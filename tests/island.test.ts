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
import { islandPalmPlacement } from '../src/island/palms';
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
