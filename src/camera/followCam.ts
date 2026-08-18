/**
 * FollowCam — chase camera for the player ship (T10) plus the detached
 * free/fly camera used for visual acceptance (§V22). Render-side: MAY use
 * three.js (§V.3 — reads SimState, never writes it). All pure math lives in
 * camMath.ts; all tunables in params/camera.ts (§V.16).
 *
 * Modes (C toggles follow ↔ free):
 *  - follow: orbit angles are stored as an OFFSET from the ship's stern
 *    heading, so a held angle persists forever and only swings with the
 *    ship's turns. It never re-centers to a "default framing" on its own.
 *  - orbit: world-absolute angles, no heading coupling at all.
 *  - free: fully detached fly camera (see freeCam.ts) — holds whatever
 *    pose the user parks it at, may go far below the surface.
 *
 * On top of the modes sits the debug vantage (setDebugPose, debugPose.ts):
 * an exact pose that outranks all of them, for visual verification.
 *
 * Mouse drag = look/orbit, wheel = zoom radius (follow/orbit) or fly speed
 * (free). Mode switches blend position AND look target so neither cut is a
 * jump. Bindings live in camInput.ts.
 */
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import type { ShipState } from '../state/simState';
import { cameraParams } from '../params/camera';
import { FreeCam } from './freeCam';
import { attachCamInput } from './camInput';
import { DebugPose, readVec3, type Vec3Like } from './debugPose';
import {
  clamp,
  dampFactor,
  enforceMinHeight,
  sphericalOffset,
  stepFollowYaw,
  wrapAngle,
} from './camMath';

export type CamMode = 'follow' | 'orbit' | 'free' | 'helm';
export type HeightFn = (x: number, z: number) => number;
export type { Vec3Like } from './debugPose';

export class FollowCam {
  private yaw = 0;
  private pitch = 0.45;
  /** orbit yaw relative to the ship's stern heading — the thing that persists */
  private yawOffset = 0;
  private radius = cameraParams.radius;
  private mode: CamMode = 'follow';
  private dragging = false;
  private smoothed = new Vector3();
  private initialized = false;
  private lookTarget = new Vector3();
  private lookSmoothed = new Vector3();
  private tmp = new Vector3();
  private free = new FreeCam();
  /** seconds left of the softened post-mode-switch blend */
  private blend = 0;
  /** last frame's pivot, so a mode switch can re-anchor on the ship */
  private lastPivot = new Vector3();
  /** debug vantage: pinned pose that outranks all modes (§V22) */
  private pin = new DebugPose();
  /**
   * Helm POV, all SHIP-LOCAL. The anchor is the wheel's own socket, handed in
   * from main.ts rather than hardcoded here, so the eye tracks the model if
   * the sterncastle moves. Free-look angles are their own pair, NOT the orbit
   * yaw/pitch: stepping to the helm and back must not disturb the chase
   * framing the shot was set up with.
   */
  private helmAnchor = new Vector3(0, 6.2, -13);
  private helmYaw = 0;
  private helmPitch = 0;
  private helmQuat = new Quaternion();
  private helmEye = new Vector3();
  private detach: () => void;

  constructor(
    private camera: PerspectiveCamera,
    domElement: HTMLElement,
  ) {
    this.detach = attachCamInput(domElement, {
      isFree: () => this.mode === 'free',
      toggleFree: () => this.setMode(this.mode === 'free' ? 'follow' : 'free'),
      toggleHelm: () => this.setMode(this.mode === 'helm' ? 'follow' : 'helm'),
      setDragging: (d) => {
        this.dragging = d;
      },
      drag: (dx, dy) => {
        if (!this.dragging) return;
        const p = cameraParams;
        if (this.mode === 'free') {
          this.free.look(dx, dy);
          return;
        }
        if (this.mode === 'helm') {
          // free-look about the ship's OWN heading, so the view stays put
          // relative to the deck as she yaws instead of swinging with her
          this.helmYaw = clamp(
            this.helmYaw - dx * p.freeLookSpeed,
            -p.helmYawLimit,
            p.helmYawLimit,
          );
          this.helmPitch = clamp(
            this.helmPitch - dy * p.freeLookSpeed,
            -p.freePitchLimit,
            p.freePitchLimit,
          );
          return;
        }
        this.yaw = wrapAngle(this.yaw - dx * p.orbitSpeed);
        this.pitch = clamp(this.pitch + dy * p.orbitSpeed, p.pitchMin, p.pitchMax);
      },
      wheel: (deltaY) => {
        const p = cameraParams;
        if (this.mode === 'free') {
          this.free.adjustSpeed(deltaY);
          return;
        }
        this.radius = clamp(this.radius * Math.exp(deltaY * p.zoomSpeed), p.minRadius, p.maxRadius);
      },
      flyKey: (code, down) => {
        if (down) this.free.keyDown(code);
        else this.free.keyUp(code);
      },
      blur: () => this.free.clearKeys(),
    });
  }

