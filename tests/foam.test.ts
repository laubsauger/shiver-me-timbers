/**
 * §V6 foam sim invariants, verified against the CPU mirror (foamMath) of the
 * GPU compute passes. Each test encodes WHY the behavior matters for the
 * look: crests must be born sharp and then spread/dissipate on a tunable
 * clock (progressive blur), injection must only ever add foam where waves
 * fold, the blur must conserve foam so decay alone controls lifetime, and
 * everything must wrap because each foam texture tiles with its cascade
 * domain (§V19).
 */
import { describe, expect, it } from 'vitest';
import {
  GAUSSIAN_3X3,
  JACOBIAN_SIGMA_PER_TRACE,
  NEVER_INJECT_BIAS,
  accumulateFoam,
  bandCanFold,
  blurDecayAt,
  blurMixPerStep,
  breakingGain,
  breakupJitter,
  breakupJitterAligned,
  crestFrame,
  tensorRadiusTexels,
  metricSigmaScale,
  breakupOctaves,
  expectedBandFoam,
  expectedDeficit,
  normalCdf,
  crestBiasPerMetre,
  foamMaskFrom,
  meanFoamAgeTicks,
  boxReduceAt,
  tierWeightAt,
  cascadeFoamBias,
  cascadeInjectPerStep,
  EIGEN_MEAN_PER_TRACE,
  EIGEN_SIGMA_PER_TRACE,
  eigenFoamGate,
  eigenInjectPerStep,
  eigenRestValue,
  eigenSigma,
  foamGateZ,
  minEigenvalue,
  foamTexelMetres,
  decayFactorPerFrame,
  dissolveKnee,
  waveCarveOffset,
  foamBodyLevel,
  injectAmount,
  jacobianSigma,
  whitecapCoverage,
  whitecapWindScale,
  WHITECAP_ONSET_MS,
  wrapIndex,
} from '../src/foam/foamMath';
import {
  buildFoamPattern,
  FOAM_CHANNEL,
  FOAM_CREST_MEAN,
  FOAM_SOFT_MEAN,
} from '../src/foam/foamPattern';
import { foamParams } from '../src/params/foam';
import { oceanParams, type OceanParams } from '../src/params/ocean';
import {
  cascadeBand,
  effectiveChoppiness,
  generateButterfly,
  generateH0,
  waveSpectrum,
  spectralJacobianRms,
  spectralSteepness,
} from '../src/ocean/oceanMath';
import { cpuIFFT2D, extractCentralBlock } from '../src/sea-physics/cpuOcean';
import { weatherPresets } from '../src/weather/presets';
import { advanceAccumulator, SIM_DT } from '../src/core/loop';
import { getParamsEntry } from '../src/params/registry';

const DT = 1 / 60; // §V2 fixed sim tick

describe('decay factor (§V6 dissipation clock)', () => {
  it('after halfLife seconds of frames the value has halved', () => {
    // WHY: the tunable is a half-life so artists can reason "foam lasts about
    // a second" — if N frames of the per-frame factor missed 0.5, the
    // Tweakpane value would lie and storm tuning (§V7) becomes guesswork.
    const halfLife = 1.2;
    const factor = decayFactorPerFrame(halfLife, DT);
    const frames = Math.round(halfLife / DT);
    expect(Math.pow(factor, frames)).toBeCloseTo(0.5, 10);
  });

  it('is strictly inside (0, 1) — foam always fades, never grows or sticks', () => {
    for (const h of [0.05, 1, 10]) {
      const f = decayFactorPerFrame(h, DT);
      expect(f).toBeGreaterThan(0);
      expect(f).toBeLessThan(1);
    }
  });

  it('composes across tick sizes: two dt steps = one 2·dt step', () => {
    // WHY: decay must be a property of elapsed sim time, not of frame count,
    // or a future tick-rate change would silently retune every foam preset.
    const f1 = decayFactorPerFrame(1.2, DT);
    const f2 = decayFactorPerFrame(1.2, 2 * DT);
    expect(f1 * f1).toBeCloseTo(f2, 12);
  });

  it('non-positive half-life kills foam instantly instead of dividing by zero', () => {
    expect(decayFactorPerFrame(0, DT)).toBe(0);
    expect(decayFactorPerFrame(-1, DT)).toBe(0);
  });
});

describe('injection (§V6 jacobian → foam, §V7 storm bias)', () => {
  it('jacobian below bias injects foam proportional to the deficit', () => {
    // WHY: deeper wave folding (more negative J) must make MORE foam — this
    // proportionality is what turns a lowered storm bias into big patches.
    const a = injectAmount(-0.2, 0.0, 4, DT);
    const b = injectAmount(-0.6, 0.0, 4, DT);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeCloseTo(3 * a, 12);
  });

  it('jacobian at or above bias injects exactly zero', () => {
    // WHY: calm, un-folded water (J ≈ 1) must neither add nor scrub foam —
    // a negative "injection" would eat foam faster than the decay half-life.
    expect(injectAmount(1.0, 0.0, 4, DT)).toBe(0);
    expect(injectAmount(0.0, 0.0, 4, DT)).toBe(0);
  });

  it('raising the bias (storm) creates foam where calm settings had none', () => {
    const calmBias = 0.0;
    const stormBias = 0.5;
    expect(injectAmount(0.3, calmBias, 4, DT)).toBe(0);
    expect(injectAmount(0.3, stormBias, 4, DT)).toBeGreaterThan(0);
  });

  it('accumulation adds to existing foam and clamps at 1', () => {
    // WHY: the foam value is a mix factor for crest→soft blending (§V6);
    // values above 1 would overdrive the blend and break the age proxy.
    expect(accumulateFoam(0.3, 0.2)).toBeCloseTo(0.5, 12);
    expect(accumulateFoam(0.9, 5)).toBe(1);
  });
});

describe('progressive blur (§V6: sharp at birth, then spreads and dissipates)', () => {
  const n = 8;
  const impulse = (x: number, y: number): Float32Array => {
    const g = new Float32Array(n * n);
    g[y * n + x] = 1;
    return g;
  };
  const step = (src: Float32Array, radius: number, decay: number): Float32Array => {
    const out = new Float32Array(n * n);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) out[y * n + x] = blurDecayAt(src, n, x, y, radius, decay);
    return out;
  };
  const total = (g: Float32Array) => g.reduce((s, v) => s + v, 0);

  it('gaussian weights sum to exactly 1 — blur conserves foam', () => {
    // WHY: if the kernel gained or lost mass, foam lifetime would depend on
    // the blur instead of ONLY on decayHalfLife, making the param a lie.
    expect(GAUSSIAN_3X3.reduce((s, w) => s + w, 0)).toBe(1);
  });

  it('a fresh crest spreads: center loses foam, neighbors gain it', () => {
    // WHY: this is the whole trick (docs/ocean-foam-progressive-blur.png) —
    // dissipation without particle physics comes from repeated blurring.
    const out = step(impulse(3, 3), 1, 1);
    expect(out[3 * n + 3]).toBeLessThan(1);
    expect(out[3 * n + 4]).toBeGreaterThan(0); // orthogonal neighbor
    expect(out[4 * n + 4]).toBeGreaterThan(0); // diagonal neighbor
    expect(out[3 * n + 3]).toBeGreaterThan(out[3 * n + 4]); // still crest-peaked
  });

  it('blur alone conserves total foam; decay alone removes it', () => {
    const spread = step(impulse(3, 3), 1, 1);
    expect(total(spread)).toBeCloseTo(1, 10);
    const decayed = step(impulse(3, 3), 1, 0.9);
    // Float32Array rounds texels to f32 exactly like the GPU's rgba32f
    expect(total(decayed)).toBeCloseTo(0.9, 6);
  });

  it('repeated steps flatten toward zero everywhere — foam patches die out', () => {
    let g = impulse(3, 3);
    const decay = decayFactorPerFrame(0.2, DT);
    for (let i = 0; i < 600; i++) g = step(g, 1, decay);
    expect(Math.max(...g)).toBeLessThan(1e-3);
  });

  it('taps wrap across texture edges (foam tiles with its cascade domain)', () => {
    // WHY §V19: the texture repeats across the ocean — a non-wrapping blur
    // would starve the border texels and draw the tile grid onto the sea.
    const out = step(impulse(0, 0), 1, 1);
    expect(out[(n - 1) * n + (n - 1)]).toBeGreaterThan(0); // diagonal wrap
    expect(out[0 * n + (n - 1)]).toBeGreaterThan(0); // horizontal wrap
    expect(total(out)).toBeCloseTo(1, 10); // nothing lost at the seam
  });

  it('blurRadius moves the taps farther out (faster spread, same mass)', () => {
    const out = step(impulse(4, 4), 2, 1);
    expect(out[4 * n + 6]).toBeGreaterThan(0); // 2 texels away
    expect(out[4 * n + 5]).toBe(0); // 1 texel away untouched
    expect(total(out)).toBeCloseTo(1, 10);
  });

  it('output clamps at 1 even where saturated neighborhoods concentrate', () => {
    const g = new Float32Array(n * n).fill(1);
    const out = step(g, 1, 1);
    expect(Math.max(...out)).toBeLessThanOrEqual(1);
  });

  it('wrapIndex maps any offset into [0, n)', () => {
    expect(wrapIndex(-1, n)).toBe(n - 1);
    expect(wrapIndex(n, n)).toBe(0);
    expect(wrapIndex(-n - 2, n)).toBe(n - 2);
  });
});

describe('the blur is ISOTROPIC (§B: the cap-lattice the user photographed 4×)', () => {
  const n = 16;
  const impulse = (x: number, y: number): Float32Array => {
    const g = new Float32Array(n * n);
    g[y * n + x] = 1;
    return g;
  };

  it('one injected fold spreads the SAME distance in every direction', () => {
    // WHY this is the fix and not a regression (user, four frames: "every cap
    // has the same orientation — all the ellipses tilt the same way across the
    // entire frame"). The old kernel stretched its taps 2.6 along a SINGLE
    // GLOBAL crest axis and 0.5 across it; applied ~270× over a cap's life that
    // is a diffusion tensor with a 5.2:1 axis ratio in one world direction, so
    // it did not hint at a shape, it WAS the shape — measured cap axial-angle
    // spread 3.9° over a whole 420 m tile. Cap shape is now the injection's
    // job (λ−), and the injection's shape varies because the sea does.
    const src = impulse(8, 8);
    const at = (x: number, y: number) => blurDecayAt(src, n, x, y, 1, 1);
    expect(at(9, 8)).toBeCloseTo(at(7, 8), 12);
    expect(at(8, 9)).toBeCloseTo(at(8, 7), 12);
    expect(at(9, 8)).toBeCloseTo(at(8, 9), 12);
    // …and the corners match each other too — no preferred diagonal either
    expect(at(9, 9)).toBeCloseTo(at(7, 7), 12);
    expect(at(9, 7)).toBeCloseTo(at(7, 9), 12);
  });

  it('conserves foam EXACTLY — decay owns lifetime alone (§V6)', () => {
    // The property the old global crest frame existed to protect. It is NOT
    // traded away by dropping the frame: an axis-aligned kernel is
    // shift-invariant too, so this still holds exactly, at every radius.
    for (const radius of [1, 2, 3]) {
      const src = impulse(4, 8);
      let sum = 0;
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) sum += blurDecayAt(src, n, x, y, radius, 1);
      expect(sum, `radius=${radius}`).toBeCloseTo(1, 10);
    }
  });
});

