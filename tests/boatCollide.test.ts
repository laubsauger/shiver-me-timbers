/**
 * §T.188 BOAT COLLISIONS — WHY these tests (docs/speedboat/crash.md, sea-physics/boatCollide.ts):
 *
 *  - Racing boats close at 45 m/s. A discrete overlap test moves 0.75 m per tick and the bow capsule is 1.1 m across,
 *    so a contact that is not swept lets a rival drive THROUGH you. The sweep is what forbids it; the kinematic
 *    control below shows the same measure catching a tunnel when the sweep is taken away.
 *  - A collision between an NPC stepped on a worker and one stepped elsewhere must still be ONE contact: equal and
 *    opposite impulses, bit for bit, or momentum (and the replay hash) depends on which thread a boat lives on.
 *  - An off-centre hit must turn both boats the way the lever arm says; a pole must stop or deflect a boat without
 *    a launch, a NaN or an acceleration past the V110 bound; a rock face must turn the boat aside, not glue it on.
 *
 * All runs are REAL physics: rigid6 + HullWater on the deepV12 hull, contacts once per tick before the step.
 */
import { describe, expect, it } from 'vitest';
import { HullWater, type HeightSampler } from '../src/sea-physics/hullWater';
import {
  applyPairContact,
  BOAT_COLLIDE_DEFAULTS,
  beginContactTick,
  boatPairContact,
  buildCollisionHull,
  collideBoatWithFleet,
  collideBoatWithWorld,
  CONTACT_FLEXIBLE,
  CONTACT_SOLID,
  createBoatCollideMemory,
  prepareStaticWorld,
  writePose,
  type BedHeight,
  type BoatCollideMemory,
  type CollisionHull,
  type StaticWorld,
} from '../src/sea-physics/boatCollide';
import { createRigid6Memory, stepRigid6, type Rigid6Memory, type Rigid6State } from '../src/sea-physics/rigidBody';
import { buildDeepVHull } from '../src/speedboat/hullMesh';
import type { Quat, Vec3 } from '../src/state/simState';

const DT = 1 / 60;
const FLAT: HeightSampler = () => 0;
const hull = buildDeepVHull();
const ch = buildCollisionHull(hull);
const REST_Y = 0.2;

interface Boat {
  s: Rigid6State;
  hw: HullWater;
  mem: Rigid6Memory;
  cm: BoatCollideMemory;
}

function yawQ(h: number): Quat {
  return [0, Math.sin(h / 2), 0, Math.cos(h / 2)];
}

function boat(p: Vec3, heading: number, speed: number, extraV: Vec3 = [0, 0, 0], w: Vec3 = [0, 0, 0]): Boat {
  return {
    s: {
      position: [...p] as Vec3,
      quaternion: yawQ(heading),
      velocity: [speed * Math.sin(heading) + extraV[0], extraV[1], speed * Math.cos(heading) + extraV[2]],
      angularVelocity: [...w] as Vec3,
    },
    hw: new HullWater(hull),
    mem: createRigid6Memory(),
    cm: createBoatCollideMemory(ch),
  };
}

/** one fixed tick for a fleet: contacts from the tick-start snapshot, then each boat's own step */
function tick(boats: Boat[], opts: { world?: StaticWorld; bed?: BedHeight; mask?: number; sea?: HeightSampler; throttle?: number } = {}): void {
  const n = boats.length;
  const poses = new Float64Array(n * 13);
  boats.forEach((b, i) => writePose(poses, 0, i, b.s));
  boats.forEach((b, i) => {
    beginContactTick(b.cm);
    collideBoatWithFleet(i, b.s, ch, poses, 0, n, opts.mask ?? 0, DT, b.cm);
  });
  for (const b of boats) {
    if (opts.world || opts.bed) collideBoatWithWorld(b.s, ch, opts.world ?? null, opts.bed ?? null, DT, b.cm);
    b.hw.setControls(0, opts.throttle ?? 0);
    b.hw.samplePatch(opts.sea ?? FLAT, b.s, DT);
    stepRigid6(b.s, hull, DT, 2, (ss, h, out) => b.hw.evaluate(ss, h, out), b.mem);
  }
}

// ── independent geometry for the assertions (not the module's sweep) ────────────────────────

function rotate(q: ArrayLike<number>, v: ArrayLike<number>): Vec3 {
  const [qx, qy, qz, qw] = [q[0], q[1], q[2], q[3]];
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [v[0] + qw * tx + (qy * tz - qz * ty), v[1] + qw * ty + (qz * tx - qx * tz), v[2] + qw * tz + (qx * ty - qy * tx)];
}

