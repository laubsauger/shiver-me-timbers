#!/usr/bin/env node
/**
 * THE STUDIO DASHBOARD: one small page that says what the machine and the agents are doing right now, and how long
 * it will take (the user, 2026-10-29: "a cute little dashboard thing for me, that doesn't take enough resources so I
 * can see what's going on … how long it's gonna take").
 *
 *   node scripts/drift-dash.mjs [--port 5190] [--host 127.0.0.1]     then open http://localhost:5190
 *
 * What it reads (nothing here starts or stops anything):
 *   - the render slots, out/drift/.slots/ (scripts/drift-slot.mjs): who holds each, who waits (`wait-<pid>`), and the
 *     job's output copied to `<slot>.log` — a review clip's `[review] n/N  x fps` lines give its progress and ETA, a
 *     stills run's per-shot lines its count
 *   - the work streams, out/drift/dashboard/work.json: written by the coordinating session as agents start, render
 *     and finish (what each is on, its state, an estimate), and what waits on the user
 *   - the machine: load, memory free (`memory_pressure -Q`), GPU use (`ioreg` IOAccelerator, Apple silicon), power
 *     (`pmset -g batt`), the busiest processes
 *   - the newest review images and clips in the session scratchpad and out/drift, served read-only
 *   - THE STUDIO'S RENDER NODES (the user, 2026-10-29: "especially if we're thinking about multiple machines we need
 *     the dashboards to be able to see what's happening on those guys so that we are not losing touch in the depths
 *     of random detached terminal sessions"): each node (scripts/drift-node.mjs) POSTs a heartbeat to `/report` on
 *     this dashboard every few seconds while it syncs or renders; the page shows one card per node, offline when it
 *     has not been heard from for 90 s. The last report of each is kept in out/drift/dashboard/nodes.json across
 *     restarts. To be reachable from the nodes the dashboard also listens on the Mac's Tailscale address:
 *
 *       node scripts/drift-dash.mjs --tailnet          (localhost and `tailscale ip -4`; reports from 100.64.0.0/10)
 *
 * THE /report CONTRACT (JSON, at most 64 KB; only `node` is required):
 *   { node: "win-4090", os: "win32", commit: "abc1234", bundle: "20261029",
 *     state: "idle" | "syncing" | "rendering" | "failed" | "done",
 *     gpu: { name, utilPct, memUsedGB, memTotalGB }, cpuLoadPct, power: "AC" | "battery 80%",
 *     job: { name, chunk, chunks, frames, framesTotal, fps, etaS, out }, last: "<the newest log line>", error: "…" }
 *
 * LIGHT ON PURPOSE: built-ins only, one request every 3 s from the page (none while its tab is hidden), the system
 * probes cached for 2.5 s whoever asks, thumbnails replaced only when the list changes. It listens on localhost
 * unless `--host` says otherwise; the files it serves are limited to images and videos under the roots below.
 */
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readFileSync, readdirSync, statSync, createReadStream, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve, extname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus, loadavg, freemem, totalmem, platform } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PORT = Number(arg('port', 5190));
const HOST = arg('host', '127.0.0.1');
const TAILNET = argv.includes('--tailnet');
const NODES_FILE = join(ROOT, 'out/drift/dashboard/nodes.json');
const SLOTS = process.env.DRIFT_SLOTS_DIR ?? join(ROOT, 'out/drift/.slots');
const WORK = join(ROOT, 'out/drift/dashboard/work.json');
/** where review outputs land: the coordinating session's scratchpad (from work.json, else $DRIFT_SCRATCH) and out/drift */
const outputRoots = (work) => [work?.scratchpad ?? process.env.DRIFT_SCRATCH, join(ROOT, 'out/drift')].filter((p) => p && existsSync(p)).map((p) => resolve(p));
const MEDIA = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4' };

const sh = (cmd, args) =>
  new Promise((res) => execFile(cmd, args, { timeout: 4000, maxBuffer: 1 << 20 }, (e, out) => res(e ? '' : String(out))));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return undefined;
  }
};

