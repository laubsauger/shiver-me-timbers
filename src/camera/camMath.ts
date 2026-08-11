/**
 * Pure math helpers for the follow camera (T10). NO three.js imports —
 * this half is unit-testable headless; followCam.ts owns the render-side
 * three objects. All tunables come in as arguments (§V.16 keeps the values
 * themselves in params/camera.ts).
 */

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Frame-rate-independent exponential smoothing factor: the remaining
 * distance to the target halves every `halfLife` seconds regardless of dt.
 * halfLife <= 0 snaps (factor 1).
 */
export function dampFactor(halfLife: number, dt: number): number {
  if (halfLife <= 0) return 1;
  return 1 - Math.pow(0.5, dt / halfLife);
}

/** Move current toward target by the half-life damp factor. Never overshoots. */
export function expDamp(current: number, target: number, halfLife: number, dt: number): number {
  return current + (target - current) * dampFactor(halfLife, dt);
}

/** Wrap an angle to (-π, π]. */
export function wrapAngle(a: number): number {
  const TAU = Math.PI * 2;
  let x = a % TAU;
  if (x <= -Math.PI) x += TAU;
  else if (x > Math.PI) x -= TAU;
  return x;
}

/** expDamp on an angle, taking the shortest way around the circle. */
export function dampAngle(current: number, target: number, halfLife: number, dt: number): number {
  return current + wrapAngle(target - current) * dampFactor(halfLife, dt);
}

/**
 * Orbit offset from pivot to camera. yaw 0, pitch 0 → radius along +z;
 * positive pitch raises the camera (looking down at the pivot).
 */
export function sphericalOffset(
  yaw: number,
  pitch: number,
  radius: number,
): [number, number, number] {
  const c = Math.cos(pitch);
  return [Math.sin(yaw) * c * radius, Math.sin(pitch) * radius, Math.cos(yaw) * c * radius];
}

/**
 * Enforce the never-below-water rule: given a candidate camera y and the
 * ocean height at (x, z) — sea-physics provides the sampler; a 0-plane
 * default stands in when absent — return a y at least minAbove over water.
 */
export function enforceMinHeight(
  candidateY: number,
  x: number,
  z: number,
  minAbove: number,
  heightFn?: (x: number, z: number) => number,
): number {
  const water = heightFn ? heightFn(x, z) : 0;
  return Math.max(candidateY, water + minAbove);
}
