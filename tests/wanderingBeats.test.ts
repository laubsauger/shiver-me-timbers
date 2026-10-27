/**
 * Part C and Act 3 on one clock (src/drift/wandering/beats.ts). Time passes in dissolves (the user's call,
 * 2026-10-27): the light and the surroundings crossfade, the camera never stops. So the tests hold the parts
 * that make that true: every instant is drawn by one beat, or two crossfading, and only at the planned
 * dissolves; where the eye is against the raft, and where it goes on the coast, change smoothly and slowly
 * (a jump there is a cut, a jolt is "stop and go"); and within a beat the Sun moves only slowly ("real time").
 */
import { describe, expect, it } from 'vitest';
import { BEATS, C1_FOLLOW, beatStarts, beatSun, beatsAt, coastEye, raftPose, type RaftPose } from '../src/drift/wandering/beats';

const c1End = 21 + C1_FOLLOW;
const { starts, total } = beatStarts(c1End);
const rest: RaftPose = { bearing: 0.26, distance: 18, heading: -1.5, height: 3 };
const beach = { x: -39310, z: 150 };

describe('the beats after the landing', () => {
  it('draws every instant with one beat, or two crossfading only across the planned dissolves', () => {
    const dissolving = new Set<string>();
    for (let t = 0; t < total; t += 0.05) {
      const ps = beatsAt(t, c1End);
      expect(ps.reduce((s, p) => s + p.weight, 0)).toBeCloseTo(1, 9);
      if (ps.length === 2) dissolving.add(ps[1].name);
    }
    // the time-of-day jumps: c1's morning to c2's sunset, c3's last light to c4's night, the night to w1's
    // morning, w2's late morning to w3's golden hour, w5's dusk to the outro's night; nowhere else
    expect([...dissolving].sort()).toEqual(['c2', 'c4', 'w1', 'w3', 'w6']);
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
