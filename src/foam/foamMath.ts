/**
 * Pure CPU mirrors of the foam GPU math (§V6) — no three imports so
 * tests/foam.test.ts runs in node without a GPU. Change one side → change
 * the other (same mirror contract as deckwater/fluxMath.ts).
 */
import { fbm2Cpu } from '../terrain/noiseCpu';

/**
 * Half-life → per-frame decay factor: factor = 2^(−dt/halfLife), so after
 * halfLife seconds of frames the foam value has halved exactly. This is WHY
 * the tunable is a half-life and not a raw multiplier: artists reason in
 * "foam lasts ~a second", not "multiply by 0.9906 per frame" (§V6 dissipate).
 * halfLife ≤ 0 → 0 (foam dies instantly rather than dividing by zero).
 */
export function decayFactorPerFrame(halfLifeSeconds: number, dt: number): number {
  if (halfLifeSeconds <= 0) return 0;
  return Math.pow(2, -dt / halfLifeSeconds);
}

/**
 * Injection amount for one frame (§V6): jacobian below the bias means the
 * wave surface is folding over itself → foam ∝ how far below. GPU mirror:
 * injectPass. Never negative — calm water must not scrub existing foam.
 */
export function injectAmount(
  jacobian: number,
  bias: number,
  strengthPerSecond: number,
  dt: number,
): number {
  return Math.max(0, bias - jacobian) * strengthPerSecond * dt;
}

/* -------------------------------------------------------------------------
 * §V36 for the JACOBIAN gate (§B: `jacobianFoamBias` applied to the wrong
 * statistic). `oceanParams.jacobianFoamBias` is calibrated against the
 * SUMMED three-cascade jacobian — surfaceMaterial computes `d0.w+d1.w+d2.w−2`
 * and its own fallback threshold is that same number. The foam sim injects
 * PER CASCADE, and one band's det J is a much narrower distribution than the
 * sum of three: measured on the shipped swell spectrum, σ is 0.055 / 0.093 /
 * 0.147 per band against 0.183 for the sum. Applying 0.55 to each band
 * therefore asked for a 8.2σ / 4.9σ / 3.1σ event instead of the 2.5σ event
 * the number means — ≈0.15 texels of 262144 firing per frame, i.e. no foam
 * at all at swell, while storm's ~3× wider bands still cleared it. Exactly
 * §B.12's failure: a constant calibrated against one statistic, applied to
 * another, changing meaning in silence.
 * ---------------------------------------------------------------------- */

/**
 * σ(det J of one cascade) ÷ (λ · RMS Jacobian TRACE of that cascade) — and it
 * is exactly 1, which is why it is documented rather than fitted.
 *
 * det J = (1+λa)(1+λb) − (λc)² with (a,b,c) = (∂Dx/∂x, ∂Dz/∂z, ∂Dx/∂z), so to
 * first order its spread is λ·σ(a+b): the trace, spectral transfer |k|. The
 * ocean now PUBLISHES that moment (`OceanCascade.jacobianRms`), so no
 * conversion is needed.
 *
 * IT USED TO BE 1.79 AGAINST `steepnessRms`, and that was a latent §B.12.
 * `spectralSteepness` measures kx²/|k| — the x-gradient only — so the ratio
 * between it and the trace depends on the spectrum's DIRECTIONAL SHAPE. For a
 * broad wind sea that is 1.79 to within 1% in every band of every preset, and
 * it held for months. The swell train broke it in one step: swell is a narrow
 * one-sided cos²⁴ beam, so the ratio becomes ~1/cos²θ of its heading, and
 * `calm` — whose long band is ~100% swell — measured 4.75. The foam gate in
 * that band was sitting at 2.65× the σ-multiple it claimed.
 */
export const JACOBIAN_SIGMA_PER_TRACE = 1;

/** absolute floor: a sea with no spectrum at all has no bands to gate (§V28) */
export const MIN_BAND_JACOBIAN_SIGMA = 1e-9;

/**
 * A band holding less than this fraction of the sea's jacobian σ is DEAD, not
 * merely quiet, and is switched off rather than gated.
 *
 * Not a nicety — it is the failure mode of a purely relative gate. Calm has
 * essentially nothing in the 420 m band (σ ≈ 6e-6 against the sea's 0.125), so
 * "the same σ-multiple" puts its threshold at 0.99996 while its det J is
 * 1 ± 6e-6: half the texels of the whole cascade would clear it, and the
 * σ-relative injection would then treat that float noise as a real fold and
 * foam over half the sea. A band that cannot fold must not be normalised into
 * relevance.
 */
export const DEAD_BAND_SIGMA_FRACTION = 1e-3;

/**
 * Gate value that provably never injects, for EITHER fold metric: det J ≥ 0
 * in any sane sea, and λ− = 1 + λ·μ− sits ~38σ above this even in storm's
 * widest band (σ(λ−) = 0.287 there). Used to switch a band off outright.
 */
export const NEVER_INJECT_BIAS = -10;

/** can this band produce a real fold, or is it float noise? (see above) */
export function bandCanFold(bandSigma: number, seaSigma: number): boolean {
  if (!Number.isFinite(bandSigma) || !Number.isFinite(seaSigma)) return false;
  if (!(seaSigma > MIN_BAND_JACOBIAN_SIGMA)) return false;
  return bandSigma > Math.max(MIN_BAND_JACOBIAN_SIGMA, DEAD_BAND_SIGMA_FRACTION * seaSigma);
}

/**
 * σ of one band's det J, from the moments the ocean already publishes:
 * `OceanCascade.jacobianRms` (at λ=1) × the effective choppiness λ actually
 * sent to the GPU. Pass the sea-wide `OceanSimulation.jacobianRms` to get σ of
 * the summed jacobian.
 */
export function jacobianSigma(jacobianRms: number, choppiness: number): number {
  if (!Number.isFinite(jacobianRms) || !Number.isFinite(choppiness)) return 0;
  return JACOBIAN_SIGMA_PER_TRACE * Math.max(0, jacobianRms) * Math.max(0, choppiness);
}

/**
 * Per-cascade inject threshold that carries the SAME σ-multiple the artist's
 * `jacobianFoamBias` means on the summed jacobian (§V36).
 *
 * The summed gate fires at z = (1 − bias)/σ_sea below the rest value 1. A
 * band whose own σ is σ_band must therefore sit at 1 − (1 − bias)·σ_band/σ_sea
 * to fire at that same z. At swell this turns the flat 0.55 into
 * 0.864 / 0.771 / 0.637 and every band fires at 2.48σ instead of 8.2 / 4.9 /
 * 3.1σ. A band with no energy in it (calm's 420 m cascade) can never fold, so
 * it is gated off outright rather than handed a divide-by-nothing.
 */
export function cascadeFoamBias(
  bias: number,
  bandSigma: number,
  seaSigma: number,
): number {
  if (!bandCanFold(bandSigma, seaSigma)) return NEVER_INJECT_BIAS;
  // ratio ≤ 1 by quadrature (σ_sea² = Σ σ_band²); clamped anyway so a stale
  // moment can never bias a band ABOVE the rest value and foam the flat sea
  return 1 - (1 - bias) * Math.min(1, bandSigma / seaSigma);
}

/**
 * Per-cascade injection scale, in units of σ of fold depth per second (§V36
 * again — the AMOUNT injected has to be σ-relative for the same reason the
 * THRESHOLD does).
 *
 * The GPU multiplies the raw deficit (bias − J) by this. Dividing by the
 * band's own σ makes `injectStrength` mean "foam per second per σ that the
 * jacobian sits below the gate", identical across bands and across weather.
 * Without it the deficit at a 2.5σ fold is ~0.02 in the coarse band and ~0.05
 * in the fine one, so the same setting produced 2.5× the foam in one band as
 * another and roughly 20× less foam at swell than at storm — the amplitude
 * half of the "no whitecaps" report, distinct from the threshold half above.
 */
export function cascadeInjectPerStep(
  strengthPerSecond: number,
  dt: number,
  bandSigma: number,
  seaSigma: number,
): number {
  // dead bands return 0 rather than a huge 1/σ: their bias is NEVER_INJECT so
  // the deficit is already clamped to 0, and 0 × Infinity is NaN (§V28)
  if (!bandCanFold(bandSigma, seaSigma) || !(dt > 0)) return 0;
  return (Math.max(0, strengthPerSecond) * dt) / bandSigma;
}

