/**
 * §V109 SPEEDBOAT ISOLATION (§T.181). The speedboat page is a THIRD entry that shares modules
 * with pirate and raft and imports nothing from their boots, the raft's own directory, combat or
 * AI — at ANY depth. Why transitive: §B71 showed a raw scan of the entry and its own directory
 * misses a forbidden module reached through a third file (the raft pulled `combat/` in through
 * `sailing/`), so this walks the whole graph from `src/main-speedboat.ts` AND from every module
 * under `src/speedboat/` (a file added later is covered without anyone listing it).
 *
 * Read as `?raw` source, never executed: these modules build a WebGPU scene.
 *
 * The resolver extends tests/raftIsolation.test.ts's: it also follows `export … from` re-exports
 * and bare side-effect imports, and strips `?raw`/`?url` query suffixes — the raft walk's
 * `import … from` regex would step over a barrel's re-exports, which is where this graph's
 * breadth lives (`camera/index.ts`, `speedboat/assets/index.ts`).
 */
import { describe, expect, it } from 'vitest';
import mainSpeedboat from '../src/main-speedboat.ts?raw';
import speedboatHtml from '../speedboat.html?raw';
import viteConfig from '../vite.config.ts?raw';

const all = import.meta.glob('../src/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const ENTRY = '../src/main-speedboat.ts';

function imports(src: string): string[] {
  const from = [...src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  const bare = [...src.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  const dynamic = [...src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  return [...from, ...bare, ...dynamic];
}

const resolve = (fromKey: string, spec: string): string | null => {
  if (!spec.startsWith('.')) return null; // three, vitest, bare deps
  const base = fromKey.replace(/\/[^/]+$/, '');
  const out: string[] = [];
  for (const part of `${base}/${spec.replace(/\?.*$/, '')}`.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  const path = out.join('/');
  for (const cand of [path, `${path}.ts`, `${path}/index.ts`]) {
    const key = cand.startsWith('..') ? cand : `../${cand}`;
    if (key in all) return key;
  }
  return null;
};

function walk(roots: string[]): Set<string> {
  const seen = new Set<string>(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const key = queue.shift() as string;
    const src = key === ENTRY ? mainSpeedboat : all[key];
    for (const spec of imports(src ?? '')) {
      const next = resolve(key, spec);
      if (next === null || seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

const FORBIDDEN = /\/src\/main\.ts$|\/src\/main-raft\.ts$|\/src\/raft\/|\/src\/combat\/|\/src\/ai\//;
const speedboatDir = Object.keys(all).filter((k) => k.startsWith('../src/speedboat/'));

/**
 * THE §V81 RATCHET, SHARED (tests/raftIsolation.test.ts KNOWN_LEAK). `camera/followCam.ts` needs
 * `STATION_IDS`, so it imports `camera/camStations.ts`, which builds the pirate GUN stations out
 * of `combat/battery` + `combat/aim`. The speedboat's stub chase camera is that FollowCam (§T.182
 * replaces it), so it inherits the same leak by the same single route. The list may only SHRINK:
 * a new forbidden module, or a second bridge into one, turns this red the day it lands.
 */
const KNOWN_LEAK = ['../src/combat/aim.ts', '../src/combat/ballistics.ts', '../src/combat/battery.ts', '../src/combat/pieceFrame.ts'];
const KNOWN_BRIDGES = ['../src/camera/camStations.ts'];

describe('§V109 the speedboat page never reaches pirate or raft boot, raft/, combat/ or ai/', () => {
  const seen = walk([ENTRY, ...speedboatDir]);

  it('covers the entry, the page modules and the asset runtime (a file added later is walked unlisted)', () => {
    for (const f of ['seams', 'controls', 'playerBoat', 'npcFleet', 'speedboatScene', 'speedboatFrame', 'course', 'seaParams', 'stubs']) {
      expect(speedboatDir, `src/speedboat/page/${f}.ts`).toContain(`../src/speedboat/page/${f}.ts`);
    }
    expect(speedboatDir).toContain('../src/speedboat/assets/boatModel.ts');
    expect(speedboatDir).toContain('../src/speedboat/hullMesh.ts');
  });

  it('the walk actually walked: the shared systems several directories away are in the graph', () => {
    expect(seen.size).toBeGreaterThan(80);
    for (const k of [
      '../src/core/seaScene.ts',
      '../src/sea-physics/hullWater.ts',
      '../src/sea-physics/rigidBody.ts',
      '../src/sim-worker/select.ts',
      '../src/sim-worker/stepCore.ts',
      '../src/wake/wakeSim.ts',
      '../src/wake/propWashHullWater.ts',
      '../src/flowfoam/index.ts',
      '../src/speedboat/assets/boatModel.ts',
      '../src/camera/followCam.ts',
    ]) {
      expect(seen, k).toContain(k);
    }
  });

  it('nothing reached, at any depth, is main.ts, main-raft.ts, raft/, combat/ or ai/ (beyond the shared ratchet)', () => {
    const forbidden = [...seen].filter((k) => FORBIDDEN.test(k)).sort();
    expect(forbidden, `speedboat reaches ${forbidden.join(', ')}`).toEqual(KNOWN_LEAK);
    const bridges = [...seen]
      .filter((k) => !FORBIDDEN.test(k))
      .filter((k) => imports((k === ENTRY ? mainSpeedboat : all[k]) ?? '').some((spec) => {
        const r = resolve(k, spec);
        return r !== null && FORBIDDEN.test(r);
      }))
      .sort();
    expect(bridges).toEqual(KNOWN_BRIDGES);
  });

  it('the entry and every page module name no forbidden import directly (raw scan, §V81 shape)', () => {
    for (const key of [ENTRY, ...speedboatDir]) {
      const src = key === ENTRY ? mainSpeedboat : all[key];
      for (const spec of imports(src)) {
        // resolved, not a bare path match: `race/ai/` (the §T.186 rival pilots) is not the pirate `src/ai/`
        const r = resolve(key, spec);
        if (r !== null) expect(r, `${key} imports ${spec}`).not.toMatch(FORBIDDEN);
        else expect(spec, `${key} imports ${spec}`).not.toMatch(/(^|\/)main(\.ts)?$|(^|\/)main-raft(\.ts)?$/);
      }
    }
  });

  it('the entry is boot only: at most 300 lines (§T.181)', () => {
    expect(mainSpeedboat.split('\n').length).toBeLessThanOrEqual(300);
  });

  it('vite builds the speedboat entry beside pirate and raft', () => {
    expect(viteConfig).toMatch(/speedboat:\s*['"]speedboat\.html['"]/);
    expect(viteConfig).toMatch(/main:\s*['"]index\.html['"]/);
    expect(viteConfig).toMatch(/raft:\s*['"]raft\.html['"]/);
  });

  it('speedboat.html boots main-speedboat.ts, loads the COI shim BEFORE it, and sits inside the shim scope', () => {
    // the shim may reload the page once: it has to run before the module starts building anything
    const shim = speedboatHtml.indexOf('<script src="./coi-register.js"></script>');
    const entry = speedboatHtml.indexOf('<script type="module" src="/src/main-speedboat.ts"></script>');
    expect(shim).toBeGreaterThan(-1);
    expect(entry).toBeGreaterThan(shim);
    expect(speedboatHtml).not.toMatch(/src="\/src\/main(-raft)?\.ts"/);
    // coi-register.js registers scope `new URL('speedboat', here)` — a URL PREFIX; this page's name must start with it
    expect('speedboat.html'.startsWith('speedboat')).toBe(true);
    // the splash contract core/bootSplash.ts talks to
    expect(speedboatHtml).toMatch(/window\.__bootReady\s*=/);
    expect(speedboatHtml).toMatch(/window\.__bootProgress\s*=/);
  });
});
