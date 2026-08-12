/**
 * Foam shading TSL nodes (§V6 texture blending, procedural per §I assets):
 * the blurred sim mask blends two detail layers — high-frequency crackle on
 * fresh (high-value) foam, soft low-frequency mottling on dissipated
 * (low-value) foam. The foam value itself is the age proxy: injection writes
 * ~1 at crests and decay+blur only ever lowers it, so value ≈ freshness.
 *
 * Anti-boxiness (§V20 user critique "patchy squares, frozen"):
 * - foamWarpVec: fbm domain-warp offset (world meters) applied to the sim
 *   texture LOOKUP so texel edges never read as straight grid lines.
 * - detail noise layers scroll/evolve over time with slight counter-motion,
 *   so standing foam churns instead of reading as a frozen decal.
 *
 * §V48 EVERY procedural periodic term here is band-limited by `fwidth`, not
 * by distance — see bandLimitedFbm2 and the `uKneeWiden` comment. This module
 * is the "gritty/stippled interiors" half of the four-image foam report; the
 * lattice half lives in foamMath/foamPasses.
 *
 * §V23: functional mix(a,b,t)/smoothstep(e0,e1,x) only for 3-arg math.
 * §V20: warm-tinted foam via foamTintNode.
 */
import {
  float,
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

const uCrackleScale = uniform(3.0);
const uMottleScale = uniform(0.35);
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
const uKneeLow = uniform(0.03);
const uKneeHigh = uniform(0.12);
const uCrestDirScale = uniform(0.006);
const uCrestDirSwing = uniform(2.0);
// unit wave-propagation direction (world XZ) — crest lines run ACROSS it.
// Two scalar uniforms, not a vec2: this module imports three only as a TYPE,
// and `uniform(vec2(...))` would seed the uniform with a NODE whose .value
// has no .x/.y to write — the direction would silently never update.
const uPropX = uniform(1);
const uPropZ = uniform(0);

/** octave counts are BUILD constants (they unroll the graph), per terrain/noise */
const CRACKLE_OCTAVES = 3;
const MOTTLE_OCTAVES = 2;
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
  uCrackleScale.value = p.crackleScale;
  uMottleScale.value = p.mottleScale;
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
 * WHY PER OCTAVE, and why this is the grit (§V48's SIXTH-occurrence lesson
 * applied here): the field's fade must be measured against its SHARPEST
 * feature, not its repeat. The crackle layer's base cell is 1/2.4 = 0.42 m but
 * its third octave's cell is 0.104 m, four times finer, and the old guard was
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
export function foamDetailMask(rawFoam: AnyNode, coord: AnyNode): AnyNode {
  // per-position phase (§B.4: NO shared global timeline) — coarse value
  // noise gives nearby points a common offset but distant caps their own
  const phase = valueNoise2(coord.mul(0.021)).mul(37.0);
  const t = uTime.add(phase).mul(uScroll);
  // shared low-freq churn warps both detail layers (internal motion)
  const churn = foamWarpVec(coord).mul(0.6);
  // crest-aligned detail space: streaks along the ridge, not round cells
  const aniso = crestAnisoCoord(coord.add(churn));

  // COVERAGE-ADAPTIVE SCALE (user, storm preset: "blobby noise in parts").
  // Detail texture that reads well at 10% coverage reads as high-frequency
  // noise when the whole sea is foaming. Where foam SATURATES, broaden the
  // detail into wind-driven sheets and flatten its contrast — §V7 asks storm
  // for big patches, and the reference storm foam is broad streaks running
  // with the swell, not 30 cm mottle stretched over everything.
  const sheetN = smoothstep(uSheetKnee, float(1.0), rawFoam);
  const broaden = mix(float(1), uSheetBroaden.max(0.05), sheetN);

  // fresh foam: broken high-freq crackle cells (thresholded fbm), drifting
  const crackleCoord = aniso.mul(uCrackleScale).mul(broaden).add(vec2(t, t.mul(-0.7)));
  const crackleFw = coordFootprint(crackleCoord);
  const crackleNoise = bandLimitedFbm2(crackleCoord, CRACKLE_OCTAVES, crackleFw);
  // §V48(a) WIDEN — the half that the per-octave fade does NOT cover. The
  // threshold is a step on a smooth field, so it has a width of its own: the
  // authored 0.35 of the fbm's range, which goes sub-pixel long before the
  // coarsest octave does. Widen it until the transition spans ~2 px of its own
  // coordinate (ship/bandLimit's FILTER_PIXELS = 2, expressed in this field's
  // units — value noise moves ~1 unit of value per lattice cell, so a
  // footprint of f cells is ≈ f of value). One pixel is not enough: at exactly
  // one, neighbouring samples still land on opposite ends of the step.
  const half = crackleFw.max(0.175);
  const crackle = smoothstep(float(0.525).sub(half), float(0.525).add(half), crackleNoise);
  const crackleLayer = mix(float(0.2), float(1.0), crackle);

  // dissipated foam: gentle low-freq mottling, counter-drifts vs crackle,
  // never cuts foam fully out
  const mottleCoord = aniso.mul(uMottleScale).mul(broaden).sub(vec2(t.mul(0.4), t.mul(-0.3)));
  const mottleNoise = bandLimitedFbm2(mottleCoord, MOTTLE_OCTAVES, coordFootprint(mottleCoord));
  const mottleLayer = mix(float(0.55), float(1.0), mottleNoise);

  // age proxy = foam value (§V6): high → crest crackle, low → soft mottle
  const freshness = smoothstep(float(0.25), float(0.8), rawFoam);
  const textured = mix(mottleLayer, crackleLayer, freshness);
  // saturated foam settles toward an unbroken sheet
  const sheeted = mix(textured, float(1), sheetN.mul(uSheetFlatten).clamp(0, 1));

  // FAR-FIELD DETAIL FADE — a BACKSTOP, not the band limit, and now keyed on
  // the PIXEL FOOTPRINT rather than on camera distance.
  //
  // It is kept because it is cheap and because it retires the mottle layer's
  // very low frequencies, which never alias but stop meaning anything once a
  // whole cap is a pixel wide. The actual anti-aliasing is the per-octave
  // fwidth limit above (§V48).
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
  // sparkle). Measured against the COARSEST layer in the composite (the mottle
  // cell), because this gate retires the WHOLE composite — the sharp end is
  // already handled per octave.
  const featureMetres = float(1).div(uMottleScale.max(0.01)); // floored §V28
  const keepMetres = featureMetres.div(uDetailKeepPixels.max(0.5));
  // e0 > e1 → 1 while a cell still spans the keep width, 0 once it is smaller
  // than one pixel by `detailFadeSpan` (§V23: functional smoothstep)
  const detailFade = smoothstep(
    keepMetres.mul(uDetailFadeSpan.max(1.05)),
    keepMetres,
    coordFootprint(coord),
  );
  const detail = mix(float(1), sheeted, detailFade);
  // Low-residue knee: a few percent of foam mixed over deep teal reads as a
  // dirty beige smudge, not as thin foam (§V20 critique) — cut it, keep the
  // soft skirt above. TUNABLE (§V16): this sits in SERIES with the jacobian
  // injection gate, so the two must be retuned together. As a shader literal
  // at (0.03, 0.12) it silently swallowed the whole injection fix.
  const knee = smoothstep(uKneeLow, uKneeHigh, rawFoam);
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