  getMode(): CamMode {
    return this.mode;
  }

  isFree(): boolean {
    return this.mode === 'free';
  }

  isDebugPinned(): boolean {
    return this.pin.pinned;
  }

  /**
   * Park the lens at an exact world pose and HOLD it there — the vantage
   * outranks every mode, and re-asserts itself on every update(), so a
   * screenshot's forced rAF frames cannot walk it off. This is the §V22
   * verification instrument: "put the camera somewhere specific and look".
   *
   *   __game.followCam.setDebugPose([12, 3, -40], [0, 4, 0])
   *
   * `target` omitted keeps the current aim. Released by clearDebugPose()
   * or by the C key (an explicit "I want to fly" gesture).
   */
  setDebugPose(position: Vec3Like, target?: Vec3Like): void {
    this.pin.set(this.camera, position, target, this.tmp);
  }

  /**
   * CUT, don't chase. The chase position is exponentially damped toward the
   * ship, which is exactly right when she is sailing and exactly wrong when she
   * has been teleported: the camera would fly the whole kilometre at
   * `posHalfLife`, arriving seconds later having flown through the island on
   * the way. Dropping `initialized` makes the next update() seat the lens at
   * its desired pose in one frame; clearing `blend` stops a mode-switch ramp
   * from re-softening it.
   *
   * Deliberately NOT wired into the mode machinery — teleporting is not a mode
   * change, and setMode() already has its own (correct) glide behaviour.
   */
  snap(): void {
    this.initialized = false;
    this.blend = 0;
  }

  /**
   * Ship-LOCAL position of the helm (the wheel's own socket). main.ts resolves
   * it from the assembly at boot so this file never has to know the galleon's
   * dimensions — and so a change to the sterncastle moves the captain's eye
   * with it instead of leaving him standing in mid-air.
   */
  setHelmAnchor(local: Vec3Like): void {
    readVec3(local, this.helmAnchor);
  }

  /** Release the pin. The camera does NOT jump: free mode adopts the
   *  parked pose as its own, follow mode glides back to the chase. */
  clearDebugPose(): void {
    if (!this.pin.pinned) return;
    this.pin.clear();
    if (this.mode === 'free') {
      this.free.seedFrom(this.camera, this.tmp);
    } else {
      this.smoothed.copy(this.camera.position);
      this.lookSmoothed.copy(this.pin.target);
      this.initialized = true;
      this.blend = cameraParams.modeSwitchTime;
    }
  }

  setMode(mode: CamMode): void {
    if (mode === this.mode) return;
    const p = cameraParams;
    // switching modes is an explicit "give me the camera back" gesture
    this.clearDebugPose();
    if (mode === 'helm') {
      // an INSTANT cut, deliberately — "POV the captain in an instant" is the
      // whole point, and easing a 30 m move would read as a swoop, not a cut.
      // Angles reset so H always lands looking dead ahead over the bow.
      this.helmYaw = 0;
      this.helmPitch = 0;
    } else if (this.mode === 'helm') {
      // leaving the helm glides: start the chase from where the eye actually
      // is, or the camera teleports astern on the first frame
      this.smoothed.copy(this.camera.position);
      this.lookSmoothed.copy(this.lastPivot);
      this.initialized = true;
      this.blend = p.modeSwitchTime;
    }
    if (mode === 'free') {
      // adopt the live pose: entering free mode is a cut with zero motion
      this.free.seedFrom(this.camera, this.tmp);
    } else if (this.mode === 'free') {
      // free mode never touched yaw offset / pitch / radius, so leaving it
      // restores the framing you had before the excursion; only the START
      // of the chase moves to the lens, making the return a glide not a cut
      const dist = this.camera.position.distanceTo(this.lastPivot);
      this.smoothed.copy(this.camera.position);
      this.lookSmoothed
        .copy(this.camera.position)
        .addScaledVector(this.camera.getWorldDirection(this.tmp), Math.max(dist, 1));
      this.initialized = true;
      this.blend = p.modeSwitchTime;
    }
    this.mode = mode;
  }