function worldCapsules(s: Rigid6State, h: CollisionHull): { a: Vec3; b: Vec3; r: number }[] {
  const out = [];
  for (let k = 0; k < h.capsuleCount; k++) {
    const c = h.capsules.subarray(k * 7, k * 7 + 7);
    const a = rotate(s.quaternion, [c[0], c[1], c[2]]);
    const b = rotate(s.quaternion, [c[3], c[4], c[5]]);
    out.push({ a: a.map((x, i) => x + s.position[i]) as Vec3, b: b.map((x, i) => x + s.position[i]) as Vec3, r: c[6] });
  }
  return out;
}

/** brute-force signed surface distance between two capsules (sampled segments; N = 40 ⇒ ≤ 1 cm error here) */
function capsuleGap(p: { a: Vec3; b: Vec3; r: number }, q: { a: Vec3; b: Vec3; r: number }, N = 40): number {
  let best = Infinity;
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const x0 = p.a[0] + (p.b[0] - p.a[0]) * u;
    const x1 = p.a[1] + (p.b[1] - p.a[1]) * u;
    const x2 = p.a[2] + (p.b[2] - p.a[2]) * u;
    for (let j = 0; j <= N; j++) {
      const t = j / N;
      const d0 = x0 - (q.a[0] + (q.b[0] - q.a[0]) * t);
      const d1 = x1 - (q.a[1] + (q.b[1] - q.a[1]) * t);
      const d2 = x2 - (q.a[2] + (q.b[2] - q.a[2]) * t);
      const d = d0 * d0 + d1 * d1 + d2 * d2;
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best) - p.r - q.r;
}

function chainGap(a: Rigid6State, b: Rigid6State, N = 40): number {
  let g = Infinity;
  for (const p of worldCapsules(a, ch)) for (const q of worldCapsules(b, ch)) g = Math.min(g, capsuleGap(p, q, N));
  return g;
}

const momentum = (bs: Boat[]): Vec3 => [0, 1, 2].map((k) => bs.reduce((acc, b) => acc + hull.mass * b.s.velocity[k], 0)) as Vec3;
const minRadius = Math.min(...Array.from({ length: ch.capsuleCount }, (_, k) => ch.capsules[k * 7 + 6]));

