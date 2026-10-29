#!/usr/bin/env node
/**
 * A RESUMABLE RENDER QUEUE for The Drift (docs/drift/RENDER-NODE.md §Queue): a jobs file in, each job split into
 * chunks, each chunk one scripts/drift-render.mjs run with its own output file — so an interruption (a crash, a
 * stall, a reboot, a sleeping machine) costs the chunk in progress, never the night (on 2026-10-28 an overnight
 * render that was one file lost 80 minutes to one readback stall, then 7 h to a sleep).
 *
 *   node scripts/drift-queue.mjs [jobs.jsonc] [--only smoke,film] [--dry-run] [--no-concat] [--retries 1]
 *                                [--port 5290] [--decode-check] [--allow-battery]
 *   node scripts/drift-queue.mjs [jobs.jsonc] --prores4444 [--only film]     ON THE MAC: a job's FFV1 chunks (from a
 *                                node) → the 12-bit ProRes 4444 master (prores4444Job below)
 *
 *   jobs.jsonc   default: render-queue.jsonc in the repo root. JSON, plus whole-line // comments. The example with a
 *                smoke job and the 8K 12-bit film: scripts/drift-render-queue.example.jsonc
 *
 * PER CHUNK: frames [n0, n1) of the job (frame n at t = from + n/fps, as drift-render counts them), rendered to
 * <out>/<job>/chunks/<job>_<n0>-<n1>.<ext> with a .json beside it: the settings key, the commit, the time it took.
 * A chunk is SKIPPED when its file is there, its key matches the job's settings now, and ffprobe counts exactly
 * n1 − n0 frames; otherwise it is rendered (again). A failed chunk is retried (--retries), then left for the next run
 * while the queue goes on; the exit code says whether everything is done. Each chunk's full log is beside it.
 *
 * AT THE END of a job whose chunks are all there: `ffmpeg -f concat -c copy` into <out>/<job>.<ext> (every chunk
 * starts on a keyframe; ProRes and FFV1 are intra-only), its frame count checked. `"concat": false` keeps only the
 * chunks — for 8K masters, where the joined copy doubles hundreds of GB (DaVinci takes the chunks as clips).
 *
 * THE MACHINE: each chunk runs inside the machine-wide render slots (scripts/drift-slot.mjs, weight = its lanes; at
 * most DRIFT_SLOTS heavy browser jobs at once across everyone, default 2); one render per repo at a time
 * (drift-render's own lock); on battery it refuses (macOS pmset, Linux sysfs, Windows' power line status: the
 * studio's RTX 5090 laptop) unless --allow-battery; while it runs it keeps the machine awake (caffeinate /
 * systemd-inhibit / SetThreadExecutionState) — best effort, a warning when that is not possible.
 *
 * WHERE IT STANDS, for the studio dashboard (scripts/drift-node.mjs reads it and reports it to scripts/drift-dash.mjs;
 * the user, 2026-10-29: "we need the dashboards to be able to see what's happening on those guys"): while it renders,
 * out/drift/queue/status.json holds the job, the chunk, the job's frames done of its total (chunks finished on an
 * earlier run count as done), the rate and a WHOLE-JOB ETA, and the render's newest line; at the end the summary.
 * Not written by --dry-run or --prores4444. A failed write is ignored: the status never stops a render.
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANE_CODECS } from './cine-codecs.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);
const VALUE_FLAGS = new Set(['--only', '--retries', '--port']);
const positional = argv.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(argv[i - 1]));
const JOBS_FILE = resolve(positional[0] ?? join(ROOT, 'render-queue.jsonc'));
const ONLY = arg('only', null)?.split(',') ?? null;
const RETRIES = Math.max(0, Number(arg('retries', '1')));
const PORT = arg('port', '5290');

const SLOT = join(ROOT, 'scripts/drift-slot.mjs');
/** the machine's render slots (scripts/drift-slot.mjs: --slots, else DRIFT_SLOTS, else 2) */
const SLOTS = Number(process.env.DRIFT_SLOTS ?? 2);
const say = (...a) => console.log(`[queue ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sh = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? String(r.error ?? '') };
};
const frameCountOf = (file) => {
  const r = sh('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=nb_frames', '-of', 'csv=p=0', file]);
  return r.ok ? Number(r.out.trim()) : NaN;
};
const pad = (n) => String(n).padStart(6, '0');
const gb = (b) => `${(b / 2 ** 30).toFixed(1)} GB`;

// ------------------------------------------------------------------------------------- where it stands (header)
const STATUS_FILE = join(ROOT, 'out/drift/queue/status.json');
const STATUS_ON = !flag('dry-run') && !flag('prores4444');
const status = { pid: process.pid, file: JOBS_FILE, started: new Date().toISOString(), state: 'rendering', job: null, last: '' };
/** merge `patch` into the status and write it whole (a temp file renamed over it: a reader never sees half) */
function writeStatus(patch = {}) {
  if (!STATUS_ON) return;
  Object.assign(status, patch, { updated: new Date().toISOString() });
  try {
    mkdirSync(dirname(STATUS_FILE), { recursive: true });
    writeFileSync(`${STATUS_FILE}.${process.pid}.tmp`, JSON.stringify(status, null, 1));
    renameSync(`${STATUS_FILE}.${process.pid}.tmp`, STATUS_FILE);
  } catch {
    // (a full disk or a reader holding the file on Windows: the next write tries again; the render goes on)
  }
}

// ------------------------------------------------------------------------------------------------ the jobs
/**
 * the drift-render settings a job may set, and the defaults when neither the job nor `defaults` does (one lane: a job
 * takes as many of the machine's render slots as it has lanes, and two lanes would be all of a default machine)
 */
const DEFAULTS = { fps: 30, ss: 1, blur: 1, shutter: 0.5, codec: 'x264', depth: 8, lanes: 1, chunk: 30, channel: 'chrome', crf: 18, preset: 'medium', inflight: 3, queue: 8, query: null, allowLanes: false, concat: true, out: 'out/drift/queue', msaa: 4 };
/** the settings that change pixels: a chunk rendered with other values is not reused */
const KEY_FIELDS = ['size', 'fps', 'ss', 'blur', 'shutter', 'codec', 'depth', 'crf', 'preset', 'query', 'channel'];
// ("msaa" changes pixels too, but joins the key only when it is not the default 4: chunks rendered before the field
// existed were all 4× MSAA, and their keys must still match — see keyOf)

function loadJobs(file) {
  if (!existsSync(file)) throw new Error(`no jobs file ${file} — copy scripts/drift-render-queue.example.jsonc there, or pass a path`);
  // whole-line // comments only (a // inside a string, e.g. a URL, stays), and trailing commas, so a job is
  // commented in and out line by line without minding the comma before it
  const text = readFileSync(file, 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n').replace(/,(\s*[\]}])/g, '$1');
  const spec = JSON.parse(text);
  const jobs = (spec.jobs ?? []).map((j) => ({ ...DEFAULTS, ...(spec.defaults ?? {}), ...j }));
  for (const j of jobs) {
    if (!/^[\w.-]+$/.test(j.name ?? '')) throw new Error(`job ${JSON.stringify(j.name)}: a name of letters, digits, . _ -`);
    for (const k of ['from', 'to', 'size']) if (!Number.isFinite(j[k])) throw new Error(`job ${j.name}: "${k}" must be a number (the show's length: drift-gpu-check prints it)`);
    if (!(j.to > j.from)) throw new Error(`job ${j.name}: to ${j.to} must be after from ${j.from}`);
    if (!(j.codec in LANE_CODECS)) throw new Error(`job ${j.name}: codec ${j.codec}: ${Object.keys(LANE_CODECS).join(' | ')}`);
    if (!LANE_CODECS[j.codec].depths.includes(j.depth)) throw new Error(`job ${j.name}: codec ${j.codec} takes depth ${LANE_CODECS[j.codec].depths.join(' | ')}`);
    if (!(j.chunk > 0)) throw new Error(`job ${j.name}: chunk (s) must be > 0`);
    if (j.msaa !== 4 && j.msaa !== 0) throw new Error(`job ${j.name}: msaa ${j.msaa}: 4 (the faces' 4× MSAA, the default) | 0 (off: less GPU memory)`);
    if (j.lanes > SLOTS) throw new Error(`job ${j.name}: ${j.lanes} lanes need ${j.lanes} render slots, the machine has ${SLOTS} (DRIFT_SLOTS)`);
  }
  if (new Set(jobs.map((j) => j.name)).size !== jobs.length) throw new Error('two jobs share a name');
  return jobs;
}

