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
  /** free-dive: pitch the camera below the surface (underwater mode T29) */
  allowUnderwater: boolean;
  /** look-ahead: seconds of ship velocity added to the look target */
  lookAhead: number;
  /** rad of orbit per pixel of mouse drag */
  orbitSpeed: number;
  /** zoom sensitivity per wheel-delta unit */
  zoomSpeed: number;

  // --- free/detached camera (C key) — screenshot + inspection rig (§V22) ---
  /** free-fly base speed, m/s (wheel scales it, Shift/Ctrl multiply it) */
  freeSpeed: number;
  /** Shift multiplier — horizon / view-distance runs at km scale */
  freeFastMul: number;
  /** Ctrl multiplier — creeping along the bow or transom */
  freeSlowMul: number;
  /** fly velocity smoothing half-life, s (0 = instant start/stop) */
  freeMoveHalfLife: number;
  /** below this speed the free cam hard-stops, m/s — no idle creep */
  freeStopEps: number;
  /** rad of free-look per pixel of mouse drag */
  freeLookSpeed: number;
  /** free-look pitch clamp, rad (just shy of straight up/down) */
  freePitchLimit: number;
  /** free-cam world height clamp, m — freeMinY is the free-dive floor */
  freeMinY: number;
  freeMaxY: number;
  /** wheel sensitivity on the free-cam speed scale, per wheel-delta unit */
  freeSpeedWheelStep: number;
  /** softer position half-life used right after a mode switch, s */
  modeSwitchHalfLife: number;
  /** how long that softer blend lasts, s */
  modeSwitchTime: number;
  /** vertical field of view, deg */
  fov: number;
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
    allowUnderwater: true,
    lookAhead: 0.6,
    orbitSpeed: 0.005,
    zoomSpeed: 0.0012,
    freeSpeed: 30,
    freeFastMul: 12,
    freeSlowMul: 0.1,
    freeMoveHalfLife: 0.08,
    freeStopEps: 0.02,
    freeLookSpeed: 0.0025,
    freePitchLimit: 1.5533, // 89°
    freeMinY: -300,
    freeMaxY: 2000,
    freeSpeedWheelStep: 0.0015,
    modeSwitchHalfLife: 0.5,
    modeSwitchTime: 1.5,
    fov: 55,
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
    freeSpeed: { min: 1, max: 200, step: 1 },
    freeFastMul: { min: 1, max: 50, step: 1 },
    freeSlowMul: { min: 0.01, max: 1, step: 0.01 },
    freeMoveHalfLife: { min: 0, max: 0.5, step: 0.01 },
    freeStopEps: { min: 0.001, max: 0.2, step: 0.001 },
    freeLookSpeed: { min: 0.0005, max: 0.01, step: 0.0005 },
    freePitchLimit: { min: 0.1, max: 1.5707, step: 0.01 },
    freeMinY: { min: -2000, max: 0, step: 10 },
    freeMaxY: { min: 50, max: 4500, step: 50 },
    freeSpeedWheelStep: { min: 0.0002, max: 0.01, step: 0.0002 },
    modeSwitchHalfLife: { min: 0.05, max: 2, step: 0.05 },
    modeSwitchTime: { min: 0, max: 5, step: 0.1 },
    fov: { min: 20, max: 110, step: 1 },
  },
);
