/**
 * Synthesized one-shots — pure param config → WebAudio node graph, zero
 * audio assets. Every graph self-disconnects when its longest source ends.
 * Tunables live in params/audio.ts (§V16). Randomization (creak) takes a
 * seeded rng (src/state/rng) — no Math.random (§V2 spirit).
 */
import { centsToRatio, safeExpTarget } from './envelope';
import { audioParams as p } from '../params/audio';
import { createRng, type Rng } from '../state/rng';

const NOISE_SEED = 0xcafe;
const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();

/** 2s deterministic white-noise buffer, cached per context */
function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let buf = noiseCache.get(ctx);
  if (buf) return buf;
  const n = Math.floor(ctx.sampleRate * 2);
  buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buf.getChannelData(0);
  const rng = createRng(NOISE_SEED);
  for (let i = 0; i < n; i++) data[i] = rng() * 2 - 1;
  noiseCache.set(ctx, buf);
  return buf;
}

/** wire src → …chain… → out, and tear the whole graph down when src ends */
function playChain(src: AudioScheduledSourceNode, chain: AudioNode[], out: AudioNode): void {
  let node: AudioNode = src;
  for (const next of chain) {
    node.connect(next);
    node = next;
  }
  node.connect(out);
  src.onended = () => {
    src.disconnect();
    for (const n of chain) n.disconnect();
  };
}

/** gain envelope: instant/linear attack to peak, exponential decay to ~0 */
function envGain(ctx: BaseAudioContext, t0: number, peak: number, attack: number, end: number): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(safeExpTarget(0), t0);
  g.gain.linearRampToValueAtTime(safeExpTarget(peak), t0 + attack);
  g.gain.exponentialRampToValueAtTime(safeExpTarget(0), end);
  return g;
}

/**
 * cannonBoom (~1.2s):
 *   [noise burst] → lowpass (6kHz→120Hz exp sweep) → env ─┐
 *   [sub sine 48Hz→½] ────────────────────────────→ env ─┴→ out
 */
export function cannonBoom(ctx: BaseAudioContext, out: AudioNode): void {
  const t0 = ctx.currentTime;
  const end = t0 + p.cannonDuration;

  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer(ctx);
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.setValueAtTime(p.cannonLowpassStartHz, t0);
  lowpass.frequency.exponentialRampToValueAtTime(safeExpTarget(p.cannonLowpassEndHz), end);
  playChain(noise, [lowpass, envGain(ctx, t0, p.cannonNoiseGain, 0.005, end)], out);
  noise.start(t0);
  noise.stop(end);

  const sub = ctx.createOscillator();
  sub.type = 'sine';
  sub.frequency.setValueAtTime(p.cannonSubHz, t0);
  sub.frequency.exponentialRampToValueAtTime(safeExpTarget(p.cannonSubHz * 0.5), end);
  playChain(sub, [envGain(ctx, t0, p.cannonSubGain, 0.01, end)], out);
  sub.start(t0);
  sub.stop(end);
}

/**
 * splash:
 *   [noise burst] → bandpass(splashBandHz, Q) → env (fast attack) → out
 */
export function splash(ctx: BaseAudioContext, out: AudioNode): void {
  const t0 = ctx.currentTime;
  const end = t0 + p.splashAttack + p.splashRelease;
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer(ctx);
  const bandpass = ctx.createBiquadFilter();
  bandpass.type = 'bandpass';
  bandpass.frequency.value = p.splashBandHz;
  bandpass.Q.value = p.splashQ;
  playChain(noise, [bandpass, envGain(ctx, t0, p.splashGain, p.splashAttack, end)], out);
  noise.start(t0);
  noise.stop(end);
}

export interface CreakPlan {
  startHz: number;
  endHz: number;
  duration: number;
  q: number;
  gain: number;
}

/**
 * Pure plan for a creak — deterministic given the rng (unit-tested without
 * an AudioContext). Pitch randomized ±creakSpreadCents around creakBaseHz.
 */
export function planCreak(rng: Rng): CreakPlan {
  const startHz = p.creakBaseHz * centsToRatio((rng() * 2 - 1) * p.creakSpreadCents);
  return {
    startHz,
    endHz: startHz * p.creakBendRatio,
    duration: p.creakDuration,
    q: p.creakQ,
    gain: p.creakGain,
  };
}

/**
 * creak:
 *   [saw osc, startHz→endHz bend] → bandpass(startHz, high Q) → env → out
 */
export function creak(ctx: BaseAudioContext, out: AudioNode, rng: Rng): void {
  const plan = planCreak(rng);
  const t0 = ctx.currentTime;
  const end = t0 + plan.duration;
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(plan.startHz, t0);
  osc.frequency.exponentialRampToValueAtTime(safeExpTarget(plan.endHz), end);
  const resonant = ctx.createBiquadFilter();
  resonant.type = 'bandpass';
  resonant.frequency.value = plan.startHz;
  resonant.Q.value = plan.q;
  playChain(osc, [resonant, envGain(ctx, t0, plan.gain, 0.02, end)], out);
  osc.start(t0);
  osc.stop(end);
}