/* -------------------------------------------------------------------------
 * THE FOLD METRIC: det J is the WRONG ONE (§B, user "the regularity of them").
 *
 * The choppy displacement is a gradient field, so ∇D is SYMMETRIC and
 * J = I + λ∇D has two real eigenvalues. Tessendorf (coursenotes 2004, eq. 45–49)
 * is explicit about which one carries the signal:
 *   "The criterion for folding that J < 0 means that J− < 0 and J+ > 0. So the
 *    minimum eigenvalue is the actual signal of the onset of folding."
 *
 * det J = J−·J+ measures AREA compression. Area is direction-free, so its
 * super-level sets are ROUND — every cap the same blob, and the only thing
 * that could then give a cap a direction was the blur kernel, which had one
 * direction for the whole ocean. That is the lattice the user photographed
 * four times. λ− measures compression along ONE axis, so it fires as a RIDGE
 * that already points along the local crest, and the crest curves.
 *
 * MEASURED on the shipped spectra (CPU mirror of the real IFFT field, all
 * three bands × calm/swell/storm, gate held at the same σ-multiple):
 *                             det J          λ−
 *   coverage (cascade 1)      0.5 %          9.2 %
 *   cap length spread CV      0.08           0.68
 *   cap orientation spread    2.1°           21.4°
 * i.e. det J at the same threshold produced almost no foam AND what it did
 * produce was one size at one angle. Both user complaints, one cause.
 *
 * λ± = ½(tr ± √(tr² − 4·det)) needs only the TRACE and the DETERMINANT, and
 * the ocean already publishes both — det J in `displacement.w`, ∂Dx/∂x and
 * ∂Dz/∂z in `derivatives.zw`. No new ocean output, and the off-diagonal term
 * never has to be reconstructed (it only ever appears squared).
 * ---------------------------------------------------------------------- */

/**
 * Minimum eigenvalue of the symmetric 2×2 displacement jacobian, from its
 * trace and determinant alone. GPU mirror: injectPass.
 *
 * The discriminant is ≥ 0 for a real symmetric matrix, so the `max(0, …)` is
 * a float-error floor, not a branch — without it a texel one ulp under zero
 * returns NaN and poisons the whole accumulator (§V28).
 */
export function minEigenvalue(trace: number, det: number): number {
  return 0.5 * (trace - Math.sqrt(Math.max(0, trace * trace - 4 * det)));
}

/* -------------------------------------------------------------------------
 * §V36 for λ−. The gate has to stay a multiple of the LIVE sea's own spread,
 * and λ− has a different mean AND a different spread from det J: it is the
 * min of two eigenvalues, so its mean sits BELOW the rest value 1 even on a
 * flat sea, and no amount of "threshold below 1" reasoning survives that.
 *
 * Both constants are measured against the band's own `jacobianRms × λ` (the
 * same normaliser JACOBIAN_SIGMA_PER_STEEPNESS uses, because a Gaussian
 * surface scales its whole displacement-gradient distribution with that one
 * number. Measured over every band of every shipped preset:
 *
 *   preset band   E[μ]/s    σ(μ)/s     (μ = (λ− − 1)/λ, s = jacobianRms)
 *   calm    0     −1.134     1.357
 *   calm    1     −1.056     1.366
 *   calm    2     −1.034     1.319
 *   swell   0     −1.068     1.339
 *   swell   1     −1.155     1.463
 *   swell   2     −1.029     1.312
 *   storm   0     −1.002     1.271
 *   storm   1     −1.161     1.467
 *   storm   2     −1.029     1.312
 *
 * tests/foam.test.ts re-derives both from the real spectrum and fails if a
 * spread/directionality retune moves them — the same guard the det-J constant
 * carries, and for the same reason (§V36: a gate whose σ silently drifts).
 * ---------------------------------------------------------------------- */

/** E[λ−] − 1, per unit of λ·jacobianRms. Negative: λ− ≤ ½·tr always. */
export const EIGEN_MEAN_PER_TRACE = -0.592;
/** σ(λ−) per unit of λ·jacobianRms. */
export const EIGEN_SIGMA_PER_TRACE = 0.754;

/** where λ− sits on an undisturbed sea of this band — NOT 1 (see above) */
export function eigenRestValue(traceRms: number, choppiness: number): number {
  return 1 + EIGEN_MEAN_PER_TRACE * scaleOf(traceRms, choppiness);
}

/** σ of this band's λ− */
export function eigenSigma(traceRms: number, choppiness: number): number {
  return EIGEN_SIGMA_PER_TRACE * scaleOf(traceRms, choppiness);
}

function scaleOf(traceRms: number, choppiness: number): number {
  if (!Number.isFinite(traceRms) || !Number.isFinite(choppiness)) return 0;
  return Math.max(0, traceRms) * Math.max(0, choppiness);
}

/**
 * The σ-multiple the artist's `oceanParams.jacobianFoamBias` means (§V36).
 * It is calibrated on the SUMMED det J, which rests at 1 — so the number is
 * read as "fire where the sea is folding this many σ below rest", and that
 * z is what every band then reproduces against ITS OWN metric.
 */
export function foamGateZ(bias: number, seaSigma: number): number {
  if (!Number.isFinite(bias) || !(seaSigma > MIN_BAND_JACOBIAN_SIGMA)) return Infinity;
  return (1 - bias) / seaSigma;
}

/**
 * Per-cascade λ− threshold carrying that same z (§V36), in λ− units so the
 * GPU keeps the cheap `max(0, gate − metric)` form it already had.
 * A band with no energy is gated OFF rather than normalised into relevance —
 * see bandCanFold; without it calm's empty 420 m band would foam on float noise.
 */
export function eigenFoamGate(
  bias: number,
  traceRms: number,
  choppiness: number,
  bandSigmaJ: number,
  seaSigmaJ: number,
  /**
   * How much wider the METRIC is than λ− alone (metricSigmaScale). The gate is
   * a z-score, so it has to be taken against the spread of the thing actually
   * compared to it — the zero-mean bias and breakup terms widen that spread
   * without moving its mean, and ignoring them fires the gate 2.8× too often.
   */
  sigmaScale = 1,
): number {
  if (!bandCanFold(bandSigmaJ, seaSigmaJ)) return NEVER_INJECT_BIAS;
  const z = foamGateZ(bias, seaSigmaJ);
  if (!Number.isFinite(z)) return NEVER_INJECT_BIAS;
  const scale = Number.isFinite(sigmaScale) ? Math.max(1e-6, sigmaScale) : 1;
  return eigenRestValue(traceRms, choppiness) - z * eigenSigma(traceRms, choppiness) * scale;
}

/**
 * Per-cascade injection scale for the λ− gate: foam per second per σ of fold
 * depth, identical across bands and weather (§V36 — the AMOUNT has to be
 * σ-relative for the same reason the THRESHOLD does). The GPU multiplies the
 * raw λ− deficit by this, and dividing by the band's own σ is what turns that
 * raw deficit back into σ.
 */
export function eigenInjectPerStep(
  strengthPerSecond: number,
  dt: number,
  traceRms: number,
  choppiness: number,
  bandSigmaJ: number,
  seaSigmaJ: number,
  /** the same widening the gate takes — the AMOUNT is σ-relative too (§V36) */
  sigmaScale = 1,
): number {
  if (!bandCanFold(bandSigmaJ, seaSigmaJ) || !(dt > 0)) return 0;
  const scale = Number.isFinite(sigmaScale) ? Math.max(1e-6, sigmaScale) : 1;
  const sigma = eigenSigma(traceRms, choppiness) * scale;
  // 0 × Infinity is NaN, and the gate above is already NEVER_INJECT there
  if (!(sigma > MIN_BAND_JACOBIAN_SIGMA)) return 0;
  return (Math.max(0, strengthPerSecond) * dt) / sigma;
}

/* -------------------------------------------------------------------------
 * THE JACOBIAN DECIDES *WHERE*; THE WIND DECIDES *HOW MUCH*
 * (docs/research-whitecap-coverage.md §4.1 and §7 — user: "you can have a
 * massive swell on a non-windy day".)
 *
 * Every gate above is σ-relative (§V36), which is the right idiom and is why
 * they hold across weather presets — but σ-relative means SCALE-FREE. Raise a
 * tall swell with the local wind at nothing and its folds still clear their
 * own band's σ, so foam still injects. The literature says that must not
 * happen: whitecapping is wind-driven breaking, and swell is BY DEFINITION
 * wave energy that has left the wind that raised it. Callaghan et al. 2008
 * measured coverage about one third lower in swell-dominated seas than in
 * mixed ones; Brumer et al. 2017 found that expressing coverage in wavefield
 * statistics decoupled from wind is a WORSE predictor, not a better one.
 *
 * The fix the research names is NOT to change the gate. A fold criterion is
 * the only thing that can say which crest is breaking, and no wind-speed
 * formula can. What the wind owns is the AMOUNT.
 * ---------------------------------------------------------------------- */

/**
 * Wind speed (m/s) below which published fits give literally zero whitecap
 * coverage. THE load-bearing number of the whole curve, and the reason it can
 * be trusted is a coincidence worth keeping in the file: Beaufort Force 3 —
 * the first mention of whitecaps anywhere in the scale — begins at 7 kt =
 * 3.60 m/s, and Callaghan's independent 2008 least-squares fit to video
 * imagery landed at 3.70. A 19th-century descriptive scale and a modern
 * regression agree to 0.1 m/s.
 */
export const WHITECAP_ONSET_MS = 3.7;

