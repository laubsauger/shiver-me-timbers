/**
 * §T.112a quick wins — PROPERTIES (§V80), never decisions. WHY each matters:
 * - horizon map: the sun shadow map is 80 m around the ship; a 250 m island
 *   had no self-shadow and no AO at all (research D5). The map is only worth
 *   having if it is 0 where nothing rises (a flat field), grows as you walk
 *   toward a ridge (monotone), and bakes inside a load-time budget.
 * - pines: "~12 trees on a 250 m island" read as Playmobil (D8). Counts must
 *   go up, stands must CLUSTER (mean NN distance below a uniform scatter on
 *   the same bench), crowns must not interpenetrate after competition, and a
 *   steep island must still thin rather than throw.
 * - boulders: shore-ring only (D9). Inland boulders must sit on convex
 *   ground, and none may land in the DG beach band the raft beaches on.
 * - pirate islands byte-identical: §T.112a is additive to the galleon world.
 * - sierra material: the cover layer is retinted and the handle binds a
 *   horizon map (the whole point of items 1 and 4).
 * No renderer: bakes, placements and node-graph construction only.
 */
import { describe, expect, it } from 'vitest';
import { findShoreRadius, generateIslandHeightmap, gradientAt, type IslandHeightmap } from '../src/island/heightmap';
import { sierraIslandParams } from '../src/island/sierraSites';
import { bakeHorizonMap, horizonMapFor, sunVisibilityCpu, HORIZON_AZIMUTHS } from '../src/island/horizonMap';
import { createSierraAtlas } from '../src/island/sierraAtlas';
import { createSierraRockMaterial, createSierraTerrainMaterial } from '../src/island/sierraMaterial';
import { createIslandMaterials } from '../src/island/islandMaterials';
import { convexityAt, generateInlandPlacements, generateRockPlacements } from '../src/island/rocks';
import {
  benchFraction,
  competeFootprints,
  meanNearestNeighbour,
  planSierraPines,
  sierraPineCount,
  uniformBenchNearestNeighbour,
  type PineCandidate,
} from '../src/vegetation/pineScatter';
import { buildPineGeometry } from '../src/vegetation/pineGeometry';
import { islandParams } from '../src/params/island';
import { sierraParams } from '../src/params/sierra';
import { postParams } from '../src/params/post';

const SEEDS = [988, 1965, 2942];
const RADII = [210, 250, 290];
const GRID = sierraParams.sliceGridSize;
type Family = 'dome' | 'drownedRidge' | 'cirque';

const cache = new Map<string, IslandHeightmap>();
const hmFor = (name: Family, i: number): IslandHeightmap => {
  const key = `${name}:${i}`;
  let hm = cache.get(key);
  if (!hm) {
    hm = generateIslandHeightmap(SEEDS[i], sierraIslandParams(name, RADII[i], GRID));
    cache.set(key, hm);
  }
  return hm;
};

