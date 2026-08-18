/**
 * Intersection foam + flow advection (§V10, task T13) — integration surface:
 *
 *   const ff = createFlowFoam();
 *   // per frame, BEFORE the main renderer.render():
 *   ff.setCenter(ship.position.x, ship.position.z);   // region follows ship
 *   ff.setFlowDir([-shipVel.x, -shipVel.z]);          // wake trails behind
 *   ff.setShip([ship.x, ship.z], yaw, speed, bowOff, sternOff, beam); // wake V
 *   ff.renderInjection(renderer, scene);  // ortho capture of foam targets
 *   ff.update(renderer, dt);              // advect + blur compute passes
 *
 * Tag any mesh that should shed waterline foam (ship hull, rocks):
 *   mesh.userData.foamTarget = true;
 *
 * OCEAN MATERIAL SAMPLING (world-space via regionUniforms) — either call
 * `ff.foamSampleNode(worldXZ)` (uv + border fade prebuilt), or by hand in
 * src/ocean/surfaceMaterial.ts colorNode (worldXZ = positionLocal.xz + origin):
 *
 *   const c = ff.regionUniforms.uCenter, s = ff.regionUniforms.uSize;
 *   const uv = vec2(
 *     worldXZ.x.sub(c.x).div(s).add(0.5),
 *     float(0.5).sub(worldXZ.y.sub(c.y).div(s)),   // v flips world z (flowMath.ts)
 *   );
 *   const hullFoam = texture(ff.foamTexture, uv).r;
 *   col.assign(mix(col, uFoam, hullFoam.mul(0.9)));  // §V23 functional mix
 *
 * The screen-space depth-compare mask for the water material itself is
 * `maskNodeFactory` (= intersectionMaskNode) — exact wiring snippet in
 * src/flowfoam/intersectionMask.ts header.
 *
 * ── THE WAKE'S EFFECT ON THE WATER (not just on its colour) ────────────────
 * A wake that only paints white is a decal. Two nodes make it a wake, and
 * NEITHER touches the ocean's geometry — both are consumed in the fragment
 * slope, in src/ocean/surfaceMaterial.ts, by that file's owner:
 *
 *   const smooth = ff.wakeSmoothNode(worldXZ, pixWorld);  // scalar, ≤ 1
 *   const wSlope = ff.wakeSlopeNode(worldXZ, pixWorld);   // vec2, signed
 *
 * 1. `wakeSmoothNode` — capillary damping. A ship's track kills the short
 *    waves (turbulence + surfactant), leaving a glassy lane that reflects the
 *    sky coherently and so reads as a darker mirror-like stripe. Apply it as a
 *    MULTIPLIER on the FINE slope terms only — the shortest cascade and the
 *    micro-wavelet churn — never on the long swell, which a wake does not
 *    flatten:
 *        der = sampleDeriv(0)·normLod[0] + sampleDeriv(1)·normLod[1]
 *            + sampleDeriv(2)·normLod[2]·smooth        // ← fine cascade only
 *        …
 *        const microGain = microAmp.mul(faceGate).mul(smooth);
 *    Optionally also `sparkle.mul(smooth)`: the sparkle field is a world-cell
 *    hash independent of the normal, so a flattened lane would otherwise still
 *    be stippled with glints and lose the mirror read.
 * 2. `wakeSlopeNode` — the wake's actual SURFACE, added to the slope:
 *        slopeX.addAssign(wSlope.x); slopeZ.addAssign(wSlope.y);
 *    Three mechanisms sum into this one vector field, so wiring it once gets
 *    all three and adding a fourth later needs no ocean-side change:
 *      • the BOW MOUND — water heaped ahead of the stem. The foam mound has
 *        always painted white here; this is the shape under the paint;
 *      • DIVERGENT (cusp) crests — short steep waves fanning off the stem at
 *        54.74° to the track. This is the bow wave a viewer actually reads;
 *      • TRANSVERSE crests — the long train across the track astern.
 *    Both wave systems come from one solve of the Kelvin stationary-phase
 *    condition (slickMath.kelvinBranchesCpu), so the 19.47° envelope, the
 *    speed-independence of that angle and the v² wavelength scaling are all
 *    consequences of the algebra rather than separate tunings.
 *
 * `pixWorld` is optional; pass the material's own `fwidth(worldXZ)` footprint
 * so both owners band-limit against the same number (§V48/§V49 — see the node
 * docs for what happens to the product at minification).
 *
 * §V22: agent/code done ≠ task done — visual verification of the foam trail
 * against docs/flows.png is pending main-thread integration + screenshot.
 */
