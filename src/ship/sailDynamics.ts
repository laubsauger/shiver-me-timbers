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
import { autoBrace, braceDrive, trimEfficiency, windBearing } from '../sailing/shipKinematics';
import { sailingParams } from '../params/sailing';
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
  /**
   * §B86-2 — THIS sail's saturating reference wind (m/s), overriding
   * `shipMaterialParams.sailWindRef`. Per-sail because one number cannot be
   * right for a galleon's courses and a raft's cotton square at the same
   * time; it rides the mesh (`readSailWindRef` below) so the two
   * evaluators of the cloth — the shader's uniforms and the CPU anchor
   * mirror — read the same value (§B.30).
   */
  windRef?: number;
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

/** `mesh.userData` key a sail's own reference wind rides on (§B86-2) */
export const SAIL_WIND_REF_KEY = 'sailWindRef';

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

/**
 * §B86-2 — THE WIND A SAIL CALLS "FULL", PER SAIL MESH.
 *
 * `sailDrive` saturates fullness at `shipMaterialParams.sailWindRef`, and that
 * number was fitted to the galleon's canvas (6.43 m/s = half full at 10.4).
 * The raft's mainsail is light cotton on a bamboo yard in the trades: at her
 * own 8–11 m/s she should be drum-full, and on the shared reference she
 * bellied modestly instead (§B86-2). A GLOBAL knob cannot hold two answers,
 * and forking the membrane for one ship is the §V33 mistake — so the sail
 * carries its own reference the way it already carries `sheetLeadAft` and
 * `sailDropScale`: on the mesh, read per object, ONE material and ONE
 * pipeline for every class (§T.40).
 *
 * `shape.windRef` on a sail piece is copied onto `mesh.userData.sailWindRef`
 * by `ShipAssembly`; absent or non-finite falls back to the shared param, so
 * nothing else moves (§V28). Structurally typed on purpose: this module has
 * no three.js import and is not about to grow one.
 */
export function readSailWindRef(object: { userData: Record<string, unknown> }, fallback: number): number {
  const raw = object.userData[SAIL_WIND_REF_KEY];
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : fallback;
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
   * Apparent wind keeps the job it is right for — the dynamic pressure below,
   * i.e. how hard the cloth is pressed, which is where boat speed belongs.
   */
  const alongShip = clamp((sfx * twx + sfz * twz) / slen, -1, 1);
  const theta = Math.acos(clamp(-alongShip, -1, 1)); // 0 = head to wind, π = running
  const eff = trimEfficiency(theta);
  /**
   * THE BRACE, EXACTLY AS THE HULL FEELS IT (§T.76, §V.77 — imported, not
   * re-derived). `stepShipSailing` scales thrust by
   * `braceGain = 1 − authority·(1 − braceDrive(β)/braceDrive(β*))`: at the
   * crew's own brace it is exactly 1, braced off it the plate law takes drive
   * away, and where the clamp leaves the yards no drive at all (close-hauled)
   * the arcade curve governs alone. The cloth reads the SAME number, so a
   * yard braced edge-on to the wind goes as flat as her thrust does, and two
   * sails braced differently in one wind are visibly different sails. β is
   * the sail's own yaw against the hull's — the angle the yards are drawn at.
   */
  const yaw = Math.atan2(sfx, sfz);
  const gamma = windBearing(yaw, finite(input.windDirection));
  let beta = Math.atan2(fx, fz) - yaw;
  if (beta > Math.PI) beta -= 2 * Math.PI;
  else if (beta < -Math.PI) beta += 2 * Math.PI;
  const betaStar = autoBrace(gamma);
  const driveStar = braceDrive(betaStar, gamma);
  const authRef = Math.max(1e-6, finite(sailingParams.braceAuthorityRef, 0.05));
  const authT = clamp(driveStar / authRef, 0, 1);
  const authority = authT * authT * (3 - 2 * authT);
  const braceRatio = driveStar > 0 ? clamp(braceDrive(beta, gamma) / driveStar, 0, 1) : 1;
  const braceGain = finite(1 - authority * (1 - braceRatio), 1);
  // Dead downwind the arcade curve dips but a square sail is at its fullest
  // there, hence max(eff, along).
  const fill = clamp(Math.max(eff, along), 0, 1) * braceGain;
  // headed sail: the wind presses it back against the rig instead of filling
  const backed = Math.max(0, -along) * p.sailBackBillow * (1 - fill);
  /** signed PRESSURE COEFFICIENT on the canvas, −1..1: + draws, − aback */
  const cp = clamp(fill - backed, -1, 1);

  /**
   * FULLNESS IS A CONTINUOUS FUNCTION OF DYNAMIC PRESSURE, AND IT SATURATES.
   *
   * User: "we don't see the amount of force we're catching: it should be much
   * fuller, fully stretched out at 20 knots and above, and as the wind power
   * we're capturing lowers we should visually see that — not a binary
   * has-wind / has-no-wind." The old law was `(1 − e^(−v/ref))^0.45` under a
   * √ in the camber: 61% of full camber in 2 kn of wind, 80% at 5 kn.
   *
   * q = ½ρv² · cp, and fullness = 1 − exp(−q/q₀) with q₀ written as a
   * reference wind `sailWindRef` (6.43 m/s = 12.5 kn): ~0 at 2 kn (2.5%),
   * slack at 5 (15%), half at 10.4, 76% at 15, 92% at 20, 98% at 25. The
   * gust rides the SPEED, where a gust lives. It passes through zero, so a
   * becalmed sail is genuinely slack, and it is bounded by construction.
   */
  // §B86-2: a sail may carry its OWN reference wind — the raft's canvas is
  // full at 8–11 m/s where the galleon's is half. Absent, the shared param.
  const ref = Math.max(0.5, finite(input.windRef ?? p.sailWindRef, finite(p.sailWindRef, 6.43)));
  const vq = (Math.max(0, app.speed) * gust) / ref;
  const q = vq * vq;
  const fullness = 1 - Math.exp(-q * Math.abs(cp));
  const drive = clamp(Math.sign(cp) * fullness, -1, 1);

  const yawRate = finite(input.yawRate);
  // not drawing → shaking; a swing under the rudder shakes it too. The wind
  // factor saturates faster than the fill: a sail in 12 kn that is not
  // drawing flogs hard long before the same wind would have filled it.
  const turning = clamp(Math.abs(yawRate) * p.sailTurnSkew * 0.6, 0, 0.6);
  const luff = clamp((1 - fill) * (1 - Math.exp(-2 * q)) + turning, 0, 1.4);

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
