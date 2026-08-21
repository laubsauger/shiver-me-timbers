/**
 * Ship-local frame of every piece in a blueprint (§V.13 piece graph, §V.18
 * piece contract). Pure data in, pure data out — no three.js, no assembly —
 * so combat resolves gun mounts and hit boxes headlessly and deterministically
 * (§V.2), from exactly the same numbers the scene graph is built from.
 *
 * The parent chain is composed in FULL (rotation as well as translation).
 * Accumulating translations only — which is sound today, because every piece
 * that currently carries a cannon-mount or damage-zone socket happens to be
 * unrotated — is a trap primed to spring: the moment the ship gains a rotated
 * carrier (a raked gunport strake, a heeled channel, guns run out through a
 * canted bulwark) the sockets keep resolving to plausible-looking wrong
 * places, and nothing raises a word about it.
 */
import type { PieceDef, Vec3 } from '../ship/pieceTypes';
import type { Quat } from '../state/simState';
import { add, quatFromEulerXYZ, quatMul, rotateVec } from '../core/quat';

export interface PieceFrame {
  /** ship-local origin of the piece */
  position: Vec3;
  /** ship-local orientation of the piece */
  quaternion: Quat;
}

/**
 * Resolve each piece id → its ship-local frame. Throws on an unknown or
 * cyclic parent link rather than silently rooting the subtree at the origin.
 */
export function resolvePieceFrames(blueprint: readonly PieceDef[]): Map<string, PieceFrame> {
  const byId = new Map(blueprint.map((p) => [p.id, p]));
  const frames = new Map<string, PieceFrame>();

  const resolve = (piece: PieceDef, seen: Set<string>): PieceFrame => {
    const cached = frames.get(piece.id);
    if (cached !== undefined) return cached;
    if (seen.has(piece.id)) {
      throw new Error(`resolvePieceFrames: cyclic parent chain at ${piece.id}`);
    }
    seen.add(piece.id);

    const local = piece.transform.position;
    const rot = quatFromEulerXYZ(piece.transform.rotation);
    let frame: PieceFrame;
    if (piece.parent === undefined) {
      frame = { position: [local[0], local[1], local[2]], quaternion: rot };
    } else {
      const parent = byId.get(piece.parent);
      if (parent === undefined) {
        throw new Error(`resolvePieceFrames: ${piece.id} has unknown parent ${piece.parent}`);
      }
      const pf = resolve(parent, seen);
      frame = {
        position: add(pf.position, rotateVec(pf.quaternion, local)),
        quaternion: quatMul(pf.quaternion, rot),
      };
    }
    frames.set(piece.id, frame);
    return frame;
  };

  for (const piece of blueprint) resolve(piece, new Set());
  return frames;
}

/** Ship-local position of a socket, given its owning piece's frame. */
export function socketLocalPosition(frame: PieceFrame, socketPosition: Vec3): Vec3 {
  return add(frame.position, rotateVec(frame.quaternion, socketPosition));
}
