/**
 * §T.112e LIVING VEGETATION LAYERS — PROPERTIES (§V80), never decisions.
 *
 * WHY EACH MATTERS.
 * - species/mask correlation: the whole point of T112e is that the plants are
 *   WHERE A PLANT WOULD BE. If pines are not wetter than junipers and
 *   junipers are not on the windward convexities, the density maps are
 *   decoration and the island is back to a seeded scatter (the "Playmobil"
 *   complaint, one level up from the geometry).
 * - manzanita on the fork: the user's call on the distraction fork is that it
 *   passes through a DENSE BUT WALKABLE shrub corridor. Density beside the
 *   fork must beat open ground, or the fork reads as a line drawn on a hill
 *   instead of a way through something.
 * - nothing in the corridor: there is no foliage collision. A shrub on the
 *   tread is a shrub you walk THROUGH, which reads worse than bare ground and
 *   breaks §V90's walkable route.
 * - no overlap after competition: interpenetrating crowns are the single
 *   loudest instancing tell; competition is what makes a stand read as grown.
 * - counts scale with HABITAT AREA: `pinesPerRadius` was linear in R, so a
 *   bigger island got more trees whether or not it had anywhere to put them.
 *   The property is that a LARGE island with a thin bench carries FEWER plants
 *   than a small island with a broad one.
 * - snags below the waterline: the drowned treeline is the read of a drowned
 *   ridge; a snag on dry land is a dead tree in a field.
 * - triangle budgets + determinism + bake time: §V17 and §V2, and the bake
 *   runs at island load where T112c already spends most of the budget.
 * - foliage lighting: the CPU twins of the wrap and transmission terms, and
 *   the cluster-normal bake, are pinned here because §V88 forbids a browser
 *   and these are the three things that stop a cone reading as a cone.
 *
 * Heightmaps, bakes, placements and geometry only — no renderer (§V88).
 */
import { describe, expect, it } from 'vitest';
import { generateIslandHeightmap, type IslandHeightmap } from '../src/island/heightmap';
import { sierraIslandParams } from '../src/island/sierraSites';
import { islandParams } from '../src/params/island';
import { sierraParams } from '../src/params/sierra';
import { getParamsEntry } from '../src/params/registry';
import { decodeTerrainInfo, sampleTerrainChannel } from '../src/island/terrainInfo';
import { terrainInfoFor } from '../src/island/terrainInfoBake';
import {
  forkDistanceAt,
  habitatSample,
  inCorridor,
  pineDensityAt,
  sierraHabitatFor,
  sierraUnderstoryPlacements,
  speciesDensity,
  speciesHabitatIntegral,
  type SierraSpecies,
} from '../src/vegetation/sierraScatter';
import { competeFootprints, planSierraVegetation } from '../src/vegetation/pineScatter';
import { buildPineGeometry, PINE_ROLE } from '../src/vegetation/pineGeometry';
import { buildJuniperGeometry } from '../src/vegetation/juniperGeometry';
import { buildManzanitaGeometry } from '../src/vegetation/manzanitaGeometry';
import { applyClusterNormals, backTransmission, wrapDiffuseGain } from '../src/vegetation/foliage';
import { createGroundCover } from '../src/terrain/groundCoverMesh';
import * as THREE from 'three/webgpu';

const SEEDS = [988, 1965, 2942];
const RADII = [210, 250, 290];
const GRID = sierraParams.sliceGridSize;
type Family = 'dome' | 'drownedRidge' | 'cirque';
const FAMILIES: Family[] = ['dome', 'drownedRidge', 'cirque'];

const cache = new Map<string, IslandHeightmap>();
/** the island a slice site ACTUALLY builds (§V71 — same resolution path) */
const hmFor = (name: Family, i: number): IslandHeightmap => {
  const key = `${name}:${i}`;
  let hm = cache.get(key);
  if (!hm) {
    hm = generateIslandHeightmap(SEEDS[i], sierraIslandParams(name, RADII[i], GRID));
    cache.set(key, hm);
  }
  return hm;
};

const planCache = new Map<string, ReturnType<typeof planSierraVegetation>>();
const planFor = (name: Family, i: number) => {
  const key = `${name}:${i}`;
  let plan = planCache.get(key);
  if (!plan) {
    plan = planSierraVegetation(hmFor(name, i), SEEDS[i] + 31);
    planCache.set(key, plan);
  }
  return plan;
};

