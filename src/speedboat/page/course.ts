/**
 * OPEN-SEA course stub (§T.181 S0) behind the `CourseHook` seam: no islands, no course, a
 * two-column grid. §T.187 replaces it with a course + race archipelago from `src/circuit`
 * (the sites go to `buildSea`, the course's `paceLine`/grid to `spawn`).
 *
 * ARCHIPELAGO CAVEAT for T187 (docs/speedboat/sim-worker.md blockers 1–2): the NPC workers
 * float on OPEN-OCEAN depth and have no fetch/swell-shadow grids. With `sites` non-empty the
 * page mirror (player) and the worker mirrors (rivals) stop being the same sea (§V110) until
 * the seabed and fetch exports land.
 */
import { quatFromAxisAngle } from '../../core/quat';
import type { Rigid6State } from '../../sea-physics/rigidBody';
import type { CourseHook } from './seams';

/** CG height of a spawn above the still-water plane, m — the deep-V's measured rest height is 0.197 m */
export const SPAWN_CG_Y = 0.2;
/** grid geometry: columns ±COLUMN_X, rows ROW_Z apart, NPCs AHEAD of the player (slot 0) */
export const GRID_COLUMN_X = 10;
export const GRID_ROW_Z = 25;

/** slot → x/z on a grid heading `heading` rad (0 = world +z) about `origin` */
export function gridSlot(slot: number, origin: readonly [number, number] = [0, 0], heading = 0): Rigid6State {
  const lx = slot === 0 ? 0 : slot % 2 === 1 ? GRID_COLUMN_X : -GRID_COLUMN_X;
  const lz = Math.ceil(slot / 2) * GRID_ROW_Z;
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  return {
    position: [origin[0] + lx * c + lz * s, SPAWN_CG_Y, origin[1] - lx * s + lz * c],
    quaternion: quatFromAxisAngle([0, 1, 0], heading),
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
  };
}

export function openSeaCourse(): CourseHook {
  return { sites: [], course: null, spawn: (slot) => gridSlot(slot) };
}
