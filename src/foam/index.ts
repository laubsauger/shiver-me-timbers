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
import { cameraPosition, clamp, float, mix, smoothstep, texture, uniform } from 'three/tsl';
import { SIM_DT } from '../core/loop';
import { createOutputTexture } from '../ocean/oceanTextures';
import { foamParams } from '../params/foam';
import { oceanParams } from '../params/ocean';
import { decayFactorPerFrame, foamTexelMetres } from './foamMath';
import {
  createBlurDecayPass,
  createInjectPass,
  createFoamUniforms,
  createReducePass,
} from './foamPasses';
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

/** box-reduction step per pass; two of these build the far tier (16× total) */
const REDUCE_FACTOR = 4;

/** distance fades for the cascade bands, in texel widths (foamMath) */
const uCascadeFadeTexels = uniform(2300);
const uCascadeFadeSpan = uniform(3);

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

  // Filtered far-field tier (§V6 sampling, ocean agent's horizon-sizzle
  // finding): StorageTextures have NO mip chain, so a distant pixel covering
  // thousands of texels gets ONE of them and shimmers. Only the COARSEST
  // cascade needs the tier — the finer bands are sub-pixel long before this
  // distance and simply retire (cascadeDetailWeight). Two 4× box reductions
  // rather than one 16× so the taps stay unrolled and cheap.
  // fail loud rather than build a tier that reads outside its source: the
  // reductions assume exact division, and an out-of-range textureLoad returns
  // zero in WGSL — which would silently DIM distant foam instead of erroring
  const tierDivisor = REDUCE_FACTOR * REDUCE_FACTOR;
  const canTier = resolution % tierDivisor === 0 && resolution >= tierDivisor;
  if (!canTier) {
    throw new Error(
      `foam: resolution ${resolution} must be a multiple of ${tierDivisor} to ` +
        'build the filtered far tier (StorageTextures carry no mips, so the ' +
        'tier is what keeps distant foam from aliasing)',
    );
  }
  const coarseMidN = resolution / REDUCE_FACTOR;
  const coarseN = coarseMidN / REDUCE_FACTOR;

  const lanes = cascades.map((c, i) => {
    const lu = i === cascades.length - 1 ? uFine : u;
    const front = createOutputTexture(resolution); // A — stable output
    const back = createOutputTexture(resolution); // B — inject scratch
    const coarsest = i === 0;
    const coarseMid = coarsest ? createOutputTexture(coarseMidN) : null;
    const coarse = coarsest ? createOutputTexture(coarseN) : null;
    return {
      domain: c.domain,
      texelMetres: foamTexelMetres(c.domain, resolution),
      front,
      back,
      coarse,
      inject: createInjectPass(c.displacement, front, back, resolution, lu),
      blurDecay: createBlurDecayPass(back, front, resolution, lu),
      // reductions run off `front`, i.e. AFTER the blur+decay of this tick,
      // so the tier is always a filtered view of what is actually on screen
      reduce:
        coarseMid && coarse
          ? [
              createReducePass(front, coarseMid, coarseMidN, REDUCE_FACTOR),
              createReducePass(coarseMid, coarse, coarseN, REDUCE_FACTOR),
            ]
          : [],
      coarseMid,
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
      // crest-frame tap stretch (§V6 cap shape): floored ≥ 0 so a negative
      // slider can't mirror the kernel into itself
      u.uAlong.value = Math.max(0, foamParams.crestBlurAlong);
      u.uAcross.value = Math.max(0, foamParams.crestBlurAcross);
      // crest lines run ACROSS the wave propagation (≈ wind) direction
      u.uAcrossX.value = Math.cos(oceanParams.windDirection);
      u.uAcrossZ.value = Math.sin(oceanParams.windDirection);
      uFine.uBias.value =
        foamParams.injectFineCascade >= 1 ? oceanParams.jacobianFoamBias : -10;
      uFine.uInjectPerFrame.value = u.uInjectPerFrame.value;
      uFine.uDecay.value = u.uDecay.value;
      uFine.uRadius.value = u.uRadius.value;
      uFine.uAlong.value = u.uAlong.value;
      uFine.uAcross.value = u.uAcross.value;
      uFine.uAcrossX.value = u.uAcrossX.value;
      uFine.uAcrossZ.value = u.uAcrossZ.value;
      uCascadeFadeTexels.value = Math.max(1, foamParams.cascadeFadeTexels);
      uCascadeFadeSpan.value = Math.max(1.05, foamParams.cascadeFadeSpan);
      updateFoamShadingUniforms(foamParams, time, oceanParams.windDirection);
      for (const lane of lanes) {
        renderer.compute(lane.inject as Parameters<THREE.WebGPURenderer['compute']>[0]);
        renderer.compute(lane.blurDecay as Parameters<THREE.WebGPURenderer['compute']>[0]);
        for (const pass of lane.reduce) {
          renderer.compute(pass as Parameters<THREE.WebGPURenderer['compute']>[0]);
        }
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
      // Distance-driven band retirement + filtered far tier. Each cascade's
      // full-res sample is worth reading only while its texels resolve on
      // screen; past that it is noise and must hand over to the pre-filtered
      // coarse tier (the coarsest band) or simply retire (the finer ones).
      const camDist = worldXZ.sub(cameraPosition.xz).length();
      let raw: any = float(0);
      for (const lane of lanes) {
        const uv = warped.div(lane.domain);
        const fine = texture(lane.front, uv).r;
        const start = float(lane.texelMetres).mul(uCascadeFadeTexels);
        const w = smoothstep(start, start.mul(uCascadeFadeSpan.max(1.05)), camDist)
          .oneMinus();
        // coarsest band cross-fades into its filtered tier so broad foam
        // still reaches the horizon — just band-limited instead of sizzling;
        // finer bands fade to nothing, which is what averaging them out means
        raw = raw.add(lane.coarse ? mix(texture(lane.coarse, uv).r, fine, w) : fine.mul(w));
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
        lane.coarseMid?.dispose();
        lane.coarse?.dispose();
      }
    },
  };
}

export type FoamSim = ReturnType<typeof createFoamSim>;
