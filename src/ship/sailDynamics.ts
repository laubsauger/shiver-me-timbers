/**
 * Sail wind response — pure, testable, no three.js (§V3: this only READS
 * wind + the ship's own render transform; it never writes SimState).
 *
 * Convention matches src/sailing/shipKinematics.ts: ship forward = local +z,
 * `windDirection` is the direction the wind blows TOWARD. A square sail set
 * on its yard draws when the wind has an aft component (along > 0), backs
 * and shakes when the wind comes forward of the beam, and shivers when the
 * ship swings under the rudder.
 *
 * §V28: every output is finite-guarded and clamped — these values feed
 * shader uniforms, and a NaN here becomes NaN vertices.
 */
import type { ShipMaterialParams, ShipRigParams } from '../params/ship';
import type { SailStateId } from './pieceTypes';
import { trimEfficiency } from '../sailing/shipKinematics';

export interface SailWindInput {
  /** world-space forward of the sail's ship (unit-ish) */
  forwardX: number;
  forwardZ: number;
  /** direction the wind blows toward, radians */
  windDirection: number;
  windSpeed: number;
  /** ship yaw rate, rad/s (positive = turning to starboard) */
  yawRate: number;
  /** seconds, for the gust cycle */
  time: number;
}

export interface SailDriveState {
  /** signed belly fill: 1 = full following wind, <0 = backed against the mast */
  drive: number;
  /** 0..1 how hard the cloth is shaking (not drawing / gust / turning) */
  luff: number;
  /** -1..1 sideways lag of the belly while the ship swings */
  skew: number;
}

function finite(x: number, fallback = 0): number {
  return Number.isFinite(x) ? x : fallback;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** two detuned sines ≈ a slow gust train; never resonates into a pulse (§B.4) */
export function gustFactor(time: number, p: ShipMaterialParams): number {
  const f = Math.max(0.01, p.sailGustFreq);
  const g = 0.5 * Math.sin(time * f) + 0.5 * Math.sin(time * f * 1.63 + 1.7);
  return 1 + p.sailGustAmp * g * 0.5;
}

export function sailDrive(input: SailWindInput, p: ShipMaterialParams): SailDriveState {
  const fx = finite(input.forwardX);
  const fz = finite(input.forwardZ, 1);
  const len = Math.max(1e-4, Math.hypot(fx, fz)); // §V28 floored divisor
  const wx = Math.sin(finite(input.windDirection));
  const wz = Math.cos(finite(input.windDirection));
  // +1 = wind dead astern (running), -1 = in irons
  const along = clamp((fx * wx + fz * wz) / len, -1, 1);

  const press = clamp(
    finite(input.windSpeed) / Math.max(0.5, p.sailWindRef),
    0,
    1.5,
  );
  const gust = gustFactor(finite(input.time), p);

  // How full the sail is = how well it DRAWS, using the sim's own efficiency
  // curve so the cloth never contradicts the thrust the player feels: it is
  // flat in irons and full on a reach. Dead downwind the curve dips (arcade
  // penalty) but a square sail is at its fullest there, hence max(eff, along).
  const theta = Math.acos(clamp(-along, -1, 1)); // 0 = head to wind, π = running
  const eff = trimEfficiency(theta);
  const fill = clamp(Math.max(eff, along), 0, 1);
  // headed sail: the wind presses it back against the rig instead of filling
  const backed = Math.max(0, -along) * p.sailBackBillow * (1 - fill);
  const drive = clamp((fill - backed) * press * gust, -1, 1.5);

  const yawRate = finite(input.yawRate);
  // not drawing → shaking; a swing under the rudder shakes it too
  const turning = clamp(Math.abs(yawRate) * p.sailTurnSkew * 0.6, 0, 0.6);
  const luff = clamp((1 - fill) * Math.min(1, press) + turning, 0, 1.4);

  const skew = clamp(yawRate * p.sailTurnSkew, -1, 1);
  return { drive, luff, skew };
}

/**
 * Yard brace angle (rad about the ship's vertical) for a square rig, from
 * the ship's OWN heading — not a sail's, which is already braced.
 *
 * Rule of thumb the crew uses: the yard bisects the angle between the
 * apparent wind and the centreline, so it is square when running and swings
 * round as the ship comes up toward the wind. Sign: the WINDWARD yardarm
 * goes forward (on a port tack, the port arm leads), which for three's
 * left-handed +y rotation means a positive angle when the wind is on the
 * port bow. Clamped — beyond ~35° a yard fouls its own shrouds.
 *
 * Continuous through both dead-astern and head-to-wind: the magnitude goes
 * to zero on a run, and the tack flip is a smooth blend over
 * `braceTackWidth`, so a ship rolling through the eye of the wind does not
 * snap its whole rig from one side to the other.
 */
export function braceAngle(
  input: Pick<SailWindInput, 'forwardX' | 'forwardZ' | 'windDirection'>,
  p: ShipRigParams,
): number {
  const fx = finite(input.forwardX);
  const fz = finite(input.forwardZ, 1);
  const len = Math.max(1e-4, Math.hypot(fx, fz)); // §V28 floored divisor
  const ux = fx / len;
  const uz = fz / len;
  const wx = Math.sin(finite(input.windDirection));
  const wz = Math.cos(finite(input.windDirection));
  // SAME convention as sailDrive above and as src/sailing: windDirection is
  // where the wind blows TOWARD, so +1 here is the wind dead astern
  const along = clamp(ux * wx + uz * wz, -1, 1);
  const theta = Math.acos(clamp(-along, -1, 1)); // 0 = head to wind, π = running
  const magnitude = Math.min((Math.PI - theta) * p.braceBisect * 0.5, p.braceMax);
  // starboard = forward rotated −90° about +y
  const lateral = clamp(uz * -wx + -ux * -wz, -1, 1); // wind FROM, to starboard
  const tack = clamp(-lateral / Math.max(0.01, p.braceTackWidth), -1, 1);
  const brace = magnitude * tack;
  return Number.isFinite(brace) ? brace : 0;
}

/**
 * sailTrim (0..1, the sim's value) → §V13 sail state, with hysteresis so a
 * trim resting on a threshold cannot flip states every frame — each flip
 * disposes and rebuilds six sail geometries.
 */
export function sailStateForTrim(
  trim: number,
  current: SailStateId,
  p: ShipRigParams,
): SailStateId {
  const t = clamp(finite(trim, 1), 0, 1);
  const h = Math.max(0, p.reefHysteresis);
  // shaking canvas OUT (trim rising) needs to clear the threshold by `h`;
  // taking it in happens at the bare threshold
  const furledTop = current === 'furled' ? p.reefFurledBelow + h : p.reefFurledBelow;
  const reefedTop = current === 'full' ? p.reefReefedBelow : p.reefReefedBelow + h;
  if (t < furledTop) return 'furled';
  if (t < reefedTop) return 'reefed';
  return 'full';
}

/**
 * Continuous cloth-drop scale within a state, so hauling on the sheets reads
 * as the canvas gradually coming in rather than three snapping silhouettes.
 * 1 at full trim, `trimDropMin` at the point the sail reefs.
 */
export function trimDropScale(trim: number, p: ShipRigParams): number {
  const t = clamp(finite(trim, 1), 0, 1);
  const span = Math.max(0.05, 1 - p.reefReefedBelow); // §V28 floored divisor
  const k = clamp((t - p.reefReefedBelow) / span, 0, 1);
  return p.trimDropMin + (1 - p.trimDropMin) * k;
}
