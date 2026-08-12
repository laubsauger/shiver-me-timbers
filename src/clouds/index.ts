/**
 * SoT-style 2.5D clouds (§V11, task T14) — integration surface:
 *
 *   createClouds({ renderer, camera, seed, stormAt }) => {
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
 *
 * TWO THINGS THIS READS FROM OUTSIDE ITSELF:
 *
 *  - `opts.stormAt` (§V46) — pass `weather.stormAt` and each cluster shapes
 *    itself from the storm field at its OWN world XZ: fair-weather cumulus in
 *    the clear, an anvil monument over a cell. Omit it and every cluster is
 *    fair weather, which is the old global behaviour §V46 replaced. This is
 *    the ONE line that makes "blue sky, sunny, storm cloud in the distance"
 *    the default sky rather than a preset.
 *
 *  - `scene.fog.color` (§T.39) — picked up from the scene passed to
 *    `attachTo`, no extra plumbing, and used to swing the cloud palette
 *    through the day cycle. See cloudPalette.ts for why it drives hue only.
 */
import * as THREE from 'three/webgpu';
import { cloudParams, clampCoverage, cloudLayoutKey } from '../params/clouds';
import {
  generateClusters,
  createCloudCores,
  stormFieldKey,
  type StormSampler,
} from './cloudCores';
import { createCloudBlur } from './cloudBlur';
import { createCloudComposite } from './cloudComposite';
import { resolveCloudPalette } from './cloudPalette';

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
  /** this frame's resolved sun/sky pair (§T.39 day cycle). The reflection's
   *  cloud stand-in reconstructs colour with the same two values and must
   *  read them from HERE, not from the raw params hexes, or reflected clouds
   *  stay cold while the real ones warm. */
  readonly sunColorLive: THREE.Color;
  readonly skyColorLive: THREE.Color;
  dispose(): void;
}

export interface CloudsOptions {
  renderer: THREE.WebGPURenderer;
  camera: THREE.PerspectiveCamera;
  seed: number;
  /** §V46 localised storm field — pass `weather.stormAt`. Default: clear. */
  stormAt?: StormSampler;
}

export function createClouds(opts: CloudsOptions): CloudsHandle {
  const { renderer, camera, seed } = opts;
  const p = cloudParams;
  const sampleStorm: StormSampler = opts.stormAt ?? (() => 0);

  let clusters = generateClusters(seed, p, sampleStorm);
  const cores = createCloudCores(clusters, p);
  const coreScene = new THREE.Scene();
  coreScene.add(cores.object);

  const coresRT = new THREE.RenderTarget(p.rtWidth, p.rtHeight, {
    depthBuffer: false,
    type: THREE.HalfFloatType,
  });
  coresRT.texture.name = 'clouds/cores';

  const blur = createCloudBlur(coresRT.texture, p);
  const composite = createCloudComposite(blur.output, p, seed);

  // Cluster SHAPE is CPU-side, so it only takes effect through regeneration.
  // Two things move it and both would otherwise silently do nothing: a panel
  // edit or preset lerp (layoutKey), and the storm field drifting under the
  // clusters (stormKey, quantised to p.stormQuantSteps so a continuously
  // drifting field does not rebuild every single frame). Regeneration is
  // ~400 lobes of scalar math refilled into the existing instance buffers.
  let layoutKey = cloudLayoutKey(p);
  let stormKey = stormFieldKey(clusters, sampleStorm, p.stormQuantSteps);

  const invView = new THREE.Matrix4();
  // runtime getClearColor just target.copy()s, so a plain Color works;
  // @types wants the non-exported Color4, hence the narrow cast below
  const prevClearColor = new THREE.Color();
  let attachedScene: THREE.Scene | null = null;

  return {
    update(time: number, sunDir: THREE.Vector3): void {
      const lKey = cloudLayoutKey(p);
      const sKey = stormFieldKey(clusters, sampleStorm, p.stormQuantSteps);
      if (lKey !== layoutKey || sKey !== stormKey) {
        layoutKey = lKey;
        clusters = generateClusters(seed, p, sampleStorm);
        // re-key off the NEW sites: layout params may have moved them
        stormKey = stormFieldKey(clusters, sampleStorm, p.stormQuantSteps);
        cores.rebuild(clusters);
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
      cores.uStormSunCut.value = p.stormSunCut;
      cores.uStormSkyCut.value = p.stormSkyCut;
      blur.uRadiusNear.value = p.blurRadiusNear;
      blur.uRadiusFar.value = p.blurRadiusFar;
      composite.uTime.value = time * p.distortSpeed;
      // §T.39: swing the pair through the day cycle off the sky rig's live
      // horizon haze. Hue only — see cloudPalette.ts for the §B.19 guard.
      resolveCloudPalette(
        p,
        attachedScene?.fog?.color ?? null,
        composite.uSunColor.value,
        composite.uSkyColor.value,
      );
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
    sunColorLive: composite.uSunColor.value,
    skyColorLive: composite.uSkyColor.value,

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
