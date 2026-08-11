/**
 * Minimal vec3/quaternion helpers for the combat sim.
 * §V.3: the sim layer stays engine-free (no three.js) so it runs headless
 * and byte-identical for future netcode. Quaternions are [x, y, z, w],
 * matching ShipState.quaternion; all quats here are assumed unit-length.
 */
import type { Quat, Vec3 } from '../state/simState';

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

export function length(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

export function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

/** Rotate v by unit quaternion q: v' = v + w*t + cross(q.xyz, t), t = 2*cross(q.xyz, v). */
export function rotateVec(q: Quat, v: Vec3): Vec3 {
  const [qx, qy, qz, qw] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}

/** Rotate v by the inverse of unit quaternion q (conjugate = inverse for unit quats). */
export function invRotateVec(q: Quat, v: Vec3): Vec3 {
  return rotateVec([-q[0], -q[1], -q[2], q[3]], v);
}

/** Unit quaternion from a normalized axis and an angle in radians. */
export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const h = angle / 2;
  const s = Math.sin(h);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
}
