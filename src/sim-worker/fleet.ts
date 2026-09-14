/**
 * The main-thread face of NPC physics (§T.178): writes tick inputs into whichever transport
 * is underneath and reads the results back. Transport-agnostic by construction — every
 * method goes through `layouts` / `ownerOf`, so a caller cannot tell SAB from transferable
 * from in-process except by `kind` and timing.
 *
 * TICK ORDER (deterministic, §V2):
 *   collect k   (await fleet.done() or fleet.poll())   ← results of the previous kick
 *   read poses / contact for render + game logic
 *   setControls / place for tick k (AI, input)
 *   kick(tick, time, oceanParams, seaParams)          ← AFTER weather/panel moved the params
 * Nothing may be written between kick and collect: on the transferable path the buffers are
 * not even on this thread (writes throw here rather than vanish).
 */
import type { OceanParams } from '../params/ocean';
import type { SeaPhysicsParams } from '../params/seaPhysics';
import type { Rigid6State } from '../sea-physics/rigidBody';
import { AI_BLOCK_LEN, AI_IN_LEN, AI_OUT_LEN, B, BATCH_ROW, CONTROL_LEN, F, H, HASH_SEED, POSE_LEN, TRACE_LEN, WAKE_SAMPLE_LEN, hashBoatOutput, type BoatSimLayout, type LayoutSpec } from './layout';
import { paramsLength, writeParams } from './paramsVector';
import { writeResetPose } from './stepCore';
import { createBoatFx, readBoatFx, type BoatFx } from './fx';
import type { HydroSample } from '../wake/wakeSolverMath';
import { WAKE_SRC_LEN } from '../wake/wakeField';
import {
  MainThreadTransport,
  SabWorkerTransport,
  TransferWorkerTransport,
  type BoatStepTransport,
  type SimInit,
  type TransportKind,
  type WorkerPort,
} from './transport';

/** §T.195 one boat's effects of the last collected step (`BoatFleet.effects`) — main-owned copies */
export interface BoatEffects {
  /** the page tick of the step (−1 = none yet / external boat) */
  tick: number;
  pose: Rigid6State;
  /** the contact's plan-column wake load samples of that step */
  wake: HydroSample[];
  fx: BoatFx;
}

export function createBoatEffects(): BoatEffects {
  return { tick: -1, pose: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] }, wake: [], fx: createBoatFx() };
}

/** wake load samples kept per boat per tick; the contact rarely exceeds ~200 wet cells on the 12 m hull */
export const DEFAULT_WAKE_CAP = 256;

export interface FleetOptions extends SimInit {
  boats: number;
  kind: TransportKind;
  /** worker shards (ignored for 'main'); default 1 */
  workers?: number;
  wakeCap?: number;
  /** required for 'sab' / 'transfer' */
  spawn?: () => WorkerPort;
  /** §T.181: ticks one `kickBatch` may carry (0/absent = no BATCH region, `kick` only; the layout is unchanged) */
  batchCap?: number;
  /** §T.191: the LAST n fleet indices are external (main writes their pose every tick; never stepped) */
  externalBoats?: number;
  /** §T.191: per-row TRACE region (readTrace) */
  trace?: boolean;
  /** §T.207: every hull feels every other boat's wake (layout WAKE regions; `setExternalWakeSource` for external boats) */
  wakeField?: boolean;
}

export class BoatFleet {
  readonly transport: BoatStepTransport;
  readonly spec: LayoutSpec;
  /** a stepper reads other boats from WORLD this fleet (§T.186 pilot, §T.188 contacts, §T.207 wakes) */
  private readonly worldReaders: boolean;
  /** §T.207 external boats' wake records for the next one-tick kick (main-owned) */
  private readonly extWake: Float64Array;

