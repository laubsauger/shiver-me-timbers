/**
 * PATH-FIRST ISLAND AUTHORING — the graph half (T112b, §V94, §V90). Pure
 * CPU, ZERO three imports; tests/pathGraph.test.ts drives it.
 *
 * The walkable route used to be a property the BFS in tests/sierra.test.ts
 * discovered after the fact. Here it is CONTENT: a seeded graph on a 128²
 * downsample of the post-erosion field —
 *
 *   landing   the beach cell nearest the bearing the raft arrives from
 *   station   the summit (the radio aerial stands here)
 *   exit      a second beach cell, toward the next slice island, kept
 *             ≥ `pathExitSeparation` rad around the coast from the landing
 *   fork POI  off the route by ≥ `pathForkOffset` m and NOT in line of sight
 *             from the landing (BotW "gravity": you must walk to find out)
 *
 * joined by anisotropic A* with a Galin 2010 cost (slope along the edge —
 * climbing the gradient costs more than traversing it — a turn penalty so
 * the route does not zig-zag cell by cell, water forbidden, the beach band
 * cheap) and smoothed into Catmull-Rom splines sampled every half cell. The
 * carve (pathCarve.ts) then writes those splines into the heightfield.
 *
 * Beach cells are LAND CELLS TOUCHING THE SEA, where "sea" is the water
 * flood-filled from the grid border — a cirque's inner lagoon shore is not a
 * landing unless its opening actually lets the water in.
 */
import { createRng, type Rng } from '../state/rng';

export type Vec3 = [number, number, number];
export type PoiKind = 'landing' | 'station' | 'exit' | 'fork';

export interface PathHints {
  /** island-local bearing (rad, (cos, sin) on x/z) toward where the raft comes from */
  approach: number;
  /** island-local bearing toward the next slice island (exit side, Journey tilt) */
  next: number;
}

export interface PathCostParams {
  pathSlopeCost: number;
  pathTurnCost: number;
  pathBeachCost: number;
  pathMainSlope: number;
  /** the carve's guard: it cannot act below this height (+ width) */
  erodeBandStart: number;
  erodeBandWidth: number;
}

/** the coarse field the graph is solved on */
export interface CoarseField {
  n: number;
  cell: number;
  /** grid spans [-R, R] */
  R: number;
  h: Float64Array;
  /**
   * steepest fine-grid 8-neighbour slope (tan) under each coarse cell — the
   * A* pays for it where the carve cannot act (the beach guard), so the route
   * leaves the beach over a real ramp and not a 2 m step the 4 m cell averaged
   * away
   */
  rough: Float64Array;
}

/** a route as island-local metre samples, `step` apart along the spline */
export interface Polyline {
  x: Float64Array;
  z: Float64Array;
  /** cumulative arc length (m) */
  s: Float64Array;
}

export interface PathGraph {
  coarse: CoarseField;
  landing: [number, number];
  station: [number, number];
  exit: [number, number];
  /** null when no hidden, off-route POI exists on this island */
  fork: [number, number] | null;
  main: Polyline;
  /** index of the station sample on `main` */
  stationIndex: number;
  /** fork polylines (junction → POI [→ route]); empty when `fork` is null */
  forks: Polyline[];
  /** true when the fork rejoins the route (a loop) instead of dead-ending */
  forkLoops: boolean;
}

const smoothstep01 = (t: number): number => {
  const c = Math.min(Math.max(t, 0), 1);
  return c * c * (3 - 2 * c);
};

/** bilinear sample of a row-major grid spanning [-R, R] at island-local (x, z) */
export function sampleField(h: Float64Array, n: number, R: number, x: number, z: number): number {
  const cell = (2 * R) / (n - 1);
  const gx = Math.min(Math.max((x + R) / cell, 0), n - 1);
  const gz = Math.min(Math.max((z + R) / cell, 0), n - 1);
  const x0 = Math.min(Math.floor(gx), n - 2);
  const z0 = Math.min(Math.floor(gz), n - 2);
  const fx = gx - x0;
  const fz = gz - z0;
  const a = h[z0 * n + x0] + (h[z0 * n + x0 + 1] - h[z0 * n + x0]) * fx;
  const b = h[(z0 + 1) * n + x0] + (h[(z0 + 1) * n + x0 + 1] - h[(z0 + 1) * n + x0]) * fx;
  return a + (b - a) * fz;
}

