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

    pinesPerRadius: 0.28,
    juniperFraction: 0.3,
    pineHeightMin: 9,
    pineHeightMax: 16,
    pineTiersMin: 3,
    pineTiersMax: 4,
    pineTierSpread: 0.2,
    pineTrunkRadius: 0.28,
    pineSlopeLimit: 0.53, // tan 28°
    pineMinHeight: 2.5,
    // measured bench fractions at the defaults: dome 9%, cirque 0.7%, ridge
    // 0.3% — level ground is scarce on a ridge, and a ridge is still wooded
    pineBenchReference: 0.04,
    pineStandCount: 5,
    pineStandSpread: 34,
    deadPineHeight: 11,
    deadBranchCount: 5,
    pineSwayAmplitude: 0.18,
    pineFlutterAmplitude: 0.04,
    pineBarkColor: 0x6b4a33,
    needleDarkColor: 0x2f4b2c,
    needleLightColor: 0x5b7d47,
    juniperNeedleColor: 0x5f7358,
    deadWoodColor: 0x8d837a,
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
    pinesPerRadius: { min: 0, max: 1.5, step: 0.01 },
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
    deadPineHeight: { min: 3, max: 25, step: 0.5 },
    deadBranchCount: { min: 0, max: 12, step: 1 },
    pineSwayAmplitude: { min: 0, max: 1, step: 0.01 },
    pineFlutterAmplitude: { min: 0, max: 0.3, step: 0.005 },
  },
);
