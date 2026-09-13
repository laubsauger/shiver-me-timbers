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
import { B, CONTROL_LEN, F, H, HASH_SEED, POSE_LEN, hashBoatOutput, type BoatSimLayout, type LayoutSpec } from './layout';
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
}

export class BoatFleet {
  readonly transport: BoatStepTransport;
  readonly spec: LayoutSpec;

  constructor(opts: FleetOptions) {
    this.spec = {
      boats: opts.boats,
      wakeCap: opts.wakeCap ?? DEFAULT_WAKE_CAP,
      oceanLen: paramsLength(opts.oceanParams),
      seaLen: paramsLength(opts.seaParams),
    };
    const init: SimInit = { seed: opts.seed, oceanParams: opts.oceanParams, seaParams: opts.seaParams };
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
  }

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
      L.i32[H.TICK] = tick;
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
    this.transport.kick();
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