/** frames [n0, n1) of each chunk, by frames (so chunk seams are exact frames, not rounded seconds) */
function chunksOf(j) {
  const F = Math.round((j.to - j.from) * j.fps);
  const C = Math.max(1, Math.round(j.chunk * j.fps));
  const ext = LANE_CODECS[j.codec].ext;
  const dir = resolve(ROOT, j.out, j.name);
  return Array.from({ length: Math.ceil(F / C) }, (_, k) => {
    const n0 = k * C;
    const n1 = Math.min(F, n0 + C);
    return { n0, n1, from: j.from + n0 / j.fps, to: j.from + n1 / j.fps, file: join(dir, 'chunks', `${j.name}_${pad(n0)}-${pad(n1)}.${ext}`) };
  });
}

const keyOf = (j) => JSON.stringify({ ...Object.fromEntries(KEY_FIELDS.map((k) => [k, j[k] ?? null])), ...(j.msaa !== 4 ? { msaa: j.msaa } : {}) });
const commit = () => {
  const c = sh('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD']).out.trim() || 'unknown';
  const dirty = sh('git', ['-C', ROOT, 'status', '--porcelain', '--untracked-files=no']).out.trim() !== '';
  return `${c}${dirty ? '+dirty' : ''}`;
};

/** null when the chunk on disk is complete and current, else why it must be rendered */
function staleReason(j, c) {
  if (!existsSync(c.file)) return 'not rendered';
  const meta = existsSync(`${c.file}.json`) ? JSON.parse(readFileSync(`${c.file}.json`, 'utf8')) : null;
  if (meta === null) return 'no .json beside it (not this queue\'s, or interrupted)';
  if (meta.key !== keyOf(j)) return 'rendered with other settings';
  const n = frameCountOf(c.file);
  if (n !== c.n1 - c.n0) return `${n} frames, ${c.n1 - c.n0} expected`;
  if (flag('decode-check')) {
    const d = sh('ffmpeg', ['-v', 'error', '-xerror', '-i', c.file, '-f', 'null', '-']);
    if (!d.ok || d.err.trim() !== '') return `does not decode cleanly: ${d.err.trim().split('\n')[0]}`;
  }
  return null;
}

