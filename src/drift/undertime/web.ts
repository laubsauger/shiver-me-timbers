/**
 * The cosmic web Undertime's grains lie on (direction U5) — generated ONCE on the CPU, seeded, so it is the
 * same web in every frame, every render, every lane.
 *
 * Shape, after the large-scale structure it stands for: KNOTS scattered through a ball with a minimum
 * spacing (no two clumps on top of each other), each joined to its nearest neighbours by a FILAMENT — a
 * gently bowed curve (quadratic Bézier), never a straight segment: straight lines between points read as a
 * diagram, not as matter. Grains gather at the knots and along the filaments, with a little left over in
 * the voids. Everything is in pattern space (unit ball); grains.ts scales it per zoom level.
 */
import type { Vec3 } from '../../cine/domeMaster';

export interface Filament {
  a: number;
  b: number;
  /** Bézier control point */
  c: Vec3;
}

export interface Web {
  knots: Vec3[];
  filaments: Filament[];
}

/** mulberry32: small, fast, seedable */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

function inBall(r: () => number): Vec3 {
  for (;;) {
    const p: Vec3 = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1];
    if (len(p) <= 1) return p;
  }
}

/** a unit vector perpendicular to `d` */
function perpendicular(d: Vec3, r: () => number): Vec3 {
  const t: Vec3 = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u: Vec3 = [d[1] * t[2] - d[2] * t[1], d[2] * t[0] - d[0] * t[2], d[0] * t[1] - d[1] * t[0]];
  const ul = len(u) || 1;
  const n: Vec3 = [u[0] / ul, u[1] / ul, u[2] / ul];
  const dl = len(d) || 1;
  const w: Vec3 = [(d[1] * n[2] - d[2] * n[1]) / dl, (d[2] * n[0] - d[0] * n[2]) / dl, (d[0] * n[1] - d[1] * n[0]) / dl];
  const a = r() * Math.PI * 2;
  return [n[0] * Math.cos(a) + w[0] * Math.sin(a), n[1] * Math.cos(a) + w[1] * Math.sin(a), n[2] * Math.cos(a) + w[2] * Math.sin(a)];
}

export function buildWeb(seed: number, count = 40, neighbours = 3, minGap = 0.16): Web {
  const r = rng(seed);
  const knots: Vec3[] = [];
  for (let tries = 0; knots.length < count && tries < count * 200; tries++) {
    const p = inBall(r);
    if (knots.every((k) => len(sub(k, p)) >= minGap)) knots.push(p);
  }
  const seen = new Set<string>();
  const filaments: Filament[] = [];
  knots.forEach((k, i) => {
    const near = knots
      .map((o, j) => ({ j, d: len(sub(o, k)) }))
      .filter((n) => n.j !== i)
      .sort((x, y) => x.d - y.d)
      .slice(0, neighbours);
    for (const { j, d } of near) {
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const m: Vec3 = [(k[0] + knots[j][0]) / 2, (k[1] + knots[j][1]) / 2, (k[2] + knots[j][2]) / 2];
      const off = perpendicular(sub(knots[j], k), r);
      const bow = d * (0.08 + r() * 0.14);
      filaments.push({ a: i, b: j, c: [m[0] + off[0] * bow, m[1] + off[1] * bow, m[2] + off[2] * bow] });
    }
  });
  return { knots, filaments };
}

/** point at t ∈ [0, 1] along filament f */
export function filamentPoint(w: Web, f: Filament, t: number): Vec3 {
  const A = w.knots[f.a];
  const B = w.knots[f.b];
  const u = 1 - t;
  return [0, 1, 2].map((i) => u * u * A[i] + 2 * u * t * f.c[i] + t * t * B[i]) as Vec3;
}

function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(1e-9, r()))) * Math.cos(2 * Math.PI * r());
}

export type GrainKind = 'scatter' | 'hair' | 'filament' | 'knot';

