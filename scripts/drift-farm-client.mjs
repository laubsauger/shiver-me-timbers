/**
 * THE DRIFT FARM, its two clients (the hub is scripts/drift-farm.mjs, on this Mac's dashboard):
 *
 *   SUBMIT (scripts/drift-slot.mjs --farm, on the Mac): a command that would run in a local render slot goes to a
 *   studio box instead, and its results land at the same local paths, as if it had run here. The agent that started
 *   it sees the remote output on its own stdout. What goes with it:
 *     - THE CODE STATE: `git diff --binary <base>` (base = origin/main, a commit the boxes can fetch; the diff holds
 *       committed-but-unpushed work as well as what is not committed) and the untracked, not ignored files under
 *       src/ scripts/ tests/ public/ (not public/drift). Every frame is a pure function of show time t, so the same
 *       state renders the same anywhere — up to the GPU vendor's arithmetic: the job says which box drew it.
 *     - THE ASSETS a box's bundle lacks: files under public/ that the bundle would hold now (drift-bundle.mjs
 *       --list-json) but the Mac's last bundle (out/drift-bundle/manifest-assets.json, what the boxes sync) does not,
 *       or holds otherwise. Up to 200 MB of them travel with the job; more fails loud: rebuild the bundle and let the
 *       boxes sync.
 *     - THE INPUTS: every argument that is a file outside the code (a shots.json in a scratchpad, a --setup file) is
 *       uploaded and its path rewritten; every --out path is mapped to a folder of the job's on the box, and what the
 *       box writes there comes back to the --out path here. Paths inside a JSON input are not rewritten.
 *
 *   WORK (scripts/drift-node.mjs worker, on each box): claims a job only while the GPU is free of others' work
 *   (drift-share.mjs shareDecision), then
 *     - a fresh code tree per job, ../smt-farm/<job>/tree beside the checkout: `git fetch`, `git archive <base>`
 *       unpacked, the job's patch applied (`git apply`, with git kept from finding the checkout's repository above),
 *       its files copied in. Not a `git worktree` reset between jobs: a reset discards whatever is there, and the repo's
 *       rule is that nothing runs a discarding git command. A finished tree is deleted as a folder of our own;
 *     - the asset bundle: hard links to the checkout's synced files (no copy, no change to them: nothing writes
 *       into a linked file, the job's own asset files are copied in first), node_modules: a folder of links to the
 *       checkout's packages (npm ci into a cache only when the job's lockfile differs), and to the box's warm Vite
 *       dependency caches (VITE_CACHES); Chrome's profiles, with their compiled shaders, are the box's too
 *       (~/.cache/drift-chrome-profiles, drift-chrome.mjs);
 *     - the command inside the box's render slots (drift-slot.mjs, the checkout's slot folder), its output lines and
 *       progress sent to the hub every 2 s, every file it wrote under its out folders uploaded, the exit code reported.
 *
 *   A DASHBOARD RESTART LOSES NOTHING (the coordinator, 2026-10-30, with two jobs running: "make sure a dashboard
 *   restart doesn't lose them"): the hub keeps every job on disk, and both sides HOLD ON while it is away instead of
 *   failing (holdOn: 1, 2, 5, 10, 15, 30 s between tries, up to 15 min; an answer that says no — a 4xx — is final).
 *   The worker: the payload, its "running", every result file and its final state are tried until the hub takes
 *   them (a final state lost meant the job ran twice: the hub requeues a job it stops hearing from); its log lines
 *   wait in order and are sent again, numbered, so the hub drops any it already has. The submitter: it keeps
 *   following through the gap, follows a job the dashboard requeued (requeuedAs), and its result downloads hold on.
 *
 * Built-ins only, and the stock git and tar (Windows' own tar.exe) on every machine.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, createWriteStream, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { contentId, installedManifest, run } from './drift-node-lib.mjs';
import { landingPath } from './drift-farm.mjs';

/** result files sent back while the job still runs (header of runJob's RESULTS AS THEY COME): whole-file kinds */
const STREAMED = /\.(png|jpe?g|webp|exr|json|txt|csv)$/i;

/** the scripts' Vite dependency caches (their cacheDir, under node_modules): linked from the box's into each job */
export const VITE_CACHES = ['.vite-drift-render', '.vite-drift-review-stills', '.vite-drift-review-clip', '.vite-drift-check', '.vite-drift-node', '.vite-drift-stills'];

/** MB of asset and untracked files a job may carry; more is a bundle's job */
export const MAX_EXTRA_MB = 200;
const OUT_FLAGS = new Set(['--out', '--out-dir', '--outdir', '-o']);
const posix = (p) => p.split(sep).join('/');
const git = (root, args, opts = {}) => spawnSync('git', ['-C', root, ...args], { encoding: opts.encoding ?? 'utf8', maxBuffer: 1 << 30, windowsHide: true, ...opts });

// ---------------------------------------------------------------------------------------------- the command line
/**
 * the command as the box runs it: `{{in:i}}` for an uploaded input, `{{out:i}}` for an out path, repo files as paths
 * relative to the code tree. `shipped(rel)`: is this repo-relative file in the job's tree (tracked, or sent along).
 * → { argv, inputs: [{ i, local, name }], outs: [{ i, local, file }] }
 */