/**
 * Callaghan et al. (2008) whitecap coverage as an AREA FRACTION — the
 * threshold-cubic quoted in docs/research-whitecap-coverage.md §1.1 from
 * Albert et al. 2016 Eq. (2) (open access), converted from percent:
 *
 *   W = 0                           U10 < 3.70
 *   W = 3.18e-5 · (U10 − 3.70)³     3.70 ≤ U10 ≤ 11.25
 *   W = 4.82e-6 · (U10 + 1.98)³     9.25 ≤ U10 ≤ 23.09
 *
 * The two branches OVERLAP on 9.25–11.25 in the paper's own domain statement
 * and disagree by 26% at 9.25, so crossfading across that window is what the
 * published structure invites rather than something invented here.
 *
 * CLAMPED AT 0.10, and the clamp is load-bearing rather than defensive:
 * Brumer et al. 2017 measured out to sustained 25 m/s and state that coverage
 * levels off, "not exceeding 10% when averaged over 20 min", while our
 * `windSpeed` slider goes to 30 — past the fit's own 23.09 validity edge.
 *
 * NEVER READ AS AN ABSOLUTE TARGET — see `whitecapWindScale`. Observed
 * coverage scatters by one to two orders of magnitude at a fixed wind speed
 * (research §5, three independent sources in those words), so the SHAPE of
 * this curve is trustworthy and its LEVEL is not.
 */
export function whitecapCoverage(windSpeed: number): number {
  const u = Number.isFinite(windSpeed) ? windSpeed : 0;
  if (!(u > WHITECAP_ONSET_MS)) return 0;
  const below = u - WHITECAP_ONSET_MS;
  const above = u + 1.98;
  const low = 3.18e-5 * below * below * below;
  const high = 4.82e-6 * above * above * above;
  // smoothstep across the published overlap window, so the 26% step at its
  // lower edge never shows up as a discontinuity in foam as the wind crosses
  const x = Math.min(1, Math.max(0, (u - 9.25) / 2));
  return Math.min(0.1, low + (high - low) * x * x * (3 - 2 * x));
}

/**
 * Multiplier on the foam sim's INJECTION RATE for the live wind, as a ratio to
 * the wind the coverage was calibrated at.
 *
 * A RATIO, never an absolute (§V36, the same argument as every σ-multiple
 * above): at the reference wind this returns exactly 1, so the calibrated sea
 * is a bit-identical no-op and every other wind moves relative to it. Feeding
 * `whitecapCoverage` in directly would instead import the literature's LEVEL,
 * which §5 of the research says is the one thing it cannot supply.
 *
 * ONE-SIDED ON PURPOSE — clamped at 1, so the wind can only take foam AWAY
 * below the reference, never add it. Two reasons, both worth stating:
 *   - the defect is foam on a windless swell, which lies entirely below the
 *     reference. Nothing above it was reported broken.
 *   - the UNCLAMPED ratio at storm's 18 m/s is 3.6×, and that is a coverage
 *     CALIBRATION, not a gating fix. Storm cannot be calibrated against while
 *     its Hs reads 18.6 m against the 8–10 m the preset was cut to. Whoever
 *     fixes storm's height can delete the `Math.min(1, …)` in one edit and
 *     get the physical curve on both sides.
 *
 * Measured against the shipped 11 m/s reference:
 *   4 m/s → 8.1e-5 (calm: off, which is the published law AND the user's own
 *   "if it's rather calm it's fine that there's no foam")   6 m/s → 0.036
 *   8 m/s → 0.238    11 m/s → exactly 1    ≥ 11.25 m/s → 1 by the clamp.
 */
export function whitecapWindScale(windSpeed: number, referenceSpeed: number): number {
  const reference = whitecapCoverage(referenceSpeed);
  // a reference at or below onset has no ratio to give — leave foam alone
  // rather than divide by zero and scrub the sea (§V28)
  if (!(reference > 0)) return 1;
  return Math.min(1, whitecapCoverage(windSpeed) / reference);
}

/** accumulate with existing foam, clamped ≤ 1 (§V6: mask feeds a mix factor) */
export function accumulateFoam(previous: number, injected: number): number {
  return Math.min(1, previous + injected);
}

/* -------------------------------------------------------------------------
 * THE MASK WAS DWELL TIME, NOT BREAKING INTENSITY (§B, user: "we don't see a
 * bias towards the higher and steeper cresting having the foam and the splash,
 * while the troughs have less of it... it kinda just gets emitted there but
 * then it doesn't really respect it").
 *
 * MEASURED headless on the realised three-cascade field — swell preset, 256²
 * CPU mirror of the real IFFT, 300 ticks, composited onto a 1010 m world grid
 * with every finer band BOX-AVERAGED to the cell footprint (point-sampling
 * cascade 2's 0.089 m texels onto a 2 m grid is pure aliasing and would
 * decorrelate everything by construction):
 *
 *   by TOTAL-ELEVATION decile        bottom      top      ratio
 *   injection this tick             0.00010   0.00329    33 : 1
 *   foam on screen                  0.0348    0.0810    2.3 : 1
 *
 * and foam COVERAGE by that same decile ran
 *   21.4  12.5  11.0  10.2  9.5  9.5  9.8  10.4  11.4  21.9
 * i.e. THE DEEPEST TROUGHS WERE AS FOAMY AS THE HIGHEST CRESTS.
 *
 * THE INJECTION IS NOT THE DEFECT, and that is the whole point. λ−'s trace
 * half is −½λ|k|ĥ — an implicit elevation term — and it measures r = −0.90
 * against its own band's elevation. 82.2% of everything injected lands in the
 * top 30% of the sea by elevation and 67.9% in the top 10%. By the time it is
 * on screen those are 45.4% and 27.7%. Four alternative CRITERIA were tried
 * (trace only, cross-band total trace, convergence-gated anisotropy, both
 * together) and every one scored the same or worse, because they all inherit
 * the same fate downstream.
 *
 * What loses it is the ACCUMULATOR. `injectStrength` 4.0 adds ~0.0033 per tick
 * at a hard-breaking texel, so reaching a mask of 0.3 takes ~100 ticks while
 * the decay-weighted mean visible age is 77. The value a texel carries is
 * therefore ≈ how LONG it has been firing, not how HARD it is firing now: a
 * weak 100-tick fire and a violent 20-tick fire arrive identical. Half-life
 * sweep, share of foam mass in the top 30% of the sea by elevation, with the
 * injection pinned at 82.2% throughout and the blur held at a constant 0.6 m
 * world spread so this isolates TIME alone:
 *
 *   halfLife    0.05 s   0.15 s   0.30 s   0.90 s (was)   2.00 s
 *   share        82.3%    77.8%    66.8%     45.4%         36.9%
 *
 * It is NOT clipping — measured saturation at the shipped settings is 0.00%.
 * And it means §T.41 is BACKWARDS for this complaint: raising `decayHalfLife`
 * to buy trailing takes the crest bias from 45% to 37%.
 *
 * ⟹ TWO CHANNELS, TWO CLOCKS, ONE TEXTURE. R keeps the long residue (real seas
 * do leave foam behind a breaker, and deleting it outright is exactly the
 * variance §V.64 forbids throwing away). G is the same injection on a short
 * clock, so it is a RATE and cannot integrate long enough to drift off its
 * crest. The texture was already RGBA and both G and B were being written as
 * zero, and the shading already takes ONE sample of it — so this costs no
 * binding, no sampler and no dispatch (§V.40 untouched).
 *
 * Measured on the SHADED mask (raw → foamMath.dissolveKnee, which is what
 * decides whether foam exists at a texel at all), swell:
 *
 *                                     mass in top 30%   top 10%
 *   shipped                                58.8%         42.2%
 *   + breaking channel                     81.1%         61.6%
 *   + cross-band crest bias (below)        92.4%         76.1%
 *
 * at 83% of the shipped total foam mass — a real reduction, declared rather
 * than hidden (§V.64): `injectStrength` is the knob that buys it back, and the
 * foam that was removed is the trough residue the complaint was about.
 * ---------------------------------------------------------------------- */

/**
 * Scale that puts the short-clock BREAKING channel onto the long-clock
 * residue's own scale, so `breakingWeight` is a mix factor and not a magic
 * multiplier that silently means something different at every half-life.
 *
 * DERIVED, not fitted — and the ORDER OF THE PASSES IS PART OF THE DERIVATION.
 * A tick is inject THEN blurDecay, i.e. x ← (x + I)·decay, so under a constant
 * injection rate I a channel settles at I·decay/(1 − decay), NOT at
 * I/(1 − decay). The naive form is 6.6% low at the shipped clocks, which is
 * small enough to read as tuning and wrong for a reason that would come back
 * the moment either half-life moved. tests/foam.test.ts runs both accumulators
 * to steady state and compares, so the ordering cannot silently change either.
 */
export function breakingGain(decay: number, breakingDecay: number): number {
  if (!Number.isFinite(decay) || !Number.isFinite(breakingDecay)) return 0;
  const d = Math.min(1, Math.max(0, decay));
  const b = Math.min(1, Math.max(0, breakingDecay));
  // decay = 1 is foam that never dies: the steady state is unbounded and the
  // ratio meaningless. decay = 0 is a channel that holds nothing, so there is
  // nothing to put on the residue's scale — and it is the divisor (§V28).
  if (!(d < 1) || !(b > 0)) return 0;
  return (d * (1 - b)) / (b * (1 - d));
}

