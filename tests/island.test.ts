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
import {
  generateIslandSites,
  createArchipelago,
  siteParams,
  type IslandSite,
} from '../src/island/archipelago';
import { SHOWCASE_LAGOON, findLagoonAnchorage } from '../src/island/showcase';
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

/**
 * The heightmap a site ACTUALLY builds — archetype override and per-island
 * param overrides included. Every §V43 quality contract below goes through
 * this rather than re-deriving `{...islandParams, radius}`: the showcase island
 * (island/showcase.ts) carries overrides, and a test that ignored them would
 * be measuring an island the world does not contain (§V71 — a part-vs-host
 * test must evaluate the host).
 */
const heightmapForSite = (site: IslandSite) =>
  generateIslandHeightmap(site.seed, siteParams(site));

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
      generateIslandHeightmap(SEED, { ...islandParams, peakHeight: 0, noiseSlope: 0, coastNoiseSlope: 0 }),
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

  it('boulders cluster on the beach/waterline ring, not mid-ocean or on the peak', () => {
    // SCOPED TO THE BOULDER CLASS. This contract was written about the shore
    // scatter and it still holds for it exactly as before. The CLIFF masses
    // added alongside it are a different thing with a different job — they
    // carry the island's silhouette, which means running from inland down
    // into the water — and they get their own bound in the next test.
    for (const rock of rocks.filter((r) => !r.cliff)) {
      const [x, , z] = rock.position;
      const r = Math.hypot(x, z);
      const shore = findShoreRadius(hm, Math.atan2(z, x));
      // placement jitters ±rockSpread around the shoreline; shore radius from
      // the placement angle vs re-derived angle can differ by ~a march step
      expect(Math.abs(r - shore)).toBeLessThanOrEqual(islandParams.rockSpread + 3);
    }
  });

  it('cliff masses stay on the island, and reach both inland and into the sea', () => {
    // The user's ask was "huge big cliffs made out of rock … or it is very
    // contrived as a texture little bits", and the references (ref-island-146,
    // -150) carry the relief in placed granite that runs from the high ground
    // down past the waterline. So the contract is a RANGE, not a ring: masses
    // must exist on both sides of the shoreline, and none may wander off the
    // footprint into open water where they would read as a floating boulder.
    const cliffs = rocks.filter((r) => r.cliff);
    expect(cliffs.length).toBeGreaterThan(0);
    let inland = 0;
    let seaward = 0;
    for (const rock of cliffs) {
      const [x, , z] = rock.position;
      const r = Math.hypot(x, z);
      expect(r).toBeLessThanOrEqual(hm.worldRadius);
      const shore = findShoreRadius(hm, Math.atan2(z, x));
      if (r < shore) inland++;
      else seaward++;
    }
    expect(inland).toBeGreaterThan(0);
    expect(seaward).toBeGreaterThan(0);
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
    heightmap: heightmapForSite(s),
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

/**
 * THE USER-REPORTED DEFECT THIS PINS: "a crazy hard edge border around it —
 * no blending whatsoever with the rest of the ocean."
 *
 * The height FIELD was already continuous across the footprint boundary
 * (27a0795 took a 4.25 m step down to 0.0074 m, and the shelf ramp from a
 * 12.3 m corner disagreement to zero). What was not continuous was the DRAWN
 * SURFACE: the terrain mesh stopped on the square grid and nothing at all was
 * rendered outside it, while the depth field kept ramping to -45 m and the
 * ocean kept shading its shallows against that field. Bright shallow water
 * over nothing, ending on a straight line — showcase.ts describes exactly this
 * and calls the general fix somebody else's job.
 *
 * So the invariant is NOT "the field is smooth" — that one already passed
 * while the border was plainly visible, which is the §Rule 6 failure mode. It
 * is that the floor the player LOOKS AT and the floor the sim SAMPLES are the
 * same floor, everywhere the mesh exists.
 */
describe('§V43 the drawn seabed is the sampled seabed (no hard border)', () => {
  const site: IslandSite = { seed: SEED, position: [0, 0], radius: islandParams.radius };
  const island = { heightmap: hm, center: [0, 0] as [number, number] };

  it('terrain geometry reaches open water, not the footprint edge', () => {
    const g = buildIslandGeometry(hm, islandParams.skirtDepth, 1);
    const pos = g.getAttribute('position');
    let extent = 0;
    for (let i = 0; i < pos.count; i++) {
      extent = Math.max(extent, Math.abs(pos.getX(i)), Math.abs(pos.getZ(i)));
    }
    // the apron has to span the whole shelf the depth field ramps over, or the
    // water goes on reading shallow past where anything is drawn
    expect(extent).toBeCloseTo(R + islandParams.seabedShelfWidth, 3);
  });

  it('every apron vertex sits at the depth the seabed field reports there', () => {
    const g = buildIslandGeometry(hm, islandParams.skirtDepth, 1);
    const pos = g.getAttribute('position');
    const skirtY = -islandParams.seabedOpenDepth - islandParams.skirtDepth;
    let worst = 0;
    let checked = 0;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      // interior grid is the heightmap's own business; the closing skirt is a
      // deliberate vertical drop BELOW open depth, where nothing can see it
      if (Math.max(Math.abs(x), Math.abs(z)) <= R) continue;
      if (Math.abs(y - skirtY) < 1e-6) continue;
      checked++;
      worst = Math.max(worst, Math.abs(y - sampleSeabedHeight([island], x, z, islandParams)));
    }
    expect(checked).toBeGreaterThan(0);
    // one implementation of the ramp, shared — so this is exact, not merely close
    expect(worst).toBeLessThan(1e-3);
  });

  it('the apron descends monotonically — no wall for the eye to catch on', () => {
    // the old geometry ended in a vertical skirt at the rim, which IS the hard
    // border; the apron must never step down faster than it runs outward
    const g = buildIslandGeometry(hm, islandParams.skirtDepth, 1);
    const pos = g.getAttribute('position');
    const skirtY = -islandParams.seabedOpenDepth - islandParams.skirtDepth;
    const byCheb = new Map<number, number>();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const cheb = Math.max(Math.abs(x), Math.abs(z));
      if (cheb <= R || Math.abs(y - skirtY) < 1e-6) continue;
      byCheb.set(Math.round(cheb * 100) / 100, y);
    }
    const rings = [...byCheb.entries()].sort((a, b) => a[0] - b[0]);
    expect(rings.length).toBeGreaterThan(1);
    let maxSlope = 0;
    for (let i = 1; i < rings.length; i++) {
      const run = rings[i][0] - rings[i - 1][0];
      const drop = rings[i - 1][1] - rings[i][1];
      expect(drop).toBeGreaterThanOrEqual(-1e-6); // never rises going seaward
      maxSlope = Math.max(maxSlope, drop / Math.max(run, 1e-6));
    }
    // a shelf, not a cliff: the ramp's steepest point is 1.5·Δdepth/width
    expect(maxSlope).toBeLessThan(0.5);
  });

  it('the ship grounds on the floor it can see (§V8 shares the apron)', () => {
    // buoyancy samples sampleSeabedHeight; the mesh is now the same surface, so
    // "she ran aground on nothing" and "she sailed through a visible bank" are
    // both excluded by the vertex check above. This pins the shared owner.
    const onShelf = sampleSeabedHeight([island], R + islandParams.seabedShelfWidth / 2, 0, islandParams);
    expect(onShelf).toBeLessThan(hm.heightAt(R, 0));
    expect(onShelf).toBeGreaterThan(-islandParams.seabedOpenDepth);
    expect(site.radius).toBe(islandParams.radius);
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
    const hm = heightmapForSite(s);
    let peak = -Infinity;
    for (const h of hm.data) if (h > peak) peak = h;
    return { radius: s.radius, peak, ratio: peak / s.radius, hm };
  });

  it('a bigger island grows SIDEWAYS more than it grows up', () => {
    // THIS ASSERTION HAS BEEN WRONG TWICE, IN OPPOSITE DIRECTIONS, AND THE
    // SECOND VERSION IS WHY EVERY ISLAND WAS A CONE.
    //
    // v1: `peakHeight` was a fixed 26 m against a 110-260 m scatter, so
    // peak/radius ran 0.198 down to 0.149 — growth made islands MORE
    // pancake-like. Fixed by scaling peak LINEARLY with radius.
    //
    // v2 (this test's previous form) then pinned |Δratio| < 0.05, i.e. it
    // REQUIRED peak/radius to be constant. A constant ratio means a big island
    // is a SCALED COPY of a small one — it can never be a broader landmass,
    // only a larger cone — and measured across every family and radius the
    // ratio sat at 0.38-0.52 with all five medians inside one narrow band.
    // The test passed the whole time. It was enforcing the defect.
    //
    // v3: growth must be SUB-LINEAR. The absolute peak still rises with
    // footprint (an island that grew without getting taller at all would go
    // back to v1's pancake), but the ratio must FALL, because that is what
    // "broader, not taller" means. Same seed → same family, so this isolates
    // size from silhouette.
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
    expect(large.peak).toBeGreaterThan(small.peak); // still grows (v1's guard)
    expect(large.ratio).toBeLessThan(small.ratio * 0.85); // but grows WIDER
  });

  it('the world spans sandbars AND cliff islands, not one shape at five sizes', () => {
    // REPLACES a flat `ratio > 0.28` on every island, which forbade the
    // sandbar outright — and the art direction (docs/inspo/island/) is more
    // than half sandbar: broad sand platforms a couple of metres proud with
    // the relief carried by boulders, not terrain.
    //
    // §V43's actual demand is that islands be identifiable from kilometres
    // out, which is a statement about the SPREAD, not about any one island's
    // height. The old params measured a spread of 0.38-0.52 — a factor of 1.3,
    // five copies of one cone. `ARCHETYPE_RELIEF` is what buys the range, so
    // this fails the moment someone re-flattens it to a single global height.
    const ratios = built.map((b) => b.ratio);
    const lo = Math.min(...ratios);
    const hi = Math.max(...ratios);
    expect(hi / lo).toBeGreaterThan(3); // genuinely different silhouettes
    expect(hi).toBeGreaterThan(0.2); // at least one island still reads TALL
    // and nothing is so flat it stops being an island: every one must carry
    // dry land the sea cannot simply wash over
    for (const b of built) expect(b.peak).toBeGreaterThan(6);
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

describe('§V43 habitability: there has to be somewhere to stand', () => {
  // THE TEST THAT WAS MISSING, and its absence is why the defect shipped.
  // Every structural guard passed the whole time — rim submerged, peak floor,
  // determinism, "a low-gradient sample exists near the shore" — while the
  // islands were cones nobody could build on. The user's words were "it
  // doesn't feel like one could build a house there, or like there could be a
  // marina", so the measurement is the largest CONTIGUOUS patch of buildable
  // ground, not a count of scattered samples that happen to be flat.
  //
  // MEASURED BEFORE THE FIX: the largest such patch anywhere in the world was
  // 222 m² with a 4.6 m inscribed radius — and 4.09 m is ONE grid cell, so
  // those patches were sampling accidents, not terrain. The ship is 35 m long.
  //
  // The inscribed radius is the load-bearing half. Area alone is satisfiable
  // by a long thin ribbon of coastline; a building needs a disc.
  const buildable = (hm: ReturnType<typeof generateIslandHeightmap>) => {
    const n = hm.size;
    const R = hm.worldRadius;
    const cell = (2 * R) / (n - 1);
    const limit = Math.tan((6 * Math.PI) / 180);
    const mask = new Uint8Array(n * n);
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const x = -R + ix * cell;
        const z = -R + iz * cell;
        // above the swash band (shoreRunup owns 0-1 m) and gently sloping
        if (hm.data[iz * n + ix] > 1 && gradientAt(hm, x, z) < limit) mask[iz * n + ix] = 1;
      }
    }
    // largest 4-connected component, then its inscribed radius by chamfer
    const comp = new Int32Array(n * n).fill(-1);
    let bestId = -1;
    let bestCells = 0;
    let id = 0;
    const stack: number[] = [];
    for (let i = 0; i < n * n; i++) {
      if (mask[i] !== 1 || comp[i] !== -1) continue;
      let count = 0;
      stack.push(i);
      comp[i] = id;
      while (stack.length > 0) {
        const q = stack.pop() as number;
        count++;
        const qx = q % n;
        const qz = (q / n) | 0;
        const nb = [qx > 0 ? q - 1 : -1, qx < n - 1 ? q + 1 : -1, qz > 0 ? q - n : -1, qz < n - 1 ? q + n : -1];
        for (const m of nb) if (m >= 0 && mask[m] === 1 && comp[m] === -1) { comp[m] = id; stack.push(m); }
      }
      if (count > bestCells) { bestCells = count; bestId = id; }
      id++;
    }
    if (bestId < 0) return { area: 0, inscribed: 0 };
    const dist = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) dist[i] = comp[i] === bestId ? 1e9 : 0;
    for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) {
      const i = iz * n + ix;
      if (dist[i] === 0) continue;
      let d = 1e9;
      if (ix > 0) d = Math.min(d, dist[i - 1] + 1);
      if (iz > 0) d = Math.min(d, dist[i - n] + 1);
      if (ix > 0 && iz > 0) d = Math.min(d, dist[i - n - 1] + 1.4142);
      if (ix < n - 1 && iz > 0) d = Math.min(d, dist[i - n + 1] + 1.4142);
      dist[i] = Math.min(dist[i], d);
    }
    let inscribed = 0;
    for (let iz = n - 1; iz >= 0; iz--) for (let ix = n - 1; ix >= 0; ix--) {
      const i = iz * n + ix;
      if (comp[i] !== bestId) continue;
      let d = dist[i];
      if (ix < n - 1) d = Math.min(d, dist[i + 1] + 1);
      if (iz < n - 1) d = Math.min(d, dist[i + n] + 1);
      if (ix < n - 1 && iz < n - 1) d = Math.min(d, dist[i + n + 1] + 1.4142);
      if (ix > 0 && iz < n - 1) d = Math.min(d, dist[i + n - 1] + 1.4142);
      dist[i] = d;
      if (d > inscribed) inscribed = d;
    }
    return { area: bestCells * cell * cell, inscribed: inscribed * cell };
  };

  it('the anchorage island could hold a settlement', () => {
    // the showcase island is the one the player parks at and walks on, so it
    // carries the bar: room for a marina, not just for a hut
    const sites = generateIslandSites(WORLD_SEED);
    const hm = heightmapForSite(sites[0]);
    const b = buildable(hm);
    expect(b.area).toBeGreaterThan(8_000);
    expect(b.inscribed).toBeGreaterThan(15);
  });

  it('every island in the world has somewhere a building could stand', () => {
    // a hut is ~8 x 10 m, so a 6 m inscribed radius is the floor. This is the
    // assertion that fails if `noiseSlope` is ever put back on a peak-relative
    // amplitude, because that is what ate the flat ground last time.
    for (const site of generateIslandSites(WORLD_SEED)) {
      const b = buildable(heightmapForSite(site));
      expect(b.inscribed).toBeGreaterThan(6);
    }
  });

  it('the beach is a beach — a 2-6 deg grade over a walkable run', () => {
    // "a beach doesn't go down with like 12 or 15 or 20 or 25 degrees" (user).
    // Measured before the fix: 19 deg at the r/R 0.6-0.8 band and a 6.0 m run
    // from the waterline to +2 m. The old apron could not fix it at ANY band
    // width because it was a vertical remap at a fixed horizontal position —
    // see heightmap.beachApron for the derivation.
    const sites = generateIslandSites(WORLD_SEED);
    const hm = heightmapForSite(sites[0]);
    const runs: number[] = [];
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      const shore = findShoreRadius(hm, a);
      for (let k = 0; k <= 400; k++) {
        const r = shore - k * 0.5;
        if (r < 0) break;
        if (hm.heightAt(Math.cos(a) * r, Math.sin(a) * r) >= 1.5) { runs.push(shore - r); break; }
      }
    }
    runs.sort((x, y) => x - y);
    const median = runs[runs.length >> 1];
    const grade = (Math.atan2(1.5, median) * 180) / Math.PI;
    expect(grade).toBeLessThan(8);
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
      const hm = heightmapForSite(s);
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
    const hm = heightmapForSite(sites[0]);
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
      const hm = heightmapForSite(site);
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
  const built = sites.map(heightmapForSite);

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

  it('the WORLD carries cliff coast, even though a sandbar does not', () => {
    // WAS: every island had to clear 0.05. That was right while every island
    // was meant to be a mountain, and it became wrong the moment the art
    // direction asked for sandbars — this test measures a 45° rise over the
    // first 25 m inland, which a 11 m island physically cannot produce, so on
    // `lagoon` and `crestedDome` it was asserting something the family is
    // defined by NOT having.
    //
    // The complaint it was written for was "a single skirt of sand all the way
    // round" — a statement about the world reading as uniform. So the bar is
    // that cliff coast EXISTS and is not spread evenly, which is what
    // `HEADLAND_AFFINITY` and `ARCHETYPE_RELIEF` together are for. A world
    // where every island scored 0 is still caught.
    const fractions = built.map(cliffFraction);
    expect(Math.max(...fractions)).toBeGreaterThan(0.15);
    expect(fractions.filter((f) => f > 0.05).length).toBeGreaterThanOrEqual(2);
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
  const built = sites.map(heightmapForSite);

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

// ---------------------------------------------------------------------------
// §T52 — THE SHOWCASE LAGOON. These are venue contracts, not shape trivia:
// each one is a system that had nowhere to be observed before this island
// existed, expressed as the thing that must be true for it to be observable.
// Swept over several world seeds on purpose — the island is hand-PLACED but
// still seeded, so "it works on 1337" is not the claim being made.
// ---------------------------------------------------------------------------
describe('§T52 showcase lagoon: a venue for the shore systems', () => {
  const WORLD_SEEDS = [1337, 42, 7, 20259, 999];
  const showcaseOf = (seed: number) => {
    const site = generateIslandSites(seed)[0];
    return { site, hm: heightmapForSite(site) };
  };
  /** m² of the footprint whose depth falls in [lo, hi) */
  const areaBetween = (
    hm: ReturnType<typeof heightmapForSite>,
    lo: number,
    hi: number,
  ): number => {
    const R = hm.worldRadius;
    const N = 260;
    const cell = ((2 * R) / (N - 1)) ** 2;
    let area = 0;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const x = -R + (2 * R * i) / (N - 1);
        const z = -R + (2 * R * j) / (N - 1);
        if (Math.hypot(x, z) > R) continue;
        const d = -hm.heightAt(x, z);
        if (d >= lo && d < hi) area += cell;
      }
    }
    return area;
  };

  it('is the first island in the layout, hand-placed and off the starboard bow', () => {
    // the ship spawns at the origin facing +z, so +x is to her right. It has
    // to be sites[0] because generateIslandSites seeds the rejection loop with
    // it — that ordering is what makes the scattered islands route around it.
    for (const seed of WORLD_SEEDS) {
      const site = generateIslandSites(seed)[0];
      expect(site.position).toEqual(SHOWCASE_LAGOON.position);
      expect(site.archetype).toBe('lagoon');
      expect(site.position[0]).toBeGreaterThan(0);
    }
  });

  it('still obeys every rule the scattered islands obey', () => {
    // a hand-placed exception that quietly broke the spawn clearance or the
    // inter-island gap would be exactly the "magic entry" this is not
    for (const seed of WORLD_SEEDS) {
      const sites = generateIslandSites(seed);
      expect(sites).toHaveLength(islandParams.islandCount);
      for (const s of sites) {
        const d = Math.hypot(s.position[0], s.position[1]);
        expect(d - s.radius).toBeGreaterThanOrEqual(islandParams.spawnClearance);
      }
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
    }
  });

  it('holds a lagoon that never drains, because the sea it sits in is 4 m deep', () => {
    // THE POINT. There is no shoaling: the ocean surface swings its full
    // open-ocean amplitude over a 1 m floor exactly as over 45 m, and the
    // measured deepest trough in the shipped `swell` sea is -3.96 m. A floor
    // shallower than that is EXPOSED — the water mesh drops below the sand and
    // the lagoon flickers dry once per wave. So the basin clears the trough,
    // and this is the assertion that stops anyone "fixing" it shallower.
    const SWELL_TROUGH = -3.96;
    for (const seed of WORLD_SEEDS) {
      const { hm } = showcaseOf(seed);
      expect(hm.lagoonCenter).not.toBeNull();
      const alwaysWet = areaBetween(hm, -SWELL_TROUGH, 8);
      expect(alwaysWet).toBeGreaterThan(30_000);
      // and it is a FLOOR, not a hole: the basin centre sits at the authored
      // depth rather than wherever the noise left it
      const [cx, cz] = hm.lagoonCenter!;
      expect(-hm.heightAt(cx, cz)).toBeGreaterThan(3.5);
      expect(-hm.heightAt(cx, cz)).toBeLessThan(6);
    }
  });

  it('keeps a broad 0-3 m shelf, which is where the shore break actually is', () => {
    // The user asked for 1-3 m of standing water. In this sea that band cannot
    // stand — it dries and refloods every cycle. That is not a compromise: the
    // drying band IS the swash `terrain/shoreRunup.ts` paints, so it is the
    // thing worth having. It must be big enough to read from a ship's deck.
    for (const seed of WORLD_SEEDS) {
      const { hm } = showcaseOf(seed);
      expect(areaBetween(hm, 0, 3)).toBeGreaterThan(15_000);
    }
  });

  it('opens to the sea instead of being a landlocked crater', () => {
    // The `lagoon` archetype alone does NOT give this. Its lobes sit at ring
    // 0.50-0.62·extent with radius 0.34-0.46·extent, so each reaches ±33-67°
    // and the two bounding its gap close it from the sides: measured 1-7% of
    // bearings open, widest mouth 2-22°, with the basin at the island origin.
    // Pushing the basin out along the archetype's own least-land bearing is
    // what turns the crater into a cove — and a cove you cannot see into is
    // not a venue.
    for (const seed of WORLD_SEEDS) {
      const { hm } = showcaseOf(seed);
      const [cx, cz] = hm.lagoonCenter!;
      const R = hm.worldRadius;
      const N = 180;
      const open: boolean[] = [];
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2;
        let clear = true;
        for (let r = 0; r <= 2 * R; r += 2) {
          const x = cx + Math.cos(a) * r;
          const z = cz + Math.sin(a) * r;
          if (Math.hypot(x, z) > R) break; // reached open sea
          if (hm.heightAt(x, z) > 0) { clear = false; break; }
        }
        open.push(clear);
      }
      let run = 0;
      let widest = 0;
      for (let i = 0; i < N * 2; i++) {
        if (open[i % N]) { run++; widest = Math.max(widest, run); } else run = 0;
      }
      expect(Math.min(widest, N) * (360 / N)).toBeGreaterThan(90);
    }
  });

  it('offers a berth she will not ground on, facing the lagoon', () => {
    // draft 2 m + the 3.96 m trough = 5.96 m before the keel touches at all,
    // and `stepShipGrounding` tests the KEEL, so a berth measured only at the
    // ship's origin can still drop her bow onto a bank (§V54: give the lumped
    // model the body's own extent).
    for (const seed of WORLD_SEEDS) {
      const { hm } = showcaseOf(seed);
      const a = findLagoonAnchorage(hm);
      expect(a.depth).toBeGreaterThanOrEqual(7);
      for (let i = 0; i < 16; i++) {
        const t = (i / 16) * Math.PI * 2;
        const d = -hm.heightAt(a.x + Math.cos(t) * 22, a.z + Math.sin(t) * 22);
        expect(d).toBeGreaterThanOrEqual(6.2);
      }
      // and she is pointed at the lagoon, not away from it: heading is a yaw
      // about +Y, which maps her forward [0,0,1] to [sin, 0, cos]
      const [cx, cz] = hm.lagoonCenter!;
      const fwd = [Math.sin(a.heading), Math.cos(a.heading)];
      const toLagoon = [cx - a.x, cz - a.z];
      const len = Math.hypot(toLagoon[0], toLagoon[1]);
      expect((fwd[0] * toLagoon[0] + fwd[1] * toLagoon[1]) / len).toBeGreaterThan(0.99);
      // close enough that the beach behind the lagoon is in frame, not a smudge
      expect(len).toBeLessThan(hm.worldRadius);
    }
  });

  it('leaves every other island in the world exactly as it was', () => {
    // the basin is opt-in (`lagoonDepth` 0) so a change made for one island
    // cannot silently reshape the other four
    for (const seed of WORLD_SEEDS) {
      for (const site of generateIslandSites(seed).slice(1)) {
        const hm = heightmapForSite(site);
        expect(hm.lagoonCenter).toBeNull();
        expect(siteParams(site).lagoonDepth).toBe(0);
      }
    }
  });

  it('the basin can never turn water into land, or make land taller', () => {
    // THE GUARANTEE, stated as h' = h(1-w) + target·w with target < 0 and
    // w in [0,1]  =>  h' <= max(h, target) <= max(h, 0). Tested against the
    // SAME island with the basin switched off, so it is a claim about the
    // operator rather than about one tuning of it.
    //
    // Note what is deliberately NOT claimed: the basin does RAISE ground that
    // was deeper than the floor — lifting a noise hole up to the sand is half
    // its job. And it yields to the archetype's own lobes, so an islet inside
    // the disc stays an islet. Both are why the naive "everything near the
    // centre is water" version of this test failed, correctly.
    for (const seed of WORLD_SEEDS) {
      const site = generateIslandSites(seed)[0];
      const withBasin = heightmapForSite(site);
      const without = generateIslandHeightmap(site.seed, {
        ...siteParams(site),
        lagoonDepth: 0,
      });
      const R = withBasin.worldRadius;
      let changed = 0;
      for (let i = 0; i < 120; i++) {
        for (let j = 0; j < 120; j++) {
          const x = -R + (2 * R * i) / 119;
          const z = -R + (2 * R * j) / 119;
          const a = withBasin.heightAt(x, z);
          const b = without.heightAt(x, z);
          if (b <= 0) expect(a).toBeLessThanOrEqual(0);
          if (Math.abs(a - b) > 0.05) changed++;
        }
      }
      // ...and it did something, or the guarantee above is vacuous
      expect(changed).toBeGreaterThan(500);
    }
  });
});
