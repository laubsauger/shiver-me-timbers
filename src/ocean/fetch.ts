/**
 * FETCH-LIMITED WAVE GROWTH (§V.8, §V.19, §V.72's pattern) — water with land
 * upwind of it cannot grow the sea the wind is asking for.
 *
 * THE ASK (user): "Maybe we should have a fetch and lee model then." The
 * complaint behind it has been consistent all session: a lagoon inside an
 * island rim reads as open ocean, and things that should agree do not. There
 * was no shelter model at ALL before this file — the wind field is uniform and
 * the wave field is global, so a 120 m anchorage got the same spectrum as the
 * middle of the Atlantic.
 *
 * WHAT THIS IS NOT. It is not shoaling. `shoaling.ts` keys on DEPTH and asks
 * "can this wave still stand up in this much water"; this file keys on the
 * UPWIND DISTANCE TO LAND and asks "was the wind ever given room to build this
 * wave". They are disjoint physics and they compose as a product: the boot
 * berth sits in 10.5 m of water where shoaling measures 0.841/0.995/1.000 —
 * i.e. shoaling correctly says "nothing to damp here" — and it is STILL inside
 * a rim, which is what this file is for.
 *
 * WHAT THIS IS NOT, PART TWO — LEE. Lee is the wind SHADOW: reduced wind speed
 * behind terrain, recovering downwind. It is a modification of the wind field
 * with knock-on effects on sails, flags and wind lines. It is NOT implemented
 * here; only fetch is. See the report and §Rule 8 — the shelter field this
 * file consumes (`fetchField.ts`) is exactly the query a lee model needs, so
 * the expensive half is already built, but nothing reads it as wind yet.
 *
 * ── THE MODEL, AND WHY IT IS A SPECTRAL RATIO RATHER THAN A FALLOFF ──────────
 *
 * The temptation is to multiply the sea down by some curve in fetch. That is
 * wrong in a way that is immediately visible and is the reason §Rule 6's test
 * has two clauses: short fetch does not give you a SMALL OCEAN, it gives you
 * SHORT STEEP CHOP. Sheltered water at 25 kt is busy and unpleasant and
 * objectively tiny; it is not a scale model of the swell outside. An amplitude
 * scale gets the height right and the character exactly backwards.
 *
 * So the factor is derived, not authored. Take the JONSWAP fetch-limited
 * spectrum (Hasselmann et al. 1973) at fetch F and the SAME spectrum at full
 * development, both at the same wind, and divide:
 *
 *      S(ω) = α g² ω⁻⁵ exp(−1.25 (ω_p/ω)⁴)          (peak enhancement γ omitted
 *                                                     — see the note below)
 *      α    = 0.076 F̃^(−0.22)          ω̃_p = 22 F̃^(−0.33)      F̃ = gF/U²
 *
 *      S_F(ω)/S_full(ω) = r^(−0.22) · exp(−1.25 [(ω_pF/ω)⁴ − (ω_pfull/ω)⁴])
 *
 * with r = F̃/F̃_full the DEVELOPMENT RATIO, 0..1. In deep water ω² = gk, so
 * (ω_p/ω)⁴ = (k_p/k)² and the whole thing collapses onto WAVENUMBER, which is
 * the coordinate §V.19's cascades are already band-split in. A band's
 * amplitude is √(its spectral density), so the per-cascade factor is
 *
 *      gain(k) = r^(−0.11) · exp( −0.625 · (k_pfull/k)² · (r^(−1.32) − 1) )
 *                └ steepening ┘   └── the low-frequency cutoff ──────────┘
 *
 * and BOTH of the behaviours the feature exists for fall out of it:
 *
 *  · HEIGHT. The exponential crushes every band whose k is below the
 *    fetch-limited peak, which is where nearly all the variance lives. Hs
 *    drops because the swell is deleted, not because a slider dimmed it.
 *  · PERIOD, i.e. THE PART THAT MAKES IT LOOK RIGHT. Deleting the long bands
 *    while leaving the short ones IS a shift of the peak to shorter waves. The
 *    peak wavelength moves on its own; nothing computes it and nothing sets it.
 *  · STEEPNESS. `r^(−0.11)` is √(α ratio) and it is GREATER THAN 1: a young
 *    sea has a fatter equilibrium tail than a fully developed one at the same
 *    wind. This is the one term that ADDS energy, and it is why enclosed water
 *    can look choppy and mean while being half a metre high. It is clamped —
 *    see `fetchMaxGain`.
 *
 * Exactly 1 at full development (r = 1: the exponential's argument is zero and
 * the steepening term is 1⁰), so open water is bit-identically the sea it
 * always was, in the same way `shoalWavenumberFloor` guarantees for shoaling.
 *
 * WHAT IS DELIBERATELY NOT MODELLED, so it does not read as an error:
 *  · the JONSWAP peak enhancement γ. It is a narrow multiplicative bump AT the
 *    peak, and both spectra in the ratio carry one; keeping it would sharpen
 *    the young sea's peak slightly and costs another exp() per band per vertex
 *    for something no cascade is narrow enough to resolve (§V.19 splits at 40 m
 *    and 8.3 m; γ's width is a few percent of ω_p).
 *  · SWELL BLOCKING, which this gets right for the wrong reason and it should
 *    be said out loud. `oceanParams.swellPeriod/swellAmplitude` inject a
 *    remotely generated swell train, and remote swell is NOT fetch-limited —
 *    it arrives fully formed. But it rides in cascade 0's spectrum, so the
 *    cascade-0 gain deletes it inside a rim. That is the correct PICTURE (a
 *    lagoon behind land has no swell) reached by the wrong MECHANISM: the real
 *    physics is blocking and diffraction, whose shadow geometry happens to be
 *    the same shadow this field already measures. One field serves both; do
 *    not let that coincidence be mistaken for a derivation.
 *
 * ── THE SECOND COMPRESSION: `fetchLongBandLimit`, and why it is not optional ─
 *
 * The exponent above contains (k_pfull/k)², which is (λ_band/λ_peak)². For a
 * band FAR longer than the fully developed peak that number is enormous, and
 * an enormous coefficient turns a smooth exponential into a STEP.
 *
 * MEASURED on the calm preset (4 m/s, peak λ 16 m), where cascade 0's own mean
 * wavelength is 249 m: the raw coefficient is 256, and the gain falls 1.000 →
 * 0.000 between 138 m and 124 m of fetch. Fourteen metres of world space. That
 * is a painted ring on the water, the exact defect §V.72's soft knee exists to
 * avoid one file over.
 *
 * The cause is NOT a bug in the fit — a 249 m wave genuinely has no wind-sea
 * energy at 4 m/s. The cause is that cascade 0's energy there is not wind sea
 * at all: it is the AUTHORED SWELL TRAIN (`swellPeriod`/`swellAmplitude`), and
 * §V.36 has deliberately decoupled `amplitude` from `windSpeed`, so the sea can
 * legitimately carry waves the wind fit says should not exist. The fetch law
 * describes wind sea; applied to that band it is extrapolating far outside
 * where JONSWAP was fitted.
 *
 * So the coefficient is capped: a band more than `fetchLongBandLimit` times the
 * fully developed peak wavelength is treated as EXACTLY that many times longer.
 * At the shipped 2 this touches nothing on swell (λ_band/λ_peak = 0.74) or
 * storm (0.45) — their coefficients are 0.55 and 0.21, nowhere near the cap —
 * and turns calm's step into a ramp spread over ~100 m of fetch. One number,
 * one preset affected, and it is the honest place to put the interaction with
 * §V.36 rather than letting it show up as a ring.
 *
 * ── THE FIRST COMPRESSION: `fetchWorldScale` ────────────────────────────────
 *
 * Same shape of honesty as `shoalWavenumberFloor`, and paid in one number.
 * Real full development at the shipped 11 m/s needs F̃ = 2.2e4, i.e. 271 km of
 * open water. Our archipelago is 9 km across. Uncompressed, the ENTIRE WORLD
 * would be fetch-limited and the open ocean would collapse — the exact defect
 * the shoaling floor exists to prevent, one file over.
 *
 * `fetchWorldScale` converts world metres to physical fetch metres. At the
 * shipped 260 the sea is fully developed after:
 *      4 m/s (calm)   138 m        11 m/s (swell, shipped)  1043 m
 *     18 m/s (storm) 2794 m
 * of clear upwind water. So the open sea between islands is untouched, and the
 * feature acts inside rims and in the few hundred metres directly downwind of
 * land — which is what was asked for. The wind dependence is not an artefact
 * and is worth keeping: the same 120 m anchorage is fully developed in light
 * air and hard-limited in a gale, which is what a real one does.
 *
 * §V.8 — THE TRANSLITERATION PAIR. Three consumers scale displacement by this
 * gain and they must not be able to derive it differently: the ocean material
 * (`surfaceMaterial.ts`), the CPU mirror the ship floats on
 * (`sea-physics/cpuOcean.ts`), and the terrain's reconstruction of the sea
 * (`caustics/causticsNode.ts` → `waterHeightNode`, the §V.72/f62e037 lesson).
 * All three call the functions below or their TSL twins immediately beneath
 * them. Same convention as `shoaling.ts`, `bandLimit.ts`, `foamMath.ts`.
 *
 * §V.23: 1- and 2-arg math only. §V.28: every divisor floored.
 */
