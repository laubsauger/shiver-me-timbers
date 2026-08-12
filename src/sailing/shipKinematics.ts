/**
 * stepShipSailing — arcade sailing kinematics on the water plane (T9).
 * §V.2: pure deterministic fixed-tick math, no randomness, no wall clock.
 * §V.3: sim-side — no three.js; mutates only ShipState plain data.
 *
 * SPLIT CONTRACT with buoyancy (src/sea-physics, §B.6 fix):
 * sailing owns yaw — the angle AND the rate in angularVelocity[1], which
 * buoyancy leaves strictly alone — plus a wind-heel OFFSET on roll and
 * PLANAR velocity/position only. It never writes position[1]/velocity[1],
 * PRESERVES the pitch buoyancy integrated (recompose is yaw∘pitch∘roll,
 * never yaw∘heel),
 * and never relaxes total roll: wind heel is tracked separately and added
 * on top of the wave-roll component, so buoyancy's roll dynamics pass
 * through untouched. Buoyancy's pitch-memory workaround detects surviving
 * pitch (forward.y ≠ 0) and self-deactivates — no double-pitch.
 *
 * Conventions: ship forward = local +z; yaw about +y, yaw 0 → world +z,
 * heading = [sin yaw, 0, cos yaw]; starboard = [cos yaw, 0, -sin yaw].
 * wind.direction is the direction the wind blows TOWARD (same convention
 * as yaw). Positive rudder (D) turns to starboard (yaw increases).
 */
import type { Quat, ShipState } from '../state/simState';
import type { InputState } from './input';
import { quatFromAxisAngle, quatMul, rotateVec } from '../combat/quatMath';
import { groundGrip } from '../sea-physics/grounding';
import { sailingParams, type SailingParams } from '../params/sailing';

export interface Wind {
  direction: number; // radians, blowing toward
  speed: number; // m/s
}

/**
 * Wind-heel memory keyed by ShipState identity (plain-data state stays
 * untouched, §V.3 — same pattern as buoyancy's seaMemory). Derived cache
 * only: windHeel re-converges from ship+wind within ~1/heelResponse s, so
 * losing it (reload) costs a brief heel blend restart, nothing
 * sim-hash-relevant accumulates here. Deterministic under §V.2: its value
 * is a pure function of the tick-ordered ship+wind history.
 */
