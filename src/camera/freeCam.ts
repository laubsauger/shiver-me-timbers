/**
 * FreeCam — detached fly camera for inspection + screenshots (§V22: the
 * camera IS the acceptance instrument, so it has to be parkable). Holds its
 * own position/orientation and NEVER reads the ship: no snap-back, no
 * re-centering, no drift. Render-side only (§V.3), tunables in
 * params/camera.ts (§V.16).
 *
 * Convention matches camMath.sphericalOffset: yaw 0 = looking down +z,
 * positive pitch = looking up.
 */
import type { PerspectiveCamera, Vector3 } from 'three';
import { cameraParams } from '../params/camera';
import { clamp, sphericalOffset, stepFly, yawPitchFromDirection } from './camMath';

/** keys the free cam eats while active (see FollowCam's capture listener) */
export const FLY_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyR',
  'KeyF',
]);
/** modifiers the free cam reads but does NOT swallow */
const MODIFIER_KEYS = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight']);
/** below this, a transform delta is our own float noise, not an external write */
const EXTERNAL_EPS = 1e-9;

export class FreeCam {
  yaw = 0;
  pitch = 0;
  /** wheel-adjusted multiplier on top of params.freeSpeed */
  speedScale = 1;
  readonly position: [number, number, number] = [0, 0, 0];
  private vel = [0, 0, 0];
  private held = new Set<string>();
  private target = [0, 0, 0];
  /** last transform WE wrote: [px,py,pz, qx,qy,qz,qw] — see adoptExternal */
  private applied = [0, 0, 0, 0, 0, 0, 1];
  private hasApplied = false;

  /** true if the code belongs to the free cam and must not reach the sim */
  static consumes(code: string): boolean {
    return FLY_KEYS.has(code);
  }

  keyDown(code: string): void {
    if (FLY_KEYS.has(code) || MODIFIER_KEYS.has(code)) this.held.add(code);
  }

  keyUp(code: string): void {
    this.held.delete(code);
  }

  /** window blur / mode switch — drop everything so nothing sticks held */
  clearKeys(): void {
    this.held.clear();
    this.vel[0] = this.vel[1] = this.vel[2] = 0;
  }

  /** mouse-look: drag right = look right, drag down = look down */
  look(dx: number, dy: number): void {
    const p = cameraParams;
    this.yaw += dx * p.freeLookSpeed;
    this.pitch = clamp(this.pitch - dy * p.freeLookSpeed, -p.freePitchLimit, p.freePitchLimit);
  }

  /** wheel changes travel speed (there is no orbit radius to zoom here) */
  adjustSpeed(wheelDeltaY: number): void {
    const p = cameraParams;
    this.speedScale = clamp(this.speedScale * Math.exp(-wheelDeltaY * p.freeSpeedWheelStep), 0.02, 50);
  }

  /** current effective travel speed, m/s — HUD/debug readable */
  get speed(): number {
    const p = cameraParams;
    const mul = this.fast ? p.freeFastMul : this.slow ? p.freeSlowMul : 1;
    return p.freeSpeed * this.speedScale * mul;
  }

  private get fast(): boolean {
    return this.held.has('ShiftLeft') || this.held.has('ShiftRight');
  }

  private get slow(): boolean {
    return this.held.has('ControlLeft') || this.held.has('ControlRight');
  }

  /** adopt the live camera pose so entering free mode is a zero-jump cut */
  seedFrom(camera: PerspectiveCamera, worldForward: Vector3): void {
    this.position[0] = camera.position.x;
    this.position[1] = camera.position.y;
    this.position[2] = camera.position.z;
    camera.getWorldDirection(worldForward);
    const [yaw, pitch] = yawPitchFromDirection(worldForward.x, worldForward.y, worldForward.z);
    this.yaw = yaw;
    this.pitch = clamp(pitch, -cameraParams.freePitchLimit, cameraParams.freePitchLimit);
    this.clearKeys();
    this.recordApplied(camera);
  }

