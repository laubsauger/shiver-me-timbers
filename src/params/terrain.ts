/**
 * Terrain material tunables (§V16: every tunable lives in a params module and
 * appears in Tweakpane; shader magic constants forbidden). Consumed by
 * src/terrain/* (T27 materials, T20 island geometry).
 *
 * Colors are hex numbers (same convention as params/clouds.ts). The debug
 * panel mutates this object in place; material handles copy values into GPU
 * uniforms via their `updateFromParams()` — call it per frame or on change.
 */
import { registerParams, type ParamMeta } from './registry';

export interface TerrainParams {
  // -- shared procedural noise (mirrored on CPU in terrain/noiseCpu.ts) -----
  /** fbm octave count used when building material node graphs (2..4) */
  noiseOctaves: number;
  /** per-octave frequency multiplier */
  noiseLacunarity: number;
  /** per-octave amplitude multiplier */
  noiseGain: number;
  /** tri-planar blend sharpness (higher = tighter plane transitions) */
  triplanarSharpness: number;

  // -- rock (chunky stylized, soft-beveled — docs/ship-full-view.png) -------
  /** world-space noise frequency on rock (1/m) */
  rockScale: number;
  /** color band count for the painterly stepped shading */
  rockBands: number;
  /** 0 = hard posterize bands, 1 = fully smooth (no banding) */
  rockBandSoftness: number;
  /** base grey-tan */
  rockBaseColor: number;
  /** warm sun-bleached top catch */
  rockTopColor: number;
  /** dark crevice/cavity tint */
  rockCreviceColor: number;
  /** low-frequency cavity noise scale (1/m) */
  rockCreviceScale: number;
  /** how strongly cavities pull toward creviceColor (0..1) */
  rockCreviceStrength: number;
  /** exponent shaping the upward-face highlight falloff */
  rockTopPower: number;
  /** strength of the top/sun-catch tint (0..1) */
  rockTopStrength: number;
  /** extra darkening on steep side faces (0..1) */
  rockSideDarken: number;
  rockRoughness: number;

  // -- sand (bright warm beach) ---------------------------------------------
  /** warm bright base */
  sandBaseColor: number;
  /** darker warm shade mixed in by large-scale noise */
  sandShadeColor: number;
  /** large hue-variation noise scale (1/m) */
  sandShadeScale: number;
  /** fine grain noise scale (1/m) */
  sandGrainScale: number;
  /** grain brightness modulation amount (0..1) */
  sandGrainStrength: number;
  /** sparkle cells per meter */
  sparkleDensity: number;
  /** fraction of cells that can glint (0..1) */
  sparkleCoverage: number;
  /** specular exponent of a glint (higher = tighter) */
  sparklePower: number;
  /** glint brightness multiplier */
  sparkleStrength: number;
  sandRoughnessDry: number;
  sandRoughnessWet: number;

  // -- wave-formed sand ripples (the submerged shelf's only structure) -------
  /**
   * WHY THIS EXISTS. User: "the seafloor is so boring and has no structure to
   * it at all that we're not even noticing that we're seeing down at the
   * seafloor" — arrived at after first reporting that the sea had lost its
   * transparency. That is the sharper diagnosis: transparency you cannot
   * perceive is indistinguishable from opacity. Ten metres of clear water over
   * a FEATURELESS plane gives the same flat wash as an opaque surface, so the
   * water reads as opaque however correct the transmission is.
   *
   * Wave ripples are the most recognisable shallow-bottom feature there is,
   * and the shelf apron (islandMesh.buildIslandGeometry) has just made a lot
   * more of that bottom visible, so it needs them more than it did.
   *
   * `rippleAngle` is a WORLD BEARING in degrees and it is a stand-in: real
   * ripple crests run along the depth contours, because refraction turns the
   * swell to approach a shore head-on. Contour-following would come from the
   * horizontal part of `normalWorld`, which this material already has — see
   * the note in `buildSandNodes`. One bearing for the world is honest as a
   * first cut and is a live panel value, not a baked constant.
   */
  rippleStrength: number;
  /** crest-to-crest distance (m) — real wave ripples run 0.1-1 m */
  rippleWavelength: number;
  /** water depth (m) by which ripples have died out — orbital motion at the
   *  bed falls off with depth, so a deep shelf is smooth sand */
  rippleDepthFade: number;
  /** bearing (deg) the crests run along */
  rippleAngle: number;
  /** how far crest lines wander (in wavelengths) so they are not ruled lines */
  rippleBend: number;
  /** world frequency (1/m) of that wander */
  rippleBendScale: number;

