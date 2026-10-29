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
 *       checkout's packages (npm ci into a cache only when the job's lockfile differs), so each job's Vite cache is
 *       its own;
 *     - the command inside the box's render slots (drift-slot.mjs, the checkout's slot folder), its output lines and
 *       progress sent to the hub every 2 s, every file it wrote under its out folders uploaded, the exit code reported.
 *
 * Built-ins only, and the stock git and tar (Windows' own tar.exe) on every machine.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, createWriteStream, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { contentId, installedManifest, run } from './drift-node-lib.mjs';
import { landingPath } from './drift-farm.mjs';

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
export async function packState({ root, stage, inputs = [], base = 'origin/main', say = () => {}, assetsNow = null }) {
  const baseSha = git(root, ['rev-parse', '--verify', `${base}^{commit}`]).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new Error(`${base} is not a commit here (git fetch first)`);
  const job = join(stage, 'job');
  mkdirSync(join(job, 'files'), { recursive: true });
  // the tracked changes against the base: committed but not pushed, staged, and not staged, binary files whole
  const d = git(root, ['diff', '--binary', baseSha], { encoding: 'buffer' });
  if (d.status !== 0) throw new Error(`git diff failed: ${String(d.stderr)}`);
  writeFileSync(join(job, 'code.patch'), d.stdout);
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', 'src', 'scripts', 'tests', 'public']).stdout.split('\0').filter((f) => f && !f.startsWith('public/drift/'));
  // the assets the boxes' bundle lacks (drift-bundle.mjs decides what a bundle holds; `assetsNow`: that list given)
  let now = assetsNow;
  if (now === null) {
    const listFile = join(stage, 'assets-now.json');
    const r = spawnSync(process.execPath, [join(root, 'scripts/drift-bundle.mjs'), '--list-json', listFile], { cwd: root, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`drift-bundle --list-json failed: ${r.stderr}`);
    now = JSON.parse(readFileSync(listFile, 'utf8'));
  }
  const manifest = installedManifest(root);
  const overlay = [];
  for (const f of assetOverlay(now, manifest)) {
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
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${data?.error ?? text}`);
  return data;
};
const upload = (call, path, file) => call(path, { method: 'PUT', body: Readable.from(createReadStream(file)), json: false, timeoutMs: 3_600_000 });

// ------------------------------------------------------------------------------------------------------- submit
/**
 * run `argv` on the farm as if here (header: SUBMIT). `prefer`: a box's name, or 'auto' (the best free box; none
 * free, or none takes it in 60 s: { fallback } and the caller runs it locally). → { code } or { fallback: why }
 */
export async function submit({ root, hub, token, argv, prefer = 'auto', weight = 1, say = console.error, out = (s) => process.stdout.write(s), stage }) {
  const call = api(hub, token);
  if (prefer === 'auto') {
    const workers = await call('/farm/workers', { timeoutMs: 3000 }).catch((e) => ({ error: e.message }));
    if (!Array.isArray(workers)) return { fallback: `the farm hub does not answer (${workers.error})` };
    if (!workers.some((w) => w.state === 'waiting')) return { fallback: `no box is free (${workers.map((w) => `${w.node} ${w.state}`).join(', ')})` };
  }
  const tracked = new Set(git(root, ['ls-files', '-z']).stdout.split('\0').filter(Boolean));
  const untracked = new Set(git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', 'src', 'scripts', 'tests', 'public']).stdout.split('\0').filter(Boolean));
  const bundled = new Set((installedManifest(root)?.files ?? []).map((f) => f.path));
  const remap = remapArgv(argv, { root, cwd: process.cwd(), shipped: (rel) => tracked.has(rel) || untracked.has(rel) || bundled.has(rel) });
  const { payload, meta } = await packState({ root, stage, inputs: remap.inputs, say });
  const { id } = await call('/farm/jobs', { method: 'POST', body: { label: argv.map((a) => basename(a)).slice(0, 6).join(' '), argv: remap.argv, prefer: prefer === 'auto' ? null : prefer, weight, base: meta.base, bundle: meta.bundle, outs: remap.outs, inputs: remap.inputs.map((i) => ({ i: i.i, name: i.name })), submitter: { pid: process.pid } } });
  await upload(call, `/farm/jobs/${id}/payload`, payload);
  say(`farm: job ${id} queued${prefer === 'auto' ? '' : ` for ${prefer}`}; following it here (Ctrl-C cancels it)`);
  let cancelled = false;
  const onSig = () => {
    cancelled = true;
    call(`/farm/jobs/${id}/cancel`, { method: 'POST' }).catch(() => {});
  };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);
  let from = 0;
  const t0 = Date.now();
  let job;
  for (;;) {
    job = await call(`/farm/jobs/${id}?from=${from}`).catch(() => job);
    if (job?.log?.length) {
      out(job.log.map((l) => `[farm ${job.node ?? '?'}] ${l}\n`).join(''));
      from = job.logTo;
    }
    if (job && ['done', 'failed', 'cancelled'].includes(job.state)) break;
    if (prefer === 'auto' && job?.state === 'queued' && Date.now() - t0 > 60_000 && !cancelled) {
      await call(`/farm/jobs/${id}/cancel`, { method: 'POST' }).catch(() => {});
      return { fallback: 'no box took it in 60 s' };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  // the results, at the local paths the command named
  for (const r of job.results ?? []) {
    const dst = landingPath(job.outs[r.out], r.path);
    mkdirSync(dirname(dst), { recursive: true });
    const res = await call(`/farm/jobs/${id}/files/${r.out}/${r.path.split('/').map(encodeURIComponent).join('/')}`, { raw: true, timeoutMs: 3_600_000 });
    if (!res.ok) throw new Error(`result ${r.path}: ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(`${dst}.part`));
    renameSync(`${dst}.part`, dst);
  }
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
  let lines = [];
  let progress = { done: null, total: null, unit: null, fps: null, etaS: null };
  let cancel = false;
  const flush = async (patch = {}) => {
    const send = lines;
    lines = [];
    const r = await call(`/farm/jobs/${job.id}/status`, { method: 'POST', body: { lines: send, progress, ...patch } }).catch(() => null);
    if (r?.cancel) cancel = true;
  };
  const note = (l) => {
    lines.push(l);
    say(l);
  };
  try {
    const res = await call(`/farm/jobs/${job.id}/payload`, { raw: true, timeoutMs: 3_600_000 });
    if (!res.ok) throw new Error(`payload: ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(join(jobDir, 'payload.tgz')));
    const x = spawnSync(tar, ['-xzf', 'payload.tgz'], { cwd: jobDir, encoding: 'utf8', windowsHide: true });
    if (x.status !== 0) throw new Error(`payload unpack: ${x.stderr}`);
    const meta = JSON.parse(readFileSync(join(jobDir, 'job', 'meta.json'), 'utf8'));
    await ensureBundle(meta.bundle);
    const { tree } = await applyState({ main, jobDir, tar, say: note });
    for (const o of job.outs) mkdirSync(join(jobDir, 'out', String(o.i)), { recursive: true });
    const argv = resolveArgv(job.argv, { jobDir, outs: job.outs, inputs: job.inputs });
    // inside the box's render slots: the checkout's slot folder, whoever else renders there (DRIFT_FARM off: no loop)
    const cmd = [join(tree, 'scripts', 'drift-slot.mjs'), '--weight', String(job.weight ?? 1), '--', ...argv];
    note(`farm: running ${job.label} on ${tree}`);
    await flush({ state: 'running' });
    const tick = setInterval(() => flush(), 2000);
    let child = null;
    const watch = setInterval(() => {
      if (cancel && child?.exitCode === null) {
        child.kill('SIGINT');
        setTimeout(() => child?.exitCode === null && child.kill('SIGKILL'), 15_000).unref();
      }
    }, 1000);
    const r = await run(process.execPath, cmd, {
      cwd: tree,
      env: { ...process.env, DRIFT_FARM: '', DRIFT_SLOTS_DIR: process.env.DRIFT_SLOTS_DIR ?? join(main, 'out', 'drift', '.slots') },
      onSpawn: (p) => (child = p),
      onLine: (l) => {
        progress = progressOf(l, progress);
        onProgress(progress, l);
        lines.push(l);
      },
    });
    clearInterval(tick);
    clearInterval(watch);
    // every file it wrote under its out folders, back to the hub
    let sent = 0;
    for (const o of job.outs) {
      const dir = join(jobDir, 'out', String(o.i));
      for (const rel of filesUnder(dir)) {
        if (rel.endsWith('.part')) continue;
        await upload(call, `/farm/jobs/${job.id}/files?out=${o.i}&path=${encodeURIComponent(rel)}`, join(dir, ...rel.split('/')));
        sent++;
      }
    }
    const state = cancel ? 'cancelled' : r.code === 0 ? 'done' : 'failed';
    note(`farm: exit ${r.code}, ${sent} file(s) sent back`);
    await flush({ state, exitCode: r.code, fps: progress.fps, ...(state === 'failed' ? { error: `exit ${r.code}` } : {}) });
    return { state, exitCode: r.code, fps: progress.fps };
  } catch (e) {
    note(`farm: FAILED: ${e.message}`);
    await flush({ state: 'failed', error: String(e.message).slice(0, 500) });
    return { state: 'failed', exitCode: null, error: e.message };
  } finally {
    removeTree(jobDir);
  }
}

/**
 * the worker's loop: claim while the GPU is free of others' work (`gpuFree()` → { ok, why }), run, repeat.
 * Returns only when `stop()` says so.
 */
export async function workLoop({ hub, token, node, main, work, tar, say, gpuFree, ensureBundle, onState = () => {}, stop = () => false }) {
  const call = api(hub, token);
  mkdirSync(work, { recursive: true });
  while (!stop()) {
    const g = await gpuFree();
    if (!g.ok) {
      onState('busy-foreign', null, g.why);
      await call(`/farm/claim?node=${encodeURIComponent(node)}&busy=${encodeURIComponent(g.why)}`).catch(() => {});
      await new Promise((r) => setTimeout(r, 30_000));
      continue;
    }
    onState('waiting', null);
    let job = null;
    try {
      job = await call(`/farm/claim?node=${encodeURIComponent(node)}`, { timeoutMs: 40_000 });
    } catch (e) {
      say(`farm: the hub does not answer (${e.message}); trying again in 15 s`);
      await new Promise((r) => setTimeout(r, 15_000));
      continue;
    }
    if (!job) continue;
    say(`farm: took ${job.id}: ${job.label}`);
    onState('rendering', job);
    const r = await runJob({ job, call, main, work, tar, say, ensureBundle, onProgress: (p, line) => onState('rendering', { ...job, progress: p, last: line }) });
    say(`farm: ${job.id} ${r.state}`);
  }
}
