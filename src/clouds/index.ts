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
import { createCloudBands, advanceBandDrift } from './cloudBands';
import { createCloudBlur } from './cloudBlur';
import { createCloudComposite } from './cloudComposite';
import { resolveCloudPalette, resolveDomeAmbient } from './cloudPalette';

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
  /** this frame's world sun direction, mutated in place — the edge
   *  transmission term needs it and the reflection must read the SAME object
   *  so a cloud and its mirror light their thin margins identically */
  readonly sunDirLive: THREE.Vector3;
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
  // §V11 second cloud form: the banded stratus sheet writes the SAME packed RT
  // as the cores, so it inherits the blur, the composite, the day-cycle
  // palette and its own water reflection with no second pipeline stage and no
  // new sampler (§V40). See cloudBands.ts for why it is a ray/plane sheet
  // rather than geometry.
  const bands = createCloudBands(p, seed);
  const coreScene = new THREE.Scene();
  coreScene.add(cores.object);
  coreScene.add(bands.quad);

  const coresRT = new THREE.RenderTarget(p.rtWidth, p.rtHeight, {
    depthBuffer: false,
    type: THREE.HalfFloatType,
  });
  coresRT.texture.name = 'clouds/cores';

  const blur = createCloudBlur(coresRT.texture, p);
  const sunDirLive = new THREE.Vector3(0, 1, 0);
  const composite = createCloudComposite(blur.output, p, seed, sunDirLive);

  // Cluster SHAPE is CPU-side, so it only takes effect through regeneration.
  // Two things move it and both would otherwise silently do nothing: a panel
  // edit or preset lerp (layoutKey), and the storm field drifting under the
  // clusters (stormKey, quantised to p.stormQuantSteps so a continuously
  // drifting field does not rebuild every single frame). Regeneration is
  // ~400 lobes of scalar math refilled into the existing instance buffers.
  let layoutKey = cloudLayoutKey(p);
  let stormKey = stormFieldKey(clusters, sampleStorm, p.stormQuantSteps);

  // §V.55: the banded layer's drift is a PHASE, accumulated from dt, because
  // `bandDriftSpeed` is a live knob (and is meant to answer the wind later).
  // `time × rate` is only an offset while the rate is constant — §B.30 is
  // exactly that bug on the flags, and it looks fine on a fresh reload.
  const bandDrift = { x: 0, z: 0 };
  let lastTime: number | null = null;

  const invView = new THREE.Matrix4();
  // runtime getClearColor just target.copy()s, so a plain Color works;
  // @types wants the non-exported Color4, hence the narrow cast below
  const prevClearColor = new THREE.Color();
  /** scratch: this frame's sky-dome colour, the fill's input (see below) */
  const domeAmbient = new THREE.Color();
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
      cores.uMultiScatter.value = p.multiScatterFloor;
      cores.uBaseGlow.value = p.baseGlow;
      cores.uBaseGlowSpan.value = p.baseGlowLowSun;
      cores.uFluffScale.value = p.fluffScale;
      cores.uFluffAlpha.value = p.fluffAlpha;
      cores.uFluffPower.value = p.fluffPower;
      cores.uFluffHollow.value = p.fluffHollow;
      cores.uFluffRing.value = p.fluffRing;
      cores.uFluffTopSharp.value = p.fluffTopSharp;
      cores.uFluffSunSharp.value = p.fluffSunSharp;
      cores.uFluffVary.value = p.fluffScaleVary;
      cores.uStormSunCut.value = p.stormSunCut;
      cores.uStormSkyCut.value = p.stormSkyCut;
      blur.uRadiusNear.value = p.blurRadiusNear;
      blur.uRadiusFar.value = p.blurRadiusFar;

      // -- banded stratus layer -------------------------------------------
      const dt = lastTime === null ? 0 : time - lastTime;
      lastTime = time;
      const bandDirRad = THREE.MathUtils.degToRad(p.bandDriftDirDeg);
      advanceBandDrift(bandDrift, bandDirRad, p.bandDriftSpeed, dt);
      bands.uDrift.value.set(bandDrift.x, bandDrift.z);
      bands.uAxis.value.set(Math.cos(bandDirRad), Math.sin(bandDirRad));
      bands.push(p);
      composite.uTime.value = time * p.distortSpeed;
      // §T.39: swing the pair through the day cycle off the sky rig's live
      // horizon haze. Hue only — see cloudPalette.ts for the §B.19 guard.
      // TWO INPUTS, and they must stay two (§B.49): the HAZE warms the key,
      // the DOME colours the fill. Driving both from the haze resolved them to
      // 5.9° of hue separation at the §T.39 sunset, which is a cloud with no
      // colour difference between its lit and shadow faces — one brown lump.
      resolveDomeAmbient(domeAmbient);
      resolveCloudPalette(
        p,
        attachedScene?.fog?.color ?? null,
        domeAmbient,
        composite.uSunColor.value,
        composite.uSkyColor.value,
      );
      composite.edge.push(p);

      // view-space light directions for the fake-sphere puff shading
      camera.updateMatrixWorld();
      invView.copy(camera.matrixWorld).invert();
      cores.uSunWorld.value.copy(sunDir).normalize();
      sunDirLive.copy(cores.uSunWorld.value);
      // one source for the key direction: the sheet's forward-scattering lobe
      // must point at the same sun the lobes are lit by
      bands.uSunWorld.value.copy(cores.uSunWorld.value);
      cores.uSunView.value.copy(sunDir).normalize().transformDirection(invView);
      cores.uUpView.value.set(0, 1, 0).transformDirection(invView);

      composite.fitToCamera(camera);
      // the sheet only needs the DIRECTION through each fragment (the deck is
      // intersected analytically), so its quad rides the frustum at the same
      // distance the composite uses — well inside camera.far, §V32/§B.10
      bands.fitToCamera(camera, p.quadDistance);

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
    sunDirLive,

    dispose(): void {
      attachedScene?.remove(composite.quad);
      coreScene.remove(cores.object);
      coreScene.remove(bands.quad);
      bands.dispose();
      composite.dispose();
      blur.dispose();
      coresRT.dispose();
      cores.dispose();
    },
  };
}
