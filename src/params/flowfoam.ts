/**
 * Intersection/flow foam tunables (§V16: every tunable in a params module,
 * no shader magic constants). Consumed by src/flowfoam/* (§V10: depth-compare
 * intersection mask → world-space accumulation RT advected by a flow noise
 * map + blurred every frame — the Rare depth-trick, docs/handoff.md §4).
 *
 * `resolution` is a startup constant (texture allocation + dispatch size —
 * change requires recreating the system, like deckwater grid dims).
 * `regionSize` is live-tweakable but a change breaks world anchoring for one
 * frame (the sliding window rescales under existing foam).
 */
import { registerParams, type ParamMeta } from './registry';

export interface FlowFoamParams {
  /** side length (m) of the square top-down foam region following the ship */
  regionSize: number;
  /** foam RT resolution (texels per side, power of two — startup constant) */
  resolution: number;
  /** injection ortho camera height above water (m); capture range = ±height */
  captureHeight: number;
  /** |scene depth − water depth| (m) below which a pixel counts as intersecting */
  depthThreshold: number;
  /** fraction of depthThreshold over which the mask feathers 1→0 (0..1] */
  maskFeather: number;
  /** foam added per second where the injection mask is 1 */
  injectStrength: number;
  /** seconds for advected foam to fade to half value (per-frame factor at §V2 tick) */
  decayHalfLife: number;
  /** multiplier on the flow vector when advecting (1 = flow speed in m/s) */
  advectSpeed: number;
  /** 3×3 blur tap offset in texels — spread speed of the progressive blur */
  blurRadius: number;
  /** 0 = no blur, 1 = full 3×3 gaussian per frame — partial blur keeps streaky structure */
  blurMix: number;
  /** curl/eddy multiplier where foam = 1 — the trail churns, open ocean stays calm */
  wakeChurn: number;
  /** fraction of the region half-width over which sampled foam fades at the border */
  edgeFade: number;
  /** flow noise frequency (1/m) — lower = larger, lazier eddies */
  noiseScale: number;
  /** swirl speed contributed by the pseudo-curl field (m/s per unit gradient) */
  noiseStrength: number;
  /** scroll speed of the noise potential along the base flow direction (m/s) */
  noiseScrollSpeed: number;
  /** uniform downstream drift along the flow direction (m/s) */
  baseFlowSpeed: number;
  /** finite-difference offset (m) for the pseudo-curl gradient samples */
  curlStep: number;
  // --- wake track history (world-space memory: src/flowfoam/wakeTrack.ts) ---
  /** metres of travel between recorded cutwater samples — the trail's resolution */
  trackSpacing: number;
  /** heading change (deg) that also lays a sample — keeps hard turns curved, not faceted */
  trackTurn: number;
  /** seconds a track sample survives; with trackSpacing this sets trail length */
  trackLife: number;
  /** fraction of trackLife over which the oldest wake fades out (no eviction pop) */
  tailFade: number;
  /** feather distance (m) ahead of the cutwater over which wake is clipped to 0 */
  bowClip: number;

  // --- bow mound: the displacement bow wave, FORWARD of the stem ---
  /** bow mound foam per second per m/s — the water shoved ahead of the stem */
  moundIntensity: number;
  /** metres AHEAD of the stem where the mound crest peaks (must be > 0: it leads) */
  moundLead: number;
  /** crest aft-sweep per metre outboard — how the mound peels into the V arms */
  moundSweep: number;
  /** outboard half-extent (m) of the mound before it hands over to the arms */
  moundSpan: number;
  /** fore-aft thickness (m) of the mound's leading face */
  moundThick: number;
  /** aft thickness as a multiple of moundThick — fills the gap back to the hull */
  moundFill: number;
  /** seconds for the mound to build/subside toward the hull's speed (inertia) */
  moundLag: number;