/** a job's command in a few words: what kind, and the span or shot file it renders */
function label(cmd) {
  const o = (k) => cmd.match(new RegExp(`--${k}\\s+(\\S+)`))?.[1];
  const out = o('out');
  const at = out ? `  →  ${basename(out)}` : '';
  if (cmd.includes('drift-review-clip')) return `review clip ${o('from')}–${o('to')} s, ${o('width') ?? '?'} px${at}`;
  if (cmd.includes('drift-review-stills')) return `review stills (${basename(cmd.match(/(\S+\.json)/)?.[1] ?? '?')})${at}`;
  if (cmd.includes('drift-render')) return `render ${o('from') ?? ''}–${o('to') ?? ''} s ${o('size') ?? ''}${at}`;
  if (cmd.includes('drift-gpu-check')) return 'GPU check';
  if (cmd.includes('drift-stills')) return `stills${at}`;
  return cmd.split(' ').slice(0, 3).join(' ');
}

/** the shot count of a stills job's shot file, when it can be read */
function shotTotal(cmd) {
  const f = cmd.match(/(\S+\.json)/)?.[1];
  const shots = f && readJson(resolve(ROOT, f));
  return Array.isArray(shots) ? shots.length : Array.isArray(shots?.shots) ? shots.shots.length : undefined;
}

/** progress from a slot's log: frames n/N and fps (a clip), or shots done (stills) */
function progress(cmd, text, startedMs) {
  const lines = text.split('\n').filter(Boolean);
  const last = lines.at(-1) ?? '';
  const elapsed = (Date.now() - startedMs) / 1000;
  const frames = [...text.matchAll(/\[review\] (\d+)\/(\d+)\s+([\d.]+) fps/g)].at(-1);
  if (frames) {
    const [, n, N, fps] = frames.map(Number);
    return { done: n, total: N, unit: 'frames', etaS: fps > 0 ? (N - n) / fps : undefined, last };
  }
  const shots = [...text.matchAll(/\[review\] \S+\.(?:png|jpg)\s+t /g)].length;
  if (cmd.includes('stills')) {
    const total = shotTotal(cmd);
    const per = shots ? elapsed / shots : undefined;
    return { done: shots, total, unit: 'stills', etaS: per && total ? per * Math.max(0, total - shots) : undefined, last };
  }
  return { last };
}

function slots() {
  let limit = Number(process.env.DRIFT_SLOTS) || 2;
  try {
    limit = Number(readFileSync(join(SLOTS, 'limit'), 'utf8').trim()) || limit;
  } catch {
    // no limit file: the default
  }
  const held = [];
  const waiting = [];
  const recent = [];
  let files = [];
  try {
    files = readdirSync(SLOTS);
  } catch {
    // no slots dir yet
  }
  for (const f of files) {
    const p = join(SLOTS, f);
    try {
      if (f.endsWith('.slot')) {
        const [pid, ...what] = readFileSync(p, 'utf8').split('\n');
        if (!alive(Number(pid))) continue;
        const cmd = what.join(' ').trim();
        const started = statSync(p).mtimeMs;
        let log = '';
        try {
          log = readFileSync(p.replace(/\.slot$/, '.log'), 'utf8').slice(-20000);
        } catch {
          // a job started before logs existed
        }
        held.push({ slot: f.replace('.slot', ''), pid: Number(pid), label: label(cmd), cmd, started, ...progress(cmd, log, started) });
      } else if (f.startsWith('wait-')) {
        const pid = Number(f.slice(5));
        if (!alive(pid)) continue;
        const cmd = readFileSync(p, 'utf8');
        waiting.push({ pid, label: label(cmd), since: statSync(p).mtimeMs });
      } else if (f.endsWith('.log')) {
        const text = readFileSync(p, 'utf8');
        const exit = text.match(/exit (\S+)\s*$/)?.[1];
        if (exit !== undefined) recent.push({ label: label(text.split('\n')[0]), exit, ended: statSync(p).mtimeMs });
      }
    } catch {
      // taken or released while we looked
    }
  }
  return { limit, held: held.sort((a, b) => a.slot.localeCompare(b.slot)), waiting: waiting.sort((a, b) => a.since - b.since), recent };
}

