/**
 * T20 island guards. WHY each matters:
 * - §V2-adjacent determinism: heightmap/palm/rock generation must be pure
 *   f(seed, params) — multiplayer clients later rebuild the same island from
 *   the SimState seed; any drift desyncs collision + visuals.
 * - rim submerged: the island boundary must sit below the waterline or the
 *   terrain edge/skirt pops out of the ocean at distance (visible seam).
 * - peak floor: an island that noise flattened into a sandbar breaks the
 *   silhouette read (refs: docs/ship-full-view.png) — minPeakHeight is the
 *   contract that the interior actually rises.
 * - beach apron: the sand ring the whole look hangs on — there must exist a
 *   low-gradient band where height crosses 0..~2 m or the shore is a cliff.
 * - palm rules: palms below the waterline or on cliff faces read as bugs
 *   instantly; the placement fn promises height ≥ min and |∇h| ≤ limit.
 * - rock foamTarget flags: T13's intersection foam (§V10) keys off
 *   userData.foamTarget — the placement data must tag waterline-straddling
 *   rocks deterministically.
 * CPU modules only — materials/GPU stay untouched (lazy creation elsewhere).
 */
import { describe, expect, it } from 'vitest';
import {
  findShoreRadius,
  generateIslandHeightmap,
  gradientAt,
} from '../src/island/heightmap';
import { generateRockPlacements } from '../src/island/rocks';
import { islandPalmPlacement, palmLodCount } from '../src/island/palms';
import { generateIslandSites } from '../src/island/archipelago';
import { sampleSeabedHeight } from '../src/island/seabed';
import { buildIslandGeometry, selectTerrainLod } from '../src/island/islandMesh';
import { islandPalmCount } from '../src/island/island';
import { generatePlacements } from '../src/vegetation/scatter';
import { islandParams } from '../src/params/island';
import { getParamsEntry } from '../src/params/registry';

const SEED = 42;
const hm = generateIslandHeightmap(SEED, islandParams);
const R = hm.worldRadius;

describe('heightmap determinism (§V2-adjacent)', () => {
  it('same seed → byte-identical grid and identical heightAt samples', () => {
    const again = generateIslandHeightmap(SEED, islandParams);
    expect(again.data).toEqual(hm.data);
    for (let i = 0; i < 50; i++) {
      const x = ((i * 37) % 100) / 100 * 2 * R - R;
      const z = ((i * 53) % 100) / 100 * 2 * R - R;
      expect(again.heightAt(x, z)).toBe(hm.heightAt(x, z));
    }
  });

  it('different seed → different terrain', () => {
    const other = generateIslandHeightmap(SEED + 1, islandParams);
    expect(other.data).not.toEqual(hm.data);
  });
});

describe('rim submerged (island boundary must never break the surface)', () => {
  it('every sample on the boundary circle r=radius is below waterline', () => {
    for (let i = 0; i < 128; i++) {
      const a = (i / 128) * Math.PI * 2;
      expect(hm.heightAt(Math.cos(a) * R, Math.sin(a) * R)).toBeLessThan(0);
    }
  });

  it('every grid-edge vertex is below waterline', () => {
    const n = hm.size;
    for (let i = 0; i < n; i++) {
      expect(hm.data[i]).toBeLessThan(0); // z = -R row
      expect(hm.data[(n - 1) * n + i]).toBeLessThan(0); // z = +R row
      expect(hm.data[i * n]).toBeLessThan(0); // x = -R col
      expect(hm.data[i * n + (n - 1)]).toBeLessThan(0); // x = +R col
    }
  });

  it('outside the grid heightAt reports the submerged rim depth', () => {
    expect(hm.heightAt(R * 3, 0)).toBe(-islandParams.rimDepth);
  });
});

