/**
 * §T.178 / §V109 / §V110 — sim-worker isolation, cross-origin isolation wiring, transport choice.
 *
 * WHY each block:
 *  - V109: the worker bundle is its own module graph on its own thread. If it reached main.ts,
 *    the raft, combat or AI, the worker would boot another mode's code (or a DOM-touching
 *    module that throws in a worker) — read as source, walked at every depth, like §B71.
 *  - COI: SharedArrayBuffer silently does not exist on a non-isolated page, so the headers and
 *    the Pages shim are the difference between the default path and the fallback. The shim must
 *    reach speedboat pages and the bundled worker scripts, and must NOT reach the pirate or raft
 *    page (a service worker on those is risk with no benefit).
 *  - Transport choice: the order is a user decision (SAB → transferable worker → main thread),
 *    and none of the three may carry a fidelity knob.
 */
import { describe, expect, it } from 'vitest';
import viteConfig from '../vite.config.ts?raw';
import indexHtml from '../index.html?raw';
import raftHtml from '../raft.html?raw';
import lookdevHtml from '../speedboat-lookdev.html?raw';
import coiSw from '../public/coi-sw.js?raw';
import coiRegister from '../public/coi-register.js?raw';
import { chooseTransport, transferIsWorthIt, transportWarning } from '../src/sim-worker/select';

