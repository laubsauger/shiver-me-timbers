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
  /** currently mounted LOD level */
  readonly lod: number;
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
  return {
    mesh,
    material,
    get lod(): number {
      return lod;
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
    updateFromParams(): void {
      material.updateFromParams();
    },
    dispose(): void {
      for (const g of levels) g.dispose();
      if (!shared) material.dispose(); // injected materials belong to the caller
    },
  };
}
