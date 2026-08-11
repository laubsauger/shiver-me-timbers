/**
 * Island terrain mesh (T20): heightmap grid → BufferGeometry + T27's
 * terrainBlendMaterial (sand on low/flat, rock on steep/high — §V16 tunables
 * in params/terrain.ts, waterline uniform wired below).
 *
 * Geometry gets a perimeter skirt extruded straight down to -skirtDepth so
 * the shoreline never shows a gap between water surface and terrain edge.
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

/**
 * Heightmap → indexed grid geometry (positions + computed normals) with a
 * closed perimeter skirt down to y = -skirtDepth.
 */
export function buildIslandGeometry(
  hm: IslandHeightmap,
  skirtDepth: number = islandParams.skirtDepth,
): THREE.BufferGeometry {
  const n = hm.size;
  const R = hm.worldRadius;
  const cell = (2 * R) / (n - 1);
  const perim = 4 * (n - 1);
  const positions = new Float32Array((n * n + perim) * 3);

  // interior grid vertices
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const v = (iz * n + ix) * 3;
      positions[v] = -R + ix * cell;
      positions[v + 1] = hm.data[iz * n + ix];
      positions[v + 2] = -R + iz * cell;
    }
  }

  // ordered boundary loop: top row → right col → bottom row → left col
  const boundary = new Uint32Array(perim);
  let k = 0;
  for (let ix = 0; ix < n - 1; ix++) boundary[k++] = ix; // z = -R
  for (let iz = 0; iz < n - 1; iz++) boundary[k++] = iz * n + (n - 1); // x = +R
  for (let ix = n - 1; ix > 0; ix--) boundary[k++] = (n - 1) * n + ix; // z = +R
  for (let iz = n - 1; iz > 0; iz--) boundary[k++] = iz * n; // x = -R

  // skirt vertices: boundary xz, pushed down to -skirtDepth
  for (let i = 0; i < perim; i++) {
    const b = boundary[i] * 3;
    const v = (n * n + i) * 3;
    positions[v] = positions[b];
    positions[v + 1] = -skirtDepth;
    positions[v + 2] = positions[b + 2];
  }

  const quadCount = (n - 1) * (n - 1) + perim;
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
  // skirt quads (wound to face outward, away from the island center)
  for (let i = 0; i < perim; i++) {
    const j = (i + 1) % perim;
    const bi = boundary[i];
    const bj = boundary[j];
    const si = n * n + i;
    const sj = n * n + j;
    indices[t++] = bi;
    indices[t++] = bj;
    indices[t++] = si;
    indices[t++] = bj;
    indices[t++] = sj;
    indices[t++] = si;
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
  /** push live Tweakpane edits of terrain params into GPU uniforms */
  updateFromParams(): void;
  dispose(): void;
}

/** Build the island terrain mesh with the sand↔rock blend material. */
export function createIslandMesh(
  hm: IslandHeightmap,
  skirtDepth: number = islandParams.skirtDepth,
): IslandMeshHandle {
  const geometry = buildIslandGeometry(hm, skirtDepth);
  const material = terrainBlendMaterial();
  material.uniforms.sand.waterline.value = terrainParams.waterline;
  const mesh = new THREE.Mesh(geometry, material.material);
  return {
    mesh,
    material,
    setWaterline(y: number): void {
      material.uniforms.sand.waterline.value = y;
    },
    updateFromParams(): void {
      material.updateFromParams();
    },
    dispose(): void {
      geometry.dispose();
      material.dispose();
    },
  };
}
