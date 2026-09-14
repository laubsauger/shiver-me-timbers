/**
 * THE NPC FLEET ON THE PAGE LOOP (§T.181 S0, §T.178, §V110): 7 rivals stepped by
 * `src/sim-worker` on whichever transport `createNpcFleet` selects (SAB → transferable worker →
 * main thread), at the SAME fidelity as the player, without touching `core/loop.ts`.
 *
 * PIPELINED MULTI-TICK KICK / COLLECT (docs/speedboat/sim-worker.md "Tick handshake"). The browser
 * main thread may never block on the worker, so `pump()` is called at two points the loop already
 * has — at the end of every fixed tick and at the end of every rendered frame — and each call:
 *   1. if a kick is out and the steppers are done: COLLECT (the kick's last two poses, read OUT);
 *   2. if nothing is out and the fleet trails the page's tick: KICK every tick it owes, up to a
 *      budget, as ONE request (`BoatFleet.kickBatch`): row j carries tick j's time, params and
 *      controls, and the stepper unrolls the rows through the unchanged step core.
 * One request is in flight at a time. A page running 3 ticks per frame (20 fps) or a hidden tab's
 * burst is repaid in one or a few round trips, not one tick per round trip, and NO tick is ever
 * dropped: the pending queue holds every recorded page tick until it is collected.
 *
 * BUDGET, HONEST CATCH-UP. A request carries n = min(owed, maxBatch, budgetTicks) ticks, where
 * budgetTicks = max(1, ⌊budgetMs / measured per-tick step ms⌋). On a worker the budget is latency
 * (the render lags a batch by its step time): max(`NPC_WORKER_BUDGET_MS`, ¾ of the measured interval
 * between kicks — the gap the worker has before the next collect can happen). On the 'main'
 * transport it is main-thread time per pump, `NPC_MAIN_BUDGET_MS`. Whatever the budget does, the
 * trajectory does not change — only how many round trips the catch-up takes; `lagTicks` and
 * `catchUp` report it.
 *
 * DETERMINISM (§V2, §V110). NPC tick k is stepped with the exact float64 SimState.time AND the
 * params snapshot recorded at page tick k (so a weather lerp or a panel drag reaches the rivals'
 * sea on the same tick it reaches the player's, however far they trail), and with
 * `controls(boat, k)`. The control function sees the TICK only: inside a multi-tick request the
 * pose of tick k−1 exists only in the stepper, so a pose-reading control fn here could not be
 * tick-exact. Pose-dependent piloting is the in-stepper §T.186 pilot (it reads tick-k state there).
 *
 * RENDER: `renderPose(i, alpha, out)` lerps between the last two COLLECTED tick poses — after a
 * multi-tick request, the stepper's pose before its last tick (`readBatchPrevPose`) and its last
 * pose — so the lerp spans one tick; a trailing fleet is drawn `lagTicks` behind the player.
 *
 * ERRORS: a stepper error rejects the kick's `done()` (SAB STATUS_ERROR, transfer 'error'
 * message); the fleet stops kicking and `error` holds it, logged once.
 */
import type { OceanParams } from '../../params/ocean';
import type { PilotSetup } from '../../race/ai/pilot';
import type { BoatContactSetup } from '../../sea-physics/boatCollide';
import type { SimWorldData } from '../../sim-worker/worldData';
import type { SeaPhysicsParams } from '../../params/seaPhysics';
import type { Rigid6State } from '../../sea-physics/rigidBody';
import type { BoatFleet } from '../../sim-worker/fleet';
import { AI_IN_LEN, B, POSE_LEN, TR, TR_RPM_DRIVES, TRACE_LEN } from '../../sim-worker/layout';
import { paramsLength, writeParams } from '../../sim-worker/paramsVector';
import type { TransportCaps } from '../../sim-worker/select';
import { createNpcFleet, detectCaps } from '../../sim-worker/select';