  constructor(opts: FleetOptions) {
    this.spec = {
      boats: opts.boats,
      wakeCap: opts.wakeCap ?? DEFAULT_WAKE_CAP,
      oceanLen: paramsLength(opts.oceanParams),
      seaLen: paramsLength(opts.seaParams),
      // §T.186: the AI block exists only when a pilot setup is given (otherwise the layout is unchanged)
      ...(opts.pilot ? { aiLen: AI_BLOCK_LEN } : {}),
      // §T.181: the BATCH region exists only when asked for (otherwise the layout is unchanged)
      ...(opts.batchCap ? { batchCap: opts.batchCap } : {}),
      ...(opts.externalBoats ? { externalBoats: opts.externalBoats } : {}),
      ...(opts.trace ? { trace: true } : {}),
      ...(opts.wakeField ? { wakeField: true } : {}),
    };
    this.worldReaders = !!(opts.pilot || opts.contacts || opts.wakeField);
    this.extWake = new Float64Array(opts.wakeField ? opts.boats * WAKE_SRC_LEN : 0);
    const init: SimInit = { seed: opts.seed, oceanParams: opts.oceanParams, seaParams: opts.seaParams };
    if (opts.pilot) init.pilot = opts.pilot;
    if (opts.contacts) init.contacts = opts.contacts;
    if (opts.world) init.world = opts.world;
    const workers = opts.workers ?? 1;
    if (opts.kind === 'main') this.transport = new MainThreadTransport(this.spec, init);
    else {
      if (!opts.spawn) throw new Error(`fleet: transport '${opts.kind}' needs a worker spawner`);
      this.transport =
        opts.kind === 'sab'
          ? new SabWorkerTransport(this.spec, init, workers, opts.spawn)
          : new TransferWorkerTransport(this.spec, init, workers, opts.spawn);
    }
    // params reach the buffer in kick(), tick 0 included (the stepper reads them on its first
    // step whatever PARAMS_VERSION says); on the transferable path the buffers are away until `ready`
  }

  get kind(): TransportKind {
    return this.transport.kind;
  }

  get ready(): Promise<void> {
    return this.transport.ready;
  }

  private home(i: number): BoatSimLayout {
    const L = this.transport.layouts[this.transport.ownerOf(i)];
    if (L.buffer.byteLength === 0 || !this.transport.poll()) {
      throw new Error('fleet: buffers are with the stepper — collect (done/poll) before reading or writing');
    }
    return L;
  }

  /** teleport / spawn (V108: the stepper resets every per-location memory for this boat) */
  place(i: number, pose: Readonly<Rigid6State>): void {
    if (this.isExternal(i)) throw new Error(`fleet: boat ${i} is external — write its pose with setExternalPose`);
    writeResetPose(this.home(i), i, pose);
    // §T.188: its WORLD pose next kick is the pre-teleport one — no boat contacts for it that tick
    if (i < 32) this.placedMask |= 1 << i;
  }

  /** §T.188: respawn ghost — boat i makes and receives no boat↔boat contacts while set (the crash machine's `out.ghost`) */
  setGhost(i: number, ghost: boolean): void {
    if (!(i >= 0 && i < 32)) throw new Error(`fleet: ghost mask holds boats 0..31, got ${i}`);
    if (ghost) this.ghostMask |= 1 << i;
    else this.ghostMask &= ~(1 << i);
  }

  private ghostMask = 0;
  private placedMask = 0;
  /** §T.191 per-row contact-off overrides for the next kickBatch (NaN = default ghost mask) */
  private rowContactOff: number[] = [];
  /** §T.198 per-row soft-contact masks for the next kickBatch (absent = 0) */
  private rowContactSoft: number[] = [];

  /** §T.191: boat i is external (main-driven) */
  isExternal(i: number): boolean {
    const ext = this.spec.externalBoats ?? 0;
    return i >= this.spec.boats - ext && i < this.spec.boats;
  }

  /**
   * §T.191: an external boat's pose at the START of the next one-tick kick's tick. Written into its OUT POSE, which
   * `kick` copies into every shard's WORLD like any other boat's.
   */
  setExternalPose(i: number, pose: Readonly<Rigid6State>): void {
    if (!this.isExternal(i)) throw new Error(`fleet: boat ${i} is not external`);
    const L = this.home(i);
    const p = L.boatOffset(i) + B.POSE;
    const f = L.f64;
    for (let c = 0; c < 3; c++) f[p + c] = pose.position[c];
    for (let c = 0; c < 4; c++) f[p + 3 + c] = pose.quaternion[c];
    for (let c = 0; c < 3; c++) f[p + 7 + c] = pose.velocity[c];
    for (let c = 0; c < 3; c++) f[p + 10 + c] = pose.angularVelocity[c];
  }

