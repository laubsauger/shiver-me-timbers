/**
 * Ship buoyancy (§V.8): probe points sample the CPU ocean mirror — the
 * same seeded spectrum the GPU renders — so ships ride the visible waves.
 * Engine-free plain-data physics (§V.3), fixed-dt semi-implicit Euler
 * (§V.2). Righting roll/pitch torque emerges from the probe geometry:
 * the deeper side pushes harder, no separate metacentric model needed.
 *
 * Ship body frame matches the proc ship (§V.13): forward +z, beam x, up y.
 */
import { rotateVec, invRotateVec } from '../combat/quatMath';
import type { Quat, ShipState, Vec3 } from '../state/simState';
import { GRAVITY } from '../ocean/oceanMath';
import { seaPhysicsParams, type SeaPhysicsParams } from '../params/seaPhysics';
import type { CpuOcean } from './cpuOcean';

/**
 * Canonical probe layout for a ~30 m hull at probeLayoutScale 1, on the
 * ship-local waterline plane (y=0): 4 corners + bow/stern + 2 midship.
 * Spread (not count) is the tunable — 8 points is enough to feel roll,
 * pitch and heave from swell-length waves.
 */
export const PROBE_LAYOUT: readonly Vec3[] = [
  [-3.6, 0, 13],
  [3.6, 0, 13],
  [-3.6, 0, -13],
  [3.6, 0, -13],
  [0, 0, 15],
  [0, 0, -15],
  [-4, 0, 0],
  [4, 0, 0],
];

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** Hamilton product a·b — quatMath (reused above) has no multiply yet */
function quatMultiply(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/** integrate world-space angular velocity into the orientation quat */
function integrateQuat(q: Quat, w: Vec3, dt: number): Quat {
  const dq = quatMultiply([w[0], w[1], w[2], 0], q);
  const out: Quat = [
    q[0] + 0.5 * dt * dq[0],
    q[1] + 0.5 * dt * dq[1],
    q[2] + 0.5 * dt * dq[2],
    q[3] + 0.5 * dt * dq[3],
  ];
  const len = Math.hypot(out[0], out[1], out[2], out[3]);
  return [out[0] / len, out[1] / len, out[2] / len, out[3] / len];
}

/**
 * One fixed-dt buoyancy step, mutating ship position/quaternion/velocity/
 * angularVelocity in place. Caller must have advanced `ocean.update(time)`
 * for this tick first (heights are read at ocean.currentTime).
 */
export function stepShipBuoyancy(
  ship: ShipState,
  ocean: CpuOcean,
  dt: number,
  p: SeaPhysicsParams = seaPhysicsParams,
): void {
  const q = ship.quaternion;
  const pos = ship.position;
  const vel = ship.velocity;
  const w = ship.angularVelocity;

  const time = ocean.currentTime;
  if (Number.isNaN(time)) {
    // fail loud: silently floating on a never-computed sea hides V8 bugs
    throw new Error('stepShipBuoyancy: call ocean.update(time) first');
  }

  const force: Vec3 = [0, -p.mass * GRAVITY, 0];
  const torque: Vec3 = [0, 0, 0];

  for (const local of PROBE_LAYOUT) {
    const r = rotateVec(q, [
      local[0] * p.probeLayoutScale,
      local[1] * p.probeLayoutScale,
      local[2] * p.probeLayoutScale,
    ]);
    const px = pos[0] + r[0];
    const py = pos[1] + r[1];
    const pz = pos[2] + r[2];
    const depth = ocean.heightAt(px, pz, time) - py;
    if (depth <= 0) continue;
    // vertical velocity of the probe point = v.y + (ω × r).y
    const vy = vel[1] + (w[2] * r[0] - w[0] * r[2]);
    const f = p.buoyancySpring * depth - p.buoyancyDamping * vy;
    force[1] += f;
    const t = cross(r, [0, f, 0]);
    torque[0] += t[0];
    torque[1] += t[1];
    torque[2] += t[2];
  }

  // semi-implicit Euler: velocity first, then position from new velocity
  vel[0] += (force[0] / p.mass) * dt;
  vel[1] += (force[1] / p.mass) * dt;
  vel[2] += (force[2] / p.mass) * dt;
  pos[0] += vel[0] * dt;
  pos[1] += vel[1] * dt;
  pos[2] += vel[2] * dt;

  // diagonal inertia lives in the body frame: world→body, apply, body→world
  const tBody = invRotateVec(q, torque);
  const wBody = invRotateVec(q, w);
  wBody[0] += (tBody[0] / p.inertiaPitch) * dt;
  wBody[1] += (tBody[1] / p.inertiaYaw) * dt;
  wBody[2] += (tBody[2] / p.inertiaRoll) * dt;
  const wWorld = rotateVec(q, wBody);
  const decay = Math.max(0, 1 - p.angularDamping * dt);
  w[0] = wWorld[0] * decay;
  w[1] = wWorld[1] * decay;
  w[2] = wWorld[2] * decay;

  ship.quaternion = integrateQuat(q, w, dt);
}
