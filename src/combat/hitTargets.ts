/**
 * Hit-target set for one ship, derived from its piece graph (§V.13/§V.18):
 * piece AABB + ship-local frame, re-posed into world space each tick from
 * ShipState alone (§V.3 — the sim never reads the scene graph back).
 *
 * The static half (which pieces, what boxes) is resolved once at
 * construction; the per-tick half only rotates and translates, and writes
 * into a reused array so a 60 Hz tick allocates nothing.
 *
 * Pieces at 0 hp are dropped from the set: a mast that has gone over the side
 * is no longer part of this ship, and leaving it in place would let a shot
 * "hit" a spar that is visibly in the water.
 */
import type { PieceDef, PieceKind } from '../ship/pieceTypes';
import type { Quat, ShipState, Vec3 } from '../state/simState';
import type { HitTarget } from './hitTest';
import { resolvePieceFrames, type PieceFrame } from './pieceFrame';
import { add, quatMul, rotateVec } from './quatMath';

/**
 * Structure a cannonball can bite on. Deliberately excludes cloth and
 * cordage (sails, ratlines, pennants — a ball punches through), decoration
 * with no structural role, and the guns themselves.
 */
const TARGET_KINDS: ReadonlySet<PieceKind> = new Set<PieceKind>([
  'hull-section',
  'keel',
  'deck',
  'bow',
  'transom',
  'gallery',
  'forecastle-deck',
  'sterncastle-deck',
  'cabin',
  'mast',
  'bowsprit',
  'rail',
  'rudder',
]);

export interface TargetPiece {
  pieceId: string;
  frame: PieceFrame;
  min: Vec3;
  max: Vec3;
}

export interface HitTargetSet {
  readonly pieces: readonly TargetPiece[];
  /**
   * Reusable output buffer. Only the first `count` entries returned by
   * `poseTargets` are live — read past it and you are reading last tick.
   */
  readonly buffer: HitTarget[];
}

export function buildHitTargetSet(blueprint: readonly PieceDef[]): HitTargetSet {
  const frames = resolvePieceFrames(blueprint);
  const pieces: TargetPiece[] = [];
  for (const piece of blueprint) {
    if (!TARGET_KINDS.has(piece.kind)) continue;
    const frame = frames.get(piece.id);
    if (frame === undefined) continue;
    pieces.push({
      pieceId: piece.id,
      frame,
      min: [piece.aabb.min[0], piece.aabb.min[1], piece.aabb.min[2]],
      max: [piece.aabb.max[0], piece.aabb.max[1], piece.aabb.max[2]],
    });
  }
  const buffer: HitTarget[] = pieces.map(() => ({
    shipIndex: 0,
    pieceId: '',
    aabb: { min: [0, 0, 0], max: [0, 0, 0] },
    worldTransform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
  }));
  return { pieces, buffer };
}

/**
 * Pose the set into world space for `ship` and return how many targets are
 * live this tick. Writes into `set.buffer` in place.
 */
export function poseTargets(
  set: HitTargetSet,
  shipIndex: number,
  ship: ShipState,
): number {
  const q = ship.quaternion;
  let n = 0;
  for (const piece of set.pieces) {
    // hp is only present once a piece has been hit; absent = untouched
    const hp = ship.damage[piece.pieceId];
    if (hp !== undefined && hp <= 0) continue;
    const out = set.buffer[n++];
    out.shipIndex = shipIndex;
    out.pieceId = piece.pieceId;
    writeVec(out.aabb.min, piece.min);
    writeVec(out.aabb.max, piece.max);
    writeVec(out.worldTransform.position, add(ship.position, rotateVec(q, piece.frame.position)));
    writeQuat(out.worldTransform.quaternion, quatMul(q, piece.frame.quaternion));
  }
  return n;
}

function writeVec(out: Vec3, v: Vec3): void {
  out[0] = v[0];
  out[1] = v[1];
  out[2] = v[2];
}

function writeQuat(out: Quat, q: Quat): void {
  out[0] = q[0];
  out[1] = q[1];
  out[2] = q[2];
  out[3] = q[3];
}
