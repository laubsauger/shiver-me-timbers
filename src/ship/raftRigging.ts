/**
 * The raft's rigging plan (§B73/§B79): the shared planner's ropes, CUT DOWN
 * to the Kon-Tiki's gear and with the standing rigging eased.
 *
 * §B79 — the planner is a square-rigger's: per sail it emits sheets, braces,
 * lifts and a 3-segment buntline each side, and the raft inherited 69 ropes
 * ("way too many ropes, way too crowded — on the tiny back sail that's an
 * insane amount"). Heyerdahl's rig [§4 Controls: "sheets port/starboard from
 * clews; braces"; §4 Standing rigging: "fibre stays + guys fore/aft/sides"]
 * and [ref-sails-1947] show the table below and nothing else — no buntlines,
 * no leechlines, no lifts on a bamboo yard. `RAFT_ROPE_TABLE` is the one
 * owner of that decision; the §T89 test counts against it.
 *
 * Slack: the galleon's stays are set up near-taut (shipRigging STYLE, 1.004)
 * because a shroud that sagged read as a broken mast. Kon-Tiki's fibre stays
 * and guys sag visibly in every 1947 frame — knotted, no turnbuckles — so
 * here they carry `RAFT_STANDING_SLACK` of rope per chord. Pure: the plan is
 * data, the rope solver (src/ropes) does the hanging (§V45).
 */
import type { PieceDef } from './pieceTypes';
import { buildRiggingPlan, type RigRole, type RiggingRope } from '../ropes/shipRigging';
import { raftParams, type RaftParams } from '../params/raft';

/** rope length ÷ chord for the raft's stays, shrouds and guys — EST [ref-sails-1947] */
export const RAFT_STANDING_SLACK = 1.02;

/** the sails the plan addresses, by the `sail-{mast}-{level}` id stem */
export type RaftSailKey = 'main-lower' | 'main-upper' | 'mizzen-lower';

/**
 * Running rigging per sail: the MOST of each role a sail may carry.
 *   main    — 2 sheets + 2 braces (+ halyard, + ≤ 2 lifts) [§4 Controls]
 *   topsail — 2 sheets (+ halyard); it is set flying, no braces [ref-sails-1947]
 *   mizzen  — ≤ 2 sheets (+ halyard); a loose sail on a sprit, no braces
 * Roles absent from a row are forbidden for that sail. The planner still
 * emits no halyards — its one halyard rule runs from a CROW'S NEST, which a
 * raft does not have — so each sail's halyard comes from `RAFT_EXTRA_ROPES`
 * below and this column is what the §T89 test counts it against.
 */
export const RAFT_ROPE_TABLE: Record<RaftSailKey, Partial<Record<RigRole, number>>> = {
  'main-lower': { sheet: 2, brace: 2, halyard: 1, lift: 2 },
  'main-upper': { sheet: 2, halyard: 1 },
  'mizzen-lower': { sheet: 2, halyard: 1 },
};

/**
 * §B80 — rope RADIUS (m) per role; `RiggingRope.thickness` is the tube radius
 * the rope mesh extrudes. Lashings and stays are 30 mm hemp [§1 Lashing]
 * (radius 0.015); sheets, braces and halyards ~20 mm (0.010). The planner's
 * 50 mm-radius stays were as thick as the raft's yard.
 */
export const RAFT_ROPE_RADIUS: Record<RigRole, number> = {
  stay: 0.015,
  shroud: 0.015,
  halyard: 0.01,
  sheet: 0.01,
  brace: 0.01,
  lift: 0.01,
  buntline: 0.008,
  leechline: 0.008,
};

/** running gear on a raft is knotted and eased, not set up on a winch */
export const RAFT_RUNNING_SLACK = 1.02;

