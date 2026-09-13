/**
 * What the assists may read from the sim (§V3 one-way: they read the boat's state and last contact result, never
 * write it). Filled once per fixed tick, BEFORE the assists run, from the rigid6 state and the HullWater result of
 * the previous tick's last substep. Plain numbers so an NPC controller or a replay can build one without a HullWater.
 */
import type { HullWater } from '../../sea-physics/hullWater';
import type { Rigid6State } from '../../sea-physics/rigidBody';

export const GRAVITY = 9.81;

export interface BoatSimSample {
  /** horizontal speed over the water, m/s */
  speed: number;
  /** pitch, rad, bow UP positive: asin(fwd·Ŷ) (physics-log convention) */
  pitch: number;
  /** pitch rate about the horizontal axis ⊥ heading, rad/s, bow-up positive */
  pitchRate: number;
  /** heel, rad: asin(x̂_body·Ŷ) (body +x is port; + = port side up) */
  roll: number;
  /** vertical velocity of the CG, m/s */
  vy: number;
  /** CG height above the water surface below it, m (patch height at the CG) */
  heightAboveWater: number;
  /** true when no hull triangle is wet AND no gearcase is in the water */
  airborne: boolean;
  /** mean prop immersion over the drives, 0 (dry) … 1 (buried) — HullWater.driveImmersion */
  propImmersion: number;
}

export function emptySimSample(): BoatSimSample {
  return { speed: 0, pitch: 0, pitchRate: 0, roll: 0, vy: 0, heightAboveWater: 0, airborne: false, propImmersion: 1 };
}

/** fill `out` from a rigid6 state and the HullWater that last evaluated it */
export function readBoatSim(hw: Readonly<HullWater>, s: Readonly<Rigid6State>, out: BoatSimSample = emptySimSample()): BoatSimSample {
  const [qx, qy, qz, qw] = s.quaternion;
  // body axes in world (columns of R)
  const fx = 2 * (qx * qz + qw * qy);
  const fy = 2 * (qy * qz - qw * qx);
  const fz = 1 - 2 * (qx * qx + qy * qy);
  const ry = 2 * (qx * qy + qw * qz);
  out.speed = Math.hypot(s.velocity[0], s.velocity[2]);
  out.pitch = Math.asin(fy < -1 ? -1 : fy > 1 ? 1 : fy);
  out.roll = Math.asin(ry < -1 ? -1 : ry > 1 ? 1 : ry);
  // bow-up rate: d(fwd·Ŷ)/dt = (ω × fwd)·Ŷ = ω_z f_x − ω_x f_z, over cos(pitch)
  const [wx, , wz] = s.angularVelocity;
  const c = Math.sqrt(Math.max(1e-6, 1 - fy * fy));
  out.pitchRate = (wz * fx - wx * fz) / c;
  out.vy = s.velocity[1];
  // before the first samplePatch (tick 0) there is no surface yet: treat the still-water level y = 0 as it
  out.heightAboveWater = s.position[1] - (hw.patch.nu > 1 ? hw.patch.heightAt(s.position[0], s.position[2]) : 0);
  let gear = 0;
  let imm = 0;
  const n = hw.driveImmersion.length;
  for (let k = 0; k < n; k++) {
    gear += hw.gearcaseImmersion[k];
    imm += hw.driveImmersion[k];
  }
  out.propImmersion = n > 0 ? imm / n : 1;
  out.airborne = hw.wet.count === 0 && gear === 0;
  return out;
}
