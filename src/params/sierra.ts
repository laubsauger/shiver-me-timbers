/**
 * Sierra archetype tunables (§T.99, §V90, §V16) — the flooded-Sierra world:
 * glacial-polished granite domes with exfoliation terraces, drowned ridges
 * with a line of dead-pine treetops to leeward, cirque bowls holding a still
 * lagoon, decomposed-granite (DG) sand beaches, Jeffrey pine / juniper on the
 * benches. Everything here is a knob the panel can drag; the heightfield,
 * site layout, granite material and pine scatter all read from this object.
 *
 * Slice = 3 islands 500–700 m apart + a start anchorage + ONE Half-Dome
 * silhouette on the far horizon flagged unreachable (≥ 1.5× the furthest
 * slice island, §V90).
 */
import { registerParams } from './registry';

export interface SierraParams {
  // ── site layout (generateSierraSites) ──────────────────────────────────
  /** slice islands — one per walkable archetype */
  sliceCount: number;
  /** centre-to-centre spacing band between slice islands (m) */
  sliceMinSpacing: number;
  sliceMaxSpacing: number;
  /** open water kept between any two footprints (m) */
  sliceGap: number;
  /** footprint radius range of the slice islands (m) */
  sliceRadiusMin: number;
  sliceRadiusMax: number;
  /** the start anchorage sits at the origin; nothing within this (m) */
  startClearance: number;
  /** heightmap resolution per slice island (§V90: 256²) */
  sliceGridSize: number;
  /** resolution for fillers and the silhouette island */
  fillerGridSize: number;
  /** minor islets sprinkled around the slice (0 disables) */
  fillerCount: number;
  fillerRadiusMin: number;
  fillerRadiusMax: number;
  /** Half-Dome distance as a multiple of the furthest slice island (≥ 1.5) */
  halfDomeDistanceFactor: number;
  /** Half-Dome footprint radius (m) — silhouette only, never visited */
  halfDomeRadius: number;
  /** Half-Dome summit height (m) — a silhouette needs to be tall */
  halfDomePeak: number;

  // ── heightfield (sierraArchetypes) ─────────────────────────────────────
  /** family relief as a multiple of the island's radius-derived peakHeight */
  domeRelief: number;
  ridgeRelief: number;
  cirqueRelief: number;
  /** crown profile exponent k in (1 − u²)^k — higher = steeper shoulder, flatter top */
  domeCrownPower: number;
  /** exfoliation terraces on the terraced flank */
  domeTerraceMin: number;
  domeTerraceMax: number;
  /** height of one terrace step (m) */
  domeTerraceRise: number;
  /** fraction of each step that is riser (the rest is polished tread) */
  domeTerraceRiser: number;
  /** half-width of the terraced sector (rad) */
  domeTerraceSector: number;
  /** drowned ridge: length as a multiple of featureExtent, crest half-width */
  ridgeLength: number;
  ridgeWidth: number;
  /** crest undulation amplitude (fraction of peak) */
  ridgeUndulation: number;
  /** where along the ridge (0..1) the crest starts going under */
  ridgeDrownStart: number;
  /** crest depth in the drowned section (m below the waterline) */
  ridgeLeeDepth: number;
  /** treeline markers: spacing along the drowned crest (m), depth band (m) */
  treelineSpacing: number;
  treelineDepthMin: number;
  treelineDepthMax: number;
  /** cirque: arc of the cliff ring (rad), ring radius (× extent) */
  cirqueArc: number;
  cirqueRing: number;
  /** cirque interior lagoon floor (m) and disc radius (× R) */
  cirqueLagoonDepth: number;
  cirqueLagoonRadius: number;
  /** half dome: where the sheared face cuts (× extent) and its width (× extent) */
  halfDomeFaceOffset: number;
  halfDomeFaceWidth: number;
  /** DG sand band: the beach apron width on sierra islands (m) */
  dgSandBand: number;
  /** surface detail slope budget — granite is smoother than the pirate noise */
  graniteNoiseSlope: number;
  /** coastline noise slope budget for sierra islands */
  sierraCoastSlope: number;

  // ── granite material ───────────────────────────────────────────────────
  graniteBaseColor: number;
  graniteTopColor: number;
  graniteJointColor: number;
  lichenColor: number;
  /** joint set spacing (m) and width (m) */
  jointSpacing: number;
  jointWidth: number;
  /** 0..1 darkening at a joint */
  jointStrength: number;
  /** lichen patch field: world frequency (1/m), coverage 0..1, strength 0..1 */
  lichenScale: number;
  lichenCoverage: number;
  lichenStrength: number;
  /** roughness reduction on polished flats (0 = matte, 1 = glass) */
  polishGloss: number;
  /** DG sand tones — warmer than the coral sand */
  dgSandColor: number;
  dgSandShadeColor: number;

  // ── cover retint (§T.112a: the 18 m tropical green never reached sierra) ──
  /** grus (decomposed-granite gravel) on the flats, pine litter under the macro noise */
  grusColor: number;
  litterColor: number;
  /** slope (°) below which the ground is grus, above which it is bare granite */
  coverGrusSlope: number;
  coverBareSlope: number;
  /** 60 m macro field: world frequency (1/m) and tone variation 0..1 */
  coverMacroScale: number;
  coverMacroVariation: number;
  /** litter coverage of the macro field 0..1 and blend strength 0..1 */
  litterCoverage: number;
  litterStrength: number;
  /** grus grain: world frequency (1/m) and contrast 0..1 */
  coverGrainScale: number;
  coverGrainStrength: number;

  // ── horizon map (§T.112a: sun self-shadow + sky AO) ────────────────────
  /** shadow terminator half-width (rad) on the sun-elevation vs horizon compare */
  horizonShadowSoftness: number;
  /** 0..1 how much of the direct sun the horizon removes (1 = full shadow) */
  horizonShadowStrength: number;
  /** 0..1 how much of the sky AO reaches the ambient term */
  horizonSkyAoStrength: number;

  // ── inland boulders (§T.112a) ────────────────────────────────────────────
  /** boulders on convex + steep cells per metre of footprint radius */
  inlandBouldersPerRadius: number;
  /** glacial erratics on the flat treads (per island) */
  erraticCount: number;
  /** convexity gate: −Laplacian of h (1/m) a cell must exceed */
  boulderConvexity: number;
  /** slope (rise/run) a convex cell must exceed to shed a boulder */
  boulderSlopeMin: number;
  /** erratics sit on ground flatter than this (rise/run) */
  erraticSlopeMax: number;
  /** inland band: metres above the waterline the beach apron must be cleared by */
  boulderMinHeight: number;
  /** size range (m) of the inland scatter; erratics use the top of it */
  boulderMinScale: number;
  boulderMaxScale: number;

  // ── pines / junipers / dead pines ──────────────────────────────────────
  /** live trees per metre of footprint radius */
  pinesPerRadius: number;
  /** fraction of the live stand that is juniper (squat, wide) */
  juniperFraction: number;
  pineHeightMin: number;
  pineHeightMax: number;
  pineTiersMin: number;
  pineTiersMax: number;
  /** widest tier radius as a fraction of height */
  pineTierSpread: number;
  pineTrunkRadius: number;
  /** benches: max slope (rise/run) and min height above the waterline (m) */
  pineSlopeLimit: number;
  pineMinHeight: number;
  /** bench fraction of the footprint that carries the full nominal stand */
  pineBenchReference: number;
  /** stand clustering: number of seeded stands, spread (m) */
  pineStandCount: number;
  pineStandSpread: number;
  /** footprint competition: crown radius (m) at scale 1, growth per round, rounds */
  pineFootprint: number;
  pineFootprintGrowth: number;
  pineCompetitionRounds: number;
  /** acceptance on a south-facing (sun-baked) slope relative to north-facing, 0..1 */
  pineSouthAspectFactor: number;
  /** dead pines at the treeline: trunk height (m), branch count */
  deadPineHeight: number;
  deadBranchCount: number;
  /** wind */
  pineSwayAmplitude: number;
  pineFlutterAmplitude: number;
  /** colours */
  pineBarkColor: number;
  needleDarkColor: number;
  needleLightColor: number;
  juniperNeedleColor: number;
  deadWoodColor: number;

