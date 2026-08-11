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

/**
 * hullHit (thud):
 *   [sine, hullHitHz→½ drop] → env (fast attack, short decay) → out
 */
export function hullHit(ctx: BaseAudioContext, out: AudioNode): void {
  const t0 = ctx.currentTime;
  const end = t0 + p.hullHitDuration;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(p.hullHitHz, t0);
  osc.frequency.exponentialRampToValueAtTime(safeExpTarget(p.hullHitHz * 0.5), end);
  playChain(osc, [envGain(ctx, t0, p.hullHitGain, 0.005, end)], out);
  osc.start(t0);
  osc.stop(end);
}
