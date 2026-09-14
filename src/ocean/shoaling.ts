/**
 * WAVE SHOALING (§V.8, §V.19, §V.72 as amended by §T.190) — the sea feels its
 * own shallows: waves GROW as the water shoals, BREAK when the column can no
 * longer hold them, and decay through the surf zone to nothing at the
 * waterline. Open water is untouched, bit for bit.
 *
 * HISTORY, so the next reader does not "fix" it back: until §T.190 this file
 * attenuated only (tanh(k·d) per band) — a deliberate artistic calming. The
 * Tower Reach circuit needs its sandbars to be the lap's biggest water, and the
 * attenuation made them the calmest (23–29% of the swell kept over the crest),
 * so the user replaced it with linear theory end to end (2026-09-13).
 *
 * THE ONE DESIGN DECISION, unchanged: everything keys off DEPTH, never off
 * distance to land. A shelving beach has a wide shallow band, so it gets a
 * shoaling zone, a surf line and a surf zone; a cliff into 40 m has no shallow
 * band at all, so the sea stays open-ocean rough to the rock. There is no cliff
 * case and there must not be one.
 *
 * THREE TERMS, applied in this order, per cascade (§V.19 band-splits them, so
 * each has its own wavelength and long swell feels the bottom first):
 *
 *  A. SHOALING GROWTH — `shoalingCoefficient`, Ks = √(cg_deep / cg(d)): linear
 *     energy-flux conservation for a wave train walking into shallower water
 *     with no reflection or loss (Dean & Dalrymple, "Water Wave Mechanics for
 *     Engineers and Scientists", 1991, §4.10; Holthuijsen, "Waves in Oceanic
 *     and Coastal Waters", 2007, §7.2). With ω² = g·k·tanh(k·d) and
 *     n = ½(1 + 2kd/sinh 2kd), cg/cg_deep = 2n·tanh(kd), which the identity
 *     sinh 2x = 2·tanh x/(1 − tanh²x) turns into
 *         cg/cg_deep = T + kd·(1 − T²),   T = tanh(kd)
 *     — no sinh, no division by T, exact in both limits (→ 1 deep, → 2kd
 *     shallow, i.e. Green's law d^(−1/4) once kd ∝ √d). Ks dips to 0.91 near
 *     kd ≈ 1.2 and then grows without bound; term B is what stops it.
 *     The local kd comes from the deep-water band wavenumber by Fenton &
 *     McKee's explicit dispersion solution (Coastal Engineering 14, 1990):
 *         kd ≈ k₀d · coth((k₀d)^¾)^⅔,   within 1.7% of the exact root, ∀ depth.
 *
 *  B. DEPTH-LIMITED BREAKING — `surfBreakingFactor`, ONE factor for all bands
 *     from the local SIGNIFICANT height Hs = 4·√(Σ(σᵢ·gᵢ)²), soft-capped at
 *     γ·d. One factor, not one per band, so the spectral shape (each cascade's
 *     share of the energy) survives breaking: the surf zone is the same sea,
 *     smaller. γ = `shoalSurfGamma` = 0.6 applies to Hs: Thornton & Guza
 *     (JGR 88, 1983) measured the saturated inner surf zone at Hrms/h = 0.42,
 *     i.e. Hs/h = 0.42·√2 = 0.59; for a Rayleigh sea H₁/₁₀ = 1.27·Hs, which
 *     puts the highest tenth of the waves at 0.76·h — McCowan's (1894) 0.78
 *     individual-wave limit. Exact identity below `shoalSurfOnset`·γ·d, C1
 *     through the knee, saturating to γ·d: past the break Hs = γ·d, i.e. the
 *     saturated surf zone decays linearly to ZERO at the waterline.
 *
 *  C. COLUMN GUARD — `breakerClip`, a soft clip on the SUMMED elevation at
 *     `shoalBreakerIndex`·d saturating to `shoalColumnCeiling`·d. Unchanged
 *     from before §T.190. With B holding Hs ≤ 0.6·d a sample reaches its knee
 *     only past 5.2σ, so it is a geometric guarantee ((1 − ceiling)·d of water
 *     always remains) rather than a look.
 *
 * DEEP WATER IS EXACTLY THE IDENTITY, and that is by construction: kd is
 * clamped at π — d = λ/2, the textbook deep-water criterion — and Ks is
 * normalised by its own value there, so every band with d ≥ λ/2 gets
 * √(F(π)/F(π)) = 1 exactly, B is x/x = 1 exactly, and the product is the
 * unshoaled sea bit for bit. The price is linear theory's last 1% (true
 * Ks(π) = 0.990) folded into the shallows, and a slope change of 0.015 per
 * unit kd at the clamp — two orders below anything that draws a ring.
 *
 * NOT MODELLED, said so it does not read as an omission:
 *  · WAVELENGTH SHORTENING. The cascades are global FFT tiles with the
 *    deep-water ω(k) (oceanMath.dispersion); a wave's phase is shared by the
 *    whole tile, so shortening λ near shore would need a per-position phase
 *    integrated along the ray (∫k(x)dx). A local coordinate warp tears the
 *    tile. Kd above is used for the AMPLITUDE law only.
 *  · CREST ASYMMETRY. §T.193 adds it as a vertical second harmonic in
 *    src/ocean/shoalAsymmetry.ts, from the gains this file computes.
 *
 * THE ONE COMPRESSION, unchanged: `shoalWavenumberFloor`. The world floor is
 * 45 m where a 143 m storm swell wants 71 m to be deep, so each band's k is
 * floored at π/(shoalDeepFraction·openDepth). At 45 m every band at every
 * preset has kd ≥ π, so the open ocean is the identity (see above).
 *
 * §V.8 / §V.77 — ONE LAW. The GPU displacement, the CPU mirror the hulls float
 * on, the caustics/terrain receiver and the shore foam all call the CPU
 * functions here or their TSL twins beside them. `shoalBandGains` and
 * `shoalBandGainNodes` are the ONLY way to get a band's gain; there is no
 * per-band factor exported on its own any more, because B couples the bands
 * and a consumer that applied A alone would be a second sea. See §V.72 for the
 * two traps that make "same formula" insufficient: WHERE the depth is sampled
 * (the grid coord), and WHAT it is measured against (still water).
 *
 * §V.23: no 3-arg chained math. §V.28: every divisor floored; d → 0 and dry
 * land (d = 0) give a gain of exactly 0, never NaN.
 */
