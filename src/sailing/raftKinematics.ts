/**
 * stepRaftSailing — Kon-Tiki raft kinematics on the water plane (§T.96).
 * §V.2 pure, deterministic, fixed-tick; §V.3 no three.js, plain data in and
 * a NEW plain-data object out (the caller writes it into ShipState).
 *
 * CONVENTIONS — identical to `shipKinematics.ts`, stated here so the two can
 * never disagree (§V.77): raft forward = local +z; yaw about +y, yaw 0 →
 * world +z, forward = [sin yaw, 0, cos yaw], starboard = [cos yaw, 0, −sin yaw].
 * `wind.direction` is the direction the wind blows TOWARD. `gamma =
 * wrapPi(windDirection − yaw)`: 0 = dead run, ±π = head to wind, gamma > 0
 * = wind blowing toward the STARBOARD side, i.e. wind FROM port. TWA (angle
 * off the eye) = π − |gamma|. Positive yaw rate / positive oar = turn to
 * STARBOARD (yaw increases), the same sign as `ShipState.rudder`. "Toward
 * the wind" is therefore yaw DEcreasing when gamma > 0 — luffing sign is
 * −sign(gamma).
 *
 * GUARA STEERING (runasimi.net/guara-5UK.htm, Heyerdahl p.127): the sail's
 * side force acts at the centre of effort; the boards resist it wherever
 * they are lowered. Boards down FORWARD pin the bow and the stern slides
 * off to leeward ⇒ she LUFFS UP toward the wind. Boards down AFT pin the
 * stern and the bow blows off ⇒ she BEARS AWAY. §T.96's row states the
 * opposite ("fwd-down ⇒ bow falls off"); that is the wrong sign and this
 * file implements the physics. The sign falls out of the model rather than
 * being pinned: leeway is the lateral velocity the side force builds, each
 * board's lift opposes the leeway in proportion to its depth, and the yaw
 * moment is Σ lift_i · (pos_i − CE). No board-specific sign constant exists.
 */
import type { Vec3 } from '../state/simState';
import type { Wind } from './shipKinematics';
import { type RaftTuning } from '../params/raftSailing';
import { raftParams, type RaftParams } from '../params/raft';
import { guaraStations } from '../ship/raftPartsLayout';
import { RAFT_SAIL_KEYS, type RaftSailKey } from '../ship/raftRigging';

export interface RaftControls {
  /**
   * §T.148 — ONE SHEET PER SAIL, 0 (flogging, draws nothing) .. 1 (home).
   *
   * This was a single number applied to all three sails, which made the
   * honest answer to USER's "is that adjusting all three sails at the same
   * time?" YES — and made any second sheet station a §V62 knob on the main's
   * channel before it was ever wired. The key is the sail's own
   * `sail-{mast}-{level}` id stem (`raftRigging.RaftSailKey`), so a trim
   * cannot be published for a name no sail answers to.
   */
  sheet: Record<RaftSailKey, number>;
  /** 5 guaras, each 0 (raised clear) .. 1 (fully lowered) */
  guaraDepth: number[];
  /** 5 guara longitudinal positions, m from centre, + = forward */
  guaraPos: number[];
  /** steering oar −1..1, + = helm for a starboard turn; rope-clamped to ±oarMax */
  oarAngle: number;
  /** sail bent on and hoisted; false = bare mast, windage drift only */
  sailUp: boolean;
}

/** the planar motion the raft owns — the caller maps it onto ShipState */
export interface RaftMotion {
  position: Vec3;
  yaw: number;
  velocity: Vec3; // world frame; y untouched (buoyancy's)
  yawRate: number;
}

export interface RaftStep extends RaftMotion {
  speed: number; // planar, m/s
  leeway: number; // rad, + = sliding to starboard
  drive: number; // m/s² the sail delivered this tick
}

/**
 * Where the boards ACTUALLY are, read from the blueprint's own layout (§V71).
 *
 * `guaraStations()` is what `buildGuaras` drops the planks through, so the sim
 * and the geometry cannot drift; a re-authored chink moves the yaw moment with
 * it. This replaces a hand-written `RAFT_GUARA_POS` that had disagreed with the
 * built boards by up to 2.8 m for as long as both existed (§B102) — the
 * steering model was taking moments about planks that are not on this raft.
 */
