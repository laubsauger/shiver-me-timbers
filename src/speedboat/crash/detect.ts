/**
 * CRASH DETECTION (§T.188; design doc §3; tech-research §4.1). Pure per tick: the crash kind whose physical
 * signature holds THIS tick, or null. Each threshold below is a documented number with the measurement it was set
 * against (docs/speedboat/crash.md), and tests/speedboatCrash.test.ts pins both edges with real physics: every kind
 * fires within 0.5 s of its physical onset, and a clean Working-sea run with assists Default fires nothing.
 *
 * The only memory is a 0.1 s speed history (deceleration); it is per boat and resets with the boat (V108).
 */
import { CONTACT_FLEXIBLE } from '../../sea-physics/boatCollide';
import type { CrashSensors } from './sensors';

export type CrashKind = 'hook' | 'stuff' | 'blowOver' | 'barrelRoll' | 'impact';

export const CRASH_KINDS: readonly CrashKind[] = ['impact', 'barrelRoll', 'blowOver', 'stuff', 'hook'];

export interface CrashThresholds {
  /**
   * HOOK = spin-out at racing speed, all four at once. Measured (full lock, 30°/s helm, flat water): at the
   * chine catch C_v 5 reads slip 39° / yaw 1.26 rad/s / heel 32°, C_v 8 slip 38° / 1.50 / 25°; a clean
   * Working-sea run peaks at slip 18° / 0.7 rad/s / heel 41° (never together); half lock C_v 3–6 peaks
   * slip 17° / 0.53 rad/s. The speed floor keeps the C_v 3 full-lock transient (12 m/s at 40° slip) a stumble.
   */
  hookSlipDeg: number;
  hookYawRate: number;
  hookHeelDeg: number;
  hookMinSpeed: number;
  /**
   * STUFF = green water over the foredeck AND the boat braking hard. Measured: a 30 m/s bow-down entry reads
   * 0.77 m / 1.4 g at 0.25 s and pitchpoles; a clean Working-sea run buries the bow 1.7 m once at < 1.5 g and
   * brakes 3.2 g once with the bow dry.
   */
  stuffBowImmersion: number;
  stuffDecelG: number;
  stuffMinSpeed: number;
  /** BLOW-OVER = bow-up pitch past the GDD's airborne crash angle (35°, clean-run peak 26°), or near-vertical any time */
  blowOverAirPitchDeg: number;
  blowOverPitchDeg: number;
  /** wetted area below which the hull is airborne, m² (planing at 43 m/s wets ≈ 4 m²) */
  airborneWettedArea: number;
  /** BARREL ROLL = heel or tilt past 110° (task; the clean run peaks at 44°) */
  barrelRollDeg: number;
  /** IMPACT = one collision |Δv| on this boat (tech-research §4.1: 8 m/s ≈ 15.5 kn); flexible poles never count */
  impactDeltaV: number;
}

export const CRASH_THRESHOLDS: Readonly<CrashThresholds> = Object.freeze({
  hookSlipDeg: 35,
  hookYawRate: 1.0,
  hookHeelDeg: 20,
  hookMinSpeed: 15,
  stuffBowImmersion: 0.4,
  stuffDecelG: 1.5,
  stuffMinSpeed: 12,
  blowOverAirPitchDeg: 35,
  blowOverPitchDeg: 75,
  airborneWettedArea: 0.5,
  barrelRollDeg: 110,
  impactDeltaV: 8,
});

/** deceleration window, ticks at 60 Hz (0.1 s) */
export const DECEL_WINDOW = 6;

export interface CrashDetectMemory {
  speeds: Float64Array;
  count: number;
  head: number;
  /** deceleration over the window, m/s² (positive = slowing), and the speed at the window start */
  decel: number;
  speedBefore: number;
}

export function createCrashDetectMemory(): CrashDetectMemory {
  return { speeds: new Float64Array(DECEL_WINDOW + 1), count: 0, head: 0, decel: 0, speedBefore: 0 };
}

export function resetCrashDetectMemory(m: CrashDetectMemory): void {
  m.count = 0;
  m.head = 0;
  m.decel = 0;
  m.speedBefore = 0;
}

const G = 9.81;

/** push this tick's speed; call once per tick before `detectCrash` */
export function updateCrashDetectMemory(m: CrashDetectMemory, s: Readonly<CrashSensors>, dt: number): void {
  const n = m.speeds.length;
  m.speeds[m.head] = s.speed;
  m.head = (m.head + 1) % n;
  if (m.count < n) m.count++;
  if (m.count === n) {
    // oldest sample is at head (the slot about to be overwritten)
    m.speedBefore = m.speeds[m.head];
    m.decel = (m.speedBefore - s.speed) / ((n - 1) * dt);
  } else {
    m.speedBefore = s.speed;
    m.decel = 0;
  }
}

export function isAirborne(s: Readonly<CrashSensors>, th: Readonly<CrashThresholds> = CRASH_THRESHOLDS): boolean {
  return s.wettedArea < th.airborneWettedArea;
}

/** each kind's condition on its own (tests and the HUD's warning read these) */
export function crashCondition(kind: CrashKind, s: Readonly<CrashSensors>, m: Readonly<CrashDetectMemory>, th: Readonly<CrashThresholds> = CRASH_THRESHOLDS): boolean {
  switch (kind) {
    case 'hook':
      return s.slipDeg >= th.hookSlipDeg && Math.abs(s.yawRate) >= th.hookYawRate && Math.abs(s.heelDeg) >= th.hookHeelDeg && s.groundSpeed >= th.hookMinSpeed;
    case 'stuff':
      return s.bowImmersion >= th.stuffBowImmersion && m.decel >= th.stuffDecelG * G && m.speedBefore >= th.stuffMinSpeed;
    case 'blowOver':
      return (isAirborne(s, th) && s.pitchDeg >= th.blowOverAirPitchDeg) || s.pitchDeg >= th.blowOverPitchDeg;
    case 'barrelRoll':
      return Math.abs(s.heelDeg) >= th.barrelRollDeg || s.tiltDeg >= th.barrelRollDeg;
    case 'impact':
      return s.contactDeltaV >= th.impactDeltaV && s.contactSource !== CONTACT_FLEXIBLE;
  }
}

/**
 * The crash this tick, or null. When several hold at once the most specific cause wins, in `CRASH_KINDS` order:
 * an impact explains the tumble that follows it, a roll-over explains the speed it loses, and so on.
 */
export function detectCrash(s: Readonly<CrashSensors>, m: Readonly<CrashDetectMemory>, th: Readonly<CrashThresholds> = CRASH_THRESHOLDS): CrashKind | null {
  for (const k of CRASH_KINDS) if (crashCondition(k, s, m, th)) return k;
  return null;
}
