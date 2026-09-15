/**
 * FOAM AND SLICK FROM THE SIM WAKE (§T.171 W5, §T.180 W5b; docs/wake/w5-foam.md,
 * docs/wake/w5b.md, wake-research.md §5.4). With `wakeBackend: 'sim'` the white
 * trail and the glassy lane are injected from the SAME solver field the ocean
 * is displaced by, so the paint can no longer disagree with the shape. The
 * analytic Kelvin doses are not evaluated on that backend at all (the pirate
 * page keeps them until W6, §T.172).
 *
 * Per texel, ONE expression (§V77 — `simFoamRate`, and the texel sampler
 * `simFoamSample` around it, instantiated for numbers by the CPU twins and for
 * TSL nodes by `createSimFoamField`):
 *
 *   BREAKING   the INCREMENT the wake adds to breaking, against the ambient sea:
 *                ΔB = max(0, E[B(|∇η_wake + ∇η_amb|)] − E[B(|∇η_amb|)])
 *                B(s) = smoothstep(0.30, 0.44, s)
 *              0.44 is the Stokes limiting steepness (H/λ ≈ 1/7 ⇒ ka ≈ 0.44);
 *              0.30 is the onset the research doc gives. For deep-water modes
 *              the vertical accelerations add as g·Σkᵢaᵢ, so the SUM of the
 *              slopes is the downward-acceleration criterion (one criterion,
 *              not two). The ambient slope enters as a statistic, not a phase:
 *              an isotropic Gaussian with per-axis σ_amb measured from the
 *              ocean's own slope spectrum BAND-LIMITED to the sim's band
 *              (λ ≥ 2 sim texels — `bandSlopeVariance`). E[·] is a fixed
 *              5 × 3 Gauss–Hermite rule aligned with the wake slope, which is
 *              exact at σ = 0, so a calm sea reproduces W5 bit for bit. The
 *              subtraction is the no-double-count rule: where the wake adds no
 *              slope the increment is exactly 0 and ambient whitecaps stay the
 *              foam sim's (src/foam).
 *   CHURN      the rate the hull displaces water at a FIXED world point:
 *                ∂h_P/∂t ≈ −u·∇h_P  +  w(x,z)·ℓ·|∇h_P|/D
 *              translation (W5) plus the §T.70 VERTICAL term: the hull's burial
 *              rate w (hullContact `rate`, fitted as a plane over her stations,
 *              so heave, pitch and roll all enter) carried out through the
 *              waterline rim. ℓ = A_wp/P (waterplane area over perimeter) makes
 *              ∫ w·ℓ·|∇h_P|/D dA = w·A_wp·(h_peak/D) — the volume flux a
 *              heaving waterplane pushes out. bury = max(0, ∂h/∂t), emerge =
 *              max(0, −∂h/∂t), scaled by Bernoulli `liftFraction(√(U²+w²), D)`
 *              and normalised by D, so one passage lays a dose ∝ lift (§V66).
 *              W8 vessel mode: bury/emerge count only the vertical surface speed
 *              past the air-entrainment onset V_e (`SHEET_ENTRAINMENT_ONSET`):
 *              water displaced slower than ≈ 1 m/s folds in no air. The raft
 *              and galleon (single-hull graph) keep the W5 law.
 *   PROP WASH  Σ jets (`jetFoamRate`): an actuator-disc jet, excess speed
 *              V_j − U_a = √(U_a² + 2T/ρA) − U_a, as a turbulent ribbon aft of
 *              the prop (half-width r + S_c·s, S_c = 0.1·ΔV/(ΔV + U_a) the co-flow
 *              spread §T.199, potential core 6 D) — injection
 *              drive·ΔV_c(s)/(ΔV·b(s)) across a Gaussian of that width,
 *              floored at the tier texel (the splat-σ law, so the cross-track
 *              integral is kept when it is band-limited). W8: the drive is the
 *              AIR the slipstream carries (`AERATION_SHARE·aerationSpeed`), not
 *              the jet's lifted excess — no air, no bubbles.
 *   EXHAUST    W8 vessel mode: the through-hub gas that rises out as a boil
 *              (`exhaustBoilRate`), a patch where the plume surfaces.
 *   SHEETS     Vessel mode: retained world-space emissions, carrying their own
 *              launch direction, volume and age. Later hull motion cannot reorient them.
 *   FOAM  (R)  breakRate·ΔB + churnRate·(churn + jet) + sheets
 *   SLICK (G)  slickPerFoam·FOAM — the turbulence proxy: the lane is laid where
 *              whitewater was made and outlives it by the slick half-life. The
 *              two decay clocks are what the ocean material reads as AGE
 *              (`index.ts wakeFoamFreshnessNode`, §T.59).
 *
 * FAR TIER (§T.180 b): the far accumulation texel is 2.5 m against a 0.5–0.625 m
 * sim texel, so ONE bilinear tap per far texel point-samples a field it cannot
 * hold. `rateNode(worldXZ, tierTexel)` averages the rate over an S × S stratified
 * grid across the tier texel, S = ⌈tierTexel / simTexel⌉ — a box filter of the
 * bilinear reconstruction at the sim's own sample spacing. The RATE is averaged,
 * not its inputs, because breaking and bury/emerge are non-linear.
 *
 * §V28: every uniform is finite-guarded on the CPU; the solver clamps its slope
 * (±1) and head is a splat of finite samples; D is floored; jets are dropped
 * whole when non-finite; loops have literal bounds. §V40: the solver textures
 * are read in COMPUTE by `textureLoad` — no material binding. §V48: breaking is
 * a VALUE-space gate on a spectral slope band-limited at the solver's Nyquist;
 * the jet ribbon is floored at the tier texel; the far tier is box-filtered.
 * Per-texel noise: none (§B4).
 */
import type { ChineSheetEmitter } from '../wake/chineContact';
import { CHINE_EMISSION_SLOTS, SHEET_ENTRAINMENT_ONSET, packChineEmission, sheetAirShare, type PackedChineEmission } from '../wake/chineEmissions';
import { If, Loop, float, int, ivec2, mix, select, smoothstep, textureLoad, uniform, uniformArray, vec2, vec4 } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { waterlineSheetLaunch } from '../foam/bowSpray';
import { LIFT_DEPTH_FLOOR, liftFraction, type WaterlineSpray } from '../foam/sprayMath';
import { GRAVITY } from '../ocean/oceanMath';
import { SIM_DT } from '../core/loop';
import { simNearWeight, type SimGrid, type SimResampleOps } from './simInjection';
import { WAKE_TEX_CHANNEL } from '../wake/wakeSolverMath';
import { JET_CORE_DIAMETERS, JET_SPREAD, advanceJetRun, aerationSpeed, exhaustBoil, jetExcessSpeed, jetSpreadRate, propWashValid, type PropWashInput } from '../wake/propWash';

export { JET_CORE_DIAMETERS, JET_SPREAD, jetExcessSpeed, type PropWashInput };
import { WAKE_MAX_VESSELS, WAKE_NEAR_BLEND_WIDTHS, type WakeSim } from '../wake/wakeSim';
import { DRIVE_STRUT, appendageFoamDrive, strutsFromJets, type AppendageInput } from '../wake/appendages';
import type { FlowFoamParams } from '../params/flowfoam';
import { orientationMoment } from './wakeOrientation';

/** research §5.4: breaking onset slope */
export const BREAK_ONSET_SLOPE = 0.3;
/** Stokes limiting steepness ka ≈ 0.44 (H/λ ≈ 1/7) — full breaking */
export const STOKES_SLOPE = 0.44;
/** at most this many props per flowfoam (the speedboat carries 3) — a literal shader bound (§V28) */
export const MAX_PROP_JETS = 4;
/** §T.195 VESSEL MODE: prop jets across the whole fleet (8 boats × 3 drives), a literal shader bound (§V28) */
export const MAX_FLEET_JETS = 32;
/**
 * §T.195 AERATION SHARE: ribbon drive (m/s) per unit aeration speed (`propWash.aerationSpeed`, the entrained air's
 * volume flux over the disc). THE ONE LOOK NUMBER of the bubble trail — how white a unit of air reads — sized so a
 * wide-open drive at race speed lays a ribbon dose of ≈ 0.5 (docs/wake/w6-multivessel.md §3).
 */
export const AERATION_SHARE = 0.033;
/**
 * §T.195 the jet ribbon's evaluated extent in vessel mode (m along the jet; ±4 half-widths across): 24 jets per texel
 * cost a bounding test each, not a ribbon. Stated truncation: past 60 m the 1/s ribbon decay has fallen to core/60 of
 * its core value (≈ 4 % for the speedboat's 0.39 m disc) and the accumulated trail — not the injection — carries it.
 */
export const JET_FOAM_REACH = 60;
/** Visual bubble-source fade in vessel mode, metres. The momentum jet keeps
 * its own transport law; deposited foam continues to advect and age normally. */
export const JET_FOAM_FADE_METRES = 12;
/** head-target channels: .r total h_P, .g deep-bin part, .b the jets' (non-hull) share (wakeSolverPasses splat) */
export const HEAD_CHANNEL = { TOTAL: 0, JET: 2 } as const;

/** the arithmetic `simFoamRate` is written against — numbers or TSL nodes */
export interface SimFoamArith<T> {
  k(v: number): T;
  add(a: T, b: T): T;
  sub(a: T, b: T): T;
  mul(a: T, b: T): T;
  div(a: T, b: T): T;
  max(a: T, b: T): T;
  min(a: T, b: T): T;
  neg(a: T): T;
  sqrt(a: T): T;
  exp(a: T): T;
  // @band-limited-elsewhere: a TYPE SIGNATURE, not a shader edge — the uses are justified at their call sites
  smoothstep(e0: T, e1: T, x: T): T;
}

export interface SimFoamInputs<T> {
  /** |∇η_vis| of the sim surface (dimensionless) */
  slope: T;
  /** u·∇h_P: hull velocity (m/s) dotted with the pressure-head gradient — the translation part of −∂h_P/∂t */
  headAdvect: T;
  /** liftFraction(√(U² + w_rms²), D) — computed once per frame by the CPU function */
  lift: T;
  /** D: deepest HULL source depth this tick (m), the column the lift is measured against */
  depth: T;
  /** per-axis RMS slope of the ambient sea in the sim's band (dimensionless, ≥ 0) */
  ambientSigma: T;
  /** E[B(|∇η_amb|)] — `expectedBreaking(0, σ)`, evaluated once per frame by the CPU instance */
  ambientBreak: T;
  /** §T.70 hull burial rate w at this point (m/s, + = the hull driving into the water) */
  burialRate: T;
  /** |∇h_P| at this point (dimensionless) */
  headGrad: T;
  /** ℓ = A_wp / perimeter of the hull's waterplane (m) */
  rimLength: T;
  /** Σ prop-wash jet injection at this point (1/s, `jetFoamRate`) */
  jet: T;
  /**
   * W8 vessel mode: the plunge speed below which displaced water folds in no air (`SHEET_ENTRAINMENT_ONSET`, m/s) —
   * the churn counts only the vertical surface speed past it. Absent (the single-hull raft/galleon graph): the W5 law,
   * node for node.
   */
  airOnset?: T;
}

