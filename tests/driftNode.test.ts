/**
 * The render node's one command (scripts/drift-node.mjs, its parts in drift-node-lib.mjs; docs/drift/RENDER-NODE.md).
 * A node is a machine nobody watches: what goes wrong there goes wrong for hours. These pin the rules whose failure
 * would not announce itself:
 *   - THE SOURCE: a Windows path (D:\…, D:/…, \\NAS\…) is a folder, never an SSH host named "D"; the Mac over SSH is
 *     user@host:/path; a remote path a shell would split is refused up front, not mis-copied.
 *   - CHANGED MEANS OTHER FILES: every publish rebuilds the bundle (new manifest date, new tarball bytes), so the
 *     identity is the file list — the same files in any order are the same bundle, and a node does not pull 1.4 GB
 *     for nothing; one changed file is another bundle.
 *   - THE FETCH: a copy is unpacked only after its sha256 is the source's, a pointer cannot name a file outside the
 *     bundle folder, a second sync of the same bundle copies nothing, and a half-copied tarball never stays.
 *   - THE PRESETS: each one is a queue drift-queue.mjs accepts (its own loader, in a dry run), with "to": "end" the
 *     show's length and the output in one folder per state of code and data.
 * Plus the Windows-editor JSON (a BOM, CRLF) and the nvidia-smi line the dashboard shows.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  contentId, decideBundle, needsLength, parseBundleSource, parseJsonc, parseNvidiaSmi, parseSet, readConfig, resolveJobs, stateLabel, syncBundle,
  type BundleRecord, type QueueSpec,
} from '../scripts/drift-node-lib.mjs';

const ROOT = join(__dirname, '..');
const BUNDLE_SCRIPT = join(ROOT, 'scripts/drift-bundle.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'drift-node-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('the bundle source', () => {
  it('a Windows drive or share is a folder: an SSH host "D" would fail every sync', () => {
    for (const p of ['D:\\Google Drive\\drift-bundle', 'D:/Google Drive/drift-bundle', 'C:drift', '\\\\NAS\\drift', '/mnt/nas/drift', 'relative/folder']) {
      expect(parseBundleSource(p)?.kind, p).toBe('folder');
    }
  });

  it('user@host:/path is the Mac over SSH, with the host for the dashboard', () => {
    const s = parseBundleSource('flo@flos-mac:/Users/flo/work/code/shiver-me-timbers/out/drift-bundle/');
    expect(s).toMatchObject({ kind: 'ssh', target: 'flo@flos-mac', host: 'flos-mac', path: '/Users/flo/work/code/shiver-me-timbers/out/drift-bundle' });
    expect(parseBundleSource('mac.tail1234.ts.net:~/drift-bundle')).toMatchObject({ kind: 'ssh', target: 'mac.tail1234.ts.net', path: '~/drift-bundle' });
  });

  it('a remote path with a space is refused: the remote shell would split it, and scp would fetch the wrong thing', () => {
    expect(() => parseBundleSource('flo@mac:/Users/flo/My Bundles')).toThrow(/characters/);
  });

  it('a URL is refused (a link is one step from public, and the bundle may never be)', () => {
    expect(() => parseBundleSource('https://example.com/drift-assets.tar.gz')).toThrow(/URL/);
  });

  it('no source is null (sync then prints what to put in drift-node.json)', () => {
    expect(parseBundleSource(undefined)).toBeNull();
    expect(parseBundleSource('  ')).toBeNull();
  });
});

describe('drift-node.json', () => {
  it('reads what Windows Notepad writes: a byte-order mark, CRLF, and comments', () => {
    const dir = mkdtempSync(join(scratch, 'cfg-'));
    writeFileSync(join(dir, 'drift-node.json'), '\uFEFF// the 4090 desktop\r\n{\r\n  "bundle": "D:\\\\Google Drive\\\\drift-bundle",\r\n  "name": "win-4090",\r\n}\r\n');
    const c = readConfig(dir, {});
    expect(c.bundle).toBe('D:\\Google Drive\\drift-bundle');
    expect(c.name).toBe('win-4090');
  });

  it('a typo in a key fails loud instead of silently using the default', () => {
    const dir = mkdtempSync(join(scratch, 'cfg-'));
    writeFileSync(join(dir, 'drift-node.json'), '{ "bundel": "x" }');
    expect(() => readConfig(dir, {})).toThrow(/unknown key "bundel"/);
  });

  it('the environment overrides the file for one shell', () => {
    const dir = mkdtempSync(join(scratch, 'cfg-'));
    expect(readConfig(dir, { DRIFT_BUNDLE_SRC: '/mnt/x', DRIFT_DASHBOARD: '0' })).toMatchObject({ bundle: '/mnt/x', dashboard: false });
  });

  it('parseJsonc keeps a // inside a string (a URL in a job)', () => {
    expect(parseJsonc('{ "dashboard": "http://mac:5190" }')).toEqual({ dashboard: 'http://mac:5190' });
  });
});

describe('when the bundle changed', () => {
  const files = [
    { path: 'public/drift/a.bin', bytes: 3, sha256: 'a'.repeat(64) },
    { path: 'public/drift/b.bin', bytes: 5, sha256: 'b'.repeat(64) },
  ];

  it('the same files in another order are the same bundle (a rebuild that changed nothing costs a node nothing)', () => {
    expect(contentId([...files].reverse())).toBe(contentId(files));
  });

  it('one changed file is another bundle', () => {
    expect(contentId([files[0], { ...files[1], sha256: 'c'.repeat(64) }])).not.toBe(contentId(files));
  });

  it('decides on the content id, not the tarball name', () => {
    const id = contentId(files);
    const p = { file: 'drift-assets-20261030.tar.gz', bytes: 10, sha256: 'f'.repeat(64), content: id };
    expect(decideBundle(p, id, { file: 'drift-assets-20261029.tar.gz' }).action).toBe('current');
    expect(decideBundle({ ...p, content: 'e'.repeat(64) }, id, null).action).toBe('fetch');
    expect(decideBundle(p, null, null).action).toBe('fetch');
  });

  it('a hand-copied folder without latest-assets.json: the same tarball by name, size and time, else fetch', () => {
    const id = contentId(files);
    const p = { file: 'drift-assets-20261029.tar.gz', bytes: 10, mtimeMs: 1000, fallback: true };
    const prev = { file: p.file, bytes: 10, mtimeMs: 1000, content: id };
    expect(decideBundle(p, id, prev).action).toBe('current');
    expect(decideBundle({ ...p, mtimeMs: 2000 }, id, prev).action).toBe('fetch');
    expect(decideBundle(p, id, null).action).toBe('fetch');
  });
});

/** a tiny asset bundle, built like drift-bundle.mjs's (files, then its manifest as the last entry), with the stock tar */
function makeBundle(dir: string, name: string, payload: Record<string, string>): { file: string; pointer: Record<string, unknown> } {
  const stage = mkdtempSync(join(scratch, 'stage-'));
  const list = Object.entries(payload).map(([path, text]) => {
    mkdirSync(join(stage, path, '..'), { recursive: true });
    writeFileSync(join(stage, path), text);
    return { path, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') };
  });
  const manifest = { bundle: 'assets', created: '2026-10-29T12:00:00.000Z', base: 'repo', commit: 'abc1234', bytes: list.reduce((a, f) => a + f.bytes, 0), count: list.length, files: list };
  mkdirSync(join(stage, 'out/drift-bundle'), { recursive: true });
  writeFileSync(join(stage, 'out/drift-bundle/manifest-assets.json'), JSON.stringify(manifest));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  const r = spawnSync('tar', ['-czf', file, '-C', stage, 'public', 'out'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  expect(r.status, String(r.stderr)).toBe(0);
  const bytes = new Uint8Array(readFileSync(file));
  const pointer = { bundle: 'assets', file: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), content: contentId(list), created: manifest.created, commit: 'abc1234', count: list.length, filesBytes: manifest.bytes };
  writeFileSync(join(dir, 'latest-assets.json'), JSON.stringify(pointer));
  return { file, pointer };
}

describe('syncBundle from a folder (the hand-copied Google Drive / USB case), into a scratch repo', () => {
  const src = join(scratch, 'share');
  const root = join(scratch, 'node');
  const quiet = () => {};
  let prev: BundleRecord | null = null;

  it('the first sync copies, checks, unpacks and verifies', async () => {
    makeBundle(src, 'drift-assets-20261029.tar.gz', { 'public/drift/earth/a.bin': 'earth', 'public/drift/pbr/b.txt': 'palm' });
    mkdirSync(root, { recursive: true });
    const r = await syncBundle({ root, source: { kind: 'folder', path: src, label: src }, say: quiet, bundleScript: BUNDLE_SCRIPT });
    expect(r.changed).toBe(true);
    expect(readFileSync(join(root, 'public/drift/earth/a.bin'), 'utf8')).toBe('earth');
    expect(existsSync(join(root, 'out/drift-bundle/drift-assets-20261029.tar.gz'))).toBe(true);
    prev = r.record;
  });

  it('the second sync of the same bundle copies nothing', async () => {
    rmSync(join(root, 'out/drift-bundle/drift-assets-20261029.tar.gz'));
    const r = await syncBundle({ root, source: { kind: 'folder', path: src, label: src }, prev, say: quiet, bundleScript: BUNDLE_SCRIPT });
    expect(r.changed).toBe(false);
    // (it did not fetch the tarball again: the one removed above stays gone)
    expect(existsSync(join(root, 'out/drift-bundle/drift-assets-20261029.tar.gz'))).toBe(false);
  });

  it('a dry run of a new bundle says it would fetch, and touches nothing', async () => {
    makeBundle(src, 'drift-assets-20261030.tar.gz', { 'public/drift/earth/a.bin': 'earth v2', 'public/drift/pbr/b.txt': 'palm' });
    const lines: string[] = [];
    const r = await syncBundle({ root, source: { kind: 'folder', path: src, label: src }, prev, dryRun: true, say: (l) => lines.push(l), bundleScript: BUNDLE_SCRIPT });
    expect(r.changed).toBe(true);
    expect(lines.join('\n')).toMatch(/would fetch/);
    expect(readFileSync(join(root, 'public/drift/earth/a.bin'), 'utf8')).toBe('earth');
  });

  it('a copy whose sha256 is not the pointer\'s is not unpacked, and no .part stays', async () => {
    const ptr = JSON.parse(readFileSync(join(src, 'latest-assets.json'), 'utf8'));
    writeFileSync(join(src, 'latest-assets.json'), JSON.stringify({ ...ptr, sha256: '0'.repeat(64) }));
    await expect(syncBundle({ root, source: { kind: 'folder', path: src, label: src }, prev, say: quiet, bundleScript: BUNDLE_SCRIPT })).rejects.toThrow(/not the source's/);
    expect(readFileSync(join(root, 'public/drift/earth/a.bin'), 'utf8')).toBe('earth');
    expect(existsSync(join(root, 'out/drift-bundle/drift-assets-20261030.tar.gz.part'))).toBe(false);
    writeFileSync(join(src, 'latest-assets.json'), JSON.stringify(ptr));
  });

  it('the new bundle replaces the old one, whose tarball is removed', async () => {
    writeFileSync(join(root, 'out/drift-bundle/drift-assets-20261029.tar.gz'), 'old');
    const r = await syncBundle({ root, source: { kind: 'folder', path: src, label: src }, prev, say: quiet, bundleScript: BUNDLE_SCRIPT });
    expect(r.changed).toBe(true);
    expect(readFileSync(join(root, 'public/drift/earth/a.bin'), 'utf8')).toBe('earth v2');
    expect(existsSync(join(root, 'out/drift-bundle/drift-assets-20261029.tar.gz'))).toBe(false);
    expect(r.record?.file).toBe('drift-assets-20261030.tar.gz');
  });

  it('a pointer naming a path outside the bundle folder is refused before anything is written', async () => {
    const ptr = JSON.parse(readFileSync(join(src, 'latest-assets.json'), 'utf8'));
    writeFileSync(join(src, 'latest-assets.json'), JSON.stringify({ ...ptr, file: '../../evil.tar.gz' }));
    await expect(syncBundle({ root, source: { kind: 'folder', path: src, label: src }, say: quiet, bundleScript: BUNDLE_SCRIPT })).rejects.toThrow(/not a drift-assets/);
    writeFileSync(join(src, 'latest-assets.json'), JSON.stringify(ptr));
  });
});

describe('the presets', () => {
  const presets = (parseJsonc(readFileSync(join(ROOT, 'scripts/drift-node-presets.jsonc'), 'utf8')) as { presets: Record<string, QueueSpec> }).presets;

  it('has the four the nodes are told to run', () => {
    expect(Object.keys(presets)).toEqual(expect.arrayContaining(['smoke', 'preview-2k', 'master-4k', 'master-8k']));
  });

  it('whole-show presets need the show\'s length, and fail without it rather than render a guess', () => {
    expect(needsLength(presets['preview-2k'])).toBe(true);
    expect(needsLength(presets.smoke)).toBe(false);
    expect(() => resolveJobs(presets['preview-2k'])).toThrow(/length/);
  });

  it('each one is a queue drift-queue.mjs accepts (its own loader, a dry run), ending at the show\'s end', () => {
    const out = join(scratch, 'renders', stateLabel('abc1234', false, 'f'.repeat(64)));
    for (const [name, spec] of Object.entries(presets)) {
      const q = resolveJobs(spec, { length: 770, out });
      for (const j of q.jobs) {
        expect(j.out, name).toBe(out);
        if (spec.jobs.some((s) => s.to === 'end')) expect(j.to, name).toBe(770);
      }
      const file = join(scratch, `queue-${name}.json`);
      writeFileSync(file, JSON.stringify(q));
      const r = spawnSync(process.execPath, [join(ROOT, 'scripts/drift-queue.mjs'), file, '--dry-run'], { encoding: 'utf8' });
      expect(r.status, `${name}: ${r.stderr}${r.stdout.slice(-400)}`).toBe(0);
    }
  });

  it('one folder per state: another commit, local edits or another bundle never resume an older render', () => {
    const a = stateLabel('abc1234', false, '1'.repeat(64));
    expect(new Set([a, stateLabel('def5678', false, '1'.repeat(64)), stateLabel('abc1234', true, '1'.repeat(64)), stateLabel('abc1234', false, '2'.repeat(64))]).size).toBe(4);
  });

  it('--set reaches every job, typed: msaa=0 is the number the queue checks, not the string "0"', () => {
    const set = parseSet(['msaa=0,ss=1', 'codec=ffv1']);
    expect(set).toEqual({ msaa: 0, ss: 1, codec: 'ffv1' });
    expect(resolveJobs(presets.smoke, { set }).jobs.every((j) => j.msaa === 0 && j.ss === 1)).toBe(true);
    expect(() => parseSet(['sss=1'])).toThrow(/not a job field/);
  });
});

describe('the heartbeat', () => {
  it('reads nvidia-smi\'s csv line as the dashboard shows it (MiB → GB)', () => {
    expect(parseNvidiaSmi('NVIDIA GeForce RTX 4090, 97, 18432, 24564\r\n')).toEqual({ name: 'NVIDIA GeForce RTX 4090', utilPct: 97, memUsedGB: 18, memTotalGB: 24 });
    expect(parseNvidiaSmi('')).toBeUndefined();
  });
});
