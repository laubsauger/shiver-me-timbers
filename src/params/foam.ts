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
  /**
   * How far, IN WORLD METRES, the progressive blur is allowed to spread a cap
   * over its visible life (σ of the accumulated diffusion). Each band solves
   * for its own per-tick kernel weight from this and its own texel size
   * (foamMath.blurMixPerStep), so the diffusion is one physical process at one
   * rate instead of three grid-dependent ones.
   *
   * THIS NUMBER IS DERIVED, NOT TASTED. An isotropic diffusion adds the same
   * variance to both axes, so it drives ANY shape to a disc — the only
   * question is how fast relative to the feature. Measured on the real
   * spectrum at full resolution, the injected cap's MINOR axis is 2.65 m in
   * cascade 0 and 0.72 m in cascade 1 (swell; 5.09 / 0.93 at storm). A spread
   * at or below the smallest of those keeps ~75% of the injected aspect
   * everywhere; above it the blur wins and every cap is a dot. It was
   * effectively 12.27 m in cascade 0 — 4.6× that band's own cap — which is
   * why the user photographed round discs from directly above while the
   * injection measured aspect 3.3 at 18.5° of spread.
   *
   * Raise it and caps soften and merge; lower it and the sim texture's own
   * texel grid starts to read (cascade 0's texel is 1.97 m — `uvWarpMeters`
   * is the thing that hides it).
   */
  blurSpreadMetres: number;
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
   * else. Keep it well below every cascade domain (1010/98/22.7 m — cascade 0
   * grew from 420 m to carry the 189 m swell train) so it adds no repeat of
   * its own; its whole job is to destroy one.
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
   * PIXELS the COARSEST detail layer (1/mottleScale metres) must still span
   * for the detail composite to be worth evaluating at all.
   *
   * IT WAS A CAMERA DISTANCE, and that is the whole "very much view-angle
   * dependent" report. The old form faded detail out between 108 m and 379 m
   * of camera distance, which is a statement about a grazing camera and
   * nothing else: from the near-vertical camera in docs/bug-foam-topdown.jpeg
   * (~620 m altitude) EVERY pixel of sea is past 379 m, so the fade was fully
   * engaged over the entire frame and the crackle/mottle layers — the only
   * things breaking the sim mask's smooth blobs into foam — were multiplied
   * out completely. What is left is the raw blurred mask, i.e. discs. Measured
   * detailFade: 1.000 at a 20 m deck camera, 0.936 at 150 m, 0.206 at a 300 m
   * top-down, 0.000 at 620 m.
   *
   * This is the FOURTH gate in this project keyed on distance where the real
   * quantity is the PIXEL FOOTPRINT (after `cascadeFadeTexels`, the ocean
   * sparkle cells and the sand sparkle). A footprint knows about the grazing
   * stretch AND about altitude; a distance knows about neither. 2 is Nyquist,
   * the same constant `tierKeepPixels` and ship/bandLimit use.
   */
  detailKeepPixels: number;
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
    // = the smallest injected minor axis measured across bands and presets
    // (cascade 1 at swell, 0.72 m), so no band's caps are re-rounded
    blurSpreadMetres: 0.6,
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
    detailKeepPixels: 2,
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
    blurSpreadMetres: { min: 0, max: 8, step: 0.05 },
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
    detailKeepPixels: { min: 0.5, max: 12, step: 0.25 },
    detailFadeSpan: { min: 1.05, max: 10, step: 0.05 },
    farFoamFade: { min: 0, max: 1, step: 0.05 },
    residueKneeLow: { min: 0, max: 0.5, step: 0.005 },
    residueKneeHigh: { min: 0.005, max: 1, step: 0.005 },
  };
}
