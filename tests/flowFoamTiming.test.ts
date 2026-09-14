import { describe, expect, it } from 'vitest';
import { decayedSourceDuration } from '../src/flowfoam/flowMath';
import { decayFactorPerFrame } from '../src/foam/foamMath';

describe('continuous foam source integration', () => {
  it('preserves the surviving dose across frame partitions for both clocks', () => {
    for (const halfLife of [0.5, 5, 12, 60]) {
      const rate = 0.015, start = 0.1, seconds = 3;
      const exact = start * decayFactorPerFrame(halfLife, seconds)
        + rate * decayedSourceDuration(halfLife, seconds);
      for (const fps of [5, 30, 60, 144]) {
        let coverage = start;
        for (let i = 0; i < seconds * fps; i++) {
          coverage = coverage * decayFactorPerFrame(halfLife, 1 / fps)
            + rate * decayedSourceDuration(halfLife, 1 / fps);
        }
        expect(coverage).toBeCloseTo(exact, 12);
      }
    }
  });
  it('preserves a source switch at a shared frame boundary', () => {
    const evolve = (fps: number) => {
      let value = 0;
      for (let i = 0; i < fps * 4; i++) {
        const source = i < fps ? 0.2 : 0;
        value = value * decayFactorPerFrame(0.5, 1 / fps)
          + source * decayedSourceDuration(0.5, 1 / fps);
      }
      return value;
    };
    expect(evolve(5)).toBeCloseTo(evolve(144), 12);
  });
  it('is zero when paused and retains tiny timesteps without cancellation', () => {
    expect(decayedSourceDuration(5, 0)).toBe(0);
    expect(decayedSourceDuration(5, 1e-12) / 1e-12).toBeCloseTo(1, 12);
  });
  it('rejects invalid clocks instead of poisoning GPU uniforms', () => {
    for (const dt of [-1, NaN, Infinity]) expect(() => decayedSourceDuration(5, dt)).toThrow(RangeError);
    for (const halfLife of [0, -1, NaN, Infinity]) expect(() => decayedSourceDuration(halfLife, 1)).toThrow(RangeError);
  });
});
