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
 * σ(det J of one cascade) ÷ (λ · RMS(∂Dx/∂x) of that cascade).
 *
 * det J = (1+λa)(1+λb) − (λc)² with (a,b,c) = (∂Dx/∂x, ∂Dz/∂z, ∂Dx/∂z), so
 * its spread is driven by a+b, whose spectral transfer is |k| — NOT the
 * kx²/|k| that `spectralSteepness` measures. The two differ only by a factor
 * fixed by the spectrum's DIRECTIONAL SHAPE, so one constant converts
 * between them: measured 1.79 for every cascade of every shipped preset
 * (calm/swell/storm, all three bands, spread from the live `directionality` /
 * `oppositeWaveDamp`). tests/foam.test.ts recomputes it from the real
 * spectrum and fails if a spread retune moves it — which is the whole point:
 * the alternative is a foam gate whose σ silently drifts (§V36).
 */
export const JACOBIAN_SIGMA_PER_STEEPNESS = 1.79;

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

/** bias value that provably never injects (det J ≥ 0 in any sane sea) */
export const NEVER_INJECT_BIAS = -10;

/** can this band produce a real fold, or is it float noise? (see above) */
export function bandCanFold(bandSigma: number, seaSigma: number): boolean {
  if (!Number.isFinite(bandSigma) || !Number.isFinite(seaSigma)) return false;
  if (!(seaSigma > MIN_BAND_JACOBIAN_SIGMA)) return false;
  return bandSigma > Math.max(MIN_BAND_JACOBIAN_SIGMA, DEAD_BAND_SIGMA_FRACTION * seaSigma);
}

/**
 * σ of one band's det J, from the moments the ocean already publishes:
 * `OceanCascade.steepnessRms` (at λ=1) × the effective choppiness λ actually
 * sent to the GPU × the shape constant above. Pass the sea-wide
 * `OceanSimulation.steepnessRms` to get σ of the summed jacobian.
 */
export function jacobianSigma(steepnessRms: number, choppiness: number): number {
  if (!Number.isFinite(steepnessRms) || !Number.isFinite(choppiness)) return 0;
  return JACOBIAN_SIGMA_PER_STEEPNESS * Math.max(0, steepnessRms) * Math.max(0, choppiness);
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

/** accumulate with existing foam, clamped ≤ 1 (§V6: mask feeds a mix factor) */
export function accumulateFoam(previous: number, injected: number): number {
  return Math.min(1, previous + injected);
}

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
 * blurDecayPass): blur3x3(src) · decay, taps offset by `radius` texels.
 */
export function blurDecayAt(
  src: Float32Array,
  n: number,
  x: number,
  y: number,
  radius: number,
  decay: number,
): number {
  let sum = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const sx = wrapIndex(x + Math.round(dx * radius), n);
      const sy = wrapIndex(y + Math.round(dy * radius), n);
      sum += src[sy * n + sx] * GAUSSIAN_3X3[(dy + 1) * 3 + (dx + 1)];
    }
  }
  return Math.min(1, sum * decay);
}

/** below this direction magnitude the crest frame is undefined */
export const CREST_GRAD_EPS = 1e-4;

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
 * Distance at which a cascade's foam texels drop below the screen sampling
 * rate and start aliasing — the Nyquist point for THIS band.
 *
 * A pixel's world footprint grows roughly linearly with distance, so a texel
 * of size t becomes sub-pixel at d ≈ t · fadeTexels, where fadeTexels folds
 * the camera's angular pixel size and the 2× Nyquist margin into one
 * dimensionless tunable. Grazing angles stretch the along-view footprint far
 * beyond this, which is why the fade must START here rather than end here.
 */
export function cascadeFadeDistance(texelMetres: number, fadeTexels: number): number {
  return Math.max(0, texelMetres) * Math.max(0, fadeTexels);
}

/**
 * Weight for a cascade's FULL-RESOLUTION contribution at a camera distance:
 * 1 while its texels resolve, ramping to 0 once they are sub-pixel noise.
 * Smoothstep so bands retire gradually — a hard cut-off would draw a visible
 * ring on the sea where a whole cascade switched off.
 */
