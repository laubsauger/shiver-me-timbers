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

  /**
   * §B71: the raw scan above only reads `src/main-raft.ts` + `src/raft/`, so a
   * forbidden module reached through a THIRD file was invisible to it — which
   * is exactly what happened: `sailing/raftBeaching.ts` imported
   * `combat/quatMath` for pure quaternion arithmetic, and the raft entry
   * therefore pulled `src/combat/` in transitively while every assertion above
   * stayed green. §T.113 moved that module to `src/core/quat.ts` (neutral
   * ground, §V95's one implementation); this walks the whole graph so the next
   * one cannot hide behind an intermediary either.
   */
  it('§B71 nothing the raft entry reaches, at any depth, lives in combat or ai', () => {
    const all = import.meta.glob('../src/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<
      string,
      string
    >;
    const resolve = (fromKey: string, spec: string): string | null => {
      if (!spec.startsWith('.')) return null; // three, vitest, bare deps
      const base = fromKey.replace(/\/[^/]+$/, '');
      const parts = `${base}/${spec}`.split('/');
      const out: string[] = [];
      for (const part of parts) {
        if (part === '.' || part === '') continue;
        if (part === '..') out.pop();
        else out.push(part);
      }
      const path = out.join('/');
      for (const cand of [`${path}.ts`, `${path}/index.ts`]) {
        // the glob keys are '../src/…'; rebuild that prefix
        const key = cand.startsWith('..') ? cand : `../${cand}`;
        if (key in all) return key;
      }
      return null;
    };
    const seen = new Set<string>(['../src/main-raft.ts']);
    const queue = ['../src/main-raft.ts'];
    while (queue.length > 0) {
      const key = queue.shift() as string;
      const src = key === '../src/main-raft.ts' ? mainRaft : all[key];
      if (src === undefined) continue;
      for (const spec of imports(src)) {
        const next = resolve(key, spec);
        if (next === null || seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    // the walk has to have actually walked — a resolver that resolves nothing
    // would pass this test by visiting one file
    expect(seen.size).toBeGreaterThan(60);
    expect(seen).toContain('../src/sailing/raftBeaching.ts'); // §B71's bridge
    expect(seen).toContain('../src/core/quat.ts'); // where the helpers live now
    const forbidden = [...seen].filter((k) => /\/(combat|ai)\//.test(k)).sort();
    /**
     * A SECOND LEAK OF §B71's SHAPE, and this test is what found it.
     *
     * `camera/followCam.ts` needs `STATION_IDS`, so it imports
     * `camera/camStations.ts`, which builds the GUN stations out of
     * `combat/battery` + `combat/aim`. The raft has no guns and never calls
     * those stations — but its module graph contains them, which is precisely
     * what §V81 says it must not, and it is invisible to the raw scans above
     * because the route runs through `src/camera/`.
     *
     * Recorded rather than fixed: `src/camera/` is not §T.113's to reshape
     * (splitting the station ids from the battery geometry is its own task).
     * The list is a RATCHET — it must shrink to `[]` when camStations stops
     * reaching for the battery, and a new route makes this test red the day it
     * lands rather than at the next audit.
     */
    const KNOWN_LEAK = [
      '../src/combat/aim.ts',
      '../src/combat/ballistics.ts',
      '../src/combat/battery.ts',
      '../src/combat/pieceFrame.ts',
    ];
    expect(forbidden, `raft reaches ${forbidden.join(', ')}`).toEqual(KNOWN_LEAK);
    // and it reaches them by exactly ONE route: any second bridge is a new bug
    const bridges = [...seen]
      .filter((k) => !/\/(combat|ai)\//.test(k))
      .filter((k) => {
        const src = k === '../src/main-raft.ts' ? mainRaft : all[k];
        return src !== undefined && imports(src).some((spec) => {
          const r = resolve(k, spec);
          return r !== null && /\/(combat|ai)\//.test(r);
        });
      });
    expect(bridges).toEqual(['../src/camera/camStations.ts']);
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
  it('§V93: one vessel — the entry pushes exactly one ship and never an enemy/AI', () => {
    // createInitialState seeds an empty ships[]; the raft boot pushes the raft and nothing else.
    const pushes = (mainRaft.match(/state\.ships\.push\(/g) ?? []).length;
    expect(pushes).toBe(1);
    for (const src of [mainRaft, ...Object.values(raftDir)]) {
      // identifiers, not prose: the header comment may SAY 'no enemy'
      expect(src).not.toMatch(/\b(buildBrigantineBlueprint|buildGalleonBlueprint|createCombatArena|createShipAi|enemyBlueprint)\b/);
      expect(imports(src).some((p) => /enemy|\/ai\b/.test(p))).toBe(false);
    }
  });

});
