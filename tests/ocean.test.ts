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