/** the system probes, cached so several open tabs cost what one does */
let machineCache = { at: 0, value: undefined };
async function machine() {
  if (Date.now() - machineCache.at < 2500 && machineCache.value) return machineCache.value;
  // (macOS: ioreg's IOAccelerator for the Apple GPU, memory_pressure, pmset. Linux and Windows nodes running their
  // own dashboard: nvidia-smi for the card, the OS's free memory; no power probe there — drift-render has its own)
  const mac = platform() === 'darwin';
  const [gpu, mem, batt, ps, smi] = await Promise.all([
    mac ? sh('ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator']) : '',
    mac ? sh('memory_pressure', ['-Q']) : '',
    mac ? sh('pmset', ['-g', 'batt']) : '',
    platform() === 'win32' ? '' : sh('ps', ['-Ao', 'pid=,pcpu=,rss=,command=', '-r']),
    mac ? '' : sh('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used', '--format=csv,noheader,nounits']),
  ]);
  const num = (re, s) => (s.match(re) ? Number(s.match(re)[1]) : undefined);
  const [smiUtil, smiMem] = smi.split('\n')[0].split(',').map(Number);
  const top = ps
    .split('\n')
    .slice(0, 6)
    .map((l) => l.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map(([, pid, cpu, rss, cmd]) => ({ pid: Number(pid), cpu: Number(cpu), memMB: Math.round(Number(rss) / 1024), name: procName(cmd) }));
  const headless = ps.split('\n').filter((l) => /Chrome|chrome/.test(l) && l.includes('--headless') && l.includes('--type=gpu-process')).length;
  machineCache = {
    at: Date.now(),
    value: {
      cores: cpus().length,
      load: loadavg().map((x) => Math.round(x * 10) / 10),
      memFreePct: mac ? num(/free percentage: (\d+)%/, mem) : Math.round((100 * freemem()) / totalmem()),
      gpuPct: mac ? num(/"Device Utilization %"=(\d+)/, gpu) : Number.isFinite(smiUtil) ? smiUtil : undefined,
      gpuMemGB: mac
        ? num(/"In use system memory"=(\d+)/, gpu) !== undefined ? Math.round(num(/"In use system memory"=(\d+)/, gpu) / 2 ** 27) / 8 : undefined
        : Number.isFinite(smiMem) ? Math.round(smiMem / 102.4) / 10 : undefined,
      power: !mac ? '' : batt.includes("'AC Power'") ? 'AC' : `battery ${num(/(\d+)%/, batt) ?? '?'}%`,
      headlessPages: headless,
      top,
    },
  };
  return machineCache.value;
}
function procName(cmd) {
  if (cmd.includes('shaderloom')) return 'Loom MCP server';
  if (cmd.includes('--headless') && cmd.includes('gpu-process')) return 'headless Chrome GPU (render)';
  if (cmd.includes('--headless')) return 'headless Chrome (render)';
  if (cmd.includes('drift-review') || cmd.includes('drift-render')) return basename(cmd.split(' ').find((w) => w.includes('drift-')) ?? 'drift');
  if (cmd.includes('vite')) return 'Vite dev server';
  if (cmd.includes('tsc')) return 'typecheck (tsc)';
  if (cmd.includes('vitest')) return 'tests (vitest)';
  if (cmd.includes('Claude Helper') || cmd.includes('Claude.app')) return 'Claude app';
  if (cmd.includes('WindowServer')) return 'WindowServer';
  if (cmd.includes('Google Chrome')) return 'Google Chrome (yours)';
  return basename(cmd.split(' ')[0]);
}

