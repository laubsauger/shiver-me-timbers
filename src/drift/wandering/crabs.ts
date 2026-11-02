/**
 * GHOST CRABS ON THE WALK BEACH (params/drift.ts beachCrabs, default off). The user, 2026-11-02, after the spine
 * review: the film should "feel more alive … without adding a whole lot of actual action, make it more interesting to
 * look at", and "a walking crab on the beach once they land could be interesting".
 *
 * WHAT THEY DO, every frame a pure function of the sea's clock (the show's rule):
 *   - THE ONE (w3, the golden-hour hold on the open beach, ~612–630 show s — the beat where nothing else happens since
 *     the field by day went): it comes up out of its burrow 12–13 m ahead of the eye, eyes first, looks about,
 *     scuttles sideways down the beach to the wet sand in two runs with a pause between, stops, raises its claws, waits
 *     at the edge of the water, and as the next run-up comes at it dashes back up to its burrow and is gone; a few
 *     seconds later its eyes come up out of the hole again (the gag), and go back down.
 *   - A FEW AT THE WATERLINE (w4–w5, ~654–688 s): five come out of their burrows on the upper beach through the score's
 *     silence, go down to the swash and run in and out with it — down after the backwash, back up ahead of each run-up
 *     — and scatter as the first of the wanderers comes up the beach toward them: three back to their burrows, two
 *     into the water.
 * A ghost crab's own rhythm (Ocypode: pale, sand-coloured, eyes on tall stalks, the fastest crab there is): runs of a
 * second or less at 1.5–2.5 m/s, sideways, with dead stops between; it faces where it looks and runs across that.
 *
 * READ THE WATER, NOT A GUESS OF IT: where the swash's front is at t comes from the sim's own scheme (swashSim.ts
 * stepSwashCpu, the CPU reference its GPU kernel transliterates) on a strip across the beach at the crabs' place along
 * it — the same bed, the same incoming waves (swashForcing), the same 10 cm cells and substeps — warmed from rest
 * FRONT_WARM s before each window the crabs need it in, its front (the landward end of the water connected to the sea)
 * sampled every frame. The crabs' plan reads it ahead: a crab picks where it goes next from where the water will be
 * over the coming second, so it is never under the water it is running from. It is not the GPU's 2D water exactly
 * (that one has the alongshore flow, and its warm start differs per render lane), so every crab keeps a margin of
 * 0.5 m and more.
 *
 * SIZE AND WHERE IT READS (the 2026-11-02 brief: "a crab 5 cm across at 10+ m is sub-pixel"): the eye stands 1.6 m
 * over the upper beach, ~2.2 m over the wet sand, and the Horizon 18 dome's tilt and the row-8 seat's view (pitch 24°,
 * 136° wide) leave only the sand from ~12 m ahead outward in frame — the bottom 1–4 % of the seat view. There a crab
 * of 6 cm with its legs (15 cm across) spans 9–11 px of a 3840 seat view (4–6 px of the 1920 share copy, 8–10 px of a
 * 2048 master). The geometry cannot carry that, so the MOTION does — the darts and dead stops (the dolphin's and the
 * birds' approach: outline and motion first, docs/drift/WORKING-NOTES.md) — and so does the low Sun: a crab 4.5 cm
 * tall throws a shadow 0.5–1.5 m long at a Sun 2–5° up, 3–8° of the view, the thing that reads first.
 *
 * Beach coordinates as beats.ts: `along` up the beach (−z), `off` out to sea (−x); x = beach.x − off, z = beach.z −
 * along. Metres and seconds; times on the sea's clock (show s − 314) unless said.
 */
import * as THREE from 'three/webgpu';
import { Fn, abs, attribute, cos, exp, float, instancedBufferAttribute, max, select, sin, smoothstep, uv, vec3, vec4 } from 'three/tsl';
import type { BeatName } from './beats';
import { wanderer, wetSand } from './props';
import { SWASH, SWASH_DT, stepSwashCpu, swashAtRest, type SwashGrid } from './swashSim';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

// ---------------------------------------------------------------------------------------------------------------
// THE WATER'S FRONT
// ---------------------------------------------------------------------------------------------------------------

/** s the strip is run from rest before the first frame it is read at (the swash forgets its start within a period or
 * two: tests/swashSim.test.ts, THE SEAM) */
export const FRONT_WARM = 10;
/** m: water this deep is water to a crab (and to the eye: the swash sheet reads from a few mm) */
const FRONT_DEPTH = 0.003;
/** m: the strip's landward end, `off` (beach coordinates): past the highest run-up (~−4 m on our beach) the cells
 * never wet, and stepping them is a quarter of the work */
const STRIP_LAND = -6.5;

export interface SwashFront {
  /** sea s of the first sample, s between samples (one frame at 30 fps: the GPU sim's chunk) */
  t0: number;
  dt: number;
  /** `off` (m, beach coordinates) of the water's landward edge at each sample: the sand landward of it is dry */
  off: Float32Array;
}

/**
 * The swash's front at `along` (m up the beach) from sea time `from` to `to`, on a strip of the sim's own cells across
 * the beach (one row: its ends open, so no flow along it), run from rest FRONT_WARM s before `from`.
 */
