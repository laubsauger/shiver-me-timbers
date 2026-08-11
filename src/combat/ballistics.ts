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
import { combatParams, type CombatParams } from '../params/combat';
import { lerp } from './quatMath';

export interface ProjectileEvent {
  type: 'splash' | 'expired';
  /** world position: water-entry point for splash, last position for expired */
  position: Vec3;
  projectileId: number;
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
    events.push({ type: 'splash', position: lerp(prev, curr, t), projectileId: p.id });
  }

  state.projectiles = alive;
  return events;
}

/** non-finite sea heights would send a splash to NaN and poison fx uniforms */
function height(fn: WaterHeightFn, x: number, z: number): number {
  const h = fn(x, z);
  return Number.isFinite(h) ? h : 0;
}
