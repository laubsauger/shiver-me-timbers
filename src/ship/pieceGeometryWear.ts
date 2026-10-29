/**
 * WORN GEOMETRY — an OPT-IN pass over the raft's greybox pieces (§T89), for a
 * view that comes close enough to see how they were cut.
 *
 * The user, of the film's chase shots (The Drift, 2026-10-29): "the house on
 * top and everything has perfectly sharp edges … everything except the large
 * tree trunks looks laser-cut, made out of styrofoam". The builders in
 * pieceGeometryRaft.ts are boxes on purpose — a slab is exact, cheap, and what
 * the game's z-fighting, roof-mitre and triangle-budget tests are written
 * against (tests/raft.test.ts) — so nothing here replaces them. A caller that
 * wants the hand-built look asks {@link wornPieceGeometry} for a piece's worn
 * twin and swaps it onto the mesh; the game never asks, and its geometry, its
 * tests and its budget are untouched (the film raft, src/drift/wandering/raft.ts,
 * is the one caller).
 *
 * What wear is, per piece (all of it a pure function of the piece def and a
 * seed from its id: §V2, seeded never random):
 *
 *   ROUNDED EDGES — a sawn board or a woven panel has no 90° arris: light
 *     rolls round a few millimetres of radius, and that soft line is most of
 *     what tells the eye a thing is made, not machined ({@link softBox}).
 *   SUBDIVISION — the slabs are two triangles a face; a wall that bows needs
 *     vertices to bow with ({@link subdivideToEdge}: crack-free, every edge
 *     longer than the limit split the same way from both sides).
 *   WARP — the lashed panels bulge between their corners and lean a little
 *     at the top, the roof sags between its gables and droops at the eave,
 *     the boards twist, the mats lie on the logs' crowns. Centimetres, low
 *     frequency: enough that no edge is a ruled line, not so much that a
 *     piece leaves the place the deck field and its neighbours expect it.
 *
 * Sizes stay inside the piece's aabb ± the warp (a few cm), so the deck field
 * (built from the blueprint, never from geometry) and every socket hold.
 */
import * as THREE from 'three';
import { mergeVertices, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import type { PieceDef } from './pieceTypes';
import { vhash } from './variation';

/** how worn: the scale of every term below (0 = the greybox's own shape, warped by nothing) */
export interface WearOptions {
  /** × every displacement (1 = the film's) */
  amount?: number;
  /** m: the longest edge left after subdivision (the warp's resolution); by default the kind's own, {@link CELL} */
  cell?: number;
  /** × every kind's own cell (a cheaper tier: 1.4 has about half the triangles) */
  cellScale?: number;
}

/**
 * m: each kind's warp resolution — the shortest wavelength its warp has, over about three. Finer only buys
 * triangles: the roof is a stack of course boxes whose every thin riser is cut at this pitch along the ridge, and
 * at 7 cm it alone was 260k triangles (the whole worn raft is ~120k at these).
 */
const CELL: Partial<Record<PieceDef['kind'], number>> = {
  'cabin-wall': 0.1,
  'thatch-roof': 0.15,
  'bamboo-deck': 0.2,
  splashboard: 0.12,
  guara: 0.12,
  log: 0.3,
  crossbeam: 0.25,
};

/** 0..1 smooth value noise in 1D, seeded: the warp's only randomness */
function noise1(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return vhash(seed, i) * (1 - u) + vhash(seed, i + 1) * u;
}

/** −1..1 smooth value noise in 2D, seeded, two octaves */
function noise2(x: number, y: number, seed: number): number {
  const one = (px: number, py: number, s: number): number => {
    const ix = Math.floor(px);
    const iy = Math.floor(py);
    const fx = px - ix;
    const fy = py - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const a = vhash(s, ix, iy);
    const b = vhash(s, ix + 1, iy);
    const c = vhash(s, ix, iy + 1);
    const d = vhash(s, ix + 1, iy + 1);
    return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
  };
  return (one(x, y, seed) * 0.67 + one(x * 2.03 + 7.1, y * 2.03 + 3.3, seed + 1) * 0.33) * 2 - 1;
}

/** the grid stations along one axis of a {@link softBox}: dense through each rounded edge, `cell` apart between */
function stations(lo: number, hi: number, r: number, seg: number, cell: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < seg; k++) out.push(lo + (r * k) / seg);
  const a = lo + r;
  const b = hi - r;
  const n = Math.max(1, Math.ceil((b - a) / cell));
  for (let k = 0; k <= n; k++) out.push(a + ((b - a) * k) / n);
  for (let k = seg - 1; k >= 0; k--) out.push(hi - (r * k) / seg);
  return out;
}

/**
 * A box with every edge and corner rounded to radius `r`, its faces gridded `cell` apart (so it can be warped).
 *
 * Each face is laid as a grid on the box's own surface and every vertex pulled onto the rounded box: clamped
 * into the box shrunk by r, then pushed back out r along the way it came — on a face's flat middle that is
 * straight back where it was, in the r-wide band at an edge it is round the edge. The two faces meeting at an
 * edge agree on every vertex there, so a later merge welds them.
 */
