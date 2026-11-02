/**
 * LIGHTS OUT (the 2026-11-02 next-level review, move 2, "the flood as Act 1's wave"; params lightsOut): Act 1 says "a
 * billion lost, one grain remained", and Act 2 must rhyme it — the flood comes as a front across the night side, the
 * cities go out behind it, the dome goes nearly black in the score's dip, and one warm lamp is still lit, low in
 * front, held at one place on the dome all the way down; only then does the Sun rise. These tests hold what that
 * rests on, measured on the approved camera path (commit 367627d), which Lights Out does not touch:
 *   - off by default, it changes nothing (the next master render is the approved flood);
 *   - the black falls in the score's dip: drift_audio.wav (offset 0) is quietest over 240.2–245.2 s (−28 dB RMS over
 *     5 s, ~11 dB under the 229–237 s plateau; the hit before it at 235.0 s, the next at 252.2 s) — every light in
 *     view is out by DIP_FROM, and none went out before the front left the limb;
 *   - the front travels toward the audience, at a pace that reads as water coming in, not a wipe;
 *   - the lamp sits still on the dome (it must not read as a moving light from orbit — a UFO), in the planet's lower
 *     front where the review put it, and blinks slowly (never a strobe);
 *   - the Sun is still behind the planet through the black and rises ~15 s later than the approved dawn.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { getTheDriftParams } from '../src/params/getTheDrift';
import { beatStarts, domeDir, earthPose, gatherFrame, glideAxis, glideSpin, landingTurn } from '../src/drift/getTheDrift/timeline';
import { lifeState } from '../src/drift/getTheDrift/life';
import { FRONT_KEYS, LO_CLUSTER, LO_RAGGED, frontArrival } from '../src/drift/getTheDrift/lifeLayers';
import { lampState } from '../src/drift/getTheDrift/lamp';
import { geoFrameAt } from '../src/drift/getTheDrift/earthMaps';
import { domeBasis } from '../src/cine/domeMaster';

const off = { ...getTheDriftParams, lightsOut: 0 };
const p = { ...getTheDriftParams, lightsOut: 1 };
const tilt = 15;
const R = 6.371;
const D = Math.PI / 180;
const { starts } = beatStarts(p);
/** s: Undertime's length less the overlap — act time 0 in show time (main-drift.ts act2Start) */
const ACT2 = 81;
/** show s: the score's dip, measured (header) */
const DIP_FROM = 240.7;
const DIP_TO = 245.2;
/** show s: the hit before the dip, where the front may leave the limb */
const HIT = 235.0;

// the camera and the map exactly as act.ts draws them
const gf = gatherFrame(p, tilt);
const up = new THREE.Vector3(...gf.up);
const level = new THREE.Quaternion().setFromRotationMatrix(
  new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(new THREE.Vector3(...gf.front), up), up, new THREE.Vector3(...gf.front).negate()),
);
const turn = (t: number): THREE.Quaternion => {
  const l = landingTurn(t, p, tilt);
  return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -l.look).slerp(level, l.k);
};
const front0 = new THREE.Vector3(...domeDir(0, 0, tilt));
front0.addScaledVector(up, -front0.dot(up)).normalize();
const rgt = new THREE.Vector3().crossVectors(front0, up);
const geoNorth = front0.clone().multiplyScalar(Math.cos(p.heading * D)).addScaledVector(rgt, -Math.sin(p.heading * D));
const geo = geoFrameAt(p.gatherLat, p.gatherLon, up, geoNorth);
const spinAxis = new THREE.Vector3(...glideAxis(p, tilt));
const mapAt = (t: number) => {
  const q = new THREE.Quaternion().setFromAxisAngle(spinAxis, glideSpin(t, p));
  return { zero: geo.zero.clone().applyQuaternion(q), east: geo.east.clone().applyQuaternion(q), north: geo.north.clone().applyQuaternion(q) };
};
const basis = domeBasis(tilt);
const toDome = (t: number, w: THREE.Vector3): { el: number; az: number } => {
  const l = w.clone().applyQuaternion(turn(t).invert());
  const v = (b: number[]): number => l.x * b[0] + l.y * b[1] + l.z * b[2];
  return { el: Math.asin(v(basis.axis)) / D, az: Math.atan2(v(basis.right), v(basis.front)) / D };
};
/** the ground point the dome direction (el, az) sees at act time t, in the planet's frame — or null (sky) */
const groundAt = (t: number, el: number, az: number): THREE.Vector3 | null => {
  const e = earthPose(t, p, tilt);
  const c = new THREE.Vector3(...e.centreDir).multiplyScalar(e.distance);
  const ray = new THREE.Vector3(...domeDir(el, az, tilt)).applyQuaternion(turn(t));
  const b = ray.dot(c);
  const disc = b * b - c.lengthSq() + R * R;
  if (disc < 0 || b < 0) return null;
  const n = ray.multiplyScalar(b - Math.sqrt(disc)).sub(c).normalize();
  const m = mapAt(t);
  return new THREE.Vector3(n.dot(m.zero), n.dot(m.east), n.dot(m.north));
};
const origin = new THREE.Vector3(...lifeState(0, p).frontOrigin);
/** show s the water reaches a place (planet frame), its raggedness at its most either way */
const reaches = (g: THREE.Vector3, ragged: number): number => ACT2 + starts.flood + p.loFront + frontArrival(Math.acos(Math.min(1, g.dot(origin))) / D + ragged, p.loFrontLen);
const RAG = LO_RAGGED[0] + LO_RAGGED[1];

