/**
 * First-person player tunables (§T.94, §V16: every tunable lives here and
 * appears in Tweakpane). Consumed by src/player/*. All lengths metres, speeds
 * m/s, angles degrees at the panel and converted once where they are read.
 *
 * Every value below is read LIVE on each tick through the `playerParams`
 * object — nothing is captured into a closure at construction (§V62).
 */
import { registerParams } from './registry';

export interface PlayerParams {
  /** capsule radius — how close the eye can get to a bulwark */
  capsuleRadius: number;
  /** capsule height standing / crouched; eye sits `eyeDrop` below the top */
  standHeight: number;
  crouchHeight: number;
  eyeDrop: number;
  /** deck-relative walking speed (§V85: measured against the deck, not the sea) */
  walkSpeed: number;
  crouchSpeed: number;
  swimSpeed: number;
  /** tallest rise a single stride climbs without it being a wall */
  stepUp: number;
  /** steepest rising slope that is walkable; beyond it the move is refused */
  maxSlopeDeg: number;
  /** how far ahead of the foot the slope is sampled */
  slopeProbe: number;
  /** stand back up only once head clearance exceeds standHeight by this much */
  crouchHysteresis: number;
  /** a hop, not a leap: a deck is not a parkour course */
  jumpSpeed: number;
  /** gravity in the SHIP frame; the deck's own acceleration is ignored */
  gravity: number;
  /** swimming: the eye rides this far above the water, and follows it at this rate */
  swimEyeAbove: number;
  swimBobRate: number;
  /** climb back aboard within this reach (horizontal) and height of a boarding point */
  boardReach: number;
  boardVertical: number;
  /** mouse: radians of yaw per pixel of pointer-lock movement */
  lookSensitivity: number;
  /** pitch limit, degrees — straight up/down would gimbal the camera */
  pitchLimitDeg: number;
  /** §T.95 stations: how far a hand reaches, and how far off the look axis a station still counts */
  reach: number;
  focusConeDeg: number;
  /** while holding a station the head may turn this far either side of its facing */
  holdYawLimitDeg: number;
  /** hold-turn / hold-slide: channel units per radian of mouse travel */
  turnSensitivity: number;
  slideSensitivity: number;
  /** step-off: how far outboard of the gangway socket the foot lands */
  stepOffDistance: number;
  /** placeholder hands: pose blend time (s) and radians of wrist per channel unit */
  handPoseTime: number;
  handTurnGain: number;
  /** dev-layer hotkeys: channel change per keydown */
  debugStep: number;
}

export const playerParams: PlayerParams = registerParams<PlayerParams>(
  'player',
  {
    capsuleRadius: 0.3,
    standHeight: 1.7,
    crouchHeight: 1.1,
    eyeDrop: 0.1,
    walkSpeed: 1.6,
    crouchSpeed: 0.9,
    swimSpeed: 1.0,
    stepUp: 0.4,
    maxSlopeDeg: 40,
    slopeProbe: 0.15,
    crouchHysteresis: 0.05,
    jumpSpeed: 1.2,
    gravity: 9.81,
    swimEyeAbove: 0.25,
    swimBobRate: 6,
    boardReach: 0.8,
    boardVertical: 1.5,
    lookSensitivity: 0.0022,
    pitchLimitDeg: 89,
    reach: 1.6,
    focusConeDeg: 35,
    holdYawLimitDeg: 60,
    turnSensitivity: 1.2,
    slideSensitivity: 1.5,
    stepOffDistance: 0.6,
    handPoseTime: 0.15,
    handTurnGain: 1.0,
    debugStep: 0.05,
  },
  {
    capsuleRadius: { min: 0.1, max: 0.6, step: 0.01 },
    standHeight: { min: 1.2, max: 2.2, step: 0.01 },
    crouchHeight: { min: 0.6, max: 1.6, step: 0.01 },
    eyeDrop: { min: 0, max: 0.3, step: 0.01 },
    walkSpeed: { min: 0.2, max: 6, step: 0.05 },
    crouchSpeed: { min: 0.1, max: 3, step: 0.05 },
    swimSpeed: { min: 0.1, max: 3, step: 0.05 },
    stepUp: { min: 0.05, max: 1, step: 0.01 },
    maxSlopeDeg: { min: 10, max: 70, step: 1 },
    slopeProbe: { min: 0.05, max: 0.5, step: 0.01 },
    crouchHysteresis: { min: 0, max: 0.3, step: 0.01 },
    jumpSpeed: { min: 0, max: 5, step: 0.1 },
    gravity: { min: 0, max: 20, step: 0.1 },
    swimEyeAbove: { min: 0, max: 1, step: 0.01 },
    swimBobRate: { min: 0.5, max: 20, step: 0.5 },
    boardReach: { min: 0.2, max: 3, step: 0.05 },
    boardVertical: { min: 0.2, max: 4, step: 0.05 },
    lookSensitivity: { min: 0.0002, max: 0.01, step: 0.0001 },
    pitchLimitDeg: { min: 45, max: 89.9, step: 0.1 },
    reach: { min: 0.5, max: 4, step: 0.05 },
    focusConeDeg: { min: 5, max: 90, step: 1 },
    holdYawLimitDeg: { min: 10, max: 180, step: 1 },
    turnSensitivity: { min: 0.1, max: 10, step: 0.1 },
    slideSensitivity: { min: 0.1, max: 10, step: 0.1 },
    stepOffDistance: { min: 0.1, max: 2, step: 0.05 },
    handPoseTime: { min: 0.02, max: 1, step: 0.01 },
    handTurnGain: { min: 0, max: 5, step: 0.05 },
    debugStep: { min: 0.01, max: 0.5, step: 0.01 },
  },
);