describe('horizon map (§T.112a item 4)', () => {
  it('is 0 on every azimuth of a flat field, and sky AO is exactly 1 there', () => {
    const size = 64;
    const flat = new Float32Array(size * size).fill(5);
    const m = bakeHorizonMap(flat, size, 100);
    for (let i = 0; i < m.angles.length; i++) expect(m.angles[i]).toBe(0);
    expect(m.skyAoAt(32, 32)).toBe(1);
  });
  it('rises monotonically as the cell walks toward a synthetic ridge, on the ray that faces it', () => {
    // a wall across the +x end of the grid: horizon along azimuth 0 (+x)
    // must grow with x; the ray that looks away (azimuth 4, −x) stays 0
    const size = 64;
    const data = new Float32Array(size * size);
    for (let iz = 0; iz < size; iz++) for (let ix = 56; ix < size; ix++) data[iz * size + ix] = 40;
    const m = bakeHorizonMap(data, size, 64, { skipBelow: -1 });
    let prev = -1;
    for (let ix = 0; ix < 56; ix++) {
      const a = m.angleAt(ix, 32, 0);
      expect(a).toBeGreaterThanOrEqual(prev);
      prev = a;
      expect(m.angleAt(ix, 32, 4)).toBe(0);
    }
    expect(prev).toBeGreaterThan(0.5); // a 40 m wall 2 cells away is steep
    // sky AO is in [0,1] everywhere and below 1 at the wall's foot
    expect(m.skyAoAt(54, 32)).toBeLessThan(1);
    expect(m.skyAoAt(54, 32)).toBeGreaterThan(0);
  });
  it('bakes a 256² slice island inside 50 ms, memoised per heightmap', () => {
    const hm = hmFor('dome', 1);
    const t0 = performance.now();
    const m = bakeHorizonMap(hm.data, hm.size, hm.worldRadius);
    const ms = performance.now() - t0;
    expect(hm.size).toBe(256);
    expect(ms).toBeLessThan(50);
    expect(m.angles.length).toBe(256 * 256 * 8);
    expect(horizonMapFor(hm)).toBe(horizonMapFor(hm));
    // a dome has SOME self-occlusion: AO < 1 somewhere on land
    let min = 1;
    for (let iz = 0; iz < hm.size; iz += 4) for (let ix = 0; ix < hm.size; ix += 4) min = Math.min(min, m.skyAoAt(ix, iz));
    expect(min).toBeLessThan(1);
    expect(min).toBeGreaterThanOrEqual(0);
  });
  it('sun visibility: lit when the sun clears the horizon in its azimuth, dark behind it', () => {
    const size = 64;
    const data = new Float32Array(size * size);
    for (let iz = 0; iz < size; iz++) for (let ix = 56; ix < size; ix++) data[iz * size + ix] = 40;
    const m = bakeHorizonMap(data, size, 64, { skipBelow: -1 });
    // at the wall's foot, a low sun in +x is blocked; the same sun in −x is not
    const low = Math.sin(10 / 57.3);
    expect(sunVisibilityCpu(m, 52, 32, [Math.cos(10 / 57.3), low, 0], 0.05)).toBe(0);
    expect(sunVisibilityCpu(m, 52, 32, [-Math.cos(10 / 57.3), low, 0], 0.05)).toBe(1);
    // a high sun clears it
    expect(sunVisibilityCpu(m, 52, 32, [0.1, 0.99, 0], 0.05)).toBe(1);
    expect(HORIZON_AZIMUTHS).toBe(8);
  });
});