  // --- bow: cutwater core + Kelvin arms ---
  /** bow wake V half-angle (deg) — 19.47 is the physical Kelvin angle */
  kelvinAngle: number;
  /** Kelvin arm foam injected per second per m/s of ship speed */
  bowIntensity: number;
  /** arm half-width (m) at the stem */
  armWidth: number;
  /** extra arm half-width per metre of track distance — the V thickens as it trails */
  armWidthGrowth: number;
  /** extra arm intensity multiplier at the hull (0 = flat) — "heaving water out" read */
  hullBoost: number;
  /** track distance (m) over which hullBoost fades to 0 */
  hullBoostDist: number;
  /** seconds an arm keeps injecting before it fades out */
  bowLife: number;
  /** cutwater core foam per second per m/s — the stem tearing the surface open */
  cutIntensity: number;
  /** cutwater core half-width (m) */
  cutWidth: number;
  /** track distance (m) over which the cutwater core fades */
  cutLength: number;

  // --- aft: transom churn + shed vortex pair ---
  /** stern churn foam injected per second per (m/s)² of ship speed */
  sternIntensity: number;
  /** stern churn half-width as a multiple of ship beam (≈1 → width ≈ beam) */
  sternWidth: number;
  /** turbulent lateral spread of the stern churn (m/s of water age) */
  sternSpread: number;
  /** seconds the stern churn keeps injecting after the transom passes */
  sternLife: number;
  /** track distance (m) aft of the transom over which the aft features fade IN */
  sternOnset: number;
  /** shed vortex foam per second per (m/s)² — the aft's distinguishing feature */
  vortexIntensity: number;
  /** vortex lobe offset from the centreline, × beam half-width */
  vortexOffset: number;
  /** outboard drift of the vortex lobes (m/s of water age) */
  vortexSpread: number;
  /** vortex lobe half-width (m) */
  vortexWidth: number;
  /** metres of track between shed puffs — port/starboard alternate (von Kármán) */
  vortexSpacing: number;
  /** seconds a shed vortex keeps injecting */
  vortexLife: number;

  /** ship speed (m/s) below which no wake is injected (feathers over 1× more) */
  speedThreshold: number;
  /** speed (m/s) at which the bow wake is fully developed — arm intensity
   * scales with smoothstep(speedThreshold, fullWakeSpeed, speed); slow drift
   * shows only faint stern churn, no V */
  fullWakeSpeed: number;
  /** world-space frequency (1/m) of the wake breakup noise */
  wakeNoiseScale: number;
  /** smoothstep half-band around 0.5 thresholding the breakup noise — small = hard gaps, large = soft mottle */
  wakeNoiseContrast: number;
  /** 0 = solid painted bands, 1 = fully gappy/broken foam patches */
  wakeBreakup: number;
}

export const flowFoamParams: FlowFoamParams = registerParams(
  'flowfoam',
  {
    regionSize: 120,
    resolution: 512,
    captureHeight: 50,
    depthThreshold: 0.35,
    maskFeather: 0.5,
    injectStrength: 0.6,
    decayHalfLife: 2.8,
    advectSpeed: 1.0,
    blurRadius: 1.0,
    blurMix: 0.35,
    wakeChurn: 1.8,
    edgeFade: 0.16,
    noiseScale: 0.12,
    noiseStrength: 8.0,
    noiseScrollSpeed: 0.4,
    baseFlowSpeed: 0.8,
    curlStep: 1.2,
    trackSpacing: 2.2,
    trackTurn: 6,
    trackLife: 30,
    tailFade: 0.35,
    bowClip: 0.8,
    moundIntensity: 0.5,
    moundLead: 1.6,
    moundSweep: 0.9,
    moundSpan: 5.0,
    moundThick: 1.4,
    moundFill: 3.0,
    moundLag: 1.1,
    kelvinAngle: 19.47,
    bowIntensity: 0.3,
    armWidth: 0.9,
    armWidthGrowth: 0.05,
    hullBoost: 1.6,
    hullBoostDist: 14,
    bowLife: 9,
    cutIntensity: 1.0,
    cutWidth: 1.1,
    cutLength: 7,
    sternIntensity: 0.05,
    sternWidth: 0.9,
    sternSpread: 0.55,
    sternLife: 8,
    sternOnset: 3,
    vortexIntensity: 0.05,
    vortexOffset: 1.15,
    vortexSpread: 0.28,
    vortexWidth: 1.3,
    vortexSpacing: 11,
    vortexLife: 10,
    speedThreshold: 0.5,
    fullWakeSpeed: 5.0,
    wakeNoiseScale: 0.3,
    wakeNoiseContrast: 0.18,
    wakeBreakup: 0.85,
  },
  flowFoamParamsMeta(),
);

