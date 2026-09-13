/**
 * HEADLESS MEASUREMENT OF WHAT THE BOAT CAN DO (§T.186). The racing line's speed profile and the pursuit
 * controller's steer map are built from these numbers, and these numbers come from running the REAL physics
 * (`HullWater` + `stepRigid6` + `planingSubsteps`, the exact calls `BoatSimCore` makes) on flat water — never
 * from a guess (tech-research §5.3). `capability.ts` holds the committed table; `tests/raceAiCapability.test.ts`
 * re-runs this module and fails when the physics (or the TEMPORARY stand-in thrust, T166) has moved away from it.
 *
 * Not imported by the pilot: the worker bundle never runs physics for measurement.
 */
import { HullWater, planingSubsteps, type HeightSampler, type HullWaterParams } from '../../sea-physics/hullWater';
import { createRigid6Memory, stepRigid6, type Rigid6Memory, type Rigid6State } from '../../sea-physics/rigidBody';
import { buildDeepVHull, type HullProxy } from '../../speedboat/hullMesh';

const DT = 1 / 60;
const FLAT: HeightSampler = () => 0;
/** helm slew of the steady-turn runs (the physics-log T179 envelope rate; steady values do not depend on it) */
export const MEASURE_HELM_RATE = (30 * Math.PI) / 180;

interface Rig {
  hull: HullProxy;
  hw: HullWater;
  s: Rigid6State;
  mem: Rigid6Memory;
}

function rig(speed: number, params: Partial<HullWaterParams> = {}, hull: HullProxy = buildDeepVHull()): Rig {
  return {
    hull,
    hw: new HullWater(hull, params),
    mem: createRigid6Memory(),
    s: { position: [0, 0.35, 0], quaternion: [-Math.sin(0.02), 0, 0, Math.cos(0.02)], velocity: [0, 0, speed], angularVelocity: [0, 0, 0] },
  };
}

function tick(r: Rig): void {
  r.hw.samplePatch(FLAT, r.s, DT);
  const n = planingSubsteps(r.hw, r.s, DT);
  stepRigid6(r.s, r.hull, DT, n, (ss, h, out) => r.hw.evaluate(ss, h, out), r.mem);
}

const horiz = (s: Rigid6State): number => Math.hypot(s.velocity[0], s.velocity[2]);

/** up·Ŷ and |drift| (bow heading vs course over ground, rad) — the physics log's departure test (hook) */
function attitude(s: Rigid6State): { upY: number; drift: number } {
  const [qx, qy, qz, qw] = s.quaternion;
  const upY = 1 - 2 * (qx * qx + qz * qz);
  const fx = 2 * (qx * qz + qw * qy);
  const fz = 1 - 2 * (qx * qx + qy * qy);
  let d = Math.atan2(fx, fz) - Math.atan2(s.velocity[0], s.velocity[2]);
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return { upY, drift: Math.abs(horiz(s) > 1 ? d : 0) };
}

/** a departure = heel/pitch past 45° or slip past 45° (physics-log T179 "hook") */
export const departed = (s: Rigid6State): boolean => {
  const a = attitude(s);
  return a.upY < Math.SQRT1_2 || a.drift > Math.PI / 4;
};

export interface StraightRun {
  topSpeed: number;
  /** [speed, accel m/s²] at full throttle */
  accel: [number, number][];
  /** [speed, decel m/s² (positive)] at throttle 0 */
  coast: [number, number][];
  /** [speed, decel m/s²] at full reverse (−0.3) */
  reverse: [number, number][];
}

function slopeTable(trace: number[], grid: readonly number[], sign: 1 | -1): [number, number][] {
  const out: [number, number][] = [];
  const w = 6; // ±0.1 s central difference
  for (const g of grid) {
    for (let k = w; k < trace.length - w; k++) {
      const a = trace[k - 1];
      const b = trace[k];
      if ((sign > 0 && a < g && b >= g) || (sign < 0 && a > g && b <= g)) {
        out.push([g, (sign * (trace[k + w] - trace[k - w])) / (2 * w * DT)]);
        break;
      }
    }
  }
  return out;
}

export function measureStraight(grid: readonly number[]): StraightRun {
  const r = rig(0.5);
  const up: number[] = [];
  for (let t = 0; t < 50 * 60; t++) {
    r.hw.setControls(0, 1);
    tick(r);
    up.push(horiz(r.s));
  }
  const topSpeed = up[up.length - 1];
  const coastFrom = (throttle: number): number[] => {
    const c = rig(topSpeed);
    c.s.position = [...r.s.position];
    c.s.quaternion = [...r.s.quaternion];
    c.s.velocity = [...r.s.velocity];
    c.s.angularVelocity = [...r.s.angularVelocity];
    const tr: number[] = [];
    for (let t = 0; t < 30 * 60; t++) {
      c.hw.setControls(0, throttle);
      tick(c);
      tr.push(horiz(c.s));
    }
    return tr;
  };
  return {
    topSpeed,
    accel: slopeTable(up, grid, 1),
    coast: slopeTable(coastFrom(0), grid, -1),
    reverse: slopeTable(coastFrom(-0.3), grid, -1),
  };
}