  /** §T.191: row j's pose of external boat i (its pose at the START of that row's tick), into every shard */
  setBatchExternalPose(j: number, i: number, pose: Readonly<Rigid6State>): void {
    if (!this.isExternal(i)) throw new Error(`fleet: boat ${i} is not external`);
    for (const L of this.batchLayouts(j)) {
      const o = L.batchExternalPoseOffset(L.batchRowOffset(j), i);
      const f = L.f64;
      for (let c = 0; c < 3; c++) f[o + c] = pose.position[c];
      for (let c = 0; c < 4; c++) f[o + 3 + c] = pose.quaternion[c];
      for (let c = 0; c < 3; c++) f[o + 7 + c] = pose.velocity[c];
      for (let c = 0; c < 3; c++) f[o + 10 + c] = pose.angularVelocity[c];
    }
  }

  /**
   * §T.191: row j's contact-off mask for the next `kickBatch`, REPLACING the ghost mask on that row (the placed mask
   * is still OR'ed onto row 0). Cleared by the kick.
   */
  setBatchContactOff(j: number, mask: number): void {
    this.batchLayouts(j);
    if (!(Number.isInteger(mask) && mask >= 0 && mask <= 0xffffffff)) throw new Error(`fleet: contact-off mask ${mask} is not a uint32`);
    this.rowContactOff[j] = mask;
  }

  /** §T.198: row j's soft-contact mask for the next `kickBatch` (boatCollide `softMask`; 0 when not set). Cleared by the kick. */
  setBatchContactSoft(j: number, mask: number): void {
    this.batchLayouts(j);
    if (!(Number.isInteger(mask) && mask >= 0 && mask <= 0xffffffff)) throw new Error(`fleet: contact-soft mask ${mask} is not a uint32`);
    this.rowContactSoft[j] = mask;
  }

  /** §T.191: boat i's TRACE slot `slot` (layout TR) for row j of the last collected kick (row 0 for a one-tick kick) */
  readTrace(j: number, i: number, slot: number): number {
    const L = this.home(i);
    if (!(slot >= 0 && slot < TRACE_LEN)) throw new Error(`fleet: trace slot ${slot} out of range`);
    const rows = this.lastKickTicks();
    if (!(j >= 0 && j < rows)) throw new Error(`fleet: trace row ${j} outside the last kick's ${rows} rows`);
    return L.f64[L.traceOffset(j, i) + slot];
  }

  /** §T.191: the layout + offset of boat i's TRACE record for row j (bulk reads; same validity as readTrace) */
  traceRecord(j: number, i: number): { f64: Float64Array; offset: number } {
    const L = this.home(i);
    const rows = this.lastKickTicks();
    if (!(j >= 0 && j < rows)) throw new Error(`fleet: trace row ${j} outside the last kick's ${rows} rows`);
    return { f64: L.f64, offset: L.traceOffset(j, i) };
  }

  /** `boost`: §T.207 the race's Surge thrust multiplier, fed to the engine (`HullWater.setBoost`; ≤ 1 = stock) */
  setControls(i: number, throttle: number, steer: number, trim = 0, boost = 0): void {
    const L = this.home(i);
    const o = L.boatOffset(i) + B.CONTROLS;
    L.f64[o] = throttle;
    L.f64[o + 1] = steer;
    L.f64[o + 2] = trim;
    L.f64[o + CONTROL_LEN - 1] = boost;
  }

  /** §T.207: external boat i's wake record (src/wake/wakeField.ts) at the start of the next one-tick kick's tick */
  setExternalWakeSource(i: number, rec: ArrayLike<number>, offset = 0): void {
    if (!this.spec.wakeField) throw new Error('fleet: no wake regions (build the fleet with wakeField)');
    if (!this.isExternal(i)) throw new Error(`fleet: boat ${i} is not external`);
    for (let c = 0; c < WAKE_SRC_LEN; c++) this.extWake[i * WAKE_SRC_LEN + c] = rec[offset + c];
  }

