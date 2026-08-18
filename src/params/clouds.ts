/**
 * Cloud tunables (§V16: every tunable lives in a params module, no shader
 * magic constants). Consumed by src/clouds/* (§V11, §V11b).
 *
 * TERMINOLOGY, since it changed with §V11b:
 *   LOBE  — a polygonal core. A noise-displaced icosphere, instanced. Lobes
 *           are what carry the SILHOUETTE: a union of faceted, bumpy solids
 *           reads as sculpted form. Billboards never can (§V11b).
 *   FLUFF — one soft billboard riding each lobe. Only there to feather the
 *           polygonal rim, per the talk's "billboards for 'fluff'".
 *
 * SHAPE IS PARAMETRIC ON PURPOSE (§V7). Calm cumulus and a storm anvil are
 * the same generator at different `silhouette*` values — there is no storm
 * code path. See `silhouetteRadius()` in src/clouds/cloudCores.ts.
 *
 * COLOUR AUTHORING CONTRACT, same as src/params/sky.ts: hexes are sRGB and
 * enter the pipeline through THREE.Color (§V31), and they are authored
 * PRE-tonemap (ACESFilmic @ skyParams.exposure), so they sit deeper and more
 * saturated than the number you want on screen.
 */
import { registerParams, type ParamMeta } from './registry';

export interface CloudParams {
  /** offscreen cores/blur target size (px) — blur hides the low res */
  rtWidth: number;
  rtHeight: number;

  // -- layout: changing any of these regenerates the lobe set ---------------
  /** number of cumulus clusters placed on the ring around origin */
  clusterCount: number;
  /** polygonal lobes per cluster, inclusive bounds */
  lobesMin: number;
  lobesMax: number;
  /** cluster placement ring (m, world XZ around origin) */
  ringInner: number;
  ringOuter: number;
  /** cluster BASE altitude range (m) — the cloud grows upward from here */
  altitudeMin: number;
  altitudeMax: number;
  /** cluster footprint radius range (m) */
  clusterRadiusMin: number;
  clusterRadiusMax: number;
  /** horizontal stretch of clusters (cumulus are wider than tall) */
  clusterFlatten: number;
  /** vertical extent as a multiple of cluster radius — >1 builds towers */
  clusterHeight: number;
  /** lobe radius as a fraction of the cluster radius */
  lobeScaleMin: number;
  lobeScaleMax: number;
  /** lobe vertical/horizontal radius ratio (<1 = squashed, cumulus-like) */
  lobeOblate: number;
  /** lobe height distribution exponent: >1 packs lobes near the base */
  heightBias: number;
  /** radial packing exponent for lobes inside a cluster. BELOW 1 spreads them
   *  to the rim (0.6 ≈ uniform over the disc's area — that is what made a
   *  cluster read as separated potatoes); ABOVE 1 packs them toward the centre
   *  so the union merges into one mass. */
  lobePacking: number;

  // -- silhouette profile: r(h), 0..1 radius at normalized height h --------
  /** how fast the mass rounds off toward the top (low = domed, high = flat) */
  domeExponent: number;
  /** trunk width at/above `waistHeight` (1 = no waist, low = anvil stalk) */
  waistWidth: number;
  /** normalized height by which the trunk has narrowed to `waistWidth` */
  waistHeight: number;
  /** normalized height where the anvil cap starts flaring out */
  anvilStart: number;
  /** normalized height where the cap rounds back in toward the top */
  capRound: number;
  /** how far the anvil cap overhangs (0 = plain cumulus, 1+ = mushroom) */
  anvilSpread: number;

  // -- the STORM END of the same family (§V46) -----------------------------
  // A cluster blends from the values above toward these by its own local
  // storm strength, sampled at its own world XZ. Fair weather and a squall
  // therefore coexist in ONE sky with ONE code path (§V7).
  /** vertical extent multiplier at storm 1 — the tower */
  stormClusterHeight: number;
  /** lobe height distribution at storm 1 (1 = spread evenly up the column) */
  stormHeightBias: number;
  /** dome exponent at storm 1 (high = stays full width, reads as a column) */
  stormDomeExponent: number;
  /** trunk width at storm 1 — the anvil's stalk */
  stormWaistWidth: number;
  /** cap overhang at storm 1 — what makes it a monument, not a big cumulus */
  stormAnvilSpread: number;
  /** cluster footprint multiplier at storm 1 */
  stormRadiusScale: number;
  /** how far the base drops (fraction of its fair-weather altitude) — a
   *  monument sits ON the horizon, it does not float above it */
  stormBaseDrop: number;
  /** lobe radius multiplier at storm 1, relative to the (bigger) cluster */
  stormLobeScale: number;
  /** 0..1 how much of the SUN term a storm cluster loses (multiplicative) */
  stormSunCut: number;
  /** 0..1 how much of the SKY term it loses — keep well under stormSunCut or
   *  the cloud goes black instead of cool grey */
  stormSkyCut: number;
  /** field sampling quantisation: how many discrete storm levels a cluster
   *  can take. The field drifts continuously; this is what stops it
   *  regenerating the lobe set on every single frame. */
  stormQuantSteps: number;
  /** 0..1 how much of the SUN AND SKY a storm cluster's UNDERSIDE loses on
   *  top of the whole-cluster cuts. The single strongest "it is about to
   *  rain" cue: an optically thick cloud scatters its light out of the TOP,
   *  so the base goes dark while the anvil stays bright. Scales with the
   *  cluster's own storm strength × (1 − height), so fair weather is
   *  untouched and only the bottom of a squall darkens. */
  stormBaseDark: number;

