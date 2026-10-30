/**
 * THE DRIFT FARM, its hub side: a job queue on this Mac's dashboard (scripts/drift-dash.mjs) that the studio's render
 * machines pull work from (the user, 2026-10-29: "you will make sure that these machines get fat work … accelerate
 * what we are doing … more GPU power so we have to wait less … get the render results, feed them").
 *
 * PULL, NOT PUSH: the boxes come to the Mac (`drift-node.mjs worker`, scripts/drift-farm-client.mjs) — a long poll
 * for work, the job's code and inputs downloaded, progress and result files sent back. Nothing on the boxes listens,
 * so no inbound SSH or open port is needed on the Windows machines.
 *
 *   POST /farm/jobs                    a job: { label, argv, kind, prefer, weight, base, bundle, outs, inputs }
 *   PUT  /farm/jobs/:id/payload        its code state and inputs (.tar.gz, drift-farm-client.mjs packState); it is
 *                                      queued once this has arrived
 *   GET  /farm/claim?node=&speed=      a worker asking for work: answered at once with a job, or held up to 25 s
 *        [&busy=<why>]                 (a worker whose GPU someone else holds says so instead, and is not given work)
 *   GET  /farm/jobs/:id/payload        the worker's download
 *   POST /farm/jobs/:id/status         { state, lines, progress, exitCode, error, fps } — the answer says { cancel }
 *   PUT  /farm/jobs/:id/files?out=&path=   a result file, streamed
 *   GET  /farm/jobs/:id[?from=n]       the job, and its log from line n (the submitter follows it with this)
 *   GET  /farm/jobs/:id/files/:out/<path>  a result file
 *   POST /farm/jobs/:id/cancel, /requeue, POST /farm/nodes/:name/state   the dashboard's CONTROLS (below: loopback only)
 *   GET  /farm/workers                 who is free, busy or busy with someone else's work, and their speed
 *   PUT  /farm/jobs/:id/preview        the job's newest frame, a small JPEG (drift-preview.mjs; the worker sends it)
 *   GET  /farm/jobs/:id/preview.jpg    … for the console's "now rendering" mosaic: from loopback and the tailnet, NO
 *                                      token (the dashboard page has none; a 640 px frame, nothing else)
 *   POST /farm/runs                    a chunked render (drift-farm-render.mjs) says what it is: { id, kind, from, to,
 *                                      chunks: [{ from, to, here }] }; its chunks' jobs carry `run`, and /api's Farm
 *                                      shows each run with its chunks' states (the console's full-show tracker)
 *   GET  /farm/bundle/latest-assets.json, /farm/bundle/drift-assets-<date>.tar.gz
 *                                      THE ASSET BUNDLE over the same door (out/drift-bundle): the Windows boxes have no
 *                                      SSH, so a worker syncs its bundle from here (drift-node-lib.mjs, a "farm" source)
 *   GET  /farm/bundle/manifest         the newest assets' manifest (out/drift-bundle/manifest-assets.json, as a full
 *                                      build or drift-bundle.mjs --manifest-only last wrote it)
 *   GET  /farm/bundle/file?path=<p>    ONE FILE of it, by its manifest path only, from this checkout; its sha256 in
 *                                      x-sha256, Range for a resumed fetch. A box with a bundle patches it file by file
 *                                      (drift-node-lib.mjs patchBundle; the user, 2026-10-30: "make sure the bundle can
 *                                      be incrementally patched instead of having to upload the whole huge thing all
 *                                      the time"); the tarball is for a box with none
 *
 * AUTH: only from loopback or the tailnet (the dashboard's fromTailnet), and then either
 *   - the shared token in a bearer header: the Mac's farm.json (gitignored — farmToken refuses to write or use one
 *     git would take; the dashboard writes it with a random token on its first start), compared in constant time; or
 *   - for a worker's own routes (claim, payload, status, result files, the bundle), its TAILNET ADDRESS, the one
 *     drift-farm-nodes.json lists for it, claiming only as itself. Tailscale ties that address to the box's device
 *     key, so nothing else on the tailnet can use it. This is what lets studio-manager start a worker with nothing
 *     secret to hand over: its secrets are generated on the box and never travel (studio-manager SPEC V53), so the
 *     Mac's token could not reach a box that way.
 *
 * THE QUEUE lives in out/drift/farm/jobs/<id>/ (job.json, payload.tgz, log.txt, results/), so a dashboard restart
 * loses nothing: a worker keeps reporting to the job it has. A job whose worker stops reporting for 2 min goes back to
 * the queue (twice at most, then it fails: "the box stopped answering").
 *
 * WHO GETS WHAT (pickWorker): any free box that takes work takes any job — the highest priority first, the oldest
 * first within it (PRIORITIES) — and of the boxes asking at once, the fastest. Nothing is held back for a faster box
 * (the user, 2026-10-30: "I don't think we have to limit any of these machines artificially … even the EEG 5090 laptop
 * can really pack a punch": clips and long jobs had waited up to 2 min for the fastest box while a slower one idled).
 * `prefer` pins a box. Speeds start from scripts/drift-farm-nodes.json ("speed", a 4090 desktop 1.0) and are learned
 * from what the boxes measure (frames per second per kind of job, out/drift/farm/speeds.json): for estimates and for
 * the order among boxes asking at once, never to hold work back.
 *
 * WHETHER A BOX TAKES WORK is a run-time state, set from this Mac's dashboard (the user, 2026-10-30: "push a button
 * and deregister it … so that we are not magically blocking these things … and we can opt them out of taking tasks …
 * and not poke holes"), kept in out/drift/farm/nodes-state.json — nothing to commit or push to opt a box in or out:
 *   accepting  takes new jobs (the default)
 *   draining   finishes the job it has, takes no new one
 *   paused     takes nothing, and a job it has goes back to the queue (requeued as a new job): it idles with no GPU use
 *   removed    as paused, and its worker leaves its work loop and only asks every 5 min whether it is back
 * POST /farm/nodes/:name/state { state }, POST /farm/jobs/:id/cancel and /requeue are the CONTROLS: from loopback
 * only (the dashboard page on this Mac), never through the tailnet listener, not even with the token; JSON only
 * (a cross-site form cannot send it without a preflight this server never answers), and an Origin, when sent, must be
 * this machine's. Each change is a line in out/drift/farm/farm.log with its time and source. A worker learns its
 * state from every claim's answer (header x-drift-farm-state) and every status reply.
 *
 * THE PULSE, BOTH WAYS (the user, 2026-10-30: "more back and forth so things don't just wait forever … we have the
 * pulse of these things and push them and pull them"): a worker always has a claim open, and every answer carries
 *   x-drift-farm-state    its farm state
 *   x-drift-farm-command  a command from the dashboard, when one waits: sync-now, gpu-check-now, restart (pause,
 *                         resume, drain are state changes: POST /farm/nodes/:name/command, the same CONTROLS rules)
 *   x-drift-farm-head     origin/main's commit as this Mac last saw it (git ls-remote, every 30 s)
 *   x-drift-farm-bundle   the content id of the newest assets (latest-assets.json: its "manifest", which
 *                         --manifest-only moves on without a tarball; else the tarball's own)
 * A held claim is answered AT ONCE when a command or a state change arrives for its box, so nothing waits out a timer;
 * a worker whose code or bundle is behind syncs while it is idle (drift-node.mjs worker).
 *   node scripts/drift-farm.mjs kick <box> sync-now|gpu-check-now|restart|pause|resume|drain     (this Mac, loopback)
 *   node scripts/drift-farm.mjs state <box> accepting|draining|paused|removed
 *   node scripts/drift-farm.mjs consistency    every machine draws the same shots at HEAD, compared with this Mac's
 *                                              (scripts/drift-consistency.mjs)
 *   node scripts/drift-farm.mjs render --from 0 --to 770 --chunk 20 --size 2048 --priority low
 *                                              a whole render in chunks over every free box, joined on this Mac
 *                                              (scripts/drift-farm-render.mjs)
 *   node scripts/drift-farm.mjs cancel --agent <name> | --all-low | <id> …   every unfinished job of an agent, every
 *                                              unfinished low one, or those ids
 */
