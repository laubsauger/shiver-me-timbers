#!/usr/bin/env node
/**
 * FAST OFFLINE RENDER of The Drift's dome master (docs/cine/drift-render.md).
 *
 * The master is a pure function of act time (src/drift/record.ts), so frames are independent and the act splits
 * into N contiguous ranges rendered at once: N headless Chromium pages on the real GPU, each a `lane` of
 * drift.html?record posting raw RGBA to its OWN sink (scripts/cine-sink.mjs, one encoder each), joined at the end
 * with `ffmpeg -f concat -c copy` — every clip starts on a keyframe, so nothing is re-encoded. One serial tab left
 * the GPU and the CPU mostly idle (~5 fps at 1024²); the lanes fill both.
 *
 *   node scripts/drift-render.mjs --size 1024 --fps 30 [--from 0] [--to <s>] [--lanes 2] [--allow-lanes]
 *        [--out out/drift/<name>.mp4] [--codec x264|prores] [--port 5288]
 *        [--crf 18] [--preset medium] [--inflight 3] [--queue 8] [--keep] [--blur 1] [--shutter 0.5]
 *
 *   --lanes    parallel pages, at most 2 unless --allow-lanes (see MACHINE GUARDS)
 *
 *   --blur     motion-blur sub-frames per frame (1 = none; 8 for masters), averaged in linear HDR
 *   --shutter  fraction of the frame interval the shutter is open (0.5 = 180°)
 *
 *   --to       default: the show's end, asked of the page (__drift.total)
 *   --codec    x264 → .mp4 (libx264, ~cores/N threads per lane) · prores → .mov (ProRes 422 HQ on VideoToolbox)
 *   --port     the Vite dev server of THIS render. Started here on its own port with no file watcher and no HMR,
 *              so an edit saved mid-render (or anyone's HMR) cannot reload a lane and restart its range; an
 *              existing server on that port is reused only if it serves this repo's drift.html
 *   --keep     keep the lane clips (out/drift/.lanes-<name>/) after the join
 *
 * EXACT RANGES: frame n of the act is t = from + n/fps. Lane k renders n ∈ [n0, n1) with n0 = ⌊kF/N⌋, passed as
 * from = from + n0/fps, to = from + n1/fps; the page's own count round((to − from)·fps) is checked to be n1 − n0
 * before anything launches, and every clip's and the joined file's frame count is checked after — a mismatch fails
 * the render instead of shipping a dropped or doubled frame at a seam.
 *
 * HEADLESS ON THE REAL GPU (shaderloom playwright.config.ts, chromium-gpu): `channel: 'chromium'` is the full
 * Chromium in the NEW headless mode — Metal adapter, unthrottled, no window. No GPU flags: `--enable-unsafe-webgpu`
 * adds a SwiftShader fallback adapter.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer as createVite } from 'vite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const num = (name, fallback) => {
  const v = Number(arg(name, String(fallback)));
  if (!Number.isFinite(v)) throw new Error(`--${name} must be a number`);
  return v;
};

const SIZE = num('size', 2048);
const FPS = num('fps', 30);
const FROM = num('from', 0);
const TO_ARG = arg('to', null);
const LANES = Math.max(1, Math.floor(num('lanes', 2)));
const CODEC = arg('codec', 'x264');
const PORT = num('port', 5288);
const CRF = arg('crf', '18');
const PRESET = arg('preset', 'medium');
const INFLIGHT = Math.max(1, Math.floor(num('inflight', 3)));
const QUEUE = Math.max(0, Math.floor(num('queue', 8)));
const KEEP = argv.includes('--keep');
const BLUR = Math.max(1, Math.floor(num('blur', 1)));
const SHUTTER = num('shutter', 0.5);
/** no lane progress for this long = a hung lane (the first frame includes boot and shader compile) */
const STALL_MS = 180_000;

