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
 * Options for a lane of a parallel render (scripts/drift-render.mjs, docs/cine/drift-render.md), all off by default:
 *   --port 0          any free port; the listening line prints the real one
 *   --fps <n>         frame rate before any /manifest (a lane posts none)
 *   --threads <n>     libx264 threads — N lanes share the machine's cores
 *   --preset <p>      libx264 preset (default slow)
 *   --codec prores    seg/<shot>.mov, ProRes 422 HQ on the VideoToolbox engine (intra-only: joins anywhere)
 *   --queue <n>       answer a frame once it is QUEUED, holding at most n frames ahead of ffmpeg, so the page
 *                     renders on while the encoder catches up (0 = answer once ffmpeg took the frame)
 *
 * Routes (all POST):
 *   /manifest                       fps, size, shot/transition list
 *   /frame?shot=D&n=..&w=..&h=..    raw RGBA body -> piped into seg/D.mp4
 *   /endshot?clip=..                that shot is complete: finalise its clip
 *   /audio?clip=..&stem=..&fmt=f32&rate=..&dur=..   a shot's SFX take (the real-time audio pass): interleaved stereo
 *                                   float32 PCM at the context's rate — `stem` mix | engine | water | amb
 *   /plan                           the run's edit plan (edit delivery only)
 *   /done                           closes every encoder; prints the mux command
 *
 * EDIT DELIVERY (`--edit <name>`, out/cine/<name>/ unless --out): the layout the Resolve importer reads —
 *   video/<clip>.mov   ProRes 422 HQ, 10-bit 4:2:2, at the rendered size (the master)
 *   proxy/<clip>.mov   ProRes 422 Proxy, 1920x1080, made from the master the moment it closes
 *   sfx/<clip>.wav     48 kHz 24-bit PCM, padded/trimmed to EXACTLY the clip's length (`dur`, head handle included)
 *   sfx/<clip>_<stem>.wav   the split stems (engine / water / amb) when the page provides them, same length
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
const THREADS = arg('threads', null);
const PRESET = arg('preset', 'slow');
const CODEC = arg('codec', 'x264');
const QUEUE = Math.max(0, Number(arg('queue', '0')) || 0);
if (CODEC !== 'x264' && CODEC !== 'prores') throw new Error(`--codec ${CODEC}: x264 | prores`);
/** a non-edit clip's file: seg/<shot>.mp4, or .mov for ProRes (the mp4 muxer has no ProRes tag) */
const SEG_EXT = CODEC === 'prores' ? 'mov' : 'mp4';

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
  const newestTake = (video) => {
    const m = /^video\/(.*)_take(\d+)\.mov$/.exec(video ?? '');
    if (m === null) return null;
    const takes = videos.map((f) => new RegExp(`^${m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_take(\\d+)\\.mov$`).exec(f)).filter(Boolean).map((x) => x[1]);
    if (takes.length === 0) return null;
    return `${m[1]}_take${takes.sort((a, b) => Number(b) - Number(a))[0]}`;
  };
  const newest = (s) => {
    const clip = newestTake(s.video);
    // a time-of-day variant's alternates (same take at other skies) follow their own newest take and drop when absent;
    // the SFX stem is one per shot, named without the take's variant, so it keeps its own take number
    const alternates = (s.alternates ?? [])
      .map((a) => {
        const c = newestTake(a.video);
        return c === null ? a : { ...a, video: `video/${c}.mov`, proxy: `proxy/${c}.mov` };
      })
      .filter((a) => on(a.video))
      .map((a) => (on(a.proxy) ? a : { variant: a.variant, video: a.video }));
    const withAlt = (x) => (alternates.length > 0 ? { ...x, alternates } : (({ alternates: _drop, ...rest }) => rest)(x));
    if (clip === null) return withAlt(s);
    const t = /_take(\d+)$/.exec(clip)[1];
    const sfx = s.sfx === undefined ? undefined : s.sfx.replace(/_take\d+\.wav$/, `_take${t}.wav`);
    // split stems (engine / water / amb) follow the mix's take the same way
    const sfxStems = s.sfxStems === undefined ? undefined : Object.fromEntries(Object.entries(s.sfxStems).map(([k, v]) => [k, v.replace(/_take\d+_(\w+)\.wav$/, `_take${t}_$1.wav`)]));
    return withAlt({ ...s, video: `video/${clip}.mov`, proxy: `proxy/${clip}.mov`, sfx, ...(sfxStems ? { sfxStems } : {}) });
  };
  plan.shots = plan.shots
    .map(newest)
    .filter((s) => on(s.video))
    .map((s) => {
      const out = { ...s };
      if (!on(s.proxy)) delete out.proxy;
      if (!on(s.sfx)) delete out.sfx;
      if (s.sfxStems !== undefined) {
        const stems = Object.fromEntries(Object.entries(s.sfxStems).filter(([, v]) => on(v)));
        if (Object.keys(stems).length > 0) out.sfxStems = stems;
        else delete out.sfxStems;
      }
      return out;
    });
  // COVERAGE (docs/cine/trailer-edit-plan.md §Coverage): every lens of every setup, each on its own newest take on disk;
  // the setup's sfx stem keeps the take number of that clip; entries whose video is not on disk are dropped
  const allCov = plan.coverage?.length ?? 0;
  if (plan.coverage !== undefined) {
    plan.coverage = plan.coverage
      .map((c) => {
        const clip = newestTake(c.video);
        if (clip === null) return c;
        const t = /_take(\d+)$/.exec(clip)[1];
        const sfx = c.sfx === undefined ? undefined : c.sfx.replace(/_take\d+\.wav$/, `_take${t}.wav`);
        return { ...c, video: `video/${clip}.mov`, proxy: `proxy/${clip}.mov`, ...(sfx !== undefined ? { sfx } : {}) };
      })
      .filter((c) => on(c.video))
      .map((c) => {
        const out = { ...c };
        if (!on(c.proxy)) delete out.proxy;
        if (!on(c.sfx)) delete out.sfx;
        return out;
      });
  }
  writeFileSync(join(OUT, 'edit-plan.json'), JSON.stringify(plan, null, 2));
  if (plan.coverage !== undefined) console.log(`[sink] edit-plan.json: ${plan.coverage.length}/${allCov} coverage clips on disk (${new Set(plan.coverage.map((c) => c.setup)).size} setups)`);
  const sfx = plan.shots.filter((s) => s.sfx).length;
  const prox = plan.shots.filter((s) => s.proxy).length;
  const alts = plan.shots.reduce((n, s) => n + (s.alternates?.length ?? 0), 0);
  const split = plan.shots.reduce((n, s) => n + Object.keys(s.sfxStems ?? {}).length, 0);
  console.log(`\n[sink] edit-plan.json: ${plan.shots.length}/${all} shots on disk, ${prox} proxies, ${sfx} sfx mixes (+${split} split stems), ${alts} time-of-day alternates`);
}

