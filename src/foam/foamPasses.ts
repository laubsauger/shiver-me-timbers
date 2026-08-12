/**
 * Foam compute passes (§V6, §C: heavy sims = `Fn().compute()`):
 * - inject: the MINIMUM EIGENVALUE of the displacement jacobian (foamMath
 *   .minEigenvalue — Tessendorf's actual folding signal, not det J) below the
 *   live per-band gate adds foam ∝ how far below, accumulated onto the
 *   previous frame's foam, clamped ≤ 1.
 * - blurDecay: isotropic 3×3 gaussian × decay factor every frame — the
 *   progressive blur that leaves crests sharp at birth then spreads and
 *   dissipates them (Rare, SIGGRAPH '18: "we progressively blur the result of
 *   the foam buffer WITH FEEDBACK", i.e. one blur per frame, age = blur
 *   count; there is no anisotropy in the reference and there is none here).
 * Taps wrap (texture tiles with its cascade domain — a seam would draw grid
 * lines on the ocean). CPU mirror of the math: foamMath.ts (tested).
 */
import {
  Fn,
  float,
  instanceIndex,
  int,
  ivec2,
  textureLoad,
  textureStore,
  uniform,
  vec4,
} from 'three/tsl';
import type * as THREE from 'three/webgpu';
import { GAUSSIAN_3X3 } from './foamMath';

/** live-tweaked uniforms shared by every cascade's passes */
export function createFoamUniforms() {
  return {
    /** λ− gate for THIS band, in λ− units (foamMath.eigenFoamGate, §V36) */
    uBias: uniform(0),
    /** injectStrength · dt / σ(λ−), precomputed CPU-side per fixed tick (§V2) */
    uInjectPerFrame: uniform(0),
    /** per-frame decay factor from decayHalfLife (foamMath.decayFactorPerFrame) */
    uDecay: uniform(1),
    /** blur tap offset in texels */
    uRadius: uniform(1),
    /**
     * effective Tessendorf choppiness λ the GPU is running (the anti-fold cap,
     * not the slider). The derivatives texture stores ∂Dx/∂x and ∂Dz/∂z
     * UNSCALED, so the jacobian trace has to re-apply λ here — reading the
     * slider instead would silently mis-scale the metric the moment the
     * fold cap engages, which is exactly when foam matters most.
     */
    uChoppiness: uniform(1),
  };
}

export type FoamUniforms = ReturnType<typeof createFoamUniforms>;

/**
 * Inject pass: dst = min(1, src + max(0, gate − λ−) · injectPerFrame).
 *
 * λ− = ½(tr − √(tr² − 4·det)) is the minimum eigenvalue of J = I + λ∇D, and
 * it is the metric because det J is direction-free: area compression fires in
 * round blobs of one size, λ− fires along the axis the water is actually
 * folding on, so the injected footprint is a RIDGE that already follows the
 * local crest (foamMath, "THE FOLD METRIC"). ∇D is symmetric (D is a gradient
 * field), so both eigenvalues are real and trace+determinant is all we need —
 * which is exactly what the ocean already publishes, in two textures it
 * already writes. The off-diagonal term is never reconstructed; it only ever
 * appears squared, and it is already inside `det`.
 *
 * Reads previous-frame foam from `src` and writes `dst` (ping-pong halves —
 * never read+write the same storage texture in one pass).
 */
