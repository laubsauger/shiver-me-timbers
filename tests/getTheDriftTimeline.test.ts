/**
 * Get the Drift's arrival is one long approach from where Undertime leaves the eye to the Sun point inside
 * our galaxy, beginning as the dive into the web (webDive.ts). On a dome it must start at rest where the pull-back
 * comes to rest, and carry on without a lurch where the acts hand over (tests/webDive.test.ts),
 * stay under the comfort cap for exponential flight (0.35 e-folds of distance per second), and actually end
 * up inside the disk for the band — and our galaxy must be laid so its band arcs over the audience with the
 * bright centre low in front.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { getTheDriftParams } from '../src/params/getTheDrift';
import { ARRIVED, DEBRIS_SPIN, EYE_AT, LANDED, arrivalEye, arrivalState, beatStarts, domeDir, earthPose, gatherFrame, landingTrack, landingTurn, ourGalaxy, ramped } from '../src/drift/getTheDrift/timeline';
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

  // THE DIVE INTO THE WEB (webDive.ts, the 2026-10-30 review): the approach now begins diveLead s before the act, at
  // rest, e^diveEfolds times further out on the same line through E0 — Undertime draws the web in the same frame until
  // the act, so the eye's place in the web is one continuous curve (tests/webDive.test.ts); the world eye itself
  // changes worlds at the act, invisibly
  it('starts at rest on the approach line, e^diveEfolds further out, and flies the line through E0', () => {
    const t0 = -p.diveLead;
    const start = arrivalEye(t0, p, g);
    expect(dist(start, g.sun)).toBeCloseTo(p.ourDistance * Math.exp(p.diveEfolds), 6);
    expect(dist(arrivalEye(t0 + 0.1, p, g), start) / 0.1).toBeLessThan(1e-3 * dist(start, g.sun));
    // on the line E0 → Sun point the whole way (translation only, toward one fixed point)
    const line = [e0[0] - g.sun[0], e0[1] - g.sun[1], e0[2] - g.sun[2]];
    const ll = Math.hypot(line[0], line[1], line[2]);
    for (const t of [t0, 0, 5, p.galaxies]) {
      const e = arrivalEye(t, p, g);
      const d = [e[0] - g.sun[0], e[1] - g.sun[1], e[2] - g.sun[2]];
      expect(dot(d, line) / (ll * Math.hypot(d[0], d[1], d[2]))).toBeCloseTo(1, 9);
    }
  });

  it('never flies faster than 0.35 e-folds of distance per second', () => {
    const h = 1 / 30;
    let peak = 0;
    for (let t = -p.diveLead; t < total; t += h) {
      const a = arrivalState(t, p).f;
      const b = arrivalState(t + h, p).f;
      peak = Math.max(peak, Math.abs(Math.log(b) - Math.log(a)) / h);
    }
    expect(peak).toBeLessThan(0.35);
  });

  it('is inside the disk (within its thickness) for the band, drifting on through the near stars', () => {
    const h = 0.02 * p.ourRadius;
    for (const k of [0.1, 0.5, 0.9]) {
      const e = arrivalEye(starts.band + p.band * k, p, g);
      const z = dot([e[0] - g.centre[0], e[1] - g.centre[1], e[2] - g.centre[2]], g.normal);
      expect(Math.abs(z)).toBeLessThan(h);
    }
    // a still sky reads as a frozen frame on the dome: the eye keeps moving, by a sizable share of the
    // spacing of the near stars (~0.003 radii) every second, so they pass with parallax
    const a = arrivalEye(starts.band + 3, p, g);
    const b = arrivalEye(starts.band + 4, p, g);
    expect(dist(a, b)).toBeGreaterThan(0.003 * p.ourRadius * 0.2);
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

  // ONE journey (user, 2026-10-26): moves that each eased to rest and then started again read as clips stitched
  // together, "docking" and reorienting. From the first seconds to Drift-2 the camera is never parked — into
  // the galaxy, toward the Earth, down to it, or the planet turning in the view — and its speed never jumps.
  it('moves the whole way, without parking and without jolts', () => {
    const h = 0.1;
    const zoom = (t: number): number => {
      const a = arrivalState(t, p);
      const b = arrivalState(t + h, p);
      const galaxy = Math.abs(Math.log(b.f) - Math.log(a.f)) / h;
      const ea = earthPose(t, p, tilt);
      const eb = earthPose(t + h, p, tilt);
      // (the planet's motion counts as much as the planet shows: it fades in over two seconds)
      const earth = (a.earth * Math.abs(Math.log(eb.distance - 6.371) - Math.log(ea.distance - 6.371))) / h;
      const turn = (a.earth * (Math.acos(Math.min(1, dot(ea.centreDir, eb.centreDir))) * 180) / Math.PI) / h;
      return Math.max(galaxy, earth, turn / 30);
    };
    let slowest = Infinity;
    let jolt = 0;
    let was = zoom(8);
    for (let t = 8; t < starts.drift2 + p.drift2 - 6; t += h) {
      const now = zoom(t);
      slowest = Math.min(slowest, now);
      jolt = Math.max(jolt, Math.abs(now - was) / h);
      was = now;
    }
    expect(slowest).toBeGreaterThan(0.008);
    expect(jolt).toBeLessThan(0.12);
  });

  it('lands as one glide: down to the raft the eye never parks or lurches, then drifts on with the raft', () => {
    // A descent that stops gliding forward while it is still coming down reads as two shots spliced together
    // (the v6 notes): the ground's apparent motion (speed over height) and the descent (e-folds of height per
    // second) must change smoothly from Drift-2's end to the raft. Down at the deck's height it does not park
    // either (direction.md C1, "then a very slow follow"; a still dome reads as a frozen frame): it drifts on
    // with the debris galaxy's slow turn, the current the raft floats on.
    const endT = starts.drift2 + p.drift2;
    const h = 0.1;
    const height = (t: number): number => earthPose(t, p, tilt).distance - 6.371;
    const flow = (t: number): number => {
      const a = landingTrack(t, p, tilt);
      const b = landingTrack(t + h, p, tilt);
      return Math.hypot(b.east - a.east, b.north - a.north) / a.alt / h;
    };
    const descent = (t: number): number => Math.abs(Math.log(height(t + h)) - Math.log(height(t))) / h;
    const motion = (t: number): number => Math.max(flow(t), descent(t));
    let jolt = 0;
    let fastest = 0;
    let slowest = Infinity;
    let was = motion(endT - 6);
    for (let t = endT - 6; t < total; t += h) {
      const now = motion(t);
      jolt = Math.max(jolt, Math.abs(now - was) / h);
      fastest = Math.max(fastest, flow(t));
      if (height(t) > LANDED * 1.2) slowest = Math.min(slowest, now);
      was = now;
    }
    expect(jolt).toBeLessThan(0.12);
    // (the ground's flow under the same comfort cap as the flight's e-folds)
    expect(fastest).toBeLessThan(0.35);
    expect(slowest).toBeGreaterThan(0.05);
    expect(height(total) / LANDED).toBeCloseTo(1, 2);
    const a = landingTrack(total, p, tilt);
    const b = landingTrack(total + 1, p, tilt);
    const current = DEBRIS_SPIN * Math.hypot(EYE_AT[0], EYE_AT[1]);
    expect(Math.hypot(b.east - a.east, b.north - a.north) / current).toBeCloseTo(1, 2);
    // (slow: under a metre a second)
    expect(current).toBeLessThan(1);
  });

  it('looks down onto the debris spiral from high up, then levels out at the raft — turning gently', () => {
    // The spiral must read as a shape from the air (v7 notes: "more look down on the spiral from higher up"),
    // so at Drift-2's end its centre lies well below level (a spiral seen at a grazing angle is a smear). The
    // eye turns for it, not the planet (turning the planet would turn it under its Sun), and every turn on a
    // dome stays slow.
    const endT = starts.drift2 + p.drift2;
    const at = landingTrack(endT, p, tilt);
    expect((Math.atan2(at.alt, Math.hypot(at.east, at.north)) * 180) / Math.PI).toBeGreaterThan(40);
    const g = gatherFrame(p, tilt);
    const up = new THREE.Vector3(...g.up);
    const front = new THREE.Vector3(...g.front);
    const level = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(front, up), up, front.clone().negate()));
    const turn = (t: number): THREE.Quaternion => {
      const l = landingTurn(t, p, tilt);
      return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -l.look).slerp(level, l.k);
    };
    let fastest = 0;
    for (let t = starts.drift2 - 6; t < total; t += 0.1) fastest = Math.max(fastest, (turn(t).angleTo(turn(t + 0.1)) * 180) / Math.PI / 0.1);
    expect(fastest).toBeLessThan(2);
    expect(turn(total).angleTo(level)).toBeLessThan(1e-6);
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
      // (arrived: slid to the front, 1.6 approaches in)
      const arrived = earthPose(starts.earth + ARRIVED * p.earthApproach, p, tilt);
      const clear = deg(arrived.centreDir, arrived.sun) - arrived.radiusDeg;
      expect(clear).toBeGreaterThan(1);
      expect(clear).toBeLessThan(30);
    });

    it('puts the dawn on the planet: the terminator crosses the visible face (lit and dark both in view)', () => {
      const e = earthPose(starts.earth + ARRIVED * p.earthApproach, p, tilt);
      const toEye = e.centreDir.map((x) => -x);
      // the sub-eye point is in night, but the Sun lights part of the visible hemisphere
      const sunElAtSubEye = 90 - deg(toEye, e.sun);
      expect(sunElAtSubEye).toBeLessThan(0);
      expect(sunElAtSubEye).toBeGreaterThan(-60);
    });

    it('starts as a point showing its sunlit side, never leaves the dome, and ends with its limb across the front', () => {
      const first = earthPose(starts.earth, p, tilt);
      expect(first.radiusDeg).toBeLessThan(0.2);
      // a point near the Sun shows its night side: a dark dot, not "a blue point" — a third or more sunlit
      expect((1 - Math.cos((deg(first.centreDir, first.sun) * Math.PI) / 180)) / 2).toBeGreaterThan(0.3);
      // while it slides to the front its top stays well up on the dome (it must not dip under the edge)
      const zenith = domeDir(90, 0, tilt);
      for (let t = starts.earth; t <= starts.earth + p.earthApproach; t += 0.25) {
        const e = earthPose(t, p, tilt);
        expect(90 - deg(e.centreDir, zenith) + e.radiusDeg, `top of the planet at ${t.toFixed(2)}`).toBeGreaterThan(8);
      }
      // once it has slid to the front (1.6 approaches in), its limb lies across the front, sinking with the dawn
      const last = earthPose(starts.earth + ARRIVED * p.earthApproach, p, tilt);
      const limbTop = 90 - deg(last.centreDir, domeDir(90, 0, tilt)) + last.radiusDeg;
      expect(limbTop).toBeGreaterThan(p.limbEl - p.dawnSink - 0.5);
      expect(limbTop).toBeLessThan(p.limbEl + 0.5);
    });
  });
});
