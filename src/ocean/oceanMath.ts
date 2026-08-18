/**
 * Pure CPU-side ocean spectrum + FFT precomputation (§V.4, §V.19).
 * Everything here is deterministic (seeded, §V.2) and unit-testable —
 * the GPU passes consume the arrays this module produces.
 */
import { createRng, type Rng } from '../state/rng';
import type { OceanParams } from '../params/ocean';

export const GRAVITY = 9.81;

/** deep-water dispersion: ω² = g·|k| */
export function dispersion(k: number): number {
  return Math.sqrt(GRAVITY * k);
}

export interface SpectrumBand {
  /** keep wavelengths λ (m) with kMin < k ≤ kMax; ±Infinity allowed */
  kMin: number;
  kMax: number;
}

/** wavelength band → k band for one cascade (band-split, §V.19 no dup energy) */
export function cascadeBand(
  cascadeIndex: number,
  splitWavelengths: [number, number],
): SpectrumBand {
  const [s0, s1] = splitWavelengths;
  const k0 = (2 * Math.PI) / s0;
  const k1 = (2 * Math.PI) / s1;
  if (cascadeIndex === 0) return { kMin: 0, kMax: k0 };
  if (cascadeIndex === 1) return { kMin: k0, kMax: k1 };
  return { kMin: k1, kMax: Infinity };
}

/**
 * Deep-water peak wavenumber for a wave PERIOD.
 *   ω = 2π/T,  ω² = g·k  ⟹  k = ω²/g,  λ = 2π/k = gT²/2π
 * Swell is authored in SECONDS because that is what a sea state is described
 * in and what the user asked for ("not this 2-second interval… maybe 4 or 5
 * or 6"); the wavelength is a consequence of physics, not a second knob that
 * can disagree with it.
 */
export function swellPeakWavenumber(periodSeconds: number): number {
  const omega = (2 * Math.PI) / Math.max(0.5, periodSeconds);
  return (omega * omega) / GRAVITY;
}

/** λ = 2π/k for a swell period — the number to check a domain against */
export function swellWavelengthFor(periodSeconds: number): number {
  return (2 * Math.PI) / swellPeakWavenumber(periodSeconds);
}

/**
 * SWELL — the sea's second, independent wave train (user: "it's already quite
 * the stormy swell… on the open ocean it can be longer intervals").
 *
 * A real ocean carries TWO systems at once and they are not the same thing:
 *   WIND SEA — short, steep, broad-directional, raised by the wind blowing
 *     NOW. That is `phillips` below, and it is all we had.
 *   SWELL — long, low, NARROWLY directional, radiated days ago by a storm
 *     hundreds of miles away and completely decoupled from the local wind.
 * A single Phillips fit to one wind speed cannot produce both: turning the
 * wind down shortens AND flattens everything, turning it up steepens
 * everything. There is no setting that gives long rolling swell under light
 * chop — which is the most common sea state there is, and precisely the one
 * the user is describing as missing.
 *
 * Own peak period, own direction, own (narrow) spread, own amplitude. It is
 * summed into the SAME h0 the wind sea uses, so it needs no extra cascade, no
 * extra texture and no extra sampler (§V.40), and every consumer that reads
 * the spectrum — the GPU FFT, the σ bookkeeping (§V.36), the anti-fold cap,
 * and the CPU buoyancy mirror (§V.8) — picks it up for free.
 *
 * GRID FLOOR, and it is load-bearing (§V.48's reasoning on the spectral side).
 * Real swell is very narrow-band, but a 1010 m tile resolves k only in steps
 * of 2π/1010 = 0.0062, and a band narrower than a couple of those lands on
 * ONE mode — a single perfect sinusoid tiling the world, which §V.19 forbids
 * by name. So the bandwidth is floored at `swellGridModes` grid steps: never
 * ask the grid for a feature it cannot represent, widen instead.
 */
/** Lanczos log-Γ — needed only for the closed-form directional normalisation */
function lgamma(x: number): number {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  }
  const z = x - 1;
  let a = 0.99999999999980993;
  for (let i = 0; i < g.length; i++) a += g[i] / (z + i + 1);
  const t = z + g.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/**
 * ∫cos^n θ dθ over the half-plane the swell occupies, in closed form:
 *   √π · Γ((n+1)/2) / Γ((n+2)/2)
 * This is the ONLY reason lgamma is here — it makes `swellAmplitude` mean
 * metres (see below) instead of an arbitrary scale that changes meaning every
 * time the spread is tuned.
 */
export function directionalIntegral(n: number): number {
  const m = Math.max(0, n);
  return Math.exp(
    0.5 * Math.log(Math.PI) + lgamma((m + 1) / 2) - lgamma((m + 2) / 2),
  );
}

export function swellSpectrum(kx: number, kz: number, p: OceanParams): number {
  if (!(p.swellAmplitude > 0)) return 0;
  const k2 = kx * kx + kz * kz;
  if (k2 < 1e-12) return 0;
  const k = Math.sqrt(k2);
  const kp = swellPeakWavenumber(p.swellPeriod);
  const sigma = swellBandSigma(p);
  const d = (k - kp) / sigma;
  const radial = Math.exp(-0.5 * d * d);
  const wx = Math.cos(p.swellDirection);
  const wz = Math.sin(p.swellDirection);
  const dotKW = (kx / k) * wx + (kz / k) * wz;
  // Swell runs ONE way. Unlike wind sea there is no opposing train to damp:
  // it was radiated by a single distant storm and has travelled since.
  if (dotKW <= 0) return 0;
  const spread = Math.pow(dotKW, swellEffectiveDirectionality(p));
  return (swellScale(p) * radial * spread) / k;
}

