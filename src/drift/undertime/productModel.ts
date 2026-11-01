/**
 * WHAT COLLISIONS LEAVE BEHIND — the products of Undertime's events, decided once on the CPU from the event list
 * (events.ts), drawn by products.ts. The 2026-10-30 review: "more interesting shapes that the different particle
 * collisions are doing, and more interesting results of particles". Until now every event made one pair and every
 * annihilation one flash and two gamma rays: the field was the same figure a thousand times. A real bubble-chamber
 * photograph is never that, because collisions have PRODUCTS, and their shapes are the physics:
 *
 *   ANNIHILATION STAR   a proton meeting an antiproton does not just flash: it leaves a star of three to eight
 *                       charged pions, flying apart with their momenta balanced (they never all go one way), each
 *                       curling gently in the chamber's field, the slow ones more. Some prongs DECAY in flight —
 *                       the track kinks and goes on, fainter (π → μ) — a detail every physicist recognises.
 *   DELTA RAYS          a fast track knocks electrons out of the medium as it passes: tiny, tight curls sprouting
 *                       from its side. Electrons are matter, so they are amber even on a violet track.
 *   CONVERSIONS         a gamma ray from an annihilation travels on and, some metres out, turns into a new pair:
 *                       a small V of two tight opposite spirals pointing on along the photon's way. Light makes
 *                       matter again: the cascade production-design.md asked for ("some of them meet other light
 *                       and make new pairs, so events cascade into showers"). These are new PairEvents, drawn by
 *                       loops.ts like every other pair.
 *   JETS                a fast particle comes in and hits the medium: a FAN of tracks out of one vertex, thrown
 *                       forward in a cone, the fast ones nearly straight, the slow ones curling up tight, the two
 *                       charges curling opposite ways — the peacock-tail of a collider's event display. Some carry
 *                       a V0: a neutral that flies unseen and decays a metre or two on into a V of two tracks.
 *
 * Every product track is one closed-form path, a charged particle losing energy in a uniform field: a logarithmic
 * spiral in the plane across the field (radius R₀ shrinking as e^(−k·φ)), drawn out along it by `pitch` (a helix),
 * travelled with a decelerating ease. trackPoint is the CPU twin of products.ts's GPU path.
 *
 * Colours ("a few more shades", the same review): products keep the colour script — matter warm, antimatter cool,
 * light gold-white — with two new shades for the pions, which are neither: rose for the positive, teal for the
 * negative (`productWarm`, `productCool`). Hotter, faster tracks are paler.
 *
 * Deterministic from a seed; the wave and the text cut them on the CPU in field.ts, as they cut the pairs.
 */
import type { Vec3 } from '../../cine/domeMaster';
import { endPoint, loopPoint, meetingPoint, type PairEvent } from './events';
import { rng } from './web';

/** colour families (products.ts) */
export const MATTER = 0;
export const ANTI = 1;
export const LIGHT = 2;
export const ROSE = 3;
export const TEAL = 4;
/** a survivor's run (survivors.ts): matter, and the one thing the front does not spend */
export const SURVIVOR = 5;

export interface ProductTrack {
  /** act s it starts, and s it runs */
  t0: number;
  life: number;
  start: Vec3;
  /** unit, its initial direction across the field (pitch carries the part along it) */
  dir: Vec3;
  /** unit, the field: the axis it curls about */
  normal: Vec3;
  /** m, its initial radius of curvature (its momentum) */
  radius: number;
  /** 1/rad, how fast the radius shrinks per angle turned (energy loss; 0 a circle) */
  curl: number;
  /** rad it turns by its end */
  turn: number;
  /** m along the field per m of arc */
  pitch: number;
  /** ±1, the sense it curls in */
  q: number;
  family: number;
  /** −1..1 within its family: deep → pale */
  shade: number;
  /** 0..1 its light */
  energy: number;
  /** 0..1 a small flash where it stops (a particle that stops and decays), 0 for one that runs out */
  flash: number;
  /** 0..1 of its life it runs: 1 normally, less when the wave's front reaches it first (field.ts) */
  end: number;
}

