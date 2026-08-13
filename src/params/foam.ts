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
   *
   * THIS IS THE RESIDUE CLOCK ONLY. It used to be the only clock, and that is
   * what made the mask read as dwell time rather than breaking intensity —
   * see foamMath, "THE MASK WAS DWELL TIME". Raising it to buy the trailing
   * look (§T.41) measurably makes crest placement WORSE (foam mass in the top
   * 30% of the sea by elevation: 45.4% at 0.9 s, 36.9% at 2.0 s); the
   * trailing look has to come from somewhere else.
   */
  decayHalfLife: number;
  /**
   * Seconds for the BREAKING channel to halve — the second clock (§B, user:
   * "we don't see a bias towards the higher and steeper cresting having the
   * foam"). Same injection, ~6× shorter memory, so this channel is a RATE:
   * it cannot integrate long enough to drift off the crest that made it.
   *
   * MEASURED, not tasted. Shaded foam mass in the top 30% of the sea by
   * elevation, at `residueWeight` 0.30 (shipped 0.9 s single-clock = 58.8%):
   *   0.08 s → 84.4%   0.15 s → 81.1%   0.25 s → 74.0%   0.40 s → 66.3%
   * against total shaded foam mass of 0.0136 / 0.0150 / 0.0172 / 0.0195
   * (shipped 0.0160). 0.15 s is the knee: it buys 22 points of crest bias for
   * 6% of the foam, where 0.08 s buys 3 more points for another 9%.
   */
  breakingHalfLife: number;
  /**
   * How much of the long-lived residue channel reaches the visible mask.
   *
   * 1 = the pre-split behaviour EXACTLY (with `breakingWeight` 0), which is
   * what makes this a clean A/B. Below 1 the residue reads as what it is —
   * older, thinner foam left behind a breaker — instead of carrying the same
   * weight as water that is breaking right now.
   *
   * IT IS THE LEVER, and the measurement says so: adding the breaking channel
   * ADDITIVELY (residueWeight 1) moved the shaded crest share only 58.8% →
   * 63.2%, because the trough residue it was competing with stayed. Sweeping
   * the residue down instead: 0.50 → 74.5%, 0.30 → 81.1%, 0.15 → 86.0%,
   * 0.00 → 89.7%. 0.30 keeps 94% of the shipped foam mass; below that the sea
   * starts losing the real trailing residue along with the defect.
   */
  residueWeight: number;
  /**
   * Weight of the BREAKING channel in the mask, on the residue's own scale
   * (foamMath.breakingGain does the normalisation, so this stays a mix factor
   * at any half-life). 0 = pre-split behaviour exactly.
   */
  breakingWeight: number;
  /**
   * How hard the elevation of the OTHER cascades biases this band's fold gate,
   * in σ(λ−) per σ(sea height) — the long-wave straining term (§V36: σ-relative
   * on both sides, never an absolute metre constant).
   *
   * WHY: each lane injects from its own band's jacobian only, so measured
   * r(foam of the 98 m band, elevation of the 1010 m band) = 0.04–0.12 — the
   * 8–40 m caps are blind to the swell they ride on, and real whitecapping is
   * not band-separable. sprayMath.crestHeightThreshold is the same quantity as
   * a hard gate; foam takes it as a soft bias because it is a continuous field.
   *
   * Shaded crest share (top 30% / top 10%), on top of the breaking channel:
   *   0 → 81.1% / 61.6%   0.5σ → 92.4% / 76.1%   1.0σ → 92.9% / 79.1%
   *   2.0σ → 93.3% / 80.6%
   * 0.5 is the knee of the top-30 curve and the cheapest in foam removed.
   */
  crestBiasSigma: number;
  /**
   * WORLD METRES of the coarsest cell of the per-texel BREAKUP field — the
   * thing that decides how big a whitecap is (§B, user: "we are still very
   * patchy on the foam cresting, we are still huge blobs").
   *
   * A CAP USED TO BE THE SIZE OF THE BAND THAT MADE IT. Measured on the
   * realised field, the connected components of {λ− < gate} ran 21.7 m median
   * and 70.5 m max in cascade 0 against 2.8 m in cascade 1 and 0.2 m in
   * cascade 2 — because a super-level set of a band-limited field has that
   * band's own scale, and cascade 0 holds 40 m waves and longer. Nothing
   * downstream was growing them; they were born that size. This field raises
   * the gate per texel so a 40 m breaking zone deposits foam in metre-scale
   * islands inside itself.
   *
   * A LENGTH, not a frequency, so each band takes as many octaves as its own
   * texels can carry (foamMath.breakupOctaves — §V.48 measured against the sim
   * grid, since a StorageTexture has no mip chain). The octave COUNT is baked
   * at construction like every other octave count here; moving this live
   * rescales the field without rebuilding the node graph.
   */
  breakupMetres: number;
  /**
   * Amplitude of that jitter in σ(λ−) — σ-relative on both sides (§V36) so it
   * means the same in calm and storm. 0 restores the un-broken gate exactly.
   *
   * MEASURED on the shipped 512² grid at the screenshot's own 0.6 m/px, cap
   * extents in world metres (median / p90 / max):
   *   0            6.2 / 34.0 / 44.2
   *   1.5σ @ 12 m  4.3 / 10.8 / 38.7
   *   2.0σ @ 16 m  7.2 / 17.7 / 28.7
   *   2.5σ @ 16 m  8.0 / 14.9 / 27.6      ← shipped
   * The >35 m AREA SHARE is the statistic the complaint is about but it is
   * carried by a handful of giant components and swings 23–43% between time
   * samples on the same build, so the SHIPPED value is chosen on p90 and max,
   * which are stable. At 2.5σ/16 m no cap reaches the 35 m hull length.
   * Costs 14% of the foam (mean alpha 0.0095 against 0.0110) — raise
   * `injectStrength` if the sea wants it back.
   */
  breakupSigma: number;
  /**
   * Domain-warp amplitude of the breakup field, in units of one cell.
   *
   * NOT optional decoration: value noise has ROUND LEVEL SETS (§B.39), so
   * without the warp this bites round holes and leaves round islands — the
   * exact defect that made foam read as discs one stage downstream. Bending
   * the sample coordinate by a field with no period of its own is the same
   * cure the ocean's wavelet lattice took (`9bf32d7`), at a different scale.
   */
  breakupWarp: number;
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
  /**
   * WORLD METRES the foam art texture repeats over for the CREST lookup — the
   * talk's "high frequency foam texture at the crest of the wave" (§T.5 stage
   * 3). A metre length, not a frequency: every other band-limit quantity in
   * this file is a length or a pixel count, and the §V.48 feature width the
   * dissolve is gated against is `this / FOAM_BREAKUP_CELLS`.
   *
   * At 6 m the texture's 26-cell bubble raft draws ≈23 cm bubble clusters and
   * its 52-cell one ≈12 cm, which is the scale of the lace on a breaking lip
   * in docs/ref-video-foam-2.jpg. Raise it and the crest reads as a coarse
   * curdle; lower it and the repeat becomes visible on a big patch.
   */
  artCrestMetres: number;
  /**
   * WORLD METRES for the SOFT lookup — "a lower frequency texture as it blends
   * out". Deliberately NOT a small multiple of `artCrestMetres`: the two are
   * reads of the SAME texture, so a 2× or 4× ratio would line their features
   * up and draw a visible nested grid. 28/6 ≈ 4.67 keeps them incommensurate.
   */
  artSoftMetres: number;
  /**
   * How deeply the art texture's breakup channel EATS INTO the sim mask before
   * the coverage gate, in raw mask units. This is the knob that decides
   * whether foam has a torn outline or a blurred one.
   *
   * 0 reproduces the pre-art-texture gate exactly (`smoothstep(kneeLow,
   * kneeHigh, mask)`), which is what makes it a safe A/B. Above 0 the gate's
   * threshold varies per texel over [kneeLow, kneeLow + erodeDepth]: a texel
   * whose mask value is m survives with probability m/erodeDepth, so the
   * SKIRT of every patch is torn into filaments while the core — where the
   * mask is already above erodeDepth — stays solid. That asymmetry is the
   * point; real foam is dense in the middle and ragged at the edge, and an
   * erosion that ate the core would just be a thinner disc.
   *
   * IT COSTS COVERAGE, and the number is measured rather than hoped: on a
   * gaussian-disc fixture (which is exactly the shape the isotropic blur
   * produces) mean alpha falls 0.478 → 0.337 at 0.22, i.e. −29%, because the
   * threshold's mean rises from the knee midpoint to kneeLow + depth/2. That
   * is a real trade — the coverage it removes is the soft skirt, which is the
   * "painted-on" ring — but it must not be silent, so `residueKneeLow/High`
   * were lowered in the same change to bring the fixture back to 0.91× (see
   * them). Anything left over is deliberate.
   */
  erodeDepth: number;
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
    // the second clock + its mix — see the fields for the measured sweeps
    breakingHalfLife: 0.15,
    residueWeight: 0.3,
    breakingWeight: 1.0,
    crestBiasSigma: 0.5,
    breakupMetres: 16,
    breakupSigma: 2.5,
    breakupWarp: 0.35,
    blurRadius: 1.0,
    // = the smallest injected minor axis measured across bands and presets
    // (cascade 1 at swell, 0.72 m), so no band's caps are re-rounded
    blurSpreadMetres: 0.6,
    artCrestMetres: 6.0,
    artSoftMetres: 28.0,
    erodeDepth: 0.22,
    tintWarmth: 0.12,
    uvWarpScale: 0.12,
    uvWarpMeters: 1.4,
    detailScrollSpeed: 0.05,
    injectFineCascade: 1,
    capVariationScale: 0.008,
    capVariationStrength: 0.55,
    // 1 = ISOTROPIC, and it has to stay there now. `crestAnisoCoord` maps
    // detail into a rotate-then-stretch space whose ANGLE FIELD VARIES IN
    // SPACE, so above 1 it is not a 2:1 stretch, it is a shear whose local
    // anisotropy is far larger than the nominal ratio. The old value-noise
    // fbm was low-contrast and round, so that shear read as mild texture.
    // The art texture's crest channel is a worley WALL NETWORK — thin,
    // high-contrast lines — and dragging those through a varying angle field
    // combs them into long curving flow-lines across the whole sea (user
    // report + docs/bug-foam-streaks-topdown.jpeg). The dissolve threshold is
    // sampled through the same space, so it combed the SILHOUETTE too,
    // undoing the torn contour the art texture exists to provide.
    // Measured: 2 → 1 removes the combing completely and the cellular
    // structure underneath lands much closer to ref-video-foam-1/2.jpg;
    // 1.4 still combs. Raise this only if the detail is round again.
    crestElongation: 1.0,
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
    // MOVED, once, with the number measured (was 0.03 / 0.12 — "deliberately
    // the same numbers the shader literal held"). The dissolve (`erodeDepth`)
    // sits in series with this knee and raises the MEAN threshold from the
    // knee midpoint to kneeLow + depth/2, so leaving the knee where it was
    // would have shipped a −29% coverage change wearing a shape change's
    // clothes. At 0.005 / 0.03 the same fixture reads 0.91× the old coverage,
    // and the gate is now mostly the dissolve — which is the point: thin foam
    // survives in PATCHES where the art texture allows it instead of as a
    // uniform ring of residue.
    residueKneeLow: 0.005,
    residueKneeHigh: 0.03,
  },
  foamParamsMeta(),
);

function foamParamsMeta(): Partial<Record<keyof FoamParams, ParamMeta>> {
  return {
    injectStrength: { min: 0, max: 20, step: 0.1 },
    decayHalfLife: { min: 0.05, max: 10, step: 0.05 },
    breakingHalfLife: { min: 0.02, max: 2, step: 0.01 },
    residueWeight: { min: 0, max: 1, step: 0.01 },
    breakingWeight: { min: 0, max: 4, step: 0.05 },
    crestBiasSigma: { min: 0, max: 4, step: 0.05 },
    breakupMetres: { min: 2, max: 60, step: 0.5 },
    breakupSigma: { min: 0, max: 6, step: 0.05 },
    breakupWarp: { min: 0, max: 1.5, step: 0.05 },
    blurRadius: { min: 0, max: 4, step: 0.25 },
    blurSpreadMetres: { min: 0, max: 8, step: 0.05 },
    artCrestMetres: { min: 0.5, max: 40, step: 0.25 },
    artSoftMetres: { min: 2, max: 200, step: 0.5 },
    erodeDepth: { min: 0, max: 1, step: 0.01 },
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
