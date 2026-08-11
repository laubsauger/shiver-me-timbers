/**
 * Camera system entry (T10). createFollowCam replaces the OrbitControls
 * fallback in main.ts (main-thread integration happens there, not here).
 * Render-side module (§V.3: reads SimState only).
 */
import type { PerspectiveCamera } from 'three';
import { FollowCam, type CamMode, type HeightFn } from './followCam';
import type { ShipState } from '../state/simState';

export type { CamMode, HeightFn } from './followCam';
export { FollowCam } from './followCam';

export interface FollowCamHandle {
  update(shipState: ShipState, dt: number, heightFn?: HeightFn): void;
  setMode(mode: CamMode): void;
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
    dispose: () => cam.dispose(),
  };
}