const heelMemory = new WeakMap<ShipState, { windHeel: number }>();

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function smoothstep01(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function wrapPi(a: number): number {
  let x = a % (Math.PI * 2);
  if (x <= -Math.PI) x += Math.PI * 2;
  else if (x > Math.PI) x -= Math.PI * 2;
  return x;
}

/**
 * Arcade sail efficiency vs angle off the eye of the wind (theta: 0 = head
 * to wind, π/2 = beam reach, π = running). Dead zone in irons, best at
 * beam/broad reach (sin peak), decent floor dead downwind.
 */
export function trimEfficiency(theta: number, params: SailingParams = sailingParams): number {
  const gate = smoothstep01((theta - params.deadZone) / params.deadZoneRamp);
  const shape = params.downwindEff + (1 - params.downwindEff) * Math.sin(theta);
  return gate * shape;
}

export function stepShipSailing(
  ship: ShipState,
  input: InputState,
  wind: Wind,
  dt: number,
  params: SailingParams = sailingParams,
): void {
  // --- decompose q = yaw(Y) ∘ pitch(X) ∘ roll(Z), Tait-Bryan y-x'-z''.
  // forward = [cos p·sin y, sin p, cos p·cos y] gives yaw+pitch directly
  // (|pitch| < π/2 for any floating hull, so cos p > 0 and atan2 is safe);
  // roll = residual rotation about local z after removing yaw∘pitch.
  const fwd3 = rotateVec(ship.quaternion, [0, 0, 1]);
  const pitch = Math.asin(clamp(fwd3[1], -1, 1));
  const yaw = Math.atan2(fwd3[0], fwd3[2]);
  // R_x(−pitch) maps forward [0,0,1] → [0, sin pitch, cos pitch] — same
  // sign convention as buoyancy's stored pitch (asin of forward.y)
  const qPitch = quatFromAxisAngle([1, 0, 0], -pitch);
  const qYP = quatMul(quatFromAxisAngle([0, 1, 0], yaw), qPitch);
  const qRes: Quat = quatMul([-qYP[0], -qYP[1], -qYP[2], qYP[3]], ship.quaternion);
  const roll = wrapPi(2 * Math.atan2(qRes[2], qRes[3]));

  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  const rx = fz; // starboard, planar
  const rz = -fx;

  // --- controls ---
  ship.rudder = clamp(input.rudder, -1, 1);
  ship.sailTrim = clamp(ship.sailTrim + input.sailTrimDelta * params.trimSpeed * dt, 0, 1);

  // --- sail thrust: windSpeed² · trimEfficiency(angle off wind) · trim ---
  const wx = Math.sin(wind.direction);
  const wz = Math.cos(wind.direction);
  const theta = Math.acos(clamp(-(fx * wx + fz * wz), -1, 1));
  const thrust =
    wind.speed * wind.speed * trimEfficiency(theta, params) * ship.sailTrim * params.thrustScale;

  // --- aground: the bank eats the drive before it ever reaches the water.
  // OWNERSHIP (§B.6, stated because this contract has been broken here
  // before): sea-physics/grounding owns the seabed reaction and writes only
  // the vertical channel, pitch/roll and a friction bleed on velocity — it
  // never touches thrust, yaw or the quaternion. Sailing owns the driving
  // force, so the force balance closes HERE and nowhere else. Grounding
  // publishes what the seabed can resist (μ·N/m, a deceleration) and this
  // subtracts it: a keel carrying the ship's weight simply cannot be pushed
  // along by canvas, however she is trimmed. It reads one tick behind
  // (main.ts runs sailing first), which at 60 Hz is invisible.
  const grip = groundGrip(ship, dt);
  const drive = thrust > grip ? thrust - grip : 0;

  // --- planar velocity in ship frame: forward + lateral (leeway) ---
  const vx = ship.velocity[0];
  const vz = ship.velocity[2];
  let f = vx * fx + vz * fz;
  let l = vx * rx + vz * rz;
  const speed = Math.hypot(f, l);

  // semi-implicit Euler: quadratic hull drag opposes each component,
  // brake adds linear decel on forward way only
  f += (drive - params.dragCoef * speed * f - (input.brake ? params.brakeDrag * f : 0)) * dt;
  l += -params.dragCoef * speed * l * dt;
  // keel grip: kill a frame-rate-scaled fraction of sideways velocity
  l *= Math.max(0, 1 - params.keelGrip * dt);

  ship.velocity[0] = f * fx + l * rx;
  ship.velocity[2] = f * fz + l * rz;
  ship.position[0] += ship.velocity[0] * dt;
  ship.position[2] += ship.velocity[2] * dt;

  // --- rudder: yaw rate ∝ forward speed, min steerage once under way.
  // The rudder sets a TARGET rate; the actual rate lags it with time
  // constant 1/yawResponse, because a few hundred tons of ship take
  // seconds to spin up about its own mast and seconds to stop. Momentum
  // lives in ship.angularVelocity[1] — sailing is its sole owner (§B.6,
  // buoyancy never writes it), so it is real sim state: centre the helm
  // mid-turn and the ship keeps swinging round before it settles.
  const way = Math.abs(f);
  const steer =
    way < params.steerageSpeed
      ? 0
      : clamp(way / params.rudderRefSpeed, params.minSteerFactor, 1);
  const targetYawRate = ship.rudder * params.rudderRate * steer;
  const yawRate =
    ship.angularVelocity[1] +
    (targetYawRate - ship.angularVelocity[1]) * (1 - Math.exp(-params.yawResponse * dt));
  const newYaw = yaw + yawRate * dt;
  ship.angularVelocity[1] = yawRate;

  // --- wind heel: bounded target ∝ lateral wind force on the set sail.
  // Applied as an OFFSET on top of the wave roll (roll − previous heel):
  // only sailing's own contribution is relaxed, buoyancy's roll survives.
  let mem = heelMemory.get(ship);
  if (mem === undefined) {
    mem = { windHeel: 0 };
    heelMemory.set(ship, mem);
  }
  const waveRoll = roll - mem.windHeel;
  const latWindForce = wind.speed * wind.speed * ship.sailTrim * (wx * rx + wz * rz);
  const targetHeel = clamp(-params.heelGain * latWindForce, -params.maxHeel, params.maxHeel);
  mem.windHeel += (targetHeel - mem.windHeel) * (1 - Math.exp(-params.heelResponse * dt));

  ship.quaternion = quatMul(
    quatFromAxisAngle([0, 1, 0], newYaw),
    quatMul(qPitch, quatFromAxisAngle([0, 0, 1], waveRoll + mem.windHeel)),
  );
}