describe('Lights Out', () => {
  it('is off by default, and off it is the approved flood: no front, no push, the Sun on its old day', () => {
    expect(getTheDriftParams.lightsOut).toBe(0);
    // (Lights Out's own tunables turned hard: off, none of them may reach the picture)
    const late = { ...off, loSunLate: 25, loPush: 1, loFront: -9 };
    const times: number[] = [];
    for (let t = starts.overshoot - 5; t < starts.landing; t += 0.5) times.push(t);
    // (one params object at a time: the timeline caches one placement and one Sun's day)
    const sunOff = times.map((t) => earthPose(t, off, tilt).sun);
    const sunLate = times.map((t) => earthPose(t, late, tilt).sun);
    expect(sunLate).toEqual(sunOff);
    for (const t of times) {
      const a = lifeState(t, off);
      expect(a.front).toBeLessThan(-1e3);
      expect(a.overshoot).toBeLessThanOrEqual(1);
      expect(lifeState(t, late)).toEqual(a);
    }
  });

  it('puts every light in view out by the score’s dip, and none before the front leaves the limb on the hit', () => {
    // the front leaves the limb after the hit before the dip (the water comes on the score's last loud beat)
    const start = ACT2 + starts.flood + p.loFront;
    expect(start).toBeGreaterThanOrEqual(HIT);
    expect(start).toBeLessThan(HIT + 0.5);
    // nothing in view is reached before it starts: the front comes over the limb, it is not drawn across the ground
    for (let el = 0; el <= 30; el += 0.5) {
      for (let az = -180; az < 180; az += 5) {
        const g = groundAt(start - ACT2, el, az);
        if (g) expect(Math.acos(Math.min(1, g.dot(origin))) / D - RAG, `${el}/${az}`).toBeGreaterThan(FRONT_KEYS[0][0] - RAG - 0.01);
      }
    }
    // through the dip, every place in view (all round, from the dome's edge up) is out — its latest cluster's time
    for (let s = DIP_FROM; s <= DIP_TO; s += 0.5) {
      let seen = 0;
      for (let el = 0; el <= 30; el += 0.5) {
        for (let az = -180; az < 180; az += 3) {
          const g = groundAt(s - ACT2, el, az);
          if (!g) continue;
          seen++;
          expect(reaches(g, RAG) + LO_CLUSTER - 0.3, `${el}/${az} at ${s}`).toBeLessThanOrEqual(DIP_FROM);
        }
      }
      expect(seen).toBeGreaterThan(200);
    }
  });

  it('brings the water toward the audience down the front at a pace, not a wipe', () => {
    // where the front is on the dome's front meridian, frame by frame: the elevation whose ground the water reaches now
    // (the map turning under the eye as act.ts draws it). It must come down toward the audience, never back up, never
    // faster than 10°/s of dome, and take long enough over it to be seen travelling
    const start = ACT2 + starts.flood + p.loFront;
    const frontEl = (s: number): number => {
      for (let el = 21; el >= 0; el -= 0.05) {
        const g = groundAt(s - ACT2, el, 0);
        if (g && reaches(g, 0) >= s) return el;
      }
      return -1;
    };
    let was = 21;
    let fastest = 0;
    let at20 = NaN;
    let at0 = NaN;
    const h = 0.05;
    for (let s = start; s < start + p.loFrontLen; s += h) {
      const el = frontEl(s);
      expect(el, `${s.toFixed(2)}`).toBeLessThanOrEqual(was + 1e-9);
      if (el >= 0 && s > start + 0.3) fastest = Math.max(fastest, (was - el) / h);
      if (Number.isNaN(at20) && el <= 20) at20 = s;
      if (el <= 0) {
        at0 = s;
        break;
      }
      was = el;
    }
    expect(fastest).toBeLessThan(10);
    expect(at0 - at20).toBeGreaterThan(2.5);
  });

  it('keeps the lamp still on the dome, low in front on the planet, from the front all the way down', () => {
    const la = p.loLampLat * D;
    const lo = p.loLampLon * D;
    const lamp = new THREE.Vector3(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la));
    let [lowest, highest, widest] = [90, -90, 0];
    let fastest = 0;
    let was: { el: number; az: number } | null = null;
    for (let s = 236; s <= 312; s += 0.25) {
      const t = s - ACT2;
      const e = earthPose(t, p, tilt);
      const c = new THREE.Vector3(...e.centreDir).multiplyScalar(e.distance);
      const m = mapAt(t);
      const n = m.zero.clone().multiplyScalar(lamp.x).addScaledVector(m.east, lamp.y).addScaledVector(m.north, lamp.z);
      const at = c.clone().addScaledVector(n, R);
      // on the near side of the planet, over the eye's horizon
      expect(n.dot(at.clone().negate().normalize()), `visible at ${s}`).toBeGreaterThan(0);
      const d = toDome(t, at.normalize());
      lowest = Math.min(lowest, d.el);
      highest = Math.max(highest, d.el);
      widest = Math.max(widest, Math.abs(d.az));
      if (was) fastest = Math.max(fastest, Math.hypot(d.el - was.el, (d.az - was.az) * Math.cos(d.el * D)) / 0.25);
      was = d;
    }
    // the review's 15–25° (the planet only fills the lower front at these heights), within a degree; straight ahead
    expect(lowest).toBeGreaterThan(15);
    expect(highest).toBeLessThan(26.5);
    expect(widest).toBeLessThan(1);
    // and it never slides: under 1°/s anywhere on the way down
    expect(fastest).toBeLessThan(1);
  });

  it('blinks the lamp slowly and softly through the black, never off and never a strobe', () => {
    const o = { from: starts.overshoot, passed: starts.flood + p.loFront + 1, period: p.loBlink, sunEl: -40, gone: 1e9 };
    const h = 1 / 30;
    let peak = 0;
    let lo = Infinity;
    let hi = 0;
    for (let t = DIP_FROM - ACT2; t < DIP_TO - ACT2; t += h) {
      const g = lampState(t, o).gain;
      peak = Math.max(peak, Math.abs(lampState(t + h, o).gain - g));
      lo = Math.min(lo, g);
      hi = Math.max(hi, g);
    }
    // it blinks (a clear swing), stays lit, and turns no faster than ~8% of its range a frame
    expect(hi - lo).toBeGreaterThan(0.6);
    expect(lo).toBeGreaterThan(0.2);
    expect(peak).toBeLessThan(0.08);
    // slowly: at most one blink every 2.5 s (well under the 3 Hz of a flash hazard)
    expect(p.loBlink).toBeGreaterThanOrEqual(2.5);
  });

  it('holds the Sun behind the planet through the black, and lets it rise about 15 s later than the approved dawn', () => {
    const hidden = (t: number, q: typeof p): boolean => {
      const e = earthPose(t, q, tilt);
      const a = Math.acos(Math.min(1, e.sun[0] * e.centreDir[0] + e.sun[1] * e.centreDir[1] + e.sun[2] * e.centreDir[2])) / D;
      return a < e.radiusDeg;
    };
    const riseAt = (q: typeof p): number => {
      for (let t = starts.flood; t < starts.landing; t += 0.1) if (!hidden(t, q)) return t + ACT2;
      return Infinity;
    };
    for (let s = DIP_FROM; s <= DIP_TO; s += 0.5) expect(hidden(s - ACT2, p), `${s}`).toBe(true);
    const was = riseAt(off);
    const now = riseAt(p);
    expect(now - was).toBeGreaterThan(12);
    expect(now - was).toBeLessThan(18);
    // and the morning at the raft is the same: the sea's day from the landing's end on is untouched
    const end = starts.landing + p.landing;
    expect(earthPose(end, p, tilt).sun).toEqual(earthPose(end, off, tilt).sun);
  });

  it('never pops: the push and the front change the life states by under 2% a frame', () => {
    const h = 1 / 30;
    for (let t = starts.overshoot; t < starts.drift2; t += h) {
      const a = lifeState(t, p);
      const b = lifeState(t + h, p);
      expect(Math.abs(b.overshoot - a.overshoot)).toBeLessThan(0.02);
      expect(b.front - a.front).toBeCloseTo(h, 9);
    }
  });
});
