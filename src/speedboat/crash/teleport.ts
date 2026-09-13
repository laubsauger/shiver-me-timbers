/**
 * THE TELEPORT CONTRACT (§T.188; SPEC V108 as proposed in tech-research §9 / §4.5): a boat put somewhere else
 * forgets EVERY per-location memory, and the first tick after the move exchanges no slam momentum. Otherwise the
 * hull contact compares this tick's wetted sections with the ones it had at the crash site (dm_a/dt across a
 * 400 m jump → a slam impulse from nowhere), rigid6 divides by the crash site's entrained water, and the wake
 * draws a source line from the wreck to the respawn point.
 *
 * What is reset, by owner:
 *   rigid6 memory (entrained added mass)       resetRigid6Memory             sea-physics/rigidBody
 *   hull↔water dm_a/dt, lateral prev, keep     HullWater.resetMemory         sea-physics/hullWater
 *   collision contact episodes (flex poles)    resetBoatCollideMemory        sea-physics/boatCollide
 *   crash detection deceleration history      resetCrashDetectMemory        (done by the crash machine)
 *   wake source history, assists helm/trim     caller's `extra` resetters    src/wake, speedboat/assists (not owned here)
 * A worker boat gets the same through `BoatFleet.place` (stepCore resets rigid6 + HullWater + collide memory).
 */
import { HullWater, type HullWaterMesh, type HullWaterParams } from '../../sea-physics/hullWater';
import { createRigid6Load, resetRigid6Memory, RIGID6_GRAVITY, type Rigid6Memory, type Rigid6State } from '../../sea-physics/rigidBody';

export interface Resettable {
  resetMemory(): void;
}

export interface TeleportTarget {
  state: Rigid6State;
  rigidMemory: Rigid6Memory;
  hullWater: Resettable;
  /** every other per-location memory this boat has (wake source history, assists, collision episodes) */
  extra?: readonly Resettable[];
}

/** V108: pose in (element writes — references held by consumers stay valid), every per-location memory out */
export function teleportBoat(t: TeleportTarget, pose: Readonly<Rigid6State>): void {
  const s = t.state;
  for (let k = 0; k < 3; k++) {
    s.position[k] = pose.position[k];
    s.velocity[k] = pose.velocity[k];
    s.angularVelocity[k] = pose.angularVelocity[k];
  }
  for (let k = 0; k < 4; k++) s.quaternion[k] = pose.quaternion[k];
  if (![...s.position, ...s.quaternion, ...s.velocity, ...s.angularVelocity].every(Number.isFinite)) {
    throw new Error('teleport: non-finite pose');
  }
  resetRigid6Memory(t.rigidMemory);
  t.hullWater.resetMemory();
  if (t.extra) for (const r of t.extra) r.resetMemory();
}

/** first-tick slam allowed after a respawn, N·s: round-off of the second substep's sag (≈ 1e-6 measured; 5351 kg ⇒ < 2e-7 m/s) */
export const TELEPORT_SLAM_TOLERANCE = 1e-3;

/**
 * Fail loud (§Rule 8) if the first physics tick after a respawn exchanged slam momentum — the one symptom of a
 * memory that survived the move. Call with the boat's contact right after that tick's step. (The very first
 * evaluate after `HullWater.resetMemory` exchanges exactly none; a level, vy = 0 respawn pose leaves only
 * round-off for the second substep.)
 */
export function assertTeleportFirstTick(hw: { slamImpulse: number }): void {
  if (!(Math.abs(hw.slamImpulse) <= TELEPORT_SLAM_TOLERANCE)) {
    throw new Error(`teleport contract broken: first tick after respawn slammed ${hw.slamImpulse} N·s (a per-location memory survived the move)`);
  }
}

/**
 * CG height above flat water at which the LEVEL hull floats (hydrostatic equilibrium of the contact itself, by
 * bisection — derived from the same mesh the forces use, not a tuned spawn constant). 0.239 m for deepV12 level; her
 * trimmed rest pose settles lower (0.197 m, page/course.ts), which is why a level respawn rises a few cm while trimming.
 */
export function restCgHeight(mesh: HullWaterMesh, params: Partial<HullWaterParams> = {}): number {
  const hw = new HullWater(mesh, params);
  const g = RIGID6_GRAVITY; // the weight rigid6 applies
  const load = createRigid6Load();
  const s: Rigid6State = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] };
  const net = (y: number): number => {
    s.position[1] = y;
    hw.resetMemory();
    hw.samplePatch(() => 0, s, 1 / 60);
    load.force[0] = load.force[1] = load.force[2] = 0;
    hw.evaluate(s, 1 / 120, load);
    return load.force[1] - mesh.mass * g;
  };
  let lo = -2;
  let hi = 2;
  if (!(net(lo) > 0 && net(hi) < 0)) throw new Error('restCgHeight: no hydrostatic equilibrium in [−2, 2] m');
  for (let i = 0; i < 40; i++) {
    const mid = 0.5 * (lo + hi);
    if (net(mid) > 0) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** where the race logic wants the boat back (src/race owns the choice: on the racing line behind the crash) */
export interface RespawnPlacement {
  x: number;
  z: number;
  /** atan2(fwd.x, fwd.z), rad — along the racing line */
  heading: number;
  /** m/s along the heading */
  speed: number;
}

export interface RespawnQuery {
  /** where the crash started (world) and the boat's heading then */
  crashPosition: readonly [number, number, number];
  crashHeading: number;
  /** ground speed just before the crash, m/s */
  speedBeforeCrash: number;
  /** the boat's position now (it may have tumbled far from the crash point) */
  position: readonly [number, number, number];
}

export type RespawnProvider = (q: Readonly<RespawnQuery>) => RespawnPlacement;

/** design doc §3: back "planing at max(25 kn, 50%)" of the speed before the crash */
export function designRespawnSpeed(speedBeforeCrash: number): number {
  return Math.max(25 * 0.514444, 0.5 * speedBeforeCrash);
}

/** the placement as a rigid6 pose: level, on the water, moving along the heading, no rotation */
export function respawnPose(
  p: Readonly<RespawnPlacement>,
  waterHeightAt: (x: number, z: number) => number,
  cgAboveWater: number,
  out: Rigid6State = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] },
): Rigid6State {
  if (![p.x, p.z, p.heading, p.speed].every(Number.isFinite)) throw new Error('respawnPose: non-finite placement');
  const sh = Math.sin(p.heading);
  const ch = Math.cos(p.heading);
  out.position[0] = p.x;
  out.position[1] = waterHeightAt(p.x, p.z) + cgAboveWater;
  out.position[2] = p.z;
  out.quaternion[0] = 0;
  out.quaternion[1] = Math.sin(p.heading / 2);
  out.quaternion[2] = 0;
  out.quaternion[3] = Math.cos(p.heading / 2);
  out.velocity[0] = p.speed * sh;
  out.velocity[1] = 0;
  out.velocity[2] = p.speed * ch;
  out.angularVelocity[0] = out.angularVelocity[1] = out.angularVelocity[2] = 0;
  return out;
}
