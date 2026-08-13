/**
 * Foam shading TSL nodes — §V6's third stage, and the one this project had
 * never actually built (talk 07:49: "we blend this with artist authored foam
 * textures; we have a high frequency foam texture at the crest of the wave,
 * and then we blend to a lower frequency texture as it blends out").
 *
 * The sim mask (foamPasses) is a gaussian-blurred accumulator. This module
 * turns it into foam, and it does TWO things with the art texture, not one:
 *
 *  - the BODY: crest lace on fresh foam → soft mottle as it dissipates, a
 *    multiply on the mask's interior. This is what the old crackle/mottle fbm
 *    layers did, done with a texture that has foam's structure in it.
 *  - the SILHOUETTE: the art texture's breakup channel is a DISSOLVE
 *    THRESHOLD, subtracted from the mask before the coverage gate. This half
 *    is new, and it is the answer to "blotchy, reads as discs". Modulating the
 *    interior of a disc leaves a disc — the eye reads the OUTLINE, and the
 *    outline was a level set of an isotropic gaussian blur, which is a circle
 *    by construction. Now it is the art texture's own torn contour.
 *
 * AGE IS MEASURED, NOT PROXIED. This module used to read the foam VALUE as
 * freshness ("injection writes ~1 at crests and decay only lowers it"), and
 * that claim was simply untrue — the accumulator needs ~100 ticks to reach 0.3
 * against a 77-tick mean visible age, so the value was DWELL TIME. The sim now
 * carries a second, short-clock BREAKING channel (foamPasses, and foamMath
 * "THE MASK WAS DWELL TIME"); `foamDetailMask` takes its share of the mask as
 * the freshness and falls back to the old proxy only for callers without one.
 *
 * Anti-boxiness (§V20 user critique "patchy squares, frozen"):
 * - foamWarpVec: fbm domain-warp offset (world meters) applied to the sim
 *   texture LOOKUP so texel edges never read as straight grid lines.
 * - the art lookups scroll with slight counter-motion, so standing foam churns
 *   instead of reading as a frozen decal.
 *
 * §V48 the art texture carries a mip chain, which supplies the FADE-TO-MEAN
 * half for free; the WIDEN half is explicit at every gate below, measured
 * against the FEATURE's own width (§B.20 — never against the repeat).
 *
 * §V23: functional mix(a,b,t)/smoothstep(e0,e1,x) only for 3-arg math.
 * §V20: warm-tinted foam via foamTintNode.
 */