/**
 * The visible mask from the two channels (GPU mirror: index.shadingNode).
 *
 * `residueWeight = 1, breakingWeight = 0` reproduces the pre-split mask BIT
 * FOR BIT, which is what makes the whole change a clean A/B rather than a
 * rewrite — the same contract `erodeDepth = 0` carries for the dissolve.
 */
export function foamMaskFrom(
  residue: number,
  breaking: number,
  gain: number,
  residueWeight: number,
  breakingWeight: number,
  /**
   * Optical density (foamCoverage). Omit — or pass 0 — for the pre-soft-
   * saturation behaviour, a hard clamp at 1, which is what makes this a clean
   * A/B against everything measured before it.
   */
  density = 0,
): number {
  const r = Math.max(0, residue) * Math.max(0, residueWeight);
  const b = Math.max(0, breaking) * Math.max(0, gain) * Math.max(0, breakingWeight);
  if (!(density > 0)) return Math.min(1, r + b);
  return foamCoverage(r + b, density);
}

/**
 * λ− bias per METRE of the elevation the OTHER cascades contribute here — the
 * long-wave straining term, precomputed CPU-side so the inject pass is one
 * multiply-subtract (§V.2: per-tick constants never live in the kernel).
 *
 * WHY IT IS NEEDED AT ALL. Each lane injects from its OWN band's jacobian, so
 * each band's implicit elevation term only knows its own band: measured
 * r(foam of the 98 m cascade, elevation of the 1010 m cascade) = 0.04–0.12,
 * i.e. THE 8–40 m CAPS ARE BLIND TO THE SWELL THEY RIDE ON. Real whitecapping
 * is not band-separable — a short wave breaks because it is riding the crest
 * of a long one, which steepens it — and the band split threw exactly that
 * coupling away. Adding it moved the shaded crest share 81.1% → 92.4% (top
 * 30%) and 61.6% → 76.1% (top 10%).
 *
 * WHY IT IS ELEVATION AND NOT THE CROSS-BAND TRACE: both were measured, and
 * the trace form did WORSE. The trace is |k|-weighted (transfer −|k|·ĥ), so
 * summing it across bands lets the finest band's gradients dominate a term
 * whose entire job is to say "you are high up on a long wave".
 *
 * σ-RELATIVE ON BOTH SIDES (§V.36): `crestBiasSigma` is in σ(λ−) per σ(h), so
 * it means the same thing in calm and storm and cannot become an absolute
 * metre constant that silently changes meaning when the sea state moves — the
 * §B.12 failure this project has now paid for four times. `crestHeightThreshold`
 * in sprayMath is the same quantity as a HARD gate; foam needs a soft bias
 * because it is a continuous field, but both are multiples of `heightRms` and
 * both move together when the sea does.
 */
export function crestBiasPerMetre(
  crestBiasSigma: number,
  traceRms: number,
  choppiness: number,
  heightRms: number,
): number {
  if (!Number.isFinite(crestBiasSigma) || crestBiasSigma <= 0) return 0;
  if (!Number.isFinite(heightRms) || heightRms <= 0) return 0;
  const sigma = eigenSigma(traceRms, choppiness);
  if (!(sigma > 0)) return 0;
  return (crestBiasSigma * sigma) / heightRms;
}

/* -------------------------------------------------------------------------
 * A CAP IS THE SIZE OF THE BAND THAT MADE IT, AND THAT IS THE BUG (§B, user:
 * "we are still very patchy on the foam cresting, we are still huge blobs",
 * docs/bugs/bug-foam-caps-huge-topdown.png — patches 1.5–2× the 35 m hull).
 *
 * MEASURED, one instant, no accumulation, no blur, no shading: the connected
 * components of {λ− < gate} in each band's own grid, extents in world metres.
 *
 *   band        wavelengths    major median    p90     max    area in >35 m
 *   cascade 0   40–1010 m         21.7 m      42.4    70.5       48.3%
 *   cascade 1   8.3–40 m           2.8 m        —      2.8        0%
 *   cascade 2   ≤8.3 m             0.2 m       0.5     1.2        0%
 *
 * NOTHING DOWNSTREAM GROWS THEM. The accumulator, the blur, `capVariation`
 * and the dissolve were each ruled out by probe (turning `capVariation` off
 * moved the shaded >35 m area share from 69.0% to 68.6%). Cascade 0 is BORN at
 * 20–70 m, because a super-level set of a band-limited field has that band's
 * own scale: a field whose shortest wavelength is 40 m cannot have a 3 m
 * feature. And at the zoomed-out framing where the user sees this, the two
 * bands that DO make metre-scale caps are band-limited away — cascade 2 has no
 * filtered tier at all and retires outright, cascade 1 falls to its 0.76 m
 * tier. What survives to a wide shot is the one band that cannot make a small
 * cap.
 *
 * THE CURE IS A PER-TEXEL GATE JITTER AT METRE SCALE — §B.39's dissolve, one
 * stage upstream. Instead of breaking the SILHOUETTE of a finished mask, break
 * the REGION THAT IS ALLOWED TO FIRE, so a 40 m breaking zone deposits foam in
 * metre-scale islands inside itself. It is zero-mean in σ(λ−), so a
 * hard-breaking core outruns it and only the marginal SKIRT — which is what
 * makes the patches huge — is carved up. Measured on the shaded mask at the
 * screenshot's own 0.6 m/px:
 *
 *                          caps   major median   p90     max    area >35 m
 *   before                  25       1.8 m      22.3    41.3      69.0%
 *   breakup 2.5σ / 12 m     33       7.6 m      12.4    30.5       0.0%
 *
 * at 96% of the foam (mean alpha 0.0072 against 0.0075) — the user asked for
 * smaller caps, not less foam.
 * ---------------------------------------------------------------------- */

/**
 * One texel of the breakup field (GPU mirror: the `octaves > 0` block in
 * createInjectPass). Returns a roughly zero-mean value in [−1, 1]; the caller
 * scales it by `breakupSigma × σ(λ−)` and ADDS it to the metric, so a positive
 * value makes this texel harder to break.
 *
 * The domain warp is the anti-lattice half and is not optional — value noise
 * has round level sets (§B.39), so without it this bites round holes and
 * leaves round islands, which is the disc defect one stage downstream.
 */
export function breakupJitter(
  worldX: number,
  worldZ: number,
  freq: number,
  warp: number,
  octaves: number,
  drift = 0,
): number {
  if (!(octaves > 0) || !Number.isFinite(freq) || !Number.isFinite(worldX)) return 0;
  if (!Number.isFinite(worldZ) || !Number.isFinite(warp)) return 0;
  const bx = worldX * freq;
  const bz = worldZ * freq;
  const wu = (fbm2Cpu(bx * 0.35 + 11.3, bz * 0.35 - 4.1, 2) - 0.5) * warp;
  const wv = (fbm2Cpu(bx * 0.35 - 7.7, bz * 0.35 + 19.4, 2) - 0.5) * warp;
  return (fbm2Cpu(bx + wu + drift, bz + wv - drift * 0.6, octaves) - 0.5) * 2;
}

/**
 * σ of `breakupJitter`'s output, by octave count — MEASURED on the field
 * itself (400² samples), not assumed.
 *
 * It is nowhere near the ±1 the range suggests: an fbm of value noise is
 * strongly peaked at its mean, and each added octave narrows it further. This
 * matters because the jitter's variance ADDS to the metric's, and the gate is
 * a multiple of that metric's σ (§V36) — see `metricSigmaScale`.
 */
export const BREAKUP_JITTER_SD: readonly number[] = [0, 0.451, 0.338, 0.297, 0.279];

/**
 * How much WIDER the injection metric's distribution is than λ−'s own, once
 * the zero-mean cross-band bias and breakup terms are added to it.
 *
 * THIS IS §V.36 CATCHING ITSELF. Both terms are zero-mean, so they leave the
 * metric's MEAN alone and quietly widen its SPREAD — and every gate here is
 * expressed as a multiple of that spread. Without this correction the shipped
 * 2.5σ breakup measured 2.8× the firing area on a gaussian fixture: not
 * "more foam because the sea is breaking more", but a threshold that changed
 * meaning because the thing underneath it got wider. Exactly the failure the
 * per-cascade gate was built to end, reintroduced one term later.
 *
 * Variances add because the three fields are independent by construction (λ−
 * is this band's gradients, the bias is the OTHER bands' elevation, the jitter
 * is a procedural field keyed on world position).
 *
 * `crestBiasSigma` is stated per σ of SEA elevation while the term actually
 * carries the other bands' elevation, so this is an UPPER BOUND for cascade 0
 * — whose "other bands" are the small ones — and near-exact for the finer
 * cascades, whose other bands are dominated by the swell. Erring wide makes a
 * band fire slightly LESS than asked, which is the safe direction for a
 * threshold that used to fire 2.8× too often.
 */
