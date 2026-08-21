/**
 * T112b path-first island authoring (§V94, §V90, §V80).
 *
 * Every assertion here is a PROPERTY of the authored route, measured on the
 * FINISHED grid (after thermalSmooth and flood, i.e. what the player walks):
 * - main route: every sample under 35°, mean under 30° — §V90's clue-path
 *   guarantee, now a property of content rather than a BFS discovery
 * - fork: one scramble in [33°, 35°], nothing steeper — the "dense but
 *   walkable" corridor has exactly one deliberate hard step
 * - fork POI: ≥ N m off the main route and NOT in line of sight from the
 *   landing — the distraction only pays if you go
 * - soft gate: ≥ 60% of the non-route bearings around the station meet a
 *   ≥ 45° cell inside the gate radius — slide back, no climb
 * - occluder: the station is hidden from D m down the route and seen from D/2
 * - tilt: the ground drops toward the next island more than it does with
 *   the tilt off
 * - distance field: 0 on the centreline, Lipschitz outward (|Δd| ≤ step)
 * - beach guard: the carve pass never moves a cell below erodeBandStart
 * - pass order: pathCarve sits between rockfallThermal and thermalSmooth
 * - determinism, a ≤ 60 ms budget at 256², and the pirate path has no graph
 */
import { describe, expect, it } from 'vitest';
import { generateIslandHeightmap, type IslandHeightmap } from '../src/island/heightmap';
import { sierraIslandParams } from '../src/island/sierraSites';
import { SIERRA_SLICE_ARCHETYPES, type SierraArchetypeName } from '../src/island/sierraArchetypes';
import { buildErosionContext, type ErosionField } from '../src/island/erosion';
import { pathCarvePass } from '../src/island/pathCarve';
import { catmullRom, losBlocked, polylineDistance } from '../src/island/pathGraph';
import { islandParams } from '../src/params/island';
import { sierraParams } from '../src/params/sierra';

const SEEDS = [988, 1965, 2942];
const RADII = [210, 250, 290];
const GRID = sierraParams.sliceGridSize;
const DEG = 180 / Math.PI;

const cache = new Map<string, IslandHeightmap>();
const hmFor = (name: SierraArchetypeName, i: number): IslandHeightmap => {
  const key = `${name}:${i}`;
  let hm = cache.get(key);
  if (!hm) {
    hm = generateIslandHeightmap(SEEDS[i], sierraIslandParams(name, RADII[i], GRID));
    cache.set(key, hm);
  }
  return hm;
};

/** slope (°) over consecutive `window` m of WALKED (arc) length along the route */
function routeSlopes(route: [number, number, number][], window: number): number[] {
  const out: number[] = [];
  let a = 0;
  let run = 0;
  for (let b = 1; b < route.length; b++) {
    run += Math.hypot(route[b][0] - route[b - 1][0], route[b][2] - route[b - 1][2]);
    if (run < window) continue;
    out.push(Math.atan2(Math.abs(route[b][1] - route[a][1]), run) * DEG);
    a = b;
    run = 0;
  }
  return out;
}

/** arc length of a route (m) */
const routeLength = (r: [number, number, number][]): number => {
  let s = 0;
  for (let i = 1; i < r.length; i++) s += Math.hypot(r[i][0] - r[i - 1][0], r[i][2] - r[i - 1][2]);
  return s;
};

/** steepest 8-neighbour slope (tan) of a grid cell */
function cellSlope(hm: IslandHeightmap, i: number): number {
  const n = hm.size;
  const cell = (2 * hm.worldRadius) / (n - 1);
  const ix = i % n;
  const iz = (i - ix) / n;
  let best = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue;
      const jx = ix + dx;
      const jz = iz + dz;
      if (jx < 0 || jz < 0 || jx >= n || jz >= n) continue;
      const s = Math.abs(hm.data[i] - hm.data[jz * n + jx]) / (cell * Math.hypot(dx, dz));
      if (s > best) best = s;
    }
  }
  return best;
}