import { float } from 'three/tsl';

/** any TSL node — this math is structural, not typed (file-local convention) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNode = any;

/** floor for every divisor here (§V.28) */
const EPS = 1e-6;

/** m/s² — the same g the ocean spectrum is built with */
const GRAVITY = 9.81;

/**
 * Dimensionless fetch at which a sea is FULLY DEVELOPED — the Pierson-Moskowitz
 * limit, F̃ = gF/U² ≈ 2.2e4. Beyond it more fetch buys nothing, which is what
 * makes `developmentRatio` clamp at 1 and the open ocean immovable.
 */
export const PM_DIMENSIONLESS_FETCH = 2.2e4;

/** JONSWAP: ω̃_p = ω_p·U/g = 22·F̃^(−0.33) (Hasselmann et al. 1973) */
const PEAK_COEFFICIENT = 22;
const PEAK_EXPONENT = 0.33;

/**
 * JONSWAP: α = 0.076·F̃^(−0.22). Only the EXPONENT is used — the ratio of two
 * spectra cancels the 0.076 — which is why the constant does not appear below.
 */
const ALPHA_EXPONENT = 0.22;

/**
 * ω̃_p of the fully developed sea, from the SAME fit rather than from PM's own
 * 0.877, so the ratio is exactly 1 at r = 1 by construction instead of by
 * agreement between two papers. It lands at 0.812 against PM's 0.877 — a 7%
 * difference in peak period that never appears in a rendered frame, because
 * every quantity this file produces is a RATIO in which it cancels.
 */
