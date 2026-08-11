/**
 * Follow-camera tunables (§V.16): registered so the debug panel auto-binds.
 * Render-side consumers read this live object. Angles radians, lengths m.
 */
import { registerParams } from './registry';

export interface CameraParams {
  /** default orbit radius, m */
  radius: number;
  /** wheel-zoom radius clamp */
  minRadius: number;
  maxRadius: number;
  /** camera pivot height above ship origin, m */
  pivotHeight: number;
  /** camera position smoothing half-life, s (0 = snap) */
  posHalfLife: number;
  /** follow-mode yaw re-centering half-life, s */
  yawFollowHalfLife: number;
  /** orbit pitch limits, rad (positive = looking down from above) */
  pitchMin: number;
  pitchMax: number;
  /** camera never closer than this above the sampled water height, m */
  minHeightAboveWater: number;
  /** look-ahead: seconds of ship velocity added to the look target */
  lookAhead: number;
  /** rad of orbit per pixel of mouse drag */
  orbitSpeed: number;
  /** zoom sensitivity per wheel-delta unit */
  zoomSpeed: number;
}

export const cameraParams: CameraParams = registerParams(
  'camera',
  {
    radius: 28,
    minRadius: 8,
    maxRadius: 90,
    pivotHeight: 6,
    posHalfLife: 0.12,
    yawFollowHalfLife: 1.2,
    pitchMin: -0.15,
    pitchMax: 1.2,
    minHeightAboveWater: 1.5,
    lookAhead: 0.6,
    orbitSpeed: 0.005,
    zoomSpeed: 0.0012,
  },
  {
    radius: { min: 5, max: 120, step: 1 },
    minRadius: { min: 2, max: 40, step: 1 },
    maxRadius: { min: 20, max: 300, step: 5 },
    pivotHeight: { min: 0, max: 30, step: 0.5 },
    posHalfLife: { min: 0, max: 1, step: 0.01 },
    yawFollowHalfLife: { min: 0.05, max: 5, step: 0.05 },
    pitchMin: { min: -1.2, max: 0.5, step: 0.01 },
    pitchMax: { min: 0, max: 1.5, step: 0.01 },
    minHeightAboveWater: { min: 0, max: 10, step: 0.1 },
    lookAhead: { min: 0, max: 3, step: 0.05 },
    orbitSpeed: { min: 0.001, max: 0.02, step: 0.001 },
    zoomSpeed: { min: 0.0002, max: 0.005, step: 0.0002 },
  },
);
