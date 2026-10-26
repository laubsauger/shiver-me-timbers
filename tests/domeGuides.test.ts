/**
 * The guides are how a shot is staged for the dome without a dome booking, so they must agree with the
 * master's own convention (front at the bottom, right at the right) and put the tilted dome's eye level
 * where it really is: τ above the spring line at the front, on it at the sides, τ below it at the back.
 */
import { describe, expect, it } from 'vitest';
import { domePoint, eyeLevelElevation } from '../src/drift/domeGuides';

describe('dome guides geometry', () => {
  it('places front at the bottom, right at the right, the zenith at the centre (canvas y down)', () => {
    const [fx, fy] = domePoint(0, 0, 100, 100, 100);
    expect([fx, fy].map((v) => +v.toFixed(9))).toEqual([100, 200]);
    const [rx, ry] = domePoint(0, 90, 100, 100, 100);
    expect([rx, ry].map((v) => +v.toFixed(9))).toEqual([200, 100]);
    expect(domePoint(90, 37, 100, 100, 100).map((v) => +v.toFixed(9))).toEqual([100, 100]);
  });

  it('puts the eye-level horizon of a tilted dome at ±tilt front/back and at the spring line at the sides', () => {
    expect(eyeLevelElevation(0, 15)).toBeCloseTo(15, 9);
    expect(eyeLevelElevation(180, 15)).toBeCloseTo(-15, 9);
    expect(eyeLevelElevation(90, 15)).toBeCloseTo(0, 9);
    expect(eyeLevelElevation(0, 0)).toBe(0);
  });
});