/** a creation or annihilation fireball (burst.ts reads these four fields of a PairEvent) */
export type Blast = Pick<PairEvent, 'birth' | 'burst' | 'energy' | 'vertex'>;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3, k = 1): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const unit = (r: () => number): Vec3 => {
  const z = r() * 2 - 1;
  const a = r() * Math.PI * 2;
  const s = Math.sqrt(1 - z * z);
  return [s * Math.cos(a), z, s * Math.sin(a)];
};
/** a unit vector perpendicular to unit d, at a random angle about it */
const perp = (d: Vec3, r: () => number): Vec3 => {
  const t: Vec3 = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm(cross(d, t));
  const w = cross(d, u);
  const a = r() * Math.PI * 2;
  return norm(add(scale(u, Math.cos(a)), w, Math.sin(a)));
};
/** rotate v about unit axis k by angle a (Rodrigues) */
const rotate = (v: Vec3, k: Vec3, a: number): Vec3 => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return add(add(scale(v, c), cross(k, v), s), k, dot(k, v) * (1 - c));
};

/** 0..1 arc progress at time progress u: decelerating as the particle loses energy (inverse: 1 − √(1 − f)) */
export const productEase = (u: number): number => {
  const k = Math.min(1, Math.max(0, u));
  return 1 - (1 - k) * (1 - k);
};

/**
 * Where track T is at arc fraction f. In its own frame (x along dir, y toward the centre of curvature, q·n×dir) the
 * log spiral from the origin with initial tangent x and radius R₀ shrinking as e^(−kφ) integrates to
 *   x = R₀/(1+k²)·(e^(−kφ)(sin φ − k cos φ) + k),  y = R₀/(1+k²)·(1 − e^(−kφ)(cos φ + k sin φ)),
 * its arc length to s = R₀(1 − e^(−kφ))/k, which `pitch` carries along the field. k → 0 is the circle.
 */
export function trackPoint(T: Pick<ProductTrack, 'start' | 'dir' | 'normal' | 'radius' | 'curl' | 'turn' | 'pitch' | 'q'>, f: number): Vec3 {
  const phi = T.turn * Math.min(1, Math.max(0, f));
  const k = T.curl;
  const g = 1 / (1 + k * k);
  const e = Math.exp(-k * phi);
  const x = T.radius * g * (e * (Math.sin(phi) - k * Math.cos(phi)) + k);
  const y = T.radius * g * (1 - e * (Math.cos(phi) + k * Math.sin(phi)));
  const s = (T.radius * (1 - e)) / Math.max(k, 1e-4);
  const side = scale(cross(T.normal, T.dir), T.q);
  return add(add(add(T.start, T.dir, x), side, y), T.normal, T.pitch * s);
}

/** the unit direction of travel at arc fraction f */
export function trackTangent(T: Pick<ProductTrack, 'dir' | 'normal' | 'turn' | 'pitch' | 'q'>, f: number): Vec3 {
  const phi = T.turn * Math.min(1, Math.max(0, f));
  const side = scale(cross(T.normal, T.dir), T.q);
  return norm(add(add(scale(T.dir, Math.cos(phi)), side, Math.sin(phi)), T.normal, T.pitch));
}

/**
 * A track of momentum-like `p` (0..1) leaving `start` along `d` in field `n`: the radius grows with p (fast is
 * straight), the curl with 1 − p (slow ones spiral up), the run with p. `size` scales it to its parent (m per unit).
 * The turn is what its arc length reaches before the spiral has closed to 6 % of its radius.
 */
