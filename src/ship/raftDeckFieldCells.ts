/**
 * Raft deck-field geometry (§T92 / §V83) — the per-point evaluator behind
 * raftDeckField.ts. Pure maths on the piece graph + raftLayout; no three.js.
 *
 * THE FIELD IS A WALK SURFACE AND A WATER TERRAIN, NOT A RENDER MESH. The
 * first-person walker (src/player/playerStep.ts) refuses any stride whose
 * 0.15 m look-ahead climbs steeper than its max slope (40°), and a round log
 * is steeper than that beyond 0.64 r from its crown — a pure circle profile
 * wedged the capsule in every chink when crossing the logs athwartships. So
 * every round member here is drawn as its circle CAP with 35° tangent cones
 * below it, every mat edge is a 35° ramp outside its footprint, and the
 * cabin sill is a 35° ramp through the doorway. The eye sees round logs (the
 * mesh is built elsewhere); the foot sees a log a person can actually step
 * across. Largest deviation from the true surface: ~0.16 m at a log's edge,
 * exactly where a foot never rests anyway.
 *
 * Chinks (2–8 cm) are narrower than a foot. The floor of a chink is the log
 * surface where a RAFT_FOOT_RADIUS sole bridging the gap touches the higher
 * of its two logs, so the height dips (water pools along the seam) but never
 * falls toward the waterline. §V83: foot radius > chink ⇒ no fall-through.
 */
import type { PieceDef } from './pieceTypes';
import { raftLayout, type RaftLayout } from './raftPartsLayout';
import { raftParams, type RaftParams } from '../params/raft';

/** half-width of a foot sole — what bridges a chink */
export const RAFT_FOOT_RADIUS = 0.12;
/** steepest slope the field presents to the walker (tan 35°; walker limit 40°) */
export const RAFT_WALK_SLOPE = Math.tan((35 * Math.PI) / 180);
/** how far a solid piece stands proud of the deck in `data` (its real top, capped) */
const SOLID_HEIGHT_CAP = 1.0;

const SIN_A = RAFT_WALK_SLOPE / Math.sqrt(1 + RAFT_WALK_SLOPE * RAFT_WALK_SLOPE);
const COS_A = 1 / Math.sqrt(1 + RAFT_WALK_SLOPE * RAFT_WALK_SLOPE);

/**
 * Section of a round member of radius `r` at horizontal distance `d` from
 * its axis: circle cap, then the 35° tangent cone down to the axis plane.
 * Returns height above the AXIS (0 beyond the cone's foot).
 */
export function barProfile(d: number, r: number): number {
  return Math.max(0, barSkirt(d, r));
}

/**
 * §T.152 — THE SAME SECTION WITH NO FLOOR UNDER IT: the cone keeps falling
 * past the axis plane instead of stopping in it.
 *
 * A member laid ON something has its axis a radius above what it rests on —
 * a crossbeam's axis is 0.15 m over the log crowns, a foot-rail's 0.06 m —
 * so a cone that stopped at the axis plane ended in a VERTICAL LIP of that
 * height at its foot (0.19 m at a crossbeam, 0.08 m at a foot-rail). The lip
 * is under the walker's `stepUp`, so he never reads it as a wall; his 0.15 m
 * slope probe reads it as a 7 : 1 face and `admits()` REFUSES the stride. He
 * is stopped by nothing, at every beam not buried under a mat — which is the
 * stumbling §T.152 was opened for. Let the skirt run on down and `Math.max`
 * against the logs absorbs it wherever it is already below them, leaving one
 * continuous 35° surface from the log crown to the beam's crown.
 *
 * Returns height above the axis, NEGATIVE below it — never clamped.
 */
export function barSkirt(d: number, r: number): number {
  if (r <= 0) return -Infinity;
  const d0 = r * SIN_A;
  if (d <= d0) return Math.sqrt(Math.max(0, r * r - d * d));
  return r * COS_A - (d - d0) * RAFT_WALK_SLOPE;
}

interface LogGeom {
  x: number;
  r: number;
  zStern: number;
  zBow: number;
  taper: number;
  chamfer: number;
}

interface Bar {
  /** 'x' = axis along x (crossbeam), 'z' = along z (foot-rail) */
  axis: 'x' | 'z';
  /** axis line coordinate (z for an x-bar, x for a z-bar) and axis height */
  at: number;
  y: number;
  r: number;
  /** extent along the axis */
  lo: number;
  hi: number;
}

interface Slab {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  top: number;
  /** mats ramp down outside their footprint; the cabin floor does not */
  ramp: boolean;
}