/**
 * THE ANGULAR HALF OF THE GRID FLOOR, and it was missing.
 *
 * `swellBandSigma` floors the swell's RADIAL bandwidth at `swellGridModes`
 * grid steps because "a truly narrow band lands on one mode and tiles the
 * world as a sinusoid". A 2-D spectrum has TWO axes and only one of them was
 * floored. At |k| the grid's angular resolution is Δk/|k| radians, and a
 * cos^n spread has an angular width of about 1/√n — so once n exceeds
 * (|k|/(m·Δk))² the whole train fits inside ONE ray of modes, which is a
 * plane wave whichever way the radial band was widened.
 *
 * Measured on the shipped presets, all three were over that ceiling with
 * `swellDirectionality: 24`:
 *     calm  (T 13 s, λ 264 m)  Δk/kp = 0.261 ⟹ ceiling 3.7
 *     swell (T 11 s, λ 189 m)  Δk/kp = 0.187 ⟹ ceiling 7.1
 *     storm (T  9 s, λ 126 m)  Δk/kp = 0.125 ⟹ ceiling 16.0
 * and `calm` — 90.4% swell by variance, 15.2 effective modes — was the sea
 * the user was most likely looking at when they called the waves sinusoidal.
 * Longer swell is WORSE, which is the opposite of the intuition: a longer
 * wave sits at smaller |k|, where the grid's fixed Δk is a larger fraction of
 * it, so the same authored spread buys fewer directions.
 *
 * Same shape as §V.48 and the same cure: never ask the grid for a feature
 * finer than it can represent — widen instead. Applied here rather than at the
 * param so `swellScale` normalises against the spread that is ACTUALLY used
 * and `swellAmplitude` keeps meaning metres of RMS elevation (§B.12).
 */
export function swellEffectiveDirectionality(p: OceanParams): number {
  const authored = Math.max(0, p.swellDirectionality);
  const kp = swellPeakWavenumber(p.swellPeriod);
  const dk = (2 * Math.PI) / swellReferenceDomain(p);
  const modes = Math.max(0.5, p.swellGridModes);
  // want angular width 1/√n ≥ modes·Δk/kp  ⟹  n ≤ (kp/(modes·Δk))²
  const ratio = kp / Math.max(1e-9, modes * dk);
  return Math.min(authored, Math.max(0.5, ratio * ratio));
}

/**
 * Effective radial bandwidth after the grid floor.
 *
 * THE REFERENCE DOMAIN IS THE LARGEST CASCADE'S, NOT THE CALLER'S, and that is
 * a correctness requirement rather than a convenience. Swell is long-wave: it
 * lives entirely in the coarsest band, and that is the only grid whose
 * resolution can limit it. Floored against the CALLER's domain instead, the
 * 22.7 m cascade widened the swell's band by 44× (Δk 0.277 vs 0.0062) and
 * smeared its energy straight into the chop — measured, before this line: σ of
 * the finest cascade went 0.080 → 0.114 m from a swell that is supposed to be
 * 189 m long. The swell would have made the sea MORE nervous, which is the
 * exact opposite of what it is for.
 */
export function swellBandSigma(p: OceanParams): number {
  const kp = swellPeakWavenumber(p.swellPeriod);
  const domain = swellReferenceDomain(p);
  const dk = (2 * Math.PI) / Math.max(1e-3, domain);
  return Math.max(p.swellBandwidth * kp, p.swellGridModes * dk, 1e-6);
}

/** the coarsest cascade — by construction the one that carries the swell */
export function swellReferenceDomain(p: OceanParams): number {
  let d = 0;
  for (const c of p.cascades) d = Math.max(d, c.domain);
  return Math.max(1e-3, d);
}

/**
 * NORMALISATION, and it is what makes `swellAmplitude` a NUMBER YOU CAN READ:
 * metres of RMS swell elevation (so the swell's own significant height is
 * 4×swellAmplitude). Without it the parameter means nothing on its own — the
 * energy would move every time the period, the bandwidth or the directional
 * spread was touched, which is exactly the trap `amplitude` fell into when the
 * wind speed was retuned (§B.12: a constant that silently changed meaning).
 *
 * In this convention the surface variance of a component is
 *   σ² = Σ_modes 2·(√(S/2)/L)² = Σ S/L² = ∫S d²k / (2π)²
 * (the mode sum is ∫ d²k/Δk² with Δk = 2π/L, so L cancels — the swell's height
 * is independent of the domain, as it must be). With
 *   S = A·exp(−(k−kp)²/2σ_k²)·cosⁿθ / k
 * the integral separates: ∫S d²k = ∫S·k dk dθ = A·(σ_k√(2π))·Iₙ, hence
 *   A = σ²·4π² / (σ_k·√(2π)·Iₙ).
 */
export function swellScale(p: OceanParams): number {
  const targetVariance = p.swellAmplitude * p.swellAmplitude;
  const sigmaK = swellBandSigma(p);
  // the spread the grid can actually carry, not the authored one — otherwise
  // the floor above would quietly change the swell's HEIGHT (§B.12)
  const dirI = Math.max(1e-6, directionalIntegral(swellEffectiveDirectionality(p)));
  return (targetVariance * 4 * Math.PI * Math.PI) /
    (sigmaK * Math.sqrt(2 * Math.PI) * dirI);
}

/**
 * THE sea's spectrum: wind sea + swell. Every consumer must call THIS, never
 * `phillips` alone — a second implementation of "what the sea contains" is how
 * the CPU buoyancy mirror silently stops matching the drawn waves (§V.8).
 */
export function waveSpectrum(kx: number, kz: number, p: OceanParams): number {
  return phillips(kx, kz, p) + swellSpectrum(kx, kz, p);
}

/**
 * Wind-sea PEAK wavenumber, in closed form from the Phillips shape itself.
 *
 * The omnidirectional energy density is E(k) ∝ k·S(k) ∝ exp(−1/(k²L²))/k³ with
 * L = U²/g, so d/dk[−3 ln k − 1/(k²L²)] = 0 gives k_p = √(2/3)/L. It is
 * derived rather than authored because the directional spread below is a
 * function of ω/ω_p: a second knob for the peak could disagree with the
 * spectrum that actually gets sampled (the trap `swellPeriod` avoids by
 * deriving its wavelength).
 */
export function windSeaPeakWavenumber(p: OceanParams): number {
  const Lw = Math.max(1e-6, (p.windSpeed * p.windSpeed) / GRAVITY);
  return Math.sqrt(2 / 3) / Lw;
}

