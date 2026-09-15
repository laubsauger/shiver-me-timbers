/**
 * THE NPC PILOT'S PER-BOAT MEMORY LIVES IN THE SIM BUFFER (§T.186, §V2). Slot map of the AI block the sim layout
 * reserves after each boat's wake samples (`BoatSimLayout.aiOffset`).
 *
 * WHY IN THE BUFFER AND NOT IN WORKER MEMORY: the worker-side `RacePilot` holds only the immutable setup (lines,
 * profiles, archetypes). Everything that changes tick to tick — station on the line, PI integral, helm angle,
 * rng state, mistake/recovery timers, lateral offset, wave lift — is here. So:
 *  - the pilot's output is a function of (setup, this block, tick-k poses in WORLD, the sea at tick k) only, on
 *    every transport, whichever worker owns the boat (a pilot rebuilt mid-race continues bit-identically, tested);
 *  - it crosses a transport downgrade (sab → transfer → main) with the buffer, instead of silently resetting;
 *  - the V2 hash covers it (AI OUT is inside `outRange`), and the page can read it (HUD, radio, debug).
 *
 * AI IN is written by the main thread before `kick` from the race logic's `RacerStanding` (encodeStanding):
 * decisions come from sim state, never from the camera or the frame rate (§V106 wording in the task).
 */
import type { RacerStanding } from '../types';
import { AI_BLOCK_LEN, AI_IN_LEN, AI_OUT_LEN } from '../../sim-worker/layout';

/** stepper-written slots, relative to `aiOffset(i)` */
export const AI = {
  /** 1 once the pilot has projected the boat onto its line */
  INIT: 0,
  /** station as lap fraction, unwrapped (laps + fraction of the current line level) */
  STATION: 1,
  /** line level in use (0..LEVELS−1) */
  LEVEL: 2,
  /** throttle PI integral (m) */
  INTEGRAL: 3,
  /** applied drive angle, rad (+ = bow to port, hullWater convention) */
  STEER: 4,
  /** applied throttle −0.3..1 */
  THROTTLE: 5,
  /** requested trim (−1 bow down .. +1 bow up), the seam's unit trim; returned as `PilotOutput.trim` for `unitTrimToRad` */
  TRIM: 6,
  /** mulberry32 state (uint32 stored exactly in a double) */
  RNG: 7,
  MISTAKE_T: 8,
  MISTAKE_KIND: 9,
  RECOVERY_T: 10,
  /** effective risk this tick */
  RISK: 11,
  /** lateral offset from the line, m (+ = starboard) */
  OFFSET: 12,
  /** remaining seconds of the avoidance offset hold */
  AVOID_T: 13,
  /** 0..1 throttle lift from the wave read */
  WAVE_LIFT: 14,
  /** 1 while holding throttle for a jump the archetype chose */
  JUMP: 15,
  /** speed the profile asks for this tick */
  TARGET_SPEED: 16,
  /** signed cross-track error to the line, m (+ = boat to starboard of the line) */
  CROSS_TRACK: 17,
  /** ticks the pilot has run (wave read cadence) */
  TICKS: 18,
  /** 1 while blocking the inside */
  BLOCKING: 19,
  /** 1 while upset (capsized / crashed): throttle cut */
  UPSET: 20,
  /**
   * 0..1 wake brace (§T.213): another boat's wake crest across her path within 0.9 s — the helm lock is reduced by it so she
   * crosses it near upright. Decays over 0.5 s. Was RESPAWNED (a one-tick flag nothing read).
   */
  WAKE_BRACE: 21,
  /**
   * rolling-start clock: > 0 = seconds of rolling start counted (ticks with a rolling-start speed cap in GO, since the pace
   * boat began to move); < 0 = seconds of opening caution left after green (pilot.ts CAUTION_S); 0 on the grid and after.
   * Was HINT (the sample-index hint), now derived from STATION.
   */
  ROLL: 22,
  /** running mean of the predicted airtime ahead (s, ~4 s memory): how rough the water is here */
  SEA: 23,
} as const;

/** main-written slots, relative to `aiOffset(i) + AI_OUT_LEN` */
export const AI_IN = {
  /** 1 when a standing has been published for this tick */
  VALID: 0,
  POSITION: 1,
  RACERS: 2,
  LAP: 3,
  PROGRESS: 4,
  GAP_TO_LEADER: 5,
  /** RacerStanding.state as STATE_CODE */
  STATE: 6,
  /** 0 = hold at the pace speed cap (rolling start), 1 = racing; negative = speed cap in m/s while rolling */
  GO: 7,
} as const;

export const STATE_CODE: Readonly<Record<RacerStanding['state'], number>> = { racing: 0, crashed: 1, respawning: 2, ghost: 3, finished: 4 };

// the map must fit the bytes the layout reserves (static check, also asserted in tests)
const outSlots = Object.keys(AI).length;
const inSlots = Object.keys(AI_IN).length;
if (outSlots !== AI_OUT_LEN || inSlots !== AI_IN_LEN || AI_OUT_LEN + AI_IN_LEN !== AI_BLOCK_LEN) {
  throw new Error(`race/ai: AI block map ${outSlots}+${inSlots} does not match the layout ${AI_OUT_LEN}+${AI_IN_LEN}`);
}

/**
 * Write one racer's standing into AI IN. `go`: true = racing; a number = rolling-start speed cap (m/s), which is
 * a CAP only — it can slow a boat to the pace boat, it can never add speed (no rubber band, design doc §4).
 */
export function encodeStanding(f64: Float64Array, aiOffset: number, s: Readonly<RacerStanding>, racers: number, go: true | number): void {
  const o = aiOffset + AI_OUT_LEN;
  f64[o + AI_IN.VALID] = 1;
  f64[o + AI_IN.POSITION] = s.position;
  f64[o + AI_IN.RACERS] = racers;
  f64[o + AI_IN.LAP] = s.lap;
  f64[o + AI_IN.PROGRESS] = s.progress;
  f64[o + AI_IN.GAP_TO_LEADER] = s.gapToLeader;
  f64[o + AI_IN.STATE] = STATE_CODE[s.state];
  f64[o + AI_IN.GO] = go === true ? 1 : -Math.max(0, go);
}
