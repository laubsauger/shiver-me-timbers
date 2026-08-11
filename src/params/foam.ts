/**
 * Foam sim tunables (§V16: every tunable in a params module, no shader
 * magic constants). Consumed by src/foam/* (§V6: jacobian-injected foam,
 * progressively blurred each frame, crest→soft texture blend).
 * Note: the jacobian threshold itself lives in params/ocean.ts
 * (`jacobianFoamBias`) because storms bias it there (§V7).
 */
import { registerParams, type ParamMeta } from './registry';

export interface FoamParams {
  /** foam amount injected per second per unit of jacobian deficit (bias − J) */
  injectStrength: number;
  /**
   * seconds for undisturbed foam to fade to half its value — converted to a
   * per-frame decay factor at the fixed sim tick (§V2)
   */
  decayHalfLife: number;
  /** 3×3 blur tap offset in texels — spread speed of the progressive blur */
  blurRadius: number;
  /** world-space frequency of the high-freq crackle layer on fresh foam */
  crackleScale: number;
  /** world-space frequency of the soft mottling on dissipated foam */
  mottleScale: number;
  /** 0 = pure white foam, 1 = fully warm-tinted (§V20 warm-tinted foam) */
  tintWarmth: number;
  /** world-space frequency of the fbm domain-warp on the sim-texture lookup */
  uvWarpScale: number;
  /** warp amplitude in world meters — breaks the sim RT's texel grid */
  uvWarpMeters: number;
  /** drift speed of the foam detail noise (units of noise-space per second) */
  detailScrollSpeed: number;
  /** inject foam from the fine ripple cascade, 0|1 (default 0 — its ~14m
   *  tile stamps caps on a visible world grid, §V19) */
  injectFineCascade: number;
  /** world-space frequency of the non-tiling cap-strength variation (§B.4) */
  capVariationScale: number;
  /** 0 = uniform caps, 1 = strong per-site strength/lifecycle variation */
  capVariationStrength: number;
  /** blur tap stretch ALONG the wave crest ridge (1 = isotropic/round caps) */
  crestBlurAlong: number;
  /** blur tap stretch ACROSS the ridge — keep < along or caps go circular */
  crestBlurAcross: number;
  /** detail-noise stretch along the crest line (1 = isotropic blobs) */
  crestElongation: number;
  /**
   * foam value above which coverage counts as SATURATED (storm seas). Past
   * it the detail noise broadens and flattens into wind-driven sheets —
   * detail tuned for 10% coverage reads as noise at 80% (§V7 big patches).
   */
  sheetKnee: number;
  /** detail frequency multiplier at full saturation (< 1 = broader patches) */
  sheetBroaden: number;
  /** how far saturated foam flattens toward an unbroken sheet, 0..1 */
  sheetFlatten: number;
  /**
   * distance at which foam DETAIL starts fading out, measured in crackle
   * FEATURE WIDTHS (1/crackleScale metres each) rather than metres, so
   * retuning the detail frequency cannot silently un-fix the horizon sizzle.
   */
  detailFadeFeatures: number;
  /** multiplier from fade start to fully faded (≥ 1.05) */
  detailFadeSpan: number;
  /**
   * 0..1 — how much the far-field fade also removes foam COVERAGE, not just
   * its detail. 0 = off (default): distant whitecaps stay as lighter sea.
   * Raise only if the horizon still reads too white after the detail fade.
   */
  farFoamFade: number;
}

export const foamParams: FoamParams = registerParams(
  'foam',
  {
    injectStrength: 4.0,
    decayHalfLife: 0.9,
    blurRadius: 1.0,
    crackleScale: 2.4,
    mottleScale: 0.35,
    tintWarmth: 0.12,
    uvWarpScale: 0.12,
    uvWarpMeters: 1.4,
    detailScrollSpeed: 0.05,
    injectFineCascade: 0,
    capVariationScale: 0.03,
    capVariationStrength: 0.8,
    crestBlurAlong: 2.6,
    crestBlurAcross: 0.5,
    crestElongation: 3.0,
    sheetKnee: 0.7,
    sheetBroaden: 0.35,
    sheetFlatten: 0.5,
    detailFadeFeatures: 260,
    detailFadeSpan: 3.5,
    farFoamFade: 0,
  },
  foamParamsMeta(),
);

function foamParamsMeta(): Partial<Record<keyof FoamParams, ParamMeta>> {
  return {
    injectStrength: { min: 0, max: 20, step: 0.1 },
    decayHalfLife: { min: 0.05, max: 10, step: 0.05 },
    blurRadius: { min: 0, max: 4, step: 0.25 },
    crackleScale: { min: 0.1, max: 20, step: 0.1 },
    mottleScale: { min: 0.01, max: 5, step: 0.01 },
    tintWarmth: { min: 0, max: 1, step: 0.01 },
    uvWarpScale: { min: 0.01, max: 1, step: 0.01 },
    uvWarpMeters: { min: 0, max: 6, step: 0.1 },
    detailScrollSpeed: { min: 0, max: 0.5, step: 0.005 },
    injectFineCascade: { min: 0, max: 1, step: 1 },
    capVariationScale: { min: 0.002, max: 0.2, step: 0.002 },
    capVariationStrength: { min: 0, max: 1, step: 0.05 },
    crestBlurAlong: { min: 0.25, max: 5, step: 0.05 },
    crestBlurAcross: { min: 0.1, max: 3, step: 0.05 },
    crestElongation: { min: 1, max: 8, step: 0.1 },
    sheetKnee: { min: 0.1, max: 1, step: 0.01 },
    sheetBroaden: { min: 0.05, max: 1, step: 0.01 },
    sheetFlatten: { min: 0, max: 1, step: 0.01 },
    detailFadeFeatures: { min: 10, max: 2000, step: 10 },
    detailFadeSpan: { min: 1.05, max: 10, step: 0.05 },
    farFoamFade: { min: 0, max: 1, step: 0.05 },
  };
}
