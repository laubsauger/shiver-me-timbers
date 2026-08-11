/**
 * §V12/§V13 ship rigging plan: maps a blueprint's named rope-anchor sockets
 * (ship system, §V13) onto rope descriptors for createRopes (§V12). The plan
 * is plain deterministic data keyed by SOCKET IDS, not positions — world
 * positions are resolved only in applyRiggingPlan, so main.ts re-applies the
 * same plan after mast movement/destruction and the compute pass re-solves
 * the catenaries (§V14 → §V12). Rig layout follows
 * docs/ship-reference-schema.png / docs/ship-full-view.png:
 *   forestay   foremost masthead → bowsprit tip
 *   backstays  aftmost masthead → both stern cleats
 *   shrouds    each masthead → bow + stern cleat per side (2/side/mast)
 *   yard lifts each yard end → its own masthead
 *   braces     lower yard ends → stern deck cleats aft, side-matched
 * Duplicate socket pairs are deduped (e.g. aftmost mast's stern shrouds ARE
 * the backstays). Only sockets present in the blueprint are referenced, and
 * validateRiggingPlan re-checks that — a socket rename in src/ship/ fails
 * loud here instead of silently mis-rigging.
 */
import type { PieceDef } from '../ship/pieceTypes';
import type { Vec3Like } from './catenaryMath';
import type { Ropes } from './index';

export interface RiggingRope {
  socketA: string;
  socketB: string;
  /** rope length = chord distance × slack; always > 1 so ropes hang */
  slack: number;
  /** tube radius (m) */
  thickness: number;
}

/** the subset of the Ropes API the rigging needs — keeps this module free of
 *  runtime three.js imports (type-only) */
export type RopesHandle = Pick<Ropes, 'setRope' | 'setRopeCount'>;

/** per-role slack/thickness — rig design data (standing rigging tauter and
 *  thicker than running rigging), applied uniformly per role */
const STYLE = {
  stay: { slack: 1.03, thickness: 0.05 },
  shroud: { slack: 1.04, thickness: 0.04 },
  lift: { slack: 1.07, thickness: 0.03 },
  brace: { slack: 1.1, thickness: 0.025 },
} as const;

/** ids of every rope-anchor socket in the blueprint (other socket types are
 *  not valid rope endpoints) */
export function collectRopeAnchorIds(blueprint: PieceDef[]): Set<string> {
  const ids = new Set<string>();
  for (const piece of blueprint) {
    for (const socket of piece.sockets) {
      if (socket.type === 'rope-anchor') ids.add(socket.id);
    }
  }
  return ids;
}

/** throws if any plan entry references a socket id that is not a rope-anchor
 *  in the blueprint (fail loud on ship-side renames) */
export function validateRiggingPlan(
  plan: RiggingRope[],
  blueprint: PieceDef[],
): void {
  const ids = collectRopeAnchorIds(blueprint);
  for (const rope of plan) {
    for (const id of [rope.socketA, rope.socketB]) {
      if (!ids.has(id)) {
        throw new Error(
          `rigging plan references unknown rope-anchor socket '${id}'`,
        );
      }
    }
  }
}

const SIDES = ['port', 'starboard'] as const;

/**
 * Build the standard rigging set for a blueprint (works for both ship
 * classes: entries whose sockets a class lacks — e.g. brigantine rear mast —
 * are simply not generated). Pure function of the blueprint: deterministic
 * category-by-category order, no randomness.
 */
export function buildRiggingPlan(blueprint: PieceDef[]): RiggingRope[] {
  const ids = collectRopeAnchorIds(blueprint);
  const plan: RiggingRope[] = [];
  const seen = new Set<string>();
  const add = (socketA: string, socketB: string, role: keyof typeof STYLE): void => {
    const key = `${socketA}|${socketB}`;
    if (!ids.has(socketA) || !ids.has(socketB) || seen.has(key)) return;
    seen.add(key);
    plan.push({ socketA, socketB, ...STYLE[role] });
  };

  // masts sorted by ship-local z: [0] = foremost … [last] = aftmost
  const masts = blueprint
    .filter((p) => p.kind === 'mast')
    .sort((a, b) => b.transform.position[2] - a.transform.position[2])
    .map((p) => p.id.replace(/^mast-/, ''));
  if (masts.length === 0) return plan;
  const foremost = masts[0];
  const aftmost = masts[masts.length - 1];
  const masthead = (m: string): string => `anchor-masthead-${m}`;

  // forestay
  add(masthead(foremost), 'anchor-bowsprit-tip', 'stay');
  // backstays
  for (const side of SIDES) {
    add(masthead(aftmost), `anchor-cleat-stern-${side}`, 'stay');
  }
  // shrouds — 2 per side per mast (bow + stern cleat); the aftmost mast's
  // stern pair dedupes against its backstays
  for (const m of masts) {
    for (const side of SIDES) {
      add(masthead(m), `anchor-cleat-bow-${side}`, 'shroud');
      add(masthead(m), `anchor-cleat-stern-${side}`, 'shroud');
    }
  }
  // yard lifts + braces, in blueprint piece order
  for (const piece of blueprint) {
    if (piece.kind !== 'yard') continue;
    const match = /^yard-(\w+)-(\w+)$/.exec(piece.id);
    if (match === null) continue;
    const [, m, level] = match;
    for (const side of SIDES) {
      add(`anchor-${piece.id}-${side}`, masthead(m), 'lift');
      if (level === 'lower') {
        add(`anchor-${piece.id}-${side}`, `anchor-cleat-stern-${side}`, 'brace');
      }
    }
  }

  validateRiggingPlan(plan, blueprint);
  return plan;
}

/**
 * Push a plan into a ropes handle. `socketWorldPosition` resolves a socket id
 * to its CURRENT world position (ship transform × piece graph — supplied by
 * the ship system); rope length = chord × slack. Call again whenever anchors
 * move (§V14 mast break → §V12 re-solve); the descriptor upload is the only
 * CPU work, the curve math stays on the GPU. Throws (from setRope) if the
 * plan exceeds the handle's maxRopes capacity.
 */
export function applyRiggingPlan(
  plan: RiggingRope[],
  ropes: RopesHandle,
  socketWorldPosition: (id: string) => [number, number, number],
): void {
  plan.forEach((rope, index) => {
    const [ax, ay, az] = socketWorldPosition(rope.socketA);
    const [bx, by, bz] = socketWorldPosition(rope.socketB);
    const a: Vec3Like = { x: ax, y: ay, z: az };
    const b: Vec3Like = { x: bx, y: by, z: bz };
    const chord = Math.hypot(bx - ax, by - ay, bz - az);
    ropes.setRope(index, a, b, chord * rope.slack, rope.thickness);
  });
  ropes.setRopeCount(plan.length);
}