  /** §T.207: row j's wake record of external boat i (its record at the START of that row's tick), into every shard */
  setBatchExternalWakeSource(j: number, i: number, rec: ArrayLike<number>, offset = 0): void {
    if (!this.spec.wakeField) throw new Error('fleet: no wake regions (build the fleet with wakeField)');
    if (!this.isExternal(i)) throw new Error(`fleet: boat ${i} is not external`);
    for (const L of this.batchLayouts(j)) {
      const o = L.batchExternalWakeOffset(L.batchRowOffset(j), i);
      for (let c = 0; c < WAKE_SRC_LEN; c++) L.f64[o + c] = rec[offset + c];
    }
    // the next one-tick kick starts from the latest record main gave
    for (let c = 0; c < WAKE_SRC_LEN; c++) this.extWake[i * WAKE_SRC_LEN + c] = rec[offset + c];
  }

  /** §T.207: stepped boat i's wake record after row j of the last collected kick, into `out[o..]` */
  readWakeSource(j: number, i: number, out: Float64Array, o = 0): void {
    const L = this.home(i);
    const rows = this.lastKickTicks();
    if (!(j >= 0 && j < rows)) throw new Error(`fleet: wake row ${j} outside the last kick's ${rows} rows`);
    const src = L.wakeOutOffset(j, i);
    for (let c = 0; c < WAKE_SRC_LEN; c++) out[o + c] = L.f64[src + c];
  }

  /**
   * §T.207 WAKE WORLD for the kick about to go out: every stepped boat's record after the last collected tick (its home
   * shard's WAKE OUT, last row), every external boat's from main — the same freeze as the WORLD poses.
   */
  private writeWakeWorld(layouts: readonly BoatSimLayout[]): void {
    if (!this.spec.wakeField) return;
    const lastRow = this.lastKickTicks() - 1;
    for (const L of layouts) {
      for (let i = 0; i < this.spec.boats; i++) {
        const to = L.wakeWorldOffset(i);
        if (this.isExternal(i)) {
          for (let c = 0; c < WAKE_SRC_LEN; c++) L.f64[to + c] = this.extWake[i * WAKE_SRC_LEN + c];
        } else {
          const src = layouts[this.transport.ownerOf(i)];
          const from = src.wakeOutOffset(lastRow, i);
          for (let c = 0; c < WAKE_SRC_LEN; c++) L.f64[to + c] = src.f64[from + c];
        }
      }
    }
  }

  readPose(i: number, out: Rigid6State): Rigid6State {
    const L = this.home(i);
    const p = L.boatOffset(i) + B.POSE;
    const f = L.f64;
    for (let c = 0; c < 3; c++) out.position[c] = f[p + c];
    for (let c = 0; c < 4; c++) out.quaternion[c] = f[p + 3 + c];
    for (let c = 0; c < 3; c++) out.velocity[c] = f[p + 7 + c];
    for (let c = 0; c < 3; c++) out.angularVelocity[c] = f[p + 10 + c];
    return out;
  }

  /** §T.186: write boat i's AI IN slots for tick k (race standing; `race/ai/aiBlock.encodeStanding` fills `values`) */
  writeAiInput(i: number, values: ArrayLike<number>): void {
    const L = this.home(i);
    if (values.length !== AI_IN_LEN) throw new Error(`fleet: AI input needs ${AI_IN_LEN} values`);
    const o = L.aiOffset(i) + AI_OUT_LEN;
    for (let k = 0; k < AI_IN_LEN; k++) L.f64[o + k] = values[k];
  }

  /** §T.186: boat i's AI OUT slot (`race/ai/aiBlock.AI.*`) — the pilot's applied controls and memory */
  readAi(i: number, slot: number): number {
    const L = this.home(i);
    if (!(slot >= 0 && slot < AI_OUT_LEN)) throw new Error(`fleet: AI slot ${slot} out of range`);
    return L.f64[L.aiOffset(i) + slot];
  }

  /** a boat's OUT slot (contact summary, `B.*`) */
  readOut(i: number, slot: number): number {
    const L = this.home(i);
    return L.f64[L.boatOffset(i) + slot];
  }

