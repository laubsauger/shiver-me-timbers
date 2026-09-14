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
import type { ChineSheetEmitter } from '../wake/chineContact';
import type * as THREE from 'three/webgpu';
import { float, fwidth, mix, smoothstep, texture, uniform, vec2, vec4 } from 'three/tsl';
import { Vector2 as THREE_Vector2 } from 'three/webgpu';
import { bandLimitedFbm2, coordFootprint } from '../foam/foamShading';
import { flowFoamParams, type FlowFoamParams } from '../params/flowfoam';
import { regionEdgeFadeCpu } from './flowMath';
import { coverageWeightedAgeNode } from './foamAge';
import { createFlowNoiseUniforms } from './flowNoise';
import { createAccumulation, FOAM_INJECTION_LAYER, nearProfile, type AccumProfile } from './accumulation';
import { intersectionMaskNode } from './intersectionMask';
import { bandSlopeVariance, createSimFoamField, type HullBurialInput, type PropWashInput, type SlopeSpectrumBand } from './simFoam';
import { createSimWakeField, type WakeFieldFn } from './simInjection';
import { bandKeepNode } from './slickInjection';
import { createWakeInjector } from './wakeInjection';
import { WAKE_SHIP_TIER } from '../wake/wakeCalibration';
import { WAKE_MAX_VESSELS, WakeSim, type WakeSimTier } from '../wake/wakeSim';

export { FOAM_INJECTION_LAYER };
export type { PropWashInput, HullBurialInput, SlopeSpectrumBand } from './simFoam';
export { intersectionMaskNode, worldIntersectionMaskNode } from './intersectionMask';

/**
 * Where the wake's SURFACE (vertex elevation + fragment slope) comes from
 * (§T W2b, docs/wake/w2b-integration.md). A per-PAGE construction choice, not
 * a live param: TSL bakes the advect graph at construction.
 *   'analytic'  the Kelvin stationary-phase field (wakeInjection/slickInjection)
 *               — the default, and the pirate page. Bit-identical to before W2b.
 *   'sim'       the eWave solver (src/wake) resampled into the SAME channels by
 *               the near advect pass (simInjection.ts). VISUAL-ONLY until §T.170
 *               (§V8 amendment): `wakeHeightCpu` reads 0. Foam + slick doses
 *               come from the sim too (simFoam.ts, §T.171 W5); the analytic
 *               injector is not evaluated on this backend.
 */
export type WakeBackend = 'analytic' | 'sim';

/**
 * §T.199 THE FLEET'S EDDY GAIN inside the trail (`AccumProfile.wakeChurn`; the galleon/raft keep `wakeChurn` 1.8).
 * USER: 'bow wake angle seems a bit round … not triangular enough'. Measured (flowMath CPU mirror, shipped flow
 * params): the curl speed is median 0.42 / p90 0.86 m/s in open water and ×2.8 = 1.18 / 2.40 m/s where foam is
 * saturated — which a planing hull's lane always is — so the race trail was swirled 6–24 m sideways over its
 * 5–12 s life: the round cloud. A planing hull leaves a thin, fast-decaying turbulent layer, not the bluff-body
 * eddy street the 1.8 was tuned on (galleon). 0 = the trail drifts with the ambient curl only. LOOK CALIBRATION
 * against that playtest and the narrow straight-armed V of offshore-racing footage (docs/wake/w7-speedboat-look.md §2).
 */
export const FLEET_WAKE_CHURN = 0;
/**
 * W8 WHITE WATER BREAKS UP BY AGE (docs/wake/w8-foam-readability.md §9). The material's froth used to be
 * freshness × a smooth density ramp: a saturated planing lane stayed a uniform white stripe for as long as its foam/slick
 * ratio read fresh, then faded as a whole. Now the white is a GATE on a ridged, band-limited, flow-aligned fbm blend
 * (patches, filaments, bubbles — round 3) whose edge rises as the foam ages and where the lane thins: fresh dense churn
 * (edgeFresh) is solid white, ageing water keeps only the ridges (lace, filaments), aged aerated water (edgeAged) keeps
 * sparse surfacing flecks at `fleckGain` — the bubbles popping on a boil or an old lane. (The wake mask itself carries no
 * usable texture at saturation: measured, a gate on it drew flat white sheets.) LOOK CALIBRATION against the chase/top-down shots (dense 15–30 m, lace by 40–60 m at planing).
 */
