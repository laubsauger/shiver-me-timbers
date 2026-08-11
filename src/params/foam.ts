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
}

export const foamParams: FoamParams = registerParams(
  'foam',
  {
    injectStrength: 4.0,
    decayHalfLife: 1.2,
    blurRadius: 1.0,
    crackleScale: 3.0,
    mottleScale: 0.35,
    tintWarmth: 0.35,
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
  };
}
