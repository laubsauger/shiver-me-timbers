/**
 * fireCannon — spawn a cannonball projectile in SimState.
 * §V.2: any aim spread comes from createRng(seed + tick + projectile id),
 * never Math.random, so lockstep replays stay byte-identical.
 * §V.3: pure sim — mutates only the passed state, no rendering imports.
 * Mount offsets arrive as plain data (ship blueprint cannon-mount sockets
 * provide them later, §V.13) — zero dependency on ship internals here.
 */
import type { ProjectileState, SimState, Vec3 } from '../state/simState';
import { createRng } from '../state/rng';
import { combatParams, type CombatParams } from '../params/combat';
import { add, rotateVec, scale } from './quatMath';

export interface CannonAim {
  /** barrel elevation above horizontal, radians */
  elevation: number;
  /** aim jitter half-angle, radians; defaults to params.spreadAngle. 0 = exact shot */
  spread?: number;
}

/**
 * Fire the cannon at `mountIndex` on `side` of ship `shipIndex`.
 * `mountOffsets` are ship-local mount positions for that side, indexed by
 * mountIndex (port mounts sit at -x, starboard at +x, per blueprint
 * convention). Returns the spawned projectile (also pushed to state).
 */
export function fireCannon(
  state: SimState,
  shipIndex: number,
  side: 'port' | 'starboard',
  mountIndex: number,
  aim: CannonAim,
  mountOffsets: Vec3[],
  params: CombatParams = combatParams,
): ProjectileState {
  const ship = state.ships[shipIndex];
  if (!ship) throw new Error(`fireCannon: no ship at index ${shipIndex}`);
  const offset = mountOffsets[mountIndex];
  if (!offset) {
    throw new Error(`fireCannon: no ${side} mount at index ${mountIndex}`);
  }

  const id = state.nextProjectileId++;

  // §V.2: jitter seeded from state, never Math.random.
  const spread = aim.spread ?? params.spreadAngle;
  let elevation = aim.elevation;
  let azimuth = 0; // swing of the outboard direction toward bow/stern
  if (spread > 0) {
    const rng = createRng(state.seed + state.tick + id);
    elevation += (rng() * 2 - 1) * spread;
    azimuth = (rng() * 2 - 1) * spread;
  }

  // Ship-local fire direction: outboard on ±x, pitched up, yaw-jittered.
  const sign = side === 'starboard' ? 1 : -1;
  const ce = Math.cos(elevation);
  const dirLocal: Vec3 = [
    sign * ce * Math.cos(azimuth),
    Math.sin(elevation),
    ce * Math.sin(azimuth),
  ];

  const projectile: ProjectileState = {
    id,
    position: add(ship.position, rotateVec(ship.quaternion, offset)),
    velocity: scale(rotateVec(ship.quaternion, dirLocal), params.muzzleVelocity),
    age: 0,
  };
  state.projectiles.push(projectile);
  return projectile;
}
