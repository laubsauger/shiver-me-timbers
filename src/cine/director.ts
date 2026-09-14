/**
 * Shot-list runtime. Turns (shot, shot-local time) into a camera pose and a
 * world state, and writes both.
 *
 * SPLIT IN TWO ON PURPOSE. `applyWorld` runs inside the fixed SIM TICK and
 * `applyCamera` runs in the RENDER path after the camera chain is final. They
 * cannot be one call:
 *
 *  - World params must land inside the tick, immediately after
 *    `oceanAmbient.publish(...)`. The §V.62 ambient hold rewrites oceanParams
 *    on every tick from the weather sample, so anything written from the
 *    render path is clobbered before it is ever read. Same for `timeOfDay`,
 *    which `applyWorldSettings` reverts (docs/agent-browser-harness.md §6).
 *    This is also why it re-asserts EVERY tick rather than once per shot.
 *
 *  - The camera must be written after `followCam.update` and
 *    `combat.shake.apply`, because both write `camera.position`/rotation and
 *    whichever runs last wins. Everything downstream that reads the camera
 *    (clouds, surface, underwater, gunnery) already sits after that point.
 */
import type { PerspectiveCamera, Vector3 } from 'three';
import { Euler, Quaternion, Vector3 as V3 } from 'three';
import { skyParams } from '../params/sky';
import { sunElevation } from '../sky/sunCycle';
import { oceanParams } from '../params/ocean';
import { oceanSurfaceParams } from '../params/oceanSurface';
import { postParams } from '../params/post';
import { gradeParams } from '../params/grade';
import { lanternParams } from '../params/lanterns';
import { cloudParams } from '../params/clouds';
import { GLOBAL_WORLD, SHOTS } from './shotlist';
import type { Shot, ShotKey, Vec3, WorldPatch } from './types';

export interface ShipPose {
  position: readonly [number, number, number];
  /** x, y, z, w */
  quaternion: readonly [number, number, number, number];
}

export interface DirectorHost {
  /** live sea height, world XZ — the same fn followCam is handed */
  heightAt(x: number, z: number): number;
  /** the hull the shot frames */
  shipPose(): ShipPose;
  /** normalized world direction toward the key light (sky.sunDirection) */
  sunDirection(): Vector3;
  /** drive the hull without waiting on the wind (__game.setSpeed) */
  setShipSpeed(knots: number): void;
  setShipAnchored(anchored: boolean): void;
  /** weather preset switch; the director asks for an instant one */
  setWeather(name: string): void;
  /**
   * Put the world into a state a shot can be taken in. Called once per shot
   * cue, not per tick.
   *
   * THIS IS NOT HOUSEKEEPING. The first recorded shot came back as open water
   * with no ship in it: the enemy AI had spent the 10 s preroll putting two
   * broadsides into the hero, and she was sitting on the seabed 8.5 m down
   * with `flood: 1` before the first frame was captured. A cinematic run has
   * to disarm the game.
   */
  prepareScene(): void;
  /**
   * Re-assert that state every tick — the AI re-approaches and the sea keeps
   * flooding a holed hull, so preparing once is not enough over a 22 s take.
   */
  holdScene(): void;
  /**
   * Strike the set. The reference is open ocean and nothing else, so a shoot
   * hides the archipelago, the second hull and every in-world overlay; a
   * headland on the horizon of a shot that is meant to read as "no land
   * anywhere" is the one mistake the whole piece cannot survive.
   */
  setShooting(shooting: boolean): void;
  /**
   * Render at an exact output size regardless of the window.
   *
   * It has to move the RENDERER, not just the capture target: the post
   * pipeline's scene pass is sized from the renderer, so reading a 1920x1080
   * target out of a 1280x720 pipeline is an upscale wearing a 1080p filename.
   */
  setRenderSize(width: number, height: number): void;
  /** put the window's own size back */
  restoreRenderSize(): void;
}

const DEG = Math.PI / 180;

