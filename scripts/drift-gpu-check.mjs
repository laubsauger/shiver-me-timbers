#!/usr/bin/env node
/**
 * RENDER-NODE SELF-TEST (docs/drift/RENDER-NODE.md): is this machine able to render The Drift, on its GPU, right?
 *
 *   node scripts/drift-gpu-check.mjs                 everything below, prints PASS / WARN / FAIL with the fix
 *   node scripts/drift-gpu-check.mjs --variants      only the browser: try each GPU flag set of this platform
 *        [--save]                                    (scripts/drift-chrome.mjs) and keep the first that gets the GPU
 *   options: --channel chrome · --port 5291 · --t 40,150,600 (show times to draw) · --size 256 · --no-render
 *            --no-slot (skip the machine's render slots, scripts/drift-slot.mjs: by default the check waits for one)
 *            --requests <file.json> (every public file the page fetched) · --save-ref (this machine's frames
 *            become scripts/drift-gpu-check.ref.json, the frames other machines are compared with)
 *
 * It launches exactly the Chrome the renderer launches (scripts/drift-chrome.mjs), asks it for the WebGPU adapter
 * the way src/core/app.ts does (no power preference; the limits and every feature three asks for), then boots
 * drift.html on a Vite server of its own and draws one small frame at each --t through the renderer's own path:
 * __drift.record() → raw RGBA → scripts/cine-sink.mjs → ffmpeg, an 8-bit x264 clip and (when the GPU has
 * texture-formats-tier1) a 16-bit FFV1 one. A frame passes when it is one frame, not black and not flat; the 16-bit
 * frame must match the 8-bit one; and when a reference exists, each frame is compared with the frame the Mac drew
 * (a broken shader on another GPU backend draws WRONG frames, not black ones — the renderer cannot see that).
 * Asset requests that 404 (or get Vite's HTML fallback) fail it: that is an incomplete asset bundle.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { cpus, freemem, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { GPU_ARG_VARIANTS, NODE_CHROME_FILE, chromeLaunchOptions, gpuArgs } from './drift-chrome.mjs';
import { hasEncoder, laneEncoder } from './cine-codecs.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);
const CHANNEL = arg('channel', 'chrome');
const PORT = Number(arg('port', '5291'));
const TIMES = arg('t', '40,150,600').split(',').map(Number);
const SIZE = Number(arg('size', '256'));
const OUT = join(ROOT, 'out/drift/gpu-check');
const REF = join(ROOT, 'scripts/drift-gpu-check.ref.json');
const MAC = process.platform === 'darwin';

// ------------------------------------------------------------------------------------------------ the report
const results = [];
const note = (status, what, detail = '', fix = '') => {
  results.push({ status, what, detail, fix });
  const tag = { PASS: 'PASS', WARN: 'WARN', FAIL: 'FAIL', INFO: '    ' }[status];
  console.log(`[${tag}] ${what}${detail ? ` — ${detail}` : ''}`);
  if (fix && status !== 'PASS' && status !== 'INFO') console.log(`       fix: ${fix}`);
};
const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: opts.binary ? 'buffer' : 'utf8', timeout: opts.timeout ?? 60_000, maxBuffer: 1 << 26, ...opts });
  return { ok: r.status === 0, out: r.stdout ?? '', err: String(r.stderr ?? r.error?.message ?? '') };
};
const gb = (b) => `${(b / 2 ** 30).toFixed(1)} GB`;

// --------------------------------------------------------------------------------------------- the machine
function checkMachine() {
  console.log(`\n== machine: ${process.platform} ${process.arch}, ${cpus().length} threads, ${gb(totalmem())} RAM (${gb(freemem())} free)`);
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) note('FAIL', `Node ${process.versions.node}`, 'Vite 6 needs Node 20+', 'install Node 24 LTS (the Mac renders on 24.x)');
  else note(major === 24 ? 'PASS' : 'WARN', `Node ${process.versions.node}`, major === 24 ? '' : 'the Mac runs Node 24; others should work', 'Node 24 LTS');
  if (!existsSync(join(ROOT, 'node_modules/playwright')) || !existsSync(join(ROOT, 'node_modules/vite'))) note('FAIL', 'node_modules', 'playwright / vite missing', 'npm ci');

  const v = sh('ffmpeg', ['-hide_banner', '-version']);
  if (!v.ok) {
    note('FAIL', 'ffmpeg', 'not found on PATH', 'install ffmpeg (RENDER-NODE.md §Prerequisites) and open a new shell');
  } else {
    note('PASS', 'ffmpeg', v.out.split('\n')[0]);
    if (!sh('ffprobe', ['-version']).ok) note('FAIL', 'ffprobe', 'not found next to ffmpeg', 'install the full ffmpeg package (it ships ffprobe)');
    const enc = sh('ffmpeg', ['-hide_banner', '-encoders']).out;
    for (const [codec, why, must] of [
      ['x264', 'previews (.mp4)', true],
      ['proreshq', 'ProRes 422 HQ / 4444 masters', true],
      ['ffv1', 'the 12-bit master intermediate', true],
      ['hevc10', 'NVENC HEVC 10-bit previews', false],
    ]) {
      const name = laneEncoder(codec);
      if (hasEncoder(enc, name)) note('PASS', `encoder ${name}`, `--codec ${codec}: ${why}`);
      else note(must ? 'FAIL' : MAC ? 'INFO' : 'WARN', `encoder ${name}`, `missing — --codec ${codec} (${why}) will not run`, 'a full ffmpeg build (gyan.dev "full" or BtbN "gpl" on Windows, BtbN linux64-gpl or apt on Linux)');
    }
    // NVENC listed is not NVENC working: the encoder loads the driver's libnvidia-encode at the first frame
    if (hasEncoder(enc, 'hevc_nvenc')) {
      const t = sh('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=256x256:d=0.2', '-c:v', 'hevc_nvenc', '-profile:v', 'main10', '-pix_fmt', 'p010le', '-f', 'null', '-']);
      note(t.ok ? 'PASS' : 'WARN', 'hevc_nvenc test encode', t.ok ? 'Main10 works' : t.err.trim().split('\n').slice(-2).join(' '), 'the NVIDIA driver\'s encode library (Ubuntu: libnvidia-encode-<driver>) must match the driver');
    }
  }

  const dir = join(ROOT, 'out/drift');
  mkdirSync(dir, { recursive: true });
  const st = statfsSync(dir);
  const free = st.bavail * st.bsize;
  // an 8K ProRes 4444 film is ~28 MiB a frame: 24k frames ≈ 0.7 TB; FFV1 12-bit ~2.5× that
  // (FAIL only where nothing can render: drift-render keeps 20 GB free whatever the job)
  note(free > 500 * 2 ** 30 ? 'PASS' : free > 25 * 2 ** 30 ? 'WARN' : 'FAIL', 'disk under out/drift', `${gb(free)} free`, 'an 8K master needs hundreds of GB: render to a big disk (a job\'s "out", or out/drift on a big volume)');

  if (!MAC) {
    const smi = sh('nvidia-smi', ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader']);
    if (smi.ok) note('INFO', 'nvidia-smi', smi.out.trim().replace(/\n/g, ' | '));
    else note('WARN', 'nvidia-smi', 'not found', 'install the NVIDIA driver (RENDER-NODE.md §NVIDIA driver)');
  }
  if (process.platform === 'linux') {
    const vk = sh('vulkaninfo', ['--summary']);
    if (vk.ok) {
      const lines = vk.out.split('\n').filter((l) => /deviceName|driverVersion|apiVersion|deviceType/.test(l)).map((l) => l.trim());
      note(vk.out.includes('NVIDIA') ? 'PASS' : 'WARN', 'vulkaninfo', lines.slice(0, 8).join(' · '), 'the NVIDIA Vulkan ICD (/usr/share/vulkan/icd.d/nvidia_icd.json) comes with the driver\'s GL package (libnvidia-gl-<driver>)');
    } else note('WARN', 'vulkaninfo', 'not installed (only diagnostics)', 'sudo apt install vulkan-tools');
  }

  // the asset bundle: the page cannot boot without these (drift-bundle.mjs --verify checks every file)
  const need = ['earth', 'web', 'galaxies', 'flock', 'clouds', 'pbr/packed', 'pbr/blenderkit'].filter((d) => !existsSync(join(ROOT, 'public/drift', d)));
  if (need.length > 0) note('FAIL', 'asset bundle', `public/drift/{${need.join(',')}} missing`, 'unpack drift-assets-*.tar.gz in the repo root, then node scripts/drift-bundle.mjs --verify');
  else if (!existsSync(join(ROOT, 'out/drift-bundle/manifest-assets.json'))) note('WARN', 'asset bundle', 'public/drift is there but no bundle manifest to verify it against', 'node scripts/drift-bundle.mjs --verify after unpacking a bundle');
  else note('PASS', 'asset bundle', 'present (node scripts/drift-bundle.mjs --verify checks every file)');
}

// ------------------------------------------------------------------------------------------------ the adapter
/** the adapter as app.ts gets it (no power preference), and with each preference, and a device with its limits */
const PROBE = async () => {
  const keys = ['maxTextureDimension2D', 'maxBufferSize', 'maxStorageBufferBindingSize', 'maxSampledTexturesPerShaderStage', 'maxSamplersPerShaderStage',
    'maxStorageTexturesPerShaderStage', 'maxUniformBuffersPerShaderStage', 'maxColorAttachmentBytesPerSample', 'maxComputeWorkgroupStorageSize'];
  const one = async (opts) => {
    // (asked again for up to 6 s: on Linux the GPU process brings Vulkan up ~2 s after launch, and an adapter asked
    // for before that is null — src/core/gate.ts, linux-monster 2026-10-30)
    let a = await navigator.gpu?.requestAdapter(opts);
    for (let i = 0; !a && navigator.gpu && i < 12; i++) {
      await new Promise((r) => setTimeout(r, 500));
      a = await navigator.gpu.requestAdapter(opts);
    }
    if (!a) return null;
    const i = a.info ?? {};
    const limits = Object.fromEntries(keys.map((k) => [k, a.limits[k]]));
    // the device three asks for (app.ts requiredLimits; three requests every feature the adapter has)
    let device = 'ok';
    try {
      const req = ['maxSampledTexturesPerShaderStage', 'maxSamplersPerShaderStage', 'maxStorageTexturesPerShaderStage', 'maxUniformBuffersPerShaderStage', 'maxTextureDimension2D', 'maxBufferSize'];
      const d = await a.requestDevice({ requiredFeatures: [...a.features], requiredLimits: Object.fromEntries(req.map((k) => [k, a.limits[k]])) });
      d.destroy();
    } catch (e) {
      device = String(e);
    }
    return { vendor: i.vendor, architecture: i.architecture, device: i.device, description: i.description, fallback: i.isFallbackAdapter === true, features: [...a.features].sort(), limits, requestDevice: device };
  };
  return { ua: navigator.userAgent, hasGpu: 'gpu' in navigator, def: await one(undefined), high: await one({ powerPreference: 'high-performance' }), low: await one({ powerPreference: 'low-power' }) };
};