function flowFoamParamsMeta(): Partial<Record<keyof FlowFoamParams, ParamMeta>> {
  return {
    regionSize: { min: 30, max: 500, step: 5 },
    captureHeight: { min: 5, max: 200, step: 1 },
    depthThreshold: { min: 0.05, max: 3, step: 0.05 },
    maskFeather: { min: 0.05, max: 1, step: 0.05 },
    injectStrength: { min: 0, max: 20, step: 0.1 },
    decayHalfLife: { min: 0.05, max: 15, step: 0.05 },
    advectSpeed: { min: 0, max: 4, step: 0.05 },
    blurRadius: { min: 0, max: 4, step: 0.25 },
    blurMix: { min: 0, max: 1, step: 0.05 },
    wakeChurn: { min: 0, max: 8, step: 0.1 },
    edgeFade: { min: 0.01, max: 0.45, step: 0.01 },
    noiseScale: { min: 0.005, max: 0.5, step: 0.005 },
    noiseStrength: { min: 0, max: 12, step: 0.1 },
    noiseScrollSpeed: { min: 0, max: 4, step: 0.05 },
    baseFlowSpeed: { min: 0, max: 6, step: 0.05 },
    curlStep: { min: 0.1, max: 8, step: 0.1 },
    trackSpacing: { min: 0.5, max: 10, step: 0.1 },
    trackTurn: { min: 1, max: 45, step: 0.5 },
    trackLife: { min: 1, max: 60, step: 0.5 },
    tailFade: { min: 0.05, max: 0.9, step: 0.05 },
    bowClip: { min: 0.1, max: 8, step: 0.1 },
    moundIntensity: { min: 0, max: 5, step: 0.05 },
    moundLead: { min: 0.1, max: 10, step: 0.1 },
    moundSweep: { min: 0, max: 4, step: 0.05 },
    moundSpan: { min: 0.5, max: 20, step: 0.25 },
    moundThick: { min: 0.2, max: 8, step: 0.1 },
    moundFill: { min: 1, max: 8, step: 0.1 },
    moundLag: { min: 0.05, max: 6, step: 0.05 },
    kelvinAngle: { min: 5, max: 45, step: 0.01 },
    bowIntensity: { min: 0, max: 5, step: 0.05 },
    armWidth: { min: 0.1, max: 10, step: 0.1 },
    armWidthGrowth: { min: 0, max: 0.5, step: 0.005 },
    hullBoost: { min: 0, max: 8, step: 0.1 },
    hullBoostDist: { min: 1, max: 60, step: 1 },
    bowLife: { min: 0.5, max: 30, step: 0.5 },
    cutIntensity: { min: 0, max: 8, step: 0.05 },
    cutWidth: { min: 0.1, max: 8, step: 0.1 },
    cutLength: { min: 0.5, max: 40, step: 0.5 },
    sternIntensity: { min: 0, max: 2, step: 0.005 },
    sternWidth: { min: 0.2, max: 4, step: 0.05 },
    sternSpread: { min: 0, max: 4, step: 0.05 },
    sternLife: { min: 0.5, max: 20, step: 0.5 },
    sternOnset: { min: 0.5, max: 20, step: 0.5 },
    vortexIntensity: { min: 0, max: 2, step: 0.005 },
    vortexOffset: { min: 0.2, max: 4, step: 0.05 },
    vortexSpread: { min: 0, max: 3, step: 0.02 },
    vortexWidth: { min: 0.2, max: 6, step: 0.1 },
    vortexSpacing: { min: 2, max: 60, step: 0.5 },
    vortexLife: { min: 0.5, max: 25, step: 0.5 },
    speedThreshold: { min: 0, max: 5, step: 0.05 },
    fullWakeSpeed: { min: 1, max: 15, step: 0.25 },
    wakeNoiseScale: { min: 0.02, max: 2, step: 0.01 },
    wakeNoiseContrast: { min: 0.02, max: 0.5, step: 0.01 },
    wakeBreakup: { min: 0, max: 1, step: 0.05 },
  };
}
