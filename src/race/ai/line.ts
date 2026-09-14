/**
 * THE RACING LINE (§T.186, tech-research §5.2). A closed, uniformly re-sampled polyline through the course's
 * corridors, relaxed to minimum Σκ² (elastic band, the iterative form of Kapania et al. 2016's first step).
 *
 *  corridor   gate: the segment between the poles shrunk by `gateMargin` (max(margin + GATE_TRACK, GATE_SHARE·width)).
 *             mark: a segment on the rounding side, from `radius + margin + MARK_TRACK` to `radius + MARK_REACH` off the mark,
 *             perpendicular to the bisector of the in/out directions (keepOn 'port' ⇒ the mark is on the boat's
 *             left ⇒ the segment is to the mark's starboard).
 *  relax      Gauss–Seidel on the discrete bi-Laplacian (p_i = (4(p_{i−1}+p_{i+1}) − (p_{i−2}+p_{i+2}))/6, the
 *             minimiser of Σ|p_{i−1} − 2p_i + p_{i+1}|² in p_i), corridor samples projected onto their segment,
 *             every sample pushed out of every mark's keep-out circle. Coarse → fine (12, 6, 3 m), re-sampled by
 *             arc length between the corridor samples after every block so spacing stays uniform (a
 *             second difference is only curvature at uniform spacing). Fixed iteration counts: deterministic.
 *  keep-outs  (optional) every sample pushed LINE_CLEAR off each static solid a hull can reach (keepOut.ts: roof walls,
 *             granite, anchors), and the lateral room clipped where a hull ROOM_CLEAR off the offset line would touch one.
 *  output     uniform ds ≈ 2 m; s = 0 at the start gate; κ signed (+ = turning to starboard, yaw increasing,
 *             core/steering convention); lateral room to the corridor edges for avoidance/blocking offsets.
 *
 * Frame: x/z sea plane; forward (sin θ, cos θ); starboard of a direction d is (d.z, −d.x).
 */
import type { Course, Vec2 } from '../types';
import { keepOutClearance, keepOutPush, type KeepOuts, type Push } from './keepOut';

/** how far past the keep-out radius a mark's rounding corridor reaches (m) */
export const MARK_REACH = 90;
/** lateral room cap between corridors (m): open water, but a line never wanders far off */
export const ROOM_CAP = 12;
/** metres a mark's keep-out adds for tracking error (measured 4–6 m off the line near an element) */
export const MARK_TRACK = 6;
/**
 * metres a gate's corridor adds to the level margin for tracking error: at a 4.4 m margin (risk 0.75) a boat 7 m off
 * its line out of the lee chicane crossed 3 m outside G8's pole on Tower Reach
 */
export const GATE_TRACK = 3;
/**
 * share of a gate's width its corridor keeps off each pole, when that is more than margin + GATE_TRACK: a wide gate costs
 * the line nothing to hold well inside (Tower Reach: G8 70 m ⇒ 12.6 m; a rookie over-speeding into it at risk 0.75 ran 11 m
 * off her line and crossed 4 m outside the pole)
 */
export const GATE_SHARE = 0.18;
/** metres the line keeps off a static solid's surface: half a 12 m hull + the measured 2–6 m tracking error */
export const LINE_CLEAR = 10;
/** metres an OFFSET line (avoidance, blocking) keeps off a static solid's surface: a half beam + tracking error */
export const ROOM_CLEAR = 5;

export interface Corridor {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  element: number;
  sheltered: boolean;
  /** mark keep-out circle (radius + margin + MARK_TRACK), or null for a gate */
  keepOut: { x: number; z: number; r: number } | null;
}

export interface RacingLine {
  n: number;
  ds: number;
  length: number;
  x: Float64Array;
  z: Float64Array;
  /** unit tangent */
  tx: Float64Array;
  tz: Float64Array;
  /** signed curvature, + = starboard turn */
  kappa: Float64Array;
  /** lateral room from the line to the corridor edge on the port / starboard side (m, ≥ 0) */
  roomPort: Float64Array;
  roomStbd: Float64Array;
  /** 1 = sheltered sector (island lee), 0 = exposed */
  sheltered: Uint8Array;
  /** sample index at which each course element's corridor is crossed */
  elementSample: Int32Array;
}

const center = (course: Course, k: number): Vec2 => {
  const e = course.elements[k];
  return e.kind === 'gate' ? [(e.gate.left[0] + e.gate.right[0]) / 2, (e.gate.left[1] + e.gate.right[1]) / 2] : e.mark.at;
};

/** metres a gate corridor keeps off each pole at a level margin, for a gate `w` wide */
export function gateMargin(margin: number, w: number): number {
  return Math.min(Math.max(margin + GATE_TRACK, GATE_SHARE * w), w / 2 - 0.5);
}

