/**
 * Undertime's timeline stages the physics in order, and on a dome a jump in density or light at a beat
 * boundary changes the whole field of view at once — it reads as a pop, not a cut. These hold the story
 * order (pairs thin out, the final wave, grains remain, the scale pulls back, the grains gather) and the
 * continuity of every value across boundaries.
 */
import { describe, expect, it } from 'vitest';
import { driftParams } from '../src/params/drift';
import { BEATS, beatStarts, undertimeState } from '../src/drift/undertime/timeline';

const p = { ...driftParams };
const { starts, total } = beatStarts(p);
const KEYS = ['pairDensity', 'flashGain', 'glow', 'grains', 'scale', 'gather', 'starlight'] as const;

describe('Undertime timeline', () => {
  it('names the beats in story order', () => {
    expect(undertimeState(0, p).beat).toBe('boil');
    for (const b of BEATS) expect(undertimeState(starts[b] + p[b] * 0.5, p).beat).toBe(b);
    expect(undertimeState(total + 1, p).beat).toBe('end');
  });

  it('stages the physics: dense pairs → none, grains only after the final wave, starlight last', () => {
    const at = (b: (typeof BEATS)[number], k: number) => undertimeState(starts[b] + p[b] * k, p);
    expect(at('boil', 0.5).pairDensity).toBeCloseTo(1, 6);
    expect(at('cool', 1).pairDensity).toBeLessThan(0.3);
    expect(at('remain', 0).pairDensity).toBeCloseTo(0, 6);
    expect(at('cool', 0.5).grains).toBe(0);
    expect(at('remain', 0).grains).toBeCloseTo(1, 6);
    // the final wave is brighter than the end of cooling, and the remain beat ends dim
    expect(at('annihilate', 0.5).glow).toBeGreaterThan(at('cool', 1).glow);
    expect(at('remain', 1).glow).toBeLessThan(0.15);
    expect(at('zoom', 1).scale).toBeCloseTo(10 ** -p.zoomDecades, 9);
    expect(at('gather', 0.2).starlight).toBe(0);
    expect(at('gather', 1).starlight).toBeCloseTo(1, 6);
  });

  it('every value is continuous across every beat boundary', () => {
    for (const b of BEATS) {
      const t = starts[b];
      const before = undertimeState(t - 1e-6, p);
      const after = undertimeState(t + 1e-6, p);
      for (const k of KEYS) expect(Math.abs(after[k] - before[k]), `${k} at the start of ${b}`).toBeLessThan(1e-3);
    }
  });

  it('is a pure function of time: the same t gives the same frame', () => {
    for (let t = 0; t < total; t += 0.37) expect(undertimeState(t, p)).toEqual(undertimeState(t, p));
  });
});
