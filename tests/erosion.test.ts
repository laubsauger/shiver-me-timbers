/**
 * §T.112c erosion + macro form — PROPERTIES (§V80), never decisions. WHY
 * each matters:
 * - thermal: talus at repose is what makes an apron read as gravity-sorted
 *   debris; a pass that creates or destroys mass is not erosion, it is a
 *   paint job, and the debris channel T112f samples would lie.
 * - sheeting only on convex ground: Martel 2006 — sheet joints form where
 *   the surface is convex. Steps in a bowl are a wedding cake again.
 * - stoss < lee: the roche moutonnée is the one glacial form the per-island
 *   ice vector exists for; without the asymmetry the vector is a number.
 * - drainage monotone / channels deepen: stream power is only worth its
 *   sort if area accumulates downstream and the channels it owes the ridge
 *   and cirque silhouettes actually get cut.
 * - flood: an inland cell under sea level shows the ocean plane through the
 *   island.
 * - determinism + chunked ≡ one-shot (§V2): the loader will yield between
 *   pass steps; a bake whose result depends on the frame budget re-rolls
 *   the world per machine.
 * - bake budget: T112 decided ≤ 300 ms per slice island at 256² on the
 *   CPU (worker above that) — measured, not assumed.
 * - pirate untouched / shapeOnly: the stage gates on the sierra branch
 *   only, and the analytic archetype stays reachable for A/B.
 */
import { describe, expect, it } from 'vitest';
import { budgetLabel, budgetMs } from './perfBudget';
import {
  bedrockSheetingPass,
  buildErosionContext,
  erodeAndShape,
  floodStep,
  insertPassBefore,
  sheetingStep,
  type ErosionContext,
  type ErosionField,
  type ErosionPass,
} from '../src/island/erosion';
import { computeDrainage, streamPowerStep } from '../src/island/erosionStream';
import { thermalStep } from '../src/island/erosionThermal';
import { generateIslandHeightmap, generateIslandHeightmapChunked } from '../src/island/heightmap';
import { sierraIslandParams } from '../src/island/sierraSites';
import { SIERRA_SLICE_ARCHETYPES } from '../src/island/sierraArchetypes';
import { islandParams } from '../src/params/island';
import { sierraParams } from '../src/params/sierra';
import {
  fbmDeriv2Cpu,
  gradNoise2Cpu,
  jordanTurbulence2Cpu,
  ridged2Cpu,
  swissTurbulence2Cpu,
  domainWarp2Cpu,
} from '../src/terrain/noiseCpu';

const TAN35 = Math.tan((35 * Math.PI) / 180);

/** a synthetic island field: `shape(x, z)` in metres on a size² grid of `cell` m */
function synthetic(
  size: number,
  cell: number,
  shape: (x: number, z: number) => number,
  opts: { ice?: number; streamIters?: number; lagoonMask?: Uint8Array | null } = {},
): { field: ErosionField; ctx: ErosionContext } {
  const R = (cell * (size - 1)) / 2;
  const bedrock = new Float64Array(size * size);
  let peak = 0;
  for (let iz = 0; iz < size; iz++) {
    for (let ix = 0; ix < size; ix++) {
      const h = shape(-R + ix * cell, -R + iz * cell);
      bedrock[iz * size + ix] = h;
      if (h > peak) peak = h;
    }
  }
  const h0 = Float64Array.from(bedrock);
  const uplift = Float64Array.from(bedrock, (h) => Math.min(Math.max(h / Math.max(peak, 1e-3), 0), 1));
  const ctx = buildErosionContext({
    size,
    cell,
    worldRadius: R,
    peak,
    iceAzimuth: opts.ice ?? 0,
    uplift,
    h0,
    noiseOffset: [12.3, 45.6],
    p: sierraParams,
    streamIters: opts.streamIters ?? 0,
    lagoonMask: opts.lagoonMask ?? null,
  });
  return { field: { size, cell, bedrock, debris: new Float64Array(size * size) }, ctx };
}

const sum = (a: ArrayLike<number>): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
};

/** slope (tan) to the steepest 8-neighbour of the total surface */
function maxSlopeAt(f: ErosionField, i: number): number {
  const { size, cell, bedrock, debris } = f;
  const ix = i % size;
  const iz = (i - ix) / size;
  const h = bedrock[i] + debris[i];
  let best = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue;
      const jx = ix + dx;
      const jz = iz + dz;
      if (jx < 0 || jz < 0 || jx >= size || jz >= size) continue;
      const j = jz * size + jx;
      const s = (h - bedrock[j] - debris[j]) / (cell * Math.hypot(dx, dz));
      if (s > best) best = s;
    }
  }
  return best;
}

