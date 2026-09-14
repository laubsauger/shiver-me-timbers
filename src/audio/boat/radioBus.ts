/**
 * RACE RADIO BUS (§T.197 item 7). Race control's calls are TEXT on the HUD strip (page/raceRadio.ts); what is
 * AUDIBLE is a VHF squelch "kerchunk" — a short band-limited noise burst — each time a new line goes out, so the ear
 * knows to glance at the strip. No speech is voiced. Every radio sound goes through ONE gain node, the radio bus,
 * whose level is the pause screen's `master × radio` (`radioBusLevel`).
 *
 *   noise buffer ─► BufferSource ─► env Gain ─► shared bandpass ─► radio bus Gain ─► destination
 *
 * Why the bus sits beside the engine's buses, not under `master`: `audio/engine.ts` does not expose its master gain
 * (shared with the pirate/raft pages), so the master factor is folded into this bus's level by the caller; the page's
 * one audio-settings hook sets both. Engines stay on the sfx bus and are untouched by the radio level.
 *
 * Built lazily on the first call with a running context (browsers block audio before a gesture); ≤ 4 persistent nodes
 * plus 2 per call, released when the burst ends.
 */
import { clamp01 } from '../envelope';
import type { AudioEngine } from '../engine';

/** squelch burst length, s */
export const SQUELCH_S = 0.14;
/** VHF voice band centre and Q of the burst's bandpass */
const BAND_HZ = 1800;
const BAND_Q = 1.1;
/** peak of the burst before the bus (a notification, well under the engines' loudness) */
const BURST_PEAK = 0.35;

/** the radio bus gain for pause-screen levels: master scales it, radio sets it; 0 on either silences it */
export function radioBusLevel(master: number, radio: number): number {
  return clamp01(Number.isFinite(master) ? master : 0) * clamp01(Number.isFinite(radio) ? radio : 0);
}

export interface RadioBus {
  /** bus level 0..1 (use `radioBusLevel(master, radio)`); survives being set before the context exists */
  setLevel(level: number): void;
  readonly level: number;
  /** a new radio line went out: play the squelch burst (no-op until the context runs, or at level 0) */
  call(): void;
  /** the bus node once built (tests, a future voice) */
  readonly node: GainNode | null;
  dispose(): void;
}

export function createRadioBus(engine: Pick<AudioEngine, 'getContext'>): RadioBus {
  let level = 0;
  let ctx: BaseAudioContext | null = null;
  let bus: GainNode | null = null;
  let band: BiquadFilterNode | null = null;
  let noise: AudioBuffer | null = null;

  const build = (c: BaseAudioContext): void => {
    ctx = c;
    bus = c.createGain();
    bus.gain.value = level;
    bus.connect(c.destination);
    band = c.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = BAND_HZ;
    band.Q.value = BAND_Q;
    band.connect(bus);
    const n = Math.max(1, Math.ceil(c.sampleRate * SQUELCH_S));
    noise = c.createBuffer(1, n, c.sampleRate);
    const data = noise.getChannelData(0);
    // deterministic LCG noise (no Math.random: the same burst every call)
    let s = 0x2545f491;
    for (let i = 0; i < n; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      data[i] = s / 0x80000000 - 1;
    }
  };

  return {
    get level() {
      return level;
    },
    get node() {
      return bus;
    },
    setLevel(v) {
      level = clamp01(Number.isFinite(v) ? v : 0);
      if (bus) bus.gain.value = level;
    },
    call() {
      const c = engine.getContext();
      if (!c || c.state !== 'running' || level <= 0) return;
      if (ctx !== c) build(c);
      if (!band || !noise) return;
      const src = c.createBufferSource();
      src.buffer = noise;
      const env = c.createGain();
      const t = c.currentTime;
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(BURST_PEAK, t + 0.008);
      env.gain.setTargetAtTime(0, t + SQUELCH_S * 0.45, SQUELCH_S * 0.18);
      src.connect(env);
      env.connect(band);
      src.onended = () => {
        src.disconnect();
        env.disconnect();
      };
      src.start(t);
      src.stop(t + SQUELCH_S);
    },
    dispose() {
      bus?.disconnect();
      band?.disconnect();
      ctx = null;
      bus = null;
      band = null;
      noise = null;
    },
  };
}
