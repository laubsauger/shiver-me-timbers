/**
 * Pure heading helpers — ONE implementation for every mode (§V95).
 * §V.2/§V.3: deterministic plain math, no three.js, no side effects.
 *
 * Lived in `ai/steering.ts` (and `yawOf` again in `raft/raftShip.ts`) until
 * §T.163. Nothing here is AI — it is arithmetic — and §V81 keeps non-pirate
 * entries out of `src/ai/`, so it moved to neutral ground. The AI-tuned pieces
 * (`rudderFromError`, `resolveHeading`, which read pirate `AiParams`) stay in
 * `ai/steering.ts`, which re-exports these.
 *
 * Conventions (§V.13): yaw θ ⇒ world forward [sin θ, 0, cos θ]; increasing
 * yaw = turn to starboard.
 */
import type { Quat, Vec3 } from '../state/simState';
import { rotateVec } from './quat';

/** Wrap an angle to (-π, π]. */
export function wrapAngle(a: number): number {
  const t = a % (2 * Math.PI);
  if (t > Math.PI) return t - 2 * Math.PI;
  if (t < -Math.PI) return t + 2 * Math.PI;
  return t;
}

/** Yaw of a ship quaternion: heading of the world-space bow direction. */
export function yawOf(q: Quat): number {
  const f = rotateVec(q, [0, 0, 1]);
  return Math.atan2(f[0], f[2]);
}

/** World bearing from `from` to the point (x, z), same convention as yaw. */
export function bearingTo(from: Vec3, x: number, z: number): number {
  return Math.atan2(x - from[0], z - from[2]);
}

/** Signed heading error, positive = target lies to starboard. */
export function headingError(yaw: number, targetYaw: number): number {
  return wrapAngle(targetYaw - yaw);
}
