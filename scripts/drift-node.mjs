#!/usr/bin/env node
/**
 * THE RENDER NODE'S ONE COMMAND (docs/drift/RENDER-NODE.md; the user, 2026-10-29: "easily pull from a single spot …
 * and then just run a single command to render our current state or render whatever"). Plain Node on Windows, Linux
 * and macOS: no bash, no PowerShell needed.
 *
 *   node scripts/drift-node.mjs sync                       pull the code, npm ci if the lockfile changed, fetch the
 *                                                          asset bundle if it changed, GPU self-test when due
 *   node scripts/drift-node.mjs render <preset|queue.jsonc> [--only a,b] [--set k=v] [--no-sync] [--detach]
 *                                                          sync, then scripts/drift-queue.mjs: presets smoke,
 *                                                          preview-2k, master-4k, master-8k (drift-node-presets.jsonc)
 *   node scripts/drift-node.mjs status                     commit, bundle, GPU check, the render running and where it is
 *   node scripts/drift-node.mjs logs [-f] [--lines 40]     the newest run's log (-f: follow it)
 *   node scripts/drift-node.mjs dash [--port 5190]         the studio dashboard (scripts/drift-dash.mjs) on this machine
 *   node scripts/drift-node.mjs length                     the show's length in s at this commit (asks the page once)
 *   common: --dry-run (say what would happen, change nothing) · sync: --gpu-check (run it anyway) · --no-gpu-check
 *   render: --length <s> (the show's length, instead of asking the page) · anything else goes to drift-queue.mjs
 *           (--only, --retries, --decode-check, --no-concat, --port, --dry-run)
 *
 * SYNC, step by step; each stops the sync with the fix when it fails, and none discards anything:
 *   0. no render is running here (drift-render's lock, the render slots, a queue, a background run): pulling code
 *      or unpacking assets under a render would change its frames mid-job
 *   1. git pull --ff-only on the current branch — refused when a tracked file has local changes, the branch has no
 *      upstream, or it cannot fast-forward (commits here that are not upstream): nothing is reset, stashed or merged
 *   2. npm ci, only when package-lock.json is not the one of the last sync (its sha256 in out/drift/node-state.json)
 *      or node_modules lacks playwright / vite
 *   3. the asset bundle (scripts/drift-node-lib.mjs syncBundle): the source in drift-node.json (gitignored, this
 *      machine's own) — the Mac's out/drift-bundle over SSH on the tailnet, or a folder it was copied to by hand.
 *      The source's latest-assets.json (a few hundred bytes) first; the 1.4 GB .tar.gz only when it names other
 *      files than the ones unpacked here; then `tar -xzf` and drift-bundle.mjs --verify --quick
 *   4. scripts/drift-gpu-check.mjs on the first sync, when Chrome's version or the GPU driver changed, or when the
 *      last one failed. It also prints the show's length, which `"to": "end"` jobs use (cached per commit)
 *
 * RENDER: sync (unless --no-sync), the preset's or the file's jobs resolved — `"to": "end"` → the show's length,
 * `--set` over every job, and a preset's output into <renders>/<commit>-<bundle>/ (one folder per state of code and
 * data: "render our current state" never takes a chunk of an older one; the same command again resumes it) —
 * written to out/drift/node/queue-<name>.json, and drift-queue.mjs on that. The queue's own guards stay: battery
 * (the laptop), one render at a time, the render slots, the disk check, the chunks and their retries.
 *
 * THE DASHBOARD (the user, 2026-10-29: "we need the dashboards to be able to see what's happening on those guys so
 * that we are not losing touch in the depths of random detached terminal sessions"): while sync or render runs, a
 * heartbeat every 5 s, at each change of state and at the end, POSTed to <dashboard>/report — scripts/drift-dash.mjs
 * on the Mac (`--tailnet`), whose header is the contract. <dashboard> is drift-node.json's "dashboard", else the
 * bundle's SSH host on :5190. Fire and forget (2 s timeout, failures ignored): a Mac that is off never slows a render.
 * The job's progress and whole-job ETA come from the queue's out/drift/queue/status.json.
 *
 * DETACHED RUNS: `render … --detach` starts the same command in the background (its own process group, no window on
 * Windows), its output in out/drift/node/<date>-<what>.log, so a closed terminal or a dropped SSH session kills
 * nothing. `status` and `logs -f` find it again. To stop one: Ctrl-C does not reach it — `status` prints its pid;
 * Linux `kill -INT <pid>` (the queue stops its render cleanly), Windows `taskkill /PID <pid> /T /F` (the chunk in
 * progress is lost, finished chunks stay). A run in the foreground keeps its log there too.
 *
 * WINDOWS: every child is spawned with an argument list, never a command line, so paths with spaces are safe; npm is
 * npm.cmd, which Node ≥ 20.12 runs only through a shell (`shell: true`, its arguments are fixed words); tar is
 * Windows' own System32\tar.exe (bsdtar: Git for Windows' GNU tar, if first on PATH, reads "C:" as a host name);
 * JSON is read with CRLF and a byte-order mark allowed; long paths are no issue (the longest file in the bundle is
 * 95 characters under the repo, libuv and bsdtar use \\?\ names).
 */