  // ── T112c erosion (island/erosion*.ts) ──────────────────────────────────
  /** 0 = analytic archetype only (A/B), 1 = run the erosion pass stage */
  erosionEnabled: number;
  /** crest displacement along the ice vector at peak height (m) — the roche moutonnée shear */
  iceShear: number;
  /** sheet thickness measured along the normal (m), riser fraction of a sheet */
  sheetThickness: number;
  sheetRiser: number;
  /** convex curvature (1/m) at which the sheeting mask is full */
  sheetCurvature: number;
  /** sheeting strength on the stoss (polished) flank relative to the lee (plucked) */
  sheetStossFactor: number;
  /** plate-offset noise wavelength (m): sheets break into plates this size */
  sheetPlateSize: number;
  /** joint-density noise frequency (1/m) */
  jointScale: number;
  /** beach guard: erosion fades in from this height (m) over this width (m) */
  erodeBandStart: number;
  erodeBandWidth: number;
  /** stream power K·dt (per iteration), uplift per iteration at mask 1 (m), area exponent m */
  streamRate: number;
  streamUplift: number;
  streamAreaExp: number;
  /** stream-power iterations per family (0 = off; the dome keeps its crown) */
  streamItersDome: number;
  streamItersRidge: number;
  streamItersCirque: number;
  /** rockfall: bedrock slope (tan) above which it sheds, rate (m per unit excess), source steps */
  rockfallSlope: number;
  rockfallRate: number;
  rockfallSteps: number;
  /** talus repose (tan 35° = 0.70) and thermal iterations */
  talusRepose: number;
  thermalIters: number;
  /** final bedrock smoothing: repose (tan) and iterations */
  smoothRepose: number;
  smoothIters: number;
  /** land that erosion pushed under is held at this height above the sea (m) */
  floodFloor: number;

  // ── T112b paths (island/pathGraph.ts, pathCarve.ts) ─────────────────────
  /** 0 = no path graph / carve (A/B), 1 = author the route */
  pathEnabled: number;
  /** islands with a footprint radius under this get no route (fillers) */
  pathMinRadius: number;
  /** corridor tread width (m) and the bench falloff beyond it (m) */
  pathCorridorWidth: number;
  pathCorridorFalloff: number;
  /** slope caps (°): main route, fork, the one scramble segment, and its length (m) */
  pathMainSlope: number;
  pathForkSlope: number;
  pathScrambleSlope: number;
  pathScrambleLength: number;
  /** A* cost: slope penalty gain, turn penalty gain, beach-band cost factor */
  pathSlopeCost: number;
  pathTurnCost: number;
  pathBeachCost: number;
  /** fork: junction / return positions along the main route (0..1), POI offset from the route (m) */
  pathForkAt: number;
  pathForkReturnAt: number;
  pathForkOffset: number;
  /** exit beach is kept at least this far (rad) around the coast from the landing */
  pathExitSeparation: number;
  /** soft gate around the station: ring radius (m), cut height (m), riser width (m), feather off the route (m) */
  pathGateRadius: number;
  pathGateStep: number;
  pathGateWidth: number;
  pathGateFeather: number;
  /** occluder ridge before the station: route distance (m) of the LOS test, crest height (m), half-width along the route (m), span across it (m) */
  pathOccluderDistance: number;
  pathOccluderHeight: number;
  pathOccluderSigma: number;
  pathOccluderSpan: number;
  /** Journey tilt: total drop across the island toward the next slice island (m) */
  pathTilt: number;
  /** the corridor's own beach guard: the blend fades in from this height (m) over this width (m) */
  pathGuardStart: number;
  pathGuardWidth: number;
  // ── T112d shading (island/terrainInfo.ts + sierraMaterial.ts) ──────────
  /** polished granite: convex curvature (1/m) and slope (°) ceiling, debris (m) ceiling */
  polishCurvature: number;
  polishSlope: number;
  polishDebrisMax: number;
  polishedColor: number;
  /** fractured granite: joint-density threshold 0..1 and slope (°) floor */
  fracturedJoint: number;
  fracturedSlope: number;
  fracturedColor: number;
  fracturedRoughness: number;
  /** grus: debris thickness (m) at which the tread is fully gravel */
  grusDebrisMin: number;
  /** litter: moisture proxy threshold 0..1 (under-canopy proxy until T112e pine density) */
  litterMoisture: number;
  /** lichen on shaded faces: the shaded azimuth (rad, atan(z, x)), aspect weight 0..1, sky-AO weight 0..1 */
  lichenAspectAzimuth: number;
  lichenAspectStrength: number;
  lichenShadeStrength: number;
  /** implied trail: wear half-width (m) around the route centreline, strength 0..1, worn colour */
  pathWearWidth: number;
  pathWearStrength: number;
  pathWornColor: number;
  /** sheeting bands: spacing (m) along the curvature axis, riser fraction, darkening 0..1, convexity (1/m) at full, relief (m) */
  sheetBandSpacing: number;
  sheetBandRiser: number;
  sheetBandStrength: number;
  sheetBandConvexity: number;
  sheetBandRelief: number;
  /** height blend: crossfade width in score units, per-layer height amplitude */
  layerBlendWidth: number;
  layerHeightAmp: number;
  /** elevation bands (Firewatch value grouping): band tops (m), crossfade (m), tints, strength 0..1 */
  bandLowHeight: number;
  bandMidHeight: number;
  bandHighHeight: number;
  bandWidth: number;
  bandLowTint: number;
  bandMidTint: number;
  bandHighTint: number;
  bandCrownTint: number;
  bandStrength: number;

  // ── T122 layer separation, sheeting contours, fresh rock ────────────────
  /**
   * Metres of ELEVATION a sheet trace bows by where the curvature reaches
   * `sheetBandConvexity` — the term that makes the bands hug a convex nose
   * instead of lying as exact level sets of height (§T.122, sierraMaterial's
   * header). 0 = horizontal contours.
   */
  sheetBandWarp: number;
  /**
   * Joint-density (0..1) at which the two sets are fully drawn; they fade out
   * 0.15 either side. Below this the rock is not jointed and the sets must not
   * appear, or the lattice covers the whole island (R3-14's graph paper).
   */
  jointCoverage: number;
  /** share of the joint bite that lands on un-fractured bedrock (was a hard 0.5) */
  jointBaseBite: number;
  /**
   * A block that has fallen is not the slab it fell from: how much of the
   * ground's grus/litter/wear it sheds (0..1), how much of its lichen (0..1),
   * and how far it goes toward a fresh fracture face.
   */
  rockFreshCover: number;
  rockFreshLichen: number;
  rockFreshStrength: number;
  rockFreshTint: number;

