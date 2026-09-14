/**
 * MINIMUM PROJECTED WIDTH for thin geometry — §V41's phone-wire AA [Persson 2012], ONE implementation (§V95) for
 * the pirate ropes and the speedboat course's lattice pylons, radio mast, spars and cables.
 *
 * THE PROBLEM. A member of fixed world width (a 16 cm pylon leg, a 3.6 cm conductor) shrinks with distance. Under a
 * pixel the rasteriser misses the pixel centre on some rows and hits it on others: the member goes dashed, the dashes
 * crawl as the camera moves, then it is gone. More samples do not cure it — the geometry is genuinely sub-pixel.
 *
 * THE FIX. Never draw a member thinner than `minWidthPx`: push each vertex out from the member's AXIS by
 * `widen = max(1, minWidthPx / widthPx)`, and pay the widening back as COVERAGE `1 / widen`. Drawn width × coverage is
 * the true width at every distance, so a far pylon reads as a faint continuous line, not a thick one, and fades out
 * smoothly instead of breaking up — no distance threshold, no pop.
 *
 * WHY PIXELS, NEVER METRES (§V36): the projected width is derived from the pass's own projection and viewport, so it
 * is right in the half-res reflection pass, at any FOV and at the trailer's 640×360 look passes and 1080p master.
 *
 * COVERAGE ON OPAQUE GEOMETRY. Ropes and the course cables are their own transparent meshes and blend it (`blend`).
 * The lattice lives in the course's opaque BatchedMeshes (the ocean's refraction copy must still see the drowned
 * legs), so there it is a hashed discard (`hash`): a per-pixel interleaved-gradient threshold stepped by the golden
 * ratio each frame. The trailer's jittered subframes are separate frames, so N of them resolve coverage in ~1/N steps
 * per pixel, and live play averages it over frames — rather than the fixed dash the rasteriser made.
 *
 * WHERE THE AXIS COMES FROM. The course GLBs are triangle soups: flat-shaded faces, members joined per material, the
 * far LODs decimated. {@link computeThinAxes} rebuilds the members on the CPU once at load (welded shells, then
 * parallel sliver runs where decimation fused a lattice into one shell) and stores each vertex's offset from its
 * member's axis plus the member's half-width in the `thinAxis` attribute. Vertices of anything that is not a thin
 * straight member (plates, caps of fat parts, hut walls) get zero and are never moved or dithered.
 *
 * The CPU functions here are the tested mirror of the TSL (tests/minWidth.test.ts), as phoneWireAA.ts is for ropes.
 */
import {
  cameraProjectionMatrix,
  cameraViewMatrix,
  drawIndex,
  float,
  frameId,
  Fn,
  hash,
  instanceIndex,
  int,
  ivec2,
  mat3,
  mat4,
  max,
  min,
  modelWorldMatrix,
  positionLocal,
  positionView,
  screenCoordinate,
  select,
  textureLoad,
  textureSize,
  varyingProperty,
  vec2,
  vec4,
  viewport,
  attribute,
} from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TSLNode = any;

/** the per-vertex attribute {@link computeThinAxes} writes: xyz = offset from the member axis, w = member half-width */
export const THIN_AXIS_ATTRIBUTE = 'thinAxis';

/**
 * Never draw a member narrower than this. A little over a pixel, not exactly one: the half-width is the member's
 * LARGEST offset from its axis, and an L-angle or a hexagonal tube seen along a flat presents 0.7–1× of that, so a
 * 1 px floor would still leave sub-pixel slivers on some rows.
 */
export const THIN_MIN_WIDTH_PX = 1.25;

/** divisor guard, CPU (same value as the rope mirror, src/ropes/phoneWireAA.ts) */
const EPS = 1e-6;
/** divisor guard, GPU (src/ropes/catenaryMath.ts Z_MIN — the rope WGSL is unchanged by the move here) */
const GPU_EPS = 1e-9;

// ── CPU mirror ─────────────────────────────────────────────────────────────

/**
 * The minimum-width response for a projected width. `widen` ≥ 1 scales the member's offsets from its axis so it is
 * drawn at least `minWidthPx` wide; `coverage` ≤ 1 pays that back. widen × coverage = 1 whenever widening happens,
 * which is the energy conservation the technique is for.
 */