import { float } from 'three/tsl';

/** any TSL node — this math is structural, not typed (file-local convention) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNode = any;

/** floor for every divisor here (§V.28) */
const EPS = 1e-6;

/**
 * tanh, WRITTEN OUT, because three r180's TSL has no `tanh` — `MathNode` ships
 * `tan` and stops there (verified in node_modules; the full op list is SIN,
 * COS, TAN, ASIN, ACOS, ATAN). The identity is
 *   tanh(x) = 1 − 2/(e^{2x} + 1)
 * which is the numerically friendly form for the x ≥ 0 branch this file uses:
 * e^{2x} overflows to +inf rather than to NaN, 2/inf is 0, and the result
 * saturates cleanly at 1 instead of going undefined. Both sides use this
 * expression rather than `Math.tanh` so the CPU mirror and the shader agree
 * on the same rounding, not merely on the same limit.
 */
export function tanhCpu(x: number): number {
  return 1 - 2 / (Math.exp(2 * x) + 1);
}

/** TSL twin of `tanhCpu` — see it for why this is not a library call */
export function tanhNode(x: AnyNode): AnyNode {
  return float(1).sub(float(2).div(x.mul(2).exp().add(1)));
}

/** the three dimensionless constants this file is parameterised by (§V.16) */
export interface ShoalingParams {
  /** fraction of the seabed's open depth by which every band is open-ocean */
  shoalDeepFraction: number;
  /** fraction of the local column a wave may occupy before breaking bites */
  shoalBreakerIndex: number;
  /** fraction of the local column a wave may NEVER exceed */
  shoalColumnCeiling: number;
  /** γ: the saturated surf zone's Hs / d (term B) */
  shoalSurfGamma: number;
  /** fraction of γ·d at which breaking starts to dissipate (term B's knee) */
  shoalSurfOnset: number;
}

/**
 * THE COMPRESSION, and the only art decision in this file.
 *
 * A band with wavenumber k is back to full open-ocean amplitude once
 * tanh(k·d) ≈ 1, i.e. once k·d ≥ π (tanh(π) = 0.9963). We require that to
 * happen at or before `shoalDeepFraction` of the world's own open-ocean depth,
 * which floors k at π/(fraction·openDepth). Bands shorter than that are
 * untouched and keep their true physical gate; only the long swell — whose
 * real gate is deeper than our sea floor — is pulled in.
 *
 * At the shipped 45 m open depth and 0.6, the floor is λ = 54 m. Ordering
 * after the floor, on the swell preset: cascade 0 at 54 m, cascade 1 at 22 m,
 * cascade 2 at 4 m — so the per-cascade behaviour §V.19 makes possible
 * survives the compression, which is the point of doing it this way rather
 * than by fading the whole sea.
 *
 * `openDepth` is DATA from the seabed field (`SeabedField.openHeight`), not an
 * import: the ocean does not depend on params/island.
 */