/** ticks one request may carry (1 s of sim): bounds the BATCH region (49 KB per shard buffer for 7 boats, measured) */
export const NPC_BATCH_CAP = 60;
/** 'main' transport: main-thread milliseconds one pump may spend stepping rivals */
export const NPC_MAIN_BUDGET_MS = 8;
/** worker transports: the floor of the per-request latency budget (a 60 Hz frame minus slack) */
export const NPC_WORKER_BUDGET_MS = 12;
/** per-tick step estimate before the first measurement: 8 boats on one worker measured 2.6 ms (sim-worker.md) */
export const NPC_INITIAL_STEP_MS = 3;

/** rival controls for page tick `tick` — a function of (boat, tick) only (see DETERMINISM) */
export interface NpcControlFn {
  (boat: number, tick: number): { throttle: number; steer: number };
}
/** placeholder rival controls until §T.186: a straight line at a fixed throttle */
export const STRAIGHT_LINE_THROTTLE = 0.6;
export const straightLine: NpcControlFn = () => ({ throttle: STRAIGHT_LINE_THROTTLE, steer: 0 });

export interface NpcFleetDeps {
  seed: number;
  boats: number;
  oceanParams: OceanParams;
  seaParams: SeaPhysicsParams;
  /** grid slot poses, NPC i → slot i + 1 */
  spawn(i: number): Rigid6State;
  controls?: NpcControlFn;
  /** capability override for tests; default `detectCaps()` */
  caps?: TransportCaps;
  /** ticks per request cap; default NPC_BATCH_CAP */
  batchCap?: number;
  /** budget floor, ms (see BUDGET); default NPC_MAIN_BUDGET_MS on 'main', NPC_WORKER_BUDGET_MS on a worker */
  budgetMs?: number;
  /** clock for the kick-interval measurement; default performance.now */
  now?: () => number;
  /** §T.186 pilot for the NPCs (`boats[d.boats]`, the player's slot, must be null) */
  pilot?: PilotSetup;
  /** §T.188 boat↔boat + static contacts inside the steppers */
  contacts?: BoatContactSetup;
  /** §T.191/§V110 the course's seabed, fetch mask and bars: rivals float on and ground against the player's world */
  world?: SimWorldData;
  /**
   * §T.191: the player rides in the fleet as EXTERNAL boat index `boats` (never stepped by a core, its pose written
   * per tick by the page), so rivals see, avoid, block and collide with the player through WORLD. Turns on the
   * per-row step TRACE the race reads.
   */
  player?: boolean;
}

/** §T.191 what the page hands the fleet with each recorded tick (all tick-indexed, so a batch is tick-exact) */
export interface NpcTickInputs {
  /** the player's pose at the START of this tick */
  playerPose: Readonly<Rigid6State>;
  /** CONTACT_OFF mask for this tick, bit = fleet index (ghosts) */
  contactOff: number;
  /** §T.198 soft-contact mask for this tick, bit = fleet index (the rolling-start formation); absent = 0 */
  contactSoft?: number;
  /** AI IN for every NPC, AI_IN_LEN each (flattened), or null = no standing yet */
  aiIn: Float64Array | null;
}

/** ticks of step trace kept after collect (the race reads them RACE_DELAY_TICKS behind the page) */
export const NPC_TRACE_RING = 256;

const pose = (): Rigid6State => ({ position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] });

export interface NpcCatchUp {
  /** requests kicked */
  batches: number;
  /** ticks in the last request / the largest request so far */
  lastBatch: number;
  maxBatch: number;
  /** the budget's tick count when the last request was sized */
  budgetTicks: number;
  /** largest lag seen at a pump */
  maxLagTicks: number;
}

