/**
 * What the ghost crabs on the walk beach (src/drift/wandering/crabs.ts, params beachCrabs) must do, whatever they are
 * tuned to — the 2026-11-02 brief ("make it more interesting to look at … without adding a whole lot of actual
 * action"), and what makes them crabs rather than props:
 *
 *   - THEY NEVER STAND IN THE WATER THEY RUN FROM. Ghost crabs live by staying just ahead of the swash; one the run-up
 *     washes over reads as a stone. Above the sand and outside their planned dash into the sea, every crab keeps
 *     landward of the swash's front (the sim's own scheme on a strip at their place) by a margin.
 *   - THE ONE RUNS FROM A WAVE: its dash home starts as a run-up comes at it (the front advancing, within ~1 m), not on
 *     a clock — the beat is the wave.
 *   - THEY RUN FROM PEOPLE: no crab is near a wanderer at any instant, and the group is gone into its burrows and the
 *     sea before the first wanderer reaches it.
 *   - THEY ARE WHERE THEY CAN BE SEEN, AND GONE BEFORE THEY CANNOT: the row-8 seat keeps only the sand ~11 m and more
 *     ahead of the eye in frame (the H18 tilt, pitch 24°), and a crab past ~18 m spans under 7 px of the 3840 seat
 *     view; every crab shown stands in that band ahead of the eye of its moment, and the group is gone by w5 + 12 s,
 *     before the eye rises out of the near sand's reach (beats.ts, w5's pull back from 10 s).
 *   - A GHOST CRAB'S RHYTHM: runs of a second or two at most, at a crab's speed (≤ 3 m/s), with dead stops between —
 *     it stands most of the time.
 *   - EVERY FRAME A PURE FUNCTION OF t: the same t, the same pose.
 *
 * And the flock's silence (params flockSilence): the eye holds through w4 — no turn left after a flock that now climbs
 * to the right (beats.ts coastLook) — and the default is the approved cut's look.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { float, vec3 } from 'three/tsl';
import { createFilmCoast } from '../src/drift/wandering/coast';
import { C1_FOLLOW, beatStarts, coastEye, coastLook } from '../src/drift/wandering/beats';
import { crabPlan, crabPose, frontAt, type CrabPlan } from '../src/drift/wandering/crabs';
import { wanderer, wetSand } from '../src/drift/wandering/props';
import { driftParams } from '../src/params/drift';

const c1End = 21 + C1_FOLLOW;
const { starts } = beatStarts(c1End);
/** m: the margin a crab keeps from the front (crabs.ts MARGIN's least, less the strip's 0.1 m cells) */
const DRY = 0.4;
/** m: the nearest a crab comes to a wanderer */
const PEOPLE = 5;
/** m ahead of the eye: the near sand the row-8 seat keeps in frame, and where a crab still spans ~7 px of it */
const SEEN: [number, number] = [11, 18.5];