/**
 * DIRECTIONAL SPREAD OF THE WIND SEA — and the whole point is that it is a
 * FUNCTION OF WAVENUMBER (§V.58's family: the shape of a feature comes from
 * the spectrum that made it).
 *
 * WHAT WAS THERE AND WHY IT READ AS SINUSOIDS. `spread = |k̂·ŵ|^directionality`
 * with `directionality: 10`, applied identically at EVERY wavenumber. Measured
 * axial (2nd-moment) spread of the shipped sea, per cascade:
 *     cascade 0: 16.5°   cascade 1: 16.5°   cascade 2: 16.4°
 * i.e. the 2 m ripples were combed into the same 33°-wide fan as the 100 m
 * rollers. A spread that narrow at every scale is a comb, and a comb is what
 * "very obvious sine-wavy feeling" (user) looks like: long parallel ridges,
 * self-similar, at every zoom level.
 *
 * A REAL SEA IS NARROWEST AT ITS PEAK AND BROADENS SHARPLY EITHER SIDE.
 * Hasselmann/Mitsuyasu, as used by Horvath 2015 ("Empirical Directional Wave
 * Spectra for Computer Graphics") — the same construction the reference
 * implementations use:
 *     D(θ) ∝ cos^{2s}(Δθ/2),   s = s_p·(ω/ω_p)^{+μ_below}   ω ≤ ω_p
 *                              s = s_p·(ω/ω_p)^{−μ_above}   ω > ω_p
 * With ω² = g|k| the frequency ratio is √(k/k_p), so the exponents halve in k.
 * Measured against our cascades, s_p ≈ 9.8 gives axial spread 22.9° at the
 * peak and ~39° by λ ≤ 8.3 m, against a flat 16.4° before: the short waves are
 * the ones that were most wrong, by 2.4×, and they are the ones the eye reads
 * as surface texture.
 *
 * cos^{2s}(Δθ/2) rather than cos^n(Δθ) for two reasons that both matter here:
 * it is the standard form the fitted constants belong to, and it reaches
 * EXACTLY ZERO at 180° instead of needing `oppositeWaveDamp` to knock out the
 * upwind lobe with a step at 90°. That param survives as a smooth isotropic
 * PEDESTAL — a real sea is never perfectly one-sided — which keeps its meaning
 * ("this fraction of the energy runs against the wind") without the corner.
 *
 * NORMALISED, and that is load-bearing. The factor is divided by its own
 * directional integral, so widening the spread REDISTRIBUTES energy instead of
 * adding it. Without this, every tweak to the spread silently moves Hs —
 * §B.12's shape, and the exact trap `swellScale` already exists to avoid on
 * the other train.
 *
 * The integral is then re-scaled by {@link LEGACY_SPREAD_NORM} so that
 * `amplitude` keeps the numerical meaning it has always had. Any constant
 * would satisfy the invariant above (Phillips' amplitude has no units), and
 * picking the OLD convention's value makes this change a pure redistribution
 * of DIRECTION with bit-identical omnidirectional E(k) — so Hs, `heightRms`,
 * `jacobianRms` (transfer |k|, direction-free ⟹ a function of E(k) alone),
 * the foam gate, the anti-fold cap, every weather preset and the CPU buoyancy
 * mirror's sea state are all exactly where they were. Rescaling three preset
 * amplitudes instead would have been the same physics and a much wider blast
 * radius; measured, it broke a weather-lerp test that assumes storm's
 * amplitude sits above 1.
 */
/**
 * ∫ of the spreading factor this replaces, over the full circle:
 *   ∫|cos θ|¹⁰ dθ · (1 + oppositeWaveDamp) = I(10)·1.06 = 0.7731·1.06
 * It was constant in k — that was the defect — so dividing it out is exact at
 * every wavenumber, not a fit.
 */
export const LEGACY_SPREAD_NORM = 0.81949;
export function windSeaSpread(
  dotKW: number,
  k: number,
  p: OceanParams,
): number {
  const kp = windSeaPeakWavenumber(p);
  const ratio = Math.max(1e-6, k / kp);
  // ω/ωp = √(k/kp) ⟹ (ω/ωp)^μ = (k/kp)^{μ/2}
  const s =
    ratio <= 1
      ? p.spreadPeak * Math.pow(ratio, p.spreadBelowPeak / 2)
      : p.spreadPeak * Math.pow(ratio, -p.spreadAbovePeak / 2);
  // floor: below s≈1 the spread has already saturated at the isotropic limit
  // (measured axial 39.1° at s=0.5 against 40.5° at s=1), so this costs no
  // realism and keeps the normalisation away from Γ's small-argument blowup
  const sEff = Math.max(p.spreadMin, Math.min(64, s));
  const cosHalf = Math.sqrt(Math.max(0, (1 + Math.min(1, Math.max(-1, dotKW))) / 2));
  const lobe = Math.pow(cosHalf, 2 * sEff);
  // ∫cos^{2s}(θ/2) dθ over the full circle = 2·∫cos^{2s}(u) du = 2·I(2s)
  const norm = Math.max(1e-6, 2 * directionalIntegral(2 * sEff)) / LEGACY_SPREAD_NORM;
  const damp = Math.min(1, Math.max(0, p.oppositeWaveDamp));
  // isotropic pedestal, normalised the same way (∫1 dθ = 2π)
  return ((1 - damp) * lobe) / norm + (damp * LEGACY_SPREAD_NORM) / (2 * Math.PI);
}

/** Phillips spectrum with directional spreading + small-wave suppression */
export function phillips(
  kx: number,
  kz: number,
  p: OceanParams,
): number {
  const k2 = kx * kx + kz * kz;
  if (k2 < 1e-12) return 0;
  const k = Math.sqrt(k2);
  const Lw = (p.windSpeed * p.windSpeed) / GRAVITY;
  const wx = Math.cos(p.windDirection);
  const wz = Math.sin(p.windDirection);
  const dotKW = (kx / k) * wx + (kz / k) * wz;
  const spread = windSeaSpread(dotKW, k, p);
  const base =
    (p.amplitude * Math.exp(-1 / (k2 * Lw * Lw))) / (k2 * k2) ;
  const smallWave = Math.exp(-k2 * p.smallWaveCutoff * p.smallWaveCutoff);
  return base * spread * smallWave;
}

