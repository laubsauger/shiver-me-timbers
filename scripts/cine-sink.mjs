#!/usr/bin/env node
/**
 * Frame sink for the cinematic recorder (src/cine/recorder.ts).
 *
 * The browser cannot write files, and a 5000-file `showDirectoryPicker` run
 * dies with the tab. So the page POSTs each frame here and this writes it to
 * disk — which also means the render survives losing the tab, and you poll the
 * directory rather than the page (docs/agent-browser-harness.md §5).
 *
 * FRAMES ARRIVE AS RAW RGBA AND ARE ENCODED HERE, by an ffmpeg the sink keeps
 * open per shot. The page used to encode its own PNGs; in a backgrounded tab
 * `OffscreenCanvas.convertToBlob` at 1080p just stops ("did not finish in
 * 20000ms"), because the encode is a task the browser may deprioritise. Node
 * is not throttled. It also means no PNG sequence ever hits the disk — a
 * 240 s film is one mp4 per shot instead of ~6 GB of stills.
 *
 *   node scripts/cine-sink.mjs [--out out/cine] [--port 7654] [--crf 12]
 *   node scripts/cine-sink.mjs --edit sb-trailer-v1          EDIT DELIVERY (docs/cine/trailer-edit-plan.md)
 *
 * Routes (all POST):
 *   /manifest                       fps, size, shot/transition list
 *   /frame?shot=D&n=..&w=..&h=..    raw RGBA body -> piped into seg/D.mp4
 *   /endshot?clip=..                that shot is complete: finalise its clip
 *   /audio?clip=..&ext=..&dur=..    a shot's SFX take (the real-time audio pass)
 *   /plan                           the run's edit plan (edit delivery only)
 *   /done                           closes every encoder; prints the mux command
 *
 * EDIT DELIVERY (`--edit <name>`, out/cine/<name>/ unless --out): the layout the Resolve importer reads —
 *   video/<clip>.mov   ProRes 422 HQ, 10-bit 4:2:2, at the rendered size (the master)
 *   proxy/<clip>.mov   ProRes 422 Proxy, 1920x1080, made from the master the moment it closes
 *   sfx/<clip>.wav     48 kHz 24-bit PCM, padded/trimmed to EXACTLY the clip's length (`dur`, head handle included)
 *   edit-plan.json     the page's plan with only the files that exist on disk (rewritten as each file lands)
 * No mux: the edit is assembled in Resolve.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

const EDIT = arg('edit', null);
const OUT = resolve(arg('out', EDIT === null ? 'out/cine' : `out/cine/${EDIT}`));
const PORT = Number(arg('port', '7654'));
const CRF = arg('crf', '12');
const PROXY = arg('proxy', '1920x1080');

if (EDIT === null) mkdirSync(join(OUT, 'seg'), { recursive: true });
else for (const d of ['video', 'proxy', 'sfx']) mkdirSync(join(OUT, d), { recursive: true });

/** run ffmpeg to completion; resolves to its exit code (errors are printed by ffmpeg itself) */
const ffmpeg = (args) =>
  new Promise((res) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
    p.on('error', (e) => {
      console.error(`[sink] ffmpeg: ${e.message}`);
      res(1);
    });
    p.on('close', (code) => res(code));
  });

/**
 * edit-plan.json = the page's template minus every file that is not on disk. The importer fails on a missing path,
 * and a plan written before the render is exactly that; so it is rewritten each time a master, proxy or stem lands.
 */
