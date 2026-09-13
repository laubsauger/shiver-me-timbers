/**
 * SWELL SHADOW IN ISLAND LEE (T174) — the remotely generated swell train does
 * not regrow behind land, so an island must leave a calm wake in it.
 *
 * Design, formula, sources and costs: docs/ocean/swell-shadow.md. In one line:
 * a diffraction coefficient K is marched downswell with lateral variance
 * σ² = σθ²·x² + π·x/k (directional spread + Fresnel-zone diffraction), and each
 * cascade's SWELL SHARE fᵢ is scaled by K² while its wind-sea share passes
 * untouched — wind sea in a lee is `fetch.ts`'s job, and two models describing
 * the same waves in the same place is §V.77 in physics form.
 *
 * §V.8 / §V.77 — THE TRANSLITERATION PAIR. `swellShadowGain` and
 * `swellShadowGainNode` are the ONE expression the drawn sea
 * (`surfaceMaterial.ts`) and the floated sea (`sea-physics/cpuOcean.ts`)
 * multiply into each cascade. Same convention as `fetch.ts`, `shoaling.ts`.
 *
 * §V.23: 1- and 2-arg math only. §V.28: every divisor floored.
 */
import { float } from 'three/tsl';
import {
  cascadeBand,
  swellBandSigma,
  swellEffectiveDirectionality,
  swellPeakWavenumber,
} from './oceanMath';
import { normalCdf } from '../foam/foamMath';
import type { OceanParams } from '../params/ocean';
import type { FetchSource } from './fetch';

/** any TSL node — structural, not typed (file-local convention) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNode = any;

const EPS = 1e-9;

/**
 * K snap. The baked K of open water is exactly 1, but a GPU bilinear fetch of
 * four half-float 1.0 texels is not guaranteed to be 1.0 bit for bit. Dividing
 * by (1 − SNAP) and clamping lands every K ≥ 0.999 on EXACTLY 1, on both sides,
 * which is what makes the open sea bit-identical rather than "within 1e-7".
 * The price is a 0.1% lift of K inside a shadow, far below half-float's own
 * quantisation step near 1.
 */
export const SWELL_SHADOW_SNAP = 1e-3;

/** what `CpuOcean` needs from a shelter source that also carries the shadow */
export interface SwellShadowSource {
  /** diffraction coefficient K ∈ [0, 1] of the swell at a world XZ; 1 = open */
  shadowAt(x: number, z: number): number;
}

/** a fetch source that may or may not carry the swell shadow (tests pass bare ones) */
export type ShelterSource = FetchSource & Partial<SwellShadowSource>;

/**
 * THE GAIN on a cascade's displacement: √(1 − f·(1 − K'²)).
 *
 * Energy bookkeeping: the wind-sea share (1 − f) is untouched, the swell share
 * f is scaled by K². Exactly 1 when K' = 1 (open water) or f = 0 (no swell in
 * this band, strength 0) — `1 − f·0` and `√1` are exact in IEEE arithmetic.
 */
export function swellShadowGain(share: number, k: number): number {
  // NaN K is "no information" → open sea, never a NaN sea (§V.28)
  const kk = Number.isFinite(k) ? Math.min(Math.max(k, 0) / (1 - SWELL_SHADOW_SNAP), 1) : 1;
  return Math.sqrt(Math.max(1 - share * (1 - kk * kk), 0));
}

/** TSL twin of `swellShadowGain`, operation for operation in the same order */
export function swellShadowGainNode(uShare: AnyNode, k: AnyNode): AnyNode {
  const kk = float(k).max(0).div(1 - SWELL_SHADOW_SNAP).min(1);
  return float(1).sub(float(uShare).mul(float(1).sub(kk.mul(kk)))).max(0).sqrt();
}

/**
 * fᵢ — fraction of cascade `index`'s height variance that is SWELL, times the
 * live `swellShadowStrength`. Analytic: `swellSpectrum`'s radial factor is a
 * Gaussian in k once its 1/k meets the k·dk Jacobian, so the band's slice of
 * A² is a difference of two normal CDFs. `bandVariance` is the cascade's
 * measured `heightVariance` from the SAME spectrum snapshot on both sides.
 */
export function swellBandShare(p: OceanParams, index: number, bandVariance: number): number {
  if (!(p.swellAmplitude > 0)) return 0;
  const strength = Math.min(Math.max(p.swellShadowStrength, 0), 1);
  if (!(strength > 0)) return 0;
  const band = cascadeBand(index, p.splitWavelengths);
  const kp = swellPeakWavenumber(p.swellPeriod);
  const sk = Math.max(swellBandSigma(p), EPS);
  const hi = band.kMax === Infinity ? 1 : normalCdf((band.kMax - kp) / sk);
  const lo = normalCdf((band.kMin - kp) / sk);
  const swellVar = p.swellAmplitude * p.swellAmplitude * Math.max(hi - lo, 0);
  const share = swellVar / Math.max(bandVariance, EPS);
  return Math.min(Math.max(share, 0), 1) * strength;
}

