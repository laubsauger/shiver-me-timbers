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
import { islandPalmPlacement, palmLodCount, palmGroveAngles } from '../src/island/palms';
import { generateIslandSites, createArchipelago } from '../src/island/archipelago';
import { sampleSeabedHeight } from '../src/island/seabed';
import { smoothMax } from '../src/island/archetypes';
import { buildIslandGeometry, selectTerrainLod } from '../src/island/islandMesh';
import { islandPalmCount, islandPeakHeights } from '../src/island/island';
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

// ---------------------------------------------------------------------------
// §V43 — Sea of Thieves parity. These are QUALITY contracts, and they are here
// because the failures they guard were all invisible to the old tests: the
// islands generated fine, passed every structural check, and looked silly.
// Each number below was measured against docs/final-full-result*.png and
// docs/ship-full-view.png before it was chosen.
// ---------------------------------------------------------------------------

describe('§V43 silhouette: island shape must not flatten as it grows', () => {
  const sites = generateIslandSites(WORLD_SEED);
  const built = sites.map((s) => {
    const hm = generateIslandHeightmap(s.seed, {
      ...islandParams,
      radius: s.radius,
      ...islandPeakHeights(s.radius),
    });
    let peak = -Infinity;
    for (const h of hm.data) if (h > peak) peak = h;
    return { radius: s.radius, peak, ratio: peak / s.radius, hm };
  });

  it('peak height scales with footprint — bigger islands are not flatter', () => {
    // THE BUG: peakHeight was a fixed 26 m while the scatter varied radius
    // 110-260 m, so peak/radius ran 0.198 at the smallest island down to
    // 0.149 at the largest. Growth made them MORE pancake-like.
    //
    // Tested by growing ONE island rather than comparing five: same seed →
    // same archetype, so this isolates size from silhouette family. Across
    // different archetypes the ratio SHOULD vary — a cliff table is meant to
    // be taller than a lagoon — and asserting a tight spread over the whole
    // world would forbid exactly the variety the rewrite is for.
    const shape = (radius: number) => {
      const hm = generateIslandHeightmap(WORLD_SEED, {
        ...islandParams,
        radius,
        ...islandPeakHeights(radius),
      });
      let peak = -Infinity;
      for (const h of hm.data) if (h > peak) peak = h;
      return { peak, ratio: peak / radius, archetype: hm.archetype };
    };
    const small = shape(110);
    const large = shape(250);
    expect(small.archetype).toBe(large.archetype); // same family, fair compare
    expect(Math.abs(large.ratio - small.ratio)).toBeLessThan(0.05);
    expect(large.peak).toBeGreaterThan(small.peak);
  });

  it('every silhouette family reads as a landmass, not a sandbar', () => {
    for (const b of built) expect(b.ratio).toBeGreaterThan(0.28);
  });

  it('still leaves ground shallow enough to plant a grove on', () => {
    // steepening trades away plantable area — if this ever drops too far,
    // islandPalmPlacement starts throwing rather than degrading (§Rule 8)
    for (const b of built) {
      let plantable = 0;
      let land = 0;
      const R = b.hm.worldRadius;
      for (let k = 0; k < 2000; k++) {
        const a = (k * 2.399963) % (Math.PI * 2);
        const r = Math.sqrt((k % 101) / 101) * R * 0.95;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        if (b.hm.heightAt(x, z) <= 0) continue;
        land++;
        if (gradientAt(b.hm, x, z) <= islandParams.palmSlopeLimit) plantable++;
      }
      expect(plantable / land).toBeGreaterThan(0.25);
    }
  });
});

describe('§V43 rocks: outcrops at reference scale, not pebbles', () => {
  const hmBig = generateIslandHeightmap(WORLD_SEED, {
    ...islandParams,
    radius: 200,
    ...islandPeakHeights(200),
  });
  const rocks = generateRockPlacements(WORLD_SEED + 1013, hmBig);

  it('reads at the scale of the reference cove, not as gravel', () => {
    // docs/ship-full-view.png: the shore rocks are comparable to the ship's
    // bow — 8-15 m. Ours measured 1.6-5.8 m, which is why they disappeared
    // against the beach instead of framing it.
    const diameters = rocks.map((r) => r.scale * 2);
    expect(Math.max(...diameters)).toBeGreaterThan(8);
    expect(Math.min(...diameters)).toBeGreaterThan(4);
    // …but not so large they become the island
    expect(Math.max(...diameters)).toBeLessThan(hmBig.worldRadius * 0.2);
  });

  it('enough of them straddle the waterline to give §V10 something to break on', () => {
    // rocks in the surf are half the reason a shore reads as a shore
    expect(rocks.filter((r) => r.foamTarget).length).toBeGreaterThanOrEqual(4);
  });
});