export function shoalWavenumberFloor(openDepth: number, p: ShoalingParams): number {
  return Math.PI / Math.max(p.shoalDeepFraction * openDepth, EPS);
}

/**
 * The band's shoaling wavenumber: its energy-weighted mean k (measured from
 * the live spectrum by `spectralMeanWavenumber`, so weather presets move it
 * for free), floored as above. One place, so the GPU uniform and the mirror's
 * per-cascade factor cannot be derived differently.
 */
export function shoalWavenumber(
  meanK: number,
  openDepth: number,
  p: ShoalingParams,
): number {
  return Math.max(meanK, shoalWavenumberFloor(openDepth, p));
}

/** d = λ/2: past this every band is deep water and the law is the identity */
export const SHOAL_DEEP_KD = Math.PI;

/**
 * The band's LOCAL kd at `depth`, from its deep-water wavenumber — Fenton &
 * McKee (1990)'s explicit solution of ω² = g·k·tanh(k·d):
 *   kd ≈ x·coth(x^¾)^⅔,   x = k₀·d.
 * Exact in both limits (x deep, √x shallow), ≤ 1.7% between. The pow base is
 * floored so d = 0 lands on kd = 1e-3 rather than 0·∞ (§V.28).
 */
export function shallowWaterKd(shoalK: number, depth: number): number {
  const x = Math.max(shoalK * Math.max(depth, 0), EPS);
  return x * Math.pow(Math.max(tanhCpu(Math.pow(x, 0.75)), EPS), -2 / 3);
}

/** TSL twin of `shallowWaterKd` */
export function shallowWaterKdNode(shoalK: AnyNode, depth: AnyNode): AnyNode {
  const x = float(shoalK).mul(depth.max(0)).max(EPS);
  return x.mul(tanhNode(x.pow(0.75)).max(EPS).pow(-2 / 3));
}

/**
 * cg / cg_deep at a local kd: 2n·tanh(kd) = T + kd·(1 − T²), T = tanh(kd).
 * See the header for the identity; it is the energy-flux speed ratio term A
 * conserves against.
 */
export function groupVelocityRatio(kd: number): number {
  const t = tanhCpu(kd);
  return t + kd * (1 - t * t);
}

/** TSL twin of `groupVelocityRatio` */
function groupVelocityRatioNode(kd: AnyNode): AnyNode {
  const t = tanhNode(kd);
  return t.add(kd.mul(float(1).sub(t.mul(t))));
}

/** cg/cg_deep at the clamp — the normaliser that makes deep water exactly 1 */
const FLUX_AT_DEEP = groupVelocityRatio(SHOAL_DEEP_KD);

/**
 * TERM A: the shoaling coefficient Ks for one band at `depth`.
 * Exactly 1 for d ≥ λ/2; dips to 0.92 around kd ≈ 1.2; grows without bound as
 * d → 0 (finite: 22.6 at d = 0), which is term B's job to stop.
 */
export function shoalingCoefficient(shoalK: number, depth: number): number {
  const kd = Math.min(shallowWaterKd(shoalK, depth), SHOAL_DEEP_KD);
  return Math.sqrt(FLUX_AT_DEEP / Math.max(groupVelocityRatio(kd), EPS));
}

/** TSL twin of `shoalingCoefficient`. `shoalK` is a uniform, `depth` a node. */
export function shoalingCoefficientNode(shoalK: AnyNode, depth: AnyNode): AnyNode {
  const kd = shallowWaterKdNode(shoalK, depth).min(SHOAL_DEEP_KD);
  return float(FLUX_AT_DEEP).div(groupVelocityRatioNode(kd).max(EPS)).sqrt();
}

/**
 * TERM B: the factor every band is multiplied by so the local significant
 * height `hs` (m) respects depth-limited breaking at `depth`.
 *
 * limited = min(hs, knee) + head·tanh(max(hs − knee, 0)/head), with
 * ceiling = γ·d, knee = onset·ceiling, head = ceiling − knee; factor =
 * limited/hs. Below the knee tanh(0) is exactly 0, so the factor is hs/hs = 1
 * EXACTLY — not a small tax on every sea. C1 through the knee in both hs and
 * d (the same construction as `breakerClip`). Past it, limited → γ·d: the
 * saturated surf zone, H ∝ d. On dry land d = 0 ⟹ ceiling = head = 0 ⟹
 * the factor is exactly 0 (the head is floored only as a DIVISOR).
 */
