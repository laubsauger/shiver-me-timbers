/**
 * Terrain material tunables (§V16: every tunable lives in a params module and
 * appears in Tweakpane; shader magic constants forbidden). Consumed by
 * src/terrain/* (T27 materials, T20 island geometry).
 *
 * Colors are hex numbers (same convention as params/clouds.ts). The debug
 * panel mutates this object in place; material handles copy values into GPU
 * uniforms via their `updateFromParams()` — call it per frame or on change.
 */
import { registerParams, type ParamMeta } from './registry';

export interface TerrainParams {
  // -- shared procedural noise (mirrored on CPU in terrain/noiseCpu.ts) -----
  /** fbm octave count used when building material node graphs (2..4) */
  noiseOctaves: number;
  /** per-octave frequency multiplier */
  noiseLacunarity: number;
  /** per-octave amplitude multiplier */
  noiseGain: number;
  /** tri-planar blend sharpness (higher = tighter plane transitions) */
  triplanarSharpness: number;

  // -- rock (chunky stylized, soft-beveled — docs/ship-full-view.png) -------
  /** world-space noise frequency on rock (1/m) */
  rockScale: number;
  /** color band count for the painterly stepped shading */
  rockBands: number;
  /** 0 = hard posterize bands, 1 = fully smooth (no banding) */
  rockBandSoftness: number;
  /** base grey-tan */
  rockBaseColor: number;
  /** warm sun-bleached top catch */
  rockTopColor: number;
  /** dark crevice/cavity tint */
  rockCreviceColor: number;
  /** low-frequency cavity noise scale (1/m) */
  rockCreviceScale: number;
  /** how strongly cavities pull toward creviceColor (0..1) */
  rockCreviceStrength: number;
  /** exponent shaping the upward-face highlight falloff */
  rockTopPower: number;
  /** strength of the top/sun-catch tint (0..1) */
  rockTopStrength: number;
  /** extra darkening on steep side faces (0..1) */
  rockSideDarken: number;
  rockRoughness: number;

  // -- sand (bright warm beach) ---------------------------------------------
  /** warm bright base */
  sandBaseColor: number;
  /** darker warm shade mixed in by large-scale noise */
  sandShadeColor: number;
  /** large hue-variation noise scale (1/m) */
  sandShadeScale: number;
  /** fine grain noise scale (1/m) */
  sandGrainScale: number;
  /** grain brightness modulation amount (0..1) */
  sandGrainStrength: number;
  /** sparkle cells per meter */
  sparkleDensity: number;
  /** fraction of cells that can glint (0..1) */
  sparkleCoverage: number;
  /** specular exponent of a glint (higher = tighter) */
  sparklePower: number;
  /** glint brightness multiplier */
  sparkleStrength: number;
  sandRoughnessDry: number;
  sandRoughnessWet: number;

  // -- shore wetness band ----------------------------------------------------
  /** world Y of the water surface the wet band hugs (m) */
  waterline: number;
  /** vertical width of the wet gradient above the waterline (m) */
  wetBand: number;
  /** how much wet sand darkens (0..1) */
  wetDarken: number;

  // -- slope blend (sand on flat, rock on steep) — terrainBlendMaterial -----
  /** normal.y at the sand↔rock midpoint (1 = flat up, 0 = vertical) */
  slopeThreshold: number;
  /** half-width of the smooth blend around the threshold */
  slopeBlendWidth: number;
  /** noise jitter on the blend edge so the border is not a clean line */
  slopeNoiseAmount: number;
}

export const terrainParams: TerrainParams = registerParams(
  'terrain',
  {
    noiseOctaves: 3,
    noiseLacunarity: 2.0,
    noiseGain: 0.5,
    triplanarSharpness: 4.0,

    rockScale: 0.16,
    rockBands: 5,
    rockBandSoftness: 0.45,
    rockBaseColor: 0x9a8f7c,
    rockTopColor: 0xd9c9a8,
    rockCreviceColor: 0x55483d,
    rockCreviceScale: 0.05,
    rockCreviceStrength: 0.55,
    rockTopPower: 2.2,
    rockTopStrength: 0.7,
    rockSideDarken: 0.3,
    rockRoughness: 0.92,

    sandBaseColor: 0xecd9ab,
    sandShadeColor: 0xd0b382,
    sandShadeScale: 0.045,
    sandGrainScale: 14,
    sandGrainStrength: 0.1,
    sparkleDensity: 6,
    sparkleCoverage: 0.06,
    sparklePower: 26,
    sparkleStrength: 1.4,
    sandRoughnessDry: 0.95,
    sandRoughnessWet: 0.3,

    waterline: 0.0,
    wetBand: 1.4,
    wetDarken: 0.35,

    slopeThreshold: 0.72,
    slopeBlendWidth: 0.1,
    slopeNoiseAmount: 0.12,
  },
  terrainParamsMeta(),
);

function terrainParamsMeta(): Partial<Record<keyof TerrainParams, ParamMeta>> {
  return {
    noiseOctaves: { min: 2, max: 4, step: 1 },
    noiseLacunarity: { min: 1.5, max: 3, step: 0.1 },
    noiseGain: { min: 0.2, max: 0.8, step: 0.05 },
    triplanarSharpness: { min: 1, max: 12, step: 0.5 },
    rockScale: { min: 0.02, max: 1, step: 0.01 },
    rockBands: { min: 2, max: 10, step: 1 },
    rockBandSoftness: { min: 0, max: 1, step: 0.05 },
    rockCreviceScale: { min: 0.01, max: 0.5, step: 0.005 },
    rockCreviceStrength: { min: 0, max: 1, step: 0.05 },
    rockTopPower: { min: 0.5, max: 8, step: 0.1 },
    rockTopStrength: { min: 0, max: 1, step: 0.05 },
    rockSideDarken: { min: 0, max: 1, step: 0.05 },
    rockRoughness: { min: 0, max: 1, step: 0.01 },
    sandShadeScale: { min: 0.005, max: 0.5, step: 0.005 },
    sandGrainScale: { min: 1, max: 60, step: 1 },
    sandGrainStrength: { min: 0, max: 0.5, step: 0.01 },
    sparkleDensity: { min: 0.5, max: 30, step: 0.5 },
    sparkleCoverage: { min: 0, max: 0.5, step: 0.01 },
    sparklePower: { min: 2, max: 128, step: 1 },
    sparkleStrength: { min: 0, max: 4, step: 0.05 },
    sandRoughnessDry: { min: 0, max: 1, step: 0.01 },
    sandRoughnessWet: { min: 0, max: 1, step: 0.01 },
    waterline: { min: -5, max: 5, step: 0.05 },
    wetBand: { min: 0, max: 5, step: 0.05 },
    wetDarken: { min: 0, max: 1, step: 0.05 },
    slopeThreshold: { min: 0.2, max: 0.95, step: 0.01 },
    slopeBlendWidth: { min: 0.01, max: 0.4, step: 0.01 },
    slopeNoiseAmount: { min: 0, max: 0.5, step: 0.01 },
  };
}
