/**
 * Sample one-shots, including slices cut out of the long recordings.
 *
 * "Cut them up and use them appropriately": a bow splash is a ~1 s window
 * lifted out of the 64 s wake recording at a seeded random offset, so no two
 * splashes are the same take. A cut needs its own micro fade in/out or the
 * discontinuity at the cut points clicks — hence the envelope here rather than
 * a bare source.start(offset, duration).
 */
import { safeExpTarget } from './envelope';
import type { Rng } from '../state/rng';

export interface ShotOpts {
  gain: number;
  /** seconds into the buffer (defaults to 0 = play from the top) */
  offset?: number;
  /** seconds to play (defaults to the rest of the buffer) */
  duration?: number;
  playbackRate?: number;
  fadeIn?: number;
  fadeOut?: number;
}

const DEFAULT_FADE = 0.02;

/**
 * Fire-and-forget: the graph disconnects itself on ended, so nothing
 * accumulates over a long session.
 */
export function playSample(
  ctx: BaseAudioContext,
  out: AudioNode,
  buffer: AudioBuffer,
  opts: ShotOpts,
): void {
  const rate = Math.max(0.25, opts.playbackRate ?? 1);
  const offset = Math.min(Math.max(0, opts.offset ?? 0), Math.max(0, buffer.duration - 0.05));
  const available = (buffer.duration - offset) / rate;
  const dur = Math.max(0.05, Math.min(opts.duration ?? available, available));
  const fadeIn = Math.min(opts.fadeIn ?? DEFAULT_FADE, dur * 0.4);
  const fadeOut = Math.min(opts.fadeOut ?? DEFAULT_FADE, dur * 0.4);

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = rate;
  const gain = ctx.createGain();
  const t0 = ctx.currentTime;
  const end = t0 + dur;
  gain.gain.setValueAtTime(safeExpTarget(0), t0);
  gain.gain.linearRampToValueAtTime(Math.max(0, opts.gain), t0 + fadeIn);
  gain.gain.setValueAtTime(Math.max(0, opts.gain), Math.max(t0 + fadeIn, end - fadeOut));
  gain.gain.linearRampToValueAtTime(0, end);
  src.connect(gain).connect(out);
  src.onended = () => {
    src.disconnect();
    gain.disconnect();
  };
  src.start(t0, offset, dur * rate);
  src.stop(end + 0.01);
}

/**
 * Pick a slice start inside the first `windowSec` of a recording, leaving room
 * for `sliceSec`. Pure so the slice bookkeeping is testable (an offset past
 * the end plays silence — an audible dropout, not an error).
 */
export function sliceOffset(
  rng: Rng,
  bufferDuration: number,
  windowSec: number,
  sliceSec: number,
): number {
  const usable = Math.max(0, Math.min(windowSec, bufferDuration) - sliceSec);
  return rng() * usable;
}
