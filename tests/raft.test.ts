/**
 * §T89 — the Kon-Tiki raft blueprint, held to the reference as PROPERTIES
 * (§V80/§V82): relations between parts, not metre values a legitimate
 * re-tune would break. GPU-free: stub material factory, geometry only.
 *
 * Frame convention (verified against blueprintParts/blueprintEnds, which
 * build `['port', -1], ['starboard', 1]`): +x = STARBOARD, +z = bow.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Material } from 'three';
import { buildRaftBlueprint, raftLayout } from '../src/ship/raftBlueprint';
import { buildBrigantineBlueprint } from '../src/ship/shipBlueprint';
import { buildPieceGeometry, buildSailGeometry } from '../src/ship/pieceGeometry';
import { ShipAssembly } from '../src/ship/shipAssembly';
import { buildRiggingPlan, validateRiggingPlan } from '../src/ropes/shipRigging';
import { updateRig } from '../src/ship/rigTrim';
import { playerParams } from '../src/params/player';
import { buildRatlinePlan } from '../src/ship/ratlinePlan';
import { raftParams } from '../src/params/raft';
import { shipDetailParams, shipMaterialParams } from '../src/params/ship';
import { readSailWindRef, sailDrive } from '../src/ship/sailDynamics';
import { yardAttitude } from '../src/ship/raftPartsRig';
import { cabinRoom, radioCorner, roofSlope } from '../src/ship/raftPartsCabin';
import { thatchCourses, thatchEaveButts } from '../src/ship/pieceGeometryRaft';
import {
  buildRaftRiggingPlan,
  raftExtraRopeOf,
  raftRopeSail,
  RAFT_ROPE_MAX,
  RAFT_ROPE_TABLE,
  RAFT_RUNNING_SLACK,
  RAFT_STANDING_MAX,
  RAFT_STANDING_SLACK,
} from '../src/ship/raftRigging';
import {
  readSailSparSources,
  resolveSailSpars,
  sheetLeadDirections,
  type SailSparCapsule,
} from '../src/ship/sailFrame';
import { shipRigParams } from '../src/params/ship';
import { furlBundleRadius, sailTieSpec } from '../src/ship/pieceGeometrySail';
import { buildShipBlueprint } from '../src/ship/previewRaft';
import type { PieceDef } from '../src/ship/pieceTypes';

const stubFactory = () => ({ dispose(): void {} }) as unknown as Material;

const STATIONS = [
  'station-tiller', 'station-radio', 'station-chart', 'station-mat',
  'station-sheet-p', 'station-sheet-s', 'station-halyard',
  'station-guara-1', 'station-guara-2', 'station-guara-3', 'station-guara-4', 'station-guara-5',
  'station-ladder', 'station-lookout',
  'station-gangway-bow', 'station-gangway-stbd', 'station-gangway-port', 'station-gangway-stern',
];
/** spec spells the starboard gangway `stbd`; the piece ids use the full word everywhere else */
const socketAlias = (id: string): string => (id === 'station-gangway-stbd' ? 'station-gangway-starboard' : id);

function triCount(p: PieceDef): number {
  const g = p.kind === 'sail' ? buildSailGeometry('full', p.aabb) : buildPieceGeometry(p.kind, p.aabb, p.shape);
  const n = g.index !== null ? g.index.count / 3 : g.attributes.position.count / 3;
  g.dispose();
  return n;
}

function totalTris(bp: PieceDef[]): number {
  return bp.reduce((n, p) => n + triCount(p), 0);
}

/** world-space box of a piece's mesh through the live assembly (rotations included) */
function worldBox(asm: ShipAssembly, id: string): THREE.Box3 {
  const mesh = asm.group.getObjectByName(`${id}-mesh`) as THREE.Mesh | undefined;
  if (mesh === undefined) throw new Error(`no mesh for ${id}`);
  asm.group.updateWorldMatrix(true, true);
  mesh.geometry.computeBoundingBox();
  return mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld);
}

/** every triangle of a piece's mesh, in world space, with its own plane */
interface Facet {
  id: string;
  /** unit normal, world space */
  n: THREE.Vector3;
  /** plane constant: n·v for any vertex on it */
  d: number;
  p: readonly THREE.Vector3[];
}

function facetsOf(asm: ShipAssembly, id: string): Facet[] {
  const mesh = asm.group.getObjectByName(`${id}-mesh`) as THREE.Mesh | undefined;
  if (mesh === undefined) throw new Error(`no mesh for ${id}`);
  asm.group.updateWorldMatrix(true, true);
  const pos = mesh.geometry.attributes.position;
  const index = mesh.geometry.index;
  const count = index !== null ? index.count : pos.count;
  const out: Facet[] = [];
  for (let i = 0; i + 2 < count; i += 3) {
    const p = [0, 1, 2].map((k) => new THREE.Vector3()
      .fromBufferAttribute(pos, index !== null ? index.getX(i + k) : i + k)
      .applyMatrix4(mesh.matrixWorld));
    const n = new THREE.Vector3().subVectors(p[1], p[0])
      .cross(new THREE.Vector3().subVectors(p[2], p[0]));
    const len = n.length();
    if (len < 1e-12) continue; // a degenerate cap triangle carries no surface
    n.divideScalar(len);
    out.push({ id, n, d: n.dot(p[0]), p });
  }
  return out;
}

/** signed area of a 2D polygon (shoelace) */
function polyArea(poly: readonly (readonly [number, number])[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

/** area the two facets have in common, in their shared plane (Sutherland–Hodgman) */
function sharedArea(a: Facet, b: Facet): number {
  const u = (Math.abs(a.n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0))
    .cross(a.n).normalize();
  const w = new THREE.Vector3().crossVectors(a.n, u);
  const flat = (f: Facet): [number, number][] => {
    const t = f.p.map((q) => [q.dot(u), q.dot(w)] as [number, number]);
    return polyArea(t) < 0 ? [t[0], t[2], t[1]] : t;
  };
  let poly: [number, number][] = flat(a);
  const clip = flat(b);
  for (let e = 0; e < clip.length && poly.length > 0; e++) {
    const [x0, y0] = clip[e];
    const [x1, y1] = clip[(e + 1) % clip.length];
    const side = (q: [number, number]): number => (x1 - x0) * (q[1] - y0) - (y1 - y0) * (q[0] - x0);
    const next: [number, number][] = [];
    for (let k = 0; k < poly.length; k++) {
      const c = poly[k];
      const nx = poly[(k + 1) % poly.length];
      const sc = side(c);
      const sn = side(nx);
      if (sc >= 0) next.push(c);
      if ((sc >= 0) !== (sn >= 0)) {
        const t = sc / (sc - sn);
        next.push([c[0] + (nx[0] - c[0]) * t, c[1] + (nx[1] - c[1]) * t]);
      }
    }
    poly = next;
  }
  return Math.abs(polyArea(poly));
}

/**
 * §T129 — CO-FACING COPLANAR OVERLAPS: the one arrangement the depth buffer
 * cannot separate, and the user's "the side walls and the back walls are stuck
 * in each other". Three conditions together, and only together:
 *   • the two triangles lie in the SAME plane, within `slack` metres;
 *   • they face the SAME way — a butt joint's two faces are anti-parallel, so
 *     one of them is always culled and it has never fought;
 *   • and they cover a common patch of AREA — the two halves of one quad share
 *     an edge, and two panels that merely meet along a line share a line.
 * Anything else (touching, parallel-and-offset, one behind the other) is legal
 * and this must not flag it, or every butted box on the raft is a "defect".
 */
function coplanarFights(
  asm: ShipAssembly, ids: readonly string[], slack = 0.001, minArea = 1e-4,
): string[] {
  const all = ids.flatMap((id) => facetsOf(asm, id));
  const bad = new Map<string, number>();
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i];
      const b = all[j];
      if (a.n.dot(b.n) < 1 - 1e-6) continue;
      if (Math.abs(a.d - b.d) > slack) continue;
      const area = sharedArea(a, b);
      if (area <= minArea) continue;
      const key = `${a.id} ∥ ${b.id} on n=(${a.n.toArray().map((v) => v.toFixed(2)).join(',')}) @ ${a.d.toFixed(4)}`;
      bad.set(key, (bad.get(key) ?? 0) + area);
    }
  }
  return [...bad].map(([k, area]) => `${k}: ${area.toFixed(3)} m² fighting`);
}

describe('§T89 raft blueprint — piece contract (§V13/§V18)', () => {
  const raft = buildRaftBlueprint();

  it('is deterministic: two builds are deep-equal, and it never reaches for Math.random', () => {
    expect(buildRaftBlueprint()).toEqual(buildRaftBlueprint());
    const ids = raft.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every piece AABB is finite and non-degenerate, every parent resolves', () => {
    const ids = new Set(raft.map((p) => p.id));
    for (const p of raft) {
      for (let i = 0; i < 3; i++) {
        expect(Number.isFinite(p.aabb.min[i]), p.id).toBe(true);
        expect(Number.isFinite(p.aabb.max[i]), p.id).toBe(true);
        expect(p.aabb.max[i], `${p.id} axis ${i}`).toBeGreaterThan(p.aabb.min[i]);
      }
      if (p.parent !== undefined) expect(ids.has(p.parent), `${p.id} -> ${p.parent}`).toBe(true);
    }
  });

  it('uses only the §I raft kinds plus the shared rig kinds the sail membrane needs', () => {
    const allowed = new Set(['log', 'crossbeam', 'bamboo-deck', 'guara', 'cabin-wall', 'thatch-roof',
      'bipod-mast', 'steering-oar', 'crate', 'splashboard', 'stern-block', 'lashing', 'mast', 'yard', 'sail', 'pennant',
      // §B87 dressing pass
      'radio', 'rope-rail']);
    for (const p of raft) expect(allowed.has(p.kind), `${p.id}: ${p.kind}`).toBe(true);
  });

  it('is cheaper than the brigantine in triangles (low-poly by construction)', () => {
    // WHY: the raft is walked in first person at 60 fps alongside the sierra
    // terrain; a raft heavier than a square-rigger would be spending the budget
    // on the wrong thing. Measured, not assumed.
    const raftTris = totalTris(raft);
    const brigTris = totalTris(buildBrigantineBlueprint());
    expect(raftTris).toBeGreaterThan(0);
    expect(raftTris).toBeLessThan(brigTris);
  });
});

