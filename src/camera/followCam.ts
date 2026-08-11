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
 * Mouse drag = look/orbit, wheel = zoom radius (follow/orbit) or fly speed
 * (free). Mode switches blend position AND look target so neither cut is a
 * jump. Free-mode fly keys are swallowed in the capture phase so W/A/S/D
 * don't also steer the ship — see the note on the key listener.
 */
import { PerspectiveCamera, Vector3 } from 'three';
import type { ShipState } from '../state/simState';
import { cameraParams } from '../params/camera';
import { FreeCam } from './freeCam';
import {
  clamp,
  dampFactor,
  enforceMinHeight,
  sphericalOffset,
  stepFollowYaw,
  wrapAngle,
} from './camMath';

export type CamMode = 'follow' | 'orbit' | 'free';
export type HeightFn = (x: number, z: number) => number;

/** C = toggle free camera (§I input map; W/A/S/D/R/F fly while free) */
const TOGGLE_FREE_CODE = 'KeyC';

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
  private detach: () => void;

  constructor(
    private camera: PerspectiveCamera,
    domElement: HTMLElement,
  ) {
    const onPointerDown = (e: PointerEvent): void => {
      this.dragging = true;
      domElement.setPointerCapture?.(e.pointerId);
    };
    const onPointerUp = (): void => {
      this.dragging = false;
    };
    const onPointerMove = (e: PointerEvent): void => {
      if (!this.dragging) return;
      const p = cameraParams;
      if (this.mode === 'free') {
        this.free.look(e.movementX, e.movementY);
        return;
      }
      this.yaw = wrapAngle(this.yaw - e.movementX * p.orbitSpeed);
      this.pitch = clamp(this.pitch + e.movementY * p.orbitSpeed, p.pitchMin, p.pitchMax);
    };
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const p = cameraParams;
      if (this.mode === 'free') {
        this.free.adjustSpeed(e.deltaY);
        return;
      }
      this.radius = clamp(
        this.radius * Math.exp(e.deltaY * p.zoomSpeed),
        p.minRadius,
        p.maxRadius,
      );
    };
    // Capture phase on window: fly keys must not ALSO reach the sailing
    // input collector (window, bubble phase) or W/A/S/D would steer the
    // ship while the user is flying the camera. keyup is never swallowed —
    // a key held across a mode switch must still release on the sim side.
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.metaKey || e.altKey) return;
      // never steal keys from a focused field — the Tweakpane panel (Tab)
      // is full of numeric inputs and C is a perfectly good character
      const t = e.target as { tagName?: string; isContentEditable?: boolean } | null;
      if (t?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName ?? '')) return;
      if (e.code === TOGGLE_FREE_CODE && !e.repeat) {
        this.setMode(this.mode === 'free' ? 'follow' : 'free');
        return;
      }
      if (this.mode !== 'free') return;
      this.free.keyDown(e.code);
      if (FreeCam.consumes(e.code)) e.stopPropagation();
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      this.free.keyUp(e.code);
    };
    const onBlur = (): void => this.free.clearKeys();

    const bindings: [EventTarget, string, EventListener, AddEventListenerOptions?][] = [
      [domElement, 'pointerdown', onPointerDown as EventListener],
      [domElement, 'pointerup', onPointerUp as EventListener],
      [domElement, 'pointermove', onPointerMove as EventListener],
      [domElement, 'wheel', onWheel as EventListener, { passive: false }],
      [window, 'keydown', onKeyDown as EventListener, { capture: true }],
      [window, 'keyup', onKeyUp as EventListener, { capture: true }],
      [window, 'blur', onBlur as EventListener],
    ];
    for (const [t, type, fn, opts] of bindings) t.addEventListener(type, fn, opts);
    this.detach = () => {
      for (const [t, type, fn, opts] of bindings) t.removeEventListener(type, fn, opts);
    };
  }

  getMode(): CamMode {
    return this.mode;
  }

  isFree(): boolean {
    return this.mode === 'free';
  }

  setMode(mode: CamMode): void {
    if (mode === this.mode) return;
    const p = cameraParams;
    if (mode === 'free') {
      // adopt the live pose: entering free mode is a cut with zero motion
      this.free.seedFrom(this.camera, this.tmp);
    } else if (this.mode === 'free') {
      // Leaving free mode restores the orbit framing the user had BEFORE
      // the excursion (yaw offset, pitch, radius are untouched by free
      // mode) — you get your gameplay camera back exactly as you left it.
      // Only the start of the chase is moved to the current lens position
      // so the return is a glide on modeSwitchHalfLife, never a cut.
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

    if (this.mode === 'free') {
      this.free.update(dt);
      this.free.applyTo(this.camera, this.tmp);
      return;
    }

    // follow mode holds the user's angle AS AN OFFSET from the stern
    // heading: the camera swings with the ship's turns but never crawls
    // back to a default framing the user deliberately left.
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

    // Right after a mode switch the position/look chase on a softer
    // half-life, so returning from a kilometre out is a glide and not a
    // snap. The half-life is RAMPED back to the normal one over the blend
    // rather than switched at the end — a hard handover reads as the
    // camera suddenly accelerating halfway home.
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
