/**
 * THE FOAM ART TEXTURE (§T.5 stage 3, talk 07:49) — generated, not authored,
 * but generated as an ARTIST WOULD AUTHOR IT rather than as noise.
 *
 * The talk's third stage is one sentence: "we blend this with artist authored
 * foam textures — we have a high frequency foam texture at the crest of the
 * wave, and then we blend to a lower frequency texture as it blends out."
 * This project has substituted a value-noise fbm for that pair since the
 * beginning, and THAT is the drift. A value-noise fbm cannot make foam,
 * for a reason that is structural and not a matter of tuning:
 *
 *   VALUE NOISE HAS ROUND LEVEL SETS. Its super-level sets are blobs, because
 *   it is a smooth interpolation of independent lattice values — the maxima
 *   are near cell centres and the contours around them are convex. Threshold
 *   it and you get discs; that is the user's "blotchy, reads as discs", and it
 *   is the same defect §V.58 identified one stage upstream (det J is
 *   direction-free, so it cannot make oriented caps). Foam's structure is
 *   CELLULAR AND TORN: a bubble raft is a packing, so its dark features are
 *   the thin WALLS between cells (a network of lines, not a field of dots),
 *   and its edges are ripped rather than convex.
 *
 * So the two things this file makes that noise cannot:
 *   1. a WORLEY WALL NETWORK — |F2 − F1| of a jittered point set is thin
 *      curved lines meeting at junctions, which is what a bubble raft's wet
 *      interstices actually are;
 *   2. DOMAIN-WARPED contours — warping the coordinate before the noise turns
 *      convex contours into meandering, pinching, tendrilled ones. That is
 *      what makes a foam patch's edge read as torn instead of as a blur's
 *      level set.
 *
 * Three-free on purpose (same split as ship/deckHeightfield vs
 * ship/deckFieldTexture): the statistics below are asserted in vitest with no
 * GPU, and the three wrapper is foamTexture.ts.
 *
 * SEAMLESS BY CONSTRUCTION. Every lattice index and every worley cell index is
 * wrapped modulo its own integer frequency, so the field is periodic on the
 * unit square. It is sampled with RepeatWrapping over an unbounded ocean, so a
 * seam would draw a grid across the whole sea — the same failure the foam sim
 * textures avoid by tiling with their cascade domain.
 */

/** RGBA channel meanings — see the per-channel builders below */
export const FOAM_CHANNEL = {
  /** R: crest lace, the HIGH-frequency texture at the crest of the wave */
  crest: 0,
  /** G: soft mottle, the LOW-frequency texture it blends out to */
  soft: 1,
  /** B: dissolve threshold — uniform on [0,1], mean exactly 0.5 */
  breakup: 2,
  /** A: relief height of the foam's own surface */
  relief: 3,
} as const;

/**
 * Worley cells per unit tile in the BREAKUP channel. Exported because the
 * shader needs it: the world size of one dissolve feature is
 * `repeatMetres / FOAM_BREAKUP_CELLS`, and §V.48 is measured against the
 * FEATURE's width, never against the repeat (§B.20 was 12× too late for
 * exactly this reason).
 */
export const FOAM_BREAKUP_CELLS = 14;

/**
 * Base fbm cells per unit tile in the SOFT channel — the coarsest feature in
 * the whole composite, and therefore the one the far-field detail backstop is
 * measured against.
 */
export const FOAM_SOFT_CELLS = 3;

/* ---------------------------------------------------------------- lattice */

