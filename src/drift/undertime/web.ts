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

export type GrainKind = 'scatter' | 'knot' | 'filament';

/**
 * `n` grain positions for one zoom level: `webShare` of them on the web (a quarter clustered at knots, the
 * rest along filaments, denser toward the knots they drain into), the others scattered through the ball.
 * The filaments ARE these grains — no drawn tubes: a gaussian cloud about each spine reads as matter.
 * Returns positions and, per grain, 0 = scatter, 1 = knot, 0.5 = filament (the shader's brightness weight).
 */
export function placeGrains(w: Web, n: number, webShare: number, seed: number): { pos: Float32Array; kind: Float32Array } {
  const r = rng(seed);
  const pos = new Float32Array(n * 3);
  const kind = new Float32Array(n);
  const lengths = w.filaments.map((f) => len(sub(w.knots[f.b], w.knots[f.a])));
  const total = lengths.reduce((a, b) => a + b, 0);
  for (let i = 0; i < n; i++) {
    let p: Vec3;
    let k = 0;
    if (r() >= webShare || w.filaments.length === 0) {
      p = inBall(r);
    } else if (r() < 0.25) {
      const c = w.knots[Math.floor(r() * w.knots.length)];
      const s = 0.03 + 0.03 * r();
      p = [c[0] + gauss(r) * s, c[1] + gauss(r) * s, c[2] + gauss(r) * s];
      k = 1;
    } else {
      // a filament, chosen by length (long ones hold more grains)
      let x = r() * total;
      let fi = 0;
      while (fi < lengths.length - 1 && x > lengths[fi]) x -= lengths[fi++];
      const u = r();
      const t = r() < 0.5 ? u * u * 0.5 : 1 - u * u * 0.5; // denser toward both ends
      const f = w.filaments[fi];
      const c = filamentPoint(w, f, t);
      // a gaussian about the spine, 1–3 % of the filament's length, swelling and thinning 3:1 along it
      const swell = 0.5 + 0.5 * Math.sin(t * Math.PI * 2.3 + f.c[0] * 17);
      const s = lengths[fi] * (0.01 + 0.02 * swell);
      p = [c[0] + gauss(r) * s, c[1] + gauss(r) * s, c[2] + gauss(r) * s];
      k = 0.5;
    }
    pos.set(p, i * 3);
    kind[i] = k;
  }
  return { pos, kind };
}