export function swashFront(ground: (x: number, z: number) => number, beach: { x: number; z: number }, along: number, from: number, to: number): SwashFront {
  const dx = SWASH.cell;
  const nx = Math.round((-SWASH.x0 - STRIP_LAND) / dx);
  // (cell i's centre: x = beach.x + SWASH.x0 + (i + ½)·dx, i = 0 at the seaward edge — the sim's own layout, its core
  // rows unshifted: the crabs' stretch, along 15–30 m, lies in the core)
  const x0 = beach.x + SWASH.x0;
  const z = beach.z - along;
  const bed = new Float64Array(nx);
  for (let i = 0; i < nx; i++) bed[i] = ground(x0 + (i + 0.5) * dx, z);
  let a: SwashGrid = swashAtRest(nx, 1, dx, bed);
  let b: SwashGrid = swashAtRest(nx, 1, dx, bed);
  // (the forcing's place along: m from the beach's middle, world z — as the sim's rows' zc)
  a.zc = b.zc = Float64Array.of(z - beach.z);
  const per = 1 / 30;
  const start = from - FRONT_WARM;
  const steps = Math.round(per / SWASH_DT);
  const n = Math.ceil((to - from) / per) + 1;
  const off = new Float32Array(n);
  let k = 0;
  for (let c = 0; k < n; c++) {
    const t = start + c * per;
    if (t >= from - 1e-9) {
      // the landward end of the water joined to the sea (a puddle left on the face is not the swash)
      let i = 0;
      while (i < nx && a.h[i] > FRONT_DEPTH) i++;
      off[k++] = -(SWASH.x0 + i * dx);
    }
    for (let s = 0; s < steps; s++) {
      stepSwashCpu(a, b, t + s * SWASH_DT, SWASH_DT, { seaward: 'generate', ends: 'open', friction: true, infiltration: true });
      [a, b] = [b, a];
    }
  }
  return { t0: from, dt: per, off };
}

/** the front's `off` at sea time t (held at its ends) */
export function frontAt(f: SwashFront, t: number): number {
  const u = Math.min(f.off.length - 1, Math.max(0, (t - f.t0) / f.dt));
  const i = Math.min(f.off.length - 2, Math.floor(u));
  return f.off[i] + (f.off[i + 1] - f.off[i]) * (u - i);
}
/** the most landward the front reaches over [a, b] (the smallest `off`) */
function frontReach(f: SwashFront, a: number, b: number): number {
  let m = Infinity;
  for (let t = a; t <= b; t += f.dt) m = Math.min(m, frontAt(f, t));
  return Math.min(m, frontAt(f, b));
}

// ---------------------------------------------------------------------------------------------------------------
// THE PLAN: each crab a track of runs, stops and its poses, made once from the water's front and the wanderers'
// walk (both pure in t), then read at t
// ---------------------------------------------------------------------------------------------------------------

/** m a leg cycle carries the crab, as drawn: a ghost crab's legs cycle ~10+ Hz at a run, which would alias at 30 fps;
 * drawn at ~5 Hz at 2 m/s they read as legs going, not as a strobe (the flock's wingbeat, flock.ts) */
const STRIDE = 0.4;
/** m below the sand a crab is out of sight (its eye stalks' tips are 6 cm up), and where only its eyes show */
const HIDDEN = 0.075;
const PEEK = 0.045;
/** s a run takes to reach its speed and to stop (a ghost crab's stops are dead stops) */
const RAMP = 0.12;
/** m: the nearest a crab lets the water's front come (its margin, landward of it), per crab of the group */
const MARGIN: [number, number] = [0.5, 1.0];
/** m: a crab of the group runs when a wanderer comes this near (ghost crabs bolt at 5–10 m from a person) */
// (8–10 m, not 5.5–7: at 5.5–7 the first wanderer came near them at 687–691 s, as the eye was already rising out of
// the frame's reach of the near sand; at 8–10 they go at ~684.5 s, before it does)
const FLEE: [number, number] = [8.0, 10.0];
/** s after the first of the group bolts the others go (each its own) */
const ALARM: [number, number] = [0.15, 0.6];

interface Run {
  t0: number;
  t1: number;
  a0: number;
  o0: number;
  a1: number;
  o1: number;
  /** m walked before this run */
  walked: number;
}
interface Key {
  t: number;
  v: number;
}
export interface CrabTrack {
  /** where it starts (along, off m) and its runs, in time order, none overlapping */
  start: { along: number; off: number };
  runs: Run[];
  /** its burrow (along, off m; null: none), drawn as a dark hole while the crab is about */
  burrow: { along: number; off: number } | null;
  /** keyed channels, eased between keys (held past their ends): m below the sand, claws raised 0..1, eyes up 0..1,
   * and its facing (rad about y: 0 faces +z, toward the eye's side of the beach — we see its eyes and its claws) */
  sink: Key[];
  claws: Key[];
  eyes: Key[];
  facing: Key[];
  /** sea s it is drawn over */
  from: number;
  to: number;
}

const smooth = (x: number): number => {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
};
/** a seeded generator (the plan the same on every machine, every lane) */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

/** the share of a run's way covered at u (0..1) of its time: a trapezoid of speed, RAMP s up and down */
function runShare(u: number, len: number): number {
  const r = Math.min(0.45, RAMP / Math.max(len, 1e-3));
  const top = 1 / (1 - r);
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  if (u < r) return (0.5 * top * u * u) / r;
  if (u > 1 - r) return 1 - (0.5 * top * (1 - u) * (1 - u)) / r;
  return 0.5 * top * r + top * (u - r);
}