/**
 * Solve `timeOfDay` for a target sun elevation.
 *
 * Elevation is monotonic in time on each side of noon, so a bisection over
 * the half-day is exact enough at 40 steps (< 0.001 h) and cannot be fooled
 * by a latitude change the way a hand-written clock time is. Returns the
 * nearest achievable time when the target is out of reach — a sun that never
 * rises that high at this latitude clamps to local noon rather than throwing,
 * because a shot that renders slightly wrong is recoverable and a shoot that
 * dies on frame 3000 is not.
 */
export function timeForSunElevation(
  targetDeg: number,
  side: 'morning' | 'evening' = 'morning',
  latitude: number = skyParams.latitude,
): number {
  const target = targetDeg * DEG;
  // morning half runs 00->12 with elevation rising, evening 12->24 falling
  let lo = side === 'morning' ? 0 : 12;
  let hi = side === 'morning' ? 12 : 24;
  const rising = side === 'morning';
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) * 0.5;
    const e = sunElevation(mid, latitude);
    if (rising ? e < target : e > target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) * 0.5;
}

/* ------------------------------------------------------------------ *
 * pure key interpolation — no three, no host, unit testable
 * ------------------------------------------------------------------ */

/** zero velocity at t=0, full velocity at t=1 (shot D eases IN and not out) */
export function easeIn(x: number): number {
  const t = Math.min(Math.max(x, 0), 1);
  return t * t * (3 - 2 * t) * 0.5 + t * 0.5;
}

export interface SampledKey {
  pos: Vec3;
  aim: Vec3;
  fov: number;
  roll: number;
}

/**
 * Piecewise-linear along the key list, eased inside each span. Returns the
 * first key before the first `t` and the last one after the last, so a shot
 * with one key is a lock-off and a shot read past its end holds rather than
 * extrapolating off into the sea.
 */
export function sampleKeys(keys: readonly ShotKey[], t: number): SampledKey {
  if (keys.length === 0) throw new Error('cine: shot has no keys');
  const first = keys[0] as ShotKey;
  let fov = first.fov ?? 45;
  let roll = first.roll ?? 0;
  if (keys.length === 1 || t <= first.t) {
    return { pos: first.pos, aim: first.aim, fov, roll };
  }
  const last = keys[keys.length - 1] as ShotKey;
  if (t >= last.t) {
    // fov/roll are sticky: a later key that omits them inherits
    for (const k of keys) {
      if (k.fov !== undefined) fov = k.fov;
      if (k.roll !== undefined) roll = k.roll;
    }
    return { pos: last.pos, aim: last.aim, fov, roll };
  }
  let i = 0;
  while (i < keys.length - 2 && (keys[i + 1] as ShotKey).t <= t) i++;
  const a = keys[i] as ShotKey;
  const b = keys[i + 1] as ShotKey;
  for (let j = 0; j <= i; j++) {
    const k = keys[j] as ShotKey;
    if (k.fov !== undefined) fov = k.fov;
    if (k.roll !== undefined) roll = k.roll;
  }
  const span = b.t - a.t;
  const u = span > 1e-6 ? easeIn((t - a.t) / span) : 0;
  const lerp3 = (p: Vec3, q: Vec3): Vec3 => [
    p[0] + (q[0] - p[0]) * u,
    p[1] + (q[1] - p[1]) * u,
    p[2] + (q[2] - p[2]) * u,
  ];
  const fovB = b.fov ?? fov;
  const rollB = b.roll ?? roll;
  return {
    pos: lerp3(a.pos, b.pos),
    aim: lerp3(a.aim, b.aim),
    fov: fov + (fovB - fov) * u,
    roll: roll + (rollB - roll) * u,
  };
}

/**
 * Deterministic low-frequency wander. Three axes on incommensurate multiples
 * of the base frequency so the pattern never visibly repeats inside a shot,
 * and a pure function of shot-local time so re-rendering frame 412 gives back
 * the identical frame 412.
 */
