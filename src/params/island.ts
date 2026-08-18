/**
 * Island tunables (T20, §V16: every tunable lives in a params module and
 * appears in Tweakpane — no magic constants in generation code or shaders).
 * Consumed by src/island/* — heightmap shape, mesh skirt, palm/rock scatter.
 *
 * Shape values (radius…rimDepth, rock geometry values) are read at BUILD time:
 * a live panel tweak needs a createIsland() rebuild to show. Material tunables
 * live in params/terrain.ts and params/vegetation.ts and stay live per frame.
 */
import { registerParams, type ParamMeta } from './registry';

export interface IslandParams {
  // -- footprint + heightmap grid -------------------------------------------
  /** island footprint radius (m); heightmap spans [-radius, radius]² */
  radius: number;
  /** heightmap grid resolution per side (vertices) */
  gridSize: number;

  // -- dome shape ------------------------------------------------------------
  /** target peak height above waterline (m) */
  peakHeight: number;
  /** guaranteed minimum interior peak (m) — grid rescales if noise undershoots */
  minPeakHeight: number;

  // -- heightmap fbm (uses terrain/noiseCpu) ---------------------------------
  /** world-space noise frequency (1/m) */
  noiseScale: number;
  /** relative height modulation, must stay < 1 (0 = pure dome) */
  noiseStrength: number;
  noiseOctaves: number;

  // -- archetype composition (§V43: silhouette is authored, not sampled) -----
  /** fraction of the footprint the archetype's features may occupy — they must
   *  die out well inside the rim so the COASTLINE belongs to the noise */
  featureExtent: number;
  /** metres over which two features fuse instead of creasing */
  featureBlend: number;
  /** coastline noise world frequency (1/m) — sets cove/headland wavelength */
  coastNoiseScale: number;
  /** coastline noise amplitude, as a fraction of peak height */
  coastNoiseStrength: number;
  /** fraction of the radius inside which the rim envelope does not act */
  rimStart: number;

  // -- sea stacks (§V43 silhouette; see archetypes.buildSeaStacks) ----------
  /**
   * Upper bound on stacks standing off the shore, before the per-archetype
   * affinity scales it. These are HEIGHT-FIELD features, not rock meshes, so
   * they cost no draw call and no cull distance — see buildSeaStacks for why
   * that is the whole point.
   */
  seaStackCount: number;
  /** ring they stand on, fraction of the footprint radius */
  seaStackRing: number;
  /** footprint radius range, fraction of the island radius. The floor must
   *  stay well above one DECIMATED terrain cell (radius/gridSize ×
   *  lodTerrainStride) or the stacks vanish at exactly the range they exist
   *  for. */
  seaStackRadiusMin: number;
  seaStackRadiusMax: number;
  /** height range, fraction of the island peak height */
  seaStackHeightMin: number;
  seaStackHeightMax: number;

  // -- headlands (§V43 coastline; see archetypes.buildHeadlands) ------------
  /**
   * Cliff masses per island. Zero gives back the shipping look: a shelving
   * beach on every bearing (measured median coastal slope 5-8°, and 0% of the
   * shoreline steeper than 45° on three of five islands).
   */
  headlandCount: number;
  /** how far out the mass sits, fraction of the footprint radius */
  headlandOffset: number;
  /** footprint radius range, fraction of the island radius */
  headlandRadiusMin: number;
  headlandRadiusMax: number;
  /** height range, fraction of the island peak height */
  headlandHeightMin: number;
  headlandHeightMax: number;
  /** wall width as a fraction of the headland radius — small = sheerer cliff */
  headlandEdge: number;

  // -- beach apron (gentle 0..~band slope where height crosses waterline) ----
  /** height band (m) around waterline that gets flattened */
  beachBandWidth: number;
  /** slope multiplier at the waterline (0 = dead flat, 1 = no apron) */
  beachFlatness: number;

