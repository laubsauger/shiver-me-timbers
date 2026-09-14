import { describe, expect, it } from 'vitest';
import { propWashFoamCpu } from '../src/flowfoam/simFoam';
import type { PropWashInput } from '../src/wake/propWash';

const jet: PropWashInput = {
  x: 0, z: 0, dirX: 0, dirZ: -1, thrust: 6000,
  discArea: Math.PI * 0.2 ** 2, depth: 0, advance: 30,
  immersion: 0.5, surfaceY: 0, propRps: 60,
};
const rate = (distance: number, finite: boolean, side = 0) =>
  propWashFoamCpu([jet], side, -distance, 0.234, finite);

describe('fresh prop foam is local; deposited foam owns the long trail', () => {
  it('retains the propeller source while suppressing fresh injection far astern', () => {
    expect(rate(0, true)).toBeGreaterThan(0);
    expect(rate(0, true)).toBe(rate(0, false));
    expect(rate(30, true)).toBeLessThan(rate(30, false) * 0.1);
    expect(rate(50, true)).toBeLessThan(rate(50, false) * 0.025);
    let previous = rate(3, true);
    for (let distance = 4; distance <= 60; distance++) {
      const current = rate(distance, true);
      expect(current).toBeLessThan(previous);
      previous = current;
    }
  });

  it('preserves co-flow ribbon width and symmetry while thinning its dose', () => {
    const oldCentre = rate(12, false), newCentre = rate(12, true);
    for (const side of [-1, -0.5, 0.5, 1]) {
      expect(rate(12, true, side) / newCentre).toBeCloseTo(rate(12, false, side) / oldCentre, 12);
      expect(rate(12, true, side)).toBeCloseTo(rate(12, true, -side), 12);
    }
  });

  it('generates no foam from idle props or outside the bounded source', () => {
    expect(propWashFoamCpu([{ ...jet, thrust: 0, immersion: 0 }], 0, -5, 0.234, true)).toBe(0);
    expect(rate(61, true)).toBe(0);
  });
});
