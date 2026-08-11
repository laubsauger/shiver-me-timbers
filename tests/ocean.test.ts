/**
 * §V.4/§V.19 ocean math. These tests gate the GPU work: if the butterfly
 * table or Hermitian packing is wrong, the GPU produces garbage that is
 * miserable to debug — so the math is proven on CPU first.
 */
import { describe, expect, it } from 'vitest';
import {
  GRAVITY,
  bitReverse,
  cascadeBand,
  cpuButterflyIFFT,
  dispersion,
  gaussianPair,
  generateButterfly,
  generateH0,
  naiveIDFT,
  phillips,
} from '../src/ocean/oceanMath';
import { oceanParams } from '../src/params/ocean';
import { oceanSurfaceParams } from '../src/params/oceanSurface';
import { seaPhysicsParams } from '../src/params/seaPhysics';
import {
  buildOceanGrid,
  ringRadius,
  snapToGrid,
  solveGrowthRate,
  spacingAtRadius,
  warpVertex,
  type SurfaceGridOptions,
} from '../src/ocean/surfaceGeometry';
import { createRng } from '../src/state/rng';

describe('dispersion (§V.4 wave speed realism)', () => {
  it('ω² = g·k — deep water relation', () => {
    for (const k of [0.01, 0.5, 2, 40]) {
      const w = dispersion(k);
      expect(w * w).toBeCloseTo(GRAVITY * k, 6);
    }
  });
});

describe('cascade band split (§V.19 no duplicated energy)', () => {
  it('bands partition k-space with no overlap and no gap', () => {
    const splits: [number, number] = [24, 5];
    const b0 = cascadeBand(0, splits);
    const b1 = cascadeBand(1, splits);
    const b2 = cascadeBand(2, splits);
    expect(b0.kMax).toBe(b1.kMin);
    expect(b1.kMax).toBe(b2.kMin);
    expect(b0.kMin).toBe(0);
    expect(b2.kMax).toBe(Infinity);
  });

  it('a given k lands in exactly one cascade', () => {
    const splits: [number, number] = [24, 5];
    for (const k of [0.05, 0.26, 0.3, 1.2, 1.26, 3]) {
      const hits = [0, 1, 2].filter((c) => {
        const b = cascadeBand(c, splits);
        return k > b.kMin && k <= b.kMax;
      });
      expect(hits).toHaveLength(1);
    }
  });
});

describe('phillips spectrum', () => {
  it('zero at k=0 (no DC drift) and decays at high k', () => {
    expect(phillips(0, 0, oceanParams)).toBe(0);
    const low = phillips(0.3, 0.1, oceanParams);
    const high = phillips(30, 10, oceanParams);
    expect(low).toBeGreaterThan(0);
    expect(high).toBeLessThan(low);
  });

  it('waves against wind are damped — sea moves with the wind', () => {
    const p = { ...oceanParams, windDirection: 0 };
    const withWind = phillips(1, 0, p);
    const against = phillips(-1, 0, p);
    expect(against).toBeLessThan(withWind);
    expect(against).toBeGreaterThan(0);
  });
});

describe('butterfly IFFT table (§V.4 GPU math gate)', () => {
  it('bitReverse sane', () => {
    expect(bitReverse(1, 3)).toBe(4);
    expect(bitReverse(3, 3)).toBe(6);
    expect(bitReverse(0, 8)).toBe(0);
  });

  it('stage indices form a permutation covering all inputs', () => {
    const N = 16;
    const bf = generateButterfly(N);
    const stages = Math.log2(N);
    for (let j = 0; j < stages; j++) {
      const used = new Set<number>();
      for (let x = 0; x < N; x++) {
        const i = (j * N + x) * 4;
        used.add(bf[i + 2]);
        used.add(bf[i + 3]);
      }
      expect(used.size).toBe(N); // every input consumed, none lost
    }
  });

  it('butterfly-driven IFFT matches naive inverse DFT (random complex input)', () => {
    const N = 16;
    const rng = createRng(99);
    const input = {
      re: Float32Array.from({ length: N }, () => rng() * 2 - 1),
      im: Float32Array.from({ length: N }, () => rng() * 2 - 1),
    };
    const bf = generateButterfly(N);
    const fast = cpuButterflyIFFT(input, bf, N);
    const slow = naiveIDFT(input, N);
    for (let n = 0; n < N; n++) {
      expect(fast.re[n]).toBeCloseTo(slow.re[n], 3);
      expect(fast.im[n]).toBeCloseTo(slow.im[n], 3);
    }
  });
});

