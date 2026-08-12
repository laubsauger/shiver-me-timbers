/**
 * Band-limiting reduction chain for the deck-water state (§V.48).
 *
 * WHY THIS EXISTS: StorageTextures cannot carry mips, and the solver state is
 * sampled by the ship's deck material — which multiplies its ENTIRE procedural
 * height field by `deckWetness().reliefScale`. `reliefNormal` then
 * differentiates H·S in screen space, so the product rule hands the shading
 * normal an `H · dS/dx` term: our texture's minification aliasing, amplified
 * by the wood grain's own magnitude. That is §V.48's signature failure —
 * uniform per-pixel speckle across a whole surface — and it is at its worst
 * exactly here, because the derivative of noise is louder noise. It would not
 * show on a dry deck (S ≡ 1, dS/dx = 0); it shows the moment she takes water.
 *
 * The fix follows the foam agent's precedent, since StorageTextures rule mips
 * out: two 4× box reductions run per frame off the FRONT texture, after that
 * tick's substeps, so the coarse tier always reflects what is on screen. 192 ×
 * 512 → 48 × 128 → 12 × 32, which at that last tier is ~36 × 54 cm per texel.
 * That is plenty for "is this stretch of deck wet", which is all `reliefScale`
 * ever needed — and being smooth by construction it cannot alias into the
 * normal however far away the deck is.
 *
 * The full-resolution texture stays the source for `tint` and
 * `roughnessScale`: those feed colour and roughness directly rather than a
 * screen-space derivative, and they are where a puddle's actual shape has to
 * stay crisp.
 *
 * §V28: the 4×4 tap window is unrolled at build time (literal bounds, no Loop)
 * and every source coordinate is clamped, so a tier whose dimensions do not
 * divide evenly still reads inside the texture.
 */
import type * as THREE from 'three/webgpu';
import { Fn, If, instanceIndex, int, ivec2, textureLoad, textureStore, uint, uvec2, vec4 } from 'three/tsl';

/** each reduction step halves twice — one output texel per 4×4 input block */
export const REDUCE_FACTOR = 4;

/** dimensions of the tier below `n`, never smaller than 1 (§V28 sanitized) */
export function reducedSize(n: number): number {
  return Math.max(1, Math.ceil(n / REDUCE_FACTOR));
}

/**
 * One 4× box reduction: `dst[x,y]` = mean of the 4×4 block of `src`. Averaging
 * is the point — a point-sampled decimation would keep the aliasing it is
 * meant to remove.
 */
export function createReducePass(
  src: THREE.Texture,
  dst: THREE.StorageTexture,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
) {
  return Fn(() => {
    If(instanceIndex.lessThan(uint(dstW * dstH)), () => {
      const x = int(instanceIndex.modInt(dstW));
      const y = int(instanceIndex.div(uint(dstW)));
      const x0 = x.mul(REDUCE_FACTOR);
      const y0 = y.mul(REDUCE_FACTOR);
      // unrolled 4×4 — literal bounds by construction (§V28). TSL nodes are
      // structurally typed per operation, so the running sum needs the loose
      // node type the rest of this codebase uses for the same reason.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let sum: any = null;
      for (let j = 0; j < REDUCE_FACTOR; j++) {
        for (let i = 0; i < REDUCE_FACTOR; i++) {
          const sx = x0.add(int(i)).clamp(0, srcW - 1);
          const sy = y0.add(int(j)).clamp(0, srcH - 1);
          const tap = textureLoad(src, ivec2(sx, sy));
          sum = sum === null ? tap : sum.add(tap);
        }
      }
      const mean = sum.div(REDUCE_FACTOR * REDUCE_FACTOR);
      textureStore(dst, uvec2(ivec2(x, y)), vec4(mean)).toWriteOnly();
    });
  })().compute(dstW * dstH);
}