export function corridorsOf(course: Course, margin: number): Corridor[] {
  const m = course.elements.length;
  const out: Corridor[] = [];
  let sheltered = false;
  for (let k = 0; k < m; k++) {
    const e = course.elements[k];
    if (e.kind === 'gate') {
      const { left, right } = e.gate;
      const w = Math.hypot(right[0] - left[0], right[1] - left[1]);
      const ux = (right[0] - left[0]) / w;
      const uz = (right[1] - left[1]) / w;
      const mm = gateMargin(margin, w);
      sheltered = e.gate.sector === 'sheltered';
      out.push({ ax: left[0] + ux * mm, az: left[1] + uz * mm, bx: right[0] - ux * mm, bz: right[1] - uz * mm, element: k, sheltered, keepOut: null });
    } else {
      const mk = e.mark;
      const p = center(course, (k + m - 1) % m);
      const q = center(course, (k + 1) % m);
      let ix = mk.at[0] - p[0];
      let iz = mk.at[1] - p[1];
      const il = Math.hypot(ix, iz);
      ix /= il;
      iz /= il;
      let ox = q[0] - mk.at[0];
      let oz = q[1] - mk.at[1];
      const ol = Math.hypot(ox, oz);
      ox /= ol;
      oz /= ol;
      let bx = ix + ox;
      let bz = iz + oz;
      const bl = Math.hypot(bx, bz);
      if (bl < 0.1) {
        // a hairpin: the apex heading is the in-direction turned 90° toward the mark (race/types.ts handedness: port of
        // a heading (x, z) is (z, −x); a port rounding turns to port)
        bx = mk.keepOn === 'port' ? iz : -iz;
        bz = mk.keepOn === 'port' ? -ix : ix;
      } else {
        bx /= bl;
        bz /= bl;
      }
      // the boat passes on the side AWAY from keepOn: a port rounding keeps the mark to port, so the corridor lies to the
      // STARBOARD of the apex heading, (−bz, bx) (race/types.ts handedness, §T.197/B112; T196: was mirrored — the page
      // handed the pilots `aiHandedCourse`)
      const side = mk.keepOn === 'port' ? -1 : 1;
      const sx = bz * side;
      const sz = -bx * side;
      // the keep-out holds the LINE the pilot's tracking error (MARK_TRACK) clear of the rounding radius: a line at radius +
      // margin (31.5–35 m round T1's 28 m) let a boat 4–6 m inside it cut the radius and be called missed (§T.191 smoke race)
      const r0 = mk.radius + margin + MARK_TRACK;
      const r1 = mk.radius + MARK_REACH;
      // left pole seen along the course = the one nearer the mark for a port rounding
      const near: Vec2 = [mk.at[0] + sx * r0, mk.at[1] + sz * r0];
      const far: Vec2 = [mk.at[0] + sx * r1, mk.at[1] + sz * r1];
      const [a, b] = mk.keepOn === 'port' ? [near, far] : [far, near];
      out.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1], element: k, sheltered, keepOut: { x: mk.at[0], z: mk.at[1], r: r0 } });
    }
  }
  return out;
}

interface Band {
  x: number[];
  z: number[];
  /** corridor index per sample, −1 = free */
  c: number[];
}

/** closed polyline through `pts`, re-sampled so the samples at `anchors` stay put and each arc is split at ≈ ds */
function resample(xs: number[], zs: number[], anchors: number[], ds: number, corridorOfAnchor: number[]): Band {
  const n = xs.length;
  const band: Band = { x: [], z: [], c: [] };
  for (let a = 0; a < anchors.length; a++) {
    const i0 = anchors[a];
    const i1 = anchors[(a + 1) % anchors.length];
    // walk the polyline i0 → i1 (wrapping), collecting cumulative length
    const px: number[] = [];
    const pz: number[] = [];
    let i = i0;
    for (;;) {
      px.push(xs[i]);
      pz.push(zs[i]);
      if (i === i1 && px.length > 1) break;
      i = (i + 1) % n;
      if (i === i1) {
        px.push(xs[i]);
        pz.push(zs[i]);
        break;
      }
    }
    const cum = [0];
    for (let k = 1; k < px.length; k++) cum.push(cum[k - 1] + Math.hypot(px[k] - px[k - 1], pz[k] - pz[k - 1]));
    const len = cum[cum.length - 1];
    const cnt = Math.max(2, Math.round(len / ds));
    let seg = 1;
    for (let j = 0; j < cnt; j++) {
      const s = (j * len) / cnt;
      while (seg < cum.length - 1 && cum[seg] < s) seg++;
      const t = cum[seg] === cum[seg - 1] ? 0 : (s - cum[seg - 1]) / (cum[seg] - cum[seg - 1]);
      band.x.push(px[seg - 1] + (px[seg] - px[seg - 1]) * t);
      band.z.push(pz[seg - 1] + (pz[seg] - pz[seg - 1]) * t);
      band.c.push(j === 0 ? corridorOfAnchor[a] : -1);
    }
  }
  return band;
}