export function metricSigmaScale(
  crestBiasSigma: number,
  breakupSigma: number,
  octaves: number,
): number {
  const c = Number.isFinite(crestBiasSigma) ? Math.max(0, crestBiasSigma) : 0;
  const b = Number.isFinite(breakupSigma) ? Math.max(0, breakupSigma) : 0;
  const sd = BREAKUP_JITTER_SD[Math.min(BREAKUP_JITTER_SD.length - 1, Math.max(0, octaves | 0))];
  return Math.sqrt(1 + c * c + (b * sd) ** 2);
}

/* -------------------------------------------------------------------------
 * THE BREAKUP TRADED SHAPE FOR SIZE, AND SHAPE WAS THE THING (§B, user: "the
 * caps still look a little bit weird... maybe we shouldn't only measure the
 * area but also its SHAPE — take a look that its shape is actually starting to
 * reflect the structure of the water").
 *
 * MEASURED on connected components of the fired region, at matched coverage.
 * ASPECT is √(λ₁/λ₂) of the second-moment matrix; ALIGN is cos(2Δθ) between a
 * cap's major axis and the local crest LINE, both as directors; CIRC is
 * 4πA/P², which is 1 for a disc:
 *
 *                              p90 major   aspect   align   circ
 *   λ− alone, no breakup          53.9 m    2.48    +0.96   0.49
 *   + isotropic noise breakup     30.0 m    1.73    +0.52   0.49
 *   + finer cascades' own λ−      11.6 m    1.73    −0.01   0.50
 *   + noise in the CREST FRAME    28.5 m    2.62    +0.63   0.36
 *
 * TWO RESULTS, BOTH SURPRISES. First: λ− was ALREADY producing crest-following
 * ribbons — align +0.96, aspect 2.48 — which is §V.58's fix working exactly as
 * designed, and the isotropic breakup HALVED it while hitting its size target.
 * Optimising one statistic damaged the one nobody was watching. Second: driving
 * the breakup from the finer cascades — the intuitive reading of "influenced by
 * all the different sub-tessellations" — is the WORST option on the board. Each
 * finer band folds along ITS OWN propagation direction, uncorrelated with the
 * big crest, so using it as a breakup field stamps a second unrelated
 * orientation over the first and randomises the result.
 *
 * ⟹ the breakup field is sampled in the LOCAL CREST FRAME, stretched along the
 * crest line, so it cuts a ribbon into shorter ribbons instead of eroding it
 * into discs.
 * ---------------------------------------------------------------------- */

/**
 * Unit vector along the local CREST LINE, from the structure tensor of ∇h
 * (GPU mirror: the tensor ring in createInjectPass). Returns the crest
 * direction itself, so a caller stretches its sample coordinate along it.
 *
 * WHY A STRUCTURE TENSOR AND NOT THE GRADIENT, AND WHY NOT λ−'s EIGENVECTOR.
 * Two dead ends had to be ruled out first and a future reader should not
 * "simplify" this back into either of them:
 *
 *  - λ−'s own eigenvector is the natural answer and it is UNREACHABLE. It needs
 *    the SIGN of ∂Dx/∂z, and §V.58 records that the off-diagonal term is never
 *    reconstructed because it only ever appears squared (inside det J).
 *    `derivatives` is full and so is `displacement`, so there is no slot to
 *    publish it in without an ocean change.
 *  - raw ∇h is worse than useless ON a crest, which is the only place this is
 *    asked: foamMath's own note is that "∇h vanishes and flips sign ON the
 *    crest line". A per-texel gradient there is numerical noise with a sign.
 *
 * The tensor answers a BETTER-POSED question. It is quadratic in ∇h, so it
 * yields a DIRECTOR — an axis with no head or tail — and the sign §V.58 calls
 * unreconstructable is not needed at all rather than worked around. And because
 * it is accumulated over a RING around the texel rather than at it, it samples
 * the flanks where ∇h is large and informative instead of the crest line where
 * it vanishes. Both properties are the reason it is correct, not merely
 * convenient.
 *
 * `jxx`/`jzz`/`jxz` are Σ(∂h/∂x)², Σ(∂h/∂z)², Σ(∂h/∂x·∂h/∂z) over that ring.
 * Its dominant eigenvector points ACROSS the crest (the propagation axis), so
 * the crest line is the other one — a quarter turn, which in doubled-angle
 * form is a negation.
 */
export function crestFrame(
  jxx: number,
  jzz: number,
  jxz: number,
): { cos: number; sin: number } {
  const dx = jxx - jzz;
  const dy = 2 * jxz;
  const r = Math.hypot(dx, dy);
  // an isotropic neighbourhood (flat water, or a perfectly symmetric peak) has
  // NO crest direction; return the x axis rather than dividing by zero (§V28)
  if (!(r > 1e-20) || !Number.isFinite(r)) return { cos: 1, sin: 0 };
  // doubled angle of the PROPAGATION axis, turned a quarter to the crest line
  const c2 = -dx / r;
  const s2 = -dy / r;
  // half-angle, so no atan2/cos/sin round trip. sign(0) must read +1, or a
  // crest exactly on the z axis collapses to a zero-length frame.
  const cos = Math.sqrt(Math.max(0, (1 + c2) * 0.5));
  const sin = Math.sqrt(Math.max(0, (1 - c2) * 0.5)) * (s2 < 0 ? -1 : 1);
  return { cos, sin };
}

/**
 * Radius of the structure-tensor ring, IN TEXELS, from the band's own shortest
 * wavelength — the §V.36 rule (state a length in the units of the thing it
 * measures, never in the units of the grid that happens to hold it) applied to
 * a filter radius.
 *
 * IT HAS A REAL OPTIMUM AND IT IS NOT SMALL. Measured, as the agreement between
 * the tensor's director and the one λ− implies, over FIRING texels only:
 *
 *   ring radius (of a 40–400 m band)   1     2     4     8    16    32  cells
 *   agreement                        0.374 0.497 0.855 0.874 0.564 −0.127
 *
 * Both ends fail for opposite reasons. Too SMALL and all eight taps see nearly
 * the same gradient, so the tensor degenerates to rank one — it becomes the raw
 * gradient, which is precisely the quantity that vanishes and flips sign ON the
 * crest line. Too LARGE and the ring spans past the neighbouring crest and
 * averages two unrelated directions, which is why 32 cells reads NEGATIVE. The
 * plateau sits near a third of the band's shortest wave, where the taps straddle
 * one crest: the up-face and down-face gradients are opposite VECTORS but the
 * same DIRECTOR, so being quadratic the tensor adds them coherently.
 *
 * Verified against a single 100 m mode, where the answer is analytic: 0.993 at
 * one cell, 1.000 at four. The construction is exact; only the radius was wrong.
 */
export function tensorRadiusTexels(
  bandShortestMetres: number,
  texelMetres: number,
  maxTexels = 12,
): number {
  if (!Number.isFinite(bandShortestMetres) || !Number.isFinite(texelMetres)) return 1;
  if (!(texelMetres > 0)) return 1;
  const wanted = Math.round(Math.max(0, bandShortestMetres) / 3 / texelMetres);
  return Math.min(maxTexels, Math.max(1, wanted));
}

/**
 * `breakupJitter` sampled in the crest frame, stretched `elongation` along the
 * crest line (GPU mirror: the same block). Stretching the COORDINATE along the
 * crest stretches the FEATURES along it, so the field cuts ACROSS a cap at
 * intervals — shorter ribbons — instead of biting isotropic holes in it.
 */
export function breakupJitterAligned(
  worldX: number,
  worldZ: number,
  frame: { cos: number; sin: number },
  elongation: number,
  freq: number,
  warp: number,
  octaves: number,
  drift = 0,
): number {
  const e = Number.isFinite(elongation) ? Math.max(1, elongation) : 1;
  const along = (worldX * frame.cos + worldZ * frame.sin) / e;
  const across = -worldX * frame.sin + worldZ * frame.cos;
  return breakupJitter(along, across, freq, warp, octaves, drift);
}

/* -------------------------------------------------------------------------
 * THE SECOND HALF OF THE TWO-CLOCK FIX (§B, user: "we're still missing a bunch
 * of transparency").
 *
 * `75bc563` split the mask into a residue and a breaking RATE so it would
 * encode breaking INTENSITY rather than dwell time. It then threw that
 * intensity away one stage later, and the arithmetic is not subtle:
 * `breakingGain` is 6.19 at the shipped clocks, the channel is clamped to 1 in
 * the TEXTURE, and the mask was clamped to 1 again in the composite — so `raw`
 * reached 1 whenever breaking exceeded 0.161, i.e. at a deficit of 0.19σ, while
 * the mean excess beyond the 2.56σ gate is 0.36σ. THE TYPICAL FIRING TEXEL
 * SATURATED. Worked through at cascade 0's shipped numbers, the residue channel
 * settles at 1.86 for that texel and is clipped by its own accumulator too.
 *
 * So a marginal breaker and a violent one arrived at the same flat alpha 0.9,
 * which is the "big white patch" and the missing translucency in one defect —
 * and it is the very failure the two clocks were introduced to end, moved one
 * stage downstream.
 *
 * TWO CHANGES, both required. The accumulator ceiling goes above 1 so the
 * channel can still RANK breakers past that point, and the composite becomes a
 * soft saturation instead of a clamp: coverage = 1 − e^(−depth), which is what
 * a union of independent overlapping foam patches of areal density `depth`
 * actually is. It is monotone everywhere, so ordering survives at every
 * intensity, and it approaches 1 without ever flattening onto it.
 *
 * Worked at cascade 0's shipped numbers, alpha for a
 *   marginal breaker (0.05σ deficit): 0.10
 *   typical  breaker (0.36σ):         0.55
 *   violent  breaker (1.50σ):         0.95
 * against a flat 0.90 for all three before.
 * ---------------------------------------------------------------------- */

