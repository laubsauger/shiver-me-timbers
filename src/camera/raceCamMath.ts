/**
 * Pure math for the speedboat race camera (§T.182, `raceCam.ts`). NO three.js. Everything here is exact for any
 * frame time (closed forms or rate limits), so the camera path is a function of scene time, not of how frames
 * partition it (§T.167).
 *
 * QUATERNION-SAFE. Nothing here converts the hull pose to Euler angles. The chase heading is read from a horizontal
 * PROJECTION of the hull's forward axis only while that projection is long (|fwd_xz| > 0.5), otherwise from the
 * velocity, otherwise held — so a bow pointing straight up, a barrel roll or an inverted hull cannot swing it.
 * (followCam's `atan2(fwd.x, fwd.z)` flips 180° as the bow passes vertical: tech-research §7.)
 */

import { rotateVec } from '../core/quat';
import type { Quat } from '../state/simState';
import { wrapAngle } from './camMath';

export type V3 = readonly [number, number, number] | { readonly 0: number; readonly 1: number; readonly 2: number };
export type Q4 = readonly [number, number, number, number];

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = x <= e0 ? 0 : x >= e1 ? 1 : (x - e0) / (e1 - e0);
  return t * t * (3 - 2 * t);
}

export function moveToward(cur: number, target: number, maxDelta: number): number {
  const d = target - cur;
  return d > maxDelta ? cur + maxDelta : d < -maxDelta ? cur - maxDelta : target;
}

/** speed FOV (design §6: chase 60→76°, near 68→82°, cockpit 72→86°) over tech-research §7's 15–45 m/s ramp */
export function speedFov(speed: number, fovMin: number, fovMax: number, v0 = 15, v1 = 45): number {
  return fovMin + (fovMax - fovMin) * smoothstep(v0, v1, Number.isFinite(speed) ? speed : 0);
}

/** hull heading (yaw of body +z) when its horizontal projection is long enough to mean something, else null */
export function hullYaw(q: Q4, minHorizontal = 0.5): number | null {
  const f = rotateVec(q as Quat, [0, 0, 1]);
  const h = Math.hypot(f[0], f[2]);
  return h > minHorizontal ? Math.atan2(f[0], f[2]) : null;
}

export function velocityYaw(v: V3, minSpeed = 2): number | null {
  return Math.hypot(v[0], v[2]) > minSpeed ? Math.atan2(v[0], v[2]) : null;
}

/**
 * Heading the chase aims along: hull yaw weighted by `hullWeight` (1 = wet and hull heading valid), velocity yaw for
 * the rest; whichever is missing is replaced by the other; both missing ⇒ `hold`.
 */
export function blendHeading(hull: number | null, vel: number | null, hullWeight: number, hold: number): number {
  if (hull === null && vel === null) return hold;
  if (hull === null) return vel as number;
  if (vel === null) return hull;
  return vel + wrapAngle(hull - vel) * hullWeight;
}

/**
 * Ballistic touchdown of a point at height y above water level `waterY`: seconds and horizontal point. Rising or
 * falling; below the water ⇒ t = 0.
 */
export function ballisticLanding(p: V3, v: V3, waterY: number, g = 9.81): { t: number; x: number; z: number } {
  const h = p[1] - waterY;
  const t = h <= 0 ? 0 : (v[1] + Math.sqrt(v[1] * v[1] + 2 * g * h)) / g;
  return { t, x: p[0] + v[0] * t, z: p[2] + v[2] * t };
}

/**
 * Critically damped spring toward 0, advanced EXACTLY by dt: x(t) = (x0 + (v0 + ωx0)t)e^(−ωt). Returns [x, v].
 * Exact ⇒ the same kick settles the same way at 50 or 100 fps.
 */
export function criticalSpring(x: number, v: number, omega: number, dt: number): [number, number] {
  if (dt <= 0) return [x, v];
  const e = Math.exp(-omega * dt);
  const c = v + omega * x;
  return [(x + c * dt) * e, (v - omega * c * dt) * e];
}

/**
 * Bounded deterministic shake: two incommensurate sines per axis at time t, scaled by amplitude (rad). |out| ≤ amp
 * per axis, zero-mean, the same for the same t. Returns [yaw, pitch] offsets.
 */
export function shakeOffsets(t: number, amp: number): [number, number] {
  const a = amp * 0.5;
  return [a * (Math.sin(t * 37.1) + Math.sin(t * 23.3 + 1.7)), a * (Math.sin(t * 31.7 + 0.4) + Math.sin(t * 19.9 + 2.9))];
}

/**
 * TILT of a hull (angle between its up axis and world up, 0…π) and the horizontal axis that tilt is about
 * (Ŷ × up, normalised). At 0 or π the axis is undefined: `fallback` (a unit horizontal vector) is returned.
 */
export function tiltOf(q: Q4, fallback: readonly [number, number, number]): { angle: number; axis: [number, number, number] } {
  const u = rotateVec(q as Quat, [0, 1, 0]);
  const angle = Math.acos(u[1] < -1 ? -1 : u[1] > 1 ? 1 : u[1]);
  // Ŷ × u = (u_z, 0, −u_x)
  const ax = u[2];
  const az = -u[0];
  const l = Math.hypot(ax, az);
  if (l < 1e-6) return { angle, axis: [fallback[0], fallback[1], fallback[2]] };
  return { angle, axis: [ax / l, 0, az / l] };
}

/**
 * CRASH CAM GATE (design §6: player only, 0.35× for 1.2 s, skippable, 20 s cooldown). Pure bookkeeping on the
 * scene clock; the page applies the time scale to the sim, the camera never changes time.
 */
export const CRASH_SLOWMO_SCALE = 0.35;
export const CRASH_SLOWMO_SECONDS = 1.2;
export const CRASH_COOLDOWN_SECONDS = 20;

export function crashCamAllowed(now: number, lastCrashCam: number | null): boolean {
  return lastCrashCam === null || now - lastCrashCam >= CRASH_COOLDOWN_SECONDS;
}

export function crashTimeScale(sinceCrash: number, skipped: boolean): number {
  return !skipped && sinceCrash >= 0 && sinceCrash < CRASH_SLOWMO_SECONDS ? CRASH_SLOWMO_SCALE : 1;
}
