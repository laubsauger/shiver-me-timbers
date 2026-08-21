/**
 * §V95: ONE IMPLEMENTATION PER UTILITY ACROSS MODES.
 *
 * WHY THIS TEST EXISTS, in the user's words: "some of these things shouldn't
 * be reinvented in both modes and then live duplicated and varied — that's
 * going to cause code rot." The pirate boot (`main.ts`), the raft boot
 * (`main-raft.ts`) and the preview harnesses had each grown their own copy of
 * the same handful of helpers — the compile walk was pasted verbatim, comment
 * and all, and the ship preview counted its own frames into its own div. A
 * copy is not shared code: it starts identical and drifts, and the drift is
 * invisible because both sides still "work".
 *
 * Read as source (`?raw`), not executed: these modules build a WebGPU scene,
 * so importing them here would be a GPU test. Two kinds of assertion:
 *
 *   1. NAMED: each helper is DEFINED in exactly one module, under
 *      `src/core` or `src/debug`. Everyone else reaches it by import.
 *   2. SHAPED: the body of a copied helper is searched for by its most
 *      distinctive line, so a paste that RENAMES the function is caught too —
 *      the rename is what a well-meaning copy actually looks like.
 *
 * A mode may still LEAVE A SYSTEM OUT (the raft has no combat; the harnesses
 * have no ocean) — §V95 forbids re-implementing one, not omitting one.
 */
import { describe, expect, it } from 'vitest';

