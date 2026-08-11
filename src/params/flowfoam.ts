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
  /** bow wake V half-angle (deg) — 19.47 is the physical Kelvin angle */
  kelvinAngle: number;
  /** bow arm foam injected per second per m/s of ship speed */
  bowIntensity: number;
  /** stern band foam injected per second per (m/s)² of ship speed */
  sternIntensity: number;
  /** ship speed (m/s) below which no wake is injected (feathers over 1× more) */
  speedThreshold: number;
  /** bow arm half-width (m) at the bow point */
  armWidth: number;
  /** extra arm half-width per meter aft — the V thickens as it trails */
  armWidthGrowth: number;
  /** stern band half-width as a multiple of ship beam (≈1 → width ≈ beam) */
  sternWidth: number;
  /** distance aft (m) over which wake injection fades to 0 — the advected field carries it further */
  wakeRange: number;
}

export const flowFoamParams: FlowFoamParams = registerParams(
  'flowfoam',
  {
    regionSize: 120,
    resolution: 512,
    captureHeight: 50,
    depthThreshold: 0.35,
    maskFeather: 0.5,
    injectStrength: 2.5,
    decayHalfLife: 3.0,
    advectSpeed: 1.0,
    blurRadius: 1.0,
    edgeFade: 0.08,
    noiseScale: 0.06,
    noiseStrength: 3.0,
    noiseScrollSpeed: 0.4,
    baseFlowSpeed: 0.8,
    curlStep: 1.2,
    kelvinAngle: 19.47,
    bowIntensity: 3.0,
    sternIntensity: 1.2,
    speedThreshold: 0.5,
    armWidth: 1.2,
    armWidthGrowth: 0.06,
    sternWidth: 1.0,
    wakeRange: 60,
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
    edgeFade: { min: 0.01, max: 0.45, step: 0.01 },
    noiseScale: { min: 0.005, max: 0.5, step: 0.005 },
    noiseStrength: { min: 0, max: 12, step: 0.1 },
    noiseScrollSpeed: { min: 0, max: 4, step: 0.05 },
    baseFlowSpeed: { min: 0, max: 6, step: 0.05 },
    curlStep: { min: 0.1, max: 8, step: 0.1 },
    kelvinAngle: { min: 5, max: 45, step: 0.01 },
    bowIntensity: { min: 0, max: 20, step: 0.1 },
    sternIntensity: { min: 0, max: 10, step: 0.05 },
    speedThreshold: { min: 0, max: 5, step: 0.05 },
    armWidth: { min: 0.1, max: 10, step: 0.1 },
    armWidthGrowth: { min: 0, max: 0.5, step: 0.005 },
    sternWidth: { min: 0.2, max: 3, step: 0.05 },
    wakeRange: { min: 5, max: 300, step: 5 },
  };
}