  // -- lagoon basin (authored shallow floor; see heightmap.lagoonBasin) ------
  /**
   * Depth (m) of the authored lagoon floor. 0 DISABLES the basin entirely,
   * which is the default: only the showcase island (island/showcase.ts) turns
   * it on, and every procedurally scattered island is byte-identical without
   * it.
   *
   * THE NUMBER IS SET BY THE SEA, NOT BY TASTE. There is no shoaling anywhere
   * in the ocean (the seabed field drives COLOUR only — surfaceMaterial's
   * `seabedShallowFactorNode` feeds the tint mix, nothing touches
   * displacement), so the surface swings its full open-ocean amplitude over a
   * 1 m floor exactly as it does over 45 m. Measured deepest trough over 60 s
   * of a 320 m patch through the CpuOcean mirror: calm −1.20 m, swell (the
   * shipped default) −3.96 m, storm −18.3 m. A floor shallower than the trough
   * is EXPOSED — the ocean mesh drops below the sand, loses the depth test,
   * and the whole lagoon flickers dry in lockstep with the swell. So the basin
   * clears the swell trough, and the genuinely 0-3 m water is the beach shelf
   * OUTSIDE the basin, which dries and refloods every cycle by design: that
   * band is the shore break, not a defect.
   */
  lagoonDepth: number;
  /** basin disc radius, fraction of the footprint radius */
  lagoonRadius: number;
  /** metres (as a fraction of footprint radius) the basin fades out over */
  lagoonFeather: number;
  /**
   * Metres of ARCHETYPE landmass over which the basin yields. The gate is on
   * the feature height, not on the finished height — see heightmap.lagoonBasin
   * for the measurement that forced that (an h-gate fired nowhere, because
   * coast noise had already filled the bay with dry land).
   */
  lagoonLandGuard: number;
  /**
   * Fraction of the island's own detail noise kept on the basin floor, so the
   * lagoon bed undulates like sand instead of reading as a plane. Small: the
   * detail field is scaled off `peakHeight` and is tens of metres tall on a
   * big island, and this floor is 4.5 m under water.
   */
  lagoonFloorRelief: number;
  /**
   * How far the basin centre is pushed out from the island origin, as a
   * fraction of the footprint radius, along the bearing carrying the least
   * landmass (heightmap.findBayBearing). 0 leaves it at the origin, which
   * measured as a landlocked crater on every world seed.
   */
  lagoonOffset: number;

  // -- submerged rim + mesh skirt --------------------------------------------
  /** guaranteed depth (m) of the island boundary below waterline */
  rimDepth: number;
  /** skirt bottom depth (m below waterline) so no gap shows at the shore */
  skirtDepth: number;

  // -- palms -----------------------------------------------------------------
  palmCount: number;
  /** fraction of palms biased onto the beach ring vs sparse interior */
  palmBeachFraction: number;
  /** how far inland from the shoreline beach palms sit (m) */
  palmBeachSetback: number;
  /** interior palm scatter disc radius, fraction of island radius */
  palmInteriorRadius: number;
  /** max terrain gradient |∇h| (m/m) a palm accepts */
  palmSlopeLimit: number;
  /** min terrain height above waterline (m) a palm accepts */
  palmMinHeight: number;
  /**
   * Palms grow in GROVES, not scattered (§V43 — evenly-spaced palms measured
   * an angular-gap CV of 0.84, i.e. Poisson-random, and that reads as the
   * single most "generated" tell on an island). These control the groves:
   * how many stands ring the island, and how tightly each one packs.
   */
  palmGroveCount: number;
  /** arc half-width (m) of a grove along the shoreline — small = tight stand */
  palmGroveSpread: number;
  /** how much wider the inland tail of a grove spreads than its beach front */
  palmGroveInlandFlare: number;