export type SimFoamParams = Pick<FlowFoamParams, 'simBreakRate' | 'simChurnRate' | 'simSternChurn' | 'simSlickPerFoam'>;

// @band-limited-elsewhere: a VALUE-space gate on steepness (dimensionless), not a spatial coordinate
const breakingOf = <T>(A: SimFoamArith<T>, s: T): T => A.smoothstep(A.k(BREAK_ONSET_SLOPE), A.k(STOKES_SLOPE), s);

/**
 * Gauss–Hermite nodes for E over N(0, σ²): physicists' nodes ×√2σ, weights /√π.
 * ALONG the wake slope 5 points (exact for polynomials to degree 9), ACROSS it
 * 3 points folded to 2 by symmetry (|s| is even in the across offset).
 */
const GH5 = (() => {
  const x = [0, 0.9585724646138185, 2.0201828704560856];
  const w = [0.9453087204829419, 0.3936193231522412, 0.0199532420590459];
  const rootPi = Math.sqrt(Math.PI);
  const out: [number, number][] = [[0, w[0] / rootPi]];
  for (let i = 1; i < 3; i++) {
    out.push([Math.SQRT2 * x[i], w[i] / rootPi], [-Math.SQRT2 * x[i], w[i] / rootPi]);
  }
  return out;
})();
const GH3_FOLDED: readonly [number, number][] = [
  [0, 2 / 3],
  [Math.sqrt(3), 1 / 3],
];
/** the quadrature, as (along offset in σ, across offset in σ, weight) — weights sum to 1 */
export const AMBIENT_QUADRATURE: readonly (readonly [number, number, number])[] = GH5.flatMap(([a, wa]) =>
  GH3_FOLDED.map(([c, wc]) => [a, c, wa * wc] as const),
);

/**
 * E[B(|s_w + s_amb|)] for a wake slope of magnitude `slope` in an isotropic
 * Gaussian ambient slope field of per-axis RMS `sigma` (header). Exact at σ = 0.
 */
export function expectedBreaking<T>(A: SimFoamArith<T>, slope: T, sigma: T): T {
  let sum = A.k(0);
  for (const [along, across, weight] of AMBIENT_QUADRATURE) {
    const a = A.add(slope, A.mul(sigma, A.k(along)));
    const c = A.mul(sigma, A.k(across));
    sum = A.add(sum, A.mul(A.k(weight), breakingOf(A, A.sqrt(A.add(A.mul(a, a), A.mul(c, c))))));
  }
  return sum;
}

/** THE expression (header). Returns [foam rate, slick rate] per second. */
export function simFoamRate<T>(A: SimFoamArith<T>, i: SimFoamInputs<T>, p: { [K in keyof SimFoamParams]: T }): [T, T] {
  const zero = A.k(0);
  const d = A.max(i.depth, A.k(LIFT_DEPTH_FLOOR));
  const breaking = A.max(zero, A.sub(expectedBreaking(A, i.slope, i.ambientSigma), i.ambientBreak));
  // ∂h_P/∂t at this point: translation plus the vertical burial carried out through the rim
  const vertical = A.div(A.mul(A.mul(i.burialRate, i.rimLength), i.headGrad), d);
  const rise = A.add(A.neg(i.headAdvect), vertical);
  // W8 (vessel mode): rise·(1 − V_e/rise) past the entrainment onset — Ervine's air share, as the chine sheets use
  const bury = i.airOnset === undefined ? A.max(zero, rise) : A.max(zero, A.sub(rise, i.airOnset));
  const emerge = i.airOnset === undefined ? A.max(zero, A.neg(rise)) : A.max(zero, A.sub(A.neg(rise), i.airOnset));
  const churn = A.div(A.mul(i.lift, A.add(bury, A.mul(p.simSternChurn, emerge))), d);
  const foam = A.add(A.mul(p.simBreakRate, breaking), A.mul(p.simChurnRate, A.add(churn, i.jet)));
  return [foam, A.mul(p.simSlickPerFoam, foam)];
}

export const NUM: SimFoamArith<number> = {
  k: (v) => v,
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  div: (a, b) => a / b,
  max: (a, b) => Math.max(a, b),
  min: (a, b) => Math.min(a, b),
  neg: (a) => -a,
  sqrt: (a) => Math.sqrt(Math.max(0, a)),
  exp: (a) => Math.exp(a),
  smoothstep: (e0, e1, x) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  },
};

/** CPU E[B] (tests, and the per-frame `ambientBreak` uniform) */
export function expectedBreakingCpu(slope: number, sigma: number): number {
  if (!Number.isFinite(slope) || !Number.isFinite(sigma)) return 0;
  return expectedBreaking(NUM, Math.max(0, slope), Math.max(0, sigma));
}

/** CPU instance (gameplay/audio/tests). Omitted W5b inputs are 0. §V28: a non-finite input injects nothing. */
export function simFoamRateCpu(
  i: Pick<SimFoamInputs<number>, 'slope' | 'headAdvect' | 'lift' | 'depth'> & Partial<SimFoamInputs<number>>,
  p: SimFoamParams,
): [number, number] {
  const sigma = i.ambientSigma ?? 0;
  const full: SimFoamInputs<number> = {
    ambientBreak: expectedBreakingCpu(0, sigma),
    burialRate: 0,
    headGrad: 0,
    rimLength: 0,
    jet: 0,
    ...i,
    ambientSigma: sigma,
  };
  if (!Object.values(full).every(Number.isFinite)) return [0, 0];
  return simFoamRate(NUM, full, p);
}

// ---------------------------------------------------------------------------
// PROP WASH (§T.180 c)
// ---------------------------------------------------------------------------

/**
 * Foam injection (1/s) of one jet at a point `(dx, dz)` from its prop, on a tier
 * of texel `texel` (header). `drive` = liftFraction(ΔV, d_prop)·ΔV (m/s).
 */
export function jetFoamRate<T>(A: SimFoamArith<T>, dx: T, dz: T, dirX: T, dirZ: T, drive: T, radius: T, texel: T, spread: T = A.k(JET_SPREAD), finiteBubbles = false): T {
  const zero = A.k(0);
  const s = A.add(A.mul(dx, dirX), A.mul(dz, dirZ));
  const n = A.sub(A.mul(dz, dirX), A.mul(dx, dirZ));
  const ahead = A.max(s, zero);
  // §T.199 the co-flow spread (`propWash.jetSpreadRate`); JET_SPREAD when not given
  const b = A.add(radius, A.mul(spread, ahead));
  // the splat-σ law: convolve with one tier texel so the ribbon cannot alias, integral across kept
  const bEff = A.sqrt(A.add(A.mul(b, b), A.mul(texel, texel)));
  const core = A.mul(radius, A.k(2 * JET_CORE_DIAMETERS));
  const decay = A.div(core, A.max(ahead, core));
  // @band-limited-elsewhere: a ramp over the prop DISC (≥ one tier texel below via bEff) along the jet axis, evaluated in COMPUTE
  const start = A.smoothstep(A.neg(bEff), bEff, s);
  let exponent = A.neg(A.div(A.mul(n, n), A.mul(A.k(2), A.mul(bEff, bEff))));
  // Combine bubble depletion with the Gaussian's existing exponential. This
  // limits fresh whitewater generation, not the lifetime of foam already laid.
  if (finiteBubbles) exponent = A.sub(exponent, A.div(ahead, A.k(JET_FOAM_FADE_METRES)));
  const across = A.exp(exponent);
  return A.mul(A.div(A.mul(A.mul(drive, decay), across), bEff), start);
}

/**
 * W8 EXHAUST BOIL LOOK CALIBRATION: gas volume (m) per unit area that reads as full coverage. A monolayer of ~2 mm
 * bubbles holds ≈ 3 mm of gas per m². Measured in the browser (free roam, 0.7 m/s): with the near tier's blur the boil
 * spreads to σ ≈ 3 m within its life, so an idling drive's patch lands mid-gate at this value, where 13 mm left it
 * invisible (docs/wake/w8-foam-readability.md §2).
 */
export const EXHAUST_FOAM_LAYER = 0.002;

/**
 * packed per-jet uniform state: [x, z, dirX, dirZ], [boil amplitude, radius, aeration drive, co-flow spread] and
 * [boil along, boil σ, 0, 0] — zero drive and zero amplitude is an idle slot; §T.199 meta.w = `jetSpreadRate`.
 *
 * W8 (docs/wake/w8-foam-readability.md §2): the RIBBON's drive is the AIR only, meta.z = AERATION_SHARE·aerationSpeed.
 * It used to add the jet's Bernoulli-lifted excess lift(ΔV, d)·ΔV (§T.180 c): 1.9–2.8 m/s at 5 m/s against an air drive
 * of 0.3, so the ribbon was widest and whitest at displacement speed and faded as ΔV fell with speed — the inverse of
 * the real thing. A jet that carries no air lays no bubbles; its upwelling is drawn by the SURFACE (`propJetSample`,
 * the wake solver's jet head). meta.x is the exhaust boil's peak amplitude φ·Q_ex/(2π·EXHAUST_FOAM_LAYER) (`exhaustBoil`).
 */
export function packPropJet(j: PropWashInput): { pos: [number, number, number, number]; meta: [number, number, number, number]; boil: [number, number, number, number] } | null {
  if (!propWashValid(j)) return null;
  const len = Math.hypot(j.dirX, j.dirZ);
  // the drive model already scaled thrust by the prop's immersion
  const excess = jetExcessSpeed(j.advance, j.thrust, j.discArea);
  const ex = exhaustBoil(j);
  const amp = j.immersion > 0 ? (ex.share * ex.flux) / (2 * Math.PI * EXHAUST_FOAM_LAYER) : 0;
  return {
    pos: [j.x, j.z, j.dirX / len, j.dirZ / len],
    meta: [amp, Math.sqrt(j.discArea / Math.PI), AERATION_SHARE * aerationSpeed(j), jetSpreadRate(excess, j.advance)],
    // W8 round 3: boil.z = the drive strut's streak drive (`appendages.appendageFoamDrive`), boil.w its lead ahead of the prop
    boil: [Math.min(ex.along, JET_FOAM_REACH), ex.sigma, strutDriveOf(j), DRIVE_STRUT.lead],
  };
}