function charged(
  t0: number, start: Vec3, d: Vec3, n: Vec3, p: number, q: number, size: number, family: number, shade: number, energy: number, r: () => number,
): ProductTrack {
  const along = dot(d, n);
  const across = sub(d, scale(n, along));
  const al = Math.hypot(...across);
  const dir = al > 1e-3 ? scale(across, 1 / al) : perp(n, r);
  const radius = size * (0.35 + 5.5 * p * p + 0.6 * p);
  const curl = 0.04 + 0.42 * (1 - p) * (1 - p);
  const arc = size * (0.9 + 4.2 * p) * (0.8 + 0.4 * r());
  const closed = -Math.log(0.06) / curl;
  const reach = curl * arc < radius * 0.94 ? -Math.log(1 - (curl * arc) / radius) / curl : closed;
  return {
    t0,
    life: (0.32 + 0.55 * p) * (0.85 + 0.3 * r()),
    start,
    dir,
    normal: n,
    radius,
    curl,
    turn: Math.min(reach, closed),
    pitch: Math.max(-2, Math.min(2, along / Math.max(0.2, al))),
    q,
    family,
    shade,
    energy,
    flash: 0,
    end: 1,
  };
}

/** a straight light ray (a neutral pion's photon): white, fast, gone */
function ray(t0: number, start: Vec3, d: Vec3, length: number, energy: number): ProductTrack {
  const n = perp(d, () => 0.37);
  return { t0, life: length / 38, start, dir: d, normal: n, radius: 400, curl: 0, turn: length / 400, pitch: 0, q: 1, family: LIGHT, shade: 0.5, energy, flash: 0, end: 1 };
}

export interface Products {
  tracks: ProductTrack[];
  /** gamma conversions: new pairs, for loops.ts */
  conversions: PairEvent[];
  /** annihilation fireballs, for burst.ts */
  blasts: Blast[];
}

/** m/s, events.ts PHOTON_SPEED (a converting gamma's travel) */
const C = 38;

/** momentum-balanced directions: n random units with their mean taken out, three times over (renormalising brings
 * a little back each time; after three the residue is a few percent) — a star never flies all one way */
function balanced(n: number, r: () => number): Vec3[] {
  let ds = Array.from({ length: n }, () => unit(r));
  for (let k = 0; k < 3; k++) {
    const mean = scale(ds.reduce((a, b) => add(a, b), [0, 0, 0] as Vec3), 1 / n);
    ds = ds.map((d) => norm(sub(d, mean)));
  }
  return ds;
}

export interface ProductOptions {
  /** the index of the hero (U0) in `events`: its gammas always convert, far out, so the first light's shower
   * spreads into the arising; it throws no star (its annihilation is the act's one pure flash) */
  hero?: number;
  /** false: no conversions (the wave's own events: a pair born behind the front would be born after it) */
  conversions?: boolean;
  /** scales the chance of an annihilation star (1 default) */
  stars?: number;
}