export function raftGuaraPositions(p = raftParams): number[] {
  return guaraStations(p).map((g) => g.z);
}

/** the same trim on every sail — the whole rig sheeted to `v` */
export function raftSheetsAll(v: number): Record<RaftSailKey, number> {
  const out = {} as Record<RaftSailKey, number>;
  for (const k of RAFT_SAIL_KEYS) out[k] = v;
  return out;
}

/**
 * §T.148 — EACH SAIL'S SHARE OF THE RIG'S CANVAS, by cloth area.
 *
 * The weights the three sheets sum through in `stepRaftSailing`. Read off
 * `raftParams` live (§V62): re-cutting the topsail changes what easing it
 * costs her, in the same change as the cloth.
 */
export function raftSailAreas(p: RaftParams = raftParams): Record<RaftSailKey, number> {
  return {
    'main-lower': Math.max(0, p.mainSailWidth * p.mainSailDrop),
    'main-upper': Math.max(0, p.topsailWidth * p.topsailDrop),
    'mizzen-lower': Math.max(0, p.mizzenSailWidth * p.mizzenSailDrop),
  };
}

/**
 * §T.148 — HOW MUCH CANVAS IS ACTUALLY DRAWING, 0..1: the area-weighted sum
 * of the three sheets.
 *
 * THE AERODYNAMICS SUM, they do not pick one sail. `sailDrive` is a polar for
 * the WHOLE square rig — one twa, one apparent wind, one thrust coefficient
 * fitted with every sail set — so the honest way to carry three sheets
 * through it is to scale it by the fraction of the rig's area that is
 * actually sheeted home. Three sails at the same trim give exactly the old
 * scalar back (Σ w·s = s), so `RaftTuning.thrust` did not have to be re-fitted
 * when trim went per sail; easing the mizzen alone now costs her its 11 % of
 * the canvas and easing the main costs 84 %, which is the property a §V62
 * test can hold each of the three sheets to.
 *
 * A per-sail polar (each sail with its own twa off its own yard, its own
 * blanketing behind the main) is a bigger model than this raft has ever had —
 * the yards do not brace independently and there is one `sailCE` — so it is
 * NOT claimed here, and this comment is the "state plainly why it does not".
 */
export function raftCanvasSet(c: Pick<RaftControls, 'sheet'>, p: RaftParams = raftParams): number {
  const area = raftSailAreas(p);
  let total = 0;
  let set = 0;
  for (const k of RAFT_SAIL_KEYS) {
    const a = fin(area[k]);
    total += a;
    set += a * clamp(fin(c.sheet?.[k]), 0, 1);
  }
  return total > 1e-9 ? clamp(set / total, 0, 1) : 0;
}

export function neutralRaftControls(p = raftParams): RaftControls {
  const pos = raftGuaraPositions(p);
  return {
    sheet: raftSheetsAll(1),
    guaraDepth: pos.map(() => 1),
    guaraPos: pos,
    oarAngle: 0,
    sailUp: true,
  };
}

function fin(x: number, fallback = 0): number {
  return Number.isFinite(x) ? x : fallback;
}
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
 * Square-sail polar: forward drive (m/s²) at full sheet. Zero at and below
 * `minTwa`, C1 through it (smoothstep gate) and cos-shaped to the run
 * (0.5 − 0.5·cos twa), ∝ apparent wind². `twa` is the angle off the eye,
 * 0 = head to wind, π = dead run.
 */
export function sailDrive(twa: number, vApp: number, t: RaftTuning): number {
  const a = clamp(fin(Math.abs(twa)), 0, Math.PI);
  const v = Math.max(0, fin(vApp));
  const gate = smoothstep01((a - t.minTwa) / Math.max(1e-3, t.twaRamp));
  const shape = 0.5 - 0.5 * Math.cos(a);
  return t.thrust * v * v * gate * shape;
}

/**
 * Yaw acceleration from the guaras. `lateral` is the raft's sideways
 * velocity (+ starboard), `forward` her way; each board's lift opposes the
 * leeway ∝ depth · |v| · v_lat (a foil at small angle: ½ρv²·C_L(α) with
 * α ≈ v_lat / v), acting at the board's station, moment arm to the sail's CE.
 */
