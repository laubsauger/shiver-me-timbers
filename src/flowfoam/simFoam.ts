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
 *   PROP WASH  Σ jets (`jetFoamRate`): an actuator-disc jet, excess speed
 *              V_j − U_a = √(U_a² + 2T/ρA) − U_a, as a turbulent ribbon aft of
 *              the prop (half-width r + 0.1·s, potential core 6 D) — injection
 *              lift(ΔV, d_prop)·ΔV_c(s)/b(s) across a Gaussian of that width,
 *              floored at the tier texel (the splat-σ law, so the cross-track
 *              integral is kept when it is band-limited).
 *   FOAM  (R)  breakRate·ΔB + churnRate·(churn + jet)
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
import { If, Loop, float, int, ivec2, select, smoothstep, textureLoad, uniform, uniformArray, vec2, vec4 } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { LIFT_DEPTH_FLOOR, liftFraction } from '../foam/sprayMath';
import { WAKE_TEX_CHANNEL } from '../wake/wakeSolverMath';
import { JET_CORE_DIAMETERS, JET_SPREAD, jetExcessSpeed, propWashValid, type PropWashInput } from '../wake/propWash';

export { JET_CORE_DIAMETERS, JET_SPREAD, jetExcessSpeed, type PropWashInput };
import type { WakeSim } from '../wake/wakeSim';
import type { FlowFoamParams } from '../params/flowfoam';

/** research §5.4: breaking onset slope */
export const BREAK_ONSET_SLOPE = 0.3;
/** Stokes limiting steepness ka ≈ 0.44 (H/λ ≈ 1/7) — full breaking */
export const STOKES_SLOPE = 0.44;
/** at most this many props per flowfoam (the speedboat carries 3) — a literal shader bound (§V28) */
export const MAX_PROP_JETS = 4;
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
  const bury = A.max(zero, rise);
  const emerge = A.max(zero, A.neg(rise));
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
export function jetFoamRate<T>(A: SimFoamArith<T>, dx: T, dz: T, dirX: T, dirZ: T, drive: T, radius: T, texel: T): T {
  const zero = A.k(0);
  const s = A.add(A.mul(dx, dirX), A.mul(dz, dirZ));
  const n = A.sub(A.mul(dz, dirX), A.mul(dx, dirZ));
  const ahead = A.max(s, zero);
  const b = A.add(radius, A.mul(A.k(JET_SPREAD), ahead));
  // the splat-σ law: convolve with one tier texel so the ribbon cannot alias, integral across kept
  const bEff = A.sqrt(A.add(A.mul(b, b), A.mul(texel, texel)));
  const core = A.mul(radius, A.k(2 * JET_CORE_DIAMETERS));
  const decay = A.div(core, A.max(ahead, core));
  // @band-limited-elsewhere: a ramp over the prop DISC (≥ one tier texel below via bEff) along the jet axis, evaluated in COMPUTE
  const start = A.smoothstep(A.neg(bEff), bEff, s);
  const across = A.exp(A.neg(A.div(A.mul(n, n), A.mul(A.k(2), A.mul(bEff, bEff)))));
  return A.mul(A.div(A.mul(A.mul(drive, decay), across), bEff), start);
}

/** packed per-jet uniform state: [x, z, dirX, dirZ] and [drive, radius, 0, 0] — zero drive is an idle slot */
export function packPropJet(j: PropWashInput): { pos: [number, number, number, number]; meta: [number, number, number, number] } | null {
  if (!propWashValid(j)) return null;
  const len = Math.hypot(j.dirX, j.dirZ);
  // the drive model already scaled thrust by the prop's immersion
  const excess = jetExcessSpeed(j.advance, j.thrust, j.discArea);
  const lift = liftFraction(excess, Math.max(0, j.depth));
  return {
    pos: [j.x, j.z, j.dirX / len, j.dirZ / len],
    meta: [lift * excess, Math.sqrt(j.discArea / Math.PI), 0, 0],
  };
}

