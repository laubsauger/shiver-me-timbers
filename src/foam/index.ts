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
import { clamp, float, mix, smoothstep, texture, uniform } from 'three/tsl';
import { advanceAccumulator, SIM_DT } from '../core/loop';
import { createOutputTexture } from '../ocean/oceanTextures';
import { foamParams } from '../params/foam';
import { oceanParams } from '../params/ocean';
import {
  blurMixPerStep,
  decayFactorPerFrame,
  eigenFoamGate,
  eigenInjectPerStep,
  foamTexelMetres,
  jacobianSigma,
  meanFoamAgeTicks,
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
  coordFootprint,
  foamDetailMask,
  foamWarpVec,
  updateFoamShadingUniforms,
} from './foamShading';

export { foamDetailMask, foamShadingNode, foamTintNode } from './foamShading';
export { createSpray, createBowSpray } from './spray'; // crest + bow spray (see spray.ts/bowSpray.ts headers)

export interface FoamCascadeInput {
  /** ocean unpack output: (λDx, h, λDz, det J) — w = jacobian (§V6) */
  displacement: THREE.StorageTexture;
  /**
   * ocean unpack output: (∂h/∂x, ∂h/∂z, ∂Dx/∂x, ∂Dz/∂z). The zw pair is the
   * TRACE of the displacement jacobian, and trace + determinant is exactly
   * what the minimum eigenvalue needs (foamMath, "THE FOLD METRIC") — which
   * is why the fix for the round, same-sized, same-angle caps costs the ocean
   * nothing: both textures were already being written every frame.
   */
  derivatives: THREE.StorageTexture;
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
  /**
   * Per-cascade RMS of the Jacobian TRACE (∂Dx/∂x + ∂Dz/∂z) at λ=1,
   * index-aligned with the cascades. NOT `steepnessRms` (the x-gradient only):
   * that moment is direction-dependent and the sea now carries two trains with
   * very different headings and spreads — see foamMath's JACOBIAN_SIGMA_PER_TRACE.
   */
  readonly cascades: readonly { readonly jacobianRms: number }[];
  /** the same moment summed in quadrature over all cascades */
  readonly jacobianRms: number;
  /** choppiness λ actually sent to the GPU (the anti-fold cap, not the slider) */
  effectiveChoppiness(): number;
}

/**
 * Box-reduction factor for the filtered far tier.
 *
 * ONE reduction, not two. The chain used to build 512² → 128² → 32² and then
 * cross-fade the full-res tier STRAIGHT into the 32² one, never sampling the
 * 128² tier it computed every frame: the sample jumped 0.82 m texels → 13.1 m
 * texels in a single step, 16× the texel AREA at a distance that justified 4×,
 * and past that the whole coarsest cascade was read from a 32×32 texture —
 * bilinear on 32×32 stretched over kilometres, i.e. a lattice of 13 m quads,
 * worst exactly in the glint road (the surface material divides its specular
 * by this mask). The three-tier handover that would fix it needs a third
 * sampled texture and the ocean fragment stage is at 16/16 samplers (§V40).
 * Sampling the 128² tier INSTEAD of the 32² one fixes the same jump for free:
 * 4× the texel area, at its own Nyquist distance, no new binding, one fewer
 * compute dispatch. The 32² tier only ever earned its keep past ~7.5 km, and
 * the readable sea ends at ~4 km (§V30).
 */
const REDUCE_FACTOR = 4;

/**
 * Tier handover, in PIXELS PER TEXEL — not in camera distance.
 *
 * MEASURED IN THE BROWSER, from the high camera the user shot all four
 * `docs/bug-foam-lattice-*.png` from. The old gate was a camera-DISTANCE ramp
 * (`cascadeFadeTexels` = 2300 texel widths), which folds the angular pixel
 * size and the Nyquist margin into one constant and therefore cannot know the
 * GRAZING STRETCH — and from a high camera the grazing stretch is the whole
 * story. At 300 m altitude one pixel covers 0.234 m of sea while a cascade-1
 * foam texel is 0.191 m, i.e. the band was already past Nyquist, and the
 * distance ramp did not even START retiring it until 440 m. The result was a
 * dense field of hard 1–3 m specks over the entire frame: the "very
 * grittiness" of the report, still there after the procedural detail layers
 * were band-limited, because this is the SAME §V.48 error one level up — a
 * band limit measured against a proxy instead of against the sampling rate.
 * Forcing the old constant down to 700 removed the specks completely and
 * confirmed the mechanism (it also removed all real detail, so it is not the
 * fix — it is the same guess, guessed lower).
 *
 * `fwidth` of the sample coordinate IS the sampling rate, at every camera
 * angle and altitude, with nothing to tune per shot. Keep a tier while its
 * texel still spans `uTierKeepPixels`, fade it out by one pixel — the same
 * rule `bandLimitedFbm2` applies to a noise octave, applied to a texture tier.
 */
