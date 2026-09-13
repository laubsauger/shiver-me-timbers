/**
 * DRIVE TRIM + LANDING ASSIST (design doc §3: trim is a PERSISTENT drive angle; landing assist 0.5 by default).
 *
 * TRIM. The stick/keys are a RATE: holding ↓ trims out (bow up) at `TRIM_RATE`, letting go leaves the drives where
 * they are. Range −6°…+8° (tech-research §3.1 trim axis). Rate 8°/s is ASSUMED (the full range in 1.75 s; tech-research
 * §3.2 proposed 4°/s, which measured too slow for the landing assist to act on a ramp face lasting ~0.5 s).
 *
 * LANDING ASSIST. Adds a trim OFFSET that nudges the drives toward the landing window (design §3 clean landing pitch
 * −2…+7°, centre 2.5°). It predicts the pitch at touchdown from the pitch rate and a ballistic time to land, and
 * commands trim against the error. Acts while the boat is RISING off a face (vy > 0.5 m/s) or airborne; decays back
 * to the player's trim otherwise. It never writes a force: the trim angle reaches the hull only through the drives.
 * Measured sensitivity (scratch T182, thrust-line emulation, 1.2–2 m ramps at C_v 6–10): −6° vs +8° of trim held
 * through the launch moves the landing pitch by 10–18°; the same through the air alone moves nothing, because a dry
 * prop makes no thrust — see docs/speedboat/controls.md "hooks" for the airborne trim authority the design wants.
 */
import { GRAVITY, type BoatSimSample } from './simSample';

const DEG = Math.PI / 180;
export const TRIM_MIN = -6 * DEG;
export const TRIM_MAX = 8 * DEG;
export const TRIM_RATE = 8 * DEG;
/** landing window centre (design §3: clean −2…+7°) */
export const LANDING_PITCH_CENTRE = 2.5 * DEG;
/** trim offset per radian of predicted landing-pitch error at dial 1 */
export const LANDING_GAIN = 1.5;
/** CG height above the surface when running on the plane, m — ballistic "landed" level (measured 0.3–0.4 m) */
export const PLANING_CG_HEIGHT = 0.35;

export interface TrimState {
  /** the player's persistent trim setpoint, rad */
  player: number;
  /** the drive angle actually commanded, rad: ONE actuator, slewed at TRIM_RATE toward player + assist offset */
  drive: number;
}

export function createTrimState(): TrimState {
  return { player: 0, drive: 0 };
}

/** ballistic seconds until the CG is back at planing height; 0 when not rising and not airborne */
export function timeToLand(sim: Readonly<BoatSimSample>): number {
  if (!sim.airborne) return sim.vy > 0.5 ? (2 * sim.vy) / GRAVITY : 0;
  const h = Math.max(0, sim.heightAboveWater - PLANING_CG_HEIGHT);
  return (sim.vy + Math.sqrt(sim.vy * sim.vy + 2 * GRAVITY * h)) / GRAVITY;
}

export function predictedLandingPitch(sim: Readonly<BoatSimSample>): number {
  return sim.pitch + sim.pitchRate * timeToLand(sim);
}

/** one trim step; returns the commanded drive trim angle, rad (+ = out, bow up) */
export function stepTrim(st: TrimState, stick: number, sim: Readonly<BoatSimSample>, landingAssist: number, dt: number): number {
  const s = stick < -1 ? -1 : stick > 1 ? 1 : stick;
  st.player = Math.min(TRIM_MAX, Math.max(TRIM_MIN, st.player + s * TRIM_RATE * dt));
  let offset = 0;
  const dial = landingAssist < 0 ? 0 : landingAssist > 1 ? 1 : landingAssist;
  if (dial > 0 && timeToLand(sim) > 0) {
    offset = -dial * LANDING_GAIN * (predictedLandingPitch(sim) - LANDING_PITCH_CENTRE);
  }
  const target = Math.min(TRIM_MAX, Math.max(TRIM_MIN, st.player + offset));
  const max = TRIM_RATE * dt;
  const d = target - st.drive;
  st.drive += d > max ? max : d < -max ? -max : d;
  return st.drive;
}
