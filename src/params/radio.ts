/**
 * §T.103 / §V86 — THE RADIO'S NUMBERS.
 *
 * The dial is the game's main interface (design doc §05: "the dial is the
 * map"), and everything about how it behaves is here rather than in the tuner,
 * so a designer can move the band, widen the window or slow the lock without
 * touching a function. §V86 is what these serve: clarity is a narrow window on
 * |Δf|, strength is a distance falloff times a cardioid on the raft's heading,
 * night roughly doubles the range, and a lock needs dwell and releases with
 * hysteresis.
 *
 * BAND. Shortwave broadcast, 3–30 MHz, and the slice sits in the 41 m band the
 * real Kon-Tiki's operators worked [ref §6: "NC-173 receiver, 6 W
 * transmitters"]. The numbers are EST — nothing in the reference fixes them —
 * but the SHAPE is not: a station has to be findable by sweeping and lose-able
 * by drifting, which is what `channelWidth` against `bandMHz` decides.
 */
export interface RadioParams {
  /** the dial's low end, MHz — channel 0 */
  bandLowMHz: number;
  /** the dial's high end, MHz — channel 1 */
  bandHighMHz: number;
  /**
   * MHz either side of a station where anything is audible at all. Outside it
   * clarity is exactly 0, which is what makes the dial a search rather than a
   * slider with a bias.
   */
  channelWidth: number;
  /**
   * How square the clarity window is: 1 = a cosine hump, higher = a flatter
   * top with steeper skirts, so the station has a "spot" you sit in.
   */
  channelShape: number;
  /** m at which a day signal has fallen to half. Night doubles it. */
  halfRangeM: number;
  /** the range multiplier after dusk — shortwave propagates better at night */
  nightRangeMult: number;
  /**
   * The aerial's cardioid: 0 = omnidirectional, 1 = a full null astern. The
   * wire runs fore-and-aft along the mast, so pointing the raft at a station
   * is what brings it up.
   */
  cardioidDepth: number;
  /** signal (clarity × strength) a station must beat to start locking */
  lockThreshold: number;
  /** …and how far below the threshold it must fall to let go again */
  lockHysteresis: number;
  /** seconds it must hold above the threshold before it locks */
  lockDwellSec: number;
  /** the static bed's gain when there is no signal at all */
  staticGain: number;
  /** …and the fraction of it that survives a perfect lock */
  staticFloor: number;
  /** the static bed's lowpass corner, Hz, off-station → on-station */
  staticHissHz: number;
  staticVoiceHz: number;
  /**
   * The noise loop's playback RATE off-station → on-station. §T.150 asks for
   * "the static changes pitch or volume with the tuning channel", and pitch is
   * the half a player hears first: sweeping past a station drags the hiss down
   * as well as closing it in, which is what a superhet actually sounds like.
   */
  staticRateOff: number;
  staticRateOn: number;
  /** the fragment player's gain at full signal */
  voiceGain: number;
  /** seconds between fragments while a station is held */
  fragmentGapSec: number;
}

import { registerParams, type ParamMeta } from './registry';

const m = (min: number, max: number, step = 0.01): ParamMeta => ({ min, max, step });

/**
 * §V16 — REGISTERED, so every number above is a live slider in the debug panel
 * rather than a constant someone has to rebuild to try. The radio is the one
 * system whose feel nobody can reason about from a source file: how wide a
 * window feels findable, how deep a cardioid feels like a skill and how long a
 * dwell feels like a lock are all things you turn a knob to find out.
 */
export const radioParams: RadioParams = registerParams('radio', {
  bandLowMHz: 6.0, // EST — the 49/41 m broadcast bands
  bandHighMHz: 7.6, // EST
  channelWidth: 0.09, // EST — ~18 windows across the dial: a sweep finds them, a nudge loses them
  channelShape: 1.7, // EST
  halfRangeM: 2600, // EST — the Sierra slice is a few km across
  nightRangeMult: 2, // §V86: night doubles the range
  cardioidDepth: 0.62, // EST — a real null astern would make the mode a chore
  lockThreshold: 0.34, // EST
  lockHysteresis: 0.08, // EST
  lockDwellSec: 2, // design doc §05: "above it for two seconds, the station locks"
  staticGain: 0.5, // EST
  staticFloor: 0.06, // EST
  staticHissHz: 2400, // EST — off-station is thin white hiss
  staticVoiceHz: 700, // EST — on-station it closes down onto the voice band
  staticRateOff: 1, // EST
  staticRateOn: 0.72, // EST — a fifth of an octave down, plainly audible in a sweep
  voiceGain: 0.85, // EST
  fragmentGapSec: 9, // EST
} satisfies RadioParams, {
  bandLowMHz: m(3, 30, 0.1),
  bandHighMHz: m(3, 30, 0.1),
  channelWidth: m(0.01, 0.5, 0.005),
  channelShape: m(0.5, 6, 0.1),
  halfRangeM: m(200, 20000, 50),
  nightRangeMult: m(1, 4, 0.05),
  cardioidDepth: m(0, 1),
  lockThreshold: m(0.02, 0.95),
  lockHysteresis: m(0, 0.4, 0.005),
  lockDwellSec: m(0, 10, 0.1),
  staticGain: m(0, 1),
  staticFloor: m(0, 1),
  staticHissHz: m(200, 8000, 50),
  staticVoiceHz: m(200, 8000, 50),
  staticRateOff: m(0.25, 3),
  staticRateOn: m(0.25, 3),
  voiceGain: m(0, 2),
  fragmentGapSec: m(1, 60, 0.5),
});
