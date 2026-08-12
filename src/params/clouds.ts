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

  /** instance capacity — read once at construction, reload to change (§V28) */
  maxLobes: number;
  /** icosphere subdivision per lobe — read once at construction (0..3) */
  lobeDetail: number;

  // -- lobe surface + shading (live uniforms) ------------------------------
  /** radial noise displacement amplitude (0..1) — the cauliflower relief */
  lobeRelief: number;
  /** spatial frequency of that relief on the unit lobe */
  lobeReliefScale: number;
  /** silhouette softness: |N·V| below this fades the rim out */
  rimSoftness: number;
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
  lobesMin: { min: 1, max: 64, step: 1 },
  lobesMax: { min: 1, max: 64, step: 1 },
  clusterFlatten: { min: 0.4, max: 3, step: 0.05 },
  clusterHeight: { min: 0.2, max: 4, step: 0.05 },
  lobeScaleMin: { min: 0.05, max: 0.6, step: 0.01 },
  lobeScaleMax: { min: 0.05, max: 0.6, step: 0.01 },
  lobeOblate: { min: 0.3, max: 1.5, step: 0.01 },
  heightBias: { min: 0.4, max: 4, step: 0.05 },
  domeExponent: { min: 1, max: 12, step: 0.1 },
  waistWidth: { min: 0.1, max: 1, step: 0.01 },
  waistHeight: { min: 0.05, max: 1, step: 0.01 },
  anvilStart: { min: 0.1, max: 0.95, step: 0.01 },
  capRound: { min: 0.5, max: 1, step: 0.01 },
  anvilSpread: { min: 0, max: 2, step: 0.01 },
  lobeDetail: { min: 0, max: 3, step: 1 },
  lobeRelief: { min: 0, max: 0.6, step: 0.01 },
  lobeReliefScale: { min: 0.5, max: 8, step: 0.1 },
  rimSoftness: { min: 0.02, max: 1, step: 0.01 },
  sunPower: { min: 0.5, max: 6, step: 0.05 },
  sunSideGain: { min: 0, max: 1, step: 0.01 },
  selfShadow: { min: 0, max: 1, step: 0.01 },
  silverLining: { min: 0, max: 2, step: 0.01 },
  skyMin: { min: 0, max: 1.5, step: 0.01 },
  skyMax: { min: 0, max: 1.5, step: 0.01 },
  fluffScale: { min: 0.5, max: 4, step: 0.05 },
  fluffAlpha: { min: 0, max: 1, step: 0.01 },
  fluffPower: { min: 0.5, max: 4, step: 0.05 },
  fluffHollow: { min: 0, max: 1, step: 0.01 },
  fluffRing: { min: 0.02, max: 1, step: 0.01 },
  fluffTopSharp: { min: 0, max: 1, step: 0.01 },
  fluffSunSharp: { min: 0, max: 1, step: 0.01 },
  fluffScaleVary: { min: 0, max: 0.8, step: 0.01 },
  coverage: { min: 0, max: 1, step: 0.01 },
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

    clusterCount: 11,
    lobesMin: 30,
    lobesMax: 46,
    ringInner: 900,
    ringOuter: 2600,
    altitudeMin: 340,
    altitudeMax: 620,
    clusterRadiusMin: 180,
    clusterRadiusMax: 360,
    clusterFlatten: 1.35,
    clusterHeight: 0.95,
    lobeScaleMin: 0.17,
    lobeScaleMax: 0.31,
    lobeOblate: 0.74,
    heightBias: 1.6,

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
    rimSoftness: 0.42,
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

    maxCloudDist: 4000,
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
];

export function cloudLayoutKey(p: CloudParams): string {
  let key = '';
  for (const k of CLOUD_LAYOUT_KEYS) key += `${p[k]}|`;
  return key;
}
