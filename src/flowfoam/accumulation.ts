/**
 * Flow-foam accumulation (§V10, §C: heavy sims = `Fn().compute()`): a
 * top-down world-space foam region following a target (ship). Per frame:
 *   1. renderInjection(): ortho capture of `userData.foamTarget` meshes with
 *      a cheap white waterline-band material → injection RT.
 *   2. advect pass: dst = bilerp(prevFoam @ backward flow lookup + region
 *      shift) · decay + capture·injectPerFrame + wakeRate·dt, clamped ≤ 1.
 *   3. blur pass: 3×3 gaussian (weights sum to 1 — §V6 lesson: only decay
 *      may remove foam) written back to the front texture.
 * Fixed pass directions (advect A→B, blur B→A) keep the material-facing
 * texture identity stable (always texA) — no ping-pong retargeting.
 *
 * WORLD ANCHORING + UV/SHIFT MATH: flowMath.ts header is the single source
 * of truth (v flips world z; setCenter snaps to whole texels → exact-texel
 * shifts, no resample blur). Taps outside the region read 0: foam leaks off
 * the border, which with the material edge fade hides window pops.
 * Injection capture renders ONLY layer FOAM_INJECTION_LAYER (27, owned here;
 * re-tagged from userData.foamTarget every call), depthTest OFF + additive
 * blending so submerged hull near the waterline contributes when occluded.
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  float,
  instanceIndex,
  int,
  ivec2,
  mix,
  positionWorld,
  select,
  textureLoad,
  textureStore,
  uint,
  uniform,
  vec2,
  vec4,
} from 'three/tsl';
import { decayFactorPerFrame, GAUSSIAN_3X3 } from '../foam/foamMath';
import { worldIntersectionMaskNode } from './intersectionMask';
import { flowVectorNode, type FlowNoiseUniforms } from './flowNoise';
import { regionShiftUv, snapToTexel } from './flowMath';
import type { FlowFoamParams } from '../params/flowfoam';

/** scene layer owned by the injection capture (tagged meshes get it) */
export const FOAM_INJECTION_LAYER = 27;

/**
 * Which tier of the foam region this instance is. TWO tiers exist because one
 * cannot serve both jobs: the user wants sub-metre detail at the hull AND a
 * wake running hundreds of metres astern, and a single 512² texture can only
 * buy one by giving up the other.
 *   near — 512² over ~120 m (0.23 m/texel): hull capture, flow advection, all
 *          the structure the eye resolves.
 *   far  — 256² over ~600 m (2.3 m/texel): the long fading streak only. No
 *          hull capture and no flow-noise advection (3 fbm evaluations per
 *          texel) — at that range the trail is a smooth band that neither
 *          needs nor shows either.
 */
export interface AccumProfile {
  /** texels per side — startup constant (allocation + dispatch size) */
  res: number;
  /** live region side length (m) */
  size: () => number;
  /** live decay half-life (s) */
  decayHalfLife: () => number;
  /** advect by the flow-noise field (near only — 3 fbm per texel) */
  useFlow: boolean;
  /** composite the ortho hull-waterline capture (near only) */
  useCapture: boolean;
  /**
   * Scale on the analytic wake injection rate for this tier.
   *
   * WHY IT MUST EXIST: accumulated foam under a persistent source settles at
   * `rate × halfLife/ln2`, so the SAME injection rate that reads correctly in a
   * 5 s-half-life tier pins to solid white in a 30 s one. The far tier holds
   * the aged, dispersed remnant of the wake, not fresh foam, and needs a much
   * smaller rate to land in range. Getting this wrong turns the whole region
   * into a saturated slab with no structure — which is exactly what it did.
   */
  wakeScale: () => number;
}

