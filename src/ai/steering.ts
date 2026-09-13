/**
 * Pure steering helpers for enemy AI (T19, §V.15).
 * §V.2/§V.3: deterministic plain math over SimState data — no three.js,
 * no side effects, safe for headless lockstep replay.
 *
 * Conventions (match ship blueprint + combat/cannons.ts, §V.13):
 *  - ship-local +z = bow, +x = starboard;
 *  - yaw θ ⇒ world forward [sin θ, 0, cos θ]; increasing yaw = turn to
 *    starboard; positive rudder = turn to starboard;
 *  - wind.direction = bearing the wind blows TOWARD, so dead upwind
 *    (the "no-go" bearing) = direction + π.
 */
import type { AiParams } from '../params/ai';
import { wrapAngle } from '../core/steering';

// §T.163: the mode-neutral heading helpers live in `core/steering` (§V95);
// re-exported so every pirate caller keeps importing them from here
export { wrapAngle, yawOf, bearingTo, headingError } from '../core/steering';

/** Proportional rudder with deadband, clamped to [-1, 1]. */
export function rudderFromError(error: number, p: AiParams): number {
  if (Math.abs(error) < p.rudderDeadband) return 0;
  return Math.max(-1, Math.min(1, error * p.rudderGain));
}

/**
 * Point-of-sail aware heading: if the desired heading sits inside the
 * irons cone around dead upwind, tack instead — hold the ~45°-off-wind
 * heading on the side the bow already points to. The tackHysteresis band
 * around the wind line keeps the choice from oscillating: the side only
 * flips once yaw has actually crossed the line by more than the band
 * (inside the band the stable desired-target side decides).
 */
export function resolveHeading(
  desiredYaw: number,
  currentYaw: number,
  windDirection: number,
  p: AiParams,
): number {
  const upwind = wrapAngle(windDirection + Math.PI);
  const offUpwind = wrapAngle(desiredYaw - upwind);
  if (Math.abs(offUpwind) >= p.ironsCone) return desiredYaw; // directly sailable
  const relYaw = wrapAngle(currentYaw - upwind);
  let side: number;
  if (Math.abs(relYaw) > p.tackHysteresis) side = relYaw >= 0 ? 1 : -1;
  else side = offUpwind !== 0 ? Math.sign(offUpwind) : 1;
  return wrapAngle(upwind + side * p.tackAngle);
}

/**
 * HOW MUCH CANVAS THE AI CREW SETS — all of it, at every point of sail. The
 * value is `AI_SAIL_TRIM` in stateMachine.ts; the point-of-sail throttle that
 * used to live here (`sailTrimFor`, minSailTrim → 1 across `fullTrimAngle`) is
 * gone, and the WHY is written down at that constant (§B88, §V77).
 */
