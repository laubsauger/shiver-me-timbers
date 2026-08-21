/**
 * stepProjectiles — fixed-tick ballistic integration for cannonballs.
 * §V.2: deterministic semi-implicit Euler, no randomness, no wall clock.
 * §V.3: mutates only SimState; returns plain event records that fx/audio
 * consumers read later — rendering never writes back.
 *
 * Integration order matters for hit testing: with semi-implicit Euler,
 * position_new = position_old + velocity_new * dt exactly, so hitTest can
 * reconstruct the tick's travel segment as position - velocity * dt.
 *
 * TICK ORDER (combatSystem.step owns it, and it is not interchangeable):
 *   stepProjectiles → testHits → resolveWaterEntry
 * Water entry is resolved LAST, on purpose. Removing water-crossers inside
 * the integrator — as this module used to — deletes the ball before the hit
 * test ever sees the tick in which it reached the hull, so no shot can ever
 * strike below the waterline. That is precisely the geometry §V14's flooding
 * clause is about, and it fails by quietly producing zero hits.
 */
import type { SimState, ProjectileState, Vec3 } from '../state/simState';
import { SIM_DT } from '../core/loop';
import { combatParams, type CombatParams } from '../params/combat';
import { lerp } from '../core/quat';

export interface ProjectileEvent {
  type: 'splash' | 'expired';
  /** world position: water-entry point for splash, last position for expired */
  position: Vec3;
  projectileId: number;
  /**
   * m/s the ball was travelling when it crossed the surface. A splash is an
   * ENERGY event — a ball dropping out of a high lob at 30 m/s throws a
   * different column from one skimming in flat at 70 — and without this every
   * water entry in the game produced the identical burst regardless of the
   * shot that made it, which is most of why they read as a stamped decal.
   * Optional so `expired` events (and old fixtures) need not carry it.
   */
  speed?: number;
}

/** sea surface height at a world XZ. Flat sea (y = 0) is the default. */
export type WaterHeightFn = (x: number, z: number) => number;

const FLAT_SEA: WaterHeightFn = () => 0;

/**
 * Advance every projectile one fixed step and retire the ones that have
 * outlived `maxAge`. Water crossings are NOT handled here (see tick order
 * above) — call resolveWaterEntry after the hit test.
 */
export function stepProjectiles(
  state: SimState,
  dt: number,
  params: CombatParams = combatParams,
): ProjectileEvent[] {
  const events: ProjectileEvent[] = [];
  const alive: ProjectileState[] = [];

  for (const p of state.projectiles) {
    const [vx, vy, vz] = p.velocity;
    const speed = Math.hypot(vx, vy, vz);
    // quadratic drag: a = -drag * |v| * v ; gravity straight down
    const k = params.drag * speed;
    p.velocity = [
      vx - k * vx * dt,
      vy - (params.gravity + k * vy) * dt,
      vz - k * vz * dt,
    ];
    p.position = [
      p.position[0] + p.velocity[0] * dt,
      p.position[1] + p.velocity[1] * dt,
      p.position[2] + p.velocity[2] * dt,
    ];
    p.age += dt;

    if (p.age > params.maxAge) {
      events.push({ type: 'expired', position: [...p.position], projectileId: p.id });
    } else {
      alive.push(p);
    }
  }

  state.projectiles = alive;
  return events;
}

/**
 * Retire projectiles that ended this tick under the sea surface, emitting one
 * splash each at the interpolated crossing point (§V.2 event determinism:
 * exactly one splash per water entry, because the ball is removed on entry).
 *
 * `waterHeightAt` is the SAME field the hull floats on (§V.8 CPU mirror) when
 * the caller supplies it, so a ball pitches into the face of the wave that is
 * actually there rather than a flat plane. Omitting it assumes y = 0.
 */
