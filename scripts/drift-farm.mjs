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
 *   POST /farm/jobs/:id/cancel
 *   GET  /farm/workers                 who is free, busy or busy with someone else's work, and their speed
 *   GET  /farm/bundle/latest-assets.json, /farm/bundle/drift-assets-<date>.tar.gz
 *                                      THE ASSET BUNDLE over the same door (out/drift-bundle): the Windows boxes have no
 *                                      SSH, so a worker syncs its bundle from here (drift-node-lib.mjs, a "farm" source)
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
 * WHO GETS WHAT (pickWorker; the user: prefer the fastest free box for clips and long jobs, quick stills to whatever
 * is free): a still goes to any free box (the fastest of those asking); a clip or a long job waits for the fastest
 * box that is free — unless it has waited 2 min, then the fastest one asking takes it. `prefer` pins a box.
 * Speeds start from scripts/drift-farm-nodes.json ("speed": 4090 desktops 1.0, the 100 W 5090 laptop 0.5) and are
 * learned from what the boxes measure (frames per second per kind of job), out/drift/farm/speeds.json.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

/** ms a preparing or running job may go without a word from its worker before it is queued again */
export const LEASE_MS = 120_000;
/** ms a clip or long job waits for the fastest free box before a slower one may take it */
export const PATIENCE_MS = 120_000;
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
 * the worker that takes `job` now, or null (hold it). `waiting`: workers in a claim right now [{ node, speed }];
 * `free`: every worker free in the last FREE_MS (the waiting ones too).
 */
export function pickWorker(job, waiting, free, now, patienceMs = PATIENCE_MS) {
  let cands = job.prefer ? waiting.filter((w) => w.node === job.prefer) : [...waiting];
  if (cands.length === 0) return null;
  cands = cands.sort((a, b) => b.speed - a.speed);
  if (job.kind === 'still' || job.prefer) return cands[0].node;
  const fastestFree = Math.max(cands[0].speed, ...free.map((f) => f.speed));
  if (cands[0].speed >= fastestFree) return cands[0].node;
  return now - (job.queuedAt ?? job.createdAt) > patienceMs ? cands[0].node : null;
}

/**
 * why a queued job has no box yet, in words for the dashboard (FarmJob.why). `workers`: view()'s, each { node, state:
 * waiting | busy | busy-foreign | offline, why (busy-foreign: who, "ComfyUI 18 GB"), speed }
 */
