/**
 * PER-INSTANCE VISIBILITY FOR THE PLANT BATCHES (§T.112g, §V17, §V79).
 *
 * THE DEFECT THIS CLOSES. T112e put ~1550 live plants + ~430 understory on the
 * largest dome, in 7 batches. Every one of those batches is submitted whole,
 * every frame, in the main pass AND the shadow pass, and three's own frustum
 * cull cannot help: the batch's bounding sphere is the WHOLE ISLAND, so the
 * moment you are standing on the island it is trivially inside the frustum and
 * all 1550 trees are drawn — including the 1100 behind your head. The existing
 * `palmLodCount` ramp does not close it either: it thins by DISTANCE TO THE
 * ISLAND CENTRE, which is one number for the whole island and is at its
 * smallest exactly when you are standing in the middle of the stand.
 *
 * WHAT THIS DOES INSTEAD. Bucket the instances into fixed world CELLS once, at
 * build; per frame test each cell's bounding sphere against the camera frustum
 * and against a cull radius; compact the surviving cells' instance ranges into
 * the head of the instance buffers and set `InstancedMesh.count`.
 *
 * WHY CELLS AND NOT INSTANCES. Two reasons, both measured elsewhere in this
 * tree. (1) The result only has to be re-uploaded when the VISIBLE SET
 * CHANGES, and a set of ~30 cells changes on a handful of frames per second of
 * walking, not on all of them — so the amortised cost is a few dozen sphere
 * tests, not a 1550-matrix rewrite per frame. (2) §V79: draw calls are 3.8 µs
 * and the main thread is idle 44% of the time; the win here is NOT CPU, it is
 * the vertex + fragment + shadow work of geometry that is behind the camera.
 * Cell granularity gives up a few percent of that and buys back all of the CPU
 * cost, which is the right trade on this frame.
 *
 * ORDER WITHIN A CELL IS LARGEST-FIRST, so `count` truncation inside a cell
 * still drops the least readable plant first — the property `scatter.sortForLod`
 * was written for, kept under the new ordering.
 *
 * PURE MATHS, NO RENDERER. `frustumPlanes`, `sphereVisible`, `buildCullCells`,
 * `cullCells` and the hi-z mirror below are pure functions over numbers, so
 * tests pin them headlessly (§V88). `createInstanceCuller` is the only part
 * that touches three, and it only moves Float32Arrays.
 *
 * ── WHERE THE COMPUTE PATH STANDS (checked, not assumed) ───────────────────
 * three r180 DOES have the indirect-draw plumbing this task asked about:
 *   - `IndirectStorageBufferAttribute` (renderers/common/)
 *   - `BufferGeometry.setIndirect(attr)` (core/BufferGeometry.js:229)
 *   - `WebGPUBackend.draw` reads `renderObject.getIndirect()` and issues
 *     `drawIndexedIndirect(buffer, 0)` / `drawIndirect(buffer, 0)`
 *     (WebGPUBackend.js:1572-1600)
 * So a compute pass CAN write the draw args. What is NOT free, and is why this
 * ships as the CPU mirror first:
 *   1. The offset is HARD-CODED 0, so one indirect draw per geometry — each
 *      LOD bucket needs its own mesh, which is what the cell scheme produces
 *      anyway.
 *   2. Compaction needs the instance transforms in a storage buffer read
 *      through an index redirection, i.e. `InstancedMesh.instanceMatrix` has to
 *      be replaced by a storage buffer + a per-draw visible-index list that the
 *      SHARED conifer material (`createPineMaterial`) reads. That is a change
 *      to the one material every plant in the world uses.
 *   3. Hi-z needs the previous frame's depth pyramid, which means a reduction
 *      chain off the depth attachment owned by `src/core/postPipeline.ts`.
 * (2) and (3) are the next step and are described here so the next agent does
 * not have to re-derive them. Nothing in this file pretends to be on the GPU.
 */

import type * as THREE from 'three/webgpu';

/** anything the cull can bound: a world position and a radius that covers it */
export interface CullInstance {
  x: number;
  y: number;
  z: number;
  /** world radius covering the instance's geometry INCLUDING wind sway */
  radius: number;
  /** larger = more readable; decides the order inside a cell */
  size: number;
}