  // -- CELL-ANCHORED STORM CLOUD (§V.63) ------------------------------------
  // The ring above places clouds on hashed sites around the world ORIGIN. A
  // squall's cloud has to stand on the squall, so storm clusters are placed
  // from the storm field's own cell list instead. See cloudCores.ts.
  /** lattice radius of the cell walk around the CAMERA: 2 → 5×5 squares */
  stormCellRange: number;
  /** cluster footprint as a fraction of its cell's radius. Must be at or
   *  above the fraction of the radius at which the field passes
   *  weatherParams.rainThreshold (0.78 at the shipped values) or rain falls
   *  in a ring OUTSIDE the cloud that produced it — see the default. */
  stormCellRadius: number;
  /** minimum cell amplitude that gets a cloud at all. Keep BELOW the
   *  weather rainThreshold or rain can start under a cell with no cloud. */
  stormCellMin: number;
  /** lobes per cell cluster, inclusive — these are far bigger masses than a
   *  ring cumulus and need the count to hold together */
  stormCellLobesMin: number;
  stormCellLobesMax: number;

  // -- RAIN SHAFTS (§V.63) --------------------------------------------------
  /** how many nearest storm clusters get a shaft. Unrolled in the shader, so
   *  this is a COMPILE-time count: changing it needs a reload. */
  shaftCount: number;
  /** 0..1 peak opacity of a shaft seen through its own thickest chord */
  shaftOpacity: number;
  /** chord length (m) at which a shaft reaches ~63% of its peak opacity */
  shaftDensityLength: number;
  /** shaft footprint as a fraction of the CLUSTER's own radius (<1: the
   *  visible column falls from the core of a cell, not from its soft rim) */
  shaftRadius: number;
  /** 0..1 how far the shaft fades out toward the sea surface — virga that
   *  never quite lands reads better than a column with a cut-off bottom */
  shaftGroundFade: number;
  /** brightness multiplier on skyColor for the shaft body */
  shaftTint: number;
  /** radial falloff exponent across the column. Higher = a tighter core with
   *  a softer margin; this, NOT the chord, is what gives a shaft its edge —
   *  see the note in cloudComposite.ts. */
  shaftEdge: number;
  /** fraction of the shaft's height over which it dissolves INTO the cloud
   *  base. Without it the flat top of the slab draws a straight horizontal
   *  line wherever the (bumpy) cloud sits higher than `base`. */
  shaftTopFade: number;

  /** instance capacity — read once at construction, reload to change (§V28) */
  maxLobes: number;
  /** icosphere subdivision per lobe — read once at construction (0..3) */
  lobeDetail: number;

  // -- lobe surface + shading (live uniforms) ------------------------------
  /** radial noise displacement amplitude (0..1) — the cauliflower relief */
  lobeRelief: number;
  /** spatial frequency of that relief on the unit lobe */
  lobeReliefScale: number;
  /**
   * Exponent on the OPTICAL CHORD. `|N·V|` at the smooth ellipsoid is exactly
   * `sqrt(1-u²)` at projected radius `u`, i.e. half the chord a ray cuts
   * through a uniform-density sphere — so **1 is the physical answer** and
   * gives a lobe the density profile of the volume it stands for. Above 1
   * concentrates density toward the core (a fuzzier, more diffuse lobe).
   *
   * REPLACED `rimSoftness`, which was `smoothstep(0, 0.42, |N·V|)` and
   * therefore SATURATED at u ≤ 0.907: 92% of a lobe's projected disc area sat
   * at ≥90% of peak alpha and the 90→10 feather was 0.42 RT px. See the note
   * in cloudCores.ts — a sphere drawn as a hard disc is a disc, and that is
   * the whole of the "small clouds look like small explosions" report.
   */
  lobeChordPower: number;
  /**
   * ABSOLUTE density scale of a lobe, under the preset-driven `coverage`.
   * This is what lets optical depth accumulate ACROSS overlapping lobes rather
   * than saturating inside one — at the old scale a single lobe already hit
   * alpha 0.80, so 35 of them could only tile, never merge. Kept separate from
   * `coverage` because the weather presets write that one (0.8 clear, 1.0
   * storm) and would overwrite this on every apply.
   */
  lobeDensity: number;
  /** wrapped-diffuse exponent for the sun term (higher = harder terminator) */
  sunPower: number;
  /** 0..1 how much the cluster-level sun-side gradient darkens the far side */
  sunSideGain: number;
  /** 0..1 sun multiplier deep inside the mass — self-shadow (§V44 multiplicative) */
  selfShadow: number;
  /** silver lining: extra rim brightness when the sun is behind the cloud */
  silverLining: number;
  /** skylight (ambient) range from fully downward-facing to fully upward */
  skyMin: number;
  skyMax: number;
  /**
   * 0..1 FLOOR ON THE PRODUCT of the three direct-light attenuations
   * (wrapped diffuse × cluster sun-side × self-shadow), i.e. the isotropic
   * multiple-scattering component a single-scattering model has no way to
   * produce. Measured before it existed: a buried, down-facing, far-side lobe
   * received 1.8% of the key and rendered at px 87,60,37 against a sky at
   * 213,149,135 — the "dark and gloomy" report, and the mechanical reason the
   * clouds read as brown lumps from underneath.
   *
   * A FLOOR ON THE PRODUCT, not on any one term (§V.56): each of the three is
   * individually defensible and each one, lowered alone, flattens the clouds a
   * different way. Real cloud-base reflectance is 30-60% of the top.
   */
  multiScatterFloor: number;
  /** warm uplight added to the SUNLIGHT channel on downward-facing faces when
   *  the key is near the horizon — the glowing underside of a sunset cumulus.
   *  Rides sunColor, which is already the haze-warmed key, so it needs no
   *  third colour slot (§V40 untouched). */
  baseGlow: number;
  /** sin(elevation) span over which that uplight fades out as the key climbs.
   *  0.38 ≈ 22°: above that the sun no longer reaches under the deck. */
  baseGlowLowSun: number;