/** a keyed channel at t: eased (smoothstep) from each key to the next, held past the ends */
function channel(keys: Key[], t: number): number {
  if (keys.length === 0) return 0;
  if (t <= keys[0].t) return keys[0].v;
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) return keys[i - 1].v + (keys[i].v - keys[i - 1].v) * smooth((t - keys[i - 1].t) / Math.max(1e-6, keys[i].t - keys[i - 1].t));
  }
  return keys[keys.length - 1].v;
}

export interface CrabPose {
  along: number;
  off: number;
  /** m/s now (beach coordinates), and the leg cycles walked */
  speed: number;
  phase: number;
  sink: number;
  claws: number;
  eyes: number;
  facing: number;
  /** drawn at all (inside its span and not wholly under the sand) */
  shown: boolean;
}

/** crab `c` at sea time t: a pure function of its track */
export function crabPose(c: CrabTrack, t: number): CrabPose {
  let along = c.start.along;
  let off = c.start.off;
  let walked = 0;
  let speed = 0;
  for (const r of c.runs) {
    if (t < r.t0) break;
    const len = Math.hypot(r.a1 - r.a0, r.o1 - r.o0);
    const dur = r.t1 - r.t0;
    const u = Math.min(1, (t - r.t0) / dur);
    const k = runShare(u, dur);
    along = r.a0 + (r.a1 - r.a0) * k;
    off = r.o0 + (r.o1 - r.o0) * k;
    walked = r.walked + len * k;
    if (u < 1) {
      const e = 1e-3;
      speed = (len * (runShare(Math.min(1, u + e), dur) - runShare(Math.max(0, u - e), dur))) / (2 * e * dur);
    }
  }
  const sink = channel(c.sink, t);
  return {
    along,
    off,
    speed,
    phase: walked / STRIDE,
    sink,
    claws: channel(c.claws, t),
    eyes: channel(c.eyes, t),
    facing: channel(c.facing, t),
    shown: t >= c.from && t <= c.to && sink < HIDDEN,
  };
}

/** a track builder: runs appended one after the other from where the last left it */
class Track {
  readonly c: CrabTrack;
  at: { along: number; off: number };
  t: number;
  walked = 0;
  constructor(t: number, at: { along: number; off: number }, burrow: CrabTrack['burrow']) {
    this.at = { ...at };
    this.t = t;
    this.c = { start: { ...at }, runs: [], burrow, sink: [], claws: [], eyes: [], facing: [{ t, v: 0 }], from: t, to: t };
  }
  /** hold still until sea s `t` */
  hold(t: number): this {
    this.t = Math.max(this.t, t);
    return this;
  }
  /** run to (along, off) at `speed` m/s; returns the time it gets there */
  run(along: number, off: number, speed: number): number {
    const len = Math.hypot(along - this.at.along, off - this.at.off);
    if (len < 1e-3) return this.t;
    // (a trapezoid's time for the way at this top speed, RAMP s up and down)
    const dur = len / speed + RAMP;
    this.c.runs.push({ t0: this.t, t1: this.t + dur, a0: this.at.along, o0: this.at.off, a1: along, o1: off, walked: this.walked });
    this.walked += len;
    this.t += dur;
    this.at = { along, off };
    return this.t;
  }
  key(ch: 'sink' | 'claws' | 'eyes' | 'facing', t: number, v: number): this {
    const keys = this.c[ch];
    // (keys in time order: a key earlier than the last replaces nothing, it waits for it)
    keys.push({ t: Math.max(t, keys.length ? keys[keys.length - 1].t : -Infinity), v });
    return this;
  }
}

/** THE ONE (w3), s into w3 it comes out; its burrow (along, off m): 12–13 m ahead of the eye as w3 holds (along
 * 5–7, off −8), 2.5 m nearer the sea than it */
// (its spot at the edge −2.45 m, not −2.6: with the swash's chop since 2026-11-02 — swashSim.ts SHORT-CRESTED — the
// run-up it runs from turned back 0.9 m short of −2.6, and it ran from water that never came; a step nearer the
// water, the same wave comes on to within 0.75 m of where it stood)
const ONE = { at: 22.5, burrow: { along: 18.5, off: -5.6 }, edge: -2.45 };
/** THE GROUP (w4–w5): their places along (m) and their burrows' `off` (m), s into w4 each comes out */
// (12–16 m ahead of the eye as it holds at along 12: the nearest sand the row-8 seat's view keeps in frame)
const GROUP: Array<{ along: number; burrow: number; out: number; into: 'burrow' | 'sea' }> = [
  { along: 24.1, burrow: -5.0, out: 19.0, into: 'burrow' },
  { along: 25.2, burrow: -4.6, out: 21.5, into: 'sea' },
  { along: 26.0, burrow: -5.6, out: 23.0, into: 'burrow' },
  { along: 27.1, burrow: -4.9, out: 25.5, into: 'burrow' },
  { along: 28.3, burrow: -5.3, out: 27.0, into: 'sea' },
];
/** m along the beach each window's strip is run at (the group's middle, the one's burrow) */
const STRIP_ALONG = { one: ONE.burrow.along + 0.4, group: 26.2 };

export interface CrabPlan {
  crabs: CrabTrack[];
  /** the fronts the plan read (for its tests and its review) */
  fronts: { one: SwashFront; group: SwashFront };
}

/**
 * The crabs' plan for the show (`starts`: the beats' sea s), from the water's front (swashFront) and the wanderers'
 * walk (props.ts wanderer, on the beach's wet-sand line). Deterministic: the same on every machine and lane.
 */
