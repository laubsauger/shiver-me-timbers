/**
 * Sea-of-Thieves progressive-blur foam sim (§V6, §V7, docs/handoff.md §2).
 * Per ocean cascade (§V19): jacobian-deficit inject → 3×3 blur × decay every
 * frame, ping-ponged between two StorageTextures that tile with the
 * cascade's world domain.
 *
 * INTEGRATION SURFACE (main-thread work, not done here):
 *   createFoamSim(
 *     cascades: { displacement: StorageTexture; domain: number }[],
 *     resolution: number,               // N — displacement textures are N×N
 *   ) => {
 *     update(renderer): void;           // run after ocean passes, per tick
 *     foamTextures: StorageTexture[];   // per-cascade foam (R channel),
 *                                       //   stable refs, RepeatWrapping —
 *                                       //   sample at worldXZ / domain[i]
 *     shadingNode(worldXZ): node;       // final detail-blended foam mask
 *                                       //   [0,1] for the surface material
 *   }
 *   Plus foamShadingNode(foamTex, uv) / foamTintNode() from ./foamShading.
 *
 * Pass order per cascade and frame (never read+write one texture in a pass):
 *   inject:    A + f(displacement.w) → B
 *   blurDecay: blur3x3(B) · decay    → A     ← A is always the output
 */
import type * as THREE from 'three/webgpu';
import { clamp, float, texture } from 'three/tsl';
import { SIM_DT } from '../core/loop';
import { createOutputTexture } from '../ocean/oceanTextures';
import { foamParams } from '../params/foam';
import { oceanParams } from '../params/ocean';
import { decayFactorPerFrame } from './foamMath';
import { createBlurDecayPass, createInjectPass, createFoamUniforms } from './foamPasses';
import { foamDetailMask, updateFoamShadingUniforms } from './foamShading';

export { foamShadingNode, foamTintNode } from './foamShading';
export { createSpray, createBowSpray } from './spray'; // crest + bow spray (see spray.ts/bowSpray.ts headers)

export interface FoamCascadeInput {
  /** ocean unpack output: (λDx, h, λDz, J) — w = jacobian (§V6) */
  displacement: THREE.StorageTexture;
  /** world-space meters this cascade tiles over (§V19) */
  domain: number;
}

export function createFoamSim(cascades: FoamCascadeInput[], resolution: number) {
  const u = createFoamUniforms();

  const lanes = cascades.map((c) => {
    const front = createOutputTexture(resolution); // A — stable output
    const back = createOutputTexture(resolution); // B — inject scratch
    return {
      domain: c.domain,
      front,
      back,
      inject: createInjectPass(c.displacement, front, back, resolution, u),
      blurDecay: createBlurDecayPass(back, front, resolution, u),
    };
  });

  return {
    /** per-cascade foam textures (R = foam), index-aligned with `cascades` */
    foamTextures: lanes.map((l) => l.front),

    /** run once per fixed sim tick (§V2), after the ocean cascade update */
    update(renderer: THREE.WebGPURenderer): void {
      u.uBias.value = oceanParams.jacobianFoamBias; // live, storm-driven §V7
      u.uInjectPerFrame.value = foamParams.injectStrength * SIM_DT;
      u.uDecay.value = decayFactorPerFrame(foamParams.decayHalfLife, SIM_DT);
      u.uRadius.value = foamParams.blurRadius;
      updateFoamShadingUniforms(foamParams);
      for (const lane of lanes) {
        renderer.compute(lane.inject as Parameters<THREE.WebGPURenderer['compute']>[0]);
        renderer.compute(lane.blurDecay as Parameters<THREE.WebGPURenderer['compute']>[0]);
      }
    },

    /**
     * Final foam mask node for the surface material: cascade foam summed
     * (independent bands add, like the surface material sums jacobians),
     * clamped, then crest-crackle → soft-mottle detail blend (§V6).
     * `worldXZ` = same node the material uses to sample displacement.
     */
    shadingNode(worldXZ: any): any {
      let raw: any = float(0);
      for (const lane of lanes) {
        raw = raw.add(texture(lane.front, worldXZ.div(lane.domain)).r);
      }
      return foamDetailMask(clamp(raw, 0, 1), worldXZ);
    },

    dispose(): void {
      for (const lane of lanes) {
        lane.front.dispose();
        lane.back.dispose();
      }
    },
  };
}

export type FoamSim = ReturnType<typeof createFoamSim>;
