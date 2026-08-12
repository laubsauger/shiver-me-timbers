/**
 * SoT-style 2.5D clouds (§V11, task T14) — integration surface:
 *
 *   createClouds({ renderer, camera, seed }) => {
 *     update(time, sunDir)  // renders offscreen cores pass + blur compute;
 *                           // MUST be called each frame BEFORE the main
 *                           // renderer.render() — it does the
 *                           // setRenderTarget dance and restores state.
 *     attachTo(scene)       // adds the composite quad to the main scene
 *     setCoverage(v)        // 0..1 cloud density (clamped)
 *     dispose()             // frees RTs, storage + noise textures, materials
 *   }
 *
 * Pipeline: cores (instanced polygonal lobes + fluff billboards, packed RGBA
 * → RenderTarget, §V11b) → depth-scaled separable blur (compute →
 * StorageTexture) → camera-pinned composite quad.
 * All tunables live in src/params/clouds.ts (§V16) and are pushed to GPU
 * uniforms every update, so panel tweaks apply live.
 */
import * as THREE from 'three/webgpu';
import { cloudParams, clampCoverage, cloudLayoutKey } from '../params/clouds';
import { generateClusters, createCloudCores } from './cloudCores';
import { createCloudBlur } from './cloudBlur';
import { createCloudComposite } from './cloudComposite';

export interface CloudsHandle {
  update(time: number, sunDir: THREE.Vector3): void;
  attachTo(scene: THREE.Scene): void;
  setCoverage(v: number): void;
  /** blurred 4-channel cloud RT — the planar reflection's mirrored cloud
   *  stand-in samples this same texture (§V26 clouds visible in water) */
  readonly blurredTexture: THREE.Texture;
  /** the camera-pinned composite quad — must be layer-excluded from the
   *  mirror pass, since it is fitted to the MAIN camera */
  readonly compositeQuad: THREE.Mesh;
  dispose(): void;
}

export interface CloudsOptions {
  renderer: THREE.WebGPURenderer;
  camera: THREE.PerspectiveCamera;
  seed: number;
}

export function createClouds(opts: CloudsOptions): CloudsHandle {
  const { renderer, camera, seed } = opts;
  const p = cloudParams;

  const cores = createCloudCores(generateClusters(seed, p), p);
  const coreScene = new THREE.Scene();
  coreScene.add(cores.object);

  const coresRT = new THREE.RenderTarget(p.rtWidth, p.rtHeight, {
    depthBuffer: false,
    type: THREE.HalfFloatType,
  });
  coresRT.texture.name = 'clouds/cores';

  const blur = createCloudBlur(coresRT.texture, p);
  const composite = createCloudComposite(blur.output, p, seed);

  // Shape params (§V11b silhouette family) only take effect through CPU
  // regeneration, so a weather preset lerping `anvilSpread` would otherwise
  // silently do nothing until reload. Regenerate when the layout key moves —
  // ~400 lobes of scalar math, only on frames where something actually
  // changed, and the instance buffers are refilled in place.
  let layoutKey = cloudLayoutKey(p);

  const invView = new THREE.Matrix4();
  // runtime getClearColor just target.copy()s, so a plain Color works;
  // @types wants the non-exported Color4, hence the narrow cast below
  const prevClearColor = new THREE.Color();
  let attachedScene: THREE.Scene | null = null;

  return {
    update(time: number, sunDir: THREE.Vector3): void {
      const key = cloudLayoutKey(p);
      if (key !== layoutKey) {
        layoutKey = key;
        cores.rebuild(generateClusters(seed, p));
      }

      // push live params → uniforms (Tweakpane edits apply without rebuild)
      cores.uCoverage.value = clampCoverage(p.coverage);
      cores.uMaxDist.value = p.maxCloudDist;
      cores.uRelief.value = p.lobeRelief;
      cores.uReliefScale.value = p.lobeReliefScale;
      cores.uRimSoft.value = p.rimSoftness;
      cores.uSunPower.value = p.sunPower;
      cores.uSunSideGain.value = p.sunSideGain;
      cores.uSelfShadow.value = p.selfShadow;
      cores.uSilver.value = p.silverLining;
      cores.uSkyMin.value = p.skyMin;
      cores.uSkyMax.value = p.skyMax;
      cores.uFluffScale.value = p.fluffScale;
      cores.uFluffAlpha.value = p.fluffAlpha;
      cores.uFluffPower.value = p.fluffPower;
      blur.uRadiusNear.value = p.blurRadiusNear;
      blur.uRadiusFar.value = p.blurRadiusFar;
      composite.uTime.value = time * p.distortSpeed;
      composite.uSunColor.value.setHex(p.sunColor);
      composite.uSkyColor.value.setHex(p.skyColor);
      composite.uDistortScale.value = p.distortScale;
      composite.uDistortStrength.value = p.distortStrength;
      composite.uEdgeErode.value = p.edgeErode;
      composite.uAlphaGain.value = p.alphaGain;

      // view-space light directions for the fake-sphere puff shading
      camera.updateMatrixWorld();
      invView.copy(camera.matrixWorld).invert();
      cores.uSunWorld.value.copy(sunDir).normalize();
      cores.uSunView.value.copy(sunDir).normalize().transformDirection(invView);
      cores.uUpView.value.set(0, 1, 0).transformDirection(invView);

      composite.fitToCamera(camera);

      // offscreen cores pass — save/restore renderer state
      const prevRT = renderer.getRenderTarget();
      renderer.getClearColor(
        prevClearColor as Parameters<typeof renderer.getClearColor>[0],
      );
      const prevClearAlpha = renderer.getClearAlpha();
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(coresRT);
      renderer.render(coreScene, camera);
      renderer.setRenderTarget(prevRT);
      renderer.setClearColor(prevClearColor, prevClearAlpha);

      // depth-scaled separable blur (compute passes)
      blur.run(renderer);
    },

    attachTo(scene: THREE.Scene): void {
      attachedScene = scene;
      scene.add(composite.quad);
    },

    setCoverage(v: number): void {
      // params module is the single source of truth; update() pushes it on
      p.coverage = clampCoverage(v);
    },

    blurredTexture: blur.output,
    compositeQuad: composite.quad,

    dispose(): void {
      attachedScene?.remove(composite.quad);
      coreScene.remove(cores.object);
      composite.dispose();
      blur.dispose();
      coresRT.dispose();
      cores.dispose();
    },
  };
}