export function remapArgv(argv, { root, cwd = root, shipped }) {
  const out = [];
  const inputs = [];
  const outs = [];
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    const eq = /^(--[\w-]+)=(.*)$/.exec(a);
    const flagName = eq ? eq[1] : null;
    const value = eq ? eq[2] : a;
    const prefix = eq ? `${eq[1]}=` : '';
    if (k === 0 && /^node(\.exe)?$|[/\\]node(\.exe)?$/.test(a)) {
      out.push('node');
      continue;
    }
    if ((flagName && OUT_FLAGS.has(flagName)) || (!flagName && OUT_FLAGS.has(argv[k - 1]))) {
      const local = resolve(cwd, value);
      const i = outs.length;
      // a name with an extension is a file (a clip's .mp4); anything else a folder (a stills run's --out dir)
      outs.push({ i, local, file: /\.[a-z0-9]{2,5}$/i.test(basename(local)) });
      out.push(`${prefix}{{out:${i}}}`);
      continue;
    }
    if (!eq && a.startsWith('-')) {
      out.push(a);
      continue;
    }
    const abs = resolve(cwd, value);
    let isFile = false;
    try {
      isFile = value !== '' && statSync(abs).isFile();
    } catch {
      isFile = false;
    }
    if (isFile) {
      const rel = relative(root, abs);
      if (!rel.startsWith('..') && !isAbsolute(rel) && shipped(posix(rel))) out.push(prefix + posix(rel));
      else {
        const i = inputs.length;
        inputs.push({ i, local: abs, name: basename(abs) });
        out.push(`${prefix}{{in:${i}}}`);
      }
      continue;
    }
    out.push(a);
  }
  return { argv: out, inputs, outs };
}

/** the box's command: placeholders → the job's folders, `node` → this Node */
export function resolveArgv(argv, { jobDir, outs, inputs, node = process.execPath }) {
  return argv.map((a, k) => {
    if (k === 0 && a === 'node') return node;
    return a
      .replace(/\{\{in:(\d+)\}\}/g, (_, i) => join(jobDir, 'job', 'inputs', i, inputs[Number(i)].name))
      .replace(/\{\{out:(\d+)\}\}/g, (_, i) => (outs[Number(i)].file ? join(jobDir, 'out', i, basename(outs[Number(i)].local)) : join(jobDir, 'out', i)));
  });
}

/** progress from a job's output line: a clip's or a render's "n/N x fps", a stills run's one line per still */
export function progressOf(line, p = { done: null, total: null, unit: null, fps: null, etaS: null }) {
  const m = /\[(review|render)\] (\d+)\/(\d+)\s+([\d.]+) fps/.exec(line);
  if (m) {
    const [done, total, fps] = [Number(m[2]), Number(m[3]), Number(m[4])];
    return { done, total, unit: 'frames', fps, etaS: fps > 0 ? Math.round((total - done) / fps) : null };
  }
  if (/\[review\] \S+\.(png|jpe?g)\s/.test(line)) return { ...p, done: (p.done ?? 0) + 1, unit: 'stills' };
  return p;
}

// ------------------------------------------------------------------------------------------------ the code state
/** the asset files a box's bundle lacks: what a bundle would hold now against the Mac's last bundle manifest */
export function assetOverlay(now, manifest) {
  const had = new Map((manifest?.files ?? []).map((f) => [f.path, f]));
  const created = manifest?.created ? Date.parse(manifest.created) : 0;
  const out = [];
  for (const f of now) {
    const m = had.get(f.path);
    if (!m) out.push({ ...f, why: 'new' });
    else if (m.bytes !== f.bytes) out.push({ ...f, why: 'changed' });
    else if (f.mtimeMs > created) out.push({ ...f, why: 'touched', sha256: m.sha256 });
  }
  return out;
}

const sha256 = async (p) => {
  const h = createHash('sha256');
  for await (const c of createReadStream(p)) h.update(c);
  return h.digest('hex');
};
const copyInto = (src, dst) => {
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
};

/**
 * the job's payload: stage/job/{meta.json, code.patch, files/<rel>, inputs/<i>/<name>} → stage/payload.tgz.
 * Throws when the extra files are over MAX_EXTRA_MB, or the base is not a commit here.
 */
