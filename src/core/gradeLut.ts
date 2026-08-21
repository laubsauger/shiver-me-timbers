/**
 * Colour grade — the CPU half (§T.101, §V.89).
 *
 * Everything the shader in `grade.ts` computes has a mirror here, in the same
 * order with the same constants, and the tests run against THIS file (§V.80,
 * no GPU). Two things depend on that being exact:
 *
 *  * `lutFromLgg` bakes the live LGG/split-tone into a LUT slot, so a look
 *    tuned on the sliders and then baked must render the same as the sliders
 *    did — `gradeCpu` IS the slider maths.
 *  * `sampleLutCpu` is the sampler: trilinear, with the half-texel offset
 *    that makes the identity LUT exact. The shader's coordinate transform is
 *    the same `rgb·(N−1)/N + 0.5/N` and the identity test (Δ < 1/255 over a
 *    9³ sweep) is the proof that the offset is right, which is the whole
 *    §V.89 invariant: a LUT that shifts greys by half a texel is the classic
 *    bug and it is invisible until a dark scene goes milky.
 *
 * Layouts. A LUT is `Float32Array(size³·3)`, RGB, R fastest then G then B:
 * `idx = (r + size·(g + size·b))·3`. That is exactly the texel order of a
 * `Data3DTexture(width=R, height=G, depth=B)`, so `lutToTexture` is a copy.
 * A STRIP is the PNG form under `assets/lut/`: width `size²`, height `size`,
 * pixel `(x = r + size·b, y = g)` — i.e. the B slices laid side by side, each
 * slice an R×G square. (Hald CLUTs fold the slices into a square instead;
 * the strip is kept flat so a slice can be read by eye.)
 */
import * as THREE from 'three/webgpu';
import { GRADE_SLOTS, type GradeSlot } from '../params/grade';

export const LUT_SIZE = 32;

/** Rec.709 luma, the same three numbers the shader uses */
export const LUMA = [0.2126, 0.7152, 0.0722] as const;

/** the subset of gradeParams the maths reads — tests build partials of it */
export interface LggParams {
  liftR: number;
  liftG: number;
  liftB: number;
  gammaR: number;
  gammaG: number;
  gammaB: number;
  gainR: number;
  gainG: number;
  gainB: number;
  saturation: number;
  splitPivot: number;
  splitSoftness: number;
  splitStrength: number;
  shadowTintR: number;
  shadowTintG: number;
  shadowTintB: number;
  highlightTintR: number;
  highlightTintG: number;
  highlightTintB: number;
}

export interface BandParams {
  dawnCentre: number;
  dawnHold: number;
  noonCentre: number;
  noonHold: number;
  duskCentre: number;
  duskHold: number;
  nightCentre: number;
  nightHold: number;
}

export const IDENTITY_LGG: LggParams = {
  liftR: 0, liftG: 0, liftB: 0,
  gammaR: 1, gammaG: 1, gammaB: 1,
  gainR: 1, gainG: 1, gainB: 1,
  saturation: 1,
  splitPivot: 0.5, splitSoftness: 0.25, splitStrength: 0,
  shadowTintR: 0.5, shadowTintG: 0.5, shadowTintB: 0.5,
  highlightTintR: 0.5, highlightTintG: 0.5, highlightTintB: 0.5,
};

