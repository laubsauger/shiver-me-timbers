/**
 * Planar water reflections (§V26, task T30): a mirrored scene pass rendered
 * into its own ≤ half-res target and sampled by the ocean material.
 *
 * WHY PLANAR AND NOT SSR: §V26 settles it — the reference (talk 03:59) shows
 * the ship and the islands in the water, and screen-space reflections cannot
 * show anything the main camera does not already have on screen (the hull's
 * waterline, the far side of an island, sky below the horizon line). The
 * analytic sky gradient the water uses today is explicitly "⊥ final".
 *
 * WHAT THIS OWNS. three's `reflector()` supplies the part that is easy to get
 * wrong — the mirrored virtual camera and the Lengyel oblique near-plane clip
 * that stops geometry BELOW the water leaking into the reflection. Everything
 * around it is this module:
 *   - `bounces: false` → the node updates once per FRAME instead of once per
 *     RENDER, and hard-guards against a reflector rendering a reflector.
 *     FRAME here means `nodeFrame.frameId`, which this app does NOT advance
 *     from its own GameLoop — it advances because `renderer.init()` starts
 *     three's internal Animation rAF unconditionally, whether or not
 *     `setAnimationLoop` is ever called. That is load-bearing: if that loop
 *     ever stops ticking, every FRAME-type node freezes at its first result
 *     (this reflection, the post pipeline's PassNode, the ocean's
 *     viewportSharedTexture) with no error anywhere.
 *     §V39 makes that concrete: Chrome suspends rAF in a hidden tab, and
 *     three's loop is a plain rAF, so a hidden automated tab freezes these
 *     nodes too. The app's GameLoop rAF and three's are SEPARATE callbacks —
 *     a forced paint may service one and not the other, so a screenshot taken
 *     from a hidden tab can show a stale reflection over a fresh frame. Judge
 *     this pass from a foreground tab only; a wrong-looking capture there is
 *     a capture artefact, not a bug in the mirror.
 *   - resolutionScale clamped to ≤ 0.5 in code (§V26), finite-guarded (§V28).
 *   - a layer split, so the mirror pass is not simply "the whole frame again":
 *     spray, rigging and the camera-pinned cloud quad are excluded, and the
 *     mirrored cloud stand-in is included.
 *   - a runtime kill switch that skips the pass entirely, not one that
 *     multiplies its result by zero (§V17 — the cost is the second scene
 *     render, not the texture fetch).
 *
 * §V17 HONESTY. This is a SECOND full scene render every frame. At half
 * resolution scale it is ~1/4 of the main pass's pixels, but it pays full
 * price for culling, draw-call submission and vertex work (the ocean itself
 * is excluded, which is where most of the vertex cost lives). Budget it as a
 * real cost and read the per-pass HUD before calling it free.
 */
import * as THREE from 'three/webgpu';
import { reflector } from 'three/tsl';
import { reflectionParams as rp } from '../params/reflection';
import { cloudParams } from '../params/clouds';
import {
  clampResolutionScale,
  createMirrorPose,
  eyeIsAbovePlane,
  hiddenObjectMask,
  mainCameraMask,
  mirrorCameraPose,
  reflectionCameraMask,
  reflectionOnlyObjectMask,
  shadowCameraMask,
} from './mirrorMath';
import { createReflectionShading, type ReflectionShadeInput } from './reflectionShading';
import { createCloudMirror, type CloudMirror, type CloudMirrorSource } from './cloudMirror';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node union
type TslNode = any;

/** minimal structural view of three's (unexported) ReflectorBaseNode */
interface ReflectorBase {
  target: THREE.Object3D;
  resolutionScale: number;
  getVirtualCamera(camera: THREE.Camera): THREE.Camera;
  updateBefore(frame: unknown): unknown;
  renderTargets: Map<THREE.Camera, THREE.RenderTarget>;
}

export interface PlanarReflectionOptions {
  /** the sun — its shadow camera mask is pinned so layer moves cost no shadows */
  sunLight?: THREE.DirectionalLight;
  /** world height of the mirror plane; the ocean rests at 0 */
  planeY?: number;
  /** wire the mirrored cloud stand-in (§V26 "clouds visible in water") */
  clouds?: Omit<CloudMirrorSource, 'params'> & { params?: typeof cloudParams };
}

export interface PlanarReflection {
  /**
   * Reflected colour for the ocean material. Drop-in replacement for its
   * analytic sky term — the ocean keeps owning the fresnel weight (§V20).
   */
  shade(input: ReflectionShadeInput): TslNode;
  /** the Object3D that defines the mirror plane (kept at y = planeY) */
  readonly target: THREE.Object3D;
  /** the mirrored cloud stand-in, or null when clouds were not wired */
  readonly cloudMirror: THREE.Mesh | null;
  /** main view only — the mirror pass skips this subtree */
  excludeFromReflection(object: THREE.Object3D): void;
  /** mirror pass only — the main camera skips this subtree */
  reflectionOnly(object: THREE.Object3D): void;
  /** add the reflection-only stand-ins to the scene */
  attachTo(scene: THREE.Scene): void;
  /** per frame, BEFORE the main render */
  update(camera: THREE.PerspectiveCamera, time: number): void;
  dispose(): void;
}

/**
 * Build the mirror pass. Returns null when `reflectionParams.enabled` is 0 —
 * the caller then leaves the ocean on its analytic sky path, and no reflector
 * node is ever compiled into the material.
 */
