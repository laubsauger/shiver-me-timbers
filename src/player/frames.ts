/**
 * Frame transitions (§T.100, §V85): the walker lives in ONE of three frames
 * and every crossing between them is written here, once, against the LIVE
 * ship transform (§V71 — a beached raft lies tilted on the sand, so the
 * matrix, never a yaw-only approximation, converts the feet).
 *
 *   ship  → world   gangway step-off (`interact.ts`, uses `shipToWorldPose`)
 *   ship  → swim    walked off the deck (`playerStep.ts` goOverboard)
 *   world → swim    ground drops below water − swimDepth
 *   swim  → world   ground rises back above water − swimDepth
 *   world → ship    within ashoreReach / ashoreVertical of any deck edge or
 *                   boarding point: climb aboard, feet to SHIP-LOCAL
 *   swim  → ship    boarding point within boardReach (`playerStep.ts` stepSwim)
 *
 * CONTRACT NOTE: the §T.100 row names the frames `'raft'|'world'|'swim'`.
 * `PlayerFrame` already existed as `'ship'|'world'|'swim'` (§T.94) and the
 * ship frame is the raft frame — one ship per scene — so the existing name
 * is kept and `'raft'` is NOT a second alias.
 *
 * `pos` stays the FEET; yaw is ship-relative aboard and world-relative
 * otherwise, converted by the ship's world yaw at each crossing. Pure data
 * in, NEW state out (§V2/§V3); the caller picks the surface by frame.
 */
import { playerParams, type PlayerParams } from '../params/player';
import { wrapAngle, type PlayerState, type Vec3 } from './playerStep';

export interface FrameContext {
  /** live ship transform, both ways */
  shipToWorld(p: Vec3): Vec3;
  worldToShip(p: Vec3): Vec3;
  /** WORLD ground height, null where there is none */
  groundAt(x: number, z: number): number | null;
  /** WORLD sea-surface height */
  waterAt(x: number, z: number): number;
  /** SHIP-LOCAL deck height, null outboard — the deck edge is where this turns null */
  deckHeightAt(x: number, z: number): number | null;
  /** SHIP-LOCAL foot-rail points; the deck edge test already covers them, but a rail below the deck may reach further */
  boardingPoints?: readonly Vec3[];
}

/** yaw of the ship's +z in the world, from the transform alone */
export function shipWorldYaw(ctx: Pick<FrameContext, 'shipToWorld'>): number {
  const o = ctx.shipToWorld([0, 0, 0]);
  const f = ctx.shipToWorld([0, 0, 1]);
  return Math.atan2(f[0] - o[0], f[2] - o[2]);
}

const fin = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);

/** is there walkable ground (not swimming water) under a world point? */
function groundUnder(ctx: FrameContext, x: number, z: number, p: PlayerParams): number | null {
  const g = ctx.groundAt(x, z);
  if (!fin(g)) return null;
  if (g < ctx.waterAt(x, z) - p.swimDepth) return null;
  return g;
}

/**
 * Nearest place to climb aboard from world feet `w`, as SHIP-LOCAL feet, or
 * null. Probes the feet themselves, a ring of `ashoreReach` around them, and
 * the boarding points; a candidate counts when the deck there is within
 * `ashoreVertical` of the feet (the §V85 edge rule, applied from the ground
 * side).
 *
 * `vel` is the walker's world velocity: a spot beside the feet counts only
 * when the walker is MOVING TOWARD it. Without that a step-off would bounce
 * straight back aboard (the gangway lands 0.6 m outboard, inside the 1 m
 * reach) — the intent to board is the walk back, not the proximity.
 */
export function boardingSpotFrom(w: Vec3, vel: Vec3, ctx: FrameContext, p: PlayerParams = playerParams): Vec3 | null {
  const speed = Math.hypot(vel[0], vel[2]);
  if (!(speed > 1e-3)) return null;
  let best: Vec3 | null = null;
  let bestD = Infinity;
  const consider = (local: Vec3, d: number): void => {
    const h = ctx.deckHeightAt(local[0], local[2]);
    if (!fin(h)) return;
    const world = ctx.shipToWorld([local[0], h, local[2]]);
    if (Math.abs(world[1] - w[1]) > p.ashoreVertical) return;
    if (d > 0 && vel[0] * (world[0] - w[0]) + vel[2] * (world[2] - w[2]) <= 0) return;
    if (d < bestD) {
      bestD = d;
      best = [local[0], h, local[2]];
    }
  };
  consider(ctx.worldToShip(w), 0);
  const ring = 8;
  for (let i = 0; i < ring; i++) {
    const a = (i / ring) * Math.PI * 2;
    const probe: Vec3 = [w[0] + Math.cos(a) * p.ashoreReach, w[1], w[2] + Math.sin(a) * p.ashoreReach];
    consider(ctx.worldToShip(probe), p.ashoreReach);
  }
  for (const bp of ctx.boardingPoints ?? []) {
    const bw = ctx.shipToWorld(bp);
    const d = Math.hypot(bw[0] - w[0], bw[2] - w[2]);
    if (d > p.ashoreReach || Math.abs(bw[1] - w[1]) > p.ashoreVertical) continue;
    if (vel[0] * (bw[0] - w[0]) + vel[2] * (bw[2] - w[2]) <= 0) continue;
    if (d < bestD) {
      bestD = d;
      best = [bp[0], bp[1], bp[2]];
    }
  }
  return best;
}

/** world feet → ship-local state, yaw made ship-relative */
export function enterShipFrame(s: PlayerState, local: Vec3, ctx: Pick<FrameContext, 'shipToWorld'>): PlayerState {
  return {
    frame: 'ship',
    pos: [local[0], local[1], local[2]],
    yaw: wrapAngle(s.yaw - shipWorldYaw(ctx)),
    pitch: s.pitch,
    vel: [0, 0, 0],
    crouch: false,
    grounded: true,
  };
}

/** ship-local feet → world state at `world` (already transformed), yaw made world-relative */
export function enterWorldFrame(s: PlayerState, world: Vec3, ctx: Pick<FrameContext, 'shipToWorld'>): PlayerState {
  return {
    frame: 'world',
    pos: [world[0], world[1], world[2]],
    yaw: wrapAngle(s.yaw + shipWorldYaw(ctx)),
    pitch: s.pitch,
    vel: [0, 0, 0],
    crouch: false,
    grounded: true,
  };
}

/**
 * Apply the automatic crossings after a locomotion step. The ship→world
 * gangway and the swim→ship climb are driven elsewhere (see header); this
 * handles the ground-driven ones and the walk-back-aboard.
 */
export function transitionFrame(s: PlayerState, ctx: FrameContext, p: PlayerParams = playerParams): PlayerState {
  if (s.frame === 'world') {
    const aboard = boardingSpotFrom(s.pos, s.vel, ctx, p);
    if (aboard !== null) return enterShipFrame(s, aboard, ctx);
    const g = groundUnder(ctx, s.pos[0], s.pos[2], p);
    if (g === null) {
      return { ...s, frame: 'swim', pos: [s.pos[0], s.pos[1], s.pos[2]], vel: [0, 0, 0], crouch: false, grounded: false };
    }
    return s;
  }
  if (s.frame === 'swim') {
    const g = groundUnder(ctx, s.pos[0], s.pos[2], p);
    if (g === null) return s;
    return { ...s, frame: 'world', pos: [s.pos[0], g, s.pos[2]], vel: [0, 0, 0], crouch: false, grounded: true };
  }
  return s;
}
