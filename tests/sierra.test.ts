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
import {
  findShoreRadius,
  generateIslandHeightmap,
  gradientAt,
  type IslandHeightmap,
} from '../src/island/heightmap';
import { createArchipelago, generateIslandSites, siteParams } from '../src/island/archipelago';
import { createIslandMaterials } from '../src/island/islandMaterials';
import { createIslandMesh } from '../src/island/islandMesh';
import { createSierraTerrainMaterial } from '../src/island/sierraMaterial';
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

/** plateaus along the terraced flank: flat runs ≥ 3 m (< 10°) separated by steeper ground */
function countPlateaus(hm: IslandHeightmap): number {
  const a = hm.sierra!.terraceAzimuth;
  const cx = Math.cos(a);
  const sz = Math.sin(a);
  const shore = findShoreRadius(hm, a);
  let plateaus = 0;
  let flatRun = 0;
  let open = true;
  for (let r = shore; r > 0; r -= 1) {
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

describe('§V90 clue path: beach → summit on foot, every segment < 35°', () => {
  for (const name of SIERRA_SLICE_ARCHETYPES) {
    for (let i = 0; i < SEEDS.length; i++) {
      it(`${name} seed ${SEEDS[i]} on the ${GRID}² grid`, () => {
        expect(summitReachable(hmFor(name, i))).toBe(true);
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
    it(`seed ${SEEDS[i]}: ≥ 2 plateaus on the terraced flank`, () => {
      const hm = hmFor('dome', i);
      expect(hm.sierra?.name).toBe('dome');
      expect(countPlateaus(hm)).toBeGreaterThanOrEqual(2);
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
      expect(arch.anchorages).toHaveLength(0); // no lagoon showcase in this world
      for (const island of arch.islands) {
        expect(isSierraArchetype(island.heightmap.archetype)).toBe(true);
        expect(island.palms.mesh.name).toBe('island-pines');
        // every island renders with the granite handle, not the pirate one
        expect(island.terrain.material).toBe(arch.materials.sierraTerrain());
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