  // ── T112e vegetation (vegetation/sierraScatter.ts, terrain/groundCoverMesh.ts) ──
  /** candidate grid spacing (m): one blue-noise cell = one chance per species */
  vegSampleSpacing: number;
  /** curvature (1/m) at which the concave/convex species preference saturates */
  vegCurvatureRef: number;
  /** ramp width of every moisture threshold, in 0..1 channel units */
  vegMoistureFeather: number;
  /** clump noise: fraction of the field that is bare ground between stands */
  vegClumpBare: number;
  /** the sun-facing downhill azimuth (rad, atan2(z, x)) both aspect rules read */
  vegSunAspect: number;
  /** pine: instances/m² at full suitability, and the moisture floor it needs */
  pineDensity: number;
  pineMoistureMin: number;
  /** juniper: instances/m² (scaled by juniperFraction), moisture ceiling, windward weight 0..1 */
  juniperDensity: number;
  juniperMoistureMax: number;
  juniperWindWeight: number;
  /** juniper crown radius (m) at scale 1 — the competition's currency */
  juniperFootprint: number;
  /** juniper geometry: height (m), crown spread + bole radius + lean (× height), limbs */
  juniperHeight: number;
  juniperSpread: number;
  juniperBoleRadius: number;
  juniperLean: number;
  juniperLimbs: number;
  /** juniper leaf cushions: radius (× spread) and vertical squash */
  juniperLobeRadius: number;
  juniperLobeSquash: number;
  /** manzanita: instances/m², moisture ceiling, sky-exposure exponent, aspect weight 0..1 */
  manzanitaDensity: number;
  manzanitaMoistureMax: number;
  manzanitaSkyExponent: number;
  manzanitaAspectWeight: number;
  /** a shrub holds steeper ground than a tree (rise/run) */
  manzanitaSlopeLimit: number;
  /** the fork corridor: half-width (m) of the thicket and the density it ADDS 0..1 */
  manzanitaForkRange: number;
  manzanitaForkBoost: number;
  manzanitaFootprint: number;
  /** manzanita geometry: height (m), spread + stem radius (× height), stems, lobes */
  manzanitaHeight: number;
  manzanitaSpread: number;
  manzanitaStems: number;
  manzanitaStemRadius: number;
  manzanitaLobeRadius: number;
  manzanitaLobeSquash: number;
  manzanitaLeafColor: number;
  manzanitaStemColor: number;
  /** foliage lighting: cluster-normal blend 0..1 (baked), wrap width + strength */
  foliageClusterBlend: number;
  foliageWrap: number;
  foliageWrapStrength: number;
  /** back transmission: strength, tightness of the view lobe, and the colour through a leaf */
  foliageTransmission: number;
  foliageTransmissionPower: number;
  foliageTransmissionColor: number;
  /** understory: sample spacing (m), slope ceiling (rise/run), densities (per m²) */
  understorySpacing: number;
  understorySlopeLimit: number;
  understoryGrassDensity: number;
  understoryDeadfallDensity: number;
  understoryConeDensity: number;
  /** understory geometry: bunchgrass height (m), fallen limb length + radius (m), cone height (m) */
  bunchgrassHeight: number;
  deadfallLength: number;
  deadfallRadius: number;
  coneHeight: number;
  // ── T112f rocks (island/rocks.ts) ────────────────────────────────────────
  /** talus: debris thickness (m) a cell must carry before it can shed a block */
  talusDebrisMin: number;
  /** talus: thickness (m) at which the apron is fully populated — density ∝ debris */
  talusDebrisFull: number;
  /** talus: minimum spacing between blocks (m) */
  talusSpacing: number;
  /**
   * Talus SORTING: block size (m) at the apron HEAD (the source cliff) and at
   * its FOOT. A talus cone sorts downslope — the fines stay under the cliff,
   * the big blocks bounce to the toe — so the size is a function of how far
   * BELOW the apron's own crest the block sits, not of the seed.
   */
  talusHeadScale: number;
  talusFootScale: number;
  /** talus: ± fraction of seeded size jitter on top of the sort */
  talusSizeJitter: number;
  /** talus: how deep a block beds into the apron (fraction of its half-height) */
  talusEmbed: number;
  /** talus: its own geometry pool — small blocks, many of them, so one detail level down */
  talusGeoVariants: number;
  /** outcrop slabs per metre of footprint radius */
  outcropsPerRadius: number;
  /** outcrop: convex curvature (1/m) and joint density (0..1) a cell must exceed */
  outcropCurvature: number;
  outcropJoint: number;
  /** outcrop: debris (m) ceiling — a sheeting slab is bare bedrock, not a buried one */
  outcropDebrisMax: number;
  /** outcrop: minimum spacing (m), size range (m) */
  outcropSpacing: number;
  outcropMinScale: number;
  outcropMaxScale: number;
  /** outcrop: vertical squash (a slab is a plate) and its bedding-tilt cap (rad) */
  outcropSquash: number;
  outcropTiltMax: number;
  /** outcrop: how deep the slab beds into the bedrock */
  outcropEmbed: number;
  /** cirque wall blocks: how many per island, minimum spacing (m), size range (m) */
  cirqueBlockCount: number;
  cirqueBlockSpacing: number;
  cirqueBlockMinScale: number;
  cirqueBlockMaxScale: number;
  /** cirque wall foot: greatest height above the bowl water (m) a block may stand at */
  cirqueBlockMaxHeight: number;
  /** the wall it must stand under: this rise (m) within this run (m) straight uphill */
  cirqueWallRise: number;
  cirqueWallRun: number;
  /** INSIDE the bowl: how strongly uphill must point AWAY from the island centre (cos) */
  cirqueBowlOutward: number;
  /** every rock keeps this clear (m) of the walk corridor masks */
  rockPathClearance: number;

  // ── T112g LOD ────────────────────────────────────────────────────────────
  /**
   * Octahedral impostor atlas: tiles per side and pixels per tile.
   *
   * 8 × 128 = a 1024² atlas per target, two targets (albedo+coverage,
   * normal+leaf mask) = 8 MB per species. The TILE is sized against the SWAP
   * DISTANCE, not picked round: at `impostorDistance` a 12 m pine covers about
   * 90 px of a 1440-line viewport at the shipped fov, so a 128 px tile is
   * still MAGNIFIED when the impostor takes over — which is also why the atlas
   * needs no mip chain to satisfy §V48. The FRAMES set the angular step: 8
   * vertices across the hemi-octahedron is ~11° between captured directions,
   * with the four horizon bearings — the only ones a walking camera uses —
   * captured exactly rather than interpolated.
   */
  impostorFrames: number;
  impostorTile: number;
  /** camera distance (m) at which the impostor starts taking over */
  impostorDistance: number;
  /** metres over which mesh and impostor cross-fade (dithered, see impostor.ts) */
  impostorFadeBand: number;
  /** coverage below this is discarded — a needle cluster's own edge */
  impostorAlphaTest: number;

  /**
   * Side (m) of one plant-cull cell. Sets the granularity of the frustum cull:
   * smaller cells cull tighter and cost more sphere tests and more upload
   * churn (the instance buffers are recompacted whenever the visible SET
   * changes, and a smaller cell changes the set more often). 32 m over a 250 m
   * island is ~60 cells carrying ~25 plants each.
   */
  vegCullCellSize: number;
  /**
   * Metres added to every plant's cull radius for the wind sway the CPU cannot
   * see. Same reason `scatterPalms` inflates its bounding sphere: a plant that
   * can leave its own cull volume pops at the frame edge.
   */
  vegCullSwayMargin: number;
  /**
   * How far a plant's SHADOW reaches (m), used to keep casters that are behind
   * the camera but cast into the frame. 0 disables the second test and the
   * cull starts eating shadows.
   */
  vegCullShadowReach: number;

