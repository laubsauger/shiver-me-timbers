/**
 * §V12/§V13 ship rigging plan: maps a blueprint's named rope-anchor sockets
 * (ship system, §V13) onto rope descriptors for createRopes (§V12). The plan
 * is plain deterministic data keyed by SOCKET IDS, not positions — world
 * positions are resolved only in applyRiggingPlan, so main.ts re-applies the
 * same plan every time anchors move and the compute pass re-solves the
 * catenaries (§V14 → §V12).
 *
 * RULE 1 — RIGGING IS LOCAL (docs/ship-reference-schema.png, ship-full-view).
 * Every line stays inside its own mast bay; nothing fans from the stem to the
 * transom. A previous plan ran shrouds from EVERY masthead to BOTH end cleats
 * and braces from every yard to the transom: 20 of its 48 lines spanned the
 * whole hull and the ship read as a spider web. Layout now:
 *   stays      forestay (foremost masthead → bowsprit tip), inter-mast stays
 *              (masthead → next masthead), backstays from the AFTMOST masthead
 *              only, bobstays (bowsprit tip → bow cleats)
 *   shrouds    masthead → the chainplate FAN abeam of that same mast
 *   lifts      upper yard ends → their own masthead
 *   braces     yard ends → the chainplate of the NEXT MAST AFT (the aftmost
 *              mast's yards → the stern cleats)
 *   sheets     lower yard ends → the chainplate of the NEXT MAST FORWARD (the
 *              foremost mast's → the bow cleats). No sail-clew sockets exist
 *              yet, so the run starts at the yard end; adapt when they land.
 *   halyard    crow's nest → its masthead
 *
 * RULE 2 — NO ROPE MAY END INSIDE THE HULL OR HANG THROUGH THE DECK. The
 * catenary solver knows nothing about the ship, so clearance is a property of
 * WHERE a line is anchored and HOW MUCH slack it carries, and nothing else.
 * Hull-side ends therefore go to `anchor-channel-{side}-{mast}-{n}` — the
 * chainplate fan the ship system places just outboard of the deck edge each
 * mast is STEPPED on — never to a belaying cleat sitting inboard on the deck,
 * and never to a plate below that deck. Standing rigging is kept nearly
 * taut (STYLE below) because a bowing stay is what dips through a deck it
 * passes over. tests/shipRigging.test.ts samples the solved curve of every
 * rope against the ship's own loft and fails if any of it enters the solid.
 *
 * Only sockets present in the blueprint are referenced, and validateRiggingPlan
 * re-checks that — a socket rename in src/ship/ fails loud here instead of
 * silently mis-rigging.
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

/**
 * Per-role slack/thickness — rig design data. Standing rigging (stays,
 * shrouds) is set up nearly TAUT: it holds the mast up, and slack is also
 * exactly what lets a line bow far enough to sink through the deck it passes
 * over (user report). Running rigging is slacker and thinner, and is only led
 * outboard where a sag has nothing to intersect.
 */
const STYLE: Record<RigRole, { slack: number; thickness: number }> = {
  stay: { slack: 1.004, thickness: 0.05 },
  halyard: { slack: 1.03, thickness: 0.028 },
  shroud: { slack: 1.004, thickness: 0.04 },
  lift: { slack: 1.02, thickness: 0.03 },
  brace: { slack: 1.02, thickness: 0.025 },
  sheet: { slack: 1.02, thickness: 0.022 },
};

/** running rigging is worked through blocks; standing rigging is seized */
const BLOCK_ROLES: ReadonlySet<RigRole> = new Set(['halyard', 'lift', 'brace', 'sheet']);

const SIDES = ['port', 'starboard'] as const;

/**
 * How far below a mast's step its chainplate may sit before the shroud would
 * have to cross a deck (see the shroud loop). Chainplates are set a cap-rail's
 * depth (~0.3 m) under the sheer by design, so the margin only has to clear
 * that — anything approaching a castle's rise (~2 m) is a stepped deck.
 */
const STEPPED_DECK_MARGIN = 1;

/** literal ceiling on the chainplate-fan probe — the fan is discovered from
 *  the blueprint, this only bounds the loop (§V28 in spirit: no open scan) */
