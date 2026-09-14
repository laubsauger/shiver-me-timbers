import { describe, expect, it } from 'vitest';
import { sparkleDiscMean } from '../src/ocean/sparkleMath';

function integrateDisc(radius: number, centerX = 0.5, centerY = 0.5): number {
  const samples = 512;
  let sum = 0;
  for (let y = 0; y < samples; y++) {
    for (let x = 0; x < samples; x++) {
      const distance = Math.hypot((x + 0.5) / samples - centerX, (y + 0.5) / samples - centerY);
      const t = Math.max(0, Math.min(1, 1 - distance / radius));
      sum += t * t * (3 - 2 * t);
    }
  }
  return sum / (samples * samples);
}

describe('sparkle retirement averages the shape it replaces', () => {
  it.each([0.1, 0.8 / 2.6, 0.5, 0.6, Math.SQRT1_2, 1, 2.5])(
    'matches a numerical pixel integral at radius %f cells', radius => {
      expect(sparkleDiscMean(radius)).toBeCloseTo(integrateDisc(radius), 5);
    },
  );

  it('has the same mean for inset jittered points', () => {
    const radius = 0.3;
    for (const [x, y] of [[radius, radius], [0.5, 0.6], [1 - radius, 1 - radius]]) {
      expect(sparkleDiscMean(radius)).toBeCloseTo(integrateDisc(radius, x, y), 5);
    }
  });

  it('stays continuous and monotone across the disc and square boundaries', () => {
    let previous = 0;
    for (let i = 0; i <= 500; i++) {
      const mean = sparkleDiscMean(i / 100);
      expect(mean).toBeGreaterThanOrEqual(previous - 1e-12);
      expect(mean).toBeLessThanOrEqual(1);
      previous = mean;
    }
    for (const boundary of [0.5, Math.SQRT1_2]) {
      expect(sparkleDiscMean(boundary - 1e-7)).toBeCloseTo(sparkleDiscMean(boundary + 1e-7), 5);
    }
  });

  it('rejects invalid radius instead of publishing NaN to the shader', () => {
    for (const radius of [-1, NaN, Infinity]) expect(() => sparkleDiscMean(radius)).toThrow();
  });
});
