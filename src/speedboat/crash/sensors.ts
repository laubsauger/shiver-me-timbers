/**
 * CRASH SENSORS (§T.188): the few numbers crash detection reads, derived from sim state and the SAME contact
 * results the forces used (§V101 — the hull↔water result for wetted area and the water under the bow, the
 * collision report for impacts). Pure, allocation-free, no Euler decomposition that breaks at a pose (§V102):
 * every angle is a function total over SO(3) (atan2/acos of rotated axes), so a boat upside down or bow-vertical
 * still reads sensibly.
 *
 * Frames (docs/speedboat/physics-log.md): body x across, y up, z forward; quaternion [x, y, z, w].
 */
import type { Rigid6State } from '../../sea-physics/rigidBody';

export interface CrashSensors {
  /** |v|, m/s */
  speed: number;
  /** horizontal speed, m/s */
  groundSpeed: number;
  /** heel about the fore-aft axis, degrees, signed: atan2(right·Ŷ, up·Ŷ) (±180 = upside down) */
  heelDeg: number;
  /** trim, degrees, bow UP positive: asin(fwd·Ŷ) */
  pitchDeg: number;
  /** angle between the deck normal and world up, degrees (0 upright, 180 inverted) */
  tiltDeg: number;
  /** world yaw rate ω·Ŷ, rad/s */
  yawRate: number;
  /** |ω|, rad/s */
  angularSpeed: number;
  /** angle between heading and horizontal velocity, degrees, 0 below `slipMinSpeed` */
  slipDeg: number;
  /** wetted area of the hull contact this tick, m² */
  wettedArea: number;
  /** water surface (pressure head) minus the foredeck point's height, m; > 0 = green water over the bow */
  bowImmersion: number;
  /** largest single collision |Δv| on this boat this tick, m/s */
  contactDeltaV: number;
  /** CONTACT_* source of that contact (sea-physics/boatCollide) */
  contactSource: number;
}

export function createCrashSensors(): CrashSensors {
  return {
    speed: 0,
    groundSpeed: 0,
    heelDeg: 0,
    pitchDeg: 0,
    tiltDeg: 0,
    yawRate: 0,
    angularSpeed: 0,
    slipDeg: 0,
    wettedArea: 0,
    bowImmersion: -1,
    contactDeltaV: 0,
    contactSource: 0,
  };
}

const DEG = 180 / Math.PI;
/** below this horizontal speed a heading/velocity angle is noise */
export const SLIP_MIN_SPEED = 3;

export interface SensorInputs {
  /** foredeck point, body frame (CollisionHull.bowDeck) */
  bowDeck: readonly [number, number, number];
  /** the hull contact's wetted area this tick (HullWater.wettedArea) */
  wettedArea: number;
  /** the water surface the contact used (HullWater.patch.heightAt), world */
  waterHeightAt(x: number, z: number): number;
  /** this tick's collision report maximum (BoatContactReport.maxDeltaV / .source), 0 if none */
  contactDeltaV: number;
  contactSource: number;
}

/** bow immersion from a pose alone (the worker publishes it from the same function) */
export function bowImmersion(state: Readonly<Rigid6State>, bowDeck: readonly [number, number, number], waterHeightAt: (x: number, z: number) => number): number {
  const q = state.quaternion;
  const [bx, by, bz] = bowDeck;
  const qx = q[0];
  const qy = q[1];
  const qz = q[2];
  const qw = q[3];
  const tx = 2 * (qy * bz - qz * by);
  const ty = 2 * (qz * bx - qx * bz);
  const tz = 2 * (qx * by - qy * bx);
  const wx = state.position[0] + bx + qw * tx + (qy * tz - qz * ty);
  const wy = state.position[1] + by + qw * ty + (qz * tx - qx * tz);
  const wz = state.position[2] + bz + qw * tz + (qx * ty - qy * tx);
  return waterHeightAt(wx, wz) - wy;
}

export function measureCrashSensors(state: Readonly<Rigid6State>, inp: SensorInputs, out: CrashSensors): CrashSensors {
  const [qx, qy, qz, qw] = state.quaternion;
  const v = state.velocity;
  const w = state.angularVelocity;
  // rotated body axes' world-y components and the forward axis' horizontal part
  const rightY = 2 * (qx * qy + qw * qz);
  const upY = 1 - 2 * (qx * qx + qz * qz);
  const fwdY = 2 * (qy * qz - qw * qx);
  const fwdX = 2 * (qx * qz + qw * qy);
  const fwdZ = 1 - 2 * (qx * qx + qy * qy);
  out.speed = Math.hypot(v[0], v[1], v[2]);
  out.groundSpeed = Math.hypot(v[0], v[2]);
  out.heelDeg = Math.atan2(rightY, upY) * DEG;
  out.pitchDeg = Math.asin(Math.max(-1, Math.min(1, fwdY))) * DEG;
  out.tiltDeg = Math.acos(Math.max(-1, Math.min(1, upY))) * DEG;
  out.yawRate = w[1];
  out.angularSpeed = Math.hypot(w[0], w[1], w[2]);
  if (out.groundSpeed > SLIP_MIN_SPEED && Math.hypot(fwdX, fwdZ) > 0.2) {
    let d = Math.atan2(fwdX, fwdZ) - Math.atan2(v[0], v[2]);
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    out.slipDeg = Math.abs(d) * DEG;
  } else {
    out.slipDeg = 0;
  }
  out.wettedArea = inp.wettedArea;
  out.bowImmersion = bowImmersion(state, inp.bowDeck, inp.waterHeightAt);
  out.contactDeltaV = inp.contactDeltaV;
  out.contactSource = inp.contactSource;
  return out;
}