export function createPlanarReflection(
  opts: PlanarReflectionOptions = {},
): PlanarReflection | null {
  if (rp.enabled !== 1) return null;

  const planeY = Number.isFinite(opts.planeY) ? (opts.planeY as number) : 0;
  const useMipmaps = rp.generateMipmaps === 1;

  const node = reflector({
    // §V26: reflection res ≤ half. Clamped here AND every frame in update(),
    // because the panel writes the params object directly.
    resolutionScale: clampResolutionScale(rp.resolutionScale),
    // FRAME update type + reflector-in-reflector guard. With `true` the pass
    // would re-render for every render context that touches the material.
    bounces: false,
    // mip chain = the distance/steepness blur (§V26 "blur ok") for the price
    // of a mipmap generation on a quarter-size target
    generateMipmaps: useMipmaps,
  });
  const base = node.reflector as unknown as ReflectorBase;

  // The mirror plane: three reads the target's LOCAL +Z as the plane normal,
  // so a ground plane is the usual -90° about X (local +Z → world +Y).
  const target = base.target;
  target.rotation.x = -Math.PI / 2;
  target.position.set(0, planeY, 0);
  target.updateMatrixWorld();

  // Virtual camera layers. three clones the source camera lazily inside
  // updateBefore, so the mask is enforced on every lookup rather than
  // pre-seeded for one camera — free-cam swaps and post-processing passes
  // then all get the same split without extra plumbing.
  const inheritedGetVirtualCamera = base.getVirtualCamera.bind(base);
  base.getVirtualCamera = (camera: THREE.Camera): THREE.Camera => {
    const virtual = inheritedGetVirtualCamera(camera);
    virtual.layers.mask = reflectionCameraMask(camera.layers.mask);
    return virtual;
  };

  // Runtime kill switch. Early-returning here skips the whole second scene
  // render; the shading node falls back to the analytic sky via setActive(0).
  // (Scaling the output to zero instead would keep paying for the pass —
  // same reasoning as the construction gates in core/postPipeline.)
  const inheritedUpdateBefore = base.updateBefore.bind(base);
  let passEnabled = true;
  base.updateBefore = (frame: unknown): unknown => {
    if (!passEnabled) return undefined;
    return inheritedUpdateBefore(frame);
  };

  // three copies the RENDERING camera's layer mask onto the shadow camera
  // whenever the shadow camera sits on layer 0 alone (ShadowNode.updateShadow).
  // Left alone, whichever pass reaches the light first that frame would decide
  // what casts shadows — so pin the mask instead: everything casts, always.
  if (opts.sunLight) {
    const shadowCam = opts.sunLight.shadow.camera;
    shadowCam.layers.mask = shadowCameraMask(shadowCam.layers.mask);
  }

  const shading = createReflectionShading(node, useMipmaps);

  let cloudMirror: CloudMirror | null = null;
  if (rp.cloudsInReflection === 1 && opts.clouds) {
    cloudMirror = createCloudMirror({
      blurred: opts.clouds.blurred,
      seed: opts.clouds.seed,
      sunColorLive: opts.clouds.sunColorLive,
      skyColorLive: opts.clouds.skyColorLive,
      params: opts.clouds.params ?? cloudParams,
    });
  }

  const mirrorPose = createMirrorPose();
  let attachedScene: THREE.Scene | null = null;

  return {
    shade: shading.shade,
    target,
    cloudMirror: cloudMirror ? cloudMirror.quad : null,

    excludeFromReflection(object: THREE.Object3D): void {
      object.traverse((o) => {
        o.layers.mask = hiddenObjectMask(o.layers.mask);
      });
    },

    reflectionOnly(object: THREE.Object3D): void {
      object.traverse((o) => {
        o.layers.mask = reflectionOnlyObjectMask(o.layers.mask);
      });
    },

    attachTo(scene: THREE.Scene): void {
      attachedScene = scene;
      if (cloudMirror) scene.add(cloudMirror.quad);
    },

    update(camera: THREE.PerspectiveCamera, time: number): void {
      // the main camera must see the hidden set and never the stand-ins
      camera.layers.mask = mainCameraMask(camera.layers.mask);

      // the plane is defined by the target's world matrix, and nothing else
      // in the scene graph updates it (the target is deliberately not parented)
      target.position.set(0, planeY, 0);
      target.updateMatrixWorld();

      base.resolutionScale = clampResolutionScale(rp.resolutionScale);
      shading.updateFromParams();

      // Below the plane the mirror pass is meaningless — three's reflector
      // detects the flipped facing and clears its target, which would read as
      // a black band in the water (§V25 puts the camera underwater on purpose).
      const above = eyeIsAbovePlane(camera.position.y, planeY);
      passEnabled = rp.live === 1 && above;
      shading.setActive(passEnabled);

      if (cloudMirror && passEnabled) {
        // three's reflector recomputes this pose internally from the same
        // plane; mirrorCameraPose reproduces its construction exactly (see
        // mirrorMath) so the stand-in lands on the virtual camera's frustum.
        camera.updateMatrixWorld();
        mirrorCameraPose(camera.position, camera.quaternion, planeY, mirrorPose);
        cloudMirror.update(
          camera,
          mirrorPose.position,
          mirrorPose.quaternion,
          time,
        );
      }
    },

    dispose(): void {
      if (cloudMirror) {
        attachedScene?.remove(cloudMirror.quad);
        cloudMirror.dispose();
      }
      node.dispose();
    },
  };
}
