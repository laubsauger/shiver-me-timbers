import { describe, expect, it } from 'vitest';
import { orientationMoment, orientationWeights, retainOrientation, type OrientationOps } from '../src/flowfoam/wakeOrientation';

const A: OrientationOps<number> = {
  k: x => x, add: (a, b) => a + b, sub: (a, b) => a - b,
  mul: (a, b) => a * b, div: (a, b) => a / b, max: Math.max,
};

describe('wake lace belongs to emitted foam', () => {
  it('retains an old emission axis through decay without reading a live heading', () => {
    let coverage = 0.8;
    let moment = orientationMoment(A, 12, 4, coverage);
    const original = moment.map(v => v / coverage);
    for (let frame = 0; frame < 600; frame++) {
      const nextCoverage = coverage * 0.99;
      moment = moment.map(v => retainOrientation(A, v, 0, 0.99, nextCoverage, nextCoverage)) as [number, number];
      coverage = nextCoverage;
    }
    expect(moment[0] / coverage).toBeCloseTo(original[0], 12);
    expect(moment[1] / coverage).toBeCloseTo(original[1], 12);
  });

  it('keeps a rival direction independent and treats opposite travel as the same line axis', () => {
    expect(orientationMoment(A, 0, 20, 0.7)).toEqual([-0.7, 0]);
    const forward = orientationMoment(A, 12, -8, 0.4);
    const reverse = orientationMoment(A, -12, 8, 0.4);
    expect(reverse).toEqual(forward);
  });

  it('makes equal perpendicular crossings isotropic and gives stronger foam more influence', () => {
    const east = orientationMoment(A, 20, 0, 0.5);
    const north = orientationMoment(A, 0, 20, 0.5);
    expect(east.map((v, i) => v + north[i])).toEqual([0, 0]);
    expect(orientationMoment(A, 20, 0, 0.75)[0] + orientationMoment(A, 0, 20, 0.25)[0]).toBe(0.5);
  });

  it('saturation caps moments with coverage, so subsequent injections cannot exceed unit anisotropy', () => {
    let m = 0, coverage = 0;
    for (let i = 0; i < 300; i++) {
      const total = coverage * 0.98 + 0.2;
      coverage = Math.min(1, total);
      m = retainOrientation(A, m, 0.2, 0.98, coverage, total);
      expect(m).toBeCloseTo(coverage, 12);
    }
  });

  it('selects fixed axes without a world-position transform', () => {
    expect(orientationWeights(A, 1, 0)).toEqual([1, 0, 0, 0]);
    expect(orientationWeights(A, 0, 1)).toEqual([0, 1, 0, 0]);
    expect(orientationWeights(A, -1, 0)).toEqual([0, 0, 1, 0]);
    expect(orientationWeights(A, 0, -1)).toEqual([0, 0, 0, 1]);
  });

  it('crossings stay finite and direction changes blend continuously across ±90°', () => {
    expect(orientationWeights(A, 0, 0)).toEqual([0.25, 0.25, 0.25, 0.25]);
    const weights = [-1e-8, 1e-8].map(dx => {
      const q = orientationMoment(A, dx, 1, 1);
      return orientationWeights(A, q[0], q[1]);
    });
    expect(Math.max(...weights[0].map((w, i) => Math.abs(w - weights[1][i])))).toBeLessThan(1e-7);
    for (let angle = -Math.PI; angle <= Math.PI; angle += 0.07) {
      const q = orientationMoment(A, Math.cos(angle), Math.sin(angle), 1);
      const w = orientationWeights(A, q[0], q[1]);
      expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
      expect(Math.min(...w)).toBeGreaterThanOrEqual(0);
    }
  });
});
