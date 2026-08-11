/**
 * stepShipSailing — arcade sailing kinematics on the water plane (T9).
 * §V.2: pure deterministic fixed-tick math, no randomness, no wall clock.
 * §V.3: sim-side — no three.js; mutates only ShipState plain data.
 *
 * SPLIT CONTRACT with buoyancy (src/sea-physics, T7 — not yet landed):
 * sailing owns yaw, heel-toward-wind, and PLANAR velocity/position only.
 * It never writes position[1] or velocity[1] — vertical float, pitch and
 * roll-restore belong to buoyancy. Until sea-physics exists, sailing
 * self-bounds heel by steering toward a clamped target angle; once
 * buoyancy lands, it must compose orientation from sailing's yaw/heel
 * rates instead of both systems writing the quaternion independently.
 *
 * Conventions: ship forward = local +z; yaw about +y, yaw 0 → world +z,
 * heading = [sin yaw, 0, cos yaw]; starboard = [cos yaw, 0, -sin yaw].
 * wind.direction is the direction the wind blows TOWARD (same convention
 * as yaw). Positive rudder (D) turns to starboard (yaw increases).
 */
import type { ShipState } from '../state/simState';
import type { InputState } from './input';
import { quatFromAxisAngle, quatMul, rotateVec } from '../combat/quatMath';
import { sailingParams, type SailingParams } from '../params/sailing';

export interface Wind {
  direction: number; // radians, blowing toward
  speed: number; // m/s
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function smoothstep01(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
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
  // --- decompose current orientation (yaw ∘ heel; pitch is buoyancy's) ---
  const fwd3 = rotateVec(ship.quaternion, [0, 0, 1]);
  const yaw = Math.atan2(fwd3[0], fwd3[2]);
  const right3 = rotateVec(ship.quaternion, [1, 0, 0]);
  let heel = Math.asin(clamp(right3[1], -1, 1));

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

  // --- planar velocity in ship frame: forward + lateral (leeway) ---
  const vx = ship.velocity[0];
  const vz = ship.velocity[2];
  let f = vx * fx + vz * fz;
  let l = vx * rx + vz * rz;
  const speed = Math.hypot(f, l);

  // semi-implicit Euler: quadratic hull drag opposes each component,
  // brake adds linear decel on forward way only
  f += (thrust - params.dragCoef * speed * f - (input.brake ? params.brakeDrag * f : 0)) * dt;
  l += -params.dragCoef * speed * l * dt;
  // keel grip: kill a frame-rate-scaled fraction of sideways velocity
  l *= Math.max(0, 1 - params.keelGrip * dt);

  ship.velocity[0] = f * fx + l * rx;
  ship.velocity[2] = f * fz + l * rz;
  ship.position[0] += ship.velocity[0] * dt;
  ship.position[2] += ship.velocity[2] * dt;

  // --- rudder: yaw rate ∝ forward speed, min steerage once under way ---
  const way = Math.abs(f);
  const steer =
    way < params.steerageSpeed
      ? 0
      : clamp(way / params.rudderRefSpeed, params.minSteerFactor, 1);
  const yawRate = ship.rudder * params.rudderRate * steer;
  const newYaw = yaw + yawRate * dt;
  ship.angularVelocity[1] = yawRate;

  // --- heel: bounded target ∝ lateral wind force on the set sail, exp
  // approach (self-righting stands in for buoyancy until T7 lands) ---
  const latWindForce = wind.speed * wind.speed * ship.sailTrim * (wx * rx + wz * rz);
  const targetHeel = clamp(-params.heelGain * latWindForce, -params.maxHeel, params.maxHeel);
  heel += (targetHeel - heel) * (1 - Math.exp(-params.heelResponse * dt));

  ship.quaternion = quatMul(
    quatFromAxisAngle([0, 1, 0], newYaw),
    quatFromAxisAngle([0, 0, 1], heel),
  );
}
