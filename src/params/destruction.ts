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
}

export const destructionParams: DestructionParams = registerParams(
  'destruction',
  {
    hitDamage: 0.25,
    holedThreshold: 0.5,
    splinterCount: 14,
  },
  {
    hitDamage: { min: 0.05, max: 1, step: 0.05 },
    holedThreshold: { min: 0, max: 1, step: 0.05 },
    splinterCount: { min: 0, max: 64, step: 1 },
  },
);
