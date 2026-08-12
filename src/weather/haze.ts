/**
 * Sun-anisotropic storm haze (§T.37, §V47) — PURE MATH, no three.
 *
 * "The fog actually gets pierced by sun, so the fog is stronger where the sun
 * is not pointing at us" (user, on the SoT storm reference). An isotropic fog
 * term cannot produce that: it thickens every direction equally and the result
 * is the uniform grey soup §V47 forbids. What reads as a lit patch in the murk
 * is scattering that is ANGLE-DEPENDENT — thinner along the sun vector, heavier
 * away from it.
 *
 * SHAPE: normalised Henyey-Greenstein. The raw phase function is
 *   p(µ) ∝ (1 − g²) / (1 + g² − 2g·µ)^1.5,  µ = dot(viewDir, sunDir)
 * dividing by its own peak p(1) gives
 *   a(µ) = ((1 − g)² / (1 + g² − 2g·µ))^1.5 ∈ [((1−g)/(1+g))³, 1]
 * which is 1 looking straight at the sun and falls off behind you. Normalising
 * ANALYTICALLY rather than clamping afterwards is the point: §V44 (learned via
 * §B15) says flooring the divisor bounds the division, not the quotient — here
 * the quotient is bounded by construction, and the clamp below is belt-and-braces
 * against a hand-edited g, not the thing carrying the invariant.
 *
 * OUTPUT CONTRACT — two numbers per view ray, both MULTIPLICATIVE (§V44: less
 * light arriving is a multiply, never a negative addend):
 *   densityScale — multiply the sky's existing haze strength by this
 *   litWeight    — 0..1, mix the haze COLOUR toward a sunlit tint by this
 *
 * OWNERSHIP: src/sky/** owns the actual fog and sky. This module owns the
 * §V47 shape only; sky consumes it (TSL node pack in ./hazeNode.ts).
 */
import { clamp01 } from './field';
import { weatherParams } from '../params/weather';

/** g must stay below 1: at g = 1 the phase denominator collapses at µ = 1 */
export const MAX_ANISOTROPY = 0.95;

const fin = (v: number, fallback: number): number =>
  Number.isFinite(v) ? v : fallback;

/**
 * Normalised HG anisotropy, 1 along the sun vector → smallest opposite it.
 * `mu` = dot(normalized view direction, normalized sun direction), −1..1.
 */
export function hazeAnisotropy(mu: number, g: number): number {
  const gc = Math.min(Math.max(fin(g, 0), 0), MAX_ANISOTROPY);
  const m = Math.min(Math.max(fin(mu, 0), -1), 1);
  const num = (1 - gc) * (1 - gc);
  // ≥ (1 − g)² ≥ 0.0025 for g ≤ 0.95 — floored anyway, but see the header:
  // the BOUND on the result comes from the normalisation, not from this floor
  const den = Math.max(1 + gc * gc - 2 * gc * m, 1e-4);
  return clamp01(Math.pow(num / den, 1.5));
}

export interface HazeContract {
  /** multiply the sky's haze strength / fog density by this */
  densityScale: number;
  /** 0..1 — mix the haze colour toward the sunlit tint by this much */
  litWeight: number;
}

/**
 * Full §V47 response for one view ray.
 *
 * `storm` (0..1, from `weatherAt().storm`) scales the whole effect, so a clear
 * day is not warped by it: at storm 0 `densityScale` is exactly 1 and the sky
 * renders precisely as it does today — §V7's "no code path change" applied to
 * this feature too.
 */
export function hazeResponse(mu: number, storm: number): HazeContract {
  const aniso = hazeAnisotropy(mu, weatherParams.hazeAnisotropy);
  const weight =
    clamp01(fin(storm, 0)) * clamp01(fin(weatherParams.hazeStormWeight, 0));
  // away (aniso 0) → thicker, along the sun (aniso 1) → thinner
  const away = Math.max(fin(weatherParams.hazeAwayMultiplier, 1), 0);
  const sun = Math.max(fin(weatherParams.hazeSunMultiplier, 1), 0);
  const raw = away + (sun - away) * aniso; // functional mix (§V23)
  return {
    densityScale: 1 + (raw - 1) * weight,
    litWeight: aniso * weight,
  };
}

/** density multiplier only — the number sky multiplies its haze strength by */
export function hazeDensityScale(mu: number, storm: number): number {
  return hazeResponse(mu, storm).densityScale;
}

/** the contract object, for callers that want both numbers in one go */
export const hazeContract = hazeResponse;
