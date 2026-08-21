/**
 * Raft beaching (§T.100 R3c): the Kon-Tiki grounds on a beach apron, slows,
 * and HOLDS until the crew pushes her off.
 *
 * REUSES `sea-physics/grounding.ts` (§V.8) rather than authoring a second
 * seabed model: the raft has no waterline loft for `hullContact.ts` to
 * sample, so this file supplies the contact points itself — the UNDERSIDE
 * of every log, a few points along its length — and hands them to
 * `stepShipGrounding` through a throw-away `ShipState` carrying the planar
 * `RaftMotion`. Grounding applies Coulomb friction to the planar velocity in
 * proportion to the weight the sand is carrying; this file reads back only
 * the planar channel (the raft's vertical is not simulated here) and adds
 * the one thing grounding deliberately leaves out: the HOLD.
 *
 * WHY an explicit hold (§V.62 spirit — a state that must not drift must be
 * pinned, not approximated): `stepRaftSailing` re-applies the sail's drive
 * from whatever velocity it finds each tick, so friction alone leaves a
 * beached raft creeping up the sand at drive·dt per tick for as long as the
 * wind blows. A raft aground below `beachHoldSpeed` is BEACHED: her position
 * and yaw are pinned to the spot and her velocity is zero, whatever the sail
 * says, until `pushOff` frees her with an astern shove and a grip-free grace
 * in which to back clear.
 *
 * §V.2 pure and deterministic, §V.3 plain data in and NEW plain data out;
 * the caller writes the motion back into ShipState and keeps the
 * `RaftBeachingState` beside it.
 */
import { raftParams, type RaftParams } from '../params/raft';
import { raftBeachingParams, type RaftBeachingParams } from '../params/raftBeaching';
import { seaPhysicsParams, type SeaPhysicsParams } from '../params/seaPhysics';
import { quatFromAxisAngle, rotateVec } from '../combat/quatMath';
import { stepShipGrounding, type GroundContact, type SeabedField } from '../sea-physics/grounding';
import type { ContactStation } from '../sea-physics/hullContact';
import { raftLayout } from '../ship/raftPartsLayout';
import type { ShipState, Vec3 } from '../state/simState';
import type { RaftMotion } from './raftKinematics';

/** the beaching memory the caller keeps beside the motion (plain data) */
export interface RaftBeachingState {
  /** aground and held: position/yaw pinned, velocity zero */
  beached: boolean;
  /** seconds of push-off grace left (grip suspended, no re-beaching) */
  release: number;
  /** where she is held while beached */
  hold: Vec3 | null;
  holdYaw: number;
}

export interface RaftBeachingStep {
  motion: RaftMotion;
  beach: RaftBeachingState;
  /** any log bottom is in the sand this tick */
  aground: boolean;
  /** deepest log penetration into the bed, m */
  penetration: number;
  /** fraction of contact points in the sand, 0..1 */
  extent: number;
  /** deceleration (m/s²) the sand can hold her with this tick — what the sail must out-push */
  grip: number;
}

export function neutralRaftBeaching(): RaftBeachingState {
  return { beached: false, release: 0, hold: null, holdYaw: 0 };
}

function fin(x: number, fallback = 0): number {
  return Number.isFinite(x) ? x : fallback;
}

/**
 * Ship-local contact points: the UNDERSIDE of every log, `contactSpacing`
 * apart from stern to bow, radius tapering to `logBowTaper` at the tip the
 * way `raftPartsHull` builds it. Logs lie at `logAxisY` with centrelines at
 * the waterline, so a point sits at y = logAxisY − r(z). Pure function of
 * the raft params; a reshaped raft moves its own contact points (§V.71).
 */
export function raftContactPoints(p: RaftParams = raftParams, spacing = raftBeachingParams.contactSpacing): Vec3[] {
  const L = raftLayout(p);
  const step = Math.max(0.25, fin(spacing, 1.5));
  const out: Vec3[] = [];
  for (const log of L.logs) {
    const n = Math.max(2, Math.ceil(log.length / step) + 1);
    for (let k = 0; k < n; k++) {
      const t = k / (n - 1);
      const z = log.zStern + log.length * t;
      const r = log.r * (1 + (p.logBowTaper - 1) * t);
      out.push([log.x, p.logAxisY - r, z]);
    }
  }
  return out;
}

/**
 * Grounding parameters for the raft: the galleon's seabed spring/damper
 * scaled by mass (so rest penetration is unchanged, as `brigantineSea`
 * does) and the sand's grip from the raft's own params. Derived per call —
 * the knobs are live (§V.62).
 */
export function raftSeaPhysics(b: RaftBeachingParams = raftBeachingParams, g: SeaPhysicsParams = seaPhysicsParams): SeaPhysicsParams {
  const ratio = Math.max(1e-3, fin(b.mass, 15000)) / g.mass;
  return {
    ...g,
    mass: g.mass * ratio,
    groundingSpring: g.groundingSpring * ratio,
    groundingDamping: g.groundingDamping * ratio,
    groundingFriction: Math.max(0, fin(b.grip)),
  };
}