  // -- shore wetness band ----------------------------------------------------
  /** world Y of the water surface the wet band hugs (m) */
  waterline: number;
  /** vertical width of the wet gradient above the waterline (m) */
  wetBand: number;
  /** how much wet sand darkens (0..1) */
  wetDarken: number;

  // -- shore runup / swash (T33 "waves lapping on the beach") ---------------
  /**
   * The runup is an ANALYTIC swash model in the sand material, not a decal:
   * each wave cycle rushes a waterline `runupLevel` up the beach, then drains
   * back slower than it came. Three bands come out of it — the wetted sheet
   * currently under water, the foam line riding the moving edge, and the wet
   * sand the last few waves left behind, drying out at `dryTime`. Levels are
   * in METERS OF ELEVATION above the waterline, which maps to horizontal
   * distance by the local beach slope, so a flat apron gets a long swash and
   * a steep one a short slap for free.
   */
  runupEnabled: boolean;
  /** seconds per swash cycle at the reference swell (set period) */
  runupPeriod: number;
  /** fraction of the cycle spent rushing up (the rest drains back) */
  runupRiseFraction: number;
  /** runup height (m above waterline) of the weakest / strongest wave in a set */
  runupHeightMin: number;
  runupHeightMax: number;
  /** how strongly live swell amplitude (≈Hs/2) scales the runup, 0 = ignore the sea */
  runupSwellResponse: number;
  /** alongshore phase noise scale (1/m) — decorrelates the swash round the
   *  island so it never reads as one synchronized ring */
  runupPhaseScale: number;
  /** vertical feather (m) of the wet-sheet edge */
  runupSheetFeather: number;
  /** turquoise sheen of the thin water sheet over sand */
  sheetColor: number;
  sheetStrength: number;
  /** vertical thickness (m) of the bright foam line riding the swash edge */
  swashFoamWidth: number;
  swashFoamColor: number;
  swashFoamStrength: number;
  /** residual foam left on the sand behind a retreating wave (0..1) */
  swashResidualStrength: number;
  /** lacy break-up noise scale (1/m) + strength for the foam edge */
  swashFoamNoiseScale: number;
  swashFoamNoiseStrength: number;
  /** seconds for wet sand left by a wave to dry back out */
  dryTime: number;
  /**
   * Receive §V34 water lighting on the terrain — sun caustics over the
   * shallows, sea bounce-fill, depth absorption. BUILD-TIME (it branches the
   * node graph, like `runupEnabled`): flipping it needs a material rebuild.
   * Kept as a switch because the shallows are the largest caustics receiver in
   * the scene by screen coverage, so this is the first thing to bisect if the
   * frame time moves when you moor next to a beach (§V17).
   *
   * It also decides where the still-water level comes from. ON: the live
   * displaced FFT surface, per fragment, shared with the caustics call — so
   * the swash waterline follows the actual waves. OFF: the flat `waterline`
   * uniform.
   */
  receiveCaustics: boolean;
  /**
   * Half-width (m) of the band around the waterline over which §V34 water
   * lighting fades out going up the beach.
   *
   * WHY THIS EXISTS: `mode: 'below'` hard-codes the caustics module's own
   * `submerged` term to 1 — correct for a seabed, wrong for terrain, because
   * ONE material here shades everything from the −45 m seabed to a +35 m
   * peak. Without this gate `belowSpan` clamps to `minDepth` on dry ground and
   * the depth budget (`maxDepth`) only culls water that is too DEEP, so a
   * hilltop gets lit as though it sat just under the surface. Caustics
   * crawling over dry sand and dunes is exactly the kind of thing that reads
   * as "silly" (§V43).
   */
  causticsWaterlineBand: number;

