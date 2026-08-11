/**
 * Pure CPU-side ocean spectrum + FFT precomputation (§V.4, §V.19).
 * Everything here is deterministic (seeded, §V.2) and unit-testable —
 * the GPU passes consume the arrays this module produces.
 */
import { createRng, type Rng } from '../state/rng';
import type { OceanParams } from '../params/ocean';

export const GRAVITY = 9.81;

/** deep-water dispersion: ω² = g·|k| */
export function dispersion(k: number): number {
  return Math.sqrt(GRAVITY * k);
}

export interface SpectrumBand {
  /** keep wavelengths λ (m) with kMin < k ≤ kMax; ±Infinity allowed */
  kMin: number;
  kMax: number;
}

/** wavelength band → k band for one cascade (band-split, §V.19 no dup energy) */
export function cascadeBand(
  cascadeIndex: number,
  splitWavelengths: [number, number],
): SpectrumBand {
  const [s0, s1] = splitWavelengths;
  const k0 = (2 * Math.PI) / s0;
  const k1 = (2 * Math.PI) / s1;
  if (cascadeIndex === 0) return { kMin: 0, kMax: k0 };
  if (cascadeIndex === 1) return { kMin: k0, kMax: k1 };
  return { kMin: k1, kMax: Infinity };
}

/** Phillips spectrum with directional spreading + small-wave suppression */
export function phillips(
  kx: number,
  kz: number,
  p: OceanParams,
): number {
  const k2 = kx * kx + kz * kz;
  if (k2 < 1e-12) return 0;
  const k = Math.sqrt(k2);
  const Lw = (p.windSpeed * p.windSpeed) / GRAVITY;
  const wx = Math.cos(p.windDirection);
  const wz = Math.sin(p.windDirection);
  const dotKW = (kx / k) * wx + (kz / k) * wz;
  let spread = Math.pow(Math.abs(dotKW), p.directionality);
  if (dotKW < 0) spread *= p.oppositeWaveDamp;
  const base =
    (p.amplitude * Math.exp(-1 / (k2 * Lw * Lw))) / (k2 * k2) ;
  const smallWave = Math.exp(-k2 * p.smallWaveCutoff * p.smallWaveCutoff);
  return base * spread * smallWave;
}

/**
 * Initial spectrum h0 for one cascade.
 * Texel (n,m) → k = 2π(n − N/2)/L. RGBA texel packs:
 *   [h0(k).re, h0(k).im, h0(−k).re, h0(−k).im]
 * GPU then evaluates h(k,t) = h0(k)e^{iωt} + conj(h0(−k))e^{−iωt},
 * which keeps the field Hermitian → real heights.
 */
export function generateH0(
  N: number,
  domain: number,
  seed: number,
  p: OceanParams,
  band: SpectrumBand,
): Float32Array {
  const rng: Rng = createRng(seed);
  // pre-generate gaussians for the full grid so h0(−k) lookups are consistent
  const re = new Float32Array(N * N);
  const im = new Float32Array(N * N);
  for (let m = 0; m < N; m++) {
    for (let n = 0; n < N; n++) {
      const kx = (2 * Math.PI * (n - N / 2)) / domain;
      const kz = (2 * Math.PI * (m - N / 2)) / domain;
      const k = Math.hypot(kx, kz);
      const [g1, g2] = gaussianPair(rng);
      let amp = 0;
      if (k > band.kMin && k <= band.kMax) {
        amp = Math.sqrt(phillips(kx, kz, p) / 2) / domain;
      }
      const i = m * N + n;
      re[i] = g1 * amp;
      im[i] = g2 * amp;
    }
  }
  const out = new Float32Array(N * N * 4);
  for (let m = 0; m < N; m++) {
    for (let n = 0; n < N; n++) {
      const i = m * N + n;
      // −k texel index (wraps at grid edge; standard Tessendorf mirror)
      const nm = (N - n) % N;
      const mm = (N - m) % N;
      const j = mm * N + nm;
      out[i * 4 + 0] = re[i];
      out[i * 4 + 1] = im[i];
      out[i * 4 + 2] = re[j];
      out[i * 4 + 3] = im[j];
    }
  }
  return out;
}

