/**
 * Speedboat circuits (§T.187): the race island kit and Tower Reach.
 * Data + terrain only; the course furniture's render side is `courseFurniture.ts`
 * (three.js), imported directly by pages that draw it.
 */
export {
  BAR_MIN_CREST_DEPTH,
  BOAT_BEAM,
  BOAT_DRAFT,
  CORRIDOR_HALF_WIDTH,
  CORRIDOR_MIN_DEPTH,
  MIN_GATE_WIDTH,
  TOWER_REACH_ID,
  TOWER_REACH_LAPS,
  buildTowerReach,
  swellFrame,
  towerReachSites,
  type BarInfo,
  type BuildTowerReachOptions,
  type BuoyPlacement,
  type CourseFurnitureData,
  type GateInfo,
  type MinimapData,
  type PolePlacement,
  type PylonPlacement,
  type RoofKind,
  type RoofPlacement,
  type StakePlacement,
  type TowerPlacement,
  type TowerReachSites,
  type TowerReachWorld,
} from './towerReach';
export { createRaceSeabed, BAR_PASS_THROUGH_DEPTH, type RaceSeabed } from './raceSeabed';
export { REFERENCE_SEA, EXPOSED_MIN_K, SHELTERED_MAX_K, SECTOR_SPLIT_K, createShelterField, sectorOf } from './shelter';
export { kitField, kitOverrides, registerKitIsland, type KitSpec } from './kitFamilies';