const software = (a) => a === null || a.fallback || /swiftshader|llvmpipe|lavapipe|microsoft basic/i.test(`${a.vendor} ${a.architecture} ${a.description}`);
const name = (a) => (a === null ? 'none' : `${a.vendor}/${a.architecture}${a.description ? ` (${a.description})` : ''}${a.fallback ? ' FALLBACK' : ''}`);

/** a blank page on 127.0.0.1 (a secure context: WebGPU exists there, not on about:blank) */
function blankServer() {
  return new Promise((res) => {
    const s = createServer((_, r) => r.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>gpu probe</title>'));
    s.listen(0, '127.0.0.1', () => res({ server: s, url: `http://127.0.0.1:${s.address().port}/` }));
  });
}

async function probeAdapter(gpu, withChromeGpu) {
  const { server, url } = await blankServer();
  const browser = await chromium.launch(chromeLaunchOptions(CHANNEL, gpu));
  try {
    const page = await browser.newPage();
    await page.goto(url);
    const p = await page.evaluate(PROBE);
    p.version = browser.version();
    if (withChromeGpu) {
      // chrome://gpu: which backend Dawn is on (Metal / Vulkan / D3D12) and the "WebGPU: Hardware accelerated" line
      try {
        const g = await browser.newPage();
        await g.goto('chrome://gpu', { timeout: 15_000 });
        await g.waitForTimeout(2500);
        const text = await g.evaluate(() => document.body.innerText);
        p.chromeGpu = [...new Set(text.split('\n').map((l) => l.trim()).filter((l) => /^WebGPU:|backend -|GL_RENDERER|^Vulkan:|Dawn/.test(l)))].slice(0, 12);
      } catch (e) {
        p.chromeGpu = [`(chrome://gpu not readable: ${String(e).split('\n')[0]})`];
      }
    }
    return p;
  } finally {
    await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 8000))]);
    server.close();
  }
}