/**
 * W8 the exhaust boil (1/s) at (dx, dz) from its prop: a Gaussian patch of the surfacing gas, `along` aft on the jet
 * axis, widened by one tier texel (the splat-σ law) so its area integral φ·Q_ex/EXHAUST_FOAM_LAYER is kept. ONE
 * expression for CPU and TSL.
 */
export function exhaustBoilRate<T>(A: SimFoamArith<T>, dx: T, dz: T, dirX: T, dirZ: T, amp: T, along: T, sigma: T, texel: T): T {
  const s = A.sub(A.add(A.mul(dx, dirX), A.mul(dz, dirZ)), along);
  const n = A.sub(A.mul(dz, dirX), A.mul(dx, dirZ));
  const v = A.add(A.mul(sigma, sigma), A.mul(texel, texel));
  return A.mul(A.div(amp, v), A.exp(A.neg(A.div(A.add(A.mul(s, s), A.mul(n, n)), A.mul(A.k(2), v)))));
}

/**
 * W8 round 4 (impacts): a ribbon exists only as far aft as the prop has been laying it. After a landing, a prop that
 * re-enters the water laid the steady 12–60 m ribbon on its first tick — the lane "appearing within two frames". The
 * window is 1 up to `run` metres aft (the distance run since the prop re-entered), falling to 0 over the next 2 m.
 * ONE expression for CPU and TSL.
 */
export function jetRunWindow<T>(A: SimFoamArith<T>, dx: T, dz: T, dirX: T, dirZ: T, run: T): T {
  const s = A.add(A.mul(dx, dirX), A.mul(dz, dirZ));
  // @band-limited-elsewhere: a 2 m window along the jet axis, evaluated in COMPUTE (no pixel footprint)
  return A.smoothstep(A.add(run, A.k(2)), run, s);
}

const strutScratch: AppendageInput[] = [];
function strutDriveOf(j: PropWashInput): number {
  return strutsFromJets([j], strutScratch) > 0 ? appendageFoamDrive(strutScratch[0]) : 0;
}

/**
 * W8 round 3: the streak (1/s) behind a drive strut at (dx, dz) from its PROP — the ribbon law (`jetFoamRate`) from the
 * strut's trailing edge, its half-width the strut's thickness, still-water spread (an unventilated eddy street or a
 * ventilated cavity spreads like a small jet, not like the co-flowing slipstream), bubble source faded over
 * JET_FOAM_FADE_METRES. ONE expression for CPU and TSL.
 */
export function strutFoamRate<T>(A: SimFoamArith<T>, dx: T, dz: T, dirX: T, dirZ: T, drive: T, lead: T, texel: T): T {
  const sx = A.add(dx, A.mul(dirX, lead));
  const sz = A.add(dz, A.mul(dirZ, lead));
  return jetFoamRate(A, sx, sz, dirX, dirZ, drive, A.k(DRIVE_STRUT.thickness), texel, A.k(JET_SPREAD), true);
}

/** CPU Σ drive-strut streaks at a world point (vessel mode) */
export function strutFoamCpu(jets: readonly PropWashInput[], x: number, z: number, texel: number): number {
  let sum = 0;
  for (const j of jets) {
    const q = packPropJet(j);
    if (!q || !(q.boil[2] > 0)) continue;
    sum += strutFoamRate(NUM, x - q.pos[0], z - q.pos[1], q.pos[2], q.pos[3], q.boil[2], q.boil[3], texel);
  }
  return sum;
}

/** CPU Σ exhaust boils at a world point (tests; vessel mode lays them) */
export function exhaustBoilFoamCpu(jets: readonly PropWashInput[], x: number, z: number, texel: number): number {
  let sum = 0;
  for (const j of jets) {
    const q = packPropJet(j);
    if (!q || !(q.meta[0] > 0)) continue;
    sum += exhaustBoilRate(NUM, x - q.pos[0], z - q.pos[1], q.pos[2], q.pos[3], q.meta[0], q.boil[0], q.boil[1], texel);
  }
  return sum;
}

/** §T.195 the vessel-mode ribbon bound (JET_FOAM_REACH): inside ⇔ the jet is evaluated at this point */
export function jetInReach<T>(A: SimFoamArith<T> & { le(a: T, b: T): T; and(a: T, b: T): T }, dx: T, dz: T, dirX: T, dirZ: T, radius: T, texel: T): T {
  const s = A.add(A.mul(dx, dirX), A.mul(dz, dirZ));
  const n = A.sub(A.mul(dz, dirX), A.mul(dx, dirZ));
  const bMax = A.add(A.add(radius, A.k(JET_SPREAD * JET_FOAM_REACH)), texel);
  const across = A.mul(A.k(4), bMax);
  return A.and(A.and(A.le(A.neg(across), s), A.le(s, A.k(JET_FOAM_REACH))), A.le(A.mul(n, n), A.mul(across, across)));
}

/** CPU Σ jets at a world point (tests); `reach` = the vessel-mode bound */
export function propWashFoamCpu(jets: readonly PropWashInput[], x: number, z: number, texel: number, reach = false): number {
  let sum = 0;
  const B = { ...NUM, le: (a: number, b: number) => (a <= b ? 1 : 0), and: (a: number, b: number) => a * b };
  for (const j of jets) {
    const packed = packPropJet(j);
    if (!packed) continue;
    const [px, pz, dx, dz] = packed.pos;
    if (reach && !jetInReach(B, x - px, z - pz, dx, dz, packed.meta[1], texel)) continue;
    sum += jetFoamRate(NUM, x - px, z - pz, dx, dz, packed.meta[2], packed.meta[1], texel, packed.meta[3], reach);
  }
  return sum;
}

// ---------------------------------------------------------------------------
// §T.199 THE CHINE SPRAY SHEETS — the V's two white lines
// ---------------------------------------------------------------------------

/** Landed-water thickness for full coverage (look calibration): 10 mm keeps the interior translucent. */
export let CHINE_SHEET_THICKNESS = 0.01;
/** Landed sheet mixing time, seconds (look calibration, not a measured fluid constant). */
export let CHINE_SHEET_SLIDE = 0.45;
/** scratch/tests only: set the two look numbers */
export function setChineSheetLook(thickness: number, slide: number): void {
  CHINE_SHEET_THICKNESS = thickness;
  CHINE_SHEET_SLIDE = slide;
}
/** §T.199 landed half-width at the chine (m) and its growth per metre of line — the sheet's lateral scatter (look) */
export const CHINE_SHEET_WIDTH = 0.25;
export const CHINE_SHEET_SPREAD = 0.02;
/** §T.199 the landing length never shorter than this (m): a sheet that barely leaves the water still lands aft of its root */
export const CHINE_SHEET_MIN_LENGTH = 2;
/** §T.199 lines evaluated to this many landing lengths (e^−5 ≈ 0.7 % left) */
export const CHINE_SHEET_REACH = 5;

/**
 * Pack [x, z, halfWidth, Q_side/h] and [aftX, aftZ, launchSlope, L].
 * L = U * (flight time + mixing time). The landed source follows
 * y(s) = halfWidth + launchSlope * L * (1 - exp(-s/L)), not an endless straight ray.
 * Each arm integrates to Q_side/h over its axial exponential and lateral Gaussian.
 * This is the steady-tow reference; live vessels use retained emission packets.
 * This is a surface-foam model; airborne spray retains its ballistic launch.
 */
export function packChineSheet(bow: Readonly<WaterlineSpray>, speed: number): { a: [number, number, number, number]; b: [number, number, number, number] } | null {
  if (!bow.inContact || !(bow.flux > 0)) return null;
  const vals = [bow.x, bow.z, bow.halfWidth, bow.fwdX, bow.fwdZ, bow.flux, bow.launch, speed];
  if (!vals.every(Number.isFinite)) return null;
  const u = Math.abs(speed);
  const l = waterlineSheetLaunch(u, bow.launch);
  if (!(u > 0.5) || !(l.outboard > 0) || !(sheetAirShare(l.up) > 0)) return null;
  const len = Math.hypot(bow.fwdX, bow.fwdZ);
  if (!(len > 1e-9)) return null;
  const L = Math.max(CHINE_SHEET_MIN_LENGTH, u * ((2 * l.up) / GRAVITY + CHINE_SHEET_SLIDE));
  return {
    a: [bow.x, bow.z, Math.max(0.3, bow.halfWidth), (0.5 * bow.flux * sheetAirShare(l.up)) / CHINE_SHEET_THICKNESS],
    b: [-bow.fwdX / len, -bow.fwdZ / len, l.outboard / Math.max(u, l.outboard), L],
  };
}

/**
 * §T.199 coverage rate (1/s) the two sheet lines of one packed hull lay at (dx, dz) from her emission centroid (header of
 * `packChineSheet`), on a tier of texel `texel` (the splat-σ law, as the ribbon). ONE expression for CPU and TSL.
 */
export function chineSheetFoamRate<T>(A: SimFoamArith<T>, dx: T, dz: T, a: readonly [T, T, T, T], b: readonly [T, T, T, T], texel: T): T {
  const zero = A.k(0);
  const [, , halfWidth, drive] = a;
  const [ax, az, tanA, L] = b;
  const along = A.add(A.mul(dx, ax), A.mul(dz, az));
  const lateral = A.sub(A.mul(dz, ax), A.mul(dx, az));
  const ahead = A.max(along, zero);
  // Landed water loses lateral momentum to the surface layer. This curve has
  // the launch angle at the root, then approaches a finite outboard distance.
  // The same exponential supplies the landing density; no extra exp per arm.
  const survival = A.exp(A.neg(A.div(ahead, L)));
  const outboard = A.add(halfWidth, A.mul(A.mul(tanA, L), A.sub(A.k(1), survival)));
  const b0 = A.add(A.k(CHINE_SHEET_WIDTH), A.mul(A.k(CHINE_SHEET_SPREAD), ahead));
  const bEff = A.sqrt(A.add(A.mul(b0, b0), A.mul(texel, texel)));
  const start = A.smoothstep(A.neg(bEff), bEff, along);
  const landing = A.div(survival, L);
  const rate = A.mul(A.div(A.mul(drive, landing), A.mul(A.k(Math.sqrt(2 * Math.PI)), bEff)), start);
  let sum = zero;
  for (const side of [-1, 1]) {
    const n = A.sub(lateral, A.mul(A.k(side), outboard));
    const across = A.exp(A.neg(A.div(A.mul(n, n), A.mul(A.k(2), A.mul(bEff, bEff)))));
    sum = A.add(sum, A.mul(rate, across));
  }
  return sum;
}