describe('§V82 hull: nine staggered logs with chinks', () => {
  const p = raftParams;
  const raft = buildRaftBlueprint();
  const L = raftLayout();
  const logs = raft.filter((x) => x.kind === 'log' && x.id.startsWith('log-'));

  it('centre log longest, outer shortest, symmetric stagger, square stern, 3 projecting', () => {
    expect(logs).toHaveLength(p.logCount);
    const len = (x: PieceDef) => x.aabb.max[2] - x.aabb.min[2];
    const centre = logs[Math.floor(logs.length / 2)];
    for (const l of logs) expect(len(l)).toBeLessThanOrEqual(len(centre) + 1e-9);
    expect(len(logs[0])).toBeLessThan(len(centre));
    expect(len(logs[logs.length - 1])).toBeLessThan(len(centre));
    for (let k = 0; k < logs.length; k++) {
      const m = logs[logs.length - 1 - k];
      expect(len(logs[k])).toBeCloseTo(len(m), 9);
      // diameters and chinks are seeded per log [§1 Gaps "irregular"], so x is
      // mirror-symmetric only to within one chink + one diameter spread
      expect(Math.abs(logs[k].transform.position[0] + m.transform.position[0])).toBeLessThan(0.2);
    }
    // monotone: each log shorter than the one inboard of it
    for (let k = 1; k < logs.length / 2; k++) expect(len(logs[k])).toBeGreaterThan(len(logs[k - 1]));
    // square stern: all non-projecting logs share one stern line; the centre
    // three project further aft by the same amount
    const sternOf = (x: PieceDef) => x.transform.position[2] + x.aabb.min[2];
    const sterns = L.logs.map((l, k) => [l.projecting, sternOf(logs[k])] as const);
    const projecting = sterns.filter(([pr]) => pr);
    const flush = sterns.filter(([pr]) => !pr);
    expect(projecting).toHaveLength(p.sternProjectingLogs);
    for (const [, z] of flush) expect(z).toBeCloseTo(flush[0][1], 9);
    for (const [, z] of projecting) expect(z).toBeLessThan(flush[0][1]);
  });

  it('chinks lie within the reference band and no two logs interpenetrate', () => {
    for (let k = 0; k < logs.length - 1; k++) {
      const a = logs[k];
      const b = logs[k + 1];
      const gap = (b.transform.position[0] + b.aabb.min[0]) - (a.transform.position[0] + a.aabb.max[0]);
      expect(gap).toBeGreaterThanOrEqual(p.chinkMin - 1e-9);
      expect(gap).toBeLessThanOrEqual(p.chinkMax + 1e-9);
    }
    // and the seeded widths VARY — "irregular", not one gap nine times
    expect(new Set(L.chinks.map((c) => c.toFixed(4))).size).toBeGreaterThan(1);
  });

  it('no water between the logs: adjacent log SURFACES ≤ 8 cm apart over the decked span (§B81)', () => {
    // WHY: the user saw "a huge gap between the long logs, water visible" —
    // the bow taper ran the whole log. [§1 Gaps] 2–8 cm; the body is full-round
    const span = [L.cabinAftZ, L.cabinFrontZ + 0.5] as const; // the lashed, decked midsection, to the mast step
    for (let k = 0; k < logs.length - 1; k++) {
      const a = logs[k];
      const b = logs[k + 1];
      // the log is FULL-ROUND over the span: its geometry carries the aabb
      // radius from the stern to beyond the span's bow end (cylinders only
      // have vertices at their ends, so this reads the trunk's extent)
      const fullRoundTo = (lg: PieceDef): number => {
        const g = buildPieceGeometry(lg.kind, lg.aabb, lg.shape);
        const pos = g.attributes.position;
        const R = lg.aabb.max[0];
        let zMax = -Infinity;
        for (let i = 0; i < pos.count; i++) {
          if (Math.hypot(pos.getX(i), pos.getY(i)) < R - 1e-3) continue;
          zMax = Math.max(zMax, pos.getZ(i) + lg.transform.position[2]);
        }
        return zMax;
      };
      expect(fullRoundTo(a), `log ${k} full-round past the span`).toBeGreaterThanOrEqual(span[1]);
      expect(fullRoundTo(b), `log ${k + 1} full-round past the span`).toBeGreaterThanOrEqual(span[1]);
      const axisGap = b.transform.position[0] - a.transform.position[0];
      const surfaceGap = axisGap - a.aabb.max[0] - b.aabb.max[0];
      expect(surfaceGap, `logs ${k}/${k + 1}`).toBeLessThanOrEqual(0.08 + 1e-6);
      expect(surfaceGap).toBeGreaterThan(0); // they do not intersect either
    }
    // the taper is at the bow only: the trunk draws the full aabb radius
    const centre = logs[Math.floor(logs.length / 2)];
    expect(p.logTaperLength).toBeLessThan((centre.aabb.max[2] - centre.aabb.min[2]) * 0.3);
  });

  it('the bow is a V that the splashboards follow; the beam matches the crossbeams', () => {
    const bowOf = (x: PieceDef) => x.transform.position[2] + x.aabb.max[2];
    const centre = logs[Math.floor(logs.length / 2)];
    expect(bowOf(logs[0])).toBeLessThan(bowOf(centre) - 1);
    const boards = raft.filter((x) => x.kind === 'splashboard' && !x.id.endsWith('-side'));
    expect(boards).toHaveLength(2);
    for (const b of boards) {
      expect(Math.abs(b.transform.rotation[1])).toBeGreaterThan(0.2); // angled, not athwartships
      expect(b.transform.position[2]).toBeGreaterThan(L.cabinFrontZ); // forward
    }
    const beam = 2 * L.halfBeam + logs[0].aabb.max[0] * 2;
    expect(beam).toBeGreaterThan(p.crossbeamLength * 0.85);
    expect(beam).toBeLessThan(p.crossbeamLength * 1.15);
  });

  it('the splashboards are a LOW BULWARK down the fore-body, not a pair of boards at the tips (§B73)', () => {
    // WHY: the user read the old 35 cm boards at the log tips as "a frame";
    // [ref-sails-1947] shows them standing ~½ m over the logs and running aft
    // along both sides. Heights are relative to the LOG, runs to the hull.
    const outerR = Math.max(logs[0].aabb.max[1], logs[logs.length - 1].aabb.max[1]);
    const centreLen = logs[Math.floor(logs.length / 2)].aabb.max[2] - logs[Math.floor(logs.length / 2)].aabb.min[2];
    const sides = raft.filter((x) => x.kind === 'splashboard' && x.id.endsWith('-side'));
    expect(sides).toHaveLength(2);
    for (const b of sides) {
      const top = b.transform.position[1] + b.aabb.max[1];
      const logTop = p.logAxisY + outerR;
      expect(top - logTop).toBeGreaterThan(outerR * 1.2); // stands well over the log, ⊥ a lip
      expect(top - logTop).toBeLessThan(outerR * 3); // but a bulwark, ⊥ a wall
      const run = b.aabb.max[2] - b.aabb.min[2];
      expect(run).toBeGreaterThan(centreLen * 0.2); // runs well aft
      expect(run).toBeLessThan(centreLen * 0.6); // the stern is bare logs [§1 Deck coverage]
      expect(b.transform.position[2]).toBeGreaterThan(L.cabinFrontZ - 1); // the fore-body
      // outboard of the outer log, flush against it
      const outer = b.transform.position[0] < 0 ? logs[0] : logs[logs.length - 1];
      expect(Math.abs(b.transform.position[0])).toBeGreaterThan(Math.abs(outer.transform.position[0]) + outer.aabb.max[0]);
      expect(Math.abs(b.transform.position[0])).toBeLessThan(Math.abs(outer.transform.position[0]) + outer.aabb.max[0] + 0.2);
    }
  });
});

describe('§B73 the rig is janky — seeded, scaled by irregularity, never dead square', () => {
  const p = raftParams;
  const raft = buildRaftBlueprint();
  const irr = shipDetailParams.irregularity;

  it('every yard is cocked, and the main, topsail and mizzen hang differently', () => {
    // WHY: the 1947 photo never shows a level yard; three yards cocked the
    // same way would read as one rotated rig, not three lashed spars
    const keys = [1, 2, 3].map((k) => yardAttitude(p, k));
    for (const a of keys) {
      expect(Math.abs(a.cock)).toBeGreaterThan(0);
      expect(a.rake).toBeGreaterThan(0); // head leads the foot forward
    }
    expect(keys[0].cock).not.toBeCloseTo(keys[1].cock, 3);
    expect(keys[1].cock).not.toBeCloseTo(keys[2].cock, 3);
    const yards = raft.filter((x) => x.kind === 'yard');
    expect(yards.length).toBeGreaterThanOrEqual(3);
    for (const y of yards) expect(Math.abs(y.transform.rotation[2]), y.id).toBeGreaterThan(0);
  });

  it('irregularity 0 squares every yard — the one dial still zeros it (§T34)', () => {
    shipDetailParams.irregularity = 0;
    try {
      const a = yardAttitude(p, 1);
      expect(a.cock).toBeCloseTo(0, 12);
      expect(a.rake).toBeCloseTo(0, 12);
      expect(a.slew).toBeCloseTo(0, 12);
      expect(a.offset).toBeCloseTo(0, 12);
    } finally {
      shipDetailParams.irregularity = irr;
    }
  });

  it('the sheets lead FORWARD of the clews on every raft sail, aft on a square-rigger', () => {
    // WHY: running before the wind the belly leads the mast; the corner-pull
    // direction is what the §T85 cloth hauls the foot along
    const sails = raft.filter((x) => x.kind === 'sail');
    expect(sails.length).toBeGreaterThanOrEqual(3);
    for (const s of sails) expect(s.shape?.sheetLeadAft, s.id).toBe(-1);
    // identity sail frame, hull forward = +z: the lead's z is its fore-aft sense
    const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const fwd = sheetLeadDirections(I, 0, 1, 0.45, -1);
    const aft = sheetLeadDirections(I, 0, 1, 0.45, 1);
    expect(fwd.port[2]).toBeGreaterThan(0);
    expect(fwd.starboard[2]).toBeGreaterThan(0);
    expect(aft.port[2]).toBeLessThan(0);
    // the lateral spread is the hull's, whichever way the sheet runs
    expect(fwd.port[0]).toBeCloseTo(aft.port[0], 6);
    expect(fwd.port[1]).toBeCloseTo(aft.port[1], 6);
    expect(fwd.port[0]).toBeLessThan(0);
    expect(fwd.starboard[0]).toBeGreaterThan(0);
  });

  it('the standing rigging carries slack — stays and shrouds SAG; running rigging keeps the planner\'s geometry', () => {
    // WHY: knotted fibre stays, no turnbuckles [§4 Standing rigging]; the
    // rope solver (§V45) hangs whatever chord excess the plan gives it
    const shared = buildRiggingPlan(raft);
    const plan = buildRaftRiggingPlan(raft);
    const standing = plan.filter((r) => r.role === 'stay' || r.role === 'shroud');
    expect(standing.length).toBeGreaterThan(0);
    for (const r of standing) expect(r.slack).toBeGreaterThanOrEqual(RAFT_STANDING_SLACK);
    expect(RAFT_STANDING_SLACK).toBeGreaterThan(Math.max(...shared.filter((r) => r.role === 'stay').map((r) => r.slack)));
    for (const r of plan) {
      // §B86-1: a raft rope is either the planner's, re-dressed, or one of the
      // raft-only rows (halyards, forestay, the ensign's halyard) — the
      // planner has no rule that can reach a stem or a bipod crossing. Either
      // way §B80 binds: a rope is a ROPE, not a spar.
      const src = shared.find((s) => s.role === r.role && s.socketA === r.socketA && s.socketB === r.socketB);
      const extra = raftExtraRopeOf(r);
      expect(src !== undefined || extra !== null, `${r.role} ${r.socketA} → ${r.socketB} came from nowhere`).toBe(true);
      expect(r.thickness).toBeLessThanOrEqual(Math.min(src?.thickness ?? Infinity, 0.02) + 1e-9);
      expect(r.thickness).toBeLessThan(raftParams.yardDiameter / 2 / 3);
      expect(r.thickness).toBeLessThanOrEqual(raftParams.lashingRopeDiameter / 2 + 1e-9); // 30 mm hemp at most
      expect(r.thickness).toBeGreaterThan(0.004);
      if (r.role !== 'stay' && r.role !== 'shroud') expect(r.slack).toBe(src?.slack ?? RAFT_RUNNING_SLACK);
    }
    expect(plan.some((r) => r.thickness < shared.find((s) => s.socketA === r.socketA && s.role === r.role)!.thickness)).toBe(true);
  });

  it('carries the Kon-Tiki\'s ropes and not a square-rigger\'s: per-sail table, < 25 in all, every rope with a purpose (§B79)', () => {
    // WHY: the shared planner inherited 69 ropes onto a raft with three
    // sails — 36 of them buntlines — "on the tiny back sail that's an insane
    // amount". The table is the reference's [§4 Controls, Standing rigging].
    const plan = buildRaftRiggingPlan(raft);
    expect(plan.length).toBeLessThan(25);
    expect(plan.length).toBeLessThanOrEqual(RAFT_ROPE_MAX);
    const perSail = new Map<string, number>();
    let standing = 0;
    let ensign = 0;
    for (const r of plan) {
      expect(['stay', 'shroud', 'halyard', 'sheet', 'brace', 'lift'], `${r.role} has no place on the raft`).toContain(r.role);
      if (r.role === 'stay' || r.role === 'shroud') {
        standing++;
        continue;
      }
      const key = raftRopeSail(r);
      if (key === null) {
        // the ONE running line that hoists something which is not canvas
        // (§B86-1). Anything else with no sail is a rope with no purpose.
        expect(`${r.role} ${r.socketA} → ${r.socketB}`).toBe('halyard anchor-truck-flag → anchor-cleat-stern-starboard');
        ensign++;
        continue;
      }
      const k = `${key}|${r.role}`;
      perSail.set(k, (perSail.get(k) ?? 0) + 1);
    }
    expect(standing).toBeGreaterThanOrEqual(3); // side guys + the aft line, at least
    expect(standing).toBeLessThanOrEqual(RAFT_STANDING_MAX);
    expect(ensign).toBe(1); // §B86-1: the flag has a halyard, and only one
    for (const [k, n] of perSail) {
      const [key, role] = k.split('|') as [keyof typeof RAFT_ROPE_TABLE, keyof (typeof RAFT_ROPE_TABLE)['main-lower']];
      expect(n, k).toBeLessThanOrEqual(RAFT_ROPE_TABLE[key][role] ?? 0);
    }
    // the sails are sheeted — the one control a downwind raft cannot do without
    expect(perSail.get('main-lower|sheet')).toBe(2);
    expect(perSail.get('main-upper|sheet')).toBe(2);
    expect(perSail.get('mizzen-lower|sheet') ?? 0).toBeGreaterThanOrEqual(1);
    // and the topsail + mizzen carry NO braces: set flying / on a sprit
    expect(perSail.get('main-upper|brace') ?? 0).toBe(0);
    expect(perSail.get('mizzen-lower|brace') ?? 0).toBe(0);
    // no two ropes are the same line
    expect(new Set(plan.map((r) => `${r.role}|${r.socketA}|${r.socketB}`)).size).toBe(plan.length);
  });

  it('the bipod crossing is wrapped, and each leg has its own lean', () => {
    const wrap = raft.find((x) => x.id === 'lashing-crossing')!;
    expect(wrap).toBeDefined();
    expect(wrap.kind).toBe('lashing');
    const legs = raft.filter((x) => x.kind === 'bipod-mast' && x.id.startsWith('bipod-leg'));
    expect(legs).toHaveLength(2);
    expect(wrap.transform.position[1]).toBeCloseTo(legs[0].transform.position[1] + p.mastHeight * Math.cos(p.mastRakeAft), 6);
    expect(legs[0].transform.rotation[0]).not.toBeCloseTo(legs[1].transform.rotation[0], 4); // crooked, not an A
  });

  it('the bipod is RAKED AFT as one, crossing, pole and wrap landing on the same point (§B75)', () => {
    // WHY: [ref-sails-1947] the mast leans aft; a crossing wrap authored at
    // the vertical crossing would float forward of the raked legs
    expect(p.mastRakeAft).toBeGreaterThan(0.05);
    expect(p.mastRakeAft).toBeLessThan(0.2);
    const legs = raft.filter((x) => x.id.startsWith('bipod-leg'));
    const pole = raft.find((x) => x.id === 'mast-main')!;
    const wrap = raft.find((x) => x.id === 'lashing-crossing')!;
    // every deck-stepped member leans aft by the rake (± its own jitter)
    for (const m of [...legs, pole]) {
      expect(m.transform.rotation[0], m.id).toBeLessThan(-p.mastRakeAft + p.legLeanJitter + p.topPoleTilt + 1e-9);
      expect(m.transform.rotation[0], m.id).toBeGreaterThan(-p.mastRakeAft - p.legLeanJitter - p.topPoleTilt - 1e-9);
    }
    // the wrap sits AFT of the mast step by the rake's throw
    expect(wrap.transform.position[2]).toBeLessThan(legs[0].transform.position[2] - 0.5);
    expect(wrap.transform.position[2]).toBeCloseTo(legs[0].transform.position[2] - p.mastHeight * Math.sin(p.mastRakeAft), 6);
    // and the geometry agrees: the leg tips (minus their overlap) meet the wrap
    const asm = new ShipAssembly(raft, stubFactory);
    for (const leg of legs) {
      const box = worldBox(asm, leg.id);
      expect(box.max.y).toBeGreaterThan(wrap.transform.position[1]);
      expect(box.min.z).toBeLessThan(wrap.transform.position[2] + 0.3);
    }
  });

  it('the rope ladder hugs the starboard leg: stringers ∥ the leg, rungs ⊥ the leg and ⊥ its outward normal (§B75/§B83)', () => {
    const ladder = raft.find((x) => x.id === 'mast-ladder')!;
    const leg = raft.find((x) => x.id === 'bipod-leg-starboard')!;
    expect(ladder.parent).toBe(leg.id); // the leg's frame — it follows the lean AND the rake
    const legR = leg.aabb.max[0];
    const rot = new THREE.Euler(...(ladder.transform.rotation ?? [0, 0, 0]));
    // the ladder() geometry: stringers along local +y, rungs along local +x
    const stringer = new THREE.Vector3(0, 1, 0).applyEuler(rot);
    const rung = new THREE.Vector3(1, 0, 0).applyEuler(rot);
    const legAxis = new THREE.Vector3(0, 1, 0); // in the leg's own frame
    const outward = new THREE.Vector3(1, 0, 0); // starboard leg: outboard = +x
    expect(Math.acos(Math.abs(stringer.dot(legAxis)))).toBeLessThan((5 * Math.PI) / 180);
    expect(Math.abs(rung.dot(legAxis))).toBeLessThan(0.05);
    expect(Math.abs(rung.dot(outward))).toBeLessThan(0.05);
    const w = ladder.aabb.max[0] - ladder.aabb.min[0];
    const h = ladder.aabb.max[1] - ladder.aabb.min[1];
    expect(h).toBeGreaterThan(w * 5); // long along the leg
    // centred fore-aft on the leg, a hand off its outboard face
    expect(Math.abs(ladder.transform.position[2])).toBeLessThan(legR);
    const standoff = ladder.transform.position[0] - legR;
    expect(standoff).toBeGreaterThan(0.03);
    expect(standoff).toBeLessThan(0.2);
  });

  it('the robands are loops round THIS yard, not pegs standing on it (§B83, §V66)', () => {
    // WHY: the galleon's 0.36 m tie on a 6 cm bamboo yard stood 0.26 m proud —
    // "a row of uniform wooden pegs" in the top view
    for (const s of raft.filter((x) => x.kind === 'sail')) {
      const yard = raft.find((y) => y.id === s.parent)!;
      const yr = yard.aabb.max[1];
      expect(s.shape?.yardR, s.id).toBeCloseTo(yr, 9);
      const tie = sailTieSpec(s.shape!.yardR);
      expect(tie.height).toBeLessThanOrEqual(yr * 1.5);
      expect(tie.centreY + tie.height / 2).toBeLessThanOrEqual(yr * 1.5); // never above the spar's top
      expect(tie.radius).toBeLessThanOrEqual(yr);
    }
    // and the galleon's tie is the authored one, untouched
    expect(sailTieSpec(undefined)).toEqual({ height: 0.36, radius: 0.035, centreY: 0.08 });
  });
});