function writePlan() {
  const tpl = join(OUT, 'plan.template.json');
  if (EDIT === null || !existsSync(tpl)) return;
  const plan = JSON.parse(readFileSync(tpl, 'utf8'));
  const on = (rel) => rel !== undefined && existsSync(join(OUT, rel));
  const all = plan.shots.length;
  // THE NEWEST TAKE of each shot on disk, not the take the last run was named for: re-shooting 09 as take 02 must
  // not drop the other seventeen take-01 clips from the timeline
  const videos = existsSync(join(OUT, 'video')) ? readdirSync(join(OUT, 'video')) : [];
  const newest = (s) => {
    const m = /^video\/(.*)_take(\d+)\.mov$/.exec(s.video ?? '');
    if (m === null) return s;
    const takes = videos.map((f) => new RegExp(`^${m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_take(\\d+)\\.mov$`).exec(f)).filter(Boolean).map((x) => x[1]);
    if (takes.length === 0) return s;
    const t = takes.sort((a, b) => Number(b) - Number(a))[0];
    const clip = `${m[1]}_take${t}`;
    return { ...s, video: `video/${clip}.mov`, proxy: `proxy/${clip}.mov`, sfx: `sfx/${clip}.wav` };
  };
  plan.shots = plan.shots
    .map(newest)
    .filter((s) => on(s.video))
    .map((s) => {
      const out = { ...s };
      if (!on(s.proxy)) delete out.proxy;
      if (!on(s.sfx)) delete out.sfx;
      return out;
    });
  writeFileSync(join(OUT, 'edit-plan.json'), JSON.stringify(plan, null, 2));
  const sfx = plan.shots.filter((s) => s.sfx).length;
  const prox = plan.shots.filter((s) => s.proxy).length;
  console.log(`\n[sink] edit-plan.json: ${plan.shots.length}/${all} shots on disk, ${prox} proxies, ${sfx} sfx stems`);
}

/** shot id -> { proc, frames } — one long-lived ffmpeg per shot */
const encoders = new Map();
let fps = 24;
let started = 0;

/**
 * Open an encoder for a shot. Backpressure is REAL here: an 8 MB frame every
 * few seconds is nothing, but ffmpeg's stdin can still fill, and ignoring
 * `write()`'s return value would silently drop frames rather than slow the
 * page down. Every write is awaited by the request handler, so a slow encoder
 * throttles the render instead of corrupting it.
 */
function openEncoder(shot, w, h) {
  const file = EDIT === null ? join(OUT, 'seg', `${shot}.mp4`) : join(OUT, 'video', `${shot}.mov`);
  if (EDIT !== null && existsSync(file)) console.warn(`\n[sink] OVERWRITING ${file} — pass a new take to keep it`);
  // .part until it closes cleanly. An mp4 only becomes playable when ffmpeg
  // writes its `moov` atom at the END, so a file that is still being written —
  // or whose encoder was killed — is a normal-looking mp4 that no player will
  // open. Naming it `.part` makes "not finished" visible in `ls` instead of
  // only in QuickTime's error dialog.
  const part = `${file}.part`;
  // the edit master: ProRes 422 HQ (profile 3), 10-bit 4:2:2, a constant frame rate
  const codec = EDIT === null
    ? ['-c:v', 'libx264', '-preset', 'slow', '-crf', CRF, '-pix_fmt', 'yuv420p']
    : ['-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le'];
  const proc = spawn(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-r', String(fps),
      '-i', 'pipe:0',
      '-an', ...codec,
      // moov at the front: one rewrite at close, and the file is seekable
      // immediately rather than only after a full read
      '-movflags', '+faststart',
      // EXPLICIT, because the output is `…mp4.part` and ffmpeg infers the
      // muxer from the extension: without this it fails with "Unable to choose
      // an output format", the encoder dies on the first frame, and the write
      // side then waits forever on a `drain` from a closed pipe
      '-f', EDIT === null ? 'mp4' : 'mov',
      part,
    ],
    { stdio: ['pipe', 'ignore', 'inherit'] },
  );
  proc.on('error', (e) => {
    rec.failed = e;
    console.error(`[sink] ffmpeg for ${shot}: ${e.message}`);
  });
  // ONCE, at spawn. Attaching this per frame added a listener per frame and
  // node started warning about a leak at 11 — on a 5760-frame film it would
  // have been 5760 of them on one socket.
  const rec = { proc, file, part, frames: 0, w, h, failed: null, closing: null, exited: false };
  proc.stdin.on('error', (e) => {
    rec.failed = e;
  });
  // an encoder that dies has to fail the WRITES too, or the next frame parks
  // on a `drain` event that a closed pipe will never emit — a silent hang that
  // looks exactly like a slow render
  proc.on('exit', (code) => {
    rec.exited = true;
    if (code !== 0 && rec.failed === null) {
      rec.failed = new Error(`ffmpeg for ${shot} exited ${code} before the shot ended`);
    }
  });
  encoders.set(shot, rec);
  console.log(`\n[sink] ${shot} -> ${file} (${w}x${h} @ ${fps})`);
  return rec;
}

