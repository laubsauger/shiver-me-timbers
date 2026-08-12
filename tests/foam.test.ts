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
  JACOBIAN_SIGMA_PER_STEEPNESS,
  NEVER_INJECT_BIAS,
  accumulateFoam,
  blurDecayAnisoAt,
  blurDecayAt,
  boxReduceAt,
  cascadeDetailWeight,
  cascadeFadeDistance,
  cascadeFoamBias,
  cascadeInjectPerStep,
  crestTapOffset,
  foamTexelMetres,
  decayFactorPerFrame,
  injectAmount,
  jacobianSigma,
  wrapIndex,
} from '../src/foam/foamMath';
import { foamParams } from '../src/params/foam';
import { oceanParams, type OceanParams } from '../src/params/ocean';
import {
  cascadeBand,
  effectiveChoppiness,
  phillips,
  spectralSteepness,
} from '../src/ocean/oceanMath';
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

describe('crest-aligned blur (§V6 cap SHAPE: ridges, not round blobs)', () => {
  const n = 16;
  // waves rolling along +x → crest lines run along y, so foam must smear in y
  const AX = 1;
  const AZ = 0;
  const impulse = (x: number, y: number): Float32Array => {
    const g = new Float32Array(n * n);
    g[y * n + x] = 1;
    return g;
  };

  it('tap frame is orthonormal-rotated: along the ridge, across the propagation', () => {
    // propagation = (0, 1) → crest runs along x → dx taps move in x, dy in y
    const [ax, ay] = crestTapOffset(0, 1, 1, 0, 3, 0.5);
    expect(Math.abs(ax)).toBeCloseTo(3, 12);
    expect(ay).toBeCloseTo(0, 12);
    const [bx, by] = crestTapOffset(0, 1, 0, 1, 3, 0.5);
    expect(bx).toBeCloseTo(0, 12);
    expect(by).toBeCloseTo(0.5, 12);
  });

  it('degenerate direction falls back to the axis frame (never NaN offsets)', () => {
    // WHY §V28: a zero direction must never divide-by-zero into NaN texel
    // offsets — it simply blurs isotropically like before.
    const [ox, oy] = crestTapOffset(0, 0, 1, 1, 1, 1);
    expect(Number.isFinite(ox)).toBe(true);
    expect(Number.isFinite(oy)).toBe(true);
  });

  it('along = across = 1 reproduces the isotropic blur exactly', () => {
    // WHY: the crest frame is a ROTATION — it must not change how much foam
    // spreads, only its direction. This pins that the knob is shape-only.
    const src = impulse(8, 8);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        expect(blurDecayAnisoAt(src, AX, AZ, n, x, y, 1, 1, 1, 0.9)).toBeCloseTo(
          blurDecayAt(src, n, x, y, 1, 0.9),
          12,
        );
      }
    }
  });

  it('spreads ALONG the crest and barely across it (the user-visible fix)', () => {
    // WHY (user: "the foam caps are too circular, not really following the
    // cap of the wave"): with along ≫ across the same injected fold becomes
    // a ridge-following streak instead of a disc.
    const src = impulse(4, 8);
    const at = (x: number, y: number) =>
      blurDecayAnisoAt(src, AX, AZ, n, x, y, 1, 3, 0.34, 1);
    // crest tangent is ±y here: foam reaches 3 texels along y…
    expect(at(4, 11)).toBeGreaterThan(0);
    expect(at(4, 5)).toBeGreaterThan(0);
    // …and does NOT reach the same distance across the crest (x)
    expect(at(7, 8)).toBe(0);
    expect(at(1, 8)).toBe(0);
  });

  it('conserves foam mass EXACTLY at any stretch — decay owns lifetime alone', () => {
    // WHY this is not a nicety (user: "I think we're missing some foam caps"):
    // a per-texel crest frame derived from ∇h rotates fastest exactly where
    // foam lives (∇h vanishes and flips sign ON the crest line), and a
    // rotating gather kernel is NOT conservative — it sheds foam every frame,
    // so caps quietly died faster than decayHalfLife promised. A uniform
    // frame is shift-invariant, which is what makes this exact.
    for (const [along, across] of [
      [1, 1],
      [3, 0.34],
      [2.6, 0.5],
      [4, 0.25],
    ]) {
      const src = impulse(4, 8);
      let sum = 0;
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++)
          sum += blurDecayAnisoAt(src, AX, AZ, n, x, y, 1, along, across, 1);
      expect(sum, `along=${along} across=${across}`).toBeCloseTo(1, 10);
    }
  });

  it('conserves foam for ANY propagation direction, not just the axes', () => {
    // a diagonal swell must not lose foam either — the gradient-derived frame
    // failed precisely on fields whose direction was not axis-aligned
    const src = impulse(8, 8);
    for (const [dx, dz] of [
      [1, 1],
      [-2, 1],
      [0.3, -0.9],
    ]) {
      let sum = 0;
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++)
          sum += blurDecayAnisoAt(src, dx, dz, n, x, y, 1, 3, 0.34, 1);
      expect(sum, `dir=${dx},${dz}`).toBeCloseTo(1, 10);
    }
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

  it('texel size and fade distance derive from the cascade, not a constant', () => {
    // §V36's lesson applied to a distance gate: retuning a domain or the sim
    // resolution must re-derive the fade, not silently invalidate it.
    expect(foamTexelMetres(253, 512)).toBeCloseTo(0.494, 3);
    expect(foamTexelMetres(13.7, 512)).toBeCloseTo(0.0268, 4);
    // the fine cascade's texels go sub-pixel ~18× closer than the coarse one
    const coarse = cascadeFadeDistance(foamTexelMetres(253, 512), 2300);
    const fine = cascadeFadeDistance(foamTexelMetres(13.7, 512), 2300);
    expect(coarse / fine).toBeCloseTo(253 / 13.7, 6);
  });

  it('bands retire in order: fine first, coarse last, none abruptly', () => {
    // WHY smoothstep and not a cut: a hard switch-off draws a visible ring on
    // the sea where a whole cascade vanished.
    const w = (domain: number, d: number) =>
      cascadeDetailWeight(d, foamTexelMetres(domain, 512), 2300, 3);
    expect(w(13.7, 10)).toBe(1); // near: fine band fully resolved
    expect(w(13.7, 400)).toBe(0); // far: fine band is sub-pixel noise
    expect(w(253, 400)).toBe(1); // coarse band still resolves there
    expect(w(253, 1e5)).toBe(0);
    // monotone, and strictly between 0 and 1 across the transition
    const mid = w(13.7, 120);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(w(13.7, 100)).toBeGreaterThan(w(13.7, 140));
  });

  it('degenerate fade settings never produce NaN weights (§V28)', () => {
    for (const [d, t, span] of [
      [100, 0, 3],
      [100, 2300, 1],
      [100, 0, 0],
      [0, 0, 0],
    ]) {
      const v = cascadeDetailWeight(d, foamTexelMetres(253, 512), t, span);
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
      const amp = Math.sqrt(phillips(kx, kz, p) / 2) / domain;
      variance += 2 * (k * amp) ** 2;
    }
  }
  return lambda * Math.sqrt(variance);
}

function seaFor(name: keyof typeof weatherPresets) {
  const p: OceanParams = { ...oceanParams, ...weatherPresets[name].ocean };
  const steep = [0, 1, 2].map((i) =>
    spectralSteepness(p.resolution, p.cascades[i].domain, p, cascadeBand(i, p.splitWavelengths)),
  );
  const steepnessRms = Math.sqrt(steep.reduce((s, v) => s + v * v, 0));
  const lambda = effectiveChoppiness(p.choppiness, steepnessRms, p.choppinessFoldLimit);
  return { p, steep, steepnessRms, lambda, bias: p.jacobianFoamBias };
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
        expect(predicted / measured, `${name} cascade ${i}`).toBeCloseTo(1, 1);
      }
    }
    expect(JACOBIAN_SIGMA_PER_STEEPNESS).toBeGreaterThan(1);
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
    // calm has nothing in the 420 m band: its det J is identically 1, so it
    // can never fold. Handing it a σ of zero must switch it off, not produce
    // an infinite bias or an infinite injection (§V28).
    const sea = seaFor('calm');
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