const PM_PEAK_NONDIM = PEAK_COEFFICIENT * Math.pow(PM_DIMENSIONLESS_FETCH, -PEAK_EXPONENT);

/**
 * `r` floor (§V.28). `r^(−1.32)` at r = 0 is +inf, and inf·0 in the exponent
 * (a band with k_p/k = 0) is NaN, which would poison the whole surface. 1e-3 is
 * far below any fetch a floating ship can be in — at the shipped wind it is
 * one metre of upwind water — and the gain there is already ~0 for every band
 * long enough to matter.
 */
const RATIO_FLOOR = 1e-3;

/**
 * What a consumer needs from the shelter field, and NOTHING else.
 *
 * Structural on purpose, exactly as `SeabedField` is for shoaling: the CPU
 * mirror in `sea-physics/` must stay free of three and of the island's params
 * (§V.3), and a test must be able to hand this an analytic shelter —
 * `{ fetchAt: () => 120 }` — which is the only way to assert the law at a
 * KNOWN fetch. `src/ocean/fetchField.ts` is the real one.
 */
export interface FetchSource {
  /** clear upwind water (m) at a world XZ, saturating at the field's cap */
  fetchAt(x: number, z: number): number;
}

/** the two dimensionless constants this file is parameterised by (§V.16) */
export interface FetchParams {
  /** world metres → physical fetch metres. THE compression; see the header. */
  fetchWorldScale: number;
  /** ceiling on the young-sea steepening term — see `fetchBandGain` */
  fetchMaxGain: number;
  /** how far below the peak a band may be treated as — see the header */
  fetchLongBandLimit: number;
}

/**
 * Peak wavenumber (rad/m) of the FULLY DEVELOPED sea at this wind. This is the
 * yardstick every band is measured against: a band far above it is in the
 * equilibrium tail and barely cares about fetch, a band below it is swell the
 * wind has not had room to build.
 *
 * ω_p = ω̃_p·g/U, k_p = ω_p²/g (deep water) ⟹ k_p = ω̃_p²·g/U².
 */
export function fullyDevelopedPeakWavenumber(windSpeed: number): number {
  const u = Math.max(windSpeed, EPS);
  return (PM_PEAK_NONDIM * PM_PEAK_NONDIM * GRAVITY) / (u * u);
}

/**
 * World metres of clear upwind water at which the sea reaches full development
 * at this wind. Nothing in the shader uses this — it is the legible form of the
 * compression, the number the docstrings and the tests quote, and the uniform
 * the ratio is divided by.
 */
export function fullyDevelopedFetch(windSpeed: number, p: FetchParams): number {
  const u = Math.max(windSpeed, EPS);
  const scale = Math.max(p.fetchWorldScale, EPS);
  return (PM_DIMENSIONLESS_FETCH * u * u) / (GRAVITY * scale);
}

