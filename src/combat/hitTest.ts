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

export function testHits(
  state: SimState,
  targets: HitTarget[],
  dt: number = SIM_DT,
): HitEvent[] {
  const events: HitEvent[] = [];
  const surviving: ProjectileState[] = [];

  for (const p of state.projectiles) {
    const curr = p.position;
    const prev = sub(curr, scale(p.velocity, dt));
    let bestT = Infinity;
    let bestTarget: HitTarget | null = null;
    for (const target of targets) {
      const t = segmentVsObb(prev, curr, target);
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
 * Segment a→b vs target OBB. Returns entry parameter t ∈ [0,1] along the
 * segment, or null on miss. Slab test in the target's local frame.
 */
function segmentVsObb(a: Vec3, b: Vec3, target: HitTarget): number | null {
  const { position, quaternion } = target.worldTransform;
  const la = invRotateVec(quaternion, sub(a, position));
  const lb = invRotateVec(quaternion, sub(b, position));
  const { min, max } = target.aabb;

  let tMin = 0;
  let tMax = 1;
  for (let i = 0; i < 3; i++) {
    const d = lb[i] - la[i];
    if (Math.abs(d) < 1e-9) {
      // parallel to this slab: inside or miss outright
      if (la[i] < min[i] || la[i] > max[i]) return null;
    } else {
      let t1 = (min[i] - la[i]) / d;
      let t2 = (max[i] - la[i]) / d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) return null;
    }
  }
  return tMin;
}
