/**
 * The farm's consistency check (scripts/drift-consistency.mjs): the numbers it judges machines by. The coordinator,
 * 2026-10-30: linux-monster's stills came out brighter than the Mac's (sand 137 against 123, ~11%) — "if boxes render
 * differently from each other, master chunks from different machines will jump at the seams". What must hold:
 *   - an exposure shift of that size is "DIFFERS", never noise; a last-bit difference in a few pixels is noise;
 *   - the means and the RMS are the ones a person would compute (luminance with Rec. 709 weights, 0–255).
 */
import { describe, expect, it } from 'vitest';
import { compare, means, NOISE_MEAN, NOISE_RMS, withinNoise } from '../scripts/drift-consistency.mjs';

const pic = (w: number, h: number, f: (i: number) => [number, number, number]) => {
  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) rgb.set(f(i), i * 3);
  return { w, h, rgb };
};

describe('the consistency check\'s numbers', () => {
  const sand = pic(64, 36, () => [123, 118, 105]);
  it('means: per channel, and luminance with Rec. 709 weights', () => {
    const m = means(sand);
    expect([m.r, m.g, m.b]).toEqual([123, 118, 105]);
    expect(m.y).toBeCloseTo(0.2126 * 123 + 0.7152 * 118 + 0.0722 * 105, 6);
  });

  it('the dressing agent\'s case — sand 137 against 123 — differs beyond noise', () => {
    const bright = pic(64, 36, () => [137, 131, 117]);
    const c = compare(bright, sand);
    expect(c.rms).toBeGreaterThan(NOISE_RMS);
    expect(withinNoise(means(bright), means(sand), c)).toBe(false);
    expect(c.p99).toBe(14);
  });

  it('a last-bit difference in a few pixels (another GPU\'s rounding in the foam) is noise', () => {
    const near = pic(64, 36, (i) => (i % 50 === 0 ? [124, 119, 106] : [123, 118, 105]));
    const c = compare(near, sand);
    expect(c.rms).toBeLessThan(0.5);
    expect(Math.abs(means(near).y - means(sand).y)).toBeLessThan(NOISE_MEAN);
    expect(withinNoise(means(near), means(sand), c)).toBe(true);
  });

  it('the heatmap marks where the pictures differ, ×8', () => {
    const one = pic(4, 1, (i) => (i === 2 ? [133, 128, 115] : [123, 118, 105]));
    const c = compare(one, pic(4, 1, () => [123, 118, 105]));
    expect([...c.heat]).toEqual([0, 0, 80, 0]);
  });
});