/**
 * How grown the sea is here, 0..1. 1 = fully developed = open ocean = every
 * gain below is exactly 1.
 *
 * Clamped at the top rather than allowed past 1: more fetch than the PM limit
 * is not a bigger sea, and an unclamped r > 1 would turn the steepening term
 * into a REDUCTION of the open ocean, which is the one thing this feature is
 * not allowed to do.
 */
export function developmentRatio(
  fetchMetres: number,
  windSpeed: number,
  p: FetchParams,
): number {
  const full = Math.max(fullyDevelopedFetch(windSpeed, p), EPS);
  const r = Math.max(fetchMetres, 0) / full;
  return Math.min(Math.max(r, RATIO_FLOOR), 1);
}

/** TSL twin of `developmentRatio`. `uFullFetch` is a uniform in world metres. */
export function developmentRatioNode(fetchMetres: AnyNode, uFullFetch: AnyNode): AnyNode {
  return fetchMetres.max(0).div(float(uFullFetch).max(EPS)).clamp(RATIO_FLOOR, 1);
}

/**
 * (k_pfull / k_band)² — the band's whole dependence on wavenumber, precomputed
 * once per cascade per wind change so the per-vertex work is one exp().
 *
 * `bandK` is the cascade's ENERGY-WEIGHTED mean wavenumber, the same live
 * measurement `shoalWavenumber` keys on (`OceanCascade.meanWavenumber`) — a
 * baked constant is wrong on two of three presets, see §V.72.
 */
export function fetchBandCoefficient(
  peakK: number,
  bandK: number,
  p: FetchParams,
): number {
  const ratio = peakK / Math.max(bandK, EPS);
  // THE SECOND COMPRESSION, and it is the answer to "how does this interact
  // with §V.36's decoupling of `amplitude` from `windSpeed`" — see the header's
  // SWELL BLOCKING note for the mechanism and MEASURED, below, for the price.
  const limit = Math.max(p.fetchLongBandLimit, 1);
  return Math.min(ratio * ratio, limit * limit);
}

/**
 * THE GAIN: how much of this band survives at development ratio `r`, relative
 * to the fully developed sea at the same wind.
 *
 *   gain = r^(−0.11) · exp( −0.625 · C · (r^(−1.32) − 1) )
 *
 * · at r = 1 both factors are exactly 1 — the open ocean cannot move;
 * · C is large for LONG bands, so they are deleted first, which is what turns
 *   shelter into chop rather than into a scaled-down ocean;
 * · r^(−0.11) > 1 is the young-sea steepening (√ of the α ratio). It is real
 *   physics and it is the reason a sheltered anchorage looks busy, but it is
 *   the only term here that ADDS energy, so it is clamped by `fetchMaxGain`.
 *   The clamp is a §V.44 boundedness guard on a term with an unbounded limit
 *   (r → 0 sends it to infinity), not a look knob: without it the foam gate
 *   (§V.6, which reads the Jacobian this scales) would eventually whitecap a
 *   puddle. It binds only at r below ~0.03, i.e. a few metres of upwind water.
 */
export function fetchBandGain(coefficient: number, ratio: number, p: FetchParams): number {
  const r = Math.min(Math.max(ratio, RATIO_FLOOR), 1);
  // (r^(−4·0.33) − 1) — the peak's migration, ≥ 0, and 0 exactly at r = 1
  const grow = Math.pow(r, -4 * PEAK_EXPONENT) - 1;
  // √(α ratio) — the steepening, ≥ 1, and 1 exactly at r = 1
  const steep = Math.pow(r, -ALPHA_EXPONENT * 0.5);
  const cut = Math.exp(-1.25 * 0.5 * Math.max(coefficient, 0) * grow);
  return Math.min(steep * cut, Math.max(p.fetchMaxGain, 1));
}

/**
 * TSL twin of `fetchBandGain`. `uCoefficient` and `uMaxGain` are uniforms,
 * `ratio` is the per-vertex node from `developmentRatioNode`.
 *
 * §V.28: `ratio` is already clamped to [RATIO_FLOOR, 1] by its producer, which
 * is what keeps `pow` away from 0 and the exponent finite. Do not feed this a
 * raw fetch.
 */
export function fetchBandGainNode(
  uCoefficient: AnyNode,
  ratio: AnyNode,
  uMaxGain: AnyNode,
): AnyNode {
  const grow = ratio.pow(-4 * PEAK_EXPONENT).sub(1);
  const steep = ratio.pow(-ALPHA_EXPONENT * 0.5);
  const cut = float(uCoefficient).max(0).mul(grow).mul(-1.25 * 0.5).exp();
  return steep.mul(cut).min(float(uMaxGain).max(1));
}