describe('§B75 the furled bundle is the canvas it packs (§V66)', () => {
  it('bundle radius ∝ area ÷ yard length on every sail of every ship — no floor fattening the small ones', () => {
    // WHY: a fixed 0.15 m floor made a 1.4 m topsail's roll as fat as a 3 m
    // topgallant's, "suggesting a much larger sail than we unpack"
    const ratios: number[] = [];
    for (const ship of ['galleon', 'brigantine', 'raft'] as const) {
      for (const s of buildShipBlueprint(ship).filter((x) => x.kind === 'sail')) {
        const width = s.aabb.max[0] - s.aabb.min[0];
        const drop = -s.aabb.min[1];
        const r = furlBundleRadius(width, drop);
        ratios.push(r / ((width * drop) / width));
        expect(r).toBeLessThan(drop * 0.1); // never a roll thicker than a tenth of its own drop
      }
    }
    expect(ratios.length).toBeGreaterThan(10);
    const k = ratios[0];
    for (const x of ratios) expect(x).toBeCloseTo(k, 9);
    // the galleon's course is where the constant was fitted: unchanged
    expect(furlBundleRadius(12.17, 7.56)).toBeCloseTo(Math.max(0.15, 7.56 * 0.05) * 1.15, 3);
  });
});

describe('§V82 deck, cabin, mast, guaras, steering', () => {
  const p = raftParams;
  const raft = buildRaftBlueprint();
  const L = raftLayout();
  const asm = new ShipAssembly(raft, stubFactory);
  const hw = p.cabinWidth / 2;
  const worldZ = (x: PieceDef) => x.transform.position[2];

  it('three deck heights: log tops < mats < cabin floor, each proud by its own layer (§V83)', () => {
    expect(L.deckY).toBeGreaterThan(L.logTopY);
    expect(L.deckY - L.crossbeamTopY).toBeCloseTo(p.matThickness, 9);
    expect(L.cabinFloorY - L.deckY).toBeCloseTo(p.cabinBoxHeight, 9);
  });

  it('bamboo deck forward of the cabin + starboard strip; NONE port of the cabin or aft of it', () => {
    const decks = raft.filter((x) => x.kind === 'bamboo-deck' && x.parent === undefined && x.id !== 'cabin-floor');
    expect(decks.length).toBeGreaterThanOrEqual(2);
    const fwd = decks.filter((d) => worldZ(d) + d.aabb.min[2] >= L.cabinFrontZ - 1e-9);
    const stbd = decks.filter((d) => worldZ(d) < L.cabinFrontZ && d.transform.position[0] + d.aabb.min[0] >= hw);
    expect(fwd.length).toBeGreaterThan(0);
    expect(stbd.length).toBeGreaterThan(0);
    for (const d of decks) {
      const x0 = d.transform.position[0] + d.aabb.min[0];
      const z0 = worldZ(d) + d.aabb.min[2];
      const z1 = worldZ(d) + d.aabb.max[2];
      expect(z1, `${d.id} aft of cabin`).toBeGreaterThan(L.cabinAftZ);
      // anything alongside the cabin is starboard of it (port = bare logs + gear)
      if (z0 < L.cabinFrontZ - 1e-9) expect(x0, `${d.id} port of cabin`).toBeGreaterThanOrEqual(hw);
    }
  });

  it('cabin: ≥ 2.4×4.3×1.2 clear volume, ridge < 1.6 over the floor, opening on STARBOARD', () => {
    const walls = raft.filter((x) => x.kind === 'cabin-wall');
    const port = walls.find((w) => w.id === 'cabin-wall-port')!;
    const stbd = walls.filter((w) => w.id.startsWith('cabin-wall-starboard'));
    // port wall continuous; starboard wall in two pieces with a gap of the
    // reference's door length between them, in the aft half. §T129b: the side
    // walls close the CLEAR length, gable to gable — they used to run the full
    // `cabinLength` and interpenetrate all four corners.
    expect(port.aabb.max[2] - port.aabb.min[2]).toBeCloseTo(p.cabinLength - 2 * p.cabinWallThickness, 9);
    expect(stbd).toHaveLength(2);
    for (const w of stbd) expect(w.transform.position[0]).toBeGreaterThan(0); // +x = starboard
    const [a, b] = stbd.sort((u, v) => worldZ(u) - worldZ(v));
    const gap = (worldZ(b) + b.aabb.min[2]) - (worldZ(a) + a.aabb.max[2]);
    expect(gap).toBeCloseTo(p.cabinOpeningLength, 9);
    expect((worldZ(a) + a.aabb.max[2] + worldZ(b) + b.aabb.min[2]) / 2).toBeLessThan((L.cabinAftZ + L.cabinFrontZ) / 2);
    // clear volume: floor to eave over the inside footprint + the gable prism
    const eave = port.transform.position[1] + port.aabb.max[1] - L.cabinFloorY;
    const inW = p.cabinWidth - 2 * p.cabinWallThickness;
    const inL = p.cabinLength - 2 * p.cabinWallThickness;
    const ridgeOver = p.cabinRidge;
    const volume = inW * inL * eave + 0.5 * inW * (ridgeOver - eave) * inL;
    expect(eave).toBeGreaterThanOrEqual(1.2);
    expect(volume).toBeGreaterThanOrEqual(2.4 * 4.3 * 1.2);
    // ridge: the highest thatch point, measured from the floor the crew sits on
    let top = -Infinity;
    for (const r of raft.filter((x) => x.kind === 'thatch-roof')) top = Math.max(top, worldBox(asm, r.id).max.y);
    expect(top - L.cabinFloorY).toBeLessThan(1.6);
    expect(top - L.cabinFloorY).toBeGreaterThan(eave);
    // the cabin is AFT of the mast
    expect(L.cabinFrontZ).toBeLessThan(L.mastZ);
  });

  it('bipod mast: two legs meeting at a crossing 8.5–10 m up, ~4.5 m apart at the deck, cabin just aft', () => {
    const legs = raft.filter((x) => x.id.startsWith('bipod-leg-'));
    expect(legs).toHaveLength(2);
    const tops = legs.map((l) => worldBox(asm, l.id));
    const feetX = legs.map((l) => l.transform.position[0]);
    expect(Math.abs(feetX[0] - feetX[1])).toBeGreaterThan(3);
    expect(Math.abs(feetX[0] - feetX[1])).toBeLessThan(5.5);
    // both legs reach the crossing, and the crossing is in the reference band
    const crossing = raft.find((x) => x.id === 'mast-main')!;
    const crossingY = crossing.transform.position[1] + crossing.aabb.min[1];
    expect(crossingY - L.logTopY).toBeGreaterThanOrEqual(8.5);
    expect(crossingY - L.logTopY).toBeLessThanOrEqual(10);
    // the crossing's WORLD height is the pole length foreshortened by the
    // aft rake (§B75) — the reference band is the pole, the meeting point is raked
    const rakedY = L.logTopY + (crossingY - L.logTopY) * Math.cos(p.mastRakeAft);
    for (const [i, b] of tops.entries()) {
      expect(b.max.y).toBeGreaterThanOrEqual(rakedY);
      // the leg's own tip (local +y end) lands at the centreline, at the crossing
      const leg = legs[i];
      const tip = new THREE.Vector3(0, leg.aabb.max[1] - p.mastCrossingOverlap, 0)
        .applyEuler(new THREE.Euler(...leg.transform.rotation))
        .add(new THREE.Vector3(...leg.transform.position));
      expect(Math.abs(tip.x), `${leg.id} leans INWARD`).toBeLessThan(0.2);
      expect(tip.y).toBeCloseTo(rakedY, 1);
    }
    // platform + ladder are on the mast
    expect(raft.find((x) => x.id === 'lookout-platform')?.parent).toBe('mast-main');
    expect(raft.find((x) => x.id === 'mast-ladder')?.parent).toMatch(/^bipod-leg-/);
  });

  it('every sail hangs on a yard that rides a mast, and the main sail is the reference size', () => {
    for (const sail of raft.filter((x) => x.kind === 'sail')) {
      const yard = raft.find((x) => x.id === sail.parent);
      expect(yard?.kind, sail.id).toBe('yard');
      const mast = raft.find((x) => x.id === yard!.parent);
      expect(mast?.kind, yard!.id).toBe('mast');
      expect(sail.sailStates?.map((s) => s.id)).toEqual(['furled', 'reefed', 'full']);
      // clew sockets sewn to the cloth (§T85 membrane reads `cloth`)
      expect(sail.sockets.some((s) => s.id.endsWith('clew-port') && s.cloth !== undefined)).toBe(true);
    }
    const main = raft.find((x) => x.id === 'sail-main-lower')!;
    const width = main.aabb.max[0] - main.aabb.min[0];
    const drop = -main.aabb.min[1];
    expect(width).toBeGreaterThan(drop); // "wider than tall" [§4 Mainsail]
    const top = raft.find((x) => x.id === 'sail-main-upper')!;
    expect(top.aabb.max[0] - top.aabb.min[0]).toBeLessThan(width); // topsail small
  });

  it('exactly 5 guaras, each on edge INSIDE a chink it physically fits', () => {
    const guaras = raft.filter((x) => x.kind === 'guara');
    expect(guaras).toHaveLength(5);
    const logs = raft.filter((x) => x.kind === 'log' && x.id.startsWith('log-'));
    let fwd = 0;
    let aft = 0;
    for (const g of guaras) {
      const x = g.transform.position[0];
      const t = g.aabb.max[0] - g.aabb.min[0];
      const k = logs.findIndex((l, i) => i < logs.length - 1
        && l.transform.position[0] < x && logs[i + 1].transform.position[0] > x);
      expect(k, `${g.id} between two log centrelines`).toBeGreaterThanOrEqual(0);
      const a = logs[k];
      const b = logs[k + 1];
      const gap0 = a.transform.position[0] + a.aabb.max[0];
      const gap1 = b.transform.position[0] + b.aabb.min[0];
      expect(x - t / 2, `${g.id} clears the port log`).toBeGreaterThanOrEqual(gap0);
      expect(x + t / 2, `${g.id} clears the starboard log`).toBeLessThanOrEqual(gap1);
      // on edge: thin across the chink, wide fore-aft, tall
      expect(t).toBeLessThan(g.aabb.max[2] - g.aabb.min[2]);
      expect(g.aabb.max[1] - g.aabb.min[1]).toBeGreaterThan(g.aabb.max[2] - g.aabb.min[2]);
      // and it reaches below the logs
      expect(g.transform.position[1] + g.aabb.min[1]).toBeLessThan(-Math.max(...logs.map((l) => l.aabb.max[1])));
      if (worldZ(g) > L.mastZ) fwd++;
      if (worldZ(g) < L.cabinAftZ) aft++;
    }
    expect(fwd).toBeGreaterThanOrEqual(2);
    expect(aft).toBeGreaterThanOrEqual(2);
  });

  it('every guara stands clear of the deck at its rest pose — a plank nobody can see cannot be hauled (§V84)', () => {
    // WHY: §B70 — measured from the log bottoms the tops sat UNDER the mats;
    // the crew's steering gear was invisible from every station
    for (const g of raft.filter((x) => x.kind === 'guara')) {
      expect(g.transform.position[1] + g.aabb.max[1], `${g.id} top`).toBeGreaterThan(L.deckY + 0.3);
    }
  });

  it('lashes every crossbeam to every log it crosses: one ring set per crossing, none in mid-air', () => {
    const beams = raft.filter((x) => x.kind === 'crossbeam');
    // `lashing-<k>` are the crossbeam seizings; the bipod crossing and the
    // yard parrels (§T.138) are lashings too, and are counted elsewhere
    const lashings = raft.filter((x) => /^lashing-\d+$/.test(x.id));
    const logs = raft.filter((x) => x.kind === 'log' && x.id.startsWith('log-'));
    expect(lashings).toHaveLength(beams.length);
    for (const l of lashings) {
      const z = l.transform.position[2];
      const beam = beams.find((b) => Math.abs(b.transform.position[2] - z) < 1e-6)!;
      expect(beam, `${l.id} sits on a beam`).toBeDefined();
      expect(l.transform.position[1]).toBeCloseTo(beam.transform.position[1], 6);
      // the crossings are exactly the OUTER two logs each side under this
      // beam (the inner five are under the mats), in ship x
      const half = (logs.length - 1) / 2;
      const under = logs.filter((lg, k) => Math.abs(k - half) >= half - 1
        && z > lg.transform.position[2] + lg.aabb.min[2] && z < lg.transform.position[2] + lg.aabb.max[2]);
      expect(under.length).toBeGreaterThanOrEqual(2);
      const n = l.shape!.n;
      expect(n).toBe(under.length);
      for (let i = 0; i < n; i++) {
        const x = l.shape![`x${i}`];
        expect(under.some((lg) => Math.abs(lg.transform.position[0] - x) < 1e-6), `${l.id} ring ${i} on a log`).toBe(true);
      }
    }
  });

  it('the oar pivots between the thole-pins above the block, which spans the 3 projecting logs', () => {
    const block = raft.find((x) => x.kind === 'stern-block')!;
    const oar = raft.find((x) => x.kind === 'steering-oar')!;
    const blockTop = block.transform.position[1] + block.aabb.max[1];
    const spacing = block.shape!.pinSpacing;
    expect(Math.abs(oar.transform.position[0] - block.transform.position[0])).toBeLessThan(spacing / 2);
    expect(oar.transform.position[1]).toBeGreaterThan(blockTop);
    expect(oar.transform.position[1]).toBeLessThan(blockTop + block.shape!.pinHeight);
    expect(Math.abs(oar.transform.position[2] - block.transform.position[2])).toBeLessThan(block.aabb.max[2]);
    // block sits on the projecting stern logs, aft of the flush stern line
    const projecting = L.logs.filter((l) => l.projecting);
    expect(projecting).toHaveLength(3);
    expect(block.transform.position[2]).toBeLessThan(L.sternZ);
    expect(block.transform.position[2]).toBeGreaterThan(Math.min(...projecting.map((l) => l.zStern)));
    const halfLen = block.aabb.max[0];
    for (const l of projecting) expect(Math.abs(l.x)).toBeLessThan(halfLen);
    // oar is the reference length and the blade is aft (−z), dipped
    expect(oar.aabb.max[2] - oar.aabb.min[2]).toBeCloseTo(p.oarLength, 9);
    expect(worldBox(asm, oar.id).min.z).toBeLessThan(block.transform.position[2] - 2);
    expect(worldBox(asm, oar.id).min.y).toBeLessThan(blockTop);
  });

  it('every §V84 station socket resolves on the live assembly, on or above the logs', () => {
    for (const id of STATIONS) {
      const pos = asm.socketWorldPosition(socketAlias(id));
      expect(pos, id).toHaveLength(3);
      for (const v of pos) expect(Number.isFinite(v), id).toBe(true);
      // on its own log's top at least (logs differ in radius), never in the water
      expect(pos[1], `${id} below the logs`).toBeGreaterThanOrEqual(p.logAxisY + p.logDiameterMin / 2 - 1e-6);
    }
    // the indoor stations are inside the cabin footprint; the chart table is by the door (starboard)
    for (const id of ['station-radio', 'station-chart', 'station-mat']) {
      const [x, , z] = asm.socketWorldPosition(id);
      expect(Math.abs(x)).toBeLessThan(hw);
      expect(z).toBeGreaterThan(L.cabinAftZ);
      expect(z).toBeLessThan(L.cabinFrontZ);
    }
    expect(asm.socketWorldPosition('station-chart')[0]).toBeGreaterThan(0);
    expect(asm.socketWorldPosition('station-radio')[0]).toBeLessThan(0);
    // sheets port/starboard of the centreline, tiller aft of the cabin
    expect(asm.socketWorldPosition('station-sheet-p')[0]).toBeLessThan(0);
    expect(asm.socketWorldPosition('station-sheet-s')[0]).toBeGreaterThan(0);
    expect(asm.socketWorldPosition('station-tiller')[2]).toBeLessThan(L.cabinAftZ);
    expect(asm.socketWorldPosition('station-lookout')[1]).toBeGreaterThan(8);
  });

  it('rigs through the shared plan: sheets on the main clews, no ratlines, every rope end resolves', () => {
    const plan = buildRiggingPlan(raft);
    expect(plan.some((r) => r.role === 'sheet')).toBe(true);
    expect(plan.some((r) => r.role === 'brace')).toBe(true);
    for (const rope of plan) {
      expect(asm.socketWorldPosition(rope.socketA)).toHaveLength(3);
      expect(asm.socketWorldPosition(rope.socketB)).toHaveLength(3);
    }
    expect(buildRatlinePlan(raft)).toHaveLength(0);
  });
});

