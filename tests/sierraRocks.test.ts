/**
 * §T.112f — OUTCROPS + TALUS AS GEOMETRY, as PROPERTIES (§V80).
 *
 * WHY EACH ONE MATTERS:
 * - talus: the debris channel is T112c's thermal-erosion talus thickness. If
 *   blocks can appear where the erosion put no material, the meso layer is a
 *   scatter rule wearing an erosion costume — the whole point of T112f is that
 *   the heightfield decides where the rock is.
 * - THE SORT: a talus cone graded uniformly reads as gravel poured out of a
 *   bag. Real aprons sort downslope — fines under the source cliff, the blocks
 *   that bounced furthest at the toe. Two INDEPENDENT halves are asserted:
 *   the size grows from head to foot, AND the "foot" really is lower ground
 *   than the "head" (measured on `heightAt`, i.e. against the host surface,
 *   §V71 — otherwise `apronT` could be any label at all and the size test
 *   would still pass).
 * - the walk corridor: T112b carved the route to be walkable and a boulder in
 *   the tread undoes the carve with no way around it.
 * - sheeting: §V71. The slab is positioned AGAINST the terrain material's
 *   sheeting bands, so its long axis has to resolve against that field's live
 *   shape (`sheetingDirectionCpu`), not against an authored bearing. The test
 *   therefore measures the axis of the ACTUAL transformed geometry off the
 *   ACTUAL instance matrix, not the placement's own bookkeeping.
 * - cirque blocks: the bowl is measured (uphill points away from the island
 *   centre, with a wall standing over the cell), never named — so the test can
 *   demand them on a cirque and demand their ABSENCE on a dome.
 * - pirate islands byte-identical: §T.112f, like §T.112a, is additive to the
 *   galleon world.
 * No renderer: placements, one bake, and instance matrices only.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { generateIslandHeightmap, type IslandHeightmap } from '../src/island/heightmap';
import { sierraIslandParams } from '../src/island/sierraSites';
import { terrainInfoFor } from '../src/island/terrainInfoBake';
import { decodeTerrainInfo, sampleTerrainChannel, sheetingDirectionCpu } from '../src/island/terrainInfo';
import {
  createRocks,
  generateInlandPlacements,
  generateMesoPlacements,
  generateRockPlacements,
  type RockPlacement,
} from '../src/island/rocks';
import { islandParams } from '../src/params/island';
import { sierraParams } from '../src/params/sierra';

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
const meso = (name: Family, i: number): RockPlacement[] => generateMesoPlacements(SEEDS[i], hmFor(name, i));
const of = (rocks: RockPlacement[], origin: string): RockPlacement[] => rocks.filter((r) => r.origin === origin);
const median = (v: number[]): number => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
/** debris cells above the talus gate — the "apron area" the counts must follow */
const debrisArea = (hm: IslandHeightmap): number => {
  const info = terrainInfoFor(hm);
  let n = 0;
  for (let i = 0; i < info.size * info.size; i++) {
    if (decodeTerrainInfo.debrisMetres(info.channels.debris[i]) > sierraParams.talusDebrisMin && hm.data[i] > 0) n++;
  }
  return n;
};