export async function packState({ root, stage, inputs = [], base = 'origin/main', say = () => {}, assetsNow = null, clean = false }) {
  const baseSha = git(root, ['rev-parse', '--verify', `${base}^{commit}`]).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new Error(`${base} is not a commit here (git fetch first)`);
  const job = join(stage, 'job');
  mkdirSync(join(job, 'files'), { recursive: true });
  // the tracked changes against the base: committed but not pushed, staged, and not staged, binary files whole.
  // `clean`: none of them — the base exactly, and the bundle's assets (drift-consistency.mjs: every machine draws the
  // same commit, whatever this checkout has in progress)
  const d = clean ? { status: 0, stdout: Buffer.alloc(0) } : git(root, ['diff', '--binary', baseSha], { encoding: 'buffer' });
  if (d.status !== 0) throw new Error(`git diff failed: ${String(d.stderr)}`);
  writeFileSync(join(job, 'code.patch'), d.stdout);
  const untracked = clean ? [] : git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', 'src', 'scripts', 'tests', 'public']).stdout.split('\0').filter((f) => f && !f.startsWith('public/drift/'));
  // the assets the boxes' bundle lacks (drift-bundle.mjs decides what a bundle holds; `assetsNow`: that list given)
  let now = assetsNow;
  if (now === null && !clean) {
    const listFile = join(stage, 'assets-now.json');
    const r = spawnSync(process.execPath, [join(root, 'scripts/drift-bundle.mjs'), '--list-json', listFile], { cwd: root, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`drift-bundle --list-json failed: ${r.stderr}`);
    now = JSON.parse(readFileSync(listFile, 'utf8'));
  }
  const manifest = installedManifest(root);
  const overlay = [];
  for (const f of clean ? [] : assetOverlay(now, manifest)) {
    if (f.why === 'touched' && (await sha256(join(root, f.path))) === f.sha256) continue; // only its time changed
    overlay.push(f);
  }
  const extra = [...untracked.map((f) => ({ path: f, bytes: statSync(join(root, f)).size })), ...overlay];
  const mb = extra.reduce((a, f) => a + f.bytes, 0) / 2 ** 20;
  if (mb > MAX_EXTRA_MB) {
    const big = overlay.sort((a, b) => b.bytes - a.bytes).slice(0, 5).map((f) => `${f.path} (${(f.bytes / 2 ** 20).toFixed(0)} MB)`).join(', ');
    throw new Error(`${mb.toFixed(0)} MB of files the boxes lack would go with the job (${MAX_EXTRA_MB} MB at most): ${overlay.length} asset file(s) not in the last bundle${big ? `, e.g. ${big}` : ''}. Rebuild the bundle (node scripts/drift-bundle.mjs) and let the boxes sync (node scripts/drift-node.mjs sync)`);
  }
  for (const f of extra) copyInto(join(root, f.path), join(job, 'files', ...f.path.split('/')));
  for (const inp of inputs) copyInto(inp.local, join(job, 'inputs', String(inp.i), inp.name));
  const meta = { base: baseSha, bundle: manifest ? contentId(manifest.files) : null, files: extra.map((f) => f.path), overlay: overlay.map((f) => f.path), inputs: inputs.map((i) => ({ i: i.i, name: i.name })) };
  writeFileSync(join(job, 'meta.json'), JSON.stringify(meta, null, 1));
  const payload = join(stage, 'payload.tgz');
  const t = spawnSync('tar', ['-czf', payload, '-C', stage, 'job'], { env: { ...process.env, COPYFILE_DISABLE: '1' }, encoding: 'utf8', windowsHide: true });
  if (t.status !== 0) throw new Error(`tar failed: ${t.stderr}`);
  say(`farm: code at ${baseSha.slice(0, 7)} + ${(d.stdout.length / 1024).toFixed(0)} KB of changes, ${untracked.length} untracked file(s), ${overlay.length} asset file(s) the boxes lack, ${inputs.length} input(s): ${(statSync(payload).size / 2 ** 20).toFixed(1)} MB`);
  return { payload, meta };
}

/** a folder's files, relative, recursively (not following links) */
function filesUnder(dir, base = dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p, base));
    else if (e.isFile()) out.push(posix(relative(base, p)));
  }
  return out;
}

/** a link to a folder: a junction on Windows (no admin needed), a symlink elsewhere */
const linkDir = (target, path) => symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
/** a file's second name (same disk), else a copy */
const linkFile = (target, path) => {
  mkdirSync(dirname(path), { recursive: true });
  try {
    linkSync(target, path);
  } catch {
    copyFileSync(target, path);
  }
};

/**
 * delete a job's folder without ever following a link: a link to a folder is removed as a link (its target, the
 * checkout's packages, untouched), a hard-linked asset as a name (the checkout's file stays)
 */
export function removeTree(dir) {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) {
    try {
      unlinkSync(dir);
    } catch {
      rmdirSync(dir); // a Windows junction
    }
    return;
  }
  if (!st.isDirectory()) {
    unlinkSync(dir);
    return;
  }
  for (const e of readdirSync(dir)) removeTree(join(dir, e));
  rmdirSync(dir);
}

/**
 * the job's code tree under `jobDir` from the checkout `main`: base exported, patch applied, files copied, bundle
 * linked, node_modules linked (header: WORK). → the tree's path. `tar`: the tar to run (Windows' own).
 */