  // -- ground cover (§V43: an island is not a sand dune) --------------------
  /**
   * WHY THIS LAYER EXISTS. The blend material had exactly two materials, sand
   * and rock, split on SLOPE alone at `slopeThreshold` 0.72 (= 44°). Measured
   * against the shipping heightmaps, mean terrain slope is 19-23°, so sand won
   * 82-98% of every island's surface: one pale tan albedo from the waterline
   * to the summit, which is the "brown lump" the whole island pass started
   * from. Nothing in the material varied with HEIGHT, and there was no green
   * anywhere on an island except the palm fronds.
   *
   * Every SoT island reference (docs/final-full-result-2.webp especially) is
   * banded by elevation, not by slope: a narrow bright sand skirt at the
   * water, a green vegetated mass above it, bare rock where it is too steep to
   * hold anything. Slope still decides rock-vs-cover; this decides sand-vs-
   * cover, and it costs no texture binding (§V40) because the axis is
   * `positionWorld.y` against the waterline uniform that is already bound.
   */
  /** metres above the live water level that sand gives way to ground cover */
  shoreBandHeight: number;
  /** metres over which that handover happens (0 = a painted contour line) */
  shoreBandFade: number;
  /**
   * Wobble (m of elevation) on the sand↔cover handover, and the world
   * frequency (1/m) of that wobble.
   *
   * WHY: the handover keys on `positionWorld.y` against one uniform, so
   * without this it is an exact LEVEL SET of the height field — a contour
   * line, drawn at the same elevation the whole way round every island in the
   * world. That is the "vegetation rings at a fixed elevation" the user
   * spotted and 27a0795 recorded as untouched, and it is the same defect the
   * slope blend already fixes for itself with `slopeNoiseAmount`. A real
   * treeline wanders with soil, shelter and aspect; the cheapest honest stand-
   * in is to let the THRESHOLD wander, which costs one fbm2 and keeps the
   * band's width and its §V23 monotonicity exactly as they were.
   *
   * The amount is in METRES so it reads the same on a flat sandbar and a
   * steep cliff — on a 4° beach 1.6 m of wobble is ~23 m of coastline
   * meander, on a 16° one about 5.6 m, which is the right relationship.
   */
  shoreBandNoise: number;
  shoreBandNoiseScale: number;
  /** lush green — the mass of the island */
  vegBaseColor: number;
  /** darker green in the hollows of the canopy noise */
  vegShadeColor: number;
  /** sun-bleached scrub mixed in on the brightest clumps */
  vegDryColor: number;
  /** canopy clump noise scale (1/m) — sets how big a stand of green reads */
  vegScale: number;
  /** how much of the dry tint the brightest clumps take (0..1) */
  vegDryStrength: number;
  /** normal.y at which cover gives way to bare rock — stricter than sand's,
   *  because scree holds on a slope that a canopy does not */
  vegSlopeThreshold: number;
  vegRoughness: number;

  // -- slope blend (sand on flat, rock on steep) — terrainBlendMaterial -----
  /** normal.y at the sand↔rock midpoint (1 = flat up, 0 = vertical) */
  slopeThreshold: number;
  /** half-width of the smooth blend around the threshold */
  slopeBlendWidth: number;
  /** noise jitter on the blend edge so the border is not a clean line */
  slopeNoiseAmount: number;
}