  // ── T130 profile ────────────────────────────────────────────────────────
  /**
   * 0 = the raw analytic profile (A/B, and what every pre-T130 measurement
   * was taken on), 1 = run `profileApron` (heightmap.ts). Sierra only; a
   * pirate island never reaches the term.
   */
  profileEnabled: number;
  /**
   * THE APRON'S GRADE AT THE WATERLINE, as a fraction of the raw field's
   * slope there. `profileApron` integrates a slope multiplier that ramps from
   * this at h = 0 back to 1 at the top of the band, so the number IS the
   * grade: 0.3 means the first metres of shore rise at 30% of the angle the
   * archetype + noise would otherwise have given them.
   *
   * WHY IT EXISTS (§T.130). Measured from the raft's eye (1.6 m) 20 m off a
   * 250 m dome: the horizon angle was 23° and the ground was already 27 m up
   * 50 m inland — a wall, not a landfall. The whole 30-50 m of relief was
   * being spent in the first tenth of the footprint because the waterline
   * cuts the crown high on its shoulder (`sinkOpenWater` puts the shoreline
   * where the raw landmass is ~7.5 m, which on `(1−u²)^k` is the steepest
   * part of the curve).
   */
  profileToeGrade: number;
  /**
   * The band the ramp spans, as a FRACTION OF THE FAMILY'S PEAK rather than
   * as metres (§V43: the shape of an island must not depend on its size — a
   * fixed-metre band would flatten a filler islet outright and barely touch
   * the Half Dome). 0.6 puts the apron + bench under the lower 60% of the
   * family's relief and leaves the crown's own profile alone.
   */
  profileRiseFraction: number;
  /**
   * THE SCALE THE SHEETING MASK MEASURES CURVATURE AT (m) — §T.112c's
   * `sheetingStep` blur, made a knob because its radius was the bug.
   *
   * Martel 2006 says sheet joints form on CONVEX SURFACES, and the surface he
   * means is the landform, not the gravel on it. The pass blurred by one cell
   * (≈ 2 m at 256² on a 250 m island) before taking the Laplacian, so the mask
   * read the surface-detail fbm's own finest octave (3.6 m) as curvature and
   * fired across the whole island rather than on the noses. At 8 m the mask
   * reads the FORM. Measured on the dome: rms|∇h| over the land 0.51 → 0.46
   * with the silhouette unchanged — the steps stop being sprayed over flat
   * ground. It does not move the sheeting's own wavelength (that is
   * `sheetThickness` / slope, and 4 m sheets were measured and rejected — see
   * that knob).
   */
  sheetCurvatureBlur: number;
  /**
   * OCTAVES OF SURFACE DETAIL a sierra island gets (§V43's slope budget still
   * sets the amplitude; this sets the FLOOR of the wavelength). The pirate
   * default is 4, which at `noiseScale` 0.035 puts the finest octave at 3.6 m
   * — two grid cells at 256² on a 250 m island. That is the wavelength the
   * user called "too detailed and too fine" from the deck, and it is also
   * what the sheeting mask was reading as curvature. 3 octaves floors the
   * detail at 7.2 m; granite is smooth at arm's length anyway, and the
   * material's own band-limited grain (§T.112d) is what carries the metre
   * scale.
   */
  graniteNoiseOctaves: number;
}