  /** the layout holding boat i (read wake samples at `boatOffset(i) + B.WAKE`) */
  layoutOf(i: number): BoatSimLayout {
    return this.home(i);
  }

  /** summed stepper wall time of the last tick across shards, ms (telemetry) */
  stepMs(): number {
    let t = 0;
    for (const L of this.transport.layouts) t += L.f64[F.STEP_MS];
    return t;
  }

  /**
   * Write tick k's shared inputs into every shard — time, params (version bumped only when a
   * leaf moved), and the WORLD snapshot of every boat's current pose — then hand over.
   */
  kick(tick: number, time: number, oceanParams: OceanParams, seaParams: SeaPhysicsParams): void {
    const layouts = this.transport.layouts;
    for (const L of layouts) if (L.buffer.byteLength === 0) throw new Error("fleet: kick while buffers are away");
    if (!this.transport.poll()) throw new Error('fleet: kick before the previous tick was collected');
    this.writeWakeWorld(layouts);
    for (const L of layouts) {
      if (this.spec.batchCap) L.f64[L.batchOffset()] = 0; // §T.181: a one-tick kick, whatever the last batch was
      L.i32[H.TICK] = tick;
      L.i32[H.CONTACT_OFF_MASK] = this.ghostMask | this.placedMask;
      L.f64[F.CONTACT_SOFT_MASK] = 0;
      L.f64[F.TIME] = time;
      const a = writeParams(oceanParams, L.f64, L.oceanOffset);
      const b = writeParams(seaParams, L.f64, L.seaOffset);
      if (a || b) L.i32[H.PARAMS_VERSION]++;
      for (let i = 0; i < this.spec.boats; i++) {
        const src = layouts[this.transport.ownerOf(i)];
        const from = src.boatOffset(i) + B.POSE;
        const to = L.worldPoseOffset(i);
        for (let c = 0; c < POSE_LEN; c++) L.f64[to + c] = src.f64[from + c];
      }
    }
    this.placedMask = 0;
    this.rowContactOff = [];
    this.rowContactSoft = [];
    this.transport.kick();
    this.kickSerial++;
  }

  // ── §T.181 multi-tick kick ─────────────────────────────────────────────────────────────────
  //   for j in 0..n−1: setBatchTick(j, …) + setBatchControls(j, i, …) [+ setBatchAiInput]  →  kickBatch(n)
  // The stepper unrolls the rows through the unchanged step core (batch.ts): tick for tick the same inputs a
  // one-tick kick would carry, so the OUT hash after the batch equals n one-tick kicks (§V2).

  /**
   * Ticks one `kickBatch` may carry: the layout's `batchCap`, or 1 when several shards step boats that read other
   * boats from WORLD (pilot, contacts) — a shard cannot see another shard's poses mid-batch, so a longer batch
   * there would not be tick-exact.
   */
  get maxBatch(): number {
    const cap = this.spec.batchCap ?? 0;
    if (cap === 0) return 1;
    return this.transport.layouts.length > 1 && this.worldReaders ? 1 : cap;
  }

  private batchLayouts(j: number): readonly BoatSimLayout[] {
    const layouts = this.transport.layouts;
    if (!this.spec.batchCap) throw new Error('fleet: no BATCH region (build the fleet with batchCap)');
    if (!(j >= 0 && j < this.spec.batchCap)) throw new Error(`fleet: batch row ${j} out of [0, ${this.spec.batchCap})`);
    for (const L of layouts) {
      if (L.buffer.byteLength === 0 || !this.transport.poll()) {
        throw new Error('fleet: buffers are with the stepper — collect (done/poll) before writing a batch');
      }
    }
    return layouts;
  }

  /**
   * Row j's shared inputs: page tick, its exact float64 SimState.time, and the params THAT tick ran on as one
   * vector (ocean leaves then sea leaves, `paramsVector.writeParams` order; length oceanLen + seaLen).
   */
  setBatchTick(j: number, tick: number, time: number, params: ArrayLike<number>): void {
    const n = this.spec.oceanLen + this.spec.seaLen;
    if (params.length !== n) throw new Error(`fleet: batch params vector needs ${n} values, got ${params.length}`);
    for (const L of this.batchLayouts(j)) {
      const r = L.batchRowOffset(j);
      L.f64[r + BATCH_ROW.TICK] = tick;
      L.f64[r + BATCH_ROW.TIME] = time;
      for (let k = 0; k < n; k++) L.f64[r + BATCH_ROW.PARAMS + k] = params[k];
    }
  }

