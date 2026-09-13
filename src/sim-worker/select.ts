/**
 * Which transport a page gets (§T.178, §V110). Order, user decision 2026-09-13:
 *   1. 'sab'       when `crossOriginIsolated` and SharedArrayBuffer exist — the default. Dev and
 *                  preview get isolation from Vite's COOP/COEP headers, GitHub Pages from the
 *                  COI service-worker shim (public/coi-register.js).
 *   2. 'transfer'  when a Worker exists — transferable ping-pong, same core, full fidelity.
 *   3. 'main'      only with no Worker at all.
 * Fidelity never depends on this choice; only where the milliseconds are spent does.
 *
 * `transferIsWorthIt` is the rule for keeping 2 over 3 once real numbers exist (see the doc's
 * measurements): the round trip has to fit inside a tick with room to spare, and the envelope
 * overhead has to stay small against the work it moves off the main thread.
 */
import { BoatFleet, type FleetOptions } from './fleet';
import type { TransportKind, WorkerPort } from './transport';

export interface TransportCaps {
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  worker: boolean;
}

export function detectCaps(g: unknown = globalThis): TransportCaps {
  const o = g as { crossOriginIsolated?: boolean; SharedArrayBuffer?: unknown; Worker?: unknown };
  return {
    crossOriginIsolated: o.crossOriginIsolated === true,
    sharedArrayBuffer: typeof o.SharedArrayBuffer === 'function',
    worker: typeof o.Worker === 'function',
  };
}

export function chooseTransport(c: TransportCaps): TransportKind {
  if (c.crossOriginIsolated && c.sharedArrayBuffer && c.worker) return 'sab';
  if (c.worker) return 'transfer';
  return 'main';
}

/** the dev-console line for a page that did not get the default transport; null when it did */
export function transportWarning(kind: TransportKind, c: TransportCaps): string | null {
  if (kind === 'sab') return null;
  const why = !c.crossOriginIsolated
    ? 'page is not crossOriginIsolated (COOP/COEP missing — on GitHub Pages the COI shim did not take)'
    : 'SharedArrayBuffer unavailable';
  return kind === 'transfer'
    ? `[sim-worker] NPC physics on a worker via transferable buffers, not SharedArrayBuffer: ${why}. Full fidelity; ~one envelope per tick per worker.`
    : `[sim-worker] NPC physics on the MAIN THREAD (no Worker available): ${why}. Full fidelity; costs main-thread ms.`;
}

export interface RoundTripStats {
  /** kick → results home, ms */
  p95RoundTripMs: number;
  /** round trip minus the stepper's own step time, ms (postMessage/wake overhead) */
  p95OverheadMs: number;
}

/**
 * Keep the transferable worker over main-thread stepping iff its p95 round trip leaves at
 * least `slackMs` of a 60 Hz tick (so kick-at-frame-end / collect-next-frame almost never has
 * to wait) AND its p95 overhead is under `maxOverheadMs` (it is not "horribly slow" at the one
 * thing it adds). Thresholds are the doc's, from the node measurements; re-check in a browser.
 */
export function transferIsWorthIt(s: RoundTripStats, tickMs = 1000 / 60, slackMs = 4, maxOverheadMs = 2): boolean {
  return s.p95RoundTripMs <= tickMs - slackMs && s.p95OverheadMs <= maxOverheadMs;
}

/** the browser worker, adapted to the transport's port */
export function spawnBrowserSimWorker(): WorkerPort {
  const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'speedboat-sim' });
  return {
    post: (msg, transfer) => w.postMessage(msg, transfer ?? []),
    listen: (cb) => {
      w.onmessage = (e: MessageEvent) => cb(e.data);
      // a worker that fails to LOAD (e.g. a COEP-blocked script) never posts: surface it
      w.onerror = (e: ErrorEvent) => cb({ type: 'error', message: `worker load/runtime error: ${e.message}` });
    },
    terminate: () => w.terminate(),
  };
}

/** the page-side constructor: detect, choose, warn loudly when not on the default path */
export function createNpcFleet(opts: Omit<FleetOptions, 'kind' | 'spawn'>, caps: TransportCaps = detectCaps()): BoatFleet {
  const kind = chooseTransport(caps);
  const warning = transportWarning(kind, caps);
  if (warning) console.warn(warning);
  return new BoatFleet({ ...opts, kind, spawn: kind === 'main' ? undefined : spawnBrowserSimWorker });
}