describe('h0 spectrum generation (§V.2 determinism, §V.4 Hermitian)', () => {
  const N = 16;
  const band = { kMin: 0, kMax: Infinity };

  it('same seed → identical spectrum', () => {
    const a = generateH0(N, 100, 7, oceanParams, band);
    const b = generateH0(N, 100, 7, oceanParams, band);
    expect(a).toEqual(b);
  });

  it('different seed → different spectrum', () => {
    const a = generateH0(N, 100, 7, oceanParams, band);
    const b = generateH0(N, 100, 8, oceanParams, band);
    expect(a).not.toEqual(b);
  });

  it('stored h0(−k) actually is the grid value at the mirrored texel', () => {
    // If this breaks, h(k,t) loses Hermitian symmetry → complex heights →
    // visually: ocean explodes into noise. Cheap check, huge failure mode.
    const spec = generateH0(N, 100, 3, oceanParams, band);
    for (const [n, m] of [
      [1, 2],
      [5, 9],
      [15, 1],
      [8, 8],
    ]) {
      const i = m * N + n;
      const nm = (N - n) % N;
      const mm = (N - m) % N;
      const j = mm * N + nm;
      expect(spec[i * 4 + 2]).toBe(spec[j * 4 + 0]);
      expect(spec[i * 4 + 3]).toBe(spec[j * 4 + 1]);
    }
  });

  it('band filter zeroes out-of-band k', () => {
    const narrow = generateH0(N, 100, 3, oceanParams, { kMin: 0.2, kMax: 0.4 });
    let nonZero = 0;
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        const kx = (2 * Math.PI * (n - N / 2)) / 100;
        const kz = (2 * Math.PI * (m - N / 2)) / 100;
        const k = Math.hypot(kx, kz);
        const i = (m * N + n) * 4;
        const mag = Math.abs(narrow[i]) + Math.abs(narrow[i + 1]);
        if (k <= 0.2 || k > 0.4) {
          expect(mag).toBe(0);
        } else if (mag > 0) {
          nonZero++;
        }
      }
    }
    expect(nonZero).toBeGreaterThan(0);
  });
});

describe('gaussianPair', () => {
  it('deterministic and roughly standard-normal', () => {
    const rng = createRng(1234);
    let sum = 0;
    let sumSq = 0;
    const count = 4000;
    for (let i = 0; i < count / 2; i++) {
      const [a, b] = gaussianPair(rng);
      sum += a + b;
      sumSq += a * a + b * b;
    }
    const mean = sum / count;
    const variance = sumSq / count - mean * mean;
    expect(Math.abs(mean)).toBeLessThan(0.1);
    expect(variance).toBeGreaterThan(0.8);
    expect(variance).toBeLessThan(1.2);
  });
});

/**
 * §V30 clipmap LOD. These encode WHY the warp exists: constant screen-space
 * triangle size out to kilometres, a circular rim inside the camera far
 * plane, and a spacing law the shader can reproduce analytically (it drives
 * the Nyquist cascade fades — get it wrong and detail either aliases or ends
 * in the visible ring §V30 forbids).
 */