// --------------------------------------------------------------------------------------------- the machine
function checkPower() {
  if (flag('allow-battery')) return;
  if (process.platform === 'darwin') {
    const b = sh('pmset', ['-g', 'batt']).out;
    if (b && !b.includes("'AC Power'")) throw new Error(`on battery (pmset -g batt: ${b.split('\n')[0]}) — plug in, or --allow-battery`);
  } else if (process.platform === 'linux') {
    const ps = '/sys/class/power_supply';
    const mains = existsSync(ps) ? readdirSync(ps).filter((d) => existsSync(join(ps, d, 'type')) && readFileSync(join(ps, d, 'type'), 'utf8').trim() === 'Mains') : [];
    // a desktop has no Mains entry at all: nothing to check
    if (mains.length > 0 && !mains.some((d) => readFileSync(join(ps, d, 'online'), 'utf8').trim() === '1')) throw new Error('on battery (/sys/class/power_supply) — plug in, or --allow-battery');
  } else if (process.platform === 'win32') {
    // GetSystemPowerStatus' AC line status, through WinForms (Windows PowerShell 5.1 ships with every Windows 10/11; no
    // admin, ~0.5 s). Win32_Battery's BatteryStatus was the other way, but its "low" and "fully charged" codes do not
    // say whether the charger is in. A desktop reports Online.
    const r = sh('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus']);
    const line = r.out.trim();
    if (line === 'Offline') throw new Error('on battery (Windows power status: the charger is out) — plug in, or --allow-battery');
    if (line !== 'Online') say(`WARNING: cannot read the power state (${line || r.err.trim().split('\n')[0] || 'no answer'}) — rendering anyway; keep the charger in`);
  }
}

