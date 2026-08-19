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

  // --- helm POV (H) — captain's eye, rides with the ship (§V22) ---
  /** eye height above the wheel's own socket, m */
  helmEyeHeight: number;
  /**
   * how far AFT of the wheel the eye sits, m. Non-zero on purpose: at 0 the
   * lens is inside the wheel's hub and the near plane slices the spokes, and
   * the shot wants the wheel in frame anyway — it is what says "captain".
   */
  helmAft: number;
  /** free-look yaw clamp either side of dead ahead, rad (0 = locked forward) */
  helmYawLimit: number;

  // --- shipboard camera stations (1..4) — fixed vantages that ride the deck ---
  /**
   * Eye height above a station's own socket, m. One number for bow, stern and
   * masthead: they are all "a person standing at that fitting", and three
   * sliders that are always set to the same value are three chances to have
   * two of them wrong. The gun station is genuinely different (you sit, not
   * stand) and has its own.
   */
  stationEyeHeight: number;
  /**
   * Free-look yaw clamp either side of a station's own bearing, rad. Wider
   * than the helm's on purpose — the helm is a POV with shoulders, a camera
   * station is a tripod, and the stern station in particular is useless if it
   * cannot be swung round to look back down the ship.
   */
  stationYawLimit: number;
  /** gun station: eye height above the gun's MOUNT socket, m (bore ≈ +0.50) */
  gunStationEyeHeight: number;
  /** gun station: how far INBOARD of the mount, along the bore, the eye sits, m */
  gunStationBack: number;
  /** gun station: sit at the PORT battery instead of the starboard one */
  gunStationPort: boolean;

  // --- arriving at a deck station, and at the helm ---
  /**
   * How fast the lens travels into a deck station, m/s. The move's duration is
   * DISTANCE-SCALED rather than constant: a fixed 1.5 s reads as a leisurely
   * swoop over the 4 m from one end of the quarterdeck to the other and as a
   * rocket over 60 m from a wide chase framing. Speed is the invariant a
   * viewer actually reads.
   */
  stationEaseSpeed: number;
  /** floor on that move, s — a very short hop still needs a beat to register */
  stationEaseMin: number;
  /** ceiling on it, s — past this a "move" stops being readable as one */
  stationEaseMax: number;
  /**
   * Beyond this gap the arrival is a CUT, not a move, m. Easing a kilometre
   * (the free camera's range) at any duration is a smear, not a camera move —
   * see the note in followCam.setMode about the decision this replaces.
   */
  stationCutDistance: number;
}

export const cameraParams: CameraParams = registerParams(
  'camera',
  {
    radius: 28,
    // range is for FRAMING SHOTS, not just for play: 2.5 m gets the lens onto
    // a single carved rail or the wheel's spokes, 500 m puts the whole galleon
    // against the horizon and the storm cell behind her. The old 8..90 could
    // do neither, and a showcase camera that cannot get close or far is the
    // one tool the recording actually needs.
    minRadius: 2.5,
    maxRadius: 500,
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
    helmEyeHeight: 1.62,
    helmAft: 0.85,
    helmYawLimit: 2.6, // ~150° — can look over either shoulder, not behind
    stationEyeHeight: 1.62,
    stationYawLimit: Math.PI, // all the way round, either way
    // the bore axis sits 0.50 m over the mount socket, so this puts the eye a
    // handspan above it: astride the barrel, sighting along it
    gunStationEyeHeight: 0.75,
    // the breech is 0.67 m inboard of the mount and the carriage 0.9 m tall —
    // 1.15 clears both and keeps the whole gun in the bottom of frame
    gunStationBack: 1.15,
    gunStationPort: false,
    stationEaseSpeed: 45,
    stationEaseMin: 0.22,
    stationEaseMax: 1.0,
    stationCutDistance: 90,
  },
  {
    radius: { min: 2, max: 500, step: 1 },
    minRadius: { min: 0.5, max: 40, step: 0.5 },
    maxRadius: { min: 20, max: 1500, step: 10 },
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
    helmEyeHeight: { min: 0.5, max: 4, step: 0.01 },
    helmAft: { min: -2, max: 4, step: 0.05 },
    helmYawLimit: { min: 0, max: 3.14, step: 0.01 },
    stationEyeHeight: { min: 0, max: 4, step: 0.01 },
    stationYawLimit: { min: 0, max: 3.1416, step: 0.01 },
    gunStationEyeHeight: { min: -0.5, max: 3, step: 0.01 },
    gunStationBack: { min: -1, max: 5, step: 0.05 },
    stationEaseSpeed: { min: 2, max: 400, step: 1 },
    stationEaseMin: { min: 0, max: 2, step: 0.01 },
    stationEaseMax: { min: 0.05, max: 6, step: 0.05 },
    stationCutDistance: { min: 0, max: 1200, step: 5 },
  },
);