/**
 * §B78-4 / §B86-1 / §B86-3 — THE RIG AS A THING A CREW USES: a perch you can
 * see from, gear you could have hoisted the sails with, and a furl that puts
 * the canvas where a furled sail goes.
 */
describe('§B78/§B86 the raft rig serves the crew', () => {
  const raft = buildRaftBlueprint();
  const asm = new ShipAssembly(raft, stubFactory);
  asm.group.updateMatrixWorld(true);
  const P = playerParams;

  /** world AABB of a piece's drawn mesh, through the live assembly (§V71) */
  const sailBox = (id: string): THREE.Box3 => new THREE.Box3().setFromObject(asm.sailMesh(id));

  it('(B78-4) a lookout STANDING on the perch has his head clear of the topsail', () => {
    // R2: "forward is 100 % topsail cloth (eye 10.74 is inside the topsail's
    // 9.46-11.23 span). Not a usable perch." Measured against the SAIL's own
    // live bounds and the WALKER's own eye height — not against the authored
    // `topsailHeightAboveCrossing`, which is free to move (§V80).
    const perch = asm.socketWorldPosition('station-lookout');
    const eye = perch[1] + P.standHeight - P.eyeDrop;
    const box = sailBox('sail-main-upper');
    expect(box.min.y, 'topsail foot over the lookout\'s eye').toBeGreaterThan(eye);
    // and over his head, not just his eye — he stands up there
    expect(box.min.y).toBeGreaterThan(perch[1] + P.standHeight);
    // the pole still carries the yard: nothing hangs off the end of it
    expect(asm.socketWorldPosition('anchor-masthead-main')[1]).toBeGreaterThan(box.max.y);
    // the MAIN sail is below the perch — the lookout climbs past it, not into it
    expect(sailBox('sail-main-lower').max.y).toBeLessThan(perch[1] + P.standHeight);
  });

  it('(B78-3) the ladder station is ON the ladder — inboard of the rail, up at the rungs', () => {
    // R2: "the ladder socket itself is at x 2.69, OUTBOARD of the foot-rail",
    // i.e. over the water at the leg's foot, while the rungs it names run up
    // the leg. §V71: a fixture on a part is resolved against THAT part.
    const q = asm.socketWorldPosition('station-ladder');
    const L = raftLayout();
    expect(Math.abs(q[0]), 'outboard of the foot-rail').toBeLessThan(L.halfBeam);
    expect(q[1], 'at hand height on the rungs, not on the deck').toBeGreaterThan(L.deckY + 0.5);
    // and it rides the leg: the whole bipod leans and rakes, so the socket
    // must sit on the leg's own axis, not at an authored ship-space point
    const legFoot = raft.find((x) => x.id === 'bipod-leg-starboard')!.transform.position;
    // the leg leans in and rakes aft, so climbing height BUYS inboard room:
    // the grab point is inboard of the leg's own step even though it hangs on
    // the leg's outboard face (§B83)
    expect(q[0], 'the lean has not carried the grab inboard').toBeLessThan(legFoot[0]);
  });

  it('(B86-1) the sails could have been hoisted: a halyard each, a forestay to the stem, and the ensign on its own', () => {
    // R1-fix gap 1: "no halyards, no forestay, no flag halyard — the planner
    // has no masthead block socket or bow anchor". A rig with no halyard is a
    // rig nobody could have set.
    const plan = buildRaftRiggingPlan(raft);
    const halyards = plan.filter((r) => r.role === 'halyard');
    expect(halyards.length).toBe(4); // three sails + the ensign
    for (const key of ['main-lower', 'main-upper', 'mizzen-lower'] as const) {
      expect(halyards.filter((r) => raftRopeSail(r) === key).length, `${key} halyard`).toBe(1);
    }
    // the forestay lands on the STEM — a socket the shared planner never had
    const fore = plan.find((r) => r.socketB === 'anchor-stem-bow' || r.socketA === 'anchor-stem-bow');
    expect(fore, 'forestay').toBeDefined();
    expect((fore as { role: string }).role).toBe('stay');
    const stem = asm.socketWorldPosition('anchor-stem-bow');
    expect(stem[2]).toBeGreaterThan(raftLayout().mastZ + 4); // it really does go forward
    // §B79/§B80 still bind with the new gear aboard
    expect(plan.length).toBeLessThan(25);
    for (const r of plan) expect(r.thickness, `${r.role} ${r.socketA}`).toBeLessThanOrEqual(0.02);
    // every endpoint is a real rope-anchor: a rename fails loud, not silently
    validateRiggingPlan(plan, raft);
  });

  it('(B86-3) furling LOWERS the main yard and the roll is the cloth it packs', () => {
    // R1-fix gap 3: "the furled main reads heavy and the yard does not lower
    // on furl". A square sail is not furled where it is set — the replica
    // frame (ref §10) carries its roll a couple of metres over the deck.
    const yardY = (): number => asm.socketWorldPosition('anchor-yard-main-lower-port')[1];
    updateRig(asm, 1 / 60, 1); // canvas set
    asm.group.updateMatrixWorld(true);
    const set = yardY();
    updateRig(asm, 1 / 60, 0); // and in
    asm.group.updateMatrixWorld(true);
    const furled = yardY();
    expect(furled, 'the yard came down its halyard').toBeLessThan(set - 1);
    const masthead = asm.socketWorldPosition('anchor-masthead-main')[1];
    expect(furled).toBeLessThan(0.75 * masthead);
    // …and it is still ABOVE the cabin, not lying on the roof
    const L = raftLayout();
    expect(furled).toBeGreaterThan(L.cabinFloorY + raftParams.cabinRidge);
    updateRig(asm, 1 / 60, 1);
    asm.group.updateMatrixWorld(true);
    expect(yardY()).toBeCloseTo(set, 6); // and goes back up: it is a hoist, not a one-way trip

    // the roll's SECTION is cloth area ÷ the yard it is gathered along, at
    // this class's own packing — §B75's law, with the two terms it was
    // missing (a yard is longer than its sail is wide; cotton packs tighter
    // than flax). The galleon's own bundles are untouched by both defaults.
    for (const s of raft.filter((x) => x.kind === 'sail')) {
      const width = s.aabb.max[0] - s.aabb.min[0];
      const drop = -s.aabb.min[1];
      const len = s.shape?.yardLength as number;
      expect(len, `${s.id} names its yard`).toBeGreaterThan(width);
      const r = furlBundleRadius(width, drop, len, s.shape?.furlPack);
      expect(r).toBeCloseTo(((width * drop) / len) * raftParams.furlBundlePack, 9);
      expect(r).toBeLessThan(furlBundleRadius(width, drop)); // slimmer than the galleon law
    }
    // …and the default call is bit-identical to what it always was
    expect(furlBundleRadius(4, 3)).toBeCloseTo(3 * 0.0575, 12);
  });
});

