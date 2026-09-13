/**
 * THE CRASH STATE MACHINE (§T.188; design doc §3; tech-research §4.5 with the user's respawn change). One per boat,
 * stepped in the FIXED tick after that boat's physics step (§V2: a pure function of sim state, this tick's input and
 * its own state).
 *
 *   RACING ──crash detected──▶ CRASHED   input cut, 1.5 s engine stall starts, the tumble plays out with physics
 *   CRASHED ──upright, slow, calm and wet for 0.5 s (after ≥ 1 s)──▶ RACING            recover in place
 *   CRASHED ──capsized 1.2 s | bow under 1.0 s | structure hit > 20 kn (after 1.2 s) | 3 s | reset held──▶ RESPAWNING
 *   RACING ──reset held──▶ RESPAWNING
 *   RESPAWNING ──0.4 s fade out──▶ teleport (V108) onto the race logic's placement ──▶ GHOST
 *   GHOST ──2 s and clear of every boat──▶ RACING                                        (no boat↔boat contacts)
 *   GHOST ──crash detected──▶ CRASHED
 *
 * Total reset cost from a crash ≈ 1.2–3 s + 0.4 s fade + the distance the placement puts her back (design: 4–6 s).
 * `autoReset: false` (Pro assist preset) keeps a wreck CRASHED until it recovers or the pilot holds reset.
 * Phase names match `RacerStanding.state` in src/race/types.ts.
 */
import type { Rigid6State } from '../../sea-physics/rigidBody';
import { createCrashDetectMemory, CRASH_THRESHOLDS, detectCrash, isAirborne, resetCrashDetectMemory, updateCrashDetectMemory, type CrashDetectMemory, type CrashKind, type CrashThresholds } from './detect';
import { addContactDamage, addCrashDamage, createDamage, type DamageGeometry, type DamageState } from './damage';
import type { CrashSensors } from './sensors';
import { respawnPose, type RespawnProvider } from './teleport';

export type CrashPhase = 'racing' | 'crashed' | 'respawning' | 'ghost';

export interface CrashTimings {
  /** a wreck may recover in place no sooner than this after the crash, s */
  recoverMinTime: number;
  /** ...and only once the recover conditions have held this long, s */
  recoverHold: number;
  recoverTiltDeg: number;
  recoverSpeed: number;
  recoverAngularSpeed: number;
  /** the crash window: not recovered by then ⇒ respawn, s (task: "upright within 3 s") */
  crashWindow: number;
  /** design §3: auto respawn after 1.2 s capsized */
  capsizedFor: number;
  capsizedTiltDeg: number;
  /** design §3: auto respawn after 1.0 s bow under */
  bowUnderFor: number;
  bowUnderImmersion: number;
  /** design §3: a structure hit above 20 kn resets; shown for this long first, s */
  structureDeltaV: number;
  structureShowFor: number;
  fadeOut: number;
  fadeIn: number;
  ghost: number;
  /** design §3: Governor fuel cut, re-fire after 1.5 s */
  stall: number;
  /** contacts at or above this |Δv| raise an `impact` event (audio/camera), m/s */
  impactEventDeltaV: number;
}

export const CRASH_TIMINGS: Readonly<CrashTimings> = Object.freeze({
  recoverMinTime: 1.0,
  recoverHold: 0.5,
  recoverTiltDeg: 30,
  recoverSpeed: 8,
  recoverAngularSpeed: 1.0,
  crashWindow: 3.0,
  capsizedFor: 1.2,
  capsizedTiltDeg: 110,
  bowUnderFor: 1.0,
  bowUnderImmersion: 0.4,
  structureDeltaV: 20 * 0.514444,
  structureShowFor: 1.2,
  fadeOut: 0.4,
  fadeIn: 0.4,
  ghost: 2.0,
  stall: 1.5,
  impactEventDeltaV: 2,
});

export type CrashEvent =
  | { type: 'crash'; kind: CrashKind; /** collision |Δv| for impacts, else the speed lost over 0.1 s, m/s */ impact: number }
  | { type: 'impact'; deltaV: number; source: number; other: number }
  | { type: 'recovered' }
  | { type: 'respawnStart'; kind: CrashKind | null }
  | { type: 'teleport'; pose: Rigid6State }
  | { type: 'respawnEnd' };

