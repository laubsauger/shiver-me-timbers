/**
 * Raft-entry world tunables (§T.98, §V.16): the day clock and the weather
 * ceiling. `params/raft.ts` is the blueprint agent's (§V.82 geometry), so the
 * entry's own knobs live here.
 *
 * dayMinutes  real minutes per 24 h of `skyParams.timeOfDay`; 24 → one game
 *             hour per real minute.
 * startHour   time of day the entry boots at (overridable with `?tod=`).
 * clockRunning false freezes the sun where it is (lookdev, §V.88 stations).
 * maxStorminess presets whose `PRESET_STORMINESS` exceeds this are refused
 *             by the raft entry and replaced by the calmest default (§T.98
 *             "storm presets excluded"). 0.12 admits glass…swell.
 */
import { registerParams } from './registry';

export interface RaftWorldParams {
  dayMinutes: number;
  startHour: number;
  clockRunning: boolean;
  maxStorminess: number;
}

export const raftWorldParams: RaftWorldParams = registerParams(
  'raft-world',
  {
    dayMinutes: 24,
    startHour: 7,
    clockRunning: true,
    maxStorminess: 0.12,
  },
  {
    dayMinutes: { min: 1, max: 240, step: 1 },
    startHour: { min: 0, max: 24, step: 0.25 },
    maxStorminess: { min: 0, max: 1, step: 0.01 },
  },
);
