/**
 * SCRIPTED DRIVER for the trailer (docs/cine/speedboat-trailer-v1.md): the hero boat follows a shot's path at a shot's
 * speed through the SAME `ControlSource` seam the keyboard, the gamepad and `?autopilot` use, so the same rigid6 +
 * HullWater step the player drives runs every frame of a take (§V110) — nothing is animated, the boat is driven.
 *
 * DETERMINISTIC. The controller is a pure function of the boat's tick-start state, the spec and a clock advanced by the
 * fixed tick's own dt (§V2): the same shot re-rendered at 4K lands on the same water as a 720p preview. The clock is
 * the driver's, not the director's — the director's advances on the render path and would make the controls depend on
 * frame pacing.
 *
 * WHY NOT THE RACE PILOT (race/ai/pilot.ts, page/autopilot.ts). It follows the course's racing line through the gates
 * with a race standing and a world snapshot of eight boats; a trailer path goes where the camera is — round an island
 * tip, through a rock gap, along a sunset — and a line that is not the lap has no `PilotSetup`. Pure pursuit + a speed
 * PI is what is left once the race is taken out, and it is a few dozen lines.
 *
 * PLACEMENT goes through the free-roam session's own `start` (`rules`): crash machine, collide memory, `player.place`
 * and the page's teleport side effects (frame snap, camera snap, controls reset) — the same path a free-roam (re)start
 * takes, never a second teleport.
 */
import type { Vec2 } from '../../race/types';
import type { Rigid6State } from '../../sea-physics/rigidBody';
import { SPAWN_CG_Y } from '../page/course';
import type { BoatControls, ControlSource } from '../page/seams';
import type { FreeRoamRules } from '../page/sessionMode';

/** a value over shot-local time (s): linear between keys, held before the first and after the last */
export interface DriveKey {
  t: number;
  v: number;
}

export interface DriveSpec {
  /** world XZ polyline she follows; placed on it `startS` m in, pointing along it. Past the end she holds its bearing. */
  path: readonly Vec2[];
  startS?: number;
  /** speed at placement along her heading, m/s (default 0: at rest) */
  startSpeed?: number;
  /** target speed over shot time, m/s. 0 = throttle off. */
  speed: readonly DriveKey[];
  /** open-loop throttle over shot time, while `t` is inside its keys' span — overrides the speed loop (the 06 insert) */
  throttle?: readonly DriveKey[];
  /** drive trim −1..1 over shot time (default 0) */
  trim?: readonly DriveKey[];
  /** a steering correction laid over the follower: steer amplitude, Hz, active shot-time window */
  weave?: { amp: number; hz: number; from: number; to: number };
  /** pursuit lookahead, s of travel (default 1.4 s, never under 18 m) */
  lookaheadS?: number;
  /** steer authority above 14 m/s (default 0.55: full lock hooks the hull above C_v ≈ 5, page/controls.ts) */
  steerLimit?: number;
}

export const keyAt = (keys: readonly DriveKey[], t: number): number => {
  if (keys.length === 0) return 0;
  const first = keys[0] as DriveKey;
  if (t <= first.t) return first.v;
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i] as DriveKey;
    if (t <= b.t) {
      const a = keys[i - 1] as DriveKey;
      const u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
      return a.v + (b.v - a.v) * u;
    }
  }
  return (keys[keys.length - 1] as DriveKey).v;
};

const wrap = (a: number): number => {
  let d = a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
};

/** the point `s` m along the path (extended straight past either end) and the path bearing there, atan2(x, z) */
export function pathAt(path: readonly Vec2[], s: number): { x: number; z: number; yaw: number } {
  if (path.length < 2) throw new Error('cine drive: a path needs two points');
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as Vec2;
    const b = path[i] as Vec2;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (s <= acc + len || i === path.length - 1) {
      const u = len > 0 ? (s - acc) / len : 0;
      const ui = i === 1 ? u : Math.max(u, 0); // before the start: extend the first segment back
      return { x: a[0] + (b[0] - a[0]) * ui, z: a[1] + (b[1] - a[1]) * ui, yaw: Math.atan2(b[0] - a[0], b[1] - a[1]) };
    }
    acc += len;
  }
  throw new Error('unreachable');
}

/** arc length of the path point nearest (x, z), searching segments from `fromSeg` on (progress never runs backwards) */
export function nearestS(path: readonly Vec2[], x: number, z: number, fromSeg = 0): { s: number; seg: number } {
  let best = Infinity;
  let bestS = 0;
  let bestSeg = fromSeg;
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as Vec2;
    const b = path[i] as Vec2;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len2 = dx * dx + dz * dz;
    const len = Math.sqrt(len2);
    if (i - 1 >= fromSeg) {
      const last = i === path.length - 1;
      let u = len2 > 0 ? ((x - a[0]) * dx + (z - a[1]) * dz) / len2 : 0;
      u = Math.max(0, last ? u : Math.min(u, 1));
      const px = a[0] + dx * u;
      const pz = a[1] + dz * u;
      const d = (x - px) ** 2 + (z - pz) ** 2;
      if (d < best) {
        best = d;
        bestS = acc + u * len;
        bestSeg = i - 1;
      }
    }
    acc += len;
  }
  return { s: bestS, seg: bestSeg };
}

/** heading yaw atan2(x, z) of a body +Z under quaternion q */
const yawOf = (q: ArrayLike<number>): number => {
  const [x, y, z, w] = [q[0], q[1], q[2], q[3]];
  return Math.atan2(2 * (x * z + w * y), 1 - 2 * (x * x + y * y));
};