/**
 * §B86-2 — THE RAFT'S CANVAS ANSWERS THE RAFT'S WIND. The membrane's
 * saturating reference was fitted to the galleon (`sailWindRef` 6.43: half
 * full at 10.4 m/s), and at the raft's own 8–11 m/s her cotton square bellied
 * modestly instead of reading drum-full. The fix is per-SAIL, not a fork of
 * the membrane and not a second global.
 */
describe('§B86-2 per-sail reference wind', () => {
  const raft = buildRaftBlueprint();
  const asm = new ShipAssembly(raft, stubFactory);
  /** dead before the wind, no way on, gust at rest — the raft's own point of sail */
  const running = (windSpeed: number): Parameters<typeof sailDrive>[0] => ({
    forwardX: 0, forwardZ: 1, shipForwardX: 0, shipForwardZ: 1,
    windDirection: 0, windSpeed, yawRate: 0, gustPhase: 0, gustPhaseB: 0,
  });

  it('every raft sail carries its own reference, and the assembly puts it on the mesh', () => {
    const sails = raft.filter((s) => s.kind === 'sail');
    expect(sails.length).toBe(3);
    for (const s of sails) {
      expect(s.shape?.windRef, `${s.id}`).toBe(raftParams.sailWindRef);
      expect(asm.sailMesh(s.id).userData.sailWindRef).toBe(raftParams.sailWindRef);
    }
    // …and a sail whose class sets none is left on the shared param (§V28)
    expect(readSailWindRef({ userData: {} }, 6.43)).toBe(6.43);
    expect(readSailWindRef({ userData: { sailWindRef: Number.NaN } }, 6.43)).toBe(6.43);
    expect(readSailWindRef({ userData: { sailWindRef: -1 } }, 6.43)).toBe(6.43);
    expect(readSailWindRef({ userData: { sailWindRef: 4.2 } }, 6.43)).toBe(4.2);
  });

  it('reads FULL through the raft\'s own 8–11 m/s, where the galleon\'s reference leaves it slack', () => {
    for (const v of [8, 9, 10, 11]) {
      const mine = sailDrive({ ...running(v), windRef: raftParams.sailWindRef }, shipMaterialParams);
      const shared = sailDrive(running(v), shipMaterialParams);
      expect(mine.drive, `${v} m/s on the raft's reference`).toBeGreaterThan(0.9);
      expect(mine.drive, `${v} m/s: the override must actually bite`).toBeGreaterThan(shared.drive);
    }
    // it is still a CURVE, not a constant: a becalmed raft is slack, and it
    // saturates rather than running away (§V62 — a knob that drives nothing)
    expect(sailDrive({ ...running(1), windRef: raftParams.sailWindRef }, shipMaterialParams).drive).toBeLessThan(0.1);
    expect(sailDrive({ ...running(25), windRef: raftParams.sailWindRef }, shipMaterialParams).drive).toBeLessThanOrEqual(1);
    // and the shared param still owns every ship that sets none
    expect(sailDrive(running(9), shipMaterialParams).drive)
      .toBeCloseTo(sailDrive({ ...running(9), windRef: shipMaterialParams.sailWindRef }, shipMaterialParams).drive, 12);
  });
});

/**
 * §B74 / §T.114 — THE CANVAS AND THE BIPOD.
 *
 * T.114 measured the raft's mainsail 0.053 m INSIDE the legs it hangs between
 * and wrote the fix down as "her main yard wants more `yardMastClearance`".
 * MEASURED, that diagnosis is wrong, and the reason is worth writing into a
 * test so nobody re-derives it a third time:
 *
 *   a bipod's legs SPLAY in x. The sail's plane turns about a VERTICAL axis
 *   when the yard is braced. A splayed line therefore crosses that plane at
 *   some height, at every brace — including brace 0, where §B73's own yard
 *   slew (0.12 rad) already tilts it. Standoff slides the crossing UP or DOWN
 *   the leg; it never removes it, and what clears the port leg braced one way
 *   fouls the starboard leg braced the other. Swept `yardMastClearance`
 *   0.05 → 0.55 against `sailYardOffset` 0.12 → 0.34: the fouled fraction of
 *   the cut panel moves 0.54 % → 0.30 % and the worst point sits at ≈ −0.05 m
 *   throughout. That band is the CLOTH side's job (§T.114 `sparPush`).
 *
 * What the BLUEPRINT owes, and what is asserted here:
 *   1. every OTHER sail on this raft clears the pole it is set on outright —
 *      the topsail and the mizzen hang on single poles, and a single pole is
 *      parallel to its own sail's plane, so there is no excuse there;
 *   2. the mainsail's HEAD — the edge that is laced to the yard, the one a
 *      player watching the rig sees cut a leg — clears both legs at square
 *      and at both brace stops;
 *   3. no point of the cut panel ever gets past a leg's AXIS. It may be
 *      inside the leg; it may not be through and out the other side.
 *
 * Every bar is a PROPERTY (§V80): "clears the spar's own radius", "never past
 * the axis". None is a metre value a legitimate re-tune of the rig would break.
 */
describe('§B74 the raft\'s canvas and the spars it is set on', () => {
  const raft = buildRaftBlueprint();
  const asm = new ShipAssembly(raft, stubFactory);
  const byId = new Map(raft.map((d) => [d.id, d]));
  const BRACES = [-shipRigParams.braceMax, 0, shipRigParams.braceMax];

  /**
   * Distance from a sail-local point to a capsule's SURFACE (> 0 = clear),
   * and to its AXIS. Written from the geometric definition, deliberately not
   * from `sparPush`'s algebra (tests/sailMastClearance.test.ts does the same).
   */
  function clearance(p: THREE.Vector3, c: SailSparCapsule): { toSurface: number; toAxis: number } {
    const ab = new THREE.Vector3(c.b[0] - c.a[0], c.b[1] - c.a[1], c.b[2] - c.a[2]);
    const len2 = ab.lengthSq();
    if (!(len2 > 1e-12)) return { toSurface: Infinity, toAxis: Infinity }; // empty slot
    const ap = new THREE.Vector3(p.x - c.a[0], p.y - c.a[1], p.z - c.a[2]);
    const t = Math.min(1, Math.max(0, ap.dot(ab) / len2));
    const toAxis = ap.distanceTo(ab.multiplyScalar(t));
    return { toSurface: toAxis - (c.ra + (c.rb - c.ra) * t), toAxis };
  }

  /** the FLAT CUT PANEL: the sail as the sailmaker cut it, before any belly */
  function cutPanel(id: string): { pts: THREE.Vector3[]; head: THREE.Vector3[] } {
    const def = byId.get(id)!;
    const w = def.aabb.max[0] - def.aabb.min[0];
    const drop = -def.aabb.min[1];
    const pts: THREE.Vector3[] = [];
    const head: THREE.Vector3[] = [];
    for (let i = 0; i <= 16; i++) {
      for (let j = 0; j <= 16; j++) {
        const p = new THREE.Vector3((i / 16 - 0.5) * w, -(1 - j / 16) * drop, 0);
        pts.push(p);
        if (j === 16) head.push(p);
      }
    }
    return { pts, head };
  }

  /** the two spars abaft this sail, live, in the sail's own frame */
  function legsOf(id: string): SailSparCapsule[] {
    const spars = resolveSailSpars(asm.group.getObjectByName(id)!, readSailSparSources(asm.sailMesh(id)));
    return [spars.mast, spars.mast2]; // NOT `yard`: the head is laced to it
  }

  it('the topsail and the mizzen clear the single poles they are set on, at every brace', () => {
    // WHY these two and not the main: a single pole is parallel to its sail's
    // own plane at every brace, so "the cloth is cut clear of the spar" is a
    // property this rig CAN hold — and at `yardMastClearance` 0.05 it did not
    // (0.043 m and 0.060 m, close enough that any re-tune put cloth inside).
    for (const id of ['sail-main-upper', 'sail-mizzen-lower']) {
      const { pts } = cutPanel(id);
      let worst = Infinity;
      for (const brace of BRACES) {
        asm.setRigTrim(brace);
        asm.group.updateMatrixWorld(true);
        for (const c of legsOf(id)) for (const p of pts) worst = Math.min(worst, clearance(p, c).toSurface);
      }
      expect(worst, `${id} cut panel vs its own pole`).toBeGreaterThan(0);
    }
  });

  it('the mainsail\'s HEAD is laced FORWARD of the bipod: it clears both legs at square and at both stops', () => {
    const { head } = cutPanel('sail-main-lower');
    let worst = { d: Infinity, at: '' };
    for (const brace of BRACES) {
      asm.setRigTrim(brace);
      asm.group.updateMatrixWorld(true);
      for (const c of legsOf('sail-main-lower')) {
        for (const p of head) {
          const d = clearance(p, c).toSurface;
          if (d < worst.d) worst = { d, at: `brace ${(brace * 180 / Math.PI).toFixed(0)}° x=${p.x.toFixed(2)}` };
        }
      }
    }
    expect(worst.d, `head of the mainsail inside a bipod leg at ${worst.at}`).toBeGreaterThan(0);
  });

  it('and no point of the cut panel is EVER past a leg\'s axis — it may touch a leg, not fall through it', () => {
    const { pts } = cutPanel('sail-main-lower');
    for (const brace of BRACES) {
      asm.setRigTrim(brace);
      asm.group.updateMatrixWorld(true);
      for (const c of legsOf('sail-main-lower')) {
        for (const p of pts) {
          expect(clearance(p, c).toAxis, `cloth on the axis of a leg at brace ${brace}`).toBeGreaterThan(0);
        }
      }
    }
    asm.setRigTrim(0);
  });
});

