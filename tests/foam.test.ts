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
  injectAmount,
  jacobianSigma,
  wrapIndex,
} from '../src/foam/foamMath';
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