  // -- fluff billboards ----------------------------------------------------
  // The fluff is the ONLY thing that can feather the polygonal rim (§V11b
  // forbids softening the cores themselves). For it to do that at all its
  // sprite must reach PAST the lobe silhouette — see the §V11b test in
  // tests/clouds.test.ts, which pins fluffScale against the lobe's own
  // worst-case projected radius.
  /** fluff sprite radius as a multiple of its lobe's mean radius */
  fluffScale: number;
  /** fluff sprite peak alpha */
  fluffAlpha: number;
  /** fluff sprite falloff exponent (higher = tighter core, softer skirt) */
  fluffPower: number;
  /** 0..1 how far the sprite CENTRE is suppressed. The fluff's job is the
   *  rim; a solid disc would only dilute the lobe's sculpted shading with its
   *  own flat fake-sphere lighting. */
  fluffHollow: number;
  /** r² (0..1 of the sprite) by which that suppression has released — puts
   *  the feather ring at the lobe's own silhouette */
  fluffRing: number;
  /** 0..1 fluff removed toward the TOP of a cluster. Convecting cauliflower
   *  tops are crisp; the dissipating base is not. A cloud that is uniformly
   *  soft reads as fake exactly like one that is uniformly sharp. */
  fluffTopSharp: number;
  /** 0..1 fluff removed on the SUNWARD side, for the same reason */
  fluffSunSharp: number;
  /** 0..1 per-lobe jitter of the fluff sprite radius, so softness is patchy
   *  along a silhouette instead of a uniform halo */
  fluffScaleVary: number;

  // -- edge transmission (user 2026-08-12: "the transmission on the edges of
  // clouds by the sun"). A THIRD light path, neither the sunlit-face term nor
  // ambient skylight: light that goes THROUGH a thin margin and forward-
  // scatters toward the eye. Driven by optical depth (the coverage we already
  // have) and sun alignment, NOT by the silhouette — a screen-space rim would
  // glow the same on a wisp and on an anvil, which is the tell for an outline
  // shader. Costs one vec3 uniform; no new sampler, so no §V40 budget.
  /** peak brightness of the transmitted term, in sunColor units */
  transGain: number;
  /** forward-scattering lobe tightness — high = only near the sun */
  transPower: number;
  /** Beer-Lambert rate against coverage: how fast thickness kills it */
  transDepth: number;

  // -- THE BANDED STRATUS LAYER (src/clouds/cloudBands.ts) ------------------
  // The SECOND cloud form (user 2026-08-13: "more bandy, stretched out,
  // diffused clouds… to break up our existing clouds"). A horizontal sheet at
  // `bandAltitude`, ray-intersected per fragment, written into the SAME packed
  // RT as the cores — so it blurs, composites, colours and reflects through
  // the machinery that already exists. `bandCoverage: 0` switches it off
  // entirely (§V16: a knob, not a code path).
  //
  // THE WHOLE LAYER IS LOW-CONTRAST ON PURPOSE. In the SoT references it
  // covers a third to a half of the frame and carries almost none of the
  // visual weight; the cumulus keeps every bit of it.
  /** 0..1 peak coverage the sheet writes. This is the layer's whole volume
   *  knob — it also bounds how far the sheet can thicken a cumulus SKIRT it
   *  crosses, since the pack is additive. */
  bandCoverage: number;
  /** deck altitude (m). Above the cumulus tops (~900 m at defaults): the
   *  banded layer sits behind and over them, as in the references. */
  bandAltitude: number;
  /** max ray/deck distance (m). Bounds the grazing divide — flooring the
   *  divisor bounds the division, not the quotient (§V44), and an unbounded
   *  coordinate near the horizon is also unbounded aliasing. */
  bandRange: number;
  /** metres below the deck over which the layer fades out as a camera climbs
   *  into it — a freecam above the deck sees nothing, not an inverted sheet */
  bandAboveFade: number;
  /** horizon fade scale, in sin(elevation): `1-exp(-sinElev/this)`. The layer
   *  reaches zero AT the skyline and lets the sky rig's own haze wedge carry
   *  the last couple of degrees; letting the grazing path go opaque instead
   *  would build a grey wall along the horizon (§V30). */
  bandHorizonFade: number;
  /** feature length ALONG the drift axis (m) */
  bandLength: number;
  /** ...and ACROSS it (m). The RATIO is what makes the layer read as bands
   *  rather than as haze — a direction-free field cannot make oriented
   *  features (§V58), so the direction is put in here explicitly. */
  bandWidth: number;
  /** domain warp, in cross-axis feature widths: bends the bands off straight.
   *  Ruled lines are what every "too regular / lattice" complaint in this
   *  project has been (§B.33). */
  bandWarp: number;
  /** gain on the field before it is clamped into a mask — how hard-edged the
   *  bands are against open sky */
  bandContrast: number;
  /** mask offset: how much of the sky is covered AT ALL. This is also the mean
   *  the band-limited field decays toward at grazing angles (§V70), so a
   *  distant pixel sees a smooth uniform sheet rather than nothing. Around
   *  0.05 leaves roughly half the sky open, which is what the references show. */
  bandBias: number;
  /** ≥1 exponent on the mask. Asymmetric falloff — firm shoulder, long
   *  diffuse tail — with no edge function to alias (§V.48). */
  bandGamma: number;
  /** 0..1 the layer's own AREA-MEAN shape — what an infinitely distant pixel
   *  sees once its structure is sub-pixel (§V70). The octave fades take the
   *  FIELD to its mean correctly, but the shape is a clamp and a pow on top of
   *  it and the mean of a nonlinear function is not that function of the mean:
   *  without this the layer converges to bias^gamma ≈ 0.005 and the bands
   *  evaporate a few degrees above the skyline. NOT MEASURED IN-BROWSER YET —
   *  this is the analytic estimate for the shipped contrast/bias/gamma. */
  bandFarMean: number;
  /** sunlight channel level. A thin sheet is lit by light coming THROUGH it,
   *  so this is a transmission level, not a lit-face brightness. */
  bandSunLevel: number;
  /** 0..1 share of that level present away from the sun. Too low and the
   *  layer reads dark and gloomy, which is a standing complaint about the
   *  cores and must not be inherited here. */
  bandAmbientFrac: number;
  /** extra sunlight in the forward-scattering lobe (looking toward the sun) */
  bandForwardGain: number;
  /** tightness of that lobe (higher = only near the sun) */
  bandForwardPower: number;
  /** Beer-Lambert rate on the sheet's OWN thickness: thin margins glow, dense
   *  cores sit a shade under the sky. This is the layer's internal tonal
   *  range, i.e. the difference between a cloud and a wash. */
  bandOptical: number;
  /** 0..1 floor of that attenuation — how dark the thickest core may go */
  bandThickFloor: number;
  /** skylight channel level (nearly flat: a sheet has one orientation) */
  bandSkyLevel: number;
  /** extra skylight toward the horizon, where the line of sight runs the long
   *  way through the sheet */
  bandHorizonLift: number;
  /** drift speed (m/s) of the pattern over the world. ACCUMULATED as a phase,
   *  never `time × rate` (§V.55 — §B.30 is that bug on the flags). */
  bandDriftSpeed: number;
  /** drift heading (degrees, world XZ) — also the band axis */
  bandDriftDirDeg: number;