  /**
   * If the camera transform changed since WE last wrote it, someone else
   * moved the lens — `camera.position.set(...)` from the console, another
   * system, a test rig. Adopt it rather than overwrite it on the next
   * frame: a free camera that fights an external pose is as useless for
   * §V22 verification as one that drifts. Returns true if it adopted.
   */
  adoptExternal(camera: PerspectiveCamera, worldForward: Vector3): boolean {
    if (!this.hasApplied) return false;
    const a = this.applied;
    const moved =
      Math.abs(camera.position.x - a[0]) > EXTERNAL_EPS ||
      Math.abs(camera.position.y - a[1]) > EXTERNAL_EPS ||
      Math.abs(camera.position.z - a[2]) > EXTERNAL_EPS;
    const turned =
      Math.abs(camera.quaternion.x - a[3]) > EXTERNAL_EPS ||
      Math.abs(camera.quaternion.y - a[4]) > EXTERNAL_EPS ||
      Math.abs(camera.quaternion.z - a[5]) > EXTERNAL_EPS ||
      Math.abs(camera.quaternion.w - a[6]) > EXTERNAL_EPS;
    if (!moved && !turned) return false;
    if (moved) {
      this.position[0] = camera.position.x;
      this.position[1] = camera.position.y;
      this.position[2] = camera.position.z;
      // an external teleport carries no momentum
      this.vel[0] = this.vel[1] = this.vel[2] = 0;
    }
    if (turned) {
      camera.getWorldDirection(worldForward);
      const [yaw, pitch] = yawPitchFromDirection(worldForward.x, worldForward.y, worldForward.z);
      this.yaw = yaw;
      this.pitch = clamp(pitch, -cameraParams.freePitchLimit, cameraParams.freePitchLimit);
    }
    return true;
  }

  private recordApplied(camera: PerspectiveCamera): void {
    const a = this.applied;
    a[0] = camera.position.x;
    a[1] = camera.position.y;
    a[2] = camera.position.z;
    a[3] = camera.quaternion.x;
    a[4] = camera.quaternion.y;
    a[5] = camera.quaternion.z;
    a[6] = camera.quaternion.w;
    this.hasApplied = true;
  }

  update(dt: number): void {
    const p = cameraParams;
    const fwd = sphericalOffset(this.yaw, this.pitch, 1);
    // strafe stays level: right = normalize(cross(forward, up)) with the
    // yaw-0-is-+z convention → (-cos yaw, 0, sin yaw)
    const rx = -Math.cos(this.yaw);
    const rz = Math.sin(this.yaw);

    const f = (this.held.has('KeyW') ? 1 : 0) - (this.held.has('KeyS') ? 1 : 0);
    const r = (this.held.has('KeyD') ? 1 : 0) - (this.held.has('KeyA') ? 1 : 0);
    const u = (this.held.has('KeyR') ? 1 : 0) - (this.held.has('KeyF') ? 1 : 0);

    let tx = fwd[0] * f + rx * r;
    let ty = fwd[1] * f + u;
    let tz = fwd[2] * f + rz * r;
    const len = Math.hypot(tx, ty, tz);
    if (len > 0) {
      const s = this.speed / len; // normalize so diagonals aren't faster
      tx *= s;
      ty *= s;
      tz *= s;
    }
    this.target[0] = tx;
    this.target[1] = ty;
    this.target[2] = tz;

    stepFly(this.vel, this.target, p.freeMoveHalfLife, dt, p.freeStopEps);
    this.position[0] += this.vel[0] * dt;
    this.position[1] = clamp(this.position[1] + this.vel[1] * dt, p.freeMinY, p.freeMaxY);
    this.position[2] += this.vel[2] * dt;
  }

  /** write the pose onto the three camera (no water clamp — dives allowed) */
  applyTo(camera: PerspectiveCamera, lookTmp: Vector3): void {
    const fwd = sphericalOffset(this.yaw, this.pitch, 1);
    camera.position.set(this.position[0], this.position[1], this.position[2]);
    lookTmp.set(
      this.position[0] + fwd[0],
      this.position[1] + fwd[1],
      this.position[2] + fwd[2],
    );
    camera.lookAt(lookTmp);
    this.recordApplied(camera);
  }
}
