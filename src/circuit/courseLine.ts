/**
 * Course-line geometry (§T.187): the closed reference line through gates and
 * around turn marks, plus the polyline utilities the course, the minimap and
 * the tests share. Pure math on `Vec2` (world x, z), no three imports.
 *
 * HEADINGS. A direction is (cos ψ, sin ψ) on (x, z). With y up, the PORT side
 * of a boat heading f = (fx, fz) is up × f = (fz, −fx) — facing +z, port is +x
 * (§B112: a man facing the bow has −x on his right hand). A turn to port
 * therefore DECREASES ψ.
 */
import type { Vec2 } from '../race/types';

export const len = (a: Vec2, b: Vec2): number => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** port unit vector of a heading vector */
export function portOf(fx: number, fz: number): Vec2 {
  const l = Math.max(Math.hypot(fx, fz), 1e-9);
  return [fz / l, -fx / l];
}

/** closed polyline length (last point connects back to the first) */
export function closedLength(pts: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) s += len(pts[i], pts[(i + 1) % pts.length]);
  return s;
}

/**
 * Closed centripetal Catmull-Rom through `pts` (Barry–Goldman form, α = ½):
 * no cusps or self-intersections inside a segment even where waypoints bunch
 * up around a mark, which uniform CR produces. `perSegment` samples per span.
 */
export function catmullRomClosed(pts: readonly Vec2[], perSegment: number): Vec2[] {
  const n = pts.length;
  const out: Vec2[] = [];
  const tj = (ti: number, a: Vec2, b: Vec2): number => ti + Math.sqrt(Math.max(len(a, b), 1e-6));
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    const t0 = 0;
    const t1 = tj(t0, p0, p1);
    const t2 = tj(t1, p1, p2);
    const t3 = tj(t2, p2, p3);
    for (let k = 0; k < perSegment; k++) {
      const t = t1 + ((t2 - t1) * k) / perSegment;
      const mix = (a: Vec2, b: Vec2, ta: number, tb: number): Vec2 => {
        const w = (t - ta) / Math.max(tb - ta, 1e-9);
        return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
      };
      const A1 = mix(p0, p1, t0, t1);
      const A2 = mix(p1, p2, t1, t2);
      const A3 = mix(p2, p3, t2, t3);
      const B1 = mix(A1, A2, t0, t2);
      const B2 = mix(A2, A3, t1, t3);
      out.push(mix(B1, B2, t1, t2));
    }
  }
  return out;
}

/** resample a closed polyline to (nearly) uniform `spacing`, starting at pts[0] */
export function resampleClosed(pts: readonly Vec2[], spacing: number): Vec2[] {
  const total = closedLength(pts);
  const count = Math.max(8, Math.round(total / spacing));
  const step = total / count;
  const out: Vec2[] = [];
  let seg = 0;
  let segStart = 0;
  let segLen = len(pts[0], pts[1 % pts.length]);
  for (let k = 0; k < count; k++) {
    const target = k * step;
    while (segStart + segLen < target && seg < pts.length - 1) {
      segStart += segLen;
      seg++;
      segLen = len(pts[seg], pts[(seg + 1) % pts.length]);
    }
    const a = pts[seg];
    const b = pts[(seg + 1) % pts.length];
    const w = segLen > 1e-9 ? (target - segStart) / segLen : 0;
    out.push([a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w]);
  }
  return out;
}