/**
 * §B87 — THE DRESSING PASS. The user, looking in through the doorway: "the
 * inside of the raft looks very barren and very lame. Same goes for the roof —
 * doesn't really look like a thatched roof. Then the radio inside is just
 * floating in air. The three boxes look kinda repetitive on the front."
 *
 * Four faults, four properties. None of them is "there are N pieces": a count
 * pins a decision and says nothing about whether the room reads as lived in
 * (§V80). What is asserted is that every piece is INSIDE the room and out of
 * the doorway, that the radio RESTS ON something, that the roof is made of
 * courses that overlap the way tiles do, and that the three crates are three
 * different crates.
 */
describe('§B87 the cabin is furnished, and the roof is thatch', () => {
  const p = raftParams;
  const raft = buildRaftBlueprint();
  const L = raftLayout();
  const asm = new ShipAssembly(raft, stubFactory);
  asm.group.updateMatrixWorld(true);
  const room = cabinRoom(p, L);
  const corner = radioCorner(p, L);
  const byId = new Map(raft.map((d) => [d.id, d]));

  /** ship-space box of a piece, resolving the one level of parenting the raft uses */
  function shipBox(id: string): THREE.Box3 {
    const d = byId.get(id);
    if (d === undefined) throw new Error(`no piece ${id}`);
    const base = d.parent === undefined ? [0, 0, 0] : byId.get(d.parent)!.transform.position;
    const c = [
      base[0] + d.transform.position[0],
      base[1] + d.transform.position[1],
      base[2] + d.transform.position[2],
    ];
    return new THREE.Box3(
      new THREE.Vector3(c[0] + d.aabb.min[0], c[1] + d.aabb.min[1], c[2] + d.aabb.min[2]),
      new THREE.Vector3(c[0] + d.aabb.max[0], c[1] + d.aabb.max[1], c[2] + d.aabb.max[2]),
    );
  }

  /** everything the dressing pass put INSIDE the cabin */
  const INTERIOR = ['floor-mat-0', 'floor-mat-1', 'berth-port', 'berth-starboard',
    'radio-crate', 'radio-set', 'radio-partition', 'battery-1', 'battery-2',
    'pot-1', 'pot-2', 'ladle', 'chart', 'cage'];

  it('every interior fitting is inside the cabin\'s clear volume, and none stands in the doorway', () => {
    for (const id of INTERIOR) {
      const b = shipBox(id);
      // a yawed box's AABB grows by its own half-diagonal, so the bar is the
      // WALL, with the wall's own thickness as the tolerance — the point is
      // "inside the room", not "inside to the millimetre"
      const slack = p.cabinWallThickness;
      expect(b.min.x, `${id} through the port wall`).toBeGreaterThan(room.x0 - slack);
      expect(b.max.x, `${id} through the starboard wall`).toBeLessThan(room.x1 + slack);
      expect(b.min.z, `${id} through the aft gable`).toBeGreaterThan(room.z0 - slack);
      expect(b.max.z, `${id} through the forward gable`).toBeLessThan(room.z1 + slack);
      expect(b.min.y, `${id} through the floor`).toBeGreaterThanOrEqual(room.floor - 1e-6);
      expect(b.max.y, `${id} through the eave`).toBeLessThanOrEqual(room.eave + 1e-6);
      // THE DOORWAY IS THE ONLY WAY IN [§3 Opening]: nothing may occupy the
      // 1.4 m of open starboard wall, or the player walks into furniture the
      // moment he steps over the sill
      const inDoorZ = b.max.z > room.doorZ0 && b.min.z < room.doorZ1;
      if (inDoorZ) {
        expect(b.max.x, `${id} stands in the doorway`).toBeLessThan(room.x1 - 0.25);
      }
    }
  });

  it('the radio SITS on its crate — it is not floating, and the crate is under it', () => {
    const set = shipBox('radio-set');
    const crate = shipBox('radio-crate');
    // the fault, in one line: the bottom of the set is on the top of the crate
    expect(set.min.y - crate.max.y, 'the set is off its crate').toBeLessThan(0.02);
    expect(crate.max.y - set.min.y, 'the set is sunk into its crate').toBeLessThan(0.02);
    // and it is standing ON it, not beside it: the set's footprint is over the
    // crate's in both axes
    expect(set.min.x).toBeGreaterThanOrEqual(crate.min.x - 1e-6);
    expect(set.max.x).toBeLessThanOrEqual(crate.max.x + 1e-6);
    expect(set.min.z).toBeGreaterThanOrEqual(crate.min.z - 1e-6);
    expect(set.max.z).toBeLessThanOrEqual(crate.max.z + 1e-6);
    // the crate itself stands on the cabin floor
    expect(crate.min.y).toBeCloseTo(L.cabinFloorY, 6);
  });

  it('a crouched player at station-radio can reach the dial and is looking DOWN at it', () => {
    // §V71: the socket through the live assembly, not the authored number
    const s = asm.socketWorldPosition('station-radio');
    const eye = [s[0], s[1] + playerParams.crouchHeight - playerParams.eyeDrop, s[2]];
    const d = corner.dial;
    const reach = Math.hypot(d[0] - eye[0], d[1] - eye[1], d[2] - eye[2]);
    // arm's length: near enough to read a dial and to put a hand on it, far
    // enough that the player is not standing inside the set
    expect(reach, 'the dial is out of reach from station-radio').toBeLessThan(1.0);
    expect(reach, 'the player is inside the radio').toBeGreaterThan(0.3);
    expect(d[1], 'the dial is above a crouched eye').toBeLessThan(eye[1]);
    // and the station is clear of the furniture it serves: a 0.6 m capsule
    // fits between the crate, the partition and the battery cases
    const r = playerParams.capsuleRadius;
    for (const id of ['radio-crate', 'radio-partition', 'battery-1', 'battery-2']) {
      const b = shipBox(id);
      const dx = Math.max(b.min.x - s[0], s[0] - b.max.x, 0);
      const dz = Math.max(b.min.z - s[2], s[2] - b.max.z, 0);
      expect(Math.hypot(dx, dz), `${id} is inside the crouch station`).toBeGreaterThan(r);
    }
  });

  it('the roof is OVERLAPPING COURSES on laths, not a slab: each course laps its neighbour and the eave hangs 20–30 cm', () => {
    const slope = roofSlope(p);
    for (const side of ['port', 'starboard'] as const) {
      const roof = byId.get(`thatch-roof-${side}`)!;
      const slabLen = roof.aabb.max[0] - roof.aabb.min[0];
      const courses = thatchCourses(slabLen, roof.aabb.max[1], roof.shape ?? {});
      expect(courses.length, `${side}: a slab is one course`).toBeGreaterThan(2);
      for (let k = 0; k < courses.length - 1; k++) {
        const a = courses[k];
        const b = courses[k + 1];
        // TILES: the lower course reaches back UNDER the one above it, so the
        // two spans share a stretch of slope — that overlap is what a course
        // line is, and it is what a single slab has none of
        expect(b.head, `${side} course ${k + 1} starts below course ${k}'s butt`).toBeLessThan(a.butt);
        expect(a.butt - b.head, `${side}: courses ${k} and ${k + 1} do not lap`).toBeGreaterThan(0);
        // and the one nearer the eave sits LOWER, which is the step that
        // catches a grazing sun
        expect(b.top, `${side}: course ${k + 1} does not step down`).toBeLessThan(a.top);
      }
      // the eave: every butt of the bottom course, as a HORIZONTAL overhang
      // past the wall face — the reference's ragged 20–30 cm [§3 Roof]
      const butts = thatchEaveButts(slabLen, roof.shape ?? {});
      const overhangs = butts.map((b) => b * Math.cos(slope) - p.cabinWidth / 2);
      for (const o of overhangs) {
        expect(o, `${side} eave overhang`).toBeGreaterThanOrEqual(0.2 - 1e-6);
        expect(o, `${side} eave overhang`).toBeLessThanOrEqual(0.3 + 1e-6);
      }
      // RAGGED, not ruled: the butts are not all the same
      expect(new Set(overhangs.map((o) => o.toFixed(3))).size,
        `${side} eave is a straight line`).toBeGreaterThan(1);
      // and the laths are under the thatch, riding the same slope
      const laths = byId.get(`roof-lath-${side}`)!;
      expect(laths.parent).toBe(`thatch-roof-${side}`);
      expect(laths.aabb.max[1]).toBeLessThanOrEqual(courses[0].bottom + 1e-9);
      expect(laths.shape?.laths ?? 0).toBeGreaterThan(1);
    }
  });

  it('the three cabin-side crates are three DIFFERENT crates — size and yaw, pairwise (§T34)', () => {
    const crates = [1, 2, 3].map((k) => byId.get(`crate-${k}`)!);
    const size = (d: PieceDef): [number, number, number] => [
      d.aabb.max[0] - d.aabb.min[0], d.aabb.max[1] - d.aabb.min[1], d.aabb.max[2] - d.aabb.min[2],
    ];
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        const a = size(crates[i]);
        const b = size(crates[j]);
        // the copy-paste test: two crates that differ by less than a hand's
        // breadth in every dimension are the same crate drawn twice
        const dSize = Math.max(...a.map((v, k) => Math.abs(v - b[k])));
        expect(dSize, `crate-${i + 1} vs crate-${j + 1} are the same size`).toBeGreaterThan(0.03);
        const dYaw = Math.abs(crates[i].transform.rotation[1] - crates[j].transform.rotation[1]);
        expect(dYaw, `crate-${i + 1} vs crate-${j + 1} sit at the same angle`).toBeGreaterThan(0.03);
      }
      // …and each is LASHED, with its own number of turns
      expect(crates[i].shape?.lash ?? 0).toBeGreaterThan(0);
    }
    expect(new Set(crates.map((c) => c.shape?.lash)).size,
      'every crate is lashed with the same number of bands').toBeGreaterThan(1);
  });

  it('the one `irregularity` dial still puts them back — 0 = three identical crates (§T34)', () => {
    // §V62/§V80: the property is that the DIAL owns the variation, not that
    // the variation has a particular size. Same shape as the §B73 yard test.
    const was = shipDetailParams.irregularity;
    try {
      shipDetailParams.irregularity = 0;
      const flat = buildRaftBlueprint();
      const crates = [1, 2, 3].map((k) => flat.find((d) => d.id === `crate-${k}`)!);
      for (const c of crates) {
        expect(c.transform.rotation[1]).toBeCloseTo(0, 12);
        expect(c.aabb.max[0] - c.aabb.min[0]).toBeCloseTo(p.crateWidth, 9);
      }
    } finally {
      shipDetailParams.irregularity = was;
    }
  });

  it('the deck dressing keeps out of the roads: the chest is inboard of the sheet, the railing stops nobody', () => {
    // §V85 — the deck edge is a REAL edge you can step off and climb back at,
    // so the railing must not be a wall to the walker. `rope-rail` has no case
    // in the deck-field writer, which is the whole point of the kind.
    for (const side of ['port', 'starboard'] as const) {
      const rail = byId.get(`rail-${side}`)!;
      expect(rail.kind).toBe('rope-rail');
      expect(rail.shape?.posts ?? 0).toBeGreaterThan(1);
      expect(rail.shape?.sag ?? 0, 'the railing rope is taut, not slack').toBeGreaterThan(0);
      // it stands on the OUTER log, along the deck edge
      expect(Math.abs(rail.transform.position[0])).toBeGreaterThan(L.halfBeam - 0.4);
    }
    // the plank chest: forward of the cabin, inboard of the starboard sheet
    // station and clear of the halyard station at the mast foot
    const chest = shipBox('plank-chest');
    expect(chest.min.z).toBeGreaterThan(L.cabinFrontZ);
    const r = playerParams.capsuleRadius;
    for (const id of ['station-sheet-s', 'station-sheet-p', 'station-halyard']) {
      const s = asm.socketWorldPosition(id);
      const dx = Math.max(chest.min.x - s[0], s[0] - chest.max.x, 0);
      const dz = Math.max(chest.min.z - s[2], s[2] - chest.max.z, 0);
      expect(Math.hypot(dx, dz), `the chest blocks ${id}`).toBeGreaterThan(r);
    }
  });

  it('the whole pass fits the budget: under the §B87 4 000 triangles, and the raft stays the light end of the fleet', () => {
    const DRESSING = /^(radio-|berth-|floor-mat-|roof-lath|rail-|aerial-|plank-chest|battery-|pot-|ladle$|chart$)/;
    const added = raft.filter((d) => DRESSING.test(d.id)).reduce((n, d) => n + triCount(d), 0);
    // the roof and the crates were already pieces; only their COST changed
    const roof = raft.filter((d) => d.kind === 'thatch-roof' || /^crate-\d/.test(d.id))
      .reduce((n, d) => n + triCount(d), 0);
    expect(added + roof, '§B87 budget: ≤ +4 000 tris').toBeLessThan(4000);
    // §V17: the raft is walked in first person beside the sierra terrain, so
    // she stays well under the square-rigger she shares a frame budget with
    expect(totalTris(raft)).toBeLessThan(totalTris(buildBrigantineBlueprint()) / 2);
  });
});