/** keep the machine from idle-sleeping while this process lives; returns the helper process (or null) */
function stayAwake() {
  const pid = String(process.pid);
  try {
    let p = null;
    if (process.platform === 'darwin') p = spawn('caffeinate', ['-i', '-s', '-w', pid], { stdio: 'ignore' });
    // (held by a `tail` that ends with this process, as caffeinate -w does: nothing outlives the queue)
    else if (process.platform === 'linux') p = spawn('systemd-inhibit', ['--what=idle:sleep', '--who=drift-queue', '--why=rendering The Drift', '--mode=block', 'tail', `--pid=${pid}`, '-f', '/dev/null'], { stdio: 'ignore' });
    else if (process.platform === 'win32') {
      // ES_CONTINUOUS | ES_SYSTEM_REQUIRED, held by a PowerShell thread until this process exits (no setting changes)
      const ps = `$k = Add-Type -Name P -Namespace W -PassThru -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; [void]$k::SetThreadExecutionState([uint32]2147483649); Wait-Process -Id ${pid}`;
      p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { stdio: 'ignore', windowsHide: true });
    }
    p?.on('error', (e) => say(`WARNING: cannot keep the machine awake (${e.message}) — disable sleep while rendering`));
    return p;
  } catch (e) {
    say(`WARNING: cannot keep the machine awake (${e.message}) — disable sleep while rendering`);
    return null;
  }
}

// ---------------------------------------------------------------------------------------------- rendering
/**
 * drift-render.mjs allows one render per repo (out/drift/.render.lock) and FAILS when another holds it; a queue
 * waits instead, so another session's render costs it time, not a chunk's retries
 */