import { spawn, spawnSync, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, closeSync, readSync, fstatSync } from 'node:fs';
import { arch, cpus } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bundleStamp, configHelp, contentId, dashboardUrl, installedManifest, jobOfQueueStatus, needsLength, parseBundleSource, parseJsonc,
  parseNvidiaSmi, parseSet, readConfig, resolveJobs, run, startHeartbeat, stateLabel, syncBundle,
} from './drift-node-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = join(ROOT, 'scripts');
const SELF = fileURLToPath(import.meta.url);
const STATE_FILE = join(ROOT, 'out/drift/node-state.json');
const NODE_DIR = join(ROOT, 'out/drift/node');
const QUEUE_STATUS = join(ROOT, 'out/drift/queue/status.json');
const PRESETS = join(SCRIPTS, 'drift-node-presets.jsonc');
const SLOT = join(SCRIPTS, 'drift-slot.mjs');
const WIN = process.platform === 'win32';
const TAR = WIN && process.env.SystemRoot && existsSync(join(process.env.SystemRoot, 'System32', 'tar.exe')) ? join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';

const argv = process.argv.slice(2);
const CMD = argv[0] ?? 'help';
const rest = argv.slice(1);
/** drift-node's own flags that take a value; the queue's (passed on) too, so their values are not taken for the target */
const OWN_VALUE = new Set(['--set', '--length', '--lines']);
const QUEUE_VALUE = new Set(['--only', '--retries', '--port']);
const flag = (name) => rest.includes(`--${name}`);
const arg = (name, fallback = null) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] !== undefined && !rest[i + 1].startsWith('--') ? rest[i + 1] : fallback;
};
const args = (name) => rest.flatMap((a, i) => (a === `--${name}` && rest[i + 1] !== undefined ? [rest[i + 1]] : []));
const positional = rest.filter((a, i) => !a.startsWith('-') && !OWN_VALUE.has(rest[i - 1]) && !QUEUE_VALUE.has(rest[i - 1]));
const DRY = flag('dry-run');

class Refusal extends Error {}

// ---------------------------------------------------------------------------------------------- state, output
/** this machine's memory of its syncs and renders (out/drift is gitignored): npm, bundle, gpuCheck, show, lastRun … */
const loadState = () => {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {}; // the first run here
  }
};
let state = loadState();
/** merged into the file as it is NOW (a background run and a foreground command may both write it) */
function saveState(patch) {
  state = { ...loadState(), ...patch };
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(`${STATE_FILE}.${process.pid}.tmp`, JSON.stringify(state, null, 1));
  renameSync(`${STATE_FILE}.${process.pid}.tmp`, STATE_FILE);
}

