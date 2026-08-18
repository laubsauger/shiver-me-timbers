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
} as const;

/**
 * A IS UNUSED, AND THAT IS A DECISION RATHER THAN AN OVERSIGHT.
 *
 * It used to hold a "relief height", generated at every startup and read by
 * NOTHING — `foamShading` samples `.r`, `.g` and `.b` and there has never been
 * a fourth consumer. Its own comment defended a normal map that does not
 * exist, which is worse than the waste: it would have told the next reader the
 * albedo and the relief were kept in step for a lighting term nobody wrote.
 *
 * §T.42 (foam composites as albedo only — no normal, no roughness — which is
 * the mechanical cause of "painted on / not three-dimensional") is real and
 * still open, but a relief TEXTURE is not its fix. The cheap route is to
 * finite-difference the already-thresholded foam mask: 2 extra taps of a
 * texture already sampled, no new binding, and the normal then matches the
 * mask the dissolve actually produced instead of a height authored beside it.
 * That change lives in the surface material's lighting, so it waits for that
 * file. Left at a constant here rather than filled with something plausible,
 * so it cannot be mistaken for a signal.
 */
export const FOAM_UNUSED_ALPHA = 255;

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

/**
 * Worley cells per unit tile in the CREST lace's bubble raft. ONE density is
 * exported and used: the fine network at 2× this is a highlight only, never a
 * second wall network — see sampleFoamPattern.
 */
export const RAFT_CELLS = 26;

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
}

/**
 * One texel of all four channels.
 *
 * ONE function rather than three because the channels share lookups — the
 * crest lace's two worley densities are one warped coordinate between them, so
 * the highlight and the wall can never disagree about where a bubble is
 * (§V.37: mating pieces share their sampling constants).
 */
export function sampleFoamPattern(x: number, y: number): FoamPatternSample {
  /* ── the bubble raft: ONE wall network, in BROKEN SEGMENTS ──────────────
   *
   * A WARPED VORONOI IS STILL A VORONOI (§B, user: "one layer has a very very
   * visible Voronoi or similar-to-Voronoi pattern"). This is §B.39's real
   * lesson one level deeper than it was first applied. Warping bends cell
   * walls; it does not stop them being a NETWORK OF WALLS MEETING AT
   * JUNCTIONS, and that network is what the eye names. Measured before the
   * rewrite: the warp was shearing correctly (26–70% differential across one
   * cell), so "the warp is too weak" was refuted, not untested — the generator
   * was simply the wrong shape, exactly as value noise was.
   *
   * Real foam lace is BROKEN ARCS THAT TERMINATE, not a tessellation. Three
   * changes make it one:
   *  1. ONE network, not two. `max(wallBig, wallFine)` overlaid two COMPLETE
   *     tessellations at 26 and 52 cells, which is what made the cell
   *     structure unmistakable — you could see both nested polygon webs.
   *  2. A SEGMENT FIELD kills the wall over part of its length, so lace ends
   *     in mid-air instead of closing every cell. This is the whole cure: a
   *     complete boundary graph reads as Voronoi at any warp amplitude, and an
   *     incomplete one cannot.
   *  3. The WARP RUNS AT THE CELL FREQUENCY, not 4–8× below it. At freq 6
   *     against 26/52 cells it was coherent over several cells and merely
   *     rotated groups of them into rosettes — which is the user's "very
   *     visible circular ringed pattern", the term meant to DISORGANISE
   *     imposing its own order (§B.33(d)'s shape, one file over).
   */
  const wr = warp(x, y, 0.030, 13, 1601);
  const big = tiledWorley(wr.x, wr.y, RAFT_CELLS, 1117);
  const fine = tiledWorley(wr.x, wr.y, RAFT_CELLS * 2, 2237);
  // wall width scaled by the cell size so the line keeps a constant RELATIVE
  // thickness rather than the density deciding how heavy it draws
  // @band-limited-elsewhere — reason at `smoothstep` above (texel space + mips)
  const wallRaw = 1 - smoothstep(0, 0.24 / RAFT_CELLS, big.f2 - big.f1);
  // the segment field varies over ~one cell (it runs AT the cell frequency),
  // so a given wall is present for a stretch and gone for the next
  const seg = tiledFbm(wr.x, wr.y, RAFT_CELLS, 2, 4507);
  // @band-limited-elsewhere — reason at `smoothstep` above (texel space + mips)
  const walls = wallRaw * smoothstep(0.46, 0.74, seg);
  // TORN GAPS. Higher base frequency and a much weaker warp than the first
  // render: at 0.42/f5 the warp's own low frequency made the 6 m TILE legible
  // (measured — the same dark cluster twice in a 14 m patch), which is a
  // second-order version of the rosette defect above.
  const wt = warp(x, y, 0.18, 9, 3331);
  const torn = tiledFbm(wt.x, wt.y, 15, 3, 5557);
  // @band-limited-elsewhere — reason at `smoothstep` above (texel space + mips)
  const raft = smoothstep(0.42, 0.66, torn);
  // bubble domes catch a little extra light at their centres. The FINE worley
  // survives only as this — a highlight at a point, not a second wall network.
  const dome = clamp01(fine.f1 * RAFT_CELLS * 2 * 1.6);
  const crest = clamp01((1 - 0.12 * dome) * (1 - 0.42 * walls) * (0.18 + 0.82 * raft));

  // ── the slick the lace blends out to: broad, no cellular structure ──
  // WARPED, and it is the last channel to get it. Unwarped `tiledFbm` is value
  // noise with ROUND LEVEL SETS — §B.39 verbatim, surviving untouched in the
  // one channel the original cure never reached, and measured as the "blotch
  // itself is not organic enough" half of the report.
  const ws = warp(x, y, 0.20, 7, 8123);
  const n = tiledFbm(ws.x, ws.y, FOAM_SOFT_CELLS, 4, 6661);
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
  //
  // The ridge's warp now runs AT its own cell frequency for the same reason
  // the raft's does — at freq 5 against 14 cells it rotated groups of cells
  // rather than distorting them, and the wall web read clearly through the fbm
  // despite carrying only 0.12 of the weight.
  const wb = warp(x, y, 0.22, 7, 7771);
  const nb = tiledFbm(wb.x, wb.y, 9, 4, 9991);
  const wc = warp(x, y, 0.045, FOAM_BREAKUP_CELLS, 2113);
  const c = tiledWorley(wc.x, wc.y, FOAM_BREAKUP_CELLS, 1229);
  const ridge = clamp01(((c.f2 - c.f1) * FOAM_BREAKUP_CELLS) / 0.6);
  const breakup = 0.9 * nb + 0.1 * ridge;

  return { crest, soft, breakup };
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
      data[i * 4 + 3] = FOAM_UNUSED_ALPHA;
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
