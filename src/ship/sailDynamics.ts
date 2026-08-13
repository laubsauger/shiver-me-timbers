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
import { apparentWind } from './flagDynamics';

export interface SailWindInput {
  /** world-space forward of the SAIL — i.e. already braced (unit-ish) */
  forwardX: number;
  forwardZ: number;
  /**
   * world-space forward of the HULL. Defaults to the sail's own, i.e. an
   * unbraced yard — see the note on `eff` in sailDrive for why the two must
   * not be conflated.
   */
  shipForwardX?: number;
  shipForwardZ?: number;
  /** direction the TRUE wind blows toward, radians, and its speed */
  windDirection: number;
  windSpeed: number;
  /**
   * The ship's own world velocity (m/s). Defaults to 0 = true wind.
   *
   * WITHOUT THIS THE SAILS READ THE TRUE WIND AND NOTHING ELSE, which is half
   * of "not wind speed and wind capture dependent enough". A ship running
   * dead downwind at 8 m/s in an 11 m/s breeze feels 3 m/s and her canvas
   * should go soft — the same cue the masthead pennant has always shown
   * (flagDynamics.apparentWind, which this now shares). Bearing away should
   * visibly ease her; hardening up should visibly load her.
   */
  shipVelX?: number;
  shipVelZ?: number;
  /** ship yaw rate, rad/s (positive = turning to starboard) */
  yawRate: number;
  /**
   * The gust train's two accumulated phases (rad). §V.55: `sailGustFreq` is a
   * live Tweakpane value, so `time × rate` is not a phase — and the two
   * evaluators of this function used to read two different clocks anyway
   * (§B.30). `rigTrim.updateRig` integrates both and publishes them.
   *
   * TWO accumulators, not one scaled by 1.63: multiplying a wrapped phase by a
   * non-integer ratio breaks continuity at every wrap (§V.55's own corollary,
   * learned on the flags' crack harmonic).
   */
  gustPhase?: number;
  gustPhaseB?: number;
}

export interface SailDriveState {
  /** signed belly fill: 1 = full following wind, <0 = backed against the mast */
  drive: number;
  /** 0..1 how hard the cloth is shaking (not drawing / gust / turning) */
  luff: number;
  /** -1..1 sideways lag of the belly while the ship swings */
  skew: number;
}

function finite(x: number | undefined, fallback = 0): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : fallback;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** the detune between the gust train's two accumulators — see SailWindInput */
export const SAIL_GUST_DETUNE = 1.63;

/** rate (rad/s) the gust train's primary accumulator advances at */
export function sailGustRate(p: ShipMaterialParams): number {
  return Math.max(0.01, finite(p.sailGustFreq, 0.55));
}

/**
 * Two detuned sines ≈ a slow gust train; never resonates into a pulse (§B.4).
 * Takes PHASES, not a time — see SailWindInput.gustPhase.
 */
export function gustFactor(
  phaseA: number,
  phaseB: number,
  p: ShipMaterialParams,
): number {
  const g = 0.5 * Math.sin(finite(phaseA)) + 0.5 * Math.sin(finite(phaseB) + 1.7);
  return 1 + p.sailGustAmp * g * 0.5;
}