export function minWidthResponse(projectedPx: number, minWidthPx: number): { widen: number; coverage: number } {
  const width = Math.max(projectedPx, 0);
  const widen = Math.max(1, minWidthPx / Math.max(width, EPS));
  // equivalently 1/widen, written so a zero-width member is coverage 0, not 0/0
  const coverage = Math.min(1, width / Math.max(minWidthPx, EPS));
  return { widen, coverage };
}

/**
 * Screen width (px) of a member of half-width `radius` at view depth `depth`: its NDC half-width is r·P00/w and NDC
 * spans 2 across `viewportWidthPx`. CPU mirror of {@link projectedWidthPx}.
 */
export function projectedWidthPxAt(radius: number, depth: number, projX: number, viewportWidthPx: number): number {
  return ((Math.abs(radius * projX) / Math.max(depth, GPU_EPS)) * viewportWidthPx);
}

// ── TSL ────────────────────────────────────────────────────────────────────

/**
 * Projected width IN PIXELS of geometry of world half-width `radius` at world point `worldPos`, in whichever pass is
 * drawing: a view-space offset of `radius` pushed through the projection gives the NDC half-width, divided by the
 * point's own clip w for perspective; NDC spans 2 across the viewport, so the full width covers ndcHalf · viewport.z.
 */
export function projectedWidthPx(worldPos: TSLNode, radius: TSLNode): TSLNode {
  const clip = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(worldPos, 1)));
  const clipW = max(clip.w, float(GPU_EPS));
  const ndcHalf = cameraProjectionMatrix.mul(vec4(radius, 0, 0, 0)).x.abs();
  return ndcHalf.div(clipW).mul(viewport.z);
}

/** TSL mirror of {@link minWidthResponse} */
export function minWidthWiden(widthPx: TSLNode, minWidthPx: TSLNode): { widen: TSLNode; coverage: TSLNode } {
  const widen = max(float(1), minWidthPx.div(max(widthPx, float(GPU_EPS))));
  const coverage = min(float(1), widthPx.div(max(minWidthPx, float(GPU_EPS))));
  return { widen, coverage };
}

/**
 * The linear part of the object's per-instance transform, for a BatchedMesh the matrix three's BatchNode applies
 * before `positionNode` runs (same texture fetch as `three/src/nodes/accessors/BatchNode.js`, r180), identity for a
 * plain Mesh. `thinAxis` offsets are in geometry space and must turn with the instance.
 */
const instanceLinear = Fn((builder: TSLNode) => {
  const object = builder.object;
  if (!object?.isBatchedMesh) return mat3(1, 0, 0, 0, 1, 0, 0, 0, 1);
  const id = builder.getDrawIndex() === null ? instanceIndex : drawIndex;
  const indirect = object._indirectTexture;
  const isize = int(textureSize(textureLoad(indirect), int(0)).x);
  const indirectId = textureLoad(indirect, ivec2(int(id).mod(isize), int(id).div(isize))).x;
  const matrices = object._matricesTexture;
  const size = int(textureSize(textureLoad(matrices), int(0)).x);
  const j = float(indirectId).mul(4).toInt().toVar();
  const x = j.mod(size);
  const y = j.div(size);
  // four column vectors: BatchNode's own form (the typings only list the 1- and 16-argument overloads)
  return mat3(
    (mat4 as TSLNode)(
      textureLoad(matrices, ivec2(x, y)),
      textureLoad(matrices, ivec2(x.add(1), y)),
      textureLoad(matrices, ivec2(x.add(2), y)),
      textureLoad(matrices, ivec2(x.add(3), y)),
    ),
  );
});

/**
 * Put minimum projected width on a node material whose geometry carries `thinAxis` ({@link computeThinAxes}).
 * `hash`: opaque, coverage as a per-frame hashed discard. `blend`: the caller's transparent material, coverage as
 * opacity. A vertex with no member (w = 0) is untouched and fully covered.
 */
