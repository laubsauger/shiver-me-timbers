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
import { RAFT_GUARA_POS, type RaftTuning } from '../params/raftSailing';

export interface RaftControls {
  /** sail sheeted home 0..1 (0 = flogging, draws nothing) */
  sheet: number;
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

export function neutralRaftControls(): RaftControls {
  return {
    sheet: 1,
    guaraDepth: [1, 1, 1, 1, 1],
    guaraPos: [...RAFT_GUARA_POS],
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

  const sheet = c.sailUp ? clamp(fin(c.sheet), 0, 1) : 0;
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