/**
 * §T.140/§V66 — A BLOCK'S SHELL, FROM THE ROPE IT IS SEIZED INTO.
 *
 * USER, against `docs/raft2100/ref/kon-tiki-rig-proportions.png`: "the rope
 * blocks look a little oversized for this boat." They were: every ship in the
 * game took `ropeParams.blockSize` = 0.25 m, a number tuned on the galleon,
 * whose halyards are 56 mm. The raft's running gear is 20 mm [§B80 above], so
 * the same shell reads at 12 rope-diameters — a ship's block on a raft's line.
 *
 * 7 is the traditional proportion and it is what the photo shows: the block
 * hanging on the main halyard forward of the sail measures ~0.25 × 0.17 m at
 * the frame's 129 px/m, on 30 mm hemp. `RiggingRope.thickness` is a RADIUS
 * (§B80), so the shell is 14 × that: 0.14 m on the 20 mm running gear, 0.21 m
 * on the 30 mm standing hemp — sized by the line, at any line.
 */
export const RAFT_BLOCK_PER_ROPE_DIAMETER = 7;

export const raftBlockSize = (rope: Pick<RiggingRope, 'thickness'>): number =>
  Math.max(0.04, rope.thickness * 2 * RAFT_BLOCK_PER_ROPE_DIAMETER);

/**
 * §B86-1 — THE GEAR THE SHARED PLANNER CANNOT SEE, and why it is a table
 * here rather than a rule there.
 *
 * `buildRiggingPlan` reaches a bow only through a BOWSPRIT and hoists only
 * from a CROW'S NEST; the raft has neither, so it emitted no halyard and no
 * forestay at all — a rig of three sails nobody could ever have got up. The
 * 1947 frame has both: stays fanning to the crossing, one line running on to
 * the stem, and the ensign on its own halyard aft.
 *
 * Each row is named by SOCKET, like every other rope in the plan, so a socket
 * rename fails loud in `validateRiggingPlan` instead of silently mis-rigging,
 * and they are counted against the same §B79 cap as everything else.
 *
 * WHERE EACH RUN GOES IS A §V71 DECISION, not a convenience: the bipod rakes
 * AFT and every sail hangs FORWARD of it, so a halyard belayed on the fore
 * deck would pass straight through the mainsail, and a forestay taken from
 * the POLE TIP would graze the topsail's head. Both halyards come down the
 * mast's aft side; the forestay leaves from the crossing, where this raft's
 * standing rigging is made fast anyway.
 */
export interface RaftExtraRope {
  a: string;
  b: string;
  role: RigRole;
  /** the sail this line works, for the §B79 per-sail count; absent = none */
  sail?: RaftSailKey;
}

export const RAFT_EXTRA_ROPES: readonly RaftExtraRope[] = [
  { a: 'anchor-hounds-main', b: 'anchor-stem-bow', role: 'stay' },
  { a: 'anchor-hounds-main', b: 'anchor-belay-main-port', role: 'halyard', sail: 'main-lower' },
  { a: 'anchor-masthead-main', b: 'anchor-belay-main-starboard', role: 'halyard', sail: 'main-upper' },
  { a: 'anchor-masthead-mizzen', b: 'anchor-cleat-stern-mid', role: 'halyard', sail: 'mizzen-lower' },
  // the ensign's own halyard — the one line aboard that hoists something
  // which is not canvas, so it answers to no row of RAFT_ROPE_TABLE
  { a: 'anchor-truck-flag', b: 'anchor-cleat-stern-starboard', role: 'halyard' },
];

const extraKey = (role: RigRole, a: string, b: string): string => `${role}|${a}|${b}`;

const EXTRA_BY_KEY = new Map(RAFT_EXTRA_ROPES.map((e) => [extraKey(e.role, e.a, e.b), e]));

/** the raft-only row a rope came from, or null if the shared planner made it */
export function raftExtraRopeOf(rope: Pick<RiggingRope, 'role' | 'socketA' | 'socketB'>): RaftExtraRope | null {
  return EXTRA_BY_KEY.get(extraKey(rope.role, rope.socketA, rope.socketB)) ?? null;
}

/**
 * Which sail a rope in the raft's plan works — from its socket names where the
 * planner made it, from the table where this file did. Null = it works no
 * sail: the standing rigging, and the ensign's halyard.
 */
export function raftRopeSail(rope: Pick<RiggingRope, 'role' | 'socketA' | 'socketB'>): RaftSailKey | null {
  return raftSailKeyOf(rope.socketA) ?? raftSailKeyOf(rope.socketB) ?? raftExtraRopeOf(rope)?.sail ?? null;
}