export interface CrashMachine {
  phase: CrashPhase;
  /** seconds in the current phase */
  phaseTime: number;
  kind: CrashKind | null;
  /** engine stall left, s (audio: fuel cut / re-fire) */
  stall: number;
  recoverHeld: number;
  capsizedTime: number;
  bowUnderTime: number;
  structureHit: boolean;
  crashPosition: [number, number, number];
  crashHeading: number;
  speedBeforeCrash: number;
  readonly detect: CrashDetectMemory;
  readonly damage: DamageState;
  /** outputs, valid after each step */
  out: CrashOutputs;
}

export interface CrashOutputs {
  /** multiply the pilot's throttle by this (0 while crashed / respawning / stalled) */
  throttleScale: number;
  /** multiply the pilot's steer by this (0 while crashed / respawning) */
  steerScale: number;
  /** no boat↔boat contacts for this boat (fleet ghost mask) */
  ghost: boolean;
  /** 0 = fully visible, 1 = faded out (render) */
  fade: number;
}

export function createCrashMachine(): CrashMachine {
  return {
    phase: 'racing',
    phaseTime: 0,
    kind: null,
    stall: 0,
    recoverHeld: 0,
    capsizedTime: 0,
    bowUnderTime: 0,
    structureHit: false,
    crashPosition: [0, 0, 0],
    crashHeading: 0,
    speedBeforeCrash: 0,
    detect: createCrashDetectMemory(),
    damage: createDamage(),
    out: { throttleScale: 1, steerScale: 1, ghost: false, fade: 0 },
  };
}

export interface CrashTickInput {
  dt: number;
  /** the boat's state AFTER this tick's physics step */
  state: Readonly<Rigid6State>;
  sensors: Readonly<CrashSensors>;
  /** this tick's largest contact: body-frame point (BoatContactReport.bodyPoint), |Δv|, source, other */
  contactPoint: ArrayLike<number>;
  contactOther: number;
  /** BoatContactReport.overlapsBoat — a ghost ends only when clear */
  overlapsBoat: boolean;
  /** AssistSettings.autoReset */
  autoReset: boolean;
  /** the reset hold completed this tick (BoatInput.reset) */
  resetRequested: boolean;
}

export interface CrashDeps {
  respawn: RespawnProvider;
  /** apply the V108 teleport to the live boat (teleportBoat for the player, BoatFleet.place for a worker boat) */
  teleport(pose: Readonly<Rigid6State>): void;
  waterHeightAt(x: number, z: number): number;
  /** restCgHeight(hull) */
  cgAboveWater: number;
  damageGeometry: Readonly<DamageGeometry>;
  thresholds?: Readonly<CrashThresholds>;
  timings?: Readonly<CrashTimings>;
}

function enter(m: CrashMachine, phase: CrashPhase): void {
  m.phase = phase;
  m.phaseTime = 0;
  m.recoverHeld = 0;
  m.capsizedTime = 0;
  m.bowUnderTime = 0;
}

function heading(s: Readonly<Rigid6State>): number {
  const [qx, qy, qz, qw] = s.quaternion;
  const fx = 2 * (qx * qz + qw * qy);
  const fz = 1 - 2 * (qx * qx + qy * qy);
  return Math.hypot(fx, fz) > 0.2 ? Math.atan2(fx, fz) : Math.atan2(s.velocity[0], s.velocity[2]);
}

function beginCrash(m: CrashMachine, kind: CrashKind, inp: CrashTickInput, T: Readonly<CrashTimings>, events: CrashEvent[]): void {
  enter(m, 'crashed');
  m.kind = kind;
  m.stall = T.stall;
  m.structureHit = kind === 'impact' && inp.sensors.contactDeltaV >= T.structureDeltaV;
  for (let k = 0; k < 3; k++) m.crashPosition[k] = inp.state.position[k];
  m.crashHeading = heading(inp.state);
  m.speedBeforeCrash = Math.max(m.detect.speedBefore, inp.sensors.groundSpeed);
  addCrashDamage(m.damage, kind, inp.sensors.heelDeg);
  const impact = kind === 'impact' ? inp.sensors.contactDeltaV : Math.max(0, m.detect.speedBefore - inp.sensors.speed);
  events.push({ type: 'crash', kind, impact });
}

