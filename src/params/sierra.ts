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
}

export const sierraParams: SierraParams = registerParams(
  'sierra',
  {
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
    ridgeRelief: 1.5,
    cirqueRelief: 2.2,
    domeCrownPower: 1.5,
    domeTerraceMin: 2,
    domeTerraceMax: 4,
    domeTerraceRise: 5,
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

    graniteBaseColor: 0xa9a39a,
    graniteTopColor: 0xc4bfb6,
    graniteJointColor: 0x6b665f,
    lichenColor: 0x6a7350,
    jointSpacing: 6.5,
    jointWidth: 0.3,
    jointStrength: 0.35,
    lichenScale: 0.09,
    lichenCoverage: 0.28,
    lichenStrength: 0.45,
    polishGloss: 0.35,
    dgSandColor: 0xd8c4a2,
    dgSandShadeColor: 0xbda987,

    grusColor: 0xb8a98e,
    litterColor: 0x6e5a42,
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
    // measured bench fractions at the defaults: dome 9%, cirque 0.7%, ridge
    // 0.3% — level ground is scarce on a ridge, and a ridge is still wooded
    pineBenchReference: 0.04,
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
    sheetThickness: 2.5,
    sheetRiser: 0.5,
    sheetCurvature: 0.0025,
    sheetStossFactor: 0.35,
    sheetPlateSize: 40,
    jointScale: 0.02,
    erodeBandStart: 14,
    erodeBandWidth: 12,
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
    pathOccluderDistance: 50,
    pathOccluderHeight: 6,
    pathOccluderSigma: 7,
    pathOccluderSpan: 36,
    pathTilt: 2,
    pathGuardStart: 0.5,
    pathGuardWidth: 1,
    // ── T112d shading ──
    // polish where curvature > +0.02/m and slope < 15°, on bare bedrock
    polishCurvature: 0.02,
    polishSlope: 15,
    polishDebrisMax: 0.3,
    polishedColor: 0xc9c4ba,
    fracturedJoint: 0.55,
    fracturedSlope: 30,
    fracturedColor: 0x8e887f,
    fracturedRoughness: 0.95,
    grusDebrisMin: 0.4,
    litterMoisture: 0.55,
    lichenAspectAzimuth: Math.PI * 1.5, // −z faces
    lichenAspectStrength: 0.6,
    lichenShadeStrength: 0.5,
    pathWearWidth: 6,
    pathWearStrength: 0.6,
    pathWornColor: 0xc2b49a,
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
  },
);
