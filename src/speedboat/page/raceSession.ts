/**
 * THE RACE IN THE FIXED TICK (§T.191): controls, collisions, the player's physics, crash machines, race logic and
 * their outputs, for the player on the page and seven rivals on the sim worker, as ONE deterministic sequence.
 *
 * TICK ORDER (`tick`, §V2 — tests/speedboatRacePage.test.ts reads it):
 *   controls  WORLD snapshot → ControlSource.sample → race outputs applied (crash input cut, rolling-start cap)
 *   collide   player ↔ rivals (snapshot) + statics + bed, the same boatCollide calls the step core makes; the
 *             rivals' tick inputs (player pose, contact-off mask, AI standings) are recorded for the worker
 *   physics   PlayerBoat.tick: setControls → samplePatch → substeps (positions captured per substep, §V107)
 *   crash     the player's step trace row; every racer's crash machine at the RACE tick
 *   race      Race.step(sensors) at the race tick
 *   outputs   respawn teleports (player now, rivals queued to the same landing tick), ghosts, speed caps, standings
 * Collide comes BEFORE physics, as in `BoatSimCore.step` (impulses from the tick-start snapshot change velocities,
 * then the step integrates): a player that collided after her step would not run the rivals' step (§V110).
 *
 * THE RACE RUNS `RACE_DELAY_TICKS` BEHIND THE PAGE, and that is what makes it deterministic. The rivals are stepped
 * off the main thread and come home late (npcFleet.ts pipelining); a race that read "whatever has been collected"
 * would couple player and rivals through the wall clock. Instead, at page tick p:
 *   - the race steps tick r = p − D + 1, from the player's recorded trace row r and the rivals' trace row r;
 *   - its outputs (and every crash machine's) act from page tick p + 1 = r + D, on the player's controls and on
 *     the rivals' tick-(r + D) inputs; a respawn decided at r lands on BOTH sides at tick r + D, and the race is
 *     fed the respawn point (not the wreck the trace still carries) for the ticks in between;
 *   - the player collides against each rival's trace pose at r, extrapolated to the tick start (D − 2 ticks).
 * Every coupling is a function of tick indices only. The page guarantees collected ≥ r by holding the loop
 * (`holdSim`) when the worker falls more than D − MAX_SUBSTEPS ticks behind — a hitch, never a desync.
 * Cost of the choice: race outputs act 117 ms after the tick they describe (input cut on a crash, Surge, HUD).
 * Collisions themselves are immediate, and so is the ROLLING-START CAP (§T.197): it is a pure function of race time
 * (`rollingCapAt`, the rule `Race.step` publishes), so it is evaluated for the tick it acts on — for the player's
 * throttle AND for every rival's recorded AI IN `GO` — instead of being carried 8 ticks. Same tick index on both
 * sides: deterministic and symmetric. What stays lagged, and why (docs/speedboat/page.md §T.197 latency):
 * the crash input cut (the rivals' crash machines need their collected trace; a player-only early cut is asymmetric
 * and its respawn needs the race's lagged respawn point) and Surge (earned from race events; §T.207: the race's
 * `thrustMultiplier` reaches every engine through `HullWater.setBoost` — the player's here, each rival's through its
 * recorded tick input, both from the same lagged race output on the same page tick).
 * WAKES (§T.207): the player's hull reads each rival's wake record of trace tick tA, carried to the tick start like its
 * pose; each rival's hull reads the player's record of the tick start (recorded with its inputs).
 *
 * Identity: racerId 0 is the player (fleet index `npcs.playerIndex`), racerId k ≥ 1 is NPC k − 1 (fleet index k − 1).
 */
