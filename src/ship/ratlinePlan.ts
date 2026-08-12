/**
 * RATLINE PLAN — the ship system's declarative INTENT for the rung ladders,
 * handed to src/ropes to render (§V.45).
 *
 * WHY THIS IS NOT GEOMETRY ANY MORE. The first version of this built the rungs
 * as a mesh from the chainplate sockets and the masthead, on the reasoning
 * that standing rigging carries slack 1.004 and is therefore straight to
 * within a couple of centimetres. That reasoning fails the moment the shrouds
 * become anything other than straight: they already sag slightly, and once
 * they move dynamically the authored rungs stay exactly where they were
 * authored and the ladder floats off its own ropes. Nothing errors — it just
 * looks wrong, in the way only a screenshot can catch. So the rungs must be
 * sampled from the SAME solved points buffer the shrouds are drawn from, and
 * that buffer lives in src/ropes.
 *
 * What crosses the boundary is this plan: which shrouds a ladder spans, where
 * each rung sits along them, and how thick it is. Everything here is plain
 * serialisable data keyed by SOCKET IDS, exactly like buildRiggingPlan — world
 * positions are resolved by the consumer, so a mast that breaks and swings
 * re-solves its shrouds and its ratlines together, for free.
 *
 * §V2: the per-rung jitter is baked in here from the seeded hash, so the
 * ladder is identical on every client without src/ropes needing any variation
 * logic of its own.
 */
import { shipDetailParams } from '../params/ship';
import type { PieceDef, SocketDef } from './pieceTypes';
import { vhash, vjitter } from './variation';

const SIDES = ['port', 'starboard'] as const;
export type RigSide = (typeof SIDES)[number];

/**
 * Narrowest rung worth seizing (m). The fan converges on the masthead, so the
 * top rungs shrink toward nothing; a rung you cannot put a foot on is not a
 * rung, and a ladder that tapers to a point reads as a spike. This is the
 * cutoff `topFrac` alone cannot express, because where the shrouds close to a
 * foot's width depends on how wide the fan was at the deck.
 */
export const MIN_RUNG = 0.55;

export interface RatlineRung {
  /** position along shroud A: 0 at its chainplate, 1 at the masthead */
  tA: number;
  /**
   * …and along shroud B. Deliberately NOT equal to tA: rungs were seized by
   * hand, one at a time, and a perfectly level ladder is the "ultra regular"
   * tell the whole detail pass exists to remove.
   */
  tB: number;
  /** belly below the straight A→B line, as a fraction of the rung's own span */
  sag: number;
}

export interface RatlineLadder {
  id: string;
  /** the mast the ladder climbs — detaching it must take the ladder along */
  mastId: string;
  side: RigSide;
  /** rope-anchor socket at the OUTBOARD end of the fan */
  footA: string;
  /** …and at the inboard end; a rung crosses every shroud between them */
  footB: string;
  /** the socket both shrouds rise to */
  masthead: string;
  /** rung tube radius (m) */
  radius: number;
  rungs: RatlineRung[];
}

/** chainplate sockets of one mast's fan on one side, outboard → inboard */
function fanFeet(blueprint: PieceDef[], mast: string, side: RigSide): SocketDef[] {
  const prefix = `anchor-channel-${side}-${mast}-`;
  const feet: Array<{ socket: SocketDef; x: number; index: number }> = [];
  for (const piece of blueprint) {
    if (piece.kind !== 'hull-section') continue;
    for (const socket of piece.sockets) {
      if (!socket.id.startsWith(prefix)) continue;
      const index = Number.parseInt(socket.id.slice(prefix.length), 10);
      if (!Number.isFinite(index)) continue;
      feet.push({ socket, x: Math.abs(socket.position[0]), index });
    }
  }
  // outboard first: the widest plate carries the outer shroud, and a rung
  // spans from it to the innermost one
  feet.sort((a, b) => b.x - a.x || a.index - b.index);
  return feet.map((f) => f.socket);
}