import type * as THREE from 'three/webgpu';
import { float, fwidth, mix, smoothstep, texture, uniform, vec2 } from 'three/tsl';
import { flowFoamParams, type FlowFoamParams } from '../params/flowfoam';
import { createFlowNoiseUniforms } from './flowNoise';
import { createAccumulation, FOAM_INJECTION_LAYER } from './accumulation';
import { intersectionMaskNode } from './intersectionMask';
import { bandKeepNode } from './slickInjection';
import { createWakeInjector } from './wakeInjection';

export { FOAM_INJECTION_LAYER };
export { intersectionMaskNode, worldIntersectionMaskNode } from './intersectionMask';

export interface FlowFoamOptions {
  params?: FlowFoamParams;
  /** water surface height (world y) for the injection waterline band */
  waterHeight?: number;
}

export function createFlowFoam(opts: FlowFoamOptions = {}) {
  const p = opts.params ?? flowFoamParams;
  const flowU = createFlowNoiseUniforms(p);
  const wake = createWakeInjector(p);
  const acc = createAccumulation(p, flowU, wake.wakeFieldNode);
  acc.uniforms.uWaterHeight.value = opts.waterHeight ?? 0;
  // Coarse FAR tier: the same analytic wake, accumulated over a region several
  // hundred metres across so the trail does not simply stop at the near
  // region's border (user: "disappearing too immediately... not fading out over
  // a long enough distance"). No hull capture — see AccumProfile.
  //
  // useFlow IS ON HERE, and that reverses an earlier judgement ("at that range
  // the trail is a smooth band that neither needs nor shows either"). It is not
  // a smooth band: past the near tier's 60 m this is the ONLY tier left, so it
  // carries the whole visible trail from ~1.5 hull-lengths astern outwards —
  // i.e. most of what the eye actually reads as the wake. Without the curl
  // field that stretch has no internal motion at all and renders as PAINT, the
  // "vortexes but also with foam pieces in between" the user asked for being
  // exactly what the flow advection supplies. The stated cost (3 fbm per texel)
  // is 65k evaluations at 256² — a fifth of the near tier's, on a frame that is
  // CPU-bound with GPU at 6-10 ms against a 19-24 ms CPU encode.
  const far = createAccumulation(p, flowU, wake.wakeFieldNode, {
    res: p.farResolution,
    size: () => p.farRegionSize,
    decayHalfLife: () => p.farDecayHalfLife,
    useFlow: true,
    useCapture: false,
    useDetail: false, // 1.8 m/texel — transverse crests are below Nyquist there
    wakeScale: () => p.farInject,
  });
  const uEdgeFade = uniform(p.edgeFade);
  const uFarStrength = uniform(p.farStrength);
  const uFarBlendStart = uniform(p.farBlendStart);
  const uFarEdgeFade = uniform(p.farEdgeFade);
  const uSlickDamp = uniform(p.slickDamp);
  const uSlickBandFull = uniform(p.slickBandFull);
  const uSlickBandCut = uniform(p.slickBandCut);
  /**
   * SMALLEST FEATURE (m) each tier is allowed to carry — the §V48 yardstick,
   * and the correction is WHAT IT IS MEASURED AGAINST. These used to be one
   * TEXEL (0.234 m near), so `wakeSlopeNode`/`wakeSmoothNode` faded out once a
   * pixel spanned 0.234 m of water and were ZERO past 0.70 m. §B.20 again: the
   * gate belongs on the FEATURE, never on the storage grid. Nothing this field
   * carries is a texel wide — the mound ridge is 2·moundThick (6.4 m), the
   * transverse train is 5.8 m at 3 m/s and 23 m at 6 m/s, and the glassy lane
   * is metres of smooth shoulder. The floor on all of it is set at the SOURCE:
   * slickInjection fades every train to zero below `waveBandLow` texels per
   * wavelength, so `texel · waveBandLow` is exactly the finest thing that can
   * ever be written, and therefore exactly the right thing to resolve against.
   *
   * Measured against the shipped follow cam (fov 55, radius 28, pivot 6) at a
   * 900 px viewport, the old gate deleted the wake's whole SURFACE — mound
   * ridge, divergent crests, damping lane — at 80 m astern (keep 0.15) and
   * from any camera under ~6 m of height even at 45 m (keep 0.00), while the
   * albedo went on being drawn. That is a second, independent cause of the
   * user's "the wake looks painted on", alongside the known albedo-mix-only
   * defect: the paint was outliving the shape it was painted on.
   */
  const uNearFeature = uniform((p.regionSize / p.resolution) * p.waveBandLow);
  const uFarFeature = uniform((p.farRegionSize / p.farResolution) * p.waveBandLow);
  let time = 0;

  /**
   * RADIAL border fade of one tier (flowMath.regionEdgeFadeCpu): the old
   * per-axis product faded over a SQUARE, so the sliding window's border was a
   * straight line from any angle — precisely what the user saw cutting the wake
   * off. smoothstep edges INVERTED (e0 > e1, §V23): 1 inside, 0 at the border.
   */
  const regionEdge = (a: typeof acc, fade: any, worldXZ: any): any => {
    const outer = a.uniforms.uSize.mul(0.5);
    const inner = outer.mul(fade.oneMinus()).max(1e-6);
    return smoothstep(outer, inner, worldXZ.sub(a.uniforms.uCenter).length());
  };
  /** world XZ → this tier's uv (v flips world z — flowMath.ts) */
  const regionUv = (a: typeof acc, worldXZ: any): any => {
    const c = a.uniforms.uCenter;
    const s = a.uniforms.uSize;
    return vec2(
      worldXZ.x.sub(c.x).div(s).add(0.5),
      float(0.5).sub(worldXZ.y.sub(c.y).div(s)),
    );
  };
  /**
   * Near→far crossfade weight. The far tier is silenced INSIDE the near window
   * (it is smooth and long-lived, so it would paint over the very structure the
   * near tier exists to carry) and takes over exactly as the near region fades
   * at its border. CPU mirror: flowMath.farBlendWeightCpu.
   */
  const farWeight = (worldXZ: any): any => {
    const nearSize = acc.uniforms.uSize;
    const e0 = nearSize.mul(uFarBlendStart);
    const e1 = nearSize.mul(0.5).mul(uEdgeFade.oneMinus()).max(e0.add(1e-6));
    return smoothstep(e0, e1, worldXZ.sub(acc.uniforms.uCenter).length());
  };
  /** caller's pixel footprint, or our own if they cannot supply theirs */
  const footprint = (worldXZ: any, pixWorld?: any): any => {
    if (pixWorld) return pixWorld;
    const f = fwidth(worldXZ);
    return f.x.max(f.y).max(1e-4);
  };

  return {
    /** foam region RT (R = foam mask 0..1), stable texture identity */
    get foamTexture(): THREE.StorageTexture {
      return acc.foamTexture;
    },
    /** debug: raw injection capture */
    injectionTexture: acc.injectionTexture,
    /** world→uv anchors for material sampling (snippet in header) */
    regionUniforms: acc.uniforms,
    /** screen-space depth-compare mask factory for the water material (§V10) */
    maskNodeFactory: intersectionMaskNode,

    /** coarse long-range wake texture (R = foam mask), stable identity */
    get farFoamTexture(): THREE.StorageTexture {
      return far.foamTexture;
    },

    setCenter(x: number, z: number): void {
      acc.setCenter(x, z);
      far.setCenter(x, z);
    },
    renderInjection: acc.renderInjection,

    /** base flow direction (world XZ) — normalized; [0,0] disables base drift */
    setFlowDir(d: [number, number]): void {
      const len = Math.hypot(d[0], d[1]);
      if (len > 1e-6) flowU.uFlowDir.value.set(d[0] / len, d[1] / len);
      else flowU.uFlowDir.value.set(0, 0);
    },

    setWaterHeight(h: number): void {
      acc.uniforms.uWaterHeight.value = h;
    },

    /**
     * Ship wake state (wakeInjection.ts): call per tick with ship state;
     * bow/stern offsets + beam come from the ship blueprint AABB (main.ts).
     * The module records the cutwater's WORLD-SPACE track internally, so a
     * turn leaves a curved trail behind instead of re-pointing the whole wake
     * (wakeTrack.ts). No extra inputs needed — same signature as before.
     *
     * `speed` should be speed OVER WATER at the hull: it drives the bow mound
     * amplitude (via a lag) and every feature's intensity. If it ever becomes
     * available, true speed-through-water (including current) would be a
     * strictly better feed than |velocity|.
     */
    setShip: wake.setShip,

    /** debug/tests: the live world-space cutwater history (index 0 = newest) */
    get wakeTrack() {
      return wake.trackSamples;
    },

    /**
     * Lagged stem speed (m/s) driving the bow mound — foam AND slope. Bow spray
     * should gate on this so the three read the bow as working at the same
     * moment (wakeInjection.moundDrive explains the alternative).
     */
    get bowDrive(): number {
      return wake.moundDrive;
    },

    /** advance the sim one fixed tick (§V2): pushes live params, runs computes */
    update(renderer: THREE.WebGPURenderer, dt: number): void {
      time += dt;
      flowU.uTime.value = time;
      flowU.uNoiseScale.value = p.noiseScale;
      flowU.uNoiseStrength.value = p.noiseStrength;
      flowU.uScrollSpeed.value = p.noiseScrollSpeed;
      flowU.uBaseSpeed.value = p.baseFlowSpeed;
      flowU.uCurlStep.value = p.curlStep;
      uEdgeFade.value = p.edgeFade;
      uFarStrength.value = p.farStrength;
      uFarBlendStart.value = p.farBlendStart;
      uFarEdgeFade.value = p.farEdgeFade;
      uSlickDamp.value = p.slickDamp;
      uSlickBandFull.value = p.slickBandFull;
      uSlickBandCut.value = p.slickBandCut;
      // regionSize is live-tweakable, resolution is a startup constant
      uNearFeature.value = (p.regionSize / p.resolution) * p.waveBandLow;
      uFarFeature.value = (p.farRegionSize / p.farResolution) * p.waveBandLow;
      // age + extend the world-space cutwater track BEFORE the computes read it
      wake.advance(dt);
      wake.pushParams();
      acc.step(renderer, dt);
      far.step(renderer, dt);
    },

    /**
     * Convenience for the ocean material: foam sampled at a world-XZ node,
     * faded to 0 over the outer `edgeFade` fraction of the region so the
     * sliding window border never pops. smoothstep edges are INVERTED
     * (e0 > e1, functional form per §V23) — reads "1 inside, 0 at border",
     * same idiom as surfaceMaterial's distance fades.
     */
    foamSampleNode(worldXZ: any): any {
      const sampleRegion = (a: typeof acc, tex: THREE.StorageTexture, fade: any) =>
        texture(tex, regionUv(a, worldXZ)).r.mul(regionEdge(a, fade, worldXZ));
      // MIX, not max: a max between two tiers of different brightness steps at
      // the handover however well they are faded. A lerp is continuous by
      // construction — near detail inside, far coverage outside, and the band
      // between is a genuine blend. §V23 functional mix(a, b, t).
      return mix(
        sampleRegion(acc, acc.foamTexture, uEdgeFade),
        sampleRegion(far, far.foamTexture, uFarEdgeFade).mul(uFarStrength),
        farWeight(worldXZ),
      );
    },

    /**
     * ── THE CAPILLARY-DAMPING LANE (the wake's effect on the WATER) ────────
     * Multiplier in [1 − slickDamp, 1] for the ocean material's FINE slope
     * terms — the shortest cascade and the micro-wavelet churn. 1 = undisturbed
     * sea, low = the glassy lane astern. Multiply, do not add: this REMOVES
     * existing high-frequency detail, it never introduces any, so the product
     * cannot contain a frequency the ocean was not already carrying.
     *
     * §V49 — the product across the ownership boundary. The ocean differentiates
     * its normal in screen space (`dFdx(normalWorld)` feeds the Toksvig lobe
     * widening), so anything multiplied into the slope has its OWN aliasing
     * handed back amplified by the slope's magnitude. Two independent defences,
     * both live:
     *   (a) the field is SMOOTH AT SOURCE — the lane is a flat core with a
     *       smoothstep shoulder and carries no breakup noise (unlike the foam);
     *   (b) it is BAND-LIMITED HERE, by this owner, against the caller's own
     *       pixel footprint: each tier fades to 1 (= no damping, which is also
     *       the correct far-field average of a metres-wide lane) once a pixel
     *       spans more than `slickBandFull` of that tier's texels.
     * AT MINIFICATION the product therefore tends to `fineSlope × 1`, i.e.
     * exactly what the ocean draws today — and by then its own normLod has
     * already faded the fine cascade to zero anyway.
     *
     * Pass `pixWorld` (the material's `fwidth(worldXZ)` footprint) when you
     * have it, so both owners band-limit against the same number.
     */
    wakeSmoothNode(worldXZ: any, pixWorld?: any): any {
      const px = footprint(worldXZ, pixWorld);
      const tier = (a: typeof acc, fade: any, feature: any) =>
        texture(a.foamTexture, regionUv(a, worldXZ))
          .g.mul(regionEdge(a, fade, worldXZ))
          .mul(bandKeepNode(px, feature, uSlickBandFull, uSlickBandCut));
      const slick = mix(
        tier(acc, uEdgeFade, uNearFeature),
        tier(far, uFarEdgeFade, uFarFeature).mul(uFarStrength),
        farWeight(worldXZ),
      );
      // §V44 bounded at SOURCE: clamp the coverage, not the result
      return float(1).sub(slick.clamp(0, 1).mul(uSlickDamp.clamp(0, 1)));
    },

    /**
     * Transverse Kelvin crests as an ADDITIVE world-XZ SLOPE (never a
     * displacement — the ocean owns its geometry). |slope| ≤ transSlope by
     * construction, clamped at the source texel (accumulation.ts), so it can be
     * added straight onto `slopeX`/`slopeZ` without a second clamp.
     *
     * NEAR TIER ONLY. λ = 2πv²/g is 5.8 m at 3 m/s; the far tier's 2.5 m texels
     * cannot hold that (§V48), so it is not written there and this reads 0 as
     * the near region fades out. The crests are a near-field cue; they do not
     * need to survive to the horizon.
     */
    wakeSlopeNode(worldXZ: any, pixWorld?: any): any {
      const px = footprint(worldXZ, pixWorld);
      return texture(acc.foamTexture, regionUv(acc, worldXZ))
        .ba.mul(regionEdge(acc, uEdgeFade, worldXZ))
        .mul(bandKeepNode(px, uNearFeature, uSlickBandFull, uSlickBandCut));
    },

    dispose(): void {
      acc.dispose();
      far.dispose();
    },
  };
}

export type FlowFoam = ReturnType<typeof createFlowFoam>;