const norm = (a: Vec3): Vec3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/**
 * `n` grain positions for one zoom level, after the cosmic-web simulations (drift-narrative/references,
 * cosmic-web): `webShare` of them on the web, the others scattered thinly through the voids. On the web:
 *
 *   knots      compact and cuspy (two nested gaussians): where the light saturates
 *   filaments  each joins a knot to its neighbours, a thin bright spine in a faint wider envelope, swelling
 *              and thinning along its length, denser toward the knots it drains into
 *   hair       the fine filaments a view without which looks fake: many short thin curved threads feeding
 *              every knot and branching off the filaments
 *
 * Returns positions; per grain its kind (0 scatter, 0.25 hair, 0.5 filament, 1 knot — the shader's
 * brightness weight); and its FLOW, the unit direction its matter drains along (toward the knot), which the
 * shader drifts it by: the web is never static.
 */
export function placeGrains(w: Web, n: number, webShare: number, seed: number): { pos: Float32Array; kind: Float32Array; flow: Float32Array } {
  const r = rng(seed);
  const pos = new Float32Array(n * 3);
  const kind = new Float32Array(n);
  const flow = new Float32Array(n * 3);
  const lengths = w.filaments.map((f) => len(sub(w.knots[f.b], w.knots[f.a])));
  const total = lengths.reduce((a, b) => a + b, 0);
  const pickFilament = (): number => {
    let x = r() * total;
    let fi = 0;
    while (fi < lengths.length - 1 && x > lengths[fi]) x -= lengths[fi++];
    return fi;
  };
  const jitter = (c: Vec3, s: number): Vec3 => [c[0] + gauss(r) * s, c[1] + gauss(r) * s, c[2] + gauss(r) * s];
  for (let i = 0; i < n; i++) {
    let p: Vec3;
    let k = 0;
    let f3: Vec3 = [0, 0, 0];
    const roll = r();
    if (roll >= webShare || w.filaments.length === 0) {
      p = inBall(r);
    } else if (r() < 0.22) {
      const c = w.knots[Math.floor(r() * w.knots.length)];
      p = jitter(c, r() < 0.6 ? 0.008 + 0.008 * r() : 0.025 + 0.02 * r());
      f3 = norm(sub(c, p));
      k = 1;
    } else if (r() < 0.62) {
      // a filament, chosen by length (long ones hold more grains)
      const fi = pickFilament();
      const u = r();
      const t = r() < 0.5 ? u * u * 0.5 : 1 - u * u * 0.5; // denser toward both ends
      const f = w.filaments[fi];
      const c = filamentPoint(w, f, t);
      // a thin spine (0.4–1.2 % of the length, swelling and thinning 3:1 along it) in a faint envelope (3 %)
      const swell = 0.5 + 0.5 * Math.sin(t * Math.PI * 2.3 + f.c[0] * 17);
      const s = lengths[fi] * (r() < 0.75 ? 0.004 + 0.008 * swell : 0.03);
      p = jitter(c, s);
      const ahead = filamentPoint(w, f, Math.min(1, t + 0.01));
      const tangent = norm(sub(ahead, c));
      // drains toward the nearer end
      f3 = t < 0.5 ? [-tangent[0], -tangent[1], -tangent[2]] : tangent;
      k = 0.5;
    } else {
      // hair: a short curved thread out from a knot, or branching off a filament
      let root: Vec3;
      if (r() < 0.6) root = w.knots[Math.floor(r() * w.knots.length)];
      else {
        const fi = pickFilament();
        root = filamentPoint(w, w.filaments[fi], 0.15 + 0.7 * r());
      }
      // each root has a few fixed threads: the thread's direction and length are seeded by (root, thread)
      const thread = Math.floor(r() * 7);
      const tr = rng(Math.floor((root[0] * 7919 + root[1] * 104729 + root[2] * 1299709) * 1e4) + thread * 31);
      const dir = norm(inBall(tr));
      const side = perpendicular(dir, tr);
      const length = 0.05 + 0.2 * tr();
      const t = Math.pow(r(), 1.5);
      const along = t * length;
      const c: Vec3 = [0, 1, 2].map((a) => root[a] + dir[a] * along + side[a] * t * t * length * 0.35) as Vec3;
      p = jitter(c, 0.002 + 0.004 * t);
      f3 = norm(sub(root, c));
      k = 0.25;
    }
    pos.set(p, i * 3);
    kind[i] = k;
    flow.set(f3, i * 3);
  }
  return { pos, kind, flow };
}
