/**
 * ASSIST SETTINGS (§T.182 S2; design doc §3 "The Governor"; §T.179 USER DECISION 2026-09-13: keep the physics honest,
 * the default assist is a speed-limited lock so normal play never hooks by accident, Pro preset = all off).
 *
 * Every assist acts ONLY through the three drive commands (steer angle, throttle, trim angle). None of them writes a
 * force, a torque or a velocity: the hull does what those commands make it do (§V106, §V110 — an NPC on the same
 * commands feels the same sea and the same boat).
 */
export type GovernorMode = 'OFF' | 'AIR' | 'FULL';

export interface AssistSettings {
  /**
   * 0…1 blend from the drives' own lock (0, the raw physics) to the speed-limited lock curve (1,
   * `steering.ts` SAFE_LOCK_CURVE). Intermediate values interpolate the lock angle.
   */
  speedLimitedLock: number;
  /**
   * Helm actuator rate, deg/s at the drives. NOT a free feel knob: the steering envelope (physics-log T179 part 3,
   * re-measured in tests/speedboatAssist.test.ts) was taken with a 30°/s hydraulic helm, and the entry kick that
   * hooks her grows with it (C_v 10 at 12° of drive: steady at 30°/s, hooks at 120°/s).
   */
  helmRateDegPerS: number;
  /** throttle limiter: OFF · AIR (feather airborne / ventilating) · FULL (AIR + a throttle cap on landing) */
  governor: GovernorMode;
  /**
   * 0…1 landing assist: nudges the drive trim toward the landing pitch window (design: AIR applies 0.5). OFF in both
   * presets since §T.207: through the real trim path it has no directional authority (trim.ts header, measured).
   */
  landingAssist: number;
  /** design §3: auto reset on by default; read by the crash state machine (§T.188), not by these functions */
  autoReset: boolean;
}

export type AssistPresetName = 'default' | 'pro';

export const ASSIST_PRESETS: Readonly<Record<AssistPresetName, Readonly<AssistSettings>>> = Object.freeze({
  // §T.207: landingAssist 0 — the drive trim cannot steer the landing pitch (trim.ts header), so Default does not carry an
  // assist that only moves the drives (and, on every rising face in a sea, lifts the props out of the water).
  default: Object.freeze({ speedLimitedLock: 1, helmRateDegPerS: 30, governor: 'AIR', landingAssist: 0, autoReset: true }),
  // Pro = all assists off. The helm rate stays the physical actuator's (it is not an assist; see above).
  pro: Object.freeze({ speedLimitedLock: 0, helmRateDegPerS: 30, governor: 'OFF', landingAssist: 0, autoReset: false }),
});

export function assistPreset(name: AssistPresetName): AssistSettings {
  return { ...ASSIST_PRESETS[name] };
}
