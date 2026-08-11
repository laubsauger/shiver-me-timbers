/**
 * Destruction ops (T17): §V13 — ALL damage flows through piece-graph
 * operations (state swap, detach); §V14 — zone hp → holed swap + splinter
 * burst, mast at 0 hp detaches with its rig, holes below the waterline
 * feed flooding (T18 consumes floodingHoles). Events are plain data so fx
 * and netcode can replay them; the detached subtree (a live Object3D) is
 * returned beside the events, never inside them.
 */
import type { Object3D } from 'three';
import type { HitEvent } from '../combat/hitTest';
import type { Quat } from '../state/simState';
import { rotateVec } from '../combat/quatMath';
import { destructionParams, type DestructionParams } from '../params/destruction';
import type { DamageStateId, PieceDef, Vec3 } from './pieceTypes';
import type { ShipAssembly } from './shipAssembly';

export interface SplinterEvent {
  type: 'splinters';
  /** world-space burst origin (the impact point) */
  position: Vec3;
  count: number;
}

export interface MastFallEvent {
  type: 'mastFall';
  pieceId: string;
}

export type DestructionEvent = SplinterEvent | MastFallEvent;

export interface HitDamageResult {
  /** plain JSON-serializable records — fx/net replay later (§V2) */
  events: DestructionEvent[];
  /** detached mast subtree (mast + yards + sails) for the caller to animate */
  detachedSubtree?: Object3D;
}

/**
 * Apply one HitEvent: decrement the zone's hp in `damageState` (mutated in
 * place — it is ShipState.damage, §V3 sim-owned), fire piece ops at the
 * thresholds. Deterministic: no randomness, same hits → same hp + events.
 */
export function applyHitDamage(
  assembly: ShipAssembly,
  blueprint: PieceDef[],
  hit: HitEvent,
  damageState: Record<string, number>,
  params: DestructionParams = destructionParams,
): HitDamageResult {
  const piece = blueprint.find((p) => p.id === hit.pieceId);
  if (piece === undefined) throw new Error(`hit references unknown piece: ${hit.pieceId}`);

  const before = damageState[piece.id] ?? 1;
  if (before <= 0) return { events: [] }; // already wrecked / detached
  const after = Math.max(0, before - params.hitDamage);
  damageState[piece.id] = after;

  const events: DestructionEvent[] = [];
  if (piece.kind === 'mast' && after <= 0) {
    const detachedSubtree = assembly.detachPiece(piece.id);
    events.push({ type: 'mastFall', pieceId: piece.id });
    return { events, detachedSubtree };
  }
  const canHole = piece.damageStates.some((s) => s.id === 'holed');
  if (canHole && before > params.holedThreshold && after <= params.holedThreshold) {
    assembly.setDamageState(piece.id, 'holed'); // exactly-once at threshold
    events.push({
      type: 'splinters',
      position: [hit.point[0], hit.point[1], hit.point[2]],
      count: params.splinterCount,
    });
  }
  return { events };
}

export interface FloodingHoles {
  count: number;
  /** hole positions in ship-oriented space (ship origin, world-rotated) */
  positions: Vec3[];
}

/**
 * Damage-zone positions of non-intact pieces, rotated by the ship's
 * quaternion; a hole floods when its rotated y < waterlineY (ship-origin-
 * relative, so a rolled ship submerges different holes). T18 consumes.
 * Damage-zone carriers are unrotated pieces, so the parent-chain walk
 * accumulates translations only.
 *
 * `damageStates` accepts either explicit state ids or raw zone hp
 * (ShipState.damage): hp ≤ holedThreshold counts as breached.
 */
export function floodingHoles(
  blueprint: PieceDef[],
  damageStates: Record<string, DamageStateId | number>,
  shipQuat: Quat,
  waterlineY: number,
  params: DestructionParams = destructionParams,
): FloodingHoles {
  const byId = new Map(blueprint.map((p) => [p.id, p]));
  const positions: Vec3[] = [];
  for (const piece of blueprint) {
    const state = damageStates[piece.id] ?? 'intact';
    const breached =
      typeof state === 'number' ? state <= params.holedThreshold : state !== 'intact';
    if (!breached) continue;
    for (const socket of piece.sockets) {
      if (socket.type !== 'damage-zone') continue;
      let local: Vec3 = [socket.position[0], socket.position[1], socket.position[2]];
      for (let node: PieceDef | undefined = piece; node !== undefined;
        node = node.parent !== undefined ? byId.get(node.parent) : undefined) {
        local = [
          local[0] + node.transform.position[0],
          local[1] + node.transform.position[1],
          local[2] + node.transform.position[2],
        ];
      }
      const rotated = rotateVec(shipQuat, local);
      if (rotated[1] < waterlineY) positions.push([rotated[0], rotated[1], rotated[2]]);
    }
  }
  return { count: positions.length, positions };
}
