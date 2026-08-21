/**
 * RaftMotion ↔ ShipState adapter (§T.98). `stepRaftSailing` is pure and
 * planar (§V.3: plain data in, a new object out); the sim's ship is a
 * `ShipState` with a quaternion that buoyancy also writes. This file is the
 * seam, and it splits the pose EXACTLY as `shipKinematics.ts` does (§V.77):
 *
 *   sailing owns x, z, yaw, vx, vz, yaw rate;
 *   buoyancy owns y, vy, pitch, roll.
 *
 * So the quaternion is decomposed as yaw(Y) ∘ pitch(X) ∘ roll(Z) (Tait-Bryan
 * y-x'-z''), the yaw is replaced, and pitch and roll go back in untouched.
 * `position[1]` and `velocity[1]` are never written here.
 *
 * The same seam serves §T.100's beaching (`stepRaftBeach`, `pushOffRaft`):
 * both are planar too, and a beached raft held at her hold-point still
 * heaves, pitches and rolls on whatever buoyancy gives her.
 *
 * Quaternion helpers come from `core/quat` — the one implementation every
 * mode shares (§V95). They used to be copied in here because the shared set
 * sat in `combat/`, which §V.81 keeps the raft out of; §T.113 moved the
 * module to neutral ground instead of keeping two of it.
 */
import type { Quat, ShipState, Vec3 } from '../state/simState';
import { quatFromAxisAngle, quatMul, rotateVec } from '../core/quat';
import type { Wind } from '../sailing/shipKinematics';
import { stepRaftSailing, type RaftControls, type RaftMotion, type RaftStep } from '../sailing/raftKinematics';
import { pushOff, stepRaftBeaching, type RaftBeachingStep } from '../sailing/raftBeaching';
import type { SeabedField } from '../sea-physics/grounding';
import { activeRaftTuning } from '../params/raftSailing';
import { raftBeachingParams } from '../params/raftBeaching';
import { raftSeaParams, type SeaPhysicsParams } from '../params/seaPhysics';

function wrapPi(a: number): number {
  let x = a % (Math.PI * 2);
  if (x <= -Math.PI) x += Math.PI * 2;
  else if (x > Math.PI) x -= Math.PI * 2;
  return x;
}
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** yaw about +y of a ship quaternion; yaw 0 = world +z, forward = [sin, 0, cos] */
export function yawOf(q: Quat): number {
  const f = rotateVec(q, [0, 0, 1]);
  return Math.atan2(f[0], f[2]);
}

/** the planar slice of a ShipState, as a fresh RaftMotion */
export function motionOf(ship: ShipState): RaftMotion {
  return {
    position: [ship.position[0], ship.position[1], ship.position[2]],
    yaw: yawOf(ship.quaternion),
    velocity: [ship.velocity[0], ship.velocity[1], ship.velocity[2]],
    yawRate: ship.angularVelocity[1],
  };
}

/** write the planar result back; y, vy, pitch and roll stay exactly as they were */
export function writeMotion(ship: ShipState, m: RaftMotion): void {
  const q = ship.quaternion;
  const fwd = rotateVec(q, [0, 0, 1]);
  const pitch = Math.asin(clamp(fwd[1], -1, 1));
  const yaw = Math.atan2(fwd[0], fwd[2]);
  const qPitch = quatFromAxisAngle([1, 0, 0], -pitch);
  const qYP = quatMul(quatFromAxisAngle([0, 1, 0], yaw), qPitch);
  const qRes = quatMul([-qYP[0], -qYP[1], -qYP[2], qYP[3]], q);
  const roll = wrapPi(2 * Math.atan2(qRes[2], qRes[3]));

  ship.position[0] = m.position[0];
  ship.position[2] = m.position[2];
  ship.velocity[0] = m.velocity[0];
  ship.velocity[2] = m.velocity[2];
  ship.angularVelocity[1] = m.yawRate;
  ship.quaternion = quatMul(
    quatFromAxisAngle([0, 1, 0], m.yaw),
    quatMul(qPitch, quatFromAxisAngle([0, 0, 1], roll)),
  );
}

/**
 * One sim tick of raft sailing on a ShipState. The tuning set is read from
 * `activeRaftTuning()` on EVERY call (§V.62: the accessible/true switch is a
 * live knob, not a boot-time constant). `rudder` and `sailTrim` are mirrored
 * from the controls so the rig display and the HUD (which read ShipState)
 * show the oar and the canvas without knowing about RaftControls.
 */
export function stepRaftShip(ship: ShipState, c: RaftControls, wind: Wind, dt: number): RaftStep {
  const t = activeRaftTuning();
  const out = stepRaftSailing(motionOf(ship), c, wind, t, dt);
  writeMotion(ship, out);
  ship.rudder = clamp(Number.isFinite(c.oarAngle) ? c.oarAngle : 0, -1, 1);
  ship.sailTrim = c.sailUp ? clamp(Number.isFinite(c.sheet) ? c.sheet : 0, 0, 1) : 0;
  return out;
}

/** the `.state`-replacing holder `raftActions.ts` exports as `raftBeach` */
export interface BeachHolder {
  state: RaftBeachingStep['beach'];
}

/**
 * One sim tick of beaching on a ShipState, AFTER `stepRaftShip` and after
 * buoyancy has written y this tick (the log undersides are probed at the
 * raft's live height). Planar result written back, the new beach state
 * into the holder; the seabed is the archipelago's field. Params are read
 * live (§V.62): the beaching knobs and the raft's own SeaPhysicsParams.
 */
export function stepRaftBeach(
  ship: ShipState,
  holder: BeachHolder,
  points: readonly Vec3[],
  seabed: SeabedField,
  dt: number,
  sea: SeaPhysicsParams = raftSeaParams,
): RaftBeachingStep {
  const out = stepRaftBeaching(motionOf(ship), holder.state, points, seabed, dt, raftBeachingParams, sea);
  writeMotion(ship, out.motion);
  holder.state = out.beach;
  return out;
}

/** the crew shove her off the sand; false (and nothing written) when she is not beached */
export function pushOffRaft(ship: ShipState, holder: BeachHolder): boolean {
  if (!holder.state.beached) return false;
  const out = pushOff(motionOf(ship), holder.state, raftBeachingParams);
  writeMotion(ship, out.motion);
  holder.state = out.beach;
  return true;
}

/**
 * Spawn pose from the Sierra world's start (§T.99): origin, bow toward the nearest
 * slice island. Yaw convention = shipKinematics: forward = [sin yaw, 0, cos yaw].
 */
export function placeRaftAtStart(
  raft: { position: number[]; quaternion: number[] },
  start: { x: number; z: number; heading: number },
): void {
  raft.position[0] = start.x;
  raft.position[2] = start.z;
  raft.quaternion = [0, Math.sin(start.heading / 2), 0, Math.cos(start.heading / 2)];
}
