/**
 * C3's dolphin (src/drift/wandering/dolphin.ts). At last light only its outline reads, so its motion carries it
 * (the user, 2026-10-27: "motion curves and the speed / timing" over geometry). The v9 stand-in crept at 1.3 m/s
 * and bobbed in sine bumps, its body pitched by a curve of its own, and read as a hopping blob. What these hold:
 * it travels at a dolphin's pace; out of the water it falls as a body does; its body lies along its path; it
 * comes up only where the choreography says, and is out of sight between.
 */
import { describe, expect, it } from 'vitest';
import { C3_RAFT, CASE_FROM, CASE_ON_DECK, DOLPHIN_SPAN, FLIP_AT_T, FLIP_RELEASE, NOSE_AT, SURFACINGS, caseAfloat, caseOnDeck, dolphinPose, dolphinSplashes, flipThrow } from '../src/drift/wandering/dolphin';
import { C1_FOLLOW, beatStarts, raftPose, type RaftPose } from '../src/drift/wandering/beats';

/** eye frame (x right, z ahead) → c3's raft: (across, along) m from its centre, along toward its bow */
function c3RaftLocal([x, z]: [number, number] | number[]): [number, number] {
  const D = Math.PI / 180;
  const c = [Math.sin(C3_RAFT.bearing * D) * C3_RAFT.distance, Math.cos(C3_RAFT.bearing * D) * C3_RAFT.distance];
  const a = [-Math.sin(C3_RAFT.heading * D), Math.cos(C3_RAFT.heading * D)];
  const rx = x - c[0];
  const rz = z - c[1];
  return [rx * a[1] - rz * a[0], rx * a[0] + rz * a[1]];
}

const G = 9.81;
const h = 1 / 240;