export function crabPlan(ground: (x: number, z: number) => number, beach: { x: number; z: number }, starts: Record<BeatName, number>): CrabPlan {
  const crabs: CrabTrack[] = [];
  // THE ONE: out at ONE.at s into w3; its front read from 3 s later to 22 s later
  const t1 = starts.w3 + ONE.at;
  const one = swashFront(ground, beach, STRIP_ALONG.one, t1 + 3, t1 + 24);
  {
    const b = ONE.burrow;
    const k = new Track(t1, b, b);
    // up out of the sand, eyes first (the stalks stand before the body comes up)
    k.key('sink', t1, HIDDEN + 0.01).key('eyes', t1, 0).key('eyes', t1 + 0.5, 1).key('sink', t1 + 0.3, PEEK).key('sink', t1 + 1.1, 0);
    // a look about: a turn to the right and back while it stands
    k.hold(t1 + 1.6).key('facing', t1 + 1.6, 0).key('facing', t1 + 1.9, 0.35).key('facing', t1 + 2.6, 0.35).key('facing', t1 + 2.9, -0.1);
    // two runs down the beach, sideways, with a dead stop between
    k.hold(t1 + 3.1);
    k.run(b.along + 0.3, -4.3, 1.8);
    k.hold(k.t + 1.4);
    k.run(b.along + 0.5, -3.5, 1.5);
    // claws up at the edge (a ghost crab's display), held, down
    const c0 = k.t + 0.5;
    k.key('claws', c0, 0).key('claws', c0 + 0.35, 1).key('claws', c0 + 1.9, 1).key('claws', c0 + 2.3, 0);
    k.hold(c0 + 2.4);
    // down to the wet sand only while the backwash is out: the first moment the water stays clear of the spot (by
    // 0.9 m) through the run there and a second after
    const runTo = (from: number): number => from + Math.hypot(0.1, ONE.edge + 3.5) / 1.4 + RAMP;
    let go = k.t;
    while (go < one.t0 + (one.off.length - 1) * one.dt - 3 && frontReach(one, go, runTo(go) + 1) < ONE.edge + 0.9) go += 0.1;
    k.hold(go);
    k.run(b.along + 0.6, ONE.edge, 1.4);
    // it waits there until a run-up comes at it: the front advancing and within 1.1 m (or at the strip's end)
    let flee = k.t + 1.2;
    const last = one.t0 + (one.off.length - 1) * one.dt - 1;
    while (flee < last && !(frontAt(one, flee) < ONE.edge + 1.1 && frontAt(one, flee + 0.1) < frontAt(one, flee))) flee += 1 / 30;
    k.hold(flee);
    // and dashes back up to its burrow, and in
    const home = k.run(b.along, b.off, 2.6);
    k.key('sink', home, 0).key('sink', home + 0.35, HIDDEN + 0.01).key('eyes', home + 0.2, 1).key('eyes', home + 0.35, 0);
    // the gag: its eyes come up out of the hole a few seconds later, look, and go down
    const peek = home + 3.4;
    k.key('sink', peek, HIDDEN + 0.01).key('eyes', peek, 0).key('sink', peek + 0.4, PEEK).key('eyes', peek + 0.5, 1);
    k.key('facing', peek + 0.6, -0.1).key('facing', peek + 1.0, 0.4).key('facing', peek + 2.0, 0.4);
    k.key('sink', peek + 2.6, PEEK).key('eyes', peek + 2.6, 1).key('sink', peek + 3.0, HIDDEN + 0.01).key('eyes', peek + 3.0, 0);
    k.c.from = t1 - 0.5;
    k.c.to = peek + 3.2;
    crabs.push(k.c);
  }

  // THE GROUP: out of their burrows through the silence, down to the swash and in and out with it, until a wanderer
  // comes near; the front read from the first one's coming out to w5 + 18 s
  const g0 = starts.w4 + GROUP[0].out;
  const gEnd = starts.w5 + 18;
  const group = swashFront(ground, beach, STRIP_ALONG.group, g0, gEnd);
  const edge = wetSand(ground, beach);
  /** crab i of the group, made to run at sea s `forced` (or when a wanderer is near, if that is first): its track and
   * when it ran */
  const simulate = (i: number, forced: number): { track: CrabTrack; ran: number } => {
    const g = GROUP[i];
    const r = rng(2100 + i * 7919);
    const b = { along: g.along, off: g.burrow };
    const out = starts.w4 + g.out;
    const k = new Track(out, b, b);
    k.key('sink', out, HIDDEN + 0.01).key('eyes', out, 0).key('eyes', out + 0.5, 1).key('sink', out + 0.3, PEEK).key('sink', out + 1.0, 0);
    k.hold(out + 1.4 + r() * 1.2);
    const margin = MARGIN[0] + (MARGIN[1] - MARGIN[0]) * r();
    const fleeAt = FLEE[0] + (FLEE[1] - FLEE[0]) * r();
    // decide, run, stop; again — until a wanderer is near, or the others run
    while (k.t < Math.min(forced, gEnd - 2)) {
      // (is a wanderer within fleeAt of it now?)
      if (k.t > starts.w5 - 1) {
        const near = [0, 1, 2].some((w) => {
          const p = wanderer(w, k.t, starts.w5, edge);
          return Math.hypot(p.along - k.at.along, p.off - k.at.off) < fleeAt;
        });
        if (near) break;
      }
      const wait = 0.8 + r() * 1.4;
      // where the water will reach over the run and the stop after it (a run is under 1.5 s): stay landward of that by
      // the margin — down after the backwash, back up ahead of the run-up — and never more than 4.5 m from its burrow
      const reach = frontReach(group, k.t, k.t + wait + 1.8);
      const want = Math.min(reach - margin, b.off + 4.5);
      const to = { along: g.along + (r() - 0.5) * 1.4, off: Math.max(b.off + 0.3, want) };
      // (up the beach whenever the water would come within the margin; down after it only for 0.3 m or more — a
      // short step down skipped, a short step up kept: skipping those let the run-up come within 0.2 m)
      if (to.off < k.at.off - 0.05 || to.off > k.at.off + 0.3) k.run(to.along, to.off, 1.2 + r() * 1.0);
      else k.key('facing', k.t, (r() - 0.5) * 0.6);
      // (a stop the others' running cuts short)
      k.hold(Math.min(k.t + wait, Math.max(k.t, forced)));
    }
    // the scatter: a dash to the burrow and in, or out into the water and under it
    const ran = k.t;
    if (g.into === 'burrow') {
      const home = k.run(b.along, b.off, 2.4 + r() * 0.4);
      k.key('sink', home, 0).key('sink', home + 0.35, HIDDEN + 0.01).key('eyes', home + 0.2, 1).key('eyes', home + 0.35, 0);
      k.c.to = home + 0.5;
    } else {
      // (into the water: to a metre past where the front will be as it gets there, 4 m at most, and under it)
      const into = Math.min(k.at.off + 4, frontAt(group, ran + 1) + 1.0);
      const wet = k.run(k.at.along - 0.6, into, 2.5);
      k.key('sink', wet, 0).key('sink', wet + 0.5, HIDDEN + 0.01).key('eyes', wet + 0.3, 1).key('eyes', wet + 0.5, 0);
      k.c.to = wet + 0.6;
    }
    k.c.from = out - 0.5;
    return { track: k.c, ran };
  };
  // ONE BOLTS, THEY ALL GO: the first to see a wanderer near runs, and the others run within a few tenths of a second
  // of it (each its own reaction: ALARM), unless one of them has already gone — a group scattering as one, which
  // reads at their size where five separate departures over five seconds would not
  const first = Math.min(...GROUP.map((_, i) => simulate(i, Infinity).ran));
  GROUP.forEach((_, i) => {
    const r = rng(77 + i * 131);
    crabs.push(simulate(i, first + ALARM[0] + (ALARM[1] - ALARM[0]) * r()).track);
  });
  return { crabs, fronts: { one, group } };
}