/** ship-space position of a socket on an un-rotated, directly-parented piece */
function shipPos(blueprint: PieceDef[], socketId: string): [number, number, number] | null {
  for (const piece of blueprint) {
    for (const socket of piece.sockets) {
      if (socket.id !== socketId) continue;
      return [
        piece.transform.position[0] + socket.position[0],
        piece.transform.position[1] + socket.position[1],
        piece.transform.position[2] + socket.position[2],
      ];
    }
  }
  return null;
}

function lerp3(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function dist3(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Build the ratline plan for a blueprint. Pure and deterministic; only masts
 * whose chainplate fan has at least two plates get a ladder, so a class
 * without a fan simply produces none (§V18 — no code path forks).
 *
 * The rung STATIONS are computed here rather than left to the consumer because
 * the cutoff depends on the fan's own geometry: the sockets are static in ship
 * space, so where the shrouds close to MIN_RUNG is knowable at build time,
 * while the solved curve between them is not.
 */
export function buildRatlinePlan(blueprint: PieceDef[]): RatlineLadder[] {
  const d = shipDetailParams;
  const spacing = Math.max(0.1, d.ratlineSpacing);
  const topFrac = Math.min(0.95, Math.max(0.05, d.ratlineTopFrac));
  const jitter = Math.max(0, d.irregularity);
  const ladders: RatlineLadder[] = [];

  for (const mast of blueprint) {
    if (mast.kind !== 'mast') continue;
    const name = mast.id.replace(/^mast-/, '');
    const masthead = `anchor-masthead-${name}`;
    if (shipPos(blueprint, masthead) === null) continue;
    const head = shipPos(blueprint, masthead)!;

    for (const side of SIDES) {
      const feet = fanFeet(blueprint, name, side);
      if (feet.length < 2) continue;
      const footA = feet[0];
      const footB = feet[feet.length - 1];
      const a = shipPos(blueprint, footA.id);
      const b = shipPos(blueprint, footB.id);
      if (a === null || b === null) continue;

      const run = dist3(a, head);
      const count = Math.max(0, Math.floor((run * topFrac) / spacing));
      const rungs: RatlineRung[] = [];
      for (let i = 1; i <= count; i++) {
        const tA = ((i + vjitter(0.16 * jitter, a[0], i)) / count) * topFrac;
        const tB = tA + vjitter(0.006 * jitter, a[2], i, 3);
        const clampedA = Math.min(0.99, Math.max(0.005, tA));
        const clampedB = Math.min(0.99, Math.max(0.005, tB));
        // stop where the fan has closed: the shrouds converge on one point, so
        // beyond this the "rungs" are stubs (see MIN_RUNG)
        if (dist3(lerp3(a, head, clampedA), lerp3(b, head, clampedB)) < MIN_RUNG) break;
        rungs.push({
          tA: clampedA,
          tB: clampedB,
          sag: 0.018 + 0.02 * vhash(i, a[0]),
        });
      }
      if (rungs.length === 0) continue;
      ladders.push({
        id: `ratlines-${side}-${name}`,
        mastId: mast.id,
        side,
        footA: footA.id,
        footB: footB.id,
        masthead,
        radius: Math.max(0.004, d.ratlineRadius),
        rungs,
      });
    }
  }
  return ladders;
}

/**
 * Throw if a ladder references a socket the blueprint does not declare as a
 * rope anchor. Mirrors validateRiggingPlan: a socket rename on the ship side
 * must fail loud in src/ropes rather than silently drop a ladder.
 */
export function validateRatlinePlan(plan: RatlineLadder[], blueprint: PieceDef[]): void {
  const anchors = new Set<string>();
  for (const piece of blueprint) {
    for (const socket of piece.sockets) {
      if (socket.type === 'rope-anchor') anchors.add(socket.id);
    }
  }
  for (const ladder of plan) {
    for (const id of [ladder.footA, ladder.footB, ladder.masthead]) {
      if (!anchors.has(id)) {
        throw new Error(`ratline plan references unknown rope-anchor socket '${id}'`);
      }
    }
  }
}