/**
 * Visible coverage from optical depth: 1 − e^(−density·depth).
 *
 * Never clips, so a violent breaker and a marginal one stay distinguishable at
 * every intensity — which is the whole point (see above). `density` is how
 * opaque one unit of accumulated foam is; it is what sets where the typical
 * cap sits on the curve, and it is a look knob rather than a derived quantity.
 */
export function foamCoverage(depth: number, density: number): number {
  if (!Number.isFinite(depth) || depth <= 0) return 0;
  const d = Number.isFinite(density) ? Math.max(0, density) : 0;
  return 1 - Math.exp(-d * depth);
}

/**
 * How many octaves of the breakup field a cascade can actually HOLD.
 *
 * §V.48 AGAINST THE SIM GRID INSTEAD OF THE SCREEN, and it is the same rule
 * for the same reason. A StorageTexture carries no mip chain and the inject
 * pass writes it at texel centres, so an octave whose cell is narrower than
 * two texels is written as pure aliasing — and unlike a fragment-stage octave
 * there is no `fwidth` to measure it against and no filtered tier downstream
 * to catch it. The limit is the cascade's OWN sampling rate.
 *
 * This is also why the field is expressed as a world LENGTH: each band then
 * takes as much of it as its texels can carry (2 octaves in cascade 0's 1.97 m
 * grid, 4 in cascade 1's 0.19 m one) instead of every band being handed the
 * same octave count and the coarse one aliasing (§V.36's rule, applied to a
 * noise field rather than a threshold).
 */
export function breakupOctaves(
  breakupMetres: number,
  texelMetres: number,
  maxOctaves = 4,
): number {
  if (!Number.isFinite(breakupMetres) || !Number.isFinite(texelMetres)) return 0;
  if (!(breakupMetres > 0) || !(texelMetres > 0)) return 0;
  let n = 0;
  while (n < maxOctaves && breakupMetres / 2 ** n >= 2 * texelMetres) n++;
  return n;
}

/**
 * Standard normal CDF, via the Abramowitz & Stegun 7.1.26 erf approximation
 * (|ε| < 1.5e-7) — enough for a band's mean coverage, which is a fade target
 * and not a threshold.
 */
export function normalCdf(z: number): number {
  if (!Number.isFinite(z)) return Number.isNaN(z) ? 0.5 : z > 0 ? 1 : 0;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  const erf = z >= 0 ? y : -y;
  return 0.5 * (1 + erf);
}

/**
 * E[max(0, gate − X)] for X ~ N(mean, sd) — the mean per-tick injection a band
 * produces, in closed form rather than by reading the texture back.
 *
 * σ·(φ(z) + z·Φ(z)) with z = (gate − mean)/σ: the standard partial expectation.
 * Exact for a gaussian λ−, which is what the EIGEN_* constants describe.
 */
export function expectedDeficit(gate: number, mean: number, sd: number): number {
  if (!Number.isFinite(gate) || !Number.isFinite(mean)) return 0;
  if (!Number.isFinite(sd) || sd <= 0) return Math.max(0, gate - mean);
  const z = (gate - mean) / sd;
  const phi = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  return sd * (phi + z * normalCdf(z));
}

/**
 * The MEAN foam a band settles at — what an infinitely-distant pixel of that
 * band should see (§V.70), derived rather than sampled.
 *
 * WHY IT HAS TO EXIST AT ALL. `tierWeight` retires a band as its texels go
 * sub-pixel and the comment said "fading to nothing IS the average of a field
 * whose features are far below one pixel". That is true of a SLOPE field, whose
 * mean is zero, and false of a COVERAGE field, whose mean is its coverage —
 * §V.70's own diagnostic (ask what ONE infinitely-distant pixel sees) answers
 * "the average of the two levels", not "the lower one". Cascade 2 has no
 * filtered tier at all, so it was faded to zero outright: half a sea's worth of
 * real foam deleted rather than filtered, which is exactly the variance §V.64
 * forbids throwing away.
 *
 * Steady state is inject-then-decay, so a channel settles at I·decay/(1−decay)
 * with I the mean per-tick injection (breakingGain carries the same ordering).
 */
export function expectedBandFoam(
  gate: number,
  injectPerStep: number,
  traceRms: number,
  choppiness: number,
  decay: number,
  /** the accumulator's ceiling — no longer 1, see "THE SECOND HALF" above */
  ceiling = 1,
): number {
  if (!Number.isFinite(injectPerStep) || injectPerStep <= 0) return 0;
  if (!Number.isFinite(decay) || decay <= 0 || decay >= 1) return 0;
  const sd = eigenSigma(traceRms, choppiness);
  const mean = eigenRestValue(traceRms, choppiness);
  const perTick = injectPerStep * expectedDeficit(gate, mean, sd);
  const cap = Number.isFinite(ceiling) && ceiling > 0 ? ceiling : 1;
  return Math.min(cap, (perTick * decay) / (1 - decay));
}

/* -------------------------------------------------------------------------
 * WHY THERE IS NO ADVECTION PASS, AND WHY THE OBVIOUS ARGUMENT FOR ONE IS
 * BACKWARDS. Written down because it has now been reasoned about twice, from
 * opposite ends, and both times the conclusion was reached without this step.
 *
 * The tempting reading of the half-life sweep above is: "foam is smeared
 * because it sits still while the wave FORM travels through it at 8–17 m/s, so
 * transport it". The wave form does travel through it — that observation is
 * correct and it IS what the sweep measures. The conclusion does not follow.
 *
 * The foam textures are indexed by the UNDISPLACED grid coordinate q, and the
 * surface point drawn for q is q + D(q,t). For a linear deep-water mode the
 * excursion of a water PARTICLE about its mean position is exactly
 * (−a·sin θ, a·cos θ) with θ = k·x − ωt, and Tessendorf's choppy displacement
 * evaluates to precisely that: h = a·cos θ and Dx = −a·sin θ. This model IS
 * the Gerstner/Lagrangian description of the surface, so q is a MATERIAL
 * LABEL: the water particle labelled q stays q for all time, and foam pinned
 * to q is ALREADY advected with the water, exactly and for free.
 *
 * A semi-Lagrangian advection pass would therefore move foam ACROSS the water
 * it is floating on. A whitecap being left behind by its own crest is what
 * real foam does. The sea read wrong not because the residue ends up in the
 * trough but because the residue and the ACTIVE breaker were drawn with the
 * same value — which is what the two channels above fix, without transporting
 * anything.
 *
 * Stokes drift is the one genuine transport this leaves out and it is second
 * order: ~1–2% of the phase speed, ≈1 m over a 3 s life against caps metres
 * across. Not the mechanism, and not worth a pass.
 * ---------------------------------------------------------------------- */

/**
 * 3×3 gaussian weights (1 2 1 / 2 4 2 / 1 2 1)/16, row-major. Sum is exactly
 * 1 so the blur redistributes foam without creating or destroying any —
 * foam lifetime must be controlled ONLY by the decay factor, or the
 * decayHalfLife param would lie (§V6 progressive blur).
 */
export const GAUSSIAN_3X3: readonly number[] = [
  1 / 16, 2 / 16, 1 / 16,
  2 / 16, 4 / 16, 2 / 16,
  1 / 16, 2 / 16, 1 / 16,
];

/** wrap a texel index into [0, n) — cascade foam tiles with its domain (§V6) */
export function wrapIndex(i: number, n: number): number {
  return ((i % n) + n) % n;
}

/**
 * One texel of the decay+blur pass on an n×n wrapped grid (GPU mirror:
 * blurDecayPass): mix(src, blur3x3(src), blurMix) · decay, taps offset by
 * `radius` texels.
 *
 * `blurMix` (default 1 = the historical full-strength kernel) is what makes
 * the diffusion a WORLD quantity instead of a grid one — see blurMixPerStep.
 * Mixing the identity with the gaussian is still a normalised kernel
 * ((1−w)·δ + w·G sums to exactly 1) and still axis-aligned, so exact mass
 * conservation and shift-invariance are untouched; only the RATE changes.
 */