export async function applyState({ main, jobDir, tar = 'tar', say = () => {} }) {
  const job = join(jobDir, 'job');
  const meta = JSON.parse(readFileSync(join(job, 'meta.json'), 'utf8'));
  const tree = join(jobDir, 'tree');
  mkdirSync(tree, { recursive: true });
  if (git(main, ['cat-file', '-e', `${meta.base}^{commit}`]).status !== 0) {
    say(`farm: fetching ${meta.base.slice(0, 7)} (git fetch origin)`);
    git(main, ['fetch', '--quiet', 'origin']);
    if (git(main, ['cat-file', '-e', `${meta.base}^{commit}`]).status !== 0) throw new Error(`base ${meta.base.slice(0, 7)} is not on origin: push it first`);
  }
  // git archive → tar, piped (165 MB of tracked files, about a second)
  await new Promise((ok, bad) => {
    const a = spawn('git', ['-C', main, 'archive', '--format=tar', meta.base], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const x = spawn(tar, ['-xf', '-', '-C', tree], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    a.stderr.on('data', (c) => (err += c));
    x.stderr.on('data', (c) => (err += c));
    a.stdout.pipe(x.stdin);
    a.on('error', bad);
    x.on('error', bad);
    x.on('close', (code) => (code === 0 ? ok() : bad(new Error(`git archive | tar failed: ${err.trim()}`))));
  });
  if (statSync(join(job, 'code.patch')).size > 0) {
    // GIT_CEILING_DIRECTORIES: the tree sits beside (on a test machine, inside) a repository; git must not find it,
    // or `git apply` would read the paths against that repository and skip the files outside the tree
    const r = spawnSync('git', ['apply', '--binary', '--whitespace=nowarn', join(job, 'code.patch')], { cwd: tree, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(tree) } });
    if (r.status !== 0) throw new Error(`the job's changes do not apply to ${meta.base.slice(0, 7)}: ${r.stderr.trim().split('\n').slice(0, 3).join(' / ')}`);
  }
  // the job's own files first (they win over the bundle's: nothing is ever written into a linked file)
  for (const f of meta.files) copyInto(join(job, 'files', ...f.split('/')), join(tree, ...f.split('/')));
  const man = installedManifest(main);
  let linked = 0;
  for (const f of man?.files ?? []) {
    const dst = join(tree, ...f.path.split('/'));
    if (existsSync(dst)) continue;
    linkFile(join(main, ...f.path.split('/')), dst);
    linked++;
  }
  // node_modules: the checkout's packages when the lockfile is the same, else a cache installed for this lockfile;
  // a real folder of links either way, so the job's Vite cache (node_modules/.vite-*) is its own
  const lock = (p) => (existsSync(p) ? createHash('sha256').update(readFileSync(p, 'utf8').replace(/\r\n/g, '\n')).digest('hex') : null);
  const jobLock = lock(join(tree, 'package-lock.json'));
  let modules = join(main, 'node_modules');
  if (jobLock !== lock(join(main, 'package-lock.json')) || !existsSync(modules)) {
    const cache = join(dirname(jobDir), `node_modules-${jobLock.slice(0, 12)}`);
    if (!existsSync(join(cache, 'node_modules'))) {
      say(`farm: the job's package-lock.json differs from the checkout's: npm ci into ${cache}`);
      mkdirSync(cache, { recursive: true });
      for (const f of ['package.json', 'package-lock.json']) copyFileSync(join(tree, f), join(cache, f));
      const r = await run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: cache, shell: process.platform === 'win32', onLine: (l) => say(`  ${l}`) });
      if (r.code !== 0) throw new Error(`npm ci for the job's lockfile failed (exit ${r.code})`);
    }
    modules = join(cache, 'node_modules');
  }
  mkdirSync(join(tree, 'node_modules'), { recursive: true });
  for (const e of readdirSync(modules)) if (!e.startsWith('.vite')) linkDir(join(modules, e), join(tree, 'node_modules', e));
  // Vite's dependency caches, the box's warm ones (the coordinator, 2026-10-30: "in farm job trees, link it to the box's
  // warm one so each job doesn't re-optimize deps"): one per script, as each script names its own cacheDir. Vite
  // keys a cache by the lockfile and its config and re-optimizes only when they differ; a job with another lockfile
  // has its own node_modules (the cache folder above), and so its own Vite caches too
  for (const name of VITE_CACHES) {
    mkdirSync(join(modules, name), { recursive: true });
    linkDir(join(modules, name), join(tree, 'node_modules', name));
  }
  say(`farm: tree at ${meta.base.slice(0, 7)} + ${meta.files.length} file(s), ${linked} bundle file(s) linked`);
  return { tree, meta };
}

// --------------------------------------------------------------------------------------------- talking to the hub
const api = (hub, token) => async (path, { method = 'GET', body, json = true, timeoutMs = 30_000, raw = false } = {}) => {
  // (no token: a farm box is known to the hub by its tailnet address, on its own routes)
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  let b = body;
  if (body !== undefined && json && !(body instanceof Readable)) {
    headers['content-type'] = 'application/json';
    b = JSON.stringify(body);
  }
  const r = await fetch(`${hub}${path}`, { method, headers, body: b, signal: AbortSignal.timeout(timeoutMs), ...(b instanceof Readable ? { duplex: 'half' } : {}) });
  if (raw) return r;
  if (r.status === 204) return null;
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw Object.assign(new Error(`${method} ${path}: ${r.status} ${data?.error ?? text}`), { status: r.status });
  return data;
};
/** an HTTP answer that is not a 2xx, as an error holdOn can judge (its status: a 4xx is final, a 5xx is tried again) */
const httpError = (what, r) => Object.assign(new Error(`${what}: ${r.status}`), { status: r.status });

/** ms between tries while the hub does not answer (header: A DASHBOARD RESTART LOSES NOTHING) */
const HOLD_ON_STEPS_MS = [1000, 2000, 5000, 10_000, 15_000, 30_000];
/** ms a job's end (its final state, its result files) keeps trying before it gives up */
export const HOLD_ON_MS = 15 * 60_000;
/**
 * `fn` until it works: a hub that is away (no answer, a timeout, a 5xx) is tried again, an answer that says no (a 4xx)
 * is not. Says so once, then every fifth try. → fn's result, or its last error after `untilMs`
 */
export async function holdOn(what, fn, { untilMs = HOLD_ON_MS, say = () => {}, steps = HOLD_ON_STEPS_MS } = {}) {
  const t0 = Date.now();
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if ((e.status >= 400 && e.status < 500) || Date.now() - t0 > untilMs) throw e;
      if (i % 5 === 0) say(`farm: ${what}: ${e.message}; holding on (the dashboard restarting?)`);
      await new Promise((ok) => setTimeout(ok, steps[Math.min(i, steps.length - 1)]));
    }
  }
}
const upload = (call, path, file) => call(path, { method: 'PUT', body: Readable.from(createReadStream(file)), json: false, timeoutMs: 3_600_000 });