const tris = (g: THREE.BufferGeometry): number => g.index!.count / 3;
const attr = (g: THREE.BufferGeometry, n: string): Float32Array => g.getAttribute(n).array as Float32Array;

/** mean of a channel over a set of plant positions */
function meanChannel(hm: IslandHeightmap, pts: readonly { x: number; z: number }[], ch: 'moisture' | 'skyAO'): number {
  const info = terrainInfoFor(hm);
  let s = 0;
  for (const p of pts) s += sampleTerrainChannel(info, ch, p.x, p.z);
  return s / Math.max(pts.length, 1);
}


/**
 * A point on this island where the species clump gate is OPEN and no fork is
 * near, so a rule test is answering a question about the RULE rather than
 * about whether that spot happened to be a clearing or a corridor.
 */
function openPointFor(
  hab: ReturnType<typeof sierraHabitatFor>,
  base: Parameters<typeof speciesDensity>[1],
  species: SierraSpecies = 'manzanita',
): [number, number] {
  for (let i = 0; i < 900; i++) {
    const x = (i % 30) * 15 - 220;
    const z = Math.floor(i / 30) * 15 - 220;
    if (forkDistanceAt(hab, x, z) <= sierraParams.manzanitaForkRange) continue;
    if (speciesDensity(species, base, hab, x, z) > 0) return [x, z];
  }
  throw new Error('openPointFor: no clump-open point on this island'); // §Rule 8
}

/* ------------------------------------------------------------------------ */

describe('§V16 the T112e knobs are registered for the panel', () => {
  it('every new vegetation tunable is on the sierra params object', () => {
    const entry = getParamsEntry('sierra');
    expect(entry).toBeTruthy();
    for (const k of [
      'vegSampleSpacing', 'vegCurvatureRef', 'vegClumpBare', 'vegSunAspect',
      'pineDensity', 'pineMoistureMin', 'juniperDensity', 'juniperMoistureMax', 'juniperWindWeight',
      'manzanitaDensity', 'manzanitaForkRange', 'manzanitaForkBoost', 'manzanitaSlopeLimit',
      'foliageClusterBlend', 'foliageWrap', 'foliageWrapStrength', 'foliageTransmission',
      'understorySpacing', 'understoryGrassDensity', 'understoryDeadfallDensity', 'understoryConeDensity',
    ]) {
      expect(sierraParams).toHaveProperty(k);
      expect(Number.isFinite((sierraParams as unknown as Record<string, number>)[k])).toBe(true);
    }
  });
});