// ------------------------------------------------------------------------------------------- MACHINE GUARDS
// A render shares the machine with whoever is working on it. Four lanes of Chromium plus ProRes once filled a
// 32 GB machine's RAM and its disk to the last 200 MB and crashed it (2026-10-26). So: at most 2 lanes unless
// asked for explicitly with --allow-lanes, one render at a time (a lock file), a disk check before the first
// frame, and partial files removed when a render fails.
const MAX_LANES = argv.includes('--allow-lanes') ? 8 : 2;
if (LANES > MAX_LANES) throw new Error(`--lanes ${LANES}: more than ${MAX_LANES} needs --allow-lanes (each lane is a full Chromium on the GPU; ${(totalmem() / 2 ** 30).toFixed(0)} GB RAM here)`);
/** bytes per pixel per frame on disk, generous: ProRes 422 HQ measured 0.54 at 1024² (mostly black); x264 is far smaller */
const BYTES_PER_PX = { x264: 0.15, prores: 0.8 };
/** never leave less than this free */
const DISK_RESERVE = 20 * 2 ** 30;
const LOCK = resolve(ROOT, 'out/drift/.render.lock');
let laneDir = null;
const releaseLock = () => {
  try {
    if (existsSync(LOCK) && readFileSync(LOCK, 'utf8').trim() === String(process.pid)) rmSync(LOCK);
  } catch {
    /* best effort */
  }
};
function takeLock() {
  mkdirSync(dirname(LOCK), { recursive: true });
  if (existsSync(LOCK)) {
    const pid = Number(readFileSync(LOCK, 'utf8').trim());
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive) throw new Error(`another render is running (pid ${pid}, ${LOCK}) — one at a time`);
  }
  writeFileSync(LOCK, String(process.pid));
}
function checkDisk(dir, frames) {
  const st = statfsSync(dir);
  const free = st.bavail * st.bsize;
  // lane clips and the joined file both exist for a moment: twice the estimate
  const need = 2 * frames * SIZE * SIZE * BYTES_PER_PX[CODEC] + DISK_RESERVE;
  const gb = (b) => (b / 2 ** 30).toFixed(1);
  if (free < need) throw new Error(`not enough disk: ${gb(free)} GB free, this render needs ~${gb(need - DISK_RESERVE)} GB plus a ${gb(DISK_RESERVE)} GB reserve`);
  return { free, need };
}
if (CODEC !== 'x264' && CODEC !== 'prores') throw new Error(`--codec ${CODEC}: x264 | prores`);
const EXT = CODEC === 'prores' ? 'mov' : 'mp4';

const t0 = Date.now();
const secs = (a, b = Date.now()) => (b - a) / 1000;
const log = (...a) => console.log('[render]', ...a);

/** run a command to completion, collecting stdout; rejects loud on a non-zero exit */
const run = (cmd, args) =>
  new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', rej);
    p.on('close', (code) => (code === 0 ? res(out) : rej(new Error(`${cmd} ${args.join(' ')} exited ${code}\n${err}`))));
  });

/** frames in a clip, from the container's sample table (no decode) */
const frameCountOf = async (file) => {
  const out = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=nb_frames', '-of', 'csv=p=0', file]);
  return Number(out.trim());
};

// ---------------------------------------------------------------------------------------------- teardown, always
const browsers = [];
const sinks = [];
let vite = null;
let tearingDown = null;
const teardown = () =>
  (tearingDown ??= (async () => {
    await Promise.allSettled(browsers.map((b) => b.close()));
    // SIGTERM: a sink finalises any clip still open as _FAILED (it never got its /endshot)
    await Promise.allSettled(
      sinks.map((s) => (s.exitCode !== null ? Promise.resolve() : new Promise((r) => (s.once('exit', r), s.kill('SIGTERM'))))),
    );
    await vite?.close();
    releaseLock();
  })());
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.error(`\n[render] ${sig} — stopping lanes`);
    void teardown().then(() => process.exit(130));
  });
}