const files = import.meta.glob('../src/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** '../src/core/quat.ts' → 'src/core/quat.ts' */
const rel = (k: string): string => k.replace(/^\.\.\//, '');

const entries = Object.entries(files).map(([k, v]) => [rel(k), v] as const);

/** a top-level definition of `name`: function, const arrow or const object */
function definers(name: string): string[] {
  const def = new RegExp(
    `(^|\\n)\\s*(export\\s+)?(async\\s+)?function\\s+${name}\\b|` +
      `(^|\\n)\\s*(export\\s+)?const\\s+${name}\\s*[:=]`,
  );
  return entries.filter(([, src]) => def.test(src)).map(([path]) => path);
}

/** files that mention `name` at all but do not define it — must import it */
function mentioners(name: string): string[] {
  const word = new RegExp(`\\b${name}\\b`);
  const defs = new Set(definers(name));
  return entries.filter(([p, src]) => !defs.has(p) && word.test(src)).map(([p]) => p);
}

/** the helpers §V95 names, and the ONE module each is allowed to live in */
const SHARED: Record<string, string> = {
  // the frustum-cull-off compile walk (was pasted into main-raft.ts verbatim)
  withFullCoverage: 'src/core/bootCompile.ts',
  // post warm-on-first-request, so a mid-session flip never compiles in-frame
  createPostWarmGate: 'src/core/bootCompile.ts',
  // §T.40's one-material-set-per-vessel-class cache
  createPieceMaterialCache: 'src/core/bootShared.ts',
  // the hoisted per-frame audio input both entries fill identically
  createShipAudioFeed: 'src/core/bootShared.ts',
  // settings → engine bindings
  bindResolution: 'src/core/bootSettings.ts',
  bindWorldSettings: 'src/core/bootSettings.ts',
  // boot splash hooks
  bootProgress: 'src/core/bootSplash.ts',
  bootReady: 'src/core/bootSplash.ts',
  showBootPhase: 'src/core/bootSplash.ts',
  afterSplashPaint: 'src/core/bootSplash.ts',
  finishSplashTitleEntrance: 'src/core/bootSplash.ts',
  atMost: 'src/core/bootSplash.ts',
  // quat helpers (§B71: they were copied into src/raft because the shared set
  // sat in src/combat, which §V81 keeps the raft out of — the module moved to
  // neutral ground instead)
  rotateVec: 'src/core/quat.ts',
  invRotateVec: 'src/core/quat.ts',
  quatMul: 'src/core/quat.ts',
  quatFromAxisAngle: 'src/core/quat.ts',
  quatFromEulerXYZ: 'src/core/quat.ts',
  // the perf HUD and its harness wrapper
  createPerfHud: 'src/debug/perfHud.ts',
  createHarnessHud: 'src/debug/harnessHud.ts',
};

describe('§V95 one implementation per utility across modes', () => {
  it('the glob actually covers both entries and the harnesses', () => {
    const paths = entries.map(([p]) => p);
    for (const p of [
      'src/main.ts',
      'src/main-raft.ts',
      'src/ship/preview.ts',
      'src/sky/preview.ts',
      'src/raft/raftShip.ts',
    ]) {
      expect(paths, `glob missed ${p}`).toContain(p);
    }
  });

  for (const [name, home] of Object.entries(SHARED)) {
    it(`${name} is defined once, in ${home}, and imported everywhere else`, () => {
      expect(definers(name), `${name} is defined in more than one module`).toEqual([home]);
      expect(home).toMatch(/^src\/(core|debug)\//);
      for (const user of mentioners(name)) {
        // a mention without an import is a redeclaration under another guise
        // an `export … from` re-export counts: it names the one definition
        expect(
          new RegExp(`(import|export)[^;]*\\b${name}\\b[^;]*from`).test(files[`../${user}`]),
          `${user} names ${name} without importing it`,
        ).toBe(true);
      }
    });
  }

  it('the compile walk exists as one body, not as a renamed paste', () => {
    // the restore step — the line no independent implementation writes twice
    const walk = entries.filter(([, s]) => s.includes('culled[i++]')).map(([p]) => p);
    expect(walk).toEqual(['src/core/bootCompile.ts']);
  });

  it("the Hamilton product exists as one body, not as a renamed paste", () => {
    const mul = entries.filter(([, s]) => s.includes('aw * bx + ax * bw')).map(([p]) => p);
    expect(mul).toEqual(['src/core/quat.ts']);
  });

  it('only the shared factory caches piece materials by kind:role', () => {
    const keyed = entries.filter(([, s]) => s.includes('`${kind}:${role}`')).map(([p]) => p).sort();
    // shipAssembly's map is a DIFFERENT layer: it memoises whatever factory it
    // was handed, per assembly. The factory itself — which decides hole vs base
    // and owns the deck-field texture — must exist exactly once.
    expect(keyed).toEqual(['src/core/bootShared.ts', 'src/ship/shipAssembly.ts']);
  });

  it('both entries reach the shared glue by import', () => {
    const main = files['../src/main.ts'];
    const raft = files['../src/main-raft.ts'];
    for (const src of [main, raft]) {
      expect(src).toMatch(/from '\.\/core\/bootCompile'/);
      expect(src).toMatch(/from '\.\/core\/bootSettings'/);
      expect(src).toMatch(/from '\.\/core\/bootSplash'/);
    }
    // and neither one re-declares what it just imported
    for (const src of [main, raft]) {
      expect(src).not.toMatch(/function withFullCoverage/);
      expect(src).not.toMatch(/settings\.subscribe\(applyResolution\)/);
    }
  });
});

describe('§V95 the harnesses use the game HUD, not a private one', () => {
  const preview = files['../src/ship/preview.ts'];

  it('ship/preview.ts owns no fps or frame-time bookkeeping of its own', () => {
    // the frame clock lives in debug/harnessHud.ts — one clock, one fps number,
    // comparable with the game's because it IS the game's
    // identifiers, not prose: the header may SAY fps, it may not COUNT it
    expect(preview).not.toMatch(/performance\.now\(\)/);
    expect(preview).not.toMatch(/frames\+\+/);
    expect(preview).not.toMatch(/fps`|fps \||toFixed\(0\)} fps/);
    expect(preview).not.toMatch(/getElementById\('hud'\)/);
    expect(preview).toMatch(/createHarnessHud/);
  });

  it('the preview page has no hand-rolled HUD element left behind', () => {
    // asserted on the page, because a stray #hud div would sit under the real
    // overlay and look like the HUD is stuck
    const html = previewHtml;
    expect(html).not.toMatch(/id="hud"/);
  });
});

// the harness page, read the same way
const previewHtml = (
  import.meta.glob('../src/ship/preview.html', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>
)['../src/ship/preview.html'];

describe('§B71/§V81 the raft carries no quaternion maths of its own', () => {
  const raftFiles = entries.filter(([p]) => p.startsWith('src/raft/'));

  it('covers the raft directory', () => {
    expect(raftFiles.length).toBeGreaterThanOrEqual(4);
  });

  for (const [path, src] of raftFiles) {
    it(`${path} defines no quat/vector helper`, () => {
      expect(src).not.toMatch(/function\s+(quat|rotateVec|invRotateVec)\w*/i);
      expect(src).not.toMatch(/aw \* bx/);
    });
  }
});