/**
 * Six frustum planes (nx, ny, nz, d), normalised, from a column-major
 * view-projection matrix — Gribb & Hartmann, the same extraction three's own
 * `Frustum.setFromProjectionMatrix` performs. A point is inside plane i when
 * `n·p + d ≥ 0`, so a sphere is inside when `n·c + d ≥ −r`.
 *
 * Normalised deliberately: without it `d` is in an arbitrary scale and the
 * sphere test silently becomes a point test with a radius that means nothing.
 */
export function frustumPlanes(e: ArrayLike<number>, out = new Float32Array(24)): Float32Array {
  const set = (i: number, a: number, b: number, c: number, d: number): void => {
    const len = Math.max(Math.hypot(a, b, c), 1e-12); // §V28
    out[i * 4] = a / len;
    out[i * 4 + 1] = b / len;
    out[i * 4 + 2] = c / len;
    out[i * 4 + 3] = d / len;
  };
  const r0 = [e[0], e[4], e[8], e[12]];
  const r1 = [e[1], e[5], e[9], e[13]];
  const r2 = [e[2], e[6], e[10], e[14]];
  const r3 = [e[3], e[7], e[11], e[15]];
  set(0, r3[0] + r0[0], r3[1] + r0[1], r3[2] + r0[2], r3[3] + r0[3]); // left
  set(1, r3[0] - r0[0], r3[1] - r0[1], r3[2] - r0[2], r3[3] - r0[3]); // right
  set(2, r3[0] + r1[0], r3[1] + r1[1], r3[2] + r1[2], r3[3] + r1[3]); // bottom
  set(3, r3[0] - r1[0], r3[1] - r1[1], r3[2] - r1[2], r3[3] - r1[3]); // top
  set(4, r3[0] + r2[0], r3[1] + r2[1], r3[2] + r2[2], r3[3] + r2[3]); // near
  set(5, r3[0] - r2[0], r3[1] - r2[1], r3[2] - r2[2], r3[3] - r2[3]); // far
  return out;
}

/** conservative sphere-vs-frustum: false ONLY when the sphere is fully outside */
export function sphereVisible(
  planes: ArrayLike<number>,
  x: number,
  y: number,
  z: number,
  r: number,
): boolean {
  for (let i = 0; i < 6; i++) {
    const o = i * 4;
    if (planes[o] * x + planes[o + 1] * y + planes[o + 2] * z + planes[o + 3] < -r) return false;
  }
  return true;
}

export interface CullCell {
  /** bounding-sphere centre (world) */
  x: number;
  y: number;
  z: number;
  /** bounding-sphere radius, instance radii included */
  radius: number;
  /** first instance of this cell in the reordered instance list */
  start: number;
  count: number;
}

export interface CullPartition {
  cells: CullCell[];
  /**
   * Reordered instance indices, cell-major and largest-first inside each cell.
   * `order[k]` is the ORIGINAL index of the k-th instance in the new layout.
   */
  order: Uint32Array;
}

/**
 * Instances → cells on a fixed world grid. DETERMINISTIC: cells come out in
 * ascending (cellZ, cellX) order and instances inside a cell in descending
 * size with the original index breaking ties, so the same input always
 * produces the same buffer layout (§V2) and the same draw for the same camera.
 */
