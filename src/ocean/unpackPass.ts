/**
 * Final IFFT unpack (§V.4, §V.6):
 * applies the (−1)^(x+y) permutation sign, unpacks the 8 real fields,
 * scales horizontal displacement by choppiness λ and computes the
 * jacobian determinant J for foam injection:
 *   J = (1+λ·∂Dx/∂x)(1+λ·∂Dz/∂z) − (λ·∂Dx/∂z)²
 * Outputs:
 *   displacement = (λ·Dx, h, λ·Dz, J)
 *   derivatives  = (∂h/∂x, ∂h/∂z, ∂Dx/∂x, ∂Dz/∂z)  — for slope-correct normals
 *
 * `derivatives` is a LAYER of one array texture shared by all three cascades,
 * not a texture per cascade (§V.40) — one binding and one sampler instead of
 * three of each in every fragment shader that reads it. `displacement` is not,
 * because it is also sampled in the vertex stage, where three r180 cannot
 * sample a filterable array texture.
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
import { storeCascadeLayer, type CascadeLayer } from './oceanTextures';

export interface UnpackPass {
  computeNode: unknown;
  choppinessUniform: { value: number };
}

export function buildUnpackPass(
  spec0Final: THREE.StorageTexture,
  spec1Final: THREE.StorageTexture,
  displacementOut: THREE.StorageTexture,
  derivativesOut: CascadeLayer,
  n: number,
): UnpackPass {
  const choppinessUniform = uniform(1.0);

  const kernel = Fn(() => {
    const x = int(instanceIndex.mod(n)).toVar();
    const y = int(instanceIndex.div(n)).toVar();
    const coord = ivec2(x, y);

    // (−1)^(x+y): undoes the frequency-domain shift that centered k-space
    const parity = x.add(y).bitAnd(int(1));
    const sign = float(1).sub(float(parity).mul(2)).toVar();

    const s0 = textureLoad(spec0Final, coord).mul(sign).toVar();
    const s1 = textureLoad(spec1Final, coord).mul(sign).toVar();

    const h = s0.x;
    const dx = s0.y;
    const dz = s0.z;
    const dhdx = s0.w;
    const dhdz = s1.x;
    const dDxdx = s1.y;
    const dDzdz = s1.z;
    const dDxdz = s1.w;

    const lambda = choppinessUniform;
    const jxx = float(1).add(lambda.mul(dDxdx));
    const jzz = float(1).add(lambda.mul(dDzdz));
    const jxz = lambda.mul(dDxdz);
    const jacobian = jxx.mul(jzz).sub(jxz.mul(jxz));

    textureStore(
      displacementOut,
      coord,
      vec4(lambda.mul(dx), h, lambda.mul(dz), jacobian),
    ).toWriteOnly();
    // this cascade's LAYER of the shared array texture (§V.40). The obvious
    // `textureStore(tex, coord, v).depth(i)` is WRONG — see storeCascadeLayer.
    storeCascadeLayer(derivativesOut, coord, vec4(dhdx, dhdz, dDxdx, dDzdz));
  });

  return {
    computeNode: (kernel() as any).compute(n * n),
    choppinessUniform: choppinessUniform as unknown as { value: number },
  };
}
