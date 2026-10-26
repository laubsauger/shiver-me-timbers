/**
 * Get the Drift's arrival is one long approach from where Undertime leaves the eye to the Sun point inside
 * our galaxy. On a dome it must start exactly where Act 1 stopped and at rest (no lurch at the hand-over),
 * stay under the comfort cap for exponential flight (0.35 e-folds of distance per second), and actually end
 * up inside the disk for the band — and our galaxy must be laid so its band arcs over the audience with the
 * bright centre low in front.
 */
import { describe, expect, it } from 'vitest';
import { getTheDriftParams } from '../src/params/getTheDrift';
import { arrivalEye, arrivalState, beatStarts, domeDir, earthPose, ourGalaxy, ramped } from '../src/drift/getTheDrift/timeline';
import type { Vec3 } from '../src/cine/domeMaster';

const p = { ...getTheDriftParams };
const e0: Vec3 = [0, 0.3, -5];
const tilt = 15;
const g = ourGalaxy(p, e0, tilt);
const { starts, total } = beatStarts(p);
const dist = (a: number[], b: number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const dot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe('Get the Drift arrival', () => {
  it('ramps: starts and ends at rest, reaches 1', () => {
    expect(ramped(0, 0.3, 0.2)).toBe(0);
    expect(ramped(1, 0.3, 0.2)).toBeCloseTo(1, 9);
    const h = 1e-4;
    expect(ramped(h, 0.3, 0.2) / h).toBeLessThan(1e-3);
    expect((1 - ramped(1 - h, 0.3, 0.2)) / h).toBeLessThan(1e-3);
  });

  it('starts exactly where Undertime left the eye, at rest', () => {
    expect(dist(arrivalEye(0, p, g), e0)).toBeLessThan(1e-9);
    expect(dist(arrivalEye(0.1, p, g), e0) / 0.1).toBeLessThan(1e-3);
  });

  it('never flies faster than 0.35 e-folds of distance per second', () => {
    const h = 1 / 30;
    let peak = 0;
    for (let t = 0; t < total; t += h) {
      const a = arrivalState(t, p).f;
      const b = arrivalState(t + h, p).f;
      peak = Math.max(peak, Math.abs(Math.log(b) - Math.log(a)) / h);
    }
    expect(peak).toBeLessThan(0.35);
  });

  it('is inside the disk (within its thickness) and still for the band', () => {
    const h = 0.02 * p.ourRadius;
    for (const k of [0.1, 0.5, 0.9]) {
      const e = arrivalEye(starts.band + p.band * k, p, g);
      const z = dot([e[0] - g.centre[0], e[1] - g.centre[1], e[2] - g.centre[2]], g.normal);
      expect(Math.abs(z)).toBeLessThan(h);
    }
    const a = arrivalEye(starts.band + 1, p, g);
    const b = arrivalEye(starts.band + 2, p, g);
    expect(dist(a, b)).toBeLessThan(1e-6);
  });

  it('lays the band over the audience: the galactic centre low in front, the plane through the zenith', () => {
    const toCentre = [g.centre[0] - g.sun[0], g.centre[1] - g.sun[1], g.centre[2] - g.sun[2]];
    const l = Math.hypot(toCentre[0], toCentre[1], toCentre[2]);
    const front = domeDir(p.centreEl, 0, tilt);
    expect(dot(toCentre, front) / l).toBeGreaterThan(0.9);
    // the zenith lies close to the plane (leaned by bandLean only)
    const zenith = domeDir(90, 0, tilt);
    expect(Math.abs(dot(zenith, g.normal))).toBeLessThan(Math.sin(((p.bandLean + 5) * Math.PI) / 180));
  });

  describe('Earth', () => {
    const deg = (a: number[], b: number[]) => (Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180) / Math.PI;
    const h = 1 / 30;

    it('comes in under the comfort cap and slides across the sky no faster than 6°/s', () => {
      let rate = 0;
      let slide = 0;
      for (let t = starts.earth; t < starts.earth + p.earth; t += h) {
        const a = earthPose(t, p, tilt);
        const b = earthPose(t + h, p, tilt);
        rate = Math.max(rate, Math.abs(Math.log(b.distance) - Math.log(a.distance)) / h);
        slide = Math.max(slide, deg(a.centreDir, b.centreDir) / h);
      }
      expect(rate).toBeLessThan(0.35);
      expect(slide).toBeLessThan(6);
    });

    it('never passes in front of the Sun on the way in, and leaves it clear of the limb', () => {
      for (let t = starts.earth; t < starts.earth + p.earthApproach; t += 0.1) {
        const e = earthPose(t, p, tilt);
        expect(deg(e.centreDir, e.sun) - e.radiusDeg, `at ${t.toFixed(1)} s`).toBeGreaterThan(1);
      }
      const arrived = earthPose(starts.earth + p.earthApproach, p, tilt);
      const clear = deg(arrived.centreDir, arrived.sun) - arrived.radiusDeg;
      expect(clear).toBeGreaterThan(1);
      expect(clear).toBeLessThan(30);
    });

    it('puts the dawn on the planet: the terminator crosses the visible face (lit and dark both in view)', () => {
      const e = earthPose(starts.earth + p.earthApproach, p, tilt);
      const toEye = e.centreDir.map((x) => -x);
      // the sub-eye point is in night, but the Sun lights part of the visible hemisphere
      const sunElAtSubEye = 90 - deg(toEye, e.sun);
      expect(sunElAtSubEye).toBeLessThan(0);
      expect(sunElAtSubEye).toBeGreaterThan(-60);
    });

    it('starts as a point near the Sun and ends with its limb across the front of the dome', () => {
      const first = earthPose(starts.earth, p, tilt);
      expect(first.radiusDeg).toBeLessThan(0.2);
      expect(deg(first.centreDir, first.sun)).toBeLessThan(30);
      const last = earthPose(starts.earth + p.earthApproach, p, tilt);
      const limbTop = 90 - deg(last.centreDir, domeDir(90, 0, tilt)) + last.radiusDeg;
      expect(limbTop).toBeCloseTo(p.limbEl, 0);
    });
  });
});
