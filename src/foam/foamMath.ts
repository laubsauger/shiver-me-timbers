/**
 * Pure CPU mirrors of the foam GPU math (§V6) — no three imports so
 * tests/foam.test.ts runs in node without a GPU. Change one side → change
 * the other (same mirror contract as deckwater/fluxMath.ts).
 */

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
): number {
  if (!bandCanFold(bandSigmaJ, seaSigmaJ)) return NEVER_INJECT_BIAS;
  const z = foamGateZ(bias, seaSigmaJ);
  if (!Number.isFinite(z)) return NEVER_INJECT_BIAS;
  return eigenRestValue(traceRms, choppiness) - z * eigenSigma(traceRms, choppiness);
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
): number {
  if (!bandCanFold(bandSigmaJ, seaSigmaJ) || !(dt > 0)) return 0;
  const sigma = eigenSigma(traceRms, choppiness);
  // 0 × Infinity is NaN, and the gate above is already NEVER_INJECT there
  if (!(sigma > MIN_BAND_JACOBIAN_SIGMA)) return 0;
  return (Math.max(0, strengthPerSecond) * dt) / sigma;
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
): number {
  const r = Math.max(0, residue) * Math.max(0, residueWeight);
  const b = Math.max(0, breaking) * Math.max(0, gain) * Math.max(0, breakingWeight);
  return Math.min(1, r + b);
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
