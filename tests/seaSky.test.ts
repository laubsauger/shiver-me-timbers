/**
 * The sky over the sea is Act 2's air seen from just above the water (src/drift/wandering/seaSky.ts), tuned
 * against measured photographs (drift-narrative/references/sea-golden-hour-sky, sea-dusk-twilight). What
 * must hold, whatever its constants become: the Sun reddens and goes out as it sets; after sunset the sky
 * stays blue overhead (ozone — without it the twilight zenith goes grey or purple, which is what the first
 * version did) and is warmer toward where the Sun went down than opposite; the twilight sky outshines the
 * night by orders of magnitude; and the eye opens as the light falls, but only so far (night stays night).
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { adaptation, radianceCpu, sunlightCpu } from '../src/drift/wandering/seaSky';
import { EARTH_R } from '../src/drift/getTheDrift/atmosphere';

const r0 = EARTH_R + 3e-6; // 3 m above the sea, in Mm
const sunAt = (deg: number): THREE.Vector3 => {
  const e = (deg * Math.PI) / 180;
  return new THREE.Vector3(0, Math.sin(e), -Math.cos(e));
};
const dir = (elDeg: number, towardSun: boolean): THREE.Vector3 => {
  const e = (elDeg * Math.PI) / 180;
  return new THREE.Vector3(0, Math.sin(e), (towardSun ? -1 : 1) * Math.cos(e));
};
const lum = (c: number[]): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

describe('the sea sky', () => {
  it('reddens the Sun as it sets, and puts it out below the horizon', () => {
    const high = sunlightCpu(r0, sunAt(30).y);
    const low = sunlightCpu(r0, sunAt(3).y);
    expect(high[2] / high[0]).toBeGreaterThan(low[2] / low[0]);
    expect(low[0]).toBeGreaterThan(low[2] * 3);
    expect(lum(sunlightCpu(r0, sunAt(-1).y))).toBeLessThan(1e-3);
  });

  it('stays blue overhead through twilight (ozone)', () => {
    for (const el of [-2, -4, -6]) {
      const z = radianceCpu(r0, new THREE.Vector3(0, 1, 0), sunAt(el));
      expect(z[2], `sun ${el}°`).toBeGreaterThan(z[0] * 1.3);
    }
  });

  it('is warmer low toward the set Sun than opposite it', () => {
    for (const el of [-1, -3]) {
      const toward = radianceCpu(r0, dir(2, true), sunAt(el));
      const away = radianceCpu(r0, dir(2, false), sunAt(el));
      expect(toward[0] / toward[2], `sun ${el}°`).toBeGreaterThan(away[0] / away[2]);
      expect(lum(toward)).toBeGreaterThan(lum(away));
    }
  });

  it('falls by orders of magnitude from twilight into night', () => {
    const z = (el: number): number => lum(radianceCpu(r0, new THREE.Vector3(0, 1, 0), sunAt(el)));
    expect(z(-2)).toBeGreaterThan(z(-6) * 3);
    expect(z(-6)).toBeGreaterThan(z(-12) * 30);
  });

  it('opens the eye as the light falls, only so far', () => {
    expect(adaptation(0.4)).toBeCloseTo(1, 6);
    expect(adaptation(0.04)).toBeGreaterThan(adaptation(0.4));
    expect(adaptation(1e-6)).toBe(adaptation(1e-9));
    expect(adaptation(1e-9)).toBeLessThanOrEqual(14);
  });
});