describe('species density maps read the terrain, not the seed', () => {
  it('pines stand in wetter ground than junipers, on every family with both', () => {
    let compared = 0;
    for (const fam of FAMILIES) {
      for (let i = 0; i < 3; i++) {
        const plan = planFor(fam, i);
        if (plan.pines.length < 5 || plan.junipers.length < 5) continue;
        const hm = hmFor(fam, i);
        expect(meanChannel(hm, plan.pines, 'moisture')).toBeGreaterThan(meanChannel(hm, plan.junipers, 'moisture'));
        compared++;
      }
    }
    expect(compared).toBeGreaterThanOrEqual(4);
  });

  it('pines sit in hollows and junipers on knobs: mean curvature is the other way round', () => {
    const hm = hmFor('dome', 1);
    const info = terrainInfoFor(hm);
    const meanCurv = (pts: readonly { x: number; z: number }[]): number => {
      let s = 0;
      for (const p of pts) s += decodeTerrainInfo.curvaturePerMetre(sampleTerrainChannel(info, 'curvature', p.x, p.z));
      return s / Math.max(pts.length, 1);
    };
    const plan = planFor('dome', 1);
    // + is convex (terrainInfo.ts): the juniper's ground is the convex one
    expect(meanCurv(plan.junipers)).toBeGreaterThan(meanCurv(plan.pines));
  });

  it('the juniper RULE prefers the windward bearing — asserted on the map, not the sample', () => {
    // §V80. The first cut of this measured the mean windward facing of the
    // PLACED junipers against the placed pines, and it failed: aspect is
    // confounded with curvature and moisture on a real island (the convex
    // knobs a juniper wants are not evenly spread over bearings), so the
    // sample can lean either way for reasons that have nothing to do with the
    // rule. The PROPERTY is that the rule itself prefers windward — hold every
    // other fact fixed and turn the ground round.
    const hab = sierraHabitatFor(hmFor('dome', 1));
    const base = {
      gradient: 0.2,
      slopeTan: 0.2,
      curvature: 0.01,
      moisture: 0.2,
      skyAO: 0.9,
      aspect: 0,
      height: 40,
      forkDistance: Infinity,
      corridor: false,
    };
    // the clump noise is a spatial gate that can read 0 anywhere, and a rule
    // test must not be answered by "this point happens to be a clearing" —
    // find a point inside a juniper stand and turn the ground there
    let px = 0;
    let pz = 0;
    for (let i = 0; i < 400 && speciesDensity('juniper', { ...base, aspect: hab.windwardAzimuth }, hab, px, pz) <= 0; i++) {
      px = (i % 20) * 11 - 100;
      pz = Math.floor(i / 20) * 11 - 100;
    }
    const at = (aspect: number): number =>
      speciesDensity('juniper', { ...base, aspect }, hab, px, pz);
    const windward = at(hab.windwardAzimuth);
    const lee = at(hab.windwardAzimuth + Math.PI);
    expect(windward).toBeGreaterThan(lee);
    // and the weighting is a knob, not a hard gate: the lee still carries some
    expect(lee).toBeGreaterThan(0);
    // pine reads a DIFFERENT bearing — the SUN's, and with the opposite sign:
    // a sun-baked face carries fewer conifers (`pineSouthAspectFactor`). The
    // two species must not be reading the same axis the same way, or "windward
    // junipers" is just "the aspect term" wearing a second name.
    const pineSunny = speciesDensity('pine', { ...base, curvature: -0.01, moisture: 0.6, aspect: sierraParams.vegSunAspect }, hab, px, pz);
    const pineShaded = speciesDensity('pine', { ...base, curvature: -0.01, moisture: 0.6, aspect: sierraParams.vegSunAspect + Math.PI }, hab, px, pz);
    expect(pineShaded).toBeGreaterThan(pineSunny);
  });

  it('manzanita takes the drier ground the pines refuse, and its RULE follows the sun', () => {
    const hm = hmFor('dome', 1);
    const hab = sierraHabitatFor(hm);
    const plan = planFor('dome', 1);
    expect(plan.manzanita.length).toBeGreaterThan(20);
    expect(meanChannel(hm, plan.manzanita, 'moisture')).toBeLessThan(meanChannel(hm, plan.pines, 'moisture'));
    // §V80. The sky-exposure half is asserted on the MAP, not on the placed
    // sample: the fork corridor is a carved cut with its own sky occlusion and
    // its own additive density term, so the mean sky-AO of the placed shrubs
    // answers a question about where the FORK went, not about the sun rule.
    const base = {
      gradient: 0.3, slopeTan: 0.3, curvature: 0.004, moisture: 0.2, skyAO: 0.9,
      aspect: sierraParams.vegSunAspect, height: 40, forkDistance: Infinity, corridor: false,
    };
    const [px, pz] = openPointFor(hab, base);
    const at = (skyAO: number, moisture: number): number =>
      speciesDensity('manzanita', { ...base, skyAO, moisture }, hab, px, pz);
    expect(at(0.95, 0.2)).toBeGreaterThan(at(0.45, 0.2)); // sky-exposed wins
    expect(at(0.95, 0.2)).toBeGreaterThan(at(0.95, 0.6)); // bare ground wins
    // and the sun-facing aspect beats the shaded one
    const facing = (aspect: number): number => speciesDensity('manzanita', { ...base, aspect }, hab, px, pz);
    expect(facing(sierraParams.vegSunAspect)).toBeGreaterThan(facing(sierraParams.vegSunAspect + Math.PI));
  });
});