describe('talus (§T.112f item 1)', () => {
  it('appears only where the erosion bake left debris, and its density follows the thickness', () => {
    for (const fam of ['dome', 'drownedRidge', 'cirque'] as const) {
      for (let i = 0; i < 3; i++) {
        const hm = hmFor(fam, i);
        const info = terrainInfoFor(hm);
        for (const b of of(meso(fam, i), 'talus')) {
          const [x, , z] = b.position;
          const d = decodeTerrainInfo.debrisMetres(sampleTerrainChannel(info, 'debris', x, z));
          expect(d).toBeGreaterThan(sierraParams.talusDebrisMin);
        }
      }
    }
    // an island the thermal pass left bare gets NO talus, whatever its shape:
    // drownedRidge seeds 1 and 2 have 0 and 1 debris cells above the gate
    for (let i = 0; i < 3; i++) {
      const hm = hmFor('drownedRidge', i);
      if (debrisArea(hm) >= 10) continue;
      expect(of(meso('drownedRidge', i), 'talus')).toEqual([]);
    }
  });

  it('SORTS DOWNSLOPE: the blocks at the apron foot are bigger, and the foot is lower ground', () => {
    for (const fam of ['dome', 'cirque'] as const) {
      for (let i = 0; i < 3; i++) {
        const hm = hmFor(fam, i);
        const talus = of(meso(fam, i), 'talus');
        if (talus.length < 12) continue; // too thin an apron to carry a median
        const head = talus.filter((b) => b.apronT! < 0.34);
        const foot = talus.filter((b) => b.apronT! > 0.66);
        expect(head.length).toBeGreaterThan(0);
        expect(foot.length).toBeGreaterThan(0);
        // (a) the sorting law itself
        expect(median(foot.map((b) => b.scale))).toBeGreaterThan(median(head.map((b) => b.scale)));
        // (b) and "foot" is not a label: it is DOWNHILL of "head" on the host
        // surface (§V71 — the test evaluates the heightfield, not the record)
        expect(median(foot.map((b) => hm.heightAt(b.position[0], b.position[2])))).toBeLessThan(
          median(head.map((b) => hm.heightAt(b.position[0], b.position[2]))),
        );
      }
    }
  });

  it('beds INTO the apron and never leans past the angle of repose it was built at', () => {
    const repose = Math.atan(sierraParams.talusRepose);
    for (const fam of ['dome', 'cirque'] as const) {
      for (let i = 0; i < 3; i++) {
        for (const b of of(meso(fam, i), 'talus')) {
          expect(b.tilt).toBeLessThanOrEqual(repose + 1e-9);
          // the seat: the block's centre sits below its own half-height above
          // ground, i.e. more than half of it is in the apron
          const ground = hmFor(fam, i).heightAt(b.position[0], b.position[2]);
          const half = b.scale * b.squash;
          expect(b.position[1] - ground).toBeLessThan(half);
        }
      }
    }
  });

  it('counts follow the debris-covered area across the archetypes', () => {
    const rows = (['dome', 'drownedRidge', 'cirque'] as const).flatMap((fam) =>
      [0, 1, 2].map((i) => ({ area: debrisArea(hmFor(fam, i)), n: of(meso(fam, i), 'talus').length })),
    );
    const bare = rows.filter((r) => r.area < 10);
    const rich = rows.filter((r) => r.area > 400);
    expect(bare.length).toBeGreaterThan(0);
    expect(rich.length).toBeGreaterThan(0);
    expect(Math.max(...bare.map((r) => r.n))).toBe(0);
    expect(Math.min(...rich.map((r) => r.n))).toBeGreaterThan(Math.max(...bare.map((r) => r.n)));
    // and the whole set is positively ordered: no island with 3× the apron
    // area of another carries fewer blocks than it
    for (const a of rows) {
      for (const b of rows) if (a.area > b.area * 3) expect(a.n).toBeGreaterThanOrEqual(b.n);
    }
  });
});