describe('ocean surface clipmap (§V30 open 360° horizon)', () => {
  const grid: SurfaceGridOptions = {
    segments: oceanSurfaceParams.gridSegments,
    coreSpacing: oceanSurfaceParams.gridCoreSpacing,
    horizonRadius: oceanSurfaceParams.gridHorizonRadius,
    rimRound: oceanSurfaceParams.gridRimRound,
  };
  const k = solveGrowthRate(grid);

  it('the outermost ring lands on horizonRadius', () => {
    const half = grid.segments / 2;
    expect(ringRadius(half, grid.coreSpacing, k)).toBeCloseTo(grid.horizonRadius, 1);
  });

  it('spacing law matches the ring radii it came from (shader parity)', () => {
    // the material computes spacing = s0 + k·dist; it must equal the actual
    // gap between consecutive rings, or the cascade fades cut at the wrong
    // distance and detail aliases or vanishes early
    for (const n of [1, 40, 120, 200, 255]) {
      const r0 = ringRadius(n, grid.coreSpacing, k);
      const r1 = ringRadius(n + 1, grid.coreSpacing, k);
      // spacingAtRadius is the derivative, r1−r0 its integral over one ring:
      // they agree to O(k/2) ≈ 1%, which is far tighter than any fade needs
      expect(spacingAtRadius(r0, grid.coreSpacing, k) / (r1 - r0)).toBeCloseTo(1, 1);
    }
  });

  it('keeps triangles at a near-constant screen angle (spacing/distance)', () => {
    // this is the whole point of the warp: no vertex budget wasted at 400 m,
    // none starved at 4 km
    for (const r of [50, 200, 800, 2000, 4000]) {
      const ratio = spacingAtRadius(r, grid.coreSpacing, k) / r;
      expect(ratio).toBeGreaterThan(0.01);
      expect(ratio).toBeLessThan(0.045);
    }
  });

  it('radius grows monotonically along every direction — no folded triangles', () => {
    for (const dir of [
      [1, 0],
      [1, 1],
      [0.3, 1],
    ]) {
      let prev = -1;
      for (let i = 0; i <= 64; i++) {
        const t = i / 64;
        const [x, z] = warpVertex(dir[0] * t, dir[1] * t, grid, k);
        const r = Math.hypot(x, z);
        expect(r).toBeGreaterThanOrEqual(prev);
        prev = r;
      }
    }
  });

  it('rim is circular, so no corner pokes through the camera far plane', () => {
    // a square rim would put its corners at √2·horizonRadius and get sliced —
    // a notched horizon is exactly the cutoff §V30 bans
    for (let i = 0; i <= 32; i++) {
      const a = (i / 32) * Math.PI * 2;
      // walk the parameter-space boundary of the unit square
      const s = Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
      const [x, z] = warpVertex(Math.cos(a) / s, Math.sin(a) / s, grid, k);
      expect(Math.hypot(x, z)).toBeCloseTo(grid.horizonRadius, 0);
    }
  });

  it('snaps the mesh origin to whole core steps (near vertices never swim)', () => {
    const [x, z] = snapToGrid(123.456, -78.9, grid);
    expect(x / grid.coreSpacing).toBeCloseTo(Math.round(x / grid.coreSpacing), 6);
    expect(z / grid.coreSpacing).toBeCloseTo(Math.round(z / grid.coreSpacing), 6);
    expect(Math.abs(x - 123.456)).toBeLessThanOrEqual(grid.coreSpacing);
  });

  it('emits triangles ring-by-ring, front-to-back from the camera (§V28)', () => {
    // the mesh is camera-centered, so ring order IS front-to-back order for
    // every heading. With depth writes that costs the horizon band ~1 shaded
    // layer instead of hundreds of blended ones — the fill-rate wedge class
    // of §B.5. Row-major order would be back-to-front for half of all
    // headings, so this ordering is load bearing, not cosmetic.
    const small: SurfaceGridOptions = {
      segments: 16,
      coreSpacing: 1,
      horizonRadius: 400,
      rimRound: 0.3,
    };
    const geo = buildOceanGrid(small);
    const pos = geo.getAttribute('position');
    const idx = geo.getIndex();
    expect(idx).not.toBeNull();
    const seen = new Set<number>();
    const quarter = Math.floor(idx!.count / 3 / 4) * 3;
    const means = [0, 0, 0, 0];
    for (let t = 0; t < idx!.count; t += 3) {
      let r = 0;
      for (let c = 0; c < 3; c++) {
        const v = idx!.getX(t + c);
        seen.add(v);
        r = Math.max(r, Math.hypot(pos.getX(v), pos.getZ(v)));
      }
      const q = Math.min(3, Math.floor(t / quarter));
      means[q] += r;
    }
    // each quarter of the draw is further from the camera than the last
    for (let q = 1; q < 4; q++) expect(means[q]).toBeGreaterThan(means[q - 1]);
    // every vertex is used — no orphan rows, no holes in the sea
    expect(seen.size).toBe(pos.count);
  });

  it('degrades to a uniform grid when the horizon is inside the core reach', () => {
    const tiny = { segments: 64, coreSpacing: 10, horizonRadius: 100, rimRound: 0.3 };
    expect(solveGrowthRate(tiny)).toBe(0);
    expect(ringRadius(32, tiny.coreSpacing, 0)).toBe(320);
  });
});

describe('ocean cascades vs the CPU buoyancy mirror (§V8)', () => {
  it('every cascade band fits inside the mirror grid', () => {
    // cpuOcean throws if a band's kMax falls outside its reduced grid — the
    // wave-scale retune must never silently float ships on a different sea
    for (let i = 0; i < 2; i++) {
      const band = cascadeBand(i, oceanParams.splitWavelengths);
      const kEdge =
        (Math.PI * seaPhysicsParams.mirrorResolution) / oceanParams.cascades[i].domain;
      expect(band.kMax).toBeLessThan(kEdge);
    }
  });

  it('the coarse cascade holds several swell wavelengths per tile (§V19)', () => {
    // tiling reads as repetition once the domain is only a couple of waves
    // wide (user critique); the longest band wavelength is splitWavelengths[0]
    expect(oceanParams.cascades[0].domain / oceanParams.splitWavelengths[0])
      .toBeGreaterThan(8);
  });
});