/**
 * RMS of ∂Dx/∂x for one cascade's band — the quantity that decides whether
 * the Tessendorf surface FOLDS (§B, storm report).
 *
 * The horizontal displacement is Dx = i(kx/|k|)·h scaled by choppiness λ, so
 * the map x → x + λ·D has Jacobian 1 + λ·∂Dx/∂x. Once λ·∂Dx/∂x reaches −1 the
 * sheet turns inside out: crests shear into faceted shards AND the Jacobian
 * goes negative over huge areas, which is exactly the foam trigger (§V6) —
 * so "foam going crazy" and "wave shapes breaking apart" are ONE bug, the
 * foam faithfully reporting a folded surface.
 *
 * Transfer function of ∂Dx/∂x acting on h is kx²/|k|, so the variance is
 * Σ (kx²/|k|)²·E(k) with E(k) = 2·amp(k)² (the same energy bookkeeping
 * generateH0 uses). Returns σ, in units of 1/λ: multiply by choppiness to get
 * the typical gradient. Deterministic, RNG-free, testable.
 */
export function spectralSteepness(
  N: number,
  domain: number,
  p: OceanParams,
  band: SpectrumBand,
): number {
  let variance = 0;
  for (let m = 0; m < N; m++) {
    for (let n = 0; n < N; n++) {
      const kx = (2 * Math.PI * (n - N / 2)) / domain;
      const kz = (2 * Math.PI * (m - N / 2)) / domain;
      const k = Math.hypot(kx, kz);
      if (!(k > band.kMin && k <= band.kMax) || k < 1e-9) continue;
      const amp = Math.sqrt(waveSpectrum(kx, kz, p) / 2) / domain;
      const transfer = (kx * kx) / k;
      variance += 2 * (transfer * amp) ** 2;
    }
  }
  return Math.sqrt(Math.max(0, variance));
}

/**
 * RMS of (∂Dx/∂x + ∂Dz/∂z) for one cascade's band — the trace of the
 * displacement Jacobian, which is what actually drives det J's spread and the
 * λ− fold metric (§V.58). Transfer function |k|, against `spectralSteepness`'s
 * kx²/|k|.
 *
 * WHY THIS IS MEASURED AND NOT A CONSTANT × steepness. The ratio between the
 * two transfers is fixed by the spectrum's DIRECTIONAL SHAPE, and the sea now
 * carries two trains with very different shapes — wind sea (cos¹⁰, two-sided,
 * damped upwind) and swell (cos²⁴, strictly one-sided). A band dominated by
 * one is not convertible with a constant fitted on the other: measured, the
 * baked 1.79 was 2.65× off in `calm`'s long band, which is ~100% swell. Same
 * failure shape as §B.12 — a constant that silently changes meaning when the
 * spectrum moves — so the cure is the same: publish the moment, do not fit it.
 */
export function spectralJacobianRms(
  N: number,
  domain: number,
  p: OceanParams,
  band: SpectrumBand,
): number {
  let variance = 0;
  for (let m = 0; m < N; m++) {
    for (let n = 0; n < N; n++) {
      const kx = (2 * Math.PI * (n - N / 2)) / domain;
      const kz = (2 * Math.PI * (m - N / 2)) / domain;
      const k = Math.hypot(kx, kz);
      if (!(k > band.kMin && k <= band.kMax) || k < 1e-9) continue;
      const amp = Math.sqrt(waveSpectrum(kx, kz, p) / 2) / domain;
      variance += 2 * (k * amp) ** 2;
    }
  }
  return Math.sqrt(Math.max(0, variance));
}

/**
 * Slope variance of one cascade's band, binned by WAVELENGTH — the histogram
 * behind {@link slopeResolutionFootprint}.
 *
 * Bins are 1/8-octave wide over λ ∈ [2⁻⁸, 2²⁴] m, which covers every
 * wavelength any cascade can hold with room to spare. Binning rather than
 * sorting keeps this the same cost class as the other spectral moments (one
 * N² pass, no allocation per texel) — it runs on every h0 rebuild.
 */
export const SLOPE_BIN_MIN_LOG2 = -8;
export const SLOPE_BINS_PER_OCTAVE = 8;
export const SLOPE_BIN_COUNT = 256;

export function slopeWavelengthHistogram(
  N: number,
  domain: number,
  p: OceanParams,
  band: SpectrumBand,
): Float64Array {
  const bins = new Float64Array(SLOPE_BIN_COUNT);
  for (let m = 0; m < N; m++) {
    for (let n = 0; n < N; n++) {
      const kx = (2 * Math.PI * (n - N / 2)) / domain;
      const kz = (2 * Math.PI * (m - N / 2)) / domain;
      const k = Math.hypot(kx, kz);
      if (!(k > band.kMin && k <= band.kMax) || k < 1e-9) continue;
      const amp = Math.sqrt(waveSpectrum(kx, kz, p) / 2) / domain;
      // slope transfer is |k| on the elevation, so slope variance = k²·E
      const sv = 2 * amp * amp * k * k;
      if (!(sv > 0)) continue;
      const lam = (2 * Math.PI) / k;
      const b = Math.round(
        (Math.log2(lam) - SLOPE_BIN_MIN_LOG2) * SLOPE_BINS_PER_OCTAVE,
      );
      bins[Math.min(SLOPE_BIN_COUNT - 1, Math.max(0, b))] += sv;
    }
  }
  return bins;
}

/** wavelength (m) at the centre of slope-histogram bin `b` */
export function slopeBinWavelength(b: number): number {
  return Math.pow(2, SLOPE_BIN_MIN_LOG2 + b / SLOPE_BINS_PER_OCTAVE);
}

