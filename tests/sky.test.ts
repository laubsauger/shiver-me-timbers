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
  fogRange,
  lowSunWarmth,
  skyTint,
  sunColor,
  sunDirection,
  sunDiscCosines,
  sunElevation,
} from '../src/sky/sunCycle';
import { shadowBasis, shadowTexelSize, snapShadowCenter } from '../src/sky/shadowMath';

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

describe('shadow texel snapping (why: unsnapped = crawling shadow edges)', () => {
  const sun = sunDirection(16.4, 15);
  const texel = shadowTexelSize(80, 2048); // 7.8 cm at the shipped settings

  it('derives the texel size the renderer actually uses', () => {
    expect(texel).toBeCloseTo(0.078125, 10);
    expect(shadowTexelSize(80, 4096)).toBeCloseTo(texel / 2, 10);
  });

  it('refuses to divide by nonsense — snapping off, never NaN (§V28)', () => {
    for (const [e, m] of [[0, 2048], [80, 0], [-80, 2048], [NaN, 2048], [80, NaN]] as Array<
      [number, number]
    >) {
      expect(shadowTexelSize(e, m)).toBe(0);
    }
    // texel 0 must pass the centre straight through, not emit NaN
    const c: [number, number, number] = [12.3, 0, -4.5];
    expect(snapShadowCenter(c, sun, 0)).toEqual(c);
    expect(snapShadowCenter(c, sun, NaN)).toEqual(c);
    expect(snapShadowCenter(c, [0, 0, 0], texel).every(Number.isFinite)).toBe(true);
    expect(snapShadowCenter(c, [0, 1, 0], texel).every(Number.isFinite)).toBe(true);
  });

  it('holds the frustum STILL while the ship moves within one texel', () => {
    // this is the whole point: sub-texel ship motion must not move the grid,
    // or every shadow edge re-samples on a new grid and visibly crawls
    const base = snapShadowCenter([100, 0, 100], sun, texel);
    const { x, y } = shadowBasis(sun);
    for (const f of [0, 0.1, -0.2, 0.35, -0.45, 0.49]) {
      const nudged: [number, number, number] = [
        base[0] + x[0] * f * texel + y[0] * f * texel,
        base[1] + x[1] * f * texel + y[1] * f * texel,
        base[2] + x[2] * f * texel + y[2] * f * texel,
      ];
      const snapped = snapShadowCenter(nudged, sun, texel);
      for (let i = 0; i < 3; i++) expect(snapped[i]).toBeCloseTo(base[i], 9);
    }
  });

  it('moves by WHOLE texels when the ship crosses cell boundaries', () => {
    const { x } = shadowBasis(sun);
    const start = snapShadowCenter([0, 0, 0], sun, texel);
    for (const n of [1, 2, 7, 40]) {
      const moved: [number, number, number] = [
        start[0] + x[0] * n * texel,
        start[1] + x[1] * n * texel,
        start[2] + x[2] * n * texel,
      ];
      const snapped = snapShadowCenter(moved, sun, texel);
      const du =
        (snapped[0] - start[0]) * x[0] +
        (snapped[1] - start[1]) * x[1] +
        (snapped[2] - start[2]) * x[2];
      expect(du / texel).toBeCloseTo(n, 6); // exactly n texels, no drift
    }
  });

  it('never strays more than half a texel — the ship stays framed', () => {
    const { x, y } = shadowBasis(sun);
    for (let i = 0; i < 200; i++) {
      const c: [number, number, number] = [i * 3.7 - 300, 0, i * -2.9 + 120];
      const s = snapShadowCenter(c, sun, texel);
      const d: [number, number, number] = [s[0] - c[0], s[1] - c[1], s[2] - c[2]];
      const du = d[0] * x[0] + d[1] * x[1] + d[2] * x[2];
      const dv = d[0] * y[0] + d[1] * y[1] + d[2] * y[2];
      expect(Math.abs(du)).toBeLessThanOrEqual(texel / 2 + 1e-9);
      expect(Math.abs(dv)).toBeLessThanOrEqual(texel / 2 + 1e-9);
    }
  });

  it('never slides along the light axis — that would move near/far', () => {
    const { z } = shadowBasis(sun);
    for (const c of [
      [10, 2, -30],
      [-1234, 5, 987],
      [0.001, 0, 0.001],
    ] as Array<[number, number, number]>) {
      const s = snapShadowCenter(c, sun, texel);
      const before = c[0] * z[0] + c[1] * z[1] + c[2] * z[2];
      const after = s[0] * z[0] + s[1] * z[1] + s[2] * z[2];
      expect(after).toBeCloseTo(before, 9);
    }
  });

  it('builds an orthonormal basis at every sun position of the day', () => {
    // if this basis drifts from three's lookAt the snap quantises against a
    // grid the renderer never uses, and the flicker survives the "fix"
    for (let t = 0; t <= 24; t += 0.25) {
      for (const lat of [-60, 0, 15, 70]) {
        const { x, y, z } = shadowBasis(sunDirection(t, lat));
        for (const v of [x, y, z]) {
          expect(Math.hypot(v[0], v[1], v[2])).toBeCloseTo(1, 9);
        }
        const d = (a: [number, number, number], b: [number, number, number]) =>
          a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        expect(d(x, y)).toBeCloseTo(0, 9);
        expect(d(x, z)).toBeCloseTo(0, 9);
        expect(d(y, z)).toBeCloseTo(0, 9);
      }
    }
  });
});