/** §V.28 — every caller-fed number is finite before it is used */
export function fin(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
/** gamma and softness are divisors in the shader: same floors here */
export const GAMMA_FLOOR = 1e-3;
export const SOFTNESS_FLOOR = 1e-3;

/** the grade uniforms after the §V.28 guards, as the shader receives them */
export function guardedLgg(p: LggParams): LggParams {
  const d = IDENTITY_LGG;
  return {
    liftR: fin(p.liftR, d.liftR), liftG: fin(p.liftG, d.liftG), liftB: fin(p.liftB, d.liftB),
    gammaR: Math.max(fin(p.gammaR, 1), GAMMA_FLOOR),
    gammaG: Math.max(fin(p.gammaG, 1), GAMMA_FLOOR),
    gammaB: Math.max(fin(p.gammaB, 1), GAMMA_FLOOR),
    gainR: fin(p.gainR, 1), gainG: fin(p.gainG, 1), gainB: fin(p.gainB, 1),
    saturation: fin(p.saturation, 1),
    splitPivot: fin(p.splitPivot, 0.5),
    splitSoftness: Math.max(fin(p.splitSoftness, 0.25), SOFTNESS_FLOOR),
    splitStrength: fin(p.splitStrength, 0),
    shadowTintR: fin(p.shadowTintR, 0.5), shadowTintG: fin(p.shadowTintG, 0.5), shadowTintB: fin(p.shadowTintB, 0.5),
    highlightTintR: fin(p.highlightTintR, 0.5), highlightTintG: fin(p.highlightTintG, 0.5), highlightTintB: fin(p.highlightTintB, 0.5),
  };
}

/**
 * The slider maths, display space in → display space out, clamped 0..1.
 * Order: LGG → saturation → split tone → clamp. The shader does the same.
 *
 *  LGG:   v = clamp(c·gain + lift·(1 − c)) ^ (1/gamma)   (per channel)
 *  split: b = S(luma) ∈ [−1, 1], S a cubic ramp across pivot ± softness, so
 *         b = 0 AT the pivot (mid unchanged) and the shadow tint applies with
 *         weight max(−b, 0), the highlight tint with max(b, 0).
 */
export function gradeCpu(rgb: readonly [number, number, number], raw: LggParams): [number, number, number] {
  const p = guardedLgg(raw);
  const out: [number, number, number] = [fin(rgb[0], 0), fin(rgb[1], 0), fin(rgb[2], 0)];
  const lift = [p.liftR, p.liftG, p.liftB];
  const gamma = [p.gammaR, p.gammaG, p.gammaB];
  const gain = [p.gainR, p.gainG, p.gainB];
  for (let i = 0; i < 3; i++) {
    const v = clamp01(out[i] * gain[i] + lift[i] * (1 - out[i]));
    out[i] = Math.pow(v, 1 / gamma[i]);
  }
  const luma0 = out[0] * LUMA[0] + out[1] * LUMA[1] + out[2] * LUMA[2];
  for (let i = 0; i < 3; i++) out[i] = luma0 + (out[i] - luma0) * p.saturation;

  const luma = out[0] * LUMA[0] + out[1] * LUMA[1] + out[2] * LUMA[2];
  const t = clamp01((luma - p.splitPivot + p.splitSoftness) / (2 * p.splitSoftness));
  const b = t * t * (3 - 2 * t) * 2 - 1;
  const ws = Math.max(-b, 0) * p.splitStrength;
  const wh = Math.max(b, 0) * p.splitStrength;
  const sh = [p.shadowTintR, p.shadowTintG, p.shadowTintB];
  const hi = [p.highlightTintR, p.highlightTintG, p.highlightTintB];
  for (let i = 0; i < 3; i++) {
    out[i] = clamp01(out[i] + (sh[i] - 0.5) * ws + (hi[i] - 0.5) * wh);
  }
  return out;
}

// --- LUT arrays --------------------------------------------------------------

export function lutIndex(size: number, r: number, g: number, b: number): number {
  return (r + size * (g + size * b)) * 3;
}

export function identityLut(size = LUT_SIZE): Float32Array {
  const lut = new Float32Array(size * size * size * 3);
  const inv = 1 / (size - 1);
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const i = lutIndex(size, r, g, b);
        lut[i] = r * inv;
        lut[i + 1] = g * inv;
        lut[i + 2] = b * inv;
      }
  return lut;
}

/** bake the slider maths into a LUT: `lut[c] = gradeCpu(c)` on the grid */
export function lutFromLgg(p: LggParams, size = LUT_SIZE): Float32Array {
  const lut = new Float32Array(size * size * size * 3);
  const inv = 1 / (size - 1);
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const o = gradeCpu([r * inv, g * inv, b * inv], p);
        const i = lutIndex(size, r, g, b);
        lut[i] = o[0];
        lut[i + 1] = o[1];
        lut[i + 2] = o[2];
      }
  return lut;
}

/**
 * CPU mirror of the shader sample: `texture3D(lut, rgb·(N−1)/N + 0.5/N)` with
 * linear filtering and clamp-to-edge. In texel space that is `x = rgb·(N−1)`,
 * floor/frac, and a lerp between the two neighbouring texels per axis.
 * `lut` may be the float array or the 8-bit RGBA texture data (`stride` 4,
 * values /255) so the test can sample exactly what the GPU holds.
 */
