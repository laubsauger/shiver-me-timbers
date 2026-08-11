/**
 * Enemy AI state machine (T19, §V.15): patrol → engage → broadside → flee,
 * stepped at sim tick rate. Reads ShipState/wind, mutates only its own
 * AiMemory, and returns a plain AiIntent — sailing/combat systems apply
 * it later (§V.3 one-way flow; the AI never writes SimState).
 * §V.2 determinism: waypoint wander uses createRng(fnv1a(ship.id) + tick),
 * never Math.random; reload measured in ticks from combatParams.reloadTime.
 * Mode transitions are gated by a min-dwell time so boundary crossings
 * cannot flap the mode.
 */
import type { ShipState, SimState } from '../state/simState';
import { createRng } from '../state/rng';
import { SIM_DT } from '../core/loop';
import { combatParams } from '../params/combat';
import { aiParams, type AiParams } from '../params/ai';
import type { AiIntent, AiMemory, AiMode } from './aiTypes';
import {
  bearingTo,
  headingError,
  resolveHeading,
  rudderFromError,
  sailTrimFor,
  wrapAngle,
  yawOf,
} from './steering';

type Wind = SimState['wind'];

/** FNV-1a 32-bit over the ship id — stable per-ship rng stream offset. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** flood past threshold, or damage zones on average below hp threshold */
function shouldFlee(ship: ShipState, p: AiParams): boolean {
  if (ship.flood > p.fleeFloodThreshold) return true;
  const hp = Object.values(ship.damage);
  if (hp.length === 0) return false;
  const mean = hp.reduce((a, b) => a + b, 0) / hp.length;
  return mean < p.fleeDamageThreshold;
}

/** flee exits only well below the entry thresholds (hysteresis) */
function recovered(ship: ShipState, p: AiParams): boolean {
  return ship.flood <= p.fleeFloodThreshold * 0.5 && !shouldFlee(ship, p);
}

function nextMode(mode: AiMode, dist: number, ship: ShipState, p: AiParams): AiMode {
  if (mode !== 'flee' && shouldFlee(ship, p)) return 'flee';
  switch (mode) {
    case 'patrol':
      return dist <= p.engageRange ? 'engage' : 'patrol';
    case 'engage':
      if (dist <= p.broadsideRange) return 'broadside';
      if (dist > p.engageRange + p.rangeHysteresis) return 'patrol';
      return 'engage';
    case 'broadside':
      return dist > p.broadsideRange + p.rangeHysteresis ? 'engage' : 'broadside';
    case 'flee':
      return recovered(ship, p) ? 'patrol' : 'flee';
  }
}

/** New patrol leg: bearing sampled OUTSIDE the irons cone → always sailable. */
function pickWaypoint(
  ship: ShipState,
  wind: Wind,
  tick: number,
  memory: AiMemory,
  p: AiParams,
): void {
  const rng = createRng((fnv1a(ship.id) + tick) >>> 0);
  const upwind = wrapAngle(wind.direction + Math.PI);
  const bearing = wrapAngle(
    upwind + p.ironsCone + rng() * (2 * Math.PI - 2 * p.ironsCone),
  );
  const leg = p.patrolLegMin + rng() * (p.patrolLegMax - p.patrolLegMin);
  memory.patrolTarget = [
    ship.position[0] + Math.sin(bearing) * leg,
    ship.position[2] + Math.cos(bearing) * leg,
  ];
}

export function stepAi(
  ship: ShipState,
  player: ShipState,
  wind: Wind,
  memory: AiMemory,
  tick: number,
  params: AiParams = aiParams,
): AiIntent {
  memory.modeTime += SIM_DT;

  const yaw = yawOf(ship.quaternion);
  const dx = player.position[0] - ship.position[0];
  const dz = player.position[2] - ship.position[2];
  const dist = Math.hypot(dx, dz);

  // min-dwell gate: no transition (incl. flee) until the mode has settled
  if (memory.modeTime >= params.minDwell) {
    const next = nextMode(memory.mode, dist, ship, params);
    if (next !== memory.mode) {
      memory.mode = next;
      memory.modeTime = 0;
    }
  }

  let desired: number;
  let fire: AiIntent['fire'];

  switch (memory.mode) {
    case 'patrol': {
      const wx = memory.patrolTarget[0] - ship.position[0];
      const wz = memory.patrolTarget[1] - ship.position[2];
      if (Math.hypot(wx, wz) < params.waypointRadius) {
        pickWaypoint(ship, wind, tick, memory, params);
      }
      desired = bearingTo(ship.position, memory.patrolTarget[0], memory.patrolTarget[1]);
      break;
    }
    case 'engage':
      desired = Math.atan2(dx, dz); // close on the player
      break;
    case 'broadside': {
      const bearing = Math.atan2(dx, dz);
      // hold player abeam: heading ⊥ bearing, side picked by current geometry
      const c1 = wrapAngle(bearing + Math.PI / 2);
      const c2 = wrapAngle(bearing - Math.PI / 2);
      desired =
        Math.abs(wrapAngle(c1 - yaw)) <= Math.abs(wrapAngle(c2 - yaw)) ? c1 : c2;
      // rel > 0 ⇒ player to starboard (world starboard = [cos yaw, -sin yaw])
      const rel = wrapAngle(bearing - yaw);
      const reloadTicks = Math.max(1, Math.round(combatParams.reloadTime / SIM_DT));
      if (
        dist <= params.fireRange &&
        Math.abs(Math.abs(rel) - Math.PI / 2) <= params.fireArc &&
        tick - memory.lastFireTick >= reloadTicks
      ) {
        fire = { side: rel >= 0 ? 'starboard' : 'port' };
        memory.lastFireTick = tick;
      }
      break;
    }
    case 'flee': {
      // run broad-reach away: of the two broad-reach headings, take the
      // one closer to directly-away-from-player
      const away = Math.atan2(-dx, -dz);
      const upwind = wrapAngle(wind.direction + Math.PI);
      const r1 = wrapAngle(upwind + params.broadReachAngle);
      const r2 = wrapAngle(upwind - params.broadReachAngle);
      desired =
        Math.abs(wrapAngle(r1 - away)) <= Math.abs(wrapAngle(r2 - away)) ? r1 : r2;
      break;
    }
  }

  const resolved = resolveHeading(desired, yaw, wind.direction, params);
  const intent: AiIntent = {
    rudder: rudderFromError(headingError(yaw, resolved), params),
    sailTrim: sailTrimFor(yaw, wind.direction, params),
  };
  if (fire) intent.fire = fire;
  return intent;
}