async function waitForRenderLock() {
  const lock = join(ROOT, 'out/drift/.render.lock');
  let said = false;
  for (;;) {
    let pid = NaN;
    try {
      pid = Number(readFileSync(lock, 'utf8').trim());
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (!said) say(`  waiting: another render holds ${relative(ROOT, lock)} (pid ${pid})`);
    said = true;
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

function renderArgs(j, c) {
  return [
    join(ROOT, 'scripts/drift-render.mjs'),
    '--size', String(j.size), '--fps', String(j.fps), '--from', String(c.from), '--to', String(c.to),
    '--ss', String(j.ss), '--blur', String(j.blur), '--shutter', String(j.shutter),
    '--codec', j.codec, '--depth', String(j.depth), '--lanes', String(j.lanes), '--channel', j.channel,
    '--crf', String(j.crf), '--preset', j.preset, '--inflight', String(j.inflight), '--queue', String(j.queue),
    '--port', PORT, '--out', c.file, '--msaa', String(j.msaa),
    ...(j.allowLanes ? ['--allow-lanes'] : []),
    ...(j.query ? ['--query', j.query] : []),
    ...(j.extra ?? []),
  ];
}

/**
 * one drift-render run; its whole output to the chunk's log, the progress and the trouble to the console, and each
 * progress line ("[render] n/N  x fps") to `onProgress(n, fps)` (the status file)
 */
function renderChunk(j, c, attempt, onProgress = () => {}) {
  return new Promise((res) => {
    mkdirSync(dirname(c.file), { recursive: true });
    const logFile = c.file.replace(/\.\w+$/, '.log');
    const log = createWriteStream(logFile, { flags: attempt === 0 ? 'w' : 'a' });
    // THE MACHINE'S RENDER SLOTS (scripts/drift-slot.mjs; the user, 2026-10-29: "not more than two lanes of heavy
    // renderers", across every agent and person on the machine): a chunk waits for as many slots as it has lanes,
    // holds them while it renders and gives them back when it ends. DRIFT_SLOTS sets the machine's count (default 2).
    const render = renderArgs(j, c);
    const args = existsSync(SLOT) ? [SLOT, '--weight', String(j.lanes), '--', process.execPath, ...render] : render;
    if (!existsSync(SLOT) && attempt === 0) say(`  WARNING: no ${relative(ROOT, SLOT)}: rendering without the machine's render slots`);
    log.write(`# ${new Date().toISOString()} attempt ${attempt + 1}: node ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}\n`);
    const p = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let last = 0;
    let tail = '';
    const onData = (d) => {
      log.write(d);
      tail = (tail + d).slice(-4000);
      for (const line of String(d).split('\n')) {
        if (!line.trim()) continue;
        status.last = line.trim().slice(0, 300);
        const rate = /^\[render\] (\d+)\/\d+\s+([\d.]+) fps/.exec(line);
        if (rate) onProgress(Number(rate[1]), Number(rate[2]));
        const progress = /^\[render\] \d+\/\d+ /.test(line);
        if (progress && Date.now() - last < 30_000) continue;
        if (progress || /FAILED|WARNING|Error|error|total:|GPU |codec|drift-slot/.test(line)) {
          if (progress) last = Date.now();
          console.log(`    ${line.slice(0, 220)}`);
        }
      }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('close', (code) => {
      current = null;
      log.end();
      res({ code, tail, logFile });
    });
    // the queue stopped (Ctrl-C): the render gets the signal and cleans up its lanes itself
    current = p;
  });
}
let current = null;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    say(`${sig}: stopping the render in progress (finished chunks stay; run the queue again to resume)`);
    writeStatus({ state: 'failed', ended: new Date().toISOString(), error: `${sig}: stopped (finished chunks stay)` });
    current?.kill(sig);
    setTimeout(() => process.exit(130), 20_000).unref();
    current?.once('close', () => process.exit(130));
    if (!current) process.exit(130);
  });
}

async function runJob(j, jobIndex = 0, jobCount = 1) {
  const chunks = chunksOf(j);
  const dir = resolve(ROOT, j.out, j.name);
  const F = Math.round((j.to - j.from) * j.fps);
  const qlog = (m) => {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'queue.log'), `${new Date().toISOString()} ${m}\n`);
  };
  const est = F * j.size * j.size * LANE_CODECS[j.codec].bytesPerPx * (j.concat && !flag('no-concat') ? 2 : 1);
  say(`job ${j.name}: [${j.from}, ${j.to}) s = ${F} frames, ${j.size}² ${j.codec} ${j.depth}-bit, ss ${j.ss}, blur ${j.blur}, ${chunks.length} chunk(s) of ≤ ${Math.round(j.chunk * j.fps)} frames -> ${relative(ROOT, dir)} (≲ ${gb(est)})`);
  // (the nearest directory that exists: a dry run creates nothing)
  let probe = dir;
  while (!existsSync(probe)) probe = dirname(probe);
  const st = statfsSync(probe);
  if (st.bavail * st.bsize < est) say(`  WARNING: ${gb(st.bavail * st.bsize)} free under ${probe}, this job may need ${gb(est)} — it will stop when a chunk does not fit`);
  const failed = [];
  let todo = 0;
  // every chunk's state first, so the status counts the chunks done on an earlier run before it renders the first
  // missing one (else a job resumed mid-way shows them only as the loop passes them, and its ETA runs long)
  const whys = chunks.map((c) => staleReason(j, c));
  // THE WHOLE JOB'S ETA: the frames still to render over this run's own rate — the frames of the chunks it finished
  // over their wall time, booting the page and waiting for slots included, which is what the rest will cost too.
  // Before its first chunk ends, the render's live rate (its "[render] n/N x fps" lines, also counted from launch).
  let framesDone = chunks.reduce((a, c, i) => a + (whys[i] === null ? c.n1 - c.n0 : 0), 0);
  let chunksDone = whys.filter((w) => w === null).length;
  let ranFrames = 0;
  let ranSecs = 0;
  const jobStarted = new Date().toISOString();
  const report = (i, inChunk = 0, liveFps = 0) => {
    const frames = framesDone + inChunk;
    const rate = ranSecs > 0 ? ranFrames / ranSecs : liveFps;
    writeStatus({
      job: { name: j.name, index: jobIndex + 1, jobs: jobCount, chunk: Math.min(i + 1, chunks.length), chunks: chunks.length, chunksDone, frames, framesTotal: F,
        fps: rate > 0 ? Math.round(rate * 100) / 100 : null, etaS: rate > 0 ? Math.round((F - frames) / rate) : null, out: relative(ROOT, dir), started: jobStarted },
    });
  };
  const firstTodo = whys.findIndex((w) => w !== null);
  report(firstTodo === -1 ? chunks.length - 1 : firstTodo);
  for (const [i, c] of chunks.entries()) {
    const why = whys[i];
    const label = `chunk ${i + 1}/${chunks.length} frames [${c.n0}, ${c.n1}) t [${c.from.toFixed(3)}, ${c.to.toFixed(3)})`;
    if (why === null) {
      say(`  ${label}: done, skipped`);
      continue;
    }
    if (flag('dry-run')) {
      say(`  ${label}: would render (${why})`);
      todo++;
      continue;
    }
    let ok = false;
    for (let attempt = 0; attempt <= RETRIES && !ok; attempt++) {
      checkPower();
      await waitForRenderLock();
      say(`  ${label}: rendering (${why})${attempt > 0 ? `, retry ${attempt}` : ''}`);
      report(i);
      const t0 = Date.now();
      const r = await renderChunk(j, c, attempt, (n, fps) => report(i, n, fps));
      const secs = (Date.now() - t0) / 1000;
      const n = r.code === 0 && existsSync(c.file) ? frameCountOf(c.file) : NaN;
      ok = n === c.n1 - c.n0;
      if (ok) {
        framesDone += n;
        chunksDone++;
        ranFrames += n;
        ranSecs += secs;
        report(i + 1);
        writeFileSync(`${c.file}.json`, JSON.stringify({ key: keyOf(j), commit: commit(), frames: n, rendered: new Date().toISOString(), secs, fps: n / secs, host: process.platform }, null, 2));
        say(`  ${label}: ok, ${n} frames in ${(secs / 60).toFixed(1)} min wall, waiting for slots included (${(n / secs).toFixed(2)} fps; the render's own rate is its "total:" line)`);
        qlog(`ok ${relative(dir, c.file)} ${n} frames ${secs.toFixed(0)} s`);
      } else {
        say(`  ${label}: FAILED (exit ${r.code}${Number.isFinite(n) ? `, ${n} frames` : ''}) — log ${r.logFile}`);
        qlog(`FAILED ${relative(dir, c.file)} exit ${r.code}: ${r.tail.split('\n').filter(Boolean).slice(-3).join(' / ')}`);
      }
    }
    if (!ok) failed.push(c);
  }
  if (failed.length > 0 || flag('dry-run')) return { job: j.name, done: chunks.length - failed.length - todo, of: chunks.length, joined: null };
  if (!j.concat || flag('no-concat')) return { job: j.name, done: chunks.length, of: chunks.length, joined: 'chunks only' };

  // ------------------------------------------------------------------------------------------ the join
  const out = join(resolve(ROOT, j.out), `${j.name}.${LANE_CODECS[j.codec].ext}`);
  const newest = Math.max(...chunks.map((c) => statSync(c.file).mtimeMs));
  if (existsSync(out) && statSync(out).mtimeMs > newest && frameCountOf(out) === F) {
    say(`  joined file is current: ${out}`);
    return { job: j.name, done: chunks.length, of: chunks.length, joined: out };
  }
  const commits = new Set(chunks.map((c) => JSON.parse(readFileSync(`${c.file}.json`, 'utf8')).commit));
  if (commits.size > 1) say(`  WARNING: the chunks come from ${commits.size} code states (${[...commits].join(', ')}) — a look change mid-job shows at a seam`);
  const joined = joinFiles(chunks.map((c) => c.file), out, F, join(dir, 'concat.txt'));
  qlog(joined ? `joined ${out} ${F} frames` : 'JOIN FAILED');
  return { job: j.name, done: chunks.length, of: chunks.length, joined };
}