export function softBox(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, r: number, cell: number, seg = 3): THREE.BufferGeometry {
  const lo = [x0, y0, z0];
  const hi = [x1, y1, z1];
  const rr = Math.max(1e-4, Math.min(r, (x1 - x0) * 0.45, (y1 - y0) * 0.45, (z1 - z0) * 0.45));
  const st = [0, 1, 2].map((k) => stations(lo[k], hi[k], rr, seg, cell));
  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  const p = [0, 0, 0];
  // each face: its normal axis and sign, and the two in-plane axes (a, b) with a × b along the outward normal
  const faces: Array<[number, number, number, number]> = [
    [0, 1, 1, 2], [0, -1, 2, 1],
    [1, 1, 2, 0], [1, -1, 0, 2],
    [2, 1, 0, 1], [2, -1, 1, 0],
  ];
  for (const [axis, sign, a, b] of faces) {
    const base = pos.length / 3;
    const sa = st[a];
    const sb = st[b];
    for (let j = 0; j < sb.length; j++) {
      for (let i = 0; i < sa.length; i++) {
        p[axis] = sign > 0 ? hi[axis] : lo[axis];
        p[a] = sa[i];
        p[b] = sb[j];
        const q = [0, 1, 2].map((k) => Math.min(hi[k] - rr, Math.max(lo[k] + rr, p[k])));
        const d = [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
        const len = Math.hypot(d[0], d[1], d[2]) || 1;
        for (let k = 0; k < 3; k++) {
          pos.push(q[k] + (d[k] / len) * rr);
          nor.push(d[k] / len);
        }
      }
    }
    const w = sa.length;
    for (let j = 0; j + 1 < sb.length; j++) {
      for (let i = 0; i + 1 < w; i++) {
        const v = base + j * w + i;
        idx.push(v, v + 1, v + w + 1, v, v + w + 1, v + w);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

/**
 * Split every edge longer than `maxEdge` at its midpoint until none is left — a triangle with one long edge
 * becomes two, with two three, with three four. The test is the edge's own length, and both triangles that
 * share an edge see the same length and the same midpoint, so they split it alike: no T-junction, no crack
 * once the vertices are moved. Returns non-indexed geometry with position only.
 */
export function subdivideToEdge(geometry: THREE.BufferGeometry, maxEdge: number): THREE.BufferGeometry {
  const src = geometry.index !== null ? geometry.toNonIndexed() : geometry;
  const p = src.attributes.position;
  let tris: number[] = [];
  for (let i = 0; i < p.count; i++) tris.push(p.getX(i), p.getY(i), p.getZ(i));
  const m2 = maxEdge * maxEdge;
  for (let pass = 0; pass < 16; pass++) {
    const out: number[] = [];
    let split = false;
    for (let t = 0; t < tris.length; t += 9) {
      const A = tris.slice(t, t + 3);
      const B = tris.slice(t + 3, t + 6);
      const C = tris.slice(t + 6, t + 9);
      const long = (u: number[], v: number[]): boolean => (u[0] - v[0]) ** 2 + (u[1] - v[1]) ** 2 + (u[2] - v[2]) ** 2 > m2;
      const mid = (u: number[], v: number[]): number[] => [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2, (u[2] + v[2]) / 2];
      const ab = long(A, B);
      const bc = long(B, C);
      const ca = long(C, A);
      const n = +ab + +bc + +ca;
      if (n === 0) {
        out.push(...A, ...B, ...C);
        continue;
      }
      split = true;
      if (n === 3) {
        const m1 = mid(A, B);
        const m2v = mid(B, C);
        const m3 = mid(C, A);
        out.push(...A, ...m1, ...m3, ...m1, ...B, ...m2v, ...m3, ...m2v, ...C, ...m1, ...m2v, ...m3);
      } else if (n === 1) {
        // rotate so the long edge is the first (P→Q, R opposite)
        const [P, Q, R] = ab ? [A, B, C] : bc ? [B, C, A] : [C, A, B];
        const m = mid(P, Q);
        out.push(...P, ...m, ...R, ...m, ...Q, ...R);
      } else {
        // two long edges: rotate so they are P→Q and Q→R (R→P short)
        const [P, Q, R] = !ca ? [A, B, C] : !ab ? [B, C, A] : [C, A, B];
        const m1 = mid(P, Q);
        const m2v = mid(Q, R);
        out.push(...m1, ...Q, ...m2v, ...P, ...m1, ...m2v, ...P, ...m2v, ...R);
      }
    }
    tris = out;
    if (!split) break;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(tris, 3));
  return g;
}

/** move every vertex by `offset(x, y, z)` (piece-local metres) */
function warp(geometry: THREE.BufferGeometry, offset: (x: number, y: number, z: number, out: THREE.Vector3) => void): void {
  const p = geometry.attributes.position;
  const d = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    d.set(0, 0, 0);
    offset(p.getX(i), p.getY(i), p.getZ(i), d);
    p.setXYZ(i, p.getX(i) + d.x, p.getY(i) + d.y, p.getZ(i) + d.z);
  }
  p.needsUpdate = true;
}

/** weld by position (normals dropped first, so the faces' seams merge) and re-derive smooth normals */
function smoothNormals(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  geometry.deleteAttribute('normal');
  const g = mergeVertices(geometry, 1e-5);
  g.computeVertexNormals();
  return g;
}

/** the piece's own seed: its id hashed (as the materials key their per-piece look, raftMaterialNodes.ts) */
function seedOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h % 100003);
}

/**
 * THE EAVE THINS TO A FRINGE. A thatch's courses are thick where they lie on the laths and thin to the reed tips
 * at the free edges — the eave and the two gable ends — where a slab's constant 11 cm edge read as a board (the
 * user: "too thick, slabby and regular"). Every vertex is drawn up toward the slab's top over the last quarter of
 * the run and the last tenth of the ridge's length: a monotonic squeeze of y, so the courses keep their order and
 * their steps, only shallower, and nothing passes through anything. The laths ride the same squeeze.
 */
function roofThin(def: PieceDef, roofShape: Record<string, number>, slabMinX: number, slabMaxX: number, k: number): (x: number, y: number, z: number, out: THREE.Vector3) => void {
  const sign = roofShape.eaveSign ?? 1;
  const halfZ = Math.max(1e-3, (def.aabb.max[2] - def.aabb.min[2]) / 2);
  const run = Math.max(1e-3, slabMaxX - slabMinX);
  const ridgeX = sign > 0 ? slabMinX : slabMaxX;
  const top = def.aabb.max[1];
  const ramp = (a: number, b: number, t: number): number => {
    const u = Math.min(1, Math.max(0, (t - a) / (b - a)));
    return u * u * (3 - 2 * u);
  };
  return (x, y, z, out) => {
    const down = Math.min(1, Math.max(0, ((x - ridgeX) * sign) / run));
    const end = ramp(0.86, 1, Math.abs(z) / halfZ);
    const squeeze = Math.max(ramp(0.72, 1, down), end * 0.85) * 0.68 * k;
    out.set(0, (top - y) * squeeze, 0);
  };
}

/**
 * THE FRINGE: tufts of reed hanging from the eave and the gable ends, each its own length (5–22 cm), width,
 * droop and splay — the ragged edge a thatch has and a slab cannot. Each tuft is a thin tapered blade, rooted a
 * few cm in under the edge it hangs from (found on the slab itself: the outermost vertices along the edge, so
 * the eave's own ragged butts carry their tufts), drooping and curling down. In the slab's frame, positions
 * only (the caller subdivides and warps it with the slab).
 */
function thatchFringe(slab: THREE.BufferGeometry, roofShape: Record<string, number>, seed: number): THREE.BufferGeometry {
  const sign = roofShape.eaveSign ?? 1;
  const p = slab.attributes.position;
  const out: number[] = [];
  const box = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
  const bp = box.attributes.position;
  const v = new THREE.Vector3();
  /** one tuft at `root`, hanging along `dir` (unit), its blade across `across` (unit) */
  const tuft = (root: THREE.Vector3, dir: THREE.Vector3, acrossIn: THREE.Vector3, len: number, w: number, t: number): void => {
    let across = acrossIn.clone();
    let thick = new THREE.Vector3().crossVectors(dir, across).normalize();
    // keep the box's winding: the map (across, thick, dir) must not mirror it
    if (new THREE.Vector3().crossVectors(across, thick).dot(dir) < 0) {
      across = across.negate();
      thick = new THREE.Vector3().crossVectors(dir, across).normalize();
    }
    for (let i = 0; i < bp.count; i++) {
      const lx = bp.getX(i);
      const ly = bp.getY(i);
      const along = bp.getZ(i) + 0.5;
      const taper = 1 - 0.75 * along;
      v.copy(root)
        .addScaledVector(dir, along * len)
        .addScaledVector(across, lx * w * taper)
        .addScaledVector(thick, ly * t * taper);
      // the tip curls down under its own weight
      v.y -= along * along * len * 0.25;
      out.push(v.x, v.y, v.z);
    }
  };
  // the edges, sampled from the slab: the outermost vertex (and the lowest one near it) per bin along the edge
  const bins = (axis: 'x' | 'z', outward: (i: number) => number, binW: number): Map<number, { tip: number; low: number }> => {
    const m = new Map<number, { tip: number; low: number }>();
    for (let i = 0; i < p.count; i++) {
      const b = Math.round((axis === 'z' ? p.getZ(i) : p.getX(i)) / binW);
      const o = outward(i);
      const e = m.get(b);
      if (!e || o > e.tip + 1e-4) m.set(b, { tip: o, low: p.getY(i) });
      else if (o > e.tip - 0.04) e.low = Math.min(e.low, p.getY(i));
    }
    return m;
  };
  const STEP = 0.022;
  /** a tuft's length: mostly short, the odd long straggler */
  const lengthOf = (h1: number, h2: number, scale: number): number => (0.035 + 0.09 * h1 * h1 + (h2 > 0.86 ? 0.07 * (h2 - 0.86) / 0.14 : 0)) * scale;
  // the eave, along z: two staggered rows, the under one longer and hanging steeper
  const eave = bins('z', (i) => p.getX(i) * sign, STEP);
  let n = 0;
  for (const [b, e] of eave) {
    for (const row of [0, 1]) {
      const z = b * STEP + (vhash(seed, 1, b, row) - 0.5) * STEP * 1.2;
      const len = lengthOf(vhash(seed, 2, b, row), vhash(seed, 12, b, row), row ? 1.25 : 1);
      const droop = (row ? 0.75 : 0.45) + 0.55 * vhash(seed, 3, b, row);
      const splay = (vhash(seed, 4, b, row) - 0.5) * 0.6;
      const dir = new THREE.Vector3(sign * Math.cos(droop), -Math.sin(droop), splay).normalize();
      tuft(new THREE.Vector3((e.tip - 0.03 - row * 0.03) * sign, e.low + 0.005 - row * 0.004, z), dir, new THREE.Vector3(0, 0, 1), len, 0.014 + 0.022 * vhash(seed, 5, b, row), 0.005);
      n++;
    }
  }
  // the gable ends, along x (each end its own sign), clear of the ridge
  for (const zs of [-1, 1]) {
    const end = bins('x', (i) => p.getZ(i) * zs, STEP);
    for (const [b, e] of end) {
      const x = b * STEP + (vhash(seed, 6, b, zs) - 0.5) * STEP * 0.8;
      const len = lengthOf(vhash(seed, 7, b, zs), vhash(seed, 13, b, zs), 0.9);
      const droop = 0.6 + 0.6 * vhash(seed, 8, b, zs);
      const splay = (vhash(seed, 9, b, zs) - 0.5) * 0.4;
      const dir = new THREE.Vector3(splay, -Math.sin(droop), zs * Math.cos(droop)).normalize();
      tuft(new THREE.Vector3(x, e.low + 0.006, (e.tip - 0.03) * zs), dir, new THREE.Vector3(1, 0, 0), len, 0.014 + 0.02 * vhash(seed, 10, b, zs), 0.005);
      n++;
    }
  }
  box.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  void n;
  return g;
}

/** two non-indexed position-only geometries as one */
function concat(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
  const pa = (a.index ? a.toNonIndexed() : a).attributes.position.array as Float32Array;
  const pb = (b.index ? b.toNonIndexed() : b).attributes.position.array as Float32Array;
  const out = new Float32Array(pa.length + pb.length);
  out.set(pa, 0);
  out.set(pb, pa.length);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(out, 3));
  return g;
}

/**
 * THE ROOF'S SAG, shared by the thatch and the laths under it (both in the slab's own frame: the laths ride it,
 * raftPartsCabin.ts) so they move together and never part. Local x runs down the slope (`eaveSign`: which way),
 * z along the ridge; the ridge pole sags between the gables, the eave droops more, and the whole is lumpy — but
 * not AT the ridge, where the two slopes must still meet.
 */
function roofSag(def: PieceDef, roofShape: Record<string, number>, slabMinX: number, slabMaxX: number, k: number): (x: number, y: number, z: number, out: THREE.Vector3) => void {
  const sign = roofShape.eaveSign ?? 1;
  const halfZ = Math.max(1e-3, (def.aabb.max[2] - def.aabb.min[2]) / 2);
  const run = Math.max(1e-3, slabMaxX - slabMinX);
  const ridgeX = sign > 0 ? slabMinX : slabMaxX;
  const seed = 4127;
  return (x, _y, z, out) => {
    // 0 at the ridge → 1 at the eave
    const down = Math.min(1, Math.max(0, ((x - ridgeX) * sign) / run));
    // the span between the gables: the ridge pole sags ~4 cm mid-length, the eave a little more; the gable
    // overhangs (beyond the walls, |z| > halfZ − overhang) droop at their free ends
    const along = Math.min(1, Math.abs(z) / halfZ);
    const span = 1 - along * along;
    const tip = Math.max(0, (along - 0.88) / 0.12);
    const sag = 0.04 * span * (0.6 + 0.4 * down) + 0.03 * tip * tip + 0.025 * down * down;
    // lumps: the thatch was laid by hand, a course thicker here, thinner there (faded out at the ridge)
    const lump = noise2(z * 1.6, down * 2.2, seed + sign) * 0.02 * Math.min(1, down * 5);
    // every course's butt wanders up and down the slope along the ridge (so no course line is ruled), and the
    // eave's the most
    const wander = noise2(z * 2.4, down * 3.1, seed + 5 * sign) * 0.022 * Math.min(1, down * 5);
    const ragged = noise2(z * 3.1, 0.5, seed + 11 * sign) * 0.03 * down ** 4;
    out.set((wander + ragged) * sign * k, (lump - sag) * k, 0);
  };
}

/**
 * A log as pieceGeometryRaft.buildLogGeometry lays it (full-round trunk, the taper over its last `taperLen`, the
 * chamfered bow tip) but with RINGS every `cell` m along it, so it can bend and swell without being subdivided.
 * Non-indexed, positions only.
 */
function logRings(def: PieceDef, cell: number): THREE.BufferGeometry {
  const shape = def.shape ?? {};
  const { min, max } = def.aabb;
  const sx = max[0] - min[0];
  const sz = max[2] - min[2];
  const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const r = sx / 2;
  const taper = Math.min(1, Math.max(0.3, shape.taper ?? 1));
  const chamfer = Math.min(sz * 0.4, Math.max(0, shape.chamfer ?? 0));
  const sides = Math.max(6, Math.round(shape.sides ?? 12));
  const bodyLen = sz - chamfer;
  const rBow = r * taper;
  const taperLen = Math.min(bodyLen, Math.max(0, shape.taperLen ?? bodyLen));
  const trunkLen = bodyLen - taperLen;
  const parts: THREE.BufferGeometry[] = [];
  const seg = (len: number): number => Math.max(1, Math.ceil(len / cell));
  if (trunkLen > 1e-4) parts.push(new THREE.CylinderGeometry(r, r, trunkLen, sides, seg(trunkLen)).rotateX(Math.PI / 2).translate(0, 0, -sz / 2 + trunkLen / 2));
  if (taperLen > 1e-4) parts.push(new THREE.CylinderGeometry(rBow, r, taperLen, sides, seg(taperLen)).rotateX(Math.PI / 2).translate(0, 0, -sz / 2 + trunkLen + taperLen / 2));
  if (chamfer > 0) parts.push(new THREE.CylinderGeometry(rBow * 0.3, rBow, chamfer, sides, seg(chamfer)).rotateX(Math.PI / 2).translate(0, 0, sz / 2 - chamfer / 2));
  const len = parts.reduce((t, g) => t + (g.index ? g.index.count : g.attributes.position.count) * 3, 0);
  const pos = new Float32Array(len);
  let o = 0;
  for (const g of parts) {
    const a = (g.index ? g.toNonIndexed() : g).attributes.position.array as Float32Array;
    pos.set(a, o);
    o += a.length;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return g.translate(c[0], c[1], c[2]);
}

/**
 * The worn twin of a piece's greybox geometry (see the header), or null when the piece is left as built.
 * `base` is the greybox (pieceGeometry.ts's own); `roof` the thatch slab a roof lath rides, so the two sag as one.
 */
export function wornPieceGeometry(def: PieceDef, base: THREE.BufferGeometry, opts: WearOptions = {}, roof?: PieceDef): THREE.BufferGeometry | null {
  const k = opts.amount ?? 1;
  const cell = (opts.cell ?? CELL[def.kind] ?? 0.1) * (opts.cellScale ?? 1);
  const { min, max } = def.aabb;
  const sx = max[0] - min[0];
  const sy = max[1] - min[1];
  const sz = max[2] - min[2];
  const seed = seedOf(def.id);
  const shape = def.shape ?? {};
  switch (def.kind) {
    case 'cabin-wall': {
      // the panel's thin axis (x for a side wall, z for a gable), the long one in its plane, and up
      const thinX = sx < sz;
      const gable = (shape.gable ?? 0) > 0;
      let g: THREE.BufferGeometry;
      if (gable) {
        // the pentagon, extruded with its edges rounded: the shape inset by the bevel so it still fills the aabb
        const b = Math.min(0.012, sz * 0.3);
        const eave = sy - shape.gable!;
        const prof = new THREE.Shape();
        prof.moveTo(-sx / 2 + b, b);
        prof.lineTo(sx / 2 - b, b);
        prof.lineTo(sx / 2 - b, eave - b * 0.5);
        prof.lineTo(0, sy - b * 1.6);
        prof.lineTo(-sx / 2 + b, eave - b * 0.5);
        prof.closePath();
        g = new THREE.ExtrudeGeometry(prof, { depth: sz - 2 * b, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelSegments: 2, curveSegments: 1 });
        g.translate(0, min[1], min[2] + b);
        g = subdivideToEdge(g, cell);
      } else {
        g = softBox(min[0], max[0], min[1], max[1], min[2], max[2], 0.014, cell).toNonIndexed();
        g.deleteAttribute('normal');
      }
      const halfL = (thinX ? sz : sx) / 2;
      warp(g, (x, y, z, out) => {
        const l = thinX ? z : x;
        const h = (y - min[1]) / sy;
        const e = Math.max(0, 1 - (l / halfL) ** 2);
        // bulge between the corner posts, a lean at the top, a slow wander, and the top edge not quite level
        const bulge = (0.018 * e * Math.sin(Math.PI * Math.min(1, h * 1.15)) + 0.012 * h * (vhash(seed, 1) * 2 - 1)) * (vhash(seed, 2) > 0.3 ? 1 : -1);
        const wander = noise2(l * 1.3, h * 1.7, seed) * 0.008;
        const off = (bulge + wander) * k;
        const lift = noise1(l * 2.2 + 3, seed + 5) * 0.012 * h ** 6 * k;
        if (thinX) out.set(off, lift, 0);
        else out.set(0, lift, off);
      });
      return smoothNormals(g);
    }
    case 'thatch-roof': {
      // thinned to its free edges, the fringe hung from them, then subdivided and sagged as one
      const slab = base.index !== null ? base.toNonIndexed() : base.clone();
      for (const name of Object.keys(slab.attributes)) if (name !== 'position') slab.deleteAttribute(name);
      warp(slab, roofThin(def, shape, min[0], max[0], k));
      const g = subdivideToEdge(concat(slab, thatchFringe(slab, shape, seed)), cell);
      warp(g, roofSag(def, shape, min[0], max[0], k));
      return toCreasedNormals(g, Math.PI / 5);
    }
    case 'bamboo-deck': {
      if ((shape.laths ?? 0) > 0 && roof !== undefined) {
        // the laths under the thatch: the roof's sag, in the roof's frame (they ride it at the identity)
        const g = subdivideToEdge(base, (opts.cell ?? CELL['thatch-roof']!) * (opts.cellScale ?? 1));
        warp(g, roofThin(roof, roof.shape ?? {}, roof.aabb.min[0], roof.aabb.max[0], k));
        warp(g, roofSag(roof, roof.shape ?? {}, roof.aabb.min[0], roof.aabb.max[0], k));
        return toCreasedNormals(g, Math.PI / 5);
      }
      // INDOORS: the two straw mattresses, stuffed and slumped (rounded hard, the top domed and lumpy, the sides
      // bellied), and the loose reed mats on the floor, soft-edged and lying not quite flat
      if (def.id.startsWith('berth-')) {
        const r = Math.min(0.05, sy * 0.4);
        const g = softBox(min[0], max[0], min[1], max[1], min[2], max[2], r, 0.08).toNonIndexed();
        g.deleteAttribute('normal');
        const cy = (min[1] + max[1]) / 2;
        warp(g, (x, y, z, out) => {
          const ex = Math.max(0, 1 - ((2 * (x - (min[0] + max[0]) / 2)) / sx) ** 2);
          const ez = Math.max(0, 1 - ((2 * (z - (min[2] + max[2]) / 2)) / sz) ** 2);
          const up = y > cy ? 1 : 0;
          const lump = noise2(x * 5, z * 3, seed) * 0.012;
          out.set(0, (up * (0.022 * ex * ez + lump * ex) - (1 - up) * 0.0) * k, 0);
        });
        return smoothNormals(g);
      }
      if (def.id.startsWith('floor-mat-')) {
        const g = softBox(min[0], max[0], min[1], max[1], min[2], max[2], 0.004, 0.15).toNonIndexed();
        g.deleteAttribute('normal');
        warp(g, (x, _y, z, out) => out.set(0, (0.003 + 0.003 * noise2(x * 1.4, z * 1.4, seed)) * k, 0));
        return smoothNormals(g);
      }
      // a mat on the deck (never the cabin floor or what lies on it: they are indoors), lying on the crossbeams'
      // crowns — up, never down into them — and its edges soft and a little ragged
      if (def.parent !== undefined || (shape.mat ?? 0) === 0) return null;
      const g = softBox(min[0], max[0], min[1], max[1], min[2], max[2], 0.006, cell).toNonIndexed();
      g.deleteAttribute('normal');
      // (and its edge is not a ruled line: the mat's cut ends and selvedges wander a couple of cm in and out)
      const hx = (max[0] - min[0]) / 2;
      const hz = (max[2] - min[2]) / 2;
      const cx = (min[0] + max[0]) / 2;
      const cz = (min[2] + max[2]) / 2;
      warp(g, (x, _y, z, out) => {
        const ex = Math.max(0, 1 - (hx - Math.abs(x - cx)) / 0.04);
        const ez = Math.max(0, 1 - (hz - Math.abs(z - cz)) / 0.04);
        out.set(
          Math.sign(x - cx) * ex * noise2(z * 3.1, 0.5, seed + 3) * 0.025 * k,
          (0.004 + 0.004 * noise2(x * 0.9, z * 0.9, seed)) * k,
          Math.sign(z - cz) * ez * noise2(x * 3.1, 1.5, seed + 4) * 0.025 * k,
        );
      });
      return smoothNormals(g);
    }
    // THE LOGS (the bow and sides of the museum raft, the user 2026-10-29: "the log ends, their irregular lengths
    // and cut faces … taper and irregular diameter … nothing straight or aligned"): each log's girth swells and
    // pinches along it and is not quite round, it bows a little, its ends are cut at its own length and its own
    // slant with the axe's unevenness on the faces. Small — the logs were already the part the user liked.
    case 'log': {
      // (rebuilt with rings along it rather than subdivided: a 13.7 m log's long thin quads split by edge length
      // cost 100k triangles across the nine logs; rings every `cell` m cost under 8k)
      const g = logRings(def, cell);
      const cx = (min[0] + max[0]) / 2;
      const cy = (min[1] + max[1]) / 2;
      const r = sx / 2;
      const len = sz;
      const bowStretch = (vhash(seed, 21) * 2 - 1) * 0.14;
      const sternStretch = (vhash(seed, 22) * 2 - 1) * 0.06;
      const tiltA = (vhash(seed, 23) * 2 - 1) * 0.14;
      const tiltB = (vhash(seed, 24) * 2 - 1) * 0.1;
      warp(g, (x, y, z, out) => {
        const dx = x - cx;
        const dy = y - cy;
        const rho = Math.hypot(dx, dy);
        const th = Math.atan2(dy, dx);
        const t = (z - min[2]) / len;
        // girth: a slow swell along the log and a lumpy section, only on the barrel (not the cut faces' centres)
        const barrel = Math.min(1, rho / (r * 0.6));
        const girth = (noise1(z * 0.7, seed) - 0.5) * 0.09 + noise2(z * 2.3, th * 1.6, seed + 1) * 0.025;
        const gx = rho > 1e-6 ? (dx / rho) * rho * girth * barrel : 0;
        const gy = rho > 1e-6 ? (dy / rho) * rho * girth * barrel : 0;
        // a bow along it (never more than a couple of cm: the neighbours are lashed hard against it)
        const bowX = (noise1(z * 0.22 + 4, seed + 2) - 0.5) * 0.03;
        const bowY = (noise1(z * 0.31 + 9, seed + 3) - 0.5) * 0.02;
        // the ends: each log its own length, its faces cut on a slant, axe-rough
        const atBow = Math.max(0, (t - 0.94) / 0.06);
        const atStern = Math.max(0, (0.03 - t) / 0.03);
        const face = (Math.abs(z - max[2]) < 0.012 ? 1 : 0) + (Math.abs(z - min[2]) < 0.012 ? 1 : 0);
        const cut = face * (tiltA * dx + tiltB * dy + noise2(dx * 18, dy * 18, seed + 5) * 0.012);
        out.set((gx + bowX) * k, (gy + bowY) * k, (bowStretch * atBow - sternStretch * atStern + cut) * k);
      });
      return toCreasedNormals(g, Math.PI / 4);
    }
    case 'crossbeam': {
      const g = new THREE.CylinderGeometry(sy / 2, sy / 2, sx, Math.max(6, Math.round(shape.sides ?? 10)), Math.max(1, Math.ceil(sx / cell)))
        .rotateZ(Math.PI / 2)
        .translate((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2)
        .toNonIndexed();
      g.deleteAttribute('normal');
      g.deleteAttribute('uv');
      const cy = (min[1] + max[1]) / 2;
      const cz = (min[2] + max[2]) / 2;
      const r = sy / 2;
      warp(g, (x, y, z, out) => {
        const dy = y - cy;
        const dz = z - cz;
        const rho = Math.hypot(dy, dz);
        const th = Math.atan2(dy, dz);
        const girth = (noise1(x * 0.9, seed) - 0.5) * 0.1 + noise2(x * 2.6, th * 1.6, seed + 1) * 0.03;
        const barrel = Math.min(1, rho / (r * 0.6));
        // a hump up between the logs it rests on, never down into them
        const hump = noise1(x * 0.6 + 2, seed + 2) * 0.012;
        out.set(0, (rho > 1e-6 ? dy * girth * barrel : 0) + hump * k, (rho > 1e-6 ? dz * girth * barrel : 0) * k);
      });
      return toCreasedNormals(g, Math.PI / 4);
    }
    // THE LASHINGS, heavy (the museum raft: "many turns, frayed"): the game's band round each crossbeam is a smooth
    // sleeve and its ring round the log one hoop; here the sleeve is ridged turn by turn and each hoop is two
    // turns, every turn a little off its neighbour, the whole a little slack
    case 'lashing': {
      const n = Math.max(0, Math.round(shape.n ?? 0));
      if (n === 0) return null;
      const rope = Math.max(0.01, shape.rope ?? 0.03);
      const turns = Math.max(1, Math.round(shape.turns ?? 4));
      const beamR = shape.beamR ?? max[1];
      const logR = shape.logR ?? beamR;
      const parts: THREE.BufferGeometry[] = [];
      for (let c = 0; c < n; c++) {
        const x = shape[`x${c}`] ?? 0;
        const turnsHere = turns + 1 + Math.round(vhash(seed, 31, c) * 2);
        const width = rope * turnsHere;
        // the sleeve: its radius rises and falls turn by turn (a rope's crown every `rope`), lumpy
        const sleeve = new THREE.CylinderGeometry(1, 1, width, 12, turnsHere * 4, true);
        const sp = sleeve.attributes.position;
        for (let i = 0; i < sp.count; i++) {
          const yy = sp.getY(i);
          const a = Math.atan2(sp.getZ(i), sp.getX(i));
          const crown = Math.abs(Math.sin(((yy + width / 2) / rope) * Math.PI));
          const rr = beamR + rope * (0.35 + 0.45 * crown) + noise2(a * 2, yy * 30, seed + c) * rope * 0.25;
          sp.setXYZ(i, Math.cos(a) * rr, yy + Math.sin(a * 2 + c) * rope * 0.3, Math.sin(a) * rr);
        }
        sleeve.rotateZ(Math.PI / 2);
        sleeve.translate(x, 0, 0);
        parts.push(sleeve.toNonIndexed());
        if ((shape.ring ?? 1) <= 0) continue;
        for (let tt = 0; tt < 2; tt++) {
          const ring = new THREE.TorusGeometry(logR + rope * 0.6, rope * 0.5, 4, 12);
          ring.rotateY(((vhash(seed, 32, c, tt) * 2 - 1) * 0.12));
          ring.translate(x, -(beamR + logR) + (tt - 0.5) * rope * 0.3, (tt - 0.5) * rope * 1.1);
          parts.push(ring.toNonIndexed());
        }
      }
      const len = parts.reduce((t, g) => t + g.attributes.position.array.length, 0);
      const pos = new Float32Array(len);
      let o = 0;
      for (const g of parts) {
        pos.set(g.attributes.position.array as Float32Array, o);
        o += g.attributes.position.array.length;
      }
      const out = new THREE.BufferGeometry();
      out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      return toCreasedNormals(out, Math.PI / 3);
    }
    case 'splashboard':
    case 'guara': {
      if ((shape.collar ?? 0) > 0) {
        // the slotted collar: its own boxes, warped a little and edge-softened by a creased normal
        const g = subdivideToEdge(base, 0.1);
        warp(g, (x, y, z, out) => out.set(noise2(y * 4, z * 4, seed) * 0.004 * k, noise2(x * 4, z * 4, seed + 1) * 0.003 * k, 0));
        return toCreasedNormals(g, Math.PI / 6);
      }
      // a sawn plank: the thin axis, the long one; it bows along its length, twists, and its top edge is worn
      const axes = [sx, sy, sz];
      const thin = axes.indexOf(Math.min(...axes));
      const long = axes.indexOf(Math.max(...axes));
      const r = Math.min(0.01, axes[thin] * 0.4);
      const g = softBox(min[0], max[0], min[1], max[1], min[2], max[2], r, cell).toNonIndexed();
      g.deleteAttribute('normal');
      const halfL = axes[long] / 2;
      const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
      const other = 3 - thin - long;
      warp(g, (x, y, z, out) => {
        const v = [x, y, z];
        const l = (v[long] - c[long]) / halfL;
        const w = (v[other] - c[other]) / Math.max(1e-3, axes[other] / 2);
        const bow = 0.008 * (1 - l * l) * (vhash(seed, 3) * 2 - 1);
        const twist = 0.006 * l * w * (vhash(seed, 4) * 2 - 1);
        const o = [0, 0, 0];
        o[thin] = (bow + twist + noise2(l * 3, w, seed) * 0.002) * k;
        out.set(o[0], o[1], o[2]);
      });
      return smoothNormals(g);
    }
  }
  return null;
}

/**
 * THE SLACK-ROPE RAILING, rebuilt so the rope is MADE FAST to its posts (the user: "the rope doesn't reach the
 * tip of the cylinder posts"). The game's `rope-rail` (pieceGeometryRaft.ts) runs its rope at the rail's nominal
 * height while each post is cut ±9% long and leans a little, so the rope floats over the short posts and the tall
 * ones stand up through nothing. Here the posts are the game's own stations, lengths and leans (the same seeded
 * jitters, so it is the same railing), and the rope is led over each post's own head — a few turns round it just
 * under the top — and sags between, each span its own dip. Returns the rope (with its turns) as one geometry and
 * the posts as foot/head points with a radius, in the piece's frame, for the caller to draw in wood.
 */
export function ropeRailParts(def: PieceDef): { rope: THREE.BufferGeometry; posts: Array<{ foot: THREE.Vector3; head: THREE.Vector3; r: number }> } | null {
  const shape = def.shape ?? {};
  const n = Math.max(0, Math.round(shape.posts ?? 0));
  if (n < 2) return null;
  const { min, max } = def.aabb;
  const sz = max[2] - min[2];
  const postR = Math.max(0.008, shape.postRadius ?? 0.04);
  const ropeR = Math.max(0.003, shape.rope ?? 0.02);
  const sag = Math.max(0, shape.sag ?? 0);
  const seed = shape.seed ?? 0;
  const top = max[1];
  const foot = min[1];
  const cx = (min[0] + max[0]) / 2;
  // (the game's own jitters: vjitter(a, ...k) = (vhash(...k)·2 − 1)·a)
  const jit = (a: number, ...k: number[]): number => (vhash(...k) * 2 - 1) * a;
  const posts: Array<{ foot: THREE.Vector3; head: THREE.Vector3; r: number }> = [];
  for (let k = 0; k < n; k++) {
    const z = min[2] + (sz * k) / (n - 1) + jit(sz * 0.035, seed, 71, k);
    const hk = (top - foot) * (1 + jit(0.09, seed, 72, k));
    // the post's axis leaned as the game leans it (rotateZ, then rotateX, about its centre)
    const axis = new THREE.Vector3(0, hk / 2, 0).applyAxisAngle(new THREE.Vector3(0, 0, 1), jit(0.07, seed, 73, k)).applyAxisAngle(new THREE.Vector3(1, 0, 0), jit(0.05, seed, 74, k));
    const centre = new THREE.Vector3(cx, foot + hk / 2, z);
    posts.push({ foot: centre.clone().sub(axis), head: centre.clone().add(axis), r: postR });
  }
  // the rope's line: just under each head, sagging between
  const pts: THREE.Vector3[] = [];
  const under = (k: number): THREE.Vector3 => {
    const { foot: f, head: h } = posts[k];
    return h.clone().lerp(f, 0.045 / h.distanceTo(f));
  };
  for (let k = 0; k + 1 < n; k++) {
    const a = under(k);
    const b = under(k + 1);
    const dip = sag * (0.6 + 0.8 * vhash(seed, 75, k));
    const steps = 10;
    for (let j = k === 0 ? 0 : 1; j <= steps; j++) {
      const t = j / steps;
      pts.push(a.clone().lerp(b, t).add(new THREE.Vector3(0, -dip * 4 * t * (1 - t), 0)));
    }
  }
  const parts: THREE.BufferGeometry[] = [new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length * 2, ropeR, 5, false).toNonIndexed()];
  // the turns round each head
  posts.forEach((post, k) => {
    const axis = new THREE.Vector3().subVectors(post.head, post.foot).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
    const turns = 3;
    for (let i = 0; i < turns; i++) {
      const t = new THREE.TorusGeometry(post.r * 0.95 + ropeR * 0.7, ropeR, 5, 12);
      t.rotateX(((i % 2 ? 1 : -1) * 0.18) + jit(0.05, seed, 76, k, i));
      t.applyQuaternion(q);
      const at = under(k).addScaledVector(axis, (i - 1) * ropeR * 1.9);
      t.translate(at.x, at.y, at.z);
      parts.push(t.toNonIndexed());
    }
  });
  const len = parts.reduce((s, g) => s + g.attributes.position.array.length, 0);
  const pos = new Float32Array(len);
  let o = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array as Float32Array, o);
    o += g.attributes.position.array.length;
  }
  const rope = new THREE.BufferGeometry();
  rope.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return { rope: toCreasedNormals(rope, Math.PI / 2), posts };
}