/** shot id -> { proc, frames } — one long-lived ffmpeg per shot */
const encoders = new Map();
let fps = Number(arg('fps', '24'));
let started = 0;

/**
 * Open an encoder for a shot. Backpressure is REAL here: an 8 MB frame every
 * few seconds is nothing, but ffmpeg's stdin can still fill, and ignoring
 * `write()`'s return value would silently drop frames rather than slow the
 * page down. Every write is awaited by the request handler, so a slow encoder
 * throttles the render instead of corrupting it.
 */
function openEncoder(shot, w, h) {
  const file = EDIT === null ? join(OUT, 'seg', `${shot}.${SEG_EXT}`) : join(OUT, 'video', `${shot}.mov`);
  if (EDIT !== null && existsSync(file)) console.warn(`\n[sink] OVERWRITING ${file} — pass a new take to keep it`);
  // .part until it closes cleanly. An mp4 only becomes playable when ffmpeg
  // writes its `moov` atom at the END, so a file that is still being written —
  // or whose encoder was killed — is a normal-looking mp4 that no player will
  // open. Naming it `.part` makes "not finished" visible in `ls` instead of
  // only in QuickTime's error dialog.
  const part = `${file}.part`;
  // the edit master: ProRes 422 HQ (profile 3), 10-bit 4:2:2, a constant frame rate
  // --codec prores (lanes): the same HQ 422 10-bit, on the hardware ProRes engine instead of the CPU
  const codec = EDIT !== null
    ? ['-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le']
    : CODEC === 'prores'
      ? ['-c:v', 'prores_videotoolbox', '-profile:v', 'hq', '-pix_fmt', 'p210le']
      : ['-c:v', 'libx264', '-preset', PRESET, '-crf', CRF, '-pix_fmt', 'yuv420p', ...(THREADS !== null ? ['-threads', THREADS] : [])];
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
      '-f', EDIT === null ? SEG_EXT : 'mov',
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
  // tail / queued / room: the --queue path (enqueueFrame); with --queue 0 the tail stays resolved
  const rec = { proc, file, part, frames: 0, w, h, failed: null, closing: null, exited: false, tail: Promise.resolve(), queued: 0, room: [] };
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
  // remembered for closeEncoder: an encoder that died mid-shot has ALREADY emitted 'close', and waiting for it again
  // hung the shot's /endshot (and the page awaiting it) forever
  proc.on('close', (code) => {
    rec.closeCode = code;
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
 * --queue N: the frame is answered once it is QUEUED, and the page waits only when N frames are already waiting for
 * ffmpeg — a slow encode then still throttles the render (bounded memory: N × w×h×4 bytes per encoder) but no longer
 * stalls it frame by frame. Writes stay in arrival order on one chain; a failed write fails every later frame and the
 * shot's /endshot. --queue 0 is writeFrame itself.
 */
function enqueueFrame(rec, buf) {
  if (QUEUE === 0) return writeFrame(rec, buf);
  if (rec.failed !== null) return Promise.reject(rec.failed);
  rec.queued++;
  rec.tail = rec.tail
    .then(() => (rec.failed === null ? writeFrame(rec, buf) : undefined))
    .catch((e) => {
      if (rec.failed === null) rec.failed = e;
    })
    .finally(() => {
      rec.queued--;
      rec.room.shift()?.();
    });
  if (rec.queued <= QUEUE) return Promise.resolve();
  return new Promise((res) => rec.room.push(res)).then(() => {
    if (rec.failed !== null) throw rec.failed;
  });
}

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
/**
 * FAIL LOUD ON A BROKEN TAKE (a take cut short by a stalled page, a killed session or a failed shot looked exactly like
 * a valid clip: 48 frames of the default scene, then black, as `…_take80.mov`). `verdict` null = a complete take;
 * otherwise the clip is written as `<name>_FAILED.mov` with a `.why.txt` beside it, gets no proxy and no settings key,
 * and never matches the edit plan's names.
 */
function closeEncoder(name, verdict = null) {
  const rec = encoders.get(name);
  if (rec === undefined) return Promise.resolve();
  if (rec.closing !== null) return rec.closing;
  // --queue: every queued frame reaches ffmpeg before its stdin closes (a no-op tail without it)
  rec.closing = rec.tail.then(() => new Promise((res) => {
    const onClose = (code) => {
      if (code === 0 && existsSync(rec.part) && verdict !== null) {
        const bad = rec.file.replace(/\.(mov|mp4)$/, '_FAILED.$1');
        renameSync(rec.part, bad);
        writeFileSync(`${bad}.why.txt`, `${verdict}\n`);
        console.error(`\n[sink] ${name}: BROKEN TAKE (${verdict}) — ${rec.frames} frames -> ${bad}`);
      } else if (code === 0 && existsSync(rec.part)) {
        renameSync(rec.part, rec.file);
        console.log(`\n[sink] ${name}: ${rec.frames} frames -> ${rec.file}`);
        // NOT awaited: a 4K transcode would hold the next shot's first frame long enough to trip the stall watchdog
        if (EDIT !== null) void makeProxy(name, rec.file);
      } else {
        console.error(`\n[sink] ${name}: ffmpeg exited ${code} — left ${rec.part}`);
      }
      res();
    };
    if (rec.closeCode !== undefined) onClose(rec.closeCode);
    else rec.proc.on('close', onClose);
    rec.proc.stdin.end();
  }));
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
      // `group`: the clips of ONE take drawn interleaved (the trailer's time-of-day looks, src/cine/recorder.ts `looks`)
      // share one; a frame of another group means the previous take is done. Without it every look clip closed the
      // other looks' encoders and each variant came out one frame long.
      const group = url.searchParams.get('group') ?? shot;
      let rec = encoders.get(shot);
      if (rec === undefined) {
        // a new shot means the previous one is done — close it now rather than
        // holding every encoder of the run open to the end
        const done = [...encoders.entries()].filter(([, r]) => r.group !== group).map(([k]) => k);
        await Promise.all(done.map((k) => closeEncoder(k, 'a new take started before this one ended')));
        for (const k of done) encoders.delete(k);
        rec = openEncoder(shot, w, h);
        rec.group = group;
      }
      await enqueueFrame(rec, body);
      rec.frames++;
      if (rec.frames % 24 === 0) process.stdout.write('.');
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === '/endshot') {
      const clip = url.searchParams.get('clip');
      if (!clip) throw new Error('endshot needs ?clip=');
      const rec = encoders.get(clip);
      // the page says how many frames the take has; anything else is a broken take
      const expected = Number(url.searchParams.get('frames'));
      const failed = url.searchParams.get('failed');
      // --queue: frames were answered before ffmpeg took them, so a write that failed later surfaces here
      if (rec !== undefined) await rec.tail;
      const verdict = failed
        ? `the page failed the take: ${failed}`
        : rec !== undefined && rec.failed !== null
          ? `the encoder failed: ${rec.failed.message ?? rec.failed}`
          : rec !== undefined && Number.isFinite(expected) && expected > 0 && rec.frames !== expected
          ? `${rec.frames} frames written, ${expected} expected`
          : null;
      await closeEncoder(clip, verdict);
      encoders.delete(clip);
      // RESUMABLE RECORDS: the settings key the page rendered this clip with, beside the master (see /have)
      const key = url.searchParams.get('key');
      if (key && verdict === null && rec !== undefined && existsSync(rec.file)) writeFileSync(`${rec.file}.key`, key);
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === '/have') {
      // a record with `resume` skips a clip whose master is on disk AND was rendered with the same settings key
      const clip = url.searchParams.get('clip') ?? '';
      const key = url.searchParams.get('key') ?? '';
      const file = EDIT === null ? join(OUT, 'seg', `${clip}.${SEG_EXT}`) : join(OUT, 'video', `${clip}.mov`);
      const have = existsSync(file) && existsSync(`${file}.key`) && readFileSync(`${file}.key`, 'utf8') === key;
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }).end(JSON.stringify({ have }));
      return;
    }
    if (url.pathname === '/audio') {
      // the audio pass is a SEPARATE, real-time run (src/cine/audio.ts), so it
      // lands beside the clip rather than inside it; cine-mux pairs them.
      // LOSSLESS: float PCM from the page's AudioWorklet tap, written once as 24-bit WAV (no lossy codec in between)
      const clip = url.searchParams.get('clip');
      const stem = url.searchParams.get('stem') ?? 'mix';
      const rate = Number(url.searchParams.get('rate'));
      if (!clip) throw new Error('audio needs ?clip=');
      if (url.searchParams.get('fmt') !== 'f32' || !(rate > 0)) throw new Error('audio needs ?fmt=f32&rate= (interleaved stereo float32 PCM)');
      if (!/^(mix|engine|water|amb)$/.test(stem)) throw new Error(`audio: unknown stem '${stem}'`);
      const body = await readBody(req);
      const name = stem === 'mix' ? clip : `${clip}_${stem}`;
      const dir = EDIT !== null ? join(OUT, 'sfx') : join(OUT, 'seg');
      const src = join(dir, `${name}.f32.src`);
      const wav = join(dir, `${name}.wav`);
      writeFileSync(src, body);
      // a WAV the length of the video clip EXACTLY (edit delivery): the page already cut the take at the head's sample,
      // this only guards the last few samples of rounding; resampled to 48 kHz if the context ran at another rate
      const dur = Number(url.searchParams.get('dur'));
      if (EDIT !== null && !(dur > 0)) throw new Error('edit delivery: audio needs ?dur= (the clip length, s)');
      const trim = dur > 0 ? ['-af', `apad,atrim=end_sample=${Math.round(dur * 48000)}`] : [];
      const code = await ffmpeg(['-f', 'f32le', '-ar', String(rate), '-ac', '2', '-i', src, '-ar', '48000', ...trim, '-c:a', 'pcm_s24le', wav]);
      unlinkSync(src);
      if (code !== 0) throw new Error(`audio ${name}: ffmpeg exited ${code}`);
      console.log(`\n[sink] sfx ${name} -> ${wav} (${dur > 0 ? dur.toFixed(3) + ' s' : (body.length / 8 / rate).toFixed(3) + ' s'})`);
      if (EDIT !== null) writePlan();
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
    console.log(`\n[sink] ${sig} — finalising ${encoders.size} unfinished clip(s) as FAILED…`);
    // a clip still open at shutdown never got its /endshot: it is partial by definition
    void Promise.all([...encoders.keys()].map((k) => closeEncoder(k, `interrupted (${sig}) before the take ended`))).then(() => process.exit(0));
  });
}

server.listen(PORT, '127.0.0.1', () => {
  // the bound port, not PORT: `--port 0` lets the OS pick (scripts/drift-render.mjs reads this line)
  console.log(`[sink] listening on http://127.0.0.1:${server.address().port} -> ${OUT}`);
});