const uTierKeepPixels = uniform(2);
const uTierFadeSpan = uniform(2);

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
  // index-aligned by contract: lane i reads sea.cascades[i].jacobianRms, so a
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
  const canTier = resolution % REDUCE_FACTOR === 0 && resolution >= REDUCE_FACTOR;
  if (!canTier) {
    throw new Error(
      `foam: resolution ${resolution} must be a multiple of ${REDUCE_FACTOR} to ` +
        'build the filtered far tier (StorageTextures carry no mips, so the ' +
        'tier is what keeps distant foam from aliasing)',
    );
  }
  const coarseN = resolution / REDUCE_FACTOR;

  const lanes = cascades.map((c, i) => {
    // ONE uniform set PER LANE. The bias and the injection scale are now
    // per-band quantities (§V36 — each band's own live σ), so a shared uniform
    // block cannot express them; sharing is what forced the old code to gate
    // the fine band with a second hard-coded "never" bias instead.
    const lu = createFoamUniforms();
    const front = createOutputTexture(resolution); // A — stable output
    const back = createOutputTexture(resolution); // B — inject scratch
    /**
     * Which bands get a filtered tier — MEASURED IN THE BROWSER, not assumed.
     *
     * Only the coarsest band had one, and from the high camera that was wrong:
     * at 300 m altitude one pixel covers ~0.25–0.5 m of sea while cascade 1's
     * texel is 0.191 m, so that band is genuinely past Nyquist there — but its
     * FEATURES are 1–3 m caps, five to fifteen texels across, which are
     * perfectly resolvable and are most of what the sea's mid-scale reads as.
     * Retiring the band (the first fix) removed the aliasing AND the caps, and
     * left sparse cotton-wool on bare water. A band whose features still
     * resolve but whose texels do not needs FILTERING, not retirement.
     *
     * Cascade 2 (22.7 m domain, 0.044 m texels) is different and genuinely
     * retires: its features are ≤ 1 m, sub-pixel past ~50 m, so even its
     * reduced tier would be sub-pixel and fading to the mean IS the answer.
     */
    const wantsTier = i < cascades.length - 1;
    const coarse = wantsTier ? createOutputTexture(coarseN) : null;
    return {
      index: i,
      u: lu,
      domain: c.domain,
      texelMetres: foamTexelMetres(c.domain, resolution),
      // the tier's OWN texel size — the distance at which IT goes sub-pixel,
      // which is the only honest place to hand over
      coarseTexelMetres: foamTexelMetres(c.domain, coarseN),
      front,
      back,
      coarse,
      inject: createInjectPass(c.displacement, c.derivatives, front, back, resolution, lu),
      blurDecay: createBlurDecayPass(back, front, resolution, lu),
      // the reduction runs off `front`, i.e. AFTER the blur+decay of this tick,
      // so the tier is always a filtered view of what is actually on screen
      reduce: coarse ? [createReducePass(front, coarse, coarseN, REDUCE_FACTOR)] : [],
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
      // The artist's `jacobianFoamBias` is a threshold on the SUMMED det J
      // (surfaceMaterial: d0.w+d1.w+d2.w−2), read as a σ-multiple below its
      // rest value of 1. Each lane injects from ONE band, and from λ− rather
      // than det J, so that σ-multiple has to be re-expressed against the
      // band's own λ− mean AND spread — both differ, and λ−'s mean is not 1
      // even on a flat sea. See foamMath, "THE FOLD METRIC" and §V36 for λ−.
      const lambda = sea.effectiveChoppiness();
      const seaSigma = jacobianSigma(sea.jacobianRms, lambda);
      const decay = decayFactorPerFrame(foamParams.decayHalfLife, SIM_DT);
      // how many blur steps the foam you can SEE has been through — the blur
      // budget below is spent over exactly this many ticks (foamMath)
      const ageTicks = meanFoamAgeTicks(decay);
      const fineOff = foamParams.injectFineCascade < 1;
      for (const lane of lanes) {
        const steep = sea.cascades[lane.index].jacobianRms;
        const bandSigma = jacobianSigma(steep, lambda);
        // finest band keeps its opt-out switch (see params/foam.ts) — decay
        // still drains whatever it holds, only injection stops
        const off = fineOff && lane.index === lanes.length - 1;
        lane.u.uBias.value = off
          ? NEVER_INJECT_BIAS
          : eigenFoamGate(oceanParams.jacobianFoamBias, steep, lambda, bandSigma, seaSigma);
        // σ-relative amount too: `injectStrength` = foam/s per σ of fold depth.
        // Floored ≥ 0 — negative strength would pump NEGATIVE foam into the
        // accumulator, whose min-1 clamp has no floor.
        lane.u.uInjectPerFrame.value = off
          ? 0
          : eigenInjectPerStep(foamParams.injectStrength, SIM_DT, steep, lambda, bandSigma, seaSigma);
        lane.u.uDecay.value = decay;
        lane.u.uRadius.value = foamParams.blurRadius;
        // ONE world diffusion length for every band (§B: the blur was the
        // shape, and it was a grid quantity). `blurRadius` alone made the
        // spread proportional to the band's TEXEL — 12.27 m of isotropic
        // diffusion on cascade 0's 2.65 m caps against 1.19 m on cascade 1's
        // 0.72 m ones — so each cascade drew discs of its own size and no
        // injected anisotropy survived the coarse band at all.
        lane.u.uBlurMix.value = blurMixPerStep(
          foamParams.blurSpreadMetres,
          lane.texelMetres,
          foamParams.blurRadius,
          ageTicks,
        );
        // the derivatives texture stores ∂D unscaled, so the metric needs the
        // EFFECTIVE λ (the anti-fold cap), not the slider
        lane.u.uChoppiness.value = lambda;
      }
      uTierKeepPixels.value = Math.max(1, foamParams.tierKeepPixels);
      uTierFadeSpan.value = Math.max(1.05, foamParams.tierFadeSpan);
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
      // Sampling-rate-driven band retirement + filtered far tier. Each
      // cascade's full-res sample is worth reading only while its texels
      // still resolve on screen; past that it is aliasing and must hand over
      // to the pre-filtered tier (the coarsest band) or retire (the finer
      // ones — fading to nothing IS the average of a field whose features are
      // far below one pixel).
      /** world metres one pixel covers here — grazing stretch included */
      const pixelMetres = coordFootprint(worldXZ);
      /** 1 while texels this size resolve on screen, 0 once they are sub-pixel */
      const tierWeight = (texelMetres: number) => {
        // e0 > e1: 1 below the keep width, 0 above one pixel per texel
        const keep = float(texelMetres).div(uTierKeepPixels.max(1));
        return smoothstep(keep.mul(uTierFadeSpan.max(1.05)), keep, pixelMetres);
      };
      let raw: any = float(0);
      for (const lane of lanes) {
        const uv = warped.div(lane.domain);
        const fine = texture(lane.front, uv).r;
        const wFine = tierWeight(lane.texelMetres);
        if (lane.coarse) {
          // Hand over at the FINE tier's own Nyquist point to the tier whose
          // texels are 4× the area — not 16× (see REDUCE_FACTOR) — and retire
          // that one at ITS Nyquist point too, rather than letting a 3.3 m
          // texel alias its way to the horizon.
          const coarse = texture(lane.coarse, uv).r.mul(tierWeight(lane.coarseTexelMetres));
          raw = raw.add(mix(coarse, fine, wFine));
        } else {
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
        lane.coarse?.dispose();
      }
    },
  };
}

export type FoamSim = ReturnType<typeof createFoamSim>;