export const terrainParams: TerrainParams = registerParams(
  'terrain',
  {
    noiseOctaves: 3,
    noiseLacunarity: 2.0,
    noiseGain: 0.5,
    triplanarSharpness: 4.0,

    rockScale: 0.16,
    rockBands: 5,
    rockBandSoftness: 0.45,
    rockBaseColor: 0x9a8f7c,
    // the sunlit rock face shared the sand's problem at S 0.39 — with the
    // low-sun key that is the orange the top-down bug shot is made of
    rockTopColor: 0xc9c2b4,
    rockCreviceColor: 0x55483d,
    rockCreviceScale: 0.05,
    rockCreviceStrength: 0.55,
    rockTopPower: 2.2,
    rockTopStrength: 0.7,
    rockSideDarken: 0.3,
    rockRoughness: 0.92,

    // PALE CREAM, NOT MUSTARD — and the fault was SATURATION, not hue.
    // 0xecd9ab / 0xd0b382 measured H 42.5°/37.7° (already inside the tropical
    // 35-45° window) at S 0.63/0.45, which is 2.5-4x a real beach's 0.10-0.25.
    // `fbm2` is mean-0.5, so the mean sand albedo drawn was rgb(222,198,150) =
    // S 0.52: textbook tan. Two render-time multiplies then push it further —
    // the noon key (0xfff3da) takes S to ~0.59, and the low sun (0xff9440,
    // linear (1.0,0.30,0.05)) takes it to H 25.5° / S 0.74, which is why the
    // sunset shots read as terracotta rather than merely warm. Post `vibrance`
    // 0.18 acts hardest in exactly this saturation range. So these are
    // authored at the BOTTOM of the target band and let the light warm them.
    sandBaseColor: 0xe2ded5,
    sandShadeColor: 0xcec5b6,
    sandShadeScale: 0.045,
    sandGrainScale: 14,
    sandGrainStrength: 0.1,
    sparkleDensity: 6,
    sparkleCoverage: 0.06,
    sparklePower: 26,
    sparkleStrength: 1.4,
    sandRoughnessDry: 0.95,
    sandRoughnessWet: 0.3,

    rippleStrength: 0.18,
    rippleWavelength: 0.55,
    rippleDepthFade: 16,
    rippleAngle: 24,
    rippleBend: 0.7,
    rippleBendScale: 0.035,

    waterline: 0.0,
    wetBand: 1.4,
    wetDarken: 0.35,

    runupEnabled: true,
    runupPeriod: 8.5,
    runupRiseFraction: 0.32,
    runupHeightMin: 0.35,
    runupHeightMax: 1.5,
    runupSwellResponse: 0.55,
    runupPhaseScale: 0.012,
    runupSheetFeather: 0.12,
    sheetColor: 0x2fb9ae,
    sheetStrength: 0.55,
    swashFoamWidth: 0.22,
    swashFoamColor: 0xf4fbf7,
    swashFoamStrength: 1.0,
    swashResidualStrength: 0.45,
    swashFoamNoiseScale: 0.6,
    swashFoamNoiseStrength: 0.7,
    dryTime: 11,
    receiveCaustics: true,
    causticsWaterlineBand: 0.6,

    shoreBandHeight: 3.2,
    shoreBandFade: 4.5,
    shoreBandNoise: 1.6,
    shoreBandNoiseScale: 0.012,
    // THE SECOND HALF OF 27a0795's COLOUR PASS, AND THE HALF THE USER ACTUALLY
    // SEES. That commit desaturated sand (S 0.63 → 0.06) and rock (S 0.39 →
    // 0.10) and left this layer alone, so the three greens shipped at HSV
    // S 0.57 / 0.49 / 0.49 — five to ten times the band sand and rock were
    // deliberately authored into. Ground cover is also the layer with the most
    // screen area by far: `shoreBandHeight` 3.2 m puts sand in a skirt while
    // everything above it is cover, so from a ship the island IS this palette.
    // Hence "green and yellow": 0x5f8f3e is a fairway green and 0x9aa855 is
    // a highlighter yellow-green at H 65°, and the same two render-time
    // multiplies 27a0795 measured on sand (noon key ×1.15, low sun to S 0.74,
    // post `vibrance` 0.18 biting hardest in exactly this range) act here too.
    //
    // Authored at the BOTTOM of the band on the same rule as sand, and with
    // VALUE rather than CHROMA carrying the sand↔scrub↔canopy read: a real
    // tropical island from a mile off is olive and khaki, not lime.
    // HOW FAR DOWN, AND WHY NOT FURTHER — this was measured in the browser and
    // the first attempt OVERSHOT. Authored at S 0.30 with the hue pulled to a
    // yellow-olive 78°, the cover mass rendered GREY-PURPLE, not green: a
    // low-chroma yellow-olive has barely more green than the blue sky fill has
    // blue, so the ambient wins and the residual reads violet. Saturation is
    // not a free axis here — the fill light sets a floor under how little
    // chroma an albedo can carry and still keep its hue.
    //
    // So the landing is a ~30% cut rather than the ~47% that went purple, with
    // the HUE moved toward a truer green (86-104°, from 96°/93°) instead. Hue
    // costs nothing against a blue fill; chroma is what was buying the lurid.
    // base  S 0.566 → 0.394, H 96° → 86°, and darker (V 0.56 → 0.52): a mass
    //       reads by being darker than the beach, not by being greener
    vegBaseColor: 0x6d8450,
    // shade S 0.489 → 0.354, and bluer-green at 104° — the hollows between
    //       canopy clumps are where the sky fill dominates, so this is the one
    //       that must not be allowed to neutralise
    vegShadeColor: 0x47603e,
    // dry   S 0.494 → 0.325 and H 65° → 57°: sun-bleached grass is KHAKI. This
    //       is the single most yellow thing on the island and it is the "yellow"
    //       in the report.
    vegDryColor: 0xa3a06e,
    vegScale: 0.055,
    // 0.45 of a lurid yellow was the top note of the whole island; at the new
    // khaki it can stay generous without shouting, but the clumps read better
    // when the dry tint is a highlight rather than half the surface
    vegDryStrength: 0.35,
    vegSlopeThreshold: 0.82,
    vegRoughness: 0.88,

    slopeThreshold: 0.72,
    slopeBlendWidth: 0.1,
    slopeNoiseAmount: 0.12,
  },
  terrainParamsMeta(),
);