describe('the distraction fork walks through a shrub corridor (T112b decision)', () => {
  /**
   * Instances per m² of manzanita in three zones, measured on the island's own
   * grid: the corridor band beside a fork, open ground away from every route,
   * and the main route's own corridor.
   */
  function manzanitaByZone(fam: Family, i: number) {
    const hm = hmFor(fam, i);
    const hab = sierraHabitatFor(hm);
    const plan = planFor(fam, i);
    const R = hm.worldRadius;
    const range = sierraParams.manzanitaForkRange;
    const zoneOf = (x: number, z: number): 'route' | 'fork' | 'open' | null => {
      if (x * x + z * z > R * R) return null;
      const path = hm.path;
      if (!path) return null;
      const size = hm.size;
      const cell = (2 * R) / (size - 1);
      const ix = Math.round((x + R) / cell);
      const iz = Math.round((z + R) / cell);
      if (ix < 0 || iz < 0 || ix >= size || iz >= size) return null;
      const k = iz * size + ix;
      if (path.routeMask[k] === 1 || path.forkMask[k] === 1) return 'route';
      if (hm.heightAt(x, z) < sierraParams.pineMinHeight) return null;
      return forkDistanceAt(hab, x, z) <= range ? 'fork' : 'open';
    };
    // zone areas, by sampling the same footprint the placement walked
    const step = sierraParams.vegSampleSpacing;
    const cells = Math.floor((2 * R) / step);
    const area = { route: 0, fork: 0, open: 0 };
    for (let iz = 0; iz < cells; iz++) {
      for (let ix = 0; ix < cells; ix++) {
        const z = zoneOf(-R + (ix + 0.5) * step, -R + (iz + 0.5) * step);
        if (z) area[z] += step * step;
      }
    }
    // the MAP's own mean density in each zone, alongside the instance count:
    // the map is the rule and the instances are what shipped, and a corridor
    // rule that only shows up in one of the two has not been demonstrated
    const map = { route: 0, fork: 0, open: 0 };
    const n = { route: 0, fork: 0, open: 0 };
    for (let iz = 0; iz < cells; iz++) {
      for (let ix = 0; ix < cells; ix++) {
        const x = -R + (ix + 0.5) * step;
        const z = -R + (iz + 0.5) * step;
        const zone = zoneOf(x, z);
        if (!zone) continue;
        map[zone] += speciesDensity('manzanita', habitatSample(hab, x, z), hab, x, z);
        n[zone]++;
      }
    }
    const count = { route: 0, fork: 0, open: 0 };
    for (const m of plan.manzanita) {
      const z = zoneOf(m.x, m.z);
      if (z) count[z]++;
    }
    return {
      route: count.route / Math.max(area.route, 1e-6),
      fork: count.fork / Math.max(area.fork, 1e-6),
      open: count.open / Math.max(area.open, 1e-6),
      mapFork: map.fork / Math.max(n.fork, 1),
      mapOpen: map.open / Math.max(n.open, 1),
      areas: area,
    };
  }

  it('density beside a fork > open ground > the main route, which is exactly zero', () => {
    let checked = 0;
    for (const fam of FAMILIES) {
      for (let i = 0; i < 3; i++) {
        const hm = hmFor(fam, i);
        if (!hm.path || hm.path.routes.forks.length === 0) continue;
        const d = manzanitaByZone(fam, i);
        if (d.areas.fork < 200) continue; // no corridor worth measuring on this island
        // the MAIN route carries nothing at all: it is inside a mask, and a
        // mask is a hard zero for every species
        expect(d.route).toBe(0);
        // the RULE: mean density per m² of the map itself, unconfounded by how
        // many candidates happened to survive
        expect(d.mapFork).toBeGreaterThan(d.mapOpen * 2);
        // and the SHIPPED placement agrees — the corridor is really thicker
        expect(d.fork).toBeGreaterThan(d.open);
        expect(d.open).toBeGreaterThan(0);
        checked++;
      }
    }
    // the slice is authored to carry a fork per island (§V94); if none of the
    // nine has a measurable one, the corridor rule is untested, not passing
    expect(checked).toBeGreaterThanOrEqual(6);
  });

  it('but the corridor is WALKABLE: not one plant of any species is inside a mask', () => {
    for (const fam of FAMILIES) {
      for (let i = 0; i < 3; i++) {
        const hm = hmFor(fam, i);
        if (!hm.path) continue;
        const hab = sierraHabitatFor(hm);
        const plan = planFor(fam, i);
        for (const p of plan.all) expect(inCorridor(hab, p.x, p.z)).toBe(false);
        const under = sierraUnderstoryPlacements(SEEDS[i] + 7, hm);
        for (const set of [under.bunchgrass, under.deadfall, under.cones]) {
          for (const c of set) expect(inCorridor(hab, c.position[0], c.position[2])).toBe(false);
        }
      }
    }
  });

  it('manzanita crowds right up to the corridor edge — the thicket has a hard edge, not a margin', () => {
    const hm = hmFor('drownedRidge', 1);
    const hab = sierraHabitatFor(hm);
    const plan = planFor('drownedRidge', 1);
    const near = plan.manzanita.filter((m) => forkDistanceAt(hab, m.x, m.z) <= hm.path!.treadHalf + 3);
    expect(near.length).toBeGreaterThan(0);
  });
});