/** §T.199 the sheet lines' evaluated extent: within CHINE_SHEET_REACH·L along and 4 widths across (both rays) */
export function chineSheetInReach<T>(A: SimFoamArith<T> & { le(a: T, b: T): T; and(a: T, b: T): T }, dx: T, dz: T, a: readonly [T, T, T, T], b: readonly [T, T, T, T], texel: T): T {
  const [, , halfWidth] = a;
  const [ax, az, tanA, L] = b;
  const reach = A.mul(A.k(CHINE_SHEET_REACH), L);
  const along = A.add(A.mul(dx, ax), A.mul(dz, az));
  const across = A.sub(A.mul(dz, ax), A.mul(dx, az));
  const bMax = A.add(A.add(A.k(CHINE_SHEET_WIDTH), A.mul(A.k(CHINE_SHEET_SPREAD), reach)), texel);
  const half = A.add(A.add(halfWidth, A.mul(tanA, L)), A.mul(A.k(4), bMax));
  return A.and(A.and(A.le(A.neg(A.mul(A.k(4), bMax)), along), A.le(along, reach)), A.le(A.mul(across, across), A.mul(half, half)));
}

/** CPU Σ sheets at a world point (tests) */
export function chineSheetFoamCpu(sheets: readonly ({ bow: Readonly<WaterlineSpray>; speed: number } | ChineSheetEmitter)[], x: number, z: number, texel: number): number {
  const B = { ...NUM, le: (a: number, b: number) => (a <= b ? 1 : 0), and: (a: number, b: number) => a * b };
  let sum = 0;
  for (const e of sheets) {
    if ('emissions' in e) {
      sum += retainedChineFoamCpu([e], x, z, texel);
      continue;
    }
    // Steady-tow calibration inputs have no emission timeline. Live vessel
    // inputs above always use their retained packets, as the GPU does.
    const q = packChineSheet(e.bow, e.speed);
    if (!q || !chineSheetInReach(B, x - q.a[0], z - q.a[1], q.a, q.b, texel)) continue;
    sum += chineSheetFoamRate(NUM, x - q.a[0], z - q.a[1], q.a, q.b, texel);
  }
  return sum;
}

/** Normalized two-sided packet footprint; CPU and GPU share this expression. */
export function chineEmissionRate<T>(A: SimFoamArith<T>, along: T, across: T, offset: T, rate: T, varAlong: T, varAcross: T): T {
  const axial = A.div(A.mul(along, along), varAlong);
  let sum = A.k(0);
  for (const side of [-1, 1]) {
    const n = A.sub(across, A.mul(A.k(side), offset));
    const exponent = A.mul(A.k(-0.5), A.add(axial, A.div(A.mul(n, n), varAcross)));
    sum = A.add(sum, A.exp(exponent));
  }
  return A.div(A.mul(rate, sum), A.mul(A.k(2 * Math.PI), A.sqrt(A.mul(varAlong, varAcross))));
}

export function packedChineFoamCpu(packets: readonly PackedChineEmission[], x: number, z: number, texel: number): number {
  let sum = 0;
  for (const q of packets) {
    const [cx, cz, offset, rate] = q.a;
    const [fx, fz, va, vl] = q.b;
    const along = (x - cx) * fx + (z - cz) * fz;
    const across = (z - cz) * fx - (x - cx) * fz;
    const varAlong = va + texel * texel, varAcross = vl + texel * texel;
    if (along * along >= 16 * varAlong || Math.abs(across) >= offset + 4 * Math.sqrt(varAcross)) continue;
    sum += chineEmissionRate(NUM, along, across, offset, rate, varAlong, varAcross);
  }
  return sum;
}

export function retainedChineFoamCpu(sheets: readonly ChineSheetEmitter[], x: number, z: number, texel: number): number {
  const packets: PackedChineEmission[] = [];
  for (const e of sheets) for (const emission of e.emissions) {
    const q = packChineEmission(emission, e.time, CHINE_SHEET_THICKNESS, CHINE_SHEET_SLIDE);
    if (q) packets.push(q);
  }
  return packedChineFoamCpu(packets, x, z, texel);
}

// ---------------------------------------------------------------------------
// §T.195 VESSEL MODE — every boat's hull churns at its own velocity
// ---------------------------------------------------------------------------

/** one vessel slot the churn blends over: plan centre, radius, velocity, lift, depth, burial share */
export interface VesselChurnSlot<T> {
  x: T;
  z: T;
  radius: T;
  vx: T;
  vz: T;
  lift: T;
  depth: T;
}

/**
 * The hull velocity, lift and depth AT A POINT when several hulls press the one head field: each slot weighs
 * g_i = exp(−d_i²/(2R_i²)) (R_i its plan radius), the churn reads Σ g·v / Σ g (and lift, depth alike), and the
 * hero's burial plane is scaled by her share g_0/Σ g — so a rival's head is never advected at the hero's velocity
 * and the hero's pitch plane is not extrapolated under a rival 100 m away. A lone vessel reads exactly its own
 * values wherever its weight is non-negligible (share → 1). ONE expression for CPU and TSL (§V77).
 */
export function blendVessels<T>(A: SimFoamArith<T>, x: T, z: T, slots: readonly VesselChurnSlot<T>[]): { vx: T; vz: T; lift: T; depth: T; heroShare: T } {
  let sum = A.k(0);
  let vx = A.k(0);
  let vz = A.k(0);
  let lift = A.k(0);
  let depth = A.k(0);
  let hero = A.k(0);
  slots.forEach((s, i) => {
    const dx = A.sub(x, s.x);
    const dz = A.sub(z, s.z);
    const r = A.max(s.radius, A.k(1));
    const g = A.exp(A.neg(A.div(A.add(A.mul(dx, dx), A.mul(dz, dz)), A.mul(A.k(2), A.mul(r, r)))));
    sum = A.add(sum, g);
    vx = A.add(vx, A.mul(g, s.vx));
    vz = A.add(vz, A.mul(g, s.vz));
    lift = A.add(lift, A.mul(g, s.lift));
    depth = A.add(depth, A.mul(g, s.depth));
    if (i === 0) hero = g;
  });
  const inv = A.div(A.k(1), A.max(sum, A.k(1e-6)));
  return { vx: A.mul(vx, inv), vz: A.mul(vz, inv), lift: A.mul(lift, inv), depth: A.max(A.mul(depth, inv), A.k(LIFT_DEPTH_FLOOR)), heroShare: A.mul(hero, inv) };
}

// ---------------------------------------------------------------------------
// AMBIENT SLOPE (§T.180 a)
// ---------------------------------------------------------------------------

/** the ocean cascade's published slope statistics (`OceanCascade`) */
export interface SlopeSpectrumBand {
  slopeVariance(): number;
  slopeFootprint(keep: number): number;
}

/**
 * Slope variance (dimensionless, both axes) the sea carries at wavelengths
 * ≥ `lambdaMin`, from each cascade's published histogram: the largest keep
 * fraction whose resolution footprint (λ/2) is still ≥ λmin/2, bisected.
 */
export function bandSlopeVariance(bands: readonly SlopeSpectrumBand[], lambdaMin: number): number {
  let total = 0;
  for (const b of bands) {
    const v = b.slopeVariance();
    if (!(v > 0) || !Number.isFinite(v)) continue;
    let lo = 0;
    let hi = 1;
    if (b.slopeFootprint(1) >= lambdaMin / 2) lo = 1;
    else {
      for (let it = 0; it < 24; it++) {
        const mid = (lo + hi) / 2;
        if (b.slopeFootprint(mid) >= lambdaMin / 2) lo = mid;
        else hi = mid;
      }
    }
    total += lo * v;
  }
  return total;
}

// ---------------------------------------------------------------------------
// §T.70 HULL BURIAL (§T.180 e)
// ---------------------------------------------------------------------------

/** the slice of `HullContactResult` the burial plane reads (structural, src/sea-physics/hullContact) */
export interface HullBurialInput {
  inContact: boolean;
  readonly rate: ArrayLike<number>;
  readonly worldX: ArrayLike<number>;
  readonly worldZ: ArrayLike<number>;
  readonly sliceZ: ArrayLike<number>;
  readonly sliceHalfWidth: ArrayLike<number>;
}

export interface HullBurialPlane {
  /** w = a + b·(x − ox) + c·(z − oz) (m/s) */
  a: number;
  b: number;
  c: number;
  ox: number;
  oz: number;
  /** RMS station burial rate (m/s) — the vertical part of the lift speed */
  rms: number;
  /** ℓ = A_wp / perimeter (m) */
  rimLength: number;
}

export const NO_BURIAL: Readonly<HullBurialPlane> = Object.freeze({ a: 0, b: 0, c: 0, ox: 0, oz: 0, rms: 0, rimLength: 0 });

/** waterplane area over perimeter of the contact outline (stem and transom faces included) */
export function waterplaneRimLength(sliceZ: ArrayLike<number>, halfWidth: ArrayLike<number>): number {
  const n = Math.min(sliceZ.length, halfWidth.length);
  if (n < 2) return 0;
  let area = 0;
  let perim = 2 * Math.max(0, halfWidth[0]) + 2 * Math.max(0, halfWidth[n - 1]);
  for (let s = 0; s + 1 < n; s++) {
    const dz = Math.abs(sliceZ[s] - sliceZ[s + 1]);
    const ha = Math.max(0, halfWidth[s]);
    const hb = Math.max(0, halfWidth[s + 1]);
    area += (ha + hb) * dz;
    perim += 2 * Math.hypot(dz, hb - ha);
  }
  return perim > 1e-9 && Number.isFinite(area) ? area / perim : 0;
}

/**
 * Least-squares plane of the stations' burial rates over their world XZ.
 * §V28: non-finite stations are skipped; a degenerate layout keeps the mean.
 */
