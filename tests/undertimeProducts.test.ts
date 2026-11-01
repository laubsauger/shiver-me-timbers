/**
 * What Undertime's collisions leave behind (productModel.ts; the 2026-10-30 review: "more interesting shapes that the
 * different particle collisions are doing, and more interesting results of particles"). The products only read as
 * physics — not as decoration sprayed onto the pairs — if they keep the physics' tells: a star's prongs balance
 * (momentum is conserved), a kink starts where and when its parent ends, delta rays are electrons (matter: they curl
 * like the matter bead and are amber), a converted gamma's pair points on along the photon's way and appears only once
 * the light could have got there, and nothing is born behind the light wave. If any of these breaks, the field turns
 * back into squiggles.
 */
import { describe, expect, it } from 'vitest';
import { driftParams } from '../src/params/drift';
import { HERO_RUN, beatStarts, eyePath, heroGrainPosition, heroPassTime, undertimeState, waveTimeAt } from '../src/drift/undertime/timeline';
import { SURVIVOR } from '../src/drift/undertime/productModel';
import { PHOTON_SPEED, endPoint, generatePairs, loopPoint, meetingPoint, type PairEvent } from '../src/drift/undertime/events';
import { MATTER, generateProducts, jet, trackPoint, trackTangent, type ProductTrack } from '../src/drift/undertime/productModel';
import { undertimeEvents } from '../src/drift/undertime/field';
import { RAG, frontFracCpu, frontRagCpu } from '../src/drift/undertime/front';
import { domeBasis, type Vec3 } from '../src/cine/domeMaster';
import { rng } from '../src/drift/undertime/web';

const p = { ...driftParams };
const { starts } = beatStarts(p);
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

const pairs = generatePairs(
  {
    seed: 11, rate: () => 40, from: 0, to: 20, centre: () => [0, 0, 0], radius: 20, eye: () => [0, 0, 40], clearance: 1,
    loopRadius: [0.8, 2.8], loopTime: [2.2, 3.8], braid: 0.12,
  },
  40,
);
const P = generateProducts(pairs, 3);