/** integer hash → [0,1). Two rounds of xorshift-multiply; no float error path */
function hash2i(x: number, y: number, seed: number): number {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 2246822519;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** positive modulo — lattice indices go negative at the tile's lower edge */
function wrapi(i: number, n: number): number {
  return ((i % n) + n) % n;
}

/** the cubic Hermite ease, 3t²−2t³ — same curve TSL's `smoothstep` uses */
function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Value noise on [0,1)² at an INTEGER frequency, periodic on the unit square.
 * The integer frequency is what makes it tile: lattice cell `freq` is cell 0.
 */
export function tiledValueNoise(
  x: number,
  y: number,
  freq: number,
  seed: number,
): number {
  const fx = x * freq;
  const fy = y * freq;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const wx = fade(fx - x0);
  const wy = fade(fy - y0);
  const i0 = wrapi(x0, freq);
  const i1 = wrapi(x0 + 1, freq);
  const j0 = wrapi(y0, freq);
  const j1 = wrapi(y0 + 1, freq);
  const top = hash2i(i0, j0, seed) * (1 - wx) + hash2i(i1, j0, seed) * wx;
  const bot = hash2i(i0, j1, seed) * (1 - wx) + hash2i(i1, j1, seed) * wx;
  return top + (bot - top) * wy;
}

/** octave sum of {@link tiledValueNoise}; every octave frequency stays integer */
export function tiledFbm(
  x: number,
  y: number,
  baseFreq: number,
  octaves: number,
  seed: number,
): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = baseFreq;
  for (let i = 0; i < octaves; i++) {
    sum += amp * tiledValueNoise(x, y, f, seed + i * 1013);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/**
 * Worley/cellular distances on [0,1)², periodic on the unit square.
 * Returns the two nearest feature-point distances IN TILE UNITS (so a cell is
 * 1/cells across). `f2 − f1` is the CELL WALL — small on the boundary between
 * two cells, large at a cell's centre — and that network of thin lines is the
 * one thing a value noise cannot produce.
 */
export function tiledWorley(
  x: number,
  y: number,
  cells: number,
  seed: number,
): { f1: number; f2: number } {
  const fx = x * cells;
  const fy = y * cells;
  const cx = Math.floor(fx);
  const cy = Math.floor(fy);
  let f1 = Infinity;
  let f2 = Infinity;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const gx = cx + dx;
      const gy = cy + dy;
      // the JITTER is looked up at the wrapped index (so the tile is periodic)
      // while the POSITION uses the unwrapped one (so distances stay local)
      const wx = wrapi(gx, cells);
      const wy = wrapi(gy, cells);
      const px = gx + hash2i(wx, wy, seed);
      const py = gy + hash2i(wx, wy, seed + 7919);
      const ex = px - fx;
      const ey = py - fy;
      const d = Math.sqrt(ex * ex + ey * ey);
      if (d < f1) {
        f2 = f1;
        f1 = d;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  return { f1: f1 / cells, f2: f2 / cells };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * smoothstep(e0, e1, v) — argument order matches TSL's functional form (§V23).
 *
 * @band-limited-elsewhere — and this marker covers every use of it in this
 * file, so read the reason once. §V.48 is about a threshold evaluated PER
 * SCREEN PIXEL with no idea how big a pixel is. Nothing here runs in a shader:
 * this is a CPU texture generator, its coordinate is a texel of a fixed 256²
 * grid, and its output is band-limited by the MIP CHAIN built from it
 * (foamTexture.ts sets LinearMipmapLinearFilter + generateMipmaps, which is
 * §V.48's cure done by the hardware, including the fade-to-own-mean half).
 * The screen-space gates that CONSUME these channels are in foamShading.ts and
 * every one of them carries its own `fwidth`. Widening these edges by a
 * screen footprint would be meaningless — there is no screen here — and
 * narrowing them is what makes foam read as foam rather than as blur.
 */
function smoothstep(e0: number, e1: number, v: number): number {
  if (!(e1 > e0)) return v >= e1 ? 1 : 0;
  return fade(clamp01((v - e0) / (e1 - e0)));
}

/* ---------------------------------------------------------------- channels */

/**
 * A PERIODIC domain warp — the one operation that turns convex level sets into
 * torn ones, and the one that keeps a jittered point set from reading as the
 * grid it was jittered from.
 *
 * Both uses matter here and the second is the one that nearly got away.
 * §B.33(d) is this project's own record of it: "THE ANTI-LATTICE FIELD WAS A
 * LATTICE" — a value-noise field put its maxima near its own cells and became
 * the ~25 m grid it existed to break. A worley point set has the same defect
 * with a shorter memory: one jittered point per cell means the cell CENTRES
 * are quasi-regular however random the jitter looks, measured in the first
 * render of this texture as a visible polygon mosaic in the breakup channel.
 * Warping the LOOKUP coordinate bends those cells into each other and the
 * regularity goes.
 *
 * Periodicity survives by construction: f and w are both 1-periodic, so
 * f(x+1 + w(x+1)) = f(x+1 + w(x)) = f(x + w(x)). The tile still tiles.
 */
function warp(
  x: number,
  y: number,
  amp: number,
  freq: number,
  seed: number,
): { x: number; y: number } {
  return {
    x: x + amp * (tiledFbm(x, y, freq, 2, seed) - 0.5),
    y: y + amp * (tiledFbm(x, y, freq, 2, seed + 4441) - 0.5),
  };
}

/** every channel of one texel, sharing the lookups they have in common */
export interface FoamPatternSample {
  /** R: crest lace — the high-frequency texture at the breaking crest */
  crest: number;
  /** G: soft mottle — the low-frequency one it blends out to */
  soft: number;
  /** B: dissolve threshold, PRE-normalisation (the caller ranks it) */
  breakup: number;
  /** A: the foam's own relief height */
  relief: number;
}

/**
 * One texel of all four channels.
 *
 * ONE function rather than four because the crest lace and the relief share
 * the fine bubble raft — the relief must be the HEIGHT OF THE SAME BUBBLES the
 * lace draws, or a normal map built from it would light structure that is not
 * in the albedo. Sharing the lookup makes that true by construction instead of
 * by two constants agreeing (§V.37's lesson: mating pieces share their
 * sampling constants).
 */
export function sampleFoamPattern(x: number, y: number): FoamPatternSample {
  // ── the bubble raft, warped so it is a packing and not a honeycomb ──
  const wr = warp(x, y, 0.09, 6, 1601);
  const big = tiledWorley(wr.x, wr.y, 26, 1117);
  const fine = tiledWorley(wr.x, wr.y, 52, 2237);
  // wall width scaled by the cell size so both densities draw a line of
  // comparable RELATIVE thickness rather than the fine one drawing a smear.
  // @band-limited-elsewhere — reason at `smoothstep` above (texel space + mips)
  const wallBig = 1 - smoothstep(0, 0.34 / 26, big.f2 - big.f1);
  const wallFine = 1 - smoothstep(0, 0.30 / 52, fine.f2 - fine.f1);
  const walls = Math.max(wallBig * 0.8, wallFine * 0.55);
  // TORN GAPS. Warped hard (0.42) and at a frequency close to the raft's own,
  // because the first render had these as large round holes — which is the
  // "blotchy" defect reappearing INSIDE the texture that exists to cure it.
  const wt = warp(x, y, 0.42, 5, 3331);
  const torn = tiledFbm(wt.x, wt.y, 9, 3, 5557);
  // @band-limited-elsewhere — reason at `smoothstep` above (texel space + mips)
  const raft = smoothstep(0.34, 0.56, torn);
  // bubble domes catch a little extra light at their centres
  const dome = clamp01(fine.f1 * 52 * 1.6);
  const crest = clamp01((1 - 0.18 * dome) * (1 - 0.55 * walls) * (0.25 + 0.75 * raft));

  // ── the slick the lace blends out to: broad, no cellular structure ──
  const n = tiledFbm(x, y, FOAM_SOFT_CELLS, 4, 6661);
  // @band-limited-elsewhere — reason at `smoothstep` above (texel space + mips)
  const soft = clamp01(0.527 + 0.47 * smoothstep(0.2, 0.85, n));

  // ── the dissolve threshold: warped fbm, ridged where cells meet ──
  // The ridge weight is 0.12, down from 0.38 across two renders: at 0.38 the
  // worley won outright and the channel read as a polygon mosaic (foam would
  // have dissolved into shards), and at 0.22 its wall lines still dominated
  // after the rank stretch, because `ridge` is mostly saturated with thin dark
  // seams — so ranking hands those seams the whole bottom of the range. The
  // warped fbm is the field that meanders and pinches; the ridge only adds
  // junctions. The base frequency is 8 rather than 5 and the warp is 0.26 at
  // freq 5 rather than 0.45 at freq 3 for the same reason one level up: strong
  // low-frequency content makes the TILE itself legible, and this texture
  // repeats every 6 m at the crest scale.
  const wb = warp(x, y, 0.26, 5, 7771);
  const nb = tiledFbm(wb.x, wb.y, 8, 4, 9991);
  const wc = warp(x, y, 0.16, 5, 2113);
  const c = tiledWorley(wc.x, wc.y, FOAM_BREAKUP_CELLS, 1229);
  const ridge = clamp01(((c.f2 - c.f1) * FOAM_BREAKUP_CELLS) / 0.6);
  const breakup = 0.88 * nb + 0.12 * ridge;

  // ── relief: the SAME bubbles the lace draws, over broad clumps ──
  const clump = tiledFbm(x, y, 5, 3, 1483);
  const relief = clamp01(0.25 + 0.45 * clump + 0.35 * clamp01(1 - fine.f1 * 52 * 1.9));

  return { crest, soft, breakup, relief };
}

/* ------------------------------------------------------------------ build */

/**
 * Build the packed RGBA8 foam art texture data, row-major, `n × n`.
 *
 * ONE texture, four channels, because the whole budget is two samplers
 * (§V.40) and a channel-packed RGBA buys four fields for one of them. Sampling
 * it at two different world scales costs nothing extra: bindings dedupe by
 * texture UUID, so the crest lookup and the soft lookup are one binding and
 * one sampler between them.
 */
export function buildFoamPattern(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 8 || (n & (n - 1)) !== 0) {
    throw new Error(`foam art texture: size must be a power of two ≥ 8, got ${n}`);
  }
  const count = n * n;
  const data = new Uint8Array(count * 4);
  const breakup = new Float32Array(count);
  for (let y = 0; y < n; y++) {
    // texel CENTRES: sampling the field at the texel corner puts the last row
    // one full texel from the first, so the tile would not be periodic at the
    // sample points even though the field is
    const v = (y + 0.5) / n;
    for (let x = 0; x < n; x++) {
      const u = (x + 0.5) / n;
      const i = y * n + x;
      const s = sampleFoamPattern(u, v);
      data[i * 4 + FOAM_CHANNEL.crest] = Math.round(255 * s.crest);
      data[i * 4 + FOAM_CHANNEL.soft] = Math.round(255 * s.soft);
      data[i * 4 + FOAM_CHANNEL.relief] = Math.round(255 * s.relief);
      breakup[i] = s.breakup;
    }
  }
  const ranked = rankNormalise(breakup);
  for (let i = 0; i < count; i++) {
    data[i * 4 + FOAM_CHANNEL.breakup] = Math.round(255 * ranked[i]);
  }
  return data;
}

/**
 * Map a field onto EXACTLY uniform [0,1] by rank, in place of a min/max
 * stretch.
 *
 * A stretch leaves the histogram alone, so the field's mean is whatever the
 * generator's shape happened to give — and the mean of the dissolve threshold
 * IS the net coverage change the erosion applies. An unmeasured mean means
 * turning the art texture on silently moves foam coverage, which is the one
 * quantity five separate user reports have been about. Rank-normalising pins
 * it at 0.5 by construction and makes the survival probability of a texel with
 * mask value m exactly m/depth, which is what lets the sub-pixel limit be a
 * plain ramp rather than a fitted curve (§V.48b).
 */
export function rankNormalise(values: Float32Array): Float32Array {
  const n = values.length;
  const idx = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => values[a] - values[b],
  );
  const out = new Float32Array(n);
  // (rank + 0.5)/n rather than rank/(n−1): midpoints of the n equal quantile
  // bins, so the mean is exactly 0.5 and neither endpoint is over-represented
  for (let r = 0; r < n; r++) out[idx[r]] = (r + 0.5) / n;
  return out;
}
