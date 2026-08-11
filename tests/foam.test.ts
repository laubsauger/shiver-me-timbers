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
  accumulateFoam,
  blurDecayAnisoAt,
  blurDecayAt,
  crestTapOffset,
  decayFactorPerFrame,
  injectAmount,
  wrapIndex,
} from '../src/foam/foamMath';
import { foamParams } from '../src/params/foam';
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