const writeFrame = (rec, buf) =>
  new Promise((res, rej) => {
    if (rec.failed !== null) {
      rej(rec.failed);
      return;
    }
    if (rec.exited || rec.proc.stdin.destroyed) {
      rej(new Error('ffmpeg is gone — see the error above this line'));
      return;
    }
    // backpressure is real: an 8 MB frame can fill ffmpeg's stdin, and
    // ignoring `write()`'s return value drops frames silently rather than
    // slowing the render down
    if (rec.proc.stdin.write(buf)) res();
    else rec.proc.stdin.once('drain', res);
  });

/**
 * Finish ONE shot's clip: close the pipe, wait for ffmpeg to write its `moov`,
 * then take the `.part` off the name.
 *
 * Per shot and not per run, for a reason that cost a whole 1440p take: every
 * encoder used to stay open until `/done`, so 23 ffmpeg processes sat holding
 * 23 unfinalised files, and when the run did not reach `/done` — a closed tab
 * is enough — not one of the 23 was playable. Closing a shot the moment it
 * ends means the worst an interruption can cost is the shot in progress.
 */
function closeEncoder(name) {
  const rec = encoders.get(name);
  if (rec === undefined) return Promise.resolve();
  if (rec.closing !== null) return rec.closing;
  rec.closing = new Promise((res) => {
    rec.proc.on('close', (code) => {
      if (code === 0 && existsSync(rec.part)) {
        renameSync(rec.part, rec.file);
        console.log(`\n[sink] ${name}: ${rec.frames} frames -> ${rec.file}`);
        // NOT awaited: a 4K transcode would hold the next shot's first frame long enough to trip the stall watchdog
        if (EDIT !== null) void makeProxy(name, rec.file);
      } else {
        console.error(`\n[sink] ${name}: ffmpeg exited ${code} — left ${rec.part}`);
      }
      res();
    });
    rec.proc.stdin.end();
  });
  return rec.closing;
}

const closeEncoders = () => Promise.all([...encoders.keys()].map(closeEncoder));

/** the 1920x1080 ProRes Proxy beside a finished master, then the plan picks both up */
async function makeProxy(name, master) {
  const [pw, ph] = PROXY.split('x');
  const out = join(OUT, 'proxy', `${name}.mov`);
  const code = await ffmpeg([
    '-i', master, '-vf', `scale=${pw}:${ph}:flags=lanczos`,
    '-c:v', 'prores_ks', '-profile:v', '0', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le', '-an', '-f', 'mov', `${out}.part`,
  ]);
  if (code === 0) {
    renameSync(`${out}.part`, out);
    console.log(`[sink] ${name}: proxy -> ${out}`);
  } else {
    console.error(`[sink] ${name}: proxy ffmpeg exited ${code}`);
  }
  writePlan();
}

const readBody = (req) =>
  new Promise((res, rej) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => res(Buffer.concat(chunks)));
    req.on('error', rej);
  });

const cors = (res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
};

