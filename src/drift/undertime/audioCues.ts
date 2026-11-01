/**
 * THE SOUNDTRACK'S CUES, as Act 1 reads them (the 2026-11-01 brief: "big collisions on hits, the wave's start on a
 * swell, its crest at the zenith on the biggest peak, the text entries on calm moments").
 *
 * Mark's score (drift_audio.wav, 770.47 s) is locked to the timeline: the beats never move for it. What moves are the
 * events INSIDE the beats, onto the music's own moments. Those moments come from a baked table, audioCues.json, which
 * scripts/drift-audio-cues.py measures from the file (spectral flux, the RMS envelope, onsets, swells, peaks; run it
 * again if the mix changes). Nothing here listens to audio: every query is a pure function of its arguments and the
 * table, so a frame stays a pure function of show time t, on any machine, in any lane.
 *
 * The queries are WINDOWED on purpose: each event says where in its beat it may sit (the window its old fixed time sat
 * in the middle of), and the music picks the moment inside it. With no cue in a window the event keeps its old time,
 * so a different mix can move events but never break the act.
 */
import cues from './audioCues.json';

export interface Onset {
  /** show s */
  t: number;
  /** 0..1 how far the spectral flux rose over its moving threshold */
  strength: number;
  /** 0..1 the low band's (< 200 Hz) part in it: the body of a hit */
  low: number;
  /** dB, the level 0.25 s after against 0.25 s before */
  jump: number;
  /** 0..1 how much of a HIT it is: flux, low band and level jump together */
  hit: number;
}

export interface Swell {
  /** show s the rise starts and ends, and where it is steepest */
  t0: number;
  t1: number;
  steepest: number;
  /** dB */
  rise: number;
  strength: number;
}

export const ONSETS: readonly Onset[] = cues.onsets;
export const SWELLS: readonly Swell[] = cues.swells;
/** Hz the envelopes are sampled at */
const RATE = cues.envelopeRate;
const LEVEL: readonly number[] = cues.level;
const FLUX: readonly number[] = cues.flux;
/** show s the table covers */
export const CUES_END = cues.analysed[1];

const sample = (a: readonly number[], t: number): number => {
  const x = Math.min(a.length - 1, Math.max(0, t * RATE));
  const i = Math.min(a.length - 2, Math.floor(x));
  return a[i] + (a[i + 1] - a[i]) * (x - i);
};

/** 0..1 the music's loudness at show s t (0.4 s smoothing, normalised over the analysed span) */
export const levelAt = (t: number): number => sample(LEVEL, t);
/** 0..1 the spectral flux at show s t: how much is newly sounding */
export const fluxAt = (t: number): number => sample(FLUX, t);

/** the strongest hit in [t0, t1] with `hit` at least `min`, or null */
export function strongestHit(t0: number, t1: number, min = 0): Onset | null {
  let best: Onset | null = null;
  for (const o of ONSETS) if (o.t >= t0 && o.t <= t1 && o.hit >= min && (!best || o.hit > best.hit)) best = o;
  return best;
}

/** every hit in [t0, t1] of at least `min`, in time order */
export function hitsIn(t0: number, t1: number, min: number): Onset[] {
  return ONSETS.filter((o) => o.t >= t0 && o.t <= t1 && o.hit >= min);
}

/** the first swell that starts in [t0, t1], or null */
export function swellIn(t0: number, t1: number): Swell | null {
  return SWELLS.find((s) => s.t0 >= t0 && s.t0 <= t1) ?? null;
}

/**
 * The CALMEST moment in [t0, t1] to bring a line of text in on: the least level plus flux, averaged over the `look` s
 * after it (an entry reads as calm when what follows it is calm, not only its instant), on a 0.05 s grid. Ties go to
 * the earliest. Outside the table: t0 (the window's start, which is where the event would sit without the music).
 */
export function calmest(t0: number, t1: number, look = 1): number {
  if (t1 <= t0 || t0 > CUES_END) return t0;
  let best = t0;
  let score = Infinity;
  for (let t = t0; t <= t1 + 1e-9; t += 0.05) {
    let s = 0;
    for (let k = 0; k <= 10; k++) s += levelAt(t + (look * k) / 10) + fluxAt(t + (look * k) / 10);
    if (s < score - 1e-9) [score, best] = [s, t];
  }
  return Math.round(best * 100) / 100;
}