async function main() {
  takeLock();
  // -------------------------------------------------------------------------------------------- the dev server
  let base = `http://localhost:${PORT}`;
  const ours = await fetch(`${base}/drift.html`)
    .then((r) => r.text())
    .then((html) => html.includes('/src/main-drift.ts'))
    .catch(() => false);
  if (ours) {
    log(`reusing the dev server on ${base} (it must not hot-reload while this runs)`);
  } else {
    vite = await createVite({
      root: ROOT,
      clearScreen: false,
      logLevel: 'warn',
      // its own dep cache: re-optimising must never rewrite the one a developer's server on 5173 is serving from
      cacheDir: join(ROOT, 'node_modules/.vite-drift-render'),
      server: { port: PORT, strictPort: true, hmr: false, watch: null },
    });
    await vite.listen();
    base = (vite.resolvedUrls?.local?.[0] ?? `${base}/`).replace(/\/$/, '');
    log(`dev server ${base} (no watcher, no HMR)`);
  }

  // ------------------------------------------------- probe: boots the page once (warms Vite) and asks for the act end
  const launch = () => chromium.launch({ channel: 'chromium', headless: true });
  const probeBrowser = await launch();
  browsers.push(probeBrowser);
  const probe = await probeBrowser.newPage({ viewport: { width: 256, height: 256 } });
  const probeErrors = [];
  probe.on('pageerror', (e) => probeErrors.push(String(e)));
  await probe.goto(`${base}/drift.html?paused`);
  for (const until = Date.now() + 120_000; ; ) {
    if (probeErrors.length > 0) throw new Error(`drift.html failed to boot: ${probeErrors.join('\n')}`);
    if (await probe.evaluate(() => '__drift' in window || document.body.innerText.includes('requires WebGPU'))) break;
    if (Date.now() > until) throw new Error('drift.html did not boot in 120 s');
    await new Promise((r) => setTimeout(r, 100));
  }
  const probed = await probe.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter();
    const info = adapter?.info;
    if (!('__drift' in window)) return { error: 'no WebGPU in this browser (the page showed its gate)' };
    // the show's end (every act on one clock), as the page reports it
    return { total: window.__drift.total, gpu: `${info?.vendor}/${info?.architecture}${info?.isFallbackAdapter ? ' FALLBACK' : ''}` };
  });
  if (probed.error) throw new Error(probed.error);
  await probeBrowser.close();
  browsers.splice(browsers.indexOf(probeBrowser), 1);
  const TO = TO_ARG === null ? probed.total : Number(TO_ARG);
  if (!(TO > FROM)) throw new Error(`--to ${TO} must be after --from ${FROM}`);

  // ------------------------------------------------------------------------------------------------ the ranges
  const F = Math.max(0, Math.round((TO - FROM) * FPS));
  const N = Math.min(LANES, F);
  const lanes = Array.from({ length: N }, (_, k) => {
    const n0 = Math.floor((k * F) / N);
    const n1 = Math.floor(((k + 1) * F) / N);
    const from = FROM + n0 / FPS;
    const to = FROM + n1 / FPS;
    // the page derives its own frame count from from/to (record.ts frameCount): it must be exactly this range
    if (Math.max(0, Math.round((to - from) * FPS)) !== n1 - n0) throw new Error(`lane ${k}: [${from}, ${to}) is not ${n1 - n0} frames at ${FPS} fps`);
    // t of each frame as the lane computes it vs as one serial take would: equal up to the last bit of a double
    let ulp = 0;
    for (let j = 0; j < n1 - n0; j++) if (from + j / FPS !== FROM + (n0 + j) / FPS) ulp++;
    return { k, n0, n1, from, to, frames: n1 - n0, ulp, shot: `lane${k}` };
  });
  const name = `undertime_${SIZE}_${FROM}-${TO}s`;
  const OUT = resolve(ROOT, arg('out', `out/drift/${name}.${EXT}`));
  if (!OUT.endsWith(`.${EXT}`)) throw new Error(`--out must end in .${EXT} for --codec ${CODEC}`);
  const LANE_DIR = join(dirname(OUT), `.lanes-${name}`);
  const disk = checkDisk(dirname(OUT), F);
  log(`disk: ${(disk.free / 2 ** 30).toFixed(1)} GB free, this render ~${((disk.need - DISK_RESERVE) / 2 ** 30).toFixed(1)} GB at most`);
  rmSync(LANE_DIR, { recursive: true, force: true }); // our own scratch from an earlier run of this name
  mkdirSync(LANE_DIR, { recursive: true });
  laneDir = LANE_DIR;
  const threads = Math.max(1, Math.floor(cpus().length / N));
  log(`${F} frames [${FROM}, ${TO}) s at ${FPS} fps, ${SIZE}² ${CODEC}${CODEC === 'x264' ? ` crf ${CRF} ${PRESET}, ${threads} threads/lane` : ''}, ${N} lane(s), GPU ${probed.gpu}`);
  for (const l of lanes) log(`  lane ${l.k}: frames [${l.n0}, ${l.n1}) = t [${l.from.toFixed(3)}, ${l.to.toFixed(3)}) s${l.ulp > 0 ? `  (${l.ulp} t values off a serial take's in the last bit)` : ''}`);

  // ----------------------------------------------------------------------------------------- a sink per lane
  const startSink = (l) =>
    new Promise((res, rej) => {
      const dir = join(LANE_DIR, l.shot);
      const p = spawn(
        process.execPath,
        [join(ROOT, 'scripts/cine-sink.mjs'), '--out', dir, '--port', '0', '--fps', String(FPS), '--crf', CRF, '--preset', PRESET,
          '--threads', String(threads), '--codec', CODEC, '--queue', String(QUEUE)],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      sinks.push(p);
      l.sinkProc = p;
      l.file = join(dir, 'seg', `${l.shot}.${EXT}`);
      let buf = '';
      p.stdout.on('data', (d) => {
        buf += d;
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(line);
          if (m) res(m[1]);
          // LANE TIMING from the sink's own lines: it opens the clip on the first frame and closes it on /endshot —
          // exact, where sampling a page that is busy compiling its pipelines answers late
          if (line.includes(`[sink] ${l.shot} -> `)) l.tOpen = Date.now();
          if (line.includes(`[sink] ${l.shot}: `)) l.tClose = Date.now();
          const text = line.replace(/^\.+/, '').trim();
          // the clip-opened/closed lines are the driver's to report; a teardown that finalised nothing is not news
          if (text && !m && !text.includes('-> ') && !text.includes('finalising 0 unfinished')) console.log(`[lane ${l.k}] ${text}`);
        }
      });
      p.stderr.on('data', (d) => process.stderr.write(`[lane ${l.k} sink] ${d}`));
      p.on('exit', (code) => {
        l.sinkExit = code;
        rej(new Error(`lane ${l.k}: sink exited ${code} before listening`));
      });
    });
  const sinkUrls = await Promise.all(lanes.map(startSink));

  // --------------------------------------------------------------------------------------------------- lanes
  const tLaunch = Date.now();
  const group = `drift-${process.pid}`;
  await Promise.all(
    lanes.map(async (l, i) => {
      const b = await launch();
      browsers.push(b);
      const page = await b.newPage({ viewport: { width: 256, height: 256 } });
      l.page = page;
      l.errors = [];
      const seen = new Set();
      page.on('pageerror', (e) => l.errors.push(`pageerror: ${e}`));
      page.on('crash', () => l.errors.push('the page crashed'));
      l.consoleErrors = 0;
      page.on('console', (m) => {
        if (m.type() !== 'error' && m.type() !== 'warning') return;
        if (m.type() === 'error') l.consoleErrors++;
        const text = m.text();
        if (seen.has(text) || seen.size > 20) return;
        seen.add(text);
        console.log(`[lane ${l.k} ${m.type()}] ${text}`);
      });
      const q = new URLSearchParams({
        size: String(SIZE), fps: String(FPS), from: String(l.from), to: String(l.to), shot: l.shot, group,
        sink: sinkUrls[i], inflight: String(INFLIGHT), blur: String(BLUR), shutter: String(SHUTTER),
      });
      await page.goto(`${base}/drift.html?record&lane&${q}`);
    }),
  );
  log(`${N} lane(s) launched in ${secs(tLaunch).toFixed(1)} s`);

  // ------------------------------------------------------------------------------- wait, watching every lane
  let lastProgress = Date.now();
  let lastLine = 0;
  for (;;) {
    const live = lanes.filter((l) => !l.done);
    for (const l of live) {
      if (l.sinkExit !== undefined) l.errors.push(`its sink exited ${l.sinkExit}`);
      if (l.errors.length > 0) throw new Error(`lane ${l.k} failed:\n  ${l.errors.join('\n  ')}`);
    }
    // all lanes at once: a page busy compiling its pipelines answers late, and must not delay the others' samples
    const states = await Promise.all(
      live.map((l) => l.page.evaluate(() => ({ booted: '__drift' in window, rec: window.__driftRecord, hud: document.getElementById('drift-hud')?.textContent ?? '' }))),
    );
    for (const [i, l] of live.entries()) {
      const s = states[i];
      if (s.rec?.done && s.rec.error) throw new Error(`lane ${l.k} failed: ${s.rec.error}`);
      const m = /REC (\d+)\/(\d+)/.exec(s.hud);
      const n = s.rec?.done ? l.frames : m ? Number(m[1]) : 0;
      if (n > (l.n ?? 0)) lastProgress = Date.now();
      l.n = n;
      l.state = s;
      if (s.rec?.done) {
        if (s.rec.frames !== l.frames) throw new Error(`lane ${l.k}: the page rendered ${s.rec.frames} frames, ${l.frames} expected`);
        l.done = Date.now();
      }
    }
    if (lanes.every((l) => l.done)) break;
    if (Date.now() - lastProgress > STALL_MS) {
      const why = (l) => (l.done ? 'done' : `sink ${l.tOpen ? 'has frames' : 'has no frame'}, booted ${l.state?.booted}, __driftRecord ${JSON.stringify(l.state?.rec)}, hud ${JSON.stringify(l.state?.hud?.split('\n')[0])}`);
      throw new Error(`no lane advanced in ${STALL_MS / 1000} s:\n  ${lanes.map((l) => `lane ${l.k} ${l.n}/${l.frames} (${why(l)})`).join('\n  ')}`);
    }
    if (Date.now() - lastLine > 5000) {
      lastLine = Date.now();
      const done = lanes.reduce((a, l) => a + (l.n ?? 0), 0);
      log(`${done}/${F}  ${(done / secs(tLaunch)).toFixed(1)} fps  ${lanes.map((l) => `${l.n ?? 0}/${l.frames}`).join(' ')}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  const tRendered = Date.now();
  await Promise.allSettled(browsers.map((b) => b.close()));

  // --------------------------------------------------------------------------- every clip whole, then join
  for (const l of lanes) {
    if (!existsSync(l.file)) throw new Error(`lane ${l.k}: no clip at ${l.file} (a _FAILED take or .part beside it says why)`);
    const got = await frameCountOf(l.file);
    if (got !== l.frames) throw new Error(`lane ${l.k}: ${l.file} has ${got} frames, ${l.frames} expected`);
  }
  const list = join(LANE_DIR, 'concat.txt');
  writeFileSync(list, lanes.map((l) => `file '${l.file.replace(/'/g, "'\\''")}'\n`).join(''));
  mkdirSync(dirname(OUT), { recursive: true });
  const part = `${OUT}.part`;
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy',
    ...(EXT === 'mp4' ? ['-movflags', '+faststart'] : []), '-f', EXT, part]);
  const joined = await frameCountOf(part);
  if (joined !== F) throw new Error(`the joined file has ${joined} frames, ${F} expected — left ${part}`);
  if (existsSync(OUT)) console.warn(`[render] overwriting ${OUT}`);
  renameSync(part, OUT);
  const tJoined = Date.now();
  await teardown();
  if (!KEEP) rmSync(LANE_DIR, { recursive: true, force: true });

  // -------------------------------------------------------------------------------------------------- report
  // a lane's rate: frames 2..n over the time between its first and its last frame reaching the sink
  const rate = (l) => (l.tOpen !== undefined && l.tClose > l.tOpen && l.frames > 1 ? (l.frames - 1) / secs(l.tOpen, l.tClose) : NaN);
  const firstFrame = Math.min(...lanes.map((l) => l.tOpen ?? tRendered));
  const lastFrame = Math.max(...lanes.map((l) => l.tClose ?? tRendered));
  log(`${OUT}: ${F} frames, ${SIZE}², ${N} lane(s)`);
  for (const l of lanes) {
    log(`  lane ${l.k}: ${l.frames} frames, first frame ${secs(tLaunch, l.tOpen ?? tRendered).toFixed(1)} s after launch, ${rate(l).toFixed(2)} fps`);
  }
  log(`total: ${(F / secs(tLaunch, lastFrame)).toFixed(2)} fps launch to last frame (incl. lane boot), ` +
    `${(F / secs(firstFrame, lastFrame)).toFixed(2)} fps first to last frame, ${lanes.reduce((a, l) => a + rate(l), 0).toFixed(2)} fps sum of lanes; ` +
    `join ${secs(tRendered, tJoined).toFixed(1)} s, wall ${secs(t0).toFixed(1)} s`);
  // not fatal (a missing favicon logs one too), but a shader that failed to build renders wrong frames, not no frames
  const errs = lanes.reduce((a, l) => a + l.consoleErrors, 0);
  if (errs > 0) console.warn(`[render] WARNING: the lanes logged ${errs} console error(s), printed above — check the frames`);
}

main().then(
  () => {
    releaseLock();
    process.exit(0);
  },
  async (e) => {
    console.error(`\n[render] FAILED: ${e?.stack ?? e}`);
    await teardown();
    // a failed render leaves nothing behind (its partial lane clips can be gigabytes) unless --keep
    if (laneDir && !KEEP) rmSync(laneDir, { recursive: true, force: true });
    releaseLock();
    process.exit(1);
  },
);