const scratchPush: Push = { x: 0, z: 0, depth: 0 };

function relax(b: Band, cor: readonly Corridor[], sweeps: number, ko: KeepOuts | null): void {
  const n = b.x.length;
  const x = b.x;
  const z = b.z;
  const keep = cor.filter((c) => c.keepOut !== null).map((c) => c.keepOut as { x: number; z: number; r: number });
  for (let it = 0; it < sweeps; it++) {
    for (let i = 0; i < n; i++) {
      const im1 = (i + n - 1) % n;
      const im2 = (i + n - 2) % n;
      const ip1 = (i + 1) % n;
      const ip2 = (i + 2) % n;
      let px = (4 * (x[im1] + x[ip1]) - (x[im2] + x[ip2])) / 6;
      let pz = (4 * (z[im1] + z[ip1]) - (z[im2] + z[ip2])) / 6;
      const ci = b.c[i];
      if (ci >= 0) {
        const c = cor[ci];
        const ux = c.bx - c.ax;
        const uz = c.bz - c.az;
        const l2 = ux * ux + uz * uz;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - c.ax) * ux + (pz - c.az) * uz) / l2)) : 0;
        px = c.ax + ux * t;
        pz = c.az + uz * t;
      }
      for (const k of keep) {
        const dx = px - k.x;
        const dz = pz - k.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < k.r * k.r && d2 > 1e-18) {
          const d = Math.sqrt(d2);
          px = k.x + (dx / d) * k.r;
          pz = k.z + (dz / d) * k.r;
        }
      }
      if (ko !== null) {
        keepOutPush(ko, px, pz, LINE_CLEAR, scratchPush);
        px = scratchPush.x;
        pz = scratchPush.z;
      }
      x[i] = px;
      z[i] = pz;
    }
  }
}

export interface LineOptions {
  /** metres kept off each pole / beyond each mark's radius */
  margin: number;
  /** output spacing (m) */
  ds?: number;
  /** false = corridor midpoints joined and re-sampled, no relaxation (the A/B baseline the tests compare against) */
  relax?: boolean;
  /** static solids the line and its lateral room keep clear of (keepOut.ts); absent = open water */
  keepOuts?: KeepOuts | null;
}

