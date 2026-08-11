/**
 * Ocean simulation tunables (§V.16, §V.19).
 * 3 FFT cascades; band-split by wavelength so energy is never duplicated.
 */
import { registerParams } from './registry';

export interface CascadeParams {
  /** world-space domain size in meters this cascade tiles over */
  domain: number;
}

export interface OceanParams {
  /** texture resolution per cascade (N×N), power of two (§V.19 ≥512) */
  resolution: number;
  cascades: [CascadeParams, CascadeParams, CascadeParams];
  /**
   * wavelength (m) boundaries between cascades: cascade0 keeps λ > split[0],
   * cascade1 keeps split[0] ≥ λ > split[1], cascade2 keeps λ ≤ split[1].
   * Prevents double-counted spectrum energy across cascades.
   */
  splitWavelengths: [number, number];
  /** Phillips spectrum scale — overall wave energy */
  amplitude: number;
  windSpeed: number; // m/s
  windDirection: number; // radians
  /** directional spreading exponent — higher = waves align with wind */
  directionality: number;
  /** damping for waves travelling against the wind, 0..1 */
  oppositeWaveDamp: number;
  /** small-wave suppression length (m) — kills sub-texel chop */
  smallWaveCutoff: number;
  /** horizontal displacement scale (Tessendorf choppiness λ) */
  choppiness: number;
  /** foam: jacobian below this injects foam (§V.6, biased down in storms §V.7) */
  jacobianFoamBias: number;
}

export const oceanParams: OceanParams = registerParams('ocean', {
  resolution: 512,
  // non-commensurate domains (§V19): 420/98 ≈ 4.29, 98/22.7 ≈ 4.32 — no pair
  // re-aligns on a short world period, so foam/wave repeats don't grid up.
  // Scaled 1.66× off the old 253/59/13.7 to carry OPEN-OCEAN swell: at the
  // wind below the energy-weighted mean wavelength is ≈69 m, and 3.7 waves
  // per tile (the old 253 m domain) reads as repetition (user: "wave
  // frequency for open ocean is a little high", "pattern is repetitive").
  cascades: [{ domain: 420 }, { domain: 98 }, { domain: 22.7 }],
  // band edges scale with the domains so no cascade is asked for wavelengths
  // its grid can't hold (also keeps the CPU buoyancy mirror's kMax inside its
  // reduced grid — see sea-physics/cpuOcean ctor guard)
  splitWavelengths: [40, 8.3],
  // wave SCALE is windSpeed (Phillips peak ∝ V²/g), not domain: 8 → 11 m/s
  // moves the mean wavelength 37 m → 69 m. Amplitude drops 0.75 → 0.32 to
  // hold significant wave height near the old sea state (Hs ≈ 2.3 → 2.8 m)
  // instead of letting longer waves also get much taller.
  amplitude: 0.32,
  windSpeed: 11,
  windDirection: Math.PI * 0.25,
  directionality: 10,
  oppositeWaveDamp: 0.06,
  smallWaveCutoff: 0.03,
  choppiness: 0.95,
  // longer swell at the same height is LESS steep → less jacobian folding,
  // so the foam gate opens slightly to keep whitecap coverage (§V6)
  jacobianFoamBias: 0.55,
}, oceanParamsMeta());

function oceanParamsMeta() {
  return {
    amplitude: { min: 0, max: 4, step: 0.01 },
    windSpeed: { min: 0.5, max: 30, step: 0.1 },
    windDirection: { min: 0, max: Math.PI * 2, step: 0.01 },
    directionality: { min: 0, max: 16, step: 0.5 },
    oppositeWaveDamp: { min: 0, max: 1, step: 0.01 },
    smallWaveCutoff: { min: 0, max: 0.5, step: 0.005 },
    choppiness: { min: 0, max: 3, step: 0.01 },
    jacobianFoamBias: { min: -1, max: 1, step: 0.01 },
  };
}
