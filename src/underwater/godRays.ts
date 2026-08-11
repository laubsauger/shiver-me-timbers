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
  screenUV,
  smoothstep,
  uniform,
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

  // loop bound must be compile-time — snapshot of params at build (doc above)
  const taps = Math.max(1, Math.round(p.rayTaps));

  const sceneColor = scenePass.getTextureNode('output');
  const toSun = u.sunScreen.sub(screenUV);

  // unrolled N-tap march from this pixel toward the sun's screen position
  let acc: ShaderNodeObject<Node> = vec3(0);
  for (let i = 1; i <= taps; i++) {
    const t = float(i / taps).mul(uLength);
    const sampleUV = screenUV.add(toSun.mul(t));
    const s = sceneColor.sample(sampleUV).rgb;
    // bright mask: only luminous pixels (sun disc, sparkle) feed the streaks
    const bright = smoothstep(uThreshold, float(1), luminance(s));
    const weight = pow(uDecay, float(i));
    acc = acc.add(s.mul(bright).mul(weight));
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
      uLength.value = p.rayLength;
      uFalloff.value = p.rayFalloff;
    },
  };
}
