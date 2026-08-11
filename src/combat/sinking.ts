/**
 * Sink sequence (T18, §V14) — the stages a hull passes through between the
 * first hole and the seabed, all derived from the single `ShipState.flood`
 * scalar so nothing new has to be replicated for multiplayer (§V.2).
 *
 * The physics of the sequence already lives in sea-physics: flood adds mass
 * (rides lower), the flooded holes' mean offset makes a couple (lists toward
 * the breach), and buoyancy support ramps 1 → 0 across sinkThreshold → 1
 * (settles under instead of bobbing). This module supplies the two things
 * that pure force model cannot:
 *
 *  1. CONTROL. A ship with her gunports under does not answer the helm. The
 *     sails come off her and the rudder goes slack, progressively, so the
 *     last half-minute is spent watching her go rather than sailing a
 *     submarine.
 *  2. A BOTTOM. Support and probe damping both vanish at flood = 1, so the
 *     wreck is in free fall with nothing opposing it. Left alone she is a
 *     kilometre down inside a minute — past camera.far, with a velocity that
 *     dwarfs every other term in the integrator and nothing to bring it back.
 *     stepSinkSettle is the floor under that fall.
 *
 * Pure sim: plain numbers, no three.js, deterministic under a fixed tick.
 */
import type { ShipState } from '../state/simState';
import { floodingParams, type FloodingParams } from '../params/flooding';

/**
 * dry        — no water in her
 * damaged    — taking water, pumps still in the fight
 * sinking    — past the point of no return, still under command
 * foundering — decks awash, helm and sheets gone
 * sunk       — under, settling to her rest
 */
export type SinkPhase = 'dry' | 'damaged' | 'sinking' | 'foundering' | 'sunk';

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** fraction of the sinkThreshold→1 run completed; 0 while recoverable */
function sinkProgress(flood: number, p: FloodingParams): number {
  if (flood < p.sinkThreshold) return 0;
  const range = Math.max(1e-6, 1 - p.sinkThreshold);
  return clamp01((flood - p.sinkThreshold) / range);
}

export function sinkPhase(ship: ShipState, p: FloodingParams = floodingParams): SinkPhase {
  const flood = clamp01(ship.flood);
  if (flood >= 1) return 'sunk';
  if (flood < p.sinkThreshold) return flood > 0 ? 'damaged' : 'dry';
  return sinkProgress(flood, p) >= clamp01(p.founderFraction) ? 'foundering' : 'sinking';
}

/** flood = 1: she is under. The one terminal condition, no params needed. */
export function isSunk(ship: ShipState): boolean {
  return clamp01(ship.flood) >= 1;
}

/**
 * How much of the helm and the sheets still answer, 1 → 0. Full authority
 * until the sink sequence starts, then a linear fade that reaches 0 exactly
 * when the ship founders — multiply it into rudder and sail-trim commands.
 */
export function controlAuthority(
  ship: ShipState,
  p: FloodingParams = floodingParams,
): number {
  const founder = clamp01(p.founderFraction);
  if (founder <= 0) return sinkProgress(ship.flood, p) > 0 ? 0 : 1;
  return clamp01(1 - sinkProgress(ship.flood, p) / founder);
}

/**
 * Terminal stage of the sequence, run AFTER buoyancy in the sim tick (it is
 * the floor buoyancy no longer provides). Before flood reaches 1 this is a
 * no-op and the force model owns the ship completely.
 *
 * `waterHeight` is the sea surface at the ship's position — the same §V.8
 * mirror the hull floats on, so the wreck comes to rest a fixed depth under
 * the LIVE surface rather than under a flat plane that the swell has left.
 */
export function stepSinkSettle(
  ship: ShipState,
  waterHeight: number,
  dt: number,
  p: FloodingParams = floodingParams,
): void {
  if (clamp01(ship.flood) < 1 || !(dt > 0)) return;

  // she is gone: no canvas, no helm, no more shooting back
  ship.sailTrim = 0;
  ship.rudder = 0;

  const surface = Number.isFinite(waterHeight) ? waterHeight : 0;
  const restY = surface - Math.max(0, p.sunkDepth);
  if (ship.position[1] > restY) return; // still on the way down

  ship.position[1] = restY;
  // bleed way and spin off her rather than freezing the pose — a wreck that
  // stops dead in one tick reads as a bug, and buoyancy keeps writing
  // velocity every tick regardless, so a hard zero would not hold anyway
  const keep = Math.max(0, 1 - Math.max(0, p.sunkDrag) * dt);
  ship.velocity[0] *= keep;
  ship.velocity[1] = 0;
  ship.velocity[2] *= keep;
  ship.angularVelocity[0] *= keep;
  ship.angularVelocity[1] *= keep;
  ship.angularVelocity[2] *= keep;
}