import {
  float,
  fwidth,
  mix,
  smoothstep,
  texture,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import type * as THREE from 'three/webgpu';
import { fbm2, valueNoise2 } from '../terrain/noise';
import type { FoamParams } from '../params/foam';
import { FOAM_BREAKUP_CELLS, FOAM_SOFT_CELLS } from './foamPattern';
import { foamArtTexture } from './foamTexture';

const uArtCrestMetres = uniform(6.0);
const uArtSoftMetres = uniform(28.0);
const uErodeDepth = uniform(0.22);
const uTintWarmth = uniform(0.12);
const uWarpScale = uniform(0.12);
const uWarpMeters = uniform(1.4);
const uScroll = uniform(0.05);
const uCapVarScale = uniform(0.03);
const uCapVarStrength = uniform(0.8);
const uTime = uniform(0);
const uElong = uniform(3.0);
const uSheetKnee = uniform(0.7);
const uSheetBroaden = uniform(0.35);
const uSheetFlatten = uniform(0.5);
const uDetailKeepPixels = uniform(2);
const uDetailFadeSpan = uniform(3.5);
const uFarFoamFade = uniform(0);
const uKneeLow = uniform(0.005);
const uKneeHigh = uniform(0.03);
const uCrestDirScale = uniform(0.006);
const uCrestDirSwing = uniform(2.0);
// unit wave-propagation direction (world XZ) — crest lines run ACROSS it.
// Two scalar uniforms, not a vec2: this module imports three only as a TYPE,
// and `uniform(vec2(...))` would seed the uniform with a NODE whose .value
// has no .x/.y to write — the direction would silently never update.
const uPropX = uniform(1);
const uPropZ = uniform(0);

/**
 * Octaves of the world-space cap-strength field.
 *
 * FOUR, not two, and the number is load-bearing. A 2-octave value-noise field
 * has its maxima very near its lattice cell centres: measured nearest-
 * neighbour spacing CV 0.292 against 0.523 for a fully random (Poisson) point
 * process — i.e. the field that exists to BREAK the FFT lattice was imposing a
 * quasi-regular ~25 m lattice of its own, which is "evenly spaced" in the user's
 * four frames. At 4 octaves the same measurement reads 0.401, most of the way
 * back to random, because the finer octaves move each maximum off its cell.
 */
const CAP_VAR_OCTAVES = 4;

/** push live param values + sim time into the shading uniforms (per tick) */
export function updateFoamShadingUniforms(
  p: FoamParams,
  time?: number,
  windDirRadians?: number,
): void {
  uArtCrestMetres.value = Math.max(0.25, p.artCrestMetres);
  uArtSoftMetres.value = Math.max(1, p.artSoftMetres);
  uErodeDepth.value = Math.min(1, Math.max(0, p.erodeDepth));
  uTintWarmth.value = p.tintWarmth;
  uWarpScale.value = p.uvWarpScale;
  uWarpMeters.value = p.uvWarpMeters;
  uScroll.value = p.detailScrollSpeed;
  uCapVarScale.value = p.capVariationScale;
  uCapVarStrength.value = p.capVariationStrength;
  uElong.value = Math.max(1, p.crestElongation);
  uCrestDirScale.value = Math.max(1e-4, p.crestDirectionScale);
  uCrestDirSwing.value = Math.max(0, p.crestDirectionSwing);
  uSheetKnee.value = p.sheetKnee;
  uSheetBroaden.value = p.sheetBroaden;
  uSheetFlatten.value = p.sheetFlatten;
  uDetailKeepPixels.value = Math.max(0.5, p.detailKeepPixels);
  uDetailFadeSpan.value = Math.max(1.05, p.detailFadeSpan);
  uFarFoamFade.value = p.farFoamFade;
  // ordered pair: a low ≥ high inverts the smoothstep and the knee becomes a
  // high-pass that deletes the STRONG foam instead of the residue
  uKneeLow.value = Math.max(0, p.residueKneeLow);
  uKneeHigh.value = Math.max(uKneeLow.value + 1e-4, p.residueKneeHigh);
  if (time !== undefined) uTime.value = time;
  if (windDirRadians !== undefined && Number.isFinite(windDirRadians)) {
    uPropX.value = Math.cos(windDirRadians);
    uPropZ.value = Math.sin(windDirRadians);
  }
}

/** any TSL node */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNode = any;

/**
 * Screen-space footprint of a world-XZ coordinate, as a scalar in that
 * coordinate's own units — |∂c/∂x| + |∂c/∂y|, the same quantity
 * ship/bandLimit.coordFilter measures for a scalar pattern coordinate.
 * This, not camera distance, is what a band limit must be measured against:
 * distance ignores the grazing stretch, and from a high camera the stretch is
 * the whole story (a 3× stretch moves the aliasing onset from 60 m to 20 m).
 */
export function coordFootprint(coord: AnyNode): AnyNode {
  return coord.dFdx().length().add(coord.dFdy().length());
}

/**
 * fbm whose every octave fades to its OWN MEAN once that octave's lattice
 * cell is narrower than {@link FILTER_CELLS} pixels — §V48(b), done per
 * octave rather than per field.
 *
 * WHY PER OCTAVE, and why this was the grit (§V48's SIXTH-occurrence lesson
 * applied here): the field's fade must be measured against its SHARPEST
 * feature, not its repeat. The crackle layer this replaced had a base cell of
 * 1/2.4 = 0.42 m but a third octave of 0.104 m, four times finer, and its guard was
 * a camera-DISTANCE fade computed from the base cell — it began at 108 m while
 * the third octave went sub-pixel at 60 m head-on and at ~20 m from a high
 * camera. Everything between was guaranteed per-pixel dither, over the whole
 * visible sea, which is precisely the "gritty/stippled" report.
 *
 * Fading to the mean rather than to zero is the point: the mean IS the average
 * that pixel should have seen, so coverage is conserved and only detail is
 * lost. Fading to zero would make distant water change brightness with camera
 * height instead of just going smooth.
 */
export function bandLimitedFbm2(
  coord: AnyNode,
  octaves: number,
  footprint: AnyNode,
): AnyNode {
  let sum: AnyNode = float(0);
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const freq = 2 ** i;
    const amp = 0.5 ** i;
    // one lattice cell of this octave is 1/freq in `coord` units, so its
    // footprint in cells is footprint·freq. Keep it while a cell still spans
    // FILTER_CELLS pixels; fade out over the next octave (e0 > e1 → 1 below).
    const cells = footprint.mul(freq);
    // @band-limited-elsewhere: this IS the band limit. `footprint` is a screen
    // footprint (coordFootprint = dFdx+dFdy), so the gate's argument is
    // already measured in pixels per lattice cell — the §V.48 quantity itself.
    const keep = smoothstep(float(1), float(0.5), cells);
    const octave = mix(float(0.5), valueNoise2(coord.mul(freq)), keep);
    sum = sum.add(octave.mul(amp));
    norm += amp;
  }
  return sum.div(norm);
}

