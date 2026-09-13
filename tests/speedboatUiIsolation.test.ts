/**
 * §V109 for the speedboat UI: src/speedboat/ui reaches no pirate boot, raft, combat or AI module,
 * at any depth. And stronger, because the HUD is a pure overlay the page drives: it reaches nothing
 * outside its own directory except the race contract types (src/race/types.ts) and its self-hosted
 * fonts. In particular not three.js (a DOM overlay has no business pulling the renderer into the
 * harness) and not the pirate UI in src/ui (a different visual language, §T.185).
 *
 * WHY walked transitively: §B71 was a forbidden module reached through a third file while the
 * one-level scan stayed green.
 */
import { describe, expect, it } from 'vitest';

const all = import.meta.glob('../src/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

function imports(src: string): string[] {
  return [...src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
}

function resolve(fromKey: string, spec: string): string | null {
  const bare = spec.replace(/\?.*$/, '');
  const parts = `${fromKey.replace(/\/[^/]+$/, '')}/${bare}`.split('/');
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
  return `../${path}`; // non-TS asset (fonts) or unresolved
}

describe('§V109 src/speedboat/ui isolation', () => {
  const roots = Object.keys(all).filter((k) => k.startsWith('../src/speedboat/ui/'));

  it('covers the whole directory', () => {
    for (const f of ['model.ts', 'raceHud.ts', 'gauges.ts', 'pause.ts', 'results.ts', 'boatSelect.ts', 'harness.ts', 'dash.ts']) {
      expect(roots, f).toContain(`../src/speedboat/ui/${f}`);
    }
  });

  it('reaches only its own directory, the race contract types and its fonts, at any depth', () => {
    const seen = new Set<string>(roots);
    const queue = [...roots];
    const bare: string[] = [];
    while (queue.length > 0) {
      const key = queue.shift() as string;
      const src = all[key];
      if (src === undefined) continue;
      for (const spec of imports(src)) {
        if (!spec.startsWith('.')) {
          bare.push(`${key} → ${spec}`);
          continue;
        }
        const next = resolve(key, spec);
        if (next === null || seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    expect(bare, 'bare package imports (three, tweakpane, …)').toEqual([]);
    const outside = [...seen].filter((k) => !k.startsWith('../src/speedboat/ui/')).sort();
    expect(outside).toEqual([
      '../assets/fonts/speedboat/SairaCondensed-Bold.woff2',
      '../assets/fonts/speedboat/SairaCondensed-SemiBold.woff2',
      '../assets/fonts/speedboat/SairaStencilOne-Regular.woff2',
      '../src/race/types.ts',
    ]);
    for (const k of seen) {
      expect(k).not.toMatch(/\/main(-raft)?\.ts$|\/src\/raft\/|\/combat\/|\/ai\/|\/src\/ui\//);
    }
  });

  it('every font it ships is present with its licence next to it (COEP: same-origin only)', async () => {
    const fonts = import.meta.glob('../assets/fonts/speedboat/*', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
    const names = Object.keys(fonts).map((k) => k.split('/').pop());
    expect(names).toEqual(expect.arrayContaining(['SairaStencilOne-Regular.woff2', 'SairaCondensed-SemiBold.woff2', 'SairaCondensed-Bold.woff2', 'OFL-SairaStencilOne.txt', 'OFL-SairaCondensed.txt']));
    const ofl = import.meta.glob('../assets/fonts/speedboat/OFL-*.txt', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    for (const [k, text] of Object.entries(ofl)) expect(text, k).toMatch(/SIL Open Font License, Version 1\.1/);
  });
});
