/**
 * Colour grade tunables (§T.101, §V.89, §V.16).
 *
 * Everything here is DISPLAY-referred: the grade node sits after the tone
 * map (`postPipeline.ts`, between `renderOutput` and vibrance), so every
 * value is a 0..1 sRGB quantity and every identity is exact:
 *   lift 0 · gamma 1 · gain 1 · saturation 1 · splitStrength 0 · lutMix 0
 * leave the frame byte-identical. The defaults ARE that identity — enabling
 * the grade changes nothing until the R3 lookdev sync authors a look.
 *
 * `enabled` is a CONSTRUCTION gate like the other post stages: off means the
 * node is not in the graph at all (§V.17 — bypassed, not identity-sampled).
 *
 * Tints are three numbers each because the panel binds flat numbers; the
 * neutral tint is 0.5/0.5/0.5 (the split-tone adds `(tint − 0.5)·strength`).
 * The LUT bands are hours on the sky's 24 h clock (`sky.timeOfDay`), a
 * centre plus a hold half-width during which that slot's LUT is used alone;
 * between holds the two neighbouring slots crossfade (see gradeBandWeights).
 * The engine's sun sets at 18:00 and `nightFactor` is 1 at 19 (R0 params.md),
 * which is why dusk sits at 17.8 with a short hold.
 */
import { registerParams } from './registry';

export const gradeParams = registerParams(
  'grade',
  {
    /** CONSTRUCTION gate (reload to change) — see postPipeline gates */
    enabled: true,

    // --- lift / gamma / gain, per channel ----------------------------------
    liftR: 0,
    liftG: 0,
    liftB: 0,
    gammaR: 1,
    gammaG: 1,
    gammaB: 1,
    gainR: 1,
    gainG: 1,
    gainB: 1,

    /** 1 = untouched, 0 = greyscale (Rec.709 luma) */
    saturation: 1,

    // --- split tone ----------------------------------------------------------
    /** luma below the pivot is pulled toward shadowTint, above toward highlightTint */
    splitPivot: 0.5,
    /** half-width of the luma band over which one tint hands over to the other */
    splitSoftness: 0.25,
    /** 0 = off (identity) */
    splitStrength: 0,
    shadowTintR: 0.5,
    shadowTintG: 0.5,
    shadowTintB: 0.5,
    highlightTintR: 0.5,
    highlightTintG: 0.5,
    highlightTintB: 0.5,

    // --- LUT -----------------------------------------------------------------
    /** 0 = LGG/split only, 1 = fully the blended LUT (applied AFTER the LGG) */
    lutMix: 1,
    /** a disabled slot contributes the identity LUT for its share of the band */
    lutDawn: true,
    lutNoon: true,
    lutDusk: true,
    lutNight: true,
    dawnCentre: 6,
    dawnHold: 0.75,
    noonCentre: 12,
    noonHold: 3,
    duskCentre: 17.8,
    duskHold: 0.5,
    nightCentre: 23,
    nightHold: 4,
  },
  {
    liftR: { min: -0.5, max: 0.5, step: 0.005 },
    liftG: { min: -0.5, max: 0.5, step: 0.005 },
    liftB: { min: -0.5, max: 0.5, step: 0.005 },
    gammaR: { min: 0.2, max: 3, step: 0.01 },
    gammaG: { min: 0.2, max: 3, step: 0.01 },
    gammaB: { min: 0.2, max: 3, step: 0.01 },
    gainR: { min: 0, max: 3, step: 0.01 },
    gainG: { min: 0, max: 3, step: 0.01 },
    gainB: { min: 0, max: 3, step: 0.01 },
    saturation: { min: 0, max: 2, step: 0.01 },
    splitPivot: { min: 0, max: 1, step: 0.01 },
    splitSoftness: { min: 0.01, max: 0.5, step: 0.01 },
    splitStrength: { min: 0, max: 1, step: 0.01 },
    shadowTintR: { min: 0, max: 1, step: 0.01 },
    shadowTintG: { min: 0, max: 1, step: 0.01 },
    shadowTintB: { min: 0, max: 1, step: 0.01 },
    highlightTintR: { min: 0, max: 1, step: 0.01 },
    highlightTintG: { min: 0, max: 1, step: 0.01 },
    highlightTintB: { min: 0, max: 1, step: 0.01 },
    lutMix: { min: 0, max: 1, step: 0.01 },
    dawnCentre: { min: 0, max: 24, step: 0.1 },
    dawnHold: { min: 0, max: 6, step: 0.05 },
    noonCentre: { min: 0, max: 24, step: 0.1 },
    noonHold: { min: 0, max: 6, step: 0.05 },
    duskCentre: { min: 0, max: 24, step: 0.1 },
    duskHold: { min: 0, max: 6, step: 0.05 },
    nightCentre: { min: 0, max: 24, step: 0.1 },
    nightHold: { min: 0, max: 6, step: 0.05 },
  },
);

export type GradeParams = typeof gradeParams;

/** slot order everywhere: band weights, textures, asset strips */
export const GRADE_SLOTS = ['dawn', 'noon', 'dusk', 'night'] as const;
export type GradeSlot = (typeof GRADE_SLOTS)[number];