describe('competition (§T.112a, extended across species)', () => {
  it('no two survivors overlap, whatever species they are', () => {
    const k = 1 + (sierraParams.pineCompetitionRounds - 1) * sierraParams.pineFootprintGrowth;
    for (const fam of FAMILIES) {
      const plan = planFor(fam, 1);
      const all = plan.all;
      for (let a = 0; a < all.length; a++) {
        for (let b = a + 1; b < all.length; b++) {
          const d = Math.hypot(all[a].x - all[b].x, all[a].z - all[b].z);
          expect(d).toBeGreaterThanOrEqual((all[a].footprint + all[b].footprint) * k - 1e-9);
        }
      }
      expect(all.length).toBeLessThan(plan.candidates); // it removed something
      expect(all.length).toBeGreaterThan(plan.candidates * 0.2); // thinned, not razed
    }
  });

  it('the SMALLER CROWN dies, not the smaller instance scale — the cross-species fix', () => {
    // a pine at scale 0.9 (crown 0.9 m) against a manzanita at scale 1.3
    // (crown 0.42 m): `scale` says the shrub wins, which would clear a tree
    // out of the way for a bush. Crown radius is the currency.
    const pine = { x: 0, z: 0, scale: 0.9, footprint: 0.9, species: 'pine' };
    const shrub = { x: 0.6, z: 0, scale: 1.3, footprint: 0.42, species: 'manzanita' };
    expect(competeFootprints([pine, shrub], 1, 0)).toEqual([pine]);
    expect(competeFootprints([shrub, pine], 1, 0)).toEqual([pine]);
    expect(competeFootprints([pine, shrub], 0, 0)).toEqual([pine, shrub]);
  });
});

describe('counts follow the HABITAT, not the radius', () => {
  it('a big island with a thin bench carries fewer plants than a small island with a broad one', () => {
    const small = hmFor('dome', 0); // R 210, a broad bench
    const big = hmFor('drownedRidge', 2); // R 290, a crest
    expect(big.worldRadius).toBeGreaterThan(small.worldRadius);
    expect(planFor('drownedRidge', 2).all.length).toBeLessThan(planFor('dome', 0).all.length);
  });

  it('count / ∫density dA is far steadier across three radii than count / R', () => {
    const cv = (v: number[]): number => {
      const m = v.reduce((a, b) => a + b, 0) / v.length;
      const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length);
      return sd / Math.max(Math.abs(m), 1e-9);
    };
    const perArea: number[] = [];
    const perRadius: number[] = [];
    for (let i = 0; i < 3; i++) {
      const hm = hmFor('dome', i);
      const n = planFor('dome', i).pines.length;
      perArea.push(n / Math.max(speciesHabitatIntegral(hm, 'pine'), 1e-6));
      perRadius.push(n / hm.worldRadius);
    }
    expect(cv(perArea)).toBeLessThan(cv(perRadius));
  });

  it('the habitat integral itself is an AREA: it collapses when the bench does', () => {
    const dome = speciesHabitatIntegral(hmFor('dome', 1), 'pine');
    const ridge = speciesHabitatIntegral(hmFor('drownedRidge', 1), 'pine');
    expect(dome).toBeGreaterThan(ridge * 3);
  });
});

describe('dead snags stay on the drowned crest, in the water', () => {
  it('every treeline marker stands below the waterline, and only the ridge has any', () => {
    for (let i = 0; i < 3; i++) {
      const ridge = hmFor('drownedRidge', i);
      const markers = ridge.sierra?.treeline ?? [];
      expect(markers.length).toBeGreaterThanOrEqual(5);
      for (const m of markers) {
        expect(m.floor).toBeLessThanOrEqual(0);
        expect(-m.floor).toBeGreaterThanOrEqual(sierraParams.treelineDepthMin);
        expect(-m.floor).toBeLessThanOrEqual(sierraParams.treelineDepthMax);
      }
      expect(hmFor('dome', i).sierra?.treeline.length ?? 0).toBe(0);
      expect(hmFor('cirque', i).sierra?.treeline.length ?? 0).toBe(0);
    }
  });
});

