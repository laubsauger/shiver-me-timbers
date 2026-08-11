/**
 * Foam shading TSL nodes (§V6 texture blending, procedural per §I assets):
 * the blurred sim mask blends two detail layers — high-frequency crackle on
 * fresh (high-value) foam, soft low-frequency mottling on dissipated
 * (low-value) foam. The foam value itself is the age proxy: injection writes
 * ~1 at crests and decay+blur only ever lowers it, so value ≈ freshness.
 * §V23: functional mix(a,b,t)/smoothstep(e0,e1,x) only for 3-arg math.
 * §V20: warm-tinted foam via foamTintNode.
 */
import { float, mix, smoothstep, texture, uniform, vec3 } from 'three/tsl';
import type * as THREE from 'three/webgpu';
import { fbm2 } from '../terrain/noise';
import type { FoamParams } from '../params/foam';

const uCrackleScale = uniform(3.0);
const uMottleScale = uniform(0.35);
const uTintWarmth = uniform(0.35);

/** push live param values into the shading uniforms (call per frame) */
export function updateFoamShadingUniforms(p: FoamParams): void {
  uCrackleScale.value = p.crackleScale;
  uMottleScale.value = p.mottleScale;
  uTintWarmth.value = p.tintWarmth;
}

/**
 * Detail-modulated foam mask from a raw sim value and a noise coordinate
 * (world XZ preferred — continuous across cascade tile seams).
 * Output scalar mask in [0, 1] for the surface material's crest mix.
 */
export function foamDetailMask(rawFoam: any, coord: any): any {
  // fresh foam: broken high-freq crackle cells (thresholded fbm)
  const crackleNoise = fbm2(coord.mul(uCrackleScale), 3);
  const crackle = smoothstep(float(0.35), float(0.7), crackleNoise);
  const crackleLayer = mix(float(0.2), float(1.0), crackle);

  // dissipated foam: gentle low-freq mottling, never cuts foam fully out
  const mottleNoise = fbm2(coord.mul(uMottleScale), 2);
  const mottleLayer = mix(float(0.55), float(1.0), mottleNoise);

  // age proxy = foam value (§V6): high → crest crackle, low → soft mottle
  const freshness = smoothstep(float(0.25), float(0.8), rawFoam);
  const detail = mix(mottleLayer, crackleLayer, freshness);
  return rawFoam.mul(detail).clamp(0, 1);
}

/**
 * §V6 helper: final foam mask for ONE cascade texture at its tiling uv.
 * Pass un-fract'd uv (worldXZ / domain) — RepeatWrapping tiles the texture
 * while the detail noise stays continuous across tile boundaries.
 */
export function foamShadingNode(foamTex: THREE.Texture, uv: any): any {
  return foamDetailMask(texture(foamTex, uv).r, uv);
}

/** warm foam tint (§V20): mix(white, warm, tintWarmth) — multiply foam color */
export function foamTintNode(): any {
  return mix(vec3(1.0, 1.0, 1.0), vec3(1.0, 0.92, 0.8), uTintWarmth);
}