import { execFile, spawnSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { copyFileSync, createReadStream, createWriteStream, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { contentId } from './drift-node-lib.mjs';

/** ms a preparing or running job may go without a word from its worker before it is queued again */
export const LEASE_MS = 120_000;
/** ms a claim is held open */
export const CLAIM_HOLD_MS = 25_000;
/** ms since its last claim that a worker still counts as free */
export const FREE_MS = 35_000;

// ------------------------------------------------------------------------------------------- the state machine
const NEXT = {
  uploading: ['queued', 'cancelled', 'failed'],
  queued: ['preparing', 'cancelled'],
  preparing: ['running', 'queued', 'done', 'failed', 'cancelled'],
  running: ['done', 'failed', 'queued', 'cancelled'],
  done: [],
  failed: [],
  cancelled: [],
};
export const FINAL = new Set(['done', 'failed', 'cancelled']);

/** the job moved to `to` (with `patch`), or an error: a finished job stays finished, nothing skips the queue */
export function transition(job, to, patch = {}) {
  if (!(NEXT[job.state] ?? []).includes(to)) throw new Error(`farm job ${job.id}: ${job.state} → ${to} is not a move`);
  return { ...job, ...patch, state: to };
}

/** what kind of work a command is: quick stills, a review clip, or a long render */
export function jobKind(argv) {
  const s = argv.join(' ');
  if (/drift-(review-)?stills\.mjs/.test(s)) return 'still';
  if (/drift-(render|queue|node)\.mjs/.test(s)) return 'long';
  return 'clip';
}

/** the class a speed is measured in: the script and its size (a 1280 px clip is not an 8K chunk) */
export function jobClass(argv) {
  const script = argv.map((a) => basename(String(a))).find((a) => a.endsWith('.mjs')) ?? argv[0] ?? '?';
  const size = (() => {
    for (const f of ['--width', '--size']) {
      const i = argv.indexOf(f);
      if (i >= 0 && /^\d+$/.test(argv[i + 1] ?? '')) return argv[i + 1];
    }
    return argv.find((a) => /^\d{3,5}$/.test(a)) ?? '-';
  })();
  return `${script}:${size}`;
}

// ------------------------------------------------------------------------------------------------ scheduling
/**
 * A JOB'S PRIORITY (the user, 2026-10-30: "I gave you all the computer in the world and everything is idle"): the
 * agents' review jobs are short and come in bursts while they code, so the boxes idle between them; a background
 * render (the whole show as a preview, drift-farm.mjs render) fills the gaps at `low` without slowing the agents'
 * loop. The queue hands out the highest priority first, the oldest first within it; a `low` job takes a box only when
 * no higher job that could use that box is queued (one pinned to another box does not hold it back). A running low job
 * is never stopped: its chunks are kept short instead (20 s of show), so a normal job waits at most one chunk.
 */
export const PRIORITIES = ['low', 'normal', 'high'];
export const rankOf = (job) => Math.max(0, PRIORITIES.indexOf(job.priority ?? 'normal'));
/** the queued jobs in the order they are handed out: priority, then age */
export const queueOrder = (queued) => [...queued].sort((a, b) => rankOf(b) - rankOf(a) || (a.queuedAt ?? a.createdAt) - (b.queuedAt ?? b.createdAt));
/** may `job` take `node` while `queued` (the others) wait? Not while a higher job that could use that box is queued */
export const yieldsTo = (job, node, queued) => queued.some((h) => h !== job && rankOf(h) > rankOf(job) && (!h.prefer || h.prefer === node));

/** ms a job sent back for results that were not pictures stays off the box that made them (drift-sanity.mjs) */
export const AVOID_MS = 10 * 60_000;

/** the worker that takes `job` now, or null (hold it): of the workers in a claim right now [{ node, speed }], the
 * fastest (only the pinned one, when `prefer`; not one the job is avoiding, until `avoidUntil`) — header: WHO GETS WHAT */
export function pickWorker(job, waiting, now = Date.now()) {
  const avoid = job.avoid && now < (job.avoidUntil ?? 0) ? new Set(job.avoid) : null;
  const cands = (job.prefer ? waiting.filter((w) => w.node === job.prefer) : waiting.filter((w) => !avoid?.has(w.node))).sort((a, b) => b.speed - a.speed);
  return cands[0]?.node ?? null;
}

/**
 * why a queued job has no box yet, in words for the dashboard (FarmJob.why). `workers`: view()'s, each { node, state:
 * waiting | busy | busy-foreign | offline, why (busy-foreign: who, "ComfyUI 18 GB"), speed }
 */
export function holdReason(job, workers, now, queued = []) {
  const word = (w) => (w.state === 'busy-foreign' ? `${w.node} busy (${w.why ?? 'someone else on the GPU'})` : w.state === 'busy' ? `${w.node} busy with another job` : w.state === 'offline' ? `${w.node} offline` : `${w.node} free`);
  // only boxes that take work (farmState accepting) are candidates; the others say so
  const takes = (w) => (w.farmState ?? 'accepting') === 'accepting';
  const asked = job.prefer ? workers.filter((w) => w.node === job.prefer) : workers;
  if (asked.length === 0) return `${job.prefer} is not a farm box`;
  // (low priority, header of PRIORITIES: behind the queued jobs above it that could use the same boxes)
  const above = (queued ?? []).filter((h) => rankOf(h) > rankOf(job) && (!h.prefer || !job.prefer || h.prefer === job.prefer));
  if (above.length > 0) return `${job.priority ?? 'normal'} priority: after ${above.length} queued job(s) above it`;
  const pool = asked.filter(takes);
  if (pool.length === 0) return job.prefer ? `${job.prefer} is ${asked[0].farmState} in the farm (the dashboard)` : `no box takes jobs (${asked.map((w) => `${w.node} ${w.farmState}`).join(', ')})`;
  const up = pool.filter((w) => w.state !== 'offline');
  if (up.length === 0) return job.prefer ? `${job.prefer} offline (no worker running there)` : 'no worker online';
  const free = up.filter((w) => w.state === 'waiting').sort((a, b) => b.speed - a.speed);
  if (free.length === 0) return pool.map(word).join(', ');
  return 'being handed out';
}

/**
 * speeds.json after a finished job: its class's frame rate on that node (an average leaning to the newest), and its
 * duration as it would have been on a speed-1 box (for queued jobs' estimates). { nodes: { [node]: { [cls]: fps } },
 * dur1: { [cls]: s } }
 */
export function learn(speeds, { node, cls, fps, durS, speed }) {
  const next = { nodes: { ...(speeds?.nodes ?? {}) }, dur1: { ...(speeds?.dur1 ?? {}) } };
  const ema = (old, v) => (Number.isFinite(old) ? Math.round((0.6 * old + 0.4 * v) * 1000) / 1000 : v);
  if (Number.isFinite(fps) && fps > 0) next.nodes[node] = { ...(next.nodes[node] ?? {}), [cls]: ema(next.nodes[node]?.[cls], fps) };
  if (Number.isFinite(durS) && durS > 0 && Number.isFinite(speed) && speed > 0) next.dur1[cls] = ema(next.dur1[cls], durS * speed);
  return next;
}

/**
 * a node's relative speed: in each class two or more nodes have measured, its frame rate over the fastest node's,
 * averaged; with nothing to compare, drift-farm-nodes.json's guess (`hint`), else 1
 */
export function speedOf(node, speeds, hint = 1) {
  const mine = speeds?.nodes?.[node] ?? {};
  const ratios = [];
  for (const [cls, fps] of Object.entries(mine)) {
    const all = Object.values(speeds.nodes).map((n) => n[cls]).filter((v) => Number.isFinite(v) && v > 0);
    if (all.length >= 2) ratios.push(fps / Math.max(...all));
  }
  return ratios.length > 0 ? Math.round((ratios.reduce((a, b) => a + b, 0) / ratios.length) * 100) / 100 : hint;
}

/** ms between two of a job's fps samples (fpsSamples), and how many it keeps: 120 × 10 s, the last 20 min */
export const SAMPLE_MS = 10_000;
export const SAMPLES_MAX = 120;

/**
 * a running job's frame rate over time, for the console's sparkline (the user, 2026-10-30, a studio hub showing
 * "time, processing, FPS"): [ms epoch, fps, frames done] appended at most every SAMPLE_MS, the newest SAMPLES_MAX
 */
export function fpsSamples(samples, t, fps, done) {
  const list = Array.isArray(samples) ? samples : [];
  if (!Number.isFinite(fps) || (list.length > 0 && t - list.at(-1)[0] < SAMPLE_MS)) return list;
  return [...list, [t, Math.round(fps * 100) / 100, Number.isFinite(done) ? done : null]].slice(-SAMPLES_MAX);
}

/** a box's farm states, and the states each may move to from the dashboard (header: WHETHER A BOX TAKES WORK) */
export const NODE_STATES = ['accepting', 'draining', 'paused', 'removed'];
/** the dashboard's commands for a box (header: THE PULSE); pause/resume/drain set its farm state */
export const NODE_COMMANDS = ['sync-now', 'gpu-check-now', 'restart', 'pause', 'resume', 'drain'];
export const NODE_ACTIONS = { accepting: ['draining', 'paused', 'removed'], draining: ['accepting', 'paused', 'removed'], paused: ['accepting', 'removed'], removed: ['accepting'] };

/** a result file's path below its out folder: plain relative parts only (a worker may not write elsewhere) */
export function safeRel(p) {
  const parts = String(p ?? '').replace(/\\/g, '/').split('/').filter((x) => x !== '' && x !== '.');
  if (parts.length === 0 || parts.some((x) => x === '..' || /^[a-z]:$/i.test(x) || x.includes('\0'))) return null;
  return parts.join('/');
}

/** where a result file lands on the submitting machine: in the out folder, or beside the out file */
export function landingPath(out, rel) {
  return out.file ? (rel === basename(out.local) ? out.local : join(dirname(out.local), rel)) : join(out.local, rel);
}

/**
 * is `file` kept out of git: 'ignored', 'tracked' (committed or staged: the token is in the history already),
 * 'not-ignored' (the next `git add -A` takes it), or 'no-repo' (outside any repository: a test folder)
 */
export function gitIgnoreState(file) {
  const dir = dirname(file);
  if (spawnSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', windowsHide: true }).status !== 0) return 'no-repo';
  if (spawnSync('git', ['-C', dir, 'ls-files', '--error-unmatch', basename(file)], { encoding: 'utf8', windowsHide: true }).status === 0) return 'tracked';
  return spawnSync('git', ['-C', dir, 'check-ignore', '-q', basename(file)], { encoding: 'utf8', windowsHide: true }).status === 0 ? 'ignored' : 'not-ignored';
}

/**
 * the token of farm.json, written with a new random one when there is none — only where git ignores the file: this
 * repo is public, and a token in it opens the farm to anyone on the tailnet who reads GitHub (2026-10-29: the first
 * farm.json was written before /farm.json was in .gitignore). A tracked or unignored farm.json stops the farm.
 */
export function farmToken(file) {
  const git = gitIgnoreState(file);
  if (git === 'tracked') throw new Error(`${file} is tracked by git: the token is public. Take it out of git (git rm --cached ${basename(file)}), add /${basename(file)} to .gitignore, delete the file so a new token is made, and update the boxes`);
  if (git === 'not-ignored') throw new Error(`${file} is not ignored by git, and this repo is public: add /${basename(file)} to .gitignore first (git check-ignore ${basename(file)} must name it)`);
  if (existsSync(file)) {
    const t = JSON.parse(readFileSync(file, 'utf8')).token;
    if (typeof t !== 'string' || t.length < 16) throw new Error(`${file}: "token" must be a string of 16+ characters`);
    return { token: t, created: false };
  }
  const token = randomBytes(24).toString('base64url');
  writeFileSync(file, `${JSON.stringify({ token, about: 'The Drift farm: the token render machines send (their drift-node.json "farm": { "token": … }). Gitignored; never commit it.' }, null, 1)}\n`, { mode: 0o600 });
  return { token, created: true };
}

const tokenOk = (header, token) => {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};

// ------------------------------------------------------------------------------------------------- the hub
/**
 * the hub: { handle(req, res, url) → true when it answered (a /farm/ path), view() → the dashboard's Farm, sweep() }.
 * `allow(ip)`: may this address use the farm (loopback, tailnet); `hints`: () → drift-farm-nodes.json's nodes.
 */
export function createFarmHub({ dir, token, allow = () => true, hints = () => [], bundleDir = null, repo = null, assetsRoot = repo, now = Date.now, log = () => {} }) {
  const jobsDir = join(dir, 'jobs');
  mkdirSync(jobsDir, { recursive: true });
  const jobs = new Map();
  for (const id of readdirSync(jobsDir)) {
    try {
      jobs.set(id, JSON.parse(readFileSync(join(jobsDir, id, 'job.json'), 'utf8')));
    } catch {
      // a job folder without its job.json: half-made, ignored
    }
  }
  // THE CHUNKED RENDERS (header: POST /farm/runs), across restarts
  const runsDir = join(dir, 'runs');
  mkdirSync(runsDir, { recursive: true });
  const runs = new Map();
  for (const f of readdirSync(runsDir).filter((x) => x.endsWith('.json'))) {
    try {
      const r = JSON.parse(readFileSync(join(runsDir, f), 'utf8'));
      runs.set(r.id, r);
    } catch {
      // (half-written: ignored)
    }
  }
  const speedsFile = join(dir, 'speeds.json');
  let speeds = (() => {
    try {
      return JSON.parse(readFileSync(speedsFile, 'utf8'));
    } catch {
      return { nodes: {}, dur1: {} };
    }
  })();
  /** workers by node: { node, at, state: waiting | busy | busy-foreign, why, speed, job } */
  const workers = new Map();
  /** open claims by node: { res, timer } */
  const claims = new Map();
  const hintOf = (node) => hints().find((n) => n.name === node)?.speed ?? 1;
  // THE BOXES' FARM STATES (header), across restarts
  const statesFile = join(dir, 'nodes-state.json');
  let nodeStates = (() => {
    try {
      return JSON.parse(readFileSync(statesFile, 'utf8'));
    } catch {
      return {};
    }
  })();
  const farmStateOf = (node) => (NODE_STATES.includes(nodeStates[node]?.state) ? nodeStates[node].state : 'accepting');
  const farmLog = (line) => writeFileSync(join(dir, 'farm.log'), `${new Date(now()).toISOString()}  ${line}\n`, { flag: 'a' });
  // THE PULSE (header): commands waiting per box, claims held for boxes that take no work, origin's head, the bundle
  const commands = new Map();
  const holds = new Map();
  let head = null;
  const pollHead = () => {
    if (!repo) return;
    execFile('git', ['-C', repo, 'ls-remote', 'origin', 'refs/heads/main'], { timeout: 15_000, windowsHide: true }, (e, out) => {
      const m = /^([0-9a-f]{40})\s/.exec(String(out ?? ''));
      if (!e && m) head = m[1];
    });
  };
  pollHead();
  const headTimer = setInterval(pollHead, 30_000);
  headTimer.unref?.();
  let bundleCache = { at: 0, id: null };
  const bundleId = () => {
    if (now() - bundleCache.at < 5000) return bundleCache.id;
    let id = null;
    try {
      const ptr = JSON.parse(readFileSync(join(bundleDir ?? '', 'latest-assets.json'), 'utf8'));
      id = ptr.manifest?.content ?? ptr.content ?? null;
    } catch {
      id = null;
    }
    bundleCache = { at: now(), id };
    return id;
  };
  // THE NEWEST FILES, ONE BY ONE (header: GET /farm/bundle/manifest, /file): the manifest re-read when its file
  // changes (a --manifest-only run on this Mac), its paths the only files served
  let manCache = { mtimeMs: -1, man: null, byPath: null, content: null };
  const currentManifest = () => {
    const f = join(bundleDir ?? '', 'manifest-assets.json');
    let st;
    try {
      st = statSync(f);
    } catch {
      return null;
    }
    if (st.mtimeMs !== manCache.mtimeMs) {
      try {
        const man = JSON.parse(readFileSync(f, 'utf8'));
        if (!Array.isArray(man.files)) return null;
        manCache = { mtimeMs: st.mtimeMs, man, byPath: new Map(man.files.map((x) => [x.path, x])), content: contentId(man.files) };
      } catch {
        return null; // (half-written: drift-bundle.mjs writes it with a rename, so only a hand edit gets here)
      }
    }
    return manCache;
  };
  /** what every claim answer says (header: THE PULSE); `withCommand`: hand over the next waiting command */
  const replyHeaders = (node, withCommand = true) => {
    const q = commands.get(node) ?? [];
    const c = withCommand ? q.shift() : null;
    if (q.length === 0) commands.delete(node);
    const b = bundleId();
    return { 'x-drift-farm-state': farmStateOf(node), ...(c ? { 'x-drift-farm-command': c.cmd } : {}), ...(head ? { 'x-drift-farm-head': head } : {}), ...(b ? { 'x-drift-farm-bundle': b } : {}) };
  };
  /** a box's open claim answered now (a command or a state change waits for it) */
  const wake = (node) => {
    const h = claims.get(node) ?? holds.get(node);
    if (!h) return;
    clearTimeout(h.timer);
    claims.delete(node);
    holds.delete(node);
    h.res.writeHead(204, replyHeaders(node)).end();
  };
  const speedNow = (node) => speedOf(node, speeds, hintOf(node));

  const save = (job) => {
    jobs.set(job.id, job);
    const d = join(jobsDir, job.id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'job.json.part'), JSON.stringify(job, null, 1));
    renameSync(join(d, 'job.json.part'), join(d, 'job.json'));
  };
  const appendLog = (job, lines) => {
    if (!lines?.length) return;
    writeFileSync(join(jobsDir, job.id, 'log.txt'), `${lines.join('\n')}\n`, { flag: 'a' });
  };
  const logLines = (job) => {
    try {
      return readFileSync(join(jobsDir, job.id, 'log.txt'), 'utf8').split('\n').slice(0, -1);
    } catch {
      return [];
    }
  };

  /** hand queued jobs to the workers in a claim right now (FIFO, by pickWorker) */
  const dispatch = () => {
    // (header of PRIORITIES: the highest first, the oldest first within it)
    const queued = queueOrder([...jobs.values()].filter((j) => j.state === 'queued'));
    for (const job of queued) {
      // (a box a higher queued job could use is not offered to this one: that job waits for it, not behind a chunk)
      const still = queued.filter((q) => jobs.get(q.id)?.state === 'queued');
      const waiting = [...claims.keys()].filter((node) => !yieldsTo(job, node, still)).map((node) => ({ node, speed: speedNow(node) }));
      if (waiting.length === 0) continue;
      const node = pickWorker(job, waiting, now());
      if (!node) continue;
      const c = claims.get(node);
      claims.delete(node);
      clearTimeout(c.timer);
      const taken = transition(job, 'preparing', { node, claimedAt: now(), heardAt: now() });
      save(taken);
      workers.set(node, { ...(workers.get(node) ?? {}), node, at: now(), state: 'busy', job: job.id });
      log(`farm: ${job.id} (${job.label}) → ${node}`);
      c.res.writeHead(200, { 'content-type': 'application/json', ...replyHeaders(node, false) }).end(JSON.stringify(taken));
    }
  };

  /**
   * a worker that went quiet: its job back to the queue (or failed after two tries). Counted from this hub's start at
   * the earliest: a dashboard that was down for minutes does not take a job from a box that was rendering all along
   * (its worker holds on and reports again, drift-farm-client.mjs holdOn)
   */
  const bootAt = now();
  const sweep = () => {
    for (const job of jobs.values()) {
      if (!['preparing', 'running'].includes(job.state) || now() - Math.max(job.heardAt ?? 0, bootAt) < LEASE_MS) continue;
      // (a job someone cancelled is not given back to the queue when its box goes quiet: it is over)
      if (job.cancelRequested) {
        save(transition(job, 'cancelled', { endedAt: now(), last: `${job.node} went quiet after the cancel` }));
        continue;
      }
      const tries = (job.attempts ?? 0) + 1;
      save(tries >= 2
        ? transition(job, 'failed', { error: `${job.node} stopped answering (twice)`, endedAt: now(), attempts: tries })
        : transition(job, 'queued', { node: null, queuedAt: now(), attempts: tries, last: `${job.node} stopped answering: queued again` }));
    }
    dispatch();
  };
  const timer = setInterval(sweep, 10_000);
  timer.unref?.();

  const json = (res, code, body) => res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(body === undefined ? '' : JSON.stringify(body));
  const readJson = (req, max = 1 << 20) =>
    new Promise((ok, bad) => {
      let s = '';
      req.on('data', (c) => {
        s += c;
        if (s.length > max) {
          bad(new Error('too large'));
          req.destroy();
        }
      });
      req.on('end', () => {
        try {
          ok(JSON.parse(s || '{}'));
        } catch (e) {
          bad(e);
        }
      });
      req.on('error', bad);
    });

  /**
   * the chunked renders of the last 24 h, newest first (header: POST /farm/runs): each chunk with the state of its
   * newest job — 'here' (it was on this Mac already), queued, preparing, running (with progress), done, failed,
   * cancelled — or 'waiting' (no job yet); and the counts
   */
  const runsView = (t) => {
    const byRun = new Map();
    for (const j of jobs.values()) {
      if (!j.run || !runs.has(j.run.id)) continue;
      const k = `${j.run.id}:${j.run.i}`;
      const prev = byRun.get(k);
      if (!prev || j.createdAt > prev.createdAt) byRun.set(k, j);
    }
    return [...runs.values()]
      .filter((r) => t - r.createdAt < 86_400_000)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => {
        const chunks = r.chunks.map((c, i) => {
          const j = byRun.get(`${r.id}:${i}`);
          return { from: c.from, to: c.to, state: c.here ? 'here' : j?.state ?? 'waiting', job: j?.id ?? null, node: j?.node ?? null, progress: j && !FINAL.has(j.state) ? j.progress ?? null : null, previewAt: j?.previewAt ?? null };
        });
        const count = (st) => chunks.filter((c) => st.includes(c.state)).length;
        return {
          id: r.id, kind: r.kind, label: r.label, from: r.from, to: r.to, size: r.size, priority: r.priority, submitter: r.submitter, createdAt: r.createdAt, chunks,
          done: count(['here', 'done']), running: count(['preparing', 'running']), failed: count(['failed', 'cancelled']), total: chunks.length,
          active: chunks.some((c) => !['here', 'done', 'failed', 'cancelled'].includes(c.state)),
        };
      });
  };

  /** the dashboard's Farm (drift-dash.mjs's typedef) */
  const view = () => {
    const t = now();
    const list = [...jobs.values()].filter((j) => !FINAL.has(j.state) || t - (j.endedAt ?? j.createdAt) < 86_400_000).sort((a, b) => b.createdAt - a.createdAt);
    const queuedNow = [...jobs.values()].filter((j) => j.state === 'queued');
    const best = Math.max(1, ...[...workers.values()].filter((w) => t - w.at < FREE_MS).map((w) => speedNow(w.node)));
    const workerView = hints().map((n) => {
      const w = workers.get(n.name);
      const state = !w || t - w.at > (w.state === 'busy' ? LEASE_MS : FREE_MS) ? 'offline' : w.state;
      return { node: n.name, state, farmState: farmStateOf(n.name), seen: w?.at ?? 0, speed: speedNow(n.name), job: w?.job ?? null, why: w?.why ?? null };
    });
    return {
      enabled: true,
      jobs: list.map((j) => ({
        id: j.id, label: j.label, kind: j.kind, state: j.state, node: j.node ?? null, prefer: j.prefer ?? null, createdAt: j.createdAt, startedAt: j.startedAt ?? null, endedAt: j.endedAt ?? null,
        exitCode: j.exitCode ?? null, base: j.base, progress: j.progress ?? { done: null, total: null, unit: null, fps: null, etaS: null },
        estS: j.state === 'queued' && speeds.dur1?.[j.cls] ? Math.round(speeds.dur1[j.cls] / best) : null, last: j.last ?? null,
        results: (j.results ?? []).map((r) => ({ path: landingPath(j.outs[r.out], r.path), bytes: r.bytes })), error: j.error ?? null,
        why: j.state === 'queued' ? holdReason(j, workerView, t, queuedNow) : null, requeuedFrom: j.requeuedFrom ?? null, requeuedAs: j.requeuedAs ?? null,
        priority: j.priority ?? 'normal',
        cancelRequested: j.cancelRequested === true && !FINAL.has(j.state),
        timing: j.timing ?? null,
        previewAt: j.previewAt ?? null, run: j.run ?? null,
        // (the console's queue manager: who sent it, its command for the settings, its times, its fps over time while
        // it runs — a finished job's samples stay in its job.json, not in every 3 s answer)
        submitter: j.submitter ?? null, argv: j.argv ?? [], cls: j.cls ?? null, queuedAt: j.queuedAt ?? null, claimedAt: j.claimedAt ?? null,
        attempts: j.attempts ?? 0, samples: FINAL.has(j.state) ? [] : j.samples ?? [],
        // (where its files land on the submitting machine: the console groups a whole render's chunks by them)
        outs: (j.outs ?? []).map((o) => o.local),
      })),
      workers: workerView,
      runs: runsView(t),
      nodes: Object.fromEntries(hints().map((n) => [n.name, { state: farmStateOf(n.name), at: nodeStates[n.name]?.at ?? null, by: nodeStates[n.name]?.by ?? null, actions: NODE_ACTIONS[farmStateOf(n.name)] }])),
    };
  };

  /**
   * run `job` again as a new job (the same code state, inputs and outs, its payload linked): a finished one on the
   * user's word, a running one taken off its box (which is told to stop: cancel on its next status). → the new job
   */
  const requeue = (job, why, extra = {}) => {
    const id = `${new Date(now()).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}-${randomBytes(3).toString('hex')}`;
    const keep = ['label', 'argv', 'kind', 'cls', 'prefer', 'weight', 'priority', 'base', 'bundle', 'outs', 'inputs', 'submitter', 'payloadBytes', 'run', 'retries'];
    const fresh = { id, state: 'queued', ...Object.fromEntries(keep.map((k) => [k, job[k]])), createdAt: now(), queuedAt: now(), attempts: 0, results: [], requeuedFrom: job.id, ...extra };
    mkdirSync(join(jobsDir, id), { recursive: true });
    try {
      linkSync(join(jobsDir, job.id, 'payload.tgz'), join(jobsDir, id, 'payload.tgz'));
    } catch {
      copyFileSync(join(jobsDir, job.id, 'payload.tgz'), join(jobsDir, id, 'payload.tgz'));
    }
    save(fresh);
    save({ ...jobs.get(job.id), requeuedAs: id, ...(FINAL.has(job.state) ? {} : { cancelRequested: true }) });
    farmLog(`job ${job.id} (${job.label}) requeued as ${id}: ${why}`);
    return fresh;
  };

  /** a box's farm state set (the dashboard's control); paused/removed: its job goes back to the queue */
  const setFarmState = (node, to, by) => {
    const from = farmStateOf(node);
    if (!NODE_STATES.includes(to)) throw new Error(`state ${to}: ${NODE_STATES.join(' | ')}`);
    if (to !== from && !NODE_ACTIONS[from].includes(to)) throw new Error(`${node}: ${from} → ${to} is not a move (${NODE_ACTIONS[from].join(', ')})`);
    nodeStates = { ...nodeStates, [node]: { state: to, at: now(), by } };
    writeFileSync(`${statesFile}.part`, JSON.stringify(nodeStates, null, 1));
    renameSync(`${statesFile}.part`, statesFile);
    farmLog(`${node}: ${from} → ${to} (by ${by})`);
    if (to === 'paused' || to === 'removed') for (const j of [...jobs.values()]) if (j.node === node && ['preparing', 'running'].includes(j.state)) requeue(j, `${node} ${to}`);
    wake(node);
    dispatch();
    return { node, state: to, from, actions: NODE_ACTIONS[to] };
  };

  const deny = (res, code, why) => json(res, code, { error: why });
  /** the farm node whose tailnet address this is (drift-farm-nodes.json "tailnetIp"), or null */
  const nodeAt = (ip) => hints().find((n) => n.tailnetIp && n.tailnetIp === String(ip ?? '').replace(/^::ffff:/, ''))?.name ?? null;
  /** a worker's own routes: what a box needs to take, run and return a job, and to sync its bundle */
  const workerRoute = (p, method) =>
    (p[1] === 'claim' && method === 'GET') || (p[1] === 'bundle' && method === 'GET') ||
    (p[1] === 'jobs' && p[2] && ((p[3] === 'payload' && method === 'GET') || (p[3] === 'status' && method === 'POST') || (p[3] === 'files' && method === 'PUT') || (p[3] === 'preview' && method === 'PUT')));

  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/farm/')) return false;
    if (!allow(req.socket.remoteAddress)) return deny(res, 403, 'loopback and tailnet only'), true;
    const p = url.pathname.split('/').filter(Boolean); // ['farm', 'jobs', id, …]
    // THE CONTROLS (header): this Mac's dashboard page only — loopback, JSON, its own Origin — and no token needed
    if (req.method === 'POST' && ((p[1] === 'nodes' && (p[3] === 'state' || p[3] === 'command')) || (p[1] === 'jobs' && (p[3] === 'cancel' || p[3] === 'requeue')))) {
      const ip = String(req.socket.remoteAddress ?? '');
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return deny(res, 403, 'farm controls only from this Mac\'s dashboard (loopback), never over the tailnet'), true;
      const origin = req.headers.origin;
      if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return deny(res, 403, `farm controls only from the dashboard page, not ${origin}`), true;
      if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) return deny(res, 415, 'farm controls take JSON (content-type: application/json)'), true;
      const by = `${ip}${origin ? ` ${origin}` : ''}${req.headers['user-agent'] ? ` ${String(req.headers['user-agent']).slice(0, 40)}` : ''}`;
      try {
        const b = await readJson(req);
        if (p[1] === 'nodes') {
          if (!hints().some((n) => n.name === p[2])) return deny(res, 404, `${p[2]}: not in drift-farm-nodes.json`), true;
          if (p[3] === 'state') return json(res, 200, setFarmState(p[2], b.state, by)), true;
          const cmd = String(b.cmd ?? b.command ?? '');
          if (!NODE_COMMANDS.includes(cmd)) return deny(res, 400, `command ${cmd}: ${NODE_COMMANDS.join(' | ')}`), true;
          if (cmd === 'pause' || cmd === 'resume' || cmd === 'drain') return json(res, 200, setFarmState(p[2], { pause: 'paused', resume: 'accepting', drain: 'draining' }[cmd], by)), true;
          commands.set(p[2], [...(commands.get(p[2]) ?? []).filter((c) => c.cmd !== cmd), { cmd, at: now(), by }]);
          farmLog(`${p[2]}: command ${cmd} (by ${by})`);
          const waiting = claims.has(p[2]) || holds.has(p[2]);
          wake(p[2]);
          return json(res, 200, { node: p[2], cmd, delivered: waiting ? 'now (its claim was open)' : 'with its next claim' }), true;
        }
        const job = jobs.get(p[2]);
        if (!job) return deny(res, 404, `no farm job ${p[2]}`), true;
        if (p[3] === 'requeue') {
          if (['uploading', 'queued'].includes(job.state)) return json(res, 200, job), true;
          const fresh = requeue(job, `by ${by}`);
          dispatch();
          return json(res, 200, fresh), true;
        }
        if (FINAL.has(job.state)) return json(res, 200, job), true;
        const next = ['uploading', 'queued'].includes(job.state) ? transition(job, 'cancelled', { endedAt: now() }) : { ...job, cancelRequested: true };
        save(next);
        farmLog(`job ${job.id} (${job.label}) cancelled (by ${by})`);
        return json(res, 200, next), true;
      } catch (e) {
        return deny(res, 400, String(e.message)), true;
      }
    }
    // THE LIVE PREVIEW (header): no token — the dashboard page has none; `allow` (loopback, the tailnet) stands
    if (req.method === 'GET' && p[1] === 'jobs' && p[3] === 'preview.jpg' && p.length === 4) {
      const job = jobs.get(p[2]);
      const f = job ? join(jobsDir, job.id, 'preview.jpg') : null;
      if (!f || !existsSync(f)) return deny(res, 404, 'no preview (yet)'), true;
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': statSync(f).size, 'cache-control': 'no-cache' });
      await pipeline(createReadStream(f), res);
      return true;
    }
    const byToken = tokenOk(req.headers.authorization, token);
    const byAddress = !byToken && workerRoute(p, req.method) ? nodeAt(req.socket.remoteAddress) : null;
    if (!byToken && !byAddress) return deny(res, 401, 'no or wrong farm token (farm.json / drift-node.json "farm"), and not a farm box\'s own tailnet address'), true;
    // a box known by its address works only as itself: its claims, and the jobs it holds
    if (byAddress && p[1] === 'claim' && url.searchParams.get('node') !== byAddress) return deny(res, 403, `this address is ${byAddress}'s`), true;
    if (byAddress && p[1] === 'jobs' && jobs.get(p[2])?.node !== byAddress) return deny(res, 403, `job ${p[2]} is not ${byAddress}'s`), true;
    try {
      if (p[1] === 'workers' && req.method === 'GET') return json(res, 200, view().workers), true;
      if (p[1] === 'bundle' && req.method === 'GET' && (p[2] === 'manifest' || p[2] === 'file')) {
        const cur = currentManifest();
        if (!cur) return deny(res, 404, 'no manifest-assets.json in the hub\'s bundle folder (node scripts/drift-bundle.mjs --manifest-only on the Mac writes it)'), true;
        if (p[2] === 'manifest') {
          const body = Buffer.from(JSON.stringify(cur.man));
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length, 'x-drift-farm-bundle': cur.content, 'cache-control': 'no-store' });
          res.end(body);
          return true;
        }
        // only a path the manifest lists, and only inside this checkout (a manifest is ours, but a path is checked anyway)
        const rel = url.searchParams.get('path') ?? '';
        const entry = cur.byPath.get(rel);
        if (!entry || safeRel(rel) !== rel || !assetsRoot) return deny(res, 404, `${rel}: not a file of the bundle's manifest (only those are served)`), true;
        const abs = resolve(assetsRoot, rel);
        if (!abs.startsWith(resolve(assetsRoot) + sep)) return deny(res, 404, `${rel}: outside the checkout`), true;
        let st;
        try {
          st = statSync(abs);
        } catch {
          return deny(res, 410, `${rel}: in the manifest but gone from this Mac: node scripts/drift-bundle.mjs --manifest-only`), true;
        }
        // (changed since the manifest was written: the box would fetch bytes that are not the manifest's, and say so
        // when their sha256 is checked; a size that differs is caught here, before any byte moves)
        if (st.size !== entry.bytes) return deny(res, 409, `${rel}: ${st.size} bytes here, ${entry.bytes} in the manifest — changed since: node scripts/drift-bundle.mjs --manifest-only`), true;
        const range = req.headers.range;
        let start = 0;
        let end = st.size - 1;
        if (range) {
          const m = /^bytes=(\d+)-(\d*)$/.exec(range);
          if (!m || Number(m[1]) >= st.size) return res.writeHead(416, { 'content-range': `bytes */${st.size}` }).end(), true;
          start = Number(m[1]);
          if (m[2]) end = Math.min(Number(m[2]), st.size - 1);
          if (end < start) return res.writeHead(416, { 'content-range': `bytes */${st.size}` }).end(), true;
        }
        res.writeHead(range ? 206 : 200, {
          'content-type': 'application/octet-stream', 'content-length': Math.max(0, end - start + 1), 'accept-ranges': 'bytes',
          'x-sha256': entry.sha256, 'x-bytes': String(entry.bytes), 'cache-control': 'no-store',
          ...(range ? { 'content-range': `bytes ${start}-${end}/${st.size}` } : {}),
        });
        if (st.size === 0) return res.end(), true;
        await pipeline(createReadStream(abs, { start, end }), res);
        return true;
      }
      if (p[1] === 'bundle' && req.method === 'GET') {
        const name = p[2] ?? '';
        const f = bundleDir && /^(latest-assets\.json|drift-assets-\d{8}\.tar\.gz)$/.test(name) ? join(bundleDir, name) : null;
        if (!f || !existsSync(f)) return deny(res, 404, `no ${name} in the hub's bundle folder (node scripts/drift-bundle.mjs on the Mac builds it)`), true;
        res.writeHead(200, { 'content-type': name.endsWith('.json') ? 'application/json' : 'application/gzip', 'content-length': statSync(f).size, 'cache-control': 'no-store' });
        await pipeline(createReadStream(f), res);
        return true;
      }
      if (p[1] === 'claim' && req.method === 'GET') {
        const node = url.searchParams.get('node');
        if (!node || !hints().some((n) => n.name === node)) return deny(res, 400, `node ${node}: not in drift-farm-nodes.json`), true;
        // SOMEONE ELSE ON ITS GPU (&busy=<who>): answered at once with the pulse, and never a claim — a job handed to
        // it was lost (its worker reads only the headers then), went quiet for a lease and was given back, twice:
        // linux-monster with ComfyUI on its card, 2026-10-30, "linux-monster stopped answering (twice)"
        const busy = url.searchParams.get('busy');
        if (busy !== null) {
          if (claims.get(node)) {
            claims.get(node).res.writeHead(204, replyHeaders(node, false)).end();
            clearTimeout(claims.get(node).timer);
            claims.delete(node);
          }
          workers.set(node, { ...(workers.get(node) ?? {}), node, at: now(), state: 'busy-foreign', why: busy.slice(0, 120), job: null });
          return res.writeHead(204, replyHeaders(node)).end(), true;
        }
        // not accepting (header): never in `claims`, so dispatch never sees it. Removed: answered at once (its worker
        // waits minutes); paused, draining: held like a claim (it asks again in 25 s); the state in the header
        const fs = farmStateOf(node);
        if (fs !== 'accepting') {
          workers.set(node, { ...(workers.get(node) ?? {}), node, at: now(), state: 'waiting', job: null });
          if (fs === 'removed' || commands.has(node)) return res.writeHead(204, replyHeaders(node)).end(), true;
          holds.get(node)?.res.writeHead(204, replyHeaders(node, false)).end();
          clearTimeout(holds.get(node)?.timer);
          const t = setTimeout(() => {
            if (holds.get(node)?.res === res) holds.delete(node);
            res.writeHead(204, replyHeaders(node)).end();
          }, CLAIM_HOLD_MS);
          holds.set(node, { res, timer: t });
          req.on('close', () => {
            if (holds.get(node)?.res === res) {
              holds.delete(node);
              clearTimeout(t);
            }
          });
          return true;
        }
        claims.get(node)?.res.writeHead(204, replyHeaders(node, false)).end();
        clearTimeout(claims.get(node)?.timer);
        // a command waiting: answered at once (the worker acts on it, then claims again)
        if (commands.has(node)) {
          claims.delete(node);
          workers.set(node, { node, at: now(), state: 'waiting', job: null });
          return res.writeHead(204, replyHeaders(node)).end(), true;
        }
        workers.set(node, { node, at: now(), state: 'waiting', job: null });
        const t = setTimeout(() => {
          if (claims.get(node)?.res === res) claims.delete(node);
          res.writeHead(204, replyHeaders(node)).end();
        }, CLAIM_HOLD_MS);
        claims.set(node, { res, timer: t });
        req.on('close', () => {
          if (claims.get(node)?.res === res) {
            claims.delete(node);
            clearTimeout(t);
          }
        });
        dispatch();
        return true;
      }
      if (p[1] === 'runs' && req.method === 'POST' && byToken) {
        const b = await readJson(req);
        if (!/^[\w.-]{4,80}$/.test(String(b.id ?? '')) || !Array.isArray(b.chunks)) return deny(res, 400, 'a run: { id, kind, from, to, chunks: [{ from, to, here }] }'), true;
        const run = { id: b.id, kind: b.kind === 'flat' ? 'flat' : 'dome', label: String(b.label ?? '').slice(0, 160), from: Number(b.from), to: Number(b.to), size: b.size ?? null, priority: b.priority ?? 'normal', submitter: b.submitter ?? null, createdAt: now(), chunks: b.chunks.slice(0, 2000).map((c) => ({ from: Number(c.from), to: Number(c.to), here: c.here === true })) };
        runs.set(run.id, run);
        writeFileSync(join(runsDir, `${run.id}.json`), JSON.stringify(run));
        return json(res, 201, { id: run.id }), true;
      }
      if (p[1] !== 'jobs') return deny(res, 404, 'no such farm route'), true;
      if (p.length === 2 && req.method === 'POST') {
        const b = await readJson(req);
        if (!Array.isArray(b.argv) || b.argv.length === 0 || !b.argv.every((a) => typeof a === 'string')) return deny(res, 400, 'argv: a list of strings'), true;
        if (typeof b.base !== 'string' || !/^[0-9a-f]{7,40}$/.test(b.base)) return deny(res, 400, 'base: the commit (on origin) the code is based on'), true;
        if (b.prefer && !hints().some((n) => n.name === b.prefer)) return deny(res, 400, `prefer ${b.prefer}: not in drift-farm-nodes.json`), true;
        if (b.prefer && farmStateOf(b.prefer) !== 'accepting') return deny(res, 400, `${b.prefer} is ${farmStateOf(b.prefer)} in the farm (the dashboard): it takes no jobs`), true;
        const id = `${new Date(now()).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}-${randomBytes(3).toString('hex')}`;
        const job = {
          id, state: 'uploading', label: String(b.label ?? b.argv.join(' ')).slice(0, 160), argv: b.argv, kind: ['still', 'clip', 'long'].includes(b.kind) ? b.kind : jobKind(b.argv),
          cls: jobClass(b.argv), prefer: b.prefer ?? null, weight: Math.max(1, Number(b.weight) || 1), priority: PRIORITIES.includes(b.priority) ? b.priority : 'normal', base: b.base, bundle: b.bundle ?? null, run: b.run && typeof b.run === 'object' ? { id: String(b.run.id), i: Number(b.run.i) } : null,
          outs: Array.isArray(b.outs) ? b.outs : [], inputs: Array.isArray(b.inputs) ? b.inputs : [], submitter: b.submitter ?? null, createdAt: now(), attempts: 0, results: [],
        };
        save(job);
        return json(res, 201, { id }), true;
      }
      const job = jobs.get(p[2]);
      if (!job) return deny(res, 404, `no farm job ${p[2]}`), true;
      const d = join(jobsDir, job.id);
      if (p[3] === 'preview' && req.method === 'PUT') {
        // (a 640 px JPEG; more is not a preview)
        const n = Number(req.headers['content-length'] ?? 0);
        if (n > 2 * 2 ** 20) return deny(res, 413, 'a preview is a small JPEG (2 MB at most)'), true;
        await pipeline(req, createWriteStream(join(d, 'preview.jpg.part')));
        renameSync(join(d, 'preview.jpg.part'), join(d, 'preview.jpg'));
        save({ ...jobs.get(job.id), previewAt: now() });
        return json(res, 204), true;
      }
      if (p[3] === 'payload' && req.method === 'PUT') {
        if (job.state !== 'uploading') return deny(res, 409, `job ${job.id} is ${job.state}`), true;
        await pipeline(req, createWriteStream(join(d, 'payload.tgz.part')));
        renameSync(join(d, 'payload.tgz.part'), join(d, 'payload.tgz'));
        save(transition(job, 'queued', { queuedAt: now(), payloadBytes: statSync(join(d, 'payload.tgz')).size }));
        dispatch();
        return json(res, 204), true;
      }
      if (p[3] === 'payload' && req.method === 'GET') {
        if (!existsSync(join(d, 'payload.tgz'))) return deny(res, 404, 'no payload'), true;
        res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': statSync(join(d, 'payload.tgz')).size });
        await pipeline(createReadStream(join(d, 'payload.tgz')), res);
        return true;
      }
      if (p[3] === 'status' && req.method === 'POST') {
        const b = await readJson(req);
        let j = { ...job, heardAt: now() };
        if (Array.isArray(b.lines)) {
          // numbered (`from`: the worker's count of lines before these): a batch sent again after a lost answer adds
          // only what this hub does not have; a gap (lines the worker dropped while the hub was away) is noted
          let lines = b.lines.map(String);
          if (Number.isInteger(b.from) && b.from >= 0) {
            const have = j.linesIn ?? 0;
            if (b.from < have) lines = lines.slice(have - b.from);
            else if (b.from > have) lines = [`(farm: ${b.from - have} line(s) lost while the hub was away)`, ...lines];
            j.linesIn = Math.max(have, b.from + b.lines.length);
          }
          appendLog(j, lines);
          if (lines.length) j.last = String(lines.at(-1)).slice(0, 300);
        }
        if (b.progress && typeof b.progress === 'object') j.progress = b.progress;
        // THE ROUND TRIP, measured on the box (durations, not its clock: the boxes' clocks are not this Mac's):
        // payloadMs, bundleMs, treeMs, bootMs (start to first frame), renderMs, uploadMs, cache (warm | cold)
        if (b.timing && typeof b.timing === 'object') j.timing = { ...(j.timing ?? {}), ...b.timing };
        if (Number.isFinite(b.progress?.fps)) j.samples = fpsSamples(j.samples, now(), b.progress.fps, b.progress.done);
        if (b.state && b.state !== j.state && !FINAL.has(j.state)) {
          const patch = b.state === 'running' ? { startedAt: now() } : FINAL.has(b.state) ? { endedAt: now(), exitCode: b.exitCode ?? null, error: b.error ?? null } : {};
          j = transition(j, b.state, patch);
          if (b.state === 'done' || b.state === 'failed') {
            workers.set(j.node, { node: j.node, at: now(), state: 'waiting', job: null });
            // RESULTS THAT ARE NOT PICTURES (drift-sanity.mjs, `retry`): the job again, on another box when one takes
            // work in the next AVOID_MS — twice at most
            if (b.state === 'failed' && b.retry === true && (j.retries ?? 0) < 2 && !j.prefer) {
              save(j);
              requeue(j, `${j.error} (on ${j.node})`, { retries: (j.retries ?? 0) + 1, avoid: [...(j.avoid ?? []), j.node], avoidUntil: now() + AVOID_MS });
              j = jobs.get(j.id); // (with its requeuedAs: saved again below)
              dispatch();
            }
            const durS = (j.endedAt - (j.startedAt ?? j.endedAt)) / 1000;
            if (b.state === 'done') {
              speeds = learn(speeds, { node: j.node, cls: j.cls, fps: Number(b.fps), durS, speed: speedNow(j.node) });
              writeFileSync(speedsFile, JSON.stringify(speeds, null, 1));
            }
          }
        } else if (j.node && !FINAL.has(j.state)) workers.set(j.node, { ...(workers.get(j.node) ?? {}), node: j.node, at: now(), state: 'busy', job: j.id });
        save(j);
        return json(res, 200, { cancel: j.cancelRequested === true, state: farmStateOf(j.node) }), true;
      }
      if (p[3] === 'files' && req.method === 'PUT') {
        const out = Number(url.searchParams.get('out'));
        const rel = safeRel(url.searchParams.get('path'));
        if (!Number.isInteger(out) || !job.outs[out] || rel === null) return deny(res, 400, 'out: an index of the job\'s outs; path: a plain relative path'), true;
        const dst = join(d, 'results', String(out), ...rel.split('/'));
        mkdirSync(dirname(dst), { recursive: true });
        await pipeline(req, createWriteStream(`${dst}.part`));
        renameSync(`${dst}.part`, dst);
        const results = [...(job.results ?? []).filter((r) => !(r.out === out && r.path === rel)), { out, path: rel, bytes: statSync(dst).size }];
        save({ ...jobs.get(job.id), results, heardAt: now() });
        return json(res, 204), true;
      }
      if (p[3] === 'files' && req.method === 'GET') {
        const out = Number(p[4]);
        const rel = safeRel(p.slice(5).map(decodeURIComponent).join('/'));
        const f = rel === null ? null : join(d, 'results', String(out), ...rel.split('/'));
        if (!f || !existsSync(f)) return deny(res, 404, 'no such result file'), true;
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': statSync(f).size });
        await pipeline(createReadStream(f), res);
        return true;
      }
      if (p.length === 3 && req.method === 'GET') {
        const from = Math.max(0, Number(url.searchParams.get('from')) || 0);
        const lines = logLines(job);
        return json(res, 200, { ...job, log: lines.slice(from), logFrom: from, logTo: lines.length, results: (job.results ?? []).map((r) => ({ ...r, landing: landingPath(job.outs[r.out], r.path) })) }), true;
      }
      return deny(res, 404, 'no such farm route'), true;
    } catch (e) {
      if (!res.headersSent) deny(res, String(e.message).includes('is not a move') ? 409 : 400, String(e.message));
      return true;
    }
  }

  return {
    handle,
    view,
    sweep,
    close: () => {
      clearInterval(timer);
      clearInterval(headTimer);
    },
    jobs: () => [...jobs.values()],
  };
}