const all = import.meta.glob('../src/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

function imports(src: string): string[] {
  return [...src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
}

function resolve(fromKey: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const parts = `${fromKey.replace(/\/[^/]+$/, '')}/${spec.replace(/\?.*$/, '')}`.split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '.' || p === '') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  const path = out.join('/');
  for (const cand of [path, `${path}.ts`, `${path}/index.ts`]) {
    const key = cand.startsWith('..') ? cand : `../${cand}`;
    if (key in all) return key;
  }
  return null;
}

describe('§V109 src/sim-worker reaches no pirate, raft, combat or AI module at any depth', () => {
  const roots = Object.keys(all).filter((k) => k.startsWith('../src/sim-worker/'));

  it('covers the whole directory (a file added later is walked without being listed)', () => {
    for (const f of ['layout', 'paramsVector', 'stepCore', 'transport', 'fleet', 'workerHost', 'worker', 'select']) {
      expect(roots).toContain(`../src/sim-worker/${f}.ts`);
    }
  });

  it('walks the import graph and finds none of main.ts, main-raft.ts, raft/, combat/, ai/', () => {
    const seen = new Set<string>(roots);
    const queue = [...roots];
    while (queue.length) {
      const key = queue.shift() as string;
      for (const spec of imports(all[key] ?? '')) {
        const next = resolve(key, spec);
        if (next && !seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    // the walk must have walked: the physics it steps is several directories away
    expect(seen).toContain('../src/sea-physics/cpuOcean.ts');
    expect(seen).toContain('../src/sea-physics/hullWater.ts');
    expect(seen).toContain('../src/speedboat/hullMesh.ts');
    const forbidden = [...seen].filter((k) => /\/src\/(main|main-raft)\.ts$|\/src\/(raft|combat|ai)\//.test(k));
    expect(forbidden).toEqual([]);
  });

  it('the step core exposes no fidelity option: every boat is `new HullWater(hull)` with the defaults (§V110)', () => {
    // code only: the docstrings quote `new HullWater(hull)` in prose
    const core = all['../src/sim-worker/stepCore.ts'].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const ctorCalls = [...core.matchAll(/new HullWater\(([^)]*)\)/g)].map((m) => m[1].trim());
    expect(ctorCalls.length).toBeGreaterThan(0);
    expect(ctorCalls).toEqual(ctorCalls.map(() => 'this.hull'));
    expect(core).toMatch(/planingSubsteps\(/);
  });
});

describe('cross-origin isolation wiring', () => {
  it('Vite dev AND preview send COOP same-origin + COEP require-corp', () => {
    expect(viteConfig).toMatch(/'Cross-Origin-Opener-Policy':\s*'same-origin'/);
    expect(viteConfig).toMatch(/'Cross-Origin-Embedder-Policy':\s*'require-corp'/);
    expect(viteConfig).toMatch(/server:\s*\{\s*headers:\s*CROSS_ORIGIN_ISOLATION\s*\}/);
    expect(viteConfig).toMatch(/preview:\s*\{\s*headers:\s*CROSS_ORIGIN_ISOLATION\s*\}/);
  });

  it('bundled workers are emitted inside the shim scope prefix `speedboat`', () => {
    expect(viteConfig).toMatch(/entryFileNames:\s*'speedboat-workers\//);
    expect(viteConfig).toMatch(/chunkFileNames:\s*'speedboat-workers\//);
    expect(all['../src/sim-worker/select.ts']).toMatch(/new Worker\(new URL\('\.\/worker\.ts', import\.meta\.url\)/);
  });

  it('the Pages shim is registered by the speedboat page only — never by the pirate or raft page', () => {
    const tag = /<script src="\.\/coi-register\.js"><\/script>/;
    expect(lookdevHtml).toMatch(tag);
    // classic script BEFORE the module, so the reload decision is taken before boot
    expect(lookdevHtml.search(tag)).toBeLessThan(lookdevHtml.indexOf('type="module"'));
    for (const [name, html] of [['index.html', indexHtml], ['raft.html', raftHtml]] as const) {
      expect(html, name).not.toMatch(/coi-register|coi-sw|serviceWorker/);
    }
    // no other module registers a service worker behind the pages' backs
    const registrars = Object.entries(all).filter(([, src]) => /serviceWorker\.register/.test(src)).map(([k]) => k);
    expect(registrars).toEqual([]);
  });

  it('the shim scopes itself to the speedboat prefix and rewrites only isolating responses', () => {
    expect(coiRegister).toMatch(/new URL\('speedboat', here\)\.pathname/);
    expect(coiRegister).toMatch(/register\(swUrl\.href, \{ scope \}\)/);
    expect(coiRegister).toMatch(/if \(window\.crossOriginIsolated\)/); // no-op where headers already isolate
    expect(coiRegister).toMatch(/storage\.get\(\)/); // one reload, never a loop
    expect(coiSw).toMatch(/'Cross-Origin-Embedder-Policy', 'require-corp'/);
    expect(coiSw).toMatch(/'Cross-Origin-Opener-Policy', 'same-origin'/);
    expect(coiSw).toMatch(/ISOLATING_DESTINATIONS = new Set\(\['document', 'iframe', 'worker', 'sharedworker'\]\)/);
  });

  it('no page or module pulls a cross-origin resource that require-corp would block (the audit, kept honest)', () => {
    const urlish = /(?:src|href)\s*=\s*["'](https?:)?\/\/|url\(\s*["']?https?:|fonts\.googleapis|cdn\.jsdelivr|unpkg\.com|cdnjs/;
    for (const [name, html] of [['index.html', indexHtml], ['raft.html', raftHtml], ['speedboat-lookdev.html', lookdevHtml]] as const) {
      expect(html, name).not.toMatch(urlish);
    }
    // network loads from code: only localhost CORS sinks (cine, wake preview), which COEP does not gate
    const remote = Object.entries(all)
      .flatMap(([k, src]) => [...src.matchAll(/['"`](https?:\/\/[^'"`/]+)/g)].map((m) => `${k} ${m[1]}`))
      .filter((s) => !/127\.0\.0\.1|www\.w3\.org/.test(s));
    expect(remote).toEqual([]);
  });
});

describe('transport choice (user order: SAB → transferable worker → main thread)', () => {
  it('picks SAB only when isolated with SAB and Worker; transferable when there is any Worker; main otherwise', () => {
    expect(chooseTransport({ crossOriginIsolated: true, sharedArrayBuffer: true, worker: true })).toBe('sab');
    expect(chooseTransport({ crossOriginIsolated: false, sharedArrayBuffer: true, worker: true })).toBe('transfer');
    expect(chooseTransport({ crossOriginIsolated: true, sharedArrayBuffer: false, worker: true })).toBe('transfer');
    expect(chooseTransport({ crossOriginIsolated: true, sharedArrayBuffer: true, worker: false })).toBe('main');
  });

  it('every non-default path warns, and says why', () => {
    expect(transportWarning('sab', { crossOriginIsolated: true, sharedArrayBuffer: true, worker: true })).toBeNull();
    expect(transportWarning('transfer', { crossOriginIsolated: false, sharedArrayBuffer: false, worker: true })).toMatch(/not crossOriginIsolated/);
    expect(transportWarning('main', { crossOriginIsolated: false, sharedArrayBuffer: false, worker: false })).toMatch(/MAIN THREAD/);
  });

  it('keeps the transferable worker only while its round trip fits a tick with slack and its overhead is small', () => {
    expect(transferIsWorthIt({ p95RoundTripMs: 6, p95OverheadMs: 0.3 })).toBe(true);
    expect(transferIsWorthIt({ p95RoundTripMs: 14, p95OverheadMs: 0.3 })).toBe(false); // would miss the next tick
    expect(transferIsWorthIt({ p95RoundTripMs: 6, p95OverheadMs: 3 })).toBe(false); // transport itself is the cost
  });
});
