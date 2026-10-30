/**
 * The Earth's finer map levels (earthMaps.ts NEAR and INSET, built by scripts/drift-earth-data.py) are boxes drawn
 * round where the show's camera comes closest to the ground (the 2026-10-30 question: "at the zoom level we end up in
 * they look kind of low resolution"). They are only right for THIS camera path: move the gathering point, Drift-2's
 * height or the landing, and the closest views can leave them — back on the region's 1.1 km, ten times magnified,
 * with nothing to say so but a soft picture. These hold the boxes to the path, and the bake to the shader.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { getTheDriftParams } from '../src/params/getTheDrift';
import { beatStarts, domeDir, earthPose, gatherFrame, landingTrack, landingTurn } from '../src/drift/getTheDrift/timeline';
import { INSET, NEAR, geoFrameAt } from '../src/drift/getTheDrift/earthMaps';

const p = { ...getTheDriftParams };
const tilt = 15;
const R = 6.371; // Mm
const DEG = 180 / Math.PI;
/** rad, a 4096² master's pixel */
const PIXEL_4K = Math.PI / 4096;

/** the ground under the dome's directions over act time, as act.ts places the planet and turns the eye */
function groundViews(t0: number, t1: number, dt: number, visit: (v: { t: number; lat: number; lon: number; fp: number; night: boolean }) => void): void {
  const gf = gatherFrame(p, tilt);
  const up = new THREE.Vector3(...gf.up);
  const levelFront = new THREE.Vector3(...gf.front);
  const level = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(levelFront, up), up, levelFront.clone().negate()));
  const front = new THREE.Vector3(...domeDir(0, 0, tilt));
  front.addScaledVector(up, -front.dot(up)).normalize();
  const rgt = new THREE.Vector3().crossVectors(front, up);
  const h = (p.heading * Math.PI) / 180;
  const G = geoFrameAt(p.gatherLat, p.gatherLon, up, front.clone().multiplyScalar(Math.cos(h)).addScaledVector(rgt, -Math.sin(h)));
  for (let t = t0; t <= t1; t += dt) {
    const pose = earthPose(t, p, tilt);
    const c = new THREE.Vector3(...pose.centreDir).multiplyScalar(pose.distance);
    const lt = landingTurn(t, p, tilt);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -lt.look).slerp(level, lt.k);
    const sun = new THREE.Vector3(...pose.sun);
    for (let el = 0; el <= 90; el += 2) {
      for (let az = -180; az < 180; az += 4) {
        const d = new THREE.Vector3(...domeDir(el, az, tilt)).applyQuaternion(q);
        const b = d.dot(c);
        const disc = b * b - c.lengthSq() + R * R;
        if (disc < 0 || b < 0) continue;
        const tt = b - Math.sqrt(disc);
        const n = d.clone().multiplyScalar(tt).sub(c).divideScalar(R);
        visit({
          t,
          lat: Math.asin(n.dot(G.north)) * DEG,
          lon: Math.atan2(n.dot(G.east), n.dot(G.zero)) * DEG,
          fp: tt * 1e6 * PIXEL_4K,
          night: n.dot(sun) < -0.02,
        });
      }
    }
  }
}

const inside = (b: { lon0: number; lon1: number; lat0: number; lat1: number }, lat: number, lon: number): boolean => lon >= b.lon0 && lon <= b.lon1 && lat >= b.lat0 && lat <= b.lat1;

describe('the Earth map levels', () => {
  const { starts } = beatStarts(p);
  // from the lights beat to where the landing is ~5 km up (below that the ground in front is the new sea, drawn by
  // the shader, and the land in view is tens of km off)
  let low = starts.landing;
  for (let t = starts.landing; t < starts.landing + p.landing; t += 0.5) if (landingTrack(t, p, tilt).alt > 5000) low = t;

  it('the inset holds every view a 4096 master sees closer than 60 m a pixel', () => {
    const outside: string[] = [];
    groundViews(starts.lights, low, 1, (v) => {
      if (v.fp < 60 && !inside(INSET, v.lat, v.lon)) outside.push(`${v.t.toFixed(0)} s: ${v.lat.toFixed(2)} N ${v.lon.toFixed(2)} E at ${v.fp.toFixed(0)} m`);
    });
    expect(outside.slice(0, 5)).toEqual([]);
  });

  it('the near level holds every view closer than the region texel (~1.1 km) by more than half, by night or day', () => {
    // (the fringe where a 4096 pixel is 0.6–1.1 km keeps the region: at most 1.6x magnified)
    const outside: string[] = [];
    groundViews(starts.lights, low, 2, (v) => {
      if (v.fp < 550 && !inside(NEAR, v.lat, v.lon) && !inside(INSET, v.lat, v.lon)) outside.push(`${v.t.toFixed(0)} s: ${v.lat.toFixed(2)} N ${v.lon.toFixed(2)} E at ${v.fp.toFixed(0)} m`);
    });
    expect(outside.slice(0, 5)).toEqual([]);
  });

  it('the night is never seen closer than ~75 m a pixel (what the lights\' detail under their 500 m was judged at)', () => {
    // the night lights have no finer data than the Black Marble's 15″ (~500 m, the near level). The closest night
    // views are the flood's last twilight, ~269–273 s, 100–80 m a 4096 pixel, where the flood has put out all but
    // the brightest cores (life.ts); their look under the texel is the shader's (lifeLayers.ts nightLights). A camera
    // change that brings the night closer than this needs that look judged again (docs/drift/earth-data.md)
    let closest = Infinity;
    groundViews(starts.lights, low, 1, (v) => {
      if (v.night) closest = Math.min(closest, v.fp);
    });
    expect(closest).toBeGreaterThan(70);
  });

  it('the bake builds the boxes the shader reads', () => {
    const py = readFileSync(new URL('../scripts/drift-earth-data.py', import.meta.url), 'utf8');
    const box = (name: string): number[] => (py.match(new RegExp(`^${name} = \\(([^)]*)\\)`, 'm'))?.[1] ?? '').split(',').map(Number);
    expect(box('NEAR')).toEqual([NEAR.lon0, NEAR.lon1, NEAR.lat0, NEAR.lat1]);
    expect(box('INSET')).toEqual([INSET.lon0, INSET.lon1, INSET.lat0, INSET.lat1]);
    expect((NEAR.lon1 - NEAR.lon0) * 240).toBe(NEAR.w);
    expect((NEAR.lat1 - NEAR.lat0) * 240).toBe(NEAR.h);
    expect(py).toMatch(new RegExp(`INSET_W, INSET_H = ${INSET.w}, ${INSET.h}`));
  });
});