export function wobbleAt(
  w: { yaw?: number; pitch?: number; roll?: number; alt?: number; hz?: number } | undefined,
  t: number,
): { yaw: number; pitch: number; roll: number; alt: number } {
  if (w === undefined) return { yaw: 0, pitch: 0, roll: 0, alt: 0 };
  const f = (w.hz ?? 0.08) * Math.PI * 2;
  return {
    yaw: (w.yaw ?? 0) * Math.sin(t * f * 1.0 + 0.7),
    pitch: (w.pitch ?? 0) * Math.sin(t * f * 1.37 + 2.1),
    roll: (w.roll ?? 0) * Math.sin(t * f * 0.79 + 4.3),
    alt: (w.alt ?? 0) * Math.sin(t * f * 1.61 + 1.2),
  };
}

/* ------------------------------------------------------------------ *
 * the director
 * ------------------------------------------------------------------ */

const tmpShipQ = new Quaternion();
const tmpHeadingQ = new Quaternion();
const tmpV = new V3();
const tmpAim = new V3();
const tmpEuler = new Euler();
const tmpFwd = new V3();
const tmpRight = new V3();
const UP = new V3(0, 1, 0);

/** heading only, from a quaternion — the Y term of a YXZ decomposition */
function yawOf(q: readonly [number, number, number, number]): number {
  const [x, y, z, w] = q;
  return Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + x * x));
}

/** apply a flat numeric/boolean patch onto a live params object */
function patch(target: Record<string, unknown>, src: Record<string, unknown> | undefined): void {
  if (src === undefined) return;
  for (const k of Object.keys(src)) target[k] = src[k];
}

/** every params object the director is allowed to write */
const TOUCHED = (): Record<string, Record<string, unknown>> => ({
  sky: skyParams as unknown as Record<string, unknown>,
  ocean: oceanParams as unknown as Record<string, unknown>,
  oceanSurface: oceanSurfaceParams as unknown as Record<string, unknown>,
  clouds: cloudParams as unknown as Record<string, unknown>,
  post: postParams as unknown as Record<string, unknown>,
  grade: gradeParams as unknown as Record<string, unknown>,
  lanterns: lanternParams as unknown as Record<string, unknown>,
});

export class Director {
  private shot: Shot | null = null;
  /** shot-local time, seconds. Negative during preroll. */
  private t = 0;
  private lastWeather = '';
  /** `frame: 'locked'` — the ship pose captured at cue, held for the take */
  private locked: ShipPose | null = null;
  /** `follow` — the damped pose the keys resolve against */
  private followed: { x: number; y: number; z: number; yaw: number } | null = null;

  /** the game's own world, held while a shoot rewrites it */
  private saved: Record<string, Record<string, unknown>> | null = null;

  constructor(private host: DirectorHost) {}

  /**
   * Take the world the game was in, so it can be given back.
   *
   * A shot writes fog ranges, exposure, moon, cloud coverage and ocean haze
   * straight into the live params, and NOTHING was putting them back: after a
   * shoot the game was left in the last shot's world — a hull fogged to a
   * ghost under a clear blue sky, because shot Q's `fogNear/fogFar` outlived
   * the run while the rest of its sky did not. Snapshot in, restore out.
   */
  snapshotWorld(): void {
    if (this.saved !== null) return;
    const out: Record<string, Record<string, unknown>> = {};
    for (const [k, obj] of Object.entries(TOUCHED())) out[k] = { ...obj };
    this.saved = out;
  }

  restoreWorld(): void {
    if (this.saved === null) return;
    const live = TOUCHED();
    for (const [k, was] of Object.entries(this.saved)) {
      const now = live[k];
      if (now !== undefined) Object.assign(now, was);
    }
    this.saved = null;
  }

  get current(): Shot | null {
    return this.shot;
  }
  get shotTime(): number {
    return this.t;
  }
  get active(): boolean {
    return this.shot !== null;
  }

  /** enter a shot at shot-local time `t` (pass -preroll to start settling) */
  cue(shot: Shot, t: number): void {
    this.shot = shot;
    this.t = t;
    this.lastWeather = '';
    this.locked = null;
    this.followed = null;
    this.host.prepareScene();
  }

  release(): void {
    this.shot = null;
  }

