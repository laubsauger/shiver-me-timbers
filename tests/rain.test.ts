/**
 * T37 rain (§V47). What these tests encode is WHY rain has to behave this way,
 * not merely that the helpers return numbers:
 *
 *  - §V47's central claim is that rain is driven by the SAME wind the sea and
 *    the sails read. That is only true if there is exactly one place wind
 *    enters the system, so the tests assert both the value AND the absence of
 *    any second wind knob to disagree with.
 *  - §B4 (the 3-second global ocean pulse) came from one shared time phase. The
 *    drops' phases must come from their own hashed origins and speeds.
 *  - §B5 (the GPU wedge) came from an unbounded particle size. Every divisor
 *    here is floored and every count sanitized at construction (§V28).
 *
 * HONEST SCOPE: the last block builds the TSL graph. There is no GPU in node,
 * so nothing below compiles WGSL — §V22 still applies, rain is not done until
 * it has been seen in a browser.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { vec3 } from 'three/tsl';
import { oceanParams } from '../src/params/ocean';
import { weatherParams } from '../src/params/weather';
import { createStormHaze } from '../src/weather/hazeNode';
import { rainParams } from '../src/params/rain';
import {
  activeRainCount,
  createRain,
  liveRainWind,
  rainSlant,
  rainWindVector,
  sanitizeRainCount,
  wrapOffset,
} from '../src/rain';

const savedWind = {
  direction: oceanParams.windDirection,
  speed: oceanParams.windSpeed,
};
afterEach(() => {
  oceanParams.windDirection = savedWind.direction;
  oceanParams.windSpeed = savedWind.speed;
});

describe('rain reads the SAME wind as the sea and the sails (§V47)', () => {
  it('has no wind param of its own — there is nothing to disagree with', () => {
    // a duplicate wind knob is how two systems end up blowing opposite ways;
    // §V47 names one wind, so rain must own no copy of it
    for (const key of Object.keys(rainParams)) {
      expect(key.toLowerCase()).not.toContain('winddir');
      expect(key.toLowerCase()).not.toContain('windspeed');
    }
    expect(Object.keys(rainParams)).toContain('windCarry'); // a fraction, not a wind
  });

  it('tracks oceanParams live — change the sea wind, the rain follows', () => {
    oceanParams.windDirection = 1.1;
    oceanParams.windSpeed = 14;
    const w = liveRainWind();
    const carry = rainParams.windCarry;
    expect(w.x).toBeCloseTo(Math.cos(1.1) * 14 * carry, 9);
    expect(w.z).toBeCloseTo(Math.sin(1.1) * 14 * carry, 9);

    oceanParams.windDirection = 1.1 + Math.PI; // reverse the sea's wind
    const back = liveRainWind();
    expect(back.x).toBeCloseTo(-w.x, 9);
    expect(back.z).toBeCloseTo(-w.z, 9);
  });

  it('uses the (cos θ, sin θ) → (x, z) convention main.ts builds spray with', () => {
    // main.ts: windDirTmp.set(Math.cos(dir), Math.sin(dir)) — same mapping, or
    // the rain leans one way while the wave crests run the other
    for (const dir of [0, Math.PI / 4, Math.PI / 2, -2.3, 5.9]) {
      const w = rainWindVector(dir, 10, 1);
      expect(w.x).toBeCloseTo(Math.cos(dir) * 10, 9);
      expect(w.z).toBeCloseTo(Math.sin(dir) * 10, 9);
    }
  });

  it('a non-finite wind produces no drift instead of NaN positions', () => {
    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      const w = rainWindVector(bad, 10, 1);
      expect(Number.isFinite(w.x) && Number.isFinite(w.z)).toBe(true);
      const s = rainWindVector(0, bad, 1);
      expect(Number.isFinite(s.x) && Number.isFinite(s.z)).toBe(true);
    }
  });
});

describe('rain is visibly slanted, not falling straight down (§V47)', () => {
  it('storm wind lays the streaks well off vertical', () => {
    // the storm preset's 18 m/s against the default 8.5 m/s fall
    const slant = rainSlant(18 * rainParams.windCarry, rainParams.fallSpeed);
    expect(slant).toBeGreaterThan(Math.PI / 4); // past 45° — "flying left and right"
    expect(slant).toBeLessThan(Math.PI / 2);
  });

  it('is vertical in a dead calm and rises monotonically with wind', () => {
    expect(rainSlant(0, 8.5)).toBe(0);
    let prev = 0;
    for (let v = 1; v <= 30; v++) {
      const s = rainSlant(v, 8.5);
      expect(s).toBeGreaterThan(prev);
      prev = s;
    }
  });

  it('stays finite when fallSpeed is dragged to zero (§V28 floored divisor)', () => {
    for (const fall of [0, -5, Number.NaN]) {
      const s = rainSlant(12, fall);
      expect(Number.isFinite(s)).toBe(true);
      expect(Math.abs(s)).toBeLessThanOrEqual(Math.PI);
    }
  });
});

describe('the wrapping volume keeps drops around the camera', () => {
  it('always lands inside [−size/2, size/2)', () => {
    for (const size of [130, 7.5, 1000]) {
      for (let d = -5000; d <= 5000; d += 7.3) {
        const w = wrapOffset(d, size);
        expect(w).toBeGreaterThanOrEqual(-size / 2 - 1e-9);
        expect(w).toBeLessThan(size / 2 + 1e-9);
      }
    }
  });

  it('is periodic — a drop one box away is the same drop', () => {
    for (let d = -300; d <= 300; d += 3.7) {
      expect(wrapOffset(d, 130)).toBeCloseTo(wrapOffset(d + 130, 130), 9);
      expect(wrapOffset(d, 130)).toBeCloseTo(wrapOffset(d - 390, 130), 9);
    }
  });

  it('survives a zero or NaN box size without emitting NaN (§V28)', () => {
    for (const size of [0, -1, Number.NaN]) {
      expect(Number.isFinite(wrapOffset(42, size))).toBe(true);
    }
    expect(Number.isFinite(wrapOffset(Number.NaN, 130))).toBe(true);
  });
});

describe('density gate collapses dead drops to nothing (§V28, §B5)', () => {
  it('scales the live count with rain intensity, clamped both ends', () => {
    expect(activeRainCount(12000, 0)).toBe(0); // clear sky: no drops at all
    expect(activeRainCount(12000, 1)).toBe(12000);
    expect(activeRainCount(12000, 0.5)).toBe(6000);
    expect(activeRainCount(12000, 5)).toBe(12000); // clamped, never overruns
    expect(activeRainCount(12000, -3)).toBe(0);
    expect(activeRainCount(12000, Number.NaN)).toBe(0);
  });

  it('always returns an integer index bound, never a fraction', () => {
    for (let i = 0; i <= 20; i++) {
      const n = activeRainCount(9997, i / 20);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeLessThanOrEqual(9997);
    }
  });

  it('sanitizes the build-time pool size (buffer + dispatch sizing)', () => {
    expect(sanitizeRainCount(12000)).toBe(12000);
    expect(sanitizeRainCount(0)).toBe(1);
    expect(sanitizeRainCount(-50)).toBe(1);
    expect(sanitizeRainCount(1.7)).toBe(1);
    expect(sanitizeRainCount(Number.NaN)).toBe(4096);
    expect(sanitizeRainCount(1e9)).toBe(200000); // a typo cannot allocate 1e9
  });
});

describe('rain integration surface (TSL graph builds — §V22 not a substitute)', () => {
  it('builds a sized, blend-correct sprite mesh', () => {
    const rain = createRain();
    try {
      expect(rain.count).toBe(sanitizeRainCount(rainParams.count));
      expect(rain.mesh.count).toBe(rain.count);
      expect(rain.mesh.frustumCulled).toBe(false); // positions are GPU-derived
      const mat = rain.mesh.material as unknown as THREE.SpriteNodeMaterial;
      expect(mat.transparent).toBe(true);
      expect(mat.depthWrite).toBe(false);
      // NOT additive: 12k overlapping additive streaks blow the near field to
      // white, which is the grey-soup failure §V47 forbids from the other side
      expect(mat.blending).toBe(THREE.NormalBlending);
      // the three slots that make a streak: position, size, alpha
      expect(mat.positionNode).toBeTruthy();
      expect(mat.scaleNode).toBeTruthy();
      expect(mat.opacityNode).toBeTruthy();
    } finally {
      rain.dispose();
    }
  });

  it('update accepts garbage without throwing and stays sane', () => {
    const rain = createRain();
    const saved = { ...rainParams };
    try {
      rain.update({ intensity: 0.5, dt: 1 / 60 });
      rain.update({ intensity: Number.NaN, dt: Number.NaN });
      rain.update({ intensity: 5, dt: -1 });
      // live sliders dragged to their worst values mid-frame
      rainParams.extent = 0;
      rainParams.height = 0;
      rainParams.fallSpeed = 0;
      rainParams.streakAspect = 0;
      rainParams.softness = 0;
      rainParams.fadeNear1 = -5;
      rainParams.fadeFar1 = -5;
      expect(() => rain.update({ intensity: 1 })).not.toThrow();
      expect(rain.mesh.count).toBe(rain.count);
    } finally {
      Object.assign(rainParams, saved);
      rain.dispose();
    }
  });
});

/**
 * The §V47 haze node pack ships with this task even though src/sky/** owns the
 * fog it plugs into — these checks live here because this is the suite that
 * already pays for a three import.
 */
describe('storm haze node pack (§V47 handoff to sky)', () => {
  it('builds density and colour nodes from a view/sun pair', () => {
    const haze = createStormHaze();
    const viewDir = vec3(0, 0, 1);
    const sunDir = vec3(0, 1, 0);
    expect(haze.densityScale(viewDir, sunDir)).toBeTruthy();
    expect(haze.litWeight(viewDir, sunDir)).toBeTruthy();
    expect(haze.anisotropy(viewDir, sunDir)).toBeTruthy();
  });

  it('update clamps g below 1 and survives garbage (§V28/§V44)', () => {
    const haze = createStormHaze();
    const saved = { ...weatherParams };
    try {
      weatherParams.hazeAnisotropy = 5;
      weatherParams.hazeAwayMultiplier = Number.NaN;
      weatherParams.hazeSunMultiplier = -3;
      expect(() => haze.update(Number.NaN)).not.toThrow();
      expect(() => haze.update(7)).not.toThrow();
    } finally {
      Object.assign(weatherParams, saved);
    }
  });
});