export function surfBreakingFactor(hs: number, depth: number, p: ShoalingParams): number {
  const ceiling = p.shoalSurfGamma * Math.max(depth, 0);
  const knee = p.shoalSurfOnset * ceiling;
  const head = ceiling - knee;
  const excess = Math.max(hs - knee, 0) / Math.max(head, EPS);
  const limited = Math.min(hs, knee) + head * tanhCpu(excess);
  return limited / Math.max(hs, EPS);
}

/** TSL twin of `surfBreakingFactor`; `uSurf` = (γ, onset) */
export function surfBreakingFactorNode(hs: AnyNode, depth: AnyNode, uSurf: AnyNode): AnyNode {
  const ceiling = float(uSurf.x).mul(depth.max(0));
  const knee = float(uSurf.y).mul(ceiling);
  const head = ceiling.sub(knee);
  const excess = hs.sub(knee).max(0).div(head.max(EPS));
  const limited = hs.min(knee).add(head.mul(tanhNode(excess)));
  return limited.div(hs.max(EPS));
}

/**
 * THE PER-BAND GAIN — A × external × B, the only way to get one (§V.77).
 *
 * `shoalK[i]` is the band's floored deep-water wavenumber (`shoalWavenumber`),
 * `sigma[i]` its spectral height RMS (m, √heightVariance), `external[i]` the
 * gain the band already carries from fetch × swell shadow (1 when none).
 * COMPOSITION, and why nothing is counted twice: fetch and shadow decide how
 * much wave ARRIVES (they are about upwind water, not depth), shoaling grows
 * what arrived, and breaking caps the grown result — so B is measured on
 * σᵢ·Ksᵢ·externalᵢ and multiplies the same product. ALL bands go in, including
 * any a consumer does not draw (the CPU mirror draws two of three): breaking
 * is a property of the whole sea at that point.
 *
 * Writes into `out` (hot path, no allocation) and returns it. Deep water:
 * out[i] = (1·external[i])·1 = external[i], bit for bit.
 */
export function shoalBandGains(
  depth: number,
  shoalK: ArrayLike<number>,
  sigma: ArrayLike<number>,
  external: ArrayLike<number> | null,
  p: ShoalingParams,
  out: number[],
): number[] {
  const n = shoalK.length;
  let m0 = 0;
  for (let i = 0; i < n; i++) {
    const g = shoalingCoefficient(shoalK[i], depth) * (external ? external[i] : 1);
    out[i] = g;
    const a = sigma[i] * g;
    m0 += a * a;
  }
  const b = surfBreakingFactor(4 * Math.sqrt(m0), depth, p);
  for (let i = 0; i < n; i++) out[i] *= b;
  return out;
}

/**
 * How hard the water is breaking here, 0..1: the fraction of the ARRIVING wave
 * energy (E ∝ H², so 1 − B²) that depth-limited breaking has dissipated. 0 at
 * and outside the break line's onset, → 1 deep in a saturated surf zone. It is
 * the breaking foam's injection key (src/foam/shoreFoam.ts), taken from the
 * same B the gains carry, so foam can only appear where the drawn sea IS
 * breaking. On dry land B = 0 ⟹ 1: every consumer must gate on a wet column.
 */
export function surfBreakingIntensity(breakingFactor: number): number {
  return 1 - breakingFactor * breakingFactor;
}

/**
 * TSL twin of `shoalBandGains` + `surfBreakingIntensity`: the gains and the
 * breaking intensity share one B, so they cannot be derived apart.
 * `external[i]` null ⟹ 1 (folds away).
 */
export function shoalSurfNodes(
  depth: AnyNode,
  uShoalK: readonly AnyNode[],
  uSigma: readonly AnyNode[],
  external: readonly (AnyNode | null)[] | null,
  uSurf: AnyNode,
): { gains: AnyNode[]; breaking: AnyNode } {
  const pre = uShoalK.map((k, i) => {
    const ks = shoalingCoefficientNode(k, depth);
    const e = external ? external[i] : null;
    return e ? ks.mul(e) : ks;
  });
  let m0: AnyNode = null;
  for (let i = 0; i < pre.length; i++) {
    const a = float(uSigma[i]).mul(pre[i]);
    m0 = m0 === null ? a.mul(a) : m0.add(a.mul(a));
  }
  const b = surfBreakingFactorNode(m0.sqrt().mul(4), depth, uSurf);
  return { gains: pre.map((g) => g.mul(b)), breaking: float(1).sub(b.mul(b)) };
}