export function sampleLutCpu(
  lut: ArrayLike<number>,
  size: number,
  rgb: readonly [number, number, number],
  stride: 3 | 4 = 3,
  scale = 1,
): [number, number, number] {
  const n1 = size - 1;
  const idx = (r: number, g: number, b: number): number => (r + size * (g + size * b)) * stride;
  const axis = (v: number): [number, number, number] => {
    const x = clamp01(fin(v, 0)) * n1;
    const i0 = Math.min(Math.floor(x), n1);
    const i1 = Math.min(i0 + 1, n1);
    return [i0, i1, x - i0];
  };
  const [r0, r1, fr] = axis(rgb[0]);
  const [g0, g1, fg] = axis(rgb[1]);
  const [b0, b1, fb] = axis(rgb[2]);
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
    const c00 = lerp(lut[idx(r0, g0, b0) + c], lut[idx(r1, g0, b0) + c], fr);
    const c10 = lerp(lut[idx(r0, g1, b0) + c], lut[idx(r1, g1, b0) + c], fr);
    const c01 = lerp(lut[idx(r0, g0, b1) + c], lut[idx(r1, g0, b1) + c], fr);
    const c11 = lerp(lut[idx(r0, g1, b1) + c], lut[idx(r1, g1, b1) + c], fr);
    out[c] = lerp(lerp(c00, c10, fg), lerp(c01, c11, fg), fb) * scale;
  }
  return out;
}

// --- 8-bit forms: texture data and PNG strip -----------------------------

/** float LUT → RGBA8 texel array in Data3DTexture order (alpha 255) */
export function lutToRgba8(lut: Float32Array, size: number): Uint8Array {
  const n = size * size * size;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = Math.round(clamp01(fin(lut[i * 3], 0)) * 255);
    out[i * 4 + 1] = Math.round(clamp01(fin(lut[i * 3 + 1], 0)) * 255);
    out[i * 4 + 2] = Math.round(clamp01(fin(lut[i * 3 + 2], 0)) * 255);
    out[i * 4 + 3] = 255;
  }
  return out;
}

export function lutToTexture(lut: Float32Array, size = LUT_SIZE): THREE.Data3DTexture {
  const tex = new THREE.Data3DTexture(lutToRgba8(lut, size), size, size, size);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

/** write new contents into an existing slot texture (same size) in place */
export function updateTexture(tex: THREE.Data3DTexture, lut: Float32Array, size: number): void {
  const data = tex.image.data as Uint8Array;
  data.set(lutToRgba8(lut, size));
  tex.needsUpdate = true;
}

/** ImageData-shaped, so the browser's `ImageData` and a test object both fit */
export interface StripImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export function lutToStrip(lut: Float32Array, size = LUT_SIZE): StripImage {
  const width = size * size;
  const height = size;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const i = lutIndex(size, r, g, b);
        const px = ((r + size * b) + width * g) * 4;
        data[px] = Math.round(clamp01(fin(lut[i], 0)) * 255);
        data[px + 1] = Math.round(clamp01(fin(lut[i + 1], 0)) * 255);
        data[px + 2] = Math.round(clamp01(fin(lut[i + 2], 0)) * 255);
        data[px + 3] = 255;
      }
  return { width, height, data };
}

/** throws on a wrong shape rather than silently reading a misaligned image */
export function lutFromStrip(img: StripImage): { lut: Float32Array; size: number } {
  const size = img.height;
  if (size < 2 || img.width !== size * size || img.data.length < img.width * img.height * 4) {
    throw new Error(`[grade] LUT strip must be size²×size RGBA, got ${img.width}×${img.height}`);
  }
  const lut = new Float32Array(size * size * size * 3);
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const i = lutIndex(size, r, g, b);
        const px = ((r + size * b) + img.width * g) * 4;
        lut[i] = img.data[px] / 255;
        lut[i + 1] = img.data[px + 1] / 255;
        lut[i + 2] = img.data[px + 2] / 255;
      }
  return { lut, size };
}

// --- time-of-day bands -----------------------------------------------------

