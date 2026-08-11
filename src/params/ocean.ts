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
  cascades: [{ domain: 250 }, { domain: 60 }, { domain: 15 }],
  splitWavelengths: [24, 5],
  amplitude: 1.0,
  windSpeed: 9,
  windDirection: Math.PI * 0.25,
  directionality: 6,
  oppositeWaveDamp: 0.06,
  smallWaveCutoff: 0.02,
  choppiness: 1.4,
  jacobianFoamBias: 0.0,
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
