/**
 * What the coast's props (src/drift/wandering/props.ts) must do in Act 3, whatever they are tuned to — the two faults
 * the 2026-10-30 QA sweep found there before the clean full-show render:
 *
 *   - THE FIELD IS NOT DRAWN BY DAY. Act 1's pairs over the beach in w3–w4 put ~700 white dots into the 2K master's
 *     blue sky (its blocker; the user's call that night: no field by day, coming in only as the sky darkens toward
 *     w6). So its weight is 0 under every coast beat's sky but w6's night, including w5's dusk as w6 dissolves in —
 *     and whole under w6's, so the night field keeps its look.
 *   - THE WANDERERS NEVER COME AT THE EYE. The stand-ins stepped into frame from behind it 2–3 m off and filled a third
 *     of it. On the coast's own ground they walk the wet sand at the water's edge, never nearer the eye than
 *     WALK_CLEAR at any instant of w5–w6, and walk on away from it, small, into the dusk.
 */
import { describe, expect, it } from 'vitest';
import { float, vec3 } from 'three/tsl';
import { createFilmCoast } from '../src/drift/wandering/coast';
import { BEATS, C1_FOLLOW, beatStarts, beatSun, beatsAt, coastEye, spec } from '../src/drift/wandering/beats';
import { WALK_CLEAR, fieldOnCoast, fieldWeight, wanderer, wetSand } from '../src/drift/wandering/props';

const c1End = 21 + C1_FOLLOW;
const { starts, total } = beatStarts(c1End);

/** the sky's darkness a pass is drawn under, as sea.ts hands it to the props (from its Sun's height) */
const nightOf = (beat: (typeof BEATS)[number]['name'], t: number): number => {
  const x = Math.min(1, Math.max(0, (beatSun(beat, t, c1End)[1] + 0.1) / 0.12));
  return 1 - x * x * (3 - 2 * x);
};

describe('the field on the coast', () => {
  it('is not drawn at all by day or through the dusk: in no coast pass but under w6\'s night', () => {
    // (nor in w1's arrival out of the sea's night, 2026-11-01: dark, but the night there is the network's)
    let drawn = 0;
    for (let t = starts.w1 - 10; t < total; t += 0.25) {
      for (const p of beatsAt(t, c1End)) {
        if (spec(p.name)?.world !== 'coast' || p.name === 'w6') continue;
        drawn = Math.max(drawn, fieldOnCoast(t, starts, nightOf(p.name, t)));
      }
    }
    expect(drawn).toBe(0);
    // (w1 does start dark: the field is kept out by its beats, not by the light)
    expect(nightOf('w1', starts.w1)).toBe(1);
  });

  it('is whole under w6\'s night, so the night field keeps its look', () => {
    for (let t = starts.w6 - spec('w6')!.dissolve / 2; t < total; t += 1) expect(fieldWeight(nightOf('w6', t))).toBe(1);
  });
});

describe('the wanderers', () => {
  const coast = createFilmCoast([-40000, 0], { ground: () => ({ albedo: vec3(0.5), roughness: float(1) }) } as never);
  // (its radio towers' GLB fetch fails in node; the ground is all this reads)
  coast.ready.catch(() => {});
  const { beach, ground } = coast;
  const edge = wetSand(ground, beach);
  const at = (i: number, t: number): { x: number; z: number; walked: number } => {
    const p = wanderer(i, t, starts.w5, edge);
    return { x: beach.x - p.off, z: beach.z - p.along, walked: p.walked };
  };

  it(`never come nearer the eye than ${WALK_CLEAR} m at any instant of w5 and w6 (the stand-ins passed it at 2.7)`, () => {
    let nearest = Infinity;
    for (let t = starts.w5 - 2; t < total; t += 0.1) {
      const e = coastEye(t, c1End, beach);
      for (const i of [0, 1, 2]) {
        const w = at(i, t);
        nearest = Math.min(nearest, Math.hypot(w.x - e.x, w.z - e.z));
      }
    }
    expect(nearest).toBeGreaterThanOrEqual(WALK_CLEAR);
  });

  it('walk the wet sand at the water\'s edge, not up the beach or out in the sea', () => {
    for (let t = starts.w5; t < total; t += 0.5) {
      for (const i of [0, 1, 2]) {
        const w = at(i, t);
        const h = ground(w.x, w.z);
        expect(h).toBeGreaterThan(-0.25);
        expect(h).toBeLessThan(0.6);
      }
    }
  });

  it('wander, not march (the 2026-11-01 note: "the people could be more wandery"): each stops and goes, stoops or looks round, and they drift apart and together across the beach', () => {
    const end = starts.w5 + spec('w5')!.length + 10;
    let apart = 0;
    let together = Infinity;
    for (const i of [0, 1, 2]) {
      let stopped = 0;
      let walking = 0;
      let did = 0;
      for (let t = starts.w5 + 2; t < end; t += 0.25) {
        const p = wanderer(i, t, starts.w5, edge);
        const v = (wanderer(i, t + 0.25, starts.w5, edge).walked - p.walked) / 0.25;
        if (v < 0.1) stopped += 0.25;
        if (v > 0.9) walking += 0.25;
        did = Math.max(did, p.stoop, Math.abs(p.look));
      }
      // (a pause of seconds, most of the time walking, and something done in it)
      expect(stopped).toBeGreaterThan(2);
      expect(walking).toBeGreaterThan(20);
      expect(did).toBeGreaterThan(0.6);
    }
    for (let t = starts.w5 + 15; t < end; t += 0.5) {
      const offs = [0, 1, 2].map((i) => wanderer(i, t, starts.w5, edge).off);
      const spread = Math.max(...offs) - Math.min(...offs);
      apart = Math.max(apart, spread);
      together = Math.min(together, spread);
    }
    expect(apart).toBeGreaterThan(2.5);
    expect(together).toBeLessThan(1.2);
  });

  it('walk on away from the eye, small, by the end of w5 — at a walk, without a jump', () => {
    const end = starts.w5 + spec('w5')!.length;
    const e = coastEye(end, c1End, beach);
    for (const i of [0, 1, 2]) {
      const w = at(i, end);
      expect(Math.hypot(w.x - e.x, w.z - e.z)).toBeGreaterThan(40);
      let fastest = 0;
      for (let t = starts.w5 - 2; t < total; t += 0.1) {
        const a = at(i, t);
        const b = at(i, t + 0.1);
        fastest = Math.max(fastest, Math.hypot(b.x - a.x, b.z - a.z) / 0.1);
      }
      expect(fastest).toBeLessThan(2);
    }
  });
});
