/**
 * Depth-scaled cloud blur (§V11 stage 2): two separable gaussian compute
 * passes (`Fn().compute()` → StorageTexture, per §C heavy sims = compute).
 * The per-pixel sample radius is driven by the packed depth (A/B weighted
 * average from cloudCores.ts): near clouds spread wide and soft, distant
 * clouds stay tighter. Radii are uniforms so Tweakpane tweaks apply live.
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  float,
  instanceIndex,
  int,
  ivec2,
  mix,
  textureLoad,
  textureStore,
  uint,
  uniform,
  uvec2,
  vec4,
} from 'three/tsl';
import type { CloudParams } from '../params/clouds';

/** taps per side; total kernel = 2*TAPS+1 samples, spaced radius/TAPS apart */
const TAPS = 6;

export function createCloudBlur(input: THREE.Texture, p: CloudParams) {
  const w = p.rtWidth;
  const h = p.rtHeight;

  const makeTarget = (): THREE.StorageTexture => {
    const t = new THREE.StorageTexture(w, h);
    t.type = THREE.HalfFloatType;
    return t;
  };
  const texH = makeTarget();
  const texV = makeTarget();

  const uRadiusNear = uniform(p.blurRadiusNear);
  const uRadiusFar = uniform(p.blurRadiusFar);

  const makePass = (
    src: THREE.Texture,
    dst: THREE.StorageTexture,
    dx: number,
    dy: number,
  ) =>
    Fn(() => {
      If(instanceIndex.lessThan(uint(w * h)), () => {
        const x = int(int(instanceIndex).mod(int(w)));
        const y = int(instanceIndex.div(uint(w)));
        const center = textureLoad(src, ivec2(x, y));
        // weighted-average depth of the accumulated puffs at this pixel
        const depthN = center.a.div(center.b.max(1e-4)).clamp(0, 1);
        const radius = mix(uRadiusNear, uRadiusFar, depthN);

        const acc = vec4(0).toVar();
        const wsum = float(0).toVar();
        // The kernel is fixed. Build its weights once instead of evaluating
        // 13 exponentials per pixel in each separable pass. Keep float32
        // intermediate rounding; half-float output may differ by one step.
        for (let i = -TAPS; i <= TAPS; i++) {
          const t = Math.fround(i / TAPS);
          const off = radius.mul(t).round();
          const sx = x.add(int(off.mul(dx))).clamp(0, w - 1);
          const sy = y.add(int(off.mul(dy))).clamp(0, h - 1);
          const weight = Math.fround(Math.exp(Math.fround(
            Math.fround(t * t) * Math.fround(-3.2),
          )));
          acc.addAssign(textureLoad(src, ivec2(sx, sy)).mul(weight));
          wsum.addAssign(weight);
        }
        textureStore(dst, uvec2(ivec2(x, y)), acc.div(wsum)).toWriteOnly();
      });
    })().compute(w * h);

  const passH = makePass(input, texH, 1, 0);
  const passV = makePass(texH, texV, 0, 1);

  // Preserve dispatch order while sharing one command submission.
  const passes = [passH, passV];

  return {
    /** final blurred 4-channel texture, sampled by the composite quad */
    output: texV,
    uRadiusNear,
    uRadiusFar,
    run(renderer: THREE.WebGPURenderer): void {
      renderer.compute(passes);
    },
    dispose(): void {
      texH.dispose();
      texV.dispose();
    },
  };
}

export type CloudBlur = ReturnType<typeof createCloudBlur>;