/**
 * σθ (rad) of the swell as DRAWN: cos^n θ has angular variance ≈ 1/n, and n is
 * the grid-ceiled `swellEffectiveDirectionality`, not the authored number.
 * Capped at 1 rad — past that the spread is effectively isotropic.
 */
export function swellShadowSpread(p: OceanParams): number {
  return 1 / Math.sqrt(Math.max(swellEffectiveDirectionality(p), 1));
}

/** the three numbers the bake depends on — the rebuild key */
export interface SwellShadowInputs {
  direction: number;
  wavenumber: number;
  spread: number;
}

export function swellShadowInputs(p: OceanParams): SwellShadowInputs {
  return {
    direction: p.swellDirection,
    wavenumber: swellPeakWavenumber(p.swellPeriod),
    spread: swellShadowSpread(p),
  };
}

/**
 * Lateral blur of one row with a PER-CELL variance `s[c]` (cells²), clamp-to-
 * edge. Exact variance, O(N) regardless of width:
 *  · s < 2/3: 3-tap [a, 1−2a, a] with a = s/2, written e + a·(l − 2e + r) so a
 *    row of ones stays EXACTLY ones;
 *  · else: blend of the integer box radii r, r+1 bracketing s (a box of radius
 *    r has variance r(r+1)/3), from prefix sums, again as B_r + (B_r1 − B_r)·t.
 * At s = 2/3 both branches are the radius-1 box, so the switch has no seam.
 */
function blurRow(
  src: Float32Array,
  base: number,
  n: number,
  s: Float32Array,
  out: Float32Array,
  outBase: number,
  prefix: Float64Array,
): void {
  prefix[0] = 0;
  for (let c = 0; c < n; c++) prefix[c + 1] = prefix[c] + src[base + c];
  const first = src[base];
  const last = src[base + n - 1];
  /** Σ src[clamp(j)] for j ∈ [c−r, c+r] */
  const boxSum = (c: number, r: number): number => {
    const lo = c - r;
    const hi = c + r;
    const loC = lo < 0 ? 0 : lo;
    const hiC = hi > n - 1 ? n - 1 : hi;
    let sum = prefix[hiC + 1] - prefix[loC];
    if (lo < 0) sum += -lo * first;
    if (hi > n - 1) sum += (hi - (n - 1)) * last;
    return sum;
  };
  for (let c = 0; c < n; c++) {
    const v = s[c];
    const e = src[base + c];
    if (!(v > 0)) {
      out[outBase + c] = e;
    } else if (v < 2 / 3) {
      const l = c > 0 ? src[base + c - 1] : first;
      const rr = c < n - 1 ? src[base + c + 1] : last;
      out[outBase + c] = e + (v / 2) * (l - 2 * e + rr);
    } else {
      // largest r with r(r+1)/3 ≤ v
      let r = Math.floor((-1 + Math.sqrt(1 + 12 * v)) / 2);
      if (r < 1) r = 1;
      if (r > n) r = n;
      const vr = (r * (r + 1)) / 3;
      const t = Math.min(Math.max((v - vr) / ((2 * r + 2) / 3), 0), 1);
      const br = boxSum(c, r) / (2 * r + 1);
      const br1 = boxSum(c, r + 1) / (2 * r + 3);
      out[outBase + c] = br + (br1 - br) * t;
    }
  }
}

/**
 * How much lateral offset counts toward a penumbra column's "distance behind
 * the obstacle". It must be > 0 (see the march) and small: a gather blur whose
 * radius grows across a shadow edge is not conservative, and the column just
 * outside a shadow should blur like the shadow it borders. MEASURED on a
 * 300 m strip, spread-only, deficit ∫(1−K)dv at 300 / 1200 / 4800 m downswell
 * (conserved value ≈ 300–320 m, the bilinear strip):
 *     weight 1     389 / 512 / 701 m
 *     weight 0.25  331 / 359 / 394 m
 *     weight 0.1   320 / 331 / 344 m   ← and K within 0.02 of the closed form
 * Far columns keep x ≥ 0.1·y, so their per-row radius √(6σθ²·0.1y·Δ) stays
 * ≪ y (87 m at y = 3 km): the kilometre-scale leak cannot come back.
 */
const LATERAL_WEIGHT = 0.1;

/** scratch the march reuses across rebuilds (sized to the rotated grid) */
export interface SwellShadowScratch {
  nr: number;
  land: Float32Array;
  k: Float32Array;
  x: Float32Array;
  s: Float32Array;
  prefix: Float64Array;
}