/**
 * Anisotropic noise coordinate (user critique "caps too circular"): compress
 * the coordinate ALONG the crest tangent so every noise feature drawn in this
 * space comes out elongated along the crest and short across it.
 *
 * THE DIRECTION IS A FIELD, NOT A CONSTANT (user, four frames: "every cap has
 * the same orientation — all the ellipses tilt the same way across the entire
 * frame"). It used to be exactly `perp(windDirection)` everywhere, which put a
 * single tilt on every streak in the world at full screen resolution — the
 * same defect the blur kernel had, one level further down the pipe and far
 * more visible because it is not blurred away. Real crest lines meander by
 * tens of degrees across a frame, so the propagation axis is turned here by a
 * slow world-space angle field (a few hundred metres per swing, well below any
 * cascade domain so it adds no repeat of its own).
 */
export function crestAnisoCoord(coord: AnyNode): AnyNode {
  const angle = fbm2(coord.mul(uCrestDirScale), 2).sub(0.5).mul(uCrestDirSwing);
  const ca = angle.cos();
  const sa = angle.sin();
  // rotate the unit propagation direction — still unit length, so the frame
  // below stays orthonormal and the elongation stays a pure shape change
  const prop = vec2(uPropX.mul(ca).sub(uPropZ.mul(sa)), uPropX.mul(sa).add(uPropZ.mul(ca)));
  const tan = vec2(prop.y.negate(), prop.x); // perp(prop) — along the crest
  const along = coord.dot(tan).div(uElong.max(1)); // floored divisor (§V28)
  const across = coord.dot(prop);
  return tan.mul(along).add(prop.mul(across));
}

/**
 * Non-tiling world-space cap strength (§B.4 class fix): the FFT foam field
 * repeats per cascade domain, so without this every tile's caps are clones
 * on a perfect grid, breathing in sync. Low-freq fbm over ABSOLUTE world XZ
 * (never wrapped) scales each cap by where it lives; a slow drift means a
 * given lattice site strengthens/weakens over time — per-site lifecycles.
 * Range [1−strength, 1+0.25·strength], mean slightly under 1.
 *
 * Broadband (CAP_VAR_OCTAVES) and band-limited: it is itself a periodic
 * procedural term, and a 2-octave version substituted its own ~25 m lattice
 * for the FFT one — see CAP_VAR_OCTAVES.
 */
export function capVariationNode(worldXZ: AnyNode): AnyNode {
  const drift = uTime.mul(0.013);
  const c = worldXZ.mul(uCapVarScale).add(vec2(drift, drift.mul(-0.6)));
  const n = bandLimitedFbm2(c, CAP_VAR_OCTAVES, coordFootprint(c));
  return mix(float(1).sub(uCapVarStrength), float(1).add(uCapVarStrength.mul(0.25)), n).max(0);
}

/**
 * fbm domain-warp offset in world meters for the sim-texture lookup —
 * breaks the texel grid of the low-res foam RT (drifts slowly with time so
 * eddies read as pushed-around, not baked).
 */
export function foamWarpVec(coord: AnyNode): AnyNode {
  const drift = uTime.mul(uScroll).mul(0.5);
  const wx = fbm2(coord.mul(uWarpScale).add(vec2(drift, 0)), 2);
  const wy = fbm2(coord.mul(uWarpScale).add(vec2(17.3, 9.1)).sub(vec2(0, drift)), 2);
  return vec2(wx, wy).sub(0.5).mul(uWarpMeters);
}

