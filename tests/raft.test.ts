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
      'bipod-mast', 'steering-oar', 'crate', 'splashboard', 'stern-block', 'mast', 'yard', 'sail', 'pennant']);
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

  it('the bow is a V that the splashboards follow; the beam matches the crossbeams', () => {
    const bowOf = (x: PieceDef) => x.transform.position[2] + x.aabb.max[2];
    const centre = logs[Math.floor(logs.length / 2)];
    expect(bowOf(logs[0])).toBeLessThan(bowOf(centre) - 1);
    const boards = raft.filter((x) => x.kind === 'splashboard');
    expect(boards).toHaveLength(2);
    for (const b of boards) {
      expect(Math.abs(b.transform.rotation[1])).toBeGreaterThan(0.2); // angled, not athwartships
      expect(b.transform.position[2]).toBeGreaterThan(L.cabinFrontZ); // forward
    }
    const beam = 2 * L.halfBeam + logs[0].aabb.max[0] * 2;
    expect(beam).toBeGreaterThan(p.crossbeamLength * 0.85);
    expect(beam).toBeLessThan(p.crossbeamLength * 1.15);
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
    for (const [i, b] of tops.entries()) {
      expect(b.max.y).toBeGreaterThanOrEqual(crossingY);
      // the leg's own tip (local +y end) lands at the centreline, at the crossing
      const leg = legs[i];
      const tip = new THREE.Vector3(0, leg.aabb.max[1] - p.mastCrossingOverlap, 0)
        .applyEuler(new THREE.Euler(...leg.transform.rotation))
        .add(new THREE.Vector3(...leg.transform.position));
      expect(Math.abs(tip.x), `${leg.id} leans INWARD`).toBeLessThan(0.2);
      expect(tip.y).toBeCloseTo(crossingY, 1);
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
