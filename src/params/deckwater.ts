/**
 * Deck water tunables (§V16: every tunable in a params module, no shader
 * magic constants). Consumed by src/deckwater/* (§V9: Mei 2-pass shallow
 * water — outflow biased by ship rotation, B=volume G=wetness, constant
 * evaporation per step so the deck dries).
 */
import { registerParams, type ParamMeta } from './registry';

export interface DeckWaterParams {
  /** grid cells along ship length (x) */
  gridWidth: number;
  /** grid cells across the beam (y) */
  gridHeight: number;
  /** fraction of head difference moved per second (per-dt scaled in update) */
  fluxRate: number;
  /** head units added per unit tilt gradient — rocking slosh strength (§V9) */
  tiltBiasStrength: number;
  /** volume units evaporated per second (§V9: deck dries) */
  evapVolume: number;
  /** wetness units evaporated per second — slower than volume so wet planks linger */
  evapWetness: number;
  /** volume → wetness transfer gain (wetness = max(wetness, volume*gain)) */
  wetnessGain: number;
  /** splash splat gaussian radius in cells */
  splashRadius: number;
  /** deck heightfield: camber crown height at beam center (height units) */
  camberHeight: number;
  /** plank seam groove depth (height units) */
  plankGrooveDepth: number;
  /** cells between plank seams (planks run lengthwise) */
  plankSpacing: number;
  /** raised rail height at deck edges — water pools before scupper drain */
  railHeight: number;
  /** scupper gaps per side rail (rail cut to deck level → drains overboard) */
  scupperCount: number;
}

export const deckWaterParams: DeckWaterParams = registerParams(
  'deckwater',
  {
    gridWidth: 512,
    gridHeight: 192,
    fluxRate: 18,
    tiltBiasStrength: 0.25,
    evapVolume: 0.05,
    evapWetness: 0.012,
    wetnessGain: 30,
    splashRadius: 6,
    camberHeight: 0.03,
    plankGrooveDepth: 0.008,
    plankSpacing: 8,
    railHeight: 0.15,
    scupperCount: 4,
  },
  deckWaterParamsMeta(),
);

function deckWaterParamsMeta(): Partial<Record<keyof DeckWaterParams, ParamMeta>> {
  return {
    fluxRate: { min: 0, max: 60, step: 0.5 },
    tiltBiasStrength: { min: 0, max: 2, step: 0.01 },
    evapVolume: { min: 0, max: 0.5, step: 0.001 },
    evapWetness: { min: 0, max: 0.2, step: 0.001 },
    wetnessGain: { min: 0, max: 100, step: 0.5 },
    splashRadius: { min: 1, max: 32, step: 1 },
    camberHeight: { min: 0, max: 0.2, step: 0.005 },
    plankGrooveDepth: { min: 0, max: 0.05, step: 0.001 },
    plankSpacing: { min: 2, max: 32, step: 1 },
    railHeight: { min: 0, max: 0.5, step: 0.01 },
    scupperCount: { min: 0, max: 16, step: 1 },
  };
}