describe('gradient noise with analytic derivatives (noiseCpu ↔ noise.ts twins)', () => {
  it('the analytic derivative matches a central difference, and v stays in [-1, 1]', () => {
    const eps = 1e-4;
    let worst = 0;
    for (let k = 0; k < 400; k++) {
      const x = (k * 0.731 - 100) * 1.37;
      const y = (k * 0.413 - 50) * 0.91;
      const n = gradNoise2Cpu(x, y);
      expect(Math.abs(n.v)).toBeLessThanOrEqual(1 + 1e-9);
      const fdx = (gradNoise2Cpu(x + eps, y).v - gradNoise2Cpu(x - eps, y).v) / (2 * eps);
      const fdy = (gradNoise2Cpu(x, y + eps).v - gradNoise2Cpu(x, y - eps).v) / (2 * eps);
      worst = Math.max(worst, Math.abs(fdx - n.dx), Math.abs(fdy - n.dy));
    }
    expect(worst).toBeLessThan(1e-4);
  });
  it('fbmDeriv2 carries the derivative through the octave frequencies', () => {
    const eps = 1e-4;
    for (let k = 0; k < 100; k++) {
      const x = k * 0.37 + 3.1;
      const y = k * 0.23 - 7.7;
      const n = fbmDeriv2Cpu(x, y, 4);
      const fdx = (fbmDeriv2Cpu(x + eps, y, 4).v - fbmDeriv2Cpu(x - eps, y, 4).v) / (2 * eps);
      expect(Math.abs(fdx - n.dx)).toBeLessThan(2e-3);
    }
  });
  it('turbulences stay in [0, 1], warp in [-1, 1], deterministic and NaN-free over a wide sweep', () => {
    for (let k = 0; k < 300; k++) {
      const x = (k - 150) * 97.3;
      const y = (k - 150) * -31.7;
      for (const v of [swissTurbulence2Cpu(x, y, 5), jordanTurbulence2Cpu(x, y, 5), ridged2Cpu(x, y, 4)]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      const w = domainWarp2Cpu(x, y, 3);
      expect(Math.abs(w)).toBeLessThanOrEqual(1);
      expect(swissTurbulence2Cpu(x, y, 5)).toBe(swissTurbulence2Cpu(x, y, 5));
    }
  });
});

describe('thermal erosion (Musgrave): repose + mass', () => {
  it('a debris cone settles to ≤ tan 35° + ε wherever debris remains, conserving mass to 1e-6', () => {
    // bedrock is a flat 40 m bench (inside the erodible band); the debris is a
    // steep cone dumped on it
    const size = 64;
    const { field, ctx } = synthetic(size, 2, () => 40);
    for (let iz = 0; iz < size; iz++) {
      for (let ix = 0; ix < size; ix++) {
        const d = Math.hypot(ix - 32, iz - 32) * 2;
        field.debris[iz * size + ix] = Math.max(0, 30 - d * 1.6); // ~58°
      }
    }
    const mass0 = sum(field.debris);
    for (let k = 0; k < 400; k++) thermalStep(field, ctx, field.debris, field.debris, ctx.p.talusRepose);
    expect(Math.abs(sum(field.debris) - mass0) / mass0).toBeLessThan(1e-6);
    let worst = 0;
    for (let i = 0; i < size * size; i++) {
      if (field.debris[i] > 0.01) worst = Math.max(worst, maxSlopeAt(field, i));
    }
    expect(worst).toBeLessThanOrEqual(TAN35 + 0.02);
    for (let i = 0; i < size * size; i++) expect(field.debris[i]).toBeGreaterThanOrEqual(-1e-12);
  });
});

describe('bedrock sheeting follows curvature (Martel 2006) and the ice vector', () => {
  const size = 96;
  const cell = 2;
  const dome = (x: number, z: number): number => 80 * Math.max(0, 1 - (x * x + z * z) / (80 * 80));
  it('steps appear on a dome (convex) and a bowl (concave) is byte-identical', () => {
    const d = synthetic(size, cell, dome);
    const before = Float64Array.from(d.field.bedrock);
    sheetingStep(d.field, d.ctx);
    let changed = 0;
    for (let i = 0; i < before.length; i++) if (d.field.bedrock[i] !== before[i]) changed++;
    expect(changed).toBeGreaterThan(size * size * 0.05);
    // a bowl above the band: concave everywhere inside, so nothing may move
    const b = synthetic(size, cell, (x, z) => 40 + (x * x + z * z) / 400);
    const bowl0 = Float64Array.from(b.field.bedrock);
    sheetingStep(b.field, b.ctx);
    expect(b.field.bedrock).toEqual(bowl0);
  });
  it('stoss mean slope < lee mean slope along the ice vector, on a symmetric dome', () => {
    // the roche moutonnée: along the ice line through the crest, the stoss
    // flank runs further to the same drop than the lee flank, i.e. its mean
    // slope (drop / run) is the smaller one. Measured from the crest the
    // shear actually produced, not from the grid centre.
    const d = synthetic(size, cell, dome, { ice: 0 }); // ice flows +x: stoss x<0, lee x>0
    const pass = bedrockSheetingPass();
    for (let i = 0; i < pass.steps; i++) pass.advance(d.field, d.ctx, i);
    const row = (size >> 1) * size;
    let crest = 0;
    for (let ix = 0; ix < size; ix++) if (d.field.bedrock[row + ix] > d.field.bedrock[row + crest]) crest = ix;
    const peak = d.field.bedrock[row + crest];
    const drop = peak - 30;
    const run = (dir: 1 | -1): number => {
      for (let k = 1; k < size; k++) {
        const ix = crest + dir * k;
        if (ix < 0 || ix >= size || d.field.bedrock[row + ix] <= 30) return k * cell;
      }
      return size * cell;
    };
    const stossSlope = drop / run(-1);
    const leeSlope = drop / run(1);
    expect(leeSlope).toBeGreaterThan(stossSlope * 1.1);
  });
});

describe('stream power (Schott 2023 kernel)', () => {
  it('drainage area is non-decreasing downstream on a tilted plane', () => {
    const size = 48;
    const cell = 2;
    const h = new Float64Array(size * size);
    for (let iz = 0; iz < size; iz++) for (let ix = 0; ix < size; ix++) h[iz * size + ix] = 30 + ix * 0.5 + iz * 0.2;
    const d = computeDrainage(h, size, cell);
    let routed = 0;
    for (let i = 0; i < size * size; i++) {
      const r = d.recv[i];
      if (r === i) continue;
      routed++;
      expect(d.area[r]).toBeGreaterThanOrEqual(d.area[i]);
      expect(h[r]).toBeLessThan(h[i]);
    }
    expect(routed).toBeGreaterThan(size * size * 0.9);
  });
  it('channels deepen with iterations and never dig a cell under its receiver', () => {
    const size = 64;
    const cell = 2;
    const shape = (x: number, z: number): number => 60 + x * 0.3 + 3 * swissTurbulence2Cpu(x * 0.05, z * 0.05, 3);
    const incision = (iters: number): number => {
      const { field, ctx } = synthetic(size, cell, shape);
      const h0 = Float64Array.from(field.bedrock);
      for (let k = 0; k < iters; k++) streamPowerStep(field, ctx);
      const d = computeDrainage(field.bedrock, size, cell);
      for (let i = 0; i < size * size; i++) {
        if (d.recv[i] !== i) expect(field.bedrock[i]).toBeGreaterThanOrEqual(field.bedrock[d.recv[i]]);
      }
      let deepest = 0;
      for (let i = 0; i < size * size; i++) deepest = Math.max(deepest, h0[i] - field.bedrock[i]);
      return deepest;
    };
    const a = incision(4);
    const b = incision(16);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
  });
});

describe('flood at sea level', () => {
  it('no cell that started as land ends below the sea unless lagoon-masked', () => {
    const size = 32;
    const { field, ctx } = synthetic(size, 2, (x) => 20 - x * 0.4);
    const mask = new Uint8Array(size * size);
    for (let i = 0; i < size * size; i++) {
      if (ctx.h0[i] > 0) field.bedrock[i] = -1.5; // pretend erosion sank the land
      if (i % size < 8) mask[i] = 1;
    }
    ctx.lagoonMask = mask;
    floodStep(field, ctx);
    for (let i = 0; i < size * size; i++) {
      if (ctx.h0[i] <= 0) continue;
      if (mask[i]) expect(field.bedrock[i]).toBe(-1.5);
      else expect(field.bedrock[i] + field.debris[i]).toBeGreaterThanOrEqual(sierraParams.floodFloor);
    }
  });
});

describe('the pass stage: order, hook, chunking, determinism', () => {
  it('insertPassBefore puts T112b\'s carve between rockfallThermal and thermalSmooth, and a missing name throws', () => {
    const { field, ctx } = synthetic(16, 2, () => 30);
    const order: string[] = [];
    const spy = (name: string): ErosionPass => ({ name, steps: 1, advance: () => order.push(name) });
    const passes = [spy('bedrockSheeting'), spy('streamPower'), spy('rockfallThermal'), spy('thermalSmooth'), spy('floodAtSeaLevel')];
    insertPassBefore(passes, 'thermalSmooth', spy('carve'));
    erodeAndShape(field, ctx, passes).finish();
    expect(order).toEqual(['bedrockSheeting', 'streamPower', 'rockfallThermal', 'carve', 'thermalSmooth', 'floodAtSeaLevel']);
    expect(() => insertPassBefore(passes, 'nope', spy('x'))).toThrow();
  });
  it('step(msBudget) always advances and finishes; stats count every pass step', () => {
    const { field, ctx } = synthetic(32, 2, (x, z) => 50 - Math.hypot(x, z) * 0.5, { streamIters: 3 });
    const bake = erodeAndShape(field, ctx);
    let calls = 0;
    while (!bake.advance(0)) calls++;
    expect(bake.done).toBe(true);
    const steps = bake.stats.passes.reduce((s, p) => s + p.steps, 0);
    expect(calls + 1).toBeLessThanOrEqual(steps);
    expect(bake.stats.totalMs).toBeGreaterThan(0);
    expect(bake.stats.passes.map((p) => p.name)).toEqual([
      'bedrockSheeting', 'streamPower', 'rockfallThermal', 'thermalSmooth', 'floodAtSeaLevel',
    ]);
  });
  for (const name of SIERRA_SLICE_ARCHETYPES) {
    it(`${name}: chunked (1 ms slices) ≡ one-shot, byte-identical, and a second run is too (§V2)`, () => {
      const params = sierraIslandParams(name, 180, 128);
      const one = generateIslandHeightmap(4242, params);
      const chunked = generateIslandHeightmapChunked(4242, params);
      let slices = 0;
      while (!chunked.advance(1)) slices++;
      expect(slices).toBeGreaterThan(1);
      const two = chunked.result();
      expect(two.data).toEqual(one.data);
      expect(two.erosion!.debris).toEqual(one.erosion!.debris);
      expect(generateIslandHeightmap(4242, params).data).toEqual(one.data);
    });
  }
});

describe('gating: sierra only, analytic reachable', () => {
  it('a sierra island differs from its shapeOnly twin; a pirate island ignores the erosion knobs', () => {
    const params = sierraIslandParams('drownedRidge', 180, 128);
    const full = generateIslandHeightmap(7, params);
    const shape = generateIslandHeightmap(7, { ...params, erosion: 'shapeOnly' });
    expect(full.erosion).toBeDefined();
    expect(shape.erosion).toBeUndefined();
    expect(full.data).not.toEqual(shape.data);
    // the family's own draws are untouched: same axis, same treeline bearing
    expect(full.sierra!.axis).toBe(shape.sierra!.axis);
    const pirate = { ...islandParams, gridSize: 48 };
    const a = generateIslandHeightmap(42, pirate);
    expect(a.erosion).toBeUndefined();
    const saved = sierraParams.iceShear;
    sierraParams.iceShear = saved * 4;
    try {
      expect(generateIslandHeightmap(42, pirate).data).toEqual(a.data);
      expect(generateIslandHeightmap(42, { ...pirate, erosion: 'shapeOnly' }).data).toEqual(a.data);
    } finally {
      sierraParams.iceShear = saved;
    }
  });
});

describe('bake budget (T112 decision: ≤ 300 ms per slice island at 256², CPU)', () => {
  const SEEDS = [988, 1965, 2942];
  const RADII = [210, 250, 290];
  it('every slice archetype × seed bakes under budget at 256²; 512² is reported, not bound', () => {
    const rows: string[] = [];
    SIERRA_SLICE_ARCHETYPES.forEach((name, i) => {
      for (const g of [256, 512]) {
        // min of 3 runs: the budget is the bake's own cost, not the full suite's
        // worker contention (the first full-suite run measured 349 ms on a 87 ms bake)
        let total = Infinity;
        let hm = generateIslandHeightmap(SEEDS[i], sierraIslandParams(name, RADII[i], g));
        for (let run = 0; run < (g === 256 ? 3 : 1); run++) {
          const t0 = performance.now();
          hm = generateIslandHeightmap(SEEDS[i], sierraIslandParams(name, RADII[i], g));
          total = Math.min(total, performance.now() - t0);
        }
        const st = hm.erosion!.bakeStats;
        rows.push(`${name} ${g}²: total ${total.toFixed(0)} ms, bake ${st.totalMs.toFixed(0)} ms`);
        if (g === 256) {
          // §V80 — the budget is 300 ms OF THE MACHINE IT WAS MEASURED ON.
          // A free-tier CI runner came in at 301.8 and blocked a deploy with
          // no regression behind it; see tests/perfBudget.ts.
          expect(st.totalMs, budgetLabel(st.totalMs, 300)).toBeLessThan(budgetMs(300));
          expect(total, budgetLabel(total, 300)).toBeLessThan(budgetMs(300));
        }
      }
    });
    // surfaced through the test name on failure only; no console spam
    expect(rows).toHaveLength(6);
  }, 30000);
});
