/**
 * §V12/§V13 ship rigging plan: maps a blueprint's named rope-anchor sockets
 * (ship system, §V13) onto rope descriptors for createRopes (§V12). The plan
 * is plain deterministic data keyed by SOCKET IDS, not positions — world
 * positions are resolved only in applyRiggingPlan, so main.ts re-applies the
 * same plan every time anchors move and the compute pass re-solves the
 * catenaries (§V14 → §V12). Rig layout per docs/ship-reference-schema.png +
 * docs/ship-full-view.png:
 *   stays      forestay (foremost masthead → bowsprit tip), inter-mast stays
 *              (masthead → next masthead aft), backstays (aftmost masthead →
 *              stern cleats), bobstays (bowsprit tip → bow cleats)
 *   halyard    crow's nest → its masthead (flag/topsail line)
 *   shrouds    each masthead → bow + stern cleat per side (2/side/mast)
 *   yard lifts each yard end → its own masthead
 *   braces     BOTH yards' ends → stern deck cleats aft, side-matched
 *   sheets     lower yard ends → bow cleats, side-matched (clew sheet run —
 *              the blueprint has no sail-clew sockets, so the run starts at
 *              the yard end; adapt when the ship system adds clew anchors)
 * Duplicate socket pairs are deduped (e.g. aftmost mast's stern shrouds ARE
 * the backstays). Only sockets present in the blueprint are referenced, and
 * validateRiggingPlan re-checks that — a socket rename in src/ship/ fails
 * loud here instead of silently mis-rigging.
 */
import type { PieceDef } from '../ship/pieceTypes';
import type { Vec3Like } from './catenaryMath';
import type { Blocks } from './blocks';
import type { Ropes } from './index';

export type RigRole = 'stay' | 'halyard' | 'shroud' | 'lift' | 'brace' | 'sheet';

export interface RiggingRope {
  socketA: string;
  socketB: string;
  role: RigRole;
  /** rope length = chord distance × slack; always > 1 so ropes hang */
  slack: number;
  /** tube radius (m) */
  thickness: number;
}

/** the subsets of the ropes/blocks APIs the rigging needs — keeps this
 *  module free of runtime three.js imports (type-only) */
export type RopesHandle = Pick<Ropes, 'setRope' | 'setRopeCount'>;
export type BlocksHandle = Pick<Blocks, 'setBlock' | 'setBlockCount'>;

/** per-role slack/thickness — rig design data: standing rigging (stays/
 *  shrouds) tauter and thicker than running rigging (lifts/braces/sheets) */
const STYLE: Record<RigRole, { slack: number; thickness: number }> = {
  stay: { slack: 1.03, thickness: 0.05 },
  halyard: { slack: 1.05, thickness: 0.028 },
  shroud: { slack: 1.04, thickness: 0.04 },
  lift: { slack: 1.07, thickness: 0.03 },
  brace: { slack: 1.1, thickness: 0.025 },
  sheet: { slack: 1.12, thickness: 0.02 },
};

/** running rigging is worked through blocks; standing rigging is seized */
const BLOCK_ROLES: ReadonlySet<RigRole> = new Set(['halyard', 'lift', 'brace', 'sheet']);

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
 * classes: entries whose sockets a class lacks — e.g. brigantine rear mast /
 * crow's nest — are simply not generated). Pure function of the blueprint:
 * deterministic category-by-category order, no randomness.
 */
export function buildRiggingPlan(blueprint: PieceDef[]): RiggingRope[] {
  const ids = collectRopeAnchorIds(blueprint);
  const plan: RiggingRope[] = [];
  const seen = new Set<string>();
  const add = (socketA: string, socketB: string, role: RigRole): void => {
    const key = `${socketA}|${socketB}`;
    if (!ids.has(socketA) || !ids.has(socketB) || seen.has(key)) return;
    seen.add(key);
    plan.push({ socketA, socketB, role, ...STYLE[role] });
  };

  // masts sorted by ship-local z: [0] = foremost … [last] = aftmost
  const mastPieces = blueprint
    .filter((p) => p.kind === 'mast')
    .sort((a, b) => b.transform.position[2] - a.transform.position[2]);
  const masts = mastPieces.map((p) => p.id.replace(/^mast-/, ''));
  if (masts.length === 0) return plan;
  const foremost = masts[0];
  const aftmost = masts[masts.length - 1];
  const masthead = (m: string): string => `anchor-masthead-${m}`;

  // stays: forestay, inter-mast, backstays, bobstays (bow runs)
  add(masthead(foremost), 'anchor-bowsprit-tip', 'stay');
  for (let i = 0; i < masts.length - 1; i++) {
    add(masthead(masts[i]), masthead(masts[i + 1]), 'stay');
  }
  for (const side of SIDES) {
    add(masthead(aftmost), `anchor-cleat-stern-${side}`, 'stay');
  }
  for (const side of SIDES) {
    add('anchor-bowsprit-tip', `anchor-cleat-bow-${side}`, 'stay');
  }
  // halyard: crow's nest → the masthead of the mast that carries it
  const crowNest = blueprint.find((p) => p.kind === 'crow-nest');
  if (crowNest?.parent !== undefined) {
    add('anchor-crow-nest', masthead(crowNest.parent.replace(/^mast-/, '')), 'halyard');
  }
  // shrouds — 2 per side per mast (bow + stern cleat); the aftmost mast's
  // stern pair dedupes against its backstays
  for (const m of masts) {
    for (const side of SIDES) {
      add(masthead(m), `anchor-cleat-bow-${side}`, 'shroud');
      add(masthead(m), `anchor-cleat-stern-${side}`, 'shroud');
    }
  }
  // yard lifts + braces (both yard levels) + sheets, in blueprint order
  for (const piece of blueprint) {
    if (piece.kind !== 'yard') continue;
    const match = /^yard-(\w+)-(\w+)$/.exec(piece.id);
    if (match === null) continue;
    const [, m, level] = match;
    for (const side of SIDES) {
      add(`anchor-${piece.id}-${side}`, masthead(m), 'lift');
      add(`anchor-${piece.id}-${side}`, `anchor-cleat-stern-${side}`, 'brace');
      if (level === 'lower') {
        add(`anchor-${piece.id}-${side}`, `anchor-cleat-bow-${side}`, 'sheet');
      }
    }
  }

  validateRiggingPlan(plan, blueprint);
  return plan;
}

/**
 * Sockets that get a wooden block (pulley) mesh: the socketA termination of
 * running-rigging entries, deduped in plan order and capped. Deterministic —
 * same plan, same blocks.
 */
export function selectBlockSockets(plan: RiggingRope[], cap: number): string[] {
  const out: string[] = [];
  const used = new Set<string>();
  for (const rope of plan) {
    if (!BLOCK_ROLES.has(rope.role) || used.has(rope.socketA)) continue;
    used.add(rope.socketA);
    out.push(rope.socketA);
    if (out.length >= cap) break;
  }
  return out;
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

/** Place block meshes at the selected sockets — same call pattern/cadence as
 *  applyRiggingPlan so blocks ride their anchors. */
export function applyBlocks(
  sockets: string[],
  blocks: BlocksHandle,
  socketWorldPosition: (id: string) => [number, number, number],
): void {
  sockets.forEach((id, index) => {
    const [x, y, z] = socketWorldPosition(id);
    blocks.setBlock(index, { x, y, z });
  });
  blocks.setBlockCount(sockets.length);
}
