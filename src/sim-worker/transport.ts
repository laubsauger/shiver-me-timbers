/**
 * THREE TRANSPORTS, ONE STEP CORE (§T.178, §V95, §V110).
 *
 *   'sab'       SharedArrayBuffer per shard + Atomics tick handshake. Zero copies, zero
 *               messages per tick. Needs `crossOriginIsolated` (COOP/COEP, or the Pages shim).
 *   'transfer'  ArrayBuffer per shard, ping-ponged to its worker as a TRANSFERABLE every tick:
 *               the same bytes move, nothing is structured-cloned but a two-field envelope.
 *               Works without isolation.
 *   'main'      ArrayBuffer stepped in-process on the calling thread. Only when there is no Worker.
 *
 * All three construct `BoatSimCore` with the same init and hand it a `BoatSimLayout`; the
 * only code that differs is how `kick` gets the bytes to the core and back. That is what the
 * V2 hash test pins: 600 ticks × 8 boats, identical across the three.
 *
 * HANDSHAKE (one tick, per shard):
 *   main   writes inputs for tick k (fleet.ts) → KICK = seq → Atomics.notify(KICK)
 *   worker Atomics.wait(KICK) → core.step → DONE = seq → Atomics.notify(DONE)
 *   main   poll(): DONE === seq (non-blocking)  |  done(): Atomics.waitAsync(DONE) or a timer poll
 * Browsers forbid Atomics.wait on the main thread, so the page never blocks: kick at the end of
 * a frame's sim ticks, collect at the next frame's first tick (docs/speedboat/sim-worker.md).
 */
import type { OceanParams } from '../params/ocean';
import type { SeaPhysicsParams } from '../params/seaPhysics';
import { BoatSimLayout, F, H, KICK_STOP, STATUS_ERROR, layoutByteLength, type LayoutSpec } from './layout';
import type { PilotSetup } from '../race/ai/pilot';
import type { BoatContactSetup } from '../sea-physics/boatCollide';
import { BoatSimCore } from './stepCore';
import { stepKick } from './batch';

export type TransportKind = 'sab' | 'transfer' | 'main';

/** a browser `Worker` or a node `worker_threads.Worker`, adapted */
export interface WorkerPort {
  post(msg: SimMessage, transfer?: Transferable[]): void;
  listen(cb: (msg: SimMessage) => void): void;
  terminate(): void;
}

export interface SimInit {
  seed: number;
  oceanParams: OceanParams;
  seaParams: SeaPhysicsParams;
  /** §T.186 NPC pilot setup (lines, profiles, archetypes); crosses to the worker once, in the init message */
  pilot?: PilotSetup;
  /** §T.188 collision hook (plain data: static colliders + switches); crosses to the worker once, in the init message */
  contacts?: BoatContactSetup;
}

export type SimMessage =
  | ({ type: 'init'; mode: 'sab' | 'transfer'; buffer: ArrayBuffer | SharedArrayBuffer } & SimInit)
  | { type: 'ready'; buffer?: ArrayBuffer }
  | { type: 'tick'; buffer: ArrayBuffer }
  | { type: 'error'; message: string; buffer?: ArrayBuffer };

export interface BoatStepTransport {
  readonly kind: TransportKind;
  readonly boats: number;
  readonly layouts: readonly BoatSimLayout[];
  /** index into `layouts` of the shard stepping boat i */
  ownerOf(i: number): number;
  /** resolves once every stepper has built its core (the mirror build is ~0.1 s) */
  readonly ready: Promise<void>;
  /** hand the tick inputs already written into `layouts` to the steppers; returns at once ('main' steps here) */
  kick(): void;
  /** non-blocking: every shard has finished the last kick (and the buffers are home) */
  poll(): boolean;
  /** resolves when every shard finished the last kick; rejects with the stepper's error */
  done(): Promise<void>;
  dispose(): void;
}

/** contiguous, near-equal boat ranges — deterministic, so a boat's shard never depends on timing */
export function shardRanges(boats: number, shards: number): [number, number][] {
  const n = Math.max(1, Math.min(Math.floor(shards), Math.max(boats, 1)));
  const out: [number, number][] = [];
  for (let s = 0; s < n; s++) out.push([Math.floor((s * boats) / n), Math.floor(((s + 1) * boats) / n)]);
  return out;
}