export function holdReason(job, workers, now, patienceMs = PATIENCE_MS) {
  const word = (w) => (w.state === 'busy-foreign' ? `${w.node} busy (${w.why ?? 'someone else on the GPU'})` : w.state === 'busy' ? `${w.node} busy with another job` : w.state === 'offline' ? `${w.node} offline` : `${w.node} free`);
  const pool = job.prefer ? workers.filter((w) => w.node === job.prefer) : workers;
  if (pool.length === 0) return `${job.prefer} is not a farm box`;
  const up = pool.filter((w) => w.state !== 'offline');
  if (up.length === 0) return job.prefer ? `${job.prefer} offline (no worker running there)` : 'no worker online';
  const free = up.filter((w) => w.state === 'waiting').sort((a, b) => b.speed - a.speed);
  if (free.length === 0) return pool.map(word).join(', ');
  if (job.kind !== 'still' && !job.prefer) {
    const fastest = Math.max(...up.map((w) => w.speed));
    if (free[0].speed < fastest) {
      const left = Math.max(0, Math.round((patienceMs - (now - (job.queuedAt ?? job.createdAt))) / 1000));
      return `waiting for a faster box (${up.filter((w) => w.speed === fastest).map(word).join(', ')}); ${free[0].node} takes it in ${left} s`;
    }
  }
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
export function createFarmHub({ dir, token, allow = () => true, hints = () => [], bundleDir = null, now = Date.now, log = () => {} }) {
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
    const queued = [...jobs.values()].filter((j) => j.state === 'queued').sort((a, b) => a.queuedAt - b.queuedAt);
    for (const job of queued) {
      const waiting = [...claims.keys()].map((node) => ({ node, speed: speedNow(node) }));
      if (waiting.length === 0) return;
      const free = [...workers.values()].filter((w) => w.state === 'waiting' && now() - w.at < FREE_MS).map((w) => ({ node: w.node, speed: speedNow(w.node) }));
      const node = pickWorker(job, waiting, free, now());
      if (!node) continue;
      const c = claims.get(node);
      claims.delete(node);
      clearTimeout(c.timer);
      const taken = transition(job, 'preparing', { node, claimedAt: now(), heardAt: now() });
      save(taken);
      workers.set(node, { ...(workers.get(node) ?? {}), node, at: now(), state: 'busy', job: job.id });
      log(`farm: ${job.id} (${job.label}) → ${node}`);
      c.res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(taken));
    }
  };

  /** a worker that went quiet: its job back to the queue (or failed after two tries) */
  const sweep = () => {
    for (const job of jobs.values()) {
      if (!['preparing', 'running'].includes(job.state) || now() - (job.heardAt ?? 0) < LEASE_MS) continue;
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

  /** the dashboard's Farm (drift-dash.mjs's typedef) */
  const view = () => {
    const t = now();
    const list = [...jobs.values()].filter((j) => !FINAL.has(j.state) || t - (j.endedAt ?? j.createdAt) < 86_400_000).sort((a, b) => b.createdAt - a.createdAt);
    const best = Math.max(1, ...[...workers.values()].filter((w) => t - w.at < FREE_MS).map((w) => speedNow(w.node)));
    const workerView = hints().map((n) => {
      const w = workers.get(n.name);
      const state = !w || t - w.at > (w.state === 'busy' ? LEASE_MS : FREE_MS) ? 'offline' : w.state;
      return { node: n.name, state, seen: w?.at ?? 0, speed: speedNow(n.name), job: w?.job ?? null, why: w?.why ?? null };
    });
    return {
      enabled: true,
      jobs: list.map((j) => ({
        id: j.id, label: j.label, kind: j.kind, state: j.state, node: j.node ?? null, prefer: j.prefer ?? null, createdAt: j.createdAt, startedAt: j.startedAt ?? null, endedAt: j.endedAt ?? null,
        exitCode: j.exitCode ?? null, base: j.base, progress: j.progress ?? { done: null, total: null, unit: null, fps: null, etaS: null },
        estS: j.state === 'queued' && speeds.dur1?.[j.cls] ? Math.round(speeds.dur1[j.cls] / best) : null, last: j.last ?? null,
        results: (j.results ?? []).map((r) => ({ path: landingPath(j.outs[r.out], r.path), bytes: r.bytes })), error: j.error ?? null,
        why: j.state === 'queued' ? holdReason(j, workerView, t) : null,
      })),
      workers: workerView,
    };
  };

  const deny = (res, code, why) => json(res, code, { error: why });
  /** the farm node whose tailnet address this is (drift-farm-nodes.json "tailnetIp"), or null */
  const nodeAt = (ip) => hints().find((n) => n.tailnetIp && n.tailnetIp === String(ip ?? '').replace(/^::ffff:/, ''))?.name ?? null;
  /** a worker's own routes: what a box needs to take, run and return a job, and to sync its bundle */
  const workerRoute = (p, method) =>
    (p[1] === 'claim' && method === 'GET') || (p[1] === 'bundle' && method === 'GET') ||
    (p[1] === 'jobs' && p[2] && ((p[3] === 'payload' && method === 'GET') || (p[3] === 'status' && method === 'POST') || (p[3] === 'files' && method === 'PUT')));

  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/farm/')) return false;
    if (!allow(req.socket.remoteAddress)) return deny(res, 403, 'loopback and tailnet only'), true;
    const p = url.pathname.split('/').filter(Boolean); // ['farm', 'jobs', id, …]
    const byToken = tokenOk(req.headers.authorization, token);
    const byAddress = !byToken && workerRoute(p, req.method) ? nodeAt(req.socket.remoteAddress) : null;
    if (!byToken && !byAddress) return deny(res, 401, 'no or wrong farm token (farm.json / drift-node.json "farm"), and not a farm box\'s own tailnet address'), true;
    // a box known by its address works only as itself: its claims, and the jobs it holds
    if (byAddress && p[1] === 'claim' && url.searchParams.get('node') !== byAddress) return deny(res, 403, `this address is ${byAddress}'s`), true;
    if (byAddress && p[1] === 'jobs' && jobs.get(p[2])?.node !== byAddress) return deny(res, 403, `job ${p[2]} is not ${byAddress}'s`), true;
    try {
      if (p[1] === 'workers' && req.method === 'GET') return json(res, 200, view().workers), true;
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
        const busy = url.searchParams.get('busy');
        if (busy) {
          workers.set(node, { node, at: now(), state: 'busy-foreign', why: busy, job: null });
          return json(res, 204), true;
        }
        claims.get(node)?.res.writeHead(204).end();
        clearTimeout(claims.get(node)?.timer);
        workers.set(node, { node, at: now(), state: 'waiting', job: null });
        const t = setTimeout(() => {
          if (claims.get(node)?.res === res) claims.delete(node);
          res.writeHead(204).end();
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
      if (p[1] !== 'jobs') return deny(res, 404, 'no such farm route'), true;
      if (p.length === 2 && req.method === 'POST') {
        const b = await readJson(req);
        if (!Array.isArray(b.argv) || b.argv.length === 0 || !b.argv.every((a) => typeof a === 'string')) return deny(res, 400, 'argv: a list of strings'), true;
        if (typeof b.base !== 'string' || !/^[0-9a-f]{7,40}$/.test(b.base)) return deny(res, 400, 'base: the commit (on origin) the code is based on'), true;
        if (b.prefer && !hints().some((n) => n.name === b.prefer)) return deny(res, 400, `prefer ${b.prefer}: not in drift-farm-nodes.json`), true;
        const id = `${new Date(now()).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}-${randomBytes(3).toString('hex')}`;
        const job = {
          id, state: 'uploading', label: String(b.label ?? b.argv.join(' ')).slice(0, 160), argv: b.argv, kind: ['still', 'clip', 'long'].includes(b.kind) ? b.kind : jobKind(b.argv),
          cls: jobClass(b.argv), prefer: b.prefer ?? null, weight: Math.max(1, Number(b.weight) || 1), base: b.base, bundle: b.bundle ?? null,
          outs: Array.isArray(b.outs) ? b.outs : [], inputs: Array.isArray(b.inputs) ? b.inputs : [], submitter: b.submitter ?? null, createdAt: now(), attempts: 0, results: [],
        };
        save(job);
        return json(res, 201, { id }), true;
      }
      const job = jobs.get(p[2]);
      if (!job) return deny(res, 404, `no farm job ${p[2]}`), true;
      const d = join(jobsDir, job.id);
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
          appendLog(j, b.lines.map(String));
          j.last = String(b.lines.at(-1) ?? j.last ?? '').slice(0, 300);
        }
        if (b.progress && typeof b.progress === 'object') j.progress = b.progress;
        if (b.state && b.state !== j.state && !FINAL.has(j.state)) {
          const patch = b.state === 'running' ? { startedAt: now() } : FINAL.has(b.state) ? { endedAt: now(), exitCode: b.exitCode ?? null, error: b.error ?? null } : {};
          j = transition(j, b.state, patch);
          if (b.state === 'done' || b.state === 'failed') {
            workers.set(j.node, { node: j.node, at: now(), state: 'waiting', job: null });
            const durS = (j.endedAt - (j.startedAt ?? j.endedAt)) / 1000;
            if (b.state === 'done') {
              speeds = learn(speeds, { node: j.node, cls: j.cls, fps: Number(b.fps), durS, speed: speedNow(j.node) });
              writeFileSync(speedsFile, JSON.stringify(speeds, null, 1));
            }
          }
        } else if (j.node) workers.set(j.node, { ...(workers.get(j.node) ?? {}), node: j.node, at: now(), state: 'busy', job: j.id });
        save(j);
        return json(res, 200, { cancel: j.cancelRequested === true }), true;
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
      if (p[3] === 'cancel' && req.method === 'POST') {
        if (FINAL.has(job.state)) return json(res, 200, job), true;
        const next = ['uploading', 'queued'].includes(job.state) ? transition(job, 'cancelled', { endedAt: now() }) : { ...job, cancelRequested: true };
        save(next);
        return json(res, 200, next), true;
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

  return { handle, view, sweep, close: () => clearInterval(timer), jobs: () => [...jobs.values()] };
}
