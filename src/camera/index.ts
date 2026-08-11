/**
 * Camera system entry (T10). createFollowCam replaces the OrbitControls
 * fallback in main.ts (main-thread integration happens there, not here).
 * Render-side module (§V.3: reads SimState only).
 *
 * Input map owned by this module (§I): C toggles the free/detached camera;
 * while free, W/A/S/D fly along the view axes, R/F rise/descend, Shift =
 * fast, Ctrl = slow, wheel = travel speed. Those fly keys are swallowed
 * before the sailing collector sees them, so the ship holds its course.
 */
import type { PerspectiveCamera } from 'three';
import { FollowCam, type CamMode, type HeightFn } from './followCam';
import type { ShipState } from '../state/simState';

export type { CamMode, HeightFn } from './followCam';
export { FollowCam } from './followCam';
export { FreeCam } from './freeCam';

export interface FollowCamHandle {
  update(shipState: ShipState, dt: number, heightFn?: HeightFn): void;
  setMode(mode: CamMode): void;
  getMode(): CamMode;
  /** true while the detached camera owns the lens — sim input is suppressed */
  isFree(): boolean;
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
    dispose: () => cam.dispose(),
  };
}