/**
 * The PIXEL FOOTPRINT (m) at which `keep` of this band's SLOPE variance is
 * still resolvable — i.e. still carried by wavelengths ≥ 2·footprint.
 *
 * THIS IS THE NUMBER THE NORMAL LOD MUST BE MEASURED AGAINST, and the reason
 * it exists is §V.48's own lesson applied to the retirement side of a fade.
 * The gate it replaces measured the pixel footprint against the cascade's
 * TEXEL SIZE (domain/N) and retired the whole cascade's normals once a pixel
 * spanned 3.5 of them. A texel is the FINEST thing the grid can hold, not the
 * thing the band is made of: measured on the shipped sea, cascade 2 still has
 * 89% of its slope variance resolvable at the footprint where it was being
 * deleted outright, because its slope-carrying wavelength is 2.4 m = 53
 * texels. The band's own content is 15× coarser than the criterion used to
 * throw it away — which is exactly the mistake §V.48 names (band-limit against
 * the FEATURE, never against the grid), with the sign flipped.
 *
 * The stated justification for fading to zero — "the coarser cascade, still
 * resolved, keeps carrying the large-scale shading; the cascade pyramid IS the
 * mip chain" — is false BY CONSTRUCTION here. A mip chain holds the same
 * wavelengths at several resolutions; §V.19 band-splits the cascades precisely
 * so that no wavelength appears twice. When cascade 2 retires, nothing else in
 * the sea carries λ ≤ 8.3 m at all.
 *
 * Returned in METRES so consumers compare it against `fwidth(worldXZ)`
 * directly, with no per-cascade constant in between — and re-derived from the
 * live spectrum on every rebuild, because the ratio to the texel is NOT stable
 * (measured 2.5/50 texels on cascade 2 against 23/71 on cascade 1: §V.59's
 * tell, a constant that looks like it should serve every band and does not).
 */
export function slopeResolutionFootprint(
  bins: Float64Array,
  keep: number,
): number {
  let total = 0;
  for (const v of bins) total += v;
  if (!(total > 0)) return Infinity;
  const want = Math.min(1, Math.max(0, keep)) * total;
  let acc = 0;
  for (let b = SLOPE_BIN_COUNT - 1; b >= 0; b--) {
    acc += bins[b];
    // λ/2 is Nyquist: a footprint of λ/2 is the last one that can resolve λ
    if (acc >= want) return slopeBinWavelength(b) / 2;
  }
  return slopeBinWavelength(0) / 2;
}

/**
 * TOTAL slope variance of one cascade's band (dimensionless, σ² of ∂h/∂x plus
 * ∂h/∂z) — the same histogram {@link slopeResolutionFootprint} reads, summed
 * instead of inverted.
 *
 * WHY THIS EXISTS, and it is the missing half of §V.48b. `slopeResolutionFootprint`
 * answers "where does this band stop being resolvable", and the fragment normal
 * LOD uses it to fade the cascade OUT. Fading to zero is the right MEAN — a
 * zero-mean slope field averages to flat — but the VARIANCE it removes has to
 * go somewhere, and today it is simply discarded. The consequence was measured
 * in `surfaceMaterial`'s own normLod docstring: shading slope RMS reaches
 * EXACTLY ZERO past 365 m, i.e. half a kilometre of perfect mirror, and a
 * mirror at grazing incidence is maximally sensitive to whatever residual
 * normal survives. That is the sparkle the user reports, arriving as an
 * absence rather than as an excess.
 *
 * The cure is to hand the deleted variance to the specular lobe as ROUGHNESS
 * (Toksvig / Kaplanyan, with the spectrum standing in for the mip chain). This
 * function publishes the σ² that the LOD ramp is scaling, so the shader can
 * reconstruct the UNRESOLVED part as Σ (1 − lod_i)·σ²_i with no extra texture,
 * no extra sampler and no extra fetch (§V.40 — the one spare sampler is not
 * spent here).
 *
 * WHY NOT `dFdx(normalWorld)`, which the material already computes: that
 * estimator is structurally blind to exactly this variance. It measures the
 * normal that SURVIVED the LOD, so the band the LOD already deleted cannot
 * appear in it at all. The two are disjoint and the shader adds them.
 */
export function slopeVarianceTotal(bins: Float64Array): number {
  let total = 0;
  for (const v of bins) total += v;
  return total > 0 ? total : 0;
}

/**
 * THE BAND'S OWN WAVENUMBER (rad/m) — its ELEVATION-ENERGY-WEIGHTED mean k,
 * i.e. Σ k·|h|² / Σ |h|² over the modes this cascade actually carries.
 *
 * Shoaling is strongly wavelength-dependent (a wave feels the bottom below
 * d = λ/2), so `src/ocean/shoaling.ts` needs ONE k per cascade. Publishing it
 * as a MEASUREMENT rather than baking a constant per cascade is the same
 * discipline as `spectralHeightVariance` / `slopeFootprint`, and here it is
 * load-bearing rather than tidy: cascade 0 spans λ 40–1010 m and its mean
 * wavelength moves 249 m → 87 m → 143 m across the calm/swell/storm presets,
 * because the wind sea and the swell train trade dominance inside that one
 * band. A baked constant would be wrong on two of the three.
 *
 * Weighted by ENERGY, not by amplitude or by mode count: k is being used to
 * decide when this band's CONTRIBUTION TO THE SURFACE stops feeling the
 * bottom, and that contribution is what the variance measures. Weighting by
 * mode count would answer with the band's geometric centre, which on a
 * log-spaced-energy spectrum is nowhere near where the sea's motion lives.
 *
 * Same loop shape as `spectralHeightVariance` (transfer function 1), so the
 * two can only ever disagree about the weighting, never about the band.
 */
export function spectralMeanWavenumber(
  N: number,
  domain: number,
  p: OceanParams,
  band: SpectrumBand,
): number {
  let energy = 0;
  let weighted = 0;
  for (let m = 0; m < N; m++) {
    for (let n = 0; n < N; n++) {
      const kx = (2 * Math.PI * (n - N / 2)) / domain;
      const kz = (2 * Math.PI * (m - N / 2)) / domain;
      const k = Math.hypot(kx, kz);
      if (!(k > band.kMin && k <= band.kMax) || k < 1e-9) continue;
      const amp = Math.sqrt(waveSpectrum(kx, kz, p) / 2) / domain;
      const variance = 2 * amp * amp;
      energy += variance;
      weighted += variance * k;
    }
  }
  // an empty or zero-energy band has no wavelength to report; 0 lets the
  // caller's own floor (shoaling.shoalWavenumber) supply the answer rather
  // than propagating a NaN into every vertex (§V.28)
  return energy > 0 ? weighted / energy : 0;
}