/** a master's limits from the adapter's: record.ts faceSizeFor (0.55 × size × ss, to 16) and the readback buffer */
function masterLimits(L) {
  const bySize = (ss) => Math.floor(L.maxTextureDimension2D / 0.55 / ss / 16) * 16;
  const byBuf = (bpp) => Math.floor(Math.sqrt(L.maxBufferSize / bpp) / 64) * 64;
  return { ss1: Math.min(bySize(1), byBuf(8)), ss2: Math.min(bySize(2), byBuf(8)), read8: byBuf(4), read16: byBuf(8) };
}

function judgeAdapter(p) {
  console.log(`\n== browser: ${CHANNEL} ${p.version ?? ''}, GPU flags (${gpuArgs().from}): ${gpuArgs().args.join(' ') || '(none)'}`);
  if (!p.hasGpu) return note('FAIL', 'navigator.gpu', 'no WebGPU in this browser', 'Chrome 113+ (google-chrome-stable); on Linux the flags in scripts/drift-chrome.mjs');
  if (p.def === null) return note('FAIL', 'WebGPU adapter', 'requestAdapter() returned null', 'node scripts/drift-gpu-check.mjs --variants --save (tries the other flag sets); check the driver (nvidia-smi, vulkaninfo)');
  note(software(p.def) ? 'FAIL' : 'PASS', 'adapter (as the page asks for it)', name(p.def), 'software rendering: the GPU path is broken — driver, Vulkan ICD, or try --variants');
  if (!MAC && p.def.vendor !== 'nvidia') note('WARN', 'adapter vendor', `${p.def.vendor}, not nvidia`, 'expected the RTX 4090: connect the display to it / disable the iGPU, or try --variants (Windows: --use-webgpu-power-preference)');
  if (p.high && name(p.high) !== name(p.def)) note('FAIL', 'adapter choice', `the page gets ${name(p.def)}, the high-performance one is ${name(p.high)}`, 'Windows: Settings > Display > Graphics: Chrome on "High performance", or --variants --save; Linux: the iGPU off in the BIOS');
  for (const l of p.chromeGpu ?? []) note('INFO', 'chrome://gpu', l);
  const L = p.def.limits;
  const m = masterLimits(L);
  note('INFO', 'limits', Object.entries(L).map(([k, v]) => `${k.replace(/^max/, '')} ${v}`).join(', '));
  note(m.ss2 >= 8192 ? 'PASS' : m.ss1 >= 8192 ? 'WARN' : 'FAIL', 'master size', `up to ${m.ss1}² at ss 1, ${m.ss2}² at ss 2 (16-bit readback up to ${m.read16}²)`, 'the GPU\'s maxTextureDimension2D / maxBufferSize limit the master: lower --size or --ss');
  // the sea's material samples far past WebGPU's default 16 textures per stage (app.ts): the Mac's M3 gives 48 (Metal)
  note(L.maxSampledTexturesPerShaderStage >= 32 ? 'PASS' : 'WARN', 'sampled textures per stage', String(L.maxSampledTexturesPerShaderStage), 'below 32 the ocean material may fail to build: watch the frame check below');
  const f = new Set(p.def.features);
  note(f.has('texture-formats-tier1') ? 'PASS' : 'FAIL', 'feature texture-formats-tier1', f.has('texture-formats-tier1') ? '16-bit capture (rgba16unorm) works' : 'no 16-bit capture: no 10/12-bit masters (--depth 16)', 'a newer Chrome / driver');
  note(f.has('timestamp-query') ? 'PASS' : 'WARN', 'feature timestamp-query', f.has('timestamp-query') ? '' : 'GPU timing (perf HUD) only; renders do not need it');
  note('INFO', 'feature float32-filterable', f.has('float32-filterable') ? 'present' : 'absent (the project does not use it)');
  note(p.def.requestDevice === 'ok' ? 'PASS' : 'FAIL', 'requestDevice with the adapter\'s limits + every feature', p.def.requestDevice === 'ok' ? '' : p.def.requestDevice, 'a driver that cannot give its own reported limits: update the driver');
  return null;
}