/** the run's log: our stdout when detached (DRIFT_NODE_LOG, set by --detach), else a copy of everything printed */
let logStream = null;
let lastLine = '';
const emit = (line) => {
  process.stdout.write(`${line}\n`);
  logStream?.write(`${line}\n`);
  if (line.trim()) lastLine = line.trim().slice(0, 300);
};
const hhmmss = () => new Date().toTimeString().slice(0, 8);
const say = (m) => emit(`[node ${hhmmss()}] ${m}`);
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
const slug = (s) => basename(s).replace(/\.jsonc?$/, '').replace(/[^\w.-]+/g, '_');
const gbs = (b) => `${(b / 2 ** 30).toFixed(2)} GB`;
const dur = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m` : s >= 60 ? `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s` : `${Math.round(s)}s`);

function openRunLog(what) {
  if (DRY) return null; // (a dry run changes nothing: no log, no state)
  const log = process.env.DRIFT_NODE_LOG ?? join(NODE_DIR, `${stamp()}-${slug(what)}.log`);
  mkdirSync(dirname(log), { recursive: true });
  if (!process.env.DRIFT_NODE_LOG) logStream = createWriteStream(log, { flags: 'a' });
  saveState({ lastRun: { what, log, pid: process.pid, started: new Date().toISOString(), detached: Boolean(process.env.DRIFT_NODE_LOG) } });
  return log;
}

// -------------------------------------------------------------------------------------------- the machine
const alive = (pid) => {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
const git = (a) => spawnSync('git', ['-C', ROOT, ...a], { encoding: 'utf8', windowsHide: true });
/** HEAD: short commit, whether a tracked file has local changes, the branch */
function head() {
  const c = git(['rev-parse', '--short', 'HEAD']);
  const d = git(['status', '--porcelain', '--untracked-files=no']);
  return { commit: c.status === 0 ? c.stdout.trim() : 'unknown', dirty: d.status === 0 && d.stdout.trim() !== '', branch: git(['symbolic-ref', '--quiet', '--short', 'HEAD']).stdout?.trim() || null };
}
let HEAD = head();
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

/** what is rendering on this machine right now (each a sentence), other than this process */
function busy() {
  const why = [];
  const lock = join(ROOT, 'out/drift/.render.lock');
  const lockPid = existsSync(lock) ? Number(readFileSync(lock, 'utf8').trim()) : NaN;
  if (alive(lockPid) && lockPid !== process.pid) why.push(`a render holds out/drift/.render.lock (pid ${lockPid})`);
  const slots = process.env.DRIFT_SLOTS_DIR ?? join(ROOT, 'out/drift/.slots');
  for (const f of existsSync(slots) ? readdirSync(slots).filter((x) => x.endsWith('.slot')) : []) {
    try {
      const [pid, ...what] = readFileSync(join(slots, f), 'utf8').split('\n');
      if (alive(Number(pid))) why.push(`render slot ${f.replace('.slot', '')}: pid ${pid}, ${what.join(' ').trim().slice(0, 90)}`);
    } catch {
      // released while we looked
    }
  }
  const q = readJson(QUEUE_STATUS);
  if (q && q.state === 'rendering' && alive(q.pid)) why.push(`a render queue (pid ${q.pid}, ${q.file})`);
  const bg = state.detached;
  if (bg && alive(bg.pid) && bg.pid !== process.pid && bg.pid !== process.ppid) why.push(`a background run: ${bg.what} (pid ${bg.pid})`);
  return why;
}

/** Google Chrome's version, read without starting it where the OS allows */
function chromeVersion() {
  try {
    if (WIN) {
      const bases = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
      for (const b of bases) {
        const dir = join(b, 'Google', 'Chrome', 'Application');
        if (!existsSync(dir)) continue;
        // the installer keeps each version in a folder named for it, beside chrome.exe
        const v = readdirSync(dir).filter((f) => /^\d+\.\d+\.\d+\.\d+$/.test(f)).sort((a, z) => {
          const [p, q] = [a, z].map((s) => s.split('.').map(Number));
          return p.reduce((acc, n, i) => acc || n - q[i], 0);
        });
        if (v.length) return v.at(-1);
      }
      return null;
    }
    if (process.platform === 'darwin') {
      const plist = readFileSync('/Applications/Google Chrome.app/Contents/Info.plist', 'utf8');
      return /CFBundleShortVersionString<\/key>\s*<string>([^<]+)/.exec(plist)?.[1] ?? null;
    }
    const r = spawnSync('/opt/google/chrome/chrome', ['--version'], { encoding: 'utf8', timeout: 15_000 });
    return /([\d.]{6,})/.exec(r.stdout ?? '')?.[1] ?? null;
  } catch {
    return null;
  }
}
/** what the GPU check depends on: Chrome's version, the GPU and its driver */
function gpuFingerprint() {
  const smi = spawnSync('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  const gpu = smi.status === 0 ? smi.stdout.trim().split(/\r?\n/).join(' | ') : process.platform === 'darwin' ? cpus()[0]?.model ?? 'mac' : 'no nvidia-smi';
  return `chrome ${chromeVersion() ?? 'not found'} · ${gpu}`;
}

/** the GPU and the power line for the heartbeat, probed in the background (never on the render's path) */
const probes = { gpu: undefined, power: undefined, powerAt: 0, smi: true };
function refreshProbes() {
  if (probes.smi && process.platform !== 'darwin') {
    execFile('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], { timeout: 3000, windowsHide: true }, (e, out) => {
      if (e?.code === 'ENOENT') probes.smi = false;
      probes.gpu = e ? undefined : parseNvidiaSmi(out);
    });
  }
  if (Date.now() - probes.powerAt < 60_000) return;
  probes.powerAt = Date.now();
  if (process.platform === 'darwin') {
    execFile('pmset', ['-g', 'batt'], { timeout: 3000 }, (e, out) => {
      if (!e) probes.power = String(out).includes("'AC Power'") ? 'AC' : `battery ${/(\d+)%/.exec(out)?.[1] ?? '?'}%`;
    });
  } else if (process.platform === 'linux') {
    try {
      const ps = '/sys/class/power_supply';
      const ents = existsSync(ps) ? readdirSync(ps) : [];
      const type = (d) => readFileSync(join(ps, d, 'type'), 'utf8').trim();
      const mains = ents.filter((d) => existsSync(join(ps, d, 'type')) && type(d) === 'Mains');
      const bat = ents.find((d) => existsSync(join(ps, d, 'capacity')));
      const on = mains.length === 0 || mains.some((d) => readFileSync(join(ps, d, 'online'), 'utf8').trim() === '1');
      probes.power = on ? 'AC' : `battery ${bat ? readFileSync(join(ps, bat, 'capacity'), 'utf8').trim() : '?'}%`;
    } catch {
      probes.power = undefined;
    }
  } else if (WIN) {
    const cmd = "Add-Type -AssemblyName System.Windows.Forms; $p = [System.Windows.Forms.SystemInformation]::PowerStatus; '{0} {1}' -f $p.PowerLineStatus, [int]($p.BatteryLifePercent * 100)";
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 8000, windowsHide: true }, (e, out) => {
      const [line, pct] = String(out ?? '').trim().split(/\s+/);
      if (!e) probes.power = line === 'Offline' ? `battery ${pct}%` : line === 'Online' ? 'AC' : undefined;
    });
  }
}

// ------------------------------------------------------------------------------------------- the heartbeat
let hb = null;
let queuePid = null;
const report = { state: 'idle', error: undefined };
function beat(patch) {
  Object.assign(report, patch);
  hb?.beat();
}
function payload() {
  const q = queuePid ? readJson(QUEUE_STATUS) : null;
  const live = q && q.pid === queuePid ? q : null;
  return {
    node: CFG.name, os: process.platform, commit: `${HEAD.commit}${HEAD.dirty ? '+dirty' : ''}`, bundle: bundleStamp(state.bundle) ?? bundleStamp({ created: installedManifest(ROOT)?.created }),
    state: report.state, gpu: probes.gpu, power: probes.power, job: jobOfQueueStatus(live), last: (live?.last || lastLine).slice(0, 300), error: report.error?.slice(0, 1000),
  };
}
function startReporting(source) {
  if (DRY) return;
  const url = dashboardUrl(CFG, source);
  if (!url) return;
  refreshProbes();
  setInterval(refreshProbes, 5000).unref();
  hb = startHeartbeat(url, payload, 5000);
  say(`reporting to the studio dashboard: ${url} (as "${CFG.name}")`);
}
let finishing = false;
async function finish(code, error) {
  if (finishing) return;
  finishing = true;
  if (code !== 0 && error) say(`FAILED: ${error}`);
  Object.assign(report, { state: code === 0 ? (CMD === 'render' ? 'done' : 'idle') : 'failed', error: code === 0 ? undefined : error });
  await hb?.stop();
  if (state.lastRun?.pid === process.pid) saveState({ lastRun: { ...state.lastRun, ended: new Date().toISOString(), code } });
  if (logStream) await new Promise((r) => logStream.end(r));
  process.exit(code);
}
// Ctrl-C reaches every process of the terminal's group: the queue stops its render itself, and this waits for it.
// A run in the background has no terminal: a `kill -INT <pid>` reaches only this process, which passes it on to the
// child it runs (the queue). Only for sync and render: `dash` passes the signal to its dashboard, the rest just stop.
let interrupted = 0;
let child = null;
/** run() with the child kept, for the signal above */
const runTracked = (cmd, a, o = {}) => run(cmd, a, { ...o, onSpawn: (p) => ((child = p), o.onSpawn?.(p)) });
for (const sig of ['sync', 'render'].includes(CMD) ? ['SIGINT', 'SIGTERM'] : []) {
  process.on(sig, () => {
    if (++interrupted > 1) process.exit(130);
    say(`${sig}: stopping (the render in progress stops itself; finished chunks stay). Again to quit at once`);
    report.error = `${sig}: stopped`;
    if (process.env.DRIFT_NODE_LOG && child?.exitCode === null) child.kill(sig);
  });
}

// ------------------------------------------------------------------------------------------------- sync
let CFG;
try {
  CFG = readConfig(ROOT);
} catch (e) {
  console.error(`[node] ${e.message}`);
  process.exit(1);
}

function stepBusy() {
  const why = busy();
  if (why.length === 0) return true;
  say(`refused: something is rendering on this machine, and a sync would change the code or the assets under it:\n    ${why.join('\n    ')}\n  wait for it (status shows it; logs -f follows it), or render what is here: render … --no-sync`);
  return false;
}

async function stepGit() {
  if (git(['rev-parse', '--is-inside-work-tree']).status !== 0) throw new Refusal(`${ROOT} is not a git clone (git clone https://github.com/laubsauger/shiver-me-timbers.git)`);
  const branch = HEAD.branch;
  if (!branch) throw new Refusal('HEAD is detached (no branch to pull into): git switch main');
  const up = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (up.status !== 0) throw new Refusal(`branch ${branch} has no upstream to pull from: git branch --set-upstream-to origin/${branch}`);
  const upstream = up.stdout.trim();
  const dirty = git(['status', '--porcelain', '--untracked-files=no']).stdout.split(/\r?\n/).filter(Boolean);
  if (dirty.length > 0) {
    throw new Refusal(`local changes in ${dirty.length} tracked file(s) — sync pulls only into a clean tree and never discards anything:\n    ${dirty.slice(0, 8).join('\n    ')}${dirty.length > 8 ? '\n    …' : ''}\n  commit them or set them aside yourself, then sync again; or render what is here with --no-sync`);
  }
  if (DRY) {
    const behind = git(['rev-list', '--count', 'HEAD..@{u}']).stdout.trim();
    say(`git: would pull --ff-only into ${branch} from ${upstream} (${behind || '?'} commit(s) behind as of the last fetch)`);
    return true;
  }
  const before = HEAD.commit;
  say(`git pull --ff-only (${branch} ← ${upstream})`);
  // (no prompt can wait unseen in a detached run: a pull that needs credentials fails instead)
  const r = await runTracked('git', ['-C', ROOT, 'pull', '--ff-only'], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, onLine: (l) => emit(`  ${l}`) });
  if (r.code !== 0) {
    throw new Refusal(`git pull --ff-only failed (exit ${r.code}); nothing was changed. If ${branch} has commits of its own that ${upstream} has not (diverged), sort it out by hand: git status, git log --oneline --graph HEAD @{u}`);
  }
  HEAD = head();
  say(before === HEAD.commit ? `git: up to date at ${HEAD.commit}` : `git: ${before} → ${HEAD.commit}`);
  return true;
}

