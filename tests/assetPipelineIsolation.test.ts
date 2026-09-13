/**
 * §V109 for the speedboat ASSET runtime and its lookdev page: nothing they reach, at any depth,
 * lives in main.ts, main-raft.ts, raft/, combat/ or ai/. A loader that dragged the pirate boot or
 * the raft in behind it would hand the speedboat page another mode's module graph — the §B71
 * shape (tests/raftIsolation.test.ts), which only a transitive walk catches. Read as `?raw`
 * source: these modules build GPU materials and must not execute here.
 */
import { describe, expect, it } from 'vitest';
import viteConfig from '../vite.config.ts?raw';
import lookdevHtml from '../speedboat-lookdev.html?raw';

const all = import.meta.glob('../src/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const assetsDir = Object.keys(all).filter((k) => k.startsWith('../src/speedboat/assets/'));

function imports(src: string): string[] {
  return [...src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
}

const resolve = (fromKey: string, spec: string): string | null => {
  if (!spec.startsWith('.')) return null;
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
    for (const spec of imports(all[key] ?? '')) {
      const next = resolve(key, spec);
      if (next === null || seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

const FORBIDDEN = /\/src\/main\.ts$|\/src\/main-raft\.ts$|\/src\/raft\/|\/src\/combat\/|\/src\/ai\//;

describe('§V109 speedboat asset runtime + lookdev isolation', () => {
  it('covers the asset modules and the lookdev entry', () => {
    for (const f of ['contract.ts', 'slotMaterials.ts', 'boatModel.ts', 'index.ts']) {
      expect(assetsDir, `src/speedboat/assets/${f}`).toContain(`../src/speedboat/assets/${f}`);
    }
    expect('../src/speedboat/lookdev.ts' in all).toBe(true);
  });

  it('src/speedboat/assets/* reaches no main/raft/combat/ai module at any depth', () => {
    const seen = walk(assetsDir);
    // the walk must actually walk: the runtime reaches caustics → ocean → params
    expect(seen).toContain('../src/caustics/index.ts');
    expect(seen).toContain('../src/flowfoam/accumulation.ts');
    expect([...seen].filter((k) => FORBIDDEN.test(k)).sort()).toEqual([]);
  });

  it('the lookdev page reaches none either (it builds the shared sea, not the raft sea)', () => {
    const seen = walk(['../src/speedboat/lookdev.ts']);
    expect(seen).toContain('../src/core/seaScene.ts');
    expect(seen.size).toBeGreaterThan(60);
    expect([...seen].filter((k) => FORBIDDEN.test(k)).sort()).toEqual([]);
  });

  it('vite builds the lookdev entry, and its html boots lookdev.ts', () => {
    expect(viteConfig).toMatch(/speedboatLookdev:\s*['"]speedboat-lookdev\.html['"]/);
    expect(lookdevHtml).toMatch(/<script type="module" src="\/src\/speedboat\/lookdev\.ts"><\/script>/);
  });
});