/** the newest review images and clips, newest first (a shallow walk, cached) */
let outCache = { at: 0, value: [] };
function outputs(work) {
  if (Date.now() - outCache.at < 10000) return outCache.value;
  const found = [];
  const walk = (dir, depth) => {
    let ents = [];
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 3 && !/^(frames|clipall|chunks|raw|tiles|node_modules)$/.test(e.name)) walk(p, depth + 1);
      } else if (MEDIA[extname(e.name).toLowerCase()] && !/^(f_?|frame_?)?\d+\.(png|jpg)$/i.test(e.name)) {
        // (numbered frame dumps — a clip's frames pulled out to look at — are not outputs)
        try {
          found.push({ path: p, mtime: statSync(p).mtimeMs });
        } catch {
          // gone
        }
      }
    }
  };
  for (const r of outputRoots(work)) walk(r, 0);
  found.sort((a, b) => b.mtime - a.mtime);
  // at most three from one folder, so one busy round does not hide every other stream's newest
  const perDir = new Map();
  const pick = found.filter((f) => {
    const n = (perDir.get(dirname(f.path)) ?? 0) + 1;
    perDir.set(dirname(f.path), n);
    return n <= 3;
  });
  outCache = { at: Date.now(), value: pick.slice(0, 12).map((f) => ({ ...f, name: basename(f.path), dir: basename(dirname(f.path)), video: f.path.endsWith('.mp4') })) };
  return outCache.value;
}

/** the render nodes' last reports, by name (kept in a file so a restart still shows where each stood) */
const nodes = new Map(Object.entries(readJson(NODES_FILE) ?? {}).filter(([, r]) => Date.now() - (r.seen ?? 0) < 7 * 86400e3));
let nodesDirty = false;
setInterval(() => {
  if (!nodesDirty) return;
  nodesDirty = false;
  mkdirSync(dirname(NODES_FILE), { recursive: true });
  writeFileSync(NODES_FILE, JSON.stringify(Object.fromEntries(nodes)));
}, 10000).unref();
/** loopback, or a Tailscale address (100.64.0.0/10, fd7a:115c:a1e0::/48) */
const fromTailnet = (ip = '') => {
  const v4 = ip.replace(/^::ffff:/, '');
  if (v4 === '127.0.0.1' || ip === '::1') return true;
  const m = v4.match(/^100\.(\d+)\./);
  if (m && Number(m[1]) >= 64 && Number(m[1]) < 128) return true;
  return ip.toLowerCase().startsWith('fd7a:115c:a1e0:');
};

async function status() {
  const work = readJson(WORK);
  return { now: Date.now(), machine: await machine(), slots: slots(), work: work ?? { streams: [], waitingOnUser: [] }, outputs: outputs(work), nodes: [...nodes.values()].sort((a, b) => String(a.node).localeCompare(String(b.node))) };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/report' && req.method === 'POST') {
    if (!fromTailnet(req.socket.remoteAddress)) {
      res.writeHead(403).end();
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 65536) req.destroy();
    });
    req.on('end', () => {
      try {
        const r = JSON.parse(body);
        if (typeof r.node !== 'string' || !r.node) throw new Error('no node');
        nodes.set(r.node, { ...r, seen: Date.now(), from: req.socket.remoteAddress });
        nodesDirty = true;
        res.writeHead(204).end();
      } catch {
        res.writeHead(400).end();
      }
    });
    return;
  }
  if (url.pathname === '/api') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(await status()));
    return;
  }
  if (url.pathname === '/file') {
    const p = resolve(url.searchParams.get('p') ?? '');
    const type = MEDIA[extname(p).toLowerCase()];
    const ok = type && outputRoots(readJson(WORK)).some((r) => p.startsWith(r + sep)) && existsSync(p);
    if (!ok) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'max-age=3600' });
    createReadStream(p).pipe(res);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
