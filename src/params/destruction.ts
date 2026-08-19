/**
 * Destruction tunables (§V14, §V16). Consumed by src/ship/destruction.ts;
 * hp lives in SimState.ships[].damage (plain data, §V2) — these only shape
 * how fast zones degrade and what the breach fx spawn.
 */
import { registerParams } from './registry';

export interface DestructionParams {
  /** hp removed per cannonball hit (zone hp is 0..1) */
  hitDamage: number;
  /** hp at/below which an intact piece swaps to its holed variant */
  holedThreshold: number;
  /** splinter particles per breach burst (fx consumes later) */
  splinterCount: number;
  /**
   * §T.63 — torn opening radius as a multiple of the BALL'S DIAMETER
   * (`combatFxParams.ballDrawRadius` × 2). The hole is sized by the shot, not
   * by the piece it lands on: the disc this replaces was
   * `min(sy, sz) · 0.3` = 1.794 m radius on every hull section of the shipped
   * galleon, i.e. 3.588 m across on a 35 m ship, whatever hit it.
   */
  breachRadiusPerCalibre: number;
  /** m — how far the torn rim is carried inboard so the hole shows plank
   *  thickness instead of reading as a cut in paper */
  breachCollarDepth: number;
  /** splintered fringe outer radius, × the opening radius */
  breachFringeScale: number;
  /** dark backing radius, × the opening radius — wide enough that the cavity
   *  still reads at an oblique angle */
  breachBackingScale: number;
  /** m — how far the dark backing sits INBOARD of the planking. Flush is the
   *  old defect: it fills the aperture and the hole stops being a hole. */
  breachBackingRecess: number;
  /** how many breaches one piece draws before further hits stop cutting */
  breachesPerPiece: number;
}

export const destructionParams: DestructionParams = registerParams(
  'destruction',
  {
    hitDamage: 0.25,
    holedThreshold: 0.5,
    splinterCount: 14,
    breachRadiusPerCalibre: 1.25,
    breachCollarDepth: 0.28,
    breachFringeScale: 1.8,
    breachBackingScale: 1.7,
    breachBackingRecess: 0.55,
    breachesPerPiece: 5,
  },
  {
    hitDamage: { min: 0.05, max: 1, step: 0.05 },
    holedThreshold: { min: 0, max: 1, step: 0.05 },
    splinterCount: { min: 0, max: 64, step: 1 },
    breachRadiusPerCalibre: { min: 0.4, max: 6, step: 0.05 },
    breachCollarDepth: { min: 0, max: 1, step: 0.01 },
    breachFringeScale: { min: 1.05, max: 4, step: 0.05 },
    breachBackingScale: { min: 1.05, max: 4, step: 0.05 },
    breachBackingRecess: { min: 0.05, max: 2, step: 0.05 },
    breachesPerPiece: { min: 1, max: 12, step: 1 },
  },
);