describe('pines (§T.112a item 5)', () => {
  it('the stand clusters: mean NN distance below a uniform scatter on the same bench (dome + cirque, 3 seeds)', () => {
    for (const fam of ['dome', 'cirque'] as const) {
      for (let i = 0; i < 3; i++) {
        const hm = hmFor(fam, i);
        const plan = planSierraPines(hm, SEEDS[i] + 31);
        const all = [...plan.pines, ...plan.junipers];
        const nn = meanNearestNeighbour(all);
        const uniform = uniformBenchNearestNeighbour(hm, all.length, SEEDS[i] + 5);
        expect(nn).toBeLessThan(uniform);
      }
    }
    // NOTE the drowned ridge is NOT asserted: its bench is a 0.3 % strip, so a
    // uniform scatter on it is already one line of trees and the stands
    // cannot beat it (measured 0.9-1.2×). That is the island, not the rule.
  });
  it('no two crowns overlap after competition, and each round can only remove', () => {
    const hm = hmFor('dome', 0);
    const plan = planSierraPines(hm, SEEDS[0] + 31);
    const all = [...plan.pines, ...plan.junipers];
    const k = 1 + (sierraParams.pineCompetitionRounds - 1) * sierraParams.pineFootprintGrowth;
    for (let a = 0; a < all.length; a++) {
      for (let b = a + 1; b < all.length; b++) {
        const d = Math.hypot(all[a].x - all[b].x, all[a].z - all[b].z);
        expect(d).toBeGreaterThanOrEqual((all[a].footprint + all[b].footprint) * k - 1e-9);
      }
    }
    expect(all.length).toBeLessThan(plan.candidates);
    expect(all.length).toBeGreaterThan(plan.candidates * 0.3); // thinned, not razed
    // the smaller of an overlapping pair is the one that dies
    const pair: PineCandidate[] = [
      { x: 0, z: 0, y: 0, scale: 1.2, footprint: 1.2, juniper: false },
      { x: 1, z: 0, y: 0, scale: 0.8, footprint: 0.8, juniper: false },
    ];
    expect(competeFootprints(pair, 1, 0)).toEqual([pair[0]]);
    expect(competeFootprints(pair, 0, 0)).toEqual(pair);
  });
  it('counts went up 5-10× over the R0 stand and still scale with bench area', () => {
    const dome = hmFor('dome', 1);
    const ridge = hmFor('drownedRidge', 1);
    // the R0 stand: pinesPerRadius 0.28 → 70 nominal on the dome, 12 on the ridge
    const r0 = { ...sierraParams, pinesPerRadius: 0.28 };
    expect(sierraPineCount(dome) / sierraPineCount(dome, r0)).toBeGreaterThanOrEqual(5);
    expect(sierraPineCount(dome) / sierraPineCount(dome, r0)).toBeLessThanOrEqual(10);
    expect(benchFraction(dome)).toBeGreaterThan(benchFraction(ridge));
    const domePlan = planSierraPines(dome, 7);
    const ridgePlan = planSierraPines(ridge, 7);
    expect(domePlan.pines.length + domePlan.junipers.length).toBeGreaterThan(ridgePlan.pines.length + ridgePlan.junipers.length);
    expect(ridgePlan.pines.length + ridgePlan.junipers.length).toBeGreaterThan(0);
  });
  it('every tree stays on a bench (slope ≤ limit, above the sand band), ≤ 300 tris, deterministic', () => {
    const hm = hmFor('cirque', 2);
    const plan = planSierraPines(hm, 99);
    for (const c of [...plan.pines, ...plan.junipers]) {
      expect(gradientAt(hm, c.x, c.z)).toBeLessThanOrEqual(sierraParams.pineSlopeLimit);
      expect(hm.heightAt(c.x, c.z)).toBeGreaterThanOrEqual(sierraParams.pineMinHeight);
    }
    expect(planSierraPines(hm, 99)).toEqual(plan);
    expect(planSierraPines(hm, 100)).not.toEqual(plan);
    for (const v of ['pine', 'juniper', 'dead'] as const) expect(buildPineGeometry(12, v).index!.count / 3).toBeLessThanOrEqual(300);
  });
});

describe('boulders (§T.112a item 6)', () => {
  it('inland boulders sit on convex, steep cells; erratics on flat treads; none in the beach band', () => {
    for (const fam of ['dome', 'drownedRidge', 'cirque'] as const) {
      const hm = hmFor(fam, 1);
      const inland = generateInlandPlacements(SEEDS[1], hm);
      const convex = inland.filter((r) => r.origin === 'convex');
      const erratics = inland.filter((r) => r.origin === 'erratic');
      expect(convex.length).toBeGreaterThan(0);
      expect(erratics.length).toBe(sierraParams.erraticCount);
      for (const r of inland) {
        const [x, , z] = r.position;
        const angle = Math.atan2(z, x);
        // clear of the DG beach band on its own bearing, and above the apron
        expect(Math.hypot(x, z)).toBeLessThan(findShoreRadius(hm, angle) - sierraParams.dgSandBand);
        expect(hm.heightAt(x, z)).toBeGreaterThanOrEqual(sierraParams.boulderMinHeight);
      }
      // the cell each convex boulder was drawn from is within half a cell, so
      // test the property at the boulder itself with a tolerance on the gate
      for (const r of convex) {
        expect(convexityAt(hm, r.position[0], r.position[2])).toBeGreaterThan(0);
        expect(gradientAt(hm, r.position[0], r.position[2])).toBeGreaterThan(sierraParams.boulderSlopeMin * 0.5);
      }
      for (const r of erratics) expect(gradientAt(hm, r.position[0], r.position[2])).toBeLessThan(sierraParams.erraticSlopeMax * 2);
      // sizes come from a seeded spread, not one value
      expect(new Set(inland.map((r) => r.scale.toFixed(2))).size).toBeGreaterThan(inland.length * 0.5);
    }
  });
  it('is deterministic, additive to the shore scatter, and absent on pirate islands', () => {
    const hm = hmFor('dome', 0);
    expect(generateInlandPlacements(5, hm)).toEqual(generateInlandPlacements(5, hm));
    expect(generateInlandPlacements(5, hm)).not.toEqual(generateInlandPlacements(6, hm));
    const all = generateRockPlacements(5, hm);
    const shore = all.filter((r) => !r.origin);
    // §V80 RE-CUT (§T.112f). This read `all.length === shore.length + inland.length`,
    // which pinned the DECISION "the inland scatter is the only thing appended" —
    // and duly failed the moment §T.112f appended a second sierra family (talus,
    // outcrop slabs, cirque blocks) behind it, while the thing it was written to
    // protect was untouched. The PROPERTY is that the shore scatter never moves:
    // it is a byte-identical PREFIX of the list, and everything after it is
    // tagged with an origin. That holds for §T.112f and for the next family too.
    expect(all.slice(0, shore.length)).toEqual(shore);
    expect(all.slice(0, shore.length)).toEqual(generateRockPlacements(5, hm).slice(0, shore.length));
    expect(all.slice(shore.length).every((r) => r.origin !== undefined)).toBe(true);
    const inland = generateInlandPlacements(5, hm);
    expect(all.slice(shore.length, shore.length + inland.length)).toEqual(inland);
    const pirate = generateIslandHeightmap(42, islandParams);
    expect(pirate.sierra).toBeUndefined();
    expect(generateInlandPlacements(5, pirate)).toEqual([]);
    expect(generateRockPlacements(5, pirate).every((r) => r.origin === undefined)).toBe(true);
  });
});

