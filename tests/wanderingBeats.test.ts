/**
 * Part C and Act 3 on one clock (src/drift/wandering/beats.ts). Time passes in dissolves (the user's call,
 * 2026-10-27): the light and the surroundings crossfade, the camera never stops — or, where a beat runs on in one
 * shot, in a time-lapse (c4's nightfall, the 2026-10-29 review). So the tests hold the parts
 * that make that true: every instant is drawn by one beat, or two crossfading, and only at the planned
 * dissolves; where the eye is against the raft, and where it goes on the coast, change smoothly and slowly
 * (a jump there is a cut, a jolt is "stop and go"); and within a beat the Sun moves only slowly ("real time").
 */
import { describe, expect, it } from 'vitest';
import { BEATS, C1_FOLLOW, SAILING, airAt, beatStarts, beatSun, beatsAt, coastEye, coastLook, landfall, raftPose, sailsAt, speedAt, type RaftPose } from '../src/drift/wandering/beats';

const c1End = 21 + C1_FOLLOW;
const { starts, total } = beatStarts(c1End);
const rest: RaftPose = { bearing: 0.26, distance: 18, heading: -1.5, height: 3 };
const beach = { x: -39310, z: 150 };

/** deg between two unit vectors */
const deg = (a: number[], b: number[]): number => (Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * 180) / Math.PI;

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

  it('keeps the sail set from the open sea through the dolphin into the night, struck only once the dissolve is through', () => {
    // (struck at the dolphin's turn, it went up and came down again within 45 s — the v10 review; and a sail set on
    // one side of a dissolve and struck on the other shows two sails crossfading)
    for (let t = starts.c2; t <= starts.c4 + 6; t += 0.25) {
      for (const { name } of beatsAt(t, c1End)) expect(sailsAt(name, t, c1End), `${name} at ${t - starts.c2} s into c2`).toBe(1);
    }
    let last = 1;
    for (let t = starts.c4; t < starts.w1 - 6; t += 0.25) {
      const now = sailsAt('c4', t, c1End);
      expect(now).toBeLessThanOrEqual(last);
      last = now;
    }
    expect(last).toBe(0);
    // the air it stands in: the day's through the dolphin's throw, then dying with the light
    expect(airAt(starts.c3 + 27, starts)).toBeGreaterThan(0.9);
    expect(airAt(starts.c4, starts)).toBeLessThan(0.35);
  });

  it('changes the world into the morning in the dark, then brings the dawn up in one continuous run', () => {
    // (the 2026-11-01 review: the night-to-island dissolve felt "a bit abrupt and blendy" — night and day crossfaded.
    // No crossfade in continuous action: the light is scripted over time. So through the dissolve both beats draw
    // the same deep night (no day on either side), and the light lifts only once the new world stands alone)
    const w1 = BEATS.find((b) => b.name === 'w1')!;
    expect(w1.rise).toBeDefined();
    const s = starts.w1;
    const el = (v: number[]): number => (Math.asin(v[1]) * 180) / Math.PI;
    for (let t = s - w1.dissolve / 2; t <= s + w1.dissolve / 2; t += 0.1) {
      for (const { name } of beatsAt(t, c1End)) expect(el(beatSun(name, t, c1End)), `${name} at ${(t - s).toFixed(1)} s`).toBeLessThan(-18);
    }
    // the dawn is a passage, not a cut: from night (−12°, before any first light) to the morning's 5° takes well over
    // the old dissolve's 10 s, and the Sun never steps
    const h = 1 / 30;
    let firstLight = NaN;
    let up = NaN;
    let fastest = 0;
    for (let t = s; t < s + w1.length; t += h) {
      const a = el(beatSun('w1', t, c1End));
      if (Number.isNaN(firstLight) && a > -12) firstLight = t;
      if (Number.isNaN(up) && a > 5) up = t;
      fastest = Math.max(fastest, deg(beatSun('w1', t, c1End), beatSun('w1', t + h, c1End)) / h);
    }
    expect(up - firstLight).toBeGreaterThan(18);
    expect(fastest).toBeLessThan(2);
    // and it ends on the morning w2 runs on from
    const end = beatSun('w1', starts.w2, c1End);
    expect(deg(end, beatSun('w2', starts.w2, c1End))).toBeLessThan(0.05);
  });

  it('never draws the sail one way on one side of a dissolve and the other way on the other', () => {
    // (struck at night and set in w1's morning, the dissolve drew a ghost sail over the struck one — 2026-11-01)
    for (let t = 0; t < total; t += 0.05) {
      const ps = beatsAt(t, c1End);
      if (ps.length < 2) continue;
      const [a, b] = ps.map((p) => sailsAt(p.name, t, c1End));
      expect(Math.abs(a - b), `${ps[0].name}/${ps[1].name} at ${t.toFixed(2)}`).toBeLessThan(1e-6);
    }
  });

  it('draws every instant with one beat, or two crossfading only across the planned dissolves', () => {
    const dissolving = new Set<string>();
    for (let t = 0; t < total; t += 0.05) {
      const ps = beatsAt(t, c1End);
      expect(ps.reduce((s, p) => s + p.weight, 0)).toBeCloseTo(1, 9);
      if (ps.length === 2) dissolving.add(ps[1].name);
    }
    // the time-of-day jumps: the night to w1's morning, w2's late morning to w3's golden hour, w5's dusk to the
    // outro's night; nowhere else — not c1 into c2, one continuous shot whose Sun is scripted down to c2's (two
    // worlds crossfaded there showed two suns and two rafts), and not c3 into c4 any more: night falls there in a
    // time-lapse in one shot (the 2026-10-29 review: a dissolve brought the Milky Way up "very instant and fast …
    // like a bad transition"; the lapse test below holds it)
    expect([...dissolving].sort()).toEqual(['w1', 'w3', 'w6']);
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

  it('drifts along the coast with its sail struck through the dark, and gathers way only once it is set at dawn', () => {
    // (the eye ran along the coast at 1 m/s from w1's first frame while the sail stood struck, and the raft's way
    // through the water stepped from the night's 0.2 to 1 m/s at w1 − 10 s — the 2026-11-01 review: the motion must
    // follow the sail: slow with it struck, under way as it is set, eased, never a jump)
    const h = 0.05;
    const along = (t: number): number => {
      const a = coastEye(t - h / 2, c1End, beach);
      const b = coastEye(t + h / 2, c1End, beach);
      return Math.hypot(b.x - a.x, b.z - a.z) / h;
    };
    for (let t = starts.w1 - 5; t < starts.w2; t += 0.25) {
      const sail = sailsAt('w1', t, c1End);
      // struck (or barely drawing): a drift, no faster than the night's way
      if (sail < 0.5) expect(along(t), `${(t - starts.w1).toFixed(2)} s into w1, sail ${sail.toFixed(2)}`).toBeLessThan(0.3);
      // the eye on the coast moves as the raft makes way (the wake is laid by the same speed)
      expect(Math.abs(along(t) - speedAt(t, starts)), `${(t - starts.w1).toFixed(2)} s into w1`).toBeLessThan(0.02);
    }
    // under way by w2, at the speed the landfall leaves at
    expect(along(starts.w2 - 0.1)).toBeGreaterThan(0.95);
    // the way through the water, the open sea's and the coast's alike, changes without a step from the night to w2
    let step = 0;
    for (let t = starts.c4; t < starts.w2; t += h) step = Math.max(step, Math.abs(speedAt(t + h, starts) - speedAt(t, starts)));
    expect(step).toBeLessThan(0.01);
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

  it('looks round toward the land and to the birds only slowly, and is back along the beach between', () => {
    // (every turn of the dome's eye at most ~1.5°/s at its fastest: the dome's comfort, docs/drift/WORKING-NOTES.md —
    // camera turns "about 1° a second or less" — a turn the whole audience is carried through; the w4 look toward
    // the sandpipers was 22° over 8 s, 4.7°/s, and is 10° over 10 s now, the user not being able to judge its speed
    // from a 16:9 view, 2026-10-30)
    const h = 0.1;
    let fastest = 0;
    for (let t = starts.w1; t < total; t += h) fastest = Math.max(fastest, (Math.abs(coastLook(t + h, c1End) - coastLook(t, c1End)) / h) * (180 / Math.PI));
    expect(fastest).toBeLessThanOrEqual(1.5);
    expect(coastLook(starts.w1 + 10, c1End)).toBeCloseTo(0, 9);
    expect(coastLook(starts.w4, c1End)).toBeCloseTo(0, 9);
    // w4: round to the left, out over the sea where the flock wheels ("we should tilt a little to the left to watch
    // the sandpipers", the 2026-10-29 review), and back along the beach before the wanderers come past in w5
    const D = Math.PI / 180;
    expect(coastLook(starts.w4 + 20, c1End) / D).toBeGreaterThan(8);
    expect(coastLook(starts.w5, c1End)).toBeCloseTo(0, 9);
  });

  it('moves the Sun within a beat as real time would, slowly', () => {
    // (direction.md: "within a beat the light runs in real time, slowly (under 0.15°/s)"; time passes between
    // beats, in a dissolve — or, where a beat says so, in a time-lapse, the next test)
    for (const b of BEATS.filter((x) => !x.lapse)) {
      const h = 1;
      let fastest = 0;
      // (a dawn's run is a time-lapse too: real time from its end)
      const from = starts[b.name] + (b.rise ? b.rise.at + b.rise.over : 0);
      for (let t = from; t < starts[b.name] + b.length; t += h) fastest = Math.max(fastest, deg(beatSun(b.name, t, c1End), beatSun(b.name, t + h, c1End)) / h);
      expect(fastest, b.name).toBeLessThan(0.15);
    }
  });

  it('lets a time-lapse beat bring its light down in one continuous run, then hold it as real time again', () => {
    // (c4: night falls in a time-lapse in place of a dissolve — the 2026-10-29 review — so the Sun may move fast
    // there, but never jump: eased in from where the beat before left it, still again once the lapse is run, so the
    // night after it is a night, not a Sun still sinking)
    const lapsed = BEATS.filter((x) => x.lapse);
    expect(lapsed.length).toBeGreaterThan(0);
    for (const b of lapsed) {
      const s = starts[b.name];
      const span = Math.abs(b.sunEl[1] - b.sunEl[0]);
      const h = 1 / 30;
      let fastest = 0;
      for (let t = s; t < s + b.lapse!; t += h) fastest = Math.max(fastest, deg(beatSun(b.name, t, c1End), beatSun(b.name, t + h, c1End)) / h);
      // continuous: no faster than the eased run's own peak (1.5 × its span over its length), so no step anywhere
      expect(fastest, b.name).toBeLessThan((1.5 * span) / b.lapse! + 0.01);
      // and done: from the lapse's end to the beat's, the Sun stands
      expect(deg(beatSun(b.name, s + b.lapse!, c1End), beatSun(b.name, s + b.length - 0.01, c1End)), b.name).toBeLessThan(0.01);
    }
  });
});
