/**
 * §V.81: RAFT 2100 ⊥ TOUCHES PIRATE BOOT. The raft entry is a second page
 * that shares modules with the pirate sim and imports NOTHING from its boot,
 * its combat or its AI. Read as source (`?raw`), not executed: the modules
 * under test build a WebGPU scene and a test that imported them would be a
 * GPU test. The glob is the whole of `src/raft/` so a file added later is
 * covered without anyone remembering to list it (§V.62's shape, inverted).
 */
import { describe, expect, it } from 'vitest';
import mainRaft from '../src/main-raft.ts?raw';
import viteConfig from '../vite.config.ts?raw';
import raftHtml from '../raft.html?raw';
import indexHtml from '../index.html?raw';

const raftDir = import.meta.glob('../src/raft/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>;

const FORBIDDEN: RegExp[] = [
  /from\s+['"][^'"]*\/main(\.ts)?['"]/, // src/main.ts, by any relative path
  /from\s+['"]\.\/combat/,
  /from\s+['"]\.\.\/combat/,
  /from\s+['"]\.\/ai/,
  /from\s+['"]\.\.\/ai/,
  /combatArena/,
  /projectile/i,
];

function imports(src: string): string[] {
  return [...src.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
}

describe('§V81 the raft entry never reaches into the pirate boot', () => {
  const files: Record<string, string> = { 'src/main-raft.ts': mainRaft, ...raftDir };

  it('covers the entry and every module under src/raft/', () => {
    expect(Object.keys(raftDir).length).toBeGreaterThanOrEqual(4);
    expect(Object.keys(raftDir).some((k) => k.endsWith('raftWorld.ts'))).toBe(true);
    expect(Object.keys(raftDir).some((k) => k.endsWith('raftShip.ts'))).toBe(true);
    expect(Object.keys(raftDir).some((k) => k.endsWith('raftActions.ts'))).toBe(true);
  });

  for (const [name, src] of Object.entries(files)) {
    it(`${name} imports no main.ts, combat, ai, arena or projectile module`, () => {
      for (const re of FORBIDDEN) expect(src, `${name} matches ${re}`).not.toMatch(re);
      for (const spec of imports(src)) {
        expect(spec, `${name} imports ${spec}`).not.toMatch(/(^|\/)main$|(^|\/)main\.ts$|\/combat(\/|$)|\/ai(\/|$)/);
      }
    });
  }

  it('the entry is boot only: at most 300 lines (§T.98)', () => {
    expect(mainRaft.split('\n').length).toBeLessThanOrEqual(300);
  });

  it('vite builds BOTH entries (§I raft/app)', () => {
    expect(viteConfig).toMatch(/rollupOptions/);
    expect(viteConfig).toMatch(/main:\s*['"]index\.html['"]/);
    expect(viteConfig).toMatch(/raft:\s*['"]raft\.html['"]/);
  });

  it('raft.html boots main-raft.ts and index.html still boots main.ts', () => {
    expect(raftHtml).toMatch(/<script type="module" src="\/src\/main-raft\.ts"><\/script>/);
    expect(raftHtml).not.toMatch(/src="\/src\/main\.ts"/);
    expect(indexHtml).toMatch(/<script type="module" src="\/src\/main\.ts"><\/script>/);
  });

  it('owns the caustics/deck-water singletons itself rather than borrowing them (§I raft/app)', () => {
    const all = Object.values(files).join('\n');
    expect(all).toMatch(/setActiveCaustics\(/);
    expect(all).toMatch(/setActiveDeckWater\(/);
  });
});
