/**
 * Radix-2 IFFT butterfly passes (§V.4).
 * log2(N) horizontal + log2(N) vertical dispatches per cascade, each pass
 * transforming BOTH packed spectrum textures. Butterfly table (twiddles +
 * indices, CPU-verified in tests/ocean.test.ts) is baked per stage.
 */
import {
  Fn,
  instanceIndex,
  int,
  ivec2,
  textureLoad,
  textureStore,
  vec4,
} from 'three/tsl';
import type * as THREE from 'three/webgpu';
import { cmul } from './tslComplex';

export interface FftPassSet {
  /** ordered compute nodes: run all in sequence each frame */
  passes: unknown[];
  /** which buffer index (0=ping,1=pong) holds the final result */
  finalIndex: 0 | 1;
}

interface TexturePair {
  ping: THREE.StorageTexture;
  pong: THREE.StorageTexture;
}

export function buildFftPasses(
  butterflyTexture: THREE.DataTexture,
  spec0: TexturePair,
  spec1: TexturePair,
  n: number,
): FftPassSet {
  const stages = Math.log2(n);
  const passes: unknown[] = [];
  // buffers[0] = ping set, buffers[1] = pong set
  const set0 = [spec0.ping, spec0.pong];
  const set1 = [spec1.ping, spec1.pong];
  let src = 0;

  const buildPass = (stage: number, horizontal: boolean, srcIdx: number) => {
    const dstIdx = 1 - srcIdx;
    const kernel = Fn(() => {
      const x = int(instanceIndex.mod(n)).toVar();
      const y = int(instanceIndex.div(n)).toVar();
      const along = horizontal ? x : y;

      const bf = textureLoad(butterflyTexture, ivec2(along, stage)).toVar();
      const tw = bf.xy;
      const a = int(bf.z);
      const b = int(bf.w);

      const coordA = horizontal ? ivec2(a, y) : ivec2(x, a);
      const coordB = horizontal ? ivec2(b, y) : ivec2(x, b);
      const coordOut = ivec2(x, y);

      // out = in[a] + W·in[b], applied to both packed complex pairs
      const a0 = textureLoad(set0[srcIdx], coordA);
      const b0 = textureLoad(set0[srcIdx], coordB);
      const r0 = vec4(
        a0.xy.add(cmul(tw, b0.xy)),
        a0.zw.add(cmul(tw, b0.zw)),
      );
      textureStore(set0[dstIdx], coordOut, r0).toWriteOnly();

      const a1 = textureLoad(set1[srcIdx], coordA);
      const b1 = textureLoad(set1[srcIdx], coordB);
      const r1 = vec4(
        a1.xy.add(cmul(tw, b1.xy)),
        a1.zw.add(cmul(tw, b1.zw)),
      );
      textureStore(set1[dstIdx], coordOut, r1).toWriteOnly();
    });
    return (kernel() as any).compute(n * n);
  };

  for (let stage = 0; stage < stages; stage++) {
    passes.push(buildPass(stage, true, src));
    src = 1 - src;
  }
  for (let stage = 0; stage < stages; stage++) {
    passes.push(buildPass(stage, false, src));
    src = 1 - src;
  }

  return { passes, finalIndex: src as 0 | 1 };
}