describe('§T.188 boat ↔ boat', () => {
  it('two boats closing at 45 m/s never tunnel: head-on at every lateral offset and a T-bone, in the water', () => {
    // WHY: the thinnest part of the chain (the bow, r ≈ 0.57 m) is shorter than one tick of 45 m/s closing. The
    // assertion is the physical meaning of "tunnel": the two hulls' capsules overlap deeper than the thinnest
    // capsule is wide, or the boats swap sides along the line of approach while still overlapping laterally.
    for (const offset of [0, 0.4, 0.9, 1.5, 2.2]) {
      const a = boat([0, REST_Y, 0], 0, 22.5);
      const b = boat([offset, REST_Y, 30], Math.PI, 22.5);
      let worst = Infinity;
      let touched = false;
      for (let k = 0; k < 90; k++) {
        tick([a, b]);
        const g = chainGap(a.s, b.s, 16);
        worst = Math.min(worst, g);
        if (a.cm.report.count > 0) touched = true;
        const lateral = Math.abs(b.s.position[0] - a.s.position[0]);
        // passed through: B now behind A along z while their hulls still share lateral room
        if (b.s.position[2] < a.s.position[2]) expect(lateral, `offset ${offset}: B passed A with ${lateral.toFixed(2)} m lateral`).toBeGreaterThan(2 * minRadius);
      }
      expect(touched, `offset ${offset}: they met`).toBe(true);
      expect(worst, `offset ${offset}: deepest overlap`).toBeGreaterThan(-2 * minRadius);
    }
    // T-bone: A's bow into B's side at 45 m/s
    const a = boat([0, REST_Y, 0], 0, 45);
    const b = boat([0, REST_Y, 20], Math.PI / 2, 0);
    let worst = Infinity;
    for (let k = 0; k < 60; k++) {
      tick([a, b]);
      worst = Math.min(worst, chainGap(a.s, b.s, 16));
    }
    expect(a.s.position[2], 'A did not come out the far side of B').toBeLessThan(b.s.position[2] + 2 * ch.capsules[6]);
    expect(worst).toBeGreaterThan(-2 * minRadius);
  });

  it('1000 randomized kinematic head-ons: at 45 m/s closing the hulls never overlap > 10 cm and never pass; at 100 m/s none pass — and without the sweep the same measure catches pass-throughs', () => {
    // Free bodies (no water, no gravity), integrated like rigid6 (position and quaternion from the new velocities),
    // random lateral/vertical offsets, yaw misalignment and yaw rates. PASS-THROUGH = the boats end on each other's far
    // side along the approach while their CGs are closer than the thinnest capsule is wide (they occupied the same space).
    const integrate = (s: Rigid6State): void => {
      const q = s.quaternion;
      const w = s.angularVelocity;
      for (let i = 0; i < 3; i++) s.position[i] += s.velocity[i] * DT;
      const dq = [w[0] * q[3] + w[1] * q[2] - w[2] * q[1], -w[0] * q[2] + w[1] * q[3] + w[2] * q[0], w[0] * q[1] - w[1] * q[0] + w[2] * q[3], -w[0] * q[0] - w[1] * q[1] - w[2] * q[2]];
      const n = [0, 1, 2, 3].map((i) => q[i] + 0.5 * DT * dq[i]);
      const l = Math.hypot(...n);
      for (let i = 0; i < 4; i++) q[i] = n[i] / l;
    };
    const run = (halfSpeed: number, sweep: boolean, withGap: boolean): { passes: number; worst: number } => {
      let seed = 188;
      const rnd = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
      let passes = 0;
      let worst = Infinity;
      for (let trial = 0; trial < 1000; trial++) {
        const h = (rnd() - 0.5) * 0.3;
        const A: Rigid6State = { position: [0, 0, 0], quaternion: yawQ(h), velocity: [0, (rnd() - 0.5) * 2, halfSpeed], angularVelocity: [0, (rnd() - 0.5) * 2, 0] };
        const B: Rigid6State = { position: [(rnd() - 0.5) * 1.6, (rnd() - 0.5) * 0.6, 20 + rnd() * 5], quaternion: yawQ(Math.PI + h), velocity: [0, 0, -halfSpeed], angularVelocity: [0, 0, 0] };
        const mem = createBoatCollideMemory(ch);
        for (let k = 0; k < 50; k++) {
          if (boatPairContact(A, ch, B, ch, sweep ? DT : 1e-9, mem)) applyPairContact(A, ch, B, ch, mem.pair);
          integrate(A);
          integrate(B);
          if (withGap && Math.abs(B.position[2] - A.position[2]) < 14) worst = Math.min(worst, chainGap(A, B, 16));
        }
        if (B.position[2] < A.position[2] && Math.hypot(B.position[0] - A.position[0], B.position[1] - A.position[1]) < 2 * minRadius) passes++;
      }
      return { passes, worst };
    };
    const at45 = run(22.5, true, true);
    expect(at45.passes).toBe(0);
    // ≤ 10 cm: what is left is the first-order rotation of the sweep (8 m arm, ≤ 4 rad/s) and the touch slop
    expect(at45.worst, 'deepest overlap at 45 m/s closing, m').toBeGreaterThan(-0.1);
    expect(run(50, true, false).passes, '100 m/s closing').toBe(0);
    // control (V80): a discrete overlap test (no sweep over the tick) lets them through at 100 m/s
    expect(run(50, false, false).passes).toBeGreaterThan(0);
  });

  it('conserves linear momentum: the pair impulse is exactly equal and opposite, bit for bit, whichever boat computes it (worker shards)', () => {
    // WHY: a worker holding boat 0 and another holding boat 1 each compute their own share from the same snapshot;
    // anything but an exact negative leaks momentum and makes the result depend on the shard layout (§V2).
    const a = boat([0, REST_Y, 0], 0, 20);
    const b = boat([1.2, REST_Y, 14], Math.PI / 2, 3);
    let contacts = 0;
    for (let k = 0; k < 60; k++) {
      const poses = new Float64Array(26);
      writePose(poses, 0, 0, a.s);
      writePose(poses, 0, 1, b.s);
      const before = momentum([a, b]);
      const keBefore = [a, b].reduce((acc, x) => acc + 0.5 * hull.mass * x.s.velocity.reduce((u, v) => u + v * v, 0), 0);
      for (const [i, x] of [a, b].entries()) {
        beginContactTick(x.cm);
        collideBoatWithFleet(i, x.s, ch, poses, 0, 2, 0, DT, x.cm);
      }
      if (a.cm.report.count > 0) {
        contacts++;
        for (let c = 0; c < 3; c++) expect(b.cm.report.impulse[c]).toBe(-a.cm.report.impulse[c]);
        const after = momentum([a, b]);
        const scale = hull.mass * 20;
        for (let c = 0; c < 3; c++) expect(Math.abs(after[c] - before[c]) / scale).toBeLessThan(1e-9);
        const keAfter = [a, b].reduce((acc, x) => acc + 0.5 * hull.mass * x.s.velocity.reduce((u, v) => u + v * v, 0), 0);
        // linear KE may not rise from a restitution-0.25 contact beyond what spin takes (it only falls or moves to spin)
        expect(keAfter).toBeLessThanOrEqual(keBefore * (1 + 1e-9));
      }
      for (const x of [a, b]) {
        x.hw.setControls(0, 0);
        x.hw.samplePatch(FLAT, x.s, DT);
        stepRigid6(x.s, hull, DT, 2, (ss, h, out) => x.hw.evaluate(ss, h, out), x.mem);
      }
    }
    expect(contacts, 'the boats hit').toBeGreaterThan(0);
  });

  it('a glancing contact yaws BOTH boats the way the lever arm says, and they part without capsizing or sticking', () => {
    // B drifts sideways into A's bow quarter from starboard (−x), running alongside, B's stern at A's bow.
    const a = boat([0, REST_Y, 0], 0, 25);
    const b = boat([-2.7, REST_Y, 7], 0, 22, [2.5, 0, 0]);
    const w0 = [a.s.angularVelocity[1], b.s.angularVelocity[1]];
    let hit = -1;
    let armA = 0;
    let armB = 0;
    for (let k = 0; k < 120; k++) {
      tick([a, b]);
      if (hit < 0 && a.cm.report.count > 0) {
        hit = k;
        armA = a.cm.report.bodyPoint[2];
        armB = b.cm.report.bodyPoint[2];
        // yaw kick one tick after the impulse (the water has had one step): Δω_y sign = sign((r × J)_y) = sign(r_z·J_x)
        const jA = a.cm.report.impulse[0];
        const jB = b.cm.report.impulse[0];
        const dA = a.s.angularVelocity[1] - w0[0];
        const dB = b.s.angularVelocity[1] - w0[1];
        expect(Math.sign(dA), 'A yaws with its lever arm').toBe(Math.sign(armA * jA));
        expect(Math.sign(dB), 'B yaws with its lever arm').toBe(Math.sign(armB * jB));
        expect(Math.abs(dA)).toBeGreaterThan(0.02);
        expect(Math.abs(dB)).toBeGreaterThan(0.02);
        expect(Math.abs(dA)).toBeLessThan(2);
        expect(Math.abs(dB)).toBeLessThan(2);
      }
    }
    expect(hit, 'they touched').toBeGreaterThan(0);
    expect(armA, 'on A the contact is forward of the CG').toBeGreaterThan(0);
    expect(armB, 'on B it is aft of the CG').toBeLessThan(0);
    const up = (s: Rigid6State): number => rotate(s.quaternion, [0, 1, 0])[1];
    expect(up(a.s)).toBeGreaterThan(Math.cos((30 * Math.PI) / 180));
    expect(up(b.s)).toBeGreaterThan(Math.cos((30 * Math.PI) / 180));
    expect(chainGap(a.s, b.s), 'parted').toBeGreaterThan(0);
    expect(a.s.velocity[2]).toBeGreaterThan(0.6 * 25);
  });

  it('a respawn ghost (mask bit) passes through, and so does the other boat', () => {
    const a = boat([0, REST_Y, 0], 0, 20);
    const b = boat([0, REST_Y, 20], Math.PI, 10);
    for (let k = 0; k < 90; k++) tick([a, b], { mask: 0b10 });
    expect(a.s.position[2]).toBeGreaterThan(b.s.position[2]);
  });
});

