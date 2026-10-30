/**
 * Undertime's EVENT GRAMMAR (drift-narrative/production-design.md): light makes matter, matter makes light.
 *
 *   creation      two photons — thin, intensely bright streaks — meet at a vertex and burst; a matter bead
 *                 (amber) and an antimatter bead (cyan-violet) leave it in a V
 *   the path      each bead curves away from the V's axis, the two as mirror images, slowing as they go.
 *                 Three shapes, so the field is never one figure repeated:
 *                   LOOP    all the way round and back: the loops close on the axis, where the beads MEET
 *                   HELIX   the same loop drawn out into depth along the plane's normal (a corkscrew); they
 *                           still meet, the drift being shared
 *                   SPIRAL  the classic bubble-chamber pair: each spirals inward, turning faster as it loses
 *                           energy, and annihilates at its own end, with the medium (two flashes, not one)
 *                   BRAID   (Act 1, `braid` in EventOptions) a BOUND pair — positronium — orbiting its own centre
 *                           as the centre travels along the axis: two strands, amber and violet, wound round each
 *                           other, the orbit opening from the vertex and closing where they meet. Seen from the
 *                           side the strands cross and recross like interference fringes (the 2026-10-30 review
 *                           asked for "more interesting shapes")
 *   annihilation  a flash that lights the medium around it, and gamma rays shooting out
 *
 * Every event is generated here, once, from a seed (CPU): a list of pairs with their birth time and
 * geometry. Positions at any time are closed-form functions of that record (loopPoint), evaluated the same
 * way on the GPU (loops.ts) and here (the brightest events of a frame light the plasma, plasma.ts). So
 * every frame renders on its own, and re-rendering frame 412 gives frame 412.
 */
import type { Vec3 } from '../../cine/domeMaster';
import { rng } from './web';

export interface PairEvent {
  /** act s the photons meet */
  birth: number;
  /** s the loop takes, birth to annihilation */
  loop: number;
  vertex: Vec3;
  /** unit: the V's axis (the photons' momentum, shared by the pair) */
  axis: Vec3;
  /** unit: across the axis, in the loop plane (the photons come in along ±this) */
  across: Vec3;
  /** rad, each bead leaves this far off the axis */
  open: number;
  /** m, the loops' radius */
  radius: number;
  /** 0..1 light: how bright its creation, beads and annihilation are */
  energy: number;
  /** unit: the gamma rays' direction (±) */
  gamma: Vec3;
  /** shape: 1/rad radius decay per turned angle (0 = a circle; > 0 spirals in) */
  spiral: number;
  /** m the path drifts along the plane's normal by its end (a helix); shared by both beads */
  drift: number;
  /** rad of turn from vertex to end */
  arc: number;
  /** 1 when the beads meet (loops, helices), 0 when each ends on its own (spirals) */
  meets: number;
  /** m, the creation fireball's size (burst.ts) */
  burst: number;
  /** 0..1 of its loop the pair lives: 1 normally; less when the wave front reaches it first (U3), and then
   * both beads annihilate where they are instead of meeting */
  end: number;
  /** a BRAID: the centre's run along the axis, in loop radii (absent or 0: one of the other shapes). `arc` is then
   * the orbit's total angle */
  braid?: number;
}

/** the `spiral` the GPU sees: a braid rides in it as −braid (loops.ts arcPoint; WebGPU's 8 vertex buffers are spent) */
export const packedSpiral = (e: Pick<PairEvent, 'spiral' | 'braid'>): number => (e.braid ? -e.braid : e.spiral);

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3, k = 1): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** the arc a LOOP sweeps: from leaving the vertex to meeting its partner on the axis behind it */
export const loopArc = (open: number): number => 2 * Math.PI - 2 * open;

type PathEvent = Pick<PairEvent, 'vertex' | 'axis' | 'across' | 'open' | 'radius' | 'spiral' | 'drift' | 'arc' | 'braid'>;