describe('interior peak floor (silhouette contract)', () => {
  it('max height ≥ minPeakHeight', () => {
    let max = -Infinity;
    for (const h of hm.data) if (h > max) max = h;
    expect(max).toBeGreaterThanOrEqual(islandParams.minPeakHeight);
  });

  it('noise undershoot is rescued: tiny dome still rescales up to minPeakHeight', () => {
    const low = generateIslandHeightmap(SEED, { ...islandParams, peakHeight: 2 });
    let max = -Infinity;
    for (const h of low.data) if (h > max) max = h;
    expect(max).toBeGreaterThanOrEqual(islandParams.minPeakHeight);
  });

  it('params that never surface throw instead of silently sinking (§Rule 8)', () => {
    // peak 0 + zero noise → dome never breaks waterline anywhere on the grid
    expect(() =>
      generateIslandHeightmap(SEED, { ...islandParams, peakHeight: 0, noiseStrength: 0 }),
    ).toThrow();
  });
});

describe('beach apron (gentle 0..~2 m sand ring exists)', () => {
  it('finds low-gradient samples inside the waterline band around the shore', () => {
    let found = 0;
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      const shore = findShoreRadius(hm, a);
      for (let inland = 0.5; inland <= 6; inland += 0.5) {
        const x = Math.cos(a) * (shore - inland);
        const z = Math.sin(a) * (shore - inland);
        const h = hm.heightAt(x, z);
        if (h > 0 && h <= islandParams.beachBandWidth && gradientAt(hm, x, z) <= 0.4) {
          found++;
          break; // one qualifying sample per ray is enough
        }
      }
    }
    // the ring must exist around most of the island, not just one lucky ray
    expect(found).toBeGreaterThanOrEqual(32);
  });
});

describe('palm placement (never drowned, never on cliffs, deterministic)', () => {
  const place = () =>
    generatePlacements(islandParams.palmCount, 7, islandPalmPlacement(hm));

  it('all palms sit above the waterline on acceptable slope, feet on terrain', () => {
    for (const pl of place()) {
      const [x, y, z] = pl.position;
      expect(y).toBeGreaterThanOrEqual(islandParams.palmMinHeight);
      expect(y).toBe(hm.heightAt(x, z)); // trunk base planted on the terrain
      expect(gradientAt(hm, x, z)).toBeLessThanOrEqual(islandParams.palmSlopeLimit);
    }
  });

  it('same seed → identical placements (rejection sampling included)', () => {
    expect(place()).toEqual(place());
  });

  it('different seed → different placements', () => {
    const other = generatePlacements(islandParams.palmCount, 8, islandPalmPlacement(hm));
    expect(JSON.stringify(other)).not.toEqual(JSON.stringify(place()));
  });
});

describe('rock placement (shore-hugging, deterministic, T13 foam tags §V10)', () => {
  const rocks = generateRockPlacements(5, hm);

  it('same seed → identical placements; different seed → different', () => {
    expect(generateRockPlacements(5, hm)).toEqual(rocks);
    expect(JSON.stringify(generateRockPlacements(6, hm))).not.toEqual(
      JSON.stringify(rocks),
    );
  });

  it('rocks cluster on the beach/waterline ring, not mid-ocean or on the peak', () => {
    for (const rock of rocks) {
      const [x, , z] = rock.position;
      const r = Math.hypot(x, z);
      const shore = findShoreRadius(hm, Math.atan2(z, x));
      // placement jitters ±rockSpread around the shoreline; shore radius from
      // the placement angle vs re-derived angle can differ by ~a march step
      expect(Math.abs(r - shore)).toBeLessThanOrEqual(islandParams.rockSpread + 3);
    }
  });

  it('flags waterline-straddling rocks as foam targets for T13', () => {
    for (const rock of rocks) {
      const half = rock.scale * rock.squash;
      const straddles = rock.position[1] - half < 0 && rock.position[1] + half > 0;
      expect(rock.foamTarget).toBe(straddles);
    }
    // the demo seed must actually produce foam targets, or T13 has nothing
    // to hook into on this island
    expect(rocks.some((rock) => rock.foamTarget)).toBe(true);
  });
});

describe('island params (§V16)', () => {
  it('registers with the params registry for the debug panel', () => {
    expect(getParamsEntry('island')?.params).toBe(islandParams);
  });
});

// ---------------------------------------------------------------------------
// T33: archipelago scatter, seabed depth field, LOD
// ---------------------------------------------------------------------------

const WORLD_SEED = 1337;