/** resample a size² field onto n² (n ≤ size), same extent */
export function downsample(h: Float64Array, size: number, R: number, n: number): CoarseField {
  const cell = (2 * R) / (n - 1);
  const fine = (2 * R) / (size - 1);
  const out = new Float64Array(n * n);
  const rough = new Float64Array(n * n);
  const span = Math.max(1, Math.ceil(cell / fine));
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const x = -R + ix * cell;
      const z = -R + iz * cell;
      out[iz * n + ix] = sampleField(h, size, R, x, z);
      const fx = Math.round((x + R) / fine);
      const fz = Math.round((z + R) / fine);
      let worst = 0;
      for (let dz = -span; dz <= span; dz++) {
        const jz = fz + dz;
        if (jz < 1 || jz >= size - 1) continue;
        for (let dx = -span; dx <= span; dx++) {
          const jx = fx + dx;
          if (jx < 1 || jx >= size - 1) continue;
          const j = jz * size + jx;
          const s = Math.max(Math.abs(h[j + 1] - h[j - 1]), Math.abs(h[j + size] - h[j - size])) / (2 * fine);
          if (s > worst) worst = s;
        }
      }
      rough[iz * n + ix] = worst;
    }
  }
  return { n, cell, R, h: out, rough };
}

/** 1 = sea water connected to the grid border (the open ocean), 0 otherwise */
export function seaMask(f: CoarseField): Uint8Array {
  const { n, h } = f;
  const sea = new Uint8Array(n * n);
  const queue: number[] = [];
  const push = (i: number): void => {
    if (sea[i] || h[i] > 0) return;
    sea[i] = 1;
    queue.push(i);
  };
  for (let i = 0; i < n; i++) {
    push(i);
    push((n - 1) * n + i);
    push(i * n);
    push(i * n + n - 1);
  }
  let head = 0;
  while (head < queue.length) {
    const i = queue[head++];
    const ix = i % n;
    const iz = (i - ix) / n;
    if (ix > 0) push(i - 1);
    if (ix < n - 1) push(i + 1);
    if (iz > 0) push(i - n);
    if (iz < n - 1) push(i + n);
  }
  return sea;
}

/** land cells (0 < h < beachTop) with an 8-neighbour in the open sea */
export function beachCells(f: CoarseField, sea: Uint8Array, beachTop: number): Int32Array {
  const { n, h } = f;
  const out: number[] = [];
  for (let iz = 1; iz < n - 1; iz++) {
    for (let ix = 1; ix < n - 1; ix++) {
      const i = iz * n + ix;
      if (h[i] <= 0 || h[i] >= beachTop) continue;
      let touches = false;
      for (let dz = -1; dz <= 1 && !touches; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (sea[i + dz * n + dx]) {
            touches = true;
            break;
          }
        }
      }
      if (touches) out.push(i);
    }
  }
  return Int32Array.from(out);
}

const angleDelta = (a: number, b: number): number => {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
};

/** the beach cell whose bearing from the centre is nearest `bearing`, excluding a sector */
function pickBeach(
  f: CoarseField,
  cells: Int32Array,
  bearing: number,
  avoid: { bearing: number; separation: number } | null,
): number {
  const { n, cell, R } = f;
  let best = -1;
  let bestScore = Infinity;
  for (let k = 0; k < cells.length; k++) {
    const i = cells[k];
    const ix = i % n;
    const iz = (i - ix) / n;
    const x = -R + ix * cell;
    const z = -R + iz * cell;
    const b = Math.atan2(z, x);
    if (avoid && angleDelta(b, avoid.bearing) < avoid.separation) continue;
    // nearest bearing first; a steep bank behind the sand costs bearing (the
    // carve cannot touch the sand, so the route has to leave it over a ramp)
    let bank = 0;
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const jx = ix + dx;
        const jz = iz + dz;
        if (jx < 0 || jz < 0 || jx >= n || jz >= n) continue;
        bank = Math.max(bank, f.rough[jz * n + jx]);
      }
    }
    const score = angleDelta(b, bearing) + Math.max(0, bank - 0.45) * 1.5 - (Math.hypot(x, z) / R) * 0.02;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/** 1 on land cells 8-connected (over h > 0.05) to `from` */
