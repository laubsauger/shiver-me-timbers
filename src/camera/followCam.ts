/**
 * FollowCam — chase camera for the player ship (T10). Render-side: MAY use
 * three.js (§V.3 — reads SimState, never writes it). All pure math lives in
 * camMath.ts; all tunables in params/camera.ts (§V.16).
 *
 * follow mode: orbit angles drift back behind the ship's heading when the
 * user is not dragging; orbit mode: angles stay wherever the user put them.
 * Mouse drag = yaw/pitch within limits, wheel = zoom radius clamp. The
 * camera position is exp-damped and never dips below the ocean surface
 * (height sampler injected per-update; defaults to the y=0 plane).
 */
import { PerspectiveCamera, Vector3 } from 'three';
import type { ShipState } from '../state/simState';
import { cameraParams } from '../params/camera';
import {
  clamp,
  dampAngle,
  dampFactor,
  enforceMinHeight,
  sphericalOffset,
  wrapAngle,
} from './camMath';

export type CamMode = 'follow' | 'orbit';
export type HeightFn = (x: number, z: number) => number;

export class FollowCam {
  private yaw = 0;
  private pitch = 0.45;
  private radius = cameraParams.radius;
  private mode: CamMode = 'follow';
  private dragging = false;
  private smoothed = new Vector3();
  private initialized = false;
  private lookTarget = new Vector3();
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
      this.yaw = wrapAngle(this.yaw - e.movementX * p.orbitSpeed);
      this.pitch = clamp(this.pitch + e.movementY * p.orbitSpeed, p.pitchMin, p.pitchMax);
    };
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const p = cameraParams;
      this.radius = clamp(
        this.radius * Math.exp(e.deltaY * p.zoomSpeed),
        p.minRadius,
        p.maxRadius,
      );
    };
    domElement.addEventListener('pointerdown', onPointerDown);
    domElement.addEventListener('pointerup', onPointerUp);
    domElement.addEventListener('pointermove', onPointerMove);
    domElement.addEventListener('wheel', onWheel, { passive: false });
    this.detach = () => {
      domElement.removeEventListener('pointerdown', onPointerDown);
      domElement.removeEventListener('pointerup', onPointerUp);
      domElement.removeEventListener('pointermove', onPointerMove);
      domElement.removeEventListener('wheel', onWheel);
    };
  }

  setMode(mode: CamMode): void {
    this.mode = mode;
  }

  update(ship: ShipState, dt: number, heightFn?: HeightFn): void {
    const p = cameraParams;
    const pivotX = ship.position[0];
    const pivotY = ship.position[1] + p.pivotHeight;
    const pivotZ = ship.position[2];

    // follow mode: settle behind the ship's heading unless the user drags
    if (this.mode === 'follow' && !this.dragging) {
      const q = ship.quaternion;
      // ship forward yaw from quaternion (forward = local +z)
      const fx = 2 * (q[0] * q[2] + q[3] * q[1]);
      const fz = 1 - 2 * (q[0] * q[0] + q[1] * q[1]);
      const behind = Math.atan2(fx, fz) + Math.PI; // camera sits astern
      this.yaw = dampAngle(this.yaw, behind, p.yawFollowHalfLife, dt);
    }

    const off = sphericalOffset(this.yaw, this.pitch, this.radius);
    const desiredX = pivotX + off[0];
    const desiredY = pivotY + off[1];
    const desiredZ = pivotZ + off[2];

    if (!this.initialized) {
      this.smoothed.set(desiredX, desiredY, desiredZ);
      this.initialized = true;
    } else {
      const k = dampFactor(p.posHalfLife, dt);
      this.smoothed.x += (desiredX - this.smoothed.x) * k;
      this.smoothed.y += (desiredY - this.smoothed.y) * k;
      this.smoothed.z += (desiredZ - this.smoothed.z) * k;
    }
    const y = enforceMinHeight(
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
    this.camera.lookAt(this.lookTarget);
  }

  dispose(): void {
    this.detach();
  }
}
