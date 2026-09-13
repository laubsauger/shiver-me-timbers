/**
 * Browser dedicated-worker entry for speedboat physics (§T.178). Spawned by `select.ts` as
 * `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`, which Vite
 * bundles to `speedboat-workers/` (vite.config.ts `worker`) — inside the COI shim's scope.
 */
import { runSimWorker } from './workerHost';
import type { SimMessage } from './transport';

interface WorkerScope {
  postMessage(msg: unknown, transfer: Transferable[]): void;
  onmessage: ((e: { data: SimMessage }) => void) | null;
}

const scope = globalThis as unknown as WorkerScope;

runSimWorker({
  post: (msg, transfer) => scope.postMessage(msg, transfer ?? []),
  listen: (cb) => {
    scope.onmessage = (e) => cb(e.data);
  },
});