export function applyMinWidth(
  material: { positionNode: TSLNode; maskNode?: TSLNode; opacityNode: TSLNode },
  mode: 'hash' | 'blend',
  minWidthPx: number = THIN_MIN_WIDTH_PX,
): void {
  const vCoverage = varyingProperty('float', 'vThinCoverage');
  material.positionNode = Fn(() => {
    const axis = attribute(THIN_AXIS_ATTRIBUTE, 'vec4');
    const member = axis.w.greaterThan(0);
    const offset = instanceLinear().mul(axis.xyz);
    const world = modelWorldMatrix.mul(vec4(positionLocal, 1)).xyz;
    // a non-member is given a huge radius, so it resolves to widen 1 / coverage 1 with no branch in the maths
    const widthPx = projectedWidthPx(world, select(member, axis.w, float(1e6)));
    const { widen, coverage } = minWidthWiden(widthPx, float(minWidthPx));
    vCoverage.assign(coverage);
    return positionLocal.add(offset.mul(widen.sub(1)));
  })();
  if (mode === 'blend') {
    material.opacityNode = vCoverage;
    return;
  }
  // interleaved gradient noise [Jimenez 2014] on the pixel, stepped by the golden ratio per frame, so N frames of one
  // member stratify. Offset by a hash of the fragment's 25 cm view-depth slab: members stacked in one pixel (the near
  // and far faces of a lattice) must pass INDEPENDENTLY, or five 10 % members cover 10 % of the pixel instead of 41 %
  // — measured: with one shared threshold the far pylons thinned to scattered dots.
  const slab = hash(positionView.z.abs().mul(4).floor());
  // @band-limited-elsewhere: a per-PIXEL dither threshold on screenCoordinate, not a spatial pattern
  const ign = screenCoordinate.xy.dot(vec2(0.06711056, 0.00583715)).fract().mul(52.9829189).fract();
  // @band-limited-elsewhere: temporal step of the same per-pixel threshold
  const threshold = ign.add(float(frameId).mod(1024).mul(0.6180339887)).add(slab).fract();
  material.maskNode = vCoverage.greaterThan(threshold);
}

// ── member axes (CPU, once per geometry at load) ─────────────────────────────

/** the geometry surface {@link computeThinAxes} reads (duck-typed: works for `three` and `three/webgpu` classes) */
export interface ThinAxisGeometry {
  getAttribute(name: string): { count: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number };
  getIndex(): { count: number; getX(i: number): number } | null;
}

export interface ThinAxisOptions {
  /** positions closer than this are one vertex (flat-shaded faces are split per face) — metres */
  weld?: number;
  /** a member is at most this half-width — metres; anything fatter is not thin geometry */
  maxRadius?: number;
  /** a member is at least this many half-widths long */
  minAspect?: number;
  /** and at least this long — metres: shorter detail (bolts, bands, rungs, glyph strokes) is left as it was */
  minLength?: number;
  /**
   * pass 2 only: a vertex of a FAT triangle with an edge longer than this (a sign, a panel, a glyph's face — not a
   * member's end cap) is never claimed, or the panel it bounds would be dithered away as if it were a wire — metres
   */
  maxCapEdge?: number;
}

interface Fit {
  cx: number;
  cy: number;
  cz: number;
  ax: number;
  ay: number;
  az: number;
  length: number;
  radius: number;
}

/** principal axis of a point set (power iteration on the covariance), its length along it and largest offset off it */
function fitAxis(U: Float64Array, ids: ArrayLike<number>): Fit {
  const n = ids.length;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let k = 0; k < n; k++) {
    const i = ids[k] * 3;
    cx += U[i];
    cy += U[i + 1];
    cz += U[i + 2];
  }
  cx /= n;
  cy /= n;
  cz /= n;
  let xx = 0;
  let xy = 0;
  let xz = 0;
  let yy = 0;
  let yz = 0;
  let zz = 0;
  for (let k = 0; k < n; k++) {
    const i = ids[k] * 3;
    const x = U[i] - cx;
    const y = U[i + 1] - cy;
    const z = U[i + 2] - cz;
    xx += x * x;
    xy += x * y;
    xz += x * z;
    yy += y * y;
    yz += y * z;
    zz += z * z;
  }
  // start from the dominant diagonal so the iteration never starts orthogonal to the answer
  let ax = xx >= yy && xx >= zz ? 1 : 0.1;
  let ay = yy > xx && yy >= zz ? 1 : 0.1;
  let az = zz > xx && zz > yy ? 1 : 0.1;
  for (let it = 0; it < 24; it++) {
    const bx = xx * ax + xy * ay + xz * az;
    const by = xy * ax + yy * ay + yz * az;
    const bz = xz * ax + yz * ay + zz * az;
    const l = Math.hypot(bx, by, bz);
    if (l < 1e-30) break;
    ax = bx / l;
    ay = by / l;
    az = bz / l;
  }
  let smin = Infinity;
  let smax = -Infinity;
  let r2 = 0;
  for (let k = 0; k < n; k++) {
    const i = ids[k] * 3;
    const x = U[i] - cx;
    const y = U[i + 1] - cy;
    const z = U[i + 2] - cz;
    const s = x * ax + y * ay + z * az;
    smin = Math.min(smin, s);
    smax = Math.max(smax, s);
    r2 = Math.max(r2, (x - s * ax) ** 2 + (y - s * ay) ** 2 + (z - s * az) ** 2);
  }
  return { cx, cy, cz, ax, ay, az, length: smax - smin, radius: Math.sqrt(r2) };
}

