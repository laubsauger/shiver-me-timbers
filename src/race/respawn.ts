/**
 * Respawn point ON the reference line, BEHIND the crash (§T.184, §T.179 design, design doc §3).
 *
 * Candidates start `backDistance` behind the crash progress and step back by `searchStep`
 * up to `maxBackDistance`. The first candidate at least `clearance` from every other boat and
 * accepted by the page's `isClear(x, z)` (rocks, structures, shallow bed) wins. If none is
 * clear the first candidate is used and flagged `clear: false` — the boat is ghosted anyway,
 * and a missing spot must never leave a racer stranded (fail loud via the flag, not a stall).
 *
 * This only computes the teleport CONTRACT. Physics memories (patch, section m_a, wake history)
 * are reset by the page (§T.188).
 */
import { yawOfTangent } from './polyline';
import type { CourseLine } from './progress';
import type { Vec2 } from './types';

export interface RespawnParams {
  /** metres behind the crash progress of the first candidate (design ≥ 60) */
  backDistance: number;
  searchStep: number;
  maxBackDistance: number;
  /** metres from any other boat (design ≥ 40) */
  clearance: number;
  /** floor on the respawn speed, m/s (25 kn) */
  minSpeed: number;
  /** fraction of the pre-crash speed kept (design 50%) */
  speedFraction: number;
  ghostSeconds: number;
}

export interface RespawnPoint {
  x: number;
  z: number;
  /** heading along the reference line, `core/steering.ts` convention */
  yaw: number;
  /** planing speed to set along the heading, m/s */
  speed: number;
  /** unwrapped progress of the point */
  progress: number;
  clear: boolean;
}

export type IsClear = (x: number, z: number) => boolean;

export function findRespawnPoint(
  line: CourseLine,
  crashProgress: number,
  speedBefore: number,
  others: readonly Vec2[],
  isClear: IsClear | undefined,
  p: RespawnParams,
): RespawnPoint {
  const speed = Math.max(p.minSpeed, p.speedFraction * speedBefore);
  const c2 = p.clearance * p.clearance;
  let first: RespawnPoint | null = null;
  for (let back = p.backDistance; back <= p.maxBackDistance + 1e-9; back += p.searchStep) {
    const u = crashProgress - back;
    const q = line.at(u);
    const pt: RespawnPoint = { x: q.x, z: q.z, yaw: yawOfTangent(q.tx, q.tz), speed, progress: u, clear: true };
    if (!first) first = pt;
    const boatsClear = others.every(([ox, oz]) => (ox - q.x) ** 2 + (oz - q.z) ** 2 >= c2);
    if (boatsClear && (!isClear || isClear(q.x, q.z))) return pt;
  }
  if (!first) {
    const u = crashProgress - p.backDistance;
    const q = line.at(u);
    first = { x: q.x, z: q.z, yaw: yawOfTangent(q.tx, q.tz), speed, progress: u, clear: false };
  }
  return { ...first, clear: false };
}
