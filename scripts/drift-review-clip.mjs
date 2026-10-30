#!/usr/bin/env node
/**
 * A SHORT REVIEW CLIP of The Drift, drawn by the film's own pipeline (scripts/drift-review-page.mjs): a 16:9
 * rectilinear view by default (`dome.setFlat`, as scripts/drift-review-stills.mjs), the square dome master with
 * `--dome`. For motion and flicker — what a still cannot show. Encoded here, H.264 8-bit 4:2:0 (QuickTime and DaVinci
 * read it), frame by frame as the page posts them.
 *
 *   node scripts/drift-review-clip.mjs --from <s> --to <s> [--width 1280] [--fps 30] [--out <file.mp4>]
 *        [--shot '<json>' | --shot-file <view.json>] [--dome] [--port 5362] [--channel chrome|chromium]
 *        [--query raftplain] [--ss <n>] [--setup '<js>'] [--crf 16] [--allow-long] [--allow-large]
 *
 *   --from/--to   show time, s: frames t = from + n/fps for n < round((to − from)·fps)
 *   --shot        the view, the fields of a still's shot without name and t (scripts/drift-review-page.mjs), e.g.
 *                 '{"fov":55,"mode":"chase","back":9,"side":-3,"up":2.2}'. Default: the show's eye, 60°, straight ahead
 *   --out         default out/drift/review/clip_<from>-<to>s[_dome].mp4; written as <file>.part until it is complete
 *   --width       px (even); the 16:9 view is cut from a square frame of this size
 *   --ss          cube-face supersampling (default: 2 face texels a view pixel, under 4096 px faces: flatSupersample in
 *                 scripts/drift-review-page.mjs; 1 with --dome)
 *   --setup, --query, --channel, --port: as scripts/drift-review-stills.mjs
 *
 * LIMITS (the user, 2026-10-28/29: review clips short and at most 1280×720; nothing longer or larger without their
 * go, so the machine stays free): at most 30 s unless --allow-long, at most 1280 wide (1024² with --dome) unless
 * --allow-large. Masters go through scripts/drift-render.mjs.
 *
 * FAILS LOUD: a frame out of order or of the wrong size fails the take, and the file's frame count (ffprobe) must
 * equal the range's; a clip that is short is a render that died.
 */
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ROOT, aim, cli, eyeReport, flatSupersample, openDriftPage, refuseDuringRender } from './drift-review-page.mjs';
import { previewTee } from './drift-preview.mjs';

const { arg, num, has } = cli(process.argv.slice(2));
const FROM = Number(arg('from', NaN));
const TO = Number(arg('to', NaN));
if (!Number.isFinite(FROM) || !Number.isFinite(TO) || !(TO > FROM)) throw new Error('usage: node scripts/drift-review-clip.mjs --from <s> --to <s> [--width 1280] [--shot <json>] [--dome]');
const FPS = num('fps', 30);
const FRAMES = Math.max(0, Math.round((TO - FROM) * FPS)); // record.ts frameCount
const DOME = has('dome');
const N = num('width', DOME ? 1024 : 1280);
if (N % 2 !== 0) throw new Error(`--width ${N}: must be even`);
const MAX = DOME ? 1024 : 1280;
if (N > MAX && !has('allow-large')) throw new Error(`--width ${N}: above ${MAX} needs --allow-large (and the user's go)`);
if (TO - FROM > 30 && !has('allow-long')) throw new Error(`${TO - FROM} s: a review clip is at most 30 s without --allow-long (and the user's go)`);
const shotFile = arg('shot-file', null);
const shot = { name: 'clip', ...JSON.parse(shotFile ? readFileSync(shotFile, 'utf8') : arg('shot', '{}')) };
const OUT = resolve(ROOT, arg('out', `out/drift/review/clip_${FROM}-${TO}s${DOME ? '_dome' : ''}.mp4`));
if (!OUT.endsWith('.mp4')) throw new Error('--out must end in .mp4');
const SS = arg('ss', null);
const ss = SS !== null ? Number(SS) : DOME ? 1 : flatSupersample(shot.fov ?? 60, N);
const SETUP = arg('setup', process.env.SETUP ?? null);