/**
 * a job's name in the queue and its log: the whole command, each path by its last part, cut at 160 characters with an
 * ellipsis. (It was the first six arguments: `… --width 1920 --out` read as if the --out path had gone missing, the
 * swash agent's job 20261030-004850-caf364, 2026-10-30; the argv itself carried it.)
 */
export function labelOf(argv, max = 160) {
  const s = argv.map((a) => (/[\\/]/.test(a) && !a.startsWith('--') ? basename(a) : a)).join(' ');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

const FINAL_STATES = ['done', 'failed', 'cancelled'];

/**
 * THE ROUND TRIP in one line, for the submitter's console (the user, 2026-10-30: "the idea was to accelerate our
 * workflow … whenever we need the results this also needs to be quick"): packing and upload here, the wait for a
 * box, the box's payload, bundle and tree, the boot (to the first frame; the shader cache warm or cold), the render,
 * the upload back, the download here, and the whole. `at`: this Mac's clock (submitAt, followAt: the payload is up,
 * landedAt); the hub's times are this Mac's clock too, the box's are durations.
 */
export function roundTrip(job, at) {
  const s = (ms) => (Number.isFinite(ms) ? `${(Math.max(0, ms) / 1000).toFixed(1)} s` : '?');
  const t = job.timing ?? {};
  const parts = [
    `send ${s(at.followAt - at.submitAt)}`,
    `wait for a box ${s((job.claimedAt ?? NaN) - (job.queuedAt ?? NaN))}`,
    `payload ${s(t.payloadMs)}`,
    ...(t.bundleMs > 500 ? [`bundle ${s(t.bundleMs)}`] : []),
    `tree ${s(t.treeMs)}`,
    `boot ${s(t.bootMs)}${t.cache ? ` (shader cache ${t.cache})` : ''}`,
    `render ${s(t.renderMs)}`,
    `upload ${s(t.uploadMs)}`,
    `back here ${s(at.landedAt - (job.endedAt ?? NaN))}`,
  ];
  return `farm: round trip ${s(at.landedAt - at.submitAt)}: ${parts.join(' · ')}`;
}

/** who sent a job, for the console's queue (From): DRIFT_AGENT, else the Claude Code session, else the pid */
export function submitterOf(env = process.env, pid = process.pid, host = hostname()) {
  const agent = env.DRIFT_AGENT?.trim() || (env.CLAUDE_CODE_SESSION_ID ? `claude ${env.CLAUDE_CODE_SESSION_ID.slice(0, 8)}` : null);
  return { pid, host: host.split('.')[0], agent: agent ?? `pid ${pid}` };
}

// ------------------------------------------------------------------------------------------------------- submit
/**
 * run `argv` on the farm as if here (header: SUBMIT). `prefer`: a box's name, 'any' (whichever box, however long it
 * waits), or 'auto' (the best free box; none free, or none takes it in 60 s: { fallback } and the caller runs it
 * locally — never for a `low` job, which waits for the farm). `priority`: low | normal | high (drift-farm.mjs
 * PRIORITIES). `packed`: a { payload, meta } already made by packState (drift-farm.mjs render: one code state for
 * every chunk). → { code } or { fallback: why }
 */
export async function submit({ root, hub, token, argv, prefer = 'auto', weight = 1, priority = 'normal', say = console.error, out = (s) => process.stdout.write(s), stage, clean = false, base = 'origin/main', packed = null }) {
  const call = api(hub, token);
  const t0Submit = Date.now();
  if (prefer === 'auto' && priority === 'low') prefer = 'any';
  if (prefer === 'auto') {
    const workers = await call('/farm/workers', { timeoutMs: 3000 }).catch((e) => ({ error: e.message }));
    if (!Array.isArray(workers)) return { fallback: `the farm hub does not answer (${workers.error})` };
    if (!workers.some((w) => w.state === 'waiting')) return { fallback: `no box is free (${workers.map((w) => `${w.node} ${w.state}`).join(', ')})` };
  }
  const tracked = new Set(git(root, ['ls-files', '-z']).stdout.split('\0').filter(Boolean));
  const untracked = new Set(git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', 'src', 'scripts', 'tests', 'public']).stdout.split('\0').filter(Boolean));
  const bundled = new Set((installedManifest(root)?.files ?? []).map((f) => f.path));
  const remap = remapArgv(argv, { root, cwd: process.cwd(), shipped: (rel) => tracked.has(rel) || untracked.has(rel) || bundled.has(rel) });
  if (packed && remap.inputs.length > 0) throw new Error('a packed code state carries no inputs: pass the job\'s files as repo paths');
  const { payload, meta } = packed ?? (await packState({ root, stage, inputs: remap.inputs, say, clean, base }));
  let { id } = await call('/farm/jobs', { method: 'POST', body: { label: labelOf(argv), argv: remap.argv, prefer: prefer === 'auto' || prefer === 'any' ? null : prefer, weight, priority, base: meta.base, bundle: meta.bundle, outs: remap.outs, inputs: remap.inputs.map((i) => ({ i: i.i, name: i.name })), submitter: submitterOf() } });
  await upload(call, `/farm/jobs/${id}/payload`, payload);
  say(`farm: job ${id} queued${prefer === 'auto' || prefer === 'any' ? '' : ` for ${prefer}`}${priority !== 'normal' ? ` at ${priority} priority` : ''}; following it here (Ctrl-C cancels it)`);
  let cancelled = false;
  const onSig = () => {
    cancelled = true;
    call(`/farm/jobs/${id}/cancel`, { method: 'POST', body: {} }).catch(() => {});
  };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);
  let from = 0;
  const t0 = Date.now();
  let job;
  let away = 0;
  // the results, at the local paths the command named, as they come (each download holds on through a restart)
  const landed = new Map(); // `${out}/${path}` → bytes landed
  const land = async (r) => {
    const dst = landingPath(job.outs[r.out], r.path);
    mkdirSync(dirname(dst), { recursive: true });
    await holdOn(`result ${r.path}`, async () => {
      const res = await call(`/farm/jobs/${id}/files/${r.out}/${r.path.split('/').map(encodeURIComponent).join('/')}`, { raw: true, timeoutMs: 3_600_000 });
      if (!res.ok) throw httpError(`result ${r.path}`, res);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(`${dst}.part`));
      renameSync(`${dst}.part`, dst);
    }, { say });
    landed.set(`${r.out}/${r.path}`, r.bytes);
    const of = job.progress?.unit === 'stills' && job.progress.total ? job.progress.total : FINAL_STATES.includes(job.state) ? job.results.length : '?';
    const rel = relative(process.cwd(), dst);
    say(`farm: got ${rel && !rel.startsWith('..') ? rel : dst} (${landed.size}/${of})`);
  };
  const fresh = () => (job?.results ?? []).filter((r) => landed.get(`${r.out}/${r.path}`) !== r.bytes);
  for (;;) {
    // (a dashboard restart: the last answer stands and the loop goes on; said once it has lasted 10 s)
    const next = await call(`/farm/jobs/${id}?from=${from}`).catch(() => null);
    if (next === null) {
      if (away++ === 5) say('farm: the hub does not answer; still following (the dashboard restarting?)');
    } else {
      if (away > 5) say('farm: the hub is back');
      away = 0;
      job = next;
    }
    if (job?.log?.length && next !== null) {
      out(job.log.map((l) => `[farm ${job.node ?? '?'}] ${l}\n`).join(''));
      from = job.logTo;
    }
    // requeued from the dashboard (taken off its box, or run again): the new job is this one now
    if (job?.requeuedAs && !cancelled) {
      say(`farm: job ${id} was requeued as ${job.requeuedAs}; following that`);
      id = job.requeuedAs;
      from = 0;
      job = null;
      continue;
    }
    if (job && FINAL_STATES.includes(job.state)) break;
    for (const r of fresh()) await land(r);
    if (prefer === 'auto' && job?.state === 'queued' && Date.now() - t0 > 60_000 && !cancelled) {
      await call(`/farm/jobs/${id}/cancel`, { method: 'POST', body: {} }).catch(() => {});
      return { fallback: 'no box took it in 60 s' };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  // what is not here yet (the last files, a video)
  for (const r of fresh()) await land(r);
  say(roundTrip(job, { submitAt: t0Submit, followAt: t0, landedAt: Date.now() }));
  say(`farm: job ${id} ${job.state} on ${job.node} (exit ${job.exitCode ?? '—'})${job.results?.length ? `, ${job.results.length} file(s) back` : ''}${job.error ? `: ${job.error}` : ''}`);
  return { code: job.state === 'done' ? job.exitCode ?? 0 : job.exitCode || 1, job };
}

// --------------------------------------------------------------------------------------------------------- work
/**
 * one job on this box (header: WORK): `job` as the hub handed it. → { state, exitCode, fps }.
 * `main`: the checkout; `work`: the folder of job folders (../smt-farm); `ensureBundle(meta.bundle)`: make the
 * checkout's bundle the job's (drift-node's sync), or throw.
 */
export async function runJob({ job, call, main, work, tar, say, ensureBundle = async () => {}, onProgress = () => {} }) {
  const jobDir = join(work, job.id);
  removeTree(jobDir);
  mkdirSync(jobDir, { recursive: true });
  // the log lines the hub does not have yet, in order; `acked`: how many it has (header: A DASHBOARD RESTART LOSES
  // NOTHING). One post at a time, so a batch that failed goes again before any later one.
  let lines = [];
  let acked = 0;
  let chain = Promise.resolve({ ok: true });
  let progress = { done: null, total: null, unit: null, fps: null, etaS: null };
  let cancel = false;
  // THE ROUND TRIP (header), measured here as durations (this box's clock is not the Mac's)
  const t0 = Date.now();
  const timing = { payloadMs: null, bundleMs: null, treeMs: null, bootMs: null, renderMs: null, uploadMs: null, cache: null };
  /** one status post (lines from `acked`, progress, `patch`), never throwing: → { ok } or { ok: false, e } */
  const flush = (patch = {}) =>
    (chain = chain.then(async () => {
      const send = lines.slice(0, 2000);
      try {
        const x = await call(`/farm/jobs/${job.id}/status`, { method: 'POST', body: { lines: send, from: acked, progress, timing, ...patch } });
        acked += send.length;
        lines = lines.slice(send.length);
        if (x?.cancel) cancel = true;
        return { ok: true };
      } catch (e) {
        // (away for long: the oldest lines go, never the memory; the hub sees the gap in the numbering)
        if (lines.length > 20_000) {
          acked += lines.length - 20_000;
          lines = lines.slice(-20_000);
        }
        return { ok: false, e };
      }
    }));
  /** a status post that must arrive (the job's state): tried until the hub takes it (holdOn: a 4xx is final) */
  const tell = (patch) =>
    holdOn(`job ${job.id} ${patch.state}`, async () => {
      for (let first = true; first || lines.length > 0; first = false) {
        const r = await flush(first ? patch : {});
        if (!r.ok) throw r.e;
      }
    }, { say });
  const note = (l) => {
    lines.push(l);
    say(l);
  };
  try {
    await holdOn('payload', async () => {
      const res = await call(`/farm/jobs/${job.id}/payload`, { raw: true, timeoutMs: 3_600_000 });
      if (!res.ok) throw httpError('payload', res);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(join(jobDir, 'payload.tgz')));
    }, { say, untilMs: 5 * 60_000 });
    let tMark = Date.now();
    const lap = () => {
      const t = Date.now();
      const ms = t - tMark;
      tMark = t;
      return ms;
    };
    const x = spawnSync(tar, ['-xzf', 'payload.tgz'], { cwd: jobDir, encoding: 'utf8', windowsHide: true });
    if (x.status !== 0) throw new Error(`payload unpack: ${x.stderr}`);
    const meta = JSON.parse(readFileSync(join(jobDir, 'job', 'meta.json'), 'utf8'));
    timing.payloadMs = Date.now() - t0;
    lap();
    await ensureBundle(meta.bundle);
    timing.bundleMs = lap();
    const { tree } = await applyState({ main, jobDir, tar, say: note });
    timing.treeMs = lap();
    for (const o of job.outs) mkdirSync(join(jobDir, 'out', String(o.i)), { recursive: true });
    const argv = resolveArgv(job.argv, { jobDir, outs: job.outs, inputs: job.inputs });
    // inside the box's render slots: the checkout's slot folder, whoever else renders there (DRIFT_FARM off: no loop)
    const cmd = [join(tree, 'scripts', 'drift-slot.mjs'), '--weight', String(job.weight ?? 1), '--', ...argv];
    note(`farm: running ${job.label} on ${tree}`);
    await tell({ state: 'running' });
    const tRun = Date.now();
    const tick = setInterval(() => flush(), 2000);
    // RESULTS AS THEY COME (the user, 2026-10-30: "the way back obviously has to be fast too … bam bam bam"): a still
    // goes back as soon as it is written, not when the batch ends. Only whole-file kinds stream (an image, a JSON):
    // a video grows until its encoder ends, so it goes at the end. A file counts as written once its size held for
    // a second; at the end every file goes again if it changed since.
    const sentAs = new Map(); // `${out}/${rel}` → "size:mtime" as uploaded
    const seenAs = new Map(); // `${out}/${rel}` → "size:mtime" at the last look
    let streaming = Promise.resolve();
    const sendFile = async (o, rel) => {
      const abs = join(jobDir, 'out', String(o.i), ...rel.split('/'));
      const st = statSync(abs);
      const sig = `${st.size}:${Math.round(st.mtimeMs)}`;
      if (sentAs.get(`${o.i}/${rel}`) === sig) return false;
      await holdOn(`result ${rel}`, () => upload(call, `/farm/jobs/${job.id}/files?out=${o.i}&path=${encodeURIComponent(rel)}`, abs), { say });
      sentAs.set(`${o.i}/${rel}`, sig);
      return true;
    };
    const look = () => {
      streaming = streaming.then(async () => {
        for (const o of job.outs) {
          const dir = join(jobDir, 'out', String(o.i));
          for (const rel of filesUnder(dir)) {
            if (rel.endsWith('.part') || !STREAMED.test(rel)) continue;
            let st;
            try {
              st = statSync(join(dir, ...rel.split('/')));
            } catch {
              continue;
            }
            const sig = `${st.size}:${Math.round(st.mtimeMs)}`;
            const k = `${o.i}/${rel}`;
            const steady = seenAs.get(k) === sig && Date.now() - st.mtimeMs > 1000;
            seenAs.set(k, sig);
            if (steady && sentAs.get(k) !== sig) await sendFile(o, rel).catch((e) => say(`farm: ${rel} not sent yet (${e.message}): at the end`));
          }
        }
      });
      return streaming;
    };
    const watcher = setInterval(look, 1000);
    let child = null;
    const watch = setInterval(() => {
      if (cancel && child?.exitCode === null) {
        child.kill('SIGINT');
        setTimeout(() => child?.exitCode === null && child.kill('SIGKILL'), 15_000).unref();
      }
    }, 1000);
    const r = await run(process.execPath, cmd, {
      cwd: tree,
      // (the box's own Chrome flags, drift-gpu-check.mjs --save, live in the checkout, not in the job's tree; its
      // Chrome profiles, with their compiled shaders, are in the user's home: every job shares them)
      env: { ...process.env, DRIFT_FARM: '', DRIFT_SLOTS_DIR: process.env.DRIFT_SLOTS_DIR ?? join(main, 'out', 'drift', '.slots'), DRIFT_NODE_CHROME: process.env.DRIFT_NODE_CHROME || join(main, 'out', 'drift', 'node-chrome.json') },
      onSpawn: (p) => (child = p),
      onLine: (l) => {
        progress = progressOf(l, progress);
        // the first frame or still: the page booted (its shaders compiled, its assets loaded); the shader cache as the
        // script says it (drift-chrome.mjs launchChrome: any cold Chrome makes the job's cache cold)
        if (timing.bootMs === null && (progress.done ?? 0) >= 1) timing.bootMs = Date.now() - tRun;
        const fb = /first frame ([\d.]+) s after launch/.exec(l);
        if (fb && timing.bootMs === null) timing.bootMs = Math.round(Number(fb[1]) * 1000);
        const sc = /shader cache: (warm|cold)/.exec(l);
        if (sc) timing.cache = timing.cache === 'cold' ? 'cold' : sc[1];
        onProgress(progress, l);
        lines.push(l);
      },
    });
    clearInterval(tick);
    clearInterval(watch);
    clearInterval(watcher);
    await streaming;
    timing.renderMs = Date.now() - tRun - (timing.bootMs ?? 0);
    lap();
    // every file it wrote under its out folders, back to the hub
    let sent = 0;
    for (const o of job.outs) {
      const dir = join(jobDir, 'out', String(o.i));
      for (const rel of filesUnder(dir)) {
        if (rel.endsWith('.part')) continue;
        await sendFile(o, rel);
        sent++;
      }
    }
    timing.uploadMs = lap();
    const state = cancel ? 'cancelled' : r.code === 0 ? 'done' : 'failed';
    note(`farm: exit ${r.code}, ${sent} file(s) sent back`);
    await tell({ state, exitCode: r.code, fps: progress.fps, ...(state === 'failed' ? { error: `exit ${r.code}` } : {}) });
    return { state, exitCode: r.code, fps: progress.fps };
  } catch (e) {
    note(`farm: FAILED: ${e.message}`);
    await tell({ state: 'failed', error: String(e.message).slice(0, 500) }).catch((e2) => say(`farm: could not tell the hub (${e2.message}): it requeues the job when its lease runs out`));
    return { state: 'failed', exitCode: null, error: e.message };
  } finally {
    removeTree(jobDir);
  }
}

/**
 * the worker's loop: claim while the GPU is free of others' work (`gpuFree()` → { ok, why }), run, repeat.
 * Returns only when `stop()` says so, or with { exit } when `onPulse` asks for one (a restart).
 *
 * THE PULSE (drift-farm.mjs header), read from every claim's answer and handed to `onPulse({ state, command, head,
 * bundle })` between jobs — never during one:
 *   state    accepting | draining | paused | removed. Not accepting: no GPU check (a paused box idles without probing
 *            its card); removed: its claim is answered at once, so it waits 5 min before asking again
 *   command  sync-now | gpu-check-now | restart, from the dashboard
 *   head     origin/main as the Mac sees it; bundle: the newest assets' content id
 * `onPulse` returns { exit: code } to leave the loop (drift-node.mjs: a restart, so the wrapper syncs and starts it
 * again), or nothing. A hub that does not answer: 15, 30, 60, then every 120 s.
 */
export async function workLoop({ hub, token, node, main, work, tar, say, gpuFree, ensureBundle, onState = () => {}, onPulse = async () => null, stop = () => false }) {
  const call = api(hub, token);
  mkdirSync(work, { recursive: true });
  let farmState = 'accepting';
  let away = 0;
  const pulseOf = (r) => ({
    state: r.headers.get('x-drift-farm-state') ?? 'accepting',
    command: r.headers.get('x-drift-farm-command'),
    head: r.headers.get('x-drift-farm-head'),
    bundle: r.headers.get('x-drift-farm-bundle'),
  });
  while (!stop()) {
    if (farmState === 'accepting') {
      const g = await gpuFree();
      if (!g.ok) {
        onState('busy-foreign', null, g.why);
        const r = await call(`/farm/claim?node=${encodeURIComponent(node)}&busy=${encodeURIComponent(g.why)}`, { raw: true }).catch(() => null);
        if (r) {
          const p = pulseOf(r);
          farmState = p.state;
          const out = await onPulse(p);
          if (out?.exit !== undefined) return out;
        }
        await new Promise((ok) => setTimeout(ok, 30_000));
        continue;
      }
      onState('waiting', null);
    } else onState('standby', null, `${farmState} from the dashboard`);
    let job = null;
    try {
      const r = await call(`/farm/claim?node=${encodeURIComponent(node)}`, { timeoutMs: 40_000, raw: true });
      if (r.status !== 200 && r.status !== 204) throw new Error(`claim: ${r.status} ${(await r.text()).slice(0, 200)}`);
      if (away > 0) say('farm: the hub answers again');
      away = 0;
      const p = pulseOf(r);
      if (p.state !== farmState) say(`farm: this box is ${p.state} (set from the dashboard)`);
      farmState = p.state;
      job = r.status === 200 ? await r.json() : null;
      // (between jobs only: a command, a newer head or bundle; a job handed over in this answer runs first)
      if (!job) {
        const out = await onPulse(p);
        if (out?.exit !== undefined) return out;
      }
      if (!job && farmState === 'removed') {
        onState('standby', null, 'removed from the farm (the dashboard)');
        await new Promise((ok) => setTimeout(ok, 5 * 60_000));
        continue;
      }
    } catch (e) {
      const waitS = [15, 30, 60, 120][Math.min(away, 3)];
      away++;
      say(`farm: the hub does not answer (${e.message}); trying again in ${waitS} s`);
      await new Promise((ok) => setTimeout(ok, waitS * 1000));
      continue;
    }
    if (!job) continue;
    say(`farm: took ${job.id}: ${job.label}`);
    onState('rendering', job);
    const r = await runJob({ job, call, main, work, tar, say, ensureBundle, onProgress: (p, line) => onState('rendering', { ...job, progress: p, last: line }) });
    say(`farm: ${job.id} ${r.state}`);
  }
}
