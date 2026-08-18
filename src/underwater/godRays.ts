/**
 * Fake underwater god rays (§V25 "soft god-ray fake OK").
 *
 * APPROACH CHOSEN: screen-space radial streaks in the post pipeline — an
 * N-tap radial blur from the projected sun screen position over a luminance
 * bright-mask of the scene color, added on top of the underwater grade.
 * The camera-attached cone-billboard fallback was NOT needed: the pass()
 * pipeline (see index.ts) exposes the scene color texture directly and the
 * whole effect is one cheap unrolled loop.
 *
 * Masked so it only appears underwater (× blend) and only when the sun is
 * in front of the camera (× sunVis, CPU-computed). Tap count is a shader
 * loop bound, so `rayTaps` is read once at pipeline build — changing it in
 * the panel needs a reload; all other ray params are live uniforms (V16).
 *
 * V23: 3-arg math uses functional `smoothstep`; `.saturate()` used instead
 * of ambiguous chained clamp.
 */
import {
  float,
  luminance,
  pow,
  screenCoordinate,
  screenUV,
  smoothstep,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import type { Node, PassNode } from 'three/webgpu';
import type { ShaderNodeObject } from 'three/tsl';
import { underwaterParams as p } from '../params/underwater';
import type { UnderwaterUniforms } from './underwaterGrade';

export interface GodRays {
  /** vec3 additive streak color — add onto the graded output */
  node: ShaderNodeObject<Node>;
  /** push live param values into uniforms (call per frame) */
  updateFromParams(): void;
}

export function buildGodRays(
  scenePass: ShaderNodeObject<PassNode>,
  u: UnderwaterUniforms,
): GodRays {
  const uIntensity = uniform(p.rayIntensity);
  const uDecay = uniform(p.rayDecay);
  const uThreshold = uniform(p.rayThreshold);
  const uLength = uniform(p.rayLength);
  const uFalloff = uniform(p.rayFalloff);
  const uClamp = uniform(p.rayClamp);

  // loop bound must be compile-time — snapshot of params at build (doc above)
  const taps = Math.max(1, Math.round(p.rayTaps));

  const sceneColor = scenePass.getTextureNode('output');
  const toSun = u.sunScreen.sub(screenUV);

  /**
   * STRATIFIED PER-PIXEL TAP OFFSET (§V.48) — the cure for the GHOST LADDER.
   *
   * With `rayTaps` = 12 and `rayLength` = 0.55, a pixel at radial distance d
   * from the sun samples at spacing d·0.55/12 ≈ 0.046·d. Half a screen from
   * the source that is ~25 px at 1080p. Above water the surround is bright and
   * continuous so the gaps fill in, but underwater every bright thing is a
   * COMPACT high-contrast point against a near-black volume — so each tap
   * resolved as its own visible copy of the source and the shaft came apart
   * into a stack of discrete dots, one per tap, per bright source. The user
   * shot two such chains at once (the sun, and a specular highlight on the
   * hull) and called it "stacked".
   *
   * The fix is NOT more taps — that is a linear cost on a pass §V.17 cannot
   * yet measure. Offsetting each pixel's march by a fraction of one step makes
   * the union of samples across neighbouring pixels continuous: the ghosts
   * become noise, which is both cheaper and far less legible than structure.
   * Interleaved-gradient noise [Jimenez 2014] — the same constants and the
   * same screen-locked (non-animated) choice as the output dither in
   * core/postPipeline.ts, and IGN was introduced for exactly this job.
   */
  const jitter = float(52.9829189)
    .mul(screenCoordinate.dot(vec2(0.06711056, 0.00583715)).fract())
    .fract();

  // unrolled N-tap march from this pixel toward the sun's screen position
  let acc: ShaderNodeObject<Node> = vec3(0);
  for (let i = 1; i <= taps; i++) {
    // subtract, so each tap stays inside its own stratum ((i−1)/n, i/n]·length
    // and the march never samples t = 0 (the pixel itself).
    const t = float(i / taps).sub(jitter.div(taps)).mul(uLength);
    const sampleUV = screenUV.add(toSun.mul(t));
    /**
     * §V.44 BOUNDED AT SOURCE. `rayClamp`, before the mask and before the
     * accumulate, so the total is provably ≤ clamp·intensity. Underwater the
     * sun through the surface is a four-digit HDR value, and without this each
     * ghost was an unbounded copy of it — which is why the stack read as a
     * dozen hard suns rather than as a soft shaft. The sibling above-water
     * module has always clamped here (postGodRays.ts `uClamp`); this one never
     * did.
     */
    const s = sceneColor.sample(sampleUV).rgb.clamp(float(0), uClamp);
    // bright mask: only luminous pixels (sun disc, sparkle) feed the streaks
    const bright = smoothstep(uThreshold, float(1), luminance(s));
    const weight = pow(uDecay, float(i));
    /**
     * OFF-SCREEN TAPS CONTRIBUTE NOTHING — the other guard this module never
     * got. `sunVisEdge` = 0.2 means the effect runs at FULL strength while the
     * sun is anywhere within ~78° of the view axis, i.e. far outside the frame;
     * the pass texture is ClampToEdge, so every tap that walked off the top
     * returned that column's EDGE TEXEL and smeared one row along the ray — a
     * horizontal streak with no source in the image. A multiply, never a
     * branch (§V.44, and a divergent `If` in an unrolled loop costs more than
     * the four comparisons it saves). Same defect and same cure as
     * core/postGodRays.ts, which documents it at length.
     */
    const inFrame = sampleUV.x
      .greaterThanEqual(0)
      .and(sampleUV.x.lessThanEqual(1))
      .and(sampleUV.y.greaterThanEqual(0))
      .and(sampleUV.y.lessThanEqual(1));
    acc = acc.add(
      s.mul(bright).mul(weight).mul(inFrame.select(float(1), float(0))),
    );
  }

  // radial falloff away from the sun position so streaks hug the source
  const falloff = float(1).sub(toSun.length().div(uFalloff)).saturate();

  const node = acc
    .div(taps) // normalize by build-time tap count (not a tunable)
    .mul(uIntensity)
    .mul(falloff)
    .mul(u.sunVis)
    .mul(u.blend)
    .mul(u.dayTint);

  return {
    node,
    updateFromParams(): void {
      uIntensity.value = p.rayIntensity;
      uDecay.value = p.rayDecay;
      uThreshold.value = p.rayThreshold;
      uClamp.value = Math.max(p.rayClamp, 1e-3); // §V.28: never a zero bound
      uLength.value = p.rayLength;
      uFalloff.value = p.rayFalloff;
    },
  };
}
