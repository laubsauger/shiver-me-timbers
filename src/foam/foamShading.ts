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
 * §V23: functional mix(a,b,t)/smoothstep(e0,e1,x) only for 3-arg math.
 * §V20: warm-tinted foam via foamTintNode.
 */
import { float, mix, smoothstep, texture, uniform, vec2, vec3 } from 'three/tsl';
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

/** push live param values + sim time into the shading uniforms (per tick) */
export function updateFoamShadingUniforms(p: FoamParams, time?: number): void {
  uCrackleScale.value = p.crackleScale;
  uMottleScale.value = p.mottleScale;
  uTintWarmth.value = p.tintWarmth;
  uWarpScale.value = p.uvWarpScale;
  uWarpMeters.value = p.uvWarpMeters;
  uScroll.value = p.detailScrollSpeed;
  uCapVarScale.value = p.capVariationScale;
  uCapVarStrength.value = p.capVariationStrength;
  if (time !== undefined) uTime.value = time;
}

/**
 * Non-tiling world-space cap strength (§B.4 class fix): the FFT foam field
 * repeats per cascade domain, so without this every tile's caps are clones
 * on a perfect grid, breathing in sync. Low-freq fbm over ABSOLUTE world XZ
 * (never wrapped) scales each cap by where it lives; a slow drift means a
 * given lattice site strengthens/weakens over time — per-site lifecycles.
 * Range [1−strength, 1+0.25·strength], mean slightly under 1.
 */
export function capVariationNode(worldXZ: any): any {
  const drift = uTime.mul(0.013);
  const n = fbm2(worldXZ.mul(uCapVarScale).add(vec2(drift, drift.mul(-0.6))), 2);
  return mix(float(1).sub(uCapVarStrength), float(1).add(uCapVarStrength.mul(0.25)), n).max(0);
}

/**
 * fbm domain-warp offset in world meters for the sim-texture lookup —
 * breaks the texel grid of the low-res foam RT (drifts slowly with time so
 * eddies read as pushed-around, not baked).
 */
export function foamWarpVec(coord: any): any {
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
export function foamDetailMask(rawFoam: any, coord: any): any {
  // per-position phase (§B.4: NO shared global timeline) — coarse value
  // noise gives nearby points a common offset but distant caps their own
  const phase = valueNoise2(coord.mul(0.021)).mul(37.0);
  const t = uTime.add(phase).mul(uScroll);
  // shared low-freq churn warps both detail layers (internal motion)
  const churn = foamWarpVec(coord).mul(0.6);

  // fresh foam: broken high-freq crackle cells (thresholded fbm), drifting
  const crackleNoise = fbm2(
    coord.add(churn).mul(uCrackleScale).add(vec2(t, t.mul(-0.7))),
    3,
  );
  const crackle = smoothstep(float(0.35), float(0.7), crackleNoise);
  const crackleLayer = mix(float(0.2), float(1.0), crackle);

  // dissipated foam: gentle low-freq mottling, counter-drifts vs crackle,
  // never cuts foam fully out
  const mottleNoise = fbm2(
    coord.add(churn).mul(uMottleScale).sub(vec2(t.mul(0.4), t.mul(-0.3))),
    2,
  );
  const mottleLayer = mix(float(0.55), float(1.0), mottleNoise);

  // age proxy = foam value (§V6): high → crest crackle, low → soft mottle
  const freshness = smoothstep(float(0.25), float(0.8), rawFoam);
  const detail = mix(mottleLayer, crackleLayer, freshness);
  // low-residue knee: sub-3% foam mixes as a dirty beige smudge on deep
  // teal (§V20 critique) — fade it out entirely, keep the soft skirt above
  const knee = smoothstep(float(0.03), float(0.12), rawFoam);
  return rawFoam.mul(detail).mul(knee).clamp(0, 1);
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
