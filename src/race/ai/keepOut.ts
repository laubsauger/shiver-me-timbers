/**
 * STATIC KEEP-OUTS for the NPC pilots. The page's solid colliders (roof walls, kit granite, pylons, guy anchors,
 * pontoons, buoys) as xz discs on a uniform grid, so the line optimiser, the lateral room and the pursuit controller
 * can ask "is anything solid within c metres of (x, z)" in O(1).
 *
 * WHY: collisions are solid since §T.198. The line only knew gates and marks, and between two corridors it gave every
 * offset (avoidance, blocking) a fixed 12 m of room. On Tower Reach that room ran into Main Street's roof walls.
 *
 *  discs    each solid capsule a hull can reach (its y extent overlaps HULL_BAND), projected on xz: discs of the
 *           capsule's radius spaced ≤ one radius along its axis (a vertical capsule is one disc). Flexible gate
 *           poles are left out: they cost a speed loss, not a crash, and the line has to pass between them.
 *  grid     each disc is filed in every cell its radius + MAX_CLEAR touches, so a query of clearance ≤ MAX_CLEAR
 *           reads one cell.
 *
 * Plain numbers and typed arrays: structured-clone safe, crosses to a worker inside `PilotSetup`.
 */

/** the hull's vertical reach (m, still water): keel in a trough to a bow in the air after a stuff */
export const HULL_BAND = { below: -1.5, above: 2 } as const;
/** the largest clearance a query may ask for (m) */
export const MAX_CLEAR = 14;
const CELL = 24;

export interface KeepOuts {
  cell: number;
  x0: number;
  z0: number;
  nx: number;
  nz: number;
  /** CSR: cell k's discs are items[start[k]..start[k+1]) */
  start: Int32Array;
  items: Int32Array;
  /** x, z, r per disc */
  disc: Float64Array;
  count: number;
}

export interface CapsuleLike {
  a: readonly number[];
  b: readonly number[];
  radius: number;
  flexible?: boolean;
}

export function buildKeepOuts(colliders: readonly CapsuleLike[]): KeepOuts {
  const d: number[] = [];
  for (const c of colliders) {
    if (c.flexible) continue;
    if (Math.min(c.a[1], c.b[1]) - c.radius > HULL_BAND.above || Math.max(c.a[1], c.b[1]) + c.radius < HULL_BAND.below) continue;
    const r = c.radius;
    const len = Math.hypot(c.b[0] - c.a[0], c.b[2] - c.a[2]);
    const steps = Math.max(1, Math.ceil(len / Math.max(r, 0.25)));
    for (let k = 0; k <= steps; k++) {
      const t = len < 1e-6 ? 0 : k / steps;
      d.push(c.a[0] + (c.b[0] - c.a[0]) * t, c.a[2] + (c.b[2] - c.a[2]) * t, r);
      if (len < 1e-6) break;
    }
  }
  const count = d.length / 3;
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (let i = 0; i < count; i++) {
    const pad = d[3 * i + 2] + MAX_CLEAR;
    x0 = Math.min(x0, d[3 * i] - pad);
    z0 = Math.min(z0, d[3 * i + 1] - pad);
    x1 = Math.max(x1, d[3 * i] + pad);
    z1 = Math.max(z1, d[3 * i + 1] + pad);
  }
  if (count === 0) {
    x0 = z0 = 0;
    x1 = z1 = CELL;
  }
  const nx = Math.max(1, Math.ceil((x1 - x0) / CELL));
  const nz = Math.max(1, Math.ceil((z1 - z0) / CELL));
  const counts = new Int32Array(nx * nz + 1);
  const each = (i: number, fn: (k: number) => void): void => {
    const pad = d[3 * i + 2] + MAX_CLEAR;
    const ia = Math.max(0, Math.floor((d[3 * i] - pad - x0) / CELL));
    const ib = Math.min(nx - 1, Math.floor((d[3 * i] + pad - x0) / CELL));
    const ja = Math.max(0, Math.floor((d[3 * i + 1] - pad - z0) / CELL));
    const jb = Math.min(nz - 1, Math.floor((d[3 * i + 1] + pad - z0) / CELL));
    for (let j = ja; j <= jb; j++) for (let ii = ia; ii <= ib; ii++) fn(j * nx + ii);
  };
  for (let i = 0; i < count; i++) each(i, (k) => counts[k + 1]++);
  for (let k = 0; k < nx * nz; k++) counts[k + 1] += counts[k];
  const fill = counts.slice();
  const items = new Int32Array(counts[nx * nz]);
  for (let i = 0; i < count; i++) each(i, (k) => (items[fill[k]++] = i));
  return { cell: CELL, x0, z0, nx, nz, start: counts, items, disc: Float64Array.from(d), count };
}

/** scratch result of `keepOutPush` */
export interface Push {
  x: number;
  z: number;
  /** deepest intrusion into (r + clear), m; 0 = clear */
  depth: number;
}

/**
 * (x, z) moved out of every disc's r + clear, one pass in disc order (deterministic). `depth` = the deepest intrusion
 * met. clear ≤ MAX_CLEAR.
 */
export function keepOutPush(k: KeepOuts, x: number, z: number, clear: number, out: Push): Push {
  out.x = x;
  out.z = z;
  out.depth = 0;
  const i = Math.floor((x - k.x0) / k.cell);
  const j = Math.floor((z - k.z0) / k.cell);
  if (i < 0 || j < 0 || i >= k.nx || j >= k.nz) return out;
  const c = j * k.nx + i;
  for (let q = k.start[c]; q < k.start[c + 1]; q++) {
    const o = 3 * k.items[q];
    const R = k.disc[o + 2] + clear;
    const dx = out.x - k.disc[o];
    const dz = out.z - k.disc[o + 1];
    const d2 = dx * dx + dz * dz;
    if (d2 >= R * R) continue;
    const dd = Math.sqrt(d2);
    if (R - dd > out.depth) out.depth = R - dd;
    if (dd > 1e-9) {
      out.x = k.disc[o] + (dx / dd) * R;
      out.z = k.disc[o + 1] + (dz / dd) * R;
    }
  }
  return out;
}

/** distance from (x, z) to the nearest disc surface, capped at MAX_CLEAR (m; negative inside a disc) */
export function keepOutClearance(k: KeepOuts, x: number, z: number): number {
  const i = Math.floor((x - k.x0) / k.cell);
  const j = Math.floor((z - k.z0) / k.cell);
  if (i < 0 || j < 0 || i >= k.nx || j >= k.nz) return MAX_CLEAR;
  const c = j * k.nx + i;
  let best = MAX_CLEAR;
  for (let q = k.start[c]; q < k.start[c + 1]; q++) {
    const o = 3 * k.items[q];
    const s = Math.hypot(x - k.disc[o], z - k.disc[o + 1]) - k.disc[o + 2];
    if (s < best) best = s;
  }
  return best;
}
