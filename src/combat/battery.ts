/**
 * Gun batteries read straight off the piece graph (§V.13): every
 * `cannon-mount` socket in the blueprint becomes one gun, split port /
 * starboard by which side of the centreline it resolves to. §V.18 holds —
 * an AI-generated hull that keeps the socket contract gets a working
 * broadside with no code change here.
 *
 * §V.2: pure function of the blueprint, no randomness, stable ordering.
 * Guns are ordered bow → stern so a rolling broadside ripples forward to aft
 * the way a gun crew actually works the deck.
 */
import type { PieceDef, Vec3 } from '../ship/pieceTypes';
import { resolvePieceFrames, socketLocalPosition } from './pieceFrame';

export type BroadsideSide = 'port' | 'starboard';

export interface GunMount {
  /** blueprint socket id — stable across rebuilds, safe for fx keying */
  socketId: string;
  side: BroadsideSide;
  /** ship-local muzzle station */
  position: Vec3;
}

export interface Battery {
  port: GunMount[];
  starboard: GunMount[];
}

/** Every cannon-mount socket in the blueprint, split by side, bow → stern. */
export function buildBattery(blueprint: readonly PieceDef[]): Battery {
  const frames = resolvePieceFrames(blueprint);
  const port: GunMount[] = [];
  const starboard: GunMount[] = [];

  for (const piece of blueprint) {
    const frame = frames.get(piece.id);
    if (frame === undefined) continue;
    for (const socket of piece.sockets) {
      if (socket.type !== 'cannon-mount') continue;
      const position = socketLocalPosition(frame, socket.position);
      // ship-local +x is starboard (blueprint convention, see steering.ts).
      // A mount exactly on the centreline is a blueprint bug, not a gun:
      // it would fire through its own hull. Send it starboard and let the
      // deterministic ordering keep replays identical.
      (position[0] < 0 ? port : starboard).push({
        socketId: socket.id,
        side: position[0] < 0 ? 'port' : 'starboard',
        position,
      });
    }
  }

  const bowFirst = (a: GunMount, b: GunMount): number =>
    b.position[2] - a.position[2] || a.socketId.localeCompare(b.socketId);
  port.sort(bowFirst);
  starboard.sort(bowFirst);
  return { port, starboard };
}

/** Guns on `side`, in firing order. */
export function batterySide(battery: Battery, side: BroadsideSide): GunMount[] {
  return side === 'port' ? battery.port : battery.starboard;
}

/**
 * Which broadside bears on a world bearing (the direction the gunner is
 * looking along), given the hull's yaw. Positive cross product ⇒ the bearing
 * lies to starboard of the bow.
 *
 * Ties (target dead ahead or dead astern) resolve to starboard so the same
 * input always produces the same volley (§V.2).
 */
export function sideForBearing(yaw: number, bearing: number): BroadsideSide {
  // bow = [sin yaw, cos yaw]; starboard = [cos yaw, -sin yaw]
  const bx = Math.sin(bearing);
  const bz = Math.cos(bearing);
  const dotStarboard = bx * Math.cos(yaw) - bz * Math.sin(yaw);
  return dotStarboard < 0 ? 'port' : 'starboard';
}
