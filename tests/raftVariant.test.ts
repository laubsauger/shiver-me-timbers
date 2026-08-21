/**
 * §T91 — the raft is the THIRD ship class, and every pipeline main.ts feeds a
 * blueprint through has to accept her: assembly → rigging plan → ratlines
 * (zero is fine: a bipod mast has no shrouds) → blocks → deck field → battery
 * (zero guns) → hit targets → arena targets → per-frame rig update. The
 * brigantine got the same walk in tests/enemyBrigantine.test.ts; this is
 * where "the raft tolerates the galleon's pipelines" becomes a measurement.
 *
 * Properties, not decisions (§V80): "small" is SHORTER and FEWER triangles
 * than the brigantine, "unarmed" is zero guns, "rigged" is at least three
 * sails — re-proportioning the raft does not fail this file.
 */
import { describe, expect, it } from 'vitest';
import type { Material } from 'three';
import mainSource from '../src/main.ts?raw';
import { buildRaftBlueprint } from '../src/ship/raftBlueprint';
import { buildBrigantineBlueprint } from '../src/ship/shipBlueprint';
import { ShipAssembly } from '../src/ship/shipAssembly';
import { buildBlockDescriptors, buildRiggingPlan } from '../src/ropes/shipRigging';
import { buildRatlinePlan } from '../src/ship/ratlinePlan';
import { buildRungDescriptors } from '../src/ropes/ratlines';
import { buildDeckHeightfield } from '../src/ship/deckHeightfield';
import { buildPieceGeometry, buildSailGeometry } from '../src/ship/pieceGeometry';
import { updateRig } from '../src/ship/rigTrim';
import { buildBattery } from '../src/combat/battery';
import { buildHitTargetSet } from '../src/combat/hitTargets';
import { arenaTargets } from '../src/combat/combatArena';
import { waterlineFromBlueprint } from '../src/sea-physics/hullContact';
import { STATION_IDS, createShipStations } from '../src/camera/camStations';
import { ropeParams } from '../src/params/ropes';
import { oceanParams } from '../src/params/ocean';
import type { PieceDef } from '../src/ship/pieceTypes';

const stubFactory = () => ({ dispose(): void {} }) as unknown as Material;

const finite3 = (v: ArrayLike<number>): boolean =>
  v.length === 3 && Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);

/** ship-space z extent over every piece (the raft has no 'hull-section') */
function lengthZ(bp: PieceDef[]): number {
  let bow = -Infinity;
  let stern = Infinity;
  for (const p of bp) {
    bow = Math.max(bow, p.transform.position[2] + p.aabb.max[2]);
    stern = Math.min(stern, p.transform.position[2] + p.aabb.min[2]);
  }
  return bow - stern;
}

function totalTris(bp: PieceDef[]): number {
  let n = 0;
  for (const p of bp) {
    const g = p.kind === 'sail' ? buildSailGeometry('full', p.aabb) : buildPieceGeometry(p.kind, p.aabb, p.shape);
    n += g.index !== null ? g.index.count / 3 : g.attributes.position.count / 3;
    g.dispose();
  }
  return n;
}

