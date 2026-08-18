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
  /**
   * §B.43. Sparkle cells are sized from the PIXEL, not from the world: this
   * is how many pixels a cell targets, so glints stay a fixed size on screen
   * at every distance and every view angle. The old `sparkleDensity` (cells
   * per metre) could only ever be right at one distance — at 6/m its 0.167 m
   * cell was ~11 px from the deck and a quarter of a pixel at 300 m. Same
   * name, same meaning and same default as the ocean's sun glitter, which is
   * the model this was transliterated from.
   */
  sparkleCellPixels: number;
  /** floor on the cell size (m), so cells cannot collapse up close */
  sparkleMinCell: number;
  /** glint radius in pixels, AT THE TOP OF AN OCTAVE (see §V.48b note) */
  sparkleRadiusPixels: number;
  /** cell radii across below which a glint stops being a distinguishable point */
  sparkleResolveCells: number;
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
  /**
   * DOMAIN WARP of the ripple phase, in WAVELENGTHS. This is the parameter
   * that decides whether crests are sinuous and BIFURCATE or whether the bed
   * is corduroy — under ~0.5 the field is a wobbled grating, and a grating is
   * what the user called "a perfectly regular shape and grid".
   */
  rippleWarp: number;
  /** world frequency (1/m) of the warp; a second octave rides at 2.7× this */
  rippleWarpScale: number;
  /**
   * How much of the carrier is the DEPTH CONTOUR rather than the fixed
   * bearing (0 = one global direction, 1 = crests follow the contours).
   * A UNIFORM, deliberately: making this spatial would put the 912 m world
   * coordinate back behind a varying multiplier — the `50c3a76` lever arm.
   */
  rippleContourWeight: number;
  /** metres of DEPTH per crest for the contour term (sets contour spacing) */
  rippleContourSpacing: number;
  /** world frequency (1/m) of the patchiness that removes ripples entirely */
  ripplePatchScale: number;
  /** noise value a patch must beat to carry ripples at all */
  ripplePatchThreshold: number;

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

  // -- ground cover GEOMETRY (terrain/groundCoverMesh.ts, §V43) --------------
  // Instanced grass tufts and shrubs: the silhouette layer between the sand
  // and the palms. Two draw calls per island, LOD-gated to nothing past
  // `coverCullDistance` — see the cost note at the top of that file.
  /** blades in one grass tuft */
  grassBlades: number;
  /** length segments per blade (silhouette smoothness of the bend) */
  grassSegments: number;
  grassHeight: number;
  grassWidth: number;
  /** how far a blade tip leans out from its root (m at scale 1) */
  grassBend: number;
  /** jittered-grid cell size (m) for grass candidates */
  grassSpacing: number;
  /** fraction of candidate cells that even try — thins without regularising */
  grassDensity: number;
  /** clump-noise value a cell must beat (0.5 = half the island) */
  grassClumpThreshold: number;
  /** leaf domes in one shrub */
  shrubLobes: number;
  shrubRings: number;
  shrubSegments: number;
  shrubRadius: number;
  /** vertical squash of a leaf dome (1 = hemisphere) */
  shrubSquash: number;
  /** blades round the base of a shrub, so its edge is not a clean dome */
  shrubSkirtBlades: number;
  shrubSpacing: number;
  shrubDensity: number;
  shrubClumpThreshold: number;
  /**
   * Lowest ground cover grows on, as a fraction of `shoreBandHeight`. Keyed to
   * the sand skirt rather than given its own metre value so the fringe starts
   * exactly where the painted sand hands over to green — two independent
   * numbers would drift and leave tufts standing in sand.
   */
  coverMinHeightFraction: number;
  /** highest ground cover grows on (m above the waterline) */
  coverMaxHeight: number;
  /** max terrain gradient |∇h| (m/m) cover accepts */
  coverSlopeLimit: number;
  /** clump-noise world frequency (1/m) — sets how big a stand of grass reads */
  coverClumpScale: number;
  coverScaleMin: number;
  coverScaleMax: number;
  /** camera distance (m) past which the whole cover set stops drawing */
  coverCullDistance: number;
  /** tip displacement (m) at full wind and weight 1 */
  coverSwayAmplitude: number;
  coverSwaySpeed: number;
  /** how strongly the per-plant phase decorrelates the gust */
  coverSwayGust: number;
  coverBaseColor: number;
  coverTipColor: number;
  coverDryColor: number;
  /** albedo multiplier at the root — the contact-shadow cue */
  coverRootDarken: number;
  coverRoughness: number;

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
    sparkleCellPixels: 2.6,
    /**
     * THE FLOOR IS NOT A TASTE VALUE — IT IS THE CLOSEST VIEW YOU SUPPORT.
     *
     * Below it the cell stops tracking the pixel and goes world-locked again,
     * which is the ORIGINAL §B.43 defect at short range. A first pass here
     * used 2 cm on the reasoning that "sand is not water and the camera gets
     * closer to a beach"; `tests/terrain.test.ts` caught it immediately — at
     * 3 m that floor puts the cell back at 13 px, i.e. exactly the fat bright
     * dots the user reported, just nearer.
     *
     * The reasoning was backwards. A coarser floor does not buy nearness, it
     * SPENDS it: the floor must sit BELOW `pixWorld · cellPixels` at the
     * closest view, and closer views need a SMALLER floor. At 1.5 m (standing
     * on the sand) that is 2 mm. Which is also, conveniently, about the size
     * of a grain of sand.
     */
    sparkleMinCell: 0.002,
    sparkleRadiusPixels: 0.8,
    sparkleResolveCells: 2.0,
    sparkleCoverage: 0.06,
    sparklePower: 26,
    sparkleStrength: 1.4,
    sandRoughnessDry: 0.95,
    sandRoughnessWet: 0.3,

    rippleStrength: 0.22,
    /**
     * DUNE SCALE, NOT RIPPLE SCALE, and the choice is deliberate.
     *
     * Real wave-formed ripples in fine sand at these depths run 0.05-0.2 m.
     * The shipped 0.55 m was already a compromise between that and legibility
     * and it still read as "super tiny dunes … in a perfectly regular grid":
     * from the deck at 40 m one pixel spans ~0.02 m head-on and ~0.2 m at the
     * grazing angles a seabed is actually seen at, so 0.55 m is 3-25 px — the
     * exact band where a regular pattern turns into moiré rather than into
     * texture.
     *
     * 1.4 m is chosen from what is LEGIBLE at the distances in the user's
     * screenshots: 7-70 px over the same range, i.e. always a resolved
     * bedform. That makes these dune-scale features rather than ripples,
     * which is the right call for a seabed seen through water from a deck —
     * the true fine ripples would have to live in a normal map that
     * band-limits away, and there is no sampler budget for one (§V40).
     */
    rippleWavelength: 1.4,
    rippleDepthFade: 16,
    rippleAngle: 24,
    // 0.9 wavelengths of warp is above the threshold where the phase field
    // develops dislocations, which is what makes a crest split in two
    rippleWarp: 0.9,
    // 0.09 → an 11 m warp wavelength, ~8 ripple wavelengths: long enough that
    // a crest wanders for a while before it branches, short enough that it
    // branches at all
    rippleWarpScale: 0.09,
    rippleContourWeight: 0.45,
    rippleContourSpacing: 0.35,
    ripplePatchScale: 0.035,
    ripplePatchThreshold: 0.38,

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
    /**
     * ── THE PURPLE PATCHES, AND WHY RECOLOURING ALONE WAS NEVER THE FIX ────
     *
     * The user reported "weird purple, sometimes red patches" marching over
     * the land. It was attributed to a cloud-shadow packing bug, then to the
     * ocean drawing over sand, then to these three colours being wrong. The
     * third is closest but still not right, and the difference matters:
     *
     * MEASURED IN THE BROWSER, on this branch, at the showcase lagoon. With
     * the three veg colours forced to BLACK the patches render SATURATED
     * BLUE; forced to red they render magenta; forced to a bright saturated
     * yellow-green they render blue-grey. A colour that cannot be removed by
     * setting the albedo to zero is not the albedo. Also eliminated, each by
     * disabling it and re-looking: the ocean surface mesh, the clouds, the
     * caustics bounce fill (`maxAddLight` and `bounceStrength` both zeroed),
     * the caustics waterline band, the terrain material's `emissiveNode`, its
     * `outputNode` (aerial haze), and every unnamed mesh in the scene.
     *
     * WHAT IT ACTUALLY IS: a GRAZING-ANGLE SPECULAR reflection of the sky.
     * The tell is view dependence — from directly overhead the patches nearly
     * vanish, and from the deck at grazing incidence they cover whole
     * hillsides. Fresnel rises to 1 at grazing, so a dark, not-quite-rough
     * surface reflects the sky almost perfectly; the sand next to it has the
     * same specular but an albedo bright enough to swamp it, which is exactly
     * why forcing `shoreBandHeight = 400` (everything into the sand branch)
     * made them "vanish" and sent the diagnosis to the colours.
     *
     * So the cure is VALUE and ROUGHNESS, not hue and not chroma:
     * the diffuse term has to out-compete the grazing specular, and the
     * specular lobe has to be spread. Raised in value from V 0.52 → 0.66 and
     * given back some chroma, with `vegRoughness` taken to 1.0 below.
     * Verified on screen at the lagoon: the patches are gone.
     *
     * This does NOT contradict ffeb839's lesson that saturation is not a free
     * axis — it adds the other half. Chroma has a floor set by the sky fill;
     * VALUE has one set by the grazing specular. `ffeb839` desaturated sand
     * to S 0.06 and rock to S 0.10 safely because both are bright.
     */
    vegBaseColor: 0x89a94e,
    // shade S 0.489 → 0.354, and bluer-green at 104° — the hollows between
    //       canopy clumps are where the sky fill dominates, so this is the one
    //       that must not be allowed to neutralise
    vegShadeColor: 0x647f3a,
    // dry   S 0.494 → 0.325 and H 65° → 57°: sun-bleached grass is KHAKI. This
    //       is the single most yellow thing on the island and it is the "yellow"
    //       in the report.
    vegDryColor: 0xc4b76a,
    vegScale: 0.055,
    // 0.45 of a lurid yellow was the top note of the whole island; at the new
    // khaki it can stay generous without shouting, but the clumps read better
    // when the dry tint is a highlight rather than half the surface
    vegDryStrength: 0.35,
    vegSlopeThreshold: 0.82,
    /**
     * 1.0, AND IT IS HALF OF THE PURPLE-PATCH FIX (see the colours above).
     *
     * At 0.88 the ground-cover branch still has a tight enough specular lobe
     * that at GRAZING incidence — which is every view from a deck — Fresnel
     * lifts the sky's reflection over a dark albedo and the ground turns
     * blue. Measured in the browser: dropping this to 1.0 alone visibly
     * desaturates the patches; 1.0 plus the brighter albedo removes them.
     * Vegetation is the roughest thing on an island anyway.
     */
    vegRoughness: 1.0,

    grassBlades: 7,
    grassSegments: 3,
    grassHeight: 0.55,
    grassWidth: 0.085,
    grassBend: 0.3,
    // 3 m cells over a 520 m box is ~30k candidates on the showcase island;
    // the gates take it to ~2-3k tufts. Cheap on CPU (a bilinear heightAt per
    // candidate) and irrelevant on GPU — 42 triangles each, one draw call.
    grassSpacing: 3.0,
    grassDensity: 0.55,
    // 0.52 against a mean-0.5 fbm: a little under half the ground, in stands.
    // The references have genuinely bare sand between the green, not a lawn.
    grassClumpThreshold: 0.52,
    shrubLobes: 3,
    shrubRings: 3,
    shrubSegments: 7,
    shrubRadius: 0.75,
    shrubSquash: 0.8,
    shrubSkirtBlades: 5,
    shrubSpacing: 9.0,
    shrubDensity: 0.5,
    // stricter than grass: shrubs sit in the HEART of a stand, so the two
    // species read as one graded mass rather than as two scattered layers
    shrubClumpThreshold: 0.6,
    coverMinHeightFraction: 0.85,
    coverMaxHeight: 40,
    coverSlopeLimit: 0.7,
    // 0.02 → a 50 m base wavelength: stands the size of a clearing, which is
    // what the references show. Coarser than `vegScale` (18 m) on purpose —
    // the albedo clumps are the texture inside these stands.
    coverClumpScale: 0.02,
    coverScaleMin: 0.7,
    coverScaleMax: 1.55,
    // measured to the island CENTRE (same convention as every other island
    // LOD), and the showcase anchorage is ~330 m out from a 260 m island, so
    // this has to clear both to be visible from the deck at anchor.
    coverCullDistance: 550,
    coverSwayAmplitude: 0.1,
    coverSwaySpeed: 1.6,
    coverSwayGust: 1.0,
    // §ffeb839: the variation between these three moves HUE and VALUE, not
    // chroma. A low-saturation yellow-olive renders grey-purple under this
    // sky's blue fill — the fill sets a floor on how little chroma an albedo
    // can carry and keep its hue, and grass is the thing most tempting to
    // desaturate "for realism".
    coverBaseColor: 0x6f8f47,
    coverTipColor: 0xa2c05d,
    coverDryColor: 0xc0ae68,
    coverRootDarken: 0.52,
    coverRoughness: 0.9,

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
    sparkleCellPixels: { min: 1, max: 8, step: 0.1 },
    sparkleMinCell: { min: 0.002, max: 0.5, step: 0.002 },
    sparkleRadiusPixels: { min: 0.3, max: 2.5, step: 0.05 },
    sparkleResolveCells: { min: 1, max: 6, step: 0.1 },
    sparkleCoverage: { min: 0, max: 0.5, step: 0.01 },
    sparklePower: { min: 2, max: 128, step: 1 },
    sparkleStrength: { min: 0, max: 4, step: 0.05 },
    sandRoughnessDry: { min: 0, max: 1, step: 0.01 },
    sandRoughnessWet: { min: 0, max: 1, step: 0.01 },
    rippleStrength: { min: 0, max: 0.6, step: 0.01 },
    rippleWavelength: { min: 0.1, max: 4, step: 0.05 },
    rippleDepthFade: { min: 1, max: 45, step: 0.5 },
    rippleAngle: { min: 0, max: 180, step: 1 },
    rippleWarp: { min: 0, max: 3, step: 0.05 },
    rippleWarpScale: { min: 0.005, max: 0.4, step: 0.005 },
    rippleContourWeight: { min: 0, max: 1, step: 0.05 },
    rippleContourSpacing: { min: 0.05, max: 3, step: 0.05 },
    ripplePatchScale: { min: 0.005, max: 0.3, step: 0.005 },
    ripplePatchThreshold: { min: 0, max: 0.9, step: 0.02 },
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
    grassBlades: { min: 1, max: 16, step: 1 },
    grassSegments: { min: 1, max: 6, step: 1 },
    grassHeight: { min: 0.1, max: 2, step: 0.05 },
    grassWidth: { min: 0.02, max: 0.3, step: 0.005 },
    grassBend: { min: 0, max: 1, step: 0.02 },
    grassSpacing: { min: 1, max: 12, step: 0.25 },
    grassDensity: { min: 0, max: 1, step: 0.05 },
    grassClumpThreshold: { min: 0, max: 1, step: 0.01 },
    shrubLobes: { min: 1, max: 6, step: 1 },
    shrubRings: { min: 1, max: 6, step: 1 },
    shrubSegments: { min: 3, max: 12, step: 1 },
    shrubRadius: { min: 0.2, max: 3, step: 0.05 },
    shrubSquash: { min: 0.3, max: 1.5, step: 0.05 },
    shrubSkirtBlades: { min: 0, max: 12, step: 1 },
    shrubSpacing: { min: 2, max: 30, step: 0.5 },
    shrubDensity: { min: 0, max: 1, step: 0.05 },
    shrubClumpThreshold: { min: 0, max: 1, step: 0.01 },
    coverMinHeightFraction: { min: 0, max: 2, step: 0.05 },
    coverMaxHeight: { min: 1, max: 120, step: 1 },
    coverSlopeLimit: { min: 0.1, max: 2, step: 0.05 },
    coverClumpScale: { min: 0.002, max: 0.2, step: 0.002 },
    coverScaleMin: { min: 0.2, max: 3, step: 0.05 },
    coverScaleMax: { min: 0.2, max: 4, step: 0.05 },
    coverCullDistance: { min: 50, max: 2000, step: 25 },
    coverSwayAmplitude: { min: 0, max: 0.6, step: 0.01 },
    coverSwaySpeed: { min: 0, max: 6, step: 0.1 },
    coverSwayGust: { min: 0, max: 4, step: 0.1 },
    coverRootDarken: { min: 0, max: 1, step: 0.02 },
    coverRoughness: { min: 0, max: 1, step: 0.01 },
    slopeThreshold: { min: 0.2, max: 0.95, step: 0.01 },
    slopeBlendWidth: { min: 0.01, max: 0.4, step: 0.01 },
    slopeNoiseAmount: { min: 0, max: 0.5, step: 0.01 },
  };
}