async function variants() {
  const list = GPU_ARG_VARIANTS[process.platform] ?? [[]];
  let pick = null;
  for (const gpu of list) {
    let p;
    try {
      p = await probeAdapter(gpu, false);
    } catch (e) {
      console.log(`  [${gpu.join(' ') || '(none)'}] launch failed: ${String(e).split('\n')[0]}`);
      continue;
    }
    const ok = !software(p.def) && (p.high === null || name(p.high) === name(p.def));
    console.log(`  [${gpu.join(' ') || '(none)'}] ${ok ? 'GPU' : 'no'}: ${name(p.def)}`);
    if (ok && pick === null) pick = gpu;
  }
  if (pick === null) {
    note('FAIL', 'GPU flags', 'no flag set gets a hardware adapter', 'the driver: nvidia-smi and (Linux) vulkaninfo must show the GPU; then DRIFT_HEADLESS=0 to try a visible window');
    return;
  }
  note('PASS', 'GPU flags', pick.join(' ') || '(none)');
  if (flag('save')) {
    mkdirSync(dirname(NODE_CHROME_FILE), { recursive: true });
    writeFileSync(NODE_CHROME_FILE, JSON.stringify({ args: pick, saved: new Date().toISOString(), chrome: CHANNEL }, null, 2));
    console.log(`  saved ${NODE_CHROME_FILE}: the renderer and this check now use these flags (delete the file to go back)`);
  } else console.log(`  use them: --save, or DRIFT_CHROME_ARGS="${pick.join(' ')}"`);
}

