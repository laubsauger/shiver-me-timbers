/**
 * Foam sim tunables (§V16: every tunable in a params module, no shader
 * magic constants). Consumed by src/foam/* (§V6: jacobian-injected foam,
 * progressively blurred each frame, crest→soft texture blend).
 * Note: the jacobian threshold itself lives in params/ocean.ts
 * (`jacobianFoamBias`) because storms bias it there (§V7).
 */
import { registerParams, type ParamMeta } from './registry';

export interface FoamParams {
  /**
   * foam injected per second per SIGMA that the band's jacobian sits below
   * its gate (§V36, foamMath.cascadeInjectPerStep). Not per unit of raw
   * deficit: a raw deficit means 2.5× more fold in the fine band than in the
   * coarse one and ~10× more at storm than at swell, so the same number used
   * to produce wildly different foam depending on which band and which
   * weather happened to fire it.
   */
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
  /**
   * inject foam from the fine ripple cascade, 0|1 (default 1).
   *
   * It was 0 for a real reason and the reason is gone. Under the old FLAT
   * jacobian bias the finest band — the one with the largest σ — was the only
   * band that ever cleared the gate (at storm: 16% of its texels against 5%
   * and 6% for the other two), so essentially ALL foam came from one ~14 m
   * tile and stamped whitecaps on a visible world lattice (§V19, user-
   * reported). Switching it off cured the lattice and left swell with nothing
   * at all, because the other two bands were sitting at 8σ and 5σ. With the
   * σ-relative gate all three bands fire at the same rate, so the fine band is
   * one contributor among three instead of the whole signal — and its detail
   * is what puts foam on the small crests between the big ones. Kept as a
   * switch because it is the first thing to try if lattice ever returns.
   */
  injectFineCascade: number;
  /**
   * world-space frequency of the non-tiling cap-strength variation (§B.4).
   *
   * LOWER than it looks like it should be, on purpose. The field is a value-
   * noise fbm, and a value-noise field puts its maxima near its own lattice
   * cell centres — at 0.03 (33 m) the maxima came out at a measured nearest-
   * neighbour spacing CV of 0.292 where a random point process reads 0.523,
   * i.e. the thing that exists to break the FFT lattice was drawing a ~25 m
   * lattice of its own. The cure is broadband: a low base frequency plus more
   * octaves (foamShading.CAP_VAR_OCTAVES) so the finest octaves move each
   * maximum off its cell.
   */
  capVariationScale: number;
  /** 0 = uniform caps, 1 = strong per-site strength/lifecycle variation */
  capVariationStrength: number;
  /** detail-noise stretch along the crest line (1 = isotropic blobs) */
  crestElongation: number;
  /**
   * world-space frequency of the field that TURNS the detail elongation.
   * 1/this is roughly how far you travel before the streaks point somewhere
   * else. Keep it well below every cascade domain (420/98/22.7 m) so it adds
   * no repeat of its own — its whole job is to destroy one.
   */
  crestDirectionScale: number;
  /**
   * total swing of that turn, in radians (the field spans ±swing/2). 0
   * restores the old single global tilt, which is the defect the user
   * photographed four times — every ellipse in the frame at one angle.
   */
  crestDirectionSwing: number;
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
   * PIXELS per foam texel at which a tier is still worth reading. Storage
   * textures have no mips, so a sub-pixel texel read is pure aliasing — below
   * this the coarsest band hands over to its pre-filtered tier and the finer
   * bands fade out.
   *
   * Measured against `fwidth` of the sample coordinate, NOT against camera
   * distance. The distance form (`cascadeFadeTexels`, 2300 texel widths) could
   * not see the grazing stretch, so from the high camera the user shot it left
   * cascade 1 fully weighted at 300 m altitude where one pixel already covered
   * 0.234 m against a 0.191 m texel — a frame full of hard 1–3 m specks. 2 is
   * Nyquist and is the same constant ship/bandLimit uses, for the same reason:
   * at one pixel per feature, neighbouring samples still straddle it whole.
   */
  tierKeepPixels: number;
  /** multiplier from full weight to fully retired (≥ 1.05) */
  tierFadeSpan: number;
  /**
   * 0..1 — how much the far-field fade also removes foam COVERAGE, not just
   * its detail. 0 = off (default): distant whitecaps stay as lighter sea.
   * Raise only if the horizon still reads too white after the detail fade.
   */
  farFoamFade: number;
  /**
   * Low-residue knee, in raw sim-mask units: foam below `residueKneeLow`
   * is cut entirely, foam above `residueKneeHigh` passes at full strength.
   * Its job is real — a few percent of foam mixed over deep teal reads as a
   * dirty beige smudge, not as thin foam (§V20 critique).
   *
   * TUNABLE, not a shader literal, because it is the SECOND gate in series
   * with the injection gate and the two have to be moved together. Hard-coded
   * at (0.03, 0.12) it silently cancelled the injection fix during this
   * rework: raising coverage put more foam through the jacobian gate and this
   * knee zeroed all of it, which reads exactly like "the fix did nothing".
   * If injectStrength or decayHalfLife move, check this (§V16).
   */
  residueKneeLow: number;
  residueKneeHigh: number;
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
    injectFineCascade: 1,
    capVariationScale: 0.008,
    capVariationStrength: 0.55,
    crestElongation: 2.0,
    // ~170 m per swing, ±57°: measured cap orientation spread goes from 3.9°
    // (one global axis) to >20° once the injection carries the shape too
    crestDirectionScale: 0.006,
    crestDirectionSwing: 2.0,
    sheetKnee: 0.7,
    sheetBroaden: 0.35,
    sheetFlatten: 0.5,
    tierKeepPixels: 2,
    tierFadeSpan: 2,
    detailFadeFeatures: 260,
    detailFadeSpan: 3.5,
    farFoamFade: 0,
    // deliberately the SAME numbers the shader literal held: this change makes
    // the knee reachable, it does not move it. Loosening it at the same time as
    // fixing the injection gate would have put two unmeasured changes into one
    // coverage report — and coverage is exactly what is under dispute.
    residueKneeLow: 0.03,
    residueKneeHigh: 0.12,
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
    capVariationScale: { min: 0.001, max: 0.2, step: 0.001 },
    capVariationStrength: { min: 0, max: 1, step: 0.05 },
    crestElongation: { min: 1, max: 8, step: 0.1 },
    crestDirectionScale: { min: 0.0005, max: 0.05, step: 0.0005 },
    crestDirectionSwing: { min: 0, max: 6.28, step: 0.05 },
    sheetKnee: { min: 0.1, max: 1, step: 0.01 },
    sheetBroaden: { min: 0.05, max: 1, step: 0.01 },
    sheetFlatten: { min: 0, max: 1, step: 0.01 },
    tierKeepPixels: { min: 0.5, max: 12, step: 0.25 },
    tierFadeSpan: { min: 1.05, max: 6, step: 0.05 },
    detailFadeFeatures: { min: 10, max: 2000, step: 10 },
    detailFadeSpan: { min: 1.05, max: 10, step: 0.05 },
    farFoamFade: { min: 0, max: 1, step: 0.05 },
    residueKneeLow: { min: 0, max: 0.5, step: 0.005 },
    residueKneeHigh: { min: 0.005, max: 1, step: 0.005 },
  };
}
