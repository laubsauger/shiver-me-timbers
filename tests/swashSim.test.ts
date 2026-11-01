/**
 * The swash sim's scheme (src/drift/wandering/swashSim.ts), on its CPU reference — the GPU kernel transliterates it:
 *   - MASS: in a closed basin the faces' fluxes cancel in pairs: Σh·dA holds to round-off, whatever the water does
 *     (a dam break over a bumpy, partly dry bed — wet/dry fronts running both ways);
 *   - LAKE AT REST: still water over any bed, its shore on dry land, stays exactly still (the hydrostatic
 *     reconstruction's well-balance) — a scheme without it makes currents out of the slope;
 *   - DETERMINISM: the same start and the same t give the same state, and the forcing and the step plan are pure
 *     functions of t;
 *   - NO DRY GAP, TOP-DOWN BACKWASH: the water one body from the sea to its front; the sand above it never wetter
 *     further up the beach;
 *   - THE SEAM: a state warmed from rest SWASH_WARM s before its frame against one run on from 40 s earlier, on our
 *     beach's own profile: how much the warm start still shows 30 s later (the price of the wake's rule).
 *   - ON ALONG THE BEACH (the 2026-11-01 note: the 200 m strip's edges read as "a rectangle on the shore"): the rows
 *     that coarsen along the shore and shift across it to follow its curve keep the scheme's two guarantees — mass
 *     to round-off over cells of their own widths, a lake at rest still across rows shifted by whole cells — and the
 *     layout keeps the core's own 10 cm rows where they were, reaching the shore the wide shots see.
 */
import { describe, expect, it } from 'vitest';
import { stepSwashCpu, swashAtRest, swashForcing, swashPlan, SWASH_DT, SWASH_LAYOUT, SWASH_ROWS, SWASH_SUB, SWASH_WARM, SWASH, type SwashGrid } from '../src/drift/wandering/swashSim';

const sum = (a: Float64Array): number => a.reduce((s, x) => s + x, 0);

/** our beach's profile at its middle (coast.ts, measured): m over the sea at m from the waterline (+ inland), as a
 * strip of the sim's own cells across, `nz` rows */
function beachStrip(nz: number): { nx: number; nz: number; bed: Float64Array } {
  const PROFILE: Array<[number, number]> = [[-24, -0.94], [-20, -0.87], [-16, -0.76], [-12, -0.64], [-8, -0.48], [-4, -0.25], [0, 0.06], [4, 0.4], [8, 0.74], [12, 1.04], [16, 1.3]];
  const at = (x: number): number => {
    for (let k = 1; k < PROFILE.length; k++) if (x <= PROFILE[k][0]) return PROFILE[k - 1][1] + ((x - PROFILE[k - 1][0]) / (PROFILE[k][0] - PROFILE[k - 1][0])) * (PROFILE[k][1] - PROFILE[k - 1][1]);
    return PROFILE[PROFILE.length - 1][1];
  };
  const nx = SWASH.nx;
  const bed = new Float64Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) bed[i + j * nx] = at(SWASH.x0 + (i + 0.5) * SWASH.cell);
  return { nx, nz, bed };
}
const clone = (g: SwashGrid): SwashGrid => ({ ...g, h: g.h.slice(), hu: g.hu.slice(), hv: g.hv.slice(), foam: g.foam.slice(), wet: g.wet.slice(), glaze: g.glaze.slice(), strand: g.strand.slice() });

/** a bumpy bed: a slope with a ridge and a hollow, partly above the still water */
function bumpyBed(nx: number, nz: number, dx: number): Float64Array {
  const bed = new Float64Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = i * dx;
      const z = j * dx;
      bed[i + j * nx] = -0.4 + 0.09 * x + 0.15 * Math.exp(-((x - 1.5) ** 2 + (z - 1) ** 2) / 0.2) - 0.1 * Math.exp(-((x - 3) ** 2 + (z - 2.2) ** 2) / 0.3);
    }
  }
  return bed;
}