async function stepNpm() {
  const lockFile = join(ROOT, 'package-lock.json');
  if (!existsSync(lockFile)) throw new Refusal('no package-lock.json in the repo root');
  // (line ends normalised: a checkout with core.autocrlf has CRLF, and the hash compares this machine with itself)
  const lock = createHash('sha256').update(readFileSync(lockFile, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
  const missing = ['playwright', 'vite'].filter((m) => !existsSync(join(ROOT, 'node_modules', m)));
  const why = missing.length > 0 ? `node_modules lacks ${missing.join(', ')}` : state.npm?.lock !== lock ? (state.npm ? 'package-lock.json changed since the last sync' : 'first sync on this machine') : null;
  if (why === null) {
    say('npm: package-lock.json unchanged since the last sync — no npm ci');
    return true;
  }
  if (DRY) {
    say(`npm: would run npm ci (${why})`);
    return true;
  }
  say(`npm ci (${why})`);
  const r = await runTracked('npm', ['ci', '--no-audit', '--no-fund'], { cwd: ROOT, shell: WIN, onLine: (l) => emit(`  ${l}`) });
  if (r.code !== 0) throw new Refusal(`npm ci failed (exit ${r.code}): the messages above. A file in use (an open editor or a Chrome from a render) blocks it on Windows`);
  saveState({ npm: { lock, at: new Date().toISOString() } });
  return true;
}

async function stepBundle(source) {
  say(`bundle: ${source.kind === 'ssh' ? `the Mac over SSH, ${source.label}` : `the folder ${source.label}`}`);
  const { changed, record } = await syncBundle({ root: ROOT, source, prev: state.bundle ?? null, dryRun: DRY, say: emit, bundleScript: join(SCRIPTS, 'drift-bundle.mjs'), tar: TAR });
  if (!DRY && record) saveState({ bundle: record });
  if (!DRY) say(changed ? `bundle: ${record.file} unpacked and verified` : 'bundle: current, verified');
  return true;
}

async function stepGpuCheck() {
  if (flag('no-gpu-check')) {
    say('GPU check: skipped (--no-gpu-check)');
    return true;
  }
  const fp = gpuFingerprint();
  const last = state.gpuCheck;
  const due = flag('gpu-check') ? 'asked for (--gpu-check)' : !last ? 'first sync on this machine' : last.fingerprint !== fp ? `Chrome or the driver changed (${last.fingerprint} → ${fp})` : last.result !== 'PASS' ? 'it did not pass last time' : null;
  if (due === null) {
    say(`GPU check: passed ${last.at.slice(0, 16).replace('T', ' ')} with this Chrome and driver (${fp}) — not run again; --gpu-check runs it`);
    return true;
  }
  if (DRY) {
    say(`GPU check: would run node scripts/drift-gpu-check.mjs (${due})`);
    return true;
  }
  say(`GPU check (${due}): node scripts/drift-gpu-check.mjs — a minute or two of shader compiles`);
  let total = null;
  const r = await runTracked(process.execPath, [join(SCRIPTS, 'drift-gpu-check.mjs')], {
    cwd: ROOT,
    onLine: (l) => {
      emit(`  ${l}`);
      const m = /the show is ([\d.]+) s long/.exec(l);
      if (m) total = Number(m[1]);
    },
  });
  const at = new Date().toISOString();
  saveState({ gpuCheck: { fingerprint: fp, result: r.code === 0 ? 'PASS' : 'FAIL', at, commit: HEAD.commit }, ...(total ? { show: { commit: HEAD.commit, dirty: HEAD.dirty, total, at, from: 'drift-gpu-check' } } : {}) });
  if (r.code !== 0) throw new Refusal('the GPU check failed: each failure above has its fix (RENDER-NODE.md §4). The next sync runs it again');
  return true;
}

/** why the sync stopped, in one line: the dashboard's "error" */
let syncError = null;
/** the whole sync; false when a step refused or failed (a dry run goes through every step and says what each would do) */
async function sync() {
  const source = parseBundleSource(CFG.bundle);
  if (!source) {
    emit(configHelp(ROOT));
    syncError = `no bundle source: ${CFG.file} has none`;
    return false;
  }
  let ok = true;
  for (const [name, step] of [['busy', stepBusy], ['git', stepGit], ['npm', stepNpm], ['bundle', () => stepBundle(source)], ['gpu', stepGpuCheck]]) {
    let good = false;
    try {
      good = await step();
      if (!good) syncError ??= `${name}: refused (a render is running here)`;
    } catch (e) {
      say(`${name}: ${e instanceof Refusal ? 'refused' : 'FAILED'} — ${e.message}`);
      syncError ??= `${name}: ${e.message.split('\n')[0]}`;
    }
    if (!good) {
      ok = false;
      if (!DRY) break;
    }
    if (interrupted) return false;
  }
  if (!DRY) saveState({ lastSync: { at: new Date().toISOString(), ok, commit: HEAD.commit } });
  if (ok) say(`sync ${DRY ? '(dry run) ' : ''}done: ${HEAD.commit}${HEAD.dirty ? '+dirty' : ''}`);
  return ok;
}

// ----------------------------------------------------------------------------------------- the show's length
/** s, the show's end at this commit: --length, the cached one (GPU check or probe at this clean commit), else asked */
async function showLength() {
  if (arg('length') !== null) {
    const v = Number(arg('length'));
    if (!(v > 0)) throw new Refusal('--length <s>: the show\'s length in seconds');
    return v;
  }
  const s = state.show;
  if (s && s.commit === HEAD.commit && !s.dirty && !HEAD.dirty) {
    say(`the show is ${s.total} s long (asked of the page at ${s.commit}, ${s.from})`);
    return s.total;
  }
  if (DRY) throw new Refusal(`the show's length at ${HEAD.commit}${HEAD.dirty ? '+dirty' : ''} is not known on this machine yet: a real run asks the page (one headless boot), or pass --length <s>`);
  say(`asking the page for the show's length at ${HEAD.commit} (one headless boot, in a render slot)`);
  const r = await runTracked(process.execPath, [SLOT, '--weight', '1', '--', process.execPath, SELF, 'probe-length'], { cwd: ROOT, onLine: (l) => emit(`  ${l}`) });
  const total = Number(/^show-length ([\d.]+)\s*$/m.exec(r.out)?.[1]);
  if (r.code !== 0 || !(total > 0)) throw new Refusal(`could not ask the page for the show's length (exit ${r.code}) — node scripts/drift-gpu-check.mjs says why; or pass --length <s>`);
  saveState({ show: { commit: HEAD.commit, dirty: HEAD.dirty, total, at: new Date().toISOString(), from: 'probe' } });
  say(`the show is ${total} s long`);
  return total;
}

/** (run inside a render slot by showLength) boot drift.html headless the way the renderer does and print its total */
async function probeLengthNow() {
  const { chromium } = await import('playwright');
  const { createServer } = await import('vite');
  const { chromeLaunchOptions } = await import('./drift-chrome.mjs');
  // its own port and dep cache: a render's Vite (5288/5290) may be running, and must never see its cache rewritten
  const vite = await createServer({ root: ROOT, clearScreen: false, logLevel: 'warn', cacheDir: join(ROOT, 'node_modules/.vite-drift-node'), server: { port: Number(arg('port', '5293')), strictPort: true, hmr: false, watch: null } });
  await vite.listen();
  const base = (vite.resolvedUrls?.local?.[0] ?? 'http://localhost:5293/').replace(/\/$/, '');
  const browser = await chromium.launch(chromeLaunchOptions('chrome'));
  try {
    const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${base}/drift.html?paused`);
    for (const until = Date.now() + 240_000; ; ) {
      if (errors.length > 0) throw new Error(`drift.html failed to boot: ${errors.join(' | ')}`);
      const s = await page.evaluate(() => ({ ok: '__drift' in window, gate: document.body.innerText.includes('requires WebGPU') }));
      if (s.gate) throw new Error('drift.html shows its "requires WebGPU" gate: no GPU adapter (node scripts/drift-gpu-check.mjs)');
      if (s.ok) break;
      if (Date.now() > until) throw new Error('drift.html did not boot in 240 s');
      await new Promise((r) => setTimeout(r, 250));
    }
    console.log(`show-length ${await page.evaluate(() => window.__drift.total)}`);
  } finally {
    await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 8000))]);
    await Promise.race([vite.close(), new Promise((r) => setTimeout(r, 3000))]);
  }
}

// ------------------------------------------------------------------------------------------------- render
function detach(target) {
  const what = `render ${target}`;
  const log = join(NODE_DIR, `${stamp()}-${slug(target)}.log`);
  mkdirSync(NODE_DIR, { recursive: true });
  const fd = openSync(log, 'a');
  // its own process group (setsid on Linux, a new hidden console on Windows): a closed terminal or SSH session sends
  // its hang-up to the terminal's group, not to this
  const child = spawn(process.execPath, [SELF, ...argv.filter((a) => a !== '--detach')], { cwd: ROOT, detached: true, windowsHide: true, stdio: ['ignore', fd, fd], env: { ...process.env, DRIFT_NODE_LOG: log } });
  child.unref();
  closeSync(fd);
  saveState({ detached: { pid: child.pid, log, what, started: new Date().toISOString() } });
  console.log(`[node] ${what}: running in the background, pid ${child.pid}
  log      ${log}
  follow   node scripts/drift-node.mjs logs -f
  status   node scripts/drift-node.mjs status
  stop     ${WIN ? `taskkill /PID ${child.pid} /T /F   (the chunk in progress is lost, finished chunks stay)` : `kill -INT ${child.pid}   (the queue stops its render cleanly; finished chunks stay)`}`);
  process.exit(0);
}

async function render() {
  const target = positional[0];
  if (!target) throw new Refusal(`render what? A preset (${Object.keys(loadPresets()).join(', ')}) or a queue file`);
  if (flag('detach')) {
    // what would fail at once in the background is said here, in the terminal
    if (!Object.hasOwn(loadPresets(), target) && !existsSync(resolve(target))) throw new Refusal(`${target}: not a preset (${Object.keys(loadPresets()).join(', ')}) and no such file`);
    if (!flag('no-sync') && !parseBundleSource(CFG.bundle)) {
      console.log(configHelp(ROOT));
      throw new Refusal('no bundle source for the sync (above), or --no-sync');
    }
    return detach(target);
  }
  openRunLog(`render ${target}`);
  const source = parseBundleSource(CFG.bundle);
  startReporting(source);
  say(`render ${target} on ${CFG.name}${DRY ? ' (dry run)' : ''}`);
  if (!flag('no-sync')) {
    beat({ state: 'syncing' });
    if (!(await sync())) return finish(1, `sync stopped at ${syncError ?? 'a step above'}; nothing rendered (--no-sync renders what is here)`);
  } else say('--no-sync: rendering the code and the assets that are here');
  if (interrupted) return finish(130, report.error);

  // the jobs: a preset, or a queue file
  const presets = loadPresets();
  const isPreset = Object.hasOwn(presets, target);
  let spec;
  if (isPreset) spec = presets[target];
  else {
    const f = resolve(target);
    if (!existsSync(f)) throw new Refusal(`${target}: not a preset (${Object.keys(presets).join(', ')}) and no such file`);
    try {
      spec = parseJsonc(readFileSync(f, 'utf8'));
    } catch (e) {
      throw new Refusal(`${f}: not valid JSON (${e.message})`);
    }
  }
  const set = parseSet(args('set'));
  HEAD = head();
  const length = needsLength(spec, set) ? await showLength() : null;
  const man = installedManifest(ROOT);
  if (!man) say('WARNING: no asset bundle unpacked here (out/drift-bundle/manifest-assets.json): the page will miss its assets — sync first');
  if (HEAD.dirty) say(`WARNING: tracked files have local changes: this renders ${HEAD.commit} plus them, and a chunk rendered before an edit is reused after it`);
  const out = isPreset ? join(resolve(ROOT, CFG.renders), stateLabel(HEAD.commit, HEAD.dirty, man ? contentId(man.files) : null)) : null;
  const resolved = resolveJobs(spec, { length, out, set });
  // (a dry run's own file: it must not overwrite the one a real run of the same preset resumes from)
  const qfile = join(NODE_DIR, `queue-${slug(target)}${DRY ? '.dry-run' : ''}.json`);
  mkdirSync(NODE_DIR, { recursive: true });
  writeFileSync(qfile, `${JSON.stringify(resolved, null, 2)}\n`);
  say(`jobs: ${resolved.jobs.map((j) => `${j.name} [${j.from}, ${j.to}) s ${j.size}²`).join(', ')}${Object.keys(set).length ? `, with ${JSON.stringify(set)}` : ''} → ${relative(ROOT, qfile)}`);
  if (out) say(`output: ${out}  (this commit and bundle; the same command again resumes it)`);

  // everything that is not drift-node's own goes to the queue
  const own = new Set(['--no-sync', '--detach', '--gpu-check', '--no-gpu-check']);
  const at = rest.findIndex((a, i) => a === target && !OWN_VALUE.has(rest[i - 1]) && !QUEUE_VALUE.has(rest[i - 1]));
  const pass = rest.filter((a, i) => i !== at && !own.has(a) && !OWN_VALUE.has(a) && !OWN_VALUE.has(rest[i - 1]));
  beat({ state: 'rendering' });
  say(`node scripts/drift-queue.mjs ${relative(ROOT, qfile)} ${pass.join(' ')}`.trim());
  const r = await runTracked(process.execPath, [join(SCRIPTS, 'drift-queue.mjs'), qfile, ...pass], {
    cwd: ROOT,
    onLine: emit,
    onSpawn: (p) => {
      queuePid = p.pid;
    },
  });
  // (the last report carries the queue's final status: its summary, and the job's frames)
  if (!DRY) saveState({ lastRender: { what: target, queue: qfile, out, commit: HEAD.commit, ended: new Date().toISOString(), code: r.code } });
  return finish(r.code === 0 ? 0 : 1, r.code === 0 ? undefined : report.error ?? `the queue exited ${r.code}: ${readJson(QUEUE_STATUS)?.error ?? lastLine}`);
}

function loadPresets() {
  const p = parseJsonc(readFileSync(PRESETS, 'utf8')).presets;
  if (!p || typeof p !== 'object') throw new Error(`${PRESETS}: no "presets"`);
  return p;
}

// ------------------------------------------------------------------------------------------- status, logs
async function status() {
  const when = (iso) => (iso ? iso.slice(0, 16).replace('T', ' ') : '?');
  const lines = [];
  const row = (k, v) => lines.push(`  ${k.padEnd(10)} ${v}`);
  lines.push(`[node] ${CFG.name} · ${process.platform} ${arch()} · ${ROOT}`);
  const up = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).stdout?.trim();
  const counts = up ? git(['rev-list', '--left-right', '--count', 'HEAD...@{u}']).stdout.trim().split(/\s+/).map(Number) : null;
  row('code', `${HEAD.branch ?? '(detached)'} @ ${HEAD.commit}${HEAD.dirty ? ', tracked files changed here' : ', clean'}${counts ? ` · ${up} as of the last fetch: ${counts[1] ? `${counts[1]} behind` : 'not behind'}${counts[0] ? `, ${counts[0]} ahead` : ''}` : ' · no upstream'}`);
  const man = installedManifest(ROOT);
  const b = state.bundle;
  if (man) {
    row('bundle', `assets ${man.created.slice(0, 10)} at ${man.commit ?? '?'} · ${man.count} files, ${gbs(man.bytes)} · content ${contentId(man.files).slice(0, 6)}`);
    row('', b ? `synced ${when(b.at)} from ${b.source}` : 'unpacked by hand (no sync here yet)');
  } else row('bundle', 'none unpacked here (sync fetches it)');
  row('config', CFG.exists || CFG.bundle ? `bundle ${CFG.bundle ?? '(none)'} · dashboard ${dashboardUrl(CFG, parseBundleSource(CFG.bundle)) ?? 'none'}` : `no ${CFG.file} (sync prints what to put in it)`);
  const g = state.gpuCheck;
  if (g) {
    const now = gpuFingerprint();
    row('GPU check', `${g.result} ${when(g.at)} at ${g.commit} · ${g.fingerprint}${now !== g.fingerprint ? `\n${' '.repeat(13)}Chrome or the driver changed since (${now}): the next sync runs it again` : ''}`);
  } else row('GPU check', 'not run here yet (the first sync runs it)');
  if (state.show) row('show', `${state.show.total} s long at ${state.show.commit}${state.show.commit !== HEAD.commit ? ' (another commit: asked again at the next render)' : ''}`);
  if (state.lastSync) row('last sync', `${when(state.lastSync.at)} ${state.lastSync.ok ? 'ok' : 'STOPPED (its log says why)'} at ${state.lastSync.commit}`);
  const run1 = state.lastRun;
  if (run1) {
    const live = alive(run1.pid) && run1.pid !== process.pid && !run1.ended;
    row('run', `${run1.what}${run1.detached ? ' (background)' : ''}, pid ${run1.pid}: ${live ? `running since ${when(run1.started)}` : `${run1.code === 0 ? 'done' : run1.code === undefined ? 'ended' : `exit ${run1.code}`} ${when(run1.ended ?? run1.started)}`}`);
    row('', `log ${run1.log}`);
  }
  // a background run whose own record is not the last one (still booting, or a dry run, which keeps no record)
  const bg = state.detached;
  if (bg && bg.pid !== run1?.pid && (alive(bg.pid) || bg.started > (run1?.started ?? ''))) {
    row('background', `${bg.what}, pid ${bg.pid}: ${alive(bg.pid) ? `running since ${when(bg.started)}` : `ended (started ${when(bg.started)})`}`);
    row('', `log ${bg.log}`);
  }
  const q = readJson(QUEUE_STATUS);
  if (q?.job) {
    const j = q.job;
    const live = q.state === 'rendering' && alive(q.pid);
    const pct = j.framesTotal ? ` (${((100 * j.frames) / j.framesTotal).toFixed(1)}%)` : '';
    row('queue', `${live ? 'rendering' : `${q.state} ${when(q.ended ?? q.updated)}`} · ${j.name}${j.jobs > 1 ? ` (job ${j.index}/${j.jobs})` : ''} · chunk ${j.chunk}/${j.chunks}, ${j.chunksDone} done · ${j.frames}/${j.framesTotal} frames${pct}${j.fps ? ` · ${j.fps} fps` : ''}${live && j.etaS != null ? ` · ~${dur(j.etaS)} left` : ''}`);
    row('', `${j.out}${q.error ? ` · ${q.error}` : ''}`);
    if (live && q.last) row('', q.last.slice(0, 160));
  }
  const url = dashboardUrl(CFG, parseBundleSource(CFG.bundle));
  if (url) {
    const ok = await fetch(`${url}/api`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
    row('dashboard', `${url} ${ok ? '(reachable)' : '(not reachable from here now: the Mac asleep, off the tailnet, or the dashboard not running with --tailnet)'}`);
  }
  console.log(lines.join('\n'));
}

async function logs() {
  const listed = existsSync(NODE_DIR) ? readdirSync(NODE_DIR).filter((f) => f.endsWith('.log')).map((f) => join(NODE_DIR, f)) : [];
  listed.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const file = positional[0] ? resolve(positional[0]) : listed[0];
  if (!file || !existsSync(file)) throw new Refusal(`no run log yet in ${NODE_DIR}`);
  const n = Number(arg('lines', '40'));
  const text = readFileSync(file, 'utf8');
  console.log(`[node] ${file}`);
  process.stdout.write(`${text.split(/\r?\n/).slice(-n - 1).join('\n')}`);
  if (!(flag('f') || rest.includes('-f') || flag('follow'))) return;
  // follow it (no `tail` on Windows): new bytes every second, until its run has ended and nothing more comes
  const pid = state.lastRun?.log === file ? state.lastRun.pid : state.detached?.log === file ? state.detached.pid : null;
  const fd = openSync(file, 'r');
  let pos = fstatSync(fd).size;
  let quiet = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const size = fstatSync(fd).size;
    if (size > pos) {
      const buf = Buffer.alloc(size - pos);
      readSync(fd, buf, 0, buf.length, pos);
      process.stdout.write(buf);
      pos = size;
      quiet = 0;
    } else if (pid !== null && !alive(pid) && ++quiet > 2) {
      console.log(`\n[node] (the run, pid ${pid}, has ended)`);
      return;
    }
  }
}

function usage() {
  // (the header's command list)
  const text = readFileSync(SELF, 'utf8');
  console.log(text.slice(text.indexOf(' *   node scripts/drift-node.mjs sync'), text.indexOf(' * SYNC, step by step')).replace(/^ \* ?/gm, '').trimEnd());
}

// ---------------------------------------------------------------------------------------------------- main
async function main() {
  if (CMD === 'sync') {
    openRunLog('sync');
    const source = parseBundleSource(CFG.bundle);
    startReporting(source);
    beat({ state: 'syncing' });
    return finish((await sync()) ? 0 : 1, `${DRY ? 'dry run: would stop at ' : 'sync stopped at '}${syncError ?? 'a step above'}`);
  }
  if (CMD === 'render') return render();
  if (CMD === 'status') return status();
  if (CMD === 'logs') return logs();
  if (CMD === 'length') {
    HEAD = head();
    console.log(await showLength());
    return;
  }
  if (CMD === 'probe-length') return probeLengthNow();
  if (CMD === 'dash') {
    const p = spawn(process.execPath, [join(SCRIPTS, 'drift-dash.mjs'), ...rest], { cwd: ROOT, stdio: 'inherit' });
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => p.kill(sig));
    p.on('close', (code) => process.exit(code ?? 0));
    return;
  }
  usage();
  if (CMD !== 'help' && CMD !== '--help' && CMD !== '-h') process.exit(2);
}

main().catch((e) => {
  const msg = e instanceof Refusal ? e.message : (e?.stack ?? String(e));
  if (['sync', 'render'].includes(CMD)) return finish(1, msg);
  console.error(`[node] ${msg}`);
  process.exit(1);
});