/**
 * §T129 — THE CABIN'S ROOF, WALLS AND WEAVE. The user, head-on from the tiller
 * (`docs/raft2100/ref/bug-cabin-roof-weave.png`): the roof "has normal issues
 * — a super lengthy stretched weird shadow", and "we have z-fighting on the
 * walls of the cabin — the side walls and the back walls are stuck in each
 * other".
 *
 * The properties, not the decisions (§V80). Z-FIGHTING is not "the walls are
 * 5 cm thick" or "the wall runs 4.3 m" — it is two opaque surfaces the depth
 * buffer cannot order, which is `coplanarFights` above and nothing else. The
 * STRETCH is not "thatchRowPitch is 0.12" — it is a course of leaves that
 * measures a metre of ROOF per metre it advances, which is §V66's rule read
 * off the roof's own dimension.
 */
describe('§T129 the cabin shell: no fighting faces, and courses that step', () => {
  const p = raftParams;
  const raft = buildRaftBlueprint();
  const L = raftLayout();
  const asm = new ShipAssembly(raft, stubFactory);
  asm.group.updateMatrixWorld(true);
  const byId = new Map(raft.map((d) => [d.id, d]));
  const walls = raft.filter((d) => d.kind === 'cabin-wall').map((d) => d.id);

  it('(b) no two cabin wall or gable surfaces share a plane, a facing and a patch of area', () => {
    // WHY THIS IS THE TEST. Before the fix the port wall and both starboard
    // walls ran the FULL cabin length while the two gables ran the full width,
    // so each of the four corners had the side wall's outer face and the
    // gable's end face on one plane pointing one way over the gable's whole
    // 5 cm × 1.54 m section, and the gable's outer face and the side wall's
    // end cap likewise — eight patches, 0.077 m² each on the sides and
    // 0.002 m² on the sills. No metre value could have caught it: every one of
    // those metre values was right, and the arrangement was still wrong.
    expect(coplanarFights(asm, walls).join('\n')).toBe('');
  });

  it('(b) the cabin is still CLOSED: the side walls meet the gables, gable to gable, with no gap', () => {
    // the cure for the fight must not open the shell — a wall shortened PAST
    // the gable is a slot of daylight at the corner, the same defect with the
    // sign flipped, and it is why this is asserted alongside the one above
    const t = p.cabinWallThickness;
    for (const id of ['cabin-wall-port', 'cabin-wall-starboard-aft', 'cabin-wall-starboard-fwd']) {
      const w = byId.get(id)!;
      const z0 = w.transform.position[2] + w.aabb.min[2];
      const z1 = w.transform.position[2] + w.aabb.max[2];
      expect(z0, `${id} misses the aft gable`).toBeGreaterThanOrEqual(L.cabinAftZ + t - 1e-9);
      expect(z1, `${id} misses the forward gable`).toBeLessThanOrEqual(L.cabinFrontZ - t + 1e-9);
    }
    // the port side is closed gable to gable in one piece — no door that side
    const port = byId.get('cabin-wall-port')!;
    expect(port.transform.position[2] + port.aabb.min[2]).toBeCloseTo(L.cabinAftZ + t, 9);
    expect(port.transform.position[2] + port.aabb.max[2]).toBeCloseTo(L.cabinFrontZ - t, 9);
    // …and the gables still span the full width, so the corners stay solid to
    // the walker (raftDeckFieldCells reads every cabin-wall as one solid)
    for (const id of ['cabin-wall-aft', 'cabin-wall-fwd']) {
      const g = byId.get(id)!;
      expect(g.aabb.max[0] - g.aabb.min[0]).toBeCloseTo(p.cabinWidth, 9);
    }
  });

  it('(a) no two courses of one roof slope share a plane, a facing and a patch of area', () => {
    // the roof's own version of the same fault, and the one a man at the
    // tiller is looking straight up into: every course box reached back UNDER
    // its neighbour to the SAME shared underside, so consecutive courses put
    // 0.14 m × 4.8 m of soffit on one plane facing one way — 2.0 m² a slope.
    for (const side of ['port', 'starboard'] as const) {
      expect(coplanarFights(asm, [`thatch-roof-${side}`]).join('\n'), side).toBe('');
    }
  });

  it('(a) every roof normal is unit, and a lap turns the surface: course face, riser, underside', () => {
    for (const side of ['port', 'starboard'] as const) {
      const roof = byId.get(`thatch-roof-${side}`)!;
      const g = buildPieceGeometry(roof.kind, roof.aabb, roof.shape);
      const n = g.attributes.normal;
      for (let i = 0; i < n.count; i++) {
        const len = Math.hypot(n.getX(i), n.getY(i), n.getZ(i));
        expect(len, `${side} normal ${i} is not unit`).toBeCloseTo(1, 5);
      }
      // a slope shaded as ONE plane is the failure the user described. The
      // courses must present at least the six directions a stepped solid has,
      // and a riser standing at EVERY lap — that step is what a low sun
      // catches, and it is the only thing separating thatch from a painted box.
      const dirs = new Set<string>();
      for (let i = 0; i < n.count; i++) {
        dirs.add([n.getX(i), n.getY(i), n.getZ(i)].map((v) => v.toFixed(3)).join(','));
      }
      expect(dirs.size, `${side}: the slope is shaded as one plane`).toBeGreaterThanOrEqual(6);
      const slabLen = roof.aabb.max[0] - roof.aabb.min[0];
      const courses = thatchCourses(slabLen, roof.aabb.max[1], roof.shape ?? {});
      const sign = (roof.shape?.eaveSign ?? 1) < 0 ? -1 : 1;
      const pos = g.attributes.position;
      for (let k = 0; k < courses.length - 1; k++) {
        const x = sign * (courses[k].butt - slabLen / 2);
        let riser = false;
        for (let i = 0; i + 2 < pos.count && !riser; i += 3) {
          if (Math.abs(Math.abs(n.getX(i)) - 1) > 1e-6) continue;
          if (Math.abs(pos.getX(i) - x) > 1e-6) continue;
          riser = true;
        }
        expect(riser, `${side}: course ${k} has no riser at its butt — no step, no shadow`).toBe(true);
      }
      g.dispose();
    }
  });
});

/**
 * §T.137 — THE DECK USES THE RAFT'S OWN WIDTH, AND THE EDGE IS ONE LINE.
 *
 * USER: "our guardrails are too much inset, they are not on the outer edge —
 * on one side at least, and actually on both. The deck is not wide enough left
 * and right to really use the width, so we're losing a bunch of space."
 *
 * MEASURED before the fix, on the built blueprint:
 *   log field faces      −2.721 / +2.692   (5.41 m of beam over nine logs)
 *   `deck-fore`          −2.432 / +2.432   → 0.29 m port and 0.26 m starboard
 *                                            of bare log outboard of the mats
 *   `deck-starboard`      1.230 / +2.432   → a 1.20 m strip, not 1.46
 *   `foot-rail-*`        ±2.432             on the outer log's CENTRELINE,
 *                                            a quarter-metre inboard of the
 *                                            edge it is named for
 *   `rail-*`             ±2.354 / ±2.345   → 0.338 / 0.376 m inboard of the
 *                                            faces, and INBOARD of the
 *                                            foot-rail as well
 *
 * The bars below are relations to the OUTER LOG'S OWN FACE (§V80/§V71), so a
 * re-seeded log field carries all four with it.
 */
describe('§T.137 the deck edge: mats, foot-rail and railing on one line', () => {
  const p = raftParams;
  const raft = buildRaftBlueprint();
  const L = raftLayout();
  const byId = new Map(raft.map((d) => [d.id, d]));
  const outer = { port: L.logs[0], starboard: L.logs[L.logs.length - 1] };
  /** ship-space x of the outer log's outboard face, per side */
  const face = { port: outer.port.x - outer.port.r, starboard: outer.starboard.x + outer.starboard.r };
  const span = (id: string, axis: 0 | 2): [number, number] => {
    const d = byId.get(id)!;
    return [d.transform.position[axis] + d.aabb.min[axis], d.transform.position[axis] + d.aabb.max[axis]];
  };

  it('the mats reach the outer logs\' faces on BOTH sides — the deck covers the wood, ⊥ half of it', () => {
    // WHY THIS IS A PROPERTY: "the deck is 5.41 m wide" would be a magnitude a
    // re-seeded log field breaks. "The mats end where the wood ends" is the
    // thing the user asked for and it survives any diameter draw.
    const TOL = p.matThickness; // a mat's own thickness of slop, no more
    const [x0, x1] = span('deck-fore', 0);
    expect(x0, 'deck-fore port edge vs the port log face').toBeLessThanOrEqual(face.port + TOL);
    expect(x1, 'deck-fore starboard edge vs the starboard log face').toBeGreaterThanOrEqual(face.starboard - TOL);
    // the starboard strip runs from the cabin wall to the SAME face
    const [s0, s1] = span('deck-starboard', 0);
    expect(s0, 'the strip still starts at the cabin wall').toBeGreaterThanOrEqual(p.cabinWidth / 2);
    expect(s1, 'the strip reaches the starboard log face').toBeGreaterThanOrEqual(face.starboard - TOL);
    // …and it is wider than one capsule can walk with a shoulder each side
    expect(s1 - s0, 'the starboard strip').toBeGreaterThan(playerParams.capsuleRadius * 4);
  });

  it('the deck is STILL not continuous: nothing aft of the cabin, nothing port of it [§1 Deck coverage]', () => {
    // §T.137 widens the deck WITHIN the reference's coverage. Widening it into
    // a paved raft would be the same defect in the other direction.
    const decks = raft.filter((d) => d.kind === 'bamboo-deck' && d.parent === undefined
      && d.id !== 'cabin-floor' && (d.shape?.platform ?? 0) === 0);
    for (const d of decks) {
      const [z0] = span(d.id, 2);
      const [x0] = span(d.id, 0);
      expect(z0, `${d.id} reaches aft of the cabin`).toBeGreaterThanOrEqual(L.cabinAftZ - 1e-9);
      if (z0 < L.cabinFrontZ - 1e-9) {
        expect(x0, `${d.id} is port of the cabin`).toBeGreaterThanOrEqual(p.cabinWidth / 2);
      }
    }
    // and the stern is bare: no mat abaft the cabin's aft wall
    const aftMost = Math.min(...decks.map((d) => span(d.id, 2)[0]));
    expect(aftMost).toBeGreaterThanOrEqual(L.cabinAftZ - 1e-9);
  });

  it('the foot-rail runs along the DECK EDGE — its outer face flush with the log\'s [§1 Foot-rails]', () => {
    // §B78/§T.137: it lay on the outer log's centreline, half of it under the
    // mats and 0.26 m inboard of the edge it is the edge of.
    for (const side of ['port', 'starboard'] as const) {
      const [x0, x1] = span(`foot-rail-${side}`, 0);
      const outboard = side === 'port' ? x0 : x1;
      expect(Math.abs(outboard - face[side]), `foot-rail-${side} vs the log face`)
        .toBeLessThanOrEqual(p.footRailDiameter / 2);
      // still a climb from the sea, not a bulwark (§V85 / T115-1)
      const rail = byId.get(`foot-rail-${side}`)!;
      expect(rail.transform.position[1] + rail.aabb.max[1]).toBeLessThanOrEqual(playerParams.boardVertical);
    }
  });

  /**
   * ROUTED, NOT DONE — the one piece of §T.137 this agent could not land.
   *
   * `rail-{side}` is built in `src/ship/raftPartsCabin.ts:buildDressing`, which
   * this task was told not to touch (a live sibling holds §T.134 there). The
   * change is ONE expression: the stanchion x is authored as
   *
   *     outer.x - sign * outer.r * 0.3          // 0.338 m / 0.376 m INBOARD
   *
   * i.e. 30 % of the log's radius INBOARD of its centreline, which puts the
   * posts inboard of the foot-rail as well. It should stand on the log's
   * outboard shoulder, its own outer face flush with the log's:
   *
   *     outer.x + sign * (outer.r - p.railPostDiameter / 2)
   *
   * Un-skip this test with that line. Nothing else in §T.137 depends on it —
   * `rope-rail` has no case in `raftDeckFieldCells.ts` and never will (§V85),
   * so the railing moves in the eye only, not in the walk field.
   */
  it('(ROUTED) the railing stands at the outer edge on BOTH sides', () => {
    for (const side of ['port', 'starboard'] as const) {
      const rail = byId.get(`rail-${side}`)!;
      const inset = Math.abs(face[side]) - Math.abs(rail.transform.position[0]);
      expect(inset, `rail-${side} inboard of the log face`).toBeLessThanOrEqual(p.railPostDiameter);
      expect(inset, `rail-${side} outboard of the log face`).toBeGreaterThanOrEqual(-p.railPostDiameter);
      // and outboard of the foot-rail it runs beside, not inboard of it
      const [f0, f1] = span(`foot-rail-${side}`, 0);
      const footInboard = side === 'port' ? f1 : f0;
      expect(Math.abs(rail.transform.position[0])).toBeGreaterThan(Math.abs(footInboard));
    }
  });
});

