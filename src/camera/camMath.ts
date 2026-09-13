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

/**
 * expDamp toward a MOVING target, exact for a target that moves linearly
 * across the step (first-order hold): `prevTarget` is where the target was at
 * the start of the step, `target` where it is at the end.
 *
 * WHY NOT expDamp. expDamp treats the target as if it had sat at its END
 * value for the whole step, so a chase of a target moving at speed v settles
 * at a lag of about v·(halfLife/ln2 − dt/2): the lag depends on the frame
 * time. The render rate is not steady (50–100 fps is normal, and it drops
 * exactly when the wake is on screen), so the chase distance breathed in and
 * out with it — at 5 m/s, 99 mm of camera error at 50 fps vs 35 mm at 100 fps,
 * the hull sliding a few pixels fore and aft every time the frame time moved.
 * Integrating the same first-order lag exactly over a ramping target makes
 * the steady lag v·halfLife/ln2 at ANY dt, so the camera path depends on
 * scene time only, not on how the frames partition it.
 *
 * A still target (prevTarget === target) reduces to expDamp exactly, and a
 * first-order lag never overshoots a monotone input, so this cannot ring.
 */
export function dampMoving(
  current: number,
  prevTarget: number,
  target: number,
  halfLife: number,
  dt: number,
): number {
  if (halfLife <= 0) return target;
  if (dt <= 0) return current;
  const tau = halfLife / Math.LN2;
  const e = Math.exp(-dt / tau);
  // 1 − e, accurate when dt ≪ tau
  const oneMinusE = -Math.expm1(-dt / tau);
  return target + (current - prevTarget) * e - (target - prevTarget) * (tau / dt) * oneMinusE;
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
 * `prevBehind` is last frame's stern heading: the chase is integrated over
 * the heading's motion across the frame (dampMoving), so the lag in a turn
 * does not change with the frame time. Omitted, the heading is treated as
 * still.
 * Returns [yaw, offset].
 */
export function stepFollowYaw(
  yaw: number,
  offset: number,
  behind: number,
  dragging: boolean,
  halfLife: number,
  dt: number,
  prevBehind: number = behind,
): [number, number] {
  if (dragging) return [yaw, wrapAngle(yaw - behind)];
  // unwrap both target samples next to the current yaw, shortest way round
  const from = yaw + wrapAngle(prevBehind + offset - yaw);
  const to = from + wrapAngle(behind - prevBehind);
  return [dampMoving(yaw, from, to, halfLife, dt), offset];
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
