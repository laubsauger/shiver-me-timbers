/**
 * SESSION MODE (`speedboat.html?mode=free`): the race (default) or FREE ROAM — the same Tower Reach world, sea,
 * furniture, wakes, spray and player audio, with no rivals and no race.
 *
 * What free roam changes, and where:
 *  - NO RIVALS, NO WORKER: `createIdleNpcFleet` stands in for the NPC fleet driver (0 boats, nothing spawned, nothing
 *    pumped, never holds the loop); the page builds 0 NPC hulls.
 *  - NO RACE: `raceSession` gets `freeRoam` rules — `start` places the player at `freeSpawnPose` instead of building a
 *    `Race` (no rolling start, lights, gates, laps, penalties, results); the player's crash machine still runs (crash,
 *    recover, R to reset) and a respawn lands at `nearestClearWater` (the course's `respawnClear` rule).
 *  - HUD: raceUi hides every race panel (raceHud `setFreeRoam`), leaves speed/rpm and trim; no radio; H hides the HUD.
 *  - PAUSE: no restart/boat select; a Sea row; the Mode row reloads into the other mode (`sessionModeHref`).
 */
import type { Course, Vec2 } from '../../race/types';
import type { Rigid6State } from '../../sea-physics/rigidBody';
import type { BoatFleet } from '../../sim-worker/fleet';
import type { RespawnPlacement, RespawnQuery } from '../crash';
import { SPAWN_CG_Y } from './course';
import type { NpcFleet } from './npcFleet';

export type SessionMode = 'race' | 'free';
export const SESSION_MODE_PARAM = 'mode';
export const SESSION_MODE_LABEL: Readonly<Record<SessionMode, string>> = { race: 'Race', free: 'Free roam' };

/** `?mode=free` → free roam; anything else (absent, a typo) is the race */
export function sessionModeFrom(search: string | URLSearchParams): SessionMode {
  const q = typeof search === 'string' ? new URLSearchParams(search) : search;
  return q.get(SESSION_MODE_PARAM) === 'free' ? 'free' : 'race';
}

/** the page URL in `mode`, every other query parameter kept (the race is the bare URL) */
export function sessionModeHref(mode: SessionMode, href: string): string {
  const u = new URL(href);
  if (mode === 'free') u.searchParams.set(SESSION_MODE_PARAM, 'free');
  else u.searchParams.delete(SESSION_MODE_PARAM);
  return u.toString();
}

/** the free-roam rules `createRaceSession` takes instead of a race */
export interface FreeRoamRules {
  /** the player's pose on (re)start */
  spawn(): Rigid6State;
  /** where a crash or a reset lands */
  respawn(q: Readonly<RespawnQuery>): RespawnPlacement;
}

type IsClear = (x: number, z: number) => boolean;

/** ring search around (x, z), nearest first: the point itself, then every `step` m out to `maxR`, 16 bearings a ring */
export function nearestClearWater(isClear: IsClear, x: number, z: number, step = 10, maxR = 800): Vec2 | null {
  if (isClear(x, z)) return [x, z];
  for (let r = step; r <= maxR; r += step) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const px = x + Math.sin(a) * r;
      const pz = z + Math.cos(a) * r;
      if (isClear(px, pz)) return [px, pz];
    }
  }
  return null;
}

/**
 * Free roam's start: the start straight — the course's clear pace line (course.ts `clearPaceLine`: open water for a
 * whole grid) at its first point, pointed along it — moved to the nearest clear water if that point fails `isClear`.
 */
export function freeSpawnPose(course: Pick<Course, 'paceLine'>, isClear: IsClear, waterAt: (x: number, z: number) => number): Rigid6State {
  const line = course.paceLine;
  const a = line[0] ?? [0, 0];
  const b = line[Math.min(1, line.length - 1)] ?? a;
  const yaw = a === b ? 0 : Math.atan2(b[0] - a[0], b[1] - a[1]);
  const [x, z] = nearestClearWater(isClear, a[0], a[1]) ?? a;
  return {
    position: [x, waterAt(x, z) + SPAWN_CG_Y, z],
    quaternion: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
  };
}

export function freeRoamRules(course: Pick<Course, 'paceLine'>, isClear: IsClear, waterAt: (x: number, z: number) => number): FreeRoamRules {
  return {
    spawn: () => freeSpawnPose(course, isClear, waterAt),
    // from where she is now (a tumble carries her off the crash point), same heading, at rest: a sandbox, no penalty
    respawn: (q) => {
      const p = nearestClearWater(isClear, q.position[0], q.position[2]) ?? [q.crashPosition[0], q.crashPosition[2]];
      return { x: p[0], z: p[1], heading: q.crashHeading, speed: 0 };
    },
  };
}

/**
 * The NPC fleet with no rivals: no worker, no stepping, no trace. `collectedTick` follows the recorded tick so
 * `raceSession.holdSim` never holds; anything that would read a rival throws (there are none to read).
 */
export function createIdleNpcFleet(): NpcFleet {
  let recorded = 0;
  const none = (what: string) => (): never => {
    throw new Error(`[speedboat] free roam has no rivals (${what})`);
  };
  return {
    fleet: { spec: { boats: 0 } } as unknown as BoatFleet, // vesselFx reads `spec.boats`
    boats: 0,
    get collectedTick() {
      return recorded;
    },
    lagTicks: 0,
    catchUp: { batches: 0, lastBatch: 0, maxBatch: 0, budgetTicks: 0, maxLagTicks: 0 },
    error: null,
    playerIndex: 0,
    wakes: false,
    recordTick(tick) {
      recorded = tick;
    },
    queueReset: none('queueReset'),
    trace: none('trace'),
    spawnPose: none('spawnPose'),
    wakeSource: none('wakeSource'),
    renderPose: none('renderPose'),
    pose: none('pose'),
    contact: none('contact'),
    steer: () => 0,
    throttle: () => 0,
    pump: () => undefined,
    resetSlam: () => undefined,
    dispose: () => undefined,
  };
}
