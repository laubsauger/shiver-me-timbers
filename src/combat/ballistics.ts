/**
 * stepProjectiles — fixed-tick ballistic integration for cannonballs.
 * §V.2: deterministic semi-implicit Euler, no randomness, no wall clock.
 * §V.3: mutates only SimState; returns plain event records that fx/audio
 * consumers read later — rendering never writes back.
 *
 * Integration order matters for hit testing: with semi-implicit Euler,
 * position_new = position_old + velocity_new * dt exactly, so hitTest can
 * reconstruct the tick's travel segment as position - velocity * dt.
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
    const prev: Vec3 = [...p.position];
    p.position = [
      prev[0] + p.velocity[0] * dt,
      prev[1] + p.velocity[1] * dt,
      prev[2] + p.velocity[2] * dt,
    ];
    p.age += dt;

    if (p.position[1] < 0) {
      // Removed on entry → exactly one splash per water crossing (§V.2
      // event determinism). Position interpolated to the y=0 crossing.
      const t = prev[1] <= 0 ? 0 : prev[1] / (prev[1] - p.position[1]);
      events.push({ type: 'splash', position: lerp(prev, p.position, t), projectileId: p.id });
    } else if (p.age > params.maxAge) {
      events.push({ type: 'expired', position: [...p.position], projectileId: p.id });
    } else {
      alive.push(p);
    }
  }

  state.projectiles = alive;
  return events;
}