describe('§T91 the raft is a DIFFERENT ship, on the same rails as the other two', () => {
  const raft = buildRaftBlueprint();
  const brig = buildBrigantineBlueprint();

  it('is the light end of the fleet: shorter, cheaper, unarmed, and still under canvas', () => {
    // WHY: if the switch in main.ts ever lands on the galleon again, or the
    // raft grows guns by sharing a hull builder, nothing else would notice.
    expect(lengthZ(raft)).toBeLessThan(lengthZ(brig));
    expect(totalTris(raft)).toBeLessThan(totalTris(brig));
    expect(raft.filter((p) => p.kind === 'cannon').length).toBe(0);
    expect(raft.filter((p) => p.kind === 'sail').length).toBeGreaterThanOrEqual(3);
  });

  it('walks the whole boot pipeline: nothing reaches for a hull, a shroud or a gun by name', () => {
    const asm = new ShipAssembly(raft, stubFactory);
    expect(asm.group.children.length).toBeGreaterThan(10);

    const plan = buildRiggingPlan(raft);
    for (const rope of plan) {
      expect(finite3(asm.socketWorldPosition(rope.socketA)), rope.socketA).toBe(true);
      expect(finite3(asm.socketWorldPosition(rope.socketB)), rope.socketB).toBe(true);
    }
    // three sails: each is sheeted and its yard braced and lifted
    expect(plan.filter((r) => r.role === 'sheet').length).toBeGreaterThanOrEqual(3);
    expect(plan.some((r) => r.role === 'brace')).toBe(true);
    expect(plan.some((r) => r.role === 'lift')).toBe(true);

    // a bipod has no shrouds; zero ladders must not be an error downstream
    const ladders = buildRatlinePlan(raft);
    const declared = ladders.reduce((n, l) => n + l.rungs.length, 0);
    expect(buildRungDescriptors(ladders, plan)).toHaveLength(declared);
    expect(() => buildBlockDescriptors(plan, ropeParams.maxBlocks)).not.toThrow();

    // the LEGACY deck writer keys on a planked 'deck' piece the raft has not
    // got; main.ts accepts null there (materials fall back), so null is the
    // contract — a throw is the defect. The raft's own field is §T92's.
    expect(() => buildDeckHeightfield(raft)).not.toThrow();

    const battery = buildBattery(raft);
    expect(battery.port.length + battery.starboard.length).toBe(0);
    expect(() => buildHitTargetSet(raft)).not.toThrow();

    // the other player-blueprint consumers in boot: the waterline loft
    // (null → box fallback) and the 1..4 camera stations (null → key inert)
    expect(() => waterlineFromBlueprint(raft)).not.toThrow();
    const stations = createShipStations(raft, asm, () => 0);
    for (const id of STATION_IDS) expect(() => stations.pose(id)).not.toThrow();

    // the combat arena REFUSES a hull-less blueprint by design (Rule 8), and
    // main.ts only ever hands it the ENEMY's graph (§V77) — so the contract
    // the raft must satisfy is "never reaches it", pinned below on main.ts
    expect(() => arenaTargets(raft)).toThrow(/no holeable hull/);
    expect(mainSource).toMatch(/createCombatArena\([^)]*enemyBlueprint\)/);
    asm.dispose();
  });

  it('every station-* socket resolves to a finite world point on the live assembly (§V71)', () => {
    const asm = new ShipAssembly(raft, stubFactory);
    const stations = raft.flatMap((p) => p.sockets.filter((s) => s.id.startsWith('station-')).map((s) => s.id));
    expect(stations.length).toBeGreaterThanOrEqual(5);
    for (const id of stations) expect(finite3(asm.socketWorldPosition(id)), id).toBe(true);
    // the five preview stations by name
    for (const id of ['station-tiller', 'station-radio', 'station-gangway-bow', 'station-lookout', 'station-mat']) {
      expect(stations).toContain(id);
    }
    asm.dispose();
  });

  it('the membrane drives all three sails through 3 s at 10 m/s without a NaN anywhere on the cloth', () => {
    // WHY: §T85 evaluates the cloth on the CPU for every socket riding a sail
    // (clews, buntlines), and a NaN there is a NaN rope end and a NaN camera
    // on a station. The raft's square sails are smaller and lower than any
    // the membrane was tuned on.
    const prevSpeed = oceanParams.windSpeed;
    oceanParams.windSpeed = 10;
    const asm = new ShipAssembly(raft, stubFactory);
    const sails = asm.sailPieceIds();
    expect(sails).toHaveLength(3);
    for (const id of sails) asm.setSailState(id, 'full');
    asm.setRigTrim(0.4);
    const sailSockets = raft.filter((p) => p.kind === 'sail').flatMap((p) => p.sockets.map((s) => s.id));
    expect(sailSockets.length).toBeGreaterThan(0);
    try {
      for (let t = 0; t < 3; t += 1 / 60) {
        updateRig(asm, 1 / 60, 0.5 + 0.5 * Math.sin(t), 0.3, 0.4 + 0.2 * Math.sin(t * 0.7));
        for (const id of sailSockets) expect(finite3(asm.socketWorldPosition(id)), `${id} @ ${t}`).toBe(true);
      }
      for (const id of sails) {
        const pos = asm.sailMesh(id).geometry.attributes.position.array;
        for (let i = 0; i < pos.length; i++) expect(Number.isFinite(pos[i]), `${id}[${i}]`).toBe(true);
      }
    } finally {
      oceanParams.windSpeed = prevSpeed;
      asm.dispose();
    }
  });

  it('the ?ship=raft switch is WIRED in main.ts, not just declared (§V62, §V81)', () => {
    // WHY: a control that drives nothing is the defect §V62 catalogues. The
    // switch must read the query AND build the raft — either half alone is
    // a dead knob. And it is the only raft touch main.ts may carry.
    expect(mainSource).toContain("get('ship') === 'raft'");
    expect(mainSource).toContain('buildRaftBlueprint()');
    expect(mainSource.match(/buildRaftBlueprint/g)?.length).toBe(2); // import + one call
  });
});