import { MAX_SUBSTEPS, SIM_DT } from '../../core/loop';
import { AI_IN, encodeStanding } from '../../race/ai/aiBlock';
import type { RaceEvent } from '../../race/events';
import { Race, type RacerOutputs } from '../../race/race';
import type { RacerSensors } from '../../race/sensors';
import type { Course, RaceState, RacerStanding, Vec2 } from '../../race/types';
import {
  BOAT_COLLIDE_DEFAULTS,
  beginContactTick,
  buildCollisionHull,
  collideBoatWithFleet,
  collideBoatWithWorld,
  createBoatCollideMemory,
  prepareStaticWorld,
  resetBoatCollideMemory,
  writePose,
  type BedHeight,
  type StaticCollider,
} from '../../sea-physics/boatCollide';
import type { Rigid6State } from '../../sea-physics/rigidBody';
import { AI_IN_LEN, AI_OUT_LEN, POSE_LEN, TR, TRACE_LEN } from '../../sim-worker/layout';
import { WAKE_SRC_LEN, WS } from '../../wake/wakeField';
import { writeTrace } from '../../sim-worker/trace';
import {
  CRASH_TIMINGS,
  createCrashMachine,
  createCrashSensors,
  damageGeometryFor,
  designRespawnSpeed,
  measureCrashSensors,
  restCgHeight,
  stepCrashMachine,
  type CrashEvent,
  type CrashMachine,
  type RespawnPlacement,
} from '../crash';
import type { HullProxy } from '../hullMesh';
import { SPAWN_CG_Y } from './course';
import type { NpcFleet, NpcTickInputs } from './npcFleet';
import type { PlayerBoat } from './playerBoat';
import type { BoatControls, ControlSource } from './seams';
import type { FreeRoamRules } from './sessionMode';

/** race ticks behind the page (see header): ≥ MAX_SUBSTEPS + 3 so a whole frame of ticks fits the guarantee */
export const RACE_DELAY_TICKS = 8;
export const PLAYER_RACER_ID = 0;
/** NPC i (racerId i + 1) runs the ui/roster RIVALS[i] courier's archetype, so the HUD's names are the boats' pilots */
export const RIVAL_ARCHETYPES = ['rival', 'swell', 'veteran', 'lee', 'blocker', 'rookie', 'hothead'] as const;
/** player trace ring (ticks); the race reads D ticks back */
const PLAYER_RING = 64;
const G = 9.81;

export interface RaceSessionDeps {
  course: Course;
  hull: HullProxy;
  player: PlayerBoat;
  /** built with `player: true` (the player's external slot) and a pilot for the rivals */
  npcs: NpcFleet;
  controls: ControlSource;
  /** held reset this tick (BoatInput.reset) — the crash machine's `resetRequested` */
  resetPressed(): boolean;
  /** Surge held this tick */
  surgePressed(): boolean;
  /** AssistSettings.autoReset */
  autoReset(): boolean;
  colliders: readonly StaticCollider[];
  bed: BedHeight | null;
  /** the sea surface the hull floats on at the CURRENT sim time — the §V68 pressure head (grid spawn and respawn height) */
  waterAt(x: number, z: number): number;
  /** respawn clearance (race/respawn.ts IsClear): open water, clear of rocks and structures — page/course.ts respawnClear */
  isClear?(x: number, z: number): boolean;
  /** fetch/shadow grid version the page mirror reads this tick (§V110 parity evidence in the trace), NaN if none */
  fetchVersion?(): number;
  /** V108 side effects of a player teleport: frame.snap, camera snap + endCrash, controls.reset */
  onPlayerTeleport?(pose: Readonly<Rigid6State>): void;
  /** the player's crash machine raised a crash (camera: beginCrash) */
  onPlayerCrash?(ev: Extract<CrashEvent, { type: 'crash' }>, at: readonly [number, number, number]): void;
  /** racer ids in grid order; default rivals 1..7 ahead, the player last on the grid */
  gridOrder?: readonly number[];
  /**
   * FREE ROAM (page/sessionMode.ts): never a `Race` — `start` places the player at `spawn()`, and her crash machine runs
   * without one (same D-tick lag, same trace), respawning at `respawn(q)`. Build it with the idle fleet (0 rivals).
   */
  freeRoam?: FreeRoamRules;
}

export interface CrashEventRecord {
  racerId: number;
  event: CrashEvent;
}

const newPose = (): Rigid6State => ({ position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] });

function poseFromRow(row: Float64Array, out: Rigid6State): Rigid6State {
  for (let c = 0; c < 3; c++) out.position[c] = row[TR.POSE + c];
  for (let c = 0; c < 4; c++) out.quaternion[c] = row[TR.POSE + 3 + c];
  for (let c = 0; c < 3; c++) out.velocity[c] = row[TR.POSE + 7 + c];
  for (let c = 0; c < 3; c++) out.angularVelocity[c] = row[TR.POSE + 10 + c];
  return out;
}