refuseDuringRender();
mkdirSync(dirname(OUT), { recursive: true });
const part = `${OUT}.part`;
const h = DOME ? N : Math.round((N * 9) / 16 / 2) * 2;
let got = 0;
let t0 = 0;
let ff = null;
let ffExit = null;
const preview = previewTee();
const { page, sinkUrl, run, close } = await openDriftPage({
  port: num('port', 5362),
  channel: arg('channel', 'chrome'),
  query: arg('query', ''),
  cacheDir: 'node_modules/.vite-drift-review-clip',
  onFrame: async (bytes, q) => {
    if (ffExit !== null) throw new Error(`ffmpeg exited ${ffExit}`);
    if (Number(q.get('n')) !== got) throw new Error(`frame ${q.get('n')} arrived, ${got} expected`);
    if (bytes.length !== N * N * 4) throw new Error(`a frame of ${bytes.length} bytes, not ${N}² RGBA`);
    got++;
    // (a farm job's live preview, drift-preview.mjs: one frame every 10 s handed on, never waited for)
    preview.offer(bytes, N, N, { crop: DOME ? null : h });
    if (!ff.stdin.write(bytes)) await once(ff.stdin, 'drain');
    if (got % 30 === 0 || got === FRAMES) console.log(`[review] ${got}/${FRAMES}  ${(got / ((Date.now() - t0) / 1000)).toFixed(1)} fps`);
  },
});
let ok = false;
try {
  // the encoder starts once the page is up, so a page that never boots leaves no file behind
  ff = spawn(
    'ffmpeg',
    [
      '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${N}x${N}`, '-r', String(FPS), '-i', 'pipe:0',
      ...(DOME ? [] : ['-vf', `crop=${N}:${h}:0:${(N - h) / 2}`]),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', arg('crf', '16'), '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      // explicit: the muxer cannot be inferred from `.mp4.part`
      '-f', 'mp4', part,
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );
  ff.on('close', (code, signal) => (ffExit = code ?? signal));
  ff.stdin.on('error', () => {}); // an ffmpeg that died is reported by its exit code below
  if (SETUP) console.log('[review] setup:', JSON.stringify(await run(SETUP)));
  await aim(page, shot, DOME);
  console.log(`[review] ${FRAMES} frames [${FROM}, ${TO}) s at ${FPS} fps, ${N}×${h}${DOME ? ' dome' : ''}, ss ${ss.toFixed(2)}`);
  t0 = Date.now();
  await page.evaluate(
    ({ N, FPS, FROM, TO, sinkUrl, ss }) => window.__drift.record({ size: N, fps: FPS, from: FROM, to: TO, sink: sinkUrl, lane: true, shot: 'clip', inFlight: 2, supersample: ss }),
    { N, FPS, FROM, TO, sinkUrl, ss },
  );
  const raft = await eyeReport(page, shot);
  ff.stdin.end();
  if (ffExit === null) await once(ff, 'close');
  if (ffExit !== 0) throw new Error(`ffmpeg exited ${ffExit}`);
  const nb = Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=nb_frames', '-of', 'csv=p=0', part], { encoding: 'utf8' }).trim());
  if (got !== FRAMES || nb !== FRAMES) throw new Error(`${got} frames received, ${nb} in the file, ${FRAMES} expected`);
  renameSync(part, OUT);
  ok = true;
  console.log(`[review] ${OUT}: ${nb} frames, ${N}×${h}, ${((Date.now() - t0) / 1000).toFixed(1)} s${raft ? `  raft at the end ${JSON.stringify(raft)}` : ''}`);
} finally {
  if (!ok) {
    ff?.kill('SIGKILL');
    rmSync(part, { force: true });
  }
  await close();
}