  advance(dt: number): void {
    this.t += dt;
    this.dt = dt;
  }

  private dt = 0;

  /**
   * SIM TICK. Writes the world the shot asks for, every tick, on purpose —
   * see the note at the top of this file for what reverts it otherwise.
   */
  applyWorld(): void {
    const s = this.shot;
    if (s === null) return;
    const apply = (w: WorldPatch | undefined): void => {
      if (w === undefined) return;
      if (w.sunElevationDeg !== undefined) {
        skyParams.timeOfDay = timeForSunElevation(w.sunElevationDeg, w.sunSide ?? 'morning');
      } else if (w.timeOfDay !== undefined) {
        skyParams.timeOfDay = w.timeOfDay;
      }
      patch(skyParams as unknown as Record<string, unknown>, w.sky as Record<string, unknown>);
      patch(cloudParams as unknown as Record<string, unknown>, w.clouds as Record<string, unknown>);
      patch(oceanParams as unknown as Record<string, unknown>, w.ocean as Record<string, unknown>);
      patch(
        oceanSurfaceParams as unknown as Record<string, unknown>,
        w.oceanSurface as Record<string, unknown>,
      );
      patch(postParams as unknown as Record<string, unknown>, w.post as Record<string, unknown>);
      patch(gradeParams as unknown as Record<string, unknown>, w.grade as Record<string, unknown>);
      patch(
        lanternParams as unknown as Record<string, unknown>,
        w.lanterns as Record<string, unknown>,
      );
    };
    this.host.holdScene();
    const w = s.world;

    // WEATHER FIRST. A preset is a BATCH OF PARAM WRITES (§V7) — it sets
    // `hazeStrength`, `sunIntensity` and the rest — so applying it AFTER the
    // shot's own `sky` block silently overwrites it. That is what made the fog
    // shots come back as clear blue afternoons: `glass` writes hazeStrength
    // 0.3 straight over the shot's 1.0. Latched, because switching every tick
    // would restart the transition forever.
    if (w?.weather !== undefined && w.weather !== this.lastWeather) {
      this.lastWeather = w.weather;
      this.host.setWeather(w.weather);
    }

    apply(GLOBAL_WORLD);
    apply(s.world);

    if (w === undefined) return;
    if (w.shipAnchored !== undefined) this.host.setShipAnchored(w.shipAnchored);
    if (w.shipKnots !== undefined) this.host.setShipSpeed(w.shipKnots);
  }

