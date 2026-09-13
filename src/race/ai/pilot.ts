/**
 * THE NPC PILOT (§T.186). Runs INSIDE the boat step core (`BoatSimCore.step`, every transport), once per boat per
 * tick, before the drives are set: reads the tick-k pose, the tick-k WORLD snapshot of every boat, the sea the
 * worker's own CpuOcean mirror floats the boats on, its race standing (AI IN) and its memory (AI OUT); writes its
 * memory back and returns drive angle + throttle. Deterministic by construction: sim time and buffer contents are
 * its only inputs; no wall clock, camera or frame rate (§V2). Memory lives in the buffer (aiBlock.ts header).
 *
 *  line     one racing line + speed profile per risk LEVEL (margin, curvature use and braking move with risk);
 *           the boat rides the level its current risk picks (hysteresis), tracked by station fraction.
 *  steer    pure pursuit (Coulter 1992): lookahead L = clamp(lookaheadS·V, 25, 70) m (≈ 2 s: the helm + yaw lag needs L ≫ √2·V·τ), κ = 2 sin α / L, mapped to a
 *           drive angle through the MEASURED steady-turn table, a small yaw-rate damper, clamped to the measured
 *           no-hook lock schedule (capability.ts), eased past 22° of heel, 40 % for 1.5 s after a placement,
 *           slewed at 15°/s.
 *  throttle PI on the profile speed V·0.6 s ahead, with the measured hold throttle as feed-forward; reverse gear
 *           as the only brake.
 *  waves    every 3 ticks: the true surface at this tick along the path the boat will cover in
 *           t = 0, 0.3, 0.6, 0.9, 1.2 s (never a future-time read: that steps the shared mirror); predicted airtime 2·V·slope/g and trough→face slope change (stuff) above
 *           the archetype's tolerance ⇒ throttle lift (× wave skill) and bow-down trim request; an exposed ramp
 *           under the tolerance ⇒ a jump-loving archetype holds throttle.
 *  risk     base + sector bias + catch-up (trailing ⇒ riskier LEVEL and tolerance — never more thrust: the throttle
 *           is the physics' own −0.3..1 and nothing here touches power) + recovery mood.
 *  mistakes seeded mulberry32 in the buffer: throttle fumble, missed wave read, over-speed into a corner.
 *  traffic  avoidance from WORLD poses (closest approach over 2 s < 8 m ⇒ lateral offset away, held 1.5 s);
 *           blocking: someone faster 4–35 m behind ⇒ offset to the inside of the next turn (× aggression).
 *           Offsets stay inside the corridor room the line was built with.
 */
import { SIM_DT } from '../../core/loop';
import { B, AI_OUT_LEN, type BoatSimLayout } from '../../sim-worker/layout';
import type { Rigid6State } from '../../sea-physics/rigidBody';
import type { Course } from '../types';
import { AI, AI_IN } from './aiBlock';
import { ARCHETYPES, type Archetype, type ArchetypeId } from './archetypes';
import { HELM_RATE, holdThrottle, lockLimit, steerForCurvature } from './capability';
import { buildRacingLine, nearestSample, type RacingLine } from './line';
import { speedProfile } from './profile';

export const LINE_LEVELS = 5;
const G = 9.81;
const AVOID_R = 8;
const WAVE_T = [0, 0.3, 0.6, 0.9, 1.2] as const;
const BOW_AHEAD = 7;
const HEEL_EASE = (22 * Math.PI) / 180;
const HEEL_ZERO = (38 * Math.PI) / 180;
const ROLL_DEADBAND = Math.sin((20 * Math.PI) / 180);
const ROLL_KP = 0.8;
const ROLL_KD = 0.15;
/** seconds after a placement (grid, respawn) the helm is held to a fraction of the lock while the hull settles */
const SETTLE_S = 1.5;

export interface LineLevel {
  risk: number;
  margin: number;
  latUse: number;
  brakeUse: number;
  line: RacingLine;
  speed: Float64Array;
}