describe('archipelago scatter (§V2: same seed ⇒ same world)', () => {
  const sites = generateIslandSites(WORLD_SEED);

  it('same seed → identical layout; different seed → different layout', () => {
    // multiplayer clients rebuild the world from SimState.seed alone, so a
    // layout that is not a pure f(seed, params) desyncs collision + visuals
    expect(generateIslandSites(WORLD_SEED)).toEqual(sites);
    expect(JSON.stringify(generateIslandSites(WORLD_SEED + 1))).not.toEqual(
      JSON.stringify(sites),
    );
  });

  it('places the requested number of islands', () => {
    expect(sites).toHaveLength(islandParams.islandCount);
  });

  it('no island footprint reaches the spawn point', () => {
    // the ship spawns at the world origin — an island on top of it means the
    // player starts beached, which buoyancy grounding would make unrecoverable
    for (const site of sites) {
      const d = Math.hypot(site.position[0], site.position[1]);
      expect(d - site.radius).toBeGreaterThanOrEqual(islandParams.spawnClearance);
    }
  });

  it('leaves open water between every pair of islands', () => {
    for (let i = 0; i < sites.length; i++) {
      for (let j = i + 1; j < sites.length; j++) {
        const d = Math.hypot(
          sites[i].position[0] - sites[j].position[0],
          sites[i].position[1] - sites[j].position[1],
        );
        expect(d).toBeGreaterThanOrEqual(
          sites[i].radius + sites[j].radius + islandParams.islandGap,
        );
      }
    }
  });

  it('spans near AND far so the world has both landfall and haze subjects', () => {
    // the sky agent's object-vs-water haze fade needs geometry out at 2-4 km;
    // the shore work needs something you can actually sail to. Uniform
    // sampling of the annulus gave neither — stratified bands guarantee both.
    const d = sites.map((s) => Math.hypot(s.position[0], s.position[1])).sort((a, b) => a - b);
    expect(d[0]).toBeLessThan(1600);
    expect(d[d.length - 1]).toBeGreaterThan(2500);
    // and everything stays inside the ocean's 4.6 km rim (§V30)
    for (const site of sites) {
      expect(Math.hypot(site.position[0], site.position[1]) + site.radius).toBeLessThan(4600);
    }
  });

  it('impossible constraints throw instead of returning a short world (§Rule 8)', () => {
    expect(() =>
      generateIslandSites(WORLD_SEED, {
        ...islandParams,
        islandCount: 8,
        scatterMinDistance: 700,
        scatterMaxDistance: 800,
        islandGap: 2000,
      }),
    ).toThrow();
  });
});

describe('seabed depth field (T33 keystone — ocean tint + §V8 grounding)', () => {
  const sites = generateIslandSites(WORLD_SEED);
  const islands = sites.map((s) => ({
    heightmap: generateIslandHeightmap(s.seed, { ...islandParams, radius: s.radius }),
    center: s.position,
  }));
  const seabedAt = (x: number, z: number) => sampleSeabedHeight(islands, x, z);

  it('open ocean reports the open depth', () => {
    // the spawn point must be deep water or buoyancy grounds the ship at t=0
    expect(seabedAt(0, 0)).toBeCloseTo(-islandParams.seabedOpenDepth, 6);
    expect(seabedAt(9000, -9000)).toBeCloseTo(-islandParams.seabedOpenDepth, 6);
  });

  it('over an island it reproduces that island heightmap exactly', () => {
    // §V8 in spirit: physics must sample the surface that is DRAWN. The mesh
    // vertices come from the same heightmap, so any divergence here is the
    // ship floating over (or grounding on) terrain that is not there.
    const isl = islands[0];
    const R = isl.heightmap.worldRadius;
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      const r = (((i * 17) % 40) / 40) * R * 0.8;
      const lx = Math.cos(a) * r;
      const lz = Math.sin(a) * r;
      expect(seabedAt(isl.center[0] + lx, isl.center[1] + lz)).toBeCloseTo(
        isl.heightmap.heightAt(lx, lz),
        6,
      );
    }
  });

  it('the shelf falls off monotonically from the rim to open water', () => {
    // a hard depth step at the footprint edge would paint a hard turquoise
    // ring on the water — the shelf ramp IS the halo
    const isl = islands[0];
    const R = isl.heightmap.worldRadius;
    let prev = Infinity;
    for (let d = 0; d <= islandParams.seabedShelfWidth; d += 10) {
      const h = seabedAt(isl.center[0] + R + d, isl.center[1]);
      expect(h).toBeLessThanOrEqual(prev + 1e-9);
      prev = h;
    }
    expect(prev).toBeCloseTo(-islandParams.seabedOpenDepth, 4);
  });

  it('depthAt is a non-negative water column that follows the water level', () => {
    const field = { depthAt: (x: number, z: number, w = 0) => Math.max(w - seabedAt(x, z), 0) };
    const isl = islands[0];
    expect(field.depthAt(0, 0)).toBeCloseTo(islandParams.seabedOpenDepth, 6);
    // dry land: zero water column regardless of a small swell
    expect(field.depthAt(isl.center[0], isl.center[1])).toBe(0);
    // a rising tide deepens everything by exactly the same amount
    expect(field.depthAt(0, 0, 2)).toBeCloseTo(islandParams.seabedOpenDepth + 2, 6);
  });

  it('is deterministic and NaN-free over a coarse world sweep', () => {
    for (let x = -4000; x <= 4000; x += 250) {
      for (let z = -4000; z <= 4000; z += 250) {
        const h = seabedAt(x, z);
        expect(Number.isFinite(h)).toBe(true);
        expect(h).toBe(seabedAt(x, z));
      }
    }
  });
});