/**
 * Detail-modulated foam mask from a raw sim value and a noise coordinate
 * (world XZ preferred — continuous across cascade tile seams).
 * Output scalar mask in [0, 1] for the surface material's crest mix.
 */
export function foamDetailMask(
  rawFoam: AnyNode,
  coord: AnyNode,
  /**
   * MEASURED freshness in [0,1] — the breaking channel's share of this mask
   * (foam/index.shadingNode). Optional because the wake foam (§V.10) has no
   * such channel and the surface material passes two arguments; when it is
   * absent the old VALUE proxy is used, which is also what makes
   * `breakingWeight = 0` reproduce the pre-split look bit for bit.
   */
  breakingShare?: AnyNode,
): AnyNode {
  const art = foamArtTexture();
  // per-position phase (§B.4: NO shared global timeline) — coarse value
  // noise gives nearby points a common offset but distant caps their own
  const phase = valueNoise2(coord.mul(0.021)).mul(37.0);
  const t = uTime.add(phase).mul(uScroll);
  // shared low-freq churn warps both lookups (internal motion)
  const churn = foamWarpVec(coord).mul(0.6);
  // crest-aligned sample space: the art texture is STRETCHED along the ridge,
  // which is what turns its cells into the streaks the reference shows running
  // down a wave face. The stretch axis is a FIELD, not one global vector
  // (§B.33 (c) — a single tilt on every streak in the world is the lattice).
  const aniso = crestAnisoCoord(coord.add(churn));

  // COVERAGE-ADAPTIVE SCALE (user, storm preset: "blobby noise in parts").
  // Detail texture that reads well at 10% coverage reads as high-frequency
  // noise when the whole sea is foaming. Where foam SATURATES, broaden the
  // detail into wind-driven sheets and flatten its contrast — §V7 asks storm
  // for big patches, and the reference storm foam is broad streaks running
  // with the swell, not 30 cm mottle stretched over everything.
  const sheetN = smoothstep(uSheetKnee, float(1.0), rawFoam);
  const broaden = mix(float(1), uSheetBroaden.max(0.05), sheetN);

  // ONE TEXTURE, TWO WORLD SCALES — the talk's crest/soft pair. Both reads hit
  // the SAME texture object, so they dedupe to one binding and ONE SAMPLER
  // (§V.40 hashes on `value.uuid`); two texture objects would have cost both
  // of the ocean's spare samplers for one feature. Broadening DIVIDES the
  // repeat, so a saturated storm sea draws the same texture bigger rather than
  // a different one (§V7: presets touch params, never code paths).
  const crestMetres = uArtCrestMetres.max(0.25).div(broaden.max(0.05));
  const softMetres = uArtSoftMetres.max(1).div(broaden.max(0.05));
  const crestTex = texture(art, aniso.div(crestMetres).add(vec2(t, t.mul(-0.7))));
  const softTex = texture(art, aniso.div(softMetres).sub(vec2(t.mul(0.4), t.mul(-0.3))));

  // AGE. It used to be the foam VALUE standing in for an age nothing measured
  // ("injection writes ~1 at crests and decay only lowers it") — and that was
  // false: the accumulator needs ~100 ticks to reach 0.3 against a 77-tick
  // mean visible age, so the value was DWELL TIME, not freshness, and a weak
  // long fire read identical to a violent short one (foamMath, "THE MASK WAS
  // DWELL TIME"). The breaking channel measures it directly; the proxy remains
  // for callers that have no such channel.
  const freshness =
    breakingShare !== undefined
      ? // @band-limited-elsewhere: `breakingShare` is a RATIO of two channels of
        // the same texture sample — dimensionless, with no period and no
        // spatial frequency of its own. Both channels are filtered texture
        // reads already retired against their measured footprint by
        // `tierWeight` (index.shadingNode), and the mask's residual footprint
        // is carried into `softness` below via `fwidth(rawFoam)`.
        smoothstep(float(0.25), float(0.8), breakingShare)
      : smoothstep(float(0.25), float(0.8), rawFoam);
  // BODY — the interior of the patch (R = crest lace, G = soft mottle)
  const textured = mix(softTex.g, crestTex.r, freshness);
  // saturated foam settles toward an unbroken sheet
  const sheeted = mix(textured, float(1), sheetN.mul(uSheetFlatten).clamp(0, 1));

  // FAR-FIELD DETAIL FADE — a BACKSTOP, not the band limit, and now keyed on
  // the PIXEL FOOTPRINT rather than on camera distance.
  //
  // It is kept because it is cheap and because it retires the SOFT channel's
  // very low frequencies, which never alias but stop meaning anything once a
  // whole cap is a pixel wide. The actual anti-aliasing is the art texture's
  // mip chain (§V48, foamTexture.ts).
  //
  // IT USED TO BE `length(coord − cameraPosition.xz)` against 108→379 m, and
  // that is the "very much view-angle dependent" report in one line: distance
  // is a proxy for footprint that is only calibrated for ONE camera. From the
  // near-vertical camera the user shot docs/bug-foam-topdown.jpeg from (~620 m
  // altitude) every pixel of sea is past 379 m, so this multiplied the entire
  // detail composite out of the frame and left the bare blurred sim mask —
  // measured detailFade 1.000 / 0.936 / 0.206 / 0.000 at a 20 m deck camera,
  // 150 m grazing, a 300 m top-down and a 620 m top-down. Meanwhile the actual
  // footprint from that camera is well under a metre, i.e. the detail resolved
  // perfectly and was deleted anyway. Fourth occurrence of distance-for-
  // footprint in this project (`cascadeFadeTexels`, ocean sparkle, sand
  // sparkle). Measured against the COARSEST layer in the composite (the soft
  // channel's own base cell), because this gate retires the WHOLE composite —
  // the sharp end is handled by the texture's mip chain.
  const pixelMetres = coordFootprint(coord);
  const featureMetres = softMetres.div(FOAM_SOFT_CELLS);
  const keepMetres = featureMetres.div(uDetailKeepPixels.max(0.5));
  // e0 > e1 → 1 while a cell still spans the keep width, 0 once it is smaller
  // than one pixel by `detailFadeSpan` (§V23: functional smoothstep)
  // @band-limited-elsewhere: this IS the band limit. `pixelMetres` is
  // coordFootprint(coord) = dFdx+dFdy, i.e. the measured screen footprint, and
  // the thresholds are the FEATURE's own world size (§B.20: never the repeat).
  const detailFade = smoothstep(
    keepMetres.mul(uDetailFadeSpan.max(1.05)),
    keepMetres,
    pixelMetres,
  );
  const detail = mix(float(1), sheeted, detailFade);

  // ── THE DISSOLVE: the art texture carves the SILHOUETTE ─────────────────
  //
  // This is §T.5's missing mechanism, and it is the answer to "blotchy, reads
  // as discs". Every previous foam pass modulated the INTERIOR of the patch
  // and left its outline alone — but the outline is a level set of an
  // ISOTROPIC GAUSSIAN BLUR, which is a circle by construction (foamMath,
  // "THE BLUR WAS THE SHAPE"), and a textured disc still reads as a disc.
  // Here the coverage gate's THRESHOLD is a per-texel value from the art
  // texture's breakup channel instead of a constant, so the boundary is that
  // channel's own domain-warped, worley-torn contour. Fresh foam dissolves
  // against the fine crest lookup (fine filaments at a breaking lip); old foam
  // against the soft one (broad ragged patches in the trail) — the same
  // crest→soft interpolation the body uses, applied to the shape.
  //
  // The threshold FLOOR is the low-residue knee, unchanged in meaning: a few
  // percent of foam mixed over deep teal reads as a dirty beige smudge, not as
  // thin foam (§V20 critique). TUNABLE (§V16) because it sits in SERIES with
  // the jacobian injection gate and the two must be retuned together — as a
  // shader literal at (0.03, 0.12) it once silently swallowed a whole
  // injection fix. `erodeDepth = 0` reproduces the old gate exactly.
  const breakup = mix(softTex.b, crestTex.b, freshness);
  /**
   * 1 while the dissolve's own cells still resolve on screen, 0 once they are
   * sub-pixel. Measured against the FEATURE (one breakup cell), never against
   * the repeat — that mistake is §B.20, and it was 12× too late.
   */
  const cellMetres = mix(softMetres, crestMetres, freshness).div(FOAM_BREAKUP_CELLS);
  // @band-limited-elsewhere: this IS the band limit — `pixelMetres` is the
  // measured screen footprint (dFdx+dFdy) against ONE breakup cell's world
  // size, and the amplitude half is the widening of `softness` below.
  const resolved = smoothstep(cellMetres, cellMetres.mul(0.5), pixelMetres);
  const erode = uErodeDepth.clamp(0, 1);
  // ONE-SIDED — [kneeLow, kneeLow + erode] — and it was tried the other way.
  // A SIGNED, mean-zero shift is the tempting version: it grows tendrils
  // outward as well as tearing holes inward and it is coverage-neutral by
  // construction (measured 0.478 → 0.486 → 0.473 over the depth range). It
  // has to floor the threshold at 0 or it paints foam onto bare water, and
  // that floor puts an ATOM of probability mass at threshold 0 — 43% of texels
  // at the shipped depth — so the sub-pixel average is no longer a ramp but a
  // steep rise to 0.43 followed by a ramp, which no single `smoothstep` is.
  // §V.48(b) went from a 0.045 residual to 0.478, i.e. distant foam coverage
  // would differ from near foam coverage by half. Coverage is instead paid for
  // where it is visible and testable, at `residueKneeLow/High` (params/foam).
  const threshold = uKneeLow.add(breakup.mul(erode).mul(resolved));
  // §V.48(b) — AND THE MEAN THAT MATTERS IS NOT THE FIELD'S. Fading `breakup`
  // to its own mean (0.5, exactly, by construction) would leave a step at a
  // shifted threshold, which is a fade to a hard edge. The average a pixel
  // should see is the average of the GATE: a uniform threshold on [0, d]
  // passes a texel of mask m with probability m/d, so the sub-pixel limit of
  // this dissolve is a RAMP OF WIDTH d. So the widening below carries `d` as
  // the field retires. The two halves meet to 0.045 of alpha — a limit, not an
  // identity; the residual is the cubic ease against a box-convolved ramp and
  // is stated in foamMath.dissolveKnee rather than rounded away.
  // §V.48(a) — plus ≥ 2 px of the mask's own fwidth, so the gate never varies
  // faster than the sample grid. §V.60 — and never narrower than the authored
  // knee, which is the body it multiplies.
  // The retirement term is ADDED to the authored width, not maxed against it:
  // the full-resolution gate is already a ramp of width (kneeHigh − kneeLow),
  // so the average of it over a uniform threshold spanning `erode` has support
  // `erode + that` — a box convolved with a ramp. Maxing leaves the sub-pixel
  // gate NARROWER than the thing it is the average of, and the error goes from
  // 0.045 of alpha to 0.196 (foamMath.dissolveKnee — measured, and tested).
  const softness = uKneeHigh
    .sub(uKneeLow)
    .max(0)
    .add(erode.mul(float(1).sub(resolved)))
    .max(fwidth(rawFoam).mul(2))
    .max(1e-4);
  const knee = smoothstep(threshold, threshold.add(softness), rawFoam);
  // optional far-field COVERAGE softening on top of the detail fade, off by
  // default: reach for this only if the horizon still reads too white once
  // the detail shimmer is gone — it removes real foam, the detail fade does not
  const farSoften = mix(float(1), detailFade, uFarFoamFade.clamp(0, 1));
  return rawFoam.mul(detail).mul(knee).mul(farSoften).clamp(0, 1);
}

/**
 * §V6 helper: final foam mask for ONE cascade texture at its tiling uv.
 * Pass un-fract'd uv (worldXZ / domain) — RepeatWrapping tiles the texture
 * while the detail noise stays continuous across tile boundaries.
 */
export function foamShadingNode(foamTex: THREE.Texture, uv: AnyNode): AnyNode {
  return foamDetailMask(texture(foamTex, uv).r, uv);
}

/** warm foam tint (§V20): mix(white, warm, tintWarmth) — multiply foam color */
export function foamTintNode(): AnyNode {
  return mix(vec3(1.0, 1.0, 1.0), vec3(1.0, 0.92, 0.8), uTintWarmth);
}