// ---------------------------------------------------------------------------------------------------------------
// THE MODEL: one merged mesh, its legs, claws and eyes posed in the vertex shader from four numbers a crab
// ---------------------------------------------------------------------------------------------------------------

/** m: the carapace (a ghost crab's is near square, ~5.5 cm, a little wider than long, its front edge straight between
 * the eye sockets), its underside's height when standing, the walking legs' reach out from its side to the foot, the
 * eye stalks' height (Ocypode's eyes are long dark clubs on stalks at the front corners) */
const BODY = { w: 0.056, l: 0.05, h: 0.022, under: 0.024 };
const LEG_REACH = 0.055;
const STALK = 0.02;
/** linear albedos: a ghost crab is the beach's own colour, paler (it hides on the sand by being it — a shade lighter,
 * so it reads against it), its legs paler still, its claws' tips near white, its eyes black */
const SHELL: [number, number, number] = [0.6, 0.53, 0.41];
const LEGS: [number, number, number] = [0.66, 0.6, 0.48];
const CLAW: [number, number, number] = [0.78, 0.74, 0.64];
const EYE: [number, number, number] = [0.025, 0.022, 0.02];

/** a tapered tube from a to b (radius r0 at a, r1 at b), its cross-section flattened by `flat` (1: round) across the
 * plane it lies in with the up axis (a crab's leg segments are flat blades, not rods) */
function segment(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, flat = 1): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r1, r0, len, 8, 1, false);
  g.scale(1, 1, flat);
  g.translate(0, len / 2, 0);
  const dir = b.clone().sub(a).normalize();
  // (the flat side kept facing up-ish: the tube's local z turned toward the world's up as far as the axis allows)
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  const z = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  const want = new THREE.Vector3(0, 1, 0).sub(dir.clone().multiplyScalar(dir.y)).normalize();
  if (want.lengthSq() > 1e-6) {
    const ang = Math.atan2(z.clone().cross(want).dot(dir), z.dot(want));
    q.premultiply(new THREE.Quaternion().setFromAxisAngle(dir, ang));
  }
  g.applyQuaternion(q);
  g.translate(a.x, a.y, a.z);
  return g;
}

/** parts: 0 body, 1 leg, 2 claw, 3 eye; each vertex with its part, its side (−1 left, +1 right), its leg (0–3) and the
 * pivot it turns about (crab's frame: x to its right, y up, z ahead — toward where it looks) */
function crabGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const tag = (g: THREE.BufferGeometry, part: number, side: number, leg: number, pivot: [number, number, number], col: [number, number, number]): void => {
    const n = g.attributes.position.count;
    g.setAttribute('part', new THREE.Float32BufferAttribute(new Array(n).fill(0).flatMap(() => [part, side, leg, 0]), 4));
    g.setAttribute('pivot', new THREE.Float32BufferAttribute(new Array(n).fill(0).flatMap(() => pivot), 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(n).fill(0).flatMap(() => col), 3));
    parts.push(g.index ? g.toNonIndexed() : g);
  };
  const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
  // the carapace: a superellipsoid, near square in plan (wider at the front, where the eyes sit), flat-topped with a
  // low dome, its underside flatter still
  const body = new THREE.SphereGeometry(1, 24, 14);
  {
    const p = body.attributes.position;
    const sq = (v: number, e: number): number => Math.sign(v) * Math.pow(Math.abs(v), e);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const y = p.getY(i);
      const z = p.getZ(i);
      // (a little wider at the front than the back: the trapezoid of a ghost crab's shell seen from above)
      const wide = 1 + 0.08 * z;
      p.setXYZ(i, sq(x, 0.35) * (BODY.w / 2) * wide, BODY.under + BODY.h / 2 + sq(y, 0.7) * (BODY.h / 2) * (y > 0 ? 1 : 0.75), sq(z, 0.4) * (BODY.l / 2));
    }
    body.computeVertexNormals();
  }
  tag(body, 0, 0, 0, [0, 0, 0], SHELL);
  // the walking legs: four a side along the shell's flank from its front corner to its back, each a flat thigh out and
  // up to the knee and a long shin down to the sand, splayed (the front pair reaching forward, the back pair back)
  for (const side of [-1, 1]) {
    for (let k = 0; k < 4; k++) {
      const z = BODY.l * (0.32 - k * 0.21);
      const spread = (1.5 - k) * 0.016;
      const hip: [number, number, number] = [side * BODY.w * 0.46, BODY.under + 0.006, z];
      const knee = V(side * (BODY.w / 2 + LEG_REACH * 0.5), BODY.under + 0.02, z + spread);
      const ankle = V(side * (BODY.w / 2 + LEG_REACH * 0.85), 0.012, z + spread * 1.7);
      const foot = V(side * (BODY.w / 2 + LEG_REACH), 0.0, z + spread * 2.0);
      tag(segment(V(...hip), knee, 0.0042, 0.0034, 0.55), 1, side, k, hip, LEGS);
      tag(segment(knee, ankle, 0.0032, 0.0024, 0.7), 1, side, k, hip, LEGS);
      tag(segment(ankle, foot, 0.0022, 0.0007), 1, side, k, hip, LEGS);
    }
  }
  // the claws: two in front, folded under the front edge, the right one larger (a ghost crab's are unequal): an arm
  // forward and in, a palm, two fingers; raised, they come up in front of the face (THE MODEL's shader)
  for (const side of [-1, 1]) {
    const s = side > 0 ? 1.3 : 0.85;
    const base: [number, number, number] = [side * BODY.w * 0.3, BODY.under + 0.004, BODY.l * 0.42];
    const elbow = V(side * BODY.w * 0.42, BODY.under - 0.002, BODY.l * 0.62);
    const wrist = V(side * BODY.w * 0.2, BODY.under + 0.002, BODY.l * 0.72);
    tag(segment(V(...base), elbow, 0.0035, 0.003, 0.7), 2, side, 0, base, LEGS);
    tag(segment(elbow, wrist, 0.003, 0.0035, 0.7), 2, side, 0, base, LEGS);
    const palm = new THREE.SphereGeometry(1, 12, 8);
    palm.scale(0.0055 * s, 0.0075 * s, 0.009 * s);
    palm.translate(wrist.x - side * 0.004 * s, wrist.y + 0.001, wrist.z + 0.002);
    tag(palm, 2, side, 0, base, CLAW);
    const tip = V(wrist.x - side * 0.012 * s, wrist.y - 0.001, wrist.z + 0.004);
    tag(segment(V(wrist.x - side * 0.008 * s, wrist.y + 0.002, wrist.z + 0.003), tip, 0.0022 * s, 0.0006), 2, side, 0, base, CLAW);
  }
  // the eyes: stalks up from the front corners, each with its long dark club (Ocypode's eye wraps the stalk's upper
  // part); they stand while it is up, fold flat as it goes down
  for (const side of [-1, 1]) {
    const foot: [number, number, number] = [side * BODY.w * 0.36, BODY.under + BODY.h * 0.85, BODY.l * 0.38];
    const top = V(foot[0] + side * 0.002, foot[1] + STALK, foot[2] + 0.002);
    tag(segment(V(...foot), top, 0.0024, 0.002), 3, side, 0, foot, SHELL);
    const club = new THREE.SphereGeometry(1, 12, 10);
    club.scale(0.0036, 0.0075, 0.0036);
    club.translate(top.x, top.y - 0.004, top.z);
    tag(club, 3, side, 0, foot, EYE);
  }
  const merged = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'part', 'pivot', 'color']) {
    const size = parts[0].getAttribute(name).itemSize;
    const all: number[] = [];
    for (const g of parts) all.push(...(g.getAttribute(name).array as Float32Array));
    merged.setAttribute(name, new THREE.Float32BufferAttribute(all, size));
  }
  return merged;
}

/** rotate p about the y axis by a (rad), and about z, and about x */
const rotY = (p: V3, a: F): V3 => vec3(p.x.mul(cos(a)).add(p.z.mul(sin(a))), p.y, p.z.mul(cos(a)).sub(p.x.mul(sin(a)))) as V3;
const rotZ = (p: V3, a: F): V3 => vec3(p.x.mul(cos(a)).sub(p.y.mul(sin(a))), p.x.mul(sin(a)).add(p.y.mul(cos(a))), p.z) as V3;
const rotX = (p: V3, a: F): V3 => vec3(p.x, p.y.mul(cos(a)).sub(p.z.mul(sin(a))), p.y.mul(sin(a)).add(p.z.mul(cos(a)))) as V3;

