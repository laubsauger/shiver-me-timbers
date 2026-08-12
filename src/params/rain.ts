/**
 * Rain tunables (§V16). Consumed by src/rain/* (§T.37, §V47).
 *
 * TUNING CONTRACT, from the SoT storm reference (§V43): rain reads as SLANTED
 * STREAKS driven hard by the wind, dense enough to be unmistakable but never
 * a grey curtain over the near field — the reference still shows the water's
 * teal-green through it, and the enemy galleon close aboard stays readable.
 * If the sea colour dulls when rain switches on, `opacity` or `count` is too
 * high, not the ocean's problem.
 *
 * There is deliberately NO wind param here. §V47 requires rain to be driven by
 * the same wind the sea and the sails read, so src/rain reads
 * `oceanParams.windDirection` / `windSpeed` directly and takes no override —
 * a duplicate wind knob is exactly how two systems end up disagreeing about
 * which way the wind blows.
 */
import { registerParams, type ParamMeta } from './registry';

export interface RainParams {
  /** particle pool size (build-time: changing requires recreating the system) */
  count: number;
  /** XZ side length (m) of the wrapping rain volume centred on the camera */
  extent: number;
  /** vertical size (m) of that volume */
  height: number;
  /** metres the volume's centre sits above the camera */
  heightOffset: number;
  /** terminal fall speed (m/s) — real raindrops land near 7-9 m/s */
  fallSpeed: number;
  /**
   * 0..1 per-drop spread on fall speed. Not cosmetic: identical speeds plus
   * identical wrap periods make the whole curtain re-align periodically, which
   * is the §B4 failure (one shared phase → the entire field pulses in unison).
   * Per-drop position hashes already decorrelate the phase; this keeps them
   * decorrelated over time.
   */
  fallSpeedVariance: number;
  /** fraction of the live wind vector the drops are advected by */
  windCarry: number;
  /** streak length (m) — the sprite's long axis, along its own velocity */
  streakLength: number;
  /** >1 squashes the streak ACROSS its velocity: how thin the line reads */
  streakAspect: number;
  /** radial falloff exponent along the streak (higher = softer ends) */
  softness: number;
  /** peak streak opacity */
  opacity: number;
  /** streak colour, sRGB hex (§V31 — entered via new THREE.Color) */
  color: number;
  /**
   * Near depth fade (m): streaks are invisible closer than fadeNear0 and reach
   * full strength by fadeNear1. §V47 "depth-faded so it does not fog the near
   * field" — a drop rendered 30 cm from the lens is a grey smear over the whole
   * frame, which is what makes rain read as fog instead of rain.
   */
  fadeNear0: number;
  fadeNear1: number;
  /** far depth fade (m): full strength until fadeFar0, gone by fadeFar1 */
  fadeFar0: number;
  fadeFar1: number;
  /**
   * How far BELOW mean sea level a drop survives, as a MULTIPLE OF σ (the
   * sea's height RMS, published by the ocean as `heightRms`). The rain volume
   * wraps vertically, so drops exist below the waterline too — and the water
   * is see-through in the near field (§V24), so those would read as streaks
   * falling underwater.
   *
   * §V36: σ-relative, never an absolute metre gate. A trough is roughly −2σ
   * deep whatever the sea state, so a fixed "−3 m" would clip rain out of the
   * troughs in a storm and leave sub-surface streaks in a calm — the exact
   * failure mode that has already produced two user-visible bugs here.
   */
  seaCullSigma: number;
}

export const rainParams: RainParams = registerParams(
  'rain',
  {
    count: 12000,
    extent: 130,
    height: 90,
    heightOffset: 18,
    fallSpeed: 8.5,
    fallSpeedVariance: 0.35,
    // full advection: at storm wind (18 m/s) against an 8.5 m/s fall the
    // streaks lie ~65° off vertical, which is the hard left-right slant the
    // reference shows. Below ~0.7 the rain reads as falling straight down.
    windCarry: 1,
    streakLength: 1.1,
    streakAspect: 9,
    softness: 2.2,
    opacity: 0.3,
    color: 0xc9d8e4, // pale cool grey — storm rain lit by a flat overcast lid
    fadeNear0: 1.2,
    fadeNear1: 6,
    fadeFar0: 55,
    fadeFar1: 110,
    // 2.5σ is below any trough (a sea reaches roughly ±2σ), so rain still
    // falls all the way into the hollows but nothing survives under the water
    seaCullSigma: 2.5,
  },
  rainParamsMeta(),
);

function rainParamsMeta(): Partial<Record<keyof RainParams, ParamMeta>> {
  return {
    count: { min: 512, max: 60000, step: 512 },
    extent: { min: 20, max: 400, step: 5 },
    height: { min: 10, max: 300, step: 5 },
    heightOffset: { min: -50, max: 120, step: 1 },
    fallSpeed: { min: 0.5, max: 30, step: 0.1 },
    fallSpeedVariance: { min: 0, max: 1, step: 0.01 },
    windCarry: { min: 0, max: 2, step: 0.01 },
    streakLength: { min: 0.05, max: 6, step: 0.05 },
    streakAspect: { min: 1, max: 30, step: 0.5 },
    softness: { min: 1, max: 8, step: 0.1 },
    opacity: { min: 0, max: 1, step: 0.01 },
    fadeNear0: { min: 0, max: 20, step: 0.1 },
    fadeNear1: { min: 0.5, max: 40, step: 0.5 },
    fadeFar0: { min: 5, max: 400, step: 5 },
    fadeFar1: { min: 10, max: 600, step: 5 },
    seaCullSigma: { min: 0, max: 8, step: 0.1 },
  };
}