export function resolveWaterEntry(
  state: SimState,
  dt: number,
  waterHeightAt: WaterHeightFn = FLAT_SEA,
): ProjectileEvent[] {
  const events: ProjectileEvent[] = [];
  const alive: ProjectileState[] = [];

  for (const p of state.projectiles) {
    const curr = p.position;
    // exact under this module's semi-implicit Euler — same reconstruction
    // hitTest uses, so both see one identical segment for the tick
    const prev: Vec3 = [
      curr[0] - p.velocity[0] * dt,
      curr[1] - p.velocity[1] * dt,
      curr[2] - p.velocity[2] * dt,
    ];
    const dCurr = curr[1] - height(waterHeightAt, curr[0], curr[2]);
    if (dCurr >= 0) {
      alive.push(p);
      continue;
    }
    const dPrev = prev[1] - height(waterHeightAt, prev[0], prev[2]);
    // dPrev ≤ 0 means the ball was already under at the start of the tick
    // (spawned submerged): cross at t = 0 rather than dividing by ~0.
    const denom = dPrev - dCurr;
    const t = dPrev <= 0 || denom <= 0 ? 0 : dPrev / denom;
    events.push({
      type: 'splash',
      position: lerp(prev, curr, t),
      projectileId: p.id,
      // the velocity this tick, which under semi-implicit Euler is exactly the
      // velocity the ball carried across the segment prev → curr
      speed: Math.hypot(p.velocity[0], p.velocity[1], p.velocity[2]),
    });
  }

  state.projectiles = alive;
  return events;
}

/** iterations of the bisection: 0.72 rad / 2^16 ≈ 0.0006° — far past aim spread */
const LAY_ITERATIONS = 16;
/** shots that never come down (all elevation, no gravity) must still terminate */
const LAY_MAX_STEPS = 2000;

/**
 * Horizontal distance a ball fired at `elevation` from `height` above the sea
 * travels before it crosses the surface. Uses THIS module's own integrator at
 * the sim step, so the answer is the shot the sim will actually fire rather
 * than a drag-free textbook parabola — the two disagree by 40% at these
 * numbers, and the difference is the whole reason this function exists.
 */
export function shotRange(
  elevation: number,
  height: number,
  params: CombatParams = combatParams,
): number {
  let x = 0;
  let y = Number.isFinite(height) ? height : 0;
  let vx = params.muzzleVelocity * Math.cos(elevation);
  let vy = params.muzzleVelocity * Math.sin(elevation);
  for (let i = 0; i < LAY_MAX_STEPS; i++) {
    const k = params.drag * Math.hypot(vx, vy);
    vx -= k * vx * SIM_DT;
    vy -= (params.gravity + k * vy) * SIM_DT;
    x += vx * SIM_DT;
    y += vy * SIM_DT;
    if (y <= 0) return x;
  }
  return x;
}

/**
 * Lay the guns for a target at `range` metres, `height` metres below the
 * muzzle. Bisects the elevation clamp because shot range is monotone in
 * elevation over [minElevation, maxElevation] (the ballistic maximum sits
 * near 45°, well outside the clamp).
 *
 * WHY this is not a constant: `defaultElevation` puts a 60 m/s ball 56 m
 * downrange, while §V.15's broadside state holds station at 90 m and opens
 * at 130 m. A fixed elevation therefore means every enemy broadside falls
 * short by half the range — guns that fire, smoke that blooms, and not one
 * hit, ever. §V14's whole damage clause is unreachable in play while every
 * unit test stays green, which is this project's signature failure.
 *
 * Out of reach in either direction returns the corresponding clamp: short
 * of the minimum she still shoots (and splashes beyond), past the maximum
 * she elevates fully and falls short honestly.
 */
export function elevationForRange(
  range: number,
  height: number,
  params: CombatParams = combatParams,
): number {
  const lo = Math.min(params.minElevation, params.maxElevation);
  const hi = Math.max(params.minElevation, params.maxElevation);
  if (!Number.isFinite(range) || range <= 0) return lo;
  if (range >= shotRange(hi, height, params)) return hi;
  if (range <= shotRange(lo, height, params)) return lo;
  let a = lo;
  let b = hi;
  for (let i = 0; i < LAY_ITERATIONS; i++) {
    const mid = (a + b) * 0.5;
    if (shotRange(mid, height, params) < range) a = mid;
    else b = mid;
  }
  return (a + b) * 0.5;
}

/** non-finite sea heights would send a splash to NaN and poison fx uniforms */
function height(fn: WaterHeightFn, x: number, z: number): number {
  const h = fn(x, z);
  return Number.isFinite(h) ? h : 0;
}