export function createInjectPass(
  displacement: THREE.StorageTexture,
  derivatives: THREE.StorageTexture,
  src: THREE.StorageTexture,
  dst: THREE.StorageTexture,
  n: number,
  u: FoamUniforms,
) {
  return Fn(() => {
    const x = int(instanceIndex.mod(n)).toVar();
    const y = int(instanceIndex.div(n)).toVar();
    const coord = ivec2(x, y);

    // (λDx, h, λDz, det J) and (∂h/∂x, ∂h/∂z, ∂Dx/∂x, ∂Dz/∂z) — see unpackPass
    const det = textureLoad(displacement, coord).w;
    const d = textureLoad(derivatives, coord);
    // tr J = 2 + λ(∂Dx/∂x + ∂Dz/∂z)
    const trace = float(2).add(u.uChoppiness.mul(d.z.add(d.w))).toVar();
    // foamMath.minEigenvalue. The discriminant is ≥ 0 for a real symmetric
    // matrix; the floor is float error, and without it one ulp of negative
    // returns NaN into an accumulator that has no way back (§V28).
    const disc = trace.mul(trace).sub(det.mul(4)).max(0);
    const minEigen = trace.sub(disc.sqrt()).mul(0.5);

    const previous = textureLoad(src, coord).r;
    // deficit below the gate → foam, never negative: calm water must not
    // scrub foam that is already there
    const injected = u.uBias.sub(minEigen).max(0).mul(u.uInjectPerFrame);
    // foamMath.accumulateFoam: clamp ≤ 1 (mask feeds a mix factor)
    const foam = previous.add(injected).min(1);
    textureStore(dst, coord, vec4(foam, 0, 0, 1)).toWriteOnly();
  })().compute(n * n);
}

/**
 * Box-reduction pass: dst[i] = mean of the factor×factor source block.
 *
 * WHY (ocean agent, horizon sizzle): StorageTextures carry NO mip chain, so a
 * grazing-angle pixel covering thousands of foam texels receives exactly ONE
 * of them, re-picked every frame — textbook minification aliasing, and the
 * real cause of the shimmering white band. A distance fade or a compositing
 * cap only hides it. This builds the missing filtered tier explicitly.
 *
 * `factor` is a build-time literal so the taps unroll (§V28 forbids dynamic
 * loop bounds), and the weights are a plain mean: this must not sharpen or
 * dim foam, only band-limit it.
 */
export function createReducePass(
  src: THREE.StorageTexture,
  dst: THREE.StorageTexture,
  dstN: number,
  factor: number,
) {
  if (!Number.isInteger(factor) || factor < 2) {
    throw new Error(`foam: reduce factor must be an integer ≥ 2, got ${factor}`);
  }
  const inv = 1 / (factor * factor);
  return Fn(() => {
    const x = int(instanceIndex.mod(dstN)).toVar();
    const y = int(instanceIndex.div(dstN)).toVar();
    const sx = x.mul(int(factor)).toVar();
    const sy = y.mul(int(factor)).toVar();
    const sum = float(0).toVar();
    for (let dy = 0; dy < factor; dy++) {
      for (let dx = 0; dx < factor; dx++) {
        sum.addAssign(textureLoad(src, ivec2(sx.add(int(dx)), sy.add(int(dy)))).r);
      }
    }
    textureStore(dst, ivec2(x, y), vec4(sum.mul(inv), 0, 0, 1)).toWriteOnly();
  })().compute(dstN * dstN);
}

/**
 * Decay+blur pass: dst = min(1, blur3x3(src) · decay). ISOTROPIC — see
 * foamMath, "REMOVED, ON PURPOSE". Gaussian weights sum to 1
 * (foamMath.GAUSSIAN_3X3) so only uDecay removes foam, and an axis-aligned
 * kernel is shift-invariant, so the conservation the old crest frame was
 * built to protect is kept, not traded. CPU mirror: foamMath.blurDecayAt.
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

    const sum = float(0).toVar();
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        // tap offset in texels, scaled by radius; +n before mod keeps the
        // wrap positive
        const ox = u.uRadius.mul(dx).round();
        const oy = u.uRadius.mul(dy).round();
        const sx = wrap(x.add(int(ox)));
        const sy = wrap(y.add(int(oy)));
        const w = GAUSSIAN_3X3[(dy + 1) * 3 + (dx + 1)];
        sum.addAssign(textureLoad(src, ivec2(sx, sy)).r.mul(w));
      }
    }
    const foam = sum.mul(u.uDecay).min(1);
    textureStore(dst, ivec2(x, y), vec4(foam, 0, 0, 1)).toWriteOnly();
  })().compute(n * n);
}
