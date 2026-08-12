/**
 * Underwater LENS treatment (§V25): refractive screen wobble, desaturated
 * blue-green grade, depth-scaled vignette. Built as a TSL node graph over the
 * post pipeline's shared scene pass (see index.ts for the stage wiring).
 * Everything is scaled by the shared `blend` uniform so the whole look fades
 * continuously across the waterline crossing band — no pop (V25).
 *
 * THIS FILE NO LONGER DOES FOG. Distance extinction moved to waterVolume.ts,
 * where it is per-channel, per-pixel, and driven by the SAME Jerlov
 * coefficients the hull and the caustics use. What is left here is what
 * happens to the image at the CAMERA rather than to the light in the water —
 * which is why `blend` (a property of the camera) is the right gate for all of
 * it, and would have been the wrong gate for the fog.
 *
 * V23: 3-arg math uses functional `mix`/`smoothstep` forms only.
 * V16: every tunable is a uniform fed from params/underwater via
 * updateFromParams() — no magic shader constants.
 */
import * as THREE from 'three/webgpu';
import {
  float,
  luminance,
  mix,
  screenUV,
  sin,
  smoothstep,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import type { Node, PassNode, UniformNode } from 'three/webgpu';
import type { ShaderNodeObject } from 'three/tsl';
import { underwaterParams as p } from '../params/underwater';

/** shared per-frame uniforms owned by index.ts, read by all builders */
export interface UnderwaterUniforms {
  /** 0..1 submersion blend (rate-limited by submersion.ts) */
  blend: ShaderNodeObject<UniformNode<number>>;
  /** camera depth below the surface in meters (≥ 0) */
  camDepth: ShaderNodeObject<UniformNode<number>>;
  /** scene time in seconds */
  time: ShaderNodeObject<UniformNode<number>>;
  /** sun position in screen UV space (may be off-screen) */
  sunScreen: ShaderNodeObject<UniformNode<THREE.Vector2>>;
  /** 0..1 sun-in-front-of-camera visibility */
  sunVis: ShaderNodeObject<UniformNode<number>>;
  /** day-cycle tint (dims/warms underwater colors with the sun) */
  dayTint: ShaderNodeObject<UniformNode<THREE.Color>>;
}

/**
 * The lens treatment, split in two around the water volume.
 *
 * The order matters and is not cosmetic: `lens` RESAMPLES the scene (the
 * wobble is a refractive displacement of the incoming image, so it has to
 * happen to the image before anything is composited onto it), the volume then
 * extinguishes what that ray carried, and only then does `finish` grade what
 * finally reached the sensor. Running the grade first would tint light the
 * water had already absorbed, and running the wobble last would resample the
 * raw scene and throw the fog away.
 */
export interface UnderwaterGrade {
  /** refractive wobble — pass the RAW scene rgb, blend-gated to identity above water */
  lens(rgb: ShaderNodeObject<Node>): ShaderNodeObject<Node>;
  /** desaturate + blue-green grade + depth vignette, blend-gated */
  finish(rgb: ShaderNodeObject<Node>): ShaderNodeObject<Node>;
  /** push live param values into uniforms (call per frame) */
  updateFromParams(): void;
}

export function buildUnderwaterGrade(
  scenePass: ShaderNodeObject<PassNode>,
  u: UnderwaterUniforms,
): UnderwaterGrade {
  const uGradeStrength = uniform(p.gradeStrength);
  const uGradeTint = uniform(new THREE.Color(p.gradeTint));
  const uDesat = uniform(p.desaturation);
  const uWobbleAmp = uniform(p.wobbleAmp);
  const uWobbleFreq = uniform(p.wobbleFreq);
  const uWobbleSpeed = uniform(p.wobbleSpeed);
  const uVigStrength = uniform(p.vignetteStrength);
  const uVigDepthScale = uniform(p.vignetteDepthScale);

  const sceneColor = scenePass.getTextureNode('output');

  // --- wobble: tiny sin-based UV offset, scaled by blend so above water = 0
  const phaseX = screenUV.y.mul(uWobbleFreq).add(u.time.mul(uWobbleSpeed));
  const phaseY = screenUV.x
    .mul(uWobbleFreq)
    .mul(1.31) // decorrelate axes (math const, not a tunable)
    .add(u.time.mul(uWobbleSpeed).mul(1.73));
  const wobble = vec2(sin(phaseX), sin(phaseY).mul(0.6))
    .mul(uWobbleAmp)
    .mul(u.blend);
  const wobbled = sceneColor.sample(screenUV.add(wobble)).rgb;

  // NOTE: the exponential distance fog that used to live here is GONE. It was
  // a second, hand-authored extinction set (`fogDensity` + two colours) racing
  // the physical one — the hull and the caustics attenuate by Jerlov K_d from
  // params/caustics, so a scalar density here made the water and the things in
  // it disagree about depth. Extinction now happens ONCE, per channel and per
  // pixel, in waterVolume.ts. What is left in this file is lens treatment
  // (wobble, grade, vignette) — things that happen to the CAMERA, not to the
  // light on its way to it.

  // --- vignette, strengthened by camera depth
  const radial = screenUV.sub(0.5).length().mul(2); // 0 center → ~1.41 corner
  const vigAmount = uVigStrength.add(u.camDepth.mul(uVigDepthScale)).saturate();
  const vignette = float(1).sub(
    smoothstep(float(0.5), float(1.4), radial).mul(vigAmount),
  );

  return {
    // above water blend = 0 ⟹ both halves are the exact identity, so the
    // stage costs nothing visually until the lens actually goes under (V25:
    // the crossing band never pops).
    lens: (rgb) => mix(rgb, wobbled, u.blend),
    finish: (rgb) => {
      const desat = mix(rgb, vec3(luminance(rgb)), uDesat);
      const graded = mix(desat, desat.mul(uGradeTint), uGradeStrength);
      return mix(rgb, graded.mul(vignette), u.blend);
    },
    updateFromParams(): void {
      uGradeStrength.value = p.gradeStrength;
      uGradeTint.value.set(p.gradeTint);
      uDesat.value = p.desaturation;
      uWobbleAmp.value = p.wobbleAmp;
      uWobbleFreq.value = p.wobbleFreq;
      uWobbleSpeed.value = p.wobbleSpeed;
      uVigStrength.value = p.vignetteStrength;
      uVigDepthScale.value = p.vignetteDepthScale;
    },
  };
}