export function swellShadowScratch(nr: number): SwellShadowScratch {
  return {
    nr,
    land: new Float32Array(nr * nr),
    k: new Float32Array(nr * nr),
    x: new Float32Array(nr),
    s: new Float32Array(nr),
    prefix: new Float64Array(nr + 1),
  };
}

/**
 * Rotated-grid cells per axis to cover a square field of `res` cells at any
 * bearing, when one march cell spans `stride` field cells.
 */
export function swellShadowGridSize(res: number, stride = SWELL_SHADOW_STRIDE): number {
  return Math.ceil((res * Math.SQRT2) / Math.max(1, stride)) + 2;
}

/**
 * Field cells per march cell. 2, and it is the band limit rather than a
 * shortcut: the finished field is box-blurred by `fetchBlurTexels` (3 texels,
 * ~90 m at the shipped archipelago) for §V.48, so a march finer than ~2 texels
 * resolves detail the blur deletes. Cost is quadratic in it — MEASURED at
 * 512², one 300 m islet: stride 1 = 17 ms, stride 2 = see the report.
 */
export const SWELL_SHADOW_STRIDE = 2;

/**
 * THE MARCH, as a free function over plain arrays (testable without a GPU).
 *
 * `land` is the field's res×res mask (non-zero blocks), texel centres at
 * (i + 0.5)·cell. `out` receives K on the same grid. `direction` is where the
 * swell TRAVELS (same convention as `swellSpectrum`: (cos θ, sin θ) → (x, z)).
 * `k` is the swell's wavenumber (rad/m), `spread` its σθ (rad).
 *
 * A grid rotated onto the swell is marched row by row downswell (no numerical
 * diffusion from sub-cell advection: every row steps exactly one cell), then
 * resampled bilinearly back. See docs/ocean/swell-shadow.md for the recurrence.
 */
