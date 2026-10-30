/**
 * The other rafts at sea in c2–c4 (src/drift/wandering/farRafts.ts; direction.md C2: "other rafts and small vessels far
 * off on the horizon, each alone, all drifting the same way"). The user could not read them on a c2 sunset frame
 * (2026-10-30: "Are these pirate ships, or two other rafts?"): five copies of our raft as specks at 950–2100 m, two of
 * them behind our own sail. What must hold, whatever they are tuned to:
 *
 *   - some come near enough to read (200–350 m: our raft's 8.3 m is then ~1.4–2.4°, its square sail and hut a
 *     silhouette; at 480 m it was a speck again in the 16:9 frame), in the front half of the dome where the eye
 *     looks, and not behind our raft (24° right of the front at 15 m, its sail and logs covering ~0–50° right in c2);
 *   - the rest stay far, and their sizes vary (a canoe-sized one, a bigger one);
 *   - none stands on a Rose station's bearing (their islands are 7 km off, ±4°), nor on the eye's own way ahead.
 */
import { describe, expect, it } from 'vitest';
import { FAR_RAFTS, ROSE_CLEAR } from '../src/drift/wandering/farRafts';
import { STATIONS } from '../src/drift/wandering/props';

const apart = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180);

describe('the other rafts', () => {
  it('bring some near enough to read, in front, clear of our own raft', () => {
    const near = FAR_RAFTS.filter((f) => f.distance >= 200 && f.distance <= 350);
    expect(near.length).toBeGreaterThanOrEqual(2);
    for (const f of near) {
      expect(Math.abs(f.bearing)).toBeLessThan(90);
      expect(f.bearing < -5 || f.bearing > 55).toBe(true);
    }
  });

  it('keep the rest far off, and vary in size from a canoe to bigger than ours', () => {
    expect(FAR_RAFTS.filter((f) => f.distance > 1000).length).toBeGreaterThanOrEqual(2);
    expect(Math.min(...FAR_RAFTS.map((f) => f.scale))).toBeLessThanOrEqual(0.7);
    expect(Math.max(...FAR_RAFTS.map((f) => f.scale))).toBeGreaterThanOrEqual(1.25);
  });

  it('stand on no Rose station\'s bearing and not on the eye\'s way ahead', () => {
    for (const f of FAR_RAFTS) {
      for (const s of STATIONS) expect(apart(f.bearing, s)).toBeGreaterThanOrEqual(ROSE_CLEAR);
      expect(Math.abs(f.bearing)).toBeGreaterThanOrEqual(10);
    }
  });
});