export function landComponent(f: CoarseField, from: number): Uint8Array {
  const { n, h } = f;
  const seen = new Uint8Array(n * n);
  const queue = [from];
  seen[from] = 1;
  let head = 0;
  while (head < queue.length) {
    const i = queue[head++];
    const ix = i % n;
    const iz = (i - ix) / n;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const jx = ix + dx;
        const jz = iz + dz;
        if (jx < 0 || jz < 0 || jx >= n || jz >= n) continue;
        const j = jz * n + jx;
        if (seen[j] || h[j] <= 0.05) continue;
        seen[j] = 1;
        queue.push(j);
      }
    }
  }
  return seen;
}

/** the highest cell */
export function summitCell(f: CoarseField): number {
  let best = 0;
  for (let i = 1; i < f.h.length; i++) if (f.h[i] > f.h[best]) best = i;
  return best;
}

// ── anisotropic A* ────────────────────────────────────────────────────────
const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DZ = [0, 1, 1, 1, 0, -1, -1, -1];
const DLEN = DX.map((dx, k) => Math.hypot(dx, DZ[k]));

/** binary min-heap on (key, id) pairs; FIFO among equal keys for determinism */
class Heap {
  private keys: number[] = [];
  private ids: number[] = [];
  private seq: number[] = [];
  private counter = 0;
  get size(): number {
    return this.keys.length;
  }
  private less(a: number, b: number): boolean {
    return this.keys[a] < this.keys[b] || (this.keys[a] === this.keys[b] && this.seq[a] < this.seq[b]);
  }
  private swap(a: number, b: number): void {
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
    [this.ids[a], this.ids[b]] = [this.ids[b], this.ids[a]];
    [this.seq[a], this.seq[b]] = [this.seq[b], this.seq[a]];
  }
  push(key: number, id: number): void {
    this.keys.push(key);
    this.ids.push(id);
    this.seq.push(this.counter++);
    let i = this.keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): number {
    const top = this.ids[0];
    const last = this.keys.length - 1;
    this.swap(0, last);
    this.keys.pop();
    this.ids.pop();
    this.seq.pop();
    let i = 0;
    const n = this.keys.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < n && this.less(l, m)) m = l;
      if (r < n && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
    return top;
  }
}

/**
 * Galin-style edge cost from cell a to b along direction k: length × a
 * slope term quadratic in (slope / walkable cap) that turns punitive past
 * 40° (the carve would have to trench), × the beach factor, + a turn
 * penalty ∝ (1 − cos Δθ). Water (h ≤ 0) is forbidden (Infinity).
 */
export function edgeCost(
  f: CoarseField,
  a: number,
  b: number,
  k: number,
  prevDir: number,
  p: PathCostParams,
  beachTop: number,
): number {
  const hb = f.h[b];
  if (hb <= 0.05) return Infinity;
  const d = f.cell * DLEN[k];
  const s = Math.abs(hb - f.h[a]) / d;
  const cap = Math.tan((p.pathMainSlope * Math.PI) / 180);
  const r = s / Math.max(cap, 1e-3);
  let slope = 1 + p.pathSlopeCost * r * r;
  const hard = Math.tan((40 * Math.PI) / 180);
  if (s > hard) slope += 30 * (s / hard) * (s / hard);
  const beach = hb < beachTop ? p.pathBeachCost : 1;
  // where the carve cannot act, the fine-grid steps are what the player meets
  const guard = 1 - smoothstep01((hb - p.erodeBandStart) / Math.max(p.erodeBandWidth, 1e-3));
  if (guard > 0) {
    const rr = f.rough[b] / Math.max(cap, 1e-3);
    if (rr > 1) slope += guard * p.pathSlopeCost * 3 * (rr - 1) * (rr - 1) * 4;
  }
  let turn = 0;
  if (prevDir >= 0) {
    let dk = Math.abs(k - prevDir) % 8;
    if (dk > 4) dk = 8 - dk;
    turn = p.pathTurnCost * f.cell * (1 - Math.cos((dk * Math.PI) / 4));
  }
  return d * slope * beach + turn;
}