interface Solid {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  top: number;
}

export interface RaftFieldLayout {
  p: RaftParams;
  L: RaftLayout;
  axisY: number;
  deckY: number;
  logs: LogGeom[];
  chinks: number[];
  bars: Bar[];
  slabs: Slab[];
  solids: Solid[];
  /** cabin doorway sill: ramp from the floor edge at `x` outward, over z0..z1 */
  sill: { x: number; z0: number; z1: number; top: number } | null;
  /** ship-space rectangle the field should cover */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** ship-space position of a piece, resolving one level of parenting */
function shipPos(byId: Map<string, PieceDef>, p: PieceDef): [number, number, number] {
  const parent = p.parent === undefined ? undefined : byId.get(p.parent);
  const base = parent === undefined ? [0, 0, 0] : parent.transform.position;
  return [
    base[0] + p.transform.position[0],
    base[1] + p.transform.position[1],
    base[2] + p.transform.position[2],
  ];
}

function rectOf(pos: [number, number, number], piece: PieceDef, top?: number): Solid {
  return {
    x0: pos[0] + piece.aabb.min[0],
    x1: pos[0] + piece.aabb.max[0],
    z0: pos[2] + piece.aabb.min[2],
    z1: pos[2] + piece.aabb.max[2],
    top: top ?? pos[1] + piece.aabb.max[1],
  };
}

/** harvest everything the evaluator needs from the blueprint + layout */
export function readRaftField(blueprint: PieceDef[], p: RaftParams = raftParams): RaftFieldLayout {
  const L = raftLayout(p);
  const byId = new Map(blueprint.map((pc) => [pc.id, pc]));
  const logs: LogGeom[] = L.logs.map((l) => ({
    x: l.x,
    r: l.r,
    zStern: l.zStern,
    zBow: l.zBow,
    taper: p.logBowTaper,
    chamfer: p.logBowChamfer,
  }));
  const bars: Bar[] = [];
  const slabs: Slab[] = [];
  const solids: Solid[] = [];
  let floor: Solid | null = null;
  let wallAft: Solid | null = null;
  let wallFwd: Solid | null = null;

  for (const piece of blueprint) {
    const pos = shipPos(byId, piece);
    const bottom = pos[1] + piece.aabb.min[1];
    switch (piece.kind) {
      case 'log':
        // the nine hull logs come from the layout; a 'log' piece that is not
        // one of them is a foot-rail lying along z on top of the outer log
        if (!piece.id.startsWith('log-')) {
          bars.push({
            axis: 'z', at: pos[0], y: pos[1], r: piece.aabb.max[0],
            lo: pos[2] + piece.aabb.min[2], hi: pos[2] + piece.aabb.max[2],
          });
        }
        break;
      case 'crossbeam':
        bars.push({
          axis: 'x', at: pos[2], y: pos[1], r: piece.aabb.max[1],
          lo: pos[0] + piece.aabb.min[0], hi: pos[0] + piece.aabb.max[0],
        });
        break;
      case 'bamboo-deck': {
        // the lookout platform is a bamboo deck too, 8.8 m up — a different
        // level the player reaches by the ladder action, not by walking
        if (piece.shape?.platform !== undefined) break;
        const r = rectOf(pos, piece);
        const isFloor = piece.shape?.boxes !== undefined;
        slabs.push({ ...r, ramp: !isFloor });
        if (isFloor) floor = r;
        break;
      }
      case 'cabin-wall': {
        const r = rectOf(pos, piece);
        solids.push(r);
        if (piece.id === 'cabin-wall-starboard-aft') wallAft = r;
        if (piece.id === 'cabin-wall-starboard-fwd') wallFwd = r;
        break;
      }
      case 'bipod-mast':
      case 'mast':
        // only poles STEPPED on the logs block the walker: the topsail pole
        // starts at the crossing and the rope ladder hangs off a leg
        if (piece.parent !== undefined || bottom > L.logTopY + 0.5) break;
        solids.push(rectOf(pos, piece, bottom + SOLID_HEIGHT_CAP));
        break;
      case 'guara':
        // the plank rides up and down; its station cell is always occupied
        solids.push(rectOf(pos, piece, L.logTopY + 0.6));
        break;
      case 'crate':
      case 'stern-block':
        // a crate hanging under the roof (the parrot cage) is not on the deck
        if (bottom > L.cabinFloorY + 0.3) break;
        solids.push(rectOf(pos, piece));
        break;
      default:
        break;
    }
  }

  let sill: RaftFieldLayout['sill'] = null;
  if (floor !== null && wallAft !== null && wallFwd !== null) {
    const f = floor as Solid;
    sill = { x: f.x1, z0: (wallAft as Solid).z1, z1: (wallFwd as Solid).z0, top: f.top };
  }

  const rMax = Math.max(...logs.map((l) => l.r));
  const outer = Math.max(...logs.map((l) => Math.abs(l.x))) + rMax + 0.1;
  return {
    p, L,
    axisY: p.logAxisY,
    deckY: L.logTopY,
    logs,
    chinks: L.chinks,
    bars, slabs, solids, sill,
    minX: -outer,
    maxX: outer,
    minZ: Math.min(...logs.map((l) => l.zStern)) - 0.1,
    maxZ: L.bowZ + 0.1,
  };
}

/** radius of a log at z: linear bow taper, then the chamfered tip to a point */
export function logRadiusAt(log: LogGeom, z: number): number {
  if (z < log.zStern || z > log.zBow) return 0;
  const len = Math.max(1e-6, log.zBow - log.zStern);
  const t = (z - log.zStern) / len;
  const r = log.r * (1 - (1 - log.taper) * t);
  const tip = log.zBow - z;
  return tip < log.chamfer ? r * (tip / Math.max(1e-6, log.chamfer)) : r;
}

export interface RaftCell {
  /** ship-space y of the surface */
  y: number;
  /** 1 inside the hull outline (logs + chinks), 0 outboard */
  mask: number;
  solid: number;
}

/** the surface at one ship-space point; `padX/padZ` widen solids to ≥ 1 texel */
export function raftStructureAt(F: RaftFieldLayout, x: number, z: number, padX = 0, padZ = 0): RaftCell {
  let y = F.axisY;
  let covered = false;
  const rs: number[] = new Array<number>(F.logs.length);
  for (let k = 0; k < F.logs.length; k++) {
    const log = F.logs[k];
    const r = logRadiusAt(log, z);
    rs[k] = r;
    if (r <= 0) continue;
    const d = Math.abs(x - log.x);
    if (d <= r) covered = true;
    y = Math.max(y, F.axisY + barProfile(d, r));
  }
  // chink floors: a sole of RAFT_FOOT_RADIUS bridging the gap rests on the
  // higher of its two contacts, `inset` in from each log's edge
  for (let k = 0; k < F.chinks.length; k++) {
    const a = F.logs[k];
    const b = F.logs[k + 1];
    if (x < a.x || x > b.x) continue;
    const ra = rs[k];
    const rb = rs[k + 1];
    if (ra <= 0 || rb <= 0) continue;
    covered = true;
    const inset = Math.max(0, RAFT_FOOT_RADIUS - F.chinks[k] / 2);
    const fa = barProfile(Math.max(0, ra - inset), ra);
    const fb = barProfile(Math.max(0, rb - inset), rb);
    y = Math.max(y, F.axisY + Math.max(fa, fb));
  }
  if (!covered) return { y, mask: 0, solid: 0 };

  for (const bar of F.bars) {
    // distance to the bar's AXIS SEGMENT, so its ends carry the same 35°
    // skirt its sides do — a foot-rail that stops abeam the cabin used to
    // drop its whole crown in one texel (§T.152)
    const along = bar.axis === 'x' ? x : z;
    const perp = Math.abs((bar.axis === 'x' ? z : x) - bar.at);
    const past = Math.max(bar.lo - along, along - bar.hi, 0);
    y = Math.max(y, bar.y + barSkirt(Math.hypot(perp, past), bar.r));
  }
  for (const s of F.slabs) {
    const dx = Math.max(s.x0 - x, x - s.x1, 0);
    const dz = Math.max(s.z0 - z, z - s.z1, 0);
    const out = Math.max(dx, dz);
    if (out > 0 && !s.ramp) continue;
    y = Math.max(y, s.top - out * RAFT_WALK_SLOPE);
  }
  if (F.sill !== null && z >= F.sill.z0 && z <= F.sill.z1 && x > F.sill.x) {
    y = Math.max(y, F.sill.top - (x - F.sill.x) * RAFT_WALK_SLOPE);
  }

  let solid = 0;
  for (const s of F.solids) {
    if (x < s.x0 - padX || x > s.x1 + padX || z < s.z0 - padZ || z > s.z1 + padZ) continue;
    solid = 1;
    // stand proud in `data` too, so the water solver's head keeps water out
    // of it the way it does for the bulwarks (deckwater ignores `solid`)
    y = Math.max(y, Math.min(s.top, y + SOLID_HEIGHT_CAP));
  }
  return { y, mask: 1, solid };
}
