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
import { buildRiggingPlan } from '../src/ropes/shipRigging';
import { buildRatlinePlan } from '../src/ship/ratlinePlan';
import { raftParams } from '../src/params/raft';
import { shipDetailParams } from '../src/params/ship';
import { yardAttitude } from '../src/ship/raftPartsRig';
import { buildRaftRiggingPlan, RAFT_ROPE_MAX, RAFT_ROPE_TABLE, RAFT_STANDING_MAX, RAFT_STANDING_SLACK, raftSailKeyOf } from '../src/ship/raftRigging';
import { sheetLeadDirections } from '../src/ship/sailFrame';
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
      'bipod-mast', 'steering-oar', 'crate', 'splashboard', 'stern-block', 'lashing', 'mast', 'yard', 'sail', 'pennant']);
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
      const src = shared.find((s) => s.role === r.role && s.socketA === r.socketA && s.socketB === r.socketB)!;
      expect(src, `${r.role} ${r.socketA}`).toBeDefined(); // every raft rope IS a planner rope, re-dressed
      // §B80: a rope is a ROPE, not a spar — ≤ 20 mm radius, under a third of the yard's
      expect(r.thickness).toBeLessThanOrEqual(Math.min(src.thickness, 0.02) + 1e-9);
      expect(r.thickness).toBeLessThan(raftParams.yardDiameter / 2 / 3);
      expect(r.thickness).toBeLessThanOrEqual(raftParams.lashingRopeDiameter / 2 + 1e-9); // 30 mm hemp at most
      expect(r.thickness).toBeGreaterThan(0.004);
      if (r.role !== 'stay' && r.role !== 'shroud') expect(r.slack).toBe(src.slack);
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
    for (const r of plan) {
      expect(['stay', 'shroud', 'halyard', 'sheet', 'brace', 'lift'], `${r.role} has no place on the raft`).toContain(r.role);
      if (r.role === 'stay' || r.role === 'shroud') {
        standing++;
        continue;
      }
      const key = raftSailKeyOf(r.socketA) ?? raftSailKeyOf(r.socketB);
      expect(key, `${r.role} ${r.socketA} → ${r.socketB} belongs to no sail`).not.toBeNull();
      const k = `${key}|${r.role}`;
      perSail.set(k, (perSail.get(k) ?? 0) + 1);
    }
    expect(standing).toBeGreaterThanOrEqual(3); // side guys + the aft line, at least
    expect(standing).toBeLessThanOrEqual(RAFT_STANDING_MAX);
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
    // reference's door length between them, in the aft half
    expect(port.aabb.max[2] - port.aabb.min[2]).toBeCloseTo(p.cabinLength, 9);
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
    const lashings = raft.filter((x) => x.kind === 'lashing' && x.id !== 'lashing-crossing');
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