/** A* over (cell, incoming direction) states; returns cell indices from → to, or null */
export function astar(
  f: CoarseField,
  from: number,
  to: number,
  p: PathCostParams,
  beachTop: number,
  /** optional extra per-cell cost multiplier (1 = none) */
  weight: Float64Array | null = null,
): number[] | null {
  const { n, cell } = f;
  const N = n * n * 8;
  const g = new Float64Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const heap = new Heap();
  const tx = to % n;
  const tz = (to - tx) / n;
  const hfn = (i: number): number => {
    const ix = i % n;
    const iz = (i - ix) / n;
    // admissible: the cheapest edge multiplier is the beach factor
    return Math.hypot(ix - tx, iz - tz) * cell * Math.min(p.pathBeachCost, 1);
  };
  // direction slot 8 would be "none"; we seed all 8 with no turn penalty
  for (let k = 0; k < 8; k++) {
    g[from * 8 + k] = 0;
    heap.push(hfn(from), from * 8 + k);
  }
  let endState = -1;
  while (heap.size > 0) {
    const st = heap.pop();
    if (closed[st]) continue;
    closed[st] = 1;
    const i = st >> 3;
    const dir = st & 7;
    if (i === to) {
      endState = st;
      break;
    }
    const ix = i % n;
    const iz = (i - ix) / n;
    const gi = g[st];
    for (let k = 0; k < 8; k++) {
      const jx = ix + DX[k];
      const jz = iz + DZ[k];
      if (jx < 0 || jz < 0 || jx >= n || jz >= n) continue;
      const j = jz * n + jx;
      const prev = gi === 0 ? -1 : dir;
      let c = edgeCost(f, i, j, k, prev, p, beachTop);
      if (!Number.isFinite(c)) continue;
      if (weight) c *= weight[j];
      const ns = j * 8 + k;
      const ng = gi + c;
      if (ng < g[ns]) {
        g[ns] = ng;
        came[ns] = st;
        heap.push(ng + hfn(j), ns);
      }
    }
  }
  if (endState < 0) return null;
  const cells: number[] = [];
  for (let st = endState; st >= 0; st = came[st]) {
    const i = st >> 3;
    if (cells.length === 0 || cells[cells.length - 1] !== i) cells.push(i);
  }
  cells.reverse();
  return cells;
}

// ── splines ───────────────────────────────────────────────────────────────

/** Catmull-Rom through `pts` (metres), sampled ~`step` apart, with arc length */
export function catmullRom(pts: [number, number][], step: number): Polyline {
  if (pts.length < 2) {
    const x = Float64Array.from(pts.map((q) => q[0]));
    const z = Float64Array.from(pts.map((q) => q[1]));
    return { x, z, s: new Float64Array(pts.length) };
  }
  const P = [pts[0], ...pts, pts[pts.length - 1]];
  const xs: number[] = [];
  const zs: number[] = [];
  for (let i = 1; i < P.length - 2; i++) {
    const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const m = Math.max(1, Math.ceil(len / step));
    for (let j = 0; j < m; j++) {
      const t = j / m;
      const t2 = t * t;
      const t3 = t2 * t;
      const w0 = -0.5 * t3 + t2 - 0.5 * t;
      const w1 = 1.5 * t3 - 2.5 * t2 + 1;
      const w2 = -1.5 * t3 + 2 * t2 + 0.5 * t;
      const w3 = 0.5 * t3 - 0.5 * t2;
      xs.push(w0 * p0[0] + w1 * p1[0] + w2 * p2[0] + w3 * p3[0]);
      zs.push(w0 * p0[1] + w1 * p1[1] + w2 * p2[1] + w3 * p3[1]);
    }
  }
  xs.push(pts[pts.length - 1][0]);
  zs.push(pts[pts.length - 1][1]);
  const s = new Float64Array(xs.length);
  for (let i = 1; i < xs.length; i++) {
    s[i] = s[i - 1] + Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]);
  }
  return { x: Float64Array.from(xs), z: Float64Array.from(zs), s };
}