export interface NpcFleet {
  readonly fleet: BoatFleet;
  readonly boats: number;
  /** last collected NPC tick (0 = the spawn, before the first collect) */
  readonly collectedTick: number;
  /** page ticks the fleet trails by */
  readonly lagTicks: number;
  readonly catchUp: Readonly<NpcCatchUp>;
  readonly error: Error | null;
  /** FIXED TICK: record page tick `tick`'s time and params (call after SimState.time and the weather advanced) */
  recordTick(tick: number, time: number, inputs?: Readonly<NpcTickInputs>): void;
  /**
   * §T.191 V108 teleport of NPC i that lands EXACTLY at the start of page tick `atTick` (the request carrying that
   * tick starts there), whatever the batching — a respawn is part of the trajectory, not of the transport timing.
   */
  queueReset(i: number, pose: Readonly<Rigid6State>, atTick: number): void;
  /** §T.191 step trace slot (`TR.*`) of fleet boat i after page tick `tick` (collected, within NPC_TRACE_RING) */
  trace(tick: number, i: number, slot: number): number;
  /** NPC i's boot placement (`spawn(i)`): the deterministic stand-in before any tick has a trace */
  spawnPose(i: number): Readonly<Rigid6State>;
  /** the fleet index of the player's external slot (−1 without `player`) */
  readonly playerIndex: number;
  /** applied steer (−1..1) at the last collected tick (render: outboard yaw, pilot rig) */
  steer(i: number): number;
  /** end of a tick and end of a frame: collect if home, kick every owed tick the budget allows */
  pump(tick: number): void;
  /** the last two collected tick poses, interpolated */
  renderPose(i: number, alpha: number, out: Rigid6State): Rigid6State;
  /** live collected pose (sim side, for AI/HUD) */
  pose(i: number): Readonly<Rigid6State>;
  /**
   * AUDIO (§T.183 hook 3): the stepper's contact summary at the last collected tick. `slamImpulse` is the
   * SUM over every collect since `resetSlam()` (a render frame may cover several collects), but within
   * one multi-tick request only its last tick's slam is published (stepper OUT) — earlier ticks' slams
   * in a catch-up request are not seen.
   */
  contact(i: number): Readonly<NpcContact>;
  /** AUDIO (§T.183 hook 4): the throttle the rival's controls applied at the last collected tick */
  throttle(i: number): number;
  /** RENDER, after the audio read the frame's slams */
  resetSlam(): void;
  dispose(): void;
}

export interface NpcContact {
  wettedArea: number;
  slamImpulse: number;
  propImmersion: number;
  /** §T.191 per-drive rpm at the last collected tick (engine model, from the step trace; zeros without a trace) */
  driveRpm: Float64Array;
}

/**
 * Build the fleet at boot, BEFORE page tick 1 and on the same tick as the page mirror (the
 * worker's spectrum scheduler countdown is history, sim-worker.md), wait for its steppers, place
 * every rival.
 */