export interface HullHitLayer {
  kind: 'crack' | 'body' | 'rattle';
  /**
   * true = broadband noise, false = a pitched oscillator. THE load-bearing
   * field: a sine has energy only at its fundamental, so a hit built from
   * pitched layers alone cannot produce an onset however loud it is driven.
   */
  broadband: boolean;
  /** s to peak. A transient IS a fast attack; there is no other way to make one */
  attack: number;
  /** s from onset to silence */
  duration: number;
  gain: number;
}

/**
 * Pure plan for a hull hit — deterministic, and testable with no
 * AudioContext, the same way `planCreak` is. The shape of this list IS the
 * fix: three layers whose durations SPAN, rather than one sine.
 */
export function planHullHit(): HullHitLayer[] {
  return [
    {
      kind: 'crack',
      broadband: true,
      attack: 0.001,
      duration: Math.max(0.005, p.hullHitCrackDecay),
      gain: p.hullHitCrackGain,
    },
    {
      kind: 'body',
      broadband: false,
      attack: 0.005,
      duration: p.hullHitDuration,
      gain: p.hullHitGain,
    },
    {
      kind: 'rattle',
      broadband: true,
      attack: 0.004,
      duration: Math.max(0.01, p.hullHitRattleDecay),
      gain: p.hullHitRattleGain,
    },
  ];
}

/**
 * hullHit — iron shot into oak.
 *
 *   [noise] → bandpass(crackHz, Q)  → env (1 ms attack, ~55 ms)  ─┐  CRACK
 *   [sine, hullHitHz→½ drop]        → env (5 ms attack)          ─┼→ out  BODY
 *   [noise] → highpass(rattleHz)    → env (4 ms attack, ~280 ms) ─┘  SPLINTER
 *
 * WHY THREE LAYERS. This was ONE sine at 80 Hz ramping to 40, and the user's
 * report was "a very weak impact sound". Louder was never going to fix it: an
 * impact is almost entirely TRANSIENT, and a sine has none — it has no energy
 * anywhere but its fundamental, so there is nothing for the ear's onset
 * detector to latch onto and it reads as a soft thump however hot you drive
 * it. The crack is the broadband click that says "something struck"; the body
 * is the mass behind it (and is the old sine, kept); the rattle is the timber
 * letting go afterwards, which is what makes it WOOD rather than a drum.
 *
 * The three decay at deliberately different rates — ~55 ms, ~280 ms, ~280 ms —
 * for the same reason the visual flash and smoke do: an impact is a spread of
 * timescales, and collapsing them into one reads as a single blunt event.
 */
export function hullHit(ctx: BaseAudioContext, out: AudioNode): void {
  const t0 = ctx.currentTime;
  const [crackPlan, bodyPlan, rattlePlan] = planHullHit();

  // CRACK — the transient. Short, broadband, and the layer that was missing.
  const crackEnd = t0 + crackPlan.duration;
  const crack = ctx.createBufferSource();
  crack.buffer = noiseBuffer(ctx);
  const crackBand = ctx.createBiquadFilter();
  crackBand.type = 'bandpass';
  crackBand.frequency.value = p.hullHitCrackHz;
  crackBand.Q.value = p.hullHitCrackQ;
  playChain(
    crack,
    [crackBand, envGain(ctx, t0, crackPlan.gain, crackPlan.attack, crackEnd)],
    out,
  );
  crack.start(t0);
  crack.stop(crackEnd);

  // BODY — the mass. Unchanged from the original one-shot.
  const end = t0 + bodyPlan.duration;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(p.hullHitHz, t0);
  osc.frequency.exponentialRampToValueAtTime(safeExpTarget(p.hullHitHz * 0.5), end);
  playChain(osc, [envGain(ctx, t0, bodyPlan.gain, bodyPlan.attack, end)], out);
  osc.start(t0);
  osc.stop(end);

  // RATTLE — splintering timber, the tail that makes it oak and not a drum.
  const rattleEnd = t0 + rattlePlan.duration;
  const rattle = ctx.createBufferSource();
  rattle.buffer = noiseBuffer(ctx);
  const rattleHigh = ctx.createBiquadFilter();
  rattleHigh.type = 'highpass';
  rattleHigh.frequency.value = p.hullHitRattleHz;
  playChain(
    rattle,
    [rattleHigh, envGain(ctx, t0, rattlePlan.gain, rattlePlan.attack, rattleEnd)],
    out,
  );
  rattle.start(t0);
  rattle.stop(rattleEnd);
}