/** cell index list → metre points, keeping every `keep`-th node plus both ends */
function cellsToPoints(f: CoarseField, cells: number[], keep: number): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k < cells.length; k++) {
    if (k % keep !== 0 && k !== cells.length - 1) continue;
    const i = cells[k];
    const ix = i % f.n;
    const iz = (i - ix) / f.n;
    out.push([-f.R + ix * f.cell, -f.R + iz * f.cell]);
  }
  return out;
}

// ── line of sight ─────────────────────────────────────────────────────────

/**
 * True when the terrain rises above the straight sight line between an eye
 * `eyeH` above the ground at A and a target `targetH` above the ground at
 * B, sampled every `step` m (the first/last 2 m excluded — that is the
 * observer's own feet).
 */
export function losBlocked(
  h: (x: number, z: number) => number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  eyeH: number,
  targetH: number,
  step: number,
): boolean {
  const len = Math.hypot(bx - ax, bz - az);
  if (len < 4) return false;
  const ya = h(ax, az) + eyeH;
  const yb = h(bx, bz) + targetH;
  const m = Math.ceil(len / step);
  for (let i = 1; i < m; i++) {
    const t = i / m;
    const d = t * len;
    if (d < 2 || len - d < 2) continue;
    const y = ya + (yb - ya) * t;
    if (h(ax + (bx - ax) * t, az + (bz - az) * t) > y) return true;
  }
  return false;
}

/** metres from (x, z) to the nearest polyline sample */
export function polylineDistance(pl: Polyline, x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < pl.x.length; i++) {
    const d = (pl.x[i] - x) * (pl.x[i] - x) + (pl.z[i] - z) * (pl.z[i] - z);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/**
 * Chamfer (3-4-ish, √2 diagonals) distance in metres from a polyline, on the
 * coarse grid: the samples seed their cells at 0 and two sweeps do the rest.
 * A few percent off a true Euclidean distance, which is all the fork weight
 * and the POI scan need — an exact per-cell sweep was 20 M distance tests.
 */
export function coarseDistance(f: CoarseField, pl: Polyline): Float64Array {
  const { n, cell, R } = f;
  const D = new Float64Array(n * n).fill(Infinity);
  for (let k = 0; k < pl.x.length; k++) {
    const ix = Math.round((pl.x[k] + R) / cell);
    const iz = Math.round((pl.z[k] + R) / cell);
    if (ix < 0 || iz < 0 || ix >= n || iz >= n) continue;
    D[iz * n + ix] = 0;
  }
  const a = cell;
  const b = cell * Math.SQRT2;
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const i = iz * n + ix;
      let v = D[i];
      if (ix > 0) v = Math.min(v, D[i - 1] + a);
      if (iz > 0) {
        v = Math.min(v, D[i - n] + a);
        if (ix > 0) v = Math.min(v, D[i - n - 1] + b);
        if (ix < n - 1) v = Math.min(v, D[i - n + 1] + b);
      }
      D[i] = v;
    }
  }
  for (let iz = n - 1; iz >= 0; iz--) {
    for (let ix = n - 1; ix >= 0; ix--) {
      const i = iz * n + ix;
      let v = D[i];
      if (ix < n - 1) v = Math.min(v, D[i + 1] + a);
      if (iz < n - 1) {
        v = Math.min(v, D[i + n] + a);
        if (ix < n - 1) v = Math.min(v, D[i + n + 1] + b);
        if (ix > 0) v = Math.min(v, D[i + n - 1] + b);
      }
      D[i] = v;
    }
  }
  return D;
}

/** index of the sample at arc length `s` (clamped) */
function indexAtS(pl: Polyline, s: number): number {
  let lo = 0;
  while (lo < pl.s.length - 1 && pl.s[lo] < s) lo++;
  return lo;
}

/** index of the sample at arc-length fraction `t` */
function indexAt(pl: Polyline, t: number): number {
  return indexAtS(pl, pl.s[pl.s.length - 1] * t);
}