// ------------------------------------------------------------------------------------------------- the frames
function startSink(dir, codec) {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [join(ROOT, 'scripts/cine-sink.mjs'), '--out', dir, '--port', '0', '--fps', '30', '--codec', codec, '--crf', '12', '--preset', 'medium'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.stdout.on('data', (d) => {
      const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(String(d));
      if (m) res({ proc: p, url: m[1], err: () => err });
    });
    p.on('exit', (code) => rej(new Error(`sink (${codec}) exited ${code}: ${err}`)));
  });
}

/** a frame as 16×16 RGB (area-averaged), decoded by ffmpeg with the clip's own colour tags */
function thumb(file) {
  const r = sh('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=16:16:flags=area,format=rgb24', '-f', 'rawvideo', '-'], { binary: true });
  if (!r.ok || r.out.length !== 768) return null;
  return [...r.out];
}
const luma = (t) => Array.from({ length: 256 }, (_, i) => (t[3 * i] + t[3 * i + 1] + t[3 * i + 2]) / 3);
const rms = (a, b) => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0) / a.length);

async function frames(adapter) {
  console.log(`\n== frames: drift.html at t = ${TIMES.join(', ')} s, ${SIZE}², through record() → cine-sink → ffmpeg`);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const { createServer: createVite } = await import('vite');
  let vite = null;
  const sinks = [];
  let browser = null;
  try {
    let base = `http://localhost:${PORT}`;
    const ours = await fetch(`${base}/drift.html`).then((r) => r.text()).then((h) => h.includes('/src/main-drift.ts')).catch(() => false);
    if (!ours) {
      // as drift-render.mjs: no watcher, no HMR, a dep cache of its own
      vite = await createVite({ root: ROOT, clearScreen: false, logLevel: 'warn', cacheDir: join(ROOT, 'node_modules/.vite-drift-check'), server: { port: PORT, strictPort: true, hmr: false, watch: null } });
      await vite.listen();
      base = (vite.resolvedUrls?.local?.[0] ?? `${base}/`).replace(/\/$/, '');
    }
    const want16 = adapter?.features.includes('texture-formats-tier1') && hasEncoder(sh('ffmpeg', ['-hide_banner', '-encoders']).out, 'ffv1');
    const s8 = await startSink(join(OUT, 'x264'), 'x264');
    sinks.push(s8);
    const s16 = want16 ? await startSink(join(OUT, 'ffv1'), 'ffv1') : null;
    if (s16) sinks.push(s16);

    browser = await chromium.launch(chromeLaunchOptions(CHANNEL));
    const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
    const errors = [];
    const gpuErrors = [];
    const consoleErrors = new Set();
    const misses = new Set();
    const fetched = new Map();
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('crash', () => errors.push('the page crashed'));
    page.on('console', (m) => {
      const text = m.text();
      if (/\[gpu\] (uncaptured error|DEVICE LOST)/.test(text)) gpuErrors.push(text);
      else if (m.type() === 'error') consoleErrors.add(text.slice(0, 300));
    });
    // a file the bundle lacks: a 404, or (Vite's SPA fallback) index.html served as the asset
    page.on('response', async (r) => {
      const u = new URL(r.url());
      if (u.origin !== new URL(base).origin) return;
      const path = decodeURIComponent(u.pathname);
      if (!/^\/(drift|textures|assets)\//.test(path)) return;
      const html = (r.headers()['content-type'] ?? '').startsWith('text/html') && !path.endsWith('.html');
      if (r.status() >= 400 || html) misses.add(`${path} (${r.status()}${html ? ', HTML fallback' : ''})`);
      else if (existsSync(join(ROOT, 'public', path))) fetched.set(path, statSync(join(ROOT, 'public', path)).size);
    });
    // (only the page's own asset paths: Chrome reports the frame POSTs to the sink as aborted, and they are not)
    page.on('requestfailed', (r) => {
      const u = new URL(r.url());
      if (u.origin === new URL(base).origin && /^\/(drift|textures|assets)\//.test(u.pathname)) misses.add(`${decodeURIComponent(u.pathname)} (${r.failure()?.errorText})`);
    });

    const tBoot = Date.now();
    await page.goto(`${base}/drift.html?paused`);
    for (const until = Date.now() + 240_000; ; ) {
      // (with the files that came back missing or as Vite's HTML fallback: a boot that dies parsing one — "Unexpected
      // token '<'" from GLTFLoader on a .glb the bundle lacks, 2026-10-30 — names it)
      if (errors.length > 0) throw new Error(`drift.html failed to boot: ${errors.join('\n')}${misses.size ? ` — missing on this machine: ${[...misses].slice(0, 8).join(', ')} (sync the newest asset bundle)` : ''}`);
      const s = await page.evaluate(() => ({ ok: '__drift' in window, gate: document.body.innerText.includes('requires WebGPU') }));
      if (s.gate) throw new Error('drift.html shows its "requires WebGPU" gate: the page got no adapter');
      if (s.ok) break;
      if (Date.now() > until) throw new Error(`drift.html did not boot in 240 s${misses.size ? ` (missing assets: ${[...misses].slice(0, 5).join(', ')})` : ''}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    const total = await page.evaluate(() => window.__drift.total);
    note('PASS', 'drift.html boots', `${((Date.now() - tBoot) / 1000).toFixed(1)} s (every asset loaded); the show is ${total.toFixed(3)} s long (a job's "to")`);

    const ref = existsSync(REF) ? JSON.parse(readFileSync(REF, 'utf8')) : null;
    const thumbs = {};
    const take = async (t, sink, depth, shot) => {
      const t0 = Date.now();
      const n = await page.evaluate(async (o) => window.__drift.record(o), { size: SIZE, fps: 30, from: t, to: t + 1 / 30, shot, sink: sink.url, inFlight: 1, depth });
      return { n, secs: (Date.now() - t0) / 1000 };
    };
    for (const t of TIMES.filter((x) => x < total)) {
      const shot = `check_${t}`;
      const { n, secs } = await take(t, s8, 8, shot);
      const clip = join(OUT, 'x264/seg', `${shot}.mp4`);
      const frameCount = existsSync(clip) ? Number(sh('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=nb_frames', '-of', 'csv=p=0', clip]).out.trim()) : 0;
      const th = frameCount === 1 ? thumb(clip) : null;
      if (th === null) {
        note('FAIL', `frame t=${t}`, `${n} frame(s) recorded, clip ${existsSync(clip) ? `has ${frameCount}` : 'missing'}`, 'see the sink / console errors above');
        continue;
      }
      sh('ffmpeg', ['-v', 'error', '-y', '-i', clip, '-frames:v', '1', join(OUT, `frame_${t}.png`)]);
      const y = luma(th);
      const mean = y.reduce((a, b) => a + b, 0) / 256;
      const spread = Math.max(...y) - Math.min(...y);
      thumbs[t] = th;
      const black = mean < 2 || spread < 4;
      note(black ? 'FAIL' : 'PASS', `frame t=${t}`, `${secs.toFixed(1)} s, mean ${mean.toFixed(1)}/255, spread ${spread.toFixed(0)} → ${join(OUT, `frame_${t}.png`)}`, 'a black or flat frame: shaders failed to build or the readback is broken (console errors above)');
      const r = ref?.size === SIZE ? ref.frames?.[t] : undefined;
      if (r) {
        const d = rms(luma(th), luma(r));
        // another GPU and backend differ in the last bits (and other sessions change the scene): a big difference only
        note(d < 12 ? 'PASS' : 'WARN', `frame t=${t} vs the reference`, `RMS ${d.toFixed(1)}/255 against ${ref.machine} (${ref.created.slice(0, 10)}, commit ${ref.commit})`, 'look at the PNG beside the Mac\'s: a different picture is a shader that builds differently on this GPU (or the scene changed since the reference: --save-ref on the Mac)');
      }
    }
    if (s16) {
      const t = TIMES.filter((x) => x < total).at(-1);
      const shot = `check16_${t}`;
      const { secs } = await take(t, s16, 16, shot);
      const clip = join(OUT, 'ffv1/seg', `${shot}.mov`);
      const th = existsSync(clip) ? thumb(clip) : null;
      if (th === null || !thumbs[t]) note('FAIL', `16-bit frame t=${t}`, 'no clip', 'see the sink errors above');
      else {
        const d = rms(luma(th), luma(thumbs[t]));
        note(d < 4 ? 'PASS' : 'FAIL', `16-bit frame t=${t} (FFV1 12-bit)`, `${secs.toFixed(1)} s, RMS ${d.toFixed(2)}/255 against the 8-bit frame`, 'the 16-bit capture (src/cine/capture.ts Encoder16) draws a different picture on this GPU');
      }
    } else note('WARN', '16-bit frame', 'skipped (no texture-formats-tier1 or no ffv1 encoder)');

    if (gpuErrors.length > 0) note('FAIL', 'GPU errors', `${gpuErrors.length}: ${gpuErrors.slice(0, 3).join(' | ')}`, 'a pipeline that fails to build draws nothing: report the message (docs/drift/engine-findings.md)');
    else note('PASS', 'GPU errors', 'none (no uncaptured WebGPU error, no device loss)');
    if (consoleErrors.size > 0) note('WARN', 'console errors', [...consoleErrors].slice(0, 4).join(' | '));
    if (misses.size > 0) note('FAIL', 'assets', `${misses.size} missing: ${[...misses].slice(0, 10).join(', ')}`, 'unpack the newest asset bundle (node scripts/drift-bundle.mjs on the Mac builds it)');
    else note('PASS', 'assets', `${fetched.size} files fetched, none missing`);
    if (arg('requests', null)) {
      writeFileSync(resolve(arg('requests')), JSON.stringify([...fetched].sort().map(([path, bytes]) => ({ path: `public${path}`, bytes })), null, 1));
      console.log(`       requests -> ${resolve(arg('requests'))}`);
    }
    if (flag('save-ref')) {
      const commit = sh('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD']).out.trim() || 'unknown';
      const dirty = sh('git', ['-C', ROOT, 'status', '--porcelain', '--untracked-files=no']).out.trim() !== '';
      writeFileSync(REF, `${JSON.stringify({ created: new Date().toISOString(), commit: `${commit}${dirty ? '+dirty' : ''}`, machine: `${process.platform} ${adapter.vendor}/${adapter.architecture}`, size: SIZE, frames: thumbs })}\n`);
      console.log(`       reference -> ${REF}`);
    }
  } finally {
    await Promise.allSettled(sinks.map((s) => (s.proc.exitCode !== null ? null : new Promise((r) => (s.proc.once('exit', r), s.proc.kill('SIGTERM'))))));
    if (browser) await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 8000))]);
    if (vite) await Promise.race([vite.close(), new Promise((r) => setTimeout(r, 3000))]);
  }
}

