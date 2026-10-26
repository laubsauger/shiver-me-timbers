/**
 * The web pull-back (timeline.ts webFlight) flies the eye back out of the hero grain's knot along a slowly
 * turning line. What has to hold for a dome audience and for the act's continuity:
 *   - the hero grain stays where the eye rests: always the same distance away, carried across the dome by
 *     the turn no faster than 1°/s (a fixed point to rest on; nothing lurches)
 *   - the hero grain IS the hero knot: the box's scale and the eye's offset in it put the knot exactly at
 *     the grain's world position (the gas, the stars and the grain are one place)
 *   - the gas only shows once the eye is out of the knot, and is there by the end of the zoom
 */
import { describe, expect, it } from 'vitest';
import { driftParams as p } from '../src/params/drift';
import { beatStarts, eyePath, webFlight } from '../src/drift/undertime/timeline';

const { starts } = beatStarts(p);
const sub = (a: number[], b: number[]) => a.map((x, i) => x - b[i]);
const len = (a: number[]) => Math.hypot(a[0], a[1], a[2]);
const angle = (a: number[], b: number[]) => Math.acos(Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (len(a) * len(b)))) * (180 / Math.PI);

describe('Undertime web flight', () => {
  const eye = eyePath(starts.zoom, p);
  const d0 = len(sub(webFlight(starts.zoom, p).pivot, eye));

  it('keeps the hero grain at rest: same distance, turned across the dome under 1°/s', () => {
    const h = 1 / 30;
    let peak = 0;
    for (let t = starts.zoom; t < starts.gather + p.gather; t += h) {
      const a = webFlight(t, p).pivot;
      const b = webFlight(t + h, p).pivot;
      expect(len(sub(a, eye))).toBeCloseTo(d0, 6);
      peak = Math.max(peak, angle(sub(a, eye), sub(b, eye)) / h);
    }
    expect(peak).toBeLessThan(1);
  });

  it('puts the hero knot exactly at the hero grain', () => {
    for (const t of [starts.zoom + 1, starts.zoom + p.zoom / 2, starts.gather + 2]) {
      const f = webFlight(t, p);
      // the knot is at offset −f.offset from the eye in the box: in the world, eye − offset·box
      const knot = eye.map((x, i) => x - f.offset[i] * f.box);
      expect(len(sub(knot, f.pivot))).toBeLessThan(1e-6 * d0);
    }
  });

  it('shows the gas only once the eye is out of the knot, fully by the end of the zoom', () => {
    expect(webFlight(starts.zoom + 0.5, p).presence).toBeLessThan(0.05);
    expect(webFlight(starts.zoom + p.zoom, p).presence).toBeGreaterThan(0.95);
  });
});
