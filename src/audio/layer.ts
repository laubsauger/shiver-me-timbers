/**
 * One looping sample layer: source → lowpass → gain → out.
 *
 * Two rules make the bed not sound like a loop:
 *  1. every layer starts at its OWN seeded random offset inside the file and
 *     loops the whole file, so layers never line up on a common period;
 *  2. gain/cutoff/rate are only ever approached (expApproach + setTargetAtTime)
 *     — a layer fades in from silence, so nothing can pop in.
 *
 * The same primitive serves the non-positional bed and the positional
 * emitters; `out` is either the ambience bus or a PannerNode.
 */
import { expApproach } from './envelope';
import { createRng } from '../state/rng';

/** de-zipper constant for per-frame AudioParam writes */
const WRITE_TAU = 0.05;

export interface LayerTarget {
  gain: number;
  cutoffHz?: number;
  rate?: number;
}

export interface LoopLayer {
  /** starts playback (silently) — safe to call once; later calls are ignored */
  start(buffer: AudioBuffer): void;
  started(): boolean;
  /** per-frame: approach the targets. Cheap: a few AudioParam writes (§V17) */
  update(target: LayerTarget, dt: number, tau: number): void;
  /** current smoothed gain (tests + debug) */
  gain(): number;
  dispose(): void;
}

export interface LayerOpts {
  /** seeds the loop start offset — give every layer a different one */
  seed: number;
  /** insert a lowpass in the chain (wind layer uses it; wake does not) */
  lowpass?: boolean;
}

export function createLoopLayer(
  ctx: BaseAudioContext,
  out: AudioNode,
  opts: LayerOpts,
): LoopLayer {
  const gainNode = ctx.createGain();
  gainNode.gain.value = 0;
  let filter: BiquadFilterNode | null = null;
  if (opts.lowpass) {
    filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 20000;
    filter.connect(gainNode);
  }
  gainNode.connect(out);

  let src: AudioBufferSourceNode | null = null;
  let level = 0;
  let cutoff = 20000;
  let rate = 1;

  return {
    start(buffer) {
      if (src) return;
      src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      src.loopStart = 0;
      src.loopEnd = buffer.duration;
      src.connect(filter ?? gainNode);
      // staggered entry point: seeded, so a replay of the same session sounds
      // the same, but no two layers share a phase
      const offset = createRng(opts.seed)() * Math.max(0, buffer.duration - 0.05);
      src.start(ctx.currentTime, offset);
    },
    started: () => src !== null,
    update(target, dt, tau) {
      if (!src) return;
      const now = ctx.currentTime;
      level = expApproach(level, Math.max(0, target.gain), dt, tau);
      gainNode.gain.setTargetAtTime(level, now, WRITE_TAU);
      if (filter && target.cutoffHz !== undefined) {
        cutoff = expApproach(cutoff, Math.max(20, target.cutoffHz), dt, tau);
        filter.frequency.setTargetAtTime(cutoff, now, WRITE_TAU);
      }
      if (target.rate !== undefined) {
        rate = expApproach(rate, Math.max(0.25, target.rate), dt, tau);
        src.playbackRate.setTargetAtTime(rate, now, WRITE_TAU);
      }
    },
    gain: () => level,
    dispose() {
      try {
        src?.stop();
      } catch {
        /* already stopped */
      }
      src?.disconnect();
      filter?.disconnect();
      gainNode.disconnect();
      src = null;
    },
  };
}
