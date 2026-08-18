/**
 * Camera system entry (T10). createFollowCam replaces the OrbitControls
 * fallback in main.ts (main-thread integration happens there, not here).
 * Render-side module (§V.3: reads SimState only).
 *
 * Input map owned by this module (§I): C toggles the free/detached camera;
 * while free, W/A/S/D fly along the view axes, R/F rise/descend, Shift =
 * fast, Ctrl = slow, wheel = travel speed. Those fly keys are swallowed
 * before the sailing collector sees them, so the ship holds its course.
 *
 * For visual verification from the console (§V22) — an exact vantage that
 * survives every subsequent frame, in any mode:
 *
 *   __game.followCam.setDebugPose([6, 2.5, -14], [0, 3, 0])  // park + aim
 *   __game.followCam.clearDebugPose()                        // hand it back
 *
 * Free mode also adopts (rather than overwrites) a camera.position set
 * from outside, so `__game.app.camera.position.set(...)` sticks there too.
 */
import type { PerspectiveCamera } from 'three';
import { FollowCam, type CamMode, type HeightFn, type Vec3Like } from './followCam';
import type { ShipState } from '../state/simState';

export type { CamMode, HeightFn, Vec3Like } from './followCam';
export { FollowCam } from './followCam';
export { FreeCam } from './freeCam';

export interface FollowCamHandle {
  update(shipState: ShipState, dt: number, heightFn?: HeightFn): void;
  setMode(mode: CamMode): void;
  getMode(): CamMode;
  /** true while the detached camera owns the lens — sim input is suppressed */
  isFree(): boolean;
  /**
   * Park the lens at an exact world pose and hold it there against every
   * mode and every frame — the vantage for visual verification (§V22).
   * Omit `target` to keep the current aim.
   */
  setDebugPose(position: Vec3Like, target?: Vec3Like): void;
  /** release the vantage without jumping the camera */
  clearDebugPose(): void;
  isDebugPinned(): boolean;
  /** ship-local position of the wheel — where the H key puts the captain */
  setHelmAnchor(local: Vec3Like): void;
  /**
   * CUT the chase to the ship on the next frame instead of damping toward her.
   * For teleports (§T.52) — the exponential chase would otherwise fly the lens
   * the whole way, arriving seconds later.
   */
  snap(): void;
  dispose(): void;
}

export function createFollowCam(
  camera: PerspectiveCamera,
  domElement: HTMLElement,
): FollowCamHandle {
  const cam = new FollowCam(camera, domElement);
  return {
    update: (ship, dt, heightFn) => cam.update(ship, dt, heightFn),
    setMode: (mode) => cam.setMode(mode),
    getMode: () => cam.getMode(),
    isFree: () => cam.isFree(),
    setDebugPose: (position, target) => cam.setDebugPose(position, target),
    clearDebugPose: () => cam.clearDebugPose(),
    isDebugPinned: () => cam.isDebugPinned(),
    setHelmAnchor: (local) => cam.setHelmAnchor(local),
    snap: () => cam.snap(),
    dispose: () => cam.dispose(),
  };
}
