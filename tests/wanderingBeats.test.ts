/**
 * Part C and Act 3 on one clock (src/drift/wandering/beats.ts). Time passes in dissolves (the user's call,
 * 2026-10-27): the light and the surroundings crossfade, the camera never stops. So the tests hold the parts
 * that make that true: every instant is drawn by one beat, or two crossfading, and only at the planned
 * dissolves; where the eye is against the raft, and where it goes on the coast, change smoothly and slowly
 * (a jump there is a cut, a jolt is "stop and go"); and within a beat the Sun moves only slowly ("real time").
 */
import { describe, expect, it } from 'vitest';
import { BEATS, C1_FOLLOW, SAILING, beatStarts, beatSun, beatsAt, coastEye, coastLook, landfall, raftPose, type RaftPose } from '../src/drift/wandering/beats';

const c1End = 21 + C1_FOLLOW;
const { starts, total } = beatStarts(c1End);
const rest: RaftPose = { bearing: 0.26, distance: 18, heading: -1.5, height: 3 };
const beach = { x: -39310, z: 150 };

describe('the beats after the landing', () => {
  it('moves the Sun on without a jump wherever a beat follows another without a dissolve', () => {
    // (a beat's own Sun starting where the last one's stood: two degrees off it, the Sun jumped across the sky in
    // the cut — the v9 review, just before the dolphin)
    for (let i = 1; i < BEATS.length; i++) {
      const b = BEATS[i];
      if (b.dissolve > 0) continue;
      const a = BEATS[i - 1];
      const s = starts[b.name];
      const end = beatSun(a.name, s, c1End);
      const start = beatSun(b.name, s, c1End);
      const angle = Math.acos(Math.min(1, end[0] * start[0] + end[1] * start[1] + end[2] * start[2]));
      expect((angle * 180) / Math.PI, `${a.name} → ${b.name}`).toBeLessThan(0.05);
    }
  });

  it('draws every instant with one beat, or two crossfading only across the planned dissolves', () => {
    const dissolving = new Set<string>();
    for (let t = 0; t < total; t += 0.05) {
      const ps = beatsAt(t, c1End);
      expect(ps.reduce((s, p) => s + p.weight, 0)).toBeCloseTo(1, 9);
      if (ps.length === 2) dissolving.add(ps[1].name);
    }
    // the time-of-day jumps: c3's last light to c4's night, the night to w1's morning, w2's late morning to w3's
    // golden hour, w5's dusk to the outro's night; nowhere else — not c1 into c2, one continuous shot whose Sun
    // is scripted down to c2's (two worlds crossfaded there showed two suns and two rafts)
    expect([...dissolving].sort()).toEqual(['c4', 'w1', 'w3', 'w6']);
    // a dissolve is centred on its beat's start and lasts what the beat says
    for (const b of BEATS.filter((x) => x.dissolve > 0)) {
      expect(beatsAt(starts[b.name] - b.dissolve / 2 - 0.01, c1End)).toHaveLength(1);
      expect(beatsAt(starts[b.name] + b.dissolve / 2 + 0.01, c1End)).toEqual([{ name: b.name, weight: 1 }]);
    }
  });

  it('keeps the raft where it was against the eye through every dissolve, moving only slowly', () => {
    const h = 0.1;
    let was = raftPose(0, c1End, rest);
    expect(was).toEqual(rest);
    for (let t = h; t < starts.w2; t += h) {
      const now = raftPose(t, c1End, rest);
      expect(Math.abs(now.distance - was.distance) / h).toBeLessThan(1);
      expect(Math.abs(now.height - was.height) / h).toBeLessThan(0.3);
      expect((Math.abs(now.bearing - was.bearing) / h) * (180 / Math.PI)).toBeLessThan(2);
      was = now;
    }
  });

  it('glides along the coast, in and ashore without a kink or a jolt, and never faster than a walk', () => {
    const h = 0.05;
    const at = (t: number): [number, number] => {
      const c = coastEye(t, c1End, beach);
      return [c.x, c.z];
    };
    let fastest = 0;
    let jolt = 0;
    let [x0, z0] = at(starts.w1);
    let [x1, z1] = at(starts.w1 + h);
    for (let t = starts.w1 + 2 * h; t < total; t += h) {
      const [x2, z2] = at(t);
      const v = Math.hypot(x2 - x1, z2 - z1) / h;
      const a = Math.hypot(x2 - 2 * x1 + x0, z2 - 2 * z1 + z0) / (h * h);
      fastest = Math.max(fastest, v);
      jolt = Math.max(jolt, a);
      [x0, z0, x1, z1] = [x1, z1, x2, z2];
    }
    expect(fastest).toBeLessThan(3);
    expect(jolt).toBeLessThan(0.6);
    // ashore by w3 (the field and the flock are seen from the beach), and still out at sea through w1
    expect(coastEye(starts.w1 + 10, c1End, beach).ashore).toBe(0);
    expect(coastEye(starts.w3, c1End, beach).ashore).toBe(1);
  });

  it('runs the raft in to the beach bow first, at a sailing pace, clear of the eye, and leaves it aground', () => {
    // (the v8 notes: pushed sideways up the beach it read as "on rails"; a raft must sail in, and stop)
    const at = coastEye(starts.w2, c1End, beach);
    const from = { x: at.x + Math.sin(SAILING.bearing) * SAILING.distance, z: at.z - Math.cos(SAILING.bearing) * SAILING.distance };
    const h = 0.05;
    let was = landfall(starts.w2, c1End, from, beach);
    // it leaves where w1 had it, as w1 had it moving: bow to −z, at the coast drift
    expect(was.x).toBeCloseTo(from.x, 6);
    expect(was.z).toBeCloseTo(from.z, 6);
    expect(Math.cos(was.heading)).toBeCloseTo(-1, 3);
    let fastest = 0;
    let nearest = Infinity;
    let turning = 0;
    for (let t = starts.w2 + h; t < starts.w3 + 30; t += h) {
      const now = landfall(t, c1End, from, beach);
      const eye = coastEye(t, c1End, beach);
      fastest = Math.max(fastest, Math.hypot(now.x - was.x, now.z - was.z) / h);
      nearest = Math.min(nearest, Math.hypot(now.x - eye.x, now.z - eye.z));
      turning = Math.max(turning, (Math.abs(Math.atan2(Math.sin(now.heading - was.heading), Math.cos(now.heading - was.heading))) / h) * (180 / Math.PI));
      was = now;
    }
    expect(fastest).toBeLessThan(2.6);
    expect(turning).toBeLessThan(6);
    // (it comes round slowly: a little leeway early in the turn, never crabbing broadside)
    expect(nearest).toBeGreaterThan(5);
    // aground: it stays put
    expect(landfall(starts.w2 + 50, c1End, from, beach)).toEqual(landfall(starts.w5, c1End, from, beach));
  });

  it('looks round toward the land only slowly, and is back along the beach for the flock', () => {
    const h = 0.1;
    let fastest = 0;
    for (let t = starts.w1; t < total; t += h) fastest = Math.max(fastest, (Math.abs(coastLook(t + h, c1End) - coastLook(t, c1End)) / h) * (180 / Math.PI));
    expect(fastest).toBeLessThan(1.5);
    expect(coastLook(starts.w1 + 10, c1End)).toBeCloseTo(0, 9);
    expect(coastLook(starts.w4, c1End)).toBeCloseTo(0, 9);
  });

  it('moves the Sun within a beat as real time would, slowly', () => {
    const deg = (a: number[], b: number[]): number => (Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * 180) / Math.PI;
    for (const b of BEATS) {
      const h = 1;
      let fastest = 0;
      for (let t = starts[b.name]; t < starts[b.name] + b.length; t += h) fastest = Math.max(fastest, deg(beatSun(b.name, t, c1End), beatSun(b.name, t + h, c1End)) / h);
      expect(fastest).toBeLessThan(0.15);
    }
  });
});