// --------------------------------------------------------------------------------------------------- main
async function main() {
  if (flag('variants')) {
    console.log(`== GPU flag sets for ${process.platform} (scripts/drift-chrome.mjs), ${CHANNEL}`);
    await variants();
  } else {
    checkMachine();
    let p = null;
    try {
      p = await probeAdapter(gpuArgs().args, true);
      judgeAdapter(p);
    } catch (e) {
      note('FAIL', `launch ${CHANNEL}`, String(e).split('\n')[0], CHANNEL === 'chrome' ? 'install Google Chrome stable (RENDER-NODE.md §Prerequisites); Playwright finds it at its standard path' : '');
    }
    const usable = p?.def && !software(p.def);
    if (!flag('no-render') && usable) {
      try {
        await frames(p.def);
      } catch (e) {
        note('FAIL', 'frames', String(e).split('\n').slice(0, 4).join(' / '));
      }
    } else if (!flag('no-render')) note('FAIL', 'frames', 'skipped: no hardware adapter');
  }
  const fail = results.filter((r) => r.status === 'FAIL');
  const warn = results.filter((r) => r.status === 'WARN');
  console.log(`\n${fail.length === 0 ? 'PASS' : 'FAIL'}: ${results.filter((r) => r.status === 'PASS').length} passed, ${warn.length} warning(s), ${fail.length} failure(s)`);
  for (const r of fail) console.log(`  FAIL ${r.what}${r.fix ? ` — fix: ${r.fix}` : ''}`);
  process.exit(fail.length === 0 ? 0 : 1);
}

/**
 * THE MACHINE'S RENDER SLOTS (scripts/drift-slot.mjs; the user, 2026-10-29: "not more than two lanes of heavy
 * renderers", across every agent and person on the machine): the check is one browser job, so it runs inside one
 * slot — it starts itself again under drift-slot.mjs, which waits for a free slot and gives it back at the end.
 * (Not drift-render's .render.lock: a render queued meanwhile would fail on it instead of waiting.)
 */
const SLOT = join(ROOT, 'scripts/drift-slot.mjs');
if (process.env.DRIFT_SLOT_HELD !== '1' && existsSync(SLOT) && !flag('no-slot')) {
  const p = spawn(process.execPath, [SLOT, '--weight', '1', '--', process.execPath, fileURLToPath(import.meta.url), ...argv], { stdio: 'inherit', env: { ...process.env, DRIFT_SLOT_HELD: '1', DRIFT_FARM: '' } });
  // Ctrl-C reaches the whole process group: drift-slot passes it on and exits when the check has stopped
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {});
  p.on('exit', (code) => process.exit(code ?? 1));
} else {
  if (!existsSync(SLOT)) console.log(`(no ${SLOT}: running without the machine's render slots)`);
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