/** the placement a spec asks for: on its path at `startS`, level, pointing along it, at `startSpeed` */
export function drivePose(spec: DriveSpec, waterAt: (x: number, z: number) => number): Rigid6State {
  const p = pathAt(spec.path, spec.startS ?? 0);
  const v = spec.startSpeed ?? 0;
  return {
    position: [p.x, waterAt(p.x, p.z) + SPAWN_CG_Y, p.z],
    quaternion: [0, Math.sin(p.yaw / 2), 0, Math.cos(p.yaw / 2)],
    velocity: [Math.sin(p.yaw) * v, 0, Math.cos(p.yaw) * v],
    angularVelocity: [0, 0, 0],
  };
}

/**
 * The follower. STEER SIGN, measured (page/controls.ts): positive steer yaws the bow toward world −x from a +z
 * heading, i.e. DEcreases atan2(x, z) — so the steer opposes the heading error. Speed: PI on forward speed with a
 * feed-forward of 1/38 per m/s (full throttle tops out near 38 m/s on the deep-V).
 */
export class PathFollower {
  private seg = 0;
  private integral = 0;
  readonly out: BoatControls = { steer: 0, throttle: 0, trim: 0, surge: false };

  constructor(readonly spec: DriveSpec) {}

  reset(): void {
    this.seg = 0;
    this.integral = 0;
  }

  step(t: number, dt: number, boat: Readonly<Rigid6State>): Readonly<BoatControls> {
    const s = this.spec;
    const yaw = yawOf(boat.quaternion);
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const v = boat.velocity[0] * fx + boat.velocity[2] * fz;

    // --- steer: pure pursuit on the path
    const near = nearestS(s.path, boat.position[0], boat.position[2], this.seg);
    this.seg = near.seg;
    const look = Math.max(18, Math.max(v, 0) * (s.lookaheadS ?? 1.4));
    const aim = pathAt(s.path, near.s + look);
    const want = Math.atan2(aim.x - boat.position[0], aim.z - boat.position[2]);
    const err = wrap(want - yaw);
    const yawRate = boat.angularVelocity[1];
    // softer at speed: full lock hooks the hull above C_v ≈ 5 (page/controls.ts)
    // and never full lock below it either: a take re-placed at 80% speed that corrected with full lock at 13 m/s
    // logged a crash respawn (shot 14c, browser check)
    const lock = v > 14 ? (s.steerLimit ?? 0.55) : 0.6;
    let steer = -(1.6 * err - 0.35 * yawRate);
    if (s.weave && t >= s.weave.from && t <= s.weave.to) steer += s.weave.amp * Math.sin((t - s.weave.from) * s.weave.hz * Math.PI * 2);
    this.out.steer = Math.max(-lock, Math.min(lock, v < 1 ? 0 : steer));

    // --- throttle: open-loop keys where given, else the speed loop
    const open = s.throttle !== undefined && s.throttle.length > 0 && t >= (s.throttle[0] as DriveKey).t && t <= (s.throttle[s.throttle.length - 1] as DriveKey).t;
    const target = keyAt(s.speed, t);
    if (open) {
      this.out.throttle = keyAt(s.throttle as readonly DriveKey[], t);
      this.integral = 0;
    } else if (target <= 0.05) {
      this.out.throttle = 0;
      this.integral = 0;
    } else {
      const e = target - v;
      this.integral = Math.max(-0.5, Math.min(0.5, this.integral + e * dt * 0.06));
      this.out.throttle = Math.max(0, Math.min(1, target / 38 + 0.12 * e + this.integral));
    }
    this.out.trim = s.trim ? keyAt(s.trim, t) : 0;
    return this.out;
  }
}

export interface CineDrive {
  /** the page's control source with the cine's driver in front of it while a shot is armed */
  over(base: ControlSource): ControlSource;
  /** free-roam rules whose `spawn` is the armed shot's placement (falls back to the base spawn) */
  rules(base: FreeRoamRules): FreeRoamRules;
  /** arm a shot's drive from shot-local time `t0`; the next session start places her. `null` hands the boat back. */
  arm(spec: DriveSpec | null, t0: number): void;
  /** shot-local time on the driver's own fixed-tick clock, or null when unarmed */
  readonly time: number | null;
  /** crash respawns the session asked for while armed — a take with one is not the take that was scripted */
  readonly respawns: number;
}

export function createCineDrive(waterAt: (x: number, z: number) => number): CineDrive {
  let follower: PathFollower | null = null;
  let t = 0;
  let respawns = 0;
  return {
    over(base) {
      return {
        sample(dt, boat) {
          if (follower === null) return base.sample(dt, boat);
          const c = follower.step(t, dt, boat);
          t += dt;
          return c;
        },
        dispose: () => base.dispose(),
      };
    },
    rules(base) {
      return {
        spawn: () => (follower === null ? base.spawn() : drivePose(follower.spec, waterAt)),
        respawn: (q) => {
          if (follower !== null) {
            respawns++;
            const c = q.crashPosition;
            console.warn(
              `[cine] the hero CRASHED (at ${c[0].toFixed(0)}, ${c[2].toFixed(0)}, ${q.speedBeforeCrash.toFixed(1)} m/s) and respawned at shot ` +
                `time ${t.toFixed(2)} s — this take is not the scripted one`,
            );
          }
          return base.respawn(q);
        },
      };
    },
    arm(spec, t0) {
      follower = spec === null ? null : new PathFollower(spec);
      t = t0;
      respawns = 0;
    },
    get time() {
      return follower === null ? null : t;
    },
    get respawns() {
      return respawns;
    },
  };
}
