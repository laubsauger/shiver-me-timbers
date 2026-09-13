/**
 * Speedboat race logic (§T.184). Pure and deterministic (§V2): state advances only through
 * `step()`, one call per fixed sim tick; time = tick · dt. No Date, no Math.random, no DOM.
 *
 * The page (§T.181) calls `step(sensors)` once per sim tick with one `RacerSensors` per racer
 * in race order, reads `state` (HUD §T.185, AI, audio), `outputs` (thrust multiplier, speed
 * cap, grid slot, ghost) and acts on `events` (respawn teleport §T.188, radio calls).
 * `state.standings` and `state.lapTimes` are in RACE ORDER (the `racerIds` order given here,
 * which is also the grid order, index 0 = pole), not position order; `position` says the place.
 *
 * PENALTY RULE (design doc §3): a missed gate or mark costs +`missPenaltySeconds` added to the
 * classified time; the racer is NOT sent back. A miss is detected when the racer's progress
 * runs `missDistance` past the element, or when it validly passes one of the next
 * `missLookahead` elements first. Crossing the start line before green costs
 * +`jumpStartPenaltySeconds`. Live positions use the track; the results classify finish time
 * plus penalties. Not implemented: the doc's "two missed in a chicane → back to the last gate".
 */
import { elementCenter, elementPoles, segmentCrossesPoles } from './gates';
import { raceParams, type RaceParams } from './params';
import { Polyline } from './polyline';
import { CourseLine, ProgressTracker } from './progress';
import { findRespawnPoint, type IsClear } from './respawn';
import {
  gridSlotPose,
  lampsLit,
  paceBoatPose,
  startSchedule,
  type Pose2,
  type StartSchedule,
} from './rollingStart';
import type { RaceEvent } from './events';
import type { RacerSensors } from './sensors';
import { CheckpointTimes, gapSeconds, rankRacers } from './standings';
import { SurgeMeter } from './surge';
import type { Course, RaceResult, RaceState, RacerStanding, Vec2 } from './types';

export interface RaceOptions {
  course: Course;
  /** racer ids in grid order (index 0 = pole) */
  racerIds: readonly number[];
  /** fixed sim tick, s (§V2: 60 Hz) */
  dt?: number;
  params?: RaceParams;
  /** respawn clearance hook: rocks, structures, shallow bed (boats are checked here) */
  isClear?: IsClear;
}

export interface RacerOutputs {
  racerId: number;
  /** drive thrust multiplier: Surge while boosting, else 1 */
  thrustMultiplier: number;
  /** m/s: 0 on the grid, pace speed × cap factor while rolling, null once green */
  speedCap: number | null;
  /** slot to hold until green, null after */
  gridSlot: Pose2 | null;
  /** 2 s after a respawn: no boat-boat contacts, render flicker */
  ghost: boolean;
}

export interface RaceTick {
  events: RaceEvent[];
  state: RaceState;
  outputs: RacerOutputs[];
}

interface Racer {
  id: number;
  index: number;
  tracker: ProgressTracker;
  checkpoints: CheckpointTimes;
  surge: SurgeMeter;
  last: Vec2 | null;
  started: boolean;
  nextElement: number;
  elementsDone: number;
  lapsCompleted: number;
  lapStartTime: number;
  lapTimes: number[];
  finished: boolean;
  finishTime: number;
  finishProgress: number;
  dnf: boolean;
  retireRequested: boolean;
  penalty: number;
  crashed: boolean;
  crashPending: boolean;
  sinceCrash: number;
  crashProgress: number;
  speedBeforeCrash: number;
  wasRespawnRequested: boolean;
  respawnedThisTick: boolean;
  ghostRemaining: number;
  wrongWay: boolean;
  position: number;
}

export class Race {
  readonly course: Course;
  readonly params: RaceParams;
  readonly dt: number;
  readonly line: CourseLine;
  readonly paceLine: Polyline;
  readonly schedule: StartSchedule;
  private readonly poles: { left: Vec2; right: Vec2 }[];
  /** element arc along the line from the start gate, [0, L); element 0 = 0 */
  private readonly elementArc: number[];
  private readonly racers: Racer[];
  private readonly isClear?: IsClear;
  private tick = 0;
  private phase: RaceState['phase'] = 'prestart';
  private winnerTime: number | null = null;
  private lastState: RaceState | null = null;

