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
 *
 * Routes (all POST):
 *   /manifest                       fps, size, shot/transition list
 *   /frame?shot=D&n=..&w=..&h=..    raw RGBA body -> piped into seg/D.mp4
 *   /done                           closes every encoder; prints the mux command
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

const OUT = resolve(arg('out', 'out/cine'));
const PORT = Number(arg('port', '7654'));
const CRF = arg('crf', '12');

mkdirSync(join(OUT, 'seg'), { recursive: true });

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
  const file = join(OUT, 'seg', `${shot}.mp4`);
  // .part until it closes cleanly. An mp4 only becomes playable when ffmpeg
  // writes its `moov` atom at the END, so a file that is still being written —
  // or whose encoder was killed — is a normal-looking mp4 that no player will
  // open. Naming it `.part` makes "not finished" visible in `ls` instead of
  // only in QuickTime's error dialog.
  const part = `${file}.part`;
  const proc = spawn(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-r', String(fps),
      '-i', 'pipe:0',
      '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', CRF, '-pix_fmt', 'yuv420p',
      // moov at the front: one rewrite at close, and the file is seekable
      // immediately rather than only after a full read
      '-movflags', '+faststart',
      // EXPLICIT, because the output is `…mp4.part` and ffmpeg infers the
      // muxer from the extension: without this it fails with "Unable to choose
      // an output format", the encoder dies on the first frame, and the write
      // side then waits forever on a `drain` from a closed pipe
      '-f', 'mp4',
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
      const file = join(OUT, 'seg', `${clip}.${ext}`);
      writeFileSync(file, body);
      console.log(`\n[sink] audio ${clip} -> ${file} (${(body.length / 1024).toFixed(0)} kB)`);
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
        console.log(`[sink] next: node scripts/cine-mux.mjs --out ${OUT}`);
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
