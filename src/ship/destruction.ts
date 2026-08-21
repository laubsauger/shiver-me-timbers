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
import { invRotateVec, rotateVec } from '../core/quat';
import { destructionParams, type DestructionParams } from '../params/destruction';
import { defaultRadius } from './pieceGeometryHoled';
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
  /** §T.63 — true when this hit cut a new hole in the shell (false at the
   *  per-piece cap, on a non-holeable piece, or with no `seat` supplied) */
  breached?: boolean;
}

/**
 * §T.63 — what a hit needs in order to be turned into a HOLE IN THE PLANKING
 * rather than a decal at an authored station.
 *
 * `HitEvent.point` is world space; the shell is cut in piece space, so the
 * ship's pose and the piece's ship-local frame are what close the gap. Both
 * already exist at the one call site that matters (`combatSystem.applyHit`
 * holds the `ShipState` and `buildHitTargetSet`'s resolved frames), so this
 * carries them rather than re-deriving a second answer here (§V.72).
 */
export interface BreachSeat {
  shipPosition: Vec3;
  shipQuaternion: Quat;
  /** ship-local frame of the piece that was hit */
  pieceFrame: { position: Vec3; quaternion: Quat };
  /** m — physical ball radius; `defaultRadius` turns it into a hole size */
  ballRadius?: number;
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
  seat?: BreachSeat,
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
  // §T.63 — EVERY hit through the planking makes its own hole, at the point
  // the ball went in. This used to be gated on the hp threshold, which is
  // why a section could only ever show one breach and why the first shots of
  // an engagement left no mark at all ("hits don't really register").
  let breached = false;
  if (canHole && seat !== undefined) {
    breached = assembly.addBreach(piece.id, {
      point: pieceLocalPoint(hit.point, seat),
      radius: defaultRadius(seat.ballRadius),
      // §V.2: seeded off the impact point, so a replay tears the same shape
      seed: breachSeed(hit.point),
    });
  }
  if (canHole && before > params.holedThreshold && after <= params.holedThreshold) {
    assembly.setDamageState(piece.id, 'holed'); // exactly-once at threshold
    events.push({
      type: 'splinters',
      position: [hit.point[0], hit.point[1], hit.point[2]],
      count: params.splinterCount,
    });
  }
  return { events, breached };
}

/** world impact point → the piece's own frame (ship pose, then piece frame) */
function pieceLocalPoint(point: Vec3, seat: BreachSeat): [number, number, number] {
  const shipLocal = invRotateVec(seat.shipQuaternion, [
    point[0] - seat.shipPosition[0],
    point[1] - seat.shipPosition[1],
    point[2] - seat.shipPosition[2],
  ]);
  const rel: Vec3 = [
    shipLocal[0] - seat.pieceFrame.position[0],
    shipLocal[1] - seat.pieceFrame.position[1],
    shipLocal[2] - seat.pieceFrame.position[2],
  ];
  const local = invRotateVec(seat.pieceFrame.quaternion, rel);
  return [local[0], local[1], local[2]];
}

/** deterministic, position-derived, and stable across a §V.2 replay */
function breachSeed(point: Vec3): number {
  const q = (v: number): number => (Number.isFinite(v) ? Math.round(v * 64) : 0);
  return (Math.imul(q(point[0]) ^ 0x9e37, 2654435761) ^ Math.imul(q(point[1]) + 7919, 40503) ^ q(point[2])) >>> 0;
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
