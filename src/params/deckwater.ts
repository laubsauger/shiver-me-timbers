/**
 * Deck water tunables (§V16: every tunable in a params module, no shader
 * magic constants). Consumed by src/deckwater/* (§V9: Mei 2-pass shallow
 * water — outflow biased by ship rotation, B=volume G=wetness, constant
 * evaporation per step so the deck dries).
 */
import { registerParams, type ParamMeta } from './registry';

export interface DeckWaterParams {
  /** master switch — false compiles the deck material hook out entirely */
  enabled: boolean;
  /** grid cells along ship length (x) */
  gridWidth: number;
  /** grid cells across the beam (y) */
  gridHeight: number;
  /**
   * Solver substeps per update. MUST be even: the ping-pong lands back on the
   * front texture, so the material's sampler never changes binding mid-flight
   * (flowfoam does the same by keeping texA permanently front). Also halves
   * the effective flux per pass, which is what keeps the explicit scheme from
   * ringing when Tweakpane pushes fluxRate up.
   */
  substeps: number;
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

  // ── §V27 bow-immersion sensor: EVENT gates, not a passive emitter ───────
  /**
   * Immersion (m) at which green water starts coming aboard, as a multiple of
   * the live sea σ (`ocean.heightRms`). §V36: an absolute metre gate silently
   * changes meaning when the spectrum moves — §B.12 twice over.
   */
  immersionSigma: number;
  /** immersion (× σ) at which the event is at full strength */
  immersionFullSigma: number;
  /** the bow must be REBURIED from shallower than this (× σ) before it can fire again */
  rearmSigma: number;
  /** σ floor (m) so a dead-flat calm cannot divide the gate to zero (§V28) */
  sigmaFloor: number;
  /** hull speed (m/s) below which the bow shoulders water aside instead of scooping it */
  speedThreshold: number;
  /** hull speed (m/s) at which the speed term saturates */
  speedFull: number;
  /**
   * Burial rate (m/s) the stem must exceed. THIS is the gate that keeps §V27
   * satisfied: the bow is immersed most of the time at speed, so immersion
   * alone would splash every tick — a passive emitter by another name. Only a
   * stem actually driving UNDER throws water onto the deck.
   */
  burialRate: number;
  /** burial rate (m/s) at which the impact term saturates */
  burialRateFull: number;
  /** seconds the sensor stays deaf after firing (one event per wave, not per tick) */
  refractory: number;
  /** volume injected by a full-strength event, split across splashCount splats */
  splashVolume: number;
  /** splats laid across the beam per event (≤ MAX_SPLASHES) */
  splashCount: number;
  /** how far aft of the stem crossing the sheet lands, as a fraction of deck length */
  splashSetback: number;
  /** keep splats this far (uv) off the grid border so they land inboard of the rails */
  splashMargin: number;
  /** beam fraction the sheet spreads over, relative to the hull half-breadth there */
  splashBeamSpread: number;

  // ── §V9 deck material hook (roughness↓ / darker where wet) ──────────────
  /** albedo multiplier where the planks are wet — darker AND more saturated */
  wetTintColor: string;
  /** roughness multiplier at full wetness (§V9: roughness↓ where wet) */
  wetRoughness: number;
  /** plank-grain relief multiplier at full wetness — a water film flattens grain */
  wetRelief: number;
  /** standing-water volume that reads as a full puddle (drives the pool terms) */
  poolDepthRef: number;
  /** albedo multiplier inside standing water, on top of wetTint */
  poolTintColor: string;
  /** roughness multiplier inside standing water — mirror-smooth */
  poolRoughness: number;
  /** water-layer thickness → relief height gain (puddle rims catch the light) */
  waterHeightScale: number;
  /** ship-local |y − deckPlaneY| where the wet hook is still at full strength (m) */
  deckBandInner: number;
  /** ship-local |y − deckPlaneY| where the wet hook has faded out (m) */
  deckBandOuter: number;
}

export const deckWaterParams: DeckWaterParams = registerParams(
  'deckwater',
  {
    enabled: true,
    gridWidth: 512,
    gridHeight: 192,
    substeps: 2,
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

    immersionSigma: 0.55,
    immersionFullSigma: 1.6,
    rearmSigma: 0.3,
    sigmaFloor: 0.05,
    speedThreshold: 2.5,
    speedFull: 7,
    burialRate: 0.9,
    burialRateFull: 3.5,
    refractory: 0.45,
    splashVolume: 2.4,
    splashCount: 5,
    splashSetback: 0.06,
    splashMargin: 0.04,
    splashBeamSpread: 0.8,

    wetTintColor: '#7a6b58',
    wetRoughness: 0.28,
    wetRelief: 0.3,
    poolDepthRef: 0.05,
    poolTintColor: '#5d6a68',
    poolRoughness: 0.12,
    waterHeightScale: 0.6,
    deckBandInner: 0.3,
    deckBandOuter: 0.8,
  },
  deckWaterParamsMeta(),
);

function deckWaterParamsMeta(): Partial<Record<keyof DeckWaterParams, ParamMeta>> {
  return {
    substeps: { min: 2, max: 8, step: 2 }, // even only — see DeckWaterParams
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
