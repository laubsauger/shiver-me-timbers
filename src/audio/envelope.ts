/**
 * Pure audio math helpers — NO WebAudio imports (§V16: consumers pull every
 * tunable from params/audio.ts; this module is just the math). Unit-tested in
 * tests/audio.test.ts under plain node, so nothing here may touch
 * AudioContext, DOM, or Math.random.
 */

/** volumes and envelope levels are always kept in 0..1 */
export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** decibels → linear gain. 0dB = 1, -6dB ≈ 0.5 */
export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/** linear gain → decibels. Guards 0 with -Infinity floor at ~-120dB. */
export function linearToDb(lin: number): number {
  return lin <= 1e-6 ? -120 : 20 * Math.log10(lin);
}

/**
 * WebAudio exponentialRampToValueAtTime throws on values ≤ 0 — every exp ramp
 * target must pass through this floor first.
 */
export const EXP_FLOOR = 1e-4;
export function safeExpTarget(value: number, floor = EXP_FLOOR): number {
  return value < floor ? floor : value;
}

/**
 * Frame-rate independent exponential approach toward a target (one-pole
 * smoother). tau seconds = time constant; after tau, ~63% of the gap closed.
 * Used by ambience.update to de-zipper wind cutoff/gain follow.
 */
export function expApproach(current: number, target: number, dt: number, tau: number): number {
  if (tau <= 0) return target;
  return target + (current - target) * Math.exp(-dt / tau);
}

/** equal-temperament cents → frequency ratio (1200 cents = one octave) */
export function centsToRatio(cents: number): number {
  return Math.pow(2, cents / 1200);
}

/** wrap an LFO phase into [0, 1) — handles multi-cycle jumps and negatives */
export function wrapPhase(phase: number): number {
  return phase - Math.floor(phase);
}

/** advance an LFO phase by rate*dt, wrapped to [0, 1) */
export function advanceLfo(phase: number, rateHz: number, dt: number): number {
  return wrapPhase(phase + rateHz * dt);
}

/** unipolar sine LFO: phase [0,1) → 0..1, starts at 0.5 rising */
export function lfoUnipolar(phase: number): number {
  return 0.5 + 0.5 * Math.sin(phase * Math.PI * 2);
}

/** ADSR envelope times in seconds; sustain is a 0..1 level, not a time */
export interface Adsr {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
}

/**
 * Sample an ADSR at time t (seconds since note-on) with the gate held for
 * gateDuration seconds. Linear segments:
 *   0..attack           : 0 → 1
 *   attack..attack+decay: 1 → sustain
 *   ..gateDuration      : sustain
 *   gate..gate+release  : level-at-gate-off → 0
 * Gate shorter than attack+decay releases from wherever the curve was.
 */
export function sampleAdsr(env: Adsr, t: number, gateDuration: number): number {
  if (t < 0) return 0;
  const held = (tt: number): number => {
    if (tt < env.attack) return env.attack > 0 ? tt / env.attack : 1;
    const td = tt - env.attack;
    if (td < env.decay) return lerp(1, env.sustain, env.decay > 0 ? td / env.decay : 1);
    return env.sustain;
  };
  if (t <= gateDuration) return clamp01(held(t));
  const levelAtOff = clamp01(held(gateDuration));
  const tr = t - gateDuration;
  if (tr >= env.release) return 0;
  return levelAtOff * (1 - (env.release > 0 ? tr / env.release : 1));
}
