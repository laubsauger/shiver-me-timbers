/**
 * §T.5 stage 3 — the foam ART TEXTURE, and the claim it is built on.
 *
 * The talk's third foam stage is "we blend this with artist authored foam
 * textures: a high frequency foam texture at the crest of the wave, then we
 * blend to a lower frequency texture as it blends out". This project
 * substituted a value-noise fbm for that pair from the beginning, and the
 * reason that substitution CANNOT work is structural, not a matter of tuning:
 *
 *   VALUE NOISE HAS ROUND LEVEL SETS.
 *
 * So the tests that matter here are not "is the texture in range" — they are
 * the ones that would still fail if someone swapped the generator back for an
 * fbm that happened to have the same histogram. That is the isoperimetric
 * block below: at MATCHED coverage, a cellular/torn field has far more
 * boundary per unit area than a blobby one, because a network of thin walls is
 * mostly boundary and a field of discs is mostly interior. Every control below
 * is FREQUENCY-MATCHED to the channel it challenges — an unmatched control
 * measures the sampling grid, not the shape.
 */
import { describe, expect, it } from 'vitest';
import {
  buildFoamPattern,
  rankNormalise,
  tiledFbm,
  tiledValueNoise,
  tiledWorley,
  FOAM_CHANNEL,
} from '../src/foam/foamPattern';

/**
 * THE SHIPPED SIZE, and this is load-bearing for the shape tests below rather
 * than a fidelity preference. At 64² the crest lace's 26-cell raft is 2.5
 * texels per cell and its walls are sub-texel: BOTH the texture and its fbm
 * control degenerate into per-texel noise, the isoperimetric statistic
 * measures the sampling grid instead of the shape, and the comparison inverts
 * (measured: fbm 2.89 against lace 1.45 at 64², lace 1.68 against fbm 0.77 at
 * 256²). A shape test run below its own Nyquist rate reports the grid — which
 * is §V.48's lesson arriving in the test harness.
 */
const N = 256;
/** ~135 ms to build; shared across every describe rather than rebuilt */
const PATTERN = buildFoamPattern(N);

function channel(data: Uint8Array, n: number, c: number): Float32Array {
  const out = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) out[i] = data[i * 4 + c] / 255;
  return out;
}

/**
 * Boundary edges per interior texel of the set {field ≤ q-quantile}, at a
 * COVERAGE MATCHED to the comparison field.
 *
 * This is the isoperimetric statistic and it is the whole point: a set of
 * round discs of radius r has perimeter/area = 2/r, while a network of walls
 * of thickness w has perimeter/area ≈ 2/w with w ≪ r. Thresholding value
 * noise gives the former; a bubble raft gives the latter. Matching coverage
 * first is what makes it a shape test rather than an amount test.
 */
function edgeDensity(field: Float32Array, n: number, coverage: number): number {
  const sorted = Array.from(field).sort((a, b) => a - b);
  const cut = sorted[Math.min(sorted.length - 1, Math.floor(coverage * sorted.length))];
  const inSet = (x: number, y: number) =>
    field[((y % n) + n) % n * n + (((x % n) + n) % n)] <= cut;
  let inside = 0;
  let edges = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!inSet(x, y)) continue;
      inside++;
      if (!inSet(x + 1, y)) edges++;
      if (!inSet(x - 1, y)) edges++;
      if (!inSet(x, y + 1)) edges++;
      if (!inSet(x, y - 1)) edges++;
    }
  }
  return inside === 0 ? 0 : edges / inside;
}

/** the baseline this whole file exists to beat: a plain value-noise fbm */
function fbmField(n: number, baseFreq: number, octaves: number): Float32Array {
  const out = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      out[y * n + x] = tiledFbm((x + 0.5) / n, (y + 0.5) / n, baseFreq, octaves, 4242);
    }
  }
  return out;
}

function extent(f: Float32Array): { lo: number; hi: number } {
  let lo = Infinity;
  let hi = -Infinity;
  // a loop, not Math.min(...f): 65536 spread arguments overflows the stack
  for (const v of f) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return { lo, hi };
}

function mean(f: Float32Array): number {
  let sum = 0;
  for (const v of f) sum += v;
  return sum / f.length;
}