/** standing rigging: two side guys on the bipod, the mizzen's line and its pair aft, the forestay — and no more */
export const RAFT_STANDING_MAX = 6;
/** the whole raft, every rope [§B79 "total raft ropes < 25"] */
export const RAFT_ROPE_MAX = 24;

const RUNNING: ReadonlySet<RigRole> = new Set<RigRole>(['sheet', 'brace', 'halyard', 'lift']);

/** `sail-main-lower-clew-port` / `yard-main-upper-port` → `main-upper`, or null for standing gear */
export function raftSailKeyOf(socket: string): RaftSailKey | null {
  const m = /^anchor-(?:sail|yard)-(main|mizzen)-(lower|upper)-/.exec(socket);
  if (m === null) return null;
  return `${m[1]}-${m[2]}` as RaftSailKey;
}

/**
 * §T.145 — where a `main-upper` SHEET belays, or null for every other rope.
 * Keyed off the clew's own side so the port sheet lands on the port leg.
 */
export function raftSheetBelay(rope: Pick<RiggingRope, 'role' | 'socketA' | 'socketB'>): string | null {
  if (rope.role !== 'sheet' || raftSailKeyOf(rope.socketA) !== 'main-upper') return null;
  return rope.socketA.endsWith('-port') ? 'anchor-belay-topsail-port' : 'anchor-belay-topsail-starboard';
}

export function buildRaftRiggingPlan(blueprint: PieceDef[], p: RaftParams = raftParams): RiggingRope[] {
  // the standing rigging IS the lashing rope: 30 mm hemp, radius half of it
  const hempR = Math.max(0.0025, p.lashingRopeDiameter / 2);
  const seen = new Set<string>();
  const count = new Map<string, number>();
  const out: RiggingRope[] = [];
  for (const rope of buildRiggingPlan(blueprint)) {
    // the planner can emit a rope twice (both sides of a shared socket); one is enough
    const id = `${rope.role}|${rope.socketA}|${rope.socketB}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const standing = rope.role === 'stay' || rope.role === 'shroud';
    if (standing) {
      // the mizzen's own shrouds are the planner's; a 4 m pole is guyed by its
      // two stern stays and the line to the main crossing [ref-sails-1947]
      if (rope.role === 'shroud' && rope.socketA.includes('mizzen')) continue;
    } else {
      if (!RUNNING.has(rope.role)) continue; // buntlines, leechlines: a square-rigger's
      const key = raftSailKeyOf(rope.socketA) ?? raftSailKeyOf(rope.socketB);
      if (key === null) continue;
      const allowed = RAFT_ROPE_TABLE[key][rope.role] ?? 0;
      const k = `${key}|${rope.role}`;
      const n = count.get(k) ?? 0;
      if (n >= allowed) continue;
      count.set(k, n + 1);
    }
    out.push({
      ...rope,
      // §T.145: the topsail's sheets come down to their OWN pins on the bipod.
      // The shared planner has one rule — a sheet belays at the next mast aft
      // — and on a two-masted raft that put BOTH square sails' sheets on the
      // same two sockets, which is a mis-rig the plan cannot see (it dedupes
      // by role+ends, and these differ only in their clew end).
      socketB: raftSheetBelay(rope) ?? rope.socketB,
      // §B80: the raft's own rope radii, never the planner's galleon gear
      thickness: Math.min(rope.thickness, standing ? hempR : RAFT_ROPE_RADIUS[rope.role]),
      slack: standing ? Math.max(rope.slack, RAFT_STANDING_SLACK) : rope.slack,
    });
  }
  for (const e of RAFT_EXTRA_ROPES) {
    const id = extraKey(e.role, e.a, e.b);
    if (seen.has(id)) continue;
    seen.add(id);
    const standing = e.role === 'stay' || e.role === 'shroud';
    out.push({
      socketA: e.a,
      socketB: e.b,
      role: e.role,
      thickness: standing ? hempR : RAFT_ROPE_RADIUS[e.role],
      slack: standing ? RAFT_STANDING_SLACK : RAFT_RUNNING_SLACK,
    });
  }
  return out;
}
