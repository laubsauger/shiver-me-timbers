/**
 * Speedboat LED lighting tunables (§T.209, §V16). Consumed by `ocean/boatLightPool.ts` (the light pools every boat
 * throws on the water), `speedboat/assets/slotMaterials.ts` (the emissive hull + deck strips) and
 * `speedboat/page/boatLights.ts` (the player's real lights, the underwater glow). All levels are LINEAR radiance in the
 * scene's sun units (noon sun 3.4) and are multiplied by the LED level 0..1 (`sky.nightFactor`, or a cine override).
 */
import { registerParams } from './registry';

export interface BoatLightParams {
  /** emissive radiance of the hull underglow strip and the deck courtesy strip at full level */
  stripNits: number;
  deckStripNits: number;
  /** submerged hull-side strip, below the authored boot line */
  submergedStripNits: number;
  /** strip widths (m) */
  hullStripWidth: number;
  deckStripWidth: number;
  /** water light pool: ellipse half-length / half-beam (m) around each boat, and its peak radiance */
  poolLength: number;
  poolWidth: number;
  poolIntensity: number;
  /** coloured glints of the LEDs on the wave facets: Blinn exponent and peak */
  poolSpecPower: number;
  poolSpecIntensity: number;
  /**
   * §T.209 the strip as a LINE source for the pool's diffuse and glints (not a point): half-length along the boat and
   * half-beam out to the sheer (m). The water reads the strip's reflection, lit ripples and dark troughs, instead of a
   * flat coloured sheet.
   */
  poolStripHalfLength: number;
  poolStripHalfBeam: number;
  /** extra pool light on foam (wake, spray-laid foam scatters much more than clear water) */
  poolFoamGain: number;
  /** the player's two real point lights (port + starboard, at the waterline): intensity (cd) and range (m) */
  playerLightIntensity: number;
  playerLightRange: number;
  /** additive underwater glow under every hull: radiance and size multiplier of the hull's plan */
  glowIntensity: number;
  glowScale: number;
  /** §T.209 night fill on every hull (moon hue × nightFactor): Fresnel rim radiance and albedo sky-fill factor */
  nightRim: number;
  nightFill: number;
  /** §T.209 the pilot's fill in his boat's LED colour (× albedo × LED level; slotMaterials.ts `pilotLedFillNode`) */
  pilotLedFill: number;
}

export const boatLightParams: BoatLightParams = registerParams(
  'boatLights',
  {
    stripNits: 8,
    deckStripNits: 6,
    submergedStripNits: 3,
    hullStripWidth: 0.035,
    deckStripWidth: 0.018,
    poolLength: 9,
    poolWidth: 4.5,
    poolIntensity: 0.3,
    poolSpecPower: 140,
    poolSpecIntensity: 2.2,
    poolStripHalfLength: 5.2,
    poolStripHalfBeam: 1.3,
    poolFoamGain: 2.5,
    // with page/boatLights.ts HERO_LIGHT_STANDOFF: bounds the peak on her own white topside (see there)
    playerLightIntensity: 3,
    playerLightRange: 6,
    glowIntensity: 0.18,
    glowScale: 1.5,
    nightRim: 0.05,
    nightFill: 0.04,
    pilotLedFill: 0.35,
  },
  {
    stripNits: { min: 0, max: 60, step: 0.5 },
    deckStripNits: { min: 0, max: 60, step: 0.5 },
    submergedStripNits: { min: 0, max: 20, step: 0.25 },
    hullStripWidth: { min: 0.005, max: 0.15, step: 0.005 },
    deckStripWidth: { min: 0.005, max: 0.1, step: 0.002 },
    poolLength: { min: 1, max: 30, step: 0.5 },
    poolWidth: { min: 1, max: 15, step: 0.25 },
    poolIntensity: { min: 0, max: 3, step: 0.01 },
    poolSpecPower: { min: 4, max: 512, step: 1 },
    poolSpecIntensity: { min: 0, max: 10, step: 0.05 },
    poolStripHalfLength: { min: 0, max: 10, step: 0.1 },
    poolStripHalfBeam: { min: 0, max: 3, step: 0.05 },
    poolFoamGain: { min: 0, max: 10, step: 0.1 },
    playerLightIntensity: { min: 0, max: 400, step: 1 },
    playerLightRange: { min: 1, max: 60, step: 0.5 },
    glowIntensity: { min: 0, max: 5, step: 0.05 },
    glowScale: { min: 0.5, max: 4, step: 0.05 },
    nightRim: { min: 0, max: 1, step: 0.005 },
    nightFill: { min: 0, max: 0.5, step: 0.005 },
    pilotLedFill: { min: 0, max: 2, step: 0.01 },
  },
);