  /** row j's controls for boat i (same slots and meaning as `setControls`) */
  setBatchControls(j: number, i: number, throttle: number, steer: number, trim = 0, boost = 0): void {
    for (const L of this.batchLayouts(j)) {
      const o = L.batchBoatInputOffset(L.batchRowOffset(j), i);
      L.f64[o] = throttle;
      L.f64[o + 1] = steer;
      L.f64[o + 2] = trim;
      L.f64[o + CONTROL_LEN - 1] = boost;
    }
  }

  /** row j's AI IN for boat i (§T.186 race standing for THAT tick; same values as `writeAiInput`) */
  setBatchAiInput(j: number, i: number, values: ArrayLike<number>): void {
    if (!this.spec.aiLen) throw new Error('fleet: no AI block');
    if (values.length !== AI_IN_LEN) throw new Error(`fleet: AI input needs ${AI_IN_LEN} values`);
    for (const L of this.batchLayouts(j)) {
      const o = L.batchBoatInputOffset(L.batchRowOffset(j), i) + CONTROL_LEN;
      for (let k = 0; k < AI_IN_LEN; k++) L.f64[o + k] = values[k];
    }
  }

  /**
   * Hand over rows 0..count−1 (consecutive ticks, checked). WORLD gets every boat's current pose, as `kick` does;
   * the contact-off mask is the ghost mask on every row plus the placed mask on the FIRST row only (the teleport
   * lands on that tick, after which WORLD holds the new pose).
   */
  kickBatch(count: number): void {
    if (!(Number.isInteger(count) && count >= 1 && count <= this.maxBatch)) {
      throw new Error(`fleet: batch of ${count} outside [1, ${this.maxBatch}]`);
    }
    const layouts = this.batchLayouts(count - 1);
    const L0 = layouts[0];
    const t0 = L0.f64[L0.batchRowOffset(0) + BATCH_ROW.TICK];
    for (let j = 1; j < count; j++) {
      const t = L0.f64[L0.batchRowOffset(j) + BATCH_ROW.TICK];
      if (t !== t0 + j) throw new Error(`fleet: batch row ${j} is tick ${t}, expected ${t0 + j} (rows must be consecutive ticks)`);
    }
    this.writeWakeWorld(layouts);
    for (const L of layouts) {
      L.f64[L.batchOffset()] = count;
      for (let j = 0; j < count; j++) {
        const base = this.rowContactOff[j] ?? this.ghostMask;
        L.f64[L.batchRowOffset(j) + BATCH_ROW.CONTACT_OFF_MASK] = (base | (j === 0 ? this.placedMask : 0)) >>> 0;
        L.f64[L.batchRowOffset(j) + BATCH_ROW.CONTACT_SOFT_MASK] = (this.rowContactSoft[j] ?? 0) >>> 0;
      }
      for (let i = 0; i < this.spec.boats; i++) {
        const src = layouts[this.transport.ownerOf(i)];
        const from = src.boatOffset(i) + B.POSE;
        const to = L.worldPoseOffset(i);
        for (let c = 0; c < POSE_LEN; c++) L.f64[to + c] = src.f64[from + c];
      }
    }
    this.placedMask = 0;
    this.rowContactOff = [];
    this.rowContactSoft = [];
    this.transport.kick();
    this.kickSerial++;
  }

  /** ticks the last kick carried, as the stepper saw them (1 for a one-tick kick) */
  lastKickTicks(): number {
    const L = this.transport.layouts[0];
    if (L.buffer.byteLength === 0) throw new Error('fleet: buffers are with the stepper');
    return this.spec.batchCap ? Math.max(1, L.f64[L.batchOffset()]) : 1;
  }

