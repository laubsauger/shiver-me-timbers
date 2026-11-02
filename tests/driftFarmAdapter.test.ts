/**
 * The Drift's adapter for the studio farm package (farm/: drift.adapter.mjs, hub-hooks.mjs, types/*.json). drift-dash
 * mounts the package's hub with these, on the queue today's hub (scripts/drift-farm.mjs) kept, and the boxes still run
 * today's worker (scripts/drift-farm-client.mjs). What must hold, or the switch changes what the farm does:
 *   - THE HUB'S HOOKS name every command's kind and speed class as drift-farm.mjs does: speeds.json is keyed by the
 *     class (a different one starts the learned speeds over and sends a clip to the slower box), and the kind decides
 *     who gets what (stills to any free box, clips and long jobs to the fastest).
 *   - THE WORKER'S HOOKS read progress from a job's lines as drift-farm-client.mjs does, take the same Vite caches and
 *     the same VRAM rule as drift-share.mjs, so a box on the package's worker behaves as it does today.
 *   - THE TYPES name farm/drift.adapter.mjs as their hooks, resolved inside a job's own tree; and they load in the
 *     package (when the sibling checkout is here: a fresh clone of this public repo has none, and skips that one).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as adapter from '../farm/drift.adapter.mjs';
import * as hubHooks from '../farm/hub-hooks.mjs';
import { jobClass, jobKind } from '../scripts/drift-farm.mjs';
import { progressOf, VITE_CACHES } from '../scripts/drift-farm-client.mjs';
import { needVramGB, YIELD_DEFAULTS } from '../scripts/drift-share.mjs';

const ROOT = join(__dirname, '..');
const STUDIO_FARM = resolve(ROOT, process.env.STUDIO_FARM_DIR ?? '../studio-farm');

// the commands the farm has taken (out/drift/farm/jobs, 2026-10-30 to 11-02), as drift-slot.mjs --farm sends them
const COMMANDS = [
  ['node', 'drift-review-stills.mjs', 'shots.json', '--width', '1280', '--out', 'c'],
  ['node', 'drift-review-stills.mjs', 'ld1.json', '--width', '640', '--query', 'linedown&powerline', '--out', 'linedown_r1'],
  ['node', 'scripts/drift-stills.mjs', '745.8', '4096', '--channel', 'chrome'],
  ['node', 'drift-review-clip.mjs', '--from', '0', '--to', '86', '--width', '1920', '--allow-long', '--allow-large', '--flat-track', '--out', 'act1.mp4'],
  ['node', 'drift-review-clip.mjs', '--from', '31', '--to', '50', '--dome', '--width', '2048', '--allow-large', '--out', 'wave.mp4'],
  ['node', 'scripts/drift-render.mjs', '--size', '4096', '--fps', '30', '--from', '0', '--to', '20', '--channel', 'chrome', '--out', 'chunk.mp4'],
  ['node', 'scripts/drift-queue.mjs', 'render-queue.jsonc'],
  ['node', 'scripts/drift-node.mjs', 'render', '--preset', 'dome2048'],
  ['node', 'scripts/cine-bench.mjs'],
];

describe('the hub\'s hooks are drift-farm.mjs\'s (speeds.json keeps its classes)', () => {
  it('the same kind and speed class for every command the farm has taken', () => {
    for (const argv of COMMANDS) {
      expect(hubHooks.jobKind(argv), argv.join(' ')).toBe(jobKind(argv));
      expect(hubHooks.jobClass(argv), argv.join(' ')).toBe(jobClass(argv));
    }
  });
});

describe('the worker\'s hooks are drift-farm-client.mjs\'s and drift-share.mjs\'s', () => {
  it('progress from a clip\'s frames and from a stills run\'s one line per still, as today', () => {
    const lines = ['[review] 120/360  3.0 fps', '[render] 9/600  0.0 fps', '[review] tower_745.8.png  t 745.8', '[review] deck.jpg  t 12', 'boot: shader cache: warm', '[review] 1/2 fps'];
    let a = undefined;
    let b = undefined;
    for (const l of lines) {
      a = adapter.progress(l, a);
      b = progressOf(l, b);
      expect(a, l).toEqual(b);
    }
  });
  it('the same warm Vite caches and the same VRAM need: 22 GB a lane at 8192², else 10, the box\'s own figure first', () => {
    expect(adapter.VITE_CACHES).toEqual(VITE_CACHES);
    const cases: [{ size?: number; lanes?: number } | null, number | null][] = [[{ size: 2048, lanes: 1 }, null], [{ size: 8192, lanes: 2 }, null], [{ size: 4096, lanes: 2 }, 14], [null, null]];
    for (const [job, need] of cases) {
      const policy = { ...YIELD_DEFAULTS, needVramGB: need };
      expect(adapter.needVramGB(job, { needVramGB: need ?? undefined }), JSON.stringify([job, need])).toBe(needVramGB(job, policy));
    }
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
    expect(reg.keys().sort()).toEqual(['drift-render@1', 'drift-review-clip@1', 'drift-review-stills@1', 'legacy-argv@1']);
  });
});