export async function createNpcFleetDriver(d: NpcFleetDeps): Promise<NpcFleet> {
  const batchCap = d.batchCap ?? NPC_BATCH_CAP;
  const playerIndex = d.player ? d.boats : -1;
  const fleetBoats = d.boats + (d.player ? 1 : 0);
  const fleet = createNpcFleet(
    {
      seed: d.seed, boats: fleetBoats, oceanParams: d.oceanParams, seaParams: d.seaParams, batchCap,
      ...(d.pilot ? { pilot: d.pilot } : {}),
      ...(d.contacts ? { contacts: d.contacts } : {}),
      ...(d.world ? { world: d.world } : {}),
      ...(d.player ? { externalBoats: 1, trace: true } : {}),
    },
    d.caps ?? detectCaps(),
  );
  await fleet.ready;
  const controls = d.controls ?? straightLine;
  const now = d.now ?? (() => performance.now());
  const onMain = fleet.kind === 'main';
  const floorMs = d.budgetMs ?? (onMain ? NPC_MAIN_BUDGET_MS : NPC_WORKER_BUDGET_MS);
  const prev = Array.from({ length: d.boats }, pose);
  const curr = Array.from({ length: d.boats }, pose);
  const contacts: NpcContact[] = Array.from({ length: d.boats }, () => ({ wettedArea: 0, slamImpulse: 0, propImmersion: 0, driveRpm: new Float64Array(TR_RPM_DRIVES) }));
  const throttles = new Float64Array(d.boats);
  const steers = new Float64Array(d.boats);
  const spawns: Rigid6State[] = [];
  for (let i = 0; i < d.boats; i++) {
    const p = d.spawn(i);
    spawns.push(structuredClone(p));
    fleet.place(i, p);
    // OUT is zero until the first collect: both render poses start at the spawn
    for (const dst of [prev[i], curr[i]]) {
      dst.position.splice(0, 3, ...p.position);
      dst.quaternion.splice(0, 4, ...p.quaternion);
      dst.velocity.splice(0, 3, ...p.velocity);
      dst.angularVelocity.splice(0, 3, ...p.angularVelocity);
    }
  }

  // PENDING QUEUE: every recorded, uncollected page tick (never dropped)
  const oceanLen = paramsLength(d.oceanParams);
  const paramsLen = oceanLen + paramsLength(d.seaParams);
  /** times[k] = SimState.time of page tick collected + 1 + k */
  const times: number[] = [];
  /** params snapshots, each valid from `tick` until the next entry's tick */
  const paramSteps: { tick: number; vec: Float64Array }[] = [];
  const scratch = new Float64Array(paramsLen);
  let recorded = 0;
  let collected = 0;
  /** ticks in flight (0 = none) */
  let inFlight = 0;
  let error: Error | null = null;
  let stepMs = NPC_INITIAL_STEP_MS;
  let lastKickAt = Number.NaN;
  let kickIntervalMs = 0;
  const catchUp: NpcCatchUp = { batches: 0, lastBatch: 0, maxBatch: 0, budgetTicks: 0, maxLagTicks: 0 };
  // §T.191 per recorded tick: player pose, contact-off mask, AI IN (a ring: the page holds its sim when it would overflow)
  const INPUT_RING = 512;
  const inPose = new Float64Array(INPUT_RING * POSE_LEN);
  const inMask = new Float64Array(INPUT_RING);
  const inSoft = new Float64Array(INPUT_RING);
  const inAi = new Float64Array(INPUT_RING * d.boats * AI_IN_LEN);
  const inAiValid = new Uint8Array(INPUT_RING);
  const traceRing = d.player ? new Float64Array(NPC_TRACE_RING * fleetBoats * TRACE_LEN) : null;
  const scratchPose: Rigid6State = pose();
  const aiRow = new Float64Array(AI_IN_LEN);
  /** pending teleports: atTick → [(i, pose)] */
  const resets = new Map<number, { i: number; pose: Rigid6State }[]>();
  const copyPose = (p: Readonly<Rigid6State>): Rigid6State => ({
    position: [...p.position] as Rigid6State['position'],
    quaternion: [...p.quaternion] as Rigid6State['quaternion'],
    velocity: [...p.velocity] as Rigid6State['velocity'],
    angularVelocity: [...p.angularVelocity] as Rigid6State['angularVelocity'],
  });

  const paramsAt = (tick: number): Float64Array => {
    let v = paramSteps[0].vec;
    for (const s of paramSteps) {
      if (s.tick > tick) break;
      v = s.vec;
    }
    return v;
  };

  const collect = (): void => {
    const n = inFlight;
    for (let i = 0; i < d.boats; i++) {
      if (n === 1) {
        const a = prev[i];
        prev[i] = curr[i];
        curr[i] = fleet.readPose(i, a);
      } else {
        fleet.readBatchPrevPose(i, prev[i]);
        fleet.readPose(i, curr[i]);
      }
    }
    collected += n;
    inFlight = 0;
    for (let i = 0; i < d.boats; i++) {
      const c = contacts[i];
      c.wettedArea = fleet.readOut(i, B.WETTED_AREA);
      c.slamImpulse += fleet.readOut(i, B.SLAM_IMPULSE);
      c.propImmersion = fleet.readOut(i, B.PROP_IMMERSION);
      // piloted rivals: what the pilot applied (trace); otherwise a function of (boat, tick), as handed to the stepper
      throttles[i] = traceRing ? fleet.readTrace(n - 1, i, TR.THROTTLE) : controls(i, collected).throttle;
      steers[i] = traceRing ? fleet.readTrace(n - 1, i, TR.STEER) : controls(i, collected).steer;
      if (traceRing) for (let k = 0; k < TR_RPM_DRIVES; k++) c.driveRpm[k] = fleet.readTrace(n - 1, i, TR.RPM + k);
    }
    if (traceRing) {
      for (let j = 0; j < n; j++) {
        const tick = collected - n + 1 + j;
        const base = (tick % NPC_TRACE_RING) * fleetBoats * TRACE_LEN;
        for (let i = 0; i < fleetBoats; i++) {
          if (i === playerIndex) continue;
          const o = base + i * TRACE_LEN;
          for (let k = 0; k < TRACE_LEN; k++) traceRing[o + k] = fleet.readTrace(j, i, k);
        }
      }
    }
    times.splice(0, n);
    while (paramSteps.length > 1 && paramSteps[1].tick <= collected + 1) paramSteps.shift();
    const measured = fleet.stepMs();
    if (measured > 0 && Number.isFinite(measured)) stepMs = 0.8 * stepMs + 0.2 * measured;
  };

  return {
    fleet,
    boats: d.boats,
    get collectedTick() {
      return collected;
    },
    get lagTicks() {
      return recorded - collected;
    },
    catchUp,
    playerIndex,
    spawnPose(i) {
      return spawns[i];
    },
    queueReset(i, p, atTick) {
      if (!(i >= 0 && i < d.boats)) throw new Error(`[speedboat] NPC fleet: queueReset boat ${i}`);
      if (atTick <= recorded) throw new Error(`[speedboat] NPC fleet: reset for tick ${atTick} but tick ${recorded} is already recorded`);
      const list = resets.get(atTick) ?? [];
      list.push({ i, pose: copyPose(p) });
      resets.set(atTick, list);
    },
    trace(tick, i, slot) {
      if (!traceRing) throw new Error('[speedboat] NPC fleet: no trace (build with player)');
      if (!(tick <= collected && tick > collected - NPC_TRACE_RING && tick >= 1)) {
        throw new Error(`[speedboat] NPC fleet: trace of tick ${tick} outside (${collected - NPC_TRACE_RING}, ${collected}]`);
      }
      return traceRing[((tick % NPC_TRACE_RING) * fleetBoats + i) * TRACE_LEN + slot];
    },
    steer(i) {
      return steers[i];
    },
    get error() {
      return error;
    },
    recordTick(tick, time, inputs) {
      if (tick !== recorded + 1) throw new Error(`[speedboat] NPC fleet: page tick ${tick} recorded after ${recorded} (ticks must be recorded in order, none skipped)`);
      if (tick - collected > INPUT_RING) throw new Error(`[speedboat] NPC fleet: ${tick - collected} ticks owed, input ring holds ${INPUT_RING}`);
      if (d.player && !inputs) throw new Error('[speedboat] NPC fleet: a fleet with the player slot needs the tick inputs');
      if (inputs) {
        const r = tick % INPUT_RING;
        const p = inputs.playerPose;
        const o = r * POSE_LEN;
        for (let c = 0; c < 3; c++) inPose[o + c] = p.position[c];
        for (let c = 0; c < 4; c++) inPose[o + 3 + c] = p.quaternion[c];
        for (let c = 0; c < 3; c++) inPose[o + 7 + c] = p.velocity[c];
        for (let c = 0; c < 3; c++) inPose[o + 10 + c] = p.angularVelocity[c];
        inMask[r] = inputs.contactOff >>> 0;
        inSoft[r] = (inputs.contactSoft ?? 0) >>> 0;
        inAiValid[r] = inputs.aiIn ? 1 : 0;
        if (inputs.aiIn) inAi.set(inputs.aiIn.subarray(0, d.boats * AI_IN_LEN), r * d.boats * AI_IN_LEN);
      }
      recorded = tick;
      times.push(time);
      const a = writeParams(d.oceanParams, scratch, 0);
      const b = writeParams(d.seaParams, scratch, oceanLen);
      if (a || b || paramSteps.length === 0) paramSteps.push({ tick, vec: scratch.slice() });
    },
    pump(tick) {
      if (error) return;
      if (inFlight > 0) {
        if (!fleet.poll()) return;
        collect();
      }
      const owed = Math.min(tick, recorded) - collected;
      if (owed > catchUp.maxLagTicks) catchUp.maxLagTicks = owed;
      if (owed <= 0) return;
      const t = now();
      if (Number.isFinite(lastKickAt)) kickIntervalMs = 0.8 * kickIntervalMs + 0.2 * (t - lastKickAt);
      const budgetMs = onMain ? floorMs : Math.max(floorMs, 0.75 * kickIntervalMs);
      const budgetTicks = Math.max(1, Math.floor(budgetMs / stepMs));
      let n = Math.min(owed, fleet.maxBatch, budgetTicks);
      // a queued teleport lands on the FIRST row of a request: never carry its tick inside a longer one
      const first = collected + 1;
      const landing = resets.get(first);
      if (landing) {
        for (const r of landing) fleet.place(r.i, r.pose);
        resets.delete(first);
      }
      for (const t of resets.keys()) if (t > first && t < first + n) n = t - first;
      for (let j = 0; j < n; j++) {
        const k = collected + 1 + j;
        fleet.setBatchTick(j, k, times[j], paramsAt(k));
        for (let i = 0; i < d.boats; i++) {
          const c = controls(i, k);
          fleet.setBatchControls(j, i, c.throttle, c.steer);
        }
        if (d.player) {
          const r = k % INPUT_RING;
          const o = r * POSE_LEN;
          for (let c = 0; c < 3; c++) scratchPose.position[c] = inPose[o + c];
          for (let c = 0; c < 4; c++) scratchPose.quaternion[c] = inPose[o + 3 + c];
          for (let c = 0; c < 3; c++) scratchPose.velocity[c] = inPose[o + 7 + c];
          for (let c = 0; c < 3; c++) scratchPose.angularVelocity[c] = inPose[o + 10 + c];
          fleet.setBatchExternalPose(j, playerIndex, scratchPose);
          let mask = inMask[r] >>> 0;
          if (j === 0 && landing) for (const q of landing) mask |= 1 << q.i; // its WORLD pose is the pre-teleport one this tick
          fleet.setBatchContactOff(j, mask >>> 0);
          fleet.setBatchContactSoft(j, inSoft[r] >>> 0);
          if (d.pilot) {
            for (let i = 0; i < d.boats; i++) {
              if (inAiValid[r]) aiRow.set(inAi.subarray((r * d.boats + i) * AI_IN_LEN, (r * d.boats + i + 1) * AI_IN_LEN));
              else aiRow.fill(0);
              fleet.setBatchAiInput(j, i, aiRow);
            }
          }
        }
      }
      fleet.kickBatch(n);
      lastKickAt = t;
      inFlight = n;
      catchUp.batches++;
      catchUp.lastBatch = n;
      catchUp.budgetTicks = budgetTicks;
      if (n > catchUp.maxBatch) catchUp.maxBatch = n;
      fleet.done().catch((e: unknown) => {
        if (error) return;
        error = e instanceof Error ? e : new Error(String(e));
        console.error('[speedboat] NPC physics stopped:', error);
      });
    },
    renderPose(i, alpha, out) {
      const a = prev[i];
      const b = curr[i];
      for (let c = 0; c < 3; c++) out.position[c] = a.position[c] + (b.position[c] - a.position[c]) * alpha;
      for (let c = 0; c < 3; c++) out.velocity[c] = a.velocity[c] + (b.velocity[c] - a.velocity[c]) * alpha;
      // nlerp on the shorter arc: one tick apart the angle is small, and this allocates nothing
      const qa = a.quaternion;
      const qb = b.quaternion;
      const s = qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3] < 0 ? -1 : 1;
      let n = 0;
      for (let c = 0; c < 4; c++) {
        out.quaternion[c] = qa[c] + (s * qb[c] - qa[c]) * alpha;
        n += out.quaternion[c] * out.quaternion[c];
      }
      n = Math.sqrt(n) || 1;
      for (let c = 0; c < 4; c++) out.quaternion[c] /= n;
      return out;
    },
    pose(i) {
      return curr[i];
    },
    contact(i) {
      return contacts[i];
    },
    throttle(i) {
      return throttles[i];
    },
    resetSlam() {
      for (const c of contacts) c.slamImpulse = 0;
    },
    dispose() {
      fleet.dispose();
    },
  };
}