/** `ffmpeg -f concat -c copy` of whole clips into `out` (.part until its frame count is F); out or null */
function joinFiles(files, out, F, list) {
  const quoted = (f) => `file '${(process.platform === 'win32' ? f.replace(/\\/g, '/') : f).replace(/'/g, "'\\''")}'\n`;
  writeFileSync(list, files.map(quoted).join(''));
  const ext = out.endsWith('.mp4') ? 'mp4' : 'mov';
  const r = sh('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', ...(ext === 'mp4' ? ['-movflags', '+faststart'] : []), '-f', ext, `${out}.part`]);
  const n = r.ok ? frameCountOf(`${out}.part`) : NaN;
  if (n !== F) {
    say(`  JOIN FAILED: ${r.ok ? `${n} frames, ${F} expected` : r.err.trim()} — left ${out}.part`);
    return null;
  }
  renameSync(`${out}.part`, out);
  say(`  joined: ${out} (${F} frames)`);
  return out;
}

/**
 * THE 12-BIT PRORES 4444 MASTER, ON THE MAC (--prores4444): every FFV1 chunk of a job becomes ProRes 4444 on
 * VideoToolbox, the only 12-bit ProRes encoder ffmpeg has (prores_ks takes 10-bit input: off macOS this refuses).
 * The FFV1 already holds BT.709 Y'CbCr at 12 bits (cine-sink's REC709 conversion, done on the node), so this is a
 * move of bit depth, no colour math; the tags go on the frames as the sink does it (setparams). A chunk converted
 * before (its frame count right, newer than its source) is skipped; then they are joined like a render's chunks,
 * unless "concat": false / --no-concat. The FFV1 chunks stay: delete them yourself once the master checks out
 * (frame count, and a macOS decode: docs/drift/RENDER-NODE.md).
 */