  // -- rocks -----------------------------------------------------------------
  rockCount: number;
  /** radial jitter around the shoreline (m); negative→inland, positive→sea */
  rockSpread: number;
  rockMinScale: number;
  rockMaxScale: number;
  /** vertical squash range (rock height = scale × squash) */
  rockSquashMin: number;
  rockSquashMax: number;
  /** per-vertex radial perturbation amplitude (fraction of radius) */
  rockNoiseAmp: number;
  /** perturbation noise frequency on the unit icosahedron */
  rockNoiseFreq: number;
  rockNoiseOctaves: number;
  /** icosahedron subdivision level */
  rockDetail: number;
  /** distinct deformed geometries shared across rock meshes */
  rockGeoVariants: number;
  /** how deep a rock sinks into the ground, fraction of its half-height */
  rockEmbed: number;

  // -- archipelago scatter (T33; §V2: same seed ⇒ same world) ----------------
  /** islands scattered around the play area */
  islandCount: number;
  /** annulus (m) from the world origin islands are placed in */
  scatterMinDistance: number;
  scatterMaxDistance: number;
  /** no island footprint may come within this of the spawn point (m) */
  spawnClearance: number;
  /** minimum open-water gap between two island footprints (m) */
  islandGap: number;
  /** per-island footprint radius range (m) — scatter overrides `radius` */
  scatterRadiusMin: number;
  scatterRadiusMax: number;

  // -- seabed depth field (T33 keystone: ocean shallows tint + §V8 grounding) -
  /** open-ocean seabed height (m, negative) reported away from any island */
  seabedOpenDepth: number;
  /** submerged shelf width (m) blending the island rim out to open depth —
   *  this is what paints the turquoise halo, so it is a LOOK tunable */
  seabedShelfWidth: number;
  /** GPU seabed height texture resolution (texels per side, build time) */
  seabedTextureSize: number;
  /** margin (m) added around the island bounds when fitting the texture */
  seabedTextureMargin: number;

  // -- LOD + shadows (§V17 — the budget is spent, scenery must be cheap) -----
  /** beyond this camera distance the terrain swaps to the decimated grid (m) */
  lodTerrainDistance: number;
  /**
   * Vertex stride of the far terrain grid (1 = no decimation).
   *
   * This is a SILHOUETTE tunable, not only a cost one, and it was set against
   * the wrong thing. At stride 4 a default island decimates to 13 m cells,
   * which is wider than a sea stack and comparable to a headland wall — so
   * exactly the features that exist to be read at 2-4 km were the ones the
   * far LOD threw away, while palms and rocks are already culled by then.
   * At stride 2 the far grid is 64² ≈ 4k vertices per island (20k across the
   * world), which is nothing next to what it protects.
   */
  lodTerrainStride: number;
  /** palm instance count ramps from full to zero between these distances (m) */
  lodPalmFull: number;
  lodPalmCull: number;
  /** rocks hidden beyond this camera distance (m) */
  lodRockCull: number;
  /**
   * How far outside its own footprint an island stays tagged as a §V10
   * intersection-foam target (m). flowfoam's injection pass captures every
   * `userData.foamTarget` mesh in the scene each frame, and its ortho region
   * is only ~120 m wide around the ship — so islands on the far side of the
   * map would be 20-odd wasted draws per frame. Must comfortably exceed half
   * the flowfoam region size.
   */
  foamTargetMargin: number;
  /** island geometry casts sun shadows (the shadow frustum follows the ship) */
  castShadows: boolean;
}