/** 0..1 how far round its loop a bead is at loop progress u (it slows as it goes, still moving when they meet) */
export const loopEase = (u: number): number => {
  const k = Math.min(1, Math.max(0, u));
  return (1 - Math.pow(1 - k, 1.7)) * 0.85 + k * 0.15;
};

/**
 * Where bead q (+1 matter, −1 antimatter) is at loop progress u ∈ [0, 1]. In the loop plane (x along the
 * axis, y across it) the matter bead leaves at angle +open and turns left about a centre one radius away,
 * the radius shrinking as e^(−spiral·φ) for a spiral; the antimatter bead is its mirror image (y → −y),
 * so a loop's two beads reach its axis crossing together. Both drift along the plane's normal by `drift`.
 */
export function loopPoint(e: PathEvent, q: number, u: number): Vec3 {
  const f = loopEase(u);
  if (e.braid) return braidPoint(e, q, f);
  const phi = e.arc * f;
  const theta0 = e.open - Math.PI / 2;
  const r = e.radius * Math.exp(-e.spiral * phi);
  const cx = -e.radius * Math.sin(e.open);
  const cy = e.radius * Math.cos(e.open);
  const x = cx + r * Math.cos(theta0 + phi);
  const y = (cy + r * Math.sin(theta0 + phi)) * q;
  const z = (e.drift * (1 - Math.cos(Math.PI * f))) / 2;
  const n = cross(e.axis, e.across);
  return add(add(add(e.vertex, e.axis, x), e.across, y), n, z);
}

/**
 * A BRAID's bead q at arc fraction f: the centre `braid` radii along the axis by the end, the two on opposite sides
 * of it (q·ρ), the orbit radius ρ opening from 0 at the vertex to half a loop radius and closing to 0 where they meet
 * (sin(πf)^0.6: they part quickly, as a V does, and close more slowly). loops.ts arcPoint is the GPU twin.
 */
export function braidPoint(e: PathEvent, q: number, f: number): Vec3 {
  const k = Math.min(1, Math.max(0, f));
  const phi = e.arc * k;
  const rho = e.radius * 0.5 * Math.pow(Math.max(0, Math.sin(Math.PI * k)), 0.6) * q;
  const n = cross(e.axis, e.across);
  const c = add(e.vertex, e.axis, e.radius * (e.braid ?? 0) * k);
  return add(add(c, e.across, rho * Math.cos(phi)), n, rho * Math.sin(phi));
}

/** where bead q ends: for a loop or helix both end at the same point (where they meet) */
export const endPoint = (e: PairEvent, q: number): Vec3 => loopPoint(e, q, e.end);
/** where a loop's beads meet */
export const meetingPoint = (e: PairEvent): Vec3 => endPoint(e, 1);

function perpendicular(d: Vec3, r: () => number): Vec3 {
  const t: Vec3 = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm(cross(d, t));
  const w = cross(d, u);
  const a = r() * Math.PI * 2;
  return norm(add([u[0] * Math.cos(a), u[1] * Math.cos(a), u[2] * Math.cos(a)], w, Math.sin(a)));
}

function randomUnit(r: () => number): Vec3 {
  const z = r() * 2 - 1;
  const a = r() * Math.PI * 2;
  const s = Math.sqrt(1 - z * z);
  return [s * Math.cos(a), z, s * Math.sin(a)];
}

export interface EventOptions {
  seed: number;
  /** pairs per second at act time t (the arising, the boil, the cooling) */
  rate: (t: number) => number;
  from: number;
  to: number;
  /** where pairs are born: a ball around this, m */
  centre: (t: number) => Vec3;
  radius: number;
  /** never closer than this to `eye(t)` (a loop across the audience is a smear over half the dome) */
  eye: (t: number) => Vec3;
  clearance: number;
  /** loop size and duration ranges */
  loopRadius: [number, number];
  loopTime: [number, number];
  /** Act 1: the fraction of pairs born as BRAIDS (taken from the loops; absent: none, and the pairs are exactly
   * the ones they were — Act 3's field calls this too) */
  braid?: number;
  /** Act 1: added to every pair's energy draw (0..1 after it), for a phase whose pairs run hotter (the build) */
  energyBias?: number;
}

