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
  createFarmHub, farmToken, gitIgnoreState, holdReason, jobClass, jobKind, landingPath, learn, LEASE_MS, PATIENCE_MS, pickWorker, safeRel, speedOf, transition,
} from '../scripts/drift-farm.mjs';
import { applyState, assetOverlay, packState, progressOf, remapArgv, removeTree, resolveArgv } from '../scripts/drift-farm-client.mjs';

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
});

describe('who gets what', () => {
  const fast = { node: 'windows-monster', speed: 1 };
  const slow = { node: 'eeg-msi', speed: 0.5 };

  it('a still goes to whoever asks', () => {
    expect(pickWorker({ kind: 'still', createdAt: 0 }, [slow], [slow, fast], 1000)).toBe('eeg-msi');
  });

  it('a clip waits for the fastest free box rather than going to the slow laptop at once', () => {
    expect(pickWorker({ kind: 'clip', queuedAt: 0 }, [slow], [slow, fast], 1000)).toBeNull();
    expect(pickWorker({ kind: 'clip', queuedAt: 0 }, [slow, fast], [slow, fast], 1000)).toBe('windows-monster');
  });

  it('… but not for ever: after the patience the slower box takes it', () => {
    expect(pickWorker({ kind: 'long', queuedAt: 0 }, [slow], [slow, fast], PATIENCE_MS + 1)).toBe('eeg-msi');
  });

  it('a job pinned to a box goes only there', () => {
    expect(pickWorker({ kind: 'clip', prefer: 'eeg-msi', queuedAt: 0 }, [fast], [fast], 1000)).toBeNull();
    expect(pickWorker({ kind: 'clip', prefer: 'eeg-msi', queuedAt: 0 }, [fast, slow], [fast, slow], 1000)).toBe('eeg-msi');
  });

  it('a held job says why, in words the dashboard shows', () => {
    const w = (node: string, state: string, speed: number, why: string | null = null) => ({ node, state, speed, why });
    expect(holdReason({ kind: 'clip', queuedAt: 0 }, [w('windows-monster', 'offline', 1), w('eeg-msi', 'offline', 0.5)], 0)).toBe('no worker online');
    expect(holdReason({ kind: 'clip', queuedAt: 0 }, [w('windows-monster', 'busy-foreign', 1, 'ComfyUI 18 GB'), w('eeg-msi', 'offline', 0.5)], 0)).toBe('windows-monster busy (ComfyUI 18 GB), eeg-msi offline');
    expect(holdReason({ kind: 'clip', queuedAt: 0 }, [w('windows-monster', 'busy', 1), w('eeg-msi', 'waiting', 0.5)], 30_000)).toBe(`waiting for a faster box (windows-monster busy with another job); eeg-msi takes it in ${PATIENCE_MS / 1000 - 30} s`);
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
    // the box's own checkout did not change
    expect(sh(box, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    // and deleting the job's folder leaves the checkout's packages and bundle file alone
    removeTree(jobDir);
    expect(existsSync(jobDir)).toBe(false);
    expect(readFileSync(join(box, 'node_modules', 'three', 'index.js'), 'utf8')).toBe('module.exports = 3');
    expect(readFileSync(join(box, 'public', 'drift', 'sand.png'), 'utf8')).toBe('SAND');
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
