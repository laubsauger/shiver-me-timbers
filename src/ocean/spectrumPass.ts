/**
 * Per-frame spectrum time evolution (§V.4).
 * Reads h0 (CPU-generated, Hermitian-packed), writes two packed complex
 * spectra ready for IFFT:
 *   spec0 = (h + i·Dx)         | (Dz + i·∂h/∂x)
 *   spec1 = (∂h/∂z + i·∂Dx/∂x) | (∂Dz/∂z + i·∂Dx/∂z)
 * After IFFT + unpack these yield 8 real fields: height, choppy Dx/Dz,
 * slopes, and the jacobian terms for foam (§V.6).
 */
import {
  Fn,
  If,
  float,
  instanceIndex,
  int,
  ivec2,
  textureLoad,
  textureStore,
  uniform,
  vec2,
  vec4,
} from 'three/tsl';
import type * as THREE from 'three/webgpu';
import { GRAVITY } from './oceanMath';
import { addImag, cmul, expi, imul } from './tslComplex';

export interface SpectrumPass {
  computeNode: unknown;
  timeUniform: { value: number };
}

export function buildSpectrumPass(
  h0Texture: THREE.DataTexture,
  spec0Out: THREE.StorageTexture,
  spec1Out: THREE.StorageTexture,
  n: number,
  domain: number,
): SpectrumPass {
  const timeUniform = uniform(0);

  const kernel = Fn(() => {
    const x = int(instanceIndex.mod(n)).toVar();
    const y = int(instanceIndex.div(n)).toVar();
    const coord = ivec2(x, y);

    const twoPi = float(Math.PI * 2);
    const kx = twoPi.mul(float(x).sub(n / 2)).div(domain).toVar();
    const kz = twoPi.mul(float(y).sub(n / 2)).div(domain).toVar();
    const kLen = kx.mul(kx).add(kz.mul(kz)).sqrt().toVar();

    const h0 = textureLoad(h0Texture, coord).toVar();

    // h(k,t) = h0(k)e^{iωt} + conj(h0(−k))e^{−iωt}; ω² = g·|k|
    const omega = kLen.mul(GRAVITY).sqrt();
    const phase = omega.mul(timeUniform).toVar();
    const ep = expi(phase);
    const em = vec2(ep.x, ep.y.negate());
    const h0k = h0.xy;
    const h0mkConj = vec2(h0.z, h0.w.negate());
    const h = cmul(h0k, ep).add(cmul(h0mkConj, em)).toVar();

    const ih = imul(h).toVar();
    const safeK = kLen.max(1e-6).toVar();
    const kxN = kx.div(safeK).toVar();
    const kzN = kz.div(safeK).toVar();

    const dx = ih.mul(kxN).toVar(); // i·(kx/|k|)·h
    const dz = ih.mul(kzN).toVar();
    const dhdx = ih.mul(kx).toVar(); // i·kx·h
    const dhdz = ih.mul(kz).toVar();
    const dDxdx = h.mul(kx.mul(kxN).negate()).toVar(); // −kx²/|k|·h
    const dDzdz = h.mul(kz.mul(kzN).negate()).toVar();
    const dDxdz = h.mul(kx.mul(kzN).negate()).toVar(); // −kx·kz/|k|·h

    const out0 = vec4(addImag(h, dx), addImag(dz, dhdx)).toVar();
    const out1 = vec4(addImag(dhdz, dDxdx), addImag(dDzdz, dDxdz)).toVar();

    // k = 0 carries no wave energy — kill DC explicitly
    If(kLen.lessThan(1e-6), () => {
      out0.assign(vec4(0));
      out1.assign(vec4(0));
    });

    textureStore(spec0Out, coord, out0).toWriteOnly();
    textureStore(spec1Out, coord, out1).toWriteOnly();
  });

  return {
    computeNode: (kernel() as any).compute(n * n),
    timeUniform: timeUniform as unknown as { value: number },
  };
}