/**
 * The field's pairs: births as a Poisson process of the given rate (thinned from a constant-rate stream, so
 * changing the rate curve never reshuffles the pairs born where it did not change), each placed and oriented
 * at random.
 */
export function generatePairs(o: EventOptions, peakRate: number): PairEvent[] {
  const r = rng(o.seed);
  const out: PairEvent[] = [];
  let t = o.from;
  while (t < o.to) {
    t += -Math.log(Math.max(1e-9, r())) / peakRate;
    const keep = r();
    const pos = r();
    const orient = randomUnit(r);
    const spin = r();
    const size = r();
    const dur = r();
    const open = r();
    const energy = r();
    const gam = r();
    if (keep > o.rate(t) / peakRate) continue;
    const c = o.centre(t);
    const off = randomUnit(r);
    const rr = o.radius * Math.cbrt(pos);
    const vertex = add(c, off, rr);
    if (Math.hypot(...sub(vertex, o.eye(t))) < o.clearance) continue;
    const axis = orient;
    const across = perpendicular(axis, () => spin);
    const openA = 0.2 + 0.45 * open;
    const radius = o.loopRadius[0] + (o.loopRadius[1] - o.loopRadius[0]) * size * size;
    // the shape: 40 % loops, 25 % helices, 35 % spirals (each with its own tightness and number of turns)
    const shape = r();
    const tight = r();
    const isSpiral = shape > 0.65;
    const isHelix = shape > 0.4 && !isSpiral;
    // a braid takes the place of a loop (shape < braid ≤ 0.4); it needs no draws of its own, so a run without
    // braids draws exactly the numbers it always did
    const isBraid = !!o.braid && shape < Math.min(0.4, o.braid);
    const e0 = Math.min(1, energy + (o.energyBias ?? 0));
    if (isBraid) {
      out.push({
        birth: t,
        // a bound pair lives longer than a free loop of its size (it winds 2–3.5 times before it closes: at 4–7 the
        // strands, seen side-on, kinked at every turn at the 2K dome's pixel size — a coil spring, not a rope)
        loop: (o.loopTime[0] + (o.loopTime[1] - o.loopTime[0]) * dur) * 1.5,
        vertex,
        axis,
        across,
        open: openA,
        radius: radius * 0.8,
        energy: 0.35 + 0.65 * e0 * e0,
        gamma: norm(add(cross(axis, across), across, gam - 0.5)),
        spiral: 0,
        drift: 0,
        arc: Math.PI * 2 * (2 + 1.5 * tight),
        meets: 1,
        burst: 0.25 + 0.7 * e0 * e0,
        end: 1,
        braid: 2.2 + 2.4 * size,
      });
      continue;
    }
    out.push({
      birth: t,
      loop: (o.loopTime[0] + (o.loopTime[1] - o.loopTime[0]) * dur) * (isSpiral ? 1.2 : 1),
      vertex,
      axis,
      across,
      open: openA,
      radius,
      energy: 0.35 + 0.65 * e0 * e0,
      gamma: norm(add(cross(axis, across), across, gam - 0.5)),
      spiral: isSpiral ? 0.1 + 0.12 * tight : 0,
      drift: isHelix ? radius * (1.2 + 1.6 * tight) * (gam < 0.5 ? -1 : 1) : 0,
      arc: isSpiral ? Math.PI * (2.6 + 2 * tight) : loopArc(openA),
      meets: isSpiral ? 0 : 1,
      burst: 0.25 + 0.7 * e0 * e0,
      end: 1,
    });
  }
  return out;
}