/** mean |difference| between neighbouring columns, wrapping at the seam */
function columnJump(field: Float32Array, n: number, a: number, b: number): number {
  let sum = 0;
  for (let y = 0; y < n; y++) sum += Math.abs(field[y * n + a] - field[y * n + b]);
  return sum / n;
}

describe('the pattern TILES (a seam draws a grid across the whole sea)', () => {
  const data = PATTERN;

  for (const [name, c] of Object.entries(FOAM_CHANNEL)) {
    it(`${name}: the wrap seam is as smooth as the interior`, () => {
      const f = channel(data, N, c);
      // column N−1 → column 0 is the seam; column 0 → 1 is an ordinary
      // neighbour pair. A non-tiling field jumps by roughly the field's own
      // range at the seam; a tiling one does not know the seam is there.
      const seam = columnJump(f, N, N - 1, 0);
      let interior = 0;
      for (let x = 0; x < N - 1; x++) interior += columnJump(f, N, x, x + 1);
      interior /= N - 1;
      expect(seam).toBeLessThan(interior * 2);
    });
  }

  it('the lattice primitives are periodic to float precision', () => {
    // the wrap is the property; the value at u and at u+1 must be identical
    expect(tiledValueNoise(0.13, 0.71, 8, 5)).toBeCloseTo(
      tiledValueNoise(1.13, 1.71, 8, 5),
      12,
    );
    const a = tiledWorley(0.13, 0.71, 6, 5);
    const b = tiledWorley(1.13, 1.71, 6, 5);
    expect(a.f1).toBeCloseTo(b.f1, 12);
    expect(a.f2).toBeCloseTo(b.f2, 12);
  });
});

describe('the breakup channel is a DISSOLVE, and dissolves must be unbiased', () => {
  it('rank-normalising gives exactly uniform [0,1] with mean exactly 0.5', () => {
    // mean 0.5 is not decoration: the mean of the threshold field IS the net
    // coverage the erosion adds or removes. An unmeasured mean means turning
    // the art texture on silently moves foam coverage, which is the one
    // quantity five separate user reports have been about.
    const raw = new Float32Array([0.9, 0.1, 0.5, 0.7, 0.2, 0.2001]);
    const out = rankNormalise(raw);
    let sum = 0;
    for (const v of out) sum += v;
    // float32 accumulation, not the construction: the quantile midpoints sum
    // exactly, the addition does not
    expect(sum / out.length).toBeCloseTo(0.5, 8);
    // order preserving
    expect(out[1]).toBeLessThan(out[4]);
    expect(out[4]).toBeLessThan(out[5]);
    expect(out[5]).toBeLessThan(out[2]);
    expect(out[2]).toBeLessThan(out[3]);
    expect(out[3]).toBeLessThan(out[0]);
    // exactly the n quantile midpoints, each used once (to float32)
    const sortedOut = [...out].sort((a, b) => a - b);
    sortedOut.forEach((v, r) => expect(v).toBeCloseTo((r + 0.5) / 6, 6));
  });

  it('survives 8-bit encoding with its mean intact', () => {
    const f = channel(PATTERN, N, FOAM_CHANNEL.breakup);
    let sum = 0;
    for (const v of f) sum += v;
    // 1/255 is one quantisation step; anything looser and the sub-pixel ramp
    // in foamMath.dissolveKnee is being calibrated against the wrong centre
    expect(Math.abs(sum / f.length - 0.5)).toBeLessThan(1 / 255);
  });

  it('spans the full range — a dissolve that never reaches 0 never tears', () => {
    const { lo, hi } = extent(channel(PATTERN, N, FOAM_CHANNEL.breakup));
    expect(lo).toBeLessThan(0.01);
    expect(hi).toBeGreaterThan(0.99);
  });
});