  /** distance (m) mapped to depth=1 in the RT alpha channel */
  maxCloudDist: number;
  /** 0..1 global cloud density (multiplies every lobe/fluff alpha) */
  coverage: number;
  /** depth-scaled blur radius (px) at depth 0 (near) and depth 1 (far) */
  blurRadiusNear: number;
  blurRadiusFar: number;
  /** edge-distortion noise: cubemap-style lookup scale, scroll speed, uv push */
  distortScale: number;
  distortSpeed: number;
  distortStrength: number;
  /** how strongly the LOW-frequency noise moves the edge threshold (0..1).
   *  Its period is roughly half a cloud, so this wobbles a silhouette as a
   *  whole — it is not what makes an edge fray. */
  edgeErode: number;
  /** the talk's SECOND noise pair (low freq in RG, high freq in BA, blended
   *  by depth). Multiplier on distortScale for the high-frequency octave... */
  edgeHiScale: number;
  /** ...and how far it jitters the edge threshold. This is the fray. Faded
   *  out with distance (far clouds are crisper, talk 00:20:57) and against
   *  its own screen-space footprint (§V48). */
  edgeHiErode: number;
  /** composite alpha gain applied to accumulated coverage */
  alphaGain: number;
  /** exponential opacity rate: alpha = 1 - exp(-alphaDensity * coverage) */
  alphaDensity: number;
  /** WIDTH (in coverage units) of the alpha ramp at depth 0 and depth 1.
   *  This, not the blur radius, is what decides how soft a silhouette reads:
   *  coverage is an additive SUM, so a dense cluster's ramp saturates within
   *  ~1.2 coverage of the edge no matter how wide the blur kernel is. Near
   *  wide / far narrow reproduces "clouds overhead remain soft and fuzzy,
   *  clouds in the distance appear sharper" (talk 00:20:57). */
  alphaSoftNear: number;
  alphaSoftFar: number;
  /** camera-pinned composite quad distance (m) */
  quadDistance: number;
  /** lighting reconstruction colors: color = sunColor*R + skyColor*G */
  sunColor: number;
  skyColor: number;
  /** §T.39 day cycle: 0..1 how far the SKYLIGHT hue follows the live horizon
   *  haze (scene.fog.color). Hue and saturation only — the authored lightness
   *  is pinned, which is what keeps §B.19 from coming back. */
  skyTint: number;
  /** 0..1 the same for the SUNLIGHT, scaled by how warm the light actually
   *  is — at midday the haze is cyan and the sunlit faces must not follow it */
  sunTint: number;
  /** maps the haze's (r-b) in sRGB to that 0..1 warmth */
  paletteWarmthGain: number;
  /** 0..1 how far SATURATION follows the haze, separately from hue — low on
   *  purpose, see cloudPalette.ts */
  paletteSatFollow: number;
  /** 0..1 how far the SUNLIGHT darkens toward the live haze brightness at
   *  full warmth — one-directional, it can never brighten */
  sunDarken: number;
}

