/**
 * THE DRIFT'S SUBMITTER ON THE STUDIO FARM'S SDK: what `drift-slot.mjs --farm` and the full-show render
 * (`node farm/cli.mjs render`) send to the farm. The SDK comes from the sibling studio-farm checkout
 * (farm/package.mjs), loaded when a function here is called. The hub is this Mac's drift-dash (DRIFT_FARM_HUB, default
 * http://localhost:5190), the token the Mac's submitter client's (DRIFT_FARM_TOKEN_FILE, default farm-mac.token:
 * gitignored, made by `farm token add drift-mac`; the studio-farm package's docs say how).
 *
 *   farmSubmit({ root, argv, prefer, priority, … })   a drift-slot command: a TYPED job when typedJobOf can say it
 *                                                    exactly (review clip, review stills, a render chunk), else a
 *                                                    legacy-argv@1 job (legacySubmit) while the boxes still take them
 *   farmRender({ root, from, to, … })                 a whole render in chunks: one code state for all, one group,
 *                                                    one typed job per chunk at low priority, the chunks landed and
 *                                                    joined (concatJoin, its frame count checked)
 *
 * TYPED FIRST (the user, 2026-11-02: "let's clean up then"): a typed job is checked by the hub against its type
 * (every param on its allowlist, no free command), and its outputs land where the command said. A command the types
 * cannot say exactly (an unknown script, a flag no type declares: drift-stills.mjs, --port, --shot-file) goes as
 * legacy-argv@1, the free command line the boxes still run while their configs say `allowLegacy` — never a flag
 * silently dropped. DRIFT_FARM_TYPED=0 sends everything as legacy-argv, the way back.
 *
 * The code state is the Drift's (PACK: the git diff against origin/main, untracked files under src scripts tests
 * public, the assets the boxes' set lacks up to 200 MB), checked to build first (drift-precheck.mjs). A typed job and
 * a legacy one carry the same payload (the package's packGitDiff), so one pack serves either.
 *
 * A DASHBOARD RESTART LOSES NOTHING: the SDK holds on through it (its follow asks again, its uploads and downloads are
 * retried, a job the console requeued is followed as its new job). Ctrl-C (SIGINT, SIGTERM) cancels the job; again
 * ends at once.
 */
import { spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { ASSET_SET, PACK, assetOverlay, remapArgv, typedJobOf } from './drift.adapter.mjs';
import { fromPackage } from './package.mjs';

const imp = (root, f) => import(pathToFileURL(join(root, 'scripts', f)).href);
const FINAL = new Set(['done', 'failed', 'cancelled']);
const git = (root, args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 30, windowsHide: true });

/** the hub and the token file (header) */
export const hubOf = (env = process.env) => env.DRIFT_FARM_HUB ?? 'http://localhost:5190';
export const tokenFileOf = (root, env = process.env) => env.DRIFT_FARM_TOKEN_FILE ?? join(root, 'farm-mac.token');
/** typed jobs unless DRIFT_FARM_TYPED=0 (header) */
export const typedOn = (env = process.env) => env.DRIFT_FARM_TYPED !== '0';