/** structured-clone-safe: crosses to a worker in the init message */
export interface PilotSetup {
  version: 1;
  seed: number;
  /** false ⇒ trailing never raises risk (the A/B control for the catch-up test) */
  catchUp: boolean;
  levels: LineLevel[];
  /** per fleet boat index; null = not piloted (the player, a pace boat) */
  boats: (Archetype | null)[];
}

/** what risk does to the line: margin off the poles, share of the measured turning, braking point */
export function levelShape(risk: number): { margin: number; latUse: number; brakeUse: number } {
  return { margin: 7 - 5 * risk, latUse: 0.72 + 0.2 * risk, brakeUse: 0.3 + 0.6 * risk };
}

export function buildPilotSetup(course: Course, roster: readonly (ArchetypeId | Archetype | null)[], opts: { seed: number; catchUp?: boolean }): PilotSetup {
  const levels: LineLevel[] = [];
  for (let k = 0; k < LINE_LEVELS; k++) {
    const risk = k / (LINE_LEVELS - 1);
    const shape = levelShape(risk);
    const line = buildRacingLine(course, { margin: shape.margin });
    levels.push({ risk, ...shape, line, speed: speedProfile(line, shape) });
  }
  return {
    version: 1,
    seed: opts.seed >>> 0,
    catchUp: opts.catchUp ?? true,
    levels,
    boats: roster.map((r) => (r === null ? null : typeof r === 'string' ? { ...ARCHETYPES[r] } : { ...r })),
  };
}

export interface SeaHeight {
  heightAt(x: number, z: number, time: number): number;
}

export interface PilotOutput {
  /** drive angle, rad (+ = bow to port) — straight into HullWater.setControls */
  steer: number;
  throttle: number;
}

const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);