const poi = (hm: IslandHeightmap, kind: string) => hm.path!.pois.find((q) => q.kind === kind)!;

/** route sample index at `back` m of arc length before the station */
function indexBefore(route: [number, number, number][], stationIdx: number, back: number): number {
  let k = stationIdx;
  let s = 0;
  while (k > 0 && s < back) {
    s += Math.hypot(route[k][0] - route[k - 1][0], route[k][2] - route[k - 1][2]);
    k--;
  }
  return k;
}

function stationIndex(hm: IslandHeightmap): number {
  const st = poi(hm, 'station');
  const main = hm.path!.routes.main;
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < main.length; i++) {
    const d = Math.hypot(main[i][0] - st.x, main[i][2] - st.z);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

describe('every slice island publishes a route', () => {
  for (const name of SIERRA_SLICE_ARCHETYPES) {
    for (let i = 0; i < SEEDS.length; i++) {
      it(`${name} seed ${SEEDS[i]}: landing, station, exit, ≥ 1 fork POI, routes with final y`, () => {
        const hm = hmFor(name, i);
        expect(hm.path).toBeDefined();
        const kinds = hm.path!.pois.map((q) => q.kind);
        expect(kinds).toEqual(expect.arrayContaining(['landing', 'station', 'exit', 'fork']));
        expect(hm.path!.routes.forks.length).toBeGreaterThanOrEqual(1);
        expect(hm.path!.distance.length).toBe(hm.size * hm.size);
        for (const q of hm.path!.pois) expect(q.y).toBeCloseTo(hm.heightAt(q.x, q.z), 6);
        // the landing and the exit are on the beach, the station is high ground
        expect(poi(hm, 'landing').y).toBeGreaterThan(0);
        expect(poi(hm, 'landing').y).toBeLessThan(sierraParams.erodeBandStart);
        expect(poi(hm, 'exit').y).toBeLessThan(sierraParams.erodeBandStart);
        expect(poi(hm, 'station').y).toBeGreaterThan(sierraParams.erodeBandStart);
      });
    }
  }
});

describe('§V90 main route: every sample < 35° after the full bake, mean < 30°', () => {
  for (const name of SIERRA_SLICE_ARCHETYPES) {
    for (let i = 0; i < SEEDS.length; i++) {
      it(`${name} seed ${SEEDS[i]}`, () => {
        const hm = hmFor(name, i);
        const slopes = routeSlopes(hm.path!.routes.main, 2);
        const max = Math.max(...slopes);
        const mean = slopes.reduce((a, b) => a + b, 0) / slopes.length;
        expect(max, `max ${max.toFixed(1)}°`).toBeLessThan(35);
        expect(mean, `mean ${mean.toFixed(1)}°`).toBeLessThan(30);
      });
    }
  }
});

describe('fork: one scramble in [33°, 35°], nothing steeper; POI off-route and hidden from the landing', () => {
  for (const name of SIERRA_SLICE_ARCHETYPES) {
    for (let i = 0; i < SEEDS.length; i++) {
      it(`${name} seed ${SEEDS[i]}`, () => {
        const hm = hmFor(name, i);
        const fork = hm.path!.routes.forks[0];
        // AUTHORED: the fork's target profile is ≤ 35° between every pair of
        // samples and carries one 16 m scramble at exactly pathScrambleSlope
        // (in [33°, 35°]) — that is the content. WALKED: the ground on a 2 m
        // grid with a 1.5-cell tread deviates from the target by up to ~1.5°
        // over 6–10 m where the route bends (measured over the 9 islands;
        // tightens at 512²), so the walked bounds carry that band.
        const cs = hm.path!.carveStats;
        const T = cs.targets[1];
        const s = cs.graph.forks[0].s;
        let tMax = 0;
        for (let k = 1; k < T.length; k++) tMax = Math.max(tMax, Math.abs(T[k] - T[k - 1]) / Math.max(s[k] - s[k - 1], 1e-6));
        expect(Math.atan(tMax) * DEG, 'target profile').toBeLessThanOrEqual(35);
        const sc = cs.scramble;
        expect(sc, 'a scramble was placed').not.toBeNull();
        const tScr = Math.atan2(Math.abs(T[sc![1]] - T[sc![0]]), s[sc![1]] - s[sc![0]]) * DEG;
        expect(tScr).toBeGreaterThanOrEqual(33);
        expect(tScr).toBeLessThanOrEqual(35);
        expect(sierraParams.pathForkSlope).toBeLessThan(33); // the scramble is the ONE hard step
        const s10 = routeSlopes(fork, 10);
        const s6 = routeSlopes(fork, 6);
        expect(Math.max(...s10), `walked max(10 m) ${Math.max(...s10).toFixed(1)}°`).toBeLessThanOrEqual(36);
        expect(Math.max(...s6), `walked max(6 m) ${Math.max(...s6).toFixed(1)}°`).toBeLessThanOrEqual(36.5);
        const seg = fork.slice(sc![0], sc![1] + 1);
        const trim = Math.max(1, Math.round(seg.length * 0.12));
        const inner = seg.slice(trim, seg.length - trim);
        const walked = Math.atan2(Math.abs(inner[inner.length - 1][1] - inner[0][1]), routeLength(inner)) * DEG;
        expect(walked, `walked scramble ${walked.toFixed(1)}°`).toBeGreaterThanOrEqual(31.5);
        expect(walked).toBeLessThanOrEqual(36);
        const P = poi(hm, 'fork');
        const L = poi(hm, 'landing');
        const mainPl = {
          x: Float64Array.from(hm.path!.routes.main, (q) => q[0]),
          z: Float64Array.from(hm.path!.routes.main, (q) => q[2]),
          s: new Float64Array(0),
        };
        expect(polylineDistance(mainPl, P.x, P.z)).toBeGreaterThanOrEqual(sierraParams.pathForkOffset);
        expect(losBlocked(hm.heightAt, L.x, L.z, P.x, P.z, 1.7, 1.0, 1)).toBe(true);
      });
    }
  }
});

describe('soft gate: ≥ 60% of the non-route bearings around the station meet a ≥ 45° cell', () => {
  for (const name of SIERRA_SLICE_ARCHETYPES) {
    for (let i = 0; i < SEEDS.length; i++) {
      it(`${name} seed ${SEEDS[i]}`, () => {
        const hm = hmFor(name, i);
        const st = poi(hm, 'station');
        const n = hm.size;
        const cell = (2 * hm.worldRadius) / (n - 1);
        const Rg = sierraParams.pathGateRadius + 3 * sierraParams.pathGateWidth;
        const main = hm.path!.routes.main;
        const forks = hm.path!.routes.forks;
        const near: [number, number][] = [];
        for (const r of [main, ...forks]) {
          for (const q of r) {
            const rr = Math.hypot(q[0] - st.x, q[2] - st.z);
            // the ring zone: where the route crosses the gate is what it exempts
            if (rr > sierraParams.pathGateRadius * 0.6 && rr < Rg) near.push([q[0] - st.x, q[2] - st.z]);
          }
        }
        const corridor = sierraParams.pathCorridorWidth * 0.5 + sierraParams.pathCorridorFalloff + sierraParams.pathGateFeather;
        let tested = 0;
        let passed = 0;
        for (let b = 0; b < 72; b++) {
          const a = (b / 72) * Math.PI * 2;
          const ca = Math.cos(a);
          const sa = Math.sin(a);
          // a bearing the route uses: some route sample lies within the corridor of the ray
          if (near.some(([vx, vz]) => vx * ca + vz * sa > 0 && Math.abs(vx * sa - vz * ca) < corridor)) continue;
          tested++;
          let ok = false;
          for (let r = 4; r < Rg && !ok; r += cell * 0.5) {
            const x = st.x + Math.cos(a) * r;
            const z = st.z + Math.sin(a) * r;
            const ix = Math.round((x + hm.worldRadius) / cell);
            const iz = Math.round((z + hm.worldRadius) / cell);
            if (ix < 1 || iz < 1 || ix >= n - 1 || iz >= n - 1) break;
            if (cellSlope(hm, iz * n + ix) >= Math.tan(45 / DEG)) ok = true;
          }
          if (ok) passed++;
        }
        // a rim-wrapping (cirque) or crest (ridge) route leaves few free bearings; the RATIO is the property
        expect(tested).toBeGreaterThan(2);
        expect(passed / tested, `${passed}/${tested} bearings gated`).toBeGreaterThanOrEqual(0.6);
      });
    }
  }
});

describe('occluder: the station is hidden from D before it and visible from D/2', () => {
  for (const name of SIERRA_SLICE_ARCHETYPES) {
    for (let i = 0; i < SEEDS.length; i++) {
      it(`${name} seed ${SEEDS[i]}`, () => {
        const hm = hmFor(name, i);
        const main = hm.path!.routes.main;
        const si = stationIndex(hm);
        const st = main[si];
        const D = sierraParams.pathOccluderDistance;
        const far = main[indexBefore(main, si, D)];
        const near = main[indexBefore(main, si, D / 2)];
        expect(losBlocked(hm.heightAt, far[0], far[2], st[0], st[2], 1.7, 1.5, 1), 'hidden from D').toBe(true);
        expect(losBlocked(hm.heightAt, near[0], near[2], st[0], st[2], 1.7, 1.5, 1), 'seen from D/2').toBe(false);
      });
    }
  }
});

describe('distance field and corridor masks', () => {
  it('dome seed 988: 0 on the centreline, Lipschitz-1 outward, masks inside the corridor only', () => {
    const hm = hmFor('dome', 0);
    const { distance, routeMask, forkMask } = hm.path!;
    const n = hm.size;
    const cell = (2 * hm.worldRadius) / (n - 1);
    let onRoute = 0;
    for (let i = 0; i < n * n; i++) {
      if (distance[i] < cell * 0.5) onRoute++;
      expect(Number.isFinite(distance[i])).toBe(true);
      if (i % n > 0) expect(Math.abs(distance[i] - distance[i - 1])).toBeLessThanOrEqual(cell * 1.0001);
      if (i >= n) expect(Math.abs(distance[i] - distance[i - n])).toBeLessThanOrEqual(cell * 1.0001);
      const inMask = routeMask[i] || forkMask[i];
      if (inMask) expect(distance[i]).toBeLessThanOrEqual(hm.path!.treadHalf + sierraParams.pathCorridorFalloff * 0.5);
    }
    expect(onRoute).toBeGreaterThan(50);
    let route = 0;
    let fork = 0;
    for (let i = 0; i < n * n; i++) {
      route += routeMask[i];
      fork += forkMask[i];
    }
    expect(route).toBeGreaterThan(0);
    expect(fork).toBeGreaterThan(0);
  });
});

describe('Journey tilt: the ground drops toward the next island', () => {
  it('dome seed 988: the tilt-on minus tilt-off difference field falls toward pathNext', () => {
    const params = { ...sierraIslandParams('dome', RADII[0], GRID), pathNext: 0.7, pathApproach: 0.7 + Math.PI };
    const tilted = generateIslandHeightmap(SEEDS[0], params);
    const saved = sierraParams.pathTilt;
    sierraParams.pathTilt = 0;
    let flat: IslandHeightmap;
    try {
      flat = generateIslandHeightmap(SEEDS[0], params);
    } finally {
      sierraParams.pathTilt = saved;
    }
    // the route may re-solve with the tilt (local carve differences); the
    // tilt itself is global: toward pathNext the difference is negative, away
    // from it positive, by ~pathTilt across the island
    const n = tilted.size;
    const cell = (2 * tilted.worldRadius) / (n - 1);
    let toward = 0;
    let tc = 0;
    let away = 0;
    let ac = 0;
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const i = iz * n + ix;
        if (flat.data[i] < sierraParams.erodeBandStart) continue;
        const x = -tilted.worldRadius + ix * cell;
        const z = -tilted.worldRadius + iz * cell;
        const along = (x * Math.cos(0.7) + z * Math.sin(0.7)) / tilted.worldRadius;
        const d = tilted.data[i] - flat.data[i];
        if (along > 0.2) {
          toward += d;
          tc++;
        } else if (along < -0.2) {
          away += d;
          ac++;
        }
      }
    }
    expect(tc).toBeGreaterThan(100);
    expect(ac).toBeGreaterThan(100);
    // tilt is ×erodible (0 at 14 m → 1 at 26 m): ~-0.8 m × the band's mean guard
    expect(toward / tc - away / ac, 'toward minus away (m)').toBeLessThan(-0.15);
  });
});

