/**
 * ASSISTS: BoatInput + sim sample → drive commands (§T.182 S2). Pure and deterministic: the same inputs, settings and
 * state give the same commands on any machine (§V2), so the input log + preset replays the race. Nothing here writes
 * a force (§V106) — the hull is driven only by what `HullWater.setControls` and (pending) a drive trim input accept.
 *
 * Wired to the page by src/speedboat/controls/raceControls.ts (the seam's ControlSource). By hand, in the FIXED tick
 * before the rigid6 step:
 *   readBoatSim(hw, state, sim);
 *   const cmd = stepAssists(input, sim, settings, assistState, SIM_DT, hull.drives[0].maxSteerRad);
 *   hw.setControls(cmd.steerRad, cmd.throttle);   // cmd.trimRad: no HullWater input yet (docs/speedboat/controls.md)
 */
import type { BoatInput } from '../controls/boatInput';
import { createGovernorState, stepGovernor, type GovernorState } from './governor';
import type { AssistSettings } from './settings';
import type { BoatSimSample } from './simSample';
import { assistedLockRad, stepHelm } from './steering';
import { createTrimState, stepTrim, type TrimState } from './trim';

export * from './governor';
export * from './settings';
export * from './simSample';
export * from './steering';
export * from './trim';

/** HullWater.setControls throttle floor (reverse gear) */
export const REVERSE_THROTTLE = 0.3;
/** reverse engages only below this speed after the astern input has been held this long (tech-research §3.2) */
export const REVERSE_MAX_SPEED = 3;
export const REVERSE_HOLD_SECONDS = 0.3;

export interface DriveCommand {
  /** drive yaw, rad, HullWater sign (+ = bow toward body −x = starboard, the pilot's RIGHT) */
  steerRad: number;
  /** HullWater throttle, −0.3 … 1 */
  throttle: number;
  /** drive trim, rad, + = out / bow up */
  trimRad: number;
}

export interface AssistState {
  helmRad: number;
  /** seconds the astern input has been held */
  asternHeld: number;
  governor: GovernorState;
  trim: TrimState;
  /** the lock in force on the last step, rad (HUD / tests) */
  lockRad: number;
}

export function createAssistState(): AssistState {
  return { helmRad: 0, asternHeld: 0, governor: createGovernorState(), trim: createTrimState(), lockRad: 0 };
}

/** V108: forget per-location memory on teleport / respawn */
export function resetAssistState(st: AssistState): void {
  const fresh = createAssistState();
  st.helmRad = fresh.helmRad;
  st.asternHeld = fresh.asternHeld;
  st.governor = fresh.governor;
  st.trim = fresh.trim;
  st.lockRad = 0;
}

/**
 * Throttle lever → drive throttle. Ahead passes straight through; astern is "off" at speed and becomes reverse gear
 * (scaled to HullWater's −0.3 floor) only below 3 m/s after 0.3 s held — a tap of S at 80 kn must not put three
 * V8s into reverse.
 */
export function leverToThrottle(st: AssistState, lever: number, speed: number, dt: number): number {
  const l = lever < -1 ? -1 : lever > 1 ? 1 : lever;
  if (l >= 0) {
    st.asternHeld = 0;
    return l;
  }
  st.asternHeld += dt;
  return speed < REVERSE_MAX_SPEED && st.asternHeld >= REVERSE_HOLD_SECONDS ? l * REVERSE_THROTTLE : 0;
}

export function stepAssists(
  input: Readonly<BoatInput>,
  sim: Readonly<BoatSimSample>,
  settings: Readonly<AssistSettings>,
  st: AssistState,
  dt: number,
  driveLockRad: number,
  out: DriveCommand = { steerRad: 0, throttle: 0, trimRad: 0 },
): DriveCommand {
  st.lockRad = assistedLockRad(sim.speed, driveLockRad, settings.speedLimitedLock, sim.roll);
  st.helmRad = stepHelm(st.helmRad, input.steer, st.lockRad, (settings.helmRateDegPerS * Math.PI) / 180, dt);
  out.steerRad = st.helmRad;
  const lever = leverToThrottle(st, input.throttle, sim.speed, dt);
  out.throttle = stepGovernor(st.governor, settings.governor, lever, sim, dt);
  out.trimRad = stepTrim(st.trim, input.trim, sim, settings.landingAssist, dt);
  return out;
}
