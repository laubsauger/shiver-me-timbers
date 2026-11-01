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
import { adaptation, radianceCpu, skyIrradiance, sunlightCpu } from '../src/drift/wandering/seaSky';
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
    expect(adaptation(1e-9)).toBe(adaptation(1e-12));
    expect(adaptation(1e-9)).toBeLessThanOrEqual(14);
  });

  it('holds the twilight dark, the golden hour and the full night as they were', () => {
    // (the 2026-11-01 review: the dusk "still dusky … too bright" — the eye opened as fast as the light fell, 3.5× at
    // −3°, 13× at −9°). E: the sky's light on the sea, as seaSky.update takes it
    const E = (el: number): number => lum(skyIrradiance(EARTH_R, sunAt(el)));
    const old = (l: number): number => Math.min(14, Math.sqrt(0.4 / Math.max(l, 1e-9)));
    // the golden hour and the day: the eye as it was
    for (const el of [30, 5, 1, 0.2]) expect(adaptation(E(el))).toBeCloseTo(old(E(el)), 6);
    // the twilight: well under the old lift (a darker sky, sooner): ~0.7× of it at −3°, ~0.5× through the deep blue
    for (const [el, k] of [[-3, 0.75], [-6, 0.6], [-9, 0.6]]) expect(adaptation(E(el)), `at ${el}°`).toBeLessThan(old(E(el)) * k);
    // the full night: the eye open as far as it was (the Milky Way, the beacons, the lanterns read as they did)
    for (const el of [-16, -18, -20]) expect(adaptation(E(el))).toBeCloseTo(14, 6);
    // and the eye only ever opens as the Sun goes down (no pumping): the exposure never falls while the light does,
    // and the lit surfaces' level (exposure × (sky + the night light)) has one low, never a bump over the night's
    const night = 14 * 0.0109;
    let last = 0;
    let rising = false;
    let lastB = Infinity;
    for (let el = 2; el >= -20; el -= 0.25) {
      const e = adaptation(E(el));
      expect(e, `at ${el}°`).toBeGreaterThanOrEqual(last - 1e-9);
      last = e;
      const B = e * (E(el) + 0.0109);
      expect(B, `at ${el}°`).toBeLessThan(night * 1.5 + 0.1);
      if (rising) expect(B, `at ${el}°`).toBeGreaterThan(lastB * 0.97);
      else if (B > lastB * 1.03) rising = true;
      lastB = B;
    }
  });
});