export function fitBurialPlane(c: HullBurialInput): HullBurialPlane {
  const rim = waterplaneRimLength(c.sliceZ, c.sliceHalfWidth);
  const n = Math.min(c.rate.length, c.worldX.length, c.worldZ.length);
  if (!c.inContact || n === 0) return { ...NO_BURIAL, rimLength: rim };
  let cnt = 0;
  let mx = 0;
  let mz = 0;
  let mw = 0;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const x = c.worldX[i];
    const z = c.worldZ[i];
    const w = c.rate[i];
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(w)) continue;
    cnt++;
    mx += x;
    mz += z;
    mw += w;
    sq += w * w;
  }
  if (cnt === 0) return { ...NO_BURIAL, rimLength: rim };
  mx /= cnt;
  mz /= cnt;
  mw /= cnt;
  let sxx = 0;
  let sxz = 0;
  let szz = 0;
  let sxw = 0;
  let szw = 0;
  for (let i = 0; i < n; i++) {
    const x = c.worldX[i] - mx;
    const z = c.worldZ[i] - mz;
    const w = c.rate[i] - mw;
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(w)) continue;
    sxx += x * x;
    sxz += x * z;
    szz += z * z;
    sxw += x * w;
    szw += z * w;
  }
  const det = sxx * szz - sxz * sxz;
  const scale = Math.max(1e-12, (sxx + szz) ** 2);
  const b = Math.abs(det) > 1e-9 * scale ? (sxw * szz - szw * sxz) / det : 0;
  const cc = Math.abs(det) > 1e-9 * scale ? (szw * sxx - sxw * sxz) / det : 0;
  return { a: mw, b, c: cc, ox: mx, oz: mz, rms: Math.sqrt(sq / cnt), rimLength: rim };
}

// ---------------------------------------------------------------------------
// THE TEXEL SAMPLER — one generic expression over the solver's textures
// ---------------------------------------------------------------------------

/** texture ops the sampler is written against (TSL: textureLoad; CPU: typed arrays) */
export interface SimFoamOps<S, T> extends SimFoamArith<S> {
  floorIndex(a: S): S;
  next(i: S): S;
  fract(a: S): S; // @band-limited-elsewhere: an operator DECLARATION, not a use
  /** texel (i, j) of a solver output; 0 outside [0, n) */
  load(tex: 'slope' | 'head', i: S, j: S): T;
  channel(t: T, c: number): S;
}

/** the per-frame scalars a texel sample reads (uniforms on the GPU) */
export interface SimFoamFrame<S> {
  hullVelX: S;
  hullVelZ: S;
  lift: S;
  depth: S;
  ambientSigma: S;
  ambientBreak: S;
  rimLength: S;
  breakRate: S;
  churnRate: S;
  sternChurn: S;
  slickPerFoam: S;
  /** W8 vessel mode only (`SimFoamInputs.airOnset`) */
  airOnset?: S;
}

/**
 * Foam rate (1/s) from ONE bilinear sample of the solver at continuous grid
 * coordinates (gx, gy) (texel centres at integers, row j = world z), with the
 * burial rate `w` and jet injection `jet` already evaluated for this texel.
 */
export function simFoamSample<S, T>(o: SimFoamOps<S, T>, texel: number, gx: S, gy: S, w: S, jet: S, f: SimFoamFrame<S>): S {
  const x0 = o.floorIndex(gx);
  const y0 = o.floorIndex(gy);
  const x1 = o.next(x0);
  const y1 = o.next(y0);
  // @band-limited-elsewhere: bilinear tap weights, evaluated in COMPUTE (no pixel footprint)
  const fx = o.fract(gx);
  // @band-limited-elsewhere: as above
  const fy = o.fract(gy);
  const one = o.k(1);
  const fxm = o.sub(one, fx);
  const fym = o.sub(one, fy);
  const s = [o.load('slope', x0, y0), o.load('slope', x1, y0), o.load('slope', x0, y1), o.load('slope', x1, y1)];
  const bilerp = (c: number): S =>
    o.add(
      o.mul(o.add(o.mul(o.channel(s[0], c), fxm), o.mul(o.channel(s[1], c), fx)), fym),
      o.mul(o.add(o.mul(o.channel(s[2], c), fxm), o.mul(o.channel(s[3], c), fx)), fy),
    );
  const sdx = bilerp(WAKE_TEX_CHANNEL.SLOPE_DX);
  const sdz = bilerp(WAKE_TEX_CHANNEL.SLOPE_DZ);
  // the HULL head: total minus the jets' share (a jet is not a hull entering water)
  const hullHead = (i: S, j: S): S => {
    const q = o.load('head', i, j);
    return o.sub(o.channel(q, HEAD_CHANNEL.TOTAL), o.channel(q, HEAD_CHANNEL.JET));
  };
  const h00 = hullHead(x0, y0);
  const h10 = hullHead(x1, y0);
  const h01 = hullHead(x0, y1);
  const h11 = hullHead(x1, y1);
  const inv = o.k(1 / texel);
  // ∇h_P of the bilinear head (↔ simHeadGradientCpu)
  const dhdx = o.mul(o.add(o.mul(o.sub(h10, h00), fym), o.mul(o.sub(h11, h01), fy)), inv);
  const dhdz = o.mul(o.add(o.mul(o.sub(h01, h00), fxm), o.mul(o.sub(h11, h10), fx)), inv);
  const [foam] = simFoamRate(
    o,
    {
      slope: o.sqrt(o.add(o.mul(sdx, sdx), o.mul(sdz, sdz))),
      headAdvect: o.add(o.mul(f.hullVelX, dhdx), o.mul(f.hullVelZ, dhdz)),
      lift: f.lift,
      depth: f.depth,
      ambientSigma: f.ambientSigma,
      ambientBreak: f.ambientBreak,
      burialRate: w,
      headGrad: o.sqrt(o.add(o.mul(dhdx, dhdx), o.mul(dhdz, dhdz))),
      rimLength: f.rimLength,
      jet,
      airOnset: f.airOnset,
    },
    { simBreakRate: f.breakRate, simChurnRate: f.churnRate, simSternChurn: f.sternChurn, simSlickPerFoam: f.slickPerFoam },
  );
  return foam;
}

/** the sponge edge window at grid coords (the surface resample's law: 0 at the border, 1 inside `edge` texels) */
export function simEdgeWindow<S>(o: SimFoamArith<S>, n: number, edge: number, gx: S, gy: S): S {
  const zero = o.k(0);
  const ex = o.max(o.min(o.add(gx, o.k(0.5)), o.sub(o.k(n - 0.5), gx)), zero);
  const ey = o.max(o.min(o.add(gy, o.k(0.5)), o.sub(o.k(n - 0.5), gy)), zero);
  // @band-limited-elsewhere: a ≥ 19 m window evaluated per texel in COMPUTE, never in a fragment stage
  return o.mul(o.smoothstep(zero, o.k(edge), ex), o.smoothstep(zero, o.k(edge), ey));
}

/** subsamples per axis a tier of texel `tierTexel` needs over a sim of texel `simTexel` (≥ 1) */
export function farSupersample(tierTexel: number, simTexel: number): number {
  return Math.max(1, Math.ceil(tierTexel / simTexel - 1e-6));
}

/** stratified box offset of subsample k of S, in tier texels: (k + ½)/S − ½ — ONE expression for CPU and TSL (§V77) */
export function boxOffsetOf<T>(A: SimFoamArith<T>, k: T, S: number): T {
  return A.sub(A.div(A.add(k, A.k(0.5)), A.k(S)), A.k(0.5));
}
export function boxOffset(k: number, S: number): number {
  return boxOffsetOf(NUM, k, S);
}

/** the CPU solver fields the sampler reads (a `WakeSolverCpu` plus its jet head) */
export interface SimFoamCpuFields {
  n: number;
  texel: number;
  centerX: number;
  centerZ: number;
  slopeX: ArrayLike<number>;
  slopeZ: ArrayLike<number>;
  head: ArrayLike<number>;
  headJet?: ArrayLike<number>;
  sponge: { width: number };
}

export interface SimFoamCpuFrame {
  hullVelX: number;
  hullVelZ: number;
  lift: number;
  depth: number;
  ambientSigma?: number;
  burial?: HullBurialPlane;
  jets?: readonly PropWashInput[];
  /** §T.195 vessel mode: per-vessel slots (hero first) — hullVel/lift/depth are then blended per point, jets bounded */
  vessels?: readonly VesselChurnSlot<number>[];
  /** Live vessels carry retained emissions; bare bow/speed inputs are steady-tow calibration references. */
  sheets?: readonly ({ bow: Readonly<WaterlineSpray>; speed: number } | ChineSheetEmitter)[];
  /** §T.199 the near-hull tier's fields: sampled where the tier's own texel resolves it, cross-faded in (`simNearWeight`) */
  near?: SimFoamCpuFields;
  /** W8 vessel mode's air-entrainment onset (default `SHEET_ENTRAINMENT_ONSET`; tests isolate other terms with 0) */
  airOnset?: number;
}

/**
 * CPU twin of `rateNode` (tests): [foam, slick] rate at a world point for a
 * tier of texel `tierTexel` — the same sampler, S × S box, window and jets.
 */