// ----------------------------------------------------------------------------------------------- the CLI
// (header: THE PULSE) — on this Mac, through the dashboard's loopback controls
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [what, box, arg] = process.argv.slice(2);
  const base = process.env.DRIFT_DASH_URL ?? 'http://127.0.0.1:5190';
  const send = async (path, body) => {
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const t = await r.text();
    console.log(r.ok ? t : `${r.status}: ${t}`);
    process.exit(r.ok ? 0 : 1);
  };
  if (what === 'kick' && box && arg) await send(`/farm/nodes/${encodeURIComponent(box)}/command`, { cmd: arg });
  else if (what === 'state' && box && arg) await send(`/farm/nodes/${encodeURIComponent(box)}/state`, { state: arg });
  // do the machines draw the same film? (scripts/drift-consistency.mjs; it reads its own flags)
  else if (what === 'consistency') await import('./drift-consistency.mjs');
  // a whole render in chunks over the farm's free boxes, joined here (scripts/drift-farm-render.mjs)
  else if (what === 'render') await import('./drift-farm-render.mjs');
  // CANCEL BY WHO OR WHAT: every unfinished job of an agent (its submitter's name: DRIFT_AGENT, or "claude <session>"),
  // every unfinished low-priority job, or jobs by id — through the same loopback control as the dashboard's button
  else if (what === 'cancel') {
    const rest = process.argv.slice(3);
    const at = (k) => (rest.includes(k) ? rest[rest.indexOf(k) + 1] : null);
    const agent = at('--agent');
    const allLow = rest.includes('--all-low');
    const ids = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--agent');
    if (!agent && !allLow && ids.length === 0) {
      console.error('usage: node scripts/drift-farm.mjs cancel --agent <name> | --all-low | <job id> …');
      process.exit(2);
    }
    const st = await (await fetch(`${base}/api`)).json();
    const open = (st.farm?.jobs ?? []).filter((j) => !FINAL.has(j.state));
    const pick = open.filter((j) => ids.includes(j.id) || (agent && j.submitter?.agent === agent) || (allLow && j.priority === 'low'));
    for (const j of pick) {
      const r = await fetch(`${base}/farm/jobs/${j.id}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      console.log(`${j.id} ${j.state}${j.node ? ` on ${j.node}` : ''} (${j.submitter?.agent ?? '?'}, ${j.priority ?? 'normal'}): ${r.ok ? 'cancel sent' : `${r.status} ${await r.text()}`}`);
    }
    console.log(`${pick.length} of ${open.length} unfinished job(s) cancelled`);
    process.exit(0);
  }
  else {
    console.error(`usage: node scripts/drift-farm.mjs kick <box> ${NODE_COMMANDS.join('|')}\n       node scripts/drift-farm.mjs state <box> ${NODE_STATES.join('|')}\n       node scripts/drift-farm.mjs consistency [--boxes a,b] [--width 960] [--shots file] [--no-mac]\n       node scripts/drift-farm.mjs render --from 0 --to 770 [--chunk 20] [--size 2048] [--priority low] [--out dir] [-- drift-render flags]\n       node scripts/drift-farm.mjs cancel --agent <name> | --all-low | <job id> …`);
    process.exit(2);
  }
}
