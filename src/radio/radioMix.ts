/**
 * §T.103 — WHAT THE TUNER'S NUMBERS SOUND LIKE, as pure arithmetic.
 *
 * §V86 keeps `tuner.ts` free of audio; this keeps the audio free of decisions.
 * Everything between "the signal is 0.41" and "the bandpass sits at 1.4 kHz"
 * is here, so a test can drive a dial across the band and assert the static
 * CHANGED CHARACTER without a WebAudio context anywhere near it — which is
 * §B100's lesson in its own domain: assert what the world does, not that a
 * handler exists.
 *
 * The character (design doc §05: "Static fills the remainder of the gain"):
 * off-station is thin, wide hiss at full level; as a station comes up the bed
 * closes down onto the voice band, narrows (Q up), and drops toward
 * `staticFloor`, so the carrier and the voice arrive together the way they do
 * on a real receiver. The static NEVER reaches zero — a silent radio reads as
 * a broken radio.
 */
import { radioParams, type RadioParams } from '../params/radio';

export interface RadioMix {
  /** the noise bed's gain */
  staticGain: number;
  /** its lowpass corner, Hz — off-station is bright hiss, on-station closes onto the voice band */
  staticHz: number;
  /** …and the loop's playback rate, which is the pitch drag through a station */
  staticRate: number;
  /** the fragment player's gain */
  voiceGain: number;
}

function num(v: number, fallback = 0): number {
  return Number.isFinite(v) ? v : fallback;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function radioMix(signal: number, on: boolean, p: RadioParams = radioParams): RadioMix {
  const s = clamp01(num(signal));
  const floor = clamp01(num(p.staticFloor, 0.05));
  const bed = clamp01(num(p.staticGain, 0.5));
  return {
    staticGain: on ? bed * mix(1, floor, s) : 0,
    staticHz: Math.max(20, mix(num(p.staticHissHz, 2400), num(p.staticVoiceHz, 700), s)),
    staticRate: Math.max(0.05, mix(num(p.staticRateOff, 1), num(p.staticRateOn, 0.72), s)),
    voiceGain: on ? Math.max(0, num(p.voiceGain, 0.85)) * s : 0,
  };
}

/**
 * THE FRAGMENT SCHEDULER. A station that has locked plays one piece of its
 * pool, then another every `fragmentGapSec` for as long as you hold it —
 * "fragments drift in and out: a sentence, a laugh, a bell" (design doc §02).
 *
 * Held as an explicit value like `LockState`, for the same reason: the whole
 * of it can be driven in a loop by a test with no clock and no player.
 */
export interface FragmentState {
  /** the station the pool belongs to */
  station: string | null;
  /** seconds since the last piece started */
  since: number;
  /** how many have played from this station since it locked */
  played: number;
}

export const NO_FRAGMENT: FragmentState = { station: null, since: 0, played: 0 };

export interface FragmentStep {
  state: FragmentState;
  /** the index into the station's pool to start NOW, or null */
  play: number | null;
}

/**
 * @param locked the station holding the lock, or null
 * @param pool   how many pieces that station has (0 disables it)
 */
export function stepFragments(
  state: FragmentState,
  locked: string | null,
  pool: number,
  dt: number,
  p: RadioParams = radioParams,
): FragmentStep {
  const step = Math.max(0, num(dt));
  const n = Math.max(0, Math.floor(num(pool)));
  if (locked === null || n === 0) return { state: NO_FRAGMENT, play: null };
  // a NEW station speaks at once — that instant is the reward for finding it
  if (state.station !== locked) {
    return { state: { station: locked, since: 0, played: 1 }, play: 0 };
  }
  const since = state.since + step;
  const gap = Math.max(0.1, num(p.fragmentGapSec, 9));
  if (since < gap) return { state: { ...state, since }, play: null };
  const index = state.played % n;
  return { state: { station: locked, since: 0, played: state.played + 1 }, play: index };
}