describe('the blur budget is a WORLD length (§B: the caps came out round dots)', () => {
  // WHY THIS BLOCK EXISTS, and it is the fifth foam complaint. Moving injection
  // to λ− gave the cap a real shape — measured on the full-resolution spectrum,
  // aspect 3.0–3.3 at 18–59° of axial spread. None of it reached the screen,
  // because an ISOTROPIC diffusion adds the SAME variance to both axes:
  // aspect(n) = √((σa²+nv)/(σb²+nv)) → 1, monotonically, and fast. The blur was
  // ALLOWED to run unbounded because `blurRadius` is in TEXELS, so the world
  // diffusion rate was a property of the grid: cascade 0 spent 12.27 m of σ on
  // a cap whose minor axis is 2.65 m. Three cascades × three texel sizes is
  // also, literally, "circles of a few discrete sizes".
  // read the LIVE domains (§V19): the injected minor axes quoted below were
  // measured at 1010 / 98 / 22.7 m, so a domain change must move these numbers
  // and be re-measured, not silently pass against a stale constant
  const TEXELS = oceanParams.cascades.map((c) => foamTexelMetres(c.domain, oceanParams.resolution));
  const decay = decayFactorPerFrame(foamParams.decayHalfLife, DT);
  const age = meanFoamAgeTicks(decay);
  /** σ of the accumulated diffusion over the visible lifetime, in metres */
  const spreadOf = (texel: number, mixWeight: number) =>
    Math.sqrt(0.5 * foamParams.blurRadius ** 2 * texel * texel * mixWeight * age);

  it('every band diffuses the same DISTANCE, not the same number of texels', () => {
    // The look bug in one assertion: a band's texel size must not decide how
    // far its foam spreads, or the sea carries one disc size per cascade.
    const spreads = TEXELS.map((t) =>
      spreadOf(t, blurMixPerStep(foamParams.blurSpreadMetres, t, foamParams.blurRadius, age)),
    );
    for (const s of spreads) {
      // ≤, not =: a band whose texels are already coarser than the target
      // cannot spread less than one clamped kernel, and must not spread more
      expect(s).toBeLessThanOrEqual(foamParams.blurSpreadMetres * 1.001);
    }
    // the coarse and mid bands both REACH it (only the finest is texel-limited)
    expect(spreads[0]).toBeCloseTo(foamParams.blurSpreadMetres, 6);
    expect(spreads[1]).toBeCloseTo(foamParams.blurSpreadMetres, 6);
    // and the old grid-relative kernel did NOT: 10.3× apart across the bands
    const old = TEXELS.map((t) => spreadOf(t, 1));
    expect(old[0] / old[1]).toBeCloseTo(TEXELS[0] / TEXELS[1], 6);
    expect(old[0]).toBeGreaterThan(10);
  });

  it('never spreads a cap further than the cap is wide', () => {
    // MEASURED injected minor axes (256² mirror of the real IFFT field, full
    // λ− gate): cascade 0 2.65 m at swell / 5.09 m at storm, cascade 1 0.72 /
    // 0.93 m. The blur budget is set at the smallest of them, so the smallest
    // real cap in the sea still survives its own lifetime with most of its
    // aspect. This is the number that must not be raised without re-measuring.
    const SMALLEST_INJECTED_MINOR_AXIS_M = 0.72;
    expect(foamParams.blurSpreadMetres).toBeLessThanOrEqual(SMALLEST_INJECTED_MINOR_AXIS_M);
    // regression: the shipped kernel used to blow that by 17× in cascade 0
    expect(spreadOf(TEXELS[0], 1) / SMALLEST_INJECTED_MINOR_AXIS_M).toBeGreaterThan(15);
  });

  it('an elongated cap is still elongated at the end of its life', () => {
    // THE DECISIVE EXPERIMENT, as a test: inject one cap of the measured shape,
    // run it through a whole visible lifetime of the real kernel, and read the
    // aspect back off its second moments. Under the old kernel a cascade-0 cap
    // comes out a disc; under the budgeted one it keeps most of its shape.
    // If this ever passes with a round result, the caps are round on screen.
    const texel = TEXELS[0];
    const sMin = 2.65 / texel; // measured injected minor axis, in texels
    const sMaj = 8.84 / texel; // …and major
    const aspectAfter = (mixWeight: number) => {
      const v = 0.5 * foamParams.blurRadius ** 2 * mixWeight * age; // texels²
      return Math.sqrt((sMaj * sMaj + v) / (sMin * sMin + v));
    };
    const budgeted = blurMixPerStep(foamParams.blurSpreadMetres, texel, foamParams.blurRadius, age);
    expect(aspectAfter(budgeted)).toBeGreaterThan(2.6); // of 3.34 injected
    expect(aspectAfter(1)).toBeLessThan(1.3); // the shipped disc, measured 1.32
  });

  it('the mixed kernel still conserves foam EXACTLY, at any weight', () => {
    // (1−w)·δ + w·G is a normalised kernel for every w, so the §V6 contract —
    // decayHalfLife is the ONLY thing that removes foam — is kept, not traded.
    // Losing this would make the blur weight a second, invisible lifetime knob.
    const n = 16;
    for (const w of [0, 0.0024, 0.25, 0.5, 1]) {
      const src = new Float32Array(n * n);
      src[5 * n + 9] = 1;
      let sum = 0;
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) sum += blurDecayAt(src, n, x, y, 1, 1, w);
      expect(sum, `w=${w}`).toBeCloseTo(1, 10);
    }
  });

  it('weight 0 is the identity and weight 1 is the old kernel (no third mode)', () => {
    const n = 16;
    const src = new Float32Array(n * n);
    src[8 * n + 8] = 1;
    expect(blurDecayAt(src, n, 8, 8, 1, 1, 0)).toBeCloseTo(1, 12);
    expect(blurDecayAt(src, n, 9, 8, 1, 1, 0)).toBeCloseTo(0, 12);
    for (const [x, y] of [[8, 8], [9, 8], [9, 9]]) {
      expect(blurDecayAt(src, n, x, y, 1, 1, 1)).toBeCloseTo(blurDecayAt(src, n, x, y, 1, 1), 12);
    }
  });

  it('degenerate inputs give a weight in [0,1], never NaN (§V28)', () => {
    for (const [s, t, r, a] of [
      [0.6, 0, 1, 77], [0.6, 1, 0, 77], [0.6, 1, 1, 0], [-1, 1, 1, 77],
      [0.6, 1, 1, Infinity], [NaN, 1, 1, 77], [0.6, 1, 1, -5],
    ]) {
      const w = blurMixPerStep(s, t, r, a);
      expect(Number.isFinite(w), `${s},${t},${r},${a}`).toBe(true);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
    }
    expect(meanFoamAgeTicks(1)).toBe(Infinity);
    expect(meanFoamAgeTicks(0)).toBe(0);
    expect(meanFoamAgeTicks(decay)).toBeCloseTo(decay / (1 - decay), 9);
  });
});

