/**
 * Foam compute passes (§V6, §C: heavy sims = `Fn().compute()`):
 * - inject: displacement.w (jacobian, from ocean unpackPass) below the live
 *   bias (§V7 storms lower it) adds foam ∝ (bias − J), accumulated onto the
 *   previous frame's foam, clamped ≤ 1.
 * - blurDecay: 3×3 gaussian × decay factor every frame — the progressive
 *   blur that leaves crests sharp at birth then spreads/dissipates them.
 * Taps wrap (texture tiles with its cascade domain — a seam would draw grid
 * lines on the ocean). CPU mirror of the math: foamMath.ts (tested).
 */
import {
  Fn,
  float,
  instanceIndex,
  int,
  ivec2,
  select,
  textureLoad,
  textureStore,
  uniform,
  vec2,
  vec4,
} from 'three/tsl';
import type * as THREE from 'three/webgpu';
import { CREST_GRAD_EPS, GAUSSIAN_3X3 } from './foamMath';

/** live-tweaked uniforms shared by every cascade's passes */
export function createFoamUniforms() {
  return {
    /** jacobian threshold (oceanParams.jacobianFoamBias, storm-driven §V7) */
    uBias: uniform(0),
    /** injectStrength · dt, precomputed CPU-side per fixed tick (§V2) */
    uInjectPerFrame: uniform(0),
    /** per-frame decay factor from decayHalfLife (foamMath.decayFactorPerFrame) */
    uDecay: uniform(1),
    /** blur tap offset in texels */
    uRadius: uniform(1),
    /** tap stretch ALONG the crest ridge (foamMath.crestTapOffset) */
    uAlong: uniform(1),
    /** tap stretch ACROSS the ridge — < along keeps caps ridge-shaped */
    uAcross: uniform(1),
    /** across-crest (wave propagation) direction, world XZ — uniform over
     *  the field so the kernel stays shift-invariant and conserves foam */
    uAcrossX: uniform(1),
    uAcrossZ: uniform(0),
  };
}

export type FoamUniforms = ReturnType<typeof createFoamUniforms>;

/**
 * Inject pass: dst = min(1, src + max(0, bias − J) · injectPerFrame).
 * Reads previous-frame foam from `src` and writes `dst` (ping-pong halves —
 * never read+write the same storage texture in one pass).
 */
export function createInjectPass(
  displacement: THREE.StorageTexture,
  src: THREE.StorageTexture,
  dst: THREE.StorageTexture,
  n: number,
  u: FoamUniforms,
) {
  return Fn(() => {
    const x = int(instanceIndex.mod(n)).toVar();
    const y = int(instanceIndex.div(n)).toVar();
    const coord = ivec2(x, y);

    const jacobian = textureLoad(displacement, coord).w;
    const previous = textureLoad(src, coord).r;
    // foamMath.injectAmount: deficit below bias → foam, never negative
    const injected = u.uBias.sub(jacobian).max(0).mul(u.uInjectPerFrame);
    // foamMath.accumulateFoam: clamp ≤ 1 (mask feeds a mix factor)
    const foam = previous.add(injected).min(1);
    textureStore(dst, coord, vec4(foam, 0, 0, 1)).toWriteOnly();
  })().compute(n * n);
}

/**
 * Decay+blur pass: dst = min(1, blur3x3(src) · decay), taps rotated into the
 * CREST frame and stretched along the ridge (§V6 shape, user critique
 * "caps too circular"). Gaussian weights sum to 1 (foamMath.GAUSSIAN_3X3) so
 * only uDecay removes foam. CPU mirror: foamMath.blurDecayAnisoAt.
 */
export function createBlurDecayPass(
  src: THREE.StorageTexture,
  dst: THREE.StorageTexture,
  n: number,
  u: FoamUniforms,
) {
  const wrap = (v: any) => v.add(int(n)).mod(int(n));
  return Fn(() => {
    const x = int(instanceIndex.mod(n)).toVar();
    const y = int(instanceIndex.div(n)).toVar();

    // crest frame from the UNIFORM propagation direction — never per-texel
    // from ∇h, which vanishes and flips sign exactly on the crest line and
    // makes this gather-form blur shed foam every frame (foamMath
    // .crestTapOffset). Constant frame = shift-invariant = mass-conserving.
    const across = vec2(u.uAcrossX, u.uAcrossZ).toVar();
    const len = across.length().toVar();
    // degenerate direction → axis frame (identical to the isotropic blur for
    // a symmetric kernel); the divisor is floored regardless (§V28)
    const nrm = select(
      len.greaterThan(CREST_GRAD_EPS),
      across.div(len.max(CREST_GRAD_EPS)),
      vec2(0, 1),
    ).toVar();
    const tan = vec2(nrm.y.negate(), nrm.x).toVar();

    const sum = float(0).toVar();
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        // tap offset in the crest frame, scaled by radius; +n before mod
        // keeps the wrap positive
        const off = tan
          .mul(u.uAlong.mul(dx))
          .add(nrm.mul(u.uAcross.mul(dy)))
          .mul(u.uRadius);
        const sx = wrap(x.add(int(off.x.round())));
        const sy = wrap(y.add(int(off.y.round())));
        const w = GAUSSIAN_3X3[(dy + 1) * 3 + (dx + 1)];
        sum.addAssign(textureLoad(src, ivec2(sx, sy)).r.mul(w));
      }
    }
    const foam = sum.mul(u.uDecay).min(1);
    textureStore(dst, ivec2(x, y), vec4(foam, 0, 0, 1)).toWriteOnly();
  })().compute(n * n);
}
