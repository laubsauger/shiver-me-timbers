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

  // -- shore runup / swash (T33 "waves lapping on the beach") ---------------
  /**
   * The runup is an ANALYTIC swash model in the sand material, not a decal:
   * each wave cycle rushes a waterline `runupLevel` up the beach, then drains
   * back slower than it came. Three bands come out of it — the wetted sheet
   * currently under water, the foam line riding the moving edge, and the wet
   * sand the last few waves left behind, drying out at `dryTime`. Levels are
   * in METERS OF ELEVATION above the waterline, which maps to horizontal
   * distance by the local beach slope, so a flat apron gets a long swash and
   * a steep one a short slap for free.
   */
  runupEnabled: boolean;
  /** seconds per swash cycle at the reference swell (set period) */
  runupPeriod: number;
  /** fraction of the cycle spent rushing up (the rest drains back) */
  runupRiseFraction: number;
  /** runup height (m above waterline) of the weakest / strongest wave in a set */
  runupHeightMin: number;
  runupHeightMax: number;
  /** how strongly live swell amplitude (≈Hs/2) scales the runup, 0 = ignore the sea */
  runupSwellResponse: number;
  /** alongshore phase noise scale (1/m) — decorrelates the swash round the
   *  island so it never reads as one synchronized ring */
  runupPhaseScale: number;
  /** vertical feather (m) of the wet-sheet edge */
  runupSheetFeather: number;
  /** turquoise sheen of the thin water sheet over sand */
  sheetColor: number;
  sheetStrength: number;
  /** vertical thickness (m) of the bright foam line riding the swash edge */
  swashFoamWidth: number;
  swashFoamColor: number;
  swashFoamStrength: number;
  /** residual foam left on the sand behind a retreating wave (0..1) */
  swashResidualStrength: number;
  /** lacy break-up noise scale (1/m) + strength for the foam edge */
  swashFoamNoiseScale: number;
  swashFoamNoiseStrength: number;
  /** seconds for wet sand left by a wave to dry back out */
  dryTime: number;
  /**
   * Receive §V34 water lighting on the terrain — sun caustics over the
   * shallows, sea bounce-fill, depth absorption. BUILD-TIME (it branches the
   * node graph, like `runupEnabled`): flipping it needs a material rebuild.
   * Kept as a switch because the shallows are the largest caustics receiver in
   * the scene by screen coverage, so this is the first thing to bisect if the
   * frame time moves when you moor next to a beach (§V17).
   *
   * It also decides where the still-water level comes from. ON: the live
   * displaced FFT surface, per fragment, shared with the caustics call — so
   * the swash waterline follows the actual waves. OFF: the flat `waterline`
   * uniform.
   */
  receiveCaustics: boolean;
  /**
   * Half-width (m) of the band around the waterline over which §V34 water
   * lighting fades out going up the beach.
   *
   * WHY THIS EXISTS: `mode: 'below'` hard-codes the caustics module's own
   * `submerged` term to 1 — correct for a seabed, wrong for terrain, because
   * ONE material here shades everything from the −45 m seabed to a +35 m
   * peak. Without this gate `belowSpan` clamps to `minDepth` on dry ground and
   * the depth budget (`maxDepth`) only culls water that is too DEEP, so a
   * hilltop gets lit as though it sat just under the surface. Caustics
   * crawling over dry sand and dunes is exactly the kind of thing that reads
   * as "silly" (§V43).
   */
  causticsWaterlineBand: number;

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

    runupEnabled: true,
    runupPeriod: 8.5,
    runupRiseFraction: 0.32,
    runupHeightMin: 0.35,
    runupHeightMax: 1.5,
    runupSwellResponse: 0.55,
    runupPhaseScale: 0.012,
    runupSheetFeather: 0.12,
    sheetColor: 0x2fb9ae,
    sheetStrength: 0.55,
    swashFoamWidth: 0.22,
    swashFoamColor: 0xf4fbf7,
    swashFoamStrength: 1.0,
    swashResidualStrength: 0.45,
    swashFoamNoiseScale: 0.6,
    swashFoamNoiseStrength: 0.7,
    dryTime: 11,
    receiveCaustics: true,
    causticsWaterlineBand: 0.6,

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
    causticsWaterlineBand: { min: 0.05, max: 5, step: 0.05 },
    runupPeriod: { min: 2, max: 25, step: 0.1 },
    runupRiseFraction: { min: 0.05, max: 0.8, step: 0.01 },
    runupHeightMin: { min: 0, max: 4, step: 0.05 },
    runupHeightMax: { min: 0, max: 8, step: 0.05 },
    runupSwellResponse: { min: 0, max: 2, step: 0.05 },
    runupPhaseScale: { min: 0.001, max: 0.1, step: 0.001 },
    runupSheetFeather: { min: 0.01, max: 1, step: 0.01 },
    sheetStrength: { min: 0, max: 1, step: 0.01 },
    swashFoamWidth: { min: 0.02, max: 1.5, step: 0.01 },
    swashFoamStrength: { min: 0, max: 3, step: 0.05 },
    swashResidualStrength: { min: 0, max: 1, step: 0.01 },
    swashFoamNoiseScale: { min: 0.05, max: 4, step: 0.05 },
    swashFoamNoiseStrength: { min: 0, max: 1, step: 0.01 },
    dryTime: { min: 0.5, max: 60, step: 0.5 },
    slopeThreshold: { min: 0.2, max: 0.95, step: 0.01 },
    slopeBlendWidth: { min: 0.01, max: 0.4, step: 0.01 },
    slopeNoiseAmount: { min: 0, max: 0.5, step: 0.01 },
  };
}