  update(ship: ShipState, dt: number, heightFn?: HeightFn): void {
    const p = cameraParams;
    if (this.camera.fov !== p.fov) {
      this.camera.fov = p.fov;
      this.camera.updateProjectionMatrix();
    }
    const pivotX = ship.position[0];
    const pivotY = ship.position[1] + p.pivotHeight;
    const pivotZ = ship.position[2];
    const q = ship.quaternion;
    // ship forward yaw from quaternion (forward = local +z)
    const fx = 2 * (q[0] * q[2] + q[3] * q[1]);
    const fz = 1 - 2 * (q[0] * q[0] + q[1] * q[1]);
    const behind = Math.atan2(fx, fz) + Math.PI; // camera sits astern
    // cached so a toggle back out of free mode can re-anchor on the ship
    this.lastPivot.set(pivotX, pivotY, pivotZ);

    // the debug vantage outranks every mode and is re-asserted every frame
    if (this.pin.pinned) {
      this.pin.apply(this.camera);
      return;
    }

    if (this.mode === 'free') {
      // lens moved from outside (console, another system)? adopt, don't
      // stomp — fighting an external pose breaks free mode's "holds what
      // you left it at" contract just as surely as drifting does
      this.free.adoptExternal(this.camera, this.tmp);
      this.free.update(dt);
      this.free.applyTo(this.camera, this.tmp);
      return;
    }

    // HELM POV: the eye is rigidly parented to the deck, so it inherits every
    // bit of heel, pitch and heave for free — that IS the shot. No smoothing
    // at all: damping the position here would slide the captain around his own
    // deck, and damping the aim would make the horizon lag the roll.
    if (this.mode === 'helm') {
      this.helmQuat.set(q[0], q[1], q[2], q[3]);
      this.helmEye
        .set(this.helmAnchor.x, this.helmAnchor.y + p.helmEyeHeight, this.helmAnchor.z - p.helmAft)
        .applyQuaternion(this.helmQuat);
      this.helmEye.x += ship.position[0];
      this.helmEye.y += ship.position[1];
      this.helmEye.z += ship.position[2];
      this.camera.position.copy(this.helmEye);
      // aim in the SHIP's frame too, so a look to starboard stays to starboard
      // through a tack rather than being unwound by her turn
      this.tmp.set(
        Math.sin(this.helmYaw) * Math.cos(this.helmPitch),
        Math.sin(this.helmPitch),
        Math.cos(this.helmYaw) * Math.cos(this.helmPitch),
      );
      this.tmp.applyQuaternion(this.helmQuat).add(this.helmEye);
      this.camera.up.set(0, 1, 0).applyQuaternion(this.helmQuat);
      this.camera.lookAt(this.tmp);
      return;
    }
    // every other mode is world-up; helm is the only one that heels the lens
    this.camera.up.set(0, 1, 0);

    // yaw is an OFFSET from the stern heading (see stepFollowYaw): swings
    // with the ship's turns, never crawls back to a default framing
    if (this.mode === 'follow') {
      [this.yaw, this.yawOffset] = stepFollowYaw(
        this.yaw,
        this.yawOffset,
        behind,
        this.dragging,
        p.yawFollowHalfLife,
        dt,
      );
    }

    const off = sphericalOffset(this.yaw, this.pitch, this.radius);
    const desiredX = pivotX + off[0];
    const desiredY = pivotY + off[1];
    const desiredZ = pivotZ + off[2];

    // after a mode switch, chase on a softer half-life so returning from a
    // kilometre out is a glide; RAMP it back to normal rather than switch
    // at the end, or the camera visibly accelerates halfway home
    const blending = this.blend > 0;
    let posHalfLife = p.posHalfLife;
    if (blending) {
      const t = 1 - this.blend / Math.max(p.modeSwitchTime, 1e-6);
      posHalfLife = p.modeSwitchHalfLife + (p.posHalfLife - p.modeSwitchHalfLife) * t;
      this.blend = Math.max(0, this.blend - dt);
    }

    if (!this.initialized) {
      this.smoothed.set(desiredX, desiredY, desiredZ);
      this.initialized = true;
    } else {
      const k = dampFactor(posHalfLife, dt);
      this.smoothed.x += (desiredX - this.smoothed.x) * k;
      this.smoothed.y += (desiredY - this.smoothed.y) * k;
      this.smoothed.z += (desiredZ - this.smoothed.z) * k;
    }
    // clamp only when diving is disabled — the underwater mode (T29) owns
    // the below-surface experience and we need free dives for debugging
    const y = p.allowUnderwater
      ? this.smoothed.y
      : enforceMinHeight(
          this.smoothed.y,
          this.smoothed.x,
          this.smoothed.z,
          p.minHeightAboveWater,
          heightFn,
        );

    this.camera.position.set(this.smoothed.x, y, this.smoothed.z);
    this.lookTarget.set(
      pivotX + ship.velocity[0] * p.lookAhead,
      pivotY,
      pivotZ + ship.velocity[2] * p.lookAhead,
    );
    if (blending) {
      // ease the aim too, else the toggle snaps the view round instantly
      const lk = dampFactor(posHalfLife, dt);
      this.lookSmoothed.lerp(this.lookTarget, lk);
      this.camera.lookAt(this.lookSmoothed);
    } else {
      this.lookSmoothed.copy(this.lookTarget);
      this.camera.lookAt(this.lookTarget);
    }
  }

  dispose(): void {
    this.detach();
  }
}