export interface TurnRow {
  /** requested entry speed */
  speed: number;
  /** drive angle, rad (magnitude) */
  steer: number;
  /** steady speed reached with a hold loop capped at full throttle */
  steadySpeed: number;
  /** steady path curvature |r|/V, 1/m */
  curvature: number;
  /** V·|r|, m/s² */
  lateralAccel: number;
  /** mean throttle over the steady window */
  throttle: number;
  /** max tilt from vertical after the helm starts, deg */
  maxTiltDeg: number;
  departed: boolean;
  /** sign of the yaw rate for a POSITIVE steer (−1: + steer turns to port) */
  yawSign: number;
}

/**
 * Straight at `speed` for 6 s (hold loop), helm to `steer` at MEASURE_HELM_RATE, then 10 s of turning with the
 * hold loop still on (capped at full throttle, so a turn the drives cannot hold settles slower). Steady values
 * = mean of the last 4 s.
 */
export function measureTurn(speed: number, steer: number, params: Partial<HullWaterParams> = {}, seconds = 10): TurnRow {
  const r = rig(speed, params);
  let integ = 0;
  let maxTilt = 0;
  let dep = false;
  let n = 0;
  let vSum = 0;
  let wSum = 0;
  let thrSum = 0;
  const T1 = 6;
  const T2 = T1 + seconds;
  for (let t = 0; t < T2 * 60; t++) {
    const time = t / 60;
    const v = horiz(r.s);
    const err = speed - v;
    integ = Math.max(-5, Math.min(20, integ + err * DT));
    const thr = Math.max(0, Math.min(1, 0.3 + 0.3 * err + 0.1 * integ));
    r.hw.setControls(time < T1 ? 0 : Math.min(steer, (time - T1) * MEASURE_HELM_RATE), thr);
    tick(r);
    if (time >= T1) {
      const a = attitude(r.s);
      maxTilt = Math.max(maxTilt, (Math.acos(Math.min(1, Math.max(-1, a.upY))) * 180) / Math.PI);
      if (departed(r.s)) dep = true;
    }
    if (time > T2 - 4) {
      n++;
      vSum += v;
      wSum += r.s.angularVelocity[1];
      thrSum += thr;
    }
  }
  const v = vSum / n;
  const w = wSum / n;
  return {
    speed,
    steer,
    steadySpeed: v,
    curvature: Math.abs(w) / Math.max(v, 0.1),
    lateralAccel: v * Math.abs(w),
    throttle: thrSum / n,
    maxTiltDeg: maxTilt,
    departed: dep,
    yawSign: Math.sign(w),
  };
}

/** the grids the committed table is measured on (capability.ts) */
export const SPEED_GRID: readonly number[] = [4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 27, 28, 29];
export const TURN_SPEEDS: readonly number[] = [6, 10, 14, 18, 22, 26, 29.5];
export const TURN_STEER_DEG: readonly number[] = [0, 5, 10, 12.5];

export interface MeasuredCapability {
  topSpeed: number;
  accel: [number, number][];
  coast: [number, number][];
  reverse: [number, number][];
  /** per steer column: rows [steadySpeed, curvature, throttle] sorted by speed */
  turns: { steerDeg: number; rows: [number, number, number][] }[];
}

/** everything `capability.ts` commits, measured now (~3 s of physics) */
export function measureCapability(): MeasuredCapability {
  const s = measureStraight(SPEED_GRID);
  const turns = TURN_STEER_DEG.map((deg) => ({
    steerDeg: deg,
    rows: TURN_SPEEDS.map((V) => {
      const r = measureTurn(V, (deg * Math.PI) / 180);
      return [r.steadySpeed, r.curvature, r.throttle] as [number, number, number];
    }).sort((a, b) => a[0] - b[0]),
  }));
  return { topSpeed: s.topSpeed, accel: s.accel, coast: s.coast, reverse: s.reverse, turns };
}

/** helm to the given lock from a full-throttle straight at `speed` (worst case: no lift), departure within `seconds` */
export function measureLockEntry(speed: number, lock: number, params: Partial<HullWaterParams> = {}, seconds = 12, helmRate = MEASURE_HELM_RATE): { departed: boolean; maxTiltDeg: number } {
  const r = rig(speed, params);
  let integ = 0;
  let dep = false;
  let maxTilt = 0;
  for (let t = 0; t < (4 + seconds) * 60; t++) {
    const time = t / 60;
    const v = horiz(r.s);
    integ = Math.max(-5, Math.min(20, integ + (speed - v) * DT));
    const thr = time < 4 ? Math.max(0, Math.min(1, 0.3 + 0.3 * (speed - v) + 0.1 * integ)) : 1;
    r.hw.setControls(time < 4 ? 0 : Math.min(lock, (time - 4) * helmRate), thr);
    tick(r);
    if (time >= 4) {
      if (departed(r.s)) dep = true;
      const a = attitude(r.s);
      maxTilt = Math.max(maxTilt, (Math.acos(Math.min(1, Math.max(-1, a.upY))) * 180) / Math.PI);
    }
  }
  return { departed: dep, maxTiltDeg: maxTilt };
}
