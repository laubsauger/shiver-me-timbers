/**
 * The asset bundle, patched file by file (scripts/drift-node-lib.mjs patchBundle; the hub's GET /farm/bundle/manifest
 * and /farm/bundle/file in scripts/drift-farm.mjs). The user, 2026-10-30: "make sure the bundle can be incrementally
 * patched instead of having to upload the whole huge thing all the time … wasteful and takes forever if you just
 * change a little asset". What must hold, because a render box with a wrong file renders a wrong film without a word:
 *   - ONLY WHAT DIFFERS MOVES: a changed or missing file is fetched, an unchanged one is not (and not even re-hashed
 *     the second time), a file the old manifest held and the new one drops is removed, a file no manifest of ours held
 *     is never touched.
 *   - NOTHING HALF-WRITTEN: a fetch cut short leaves the old file and the old manifest in place (the next sync patches
 *     again, resuming the .part); a garbled transfer is caught by its sha256 and fetched again; a file that changed on
 *     the box behind the index's back is found and replaced.
 *   - THE DOOR: the hub serves only the files its manifest lists, from inside the checkout; a box writes only under
 *     public/, whatever a manifest says.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFarmHub } from '../scripts/drift-farm.mjs';
import { bundlePath, contentId, installedManifest, patchBundle } from '../scripts/drift-node-lib.mjs';

const TOKEN = 'a-token-of-twenty-four-ch';
const scratch = mkdtempSync(join(tmpdir(), 'drift-bundle-patch-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const sha = (b: string) => createHash('sha256').update(b).digest('hex');
const put = (root: string, rel: string, body: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
};
const entry = (rel: string, body: string) => ({ path: rel, bytes: Buffer.byteLength(body), sha256: sha(body) });
const manifestOf = (files: Record<string, string>) => ({ bundle: 'assets', created: '2026-10-30T00:00:00Z', files: Object.entries(files).map(([p, b]) => entry(p, b)) });

// the Mac: its checkout (the files) and out/drift-bundle (the manifest the hub serves)
const mac = join(scratch, 'mac');
const bundleDir = join(mac, 'out/drift-bundle');
const NEW = {
  'public/drift/pbr/rock/rock.glb': 'rock v1 — unchanged',
  'public/drift/pbr/lamp/lamp.glb': 'lamp v2, the new tower lamp', // changed (the box has v1)
  'public/drift/pbr/float/float.glb': 'a model the box has never had', // new
  'public/drift/big.bin': 'x'.repeat(200_000), // big enough to be cut short in the middle
};
const OLD = {
  'public/drift/pbr/rock/rock.glb': NEW['public/drift/pbr/rock/rock.glb'],
  'public/drift/pbr/lamp/lamp.glb': 'lamp v1, the old one!!!!!!', // same length as nothing in particular
  'public/drift/pbr/gone/gone.glb': 'dropped from the bundle',
  'public/drift/big.bin': NEW['public/drift/big.bin'],
};
const publish = (files: Record<string, string>) => {
  for (const [p, b] of Object.entries(files)) put(mac, p, b);
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(join(bundleDir, 'manifest-assets.json'), JSON.stringify(manifestOf(files)));
};

let server: Server;
let hubUrl = '';
let hub: ReturnType<typeof createFarmHub>;
beforeAll(async () => {
  publish(NEW);
  hub = createFarmHub({ dir: join(scratch, 'farm'), token: TOKEN, bundleDir, assetsRoot: mac, allow: () => true, hints: () => [] });
  server = createServer((req, res) => void hub.handle(req, res, new URL(req.url ?? '/', 'http://x')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const a = server.address();
  hubUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});
afterAll(() => {
  hub.close();
  server.close();
});
const source = () => ({ kind: 'farm' as const, hub: hubUrl, token: TOKEN, label: 'test hub' });

// a render box: the old bundle installed (its manifest too), and a file of its own that no manifest names
let box = '';
let n = 0;
const quiet = () => {};
beforeEach(() => {
  box = join(scratch, `box${n++}`);
  for (const [p, b] of Object.entries(OLD)) put(box, p, b);
  put(box, 'public/drift/pbr/mine/notes.txt', 'the box\'s own file');
  put(box, 'out/drift-bundle/manifest-assets.json', JSON.stringify(manifestOf(OLD)));
});
const read = (rel: string) => readFileSync(join(box, rel), 'utf8');

describe('only what differs moves', () => {
  it('fetches the changed and the new file, removes the dropped one, leaves the rest and the box\'s own file alone', async () => {
    const p = await patchBundle({ root: box, source: source(), old: installedManifest(box), say: quiet });
    expect(p).not.toBeNull();
    expect(p!.files).toBe(2);
    expect(p!.bytes).toBe(Buffer.byteLength(NEW['public/drift/pbr/lamp/lamp.glb']) + Buffer.byteLength(NEW['public/drift/pbr/float/float.glb']));
    expect(p!.removed).toBe(1);
    expect(read('public/drift/pbr/lamp/lamp.glb')).toBe(NEW['public/drift/pbr/lamp/lamp.glb']);
    expect(read('public/drift/pbr/float/float.glb')).toBe(NEW['public/drift/pbr/float/float.glb']);
    expect(existsSync(join(box, 'public/drift/pbr/gone/gone.glb'))).toBe(false);
    expect(read('public/drift/pbr/mine/notes.txt')).toBe('the box\'s own file');
    // the installed manifest is the hub's now: the job's bundle id matches
    expect(contentId(installedManifest(box)!.files)).toBe(contentId(manifestOf(NEW).files));
    expect(p!.content).toBe(contentId(manifestOf(NEW).files));
  });

  it('a second sync moves nothing and hashes nothing (the index remembers each file by size and time)', async () => {
    await patchBundle({ root: box, source: source(), old: installedManifest(box), say: quiet });
    const again = await patchBundle({ root: box, source: source(), old: installedManifest(box), say: quiet });
    expect(again).toMatchObject({ files: 0, bytes: 0, removed: 0, hashed: 0 });
  });
});

describe('nothing half-written', () => {
  it('a file changed on the box behind the index\'s back (same size) is found and fetched again', async () => {
    await patchBundle({ root: box, source: source(), old: installedManifest(box), say: quiet });
    const rock = NEW['public/drift/pbr/rock/rock.glb'];
    put(box, 'public/drift/pbr/rock/rock.glb', 'X'.repeat(Buffer.byteLength(rock))); // same size, new time
    const p = await patchBundle({ root: box, source: source(), old: installedManifest(box), say: quiet });
    expect(p!.files).toBe(1);
    expect(read('public/drift/pbr/rock/rock.glb')).toBe(rock);
  });

  it('a garbled transfer fails its sha256 and is fetched again; the file is right in the end', async () => {
    let garbled = 0;
    const flaky: typeof fetch = async (url, init) => {
      const r = await fetch(url, init);
      if (!String(url).includes('lamp.glb') || garbled++ > 0) return r;
      const body = Buffer.from(await r.arrayBuffer());
      body[0] ^= 0xff; // one flipped byte on the way
      return new Response(new Uint8Array(body), { status: r.status, headers: r.headers });
    };
    const lines: string[] = [];
    const p = await patchBundle({ root: box, source: source(), old: installedManifest(box), say: (l) => lines.push(l), fetchImpl: flaky });
    expect(garbled).toBe(2);
    expect(lines.some((l) => /lamp\.glb: .*sha256.*fetching it again/.test(l))).toBe(true);
    expect(p!.files).toBe(2);
    expect(read('public/drift/pbr/lamp/lamp.glb')).toBe(NEW['public/drift/pbr/lamp/lamp.glb']);
  });

  it('a fetch cut short leaves the old file and the old manifest; the next sync resumes the .part and finishes', async () => {
    // the big file differs on this box (so it is fetched), and every fetch of it dies after 40 000 bytes: the first
    // try and patchBundle's second (which resumes the first's .part) both fail, the sync fails loud
    put(box, 'public/drift/big.bin', 'y'.repeat(200_000));
    const cut: typeof fetch = async (url, init) => {
      const r = await fetch(url, init);
      if (!String(url).includes('big.bin')) return r;
      const body = Buffer.from(await r.arrayBuffer());
      let sent = false;
      const stream = new ReadableStream({
        // (the break a moment after the bytes, as on a real line: what came is on disk by then)
        async pull(c) {
          if (sent) return new Promise<void>((ok) => setTimeout(ok, 50)).then(() => c.error(new Error('connection reset')));
          sent = true;
          c.enqueue(new Uint8Array(body.subarray(0, 40_000)));
        },
      });
      return new Response(stream, { status: r.status, headers: r.headers });
    };
    const before = readFileSync(join(box, 'out/drift-bundle/manifest-assets.json'), 'utf8');
    await expect(patchBundle({ root: box, source: source(), old: installedManifest(box), say: quiet, fetchImpl: cut, parallel: 1 })).rejects.toThrow(/connection reset/);
    expect(read('public/drift/big.bin')).toBe('y'.repeat(200_000)); // the old bytes, never half of the new ones
    expect(readFileSync(join(box, 'out/drift-bundle/manifest-assets.json'), 'utf8')).toBe(before);
    expect(existsSync(join(box, 'public/drift/big.bin.part'))).toBe(true);
    // the next sync: a Range from where the .part ends, and the whole file checked
    let ranged = '';
    const watch: typeof fetch = async (url, init) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      if (String(url).includes('big.bin')) ranged = h.range ?? '';
      return fetch(url, init);
    };
    const p = await patchBundle({ root: box, source: source(), old: installedManifest(box), say: quiet, fetchImpl: watch });
    expect(ranged).toBe('bytes=80000-');
    expect(p!.bytes).toBeLessThan(120_000 + 100); // (only the rest of the big file moved, plus the two small ones)
    expect(read('public/drift/big.bin')).toBe(NEW['public/drift/big.bin']);
    expect(existsSync(join(box, 'public/drift/big.bin.part'))).toBe(false);
    expect(contentId(installedManifest(box)!.files)).toBe(contentId(manifestOf(NEW).files));
  });
});

describe('the door', () => {
  const get = (path: string, headers: Record<string, string> = {}) => fetch(`${hubUrl}${path}`, { headers: { authorization: `Bearer ${TOKEN}`, ...headers } });

  it('serves a manifest file with its sha256, and a Range of it', async () => {
    const rel = 'public/drift/pbr/lamp/lamp.glb';
    const r = await get(`/farm/bundle/file?path=${encodeURIComponent(rel)}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('x-sha256')).toBe(sha(NEW[rel]));
    expect(await r.text()).toBe(NEW[rel]);
    const part = await get(`/farm/bundle/file?path=${encodeURIComponent(rel)}`, { range: 'bytes=5-' });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe(NEW[rel].slice(5));
  });

  it('refuses any file its manifest does not list: the checkout\'s code, the token file, a path out of the checkout', async () => {
    put(mac, 'farm.json', '{"token":"secret"}');
    put(mac, 'scripts/x.mjs', 'code');
    for (const p of ['farm.json', 'scripts/x.mjs', '../mac/farm.json', 'public/drift/../../farm.json', '/etc/passwd']) {
      expect((await get(`/farm/bundle/file?path=${encodeURIComponent(p)}`)).status, p).toBe(404);
    }
    expect((await fetch(`${hubUrl}/farm/bundle/file?path=public/drift/big.bin`)).status).toBe(401); // no token
  });

  it('a file changed on the Mac since its manifest is refused before a byte moves (409: publish again)', async () => {
    const rel = 'public/drift/pbr/float/float.glb';
    put(mac, rel, `${NEW[rel]} and more`);
    const r = await get(`/farm/bundle/file?path=${encodeURIComponent(rel)}`);
    expect(r.status).toBe(409);
    expect(await r.text()).toMatch(/--manifest-only/);
    put(mac, rel, NEW[rel]);
  });

  it('a box writes only under public/, whatever a manifest says', async () => {
    expect(bundlePath('public/drift/a.glb')).toBe('public/drift/a.glb');
    for (const p of ['scripts/drift-node.mjs', 'public/../scripts/x.mjs', '/public/a', 'public\\drift\\a', 'C:/public/a', 'public//a']) expect(bundlePath(p), p).toBeNull();
    const evil: typeof fetch = async (url, init) =>
      String(url).endsWith('/farm/bundle/manifest') ? new Response(JSON.stringify({ files: [entry('scripts/drift-node.mjs', 'pwned')] })) : fetch(url, init);
    await expect(patchBundle({ root: box, source: source(), old: installedManifest(box), say: quiet, fetchImpl: evil })).rejects.toThrow(/may not write/);
    expect(existsSync(join(box, 'scripts/drift-node.mjs'))).toBe(false);
  });
});
