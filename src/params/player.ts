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
  /**
   * §T.135 — HOW HIGH THE FEET LEAVE THE DECK, in metres of APEX, not a launch
   * speed. The knob a designer means is the height; the speed that produces it
   * is √(2·g·h), derived in `playerStep` so the two can never disagree when
   * `gravity` moves (the old `jumpSpeed: 1.2` was a 7 cm hop — §T.135's whole
   * complaint was that Space read as unbound).
   */
  jumpHeight: number;
  /** gravity in the SHIP frame; the deck's own acceleration is ignored */
  gravity: number;
  /** swimming: the eye rides this far above the water, and follows it at this rate */
  swimEyeAbove: number;
  swimBobRate: number;
  /**
   * Climb back aboard within this reach (horizontal) of a boarding point whose
   * FREEBOARD — its height above the sea surface, §V85/§B78 — is at most
   * `boardVertical`. Measured from the sea and not from the swimmer's feet:
   * the feet hang a body-length under the surface, so a feet-relative test
   * refused every rail on a raft with 0.4 m of freeboard.
   */
  boardReach: number;
  boardVertical: number;
  /**
   * §T.135 THE HAUL-OUT — the same climb, asked for on purpose. Pressing the
   * jump key in the water is a LUNGE: the swimmer kicks, gets both forearms
   * over the rail and hauls, so it reaches further out and further up than the
   * passive drift-aboard above. The passive one stays exactly as it was — a
   * player who never learns the key must still get back on the raft (§B78) —
   * so these two are strictly the more generous pair, never a replacement.
   */
  boardLungeReach: number;
  boardLungeVertical: number;
  /**
   * …and how far INBOARD the lunge lands. A drift-aboard puts the feet on the
   * rail itself; a man who throws himself over one ends up on the deck behind
   * it. Used only when the deck that far in is real, level within `stepUp` and
   * not a wall — otherwise the feet go on the rail like the passive route.
   */
  boardStepIn: number;
  /** mouse: radians of yaw per pixel of pointer-lock movement */
  lookSensitivity: number;
  /** pitch limit, degrees — straight up/down would gimbal the camera */
  pitchLimitDeg: number;
  /** §T.95 stations: how far a hand reaches, and how far off the look axis a station still counts */
  reach: number;
  focusConeDeg: number;
  /**
   * §T.136d — a station looked at from between `reach` and this says SO ("step
   * closer") instead of staying silent, which is indistinguishable from "this
   * is not a thing you can touch". Past it there is no prompt at all: a
   * nameplate on everything you glance at across the raft is noise.
   */
  reachHint: number;
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
  /** §T.100 ashore: ground this far under the sea surface is swimming, not wading */
  swimDepth: number;
  /** §T.100 ashore: terrain steeper than this (degrees) is a wall in any direction */
  terrainSlopeDeg: number;
  /** §T.100 ashore: walking-speed multiplier at terrainSlopeDeg (1 = no slowdown on slopes) */
  slopeSlowdown: number;
  /** §T.100 ashore: climb back aboard from the ground within this reach / height of a deck edge (§V85) */
  ashoreReach: number;
  ashoreVertical: number;
  /** §T.116 prompt: seconds the plaque takes to fade in, and again to fade out */
  promptFade: number;
  /** §T.116 prompt: how far ABOVE the socket the plaque floats, screen px */
  promptRisePx: number;
  /**
   * §T.116 cue: two dots projecting closer than this are ONE dot — the port
   * and starboard sheets are 0.5 m apart and would otherwise land on top of
   * each other. The far one is dropped (the near one is the one E takes).
   */
  cueMergePx: number;
  /** §T.116 cue: the most dots drawn at once, nearest first */
  cueMaxDots: number;
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
    jumpHeight: 0.5,
    gravity: 9.81,
    swimEyeAbove: 0.25,
    swimBobRate: 6,
    boardReach: 0.8,
    boardVertical: 1.5,
    boardLungeReach: 1.4,
    boardLungeVertical: 2.2,
    boardStepIn: 0.5,
    lookSensitivity: 0.0022,
    pitchLimitDeg: 89,
    reach: 1.6,
    focusConeDeg: 35,
    reachHint: 3.0,
    holdYawLimitDeg: 60,
    turnSensitivity: 1.2,
    slideSensitivity: 1.5,
    stepOffDistance: 0.6,
    handPoseTime: 0.15,
    handTurnGain: 1.0,
    debugStep: 0.05,
    swimDepth: 0.3,
    terrainSlopeDeg: 35,
    slopeSlowdown: 0.5,
    ashoreReach: 1.0,
    ashoreVertical: 0.6,
    promptFade: 0.15,
    promptRisePx: 22,
    cueMergePx: 26,
    cueMaxDots: 4,
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
    jumpHeight: { min: 0, max: 1.5, step: 0.05 },
    gravity: { min: 0, max: 20, step: 0.1 },
    swimEyeAbove: { min: 0, max: 1, step: 0.01 },
    swimBobRate: { min: 0.5, max: 20, step: 0.5 },
    boardReach: { min: 0.2, max: 3, step: 0.05 },
    boardVertical: { min: 0.2, max: 4, step: 0.05 },
    boardLungeReach: { min: 0.2, max: 4, step: 0.05 },
    boardLungeVertical: { min: 0.2, max: 5, step: 0.05 },
    boardStepIn: { min: 0, max: 1.5, step: 0.05 },
    lookSensitivity: { min: 0.0002, max: 0.01, step: 0.0001 },
    pitchLimitDeg: { min: 45, max: 89.9, step: 0.1 },
    reach: { min: 0.5, max: 4, step: 0.05 },
    focusConeDeg: { min: 5, max: 90, step: 1 },
    reachHint: { min: 0.5, max: 8, step: 0.1 },
    holdYawLimitDeg: { min: 10, max: 180, step: 1 },
    turnSensitivity: { min: 0.1, max: 10, step: 0.1 },
    slideSensitivity: { min: 0.1, max: 10, step: 0.1 },
    stepOffDistance: { min: 0.1, max: 2, step: 0.05 },
    handPoseTime: { min: 0.02, max: 1, step: 0.01 },
    handTurnGain: { min: 0, max: 5, step: 0.05 },
    debugStep: { min: 0.01, max: 0.5, step: 0.01 },
    swimDepth: { min: 0.05, max: 1.5, step: 0.05 },
    terrainSlopeDeg: { min: 10, max: 70, step: 1 },
    slopeSlowdown: { min: 0.1, max: 1, step: 0.05 },
    ashoreReach: { min: 0.2, max: 3, step: 0.05 },
    ashoreVertical: { min: 0.1, max: 2, step: 0.05 },
    promptFade: { min: 0, max: 1, step: 0.01 },
    promptRisePx: { min: 0, max: 120, step: 1 },
    cueMergePx: { min: 0, max: 120, step: 1 },
    cueMaxDots: { min: 1, max: 12, step: 1 },
  },
);
