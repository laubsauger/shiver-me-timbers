/**
 * §T.99 / §V90 Sierra archetype guards — PROPERTIES on heightmaps (§V80),
 * never decisions. WHY each matters:
 * - walkable beach: §V90's "beach band continuous from the waterline" is what
 *   lets the raft beach anywhere and the player step off onto DG sand; a
 *   shore that is a wall on some bearing is a trap the player finds first.
 * - terraces / aspect / lagoon: the three families are only worth three
 *   archetypes if each is identifiable — a dome without steps is a hill, a
 *   ridge at aspect 1 is a blob, a cirque without water inside is a crater.
 * - clue path: §V90 "∀ clue path segment slope < 35°" — the summit must be
 *   reachable from the beach on foot or the island's reason to exist (a clue
 *   on top) is unreachable.
 * - unreachable silhouette: the Half Dome is scenery; if it were inside the
 *   slice the player would sail to a 320 m wall with no beach.
 * - pirate unchanged: registering the family must be a no-op for every
 *   galleon-era island (same seed → same bytes), or §T.99 silently re-rolled
 *   the world the R1/R2 lookdev was signed on.
 * - §B67: the far island read sharp because props and terrain hazed on two
 *   different curves — see islandMaterials.ts.
 * Heightmap + geometry + node-graph construction only; no renderer.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { float, positionLocal, vec2 } from 'three/tsl';
import {
  findShoreRadius,
  generateIslandHeightmap,
  gradientAt,
  type IslandHeightmap,
} from '../src/island/heightmap';
import { createArchipelago, generateIslandSites, siteParams } from '../src/island/archipelago';
import { createIslandMaterials } from '../src/island/islandMaterials';
import { createIslandMesh } from '../src/island/islandMesh';
import {
  LAYER_NAMES,
  buildSierraSurface,
  createSierraTerrainMaterial,
  createSierraUniforms,
  sheetBandCoordCpu,
  sheetPhase,
  sierraLinear,
  sierraSurfaceCpu,
  type SierraPointCpu,
} from '../src/island/sierraMaterial';
import { sampleTerrainChannel, TerrainInfoChannels, type TerrainInfo } from '../src/island/terrainInfo';
import { terrainInfoFor } from '../src/island/terrainInfoBake';
import { coordFilter, periodResolved } from '../src/ship/bandLimit';
import { fbm2Cpu, swissTurbulence2Cpu } from '../src/terrain/noiseCpu';
import { keyLight } from '../src/sky/moonCycle';
import { hemisphereColors, skyPalette, skyTint, srgbToLinear } from '../src/sky/sunCycle';
import { skyParams } from '../src/params/sky';
import { postParams } from '../src/params/post';
import {
  SIERRA_SLICE_ARCHETYPES,
  isSierraArchetype,
  terraceSteps,
  type SierraArchetypeName,
} from '../src/island/sierraArchetypes';
import { generateSierraSites, sierraIslandParams } from '../src/island/sierraSites';
import { buildPineGeometry, PINE_ROLE } from '../src/vegetation/pineGeometry';
import { benchFraction, sierraPineCount } from '../src/vegetation/pineScatter';
import { aerialHazeFactorCpu } from '../src/terrain/aerialPerspective';
import { islandParams } from '../src/params/island';
import { oceanSurfaceParams } from '../src/params/oceanSurface';
import { sierraParams } from '../src/params/sierra';
import { getParamsEntry } from '../src/params/registry';

const SEEDS = [988, 1965, 2942];
const RADII = [210, 250, 290];
const GRID = sierraParams.sliceGridSize;
const DEG = 180 / Math.PI;
const TAN35 = Math.tan(35 / DEG);

/** the island a slice site ACTUALLY builds (§V71 — same resolution path) */
const build = (name: SierraArchetypeName, i: number): IslandHeightmap =>
  generateIslandHeightmap(SEEDS[i], sierraIslandParams(name, RADII[i], GRID));

const cache = new Map<string, IslandHeightmap>();
const hmFor = (name: SierraArchetypeName, i: number): IslandHeightmap => {
  const key = `${name}:${i}`;
  let hm = cache.get(key);
  if (!hm) {
    hm = build(name, i);
    cache.set(key, hm);
  }
  return hm;
};