export function buildCullCells(
  instances: readonly CullInstance[],
  cellSize: number,
): CullPartition {
  const size = Math.max(cellSize, 1e-3); // §V28
  const buckets = new Map<string, number[]>();
  const keyOf = (i: number, j: number): string => `${j}|${i}`;
  for (let k = 0; k < instances.length; k++) {
    const c = instances[k];
    const i = Math.floor(c.x / size);
    const j = Math.floor(c.z / size);
    const key = keyOf(i, j);
    const list = buckets.get(key);
    if (list) list.push(k);
    else buckets.set(key, [k]);
  }
  const keys = [...buckets.keys()].sort((a, b) => {
    const [az, ax] = a.split('|').map(Number);
    const [bz, bx] = b.split('|').map(Number);
    return az - bz || ax - bx;
  });
  const order = new Uint32Array(instances.length);
  const cells: CullCell[] = [];
  let w = 0;
  for (const key of keys) {
    const list = buckets.get(key)!;
    list.sort((a, b) => instances[b].size - instances[a].size || a - b);
    const start = w;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let maxR = 0;
    for (const k of list) {
      const c = instances[k];
      order[w++] = k;
      if (c.x < minX) minX = c.x;
      if (c.x > maxX) maxX = c.x;
      if (c.y < minY) minY = c.y;
      if (c.y > maxY) maxY = c.y;
      if (c.z < minZ) minZ = c.z;
      if (c.z > maxZ) maxZ = c.z;
      if (c.radius > maxR) maxR = c.radius;
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    // half-diagonal of the extent + the largest instance radius: covers every
    // instance in the cell, and no instance can leave its own cull volume
    const radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 + maxR;
    cells.push({ x: cx, y: cy, z: cz, radius, start, count: list.length });
  }
  return { cells, order };
}

export interface CullResult {
  /** indices into `cells`, ascending */
  visible: number[];
  /** instances the visible cells carry */
  instances: number;
  /** instances the cull dropped */
  culled: number;
}

/**
 * Cells surviving the frustum and the cull radius. The radius test is against
 * the cell's NEAREST point (distance − radius), so a cell straddling the cull
 * distance is kept rather than half-dropped — the same conservative direction
 * as the plane test.
 */
export function cullCells(
  cells: readonly CullCell[],
  planes: ArrayLike<number>,
  camX: number,
  camY: number,
  camZ: number,
  maxDistance = Infinity,
): CullResult {
  const visible: number[] = [];
  let kept = 0;
  let total = 0;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    total += c.count;
    const d = Math.hypot(c.x - camX, c.y - camY, c.z - camZ) - c.radius;
    if (d > maxDistance) continue;
    if (!sphereVisible(planes, c.x, c.y, c.z, c.radius)) continue;
    visible.push(i);
    kept += c.count;
  }
  return { visible, instances: kept, culled: total - kept };
}

// ── hi-z: the CPU mirror of the occlusion maths ───────────────────────────
//
// The GPU version reads the previous frame's depth pyramid; this is the same
// arithmetic over an array you hand it, so the maths is pinned headlessly and
// only the pyramid itself is browser-only (§V88). See the header for why the
// pyramid cannot be built from this file today.

/**
 * Screen-space AABB of a world sphere, in [0,1]² with y down, plus the
 * sphere's NEAREST ndc depth. Returns null when the sphere crosses the near
 * plane, where the projection of its silhouette is not a bounded rectangle and
 * the only conservative answer is "do not cull".
 */
export function sphereScreenBounds(
  viewProjection: ArrayLike<number>,
  x: number,
  y: number,
  z: number,
  r: number,
  camX: number,
  camY: number,
  camZ: number,
  near: number,
): { minX: number; minY: number; maxX: number; maxY: number; depth: number } | null {
  const dist = Math.hypot(x - camX, y - camY, z - camZ);
  if (dist - r <= near) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let depth = Infinity;
  const e = viewProjection;
  // the 8 corners of the sphere's bounding box — conservative, and free of the
  // trigonometry an exact silhouette projection would need
  for (let i = 0; i < 8; i++) {
    const px = x + (i & 1 ? r : -r);
    const py = y + (i & 2 ? r : -r);
    const pz = z + (i & 4 ? r : -r);
    const cw = e[3] * px + e[7] * py + e[11] * pz + e[15];
    if (cw <= 1e-6) return null; // §V28 — behind the eye, no bounded rectangle
    const cx = (e[0] * px + e[4] * py + e[8] * pz + e[12]) / cw;
    const cy = (e[1] * px + e[5] * py + e[9] * pz + e[13]) / cw;
    const cz = (e[2] * px + e[6] * py + e[10] * pz + e[14]) / cw;
    const sx = cx * 0.5 + 0.5;
    const sy = 0.5 - cy * 0.5;
    if (sx < minX) minX = sx;
    if (sx > maxX) maxX = sx;
    if (sy < minY) minY = sy;
    if (sy > maxY) maxY = sy;
    if (cz < depth) depth = cz;
  }
  return { minX, minY, maxX, maxY, depth };
}

/**
 * Pyramid level whose texel is at least as wide as the rectangle, so the test
 * needs at most 2×2 texels however big the object is — the whole point of a
 * hi-z pyramid. `size` is the base level's resolution in texels.
 */
export function hiZLevel(rect: { minX: number; maxX: number; minY: number; maxY: number }, size: number): number {
  const w = (rect.maxX - rect.minX) * size;
  const h = (rect.maxY - rect.minY) * size;
  const span = Math.max(w, h, 1e-6); // §V28
  return Math.max(0, Math.ceil(Math.log2(span)));
}