export function blurDecayAt(
  src: Float32Array,
  n: number,
  x: number,
  y: number,
  radius: number,
  decay: number,
  blurMix = 1,
): number {
  const w = Math.min(1, Math.max(0, blurMix));
  let sum = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const sx = wrapIndex(x + Math.round(dx * radius), n);
      const sy = wrapIndex(y + Math.round(dy * radius), n);
      sum += src[sy * n + sx] * GAUSSIAN_3X3[(dy + 1) * 3 + (dx + 1)] * w;
    }
  }
  sum += src[y * n + x] * (1 - w);
  return Math.min(1, sum * decay);
}

/* -------------------------------------------------------------------------
 * THE BLUR WAS THE SHAPE, AND IT WAS A GRID QUANTITY (§B, user 5×: "the caps
 * are round dots"; measured from a near-vertical camera, docs/bug-foam-
 * topdown.jpeg).
 *
 * λ− fixed the INJECTION — measured on the real spectrum at full resolution,
 * one injected cap is aspect 3.0–3.3 with 18–59° of axial spread. What reaches
 * the screen is not that cap. An ISOTROPIC diffusion adds the SAME variance to
 * both axes, so aspect(n) = √((σa²+nv)/(σb²+nv)) → 1 MONOTONICALLY, and it is
 * fast: a 2.09 cap is at 1.43 after ten steps and 1.03 after 270. No injected
 * anisotropy survives an unbounded diffusion; that is what diffusion IS.
 *
 * The reason it went unbounded is that `blurRadius` is in TEXELS, so the world
 * diffusion rate is a property of the GRID:
 *
 *   band  domain   texel     age-weighted blur σ    injected σ_min   ratio
 *   c0    1010 m   1.973 m       12.27 m               2.65 m        4.63×
 *   c1      98 m   0.191 m        1.19 m               0.72 m        1.66×
 *   c2     22.7 m  0.044 m        0.28 m                  —            —
 *
 * (swell preset, 256² mirror of the real IFFT field, blur σ over the
 * decay-weighted mean age r/(1−r) = 77.4 ticks at decayHalfLife 0.9 s.)
 *
 * So cascade 0 — the band that covers the whole sea — spent 4.6 σ of isotropic
 * diffusion on a cap 2.65 m wide and turned it into a 35 m disc: measured
 * steady-state aspect 1.32, σmaj 17.2 m, against an injected 3.32 / 8.84 m.
 * THREE cascades × three texel sizes is also literally "circles of a few
 * discrete sizes": 28.9 m / 2.8 m / 0.6 m FWHM, one per band.
 *
 * Foam spreading is one physical process and has ONE world rate. Express the
 * diffusion as a LENGTH in metres and let each band solve for its own per-tick
 * kernel weight — §V.36's rule (state a threshold in the units of the thing it
 * measures, never in the units of the grid that happens to hold it) applied to
 * a diffusion instead of a threshold.
 * ---------------------------------------------------------------------- */

/**
 * Decay-weighted mean age of visible foam, in sim ticks: foam of age n carries
 * weight decay^n, so E[n] = r/(1−r). This is the number of blur steps the foam
 * you can actually SEE has been through — not the lifetime, which is unbounded.
 */
export function meanFoamAgeTicks(decay: number): number {
  if (!Number.isFinite(decay) || decay <= 0) return 0;
  if (decay >= 1) return Infinity;
  return decay / (1 - decay);
}

/**
 * Per-tick kernel weight that makes the ACCUMULATED blur reach `spreadMetres`
 * of σ over the foam's mean visible age, in a band whose texel is
 * `texelMetres` — the same number in every band, so the sea stops carrying one
 * disc size per cascade.
 *
 * A 1-D (1,2,1)/4 kernel at a tap offset of `radius` texels has variance
 * 0.5·radius² texels²; mixing it with the identity at weight w gives exactly
 * w× that (the identity contributes zero second moment). Over `age` ticks the
 * variances add, so w = spread² / (age · 0.5 · radius² · texel²), clamped to
 * [0,1] — a band whose texels are already coarser than the target spread
 * simply cannot reach it and stops at 1 (which is the old behaviour).
 */
export function blurMixPerStep(
  spreadMetres: number,
  texelMetres: number,
  radius: number,
  ageTicks: number,
): number {
  const perStep = 0.5 * radius * radius * texelMetres * texelMetres;
  if (!(perStep > 0) || !(ageTicks > 0) || !Number.isFinite(ageTicks)) return 0;
  // NaN fails every comparison, so `Math.max(0, NaN)` is NaN — guard the
  // numerator explicitly or one bad uniform poisons the kernel weight (§V28)
  if (!Number.isFinite(spreadMetres)) return 0;
  const w = (Math.max(0, spreadMetres) ** 2) / (ageTicks * perStep);
  return Math.min(1, Math.max(0, w));
}

/* -------------------------------------------------------------------------
 * REMOVED, ON PURPOSE: the crest-aligned (anisotropic) blur frame.
 *
 * `crestTapOffset` / `blurDecayAnisoAt` rotated the 3×3 taps into a crest
 * frame and stretched them 2.6 along the ridge / 0.5 across it. The frame was
 * ONE GLOBAL VECTOR (wave propagation ≈ wind) for the entire ocean, chosen so
 * the kernel stayed shift-invariant and provably conserved foam. The
 * conservation argument was correct. The picture it produced was not:
 * repeated ~270× over a cap's life, a diffusion tensor with a 5.2:1 axis
 * ratio in ONE world direction is not a shape hint, it is the shape — every
 * cap in the frame became the same ellipse at the same angle.
 *
 * MEASURED (CPU mirror, real swell spectrum, cascade 0, 300 frames):
 *   with the aniso frame:  cap axial-angle spread 3.9°, aspect 3.18
 *   isotropic:             cap axial-angle spread 9.7°, aspect 1.78
 *   isotropic + λ− inject: cap axial-angle spread 21.4°, aspect 2.09
 * — i.e. once the INJECTION carries the shape (λ−, above), the blur has
 * nothing left to add and everything to flatten. Its elongation is now the
 * sea's own, so it varies across the frame, which is the whole point.
 *
 * The isotropic kernel is shift-invariant too, so nothing was traded away:
 * `blurDecayAt` conserves mass exactly and `decayHalfLife` remains the only
 * thing that removes foam (§V6). Do not reintroduce a global direction here —
 * a per-texel one is worse (∇h vanishes and flips sign ON the crest line) and
 * a global one is the bug. Anisotropy belongs to the injection.
 * ---------------------------------------------------------------------- */

/* -------------------------------------------------------------------------
 * THE DISSOLVE (§T.5 stage 3). CPU mirror of foamShading's coverage gate.
 *
 * Every foam pass before this one modulated the INTERIOR of a patch and left
 * its OUTLINE alone, and the outline is what the eye reads. That outline was a
 * super-level set of an isotropic gaussian blur — a circle by construction,
 * see "THE BLUR WAS THE SHAPE" above — so a textured patch was still a disc,
 * which is the standing "blotchy, reads as discs" report.
 *
 * Here the gate's THRESHOLD is a per-texel sample of the art texture instead
 * of a constant, so the outline is that texture's torn contour. The threshold
 * field is uniform on [0,1] by construction (foamPattern.rankNormalise), which
 * is what makes the two properties below true rather than fitted.
 * ---------------------------------------------------------------------- */

/**
 * One pixel of the dissolve gate.
 *
 * `threshold01` is the art texture's breakup sample, `resolved` is 1 while its
 * cells still span ≥ 2 px and 0 once they are sub-pixel, `maskFwidth` is
 * `fwidth(mask)`.
 *
 * TWO invariants this exists to pin, both asserted in tests/foam.test.ts:
 *
 *   1. `erodeDepth = 0` reproduces the pre-art-texture gate BIT FOR BIT
 *      (`smoothstep(kneeLow, kneeHigh, mask)`), so turning the art texture on
 *      is a clean A/B rather than a rewrite.
 *
 *   2. `resolved = 0` is the SUB-PIXEL LIMIT OF THE GATE, not of the field.
 *      A uniform threshold on [0, d] passes a texel of mask m with probability
 *      m/d, so what a pixel that no longer resolves the field should see is a
 *      RAMP OF WIDTH d — and that is what widening `softness` to d gives.
 *      Fading the threshold field to its OWN mean (0.5, exactly) instead would
 *      leave the same narrow step sitting at a shifted threshold: a fade to a
 *      hard edge, which is precisely the mistake §V.48(b) exists to name.
 *
 *      It is a LIMIT, not an identity, and the residual is stated rather than
 *      hidden: this gate eases cubically where the true average is a box
 *      convolved with a ramp, so it differs from the exact pixel average by at
 *      most 0.045 of alpha (measured over the whole mask range at the shipped
 *      knee and erodeDepth 0.45). Support and both endpoints are exact. The
 *      naive alternative is out by 0.403 — nine times worse and in the middle
 *      of the ramp, where all the coverage is. The test asserts BOTH numbers
 *      so the choice cannot be quietly reversed.
 */