const fnv = (a: Float32Array): string => {
  let h = 0x811c9dc5;
  const u = new Uint8Array(a.buffer);
  for (let i = 0; i < u.length; i++) {
    h ^= u[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
};

/**
 * Exact waterline crossing on a bearing (bisected), or null when the ray
 * from the rim to the centre never meets land — a cirque's opening, by design.
 */
function shoreCrossing(hm: IslandHeightmap, angle: number): number | null {
  const cx = Math.cos(angle);
  const sz = Math.sin(angle);
  const h = (r: number): number => hm.heightAt(cx * r, sz * r);
  let water = hm.worldRadius;
  for (let r = hm.worldRadius; r >= 0; r -= 1) {
    if (h(r) > 0) {
      let lo = r;
      let hi = water;
      for (let k = 0; k < 16; k++) {
        const mid = (lo + hi) / 2;
        if (h(mid) > 0) lo = mid;
        else hi = mid;
      }
      return (lo + hi) / 2;
    }
    water = r;
  }
  return null;
}

/** grade (deg) of the first metre of rise above the waterline on a bearing */
function beachGrade(hm: IslandHeightmap, angle: number, shore: number): number {
  const cx = Math.cos(angle);
  const sz = Math.sin(angle);
  for (let d = 0; d < 60; d += 0.25) {
    if (hm.heightAt(cx * (shore - d), sz * (shore - d)) >= 1) return Math.atan2(1, Math.max(d, 0.05)) * DEG;
  }
  return Math.atan2(1, 60) * DEG;
}

/** BFS over the grid from the beach (0 < h < 1.5 m) to the summit cell, 8-connected, slope < 35° */
function summitReachable(hm: IslandHeightmap): boolean {
  const n = hm.size;
  const cell = (2 * hm.worldRadius) / (n - 1);
  let best = -Infinity;
  let summit = 0;
  for (let i = 0; i < n * n; i++) {
    if (hm.data[i] > best) {
      best = hm.data[i];
      summit = i;
    }
  }
  const seen = new Uint8Array(n * n);
  const queue: number[] = [];
  for (let i = 0; i < n * n; i++) {
    if (hm.data[i] > 0 && hm.data[i] < 1.5) {
      seen[i] = 1;
      queue.push(i);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const i = queue[head++];
    if (i === summit) return true;
    const ix = i % n;
    const iz = (i - ix) / n;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const jx = ix + dx;
        const jz = iz + dz;
        if (jx < 0 || jz < 0 || jx >= n || jz >= n) continue;
        const j = jz * n + jx;
        if (seen[j] || hm.data[j] <= 0) continue;
        if (Math.abs(hm.data[j] - hm.data[i]) / (cell * Math.hypot(dx, dz)) >= TAN35) continue;
        seen[j] = 1;
        queue.push(j);
      }
    }
  }
  return false;
}

/** plateaus along a bearing of the terraced flank: flat runs ≥ 3 m (< 10°) separated by steeper ground */
function countPlateaus(hm: IslandHeightmap, a: number = hm.sierra!.terraceAzimuth): number {
  const cx = Math.cos(a);
  const sz = Math.sin(a);
  const shore = findShoreRadius(hm, a);
  let plateaus = 0;
  let flatRun = 0;
  let open = true;
  // the apex (r < 10 m) is the summit, not a terrace — T112b's station approach
  // ramps over it, and before that the old count was crediting it
  for (let r = shore; r > 10; r -= 1) {
    const h = hm.heightAt(cx * r, sz * r);
    if (h < sierraParams.dgSandBand) continue; // the sand band is not a terrace
    const g = gradientAt(hm, cx * r, sz * r);
    if (g < 0.18) {
      flatRun += 1;
      if (flatRun >= 3 && open) {
        plateaus++;
        open = false;
      }
    } else {
      flatRun = 0;
      if (g > 0.25) open = true;
    }
  }
  return plateaus;
}

describe('§V16 sierra params are registered for the panel', () => {
  it('registers under "sierra"', () => {
    expect(getParamsEntry('sierra')?.params).toBe(sierraParams);
  });
});

describe('§V2 determinism', () => {
  it('same seed → byte-identical grid for every sierra family', () => {
    for (const name of SIERRA_SLICE_ARCHETYPES) {
      const a = build(name, 0);
      const b = build(name, 0);
      expect(b.data).toEqual(a.data);
      expect(b.sierra).toEqual(a.sierra);
    }
  });
  it('same seed → identical site layout', () => {
    expect(generateSierraSites(1337)).toEqual(generateSierraSites(1337));
    expect(generateSierraSites(1338).sites[0].position).not.toEqual(generateSierraSites(1337).sites[0].position);
  });
});

describe('pirate archetypes unchanged by the sierra family (§T.99 is additive)', () => {
  // Captured from the tree at b36efc8, BEFORE sierraArchetypes.ts existed,
  // with the same FNV-1a over the Float32Array bytes. If the pirate pipeline
  // moves on purpose, recapture; if a SIERRA change moves these, the
  // registration leaked into the pirate draw and that is the bug.
  it('seed 42 default island and the seed-1337 showcase lagoon hash as before', () => {
    expect(fnv(generateIslandHeightmap(42, islandParams).data)).toBe('eca8d801');
    const showcase = generateIslandSites(1337)[0];
    expect(showcase.archetype).toBe('lagoon');
    expect(fnv(generateIslandHeightmap(showcase.seed, siteParams(showcase)).data)).toBe('700c3484');
  });
  it('sierra params cannot reach a pirate island', () => {
    const before = generateIslandHeightmap(42, islandParams).data;
    const saved = sierraParams.domeRelief;
    sierraParams.domeRelief = saved * 3;
    try {
      expect(generateIslandHeightmap(42, islandParams).data).toEqual(before);
    } finally {
      sierraParams.domeRelief = saved;
    }
  });
  it('sierra names are never drawn by the seed', () => {
    for (let seed = 1; seed < 40; seed++) {
      expect(isSierraArchetype(generateIslandHeightmap(seed, { ...islandParams, gridSize: 16 }).archetype)).toBe(false);
    }
  });
});

describe('§V90 beach band continuous from the waterline (DG sand, every family, 3 seeds)', () => {
  // The first metre of rise is the band the raft beaches on and the player
  // steps onto. 15° is a steep beach; anything past it reads as a bank.
  const BEACH_MAX_DEG = 15;
  for (const name of SIERRA_SLICE_ARCHETYPES) {
    for (let i = 0; i < SEEDS.length; i++) {
      it(`${name} seed ${SEEDS[i]}: every bearing that meets land meets it over sand`, () => {
        const hm = hmFor(name, i);
        let crossings = 0;
        let worst = 0;
        for (let k = 0; k < 72; k++) {
          const a = (k / 72) * Math.PI * 2;
          const shore = shoreCrossing(hm, a);
          if (shore === null) continue; // a cirque's opening: water to the centre
          crossings++;
          worst = Math.max(worst, beachGrade(hm, a, shore));
        }
        // land on most bearings: the cirque's mouth may take up to a quarter
        expect(crossings / 72).toBeGreaterThanOrEqual(0.75);
        expect(worst).toBeLessThan(BEACH_MAX_DEG);
      });
    }
  }
});

/**
 * §V90 clue path — RE-CUT for T112b. The BFS used to DISCOVER a walkable
 * beach→summit path after the fact (luck, asserted). The route is now
 * AUTHORED content: `hm.path.routes.main` runs landing → station (the summit)
 * → exit, carved at ≤ pathMainSlope. So the property is stated on the
 * authored data — the station IS the summit region, the route reaches it
 * from the beach with every 2 m of walked ground under 35° — and the BFS
 * stays as the independent cross-check that the carved grid agrees (the
 * route must be a subset of what the grid allows). tests/pathGraph.test.ts
 * owns the finer route properties (mean slope, fork, gate, occluder).
 */
describe('§V90 clue path: the AUTHORED route climbs beach → summit on foot, every 2 m < 35°', () => {
  for (const name of SIERRA_SLICE_ARCHETYPES) {
    for (let i = 0; i < SEEDS.length; i++) {
      it(`${name} seed ${SEEDS[i]} on the ${GRID}² grid`, () => {
        const hm = hmFor(name, i);
        expect(hm.path, 'a slice island publishes its route').toBeDefined();
        const main = hm.path!.routes.main;
        const station = hm.path!.pois.find((q) => q.kind === 'station')!;
        const landing = hm.path!.pois.find((q) => q.kind === 'landing')!;
        // from the beach (landing under the DG band) to the summit region
        expect(landing.y).toBeGreaterThan(0);
        expect(landing.y).toBeLessThan(sierraParams.dgSandBand);
        let peak = -Infinity;
        for (let k = 0; k < hm.data.length; k++) peak = Math.max(peak, hm.data[k]);
        expect(station.y, 'the station stands on the summit').toBeGreaterThan(peak - 8);
        // every 2 m of walked ground under 35°
        let a = 0;
        let run = 0;
        let worst = 0;
        for (let b = 1; b < main.length; b++) {
          run += Math.hypot(main[b][0] - main[b - 1][0], main[b][2] - main[b - 1][2]);
          if (run < 2) continue;
          worst = Math.max(worst, Math.abs(main[b][1] - main[a][1]) / run);
          a = b;
          run = 0;
        }
        expect(worst, `steepest 2 m: ${(Math.atan(worst) * DEG).toFixed(1)}°`).toBeLessThan(TAN35);
        // and the grid agrees: the carved field still admits a BFS path
        expect(summitReachable(hm)).toBe(true);
      });
    }
  }
});

describe('dome: exfoliation terraces', () => {
  it('terraceSteps is monotone, identity outside its band, and flat on the treads', () => {
    let prev = -Infinity;
    for (let h = -5; h < 40; h += 0.05) {
      const v = terraceSteps(h, 10, 3, 5, 0.4);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
      if (h <= 10 || h >= 25) expect(v).toBeCloseTo(h, 9);
    }
    // the tread: the first 60% of a step stays on its floor
    expect(terraceSteps(12, 10, 3, 5, 0.4)).toBeCloseTo(10, 9);
    expect(terraceSteps(17, 10, 3, 5, 0.4)).toBeCloseTo(15, 9);
  });
  for (let i = 0; i < SEEDS.length; i++) {
    it(`seed ${SEEDS[i]}: ≥ 2 plateaus on the terraced flank, off the trail`, () => {
      const hm = hmFor('dome', i);
      expect(hm.sierra?.name).toBe('dome');
      // RE-CUT for T112b (§V80): the old test scanned the ONE bearing of the
      // terrace azimuth, and the authored route climbs the terraced flank
      // because it is the gentlest — with the occluder crest/saddle across it
      // 50 m under the summit, that one line lost a plateau. The property is
      // "the flank has terraces": the BEST bearing inside the terraced sector
      // still reads ≥ 2 plateaus beyond the apex.
      // (a trail can only remove plateaus, so no bearing is skipped)
      const az = hm.sierra!.terraceAzimuth;
      const half = sierraParams.domeTerraceSector * 0.6;
      let best = 0;
      for (let k = -6; k <= 6; k++) best = Math.max(best, countPlateaus(hm, az + (k / 6) * half));
      expect(best).toBeGreaterThanOrEqual(2);
    });
  }
});

describe('drowned ridge: long, narrow, and going under to leeward', () => {
  for (let i = 0; i < SEEDS.length; i++) {
    it(`seed ${SEEDS[i]}: land aspect > 2.5 along the seeded axis`, () => {
      const hm = hmFor('drownedRidge', i);
      const a = hm.sierra!.axis;
      const ax = Math.cos(a);
      const az = Math.sin(a);
      const n = hm.size;
      const cell = (2 * hm.worldRadius) / (n - 1);
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (let iz = 0; iz < n; iz++) {
        for (let ix = 0; ix < n; ix++) {
          if (hm.data[iz * n + ix] <= 0) continue;
          const x = -hm.worldRadius + ix * cell;
          const z = -hm.worldRadius + iz * cell;
          const u = x * ax + z * az;
          const v = -x * az + z * ax;
          minU = Math.min(minU, u); maxU = Math.max(maxU, u);
          minV = Math.min(minV, v); maxV = Math.max(maxV, v);
        }
      }
      expect((maxU - minU) / (maxV - minV)).toBeGreaterThan(2.5);
    });
    it(`seed ${SEEDS[i]}: ≥ 5 treeline markers, each standing in water, in a line to leeward`, () => {
      const hm = hmFor('drownedRidge', i);
      const markers = hm.sierra!.treeline;
      expect(markers.length).toBeGreaterThanOrEqual(5);
      const a = hm.sierra!.axis;
      for (const m of markers) {
        expect(m.floor).toBeLessThan(0);
        expect(hm.heightAt(m.x, m.z)).toBe(m.floor);
        // a dead pine's top must clear the water
        expect(-m.floor).toBeLessThan(sierraParams.deadPineHeight * 0.85);
        // leeward: on the positive side of the axis
        expect(m.x * Math.cos(a) + m.z * Math.sin(a)).toBeGreaterThan(0);
      }
    });
  }
});

describe('cirque: a still lagoon inside a half-ring', () => {
  for (let i = 0; i < SEEDS.length; i++) {
    it(`seed ${SEEDS[i]}: ≥ 60% of the interior within [−3, 0] m, enclosed on ≥ 180° of bearings`, () => {
      const hm = hmFor('cirque', i);
      expect(hm.lagoonCenter).not.toBeNull();
      const [cx, cz] = hm.lagoonCenter!;
      const rad = sierraParams.cirqueLagoonRadius * hm.worldRadius;
      let inBand = 0;
      const total = 400;
      for (let k = 0; k < total; k++) {
        const a = k * 2.399963;
        const r = Math.sqrt(k / total) * rad * 0.8;
        const h = hm.heightAt(cx + Math.cos(a) * r, cz + Math.sin(a) * r);
        if (h <= 0 && h >= -3) inBand++;
      }
      expect(inBand / total).toBeGreaterThanOrEqual(0.6);
      let enclosed = 0;
      for (let k = 0; k < 72; k++) {
        const a = (k / 72) * Math.PI * 2;
        for (let r = rad; r < hm.worldRadius; r += 2) {
          const x = cx + Math.cos(a) * r;
          const z = cz + Math.sin(a) * r;
          if (Math.hypot(x, z) > hm.worldRadius) break;
          if (hm.heightAt(x, z) > 0) {
            enclosed++;
            break;
          }
        }
      }
      expect((enclosed / 72) * 360).toBeGreaterThanOrEqual(180);
    });
  }
});

describe('generateSierraSites: the slice', () => {
  const seeds = [1337, 7, 2026];
  for (const seed of seeds) {
    it(`seed ${seed}: 3 slice islands, one per family, 500–700 m apart, clear of the start`, () => {
      const { sites, start } = generateSierraSites(seed);
      const slice = sites.slice(0, sierraParams.sliceCount);
      expect(new Set(slice.map((s) => s.archetype))).toEqual(new Set(SIERRA_SLICE_ARCHETYPES));
      for (let a = 0; a < slice.length; a++) {
        expect(slice[a].overrides?.gridSize).toBe(256);
        expect(slice[a].unreachable).toBeUndefined();
        const d0 = Math.hypot(slice[a].position[0] - start.x, slice[a].position[1] - start.z);
        expect(d0 - slice[a].radius).toBeGreaterThanOrEqual(400);
        expect(slice[a].radius).toBeGreaterThanOrEqual(150);
        expect(slice[a].radius).toBeLessThanOrEqual(300);
        for (let b = a + 1; b < slice.length; b++) {
          const d = Math.hypot(
            slice[a].position[0] - slice[b].position[0],
            slice[a].position[1] - slice[b].position[1],
          );
          expect(d).toBeGreaterThanOrEqual(500);
          expect(d).toBeLessThanOrEqual(700);
          expect(d).toBeGreaterThan(slice[a].radius + slice[b].radius); // open water between
        }
      }
    });
    it(`seed ${seed}: exactly one unreachable Half Dome, ≥ 1.5× the furthest station, 128² grid`, () => {
      const { sites, start } = generateSierraSites(seed);
      const unreachable = sites.filter((s) => s.unreachable);
      expect(unreachable).toHaveLength(1);
      const dome = unreachable[0];
      expect(dome.archetype).toBe('halfDome');
      expect(dome.overrides?.gridSize).toBe(128);
      let furthest = 0;
      for (const s of sites) {
        if (s.unreachable) continue;
        furthest = Math.max(furthest, Math.hypot(s.position[0] - start.x, s.position[1] - start.z));
      }
      expect(Math.hypot(dome.position[0] - start.x, dome.position[1] - start.z)).toBeGreaterThanOrEqual(1.5 * furthest);
      // and it really is a silhouette: one sheared face, tall
      const hm = generateIslandHeightmap(dome.seed, siteParams(dome));
      let max = -Infinity;
      for (const v of hm.data) max = Math.max(max, v);
      expect(max).toBeGreaterThanOrEqual(sierraParams.halfDomePeak * 0.8);
      expect(hm.sierra?.name).toBe('halfDome');
    });
  }
  it('builds through createArchipelago GPU-free, with pines instead of palms and a dead treeline', () => {
    const world = generateSierraSites(1337);
    const arch = createArchipelago({ seed: 1337, sites: world.sites });
    try {
      expect(arch.islands).toHaveLength(world.sites.length);
      for (const island of arch.islands) {
        expect(isSierraArchetype(island.heightmap.archetype)).toBe(true);
        expect(island.palms.mesh.name).toBe('island-pines');
        // every island renders with ITS granite handle, not the pirate one —
        // re-cut for §T.112a: the handle is per heightmap (it binds the
        // island's horizon map), so the pin is "the one for this heightmap"
        // and "never the pirate handle", not "one object world-wide" (§V80)
        expect(island.terrain.material).toBe(arch.materials.sierraTerrain(island.heightmap));
        expect(island.terrain.material).not.toBe(arch.materials.terrain);
        if (island.heightmap.sierra?.name === 'drownedRidge') {
          const dead = island.palms.mesh.children.find((c) => c.name === 'island-dead-pines');
          expect(dead).toBeDefined();
          expect((dead as THREE_InstancedMeshLike).count).toBe(island.heightmap.sierra.treeline.length);
        }
      }
    } finally {
      arch.dispose();
    }
  });
});

type THREE_InstancedMeshLike = { count: number };

/**
 * §T.125 — `raft.html?at=dome` HAD TO BE A HAND-POSE. `createArchipelago`
 * minted an anchorage only when `sites[0].archetype === 'lagoon'`, the slice
 * forces its own families, so the sierra world's jump list was `['spawn']`
 * and every R3 island frame was shot by writing the raft's position and
 * pinning `followCam.setDebugPose()` (docs/raft2100/lookdev/R3/README.md).
 * The old test asserted `anchorages).toHaveLength(0)` — §V80's corollary
 * exactly: it wrote the defect down and then enforced it.
 *
 * The PROPERTY, not the list: every island you can land on has a berth, that
 * berth is off ITS OWN landing, and it is water she floats in. Names are
 * asserted as a set because `?at=` needs them, not because the order matters.
 */
describe('§T.125 every routed island has an anchorage off its landing', () => {
  for (const seed of [1337, 991]) {
    it(`seed ${seed}: one berth per slice island, at its landing, afloat`, () => {
      const world = generateSierraSites(seed);
      const arch = createArchipelago({ seed, sites: world.sites });
      try {
        const routed = arch.islands.filter((i) => i.heightmap.path !== undefined);
        // the route is what makes an island landable: fillers are under
        // `pathMinRadius` and the Half Dome is scenery (§V90)
        expect(routed).toHaveLength(sierraParams.sliceCount);
        expect(new Set(arch.anchorages.map((a) => a.name))).toEqual(
          new Set(SIERRA_SLICE_ARCHETYPES),
        );
        for (const a of arch.anchorages) {
          const island = arch.islands.find((i) => i.heightmap.archetype === a.name)!;
          const landing = island.heightmap.path!.pois.find((q) => q.kind === 'landing')!;
          const lx = island.center[0] + landing.x;
          const lz = island.center[1] + landing.z;
          // she lies OFF THE BEACH SHE LANDS ON — a berth 200 m round the
          // coast is a different island as far as the player is concerned
          expect(Math.hypot(a.x - lx, a.z - lz)).toBeLessThanOrEqual(25);
          // …and she is afloat there. `depth` is what the solver measured;
          // the seabed is asked again so the two cannot drift apart.
          expect(a.depth).toBeGreaterThanOrEqual(1.5);
          expect(arch.seabed.heightAt(a.x, a.z)).toBeLessThan(0);
          // bow at the beach: forward is [sin h, cos h] (showcase.ts)
          const toLanding = Math.hypot(lx - a.x, lz - a.z);
          const dot = (Math.sin(a.heading) * (lx - a.x) + Math.cos(a.heading) * (lz - a.z)) / toLanding;
          expect(dot).toBeGreaterThan(0.99);
          // the berth belongs to its own island, not to a neighbour it drifted to
          let nearest = arch.islands[0];
          let best = Infinity;
          for (const i of arch.islands) {
            const d = Math.hypot(a.x - i.center[0], a.z - i.center[1]);
            if (d < best) {
              best = d;
              nearest = i;
            }
          }
          expect(nearest.heightmap.archetype).toBe(a.name);
        }
        // nothing for the islets or the silhouette
        expect(arch.anchorages).toHaveLength(sierraParams.sliceCount);
      } finally {
        arch.dispose();
      }
    });
  }

  it('the unreachable Half Dome is never a destination, even if it were routed', () => {
    // §V90: nothing routes to it. The guard is `site.unreachable`, so it holds
    // whatever the path carve decides to do with a 480 m island later.
    const world = generateSierraSites(1337);
    const arch = createArchipelago({ seed: 1337, sites: world.sites });
    try {
      const dome = world.sites.findIndex((s) => s.unreachable);
      expect(dome).toBeGreaterThanOrEqual(0);
      const [cx, cz] = arch.islands[dome].center;
      for (const a of arch.anchorages) {
        expect(Math.hypot(a.x - cx, a.z - cz)).toBeGreaterThan(arch.islands[dome].heightmap.worldRadius);
      }
    } finally {
      arch.dispose();
    }
  });

  it('the pirate world still gets its lagoon berth, and only that one', () => {
    // the slice's anchorages are ADDITIVE: the showcase lagoon is a galleon
    // berth in 7+ m solved against the basin, and it must not have been
    // replaced by a raft-sized one at some beach
    const arch = createArchipelago({ seed: 1337 });
    try {
      expect(arch.anchorages.map((a) => a.name)).toEqual(['lagoon']);
      expect(arch.anchorages[0].depth).toBeGreaterThanOrEqual(7);
    } finally {
      arch.dispose();
    }
  });
});

describe('pines: benches, budget, wind contract', () => {
  it('every variant stays ≤ 300 triangles and bakes the wind attributes', () => {
    for (const variant of ['pine', 'juniper', 'dead'] as const) {
      const g = buildPineGeometry(12, variant);
      expect(g.index!.count / 3).toBeLessThanOrEqual(300);
      const wind = g.getAttribute('windWeight').array as Float32Array;
      const pos = g.getAttribute('position').array as Float32Array;
      let base = Infinity;
      let top = -Infinity;
      for (let i = 0; i < wind.length; i++) {
        if (pos[i * 3 + 1] < 0.01) base = Math.min(base, wind[i]);
        top = Math.max(top, wind[i]);
      }
      expect(base).toBe(0); // trunk feet stay planted
      expect(top).toBeGreaterThan(0.9); // tips ride the sway amplitude
      const roles = new Set(Array.from(g.getAttribute('role').array as Float32Array));
      if (variant === 'dead') expect(roles).toEqual(new Set([PINE_ROLE.deadWood]));
      if (variant === 'pine') expect(roles).toEqual(new Set([PINE_ROLE.trunk, PINE_ROLE.needles]));
      if (variant === 'juniper') expect(roles).toEqual(new Set([PINE_ROLE.trunk, PINE_ROLE.juniper]));
    }
    expect(buildPineGeometry(12, 'pine').getAttribute('position').array).toEqual(
      buildPineGeometry(12, 'pine').getAttribute('position').array,
    );
  });
  it('the stand scales with the bench area, so a steep island thins rather than throws', () => {
    const dome = hmFor('dome', 1);
    const ridge = hmFor('drownedRidge', 1);
    expect(benchFraction(dome)).toBeGreaterThan(benchFraction(ridge));
    expect(sierraPineCount(dome)).toBeGreaterThan(sierraPineCount(ridge));
    expect(sierraPineCount(dome)).toBeGreaterThan(0);
  });
});

describe('sierra material: granite on the shared blend, by family', () => {
  it('keeps the granite tones after the base re-reads the pirate palette', () => {
    const h = createSierraTerrainMaterial();
    h.updateFromParams();
    expect(h.uniforms.rock.baseColor.value.getHex()).toBe(sierraParams.graniteBaseColor);
    expect(h.uniforms.sand.baseColor.value.getHex()).toBe(sierraParams.dgSandColor);
    expect(h.material.fog).toBe(false);
    expect(h.material.outputNode).not.toBeNull();
    h.dispose();
  });
});

describe('§B67: far-LOD island skipped the haze — root cause and fix', () => {
  it('cause: the terrain reads the OCEAN haze curve, which is ~2% at 1.5 km, while the lookdev dragged scene fog to 100% there', () => {
    const p = oceanSurfaceParams;
    const terrainAt1500 = aerialHazeFactorCpu(1500, p.hazeStart, p.hazeEnd, p.hazeCurve, p.hazeStrength);
    expect(terrainAt1500).toBeLessThan(0.05);
    // R0's dawn frame: sky.fogNear/fogFar 150/1400 — linear scene fog
    const sceneFogAt1500 = Math.min(Math.max((1500 - 150) / (1400 - 150), 0), 1);
    expect(sceneFogAt1500).toBe(1);
    // at the lagoon island (0.75 km) the props were half-fogged on unhazed terrain
    const sceneFogAt750 = (750 - 150) / (1400 - 150);
    expect(sceneFogAt750).toBeGreaterThan(0.4);
    expect(aerialHazeFactorCpu(750, p.hazeStart, p.hazeEnd, p.hazeCurve, p.hazeStrength)).toBe(0);
  });
  it('not the LOD: both tessellation levels are one mesh with one material', () => {
    const hm = generateIslandHeightmap(42, { ...islandParams, gridSize: 32 });
    const handle = createIslandMesh(hm);
    const material = handle.mesh.material;
    handle.setLod(1);
    expect(handle.lod).toBe(1);
    expect(handle.mesh.material).toBe(material);
    expect(handle.material.material.fog).toBe(false);
    handle.dispose();
  });
  it('fix: every island prop melts on the terrain\'s own aerial node, never on scene fog', () => {
    const m = createIslandMaterials();
    try {
      const props = [m.rock.material, m.palm.material, m.cover.material, m.structure.material, m.pines().pine.material];
      for (const mat of props) {
        expect(mat.fog).toBe(false);
        expect(mat.outputNode).not.toBeNull();
      }
      expect(m.terrain.material.fog).toBe(false);
      expect(m.sierraTerrain().material.fog).toBe(false);
    } finally {
      m.dispose();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// §T.122 — THE LAND SURFACE ITSELF. PROPERTIES over the CPU twin of
// `buildSierraSurface`, plus one node-TYPE assertion, all GPU-free (§V88).
//
// WHY THESE AND NOT A SCREENSHOT. The defects are R3-13 ("there is no
// granite, the islands are chartreuse") and R3-14 ("the sheeting bands are a
// rectilinear grid") in docs/raft2100/lookdev/R3/README.md — SPEC's T122 line
// cites them as "R3-1", which is the plank material, a different entry.
// R3 shot every landmass as one flat
// chartreuse at tod 7.5/12 and one red-brown at 17.5, with talus the same hue
// as the ground. Three different things can produce that picture and only one
// of them was true, so each is now a separate assertion that fails on its own:
//
//   1. ONE LAYER WINS EVERYWHERE — measured, and it does not: every layer
//      claims a non-trivial share of every archetype.
//   2. THE LAYER COLOURS DO NOT SURVIVE THE TONEMAP — measured, at all three
//      hours, through the shipped key light, ACES and the grade. This is the
//      one that needs a bar, because "different hex" means nothing at
//      L 0.9 where ACES has spent the chroma headroom.
//   3. THE MASKS ARE MULTIPLIED BY SOMETHING THAT FLATTENS THEM — they were.
//      `periodResolved(vec2)` returned a VEC2, every layer weight became a
//      vec2, and three pads a vec2 into a vec3 with 0.0, so the land albedo's
//      BLUE was multiplied by zero on the terrain and the boulders alike.
//      (r, g, 0) is exactly a chartreuse that turns red-brown as the key
//      warms. `albedoIsThreeChannel` below is the regression.
//
// And the sheeting: T112d's band coordinate was `localXZ · normalize(∇κ)`, a
// dot with a PER-PIXEL direction, which is not the integral of that direction.
// Its level sets spiral and its gradient grows with radius — the whirlpool the
// plan view caught. The replacement is a genuine potential Φ, and the test
// below fails BOTH an axis-aligned lattice and T112d's own formula.
// ─────────────────────────────────────────────────────────────────────────

/** the three hours R3 shot, and the three §V94 is judged at */
const T122_HOURS = [7.5, 12, 17.5];

/**
 * The bar, in OKLab ΔE, for "these two read apart". OKLab's JND over a large
 * flat field is ~0.02; 0.045 is a bit over twice that, which is where a
 * hillside stops being one colour and starts being two materials. Measured
 * floor across all 28 pairs × 3 hours with the shipped palette: 0.0498
 * (polished~fresh at noon). Raising this bar is a look decision, not a fix.
 */
const T122_SEPARATION = 0.045;

// ── the display chain, transliterated (§V80): key + hemisphere ambient,
//    ACES at the shipped exposure, then the grade. An albedo pair that is
//    far apart in linear RGB and 0.01 apart AFTER this is the defect.
const T122_ACES_IN = [[0.59719, 0.35458, 0.04823], [0.076, 0.90834, 0.01566], [0.0284, 0.13383, 0.83777]];
const T122_ACES_OUT = [[1.60475, -0.53108, -0.07367], [-0.10208, 1.10813, -0.00605], [-0.00327, -0.07276, 1.07602]];
type Rgb = [number, number, number];
const t122Mul = (m: number[][], v: Rgb): Rgb => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];
function t122Aces(c: Rgb, exposure: number): Rgb {
  const rrt = (v: number): number =>
    (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
  let v = t122Mul(T122_ACES_IN, [c[0] * (exposure / 0.6), c[1] * (exposure / 0.6), c[2] * (exposure / 0.6)]);
  v = t122Mul(T122_ACES_OUT, [rrt(v[0]), rrt(v[1]), rrt(v[2])]);
  return v.map((x) => Math.min(1, Math.max(0, x))) as Rgb;
}
/** linear albedo + geometric normal + hour → what the pixel actually shows */
function t122Display(albedo: Rgb, n: Rgb, tod: number): Rgb {
  const key = keyLight(tod, skyParams);
  const kc = key.color.map(srgbToLinear) as Rgb;
  const ndl = Math.max(0, n[0] * key.direction[0] + n[1] * key.direction[1] + n[2] * key.direction[2]);
  const pal = skyPalette(key.sunElevation, skyParams);
  const hc = hemisphereColors(pal.mid, pal.ground, skyTint(key.sunElevation, key.moonWeight), skyParams.ambientDesaturation);
  const hw = 0.5 * n[1] + 0.5;
  const hi = skyParams.ambientIntensity * key.ambient;
  const lit = [0, 1, 2].map(
    (i) => (albedo[i] * (kc[i] * key.intensity * ndl + (hc.ground[i] + (hc.sky[i] - hc.ground[i]) * hw) * hi)) / Math.PI,
  ) as Rgb;
  const out = t122Aces(lit, skyParams.exposure);
  if (!postParams.vibranceEnabled) return out;
  const mx = Math.max(out[0], out[1], out[2]);
  return out.map((v) => Math.min(1, Math.max(0, mx + (v - mx) * (1 + postParams.vibrance)))) as Rgb;
}
function t122Oklab(c: Rgb): Rgb {
  const l = Math.cbrt(0.4122214708 * c[0] + 0.5363325363 * c[1] + 0.0514459929 * c[2]);
  const m = Math.cbrt(0.2119034982 * c[0] + 0.6806995451 * c[1] + 0.1073969566 * c[2]);
  const s = Math.cbrt(0.0883024619 * c[0] + 0.2817188376 * c[1] + 0.6299787005 * c[2]);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
const t122DE = (a: Rgb, b: Rgb): number => {
  const [x, y] = [t122Oklab(a), t122Oklab(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
};

// ── the surface, sampled over a real island through the shipped CPU twin ──
const T122_UP: Rgb = [0, 1, 0];
const t122InfoCache = new Map<string, TerrainInfo>();
function t122Info(name: SierraArchetypeName, i: number): TerrainInfo {
  const key = `${name}:${i}`;
  let info = t122InfoCache.get(key);
  if (!info) {
    info = terrainInfoFor(hmFor(name, i));
    t122InfoCache.set(key, info);
  }
  return info;
}
function t122Normal(hm: IslandHeightmap, x: number, z: number): Rgb {
  const e = (2 * hm.worldRadius) / (hm.size - 1);
  const dx = (hm.heightAt(x + e, z) - hm.heightAt(x - e, z)) / (2 * e);
  const dz = (hm.heightAt(x, z + e) - hm.heightAt(x, z - e)) / (2 * e);
  const l = Math.hypot(dx, 1, dz);
  return [-dx / l, 1 / l, -dz / l];
}
/** everything `sierraSurfaceCpu` needs at one island-local point */
function t122Point(name: SierraArchetypeName, i: number, x: number, z: number, fresh: number): SierraPointCpu {
  const hm = hmFor(name, i);
  const info = t122Info(name, i);
  const enc = TerrainInfoChannels.encode;
  const p = sierraParams;
  return {
    local: [x, z],
    world: [x, z],
    height: hm.heightAt(x, z),
    normal: t122Normal(hm, x, z),
    curvature: (sampleTerrainChannel(info, 'curvature', x, z) - 0.5) * 2 * enc.curvatureRangePerMetre,
    moisture: sampleTerrainChannel(info, 'moisture', x, z),
    pathDistance: sampleTerrainChannel(info, 'pathDistance', x, z) * enc.pathDistanceMetres,
    debris: sampleTerrainChannel(info, 'debris', x, z) * enc.debrisMetres,
    skyAO: sampleTerrainChannel(info, 'skyAO', x, z),
    jointDensity: swissTurbulence2Cpu(x * p.jointScale + info.jointNoiseOffset[0], z * p.jointScale + info.jointNoiseOffset[1], 3),
    macro: fbm2Cpu(x * p.coverMacroScale, z * p.coverMacroScale, 2),
    grain: fbm2Cpu(x * p.coverGrainScale, z * p.coverGrainScale, 2),
    lichenField: fbm2Cpu(x * p.lichenScale, z * p.lichenScale, 3),
    iceAzimuth: hm.sierra?.iceAzimuth ?? 0,
    fresh,
  };
}
interface T122Cell { n: Rgb; ground: ReturnType<typeof sierraSurfaceCpu>; block: ReturnType<typeof sierraSurfaceCpu> }
const t122SweepCache = new Map<string, T122Cell[]>();
function t122Sweep(name: SierraArchetypeName, i: number): T122Cell[] {
  const key = `${name}:${i}`;
  let cells = t122SweepCache.get(key);
  if (!cells) {
    const hm = hmFor(name, i);
    const R = hm.worldRadius;
    cells = [];
    for (let z = -R; z <= R; z += 8)
      for (let x = -R; x <= R; x += 8) {
        if (hm.heightAt(x, z) < 1.2) continue; // sea and the sand skirt are the base material's
        cells.push({
          n: t122Point(name, i, x, z, 0).normal,
          ground: sierraSurfaceCpu(t122Point(name, i, x, z, 0)),
          block: sierraSurfaceCpu(t122Point(name, i, x, z, 1)),
        });
      }
    t122SweepCache.set(key, cells);
  }
  return cells;
}
const T122_FAMILIES: SierraArchetypeName[] = ['dome', 'drownedRidge', 'cirque'];

describe('§T.122 the land is a stack of materials, not one colour', () => {
  it('every layer claims a non-trivial share of every archetype', () => {
    // R3-1's first candidate cause: one layer wins the whole island. A layer
    // that never wins anywhere is a layer the palette work below cannot help,
    // and a mask threshold that has drifted off the terrain's actual range.
    const rows: string[] = [];
    for (const family of T122_FAMILIES) {
      const cells = t122Sweep(family, 1);
      expect(cells.length).toBeGreaterThan(250);
      const wins = LAYER_NAMES.map(() => 0);
      for (const c of cells) wins[c.ground.winner]++;
      rows.push(
        `  ${family.padEnd(13)} ` +
          LAYER_NAMES.map((n, k) => `${n} ${((100 * wins[k]) / cells.length).toFixed(1)}%`).join('  ') +
          `  (n=${cells.length})`,
      );
      for (let k = 0; k < LAYER_NAMES.length; k++) {
        // 3%: below that a layer is a speckle, not a material you can see
        expect.soft(wins[k] / cells.length, `${family} ${LAYER_NAMES[k]}`).toBeGreaterThan(0.03);
      }
    }
    console.log('§T.122 layer win fractions:\n' + rows.join('\n'));
  });

  it('the layer colours read APART after the key light, ACES and the grade — at 7.5, 12 and 17.5', () => {
    // The bar has to be measured HERE, not on the hex values: the shipped
    // exposure puts bare granite near L 0.65 at noon and ACES leaves almost no
    // chroma headroom above that, so two hexes that look distinct in a picker
    // can land 0.01 apart on screen. At 17.5 the key is deep orange and the
    // whole palette collapses toward one dark red-brown — that hour is the
    // binding constraint on every pair below.
    const swatches: Record<string, number> = {
      granite: sierraParams.graniteBaseColor,
      polished: sierraParams.polishedColor,
      fractured: sierraParams.fracturedColor,
      grus: sierraParams.grusColor,
      litter: sierraParams.litterColor,
      lichen: sierraParams.lichenColor,
      path: sierraParams.pathWornColor,
      fresh: sierraParams.rockFreshTint,
    };
    const names = Object.keys(swatches);
    let floor = Infinity;
    let floorAt = '';
    for (const tod of T122_HOURS) {
      const shown: Record<string, Rgb> = {};
      for (const k of names) shown[k] = t122Display(sierraLinear(swatches[k]), T122_UP, tod);
      for (let i = 0; i < names.length; i++)
        for (let j = i + 1; j < names.length; j++) {
          const d = t122DE(shown[names[i]], shown[names[j]]);
          expect.soft(d, `${names[i]}~${names[j]} @ tod ${tod}`).toBeGreaterThan(T122_SEPARATION);
          if (d < floor) {
            floor = d;
            floorAt = `${names[i]}~${names[j]} @ tod ${tod}`;
          }
        }
    }
    console.log(`§T.122 tightest layer pair after the tonemap: ${floorAt} = ${floor.toFixed(4)} (bar ${T122_SEPARATION})`);
  });

  it('a fallen block never shades as the ground it is lying on', () => {
    // T112f put real talus and real outcrops on these islands, and R3 could
    // not see any of it: the boulders shade through the SAME surface function
    // at the SAME island-local point, so they were carrying the ground's grus,
    // litter and lichen and came out as blisters of the terrain. `fresh`
    // strips the cover, thins the lichen a young face has not grown, and lifts
    // the block toward a fracture tint. If this fails, T112f's geometry is
    // invisible again and that whole task is wasted.
    const rows: string[] = [];
    for (const family of T122_FAMILIES) {
      const cells = t122Sweep(family, 1);
      for (const tod of T122_HOURS) {
        const ds = cells
          .map((c) => t122DE(t122Display(c.block.albedo, c.n, tod), t122Display(c.ground.albedo, c.n, tod)))
          .sort((a, b) => a - b);
        const median = ds[Math.floor(ds.length / 2)];
        rows.push(`  ${family.padEnd(13)} tod ${String(tod).padStart(4)}  median ${median.toFixed(4)}  p05 ${ds[Math.floor(ds.length * 0.05)].toFixed(4)}`);
        // the MEDIAN, because the tail is honest: a fresh block on a polished
        // glacial slab is genuinely a subtle difference, and pushing that case
        // apart would mean lying about one of the two
        expect.soft(median, `${family} @ tod ${tod}`).toBeGreaterThan(0.06);
      }
    }
    console.log('§T.122 talus block vs the ground under it (OKLab dE):\n' + rows.join('\n'));
  });

  it('the land albedo is a THREE-channel colour — the vec2 that zeroed its blue', () => {
    // THE ROOT CAUSE, as a type. `coordFilter` is per-component: handed the
    // vec2 field coordinate it returns a vec2 footprint, `periodResolved`
    // hands that straight to `smoothstep`, and `mix(float, float, vec2)` takes
    // the LONGEST input's type. Every fbm field and every layer weight
    // downstream became a vec2, and `NodeBuilder.format` pads a vec2 into a
    // vec3 as `vec3(v, 0.0)` — so `layerColour.mul(weight)` multiplied the
    // whole land albedo's BLUE BY ZERO, on the terrain and the boulders both.
    // Nothing in a node-graph shape test can see that; the TYPE can.
    const renderer = new THREE.WebGPURenderer({ canvas: t122StubCanvas() });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardNodeMaterial());
    const backend = (renderer as unknown as { backend: Record<string, unknown> }).backend;
    backend.renderer = renderer;
    const builder = (
      backend as unknown as { createNodeBuilder: (o: THREE.Object3D, r: THREE.WebGPURenderer) => Record<string, unknown> }
    ).createNodeBuilder(mesh, renderer);
    builder.material = mesh.material;
    const typeOf = (n: unknown): string =>
      (n as { getNodeType(b: unknown): string }).getNodeType(builder);

    // the trap is still there in bandLimit — this is why `fieldFilter` exists
    expect(typeOf(coordFilter(vec2(1, 2)))).toBe('vec2');
    expect(typeOf(periodResolved(vec2(1, 2)))).toBe('vec2');

    const u = createSierraUniforms();
    const surface = buildSierraSurface({
      info: null,
      skyAO: float(1),
      graniteGrey: u.grusColor,
      localXZ: positionLocal.xz,
      jointOffset: vec2(0, 0),
      jointDirA: vec2(1, 0),
      jointDirB: vec2(0, 1),
      bandPhase: float(0),
      roughness: float(0.8),
      u,
    });
    // 'color' is three's own three-component type; anything of length 2 here
    // is the defect, whatever it is called
    const albedoType = typeOf(surface.albedo);
    expect((builder as unknown as { getTypeLength(t: string): number }).getTypeLength(albedoType)).toBe(3);
    expect(typeOf(surface.roughness)).toBe('float');
    expect(typeOf(surface.relief)).toBe('float');
  });

  it('the sheeting bands are contours of a potential — a lattice and T112d\'s own axis both FAIL this', () => {
    // `island-dome-plan.png` is what this replaces. Sheets peel PARALLEL to
    // the surface, so their traces are closed shells round a whaleback: from
    // the air they must read as concentric rings, and the across-band axis
    // (∇Φ) must therefore point RADIALLY everywhere on a dome.
    //
    // The two controls are the point of the test. An axis-aligned lattice
    // averages |ĝ·r̂| = 2/π ≈ 0.637 over a circle — it passed the old
    // "follows ∇κ" phrasing and it must not pass this one. T112d's own
    // coordinate, `localXZ · normalize(∇κ)`, is a dot with a PER-PIXEL
    // direction: not the integral of that direction, so its level sets spiral
    // and |∇Φ| GROWS WITH RADIUS. That growth is the second assertion, and it
    // is the whirlpool itself — at |∇Φ|·spacing = 8 the bands are 30 cm apart
    // on the ground and there is nothing a band limit can do with them.
    const H = 120;
    const R = 220;
    const CELL = 2;
    // a paraboloid whaleback, plus a low bump field so ∇κ has something to
    // wander on — a mathematically perfect dome would flatter T112d
    const dome = (x: number, z: number): number =>
      Math.max(0, H * (1 - (x * x + z * z) / (R * R))) + 3 * Math.sin(x / 28) * Math.sin(z / 28);
    const kappa = (x: number, z: number): number =>
      ((dome(x + CELL, z) + dome(x - CELL, z) + dome(x, z + CELL) + dome(x, z - CELL) - 4 * dome(x, z)) / (CELL * CELL)) * 0.5;
    const grad = (f: (x: number, z: number) => number, x: number, z: number, e: number): [number, number] => [
      (f(x + e, z) - f(x - e, z)) / (2 * e),
      (f(x, z + e) - f(x, z - e)) / (2 * e),
    ];
    const ice = 0.8;
    const phase = sheetPhase(ice);
    const shipped = (x: number, z: number): number => sheetBandCoordCpu(dome(x, z), kappa(x, z), phase);
    const t112d = (x: number, z: number): number => {
      const [gx, gz] = grad(kappa, x, z, CELL);
      const dx = gx + Math.cos(ice) * 2e-4;
      const dz = gz + Math.sin(ice) * 2e-4;
      const l = Math.hypot(dx, dz) || 1;
      return (x * (dx / l) + z * (dz / l)) / sierraParams.sheetBandSpacing;
    };
    const lattice = (x: number, z: number): number =>
      (x * Math.cos(ice) + z * Math.sin(ice)) / sierraParams.sheetBandSpacing;

    /** mean & p10 of |unit(∇Φ)·r̂|, and the worst |∇Φ|·spacing, over the dome */
    function survey(f: (x: number, z: number) => number): { radial: number; p10: number; worstMag: number } {
      const rad: number[] = [];
      let worstMag = 0;
      for (let a = 0; a < Math.PI * 2 - 1e-9; a += Math.PI / 60)
        for (let r = 20; r <= R * 0.85; r += 5) {
          const x = Math.cos(a) * r;
          const z = Math.sin(a) * r;
          const [gx, gz] = grad(f, x, z, 1);
          const l = Math.hypot(gx, gz);
          if (l < 1e-9) continue;
          rad.push(Math.abs((gx / l) * Math.cos(a) + (gz / l) * Math.sin(a)));
          worstMag = Math.max(worstMag, l * sierraParams.sheetBandSpacing);
        }
      const sorted = [...rad].sort((p, q) => p - q);
      return {
        radial: rad.reduce((p, q) => p + q, 0) / rad.length,
        p10: sorted[Math.floor(sorted.length * 0.1)],
        worstMag,
      };
    }
    const now = survey(shipped);
    const old = survey(t112d);
    const grid = survey(lattice);
    console.log(
      '§T.122 sheeting on a synthetic dome (|∇Φ·r̂|, and the worst |∇Φ|·spacing):\n' +
        `  shipped Φ     radial ${now.radial.toFixed(3)}  p10 ${now.p10.toFixed(3)}  worst |∇Φ|·s ${now.worstMag.toFixed(2)}\n` +
        `  T112d ∇κ dot  radial ${old.radial.toFixed(3)}  p10 ${old.p10.toFixed(3)}  worst |∇Φ|·s ${old.worstMag.toFixed(2)}\n` +
        `  ruled lattice radial ${grid.radial.toFixed(3)}  p10 ${grid.p10.toFixed(3)}  worst |∇Φ|·s ${grid.worstMag.toFixed(2)}`,
    );

    // concentric: the across-band axis is radial almost everywhere
    expect(now.radial).toBeGreaterThan(0.9);
    expect(now.p10).toBeGreaterThan(0.8);
    // …and one band per `sheetBandSpacing` metres of elevation, never a
    // coordinate racing away from its own band limit
    expect(now.worstMag).toBeLessThan(1.5);

    // THE CONTROLS. If either of these ever passes, the test has stopped
    // measuring what it claims to.
    expect(grid.radial).toBeLessThan(0.7);
    expect(grid.p10).toBeLessThan(0.8);
    expect(old.radial).toBeLessThan(0.9);
    expect(old.worstMag).toBeGreaterThan(1.5);
  });

  it('§V2 the surface is a pure function of its point — same point, same bytes', () => {
    const a = t122Point('dome', 1, 40, -25, 0);
    const b = t122Point('dome', 1, 40, -25, 0);
    const sa = sierraSurfaceCpu(a);
    const sb = sierraSurfaceCpu(b);
    expect(sb.albedo).toEqual(sa.albedo);
    expect(sb.weights).toEqual(sa.weights);
    expect(sb.bandCoord).toBe(sa.bandCoord);
    // and a block at the same point is a DIFFERENT surface, not a rounding
    expect(sierraSurfaceCpu(t122Point('dome', 1, 40, -25, 1)).albedo).not.toEqual(sa.albedo);
  });
});

function t122StubCanvas(): HTMLCanvasElement {
  return {
    width: 4,
    height: 4,
    style: {},
    getContext: (): null => null,
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
    getRootNode: (): unknown => ({}),
    setAttribute: (): void => {},
  } as unknown as HTMLCanvasElement;
}
