/**
 * The water's mirror for the dome: what floats on the sea (the raft, the debris, the rocks and the island)
 * reflected in it (v8 notes: "reflections seem missing… things look detached").
 *
 * The game's planar mirror pass (src/reflection) is screen-space, built for one camera: a second render per
 * camera, looked up at the fragment's screen position. The dome draws six cube faces a frame, and through them
 * its pass never reached the water (docs/drift/engine-findings.md). This is the dome's own form of the same
 * mirror: ONE cube capture from the eye mirrored under the water (x, −y, z), of everything but the sea and the
 * sky, cleared transparent. For flat water the scene a ray reflected up from the surface meets is exactly what
 * that capture sees along the reflected direction; waves bend the lookup with the facet's own normal, and blur
 * it with its tilt and the distance.
 *
 * CLIPPED AT THE WATERLINE by an OBLIQUE NEAR PLANE (`clipToWater`): each face's near plane is the water, so
 * nothing under it is drawn — not the floating things' submerged halves (they had reflected as dark undersides
 * under every plank and crate), not the seabed. A ClippingGroup did the same and cost the sea 18× its frame
 * time (it re-plans its planes per camera and rebuilt every object below it on every face, engine-findings.md);
 * a projection matrix costs nothing per object. The face that looks straight down sees only what is under the
 * water, and is not drawn.
 * Where the capture saw nothing (alpha), the ocean's analytic sky stays — as the game's mirror composites.
 *
 * It plugs into the ocean through the same hook (ReflectionShadeInput → colour).
 */
import * as THREE from 'three/webgpu';
import { cubeTexture, float, mix, reflect, smoothstep, uniform } from 'three/tsl';
import type { PlanarReflection } from '../../reflection';
import type { ReflectionShadeInput } from '../../reflection/reflectionShading';

const WATER = new THREE.Vector4(0, 1, 0, 0);
const _plane = new THREE.Vector4();
const _corner = new THREE.Vector4();
const _far = new THREE.Vector4();
const _toCamera = new THREE.Matrix4();

/**
 * Make face camera `cam`'s near plane the water (y = 0, keeping y > 0): Lengyel's oblique near plane, for
 * WebGPU's [0, 1] depth — the projection's z row becomes the plane, scaled so the far plane still passes
 * through the frustum's far corner on the kept side, so the new frustum holds all of the old one above the
 * water. The camera must be under the water. Returns false when the face sees nothing above it.
 */
export function clipToWater(cam: THREE.PerspectiveCamera): boolean {
  cam.updateProjectionMatrix();
  // the plane in camera space: a point's camera coordinates c map to world M·c, so P·(M·c) = (Mᵀ·P)·c
  _plane.copy(WATER).applyMatrix4(_toCamera.copy(cam.matrixWorld).transpose());
  let best = 0;
  for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    _corner.set(x, y, 1, 1).applyMatrix4(cam.projectionMatrixInverse);
    _corner.divideScalar(_corner.w);
    const above = _plane.dot(_corner);
    if (above > best) {
      best = above;
      _far.copy(_corner);
    }
  }
  if (best <= 0) return false;
  const e = cam.projectionMatrix.elements;
  const w = e[3] * _far.x + e[7] * _far.y + e[11] * _far.z + e[15] * _far.w;
  const k = w / best;
  e[2] = _plane.x * k;
  e[6] = _plane.y * k;
  e[10] = _plane.z * k;
  e[14] = _plane.w * k;
  cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  return true;
}

/** m: the mirror holds full strength within this distance of the eye, and is gone past the second */
const FADE: [number, number] = [400, 2500];
/** mip levels of blur per unit of facet tilt (sin), and at the far fade */
const BLUR_TILT = 3;
const BLUR_FAR = 3;

export interface CubeMirror {
  /** for OceanSurface's `reflection` (only its shading hook is read) */
  readonly reflection: PlanarReflection;
  /** capture the scene from the eye mirrored under the water, with `hide` (the sea, the sky) left out */
  update(renderer: THREE.WebGPURenderer, scene: THREE.Scene, eye: THREE.Vector3, hide: THREE.Object3D[]): void;
}

export function createCubeMirror(size: number, far: number): CubeMirror {
  const target = new THREE.CubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  const camera = new THREE.CubeCamera(0.05, far, target);
  const active = uniform(0);
  const clear = new THREE.Color();
  // three sizes a target's mip chain when it first creates the GPU texture, and CubeCamera switches
  // `generateMipmaps` off for its first five faces: created there, the mirror had ONE level and the blur below
  // read nothing (domeCapture.ts drawFaces). Created up front instead, on the first update.
  let initialised = false;

  const shade = (input: ReflectionShadeInput): THREE.Node<'vec3'> => {
    const r = reflect(input.viewDirection.negate(), input.normalWorld);
    const tilt = float(1).sub(input.normalWorld.y.clamp(0, 1).mul(input.normalWorld.y.clamp(0, 1))).max(0).sqrt();
    const far = smoothstep(FADE[0], FADE[1], input.camDist);
    const s = cubeTexture(target.texture, r).level(tilt.mul(BLUR_TILT).add(far.mul(BLUR_FAR)).clamp(0, 6));
    const coverage = s.a.clamp(0, 1);
    // premultiplied: the transparent clear blended in under the geometry
    const seen = s.rgb.div(coverage.max(1e-3));
    return mix(input.skyColor, seen, coverage.mul(active).mul(far.oneMinus())) as THREE.Node<'vec3'>;
  };

  return {
    reflection: { shade } as unknown as PlanarReflection,
    update(renderer, scene, eye, hide) {
      camera.position.set(eye.x, -eye.y, eye.z);
      camera.updateMatrixWorld();
      const was = hide.map((o) => o.visible);
      hide.forEach((o) => (o.visible = false));
      const bg = scene.background;
      const bgNode = scene.backgroundNode;
      const autoClear = renderer.autoClear;
      renderer.getClearColor(clear);
      const alpha = renderer.getClearAlpha();
      scene.background = null;
      scene.backgroundNode = null;
      renderer.setClearColor(0x000000, 0);
      renderer.autoClear = true;
      const bound = renderer.getRenderTarget();
      const boundFace = renderer.getActiveCubeFace();
      const boundMip = renderer.getActiveMipmapLevel();
      const mips = target.texture.generateMipmaps;
      try {
        if (!initialised) {
          renderer.initRenderTarget(target);
          initialised = true;
        }
        if (camera.coordinateSystem !== renderer.coordinateSystem) {
          camera.coordinateSystem = renderer.coordinateSystem;
          camera.updateCoordinateSystem();
        }
        // CubeCamera.update with each face clipped to the water; the mip chain is built after the last face
        const faces = camera.children as THREE.PerspectiveCamera[];
        faces.forEach((cam, face) => {
          const seen = clipToWater(cam);
          target.texture.generateMipmaps = mips && face === faces.length - 1;
          renderer.setRenderTarget(target, face, 0);
          if (seen) renderer.render(scene, cam);
          else renderer.clear();
        });
      } finally {
        target.texture.generateMipmaps = mips;
        renderer.setRenderTarget(bound, boundFace, boundMip);
        hide.forEach((o, i) => (o.visible = was[i]));
        scene.background = bg;
        scene.backgroundNode = bgNode;
        renderer.autoClear = autoClear;
        renderer.setClearColor(clear, alpha);
      }
      active.value = eye.y > 0.05 ? 1 : 0;
    },
  };
}