export const WAKE_LACE = { freshLow: 0.25, freshHigh: 0.92, edgeFresh: 0.22, edgeAged: 0.72, fleckGain: 0.9, drift: 0.07 } as const;
/** W8 vessel mode: the near window's centre trails the hull by this many seconds of her speed … */
export const NEAR_ASTERN_SECONDS = 1.2;
/** W8 round 3 LOOK: churned-core relief height scale (m of fbm value) and its finite-difference step (m) */
export const WAKE_CHURN_RELIEF = 0.35;
export const WAKE_CHURN_STEP = 0.2;
/** … at most this fraction of the window (0.2 × 120 m = 24 m: her stem stays inside the far-blend start, 0.3 × 120 m) */
export const NEAR_ASTERN_MAX_FRACTION = 0.2;

/** the sim backend's stand-in for the analytic injector: no doses, no surface (§T.171) */
const noAnalyticWake: WakeFieldFn = () => ({ rate: vec4(0, 0, 0, 0), elev: float(0) });

export interface FlowFoamOptions {
  params?: FlowFoamParams;
  /** water surface height (world y) for the injection waterline band */
  waterHeight?: number;
  /** default 'analytic' — see `WakeBackend` */
  wakeBackend?: WakeBackend;
  /** the sim's grid when `wakeBackend` is 'sim' (default WAKE_SHIP_TIER, 160 m) */
  wakeTier?: WakeSimTier;
  /**
   * §T.180 c: prop jets the sim foam compiles for (0 = none, the raft; the
   * speedboat's three drives want 3). Construction-time: it sizes the shader.
   * §T.195: PER VESSEL when `vessels` > 0 — the shader carries propJets × vessels.
   */
  propJets?: number;
  /**
   * §T.195 vessel slots the sim foam's churn and ribbons carry (simFoam `vessels`). Default: WAKE_MAX_VESSELS on a
   * page that carries prop jets (the speedboat race — every boat marks the water), 0 otherwise (the raft: the
   * single-hull graph, bit-identical). Construction-time.
   */
  vessels?: number;
}

/**
 * STAGE-A WHITECAP LIFETIME (s): Monahan & Lu 1990 ("Acoustically relevant
 * bubble assemblages and their dependence on meteorological parameters", IEEE
 * JOE 15) measured the ACTIVE, dense bubble-plume stage of a whitecap decaying
 * with τ_A ≈ 0.53 s, against τ_B ≈ 4.2 s for the thinning foam patch it
 * leaves. It is the age at which wake whitewater stops reading as breaking
 * water (the whitecap material) and starts reading as the aged foam lane.
 */
export const WHITECAP_STAGE_A_SECONDS = 0.53;

/**
 * Exponent turning a tier's two-clock ratio into the stage-A weight (§T.59, §T.180 d).
 * A dose laid `a` seconds ago holds foam ∝ 2^(−a/T_f) and slick ∝ 2^(−a/T_s),
 * so f = foam·k/slick = 2^(−a·(1/T_f − 1/T_s)) (k = slick per foam at injection)
 * and e^(−a/τ_A) = f^e with e = 1/(ln2·τ_A·(1/T_f − 1/T_s)). When the clocks cannot
 * be told apart (T_f ≥ T_s) the age is unmeasurable and everything reads aged.
 */
export function freshnessExponent(foamHalfLife: number, slickHalfLife: number, tauA = WHITECAP_STAGE_A_SECONDS): number {
  const rate = 1 / foamHalfLife - 1 / slickHalfLife;
  const e = 1 / (Math.LN2 * tauA * rate);
  return Number.isFinite(e) && e > 0 ? Math.min(256, Math.max(0.05, e)) : 256;
}

/** CPU twin of the tier freshness (tests): (foam, slick) coverage → stage-A weight */
export function tierFreshnessCpu(foam: number, slick: number, slickPerFoam: number, exponent: number): number {
  const r = Math.max(0, foam) * Math.max(0, slickPerFoam);
  const f = Math.min(1, Math.max(0, r / Math.max(slick, r, 1e-5)));
  return Math.pow(f, exponent);
}