export function sailDrive(input: SailWindInput, p: ShipMaterialParams): SailDriveState {
  const fx = finite(input.forwardX);
  const fz = finite(input.forwardZ, 1);
  const len = Math.max(1e-4, Math.hypot(fx, fz)); // §V28 floored divisor
  // APPARENT, not true: the cloth feels what the ship feels (see the note on
  // SailWindInput.shipVelX). Defaults to the true wind when no velocity is
  // supplied, so a headless caller still gets the old, valid answer.
  const app = apparentWind({
    windDirection: finite(input.windDirection),
    windSpeed: finite(input.windSpeed),
    shipVelX: finite(input.shipVelX),
    shipVelZ: finite(input.shipVelZ),
  });
  const wx = app.x;
  const wz = app.z;
  // +1 = wind dead astern (running), -1 = in irons
  const along = clamp((fx * wx + fz * wz) / len, -1, 1);

  /**
   * DYNAMIC RANGE (the §B "flagStreamRef 7 against a wind of 11" bug again).
   *
   * `sailWindRef` is the wind that fills the sail COMPLETELY, so it has to sit
   * ABOVE the wind the game normally runs at or `press` is pinned at its top
   * whenever anyone is actually sailing, and a breeze and a gale produce
   * identical canvas. At the old ref of 11 against a default wind of 11 that
   * is precisely what happened: press = 1.0, fill ≈ 0.9, so drive ≈ 0.9 of a
   * usable 1.0 in ordinary conditions and essentially all of the range sat
   * above where the game lives.
   *
   * With the ref above the working wind, ordinary sailing lands near two
   * thirds and there is real room left above it. The ceiling comes down to
   * 1.25 at the same time: the belly is now deep enough per unit of drive that
   * 1.5 would blow the cloth clean through the rigging in a squall.
   */
  const press = clamp(app.speed / Math.max(0.5, p.sailWindRef), 0, 1.25);
  const gust = gustFactor(finite(input.gustPhase), finite(input.gustPhaseB), p);

  /**
   * How full the sail is = how well it DRAWS. Two terms, and they must be
   * measured against two DIFFERENT headings:
   *
   *   `along` is the wind on the SAIL's own normal, so it must use the sail's
   *   braced forward — that is the point of bracing.
   *
   *   `eff` is `trimEfficiency`, a POINT-OF-SAIL curve. It is defined on the
   *   HULL's angle to the wind (it carries the sim's dead zone in irons), and
   *   it is the term that keeps the cloth from contradicting the thrust the
   *   player feels. Feeding it the SAIL's angle double-counts the brace: at a
   *   35° brace close-hauled the sail reported 80° off the wind where the hull
   *   had 45°, i.e. a far better point of sail than the ship actually had, and
   *   the canvas stayed full while she made almost no way.
   */
  const sfx = finite(input.shipForwardX, fx);
  const sfz = finite(input.shipForwardZ, fz);
  const slen = Math.max(1e-4, Math.hypot(sfx, sfz)); // §V28 floored divisor
  const alongShip = clamp((sfx * wx + sfz * wz) / slen, -1, 1);
  const theta = Math.acos(clamp(-alongShip, -1, 1)); // 0 = head to wind, π = running
  const eff = trimEfficiency(theta);
  // Dead downwind the arcade curve dips but a square sail is at its fullest
  // there, hence max(eff, along).
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
 *
 * THIS IS A LABEL, NOT A SHAPE. It names the point of trim for the HUD plaque,
 * the haul audio and any state-machine logic. It must NOT drive geometry: see
 * `sailGeometryState` below for why, and use that instead.
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
 * WHICH GEOMETRY the cloth is built from (user: "pulling up and down the sails
 * still skips… it suddenly jumps when it's like half unfurled, and then it
 * suddenly snaps and they're in — on the way out it does the same").
 *
 * `sailStateForTrim` used to drive this, and a hysteretic three-way switch
 * CANNOT produce a smooth transition — the cloth has to jump at every flip, by
 * construction. Measured on the main course before this changed:
 *
 *   hauling down: at trim 0.55 the canvas foot moved 2.11 m in one frame
 *                 (34% of the sail's drop), then trim 0.15..0.54 was a DEAD
 *                 ZONE — 39% of the range in which nothing moved at all
 *   hauling up:   the same jump happened at trim 0.62, and measured 2.55 m
 *                 (41%), because the hysteresis puts it somewhere else
 *
 * Both halves of the user's report, and both readings of the earlier "reefing
 * skips 30–40%": the jump is 34–41% of the drop AND the dead band is 39–40% of
 * the range.
 *
 * So the reef is now carried ENTIRELY by the continuous `trimDropScale`, and
 * geometry only swaps once, at the very bottom, where the collapsed panel and
 * the gathered bundle are the same height (that is what `trimDropMin` is tuned
 * to). There is no 'reefed' geometry on the trim path any more: an intermediate
 * mesh swap is a jump wherever you put it.
 */
export function sailGeometryState(
  trim: number,
  current: SailStateId,
  p: ShipRigParams,
): SailStateId {
  const t = clamp(finite(trim, 1), 0, 1);
  const below = Math.max(0, finite(p.furlGeometryBelow, 0.02));
  // still edge-triggered — a swap disposes and rebuilds six geometries — but
  // the band is bounded BY the threshold, so shaking the canvas back out can
  // never cost more than twice the trim it took to furl (at these values, 4%
  // of the range, against the 6% band that used to sit at mid-travel)
  const h = Math.min(Math.max(0, p.reefHysteresis), below);
  return t < (current === 'furled' ? below + h : below) ? 'furled' : 'full';
}

/**
 * Continuous cloth-drop scale — the ONE thing that animates a reef, now over
 * the whole of trim rather than the top 45% of it.
 *
 * LINEAR ON PURPOSE. Any interval on which this is flat is a stretch of the
 * player's control that does nothing, and that is precisely what the user feels
 * as a skip: the old form pinned at `trimDropMin` for every trim below
 * `reefReefedBelow`, i.e. 55% of the travel. A smoothstep would be worse, not
 * better — it is flat at BOTH ends, so it would put a fresh dead zone at full
 * sail and another at furled.
 *
 * 1 at full trim, `trimDropMin` at trim 0. It is read by the cloth (via
 * `setSailDropScale`), by the rigging's furl response, and by the haul audio,
 * so all three stay in step by construction.
 */
export function trimDropScale(trim: number, p: ShipRigParams): number {
  const t = clamp(finite(trim, 1), 0, 1);
  const min = clamp(finite(p.trimDropMin, 0.26), 0, 1);
  return min + (1 - min) * t;
}
