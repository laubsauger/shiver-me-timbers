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
  /**
   * Fallback grid dims, used ONLY for the synthetic field. When the ship's
   * generated deck heightfield is supplied (it always is in-game) the field
   * dictates the dims and these are ignored — src/ship's DECK_FIELD_BEAM /
   * DECK_FIELD_LENGTH are the shared 192 × 512.
   * Axes: width = across the beam (ship x), height = along the length (ship z).
   */
  gridWidth: number;
  gridHeight: number;
  /**
   * A source texel whose water-domain coverage falls below this is off the
   * deck outline and becomes a drain. The grid is a rectangle and the deck is
   * not — the corners abreast of the stem are thin air.
   */
  maskDrainBelow: number;
  /**
   * How far below the deck's LOWEST point a drain cell's hydraulic head sits
   * (m). The waterway gutter is below deck datum, so a drain at datum would
   * stand higher than the gutter and water would pool in it rather than
   * running out through the freeing ports.
   */
  drainDrop: number;
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
  /**
   * DIMENSIONLESS gain on the rotation bias; 1 = the true physical slope.
   * See fluxMath's OutflowParams.cellSize — this is NOT a head offset, and
   * treating it as one overdrove heel to ~30× the deck's camber gradient and
   * slid the whole sheet to leeward as one uniform slab.
   */
  tiltBiasStrength: number;
  /** volume units evaporated per second (§V9: deck dries) */
  evapVolume: number;
  /** wetness units evaporated per second — slower than volume so wet planks linger */
  evapWetness: number;
  /**
   * Depth → wetness gain (wetness = max(wetness, depth × gain), capped at 1).
   * The reciprocal is the depth that reads as FULLY wet: at 30 that was 33 mm,
   * so every splash saturated G to 1 across everything it touched and the
   * whole deck sat at maximum wetness for the ~80 s it took to evaporate —
   * "too consistent across the whole deck at the same time". Keep 1/gain in
   * the range of a real film so wetness stays proportional to what is there.
   */
  wetnessGain: number;
  /** splash splat gaussian radius in cells */
  splashRadius: number;

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
  /**
   * PEAK added water depth at a splat centre for a full-strength burial, in
   * METRES — the same units as the deck heightfield, so it can be read
   * against the 0.028 m waterway and the 0.18 m hatch coamings it has to fill
   * before it spills. Green water on a deck is ankle-to-knee: ~0.05–0.25 m.
   */
  splashVolume: number;
  /** max burying slices injected per event (hard-capped at MAX_SPLASHES) */
  splashCount: number;
  /** how far aft of a burying station its water lands, as a fraction of deck length */
  splashSetback: number;
  /** keep splats this far (uv) off the grid border so they land inboard of the rails */
  splashMargin: number;
  /** how far toward the BURIED rail a splat leans, relative to the hull half-breadth there */
  splashBeamSpread: number;

  // ── §V9 deck material hook (roughness↓ / darker where wet) ──────────────
  /** albedo multiplier where the planks are wet — darker AND more saturated */
  wetTintColor: string;
  /** roughness multiplier at full wetness (§V9: roughness↓ where wet) */
  wetRoughness: number;
  /** plank-grain relief multiplier at full wetness — a water film fills the grain */
  wetRelief: number;
  /** grain relief multiplier under standing water — a pool drowns it entirely */
  poolRelief: number;
  /** standing-water depth (m) that reads as a full puddle (drives the pool terms) */
  poolDepthRef: number;
  /** albedo multiplier inside standing water, on top of wetTint */
  poolTintColor: string;
  /** roughness multiplier inside standing water — mirror-smooth */
  poolRoughness: number;
  /**
   * Water depth → ADDED bump height. Defaults to 0: a puddle surface is flat,
   * and feeding a 4.5 cm/texel field into a screen-space-differentiated
   * height turns it into speckle. Kept as a hook for a future low-passed rim
   * meniscus; raising it reintroduces the noise.
   */
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
    gridWidth: 192, // across the beam
    gridHeight: 512, // along the length
    maskDrainBelow: 0.5,
    drainDrop: 0.05,
    substeps: 2,
    fluxRate: 18,
    tiltBiasStrength: 1,
    evapVolume: 0.05,
    evapWetness: 0.05,
    wetnessGain: 7,
    splashRadius: 6,

    immersionSigma: 0.55,
    immersionFullSigma: 1.6,
    rearmSigma: 0.3,
    sigmaFloor: 0.05,
    speedThreshold: 2.5,
    speedFull: 7,
    burialRate: 0.9,
    burialRateFull: 3.5,
    refractory: 0.45,
    splashVolume: 0.11,
    splashCount: 5,
    splashSetback: 0.06,
    splashMargin: 0.04,
    splashBeamSpread: 0.8,

    wetTintColor: '#9b8b76',
    wetRoughness: 0.42,
    wetRelief: 0.45,
    poolRelief: 0.15,
    poolDepthRef: 0.05,
    poolTintColor: '#5d6a68',
    poolRoughness: 0.12,
    waterHeightScale: 0,
    deckBandInner: 0.3,
    deckBandOuter: 0.8,
  },
  deckWaterParamsMeta(),
);

function deckWaterParamsMeta(): Partial<Record<keyof DeckWaterParams, ParamMeta>> {
  return {
    substeps: { min: 2, max: 8, step: 2 }, // even only — see DeckWaterParams
    maskDrainBelow: { min: 0.05, max: 0.95, step: 0.05 },
    drainDrop: { min: 0.005, max: 0.5, step: 0.005 },
    fluxRate: { min: 0, max: 60, step: 0.5 },
    tiltBiasStrength: { min: 0, max: 4, step: 0.05 },
    evapVolume: { min: 0, max: 0.5, step: 0.001 },
    evapWetness: { min: 0, max: 0.2, step: 0.001 },
    wetnessGain: { min: 0, max: 40, step: 0.5 },
    splashRadius: { min: 1, max: 32, step: 1 },

    immersionSigma: { min: 0, max: 3, step: 0.05 },
    immersionFullSigma: { min: 0.1, max: 4, step: 0.05 },
    rearmSigma: { min: 0, max: 2, step: 0.05 },
    sigmaFloor: { min: 0.01, max: 1, step: 0.01 },
    speedThreshold: { min: 0, max: 12, step: 0.1 },
    speedFull: { min: 0.5, max: 20, step: 0.1 },
    burialRate: { min: 0, max: 8, step: 0.05 },
    burialRateFull: { min: 0.1, max: 12, step: 0.05 },
    refractory: { min: 0, max: 3, step: 0.05 },
    splashVolume: { min: 0, max: 1, step: 0.005 },
    splashCount: { min: 1, max: 8, step: 1 },
    splashSetback: { min: 0, max: 0.5, step: 0.005 },
    splashMargin: { min: 0, max: 0.3, step: 0.005 },
    splashBeamSpread: { min: 0, max: 2, step: 0.05 },

    wetRoughness: { min: 0.02, max: 1, step: 0.01 },
    wetRelief: { min: 0, max: 1, step: 0.01 },
    poolRelief: { min: 0, max: 1, step: 0.01 },
    poolDepthRef: { min: 0.005, max: 0.5, step: 0.005 },
    poolRoughness: { min: 0.02, max: 1, step: 0.01 },
    waterHeightScale: { min: 0, max: 4, step: 0.05 },
    deckBandInner: { min: 0, max: 3, step: 0.05 },
    deckBandOuter: { min: 0.05, max: 5, step: 0.05 },
  };
}