/**
 * Occluded when the object's NEAREST depth is behind the FARTHEST depth
 * already in the pyramid over its rectangle. `mip` is a square level of side
 * `mipSize` holding the MAXIMUM depth of each footprint (a max-reduction
 * chain, not a min one — a min pyramid answers a different question and would
 * cull things that are visible).
 */
export function hiZOccluded(
  mip: ArrayLike<number>,
  mipSize: number,
  rect: { minX: number; maxX: number; minY: number; maxY: number },
  depth: number,
): boolean {
  const x0 = Math.max(0, Math.min(mipSize - 1, Math.floor(rect.minX * mipSize)));
  const x1 = Math.max(0, Math.min(mipSize - 1, Math.floor(rect.maxX * mipSize)));
  const y0 = Math.max(0, Math.min(mipSize - 1, Math.floor(rect.minY * mipSize)));
  const y1 = Math.max(0, Math.min(mipSize - 1, Math.floor(rect.maxY * mipSize)));
  let far = -Infinity;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const v = mip[y * mipSize + x];
      if (v > far) far = v;
    }
  }
  return depth > far;
}

// ── the applier ───────────────────────────────────────────────────────────

export interface InstanceCullStats {
  /** instances submitted this frame */
  drawn: number;
  /** instances the frustum + range test dropped */
  culled: number;
  /** cells submitted */
  cells: number;
  /** whether the instance buffers were re-uploaded this frame */
  uploaded: boolean;
}

export interface InstanceCuller {
  update(
    modelViewProjection: ArrayLike<number>,
    camX: number,
    camY: number,
    camZ: number,
    maxDistance?: number,
  ): InstanceCullStats;
  /** submit everything again (LOD off, or the camera is unknown) */
  reset(): void;
  /**
   * Retarget the shadow-caster test. The sun MOVES, so this cannot be fixed at
   * construction: at a low sun the reach is the whole island and at noon it is
   * nothing, and a stale direction culls casters whose shadows are in frame.
   */
  setShadow(dir: [number, number, number] | null, length: number): void;
  readonly total: number;
  readonly cellCount: number;
  readonly stats: InstanceCullStats;
}

export interface InstanceCullerOptions {
  /** world size of one cull cell (m) */
  cellSize: number;
  /**
   * Metres added to every instance radius for vertex motion the CPU cannot
   * see — the wind sway. Same reason `scatterPalms` inflates its bounding
   * sphere: a plant must never be able to leave its own cull volume.
   */
  swayMargin?: number;
  /**
   * Per-instance attribute names to permute alongside the matrices. These live
   * on the GEOMETRY (`scatterPalms` writes `instancePhase`/`instanceSway`
   * there), so they must be reordered in lockstep or every plant gets another
   * plant's wind phase.
   */
  attributes?: readonly string[];
  /**
   * Sun direction (pointing AT the sun) and the shadow reach in metres. A cell
   * BEHIND the camera can still cast into the frame, so the test is run a
   * second time at the point its shadow LANDS — which is along −sun, away from
   * the light, not toward it. Without this the cull eats shadows, which is a
   * worse artifact than the draws it saves.
   */
  shadow?: { dir: [number, number, number]; length: number };
}

/**
 * Reorder an instanced mesh's buffers cell-major once, then compact the
 * visible cells to the head of the buffers per frame.
 *
 * The upload only happens when the visible SET changes — walking a straight
 * line across an island changes it a few times a second, so the steady-state
 * cost is `cells` sphere tests and nothing else.
 */
