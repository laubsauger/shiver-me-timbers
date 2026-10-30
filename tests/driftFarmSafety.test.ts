/**
 * The farm's safety nets, from the QA sweep of 2026-10-30 (the coordinator):
 *   - SILENT BLACK FRAMES: linux-monster ran out of video memory beside sd-webrtc and returned 16 pure-black stills with
 *     exit 0 — "a master chunk could do the same unnoticed". Results are looked at (drift-sanity.mjs): a black still, a
 *     clip that is black throughout or drops to black, fails the job and sends it to another box; the film's own black
 *     (a fade up from it, as the opening at 60 s does) passes.
 *   - HALF-EDITED TREES: a session mid-edit (loops.ts importing what events.ts did not export yet) hung every job
 *     packed in its window at boot. A tree that does not build is refused before it is packed (drift-precheck.mjs).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AVOID_MS, pickWorker } from '../scripts/drift-farm.mjs';
import { precheck } from '../scripts/drift-precheck.mjs';
import { blackVerdict, BLACK_MAX, DROP_FROM } from '../scripts/drift-sanity.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'drift-farm-safety-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('results that are not pictures', () => {
  it('a pure-black still fails; a dark one (a night shot, its brightest pixel 9) passes', () => {
    expect(blackVerdict([0], { still: true })).toMatch(/pure black/);
    expect(blackVerdict([9], { still: true })).toBeNull();
  });

  it('a clip that drops to black — a lost device — fails, with where', () => {
    const v = blackVerdict([180, 175, 170, 0, 0, 0]);
    expect(v).toMatch(/drops to pure black at frame 3 \(3 frame\(s\), after one as bright as 170/);
  });

  it('a clip black throughout fails', () => {
    expect(blackVerdict(new Array(600).fill(0))).toMatch(/all 600 frames are pure black/);
  });

  it('the film\'s own black passes: the opening at 60 s fades up out of it over a second (the 2026-10-30 preview)', () => {
    // its first frames' brightest pixels, as measured: 34 frames at 0, then 5, 11, 16, 19, 22 …
    const fadeUp = [...new Array(34).fill(0), 5, 11, 16, 19, 22, 25, 28, 30, 31, 34, ...new Array(556).fill(96)];
    expect(blackVerdict(fadeUp)).toBeNull();
    // a fade DOWN that passes through dim frames first is not a drop either
    expect(blackVerdict([120, 60, 30, 12, 4, 0, 0])).toBeNull();
    expect(DROP_FROM).toBeGreaterThan(BLACK_MAX);
  });

  it('a shot of the film\'s black can be asked for (allowBlack)', () => {
    expect(blackVerdict([0], { still: true, allowBlack: true })).toBeNull();
  });
});

describe('a job sent back for black results goes to another box first', () => {
  const linux = { node: 'linux-monster', speed: 1 };
  const eeg = { node: 'eeg-msi', speed: 0.85 };
  it('not to the box that drew black, while another takes work — for AVOID_MS, then any', () => {
    const job = { kind: 'still', avoid: ['linux-monster'], avoidUntil: 1000 + AVOID_MS };
    expect(pickWorker(job, [linux, eeg], 1000)).toBe('eeg-msi');
    expect(pickWorker(job, [linux], 1000)).toBeNull();
    expect(pickWorker(job, [linux], 1000 + AVOID_MS + 1)).toBe('linux-monster');
  });
});

describe('a tree that does not build never goes out', () => {
  const tree = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(scratch, 'tree-'));
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(join(dir, p, '..'), { recursive: true });
      writeFileSync(join(dir, p), body);
    }
    return dir;
  };

  it('an import of a name the module does not export yet (loops.ts and events.ts, 02:16): refused, with file:line', async () => {
    const dir = tree({
      'src/main-drift.ts': "import { spin } from './loops';\nconsole.log(spin);\n",
      'src/loops.ts': "import { packedSpiral } from './events';\nexport const spin = packedSpiral;\n",
      'src/events.ts': 'export const somethingElse = 1;\n',
    });
    const r = await precheck(dir);
    expect(r.ok).toBe(false);
    expect(r.errors[0].text).toMatch(/packedSpiral/);
    expect(r.errors[0].where).toBe('src/loops.ts:1');
  });

  it('a half-written file (a syntax error) is refused; the same tree once it is whole passes; assets are not code', async () => {
    const broken = tree({ 'src/main-drift.ts': "import { a } from './a';\nconsole.log(a);\n", 'src/a.ts': 'export const a = (1 + ;\n' });
    expect((await precheck(broken)).ok).toBe(false);
    const whole = tree({
      'src/main-drift.ts': "import { a } from './a';\nimport font from './f.woff2?url';\nconst u = new URL('./m.glb', import.meta.url);\nconsole.log(a, font, u);\n",
      'src/a.ts': 'export const a = 1;\n',
    });
    expect(await precheck(whole)).toMatchObject({ ok: true, errors: [] });
  });

  it('a tree without the film\'s entry (a test repository) is not checked', async () => {
    expect(await precheck(tree({ 'README.md': 'x' }))).toMatchObject({ ok: true, skipped: true });
  });
});