/**
 * RMS surface elevation contributed by one cascade's band (σ_h). Summed in
 * quadrature across cascades this is the sea state's scale: significant wave
 * height Hs = 4σ. Shading thresholds that mean "a crest" must be expressed in
 * MULTIPLES of this, never in absolute metres (§B cow-pattern) — an absolute
 * 0.25 m gate meant "the top 9% of a 2.3 m sea" when it was written and
 * "36% of a 2.8 m sea" after the swell retune, which is why large turquoise
 * blobs appeared. Same loop shape as spectralSteepness, transfer function 1.
 */
export function spectralHeightVariance(
  N: number,
  domain: number,
  p: OceanParams,
  band: SpectrumBand,
): number {
  let variance = 0;
  for (let m = 0; m < N; m++) {
    for (let n = 0; n < N; n++) {
      const kx = (2 * Math.PI * (n - N / 2)) / domain;
      const kz = (2 * Math.PI * (m - N / 2)) / domain;
      const k = Math.hypot(kx, kz);
      if (!(k > band.kMin && k <= band.kMax) || k < 1e-9) continue;
      const amp = Math.sqrt(waveSpectrum(kx, kz, p) / 2) / domain;
      variance += 2 * amp * amp;
    }
  }
  return Math.max(0, variance);
}

/**
 * Choppiness actually handed to the GPU for a cascade (§V7 keeps presets pure
 * params, so the safety lives HERE and covers every preset — including ones
 * nobody has written yet).
 *
 * Capping λ·σ at foldLimit < 1 keeps the surface single-valued with margin.
 * Because σ scales as √amplitude, raising amplitude automatically pulls
 * choppiness down: storm can keep its energy and its rolling swell without
 * the sheet self-intersecting. Never RAISES the artist's value.
 *
 * §V.59 — THE MOMENT IS THE TRACE, NOT THE X-PROJECTION, and this argument
 * used to be `steepnessRms`. The surface folds where det J ≤ 0, and det J's
 * spread is λ·σ(∂Dx/∂x + ∂Dz/∂z): transfer |k|, DIRECTION-FREE.
 * `spectralSteepness` measures kx²/|k| — a projection onto x — which is the
 * same thing only for a spectrum symmetric about that axis. It was, while
 * there was one wave train running with the wind, and that is exactly why one
 * constant appeared to serve every band of every preset. The swell train, a
 * narrow beam at ~57° to x, made the projection read 0.38× of the truth on a
 * swell-dominated band, so the anti-fold cap was 2.6× weaker than believed
 * there — and the cap is what cleared storm of the user's "crests crossing
 * over" report. Measured on wind sea the two moments differ by a flat 1.79,
 * which is why `choppinessFoldLimit` moved 0.2857 → 0.5102 in the same commit:
 * identical λ on every sea this was calibrated on, correct λ on the new ones.
 */
export function effectiveChoppiness(
  choppiness: number,
  jacobianRms: number,
  foldLimit: number,
): number {
  if (!Number.isFinite(choppiness) || choppiness <= 0) return 0;
  const limit = Math.max(0, foldLimit) / Math.max(1e-6, jacobianRms);
  return Math.min(choppiness, limit);
}

/**
 * Initial spectrum h0 for one cascade.
 * Texel (n,m) → k = 2π(n − N/2)/L. RGBA texel packs:
 *   [h0(k).re, h0(k).im, h0(−k).re, h0(−k).im]
 * GPU then evaluates h(k,t) = h0(k)e^{iωt} + conj(h0(−k))e^{−iωt},
 * which keeps the field Hermitian → real heights.
 */
export function generateH0(
  N: number,
  domain: number,
  seed: number,
  p: OceanParams,
  band: SpectrumBand,
): Float32Array {
  const rng: Rng = createRng(seed);
  // pre-generate gaussians for the full grid so h0(−k) lookups are consistent
  const re = new Float32Array(N * N);
  const im = new Float32Array(N * N);
  for (let m = 0; m < N; m++) {
    for (let n = 0; n < N; n++) {
      const kx = (2 * Math.PI * (n - N / 2)) / domain;
      const kz = (2 * Math.PI * (m - N / 2)) / domain;
      const k = Math.hypot(kx, kz);
      const [g1, g2] = gaussianPair(rng);
      let amp = 0;
      if (k > band.kMin && k <= band.kMax) {
        amp = Math.sqrt(waveSpectrum(kx, kz, p) / 2) / domain;
      }
      const i = m * N + n;
      re[i] = g1 * amp;
      im[i] = g2 * amp;
    }
  }
  const out = new Float32Array(N * N * 4);
  for (let m = 0; m < N; m++) {
    for (let n = 0; n < N; n++) {
      const i = m * N + n;
      // −k texel index (wraps at grid edge; standard Tessendorf mirror)
      const nm = (N - n) % N;
      const mm = (N - m) % N;
      const j = mm * N + nm;
      out[i * 4 + 0] = re[i];
      out[i * 4 + 1] = im[i];
      out[i * 4 + 2] = re[j];
      out[i * 4 + 3] = im[j];
    }
  }
  return out;
}

/**
 * Everything `OceanCascade` needs from a spectrum, in ONE N² pass.
 *
 * WHY THIS EXISTS — it is a pure speed fix for the one confirmed stall in the
 * project, and it changes no number anywhere. `generateH0` and the five
 * spectral moments above are SIX separate N² loops that each evaluate the SAME
 * `waveSpectrum(kx, kz, p)` at the SAME texel. Measured at the shipped 512² ×
 * 3 cascades, one full rebuild is 378–667 ms of main-thread JS, of which
 * `waveSpectrum` is ~92% of every pass (65.9 ms of a 71.6 ms pass on cascade 2,
 * itself 86% of the total because its band k ≥ 0.757 rejects almost no texel).
 * Inside `waveSpectrum` the dominant term is `windSeaSpread`'s normalisation,
 * i.e. two `lgamma` calls per texel through {@link directionalIntegral}.
 * Evaluating that once instead of six times measures **378 → 103 ms (3.67×)**.
 *
 * BIT-IDENTICAL, and that is the whole reason this is safe to do (§V.8). Each
 * accumulator receives exactly the addends the separate loop gave it, in
 * exactly the m-outer/n-inner order, so the doubles land on the same bits — not
 * "within tolerance", equal. `gaussianPair` is still drawn for EVERY texel
 * before the band test, so the RNG sequence and therefore h0's phases are
 * unchanged. The `k < 1e-9` guard is kept separate from the band test because
 * the moments skip that texel and `generateH0` does not.
 *
 * The six functions above stay exported and stay the definition of each
 * moment: they are what the tests measure against, and this is checked to be
 * bit-identical to them rather than trusted to be (tests/ocean.test.ts).
 */