export const islandParams: IslandParams = registerParams(
  'island',
  {
    radius: 90,
    gridSize: 128,
    peakHeight: 40,
    minPeakHeight: 34,
    noiseScale: 0.035,
    noiseStrength: 0.18,
    noiseOctaves: 4,
    featureExtent: 0.62,
    featureBlend: 14,
    coastNoiseScale: 0.012,
    coastNoiseStrength: 0.14,
    rimStart: 0.84,
    seaStackCount: 3,
    seaStackRing: 0.72,
    seaStackRadiusMin: 0.15,
    seaStackRadiusMax: 0.21,
    seaStackHeightMin: 0.3,
    seaStackHeightMax: 0.62,
    headlandCount: 3,
    headlandOffset: 0.68,
    headlandRadiusMin: 0.3,
    headlandRadiusMax: 0.42,
    headlandHeightMin: 0.45,
    headlandHeightMax: 0.8,
    headlandEdge: 0.1,
    beachBandWidth: 3.0,
    beachFlatness: 0.24,
    lagoonDepth: 0,
    lagoonRadius: 0.3,
    lagoonFeather: 0.24,
    lagoonLandGuard: 6,
    lagoonFloorRelief: 0.05,
    lagoonOffset: 0.6,
    rimDepth: 6,
    skirtDepth: 8,
    palmCount: 28,
    palmBeachFraction: 0.82,
    palmBeachSetback: 5,
    palmInteriorRadius: 0.55,
    palmSlopeLimit: 0.55,
    palmMinHeight: 0.3,
    palmGroveCount: 4,
    palmGroveSpread: 26,
    palmGroveInlandFlare: 2.4,
    rockCount: 18,
    rockSpread: 14,
    rockMinScale: 3.0,
    rockMaxScale: 8.0,
    rockSquashMin: 0.55,
    rockSquashMax: 0.9,
    rockNoiseAmp: 0.35,
    rockNoiseFreq: 1.4,
    rockNoiseOctaves: 3,
    rockDetail: 2,
    rockGeoVariants: 4,
    rockEmbed: 0.5,
    islandCount: 5,
    // the sky agent's haze test case wants objects at 2-4 km; the near end
    // keeps one island reachable within a couple of minutes of sailing
    scatterMinDistance: 700,
    scatterMaxDistance: 3600,
    spawnClearance: 450,
    islandGap: 400,
    scatterRadiusMin: 110,
    scatterRadiusMax: 260,
    seabedOpenDepth: 45,
    seabedShelfWidth: 260,
    seabedTextureSize: 1024,
    seabedTextureMargin: 400,
    lodTerrainDistance: 900,
    lodTerrainStride: 2,
    lodPalmFull: 500,
    lodPalmCull: 1400,
    lodRockCull: 1800,
    foamTargetMargin: 220,
    castShadows: true,
  },
  islandParamsMeta(),
);