export const sierraParams: SierraParams = registerParams(
  'sierra',
  {
    // ── T112g LOD ──
    impostorFrames: 8,
    impostorTile: 128,
    impostorDistance: 260,
    impostorFadeBand: 90,
    impostorAlphaTest: 0.35,
    vegCullCellSize: 32,
    vegCullSwayMargin: 1.2,
    vegCullShadowReach: 40,
    sliceCount: 3,
    sliceMinSpacing: 500,
    sliceMaxSpacing: 700,
    sliceGap: 100,
    sliceRadiusMin: 150,
    sliceRadiusMax: 280,
    startClearance: 400,
    sliceGridSize: 256,
    fillerGridSize: 128,
    fillerCount: 2,
    fillerRadiusMin: 55,
    fillerRadiusMax: 90,
    halfDomeDistanceFactor: 1.6,
    halfDomeRadius: 480,
    halfDomePeak: 320,

    domeRelief: 2.4,
    // T130: 1.5 was authored against the pre-T130 profile, where the ridge
    // topped out at 27-31 m. The apron remap compresses the LOW band and this
    // family lives entirely inside it, so 1.5 came out at 16-19 m — low enough
    // that §T.112b could not find a fork POI on two of three seeds and its
    // soft gate had nothing to cut. 1.95 puts the crest back at 21-25 m with
    // the long shallow foot the remap bought. Above ~2.0 the crest turns into
    // a knife edge the walker's own 35° gate refuses (measured: the summit's
    // walkable component fell to 8 cells at 2.0, seed 988). The ridge was
    // never the wall the user complained about: it read 9-14° from 20 m off
    // before T130 and 4-8° after.
    ridgeRelief: 1.95,
    cirqueRelief: 2.2,
    domeCrownPower: 1.5,
    domeTerraceMin: 2,
    domeTerraceMax: 4,
    // T130: 5 m steps read as 5 m before the apron remap; after it a step on
    // the dome's shoulder is compressed to ~0.5× and the treads stopped
    // separating (seed 988 fell from 2 plateaus to 1). 6.5 m of AUTHORED rise
    // is ~3.4 m of built tread-to-tread, which is what 5 m used to be.
    domeTerraceRise: 6.5,
    domeTerraceRiser: 0.4,
    domeTerraceSector: 1.1,
    ridgeLength: 2.0,
    ridgeWidth: 0.4,
    ridgeUndulation: 0.3,
    ridgeDrownStart: 0.62,
    ridgeLeeDepth: 2.4,
    treelineSpacing: 9,
    treelineDepthMin: 0.4,
    treelineDepthMax: 5,
    cirqueArc: 4.3,
    cirqueRing: 0.6,
    cirqueLagoonDepth: 2.2,
    cirqueLagoonRadius: 0.26,
    halfDomeFaceOffset: 0.08,
    halfDomeFaceWidth: 0.05,
    dgSandBand: 12,
    graniteNoiseSlope: 0.08,
    sierraCoastSlope: 0.1,

    graniteBaseColor: 0xa39e92,
    graniteTopColor: 0xc4bfb6,
    graniteJointColor: 0x6b665f,
    lichenColor: 0x566b41,
    jointSpacing: 6.5,
    jointWidth: 0.3,
    jointStrength: 0.35,
    lichenScale: 0.09,
    lichenCoverage: 0.28,
    lichenStrength: 0.45,
    polishGloss: 0.35,
    dgSandColor: 0xd8c4a2,
    dgSandShadeColor: 0xbda987,

    // §T.122: pale warm DG, a measured 0.052 OKLab clear of bare granite after
    // ACES at the shipped exposure — the tightest pair in the stack was
    // granite~grus at noon (0.049 before this nudge)
    grusColor: 0xcdb98f,
    litterColor: 0x5b3922,
    coverGrusSlope: 20,
    coverBareSlope: 35,
    coverMacroScale: 1 / 60,
    coverMacroVariation: 0.22,
    litterCoverage: 0.35,
    litterStrength: 0.7,
    coverGrainScale: 0.5,
    coverGrainStrength: 0.18,

    horizonShadowSoftness: 0.06,
    horizonShadowStrength: 0.9,
    horizonSkyAoStrength: 1,

    inlandBouldersPerRadius: 0.32,
    erraticCount: 4,
    boulderConvexity: 0.02,
    boulderSlopeMin: 0.47, // tan 25°
    erraticSlopeMax: 0.14, // tan 8°
    boulderMinHeight: 4,
    boulderMinScale: 1.2,
    boulderMaxScale: 5.5,

    // 0.28 → 2.0 (7×, §T.112a): the R0 frames had ~12 trees on a 250 m
    // island; the stand is then thinned by footprint competition below
    pinesPerRadius: 2.0,
    juniperFraction: 0.3,
    pineHeightMin: 9,
    pineHeightMax: 16,
    pineTiersMin: 3,
    pineTiersMax: 4,
    pineTierSpread: 0.2,
    pineTrunkRadius: 0.28,
    pineSlopeLimit: 0.47, // tan 25° (was 28°; benches only)
    pineMinHeight: 2.5,
    // T130: the re-profiled islands roughly DOUBLED their bench (measured at
    // R = 250, seed 1965: dome 6.9% → 14.5%, cirque 3.5% → 8.7%, ridge 1.1% →
    // 4.0%), so 0.04 saturated the `min(bench/reference, 1)` clamp on all three
    // and every family carried the same nominal stand — the property "a steep
    // island thins rather than throws" stopped being expressible. 0.14 is the
    // new dome bench, so the reference still means "a footprint this benched
    // carries the nominal stand" and the families separate again (500 / 311 /
    // 144 against 500 / 434 / 141 before).
    pineBenchReference: 0.14,
    // measured (tests/terrainQuickWins.test.ts): 8 stands × 28 m with a 1 m
    // crown at competition puts the dome/cirque NN distance at 0.63-0.91 of a
    // uniform scatter on the same bench; wider stands or bigger crowns push
    // it past 1 (regular, the competition's own spacing wins)
    pineStandCount: 8,
    pineStandSpread: 28,
    pineFootprint: 1.0,
    pineFootprintGrowth: 0.25,
    pineCompetitionRounds: 2,
    pineSouthAspectFactor: 0.35,
    deadPineHeight: 11,
    deadBranchCount: 5,
    pineSwayAmplitude: 0.18,
    pineFlutterAmplitude: 0.04,
    pineBarkColor: 0x6b4a33,
    needleDarkColor: 0x2f4b2c,
    needleLightColor: 0x5b7d47,
    juniperNeedleColor: 0x5f7358,
    deadWoodColor: 0x8d837a,

    // ── T112c erosion ──
    erosionEnabled: 1,
    iceShear: 14,
    // T130 measured and REJECTED: 4 m sheets (riser 0.65) put the exfoliation
    // steps ~9 m apart instead of ~4 m, but a 2 m riser is a wall to a 0.3 m
    // capsule and it closed §T.112b's carved corridor on the cirque (17 of 519
    // route samples went `solidAt` at the 35° gate). The wavelength is bought
    // by `sheetCurvatureBlur` and `graniteNoiseOctaves` instead, which move the
    // mask and the source rather than the step height.
    sheetThickness: 2.5,
    sheetRiser: 0.5,
    // T130 measured and REJECTED: recalibrating this to the FORM's own
    // curvature (0.008/m — a 38 m crown over a 175 m radius) once
    // `sheetCurvatureBlur` took the noise out of the Laplacian bought 10% of
    // relief wavelength on the dome and broke nine downstream properties at
    // once (talus sort, cirque blocks, the cirque's walk-ashore, two occluder
    // sight lines, the pine clustering). The mask stays where §T.112c put it.
    sheetCurvature: 0.0025,
    sheetStossFactor: 0.35,
    sheetPlateSize: 40,
    jointScale: 0.02,
    // T130: these are the DG-sand band's own heights, and the band moved. The
    // apron remap (heightmap.profileApron) puts the top of `dgSandBand` at
    // 3.2-3.9 m of ELEVATION instead of 12 m, so 14/12 was guarding four times
    // the beach that exists — on the re-profiled drowned ridge (peak 16 m)
    // almost nothing cleared 14 m and the erosion stage, T112b's soft gate and
    // its occluder all went inert. 4/4 keeps the same ratios to the sand's top
    // (start ≈ 1.1×, full ≈ 2.2×) that 14/12 had to the old one.
    erodeBandStart: 4,
    erodeBandWidth: 4,
    streamRate: 0.006,
    streamUplift: 0.12,
    streamAreaExp: 0.5,
    streamItersDome: 0,
    streamItersRidge: 12,
    streamItersCirque: 12,
    rockfallSlope: 1.0, // tan 45°
    rockfallRate: 0.35,
    rockfallSteps: 4,
    talusRepose: 0.7, // tan 35°
    thermalIters: 40,
    smoothRepose: 1.2, // tan 50°
    smoothIters: 6,
    floodFloor: 0.3,

    // ── T112b paths ──
    pathEnabled: 1,
    pathMinRadius: 120,
    pathCorridorWidth: 4,
    pathCorridorFalloff: 6,
    pathMainSlope: 27,
    pathForkSlope: 31,
    pathScrambleSlope: 34.25,
    pathScrambleLength: 16,
    pathSlopeCost: 4,
    pathTurnCost: 1.5,
    pathBeachCost: 0.6,
    pathForkAt: 0.45,
    pathForkReturnAt: 0.72,
    pathForkOffset: 40,
    pathExitSeparation: 1.2,
    pathGateRadius: 32,
    pathGateStep: 7,
    pathGateWidth: 5,
    pathGateFeather: 6,
    // T130: 50/6 was authored against islands 40% taller. `pathCarve` builds
    // the occluder as ySaddle + min(pathOccluderHeight, D·0.25·tan(pathMainSlope)·0.95),
    // so on the re-profiled ground the 6 m param BOUND the crest while the
    // approach's own dip was ramped away by the profile clamp — the sight line
    // from D cleared the crest by 0.16 m on the drowned ridge, seed 2942.
    // 60 m of approach lets the geometry own the crest (the cap term is 7.3 m)
    // and 8 m takes the param out of the way rather than replacing one
    // arbitrary binding constant with another.
    pathOccluderDistance: 60,
    pathOccluderHeight: 8,
    pathOccluderSigma: 7,
    pathOccluderSpan: 36,
    pathTilt: 2,
    pathGuardStart: 0.5,
    pathGuardWidth: 1,
    // ── T112d shading ──
    // polish where curvature > +0.02/m and slope < 15°, on bare bedrock
    polishCurvature: 0.016,
    polishSlope: 18,
    polishDebrisMax: 0.3,
    // §T.122: glacial polish is NOT white. Its brightness on screen is
    // SPECULAR — `polishGloss` pulls the roughness down — and an albedo up at
    // 0xcbd4d9 spent the last of the chroma headroom ACES leaves near L 0.9,
    // landing 0.015 OKLab from the fresh-fracture tint and 0.045 from grus.
    // A mid cool grey reads as polish because of the sheen, and leaves room.
    polishedColor: 0xb0b9c2,
    fracturedJoint: 0.66,
    fracturedSlope: 38,
    fracturedColor: 0x7b7368,
    fracturedRoughness: 0.95,
    grusDebrisMin: 0.15,
    litterMoisture: 0.55,
    lichenAspectAzimuth: Math.PI * 1.5, // −z faces
    lichenAspectStrength: 0.6,
    lichenShadeStrength: 0.5,
    pathWearWidth: 6,
    pathWearStrength: 0.6,
    pathWornColor: 0x987f62,
    sheetBandSpacing: 2.5,
    sheetBandRiser: 0.3,
    sheetBandStrength: 0.22,
    sheetBandConvexity: 0.01,
    sheetBandRelief: 0.12,
    layerBlendWidth: 0.25,
    layerHeightAmp: 0.3,
    bandLowHeight: 8,
    bandMidHeight: 24,
    bandHighHeight: 48,
    bandWidth: 6,
    bandLowTint: 0xd6c9b4,
    bandMidTint: 0xffffff,
    bandHighTint: 0xc9d0d8,
    bandCrownTint: 0xe8e4dc,
    bandStrength: 0.5,

    // ── T122 ──
    sheetBandWarp: 0.15,
    jointCoverage: 0.78,
    jointBaseBite: 0.15,
    rockFreshCover: 0.85,
    rockFreshLichen: 0.7,
    rockFreshStrength: 0.6,
    // WARM near-white, not the cool grey it was: a cool 0xbdc4c6 sat 0.025
    // OKLab from `polishedColor` after the tonemap, so a fallen block on the
    // glacial crown — exactly where the plucked blocks are — vanished into the
    // slab it fell from. Feldspar is warm; a polished, water-darkened glacial
    // surface is cool. Median block~ground separation 0.056 → 0.077 at tod 17.5.
    rockFreshTint: 0xdcd4c2,

    // ── T112e vegetation ──
    vegSampleSpacing: 2,
    vegCurvatureRef: 0.008,
    vegMoistureFeather: 0.2,
    vegClumpBare: 0.6,
    // 3π/2: the aspect channel is atan2(z, x) of the DOWNHILL direction, so a
    // face looking at −z (the sun's side in this world) reads 4.712
    vegSunAspect: 4.712,
    pineDensity: 0.45,
    pineMoistureMin: 0.2,
    juniperDensity: 0.65,
    juniperMoistureMax: 0.5,
    juniperWindWeight: 0.5,
    juniperFootprint: 1.1,
    juniperHeight: 2.6,
    juniperSpread: 1.15,
    juniperBoleRadius: 0.09,
    juniperLean: 0.35,
    juniperLimbs: 3,
    juniperLobeRadius: 0.5,
    juniperLobeSquash: 0.6,
    manzanitaDensity: 0.55,
    manzanitaMoistureMax: 0.45,
    manzanitaSkyExponent: 2,
    manzanitaAspectWeight: 0.5,
    manzanitaSlopeLimit: 0.9, // tan 42° — chaparral holds ground no tree will
    manzanitaForkRange: 12,
    manzanitaForkBoost: 0.85,
    manzanitaFootprint: 0.32,
    manzanitaHeight: 1.1,
    manzanitaSpread: 0.75,
    manzanitaStems: 4,
    manzanitaStemRadius: 0.045,
    manzanitaLobeRadius: 0.5,
    manzanitaLobeSquash: 0.62,
    manzanitaLeafColor: 0x71805a,
    manzanitaStemColor: 0x8f4b33,
    foliageClusterBlend: 0.55,
    foliageWrap: 0.45,
    foliageWrapStrength: 0.35,
    foliageTransmission: 0.45,
    foliageTransmissionPower: 3,
    foliageTransmissionColor: 0x93ad5c,
    understorySpacing: 2.5,
    understorySlopeLimit: 0.5,
    understoryGrassDensity: 0.15,
    understoryDeadfallDensity: 0.035,
    understoryConeDensity: 0.09,
    bunchgrassHeight: 0.45,
    deadfallLength: 2.2,
    deadfallRadius: 0.13,
    coneHeight: 0.12,
    // ── T112f rocks ──
    // the debris channel is thin: measured over the three slice archetypes it
    // reaches 0.75 m on a dome and 1.8 m in a cirque, and is ~0 on a drowned
    // ridge (which is mostly under water). 0.15 m is "an apron is here".
    // T130: the re-profiled ground is gentler, so the rockfall source is
    // weaker and the debris channel spreads thinner and further — at 0.15 m
    // the flood fill in `labelAprons` merged separate aprons into one
    // component and the downslope SORT stopped being measurable across it
    // (foot median 19.1 m against head 17.8 m on the cirque). 0.2 m separates
    // the aprons again. This is the §T.112f coupling the profile change was
    // expected to move.
    talusDebrisMin: 0.2,
    talusDebrisFull: 0.8,
    talusSpacing: 2.4,
    talusHeadScale: 0.45,
    talusFootScale: 2.1,
    talusSizeJitter: 0.18,
    talusEmbed: 0.55,
    talusGeoVariants: 2,
    outcropsPerRadius: 0.16,
    outcropCurvature: 0.015,
    outcropJoint: 0.62,
    outcropDebrisMax: 0.2,
    outcropSpacing: 7,
    outcropMinScale: 1.6,
    outcropMaxScale: 4.5,
    outcropSquash: 0.32,
    outcropTiltMax: 0.45,
    outcropEmbed: 0.5,
    cirqueBlockCount: 12,
    cirqueBlockSpacing: 9,
    cirqueBlockMinScale: 2.8,
    cirqueBlockMaxScale: 6.5,
    cirqueBlockMaxHeight: 8,
    // T130: the cirque ring is 30 m instead of 46 m after the apron remap, so
    // 10 m of rise within 18 m uphill stopped finding a wall foot on two seeds
    // (6 of 12 blocks placed). 9 within 24 finds the same wall on the lower
    // ring and still excludes the dome and the ridge, which is the property.
    cirqueWallRise: 9,
    cirqueWallRun: 24,
    cirqueBowlOutward: 0.4,
    rockPathClearance: 1.5,

    // ── T130 profile ──
    // Measured from the raft's eye (1.6 m) over 3 families × 3 seeds, at
    // 0.22/0.85, on the 250 m dome: horizon angle 20 m off the beach 23.0° →
    // 13.9°, the ground 50 m inland 27.3 m → 11.6 m, the mean grade over the
    // first fifth of the radius 28.7° → 13.1°, and the run from the waterline
    // to +3 m 10 m → 21 m. Below ~0.18 the crown's foot flattens into a table
    // and the archetypes stop reading apart; above ~0.3 the 20 m horizon angle
    // is still over 16° and the shore still reads as a bank.
    profileEnabled: 1,
    profileToeGrade: 0.22,
    profileRiseFraction: 0.85,
    sheetCurvatureBlur: 8,
    graniteNoiseOctaves: 3,

  },
  {
    sliceCount: { min: 1, max: 3, step: 1 },
    sliceMinSpacing: { min: 300, max: 1500, step: 10 },
    sliceMaxSpacing: { min: 300, max: 2000, step: 10 },
    sliceGap: { min: 0, max: 400, step: 10 },
    sliceRadiusMin: { min: 80, max: 300, step: 5 },
    sliceRadiusMax: { min: 80, max: 300, step: 5 },
    startClearance: { min: 100, max: 1000, step: 10 },
    sliceGridSize: { min: 64, max: 512, step: 64 },
    fillerGridSize: { min: 32, max: 256, step: 32 },
    fillerCount: { min: 0, max: 6, step: 1 },
    fillerRadiusMin: { min: 30, max: 150, step: 5 },
    fillerRadiusMax: { min: 30, max: 150, step: 5 },
    halfDomeDistanceFactor: { min: 1.5, max: 4, step: 0.1 },
    halfDomeRadius: { min: 200, max: 900, step: 10 },
    halfDomePeak: { min: 50, max: 600, step: 10 },
    domeRelief: { min: 0.5, max: 5, step: 0.1 },
    ridgeRelief: { min: 0.5, max: 5, step: 0.1 },
    cirqueRelief: { min: 0.5, max: 5, step: 0.1 },
    domeCrownPower: { min: 1, max: 4, step: 0.1 },
    domeTerraceMin: { min: 0, max: 6, step: 1 },
    domeTerraceMax: { min: 0, max: 6, step: 1 },
    domeTerraceRise: { min: 1, max: 15, step: 0.5 },
    domeTerraceRiser: { min: 0.1, max: 0.9, step: 0.05 },
    domeTerraceSector: { min: 0.2, max: 3.1, step: 0.05 },
    ridgeLength: { min: 1, max: 3, step: 0.05 },
    ridgeWidth: { min: 0.1, max: 0.8, step: 0.01 },
    ridgeUndulation: { min: 0, max: 0.8, step: 0.01 },
    ridgeDrownStart: { min: 0.3, max: 0.9, step: 0.01 },
    ridgeLeeDepth: { min: 0.5, max: 6, step: 0.1 },
    treelineSpacing: { min: 3, max: 30, step: 1 },
    treelineDepthMin: { min: 0.1, max: 3, step: 0.1 },
    treelineDepthMax: { min: 1, max: 10, step: 0.1 },
    cirqueArc: { min: 2, max: 5.5, step: 0.05 },
    cirqueRing: { min: 0.3, max: 0.9, step: 0.01 },
    cirqueLagoonDepth: { min: 0.5, max: 6, step: 0.1 },
    cirqueLagoonRadius: { min: 0.1, max: 0.5, step: 0.01 },
    halfDomeFaceOffset: { min: -0.5, max: 0.5, step: 0.01 },
    halfDomeFaceWidth: { min: 0.01, max: 0.3, step: 0.01 },
    dgSandBand: { min: 3, max: 30, step: 0.5 },
    graniteNoiseSlope: { min: 0, max: 0.4, step: 0.01 },
    sierraCoastSlope: { min: 0, max: 0.4, step: 0.01 },
    jointSpacing: { min: 1, max: 30, step: 0.5 },
    jointWidth: { min: 0.05, max: 2, step: 0.05 },
    jointStrength: { min: 0, max: 1, step: 0.01 },
    lichenScale: { min: 0.01, max: 0.5, step: 0.005 },
    lichenCoverage: { min: 0, max: 1, step: 0.01 },
    lichenStrength: { min: 0, max: 1, step: 0.01 },
    polishGloss: { min: 0, max: 1, step: 0.01 },
    pinesPerRadius: { min: 0, max: 4, step: 0.01 },
    juniperFraction: { min: 0, max: 1, step: 0.01 },
    pineHeightMin: { min: 3, max: 30, step: 0.5 },
    pineHeightMax: { min: 3, max: 40, step: 0.5 },
    pineTiersMin: { min: 1, max: 6, step: 1 },
    pineTiersMax: { min: 1, max: 6, step: 1 },
    pineTierSpread: { min: 0.05, max: 0.6, step: 0.01 },
    pineTrunkRadius: { min: 0.1, max: 1, step: 0.01 },
    pineSlopeLimit: { min: 0.05, max: 1.5, step: 0.01 },
    pineMinHeight: { min: 0, max: 20, step: 0.5 },
    pineBenchReference: { min: 0.005, max: 0.5, step: 0.005 },
    pineStandCount: { min: 1, max: 12, step: 1 },
    pineStandSpread: { min: 5, max: 120, step: 1 },
    pineFootprint: { min: 0.5, max: 8, step: 0.1 },
    pineFootprintGrowth: { min: 0, max: 1, step: 0.05 },
    pineCompetitionRounds: { min: 0, max: 4, step: 1 },
    pineSouthAspectFactor: { min: 0, max: 1, step: 0.01 },
    coverGrusSlope: { min: 0, max: 45, step: 1 },
    coverBareSlope: { min: 5, max: 70, step: 1 },
    coverMacroScale: { min: 0.005, max: 0.1, step: 0.001 },
    coverMacroVariation: { min: 0, max: 0.6, step: 0.01 },
    litterCoverage: { min: 0, max: 1, step: 0.01 },
    litterStrength: { min: 0, max: 1, step: 0.01 },
    coverGrainScale: { min: 0.05, max: 4, step: 0.05 },
    coverGrainStrength: { min: 0, max: 0.6, step: 0.01 },
    horizonShadowSoftness: { min: 0.005, max: 0.3, step: 0.005 },
    horizonShadowStrength: { min: 0, max: 1, step: 0.01 },
    horizonSkyAoStrength: { min: 0, max: 1, step: 0.01 },
    inlandBouldersPerRadius: { min: 0, max: 2, step: 0.01 },
    erraticCount: { min: 0, max: 20, step: 1 },
    boulderConvexity: { min: 0, max: 0.2, step: 0.001 },
    boulderSlopeMin: { min: 0, max: 1.5, step: 0.01 },
    erraticSlopeMax: { min: 0, max: 0.6, step: 0.01 },
    boulderMinHeight: { min: 0, max: 30, step: 0.5 },
    boulderMinScale: { min: 0.3, max: 10, step: 0.1 },
    boulderMaxScale: { min: 0.5, max: 20, step: 0.1 },
    deadPineHeight: { min: 3, max: 25, step: 0.5 },
    deadBranchCount: { min: 0, max: 12, step: 1 },
    pineSwayAmplitude: { min: 0, max: 1, step: 0.01 },
    pineFlutterAmplitude: { min: 0, max: 0.3, step: 0.005 },
    // ── T112c erosion ──
    erosionEnabled: { min: 0, max: 1, step: 1 },
    iceShear: { min: 0, max: 60, step: 1 },
    sheetThickness: { min: 0.5, max: 10, step: 0.25 },
    sheetRiser: { min: 0.1, max: 0.9, step: 0.05 },
    sheetCurvature: { min: 0.0002, max: 0.02, step: 0.0002 },
    sheetStossFactor: { min: 0, max: 1, step: 0.05 },
    sheetPlateSize: { min: 5, max: 200, step: 5 },
    jointScale: { min: 0.002, max: 0.2, step: 0.002 },
    erodeBandStart: { min: 0, max: 60, step: 1 },
    erodeBandWidth: { min: 1, max: 60, step: 1 },
    streamRate: { min: 0, max: 0.05, step: 0.0005 },
    streamUplift: { min: 0, max: 1, step: 0.01 },
    streamAreaExp: { min: 0.2, max: 1, step: 0.05 },
    streamItersDome: { min: 0, max: 60, step: 1 },
    streamItersRidge: { min: 0, max: 60, step: 1 },
    streamItersCirque: { min: 0, max: 60, step: 1 },
    rockfallSlope: { min: 0.3, max: 3, step: 0.05 },
    rockfallRate: { min: 0, max: 2, step: 0.05 },
    rockfallSteps: { min: 0, max: 20, step: 1 },
    talusRepose: { min: 0.3, max: 1.5, step: 0.01 },
    thermalIters: { min: 0, max: 200, step: 1 },
    smoothRepose: { min: 0.3, max: 3, step: 0.05 },
    smoothIters: { min: 0, max: 50, step: 1 },
    floodFloor: { min: 0, max: 3, step: 0.1 },
    // ── T112b paths ──
    pathEnabled: { min: 0, max: 1, step: 1 },
    pathMinRadius: { min: 0, max: 300, step: 5 },
    pathCorridorWidth: { min: 2, max: 10, step: 0.5 },
    pathCorridorFalloff: { min: 1, max: 20, step: 0.5 },
    pathMainSlope: { min: 10, max: 34, step: 0.5 },
    pathForkSlope: { min: 10, max: 34, step: 0.5 },
    pathScrambleSlope: { min: 30, max: 35, step: 0.25 },
    pathScrambleLength: { min: 3, max: 30, step: 1 },
    pathSlopeCost: { min: 0, max: 20, step: 0.25 },
    pathTurnCost: { min: 0, max: 10, step: 0.1 },
    pathBeachCost: { min: 0.1, max: 1, step: 0.05 },
    pathForkAt: { min: 0.1, max: 0.9, step: 0.01 },
    pathForkReturnAt: { min: 0.1, max: 0.95, step: 0.01 },
    pathForkOffset: { min: 10, max: 120, step: 1 },
    pathExitSeparation: { min: 0, max: 3, step: 0.05 },
    pathGateRadius: { min: 10, max: 80, step: 1 },
    pathGateStep: { min: 0, max: 20, step: 0.5 },
    pathGateWidth: { min: 2, max: 20, step: 0.5 },
    pathGateFeather: { min: 0, max: 20, step: 0.5 },
    pathOccluderDistance: { min: 20, max: 150, step: 1 },
    pathOccluderHeight: { min: 0, max: 15, step: 0.5 },
    pathOccluderSigma: { min: 2, max: 30, step: 0.5 },
    pathOccluderSpan: { min: 10, max: 100, step: 1 },
    pathTilt: { min: 0, max: 10, step: 0.1 },
    pathGuardStart: { min: 0, max: 30, step: 0.5 },
    pathGuardWidth: { min: 1, max: 30, step: 0.5 },
    // ── T112d shading ──
    polishCurvature: { min: 0, max: 0.05, step: 0.001 },
    polishSlope: { min: 0, max: 45, step: 1 },
    polishDebrisMax: { min: 0, max: 4, step: 0.05 },
    fracturedJoint: { min: 0, max: 1, step: 0.01 },
    fracturedSlope: { min: 0, max: 70, step: 1 },
    fracturedRoughness: { min: 0, max: 1, step: 0.01 },
    grusDebrisMin: { min: 0, max: 4, step: 0.05 },
    litterMoisture: { min: 0, max: 1, step: 0.01 },
    lichenAspectAzimuth: { min: 0, max: 6.2832, step: 0.01 },
    lichenAspectStrength: { min: 0, max: 1, step: 0.01 },
    lichenShadeStrength: { min: 0, max: 1, step: 0.01 },
    pathWearWidth: { min: 0, max: 32, step: 0.5 },
    pathWearStrength: { min: 0, max: 1, step: 0.01 },
    sheetBandSpacing: { min: 0.5, max: 10, step: 0.1 },
    sheetBandRiser: { min: 0.05, max: 0.9, step: 0.01 },
    sheetBandStrength: { min: 0, max: 1, step: 0.01 },
    sheetBandConvexity: { min: 0.0005, max: 0.05, step: 0.0005 },
    sheetBandRelief: { min: 0, max: 1, step: 0.01 },
    layerBlendWidth: { min: 0.02, max: 1, step: 0.01 },
    layerHeightAmp: { min: 0, max: 1, step: 0.01 },
    bandLowHeight: { min: 0, max: 100, step: 1 },
    bandMidHeight: { min: 0, max: 200, step: 1 },
    bandHighHeight: { min: 0, max: 300, step: 1 },
    bandWidth: { min: 0.5, max: 40, step: 0.5 },
    bandStrength: { min: 0, max: 1, step: 0.01 },
    // ── T122 ──
    sheetBandWarp: { min: 0, max: 6, step: 0.1 },
    jointCoverage: { min: 0, max: 1, step: 0.01 },
    jointBaseBite: { min: 0, max: 1, step: 0.01 },
    rockFreshCover: { min: 0, max: 1, step: 0.01 },
    rockFreshLichen: { min: 0, max: 1, step: 0.01 },
    rockFreshStrength: { min: 0, max: 1, step: 0.01 },

    // ── T112e vegetation ──
    vegSampleSpacing: { min: 1, max: 8, step: 0.25 },
    vegCurvatureRef: { min: 0.001, max: 0.05, step: 0.001 },
    vegMoistureFeather: { min: 0.02, max: 0.6, step: 0.01 },
    vegClumpBare: { min: 0, max: 0.9, step: 0.01 },
    vegSunAspect: { min: 0, max: 6.2832, step: 0.01 },
    pineDensity: { min: 0, max: 2.5, step: 0.01 },
    pineMoistureMin: { min: 0, max: 1, step: 0.01 },
    juniperDensity: { min: 0, max: 4, step: 0.01 },
    juniperMoistureMax: { min: 0, max: 1, step: 0.01 },
    juniperWindWeight: { min: 0, max: 1, step: 0.01 },
    juniperFootprint: { min: 0.2, max: 5, step: 0.05 },
    juniperHeight: { min: 1, max: 6, step: 0.1 },
    juniperSpread: { min: 0.4, max: 2, step: 0.05 },
    juniperBoleRadius: { min: 0.02, max: 0.25, step: 0.005 },
    juniperLean: { min: 0, max: 1, step: 0.05 },
    juniperLimbs: { min: 1, max: 5, step: 1 },
    juniperLobeRadius: { min: 0.2, max: 1, step: 0.02 },
    juniperLobeSquash: { min: 0.2, max: 1.2, step: 0.02 },
    manzanitaDensity: { min: 0, max: 2.5, step: 0.01 },
    manzanitaMoistureMax: { min: 0, max: 1, step: 0.01 },
    manzanitaSkyExponent: { min: 0, max: 6, step: 0.1 },
    manzanitaAspectWeight: { min: 0, max: 1, step: 0.01 },
    manzanitaSlopeLimit: { min: 0.1, max: 1.5, step: 0.01 },
    manzanitaForkRange: { min: 0, max: 40, step: 0.5 },
    manzanitaForkBoost: { min: 0, max: 1, step: 0.01 },
    manzanitaFootprint: { min: 0.1, max: 3, step: 0.05 },
    manzanitaHeight: { min: 0.3, max: 3, step: 0.05 },
    manzanitaSpread: { min: 0.2, max: 2, step: 0.05 },
    manzanitaStems: { min: 1, max: 7, step: 1 },
    manzanitaStemRadius: { min: 0.01, max: 0.15, step: 0.005 },
    manzanitaLobeRadius: { min: 0.2, max: 1, step: 0.02 },
    manzanitaLobeSquash: { min: 0.2, max: 1.2, step: 0.02 },
    foliageClusterBlend: { min: 0, max: 1, step: 0.01 },
    foliageWrap: { min: 0, max: 1, step: 0.01 },
    foliageWrapStrength: { min: 0, max: 1, step: 0.01 },
    foliageTransmission: { min: 0, max: 2, step: 0.01 },
    foliageTransmissionPower: { min: 0.5, max: 12, step: 0.1 },
    understorySpacing: { min: 0.5, max: 6, step: 0.1 },
    understorySlopeLimit: { min: 0.05, max: 1.5, step: 0.01 },
    understoryGrassDensity: { min: 0, max: 0.5, step: 0.005 },
    understoryDeadfallDensity: { min: 0, max: 0.2, step: 0.002 },
    understoryConeDensity: { min: 0, max: 0.5, step: 0.005 },
    bunchgrassHeight: { min: 0.1, max: 1.2, step: 0.02 },
    deadfallLength: { min: 0.5, max: 5, step: 0.1 },
    deadfallRadius: { min: 0.03, max: 0.5, step: 0.01 },
    coneHeight: { min: 0.03, max: 0.4, step: 0.01 },
    // ── T112f rocks ──
    talusDebrisMin: { min: 0.02, max: 2, step: 0.01 },
    talusDebrisFull: { min: 0.05, max: 4, step: 0.05 },
    talusSpacing: { min: 0.5, max: 12, step: 0.1 },
    talusHeadScale: { min: 0.2, max: 4, step: 0.05 },
    talusFootScale: { min: 0.2, max: 8, step: 0.05 },
    talusSizeJitter: { min: 0, max: 0.6, step: 0.01 },
    talusEmbed: { min: 0, max: 1, step: 0.01 },
    talusGeoVariants: { min: 1, max: 4, step: 1 },
    outcropsPerRadius: { min: 0, max: 1, step: 0.01 },
    outcropCurvature: { min: 0, max: 0.05, step: 0.001 },
    outcropJoint: { min: 0, max: 1, step: 0.01 },
    outcropDebrisMax: { min: 0, max: 4, step: 0.05 },
    outcropSpacing: { min: 1, max: 30, step: 0.5 },
    outcropMinScale: { min: 0.5, max: 12, step: 0.1 },
    outcropMaxScale: { min: 0.5, max: 20, step: 0.1 },
    outcropSquash: { min: 0.1, max: 1, step: 0.01 },
    outcropTiltMax: { min: 0, max: 1.2, step: 0.01 },
    outcropEmbed: { min: 0, max: 1, step: 0.01 },
    cirqueBlockCount: { min: 0, max: 40, step: 1 },
    cirqueBlockSpacing: { min: 1, max: 40, step: 0.5 },
    cirqueBlockMinScale: { min: 0.5, max: 15, step: 0.1 },
    cirqueBlockMaxScale: { min: 0.5, max: 25, step: 0.1 },
    cirqueBlockMaxHeight: { min: 1, max: 40, step: 0.5 },
    cirqueWallRise: { min: 2, max: 60, step: 0.5 },
    cirqueWallRun: { min: 4, max: 60, step: 1 },
    cirqueBowlOutward: { min: 0, max: 1, step: 0.01 },
    rockPathClearance: { min: 0, max: 12, step: 0.1 },

    // ── T130 profile ──
    profileEnabled: { min: 0, max: 1, step: 1 },
    profileToeGrade: { min: 0.05, max: 1, step: 0.01 },
    profileRiseFraction: { min: 0.1, max: 1.5, step: 0.05 },
    sheetCurvatureBlur: { min: 1, max: 30, step: 0.5 },
    graniteNoiseOctaves: { min: 1, max: 6, step: 1 },

  },
);
