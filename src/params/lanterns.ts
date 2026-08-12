/**
 * Hanging practical lights (§V16: every tunable lives in a params module and
 * appears in Tweakpane; no magic constants in the system).
 *
 * COLOUR AUTHORING CONTRACT, same as params/sky.ts: every hex here is sRGB
 * and enters three through `new THREE.Color(hex)` / `setRGB(..., SRGBColorSpace)`.
 * A bare `setRGB` writes the LINEAR working space and lands ~2× too bright
 * and desaturated, silently — that is §B9, and a warm flame colour is exactly
 * the kind of saturated value it destroys.
 */
import { registerParams } from './registry';

export interface LanternParams {
  /**
   * Master. A lantern light is created ONCE AT BOOT and never added to or
   * removed from the scene — see src/lanterns/index.ts. Turning lanterns
   * "off" means driving this to 0, not removing the light.
   */
  intensity: number;
  /** flame colour (sRGB) — warm, and warmer than the moon by a long way */
  color: number;
  /**
   * Radius in metres at which the light's contribution is forced to zero.
   * three applies a windowed falloff to this distance; 0 would mean infinite
   * and make every fragment in the scene pay for a lantern it cannot see.
   */
  range: number;
  /** inverse-square when 2. Physical; leave it unless you know why. */
  decay: number;
  /**
   * PENDULUM. `cordLength` sets the natural period, 2π√(L/g): 1.19 s at
   * 0.35 m. Keep it well clear of the hull's own 7.17 s roll and 5.43 s heave
   * (measured) — a lantern near resonance with the sea swings enormously and
   * reads as broken rather than as alive.
   */
  cordLength: number;
  /**
   * Damping ratio ζ. 0.06 is deliberately LOW: the lag and the overshoot are
   * the entire effect, and anything near critical (1.0) gives a lantern that
   * tracks the deck like it is welded to it. Above ~0.3 the swing dies inside
   * one roll and the request is not answered.
   */
  damping: number;
  /** hard stop on the swing (radians from vertical) — the cord goes taut */
  maxSwing: number;
  /**
   * §V44 cap on the accelerating-frame drive, in g. The sim's acceleration is
   * a DIFFERENTIATED channel fed by grounding impacts (§B.24 measured 100× the
   * ship's weight before it was capped) and cannon recoil, so it is bounded
   * before it reaches the pendulum rather than after.
   */
  maxDriveG: number;
  /**
   * FLICKER. The rate varies, so the phase is accumulated, never `time ×
   * rate` (§V.55, §B.30). Depth is bounded at source in flickerLevel().
   */
  flickerHz: number;
  flickerDepth: number;
  /** radius of the glowing bulb mesh (m) */
  bulbRadius: number;
  /**
   * Emissive multiplier on the bulb. The bulb is the only part of a lantern
   * you look AT rather than look BY, so it has to read as a source: bright
   * enough to survive ACES, bounded so it does not smear the whole stern
   * through the bloom threshold (§V44 — postPipeline clamps bloom input, but
   * an additive term is still meant to be bounded at ITS OWN source).
   */
  emissive: number;
}

export const lanternParams: LanternParams = registerParams(
  'lanterns',
  {
    // three's punctual lights are physical: irradiance = intensity / d².
    // At 2 m this gives 2.5, comparable to the noon sun's directional 3.4 —
    // a lantern really is brighter than daylight at arm's length. At 6 m it
    // is 0.28, which sits just under the full moon's key of 0.75, so the pool
    // of light reads as local without erasing the moonlit scene around it.
    intensity: 10,
    // candle/oil flame, ~1900 K. Deliberately far warmer and more saturated
    // than the moon's cool key: the CONTRAST between the two is what sells a
    // warm practical against a cold night, and it is the whole reason a
    // lantern reads at all once the sun is down.
    color: 0xff9a3c,
    // beyond ~18 m the 1/d² term is under 0.03 and invisible against the
    // moon's ambient, so the window costs nothing visually and bounds how
    // much of the scene pays for the light
    range: 18,
    decay: 2,
    cordLength: 0.35,
    damping: 0.06,
    maxSwing: 0.5, // 28.6°
    maxDriveG: 2,
    flickerHz: 4.5,
    // 0.22 is a visible breath, not a strobe. Past ~0.4 it reads as a fault
    // in the light rather than as a flame.
    flickerDepth: 0.22,
    bulbRadius: 0.09,
    emissive: 2.4,
  },
  {
    intensity: { min: 0, max: 60, step: 0.5 },
    range: { min: 1, max: 80, step: 1 },
    decay: { min: 0, max: 4, step: 0.1 },
    cordLength: { min: 0.05, max: 3, step: 0.01 },
    damping: { min: 0, max: 1, step: 0.01 },
    maxSwing: { min: 0.05, max: 1.4, step: 0.01 },
    maxDriveG: { min: 0, max: 10, step: 0.1 },
    flickerHz: { min: 0, max: 20, step: 0.1 },
    flickerDepth: { min: 0, max: 1, step: 0.01 },
    bulbRadius: { min: 0.02, max: 0.5, step: 0.01 },
    emissive: { min: 0, max: 12, step: 0.1 },
  },
);