export function guaraYawMoment(
  c: RaftControls,
  forward: number,
  lateral: number,
  t: RaftTuning,
): number {
  const f = fin(forward);
  const l = fin(lateral);
  const speed = Math.hypot(f, l);
  const n = Math.min(c.guaraDepth.length, c.guaraPos.length);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const depth = clamp(fin(c.guaraDepth[i]), 0, 1);
    const pos = fin(c.guaraPos[i]);
    const lift = -depth * speed * l; // + starboard
    m += lift * (pos - t.sailCE);
  }
  // a starboard force forward of the pivot swings the bow to starboard:
  // +yaw. arm = pos − CE is + forward, so the sign is as written.
  return t.guaraYawGain * m;
}

/** steering-oar yaw acceleration; the ropes clamp the sweep to ±oarMax */
export function oarTorque(angle: number, speed: number, t: RaftTuning): number {
  const a = clamp(fin(angle), -t.oarMax, t.oarMax);
  const v = fin(speed);
  return t.oarGain * a * (v * v + t.oarMinSpeedSq);
}

export function stepRaftSailing(
  s: RaftMotion,
  c: RaftControls,
  wind: Wind,
  t: RaftTuning,
  dt: number,
): RaftStep {
  const h = Math.max(0, fin(dt));
  const yaw = fin(s.yaw);
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  const rx = fz;
  const rz = -fx;
  const vx = fin(s.velocity[0]);
  const vz = fin(s.velocity[2]);
  let forward = vx * fx + vz * fz;
  let lateral = vx * rx + vz * rz;

  // apparent wind in the raft frame
  const ws = Math.max(0, fin(wind.speed));
  const wd = fin(wind.direction);
  const wx = Math.sin(wd) * ws - vx;
  const wz = Math.cos(wd) * ws - vz;
  const appFwd = wx * fx + wz * fz;
  const appLat = wx * rx + wz * rz;
  const vApp = Math.hypot(appFwd, appLat);
  const gammaApp = Math.atan2(appLat, appFwd); // 0 = from astern, + toward stbd
  const twa = Math.PI - Math.abs(wrapPi(gammaApp));

  // §T.148: the three sheets, summed by area — see `raftCanvasSet`. The
  // halyard is still one line for the rig: sails struck, nothing draws.
  const sheet = c.sailUp ? raftCanvasSet(c) : 0;
  const drive = sailDrive(twa, vApp, t) * sheet;
  // sail side force: beam-on apparent wind, pushing to leeward
  const side = t.sideForce * sheet * vApp * appLat;
  // windage: cabin and mast, pushed straight downwind, sails or no sails
  const windFwd = t.windage * vApp * appFwd;
  const windLat = t.windage * vApp * appLat;

  let depthSum = 0;
  for (let i = 0; i < c.guaraDepth.length; i++) depthSum += clamp(fin(c.guaraDepth[i]), 0, 1);
  const grip = t.hullGrip + t.boardGrip * depthSum;

  const yawAcc = guaraYawMoment(c, forward, lateral, t) + oarTorque(c.oarAngle, forward, t);

  // forces → planar velocity in the raft frame
  forward += (drive + windFwd - t.dragCoef * forward * Math.abs(forward) - t.linearDrag * forward) * h;
  lateral += (side + windLat) * h;
  lateral *= Math.exp(-grip * h);

  const yawRate = (fin(s.yawRate) + yawAcc * h) * Math.exp(-t.yawDamp * h);
  const newYaw = wrapPi(yaw + yawRate * h);

  const nvx = forward * fx + lateral * rx;
  const nvz = forward * fz + lateral * rz;
  const speed = Math.hypot(forward, lateral);
  const leeway = speed > 1e-6 ? Math.atan2(lateral, forward) : 0;

  return {
    position: [fin(s.position[0]) + nvx * h, fin(s.position[1]), fin(s.position[2]) + nvz * h],
    yaw: newYaw,
    velocity: [nvx, fin(s.velocity[1]), nvz],
    yawRate,
    speed,
    leeway,
    drive,
  };
}