describe('Undertime collision products', () => {
  it('a track starts where it says, leaves along its direction, and spirals in rather than out', () => {
    for (const T of P.tracks.slice(0, 300)) {
      expect(len(sub(trackPoint(T, 0), T.start))).toBeLessThan(1e-9);
      const t0 = trackTangent(T, 0);
      const d0 = [T.dir[0] + T.normal[0] * T.pitch, T.dir[1] + T.normal[1] * T.pitch, T.dir[2] + T.normal[2] * T.pitch] as Vec3;
      expect(dot(t0, d0) / len(d0)).toBeCloseTo(1, 6);
      // the radius of curvature only shrinks: the path never gets further across the field from its spiral's centre
      // than its starting radius
      if (T.curl > 0.05 && T.radius < 50) {
        const side = cross(T.normal, T.dir).map((x) => x * T.q) as Vec3;
        const c = [T.start[0] + side[0] * T.radius, T.start[1] + side[1] * T.radius, T.start[2] + side[2] * T.radius] as Vec3;
        for (let f = 0; f <= 1; f += 0.1) {
          const x = sub(trackPoint(T, f), c);
          const across = sub(x, T.normal.map((n) => n * dot(x, T.normal)) as Vec3);
          expect(len(across)).toBeLessThanOrEqual(T.radius * 1.0001);
        }
      }
    }
  });

  it('an annihilation star balances its momentum: its prongs never all fly one way', () => {
    // group prongs by their shared start and time (one star), skipping the kinks (those start on a prong's end)
    const stars = new Map<string, ProductTrack[]>();
    for (const T of P.tracks) {
      if (T.family !== 3 && T.family !== 4) continue;
      const key = `${T.t0.toFixed(6)}|${T.start.map((x) => x.toFixed(4)).join(',')}`;
      stars.set(key, [...(stars.get(key) ?? []), T]);
    }
    let checked = 0;
    for (const prongs of stars.values()) {
      if (prongs.length < 3) continue;
      const dirs = prongs.map((T) => trackTangent(T, 0));
      const mean = dirs.reduce((a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]] as Vec3, [0, 0, 0] as Vec3).map((x) => x / dirs.length) as Vec3;
      // (three random directions average ~0.58 long; balanced, what is left is the field's clamp on a prong that
      // leaves almost along it, productModel.ts charged)
      expect(len(mean)).toBeLessThan(0.35);
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('a kink (a decay in flight) starts exactly where and when a prong ends', () => {
    let kinks = 0;
    for (const M of P.tracks) {
      const parent = P.tracks.find((T) => T !== M && Math.abs(T.t0 + T.life - M.t0) < 1e-9 && len(sub(trackPoint(T, 1), M.start)) < 1e-9);
      if (!parent) continue;
      kinks++;
      // it goes on, turned: not straight on, not back
      const a = trackTangent(parent, 1);
      const b = trackTangent(M, 0);
      expect(dot(a, b)).toBeLessThan(0.99);
      expect(dot(a, b)).toBeGreaterThan(0.3);
    }
    expect(kinks).toBeGreaterThan(5);
  });

  it('delta rays are electrons: matter-coloured, curling in the matter bead\'s sense, sprouting from a bead as it passes', () => {
    const deltas = P.tracks.filter((T) => T.family === MATTER && T.radius < 0.2);
    expect(deltas.length).toBeGreaterThan(20);
    for (const T of deltas) {
      expect(T.q).toBe(1);
      // it starts on one of its pair's beads, at the moment that bead is there
      const e = pairs.find((x) => T.t0 >= x.birth && T.t0 < x.birth + x.loop && [1, -1].some((q) => len(sub(loopPoint(x, q, (T.t0 - x.birth) / x.loop), T.start)) < 1e-6));
      expect(e).toBeDefined();
      // in the chamber's field for that pair (the loop plane's normal)
      const n = cross(e!.axis, e!.across);
      expect(Math.abs(dot(n, T.normal))).toBeCloseTo(1, 6);
    }
  });

  it('a gamma converts into a pair pointing on along its way, and only once the light could have got there', () => {
    expect(P.conversions.length).toBeGreaterThan(10);
    for (const c of P.conversions) {
      const parent = pairs.find((e) => {
        const ends = e.meets ? [meetingPoint(e)] : [endPoint(e, 1), endPoint(e, -1)];
        return ends.some((at) => {
          const v = sub(c.vertex, at);
          const L = len(v);
          return Math.abs(Math.abs(dot(v, e.gamma)) - L) < 1e-6 && Math.abs(c.birth - (e.birth + e.loop * e.end) - L / PHOTON_SPEED) < 1e-6;
        });
      });
      expect(parent).toBeDefined();
      // the V opens along the photon's momentum
      expect(Math.abs(dot(c.axis, parent!.gamma))).toBeCloseTo(1, 6);
      // too faint to draw rays of its own (loops.ts rayKept)
      expect(c.energy).toBeLessThan(0.45);
    }
  });

  it('a jet throws its fan forward, with both charges, fast tracks straighter than slow ones', () => {
    const r = rng(5);
    const beam: Vec3 = [0, 0, -1];
    for (let k = 0; k < 20; k++) {
      const J = jet(10, [0, 0, 0], beam, 0.8, r);
      const fan = J.tracks.filter((T) => T.t0 === 10 && T.family !== 2 && T.radius < 100);
      expect(fan.length).toBeGreaterThanOrEqual(6);
      expect(new Set(fan.map((T) => T.q)).size).toBe(2);
      const forward = fan.filter((T) => dot(trackTangent(T, 0), beam) > 0.5).length;
      expect(forward / fan.length).toBeGreaterThan(0.8);
      const byR = [...fan].sort((a, b) => a.radius - b.radius);
      expect(byR[0].curl).toBeGreaterThan(byR[byR.length - 1].curl);
    }
  });
});

describe('Undertime act events and the light wave', () => {
  const act = undertimeEvents(p, () => ({ lo: 0, hi: 0, az: 0, strength: 0 }));
  const b = domeBasis(p.domeTilt);
  const eyeW = eyePath(starts.wave, p);
  const cut = (at: Vec3): number => starts.wave + waveTimeAt(frontFracCpu(sub(at, eyeW), b.front), p.waveStall) * p.wave;
  // the front's own events are born ON it (a hair before it reaches them); everything else must be born ahead of it
  const onFront = (e: PairEvent): boolean => e.birth >= starts.wave && Math.abs(e.birth + 0.05 - cut(e.vertex)) < 0.1;

  it('nothing is born behind the front, and nothing it catches lives on past it', () => {
    for (const e of act.events) {
      if (onFront(e)) continue;
      expect(e.birth).toBeLessThan(cut(e.vertex) + 1e-9);
      expect(e.birth + e.loop * e.end).toBeLessThanOrEqual(cut(e.vertex) + 1e-6);
    }
  });

  it('the build gathers its births low in front, where the front will rise, and quickens', () => {
    const t0 = starts.wave - p.waveBuild;
    // the calm: the cooling once it has settled (its rate falls fast, then holds at a few pairs a second)
    const early = act.events.filter((e) => e.birth > starts.cool + 9 && e.birth < t0);
    const built = act.events.filter((e) => e.birth > t0 + p.waveBuild * 0.5 && e.birth < starts.wave);
    // more births per second in the build's second half than in the calm before it
    expect(built.length / (p.waveBuild * 0.5)).toBeGreaterThan((2.5 * early.length) / (t0 - starts.cool - 9));
    // and they sit in front: most within 60° of the dome front
    const front = built.filter((e) => {
      const v = sub(e.vertex, eyePath(e.birth, p));
      return dot(v, b.front) / len(v) > Math.cos((60 * Math.PI) / 180);
    });
    expect(front.length / built.length).toBeGreaterThan(0.6);
    // and run quicker than the cooling's loops (medians: the cooling's own few slow pairs go on through the build)
    const median = (l: PairEvent[]): number => [...l].sort((a, c) => a.loop - c.loop)[Math.floor(l.length / 2)].loop;
    expect(median(built)).toBeLessThan(0.5 * median(early));
  });

  it('the hero\'s first light cascades: its gammas make the first new pairs before the arising', () => {
    const hero = act.events[0];
    const heroEnd = hero.birth + hero.loop;
    const firsts = act.events.filter((e) => e.birth > heroEnd && e.birth < starts.arise);
    expect(firsts.length).toBe(2);
  });
});

describe('Undertime light wave front', () => {
  it('is ragged (not a wipe) but never strays more than RAG from its circle', () => {
    const r = rng(17);
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < 4000; k++) {
      const z = r() * 2 - 1;
      const a = r() * Math.PI * 2;
      const s = Math.sqrt(1 - z * z);
      const g = frontRagCpu([s * Math.cos(a), z, s * Math.sin(a)]);
      lo = Math.min(lo, g);
      hi = Math.max(hi, g);
    }
    expect(hi).toBeLessThanOrEqual(RAG + 1e-12);
    expect(lo).toBeGreaterThanOrEqual(-RAG - 1e-12);
    // and it really is ragged: a fifth of its range at least either way
    expect(hi - lo).toBeGreaterThan(RAG * 0.8);
  });

  it('reaches the dome front first and the back last', () => {
    const b = domeBasis(p.domeTilt);
    const back: Vec3 = [-b.front[0], -b.front[1], -b.front[2]];
    expect(frontFracCpu(b.front, b.front)).toBeLessThan(RAG + 1e-9);
    expect(frontFracCpu(back, b.front)).toBeGreaterThan(1 - RAG - 1e-9);
    expect(frontFracCpu(b.axis, b.front)).toBeCloseTo(0.5, 1);
  });
});

/**
 * The one in a billion (the 2026-10-30 story note: "the big explosion of things that ultimately leaves only … the ONE
 * BILLIONTH — is not fully clear yet"; since the 2026-11-01 note, ONE: the hero grain). The front must visibly LEAVE them: few against the thousands it spends, spread
 * over the sky rather than in a clump, each coming to rest after the front has passed where it rests (it outran the
 * light), and the hero's run ending on the hero grain just as the grain comes up.
 */
describe('Undertime survivors', () => {
  const act = undertimeEvents(p, () => ({ lo: 0, hi: 0, az: 0, strength: 0 }));
  const b = domeBasis(p.domeTilt);
  const eyeW = eyePath(starts.wave, p);
  const runs = act.tracks.filter((T) => T.family === SURVIVOR);

  it('is ONE: the hero grain alone remains (the 2026-11-01 note: "I liked this better when it really was just one")', () => {
    expect(p.survivors).toBe(0);
    expect(act.rests.length).toBe(0);
    // the hero's run is the only survivor's run: the one moving line on the dome as the front leaves
    expect(runs.length).toBe(1);
  });

  it('when there are more (a non-zero `survivors`), they are spread over the sky and outrun the light', () => {
    const more = undertimeEvents({ ...p, survivors: 16 }, () => ({ lo: 0, hi: 0, az: 0, strength: 0 }));
    const spentOnFront = more.events.filter((e) => e.birth > starts.wave - p.waveBuild).length;
    expect(more.rests.length).toBeGreaterThan(5);
    expect(more.rests.length).toBeLessThanOrEqual(16);
    expect(more.rests.length * 50).toBeLessThan(spentOnFront);
    const dirs = more.rests.map((s) => {
      const v = sub(s.rest, eyeW);
      return v.map((x) => x / len(v)) as Vec3;
    });
    let closest = 1;
    dirs.forEach((a, i) => dirs.forEach((c, j) => {
      if (i < j) closest = Math.min(closest, Math.acos(Math.min(1, dot(a, c))));
    }));
    expect(closest).toBeGreaterThan((6 * Math.PI) / 180);
    for (const d of dirs) expect(dot(d, b.axis)).toBeGreaterThan(0);
    for (const s of more.rests) {
      const cut = starts.wave + waveTimeAt(frontFracCpu(sub(s.rest, eyeW), b.front), p.waveStall) * p.wave;
      expect(s.at).toBeGreaterThan(cut - 0.3);
      expect(s.at).toBeLessThan(starts.wave + p.wave + 1);
    }
  });

  it("the hero's run starts as the front passes and ends on the hero grain as the grain comes up", () => {
    const hero = runs[runs.length - 1];
    expect(len(sub(trackPoint(hero, 1), heroGrainPosition(p)))).toBeLessThan(1e-6);
    expect(hero.t0).toBeCloseTo(heroPassTime(p), 9);
    expect(hero.life).toBeCloseTo(HERO_RUN, 9);
    const end = hero.t0 + hero.life;
    expect(undertimeState(end - HERO_RUN * 0.3, p).heroGrain).toBeLessThan(0.05);
    expect(undertimeState(end + 0.6, p).heroGrain).toBeGreaterThan(0.9);
  });
});
