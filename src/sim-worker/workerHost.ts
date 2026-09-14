/**
 * The stepper side of a worker transport (§T.178), environment-free: a browser dedicated
 * worker (`worker.ts`) and a node `worker_threads` worker (tests) both adapt their port to
 * `HostPort` and call `runSimWorker`. The core it builds is the same `BoatSimCore` the
 * main-thread transport steps in-process.
 */
import { BoatSimLayout, F, H, KICK_STOP, STATUS_ERROR } from './layout';
import { BoatSimCore } from './stepCore';
import { stepKick } from './batch';
import type { SimMessage } from './transport';

export interface HostPort {
  post(msg: SimMessage, transfer?: Transferable[]): void;
  listen(cb: (msg: SimMessage) => void): void;
}

function describe(e: unknown): string {
  return e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
}

export function runSimWorker(port: HostPort): void {
  let core: BoatSimCore | null = null;
  let layout: BoatSimLayout | null = null;

  const stepOnce = (L: BoatSimLayout): void => {
    const t0 = performance.now();
    // §T.181: one tick, or every row of a multi-tick kick (batch.ts); STEP_MS stays per TICK
    const ticks = stepKick(core as BoatSimCore, L);
    L.f64[F.STEP_MS] = (performance.now() - t0) / ticks;
  };

  port.listen((msg) => {
    if (msg.type === 'init') {
      try {
        core = new BoatSimCore({ seed: msg.seed, oceanParams: msg.oceanParams, seaParams: msg.seaParams, pilot: msg.pilot, contacts: msg.contacts, world: msg.world });
        layout = new BoatSimLayout(msg.buffer);
      } catch (e) {
        const buf = msg.buffer instanceof ArrayBuffer ? msg.buffer : undefined;
        port.post({ type: 'error', message: describe(e), buffer: buf }, buf ? [buf] : []);
        return;
      }
      if (msg.mode === 'transfer') {
        const buf = msg.buffer as ArrayBuffer;
        port.post({ type: 'ready', buffer: buf }, [buf]);
        return;
      }
      port.post({ type: 'ready' });
      // SAB: this thread now lives in the handshake loop. Blocking a dedicated worker is allowed
      // and is the point — no event-loop hop between the notify and the step.
      const L = layout;
      const i32 = L.i32;
      let last = Atomics.load(i32, H.KICK);
      for (;;) {
        Atomics.wait(i32, H.KICK, last);
        const k = Atomics.load(i32, H.KICK);
        if (k === KICK_STOP) return;
        if (k === last) continue;
        try {
          stepOnce(L);
        } catch (e) {
          Atomics.store(i32, H.STATUS, STATUS_ERROR);
          port.post({ type: 'error', message: describe(e) });
        }
        Atomics.store(i32, H.DONE, k);
        Atomics.notify(i32, H.DONE);
        last = k;
        if (i32[H.STATUS] === STATUS_ERROR) return;
      }
    }
    if (msg.type === 'tick') {
      const buf = msg.buffer;
      try {
        if (!core || !layout) throw new Error('tick before init');
        layout.bind(buf);
        stepOnce(layout);
        layout.i32[H.DONE] = layout.i32[H.KICK];
        port.post({ type: 'tick', buffer: buf }, [buf]);
      } catch (e) {
        port.post({ type: 'error', message: describe(e), buffer: buf }, [buf]);
      }
    }
  });
}