  /** RENDER PATH, after the camera chain is final. */
  applyCamera(camera: PerspectiveCamera): void {
    const s = this.shot;
    if (s === null) return;
    const k = sampleKeys(s.keys, Math.max(this.t, 0));
    const wob = wobbleAt(s.wobble, Math.max(this.t, 0));

    // --- resolve the key frame into world space -----------------------
    let ship = this.host.shipPose();

    // FOLLOW, DAMPED. Exponential smoothing toward her live pose, half-life in
    // seconds, frame-rate independent — the same damper shape followCam uses.
    // Position and HEADING only: pitch and roll are hers to have, and a rig
    // that inherited them would be bolted to the mast again.
    if (s.follow !== undefined && (s.frame === 'ship' || s.frame === 'hull')) {
      const yaw = yawOf(ship.quaternion);
      if (this.followed === null) {
        this.followed = { x: ship.position[0], y: ship.position[1], z: ship.position[2], yaw };
      } else {
        const k =
          this.dt > 0 ? 1 - Math.pow(0.5, this.dt / Math.max(s.follow.halfLife, 1e-3)) : 0;
        const f = this.followed;
        f.x += (ship.position[0] - f.x) * k;
        f.y += (ship.position[1] - f.y) * k;
        f.z += (ship.position[2] - f.z) * k;
        // shortest way round, or a heading crossing north spins the rig
        let d = yaw - f.yaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        f.yaw += d * k;
      }
      const f = this.followed;
      const h = Math.sin(f.yaw * 0.5);
      ship = { position: [f.x, f.y, f.z], quaternion: [0, h, 0, Math.cos(f.yaw * 0.5)] };
    }

    if (s.frame === 'locked') {
      // captured at the END of the preroll, not at cue: the hull settles,
      // makes her way and picks up a heading during those seconds, and locking
      // to the pose she had before any of that happened aims the shot at where
      // she used to be
      if (this.locked === null && this.t >= 0) {
        this.locked = {
          position: [ship.position[0], ship.position[1], ship.position[2]],
          quaternion: [
            ship.quaternion[0],
            ship.quaternion[1],
            ship.quaternion[2],
            ship.quaternion[3],
          ],
        };
      }
      if (this.locked !== null) ship = this.locked;
    }
    if (s.frame === 'world') {
      tmpV.set(k.pos[0], k.pos[1], k.pos[2]);
      tmpAim.set(k.aim[0], k.aim[1], k.aim[2]);
    } else {
      tmpShipQ.set(ship.quaternion[0], ship.quaternion[1], ship.quaternion[2], ship.quaternion[3]);
      let q = tmpShipQ;
      if (s.frame === 'ship' || s.frame === 'locked') {
        // HEADING ONLY. A drone holding station on a rolling hull does not
        // roll with her; inheriting the full quaternion is what makes an
        // aerial look like it is bolted to the mast.
        tmpEuler.setFromQuaternion(tmpShipQ, 'YXZ');
        q = tmpHeadingQ.setFromEuler(tmpEuler.set(0, tmpEuler.y, 0, 'YXZ'));
      }
      tmpV.set(k.pos[0], k.pos[1], k.pos[2]).applyQuaternion(q);
      tmpV.x += ship.position[0];
      tmpV.y += ship.position[1];
      tmpV.z += ship.position[2];
      tmpAim.set(k.aim[0], k.aim[1], k.aim[2]).applyQuaternion(q);
      tmpAim.x += ship.position[0];
      tmpAim.y += ship.position[1];
      tmpAim.z += ship.position[2];
    }

    tmpV.y += wob.alt;
    // rideSwell OVERRIDES y rather than adding to it: the whole point is that
    // the lens sits a fixed height above THIS frame's surface, so the bob and
    // the roll fall out of the sea itself and cost nothing.
    if (s.rideSwell !== undefined) {
      tmpV.y = this.host.heightAt(tmpV.x, tmpV.z) + s.rideSwell;
    }

    // --- aim ----------------------------------------------------------
    if (s.aimSun !== undefined) {
      // point AT the key light, then swing off it. Keeps the framing correct
      // across any timeOfDay/latitude change instead of silently drifting.
      tmpFwd.copy(this.host.sunDirection()).normalize();
      const yaw = (s.aimSun.yaw + wob.yaw) * DEG;
      const pitch = (s.aimSun.pitch + wob.pitch) * DEG;
      tmpRight.crossVectors(tmpFwd, UP).normalize();
      tmpFwd.applyAxisAngle(UP, -yaw).applyAxisAngle(tmpRight, -pitch).normalize();
      tmpAim.copy(tmpV).addScaledVector(tmpFwd, 1000);
    } else {
      tmpFwd.copy(tmpAim).sub(tmpV);
      const dist = tmpFwd.length();
      if (dist > 1e-4) {
        tmpFwd.divideScalar(dist);
        tmpRight.crossVectors(tmpFwd, UP).normalize();
        tmpFwd
          .applyAxisAngle(UP, -wob.yaw * DEG)
          .applyAxisAngle(tmpRight, -wob.pitch * DEG)
          .normalize();
        tmpAim.copy(tmpV).addScaledVector(tmpFwd, dist);
      }
    }

    camera.position.copy(tmpV);
    camera.up.set(0, 1, 0);
    camera.lookAt(tmpAim);
    const roll = (k.roll + wob.roll) * DEG;
    if (roll !== 0) camera.rotateZ(roll);
    camera.updateMatrixWorld(true);

    if (Math.abs(camera.fov - k.fov) > 1e-4) {
      camera.fov = k.fov;
      camera.updateProjectionMatrix();
    }
  }
}

export { SHOTS };
