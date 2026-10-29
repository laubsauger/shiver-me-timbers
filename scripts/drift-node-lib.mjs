/**
 * THE RENDER NODE'S MOVING PARTS, for scripts/drift-node.mjs — the one command a studio machine runs to pull the
 * current state and render it (docs/drift/RENDER-NODE.md; the user, 2026-10-29: "easily pull from a single spot … and
 * then just run a single command to render our current state"). Apart from the command so tests/driftNode.test.ts
 * can run them on a scratch folder:
 *
 *   - drift-node.json, this machine's own config (gitignored), and the bundle source in it
 *   - THE ASSET BUNDLE: is the one at the source other than what is unpacked here; fetch it, check it, unpack it
 *   - a preset or a queue file → the jobs scripts/drift-queue.mjs runs (`"to": "end"` = the show's length)
 *   - the heartbeat to the studio dashboard (scripts/drift-dash.mjs: its header is the /report contract)
 *
 * Node built-ins only: `sync` runs these before `npm ci` has, on a fresh clone.
 *
 * WHERE THE BUNDLE COMES FROM (the user, 2026-10-29: SSH over Tailscale, the nodes pulling straight from the Mac, no
 * sync service in between):
 *   ssh     `user@host:/path` — the Mac's out/drift-bundle itself, over the OpenSSH client Windows 10/11 and Linux
 *           ship. First `ssh … cat <path>/latest-assets.json` (a few hundred bytes, written by drift-bundle.mjs beside
 *           the bundle), and only when that names other files than the ones unpacked here, `scp` of the .tar.gz
 *           (1.4 GB). BatchMode: a missing key fails at once with the fix instead of waiting at a password prompt
 *           nobody sees (a detached run).
 *   folder  a path: a bundle copied by hand to Google Drive, a USB disk, a NAS share ("I can just copy this thing
 *           manually over Google Drive"). Its latest-assets.json is read the same way; without one, the newest
 *           drift-assets-<date>.tar.gz there is taken, and compared by name, size and time with the one unpacked last.
 * (An https source was planned and dropped: a link is one step from public, and the bundle must never be.)
 *
 * "OTHER FILES" IS THE CONTENT, NOT THE TARBALL: the pointer carries `content`, a sha256 over the manifest's list of
 * (sha256, bytes, path) — the same for two builds of the same files, so a rebuild on the Mac that changed nothing
 * (every publish rebuilds: its manifest's date differs, so the .tar.gz's bytes do) costs the nodes nothing. The node
 * computes the same id from the manifest it unpacked (out/drift-bundle/manifest-assets.json), so a bundle unpacked by
 * hand before drift-node existed counts too. The tarball's own sha256 checks the copy.
 *
 * LICENCE: the bundle holds BlenderKit models that may not be passed on (drift-bundle.mjs). Its source must be
 * private — the Mac, or a folder only the owner reads. This repo is public: drift-node.json stays out of it.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, posix, relative, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const CONFIG_FILE = 'drift-node.json';
/** the pointer drift-bundle.mjs writes beside each bundle: { file, bytes, sha256, content, created, commit, … } */
export const pointerName = (target = 'assets') => `latest-${target}.json`;
const BUNDLE_FILE = /^drift-assets-\d{8}\.tar\.gz$/;
const HEX64 = /^[0-9a-f]{64}$/;
const mb = (b) => (b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(2)} GB` : `${(b / 2 ** 20).toFixed(0)} MB`);

// ------------------------------------------------------------------------------------------------- config
/**
 * JSON plus whole-line // comments and trailing commas (drift-queue.mjs's rules), and what Windows editors add: a
 * UTF-8 byte-order mark (Notepad) and CRLF line ends
 */
export function parseJsonc(text) {
  const clean = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n').replace(/,(\s*[\]}])/g, '$1');
  return JSON.parse(clean);
}

// ("yield": the shared-machine policy, read by drift-share.mjs readYieldPolicy, which checks its keys; "farm": the
// render farm, { hub, token } — drift-farm.mjs)
const CONFIG_KEYS = ['bundle', 'dashboard', 'name', 'renders', 'yield', 'farm'];

/**
 * this machine's config: drift-node.json in the repo root, each key overridable from the environment for one shell
 * (DRIFT_BUNDLE_SRC, DRIFT_DASHBOARD, DRIFT_NODE_NAME)
 *   bundle     the bundle source (above); null when not set
 *   dashboard  the studio dashboard's URL; undefined = the bundle's host on :5190; false or "" = no heartbeat
 *   name       this machine on the dashboard (default: its hostname)
 *   renders    where preset renders go (default out/drift/renders; an 8K master needs terabytes: a big disk)
 */
export function readConfig(root, env = process.env) {
  const file = join(root, CONFIG_FILE);
  let cfg = {};
  if (existsSync(file)) {
    try {
      cfg = parseJsonc(readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`${file} is not valid JSON (${e.message}). In JSON every \\ of a Windows path is written \\\\ — or write / instead: "D:/Google Drive/drift-bundle"`);
    }
    if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`${file}: an object, { "bundle": "…" }`);
    for (const k of Object.keys(cfg)) if (!CONFIG_KEYS.includes(k)) throw new Error(`${file}: unknown key "${k}" (it takes ${CONFIG_KEYS.join(', ')})`);
    // (the token is optional: a farm box is known to the hub by its tailnet address, drift-farm.mjs AUTH)
    const f = cfg.farm;
    if (f !== undefined && (f === null || typeof f !== 'object' || (f.token === undefined && f.hub === undefined) || (f.token !== undefined && (typeof f.token !== 'string' || f.token.length < 16)) || (f.hub !== undefined && !/^https?:\/\//.test(f.hub)))) {
      throw new Error(`${file}: "farm" is { "hub": "http://<mac>:5190" } (and, for a machine not in scripts/drift-farm-nodes.json, "token": "<the Mac's farm.json token>")`);
    }
  }
  const dash = env.DRIFT_DASHBOARD !== undefined ? env.DRIFT_DASHBOARD : cfg.dashboard;
  return {
    file,
    exists: existsSync(file),
    bundle: env.DRIFT_BUNDLE_SRC || cfg.bundle || null,
    dashboard: dash === undefined ? undefined : dash === false || dash === '' || dash === '0' ? false : String(dash),
    name: env.DRIFT_NODE_NAME || cfg.name || hostname(),
    renders: cfg.renders || 'out/drift/renders',
    farm: env.DRIFT_FARM_TOKEN || env.DRIFT_FARM_HUB ? { hub: env.DRIFT_FARM_HUB ?? cfg.farm?.hub, token: env.DRIFT_FARM_TOKEN ?? cfg.farm?.token } : cfg.farm ?? null,
  };
}

/**
 * the render farm's hub as a bundle source (the Windows boxes have no SSH: GET /farm/bundle/… with the farm token);
 * `hub` from "farm".hub, else the dashboard's URL
 */
export function farmSource(farm, hub) {
  const url = (farm?.hub ?? hub ?? '').replace(/\/+$/, '');
  if (!farm || !url) return null;
  return { kind: 'farm', hub: url, token: farm.token ?? null, label: `${url} (the farm hub)` };
}

/** what to put in drift-node.json, printed when there is none (or it has no "bundle") */
export function configHelp(root) {
  return `No bundle source on this machine. Create ${join(root, CONFIG_FILE)}
