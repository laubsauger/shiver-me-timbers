import { defineConfig } from 'vitest/config';

/**
 * §T.178 CROSS-ORIGIN ISOLATION for dev + preview: SharedArrayBuffer (speedboat NPC physics
 * on a worker, src/sim-worker) exists only on a `crossOriginIsolated` page.
 * COEP `require-corp`, not `credentialless`: Safari ships require-corp but not credentialless,
 * and every resource the three pages load is same-origin (audit in docs/speedboat/sim-worker.md),
 * so the strict policy costs nothing today and fails loud the day someone adds a CDN.
 * Applied to every page Vite serves — the pirate and raft pages load nothing cross-origin
 * either. GitHub Pages cannot send headers: there the COI service-worker shim
 * (public/coi-sw.js, registered only by speedboat pages) does this job.
 */
const CROSS_ORIGIN_ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: { headers: CROSS_ORIGIN_ISOLATION },
  preview: { headers: CROSS_ORIGIN_ISOLATION },
  build: {
    target: 'esnext',
    // two entries (§I raft/app, §V.81): the pirate sim and the raft share
    // modules and nothing else — `npm run dev` serves both
    rollupOptions: {
      input: { main: 'index.html', raft: 'raft.html', speedboat: 'speedboat.html', speedboatLookdev: 'speedboat-lookdev.html', speedboatAudioHarness: 'speedboat-audio-harness.html', speedboatUiHarness: 'speedboat-ui-harness.html', circuitPreview: 'circuit-preview.html', drift: 'drift.html' },
    },
  },
  // §T.178: bundled workers land under `speedboat-workers/`, i.e. inside the COI shim's scope
  // (`<base>/speedboat…`), so on GitHub Pages the worker script itself gets COEP too — a
  // require-corp page refuses a worker whose response lacks it. ES format: module workers.
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        entryFileNames: 'speedboat-workers/[name]-[hash].js',
        chunkFileNames: 'speedboat-workers/[name]-[hash].js',
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