  constructor(opts: RaceOptions) {
    const { course } = opts;
    if (course.elements.length < 2) throw new Error('Race: a course needs at least two elements');
    const first = course.elements[0];
    if (first.kind !== 'gate' || first.gate.id !== course.startGateId) {
      throw new Error(`Race: element 0 must be the start gate '${course.startGateId}'`);
    }
    if (new Set(opts.racerIds).size !== opts.racerIds.length) throw new Error('Race: duplicate racer ids');
    this.course = course;
    this.params = opts.params ?? raceParams;
    this.dt = opts.dt ?? 1 / 60;
    this.isClear = opts.isClear;
    const [sx, sz] = elementCenter(first);
    this.line = new CourseLine(course.referenceLine, sx, sz);
    this.paceLine = new Polyline(course.paceLine, false);
    this.schedule = startSchedule(this.paceLine, this.params.start);
    this.poles = elementPoles(course, this.params.markCaptureRange);
    this.elementArc = [0];
    for (let e = 1; e < course.elements.length; e++) {
      const [cx, cz] = elementCenter(course.elements[e]);
      const prev = this.elementArc[e - 1];
      let a = this.line.nearest(cx, cz, prev).u;
      const L = this.line.length;
      while (a < prev) a += L;
      this.elementArc.push(a);
    }
    this.racers = opts.racerIds.map((id, index) => ({
      id,
      index,
      tracker: new ProgressTracker(this.line, this.params.progress),
      checkpoints: new CheckpointTimes(this.params.checkpointSpacing),
      surge: new SurgeMeter(this.params.surge),
      last: null,
      started: false,
      nextElement: 0,
      elementsDone: 0,
      lapsCompleted: 0,
      lapStartTime: 0,
      lapTimes: [],
      finished: false,
      finishTime: 0,
      finishProgress: 0,
      dnf: false,
      retireRequested: false,
      penalty: 0,
      crashed: false,
      crashPending: false,
      sinceCrash: 0,
      crashProgress: 0,
      speedBeforeCrash: 0,
      wasRespawnRequested: false,
      respawnedThisTick: false,
      ghostRemaining: 0,
      wrongWay: false,
      position: 0,
    }));
  }

  /** sim time of the last completed tick, s */
  get simTime(): number {
    return this.tick * this.dt;
  }

  /** race time of a sim time: negative before green */
  raceTimeAt(simTime: number): number {
    return simTime - this.schedule.green;
  }

  get state(): RaceState | null {
    return this.lastState;
  }

  /** retire a racer: DNF on the next tick */
  retire(racerId: number): void {
    const r = this.racers.find((q) => q.id === racerId);
    if (!r) throw new Error(`Race.retire: unknown racer ${racerId}`);
    r.retireRequested = true;
  }

  /** slot pose for a racer at sim time t (the page's initial placement uses t = 0) */
  gridSlot(racerId: number, simTime: number): Pose2 {
    const r = this.racers.find((q) => q.id === racerId);
    if (!r) throw new Error(`Race.gridSlot: unknown racer ${racerId}`);
    return gridSlotPose(r.index, simTime, this.paceLine, this.schedule, this.params.start);
  }