/**
 * The rolling-start speed cap in force at race time `t` (s since the race was created): 0 on the grid, pace × cap factor
 * while rolling, null from green. The rule `Race.step` publishes as `RacerOutputs.speedCap` for its tick end t1
 * (tests/speedboatRaceLatency.test.ts holds the two equal on every tick), read off the race's own schedule.
 */
export function rollingCapAt(race: Pick<Race, 'schedule' | 'params'>, t: number): number | null {
  const sp = race.params.start;
  return t >= race.schedule.green ? null : t < race.schedule.rollStart ? 0 : sp.paceSpeed * sp.speedCapFactor;
}

/** throttle under a speed cap (m/s): 0 cap holds the grid, otherwise a gentle limiter toward the cap */
export function capThrottle(throttle: number, speed: number, cap: number | null): number {
  if (cap === null) return throttle;
  if (cap <= 0) return Math.min(throttle, 0);
  const lim = Math.max(0, Math.min(1, 0.2 + (cap - speed) * 0.3));
  return Math.min(throttle, lim);
}

export function createRaceSession(d: RaceSessionDeps) {
  const D = RACE_DELAY_TICKS;
  const { player, npcs, hull } = d;
  const boat = player.state;
  const nNpc = npcs.boats;
  const racers = nNpc + 1;
  const playerIndex = npcs.playerIndex;
  if (playerIndex !== nNpc) throw new Error('[speedboat] race session: the NPC fleet needs the player slot (build it with player: true)');
  const fleetOf = (id: number): number => (id === PLAYER_RACER_ID ? playerIndex : id - 1);
  const gridOrder = d.gridOrder ?? [...Array.from({ length: nNpc }, (_, i) => i + 1), PLAYER_RACER_ID];

  const cHull = buildCollisionHull(hull);
  const staticWorld = d.colliders.length > 0 ? prepareStaticWorld(d.colliders) : null;
  const mem = createBoatCollideMemory(cHull);
  const damageGeometry = damageGeometryFor(cHull);
  const cgAboveWater = restCgHeight(hull);
  const snapshot = new Float64Array(racers * POSE_LEN);
  const npcPose = newPose();

  // player trace (the same TR slots the step core writes for every rival)
  const playerRing = new Float64Array(PLAYER_RING * TRACE_LEN);
  const playerReset = new Uint8Array(PLAYER_RING);
  const playerSurge = new Uint8Array(PLAYER_RING);
  const startPose = newPose();
  const out: BoatControls = { steer: 0, throttle: 0, trim: 0, surge: false };

  // race state
  let race: Race | null = null;
  let startTick = 0;
  let nextRaceTick = 0;
  let lastState: RaceState | null = null;
  let starved = 0;
  const machines: CrashMachine[] = Array.from({ length: racers }, () => createCrashMachine());
  const sensors: RacerSensors[] = Array.from({ length: racers }, () => ({
    racerId: 0, positions: [] as Vec2[], speed: 0, airborne: false, slam: 0, pitch: 0, roll: 0, crashed: false,
    launchedFromWake: false, surgePressed: false, respawnRequested: false,
  }));
  const crashSensors = Array.from({ length: racers }, () => createCrashSensors());
  const rows = Array.from({ length: racers }, () => new Float64Array(TRACE_LEN));
  const machinePose = Array.from({ length: racers }, newPose);
  const requestRespawn = new Uint8Array(racers);
  const respawnPoint: (RespawnPlacement | null)[] = new Array(racers).fill(null);
  const teleport: (Rigid6State | null)[] = new Array(racers).fill(null);
  /** a teleport decided at race tick r lands at r + D: until then the race sees the respawn point */
  const frozen: ({ x: number; z: number; speed: number; until: number } | null)[] = new Array(racers).fill(null);
  const zeroWater = (): number => 0;
  const raceOutputs: { throttleScale: Float64Array; steerScale: Float64Array; speedCap: (number | null)[]; ghost: Uint8Array; soft: Uint8Array; boost: Float64Array } = {
    /** §T.207 Surge: RacerOutputs.thrustMultiplier → the engine boost */
    boost: new Float64Array(racers).fill(1),
    throttleScale: new Float64Array(racers).fill(1),
    steerScale: new Float64Array(racers).fill(1),
    speedCap: new Array(racers).fill(null),
    ghost: new Uint8Array(racers),
    /** §T.198 soft boat↔boat contacts (the rolling-start formation) */
    soft: new Uint8Array(racers),
  };
  /** AI IN for the rivals (flattened) + the player's own (autopilot) */
  const aiIn = new Float64Array(nNpc * AI_IN_LEN);
  const playerAiIn = new Float64Array(AI_IN_LEN);
  let aiValid = false;
  let maskThisTick = 0;
  let softThisTick = 0;
  const events: RaceEvent[] = [];
  const crashEvents: CrashEventRecord[] = [];
  const machineEvents: CrashEvent[] = [];
  const npcBoost = new Float64Array(nNpc).fill(1);
  /** §T.207 the rivals' wake records the player's hull reads this tick */
  const rivalWake = new Float64Array(nNpc * WAKE_SRC_LEN);
  if (npcs.wakes) player.setWakeSources(rivalWake, nNpc);
  const npcInputs: NpcTickInputs = { playerPose: startPose, contactOff: 0, aiIn: null, boost: npcBoost, ...(npcs.wakes ? { playerWake: player.wakeRecord } : {}) };

  /**
   * the cap acting on page tick `tick`: the race's output for the END of tick − 1, as an undelayed race loop would hand
   * it to this step (t = (tick − 1 − startTick)·dt; the first race tick after `start` sees the grid's 0). Before a race
   * exists (select screen, after stop) the stored outputs rule.
   */
  const capFor = (id: number, tick: number): number | null => (race ? rollingCapAt(race, (tick - 1 - startTick) * SIM_DT) : raceOutputs.speedCap[id]);
  const goOf = (cap: number | null): number => (cap === null ? 1 : -Math.max(0, cap));

  const contactOffMask = (): number => {
    let m = 0;
    for (let id = 0; id < racers; id++) if (raceOutputs.ghost[id]) m |= 1 << fleetOf(id);
    return m >>> 0;
  };
  const contactSoftMask = (): number => {
    let m = 0;
    for (let id = 0; id < racers; id++) if (raceOutputs.soft[id]) m |= 1 << fleetOf(id);
    return m >>> 0;
  };

  const encodeAll = (standings: readonly RacerStanding[] | null, speedCaps: readonly (number | null)[]): void => {
    for (let id = 0; id < racers; id++) {
      const s: RacerStanding = standings
        ? (standings.find((q) => q.racerId === id) as RacerStanding)
        : { racerId: id, position: gridOrder.indexOf(id) + 1, lap: 0, nextElement: 0, progress: 0, gapToLeader: 0, finished: false, state: 'racing', surge: 0 };
      const cap = speedCaps[id];
      const go: true | number = cap === null || cap === undefined ? true : cap;
      if (id === PLAYER_RACER_ID) encodeStanding(playerAiIn, -AI_OUT_LEN, s, racers, go);
      else encodeStanding(aiIn, (id - 1) * AI_IN_LEN - AI_OUT_LEN, s, racers, go);
    }
    aiValid = true;
  };

  const resetOutputs = (): void => {
    raceOutputs.boost.fill(1);
    raceOutputs.throttleScale.fill(1);
    raceOutputs.steerScale.fill(1);
    raceOutputs.speedCap.fill(null);
    raceOutputs.ghost.fill(0);
    raceOutputs.soft.fill(0);
  };

  const readRow = (id: number, tick: number, row: Float64Array): void => {
    if (id === PLAYER_RACER_ID) {
      row.set(playerRing.subarray((tick % PLAYER_RING) * TRACE_LEN, (tick % PLAYER_RING + 1) * TRACE_LEN));
    } else {
      const i = id - 1;
      for (let k = 0; k < TRACE_LEN; k++) row[k] = npcs.trace(tick, i, k);
    }
  };

  const session = {
    get race(): Race | null {
      return race;
    },
    get state(): RaceState | null {
      return lastState;
    },
    /** ticks the race had to skip because the rivals' trace was not home (0 unless `holdSim` was ignored) */
    get starvedTicks(): number {
      return starved;
    },
    machines,
    raceOutputs,
    /** the player's collision report of the last tick (boatCollide BoatContactReport: count, maxDeltaV, source, other) */
    get playerContact(): Readonly<typeof mem.report> {
      return mem.report;
    },
    /** the controls the player's physics ran this tick (after the race's outputs) */
    applied: out as Readonly<BoatControls>,
    /** the player's AI IN (encodeStanding) for an autopilot pilot reading the same standings a rival reads */
    playerAiIn,
    /** the tick-start WORLD snapshot, fleet index order (valid after `controls`) */
    snapshot,
    gridOrder,

    /** loop predicate: hold the whole frame while a frame of ticks could outrun the collected rival trace */
    holdSim(tick: number): boolean {
      if (npcs.error) return false;
      return npcs.collectedTick < tick + MAX_SUBSTEPS + 1 - D;
    },

    /** new race from the grid at page tick `atTick` (between ticks: the sim is paused on the select screen) */
    start(atTick: number): void {
      if (d.freeRoam) {
        resetOutputs();
        machines[PLAYER_RACER_ID] = createCrashMachine();
        teleport.fill(null);
        frozen.fill(null);
        // the crash machine reads the trace D − 1 ticks late (`collect`, rt = tick − D + 1): without this its first rows
        // after a (re)start are the OLD pose — the last speed, then a position jump — and a cine placement straight after
        // a fast shot "crashed" at its spawn point with the previous shot's speed (trailer look pass, docs/cine)
        nextRaceTick = atTick + 1;
        const pose = d.freeRoam.spawn();
        player.place(pose);
        // a (re)start is a fresh boat: `place` forgets location memory but not the engines, so a take placed after a fast
        // shot inherited that shot's rpm and its first seconds depended on the run order (trailer drive sim: shot 10 hooked
        // at t 2.1 from idle, at t 0.0 with the previous shot's engines)
        player.hw.resetEngines();
        resetBoatCollideMemory(mem);
        d.onPlayerTeleport?.(pose);
        return;
      }
      race = new Race({ course: d.course, racerIds: gridOrder, dt: SIM_DT, isClear: d.isClear ?? (d.bed ? (x, z) => (d.bed as BedHeight)(x, z) < -3 : undefined) });
      startTick = atTick;
      nextRaceTick = atTick + 1;
      lastState = null;
      resetOutputs();
      for (let id = 0; id < racers; id++) {
        machines[id] = createCrashMachine();
        respawnPoint[id] = null;
        teleport[id] = null;
        frozen[id] = null;
        requestRespawn[id] = 0;
      }
      // the grid holds until the first race tick says otherwise (a rival handed no standing would race off)
      const holdCaps = new Array<number | null>(racers).fill(0);
      encodeAll(null, holdCaps);
      for (let id = 0; id < racers; id++) {
        raceOutputs.speedCap[id] = 0;
        raceOutputs.soft[id] = 1;
      }
      for (const id of gridOrder) {
        const g = race.gridSlot(id, 0);
        const pose = newPose();
        pose.position[0] = g.x;
        pose.position[1] = d.waterAt(g.x, g.z) + SPAWN_CG_Y;
        pose.position[2] = g.z;
        pose.quaternion[1] = Math.sin(g.yaw / 2);
        pose.quaternion[3] = Math.cos(g.yaw / 2);
        if (id === PLAYER_RACER_ID) {
          player.place(pose);
          resetBoatCollideMemory(mem);
          d.onPlayerTeleport?.(pose);
        } else {
          npcs.queueReset(id - 1, pose, atTick + 1);
        }
      }
    },

    stop(): void {
      race = null;
      lastState = null;
      aiValid = false;
      resetOutputs();
    },

    /** CONTROLS: WORLD snapshot, pilot input, then the race's delayed outputs on it */
    controls(dt: number, tick: number): Readonly<BoatControls> {
      for (let c = 0; c < 3; c++) startPose.position[c] = boat.position[c];
      for (let c = 0; c < 4; c++) startPose.quaternion[c] = boat.quaternion[c];
      for (let c = 0; c < 3; c++) startPose.velocity[c] = boat.velocity[c];
      for (let c = 0; c < 3; c++) startPose.angularVelocity[c] = boat.angularVelocity[c];
      writePose(snapshot, 0, playerIndex, boat);
      const tA = tick - D + 1;
      const haveRivals = tA >= 1 && npcs.collectedTick >= tA;
      if (tA >= 1 && !haveRivals) {
        if (starved++ === 0) console.error(`[speedboat] race: rival trace of tick ${tA} not home at page tick ${tick} (collected ${npcs.collectedTick}); the loop hold was bypassed — this tick is not deterministic`);
      }
      for (let i = 0; i < nNpc; i++) {
        if (haveRivals) {
          readRow(i + 1, tA, rows[i + 1]);
          poseFromRow(rows[i + 1], npcPose);
          // the rival's pose at the START of this tick: its trace pose after tick tA, carried D − 2 ticks along
          const h = (tick - 1 - tA) * SIM_DT;
          for (let c = 0; c < 3; c++) npcPose.position[c] += npcPose.velocity[c] * h;
          if (npcs.wakes) {
            const w = i * WAKE_SRC_LEN;
            npcs.wakeSource(tA, i, rivalWake, w);
            rivalWake[w + WS.X] += rivalWake[w + WS.VX] * h;
            rivalWake[w + WS.Z] += rivalWake[w + WS.VZ] * h;
          }
        } else {
          if (npcs.wakes) rivalWake.fill(0, i * WAKE_SRC_LEN, (i + 1) * WAKE_SRC_LEN);
          // never a render pose here: which pose is "collected" depends on the wall clock (§V2, found by the
          // pacing hash in tests/speedboatRaceSmoke.test.ts — the player's autopilot reads this snapshot)
          const sp = npcs.spawnPose(i);
          for (let c = 0; c < 3; c++) npcPose.position[c] = sp.position[c];
          for (let c = 0; c < 4; c++) npcPose.quaternion[c] = sp.quaternion[c];
          for (let c = 0; c < 3; c++) npcPose.velocity[c] = sp.velocity[c];
          for (let c = 0; c < 3; c++) npcPose.angularVelocity[c] = sp.angularVelocity[c];
        }
        writePose(snapshot, 0, i, npcPose);
      }
      maskThisTick = contactOffMask();
      softThisTick = contactSoftMask();
      if (!haveRivals) for (let i = 0; i < nNpc; i++) maskThisTick |= 1 << i;
      const id = PLAYER_RACER_ID;
      if (race && aiValid) playerAiIn[AI_IN.GO] = goOf(capFor(id, tick)); // the autopilot reads the GO a rival does
      const c = d.controls.sample(dt, boat);
      out.steer = c.steer * raceOutputs.steerScale[id];
      out.throttle = capThrottle(c.throttle * raceOutputs.throttleScale[id], Math.hypot(boat.velocity[0], boat.velocity[2]), capFor(id, tick));
      out.trim = c.trim;
      out.surge = c.surge;
      player.hw.setBoost(raceOutputs.boost[id]);
      return out;
    },

    /** COLLIDE: the player against the snapshot, statics and bed; the rivals' inputs for this tick are recorded */
    collide(tick: number, time: number): void {
      beginContactTick(mem);
      collideBoatWithFleet(playerIndex, boat, cHull, snapshot, 0, racers, maskThisTick, SIM_DT, mem, BOAT_COLLIDE_DEFAULTS, softThisTick);
      collideBoatWithWorld(boat, cHull, staticWorld, d.bed, SIM_DT, mem);
      npcInputs.contactOff = contactOffMask();
      npcInputs.contactSoft = contactSoftMask();
      // §T.197: each rival's GO for THIS tick (the standings in the block stay the race's lagged ones)
      if (race && aiValid) for (let i = 0; i < nNpc; i++) aiIn[i * AI_IN_LEN + AI_IN.GO] = goOf(capFor(i + 1, tick));
      for (let i = 0; i < nNpc; i++) npcBoost[i] = raceOutputs.boost[i + 1];
      npcInputs.aiIn = aiValid ? aiIn : null;
      npcs.recordTick(tick, time, npcInputs);
    },

    /** CRASH: the player's trace row for this tick, then every racer's crash machine at the race tick */
    crash(tick: number): void {
      writeTrace(playerRing, (tick % PLAYER_RING) * TRACE_LEN, {
        state: boat, positions: player.positions, contact: player.hw, bowDeck: cHull.bowDeck, collide: mem,
        fetchVersion: d.fetchVersion ? d.fetchVersion() : Number.NaN, throttle: out.throttle, steer: out.steer,
      });
      playerReset[tick % PLAYER_RING] = d.resetPressed() ? 1 : 0;
      playerSurge[tick % PLAYER_RING] = d.surgePressed() ? 1 : 0;

      const rt = tick - D + 1;
      if (!(race || d.freeRoam) || rt < 1 || rt < nextRaceTick || npcs.collectedTick < rt) return;
      for (let id = 0; id < racers; id++) {
        const s = sensors[id];
        s.racerId = gridOrder[id];
      }
      for (let k = 0; k < racers; k++) {
        const id = gridOrder[k];
        const s = sensors[k];
        const pos = s.positions as [number, number][];
        const fr = frozen[id];
        s.launchedFromWake = false;
        s.surgePressed = id === PLAYER_RACER_ID && playerSurge[rt % PLAYER_RING] === 1;
        s.respawnRequested = false;
        if (fr && rt < fr.until) {
          pos.length = 1;
          pos[0] = pos[0] ?? [0, 0];
          pos[0][0] = fr.x;
          pos[0][1] = fr.z;
          s.speed = fr.speed;
          s.airborne = false;
          s.slam = 0;
          s.pitch = 0;
          s.roll = 0;
          s.crashed = false;
          continue;
        }
        frozen[id] = null;
        const row = rows[id];
        readRow(id, rt, row);
        const state = poseFromRow(row, machinePose[id]);
        const cs = measureCrashSensors(state, { bowDeck: cHull.bowDeck, wettedArea: row[TR.WETTED], waterHeightAt: zeroWater, contactDeltaV: row[TR.CONTACT_DV], contactSource: row[TR.CONTACT_SRC] }, crashSensors[id]);
        cs.bowImmersion = row[TR.BOW_IMM];
        const m = machines[id];
        machineEvents.length = 0;
        const wasCrashed = m.phase === 'crashed';
        stepCrashMachine(
          m,
          {
            dt: SIM_DT, state, sensors: cs, contactPoint: row.subarray(TR.CONTACT_POINT, TR.CONTACT_POINT + 3), contactOther: row[TR.CONTACT_OTHER],
            overlapsBoat: row[TR.OVERLAPS] === 1, autoReset: id === PLAYER_RACER_ID ? d.autoReset() : true,
            resetRequested: id === PLAYER_RACER_ID && playerReset[rt % PLAYER_RING] === 1,
          },
          {
            respawn: (q) => respawnPoint[id] ?? d.freeRoam?.respawn(q) ?? { x: q.crashPosition[0], z: q.crashPosition[2], heading: q.crashHeading, speed: designRespawnSpeed(q.speedBeforeCrash) },
            teleport: (p) => {
              teleport[id] = { position: [...p.position] as Rigid6State['position'], quaternion: [...p.quaternion] as Rigid6State['quaternion'], velocity: [...p.velocity] as Rigid6State['velocity'], angularVelocity: [...p.angularVelocity] as Rigid6State['angularVelocity'] };
            },
            waterHeightAt: d.waterAt,
            cgAboveWater,
            damageGeometry,
          },
          machineEvents,
        );
        for (const ev of machineEvents) {
          crashEvents.push({ racerId: id, event: ev });
          if (id === PLAYER_RACER_ID && ev.type === 'crash' && !wasCrashed) d.onPlayerCrash?.(ev, m.crashPosition);
        }
        // the race is asked for its respawn point the tick BEFORE the fade ends, so the machine teleports onto it
        if (m.phase === 'respawning' && m.phaseTime + SIM_DT >= CRASH_TIMINGS.fadeOut) requestRespawn[id] = 1;
        s.respawnRequested = requestRespawn[id] === 1;
        requestRespawn[id] = 0;
        const t = teleport[id];
        if (t) {
          frozen[id] = { x: t.position[0], z: t.position[2], speed: Math.hypot(t.velocity[0], t.velocity[2]), until: rt + D };
          pos.length = 1;
          pos[0] = pos[0] ?? [0, 0];
          pos[0][0] = t.position[0];
          pos[0][1] = t.position[2];
        } else {
          const ns = Math.max(1, Math.min(4, row[TR.SUBSTEPS]));
          pos.length = ns;
          for (let q = 0; q < ns; q++) {
            pos[q] = pos[q] ?? [0, 0];
            pos[q][0] = row[TR.POS + q * 2];
            pos[q][1] = row[TR.POS + q * 2 + 1];
          }
        }
        s.speed = cs.groundSpeed;
        s.airborne = cs.wettedArea < 0.5;
        s.slam = row[TR.SLAM] / hull.mass / SIM_DT / G;
        s.pitch = (cs.pitchDeg * Math.PI) / 180;
        s.roll = (cs.heelDeg * Math.PI) / 180;
        s.crashed = m.phase === 'crashed';
      }
      // free roam: no Race.step hands the crash machine's outputs on, so they act from here (input cut, ghost)
      if (!race && d.freeRoam) {
        const o = machines[PLAYER_RACER_ID].out;
        raceOutputs.throttleScale[PLAYER_RACER_ID] = o.throttleScale;
        raceOutputs.steerScale[PLAYER_RACER_ID] = o.steerScale;
        raceOutputs.ghost[PLAYER_RACER_ID] = o.ghost ? 1 : 0;
      }
    },

    /** RACE: one Race.step at the race tick */
    step(tick: number): void {
      const rt = tick - D + 1;
      if (!race || rt < nextRaceTick || npcs.collectedTick < rt) return;
      nextRaceTick = rt + 1;
      const res = race.step(sensors);
      lastState = res.state;
      for (const ev of res.events) {
        events.push(ev);
        if (ev.kind === 'respawn') respawnPoint[ev.racerId] = { x: ev.x, z: ev.z, heading: ev.yaw, speed: ev.speed };
      }
      applyRaceOutputs(res.outputs);
      encodeAll(res.state.standings, raceOutputs.speedCap);
    },

    /** OUTPUTS: teleports land at the next tick on both sides; the rest was stored by `step` */
    applyOutputs(tick: number): void {
      for (let id = 0; id < racers; id++) {
        const t = teleport[id];
        if (!t) continue;
        teleport[id] = null;
        respawnPoint[id] = null;
        if (id === PLAYER_RACER_ID) {
          player.place(t);
          resetBoatCollideMemory(mem);
          d.onPlayerTeleport?.(t);
        } else {
          npcs.queueReset(id - 1, t, tick + 1);
        }
      }
    },

    /** THE FIXED-TICK SEQUENCE (see header) — the page calls this between `frame.tickSea` and `frame.tickBoat` */
    tick(tick: number, time: number, dt: number): void {
      const c = session.controls(dt, tick);
      session.collide(tick, time);
      player.tick(c, time, dt);
      session.crash(tick);
      session.step(tick);
      session.applyOutputs(tick);
    },

    /** events since the last drain (render: HUD radio/toasts, audio) */
    drain(): { events: RaceEvent[]; crashEvents: CrashEventRecord[] } {
      const e = events.splice(0);
      const c = crashEvents.splice(0);
      return { events: e, crashEvents: c };
    },

    /** the race tick the state describes (page tick − D + 1), and the page tick the race started at */
    get raceTick(): number {
      return nextRaceTick - 1;
    },
    get startTick(): number {
      return startTick;
    },
  };

  function applyRaceOutputs(o: readonly RacerOutputs[]): void {
    for (const q of o) {
      const id = q.racerId;
      const m = machines[id];
      raceOutputs.throttleScale[id] = m.out.throttleScale;
      raceOutputs.steerScale[id] = m.out.steerScale;
      raceOutputs.speedCap[id] = q.speedCap;
      raceOutputs.boost[id] = q.thrustMultiplier;
      // FORMATION (§T.198): SOFT boat↔boat contacts until green. The rivals' pilot has no grid-slot hold (§T.186 open
      // item): it rides its racing line from the slot it was placed in, so both grid columns converge onto one line
      // behind the pace boat. Full contacts rolled boats over on the grid (§T.191 smoke race); no contacts let hulls
      // overlap (user: "boats can't overlap"). Soft = a horizontal fender push through the CG (boatCollide softMask).
      // A respawn ghost still passes through everything.
      raceOutputs.ghost[id] = q.ghost || m.out.ghost ? 1 : 0;
      raceOutputs.soft[id] = q.speedCap !== null ? 1 : 0;
    }
  }

  return session;
}
export type RaceSession = ReturnType<typeof createRaceSession>;