const cloudParamsMeta: Partial<Record<keyof CloudParams, ParamMeta>> = {
  clusterCount: { min: 1, max: 32, step: 1 },
  stormClusterHeight: { min: 0.2, max: 6, step: 0.05 },
  stormHeightBias: { min: 0.4, max: 4, step: 0.05 },
  stormDomeExponent: { min: 1, max: 16, step: 0.1 },
  stormWaistWidth: { min: 0.1, max: 1, step: 0.01 },
  stormAnvilSpread: { min: 0, max: 2, step: 0.01 },
  stormRadiusScale: { min: 0.5, max: 4, step: 0.05 },
  stormBaseDrop: { min: 0, max: 0.9, step: 0.01 },
  stormLobeScale: { min: 0.2, max: 2, step: 0.01 },
  stormSunCut: { min: 0, max: 1, step: 0.01 },
  stormSkyCut: { min: 0, max: 1, step: 0.01 },
  stormQuantSteps: { min: 2, max: 64, step: 1 },
  stormBaseDark: { min: 0, max: 1, step: 0.01 },
  stormCellRange: { min: 0, max: 3, step: 1 },
  stormCellRadius: { min: 0.2, max: 1.5, step: 0.01 },
  stormCellMin: { min: 0, max: 1, step: 0.01 },
  stormCellLobesMin: { min: 1, max: 96, step: 1 },
  stormCellLobesMax: { min: 1, max: 96, step: 1 },
  shaftOpacity: { min: 0, max: 1, step: 0.01 },
  shaftDensityLength: { min: 50, max: 4000, step: 10 },
  shaftRadius: { min: 0.1, max: 1.5, step: 0.01 },
  shaftGroundFade: { min: 0, max: 1, step: 0.01 },
  shaftTint: { min: 0, max: 2, step: 0.01 },
  shaftEdge: { min: 0.2, max: 6, step: 0.05 },
  shaftTopFade: { min: 0.02, max: 1, step: 0.01 },
  lobesMin: { min: 1, max: 64, step: 1 },
  lobesMax: { min: 1, max: 64, step: 1 },
  clusterFlatten: { min: 0.4, max: 3, step: 0.05 },
  clusterHeight: { min: 0.2, max: 4, step: 0.05 },
  lobeScaleMin: { min: 0.05, max: 0.6, step: 0.01 },
  lobeScaleMax: { min: 0.05, max: 0.6, step: 0.01 },
  lobeOblate: { min: 0.3, max: 1.5, step: 0.01 },
  heightBias: { min: 0.4, max: 4, step: 0.05 },
  lobePacking: { min: 0.4, max: 3, step: 0.05 },
  domeExponent: { min: 1, max: 12, step: 0.1 },
  waistWidth: { min: 0.1, max: 1, step: 0.01 },
  waistHeight: { min: 0.05, max: 1, step: 0.01 },
  anvilStart: { min: 0.1, max: 0.95, step: 0.01 },
  capRound: { min: 0.5, max: 1, step: 0.01 },
  anvilSpread: { min: 0, max: 2, step: 0.01 },
  lobeDetail: { min: 0, max: 3, step: 1 },
  lobeRelief: { min: 0, max: 0.6, step: 0.01 },
  lobeReliefScale: { min: 0.5, max: 8, step: 0.1 },
  lobeChordPower: { min: 0.3, max: 3, step: 0.05 },
  lobeDensity: { min: 0.05, max: 1.5, step: 0.01 },
  sunPower: { min: 0.5, max: 6, step: 0.05 },
  sunSideGain: { min: 0, max: 1, step: 0.01 },
  selfShadow: { min: 0, max: 1, step: 0.01 },
  silverLining: { min: 0, max: 2, step: 0.01 },
  skyMin: { min: 0, max: 1.5, step: 0.01 },
  skyMax: { min: 0, max: 1.5, step: 0.01 },
  multiScatterFloor: { min: 0, max: 0.8, step: 0.01 },
  baseGlow: { min: 0, max: 2, step: 0.01 },
  baseGlowLowSun: { min: 0.05, max: 1, step: 0.01 },
  fluffScale: { min: 0.5, max: 4, step: 0.05 },
  fluffAlpha: { min: 0, max: 1, step: 0.01 },
  fluffPower: { min: 0.5, max: 4, step: 0.05 },
  fluffHollow: { min: 0, max: 1, step: 0.01 },
  fluffRing: { min: 0.02, max: 1, step: 0.01 },
  fluffTopSharp: { min: 0, max: 1, step: 0.01 },
  fluffSunSharp: { min: 0, max: 1, step: 0.01 },
  fluffScaleVary: { min: 0, max: 0.8, step: 0.01 },
  coverage: { min: 0, max: 1, step: 0.01 },
  bandCoverage: { min: 0, max: 1, step: 0.01 },
  bandAltitude: { min: 400, max: 6000, step: 10 },
  bandRange: { min: 4000, max: 80000, step: 500 },
  bandAboveFade: { min: 50, max: 2000, step: 10 },
  bandHorizonFade: { min: 0.005, max: 0.3, step: 0.005 },
  bandLength: { min: 500, max: 20000, step: 50 },
  bandWidth: { min: 100, max: 4000, step: 10 },
  bandWarp: { min: 0, max: 3, step: 0.05 },
  bandContrast: { min: 0.2, max: 4, step: 0.05 },
  bandBias: { min: -0.5, max: 0.8, step: 0.01 },
  bandGamma: { min: 1, max: 4, step: 0.05 },
  bandFarMean: { min: 0, max: 1, step: 0.01 },
  bandSunLevel: { min: 0, max: 1.5, step: 0.01 },
  bandAmbientFrac: { min: 0, max: 1, step: 0.01 },
  bandForwardGain: { min: 0, max: 2, step: 0.01 },
  bandForwardPower: { min: 1, max: 32, step: 0.5 },
  bandOptical: { min: 0, max: 6, step: 0.05 },
  bandThickFloor: { min: 0, max: 1, step: 0.01 },
  bandSkyLevel: { min: 0, max: 1.5, step: 0.01 },
  bandHorizonLift: { min: 0, max: 1.5, step: 0.01 },
  bandDriftSpeed: { min: 0, max: 20, step: 0.1 },
  bandDriftDirDeg: { min: 0, max: 360, step: 1 },
  blurRadiusNear: { min: 0, max: 16, step: 0.5 },
  blurRadiusFar: { min: 0, max: 16, step: 0.5 },
  distortScale: { min: 0.2, max: 8, step: 0.1 },
  distortSpeed: { min: 0, max: 0.1, step: 0.001 },
  distortStrength: { min: 0, max: 0.15, step: 0.001 },
  edgeErode: { min: 0, max: 1, step: 0.01 },
  edgeHiScale: { min: 1, max: 16, step: 0.1 },
  edgeHiErode: { min: 0, max: 1.5, step: 0.01 },
  alphaGain: { min: 0, max: 4, step: 0.05 },
  alphaDensity: { min: 0.2, max: 6, step: 0.05 },
  alphaSoftNear: { min: 0.05, max: 4, step: 0.05 },
  transGain: { min: 0, max: 3, step: 0.01 },
  transPower: { min: 1, max: 64, step: 0.5 },
  transDepth: { min: 0.1, max: 8, step: 0.05 },
  alphaSoftFar: { min: 0.05, max: 4, step: 0.05 },
  skyTint: { min: 0, max: 1, step: 0.01 },
  sunTint: { min: 0, max: 1, step: 0.01 },
  paletteWarmthGain: { min: 0, max: 4, step: 0.05 },
  paletteSatFollow: { min: 0, max: 1, step: 0.01 },
  sunDarken: { min: 0, max: 1, step: 0.01 },
};