  /** boat i's pose BEFORE the last kick's final tick (stepper output; valid after a `kickBatch` is collected) */
  readBatchPrevPose(i: number, out: Rigid6State): Rigid6State {
    const L = this.home(i);
    if (!this.spec.batchCap) throw new Error('fleet: no BATCH region');
    const p = L.batchPrevPoseOffset(i);
    const f = L.f64;
    for (let c = 0; c < 3; c++) out.position[c] = f[p + c];
    for (let c = 0; c < 4; c++) out.quaternion[c] = f[p + 3 + c];
    for (let c = 0; c < 3; c++) out.velocity[c] = f[p + 7 + c];
    for (let c = 0; c < 3; c++) out.angularVelocity[c] = f[p + 10 + c];
    return out;
  }

  done(): Promise<void> {
    return this.transport.done().then(() => this.captureEffects());
  }

  poll(): boolean {
    const home = this.transport.poll();
    if (home) this.captureEffects();
    return home;
  }

  // ── §T.195 every boat marks the water ────────────────────────────────────────────────────────────
  // The page draws a rival's wake, prop wash and spray every tick, but may read the buffers only between collect and
  // the next kick — and the NPC driver kicks again in the same pump it collected in. So the fleet COPIES each stepped
  // boat's pose, wake samples and effects record out at the moment a kick is first seen home (poll/done): a
  // main-owned snapshot of the request's LAST tick, stable until the next request lands. Tick-exact (§V2): the same
  // bytes on every transport (tests/simWorkerEffects.test.ts).

  private kickSerial = 0;
  private effectsSerial = 0;
  private readonly effectsSnap: BoatEffects[] = [];

  /**
   * Boat i's effects from the last collected request (pose, wake samples, jets, waterline spray, all of ONE step);
   * `tick` −1 before any request came home, and for an external (main-driven) boat.
   */
  effects(i: number): Readonly<BoatEffects> {
    if (!(i >= 0 && i < this.spec.boats)) throw new Error(`fleet: boat ${i} out of [0, ${this.spec.boats})`);
    if (this.transport.poll()) this.captureEffects();
    return (this.effectsSnap[i] ??= createBoatEffects());
  }

  private captureEffects(): void {
    if (this.effectsSerial === this.kickSerial) return;
    const layouts = this.transport.layouts;
    for (const L of layouts) if (L.buffer.byteLength === 0) return;
    for (let i = 0; i < this.spec.boats; i++) {
      const e = (this.effectsSnap[i] ??= createBoatEffects());
      const L = layouts[this.transport.ownerOf(i)];
      if (this.isExternal(i)) {
        e.tick = -1;
        e.wake.length = 0;
        e.fx.jets.length = 0;
        e.fx.bow.inContact = false;
        e.fx.bow.flux = 0;
        continue;
      }
      const f = L.f64;
      const o = L.boatOffset(i);
      e.tick = L.i32[H.TICK];
      const p = o + B.POSE;
      for (let c = 0; c < 3; c++) e.pose.position[c] = f[p + c];
      for (let c = 0; c < 4; c++) e.pose.quaternion[c] = f[p + 3 + c];
      for (let c = 0; c < 3; c++) e.pose.velocity[c] = f[p + 7 + c];
      for (let c = 0; c < 3; c++) e.pose.angularVelocity[c] = f[p + 10 + c];
      const count = Math.max(0, Math.min(this.spec.wakeCap, f[o + B.WAKE_COUNT] | 0));
      for (let k = 0; k < count; k++) {
        const q = o + B.WAKE + k * WAKE_SAMPLE_LEN;
        const w = (e.wake[k] ??= { x: 0, z: 0, fy: 0, footprint: 0, depth: 0 });
        w.x = f[q];
        w.z = f[q + 1];
        w.fy = f[q + 2];
        w.footprint = f[q + 3];
        w.depth = f[q + 4];
      }
      e.wake.length = count;
      readBoatFx(f, o + B.FX, e.fx);
    }
    this.effectsSerial = this.kickSerial;
  }

  /** V2 hash of every boat's OUT block, chained onto `seed` */
  hash(seed: number = HASH_SEED): number {
    let h = seed;
    for (let i = 0; i < this.spec.boats; i++) h = hashBoatOutput(this.home(i), i, h);
    return h;
  }

  dispose(): void {
    this.transport.dispose();
  }
}
