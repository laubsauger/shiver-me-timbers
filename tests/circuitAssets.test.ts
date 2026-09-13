/**
 * §T.187 COURSE FURNITURE ASSETS — the GLBs the course draws, and what their placements promise.
 *
 * WHY (§Rule 6):
 *  · every course GLB must pass its contract at the FINAL stage (meshopt, KTX2 mips, slots, budgets per
 *    placed instance) — the checker is the build's gate, so it is also proven here to FAIL on the breaks
 *    it exists for (a checker that cannot fail is not there);
 *  · the placements may only name variants the GLBs actually carry, or a gate silently draws no board;
 *  · Main Street is "roof ridges and chimneys poking through" (design doc §5): the measured bench depth
 *    and the modelled roof heights together must put ridges above the water, and the landmarks well above;
 *  · the pylons' cables are "high and harmless", the start straight runs under a guy that must clear a
 *    jumping boat, stakes must reach the bar floor, and every guy must run from its leg to its anchor.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { Document, NodeIO } from '@gltf-transform/core';
import { createIO } from '../scripts/blender/checkGlb.mjs';
import { checkCourseDocument, loadCourseContract } from '../scripts/blender/course/checkCourseGlb.mjs';
import { buildTowerReach, type TowerReachWorld } from '../src/circuit/towerReach';
import { distanceToClosed } from '../src/circuit/courseLine';

interface Contract {
  version: number;
  slots: Record<string, { alphaMode: string; emissive?: boolean }>;
  assets: Record<string, { kind: string; variants: string[]; triBudget: number[]; drawBudget: number[]; instances: string[][] }>;
  roofs: Record<string, { eave: number; ridge: number; top: number }>;
}
const contract = loadCourseContract() as Contract;
const ROOT = new URL('..', import.meta.url).pathname;
const glbPath = (name: string) => `${ROOT}assets/models/${name}.glb`;
const ROOF_VARIANT: Record<string, string> = { gable: 'Gable', gableChimney: 'GableChimney', hip: 'Hip', shed: 'Shed', steeple: 'Steeple', waterTower: 'WaterTower' };

let world: TowerReachWorld;
const extrasOf: Record<string, Record<string, unknown>> = {};

beforeAll(async () => {
  world = buildTowerReach(1965);
  const io = await createIO();
  for (const name of Object.keys(contract.assets)) {
    if (!existsSync(glbPath(name))) continue;
    const doc = await io.read(glbPath(name));
    const root = doc.getRoot().getDefaultScene()!.listChildren()[0];
    const ex: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(root.getExtras() ?? {})) {
      try {
        ex[k] = typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        ex[k] = v;
      }
    }
    extrasOf[name] = ex;
  }
}, 120_000);

describe('course GLBs pass their contract (final stage)', () => {
  for (const name of Object.keys(contract.assets)) {
    it(name, async () => {
      expect(existsSync(glbPath(name)), `${name}.glb missing — node scripts/blender/course/build-course.mjs --asset ${name}`).toBe(true);
      const io = await createIO();
      const { errors, stats } = checkCourseDocument(await io.read(glbPath(name)), contract, { stage: 'final', asset: name });
      expect(errors).toEqual([]);
      expect(stats.tris[0]).toBeGreaterThan(0);
    });
  }
  // T187b: a lamp atlas packed to nothing baked a solid fill; packaging folded it into a factor and the lamp lost its
  // emissive texture. The packager now keeps solid textures, so the bake's own coverage is what proves a slot is real
  it('every slot atlas carries its bake (no empty, solid-fill atlas ships)', () => {
    for (const name of Object.keys(contract.assets)) {
      const density = extrasOf[name]?.courseTexelDensity as Record<string, { coverage: number; uvUsed: number }> | undefined;
      expect(density, `${name} courseTexelDensity`).toBeTruthy();
      for (const [slot, d] of Object.entries(density!)) {
        expect(d.coverage, `${name} ${slot} coverage`).toBeGreaterThan(0.05);
        expect(d.uvUsed, `${name} ${slot} uv used`).toBeGreaterThan(0.05);
      }
    }
  });
});

describe('the course checker fails on the breaks it guards', () => {
  /** a minimal valid course GLB: CF_course_bar_stake → LOD0..2 → Stake_LOD<n> boxes of shrinking size */
  const stakeDoc = (edit?: (doc: Document) => void): Document => {
    const doc = new Document();
    const buf = doc.createBuffer();
    const mat = doc.createMaterial('C_Steel');
    const scene = doc.createScene();
    const root = doc.createNode('CF_course_bar_stake').setExtras({ assetKind: 'barStake', contractVersion: contract.version, variants: '{}', heightAboveWater: 4.7 });
    scene.addChild(root);
    [120, 40, 12].forEach((tris, lod) => {
      const group = doc.createNode(`LOD${lod}`).setExtras({ lodLevel: lod });
      root.addChild(group);
      const pos: number[] = [];
      for (let i = 0; i < tris; i++) {
        const y = (4.7 * i) / tris;
        pos.push(0, y, 0, 0.2, y, 0, 0, y + 0.01, 0.2);
      }
      const acc = doc.createAccessor().setType('VEC3').setArray(new Float32Array(pos)).setBuffer(buf);
      const prim = doc.createPrimitive().setAttribute('POSITION', acc).setMaterial(mat);
      const mesh = doc.createMesh().addPrimitive(prim);
      group.addChild(doc.createNode(`Stake_LOD${lod}`).setMesh(mesh).setExtras({ lodLevel: lod, variant: 'Stake' }));
    });
    edit?.(doc);
    return doc;
  };
  const errorsOf = (doc: Document) => checkCourseDocument(doc, contract, { stage: 'raw', asset: 'course_bar_stake' }).errors;
  const node = (doc: Document, name: string) => doc.getRoot().listNodes().find((n) => n.getName() === name)!;

  it('accepts the minimal valid asset', () => {
    expect(errorsOf(stakeDoc())).toEqual([]);
  });
  it('rejects a moved node (instances carry the transform, geometry must be in the asset frame)', () => {
    expect(errorsOf(stakeDoc((d) => node(d, 'Stake_LOD0').setTranslation([1, 0, 0])))).not.toEqual([]);
  });
  it('rejects a variant the contract does not know and a missing one', () => {
    expect(errorsOf(stakeDoc((d) => node(d, 'Stake_LOD1').setName('Pole_LOD1').setExtras({ lodLevel: 1, variant: 'Pole' })))).not.toEqual([]);
    expect(errorsOf(stakeDoc((d) => node(d, 'Stake_LOD0').dispose()))).not.toEqual([]);
  });
  it('rejects a LOD that is not lighter, and a material outside the course slots', () => {
    expect(errorsOf(stakeDoc((d) => node(d, 'LOD2').listChildren()[0].getMesh()!.listPrimitives()[0].setAttribute('POSITION', node(d, 'Stake_LOD0').getMesh()!.listPrimitives()[0].getAttribute('POSITION'))))).not.toEqual([]);
    expect(errorsOf(stakeDoc((d) => d.getRoot().listMaterials()[0].setName('M_Gelcoat')))).not.toEqual([]);
  });
  it('rejects a heightAboveWater that lies about the geometry, and a raw asset at the final stage', () => {
    expect(errorsOf(stakeDoc((d) => node(d, 'CF_course_bar_stake').setExtras({ assetKind: 'barStake', contractVersion: contract.version, variants: '{}', heightAboveWater: 9 })))).not.toEqual([]);
    expect(checkCourseDocument(stakeDoc(), contract, { stage: 'final', asset: 'course_bar_stake' }).errors.join(' ')).toMatch(/meshopt/);
  });
  it('round-trips through GLB bytes (what the build writes is what is checked)', async () => {
    const io = new NodeIO();
    const doc = await io.readBinary(await io.writeBinary(stakeDoc()));
    expect(errorsOf(doc)).toEqual([]);
  });
});