describe('§T.188 boat ↔ world', () => {
  const pole = (x: number, z: number, flexible = false): StaticWorld =>
    prepareStaticWorld([{ a: [x, -4, z], b: [x, 6, z], radius: 0.25, flexible, id: 7 }]);

  it('driven into a pylon leg at 20 m/s she stops or deflects: no NaN, no launch, no speed gained, Δv per tick within the V110 bound', () => {
    for (const x of [0, 0.8, -1.2]) {
      const a = boat([x, REST_Y, 0], 0, 20);
      const world = pole(0, 30);
      const capV = BOAT_COLLIDE_DEFAULTS.maxImpactAccel * DT;
      const capW = BOAT_COLLIDE_DEFAULTS.maxImpactAngularAccel * DT;
      let first = -1;
      let maxSpeed = 0;
      let maxY = 0;
      let worst = Infinity;
      for (let k = 0; k < 180; k++) {
        tick([a], { world });
        // the contact part of this tick's change is what the report carries (the water adds its own afterwards)
        if (a.cm.report.count > 0) {
          if (first < 0) first = k;
          expect(a.cm.report.maxDeltaV).toBeLessThanOrEqual(capV * (1 + 1e-9));
          expect(Math.hypot(a.cm.report.impulse[0], a.cm.report.impulse[1], a.cm.report.impulse[2]) / hull.mass).toBeLessThanOrEqual(capV * (1 + 1e-9));
          expect(a.cm.report.source).toBe(CONTACT_SOLID);
        }
        for (const c of [...a.s.position, ...a.s.velocity, ...a.s.angularVelocity]) expect(Number.isFinite(c)).toBe(true);
        maxSpeed = Math.max(maxSpeed, Math.hypot(...a.s.velocity));
        maxY = Math.max(maxY, a.s.position[1]);
        for (const cap of worldCapsules(a.s, ch)) worst = Math.min(worst, capsuleGap(cap, { a: [0, -4, 30], b: [0, 6, 30], r: 0.25 }));
        expect(Math.hypot(...a.s.angularVelocity), 'no spin-up explosion').toBeLessThan(capW);
      }
      expect(first, `x ${x}: hit the pole`).toBeGreaterThan(0);
      expect(maxSpeed, `x ${x}: never faster than she came`).toBeLessThan(20 * 1.05);
      expect(maxY, `x ${x}: no launch`).toBeLessThan(REST_Y + 2);
      expect(worst, `x ${x}: the pole never got inside the hull`).toBeGreaterThan(-0.5);
      const forward = a.s.velocity[2];
      const lateral = Math.abs(a.s.velocity[0]);
      expect(forward < 3 || lateral > 2 || a.s.position[2] < 30 - 2, `x ${x}: stopped or deflected (vz ${forward.toFixed(1)}, |vx| ${lateral.toFixed(1)})`).toBe(true);
    }
  });

  it('a flexible gate pole costs 10% of speed once per brush and pushes nothing', () => {
    const a = boat([0, REST_Y, 0], 0, 20);
    const world = pole(0.6, 20, true);
    let hits = 0;
    let speedBefore = 0;
    let speedAfter = 0;
    for (let k = 0; k < 90; k++) {
      const s0 = Math.hypot(...a.s.velocity);
      const poses = new Float64Array(13);
      writePose(poses, 0, 0, a.s);
      beginContactTick(a.cm);
      collideBoatWithWorld(a.s, ch, world, null, DT, a.cm);
      if (a.cm.report.flexibleHits > 0) {
        hits += a.cm.report.flexibleHits;
        speedBefore = s0;
        speedAfter = Math.hypot(...a.s.velocity);
        expect(a.cm.report.source).toBe(CONTACT_FLEXIBLE);
      }
      a.hw.samplePatch(FLAT, a.s, DT);
      stepRigid6(a.s, hull, DT, 2, (ss, h, out) => a.hw.evaluate(ss, h, out), a.mem);
    }
    expect(hits, 'one episode, one loss').toBe(1);
    expect(speedAfter / speedBefore).toBeCloseTo(0.9, 6);
    expect(a.s.position[2], 'she went through the gate').toBeGreaterThan(25);
  });

  it('grounding on a rock slope deflects rather than sticks: turned along the face, still moving, pushed out, not launched', () => {
    // a 75° rock face along z at x ≈ 14 m, rising from −8 m to +3 m; she meets it at 30° to the contour at 15 m/s,
    // throttle held. WHY 75°: the bed normal tilts the response — on a 50° ramp the same code (correctly) runs her up
    // the rock like a boat ramp; a steep face must turn her aside (normal near-horizontal), not lift her.
    const slope = Math.tan((75 * Math.PI) / 180);
    const bed: BedHeight = (x) => Math.max(-8, Math.min(3, -8 + (x - 14) * slope));
    const heading = (60 * Math.PI) / 180; // 60° from +z toward +x = 30° to the face
    const a = boat([4, REST_Y, 0], heading, 15);
    const capV = BOAT_COLLIDE_DEFAULTS.maxImpactAccel * DT;
    let first = -1;
    let maxPen = 0;
    let maxY = -Infinity;
    const track: { z: number; vx: number; vz: number }[] = [];
    for (let k = 0; k < 240; k++) {
      tick([a], { bed, throttle: 0.4 });
      if (a.cm.report.count > 0) {
        if (first < 0) first = k;
        expect(Math.hypot(...a.cm.report.impulse) / hull.mass, 'V110').toBeLessThanOrEqual(capV * 1.0001);
      }
      for (let p = 0; p < ch.pointCount; p++) {
        const w = rotate(a.s.quaternion, ch.points.subarray(p * 3, p * 3 + 3));
        const x = a.s.position[0] + w[0];
        const y = a.s.position[1] + w[1];
        const h = bed(x, 0);
        // depth inside the rock measured along the face normal (horizontal distance × sin of the face angle)
        if (y < h) maxPen = Math.max(maxPen, (x - (14 + (y + 8) / slope)) * Math.sin(Math.atan(slope)));
      }
      maxY = Math.max(maxY, a.s.position[1]);
      track.push({ z: a.s.position[2], vx: a.s.velocity[0], vz: a.s.velocity[2] });
    }
    expect(first, 'she reached the rock').toBeGreaterThan(0);
    expect(maxPen, 'hull points never deep inside the rock').toBeLessThan(0.5);
    expect(maxY, 'not launched up the face').toBeLessThan(REST_Y + 2);
    const end = track[track.length - 1];
    expect(end.z - track[track.length - 61].z, 'still sliding along the face (m in the last second)').toBeGreaterThan(2);
    expect(end.vx, 'not driving into the face any more').toBeLessThan(0.5);
    const up = rotate(a.s.quaternion, [0, 1, 0])[1];
    expect(up, 'upright').toBeGreaterThan(0.8);
    const fwd = rotate(a.s.quaternion, [0, 0, 1]);
    expect(Math.abs(Math.atan2(fwd[0], fwd[2])), 'turned to run along the face').toBeLessThan((30 * Math.PI) / 180);
  });
});

