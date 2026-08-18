/**
 * Terrain material library (T27, §V16) — public surface for T20 island work.
 *
 * INTEGRATION (T20 heightmap terrain):
 * - `terrainBlendMaterial(rockOpts, sandOpts)` → one MeshStandardNodeMaterial
 *   for the island mesh, THREE layers on two axes: a sand skirt in the shore
 *   band at the water, green ground cover above it, rock wherever it is too
 *   steep to hold either, plus the shore wetness band around
 *   `terrainParams.waterline`. No UVs required anywhere (rock is tri-planar,
 *   sand and cover sample world XZ). See groundCover.ts for why elevation had
 *   to become a second axis — on slope alone, sand won 82-98% of an island.
 * - `createRockMaterial(opts)` / `createSandMaterial(opts)` → stand-alone
 *   materials for scattered rock meshes / pure beach patches.
 * - opts take `{ sunDirection?: THREE.Vector3 }`; per frame the sky system
 *   (T15) should update handle.uniforms…sunDirection.value (blend handle:
 *   `setSunDirection(v)`).
 * - ALL tunables live in params/terrain.ts (Tweakpane-bound). The panel
 *   mutates params in place; call handle.updateFromParams() per frame or on
 *   change to push values into GPU uniforms. `noiseOctaves` alone needs a
 *   material rebuild (build-time loop unroll).
 * - Materials are constructible without a renderer (node graphs only, GPU
 *   touched lazily on first render) — safe to import from tests and sim code.
 * - Noise: TSL helpers in noise.ts, pure-CPU mirror in noiseCpu.ts (no three
 *   imports; verified by tests/terrain.test.ts). Both return [0, 1].
 */
export {
  hash2,
  hash3,
  fade,
  valueNoise2,
  fbm2,
  triplanarWeights,
  triplanarFbm,
} from './noise';
export {
  fractCpu,
  hash2Cpu,
  hash3Cpu,
  fadeCpu,
  valueNoise2Cpu,
  fbm2Cpu,
} from './noiseCpu';
export {
  createRockMaterial,
  createRockUniforms,
  updateRockUniforms,
  buildRockNodes,
  type RockMaterialOptions,
  type RockMaterialHandle,
  type RockUniforms,
} from './rockMaterial';
export {
  createAerialUniforms,
  updateAerialUniforms,
  aerialHazeFactor,
  aerialOutputNode,
  aerialHazeFactorCpu,
  type AerialUniforms,
} from './aerialPerspective';
export {
  createCoverUniforms,
  updateCoverUniforms,
  buildCoverNodes,
  coverSlopeWeight,
  type CoverUniforms,
  type CoverNodes,
} from './groundCover';
export {
  buildGrassGeometry,
  buildShrubGeometry,
  generateCoverPlacements,
  createCoverMeshMaterial,
  createCoverMeshUniforms,
  updateCoverMeshUniforms,
  createGroundCover,
  type CoverPlacement,
  type CoverTerrain,
  type CoverMeshMaterial,
  type CoverMeshUniforms,
  type GroundCoverMeshes,
} from './groundCoverMesh';
export {
  createShoreUniforms,
  updateShoreUniforms,
  buildShoreNodes,
  swashShapeCpu,
  wetLevelCpu,
  type ShoreUniforms,
  type ShoreNodes,
} from './shoreRunup';
export {
  createSandMaterial,
  createSandUniforms,
  updateSandUniforms,
  buildSandNodes,
  terrainBlendMaterial,
  type SandMaterialOptions,
  type SandMaterialHandle,
  type SandUniforms,
  type TerrainBlendMaterialHandle,
} from './sandMaterial';
export { terrainParams, type TerrainParams } from '../params/terrain';