describe('outcrop slabs (§T.112f item 2)', () => {
  it('sit only on convex, joint-dense, debris-free bedrock', () => {
    for (const fam of ['dome', 'drownedRidge', 'cirque'] as const) {
      for (let i = 0; i < 3; i++) {
        const hm = hmFor(fam, i);
        const info = terrainInfoFor(hm);
        const slabs = of(meso(fam, i), 'outcrop');
        expect(slabs.length).toBeGreaterThan(0);
        for (const s of slabs) {
          const [x, , z] = s.position;
          expect(decodeTerrainInfo.curvaturePerMetre(sampleTerrainChannel(info, 'curvature', x, z))).toBeGreaterThan(
            sierraParams.outcropCurvature,
          );
          expect(sampleTerrainChannel(info, 'joint', x, z)).toBeGreaterThan(sierraParams.outcropJoint);
          expect(decodeTerrainInfo.debrisMetres(sampleTerrainChannel(info, 'debris', x, z))).toBeLessThan(
            sierraParams.outcropDebrisMax,
          );
        }
      }
    }
  });

  it('lie ALONG the sheeting the terrain material draws — measured on the built instances (§V71)', () => {
    const hm = hmFor('dome', 1);
    const info = terrainInfoFor(hm);
    const ice = hm.sierra!.iceAzimuth;
    const rocks = createRocks({ seed: SEEDS[1], heightmap: hm });
    try {
      const slabs = of(rocks.placements, 'outcrop');
      expect(slabs.length).toBeGreaterThan(10);
      const m = new THREE.Matrix4();
      const v = new THREE.Vector3();
      let checked = 0;
      let worst = 0;
      for (const mesh of rocks.group.children as THREE.InstancedMesh[]) {
        if (mesh.name.includes('talus')) continue; // the slabs live in the shared pool
        const mine = rocks.placements.filter((pl) => pl.origin !== 'talus' && pl.variant === variantOf(mesh));
        expect(mine.length).toBe(mesh.count);
        for (let i = 0; i < mine.length; i++) {
          const pl = mine[i];
          if (pl.origin !== 'outcrop') continue;
          mesh.getMatrixAt(i, m);
          m.setPosition(0, 0, 0); // rotation + scale only; the plan axis is a direction
          const pos = mesh.geometry.getAttribute('position');
          let sxx = 0;
          let sxz = 0;
          let szz = 0;
          for (let k = 0; k < pos.count; k++) {
            v.fromBufferAttribute(pos as THREE.BufferAttribute, k).applyMatrix4(m);
            sxx += v.x * v.x;
            sxz += v.x * v.z;
            szz += v.z * v.z;
          }
          // the long axis of the geometry AS IT IS DRAWN, in island-local xz
          const longAxis = 0.5 * Math.atan2(2 * sxz, sxx - szz);
          // …which must run ACROSS ∇κ: sierraMaterial's `sheetBands` puts its
          // bands on the level sets of localXZ · sheetingDirection, so the
          // band a slab lies in is the perpendicular of that vector
          const [gx, gz] = sheetingDirectionCpu(info, pl.position[0], pl.position[2], ice);
          const band = Math.atan2(gx, -gz); // ⊥ (gx, gz), atan2(z, x) convention
          let d = Math.abs(((longAxis - band + Math.PI / 2) % Math.PI) - Math.PI / 2);
          d = Math.min(d, Math.PI - d);
          worst = Math.max(worst, d);
          expect(d).toBeLessThan(0.12); // the hinge is the band itself, so only float noise is left
          checked++;
        }
      }
      expect(checked).toBe(slabs.length);
      expect(worst).toBeGreaterThan(0); // it is a solved yaw, not a constant
    } finally {
      rocks.dispose();
    }
  });
});

/** the variant index a rock mesh was built for — `island-rocks-<v>` / `island-rocks-talus-<v>` */
function variantOf(mesh: THREE.Object3D): number {
  return Number(mesh.name.replace('island-rocks-', '').replace('talus-', ''));
}

describe('cirque wall blocks (§T.112f item 3)', () => {
  it('stand at the wall foot inside the bowl on every cirque, and nowhere on a dome or a ridge', () => {
    for (let i = 0; i < 3; i++) {
      const blocks = of(meso('cirque', i), 'cirqueBlock');
      expect(blocks.length).toBe(sierraParams.cirqueBlockCount);
      const hm = hmFor('cirque', i);
      for (const b of blocks) {
        const [x, , z] = b.position;
        const h = hm.heightAt(x, z);
        expect(h).toBeLessThanOrEqual(sierraParams.cirqueBlockMaxHeight);
        // a wall really does stand over it
        let rise = 0;
        const e = (2 * hm.worldRadius) / (hm.size - 1);
        const gx = (hm.heightAt(x + e, z) - hm.heightAt(x - e, z)) / (2 * e);
        const gz = (hm.heightAt(x, z + e) - hm.heightAt(x, z - e)) / (2 * e);
        const gl = Math.hypot(gx, gz) || 1;
        for (let s = e; s <= sierraParams.cirqueWallRun; s += e) {
          rise = Math.max(rise, hm.heightAt(x + (gx / gl) * s, z + (gz / gl) * s) - h);
        }
        expect(rise).toBeGreaterThanOrEqual(sierraParams.cirqueWallRise);
        // and the wall rises OUTWARD — that is what makes it a bowl
        const r = Math.hypot(x, z) || 1;
        expect(((gx / gl) * x + (gz / gl) * z) / r).toBeGreaterThan(sierraParams.cirqueBowlOutward);
      }
      // bigger and blockier than the talus around them
      const talus = of(meso('cirque', i), 'talus');
      if (talus.length > 0) expect(median(blocks.map((b) => b.scale))).toBeGreaterThan(median(talus.map((b) => b.scale)));
    }
    for (const fam of ['dome', 'drownedRidge'] as const) {
      for (let i = 0; i < 3; i++) expect(of(meso(fam, i), 'cirqueBlock')).toEqual([]);
    }
  });
});