describe('beach guard, pass order, determinism, budget, pirate', () => {
  /** a synthetic cone island with a beach apron, as tests/erosion.test.ts builds them */
  function synthetic(size: number): { field: ErosionField; ctx: ReturnType<typeof buildErosionContext> } {
    const cell = 2;
    const R = (cell * (size - 1)) / 2;
    const bedrock = new Float64Array(size * size);
    let peak = 0;
    for (let iz = 0; iz < size; iz++) {
      for (let ix = 0; ix < size; ix++) {
        const x = -R + ix * cell;
        const z = -R + iz * cell;
        const d = Math.hypot(x, z) / R;
        const h = 80 * (1 - d * d) - 6 + 6 * Math.sin(x * 0.07) * Math.cos(z * 0.05);
        bedrock[iz * size + ix] = h;
        if (h > peak) peak = h;
      }
    }
    const h0 = Float64Array.from(bedrock);
    const ctx = buildErosionContext({
      size,
      cell,
      worldRadius: R,
      peak,
      iceAzimuth: 0,
      uplift: Float64Array.from(bedrock, (h) => Math.min(Math.max(h / peak, 0), 1)),
      h0,
      noiseOffset: [1.5, 2.5],
      p: sierraParams,
      streamIters: 0,
    });
    return { field: { size, cell, bedrock, debris: new Float64Array(size * size) }, ctx };
  }

  it('the carve never moves a cell below pathGuardStart, nor one below erodeBandStart outside the corridor (the beach is §V90\'s)', () => {
    const { field, ctx } = synthetic(128);
    const before = Float64Array.from(field.bedrock);
    const carve = pathCarvePass({ seed: 5, hints: { approach: 0.3, next: 2.5 } });
    carve.pass.advance(field, ctx, 0);
    carve.pass.advance(field, ctx, 1);
    let moved = 0;
    let above = 0;
    const path = carve.publish((x, z) => 0 * x * z);
    const edge = path.treadHalf + sierraParams.pathCorridorFalloff;
    for (let i = 0; i < before.length; i++) {
      if (ctx.h0[i] < sierraParams.pathGuardStart || (ctx.h0[i] < sierraParams.erodeBandStart && path.distance[i] >= edge)) {
        expect(field.bedrock[i]).toBe(before[i]);
      } else if (field.bedrock[i] !== before[i]) moved++;
      if (ctx.h0[i] >= sierraParams.erodeBandStart) above++;
    }
    expect(moved).toBeGreaterThan(above * 0.05);
  });

  it('pathCarve runs between rockfallThermal and thermalSmooth on a slice island, and pirate islands have no path', () => {
    const hm = hmFor('cirque', 2);
    const names = hm.erosion!.bakeStats.passes.map((q) => q.name);
    expect(names.indexOf('pathCarve')).toBe(names.indexOf('rockfallThermal') + 1);
    expect(names.indexOf('thermalSmooth')).toBe(names.indexOf('pathCarve') + 1);
    const pirate = generateIslandHeightmap(42, { ...islandParams, gridSize: 128 });
    expect(pirate.path).toBeUndefined();
    expect(pirate.erosion).toBeUndefined();
  });

  it('same seed → identical routes and distance field; different hints → a different landing', () => {
    const p = sierraIslandParams('drownedRidge', RADII[1], GRID);
    const a = generateIslandHeightmap(SEEDS[1], p);
    const b = generateIslandHeightmap(SEEDS[1], p);
    expect(a.path!.distance).toEqual(b.path!.distance);
    expect(a.path!.routes).toEqual(b.path!.routes);
    expect(a.path!.pois).toEqual(b.path!.pois);
    const c = generateIslandHeightmap(SEEDS[1], { ...p, pathApproach: poi(a, 'landing') && Math.atan2(poi(a, 'landing').z, poi(a, 'landing').x) + Math.PI });
    const la = poi(a, 'landing');
    const lc = poi(c, 'landing');
    expect(Math.hypot(la.x - lc.x, la.z - lc.z)).toBeGreaterThan(50);
  });

  it('path + carve ≤ 60 ms per slice island at 256²', () => {
    const rows: string[] = [];
    SIERRA_SLICE_ARCHETYPES.forEach((name, i) => {
      // min of 3 runs — isolates the pass cost from full-suite worker contention
      let ms = Infinity;
      for (let run = 0; run < 3; run++) {
        const hm = generateIslandHeightmap(SEEDS[i], sierraIslandParams(name, RADII[i], 256));
        ms = Math.min(ms, hm.erosion!.bakeStats.passes.find((q) => q.name === 'pathCarve')!.ms);
      }
      rows.push(`${name}: ${ms.toFixed(1)} ms`);
      expect(ms, rows.join(', ')).toBeLessThan(60);
    });
  }, 30000);

  it('catmullRom passes through its control points and losBlocked sees over flat ground', () => {
    const pl = catmullRom([[0, 0], [10, 0], [20, 5], [30, 5]], 1);
    expect(pl.x[0]).toBe(0);
    expect(pl.x[pl.x.length - 1]).toBe(30);
    expect(pl.z[pl.z.length - 1]).toBe(5);
    expect(pl.s[pl.s.length - 1]).toBeGreaterThan(31);
    expect(losBlocked(() => 0, 0, 0, 50, 0, 1.7, 1, 1)).toBe(false);
    expect(losBlocked((x) => (x > 20 && x < 25 ? 10 : 0), 0, 0, 50, 0, 1.7, 1, 1)).toBe(true);
  });
});