describe('far-field filtering (§V6 sampling: StorageTextures carry no mips)', () => {
  // WHY this whole block exists: the ocean samples the foam RT with texture(),
  // and a storage texture has NO mip chain. At grazing angles one pixel covers
  // thousands of foam texels and receives exactly ONE of them, re-picked every
  // frame — that is the shimmering white horizon band. A distance fade or a
  // compositing cap hides it; a real filtered tier removes it.

  it('reduction takes the MEAN — the far tier must not dim or brighten foam', () => {
    // WHY: a sum, or a kernel that does not sum to 1, would make distant water
    // systematically darker or whiter than near water at the exact distance
    // the tier takes over — a visible seam in the middle of the sea.
    const srcN = 8;
    const flat = new Float32Array(srcN * srcN).fill(0.37);
    // f32 precision: Float32Array rounds exactly like the GPU's rgba32f
    expect(boxReduceAt(flat, srcN, 0, 0, 4)).toBeCloseTo(0.37, 6);
    expect(boxReduceAt(flat, srcN, 1, 1, 4)).toBeCloseTo(0.37, 6);

    // and the mean over the whole field survives the reduction
    const noisy = new Float32Array(srcN * srcN);
    for (let i = 0; i < noisy.length; i++) noisy[i] = (i * 37) % 11 / 10;
    const dstN = srcN / 4;
    let reduced = 0;
    for (let y = 0; y < dstN; y++)
      for (let x = 0; x < dstN; x++) reduced += boxReduceAt(noisy, srcN, x, y, 4);
    const srcMean = noisy.reduce((a, b) => a + b, 0) / noisy.length;
    expect(reduced / (dstN * dstN)).toBeCloseTo(srcMean, 6);
  });

  it('reduction kills the per-texel variance that causes the sizzle', () => {
    // a checkerboard is the worst case: alternate texels 0 and 1, so a
    // point-sampled distant pixel flickers between them. Filtered, it is flat.
    const srcN = 8;
    const checker = new Float32Array(srcN * srcN);
    for (let y = 0; y < srcN; y++)
      for (let x = 0; x < srcN; x++) checker[y * srcN + x] = (x + y) % 2;
    for (let y = 0; y < srcN / 4; y++)
      for (let x = 0; x < srcN / 4; x++)
        expect(boxReduceAt(checker, srcN, x, y, 4)).toBeCloseTo(0.5, 6);
  });

  it('texel size derives from the cascade, not a constant', () => {
    // §V36's lesson applied to a sampling gate: retuning a domain or the sim
    // resolution must re-derive the handover, not silently invalidate it.
    expect(foamTexelMetres(253, 512)).toBeCloseTo(0.494, 3);
    expect(foamTexelMetres(13.7, 512)).toBeCloseTo(0.0268, 4);
    // the fine cascade goes sub-pixel at a footprint 18× smaller — i.e. far
    // closer to the camera — which is the whole reason bands retire in order
    const px = (domain: number) =>
      foamTexelMetres(domain, 512) / foamParams.tierKeepPixels;
    expect(px(253) / px(13.7)).toBeCloseTo(253 / 13.7, 6);
  });

  it('bands retire in order: fine first, coarse last, none abruptly', () => {
    // WHY smoothstep and not a cut: a hard switch-off draws a visible ring on
    // the sea where a whole cascade vanished.
    const w = (domain: number, px: number) =>
      tierWeightAt(px, foamTexelMetres(domain, 512), 2, 2);
    expect(w(13.7, 0.002)).toBe(1); // near: fine band fully resolved
    expect(w(13.7, 0.1)).toBe(0); // far: fine band is sub-pixel noise
    expect(w(253, 0.1)).toBe(1); // coarse band still resolves there
    expect(w(253, 10)).toBe(0);
    // monotone, and strictly between 0 and 1 across the transition
    const mid = w(13.7, 0.02);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(w(13.7, 0.018)).toBeGreaterThan(w(13.7, 0.024));
  });

  it('degenerate fade settings never produce NaN weights (§V28)', () => {
    for (const [px, keep, span] of [
      [1, 2, 3],
      [1, 0, 1],
      [1, 2, 0],
      [0, 0, 0],
    ]) {
      const v = tierWeightAt(px, foamTexelMetres(253, 512), keep, span);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

/* ---------------------------------------------------------------------------
 * §V36 for the jacobian gate. `jacobianFoamBias` is a threshold on the SUMMED
 * three-cascade jacobian; the sim injects per cascade, where σ is 2–3× tighter.
 * Applying the number flat per band turned a 2.5σ event into a 5–8σ one and
 * swell went completely bare. These tests measure the gate against a real
 * spectrum, so they fail if it ever drifts back off its statistic.
 * ------------------------------------------------------------------------ */

/** exact one-point σ of a band's det J, from the spectrum, at choppiness λ */
function measuredJacobianSigma(p: OceanParams, index: number, lambda: number): number {
  const N = p.resolution;
  const domain = p.cascades[index].domain;
  const band = cascadeBand(index, p.splitWavelengths);
  // det J = (1+λa)(1+λb) − (λc)²; to first order its spread is λ·σ(a+b), and
  // the transfer of a+b = ∂Dx/∂x + ∂Dz/∂z onto the height field is exactly |k|
  let variance = 0;
  for (let m = 0; m < N; m++) {
    for (let n = 0; n < N; n++) {
      const kx = (2 * Math.PI * (n - N / 2)) / domain;
      const kz = (2 * Math.PI * (m - N / 2)) / domain;
      const k = Math.hypot(kx, kz);
      if (!(k > band.kMin && k <= band.kMax) || k < 1e-9) continue;
      // waveSpectrum, NOT phillips: the sea carries TWO trains now (wind sea
      // + swell) and this mirror has to measure the same field the ocean
      // generates, or it silently drifts (§V.8 — it read 438× off the moment
      // the swell landed, because `calm` is mostly swell).
      const amp = Math.sqrt(waveSpectrum(kx, kz, p) / 2) / domain;
      variance += 2 * (k * amp) ** 2;
    }
  }
  return lambda * Math.sqrt(variance);
}

function seaFor(name: keyof typeof weatherPresets, over: Partial<OceanParams> = {}) {
  const p: OceanParams = { ...oceanParams, ...weatherPresets[name].ocean, ...over };
  // §V.59: every σ below is measured with the DIRECTION-FREE trace moment.
  // `steep` (the x-projection) is kept only where a test is explicitly about
  // the difference between the two.
  const steep = [0, 1, 2].map((i) =>
    spectralJacobianRms(p.resolution, p.cascades[i].domain, p, cascadeBand(i, p.splitWavelengths)),
  );
  const xProjection = [0, 1, 2].map((i) =>
    spectralSteepness(p.resolution, p.cascades[i].domain, p, cascadeBand(i, p.splitWavelengths)),
  );
  const steepnessRms = Math.sqrt(steep.reduce((s, v) => s + v * v, 0));
  const lambda = effectiveChoppiness(p.choppiness, steepnessRms, p.choppinessFoldLimit);
  return { p, steep, xProjection, steepnessRms, lambda, bias: p.jacobianFoamBias };
}

describe('§V36 jacobian gate: per-cascade bias tracks each band\'s own σ', () => {
  it('the σ constant matches the real spectrum in every band of every preset', () => {
    // WHY a constant at all: `steepnessRms` measures RMS ∂Dx/∂x (transfer
    // kx²/|k|) while det J's spread is driven by ∂Dx/∂x + ∂Dz/∂z (transfer
    // |k|). One ratio converts between them, fixed by the spectrum's
    // DIRECTIONAL SHAPE — so this test is the tripwire on a spread retune:
    // change `directionality`/`oppositeWaveDamp` and the foam gate's σ moves
    // under it, which is precisely how a threshold silently changes meaning.
    for (const name of ['calm', 'swell', 'storm'] as const) {
      const sea = seaFor(name);
      for (let i = 0; i < 3; i++) {
        if (sea.steep[i] < 1e-6) continue; // band carries no energy (calm's swell band)
        const measured = measuredJacobianSigma(sea.p, i, sea.lambda);
        const predicted = jacobianSigma(sea.steep[i], sea.lambda);
        expect(
          predicted / measured,
          `${name} cascade ${i}: jacobianSigma is ${(predicted / measured).toFixed(2)}× the ` +
            'realised σ. If this band is swell-dominated, see "FIRING RIGHT NOW" below — ' +
            'spectralSteepness projects onto x and cannot see a cross-wind swell.',
        ).toBeCloseTo(1, 1);
      }
    }
    // Exactly 1, and that is the point of §V.59: the ocean now publishes the
    // moment this σ is built on (the direction-free Jacobian trace), so there
    // is no conversion constant left to drift. It used to be 1.79 against the
    // x-projection — a number that fitted every band of every preset, which
    // read as reassuring and was in fact the tell.
    expect(JACOBIAN_SIGMA_PER_TRACE).toBe(1);
  });

  it('every band fires at the SAME σ-multiple, which is what the bias means', () => {
    // The whole point: bias 0.55 means "2.5σ of fold" on the summed jacobian,
    // so it must mean 2.5σ in each band too — not 8σ, 5σ and 3σ.
    const sea = seaFor('swell');
    const seaSigma = jacobianSigma(sea.steepnessRms, sea.lambda);
    const zSummed = (1 - sea.bias) / seaSigma;
    for (let i = 0; i < 3; i++) {
      const bandSigma = jacobianSigma(sea.steep[i], sea.lambda);
      const bandBias = cascadeFoamBias(sea.bias, bandSigma, seaSigma);
      expect((1 - bandBias) / bandSigma, `cascade ${i}`).toBeCloseTo(zSummed, 6);
    }
  });

  it('§B regression: the flat bias asked swell for a 5–8σ event, i.e. nothing', () => {
    // This is the bug as the user met it — "no whitecaps at the default sea".
    // Numbers here are the measured ones: at swell the flat 0.55 sat 8.2σ /
    // 4.9σ / 3.1σ below the bands' rest value, ≈0.15 of 262144 texels per
    // frame. Storm's bands are ~3× wider so it cleared them and foam appeared
    // there — which is exactly why this read as "storm-only foam" for months.
    const sea = seaFor('swell');
    const seaSigma = jacobianSigma(sea.steepnessRms, sea.lambda);
    const flatZ: number[] = [];
    const fixedZ: number[] = [];
    for (let i = 0; i < 3; i++) {
      const bandSigma = jacobianSigma(sea.steep[i], sea.lambda);
      flatZ.push((1 - sea.bias) / bandSigma);
      fixedZ.push((1 - cascadeFoamBias(sea.bias, bandSigma, seaSigma)) / bandSigma);
    }
    expect(Math.min(...flatZ)).toBeGreaterThan(3); // even the LOOSEST band
    expect(Math.max(...flatZ)).toBeGreaterThan(7); // and the tightest is hopeless
    for (const z of fixedZ) expect(z).toBeLessThan(2.6);
    // and the fix must not have simply opened the gate everywhere
    for (const z of fixedZ) expect(z).toBeGreaterThan(2.2);
  });

  it('a band with no energy in it is gated OFF, never divided into', () => {
    // A calm with NO GROUND SWELL has nothing in the long band: its det J is
    // identically 1, so it can never fold. Handing it a σ of zero must switch
    // it off, not produce an infinite bias or an infinite injection (§V28).
    //
    // `swellAmplitude: 0` is now load-bearing here and is not a fudge: the
    // shipped `calm` preset deliberately carries a 13 s ground swell (a calm
    // day is not a flat sea — the local wind dropped, the swell from a distant
    // storm did not), so calm's long band is no longer empty. The guard being
    // tested is "a band with no energy", which still needs a sea that has none.
    const sea = seaFor('calm', { swellAmplitude: 0 });
    const seaSigma = jacobianSigma(sea.steepnessRms, sea.lambda);
    const dead = jacobianSigma(sea.steep[0], sea.lambda);
    // it is not exactly zero — it is float dust, 5 orders below the sea's σ,
    // which is worse than zero: a purely relative gate would set its threshold
    // at 0.99996 against a det J of 1 ± 6e-6 and foam half the cascade
    expect(dead / seaSigma).toBeLessThan(1e-4);
    expect(dead).toBeGreaterThan(0);
    expect(cascadeFoamBias(sea.bias, dead, seaSigma)).toBe(NEVER_INJECT_BIAS);
    expect(cascadeInjectPerStep(4, DT, dead, seaSigma)).toBe(0);
    expect(cascadeInjectPerStep(4, DT, 0, seaSigma)).toBe(0);
    // a dead sea (no spectrum at all) gates every band off rather than NaN
    expect(cascadeFoamBias(0.55, 0, 0)).toBe(NEVER_INJECT_BIAS);
  });

  it('never biases a band above the rest value — flat water must stay bare', () => {
    // det J ≈ 1 on undisturbed water. A bias ≥ 1 would foam the entire sea,
    // so a stale or inconsistent moment must not be able to produce one.
    expect(cascadeFoamBias(0.55, 5, 1)).toBeLessThan(1);
    expect(cascadeFoamBias(0.99, 1, 1)).toBeLessThan(1);
  });

  it('injection is σ-relative too: equal folds inject equal foam in any band', () => {
    // The AMOUNT half of the same bug. A raw deficit at a 2.5σ fold is ~0.02
    // in the coarse band and ~0.05 in the fine one, so a single
    // `injectStrength` used to mean 2.5× more foam in one band than another
    // and ~10× more at storm than at swell — the knee downstream then ate the
    // weak end entirely.
    const sea = seaFor('swell');
    const seaSigma = jacobianSigma(sea.steepnessRms, sea.lambda);
    const injected = [0, 1, 2].map((i) => {
      const bandSigma = jacobianSigma(sea.steep[i], sea.lambda);
      const deficit = 0.4 * bandSigma; // the same fold depth, in each band's σ
      return (
        deficit *
        cascadeInjectPerStep(foamParams.injectStrength, DT, bandSigma, seaSigma)
      );
    });
    expect(injected[1]).toBeCloseTo(injected[0], 9);
    expect(injected[2]).toBeCloseTo(injected[0], 9);
    // and a storm band injects the same for the same σ-deep fold
    const storm = seaFor('storm');
    const stormSigma = jacobianSigma(storm.steep[0], storm.lambda);
    const stormSeaSigma = jacobianSigma(storm.steepnessRms, storm.lambda);
    expect(
      0.4 *
        stormSigma *
        cascadeInjectPerStep(foamParams.injectStrength, DT, stormSigma, stormSeaSigma),
    ).toBeCloseTo(injected[0], 9);
  });

  it('storm still foams much more than swell — the sea folds more, not the bar', () => {
    // §V7's promise survives the retune: storm's coverage comes from a
    // genuinely steeper sea, so its bias NUMBER is now lower than swell's
    // while the gate it produces is far easier to clear.
    const swell = seaFor('swell');
    const storm = seaFor('storm');
    const z = (s: ReturnType<typeof seaFor>) =>
      (1 - s.bias) / jacobianSigma(s.steepnessRms, s.lambda);
    expect(z(storm)).toBeLessThan(z(swell) - 1);
    expect(z(seaFor('calm'))).toBeGreaterThan(z(swell));
  });
});

/* ---------------------------------------------------------------------------
 * THE FOLD METRIC (§B, user four times: "the regularity of them"). det J
 * measures AREA compression, which is direction-free — so its super-level sets
 * are round and every cap comes out the same blob, leaving the blur kernel as
 * the only thing that could give a cap a direction, and that kernel had ONE
 * direction for the whole ocean. λ− is Tessendorf's actual folding signal and
 * it fires along the axis the water is folding on, so the shape is the sea's.
 * ------------------------------------------------------------------------ */

/**
 * Statistics of μ = (λ− − 1)/λ on a REALISED cascade — the actual field the
 * inject pass reads, built with the project's own CPU IFFT mirror.
 *
 * A realised field and not a spectral variance, deliberately, and this cost a
 * measurement to learn: the closed-form gaussian model of the same statistic
 * (covariance of ∂Dx/∂x, ∂Dz/∂z, ∂Dx/∂z from the spectrum, μ− of the sampled
 * 2×2) comes out a FLAT 1.36× smaller than the realised field, identically in
 * every band of every preset — and the same 1.36 shows up between the shipped
 * JACOBIAN_SIGMA_PER_TRACE and σ(det J) measured on the realised field
 * (1.79 vs 2.42). Both constants are self-consistent, since the z-score
 * divides one by the other, but neither is the field's true σ. Flagged, not
 * silently corrected: it belongs to `spectralSteepness`, which is the ocean's.
 * What matters here is that these constants are calibrated on the same thing
 * the GPU actually gates.
 */
function realisedEigenMoments(p: OceanParams, index: number, N: number, time: number) {
  const domain = p.cascades[index].domain;
  const band = cascadeBand(index, p.splitWavelengths);
  const lambda = 1; // μ is defined at λ = 1; the gate re-applies the live λ
  const h0 = extractCentralBlock(
    generateH0(p.resolution, domain, 1337 + index * 7919, p, band),
    p.resolution,
    N,
  );
  const size = N * N;
  const a = { re: new Float32Array(size), im: new Float32Array(size) };
  const b = { re: new Float32Array(size), im: new Float32Array(size) };
  for (let m = 0; m < N; m++) {
    for (let n = 0; n < N; n++) {
      const kx = (2 * Math.PI * (n - N / 2)) / domain;
      const kz = (2 * Math.PI * (m - N / 2)) / domain;
      const k = Math.hypot(kx, kz);
      const i = m * N + n;
      const safeK = Math.max(k, 1e-6);
      const phase = Math.sqrt(9.81 * k) * time;
      const c = Math.cos(phase);
      const sn = Math.sin(phase);
      const r0 = h0[i * 4], i0 = h0[i * 4 + 1], r1 = h0[i * 4 + 2], i1 = h0[i * 4 + 3];
      const hRe = (r0 + r1) * c - (i0 + i1) * sn;
      const hIm = (r0 - r1) * sn + (i0 - i1) * c;
      a.re[i] = hRe * (1 - kx / safeK);
      a.im[i] = hIm * (1 - kx / safeK);
      b.re[i] = -hIm * (kz / safeK);
      b.im[i] = hRe * (kz / safeK);
    }
  }
  cpuIFFT2D(a, generateButterfly(N), N);
  cpuIFFT2D(b, generateButterfly(N), N);
  const dx = new Float32Array(size);
  const dz = new Float32Array(size);
  for (let m = 0; m < N; m++) {
    for (let n = 0; n < N; n++) {
      const i = m * N + n;
      const sign = (n + m) & 1 ? -1 : 1;
      dx[i] = sign * a.im[i] * lambda;
      dz[i] = sign * b.re[i] * lambda;
    }
  }
  // central differences, exactly as unpackPass builds the jacobian
  const h = domain / N;
  let sum = 0;
  let sum2 = 0;
  for (let m = 0; m < N; m++) {
    for (let n = 0; n < N; n++) {
      const dDxdx = (dx[m * N + wrapIndex(n + 1, N)] - dx[m * N + wrapIndex(n - 1, N)]) / (2 * h);
      const dDzdz = (dz[wrapIndex(m + 1, N) * N + n] - dz[wrapIndex(m - 1, N) * N + n]) / (2 * h);
      const dDxdz = (dx[wrapIndex(m + 1, N) * N + n] - dx[wrapIndex(m - 1, N) * N + n]) / (2 * h);
      const det = (1 + dDxdx) * (1 + dDzdz) - dDxdz * dDxdz;
      const mu = minEigenvalue(2 + dDxdx + dDzdz, det) - 1;
      sum += mu;
      sum2 += mu * mu;
    }
  }
  const mean = sum / size;
  return { mean, sd: Math.sqrt(Math.max(0, sum2 / size - mean * mean)) };
}

/* ---------------------------------------------------------------------------
 * FIRING RIGHT NOW, ON PURPOSE (§Rule 8). The two `calm cascade 0` assertions
 * below fail against the in-flight second wave train (`swellSpectrum`), and
 * they are correct to.
 *
 * `spectralSteepness` measures RMS ∂Dx/∂x, whose spectral transfer is kx²/|k|
 * — a PROJECTION ONTO THE X AXIS. What actually sets the spread of det J and
 * of λ− is the jacobian TRACE, ∂Dx/∂x + ∂Dz/∂z, whose transfer is
 * (kx²+kz²)/|k| = |k|, which is direction-FREE. The projection is a valid
 * proxy for |k| only while the directional distribution is fixed, which is
 * exactly why one constant (JACOBIAN_SIGMA_PER_TRACE = 1.79, and the λ−
 * pair here) could serve every band of every preset: there was ONE train and
 * it ran with the wind.
 *
 * There are two trains now, and `swellDirection` is decoupled from
 * `windDirection` by design (π·1.68 against π·0.25) with `swellDirectionality`
 * 24 — a narrow beam at ~57° to the x axis, so cos²θ ≈ 0.29 and the proxy sees
 * under a third of the swell's gradient. Measured: `jacobianSigma` under-
 * predicts the realised σ(det J) by 2.65× in calm's cascade 0, and the λ−
 * mean/steepnessRms reads −2.99 against the −1.06 constant — the same factor,
 * because it is the same missing energy. Only calm cascade 0 is exposed today
 * because only there is the band PURE swell; swell and storm still have wind
 * sea dominating that band, which is what makes this the kind of defect that
 * ships.
 *
 * THE FIX IS ONE MOMENT, AND IT IS NOT OURS: the ocean should publish the
 * direction-free |k| moment (RMS of ∂Dx/∂x + ∂Dz/∂z) alongside
 * `steepnessRms`, and FoamSeaMoments should take that instead. It would also
 * dissolve the flat 1.36× gap between the closed-form σ and the realised field
 * recorded above, which is the same projection error measured on one train.
 * Not patched here, and NOT loosened, because a threshold whose σ is wrong is
 * §V36's entire subject and hiding it in a tolerance is how it comes back.
 * ------------------------------------------------------------------------ */

describe('fold metric: minimum eigenvalue, not det J', () => {
  it('det J cannot tell a breaking crest from water piling up flat', () => {
    // THE REASON THE CAPS WERE ROUND AND ALL ONE SIZE. A breaking crest is a
    // UNIAXIAL fold: the surface compresses hard along the propagation axis
    // and stretches across it. Take a = −0.3, b = +0.3, c = 0 —
    //   det J = (1−0.3)(1+0.3) = 0.91, i.e. it has barely moved off 1, because
    //   the compression and the stretch cancel in the product;
    //   λ− = 0.70, first order in the fold, and it points at it.
    const uniaxialDet = 0.7 * 1.3;
    expect(uniaxialDet).toBeCloseTo(0.91, 12);
    expect(minEigenvalue(2, uniaxialDet)).toBeCloseTo(0.7, 12);

    // Now an ISOTROPIC compression that loses the SAME AREA — water gathering
    // with no preferred direction, which is not a breaking crest at all.
    // det J reads it identically (that is the whole problem: area is
    // direction-free), λ− reads it as much weaker.
    const iso = Math.sqrt(uniaxialDet); // a = b = iso − 1, c = 0
    // 6 digits, not 12: near the degenerate point a = b the tr² − 4·det form
    // loses precision to cancellation. Harmless (the answer is ½tr there and
    // the floor keeps it real), but worth knowing it is not exact.
    expect(minEigenvalue(2 * iso, uniaxialDet)).toBeCloseTo(iso, 6);
    expect(minEigenvalue(2 * iso, uniaxialDet)).toBeGreaterThan(
      minEigenvalue(2, uniaxialDet) + 0.25,
    );
    // MEASURED consequence on the real swell spectrum, cascade 1, 300 frames
    // of the real sim: at one and the same σ-multiple det J covered 0.5 % of
    // the tile with caps whose length spread was CV 0.08 and whose axial
    // angles spread 2.1°; λ− covered 9.2 % with CV 0.68 and 21.4°.
  });

  it('is NaN-free on a discriminant that floats one ulp negative (§V28)', () => {
    // tr² − 4·det is ≥ 0 for a real symmetric matrix but not in float32 at
    // the degenerate point a = b, c = 0 — and one NaN in an ACCUMULATOR is
    // permanent, there is no frame that clears it.
    expect(minEigenvalue(2, 1 + 1e-12)).toBeCloseTo(1, 6);
    expect(Number.isNaN(minEigenvalue(2, 1 + 1e-12))).toBe(false);
    expect(Number.isNaN(minEigenvalue(0, 0))).toBe(false);
    // and it really is the MINIMUM: λ− ≤ ½tr always
    for (const [tr, det] of [[2, 0.9], [1.4, 0.2], [3, 2], [0.5, -1]]) {
      expect(minEigenvalue(tr, det)).toBeLessThanOrEqual(tr / 2 + 1e-12);
    }
  });

  it('the λ− constants match the real spectrum in every band of every preset', () => {
    // Same tripwire role as JACOBIAN_SIGMA_PER_TRACE: both the MEAN and
    // the SPREAD of λ− scale with the band's own λ·steepnessRms, fixed by the
    // spectrum's directional shape. Retune `directionality`/`oppositeWaveDamp`
    // and the gate's meaning moves under it (§V36) — that must fail here, not
    // show up months later as "storm has no foam".
    for (const name of ['calm', 'swell', 'storm'] as const) {
      const sea = seaFor(name);
      // cascades 0 and 1 only: cascade 2's band runs to the grid Nyquist, so a
      // reduced mirror would silently drop the modes that dominate its σ
      for (let i = 0; i < 2; i++) {
        const seaSigma = jacobianSigma(sea.steepnessRms, sea.lambda);
        const bandSigma = jacobianSigma(sea.steep[i], sea.lambda);
        // a band that cannot fold is switched off by the same predicate the
        // sim uses, not normalised into relevance — calm's empty 420 m band is
        // float dust and its shape statistics mean nothing
        if (!bandCanFold(bandSigma, seaSigma)) continue;
        const m = realisedEigenMoments(sea.p, i, 128, 7.3);
        // ±15 %: the shape constant is what makes ONE number serve every band
        // of every preset, so the contract is "right to within 15 % everywhere",
        // not "exact somewhere". Outside that the gate's σ has drifted.
        expect(
          Math.abs(m.mean / sea.steep[i] / EIGEN_MEAN_PER_TRACE - 1),
          `${name} cascade ${i} mean/s = ${(m.mean / sea.steep[i]).toFixed(3)}`,
        ).toBeLessThan(0.15);
        expect(
          Math.abs(m.sd / sea.steep[i] / EIGEN_SIGMA_PER_TRACE - 1),
          `${name} cascade ${i} sd/s = ${(m.sd / sea.steep[i]).toFixed(3)}`,
        ).toBeLessThan(0.15);
      }
    }
    // λ− is the MIN of two eigenvalues, so it sits below the rest value even
    // on an undisturbed sea — a gate reasoned as "below 1" would be wrong by
    // more than a σ, which is a decade of coverage.
    expect(EIGEN_MEAN_PER_TRACE).toBeLessThan(0);
  });

  it('rest value is BELOW 1, and the gate is below the rest value', () => {
    const sea = seaFor('swell');
    for (let i = 0; i < 3; i++) {
      const rest = eigenRestValue(sea.steep[i], sea.lambda);
      expect(rest, `cascade ${i}`).toBeLessThan(1);
      const seaSigma = jacobianSigma(sea.steepnessRms, sea.lambda);
      const bandSigma = jacobianSigma(sea.steep[i], sea.lambda);
      const gate = eigenFoamGate(sea.bias, sea.steep[i], sea.lambda, bandSigma, seaSigma);
      expect(gate, `cascade ${i}`).toBeLessThan(rest);
    }
  });

  it('every band fires at the SAME σ-multiple — the bias keeps its meaning', () => {
    // §V36 unchanged by the metric swap: `jacobianFoamBias` is still read as
    // "the sea is folding this many σ below rest" on the SUMMED det J, and
    // every band still has to reproduce that z against its own statistic.
    const sea = seaFor('swell');
    const seaSigma = jacobianSigma(sea.steepnessRms, sea.lambda);
    const z = foamGateZ(sea.bias, seaSigma);
    expect(z).toBeGreaterThan(2.2);
    expect(z).toBeLessThan(2.6);
    for (let i = 0; i < 3; i++) {
      const bandSigma = jacobianSigma(sea.steep[i], sea.lambda);
      const gate = eigenFoamGate(sea.bias, sea.steep[i], sea.lambda, bandSigma, seaSigma);
      const rest = eigenRestValue(sea.steep[i], sea.lambda);
      const sigma = eigenSigma(sea.steep[i], sea.lambda);
      expect((rest - gate) / sigma, `cascade ${i}`).toBeCloseTo(z, 6);
    }
  });

  it('injection is σ-relative: equal folds inject equal foam in any band or sea', () => {
    const sea = seaFor('swell');
    const seaSigma = jacobianSigma(sea.steepnessRms, sea.lambda);
    const inj = (s: ReturnType<typeof seaFor>, i: number) => {
      const bandSigma = jacobianSigma(s.steep[i], s.lambda);
      const ss = jacobianSigma(s.steepnessRms, s.lambda);
      const deficit = 0.4 * eigenSigma(s.steep[i], s.lambda); // same fold, in σ
      return (
        deficit *
        eigenInjectPerStep(foamParams.injectStrength, DT, s.steep[i], s.lambda, bandSigma, ss)
      );
    };
    expect(inj(sea, 1)).toBeCloseTo(inj(sea, 0), 9);
    expect(inj(sea, 2)).toBeCloseTo(inj(sea, 0), 9);
    expect(inj(seaFor('storm'), 0)).toBeCloseTo(inj(sea, 0), 9);
    void seaSigma;
  });

  it('a band with no energy is gated OFF, never divided into (§V28)', () => {
    // swellAmplitude 0 — see the §V36 twin above: shipped `calm` now carries a
    // ground swell in exactly this band, so an empty band has to be asked for.
    const sea = seaFor('calm', { swellAmplitude: 0 });
    const seaSigma = jacobianSigma(sea.steepnessRms, sea.lambda);
    const dead = jacobianSigma(sea.steep[0], sea.lambda);
    expect(eigenFoamGate(sea.bias, sea.steep[0], sea.lambda, dead, seaSigma)).toBe(
      NEVER_INJECT_BIAS,
    );
    expect(eigenInjectPerStep(4, DT, sea.steep[0], sea.lambda, dead, seaSigma)).toBe(0);
    // a sea with no spectrum at all: every band off, no NaN, no Infinity
    expect(eigenFoamGate(0.55, 0, 0, 0, 0)).toBe(NEVER_INJECT_BIAS);
    expect(eigenInjectPerStep(4, DT, 0, 0, 0, 0)).toBe(0);
    expect(Number.isFinite(eigenInjectPerStep(4, DT, 1e-30, 1, 1, 1))).toBe(true);
  });
});

describe('far tier handover (§V48: measured against the SAMPLING RATE)', () => {
  // The chain is 512² → 128², and each tier is retired when ITS OWN texel goes
  // sub-pixel — measured from `fwidth` of the sample coordinate, so the
  // grazing stretch is included. The two things this replaces both failed from
  // the high camera the user photographed: reducing twice more to 32² and
  // cross-fading fine STRAIGHT into it (a 16× jump in texel area where 4× was
  // warranted, i.e. 13 m quads in the glint road), and gating on camera
  // DISTANCE (which left cascade 1 fully weighted at 300 m altitude where one
  // pixel already covered more sea than one texel — a frame full of specks).
  const DOMAIN = 420;
  const N = 512;
  const fineT = foamTexelMetres(DOMAIN, N);
  const coarseT = foamTexelMetres(DOMAIN, N / 4);
  const KEEP = foamParams.tierKeepPixels;
  const SPAN = foamParams.tierFadeSpan;
  const w = (t: number, px: number) => tierWeightAt(px, t, KEEP, SPAN);

  it('the handover step is 4× in texel area, not 16×', () => {
    expect(coarseT / fineT).toBeCloseTo(4, 6);
  });

  it('a tier is gone by the time one pixel covers one of its texels', () => {
    // the Nyquist statement itself: at 1 px per texel the sample is pure
    // aliasing, so the weight must already be zero there, not starting to fall
    expect(w(fineT, fineT)).toBeCloseTo(0, 6);
    expect(w(coarseT, coarseT)).toBeCloseTo(0, 6);
    // and fully present while it still spans the keep width
    expect(w(fineT, fineT / KEEP)).toBeCloseTo(1, 6);
  });

  it('the tier taken over TO is still resolved where the fine tier retires', () => {
    // what the old chain failed: whatever replaces a retiring tier must not
    // itself be past its own Nyquist point, or the handover swaps one
    // aliasing source for a blockier one.
    const fineGone = (fineT / KEEP) * SPAN * 1.01;
    expect(w(fineT, fineGone)).toBeCloseTo(0, 6);
    expect(w(coarseT, fineGone)).toBeCloseTo(1, 6);
  });

  it('§B the high-camera regression: 0.191 m texels at 0.234 m per pixel', () => {
    // the exact frame that was measured in the browser. Cascade 1 (98 m domain)
    // seen from 300 m up: the band MUST be retired here, and the old distance
    // ramp had it at full weight because 300 m is well inside 2300 texel
    // widths (440 m). This is the number the fix exists for.
    const cascade1 = foamTexelMetres(98, 512);
    expect(cascade1).toBeCloseTo(0.191, 3);
    expect(w(cascade1, 0.234)).toBeCloseTo(0, 6);
    // …while the same band close in, where a texel spans several pixels, is
    // untouched — the fix must not simply delete near-field foam detail
    expect(w(cascade1, 0.02)).toBeCloseTo(1, 6);
  });

  it('degenerate settings never produce NaN weights (§V28)', () => {
    for (const [px, t, keep, span] of [
      [1, 0, 2, 2],
      [1, 0.2, 0, 2],
      [1, 0.2, 2, 0],
      [0, 0, 0, 0],
    ]) {
      const v = tierWeightAt(px, t, keep, span);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('§V2: foam decays on the sim clock, not the display clock', () => {
  /** total decay applied over one second of frames at a given display rate */
  const decayOverOneSecond = (fps: number) => {
    let acc = 0;
    let steps = 0;
    for (let f = 0; f < fps; f++) {
      const r = advanceAccumulator(acc, 1 / fps, SIM_DT);
      acc = r.accumulator;
      steps += r.steps;
    }
    return decayFactorPerFrame(foamParams.decayHalfLife, SIM_DT) ** steps;
  };

  it('30, 60 and 144 fps all decay foam at the same rate per SECOND', () => {
    // WHY: foam is an ACCUMULATOR — inject, decay and blur all compound once
    // per dispatch. One dispatch per rendered frame made `decayHalfLife` mean
    // half as long on a 120 Hz machine as on a 60 Hz one, on identical sim
    // input. Stepping on the fixed clock is what makes the tunable honest.
    const at60 = decayOverOneSecond(60);
    for (const fps of [30, 90, 144]) {
      // within one tick's worth of decay (±1 step per second is float dust in
      // the accumulator, not a rate that follows the display). The OLD path
      // was off by the full frame-rate ratio: 0.46 at 60 fps vs 0.21 at 144.
      expect(decayOverOneSecond(fps) / at60).toBeGreaterThan(0.98);
      expect(decayOverOneSecond(fps) / at60).toBeLessThan(1.02);
    }
    // sanity: that number IS the half-life the artist asked for
    expect(at60).toBeCloseTo(2 ** (-1 / foamParams.decayHalfLife), 2);
  });

  it('a slow frame pays its whole debt in steps, not in a bigger step', () => {
    // 4 ticks' worth of stall must run 4 identical SIM_DT steps: scaling one
    // step by dt instead would spread the blur 4× farther in one go.
    expect(advanceAccumulator(0, 4 * SIM_DT, SIM_DT).steps).toBe(4);
  });
});

describe('foam params (§V16: tunables registered, bounded, defaults sane)', () => {
  it('registers under "foam" with the live object', () => {
    const entry = getParamsEntry('foam');
    expect(entry).toBeDefined();
    expect(entry!.params).toBe(foamParams);
  });

  it('every numeric tunable has meta bounds and its default lies inside them', () => {
    // WHY: Tweakpane auto-binds from meta (§V16) and weather presets (§V7)
    // scale within these ranges — an out-of-range default breaks both.
    const entry = getParamsEntry('foam')!;
    for (const [key, value] of Object.entries(foamParams)) {
      expect(typeof value).toBe('number');
      const meta = entry.meta[key];
      expect(meta, `meta for ${key}`).toBeDefined();
      expect(value).toBeGreaterThanOrEqual(meta.min!);
      expect(value).toBeLessThanOrEqual(meta.max!);
    }
  });

  it('decayHalfLife slider cannot reach 0 (instant-kill is code-guarded, not a preset)', () => {
    expect(getParamsEntry('foam')!.meta.decayHalfLife.min).toBeGreaterThan(0);
  });
});

/* ==========================================================================
 * §T.5 stage 3 — THE DISSOLVE. The art texture carves the SILHOUETTE.
 *
 * Every foam pass before this one modulated the INTERIOR of a patch. The
 * outline is what the eye reads, and the outline was a super-level set of an
 * isotropic gaussian blur, which is a circle by construction — so a textured
 * patch was still a disc, which is the standing "blotchy, reads as discs"
 * report. These tests pin the two properties that make swapping the threshold
 * for a per-texel one safe rather than a rewrite.
 * ======================================================================= */

describe('the dissolve gate (§T.5 stage 3, foamShading mirror)', () => {
  const KNEE_LOW = 0.03;
  const KNEE_HIGH = 0.12;

  /** the gate this replaces: a constant threshold on the blurred mask */
  function oldKnee(mask: number): number {
    const t = Math.min(1, Math.max(0, (mask - KNEE_LOW) / (KNEE_HIGH - KNEE_LOW)));
    return t * t * (3 - 2 * t);
  }

  it('erodeDepth 0 reproduces the old gate EXACTLY, at any threshold sample', () => {
    // this is what makes the art texture an A/B rather than a rewrite: with
    // the knob at zero the shader is bit-for-bit the code that shipped, so a
    // difference in the frame is the dissolve and nothing else
    for (let i = 0; i <= 40; i++) {
      const mask = i / 40;
      for (const u of [0, 0.25, 0.5, 0.75, 1]) {
        expect(dissolveKnee(mask, u, KNEE_LOW, KNEE_HIGH, 0, 1)).toBeCloseTo(
          oldKnee(mask),
          12,
        );
      }
    }
  });

  it('tears the SKIRT and leaves the CORE solid — the asymmetry is the point', () => {
    // real foam is dense in the middle and ragged at the edge. An erosion that
    // ate the core would just be a thinner disc, which is the bug, not the fix.
    const d = 0.45;
    const core = 0.9;
    const skirt = 0.2;
    const atCore = [0, 0.5, 1].map((u) => dissolveKnee(core, u, KNEE_LOW, KNEE_HIGH, d, 1));
    // above the deepest threshold the mask survives whatever the texture says
    expect(Math.min(...atCore)).toBeGreaterThan(0.999);
    // in the skirt the SAME mask value is present or absent depending on the
    // texture — that is a torn boundary rather than a soft ring
    const atSkirt = [0, 0.5, 1].map((u) => dissolveKnee(skirt, u, KNEE_LOW, KNEE_HIGH, d, 1));
    expect(atSkirt[0]).toBeGreaterThan(0.99);
    expect(atSkirt[2]).toBeLessThan(0.01);
  });

  it('never removes foam the old gate kept, at the same mask value', () => {
    // a dissolve may only CUT INTO the skirt; if it could brighten, coverage
    // would rise with erodeDepth and the knob would be doing two things
    for (let i = 0; i <= 40; i++) {
      const mask = i / 40;
      for (const u of [0, 0.3, 0.7, 1]) {
        expect(dissolveKnee(mask, u, KNEE_LOW, KNEE_HIGH, 0.45, 1)).toBeLessThanOrEqual(
          oldKnee(mask) + 1e-12,
        );
      }
    }
  });

  it('§V.48b: the sub-pixel limit is the average of the GATE, not of the field', () => {
    // A uniform threshold on [0,d] passes a texel of mask m with probability
    // m/d, so a pixel that no longer resolves the field should see a RAMP OF
    // WIDTH d. Fading the FIELD to its own mean (0.5, exactly, by
    // construction) instead leaves the same narrow step at a shifted
    // threshold — a fade to a hard edge, which is the mistake §V.48(b) names.
    const d = 0.45;
    const samples = 400;
    /** the true pixel average at full resolution */
    const truth = (m: number) => {
      let sum = 0;
      for (let k = 0; k < samples; k++) {
        sum += dissolveKnee(m, (k + 0.5) / samples, KNEE_LOW, KNEE_HIGH, d, 1);
      }
      return sum / samples;
    };
    /** what this code does once the field is sub-pixel */
    const ours = (m: number) => dissolveKnee(m, 0.5, KNEE_LOW, KNEE_HIGH, d, 0);
    /** the naive alternative: fade the FIELD to its mean, keep the narrow step */
    const naive = (m: number) => dissolveKnee(m, 0.5, KNEE_LOW, KNEE_HIGH, d, 1);

    let ourWorst = 0;
    let naiveWorst = 0;
    for (let i = 0; i <= 200; i++) {
      const m = i / 200;
      ourWorst = Math.max(ourWorst, Math.abs(ours(m) - truth(m)));
      naiveWorst = Math.max(naiveWorst, Math.abs(naive(m) - truth(m)));
    }
    // exact at both ends and over the whole support; the residual is the
    // cubic ease against a box-convolved ramp — measured 0.045 of alpha
    expect(ourWorst).toBeLessThan(0.06);
    // and the alternative is out by 0.403, in the middle of the ramp where
    // all of the coverage is
    expect(naiveWorst).toBeGreaterThan(0.35);
    expect(naiveWorst).toBeGreaterThan(ourWorst * 5);
  });

  it('§B the body composite does not move COVERAGE — over the real texture', () => {
    // THE BODY IS A MULTIPLY ON THE FOAM ALPHA, so its mean over the art
    // texture IS foam coverage. Two of this pass's changes would each have
    // moved it silently: handing a saturated raft to the SOFT tap (mean 0.760)
    // instead of the CREST tap (mean 0.430) is worth up to +0.21 of body —
    // +50% foam alpha in fresh saturated foam — and keeping structure through
    // the flatten adds a term whose mean is only zero if it is centred on the
    // right number. Both are re-centred in `foamBodyLevel`; this integrates it
    // over every texel of the REAL generated texture and compares against the
    // level the un-broadened, un-flattened-with-keep composite had.
    const N = 128;
    const data = buildFoamPattern(N);
    const crestCh = new Float64Array(N * N);
    const softCh = new Float64Array(N * N);
    for (let i = 0; i < N * N; i++) {
      crestCh[i] = data[i * 4 + FOAM_CHANNEL.crest] / 255;
      softCh[i] = data[i * 4 + FOAM_CHANNEL.soft] / 255;
    }
    const cM = FOAM_CREST_MEAN;
    const sM = FOAM_SOFT_MEAN;
    for (const freshness of [0, 0.35, 0.7, 1]) {
      for (const sheetN of [0, 0.5, 1]) {
        // what the body was BEFORE this pass: plain mix at `freshness`,
        // flattened toward 1 with no structure kept
        const flat = sheetN * 0.5;
        let before = 0;
        let after = 0;
        for (let i = 0; i < N * N; i++) {
          const plain = softCh[i] + (crestCh[i] - softCh[i]) * freshness;
          before += plain + (1 - plain) * flat;
          // the shipped form, at the worst-case broadening (sheetBroaden 0.35)
          // and the shipped sheetKeep
          const bodyBlend = freshness * (1 - sheetN * 0.65);
          after += foamBodyLevel(
            softCh[i], crestCh[i], freshness, bodyBlend, flat, 0.55, cM, sM,
          );
        }
        before /= N * N;
        after /= N * N;
        expect(
          Math.abs(after - before),
          `freshness ${freshness} sheetN ${sheetN}: body ${after.toFixed(4)} vs ${before.toFixed(4)}`,
        ).toBeLessThan(0.005);
      }
    }
  });

  it('§B and it is not a no-op: the PATTERN changes where the level does not', () => {
    // Coverage-neutral is worthless if nothing moved. At full saturation the
    // body must be drawing the BROAD channel's structure — measured as the
    // correlation of the composite with each tap — while keeping the fresh
    // level. Without this the re-centring could be satisfied by simply not
    // broadening at all.
    const N = 128;
    const data = buildFoamPattern(N);
    const cM = FOAM_CREST_MEAN;
    const sM = FOAM_SOFT_MEAN;
    const corr = (a: Float64Array, b: Float64Array): number => {
      let ma = 0, mb = 0;
      for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; }
      ma /= a.length; mb /= b.length;
      let num = 0, da = 0, db = 0;
      for (let i = 0; i < a.length; i++) {
        num += (a[i] - ma) * (b[i] - mb);
        da += (a[i] - ma) ** 2;
        db += (b[i] - mb) ** 2;
      }
      return num / Math.sqrt(da * db);
    };
    const crestCh = new Float64Array(N * N);
    const softCh = new Float64Array(N * N);
    for (let i = 0; i < N * N; i++) {
      crestCh[i] = data[i * 4 + FOAM_CHANNEL.crest] / 255;
      softCh[i] = data[i * 4 + FOAM_CHANNEL.soft] / 255;
    }
    /** fresh foam, at saturation `s`, at the shipped sheetBroaden 0.35 */
    const bodyAt = (s: number): Float64Array => {
      const out = new Float64Array(N * N);
      for (let i = 0; i < N * N; i++) {
        out[i] = foamBodyLevel(
          softCh[i], crestCh[i], 1, 1 * (1 - s * 0.65), s * 0.5, 0.55, cM, sM,
        );
      }
      return out;
    };
    const unsaturated = bodyAt(0);
    const saturated = bodyAt(1);
    // Saturating must move the composite AWAY from the fine lace and TOWARD
    // the broad mottle. It does not have to be soft-DOMINATED and the bar is
    // deliberately not written that way: the crest channel carries several
    // times the variance of the soft one (lace against a smooth slick), so a
    // 35% crest weight still leads the correlation. What "broader" means here
    // is the SHARE, and the share is what this measures.
    expect(corr(saturated, crestCh)).toBeLessThan(corr(unsaturated, crestCh) - 0.1);
    expect(corr(saturated, softCh)).toBeGreaterThan(corr(unsaturated, softCh) + 0.2);
  });

  it('§B the REJECTED carve: a symmetric threshold shift is NOT coverage-neutral', () => {
    // Kept as a test rather than as a sentence, because the rejected form is
    // the one anyone would write next and its defect is invisible to the
    // argument that motivates it. Shifting the dissolve field by ±a preserves
    // the FIELD's mean exactly (E[clamp(U+a)] + E[clamp(U−a)] = 1 for uniform
    // U) — but coverage is E[gate(field)], the gate lives in the bottom of the
    // range, and the clamp at zero is a one-sided atom there. Coverage is
    // therefore CONVEX in the shift and Jensen makes every symmetric carve
    // gain. This pins the size of that gain so the shipped displacement form
    // (foamMath.waveCarveOffset) cannot be "simplified" back into it.
    const KNEE_LOW = 0.005;
    const KNEE_HIGH = 0.03;
    const D = 0.22;
    const shiftedCover = (mask: number, lift: number, carve: number): number => {
      let sum = 0;
      for (let k = 0; k < 400; k++) {
        const u = (k + 0.5) / 400;
        const shifted = Math.min(1, Math.max(0, u + lift * carve));
        sum += dissolveKnee(mask, shifted, KNEE_LOW, KNEE_HIGH, D, 1);
      }
      return sum / 400;
    };
    const mask = 0.02;
    const flat = shiftedCover(mask, 0, 0);
    let carved = 0;
    let n = 0;
    for (let i = -20; i <= 20; i++, n++) carved += shiftedCover(mask, i / 10, 0.15);
    carved /= n;
    // measured 0.0589 against 0.0172 — 3.4× the residue skirt, silently
    expect(carved).toBeGreaterThan(flat * 3);
  });

  it('§B the shipped carve is a REARRANGEMENT, so coverage cannot move', () => {
    // `waveCarveOffset` returns a UV displacement, and displacing a lookup is
    // measure-preserving: the multiset of threshold values a patch sees is
    // unchanged, so the coverage integral is unchanged at EVERY mask and every
    // parameter — exactly, not on average. The mechanical statement of that
    // here is that the offset never touches the field's values at all, and
    // that it is bounded so it can never drag the lookup a whole repeat (which
    // would be a rearrangement too, but a visible one).
    for (const carveAmt of [0, 0.35, 1]) {
      for (const lift of [-9, -2, -1, 0, 1, 2, 9]) {
        const off = waveCarveOffset(lift, carveAmt);
        expect(Number.isFinite(off)).toBe(true);
        expect(Math.abs(off)).toBeLessThanOrEqual(2 * carveAmt + 1e-9);
      }
    }
    // it is antisymmetric in the lift, so a symmetric sea displaces the lookup
    // by zero on average — no net drift of the pattern with sea state
    for (const l of [0.3, 1, 1.7, 5]) {
      expect(waveCarveOffset(l, 0.35) + waveCarveOffset(-l, 0.35)).toBeCloseTo(0, 12);
    }
    // and it is monotone, so "higher water" always means "further along the
    // texture" — a non-monotone carve would fold the lookup and pinch
    let prev = -Infinity;
    for (let i = -30; i <= 30; i++) {
      const v = waveCarveOffset(i / 10, 0.35);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('carveOffset is finite for degenerate inputs (§V28)', () => {
    for (const v of [
      waveCarveOffset(NaN, 0.3),
      waveCarveOffset(Infinity, 0.3),
      waveCarveOffset(1, NaN),
      waveCarveOffset(1, -5),
      waveCarveOffset(-1e300, 1),
    ]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('§V.60: the gate is never narrower than the body it multiplies', () => {
    // the authored knee width is a FLOOR on the transition, so no combination
    // of erosion, retirement or footprint can re-impose a hard edge after
    // every softening stage upstream — that is §B/§V.60's exact shape
    for (const resolved of [0, 0.5, 1]) {
      for (const fw of [0, 0.01, 0.2]) {
        const lo = 0.03;
        const hi = 0.12;
        const below = dissolveKnee(lo, 0.5, lo, hi, 0.45, resolved, fw);
        const above = dissolveKnee(hi, 0.5, lo, hi, 0.45, resolved, fw);
        // a transition at least as wide as (hi − lo) cannot be saturated at
        // both ends of that interval
        expect(above - below).toBeLessThan(1 - 1e-9);
      }
    }
  });

  it('is finite and in [0,1] for degenerate inputs (§V28)', () => {
    const bad = [
      dissolveKnee(0.5, 5, 0.03, 0.12, 9, 9),
      dissolveKnee(0.5, -3, 0.03, 0.12, -1, -1),
      dissolveKnee(0.5, 0.5, 0.12, 0.12, 0, 1),
      dissolveKnee(0, 0, 0, 0, 0, 0, 0),
    ];
    for (const v of bad) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

/* ---------------------------------------------------------------------------
 * WHERE THE FOAM IS, NOT HOW MUCH OF IT (§B, user: "we don't see a bias
 * towards the higher and steeper cresting having the foam and the splash,
 * while the troughs have less of it").
 *
 * THE STATISTIC IS MASS SHARE, AND THAT IS THE POINT OF THIS BLOCK. The
 * obvious measure — Pearson r between the foam field and elevation — CANNOT
 * express this complaint: foam is sparse and spiky, elevation is smooth and
 * gaussian, and r between them has a CEILING of 0.18 on the shipped sea. That
 * ceiling is what hid the defect for so long: the shipped build measured 0.127,
 * i.e. 71% of the achievable maximum, which reads as fine. The share of foam
 * MASS sitting in the top 30% of the sea by elevation was 45.4% against an
 * injection that put 82.2% there, and that gap is the whole bug.
 *
 * The sea below is ONE travelling deep-water wave rather than the full three
 * cascade IFFT, deliberately: with a single mode the crest position is known
 * in closed form at every tick, so a share below the floor can only mean the
 * foam is not on the crest. It also runs in milliseconds instead of the ~40 s
 * the full field costs. For that field, λ− collapses exactly —
 *   ∂Dx/∂x = −k·h, ∂Dz/∂z = ∂Dx/∂z = 0
 *   ⟹ tr J = 2 − λkh, det J = 1 − λkh, λ− = 1 − max(0, λkh)
 * — so the gate is a pure crest gate and the ONLY thing that can put foam in a
 * trough is the accumulator carrying it there while the wave moves on.
 * ------------------------------------------------------------------------ */

/** share of `field` mass sitting in the top `frac` of the sea ranked by `by` */
function topMassShare(by: Float32Array, field: Float32Array, frac: number): number {
  const idx = Array.from({ length: by.length }, (_, i) => i);
  idx.sort((a, b) => by[a] - by[b]);
  const cut = Math.floor(idx.length * (1 - frac));
  let all = 0;
  let top = 0;
  for (let i = 0; i < idx.length; i++) {
    all += field[idx[i]];
    if (i >= cut) top += field[idx[i]];
  }
  return all > 0 ? top / all : NaN;
}

/**
 * One travelling wave through the REAL foam accumulator (foamMath mirrors of
 * the inject + blurDecay passes), returning where the resulting mask sits.
 */
function travellingWaveFoam(opts: {
  residueHalfLife: number;
  breakingHalfLife: number;
  residueWeight: number;
  breakingWeight: number;
}) {
  const n = 64;
  const domain = 100; // exactly one wavelength across the tile
  const k = (2 * Math.PI) / domain;
  const omega = Math.sqrt(9.81 * k); // deep-water dispersion → c = 12.5 m/s
  const amp = 1.5;
  const lambda = 0.95; // the shipped effective choppiness
  const ticks = 240; // 4 s — several residue half-lives, so this is steady state

  const decay = decayFactorPerFrame(opts.residueHalfLife, DT);
  // the sim floors it at the residue's own decay; mirror that here
  const bDecay = Math.min(decay, decayFactorPerFrame(opts.breakingHalfLife, DT));
  const blurMix = blurMixPerStep(
    foamParams.blurSpreadMetres,
    domain / n,
    foamParams.blurRadius,
    meanFoamAgeTicks(decay),
  );

  const size = n * n;
  const residue = new Float32Array(size);
  const breaking = new Float32Array(size);
  const rs = new Float32Array(size);
  const bs = new Float32Array(size);
  const h = new Float32Array(size);
  // fires on the upper half of the crest; injection scaled so a fully broken
  // texel gains ~injectStrength·dt per tick, as the σ-relative sim scale does
  const peak = lambda * k * amp;
  const gate = 1 - 0.5 * peak;
  const perStep = (foamParams.injectStrength * DT) / peak;

  for (let t = 0; t < ticks; t++) {
    const time = t * DT;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        h[i] = amp * Math.cos(k * ((x / n) * domain) - omega * time);
        const u = lambda * k * h[i];
        const inj = Math.max(0, gate - minEigenvalue(2 - u, 1 - u)) * perStep;
        rs[i] = accumulateFoam(residue[i], inj);
        bs[i] = accumulateFoam(breaking[i], inj);
      }
    }
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        residue[y * n + x] = blurDecayAt(rs, n, x, y, foamParams.blurRadius, decay, blurMix);
        breaking[y * n + x] = blurDecayAt(bs, n, x, y, foamParams.blurRadius, bDecay, blurMix);
      }
    }
  }

  const gain = breakingGain(decay, bDecay);
  const mask = new Float32Array(size);
  let mass = 0;
  for (let i = 0; i < size; i++) {
    mask[i] = foamMaskFrom(
      residue[i], breaking[i], gain, opts.residueWeight, opts.breakingWeight,
    );
    mass += mask[i];
  }
  return { share: topMassShare(h, mask, 0.3), mass: mass / size, mask, residue, breaking };
}

describe('§B two clocks: foam belongs to the crest that made it', () => {
  it('the single-clock mask loses the crest it was injected on', () => {
    // WHY THIS MUST FAIL LOUD IF IT EVER GETS "FIXED" BACK: the injection here
    // is a PURE crest gate — λ− = 1 − max(0, λkh) fires only where h > 0 — so
    // 100% of everything injected lands in the top half of the wave, and by
    // construction well inside the top 30%. Anything the mask holds below that
    // arrived because the accumulator kept it while the wave travelled on
    // (12.5 m/s here, 16 m over the 1.29 s mean visible age at the shipped
    // half-life, a sixth of a wavelength). This is the defect, measured.
    const single = travellingWaveFoam({
      residueHalfLife: 0.9,
      breakingHalfLife: 0.15,
      residueWeight: 1,
      breakingWeight: 0, // = the pre-split mask, exactly
    });
    // measured 0.609 — a pure crest gate would put ~1.0 here
    expect(single.share).toBeLessThan(0.65);
  });

  it('the breaking channel puts it back on the crest, at the same foam cost', () => {
    // WHY: the breaking channel is the SAME injection on a ~6x shorter clock,
    // so it cannot integrate long enough to drift off the crest that made it.
    // The residue is not deleted — real seas do leave foam behind a breaker,
    // and deleting it is the variance §V.64 forbids throwing away — it is
    // weighted down to what it is: older, thinner foam.
    const single = travellingWaveFoam({
      residueHalfLife: 0.9, breakingHalfLife: 0.15, residueWeight: 1, breakingWeight: 0,
    });
    const split = travellingWaveFoam({
      residueHalfLife: foamParams.decayHalfLife,
      breakingHalfLife: foamParams.breakingHalfLife,
      residueWeight: foamParams.residueWeight,
      breakingWeight: foamParams.breakingWeight,
    });
    // the whole complaint, as a number
    expect(split.share).toBeGreaterThan(0.75); // measured 0.791
    expect(split.share).toBeGreaterThan(single.share + 0.15); // measured +0.182
    // AND IT IS A REDISTRIBUTION, NOT A DELETION. If the shipped weights
    // simply removed most of the foam, the share would rise for a reason that
    // has nothing to do with placement and the sea would go bald — so the mask
    // has to keep most of its mass. (Measured on the full three-cascade field:
    // 81% of the shipped total, with `injectStrength` the knob that buys it
    // back; the tolerance here is looser because one mode is not that sea.)
    expect(split.mass).toBeGreaterThan(single.mass * 0.5); // measured 0.94x
  });

  it('breakingWeight 0 + residueWeight 1 is the old mask BIT FOR BIT', () => {
    // WHY: every foam change in this project ships behind an exact A/B
    // (`erodeDepth = 0` for the dissolve, `injectFineCascade` for the fine
    // band). Without it "the fix did nothing" and "the fix is off" are
    // indistinguishable from a screenshot, which is how §V16's knee once
    // silently cancelled a whole injection rework.
    const split = travellingWaveFoam({
      residueHalfLife: 0.9, breakingHalfLife: 0.15, residueWeight: 1, breakingWeight: 0,
    });
    for (let i = 0; i < split.mask.length; i++) {
      expect(split.mask[i]).toBe(Math.min(1, split.residue[i]));
    }
  });

  it('a longer residue clock makes placement WORSE, not better (§T.41 is backwards)', () => {
    // WHY THIS TEST EXISTS AT ALL: "raise decayHalfLife so foam can trail down
    // the wave face" was carried as a GOAL, and it is the wrong sign for this
    // complaint. Long-lived foam and crest-correlated foam are incompatible
    // for a field that does not move, and the field must not move — it is
    // indexed by the undisplaced grid coordinate, which is a Lagrangian
    // material label, so it is already advected with the water exactly
    // (foamMath, "WHY THERE IS NO ADVECTION PASS"). Anyone reaching for the
    // half-life to buy trailing has to fail here first.
    const short = travellingWaveFoam({
      residueHalfLife: 0.3, breakingHalfLife: 0.15, residueWeight: 1, breakingWeight: 0,
    });
    const long = travellingWaveFoam({
      residueHalfLife: 2.0, breakingHalfLife: 0.15, residueWeight: 1, breakingWeight: 0,
    });
    expect(long.share).toBeLessThan(short.share);
  });
});

describe('§B the two-channel mix keeps its meaning when the clocks move', () => {
  it('breakingGain equalises the two channels under a constant injection', () => {
    // WHY: `breakingWeight` has to be a MIX FACTOR, not a multiplier that
    // silently means something different at every half-life — the §B.12 /
    // §V36 failure (a constant calibrated against one statistic, applied to
    // another) applied to a channel mix. Under constant injection I the
    // residue settles at I/(1−decay) and the breaking channel at
    // I/(1−breakingDecay); the gain is exactly what makes those equal.
    for (const [rHalf, bHalf] of [[0.9, 0.15], [0.4, 0.1], [2.0, 0.05]]) {
      const d = decayFactorPerFrame(rHalf, DT);
      const b = decayFactorPerFrame(bHalf, DT);
      let residue = 0;
      let breaking = 0;
      const I = 0.001;
      for (let t = 0; t < 4000; t++) {
        residue = (residue + I) * d;
        breaking = (breaking + I) * b;
      }
      expect(breaking * breakingGain(d, b)).toBeCloseTo(residue, 6);
    }
  });

  it('foam that never decays cannot define a gain, and says so instead of Infinity', () => {
    // decay = 1 is an unbounded accumulator: the ratio is meaningless and the
    // naive form divides by zero, which would put Infinity into a mask that
    // feeds a mix factor (§V28 — one Infinity there is permanent).
    expect(breakingGain(1, 0.9)).toBe(0);
    expect(Number.isFinite(breakingGain(0.99, 0.5))).toBe(true);
    expect(breakingGain(Number.NaN, 0.5)).toBe(0);
    // and a breaking channel that holds nothing is the DIVISOR here
    expect(breakingGain(0.99, 0)).toBe(0);
  });

  it('the crest bias is a multiple of σ on BOTH sides, so weather cannot move it', () => {
    // WHY (§V36, and §B.12 four times over): an absolute "bias per metre"
    // would mean something different in calm and storm — the same crest bias
    // that nudges a swell sea would obliterate a calm one, because σ(λ−) and
    // σ(h) both scale with the sea. Stated as σ(λ−) per σ(h), a crest at 1σ of
    // elevation always shifts λ− by exactly `crestBiasSigma` of its own σ.
    for (const [trace, choppiness, heightRms] of [
      [0.0513, 0.95, 0.87], [0.165, 0.95, 2.4], [0.02, 0.7, 0.3],
    ]) {
      const perMetre = crestBiasPerMetre(0.5, trace, choppiness, heightRms);
      // the shift a 1σ crest produces, in units of this band's own σ(λ−)
      const shiftInSigma = (perMetre * heightRms) / eigenSigma(trace, choppiness);
      expect(shiftInSigma).toBeCloseTo(0.5, 10);
    }
  });

  it('a sea with no height statistic yet biases nothing rather than dividing by zero', () => {
    // before the first spectrum build heightRms is 0 — §V28: the gate must go
    // quiet, not produce Infinity and foam the entire flat sea
    expect(crestBiasPerMetre(0.5, 0.05, 0.95, 0)).toBe(0);
    expect(crestBiasPerMetre(0.5, 0.05, 0.95, Number.NaN)).toBe(0);
    expect(crestBiasPerMetre(0.5, 0, 0.95, 1)).toBe(0);
    expect(crestBiasPerMetre(0, 0.05, 0.95, 1)).toBe(0);
  });
});

/* ---------------------------------------------------------------------------
 * A CAP IS THE SIZE OF THE BAND THAT MADE IT (§B, user: "we are still very
 * patchy on the foam cresting, we are still huge blobs", with a top-down frame
 * showing patches 1.5–2× the 35 m hull).
 *
 * MEASURED on the realised field: the connected components of {λ− < gate} run
 * 21.7 m median and 70.5 m max in cascade 0, against 2.8 m in cascade 1 and
 * 0.2 m in cascade 2. Nothing downstream grows them — the accumulator, the
 * blur, `capVariation` and the dissolve were each ruled out by probe. A
 * super-level set of a band-limited field HAS that band's scale, and cascade 0
 * holds 40 m waves and longer.
 *
 * The fixture below is that geometry and nothing else: a smooth field built
 * only from 40–160 m components (cascade 0's band), thresholded to give the
 * same kind of tens-of-metres regions. No IFFT, no accumulator — if the
 * breakup fragments THIS, it fragments the real thing, and the test runs in
 * milliseconds rather than the ~40 s the full field costs.
 *
 * THE STATISTIC. The >35 m AREA SHARE is what the complaint is about, but it
 * is carried by a handful of giant components and was measured swinging
 * 23–43% between time samples of the SAME build — so the assertions below lead
 * with the MAX and p90 extent, which are stable, and check the area share with
 * the tolerance its variance deserves. Pinning a noisy statistic tightly is how
 * a test becomes a thing people delete.
 * ------------------------------------------------------------------------ */

/** 4-connected components of a boolean grid; extents in world metres */
function capExtents(on: Uint8Array, n: number, cellM: number) {
  const seen = new Uint8Array(n * n);
  const out: { area: number; major: number }[] = [];
  const stack: number[] = [];
  for (let s = 0; s < n * n; s++) {
    if (!on[s] || seen[s]) continue;
    stack.length = 0;
    stack.push(s);
    seen[s] = 1;
    const xs: number[] = [];
    const ys: number[] = [];
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % n;
      const y = (i / n) | 0;
      xs.push(x);
      ys.push(y);
      const nb = [
        x > 0 ? i - 1 : -1, x < n - 1 ? i + 1 : -1,
        y > 0 ? i - n : -1, y < n - 1 ? i + n : -1,
      ];
      for (const j of nb) if (j >= 0 && on[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
    }
    let mx = 0;
    let my = 0;
    for (let i = 0; i < xs.length; i++) { mx += xs[i]; my += ys[i]; }
    mx /= xs.length;
    my /= ys.length;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (let i = 0; i < xs.length; i++) {
      const dx = xs[i] - mx;
      const dy = ys[i] - my;
      sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    }
    sxx /= xs.length; syy /= xs.length; sxy /= xs.length;
    const tr = sxx + syy;
    const root = Math.sqrt(Math.max(0, (tr * tr) / 4 - (sxx * syy - sxy * sxy)));
    // 4σ of the principal axis ≈ the length the eye reads
    out.push({ area: xs.length * cellM * cellM, major: 4 * Math.sqrt(tr / 2 + root) * cellM });
  }
  return out;
}

/**
 * Cascade 0's geometry, running THE REAL METRIC.
 *
 * Not a smooth proxy field: λ− is built from the same displacement gradients
 * the inject pass reads, over a synthetic 32-mode spectrum spanning cascade 0's
 * band. That matters — a smooth sum of cosines has smooth, ellipse-like
 * super-level sets that resist fragmentation, while λ− carries the anisotropy
 * magnitude ½√((a−b)²+4c²), which is rough. Testing the breakup against the
 * smooth proxy understated it by more than half.
 *
 * Equal SLOPE per mode (amplitude ∝ 1/k), which is what the ocean's own
 * anti-lattice work settled on for the same reason: it stops the finest
 * component also being the loudest.
 */
const regionCache = new Map<number, ReturnType<typeof computeRegions>>();
function breakingRegions(breakupSigma: number) {
  const hit = regionCache.get(breakupSigma);
  if (hit) return hit;
  const v = computeRegions(breakupSigma);
  regionCache.set(breakupSigma, v);
  return v;
}

function computeRegions(breakupSigma: number) {
  const N = 384;
  const WIN = 900; // m — several of the longest components across
  const cell = WIN / N;
  const texel = 1.97; // cascade 0's shipped texel
  const octaves = breakupOctaves(foamParams.breakupMetres, texel);
  const freq = 1 / foamParams.breakupMetres;
  const CHOP = 0.95;
  const MODES = 32;
  const SLOPE = 0.03;
  const waves = Array.from({ length: MODES }, (_, i) => {
    // 40 m to 400 m: cascade 0's band starts at 40 m by the split and runs to
    // the domain, and it is the LONG end that makes the regions big
    const lambda = 40 * 10 ** (i / (MODES - 1));
    const k = (2 * Math.PI) / lambda;
    const th = i * Math.PI * (3 - Math.sqrt(5));
    return { k, cx: Math.cos(th), cz: Math.sin(th), ph: i * 1.7, amp: SLOPE / k };
  });

  const metric = new Float32Array(N * N);
  let mean = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const wx = x * cell;
      const wz = y * cell;
      let dxx = 0;
      let dzz = 0;
      let dxz = 0;
      for (const w of waves) {
        // ∂Dx/∂x = −a·k·cx²·cos, ∂Dz/∂z = −a·k·cz²·cos, ∂Dx/∂z = −a·k·cx·cz·cos
        const c = Math.cos(w.k * (wx * w.cx + wz * w.cz) + w.ph) * w.amp * w.k;
        dxx -= c * w.cx * w.cx;
        dzz -= c * w.cz * w.cz;
        dxz -= c * w.cx * w.cz;
      }
      const a = CHOP * dxx;
      const b = CHOP * dzz;
      const cc = CHOP * dxz;
      const v = minEigenvalue(2 + a + b, (1 + a) * (1 + b) - cc * cc);
      metric[y * N + x] = v;
      mean += v;
    }
  }
  mean /= N * N;
  let varr = 0;
  for (let i = 0; i < N * N; i++) varr += (metric[i] - mean) ** 2;
  const sd = Math.sqrt(varr / (N * N));
  // fire BELOW the gate, as the inject pass does — against the METRIC's own
  // spread, which the zero-mean jitter widens (foamMath.metricSigmaScale).
  // Without that correction the same gate fired 2.8× the area and the "fix"
  // would have read as "more foam", not "smaller caps".
  const gate = mean - 2.4 * sd * metricSigmaScale(0, breakupSigma, octaves);
  const on = new Uint8Array(N * N);
  let fired = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const jitter = breakupSigma
        ? breakupJitter(x * cell, y * cell, freq, foamParams.breakupWarp, octaves) * breakupSigma * sd
        : 0;
      on[i] = metric[i] + jitter < gate ? 1 : 0;
      fired += on[i];
    }
  }
  const comps = capExtents(on, N, cell).filter((c) => c.area > 2 * cell * cell);
  const majors = comps.map((c) => c.major).sort((a, b) => a - b);
  let areaAll = 0;
  let areaBig = 0;
  for (const c of comps) { areaAll += c.area; if (c.major > 35) areaBig += c.area; }
  return {
    coverage: fired / (N * N),
    count: comps.length,
    max: majors.length ? majors[majors.length - 1] : 0,
    p90: majors.length ? majors[Math.floor(0.9 * majors.length)] : 0,
    bigShare: areaAll > 0 ? areaBig / areaAll : 0,
  };
}

describe('§B the breakup: metre-scale caps inside a band-scale region', () => {
  it('a 40 m-and-longer band breaks in patches longer than the ship', () => {
    // WHY THIS IS THE BASELINE AND NOT A STRAW MAN: this is cascade 0's actual
    // geometry. Its shortest component is 40 m by the band split, so its
    // super-level sets are tens of metres and no downstream stage can make them
    // smaller. If this ever stops producing ship-length patches the fixture has
    // drifted off the thing it stands for.
    const plain = breakingRegions(0);
    expect(plain.max).toBeGreaterThan(35); // measured 67 m
    expect(plain.p90).toBeGreaterThan(35); // measured 54 m — MOST of them
    expect(plain.bigShare).toBeGreaterThan(0.5);
  });

  it('the breakup carves it into caps smaller than the hull', () => {
    // THE COMPLAINT, AS A NUMBER: "caps are 1.5–2× ship length" against a 35 m
    // ship. Leading with max and p90 because the area share is carried by a few
    // giant components and is noisy (23–43% between time samples of one build).
    const plain = breakingRegions(0);
    const broken = breakingRegions(foamParams.breakupSigma);
    // p90 UNDER the hull: nine caps in ten are now smaller than the ship,
    // where before nine in ten were larger (54 m → 29 m measured)
    expect(broken.p90).toBeLessThan(35);
    expect(broken.p90).toBeLessThan(plain.p90 * 0.65);
    // the area share is the complaint's own statistic but it is carried by a
    // few giant components and is noisy, so it is checked as a RATIO with the
    // tolerance that deserves: 0.76 → 0.32 measured here, 0.54 → 0.11 on the
    // real field. NOT eliminated — stated as a ratio so it cannot be read as
    // a claim that ship-length caps are gone.
    expect(broken.bigShare).toBeLessThan(plain.bigShare * 0.55);
    // and it is a FRAGMENTATION, not a deletion: many more, smaller caps
    expect(broken.count).toBeGreaterThan(plain.count * 2);
  });

  it('it fragments without removing the foam (§V.64)', () => {
    // WHY: the user asked for smaller caps, not less foam. The jitter is
    // zero-mean in σ, so to first order the firing AREA survives — if a future
    // retune makes the breakup one-sided this fails, which is the point.
    const plain = breakingRegions(0);
    const broken = breakingRegions(foamParams.breakupSigma);
    expect(broken.coverage).toBeGreaterThan(plain.coverage * 0.6);
    expect(broken.coverage).toBeLessThan(plain.coverage * 1.6);
  });

  it('breakupSigma 0 is the un-broken gate, exactly', () => {
    // the same A/B contract every other foam change ships behind
    expect(breakupJitter(12.3, -45.6, 1 / 16, 0.35, 0)).toBe(0);
  });
});

describe('§V.48 against the SIM GRID: no octave written sub-texel', () => {
  it('a band only takes the octaves its own texels can hold', () => {
    // WHY: a StorageTexture has NO mip chain and the inject pass writes it at
    // texel centres, so an octave finer than 2 texels is aliasing with nothing
    // downstream able to filter it — there is no `fwidth` in a compute pass and
    // no filtered tier below the sim resolution. Same rule as the screen-space
    // band limit, measured against the grid instead of the pixel.
    for (const texel of [1.97, 0.191, 0.0443]) {
      const n = breakupOctaves(foamParams.breakupMetres, texel);
      expect(n).toBeGreaterThan(0);
      // the finest octave taken is still at least 2 texels wide
      expect(foamParams.breakupMetres / 2 ** (n - 1)).toBeGreaterThanOrEqual(2 * texel);
      // and the next one would not have been
      if (n < 4) expect(foamParams.breakupMetres / 2 ** n).toBeLessThan(2 * texel);
    }
  });

  it('a band whose texels are coarser than the field takes NO octaves', () => {
    // rather than writing one aliased octave and calling it detail
    expect(breakupOctaves(16, 20)).toBe(0);
    expect(breakupOctaves(16, 8)).toBe(1);
    expect(breakupOctaves(0, 1)).toBe(0);
    expect(breakupOctaves(16, 0)).toBe(0);
    expect(breakupOctaves(Number.NaN, 1)).toBe(0);
  });
});

describe('§V.70 a retiring band fades to its MEAN, not to zero', () => {
  it('the analytic band mean matches a simulated field', () => {
    // WHY IT IS DERIVED AND NOT SAMPLED: reading a StorageTexture back every
    // frame is not on the table, and the fade target has to track weather. The
    // closed form is exact for a gaussian λ−, which is what the EIGEN_*
    // constants describe — so this test is the tripwire on that assumption.
    const traceRms = 0.0837;
    const choppiness = 0.95;
    const decay = decayFactorPerFrame(0.9, DT);
    const sd = eigenSigma(traceRms, choppiness);
    const mean = eigenRestValue(traceRms, choppiness);
    const gate = mean - 2.2 * sd;
    const injectPerStep = 4 * DT / sd;

    // simulate: a gaussian λ− field driven to steady state by the real
    // accumulate/decay ordering
    let acc = 0;
    let rng = 12345;
    const nextGauss = () => {
      // Box-Muller on a cheap LCG — deterministic, no Math.random (§V2)
      rng = (rng * 1664525 + 1013904223) >>> 0;
      const u1 = Math.max(1e-12, rng / 4294967296);
      rng = (rng * 1664525 + 1013904223) >>> 0;
      const u2 = rng / 4294967296;
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    };
    const SAMPLES = 200000;
    for (let i = 0; i < SAMPLES; i++) {
      acc += Math.max(0, gate - (mean + sd * nextGauss())) * injectPerStep;
    }
    const simulatedPerTick = acc / SAMPLES;
    const analyticPerTick = injectPerStep * expectedDeficit(gate, mean, sd);
    expect(analyticPerTick).toBeCloseTo(simulatedPerTick, 3);
    // and the steady state carries the inject-THEN-decay ordering
    expect(expectedBandFoam(gate, injectPerStep, traceRms, choppiness, decay)).toBeCloseTo(
      (analyticPerTick * decay) / (1 - decay),
      6,
    );
  });

  it('the mean a distant pixel sees is POSITIVE, which is the whole point', () => {
    // §V.70's diagnostic: what does ONE infinitely-distant pixel see? For a
    // COVERAGE field the answer is its coverage, not zero — cascade 2 has no
    // filtered tier and was faded to nothing outright past ~50 m, deleting real
    // foam rather than filtering it (§V.64). A mean of zero here would mean the
    // old behaviour had silently come back.
    const m = expectedBandFoam(0.62, 1.1, 0.1327, 0.95, decayFactorPerFrame(0.9, DT));
    expect(m).toBeGreaterThan(0);
    expect(m).toBeLessThanOrEqual(1);
  });

  it('a band that cannot fire fades to nothing, and never to NaN', () => {
    expect(expectedBandFoam(NEVER_INJECT_BIAS, 0, 0.05, 0.95, 0.99)).toBe(0);
    expect(expectedBandFoam(0.6, 1, 0.05, 0.95, 1)).toBe(0); // decay 1 = never dies
    expect(expectedBandFoam(0.6, 1, 0.05, 0.95, 0)).toBe(0);
    expect(normalCdf(Number.NaN)).toBe(0.5);
    expect(normalCdf(-40)).toBeGreaterThanOrEqual(0);
    expect(expectedDeficit(0.5, 0.5, 0)).toBe(0);
  });
});

/* ---------------------------------------------------------------------------
 * SHAPE, NOT SIZE (§B, user: "maybe we shouldn't only measure the area but
 * also its SHAPE — take a look that its shape is actually starting to reflect
 * the structure of the water").
 *
 * THIS BLOCK EXISTS BECAUSE THE PREVIOUS ROUND SATISFIED ITS STATISTIC AND
 * MADE THE PICTURE WORSE. The breakup hit its cap-size target and, unwatched,
 * took crest alignment +0.96 → +0.52 and aspect 2.48 → 1.73 with it — λ− was
 * already producing crest-following ribbons (that is §V.58 working) and
 * isotropic noise eroded them into discs. One number can always be moved; the
 * only defence is measuring more than one, so all four are pinned here.
 *
 *   ASPECT √(λ₁/λ₂) of the second moments — a whitecap is a ribbon, not a disc
 *   ALIGN  cos(2Δθ) between a cap's major axis and the local crest LINE, both
 *          as directors, so opposite headings are the same line
 *   CIRC   4πA/P², 1 for a perfect disc — "blotchy", directly
 *   p90    the size statistic, kept so a shape win cannot hide a size loss
 * ------------------------------------------------------------------------ */

interface CapShape { area: number; major: number; aspect: number; align: number; circ: number }

const shapeCache = new Map<string, ReturnType<typeof computeShapes>>();
function capShapes(elongation: number, breakupSigma: number) {
  const key = `${elongation}|${breakupSigma}`;
  const hit = shapeCache.get(key);
  if (hit) return hit;
  const v = computeShapes(elongation, breakupSigma);
  shapeCache.set(key, v);
  return v;
}

function computeShapes(elongation: number, breakupSigma: number): {
  coverage: number; count: number; p90: number;
  aspect: number; align: number; circ: number; frameAgreement: number;
} {
  const N = 384;
  const WIN = 900;
  const cell = WIN / N;
  const TEXEL = 1.97;
  const octaves = breakupOctaves(foamParams.breakupMetres, TEXEL);
  const freq = 1 / foamParams.breakupMetres;
  const CHOP = 0.95;
  const MODES = 32;
  const waves = Array.from({ length: MODES }, (_, i) => {
    const lambda = 40 * 10 ** (i / (MODES - 1));
    const k = (2 * Math.PI) / lambda;
    const th = i * Math.PI * (3 - Math.sqrt(5));
    return { k, cx: Math.cos(th), cz: Math.sin(th), ph: i * 1.7, amp: 0.03 / k };
  });

  const metric = new Float32Array(N * N);
  const gx = new Float32Array(N * N);
  const gz = new Float32Array(N * N);
  const crest = new Float32Array(N * N * 2); // λ−'s own crest director
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const wx = x * cell;
      const wz = y * cell;
      let dxx = 0; let dzz = 0; let dxz = 0; let hx = 0; let hz = 0;
      for (const w of waves) {
        const ph = w.k * (wx * w.cx + wz * w.cz) + w.ph;
        const c = Math.cos(ph) * w.amp * w.k;
        dxx -= c * w.cx * w.cx; dzz -= c * w.cz * w.cz; dxz -= c * w.cx * w.cz;
        const sn = Math.sin(ph) * w.amp * w.k;
        hx -= sn * w.cx; hz -= sn * w.cz;
      }
      gx[i] = hx; gz[i] = hz;
      const a = CHOP * dxx; const b = CHOP * dzz; const c2 = CHOP * dxz;
      metric[i] = minEigenvalue(2 + a + b, (1 + a) * (1 + b) - c2 * c2);
      const th = 0.5 * Math.atan2(2 * c2, a - b);
      crest[i * 2] = Math.cos(2 * th); crest[i * 2 + 1] = Math.sin(2 * th);
    }
  }

  // the structure-tensor frame, exactly as the inject pass builds it
  const R = tensorRadiusTexels(40, cell);
  const fc = new Float32Array(N * N);
  const fs = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let jxx = 0; let jzz = 0; let jxz = 0;
      for (let t = 0; t < 8; t++) {
        const ang = (t / 8) * Math.PI * 2;
        const tx = (((x + Math.round(Math.cos(ang) * R)) % N) + N) % N;
        const tz = (((y + Math.round(Math.sin(ang) * R)) % N) + N) % N;
        const a = gx[tz * N + tx]; const b = gz[tz * N + tx];
        jxx += a * a; jzz += b * b; jxz += a * b;
      }
      const fr = crestFrame(jxx, jzz, jxz);
      fc[y * N + x] = fr.cos; fs[y * N + x] = fr.sin;
    }
  }

  let m = 0;
  for (let i = 0; i < N * N; i++) m += metric[i];
  m /= N * N;
  let v = 0;
  for (let i = 0; i < N * N; i++) v += (metric[i] - m) ** 2;
  const sd = Math.sqrt(v / (N * N));
  const gate = m - 2.4 * sd * metricSigmaScale(0, breakupSigma, octaves);

  // FRAME AGREEMENT over FIRING texels only. λ−'s director carries a factor of
  // −h, so it flips between crest and trough and a whole-grid average cancels
  // to zero — which is exactly how a broken frame once measured as "0.010" and
  // nearly got shipped.
  let fd = 0; let fw = 0;
  for (let i = 0; i < N * N; i++) {
    const c = fc[i]; const s = fs[i];
    const d = (c * c - s * s) * crest[i * 2] + 2 * c * s * crest[i * 2 + 1];
    const w = Math.max(0, gate - metric[i]);
    fd += d * w; fw += w;
  }

  const on = new Uint8Array(N * N);
  let fired = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const j = breakupSigma
        ? breakupJitterAligned(
            x * cell, y * cell, { cos: fc[i], sin: fs[i] }, elongation,
            freq, foamParams.breakupWarp, octaves,
          ) * breakupSigma * sd
        : 0;
      on[i] = metric[i] + j < gate ? 1 : 0;
      fired += on[i];
    }
  }

  // components
  const seen = new Uint8Array(N * N);
  const stack: number[] = [];
  const comps: CapShape[] = [];
  for (let s0 = 0; s0 < N * N; s0++) {
    if (!on[s0] || seen[s0]) continue;
    stack.length = 0; stack.push(s0); seen[s0] = 1;
    const xs: number[] = []; const ys: number[] = [];
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % N; const y = (i / N) | 0;
      xs.push(x); ys.push(y);
      const nb = [x > 0 ? i - 1 : -1, x < N - 1 ? i + 1 : -1, y > 0 ? i - N : -1, y < N - 1 ? i + N : -1];
      for (const jj of nb) if (jj >= 0 && on[jj] && !seen[jj]) { seen[jj] = 1; stack.push(jj); }
    }
    const cnt = xs.length;
    if (cnt < 4) continue;
    let mx = 0; let my = 0;
    for (let i = 0; i < cnt; i++) { mx += xs[i]; my += ys[i]; }
    mx /= cnt; my /= cnt;
    let sxx = 0; let syy = 0; let sxy = 0;
    for (let i = 0; i < cnt; i++) {
      const dx = xs[i] - mx; const dy = ys[i] - my;
      sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    }
    sxx /= cnt; syy /= cnt; sxy /= cnt;
    const tr = sxx + syy;
    const root = Math.sqrt(Math.max(0, (tr * tr) / 4 - (sxx * syy - sxy * sxy)));
    // FLOOR λ₂ at a sixteenth of a cell²: a one-texel-wide sliver otherwise
    // reports an unbounded aspect and would make this test lie in our favour
    const l1 = tr / 2 + root;
    const l2 = Math.max(1 / 16, tr / 2 - root);
    let per = 0;
    for (let i = 0; i < cnt; i++) {
      const x = xs[i]; const y = ys[i]; const idx = y * N + x;
      if (x === 0 || !on[idx - 1]) per++;
      if (x === N - 1 || !on[idx + 1]) per++;
      if (y === 0 || !on[idx - N]) per++;
      if (y === N - 1 || !on[idx + N]) per++;
    }
    const area = cnt * cell * cell;
    const P = per * cell;
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    let cx2 = 0; let sy2 = 0;
    for (let i = 0; i < cnt; i++) {
      const idx = ys[i] * N + xs[i];
      cx2 += crest[idx * 2]; sy2 += crest[idx * 2 + 1];
    }
    comps.push({
      area, major: 4 * Math.sqrt(l1) * cell, aspect: Math.sqrt(l1 / l2),
      align: Math.hypot(cx2, sy2) > 1e-9 ? Math.cos(2 * theta - Math.atan2(sy2, cx2)) : 0,
      circ: P > 0 ? (4 * Math.PI * area) / (P * P) : 0,
    });
  }
  const med = (v2: number[]) => {
    const s2 = [...v2].sort((a, b) => a - b);
    return s2.length ? s2[Math.floor(s2.length / 2)] : NaN;
  };
  let wa = 0; let ws = 0;
  for (const c of comps) { wa += c.align * c.area; ws += c.area; }
  const majors = [...comps.map((c) => c.major)].sort((a, b) => a - b);
  return {
    coverage: fired / (N * N),
    count: comps.length,
    p90: majors.length ? majors[Math.floor(0.9 * majors.length)] : 0,
    aspect: med(comps.map((c) => c.aspect)),
    align: ws > 0 ? wa / ws : NaN,
    circ: med(comps.map((c) => c.circ)),
    frameAgreement: fw > 0 ? fd / fw : NaN,
  };
}

describe('§B the crest frame: caps shaped like the water, not like the noise', () => {
  it('the structure tensor really does recover the crest axis', () => {
    // WHY THIS TEST EXISTS AND WHY IT IS WEIGHTED: the first version of this
    // frame measured 0.010 agreement — it recovered NOTHING — and the reason
    // the bug survived a whole measurement pass is that λ−'s director carries a
    // factor of −h, so it flips between crest and trough and an unweighted
    // whole-grid average cancels to zero whether the frame is right or wrong.
    // Weighting by the firing deficit is what makes this question answerable.
    // Verified against a single 100 m mode, where the answer is analytic: 1.000.
    const s = capShapes(foamParams.breakupElongation, foamParams.breakupSigma);
    expect(s.frameAgreement).toBeGreaterThan(0.75); // measured 0.899
  });

  it('the ring radius has an optimum and a fixed texel count misses it', () => {
    // Too SMALL and all eight taps see one gradient, so the tensor degenerates
    // to rank one — it becomes the raw gradient, the one quantity that vanishes
    // ON the crest line. Too LARGE and the ring spans the next crest and
    // averages two unrelated directions. Measured agreement across radii of a
    // 40–400 m band: 0.374 / 0.497 / 0.855 / 0.874 / 0.564 / −0.127 at 1 / 2 /
    // 4 / 8 / 16 / 32 cells. Shipping a fixed 2 texels sat at 0.497.
    expect(tensorRadiusTexels(40, 1.97)).toBe(7); // cascade 0: 40 m band
    expect(tensorRadiusTexels(8.3, 0.191)).toBe(12); // cascade 1, clamped
    expect(tensorRadiusTexels(0, 0.044)).toBe(1); // finest band: no kMax
    expect(tensorRadiusTexels(40, 0)).toBe(1); // §V28
    expect(tensorRadiusTexels(Number.NaN, 1)).toBe(1);
  });

  it('crest-frame breakup keeps the ribbon that isotropic noise erodes', () => {
    // THE REGRESSION THIS ROUND EXISTS TO UNDO. Isotropic noise measured
    // aspect 1.73 and align +0.52 against λ−'s own unbroken 2.48 / +0.96.
    const iso = capShapes(1, foamParams.breakupSigma);
    const aligned = capShapes(foamParams.breakupElongation, foamParams.breakupSigma);
    // ribbons, not discs — at or above what λ− produces on its own
    const plain = capShapes(1, 0);
    // ribbons, not discs — at or above what λ− produces on its own unbroken
    expect(aligned.aspect).toBeGreaterThan(2.55); // measured 2.618
    expect(aligned.aspect).toBeGreaterThan(plain.aspect); // λ−'s own 2.476
    expect(aligned.aspect).toBeGreaterThan(iso.aspect); // 2.449
    // and they point along the crest they sit on
    expect(aligned.align).toBeGreaterThan(0.6); // measured 0.631
    expect(aligned.align).toBeGreaterThan(iso.align + 0.08); // iso 0.517
    // less disc-like: a perfect disc is 1.0
    expect(aligned.circ).toBeLessThan(0.42); // measured 0.363
    expect(aligned.circ).toBeLessThan(iso.circ * 0.85); // iso 0.503
  });

  it('the shape win does not cost the size win (§33b6c33)', () => {
    // the trap this whole round is about: one statistic satisfied while
    // another quietly goes. p90 must stay in the range the size fix reached.
    const plain = capShapes(1, 0);
    const aligned = capShapes(foamParams.breakupElongation, foamParams.breakupSigma);
    expect(aligned.p90).toBeLessThan(plain.p90 * 0.65); // 28.5 vs 53.9
    expect(aligned.count).toBeGreaterThan(plain.count * 2); // 37 vs 15
    // and it is still a redistribution, not a deletion (§V.64)
    expect(aligned.coverage).toBeGreaterThan(plain.coverage * 0.6);
    expect(aligned.coverage).toBeLessThan(plain.coverage * 1.6);
  });
});

/**
 * Wind–wave coupling for whitecaps (docs/research-whitecap-coverage.md).
 *
 * The invariant these encode is a PHYSICAL one, not a curve fit: whitecapping
 * is wind-driven wave BREAKING, so foam is the local wind's signature on the
 * sea. Swell is by definition energy that has outrun the wind that raised it,
 * so a big old swell on a still day must carry none — and every gate in
 * src/foam is σ-relative and therefore scale-free, which is exactly the
 * mechanism by which it used to carry some.
 */
describe('whitecaps follow the WIND, not just the fold (§V36, research §4.1)', () => {
  it('a massive swell on a windless day carries no whitecaps', () => {
    // THE user-reported case, and the one the research answers cleanly. The
    // sea can be as tall and as folded as it likes: with no wind forcing the
    // crests, nothing is breaking, so nothing may be injected.
    expect(whitecapWindScale(0, 11)).toBe(0);
    expect(whitecapWindScale(2, 11)).toBe(0);
    // and the cutoff is the PUBLISHED onset, not a taste: Beaufort Force 3 —
    // the first mention of whitecaps in the entire scale — starts at 3.60 m/s
    // and Callaghan's independent 2008 fit landed at 3.70.
    expect(whitecapWindScale(WHITECAP_ONSET_MS, 11)).toBe(0);
    expect(whitecapWindScale(WHITECAP_ONSET_MS + 0.5, 11)).toBeGreaterThan(0);
  });

  it('the sea this project was calibrated on does not move at all', () => {
    // §V36's whole point, and the reason this is a RATIO and not the
    // literature's absolute coverage: at the calibration wind the multiplier
    // must be EXACTLY 1, so every measured number in src/foam and every
    // shipped preset's look survives this change bit-identically. If this
    // fails, the change stopped being a gate and became a recalibration.
    expect(whitecapWindScale(foamParams.whitecapWindRef, foamParams.whitecapWindRef)).toBe(1);
    // and the reference IS the sea we ship, so the default ocean is untouched
    expect(foamParams.whitecapWindRef).toBe(oceanParams.windSpeed);
  });

  it('wind can only take foam away, never add it — storm keeps its calibration', () => {
    // Deliberately one-sided. The defect is foam appearing where there should
    // be none, which lies entirely BELOW the reference; raising coverage above
    // it would be a coverage calibration, and storm cannot be calibrated
    // against while its Hs reads 18.6 m against the 8-10 m it was cut to.
    // The unclamped physical ratio at storm is ~3.6x — this pins that it is
    // NOT being applied, so whoever fixes storm's height inherits a clean
    // decision rather than a silently retuned sea.
    expect(whitecapCoverage(18) / whitecapCoverage(11)).toBeGreaterThan(3);
    expect(whitecapWindScale(18, 11)).toBe(1);
    expect(whitecapWindScale(30, 11)).toBe(1);
  });

  it('a dying breeze thins the foam out smoothly, in the published order', () => {
    // The look this buys: as the wind drops the sea keeps its shape (the
    // Jacobian gate is untouched, so foam stays on the crests that fold) and
    // simply stops being white. Monotone and continuous, or the transition
    // reads as foam switching off rather than dying down.
    const winds = [4, 5, 6, 7, 8, 9, 10, 11];
    const scales = winds.map((u) => whitecapWindScale(u, 11));
    for (let i = 1; i < scales.length; i++) {
      expect(scales[i]).toBeGreaterThan(scales[i - 1]);
    }
    // calm's own 4 m/s is barely above onset: effectively no whitecaps, which
    // is the published law AND the user's "if it's rather calm it's fine that
    // there's no foam" — not an artistic liberty.
    expect(whitecapWindScale(4, 11)).toBeLessThan(0.001);
    // no step anywhere, including across the 9.25-11.25 window where the two
    // published branches overlap and disagree by 26% at the seam
    for (let u = 3.7; u < 24; u += 0.05) {
      const jump = Math.abs(whitecapWindScale(u + 0.05, 11) - whitecapWindScale(u, 11));
      expect(jump).toBeLessThan(0.02);
    }
  });

  it('never asks for more foam than the sea can physically carry', () => {
    // Brumer et al. 2017 measured to sustained 25 m/s and state coverage
    // levels off "not exceeding 10%". Our windSpeed slider reaches 30, past
    // the fit's own 23.09 m/s validity edge, so an unclamped cubic would run
    // away off the end of the panel rather than off the end of the data.
    expect(whitecapCoverage(30)).toBeLessThanOrEqual(0.1);
    expect(whitecapCoverage(1000)).toBeLessThanOrEqual(0.1);
    // and it never returns garbage for garbage (§V28)
    expect(whitecapCoverage(Number.NaN)).toBe(0);
    expect(whitecapCoverage(-5)).toBe(0);
    // a reference at or below onset has no ratio to give: leave foam alone
    // rather than divide by zero and scrub the sea bare
    expect(whitecapWindScale(11, 0)).toBe(1);
    expect(whitecapWindScale(11, Number.NaN)).toBe(1);
  });

  it('the gate still decides WHERE — only the amount is wind-scaled', () => {
    // The architectural split the research names, pinned so nobody "fixes"
    // this by moving the threshold instead. A wind-scaled THRESHOLD would
    // move foam onto different crests as the weather changed; a wind-scaled
    // AMOUNT leaves it on exactly the folding ones and only changes how white
    // they get. eigenFoamGate takes no wind and must keep taking none.
    const sea = seaFor('swell');
    const bandSigma = jacobianSigma(sea.steep[0], sea.lambda);
    const seaSigma = jacobianSigma(sea.steepnessRms, sea.lambda);
    const gate = eigenFoamGate(
      oceanParams.jacobianFoamBias, sea.steep[0], sea.lambda, bandSigma, seaSigma, 1,
    );
    // same fold depth, two winds → same gate, proportionally less foam
    const at = (wind: number) =>
      eigenInjectPerStep(
        foamParams.injectStrength * whitecapWindScale(wind, 11),
        DT, sea.steep[0], sea.lambda, bandSigma, seaSigma, 1,
      );
    expect(Number.isFinite(gate)).toBe(true);
    expect(at(8) / at(11)).toBeCloseTo(whitecapWindScale(8, 11), 9);
    expect(at(2)).toBe(0); // below onset: the gate is unchanged, nothing injects
  });
});