describe('placements only name variants the GLBs carry', () => {
  it('gate numbers, boards, roof kinds and mark tags all exist', () => {
    const has = (asset: string, v: string) => contract.assets[asset].variants.includes(v);
    for (const p of world.furniture.poles) {
      expect(has('course_gate_pole', p.number === 0 ? 'BoardChequer' : p.board === 'square' ? 'BoardSquare' : 'BoardTriangle')).toBe(true);
      if (p.number > 0) expect(has('course_gate_pole', `Numeral${p.number}`), `gate ${p.gateId}`).toBe(true);
    }
    for (const r of world.furniture.roofs) expect(has('course_roofs', ROOF_VARIANT[r.kind]), r.kind).toBe(true);
    for (const b of world.furniture.buoys) expect(has('course_turn_buoy', `Tag${b.markId.replace(/\D/g, '')}`)).toBe(true);
  });
});

describe('what the placements promise, measured against the modelled geometry', () => {
  it('Main Street: ridges break the surface, chimneys and parapets stand proud, the landmarks tower over it', () => {
    const roofs = world.furniture.roofs;
    const top = (r: (typeof roofs)[number]) => r.floor + contract.roofs[ROOF_VARIANT[r.kind]].top;
    const ridge = (r: (typeof roofs)[number]) => r.floor + contract.roofs[ROOF_VARIANT[r.kind]].ridge;
    const houses = roofs.filter((r) => r.kind !== 'steeple' && r.kind !== 'waterTower');
    expect(houses.filter((r) => top(r) > 0.3).length / houses.length).toBeGreaterThanOrEqual(0.75);
    expect(houses.filter((r) => ridge(r) > 0).length).toBeGreaterThanOrEqual(12);
    // eaves stay awash or under: these are drowned houses, not houses on stilts
    for (const r of houses) expect(r.floor + contract.roofs[ROOF_VARIANT[r.kind]].eave).toBeLessThan(1.5);
    for (const r of roofs.filter((x) => x.kind === 'steeple' || x.kind === 'waterTower')) expect(top(r)).toBeGreaterThan(8);
  });

  it('bar stakes reach the bar floor', () => {
    const footY = Number(extrasOf.course_bar_stake?.footY);
    expect(Number.isFinite(footY)).toBe(true);
    for (const s of world.furniture.stakes) expect(footY).toBeLessThan(s.floor - 0.5);
  });

  it('pylon cables are high and harmless: the lowest conductor sags no lower than 8 m above the sea', () => {
    const ex = extrasOf.course_pylon;
    const attach = ex.attach as [number, number, number][];
    const cable = ex.cable as { sagPerSpan: number };
    expect(attach.length).toBeGreaterThanOrEqual(6);
    const lowest = Math.min(...attach.map((a) => a[1]));
    for (const [i, j] of world.furniture.spans) {
      const a = world.furniture.pylons[i].at;
      const b = world.furniture.pylons[j].at;
      const span = Math.hypot(a[0] - b[0], a[1] - b[1]);
      expect(lowest - cable.sagPerSpan * span, `span ${i}-${j} (${span.toFixed(0)} m)`).toBeGreaterThan(8);
    }
    // and the pylons' modelled footing reaches below the shallowest pylon water
    const baseY = Number(ex.baseY);
    const shallowest = Math.min(...world.furniture.pylons.map((p) => -world.seabedAt(p.at[0], p.at[1])));
    expect(baseY).toBeLessThan(-Math.min(shallowest, 12));
  });

  it('every guy runs from its leg toward its anchor, and the one over the start straight clears a jumping boat', () => {
    const ex = extrasOf.course_radio_tower;
    const guys = ex.guys as { level: number; leg: number; at: [number, number, number] }[];
    expect(guys).toHaveLength(9);
    const t = world.furniture.tower;
    const c = Math.cos(t.yaw);
    const s = Math.sin(t.yaw);
    // three.js rotation.y: asset (x, z) → world (x·c + z·s, −x·s + z·c)
    const toWorld = (p: [number, number, number]): [number, number, number] => [t.at[0] + p[0] * c + p[2] * s, p[1], t.at[1] - p[0] * s + p[2] * c];
    for (const g of guys) {
      const w = toWorld(g.at);
      const anchor = t.anchors[g.leg];
      const dirLeg = Math.atan2(w[2] - t.at[1], w[0] - t.at[0]);
      const dirAnchor = Math.atan2(anchor[1] - t.at[1], anchor[0] - t.at[0]);
      const d = Math.abs(Math.atan2(Math.sin(dirLeg - dirAnchor), Math.cos(dirLeg - dirAnchor)));
      expect(d, `guy level ${g.level} leg ${g.leg}`).toBeLessThan((6 * Math.PI) / 180);
      // where the guy crosses the reference line, it is well above a boat in the air (≥ 12 m)
      const line = world.course.referenceLine;
      for (let k = 0; k <= 60; k++) {
        const u = k / 60;
        const p: [number, number] = [w[0] + (anchor[0] - w[0]) * u, w[2] + (anchor[1] - w[2]) * u];
        const y = w[1] * (1 - u) + 1.5 * u;
        // a boat off a crest tops out ~5 m (design doc: biggest air on the lap); 8 m keeps 3 m over that plus a pitched-up antenna, across the whole ±15 m band
        if (distanceToClosed(line, p) < 15) expect(y, `guy ${g.level}/${g.leg} over the course`).toBeGreaterThan(8);
      }
    }
  });

  it('race control and the lamp board face the start straight', () => {
    const t = world.furniture.tower;
    const s = world.gates.find((g) => g.id === 'S')!;
    // asset +Z → world (sin yaw, cos yaw): toward the boats running up the straight (−heading)
    const face = [Math.sin(t.yaw), Math.cos(t.yaw)];
    expect(face[0] * -s.heading[0] + face[1] * -s.heading[1]).toBeGreaterThan(0.9);
    // asset −X (the hut, the boom) → world (−cos yaw, sin yaw): toward the course
    const side = [-Math.cos(t.yaw), Math.sin(t.yaw)];
    const toCourse = [s.mid[0] - t.at[0], s.mid[1] - t.at[1]];
    const l = Math.hypot(toCourse[0], toCourse[1]);
    expect((side[0] * toCourse[0] + side[1] * toCourse[1]) / l).toBeGreaterThan(0.8);
  });
});