export function marchSwellShadow(
  land: Uint8Array,
  res: number,
  cell: number,
  inputs: SwellShadowInputs,
  out: Float32Array,
  scratch: SwellShadowScratch = swellShadowScratch(swellShadowGridSize(res)),
  stride = SWELL_SHADOW_STRIDE,
): void {
  const { direction, wavenumber, spread } = inputs;
  // §V.28: a NaN bearing or a dead wavenumber must not become a NaN sea
  if (!Number.isFinite(direction) || !(wavenumber > 0) || !Number.isFinite(spread)) {
    out.fill(1);
    return;
  }
  const nr = scratch.nr;
  // one march cell, metres — `cell` stays the FIELD's texel below
  const cr = cell * Math.max(1, stride);
  if (nr < swellShadowGridSize(res, stride)) {
    throw new Error(`marchSwellShadow: scratch ${nr} too small for res ${res} stride ${stride}`);
  }
  const sx = Math.cos(direction);
  const sz = Math.sin(direction);
  // lateral axis n̂ = (−sin, cos)
  const half = (res * cell) / 2; // field centre offset from its own corner
  const halfR = (nr * cr) / 2;
  const sigma = Math.min(Math.max(spread, 0), 1);
  const diffract = Math.PI / Math.max(wavenumber, EPS);
  const cellSq = cr * cr;
  const xCap = nr * cr;

  // ── land into the rotated frame (bilinear of the binary mask → soft edge) ──
  const L = scratch.land;
  for (let a = 0; a < nr; a++) {
    const u = -halfR + (a + 0.5) * cr;
    for (let c = 0; c < nr; c++) {
      const v = -halfR + (c + 0.5) * cr;
      // world offset from the field centre, then field-grid coords
      const fx = (u * sx - v * sz + half) / cell - 0.5;
      const fz = (u * sz + v * sx + half) / cell - 0.5;
      const i0 = Math.floor(fx);
      const j0 = Math.floor(fz);
      let val = 0;
      if (i0 >= -1 && j0 >= -1 && i0 < res && j0 < res) {
        const tx = fx - i0;
        const tz = fz - j0;
        // outside the field is open water (0); no closures in this loop — it
        // runs (√2·res)² times per march
        const in0 = i0 >= 0;
        const in1 = i0 + 1 < res;
        const r0 = j0 >= 0 ? j0 * res : -1;
        const r1 = j0 + 1 < res ? (j0 + 1) * res : -1;
        const m00 = r0 >= 0 && in0 && land[r0 + i0] ? 1 : 0;
        const m10 = r0 >= 0 && in1 && land[r0 + i0 + 1] ? 1 : 0;
        const m01 = r1 >= 0 && in0 && land[r1 + i0] ? 1 : 0;
        const m11 = r1 >= 0 && in1 && land[r1 + i0 + 1] ? 1 : 0;
        if (m00 | m10 | m01 | m11) {
          const top = m00 + (m10 - m00) * tx;
          const bot = m01 + (m11 - m01) * tx;
          val = top + (bot - top) * tz;
        }
      }
      L[a * nr + c] = val;
    }
  }

  // ── the march ──────────────────────────────────────────────────────────────
  const K = scratch.k;
  const X = scratch.x;
  const S = scratch.s;
  // `open`: every K of the previous row is exactly 1 — nothing to blur. Rows
  // upswell of all land (most of the grid for most bearings) skip the blur.
  let open = true;
  for (let c = 0; c < nr; c++) {
    const b = L[c];
    K[c] = 1 - b;
    X[c] = b >= 0.5 ? 0 : xCap;
    if (b > 0) open = false;
  }
  for (let a = 1; a < nr; a++) {
    const row = a * nr;
    if (open) {
      let landHere = false;
      for (let c = 0; c < nr; c++) {
        const b = L[row + c];
        K[row + c] = 1 - b;
        X[c] = b >= 0.5 ? 0 : xCap;
        if (b > 0) landHere = true;
      }
      open = !landHere;
      continue;
    }
    /**
     * x = distance to the nearest upswell land, measured (rows back) +
     * LATERAL_WEIGHT·(distance across) — one step downswell, then a lateral
     * distance transform both ways within the row. The lateral half is
     * load-bearing: the blur below GATHERS with each cell's own radius, and a
     * lit column that had never "seen" land would otherwise take the largest
     * radius in the grid and pull the shadow sideways by kilometres (measured:
     * a 300 m islet's deficit ∫(1−K)dv grew 5× within 300 m).
     */
    for (let c = 0; c < nr; c++) {
      X[c] = L[row + c] >= 0.5 ? 0 : Math.min(X[c] + cr, xCap);
    }
    const lat = cr * LATERAL_WEIGHT;
    for (let c = 1; c < nr; c++) if (X[c - 1] + lat < X[c]) X[c] = X[c - 1] + lat;
    for (let c = nr - 2; c >= 0; c--) if (X[c + 1] + lat < X[c]) X[c] = X[c + 1] + lat;
    for (let c = 0; c < nr; c++) {
      // lateral variance this row adds, in cells²
      S[c] = (cr * (2 * sigma * sigma * X[c] + diffract)) / cellSq;
    }
    blurRow(K, row - nr, nr, S, K, row, scratch.prefix);
    for (let c = 0; c < nr; c++) {
      const b = L[row + c];
      if (b > 0) K[row + c] *= 1 - b;
    }
  }

  // ── back onto the field grid ────────────────────────────────────────────────
  for (let j = 0; j < res; j++) {
    const oz = (j + 0.5) * cell - half;
    for (let i = 0; i < res; i++) {
      const ox = (i + 0.5) * cell - half;
      const u = ox * sx + oz * sz;
      const v = -ox * sz + oz * sx;
      const fa = (u + halfR) / cr - 0.5;
      const fc = (v + halfR) / cr - 0.5;
      const a0 = Math.floor(fa);
      const c0 = Math.floor(fc);
      const ta = fa - a0;
      const tc = fc - c0;
      const a0c = (a0 < 0 ? 0 : a0 > nr - 1 ? nr - 1 : a0) * nr;
      const a1c = (a0 + 1 < 0 ? 0 : a0 + 1 > nr - 1 ? nr - 1 : a0 + 1) * nr;
      const c0c = c0 < 0 ? 0 : c0 > nr - 1 ? nr - 1 : c0;
      const c1c = c0 + 1 < 0 ? 0 : c0 + 1 > nr - 1 ? nr - 1 : c0 + 1;
      const p = K[a0c + c0c];
      const q = K[a0c + c1c];
      const r = K[a1c + c0c];
      const s = K[a1c + c1c];
      const top = p + (q - p) * tc;
      const bot = r + (s - r) * tc;
      const k = top + (bot - top) * ta;
      out[j * res + i] = k > 0 ? (k < 1 ? k : 1) : 0;
    }
  }
}

/**
 * Fade K to exactly 1 over `width` metres inside the field border, so the
 * clamp-to-edge sampler cannot extend a truncated shadow to the horizon.
 * `1 − (1 − K)·w` keeps open water exactly 1 and the border ring exactly 1.
 */
export function fadeShadowBorder(
  data: Float32Array,
  res: number,
  cell: number,
  width: number,
): void {
  const w = Math.max(width, cell);
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const d = Math.min(i, j, res - 1 - i, res - 1 - j) * cell;
      if (d >= w) continue;
      const t = d / w;
      const ramp = t * t * (3 - 2 * t);
      const k = j * res + i;
      data[k] = 1 - (1 - data[k]) * ramp;
    }
  }
}
