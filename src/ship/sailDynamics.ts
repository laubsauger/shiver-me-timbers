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
  /**
   * HOW HARD THE CLOTH IS LOADED — early onset, saturating, floored.
   *
   * `1 − exp(−v/ref)` rather than a linear ramp into a clamp. Three properties
   * the user asked for in as many words: it starts responding IMMEDIATELY
   * (slope 1/ref at zero, so the first knot of breeze already shows), it is
   * BROAD through the middle, and it SATURATES — "up to a certain max, from
   * which more speed is not gonna necessarily do more bending". A real sail
   * runs out of cloth; the ceiling is physical, not a taper.
   *
   * The FLOOR is the sail's own cut. Canvas is broadseamed, so it carries
   * shape with no load on it at all — which is also what stops a ship running
   * dead downwind at near wind speed from showing a flat sheet. Her apparent
   * wind really is ~1 m/s there and the load really is nearly nothing, but the
   * sail still has the shape it was sewn with.
   */
  const wind = Math.max(0.5, finite(p.sailWindRef, 8));
  const press = 1 - Math.exp(-Math.max(0, app.speed) / wind);
  // CONCAVE, not a floor. An additive floor would hold camber in a DEAD CALM,
  // where canvas simply hangs. An exponent below 1 gives the same early onset
  // — most of the shape arrives in the first few knots — while still passing
  // through zero, so a becalmed sail is genuinely slack.
  const load = Math.pow(press, Math.max(0.05, finite(p.sailLoadCurve, 0.45)));
  const gust = gustFactor(finite(input.gustPhase), finite(input.gustPhaseB), p);
  // TRUE wind for the ANGLE. See the note on `eff` below.
  const twx = Math.sin(finite(input.windDirection));
  const twz = Math.cos(finite(input.windDirection));

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
  /**
   * THE ANGLE TERM READS THE **TRUE** WIND, and this is a bug fix.
   *
   * `trimEfficiency` is the sim's own point-of-sail curve and it carries a ±30°
   * dead zone with a 20° ramp. `shipKinematics.stepShipSailing` feeds it the
   * TRUE wind angle to make thrust. Feeding it the APPARENT angle here — which
   * is what landed with the apparent-wind work — draws the angle forward as the
   * ship makes way, so at cruising speed she sits permanently near her own dead
   * zone and the canvas collapses while the hull is still being driven hard.
   * Measured at equilibrium in an 11 m/s wind: on a beam reach the apparent
   * wind arrives 39° off the bow, `eff` falls 1.00 → 0.35, and the sail read
   * 3.6% camber where the sim was making full thrust.
   *
   * That is precisely the "too sensitive… only happening when we're exactly at
   * the very perfect, to the milli-degree, set" report, and it is the failure
   * the original comment here warned about: the cloth must not contradict the
   * thrust the player feels. Same curve, same wind, same answer as the hull.
   *
   * Apparent wind keeps the job it is right for — `load` above, i.e. how hard
   * the cloth is pressed, which is where boat speed genuinely belongs.
   */
  const alongShip = clamp((sfx * twx + sfz * twz) / slen, -1, 1);
  const theta = Math.acos(clamp(-alongShip, -1, 1)); // 0 = head to wind, π = running
  const eff = trimEfficiency(theta);
  // Dead downwind the arcade curve dips but a square sail is at its fullest
  // there, hence max(eff, along).
  const fill = clamp(Math.max(eff, along), 0, 1);
  // headed sail: the wind presses it back against the rig instead of filling
  const backed = Math.max(0, -along) * p.sailBackBillow * (1 - fill);
  const drive = clamp((fill - backed) * load * gust, -1, 1.5);

  const yawRate = finite(input.yawRate);
  // not drawing → shaking; a swing under the rudder shakes it too
  const turning = clamp(Math.abs(yawRate) * p.sailTurnSkew * 0.6, 0, 0.6);
  const luff = clamp((1 - fill) * Math.min(1, load) + turning, 0, 1.4);

  const skew = clamp(yawRate * p.sailTurnSkew, -1, 1);
  return { drive, luff, skew };
}

/*
 * WHERE `braceAngle` WENT (§T.76). It used to live here: a bisector rule that
 * chose the yards' angle from the ship's heading and the wind, for the RENDER
 * to animate. The yards now make thrust, so the angle is sim state and the
 * rule that picks it is `sailing/shipKinematics.autoBrace` — one expression,
 * on the fixed tick, stepped from the same wind the hull is (§V.77, §V.2).
 * `sailDrive` below still reads the BRACED forward through `forwardX/Z`; the
 * caller passes the sail's own world transform, which follows the yard.
 */

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
 * THERE IS NO `sailGeometryState` ANY MORE, and its deletion is the fix for
 * the last of "pulling up and down the sails still skips… it suddenly snaps
 * and they're in".
 *
 * It went in three steps, and the first two were both real improvements that
 * did not finish the job:
 *
 *   1. `sailStateForTrim` drove the mesh. A hysteretic three-way switch CANNOT
 *      produce a smooth transition — measured on the main course, the canvas
 *      foot moved 2.11 m in one frame at trim 0.55 (34% of the drop) hauling
 *      down and 2.55 m at trim 0.62 hauling up, with a 39%-wide dead band
 *      between where nothing moved at all.
 *   2. One swap, at the very bottom, where `trimDropMin` was fitted to make
 *      the collapsed panel and the bundle the same HEIGHT. Its own comment
 *      said "an intermediate mesh swap is a jump wherever you put it", which
 *      is true of the bottom of the travel too: the foot matched to 3% of the
 *      drop and the TOP still jumped 0.04-0.09 of it, the THICKNESS tripled
 *      (0.56 → 1.70 m on the main course), and the foot's own scallop
 *      disagreed by 0.09 of the drop at the buntline stations — all inside the
 *      bottom 2% of the player's travel.
 *   3. No swap. The roll is in the same mesh as the canvas and grows as the
 *      canvas shortens (`furlBundleScale`), so nothing is ever rebuilt and
 *      there is no trim at which anything is discontinuous.
 *
 * `sailStateForTrim` survives above as the §V13 LABEL, which is all it was
 * ever good for.
 */

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
