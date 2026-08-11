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
 * Yaw/pitch of a direction vector in the same convention sphericalOffset
 * uses: yaw 0 = +z, positive pitch = up. Inverse of
 * sphericalOffset(yaw, pitch, 1). Zero-length input → [0, 0].
 */
export function yawPitchFromDirection(x: number, y: number, z: number): [number, number] {
  const len = Math.hypot(x, y, z);
  if (len === 0) return [0, 0];
  return [Math.atan2(x, z), Math.asin(clamp(y / len, -1, 1))];
}

/**
 * Follow-mode yaw step. The user's angle is kept as an OFFSET from the
 * ship's stern heading, NOT as a world angle that gets re-centered: while
 * dragging we re-read the offset from the live yaw, otherwise we chase
 * `behind + offset`. Consequence (the whole point): a held orbit angle
 * survives indefinitely and only swings with the ship's turns — the camera
 * never crawls back to a default framing on its own.
 * Returns [yaw, offset].
 */
export function stepFollowYaw(
  yaw: number,
  offset: number,
  behind: number,
  dragging: boolean,
  halfLife: number,
  dt: number,
): [number, number] {
  if (dragging) return [yaw, wrapAngle(yaw - behind)];
  return [dampAngle(yaw, behind + offset, halfLife, dt), offset];
}

/**
 * Free-cam fly kinematics: exp-damp `vel` (mutated in place) toward
 * `target`, then hard-zero it once every component is under `stopEps`.
 * The snap is the point — a pure exponential never reaches zero, so an
 * idle free camera would creep forever (§V.3 debugging camera must HOLD
 * the pose the user parked it at).
 */
export function stepFly(
  vel: number[],
  target: readonly number[],
  halfLife: number,
  dt: number,
  stopEps: number,
): void {
  const k = dampFactor(halfLife, dt);
  let moving = false;
  for (let i = 0; i < 3; i++) {
    vel[i] += (target[i] - vel[i]) * k;
    if (Math.abs(vel[i]) > stopEps) moving = true;
  }
  if (!moving) vel[0] = vel[1] = vel[2] = 0;
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
