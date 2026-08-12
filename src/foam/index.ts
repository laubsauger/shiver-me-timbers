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
 *     sea: OceanSimulation,             // LIVE spectral moments (§V36)
 *   ) => {
 *     update(renderer, frameDt): void;  // call per RENDERED frame; it steps
 *                                       //   itself at the fixed SIM_DT (§V2)
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
import { advanceAccumulator, SIM_DT } from '../core/loop';
import { createOutputTexture } from '../ocean/oceanTextures';
import { foamParams } from '../params/foam';
import { oceanParams } from '../params/ocean';
import {
  cascadeFoamBias,
  cascadeInjectPerStep,
  decayFactorPerFrame,
  foamTexelMetres,
  jacobianSigma,
  NEVER_INJECT_BIAS,
} from './foamMath';
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

/**
 * The LIVE spectral moments the foam gate is expressed in (§V36).
 * `OceanSimulation` satisfies this structurally — pass it directly, and pass
 * the object (not a snapshot of its numbers): every field here is re-read on
 * every update so the gate tracks weather and spectrum rebuilds (§B.7).
 *
 * Required, not optional. Given a default the gate would fall back to a flat
 * absolute threshold, which is the bug this interface exists to end, and it
 * would do it silently — the whole §B "silent no-op" family.
 */
export interface FoamSeaMoments {
  /** per-cascade RMS ∂Dx/∂x at λ=1, index-aligned with the cascades */
  readonly cascades: readonly { readonly steepnessRms: number }[];
  /** the same moment summed in quadrature over all cascades */
  readonly steepnessRms: number;
  /** choppiness λ actually sent to the GPU (the anti-fold cap, not the slider) */
  effectiveChoppiness(): number;
}

/** box-reduction step per pass; two of these build the far tier (16× total) */
const REDUCE_FACTOR = 4;

/** distance fades for the cascade bands, in texel widths (foamMath) */
const uCascadeFadeTexels = uniform(2300);
const uCascadeFadeSpan = uniform(3);

export function createFoamSim(
  cascades: FoamCascadeInput[],
  resolution: number,
  sea: FoamSeaMoments,
) {
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
  // index-aligned by contract: lane i reads sea.cascades[i].steepnessRms, so a
  // length mismatch would gate a band against another band's σ — the same
  // wrong-statistic bug one level down. Loud at construction, not per texel.
  if (!sea || sea.cascades.length !== cascades.length) {
    throw new Error(
      `foam: sea moments must cover all ${cascades.length} cascades ` +
        `(got ${sea?.cascades.length}) — the §V36 jacobian gate is expressed ` +
        'as a multiple of each band\'s own live σ',
    );
  }
  let time = 0;
  /** leftover frame time, so the sim steps at SIM_DT and not at display rate */
  let accumulator = 0;

  // Filtered far-field tier (§V6 sampling, ocean agent's horizon-sizzle
  // finding): StorageTextures have NO mip chain, so a distant pixel covering
  // thousands of texels gets ONE of them and shimmers. Only the COARSEST
  // cascade needs the tier — the finer bands are sub-pixel long before this
  // distance and simply retire (cascadeDetailWeight). Two 4× box reductions
  // rather than one 16× so the taps stay unrolled and cheap — and BOTH are
  // sampled (shadingNode), which is the whole reason there are two: a single
  // 16× step lands 13 m texels at a distance that only justified 3.3 m ones.
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
    // ONE uniform set PER LANE. The bias and the injection scale are now
    // per-band quantities (§V36 — each band's own live σ), so a shared uniform
    // block cannot express them; sharing is what forced the old code to gate
    // the fine band with a second hard-coded "never" bias instead.
    const lu = createFoamUniforms();
    const front = createOutputTexture(resolution); // A — stable output
    const back = createOutputTexture(resolution); // B — inject scratch
    const coarsest = i === 0;
    const coarseMid = coarsest ? createOutputTexture(coarseMidN) : null;
    const coarse = coarsest ? createOutputTexture(coarseN) : null;
    return {
      index: i,
      u: lu,
      domain: c.domain,
      texelMetres: foamTexelMetres(c.domain, resolution),
      // each tier's OWN texel size — the distance at which IT goes sub-pixel,
      // which is the only honest place to hand over to the next one
      midTexelMetres: foamTexelMetres(c.domain, coarseMidN),
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

    /**
     * Call once per RENDERED frame with that frame's wall dt, after the ocean
     * cascade update. It runs its passes a whole number of SIM_DT steps (§V2):
     * foam is an ACCUMULATOR — inject, decay and blur all compound per
     * dispatch — so one dispatch per rendered frame made a 120 fps machine
     * decay foam exactly twice as fast as a 60 fps one, on identical sim
     * input. Stepping on the fixed clock instead makes the visible foam
     * lifetime a property of `decayHalfLife` alone, at any display rate.
     */
    update(renderer: THREE.WebGPURenderer, frameDt: number = SIM_DT): void {
      const dt = Number.isFinite(frameDt) && frameDt > 0 ? frameDt : SIM_DT;
      const step = advanceAccumulator(accumulator, dt);
      accumulator = step.accumulator;
      time += step.steps * SIM_DT; // fixed-tick clock for the detail churn

      // ---- §V36: per-band gate from the LIVE spectral moments -------------
      // The artist's `jacobianFoamBias` is a threshold on the SUMMED jacobian
      // (surfaceMaterial: d0.w+d1.w+d2.w−2). Each lane injects from ONE band,
      // whose σ is 2–3× smaller, so the same number has to be re-expressed at
      // the band's own σ or it silently becomes a far rarer event — see
      // foamMath.cascadeFoamBias.
      const lambda = sea.effectiveChoppiness();
      const seaSigma = jacobianSigma(sea.steepnessRms, lambda);
      const decay = decayFactorPerFrame(foamParams.decayHalfLife, SIM_DT);
      // crest lines run ACROSS the wave propagation (≈ wind) direction
      const acrossX = Math.cos(oceanParams.windDirection);
      const acrossZ = Math.sin(oceanParams.windDirection);
      const fineOff = foamParams.injectFineCascade < 1;
      for (const lane of lanes) {
        const bandSigma = jacobianSigma(sea.cascades[lane.index].steepnessRms, lambda);
        // finest band keeps its opt-out switch (see params/foam.ts) — decay
        // still drains whatever it holds, only injection stops
        const off = fineOff && lane.index === lanes.length - 1;
        lane.u.uBias.value = off
          ? NEVER_INJECT_BIAS
          : cascadeFoamBias(oceanParams.jacobianFoamBias, bandSigma, seaSigma);
        // σ-relative amount too: `injectStrength` = foam/s per σ of fold depth
        // (a raw deficit is 2.5× bigger in the fine band than the coarse one).
        // Floored ≥ 0 — negative strength would pump NEGATIVE foam into the
        // accumulator, whose min-1 clamp has no floor.
        lane.u.uInjectPerFrame.value = off
          ? 0
          : cascadeInjectPerStep(foamParams.injectStrength, SIM_DT, bandSigma, seaSigma);
        lane.u.uDecay.value = decay;
        lane.u.uRadius.value = foamParams.blurRadius;
        // crest-frame tap stretch (§V6 cap shape): floored ≥ 0 so a negative
        // slider can't mirror the kernel into itself
        lane.u.uAlong.value = Math.max(0, foamParams.crestBlurAlong);
        lane.u.uAcross.value = Math.max(0, foamParams.crestBlurAcross);
        lane.u.uAcrossX.value = acrossX;
        lane.u.uAcrossZ.value = acrossZ;
      }
      uCascadeFadeTexels.value = Math.max(1, foamParams.cascadeFadeTexels);
      uCascadeFadeSpan.value = Math.max(1.05, foamParams.cascadeFadeSpan);
      // shading uniforms are display-side: refresh them every frame, even on
      // frames that owe no sim step
      updateFoamShadingUniforms(foamParams, time, oceanParams.windDirection);
      for (let s = 0; s < step.steps; s++) {
        for (const lane of lanes) {
          renderer.compute(lane.inject as Parameters<THREE.WebGPURenderer['compute']>[0]);
          renderer.compute(lane.blurDecay as Parameters<THREE.WebGPURenderer['compute']>[0]);
          for (const pass of lane.reduce) {
            renderer.compute(pass as Parameters<THREE.WebGPURenderer['compute']>[0]);
          }
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
      /** 1 while texels this size resolve on screen, 0 once they are sub-pixel */
      const tierWeight = (texelMetres: number) => {
        const start = float(texelMetres).mul(uCascadeFadeTexels);
        return smoothstep(start, start.mul(uCascadeFadeSpan.max(1.05)), camDist).oneMinus();
      };
      let raw: any = float(0);
      for (const lane of lanes) {
        const uv = warped.div(lane.domain);
        const fine = texture(lane.front, uv).r;
        const wFine = tierWeight(lane.texelMetres);
        if (lane.coarse) {
          /**
           * DIAGNOSED, NOT YET FIXED (§Rule 8) — candidate cause of the "hard
           * blocky quantised squares in the sun glint road" the user reported.
           *
           * The reduce chain builds 512² → 128² → 32², but this cross-fades
           * `fine` STRAIGHT into `coarse` and never samples the 128² middle
           * tier — which the sim computes every frame and then discards. So at
           * the fine tier's own fade distance the sample jumps 0.82 m texels →
           * 13.1 m texels in ONE step: 16× the texel AREA at a distance that
           * only justified 4×. Past that distance the whole coarsest cascade is
           * read from a 32×32 texture, and bilinear on 32×32 stretched over
           * kilometres of sea is a lattice of 13 m quads. It would show worst
           * in the GLINT ROAD, because the surface material divides its
           * specular by this mask (`spec · (1 − foamAmount·0.7)`) — a blocky
           * mask carves blocky holes exactly where the water is brightest.
           *
           * The fix is a three-tier handover, each at its own Nyquist distance
           * (`lane.midTexelMetres` is already computed for it):
           *     mix(mix(coarse, mid, tierWeight(midTexelMetres)), fine, wFine)
           * It is NOT shipped because it adds a sampled texture to the ocean
           * material, and §V40 says that is precisely how this material dies:
           * overrun the per-stage limit and pipeline creation fails, the
           * material never draws, and the console names the DESCRIPTOR rather
           * than the feature that added the 17th texture. A blank render and
           * `GPUPipelineError: [Invalid PipelineLayout] is invalid due to a
           * previous error` were observed with it in, but the tree had other
           * agents' in-flight edits to this same material at the time and the
           * page would not stay up long enough to bisect. Land it only with a
           * clean tree and a sampler recount.
           */
          const coarse = texture(lane.coarse, uv).r;
          raw = raw.add(mix(coarse, fine, wFine));
        } else {
          // finer bands have no tier: they fade to nothing, which IS the
          // average of a field whose features are far below one pixel
          raw = raw.add(fine.mul(wFine));
        }
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