export interface EventLight {
  pos: Vec3;
  /** linear rgb × intensity */
  colour: Vec3;
}

/** m/s, as loops.ts draws them */
export const PHOTON_SPEED = 38;
const AMBER: Vec3 = [1, 0.62, 0.28];
const VIOLET: Vec3 = [0.45, 0.6, 1];
const WHITE: Vec3 = [1, 0.93, 0.82];

/**
 * The lights the plasma sees at act time t: every live event's creation burst, its two beads and its
 * annihilation flash, scored by how much they would light the medium near the eye, best `k` kept.
 * Distant small events still light the plasma through the bloom; only the strong and near need a light.
 */
export function eventLights(events: readonly PairEvent[], t: number, eye: Vec3, k: number): EventLight[] {
  const cands: Array<EventLight & { score: number }> = [];
  const push = (pos: Vec3, colour: Vec3, power: number): void => {
    if (power <= 1e-4) return;
    const d2 = Math.max(1, dot(sub(pos, eye), sub(pos, eye)));
    cands.push({ pos, colour: [colour[0] * power, colour[1] * power, colour[2] * power], score: power / d2 });
  };
  for (const e of events) {
    const age = t - e.birth;
    if (age < -0.1 || age > e.loop * e.end + 1.2) continue;
    // the creation burst
    // (a light that comes on rises over a few frames; one that goes out decays — never a switch)
    if (age >= 0) push(e.vertex, WHITE, 6 * e.energy * Math.exp(-age / 0.18) * Math.min(1, age / 0.04));
    // the beads, while they fly
    const life = e.loop * e.end;
    const meets = e.meets && e.end >= 1;
    if (age >= 0 && age < life) {
      const u = age / e.loop;
      const on = Math.min(1, age / 0.1, (life - age) / 0.1);
      push(loopPoint(e, 1, u), AMBER, 0.5 * e.energy * on);
      push(loopPoint(e, -1, u), VIOLET, 0.5 * e.energy * on);
    }
    // the annihilation flash: one where a loop's beads meet, one at each end of a spiral
    const since = age - life;
    const ends = meets ? [meetingPoint(e)] : [endPoint(e, 1), endPoint(e, -1)];
    if (since >= 0) for (const p of ends) push(p, WHITE, (14 / ends.length) * e.energy * Math.exp(-since / 0.25) * Math.min(1, since / 0.04));
    // the light rays in flight: photons coming in, gammas going out (they light what they pass)
    if (age > -0.9 && age < 0) {
      const on = Math.min(1, (age + 0.9) / 0.25);
      for (const s of [1, -1]) push(add(e.vertex, e.across, s * PHOTON_SPEED * -age), WHITE, 1.5 * e.energy * on);
    }
    if (since > 0 && since < 1.4) {
      const on = Math.min(1, since / 0.05, (1.4 - since) / 0.4) * Math.exp(-since / 0.7);
      for (const s of [1, -1]) push(add(meets ? ends[0] : ends[s > 0 ? 0 : 1], e.gamma, s * PHOTON_SPEED * since), WHITE, 1.5 * e.energy * on);
    }
  }
  cands.sort((a, b) => b.score - a.score);
  // NO POPS: a light fades out as it drops in rank, reaching zero at the last slot — so when it leaves the
  // list (or a stronger one pushes it out) nothing it lit switches off at once. Scores change smoothly
  // (powers decay continuously), so the weights do too.
  const sTop = cands[Math.floor(k / 2)]?.score ?? 0;
  const sCut = cands[k - 1]?.score ?? 0;
  return cands.slice(0, k).map(({ pos, colour, score }) => {
    const w = sTop > sCut ? Math.min(1, Math.max(0, (score - sCut) / (sTop - sCut))) : 1;
    const ww = w * w * (3 - 2 * w);
    return { pos, colour: [colour[0] * ww, colour[1] * ww, colour[2] * ww] as Vec3 };
  });
}