describe('geometry budgets and the shared attribute contract (§V17)', () => {
  it('juniper ≤ 300 tris, manzanita ≤ 150, pine unchanged', () => {
    expect(tris(buildJuniperGeometry(12))).toBeLessThanOrEqual(300);
    expect(tris(buildManzanitaGeometry(12))).toBeLessThanOrEqual(150);
    for (const v of ['pine', 'juniper', 'dead'] as const) {
      expect(tris(buildPineGeometry(12, v))).toBeLessThanOrEqual(300);
    }
  });

  it('every species bakes windWeight / phaseOffset / role for the ONE wind system (§V95)', () => {
    for (const g of [buildJuniperGeometry(7), buildManzanitaGeometry(7), buildPineGeometry(7)]) {
      const w = attr(g, 'windWeight');
      const ph = attr(g, 'phaseOffset');
      const role = attr(g, 'role');
      const pos = attr(g, 'position');
      expect(w.length).toBe(pos.length / 3);
      expect(ph.length).toBe(w.length);
      expect(role.length).toBe(w.length);
      for (let i = 0; i < w.length; i++) expect(w[i]).toBeGreaterThanOrEqual(0);
      // the base is planted: a vertex at y = 0 must not move, or the plant
      // shears out of the ground under wind
      for (let i = 0; i < w.length; i++) if (pos[i * 3 + 1] === 0) expect(w[i]).toBeLessThan(0.05);
      expect(Math.max(...w)).toBeGreaterThan(0.3);
      expect(new Set(Array.from(ph)).size).toBeGreaterThan(1);
    }
  });

  it('the roles the material branches on are the ones the geometry writes', () => {
    const jr = new Set(Array.from(attr(buildJuniperGeometry(3), 'role')));
    expect(jr).toEqual(new Set([PINE_ROLE.trunk, PINE_ROLE.juniper]));
    const mr = new Set(Array.from(attr(buildManzanitaGeometry(3), 'role')));
    expect(mr).toEqual(new Set([PINE_ROLE.manzanitaStem, PINE_ROLE.manzanitaLeaf]));
  });

  it('same seed → byte-identical buffers; a different seed → a different plant', () => {
    for (const build of [buildJuniperGeometry, buildManzanitaGeometry]) {
      expect(attr(build(1234), 'position')).toEqual(attr(build(1234), 'position'));
      expect(attr(build(4321), 'position')).not.toEqual(attr(build(1234), 'position'));
    }
  });
});