  step(sensors: readonly RacerSensors[]): RaceTick {
    if (sensors.length !== this.racers.length) {
      throw new Error(`Race.step: ${sensors.length} sensors for ${this.racers.length} racers`);
    }
    const events: RaceEvent[] = [];
    const t0 = this.tick * this.dt;
    this.tick++;
    const t1 = this.tick * this.dt;
    const sp = this.params.start;

    // 1. race-wide: lamps, green, phase
    const lampOf = this.schedule.lampTimes.length;
    for (let i = 0; i < lampOf; i++) {
      const lt = this.schedule.lampTimes[i];
      if (lt > t0 && lt <= t1 && lt >= 0) events.push({ kind: 'lights', lit: i + 1, of: lampOf, green: false });
    }
    if (this.schedule.green > t0 && this.schedule.green <= t1) {
      events.push({ kind: 'lights', lit: 0, of: lampOf, green: true });
    }
    this.setPhase(this.phaseAt(t1), events);

    // 2. per racer
    for (let i = 0; i < this.racers.length; i++) {
      const r = this.racers[i];
      const s = sensors[i];
      if (s.racerId !== r.id) throw new Error(`Race.step: sensors[${i}] is racer ${s.racerId}, expected ${r.id}`);
      if (s.positions.length === 0) throw new Error(`Race.step: racer ${r.id} sent no positions`);
      this.stepRacer(r, s, t0, t1, events);
    }

    // 3. DNF: retired, or timed out after the winner
    for (const r of this.racers) {
      if (r.dnf || r.finished) continue;
      const timedOut =
        this.winnerTime !== null && this.raceTimeAt(t1) > this.winnerTime + this.params.dnfAfterWinnerSeconds;
      if (r.retireRequested || timedOut) {
        r.dnf = true;
        events.push({ kind: 'dnf', racerId: r.id });
      }
    }
    this.setPhase(this.phaseAt(t1), events);

    // 4. positions
    const order = rankRacers(
      this.racers.map((r) => ({
        index: r.index,
        dnf: r.dnf,
        finished: r.finished,
        elementsDone: r.elementsDone,
        progress: r.finished ? r.finishProgress : r.tracker.progress,
        classifiedTime: r.finishTime + r.penalty,
        prevPosition: r.position,
      })),
    );
    const moves: RaceEvent[] = [];
    order.forEach((idx, k) => {
      const r = this.racers[idx];
      const to = k + 1;
      if (r.position !== 0 && r.position !== to) moves.push({ kind: 'positionChanged', racerId: r.id, from: r.position, to });
      r.position = to;
    });
    events.push(...moves);

    const state = this.buildState(t1, order);
    this.lastState = state;
    const green = t1 >= this.schedule.green;
    const outputs = this.racers.map((r) => ({
      racerId: r.id,
      thrustMultiplier: r.surge.thrustMultiplier,
      speedCap: green ? null : t1 < this.schedule.rollStart ? 0 : sp.paceSpeed * sp.speedCapFactor,
      gridSlot: green ? null : gridSlotPose(r.index, t1, this.paceLine, this.schedule, sp),
      ghost: r.ghostRemaining > 0,
    }));
    return { events, state, outputs };
  }

  private phaseAt(t: number): RaceState['phase'] {
    if (this.racers.every((r) => r.finished || r.dnf)) return 'finished';
    const sch = this.schedule;
    if (t < sch.rollStart) return 'prestart';
    if (t >= sch.green) return 'racing';
    const firstLamp = sch.lampTimes.length ? sch.lampTimes[0] : sch.green;
    return t < firstLamp ? 'rolling' : 'countdown';
  }

  private setPhase(phase: RaceState['phase'], events: RaceEvent[]): void {
    if (phase === this.phase) return;
    this.phase = phase;
    events.push({ kind: 'phase', phase });
  }

  private stepRacer(r: Racer, s: RacerSensors, t0: number, t1: number, events: RaceEvent[]): void {
    const dt = this.dt;
    r.respawnedThisTick = false;
    r.ghostRemaining = Math.max(0, r.ghostRemaining - dt);
    // the crash happened during this tick: its point is where the tick began, not where the
    // hull tumbled to by the end of it
    const progressBefore = r.tracker.progress;
    const n = s.positions.length;
    for (let j = 0; j < n; j++) {
      const [x, z] = s.positions[j];
      const tj0 = this.raceTimeAt(t0 + (dt * j) / n);
      const tj1 = this.raceTimeAt(t0 + (dt * (j + 1)) / n);
      if (!r.last) {
        r.tracker.reset(x, z, 0);
        r.last = [x, z];
        continue;
      }
      const p0 = r.tracker.progress;
      const p1 = r.tracker.update(x, z);
      r.checkpoints.record(p0, p1, tj0, tj1);
      if (!r.finished && !r.dnf) this.elementsOnSegment(r, r.last[0], r.last[1], x, z, tj0, tj1, events);
      r.last = [x, z];
    }

    if (r.tracker.wrongWay !== r.wrongWay && !r.finished && !r.dnf) {
      r.wrongWay = r.tracker.wrongWay;
      events.push({ kind: 'wrongWay', racerId: r.id, wrongWay: r.wrongWay });
    }

    // A crash stays PENDING from its onset until a respawn, or until the boat has run
    // `crashRecoverSeconds` uncrashed (it recovered by itself). A reset asked for while pending
    // goes back from the crash point with the pre-crash speed, even if the crash machine has
    // already cleared its flag by the tick the request arrives.
    if (s.crashed && !r.crashed) {
      r.crashPending = true;
      r.crashProgress = progressBefore;
    }
    r.crashed = s.crashed;
    if (s.crashed) r.sinceCrash = 0;
    else if (r.crashPending && (r.sinceCrash += dt) >= this.params.crashRecoverSeconds) r.crashPending = false;
    if (!r.crashPending) r.speedBeforeCrash = s.speed;

    const raceT = this.raceTimeAt(t1);
    const earning = this.canEarn(r, raceT);
    const surge = r.surge.step(s, raceT, dt, earning);
    for (const a of surge.awards) {
      events.push({ kind: 'surgeEarned', racerId: r.id, reason: a.reason, amount: a.amount, surge: r.surge.segments });
    }
    if (surge.fired) {
      events.push({ kind: 'surgeFired', racerId: r.id, surge: r.surge.segments, seconds: this.params.surge.boostSeconds });
    }

    const respawnEdge = s.respawnRequested && !r.wasRespawnRequested;
    r.wasRespawnRequested = s.respawnRequested;
    if (respawnEdge && !r.finished && !r.dnf) {
      const from = r.crashPending ? r.crashProgress : r.tracker.progress;
      const others: Vec2[] = [];
      for (const q of this.racers) if (q !== r && q.last && !q.dnf) others.push(q.last);
      const pt = findRespawnPoint(this.line, from, r.speedBeforeCrash, others, this.isClear, this.params.respawn);
      r.tracker.resetTo(pt.progress);
      r.last = [pt.x, pt.z];
      r.ghostRemaining = this.params.respawn.ghostSeconds;
      r.respawnedThisTick = true;
      r.crashPending = false;
      r.surge.voidSector();
      if (r.wrongWay) {
        r.wrongWay = false;
        events.push({ kind: 'wrongWay', racerId: r.id, wrongWay: false });
      }
      events.push({
        kind: 'respawn',
        racerId: r.id,
        x: pt.x,
        z: pt.z,
        yaw: pt.yaw,
        speed: pt.speed,
        ghostSeconds: this.params.respawn.ghostSeconds,
        clear: pt.clear,
      });
    }
  }

