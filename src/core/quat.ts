/**
 * Minimal vec3/quaternion helpers — ONE implementation for every mode (§V95).
 * §V.3: the sim layer stays engine-free (no three.js) so it runs headless
 * and byte-identical for future netcode. Quaternions are [x, y, z, w],
 * matching ShipState.quaternion; all quats here are assumed unit-length.
 *
 * Lived in `combat/quatMath.ts` until §T.113. Nothing here is combat — it is
 * arithmetic — and §V.81 keeps the raft entry out of `src/combat/`, so the
 * raft had grown its own copy of quatMul/quatFromAxisAngle/rotateVec (§B71).
 * `src/core` is neutral ground: pirate, raft and harness all import it, and
 * the forbidden-import list stays exactly as strict as it was.
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

/** Hamilton product a⊗b: rotation that applies b first, then a. */
export function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Unit quaternion from a normalized axis and an angle in radians. */
export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const h = angle / 2;
  const s = Math.sin(h);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
}

/**
 * Unit quaternion from XYZ-order Euler radians — the convention
 * `PieceTransform.rotation` uses (three's Object3D.rotation default order),
 * so q = qx ⊗ qy ⊗ qz reproduces what the assembly puts in the scene graph.
 */
export function quatFromEulerXYZ(e: Vec3): Quat {
  const [x, y, z] = e;
  const cx = Math.cos(x / 2);
  const sx = Math.sin(x / 2);
  const cy = Math.cos(y / 2);
  const sy = Math.sin(y / 2);
  const cz = Math.cos(z / 2);
  const sz = Math.sin(z / 2);
  return [
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  ];
}
