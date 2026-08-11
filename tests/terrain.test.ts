/**
 * T27 terrain noise — CPU mirror tests (§V16 spirit: proven math, no magic).
 *
 * WHY: src/terrain/noise.ts (TSL) and src/terrain/noiseCpu.ts implement the
 * SAME formulas; the shader side cannot run under vitest, so these tests pin
 * the shared math. NaN or out-of-range noise on the GPU = black holes /
 * garbage tint on the island terrain — the sweeps below (negative and large
 * coordinates included) are the guard against that.
 *
 * Documented ranges: hash / valueNoise / fbm all return values in [0, 1].
 */
import { describe, expect, it } from 'vitest';
import {
  fadeCpu,
  fbm2Cpu,
  fractCpu,
  hash2Cpu,
  hash3Cpu,
  valueNoise2Cpu,
} from '../src/terrain/noiseCpu';

/** sweep incl. negatives, zero, fractions, large coords (GPU danger zones) */
const SWEEP = [-1e5, -1234.56, -7.25, -1, -0.5, 0, 0.5, 1, 7.25, 1234.56, 1e5];

describe('hash (determinism + range)', () => {
  it('same input → same output, bit-identical', () => {
    for (const x of SWEEP) {
      for (const y of SWEEP) {
        expect(hash2Cpu(x, y)).toBe(hash2Cpu(x, y));
        expect(hash3Cpu(x, y, x - y)).toBe(hash3Cpu(x, y, x - y));
      }
    }
  });

  it('outputs stay in [0, 1) and are never NaN across the sweep', () => {
    for (const x of SWEEP) {
      for (const y of SWEEP) {
        for (const h of [hash2Cpu(x, y), hash3Cpu(x, y, x * 0.7 + y)]) {
          expect(Number.isNaN(h)).toBe(false);
          expect(h).toBeGreaterThanOrEqual(0);
          expect(h).toBeLessThan(1);
        }
      }
    }
  });

  it('decorrelates neighbours (not constant, not linear)', () => {
    const values = new Set<number>();
    for (let i = 0; i < 100; i++) values.add(hash2Cpu(i, i * 3 + 1));
    expect(values.size).toBeGreaterThan(95); // collisions ≈ none
  });
});

describe('fade curve', () => {
  it('fixes endpoints (0→0, 1→1) and is monotone inside', () => {
    expect(fadeCpu(0)).toBe(0);
    expect(fadeCpu(1)).toBe(1);
    let prev = 0;
    for (let t = 0.05; t <= 1.0001; t += 0.05) {
      const f = fadeCpu(t);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
  });
});

describe('value noise (range + determinism + continuity)', () => {
  it('deterministic and bounded [0, 1], no NaN, dense grid sweep', () => {
    for (let ix = -30; ix <= 30; ix++) {
      for (let iy = -30; iy <= 30; iy++) {
        const x = ix * 37.31; // covers negative, fractional, far-out coords
        const y = iy * 21.77;
        const n = valueNoise2Cpu(x, y);
        expect(n).toBe(valueNoise2Cpu(x, y));
        expect(Number.isNaN(n)).toBe(false);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is continuous: tiny step → tiny change (no lattice seams)', () => {
    const eps = 1e-4;
    for (const x of [-5.5, -1, 0, 0.999, 3.14, 42]) {
      const a = valueNoise2Cpu(x, x * 0.5);
      const b = valueNoise2Cpu(x + eps, x * 0.5 + eps);
      expect(Math.abs(a - b)).toBeLessThan(0.01);
    }
  });
});

describe('fbm (octave behaviour, §V16 mirror of shader fbm)', () => {
  const sample = (oct: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < 900; i++) {
      const x = (i % 30) * 1.37 - 20; // includes negative region
      const y = Math.floor(i / 30) * 2.11 - 30;
      out.push(fbm2Cpu(x, y, oct));
    }
    return out;
  };
  const variance = (v: number[]): number => {
    const mean = v.reduce((s, x) => s + x, 0) / v.length;
    return v.reduce((s, x) => s + (x - mean) * (x - mean), 0) / v.length;
  };

  it('deterministic, bounded [0, 1], NaN-free for 1..4 octaves', () => {
    for (let oct = 1; oct <= 4; oct++) {
      const v = sample(oct);
      for (const n of v) {
        expect(Number.isNaN(n)).toBe(false);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(1);
      }
      expect(fbm2Cpu(-7.7, 13.3, oct)).toBe(fbm2Cpu(-7.7, 13.3, oct));
    }
  });

  it('more octaves add detail: higher octave output differs from base and variance stays bounded', () => {
    const v1 = sample(1);
    const v4 = sample(4);
    // detail added: the 4-octave field is not the 1-octave field
    let maxDiff = 0;
    for (let i = 0; i < v1.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(v1[i] - v4[i]));
    }
    expect(maxDiff).toBeGreaterThan(0.05);
    // normalization keeps energy bounded: variance finite, positive, ≤ 1-oct
    // variance + slack (fbm averages octaves, it must not blow up)
    const var1 = variance(v1);
    const var4 = variance(v4);
    expect(var1).toBeGreaterThan(0);
    expect(var4).toBeGreaterThan(0);
    expect(Number.isFinite(var4)).toBe(true);
    expect(var4).toBeLessThanOrEqual(var1 * 1.5);
  });

  it('extreme coords (±1e5) produce finite in-range output', () => {
    for (const x of [-1e5, 1e5]) {
      for (const y of [-1e5, -3.3, 0, 1e5]) {
        const n = fbm2Cpu(x, y, 4);
        expect(Number.isFinite(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(1);
      }
    }
  });

  it('fract matches GLSL/WGSL semantics (negative inputs wrap into [0,1))', () => {
    expect(fractCpu(-0.25)).toBeCloseTo(0.75, 12);
    expect(fractCpu(3.5)).toBeCloseTo(0.5, 12);
    expect(fractCpu(-3)).toBe(0);
  });
});