export const cloudParams: CloudParams = registerParams(
  'clouds',
  {
    rtWidth: 768,
    rtHeight: 432,

    // COMPOSITION, re-cut after the measurement that started this pass: the
    // shipped ring put all 11 clusters inside 2.6 km at a mean angular width
    // of 27.7° (largest 50.2° at 1028 m). That is a ceiling of boulders, seen
    // from underneath — which is also why the undersides being unlit mattered
    // so much. The references are mostly DISTANT cloud over a lot of open sky,
    // with one or two near banks carrying the frame.
    clusterCount: 14,
    lobesMin: 30,
    lobesMax: 46,
    ringInner: 2400,
    ringOuter: 9500,
    // bases a little higher, so a distant bank still clears the horizon
    altitudeMin: 520,
    altitudeMax: 980,
    // bigger in METRES but much smaller on screen, because they are further
    // out — and a bigger cluster at the same lobe count has more internal
    // structure to read
    clusterRadiusMin: 260,
    clusterRadiusMax: 620,
    clusterFlatten: 1.35,
    clusterHeight: 0.95,
    // raised with lobePacking so neighbours actually intersect: a cluster has
    // to read as ONE mass with a notched outline, not as a pile of balls
    lobeScaleMin: 0.24,
    lobeScaleMax: 0.40,
    lobeOblate: 0.74,
    heightBias: 1.6,
    lobePacking: 1.35,

    // fair-weather cumulus: wide flat base, rounded cauliflower top, no anvil.
    // waistHeight/anvilStart/capRound are shared with the storm end and are
    // INERT here — waistWidth 0.9 barely narrows and anvilSpread 0 removes
    // the cap entirely, so calm never sees them.
    domeExponent: 2.2,
    waistWidth: 0.9,
    waistHeight: 0.55,
    anvilStart: 0.55,
    capRound: 0.95,
    anvilSpread: 0,

    // the storm end. Measured profile at these values: r(0.5)=0.43 waist,
    // r(0.9)=1.37 cap — the cap is WIDER than the base, which is what
    // separates an anvil from a large cumulus.
    stormClusterHeight: 2.6,
    stormHeightBias: 1.0,
    stormDomeExponent: 8,
    stormWaistWidth: 0.42,
    stormAnvilSpread: 1.2,
    stormRadiusScale: 2.0,
    stormBaseDrop: 0.6,
    stormLobeScale: 0.62,
    stormSunCut: 0.72,
    stormSkyCut: 0.28,
    stormQuantSteps: 24,
    stormBaseDark: 0.55,

    // 2 → ±2.5 cells at cellSize 2600 = ±6.5 km of cloud placement around the
    // ship, comfortably inside maxCloudDist. Raising it puts more anvils on
    // screen AND more lobes in the buffer; 3 (7×7) is the practical ceiling
    // before maxLobes.
    stormCellRange: 2,
    // 1.0 = the cloud's footprint IS the cell's. MEASURED, not chosen: rain
    // starts where the field passes weatherParams.rainThreshold, which at full
    // cell amplitude is 0.78 of the cell radius, so anything below ~0.8 puts a
    // ring of rain OUTSIDE the cloud that made it. At 1.0 the cloud overhangs
    // its own rain by 22% of the radius before `clusterFlatten` (1.35) and the
    // lobe radii widen the drawn mass further — which is a cumulonimbus's
    // shield overhanging its rain core, and it is what you see approaching.
    stormCellRadius: 1.0,
    // below weatherParams.rainThreshold (0.35): a cell strong enough to rain
    // must already have had a cloud for a while before the first drop
    stormCellMin: 0.12,
    // a cell cluster is ~800 m across and ~2 km tall against a ring cumulus's
    // ~440 m; at the ring's 30-46 lobes it would read as scattered boulders
    stormCellLobesMin: 54,
    stormCellLobesMax: 72,

    shaftCount: 3,
    // 0.70/0.45 chosen against the shipped haze, not in isolation: the band of
    // sky a distant shaft hangs in is the BRIGHTEST part of the frame, and at
    // the first pass (0.42/0.62) the column was there in the buffer and
    // invisible on screen. These read as rain without reading as fog.
    shaftOpacity: 0.7,
    // ~a cell radius: a shaft seen edge-on through 800 m of its own core is
    // near peak, one clipped at the rim is a faint veil
    shaftDensityLength: 900,
    shaftRadius: 0.72,
    shaftGroundFade: 0.55,
    // MEASURED IN THE BROWSER, not chosen: at edge 1 the column still read as
    // a slab with vertical sides, because the alpha only reaches half at
    // perp = 0.71 r. 2.2 puts the half-alpha point at 0.46 r, i.e. a core with
    // most of the radius given over to the margin — which is what a rain
    // shaft seen through kilometres of air actually looks like.
    shaftEdge: 2.2,
    shaftTopFade: 0.35,
    // darker than the sky it hangs against — a rain shaft is the one part of
    // the weather that is unambiguously BELOW the cloud base and unlit
    shaftTint: 0.45,

    // 32 clusters x 64 lobes = the panel maxima, so the panel can never
    // ask for more instances than the buffers hold (§V28)
    maxLobes: 2048,
    // detail 1 = a subdivided icosahedron of 80 faces, whose silhouette is a
    // ~10-gon of STRAIGHT CHORDS. That is what "the edges seem a little bit
    // sharp / quite sharp" actually was: not a steep alpha gradient (measured
    // at 5 screenshot px 10-90, already soft) but dead-straight segments
    // metres long across a cloud's outline. No amount of blur or feathering
    // fixes a straight line; only more tessellation does. 2 = 320 faces.
    lobeDetail: 2,

    lobeRelief: 0.26,
    lobeReliefScale: 2.3,
    // 1.0 = the physical chord through a uniform sphere (see the interface
    // note). Not a look knob: this is the density profile of the volume.
    lobeChordPower: 1.0,
    // 0.31 came off the accumulation curve alone (one lobe → alpha 0.31, two
    // → 0.6, three → 0.79, interior still 0.9+) and IT WAS TOO LOW ON SCREEN.
    // Seen at the lagoon under the shipped swell preset, deck level looking up
    // 22°: at 0.31 the scattered small cumulus lost the hard disc AND all their
    // substance — flat, defocused grey-blue smudges with almost no lit/shadow
    // separation. Swept live against that framing (0.31 / 0.45 / 0.60 / 0.80):
    // 0.80 restores the body but the individual lobes start reading as
    // countable ovals again; 0.60 keeps the soft chord silhouette while giving
    // the mass back its tone. THE ACCUMULATION CURVE WAS NECESSARY BUT NOT
    // SUFFICIENT — it says when lobes stop tiling, not when a cloud looks like
    // one, and only pixels separate those two.
    lobeDensity: 0.60,
    sunPower: 1.9,
    sunSideGain: 0.8,
    selfShadow: 0.18,
    silverLining: 0.8,
    // A FLOOR THAT IS ALSO A CEILING IS JUST A FILL (§V56). 0.35..0.75 is a
    // 2.1x range across the entire normal sphere, so every face got roughly
    // the same skylight and the mass read as one flat tone — most of why the
    // clouds looked like cut-outs rather than solids, and visible in
    // docs/clouds.png as the reference RT having SEPARATED red and green
    // regions where ours is yellow almost everywhere. 6.8x now. The base is
    // still blue-grey rather than black: skyMin rides skyColor, not zero.
    // The range is opened DOWNWARD only. Raising skyMax to 0.95 pushes
    // sun*0.95 + sky*skyMax to 1.458 and the §B.19 clipping guard in
    // tests/clouds.test.ts catches it — which is the whole point of that
    // guard, and is why the lit end stays where the palette work put it.
    skyMin: 0.14,
    skyMax: 0.75,
    // MEASURED, and the first pair (0.28 / 0.55) was retuned DOWN because it
    // overshot into the same failure wearing the other hat: it put a lit top at
    // px 234,228,228 and its own underside at 221,212,200 — six percent apart,
    // i.e. §B.19's flatness again, bright instead of dark. These give a within-
    // cloud sunlight range of 0.20 (far side) → 0.96 (lit top), 4.8x, with the
    // worst buried underside at 0.375 against the 0.018 that started this pass.
    multiScatterFloor: 0.20,
    // 0.30 puts a sunset base at ~0.47 of the key, i.e. just under half a lit
    // top: glowing, which is the reference read, but never competing with it
    baseGlow: 0.30,
    baseGlowLowSun: 0.38,

    // fluffScale 1.25 was SMALLER than the lobe's own worst-case projected
    // radius (rx 1.25 x relief 1.377 = 1.72 mean radii), so the entire sprite
    // sat under the polygon it was supposed to feather: measured alpha at the
    // rim was ~0.03 against a lobe alpha of 0.85. The layer drew, cost fill,
    // and contributed nothing to the silhouette.
    fluffScale: 2.1,
    fluffAlpha: 0.45,
    fluffPower: 1.55,
    fluffHollow: 0.65,
    fluffRing: 0.34,
    fluffTopSharp: 0.55,
    fluffSunSharp: 0.3,
    fluffScaleVary: 0.35,

    // tuned at the shipped 17.3 sunset, the framing the note came from
    transGain: 0.9,
    transPower: 8,
    transDepth: 1.5,

    // THE BANDED LAYER. Numbers picked against docs/inspo/night/ —
    // sea_thieves_sunset_ship-scaled.jpg (a thin dark streak high up, a soft
    // bank low) and this-game-is-so-beautiful-*.webp (a broad teal veil under
    // a starfield with ONE pale cumulus doing all the work). At these values
    // peak coverage is ~0.31 against a cluster interior's 3-6, i.e. the sheet
    // is a veil over the cumulus and never a competitor.
    bandCoverage: 0.42,
    // above the cumulus and well below the range clamp, so the deck reads as a
    // separate stratum. Raised 1500 -> 2100 when the composition pass moved
    // the cluster tops to ~1570 m; the test that caught that is the point of
    // pinning it against the cumulus rather than as a bare number.
    bandAltitude: 2100,
    bandRange: 34000,
    bandAboveFade: 400,
    // 0.045 in sin(elev) ≈ 2.6°, where the fade is 63% — the layer is gone by
    // the skyline and the sky's haze takes over
    bandHorizonFade: 0.045,
    // 8.1:1. Below about 4:1 the field stops reading as bands and starts
    // reading as weather-map blotches; above about 15:1 it reads as combing
    // (§B.40, the crestElongation lesson one system over)
    bandLength: 5200,
    bandWidth: 640,
    bandWarp: 0.85,
    bandContrast: 1.45,
    bandBias: 0.05,
    bandGamma: 1.8,
    bandFarMean: 0.19,
    // Measured against the live palette (see the §B.19 band guard in
    // tests/clouds.test.ts): the sunward peak lands at sun 0.805 / sky 0.567
    // and a dense core at sun 0.267, a 3.9x tonal range on the composited
    // colour — a cloud, not a wash — with the peak still under the summed
    // ceiling the cores were retuned to.
    bandSunLevel: 0.66,
    bandAmbientFrac: 0.6,
    bandForwardGain: 0.62,
    bandForwardPower: 6,
    bandOptical: 1.8,
    bandThickFloor: 0.55,
    bandSkyLevel: 0.42,
    bandHorizonLift: 0.35,
    // ~3 m/s: a band crosses its own width in ~3.5 minutes. Faster reads as a
    // timelapse, and this layer must never be the thing the eye follows.
    bandDriftSpeed: 3.2,
    bandDriftDirDeg: 42,

    // must cover the new ring or every cluster past 4 km saturates depth 1 and
    // the depth-scaled blur and the near-soft/far-sharp alpha ramp both go flat
    maxCloudDist: 12000,
    coverage: 0.85, // per-lobe density; sky openness comes from clusterCount
    // the silhouette is now the point (§V11b) — heavy blur was there to hide
    // billboard circles and would sand the sculpting straight back off
    blurRadiusNear: 3.0,
    blurRadiusFar: 1.0,
    distortScale: 3.0,
    distortSpeed: 0.018,
    distortStrength: 0.016,
    // dropped from 0.5: at this frequency erosion only shifts the whole
    // silhouette, and at 0.5 it cut the fluff skirt (coverage ~0.2-0.5) away
    // entirely, which is most of why the edge came back hard after the blur
    edgeErode: 0.28,
    edgeHiScale: 6.0,
    edgeHiErode: 0.42,
    alphaGain: 1.1,
    alphaDensity: 1.6,
    // MEASURED (§V22), and the measurement changed the SHAPE of the gate, not
    // just these numbers — see cloudComposite: the ramp is now CENTRED on the
    // erosion threshold instead of starting at it. Widening a gate that starts
    // at rimT also drags its 50% point to rimT+soft/2, i.e. the visible
    // silhouette moves inward to cov~0.9 and the fluff skirt (cov 0.3-0.5)
    // that is supposed to be the soft part is crushed to ~0.04 alpha. Centred,
    // the same width lifts that skirt to ~0.37 and softens without moving the
    // edge. Width still clears ln(10)/alphaDensity at the near end (§V60).
    alphaSoftNear: 1.5,
    alphaSoftFar: 0.5,
    quadDistance: 500,
    // Retuned against the REPALETTED sky (skyParams zenith 0x336cb1 / mid
    // 0x558fbe). The old pair (0xfff1d4 / 0xe9eff5) was two near-whites that
    // SUMMED past 1.0 everywhere, so lit and shadowed faces both clipped to
    // white — that flatness is most of why the clouds read as blobs. The
    // skylight term is now a saturated sky blue and clearly darker than the
    // sun term, which is what gives a cloud its lit-side/shadow-side read.
    sunColor: 0xfff0d8,
    skyColor: 0x4a80b4,
    skyTint: 0.85,
    sunTint: 0.9,
    // #fdb669 at the §T.39 sunset → r-b = 0.58 → warmth 0.93; #99def9 at
    // midday → r-b negative → warmth 0, so the sun term stays as authored
    paletteWarmthGain: 1.6,
    paletteSatFollow: 0.35,
    sunDarken: 0.75,
  },
  cloudParamsMeta,
);