export function simFoamRateAtCpu(
  fields: SimFoamCpuFields,
  x: number,
  z: number,
  tierTexel: number,
  frame: SimFoamCpuFrame,
  p: SimFoamParams,
): [number, number] {
  const { n, texel } = fields;
  const zeroLoad = { slope: [0, 0, 0, 0], head: [0, 0, 0, 0] };
  const ops: SimFoamOps<number, number[]> = {
    ...NUM,
    floorIndex: Math.floor,
    next: (i) => i + 1,
    fract: (a) => a - Math.floor(a),
    load: (tex, i, j) => {
      if (i < 0 || j < 0 || i >= n || j >= n) return zeroLoad[tex];
      const q = j * n + i;
      if (tex === 'head') return [fields.head[q], 0, fields.headJet ? fields.headJet[q] : 0, 0];
      const t = [0, 0, 0, 0];
      t[WAKE_TEX_CHANNEL.SLOPE_DX] = fields.slopeX[q];
      t[WAKE_TEX_CHANNEL.SLOPE_DZ] = fields.slopeZ[q];
      return t;
    },
    channel: (t, c) => t[c],
  };
  const sigma = Math.max(0, frame.ambientSigma ?? 0);
  const burial = frame.burial ?? NO_BURIAL;
  const f: SimFoamFrame<number> = {
    hullVelX: frame.hullVelX,
    hullVelZ: frame.hullVelZ,
    lift: frame.lift,
    depth: Math.max(LIFT_DEPTH_FLOOR, frame.depth),
    ambientSigma: sigma,
    ambientBreak: expectedBreakingCpu(0, sigma),
    rimLength: burial.rimLength,
    breakRate: p.simBreakRate,
    churnRate: p.simChurnRate,
    sternChurn: p.simSternChurn,
    slickPerFoam: p.simSlickPerFoam,
  };
  const gx = (x - fields.centerX) / texel + n / 2;
  const gy = (z - fields.centerZ) / texel + n / 2;
  let w = burial.a + burial.b * (x - burial.ox) + burial.c * (z - burial.oz);
  if (frame.vessels && frame.vessels.length > 0) {
    const b = blendVessels(NUM, x, z, frame.vessels);
    f.hullVelX = b.vx;
    f.hullVelZ = b.vz;
    f.lift = b.lift;
    f.depth = b.depth;
    f.airOnset = frame.airOnset ?? SHEET_ENTRAINMENT_ONSET;
    // W8 round 3 (impacts): no instant rim churn from vertical burial in vessel mode — `w` below
    w = 0;
  }
  const jet = frame.jets ? propWashFoamCpu(frame.jets, x, z, tierTexel, !!frame.vessels) : 0;
  const S = farSupersample(tierTexel, texel);
  // §T.195 vessel mode: the ribbon is not the solver's — it is laid wherever a prop is, inside the domain or not
  const fleet = !!frame.vessels;
  let sum = 0;
  for (let ky = 0; ky < S; ky++) {
    for (let kx = 0; kx < S; kx++) {
      const ox = (boxOffset(kx, S) * tierTexel) / texel;
      const oy = (boxOffset(ky, S) * tierTexel) / texel;
      sum += simFoamSample(ops, texel, gx + ox, gy + oy, w, fleet ? 0 : jet, f);
    }
  }
  const edge = Math.max(1, fields.sponge.width * n);
  let foam = (sum / (S * S)) * simEdgeWindow(NUM, n, edge, gx, gy);
  const nf = frame.near;
  if (nf && farSupersample(tierTexel, nf.texel) === 1) {
    const nearOps = { ...ops, load: cpuLoad(nf) };
    const ngx = (x - nf.centerX) / nf.texel + nf.n / 2;
    const ngy = (z - nf.centerZ) / nf.texel + nf.n / 2;
    const nedge = Math.max(1, nf.sponge.width * nf.n);
    const nearFoam = simFoamSample(nearOps, nf.texel, ngx, ngy, w, fleet ? 0 : jet, f) * simEdgeWindow(NUM, nf.n, nedge, ngx, ngy);
    const wn = simNearWeight(RESAMPLE_NUM, { n: nf.n, texel: nf.texel, edge: nedge }, WAKE_NEAR_BLEND_WIDTHS * nedge, x, z, nf.centerX, nf.centerZ);
    foam += (nearFoam - foam) * wn;
  }
  if (fleet) foam += p.simChurnRate * jet;
  // W8 the exhaust boils (vessel mode, like the ribbon: laid wherever a prop is)
  if (fleet && frame.jets) foam += exhaustBoilFoamCpu(frame.jets, x, z, tierTexel) + p.simChurnRate * strutFoamCpu(frame.jets, x, z, tierTexel);
  if (fleet && frame.sheets) foam += chineSheetFoamCpu(frame.sheets, x, z, tierTexel);
  return [foam, p.simSlickPerFoam * foam];
}

/** §T.199 the CPU ops' texel load over one fields set (0 outside) */
function cpuLoad(fields: SimFoamCpuFields): SimFoamOps<number, number[]>['load'] {
  const { n } = fields;
  const zero = { slope: [0, 0, 0, 0], head: [0, 0, 0, 0] };
  return (tex, i, j) => {
    if (i < 0 || j < 0 || i >= n || j >= n) return zero[tex];
    const q = j * n + i;
    if (tex === 'head') return [fields.head[q], 0, fields.headJet ? fields.headJet[q] : 0, 0];
    const t = [0, 0, 0, 0];
    t[WAKE_TEX_CHANNEL.SLOPE_DX] = fields.slopeX[q];
    t[WAKE_TEX_CHANNEL.SLOPE_DZ] = fields.slopeZ[q];
    return t;
  };
}

/** §T.199 `simNearWeight`'s operator table over numbers */
const RESAMPLE_NUM: SimResampleOps<number, never> = {
  lit: (v) => v,
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  min: Math.min,
  max: Math.max,
  floorIndex: Math.floor,
  next: (i) => i + 1,
  fract: (a) => a - Math.floor(a), // @band-limited-elsewhere: an operator table entry (CPU)
  smoothstep: NUM.smoothstep,
  load: () => undefined as never,
  channel: () => 0,
};

// ---------------------------------------------------------------------------
// THE GPU HALF
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL nodes are structurally untyped */
const NODE: SimFoamArith<any> = {
  k: (v) => float(v),
  add: (a, b) => a.add(b),
  sub: (a, b) => a.sub(b),
  mul: (a, b) => a.mul(b),
  div: (a, b) => a.div(b),
  max: (a, b) => a.max(b),
  min: (a, b) => a.min(b),
  neg: (a) => a.negate(),
  sqrt: (a) => a.max(0).sqrt(),
  exp: (a) => a.exp(),
  // @band-limited-elsewhere: VALUE-space gates (steepness, jet start over the disc, sponge window) evaluated in COMPUTE
  smoothstep: (e0, e1, x) => smoothstep(e0, e1, x),
};

export interface SimFoamFieldOptions {
  /** prop jets this flowfoam can carry (0 = none compiled, the raft; ≤ MAX_PROP_JETS, or ≤ MAX_FLEET_JETS with `vessels`) */
  propJets?: number;
  /**
   * §T.195 VESSEL MODE: vessel slots the churn blends over (0 = the single-hull graph, bit-identical to before;
   * ≤ WAKE_MAX_VESSELS). Construction-time: it sizes the shader. On: the churn is advected per vessel
   * (`blendVessels`), the jets are bounded (`jetInReach`) and laid outside the solver domain too (the far trail of a
   * rival the domain does not hold).
   */
  vessels?: number;
  /**
   * §T.199 the near-hull tier's centre uniform (`createSimWakeField().uNearCenter`), when `sim.near` exists: tiers whose
   * texel the near solver resolves (S = 1) sample it and cross-fade (`simNearWeight`). Absent: no near graph.
   */
  uNearCenter?: { value: THREE.Vector2 } | null;
}

/**
 * The GPU half: a node builder both flowfoam tiers call per texel, plus the
 * once-per-frame CPU state it reads. `setHull` records the hero's heading and
 * speed (the `setShip` feed), `setAmbientSea` the sea's band slope,
 * `setHullBurial` her contact, `setPropWash` her drives; `update` pushes them
 * after the sim step.
 */