describe('far tier handover (§V48: no step bigger than the reduction itself)', () => {
  // The reduce chain is 512² → 128² → 32². shadingNode must hand over
  // fine→mid→coarse, each at ITS OWN texel size. Cross-fading fine straight
  // into coarse (what it used to do, leaving the 128² tier computed and
  // unread) jumps 16× in texel AREA at a distance that justifies 4×, so the
  // whole coarsest cascade gets read from a 32×32 texture — and bilinear on
  // 32×32 stretched over kilometres is a lattice of 13 m quads. Because the
  // surface material divides its specular by the foam mask, that lattice
  // shows up as hard quantised squares in the sun glint road.
  const DOMAIN = 420;
  const N = 512;
  const fineT = foamTexelMetres(DOMAIN, N);
  const midT = foamTexelMetres(DOMAIN, N / 4);
  const coarseT = foamTexelMetres(DOMAIN, N / 16);
  const FADE = foamParams.cascadeFadeTexels;
  const SPAN = foamParams.cascadeFadeSpan;

  it('the chain builds 4× steps — so a 4× handover is available, if it is used', () => {
    expect(midT / fineT).toBeCloseTo(4, 6);
    expect(coarseT / midT).toBeCloseTo(4, 6);
  });

  it('records the SIZE of the jump shadingNode currently takes (the defect)', () => {
    // shadingNode cross-fades fine → coarse and never samples the mid tier, so
    // the step it actually takes is 16× in texel area, at the distance where
    // only 4× was warranted. This pins the number so the fix can be measured
    // against it; see the DIAGNOSED, NOT YET FIXED block in src/foam/index.ts.
    expect(coarseT / fineT).toBeCloseTo(16, 6);
    const w = (t: number, d: number) => cascadeDetailWeight(d, t, FADE, SPAN);
    const fineGone = cascadeFadeDistance(fineT, FADE) * SPAN * 1.01;
    expect(w(fineT, fineGone)).toBeCloseTo(0, 6);
    // the mid tier is still fully resolved at that distance — i.e. there is a
    // whole distance band being served by 32² when 128² was available
    expect(w(midT, fineGone)).toBeCloseTo(1, 6);
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