const server = createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/frame') {
      const shot = url.searchParams.get('shot');
      const w = Number(url.searchParams.get('w'));
      const h = Number(url.searchParams.get('h'));
      if (!shot || !w || !h) throw new Error('frame needs ?shot=, ?w= and ?h=');
      const body = await readBody(req);
      if (body.length !== w * h * 4) {
        // loud: a short frame means the readback was padded or truncated, and
        // ffmpeg would happily encode the resulting diagonal smear
        throw new Error(`frame is ${body.length} bytes, expected ${w * h * 4} for ${w}x${h}`);
      }
      if (started === 0) started = Date.now();
      let rec = encoders.get(shot);
      if (rec === undefined) {
        // a new shot means the previous one is done — close it now rather than
        // holding every encoder of the run open to the end
        await closeEncoders();
        encoders.clear();
        rec = openEncoder(shot, w, h);
      }
      await writeFrame(rec, body);
      rec.frames++;
      if (rec.frames % 24 === 0) process.stdout.write('.');
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === '/endshot') {
      const clip = url.searchParams.get('clip');
      if (!clip) throw new Error('endshot needs ?clip=');
      await closeEncoder(clip);
      encoders.delete(clip);
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === '/audio') {
      // the audio pass is a SEPARATE, real-time run (src/cine/audio.ts), so it
      // lands beside the clip rather than inside it; cine-mux pairs them
      const clip = url.searchParams.get('clip');
      const ext = url.searchParams.get('ext') ?? 'webm';
      if (!clip) throw new Error('audio needs ?clip=');
      const body = await readBody(req);
      if (EDIT !== null) {
        // a WAV stem the length of the video clip EXACTLY: the take is wall-clock timed and lands a few ms either
        // side, and the importer lays stem and picture from the same source frame
        const dur = Number(url.searchParams.get('dur'));
        if (!(dur > 0)) throw new Error('edit delivery: audio needs ?dur= (the clip length, s)');
        const src = join(OUT, 'sfx', `${clip}.${ext}.src`);
        const wav = join(OUT, 'sfx', `${clip}.wav`);
        writeFileSync(src, body);
        const code = await ffmpeg(['-i', src, '-af', `apad,atrim=end=${dur}`, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s24le', wav]);
        unlinkSync(src);
        if (code !== 0) throw new Error(`audio ${clip}: ffmpeg exited ${code}`);
        console.log(`\n[sink] sfx ${clip} -> ${wav} (${dur.toFixed(3)} s)`);
        writePlan();
        res.writeHead(204).end();
        return;
      }
      const file = join(OUT, 'seg', `${clip}.${ext}`);
      writeFileSync(file, body);
      console.log(`\n[sink] audio ${clip} -> ${file} (${(body.length / 1024).toFixed(0)} kB)`);
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === '/plan') {
      const body = await readBody(req);
      JSON.parse(body.toString('utf8')); // loud on a malformed plan, before it replaces a good one
      writeFileSync(join(OUT, 'plan.template.json'), body);
      writePlan();
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === '/manifest' || url.pathname === '/done') {
      const body = await readBody(req);
      writeFileSync(join(OUT, 'manifest.json'), body);
      try {
        fps = JSON.parse(body.toString('utf8')).fps ?? fps;
      } catch {
        /* the manifest is advisory here; the frame route carries the size */
      }
      if (url.pathname === '/done') {
        await closeEncoders();
        const total = [...encoders.values()].reduce((a, r) => a + r.frames, 0);
        const secs = ((Date.now() - started) / 1000).toFixed(0);
        console.log(`\n[sink] done — ${total} frames from ${encoders.size} shots in ${secs}s`);
        for (const [id, r] of encoders) console.log(`[sink]   ${id}: ${r.frames} frames`);
        console.log(EDIT === null ? `[sink] next: node scripts/cine-mux.mjs --out ${OUT}` : `[sink] next: python3 scripts/resolve/trailer_import.py ${join(OUT, 'edit-plan.json')} --proxy`);
        encoders.clear();
      } else {
        console.log(`[sink] manifest -> ${join(OUT, 'manifest.json')}`);
      }
      res.writeHead(204).end();
      return;
    }
    res.writeHead(404).end('no such route');
  } catch (e) {
    console.error(`[sink] ${String(e)}`);
    res.writeHead(500).end(String(e));
  }
});

/**
 * Ctrl-C must still finish the files. Without this the sink dies holding open
 * pipes and every clip in flight is an mp4 with no `moov` — which is exactly
 * what "none of the mp4s will open" looks like from the outside.
 */
let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    console.log(`\n[sink] ${sig} — finalising ${encoders.size} clip(s)…`);
    void closeEncoders().then(() => process.exit(0));
  });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[sink] listening on http://127.0.0.1:${PORT} -> ${OUT}`);
});