/** a contact sampler the grounding step can read, from the raft's pose this tick */
function contactAt(motion: RaftMotion, points: readonly Vec3[], q: readonly number[]): GroundContact {
  const n = points.length;
  const worldX = new Float64Array(n);
  const worldY = new Float64Array(n);
  const worldZ = new Float64Array(n);
  const stations: ContactStation[] = new Array(n);
  const quat = q as [number, number, number, number];
  for (let i = 0; i < n; i++) {
    const r = rotateVec(quat, points[i]);
    worldX[i] = fin(motion.position[0]) + r[0];
    worldY[i] = fin(motion.position[1]) + r[1];
    worldZ[i] = fin(motion.position[2]) + r[2];
    stations[i] = { x: points[i][0], z: points[i][2], side: points[i][0] < 0 ? -1 : 1, slice: i };
  }
  return { stations, worldX, worldY, worldZ };
}

/**
 * One fixed-dt beaching step. Call AFTER `stepRaftSailing` with the motion
 * it produced; write `motion` back. `seabed.heightAt` is world seabed
 * elevation (the island archipelago's field, or `Island.heightAt`).
 */
export function stepRaftBeaching(
  motion: RaftMotion,
  beach: RaftBeachingState,
  points: readonly Vec3[],
  seabed: SeabedField,
  dt: number,
  b: RaftBeachingParams = raftBeachingParams,
  sea: SeaPhysicsParams = seaPhysicsParams,
): RaftBeachingStep {
  const h = Math.max(0, fin(dt));
  const next: RaftBeachingState = {
    beached: beach.beached,
    release: Math.max(0, fin(beach.release) - h),
    hold: beach.hold === null ? null : [beach.hold[0], beach.hold[1], beach.hold[2]],
    holdYaw: fin(beach.holdYaw),
  };
  const m: RaftMotion = {
    position: [fin(motion.position[0]), fin(motion.position[1]), fin(motion.position[2])],
    yaw: fin(motion.yaw),
    velocity: [fin(motion.velocity[0]), fin(motion.velocity[1]), fin(motion.velocity[2])],
    yawRate: fin(motion.yawRate),
  };
  const out: RaftBeachingStep = { motion: m, beach: next, aground: false, penetration: 0, extent: 0, grip: 0 };
  if (h <= 0 || points.length === 0) return out;

  // beached: pinned. The sail may fill, the oar may sweep; she does not move.
  if (next.beached && next.hold !== null) {
    m.position = [next.hold[0], m.position[1], next.hold[2]];
    m.yaw = next.holdYaw;
    m.velocity = [0, m.velocity[1], 0];
    m.yawRate = 0;
    out.aground = true;
    return out;
  }

  const q = quatFromAxisAngle([0, 1, 0], m.yaw);
  const contact = contactAt(m, points, q);
  const p = raftSeaPhysics(b, sea);
  // a throw-away ShipState: grounding reads pose and writes velocity; the
  // vertical and angular channels it also writes are the raft's buoyancy's
  // business elsewhere and are dropped here
  const ship: ShipState = {
    id: 'raft-beaching',
    kind: 'player',
    position: [m.position[0], m.position[1], m.position[2]],
    quaternion: q,
    velocity: [m.velocity[0], m.velocity[1], m.velocity[2]],
    angularVelocity: [0, 0, 0],
    rudder: 0,
    sailTrim: 0,
    flood: 0,
    damage: {},
  };
  const g = stepShipGrounding(ship, contact, seabed, Math.max(0, fin(b.draft)), h, p);
  out.aground = g.aground;
  out.penetration = g.penetration;
  out.extent = g.extent;
  if (!g.aground) return out;
  out.grip = (p.groundingFriction * g.normalForce) / p.mass;

  if (next.release > 0) return out; // being pushed off: the crew's legs beat the sand's grip

  m.velocity = [ship.velocity[0], m.velocity[1], ship.velocity[2]];
  const speed = Math.hypot(m.velocity[0], m.velocity[2]);
  if (speed < Math.max(0, fin(b.beachHoldSpeed))) {
    next.beached = true;
    next.hold = [m.position[0], m.position[1], m.position[2]];
    next.holdYaw = m.yaw;
    m.velocity = [0, m.velocity[1], 0];
    m.yawRate = 0;
  }
  return out;
}

/**
 * The crew shoves her off the sand: a dead-astern velocity and a grace
 * period free of grip and of re-beaching, so she backs clear into water
 * that floats her. No-op (returns the inputs unchanged) when not beached.
 */
export function pushOff(
  motion: RaftMotion,
  beach: RaftBeachingState,
  b: RaftBeachingParams = raftBeachingParams,
): { motion: RaftMotion; beach: RaftBeachingState } {
  if (!beach.beached) return { motion, beach };
  const yaw = fin(motion.yaw);
  const v = Math.max(0, fin(b.pushOffSpeed));
  return {
    motion: {
      position: [fin(motion.position[0]), fin(motion.position[1]), fin(motion.position[2])],
      yaw,
      velocity: [-Math.sin(yaw) * v, fin(motion.velocity[1]), -Math.cos(yaw) * v],
      yawRate: 0,
    },
    beach: { beached: false, release: Math.max(0, fin(b.pushOffTime)), hold: null, holdYaw: yaw },
  };
}