describe('the walk corridor (§T.112f item 1-3, T112b)', () => {
  it('no rock of any family sits in the route or fork mask', () => {
    for (const fam of ['dome', 'drownedRidge', 'cirque'] as const) {
      for (let i = 0; i < 3; i++) {
        const hm = hmFor(fam, i);
        const path = hm.path;
        expect(path).toBeDefined();
        const cell = (2 * hm.worldRadius) / (hm.size - 1);
        const inland = [...generateInlandPlacements(SEEDS[i], hm), ...meso(fam, i)];
        expect(inland.length).toBeGreaterThan(0);
        for (const r of inland) {
          const ix = Math.min(Math.max(Math.round((r.position[0] + hm.worldRadius) / cell), 0), hm.size - 1);
          const iz = Math.min(Math.max(Math.round((r.position[2] + hm.worldRadius) / cell), 0), hm.size - 1);
          const k = iz * hm.size + ix;
          expect(path!.routeMask[k]).toBe(0);
          expect(path!.forkMask[k]).toBe(0);
        }
      }
    }
  });
});

describe('determinism + the galleon world (§V80, §T.112a)', () => {
  it('same seed → identical meso placements, different seed → different', () => {
    const hm = hmFor('cirque', 0);
    expect(generateMesoPlacements(11, hm)).toEqual(generateMesoPlacements(11, hm));
    expect(JSON.stringify(generateMesoPlacements(12, hm))).not.toEqual(JSON.stringify(generateMesoPlacements(11, hm)));
  });

  it('is absent on pirate islands, and their rock placements are byte-identical to the shore scatter', () => {
    const pirate = generateIslandHeightmap(42, islandParams);
    expect(pirate.sierra).toBeUndefined();
    expect(generateMesoPlacements(5, pirate)).toEqual([]);
    const all = generateRockPlacements(5, pirate);
    expect(all.every((r) => r.origin === undefined)).toBe(true);
    expect(all.every((r) => r.apronT === undefined && r.sheetAxis === undefined)).toBe(true);
  });

  it('keeps the meso families in the instanced batches: ≤ rockGeoVariants + talusGeoVariants draws (§V17)', () => {
    const hm = hmFor('cirque', 0);
    const rocks = createRocks({ seed: SEEDS[0], heightmap: hm });
    try {
      expect(rocks.group.children.length).toBeLessThanOrEqual(
        islandParams.rockGeoVariants + sierraParams.talusGeoVariants,
      );
      // every placement made it into exactly one batch
      const instanced = rocks.group.children as THREE.InstancedMesh[];
      expect(instanced.reduce((n, m) => n + m.count, 0)).toBe(rocks.placements.length);
      // the talus pool is cheaper per instance than the shared one
      const talusMesh = instanced.find((m) => m.name.includes('talus'))!;
      const shared = instanced.find((m) => !m.name.includes('talus'))!;
      expect(talusMesh.geometry.index!.count).toBeLessThan(shared.geometry.index!.count);
    } finally {
      rocks.dispose();
    }
  });
});
