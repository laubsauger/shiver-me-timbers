/**
 * Island system barrel (T20/T33). Public surface for main.ts and the other
 * agents:
 *
 * - `createArchipelago({ seed })` — the whole world of islands in one call:
 *   deterministic scatter (§V2), meshes, rocks, palms, and the shared seabed
 *   field. Add `.group` to the scene, call `.update(frame, waterLevelAt)`.
 * - `archipelago.seabed` — the SEABED DEPTH FIELD (src/island/seabed.ts). CPU
 *   `heightAt/depthAt` for buoyancy grounding (§V8); `texture` + the TSL
 *   helpers `seabedHeightNode` / `seabedShallowFactorNode` for the ocean
 *   material's shallows tint and the T32 caustics receivers (§V34).
 * - `createIsland(...)` — a single island, if something wants one directly.
 *
 * Everything under here is constructible without a renderer (node graphs and
 * plain data only; the GPU is touched lazily on first render), so tests and
 * sim code may import it freely.
 */
export {
  generateIslandHeightmap,
  findShoreRadius,
  gradientAt,
  type IslandHeightmap,
  type IslandHeightmapParams,
} from './heightmap';
export { buildIslandGeometry, createIslandMesh, selectTerrainLod } from './islandMesh';
export { generateRockPlacements, deformRockGeometry, createRocks } from './rocks';
export {
  islandPalmPlacement,
  createIslandPalms,
  palmLodCount,
  palmGroveAngles,
} from './palms';
export {
  createIsland,
  islandPalmCount,
  islandPeakHeights,
  type Island,
  type IslandFrame,
  type CreateIslandOptions,
} from './island';
export {
  ARCHETYPES,
  buildArchetype,
  combineFeatures,
  featureHeight,
  smoothMax,
  pickArchetype,
  type ArchetypeName,
  type Feature,
} from './archetypes';
export {
  sampleSeabedHeight,
  createSeabedField,
  seabedHeightNode,
  seabedShallowFactorNode,
  type SeabedField,
  type SeabedIsland,
} from './seabed';
export {
  createIslandMaterials,
  type IslandMaterials,
} from './islandMaterials';
export {
  generateIslandSites,
  createArchipelago,
  siteParams,
  type IslandSite,
  type Archipelago,
  type WaterLevelFn,
  type WorldAnchorage,
  type CreateArchipelagoOptions,
} from './archipelago';
export {
  SHOWCASE_LAGOON,
  SHOWCASE_SEED_STRIDE,
  findLagoonAnchorage,
  type Anchorage,
  type AnchorageOptions,
  type ShowcaseIsland,
} from './showcase';
export { islandParams, type IslandParams } from '../params/island';