  private canEarn(r: Racer, raceT: number): boolean {
    return raceT >= 0 && r.started && !r.finished && !r.dnf;
  }

  /** progress at which the racer's next element sits */
  private nextTarget(r: Racer): number {
    if (!r.started) return 0;
    const L = this.line.length;
    if (r.nextElement === 0) return (r.lapsCompleted + 1) * L;
    return r.lapsCompleted * L + this.elementArc[r.nextElement];
  }

  private elementsOnSegment(
    r: Racer,
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    tj0: number,
    tj1: number,
    events: RaceEvent[],
  ): void {
    const N = this.course.elements.length;
    const lookahead = Math.min(this.params.missLookahead, N - 1);
    let tMin = -1;
    // a segment can pass more than one element (bounded by the element count)
    for (let guard = 0; guard < N && !r.finished; guard++) {
      const base = r.started ? r.nextElement : 0;
      let hit = -1;
      let hitT = 0;
      for (let k = 0; k <= lookahead; k++) {
        const e = (base + k) % N;
        const c = segmentCrossesPoles(this.poles[e].left, this.poles[e].right, x0, z0, x1, z1);
        if (c && c.dir === 'forward' && c.t > tMin) {
          hit = k;
          hitT = c.t;
          break;
        }
      }
      if (hit < 0) break;
      const time = tj0 + (tj1 - tj0) * hitT;
      for (let k = 0; k < hit && !r.finished; k++) this.advance(r, true, time, events);
      if (r.finished) break;
      this.advance(r, false, time, events);
      tMin = hitT;
    }
    // run past the next element without passing it
    for (let guard = 0; guard < N && !r.finished; guard++) {
      if (r.tracker.progress <= this.nextTarget(r) + this.params.missDistance) break;
      this.advance(r, true, tj1, events);
    }
  }