export function createFlowFoam(opts: FlowFoamOptions = {}) {
  const p = opts.params ?? flowFoamParams;
  const flowU = createFlowNoiseUniforms(p);
  const wake = createWakeInjector(p);
  const wakeBackend: WakeBackend = opts.wakeBackend ?? 'analytic';
  const wakeSim = wakeBackend === 'sim' ? new WakeSim(opts.wakeTier ?? WAKE_SHIP_TIER) : null;
  /**
   * §T.171 W5: on the sim backend the foam and slick doses come from the sim
   * too (simFoam.ts), so the analytic injector is not evaluated at all there —
   * its surface was already replaced (W2b) and its doses are now. Both tiers
   * read the zero field for `.ba`/elevation-free doses and `simFoam` for `.rg`.
   */
  const simField = wakeSim ? createSimWakeField(noAnalyticWake, wakeSim) : null;
  const vessels = opts.vessels ?? (opts.propJets ? WAKE_MAX_VESSELS : 0);
  const propJets = vessels > 0 && opts.propJets ? opts.propJets * vessels : opts.propJets;
  const simFoam = wakeSim && simField ? createSimFoamField(wakeSim, p, simField.uSimCenter, { propJets, vessels, uNearCenter: simField.uNearCenter }) : null;
  /** §T.199 the fleet's eddy gain in the trail (`FLEET_WAKE_CHURN`); the single-hull pages keep `p.wakeChurn` */
  const churnProfile: Partial<AccumProfile> = vessels > 0 && simFoam ? { wakeChurn: () => FLEET_WAKE_CHURN } : {};
  /** §T.180 a: the band the ambient slope is measured over — the sim's own (λ ≥ 2 sim texels) */
  const ambientLambdaMin = wakeSim ? 2 * wakeSim.solver.texel : 0;
  /** the cascades' slope totals the ambient σ was last measured from (no per-tick allocation) */
  const ambientKey = new Float64Array(8);
  let ambientKeyCount = -1;
  const acc = simField
    ? createAccumulation(p, flowU, simField.field, { ...nearProfile(p), blurSlope: false, simFoam: simFoam!.rateNode, ...churnProfile })
    : createAccumulation(p, flowU, wake.wakeFieldNode);
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
  const farProfile: AccumProfile = {
    res: p.farResolution,
    size: () => p.farRegionSize,
    decayHalfLife: () => p.farDecayHalfLife,
    useFlow: true,
    useCapture: false,
    useDetail: false, // 1.8 m/texel — transverse crests are below Nyquist there
    wakeScale: () => p.farInject,
  };
  // §T.171: the far tier carries the SIM trail on the sim backend — same rates, its own decay
  const far = simFoam
    ? createAccumulation(p, flowU, noAnalyticWake, { ...farProfile, simFoam: simFoam.rateNode, ...churnProfile })
    : createAccumulation(p, flowU, wake.wakeFieldNode, farProfile);
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
  /** §T.180 d: slick per foam at injection and each tier's age exponent (freshnessExponent) */
  const uSlickPerFoamAge = uniform(p.simSlickPerFoam);
  const uNearAgeExp = uniform(freshnessExponent(p.decayHalfLife, p.slickHalfLife));
  const uFarAgeExp = uniform(freshnessExponent(p.farDecayHalfLife, p.slickHalfLife));
  const uNearFeature = uniform((p.regionSize / p.resolution) * p.waveBandLow);
  /** W8 white-water breakup (`wakeWhiteNode`): freshness knees, lace edges fresh/aged, aged fleck gain, lace feature (m) */
  const uLaceFresh = uniform(new THREE_Vector2(WAKE_LACE.freshLow, WAKE_LACE.freshHigh));
  const uLaceEdge = uniform(new THREE_Vector2(WAKE_LACE.edgeFresh, WAKE_LACE.edgeAged));
  const uFleckGain = uniform(WAKE_LACE.fleckGain);
  const uFarFeature = uniform((p.farRegionSize / p.farResolution) * p.waveBandLow);
  let time = 0;
  /** has the sim tick ever driven the track? — see `advanceWake`/`update` */
  let wakeAdvanced = false;
  /** one-shot latch so a paused frame cannot spam the console */
  let warnedNoAdvance = false;

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
      // W8 vessel mode (docs/wake/w8-foam-readability.md §9): the near region carries the wake's SURFACE and its
      // detailed foam, and a planing hull's divergent arms and aerated band run far astern of her while nothing
      // happens far ahead. Centred on her, 60 m of the 120 m window was spent ahead of the stem and the drawn surface
      // ended 60 m astern. Slide it back by NEAR_ASTERN_SECONDS of her own run, capped so the stem stays well inside.
      // Raft and galleon (single-hull graph) keep the centred window.
      if (vessels > 0 && simFoam) {
        const h = simFoam.hull();
        const back = Math.min(NEAR_ASTERN_MAX_FRACTION * p.regionSize, NEAR_ASTERN_SECONDS * h.speed);
        const bx = Number.isFinite(back) ? Math.sin(h.yaw) * back : 0;
        const bz = Number.isFinite(back) ? Math.cos(h.yaw) * back : 0;
        acc.setCenter(x - bx, z - bz);
      } else {
        acc.setCenter(x, z);
      }
      far.setCenter(x, z);
    },
    renderInjection: acc.renderInjection,

    /** base flow direction (world XZ) — normalized; [0,0] disables base drift */
    setFlowDir(d: [number, number]): void {
      const len = Math.hypot(d[0], d[1]);
      if (len > 1e-6) flowU.uFlowDir.value.set(d[0] / len, d[1] / len);
      else flowU.uFlowDir.value.set(0, 0);
    },

    /**
     * The sea's TANGENT PLANE under the ship: height at the region centre plus
     * (∂h/∂x, ∂h/∂z). This is what the hull's foam-injection band rides, so the
     * wetted line moves up and down the topsides as a wave passes instead of
     * sitting at a fixed altitude — accumulation.uWaterSlope's header has the
     * whole defect and its measured size. Call every tick; both tiers share it
     * (only the near one captures).
     */
    setWaterPlane(h: number, dhdx: number, dhdz: number): void {
      acc.uniforms.uWaterHeight.value = h;
      acc.uniforms.uWaterSlope.value.set(dhdx, dhdz);
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
    setShip: simFoam
      ? (pos: [number, number], yaw: number, speed: number, bowOffset: number, sternOffset: number, beam: number): void => {
          wake.setShip(pos, yaw, speed, bowOffset, sternOffset, beam);
          simFoam.setHull(yaw, speed); // §T.171: the hull velocity the sim churn is advected by
        }
      : wake.setShip,
    /** §T.161 — this vessel's speed scale for the wake's own ramp (1 = galleon) */
    setSpeedScale: wake.setSpeedScale,

    /**
     * §T.180 a — THE AMBIENT SEA'S SLOPE, for the wake-breaking increment. Pass
     * the ocean's cascades (`ocean.cascades`, their published slope histograms);
     * the band is the sim's own, λ ≥ 2 sim texels. Cached on the cascades'
     * totals, so calling it every tick costs a compare. No-op on the analytic
     * backend.
     */
    setAmbientSea(bands: readonly SlopeSpectrumBand[]): void {
      if (!simFoam) return;
      let same = bands.length === ambientKeyCount;
      const n = Math.min(bands.length, ambientKey.length);
      for (let i = 0; i < n; i++) {
        const v = bands[i].slopeVariance();
        if (!Object.is(v, ambientKey[i])) same = false;
        ambientKey[i] = v;
      }
      if (same) return;
      ambientKeyCount = bands.length;
      simFoam.setAmbientSlopeVariance(bandSlopeVariance(bands, ambientLambdaMin));
    },

    /**
     * §T.70 / §T.180 e — the hero's hull contact, RIGHT AFTER its tick update
     * (`hullContact.update`): her stations' burial rates feed the sim churn, so
     * heave and pitch in a swell lay foam even with no way on. No-op on the
     * analytic backend.
     */
    setHullBurial(contact: HullBurialInput | null): void {
      simFoam?.setHullBurial(contact);
    },

    /**
     * §T.180 c — this tick's prop jets (`wake/propWash.ts`) for the foam ribbon; the page hands the same list to `wakeSim.tick`.
     * §T.195: in vessel mode EVERY boat's jets, hero first then nearest (`vesselFx` builds the list); `jetSlots` drawn.
     */
    setPropWash(inputs: readonly PropWashInput[]): void {
      simFoam?.setPropWash(inputs);
    },
    /**
     * §T.199 vessel mode — this tick's hulls' waterline spray and speed (hero first, `vesselFx` builds the list): the
     * chine sheet foam lines (simFoam `packChineSheet`). No-op without vessel slots.
     */
    setChineSheets(inputs: readonly ChineSheetEmitter[]): void {
      simFoam?.setChineSheets(inputs);
    },

    /** which field draws the wake's surface — fixed at construction */
    wakeBackend,
    /**
     * The GPU wake driver when `wakeBackend` is 'sim', else null. The page's
     * FIXED TICK feeds it (`wakeSim.tick(pose, samples, bowAhead, dt)`); `update`
     * dispatches its one compute group (§V104) before the advect pass reads it.
     */
    wakeSim,
    /**
     * BOOT WARM-UP of the sim wake's pipelines (splat + the one compute group)
     * for the page's boot shader-compile list (core/bootCompile.ts), so the first tick-bearing frame
     * does not compile them. Resolves immediately on the analytic backend.
     */
    warmAsync(renderer: THREE.WebGPURenderer): Promise<unknown> {
      return wakeSim ? wakeSim.compileAsync(renderer) : Promise.resolve();
    },

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

    /**
     * Wake surface elevation (m) at a world XZ — the CPU mirror of
     * `wakeHeightNode`, region edge fade included, so the sea the hull answers
     * to is the sea that is drawn (§V.8). `smithDepth` > 0 asks §V.68's
     * pressure question instead: buoyancy passes the draft, every GEOMETRIC
     * reader passes 0.
     *
     * Must be called on the same tick as `advanceWake`, after it.
     *
     * THE ±2 m CLAMP IS THE TEXTURE'S, NOT A SECOND ONE. accumulation.ts stores
     * `field.elev.clamp(-2, 2)` into `elevTexture`, so that clamp is part of the
     * surface the GPU actually draws; a mirror that skipped it would float the
     * hull on an unclamped field the moment a param push drove any term past the
     * backstop. It never fires at shipped params (peak 0.47 m) — which is
     * exactly why it must be mirrored rather than argued away (§V.62).
     */
    wakeHeightCpu(x: number, z: number, smithDepth = 0): number {
      // §V8 AMENDMENT (§T.168–§T.170): the SIM wake is visual-only — hulls do not
      // feel it, and the analytic elevation is no longer drawn, so floating on
      // it would be a sea that does not exist. The CPU band (§T.170) returns here.
      if (wakeSim) return 0;
      const e = wake.elevationCpu(x, z, smithDepth);
      if (e === 0) return 0;
      const c = acc.uniforms.uCenter.value;
      const stored = e < -2 ? -2 : e > 2 ? 2 : e;
      return stored * regionEdgeFadeCpu(x - c.x, z - c.y, acc.uniforms.uSize.value, p.edgeFade);
    },

    /**
     * ── THE WAKE'S SIM STEP (§V.2) — CALL FROM THE FIXED TICK ────────────────
     *
     * Ages the world-space cutwater track, lays a new sample if the ship has
     * travelled far enough, advances the mound's lagged speed and uploads the
     * polyline + its AABB. Call ONCE PER SIM TICK on `SIM_DT`, after `setShip`
     * and `setCenter` and BEFORE buoyancy.
     *
     * WHY IT IS NOT IN `update()` ANY MORE. It used to run there, and `update()`
     * runs in main.ts's RENDER block on `frameDt`, which made the trail's
     * spatial resolution a function of frame rate — a §V.2 defect of exactly
     * `52cd1b5`'s shape (a per-frame quantity that was really a per-second one).
     * It became a §V.8 defect the moment `wakeHeightCpu` was wired into
     * `CpuOcean`: buoyancy runs inside the fixed tick, so a track aged in the
     * render block would float the hull on a wake laid at a different instant
     * from the one being drawn — and at any frame rate above 60 there are
     * frames with no tick at all and ticks with no frame below it.
     *
     * SPLIT HERE, not one call lower: everything this touches is sim state
     * (the polyline, the odometer, the lag) and everything left in `update()`
     * is a GPU dispatch. `pushParams` comes along because the uniforms it
     * writes are the ones the track walk is evaluated against, and the mirror
     * reads the same live params — a param that moved between the tick and the
     * draw would otherwise be read differently by the two sides.
     */
    advanceWake(dt: number): void {
      wake.advance(dt);
      wake.pushParams();
      wakeAdvanced = true;
    },

    /** advance the sim one fixed tick (§V2): pushes live params, runs computes */
    update(renderer: THREE.WebGPURenderer, dt: number): void {
      /**
       * §V.2/§V.8 FAIL LOUD, ONCE, AND DELIBERATELY NOT BY THROWING.
       *
       * A caller that dispatches the computes but never drives `advanceWake`
       * gets a frozen track, which renders as a wake that is simply SHORT —
       * plausible enough to ship and to tune around. The previous agent
       * declined to split this call for exactly that reason ("a half-built API
       * that freezes the trail is worse than a stated one"); this is the split
       * with the trap named rather than left silent.
       *
       * WHY NOT `throw`. `GameLoop` renders while PAUSED (§V.21: sim halts,
       * render continues), so a pause taken before the very first tick — Esc
       * during the compile warm-up — would reach this line with no tick behind
       * it and kill the frame, every frame. That is a worse failure than the
       * one being guarded against, and the guard cannot tell the two apart from
       * in here. The regression itself is pinned in tests/wakeSea.test.ts, where
       * `advanceWake` is the only thing that can move the track at all.
       */
      if (!wakeAdvanced && !warnedNoAdvance) {
        warnedNoAdvance = true;
        console.error(
          'flowFoam.update: the wake track has never been advanced. Call ' +
            'advanceWake(dt) from the SIM TICK (§V.2) — it is sim state, and ' +
            'buoyancy reads it through CpuOcean.setWakeField (§V.8).',
        );
      }
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
      // the track was aged in the SIM TICK (`advanceWake`); what is left here is
      // the GPU work, which is per-FRAME by definition
      if (wakeSim && simField) {
        // ONE group, advanced by banked SIM time (wakeSim.ts), then the advect
        // pass resamples it about the centre that group scrolled to
        wakeSim.step(renderer); // @band-limited-elsewhere: a solver method named step, not a shader edge
        simField.uSimCenter.value.set(wakeSim.solver.centerX, wakeSim.solver.centerZ);
        if (wakeSim.near && simField.uNearCenter) simField.uNearCenter.value.set(wakeSim.near.centerX, wakeSim.near.centerZ);
        simFoam?.update();
        uSlickPerFoamAge.value = Math.max(0, Number.isFinite(p.simSlickPerFoam) ? p.simSlickPerFoam : 0);
        uNearAgeExp.value = freshnessExponent(p.decayHalfLife, p.slickHalfLife);
        uFarAgeExp.value = freshnessExponent(p.farDecayHalfLife, p.slickHalfLife);
      }
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
     * §T.59 / §T.180 d — WAKE FOAM AGE, as the stage-A weight in [0, 1]: 1 where
     * the foam is breaking-fresh (younger than ~τ_A), → 0 as it becomes the aged
     * lane. NULL on the analytic backend, so the ocean material builds exactly the
     * pre-W5b graph there (pirate WGSL byte-identical).
     *
     * NO NEW CHANNEL AND NO NEW BINDING. The age is the ratio of the two decay
     * clocks the texture already carries — foam (.r, `decayHalfLife`) and slick
     * (.g, `slickHalfLife`), injected in a fixed ratio by the sim — read from the
     * SAME texture objects `foamSampleNode`/`wakeSmoothNode` sample, so the
     * fragment stage dedupes them (§V40). Waterline-capture foam carries no slick
     * and reads fresh, which it is. Band limit: a ratio of two channels of one
     * filtered sample has no spatial frequency of its own.
     */
    /**
     * W8 the WHITE share of the wake foam (0..1) at a world-XZ node, from the material's own wake mask (`foamDetailMask` output), the
     * coverage it was built from, the stage-A freshness (`wakeFoamFreshnessNode`) and the pixel footprint (header of
     * WAKE_LACE). Sim backend only (null on analytic). Band limit: the gate's knee widens with fwidth of the mask
     * texture, and past a `featureMetres` pixel it resolves to its own mean (1 − edge).
     */
    /**
     * W8 round 3: the share (0..1) of a steep wake CREST at a world-XZ node — smoothstep(0.18, 0.35, |∇η_wake|) of the
     * near tier's wake slope (the same texture tap as `wakeSlopeNode`: no binding). Below the 0.30 breaking onset crests
     * micro-break and spill (lighter, laced); the white breaking itself is the sim foam's. Sim vessel mode only.
     */
    wakeCrestNode: vessels > 0 && simFoam
      ? (worldXZ: any): any => {
          // @band-limited-elsewhere: a VALUE gate on a slope magnitude of one filtered sample (the tier's resampled wake slope)
          return smoothstep(0.18, 0.35, texture(acc.foamTexture, regionUv(acc, worldXZ)).ba.length()).mul(regionEdge(acc, uEdgeFade, worldXZ));
        }
      : null,
    /** W8 live look uniforms of `wakeWhiteNode` (debug / browser tuning) */
    laceUniforms: { uLaceFresh, uLaceEdge, uFleckGain },
    wakeWhiteNode: simFoam
      ? (worldXZ: any, maskFresh: any, coverage: any, fresh: any, _pixWorld: any, contact: any = float(0)): any => {
          // round 5: the AREA footprint √(fx·fz) of the screen derivatives in world units — the caller's max() is the
          // along-view stretch of a grazing view, which faded a close (7 m) camera's lace to its mean (a milky sheet).
          // The fbm octaves band-limit themselves per axis (coordFootprint) and the gate's knee widens with fwidth.
          const fw = fwidth(worldXZ);
          const pixWorld = fw.x.mul(fw.y).max(1e-8).sqrt();
          // W8 round 3: ANISOTROPIC, multi-scale — the flow frame of her track (along, across); streaks run with the
          // wake. Three scales blended before the ridge: patches (6 × 24 m), filaments (0.9 × 5 m), bubbles (0.3 m).
          // Heading remains defined at rest. Normalizing velocity with a
          // fixed northward offset distorted the frame at crawling speeds.
          const dir = simFoam.uniforms.uHullDirection;
          const along = worldXZ.dot(dir);
          const across = worldXZ.dot(vec2(dir.y.negate(), dir.x));
          const drift = flowU.uTime.mul(WAKE_LACE.drift);
          const fbmAt = (c: any, oct: number): any => bandLimitedFbm2(c, oct, coordFootprint(c));
          const patch = fbmAt(vec2(across.div(6), along.div(24)).add(vec2(drift.mul(0.3), 0)), 2);
          const filCoord = vec2(across.div(0.9), along.div(5)).add(vec2(drift, drift.mul(-0.4)));
          const fil = fbmAt(filCoord, 3);
          const bub = fbmAt(worldXZ.div(0.3).add(vec2(drift.mul(3), drift.mul(-2))), 2);
          // round 3: the hull-contact line is cm–dm lace, not a stroke — at the contact share the blend swaps its patches
          // for 8 cm bubbles and its edge rises (a thin broken line)
          const fine = fbmAt(worldXZ.div(0.08).add(vec2(drift.mul(6), drift.mul(-5))), 2);
          const c = contact.clamp(0, 1);
          const m = mix(fil.mul(0.55).add(patch.mul(0.3)).add(bub.mul(0.15)), fine.mul(0.55).add(bub.mul(0.25)).add(fil.mul(0.2)), c);
          // ridged: filaments where the blend crosses its mean. Round 6 (the 03 sheet, found by toggling the white term):
          // blending three fbm fields shrinks the spread to σ ≈ 0.1 about 0.5, so the ridge sat near its maximum almost
          // everywhere and the gate passed as a solid film. Restore a ~uniform spread (×4 about the mean) before ridging.
          const ridge = float(1).sub(m.sub(0.5).mul(4).clamp(-0.5, 0.5).mul(2).abs()).pow(2);
          // @band-limited-elsewhere: a VALUE gate on freshness (a ratio of two channels of one filtered sample, no period)
          const t = smoothstep(uLaceFresh.x, uLaceFresh.y, fresh);
          // the lane's thin margins break up first: the edge rises where the wake mask is not dense
          const edge = mix(uLaceEdge.y, uLaceEdge.x, t).add(smoothstep(0.1, 0.7, maskFresh).oneMinus().mul(0.22)).add(c.mul(0.3)).min(0.97);
          const knee = fwidth(ridge).mul(1.5).max(0.04);
          const gate = smoothstep(edge, edge.add(knee), ridge);
          // past the lace cell's pixel scale the gate resolves to its own mean: P(r² > e) = 1 − √e for a ~uniform ridge r
          // @band-limited-elsewhere: this IS the band limit — the caller's pixel footprint (fwidth of worldXZ) against the lace cell
          // round 4: against the FILAMENT's width (~0.1 m: a ridge² line of a 0.9 m cell), not the cell — past it the
          // far wake is the soft pale mean, not grey hair. @band-limited-elsewhere: this IS the band limit (pixel footprint)
          // round 6 (the 03 pale sheet, found by toggling each term): an UNRESOLVED fbm returns its mean 0.5, and the
          // ridge of 0.5 is its MAXIMUM (1), so wherever the filament field faded — a grazing close view stretches its
          // footprint along the view — the gate passed everywhere and drew a solid pale sheet. The gate is also retired
          // by the filament field's own footprint (cells per pixel, both axes), not just the pixel area.
          // @band-limited-elsewhere: these two ARE the band limit (the field's coordinate footprint and the pixel area)
          const filResolved = smoothstep(float(0.35), float(0.12), coordFootprint(filCoord));
          // @band-limited-elsewhere: as above
          const resolved = smoothstep(float(0.09), float(0.025), pixWorld).mul(filResolved);
          // even dense churn is not a flat decal: its brightness follows the same filaments
          // round 6: the unresolved fallback is the gate's area share SQUARED — a lace whose filaments cannot be resolved
          // reads as a faint pale tint of the water, not an opaque white film (the 03 grazing close view)
          const lace = mix(float(1).sub(edge.max(0).sqrt()).pow(2), gate, resolved).mul(ridge.mul(0.35).add(0.65));
          return lace.mul(mix(uFleckGain, float(1), t)).mul(smoothstep(0.01, float(0.08).max(fwidth(coverage).mul(2).add(0.01)), coverage));
        }
      : null,

    wakeFoamFreshnessNode: simFoam
      ? (worldXZ: any): any => {
          const tier = (a: typeof acc, exponent: any, fade: any) => {
            const t = texture(a.foamTexture, regionUv(a, worldXZ));
            const r = t.r.max(0).mul(uSlickPerFoamAge);
            return {
              coverage: t.r.mul(regionEdge(a, fade, worldXZ)),
              age: r.div(t.g.max(r).max(1e-5)).clamp(0, 1).pow(exponent),
            };
          };
          const near = tier(acc, uNearAgeExp, uEdgeFade);
          const distant = tier(far, uFarAgeExp, uFarEdgeFade);
          const blend = farWeight(worldXZ);
          // Match foamSampleNode's actual contributions, including edge fade
          // and far strength. Empty or disabled tiers cannot change foam age.
          return coverageWeightedAgeNode(
            near.coverage.mul(blend.oneMinus()), near.age,
            distant.coverage.mul(uFarStrength).mul(blend), distant.age,
          );
        }
      : null,

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
      const t = texture(acc.foamTexture, regionUv(acc, worldXZ));
      const edge = regionEdge(acc, uEdgeFade, worldXZ);
      const wave = t.ba.mul(edge).mul(bandKeepNode(px, uNearFeature, uSlickBandFull, uSlickBandCut));
      if (!(vessels > 0 && simFoam)) return wave;
      // W8 round 3 CHURN ROUGHNESS (vessel mode): the prop wash boils — a lumpy, moving surface where the foam is dense,
      // not a mirror-flat plane under a decal. A band-limited fbm height (WAKE_CHURN_RELIEF m over ~1 m lumps, scrolled
      // two ways so it boils) differentiated over WAKE_CHURN_STEP, × coverage: churned water is never a mirror (the
      // 5 kn prop wash read as a glassy sheet at ×coverage²); the faint band edge stays soft. Octaves fade to their mean below the pixel (bandLimitedFbm2), so the relief
      // does too. Same texture tap as the wave slope: no binding.
      const cov = t.r.mul(edge).clamp(0, 1);
      const tt = flowU.uTime;
      const hAt = (p: any): any => {
        const c1 = p.div(1.1).add(vec2(tt.mul(0.35), tt.mul(-0.2)));
        const c2 = p.div(0.7).add(vec2(tt.mul(-0.25), tt.mul(0.3)));
        return bandLimitedFbm2(c1, 2, coordFootprint(c1)).add(bandLimitedFbm2(c2, 2, coordFootprint(c2))).mul(0.5);
      };
      const h0 = hAt(worldXZ);
      const hx = hAt(worldXZ.add(vec2(WAKE_CHURN_STEP, 0)));
      const hz = hAt(worldXZ.add(vec2(0, WAKE_CHURN_STEP)));
      // round 4: the relief is a sub-metre lump field — fade it (to a smooth mean surface) once a pixel spans a lump's
      // tenth, so a grazing or night view does not alias it into streaky glints
      // @band-limited-elsewhere: this IS the band limit — the pixel footprint against the lump scale
      const fwr = fwidth(worldXZ);
      const k = cov.mul(WAKE_CHURN_RELIEF / WAKE_CHURN_STEP).mul(smoothstep(0.12, 0.04, fwr.x.mul(fwr.y).max(1e-8).sqrt()));
      return wave.add(vec2(hx.sub(h0), hz.sub(h0)).mul(k));
    },

    /**
     * ── THE WAKE AS GEOMETRY (m, signed) — for the ocean's VERTEX stage ──────
     *
     * "A slope, never a displacement: the ocean owns its geometry" was the
     * standing rule and this is its considered reversal. A field that only
     * tilts the normal produces shading variation and NOTHING ELSE — no
     * silhouette, no parallax, no deformation — so the wake read as paint
     * because it WAS paint. This node is the scalar whose gradient is
     * `wakeSlopeNode`, so it is not a new wake: it is the one already modelled,
     * finally allowed to move the mesh. slickMath's header derives each
     * potential term by term.
     *
     *   material.positionNode = positionLocal.add(totalDisp)
     *                                        .add(vec3(0, ff.wakeHeightNode(worldXZ), 0))
     *
     * Sample it at the SAME undisplaced grid `worldXZ` the cascades are sampled
     * at, never at the displaced position — §V.72(a): `CpuOcean.heightAt`
     * inverts the horizontal displacement to find exactly that grid coord
     * before it sums, so anything read at the post-displacement point puts the
     * two seas 1–2 m apart horizontally (§B.34 by a third route).
     *
     * NEAR TIER ONLY, like the slope: the far tier is 2.5 m per texel and
     * carries neither wave train nor mound, so there is nothing to displace by
     * out there and this reads 0 as the near region fades.
     *
     * NO BAND-LIMIT GATE, and that is a decision rather than an omission.
     * `wakeSlopeNode` needs `bandKeepNode` because a slope is DIFFERENTIATED in
     * screen space (§V.49) and its aliasing comes back amplified. A DISPLACEMENT
     * is not differentiated by anyone — the normals come from the cascades and
     * from `wakeSlopeNode`, never from this mesh — so its only exposure is the
     * vertex grid's own Nyquist limit, and the field band-limits ITSELF there:
     * amplitude = slope·λ/2π, so any term short enough to alias is also small
     * enough not to matter (measured: 4.5 mm at the ship, 26 mm worst case
     * anywhere in the LOD's range). A gate here would ALSO be unmirrorable —
     * vertex spacing is a function of the CAMERA, and §V.8 forbids the floated
     * sea depending on where anyone is looking. The bound is stated instead.
     *
     * §V.40: +1 texture, +1 sampler, IN THE VERTEX STAGE — which was at 4/4
     * against 16. The fragment stage is at 16/16 sampled textures and this
     * spends none of it; bindings key on (node, shaderStage), and the fragment
     * already has the slope it needs.
     */
    wakeHeightNode(worldXZ: any): any {
      return texture(acc.elevTexture, regionUv(acc, worldXZ))
        .r.mul(regionEdge(acc, uEdgeFade, worldXZ));
    },

    dispose(): void {
      acc.dispose();
      far.dispose();
      wakeSim?.dispose();
    },
  };
}

export type FlowFoam = ReturnType<typeof createFlowFoam>;