/** Coverage is a 0..1 density knob; NaN falls back to 0, ±Infinity clamps. */
export function clampCoverage(v: number): number {
  if (Number.isNaN(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/**
 * Keys whose change requires regenerating the lobe set on the CPU. Joined
 * into a cheap key by src/clouds/index.ts so a Tweakpane edit or a weather
 * preset lerp (§V7) reshapes the sky live instead of silently doing nothing
 * until the next reload.
 */
export const CLOUD_LAYOUT_KEYS: readonly (keyof CloudParams)[] = [
  'clusterCount',
  'lobesMin',
  'lobesMax',
  'ringInner',
  'ringOuter',
  'altitudeMin',
  'altitudeMax',
  'clusterRadiusMin',
  'clusterRadiusMax',
  'clusterFlatten',
  'clusterHeight',
  'lobePacking',
  'lobeScaleMin',
  'lobeScaleMax',
  'lobeOblate',
  'heightBias',
  'domeExponent',
  'waistWidth',
  'waistHeight',
  'anvilStart',
  'capRound',
  'anvilSpread',
  'stormClusterHeight',
  'stormHeightBias',
  'stormDomeExponent',
  'stormWaistWidth',
  'stormAnvilSpread',
  'stormRadiusScale',
  'stormBaseDrop',
  'stormLobeScale',
  // §V.63 cell-anchored storm clouds — all four change the lobe SET, so a
  // panel edit that skipped this list would silently do nothing
  'stormCellRange',
  'stormCellRadius',
  'stormCellMin',
  'stormCellLobesMin',
  'stormCellLobesMax',
];

export function cloudLayoutKey(p: CloudParams): string {
  let key = '';
  for (const k of CLOUD_LAYOUT_KEYS) key += `${p[k]}|`;
  return key;
}
