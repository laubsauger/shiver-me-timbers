/**
 * Node harness for the sim-worker tests (§T.178): builds `src/sim-worker/workerHost.ts` with
 * Vite (the same `?raw` / TS handling the browser bundle gets) and spawns it on REAL
 * `worker_threads` threads, adapted to the transport's `WorkerPort`. Not a test file itself.
 *
 * Node built-ins are imported through a non-literal specifier on purpose: this project has no
 * `@types/node` in its tsconfig `types`, and a literal `import 'node:worker_threads'` would take
 * `tsc --noEmit` (and so the Pages build) down, as the zzScratch harnesses once did.
 */
import { build } from 'vite';
import type { SimMessage, WorkerPort } from '../src/sim-worker/transport';

const ROOT = new URL('..', import.meta.url).pathname;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function nodeModule(name: string): Promise<any> {
  return import(/* @vite-ignore */ name);
}

/** bundle the worker host once per `label`; returns its file URL */
export async function buildWorkerBundle(label: string): Promise<string> {
  const outDir = `${ROOT}node_modules/.cache/sim-worker-test/${label}`;
  await build({
    configFile: false,
    root: ROOT,
    logLevel: 'silent',
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      target: 'esnext',
      lib: { entry: `${ROOT}src/sim-worker/workerHost.ts`, formats: ['es'], fileName: () => 'workerHost.mjs' },
      // resolved from the repo's node_modules at run time (the bundle lives under it)
      rollupOptions: { external: [/^three(\/|$)/] },
    },
  });
  return `file://${outDir}/workerHost.mjs`;
}

/** a spawner of real threads running the bundle */
export async function nodeSpawner(bundleUrl: string): Promise<() => WorkerPort> {
  const { Worker } = await nodeModule('node:worker_threads');
  const code =
    `const { parentPort } = require('node:worker_threads');` +
    `import(${JSON.stringify(bundleUrl)}).then((m) => m.runSimWorker({` +
    `post: (msg, t) => parentPort.postMessage(msg, t || []),` +
    `listen: (cb) => parentPort.on('message', cb) }))` +
    `.catch((e) => parentPort.postMessage({ type: 'error', message: String(e && e.stack || e) }));`;
  return () => {
    const w = new Worker(code, { eval: true });
    return {
      post: (msg: SimMessage, transfer?: Transferable[]) => w.postMessage(msg, transfer ?? []),
      listen: (cb: (m: SimMessage) => void) => {
        w.on('message', cb);
        w.on('error', (e: unknown) => cb({ type: 'error', message: `worker thread error: ${String(e)}` }));
      },
      terminate: () => void w.terminate(),
    };
  };
}