export function createInstanceCuller(
  mesh: THREE.InstancedMesh,
  opts: InstanceCullerOptions,
): InstanceCuller {
  const total = mesh.count;
  const matrices = mesh.instanceMatrix.array as Float32Array;
  if (mesh.geometry.boundingSphere === null) mesh.geometry.computeBoundingSphere();
  const bs = mesh.geometry.boundingSphere;
  // radius about the instance ORIGIN, not about the geometry's own centre —
  // the instance matrix places the origin, so that is what the cell bounds
  const localRadius = bs ? Math.hypot(bs.center.x, bs.center.y, bs.center.z) + bs.radius : 0;
  const margin = opts.swayMargin ?? 0;

  const instances: CullInstance[] = [];
  for (let i = 0; i < total; i++) {
    const o = i * 16;
    // column-major: translation is elements 12..14, column lengths are scale
    const sx = Math.hypot(matrices[o], matrices[o + 1], matrices[o + 2]);
    const sy = Math.hypot(matrices[o + 4], matrices[o + 5], matrices[o + 6]);
    const sz = Math.hypot(matrices[o + 8], matrices[o + 9], matrices[o + 10]);
    const s = Math.max(sx, sy, sz);
    instances.push({
      x: matrices[o + 12],
      y: matrices[o + 13],
      z: matrices[o + 14],
      radius: localRadius * s + margin,
      size: sy,
    });
  }
  const { cells, order } = buildCullCells(instances, opts.cellSize);

  // permuted source copies — the live buffers become scratch the compaction
  // writes into, so nothing has to be read back to restore an order
  const srcMatrix = new Float32Array(total * 16);
  for (let k = 0; k < total; k++) {
    srcMatrix.set(matrices.subarray(order[k] * 16, order[k] * 16 + 16), k * 16);
  }
  const attrs: {
    live: Float32Array;
    src: Float32Array;
    itemSize: number;
    attr: { needsUpdate: boolean };
  }[] = [];
  for (const name of opts.attributes ?? []) {
    const a = mesh.geometry.getAttribute(name);
    if (!a) continue;
    const live = a.array as Float32Array;
    const src = new Float32Array(total * a.itemSize);
    for (let k = 0; k < total; k++) {
      src.set(live.subarray(order[k] * a.itemSize, (order[k] + 1) * a.itemSize), k * a.itemSize);
    }
    attrs.push({ live, src, itemSize: a.itemSize, attr: a });
  }

  let shadow = opts.shadow;
  let applied: number[] = [];
  const stats: InstanceCullStats = { drawn: total, culled: 0, cells: cells.length, uploaded: false };

  const compact = (visible: readonly number[]): number => {
    let w = 0;
    for (const ci of visible) {
      const c = cells[ci];
      matrices.set(srcMatrix.subarray(c.start * 16, (c.start + c.count) * 16), w * 16);
      for (const a of attrs) {
        a.live.set(
          a.src.subarray(c.start * a.itemSize, (c.start + c.count) * a.itemSize),
          w * a.itemSize,
        );
      }
      w += c.count;
    }
    mesh.instanceMatrix.needsUpdate = true;
    for (const a of attrs) a.attr.needsUpdate = true;
    return w;
  };

  const same = (a: readonly number[], b: readonly number[]): boolean =>
    a.length === b.length && a.every((v, i) => v === b[i]);

  return {
    total,
    cellCount: cells.length,
    get stats(): InstanceCullStats {
      return stats;
    },
    setShadow(dir: [number, number, number] | null, length: number): void {
      shadow = dir ? { dir, length } : undefined;
    },
    reset(): void {
      const all = cells.map((_, i) => i);
      if (!same(all, applied)) {
        compact(all);
        applied = all;
      }
      mesh.count = total;
      stats.drawn = total;
      stats.culled = 0;
      stats.cells = cells.length;
      stats.uploaded = true;
    },
    update(mvp, camX, camY, camZ, maxDistance = Infinity): InstanceCullStats {
      const planes = frustumPlanes(mvp);
      let res = cullCells(cells, planes, camX, camY, camZ, maxDistance);
      if (shadow && shadow.length > 0) {
        // second test where the cell's shadow LANDS (along −sun): a caster
        // outside the frame whose shadow is inside it must survive
        const extra: number[] = [];
        const seen = new Set(res.visible);
        for (let i = 0; i < cells.length; i++) {
          if (seen.has(i)) continue;
          const c = cells[i];
          const x = c.x - shadow.dir[0] * shadow.length;
          const y = c.y - shadow.dir[1] * shadow.length;
          const z = c.z - shadow.dir[2] * shadow.length;
          if (Math.hypot(c.x - camX, c.y - camY, c.z - camZ) - c.radius > maxDistance) continue;
          if (sphereVisible(planes, x, y, z, c.radius)) extra.push(i);
        }
        if (extra.length > 0) {
          const merged = [...res.visible, ...extra].sort((a, b) => a - b);
          let kept = 0;
          for (const i of merged) kept += cells[i].count;
          res = { visible: merged, instances: kept, culled: total - kept };
        }
      }
      stats.uploaded = false;
      if (!same(res.visible, applied)) {
        compact(res.visible);
        applied = res.visible;
        stats.uploaded = true;
      }
      mesh.count = res.instances;
      stats.drawn = res.instances;
      stats.culled = res.culled;
      stats.cells = res.visible.length;
      return stats;
    },
  };
}
