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
import {
  capVariationNode,
  foamDetailMask,
  foamWarpVec,
  updateFoamShadingUniforms,
} from './foamShading';

export { foamDetailMask, foamShadingNode, foamTintNode } from './foamShading';
export { createSpray, createBowSpray } from './spray'; // crest + bow spray (see spray.ts/bowSpray.ts headers)

export interface FoamCascadeInput {
  /** ocean unpack output: (λDx, h, λDz, J) — w = jacobian (§V6) */
  displacement: THREE.StorageTexture;
  /** world-space meters this cascade tiles over (§V19) */
  domain: number;
}

export function createFoamSim(cascades: FoamCascadeInput[], resolution: number) {
  // fail loud at construction (freeze audit): resolution bakes the dispatch
  // count (n·n) and texture sizes; domains divide world coords in shadingNode
  for (const c of cascades) {
    if (!Number.isFinite(c.domain) || c.domain <= 0) {
      throw new Error(`foam: invalid cascade domain ${c.domain}`);
    }
  }
  if (!Number.isInteger(resolution) || resolution < 1) {
    throw new Error(`foam: invalid resolution ${resolution}`);
  }
  const u = createFoamUniforms();
  // fine ripple cascade gets its OWN uniforms: its ~14m jacobian tile stamps
  // whitecaps on a perfect world grid (§V19, user-reported), so its inject is
  // gated separately (bias sunk to -10 = never injects; decay still drains)
  const uFine = createFoamUniforms();
  let time = 0;

  const lanes = cascades.map((c, i) => {
    const lu = i === cascades.length - 1 ? uFine : u;
    const front = createOutputTexture(resolution); // A — stable output
    const back = createOutputTexture(resolution); // B — inject scratch
    return {
      domain: c.domain,
      front,
      back,
      inject: createInjectPass(c.displacement, front, back, resolution, lu),
      blurDecay: createBlurDecayPass(back, front, resolution, lu),
    };
  });

  return {
    /** per-cascade foam textures (R = foam), index-aligned with `cascades` */
    foamTextures: lanes.map((l) => l.front),

    /** run once per fixed sim tick (§V2), after the ocean cascade update */
    update(renderer: THREE.WebGPURenderer): void {
      time += SIM_DT; // fixed-tick clock for the detail churn (§V2)
      u.uBias.value = oceanParams.jacobianFoamBias; // live, storm-driven §V7
      // clamp ≥ 0: a negative strength would pump NEGATIVE foam into the
      // accumulator (min-1 clamp has no floor) — nonsense mask, not injection
      u.uInjectPerFrame.value = Math.max(0, foamParams.injectStrength) * SIM_DT;
      u.uDecay.value = decayFactorPerFrame(foamParams.decayHalfLife, SIM_DT);
      u.uRadius.value = foamParams.blurRadius;
      uFine.uBias.value =
        foamParams.injectFineCascade >= 1 ? oceanParams.jacobianFoamBias : -10;
      uFine.uInjectPerFrame.value = u.uInjectPerFrame.value;
      uFine.uDecay.value = u.uDecay.value;
      uFine.uRadius.value = u.uRadius.value;
      updateFoamShadingUniforms(foamParams, time);
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
      // fbm domain-warp on the LOOKUP (world meters) — the low-res sim RT's
      // texel grid otherwise reads as boxy patches (§V20 critique)
      const warped = worldXZ.add(foamWarpVec(worldXZ));
      let raw: any = float(0);
      for (const lane of lanes) {
        raw = raw.add(texture(lane.front, warped.div(lane.domain)).r);
      }
      // world-space cap variation (NON-tiling, drifts slowly): the FFT field
      // repeats per domain, so identical caps pulse in sync on a lattice —
      // this mask gives every world position its own strength/lifecycle,
      // and the detail knee then culls the weakened ones (§B.4 class fix)
      raw = raw.mul(capVariationNode(worldXZ));
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