/** index of the polyline vertex nearest to p */
export function nearestIndex(pts: readonly Vec2[], p: Vec2): number {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = (pts[i][0] - p[0]) ** 2 + (pts[i][1] - p[1]) ** 2;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

/** unit tangent of a closed polyline at vertex i (central difference) */
export function tangentAt(pts: readonly Vec2[], i: number): Vec2 {
  const n = pts.length;
  const a = pts[(i - 1 + n) % n];
  const b = pts[(i + 1) % n];
  const l = Math.max(len(a, b), 1e-9);
  return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
}

/** distance from p to a closed polyline */
export function distanceToClosed(pts: readonly Vec2[], p: Vec2): number {
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l2 = Math.max(dx * dx + dz * dz, 1e-9);
    const s = Math.min(Math.max(((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2, 0), 1);
    const d = Math.hypot(p[0] - a[0] - dx * s, p[1] - a[1] - dz * s);
    if (d < best) best = d;
  }
  return best;
}

/**
 * The arc a boat sails around a mark kept on `keepOn`, at `clearance` metres
 * from its centre: from the approach heading (prev → mark) to the departure
 * heading (mark → next), turning toward the mark's side.
 */
export function markArc(prev: Vec2, mark: Vec2, next: Vec2, clearance: number, keepOn: 'port' | 'starboard', steps: number): Vec2[] {
  const psiIn = Math.atan2(mark[1] - prev[1], mark[0] - prev[0]);
  const psiOut = Math.atan2(next[1] - mark[1], next[0] - mark[0]);
  let d = psiOut - psiIn;
  // a port turn decreases ψ, a starboard turn increases it (see header)
  if (keepOn === 'port') {
    while (d > 0) d -= Math.PI * 2;
    while (d <= -Math.PI * 2) d += Math.PI * 2;
  } else {
    while (d < 0) d += Math.PI * 2;
    while (d >= Math.PI * 2) d -= Math.PI * 2;
  }
  const out: Vec2[] = [];
  const sign = keepOn === 'port' ? 1 : -1; // boat sits to STARBOARD of a port-kept mark
  for (let k = 0; k <= steps; k++) {
    const psi = psiIn + (d * k) / steps;
    // starboard of heading ψ = (−sin ψ, cos ψ)
    out.push([mark[0] - Math.sin(psi) * clearance * sign, mark[1] + Math.cos(psi) * clearance * sign]);
  }
  return out;
}

/** Douglas–Peucker on an open polyline */
export function simplify(pts: readonly Vec2[], tolerance: number): Vec2[] {
  if (pts.length < 3) return [...pts];
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let wd = tolerance;
    const ax = pts[a][0];
    const az = pts[a][1];
    const dx = pts[b][0] - ax;
    const dz = pts[b][1] - az;
    const l = Math.max(Math.hypot(dx, dz), 1e-9);
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dz - (pts[i][1] - az) * dx) / l;
      if (d > wd) {
        wd = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** simplify a closed ring (split at the farthest pair so DP has two anchors) */
export function simplifyClosed(ring: readonly Vec2[], tolerance: number): Vec2[] {
  if (ring.length < 4) return [...ring];
  let far = 0;
  let fd = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = len(ring[0], ring[i]);
    if (d > fd) {
      fd = d;
      far = i;
    }
  }
  const a = simplify(ring.slice(0, far + 1), tolerance);
  const b = simplify([...ring.slice(far), ring[0]], tolerance);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

/**
 * Marching squares at `level` over a row-major grid spanning [x0, x0 + (n−1)·cell]²,
 * returning closed rings (segments stitched by shared edge midpoints). Rings
 * that hit the grid border are closed along it.
 */
export function contourRings(
  data: ArrayLike<number>,
  n: number,
  x0: number,
  z0: number,
  cell: number,
  level: number,
): Vec2[][] {
  const at = (i: number, j: number): number => data[j * n + i] - level;
  const key = (i: number, j: number, e: number): string => `${i},${j},${e}`;
  // edge ids: 0 bottom (i,j)-(i+1,j), 1 right, 2 top (i,j+1)-(i+1,j+1), 3 left — canonicalised to a shared key
  const edgeKey = (i: number, j: number, e: number): string =>
    e === 0 ? key(i, j, 0) : e === 1 ? key(i + 1, j, 3) : e === 2 ? key(i, j + 1, 0) : key(i, j, 3);
  const edgePoint = (i: number, j: number, e: number): Vec2 => {
    const [ai, aj, bi, bj] =
      e === 0 ? [i, j, i + 1, j] : e === 1 ? [i + 1, j, i + 1, j + 1] : e === 2 ? [i, j + 1, i + 1, j + 1] : [i, j, i, j + 1];
    const va = at(ai, aj);
    const vb = at(bi, bj);
    const den = va - vb;
    const w = Math.abs(den) > 1e-12 ? Math.min(Math.max(va / den, 0), 1) : 0.5;
    return [x0 + (ai + (bi - ai) * w) * cell, z0 + (aj + (bj - aj) * w) * cell];
  };
  const next = new Map<string, { to: string; p: Vec2 }>();
  const lut: number[][][] = [
    [], [[3, 0]], [[0, 1]], [[3, 1]], [[1, 2]], [[3, 2], [1, 0]], [[0, 2]], [[3, 2]],
    [[2, 3]], [[2, 0]], [[0, 3], [2, 1]], [[2, 1]], [[1, 3]], [[1, 0]], [[0, 3]], [],
  ];
  const inside = (i: number, j: number): boolean => i < 0 || j < 0 || i >= n || j >= n ? false : at(i, j) > 0;
  for (let j = -1; j < n; j++) {
    for (let i = -1; i < n; i++) {
      const c = (inside(i, j) ? 1 : 0) | (inside(i + 1, j) ? 2 : 0) | (inside(i + 1, j + 1) ? 4 : 0) | (inside(i, j + 1) ? 8 : 0);
      for (const [ea, eb] of lut[c]) {
        const pa = borderAwarePoint(i, j, ea);
        next.set(edgeKey(i, j, ea), { to: edgeKey(i, j, eb), p: pa });
      }
    }
  }
  function borderAwarePoint(i: number, j: number, e: number): Vec2 {
    const [ai, aj, bi, bj] =
      e === 0 ? [i, j, i + 1, j] : e === 1 ? [i + 1, j, i + 1, j + 1] : e === 2 ? [i, j + 1, i + 1, j + 1] : [i, j, i, j + 1];
    const inA = !(ai < 0 || aj < 0 || ai >= n || aj >= n);
    const inB = !(bi < 0 || bj < 0 || bi >= n || bj >= n);
    if (inA && inB) return edgePoint(i, j, e);
    // one end is outside the grid (treated as below level): put the crossing on the border
    const w = inA ? 0 : 1;
    const ci = Math.min(Math.max(ai + (bi - ai) * w, 0), n - 1);
    const cj = Math.min(Math.max(aj + (bj - aj) * w, 0), n - 1);
    return [x0 + ci * cell, z0 + cj * cell];
  }
  const rings: Vec2[][] = [];
  const used = new Set<string>();
  for (const start of next.keys()) {
    if (used.has(start)) continue;
    const ring: Vec2[] = [];
    let k = start;
    while (!used.has(k) && next.has(k)) {
      used.add(k);
      const e = next.get(k)!;
      ring.push(e.p);
      k = e.to;
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

/** signed area of a ring (positive = counter-clockwise in x, z) */
export function ringArea(ring: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s * 0.5;
}
