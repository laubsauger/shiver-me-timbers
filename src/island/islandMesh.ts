/**
 * Island terrain mesh (T20): heightmap grid → BufferGeometry + T27's
 * terrainBlendMaterial (sand on low/flat, rock on steep/high — §V16 tunables
 * in params/terrain.ts, waterline uniform wired below).
 *
 * Geometry runs OUT to open water, not to the footprint: past the heightmap
 * grid the mesh continues as a shelf apron on the seabed field's own ramp, and
 * only then drops a skirt. See `buildIslandGeometry` for why that is the fix
 * for "a hard edge border around the island".
 * `buildIslandGeometry` is material-free (GPU untouched) so tests can verify
 * geometry without a renderer; the blend material itself is also lazily
 * compiled (node graph only until first render — see src/terrain/index.ts).
 *
 * No TSL is written here — shading comes entirely from terrainBlendMaterial
 * (already §V23-clean functional forms).
 */
import * as THREE from 'three/webgpu';
import { terrainBlendMaterial, type TerrainBlendMaterialHandle } from '../terrain';
import { terrainParams } from '../params/terrain';
import { islandParams } from '../params/island';
import type { IslandHeightmap } from './heightmap';
import { shelfRamp } from './seabed';

/**
 * Heightmap → indexed grid geometry (positions + computed normals), continued
 * outward as a SHELF APRON and closed with a skirt.
 *
 * THE DEFECT THIS CLOSES — "a crazy hard edge border around the island, no
 * blending whatsoever with the rest of the ocean".
 *
 * The heightmap is a SQUARE grid over [-R, R]² and nothing was ever drawn
 * outside it. Meanwhile `seabed.sampleSeabedHeight` keeps ramping the bottom
 * from the rim out to `seabedOpenDepth` over another `seabedShelfWidth`
 * metres, and the ocean shades its shallows against that field out to
 * `shallowFullDepth`. So the water went on looking shallow past the footprint
 * while the FLOOR under it simply stopped — on a straight line, four of them,
 * in a square, with a vertical skirt wall on the inside of it. Measured on the
 * showcase island: the drawn terrain ends at y = -12.00 m at r = 260, the
 * depth field says -12.001 m at r = 261 and carries on to -45 m at r = 520.
 * The FIELD is continuous to 0.0011 m across that boundary (27a0795 fixed
 * that); the GEOMETRY was not continuous at all, because there was none.
 *
 * showcase.ts records the symptom and its local mitigation — sinking that one
 * island's rim to -12 m "puts its mesh edge below the readable band" — and
 * says in as many words that the general fix belongs to whoever owns this
 * file. This is it: keep going. The apron rides `shelfRamp`, the SAME curve
 * and the same Chebyshev distance the depth field uses, so the drawn floor and
 * the sampled floor are one surface by construction rather than by agreement.
 *
 * Chebyshev is what makes this exact and cheap at once. The ramp's argument is
 * `max(|x|,|z|) - R`, so a constant Chebyshev offset is just a UNIFORM SCALE of
 * the square boundary loop — every apron ring is the boundary vertices times a
 * scalar, and each ring sits at exactly the depth the field reports there. A
 * Euclidean ramp would need a real offset curve and would disagree with the
 * field at the corners by the same 12.3 m 27a0795 already had to fix once.
 *
 * COST: no new draw call and no new material — this is the same mesh. It adds
 * `perim × (rings + 1)` vertices; at the shipped `gridSize` 128 that is 508 ×
 * 9 = 4572 on top of 16 892, i.e. +27% vertices on a mesh that is not what the
 * frame is short of (the frame is CPU-bound on draw calls, `d5bd07a`).
 */
