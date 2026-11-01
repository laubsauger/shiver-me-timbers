/**
 * The far islands as the eye sees them from the sea: the Rose's stations' motus (farMotu.ts) and the air in front of
 * them and the high island (farAir.ts).
 *
 * WHY THESE. The user, 2026-10-30, on a c2–c3 frame: "What exactly is this weird white thing in the back? Is this
 * supposed to be a super ugly island with the tower on it?" — a smooth pale dome — and on the high island: "the white
 * weird islands … probably an effect of haze … but it doesn't work". So: a station's island is a low, wide band with a
 * ragged top and land under its tower; and an island 7 km off seen through the air is never brighter than the sky
 * right over it, which the old haze (mixing toward the horizon's mean colour) broke at w1's morning.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { createFarMotu } from '../src/drift/wandering/farMotu';
import { airlightCpu, marineAir } from '../src/drift/wandering/farAir';
import { HIGH_AIR } from '../src/drift/wandering/coast';
import { radianceCpu, skyIrradiance, sunlightCpu } from '../src/drift/wandering/seaSky';
import { EARTH_R, SUN_E } from '../src/drift/getTheDrift/atmosphere';
import { beatSun } from '../src/drift/wandering/beats';

const lum = (c: ArrayLike<number>): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

describe('a far motu', () => {
  const seeds = [11, 12, 13, 14, 15, 16, 17];
  const top = (m: ReturnType<typeof createFarMotu>): number => {
    const p = m.mesh.geometry.getAttribute('position');
    let y = -Infinity;
    for (let i = 0; i < p.count; i++) y = Math.max(y, p.getY(i));
    return y;
  };

  it('is the same island for the same seed (every frame of t its own)', () => {
    const a = createFarMotu(13, new THREE.MeshBasicNodeMaterial());
    const b = createFarMotu(13, new THREE.MeshBasicNodeMaterial());
    expect(b.length).toBe(a.length);
    expect(b.site).toEqual(a.site);
    expect(Array.from(b.mesh.geometry.getAttribute('position').array as Float32Array)).toEqual(Array.from(a.mesh.geometry.getAttribute('position').array as Float32Array));
  });

  it('is a low wide band, not a mound: a 15–25 m canopy with palm heads, ten or more times as long as it is high', () => {
    for (const seed of seeds) {
      const m = createFarMotu(seed, new THREE.MeshBasicNodeMaterial());
      const h = top(m);
      expect(h).toBeGreaterThan(15);
      expect(h).toBeLessThan(40);
      expect(m.length / h).toBeGreaterThan(10);
    }
  });

  it('has a ragged top: its skyline along the island varies by metres (crowns and palms), not a smooth hull', () => {
    const m = createFarMotu(14, new THREE.MeshBasicNodeMaterial());
    const p = m.mesh.geometry.getAttribute('position');
    // the skyline: the highest point across each column along the island, over its middle half
    const cols = new Map<number, number>();
    for (let i = 0; i < p.count; i++) {
      const a = Math.round(p.getX(i) * 10);
      if (Math.abs(p.getX(i)) > m.length / 4) continue;
      cols.set(a, Math.max(cols.get(a) ?? -Infinity, p.getY(i)));
    }
    const line = [...cols.entries()].sort((x, y) => x[0] - y[0]).map(([, y]) => y);
    const steps = line.slice(1).map((y, i) => Math.abs(y - line[i]));
    expect(Math.max(...line) - Math.min(...line)).toBeGreaterThan(3);
    expect(steps.filter((d) => d > 0.3).length).toBeGreaterThan(line.length / 10);
  });

  it('stands its tower on land, above the sea, and its beach falls under the sea off the island', () => {
    for (const seed of seeds) {
      const m = createFarMotu(seed, new THREE.MeshBasicNodeMaterial());
      expect(m.land(m.site[0], m.site[1])).toBeGreaterThan(1.5);
      expect(m.land(m.site[0], m.site[1] + 400)).toBeLessThan(0);
    }
  });
});

describe('the air in front of a far island', () => {
  const SEA0 = 313.9388;
  const C1 = 41.0612;
  const eyeY = 2.6;
  const r0 = EARTH_R + eyeY * 1e-6;
  // toward the high island from the beach (coast.ts HIGH: bearing −42°, 7.4 km)
  const az = Math.atan2(-5208, -5555);
  const dir = (el: number): THREE.Vector3 => new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));

  it('extinguishes green over HIGH_AIR (the high island\'s marine air), blue first', () => {
    const sun = new THREE.Vector3(...beatSun('w1', 500 - SEA0, C1));
    const { beta } = marineAir(eyeY, sun);
    expect(Math.exp(-beta[1] * HIGH_AIR)).toBeCloseTo(Math.exp(-1), 3);
    expect(beta[2]).toBeGreaterThan(beta[1]);
    expect(beta[1]).toBeGreaterThan(beta[0]);
  });

  it('scatters in more light the longer the path, and never more than the sky over the horizon', () => {
    const sun = new THREE.Vector3(...beatSun('w4', 650 - SEA0, C1));
    const sky = lum(radianceCpu(r0, dir(0.002), sun));
    let last = 0;
    for (const d of [500, 2000, 7600, 16000]) {
      const L = lum(airlightCpu(eyeY, sun, az, d));
      expect(L).toBeGreaterThan(last);
      expect(L).toBeLessThan(sky);
      last = L;
    }
  });

  it('leaves the high island darker than the sky over its summit, morning and sunset (it read pale at w1)', () => {
    // (w1's morning at 530 s: since the 2026-11-01 dawn, w1 opens in the night and its Sun is up ~527 s — at 500 s it
    // is still −19°, island and sky both black)
    for (const [show, beat] of [[530, 'w1'], [650, 'w4']] as const) {
      const sun = new THREE.Vector3(...beatSun(beat, show - SEA0, C1));
      // a dark canopy (forest.ts's greens) lit by the Sun and the sky
      const E = skyIrradiance(r0, sun);
      const sl = sunlightCpu(r0, sun.y);
      const leaf = [0.055, 0.07, 0.032];
      const surf = leaf.map((a, k) => (a * (E[k] + SUN_E * sl[k] * Math.max(0, sun.y))) / Math.PI);
      const { beta } = marineAir(eyeY, sun);
      const air = airlightCpu(eyeY, sun, az, 7600);
      const island = surf.map((s, k) => s * Math.exp(-beta[k] * 7600) + air[k]);
      // the sky just over its summit (430 m at 7.4 km: 3.3°)
      const over = radianceCpu(r0, dir((3.3 * Math.PI) / 180), sun);
      expect(lum(island)).toBeLessThan(0.9 * lum(over));
    }
  });
});