describe('§T.188 cost', () => {
  it('µs per boat pair (reject and narrowphase) and per boat-world query (20 poles + a rock shelf)', () => {
    const a = boat([0, REST_Y, 0], 0, 30);
    const far = boat([60, REST_Y, 0], 0, 30);
    const near = boat([2.4, REST_Y, 3], 0.05, 28);
    const mem = createBoatCollideMemory(ch);
    const time = (fn: () => void, n: number): number => {
      for (let i = 0; i < 200; i++) fn();
      let best = Infinity;
      for (let r = 0; r < 4; r++) {
        const t0 = performance.now();
        for (let i = 0; i < n; i++) fn();
        best = Math.min(best, ((performance.now() - t0) * 1e3) / n);
      }
      return best;
    };
    const reject = time(() => boatPairContact(a.s, ch, far.s, ch, DT, mem), 20000);
    const narrow = time(() => boatPairContact(a.s, ch, near.s, ch, DT, mem), 5000);
    const colliders = Array.from({ length: 20 }, (_, i) => ({ a: [((i % 5) - 2) * 6, -4, 4 + i * 1.5] as Vec3, b: [((i % 5) - 2) * 6, 6, 4 + i * 1.5] as Vec3, radius: 0.3 }));
    const world = prepareStaticWorld(colliders);
    const bed: BedHeight = (x) => Math.max(-8, Math.min(3, -8 + (x - 2) * 1.2));
    const st = { ...a.s, velocity: [...a.s.velocity] as Vec3, angularVelocity: [...a.s.angularVelocity] as Vec3 };
    const worldQ = time(() => {
      st.velocity[0] = 0;
      st.velocity[1] = 0;
      st.velocity[2] = 30;
      st.angularVelocity.fill(0);
      beginContactTick(mem);
      collideBoatWithWorld(st, ch, world, bed, DT, mem);
    }, 2000);
    // eslint-disable-next-line no-console
    console.info(`[boatCollide] µs: pair reject ${reject.toFixed(2)}, pair narrowphase ${narrow.toFixed(2)}, boat-world (20 poles + shelf) ${worldQ.toFixed(2)}`);
    // budget: 28 pairs + 8 world queries ≪ 1 ms/tick (tech-research §8: sim ≤ 3 ms/tick total); loose for loaded machines
    expect(reject).toBeLessThan(5);
    expect(narrow).toBeLessThan(250);
    expect(worldQ).toBeLessThan(400);
  });
});