export function buildIslandGeometry(
  hm: IslandHeightmap,
  skirtDepth: number = islandParams.skirtDepth,
  /**
   * LOD decimation: take every `stride`-th heightmap vertex (§V17). The last
   * row/column is clamped to the source edge so the footprint — and with it
   * the guaranteed-submerged rim — is identical at every level; only the
   * interior tessellation drops.
   */
  stride = 1,
  /**
   * Shelf apron shape. Defaults to the world's, and the defaults are the
   * seabed field's own params rather than copies — pass an override only to
   * test the geometry against a field built with the same override.
   */
  shelf: { width: number; openDepth: number; rings: number } = {
    width: islandParams.seabedShelfWidth,
    openDepth: islandParams.seabedOpenDepth,
    rings: islandParams.seabedApronRings,
  },
): THREE.BufferGeometry {
  const src = hm.size;
  const R = hm.worldRadius;
  const cell = (2 * R) / (src - 1);
  const s = Math.max(1, Math.floor(stride));
  const n = s === 1 ? src : Math.ceil((src - 1) / s) + 1;
  /** decimated column/row index → source heightmap index */
  const srcIdx = (i: number): number => Math.min(i * s, src - 1);
  const perim = 4 * (n - 1);
  /** apron rings, then ONE more ring for the vertical closing skirt */
  const rings = Math.max(0, Math.floor(shelf.rings));
  const shelfW = Math.max(shelf.width, 1e-3);
  const outerRings = rings + 1;
  /**
   * What `heightAt` reports outside the footprint (= -rimDepth by its own
   * contract). Read rather than re-derived: `rimDepth` is a per-island
   * override and this function is only given the heightmap.
   */
  const outsideY = hm.heightAt(R * 1.5, 0);
  const openY = -shelf.openDepth;
  const positions = new Float32Array((n * n + perim * outerRings) * 3);

  // interior grid vertices
  for (let iz = 0; iz < n; iz++) {
    const sz = srcIdx(iz);
    for (let ix = 0; ix < n; ix++) {
      const sx = srcIdx(ix);
      const v = (iz * n + ix) * 3;
      positions[v] = -R + sx * cell;
      positions[v + 1] = hm.data[sz * src + sx];
      positions[v + 2] = -R + sz * cell;
    }
  }

  // ordered boundary loop: top row → right col → bottom row → left col
  const boundary = new Uint32Array(perim);
  let k = 0;
  for (let ix = 0; ix < n - 1; ix++) boundary[k++] = ix; // z = -R
  for (let iz = 0; iz < n - 1; iz++) boundary[k++] = iz * n + (n - 1); // x = +R
  for (let ix = n - 1; ix > 0; ix--) boundary[k++] = (n - 1) * n + ix; // z = +R
  for (let iz = n - 1; iz > 0; iz--) boundary[k++] = iz * n; // x = -R

  // APRON RINGS. Ring k sits a Chebyshev distance `t` outside the footprint,
  // which on a square boundary is the boundary scaled by (R + t)/R — so the
  // ring's own Chebyshev distance is exactly R + t and `shelfRamp` can be
  // evaluated on `t` directly, with no per-vertex distance to get wrong.
  //
  // Ring 0 is NOT emitted: the strip from the grid boundary to ring 1 reuses
  // the boundary vertices themselves, so the junction between heightmap and
  // apron shares vertices and is continuous by construction — the same reason
  // the old skirt attached to `boundary` rather than to a copy of it.
  for (let k = 1; k <= rings; k++) {
    const t = (shelfW * k) / rings;
    const scale = (R + t) / R;
    const y = outsideY + (openY - outsideY) * shelfRamp(t, shelfW);
    for (let i = 0; i < perim; i++) {
      const b = boundary[i] * 3;
      const v = (n * n + (k - 1) * perim + i) * 3;
      positions[v] = positions[b] * scale;
      positions[v + 1] = y;
      positions[v + 2] = positions[b + 2] * scale;
    }
  }

  // Closing skirt: straight down from the OUTERMOST apron ring. It exists for
  // the same reason it always did (never show a gap under the water surface),
  // but it now hangs off the edge of the open-water shelf at -openDepth rather
  // than off the rim, where it used to be the visible wall.
  {
    const outerScale = (R + shelfW) / R;
    const base = n * n + rings * perim;
    for (let i = 0; i < perim; i++) {
      const b = boundary[i] * 3;
      const v = (base + i) * 3;
      positions[v] = positions[b] * outerScale;
      positions[v + 1] = openY - skirtDepth;
      positions[v + 2] = positions[b + 2] * outerScale;
    }
  }

  const quadCount = (n - 1) * (n - 1) + perim * outerRings;
  const indices = new Uint32Array(quadCount * 6);
  let t = 0;
  // grid quads (CCW from above → upward-facing front faces)
  for (let iz = 0; iz < n - 1; iz++) {
    for (let ix = 0; ix < n - 1; ix++) {
      const a = iz * n + ix;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      indices[t++] = a;
      indices[t++] = c;
      indices[t++] = b;
      indices[t++] = b;
      indices[t++] = c;
      indices[t++] = d;
    }
  }
  // apron + skirt strips, wound outward exactly as the old single skirt was.
  // Ring -1 means "the grid boundary loop"; ring k ≥ 0 is the k-th emitted
  // ring, so strip k joins ring k-1 to ring k for k = 0 .. outerRings-1.
  const ringVertex = (ring: number, i: number): number =>
    ring < 0 ? boundary[i] : n * n + ring * perim + i;
  for (let ring = 0; ring < outerRings; ring++) {
    for (let i = 0; i < perim; i++) {
      const j = (i + 1) % perim;
      const bi = ringVertex(ring - 1, i);
      const bj = ringVertex(ring - 1, j);
      const si = ringVertex(ring, i);
      const sj = ringVertex(ring, j);
      indices[t++] = bi;
      indices[t++] = bj;
      indices[t++] = si;
      indices[t++] = bj;
      indices[t++] = sj;
      indices[t++] = si;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}

// ── T112g LOD ── CDLOD MORPH ──────────────────────────────────────────────
//
// THE DEFECT THIS CLOSES. `setLod` swapped a stride-1 geometry for a stride-2
// one at 900 m. That is a STEP CHANGE in what the surface can represent, and
// §T.64 already recorded what a step change in tessellation looks like on the
// ocean: it is not only a silhouette jump, it is a SHADING jump, because a
// coarser mesh carries a different slope distribution ⟹ different normals ⟹
// different diffuse and specular. On an island you walk toward, that is a
// visible seam that swims — the exact thing this task is named after.
//
// THE CURE (Strugar, CDLOD, docs/raft2100/terrain-research.md §2.6). Do not
// swap. MORPH: over a band before the swap distance, move every fine vertex
// onto the surface its COARSE PARENT would draw. At the end of the band the
// fine mesh is the coarse mesh — same positions, same normals, to within
// float — so the swap that follows changes the triangle COUNT and nothing
// else. The delta the eye could see is spread over hundreds of metres of
// approach instead of landing in one frame, and it reaches exactly zero at
// the moment of the swap rather than merely getting small.
//
// WHY THE PARENT IS THE TRIANGULATED SURFACE, ⊥ THE AVERAGE OF TWO NEIGHBOURS.
// The naive geomorph lerps an odd vertex toward the mean of its two even
// neighbours. That is right only where the coarse quad's diagonal happens to
// pass through it. `buildIslandGeometry` splits each quad (a,c,b)+(b,c,d), so
// the diagonal runs c→b and the quad CENTRE sits on it; interpolating inside
// the containing coarse TRIANGLE is right for every case at once, including
// the short final cell the decimation's edge clamp leaves behind (`src-1` is
// not a multiple of the stride at any of the shipped grid sizes).
//
// HOW IT GETS TO THE GPU: `geometry.morphAttributes` + `morphTargetsRelative`.
// three r180's `NodeMaterial.setupPosition` mounts `morphReference` whenever a
// geometry carries morph attributes (materials/nodes/NodeMaterial.js:736), so
// the morph rides the material every island already shares — no second node
// graph (§V17), no edit to a material this task does not own. Cost is one
// vertex texture fetch per vertex per frame in a stage measured at 0.48 ms for
// 263 k ocean vertices (§V79), against ~75 k here.
//
// THE MESH STAYS AT `sliceGridSize` (256²) — the T112 decision. Nothing below
// grows it; the morph is what makes 256² affordable to KEEP at close range
// instead of decimating early. See the report for the 512² height texture,
// which does not exist yet: the bake is at `sliceGridSize` and this task is
// explicitly barred from moving the bake budget.

/** vertices per side of the stride-decimated grid over a `src`-sized field */
export function lodGridSize(src: number, stride: number): number {
  const s = Math.max(1, Math.floor(stride));
  return s === 1 ? src : Math.ceil((src - 1) / s) + 1;
}

/** decimated index → source heightmap index (the last one clamps to the edge) */
export function lodSrcIndex(i: number, stride: number, src: number): number {
  return Math.min(i * Math.max(1, Math.floor(stride)), src - 1);
}

/**
 * Where a source index falls in the decimated grid: the cell it is in, and how
 * far across that cell it sits.
 *
 * The LAST cell is SHORT whenever `src - 1` is not a multiple of the stride —
 * `buildIslandGeometry` clamps the final decimated row to the source edge so
 * the footprint is identical at every level. At the shipped sizes that is
 * always: 255 is not a multiple of 2 or 4. So the fraction is taken against
 * the cell's OWN width, never against the stride, or every morph in the last
 * row would be computed against a cell that is not there.
 */
export function lodCellOf(
  srcIndex: number,
  stride: number,
  src: number,
): { cell: number; t: number } {
  const s = Math.max(1, Math.floor(stride));
  const n = lodGridSize(src, s);
  const cell = Math.min(Math.floor(srcIndex / s), n - 2);
  const lo = lodSrcIndex(cell, s, src);
  const hi = lodSrcIndex(cell + 1, s, src);
  const span = Math.max(hi - lo, 1); // §V28 — a degenerate cell would divide by 0
  return { cell, t: (srcIndex - lo) / span };
}

/**
 * Height of the STRIDE-DECIMATED triangulated surface at island-local (x, z) —
 * i.e. what the LOD level actually draws there, triangle split included.
 *
 * This is the truth the morph targets and the tests are written against. It is
 * deliberately not `heightAt` with a coarser sample: `heightAt` is a bilinear
 * read of the field, the mesh is a pair of triangles, and on a quad whose
 * corners are not coplanar those two disagree by up to the quad's own twist.
 * §V77: one expression, not two that agree today.
 */
export function strideSurfaceHeight(
  hm: IslandHeightmap,
  stride: number,
  x: number,
  z: number,
): number {
  const src = hm.size;
  const R = hm.worldRadius;
  const cell = (2 * R) / (src - 1);
  const s = Math.max(1, Math.floor(stride));
  const n = lodGridSize(src, s);
  const fx = Math.min(Math.max((x + R) / cell, 0), src - 1);
  const fz = Math.min(Math.max((z + R) / cell, 0), src - 1);
  const cx = lodCellOf(fx, s, src);
  const cz = lodCellOf(fz, s, src);
  const at = (jx: number, jz: number): number =>
    hm.data[lodSrcIndex(jz, s, src) * src + lodSrcIndex(jx, s, src)];
  const jx = Math.min(cx.cell, n - 2);
  const jz = Math.min(cz.cell, n - 2);
  const ha = at(jx, jz);
  const hb = at(jx + 1, jz);
  const hc = at(jx, jz + 1);
  const hd = at(jx + 1, jz + 1);
  // the quad is split (a,c,b) + (b,c,d): the diagonal runs c→b, so the
  // near triangle is tx + tz ≤ 1
  return cx.t + cz.t <= 1
    ? ha + (hb - ha) * cx.t + (hc - ha) * cz.t
    : hd + (hc - hd) * (1 - cx.t) + (hb - hd) * (1 - cz.t);
}

export interface TerrainMorph {
  /** per-vertex position delta (fine → coarse surface), 3 floats */
  position: Float32Array;
  /** per-vertex normal delta, 3 floats */
  normal: Float32Array;
  /** largest |Δy| any vertex travels (m) — reported, and asserted by tests */
  maxHeightDelta: number;
}

/**
 * Fine geometry → the delta that lands it exactly on the coarse geometry's
 * drawn surface.
 *
 * POSITIONS MOVE ONLY IN Y, EXACTLY. A decimated grid vertex sits at
 * `-R + srcIndex·cell` on both axes, and the linear interpolation between two
 * coarse columns evaluated at the fine column's own fraction returns that same
 * x back. So dx = dz = 0 by construction and the morph is a pure height
 * displacement — which is what makes it safe to run under a material that
 * knows nothing about it.
 *
 * NORMALS MOVE TOO, AND THAT IS HALF THE POINT. Landing the positions on the
 * coarse surface while leaving the fine mesh's normals alone would swap one
 * shading for another at the transition — §T.64's "the colour change is not
 * colour". The target is the coarse geometry's own vertex normals interpolated
 * in the same triangle, so at morph = 1 the fine mesh shades as the coarse
 * mesh does, and the swap is invisible in value as well as in silhouette.
 *
 * The APRON and SKIRT get a zero delta, and that is exact rather than lazy:
 * every apron ring is the boundary loop scaled by a scalar at a y that depends
 * only on the ring, so a fine apron vertex lies exactly on the straight line
 * between its two coarse neighbours at exactly their y. There is nothing to
 * morph. (The grid's own boundary ROW is interior data and is morphed with
 * everything else.)
 */
export function buildTerrainMorph(
  hm: IslandHeightmap,
  fine: THREE.BufferGeometry,
  coarse: THREE.BufferGeometry,
  fineStride: number,
  coarseStride: number,
): TerrainMorph {
  const src = hm.size;
  const nF = lodGridSize(src, fineStride);
  const nC = lodGridSize(src, coarseStride);
  const fPos = fine.getAttribute('position').array as Float32Array;
  const fNrm = fine.getAttribute('normal').array as Float32Array;
  const cPos = coarse.getAttribute('position').array as Float32Array;
  const cNrm = coarse.getAttribute('normal').array as Float32Array;
  const total = fPos.length / 3;
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  let maxHeightDelta = 0;

  for (let iz = 0; iz < nF; iz++) {
    const sz = lodSrcIndex(iz, fineStride, src);
    const cz = lodCellOf(sz, coarseStride, src);
    for (let ix = 0; ix < nF; ix++) {
      const sx = lodSrcIndex(ix, fineStride, src);
      const cx = lodCellOf(sx, coarseStride, src);
      const jx = Math.min(cx.cell, nC - 2);
      const jz = Math.min(cz.cell, nC - 2);
      const a = (jz * nC + jx) * 3;
      const b = (jz * nC + jx + 1) * 3;
      const c = ((jz + 1) * nC + jx) * 3;
      const d = ((jz + 1) * nC + jx + 1) * 3;
      const near = cx.t + cz.t <= 1;
      // barycentric in the containing coarse triangle — the same split the
      // index buffer writes, so this IS the drawn surface, not a re-derivation
      const blend = (arr: Float32Array, k: number): number =>
        near
          ? arr[a + k] + (arr[b + k] - arr[a + k]) * cx.t + (arr[c + k] - arr[a + k]) * cz.t
          : arr[d + k] +
            (arr[c + k] - arr[d + k]) * (1 - cx.t) +
            (arr[b + k] - arr[d + k]) * (1 - cz.t);
      const v = (iz * nF + ix) * 3;
      const dy = blend(cPos, 1) - fPos[v + 1];
      position[v + 1] = dy;
      if (Math.abs(dy) > maxHeightDelta) maxHeightDelta = Math.abs(dy);
      const nx = blend(cNrm, 0);
      const ny = blend(cNrm, 1);
      const nz = blend(cNrm, 2);
      const len = Math.max(Math.hypot(nx, ny, nz), 1e-6); // §V28
      normal[v] = nx / len - fNrm[v];
      normal[v + 1] = ny / len - fNrm[v + 1];
      normal[v + 2] = nz / len - fNrm[v + 2];
    }
  }
  return { position, normal, maxHeightDelta };
}

/**
 * Mount a morph target on a geometry. RELATIVE, so `morphTargetInfluences[0]`
 * is the morph factor itself and 0 leaves the fine mesh untouched — three's
 * `morphReference` then keeps the base influence at 1 rather than subtracting
 * (nodes/accessors/MorphNode.js).
 */
export function applyTerrainMorph(geometry: THREE.BufferGeometry, morph: TerrainMorph): void {
  geometry.morphAttributes.position = [new THREE.BufferAttribute(morph.position, 3)];
  geometry.morphAttributes.normal = [new THREE.BufferAttribute(morph.normal, 3)];
  geometry.morphTargetsRelative = true;
}

export interface TerrainLodPlan {
  /** which tessellation level is mounted */
  level: number;
  /** CDLOD morph factor for that level, 0 = its own shape, 1 = its parent's */
  morph: number;
}

/**
 * Camera distance → (level, morph). CONTINUOUS BY CONSTRUCTION: the morph
 * ramps 0 → 1 over `lodTerrainMorphBand` metres ending exactly at
 * `lodTerrainDistance`, and level 1 is what level 0 already looks like at
 * morph 1 — so the geometry pointer changes at the one distance where the two
 * surfaces are equal. Pure, so tests pin the ramp without a renderer.
 */
export function terrainLodPlan(cameraDistance: number, p = islandParams): TerrainLodPlan {
  const swap = p.lodTerrainDistance;
  if (cameraDistance >= swap) return { level: 1, morph: 0 };
  const band = Math.max(p.lodTerrainMorphBand, 0);
  if (band <= 0 || !p.lodTerrainMorph) return { level: 0, morph: 0 };
  const t = (cameraDistance - (swap - band)) / band;
  return { level: 0, morph: t <= 0 ? 0 : t >= 1 ? 1 : t };
}

/**
 * Bytes three r180 spends on the morph of one geometry: a
 * `DataArrayTexture(width, height, targets)` of RGBA32F, where the row is
 * `vertexCount × 2` texels (position + normal) capped at 4096
 * (nodes/accessors/MorphNode.js `getEntry`). Reported rather than guessed —
 * the morph is the only thing in this task that costs standing VRAM.
 */
export function terrainMorphBytes(vertexCount: number, targets = 1): number {
  const wanted = vertexCount * 2;
  const width = Math.min(wanted, 4096);
  const height = wanted > 4096 ? Math.ceil(wanted / 4096) : 1;
  return width * height * 4 * 4 * targets;
}

export interface IslandMeshHandle {
  mesh: THREE.Mesh;
  material: TerrainBlendMaterialHandle;
  /**
   * Waterline wiring: the sand wet-band + slope blend read the water level as
   * a uniform. Default source is params/terrain.waterline (Tweakpane); the
   * ocean system may drive it directly per frame via setWaterline().
   */
  setWaterline(y: number): void;
  /** swap tessellation level: 0 = full heightmap grid, 1 = decimated (§V17) */
  setLod(level: number): void;
  /**
   * T112g: the level AND the CDLOD morph for a camera distance, in one call.
   * This is what callers should use — `setLod` alone lands the tessellation
   * change in a single frame, which is the pop.
   */
  setLodDistance(cameraDistance: number, p?: typeof islandParams): void;
  /** currently mounted LOD level */
  readonly lod: number;
  /** currently applied CDLOD morph factor (0 = own shape, 1 = parent's) */
  readonly morph: number;
  /** largest height a vertex travels across the morph band (m) */
  readonly morphHeightDelta: number;
  /** push live Tweakpane edits of terrain params into GPU uniforms */
  updateFromParams(): void;
  dispose(): void;
}

/**
 * LOD level for a camera distance (§V17). Pure so tests pin the switch
 * without a renderer; hysteresis is deliberately absent because the swap is a
 * geometry pointer change with no cost and no visual pop at 900 m.
 */
export function selectTerrainLod(
  cameraDistance: number,
  p = islandParams,
): number {
  return cameraDistance > p.lodTerrainDistance ? 1 : 0;
}

/** Build the island terrain mesh with the sand↔rock blend material. */
export function createIslandMesh(
  hm: IslandHeightmap,
  skirtDepth: number = islandParams.skirtDepth,
  /**
   * Shared blend material (islandMaterials.ts). Omit and the mesh builds and
   * owns its own — convenient for a single island, wasteful for an
   * archipelago (§V17: one node graph per island for shaders that differ in
   * nothing).
   */
  shared?: TerrainBlendMaterialHandle,
): IslandMeshHandle {
  const near = buildIslandGeometry(hm, skirtDepth, 1);
  const far = buildIslandGeometry(hm, skirtDepth, islandParams.lodTerrainStride);
  const levels = [near, far];
  // T112g: level 0 carries the delta onto level 1's surface, so the two are
  // the same shape at morph 1 and the swap costs nothing to look at
  const morphData = buildTerrainMorph(hm, near, far, 1, islandParams.lodTerrainStride);
  // the A/B switch gates the MOUNT, not just the influence: an unmounted
  // target is ~2.3 MB of DataArrayTexture per slice island that three would
  // otherwise upload and sample for a factor pinned at 0
  if (islandParams.lodTerrainMorph) applyTerrainMorph(near, morphData);
  const material = shared ?? terrainBlendMaterial();
  material.uniforms.sand.waterline.value = terrainParams.waterline;
  const mesh = new THREE.Mesh(near, material.material);
  mesh.name = 'island-terrain';
  // §V10: the shoreline is an intersection-foam target exactly like a hull —
  // flowfoam's injection pass picks this up by traversal, so the surf line at
  // the beach comes out of the SAME machinery as the wake, not a second one
  mesh.userData.foamTarget = true;
  mesh.receiveShadow = true;
  mesh.castShadow = islandParams.castShadows;
  let lod = 0;
  let morph = 0;
  // owned explicitly rather than left to `Mesh.updateMorphTargets`, which only
  // repopulates the array when the geometry is assigned — and this mesh swaps
  // to a level that has no morph attributes and back
  mesh.morphTargetInfluences = [0];
  const setMorph = (k: number): void => {
    morph = k;
    (mesh.morphTargetInfluences as number[])[0] = k;
  };
  return {
    mesh,
    material,
    get lod(): number {
      return lod;
    },
    get morph(): number {
      return morph;
    },
    get morphHeightDelta(): number {
      return morphData.maxHeightDelta;
    },
    setWaterline(y: number): void {
      material.uniforms.sand.waterline.value = y;
    },
    setLod(level: number): void {
      const clamped = Math.min(Math.max(Math.floor(level), 0), levels.length - 1);
      if (clamped === lod) return;
      lod = clamped;
      mesh.geometry = levels[clamped];
    },
    setLodDistance(cameraDistance: number, p = islandParams): void {
      const plan = terrainLodPlan(cameraDistance, p);
      if (plan.level !== lod) {
        lod = plan.level;
        mesh.geometry = levels[lod];
      }
      // level 1 has no morph target; writing the influence is harmless and
      // keeps the reported value honest about what is applied
      if (plan.morph !== morph) setMorph(plan.morph);
    },
    updateFromParams(): void {
      material.updateFromParams();
    },
    dispose(): void {
      for (const g of levels) g.dispose();
      if (!shared) material.dispose(); // injected materials belong to the caller
    },
  };
}