/**
 * Per-vertex member axes for `geometry`, as a `thinAxis` array (itemSize 4: offset from the axis xyz, half-width w;
 * all zero off-member). Pure f(positions, index).
 *
 * Pass 1 — SHELLS: weld positions, union triangles into connected shells, and keep every shell that is one straight
 * thin member (an L-angle, a tube, a strap). Pass 2 — RUNS, for shells that failed: where decimation fused a lattice
 * into one shell, its members survive as runs of long thin triangles; triangles sharing a vertex whose long edges are
 * parallel (within ~8°) are one run, and each straight thin run is a member. A vertex claimed by two runs (a node)
 * keeps the longer member's axis; a vertex of a large fat triangle (a sign, a panel) is never claimed.
 *
 * Run it on members only (lattice, spars, stakes): flat artwork — glyphs, boards — triangulates into slivers too.
 */
export function computeThinAxes(geometry: ThinAxisGeometry, options: ThinAxisOptions = {}): Float32Array {
  const weld = options.weld ?? 1e-4;
  const maxRadius = options.maxRadius ?? 0.35;
  const minAspect = options.minAspect ?? 6;
  const maxCapEdge = options.maxCapEdge ?? 0.3;
  const minLength = options.minLength ?? 0.5;
  const pos = geometry.getAttribute('position');
  const count = pos.count;
  const out = new Float32Array(count * 4);
  const index = geometry.getIndex();
  const triCount = Math.floor((index ? index.count : count) / 3);
  const corner = (t: number, c: number): number => (index ? index.getX(t * 3 + c) : t * 3 + c);

  // weld
  const vid = new Int32Array(count);
  const keys = new Map<string, number>();
  const uniq: number[] = [];
  for (let i = 0; i < count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const key = `${Math.round(x / weld)},${Math.round(y / weld)},${Math.round(z / weld)}`;
    let id = keys.get(key);
    if (id === undefined) {
      id = uniq.length / 3;
      keys.set(key, id);
      uniq.push(x, y, z);
    }
    vid[i] = id;
  }
  const U = Float64Array.from(uniq);
  const nU = U.length / 3;

  const parent = new Int32Array(nU);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const isThin = (f: Fit): boolean =>
    f.radius > 1e-5 && f.radius <= maxRadius && f.length >= minAspect * f.radius && f.length >= minLength;
  /** best member per welded vertex: offset + half-width, and the member's length to settle shared vertices */
  const best = new Float64Array(nU * 5);
  const claim = (ids: ArrayLike<number>, f: Fit): void => {
    for (let k = 0; k < ids.length; k++) {
      const u = ids[k];
      if (best[u * 5 + 4] >= f.length) continue;
      const i = u * 3;
      const x = U[i] - f.cx;
      const y = U[i + 1] - f.cy;
      const z = U[i + 2] - f.cz;
      const s = x * f.ax + y * f.ay + z * f.az;
      best[u * 5] = x - s * f.ax;
      best[u * 5 + 1] = y - s * f.ay;
      best[u * 5 + 2] = z - s * f.az;
      best[u * 5 + 3] = f.radius;
      best[u * 5 + 4] = f.length;
    }
  };
  const groupsOf = (roots: (i: number) => number, members: Iterable<number>): Map<number, number[]> => {
    const g = new Map<number, number[]>();
    for (const i of members) {
      const r = roots(i);
      let list = g.get(r);
      if (!list) g.set(r, (list = []));
      list.push(i);
    }
    return g;
  };

  // pass 1: shells
  for (let i = 0; i < nU; i++) parent[i] = i;
  for (let t = 0; t < triCount; t++) {
    const a = find(vid[corner(t, 0)]);
    parent[find(vid[corner(t, 1)])] = a;
    parent[find(vid[corner(t, 2)])] = a;
  }
  const shellOf = Int32Array.from({ length: nU }, (_, i) => find(i));
  const failed = new Set<number>();
  for (const [root, ids] of groupsOf((i) => shellOf[i], Array.from({ length: nU }, (_, i) => i))) {
    const f = fitAxis(U, ids);
    if (isThin(f)) claim(ids, f);
    else failed.add(root);
  }

  // pass 2: parallel sliver runs inside the shells that were not one member
  if (failed.size) {
    const tris: number[] = [];
    const dir = new Float64Array(triCount * 3);
    const vetoed = new Uint8Array(nU);
    for (let t = 0; t < triCount; t++) {
      const v0 = vid[corner(t, 0)];
      if (!failed.has(shellOf[v0])) continue;
      const vs = [v0, vid[corner(t, 1)], vid[corner(t, 2)]];
      let longest = -1;
      let lx = 0;
      let ly = 0;
      let lz = 0;
      for (let e = 0; e < 3; e++) {
        const p = vs[e] * 3;
        const q = vs[(e + 1) % 3] * 3;
        const dx = U[q] - U[p];
        const dy = U[q + 1] - U[p + 1];
        const dz = U[q + 2] - U[p + 2];
        const l = Math.hypot(dx, dy, dz);
        if (l > longest) {
          longest = l;
          lx = dx;
          ly = dy;
          lz = dz;
        }
      }
      // twice the area over the long edge is the triangle's height across it
      const p0 = vs[0] * 3;
      const ux = U[vs[1] * 3] - U[p0];
      const uy = U[vs[1] * 3 + 1] - U[p0 + 1];
      const uz = U[vs[1] * 3 + 2] - U[p0 + 2];
      const wx = U[vs[2] * 3] - U[p0];
      const wy = U[vs[2] * 3 + 1] - U[p0 + 1];
      const wz = U[vs[2] * 3 + 2] - U[p0 + 2];
      const height = Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / Math.max(longest, 1e-12);
      if (longest < 4 * height || longest < 1e-6) {
        if (longest > maxCapEdge) for (const v of vs) vetoed[v] = 1;
        continue;
      }
      dir[t * 3] = lx / longest;
      dir[t * 3 + 1] = ly / longest;
      dir[t * 3 + 2] = lz / longest;
      tris.push(t);
    }
    // triangles meet at welded vertices; join parallel slivers
    const tparent = new Int32Array(triCount);
    for (const t of tris) tparent[t] = t;
    const tfind = (i: number): number => {
      while (tparent[i] !== i) {
        tparent[i] = tparent[tparent[i]];
        i = tparent[i];
      }
      return i;
    };
    const atVertex = new Map<number, number[]>();
    for (const t of tris) {
      for (let c = 0; c < 3; c++) {
        const v = vid[corner(t, c)];
        let list = atVertex.get(v);
        if (!list) atVertex.set(v, (list = []));
        list.push(t);
      }
    }
    const PARALLEL = Math.cos((8 * Math.PI) / 180);
    for (const list of atVertex.values()) {
      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          const ta = list[a] * 3;
          const tb = list[b] * 3;
          if (Math.abs(dir[ta] * dir[tb] + dir[ta + 1] * dir[tb + 1] + dir[ta + 2] * dir[tb + 2]) < PARALLEL) continue;
          tparent[tfind(list[b])] = tfind(list[a]);
        }
      }
    }
    for (const run of groupsOf(tfind, tris).values()) {
      const ids = new Set<number>();
      for (const t of run) for (let c = 0; c < 3; c++) ids.add(vid[corner(t, c)]);
      const list = [...ids];
      const f = fitAxis(U, list);
      if (isThin(f)) claim(list.filter((v) => !vetoed[v]), f);
    }
  }

  for (let i = 0; i < count; i++) {
    const u = vid[i] * 5;
    out[i * 4] = best[u];
    out[i * 4 + 1] = best[u + 1];
    out[i * 4 + 2] = best[u + 2];
    out[i * 4 + 3] = best[u + 3];
  }
  return out;
}
