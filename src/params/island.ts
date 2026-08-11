/**
 * Island tunables (T20, §V16: every tunable lives in a params module and
 * appears in Tweakpane — no magic constants in generation code or shaders).
 * Consumed by src/island/* — heightmap shape, mesh skirt, palm/rock scatter.
 *
 * Shape values (radius…rimDepth, rock geometry values) are read at BUILD time:
 * a live panel tweak needs a createIsland() rebuild to show. Material tunables
 * live in params/terrain.ts and params/vegetation.ts and stay live per frame.
 */
import { registerParams, type ParamMeta } from './registry';

export interface IslandParams {
  // -- footprint + heightmap grid -------------------------------------------
  /** island footprint radius (m); heightmap spans [-radius, radius]² */
  radius: number;
  /** heightmap grid resolution per side (vertices) */
  gridSize: number;

  // -- dome shape ------------------------------------------------------------
  /** target peak height above waterline (m) */
  peakHeight: number;
  /** guaranteed minimum interior peak (m) — grid rescales if noise undershoots */
  minPeakHeight: number;
  /** radial falloff exponent (higher = flatter top, steeper flanks) */
  falloffPower: number;

  // -- heightmap fbm (uses terrain/noiseCpu) ---------------------------------
  /** world-space noise frequency (1/m) */
  noiseScale: number;
  /** relative height modulation, must stay < 1 (0 = pure dome) */
  noiseStrength: number;
  noiseOctaves: number;

  // -- optional secondary peak (0 height disables) ---------------------------
  secondaryPeakHeight: number;
  /** gaussian sigma as fraction of radius */
  secondaryPeakRadius: number;
  /** peak center distance from island center, fraction of radius */
  secondaryPeakOffset: number;

  // -- beach apron (gentle 0..~band slope where height crosses waterline) ----
  /** height band (m) around waterline that gets flattened */
  beachBandWidth: number;
  /** slope multiplier at the waterline (0 = dead flat, 1 = no apron) */
  beachFlatness: number;

  // -- submerged rim + mesh skirt --------------------------------------------
  /** guaranteed depth (m) of the island boundary below waterline */
  rimDepth: number;
  /** skirt bottom depth (m below waterline) so no gap shows at the shore */
  skirtDepth: number;

  // -- palms -----------------------------------------------------------------
  palmCount: number;
  /** fraction of palms biased onto the beach ring vs sparse interior */
  palmBeachFraction: number;
  /** how far inland from the shoreline beach palms sit (m) */
  palmBeachSetback: number;
  /** interior palm scatter disc radius, fraction of island radius */
  palmInteriorRadius: number;
  /** max terrain gradient |∇h| (m/m) a palm accepts */
  palmSlopeLimit: number;
  /** min terrain height above waterline (m) a palm accepts */
  palmMinHeight: number;

  // -- rocks -----------------------------------------------------------------
  rockCount: number;
  /** radial jitter around the shoreline (m); negative→inland, positive→sea */
  rockSpread: number;
  rockMinScale: number;
  rockMaxScale: number;
  /** vertical squash range (rock height = scale × squash) */
  rockSquashMin: number;
  rockSquashMax: number;
  /** per-vertex radial perturbation amplitude (fraction of radius) */
  rockNoiseAmp: number;
  /** perturbation noise frequency on the unit icosahedron */
  rockNoiseFreq: number;
  rockNoiseOctaves: number;
  /** icosahedron subdivision level */
  rockDetail: number;
  /** distinct deformed geometries shared across rock meshes */
  rockGeoVariants: number;
  /** how deep a rock sinks into the ground, fraction of its half-height */
  rockEmbed: number;
}

export const islandParams: IslandParams = registerParams(
  'island',
  {
    radius: 90,
    gridSize: 128,
    peakHeight: 26,
    minPeakHeight: 12,
    falloffPower: 2.2,
    noiseScale: 0.035,
    noiseStrength: 0.45,
    noiseOctaves: 4,
    secondaryPeakHeight: 10,
    secondaryPeakRadius: 0.18,
    secondaryPeakOffset: 0.42,
    beachBandWidth: 2.0,
    beachFlatness: 0.3,
    rimDepth: 6,
    skirtDepth: 8,
    palmCount: 28,
    palmBeachFraction: 0.7,
    palmBeachSetback: 5,
    palmInteriorRadius: 0.55,
    palmSlopeLimit: 0.55,
    palmMinHeight: 0.3,
    rockCount: 14,
    rockSpread: 7,
    rockMinScale: 0.8,
    rockMaxScale: 3.0,
    rockSquashMin: 0.55,
    rockSquashMax: 0.9,
    rockNoiseAmp: 0.35,
    rockNoiseFreq: 1.4,
    rockNoiseOctaves: 3,
    rockDetail: 2,
    rockGeoVariants: 4,
    rockEmbed: 0.35,
  },
  islandParamsMeta(),
);

function islandParamsMeta(): Partial<Record<keyof IslandParams, ParamMeta>> {
  return {
    radius: { min: 20, max: 400, step: 5 },
    gridSize: { min: 32, max: 512, step: 16 },
    peakHeight: { min: 4, max: 80, step: 1 },
    minPeakHeight: { min: 1, max: 60, step: 1 },
    falloffPower: { min: 0.5, max: 6, step: 0.1 },
    noiseScale: { min: 0.005, max: 0.2, step: 0.005 },
    noiseStrength: { min: 0, max: 0.8, step: 0.05 },
    noiseOctaves: { min: 1, max: 6, step: 1 },
    secondaryPeakHeight: { min: 0, max: 40, step: 1 },
    secondaryPeakRadius: { min: 0.05, max: 0.5, step: 0.01 },
    secondaryPeakOffset: { min: 0, max: 0.8, step: 0.02 },
    beachBandWidth: { min: 0.2, max: 6, step: 0.1 },
    beachFlatness: { min: 0.05, max: 1, step: 0.05 },
    rimDepth: { min: 1, max: 20, step: 0.5 },
    skirtDepth: { min: 2, max: 30, step: 0.5 },
    palmCount: { min: 0, max: 120, step: 1 },
    palmBeachFraction: { min: 0, max: 1, step: 0.05 },
    palmBeachSetback: { min: 0, max: 30, step: 0.5 },
    palmInteriorRadius: { min: 0.1, max: 0.9, step: 0.05 },
    palmSlopeLimit: { min: 0.1, max: 1.5, step: 0.05 },
    palmMinHeight: { min: 0, max: 5, step: 0.05 },
    rockCount: { min: 0, max: 64, step: 1 },
    rockSpread: { min: 0, max: 30, step: 0.5 },
    rockMinScale: { min: 0.2, max: 6, step: 0.1 },
    rockMaxScale: { min: 0.2, max: 10, step: 0.1 },
    rockSquashMin: { min: 0.2, max: 1.5, step: 0.05 },
    rockSquashMax: { min: 0.2, max: 1.5, step: 0.05 },
    rockNoiseAmp: { min: 0, max: 0.8, step: 0.05 },
    rockNoiseFreq: { min: 0.2, max: 6, step: 0.1 },
    rockNoiseOctaves: { min: 1, max: 5, step: 1 },
    rockDetail: { min: 1, max: 4, step: 1 },
    rockGeoVariants: { min: 1, max: 8, step: 1 },
    rockEmbed: { min: 0, max: 1, step: 0.05 },
  };
}
