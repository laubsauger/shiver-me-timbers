/**
 * The Drift's adapter for the studio farm package (farm/: drift.adapter.mjs, hub-hooks.mjs, submit.mjs, types/*.json).
 * drift-dash mounts the package's hub with these, the boxes run the package's worker with them, and drift-slot.mjs
 * --farm sends its commands through farm/submit.mjs. What must hold, or the farm does something else than asked:
 *   - THE HUB'S HOOKS name every command's kind and speed class as the Drift's own hub did (its values, fixed here
 *     when that hub left this repo): speeds.json is keyed by the class (a different one starts the learned speeds
 *     over and sends a clip to the slower box), and the kind decides who gets what.
 *   - THE WORKER'S HOOKS read progress from a job's lines — a clip's frames, a stills run's "still k/N" (the console's
 *     "k/N" and ETA) — and use the same VRAM rule as drift-share.mjs.
 *   - A COMMAND IS TYPED ONLY WHEN THE TYPES SAY IT EXACTLY (typedJobOf): every flag on the type's list, or no typed
 *     job at all — a flag no type takes (--port, --shot-file) or an unknown script makes it a legacy-argv job, never a
 *     typed job with that flag silently dropped.
 *   - THE TYPES name farm/drift.adapter.mjs as their hooks, resolved inside a job's own tree; and they load in the
 *     package (when the sibling checkout is here: a fresh clone of this public repo has none, and skips that one).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as adapter from '../farm/drift.adapter.mjs';
import * as hubHooks from '../farm/hub-hooks.mjs';
import { needVramGB, YIELD_DEFAULTS } from '../scripts/drift-share.mjs';

const ROOT = join(__dirname, '..');
const STUDIO_FARM = resolve(ROOT, process.env.STUDIO_FARM_DIR ?? '../studio-farm');

// the commands the farm has taken (out/drift/farm/jobs, 2026-10-30 to 11-02), as drift-slot.mjs --farm sends them, with
// the kind and class the Drift's own hub gave them, and the typed job each becomes (null: it goes as legacy-argv)
const COMMANDS: [string[], string, string, string | null][] = [
  [['node', 'drift-review-stills.mjs', 'shots.json', '--width', '1280', '--out', 'c'], 'still', 'drift-review-stills.mjs:1280', 'drift-review-stills@1'],
  [['node', 'drift-review-stills.mjs', 'ld1.json', '--width', '640', '--query', 'linedown&powerline', '--out', 'linedown_r1'], 'still', 'drift-review-stills.mjs:640', 'drift-review-stills@1'],
  [['node', 'scripts/drift-stills.mjs', '745.8', '4096', '--channel', 'chrome'], 'still', 'drift-stills.mjs:4096', null],
  [['node', 'drift-review-clip.mjs', '--from', '0', '--to', '86', '--width', '1920', '--allow-long', '--allow-large', '--flat-track', '--out', 'act1.mp4'], 'clip', 'drift-review-clip.mjs:1920', 'drift-review-clip@1'],
  [['node', 'drift-review-clip.mjs', '--from', '31', '--to', '50', '--dome', '--width', '2048', '--allow-large', '--out', 'wave.mp4'], 'clip', 'drift-review-clip.mjs:2048', 'drift-review-clip@1'],
  [['node', 'scripts/drift-render.mjs', '--size', '4096', '--fps', '30', '--from', '0', '--to', '20', '--channel', 'chrome', '--out', 'chunk.mp4'], 'long', 'drift-render.mjs:4096', 'drift-render@1'],
  [['node', 'scripts/drift-queue.mjs', 'render-queue.jsonc'], 'long', 'drift-queue.mjs:-', null],
  [['node', 'scripts/drift-node.mjs', 'render', '--preset', 'dome2048'], 'long', 'drift-node.mjs:-', null],
  [['node', 'scripts/cine-bench.mjs'], 'clip', 'cine-bench.mjs:-', null],
];

describe('the hub\'s hooks keep the Drift hub\'s kinds and classes (speeds.json keeps its classes)', () => {
  it('the same kind and speed class for every command the farm has taken', () => {
    for (const [argv, kind, cls] of COMMANDS) {
      expect(hubHooks.jobKind(argv), argv.join(' ')).toBe(kind);
      expect(hubHooks.jobClass(argv), argv.join(' ')).toBe(cls);
    }
  });
});

describe('the worker\'s hooks', () => {
  it('progress from a clip\'s frames, and a stills run\'s "still k/N" with its ETA (the console\'s k/N)', () => {
    expect(adapter.progress('[review] 120/360  3.0 fps')).toEqual({ done: 120, total: 360, unit: 'frames', fps: 3, etaS: 80 });
    expect(adapter.progress('[render] 9/600  0.0 fps')).toEqual({ done: 9, total: 600, unit: 'frames', fps: 0, etaS: null });
    expect(adapter.progress('[review] still 2/5  58323 ms')).toMatchObject({ done: 2, total: 5, unit: 'stills', etaS: 175 });
    // (a stills run from before "still k/N": one more per still written; other lines change nothing)
    let p = adapter.progress('[review] tower_745.8.png  t 745.8');
    p = adapter.progress('[review] deck.jpg  t 12', p);
    expect(p).toMatchObject({ done: 2, unit: 'stills' });
    expect(adapter.progress('boot: shader cache: warm', p)).toEqual(p);
  });
  it('the warm Vite caches, and the same VRAM need as drift-share.mjs: 22 GB a lane at 8192², else 10, the box\'s own figure first', () => {
    expect(adapter.VITE_CACHES).toEqual(['.vite-drift-render', '.vite-drift-review-stills', '.vite-drift-review-clip', '.vite-drift-check', '.vite-drift-node', '.vite-drift-stills']);
    const cases: [{ size?: number; lanes?: number } | null, number | null][] = [[{ size: 2048, lanes: 1 }, null], [{ size: 8192, lanes: 2 }, null], [{ size: 4096, lanes: 2 }, 14], [null, null]];
    for (const [job, need] of cases) {
      const policy = { ...YIELD_DEFAULTS, needVramGB: need };
      expect(adapter.needVramGB(job, { needVramGB: need ?? undefined }), JSON.stringify([job, need])).toBe(needVramGB(job, policy));
    }
  });
});

describe('typed only when the types say the command exactly', () => {
  it('each command the farm has taken: its type, or legacy-argv', () => {
    for (const [argv, , , type] of COMMANDS) expect(adapter.typedJobOf(argv, { cwd: ROOT })?.spec.type ?? null, argv.join(' ')).toBe(type);
  });
  it('a flag no type takes makes the whole command legacy, never a typed job without it', () => {
    expect(adapter.typedJobOf(['node', 'drift-review-stills.mjs', 's.json', '--width', '960', '--port', '5382', '--out', 'o'], { cwd: ROOT })).toBeNull();
    expect(adapter.typedJobOf(['node', 'drift-review-clip.mjs', '--from', '1', '--to', '2', '--shot-file', 'v.json', '--out', 'c.mp4'], { cwd: ROOT })).toBeNull();
    expect(adapter.typedJobOf(['node', 'scripts/drift-render.mjs', '--from', '0', '--to', '2', '--channel', 'chromium', '--out', 'c.mp4'], { cwd: ROOT })).toBeNull();
    // (the render's extra flags travel only on its allowlist, each typed)
    const t = adapter.typedJobOf(['node', 'scripts/drift-render.mjs', '--size', '2048', '--from', '0', '--to', '2', '--channel', 'chrome', '--crf', '18', '--query', 'biolum=1', '--out', 'c.mp4'], { cwd: ROOT });
    expect(t?.spec.params).toMatchObject({ size: 2048, from: 0, to: 2, extra: { '--crf': 18, '--query': 'biolum=1' } });
  });
  it('the outputs land where the command said: a clip at its file, stills in their folder', () => {
    const clip = adapter.typedJobOf(['node', 'scripts/drift-review-clip.mjs', '--from', '1', '--to', '2', '--out', 'out/x/c.mp4'], { cwd: ROOT });
    expect(clip?.land).toEqual({ clip: { file: join(ROOT, 'out/x/c.mp4') } });
    const stills = adapter.typedJobOf(['node', 'scripts/drift-review-stills.mjs', 'shots.json', '--out', 'out/x/s'], { cwd: ROOT });
    expect(stills?.land).toEqual({ stills: join(ROOT, 'out/x/s') });
    expect(stills?.inputs).toEqual({ shots: join(ROOT, 'shots.json') });
  });
});

describe('the types', () => {
  it('name farm/drift.adapter.mjs as their hooks, a path inside the job\'s tree that is there', () => {
    const files = ['drift-render.json', 'drift-review-clip.json', 'drift-review-stills.json'];
    for (const f of files) {
      const text = readFileSync(join(ROOT, 'farm/types', f), 'utf8');
      expect(text, f).toMatch(/"hooks": "farm\/drift\.adapter\.mjs"/);
    }
    expect(existsSync(join(ROOT, 'farm/drift.adapter.mjs'))).toBe(true);
  });
  it.skipIf(!existsSync(join(STUDIO_FARM, 'src/types.mjs')))('load in the studio farm package as drift-render@1, drift-review-clip@1, drift-review-stills@1', async () => {
    const { loadTypes, createRegistry } = await import(pathToFileURL(join(STUDIO_FARM, 'src/types.mjs')).href);
    const reg = createRegistry(await loadTypes(['farm/types'], { base: ROOT }));
    // (legacy-argv@1 is built in only with an older studio-farm; now its Drift compat module registers it, on the hub)
    expect(reg.keys().filter((k: string) => k !== 'legacy-argv@1').sort()).toEqual(['drift-render@1', 'drift-review-clip@1', 'drift-review-stills@1']);
  });
});