/** the weights for the two slots sampled this frame; everything else is 0 */
export type BandWeights = [number, number, number, number];

/**
 * Slot weights for an hour on the 24 h clock. The four centres are treated as
 * a circular keyframe track: around each centre the slot HOLDS at weight 1
 * for ±hold hours, and between two neighbouring holds the pair crossfades on
 * a cubic ramp. By construction the weights sum to 1, at most two are
 * non-zero, each slot peaks (=1) at its centre, and the function is
 * continuous in `tod` as long as the holds leave some ramp between them.
 * Degenerate inputs (coincident centres, holds longer than the gap) clamp
 * rather than NaN: a hold is capped to the gap, and two centres at the same
 * hour make the later-indexed one unreachable.
 */
export function gradeBandWeights(tod: number, p: BandParams): BandWeights {
  const centres = [
    fin(p.dawnCentre, 6), fin(p.noonCentre, 12), fin(p.duskCentre, 17.8), fin(p.nightCentre, 23),
  ].map((c) => ((c % 24) + 24) % 24);
  const holds = [
    fin(p.dawnHold, 0), fin(p.noonHold, 0), fin(p.duskHold, 0), fin(p.nightHold, 0),
  ].map((h) => Math.max(h, 0));
  const h = ((fin(tod, 12) % 24) + 24) % 24;
  const order = [0, 1, 2, 3].sort((a, b) => centres[a] - centres[b] || a - b);
  const w: BandWeights = [0, 0, 0, 0];
  for (let k = 0; k < 4; k++) {
    const i = order[k];
    const j = order[(k + 1) % 4];
    const L = k === 3 ? 24 - (centres[i] - centres[j]) : centres[j] - centres[i];
    if (L <= 0) continue;
    const d = ((h - centres[i]) % 24 + 24) % 24;
    if (d >= L) continue;
    const holdI = Math.min(holds[i], L);
    const holdJ = Math.min(holds[j], L - holdI);
    const ramp = L - holdI - holdJ;
    const t = ramp > 1e-9 ? clamp01((d - holdI) / ramp) : d >= holdI ? 1 : 0;
    const s = t * t * (3 - 2 * t);
    w[i] = 1 - s;
    w[j] = s;
    return w;
  }
  w[order[0]] = 1; // all four centres coincide
  return w;
}

/** the (at most) two slots to bind this frame, heavier first, and the blend toward the second */
export function pickTopTwo(w: BandWeights): { a: number; b: number; blend: number } {
  let a = 0;
  for (let i = 1; i < 4; i++) if (w[i] > w[a]) a = i;
  let b = -1;
  for (let i = 0; i < 4; i++) if (i !== a && w[i] > 0 && (b < 0 || w[i] > w[b])) b = i;
  if (b < 0) return { a, b: a, blend: 0 };
  const sum = w[a] + w[b];
  return { a, b, blend: sum > 0 ? w[b] / sum : 0 };
}

// --- shipped strips ---------------------------------------------------------

/**
 * Static literals so Vite fingerprints them (same pattern as audio/assets.ts).
 * The shipped files are IDENTITY — `__game.grade.bake(slot)` produces the
 * replacement; see assets/lut/README.md.
 */
export const LUT_STRIP_URLS: Record<GradeSlot, string> = {
  dawn: new URL('../../assets/lut/dawn.png', import.meta.url).href,
  noon: new URL('../../assets/lut/noon.png', import.meta.url).href,
  dusk: new URL('../../assets/lut/dusk.png', import.meta.url).href,
  night: new URL('../../assets/lut/night.png', import.meta.url).href,
};

/** browser-only: decode a strip PNG into a LUT. Throws on a bad shape. */
export async function loadLutStrip(url: string): Promise<{ lut: Float32Array; size: number }> {
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx === null) throw new Error('[grade] 2d context unavailable');
  ctx.drawImage(img, 0, 0);
  return lutFromStrip(ctx.getImageData(0, 0, canvas.width, canvas.height));
}

export function slotIndex(slot: GradeSlot | number): number {
  const i = typeof slot === 'number' ? slot : GRADE_SLOTS.indexOf(slot);
  if (!Number.isInteger(i) || i < 0 || i > 3) throw new Error(`[grade] bad slot ${String(slot)}`);
  return i;
}