function beginRespawn(m: CrashMachine, inp: CrashTickInput, events: CrashEvent[]): void {
  if (m.phase === 'racing' || m.phase === 'ghost') {
    for (let k = 0; k < 3; k++) m.crashPosition[k] = inp.state.position[k];
    m.crashHeading = heading(inp.state);
    m.speedBeforeCrash = inp.sensors.groundSpeed;
    m.kind = null;
  }
  enter(m, 'respawning');
  events.push({ type: 'respawnStart', kind: m.kind });
}

/**
 * One tick. Pushes this tick's events into `events` (not cleared here) and fills `m.out`. May call
 * `deps.teleport` (once, at the end of the fade).
 */
export function stepCrashMachine(m: CrashMachine, inp: CrashTickInput, deps: CrashDeps, events: CrashEvent[]): CrashOutputs {
  const T = deps.timings ?? CRASH_TIMINGS;
  const th = deps.thresholds ?? CRASH_THRESHOLDS;
  const s = inp.sensors;
  const dt = inp.dt;
  updateCrashDetectMemory(m.detect, s, dt);
  m.phaseTime += dt;
  m.stall = Math.max(0, m.stall - dt);

  // contacts: events for audio/camera, marks for the render
  if (s.contactDeltaV >= T.impactEventDeltaV) {
    events.push({ type: 'impact', deltaV: s.contactDeltaV, source: s.contactSource, other: inp.contactOther });
  }
  if (s.contactDeltaV > 0) addContactDamage(m.damage, deps.damageGeometry, inp.contactPoint[0], inp.contactPoint[1], inp.contactPoint[2], s.contactDeltaV);

  switch (m.phase) {
    case 'racing':
    case 'ghost': {
      const kind = detectCrash(s, m.detect, th);
      if (kind) beginCrash(m, kind, inp, T, events);
      else if (inp.resetRequested) beginRespawn(m, inp, events);
      else if (m.phase === 'ghost' && m.phaseTime >= T.ghost && !inp.overlapsBoat) {
        enter(m, 'racing');
        events.push({ type: 'respawnEnd' });
      }
      break;
    }
    case 'crashed': {
      if (s.contactDeltaV >= T.structureDeltaV) m.structureHit = true;
      m.capsizedTime = s.tiltDeg >= T.capsizedTiltDeg ? m.capsizedTime + dt : 0;
      m.bowUnderTime = s.bowImmersion >= T.bowUnderImmersion ? m.bowUnderTime + dt : 0;
      const calm =
        m.phaseTime >= T.recoverMinTime && s.tiltDeg <= T.recoverTiltDeg && s.speed <= T.recoverSpeed && s.angularSpeed <= T.recoverAngularSpeed && !isAirborne(s, th);
      m.recoverHeld = calm ? m.recoverHeld + dt : 0;
      if (m.recoverHeld >= T.recoverHold) {
        enter(m, 'racing');
        m.kind = null;
        events.push({ type: 'recovered' });
      } else if (inp.resetRequested) {
        beginRespawn(m, inp, events);
      } else if (
        inp.autoReset &&
        (m.capsizedTime >= T.capsizedFor || m.bowUnderTime >= T.bowUnderFor || (m.structureHit && m.phaseTime >= T.structureShowFor) || m.phaseTime >= T.crashWindow)
      ) {
        beginRespawn(m, inp, events);
      }
      break;
    }
    case 'respawning': {
      if (m.phaseTime >= T.fadeOut) {
        const place = deps.respawn({
          crashPosition: m.crashPosition,
          crashHeading: m.crashHeading,
          speedBeforeCrash: m.speedBeforeCrash,
          position: [inp.state.position[0], inp.state.position[1], inp.state.position[2]],
        });
        const pose = respawnPose(place, deps.waterHeightAt, deps.cgAboveWater);
        deps.teleport(pose);
        resetCrashDetectMemory(m.detect);
        m.stall = 0;
        m.kind = null;
        enter(m, 'ghost');
        events.push({ type: 'teleport', pose });
      }
      break;
    }
  }

  const o = m.out;
  const driving = m.phase === 'racing' || m.phase === 'ghost';
  o.steerScale = driving ? 1 : 0;
  o.throttleScale = driving && m.stall <= 0 ? 1 : 0;
  o.ghost = m.phase === 'ghost' || m.phase === 'respawning';
  o.fade = m.phase === 'respawning' ? Math.min(1, m.phaseTime / T.fadeOut) : m.phase === 'ghost' ? Math.max(0, 1 - m.phaseTime / T.fadeIn) : 0;
  return o;
}