/** the gains alone — see `shoalSurfNodes` */
export function shoalBandGainNodes(
  depth: AnyNode,
  uShoalK: readonly AnyNode[],
  uSigma: readonly AnyNode[],
  external: readonly (AnyNode | null)[] | null,
  uSurf: AnyNode,
): AnyNode[] {
  return shoalSurfNodes(depth, uShoalK, uSigma, external, uSurf).gains;
}

/**
 * TERM C (the column guard; "term B" before §T.190), expressed once as the SATURATION 0..1 that both the clipped value
 * and its slope are built from.
 *
 * With a = |elevation|, knee = breakerIndex·d and head = (ceiling − index)·d:
 *   saturation = tanh(max(a − knee, 0) / head)
 * It is EXACTLY 0 below the knee — which is what makes term B a true no-op on
 * calm and swell rather than a small everywhere-tax — and → 1 as the wave runs
 * out of water column.
 *
 * It is also the honest measure of HOW HARD THE WATER IS BREAKING HERE, which
 * is what a shore-whitewater consumer should key on if one is ever built (see
 * the note in surfaceMaterial's foam block about why that consumer does not
 * live in the ocean material).
 */
export function breakerSaturation(
  elevation: number,
  depth: number,
  p: ShoalingParams,
): number {
  const d = Math.max(depth, 0);
  const knee = p.shoalBreakerIndex * d;
  // the HEAD ROOM between the knee and the ceiling, written as a difference of
  // the two levels rather than as (ceiling − index)·d so that knee + head is
  // the ceiling itself instead of one ULP away from it — the clip's asymptote
  // IS the guarantee, and it should not need a tolerance to be recognised
  const head = Math.max(p.shoalColumnCeiling * d - knee, EPS);
  return tanhCpu(Math.max(Math.abs(elevation) - knee, 0) / head);
}

/**
 * TERM C applied: the surface elevation a wave is allowed to reach over
 * `depth` metres of water.
 *
 * Written as `min(|y|, knee) + head·saturation` rather than as a branch,
 * because that single expression IS both cases: below the knee the saturation
 * is 0 and the min is |y|, so it returns y exactly; above it the min pins to
 * the knee and the tanh tail carries the rest. C1 at the join — the tail's
 * slope at 0 is sech²(0) = 1, matching the identity branch — so no crease
 * appears along a depth contour.
 */
export function breakerClip(elevation: number, depth: number, p: ShoalingParams): number {
  const d = Math.max(depth, 0);
  const knee = p.shoalBreakerIndex * d;
  // the HEAD ROOM between the knee and the ceiling, written as a difference of
  // the two levels rather than as (ceiling − index)·d so that knee + head is
  // the ceiling itself instead of one ULP away from it — the clip's asymptote
  // IS the guarantee, and it should not need a tolerance to be recognised
  const head = Math.max(p.shoalColumnCeiling * d - knee, EPS);
  const a = Math.abs(elevation);
  const s = tanhCpu(Math.max(a - knee, 0) / head);
  return Math.sign(elevation) * (Math.min(a, knee) + head * s);
}

/**
 * d(clipped)/d(elevation) — the factor the SHADING NORMAL has to carry, or the
 * geometry and the shading disagree on exactly the flat trough bottoms term B
 * creates (a clipped surface shaded with unclipped slopes is a flat sheet
 * wearing the reflections of a wave).
 *
 * It is free: 1 − saturation², i.e. sech² of the same argument, so the caller
 * that already has the saturation pays one multiply for it.
 */
export function breakerClipSlope(saturation: number): number {
  return 1 - saturation * saturation;
}

/**
 * TSL twin of `breakerClip` + `breakerClipSlope`. Returns both, because the
 * two share the saturation and the fragment stage needs the slope while the
 * vertex stage needs the value — computing them separately would double the
 * exp() and let them drift apart.
 */
export function breakerClipNodes(
  elevation: AnyNode,
  depth: AnyNode,
  uBreaker: AnyNode,
  uCeiling: AnyNode,
): { clipped: AnyNode; slope: AnyNode } {
  const d = depth.max(0);
  const knee = float(uBreaker).mul(d);
  // same difference-of-levels form as `breakerClip` — see the note there
  const head = float(uCeiling).mul(d).sub(knee).max(EPS);
  const a = elevation.abs();
  const s = tanhNode(a.sub(knee).max(0).div(head));
  return {
    clipped: elevation.sign().mul(a.min(knee).add(head.mul(s))),
    slope: float(1).sub(s.mul(s)),
  };
}