export function cascadeDetailWeight(
  camDist: number,
  texelMetres: number,
  fadeTexels: number,
  fadeSpan: number,
): number {
  const start = cascadeFadeDistance(texelMetres, fadeTexels);
  const end = start * Math.max(1.05, fadeSpan);
  if (!(end > start)) return camDist <= start ? 1 : 0;
  const t = Math.min(1, Math.max(0, (camDist - start) / (end - start)));
  return 1 - t * t * (3 - 2 * t);
}

/**
 * Crest-aligned blur tap offset in texels (GPU mirror: blurDecayPass).
 *
 * WHY (user critique "foam caps are too circular, not following the cap of
 * the wave"): an axis-aligned isotropic 3×3 blur run every frame turns each
 * injected fold into a round blob. Whitecaps are ridges — they must spread
 * ALONG the crest line and barely across it. `acrossX/acrossZ` is the
 * across-crest direction (wave propagation); the frame is therefore
 * (tangent = perp(across) along the ridge, normal = across), stretched
 * `along` on the tangent and squashed `acrossScale` on the normal.
 *
 * The direction is UNIFORM over the field, not derived per texel from ∇h,
 * and that is load-bearing rather than a simplification:
 *  - ∇h VANISHES exactly at a crest line (the height turns over there) and
 *    flips sign across it, so a per-texel frame is at its most unstable
 *    precisely where foam is injected;
 *  - a frame that rotates between neighbouring texels makes this gather-form
 *    blur non-conservative — it sheds foam every frame, which quietly ate
 *    whitecaps (user: "I think we're missing some foam caps");
 *  - a constant frame is shift-invariant, so the kernel provably conserves
 *    mass and decayHalfLife remains the only thing that removes foam (§V6);
 *  - it is also cheaper: no neighbour texture loads at all (§V17).
 * Crest lines are statistically perpendicular to wave propagation, which is
 * also what §V7 asks storm foam to look like — streaks running with the swell.
 *
 * Degenerate direction → axis frame, which for the symmetric gaussian kernel
 * reproduces the isotropic blur exactly.
 */
export function crestTapOffset(
  acrossX: number,
  acrossZ: number,
  dx: number,
  dy: number,
  along: number,
  acrossScale: number,
): [number, number] {
  const len = Math.hypot(acrossX, acrossZ);
  const nx = len > CREST_GRAD_EPS ? acrossX / len : 0;
  const ny = len > CREST_GRAD_EPS ? acrossZ / len : 1;
  // tangent = perp(normal): runs along the crest ridge
  const tx = -ny;
  const ty = nx;
  return [
    tx * dx * along + nx * dy * acrossScale,
    ty * dx * along + ny * dy * acrossScale,
  ];
}

/**
 * One texel of the crest-aligned decay+blur pass (GPU mirror: blurDecayPass).
 * `acrossX/acrossZ` = across-crest (wave propagation) direction, uniform over
 * the field — see crestTapOffset for why it is not derived per texel.
 * along = acrossScale = 1 collapses to blurDecayAt (same weights, mirrored
 * taps). The frame is a rotation and the weights sum to 1, so this conserves
 * foam EXACTLY: decayHalfLife stays the only thing that removes it (§V6).
 */
export function blurDecayAnisoAt(
  src: Float32Array,
  acrossX: number,
  acrossZ: number,
  n: number,
  x: number,
  y: number,
  radius: number,
  along: number,
  acrossScale: number,
  decay: number,
): number {
  let sum = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const [ox, oy] = crestTapOffset(acrossX, acrossZ, dx, dy, along, acrossScale);
      const sx = wrapIndex(x + Math.round(ox * radius), n);
      const sy = wrapIndex(y + Math.round(oy * radius), n);
      sum += src[sy * n + sx] * GAUSSIAN_3X3[(dy + 1) * 3 + (dx + 1)];
    }
  }
  return Math.min(1, sum * decay);
}
