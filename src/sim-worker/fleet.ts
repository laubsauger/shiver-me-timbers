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
import { AI_BLOCK_LEN, AI_IN_LEN, AI_OUT_LEN, B, BATCH_ROW, CONTROL_LEN, F, H, HASH_SEED, POSE_LEN, hashBoatOutput, type BoatSimLayout, type LayoutSpec } from './layout';
import { paramsLength, writeParams } from './paramsVector';
import { writeResetPose } from './stepCore';
import {
  MainThreadTransport,
  SabWorkerTransport,
  TransferWorkerTransport,
  type BoatStepTransport,
  type SimInit,
  type TransportKind,
  type WorkerPort,
} from './transport';

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
}

export class BoatFleet {
  readonly transport: BoatStepTransport;
  readonly spec: LayoutSpec;
  /** a stepper reads other boats from WORLD this fleet (§T.186 pilot, §T.188 contacts) */
  private readonly worldReaders: boolean;

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
    };
    this.worldReaders = !!(opts.pilot || opts.contacts);
    const init: SimInit = { seed: opts.seed, oceanParams: opts.oceanParams, seaParams: opts.seaParams };
    if (opts.pilot) init.pilot = opts.pilot;
    if (opts.contacts) init.contacts = opts.contacts;
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

  setControls(i: number, throttle: number, steer: number, trim = 0): void {
    const L = this.home(i);
    const o = L.boatOffset(i) + B.CONTROLS;
    L.f64[o] = throttle;
    L.f64[o + 1] = steer;
    L.f64[o + 2] = trim;
    L.f64[o + CONTROL_LEN - 1] = 0;
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
    for (const L of layouts) {
      if (this.spec.batchCap) L.f64[L.batchOffset()] = 0; // §T.181: a one-tick kick, whatever the last batch was
      L.i32[H.TICK] = tick;
      L.i32[H.CONTACT_OFF_MASK] = this.ghostMask | this.placedMask;
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
    this.transport.kick();
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
  setBatchControls(j: number, i: number, throttle: number, steer: number, trim = 0): void {
    for (const L of this.batchLayouts(j)) {
      const o = L.batchBoatInputOffset(L.batchRowOffset(j), i);
      L.f64[o] = throttle;
      L.f64[o + 1] = steer;
      L.f64[o + 2] = trim;
      L.f64[o + CONTROL_LEN - 1] = 0;
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
    for (const L of layouts) {
      L.f64[L.batchOffset()] = count;
      for (let j = 0; j < count; j++) {
        L.f64[L.batchRowOffset(j) + BATCH_ROW.CONTACT_OFF_MASK] = (this.ghostMask | (j === 0 ? this.placedMask : 0)) >>> 0;
      }
      for (let i = 0; i < this.spec.boats; i++) {
        const src = layouts[this.transport.ownerOf(i)];
        const from = src.boatOffset(i) + B.POSE;
        const to = L.worldPoseOffset(i);
        for (let c = 0; c < POSE_LEN; c++) L.f64[to + c] = src.f64[from + c];
      }
    }
    this.placedMask = 0;
    this.transport.kick();
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
    return this.transport.done();
  }

  poll(): boolean {
    return this.transport.poll();
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