export function buildRacingLine(course: Course, opts: LineOptions): RacingLine {
  const cor = corridorsOf(course, opts.margin);
  const m = cor.length;
  if (m < 3) throw new Error('racing line: a course needs at least 3 elements');
  // seed: corridor midpoints
  let xs = cor.map((c) => (c.ax + c.bx) / 2);
  let zs = cor.map((c) => (c.az + c.bz) / 2);
  let anchors = cor.map((_, k) => k);
  const corOfAnchor = cor.map((_, k) => k);
  for (const [ds, blocks, sweeps] of [
    [12, 6, 300],
    [6, 5, 300],
    [3, 4, 400],
  ] as const) {
    for (let blk = 0; blk < blocks; blk++) {
      const b = resample(xs, zs, anchors, ds, corOfAnchor);
      if (opts.relax !== false) relax(b, cor, sweeps, opts.keepOuts ?? null);
      xs = b.x;
      zs = b.z;
      anchors = [];
      b.c.forEach((c, i) => {
        if (c >= 0) anchors.push(i);
      });
    }
  }
  // final uniform re-sample over the whole loop starting at the start-gate crossing
  const n0 = xs.length;
  const start = anchors[0];
  const cum = new Float64Array(n0 + 1);
  for (let k = 0; k < n0; k++) {
    const i = (start + k) % n0;
    const j = (i + 1) % n0;
    cum[k + 1] = cum[k] + Math.hypot(xs[j] - xs[i], zs[j] - zs[i]);
  }
  const length = cum[n0];
  const n = Math.round(length / (opts.ds ?? 2));
  const ds = length / n;
  const X = new Float64Array(n);
  const Z = new Float64Array(n);
  let seg = 1;
  for (let k = 0; k < n; k++) {
    const s = k * ds;
    while (seg < n0 && cum[seg] < s) seg++;
    const i = (start + seg - 1) % n0;
    const j = (i + 1) % n0;
    const t = (s - cum[seg - 1]) / Math.max(1e-12, cum[seg] - cum[seg - 1]);
    X[k] = xs[i] + (xs[j] - xs[i]) * t;
    Z[k] = zs[i] + (zs[j] - zs[i]) * t;
  }
  const TX = new Float64Array(n);
  const TZ = new Float64Array(n);
  const K = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i + n - 1) % n;
    const b = (i + 1) % n;
    const dx = X[b] - X[a];
    const dz = Z[b] - Z[a];
    const l = Math.hypot(dx, dz);
    TX[i] = dx / l;
    TZ[i] = dz / l;
  }
  // curvature over a ±5-sample chord (≈ ±10 m): d(heading)/ds, + = yaw increasing = starboard
  const w = 5;
  for (let i = 0; i < n; i++) {
    const a = (i + n - w) % n;
    const b = (i + w) % n;
    const ha = Math.atan2(TX[a], TZ[a]);
    const hb = Math.atan2(TX[b], TZ[b]);
    let dh = hb - ha;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    K[i] = dh / (2 * w * ds);
  }
  // which sample crosses each corridor: nearest sample to the relaxed anchor point
  const elementSample = new Int32Array(m);
  for (let k = 0; k < m; k++) {
    const ax = xs[anchors[k]];
    const az = zs[anchors[k]];
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < n; i++) {
      const d = (X[i] - ax) ** 2 + (Z[i] - az) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    elementSample[k] = best;
  }
  // lateral room at each corridor (distance along the corridor segment to its ends), linear between
  const roomPort = new Float64Array(n);
  const roomStbd = new Float64Array(n);
  const sheltered = new Uint8Array(n);
  const rp = new Float64Array(m);
  const rs = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    const c = cor[k];
    const i = elementSample[k];
    const sx = TZ[i];
    const sz = -TX[i];
    // a and b projected on the starboard normal through the line point
    const da = (c.ax - X[i]) * sx + (c.az - Z[i]) * sz;
    const db = (c.bx - X[i]) * sx + (c.bz - Z[i]) * sz;
    rs[k] = Math.max(0, Math.min(ROOM_CAP, Math.max(da, db)));
    rp[k] = Math.max(0, Math.min(ROOM_CAP, -Math.min(da, db)));
  }
  for (let k = 0; k < m; k++) {
    const i0 = elementSample[k];
    const i1 = elementSample[(k + 1) % m];
    const span = (i1 - i0 + n) % n || n;
    for (let j = 0; j < span; j++) {
      const i = (i0 + j) % n;
      const t = j / span;
      // corridors bind only near their crossing: room opens up to the cap half-way between
      const edge = Math.min(t, 1 - t) * span * ds;
      const open = Math.min(1, edge / 40);
      roomPort[i] = Math.min(ROOM_CAP, rp[k] + (rp[(k + 1) % m] - rp[k]) * t + open * ROOM_CAP);
      roomStbd[i] = Math.min(ROOM_CAP, rs[k] + (rs[(k + 1) % m] - rs[k]) * t + open * ROOM_CAP);
      sheltered[i] = cor[(k + 1) % m].sheltered ? 1 : 0;
    }
  }
  const ko = opts.keepOuts ?? null;
  if (ko !== null) {
    // a solid beside the line takes the room on its side: the first 1 m step at which a hull ROOM_CLEAR wide touches it
    for (let i = 0; i < n; i++) {
      const nx = TZ[i];
      const nz = -TX[i];
      for (const side of [1, -1] as const) {
        const cap = side === 1 ? roomStbd[i] : roomPort[i];
        let room = cap;
        for (let d = 1; d <= Math.ceil(cap); d++) {
          if (keepOutClearance(ko, X[i] + nx * d * side, Z[i] + nz * d * side) < ROOM_CLEAR) {
            room = Math.max(0, d - 1);
            break;
          }
        }
        if (side === 1) roomStbd[i] = room;
        else roomPort[i] = room;
      }
    }
  }
  return { n, ds, length, x: X, z: Z, tx: TX, tz: TZ, kappa: K, roomPort, roomStbd, sheltered, elementSample };
}

/** index of the sample nearest (x, z) within ±window samples of `hint` (window ≥ n/2 ⇒ global) */
export function nearestSample(line: RacingLine, x: number, z: number, hint: number, window: number): number {
  const n = line.n;
  let best = ((hint % n) + n) % n;
  let bd = Infinity;
  const w = Math.min(window, Math.floor(n / 2));
  for (let k = -w; k <= w; k++) {
    const i = (((hint + k) % n) + n) % n;
    const dx = line.x[i] - x;
    const dz = line.z[i] - z;
    const d = dx * dx + dz * dz;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}