  /** pass (or miss) the racer's next element at race time `time` */
  private advance(r: Racer, missed: boolean, time: number, events: RaceEvent[]): void {
    const N = this.course.elements.length;
    const e = r.started ? r.nextElement : 0;
    const el = this.course.elements[e];
    const earning = this.canEarn(r, time);
    if (missed) {
      this.penalise(r, 'missedElement', e, this.params.missPenaltySeconds, time, events);
    } else {
      events.push({
        kind: 'gateCrossed',
        racerId: r.id,
        element: e,
        elementKind: el.kind,
        id: el.kind === 'gate' ? el.gate.id : el.mark.id,
        lap: Math.min(this.course.laps, r.lapsCompleted + 1 + (e === 0 && r.started ? 1 : 0)),
        time,
      });
    }
    if (el.kind === 'gate') {
      const award = r.surge.passGate(el.gate.sector, earning && !missed);
      if (missed) r.surge.voidSector();
      if (award) {
        events.push({ kind: 'surgeEarned', racerId: r.id, reason: award.reason, amount: award.amount, surge: r.surge.segments });
      }
    }
    r.nextElement = (e + 1) % N;
    if (e === 0 && !r.started) {
      r.started = true;
      if (time < 0 && !missed) this.penalise(r, 'jumpStart', 0, this.params.jumpStartPenaltySeconds, time, events);
      return;
    }
    r.elementsDone++;
    if (e !== 0) return;
    // lap completed
    r.lapsCompleted++;
    const lapTime = time - r.lapStartTime;
    r.lapStartTime = time;
    const best = r.lapTimes.every((lt) => lapTime < lt);
    r.lapTimes.push(lapTime);
    events.push({ kind: 'lapCompleted', racerId: r.id, lap: r.lapsCompleted, lapTime, best, time });
    if (r.lapsCompleted >= this.course.laps || this.winnerTime !== null) {
      r.finished = true;
      r.finishTime = time;
      r.finishProgress = r.tracker.progress;
      if (this.winnerTime === null || time < this.winnerTime) this.winnerTime = time;
      events.push({ kind: 'finish', racerId: r.id, lapsCompleted: r.lapsCompleted, time, totalTime: time + r.penalty });
    }
  }

  private penalise(
    r: Racer,
    reason: 'missedElement' | 'jumpStart',
    element: number,
    seconds: number,
    time: number,
    events: RaceEvent[],
  ): void {
    r.penalty += seconds;
    r.surge.voidSector();
    events.push({ kind: 'penalty', racerId: r.id, reason, element, seconds, totalSeconds: r.penalty, time });
  }

  private buildState(t1: number, order: readonly number[]): RaceState {
    const raceTime = this.raceTimeAt(t1);
    const leader = this.racers[order[0]];
    const standings: RacerStanding[] = this.racers.map((r) => {
      let gap = 0;
      if (r !== leader) {
        gap =
          r.finished && leader.finished
            ? Math.max(0, r.finishTime + r.penalty - (leader.finishTime + leader.penalty))
            : gapSeconds(r.checkpoints, leader.checkpoints);
      }
      const state: RacerStanding['state'] =
        r.finished || r.dnf
          ? 'finished'
          : r.respawnedThisTick
            ? 'respawning'
            : r.crashed
              ? 'crashed'
              : r.ghostRemaining > 0
                ? 'ghost'
                : 'racing';
      return {
        racerId: r.id,
        position: r.position,
        lap: r.started ? Math.min(this.course.laps, r.lapsCompleted + 1) : 0,
        nextElement: r.nextElement,
        progress: r.finished ? r.finishProgress : r.tracker.progress,
        gapToLeader: gap,
        finished: r.finished,
        state,
        surge: r.surge.segments,
        lapsCompleted: r.lapsCompleted,
        penaltySeconds: r.penalty,
        wrongWay: r.wrongWay,
        surgeBoostRemaining: r.surge.boostRemaining,
        dnf: r.dnf,
      };
    });
    const green = t1 >= this.schedule.green;
    const state: RaceState = {
      phase: this.phase,
      raceTime,
      standings,
      lapTimes: this.racers.map((r) => [...r.lapTimes]),
      lights: { lit: lampsLit(t1, this.schedule), of: this.schedule.lampTimes.length, green },
      paceBoat: green
        ? null
        : {
            ...paceBoatPose(t1, this.paceLine, this.schedule, this.params.start),
            speed: t1 < this.schedule.rollStart ? 0 : this.params.start.paceSpeed,
          },
    };
    if (this.winnerTime !== null) state.results = this.results(order);
    return state;
  }

  private results(order: readonly number[]): RaceResult[] {
    return order.map((idx, k) => {
      const r = this.racers[idx];
      return {
        racerId: r.id,
        place: k + 1,
        status: r.finished ? 'finished' : r.dnf ? 'dnf' : 'running',
        lapsCompleted: r.lapsCompleted,
        finishTime: r.finished ? r.finishTime : null,
        penaltySeconds: r.penalty,
        totalTime: r.finished ? r.finishTime + r.penalty : null,
        lapTimes: [...r.lapTimes],
        bestLap: r.lapTimes.length ? Math.min(...r.lapTimes) : null,
      };
    });
  }
}