describe('sunDiscCosines (edges of the sky shader smoothstep)', () => {
  it('orders the edges so smoothstep(outer, inner, dot) grows toward the sun', () => {
    // cosine falls as the angle grows, so the outer (wider) edge must be the
    // SMALLER number — swap them and the disc inverts into a hole in the sky
    const [outer, inner] = sunDiscCosines(1.1, 0.35);
    expect(outer).toBeLessThan(inner);
    expect(inner).toBeCloseTo(Math.cos((1.1 * Math.PI) / 180), 12);
    expect(outer).toBeCloseTo(Math.cos((1.45 * Math.PI) / 180), 12);
  });

  it('never collapses both edges together — equal edges are a NaN sky (§V28)', () => {
    // the panel lets softness be typed to 0 (or garbage); smoothstep divides
    // by (inner - outer), so a zero gap NaNs every pixel of the background
    for (const [size, soft] of [
      [1.1, 0],
      [0, 0],
      [3, -2],
      [1, NaN],
      [NaN, NaN],
    ] as Array<[number, number]>) {
      const [outer, inner] = sunDiscCosines(size, soft);
      expect(Number.isFinite(outer)).toBe(true);
      expect(Number.isFinite(inner)).toBe(true);
      expect(inner - outer).toBeGreaterThan(0);
    }
  });

  it('a bigger disc reaches further from the sun axis', () => {
    expect(sunDiscCosines(3, 0.5)[1]).toBeLessThan(sunDiscCosines(1, 0.5)[1]);
  });
});

describe('fogRange (distance haze must never become a divide-by-zero)', () => {
  it('passes sane authored ranges through untouched', () => {
    expect(fogRange(700, 4500)).toEqual([700, 4500]);
  });

  it('keeps far strictly above near — three divides by (far - near) (§V28)', () => {
    for (const [n, f] of [
      [4000, 4000],
      [4000, 100],
      [900, NaN],
      [NaN, 5000],
      [-500, 200],
    ] as Array<[number, number]>) {
      const [near, far] = fogRange(n, f);
      expect(Number.isFinite(near)).toBe(true);
      expect(Number.isFinite(far)).toBe(true);
      expect(far).toBeGreaterThan(near);
      expect(near).toBeGreaterThanOrEqual(0);
    }
  });

  it('leaves room for a kilometre-scale sea — no clamp to a few hundred m (§V30)', () => {
    // the ocean draws to kilometres; a fog range that saturated before the
    // water ends is exactly the "wall" the user reported
    expect(fogRange(1500, 16000)).toEqual([1500, 16000]);
  });
});