export function createAccumulation(
  p: FlowFoamParams,
  flowU: FlowNoiseUniforms,
  /** extra analytic injection rate (foam/sec) at a world-XZ node — ship wake */
  wakeRateNode?: (worldXZ: any) => any,
  profile: AccumProfile = {
    res: p.resolution,
    size: () => p.regionSize,
    decayHalfLife: () => p.decayHalfLife,
    useFlow: true,
    useCapture: true,
    wakeScale: () => 1,
  },
) {
  const res = profile.res;

  const makeState = (): THREE.StorageTexture => {
    const t = new THREE.StorageTexture(res, res);
    t.type = THREE.FloatType;
    t.format = THREE.RGBAFormat;
    t.minFilter = THREE.LinearFilter; // material samples foam smoothly
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    return t;
  };
  const texA = makeState(); // front — sampled by materials, blur output
  const texB = makeState(); // scratch — advect output

  // far tier never captures, so it never allocates the RT (1×1 placeholder)
  const injectionRT = new THREE.RenderTarget(profile.useCapture ? res : 1, profile.useCapture ? res : 1, {
    depthBuffer: false,
    type: THREE.HalfFloatType,
  });
  injectionRT.texture.name = 'flowfoam/injection';

  const uCenter = uniform(new THREE.Vector2(0, 0));
  const uSize = uniform(profile.size());
  const uShift = uniform(new THREE.Vector2(0, 0));
  const uDecay = uniform(1);
  const uAdvectDt = uniform(0);
  const uInjectPerFrame = uniform(0);
  const uDt = uniform(0); // wake rate is foam/sec; scaled per fixed tick (§V2)
  const uWakeScale = uniform(profile.wakeScale());
  const uBlurRadius = uniform(p.blurRadius);
  const uBlurMix = uniform(p.blurMix);
  const uWakeChurn = uniform(p.wakeChurn);
  const uWaterHeight = uniform(0);
  const uThreshold = uniform(p.depthThreshold);
  const uFeather = uniform(p.maskFeather);

  // --- injection capture (ortho top-down, world-space fallback mask) ---
  const half = profile.size() / 2;
  const camera = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, p.captureHeight * 2);
  camera.up.set(0, 0, -1); // camera x = world +x, camera y = world −z (flowMath uv convention)
  camera.layers.set(FOAM_INJECTION_LAYER);

  const injectionMaterial = new THREE.MeshBasicNodeMaterial();
  injectionMaterial.outputNode = vec4(
    worldIntersectionMaskNode({
      heightNode: positionWorld.y,
      waterHeightNode: uWaterHeight,
      thresholdNode: uThreshold,
      featherNode: uFeather,
    }),
    0,
    0,
    1,
  );
  injectionMaterial.transparent = true;
  injectionMaterial.blending = THREE.AdditiveBlending;
  injectionMaterial.depthTest = false;
  injectionMaterial.depthWrite = false;
  injectionMaterial.side = THREE.DoubleSide;
  injectionMaterial.fog = false;

  // --- compute passes ---
  /** load with taps outside [0,res) reading 0 (region does NOT tile) */
  const loadZero = (src: THREE.Texture, xi: any, yi: any) => {
    const inside = xi
      .greaterThanEqual(int(0))
      .and(xi.lessThan(int(res)))
      .and(yi.greaterThanEqual(int(0)))
      .and(yi.lessThan(int(res)));
    const clamped = ivec2(xi.clamp(0, res - 1), yi.clamp(0, res - 1));
    return select(inside, textureLoad(src, clamped).r, float(0));
  };

  const advectPass = Fn(() => {
    If(instanceIndex.lessThan(uint(res * res)), () => {
      const x = int(instanceIndex.modInt(res));
      const y = int(instanceIndex.div(uint(res)));
      // texel-center uv, then world position (flowMath.worldForUv mirror)
      const u = float(x).add(0.5).div(res);
      const v = float(y).add(0.5).div(res);
      const wx = uCenter.x.add(u.sub(0.5).mul(uSize));
      const wz = uCenter.y.sub(v.sub(0.5).mul(uSize));
      // foam-scaled churn: eddies spin up INSIDE the trail (user review:
      // "internal motion, water pushed aside"), open ocean stays calm
      const foamLocal = textureLoad(texA, ivec2(x, y)).r;
      // far tier skips the flow field entirely — pure shift + decay + wake
      const flow = profile.useFlow
        ? flowVectorNode(vec2(wx, wz), flowU, foamLocal.mul(uWakeChurn).add(1))
        : vec2(0, 0);
      // backward semi-Lagrangian source uv (flowMath.advectLookupUv mirror)
      const su = u.sub(flow.x.mul(uAdvectDt).div(uSize)).add(uShift.x);
      const sv = v.add(flow.y.mul(uAdvectDt).div(uSize)).add(uShift.y);
      // manual bilinear (compute passes have no sampler; taps zero outside)
      const tx = su.mul(res).sub(0.5);
      const ty = sv.mul(res).sub(0.5);
      const x0 = int(tx.floor());
      const y0 = int(ty.floor());
      const fx = tx.fract();
      const fy = ty.fract();
      const t00 = loadZero(texA, x0, y0);
      const t10 = loadZero(texA, x0.add(1), y0);
      const t01 = loadZero(texA, x0, y0.add(1));
      const t11 = loadZero(texA, x0.add(1), y0.add(1));
      // §V23 functional mix(a, b, t)
      const prev = mix(mix(t00, t10, fx), mix(t01, t11, fx), fy);
      const inject = profile.useCapture
        ? textureLoad(injectionRT.texture, ivec2(x, y)).r
        : float(0);
      // analytic ship wake composes ADDITIVELY with the ortho capture
      const wake = wakeRateNode ? wakeRateNode(vec2(wx, wz)).mul(uDt).mul(uWakeScale) : float(0);
      const foam = prev.mul(uDecay).add(inject.mul(uInjectPerFrame)).add(wake).min(1);
      textureStore(texB, ivec2(x, y), vec4(foam, 0, 0, 1)).toWriteOnly();
    });
  })().compute(res * res);

  const blurPass = Fn(() => {
    If(instanceIndex.lessThan(uint(res * res)), () => {
      const x = int(instanceIndex.modInt(res));
      const y = int(instanceIndex.div(uint(res)));
      const sum = float(0).toVar();
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const sx = x.add(int(uBlurRadius.mul(dx).round()));
          const sy = y.add(int(uBlurRadius.mul(dy).round()));
          const w = GAUSSIAN_3X3[(dy + 1) * 3 + (dx + 1)];
          sum.addAssign(loadZero(texB, sx, sy).mul(w));
        }
      }
      // partial blur (§V23 functional mix): full 3×3 every frame at 60+fps
      // flattens streaks to mush — blurMix keeps structure while softening
      const center = loadZero(texB, x, y);
      const foam = mix(center, sum, uBlurMix).min(1);
      textureStore(texA, ivec2(x, y), vec4(foam, 0, 0, 1)).toWriteOnly();
    });
  })().compute(res * res);

  // --- region state ---
  const center = new THREE.Vector2(0, 0); // texel-snapped world XZ
  const pendingShift = new THREE.Vector2(0, 0); // uv shift consumed next step
  const prevClearColor = new THREE.Color();

  return {
    foamTexture: texA,
    injectionTexture: injectionRT.texture,
    uniforms: { uCenter, uSize, uWaterHeight },

    /** move the region (world XZ). Snaps to the texel grid (see header). */
    setCenter(x: number, z: number): void {
      const size = profile.size();
      const sx = snapToTexel(x, size, res);
      const sz = snapToTexel(z, size, res);
      const [du, dv] = regionShiftUv(center.x, center.y, sx, sz, size);
      pendingShift.x += du;
      pendingShift.y += dv;
      center.set(sx, sz);
      uCenter.value.set(sx, sz);
    },

    /**
     * Ortho render of tagged meshes into the injection RT. Call AFTER
     * setCenter and BEFORE step() each frame (mask must align with the
     * current region). Saves/restores render target, clear color, override
     * material and scene background.
     */
    renderInjection(renderer: THREE.WebGPURenderer, scene: THREE.Scene): void {
      if (!profile.useCapture) return;
      const s = profile.size();
      camera.left = -s / 2;
      camera.right = s / 2;
      camera.top = s / 2;
      camera.bottom = -s / 2;
      camera.far = p.captureHeight * 2;
      camera.updateProjectionMatrix();
      camera.position.set(center.x, p.captureHeight, center.y);
      camera.lookAt(center.x, 0, center.y);
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        if (m.userData.foamTarget) m.layers.enable(FOAM_INJECTION_LAYER);
        else m.layers.disable(FOAM_INJECTION_LAYER);
      });
      const prevRT = renderer.getRenderTarget();
      renderer.getClearColor(prevClearColor as Parameters<typeof renderer.getClearColor>[0]);
      const prevClearAlpha = renderer.getClearAlpha();
      const prevOverride = scene.overrideMaterial;
      const prevBackground = scene.background;
      scene.overrideMaterial = injectionMaterial;
      scene.background = null;
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(injectionRT);
      renderer.render(scene, camera);
      renderer.setRenderTarget(prevRT);
      renderer.setClearColor(prevClearColor, prevClearAlpha);
      scene.overrideMaterial = prevOverride;
      scene.background = prevBackground;
    },

    /** one sim step (§V2 fixed dt): pushes live params, advect+blur computes */
    step(renderer: THREE.WebGPURenderer, dt: number): void {
      uSize.value = profile.size();
      uDecay.value = decayFactorPerFrame(profile.decayHalfLife(), dt);
      uAdvectDt.value = p.advectSpeed * dt;
      uInjectPerFrame.value = p.injectStrength * dt;
      uDt.value = dt;
      uWakeScale.value = profile.wakeScale();
      uBlurRadius.value = p.blurRadius;
      uBlurMix.value = p.blurMix;
      uWakeChurn.value = p.wakeChurn;
      uThreshold.value = p.depthThreshold;
      uFeather.value = p.maskFeather;
      uShift.value.copy(pendingShift);
      renderer.compute(advectPass);
      renderer.compute(blurPass);
      pendingShift.set(0, 0);
    },

    dispose(): void {
      texA.dispose();
      texB.dispose();
      injectionRT.dispose();
      injectionMaterial.dispose();
    },
  };
}

export type FlowFoamAccumulation = ReturnType<typeof createAccumulation>;