function makeLayouts(spec: LayoutSpec, ranges: [number, number][], alloc: (bytes: number) => ArrayBuffer | SharedArrayBuffer): BoatSimLayout[] {
  return ranges.map(([a, b]) => {
    const L = new BoatSimLayout(alloc(layoutByteLength(spec)), spec);
    L.i32[H.SHARD_START] = a;
    L.i32[H.SHARD_END] = b;
    return L;
  });
}

function ownerFn(ranges: [number, number][]): (i: number) => number {
  const owner = new Int32Array(ranges.length ? ranges[ranges.length - 1][1] : 0);
  ranges.forEach(([a, b], s) => owner.fill(s, a, b));
  return (i) => owner[i];
}

/** a deep, independent copy: the in-process core must not share the page's live singletons either */
function cloneInit(init: SimInit): SimInit {
  const out: SimInit = { seed: init.seed, oceanParams: structuredClone(init.oceanParams), seaParams: structuredClone(init.seaParams) };
  if (init.pilot) out.pilot = structuredClone(init.pilot);
  if (init.contacts) out.contacts = structuredClone(init.contacts);
  return out;
}

// ── main thread ────────────────────────────────────────────────────────────────────────────

export class MainThreadTransport implements BoatStepTransport {
  readonly kind = 'main' as const;
  readonly layouts: BoatSimLayout[];
  readonly ready = Promise.resolve();
  readonly core: BoatSimCore;
  readonly boats: number;

  constructor(spec: LayoutSpec, init: SimInit) {
    this.boats = spec.boats;
    this.layouts = makeLayouts(spec, [[0, spec.boats]], (n) => new ArrayBuffer(n));
    this.core = new BoatSimCore(cloneInit(init));
  }

  ownerOf(): number {
    return 0;
  }

  kick(): void {
    const L = this.layouts[0];
    const t0 = performance.now();
    // §T.181: one tick, or every row of a multi-tick kick; STEP_MS stays per TICK
    const ticks = stepKick(this.core, L);
    L.f64[F.STEP_MS] = (performance.now() - t0) / ticks;
    L.i32[H.DONE] = ++L.i32[H.KICK];
  }

  poll(): boolean {
    return true;
  }

  done(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): void {}
}

// ── SharedArrayBuffer + Atomics ─────────────────────────────────────────────────────────────

interface AtomicsWithAsync {
  waitAsync?: (a: Int32Array, i: number, v: number, t?: number) => { async: boolean; value: Promise<string> | string };
}

export class SabWorkerTransport implements BoatStepTransport {
  readonly kind = 'sab' as const;
  readonly layouts: BoatSimLayout[];
  readonly ready: Promise<void>;
  readonly boats: number;
  readonly ownerOf: (i: number) => number;
  private readonly ports: WorkerPort[];
  private seq = 0;
  private error: string | null = null;

  constructor(spec: LayoutSpec, init: SimInit, shards: number, spawn: () => WorkerPort) {
    const ranges = shardRanges(spec.boats, shards);
    this.boats = spec.boats;
    this.ownerOf = ownerFn(ranges);
    this.layouts = makeLayouts(spec, ranges, (n) => new SharedArrayBuffer(n));
    this.ports = this.layouts.map(() => spawn());
    this.ready = Promise.all(
      this.layouts.map(
        (L, s) =>
          new Promise<void>((resolve, reject) => {
            const port = this.ports[s];
            port.listen((msg) => {
              if (msg.type === 'ready') resolve();
              else if (msg.type === 'error') {
                this.error = msg.message;
                reject(new Error(`sim worker ${s}: ${msg.message}`));
              }
            });
            port.post({ type: 'init', mode: 'sab', buffer: L.buffer, ...init });
          }),
      ),
    ).then(() => undefined);
  }

  kick(): void {
    if (!this.poll()) throw new Error('sab transport: kick before the previous tick finished');
    this.seq++;
    for (const L of this.layouts) {
      Atomics.store(L.i32, H.KICK, this.seq);
      Atomics.notify(L.i32, H.KICK);
    }
  }

