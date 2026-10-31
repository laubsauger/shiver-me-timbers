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
import { ARRIVED, DEBRIS_SPIN, EYE_AT, LANDED, arrivalEye, arrivalState, beatStarts, domeDir, earthPose, gatherFrame, landingTrack, landingTurn, orbitLook, ourGalaxy, ramped } from '../src/drift/getTheDrift/timeline';
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
    // second) must change smoothly from the flood down to the raft. Down at the deck's height it does not park
    // either (direction.md C1, "then a very slow follow"; a still dome reads as a frozen frame): it drifts on
    // with the debris galaxy's slow turn, the current the raft floats on.
    // Measured where it shows — the eye over the planet as earthPose places it — from before the descent's own track
    // takes over (35 s before Drift-2's end) through it: the old landing set off from rest at Drift-2's end while
    // the approach still streamed the ground by at a flow of 0.9, blended over ±5 s, and the eye surged, stopped
    // and slid BACK for two seconds (the 2026-10-30 review: "going kind of back and forth", ~280–310 s).
    const endT = starts.drift2 + p.drift2;
    const h = 0.1;
    const g = gatherFrame(p, tilt);
    /** the eye relative to the planet's centre, Mm */
    const eye = (t: number): THREE.Vector3 => {
      const e = earthPose(t, p, tilt);
      return new THREE.Vector3(...e.centreDir).multiplyScalar(-e.distance);
    };
    const height = (t: number): number => eye(t).length() - 6.371;
    /** the eye's ground velocity, Mm/s (the motion along the planet's surface) */
    const ground = (t: number): THREE.Vector3 => {
      const a = eye(t);
      const v = eye(t + h).sub(a).divideScalar(h);
      const n = a.normalize();
      return v.addScaledVector(n, -v.dot(n));
    };
    const flow = (t: number): number => ground(t).length() / height(t);
    const descent = (t: number): number => Math.abs(Math.log(height(t + h)) - Math.log(height(t))) / h;
    const motion = (t: number): number => Math.max(flow(t), descent(t));
    // the way to the raft (where the eye comes down, EYE_AT, on the sphere), along the planet's surface at the eye
    const raft = new THREE.Vector3(...g.up).multiplyScalar(6.371).addScaledVector(new THREE.Vector3(...g.east), EYE_AT[0] * 1e-6).addScaledVector(new THREE.Vector3(...g.north), EYE_AT[1] * 1e-6);
    const ahead = (t: number): THREE.Vector3 => {
      const e = eye(t);
      const n = e.clone().normalize();
      const w = raft.clone().sub(e);
      return w.addScaledVector(n, -w.dot(n)).normalize();
    };
    let jolt = 0;
    let fastest = 0;
    let slowest = Infinity;
    let back = Infinity;
    let straight = Infinity;
    let peaked = false;
    let speedUp = 0;
    let wasSpeed = ground(endT - 40).length();
    let was = motion(endT - 40);
    for (let t = endT - 40; t < total; t += h) {
      const now = motion(t);
      const v = ground(t);
      jolt = Math.max(jolt, Math.abs(now - was) / h);
      fastest = Math.max(fastest, flow(t));
      if (height(t) > LANDED * 1.2) slowest = Math.min(slowest, now);
      // never back: the ground streams the one way until the eye is down to the current's metre a second — straight
      // at the raft while it flies (over 50 m/s), turning only as the field's slow turn takes over in the last metres
      const along = v.dot(ahead(t)) / v.length();
      if (v.length() * 1e6 > 50) straight = Math.min(straight, along);
      if (v.length() * 1e6 > 2) back = Math.min(back, along);
      // one surge, then only slower (until the current carries it)
      const speed = v.length();
      if (speed < wasSpeed) peaked = true;
      if (peaked && speed * 1e6 > 2) speedUp = Math.max(speedUp, (speed - wasSpeed) / wasSpeed);
      wasSpeed = speed;
      was = now;
    }
    expect(straight).toBeGreaterThan(0.999);
    expect(back).toBeGreaterThan(0.95);
    expect(speedUp).toBeLessThan(1e-3);
    expect(jolt).toBeLessThan(0.12);
    // (the ground's flow about the comfort cap of the flight's e-folds; the approach's own flood reached 0.33)
    expect(fastest).toBeLessThan(0.37);
    expect(slowest).toBeGreaterThan(0.04);
    expect(height(total) / LANDED).toBeCloseTo(1, 2);
    const a = landingTrack(total, p, tilt);
    const b = landingTrack(total + 1, p, tilt);
    const current = DEBRIS_SPIN * Math.hypot(EYE_AT[0], EYE_AT[1]);
    expect(Math.hypot(b.east - a.east, b.north - a.north) / current).toBeCloseTo(1, 2);
    // (slow: under a metre a second)
    expect(current).toBeLessThan(1);
    // and the track picks up exactly where the approach leaves the eye (no step in place)
    const from = endT - 35;
    expect(eye(from - 1e-3).distanceTo(eye(from + 1e-3)) * 1e6).toBeLessThan(400);
  });

  it('looks down onto the debris spiral from high up, then levels out at the raft — turning gently', () => {
    // The spiral must read as a shape from the air (v7 notes: "more look down on the spiral from higher up"): the
    // descent comes over it steeply while still kilometres up (a spiral seen at a grazing angle is a smear). The
    // eye turns for it, not the planet (turning the planet would turn it under its Sun), and every turn on a dome
    // stays slow — about the comfort's 1°/s (the 2026-10-30 review: no going back and forth): from where the orbit
    // look has been given back the levelling only ever turns the view up.
    const endT = starts.drift2 + p.drift2;
    const down = (t: number): number => {
      const at = landingTrack(t, p, tilt);
      return (Math.atan2(at.alt, Math.hypot(at.east, at.north)) * 180) / Math.PI;
    };
    expect(down(endT)).toBeGreaterThan(25);
    let steep = 0;
    for (let t = endT; t < total; t += 0.5) if (down(t) > 40) steep = Math.max(steep, landingTrack(t, p, tilt).alt);
    expect(steep).toBeGreaterThan(8000);
    const g = gatherFrame(p, tilt);
    const up = new THREE.Vector3(...g.up);
    const front = new THREE.Vector3(...g.front);
    const level = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(front, up), up, front.clone().negate()));
    const turn = (t: number): THREE.Quaternion => {
      const l = landingTurn(t, p, tilt);
      return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -l.look).slerp(level, l.k);
    };
    // the view's pitch against the eye's own horizon (the planet under it), deg
    const pitch = (t: number): number => {
      const e = earthPose(t, p, tilt);
      const f = new THREE.Vector3(0, 0, -1).applyQuaternion(turn(t));
      return (Math.asin(-f.dot(new THREE.Vector3(...e.centreDir))) * 180) / Math.PI;
    };
    let fastest = 0;
    let downAgain = 0;
    const settled = starts.flood + 0.6 * (p.flood + p.drift2) + 1;
    for (let t = starts.drift2 - 6; t < total; t += 0.1) {
      fastest = Math.max(fastest, (turn(t).angleTo(turn(t + 0.1)) * 180) / Math.PI / 0.1);
      if (t > settled) downAgain = Math.max(downAgain, pitch(t) - pitch(t + 0.1));
    }
    expect(fastest).toBeLessThan(1);
    expect(downAgain).toBeLessThan(1e-3);
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

    // THE ORBIT LOOK (the 2026-10-30 seat review, ~185–200 s: in the master the limb was a straight chord across the
    // lower dome, which from a seat reads as an arch standing in front, not a horizon round and below). As the planet
    // arrives the eye turns up, so in the VIEW (the eye's turn applied) the planet's centre lies low enough under the
    // front that its limb curves round the dome with its edge: the circle through the limb's ends on the springline
    // and its middle ahead has its centre on the zenith's side of the master, not beyond its front edge (an arch) or
    // at infinity (a chord). The Sun turns down with the planet, so the dawn stays a dawn; the turn is slow, and it is
    // given back before Drift-2 looks down onto the spiral.
    it('turns the eye up over the planet so its limb curves round the dome like an orbit horizon', () => {
      const front = new THREE.Vector3(...domeDir(0, 0, tilt));
      const axis = new THREE.Vector3(...domeDir(90, 0, tilt));
      const view = (t: number, w: number[]): THREE.Vector3 => {
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -landingTurn(t, p, tilt).look);
        return new THREE.Vector3(w[0], w[1], w[2]).applyQuaternion(q.invert());
      };
      // the master's y of the circle through the limb's ends and middle (master radius 0.5; + toward the zenith's side)
      const fitCentre = (t: number): { limb: number; y: number } => {
        const e = earthPose(t, p, tilt);
        const c = view(t, e.centreDir);
        const el = Math.asin(c.dot(axis));
        expect(Math.abs(c.clone().addScaledVector(axis, -c.dot(axis)).normalize().dot(front) - 1)).toBeLessThan(1e-3);
        const rho = (e.radiusDeg * Math.PI) / 180;
        const limb = el + rho;
        const half = Math.acos(Math.cos(rho) / Math.cos(el));
        const y0 = -0.5 * (1 - limb / (Math.PI / 2));
        const [x1, y1] = [0.5 * Math.sin(half), -0.5 * Math.cos(half)];
        return { limb: (limb * 180) / Math.PI, y: (x1 * x1 + y1 * y1 - y0 * y0) / (2 * (y1 - y0)) };
      };
      const arrived = starts.earth + ARRIVED * p.earthApproach;
      for (const t of [arrived, arrived + 5, arrived + 15, starts.lights, starts.lights + 0.5 * p.lights]) {
        const { limb, y } = fitCentre(t);
        expect(limb, `limb ahead at ${t}`).toBeLessThan(28);
        expect(limb, `limb ahead at ${t}`).toBeGreaterThan(18);
        expect(y, `limb's circle at ${t}`).toBeGreaterThan(0);
        expect(y, `limb's circle at ${t}`).toBeLessThan(t >= arrived + 15 ? 1.6 : 2.6);
      }
      // the dawn: the Sun is still just over the limb in the view (an angle: the turn keeps it)
      const e = earthPose(arrived, p, tilt);
      const sunOverLimb = (Math.acos(dot(e.sun, e.centreDir)) * 180) / Math.PI - e.radiusDeg;
      expect(sunOverLimb).toBeLessThan(30);
      // slow (the dome-comfort rule: ~10° in 10 s at most), and given back before Drift-2's look down
      let fastest = 0;
      for (let t = starts.earth; t < starts.drift2; t += 0.05) fastest = Math.max(fastest, (Math.abs(orbitLook(t + 0.05, p) - orbitLook(t, p)) * 180) / Math.PI / 0.05);
      expect(fastest).toBeLessThan(1);
      // (the last few degrees of it run into Drift-2's first seconds, where its own look down begins: one turn, one way)
      expect((orbitLook(starts.drift2 + 6, p) * 180) / Math.PI).toBeLessThan(0.1);
      expect((orbitLook(arrived + 5, p) * 180) / Math.PI).toBeCloseTo(p.orbitLook, 1);
    });
  });
});