describe('§V43 vegetation: palms grow in groves, not scattered', () => {
  const sites = generateIslandSites(WORLD_SEED);

  /** coefficient of variation of angular gaps: 0 = even ring, 1 = Poisson */
  const clusterCV = (positions: [number, number, number][]): number => {
    const ang = positions.map((p) => Math.atan2(p[2], p[0])).sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < ang.length; i++) gaps.push(ang[i] - ang[i - 1]);
    gaps.push(ang[0] + Math.PI * 2 - ang[ang.length - 1]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const varr = gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length;
    return Math.sqrt(varr) / mean;
  };

  it('clusters into stands with genuinely empty beach between them', () => {
    // measured CV was 0.84 — statistically indistinguishable from random,
    // which is exactly what "evenly scattered palms" looks like and the most
    // obvious generated tell on an island (§V43). Poisson is CV = 1.
    for (const s of sites) {
      const hm = generateIslandHeightmap(s.seed, {
        ...islandParams,
        radius: s.radius,
        ...islandPeakHeights(s.radius),
      });
      const palms = generatePlacements(
        islandPalmCount(s.radius),
        s.seed + 2027,
        islandPalmPlacement(hm, islandParams, s.seed + 2027),
      );
      expect(clusterCV(palms.map((p) => p.position))).toBeGreaterThan(1.5);
    }
  });

  it('grove positions are deterministic and differ between islands (§V2)', () => {
    expect(palmGroveAngles(11)).toEqual(palmGroveAngles(11));
    expect(palmGroveAngles(11)).not.toEqual(palmGroveAngles(12));
    expect(palmGroveAngles(11)).toHaveLength(islandParams.palmGroveCount);
  });

  it('every palm still obeys the terrain rules it did before', () => {
    // clustering must not smuggle palms into the sea or onto a cliff
    const hm = generateIslandHeightmap(sites[0].seed, {
      ...islandParams,
      radius: sites[0].radius,
      ...islandPeakHeights(sites[0].radius),
    });
    for (const pl of generatePlacements(40, 5, islandPalmPlacement(hm, islandParams, 5))) {
      const [x, y, z] = pl.position;
      expect(y).toBeGreaterThanOrEqual(islandParams.palmMinHeight);
      expect(y).toBe(hm.heightAt(x, z));
      expect(gradientAt(hm, x, z)).toBeLessThanOrEqual(islandParams.palmSlopeLimit);
    }
  });
});

describe('§V43 silhouette: every island a different shape', () => {
  it('archetypes are distinct across the world while families remain', () => {
    // "the one with the arch" only works if there IS only one. A noise field
    // could never deliver this — the old generator was radially symmetric by
    // construction, so all five islands were the same dome at five sizes.
    const arch = createArchipelago({ seed: WORLD_SEED });
    try {
      const names = arch.islands.map((i) => i.heightmap.archetype);
      expect(new Set(names).size).toBe(names.length);
      for (const island of arch.islands) {
        expect(island.heightmap.features.length).toBeGreaterThan(0);
      }
    } finally {
      arch.dispose();
    }
  });

  it('the coastline is shaped, not a circle', () => {
    // measured 10-16% shore-radius variation before, because noise was scaled
    // BY the dome and so vanished exactly at the rim where coastline lives.
    // Coves, spits and headlands are the whole difference between an island
    // and a hill in water.
    for (const site of generateIslandSites(WORLD_SEED)) {
      const hm = generateIslandHeightmap(site.seed, {
        ...islandParams,
        radius: site.radius,
        ...islandPeakHeights(site.radius),
      });
      const shores: number[] = [];
      for (let i = 0; i < 128; i++) shores.push(findShoreRadius(hm, (i / 128) * Math.PI * 2));
      const mean = shores.reduce((a, b) => a + b, 0) / shores.length;
      const variation = (Math.max(...shores) - Math.min(...shores)) / mean;
      expect(variation).toBeGreaterThan(0.25);
    }
  });

  it('smoothMax does not lift the sea floor where there is nothing to blend', () => {
    // the textbook polynomial adds k/4 whenever its operands are EQUAL, which
    // off-island means 0 vs 0 — it silently raised the entire field and let a
    // zero-height island break the surface
    expect(smoothMax(0, 0, 20)).toBe(0);
    expect(smoothMax(-5, -5, 20)).toBe(-5);
    // …but still blends real features instead of creasing between them
    expect(smoothMax(40, 40, 20)).toBeGreaterThan(40);
    expect(smoothMax(40, 5, 20)).toBe(40); // far apart: plain max
  });
});

