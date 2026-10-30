/**
 * The Drift farm (scripts/drift-farm.mjs, the hub on the Mac's dashboard; scripts/drift-farm-client.mjs, the submitter
 * and the worker). A job runs on another machine and its files land back here as if it ran here; what must hold:
 *   - THE QUEUE never loses or doubles a job: a finished job stays finished, a worker that goes quiet gives its job
 *     back (twice, then it fails), and only a payload that has fully arrived is queued.
 *   - WHO GETS WHAT: stills to whoever is free, clips and long jobs to the fastest free box — a slower box only after
 *     a wait; speeds learned from the boxes' own frame rates.
 *   - THE PATHS: an --out path comes back to that exact path; an input outside the code travels; a repo file stays a
 *     repo path; a result file cannot be written outside its folder.
 *   - THE CODE STATE: committed-but-unpushed, uncommitted, binary and untracked changes all arrive (a round trip
 *     through two temp git repos); the box's bundle is linked, never written to; a job's folder is deleted without
 *     following its links into the checkout.
 *   - THE DOOR: no token, a wrong token, a box claiming as another — refused; a farm.json git would commit — refused.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFarmHub, farmToken, fpsSamples, gitIgnoreState, holdReason, jobClass, jobKind, landingPath, learn, LEASE_MS, pickWorker, queueOrder, safeRel, SAMPLE_MS, SAMPLES_MAX, speedOf, transition, yieldsTo,
} from '../scripts/drift-farm.mjs';
import { applyState, assetOverlay, holdOn, labelOf, packState, progressOf, remapArgv, removeTree, resolveArgv, roundTrip, submitterOf } from '../scripts/drift-farm-client.mjs';
import { chunksOf } from '../scripts/drift-farm-render.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'drift-farm-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const sh = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

describe('the queue', () => {
  const job = { id: 'j1', state: 'uploading' };

  it('moves only forward: uploading → queued → preparing → running → done, and done stays done', () => {
    let j = transition(job, 'queued');
    j = transition(j, 'preparing', { node: 'windows-monster' });
    j = transition(j, 'running');
    j = transition(j, 'done', { exitCode: 0 });
    expect(j).toMatchObject({ state: 'done', node: 'windows-monster', exitCode: 0 });
    expect(() => transition(j, 'running')).toThrow(/not a move/);
    expect(() => transition(job, 'running')).toThrow(/not a move/); // nothing skips the queue
  });

  it('names the kind and the class a speed is measured in', () => {
    expect(jobKind(['node', 'scripts/drift-review-stills.mjs', 'shots.json'])).toBe('still');
    expect(jobKind(['node', 'scripts/drift-render.mjs', '--size', '4096'])).toBe('long');
    expect(jobKind(['node', 'scripts/drift-review-clip.mjs', '--from', '300'])).toBe('clip');
    expect(jobClass(['node', 'scripts/drift-render.mjs', '--size', '4096'])).toBe('drift-render.mjs:4096');
  });

  // the console's fps sparkline reads these: a status post every 2 s must not grow job.json without bound, and a gap
  // in the samples must mean the box went quiet, not that the hub dropped one
  it('keeps one fps sample per SAMPLE_MS, the newest SAMPLES_MAX, and ignores a report without a frame rate', () => {
    let s = fpsSamples(undefined, 0, 2.5, 10);
    s = fpsSamples(s, SAMPLE_MS - 1, 9, 11); // too soon: dropped
    s = fpsSamples(s, SAMPLE_MS, 3, 40);
    s = fpsSamples(s, 2 * SAMPLE_MS, Number.NaN, 50); // no fps (a still's line): nothing
    expect(s).toEqual([[0, 2.5, 10], [SAMPLE_MS, 3, 40]]);
    for (let i = 2; i < SAMPLES_MAX + 10; i++) s = fpsSamples(s, i * SAMPLE_MS, 1, i);
    expect(s).toHaveLength(SAMPLES_MAX);
    expect(s.at(-1)).toEqual([(SAMPLES_MAX + 9) * SAMPLE_MS, 1, SAMPLES_MAX + 9]);
  });
});

describe('who gets what', () => {
  const fast = { node: 'windows-monster', speed: 1 };
  const slow = { node: 'eeg-msi', speed: 0.5 };

  // (the user, 2026-10-30: "I don't think we have to limit any of these machines artificially … even the EEG 5090
  // laptop can really pack a punch": no job waits for a faster box while another one is free)
  it('any free box takes any job at once — a still, a clip, a long render — even the slower laptop', () => {
    for (const kind of ['still', 'clip', 'long']) expect(pickWorker({ kind, queuedAt: 0 }, [slow])).toBe('eeg-msi');
  });

  it('of the boxes asking at once, the fastest', () => {
    expect(pickWorker({ kind: 'clip', queuedAt: 0 }, [slow, fast])).toBe('windows-monster');
  });

  it('a job pinned to a box goes only there', () => {
    expect(pickWorker({ kind: 'clip', prefer: 'eeg-msi', queuedAt: 0 }, [fast])).toBeNull();
    expect(pickWorker({ kind: 'clip', prefer: 'eeg-msi', queuedAt: 0 }, [fast, slow])).toBe('eeg-msi');
  });

  // PRIORITIES (drift-farm.mjs; the user, 2026-10-30: "I gave you all the computer in the world and everything is
  // idle"): a background full-show preview fills the gaps between the agents' short review jobs at `low`, and must
  // never slow them: a box a normal job could use is never handed to a low one
  it('hands out the highest priority first, the oldest first within it', () => {
    const q = [
      { id: 'a', priority: 'low', queuedAt: 1 },
      { id: 'b', queuedAt: 5 },
      { id: 'c', priority: 'high', queuedAt: 9 },
      { id: 'd', priority: 'normal', queuedAt: 2 },
    ];
    expect(queueOrder(q).map((j) => j.id)).toEqual(['c', 'd', 'b', 'a']);
  });

  it('a low job never takes a box a queued normal job could use — but a normal job pinned elsewhere holds nothing back', () => {
    const low = { id: 'chunk', priority: 'low', queuedAt: 1 };
    const review = { id: 'stills', queuedAt: 2 };
    expect(yieldsTo(low, 'eeg-msi', [low, review])).toBe(true);
    const pinned = { id: 'pinned', queuedAt: 2, prefer: 'linux-monster' };
    expect(yieldsTo(low, 'eeg-msi', [low, pinned])).toBe(false);
    expect(yieldsTo(low, 'linux-monster', [low, pinned])).toBe(true);
    expect(yieldsTo(review, 'eeg-msi', [low, review])).toBe(false); // (a normal job never yields to a low one)
  });

  it('a held low job says it waits for the jobs above it', () => {
    const workers = [{ node: 'eeg-msi', state: 'waiting', speed: 0.5, farmState: 'accepting' }];
    const low = { kind: 'long', priority: 'low', queuedAt: 0 };
    expect(holdReason(low, workers, 1000, [low, { kind: 'still', queuedAt: 5 }])).toBe('low priority: after 1 queued job(s) above it');
  });

  it('a held job says why, in words the dashboard shows', () => {
    const w = (node: string, state: string, speed: number, why: string | null = null) => ({ node, state, speed, why });
    expect(holdReason({ kind: 'clip', queuedAt: 0 }, [w('windows-monster', 'offline', 1), w('eeg-msi', 'offline', 0.5)], 0)).toBe('no worker online');
    expect(holdReason({ kind: 'clip', queuedAt: 0 }, [w('windows-monster', 'busy-foreign', 1, 'ComfyUI 18 GB'), w('eeg-msi', 'offline', 0.5)], 0)).toBe('windows-monster busy (ComfyUI 18 GB), eeg-msi offline');
    expect(holdReason({ kind: 'clip', queuedAt: 0 }, [w('windows-monster', 'busy', 1), w('eeg-msi', 'waiting', 0.5)], 30_000)).toBe('being handed out');
    expect(holdReason({ kind: 'clip', prefer: 'eeg-msi', queuedAt: 0 }, [w('eeg-msi', 'offline', 0.5)], 0)).toBe('eeg-msi offline (no worker running there)');
  });

  it('speeds are learned from measured frame rates, relative to the fastest box in the same kind of job', () => {
    let s = learn({}, { node: 'windows-monster', cls: 'clip:1280', fps: 6 });
    s = learn(s, { node: 'eeg-msi', cls: 'clip:1280', fps: 2.4 });
    expect(speedOf('eeg-msi', s, 0.5)).toBe(0.4);
    expect(speedOf('windows-monster', s, 1)).toBe(1);
    // nothing to compare with yet: the farm-nodes guess
    expect(speedOf('linux-monster', s, 1)).toBe(1);
  });
});

describe('paths', () => {
  const root = join(scratch, 'repo-paths');
  beforeAll(() => {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'drift-review-stills.mjs'), '');
    writeFileSync(join(scratch, 'shots.json'), '[]');
  });

  it('repo files stay repo paths, outside inputs travel, --out paths come back where they were', () => {
    const r = remapArgv(['/usr/local/bin/node', 'scripts/drift-review-stills.mjs', join(scratch, 'shots.json'), '--width', '1280', '--out', join(scratch, 'out', 'stills')], { root, cwd: root, shipped: (rel) => rel === 'scripts/drift-review-stills.mjs' });
    expect(r.argv).toEqual(['node', 'scripts/drift-review-stills.mjs', '{{in:0}}', '--width', '1280', '--out', '{{out:0}}']);
    expect(r.inputs).toEqual([{ i: 0, local: join(scratch, 'shots.json'), name: 'shots.json' }]);
    expect(r.outs).toEqual([{ i: 0, local: join(scratch, 'out', 'stills'), file: false }]);
  });

  // the swash agent's job 20261030-004850-caf364 (2026-10-30): its log read `… --width 1920 --out on <tree>`, as if the
  // --out path had been swallowed. It was the label (the first six arguments); the argv and the landing were right.
  it('an agent\'s scratchpad paths: the input travels, --out comes back to the same folder, the label shows them all', () => {
    const pad = join(scratch, 'claude-501', 'scratchpad');
    mkdirSync(pad, { recursive: true });
    writeFileSync(join(pad, 'v.json'), '[]');
    const argv = ['node', 'scripts/drift-review-stills.mjs', join(pad, 'v.json'), '--width', '1920', '--out', join(pad, 'r3a'), '--port', '5372'];
    const r = remapArgv(argv, { root, cwd: pad, shipped: (rel) => rel === 'scripts/drift-review-stills.mjs' });
    expect(r.argv).toEqual(['node', 'scripts/drift-review-stills.mjs', '{{in:0}}', '--width', '1920', '--out', '{{out:0}}', '--port', '5372']);
    expect(r.outs).toEqual([{ i: 0, local: join(pad, 'r3a'), file: false }]);
    expect(landingPath(r.outs[0], 's365_show.png')).toBe(join(pad, 'r3a', 's365_show.png'));
    expect(labelOf(argv)).toBe('node drift-review-stills.mjs v.json --width 1920 --out r3a --port 5372');
    expect(labelOf(['node', 'x.mjs', '--query', 'a'.repeat(300)])).toMatch(/^node x\.mjs --query a+…$/);
    expect(labelOf(['node', 'x.mjs', '--query', 'a'.repeat(300)])).toHaveLength(160);
  });

  it('an --out file (a clip) is a file on the box too, and its result lands at that file', () => {
    const r = remapArgv(['node', 'scripts/x.mjs', `--out=${join(scratch, 'clip.mp4')}`], { root, cwd: root, shipped: () => false });
    expect(r.argv[2]).toBe('--out={{out:0}}');
    const box = resolveArgv(r.argv, { jobDir: '/box/job', outs: r.outs, inputs: [], node: '/usr/bin/node' });
    expect(box).toEqual(['/usr/bin/node', 'scripts/x.mjs', `--out=${join('/box/job', 'out', '0', 'clip.mp4')}`]);
    expect(landingPath(r.outs[0], 'clip.mp4')).toBe(join(scratch, 'clip.mp4'));
    expect(landingPath(r.outs[0], 'clip.json')).toBe(join(scratch, 'clip.json'));
  });

  it('a result file cannot climb out of its folder', () => {
    expect(safeRel('sub/a.png')).toBe('sub/a.png');
    expect(safeRel('../../.ssh/authorized_keys')).toBeNull();
    expect(safeRel('C:/Windows/x')).toBeNull();
    expect(safeRel('')).toBeNull();
  });

  it('progress from a clip\'s lines, and from a stills run\'s one line per still', () => {
    expect(progressOf('[review] 120/360  3.0 fps')).toEqual({ done: 120, total: 360, unit: 'frames', fps: 3, etaS: 80 });
    expect(progressOf('[review] tower_745.8.png  t 745.8', progressOf('[review] tower_700.8.png  t 700.8')).done).toBe(2);
  });

  it('the assets a box lacks: new, resized, or touched (its sha checked by the packer)', () => {
    const o = assetOverlay(
      [{ path: 'public/drift/a.png', bytes: 3, mtimeMs: 5 }, { path: 'public/drift/b.png', bytes: 9, mtimeMs: 5 }, { path: 'public/drift/c.png', bytes: 4, mtimeMs: 2e12 }, { path: 'public/drift/d.png', bytes: 1, mtimeMs: 5 }],
      { created: '2026-10-29T16:08:31Z', files: [{ path: 'public/drift/a.png', bytes: 3, sha256: 'x' }, { path: 'public/drift/b.png', bytes: 8, sha256: 'y' }, { path: 'public/drift/c.png', bytes: 4, sha256: 'z' }] },
    );
    expect(o.map((f) => [f.path, f.why])).toEqual([['public/drift/b.png', 'changed'], ['public/drift/c.png', 'touched'], ['public/drift/d.png', 'new']]);
  });
});

describe('the code state, packed on one machine and applied on another', () => {
  const origin = join(scratch, 'origin');
  const dev = join(scratch, 'dev');
  const box = join(scratch, 'box');

  beforeAll(() => {
    mkdirSync(join(origin, 'src'), { recursive: true });
    sh(origin, 'init', '-q', '-b', 'main');
    writeFileSync(join(origin, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(origin, 'src', 'old.ts'), 'gone soon\n');
    writeFileSync(join(origin, 'icon.bin'), new Uint8Array([0, 1, 2, 3, 255]));
    writeFileSync(join(origin, 'package-lock.json'), '{"lockfileVersion":3}\n');
    writeFileSync(join(origin, '.gitignore'), 'node_modules\npublic/drift/\nout/\n');
    sh(origin, 'add', '-A');
    sh(origin, 'commit', '-q', '-m', 'base');
    sh(scratch, 'clone', '-q', origin, dev);
    sh(scratch, 'clone', '-q', origin, box);
    // the developer's state: a commit not pushed, an edit not committed, a binary change, a delete, a new file
    writeFileSync(join(dev, 'src', 'a.ts'), 'export const a = 2;\n');
    sh(dev, 'commit', '-q', '-am', 'local, not pushed');
    writeFileSync(join(dev, 'src', 'a.ts'), 'export const a = 3; // not committed\n');
    writeFileSync(join(dev, 'icon.bin'), new Uint8Array([9, 9, 9]));
    rmSync(join(dev, 'src', 'old.ts'));
    writeFileSync(join(dev, 'src', 'new.ts'), 'export const fresh = true;\n');
    // the box: a synced bundle (manifest + its file) and its packages
    mkdirSync(join(box, 'public', 'drift'), { recursive: true });
    writeFileSync(join(box, 'public', 'drift', 'sand.png'), 'SAND');
    mkdirSync(join(box, 'out', 'drift-bundle'), { recursive: true });
    writeFileSync(join(box, 'out', 'drift-bundle', 'manifest-assets.json'), JSON.stringify({ created: '2026-10-29T00:00:00Z', count: 1, bytes: 4, files: [{ path: 'public/drift/sand.png', bytes: 4, sha256: 's' }] }));
    mkdirSync(join(box, 'node_modules', 'three'), { recursive: true });
    writeFileSync(join(box, 'node_modules', 'three', 'index.js'), 'module.exports = 3');
  });

  it('round trip: every kind of change arrives, at the base commit, and the box\'s bundle is linked, not copied', async () => {
    const stage = join(scratch, 'stage');
    const { payload, meta } = await packState({ root: dev, stage, base: 'origin/main', assetsNow: [] });
    expect(meta.base).toBe(sh(origin, 'rev-parse', 'HEAD'));
    expect(meta.files).toEqual(['src/new.ts']);
    const jobDir = join(scratch, 'smt-farm', 'job1');
    mkdirSync(jobDir, { recursive: true });
    expect(spawnSync('tar', ['-xzf', payload, '-C', jobDir]).status).toBe(0);
    const { tree } = await applyState({ main: box, jobDir });
    expect(readFileSync(join(tree, 'src', 'a.ts'), 'utf8')).toBe('export const a = 3; // not committed\n');
    expect([...readFileSync(join(tree, 'icon.bin'))]).toEqual([9, 9, 9]);
    expect(existsSync(join(tree, 'src', 'old.ts'))).toBe(false);
    expect(readFileSync(join(tree, 'src', 'new.ts'), 'utf8')).toContain('fresh');
    expect(readFileSync(join(tree, 'public', 'drift', 'sand.png'), 'utf8')).toBe('SAND');
    expect(readFileSync(join(tree, 'node_modules', 'three', 'index.js'), 'utf8')).toBe('module.exports = 3');
    // the job's Vite writes its dependency cache into the box's warm one (the next job does not re-optimize)
    writeFileSync(join(tree, 'node_modules', '.vite-drift-render', 'warm.txt'), 'deps');
    expect(readFileSync(join(box, 'node_modules', '.vite-drift-render', 'warm.txt'), 'utf8')).toBe('deps');
    // the box's own checkout did not change
    expect(sh(box, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    // and deleting the job's folder leaves the checkout's packages and bundle file alone
    removeTree(jobDir);
    expect(existsSync(jobDir)).toBe(false);
    expect(readFileSync(join(box, 'node_modules', 'three', 'index.js'), 'utf8')).toBe('module.exports = 3');
    expect(readFileSync(join(box, 'public', 'drift', 'sand.png'), 'utf8')).toBe('SAND');
    expect(readFileSync(join(box, 'node_modules', '.vite-drift-render', 'warm.txt'), 'utf8')).toBe('deps'); // (kept warm)
  });

  it('a payload over the cap fails loud and names the biggest files', async () => {
    const big = Array.from({ length: 3 }, (_, k) => ({ path: `public/drift/huge${k}.bin`, bytes: 90 * 2 ** 20, mtimeMs: 1 }));
    await expect(packState({ root: dev, stage: join(scratch, 'stage2'), assetsNow: big })).rejects.toThrow(/270 MB.*huge0\.bin.*Rebuild the bundle/);
  });

  it('removeTree removes a link to a folder as a link', () => {
    const outside = join(scratch, 'keep');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'precious.txt'), 'x');
    const d = join(scratch, 'doomed');
    mkdirSync(d, { recursive: true });
    symlinkSync(outside, join(d, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    removeTree(d);
    expect(existsSync(join(outside, 'precious.txt'))).toBe(true);
  });
});

describe('the door', () => {
  const TOKEN = 'a-token-of-twenty-four-ch';
  const hints = () => [{ name: 'windows-monster', tailnetIp: '100.77.131.101', speed: 1 }, { name: 'eeg-msi', tailnetIp: '100.126.127.68', speed: 0.5 }];
  let server: Server;
  let base = '';
  let now = 1_000_000;
  let hub: ReturnType<typeof createFarmHub>;
  // the requests' source address, as a test sets it (the hub reads req.socket.remoteAddress)
  let from = '127.0.0.1';
  beforeAll(async () => {
    const bundleDir = join(scratch, 'bundle');
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(bundleDir, 'latest-assets.json'), '{"file":"drift-assets-20261029.tar.gz"}');
    hub = createFarmHub({ dir: join(scratch, 'farm'), token: TOKEN, hints, bundleDir, now: () => now, allow: () => true });
    server = createServer((req, res) => {
      Object.defineProperty(req.socket, 'remoteAddress', { value: from, configurable: true });
      void hub.handle(req, res, new URL(req.url ?? '/', 'http://x'));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  });
  afterAll(() => {
    hub.close();
    server.close();
  });
  const call = (path: string, o: { method?: string; token?: string | null; body?: unknown; raw?: BodyInit } = {}) =>
    fetch(`${base}${path}`, { method: o.method ?? 'GET', headers: { ...(o.token === null ? {} : { authorization: `Bearer ${o.token ?? TOKEN}` }), ...(o.body ? { 'content-type': 'application/json' } : {}) }, body: o.raw ?? (o.body ? JSON.stringify(o.body) : undefined) });

  it('no token or a wrong one: 401', async () => {
    from = '127.0.0.1';
    expect((await call('/farm/workers', { token: null })).status).toBe(401);
    expect((await call('/farm/workers', { token: 'wrong-wrong-wrong-wrong-w' })).status).toBe(401);
  });

  it('a farm box by its tailnet address may use its own routes without a token — and only as itself', async () => {
    from = '100.77.131.101';
    expect((await call('/farm/bundle/latest-assets.json', { token: null })).status).toBe(200);
    expect((await call('/farm/claim?node=eeg-msi&busy=x', { token: null })).status).toBe(403);
    // but not the submitter's routes
    expect((await call('/farm/jobs', { method: 'POST', token: null, body: { argv: ['x'], base: 'abcdef1' } })).status).toBe(401);
    // an address no farm box has: nothing
    from = '100.64.9.9';
    expect((await call('/farm/bundle/latest-assets.json', { token: null })).status).toBe(401);
  });

  it('a job\'s life over HTTP: posted, its payload, claimed, run, its file back, done', async () => {
    from = '127.0.0.1';
    const { id } = await (await call('/farm/jobs', { method: 'POST', body: { argv: ['node', 'scripts/drift-review-stills.mjs', '{{in:0}}', '--out', '{{out:0}}'], base: 'abcdef1', outs: [{ i: 0, local: '/Users/flo/out/stills', file: false }], inputs: [{ i: 0, name: 'shots.json' }] } })).json();
    expect(hub.jobs().find((j) => j.id === id)?.state).toBe('uploading');
    // a claim while nothing is queued yet waits; the payload's arrival hands it the job
    from = '100.77.131.101';
    const claim = call('/farm/claim?node=windows-monster', { token: null });
    await new Promise((r) => setTimeout(r, 50));
    from = '127.0.0.1';
    expect((await call(`/farm/jobs/${id}/payload`, { method: 'PUT', raw: 'PAYLOAD' })).status).toBe(204);
    const taken = await (await claim).json();
    expect(taken).toMatchObject({ id, state: 'preparing', node: 'windows-monster' });
    from = '100.77.131.101';
    expect(await (await call(`/farm/jobs/${id}/payload`, { token: null })).text()).toBe('PAYLOAD');
    await call(`/farm/jobs/${id}/status`, { method: 'POST', token: null, body: { state: 'running', lines: ['[review] tower.png  t 745.8'] } });
    expect((await call(`/farm/jobs/${id}/files?out=0&path=${encodeURIComponent('../escape.png')}`, { method: 'PUT', token: null, raw: 'x' })).status).toBe(400);
    expect((await call(`/farm/jobs/${id}/files?out=0&path=${encodeURIComponent('sub/tower.png')}`, { method: 'PUT', token: null, raw: 'PNG' })).status).toBe(204);
    await call(`/farm/jobs/${id}/status`, { method: 'POST', token: null, body: { state: 'done', exitCode: 0, fps: 2 } });
    from = '127.0.0.1';
    const j = await (await call(`/farm/jobs/${id}?from=0`)).json();
    expect(j).toMatchObject({ state: 'done', exitCode: 0, log: ['[review] tower.png  t 745.8'] });
    expect(j.results).toEqual([{ out: 0, path: 'sub/tower.png', bytes: 3, landing: join('/Users/flo/out/stills', 'sub/tower.png') }]);
    expect(await (await call(`/farm/jobs/${id}/files/0/sub/tower.png`)).text()).toBe('PNG');
    // and the dashboard's view of it
    expect(hub.view().jobs.find((x: { id: string }) => x.id === id)).toMatchObject({ state: 'done', node: 'windows-monster', results: [{ path: join('/Users/flo/out/stills', 'sub/tower.png'), bytes: 3 }] });
  });

  it('a worker that goes quiet gives its job back, and after the second time the job fails', async () => {
    from = '127.0.0.1';
    const { id } = await (await call('/farm/jobs', { method: 'POST', body: { argv: ['node', 'scripts/drift-review-stills.mjs'], base: 'abcdef1' } })).json();
    await call(`/farm/jobs/${id}/payload`, { method: 'PUT', raw: 'P' });
    const takeIt = async () => {
      from = '100.126.127.68';
      return (await call('/farm/claim?node=eeg-msi', { token: null })).json();
    };
    expect((await takeIt()).id).toBe(id);
    now += LEASE_MS + 1;
    hub.sweep();
    expect(hub.jobs().find((j) => j.id === id)).toMatchObject({ state: 'queued', attempts: 1 });
    expect((await takeIt()).id).toBe(id);
    now += LEASE_MS + 1;
    hub.sweep();
    expect(hub.jobs().find((j) => j.id === id)).toMatchObject({ state: 'failed', error: 'eeg-msi stopped answering (twice)' });
  });

  // A DASHBOARD RESTART LOSES NOTHING (drift-farm-client.mjs header; the coordinator, 2026-10-30, with two jobs
  // running: "make sure a dashboard restart doesn't lose them"): the jobs are on disk, and a box that kept rendering
  // while the dashboard was down for minutes keeps its job — taking it would run the job twice
  const newJob = async (argv = ['node', 'scripts/drift-review-stills.mjs']) => {
    from = '127.0.0.1';
    const { id } = await (await call('/farm/jobs', { method: 'POST', body: { argv, base: 'abcdef1' } })).json();
    await call(`/farm/jobs/${id}/payload`, { method: 'PUT', raw: 'P' });
    return id as string;
  };
  const claimAs = async (node: string, ip: string) => {
    from = ip;
    const r = await call(`/farm/claim?node=${node}`, { token: null });
    return r.status === 200 ? r.json() : null;
  };

  it('a restart: the running job is read back from disk, and its box is not timed out by the downtime', async () => {
    const id = await newJob();
    expect((await claimAs('eeg-msi', '100.126.127.68')).id).toBe(id);
    await call(`/farm/jobs/${id}/status`, { method: 'POST', token: null, body: { state: 'running', lines: ['a'], from: 0 } });
    // the dashboard is down for longer than a lease, then starts again on the same folder
    now += 3 * LEASE_MS;
    const again = createFarmHub({ dir: join(scratch, 'farm'), token: TOKEN, hints, now: () => now, allow: () => true });
    try {
      expect(again.jobs().find((j) => j.id === id)).toMatchObject({ state: 'running', node: 'eeg-msi' });
      again.sweep();
      expect(again.jobs().find((j) => j.id === id)?.state).toBe('running'); // (the box gets a lease from the restart)
      now += LEASE_MS + 1;
      again.sweep();
      expect(again.jobs().find((j) => j.id === id)?.state).toBe('queued'); // (silent past that: given back as ever)
    } finally {
      again.close();
    }
  });

  it('a status batch sent again (its answer lost) adds its lines once; lines lost on the box are noted', async () => {
    const id = await newJob();
    await claimAs('eeg-msi', '100.126.127.68');
    const post = (body: unknown) => call(`/farm/jobs/${id}/status`, { method: 'POST', token: null, body });
    await post({ state: 'running', lines: ['one', 'two'], from: 0 });
    await post({ lines: ['one', 'two', 'three'], from: 0 }); // the first answer never arrived: sent again, one more
    await post({ lines: ['six'], from: 5 }); // the box dropped two lines while the hub was away
    from = '127.0.0.1';
    const j = await (await call(`/farm/jobs/${id}?from=0`)).json();
    expect(j.log).toEqual(['one', 'two', 'three', '(farm: 2 line(s) lost while the hub was away)', 'six']);
  });

  it('a final state said twice (its answer lost) changes nothing, and the box is free, not busy', async () => {
    const id = await newJob();
    await claimAs('eeg-msi', '100.126.127.68');
    const post = (body: unknown) => call(`/farm/jobs/${id}/status`, { method: 'POST', token: null, body });
    await post({ state: 'running', from: 0, lines: [] });
    await post({ state: 'done', exitCode: 0, from: 0, lines: [] });
    expect((await post({ state: 'done', exitCode: 0, from: 0, lines: [] })).status).toBe(200);
    expect(hub.jobs().find((j) => j.id === id)?.state).toBe('done');
    expect(hub.view().workers.find((w: { node: string }) => w.node === 'eeg-msi')).toMatchObject({ state: 'waiting', job: null });
  });

  // THE CONTROLS (drift-farm.mjs header; the user, 2026-10-30: "push a button and deregister it … and not poke holes")
  const control = (path: string, body: unknown, o: { json?: boolean; origin?: string } = {}) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { ...(o.json === false ? {} : { 'content-type': 'application/json' }), ...(o.origin ? { origin: o.origin } : {}) }, body: JSON.stringify(body) });

  it('a box\'s farm state is set only from this Mac: never over the tailnet (not even with the token), JSON only, its own origin', async () => {
    from = '100.77.131.101';
    expect((await call('/farm/nodes/eeg-msi/state', { method: 'POST', body: { state: 'paused' } })).status).toBe(403);
    from = '127.0.0.1';
    expect((await control('/farm/nodes/eeg-msi/state', { state: 'paused' }, { json: false })).status).toBe(415);
    expect((await control('/farm/nodes/eeg-msi/state', { state: 'paused' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await control('/farm/nodes/nobody/state', { state: 'paused' })).status).toBe(404);
    expect(hub.view().nodes['eeg-msi'].state).toBe('accepting');
  });

  it('paused: its running job goes back to the queue as a new job, it gets no work, and that survives a restart', async () => {
    const id = await newJob();
    await claimAs('eeg-msi', '100.126.127.68');
    from = '127.0.0.1';
    const r = await (await control('/farm/nodes/eeg-msi/state', { state: 'paused' })).json();
    expect(r).toMatchObject({ node: 'eeg-msi', state: 'paused', from: 'accepting' });
    const old = hub.jobs().find((j) => j.id === id)!;
    expect(old.requeuedAs).toBeTruthy();
    expect(hub.jobs().find((j) => j.id === old.requeuedAs)?.state).toBe('queued');
    // its worker's next status answer tells it to stop
    from = '100.126.127.68';
    expect(await (await call(`/farm/jobs/${id}/status`, { method: 'POST', token: null, body: { lines: [] } })).json()).toMatchObject({ cancel: true, state: 'paused' });
    // a claim from it is held, never handed the queued job
    const held = await fetch(`${base}/farm/claim?node=eeg-msi`, { signal: AbortSignal.timeout(300) }).then((x) => x.status, () => 'held');
    expect(held).toBe('held');
    expect(hub.jobs().find((j) => j.id === old.requeuedAs)?.state).toBe('queued');
    // across a restart
    const again = createFarmHub({ dir: join(scratch, 'farm'), token: TOKEN, hints, now: () => now, allow: () => true });
    try {
      expect(again.view().nodes['eeg-msi']).toMatchObject({ state: 'paused', actions: ['accepting', 'removed'] });
    } finally {
      again.close();
    }
    from = '127.0.0.1';
    expect((await control('/farm/nodes/eeg-msi/state', { state: 'draining' })).status).toBe(400); // (not a move from paused)
    expect((await control('/farm/nodes/eeg-msi/state', { state: 'accepting' })).status).toBe(200);
    // accepting again: its next claim is handed a job requeued from it (the oldest first: every job it ran went back)
    expect((await claimAs('eeg-msi', '100.126.127.68'))?.requeuedFrom).toBeTruthy();
  });

  it('over HTTP: a box asking gets the normal job before the low one queued earlier, and the low one after', async () => {
    from = '127.0.0.1';
    const mk = async (priority?: string) => {
      const { id } = await (await call('/farm/jobs', { method: 'POST', body: { argv: ['node', 'scripts/drift-render.mjs'], base: 'abcdef1', ...(priority ? { priority } : {}) } })).json();
      await call(`/farm/jobs/${id}/payload`, { method: 'PUT', raw: 'P' });
      return id as string;
    };
    // (whatever earlier tests left queued goes first: cleared so this test sees only its own two)
    for (const j of hub.jobs().filter((x) => x.state === 'queued')) await control(`/farm/jobs/${j.id}/cancel`, {});
    const low = await mk('low');
    const normal = await mk();
    expect(hub.view().jobs.find((j: { id: string }) => j.id === low)).toMatchObject({ priority: 'low', why: 'low priority: after 1 queued job(s) above it' });
    expect((await claimAs('eeg-msi', '100.126.127.68'))?.id).toBe(normal);
    expect((await claimAs('windows-monster', '100.77.131.101'))?.id).toBe(low);
  });

  // linux-monster with ComfyUI on its card, 2026-10-30: its worker said "busy" on each claim, the hub held that as a
  // claim and handed it a job, which the worker never read — "linux-monster stopped answering (twice)"
  it('a box whose GPU someone else holds is answered at once and never handed a job', async () => {
    const id = await newJob(['node', 'scripts/drift-review-stills.mjs']);
    from = '100.77.131.101';
    const r = await call('/farm/claim?node=windows-monster&busy=ComfyUI%2018%20GB', { token: null });
    expect(r.status).toBe(204);
    expect(hub.jobs().find((j) => j.id === id)?.state).toBe('queued');
    expect(hub.view().workers.find((w: { node: string }) => w.node === 'windows-monster')).toMatchObject({ state: 'busy-foreign', why: 'ComfyUI 18 GB' });
    // the next box asking takes it
    expect((await claimAs('eeg-msi', '100.126.127.68'))?.id).toBe(id);
  });

  it('a cancelled job whose box goes quiet ends cancelled — it is not given back to the queue', async () => {
    const id = await newJob(['node', 'scripts/drift-review-stills.mjs']);
    await claimAs('eeg-msi', '100.126.127.68');
    from = '127.0.0.1';
    await control(`/farm/jobs/${id}/cancel`, {});
    now += LEASE_MS + 1;
    hub.sweep();
    expect(hub.jobs().find((j) => j.id === id)?.state).toBe('cancelled');
  });

  it('removed: its claim is answered at once with its state (the worker asks again in minutes)', async () => {
    from = '127.0.0.1';
    expect((await control('/farm/nodes/windows-monster/state', { state: 'removed' })).status).toBe(200);
    from = '100.77.131.101';
    const r = await call('/farm/claim?node=windows-monster', { token: null });
    expect(r.status).toBe(204);
    expect(r.headers.get('x-drift-farm-state')).toBe('removed');
    from = '127.0.0.1';
    expect((await control('/farm/nodes/windows-monster/state', { state: 'accepting' })).status).toBe(200);
  });
});

describe('farm.json and git (the repo is public)', () => {
  const repo = join(scratch, 'tokrepo');
  beforeAll(() => {
    mkdirSync(repo, { recursive: true });
    sh(repo, 'init', '-q');
  });

  it('refuses to write a token git would take, and writes none', () => {
    expect(gitIgnoreState(join(repo, 'farm.json'))).toBe('not-ignored');
    expect(() => farmToken(join(repo, 'farm.json'))).toThrow(/not ignored by git/);
    expect(existsSync(join(repo, 'farm.json'))).toBe(false);
  });

  it('writes one once /farm.json is ignored', () => {
    writeFileSync(join(repo, '.gitignore'), '/farm.json\n');
    const t = farmToken(join(repo, 'farm.json'));
    expect(t.created).toBe(true);
    expect(farmToken(join(repo, 'farm.json'))).toEqual({ token: t.token, created: false });
  });

  it('a farm.json already committed stops the farm: its token is public', () => {
    writeFileSync(join(repo, '.gitignore'), '');
    sh(repo, 'add', 'farm.json');
    expect(gitIgnoreState(join(repo, 'farm.json'))).toBe('tracked');
    expect(() => farmToken(join(repo, 'farm.json'))).toThrow(/tracked by git/);
  });
});

describe('holding on through a dashboard restart (drift-farm-client.mjs holdOn)', () => {
  const steps = [1, 1, 1];
  it('tries again while the hub is away (no answer, a 5xx), and goes on once it answers', async () => {
    let n = 0;
    const r = await holdOn('x', async () => {
      n++;
      if (n === 1) throw new TypeError('fetch failed');
      if (n === 2) throw Object.assign(new Error('502'), { status: 502 });
      return 'ok';
    }, { steps });
    expect([r, n]).toEqual(['ok', 3]);
  });

  it('an answer that says no (a 4xx) is final: not tried again', async () => {
    let n = 0;
    await expect(holdOn('x', async () => {
      n++;
      throw Object.assign(new Error('403 not yours'), { status: 403 });
    }, { steps })).rejects.toThrow(/403/);
    expect(n).toBe(1);
  });

  it('gives up after its time, with the last error', async () => {
    await expect(holdOn('x', async () => {
      throw new TypeError('fetch failed');
    }, { steps: [5], untilMs: 20 })).rejects.toThrow(/fetch failed/);
  });

  it('names who sent a job: DRIFT_AGENT, else the Claude Code session, else the pid', () => {
    expect(submitterOf({ DRIFT_AGENT: 'beach-agent', CLAUDE_CODE_SESSION_ID: '0797e262-d034' }, 7, 'laubs-mbp.local')).toEqual({ pid: 7, host: 'laubs-mbp', agent: 'beach-agent' });
    expect(submitterOf({ CLAUDE_CODE_SESSION_ID: '0797e262-d034' }, 7, 'h').agent).toBe('claude 0797e262');
    expect(submitterOf({}, 7, 'h').agent).toBe('pid 7');
  });
});

describe('the round trip, in the submitter\'s console (drift-farm-client.mjs roundTrip)', () => {
  // the user, 2026-10-30: "the way back obviously has to be fast too … so we don't just replace waiting on one thing
  // with waiting on all the plumbing in between": every leg named, so the slow one shows
  it('names every leg from this Mac\'s clock and the box\'s durations, and the shader cache', () => {
    const job = { queuedAt: 1000, claimedAt: 1500, endedAt: 90_000, timing: { payloadMs: 300, bundleMs: 0, treeMs: 1800, bootMs: 67_200, renderMs: 400, uploadMs: 900, cache: 'warm' } };
    expect(roundTrip(job, { submitAt: 0, followAt: 1000, landedAt: 90_600 })).toBe(
      'farm: round trip 90.6 s: send 1.0 s · wait for a box 0.5 s · payload 0.3 s · tree 1.8 s · boot 67.2 s (shader cache warm) · render 0.4 s · upload 0.9 s · back here 0.6 s',
    );
  });
  it('a box on old code (no timing): the hub\'s legs still show, the box\'s say "?"', () => {
    expect(roundTrip({ queuedAt: 0, claimedAt: 0, endedAt: 5000 }, { submitAt: 0, followAt: 0, landedAt: 6000 })).toMatch(/round trip 6\.0 s: .* boot \? · render \? .* back here 1\.0 s$/);
  });
});

describe('a whole render in chunks over the farm (drift-farm-render.mjs chunksOf)', () => {
  // every chunk is cut on whole frames: drift-render.mjs counts round((to − from)·fps) frames, so a chunk boundary off
  // a frame would drop or double one at a seam — the joined show would be a frame short and everything after it late
  it('cuts [0, 770) at 30 fps into 20 s chunks of whole frames, the last one shorter, nothing lost or doubled', () => {
    const c = chunksOf(0, 770, 20, 30);
    expect(c).toHaveLength(39);
    expect(c[0]).toEqual({ from: 0, to: 20, frames: 600 });
    expect(c.at(-1)).toEqual({ from: 760, to: 770, frames: 300 });
    expect(c.reduce((a, x) => a + x.frames, 0)).toBe(770 * 30);
    for (let i = 1; i < c.length; i++) expect(c[i].from).toBe(c[i - 1].to);
    for (const x of c) expect(Math.round((x.to - x.from) * 30)).toBe(x.frames);
  });

  it('a range that starts mid-show and a chunk that is not a whole number of frames still meet exactly', () => {
    const c = chunksOf(745.8, 760, 4.01, 30);
    expect(c.reduce((a, x) => a + x.frames, 0)).toBe(Math.round((760 - 745.8) * 30));
    for (const x of c) expect(Math.round((x.to - x.from) * 30)).toBe(x.frames);
  });
});
