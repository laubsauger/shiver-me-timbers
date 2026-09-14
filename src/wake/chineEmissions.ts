import { waterlineSheetLaunch } from '../foam/bowSpray';
import { GRAVITY } from '../ocean/oceanMath';
import { SIM_DT } from '../core/loop';

/** Fresh surface-source history. Deposited foam has its own, longer decay clock. */
export const CHINE_EMISSION_LIFE = 1.5;
export const CHINE_EMISSION_INTERVAL = 0.05;
/** Enough even when each fixed tick starts a separate contact burst; two boundary slots cover rounding. */
export const CHINE_EMISSION_SLOTS = Math.ceil(CHINE_EMISSION_LIFE / SIM_DT) + 2;

/** Volume-weighted emission over at most 50 ms, in world space. */
export interface ChineEmission {
  bin: number;
  time: number;
  volume: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
  halfWidth: number;
  launch: number;
  speed: number;
}

export interface PackedChineEmission {
  /** centre x/z, outboard distance, volume deposition rate per side */
  a: [number, number, number, number];
  /** emission direction x/z, longitudinal/lateral variance */
  b: [number, number, number, number];
}

/** The packet moves only with its own launch; the boat's later pose has no influence. */
export function packChineEmission(e: ChineEmission, now: number, thickness: number, slide: number): PackedChineEmission | null {
  const age = now - e.time;
  if (age < 0 || age >= CHINE_EMISSION_LIFE || !(e.volume > 0)) return null;
  const motion = Math.hypot(e.vx, e.vz);
  if (!(motion > 0)) return null;
  const fx = e.vx / motion;
  const fz = e.vz / motion;
  const launch = waterlineSheetLaunch(e.speed, e.launch);
  const tau = Math.max(2 / e.speed, 2 * launch.up / GRAVITY + slide);
  const survival = Math.exp(-age / tau);
  const travel = tau * (1 - survival);
  const forward = launch.forward * travel;
  // Subtract the terminal exponential so deposition reaches zero smoothly at
  // expiry. Its integral normalizes the complete emitted volume, including slams.
  const terminal = Math.exp(-CHINE_EMISSION_LIFE / tau);
  const integral = tau * (1 - terminal) - CHINE_EMISSION_LIFE * terminal;
  const rate = e.volume * (survival - terminal) / (2 * thickness * integral);
  // Adjacent packets overlap enough to suppress a visible 20 Hz emission lattice.
  const sigmaAlong2 = 0.25 ** 2 + (e.speed * CHINE_EMISSION_INTERVAL) ** 2 / 4;
  const sigmaAcross = 0.25 + 0.02 * e.speed * age;
  return {
    a: [e.x + fx * forward, e.z + fz * forward, Math.max(0.3, e.halfWidth) + launch.outboard * travel, rate],
    b: [fx, fz, sigmaAlong2, sigmaAcross ** 2],
  };
}