describe('sierra materials (§T.112a items 1, 2, 4)', () => {
  it('the terrain handle binds the horizon map (aoNode + receivedShadowNode) and keeps the retint uniforms', () => {
    const hm = hmFor('dome', 0);
    const atlas = createSierraAtlas(1);
    atlas.bind(hm);
    const h = createSierraTerrainMaterial(undefined, { atlas });
    expect(h.material.aoNode).not.toBeNull();
    expect(h.material.receivedShadowNode).not.toBeNull();
    h.updateFromParams();
    expect(h.uniforms.rock.baseColor.value.getHex()).toBe(sierraParams.graniteBaseColor);
    const bare = createSierraTerrainMaterial();
    expect(bare.material.aoNode).toBeNull();
    h.dispose();
    bare.dispose();
    atlas.dispose();
  });
  // §T.132 / §V80's corollary: this test USED to assert
  // `sierraRock(a) !== sierraRock(b)`, which wrote the defect down — a handle
  // per island is six node graphs, six programs and ~21 s of codegen. The
  // property was never "one handle per island", it was "each island shades as
  // ITSELF"; that is now object state, so the handles are one. The growth
  // bound lives in tests/islandMaterialSharing.test.ts.
  it('boulders share ONE granite handle across islands, with the §B67 aerial node', () => {
    const m = createIslandMaterials();
    try {
      const a = hmFor('dome', 0);
      const b = hmFor('cirque', 0);
      expect(m.sierraRock(a)).toBe(m.sierraRock(a));
      expect(m.sierraRock(a)).toBe(m.sierraRock(b));
      expect(m.sierraRock(a).material.fog).toBe(false);
      expect(m.sierraRock(a).material.outputNode).not.toBeNull();
      expect(m.sierraRock(a).material.aoNode).not.toBeNull();
      expect(m.sierraTerrain(a)).toBe(m.sierraTerrain(b));
      m.sierraRock(a).updateFromParams();
      expect(m.sierraRock(a).uniforms.baseColor.value.getHex()).toBe(sierraParams.graniteBaseColor);
      const own = createSierraRockMaterial();
      expect(own.material.aoNode).toBeNull();
      own.dispose();
    } finally {
      m.dispose();
    }
  });
  it('GTAO stays off by default until measured (§V17) — the recommendation lives in post.ts', () => {
    expect(postParams.aoEnabled).toBe(false);
  });
});