describe('the ghost crabs', () => {
  const coast = createFilmCoast([-40000, 0], { ground: () => ({ albedo: vec3(0.5), roughness: float(1) }) } as never);
  coast.ready.catch(() => {});
  const { beach, ground } = coast;
  const edge = wetSand(ground, beach);
  let plan: CrabPlan;
  beforeAll(() => {
    plan = crabPlan(ground, beach, starts);
  }, 60000);
  const frontOf = (i: number) => (i === 0 ? plan.fronts.one : plan.fronts.group);
  /** each crab's frames: [t, pose] over its span, every 1/30 s */
  const frames = (i: number) => {
    const c = plan.crabs[i];
    const out: Array<[number, ReturnType<typeof crabPose>]> = [];
    for (let t = c.from; t <= c.to; t += 1 / 30) out.push([t, crabPose(c, t)]);
    return out;
  };

  it('never stand in the swash they run from (outside their dash into the sea)', () => {
    plan.crabs.forEach((c, i) => {
      // (a crab of the group that goes into the sea: its last run, seaward, and after)
      const last = c.runs[c.runs.length - 1];
      const intoSea = i > 0 && last.o1 > last.o0;
      let worst = Infinity;
      for (const [t, p] of frames(i)) {
        if (!p.shown || p.sink > 0.01 || (intoSea && t >= last.t0)) continue;
        worst = Math.min(worst, frontAt(frontOf(i), t) - p.off);
      }
      expect(worst, `crab ${i}`).toBeGreaterThan(DRY);
    });
  });

  it('the one runs home as a run-up comes at it', () => {
    const c = plan.crabs[0];
    const f = plan.fronts.one;
    // its dash home: the last run (the gag's peek is in place)
    const home = c.runs[c.runs.length - 1];
    const at = home.o0;
    const gap = frontAt(f, home.t0) - at;
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThan(1.3);
    expect(frontAt(f, home.t0 + 0.3)).toBeLessThan(frontAt(f, home.t0));
    // (and the water then comes on up where it stood: it ran from a real wave)
    let reach = Infinity;
    for (let t = home.t0; t < home.t0 + 4; t += 0.05) reach = Math.min(reach, frontAt(f, t));
    expect(reach).toBeLessThan(at + 0.8);
  });

  it('keep away from the wanderers, and the group is gone before the first reaches it', () => {
    plan.crabs.forEach((_, i) => {
      let near = Infinity;
      for (const [t, p] of frames(i)) {
        if (!p.shown || t < starts.w5 - 1) continue;
        for (const w of [0, 1, 2]) {
          const q = wanderer(w, t, starts.w5, edge);
          near = Math.min(near, Math.hypot(q.along - p.along, q.off - p.off));
        }
      }
      expect(near, `crab ${i}`).toBeGreaterThan(PEOPLE);
    });
  });

  it('stand where the row-8 seat sees them, and the group is gone before the eye rises', () => {
    plan.crabs.forEach((_, i) => {
      for (const [t, p] of frames(i)) {
        if (!p.shown || p.sink > 0.03) continue;
        const e = coastEye(t, c1End, beach);
        const ahead = p.along - (beach.z - e.z);
        expect(ahead, `crab ${i} at ${t.toFixed(2)}`).toBeGreaterThan(SEEN[0]);
        expect(ahead, `crab ${i} at ${t.toFixed(2)}`).toBeLessThan(SEEN[1]);
        // (the eye still at its standing height: the crabs read only from it)
        expect(e.height).toBeLessThan(1.7);
      }
    });
    for (const c of plan.crabs.slice(1)) expect(c.to).toBeLessThan(starts.w5 + 12);
  });

  it('move as ghost crabs do: short fast runs, dead stops, standing most of the time', () => {
    plan.crabs.forEach((c, i) => {
      let moving = 0;
      let shown = 0;
      let fastest = 0;
      for (const [, p] of frames(i)) {
        if (!p.shown) continue;
        shown++;
        if (p.speed > 0.05) moving++;
        fastest = Math.max(fastest, p.speed);
      }
      expect(fastest, `crab ${i}`).toBeLessThan(3);
      expect(fastest, `crab ${i}`).toBeGreaterThan(1.2);
      expect(moving / shown, `crab ${i}`).toBeLessThan(0.4);
      for (const r of c.runs) expect(r.t1 - r.t0).toBeLessThan(2.2);
      for (let k = 1; k < c.runs.length; k++) expect(c.runs[k].t0).toBeGreaterThanOrEqual(c.runs[k - 1].t1 - 1e-9);
    });
  });

  it('is a pure function of t', () => {
    const again = crabPlan(ground, beach, starts);
    plan.crabs.forEach((c, i) => {
      for (const t of [c.from + 1.3, (c.from + c.to) / 2, c.to - 0.7]) expect(crabPose(again.crabs[i], t)).toEqual(crabPose(c, t));
    });
  }, 60000);
});

describe('the flock in the silence: the eye', () => {
  const was = driftParams.flockSilence;
  afterEach(() => {
    driftParams.flockSilence = was;
  });
  it('holds on the front through w4 under flockSilence, and turns left after the flock without it', () => {
    driftParams.flockSilence = true;
    for (let t = starts.w4; t < starts.w5; t += 0.5) expect(coastLook(t, c1End)).toBeCloseTo(0, 9);
    driftParams.flockSilence = false;
    expect(coastLook(starts.w4 + 21, c1End)).toBeGreaterThan(0.15);
  });
});