server.listen(PORT, HOST, () => console.log(`[dash] http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${PORT}`));
if (TAILNET) {
  // a second listener on the Mac's Tailscale address, so the nodes can report and be looked at from the studio, and
  // nothing else on the LAN sees it. `tailscale ip -4` answers even while Tailscale is stopped, and the address is then
  // not on any interface: listening fails. So it retries each minute until it binds — starting Tailscale later is
  // enough, no restart — and never takes the localhost dashboard down with it
  let said = false;
  const bindTailnet = async () => {
    const ts = (await sh('tailscale', ['ip', '-4'])).trim().split('\n')[0];
    if (!/^100\./.test(ts)) return setTimeout(bindTailnet, 60000).unref();
    const t = createServer(server.listeners('request')[0]);
    t.once('error', (e) => {
      if (!said) console.error(`[dash] --tailnet: can't listen on ${ts} (${e.code}; is Tailscale connected?) — localhost only, retrying each minute`);
      said = true;
      setTimeout(bindTailnet, 60000).unref();
    });
    t.listen(PORT, ts, () => console.log(`[dash] http://${ts}:${PORT}  (tailnet: nodes report here)`));
  };
  bindTailnet();
}

const PAGE = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Drift Studio</title>
<style>
:root{--bg:#0e1416;--card:#162024;--line:#22323a;--ink:#e6efe9;--dim:#8aa29a;--sea:#3fb6a8;--sun:#f2b45c;--coral:#ef7a6a;--sand:#d9c49b;--ok:#7cc98a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif}
main{max-width:1100px;margin:0 auto;padding:16px}
header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:12px}
h1{font-size:20px;margin:0;letter-spacing:.02em}h1 .w{color:var(--sea)}
.sub{color:var(--dim);font-size:12px}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:var(--dim);margin:18px 0 8px}
.grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 12px}
.gauge .v{font-size:22px;font-weight:600}.gauge .k{color:var(--dim);font-size:12px}
.bar{height:6px;background:#0b1012;border-radius:4px;overflow:hidden;margin-top:6px}.bar i{display:block;height:100%;background:var(--sea);border-radius:4px;transition:width .6s}
.bar.warm i{background:var(--sun)}.bar.hot i{background:var(--coral)}
.slot{display:grid;gap:4px}.slot .t{font-weight:600}.slot .m{color:var(--dim);font-size:12px;font-family:ui-monospace,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.free{color:var(--dim);font-style:italic}
.stream{display:grid;grid-template-columns:auto 1fr auto;gap:4px 10px;align-items:start}
.pill{font-size:11px;padding:2px 8px;border-radius:99px;background:#22323a;color:var(--dim);white-space:nowrap}
.pill.rendering{background:#13403b;color:#8fe3d6}.pill.coding{background:#2c3550;color:#aebcf2}.pill.waiting{background:#463718;color:var(--sun)}
.pill.done{background:#1e3a24;color:var(--ok)}.pill.blocked{background:#4a2420;color:var(--coral)}.pill.queued{background:#3a2f1c;color:var(--sand)}
.stream .d{grid-column:2/4;color:var(--dim);font-size:13px}.stream .eta{color:var(--sand);font-size:12px;white-space:nowrap}
.list{display:grid;gap:8px}
ul.you{margin:0;padding-left:18px}ul.you li{margin:3px 0}
.thumbs{display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}
.thumbs a{display:block;color:var(--dim);font-size:11px;text-decoration:none;overflow:hidden}
.thumbs img{width:100%;aspect-ratio:16/10;object-fit:cover;border-radius:8px;border:1px solid var(--line);background:#0b1012}
.thumbs .vid{aspect-ratio:16/10;border-radius:8px;border:1px solid var(--line);display:grid;place-items:center;background:#0b1012;font-size:28px;color:var(--sea)}
.procs{font-size:12px;color:var(--dim);font-family:ui-monospace,monospace}.procs b{color:var(--ink);font-weight:500}
.nodes{grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}.node .t{display:flex;justify-content:space-between;gap:8px;font-weight:600}
.node .k{color:var(--dim);font-size:12px}.node.off{opacity:.55}.pill.idle{background:#22323a}.pill.syncing{background:#2c3550;color:#aebcf2}.pill.failed{background:#4a2420;color:var(--coral)}.pill.offline{background:#1a2226;color:#5d6f69}
.wave{display:inline-block;animation:bob 3s ease-in-out infinite}@keyframes bob{50%{transform:translateY(-2px)}}
@media (prefers-reduced-motion:reduce){.wave{animation:none}}
</style></head><body><main>
<header><h1><span class="wave">⛵</span> The Drift <span class="w">studio</span></h1><span class="sub" id="upd">connecting…</span></header>
<section class="grid" id="gauges"></section>
<h2>Render slots · this Mac</h2><section class="list" id="slots"></section>
<h2>Studio machines</h2><section class="grid nodes" id="nodes"></section>
<h2>Work streams</h2><section class="list" id="streams"></section>
<h2>Waiting on you</h2><section class="card" id="you"></section>
<h2>Latest outputs</h2><section class="thumbs" id="outs"></section>
<h2>Busiest processes</h2><section class="card procs" id="procs"></section>
</main><script>
const $=(id)=>document.getElementById(id);
const esc=(s)=>String(s??'').replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const dur=(s)=>{if(s==null||!isFinite(s))return'';s=Math.max(0,Math.round(s));const h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;return h?h+'h '+m+'m':m?m+'m '+String(x).padStart(2,'0')+'s':x+'s'};
const ago=(ms,now)=>dur((now-ms)/1000);
// (a load bar warms as it fills; a GPU or progress bar is plain: a busy GPU is the point)
const bar=(pct,plain)=>'<div class="bar '+(plain?'':pct>85?'hot':pct>60?'warm':'')+'"><i style="width:'+Math.min(100,Math.max(0,pct||0))+'%"></i></div>';
const gauge=(k,v,pct,sub,plain)=>'<div class="card gauge"><div class="k">'+k+'</div><div class="v">'+v+'</div>'+(pct!=null?bar(pct,plain):'')+(sub?'<div class="k">'+sub+'</div>':'')+'</div>';
let lastOuts='';
function render(d){
  const m=d.machine,now=d.now;
  $('upd').textContent='updated '+new Date(now).toLocaleTimeString()+' · '+m.power;
  const cpuPct=Math.round(100*m.load[0]/m.cores);
  $('gauges').innerHTML=gauge('GPU',(m.gpuPct??'–')+'%',m.gpuPct,m.gpuMemGB!=null?m.gpuMemGB+' GB in use':'',true)
    +gauge('CPU load',m.load[0]+' / '+m.cores,cpuPct,'5 min '+m.load[1])
    +gauge('Memory free',(m.memFreePct??'–')+'%',m.memFreePct!=null?100-m.memFreePct:null,'bar = used')
    +gauge('Renders',d.slots.held.length+' / '+d.slots.limit+' slots',100*d.slots.held.length/d.slots.limit,d.slots.waiting.length?d.slots.waiting.length+' queued':'none queued');
  let s='';
  for(const h of d.slots.held){
    const pct=h.total?100*h.done/h.total:null;
    const prog=h.total?h.done+' / '+h.total+' '+h.unit:(h.done?h.done+' '+h.unit+' done':'booting page, compiling shaders…');
    s+='<div class="card slot"><div class="t">slot '+esc(h.slot)+' · '+esc(h.label)+'</div>'+(pct!=null?bar(pct,true):bar(0,true))
      +'<div class="sub">'+prog+' · running '+ago(h.started,now)+(h.etaS!=null?' · <b style="color:var(--sand)">~'+dur(h.etaS)+' left</b>':'')+'</div>'
      +'<div class="m">'+esc(h.last)+'</div></div>';
  }
  for(let i=d.slots.held.length;i<d.slots.limit;i++)s+='<div class="card free">free slot — GPU available</div>';
  for(const w of d.slots.waiting)s+='<div class="card slot"><div class="t"><span class="pill queued">queued</span> '+esc(w.label)+'</div><div class="sub">waiting '+ago(w.since,now)+'</div></div>';
  $('slots').innerHTML=s;
  const nd=d.nodes||[];
  $('nodes').innerHTML=nd.length?nd.map(n=>{const off=now-n.seen>90000,j=n.job||{},g=n.gpu||{},state=off?'offline':n.state||'idle';
    const pct=j.framesTotal?100*j.frames/j.framesTotal:null;
    return '<div class="card node'+(off?' off':'')+'"><div class="t"><span>'+esc(n.node)+'</span><span class="pill '+esc(state)+'">'+esc(state)+'</span></div>'
      +'<div class="k">'+esc([n.os,g.name,n.power].filter(Boolean).join(' · '))+'</div>'
      +(g.utilPct!=null?'<div class="k">GPU '+g.utilPct+'%'+(g.memUsedGB!=null?' · '+g.memUsedGB+(g.memTotalGB?' / '+g.memTotalGB:'')+' GB':'')+'</div>'+bar(g.utilPct,true):'')
      +(j.name?'<div style="margin-top:6px"><b>'+esc(j.name)+'</b>'+(j.chunks?' · chunk '+j.chunk+'/'+j.chunks:'')+'</div>'+(pct!=null?bar(pct,true):'')
        +'<div class="k">'+(j.framesTotal?j.frames+' / '+j.framesTotal+' frames':'')+(j.fps?' · '+(+j.fps).toFixed(2)+' fps':'')+(j.etaS!=null?' · <b style="color:var(--sand)">~'+dur(j.etaS)+' left</b>':'')+'</div>':'')
      +(n.error?'<div class="k" style="color:var(--coral)">'+esc(n.error)+'</div>':'')
      +'<div class="m k" style="font-family:ui-monospace,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc(n.last||'')+'</div>'
      +'<div class="k">'+esc(n.commit||'')+(n.bundle?' · bundle '+esc(n.bundle):'')+' · seen '+ago(n.seen,now)+' ago</div></div>'}).join('')
    :'<div class="card free">no render nodes have reported yet — they appear here once <code>drift-node.mjs</code> runs on them</div>';
  const st=d.work.streams||[];
  $('streams').innerHTML=st.length?st.map(x=>'<div class="card stream"><span class="pill '+esc(x.state)+'">'+esc(x.state)+'</span><b>'+esc(x.title)+'</b><span class="eta">'+esc(x.eta||'')+'</span><div class="d">'+esc(x.detail||'')+(x.since?' · since '+new Date(x.since).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}):'')+'</div></div>').join(''):'<div class="card free">no streams listed</div>';
  const you=d.work.waitingOnUser||[];
  $('you').innerHTML=you.length?'<ul class="you">'+you.map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul>':'<span class="free">nothing — all clear</span>';
  const key=d.outputs.map(o=>o.path+o.mtime).join('|');
  if(key!==lastOuts){lastOuts=key;$('outs').innerHTML=d.outputs.map(o=>{const u='/file?p='+encodeURIComponent(o.path);return '<a href="'+u+'" target="_blank">'+(o.video?'<div class="vid">▶</div>':'<img loading="lazy" src="'+u+'">')+esc(o.dir+'/'+o.name)+' · '+ago(o.mtime,now)+' ago</a>'}).join('')}
  $('procs').innerHTML=m.top.map(p=>'<div><b>'+p.cpu.toFixed(0).padStart(3)+'%</b> '+esc(p.name)+' <span>('+p.memMB+' MB, pid '+p.pid+')</span></div>').join('')+(m.headlessPages?'<div>'+m.headlessPages+' headless render page(s) open</div>':'');
}
async function tick(){if(document.hidden)return;try{const r=await fetch('/api');render(await r.json())}catch{$('upd').textContent='dashboard server not reachable'}}
tick();setInterval(tick,3000);document.addEventListener('visibilitychange',tick);
</script></body></html>`;