/** at most this many crabs are drawn (the plan's) */
const MAX_CRABS = 8;

export interface Crabs {
  group: THREE.Group;
  /** pose them for sea time t (`on`: drawn at all); the Sun (unit, world), and the light on a white surface from it
   * and from the sky (linear luminance), for their shadows' darkness */
  update(s: { t: number; on: boolean; sun: THREE.Vector3; sunLum: number; skyLum: number }): void;
  /** the plan, once made (the first update that draws them makes it: ~3 s of swash on the CPU) */
  readonly plan: CrabPlan | null;
}

export function createCrabs(o: { ground: (x: number, z: number) => number; beach: { x: number; z: number }; starts: Record<BeatName, number> }): Crabs {
  const group = new THREE.Group();
  group.name = 'drift-crabs';
  // THE CRABS: one instanced mesh, each instance's place (world x, y, z) and facing (rad about y) in `at`, its pose in
  // `pose` (leg cycles, gait 0..1, claws 0..1, eyes 0..1). Placed in the vertex shader, not by the instance matrices
  // (left identity): three applies an InstancedMesh's matrix BEFORE the material's positionNode, so a leg turned about
  // its hip in the crab's own frame was turned about a point 40 km away and flung out of sight (the first stills: legs
  // and raised claws gone whenever they moved)
  const geo = crabGeometry();
  const pose = new THREE.InstancedBufferAttribute(new Float32Array(MAX_CRABS * 4), 4);
  pose.setUsage(THREE.DynamicDrawUsage);
  const at = new THREE.InstancedBufferAttribute(new Float32Array(MAX_CRABS * 4), 4);
  at.setUsage(THREE.DynamicDrawUsage);
  const P = instancedBufferAttribute(pose, 'vec4') as unknown as THREE.Node<'vec4'>;
  const A = instancedBufferAttribute(at, 'vec4') as unknown as THREE.Node<'vec4'>;
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.65, metalness: 0 });
  mat.colorNode = attribute<'vec3'>('color', 'vec3');
  mat.positionNode = Fn(() => {
    const p = attribute<'vec3'>('position', 'vec3') as unknown as V3;
    const part = attribute<'vec4'>('part', 'vec4');
    const pivot = attribute<'vec3'>('pivot', 'vec3');
    const kind = part.x;
    const side = part.y;
    const rel = p.sub(pivot) as V3;
    // THE LEGS, an alternating gait (each leg out of step with its neighbours and its opposite): lifted about the
    // hip (its tip up and in) through the swing, swept fore and aft — by the gait's share, 0 standing
    const off = part.z.add(select(side.greaterThan(0), float(1), float(0))).mod(2).mul(Math.PI).add(part.z.mul(0.3));
    const ph = P.x.mul(2 * Math.PI).add(off);
    const lift = max(sin(ph), 0).mul(0.6).mul(P.y);
    const sweep = cos(ph).mul(0.35).mul(P.y);
    const leg = pivot.add(rotY(rotZ(rel, lift.mul(side)), sweep)) as V3;
    // THE CLAWS raised (a display, held up and open in front of the face): turned up about their base and out to the
    // side
    const claw = pivot.add(rotZ(rotX(rel, P.z.mul(-1.3)), P.z.mul(side).mul(-0.35))) as V3;
    // THE EYES: the stalks stand (1) or fold flat into their grooves (0)
    const eye = pivot.add(rotX(rel, float(1).sub(P.w).mul(1.35))) as V3;
    const posed = select(kind.lessThan(0.5), p, select(kind.lessThan(1.5), leg, select(kind.lessThan(2.5), claw, eye))) as unknown as V3;
    // (its normals are the rest pose's, unturned: a few degrees off on a thing 10 px across)
    return rotY(posed, A.w).add(A.xyz);
  })();
  mat.name = 'drift-crab';
  const crabs = new THREE.InstancedMesh(geo, mat, MAX_CRABS);
  crabs.frustumCulled = false;
  crabs.castShadow = false;
  crabs.receiveShadow = true;
  crabs.count = 0;
  group.add(crabs);

  // THEIR SHADOWS ON THE SAND, and their burrows: flat quads laid on the slope. A shadow is its contact shade under the
  // body (the sky its body hides) and the Sun's: the legs' thin band from the crab and the body's patch beyond it, out
  // to where the eye stalks' tips fall (`len`, m: their height over tan of the Sun's elevation). The coast's shadow
  // map has ~4 cm texels — a crab's shadow would be one texel wide and crawl — so they are drawn here instead.
  const shade = new THREE.InstancedBufferAttribute(new Float32Array(MAX_CRABS * 2 * 4), 4);
  shade.setUsage(THREE.DynamicDrawUsage);
  const S = instancedBufferAttribute(shade, 'vec4') as unknown as THREE.Node<'vec4'>;
  const quad = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0, 0.5);
  const sm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  sm.polygonOffset = true;
  sm.polygonOffsetFactor = -1;
  sm.colorNode = vec4(0, 0, 0, 1);
  sm.opacityNode = Fn(() => {
    // S = (sun's darkness, its length m, contact darkness, kind: 0 a crab's shadow, 1 a burrow)
    const q = uv();
    // (the quad runs from 0.12 m behind the crab out to `len` along the shadow: m from the crab, and m across)
    const len = S.y;
    const along = q.y.oneMinus().mul(len.add(0.12)).sub(0.12);
    const across = q.x.sub(0.5).mul(0.16);
    // the contact shade: a soft disc under the body (5 cm)
    const contact = exp(along.mul(along).add(across.mul(across)).div(-0.0012)).mul(S.z);
    // the legs' band (to the body's shadow) and the body's patch (its underside's shadow to its top's), thinning
    // and fading toward the eye stalks' tips
    const u = along.div(len.max(0.01));
    const band = smoothstep(0.075, 0.03, abs(across)).mul(smoothstep(-0.02, 0.02, along)).mul(smoothstep(0.55, 0.4, u)).mul(0.45);
    const patch = smoothstep(0.04, 0.02, abs(across).mul(float(1).add(u.mul(0.6)))).mul(smoothstep(0.3, 0.45, u)).mul(smoothstep(1, 0.8, u));
    const sunShade = max(band, patch).mul(S.x);
    // a burrow: a dark hole (2.5 cm), its rim of thrown sand a shade lighter is too small to matter
    const r = across.mul(across).add(along.mul(along)).sqrt();
    const hole = smoothstep(0.03, 0.018, r).mul(0.75);
    return select(S.w.lessThan(0.5), max(contact, sunShade), hole);
  })();
  const shadows = new THREE.InstancedMesh(quad, sm, MAX_CRABS * 2);
  shadows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  shadows.frustumCulled = false;
  // (before the shoreline layer, its renderOrder −0.25, as the wanderers' contact shade: props.ts)
  shadows.renderOrder = -0.3;
  shadows.count = 0;
  group.add(shadows);

  let plan: CrabPlan | null = null;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const Y = new THREE.Vector3(0, 1, 0);
  const turn = new THREE.Quaternion();
  /** the ground's normal at world (x, z) */
  const normal = (x: number, z: number): THREE.Vector3 => {
    const e = 0.2;
    return up.set(o.ground(x - e, z) - o.ground(x + e, z), 2 * e, o.ground(x, z - e) - o.ground(x, z + e)).normalize();
  };
  /** lay a shadow quad at (x, z) along heading (rad about y, 0: +z), `len` m long */
  const lay = (i: number, x: number, z: number, heading: number, len: number, data: [number, number, number, number]): void => {
    q.setFromUnitVectors(Y, normal(x, z));
    turn.setFromAxisAngle(Y, heading);
    q.multiply(turn);
    // (3 cm up: near the eye the terrain draws its finest ripples over the analytic ground, and a decal at 1.5 cm went
    // under them in a close review view)
    pos.set(x, o.ground(x, z) + 0.03, z);
    // (the quad's own z runs 0..1: scaled to the shadow's length and the 12 cm behind the crab; it starts 12 cm back)
    const back = 0.12;
    const l = len + back;
    pos.addScaledVector(new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading)), -back);
    scl.set(0.16, 1, l);
    m.compose(pos, q, scl);
    shadows.setMatrixAt(i, m);
    shade.setXYZW(i, data[0], len, data[2], data[3]);
  };

  return {
    group,
    get plan() {
      return plan;
    },
    update(s) {
      const on = s.on;
      group.visible = on;
      if (!on) return;
      if (!plan) plan = crabPlan(o.ground, o.beach, o.starts);
      // the Sun's share of the sand's light (what its shadow takes away) and its shadows' length (eye stalks' tips
      // 6 cm up), fading out as the Sun goes down (no shadow past the dusk)
      const el = Math.asin(Math.max(-1, Math.min(1, s.sun.y)));
      const direct = s.sunLum * Math.max(0, Math.sin(el));
      const sunDark = (0.85 * direct) / (direct + s.skyLum + 1e-6);
      const len = Math.min(1.8, 0.06 / Math.max(Math.tan(el), 0.033));
      const away = Math.atan2(-s.sun.x, -s.sun.z);
      let n = 0;
      let ns = 0;
      for (const c of plan.crabs) {
        if (s.t < c.from || s.t > c.to) continue;
        if (c.burrow && ns < MAX_CRABS * 2) lay(ns++, o.beach.x - c.burrow.off, o.beach.z - c.burrow.along, 0, 0.05, [0, 0, 0, 1]);
        const p = crabPose(c, s.t);
        if (!p.shown || n >= MAX_CRABS) continue;
        const x = o.beach.x - p.off;
        const z = o.beach.z - p.along;
        // stood on the slope (tilted to it), facing its way, down into the sand by `sink`; a bob as it runs
        const bob = 0.003 * Math.abs(Math.sin(Math.PI * 2 * p.phase)) * Math.min(1, p.speed / 1.5);
        // (not tilted to the slope: the beach's 1:12 is 5°, a millimetre or two at a foot)
        at.setXYZW(n, x, o.ground(x, z) - p.sink + bob, z, p.facing);
        pose.setXYZW(n, p.phase, Math.min(1, p.speed / 0.6), p.claws, p.eyes);
        // its shadow, as much of it as is above the sand
        const above = Math.max(0, 1 - p.sink / 0.05);
        if (ns < MAX_CRABS * 2) lay(ns++, x, z, away, len * above, [sunDark * above, 0, 0.35 * above, 0]);
        n++;
      }
      crabs.count = n;
      shadows.count = ns;
      shadows.instanceMatrix.needsUpdate = true;
      at.needsUpdate = true;
      pose.needsUpdate = true;
      shade.needsUpdate = true;
    },
  };
}

/** the crabs' world placement uses only these: kept here so the module's tests can read what the eye sees */
export const CRAB_SIZE = { span: BODY.w + 2 * LEG_REACH, body: BODY.w, height: BODY.under + BODY.h + STALK + 0.006 };
