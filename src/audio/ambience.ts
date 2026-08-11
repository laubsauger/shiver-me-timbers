/**
 * Ocean + wind ambience — fully synthesized, zero audio assets.
 *
 *   [brown-ish noise loop] → lowpass → swellGain (JS LFO) → bedGain ─┐
 *                                                                    ├→ out
 *   [white noise loop] ────→ bandpass ─────────────────→ windGain ──┘
 *
 * update() follows {windSpeed, weather} read from SimState (§V3: read-only;
 * render/audio never write sim). Storm intensifies purely through the
 * weather multiplier params — same code path for calm|swell|storm (§V7
 * spirit). All tunables in params/audio.ts (§V16).
 *
 * Noise buffers are filled with the seeded RNG (no Math.random anywhere).
 */
import { advanceLfo, clamp01, expApproach, lerp, lfoUnipolar } from './envelope';
import { audioParams as p } from '../params/audio';
import { createRng } from '../state/rng';

export interface AmbienceEnv {
  windSpeed: number;
  weather: 'calm' | 'swell' | 'storm';
}

export interface Ambience {
  update(env: AmbienceEnv, dt: number): void;
  dispose(): void;
}

const NOISE_SECONDS = 4;
const NOISE_SEED_BROWN = 0xb00b1e5;
const NOISE_SEED_WHITE = 0x5eaf00d;
/** short setTargetAtTime constant to de-zipper per-frame param writes */
const WRITE_TAU = 0.05;

/** looped white noise buffer, deterministic fill */
function whiteNoiseBuffer(ctx: BaseAudioContext, seed: number): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * NOISE_SECONDS);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buf.getChannelData(0);
  const rng = createRng(seed);
  for (let i = 0; i < n; i++) data[i] = rng() * 2 - 1;
  return buf;
}

/**
 * Brown-ish noise: leaky integrator over white noise. leak (param
 * oceanNoiseLeak) sets the color — smaller = darker/browner. Normalized to
 * ~unit peak so oceanGain stays meaningful.
 */
function brownNoiseBuffer(ctx: BaseAudioContext, seed: number, leak: number): AudioBuffer {
  const buf = whiteNoiseBuffer(ctx, seed);
  const data = buf.getChannelData(0);
  let acc = 0;
  let peak = 1e-6;
  for (let i = 0; i < data.length; i++) {
    acc = (1 - leak) * acc + leak * data[i];
    data[i] = acc;
    const a = Math.abs(acc);
    if (a > peak) peak = a;
  }
  for (let i = 0; i < data.length; i++) data[i] /= peak;
  return buf;
}

function loopSource(ctx: BaseAudioContext, buffer: AudioBuffer): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.start();
  return src;
}

export function createAmbience(ctx: BaseAudioContext, out: AudioNode): Ambience {
  // ocean bed chain
  const bedSrc = loopSource(ctx, brownNoiseBuffer(ctx, NOISE_SEED_BROWN, p.oceanNoiseLeak));
  const bedLowpass = ctx.createBiquadFilter();
  bedLowpass.type = 'lowpass';
  bedLowpass.frequency.value = p.oceanLowpassHz;
  const swellGain = ctx.createGain();
  swellGain.gain.value = 0;
  const bedGain = ctx.createGain();
  bedGain.gain.value = p.oceanGain;
  bedSrc.connect(bedLowpass).connect(swellGain).connect(bedGain).connect(out);

  // wind chain
  const windSrc = loopSource(ctx, whiteNoiseBuffer(ctx, NOISE_SEED_WHITE));
  const windBandpass = ctx.createBiquadFilter();
  windBandpass.type = 'bandpass';
  windBandpass.frequency.value = p.windCutoffMinHz;
  windBandpass.Q.value = p.windQ;
  const windGain = ctx.createGain();
  windGain.gain.value = 0;
  windSrc.connect(windBandpass).connect(windGain).connect(out);

  // JS-side smoothed state (expApproach) + slow swell LFO phase
  let swellPhase = 0;
  let windCutoff = p.windCutoffMinHz;
  let windLevel = 0;

  return {
    update(env, dt) {
      const gainMult = {
        calm: p.calmGainMult,
        swell: p.swellGainMult,
        storm: p.stormGainMult,
      }[env.weather];
      const rateMult = {
        calm: p.calmSwellRateMult,
        swell: p.swellSwellRateMult,
        storm: p.stormSwellRateMult,
      }[env.weather];

      // ocean bed: amplitude swell at the wave rhythm
      swellPhase = advanceLfo(swellPhase, p.swellRateHz * rateMult, dt);
      const swell = 1 - p.swellDepth + p.swellDepth * lfoUnipolar(swellPhase);
      const now = ctx.currentTime;
      swellGain.gain.setTargetAtTime(swell * gainMult, now, WRITE_TAU);
      bedGain.gain.setTargetAtTime(p.oceanGain, now, WRITE_TAU);
      bedLowpass.frequency.setTargetAtTime(p.oceanLowpassHz, now, WRITE_TAU);

      // wind: cutoff + gain follow windSpeed, smoothed with ambienceTau
      const w = clamp01(env.windSpeed / p.windSpeedRef);
      windCutoff = expApproach(
        windCutoff,
        lerp(p.windCutoffMinHz, p.windCutoffMaxHz, w),
        dt,
        p.ambienceTau,
      );
      windLevel = expApproach(windLevel, p.windGainMax * w * gainMult, dt, p.ambienceTau);
      windBandpass.frequency.setTargetAtTime(windCutoff, now, WRITE_TAU);
      windBandpass.Q.setTargetAtTime(p.windQ, now, WRITE_TAU);
      windGain.gain.setTargetAtTime(windLevel, now, WRITE_TAU);
    },
    dispose() {
      bedSrc.stop();
      windSrc.stop();
      for (const node of [bedSrc, bedLowpass, swellGain, bedGain, windSrc, windBandpass, windGain])
        node.disconnect();
    },
  };
}
