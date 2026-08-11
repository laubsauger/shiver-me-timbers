/**
 * Underwater full-screen grade (§V25): depth-based teal exp fog, desaturated
 * blue-green grade, subtle time-based screen wobble, depth-scaled vignette.
 * Built as a TSL node graph over the scene `pass()` color/viewZ (post pass —
 * see index.ts for the PostProcessing wiring). Everything is scaled by the
 * shared `blend` uniform so the whole look fades continuously across the
 * waterline crossing band — no pop (V25).
 *
 * V23: 3-arg math uses functional `mix`/`smoothstep` forms only.
 * V16: every tunable is a uniform fed from params/underwater via
 * updateFromParams() — no magic shader constants.
 */
import * as THREE from 'three/webgpu';
import {
  float,
  exp,
  luminance,
  mix,
  screenUV,
  sin,
  smoothstep,
  uniform,
  vec2,
  vec3,
  vec4,
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

export interface UnderwaterGrade {
  /** vec4 output node — plug into PostProcessing.outputNode */
  node: ShaderNodeObject<Node>;
  /** push live param values into uniforms (call per frame) */
  updateFromParams(): void;
}

export function buildUnderwaterGrade(
  scenePass: ShaderNodeObject<PassNode>,
  u: UnderwaterUniforms,
): UnderwaterGrade {
  const uFogDensity = uniform(p.fogDensity);
  const uFogShallow = uniform(new THREE.Color(p.fogColorShallow));
  const uFogDeep = uniform(new THREE.Color(p.fogColorDeep));
  const uFogDepthRange = uniform(p.fogDepthRange);
  const uGradeStrength = uniform(p.gradeStrength);
  const uGradeTint = uniform(new THREE.Color(p.gradeTint));
  const uDesat = uniform(p.desaturation);
  const uWobbleAmp = uniform(p.wobbleAmp);
  const uWobbleFreq = uniform(p.wobbleFreq);
  const uWobbleSpeed = uniform(p.wobbleSpeed);
  const uVigStrength = uniform(p.vignetteStrength);
  const uVigDepthScale = uniform(p.vignetteDepthScale);

  const sceneColor = scenePass.getTextureNode('output');
  // viewZ sampled at the un-wobbled UV: the wobble offset is ≤ ~0.4% of the
  // screen, so the fog-distance error is invisible and we skip a depth fetch
  const viewZ = scenePass.getViewZNode();

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

  // --- teal exp fog by view distance; color deepens with camera depth
  const viewDist = viewZ.negate(); // viewZ is negative into the screen
  // fogAmount = 1 - e^(-dist * density) — mirrored by expFogFactor() in
  // submersion.ts for the unit tests
  const fogAmount = float(1).sub(exp(viewDist.mul(uFogDensity).negate()));
  const depthT = smoothstep(float(0), uFogDepthRange, u.camDepth);
  const fogColor = mix(uFogShallow, uFogDeep, depthT).mul(u.dayTint);
  const fogged = mix(wobbled, fogColor, fogAmount);

  // --- desaturate toward luminance, then blue-green multiply grade
  const desat = mix(fogged, vec3(luminance(fogged)), uDesat);
  const graded = mix(desat, desat.mul(uGradeTint), uGradeStrength);

  // --- vignette, strengthened by camera depth
  const radial = screenUV.sub(0.5).length().mul(2); // 0 center → ~1.41 corner
  const vigAmount = uVigStrength.add(u.camDepth.mul(uVigDepthScale)).saturate();
  const vignette = float(1).sub(
    smoothstep(float(0.5), float(1.4), radial).mul(vigAmount),
  );

  // fade the whole treatment in with blend — crossing band never pops (V25)
  const outRGB = mix(sceneColor.rgb, graded.mul(vignette), u.blend);
  const node = vec4(outRGB, 1);

  return {
    node,
    updateFromParams(): void {
      uFogDensity.value = p.fogDensity;
      uFogShallow.value.set(p.fogColorShallow);
      uFogDeep.value.set(p.fogColorDeep);
      uFogDepthRange.value = p.fogDepthRange;
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
