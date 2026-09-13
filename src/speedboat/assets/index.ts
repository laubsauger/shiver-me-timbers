/**
 * Speedboat asset runtime (docs/speedboat/asset-pipeline.md). Load a contract GLB, rebuild its
 * slots as TSL node materials with the sea's water-lighting hook, tag the hull for foam and the
 * wetline, and hand out LOD instances that share everything but their livery.
 */
export {
  ASSET_CONTRACT,
  SLOT_NAMES,
  isSlotName,
  lodDistances,
  readBoatExtras,
  tagFoamTargets,
  textureBytes,
  wetlineOptions,
  type AssetContract,
  type BoatExtras,
  type SlotName,
} from './contract';
export { createSlotMaterial, type BoatVariant, type SlotMaterialOptions } from './slotMaterials';
export {
  PIPELINE_TEST_BOAT_URL,
  assetFromGltf,
  createBoatAssetLoader,
  type BoatAsset,
  type BoatAssetLoader,
  type BoatAssetStats,
  type BoatInstance,
  type BoatInstanceOptions,
} from './boatModel';
