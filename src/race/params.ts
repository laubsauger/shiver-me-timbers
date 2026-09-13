/**
 * Race logic tunables (§T.184). Numbers from design doc §2/§3 where it gives them; the rest
 * are marked *tuning* (playtest starting points).
 */
import type { ProgressParams } from './progress';
import type { RespawnParams } from './respawn';
import type { RollingStartParams } from './rollingStart';
import type { SurgeParams } from './surge';

const KN = 0.514444;

export interface RaceParams {
  start: RollingStartParams;
  progress: ProgressParams;
  surge: SurgeParams;
  respawn: RespawnParams;
  /** outer end of a turn mark's rounding ray, m (*tuning*) */
  markCaptureRange: number;
  /** a crash stops counting as the respawn origin after this long uncrashed, s (*tuning*) */
  crashRecoverSeconds: number;
  /** progress this far past the next element without passing it ⟹ missed, m (*tuning*) */
  missDistance: number;
  /** elements beyond the next one whose crossing also proves the next was missed */
  missLookahead: number;
  /** design doc §3: missed gate +5 s */
  missPenaltySeconds: number;
  /** crossing the start line before green (*tuning*) */
  jumpStartPenaltySeconds: number;
  /** gap-to-leader checkpoint spacing along the line, m */
  checkpointSpacing: number;
  /** unfinished racers are DNF this long after the winner finishes, s (*tuning*) */
  dnfAfterWinnerSeconds: number;
}

export const raceParams: RaceParams = {
  start: {
    prestartSeconds: 3,
    paceSpeed: 40 * KN,
    speedCapFactor: 1.15,
    pullOffDistance: 150,
    lampCount: 5,
    lampInterval: 1,
    gridColumns: 2,
    columnSpacing: 14,
    rowSpacing: 30,
    firstRowGap: 45,
  },
  progress: {
    windowBack: 30,
    windowAhead: 150,
    hysteresis: 8,
    continuity: 0.05,
    backContinuity: 0.5,
    reacquireDistance: 80,
    wrongWayDistance: 30,
  },
  surge: {
    maxSegments: 3,
    cleanLandingAmount: 1 / 3,
    wakeJumpAmount: 1 / 3,
    cleanSectorAmount: 1 / 3,
    minAirSeconds: 0.6,
    cleanPitchMin: -2,
    cleanPitchMax: 7,
    cleanRollMax: 10,
    cleanSlamMax: 3,
    hardSlam: 6,
    landingWindowSeconds: 0.1,
    boostSeconds: 3,
    thrustMultiplier: (90 / 80) ** 2,
  },
  respawn: {
    backDistance: 60,
    searchStep: 10,
    maxBackDistance: 240,
    clearance: 40,
    minSpeed: 25 * KN,
    speedFraction: 0.5,
    ghostSeconds: 2,
  },
  markCaptureRange: 150,
  crashRecoverSeconds: 3,
  missDistance: 50,
  missLookahead: 2,
  missPenaltySeconds: 5,
  jumpStartPenaltySeconds: 5,
  checkpointSpacing: 10,
  dnfAfterWinnerSeconds: 90,
};