export function createSimFoamField(
  sim: WakeSim,
  p: FlowFoamParams,
  /** the SURFACE resample's centre uniform (`createSimWakeField().uSimCenter`) — one centre, so paint and shape cannot drift apart */
  uCenter: { value: THREE.Vector2 },
  opts: SimFoamFieldOptions = {},
) {
  const { solver } = sim;
  const n = solver.n;
  const texel = solver.texel;
  const edge = Math.max(1, solver.sponge.width * n);
  const vesselSlots = Math.max(0, Math.min(WAKE_MAX_VESSELS, Math.floor(opts.vessels ?? 0)));
  const jetSlots = Math.max(0, Math.min(vesselSlots > 0 ? MAX_FLEET_JETS : MAX_PROP_JETS, Math.floor(opts.propJets ?? 0)));
  /** §T.195 per vessel: (x, z, radius, lift) and (vx, vz, depth, 0) — a dead slot sits far away with radius 1 */
  const vesselPos = Array.from({ length: Math.max(1, vesselSlots) }, () => new THREE.Vector4(1e7, 1e7, 1, 0));
  const vesselVel = Array.from({ length: Math.max(1, vesselSlots) }, () => new THREE.Vector4(0, 0, LIFT_DEPTH_FLOOR, 0));
  const uVesselPos = vesselSlots > 0 ? uniformArray(vesselPos) : null;
  const uVesselVel = vesselSlots > 0 ? uniformArray(vesselVel) : null;
  const uHullVel = uniform(new THREE.Vector2(0, 0));
  const uHullDirection = uniform(new THREE.Vector2(0, 1));
  const uLift = uniform(0);
  const uDepth = uniform(LIFT_DEPTH_FLOOR);
  const uAmbientSigma = uniform(0);
  const uAmbientBreak = uniform(0);
  /** burial plane (a, b, c, ℓ) and its origin */
  const uBurial = uniform(new THREE.Vector4(0, 0, 0, 0));
  const uBurialOrigin = uniform(new THREE.Vector2(0, 0));
  const uBreakRate = uniform(p.simBreakRate);
  const uChurnRate = uniform(p.simChurnRate);
  const uSternChurn = uniform(p.simSternChurn);
  const uSlickPerFoam = uniform(p.simSlickPerFoam);
  const jetPos = Array.from({ length: Math.max(1, jetSlots) }, () => new THREE.Vector4());
  const jetMeta = Array.from({ length: Math.max(1, jetSlots) }, () => new THREE.Vector4());
  const uJetPos = jetSlots > 0 ? uniformArray(jetPos) : null;
  const uJetMeta = jetSlots > 0 ? uniformArray(jetMeta) : null;
  /** W8 per jet: exhaust boil (along, σ, 0, 0) — `packPropJet().boil` */
  const jetBoil = Array.from({ length: Math.max(1, jetSlots) }, () => new THREE.Vector4());
  const uJetBoil = jetSlots > 0 && vesselSlots > 0 ? uniformArray(jetBoil) : null;
  /** W8 round 4: per jet slot, metres run since the prop last entered the water (x) — `jetRunWindow` */
  const jetRun = Array.from({ length: Math.max(1, jetSlots) }, () => new THREE.Vector4(1e4, 0, 0, 0));
  const uJetRun = jetSlots > 0 && vesselSlots > 0 ? uniformArray(jetRun) : null;
  const runs = new Float64Array(Math.max(1, jetSlots)).fill(1e4);
  let yaw = 0;
  let speed = 0;
  let ambientVariance = 0;
  let burial: HullBurialPlane = { ...NO_BURIAL };
  let jets: PropWashInput[] = [];

  const swizzle = ['x', 'y', 'z', 'w'] as const;
  const makeOps = (nn: number, textures: { slope: THREE.Texture; head: THREE.Texture }): SimFoamOps<any, any> => ({
    ...NODE,
    floorIndex: (a) => int(a.floor()),
    next: (i) => i.add(1),
    // @band-limited-elsewhere: bilinear tap weights in a COMPUTE pass (no pixel footprint)
    fract: (a) => a.fract(),
    load: (tex, xi, yi) => {
      const inside = xi.greaterThanEqual(int(0)).and(xi.lessThan(int(nn))).and(yi.greaterThanEqual(int(0))).and(yi.lessThan(int(nn)));
      return select(inside, textureLoad(textures[tex as 'slope' | 'head'], ivec2(xi.clamp(0, nn - 1), yi.clamp(0, nn - 1))), vec4(0, 0, 0, 0));
    },
    channel: (t, c) => t[swizzle[c]],
  });
  const ops = makeOps(n, { slope: solver.slopeTexture, head: solver.headTarget.texture });
  // §T.199 the near-hull tier (vessel mode only, when the sim carries one)
  const nearSolver = vesselSlots > 0 && sim.near && opts.uNearCenter ? sim.near : null;
  const uNearCenter = nearSolver ? opts.uNearCenter! : null;
  const nearOps = nearSolver ? makeOps(nearSolver.n, { slope: nearSolver.slopeTexture, head: nearSolver.headTarget.texture }) : null;
  const nearGrid: SimGrid | null = nearSolver ? { n: nearSolver.n, texel: nearSolver.texel, edge: Math.max(1, nearSolver.sponge.width * nearSolver.n) } : null;
  const RESAMPLE_NODE = { ...NODE, lit: NODE.k } as unknown as SimResampleOps<any, any>;
  const packetSlots = Math.max(1, vesselSlots * CHINE_EMISSION_SLOTS);
  const sheetA = Array.from({ length: packetSlots }, () => new THREE.Vector4());
  const sheetB = Array.from({ length: packetSlots }, () => new THREE.Vector4(0, 1, 1, 1));
  const sheetBounds = Array.from({ length: Math.max(1, vesselSlots) }, () => new THREE.Vector4());
  const uSheetA = vesselSlots > 0 ? uniformArray(sheetA) : null;
  const uSheetB = vesselSlots > 0 ? uniformArray(sheetB) : null;
  const uSheetBounds = vesselSlots > 0 ? uniformArray(sheetBounds) : null;
  const sheetCounts = Array.from({ length: Math.max(1, vesselSlots) }, () => new THREE.Vector4());
  const uSheetCounts = vesselSlots > 0 ? uniformArray(sheetCounts) : null;
  let sheets: readonly ChineSheetEmitter[] = [];
  const frame: SimFoamFrame<any> = {
    hullVelX: uHullVel.x,
    hullVelZ: uHullVel.y,
    lift: uLift,
    depth: uDepth,
    ambientSigma: uAmbientSigma,
    ambientBreak: uAmbientBreak,
    rimLength: uBurial.w,
    breakRate: uBreakRate,
    churnRate: uChurnRate,
    sternChurn: uSternChurn,
    slickPerFoam: uSlickPerFoam,
  };

  /**
   * vec2(foam rate, slick rate) at a world-XZ node for a tier of texel
   * `tierTexel` (m, construction constant). Must be called inside a compute Fn.
   */
  const rateNode = (worldXZ: any, tierTexel: number): any => {
    const S = farSupersample(tierTexel, texel);
    // texel centres at integers, row j = world z (WakeSolverCpu.gridU/gridV)
    const g = worldXZ.sub(uCenter).div(texel).add(n / 2).toVar();
    const reach = (0.5 * tierTexel) / texel + 1;
    const out = vec2(0, 0).toVar();
    const inside = g.x.greaterThan(-reach).and(g.x.lessThan(n - 1 + reach)).and(g.y.greaterThan(-reach)).and(g.y.lessThan(n - 1 + reach));
    If(inside, () => {
      const w = uBurial.x
        .add(uBurial.y.mul(worldXZ.x.sub(uBurialOrigin.x)))
        .add(uBurial.z.mul(worldXZ.y.sub(uBurialOrigin.y)))
        .toVar();
      let jetSum: any = float(0);
      for (let j = 0; j < jetSlots; j++) {
        const pos = uJetPos!.element(int(j));
        const meta = uJetMeta!.element(int(j));
        jetSum = jetSum.add(
          jetFoamRate(NODE, worldXZ.x.sub(pos.x), worldXZ.y.sub(pos.y), pos.z, pos.w, meta.z, meta.y.max(1e-3), float(tierTexel), meta.w.clamp(0, JET_SPREAD)),
        );
      }
      const jet = jetSum.toVar();
      const sum = float(0).toVar();
      if (S === 1) {
        sum.assign(simFoamSample(ops, texel, g.x, g.y, w, jet, frame));
      } else {
        const step = tierTexel / texel;
        Loop(S * S, ({ i }: { i: any }) => {
          const kx = float(int(i).mod(S));
          const ky = float(int(i).div(S));
          const ox = boxOffsetOf(NODE, kx, S).mul(step);
          const oy = boxOffsetOf(NODE, ky, S).mul(step);
          sum.addAssign(simFoamSample(ops, texel, g.x.add(ox), g.y.add(oy), w, jet, frame));
        });
      }
      const foam = sum.mul(1 / (S * S)).mul(simEdgeWindow(NODE, n, edge, g.x, g.y));
      out.assign(vec2(foam, foam.mul(uSlickPerFoam)));
    });
    return out;
  };

  /** §T.195 vessel mode (header of `vessels`): the per-vessel churn inside the domain + every bounded ribbon anywhere */
  const NODE_BOOL = { ...NODE, le: (a: any, b: any) => a.lessThanEqual(b), and: (a: any, b: any) => a.and(b) };
  const fleetRateNode = (worldXZ: any, tierTexel: number, carryOrientation = false): any => {
    const S = farSupersample(tierTexel, texel);
    const g = worldXZ.sub(uCenter).div(texel).add(n / 2).toVar();
    const reach = (0.5 * tierTexel) / texel + 1;
    const foamOut = float(0).toVar();
    const orientation = carryOrientation ? vec2(0, 0).toVar() : null;
    const inside = g.x.greaterThan(-reach).and(g.x.lessThan(n - 1 + reach)).and(g.y.greaterThan(-reach)).and(g.y.lessThan(n - 1 + reach));
    If(inside, () => {
      const slots: VesselChurnSlot<any>[] = [];
      for (let k = 0; k < vesselSlots; k++) {
        const vp = uVesselPos!.element(int(k));
        const vv = uVesselVel!.element(int(k));
        slots.push({ x: vp.x, z: vp.y, radius: vp.z, lift: vp.w, vx: vv.x, vz: vv.y, depth: vv.z });
      }
      const b = blendVessels(NODE, worldXZ.x, worldXZ.y, slots);
      const vx = b.vx.toVar();
      const vz = b.vz.toVar();
      const lift = b.lift.toVar();
      const depth = b.depth.toVar();
      // W8 round 3 (impacts): the vertical burial term laid the whole waterplane rim white on the landing tick. A planing
      // hull's impact water leaves as the chine sheet — retained emissions that fly and spread outward over their life
      // (`chineEmissionRate`) — so counting it again as instant rim churn was a double count with no time evolution.
      // Vessel mode drops it; the single-hull raft/galleon graph keeps §T.70.
      const w = float(0);
      void b.heroShare;
      const f: SimFoamFrame<any> = { ...frame, hullVelX: vx, hullVelZ: vz, lift, depth, airOnset: float(SHEET_ENTRAINMENT_ONSET) };
      const zero = float(0);
      const sum = float(0).toVar();
      if (S === 1) {
        sum.assign(simFoamSample(ops, texel, g.x, g.y, w, zero, f));
      } else {
        const step = tierTexel / texel;
        Loop(S * S, ({ i }: { i: any }) => {
          const kx = float(int(i).mod(S));
          const ky = float(int(i).div(S));
          const ox = boxOffsetOf(NODE, kx, S).mul(step);
          const oy = boxOffsetOf(NODE, ky, S).mul(step);
          sum.addAssign(simFoamSample(ops, texel, g.x.add(ox), g.y.add(oy), w, zero, f));
        });
      }
      const farFoam = sum.mul(1 / (S * S)).mul(simEdgeWindow(NODE, n, edge, g.x, g.y));
      if (nearSolver && nearOps && nearGrid && uNearCenter && farSupersample(tierTexel, nearSolver.texel) === 1) {
        const gn = worldXZ.sub(uNearCenter).div(nearSolver.texel).add(nearSolver.n / 2).toVar();
        const nearFoam = simFoamSample(nearOps, nearSolver.texel, gn.x, gn.y, w, zero, f).mul(simEdgeWindow(NODE, nearSolver.n, nearGrid.edge, gn.x, gn.y));
        const nc = uNearCenter as any;
        const wn = simNearWeight(RESAMPLE_NODE, nearGrid, WAKE_NEAR_BLEND_WIDTHS * nearGrid.edge, worldXZ.x, worldXZ.y, nc.x, nc.y);
        foamOut.assign(mix(farFoam, nearFoam, wn));
      } else {
        foamOut.assign(farFoam);
      }
      if (orientation) orientation.addAssign(vec2(...orientationMoment(NODE, vx, vz, foamOut)));
    });
    const jet = float(0).toVar();
    const boil = float(0).toVar();
    for (let j = 0; j < jetSlots; j++) {
      const pos = uJetPos!.element(int(j));
      const meta = uJetMeta!.element(int(j));
      const dx = worldXZ.x.sub(pos.x);
      const dz = worldXZ.y.sub(pos.y);
      const radius = meta.y.max(1e-3);
      If(jetInReach(NODE_BOOL, dx, dz, pos.z, pos.w, radius, float(tierTexel)), () => {
        // @band-limited-elsewhere: a window along the jet axis over 2 m (≥ 8 near texels), evaluated in COMPUTE
        const laid = jetRunWindow(NODE, dx, dz, pos.z, pos.w, uJetRun!.element(int(j)).x);
        const jetRate = jetFoamRate(NODE, dx, dz, pos.z, pos.w, meta.z, radius, float(tierTexel), meta.w.clamp(0, JET_SPREAD), true).mul(laid).toVar();
        jet.addAssign(jetRate);
        const b = uJetBoil!.element(int(j));
        // Surfacing exhaust cannot appear beyond water reached since this
        // prop entered. The steady plume centre alone would pop in remotely.
        const boilRate = exhaustBoilRate(NODE, dx, dz, pos.z, pos.w, meta.x, b.x, b.y, float(tierTexel)).mul(laid).toVar();
        const strutRate = strutFoamRate(NODE, dx, dz, pos.z, pos.w, b.z, b.w, float(tierTexel)).mul(laid).toVar();
        boil.addAssign(boilRate);
        jet.addAssign(strutRate);
        if (orientation) orientation.addAssign(vec2(...orientationMoment(NODE, pos.z, pos.w, jetRate.add(strutRate).mul(uChurnRate).add(boilRate))));
      });
    }
    // Reject whole vessel histories before scanning their bounded packet lists.
    const sheet = float(0).toVar();
    for (let k = 0; k < vesselSlots; k++) {
      const bounds = uSheetBounds!.element(int(k));
      const margin = 4 * Math.SQRT2 * tierTexel;
      const inside = bounds.z.greaterThan(bounds.x).and(worldXZ.x.greaterThan(bounds.x.sub(margin))).and(worldXZ.x.lessThan(bounds.z.add(margin)))
        .and(worldXZ.y.greaterThan(bounds.y.sub(margin))).and(worldXZ.y.lessThan(bounds.w.add(margin)));
      If(inside, () => {
        Loop({ start: int(0), end: int(uSheetCounts!.element(int(k)).x), condition: '<' }, ({ i }: { i: any }) => {
          const index = i.add(k * CHINE_EMISSION_SLOTS);
          const a = uSheetA!.element(index);
          const b = uSheetB!.element(index);
          const dx = worldXZ.x.sub(a.x);
          const dz = worldXZ.y.sub(a.y);
          const along = dx.mul(b.x).add(dz.mul(b.y));
          const across = dz.mul(b.x).sub(dx.mul(b.y));
          const longitudinal = b.z.add(tierTexel * tierTexel);
          const lateral = b.w.add(tierTexel * tierTexel);
          If(a.w.greaterThan(0).and(along.mul(along).lessThan(longitudinal.mul(16)))
            .and(across.abs().lessThan(a.z.add(lateral.sqrt().mul(4)))), () => {
            const sheetRate = chineEmissionRate(NODE, along, across, a.z, a.w, longitudinal, lateral).toVar();
            sheet.addAssign(sheetRate);
            if (orientation) orientation.addAssign(vec2(...orientationMoment(NODE, b.x, b.y, sheetRate)));
          });
        });
      });
    }
    const foam = foamOut.add(uChurnRate.mul(jet)).add(boil).add(sheet);
    return orientation ? vec4(foam, foam.mul(uSlickPerFoam), orientation) : vec2(foam, foam.mul(uSlickPerFoam));
  };

  const fin = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);

  return {
    rateNode: vesselSlots > 0 ? fleetRateNode : rateNode,
    /** Far tier only: the two spare channels carry source-weighted orientation. */
    orientedRateNode: vesselSlots > 0 ? (worldXZ: any, tierTexel: number) => fleetRateNode(worldXZ, tierTexel, true) : null,
    vesselSlots,
    /** subsamples per axis a tier of this texel gets (tests / docs) */
    supersample: (tierTexel: number) => farSupersample(tierTexel, texel),
    uniforms: { uHullVel, uHullDirection, uLift, uDepth, uAmbientSigma, uAmbientBreak, uBurial, uBurialOrigin, uJetPos, uJetMeta, uJetBoil, uVesselPos, uVesselVel, uSheetA, uSheetB },
    /** §T.199 whether this graph samples a near-hull tier */
    near: !!nearSolver,
    jetSlots,
    /** W8 the last good hull heading (rad) and speed over water (m/s) the churn is advected by */
    hull(): { yaw: number; speed: number } {
      return { yaw, speed };
    },
    /** the `setShip` feed — heading (rad, atan2(fx, fz)) and speed over water (m/s) */
    setHull(yawIn: number, speedIn: number): void {
      // §V28: a non-finite pose keeps the last good one
      if (Number.isFinite(yawIn) && Number.isFinite(speedIn)) {
        yaw = yawIn;
        speed = Math.max(0, speedIn);
      }
    },
    /** §T.180 a: the ambient sea's slope variance (both axes) in the sim's band — `bandSlopeVariance` */
    setAmbientSlopeVariance(variance: number): void {
      ambientVariance = Number.isFinite(variance) ? Math.max(0, variance) : 0;
    },
    /** §T.70 / §T.180 e: the hull contact right after its tick update */
    setHullBurial(contact: HullBurialInput | null): void {
      burial = contact ? fitBurialPlane(contact) : { ...NO_BURIAL };
      if (![burial.a, burial.b, burial.c, burial.ox, burial.oz, burial.rms, burial.rimLength].every(Number.isFinite)) {
        burial = { ...NO_BURIAL };
      }
    },
    /** §T.180 c: this tick's props (at most `jetSlots` are drawn) */
    setPropWash(inputs: readonly PropWashInput[]): void {
      jets = inputs.slice(0, jetSlots);
      // Per fixed tick: travel plus the jet's own finite aft transport. At
      // standstill, thrust must still grow a wash behind the prop.
      for (let j = 0; j < jetSlots; j++) {
        const q = jets[j];
        const wet = !!q && propWashValid(q) && q.immersion > 0;
        runs[j] = wet ? Math.min(1e4, advanceJetRun(runs[j], q.advance,
          jetExcessSpeed(q.advance, q.thrust, q.discArea), Math.sqrt(q.discArea / Math.PI), SIM_DT)) : 0;
      }
    },
    /** Retained per-vessel emissions (hero first); at most `vesselSlots` histories drawn. */
    setChineSheets(inputs: readonly ChineSheetEmitter[]): void {
      if (inputs.some(e => e.emissions.length > CHINE_EMISSION_SLOTS)) throw new RangeError('Too many retained chine emissions');
      sheets = inputs.slice(0, vesselSlots);
    },
    /** RENDER FRAME, after `wakeSim.step` (the caller writes the shared centre): this tick's hull */
    update(): void {
      uHullDirection.value.set(Math.sin(yaw), Math.cos(yaw));
      uHullVel.value.copy(uHullDirection.value).multiplyScalar(speed);
      const d = sim.sources.hullDepthMax();
      uDepth.value = Math.max(LIFT_DEPTH_FLOOR, fin(d, 0));
      uLift.value = liftFraction(Math.hypot(speed, burial.rms), uDepth.value);
      const sigma = Math.sqrt(ambientVariance / 2);
      uAmbientSigma.value = sigma;
      uAmbientBreak.value = expectedBreakingCpu(0, sigma);
      uBurial.value.set(burial.a, burial.b, burial.c, burial.rimLength);
      uBurialOrigin.value.set(burial.ox, burial.oz);
      for (let k = 0; k < vesselSlots; k++) {
        const live = k < sim.vesselCount;
        const v = sim.vessels[k];
        if (live && k === 0) {
          // the hero: the `setShip` feed (speed over water) and her burial rms, as the single-hull graph reads her
          vesselPos[0].set(fin(v.x, 1e7), fin(v.z, 1e7), Math.max(1, fin(v.radius, 1)), liftFraction(Math.hypot(speed, burial.rms), Math.max(LIFT_DEPTH_FLOOR, fin(v.depth, 0))));
          vesselVel[0].set(uHullVel.value.x, uHullVel.value.y, Math.max(LIFT_DEPTH_FLOOR, fin(v.depth, 0)), 0);
        } else if (live) {
          const d = Math.max(LIFT_DEPTH_FLOOR, fin(v.depth, 0));
          const vx = fin(v.vx, 0);
          const vz = fin(v.vz, 0);
          vesselPos[k].set(fin(v.x, 1e7), fin(v.z, 1e7), Math.max(1, fin(v.radius, 1)), liftFraction(Math.hypot(vx, vz), d));
          vesselVel[k].set(vx, vz, d, 0);
        } else {
          vesselPos[k].set(1e7, 1e7, 1, 0);
          vesselVel[k].set(0, 0, LIFT_DEPTH_FLOOR, 0);
        }
      }
      for (let j = 0; j < jetSlots; j++) {
        const packed = j < jets.length ? packPropJet(jets[j]) : null;
        if (packed) {
          jetPos[j].set(...packed.pos);
          jetMeta[j].set(...packed.meta);
          jetBoil[j].set(...packed.boil);
          jetRun[j].set(runs[j], 0, 0, 0);
        } else {
          jetPos[j].set(0, 0, 0, 1);
          jetMeta[j].set(0, 1, 0, 0);
          jetBoil[j].set(0, 1, 0, 0);
          jetRun[j].set(0, 0, 0, 0);
        }
      }
      for (let k = 0; k < vesselSlots; k++) {
        const e = sheets[k];
        let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
        const count = e ? e.emissions.length : 0;
        sheetCounts[k].x = count;
        for (let j = 0; j < count; j++) {
          const index = k * CHINE_EMISSION_SLOTS + j;
          const emission = e?.emissions[j];
          const q = emission ? packChineEmission(emission, e.time, CHINE_SHEET_THICKNESS, CHINE_SHEET_SLIDE) : null;
          if (q) {
            sheetA[index].set(...q.a);
            sheetB[index].set(...q.b);
            const radius = q.a[2] + 4 * Math.sqrt(q.b[2] + q.b[3]);
            minX = Math.min(minX, q.a[0] - radius); minZ = Math.min(minZ, q.a[1] - radius);
            maxX = Math.max(maxX, q.a[0] + radius); maxZ = Math.max(maxZ, q.a[1] + radius);
          } else {
            sheetA[index].set(0, 0, 0, 0);
            sheetB[index].set(0, 1, 1, 1);
          }
        }
        // A zero-area box explicitly marks an empty history.
        if (minX === Infinity) sheetBounds[k].set(0, 0, 0, 0);
        else sheetBounds[k].set(minX, minZ, maxX, maxZ);
      }
      uBreakRate.value = Math.max(0, fin(p.simBreakRate, 0));
      uChurnRate.value = Math.max(0, fin(p.simChurnRate, 0));
      uSternChurn.value = Math.max(0, fin(p.simSternChurn, 0));
      uSlickPerFoam.value = Math.max(0, fin(p.simSlickPerFoam, 0));
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * CPU twin of the GPU head gradient: ∇h_P of the bilinear interpolant of a
 * solver's `head` grid at a world point (0 outside). Used by tests and any CPU
 * reader so both halves differentiate the same interpolant.
 */
export function simHeadGradientCpu(
  head: ArrayLike<number>,
  n: number,
  texel: number,
  centerX: number,
  centerZ: number,
  x: number,
  z: number,
): [number, number] {
  const gu = (x - centerX) / texel + n / 2;
  const gv = (z - centerZ) / texel + n / 2;
  const i = Math.floor(gu);
  const j = Math.floor(gv);
  const fx = gu - i;
  const fy = gv - j;
  const at = (a: number, b: number): number => (a < 0 || b < 0 || a >= n || b >= n ? 0 : head[b * n + a]);
  const h00 = at(i, j);
  const h10 = at(i + 1, j);
  const h01 = at(i, j + 1);
  const h11 = at(i + 1, j + 1);
  return [((h10 - h00) * (1 - fy) + (h11 - h01) * fy) / texel, ((h01 - h00) * (1 - fx) + (h11 - h10) * fx) / texel];
}