export interface SpectrumData {
  /** h0 texel data, exactly as {@link generateH0} returns it */
  h0: Float32Array;
  steepnessRms: number;
  jacobianRms: number;
  heightVariance: number;
  meanWavenumber: number;
  slopeBins: Float64Array;
}

/**
 * The fused pass as a RESUMABLE object, so one rebuild can be spread over many
 * frames instead of landing as one 515 ms stall (§B.51).
 *
 * WHY ROW SLICES ARE EXACT, and it is the whole safety argument. The build is
 * two loops over `m` (rows), and a slice is a contiguous ASCENDING range of
 * them, so:
 *  · `gaussianPair` is still drawn once per texel in m-outer/n-inner order,
 *    with ONE `Rng` carried across the slice boundaries — the RNG sequence is
 *    part of the spectrum's identity (a reseed would rotate every phase in the
 *    sea), and carrying the generator is what preserves it;
 *  · every accumulator receives exactly the same addends in exactly the same
 *    order, so the doubles land on the same bits — bit-identical, not "within
 *    tolerance".
 * Both hold for ANY partition into contiguous ascending row ranges, which is
 * why the slice COUNT is a free performance knob and not a correctness one:
 * `tests/ocean.test.ts` pins 1, 3, 7, 24 and 512 slices against each other and
 * against the six original single-purpose passes.
 *
 * TWO PHASES, because they have different dependencies. Phase A (`spectrum`)
 * fills `re`/`im` and the five moments, one row at a time. Phase B (`pack`)
 * writes the RGBA h0 texels, and texel (n,m) needs the MIRROR texel (−n,−m),
 * i.e. row (N−m)%N — which is only available once phase A has finished the
 * whole grid. So pack cannot start early, and it gets its own row budget.
 * Measured at the shipped 512²×3: phase A ≈ 135 ms, phase B ≈ 7 ms.
 */
export class SpectrumBuild {
  private readonly rng: Rng;
  private readonly re: Float32Array;
  private readonly im: Float32Array;
  private readonly bins = new Float64Array(SLOPE_BIN_COUNT);
  private readonly out: Float32Array;
  private steepVar = 0;
  private jacVar = 0;
  private heightVar = 0;
  private energy = 0;
  private weighted = 0;
  /** next un-built row of phase A */
  private row = 0;
  /** next un-packed row of phase B */
  private packRow = 0;

  constructor(
    private readonly N: number,
    private readonly domain: number,
    seed: number,
    private readonly p: OceanParams,
    private readonly band: SpectrumBand,
  ) {
    this.rng = createRng(seed);
    this.re = new Float32Array(N * N);
    this.im = new Float32Array(N * N);
    this.out = new Float32Array(N * N * 4);
  }

  get done(): boolean {
    return this.packRow >= this.N;
  }

  /** fraction of the whole build already done, phases weighted by row count */
  get progress(): number {
    return (this.row + this.packRow) / (2 * this.N);
  }

  /**
   * Run phase A up to (not including) row `spectrumRow`, then — only once
   * phase A has covered the whole grid — phase B up to row `packRow`.
   *
   * TARGETS, NOT COUNTS, and that is what makes the schedule independent of
   * the resolution. A caller that wants S even slices asks for
   * `floor((j+1)·N/S)` on step j: exactly S steps for any N, with no short
   * final slice and no dependence on whether S divides N. A per-call ROW COUNT
   * would give `ceil(N/S)` rows per step and therefore `ceil(N/ceil(N/S))`
   * steps, which is S at 512 and S−2 at 128 — a schedule that changes with the
   * grid, on both sides of a §V.8 pair.
   *
   * Returns `done`.
   */
  runTo(spectrumRow: number, packRow: number): boolean {
    if (this.row < spectrumRow) this.buildRows(Math.min(this.N, spectrumRow));
    if (this.row >= this.N && this.packRow < packRow) {
      this.packRows(Math.min(this.N, packRow));
    }
    return this.done;
  }

  /** run to completion — what the unsliced callers want */
  finish(): SpectrumData {
    this.runTo(this.N, this.N);
    return this.result();
  }

  private buildRows(endRow: number): void {
    const { N, domain, p, band, re, im, bins } = this;
    const rng = this.rng;
    for (let m = this.row; m < endRow; m++) {
      for (let n = 0; n < N; n++) {
        const kx = (2 * Math.PI * (n - N / 2)) / domain;
        const kz = (2 * Math.PI * (m - N / 2)) / domain;
        const k = Math.hypot(kx, kz);
        // drawn unconditionally, as generateH0 does — the RNG sequence is part
        // of the spectrum's identity, so a band-gated draw would reseed h0
        const [g1, g2] = gaussianPair(rng);
        const inBand = k > band.kMin && k <= band.kMax;
        const amp = inBand ? Math.sqrt(waveSpectrum(kx, kz, p) / 2) / domain : 0;
        const i = m * N + n;
        re[i] = g1 * amp;
        im[i] = g2 * amp;
        if (!inBand || k < 1e-9) continue;
        // spectralSteepness — transfer kx²/|k|
        const transfer = (kx * kx) / k;
        this.steepVar += 2 * (transfer * amp) ** 2;
        // spectralJacobianRms — transfer |k|
        this.jacVar += 2 * (k * amp) ** 2;
        // spectralHeightVariance / spectralMeanWavenumber — transfer 1
        const variance = 2 * amp * amp;
        this.heightVar += variance;
        this.energy += variance;
        this.weighted += variance * k;
        // slopeWavelengthHistogram — slope transfer |k| on the elevation
        const sv = variance * k * k;
        if (!(sv > 0)) continue;
        const lam = (2 * Math.PI) / k;
        const b = Math.round(
          (Math.log2(lam) - SLOPE_BIN_MIN_LOG2) * SLOPE_BINS_PER_OCTAVE,
        );
        bins[Math.min(SLOPE_BIN_COUNT - 1, Math.max(0, b))] += sv;
      }
    }
    this.row = endRow;
  }

