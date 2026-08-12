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
  /** fluff sprite radius as a multiple of its lobe's mean radius */
  fluffScale: number;
  /** fluff sprite peak alpha */
  fluffAlpha: number;
  /** fluff sprite falloff exponent (higher = tighter core, softer skirt) */
  fluffPower: number;

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
  /** how strongly noise erodes/feathers cloud edges (0..1) */
  edgeErode: number;
  /** composite alpha gain applied to accumulated coverage */
  alphaGain: number;
  /** camera-pinned composite quad distance (m) */
  quadDistance: number;
  /** lighting reconstruction colors: color = sunColor*R + skyColor*G */
  sunColor: number;
  skyColor: number;
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
  fluffScale: { min: 0.5, max: 3, step: 0.05 },
  fluffAlpha: { min: 0, max: 1, step: 0.01 },
  fluffPower: { min: 0.5, max: 4, step: 0.05 },
  coverage: { min: 0, max: 1, step: 0.01 },
  blurRadiusNear: { min: 0, max: 16, step: 0.5 },
  blurRadiusFar: { min: 0, max: 16, step: 0.5 },
  distortScale: { min: 0.2, max: 8, step: 0.1 },
  distortSpeed: { min: 0, max: 0.1, step: 0.001 },
  distortStrength: { min: 0, max: 0.15, step: 0.001 },
  edgeErode: { min: 0, max: 1, step: 0.01 },
  alphaGain: { min: 0, max: 4, step: 0.05 },
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
    lobeDetail: 1,

    lobeRelief: 0.26,
    lobeReliefScale: 2.3,
    rimSoftness: 0.42,
    sunPower: 1.7,
    sunSideGain: 0.55,
    selfShadow: 0.32,
    silverLining: 0.8,
    // undersides keep real ambient — a cloud base is blue-grey, never black,
    // and skyMin is the only thing holding it up once the sun term dies
    skyMin: 0.35,
    skyMax: 0.75,

    fluffScale: 1.25,
    fluffAlpha: 0.3,
    fluffPower: 1.9,

    maxCloudDist: 4000,
    coverage: 0.85, // per-lobe density; sky openness comes from clusterCount
    // the silhouette is now the point (§V11b) — heavy blur was there to hide
    // billboard circles and would sand the sculpting straight back off
    blurRadiusNear: 3.0,
    blurRadiusFar: 1.0,
    distortScale: 3.0,
    distortSpeed: 0.018,
    distortStrength: 0.016,
    edgeErode: 0.5,
    alphaGain: 1.1,
    quadDistance: 500,
    // Retuned against the REPALETTED sky (skyParams zenith 0x336cb1 / mid
    // 0x558fbe). The old pair (0xfff1d4 / 0xe9eff5) was two near-whites that
    // SUMMED past 1.0 everywhere, so lit and shadowed faces both clipped to
    // white — that flatness is most of why the clouds read as blobs. The
    // skylight term is now a saturated sky blue and clearly darker than the
    // sun term, which is what gives a cloud its lit-side/shadow-side read.
    sunColor: 0xfff0d8,
    skyColor: 0x4a80b4,
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
