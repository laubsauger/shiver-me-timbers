#!/usr/bin/env node
/**
 * REVIEW STILLS of The Drift, drawn by the film's own pipeline (scripts/drift-review-page.mjs): by default a 16:9
 * rectilinear view of the focus zone (`dome.setFlat`), the frame the master would draw resampled as a normal camera
 * sees it — "if I have to dewarp the dome projection in my head all the time, it isn't really super helpful" (the
 * user, 2026-10-29). `--dome` writes the square dome master instead, for when the point is the whole scene at once.
 *
 *   node scripts/drift-review-stills.mjs <shots.json> [--width 1280] [--out out/drift/review/<shots>] [--dome]
 *        [--port 5361] [--channel chrome|chromium] [--query raftplain] [--ss <n>]
 *        [--setup '<js>'] [--post '<js>'] [--allow-large]
 *
 * shots.json: [{ name, t, ...view }] — t is show time (s, the HUD's clock); the view fields (fov, yaw, pitch, eye,
 * mode, back, side, up, ahead) are listed in scripts/drift-review-page.mjs. For example:
 *
 *   [{ "name": "shore_545", "t": 545, "fov": 50, "pitch": -8 },
 *    { "name": "raft_chase_400", "t": 400, "fov": 55, "mode": "chase", "back": 9, "side": -3, "up": 2.2 },
 *    { "name": "beach_low_600", "t": 600, "fov": 70, "eye": { "dx": 4, "y": 0.6, "yaw": 30 } }]
 *
 * Writes <out>/<name>.png: <width> × <width>·9/16 (16:9), or <width>² with --dome. Prints each shot's time and, in the
 * sea's scene, the raft's pose (x, z m; heading deg) — what a chase or aimed shot is framed against.
 *
 *   --width   px (even). The 16:9 view is cut from a square frame of this size. Up to 1920 (1024 with --dome) unless
 *             --allow-large
 *   --ss      cube-face supersampling (default: 2 face texels a view pixel, under 4096 px faces: flatSupersample in
 *             scripts/drift-review-page.mjs; 1 with --dome)
 *   --query   extra drift.html query, e.g. `raftplain` (the game's undressed raft, an A/B) or `sea&hour=17` (the
 *             sea test act, on its own clock)
 *   --setup   JS run once after boot, the body of an async function of `d` (= window.__drift), e.g.
 *             'd.params.seaAo = 0' for an A/B against src/params/drift.ts; its result is printed. SETUP= in the
 *             environment works too
 *   --post    JS run the same way after each shot (a probe); its result is printed
 *   --channel chrome (default): the installed Google Chrome. Playwright's own Chromium fails to compile some of the
 *             sea's shaders (docs/drift/engine-findings.md); Acts 1–2 draw the same in both
 *   --port    this script's own Vite server (strict: it fails if the port is taken)
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { ROOT, aim, cli, eyeReport, flatSupersample, openDriftPage, refuseDuringRender } from './drift-review-page.mjs';
import { previewTee } from './drift-preview.mjs';

const argv = process.argv.slice(2);
const { arg, num, has } = cli(argv);
const shotsFile = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
if (!shotsFile) throw new Error('usage: node scripts/drift-review-stills.mjs <shots.json> [--width 1280] [--dome] [--out dir]');
const shots = JSON.parse(readFileSync(shotsFile, 'utf8'));
if (!Array.isArray(shots) || shots.some((s) => typeof s.name !== 'string' || !Number.isFinite(s.t))) throw new Error(`${shotsFile}: an array of { name, t, ... }`);
const DOME = has('dome');
const N = num('width', DOME ? 1024 : 1280);
if (N % 2 !== 0) throw new Error(`--width ${N}: must be even`);
const MAX = DOME ? 1024 : 1920;
if (N > MAX && !has('allow-large')) throw new Error(`--width ${N}: above ${MAX} needs --allow-large`);
const OUT = resolve(ROOT, arg('out', `out/drift/review/${basename(shotsFile, '.json')}`));
const SS = arg('ss', null);
const SETUP = arg('setup', process.env.SETUP ?? null);
const POST = arg('post', null);

refuseDuringRender();
mkdirSync(OUT, { recursive: true });
let frame = null;
const stillPreview = previewTee({ everyMs: 0 });
const { page, sinkUrl, run, close } = await openDriftPage({
  port: num('port', 5361),
  channel: arg('channel', 'chrome'),
  query: arg('query', ''),
  cacheDir: 'node_modules/.vite-drift-review-stills',
  onFrame: async (bytes, q) => {
    if (bytes.length !== N * N * 4 || Number(q.get('w')) !== N) throw new Error(`a ${q.get('w')}² frame of ${bytes.length} bytes, not ${N}² RGBA`);
    frame = bytes;
  },
});
try {
  if (SETUP) console.log('[review] setup:', JSON.stringify(await run(SETUP)));
  // IN SHOW-TIME ORDER, not the file's: the sea's wake is replayed from its world's start whenever a shot lies more than
  // 10 s past the one before, or before it (src/drift/wandering/sea.ts wakeTo) — 25–35 s a shot on a 4090 — while a
  // shot a few seconds on is caught up in steps (0.2–0.4 s; measured on windows-monster, 2026-10-30). Each still is
  // still written under its own name. (A caught-up wake is sea.ts's own trade against a replayed one: the same within
  // its 10 s catch-up, as the realtime page has always drawn it)
  const order = [...shots].sort((a, b) => a.t - b.t);
  const jumps = (list) => list.slice(1).filter((x, i) => x.t < list[i].t || x.t - list[i].t > 10).length;
  const asGiven = jumps(shots);
  const sorted = jumps(order);
  if (asGiven > sorted) console.log(`[review] shots drawn in show-time order: as listed they jump back or >10 s ${asGiven} time(s), sorted ${sorted} (each jump replays the sea's wake, ~30 s on a 4090)`);
  else if (sorted > 2) console.log(`[review] ${sorted} gaps of >10 s between shots: each replays the sea's wake (~30 s on a 4090)`);
  for (const s of order) {
    const t0 = Date.now();
    frame = null;
    await aim(page, s, DOME);
    const ss = SS !== null ? Number(SS) : DOME ? 1 : flatSupersample(s.fov ?? 60, N);
    // one frame, [t, t + 1/30): record.ts draws and drops a warm-up frame first, as every lane does
    await page.evaluate(
      ({ t, N, sinkUrl, ss }) => window.__drift.record({ size: N, fps: 30, from: t, to: t + 1 / 30, sink: sinkUrl, lane: true, shot: 'review', inFlight: 1, supersample: ss }),
      { t: s.t, N, sinkUrl, ss },
    );
    if (!frame) throw new Error(`${s.name}: the take ended without a frame`);
    const h = Math.round((N * 9) / 16 / 2) * 2;
    const file = join(OUT, `${s.name}.png`);
    const crop = DOME ? [] : ['-vf', `crop=${N}:${h}:0:${(N - h) / 2}`];
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${N}x${N}`, '-i', 'pipe:0', ...crop, file], { input: frame });
    // (a farm job's live preview, drift-preview.mjs: the newest still, every one of them — they are seconds apart)
    stillPreview.offer(frame, N, N, { crop: DOME ? null : h });
    const raft = await eyeReport(page, s);
    console.log(`[review] ${file}  t ${s.t} s  ss ${ss.toFixed(2)}  ${Date.now() - t0} ms${raft ? `  raft ${JSON.stringify(raft)}` : ''}`);
    if (POST) console.log(`[review] post ${s.name}:`, JSON.stringify(await run(POST)));
  }
} finally {
  await close();
}