/**
 * §T.138 — THE MIZZEN YARD IS HELD BY SOMETHING, AND THE STERN POLES ARE NOT
 * STANDING IN THE GUARA SLOTS.
 *
 * USER (`docs/raft2100/ref/bug-mizzen-yard-floating.png`): "the guara boards
 * are kinda weirdly in the way in the back. And the guara boards have two
 * poles — maybe they were supposed to hold the back sail's horizontal bar or
 * something, but they are not connected. The horizontal bar for the back sail
 * is floating mid-air."
 *
 * MEASURED before the fix:
 *   `mast-mizzen`  x −0.900, `station-guara-4` chink at x −0.935  → Δ 0.035 m
 *   `flagpole`     x +0.900, `station-guara-5` chink at x +0.898  → Δ 0.002 m,
 *                  and the flagpole's box (z −5.43…−5.37) lies INSIDE the
 *                  guara plank's (z −5.50…−4.90): a hard interpenetration
 *   `yard-mizzen-lower` stands off `mast-mizzen` by `yardMastClearance` 0.30 m
 *                  — 0.30 m of CLEAR AIR between a 0.10 m pole and a 0.072 m
 *                  yard, i.e. three pole-diameters of nothing, with no parrel
 *                  drawn across it
 *
 * The two poles are NOT the guaras' poles: they are the mizzen mast and the
 * ensign staff, authored at ±0.9 m, which is exactly where the two aft guara
 * chinks fall.
 */
describe('§T.138 the mizzen is held, and the stern poles stand on logs', () => {
  const p = raftParams;
  const raft = buildRaftBlueprint();
  const L = raftLayout();
  const byId = new Map(raft.map((d) => [d.id, d]));
  const asm = new ShipAssembly(raft, stubFactory);
  asm.group.updateMatrixWorld(true);
  const rect = (d: PieceDef): { x0: number; x1: number; z0: number; z1: number } => ({
    x0: d.transform.position[0] + d.aabb.min[0],
    x1: d.transform.position[0] + d.aabb.max[0],
    z0: d.transform.position[2] + d.aabb.min[2],
    z1: d.transform.position[2] + d.aabb.max[2],
  });
  const guaras = raft.filter((d) => d.kind === 'guara');
  const sternPoles = ['mast-mizzen', 'flagpole'];

  it('every deck-stepped pole stands on a LOG CROWN, never in a chink where a guara rides', () => {
    // WHY: a pole authored as a free x lands in a gap sooner or later, and a
    // gap is where a centreboard lives. §V71 — resolve against the log field's
    // own shape. Covers the bipod legs too: the class, not the instance.
    // every pole's AXIS is over a log, never over a chink…
    for (const id of [...sternPoles, 'bipod-leg-port', 'bipod-leg-starboard']) {
      const x = byId.get(id)!.transform.position[0];
      const log = L.logs.find((l) => Math.abs(l.x - x) <= l.r + 1e-9);
      expect(log, `${id} at x=${x.toFixed(3)} is stepped in a chink`).toBeDefined();
    }
    // …and the two STERN poles, the ones that share the after body with the
    // guaras, stand wholly on one crown and are seated on THAT log's own
    // radius (§V71), not on the tallest log's.
    // MEASURED, out of §T.138's scope: the bipod legs sit at ±2.25 for a
    // `mastLegSpacing` the log field never agreed to, so `bipod-leg-starboard`
    // overhangs chink 7 by 12 mm, and both legs are stepped at `L.logTopY` and
    // float 3 mm (port) / 32 mm (starboard) over the log they stand on. Both
    // are under the mats and invisible; noted rather than moved.
    for (const id of sternPoles) {
      const d = byId.get(id)!;
      const log = L.logs.find((l) => Math.abs(l.x - d.transform.position[0]) + d.aabb.max[0] <= l.r + 1e-9);
      expect(log, `${id} overhangs a chink`).toBeDefined();
      expect(d.transform.position[1] + d.aabb.min[1], `${id} foot`)
        .toBeCloseTo(p.logAxisY + (log as { r: number }).r, 9);
    }
  });

  it('no rig pole passes through a guara plank, at any point of the plank\'s travel', () => {
    // §B70/§T.138: a guara only moves in y, so a footprint overlap is an
    // interpenetration at every depth the crew can haul it to. The flagpole
    // used to be inside `guara-5`'s box outright.
    for (const id of sternPoles) {
      const a = rect(byId.get(id)!);
      for (const g of guaras) {
        const b = rect(g);
        const overlap = a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;
        expect(overlap, `${id} intersects ${g.id}`).toBe(false);
        // …and it is not merely touching it either: a pole a hand's width
        // from a centreboard still reads as growing out of it
        const dx = Math.max(a.x0 - b.x1, b.x0 - a.x1, 0);
        const dz = Math.max(a.z0 - b.z1, b.z0 - a.z1, 0);
        expect(Math.hypot(dx, dz), `${id} is on top of ${g.id}`)
          .toBeGreaterThan(p.guaraWidth / 4);
      }
    }
  });

  it('the aft guaras and the stern poles clear the helmsman\'s swing at `station-tiller`', () => {
    // The working area is HIS, measured from the raft's own numbers: the man
    // (one capsule radius) plus half the tiller cross-piece he sweeps. Before
    // the fix `guara-5` sat 0.985 m out, the mizzen pole 0.962 and the
    // flagpole 0.989 — all three inside a 1.05 m disc.
    const block = byId.get('stern-block')!;
    const s = block.sockets.find((q) => q.id === 'station-tiller')!;
    const tx = block.transform.position[0] + s.position[0];
    const tz = block.transform.position[2] + s.position[2];
    const swing = playerParams.capsuleRadius + p.oarTillerLength / 2;
    const clear = swing + playerParams.capsuleRadius; // …and elbow room round it
    for (const d of [...guaras, ...sternPoles.map((id) => byId.get(id)!)]) {
      const b = rect(d);
      const dx = Math.max(b.x0 - tx, tx - b.x1, 0);
      const dz = Math.max(b.z0 - tz, tz - b.z1, 0);
      expect(Math.hypot(dx, dz), `${d.id} stands in the helmsman's way`).toBeGreaterThan(clear);
    }
  });

  it('§T.96 still holds: guaras both FORWARD and AFT of the sail\'s centre of effort', () => {
    // Moving the aft pair must not cost the steering model its authority —
    // the yaw moment is Σ lift·(pos − CE), so boards all on one side of the CE
    // can only push one way. CE is read from the MAINSAIL that is actually
    // built, not from a number (§V71).
    const sail = byId.get('sail-main-lower')!;
    const yard = byId.get(sail.parent as string)!;
    const ce = asm.group.getObjectByName(sail.id)!.getWorldPosition(new THREE.Vector3()).z;
    expect(Number.isFinite(ce)).toBe(true);
    expect(yard.parent).toBe('mast-main');
    const zs = guaras.map((g) => g.transform.position[2]);
    expect(zs.filter((z) => z > ce).length, 'boards forward of the CE').toBeGreaterThanOrEqual(2);
    expect(zs.filter((z) => z < ce).length, 'boards aft of the CE').toBeGreaterThanOrEqual(2);
  });

  it('no yard hoisted on a SINGLE pole hangs in clear air: the gap is parrel-sized and seized', () => {
    // §V71/§V66 — `yardMastClearance` is 0.30 m because the MAIN yard hangs
    // between two SPLAYING bipod legs and its cloth has to miss both. Applied
    // to a single 0.10 m pole it is three pole-diameters of nothing, which is
    // what the user saw. The bar is the POLE'S OWN diameter, not a metre value.
    const singles: Array<[string, string, number]> = [
      ['mast-mizzen', 'yard-mizzen-lower', p.mizzenDiameter / 2],
      ['mast-main', 'yard-main-upper', (p.mastLegDiameter / 2) * 0.8],
    ];
    for (const [poleId, yardId, poleR] of singles) {
      const yard = byId.get(yardId)!;
      expect(yard.parent, `${yardId} hangs on ${poleId}`).toBe(poleId);
      const yr = yard.aabb.max[1];
      const air = yard.transform.position[2] - poleR - yr;
      expect(air, `${yardId} floats off ${poleId}`).toBeLessThanOrEqual(poleR * 2 * 1.5);
      expect(air, 'a parrel has slack in it').toBeGreaterThan(0);
      // and there is ROPE in that air — a seizing that rides the yard, so it
      // follows every cock/rake/slew `yardAttitude` gives it (§V71)
      const parrel = byId.get(`lashing-parrel-${yardId.replace('yard-', '')}`);
      expect(parrel, `${yardId} has no parrel`).toBeDefined();
      const q = parrel as PieceDef;
      // §V71: it hangs on the POLE, the frame the yard pivots in — see the
      // note on `parrelSeizing`. The live-under-brace check is the next test.
      expect(q.parent).toBe(poleId);
      const reach = q.aabb.max[1];
      const c = q.transform.position;
      // one rope collar reaching BOTH axes: the pole's (x = z = 0 in the
      // mast's frame) and the yard's (z = standoff)
      expect(Math.hypot(c[0], c[2]), 'the parrel does not reach the pole').toBeLessThan(reach);
      expect(Math.hypot(c[0] - yard.transform.position[0], c[2] - yard.transform.position[2]),
        'the parrel does not reach its yard').toBeLessThan(reach);
      expect(Math.abs(c[1] - yard.transform.position[1]), 'the parrel is at the yard\'s height')
        .toBeLessThanOrEqual(reach);
    }
  });

  it('the parrel follows the yard LIVE — brace the rig and it is still on it (§V71)', () => {
    // WHY THIS TEST EXISTS: the first cut of the parrel hung on the YARD, and
    // `rigTrim` braces a yard about its own origin — so at −45° the collar had
    // walked 0.185 m off a pole it reaches 0.171 m around. A seizing that only
    // touches its spar in the rest pose is §V71's defect, not its cure.
    const parrel = asm.group.getObjectByName('lashing-parrel-mizzen-lower')!;
    const yardObj = asm.group.getObjectByName('yard-mizzen-lower')!;
    const poleObj = asm.group.getObjectByName('mast-mizzen')!;
    const yardDef = byId.get('yard-mizzen-lower') as PieceDef;
    const reach = (byId.get('lashing-parrel-mizzen-lower') as PieceDef).aabb.max[1];
    /** distance from `q` to the yard's AXIS, the yard live in world space */
    const toYardAxis = (q: THREE.Vector3): number => {
      const half = yardDef.aabb.max[0];
      const a = yardObj.localToWorld(new THREE.Vector3(-half, 0, 0));
      const b = yardObj.localToWorld(new THREE.Vector3(half, 0, 0));
      const ab = b.clone().sub(a);
      const t = Math.min(1, Math.max(0, q.clone().sub(a).dot(ab) / ab.lengthSq()));
      return q.distanceTo(a.clone().addScaledVector(ab, t));
    };
    for (const brace of [-shipRigParams.braceMax, 0, shipRigParams.braceMax]) {
      asm.setRigTrim(brace);
      asm.group.updateMatrixWorld(true);
      const a = parrel.getWorldPosition(new THREE.Vector3());
      const c = poleObj.getWorldPosition(new THREE.Vector3());
      // the pole is vertical: compare in the horizontal plane, so its LENGTH
      // is not counted as distance
      expect(Math.hypot(a.x - c.x, a.z - c.z), `parrel off the pole at brace ${brace.toFixed(2)}`)
        .toBeLessThan(reach);
      expect(toYardAxis(a), `parrel off the yard at brace ${brace.toFixed(2)}`).toBeLessThan(reach);
    }
    asm.setRigTrim(0);
  });

  it('is deterministic and still under the brigantine\'s budget with the parrels on', () => {
    const again = buildRaftBlueprint();
    expect(JSON.stringify(again)).toBe(JSON.stringify(raft));
    expect(totalTris(raft)).toBeLessThan(totalTris(buildBrigantineBlueprint()) / 2);
  });
});