describe('LOD selection (§V17 — scenery has to be cheap)', () => {
  it('terrain drops to the decimated grid past the switch distance', () => {
    expect(selectTerrainLod(0)).toBe(0);
    expect(selectTerrainLod(islandParams.lodTerrainDistance - 1)).toBe(0);
    expect(selectTerrainLod(islandParams.lodTerrainDistance + 1)).toBe(1);
  });

  it('the decimated grid keeps the exact footprint, only fewer vertices', () => {
    // the rim is the contract that the island edge stays submerged; an LOD
    // that shrank or moved the footprint would surface the skirt at distance
    const full = buildIslandGeometry(hm, islandParams.skirtDepth, 1);
    const far = buildIslandGeometry(hm, islandParams.skirtDepth, 4);
    const fullPos = full.getAttribute('position');
    const farPos = far.getAttribute('position');
    expect(farPos.count).toBeLessThan(fullPos.count / 8);
    const extent = (attr: { count: number; getX(i: number): number; getZ(i: number): number }) => {
      let m = 0;
      for (let i = 0; i < attr.count; i++) {
        m = Math.max(m, Math.abs(attr.getX(i)), Math.abs(attr.getZ(i)));
      }
      return m;
    };
    expect(extent(farPos as never)).toBeCloseTo(extent(fullPos as never), 6);
  });

  it('palm count ramps full → zero across the LOD window and never goes negative', () => {
    const n = 40;
    expect(palmLodCount(n, 0)).toBe(n);
    expect(palmLodCount(n, islandParams.lodPalmFull)).toBe(n);
    expect(palmLodCount(n, islandParams.lodPalmCull)).toBe(0);
    expect(palmLodCount(n, 99999)).toBe(0);
    const mid = (islandParams.lodPalmFull + islandParams.lodPalmCull) / 2;
    expect(palmLodCount(n, mid)).toBeGreaterThan(0);
    expect(palmLodCount(n, mid)).toBeLessThan(n);
    // monotone: a receding camera never re-adds palms
    let prev = n;
    for (let d = 0; d <= islandParams.lodPalmCull + 100; d += 25) {
      const c = palmLodCount(n, d);
      expect(c).toBeLessThanOrEqual(prev);
      prev = c;
    }
  });

  it('palm counts scale with island size, not with the params default', () => {
    // every island got the same 28 palms once because the per-island params
    // copy (radius already overridden) was used as the reference
    expect(islandPalmCount(islandParams.radius)).toBe(islandParams.palmCount);
    expect(islandPalmCount(islandParams.radius * 2)).toBe(islandParams.palmCount * 2);
    expect(islandPalmCount(0)).toBe(0);
  });
});