const MAX_CHANNEL_PLATES = 8;

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
    if (!ids.has(socketA) || !ids.has(socketB) || socketA === socketB) return;
    if (seen.has(key)) return;
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
  /** where a brace or sheet is belayed at a mast: the forward-most plate of
   *  its chainplate fan. Falls back to the deprecated unnumbered alias so an
   *  older blueprint still rigs (the ship system may delete that alias). */
  const belay = (side: string, m: string): string => {
    const plate = `anchor-channel-${side}-${m}-1`;
    return ids.has(plate) ? plate : `anchor-channel-${side}-${m}`;
  };

  // stays: forestay, inter-mast, backstays from the AFTMOST masthead only (a
  // backstay off every masthead is what dragged lines the length of the ship),
  // bobstays holding the bowsprit down against the forestay's pull
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
  // shrouds: a FAN down the ship's side to the chainplates abeam of the same
  // mast — never to a cleat at the far end of the hull. The ship system sizes
  // the fan (params/ship channelPlates/channelPlateSpacing) and exposes it as
  // `anchor-channel-{side}-{mast}-{1..n}`; consume every plate it declares
  // rather than second-guessing the count here (§V16 owns the tunable).
  const socketY = socketHeights(blueprint);
  for (const piece of mastPieces) {
    const m = piece.id.replace(/^mast-/, '');
    for (const side of SIDES) {
      for (let plate = 1; plate <= MAX_CHANNEL_PLATES; plate++) {
        const foot = `anchor-channel-${side}-${m}-${plate}`;
        if (!ids.has(foot)) break;
        // A mast stepped on a raised deck (the galleon's mizzen stands on the
        // quarterdeck) whose chainplate is still down on the main shell would
        // have to run its shrouds THROUGH that deck — the fault the user saw
        // as rope "going into the ship". Skip such a plate rather than draw
        // it; the mast keeps its backstays and inter-mast stay meanwhile.
        const drop = piece.transform.position[1] - (socketY.get(foot) ?? -Infinity);
        if (drop > STEPPED_DECK_MARGIN) continue;
        add(masthead(m), foot, 'shroud');
      }
    }
  }
  // yard lines: lift up to the own masthead (upper yards), brace aft into the
  // next bay, sheet forward into the previous one — never end to end
  for (const piece of blueprint) {
    if (piece.kind !== 'yard') continue;
    const match = /^yard-(\w+)-(\w+)$/.exec(piece.id);
    if (match === null) continue;
    const [, m, level] = match;
    const index = masts.indexOf(m);
    if (index < 0) continue;
    const aftMast = index + 1 < masts.length ? masts[index + 1] : undefined;
    const foreMast = index > 0 ? masts[index - 1] : undefined;
    for (const side of SIDES) {
      const end = `anchor-${piece.id}-${side}`;
      if (level === 'upper') add(end, masthead(m), 'lift');
      add(end, aftMast === undefined
        ? `anchor-cleat-stern-${side}`
        : belay(side, aftMast), 'brace');
      if (level !== 'lower') continue;
      add(end, foreMast === undefined
        ? `anchor-cleat-bow-${side}`
        : belay(side, foreMast), 'sheet');
    }
  }

  validateRiggingPlan(plan, blueprint);
  return plan;
}

/**
 * Ship-local height of every socket (carrier piece + socket offset). Hull
 * pieces are axis-aligned in ship space so the sum is exact for the sockets
 * this is used on; it only ever gates the shroud guard above, never a
 * position that reaches the GPU.
 */
function socketHeights(blueprint: PieceDef[]): Map<string, number> {
  const heights = new Map<string, number>();
  for (const piece of blueprint) {
    for (const socket of piece.sockets) {
      heights.set(socket.id, piece.transform.position[1] + socket.position[1]);
    }
  }
  return heights;
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
 * CPU work, the curve math stays on the GPU. Socket lookups are memoised for
 * the call — the whole rig shares ~25 sockets across ~38 ropes. Throws (from
 * setRope) if the plan exceeds the handle's maxRopes capacity.
 */
export function applyRiggingPlan(
  plan: RiggingRope[],
  ropes: RopesHandle,
  socketWorldPosition: (id: string) => [number, number, number],
): void {
  const cache = new Map<string, [number, number, number]>();
  const at = (id: string): [number, number, number] => {
    let p = cache.get(id);
    if (p === undefined) {
      p = socketWorldPosition(id);
      cache.set(id, p);
    }
    return p;
  };
  plan.forEach((rope, index) => {
    const [ax, ay, az] = at(rope.socketA);
    const [bx, by, bz] = at(rope.socketB);
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
