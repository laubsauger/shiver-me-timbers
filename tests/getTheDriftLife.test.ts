/**
 * Part B tells the planet's life by adding layers in order — fields before forests, lights only once the
 * night has come, cities after villages after camps, the overshoot after the cities, the flood last — and
 * each change must arrive as a gentle wave, never a pop. The descent for the flood stays under the comfort
 * cap like every other move in the show.
 */
import { describe, expect, it } from 'vitest';
import { getTheDriftParams } from '../src/params/getTheDrift';
import { beatStarts, earthPose } from '../src/drift/getTheDrift/timeline';
import { lifeState } from '../src/drift/getTheDrift/life';

const p = { ...getTheDriftParams };
const { starts } = beatStarts(p);
const KEYS = ['fields', 'forests', 'ice', 'lights', 'overshoot', 'sea', 'dusk'] as const;

describe("Get the Drift, the planet's life", () => {
  it('adds the layers in order', () => {
    const mid = (b: 'timewave' | 'lights' | 'overshoot' | 'flood', k: number) => lifeState(starts[b] + p[b] * k, p);
    expect(lifeState(starts.earth + 1, p).fields).toBe(0);
    expect(mid('timewave', 0.3).fields).toBeGreaterThan(mid('timewave', 0.3).forests);
    expect(mid('timewave', 1).forests).toBeCloseTo(1, 6);
    // no lights before the night
    expect(mid('timewave', 1).lights).toBe(0);
    expect(mid('lights', 0.1).dusk).toBeGreaterThan(0);
    expect(mid('lights', 0.1).lights).toBeLessThan(0.05);
    expect(mid('lights', 1).dusk).toBeCloseTo(1, 6);
    expect(mid('lights', 1).lights).toBeGreaterThan(2.9);
    expect(mid('overshoot', 1).overshoot).toBeCloseTo(1, 6);
    // the sea only rises in the flood, and the day comes back with it
    expect(mid('overshoot', 1).sea).toBe(0);
    expect(mid('flood', 1).sea).toBeCloseTo(1, 6);
    expect(mid('flood', 1).dusk).toBeCloseTo(0, 6);
  });

  it('never pops: every value changes by under 2% of its range per frame', () => {
    const h = 1 / 30;
    for (let t = starts.earth; t < starts.drift2 + p.drift2; t += h) {
      const a = lifeState(t, p);
      const b = lifeState(t + h, p);
      for (const k of KEYS) {
        const range = k === 'lights' ? 3.4 : 1;
        expect(Math.abs(b[k] - a[k]) / range, `${k} at ${t.toFixed(2)}`).toBeLessThan(0.02);
      }
    }
  });

  it('comes down for the flood under the comfort cap, the planet never jumping', () => {
    const h = 1 / 30;
    let peak = 0;
    for (let t = starts.timewave; t < starts.drift2 + p.drift2; t += h) {
      const a = earthPose(t, p, 15);
      const b = earthPose(t + h, p, 15);
      const altA = a.distance - 6.371;
      const altB = b.distance - 6.371;
      peak = Math.max(peak, Math.abs(Math.log(altB) - Math.log(altA)) / h);
    }
    expect(peak).toBeLessThan(0.35);
  });
});