  poll(): boolean {
    for (const L of this.layouts) if (Atomics.load(L.i32, H.DONE) !== this.seq) return false;
    return true;
  }

  private check(): void {
    for (const L of this.layouts) {
      if (L.i32[H.STATUS] === STATUS_ERROR) throw new Error(`sim worker: ${this.error ?? 'stepper failed (see worker console)'}`);
    }
  }

  /** blocks the calling thread — node and workers only (browsers throw on the main thread) */
  waitSync(): void {
    for (const L of this.layouts) {
      while (Atomics.load(L.i32, H.DONE) !== this.seq) Atomics.wait(L.i32, H.DONE, Atomics.load(L.i32, H.DONE));
    }
    this.check();
  }

  async done(): Promise<void> {
    const A = Atomics as unknown as AtomicsWithAsync;
    for (const L of this.layouts) {
      for (;;) {
        const cur = Atomics.load(L.i32, H.DONE);
        if (cur === this.seq) break;
        if (A.waitAsync) {
          const r = A.waitAsync(L.i32, H.DONE, cur);
          if (r.async) await r.value;
        } else {
          await new Promise((res) => setTimeout(res, 0));
        }
      }
    }
    this.check();
  }

  dispose(): void {
    for (const L of this.layouts) {
      Atomics.store(L.i32, H.KICK, KICK_STOP);
      Atomics.notify(L.i32, H.KICK);
    }
    for (const p of this.ports) p.terminate();
  }
}

// ── transferable ping-pong ──────────────────────────────────────────────────────────────────

export class TransferWorkerTransport implements BoatStepTransport {
  readonly kind = 'transfer' as const;
  readonly layouts: BoatSimLayout[];
  readonly ready: Promise<void>;
  readonly boats: number;
  readonly ownerOf: (i: number) => number;
  private readonly ports: WorkerPort[];
  private readonly home: boolean[];
  private waiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
  private error: Error | null = null;

  constructor(spec: LayoutSpec, init: SimInit, shards: number, spawn: () => WorkerPort) {
    const ranges = shardRanges(spec.boats, shards);
    this.boats = spec.boats;
    this.ownerOf = ownerFn(ranges);
    this.layouts = makeLayouts(spec, ranges, (n) => new ArrayBuffer(n));
    this.home = this.layouts.map(() => false);
    this.ports = this.layouts.map(() => spawn());
    this.layouts.forEach((L, s) => {
      this.ports[s].listen((msg) => {
        if (msg.buffer instanceof ArrayBuffer) L.bind(msg.buffer);
        if (msg.type === 'error') this.error = new Error(`sim worker ${s}: ${msg.message}`);
        if (msg.type === 'ready' || msg.type === 'tick' || msg.type === 'error') {
          this.home[s] = msg.buffer instanceof ArrayBuffer;
          this.settle();
        }
      });
      const buf = L.buffer as ArrayBuffer;
      this.ports[s].post({ type: 'init', mode: 'transfer', buffer: buf, ...init }, [buf]);
    });
    this.ready = this.done();
  }

  private settle(): void {
    if (this.error) {
      const w = this.waiters;
      this.waiters = [];
      for (const x of w) x.reject(this.error);
      return;
    }
    if (!this.poll()) return;
    const w = this.waiters;
    this.waiters = [];
    for (const x of w) x.resolve();
  }

  kick(): void {
    if (this.error) throw this.error;
    if (!this.poll()) throw new Error('transfer transport: kick before the previous tick came home');
    this.layouts.forEach((L, s) => {
      L.i32[H.KICK]++;
      const buf = L.buffer as ArrayBuffer;
      this.home[s] = false;
      this.ports[s].post({ type: 'tick', buffer: buf }, [buf]);
    });
  }

  poll(): boolean {
    return this.home.every(Boolean);
  }

  done(): Promise<void> {
    if (this.error) return Promise.reject(this.error);
    if (this.poll()) return Promise.resolve();
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  dispose(): void {
    for (const p of this.ports) p.terminate();
  }
}