/** The products of `events`, per event, in order, from one seeded stream. */
export function generateProducts(events: readonly PairEvent[], seed: number, o: ProductOptions = {}): Products {
  const heroIndex = o.hero ?? -1;
  const r = rng(seed);
  const tracks: ProductTrack[] = [];
  const conversions: PairEvent[] = [];
  const blasts: Blast[] = [];
  events.forEach((e, i) => {
    const hero = i === heroIndex;
    const n = norm(cross(e.axis, e.across));
    const life = e.loop * e.end;
    const tEnd = e.birth + life;
    const meets = e.meets && e.end >= 1;
    const ends = meets ? [meetingPoint(e)] : [endPoint(e, 1), endPoint(e, -1)];
    const size = Math.min(1.6, 0.45 + e.radius * 0.45);

    // ANNIHILATION: a fireball for the stronger ones, and a star of pions for some (more, and more prongs, the
    // hotter the pair); a pair the wave cuts short throws a smaller star from each bead
    for (const at of ends) {
      // (a quarter of the creation's: at half they were soft orange puffs, 2026-10-30 first look; an annihilation is
      // hotter and quicker than a creation)
      if (e.energy > 0.6) blasts.push({ birth: tEnd, burst: e.burst * (meets ? 0.22 : 0.14), energy: e.energy, vertex: at });
      const pStar = (hero ? 0 : meets ? 0.22 + 0.6 * Math.max(0, Math.min(1, (e.energy - 0.45) / 0.5)) : 0.38) * (o.stars ?? 1);
      if (r() >= pStar) continue;
      const prongs = meets ? 2 + Math.floor(r() * (2 + 5 * e.energy)) : 2 + Math.floor(r() * 2);
      const dirs = balanced(prongs, r);
      dirs.forEach((d, k) => {
        const p = 0.25 + 0.75 * r();
        const q = k % 2 === 0 ? 1 : -1;
        const fam = q > 0 ? ROSE : TEAL;
        const shade = Math.max(-1, Math.min(1, (p - 0.5) * 1.6 + (r() - 0.5) * 0.6));
        const T = charged(tEnd, at, d, n, p, q, size * (meets ? 1 : 0.6), fam, shade, e.energy * (0.55 + 0.4 * p), r);
        tracks.push(T);
        // a decay in flight: the track kinks by 20–45° and goes on, fainter and paler (π → μ). The kink turns about
        // the field, so it shows in the plane the tracks curl in (turned out of it, most of it would be lost to the
        // projection along the field, and the kink would read as a wobble)
        if (r() < 0.32) {
          const endAt = trackPoint(T, 1);
          const tan = trackTangent(T, 1);
          const kinked = rotate(tan, n, ((20 + 25 * r()) * Math.PI) / 180 * (r() < 0.5 ? 1 : -1));
          const M = charged(T.t0 + T.life, endAt, kinked, n, p * 0.55, q, size * 0.7, fam, Math.min(1, shade + 0.5), T.energy * 0.7, r);
          // a muon that stops decays: a pin-point flash at its end, now and then
          M.flash = r() < 0.4 ? 1 : 0;
          tracks.push(M);
        }
      });
      // and a neutral pion or two: a straight flick of light
      // (one star in four: straight white flicks everywhere read as scratches, 2026-10-30 first looks)
      const neutrals = r() < 0.25 ? 1 : 0;
      for (let k = 0; k < neutrals; k++) tracks.push(ray(tEnd, at, unit(r), 3 + 4 * r(), 0.6 * e.energy));
    }

    // CONVERSIONS: a gamma converts some metres out into a small pair along its way (only the pairs whose rays are
    // drawn, loops.ts rayKept, and the hero's always, far out)
    if ((e.energy > 0.55 || hero) && o.conversions !== false) {
      for (const s of [1, -1]) {
        if (!hero && r() >= 0.32) continue;
        const from = meets ? ends[0] : ends[s > 0 ? 0 : 1];
        const L = hero ? (s > 0 ? 9 : 12.5) : 3 + 6 * r();
        const g = scale(e.gamma, s);
        const across = perp(g, r);
        const tight = r();
        const size2 = hero ? 0.55 : 0.12 + 0.25 * r();
        conversions.push({
          birth: tEnd + L / C,
          loop: hero ? 1.6 : 0.7 + 0.5 * r(),
          vertex: add(from, g, L),
          axis: g,
          across,
          open: 0.25 + 0.2 * r(),
          radius: size2,
          // dimmer than the rays' threshold: a conversion draws no photons of its own
          energy: hero ? 0.44 : 0.3 + 0.12 * r(),
          gamma: across,
          spiral: 0.2 + 0.15 * tight,
          drift: 0,
          arc: Math.PI * (3 + 2 * tight),
          meets: 0,
          burst: hero ? 0.25 : 0.05 + 0.06 * r(),
          end: 1,
        });
      }
    }

    // DELTA RAYS: tight amber curls off the side of a fast pair's tracks, as each bead passes
    if (e.energy > 0.55 && !e.braid) {
      for (const q of [1, -1]) {
        // (fewer, wider and flat: tight helices of 5–18 cm, seen side-on from 10 m, drew a fine sawtooth on the tracks
        // near their vertices — the 2026-11-01 note, "JAGGED SAW-TOOTH … an artefact")
        const count = Math.floor(r() * (1 + 1.6 * (e.energy - 0.55) / 0.45));
        for (let k = 0; k < count; k++) {
          const u = 0.08 + 0.6 * r();
          if (u >= e.end) continue;
          const at = loopPoint(e, q, u);
          const tan = norm(sub(loopPoint(e, q, u + 0.002), loopPoint(e, q, u - 0.002)));
          const side = norm(cross(n, tan));
          const d = norm(add(scale(tan, 0.35), side, r() < 0.5 ? 1 : -1));
          const R0 = 0.14 + 0.2 * r();
          const curl = 0.28 + 0.3 * r();
          tracks.push({
            t0: e.birth + u * e.loop,
            life: 0.35 + 0.35 * r(),
            start: at,
            dir: d,
            normal: n,
            radius: R0,
            curl,
            turn: -Math.log(0.08) / curl,
            // (flat: a pitched curl seen side-on is the sawtooth; the draw is kept so the sequence after it is unchanged)
            pitch: 0 * r(),
            q: 1,
            family: MATTER,
            shade: 0.4 + 0.5 * r(),
            energy: e.energy * 0.6,
            flash: 0,
            end: 1,
          });
        }
      }
    }
  });
  return { tracks, conversions, blasts };
}

