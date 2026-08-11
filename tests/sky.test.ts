/**
 * Sky day-cycle math tests (§V16). WHY these matter: the sun direction and
 * color ramps feed every lit system — ocean SSS/sparkle, cloud sun channel,
 * fog, the light rig. A discontinuity or out-of-range color here shows up as
 * a full-scene flash or teleporting shadows, so the pure math is pinned down
 * before any GPU work depends on it.
 */
import { describe, expect, it } from 'vitest';
import {
  daylight,
  lowSunWarmth,
  skyTint,
  sunColor,
  sunDirection,
  sunElevation,
} from '../src/sky/sunCycle';

const len = (v: [number, number, number]) => Math.hypot(v[0], v[1], v[2]);
const angleBetween = (a: [number, number, number], b: [number, number, number]) =>
  Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));

describe('sunDirection (drives every shadow + specular in the scene)', () => {
  it('is unit length at any hour and latitude', () => {
    for (const lat of [-60, -15, 0, 15, 45, 60]) {
      for (let t = 0; t <= 24; t += 0.5) {
        expect(len(sunDirection(t, lat))).toBeCloseTo(1, 10);
      }
    }
  });

  it('never teleports across the midnight wrap — lights would visibly snap', () => {
    const before = sunDirection(23.999, 15);
    const after = sunDirection(0.001, 15);
    expect(angleBetween(before, after)).toBeLessThan(0.01);
  });

  it('moves smoothly through a whole day (no jump anywhere, not just at 0h)', () => {
    // 1 sim-minute steps; a day is 2π of hour angle so each step is tiny
    let prev = sunDirection(0, 15);
    for (let t = 1 / 60; t <= 24.0001; t += 1 / 60) {
      const cur = sunDirection(t, 15);
      expect(angleBetween(prev, cur)).toBeLessThan(0.01);
      prev = cur;
    }
  });

  it('handles out-of-range hours by wrapping (day cycle loops forever)', () => {
    expect(sunDirection(25, 15)).toEqual(sunDirection(1, 15));
    expect(sunDirection(-2, 15)).toEqual(sunDirection(22, 15));
  });

  it('rises in the east, sets in the west (morning sun lights the +x side)', () => {
    expect(sunDirection(8, 15)[0]).toBeGreaterThan(0);
    expect(sunDirection(16, 15)[0]).toBeLessThan(0);
  });
});

describe('sunElevation (day/night arc every intensity ramp keys off)', () => {
  it('noon is higher than morning — otherwise the whole day arc is wrong', () => {
    expect(sunElevation(12, 15)).toBeGreaterThan(sunElevation(8, 15));
  });

  it('noon is the daily maximum and midnight is below the horizon', () => {
    const noon = sunElevation(12, 15);
    for (let t = 0; t < 24; t += 0.25) {
      expect(sunElevation(t, 15)).toBeLessThanOrEqual(noon + 1e-12);
    }
    expect(sunElevation(0, 15)).toBeLessThan(0);
  });

  it('tropical latitude keeps noon sun near zenith (the SoT look)', () => {
    expect(sunElevation(12, 0)).toBeCloseTo(Math.PI / 2, 6);
    expect(sunElevation(12, 15)).toBeGreaterThan(1.2);
  });
});

describe('color ramps (multiplied into materials — must stay 0..1)', () => {
  const elevations = [-2, -0.5, -0.1, 0, 0.05, 0.3, 0.8, Math.PI / 2, 3];

  it('sunColor and skyTint clamp every channel to 0..1 for any elevation', () => {
    for (const e of elevations) {
      for (const c of [...sunColor(e), ...skyTint(e)]) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
  });

  it('low sun is warmer than noon (red-blue gap shrinks as the sun climbs)', () => {
    const dawn = sunColor(0.05);
    const noon = sunColor(1.3);
    expect(dawn[0] - dawn[2]).toBeGreaterThan(noon[0] - noon[2]);
  });

  it('skyTint darkens at night so the whole scene dims as one', () => {
    const night = skyTint(-0.5);
    const day = skyTint(1.0);
    expect(night[0] + night[1] + night[2]).toBeLessThan(day[0] + day[1] + day[2]);
  });

  it('daylight is 0 below horizon and 1 at high sun; warmth peaks at sunset', () => {
    expect(daylight(-0.3)).toBe(0);
    expect(daylight(1.0)).toBe(1);
    expect(lowSunWarmth(0.02)).toBeGreaterThan(lowSunWarmth(1.0));
    expect(lowSunWarmth(0.02)).toBeGreaterThan(lowSunWarmth(-0.3));
  });
});