(gitignored: this machine's own, never committed — the repo is public) holding:

  { "bundle": "flo@<mac-tailnet-name>:/Users/flo/work/code/shiver-me-timbers/out/drift-bundle" }

That is the Mac over SSH on the tailnet, the usual way (one-time setup: docs/drift/RENDER-NODE.md, "SSH to the
Mac"). <mac-tailnet-name> is the Mac's name in Tailscale: \`tailscale status\` lists it.

Or a folder the bundle was copied into by hand (Google Drive, a USB disk, a NAS share), holding
drift-assets-<date>.tar.gz and latest-assets.json from the Mac's out/drift-bundle:

  Windows   { "bundle": "D:/Google Drive/drift-bundle" }     forward slashes work; with backslashes write each twice:
            { "bundle": "D:\\\\Google Drive\\\\drift-bundle" }   { "bundle": "\\\\\\\\NAS\\\\drift" }  (the share \\\\NAS\\drift)
  Linux     { "bundle": "/mnt/nas/drift" }   or   { "bundle": "/home/<you>/GoogleDrive/drift-bundle" }

DRIFT_BUNDLE_SRC=<source> does the same for one shell. Optional keys: "dashboard": "http://<mac-tailnet-name>:5190"
(default: the bundle's host), "name": "<this machine on the dashboard>" (default: its hostname), "renders": "<folder>"
(where preset renders go, default out/drift/renders; an 8K master needs terabytes).

The bundle holds BlenderKit models that may not be passed on: its source must be private — the Mac itself, or a
folder only you can open. Never a public share, never a link anyone can open, never git.`;
}

/**
 * the bundle source: { kind: 'ssh', target, path } for scp's [user@]host:/path, else { kind: 'folder', path }. A
 * Windows drive (C:\…, C:/…: one letter before the colon) and a UNC share (\\NAS\x) are folders.
 */
export function parseBundleSource(src) {
  if (typeof src !== 'string' || src.trim() === '') return null;
  const s = src.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) throw new Error(`bundle source ${s}: a URL is not a source — the Mac over SSH (user@host:/path) or a folder`);
  const m = /^(?:([^@\s:/\\]+)@)?([^@\s:/\\]{2,}):(.+)$/.exec(s);
  if (m && !s.startsWith('\\\\')) {
    const [, user, host, path] = m;
    // the remote path goes through the Mac's shell (ssh's command line; scp's legacy protocol on Windows 10's
    // OpenSSH 8.1): plain characters only, so neither splits nor expands it (a leading ~ is expanded, as wanted)
    if (!/^[\w./~+@-]+$/.test(path)) throw new Error(`bundle source ${s}: the remote path has characters (spaces, quotes, $ …) a shell would split or expand — keep the bundles under a plain path, or use a folder source`);
    return { kind: 'ssh', target: user ? `${user}@${host}` : host, host, path: path.replace(/(.)\/+$/, '$1'), label: s };
  }
  return { kind: 'folder', path: s, label: s };
}

/** the dashboard to report to: drift-node.json's, else the bundle's host on the dashboard's port; null = none */
export function dashboardUrl(cfg, source) {
  if (cfg.dashboard === false) return null;
  if (typeof cfg.dashboard === 'string') return cfg.dashboard.replace(/\/+$/, '');
  if (cfg.farm?.hub) return cfg.farm.hub.replace(/\/+$/, '');
  return source?.kind === 'ssh' ? `http://${source.host}:5190` : source?.kind === 'farm' ? source.hub : null;
}

// ------------------------------------------------------------------------------------------------- the bundle
/** the bundle's identity: a sha256 over its manifest's (sha256, bytes, path) list, in path order (header) */
export function contentId(files) {
  const h = createHash('sha256');
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const f of sorted) h.update(`${f.sha256} ${f.bytes} ${f.path}\n`);
  return h.digest('hex');
}

export async function sha256File(path) {
  const h = createHash('sha256');
  for await (const c of createReadStream(path)) h.update(c);
  return h.digest('hex');
}

/** the manifest of the asset bundle unpacked under `root`, or null */
export function installedManifest(root) {
  try {
    const m = JSON.parse(readFileSync(join(root, 'out/drift-bundle/manifest-assets.json'), 'utf8'));
    return Array.isArray(m.files) ? m : null;
  } catch {
    return null;
  }
}

/**
 * a child process, its output to `onLine` line by line (or straight to this terminal with `inherit`), never throwing:
 * { code, out, err } — a command that is not there comes back with code -1 and the reason in `err`. `onSpawn(child)`:
 * its pid (drift-node matches the queue's status.json to it)
 */
export function run(cmd, args, { cwd, env, inherit = false, onLine = null, shell = false, onSpawn = null } = {}) {
  return new Promise((res) => {
    let out = '';
    let err = '';
    let p;
    try {
      p = spawn(cmd, args, { cwd, env, shell, windowsHide: true, stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      res({ code: -1, out, err: String(e?.message ?? e) });
      return;
    }
    const lines = (which) => {
      let buf = '';
      return (d) => {
        const s = String(d);
        if (which === 'out') out = (out + s).slice(-1_000_000);
        else err = (err + s).slice(-200_000);
        if (!onLine) return;
        buf += s;
        const parts = buf.split(/\r?\n|\r/);
        buf = parts.pop();
        for (const l of parts) if (l.trim()) onLine(l);
      };
    };
    onSpawn?.(p);
    p.stdout?.on('data', lines('out'));
    p.stderr?.on('data', lines('err'));
    p.on('error', (e) => res({ code: -1, out, err: `${err}${e.message}` }));
    p.on('close', (code, signal) => res({ code: code ?? (signal ? 1 : 0), out, err }));
  });
}

const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];

/** what an ssh/scp failure means, in the words of the fix */
export function sshHint(err, target) {
  if (/not recognized|ENOENT|not found/i.test(err) && !/No such file/i.test(err)) return 'no OpenSSH client here: Windows 10/11 have it built in (Settings > System > Optional features > OpenSSH Client); Linux: sudo apt install openssh-client';
  if (/Host key verification failed/i.test(err)) return `this machine does not know the Mac's host key yet: run \`ssh ${target}\` once by hand and answer "yes"`;
  if (/Permission denied|publickey|Too many authentication/i.test(err)) return `the Mac does not take this machine's key: add its public key to the Mac's ~/.ssh/authorized_keys (RENDER-NODE.md, "SSH to the Mac"), then \`ssh ${target} echo ok\` must work without a password`;
  if (/Could not resolve|Name or service not known|No such host|nodename nor servname/i.test(err)) return 'the name does not resolve: is Tailscale up on this machine (`tailscale status`), and is that the Mac\'s tailnet name?';
  if (/timed out|Connection refused|No route|unreachable|Connection closed/i.test(err)) return 'the Mac is not reachable: is it awake and on the tailnet, with Remote Login on (System Settings > General > Sharing)?';
  if (/No such file/i.test(err)) return `nothing there: build the bundle on the Mac (node scripts/drift-bundle.mjs writes ${pointerName()} beside it), and check the path in drift-node.json`;
  return 'see the message above';
}

/** a pointer as read from a source, checked: its file name is a plain bundle name (it names a file we will write) */
function checkPointer(p, where) {
  if (p === null || typeof p !== 'object') throw new Error(`${where}: not a bundle pointer`);
  if (!BUNDLE_FILE.test(String(p.file))) throw new Error(`${where}: "file" ${JSON.stringify(p.file)} is not a drift-assets-<date>.tar.gz name`);
  if (!(Number.isFinite(p.bytes) && p.bytes > 0)) throw new Error(`${where}: no "bytes"`);
  if (!p.fallback && (!HEX64.test(String(p.sha256)) || !HEX64.test(String(p.content)))) throw new Error(`${where}: no sha256 / content (rebuild the bundle with the current drift-bundle.mjs)`);
  return p;
}

/**
 * the source's pointer to its newest asset bundle. ssh: `cat` of latest-assets.json on the Mac. Folder: its
 * latest-assets.json, else the newest drift-assets-<date>.tar.gz there ({ fallback: true }, no sha256 or content)
 */
export async function readPointer(source, root) {
  if (source.kind === 'farm') {
    const where = `${source.hub}/farm/bundle/${pointerName()}`;
    const r = await fetch(where, { headers: source.token ? { authorization: `Bearer ${source.token}` } : {}, signal: AbortSignal.timeout(10_000) }).catch((e) => ({ ok: false, status: 0, text: async () => String(e?.cause?.code ?? e.message) }));
    if (!r.ok) throw new Error(`cannot read ${where}: ${r.status} ${(await r.text()).slice(0, 200)}${r.status === 401 ? ' — the farm token in drift-node.json is not the Mac\'s (farm.json)' : r.status === 0 ? ' — is the Mac awake, its dashboard running with --tailnet, Tailscale up here?' : ''}`);
    return checkPointer(await r.json(), where);
  }
  if (source.kind === 'ssh') {
    const file = `${source.path}/${pointerName()}`;
    const r = await run('ssh', [...SSH_OPTS, source.target, 'cat', file]);
    if (r.code !== 0) throw new Error(`cannot read ${source.target}:${file} — ${r.err.trim().split('\n').slice(-2).join(' ') || `ssh exited ${r.code}`}\n  fix: ${sshHint(r.err, source.target)}`);
    // (a login script on the Mac that prints something would come before the JSON: take the object itself)
    const text = r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1);
    let p;
    try {
      p = JSON.parse(text);
    } catch {
      throw new Error(`${source.target}:${file} is not JSON: ${r.out.slice(0, 200)}`);
    }
    return checkPointer(p, `${source.target}:${file}`);
  }
  const dir = resolve(root, source.path);
  if (!existsSync(dir)) throw new Error(`bundle folder ${dir} not found — is the drive connected, the share mounted, Google Drive running and the folder synced to this machine?`);
  if (resolve(dir) === resolve(root, 'out/drift-bundle')) throw new Error(`bundle folder ${dir} is this repo's own out/drift-bundle: that is where bundles are built (the Mac) and fetched to, not a source`);
  const ptr = join(dir, pointerName());
  if (existsSync(ptr)) {
    let p;
    try {
      p = parseJsonc(readFileSync(ptr, 'utf8'));
    } catch (e) {
      throw new Error(`${ptr}: not JSON (${e.message})`);
    }
    checkPointer(p, ptr);
    if (!existsSync(join(dir, p.file))) throw new Error(`${ptr} names ${p.file}, which is not in ${dir} (yet: a cloud folder still syncing?)`);
    return p;
  }
  const tars = readdirSync(dir).filter((f) => BUNDLE_FILE.test(f)).sort();
  if (tars.length === 0) throw new Error(`no ${pointerName()} and no drift-assets-<date>.tar.gz in ${dir}`);
  const file = tars.at(-1);
  const st = statSync(join(dir, file));
  return checkPointer({ file, bytes: st.size, mtimeMs: Math.round(st.mtimeMs), fallback: true }, join(dir, file));
}

/**
 * fetch or not: 'current' when the files unpacked here are the source's (`installed` = their content id, or null),
 * else 'fetch'. Without the source's content id (a folder without latest-assets.json), the same tarball as the one
 * unpacked last (`prev`, from node-state.json) by name, size and modification time.
 */
export function decideBundle(pointer, installed, prev) {
  if (installed === null) return { action: 'fetch', why: 'no asset bundle unpacked here yet' };
  if (!pointer.fallback) return pointer.content === installed ? { action: 'current', why: 'the files unpacked here are the source\'s' } : { action: 'fetch', why: 'the source has other files than the ones unpacked here' };
  const same = prev && prev.file === pointer.file && prev.bytes === pointer.bytes && prev.mtimeMs === pointer.mtimeMs && prev.content === installed;
  return same
    ? { action: 'current', why: `the same ${pointer.file} as last time (no ${pointerName()} at the source: compared by name, size and time)` }
    : { action: 'fetch', why: `${pointer.file} at the source is not the one unpacked here last (no ${pointerName()} there: compared by name, size and time)` };
}

/** a stream copy that says how far it is every few seconds (a 1.4 GB copy off a NAS or a cloud folder is minutes) */
async function copyWithProgress(src, dst, total, say) {
  let n = 0;
  let last = Date.now();
  const count = new Transform({
    transform(chunk, _enc, cb) {
      n += chunk.length;
      if (Date.now() - last > 5000) {
        last = Date.now();
        say(`  copied ${mb(n)} of ${mb(total)}`);
      }
      cb(null, chunk);
    },
  });
  await pipeline(createReadStream(src), count, createWriteStream(dst));
}

/**
 * MAKE THE ASSET BUNDLE UNDER `root` THE SOURCE'S: read the pointer, decide, and when it differs fetch the .tar.gz to
 * root/out/drift-bundle (a .part until its sha256 is the pointer's), unpack it in root with the stock tar (Windows
 * 10/11 ship bsdtar as tar.exe), and verify it with drift-bundle.mjs --verify --quick. A bundle that is current is
 * still verified (sizes only, a second): an unpack interrupted earlier is found and redone.
 *
 *   { root, source, prev, dryRun, say, bundleScript, tar }   → { changed, record } (record: node-state.json's
 *   "bundle"), or throws with the fix. `tar`: the tar to run (default `tar` on PATH; drift-node.mjs passes Windows'
 *   own, so a GNU tar that Git for Windows put first on PATH, which reads C: as a host name, is not the one used).
 */
export async function syncBundle({ root, source, prev = null, dryRun = false, say = console.log, bundleScript, tar = 'tar' }) {
  const bundleDir = join(root, 'out/drift-bundle');
  const pointer = await readPointer(source, root);
  const where = source.kind === 'ssh' ? `${source.target}:${source.path}` : source.kind === 'farm' ? `${source.hub}/farm/bundle` : resolve(root, source.path);
  say(`  source: ${where}/${pointer.file} (${mb(pointer.bytes)}${pointer.created ? `, built ${pointer.created.slice(0, 16).replace('T', ' ')}` : ''}${pointer.commit ? ` at ${pointer.commit}` : ''})`);
  const man = installedManifest(root);
  const installed = man ? contentId(man.files) : null;
  let d = decideBundle(pointer, installed, prev);
  const verify = async () => {
    const r = await run(process.execPath, [bundleScript, '--verify', join(bundleDir, 'manifest-assets.json'), '--base', root, '--quick'], { onLine: (l) => say(`  ${l}`) });
    return r.code === 0;
  };
  if (d.action === 'current') {
    say(`  current: ${d.why}`);
    if (dryRun) return { changed: false, record: prev };
    if (await verify()) return { changed: false, record: prev ?? recordOf(pointer, man, installed, source, null) };
    d = { action: 'fetch', why: 'the files unpacked here do not match their manifest (an interrupted unpack?): unpacking again' };
  }
  say(`  ${dryRun ? 'would fetch' : 'fetching'}: ${d.why}`);
  if (dryRun) return { changed: true, record: prev };

  mkdirSync(bundleDir, { recursive: true });
  const local = join(bundleDir, pointer.file);
  // the tarball may be here already (an unpack that failed after the copy): reuse it when it is the source's
  let have = false;
  if (!pointer.fallback && existsSync(local) && statSync(local).size === pointer.bytes) have = (await sha256File(local)) === pointer.sha256;
  if (have) say(`  ${pointer.file} is here already (sha256 matches): not copied again`);
  else {
    // room for the tarball and its files unpacked (they overwrite the old ones, so this asks for more than it takes)
    const st = statfsSync(bundleDir);
    const need = pointer.bytes + (pointer.filesBytes ?? 1.3 * pointer.bytes) + 2 * 2 ** 30;
    if (st.bavail * st.bsize < need) throw new Error(`not enough disk under ${bundleDir}: ${mb(st.bavail * st.bsize)} free, the bundle needs about ${mb(need)} (tarball, unpacked files, 2 GB to spare)`);
    const part = `${local}.part`;
    rmSync(part, { force: true });
    const t0 = Date.now();
    if (source.kind === 'farm') {
      say(`  fetching ${source.hub}/farm/bundle/${pointer.file} (${mb(pointer.bytes)})`);
      const r = await fetch(`${source.hub}/farm/bundle/${pointer.file}`, { headers: source.token ? { authorization: `Bearer ${source.token}` } : {}, signal: AbortSignal.timeout(3_600_000) });
      if (!r.ok) throw new Error(`fetching ${pointer.file} from the farm hub: ${r.status}`);
      const { Readable } = await import('node:stream');
      const src = Readable.fromWeb(r.body);
      let n = 0;
      let last = Date.now();
      src.on('data', (c) => {
        n += c.length;
        if (Date.now() - last > 5000) {
          last = Date.now();
          say(`  fetched ${mb(n)} of ${mb(pointer.bytes)}`);
        }
      });
      await pipeline(src, createWriteStream(part));
    } else if (source.kind === 'ssh') {
      // scp's own progress meter when this is a terminal (inherit); relative names in the bundle folder, so a
      // Windows drive letter is never read as a host (C:…) and spaces in this machine's path never reach a shell
      say(`  scp ${source.target}:${source.path}/${pointer.file} (${mb(pointer.bytes)})`);
      const r = await run('scp', [...SSH_OPTS, `${source.target}:${source.path}/${pointer.file}`, `${pointer.file}.part`], { cwd: bundleDir, inherit: true });
      if (r.code !== 0 || !existsSync(part)) {
        rmSync(part, { force: true });
        throw new Error(`scp of ${pointer.file} failed (exit ${r.code})\n  fix: ${sshHint(r.err, source.target)} (scp's own message is above)`);
      }
    } else {
      say(`  copying ${join(where, pointer.file)} (${mb(pointer.bytes)})`);
      await copyWithProgress(join(where, pointer.file), part, pointer.bytes, say);
    }
    const size = statSync(part).size;
    const sha = await sha256File(part);
    if (size !== pointer.bytes || (!pointer.fallback && sha !== pointer.sha256)) {
      rmSync(part, { force: true });
      throw new Error(`the copy of ${pointer.file} is not the source's (${size} bytes, sha256 ${sha.slice(0, 12)}…; the source said ${pointer.bytes}${pointer.sha256 ? `, ${pointer.sha256.slice(0, 12)}…` : ''}) — rebuilt on the Mac while it copied? Run sync again`);
    }
    renameSync(part, local);
    say(`  copied in ${((Date.now() - t0) / 1000).toFixed(0)} s, sha256 checked`);
  }
  // the manifest is the archive's LAST entry: removed first, an unpack cut short leaves none, and the next sync redoes it
  rmSync(join(bundleDir, 'manifest-assets.json'), { force: true });
  const t1 = Date.now();
  say(`  unpacking ${pointer.file} in ${root}`);
  const tr = await run(tar, ['-xzf', relative(root, local).split(sep).join(posix.sep)], { cwd: root, onLine: (l) => say(`  tar: ${l}`) });
  if (tr.code !== 0) throw new Error(`tar -xzf ${pointer.file} failed (exit ${tr.code}): ${tr.err.trim().split('\n').slice(-2).join(' ')}`);
  const now = installedManifest(root);
  if (now === null) throw new Error(`${pointer.file} unpacked without its manifest (out/drift-bundle/manifest-assets.json): not an asset bundle?`);
  const content = contentId(now.files);
  if (!pointer.fallback && content !== pointer.content) throw new Error(`${pointer.file}'s manifest is not the one ${pointerName()} describes — rebuilt on the Mac between the two reads? Run sync again`);
  say(`  unpacked ${now.count} files, ${mb(now.bytes)}, in ${((Date.now() - t1) / 1000).toFixed(0)} s`);
  if (!(await verify())) throw new Error('the unpacked files do not match the bundle\'s manifest (lines above): disk full, or a file in use?');
  // the tarball fetched before this one is only disk now (this one stays: an unpack can be redone without a copy)
  if (prev?.file && prev.file !== pointer.file) rmSync(join(bundleDir, prev.file), { force: true });
  return { changed: true, record: recordOf(pointer, now, content, source, local) };
}

function recordOf(pointer, man, content, source, local) {
  return {
    file: pointer.file, bytes: pointer.bytes, sha256: pointer.sha256 ?? null, mtimeMs: pointer.mtimeMs ?? null, content,
    created: man?.created ?? pointer.created ?? null, commit: man?.commit ?? pointer.commit ?? null,
    source: source.label, at: new Date().toISOString(), ...(local ? { local } : {}),
  };
}

/** "20261029" from drift-assets-20261029.tar.gz, else the manifest's date */
export const bundleStamp = (rec) => /(\d{8})/.exec(rec?.file ?? '')?.[1] ?? rec?.created?.slice(0, 10).replace(/-/g, '') ?? null;

// --------------------------------------------------------------------------------------------------- the jobs
/** the fields a queue job takes (drift-queue.mjs DEFAULTS, plus name/from/to/size/out/extra/enabled) */
export const JOB_FIELDS = ['name', 'from', 'to', 'size', 'fps', 'ss', 'blur', 'shutter', 'codec', 'depth', 'lanes', 'chunk', 'channel', 'crf', 'preset', 'inflight', 'queue', 'query', 'allowLanes', 'concat', 'out', 'extra', 'enabled', 'msaa'];

/** `--set k=v[,k=v]` (repeatable) → { k: v }: numbers, booleans and JSON as such, anything else a string */
export function parseSet(list) {
  const out = {};
  for (const item of list.flatMap((s) => s.split(','))) {
    if (!item.trim()) continue;
    const eq = item.indexOf('=');
    if (eq <= 0) throw new Error(`--set ${item}: key=value`);
    const k = item.slice(0, eq).trim();
    const raw = item.slice(eq + 1).trim();
    if (!JOB_FIELDS.includes(k) || k === 'name') throw new Error(`--set ${k}: not a job field (${JOB_FIELDS.filter((f) => f !== 'name').join(' ')})`);
    let v = raw;
    try {
      v = JSON.parse(raw);
    } catch {
      // a plain word (a codec, a path)
    }
    out[k] = v;
  }
  return out;
}

/**
 * a preset or a queue file's { defaults, jobs } → the queue file drift-queue.mjs runs: `set` over every job, `"to":
 * "end"` → `length` (s, the show's), and with `out` (presets) every job's output under that folder
 */
export function resolveJobs(spec, { length = null, out = null, set = {} } = {}) {
  if (!Array.isArray(spec?.jobs) || spec.jobs.length === 0) throw new Error('no "jobs"');
  const jobs = spec.jobs.map((j0) => {
    const j = { ...j0, ...set };
    if (out !== null && set.out === undefined) j.out = out;
    if (j.to === 'end') {
      if (!Number.isFinite(length)) throw new Error(`job ${j.name}: "to": "end" needs the show's length`);
      j.to = length;
    }
    return j;
  });
  return { ...(spec.defaults ? { defaults: spec.defaults } : {}), jobs };
}

/** does a spec need the show's length */
export const needsLength = (spec, set = {}) => set.to === 'end' || (set.to === undefined && (spec?.jobs ?? []).some((j) => j.to === 'end'));

/** the folder name of one code + data state: commit, "-dirty" for local edits, the bundle's content id */
export const stateLabel = (commit, dirty, content) => `${commit}${dirty ? '-dirty' : ''}-${content ? content.slice(0, 6) : 'nobundle'}`;

// --------------------------------------------------------------------------------------------- the heartbeat
/** the queue's status.json (drift-queue.mjs) → the report's job */
export function jobOfQueueStatus(st) {
  const j = st?.job;
  if (!j) return undefined;
  return { name: j.name, chunk: j.chunk, chunks: j.chunks, frames: j.frames, framesTotal: j.framesTotal, fps: j.fps ?? undefined, etaS: j.etaS ?? undefined, out: j.out };
}

/**
 * every `everyMs` (and at once on `beat()`), POST `payload()` to <url>/report. Fire and forget: a 2 s timeout, any
 * failure ignored (the Mac may be asleep or off the tailnet) — it never stops, slows or fails a render. The timer is
 * unref'd: it never keeps a finished process alive. `stop()` sends the last one and waits for it (≤ 2 s).
 */
export function startHeartbeat(url, payload, everyMs = 5000) {
  const send = () => {
    if (!url) return Promise.resolve();
    let body;
    try {
      body = JSON.stringify(payload());
    } catch {
      return Promise.resolve();
    }
    return fetch(`${url}/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(2000) }).then(
      (r) => r.ok,
      () => false,
    );
  };
  const timer = url ? setInterval(send, everyMs) : null;
  timer?.unref();
  return {
    url,
    beat: send,
    stop: async () => {
      if (timer) clearInterval(timer);
      return send();
    },
  };
}