export function dissolveKnee(
  mask: number,
  threshold01: number,
  kneeLow: number,
  kneeHigh: number,
  erodeDepth: number,
  resolved: number,
  maskFwidth = 0,
): number {
  const d = Math.min(1, Math.max(0, erodeDepth));
  const r = Math.min(1, Math.max(0, resolved));
  const t = kneeLow + Math.min(1, Math.max(0, threshold01)) * d * r;
  // ADDED to the authored width, not maxed against it: the full-resolution
  // gate is itself a ramp of width (kneeHigh − kneeLow), so the average of it
  // over a uniform threshold spanning d has support d + that — a box
  // convolved with a ramp. Taking the max instead leaves the sub-pixel gate
  // NARROWER than the thing it is meant to be the average of, and the error
  // goes from 0.045 of alpha to 0.196.
  const softness = Math.max(
    Math.max(0, kneeHigh - kneeLow) + d * (1 - r),
    Math.max(0, maskFwidth) * 2,
    1e-4,
  );
  const x = (mask - t) / softness;
  const c = x < 0 ? 0 : x > 1 ? 1 : x;
  return c * c * (3 - 2 * c);
}

/**
 * THE WAVE SHAPE CARVED INTO THE FOAM — GPU mirror: `surfaceLift` in
 * `foamShading.foamDetailMask`. Returns the art-texture UV OFFSET, in texture
 * repeats, that the wave surface displaces the whole foam lookup by.
 *
 * User: the layers are "not properly … decimated by the tips of the wave".
 * They were not, at all — the foam shading consulted NOTHING about the surface
 * it sat on, so its tearing was statistically independent of the geometry and
 * it read as a decal. `lift` is the local elevation in units of the sea's own
 * RMS, and displacing the lookup by it ties every hole, tendril and lace break
 * to the wave under it: the same crest carries the same tear as it moves.
 *
 * ── WHY A DISPLACEMENT AND NOT A THINNING, WHICH IS WHAT WAS TRIED FIRST ──
 *
 * The obvious form is to raise the dissolve threshold on tips and lower it in
 * troughs — `clamp(breakup + a·lift)` — and it LOOKS coverage-neutral: the
 * breakup field is exactly uniform on [0,1] (rankNormalise) and elevation is
 * symmetric about zero, and E[clamp(U+a)] + E[clamp(U−a)] = 1 for every a, so
 * the field's MEAN really is preserved.
 *
 * The mean of the field is not the coverage. Coverage is E[g(field)] for the
 * gate g, and g is a step-like function that lives entirely in the BOTTOM of
 * the range — at a mask of 0.02 with the shipped knee only the lowest 6.8% of
 * the field passes. Down there the clamp at zero is a one-sided atom: a
 * negative lift piles mass onto "passes", a positive lift cannot take mass
 * below "already zero", so coverage is CONVEX in the shift and Jensen makes
 * any symmetric carve gain. MEASURED with the real gate: 0.0589 against
 * 0.0172, i.e. the residue skirt would have got 3.4× more foam — the "dirty
 * beige smudge" `residueKneeLow` exists to kill — while the change was
 * described as a shape fix. This is the same atom that `foamShading`'s
 * `threshold` paragraph rejected a signed threshold shift over, reached from
 * the other side, and it generalises: NO smooth symmetric perturbation of a
 * clamped threshold is coverage-neutral, because the response is convex at the
 * end where the clamp is.
 *
 * A DISPLACEMENT HAS NO SUCH PROBLEM, and the guarantee is exact rather than
 * tuned: moving where the texture is sampled is a MEASURE-PRESERVING
 * REARRANGEMENT of the plane, so the distribution of threshold values is
 * bit-for-bit what it was and coverage is unchanged at EVERY mask value and
 * EVERY parameter setting, not merely on average.
 *
 * ADDITIVE, never multiplicative, and that is the whole lesson of the ring bug
 * one file over: a term that SCALES a world coordinate picks up |worldXZ| as a
 * lever arm on its derivative. A translation's derivative is just ∂lift/∂x,
 * which the wave itself band-limits (~2σ over a ~50 m wavelength ⇒ 0.012 UV/m
 * against the crest lookup's own 0.167 UV/m, a 7% warp).
 *
 * The lift is clamped to ±2σ first: a rogue crest must not be able to drag the
 * lookup a whole repeat, and past 2σ the carve is saturated anyway.
 */
/**
 * THE BODY of the foam composite — GPU mirror: `textured` → `sheeted` in
 * `foamShading.foamDetailMask`. Returns the multiplier the interior of a foam
 * patch gets, given the two art-texture taps at this texel.
 *
 * WHY THIS HAS A CPU MIRROR AT ALL. The body is a MULTIPLY ON THE FOAM ALPHA,
 * so its mean over the texture IS foam coverage — the one quantity six user
 * reports have been arguing about, and the one 57269ca caught a shape change
 * moving from 0.500 to 0.590 while claiming not to. Two of the terms here
 * (handing a saturated raft to the broader tap, and keeping some of its
 * structure through the flatten) would each have moved it, so both are
 * re-centred and `tests/foam.test.ts` integrates this over the REAL texture to
 * prove the mean did not move.
 *
 * `crestMean`/`softMean` are the channels' own measured means
 * (foamPattern.FOAM_*_MEAN) and are what everything is re-centred against.
 */
export function foamBodyLevel(
  softTap: number,
  crestTap: number,
  /** the age blend the DISSOLVE uses — the level the body must keep */
  freshness: number,
  /** the age blend the body actually samples with (torn + broadened) */
  bodyBlend: number,
  /** sheetN · sheetFlatten */
  flat: number,
  /** sheetKeep */
  keep: number,
  crestMean: number,
  softMean: number,
): number {
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  const blendMean = lerp(softMean, crestMean, bodyBlend);
  const bodyMean = lerp(softMean, crestMean, freshness);
  // re-centred: the broad tap's PATTERN at the fresh tap's LEVEL
  const textured = lerp(softTap, crestTap, bodyBlend) - blendMean + bodyMean;
  const f = Math.min(1, Math.max(0, flat));
  const k = Math.min(1, Math.max(0, keep));
  // flatten toward the sheet, then add back a ZERO-MEAN share of the structure
  // the flatten removed — a thick raft is more foam, not a different material
  return lerp(textured, 1, f) + f * k * (textured - bodyMean);
}

export function waveCarveOffset(lift: number, tipCarve: number): number {
  if (!Number.isFinite(lift) || !Number.isFinite(tipCarve)) return 0;
  const l = Math.min(2, Math.max(-2, lift));
  return l * Math.max(0, tipCarve);
}

/**
 * One texel of the box-reduction pass (GPU mirror: createReducePass): the
 * plain MEAN of the factor×factor source block. Mean, not sum and not a
 * weighted kernel — the far tier must be the same foam, band-limited, or
 * distant water would silently darken or blow out relative to near water.
 */
export function boxReduceAt(
  src: Float32Array,
  srcN: number,
  x: number,
  y: number,
  factor: number,
): number {
  let sum = 0;
  for (let dy = 0; dy < factor; dy++) {
    for (let dx = 0; dx < factor; dx++) {
      sum += src[(y * factor + dy) * srcN + (x * factor + dx)];
    }
  }
  return sum / (factor * factor);
}

/**
 * World size of one foam texel for a cascade: its tiling domain over the sim
 * resolution. This is the quantity every distance fade below is expressed in,
 * so changing a domain or the resolution re-derives the fades automatically
 * instead of silently invalidating a metre constant (§V36's lesson applied to
 * a distance gate).
 */
export function foamTexelMetres(domain: number, resolution: number): number {
  return domain / Math.max(1, resolution);
}

/**
 * Weight for a foam tier at a measured sampling rate: 1 while one texel still
 * covers `keepPixels` pixels, ramping to 0 as it goes sub-pixel.
 * GPU mirror: the `tierWeight` closure in index.shadingNode.
 *
 * WHY THE ARGUMENT IS A PIXEL FOOTPRINT AND NOT A CAMERA DISTANCE. It used to
 * be a distance, with the camera's angular pixel size and the Nyquist margin
 * folded into one dimensionless `fadeTexels`. That constant is only valid for
 * one viewing geometry: a pixel's world footprint grows with distance AND with
 * the grazing angle, and from a high camera the grazing term dominates.
 * Measured in-browser at 300 m altitude: one pixel covered 0.234 m of sea
 * against a 0.191 m cascade-1 texel — already past Nyquist — while the
 * distance ramp (2300 texel widths) did not begin retiring that band until
 * 440 m. `fwidth` of the sample coordinate measures the real thing directly
 * and needs no per-shot tuning. §V.48, applied to a texture tier instead of a
 * procedural octave; the two now use the same rule and the same constant.
 */
export function tierWeightAt(
  pixelMetres: number,
  texelMetres: number,
  keepPixels: number,
  fadeSpan: number,
): number {
  const keep = Math.max(0, texelMetres) / Math.max(1, keepPixels);
  const end = keep * Math.max(1.05, fadeSpan);
  if (!(end > keep)) return pixelMetres <= keep ? 1 : 0;
  const t = Math.min(1, Math.max(0, (pixelMetres - keep) / (end - keep)));
  return 1 - t * t * (3 - 2 * t);
}