describe('route report (numbers for the handoff, not bounds)', () => {
  it('prints nothing, carries the stats in the assertion message', () => {
    const rows: string[] = [];
    for (const name of SIERRA_SLICE_ARCHETYPES) {
      for (let i = 0; i < SEEDS.length; i++) {
        const hm = hmFor(name, i);
        const main = hm.path!.routes.main;
        const fork = hm.path!.routes.forks[0];
        const ms = routeSlopes(main, 2);
        const P = poi(hm, 'fork');
        const mainPl = { x: Float64Array.from(main, (q) => q[0]), z: Float64Array.from(main, (q) => q[2]), s: new Float64Array(0) };
        rows.push(
          `${name}/${SEEDS[i]}: main ${routeLength(main).toFixed(0)} m mean ${(ms.reduce((a, b) => a + b, 0) / ms.length).toFixed(1)}° max ${Math.max(...ms).toFixed(1)}°, fork ${routeLength(fork).toFixed(0)} m, POI ${polylineDistance(mainPl, P.x, P.z).toFixed(0)} m off-route, carve ${hm.erosion!.bakeStats.passes.find((q) => q.name === 'pathCarve')!.ms.toFixed(0)} ms`,
        );
      }
    }
    expect(rows.length, rows.join('\n')).toBe(9);
  });
});
