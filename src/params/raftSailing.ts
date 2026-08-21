/**
 * Raft sailing tunables (§T.96, §V.16) — TWO tuning sets, ONE step function.
 *
 * `trueRaftTuning` is the Kon-Tiki as Heyerdahl sailed her: a square sail
 * that will not draw above ~100° off the eye of the wind, 1.5–2 m/s in a
 * 6–8 m/s trade, heavy leeway on nine balsa logs, and a steering oar whose
 * sweep the ropes hold to a few degrees. `accessibleRaftTuning` is the same
 * raft a player can steer without a week at sea: drive to ~70° TWA, ×1.6
 * speed, less leeway, a stronger oar. Both are DATA — `stepRaftSailing`
 * reads whichever it is handed and nothing else forks on the mode.
 *
 * Spec names `params/raft.ts` for these; that file is owned by the raft
 * BLUEPRINT agent (§V.82 geometry), so the sailing sets live here instead.
 *
 * Angles radians, speeds m/s, lengths metres, moments in rad/s² per unit
 * (the raft's yaw inertia is folded into the gains — one hull, one mass).
 */
import { registerParams } from './registry';

export interface RaftTuning {
  /** smallest true-wind angle (off the eye, rad) at which the sail draws */
  minTwa: number;
  /** C1 on-ramp width above `minTwa`, rad (drive goes 0→full across it) */
  twaRamp: number;
  /** m/s² of forward drive per (m/s)² of apparent wind at full sheet, dead run */
  thrust: number;
  /** m/s² of downwind push per (m/s)² of apparent wind — cabin/mast windage, sails up or down */
  windage: number;
  /** quadratic hull drag along the logs, 1/m */
  dragCoef: number;
  /** linear drag, 1/s — kills the last crawl a quadratic law never reaches */
  linearDrag: number;
  /** m/s² of sideways push per (m/s)² of apparent wind at full sheet, beam-on */
  sideForce: number;
  /** lateral grip of the bare logs, 1/s */
  hullGrip: number;
  /** lateral grip added per unit of total guara depth (Σ depth, 0..5), 1/s */
  boardGrip: number;
  /** yaw acceleration per (m · m/s · m/s) of guara lift × arm */
  guaraYawGain: number;
  /** longitudinal position of the sail's centre of effort, m fwd of centre */
  sailCE: number;
  /** yaw acceleration per unit oar angle per (m/s)² */
  oarGain: number;
  /** rope limit on the oar: |oarAngle| is clamped to this (0..1) */
  oarMax: number;
  /** (m/s)² added to v² so the oar still bites at a crawl (sculling) */
  oarMinSpeedSq: number;
  /** yaw damping, 1/s */
  yawDamp: number;
}

const TRUE_META = {
  minTwa: { min: 0, max: Math.PI, step: 0.01 },
  twaRamp: { min: 0.05, max: 1.5, step: 0.01 },
  thrust: { min: 0, max: 0.05, step: 0.0005 },
  windage: { min: 0, max: 0.001, step: 0.00001 },
  dragCoef: { min: 0.001, max: 0.2, step: 0.001 },
  linearDrag: { min: 0, max: 0.5, step: 0.005 },
  sideForce: { min: 0, max: 0.05, step: 0.0005 },
  hullGrip: { min: 0, max: 3, step: 0.01 },
  boardGrip: { min: 0, max: 2, step: 0.01 },
  guaraYawGain: { min: 0, max: 0.2, step: 0.001 },
  sailCE: { min: -5, max: 5, step: 0.1 },
  oarGain: { min: 0, max: 0.2, step: 0.001 },
  oarMax: { min: 0, max: 1, step: 0.01 },
  oarMinSpeedSq: { min: 0, max: 4, step: 0.05 },
  yawDamp: { min: 0, max: 3, step: 0.01 },
} as const;

/**
 * Steady dead-run speed at wind W is the root of thrust·(W−v)² = drag·v²,
 * i.e. v = W / (1 + √(drag/thrust)). 0.006/0.05 → v = W/3.89 = 1.80 m/s at
 * 7 m/s, inside Heyerdahl's 1.5–2 m/s. Windage alone gives √(5e-5/0.05) =
 * 0.032 → 0.21 m/s of drift with the sail down.
 */
export const trueRaftTuning: RaftTuning = registerParams(
  'raft-sailing-true',
  {
    minTwa: (100 * Math.PI) / 180,
    twaRamp: 0.3,
    thrust: 0.006,
    windage: 0.00005,
    dragCoef: 0.05,
    linearDrag: 0.02,
    sideForce: 0.004,
    hullGrip: 0.15,
    boardGrip: 0.25,
    guaraYawGain: 0.02,
    sailCE: 1.5, // EST — mast slightly forward of midships (kon-tiki-reference §4)
    oarGain: 0.02,
    oarMax: 0.5,
    oarMinSpeedSq: 0.5,
    yawDamp: 0.6,
  },
  TRUE_META,
);

/** ×1.6 the true speed: 0.05·2.88² = (7−2.88)²·thrust → thrust 0.0244 */
export const accessibleRaftTuning: RaftTuning = registerParams(
  'raft-sailing-accessible',
  {
    minTwa: (70 * Math.PI) / 180,
    twaRamp: 0.3,
    thrust: 0.0244,
    windage: 0.00005,
    dragCoef: 0.05,
    linearDrag: 0.02,
    sideForce: 0.004,
    hullGrip: 0.3,
    boardGrip: 0.5,
    guaraYawGain: 0.02,
    sailCE: 1.5,
    oarGain: 0.06,
    oarMax: 0.8,
    oarMinSpeedSq: 1.0,
    yawDamp: 0.6,
  },
  TRUE_META,
);

/** which set the raft entry sails on; `accessible` is the shipped default */
export const raftSailingMode = registerParams('raft-sailing', { accessible: true });

export function activeRaftTuning(): RaftTuning {
  return raftSailingMode.accessible ? accessibleRaftTuning : trueRaftTuning;
}

/**
 * Guara slots, m fwd of centre (+ = bow). Kon-Tiki: "~2 at bow, ~2 at stern,
 * 1 midships" (kon-tiki-reference §2) on a ~13.7 m centre log. EST.
 */
export const RAFT_GUARA_POS: readonly number[] = [5, 3.5, 0, -3.5, -5];
