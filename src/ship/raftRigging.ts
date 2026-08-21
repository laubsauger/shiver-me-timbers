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
 * Roles absent from a row are forbidden for that sail. The planner emits no
 * halyards yet (it has no masthead block socket), so the halyard column is
 * an allowance, not a count.
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

/** standing rigging: fore/aft/two side guys on the bipod, the mizzen's pair aft — and no more */
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
      // §B80: the raft's own rope radii, never the planner's galleon gear
      thickness: Math.min(rope.thickness, standing ? hempR : RAFT_ROPE_RADIUS[rope.role]),
      slack: standing ? Math.max(rope.slack, RAFT_STANDING_SLACK) : rope.slack,
    });
  }
  return out;
}