/** Box-Muller from seeded rng */
export function gaussianPair(rng: Rng): [number, number] {
  let u1 = rng();
  if (u1 < 1e-12) u1 = 1e-12;
  const u2 = rng();
  const r = Math.sqrt(-2 * Math.log(u1));
  return [r * Math.cos(2 * Math.PI * u2), r * Math.sin(2 * Math.PI * u2)];
}

export function bitReverse(x: number, bits: number): number {
  let r = 0;
  for (let i = 0; i < bits; i++) {
    r = (r << 1) | ((x >> i) & 1);
  }
  return r;
}

/**
 * Butterfly lookup for radix-2 DIT inverse FFT (twiddle e^{+2πik/N}).
 * Layout: stages rows × N cols, RGBA = [tw.re, tw.im, indexA, indexB].
 * Shader/CPU update rule per stage: out[x] = in[A] + W·in[B].
 * Stage 0 indices are bit-reversed so input order is natural.
 */
export function generateButterfly(N: number): Float32Array {
  const stages = Math.log2(N);
  if (!Number.isInteger(stages)) throw new Error('N must be power of two');
  const out = new Float32Array(stages * N * 4);
  for (let j = 0; j < stages; j++) {
    const span = 1 << j;
    for (let x = 0; x < N; x++) {
      const k = (x * (N >> (j + 1))) % N;
      const twRe = Math.cos((2 * Math.PI * k) / N);
      const twIm = Math.sin((2 * Math.PI * k) / N);
      const topWing = x % (span * 2) < span;
      let a: number;
      let b: number;
      if (j === 0) {
        a = topWing ? bitReverse(x, stages) : bitReverse(x - 1, stages);
        b = topWing ? bitReverse(x + 1, stages) : bitReverse(x, stages);
      } else {
        a = topWing ? x : x - span;
        b = topWing ? x + span : x;
      }
      const i = (j * N + x) * 4;
      out[i + 0] = twRe;
      out[i + 1] = twIm;
      out[i + 2] = a;
      out[i + 3] = b;
    }
  }
  return out;
}

/**
 * CPU reference 1D inverse FFT driven by the butterfly table — exists to
 * prove the table's indices/twiddles are right before the GPU ever runs
 * (same update rule the shader uses). Unnormalized: X[n] = Σ x[k]e^{+2πikn/N}.
 */
export function cpuButterflyIFFT(
  input: { re: Float32Array; im: Float32Array },
  butterfly: Float32Array,
  N: number,
): { re: Float32Array; im: Float32Array } {
  const stages = Math.log2(N);
  let pingRe = Float32Array.from(input.re);
  let pingIm = Float32Array.from(input.im);
  let pongRe = new Float32Array(N);
  let pongIm = new Float32Array(N);
  for (let j = 0; j < stages; j++) {
    for (let x = 0; x < N; x++) {
      const i = (j * N + x) * 4;
      const twRe = butterfly[i];
      const twIm = butterfly[i + 1];
      const a = butterfly[i + 2];
      const b = butterfly[i + 3];
      // out = in[a] + W·in[b]
      pongRe[x] = pingRe[a] + twRe * pingRe[b] - twIm * pingIm[b];
      pongIm[x] = pingIm[a] + twRe * pingIm[b] + twIm * pingRe[b];
    }
    [pingRe, pongRe] = [pongRe, pingRe];
    [pingIm, pongIm] = [pongIm, pingIm];
  }
  return { re: pingRe, im: pingIm };
}

/** naive unnormalized inverse DFT — test oracle only */
export function naiveIDFT(
  input: { re: Float32Array; im: Float32Array },
  N: number,
): { re: Float32Array; im: Float32Array } {
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    for (let k = 0; k < N; k++) {
      const ang = (2 * Math.PI * k * n) / N;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      re[n] += input.re[k] * c - input.im[k] * s;
      im[n] += input.re[k] * s + input.im[k] * c;
    }
  }
  return { re, im };
}
