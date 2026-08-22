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
  /** target peak height above waterline (m) at `radius` */
  peakHeight: number;
  /**
   * Guaranteed minimum interior peak (m) — grid rescales if noise undershoots.
   *
   * THIS RESCALE IS A TRAP FOR ANYTHING THAT FLATTENS TERRAIN. It multiplies
   * every POSITIVE height by `minPeakHeight / max`, and a slope is a ratio of
   * heights, so it scales the slopes too. A thermal-erosion experiment that
   * genuinely flattened the island from a 25.5° median measured 48.9° back out
   * of this line alone. Any operator that lowers the terrain has to move
   * `minPeakHeight` with it or its work is silently undone.
   */
  minPeakHeight: number;
  /**
   * How peak height grows with footprint radius — `peak = peakHeight ×
   * (radius/radius₀)^peakHeightGrowth`. See island.islandPeakHeights.
   *
   * 1.0 (the old behaviour) makes peak/radius a CONSTANT, so a bigger island
   * is a scaled copy of a small one rather than a broader landmass — measured
   * at 0.38-0.52 across every archetype and every radius, which is the
   * statistical fingerprint of "they are all the same cone". 0.5 makes growth
   * go mostly sideways: a 260 m island is 1.7× the height of a 90 m one, not
   * 2.9×.
   */
  peakHeightGrowth: number;

  // -- heightmap fbm (uses terrain/noiseCpu) ---------------------------------
  /** world-space noise frequency (1/m) */
  noiseScale: number;
  /**
   * Surface-detail relief expressed as the SLOPE it is allowed to add (m/m),
   * NOT as a fraction of peak height.
   *
   * WHY THE UNITS CHANGED, and it is the whole island fix. Amplitude used to
   * be `peakHeight × noiseStrength`, and `peakHeight` scales with radius while
   * `noiseScale` is a WORLD-space frequency that does not. So noise slope grew
   * linearly with island size: at R = 260 the detail field was ±20.8 m over a
   * 29 m wavelength — a 55° slope laid over every square metre of the island,
   * including the flat ground the archetypes had already built. Measured:
   * `mesaCliff` at R = 260 with the noise off has 16,865 m² of sub-6° ground
   * at a 73.7 m inscribed radius; with the noise on that is 134 m² at 4.1 m,
   * which is ONE grid cell. The flat ground was always in the composition.
   * The noise ate it.
   *
   * As a slope budget the amplitude is `noiseSlope × (0.5 / noiseScale)`,
   * which is radius-independent BY CONSTRUCTION — so growing an island can no
   * longer make it steeper, and every "make it bigger" move stops backfiring.
   */
  noiseSlope: number;
  noiseOctaves: number;

  // -- archetype composition (§V43: silhouette is authored, not sampled) -----
  /** fraction of the footprint the archetype's features may occupy — they must
   *  die out well inside the rim so the COASTLINE belongs to the noise */
  featureExtent: number;
  /** metres over which two features fuse instead of creasing */
  featureBlend: number;
  /** coastline noise world frequency (1/m) — sets cove/headland wavelength */
  coastNoiseScale: number;
  /**
   * Coastline relief as a SLOPE budget (m/m), same change of units and same
   * reason as `noiseSlope` — amplitude is `coastNoiseSlope × (0.5 /
   * coastNoiseScale)`. This one decides how bold the coves and spits are, and
   * being radius-independent is what lets a small island have a coastline as
   * interesting as a big one instead of a proportionally smaller one.
   */
  coastNoiseSlope: number;
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
  /**
   * Height band (m) around the waterline over which the beach grade is
   * compressed. Wider = longer horizontal run of sand.
   *
   * THE OLD APRON COULD NOT MAKE A BEACH, AND IT IS WORTH KNOWING WHY BECAUSE
   * THE FORM LOOKED RIGHT. It was `h' = h · (flatness + (1−flatness)·S(|h|/b))`
   * — a multiply on the HEIGHT. Differentiate it and the output slope is
   * `s · (f + h·f′)`, not `s · f`: the `h·f′` term means the compression is
   * only real in a vanishing band at exactly h = 0, and by h = 1.5 m the
   * ground is measurably STEEPER than the raw terrain it was handed (23°
   * against 20°). Measured horizontal run from the waterline to +2 m: 6.0 m,
   * and widening the band to 14 m only bought 12.5 m of it.
   *
   * The apron now integrates the slope multiplier instead of multiplying the
   * height (see heightmap.beachApron), so the output slope IS `s · f` all the
   * way across the band and the run comes out where the arithmetic says it
   * should. A beach is a HORIZONTAL feature; the old form was a vertical remap
   * at a fixed horizontal position and could never have produced one.
   */
  beachBandWidth: number;
  /**
   * Slope multiplier across the band (0 = dead flat, 1 = no apron). The user's
   * bar is a beach at 2-6°: with the §V43 noise budget leaving ~9° of natural
   * grade near the shore, 0.15 lands the sand at about 3° over a ~35 m run.
   */
  beachFlatness: number;
  /**
   * Metres of ARCHETYPE landmass over which the apron yields, so a cliff foot
   * is not turned into a beach. See heightmap.beachApron — at the 3 m band the
   * apron only touched the waterline and this was not needed; at the 10 m band
   * a beach requires, it flattened every `sheer` headland wall to zero.
   */
  beachLandGuard: number;

  // -- terrace (authored flat ground; see heightmap.terrace) -----------------
  /**
   * Radius of the level shelf, as a fraction of the footprint radius. 0
   * DISABLES the terrace.
   *
   * WHY THE COMPOSITION NEEDED A NEW TERM AT ALL. Every archetype feature is a
   * monotone radial falloff merged with `smoothMax`, so the field can only ADD
   * land and every primitive is flat only exactly at its own summit. There was
   * no way to say "this ground is level at +5 m". Measured across the whole
   * shipped world, the largest contiguous patch above 1.5 m with a gradient
   * under 6° was 222 m² at a 4.6 m inscribed radius — against a 35 m ship,
   * nowhere a hut could stand level.
   *
   * TWO OTHER OPERATORS WERE TRIED AND MEASURED FIRST, because both look
   * right and someone will propose them again:
   *  - THERMAL EROSION (a talus slope limiter over the grid). Rejected ON THE
   *    RESULT, not on cost: at talus 15° × 60 iterations the median slope does
   *    fall to 20.6°, but sub-6° ground stays at 3.7% and the largest patch
   *    stays at 134 m², and the radial profile comes out 16-18° at EVERY band.
   *    Erosion's fixed point IS a cone at the talus angle — it erases the
   *    silhouette variety §V43 exists for and produces no flat ground.
   *  - A `min`/CLAMP STAGE after the union. Makes a mesa of the whole island,
   *    and the detail noise still eats the table it creates.
   */
  terraceRadius: number;
  /** metres (as a fraction of footprint radius) the terrace fades out over */
  terraceFeather: number;
  /** elevation (m) the shelf levels off at — must be ≥ 3 × terraceToe */
  terraceHeight: number;
  /**
   * Residual slope inside the shelf (0 = dead flat, 1 = no terrace). This is
   * a slope COMPRESSION, not a clamp — exactly `beachApron`'s operator, keyed
   * on POSITION instead of on |h| — so the shelf blends into the surrounding
   * land across the feather with no step to hide, by construction rather than
   * by tuning. A clamp would leave a lip wherever the land was already above
   * the target.
   */
  terraceCompress: number;
  /**
   * Height (m) below which the terrace is inert. THIS IS THE SAFETY GATE, and
   * it is the dual of the one `lagoonBasin` carries.
   *
   * The basin lerps toward a NEGATIVE target and guarantees it can never
   * create dry land. The terrace lerps toward a POSITIVE one, so left ungated
   * it can lift shallow water into land and move the shoreline — measured, it
   * added 4,000 m² of land doing exactly that. The weight is therefore ramped
   * from 0 at `terraceToe` to 1 at `2 × terraceToe`, so the operator is
   * IDENTITY at and below the waterline and the shoreline cannot move.
   *
   * It also keeps the remap monotone in h, which is what actually rules out
   * new waterline crossings — see the derivation in heightmap.terrace, and
   * note it is why `terraceHeight` has a floor against this value.
   */
  terraceToe: number;

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
  /**
   * Deepest a rock standing OFF the shore may seat below still water, as a
   * fraction of its own half-height. The seabed keeps falling away past the
   * shoreline, so without this floor a mass placed out in the shallows is
   * seated on -12 m and vanishes; the references stand them proud.
   */
  rockSeaSeat: number;
  /** per-variant xz stretch (±fraction) — loaves and whale-backs, not spheres */
  rockStretch: number;
  /** z/x footprint ratio drawn per instance */
  rockAspectMin: number;
  rockAspectMax: number;
  /** max instance tilt off vertical (rad) — bedding planes are not level */
  rockTiltMax: number;
  /** seeded half-space cuts per variant: the broad granite fracture faces */
  rockFacetCount: number;
  /** nearest a cut may pass to the centre (fraction of radius) */
  rockFacetDepth: number;
  /** how softly a cut rolls off — 0 would put a crease back in the shading */
  rockFacetSoftness: number;
  /** height (fraction of radius) below which the base flattens for bedding */
  rockBedLevel: number;
  /** 0 = no bedding flat, 1 = the base is a plane at -rockBedLevel */
  rockBedFlatten: number;
  /**
   * Fraction of boulders that clump onto the rocky flanks (`cliffGroupAngles`)
   * instead of scattering on a uniform bearing.
   *
   * A uniform bearing is a Poisson process, and Poisson on a ring is exactly
   * what "evenly spread" looks like — the same measurement that sent the palms
   * into groves. Boulders are the DEBRIS of the masses they came off, so they
   * belong in fields at the foot of the headlands with clean beach between.
   * The remainder stay loose so the beaches are not perfectly swept either.
   */
  rockClumpFraction: number;
  /** angular half-spread (rad) of one boulder field around its flank */
  rockClumpSpread: number;

  // -- cliff masses (the island's silhouette, §V43) ---------------------------
  /**
   * Big granite masses, at `radius`; scaled linearly with footprint like
   * `palmCount`. They share the boulders' instanced batches, so raising this
   * costs instances and triangles but NOT draw calls.
   */
  cliffCount: number;
  /** rocky flanks the masses cluster onto — see cliffGroupAngles */
  cliffGroups: number;
  /** angular half-spread (rad) of one flank */
  cliffGroupSpread: number;
  cliffMinScale: number;
  cliffMaxScale: number;
  cliffSquashMin: number;
  cliffSquashMax: number;
  /** radial band as a fraction of the local shore radius (>1 = out to sea) */
  cliffRadialInner: number;
  cliffRadialOuter: number;
  /** how deep a cliff mass sinks, fraction of its half-height */
  cliffEmbed: number;

  // -- structures: jetties, piers, huts (src/island/structures.ts) ----------
  /**
   * Stretches of shore the built stuff clusters on. Built things CLUSTER — the
   * references put every jetty and every hut on one or two bays and leave the
   * rest of the island empty — so this is the same device as `palmGroveCount`
   * and `cliffGroups`, on its own decorrelated stream.
   */
  structureSettlements: number;
  /** arc half-width (m) of one settlement along the shore */
  structureSettlementSpread: number;
  /** upper bound on jetties per settlement (1..this, drawn per settlement) */
  structureJettiesPerSettlement: number;
  /**
   * A jetty shorter than this is not worth building, so the bearing is skipped.
   * Jetty LENGTH itself is NOT a tunable range — it is read off the seabed (see
   * structures.planJetty): a jetty runs out until it reaches `structureBerthDepth`
   * of water. The user's note on the references was "naturally different
   * lengths", and a uniform random length is precisely not that.
   */
  structureJettyMinLength: number;
  /** hard stop on the walk seaward (m) */
  structureJettyMaxLength: number;
  structureJettyWidth: number;
  /** clear water (m) between two jetty decks at the shore */
  structureJettyGap: number;
  /** deck top above still water (m) — a deck is level, so this is one number */
  structureDeckHeight: number;
  /** spacing (m) of the pile bays, and the deck's structural module */
  structureBayLength: number;
  /** how far inland of the waterline the deck starts; the ramp bridges the rest */
  structureRootInset: number;
  /** max terrain gradient at the root — a jetty needs a beach, not a cliff */
  structureShoreSlopeLimit: number;
  /** water depth (m) the jetty is trying to reach; it stops on arrival */
  structureBerthDepth: number;
  /**
   * Per-jetty variation (±fraction) on that target depth. THIS IS WHERE THE
   * LENGTH SPREAD COMES FROM — see structures.planJetty. At 0 a settlement's
   * jetties measured 16.8, 16.8 and 16.8 m, because a 34 m arc of shore has
   * one profile; each jetty now reaches for the water its own boat needs.
   */
  structureBerthDepthVar: number;
  /** past this depth (m) a pile no longer reaches bottom — the walk gives up */
  structureMaxPileDepth: number;
  /** longest pile that can be driven (m) — floors the foot off the bathymetry */
  structureMaxPileLength: number;
  structurePileEmbed: number;
  structurePileRadius: number;
  /** lateral offset (m) of a pile top — a driven pile is never plumb */
  structurePileLean: number;
  /** chance a pile stands proud of the deck as a bollard (ref-island-147/149) */
  structureBollardChance: number;
  structureBollardRise: number;
  structureStringerWidth: number;
  structureStringerDepth: number;
  structureBraceChance: number;
  structureBraceSize: number;
  /** deck board width / gap / thickness (m) — REAL boards, not shader seams */
  structurePlankWidth: number;
  structurePlankGap: number;
  structurePlankThickness: number;
  /** per-board cant (rad), roll (rad) and lift (m) — hand-laid, not milled */
  structurePlankCant: number;
  structurePlankRoll: number;
  structurePlankLift: number;
  structurePlankOverhang: number;
  /** chance a decayed jetty is missing a board, at the seaward end */
  structureMissingPlank: number;
  /** chance a jetty is a wreck rather than sound */
  structureDecayChance: number;
  /** run (m) of the loose boards ramping from the deck onto the sand */
  structureRampRun: number;
  structureRailChance: number;
  structureRailHeight: number;
  structureRailSize: number;
  /** huts at `radius`, scaled with footprint like palmCount and cliffCount */
  structureHutCount: number;
  structureHutSize: number;
  structureHutWallHeight: number;
  structureHutRoofRise: number;
  /** how far inland of the shoreline a dry-land hut sits (m) */
  structureHutSetback: number;
  structureHutMinHeight: number;
  structureHutSlopeLimit: number;
  /** how high a dry-land hut may be lifted on stumps (m) */
  structureHutStilt: number;
  /** how much wider huts spread than the jetties of the same settlement */
  structureHutFlare: number;
  structurePostRadius: number;
  /** fraction of huts standing in the shallows on stilts (ref-island-150) */
  structureStiltFraction: number;
  /** chance a wall board is missing — a gap you can see daylight through */
  structureMissingBoard: number;
  structureEaveOverhang: number;

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
  /**
   * Concentric rings of terrain geometry drawn ACROSS that shelf (build time).
   *
   * The shelf used to be shaded but never drawn: the terrain mesh stopped on
   * the square footprint and the water went on reading shallow over nothing,
   * which is the hard border round every island. `buildIslandGeometry` now
   * continues the mesh out to `seabedShelfWidth` on this many rings, riding
   * `shelfRamp` so the drawn floor and this field are one surface.
   *
   * It is a tessellation number, not a look knob: the ramp is a smoothstep
   * over `seabedShelfWidth`, so the piecewise-linear error falls as 1/rings².
   * 8 rings over the shipped 260 m shelf keeps that under ~0.3 m — well inside
   * what 10 m of water hides — for 508 vertices a ring and no extra draw call.
   */
  seabedApronRings: number;
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

  // ── T112g LOD ────────────────────────────────────────────────────────────
  /**
   * Metres of approach over which the near terrain morphs onto the far
   * terrain's surface, ending exactly at `lodTerrainDistance` (CDLOD, see
   * islandMesh.ts). The delta a vertex has to travel is fixed by the two
   * tessellations; this decides how many frames it is spread over.
   *
   * 300 m at a 900 m swap means the morph runs 600 → 900 m. At a walking pace
   * of ~4 m/s that is 75 s of travel for a motion whose whole amplitude is the
   * `morphHeightDelta` the handle reports (single metres on the shipped
   * islands), i.e. millimetres per frame — under the threshold at which a
   * surface reads as moving at all, which is the property that matters. Set to
   * 0 for a hard swap; the pop comes back.
   */
  lodTerrainMorphBand: number;
  /** CDLOD morph on/off — an A/B switch for the pop, not a look tunable */
  lodTerrainMorph: boolean;

  /** palm instance count ramps from full to zero between these distances (m) */
  lodPalmFull: number;
  lodPalmCull: number;
  /** rocks hidden beyond this camera distance (m) */
  lodRockCull: number;
  /**
   * Structures hidden beyond this camera distance (m). Tighter than the rocks:
   * a jetty is a 2 m wide ribbon of 0.28 m boards, so it is under a pixel long
   * before a 20 m granite mass is, and hiding it is zero draws in the main pass
   * AND the shadow pass.
   *
   * MEASURED, on a CPU-bound frame where draw calls are the whole budget: at
   * the lagoon anchorage 2200 m put THREE islands' settlements in the frame for
   * 3 draws, of which two were islands 1.1-2.2 km away whose jetties are a few
   * pixels of grey. 1400 m keeps the one you are anchored at and drops the
   * rest, for 1 draw. Deliberately tighter than `lodRockCull` (4000) because a
   * 20 m granite mass is still a silhouette at 4 km and a plank is not.
   */
  lodStructureCull: number;
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
    peakHeight: 15,
    minPeakHeight: 9,
    peakHeightGrowth: 0.4,
    noiseScale: 0.035,
    noiseSlope: 0.25,
    noiseOctaves: 4,
    featureExtent: 0.62,
    featureBlend: 14,
    coastNoiseScale: 0.012,
    coastNoiseSlope: 0.2,
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
    beachBandWidth: 10.0,
    beachFlatness: 0.15,
    beachLandGuard: 5,
    terraceRadius: 0.3,
    terraceFeather: 0.16,
    terraceHeight: 3.5,
    terraceCompress: 0.1,
    terraceToe: 1.0,
    lagoonDepth: 0,
    lagoonRadius: 0.3,
    lagoonFeather: 0.24,
    lagoonLandGuard: 6,
    lagoonFloorRelief: 0.05,
    lagoonOffset: 0.6,
    rimDepth: 4,
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
    rockCount: 22,
    rockSpread: 16,
    // wide range on purpose: with the cubed draw in generateRockPlacements
    // most boulders land near the bottom of it and a few reach the top, which
    // is what a real scatter looks like. A narrow range is what made every
    // rock the same size.
    rockMinScale: 2.1,
    rockMaxScale: 9.0,
    rockSquashMin: 0.5,
    rockSquashMax: 0.95,
    rockNoiseAmp: 0.22,
    rockNoiseFreq: 1.7,
    rockNoiseOctaves: 3,
    // 3, not 2: the welded normals are smooth now, so subdivision buys a
    // rounder SILHOUETTE (it always did — it was the flat shading, not the
    // triangle count, that read as facets). 720 tris on a mass that can be
    // 35 m across, in a frame where draw calls are the scarce resource and
    // triangles are not.
    rockDetail: 3,
    rockGeoVariants: 4,
    rockEmbed: 0.42,
    rockSeaSeat: 0.55,
    rockStretch: 0.3,
    rockAspectMin: 0.68,
    rockAspectMax: 1.45,
    rockTiltMax: 0.2,
    rockFacetCount: 4,
    rockFacetDepth: 0.62,
    rockFacetSoftness: 0.22,
    rockBedLevel: 0.45,
    rockBedFlatten: 0.55,
    rockClumpFraction: 0.72,
    rockClumpSpread: 0.55,
    cliffCount: 4,
    cliffGroups: 3,
    cliffGroupSpread: 0.42,
    cliffMinScale: 7,
    cliffMaxScale: 17,
    cliffSquashMin: 0.6,
    cliffSquashMax: 1.0,
    cliffRadialInner: 0.44,
    cliffRadialOuter: 1.14,
    cliffEmbed: 0.6,
    structureSettlements: 2,
    structureSettlementSpread: 60,
    structureJettiesPerSettlement: 3,
    structureJettyMinLength: 7,
    structureJettyMaxLength: 34,
    structureJettyWidth: 2.4,
    structureJettyGap: 7,
    structureDeckHeight: 1.7,
    structureBayLength: 2.8,
    structureRootInset: 3,
    structureShoreSlopeLimit: 0.45,
    structureBerthDepth: 2.2,
    structureBerthDepthVar: 0.45,
    structureMaxPileDepth: 4.5,
    structureMaxPileLength: 9,
    structurePileEmbed: 0.7,
    structurePileRadius: 0.16,
    structurePileLean: 0.22,
    structureBollardChance: 0.3,
    structureBollardRise: 0.9,
    structureStringerWidth: 0.16,
    structureStringerDepth: 0.24,
    structureBraceChance: 0.35,
    structureBraceSize: 0.12,
    structurePlankWidth: 0.28,
    structurePlankGap: 0.035,
    structurePlankThickness: 0.07,
    structurePlankCant: 0.05,
    structurePlankRoll: 0.05,
    structurePlankLift: 0.012,
    structurePlankOverhang: 0.16,
    structureMissingPlank: 0.35,
    structureDecayChance: 0.4,
    structureRampRun: 3.2,
    structureRailChance: 0.5,
    structureRailHeight: 0.95,
    structureRailSize: 0.09,
    structureHutCount: 3,
    structureHutSize: 4.2,
    structureHutWallHeight: 2.3,
    structureHutRoofRise: 1.3,
    structureHutSetback: 9,
    structureHutMinHeight: 0.5,
    structureHutSlopeLimit: 0.3,
    structureHutStilt: 0.7,
    structureHutFlare: 1.6,
    structurePostRadius: 0.13,
    structureStiltFraction: 0.3,
    structureMissingBoard: 0.1,
    structureEaveOverhang: 0.45,
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
    seabedApronRings: 8,
    seabedTextureSize: 1024,
    seabedTextureMargin: 400,
    lodTerrainDistance: 900,
    lodTerrainStride: 2,
    // ── T112g LOD ──
    lodTerrainMorphBand: 300,
    lodTerrainMorph: true,
    lodPalmFull: 500,
    lodPalmCull: 1400,
    lodRockCull: 4000,
    lodStructureCull: 1400,
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
    peakHeightGrowth: { min: 0, max: 1.2, step: 0.05 },
    noiseScale: { min: 0.005, max: 0.2, step: 0.005 },
    noiseSlope: { min: 0, max: 1.2, step: 0.01 },
    noiseOctaves: { min: 1, max: 6, step: 1 },
    featureExtent: { min: 0.2, max: 0.95, step: 0.01 },
    featureBlend: { min: 1, max: 60, step: 1 },
    coastNoiseScale: { min: 0.002, max: 0.08, step: 0.001 },
    coastNoiseSlope: { min: 0, max: 1, step: 0.01 },
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
    beachBandWidth: { min: 0.2, max: 30, step: 0.5 },
    beachFlatness: { min: 0.05, max: 1, step: 0.05 },
    beachLandGuard: { min: 0.5, max: 30, step: 0.5 },
    terraceRadius: { min: 0, max: 0.6, step: 0.01 },
    terraceFeather: { min: 0.02, max: 0.5, step: 0.01 },
    terraceHeight: { min: 1, max: 40, step: 0.5 },
    terraceCompress: { min: 0, max: 1, step: 0.05 },
    terraceToe: { min: 0.2, max: 6, step: 0.1 },
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
    rockSeaSeat: { min: 0, max: 1, step: 0.05 },
    rockStretch: { min: 0, max: 0.7, step: 0.02 },
    rockAspectMin: { min: 0.3, max: 1.5, step: 0.02 },
    rockAspectMax: { min: 0.3, max: 2.5, step: 0.02 },
    rockTiltMax: { min: 0, max: 0.6, step: 0.02 },
    rockFacetCount: { min: 0, max: 10, step: 1 },
    rockFacetDepth: { min: 0.3, max: 0.95, step: 0.01 },
    rockFacetSoftness: { min: 0.02, max: 1, step: 0.02 },
    rockBedLevel: { min: 0.1, max: 1, step: 0.05 },
    rockBedFlatten: { min: 0, max: 1, step: 0.05 },
    rockClumpFraction: { min: 0, max: 1, step: 0.02 },
    rockClumpSpread: { min: 0.05, max: 2, step: 0.02 },
    cliffCount: { min: 0, max: 24, step: 1 },
    cliffGroups: { min: 1, max: 8, step: 1 },
    cliffGroupSpread: { min: 0.05, max: 1.5, step: 0.02 },
    cliffMinScale: { min: 2, max: 30, step: 0.5 },
    cliffMaxScale: { min: 2, max: 45, step: 0.5 },
    cliffSquashMin: { min: 0.2, max: 1.6, step: 0.05 },
    cliffSquashMax: { min: 0.2, max: 1.6, step: 0.05 },
    cliffRadialInner: { min: 0, max: 1.4, step: 0.02 },
    cliffRadialOuter: { min: 0, max: 1.6, step: 0.02 },
    cliffEmbed: { min: 0, max: 1, step: 0.05 },
    structureSettlements: { min: 0, max: 6, step: 1 },
    structureSettlementSpread: { min: 2, max: 200, step: 1 },
    structureJettiesPerSettlement: { min: 1, max: 8, step: 1 },
    structureJettyMinLength: { min: 2, max: 40, step: 0.5 },
    structureJettyMaxLength: { min: 4, max: 90, step: 1 },
    structureJettyWidth: { min: 1, max: 6, step: 0.1 },
    structureJettyGap: { min: 0, max: 40, step: 0.5 },
    structureDeckHeight: { min: 0.4, max: 5, step: 0.05 },
    structureBayLength: { min: 1, max: 8, step: 0.1 },
    structureRootInset: { min: 0, max: 20, step: 0.5 },
    structureShoreSlopeLimit: { min: 0.05, max: 1.5, step: 0.05 },
    structureBerthDepth: { min: 0.5, max: 8, step: 0.1 },
    structureBerthDepthVar: { min: 0, max: 0.8, step: 0.05 },
    structureMaxPileDepth: { min: 1, max: 14, step: 0.5 },
    structureMaxPileLength: { min: 2, max: 20, step: 0.5 },
    structurePileEmbed: { min: 0, max: 3, step: 0.05 },
    structurePileRadius: { min: 0.04, max: 0.6, step: 0.01 },
    structurePileLean: { min: 0, max: 1, step: 0.02 },
    structureBollardChance: { min: 0, max: 1, step: 0.05 },
    structureBollardRise: { min: 0, max: 2.5, step: 0.05 },
    structureStringerWidth: { min: 0.04, max: 0.6, step: 0.01 },
    structureStringerDepth: { min: 0.04, max: 0.8, step: 0.01 },
    structureBraceChance: { min: 0, max: 1, step: 0.05 },
    structureBraceSize: { min: 0.03, max: 0.4, step: 0.01 },
    structurePlankWidth: { min: 0.08, max: 0.8, step: 0.01 },
    structurePlankGap: { min: 0, max: 0.2, step: 0.005 },
    structurePlankThickness: { min: 0.02, max: 0.25, step: 0.005 },
    structurePlankCant: { min: 0, max: 0.3, step: 0.005 },
    structurePlankRoll: { min: 0, max: 0.3, step: 0.005 },
    structurePlankLift: { min: 0, max: 0.1, step: 0.002 },
    structurePlankOverhang: { min: 0, max: 0.8, step: 0.01 },
    structureMissingPlank: { min: 0, max: 1, step: 0.05 },
    structureDecayChance: { min: 0, max: 1, step: 0.05 },
    structureRampRun: { min: 0.5, max: 12, step: 0.1 },
    structureRailChance: { min: 0, max: 1, step: 0.05 },
    structureRailHeight: { min: 0.3, max: 1.6, step: 0.05 },
    structureRailSize: { min: 0.03, max: 0.3, step: 0.01 },
    structureHutCount: { min: 0, max: 20, step: 1 },
    structureHutSize: { min: 1.5, max: 12, step: 0.1 },
    structureHutWallHeight: { min: 1, max: 5, step: 0.1 },
    structureHutRoofRise: { min: 0, max: 4, step: 0.05 },
    structureHutSetback: { min: 0, max: 60, step: 0.5 },
    structureHutMinHeight: { min: 0, max: 6, step: 0.1 },
    structureHutSlopeLimit: { min: 0.05, max: 1.2, step: 0.05 },
    structureHutStilt: { min: 0, max: 3, step: 0.05 },
    structureHutFlare: { min: 1, max: 5, step: 0.1 },
    structurePostRadius: { min: 0.04, max: 0.5, step: 0.01 },
    structureStiltFraction: { min: 0, max: 1, step: 0.05 },
    structureMissingBoard: { min: 0, max: 0.6, step: 0.02 },
    structureEaveOverhang: { min: 0, max: 1.5, step: 0.05 },
    islandCount: { min: 0, max: 12, step: 1 },
    scatterMinDistance: { min: 200, max: 4000, step: 50 },
    scatterMaxDistance: { min: 400, max: 4500, step: 50 },
    spawnClearance: { min: 100, max: 2000, step: 25 },
    islandGap: { min: 50, max: 1500, step: 25 },
    scatterRadiusMin: { min: 40, max: 400, step: 10 },
    scatterRadiusMax: { min: 40, max: 600, step: 10 },
    seabedOpenDepth: { min: 10, max: 200, step: 1 },
    seabedShelfWidth: { min: 20, max: 800, step: 10 },
    seabedApronRings: { min: 1, max: 32, step: 1 },
    seabedTextureSize: { min: 128, max: 2048, step: 128 },
    seabedTextureMargin: { min: 0, max: 2000, step: 50 },
    lodTerrainDistance: { min: 100, max: 4000, step: 50 },
    lodTerrainStride: { min: 1, max: 8, step: 1 },
    // ── T112g LOD ──
    lodTerrainMorphBand: { min: 0, max: 2000, step: 25 },
    lodPalmFull: { min: 50, max: 3000, step: 25 },
    lodPalmCull: { min: 50, max: 4000, step: 25 },
    lodRockCull: { min: 50, max: 4600, step: 25 },
    lodStructureCull: { min: 50, max: 4600, step: 25 },
    foamTargetMargin: { min: 20, max: 1000, step: 10 },
  };
}