/**
 * JETS (scattering fans), placed by the caller: a fast particle comes in along `beam` and hits the medium at
 * `vertex` at act time `t`: a fan of 6–15 charged tracks thrown forward in a cone, momenta mostly low with a few
 * high (a power law), charges alternating; a neutral ray or two; sometimes a V0 decaying a metre or two on.
 */
export function jet(t: number, vertex: Vec3, beam: Vec3, energy: number, r: () => number): { tracks: ProductTrack[]; blasts: Blast[] } {
  const tracks: ProductTrack[] = [];
  const b = norm(beam);
  // the field the jet sits in: across the beam, so the fan's curls show
  const n = norm(add(perp(b, r), b, (r() - 0.5) * 0.5));
  // the incoming particle: a straight, pale-gold streak arriving over a fifth of a second
  const Lb = 5 + 4 * r();
  tracks.push({ ...ray(t - Lb / 38, add(vertex, b, -Lb), b, Lb, 0.9 * energy), family: MATTER, shade: 0.9 });
  const N = 6 + Math.floor(r() * (5 + 5 * energy));
  const cone = ((12 + 22 * r()) * Math.PI) / 180;
  for (let k = 0; k < N; k++) {
    const p = 0.12 + 0.88 * r() ** 2.6;
    const d = rotate(b, perp(b, r), cone * Math.sqrt(r()) * (1.3 - p * 0.6));
    const q = k % 2 === 0 ? 1 : -1;
    const fam = q > 0 ? (r() < 0.5 ? MATTER : ROSE) : r() < 0.5 ? ANTI : TEAL;
    const shade = Math.max(-1, Math.min(1, (p - 0.35) * 2 + (r() - 0.5) * 0.4));
    tracks.push(charged(t, vertex, d, n, p, q, 1.1, fam, shade, energy * (0.45 + 0.5 * p), r));
  }
  for (let k = 0; k < 1 + Math.floor(r() * 2); k++) tracks.push(ray(t, vertex, rotate(b, perp(b, r), cone * r()), 4 + 4 * r(), 0.7 * energy));
  // a V0: unseen for L m, then a V of two opposite tracks pointing on
  if (r() < 0.55) {
    const d = rotate(b, perp(b, r), cone * 0.7 * r());
    const L = 1.2 + 1.8 * r();
    const at = add(vertex, d, L);
    const t1 = t + L / 9;
    const open = ((10 + 14 * r()) * Math.PI) / 180;
    const w = perp(d, r);
    tracks.push(charged(t1, at, rotate(d, w, open), n, 0.45 + 0.3 * r(), 1, 0.9, ROSE, 0.2, energy * 0.7, r));
    tracks.push(charged(t1, at, rotate(d, w, -open), n, 0.4 + 0.3 * r(), -1, 0.9, TEAL, 0.2, energy * 0.7, r));
  }
  return { tracks, blasts: [{ birth: t, burst: 0.3 + 0.25 * energy, energy, vertex }] };
}