function prores4444Job(j) {
  const chunks = chunksOf(j);
  if (j.codec !== 'ffv1') {
    say(`job ${j.name}: codec ${j.codec}, not ffv1 — nothing to convert`);
    return { job: j.name, done: chunks.length, of: chunks.length, joined: null };
  }
  if (process.platform !== 'darwin') throw new Error('--prores4444 runs on the Mac: its 12-bit ProRes 4444 encoder is VideoToolbox (ffmpeg\'s prores_ks takes 10-bit input)');
  const dir = join(resolve(ROOT, j.out, j.name), 'prores4444');
  say(`job ${j.name}: ${chunks.length} FFV1 chunk(s) → ProRes 4444 12-bit in ${relative(ROOT, dir)}`);
  const made = [];
  for (const c of chunks) {
    const dst = join(dir, basename(c.file).replace(/\.mov$/, '_4444.mov'));
    const want = c.n1 - c.n0;
    if (!existsSync(c.file) || frameCountOf(c.file) !== want) {
      say(`  ${basename(c.file)}: not rendered (completely) yet`);
      continue;
    }
    if (existsSync(dst) && statSync(dst).mtimeMs > statSync(c.file).mtimeMs && frameCountOf(dst) === want) {
      made.push(dst);
      continue;
    }
    mkdirSync(dir, { recursive: true });
    const t0 = Date.now();
    const r = sh('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', c.file, '-an',
      '-vf', 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv',
      '-c:v', 'prores_videotoolbox', '-profile:v', '4444', '-pix_fmt', 'p416le',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
      '-movflags', '+faststart', '-f', 'mov', `${dst}.part`]);
    const n = r.ok ? frameCountOf(`${dst}.part`) : NaN;
    if (n !== want) {
      say(`  ${basename(dst)}: FAILED (${r.ok ? `${n} frames` : r.err.trim().split('\n')[0]})`);
      continue;
    }
    renameSync(`${dst}.part`, dst);
    made.push(dst);
    say(`  ${basename(dst)}: ${n} frames, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  if (made.length < chunks.length || !j.concat || flag('no-concat')) return { job: j.name, done: made.length, of: chunks.length, joined: made.length === chunks.length ? 'chunks only' : null };
  const F = Math.round((j.to - j.from) * j.fps);
  const out = join(resolve(ROOT, j.out), `${j.name}_4444.mov`);
  if (existsSync(out) && statSync(out).mtimeMs > Math.max(...made.map((f) => statSync(f).mtimeMs)) && frameCountOf(out) === F) return { job: j.name, done: made.length, of: chunks.length, joined: out };
  return { job: j.name, done: made.length, of: chunks.length, joined: joinFiles(made, out, F, join(dir, 'concat.txt')) };
}

async function main() {
  const jobs = loadJobs(JOBS_FILE).filter((j) => j.enabled !== false && (ONLY === null || ONLY.includes(j.name)));
  if (ONLY) for (const o of ONLY) if (!jobs.some((j) => j.name === o)) throw new Error(`--only ${o}: no such enabled job in ${JOBS_FILE}`);
  if (jobs.length === 0) throw new Error(`no enabled jobs in ${JOBS_FILE}`);
  say(`${jobs.length} job(s) from ${JOBS_FILE}${flag('dry-run') ? ' (dry run)' : ''}${flag('prores4444') ? ', FFV1 chunks → ProRes 4444' : ''}`);
  if (!flag('dry-run')) {
    checkPower();
    stayAwake();
  }
  const results = [];
  for (const [k, j] of jobs.entries()) results.push(flag('prores4444') ? prores4444Job(j) : await runJob(j, k, jobs.length));
  say('summary:');
  for (const r of results) say(`  ${r.job}: ${r.done}/${r.of} chunks${r.joined ? `, ${r.joined}` : ''}`);
  const incomplete = results.filter((r) => r.done < r.of);
  writeStatus({ state: incomplete.length > 0 ? 'failed' : 'done', ended: new Date().toISOString(), results, ...(incomplete.length > 0 ? { error: `incomplete: ${incomplete.map((r) => r.job).join(', ')}` } : {}) });
  if (incomplete.length > 0 && !flag('dry-run')) {
    say(`INCOMPLETE: ${incomplete.map((r) => r.job).join(', ')} — run the queue again to retry the missing chunks`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(`[queue] FAILED: ${e?.message ?? e}`);
  writeStatus({ state: 'failed', ended: new Date().toISOString(), error: String(e?.message ?? e) });
  process.exit(1);
});
