/**
 * THE SPEEDBOAT PLAYER INPUT (§T.182 S2, design doc §3). One plain record per FIXED tick: what the sim and the
 * assists read, and what an input log stores (§V2: same seed + the same BoatInput per tick ⟹ the same SimState).
 * Nothing here reads the DOM; `inputDevices.ts` owns the devices, `raceControls.ts` is the page's ControlSource.
 *
 * SIGNS (stated once so nobody rediscovers them):
 *  - throttle  +1 full ahead (W / RT), −1 full astern (S / LT). The assists map it onto the drive range.
 *  - steer     +1 = turn to the RIGHT (D / stick right) — the same sense as HullWater's steer and the page seam
 *              (`BoatControls.steer`): + yaws the bow toward body −x, which is starboard (body +x is port).
 *  - trim      +1 = trim OUT, bow UP (↓ / right stick pulled back, flight-stick sense), −1 = trim IN, bow down.
 *              `invertTrim` flips the stick only, never the meaning of the number.
 */
export interface BoatInput {
  /** −1 (astern) … +1 (ahead) */
  throttle: number;
  /** −1 (left) … +1 (right) */
  steer: number;
  /** −1 (bow down, trim in) … +1 (bow up, trim out) */
  trim: number;
  /** Surge held this tick — or tapped since the last tick (a tap shorter than a tick is latched, not lost) */
  surge: boolean;
  /** held: look back (chase cams turn round; cockpit shows the hoop mirror) */
  lookBack: boolean;
  /** true on the ONE tick the reset hold completes (hold ≥ `resetHoldSeconds`) */
  reset: boolean;
  /** 0…1 progress of the reset hold, for the HUD ring (0 when not held) */
  resetHold: number;
  /** true on the ONE tick a camera-cycle press is consumed (render side reads it; harmless in the log) */
  cameraCycle: boolean;
  /** true on the ONE tick a pause press is consumed */
  pause: boolean;
}

export function neutralBoatInput(): BoatInput {
  return { throttle: 0, steer: 0, trim: 0, surge: false, lookBack: false, reset: false, resetHold: 0, cameraCycle: false, pause: false };
}

export function copyBoatInput(src: Readonly<BoatInput>, out: BoatInput = neutralBoatInput()): BoatInput {
  out.throttle = src.throttle;
  out.steer = src.steer;
  out.trim = src.trim;
  out.surge = src.surge;
  out.lookBack = src.lookBack;
  out.reset = src.reset;
  out.resetHold = src.resetHold;
  out.cameraCycle = src.cameraCycle;
  out.pause = src.pause;
  return out;
}
