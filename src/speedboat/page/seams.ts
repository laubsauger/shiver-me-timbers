/**
 * INTEGRATION SEAMS of the speedboat page (§T.181 S0). Every later task plugs in HERE and the
 * page boot (`src/main-speedboat.ts`) does not change shape when it does:
 *
 *   BoatControls / ControlSource   §T.182 controls + assists (keyboard stub: `controls.ts`)
 *   CameraRig                      §T.182 race camera (stub: FollowCam in follow mode, `stubs.ts`)
 *   BoatAudioSink                  §T.183 engine/hull audio + race-control radio (stub: silent, `stubs.ts`)
 *   HudSink / HudModel             §T.185 HUD (stub: knots readout, `stubs.ts`)
 *   CourseHook                     §T.187 course + archipelago (stub: open sea, `course.ts`)
 *   CrashHook                      §T.188 crashes + respawn (stub: never crashes, `stubs.ts`)
 *
 * Contract rules (docs/speedboat/page.md): a seam is read or called at a FIXED point of the tick
 * or the frame, named on each member below. Sim-side seams (controls, crash) run in the fixed
 * tick and must be pure functions of sim state + that tick's input (§V2, §V106); render-side
 * seams (camera, audio, HUD) read the interpolated view and never write sim state (§V3).
 * Owners extend by ADDING optional members; renaming or removing one is a coordinated change.
 *
 * Pure types: no three.js, no DOM (§V109: nothing here reaches main.ts, main-raft.ts, raft/,
 * combat/ or ai/).
 */
import type { IslandSite } from '../../island';
import type { Course } from '../../race/types';
import type { Rigid6State } from '../../sea-physics/rigidBody';
import type { ShipState } from '../../state/simState';

// ── controls (§T.182) ──────────────────────────────────────────────────────────────────────

/** one tick's pilot input, already shaped (assists applied) — what the drives and the log see */
export interface BoatControls {
  /** −1 (full lock left) .. +1 (full lock right); the page maps it to the drives' own lock */
  steer: number;
  /** −0.3 (reverse) .. 1 */
  throttle: number;
  /** drive trim, −1 (bow down) .. +1 (bow up); carried, not yet read by the physics (§T.182) */
  trim: number;
  /** Surge held this tick; carried, not yet read (§T.184) */
  surge: boolean;
}

export interface ControlSource {
  /**
   * FIXED TICK, before the player's physics step. Returns this tick's controls (the object may be
   * reused between calls). `boat` is the player's sim state at the start of the tick, for
   * speed-sensitive shaping (§T.182 assists) — read only.
   */
  sample(dt: number, boat: Readonly<Rigid6State>): Readonly<BoatControls>;
  dispose(): void;
}

// ── camera (§T.182) ────────────────────────────────────────────────────────────────────────

export interface CameraRig {
  /** RENDER, after the boats are placed: write the lens for this frame from the interpolated view */
  update(view: Readonly<ShipState>, frameDt: number, waterAt: (x: number, z: number) => number): void;
  /** CUT to the boat on the next update (teleport, respawn) */
  snap(): void;
  /** true while a detached/debug camera owns the input (the control source goes quiet) */
  capturesInput(): boolean;
}

// ── audio (§T.183) ─────────────────────────────────────────────────────────────────────────

/** what the page publishes to audio once per rendered frame, after the render (listener reads the lens) */
export interface BoatAudioFrame {
  frameDt: number;
  /** interpolated player view (position/quaternion) — sound follows what is drawn */
  view: Readonly<ShipState>;
  /** live sim state (velocity, rates) — motion follows the sim */
  boat: Readonly<Rigid6State>;
  /** this tick's controls */
  controls: Readonly<BoatControls>;
  /** the player's contact summary (§V101: the same result the forces used) */
  contact: {
    wettedArea: number;
    slamImpulse: number;
    propImmersion: number;
    /** per drive, signed N */
    driveThrust: ArrayLike<number>;
    /** per drive |advance speed| along the drive line, m/s (hullWater `driveAdvance`, §T.183 hook 1) */
    driveAdvance?: ArrayLike<number>;
    /** per drive prop immersion 0..1 (hullWater `driveImmersion`, §T.183 hook 1) */
    driveImmersion?: ArrayLike<number>;
  };
  /** the Governor assist's dial as audio spells it (§T.183 hook 5); absent = 'off' */
  governor?: 'off' | 'air' | 'full';
}

export interface BoatAudioSink {
  /** first user gesture on the page (autoplay policy): create/resume the AudioContext here */
  unlock(): void;
  /** RENDER, last: after the frame is drawn */
  update(frame: Readonly<BoatAudioFrame>): void;
  dispose(): void;
}

// ── HUD (§T.185) ───────────────────────────────────────────────────────────────────────────

export interface HudModel {
  /** player speed over ground, knots */
  knots: number;
  /** player heading, rad (atan2 of the drawn hull's forward x/z) */
  headingRad: number;
  /** NPC physics transport actually running (§V110 telemetry) */
  npcTransport: string;
  /** sim ticks the NPC fleet trails the player by (pipelined kick/collect) */
  npcLagTicks: number;
}

export interface HudSink {
  /** RENDER, after the render: the model is rebuilt from the frame, never stored as sim state */
  update(model: Readonly<HudModel>): void;
  dispose(): void;
}

// ── course / archipelago (§T.187) ──────────────────────────────────────────────────────────

export interface CourseHook {
  /** the islands `buildSea` places (construction-time: the seabed feeds the ocean material) */
  readonly sites: IslandSite[];
  /** the race course, or null for open sea */
  readonly course: Course | null;
  /** grid slot → spawn pose (index 0 = player, 1..n = NPCs), tick 0. Velocity/rates may be non-zero (rolling start) */
  spawn(slot: number): Rigid6State;
}

// ── crash / respawn (§T.188) ───────────────────────────────────────────────────────────────

export type CrashKind = 'capsize' | 'stuff' | 'blowOver' | 'structure' | 'offCourse';

export interface CrashEvent {
  kind: CrashKind;
  /** where the boat should be put back (V108 teleport contract applies) */
  respawn: Rigid6State;
}

export interface CrashHook {
  /**
   * FIXED TICK, after the player's physics step and before the wake reads the contact. A returned
   * event is applied by the page THIS tick through `PlayerBoat.place` (all per-location memory reset,
   * V108) and the camera is snapped.
   */
  tick(dt: number, boat: Readonly<Rigid6State>, contact: Readonly<BoatAudioFrame['contact']>): CrashEvent | null;
}
