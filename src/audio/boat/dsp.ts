/**
 * §T.183 sample-rate DSP primitives for the boat worklet. Pure TS, no WebAudio, no globals: the same
 * code runs in the AudioWorkletGlobalScope and under node (tests render WAVs with it), so what the
 * tests measure IS what the browser plays.
 */

/** mulberry32 as a class (the worklet calls it ~10⁵ times/s; a closure per call site costs more) */
export class Noise {
  private a: number;
  constructor(seed: number) {
    this.a = seed >>> 0 || 0x9e3779b9;
  }
  /** uniform 0..1 */
  next(): number {
    let a = (this.a = (this.a + 0x6d2b79f5) | 0);
    a = Math.imul(a ^ (a >>> 15), 1 | a);
    a = (a + Math.imul(a ^ (a >>> 7), 61 | a)) ^ a;
    return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
  }
  /** uniform −1..1 */
  bi(): number {
    return this.next() * 2 - 1;
  }
}

/** one-pole lowpass; `setHz` once per control block */
export class OnePole {
  y = 0;
  a = 1;
  setHz(hz: number, sr: number): void {
    const f = Math.min(sr * 0.45, Math.max(1, hz));
    this.a = 1 - Math.exp((-2 * Math.PI * f) / sr);
  }
  lp(x: number): number {
    this.y += this.a * (x - this.y);
    return this.y;
  }
}

/** DC blocker (≈ 20 Hz at 48 k) — exhaust pulses are one-signed pressure */
export class DcBlock {
  private x1 = 0;
  private y1 = 0;
  private r = 0.9974;
  setHz(hz: number, sr: number): void {
    this.r = Math.exp((-2 * Math.PI * hz) / sr);
  }
  run(x: number): number {
    const y = x - this.x1 + this.r * this.y1;
    this.x1 = x;
    this.y1 = y;
    return y;
  }
}

/**
 * Topology-preserving-transform state-variable filter (Zavalishin). Stable under per-block
 * modulation, which a direct-form biquad is not — the exhaust and hiss filters sweep with rpm/speed.
 */
export class Svf {
  private ic1 = 0;
  private ic2 = 0;
  private g = 0.1;
  private k = 1.4;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  lp = 0;
  bp = 0;
  hp = 0;
  set(hz: number, q: number, sr: number): void {
    const f = Math.min(sr * 0.49, Math.max(10, hz));
    this.g = Math.tan((Math.PI * f) / sr);
    this.k = 1 / Math.max(0.05, q);
    this.a1 = 1 / (1 + this.g * (this.g + this.k));
    this.a2 = this.g * this.a1;
    this.a3 = this.g * this.a2;
  }
  run(x: number): void {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2;
    this.bp = v1;
    this.hp = x - this.k * v1 - v2;
  }
  reset(): void {
    this.ic1 = this.ic2 = 0;
    this.lp = this.bp = this.hp = 0;
  }
}

/** integer-length feedback delay line with a one-pole damped, signed reflection: a pipe */
export class Waveguide {
  private buf: Float32Array;
  private w = 0;
  private len: number;
  private damp = new OnePole();
  reflect: number;
  constructor(lengthSamples: number, reflect: number, dampHz: number, sr: number) {
    this.len = Math.max(2, Math.round(lengthSamples));
    this.buf = new Float32Array(this.len);
    this.reflect = reflect;
    this.damp.setHz(dampHz, sr);
  }
  run(x: number): number {
    const back = this.buf[this.w];
    const y = x + this.reflect * this.damp.lp(back);
    this.buf[this.w] = y;
    this.w = this.w + 1 === this.len ? 0 : this.w + 1;
    return y;
  }
}

/** exhaust pressure pulse g(v) = v·e^(1−v): peak 1 at v = 1, ~0 by v ≈ 9. Tabled, linear lookup */
const PULSE_TABLE_N = 1024;
const PULSE_TABLE_MAX = 10;
const PULSE_TABLE = (() => {
  const t = new Float32Array(PULSE_TABLE_N + 2);
  for (let i = 0; i <= PULSE_TABLE_N + 1; i++) {
    const v = (i / PULSE_TABLE_N) * PULSE_TABLE_MAX;
    t[i] = v * Math.exp(1 - v);
  }
  return t;
})();
export function pulseShape(v: number): number {
  if (v <= 0 || v >= PULSE_TABLE_MAX) return 0;
  const x = (v / PULSE_TABLE_MAX) * PULSE_TABLE_N;
  const i = x | 0;
  const f = x - i;
  return PULSE_TABLE[i] + (PULSE_TABLE[i + 1] - PULSE_TABLE[i]) * f;
}

const SIN_N = 4096;
const SIN_TABLE = (() => {
  const t = new Float32Array(SIN_N + 1);
  for (let i = 0; i <= SIN_N; i++) t[i] = Math.sin((i / SIN_N) * Math.PI * 2);
  return t;
})();
/** sin(2π·phase), phase in [0,1) */
export function sin01(phase: number): number {
  const x = (phase - Math.floor(phase)) * SIN_N;
  const i = x | 0;
  return SIN_TABLE[i] + (SIN_TABLE[i + 1] - SIN_TABLE[i]) * (x - i);
}

/** cheap tanh-like soft clip, odd, |y| < 1 */
export function softClip(x: number): number {
  return x / (1 + Math.abs(x));
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** finite or fallback — every value that crosses the message port goes through this (§V28) */
export function finite(x: number, fallback = 0): number {
  return Number.isFinite(x) ? x : fallback;
}