describe('the shape claim: cellular and torn, NOT blobby (§V.58 one stage on)', () => {
  const data = PATTERN;
  /**
   * The darkest tenth. The crest channel's dark features at this level are the
   * WALL NETWORK — thin lines with junctions — while the fbm control's are
   * isolated basins, so the perimeter-per-texel gap is at its widest here
   * (measured 1.51 vs 0.77). Push the coverage past ~0.3 and the lace's broad
   * torn gaps take over the dark set, the walls stop being what is measured,
   * and the statistic stops discriminating (measured 0.34 vs 0.48 — it
   * INVERTS). That is not a weakness of the texture, it is the statistic
   * answering a different question, and it is written down so the next person
   * does not "fix" the threshold and quietly delete the test's meaning.
   */
  const COVERAGE = 0.1;

  it('the crest lace has far more boundary per texel than a value-noise fbm', () => {
    const lace = edgeDensity(channel(data, N, FOAM_CHANNEL.crest), N, COVERAGE);
    // matched frequency: the fbm baseline is given the SAME base cell count as
    // the lace's coarse bubble raft, so this compares shape and nothing else
    const blob = edgeDensity(fbmField(N, 26, 3), N, COVERAGE);
    // measured 1.68 vs 0.77 = 2.17x; the bar is set below that with margin for
    // a reseed, and far above 1.0, which is where a swap back to fbm lands
    expect(lace).toBeGreaterThan(blob * 1.5);
  });

  it('the breakup contour is torn, not convex, at EVERY coverage', () => {
    // The dissolve is applied across the whole mask range, so unlike the lace
    // above it has to hold its shape at every threshold, not just one.
    //
    // THE CONTROL IS THE BREAKUP CHANNEL'S OWN fbm CORE, UNWARPED — same base
    // frequency, same octave count, same everything but the domain warp and
    // the worley ridge. That isolates the mechanism claim (warping makes
    // contours meander and pinch) instead of measuring a frequency
    // difference. The first version of this test used base 14 × 4 octaves,
    // whose FINEST octave is 2.3 texels per cell: the control was near-Nyquist
    // noise, its edge density was the sampling grid's, and it beat the real
    // field. §V.48's lesson, arriving in the test harness for the second time.
    //
    // Measured ratios, coverage 0.1 → 0.5: 1.51, 1.36, 1.21, 1.25, 1.26.
    for (const cov of [0.1, 0.2, 0.3, 0.4, 0.5]) {
      const torn = edgeDensity(channel(data, N, FOAM_CHANNEL.breakup), N, cov);
      const blob = edgeDensity(fbmField(N, 8, 4), N, cov);
      expect(torn, `coverage ${cov}`).toBeGreaterThan(blob * 1.15);
    }
  });

  it('a value-noise fbm cannot be tuned into it — the level sets are round', () => {
    // the negative control, stated as a test so the claim in the header is
    // falsifiable: NO octave count moves an fbm into the lace's territory
    const lace = edgeDensity(channel(data, N, FOAM_CHANNEL.crest), N, COVERAGE);
    for (const oct of [1, 2, 3, 4, 5]) {
      expect(edgeDensity(fbmField(N, 26, oct), N, COVERAGE)).toBeLessThan(lace);
    }
  });
});

describe('build contract (§V28: fail loud at construction)', () => {
  it('rejects a size that is not a power of two', () => {
    expect(() => buildFoamPattern(100)).toThrow(/power of two/);
    expect(() => buildFoamPattern(4)).toThrow(/power of two/);
  });

  it('is deterministic — same bytes every call, so A/Bs are comparable', () => {
    expect(buildFoamPattern(32)).toEqual(buildFoamPattern(32));
  });

  it('every channel uses a real part of its 8-bit range', () => {
    for (const [name, c] of Object.entries(FOAM_CHANNEL)) {
      const { lo, hi } = extent(channel(PATTERN, N, c));
      expect(hi - lo, `${name} is nearly constant — it contributes nothing`)
        .toBeGreaterThan(0.4);
    }
  });

  it('the body channels keep the MEAN of the fbm layers they replace', () => {
    // The mean of a multiplier on the foam mask is foam AMOUNT; its structure
    // is foam SHAPE. Matching the means measured off the old crackle (0.409)
    // and mottle (0.758) layers is what makes this a pure shape change — an
    // art texture that also moved coverage would confound the one quantity
    // five separate foam reports have been arguing about.
    const crest = mean(channel(PATTERN, N, FOAM_CHANNEL.crest));
    const soft = mean(channel(PATTERN, N, FOAM_CHANNEL.soft));
    expect(Math.abs(crest - 0.409)).toBeLessThan(0.06);
    expect(Math.abs(soft - 0.758)).toBeLessThan(0.06);
  });
});