describe('foliage lighting: the three terms that stop a cone reading as a cone', () => {
  it('cluster normals bend a leaf toward its canopy sphere, leave wood alone, stay unit', () => {
    // a flat quad standing in for a leaf card, with a canopy centre below it
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, 1, 0, 1, 1, 0, 0, 1, 1], 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    const centre = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const weight = new Float32Array([1, 0, 1]);
    applyClusterNormals(g, centre, weight, 0.5);
    const n = attr(g, 'normal');
    // the wood vertex (weight 0) is untouched
    expect([n[3], n[4], n[5]]).toEqual([0, 1, 0]);
    for (let i = 0; i < 3; i++) {
      expect(Math.hypot(n[i * 3], n[i * 3 + 1], n[i * 3 + 2])).toBeCloseTo(1, 6);
    }
    // vertex 0 sat at (−1, 1, 0) with a straight-up normal; its canopy normal
    // leans −x, so the blend must too — that lean IS the soft-mass read
    expect(n[0]).toBeLessThan(0);
    expect(n[1]).toBeGreaterThan(0);
    // and a blend of 0 is a no-op, so the knob can be turned off
    const g0 = new THREE.BufferGeometry();
    g0.setAttribute('position', new THREE.Float32BufferAttribute([-1, 1, 0], 3));
    g0.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0], 3));
    applyClusterNormals(g0, new Float32Array([0, 0, 0]), new Float32Array([1]), 0);
    expect(Array.from(attr(g0, 'normal'))).toEqual([0, 1, 0]);
  });

  it('a pine crown really is bent toward its own axis after the bake', () => {
    const g = buildPineGeometry(9, 'pine');
    const pos = attr(g, 'position');
    const nrm = attr(g, 'normal');
    const role = attr(g, 'role');
    // the crown normals should have a positive radial component: a cone's
    // facets already do, but the bake pushes the APEX and the rim toward the
    // sphere, so the mean radial lean rises. Measured against the trunk, whose
    // normals were left alone.
    const radial = (want: number): number => {
      let s = 0;
      let n = 0;
      for (let i = 0; i < role.length; i++) {
        if (role[i] !== want) continue;
        const r = Math.hypot(pos[i * 3], pos[i * 3 + 2]);
        if (r < 1e-4) continue;
        s += (nrm[i * 3] * pos[i * 3] + nrm[i * 3 + 2] * pos[i * 3 + 2]) / r;
        n++;
      }
      return s / Math.max(n, 1);
    };
    expect(radial(PINE_ROLE.needles)).toBeGreaterThan(0);
    // every normal stays unit after the blend
    for (let i = 0; i < nrm.length / 3; i++) {
      const len = Math.hypot(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]);
      expect(len).toBeCloseTo(1, 4);
    }
  });

  it('wrap diffuse peaks AT the terminator and is zero at both poles, never negative', () => {
    const w = sierraParams.foliageWrap;
    const s = sierraParams.foliageWrapStrength;
    // §V80. The first cut asserted "adds nothing on the lit side", which is
    // false and would have written the wrong function down: a wrap raises
    // every partially-lit sample, and only the pole where N·L = 1 is
    // untouched. The real properties are the three below.
    // (a) zero at the fully lit pole — a leaf square to the sun is unchanged
    expect(wrapDiffuseGain(1, w, s)).toBeCloseTo(0, 9);
    // (b) zero at the fully turned-away pole with wrap < 1 — the dark side of
    //     a leaf stays dark; the wrap softens the terminator, it is not a fill
    expect(wrapDiffuseGain(-1, w, s)).toBeCloseTo(0, 9);
    // (c) the peak is AT the terminator, which is the edge it exists to move,
    //     and the term is non-negative everywhere (it never removes light)
    let peakAt = -2;
    let peak = -1;
    for (let i = 0; i <= 200; i++) {
      const n = -1 + (2 * i) / 200;
      const g = wrapDiffuseGain(n, w, s);
      expect(g).toBeGreaterThanOrEqual(-1e-12);
      if (g > peak) {
        peak = g;
        peakAt = n;
      }
    }
    expect(peakAt).toBeCloseTo(0, 1);
    expect(peak).toBeGreaterThan(0);
    // strength 0 turns it off entirely
    expect(wrapDiffuseGain(-0.2, w, 0)).toBe(0);
  });

  it('back transmission only fires through a leaf, toward the sun', () => {
    const p = sierraParams.foliageTransmissionPower;
    // sun in front of the surface: nothing comes THROUGH it
    expect(backTransmission(0.6, -1, p)).toBe(0);
    // sun behind the leaf, camera looking into the sun: the rim
    expect(backTransmission(-0.8, -1, p)).toBeGreaterThan(0);
    // sun behind the leaf, camera with its back to the sun: nothing
    expect(backTransmission(-0.8, 1, p)).toBe(0);
    // it tightens toward the sun rather than washing the whole hemisphere
    expect(backTransmission(-0.8, -1, p)).toBeGreaterThan(backTransmission(-0.8, -0.5, p));
  });
});