describe('§V43 coastline: a cliff somewhere on every island, not sand all round', () => {
  // THE COMPLAINT: "the coastline is uniform — a single skirt of sand all the
  // way round". It was structurally true and measurable. Between
  // `featureExtent` and the rim the height field was nothing but low-amplitude
  // coast noise, and every OTHER feature kind reaches its own rim
  // TANGENTIALLY (`pow(1 − d/r, power)` has zero slope at d = r), so no cone
  // and no ridge could ever put a wall at the waterline. Measured on the
  // shipping params: median coastal slope 4.8-7.6° on all five islands, and
  // the fraction of shoreline steeper than 45° was 0.0% on three of them.
  //
  // A sweep proved the obvious knobs cannot fix it — featureExtent 0.62→0.94
  // moved cliff coast 6%→6% and made the shore ROUNDER (CV 0.256→0.188). Only
  // a profile with a wall in it can, which is what `sheer` headlands are. This
  // test fails the moment headlands are disabled or detuned back to tangency.
  const sites = generateIslandSites(WORLD_SEED);
  const built = sites.map((s) =>
    generateIslandHeightmap(s.seed, {
      ...islandParams,
      radius: s.radius,
      ...islandPeakHeights(s.radius),
    }),
  );

  /** fraction of bearings where the land rises >45° in the first 25 m inland */
  const cliffFraction = (map: (typeof built)[number]): number => {
    const N = 128;
    let steep = 0;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const rs = findShoreRadius(map, a);
      const inland = map.heightAt(Math.cos(a) * (rs - 25), Math.sin(a) * (rs - 25));
      if (Math.atan2(Math.max(inland, 0), 25) > (45 * Math.PI) / 180) steep++;
    }
    return steep / N;
  };

  it('no island shelves gently into the water on every single bearing', () => {
    for (const map of built) expect(cliffFraction(map)).toBeGreaterThan(0.05);
  });

  it('and none of them is cliff the whole way round either', () => {
    // the point is VARIATION. A coast that is all cliff has no beach for the
    // §T33 swash to run up and no grove sites, and reads as uniform in the
    // other direction — which is the same failure wearing different clothes.
    for (const map of built) expect(cliffFraction(map)).toBeLessThan(0.75);
  });

  it('how much cliff differs by silhouette family, so islands stay distinct', () => {
    const fractions = built.map(cliffFraction);
    const spread = Math.max(...fractions) - Math.min(...fractions);
    expect(spread).toBeGreaterThan(0.1);
  });
});

describe('§V43 sea stacks: silhouette that survives to the horizon', () => {
  // Rocks (rocks.ts) cannot do this job however big they get: `lodRockCull`
  // hides the whole batch past 1800 m, so at the 2-4 km range where the
  // silhouette is the ONLY thing left there are no rocks at all. Stacks are
  // height-field features instead — part of the terrain mesh that is already
  // drawn, so no draw call, no pipeline (three appends object.uuid to the
  // material cache key for every InstancedMesh) and no cull distance.
  const sites = generateIslandSites(WORLD_SEED);
  const built = sites.map((s) =>
    generateIslandHeightmap(s.seed, {
      ...islandParams,
      radius: s.radius,
      ...islandPeakHeights(s.radius),
    }),
  );

  it('every island stands at least one sheer feature clear of the water', () => {
    for (const map of built) {
      const sheer = map.features.filter((f) => f.kind === 'sheer');
      expect(sheer.length).toBeGreaterThan(0);
      const standing = sheer.filter((f) => map.heightAt(f.x, f.z) > 2);
      expect(standing.length).toBeGreaterThan(0);
    }
  });

  it('stacks are wide enough to survive the DECIMATED terrain grid', () => {
    // the far LOD takes every `lodTerrainStride`-th vertex, so a stack
    // narrower than a few decimated cells is simply never sampled and
    // disappears at exactly the distance it exists for. Its vertical wall is
    // the inner 55% of the footprint (archetypes.ts `sheer`).
    for (const map of built) {
      const cell = ((2 * map.worldRadius) / (map.size - 1)) * islandParams.lodTerrainStride;
      const offshore = map.features.filter(
        (f) => f.kind === 'sheer' && f.radius < map.worldRadius * 0.25,
      );
      for (const f of offshore) {
        expect(f.radius * 2 * 0.55).toBeGreaterThan(cell * 2);
      }
    }
  });

  it('a stack is a WALL, not a small hill (that is the whole point)', () => {
    // a cone of any exponent still reads as a pointed hill at 3 km; only a
    // vertical edge reads as a stack. Sample across one stack's own wall.
    const map = built.find((m) =>
      m.features.some((f) => f.kind === 'sheer' && f.radius < m.worldRadius * 0.25),
    )!;
    const f = map.features.find(
      (g) => g.kind === 'sheer' && g.radius < map.worldRadius * 0.25,
    )!;
    const top = map.heightAt(f.x, f.z);
    const outside = map.heightAt(f.x + f.radius * 1.05, f.z);
    // rises the bulk of its height inside its own footprint radius
    expect(top - outside).toBeGreaterThan(f.height * 0.4);
  });
});