function terrainParamsMeta(): Partial<Record<keyof TerrainParams, ParamMeta>> {
  return {
    noiseOctaves: { min: 2, max: 4, step: 1 },
    noiseLacunarity: { min: 1.5, max: 3, step: 0.1 },
    noiseGain: { min: 0.2, max: 0.8, step: 0.05 },
    triplanarSharpness: { min: 1, max: 12, step: 0.5 },
    rockScale: { min: 0.02, max: 1, step: 0.01 },
    rockBands: { min: 2, max: 10, step: 1 },
    rockBandSoftness: { min: 0, max: 1, step: 0.05 },
    rockCreviceScale: { min: 0.01, max: 0.5, step: 0.005 },
    rockCreviceStrength: { min: 0, max: 1, step: 0.05 },
    rockTopPower: { min: 0.5, max: 8, step: 0.1 },
    rockTopStrength: { min: 0, max: 1, step: 0.05 },
    rockSideDarken: { min: 0, max: 1, step: 0.05 },
    rockRoughness: { min: 0, max: 1, step: 0.01 },
    sandShadeScale: { min: 0.005, max: 0.5, step: 0.005 },
    sandGrainScale: { min: 1, max: 60, step: 1 },
    sandGrainStrength: { min: 0, max: 0.5, step: 0.01 },
    sparkleDensity: { min: 0.5, max: 30, step: 0.5 },
    sparkleCoverage: { min: 0, max: 0.5, step: 0.01 },
    sparklePower: { min: 2, max: 128, step: 1 },
    sparkleStrength: { min: 0, max: 4, step: 0.05 },
    sandRoughnessDry: { min: 0, max: 1, step: 0.01 },
    sandRoughnessWet: { min: 0, max: 1, step: 0.01 },
    rippleStrength: { min: 0, max: 0.6, step: 0.01 },
    rippleWavelength: { min: 0.1, max: 4, step: 0.05 },
    rippleDepthFade: { min: 1, max: 45, step: 0.5 },
    rippleAngle: { min: 0, max: 180, step: 1 },
    rippleBend: { min: 0, max: 3, step: 0.05 },
    rippleBendScale: { min: 0.005, max: 0.3, step: 0.005 },
    waterline: { min: -5, max: 5, step: 0.05 },
    wetBand: { min: 0, max: 5, step: 0.05 },
    wetDarken: { min: 0, max: 1, step: 0.05 },
    causticsWaterlineBand: { min: 0.05, max: 5, step: 0.05 },
    runupPeriod: { min: 2, max: 25, step: 0.1 },
    runupRiseFraction: { min: 0.05, max: 0.8, step: 0.01 },
    runupHeightMin: { min: 0, max: 4, step: 0.05 },
    runupHeightMax: { min: 0, max: 8, step: 0.05 },
    runupSwellResponse: { min: 0, max: 2, step: 0.05 },
    runupPhaseScale: { min: 0.001, max: 0.1, step: 0.001 },
    runupSheetFeather: { min: 0.01, max: 1, step: 0.01 },
    sheetStrength: { min: 0, max: 1, step: 0.01 },
    swashFoamWidth: { min: 0.02, max: 1.5, step: 0.01 },
    swashFoamStrength: { min: 0, max: 3, step: 0.05 },
    swashResidualStrength: { min: 0, max: 1, step: 0.01 },
    swashFoamNoiseScale: { min: 0.05, max: 4, step: 0.05 },
    swashFoamNoiseStrength: { min: 0, max: 1, step: 0.01 },
    dryTime: { min: 0.5, max: 60, step: 0.5 },
    shoreBandHeight: { min: 0, max: 40, step: 0.1 },
    shoreBandFade: { min: 0.1, max: 40, step: 0.1 },
    shoreBandNoise: { min: 0, max: 8, step: 0.1 },
    shoreBandNoiseScale: { min: 0.002, max: 0.1, step: 0.001 },
    vegScale: { min: 0.005, max: 0.4, step: 0.005 },
    vegDryStrength: { min: 0, max: 1, step: 0.01 },
    vegSlopeThreshold: { min: 0.2, max: 0.99, step: 0.01 },
    vegRoughness: { min: 0, max: 1, step: 0.01 },
    slopeThreshold: { min: 0.2, max: 0.95, step: 0.01 },
    slopeBlendWidth: { min: 0.01, max: 0.4, step: 0.01 },
    slopeNoiseAmount: { min: 0, max: 0.5, step: 0.01 },
  };
}