  private packRows(endRow: number): void {
    const { N, re, im, out } = this;
    for (let m = this.packRow; m < endRow; m++) {
      for (let n = 0; n < N; n++) {
        const i = m * N + n;
        const nm = (N - n) % N;
        const mm = (N - m) % N;
        const j = mm * N + nm;
        out[i * 4 + 0] = re[i];
        out[i * 4 + 1] = im[i];
        out[i * 4 + 2] = re[j];
        out[i * 4 + 3] = im[j];
      }
    }
    this.packRow = endRow;
  }

  /**
   * The finished spectrum. THROWS while the build is incomplete rather than
   * returning a half-filled grid: a partially-built h0 is a sea that is
   * neither the old one nor the new one, and §V.8 says the ship floats on the
   * sea that is drawn — so "half a spectrum" must be impossible to obtain,
   * not merely discouraged (§V.28, §Rule 8: fail loud).
   */
  result(): SpectrumData {
    if (!this.done) {
      throw new Error(
        `SpectrumBuild.result: incomplete (rows ${this.row}/${this.N}, packed ${this.packRow}/${this.N})`,
      );
    }
    return {
      h0: this.out,
      steepnessRms: Math.sqrt(Math.max(0, this.steepVar)),
      jacobianRms: Math.sqrt(Math.max(0, this.jacVar)),
      heightVariance: Math.max(0, this.heightVar),
      meanWavenumber: this.energy > 0 ? this.weighted / this.energy : 0,
      slopeBins: this.bins,
    };
  }
}

export function generateSpectrumData(
  N: number,
  domain: number,
  seed: number,
  p: OceanParams,
  band: SpectrumBand,
): SpectrumData {
  return new SpectrumBuild(N, domain, seed, p, band).finish();
}

/** Box-Muller from seeded rng */
export function gaussianPair(rng: Rng): [number, number] {
  let u1 = rng();
  if (u1 < 1e-12) u1 = 1e-12;
  const u2 = rng();
  const r = Math.sqrt(-2 * Math.log(u1));
  return [r * Math.cos(2 * Math.PI * u2), r * Math.sin(2 * Math.PI * u2)];
}

export function bitReverse(x: number, bits: number): number {
  let r = 0;
  for (let i = 0; i < bits; i++) {
    r = (r << 1) | ((x >> i) & 1);
  }
  return r;
}

/**
 * Butterfly lookup for radix-2 DIT inverse FFT (twiddle e^{+2πik/N}).
 * Layout: stages rows × N cols, RGBA = [tw.re, tw.im, indexA, indexB].
 * Shader/CPU update rule per stage: out[x] = in[A] + W·in[B].
 * Stage 0 indices are bit-reversed so input order is natural.
 */
export function generateButterfly(N: number): Float32Array {
  const stages = Math.log2(N);
  if (!Number.isInteger(stages)) throw new Error('N must be power of two');
  const out = new Float32Array(stages * N * 4);
  for (let j = 0; j < stages; j++) {
    const span = 1 << j;
    for (let x = 0; x < N; x++) {
      const k = (x * (N >> (j + 1))) % N;
      const twRe = Math.cos((2 * Math.PI * k) / N);
      const twIm = Math.sin((2 * Math.PI * k) / N);
      const topWing = x % (span * 2) < span;
      let a: number;
      let b: number;
      if (j === 0) {
        a = topWing ? bitReverse(x, stages) : bitReverse(x - 1, stages);
        b = topWing ? bitReverse(x + 1, stages) : bitReverse(x, stages);
      } else {
        a = topWing ? x : x - span;
        b = topWing ? x + span : x;
      }
      const i = (j * N + x) * 4;
      out[i + 0] = twRe;
      out[i + 1] = twIm;
      out[i + 2] = a;
      out[i + 3] = b;
    }
  }
  return out;
}

/**
 * CPU reference 1D inverse FFT driven by the butterfly table — exists to
 * prove the table's indices/twiddles are right before the GPU ever runs
 * (same update rule the shader uses). Unnormalized: X[n] = Σ x[k]e^{+2πikn/N}.
 */
export function cpuButterflyIFFT(
  input: { re: Float32Array; im: Float32Array },
  butterfly: Float32Array,
  N: number,
): { re: Float32Array; im: Float32Array } {
  const stages = Math.log2(N);
  let pingRe = Float32Array.from(input.re);
  let pingIm = Float32Array.from(input.im);
  let pongRe = new Float32Array(N);
  let pongIm = new Float32Array(N);
  for (let j = 0; j < stages; j++) {
    for (let x = 0; x < N; x++) {
      const i = (j * N + x) * 4;
      const twRe = butterfly[i];
      const twIm = butterfly[i + 1];
      const a = butterfly[i + 2];
      const b = butterfly[i + 3];
      // out = in[a] + W·in[b]
      pongRe[x] = pingRe[a] + twRe * pingRe[b] - twIm * pingIm[b];
      pongIm[x] = pingIm[a] + twRe * pingIm[b] + twIm * pingRe[b];
    }
    [pingRe, pongRe] = [pongRe, pingRe];
    [pingIm, pongIm] = [pongIm, pingIm];
  }
  return { re: pingRe, im: pingIm };
}

/** naive unnormalized inverse DFT — test oracle only */
export function naiveIDFT(
  input: { re: Float32Array; im: Float32Array },
  N: number,
): { re: Float32Array; im: Float32Array } {
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    for (let k = 0; k < N; k++) {
      const ang = (2 * Math.PI * k * n) / N;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      re[n] += input.re[k] * c - input.im[k] * s;
      im[n] += input.re[k] * s + input.im[k] * c;
    }
  }
  return { re, im };
}