function islandParamsMeta(): Partial<Record<keyof IslandParams, ParamMeta>> {
  return {
    radius: { min: 20, max: 400, step: 5 },
    gridSize: { min: 32, max: 512, step: 16 },
    peakHeight: { min: 4, max: 80, step: 1 },
    minPeakHeight: { min: 1, max: 60, step: 1 },
    noiseScale: { min: 0.005, max: 0.2, step: 0.005 },
    noiseStrength: { min: 0, max: 0.8, step: 0.05 },
    noiseOctaves: { min: 1, max: 6, step: 1 },
    featureExtent: { min: 0.2, max: 0.95, step: 0.01 },
    featureBlend: { min: 1, max: 60, step: 1 },
    coastNoiseScale: { min: 0.002, max: 0.08, step: 0.001 },
    coastNoiseStrength: { min: 0, max: 0.5, step: 0.01 },
    rimStart: { min: 0.5, max: 0.98, step: 0.01 },
    seaStackCount: { min: 0, max: 8, step: 1 },
    seaStackRing: { min: 0.3, max: 0.95, step: 0.01 },
    seaStackRadiusMin: { min: 0.03, max: 0.3, step: 0.01 },
    seaStackRadiusMax: { min: 0.03, max: 0.4, step: 0.01 },
    seaStackHeightMin: { min: 0, max: 1.2, step: 0.02 },
    seaStackHeightMax: { min: 0, max: 1.5, step: 0.02 },
    headlandCount: { min: 0, max: 5, step: 1 },
    headlandOffset: { min: 0, max: 0.9, step: 0.01 },
    headlandRadiusMin: { min: 0.05, max: 0.7, step: 0.01 },
    headlandRadiusMax: { min: 0.05, max: 0.8, step: 0.01 },
    headlandHeightMin: { min: 0, max: 1.2, step: 0.02 },
    headlandHeightMax: { min: 0, max: 1.5, step: 0.02 },
    headlandEdge: { min: 0.04, max: 0.6, step: 0.01 },
    beachBandWidth: { min: 0.2, max: 6, step: 0.1 },
    beachFlatness: { min: 0.05, max: 1, step: 0.05 },
    lagoonDepth: { min: 0, max: 12, step: 0.1 },
    lagoonRadius: { min: 0.05, max: 0.8, step: 0.01 },
    lagoonFeather: { min: 0.02, max: 0.6, step: 0.01 },
    lagoonLandGuard: { min: 0.5, max: 30, step: 0.5 },
    lagoonFloorRelief: { min: 0, max: 0.4, step: 0.01 },
    lagoonOffset: { min: 0, max: 0.8, step: 0.01 },
    rimDepth: { min: 1, max: 20, step: 0.5 },
    skirtDepth: { min: 2, max: 30, step: 0.5 },
    palmCount: { min: 0, max: 120, step: 1 },
    palmBeachFraction: { min: 0, max: 1, step: 0.05 },
    palmBeachSetback: { min: 0, max: 30, step: 0.5 },
    palmInteriorRadius: { min: 0.1, max: 0.9, step: 0.05 },
    palmSlopeLimit: { min: 0.1, max: 1.5, step: 0.05 },
    palmMinHeight: { min: 0, max: 5, step: 0.05 },
    palmGroveCount: { min: 1, max: 12, step: 1 },
    palmGroveSpread: { min: 2, max: 120, step: 1 },
    palmGroveInlandFlare: { min: 1, max: 6, step: 0.1 },
    rockCount: { min: 0, max: 64, step: 1 },
    rockSpread: { min: 0, max: 30, step: 0.5 },
    rockMinScale: { min: 0.2, max: 12, step: 0.1 },
    rockMaxScale: { min: 0.2, max: 20, step: 0.1 },
    rockSquashMin: { min: 0.2, max: 1.5, step: 0.05 },
    rockSquashMax: { min: 0.2, max: 1.5, step: 0.05 },
    rockNoiseAmp: { min: 0, max: 0.8, step: 0.05 },
    rockNoiseFreq: { min: 0.2, max: 6, step: 0.1 },
    rockNoiseOctaves: { min: 1, max: 5, step: 1 },
    rockDetail: { min: 1, max: 4, step: 1 },
    rockGeoVariants: { min: 1, max: 8, step: 1 },
    rockEmbed: { min: 0, max: 1, step: 0.05 },
    islandCount: { min: 0, max: 12, step: 1 },
    scatterMinDistance: { min: 200, max: 4000, step: 50 },
    scatterMaxDistance: { min: 400, max: 4500, step: 50 },
    spawnClearance: { min: 100, max: 2000, step: 25 },
    islandGap: { min: 50, max: 1500, step: 25 },
    scatterRadiusMin: { min: 40, max: 400, step: 10 },
    scatterRadiusMax: { min: 40, max: 600, step: 10 },
    seabedOpenDepth: { min: 10, max: 200, step: 1 },
    seabedShelfWidth: { min: 20, max: 800, step: 10 },
    seabedTextureSize: { min: 128, max: 2048, step: 128 },
    seabedTextureMargin: { min: 0, max: 2000, step: 50 },
    lodTerrainDistance: { min: 100, max: 4000, step: 50 },
    lodTerrainStride: { min: 1, max: 8, step: 1 },
    lodPalmFull: { min: 50, max: 3000, step: 25 },
    lodPalmCull: { min: 50, max: 4000, step: 25 },
    lodRockCull: { min: 50, max: 4600, step: 25 },
    foamTargetMargin: { min: 20, max: 1000, step: 10 },
  };
}