function rng(f: Float64Array, o: number): number {
  let t = (f[o] + 0x6d2b79f5) >>> 0;
  f[o] = t;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export class RacePilot {
  readonly setup: PilotSetup;
  // scratch for line lookups (no allocation per tick)
  private px = 0;
  private pz = 0;
  private pnx = 0;
  private pnz = 0;

  constructor(setup: PilotSetup) {
    if (setup.version !== 1) throw new Error(`race pilot: setup version ${setup.version}`);
    this.setup = setup;
  }

  drives(i: number): boolean {
    return i < this.setup.boats.length && this.setup.boats[i] !== null;
  }

  /** line point + starboard normal at arc length s (wrapped), linear between samples */
  private at(line: RacingLine, s: number): number {
    const n = line.n;
    let u = s / line.ds;
    u = ((u % n) + n) % n;
    const i = Math.floor(u);
    const j = (i + 1) % n;
    const t = u - i;
    this.px = line.x[i] + (line.x[j] - line.x[i]) * t;
    this.pz = line.z[i] + (line.z[j] - line.z[i]) * t;
    this.pnx = line.tz[i];
    this.pnz = -line.tx[i];
    return i;
  }

  private levelFor(risk: number): number {
    return Math.round(clamp(risk, 0, 1) * (LINE_LEVELS - 1));
  }

  /** global projection, rejecting samples whose tangent points against the boat's heading */
  private project(line: RacingLine, x: number, z: number, fx: number, fz: number): number {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < line.n; i++) {
      const dx = line.x[i] - x;
      const dz = line.z[i] - z;
      const d = dx * dx + dz * dz + (line.tx[i] * fx + line.tz[i] * fz < 0 ? 1e6 : 0);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  control(i: number, L: BoatSimLayout, state: Readonly<Rigid6State>, sea: SeaHeight, time: number, justReset: boolean, out: PilotOutput): void {
    const arch = this.setup.boats[i] as Archetype;
    const f = L.f64;
    const a = L.aiOffset(i);
    const ai = a + AI_OUT_LEN;
    const DT = SIM_DT;
    const x = state.position[0];
    const z = state.position[2];
    const vx = state.velocity[0];
    const vz = state.velocity[2];
    const V = Math.hypot(vx, vz);
    const [qx, qy, qz, qw] = state.quaternion;
    const upY = 1 - 2 * (qx * qx + qz * qz);
    const fx = 2 * (qx * qz + qw * qy);
    const fz = 1 - 2 * (qx * qx + qy * qy);
    const valid = f[ai + AI_IN.VALID] === 1;
    const gap = valid ? f[ai + AI_IN.GAP_TO_LEADER] : 0;
    const stCode = valid ? f[ai + AI_IN.STATE] : 0;
    const go = valid ? f[ai + AI_IN.GO] : 1;

    // ── projection onto the line ───────────────────────────────────────────────────────────────────────────
    let level = f[a + AI.LEVEL];
    const first = f[a + AI.INIT] !== 1;
    f[a + AI.RESPAWNED] = 0;
    if (first || justReset) {
      if (first) {
        level = this.levelFor(arch.risk);
        let seed = (Math.imul(this.setup.seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(i + 1, 0xc2b2ae35)) >>> 0;
        if (seed === 0) seed = 0x1234567;
        f[a + AI.RNG] = seed;
        f[a + AI.MISTAKE_T] = 0;
        f[a + AI.MISTAKE_KIND] = 0;
        f[a + AI.RECOVERY_T] = 0;
        f[a + AI.STATION] = 0;
      } else {
        f[a + AI.RECOVERY_T] = arch.recoveryS;
        f[a + AI.RESPAWNED] = 1;
      }
      const line = this.setup.levels[level].line;
      const idx = this.project(line, x, z, fx, fz);
      const frac = idx / line.n;
      const old = f[a + AI.STATION];
      let d = frac - (old - Math.floor(old));
      d -= Math.round(d);
      f[a + AI.STATION] = first ? frac : old + d;
      f[a + AI.HINT] = idx;
      f[a + AI.INTEGRAL] = 0;
      f[a + AI.STEER] = 0;
      f[a + AI.OFFSET] = 0;
      f[a + AI.AVOID_T] = 0;
      f[a + AI.WAVE_LIFT] = 0;
      f[a + AI.JUMP] = 0;
      if (first) f[a + AI.SEA] = 0;
      f[a + AI.INIT] = 1;
    }
    let lv = this.setup.levels[level];
    let line = lv.line;
    const track = (): { idx: number; s: number } => {
      const hint = f[a + AI.HINT];
      const win = Math.ceil((V * DT * 4 + 24) / line.ds);
      const idx = nearestSample(line, x, z, hint, win);
      const along = (x - line.x[idx]) * line.tx[idx] + (z - line.z[idx]) * line.tz[idx];
      let s = idx * line.ds + clamp(along, -line.ds, line.ds);
      s = ((s % line.length) + line.length) % line.length;
      const old = f[a + AI.STATION];
      let d = s / line.length - (old - Math.floor(old));
      d -= Math.round(d);
      f[a + AI.STATION] = old + d;
      f[a + AI.HINT] = idx;
      return { idx, s };
    };
    let { idx, s } = track();

    // ── risk ───────────────────────────────────────────────────────────────────────────────────────────────
    const sheltered = line.sheltered[idx] === 1;
    const trail = this.setup.catchUp && valid ? clamp((gap - 1) / 6, 0, 1) : 0;
    const recovering = f[a + AI.RECOVERY_T] > 0;
    const risk = clamp(arch.risk + (sheltered ? arch.shelteredBias : arch.exposedBias) + trail * arch.catchUp + (recovering ? arch.recoveryRisk : 0), 0, 1);
    f[a + AI.RECOVERY_T] = Math.max(0, f[a + AI.RECOVERY_T] - DT);
    f[a + AI.RISK] = risk;
    const want = risk * (LINE_LEVELS - 1);
    if (Math.abs(want - level) > 0.7) {
      const frac = f[a + AI.STATION] - Math.floor(f[a + AI.STATION]);
      level = this.levelFor(risk);
      lv = this.setup.levels[level];
      line = lv.line;
      f[a + AI.HINT] = Math.round(frac * line.n) % line.n;
      ({ idx, s } = track());
    }
    f[a + AI.LEVEL] = level;
    const nx = line.tz[idx];
    const nz = -line.tx[idx];
    const xte = (x - line.x[idx]) * nx + (z - line.z[idx]) * nz;
    f[a + AI.CROSS_TRACK] = xte;

    // ── mistakes (seeded) ──────────────────────────────────────────────────────────────────────────────────
    if (f[a + AI.MISTAKE_T] > 0) {
      f[a + AI.MISTAKE_T] -= DT;
      if (f[a + AI.MISTAKE_T] <= 0) f[a + AI.MISTAKE_KIND] = 0;
    } else if (rng(f, a + AI.RNG) < (arch.mistakesPerMin / 60) * (1 + risk) * DT) {
      f[a + AI.MISTAKE_KIND] = 1 + Math.floor(rng(f, a + AI.RNG) * 3);
      f[a + AI.MISTAKE_T] = 0.6 + rng(f, a + AI.RNG) * 1.2;
    }
    const mistake = f[a + AI.MISTAKE_KIND];
    const ticks = f[a + AI.TICKS] + 1;
    f[a + AI.TICKS] = ticks;

    // ── upset / crashed: cut throttle, centre the helm, wait for the race logic's respawn ────────────────────
    const upset = upY < 0.5 || stCode === 1 || stCode === 2;
    f[a + AI.UPSET] = upset ? 1 : 0;
    if (upset) {
      const prev = f[a + AI.STEER];
      const steer = prev - clamp(prev, -HELM_RATE * DT, HELM_RATE * DT);
      f[a + AI.STEER] = steer;
      f[a + AI.THROTTLE] = 0;
      f[a + AI.INTEGRAL] = 0;
      f[a + AI.WAVE_LIFT] = 0;
      out.steer = steer;
      out.throttle = 0;
      return;
    }

    // ── traffic: avoidance and blocking from the WORLD snapshot ─────────────────────────────────────────────
    const ltx = line.tx[idx];
    const ltz = line.tz[idx];
    let avoid = 0;
    let blocking = false;
    for (let j = 0; j < L.spec.boats; j++) {
      if (j === i) continue;
      const w = L.worldPoseOffset(j);
      if (f[w + 3] === 0 && f[w + 4] === 0 && f[w + 5] === 0 && f[w + 6] === 0) continue; // never placed
      const dx = f[w] - x;
      const dz = f[w + 2] - z;
      if (dx * dx + dz * dz > 3600) continue;
      const along = dx * ltx + dz * ltz;
      const lat = dx * nx + dz * nz;
      const rvx = f[w + 7] - vx;
      const rvz = f[w + 9] - vz;
      const rv2 = rvx * rvx + rvz * rvz;
      const tStar = rv2 > 1e-6 ? clamp(-(dx * rvx + dz * rvz) / rv2, 0, 2) : 0;
      const cx = dx + rvx * tStar;
      const cz = dz + rvz * tStar;
      const dmin = Math.hypot(cx, cz);
      if (dmin < AVOID_R && along > -6) {
        const latAt = cx * nx + cz * nz;
        const cand = (latAt >= 0 ? -1 : 1) * 8 * ((AVOID_R - dmin) / AVOID_R);
        if (Math.abs(cand) > Math.abs(avoid)) avoid = cand;
      } else if (along < -4 && along > -35 && Math.abs(lat) < 12 && rvx * ltx + rvz * ltz > 0.5) {
        blocking = true;
      }
    }
    const Ld = clamp(arch.lookaheadS * V, 25, 70);
    this.at(line, s + Ld);
    let target: number;
    let offset = f[a + AI.OFFSET];
    if (avoid !== 0) {
      f[a + AI.AVOID_T] = 1.5;
      target = avoid;
    } else if (f[a + AI.AVOID_T] > 0) {
      f[a + AI.AVOID_T] -= DT;
      target = offset;
    } else if (blocking && arch.aggression > 0) {
      let k = 0;
      const span = Math.round(150 / line.ds);
      for (let q = 0; q < span; q++) k += line.kappa[(idx + q) % line.n];
      target = Math.sign(k) * arch.aggression * 6;
    } else {
      target = 0;
    }
    f[a + AI.BLOCKING] = blocking && avoid === 0 && arch.aggression > 0 ? 1 : 0;
    // the offset must fit the corridor over the whole lookahead, not just at its ends (a gate between them binds),
    // less a metre for tracking error
    let roomP = Infinity;
    let roomS = Infinity;
    for (let q = idx, c = 0; c <= Math.ceil((Ld + BOW_AHEAD) / line.ds); c++, q = (q + 1) % line.n) {
      if (line.roomPort[q] < roomP) roomP = line.roomPort[q];
      if (line.roomStbd[q] < roomS) roomS = line.roomStbd[q];
    }
    target = clamp(target, -Math.max(0, roomP - 1), Math.max(0, roomS - 1));
    offset += clamp(target - offset, -3 * DT, 3 * DT);
    f[a + AI.OFFSET] = offset;

    // ── steer: pure pursuit on the (offset) line ────────────────────────────────────────────────────────────
    const tgx = this.px + this.pnx * offset;
    const tgz = this.pz + this.pnz * offset;
    const courseYaw = V > 3 ? Math.atan2(vx, vz) : Math.atan2(fx, fz);
    let alpha = Math.atan2(tgx - x, tgz - z) - courseYaw;
    alpha = Math.atan2(Math.sin(alpha), Math.cos(alpha));
    const kappa = (2 * Math.sin(alpha)) / Ld;
    const Vs = Math.max(V, 6);
    // heel limiter: past HEEL_EASE the lock shrinks to nothing at HEEL_ZERO (a pilot eases the helm when she lays
    // over; the measured steady turns sit at 18–26° tilt, the physics departs past 45°)
    const tilt = Math.acos(clamp(upY, -1, 1));
    const hardLock = lockLimit(V);
    const settling = f[a + AI.TICKS] * DT < SETTLE_S || (recovering && f[a + AI.RECOVERY_T] > arch.recoveryS - SETTLE_S);
    const lock = hardLock * clamp((HEEL_ZERO - tilt) / (HEEL_ZERO - HEEL_EASE), 0, 1) * (settling ? 0.4 : 1);
    let stbd = Math.sign(kappa) * steerForCurvature(Vs, kappa) + 0.12 * (kappa * Vs - state.angularVelocity[1]);
    // roll helm (a skill, × waveSkill): the drives roll her INTO a turn (physics-log T179 r2), so steering away from a
    // heel rights her; only past 20° of heel (a steady turn sits below it), proportional + against roll rate. sinHeel > 0 = starboard side up = heeled to port.
    const sinHeel = 2 * (qx * qy + qw * qz);
    const w = state.angularVelocity;
    const rollRate = w[0] * fx + w[1] * (2 * (qy * qz - qw * qx)) + w[2] * fz;
    if (Math.abs(sinHeel) > ROLL_DEADBAND) {
      stbd += arch.waveSkill * (ROLL_KP * (sinHeel - Math.sign(sinHeel) * ROLL_DEADBAND) + ROLL_KD * rollRate);
    }
    stbd = clamp(stbd, -lock, lock);
    const prevSteer = f[a + AI.STEER];
    let steer = prevSteer + clamp(-stbd - prevSteer, -HELM_RATE * DT, HELM_RATE * DT);
    // easing off past the heel/settle limit gets a second helm-rate's worth: a pilot unwinds faster than she winds on
    if (Math.abs(steer) > lock) steer -= Math.sign(steer) * Math.min(Math.abs(steer) - lock, HELM_RATE * DT);
    steer = clamp(steer, -hardLock, hardLock);
    f[a + AI.STEER] = steer;

    // ── throttle: PI on the profile ─────────────────────────────────────────────────────────────────────────
    const u = (s + V * 0.6) / line.ds;
    const n = line.n;
    const i0 = ((Math.floor(u) % n) + n) % n;
    const i1 = (i0 + 1) % n;
    const tt = u - Math.floor(u);
    let vT = lv.speed[i0] + (lv.speed[i1] - lv.speed[i0]) * tt;
    // sea respect (× waveSkill × (1 − risk)): rough water ahead ⇒ a careful pilot runs slower than the flat-water profile
    vT *= 1 - arch.waveSkill * (1 - risk) * clamp((f[a + AI.SEA] - 0.15) / 0.5, 0, 0.4);
    if (mistake === 3) vT *= 1.06;
    if (go <= 0) vT = Math.min(vT, -go);
    if (stCode === 4) vT = Math.min(vT, 15);
    f[a + AI.TARGET_SPEED] = vT;
    const e = vT - V;
    const integ = clamp(f[a + AI.INTEGRAL] + e * DT, -4, 4);
    f[a + AI.INTEGRAL] = integ;
    let thr = holdThrottle(vT, steer) + 0.35 * e + 0.08 * integ;
    thr = clamp(thr, e < -1.5 ? -0.3 : 0, 1);
    if (mistake === 1) thr = Math.min(thr, 0.35);

    // ── wave reading ────────────────────────────────────────────────────────────────────────────────────────
    const exposed = !sheltered;
    if (ticks % 3 === 0) {
      let lift = 0;
      let jump = 0;
      if (V > 8) {
        let hPrev = 0;
        let slopePrev = 0;
        let maxAir = 0;
        let stuff = 0;
        for (let k = 0; k < WAVE_T.length; k++) {
          this.at(line, s + BOW_AHEAD + V * WAVE_T[k]);
          // the surface AT THIS TICK: CpuOcean.heightAt(…, t ≠ its time) runs update(t), which rebuilds the mirror
          // and steps the spectrum scheduler — a future-time read would move the sea every boat floats on
          const h = sea.heightAt(this.px + this.pnx * xte, this.pz + this.pnz * xte, time);
          if (k > 0) {
            const slope = (h - hPrev) / (V * (WAVE_T[k] - WAVE_T[k - 1]));
            if (slope > 0) maxAir = Math.max(maxAir, (2 * V * slope) / G);
            if (k > 1 && slopePrev < 0 && slope > 0) stuff = Math.max(stuff, slope - slopePrev);
            slopePrev = slope;
          }
          hPrev = h;
        }
        const tol = arch.airTolerance + 0.35 * risk + (exposed ? 0.3 * arch.jumpAppetite : 0);
        const need = Math.min(1, clamp((maxAir - tol) / 0.4, 0, 1) + clamp((stuff - (0.1 + 0.1 * risk)) / 0.15, 0, 1));
        lift = mistake === 2 ? 0 : need * arch.waveSkill;
        jump = exposed && arch.jumpAppetite > 0.5 && maxAir > 0.35 && maxAir <= tol ? 1 : 0;
        f[a + AI.SEA] += (maxAir - f[a + AI.SEA]) * ((3 * DT) / 4);
      }
      f[a + AI.WAVE_LIFT] = Math.max(lift, f[a + AI.WAVE_LIFT] - (3 * DT) / 0.6);
      f[a + AI.JUMP] = jump;
    }
    const waveLift = f[a + AI.WAVE_LIFT];
    if (thr > 0) thr *= 1 - waveLift;
    if (f[a + AI.JUMP] === 1 && e > -1) thr = Math.max(thr, 0.95);
    // props out of the water (last tick's contact): feather unless the pilot likes to land pinned
    if (f[L.boatOffset(i) + B.PROP_IMMERSION] < 0.05 && arch.jumpAppetite < 0.7) thr = Math.min(thr, 0.4);
    f[a + AI.THROTTLE] = thr;
    f[a + AI.TRIM] = waveLift > 0.2 ? -waveLift : V > 20 ? 0.3 : 0;
    out.steer = steer;
    out.throttle = thr;
  }
}