/** a command in a few words for the console's queue: paths as their names, at most `max` characters */
export function labelOf(argv, max = 160) {
  const s = argv.map((a) => (/[\\/]/.test(a) && !a.startsWith('--') ? basename(a) : a)).join(' ');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * the Drift's code state for a farm job (header), packed in `stage` → { payload, meta }. `inputs`: a legacy job's
 * uploaded files ([{ i, local, name }]); a typed job sends its inputs apart
 */
export async function packDrift({ root, stage, clean = false, base = 'origin/main', inputs = [], say = () => {} }) {
  const [{ packGitDiff }, { contentId }, { sameBytes }] = await Promise.all([fromPackage('src/sdk.mjs'), fromPackage('src/artifacts.mjs'), fromPackage('src/codestate.mjs')]);
  const manifestFile = join(root, ASSET_SET.worker.installedManifest);
  const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : null;
  return packGitDiff({
    root, stage, base, clean, ...PACK, inputs, say,
    meta: { bundle: manifest ? contentId(manifest.files) : null },
    precheck: async (r) => {
      const { precheck, precheckMessage } = await imp(r, 'drift-precheck.mjs');
      const pc = await precheck(r);
      return { ok: pc.ok, message: pc.ok ? '' : precheckMessage(pc) };
    },
    // the assets the boxes' set lacks: what a bundle would hold now (drift-bundle.mjs --list-json) against the last
    // one; a file only touched (its time newer, its bytes the same) stays home
    extra: async () => {
      const list = join(stage, 'assets-now.json');
      mkdirSync(stage, { recursive: true });
      const r = spawnSync(process.execPath, [join(root, 'scripts/drift-bundle.mjs'), '--list-json', list], { cwd: root, encoding: 'utf8', windowsHide: true });
      if (r.status !== 0) throw new Error(`drift-bundle --list-json failed: ${r.stderr}`);
      const out = [];
      for (const f of assetOverlay(JSON.parse(readFileSync(list, 'utf8')), manifest)) {
        if (f.why === 'touched' && (await sameBytes(join(root, f.path), f.sha256))) continue;
        out.push({ path: f.path, bytes: f.bytes, why: f.why });
      }
      return out;
    },
  });
}

/**
 * can the farm take a job at all: the hub answers and some box that takes work is online → null, else why not (the
 * caller of `--farm auto` runs it here instead). Busy boxes are a queue, not a reason to come back here (2026-10-30,
 * 01:49: a job sent back to this Mac after 60 s, while the boxes' claims had gone silent, failed here)
 */
export async function farmDown(farm) {
  const workers = await farm.call('/v1/workers', { timeoutMs: 3000 }).then((r) => r.workers).catch((e) => ({ error: e.message }));
  if (!Array.isArray(workers)) return `the farm hub does not answer (${workers.error})`;
  if (!workers.some((w) => w.state !== 'offline' && (w.farmState ?? 'accepting') === 'accepting')) return `no farm box is online and taking work (${workers.map((w) => `${w.node} ${w.state}${w.farmState && w.farmState !== 'accepting' ? `/${w.farmState}` : ''}`).join(', ')})`;
  return null;
}

/** Ctrl-C cancels `cancel()`'s job; a second one ends at once. → the handler's remover */
function onSignals(cancel, say) {
  let asked = false;
  const h = () => {
    if (asked) process.exit(130);
    asked = true;
    say('farm: cancelling (again: at once)');
    void cancel().catch(() => {});
  };
  process.on('SIGINT', h);
  process.on('SIGTERM', h);
  return () => (process.off('SIGINT', h), process.off('SIGTERM', h));
}

/**
 * a drift-slot command on the farm (header: TYPED FIRST). `prefer`: a box's name, 'any' (whichever box, however long
 * it waits), or 'auto' (whichever box; { fallback } when the farm cannot take it at all — never for a low job, which
 * waits for the farm). `weight`: a legacy job's slots (a typed job's are its type's). → { code, job } or { fallback }
 */
export async function farmSubmit({ root, hub = hubOf(), tokenFile = tokenFileOf(root), argv, prefer = 'auto', weight = 1, priority = 'normal', stage, typed = typedOn(), signals = true, say = console.error, out = (s) => process.stdout.write(s), cwd = process.cwd() }) {
  const { createClient, landingHint, roundTrip, submitterOf } = await fromPackage('src/sdk.mjs');
  const farm = createClient({ hub, tokenFile });
  if (prefer === 'auto' && priority === 'low') prefer = 'any';
  if (prefer === 'auto') {
    const why = await farmDown(farm);
    if (why) return { fallback: why };
  }
  const t = typed ? typedJobOf(argv, { cwd }) : null;
  if (!t) return legacySubmit({ root, farm, argv, prefer, weight, priority, stage, signals, say, out, cwd, why: typed ? 'the types cannot say this command exactly' : 'DRIFT_FARM_TYPED=0' });
  const t0 = Date.now();
  try {
    const { payload } = await packDrift({ root, stage, say });
    const box = prefer && prefer !== 'auto' && prefer !== 'any' ? prefer : null;
    const sub = await farm.submit({ ...t.spec, label: labelOf(argv), priority, ...(box ? { prefer: box } : {}), submitter: submitterOf(), landing: landingHint(t.land) }, { inputs: t.inputs, code: payload, say });
    let id = sub.id;
    say(`farm: job ${id} (${t.spec.type}) queued${box ? ` for ${box}` : ''}${priority !== 'normal' ? ` at ${priority} priority` : ''}; following it here (Ctrl-C cancels it)`);
    const off = signals ? onSignals(() => farm.cancel(id), say) : () => {};
    const t1 = Date.now();
    const landed = new Map();
    const land = async (j) => {
      for (const dst of await farm.land(j, t.land, { landed })) {
        const of = j.progress?.unit === 'stills' && j.progress.total ? j.progress.total : FINAL.has(j.state) ? j.results.length : '?';
        const rel = relative(cwd, dst);
        say(`farm: got ${rel && !rel.startsWith('..') ? rel : dst} (${landed.size}/${of})`);
      }
    };
    let job;
    try {
      job = await farm.follow(id, {
        say, onState: (j) => (id = j.id), onResults: land,
        onLog: (lines, j) => out(lines.map((l) => `[farm ${j.node ?? '?'}] ${l}\n`).join('')),
      });
      await land(job);
    } finally {
      off();
    }
    say(roundTrip(job, { submitAt: t0, followAt: t1, landedAt: Date.now() }));
    say(`farm: job ${job.id} ${job.state} on ${job.node ?? '?'} (exit ${job.exitCode ?? '—'})${job.results?.length ? `, ${job.results.length} file(s) back` : ''}${job.error ? `: ${job.error}` : ''}`);
    return { code: job.state === 'done' ? job.exitCode ?? 0 : job.exitCode || 1, job };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** where a legacy result file lands here: in its out folder, or beside its out file */
const landingPath = (o, rel) => (o.file ? (rel === basename(o.local) ? o.local : join(dirname(o.local), rel)) : join(o.local, rel));

/**
 * A COMMAND THE TYPES CANNOT SAY, as a legacy-argv@1 job on the hub's /farm/jobs (the protocol the boxes ran before
 * types; the package's worker runs it while its config says allowLegacy). Its argv is remapped (remapArgv: files
 * outside the code uploaded, --out paths mapped to the job's folders), its payload is the same code state, and its
 * results land at the --out paths here. Goes away when the legacy door closes. `farm`: an SDK client; `packed`: a
 * { payload, meta } already made (one code state for many chunks; no inputs then); `run`: { id, i }, a chunk of a
 * full-show render. → { code, job }
 */
export async function legacySubmit({ root, farm, argv, prefer = 'any', weight = 1, priority = 'normal', stage, packed = null, run = null, clean = false, base = 'origin/main', signals = true, onQueued = () => {}, say = console.error, out = (s) => process.stdout.write(s), cwd = process.cwd(), why = null }) {
  const [{ holdOn }, { roundTrip, submitterOf }] = await Promise.all([fromPackage('src/util.mjs'), fromPackage('src/sdk.mjs')]);
  const t0 = Date.now();
  const lines = (s) => s.stdout.split('\0').filter(Boolean);
  const tracked = new Set(lines(git(root, ['ls-files', '-z'])));
  const untracked = new Set(lines(git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...PACK.include])));
  const manifestFile = join(root, ASSET_SET.worker.installedManifest);
  const bundled = new Set((existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')).files : []).map((f) => f.path));
  const remap = remapArgv(argv, { root, cwd, shipped: (rel) => tracked.has(rel) || untracked.has(rel) || bundled.has(rel) });
  if (packed && remap.inputs.length > 0) throw new Error('a packed code state carries no inputs: pass the job\'s files as repo paths');
  try {
    const { payload, meta } = packed ?? (await packDrift({ root, stage, inputs: remap.inputs, clean, base, say }));
    const box = prefer && prefer !== 'auto' && prefer !== 'any' ? prefer : null;
    let { id } = await farm.call('/farm/jobs', { method: 'POST', body: { label: labelOf(argv), argv: remap.argv, prefer: box, weight, priority, base: meta.base, bundle: meta.bundle, outs: remap.outs, inputs: remap.inputs.map((i) => ({ i: i.i, name: i.name })), submitter: submitterOf(), ...(run ? { run } : {}) } });
    await holdOn('upload the payload', () => farm.call(`/farm/jobs/${id}/payload`, { method: 'PUT', body: Readable.from(createReadStream(payload)), json: false, timeoutMs: 3_600_000 }), { say });
    say(`farm: job ${id} (legacy-argv@1${why ? `: ${why}` : ''}) queued${box ? ` for ${box}` : ''}${priority !== 'normal' ? ` at ${priority} priority` : ''}; following it here (Ctrl-C cancels it)`);
    onQueued(id);
    const off = signals ? onSignals(() => farm.call(`/farm/jobs/${id}/cancel`, { method: 'POST', body: {} }), say) : () => {};
    const t1 = Date.now();
    const landed = new Map();
    let job = null;
    let from = 0;
    let away = 0;
    const fresh = () => (job?.results ?? []).filter((r) => landed.get(`${r.out}/${r.path}`) !== r.bytes);
    const land = async (r) => {
      const dst = landingPath(job.outs[r.out], r.path);
      mkdirSync(dirname(dst), { recursive: true });
      await holdOn(`result ${r.path}`, async () => {
        const res = await farm.call(`/farm/jobs/${id}/files/${r.out}/${r.path.split('/').map(encodeURIComponent).join('/')}`, { raw: true, timeoutMs: 3_600_000 });
        if (!res.ok) throw Object.assign(new Error(`result ${r.path}: ${res.status}`), { status: res.status });
        await pipeline(Readable.fromWeb(res.body), createWriteStream(`${dst}.part`));
        renameSync(`${dst}.part`, dst);
      }, { say });
      landed.set(`${r.out}/${r.path}`, r.bytes);
      const of = job.progress?.unit === 'stills' && job.progress.total ? job.progress.total : FINAL.has(job.state) ? job.results.length : '?';
      const rel = relative(cwd, dst);
      say(`farm: got ${rel && !rel.startsWith('..') ? rel : dst} (${landed.size}/${of})`);
    };
    try {
      for (;;) {
        // (a dashboard restart: the last answer stands and the loop goes on; said once it has lasted 10 s)
        const next = await farm.call(`/farm/jobs/${id}?from=${from}`).catch((e) => (e.status >= 400 && e.status < 500 ? Promise.reject(e) : null));
        if (next === null) {
          if (away++ === 5) say('farm: the hub does not answer; still following (the dashboard restarting?)');
        } else {
          if (away > 5) say('farm: the hub is back');
          away = 0;
          job = next;
          if (job.log?.length) out(job.log.map((l) => `[farm ${job.node ?? '?'}] ${l}\n`).join(''));
          from = job.logTo ?? from;
        }
        // requeued from the dashboard (taken off its box, or run again): the new job is this one now
        if (job?.requeuedAs) {
          say(`farm: job ${id} was requeued as ${job.requeuedAs}; following that`);
          id = job.requeuedAs;
          from = 0;
          job = null;
          continue;
        }
        if (job && FINAL.has(job.state)) break;
        for (const r of fresh()) await land(r);
        await new Promise((r) => setTimeout(r, 2000));
      }
      for (const r of fresh()) await land(r);
    } finally {
      off();
    }
    say(roundTrip(job, { submitAt: t0, followAt: t1, landedAt: Date.now() }));
    say(`farm: job ${id} ${job.state} on ${job.node ?? '?'} (exit ${job.exitCode ?? '—'})${job.results?.length ? `, ${job.results.length} file(s) back` : ''}${job.error ? `: ${job.error}` : ''}`);
    return { code: job.state === 'done' ? job.exitCode ?? 0 : job.exitCode || 1, job };
  } finally {
    if (!packed) rmSync(stage, { recursive: true, force: true });
  }
}

const stamp = (t) => t.toFixed(3).padStart(8, '0');

/**
 * A WHOLE RENDER IN CHUNKS over the farm (the user, 2026-10-30: "I gave you all the computer in the world and
 * everything is idle"): the show cut on whole frames into `chunk` s pieces, each one job — drift-render@1, the dome
 * master at `size`², or with `flat` (a width in px) drift-review-clip@1, the 16:9 view of the focus zone through the
 * real pipeline at that width — handed to whichever boxes are free (or all to `box`), at `priority` (low: it fills
 * the gaps between the agents' review jobs). ONE code state for every chunk (`clean`: HEAD exactly, which must be on
 * origin; else the live tree, checked to build). Each chunk lands as <outDir>/chunks/chunk_<from>-<to>[_flat<w>].mp4;
 * one already there with its frame count is not rendered again, so the same call resumes. `extra`: more flags of the
 * chunk's script; a flag the type does not take makes every chunk a legacy-argv job (while the boxes take them).
 * The console shows each chunk under the render it belongs to (its group, and its landing path). Ctrl-C cancels every
 * chunk sent; the chunks already here stay. → { joined, missing, chunks }
 */
export async function farmRender({ root, hub = hubOf(), tokenFile = tokenFileOf(root), from, to, chunk = 20, size = 2048, flat = null, fps = 30, lanes = 1, extra = [], priority = 'low', box = null, outDir, stage, clean = false, typed = typedOn(), say = console.log }) {
  const { chunksOf, concatJoin, createClient, frameCountOf, landingHint, submitterOf } = await fromPackage('src/sdk.mjs');
  const farm = createClient({ hub, tokenFile });
  const kind = flat ? `_flat${flat}` : '';
  mkdirSync(join(outDir, 'chunks'), { recursive: true });
  const chunks = chunksOf(from, to, chunk, fps).map((c) => ({ ...c, file: join(outDir, 'chunks', `chunk_${stamp(c.from)}-${stamp(c.to)}${kind}.mp4`) }));
  const isHere = (c) => existsSync(c.file) && frameCountOf(c.file) === c.frames;
  const have = chunks.filter(isHere);
  const todo = chunks.filter((c) => !have.includes(c));
  const argvOf = (c) =>
    flat
      ? ['node', 'scripts/drift-review-clip.mjs', '--from', String(c.from), '--to', String(c.to), '--fps', String(fps), '--width', String(flat), '--channel', 'chrome', '--allow-long', '--allow-large', ...extra, '--out', c.file]
      : ['node', 'scripts/drift-render.mjs', '--size', String(size), '--fps', String(fps), '--from', String(c.from), '--to', String(c.to), '--channel', 'chrome', '--lanes', String(lanes), ...extra, '--out', c.file];
  // (typed or legacy is one decision for the whole render: every chunk has the same flags)
  const asTyped = typed && todo.every((c) => typedJobOf(argvOf(c), { cwd: root }));
  if (todo.length && !asTyped) say(`(legacy-argv@1 chunks: ${typed ? `the type does not take ${extra.join(' ') || 'these flags'}` : 'DRIFT_FARM_TYPED=0'})`);
  // THE RUN, for the console (its group: the chunks' states, those here already counted done)
  const runId = `${new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}-${flat ? 'flat' : 'dome'}-${process.pid}`;
  await farm.call('/farm/runs', { method: 'POST', timeoutMs: 10_000, body: { id: runId, kind: flat ? 'flat' : 'dome', label: `${flat ? `16:9 ${flat}` : `dome ${size}²`} [${from}, ${to}) s`, from, to, size: flat ?? size, priority, submitter: submitterOf(), chunks: chunks.map((c) => ({ from: c.from, to: c.to, here: have.includes(c) })) } })
    .catch((e) => say(`(the console's tracker will not show this run: ${e.message})`));
  const packed = todo.length ? await packDrift({ root, stage, clean, base: clean ? 'HEAD' : 'origin/main', say }) : null;
  // CTRL-C / SIGTERM CANCELS EVERY CHUNK it sent, and ends (the coordinator, 2026-10-30: a SIGINT to the full-show
  // preview cancelled nothing and left it running — every submit had its own handler, and the process waited on them)
  const sent = new Map(); // job id → typed?
  let stopping = false;
  const stop = async (sig) => {
    if (stopping) process.exit(130);
    stopping = true;
    say(`${sig}: cancelling ${sent.size} chunk job(s)`);
    await Promise.allSettled([...sent].map(([id, t]) => (t ? farm.cancel(id) : farm.call(`/farm/jobs/${id}/cancel`, { method: 'POST', body: {} }))));
    rmSync(stage, { recursive: true, force: true });
    say('cancelled; the chunks already here stay (the same command resumes)');
    process.exit(130);
  };
  const onSig = (s) => () => void stop(s);
  const sigs = [['SIGINT', onSig('SIGINT')], ['SIGTERM', onSig('SIGTERM')]];
  for (const [s, h] of sigs) process.on(s, h);
  let done = have.length;
  const t0 = Date.now();
  try {
    await Promise.all(todo.map(async (c) => {
      const tag = `${c.from}–${c.to} s`;
      const i = chunks.indexOf(c);
      const argv = argvOf(c);
      const quiet = (m) => {
        if (/queued|done on|failed on|cancelled|requeued|hub does not answer/.test(m)) say(`${tag}: ${m.replace(/^farm: /, '')}`);
      };
      let r;
      try {
        if (asTyped) {
          const t = typedJobOf(argv, { cwd: root });
          const spec = { ...t.spec, label: labelOf(argv), priority, ...(box ? { prefer: box } : {}), group: { id: runId, index: i }, submitter: submitterOf(), landing: landingHint(t.land) };
          const sub = await farm.submit(spec, { code: packed.payload, say: quiet });
          sent.set(sub.id, true);
          quiet(`job ${sub.id} queued${box ? ` for ${box}` : ''}`);
          const landed = new Map();
          const job = await farm.follow(sub.id, { say: quiet, onState: (j) => sent.set(j.id, true), onResults: (j) => farm.land(j, t.land, { landed }) });
          await farm.land(job, t.land, { landed });
          quiet(`${job.state} on ${job.node ?? '?'}`);
          r = { code: job.state === 'done' ? job.exitCode ?? 0 : job.exitCode || 1, error: job.error };
        } else {
          r = await legacySubmit({ root, farm, argv, prefer: box ?? 'any', weight: flat ? 1 : lanes, priority, stage, packed, run: { id: runId, i }, signals: false, onQueued: (id) => sent.set(id, false), say: quiet, out: () => {}, cwd: root });
        }
      } catch (e) {
        r = { code: 1, error: e.message };
      }
      const ok = r.code === 0 && isHere(c);
      if (ok) done++;
      say(`${tag}: ${ok ? 'back' : `NOT DONE (${r.error ?? `exit ${r.code}`}${existsSync(c.file) ? `, ${frameCountOf(c.file)} of ${c.frames} frames` : ''})`} — ${done}/${chunks.length} chunks, ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    }));
  } finally {
    for (const [s, h] of sigs) process.off(s, h);
    rmSync(stage, { recursive: true, force: true });
  }
  const missing = chunks.filter((c) => !isHere(c));
  if (missing.length) return { joined: null, missing, chunks };
  const F = chunks.reduce((a, c) => a + c.frames, 0);
  const joined = concatJoin(chunks.map((c) => c.file), join(outDir, `show_${from}-${to}${flat ? '_flat' : ''}.mp4`), F, { list: join(outDir, 'chunks', `concat${kind}.txt`), say });
  return { joined, missing: [], chunks };
}
