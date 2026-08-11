/**
 * Cloud tunables (§V16: every tunable lives in a params module, no shader
 * magic constants). Consumed by src/clouds/* (§V11). Registered with the
 * Tweakpane params registry via a runtime-only dynamic import guard because
 * the registry module is built by a parallel task and may not exist yet.
 */

export interface CloudParams {
  /** offscreen cores/blur target size (px) — blur hides the low res */
  rtWidth: number;
  rtHeight: number;
  /** number of cumulus clusters placed on the ring around origin */
  clusterCount: number;
  /** puffs per cluster, inclusive bounds */
  puffsMin: number;
  puffsMax: number;
  /** cluster placement ring (m, world XZ around origin) */
  ringInner: number;
  ringOuter: number;
  /** cluster base altitude range (m) */
  altitudeMin: number;
  altitudeMax: number;
  /** cluster footprint radius range (m) */
  clusterRadiusMin: number;
  clusterRadiusMax: number;
  /** horizontal stretch of clusters (cumulus are wider than tall) */
  clusterFlatten: number;
  /** individual puff billboard radius range (m) */
  puffScaleMin: number;
  puffScaleMax: number;
  /** distance (m) mapped to depth=1 in the RT alpha channel */
  maxCloudDist: number;
  /** 0..1 global cloud coverage/density */
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

export const cloudParams: CloudParams = {
  rtWidth: 768,
  rtHeight: 432,
  clusterCount: 10,
  puffsMin: 14,
  puffsMax: 26,
  ringInner: 900,
  ringOuter: 2600,
  altitudeMin: 260,
  altitudeMax: 520,
  clusterRadiusMin: 120,
  clusterRadiusMax: 320,
  clusterFlatten: 1.5,
  puffScaleMin: 55,
  puffScaleMax: 150,
  maxCloudDist: 4000,
  coverage: 0.65,
  blurRadiusNear: 7,
  blurRadiusFar: 1.5,
  distortScale: 2.2,
  distortSpeed: 0.018,
  distortStrength: 0.03,
  edgeErode: 0.4,
  alphaGain: 1.5,
  quadDistance: 500,
  sunColor: 0xfff3da,
  skyColor: 0x8ba5c4,
};

/** Coverage is a 0..1 density knob; NaN falls back to 0, ±Infinity clamps. */
export function clampCoverage(v: number): number {
  if (Number.isNaN(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/** Tweakpane range hints, consumed by the registry's debug panel binder. */
const cloudParamsMeta: Partial<Record<keyof CloudParams, object>> = {
  clusterCount: { min: 1, max: 32, step: 1 },
  puffsMin: { min: 1, max: 64, step: 1 },
  puffsMax: { min: 1, max: 64, step: 1 },
  coverage: { min: 0, max: 1, step: 0.01 },
  blurRadiusNear: { min: 0, max: 16, step: 0.5 },
  blurRadiusFar: { min: 0, max: 16, step: 0.5 },
  distortScale: { min: 0.2, max: 8, step: 0.1 },
  distortSpeed: { min: 0, max: 0.1, step: 0.001 },
  distortStrength: { min: 0, max: 0.15, step: 0.001 },
  edgeErode: { min: 0, max: 1, step: 0.01 },
  alphaGain: { min: 0, max: 4, step: 0.05 },
};

// -- registry hookup ---------------------------------------------------------
// The params registry (src/params/registry.ts) is produced by parallel task
// T2 and may not exist yet. Resolve at runtime only: the specifier is a
// widened string so neither tsc nor Vite's static analysis requires the
// module to exist. When present, its API is registerParams(name, params, meta).
const registrySpecifier: string = './registry';
void import(/* @vite-ignore */ registrySpecifier)
  .catch(() => import(/* @vite-ignore */ (registrySpecifier + '.ts') as string))
  .then((mod: Record<string, unknown>) => {
    const register = (mod.registerParams ?? mod.register) as
      | ((group: string, params: object, meta?: object) => void)
      | undefined;
    register?.('clouds', cloudParams, cloudParamsMeta);
  })
  .catch(() => {
    /* registry not built yet — clouds still fully functional without panel */
  });