export interface BuildPathGraphOptions {
  seed: number;
  hints: PathHints;
  /** heights above this are past the beach band (the landing/exit lie below it) */
  beachTop: number;
  /** cells this high or more may host the fork POI (above the beach guard) */
  poiMinHeight: number;
  forkAt: number;
  forkReturnAt: number;
  forkOffset: number;
  /** the junction stays at least this far (m) before the station */
  forkClearance: number;
  /** the scramble needs a stretch of fork this high (m) — above the carve's beach guard */
  scrambleMinHeight: number;
  exitSeparation: number;
  sampleStep: number;
  cost: PathCostParams;
}

/** decorrelates the path rng from every other per-island stream */
export const PATH_SEED_STRIDE = 6151;

/** seeded default bearings for an island built without site hints */
export function defaultPathHints(seed: number): PathHints {
  const rng = createRng(seed + PATH_SEED_STRIDE);
  const approach = rng() * Math.PI * 2;
  return { approach, next: approach + Math.PI + (rng() - 0.5) * 1.2 };
}

/**
 * Solve the graph on a coarse field. Throws when there is no beach or the
 * summit is unreachable from it even at the punitive cost — an island with
 * no route is a params bug, not a runtime condition (§Rule 8).
 */
export function buildPathGraph(f: CoarseField, o: BuildPathGraphOptions): PathGraph {
  const { n, cell, R } = f;
  const rng: Rng = createRng(o.seed + PATH_SEED_STRIDE + 1);
  const sea = seaMask(f);
  const station = summitCell(f);
  const land = landComponent(f, station);
  const beach = beachCells(f, sea, o.beachTop).filter((i) => land[i] === 1);
  if (beach.length === 0) throw new Error('buildPathGraph: no beach cell on the summit\'s landmass touches the open sea');
  const landing = pickBeach(f, beach, o.hints.approach, null);
  const lx = -R + (landing % n) * cell;
  const lz = -R + Math.floor(landing / n) * cell;
  const exitSep = { bearing: Math.atan2(lz, lx), separation: o.exitSeparation };
  let exit = pickBeach(f, beach, o.hints.next, exitSep);
  if (exit < 0) exit = pickBeach(f, beach, o.hints.next + Math.PI, null);

  const leg1 = astar(f, landing, station, o.cost, o.beachTop);
  const leg2 = astar(f, station, exit, o.cost, o.beachTop);
  if (!leg1 || !leg2) throw new Error('buildPathGraph: the summit is unreachable from the beach');
  const pts1 = cellsToPoints(f, leg1, 2);
  const pts2 = cellsToPoints(f, leg2, 2);
  const mainPts = [...pts1, ...pts2.slice(1)];
  const main = catmullRom(mainPts, o.sampleStep);
  // the station sample: the main sample nearest the summit cell
  const sx = -R + (station % n) * cell;
  const sz = -R + Math.floor(station / n) * cell;
  let stationIndex = 0;
  let bestD = Infinity;
  for (let i = 0; i < main.x.length; i++) {
    const d = Math.hypot(main.x[i] - sx, main.z[i] - sz);
    if (d < bestD) {
      bestD = d;
      stationIndex = i;
    }
  }
  const at = (i: number): [number, number] => [main.x[i], main.z[i]];

  // ── fork POI: off-route, above the beach guard, hidden from the landing ──
  const hAt = (x: number, z: number): number => sampleField(f.h, n, R, x, z);
  const dMain = coarseDistance(f, main);
  const candidates: { i: number; score: number }[] = [];
  for (let iz = 1; iz < n - 1; iz++) {
    for (let ix = 1; ix < n - 1; ix++) {
      const i = iz * n + ix;
      if (f.h[i] < o.poiMinHeight) continue;
      const x = -R + ix * cell;
      const z = -R + iz * cell;
      const d = dMain[i];
      if (d < o.forkOffset || d > o.forkOffset * 3) continue;
      if (!losBlocked(hAt, lx, lz, x, z, 1.7, 1.0, cell)) continue;
      // a viewpoint off the route: high and well clear, with a seeded shuffle
      candidates.push({ i, score: f.h[i] / Math.max(f.h[station], 1) + d / (o.forkOffset * 3) + rng() * 0.3 });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.i - b.i);
  let fork: [number, number] | null = null;
  const forks: Polyline[] = [];
  let forkLoops = false;
  // cells near the main route cost more, so the fork leaves it instead of
  // running beside it
  const weight = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++) weight[i] = 1 + 5 * (1 - smoothstep01(dMain[i] / (o.forkOffset * 0.5)));
  const j0 = Math.min(indexAt(main, o.forkAt), indexAtS(main, main.s[stationIndex] - o.forkClearance));
  const j1 = indexAt(main, o.forkReturnAt);
  const cellOf = (x: number, z: number): number =>
    Math.round((z + R) / cell) * n + Math.round((x + R) / cell);
  // the fork pays slope three times over: it cannot fill on sand, and a
  // 16 m drop to a beach 24 m away has no 31° trail without a longer way
  // — and the beach band is not cheap for it: a distraction through the
  // manzanita does not walk the sand (the sand is the main's, and it cannot be
  // carved). The heuristic stays admissible (it uses min(beachCost, 1)).
  const forkCost: PathCostParams = { ...o.cost, pathSlopeCost: o.cost.pathSlopeCost * 3, pathBeachCost: 1.5 };
  const edgeCoarse = o.forkOffset * 0.25;
  // two rounds: candidates that can host the scramble first; failing all of
  // them, any reachable candidate (the fork exists; the scramble test says so)
  for (const strict of [true, false]) {
  if (fork) break;
  for (const c of candidates.slice(0, 8)) {
    const out = astar(f, cellOf(main.x[j0], main.z[j0]), c.i, forkCost, o.beachTop, weight);
    if (!out) continue;
    // the fork must be able to host the scramble: a run of ≥ 6 coarse cells
    // clear of the main and above the beach guard (a fork that walks the
    // shore has nowhere to put a 34° step the carve may shape)
    let run = 0;
    let best = 0;
    const usable = Math.floor(out.length * 0.75); // the tail is the scramble's taper
    for (let k = 0; k < usable; k++) {
      const i = out[k];
      if (f.h[i] >= o.scrambleMinHeight && dMain[i] >= edgeCoarse) run++;
      else run = 0;
      if (run > best) best = run;
    }
    if (strict && best < 4) continue;
    const poi: [number, number] = [-R + (c.i % n) * cell, -R + Math.floor(c.i / n) * cell];
    const back = astar(f, c.i, cellOf(main.x[j1], main.z[j1]), forkCost, o.beachTop, weight);
    const straight = Math.hypot(poi[0] - main.x[j1], poi[1] - main.z[j1]);
    let pts = [at(j0), ...cellsToPoints(f, out, 2).slice(1, -1), poi];
    // a loop only if the way back is its own way: a return that retraces or
    // shadows the way out (inside two cells of it, beyond the junction ends)
    // would stamp two targets into one corridor
    let shadowed = 0;
    if (back) {
      const outPl: Polyline = { x: new Float64Array(out.length), z: new Float64Array(out.length), s: new Float64Array(0) };
      out.forEach((i, k) => {
        outPl.x[k] = -R + (i % n) * cell;
        outPl.z[k] = -R + Math.floor(i / n) * cell;
      });
      const dOut = coarseDistance(f, outPl);
      for (let k = 3; k < back.length - 3; k++) if (dOut[back[k]] < 2.5 * cell) shadowed++;
    }
    if (back && shadowed <= 2 && back.length * cell * 1.42 <= straight * 2.5 + 4 * cell) {
      pts = [...pts, ...cellsToPoints(f, back, 2).slice(1, -1), at(j1)];
      forkLoops = true;
    }
    forks.push(catmullRom(pts, o.sampleStep));
    fork = poi;
    break;
  }
  }

  return {
    coarse: f,
    landing: [lx, lz],
    station: at(stationIndex),
    exit: at(main.x.length - 1),
    fork,
    main,
    stationIndex,
    forks,
    forkLoops,
  };
}