describe('understory + litter key off the PINE DENSITY FIELD, not a proxy', () => {
  it('deadfall and cones sit where the pines are; bunchgrass does not have to', () => {
    const hm = hmFor('dome', 1);
    const hab = sierraHabitatFor(hm);
    const u = sierraUnderstoryPlacements(SEEDS[1] + 7, hm);
    expect(u.deadfall.length).toBeGreaterThan(3);
    expect(u.bunchgrass.length).toBeGreaterThan(20);
    const meanPine = (pts: readonly { position: [number, number, number] }[]): number => {
      let s = 0;
      for (const c of pts) s += pineDensityAt(hab, c.position[0], c.position[2]);
      return s / Math.max(pts.length, 1);
    };
    // every deadfall instance is under a pine's worth of canopy: the litter is
    // WHERE THE TREES ARE, which is the coordination T112d's moisture proxy
    // was standing in for
    for (const d of u.deadfall) expect(pineDensityAt(hab, d.position[0], d.position[2])).toBeGreaterThan(0);
    expect(meanPine(u.deadfall)).toBeGreaterThan(meanPine(u.bunchgrass));
  });

  it('a sierra island gets the sierra cover set; a pirate island still gets grass and shrubs', () => {
    const sierra = createGroundCover({ seed: 5, heightmap: hmFor('dome', 1), sierra: hmFor('dome', 1) });
    expect(sierra.group.children.map((c) => c.name).sort()).toEqual(
      ['island-bunchgrass', 'island-cones', 'island-deadfall'],
    );
    expect(sierra.instanceCount).toBeGreaterThan(0);
    sierra.dispose();

    const pirate = generateIslandHeightmap(42, islandParams);
    expect(pirate.sierra).toBeUndefined();
    const tropical = createGroundCover({ seed: 5, heightmap: pirate });
    expect(tropical.group.children.map((c) => c.name).sort()).toEqual(['island-grass', 'island-shrubs']);
    expect(tropical.instanceCount).toBeGreaterThan(0);
    tropical.dispose();
  });
});

describe('§V2 determinism and the bake budget', () => {
  it('same seed → the same plan, every plant, every species', () => {
    const hm = hmFor('cirque', 2);
    const a = planSierraVegetation(hm, 99);
    const b = planSierraVegetation(hm, 99);
    const hash = (p: typeof a): string =>
      p.all.map((c) => `${c.species}:${c.x.toFixed(6)},${c.z.toFixed(6)},${c.scale.toFixed(6)}`).join('|');
    expect(hash(b)).toBe(hash(a));
    expect(hash(planSierraVegetation(hm, 100))).not.toBe(hash(a));
    // and the understory rides the same rule
    const u = sierraUnderstoryPlacements(7, hm);
    expect(sierraUnderstoryPlacements(7, hm)).toEqual(u);
  });

  it('the placement bake stays inside a generous per-island budget', () => {
    const rows: string[] = [];
    for (const fam of FAMILIES) {
      for (let i = 0; i < 3; i++) {
        const hm = hmFor(fam, i);
        const t0 = performance.now();
        const plan = planSierraVegetation(hm, SEEDS[i] + 31);
        const planMs = performance.now() - t0;
        const t1 = performance.now();
        const u = sierraUnderstoryPlacements(SEEDS[i] + 7, hm);
        const underMs = performance.now() - t1;
        rows.push(
          `${fam} R${RADII[i]}: pine ${plan.pines.length} juniper ${plan.junipers.length} ` +
            `manzanita ${plan.manzanita.length} | grass ${u.bunchgrass.length} deadfall ${u.deadfall.length} ` +
            `cones ${u.cones.length} | plan ${planMs.toFixed(0)} ms + understory ${underMs.toFixed(0)} ms`,
        );
        // T112c's own bake budget is 300 ms/island; the vegetation pass rides
        // on top of it, so this is deliberately generous and only there to
        // catch an O(n²) that ran away
        expect(planMs + underMs).toBeLessThan(1500);
      }
    }
    // eslint-disable-next-line no-console
    console.log('§T.112e placement:\n  ' + rows.join('\n  '));
  }, 120000);
});

describe('density is a pure function of the ground', () => {
  it('reads zero in the corridor and on the beach band, for every species', () => {
    const hm = hmFor('dome', 1);
    const hab = sierraHabitatFor(hm);
    const R = hm.worldRadius;
    let corridorSamples = 0;
    for (let iz = 0; iz < 96; iz++) {
      for (let ix = 0; ix < 96; ix++) {
        const x = -R + ((ix + 0.5) / 96) * 2 * R;
        const z = -R + ((iz + 0.5) / 96) * 2 * R;
        if (x * x + z * z > R * R) continue;
        const s = habitatSample(hab, x, z);
        if (!s.corridor && s.height >= sierraParams.pineMinHeight) continue;
        if (s.corridor) corridorSamples++;
        for (const sp of ['pine', 'juniper', 'manzanita'] as SierraSpecies[]) {
          expect(speciesDensity(sp, s, hab, x, z)).toBe(0);
        }
      }
    }
    expect(corridorSamples).toBeGreaterThan(0);
  });
});