/** CPU Σ jets at a world point (tests) */
export function propWashFoamCpu(jets: readonly PropWashInput[], x: number, z: number, texel: number): number {
  let sum = 0;
  for (const j of jets) {
    const packed = packPropJet(j);
    if (!packed) continue;
    const [px, pz, dx, dz] = packed.pos;
    sum += jetFoamRate(NUM, x - px, z - pz, dx, dz, packed.meta[0], packed.meta[1], texel);
  }
  return sum;
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
  const w = burial.a + burial.b * (x - burial.ox) + burial.c * (z - burial.oz);
  const jet = frame.jets ? propWashFoamCpu(frame.jets, x, z, tierTexel) : 0;
  const S = farSupersample(tierTexel, texel);
  let sum = 0;
  for (let ky = 0; ky < S; ky++) {
    for (let kx = 0; kx < S; kx++) {
      const ox = (boxOffset(kx, S) * tierTexel) / texel;
      const oy = (boxOffset(ky, S) * tierTexel) / texel;
      sum += simFoamSample(ops, texel, gx + ox, gy + oy, w, jet, f);
    }
  }
  const edge = Math.max(1, fields.sponge.width * n);
  const foam = (sum / (S * S)) * simEdgeWindow(NUM, n, edge, gx, gy);
  return [foam, p.simSlickPerFoam * foam];
}

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
  /** prop jets this flowfoam can carry (0 = none compiled, the raft; ≤ MAX_PROP_JETS) */
  propJets?: number;
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
  const jetSlots = Math.max(0, Math.min(MAX_PROP_JETS, Math.floor(opts.propJets ?? 0)));
  const uHullVel = uniform(new THREE.Vector2(0, 0));
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
  let yaw = 0;
  let speed = 0;
  let ambientVariance = 0;
  let burial: HullBurialPlane = { ...NO_BURIAL };
  let jets: PropWashInput[] = [];

  const textures = { slope: solver.slopeTexture, head: solver.headTarget.texture };
  const swizzle = ['x', 'y', 'z', 'w'] as const;
  const ops: SimFoamOps<any, any> = {
    ...NODE,
    floorIndex: (a) => int(a.floor()),
    next: (i) => i.add(1),
    // @band-limited-elsewhere: bilinear tap weights in a COMPUTE pass (no pixel footprint)
    fract: (a) => a.fract(),
    load: (tex, xi, yi) => {
      const inside = xi.greaterThanEqual(int(0)).and(xi.lessThan(int(n))).and(yi.greaterThanEqual(int(0))).and(yi.lessThan(int(n)));
      return select(inside, textureLoad(textures[tex as 'slope' | 'head'], ivec2(xi.clamp(0, n - 1), yi.clamp(0, n - 1))), vec4(0, 0, 0, 0));
    },
    channel: (t, c) => t[swizzle[c]],
  };
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
          jetFoamRate(NODE, worldXZ.x.sub(pos.x), worldXZ.y.sub(pos.y), pos.z, pos.w, meta.x, meta.y.max(1e-3), float(tierTexel)),
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

  const fin = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);

  return {
    rateNode,
    /** subsamples per axis a tier of this texel gets (tests / docs) */
    supersample: (tierTexel: number) => farSupersample(tierTexel, texel),
    uniforms: { uHullVel, uLift, uDepth, uAmbientSigma, uAmbientBreak, uBurial, uBurialOrigin, uJetPos, uJetMeta },
    jetSlots,
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
    },
    /** RENDER FRAME, after `wakeSim.step` (the caller writes the shared centre): this tick's hull */
    update(): void {
      uHullVel.value.set(Math.sin(yaw) * speed, Math.cos(yaw) * speed);
      const d = sim.sources.hullDepthMax();
      uDepth.value = Math.max(LIFT_DEPTH_FLOOR, fin(d, 0));
      uLift.value = liftFraction(Math.hypot(speed, burial.rms), uDepth.value);
      const sigma = Math.sqrt(ambientVariance / 2);
      uAmbientSigma.value = sigma;
      uAmbientBreak.value = expectedBreakingCpu(0, sigma);
      uBurial.value.set(burial.a, burial.b, burial.c, burial.rimLength);
      uBurialOrigin.value.set(burial.ox, burial.oz);
      for (let j = 0; j < jetSlots; j++) {
        const packed = j < jets.length ? packPropJet(jets[j]) : null;
        if (packed) {
          jetPos[j].set(...packed.pos);
          jetMeta[j].set(...packed.meta);
        } else {
          jetPos[j].set(0, 0, 0, 1);
          jetMeta[j].set(0, 1, 0, 0);
        }
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