describe('the dolphin in c3', () => {
  it('travels at a dolphin pace between surfacings, slowing only at the case, from the nose to the flip', () => {
    for (let t = DOLPHIN_SPAN[0] + 1; t < DOLPHIN_SPAN[1] - 1; t += 0.05) {
      const v = dolphinPose(t).speed;
      expect(v).toBeLessThan(7.5);
      // (bottlenose cruising is 3–6 m/s; the stand-in's 1.3 m/s read as a float, not a swimmer. Idling with the case,
      // nosing it and coming up under it, it is slow on purpose: the 2026-11-01 choreography)
      if (t < NOSE_AT - 0.5 || t > FLIP_AT_T + 3) expect(v, `t = ${t.toFixed(2)}`).toBeGreaterThan(2);
    }
  });

  it('falls ballistically when out of the water, and clears it by what each leap asks', () => {
    for (const [at, , , kind, clear = 0] of SURFACINGS) {
      if (kind === 'roll' || kind === 'swim') continue;
      let top = -Infinity;
      for (let t = at + 0.02; t < at + (2 * Math.sqrt(2 * G * clear)) / G - 0.02; t += 0.01) {
        const y0 = dolphinPose(t - h).y;
        const y1 = dolphinPose(t).y;
        const y2 = dolphinPose(t + h).y;
        expect((y2 - 2 * y1 + y0) / (h * h)).toBeCloseTo(-G, 1);
        top = Math.max(top, y1);
      }
      expect(top).toBeCloseTo(clear, 1);
    }
  });

  it('lies along its own path: the nose points where the body is going', () => {
    for (let t = DOLPHIN_SPAN[0] + 0.5; t < DOLPHIN_SPAN[1] - 0.5; t += 0.037) {
      const a = dolphinPose(t - h);
      const b = dolphinPose(t + h);
      const vy = (b.y - a.y) / (2 * h);
      const vh = Math.hypot(b.x - a.x, b.z - a.z) / (2 * h);
      if (vh < 0.5) continue;
      expect(dolphinPose(t).pitch).toBeCloseTo(Math.atan2(vy, vh), 1);
    }
  });

  it('is out of sight between surfacings, and its back breaks the water at each roll', () => {
    // (at last light a body a metre down is gone; an always-visible dolphin is a toy on a stick)
    for (const [at, , , kind] of SURFACINGS) {
      if (kind === 'roll') expect(dolphinPose(at).y).toBeGreaterThan(-0.3);
    }
    // (half-way between two surfacings its back, ~0.3 m over its centre, is a good way under)
    const ups = SURFACINGS.filter((s) => s[3] !== 'swim');
    const gaps = ups.slice(1).map((s, i) => (ups[i][0] + s[0]) / 2);
    for (const t of gaps) expect(dolphinPose(t).y + 0.32).toBeLessThan(-0.4);
  });

  it('flips the case from high, head up, heading straight at the deck spot it throws it onto', () => {
    const f = dolphinPose(FLIP_RELEASE);
    expect(f.y).toBeGreaterThan(0.6);
    expect(f.pitch).toBeGreaterThan(0.3);
    // the case goes where the dolphin was going (a throw sideways to its travel read as "unbelievable"), and that is
    // at the deck: it had been thrown a fixed reach along the heading and come down on the water (the v9 review)
    const th = flipThrow();
    expect(th.dir[0] * Math.sin(f.heading) + th.dir[1] * Math.cos(f.heading)).toBeGreaterThan(0.99);
    const to = [th.to[0] - th.from[0], th.to[1] - th.from[2]];
    const len = Math.hypot(to[0], to[1]);
    expect((to[0] * th.dir[0] + to[1] * th.dir[1]) / len).toBeGreaterThan(Math.cos((5 * Math.PI) / 180));
    // a flick, not a cannon shot
    expect(len).toBeLessThan(6.5);
    // and the spot is on the deck: within the raft's planform (13.7 m long, 9 logs ≈ 5.4 m across)
    const [x, z] = c3RaftLocal(th.to);
    expect(Math.abs(z)).toBeLessThan(6.85 - 1);
    expect(Math.abs(x)).toBeLessThan(2.7 - 0.5);
  });

  it('keeps the case on the deck spot it was thrown at, in the raft\'s own frame, whatever the raft does later', () => {
    // (found from the eye-frame spot every frame, it fell off the deck once the raft's pose against the eye changed:
    // afloat beside the raft through the night and along the coast, the v10 review)
    const { spot, dir } = caseOnDeck();
    expect(spot[0]).toBeCloseTo(CASE_ON_DECK.across, 6);
    expect(spot[1]).toBeCloseTo(CASE_ON_DECK.along, 6);
    // thrown in over the bow, toward the stern: from beyond the bow's tip (6.85 m), its whole line ahead of the mast
    // (1.2 m), the sail and the cabin behind it (thrown through them from the far side, the case landed out of sight:
    // the v9 review), and onto the deck in front of us
    expect(dir[1]).toBeLessThan(0);
    const th = flipThrow();
    const [, alongFrom] = c3RaftLocal([th.from[0], th.from[2]]);
    expect(alongFrom).toBeGreaterThan(6.85);
    expect(spot[1]).toBeGreaterThan(1.2 + 2.5);
  });

  it('lays the choreography about the raft where beats.ts puts it in c3', () => {
    const rest: RaftPose = { bearing: 0.26, distance: 18, heading: -1.5, height: 3 };
    const c1End = 21 + C1_FOLLOW;
    const p = raftPose(beatStarts(c1End).starts.c3 + FLIP_RELEASE, c1End, rest);
    expect((p.bearing * 180) / Math.PI).toBeCloseTo(C3_RAFT.bearing, 3);
    expect(p.distance).toBeCloseTo(C3_RAFT.distance, 3);
    expect((p.heading * 180) / Math.PI).toBeCloseTo(C3_RAFT.heading, 3);
  });

  it('never comes up into the raft, nor swims through it near the surface', () => {
    // c3's raft at the flip (as above): its centre log from the stern to the bow, 13.7 m, 9 logs ≈ 5.4 m across
    // (the v9 review: "it landed in the thing" — it had come down into the bow and swum on through it)
    for (let t = FLIP_RELEASE - 6; t < FLIP_RELEASE + 6; t += 0.02) {
      const p = dolphinPose(t);
      if (p.y < -0.9) continue;
      const [across, along] = c3RaftLocal([p.x, p.z]);
      const inside = Math.abs(along) < 6.85 + 1.3 && Math.abs(across) < 2.7 + 0.5;
      expect(inside, `t = ${t.toFixed(2)}`).toBe(false);
    }
  });

  it('bends its body along its path smoothly, into its turns and over its leaps, never snapping', () => {
    // (a stiff plank turned about its middle read as "rotating in place"; a bend taken from the path's raw curvature,
    // which steps at every waypoint, snapped the body there instead)
    let was = dolphinPose(DOLPHIN_SPAN[0]);
    let turned = 0;
    for (let t = DOLPHIN_SPAN[0] + 1 / 30; t < DOLPHIN_SPAN[1]; t += 1 / 30) {
      const p = dolphinPose(t);
      // (a frame's change at most ~a sixth of the full bend: the flip's take-off is the steepest, ~0.06/frame — a
      // snap is the whole 0.5 at once)
      expect(Math.abs(p.bend - was.bend), `bend at ${t.toFixed(2)}`).toBeLessThan(0.08);
      expect(Math.abs(p.turn - was.turn), `turn at ${t.toFixed(2)}`).toBeLessThan(0.08);
      if (Math.abs(p.turn) > 0.08) turned++;
      // it leans INTO a turn: the bank has the turn's sign
      if (Math.abs(p.turn) > 0.05) expect(Math.sign(p.bank)).toBe(Math.sign(p.turn));
      was = p;
    }
    // and it does bend: the loop before the flip is a real turn
    expect(turned).toBeGreaterThan(30);
  });

  it('throws no spout at the rolls: only leaps and the flip throw spray; a roll only rings the water', () => {
    // (a blow drawn as a column read as a whale's spout: the v9 review. A roll's back breaking the water leaves a small
    // ring of foam, and the nose pushes a little water up at the case: the 2026-11-01 notes)
    const rolls = SURFACINGS.filter((s) => s[3] === 'roll').map((s) => s[0]);
    const near = (t: number): boolean => rolls.some((r) => Math.abs(r - t) < 0.5);
    for (const sp of dolphinSplashes()) {
      expect(sp.kind).not.toBe('blow');
      if (sp.kind === 'spray' && near(sp.at)) expect(Math.abs(sp.at - NOSE_AT)).toBeLessThan(0.01);
    }
    // every leap and the flip: spray and a ring going out and coming in, drips between
    for (const [at, , , kind] of SURFACINGS) {
      if (kind !== 'leap' && kind !== 'flip') continue;
      const mine = dolphinSplashes().filter((sp) => sp.at >= at - 0.01 && sp.at < at + 2);
      expect(mine.filter((sp) => sp.kind === 'spray').length).toBeGreaterThanOrEqual(2);
      expect(mine.filter((sp) => sp.kind === 'ring').length).toBeGreaterThanOrEqual(2);
      expect(mine.some((sp) => sp.kind === 'drip')).toBe(true);
    }
  });

  it('plays on the stage left of the sail, in the Sun\'s light, where the dome and the 16:9 frame see it', () => {
    // (the 2026-11-01 review: "We need a better view of the dolphin". It had come up 31–103° left, under the dome's rim
    // or behind our shoulder, and never in the 16:9 frame. From the eye: the Sun 22° left, its glitter road ~16–28° left,
    // the sail and the cabin from 11° left to the right. A point shows on the 15°-tilted dome while its drop below the
    // eye (2.3 m) is under its distance ahead × tan 15°)
    const sun = -22;
    for (const [at, , , kind, h = 0] of SURFACINGS) {
      if (kind === 'swim' || at > FLIP_AT_T + 1) continue;
      const top = kind === 'roll' ? at : at + Math.sqrt(2 * G * h) / G;
      const p = dolphinPose(top);
      const bearing = (Math.atan2(p.x, p.z) * 180) / Math.PI;
      expect(bearing, `${kind} at ${at}`).toBeLessThan(-12);
      expect(bearing, `${kind} at ${at}`).toBeGreaterThan(-40);
      expect(2.3 - (p.y + 0.3), `${kind} at ${at}: under the dome's rim`).toBeLessThan(p.z * Math.tan((15 * Math.PI) / 180) - 0.5);
      // the leaps and the flip against the Sun's light: within 10° of its bearing
      if (kind !== 'roll') expect(Math.abs(bearing - sun), `${kind} at ${at}`).toBeLessThan(10);
    }
  });

  it('finds the case afloat, noses it and comes up under it: the case is where the beak is, and clear of the raft', () => {
    // (the case had come out of nowhere at the flip; now it floats there from far out, drifting down on the raft as it
    // sails, the 2026-11-01 choreography)
    const beak = (t: number): [number, number] => {
      const p = dolphinPose(t);
      return [p.x + Math.sin(p.heading) * 1.3 * Math.cos(p.pitch), p.z + Math.cos(p.heading) * 1.3 * Math.cos(p.pitch)];
    };
    const at = caseAfloat(NOSE_AT - 1e-3);
    const b = beak(NOSE_AT);
    expect(Math.hypot(at[0] - b[0], at[1] - b[1])).toBeLessThan(0.4);
    // at the nose the head is at the water, not a metre under it
    expect(dolphinPose(NOSE_AT).y).toBeGreaterThan(-0.3);
    const f = caseAfloat(FLIP_AT_T);
    const p = dolphinPose(FLIP_AT_T);
    expect(Math.hypot(f[0] - p.x, f[1] - p.z)).toBeLessThan(0.6);
    // afloat it never runs into the raft (13.7 m long, the bow's tip at 6.85 m; 9 logs ≈ 5.4 m across)
    for (let t = 14; t <= FLIP_AT_T; t += 0.1) {
      const [across, along] = c3RaftLocal(caseAfloat(t));
      expect(Math.abs(along) > 6.85 + 0.6 || Math.abs(across) > 2.7 + 0.4, `t = ${t.toFixed(1)}`).toBe(true);
    }
    // and it drifts as the water does, smoothly: never faster than the raft's way plus the nose's push
    for (let t = CASE_FROM; t < FLIP_AT_T; t += 0.05) {
      const a = caseAfloat(t);
      const c = caseAfloat(t + 0.05);
      expect(Math.hypot(c[0] - a[0], c[1] - a[1]) / 0.05, `t = ${t.toFixed(2)}`).toBeLessThan(3);
    }
  });
});
