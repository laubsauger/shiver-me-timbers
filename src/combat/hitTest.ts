/**
 * testHits — segment-vs-OBB projectile hit detection.
 * §V.2/§V.3: pure deterministic sim; targets arrive as plain data built
 * from the piece contract's AABB + world transform (§V.18), and the
 * returned HitEvents are what destruction (§V.14) consumes to swap
 * intact→holed pieces. Hit projectiles are removed from state.
 *
 * The tick's travel segment is reconstructed as position - velocity * dt
 * (exact under stepProjectiles' semi-implicit Euler), transformed into
 * each target's local space, and slab-tested against the local AABB —
 * so rotated ships hit correctly (the quat bug netcode would suffer from).
 * Call after stepProjectiles within the same tick.
 */
import type { Quat, SimState, ProjectileState, Vec3 } from '../state/simState';
import type { AABB } from '../ship/pieceTypes';
import { SIM_DT } from '../core/loop';
import { combatParams } from '../params/combat';
import { invRotateVec, lerp, scale, sub } from './quatMath';

export interface HitTarget {
  shipIndex: number;
  pieceId: string;
  /** piece-local bounds (piece contract §V.18) */
  aabb: AABB;
  worldTransform: { position: Vec3; quaternion: Quat };
}

export interface HitEvent {
  shipIndex: number;
  pieceId: string;
  /** world-space impact point */
  point: Vec3;
  projectileId: number;
}

/**
 * Resolve this tick's segment for every projectile against `targets`,
 * nearest hit wins. Hit projectiles are removed from state.
 *
 * A projectile NEVER tests against pieces of the ship that fired it
 * (`ProjectileState.owner`): cannon-mount sockets sit inside their own hull
 * section's AABB, so self-testing scores a hull breach on the firing tick of
 * every single shot.
 *
 * `radius` grows each box by the ball's own radius (Minkowski sum), so
 * grazing shots on thin pieces — masts above all — connect.
 */
export function testHits(
  state: SimState,
  targets: readonly HitTarget[],
  dt: number = SIM_DT,
  radius: number = combatParams.ballRadius,
): HitEvent[] {
  const events: HitEvent[] = [];
  const surviving: ProjectileState[] = [];
  const r = Number.isFinite(radius) ? Math.max(0, radius) : 0;

  for (const p of state.projectiles) {
    const curr = p.position;
    const prev = sub(curr, scale(p.velocity, dt));
    let bestT = Infinity;
    let bestTarget: HitTarget | null = null;
    for (const target of targets) {
      if (target.shipIndex === p.owner) continue; // never shoot yourself
      const t = segmentVsObb(prev, curr, target, r);
      if (t !== null && t < bestT) {
        bestT = t;
        bestTarget = target;
      }
    }
    if (bestTarget) {
      events.push({
        shipIndex: bestTarget.shipIndex,
        pieceId: bestTarget.pieceId,
        point: lerp(prev, curr, bestT),
        projectileId: p.id,
      });
    } else {
      surviving.push(p);
    }
  }

  state.projectiles = surviving;
  return events;
}

/**
 * Segment a→b vs target OBB grown by `r`. Returns entry parameter t ∈ [0,1]
 * along the segment, or null on miss. Slab test in the target's local frame.
 */
function segmentVsObb(a: Vec3, b: Vec3, target: HitTarget, r: number): number | null {
  const { position, quaternion } = target.worldTransform;
  const la = invRotateVec(quaternion, sub(a, position));
  const lb = invRotateVec(quaternion, sub(b, position));
  const { min, max } = target.aabb;

  let tMin = 0;
  let tMax = 1;
  for (let i = 0; i < 3; i++) {
    const lo = min[i] - r;
    const hi = max[i] + r;
    const d = lb[i] - la[i];
    if (Math.abs(d) < 1e-9) {
      // parallel to this slab: inside or miss outright
      if (la[i] < lo || la[i] > hi) return null;
    } else {
      let t1 = (lo - la[i]) / d;
      let t2 = (hi - la[i]) / d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) return null;
    }
  }
  return tMin;
}