describe('swash sim scheme', () => {
  it('conserves mass to round-off in a closed basin (dam break over a bumpy, partly dry bed)', () => {
    const nx = 60;
    const nz = 40;
    const dx = 0.1;
    let a = swashAtRest(nx, nz, dx, bumpyBed(nx, nz, dx));
    // a dam of water standing 0.3 m over the still level in a corner, and a current along the shore
    for (let j = 0; j < 15; j++) for (let i = 0; i < 20; i++) a.h[i + j * nx] += 0.3;
    for (let k = 0; k < nx * nz; k++) if (a.h[k] > 0) a.hv[k] = 0.2 * a.h[k];
    let b = clone(a);
    const m0 = sum(a.h);
    for (let n = 0; n < 600; n++) {
      stepSwashCpu(a, b, n * SWASH_DT, SWASH_DT, { seaward: 'wall', ends: 'wall', friction: true });
      [a, b] = [b, a];
    }
    const m1 = sum(a.h);
    // (and it moved: the dam broke and ran up the slope)
    const moved = a.h.reduce((s, h, k) => s + Math.abs(h - Math.max(0, -a.bed[k])), 0);
    expect(moved).toBeGreaterThan(1);
    expect(Math.abs(m1 - m0) / m0).toBeLessThan(1e-12);
  });

  it('keeps a lake at rest exactly still, its shore on dry land', () => {
    const nx = 60;
    const nz = 40;
    const dx = 0.1;
    let a = swashAtRest(nx, nz, dx, bumpyBed(nx, nz, dx));
    const h0 = a.h.slice();
    let b = clone(a);
    for (let n = 0; n < 400; n++) {
      stepSwashCpu(a, b, n * SWASH_DT, SWASH_DT, { seaward: 'wall', ends: 'open', friction: true, infiltration: false });
      [a, b] = [b, a];
    }
    let du = 0;
    let dh = 0;
    for (let k = 0; k < nx * nz; k++) {
      du = Math.max(du, Math.abs(a.hu[k]), Math.abs(a.hv[k]));
      dh = Math.max(dh, Math.abs(a.h[k] - h0[k]));
    }
    expect(du).toBeLessThan(1e-12);
    expect(dh).toBeLessThan(1e-12);
  });

  it('conserves mass over rows of their own widths (Σ h·dx·dz), as the coarse rows along the shore are', () => {
    const nx = 60;
    const nz = 40;
    const dx = 0.1;
    let a = swashAtRest(nx, nz, dx, bumpyBed(nx, nz, dx));
    // (growing ×1.03 a row from 10 cm, as SWASH_ROWS: the dam's water crosses the change of width)
    a.dz = Float64Array.from({ length: nz }, (_, j) => Math.min(0.4, dx * 1.03 ** j));
    for (let j = 0; j < 15; j++) for (let i = 0; i < 20; i++) a.h[i + j * nx] += 0.3;
    for (let k = 0; k < nx * nz; k++) if (a.h[k] > 0) a.hv[k] = 0.2 * a.h[k];
    let b = clone(a);
    const mass = (g: SwashGrid): number => g.h.reduce((s, h, k) => s + h * g.dz![Math.floor(k / nx)], 0);
    const m0 = mass(a);
    for (let n = 0; n < 600; n++) {
      stepSwashCpu(a, b, n * SWASH_DT, SWASH_DT, { seaward: 'wall', ends: 'wall', friction: true });
      [a, b] = [b, a];
    }
    expect(Math.abs(mass(a) - m0) / m0).toBeLessThan(1e-12);
    // (a uniform-width mass would not hold: the test can tell the widths are used)
    expect(Math.abs(sum(a.h) - sum(swashAtRest(nx, nz, dx, a.bed).h) - 0.3 * 300)).toBeGreaterThan(1e-6);
  });

  it('keeps a lake at rest still across rows shifted by whole cells to follow a curving shore', () => {
    const nx = 60;
    const nz = 40;
    const dx = 0.1;
    // the shore curving out to sea one cell in every two rows; each row's bed the same slope at its own world x
    const shift = Int32Array.from({ length: nz }, (_, j) => Math.floor(j / 2));
    const bed = new Float64Array(nx * nz);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) bed[i + j * nx] = -0.4 + 0.09 * (i - shift[j]) * dx + 0.05 * Math.sin(j * 0.3);
    let a = swashAtRest(nx, nz, dx, bed);
    a.shift = shift;
    a.dz = Float64Array.from({ length: nz }, (_, j) => Math.min(0.4, dx * 1.03 ** j));
    const h0 = a.h.slice();
    let b = clone(a);
    for (let n = 0; n < 400; n++) {
      stepSwashCpu(a, b, n * SWASH_DT, SWASH_DT, { seaward: 'wall', ends: 'open', friction: true, infiltration: false });
      [a, b] = [b, a];
    }
    let du = 0;
    let dh = 0;
    for (let k = 0; k < nx * nz; k++) {
      du = Math.max(du, Math.abs(a.hu[k]), Math.abs(a.hv[k]));
      dh = Math.max(dh, Math.abs(a.h[k] - h0[k]));
    }
    expect(du).toBeLessThan(1e-12);
    expect(dh).toBeLessThan(1e-12);
  });

  it('lays its rows out along the beach: the core\'s 10 cm rows where they were, coarsening outward to 40 cm, out to the shore the wide shots see', () => {
    const L = SWASH_LAYOUT;
    const [c0, c1] = L.core;
    expect(c1 - c0).toBe(SWASH.nz);
    for (let j = c0; j < c1; j += 97) {
      expect(L.dz[j]).toBe(SWASH.cell);
      expect(L.zc[j]).toBeCloseTo(SWASH.z0 + (j - c0 + 0.5) * SWASH.cell, 9);
    }
    expect(Math.max(...L.dz)).toBeLessThanOrEqual(SWASH_ROWS.coarse);
    // (no jump in width between neighbours bigger than the growth)
    for (let j = 1; j < L.nz; j++) expect(Math.max(L.dz[j], L.dz[j - 1]) / Math.min(L.dz[j], L.dz[j - 1])).toBeLessThanOrEqual(SWASH_ROWS.grow + 1e-9);
    // (along runs toward −z: 270 m ahead of the beach's middle and 175 m behind it)
    expect(-L.zLo).toBeGreaterThanOrEqual(270);
    expect(L.zHi).toBeGreaterThanOrEqual(175);
    expect(L.nz).toBeLessThan(2800);
  });

  it('is deterministic: the same start and t give the same state; forcing and plan are pure', () => {
    const run = (): SwashGrid => {
      let a = swashAtRest(40, 10, 0.1, bumpyBed(40, 10, 0.1));
      let b = clone(a);
      for (let n = 0; n < 200; n++) {
        stepSwashCpu(a, b, 100 + n * SWASH_DT, SWASH_DT, { seaward: 'generate', ends: 'open', z0: 0.05, friction: true, infiltration: true });
        [a, b] = [b, a];
      }
      return a;
    };
    const x = run();
    const y = run();
    expect(Array.from(x.h)).toEqual(Array.from(y.h));
    expect(Array.from(x.hu)).toEqual(Array.from(y.hu));
    expect(swashForcing(612.25, 17)).toBe(swashForcing(612.25, 17));
    const per = SWASH_SUB * SWASH_DT;
    // a continuation steps on; a jump ahead, a step back or a first frame warms from rest SWASH_WARM s earlier
    expect(swashPlan(1000, 1001 * per)).toEqual({ reset: false, from: 1000, to: 1001 });
    expect(swashPlan(1000, 1000 * per)).toEqual({ reset: false, from: 1000, to: 1000 });
    expect(swashPlan(1000, 999 * per)).toEqual({ reset: true, from: 999 - SWASH_WARM / per, to: 999 });
    expect(swashPlan(null, 1000 * per)).toEqual({ reset: true, from: 1000 - SWASH_WARM / per, to: 1000 });
    expect(swashPlan(1000, 2000 * per).reset).toBe(true);
  });

  it('never leaves a dry gap between the sea and the swash, and its backwash dries from the top down', () => {
    // (the 2026-10-29 review: "a band in between where there's no water … gravity … it definitely wouldn't look like
    // this ever"): over our beach's profile, through 40 s of swash, the water is one body from the sea up to its
    // front — no cell seaward of a wet one is dry — and the sand above the front is never wetter further up the
    // beach (the top drains and dries first; the sand nearest the sea stays wettest)
    const { nx, bed } = beachStrip(2);
    let a = swashAtRest(nx, 2, SWASH.cell, bed);
    let b = clone(a);
    const n0 = Math.round(590 / SWASH_DT);
    const n1 = Math.round(630 / SWASH_DT);
    let checked = 0;
    let ranUp = 0;
    for (let n = n0; n < n1; n++) {
      stepSwashCpu(a, b, n * SWASH_DT, SWASH_DT, { seaward: 'generate', ends: 'open', z0: 12, friction: true, infiltration: true });
      [a, b] = [b, a];
      if (n % 6) continue;
      let front = -1;
      for (let i = 0; i < nx; i++) if (a.h[i] > 5e-4) front = i;
      for (let i = 0; i < front; i++) expect(a.h[i], `dry gap at cell ${i} below the front ${front}, t ${(n * SWASH_DT).toFixed(2)}`).toBeGreaterThan(1e-4);
      for (let i = front + 1; i < nx - 1; i++) expect(a.wet[i + 1], `wetter further up at cell ${i + 1}, t ${(n * SWASH_DT).toFixed(2)}`).toBeLessThanOrEqual(a.wet[i] + 1e-12);
      ranUp = Math.max(ranUp, a.bed[front]);
      checked++;
    }
    // (and the swash did run up the face, well over the still water)
    expect(ranUp).toBeGreaterThan(0.1);
    expect(checked).toBeGreaterThan(1000);
  });

  it('measures the seam: a warm start against a long run, 30 s on, on our beach profile', () => {
    const { nx, nz, bed } = beachStrip(4);
    const dx = SWASH.cell;
    const t0 = 600;
    const runFrom = (start: number): SwashGrid => {
      let a = swashAtRest(nx, nz, dx, bed);
      let b = clone(a);
      const n0 = Math.round(start / SWASH_DT);
      const n1 = Math.round((t0 + 30) / SWASH_DT);
      for (let n = n0; n < n1; n++) {
        stepSwashCpu(a, b, n * SWASH_DT, SWASH_DT, { seaward: 'generate', ends: 'open', z0: 12, friction: true, infiltration: true });
        [a, b] = [b, a];
      }
      return a;
    };
    const warm = runFrom(t0 - SWASH_WARM);
    const long = runFrom(t0 - 40 - SWASH_WARM);
    let maxD = 0;
    let meanD = 0;
    let wetCells = 0;
    for (let i = 0; i < nx; i++) {
      const ea = warm.h[i] + bed[i];
      const eb = long.h[i] + bed[i];
      if (warm.h[i] > 1e-3 || long.h[i] > 1e-3) {
        maxD = Math.max(maxD, Math.abs(ea - eb));
        meanD += Math.abs(ea - eb);
        wetCells++;
      }
    }
    meanD /= Math.max(1, wetCells);
    // (the shoreline: the most landward wet cell)
    const shore = (g: SwashGrid): number => {
      for (let i = nx - 1; i >= 0; i--) if (g.h[i] > 1e-3) return SWASH.x0 + (i + 0.5) * dx;
      return NaN;
    };
    console.log(`[swash seam] after 30 s: |Δη| max ${(maxD * 1000).toFixed(2)} mm, mean ${(meanD * 1000).toFixed(3)} mm over ${wetCells} wet cells; shoreline ${shore(warm).toFixed(2)} vs ${shore(long).toFixed(2)} m`);
    expect(maxD).toBeLessThan(0.02);
  });
});
