/**
 * Sample one-shots, including slices cut out of the long recordings.
 *
 * "Cut them up and use them appropriately": a bow splash is a ~1 s window
 * lifted out of the 64 s wake recording at a seeded random offset, so no two
 * splashes are the same take. A cut needs its own micro fade in/out or the
 * discontinuity at the cut points clicks — hence the envelope here rather than
 * a bare source.start(offset, duration).
 */
import { centsToRatio, safeExpTarget } from './envelope';
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
  /** seconds to wait before starting — see broadside stagger in events.ts */
  delay?: number;
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
  const t0 = ctx.currentTime + Math.max(0, opts.delay ?? 0);
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

export interface Variation {
  /** which buffer of the pool to use */
  index: number;
  /** pitch jitter, as a playbackRate multiplier around 1 */
  playbackRate: number;
}

/**
 * Round-robin over a pool of takes, with pitch jitter.
 *
 * WHY NOT RANDOM. A random pick out of three repeats itself one time in three,
 * and back-to-back repeats are exactly the artifact having three takes is
 * meant to remove — one audible repeat undoes the variation for the whole
 * volley. So the step is "advance by 1..poolSize-1", which CANNOT land on the
 * index it just played while still not being a fixed A-B-C rotation the ear
 * can learn.
 *
 * Pure and seeded (§V2 spirit: no Math.random), so the no-repeat property is
 * assertable without an AudioContext — see tests/audio.test.ts.
 *
 * @param poolSize CURRENT number of takes, read per call rather than captured:
 *                 samples decode one at a time and a pool grows mid-session, so
 *                 a size fixed at construction would either rotate over slots
 *                 that do not exist yet or never use the ones that arrive
 *                 later. 1 is legal and yields index 0 forever with pitch
 *                 jitter as the only variation; 0 yields index -1 so a caller
 *                 can tell "nothing loaded" from "take 0".
 */
export function createVariationPicker(
  poolSize: () => number,
  rng: Rng,
  spreadCents: number,
): () => Variation {
  let index = 0;
  return () => {
    const size = Math.floor(poolSize());
    if (!(size > 0)) return { index: -1, playbackRate: 1 };
    if (size > 1) {
      const step = 1 + Math.floor(rng() * (size - 1));
      index = (index + step) % size;
    } else {
      index = 0;
    }
    return { index, playbackRate: centsToRatio((rng() * 2 - 1) * spreadCents) };
  };
}

export interface StaggerState {
  /** ctx time the last shot in this burst was scheduled for */
  last: number;
  /** delay handed to that shot */
  delay: number;
}

export const NO_STAGGER: StaggerState = { last: Number.NEGATIVE_INFINITY, delay: 0 };

/**
 * Spread shots that arrive on the SAME audio timestamp across a few tens of
 * milliseconds.
 *
 * This is a safety net, not the main event — combatSystem already rolls a
 * broadside fore-to-aft with `rippleDelay`/`rippleJitter`, so guns normally
 * arrive ~130 ms apart and this returns a zero delay for every one of them.
 * It engages only when several shots genuinely coincide: a frame hitch that
 * drains multiple pending guns in one tick (a case combatSystem's drain loop
 * names explicitly), `rippleDelay` tuned to 0, or two ships coming due
 * together. Shots that start on the same sample sum in phase, which reads as
 * one louder gun rather than several.
 *
 * Capped, because past a certain spread a volley stops being a volley and
 * becomes a ragged sequence of individual shots.
 *
 * @param now   ctx.currentTime of this event
 * @param burst seconds within which two shots count as the same volley
 */
export function nextStagger(
  state: StaggerState,
  now: number,
  step: number,
  max: number,
  burst: number,
): StaggerState {
  // a shot outside the burst window starts a new volley, at zero delay
  if (!(now - state.last <= burst)) return { last: now, delay: 0 };
  return { last: now, delay: Math.min(Math.max(0, max), state.delay + Math.max(0, step)) };
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
