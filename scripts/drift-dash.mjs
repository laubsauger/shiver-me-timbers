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
 *   - STUDIO-MANAGER'S HUB (the studio's fleet tool, ../studio-manager; `yarn studio` on this Mac, :4310): every 10 s,
 *     server-side, GET /api/fleet (2 s timeout) — each box's GPU load, VRAM, temperature and the services its agent
 *     runs with their VRAM. The machine cards (scripts/drift-fleet.mjs) merge it with our heartbeats, for the render
 *     machines in scripts/drift-farm-nodes.json only, this Mac's card first. No hub: a hint how to start it, and our
 *     heartbeats alone. `--hub <url>` points elsewhere; DRIFT_DASH_NODES moves the node-report file (a test instance).
 *   - THE DRIFT FARM's hub (scripts/drift-farm.mjs): the job queue the render machines pull work from (their
 *     `drift-node.mjs worker`), at /farm/… on the same listeners, bearer token from farm.json (written with a random
 *     token on the first start; gitignored). Its queue is out/drift/farm (DRIFT_FARM_DIR; DRIFT_FARM_TOKEN_FILE moves
 *     farm.json, for a test instance). Status.farm shows it.
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

// ------------------------------------------------------------------------------------- THE /api CONTRACT
// GET /api answers a Status, read by the page every 3 s (scripts/drift-dash-ui/, built against these types). Every
// field may be missing on an older server or a box that never answered: render what is there. Units are in the names
// (…GB, …Pct, …S seconds, …At ms epoch) or said.
/**
 * @typedef {object} Status
 * @property {number} now                ms epoch, the server's clock (ages: now − x)
 * @property {LocalMachine} machine      this Mac's load (the gauges)
 * @property {Slots} slots               this Mac's render slots (scripts/drift-slot.mjs)
 * @property {{ streams: Stream[], waitingOnUser: string[] }} work   the coordinating session's out/drift/dashboard/work.json
 * @property {Output[]} outputs          the newest review images and clips (served by GET /file?p=<path>)
 * @property {Machine[]} machines        this Mac first (self: true), then the render machines of scripts/drift-farm-nodes.json
 * @property {Sources} sources           where the machines' numbers came from
 * @property {Farm} farm                 the render farm's queue (drift-farm.mjs)
 * @property {object[]} nodes            raw drift-node heartbeats by node (kept for older pages; use machines)
 *
 * @typedef {object} LocalMachine
 * @property {number} cores
 * @property {number[]} load             1/5/15 min load averages
 * @property {number} [memFreePct]
 * @property {number} [gpuPct]           Apple GPU utilisation (ioreg)
 * @property {number} [gpuMemGB]         GPU memory in use (unified)
 * @property {string} [gpuName]          e.g. "Apple M3 Max"
 * @property {number} [ramTotalGB]
 * @property {string} power              "AC" | "battery 80%" | "" (not a Mac)
 * @property {number} headlessPages      headless Chrome render pages open
 * @property {{ pid: number, cpu: number, memMB: number, name: string }[]} top   busiest processes
 *
 * @typedef {object} Slots
 * @property {number} limit
 * @property {{ slot: string, pid: number, label: string, cmd: string, started: number, done?: number, total?: number, unit?: string, etaS?: number, last?: string }[]} held
 * @property {{ pid: number, label: string, cmd: string, since: number }[]} waiting
 * @property {{ label: string, cmd: string, out: string|null, exit: string, started: number|null, ended: number }[]} recent
 *           out: the job's --out, absolute (null: it named none); started/ended ms epoch
 *
 * @typedef {object} Stream               one work stream of work.json
 * @property {string} title
 * @property {'rendering'|'coding'|'waiting'|'done'|'blocked'|'queued'|string} state
 * @property {string} [detail]
 * @property {string} [eta]              free text, e.g. "~40 min"
 * @property {string|number} [since]
 *
 * @typedef {object} Output
 * @property {string} path               absolute, for GET /file?p=
 * @property {number} mtime              ms epoch
 * @property {string} name
 * @property {string} dir                its folder's name
 * @property {boolean} video
 *
 * @typedef {'ready'|'busy-foreign'|'rendering'|'rendering+shared'|'waiting-foreign'|'syncing'|'failed'|'offline'} MachineState
 *   ready: free for us · busy-foreign: someone else's load is over the yield policy · rendering: ours ·
 *   rendering+shared: ours, with a foreign load beside it · waiting-foreign: our job waits for the GPU ·
 *   syncing: drift-node pulling code/assets · failed: our last job failed (while its heartbeat is fresh)
 *
 * @typedef {object} Machine
 * @property {string} key                stable id ("this-mac" or the fleet name)
 * @property {string} name               fleet name ("linux-monster"), or "<host> · this Mac"
 * @property {string|null} tailnet       MagicDNS label ("rnatwoofour-linux")
 * @property {string} os
 * @property {boolean} online
 * @property {boolean} [self]            this Mac
 * @property {MachineState} badge
 * @property {string|null} why           busy-foreign: what is over the policy, in words
 * @property {{ gpu: string, speed: number, battery: boolean }} [hint]   drift-farm-nodes.json's hints
 * @property {{ name: string|null, utilPct: number|null, usedGB: number|null, totalGB: number|null, tempC: number|null, oursGB: number|null, othersGB: number|null, powerW?: number|null, powerLimitW?: number|null }} gpu
 *           usedGB = oursGB + othersGB (VRAM; on this Mac unified memory in use, no split)
 * @property {number|null} ramPct        RAM used
 * @property {number|null} ramTotalGB
 * @property {number|null} cpuPct        CPU in use (the box's agent; this Mac: its 1-min load over its cores)
 * @property {{ name: string, state: string, vramGB: number|null }[]} services   the box's studio-manager services that run ("fluxrt 14.5 GB")
 * @property {Job|null} job              our drift-node job there (while its heartbeat is fresh)
 * @property {FarmJob|null} [farm]       the farm job running there
 * @property {{ why: string, since: string, foreign?: { name: string, memGB: number|null }[] }|null} waiting   waiting-foreign: for whom
 * @property {string|null} last          newest log line
 * @property {string|null} error
 * @property {{ state: string, job: string|null, seen: number }|null} lastRun   our last job, once its heartbeats stopped
 * @property {string|null} power         "AC" | "battery 80%"
 * @property {string|null} commit
 * @property {string|null} bundle        asset bundle date, "20261029"
 * @property {number|null} seen          ms epoch of our last heartbeat
 * @property {'agent'|'hub'|null} source where the box's numbers came from
 * @property {string|null} agentError    its agent did not answer: why
 * @property {{ held: number, limit: number|null, waiting: number, jobs: string[] }} [slots]   this Mac only
 *
 * @typedef {object} Job                  a drift-node render (its heartbeat; drift-queue's status.json)
 * @property {string} name               the queue job ("preview-2k")
 * @property {number} chunk              1-based
 * @property {number} chunks
 * @property {number} frames             done in the whole job
 * @property {number} framesTotal
 * @property {number} [fps]
 * @property {number} [etaS]             whole job
 * @property {string} out
 *
 * @typedef {object} Sources
 * @property {Record<string, { ok: boolean, at: number, error: string|null }>} agents   by fleet name: the box's studio-manager agent (http://<tailnet>:4310), polled every 5 s
 * @property {{ url: string, ok: boolean, at: number, error: string|null, used: boolean }} hub   studio-manager's hub, the fallback (used: asked because an agent did not answer)
 *
 * @typedef {object} Farm
 * @property {boolean} enabled
 * @property {FarmJob[]} jobs            newest first: queued, running, then the finished of the last 24 h
 * @property {{ node: string, state: 'waiting'|'busy'|'busy-foreign'|'offline', seen: number, speed: number, job: string|null }[]} workers
 *
 * @typedef {object} FarmJob
 * @property {string} id
 * @property {string} label              what it is, in a few words ("review stills tower_shots.json")
 * @property {'still'|'clip'|'long'} kind
 * @property {'uploading'|'queued'|'preparing'|'running'|'done'|'failed'|'cancelled'} state
 * @property {string|null} node          the box that took it
 * @property {string|null} prefer        asked for a box ("--farm eeg-msi")
 * @property {number} createdAt          ms epoch
 * @property {number|null} startedAt
 * @property {number|null} endedAt
 * @property {number|null} exitCode
 * @property {string} base               the commit its code is based on (on origin)
 * @property {{ done: number|null, total: number|null, unit: string|null, fps: number|null, etaS: number|null }} progress
 * @property {number|null} estS          queued: its expected run time on the fastest box (measured speeds)
 * @property {string|null} why           queued: why no box has it yet ("no worker online", "windows-monster busy (ComfyUI 18 GB)", "waiting for a faster box …")
 * @property {string|null} last          newest output line
 * @property {{ path: string, bytes: number }[]} results   files it sent back, each landed at its local path (path)
 * @property {string|null} error
 */
import { createServer } from 'node:http';
import { execFile, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, createReadStream, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve, extname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus, loadavg, freemem, totalmem, platform, hostname } from 'node:os';
import { farmNodes, fleetCards, macCard } from './drift-fleet.mjs';
import { readYieldPolicy } from './drift-share.mjs';
import { createFarmHub, farmToken } from './drift-farm.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PORT = Number(arg('port', 5190));
const HOST = arg('host', '127.0.0.1');
const TAILNET = argv.includes('--tailnet');
const NODES_FILE = process.env.DRIFT_DASH_NODES ?? join(ROOT, 'out/drift/dashboard/nodes.json');
const HUB = arg('hub', 'http://localhost:4310').replace(/\/+$/, '');
const FARM_NODES = join(ROOT, 'scripts/drift-farm-nodes.json');
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

/** a slot log's first line, `<ISO time>  <command>` (drift-slot.mjs), as { at (ms epoch or null), cmd } */
function stamped(line) {
  const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+(.*)$/.exec(String(line).trim());
  return m ? { at: Date.parse(m[1]), cmd: m[2] } : { at: null, cmd: String(line).trim() };
}

/** a job's command in a few words: what kind, and the span or shot file it renders */
function label(cmd) {
  cmd = stamped(cmd).cmd;
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
        waiting.push({ pid, label: label(cmd), cmd: cmd.trim(), since: statSync(p).mtimeMs });
      } else if (f.endsWith('.log')) {
        const text = readFileSync(p, 'utf8');
        const exit = text.match(/exit (\S+)\s*$/)?.[1];
        if (exit !== undefined) {
          const { at, cmd } = stamped(text.split('\n')[0]);
          const out = cmd.match(/--out\s+(\S+)/)?.[1];
          recent.push({ label: label(cmd), cmd, out: out ? resolve(ROOT, out) : null, exit, started: at, ended: statSync(p).mtimeMs });
        }
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
      gpuName: mac ? cpus()[0]?.model : undefined,
      ramTotalGB: Math.round(totalmem() / 2 ** 30),
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
        // (dashui/: the console's own screenshots, not work)
        if (depth < 3 && !/^(frames|clipall|chunks|raw|tiles|node_modules|dashui)$/.test(e.name)) walk(p, depth + 1);
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

/**
 * THE RENDER MACHINES' OWN AGENTS (studio-manager's `yarn session serve`, :4310 on every box; the Mac reaches them by
 * their tailnet names): /api/session/metrics and /status every 5 s, /devices every 30 s (it barely changes; the agent
 * caches it a minute), each with a 2 s timeout, in the background so a page request never waits on a box.
 */
const agents = {};
const pollAgent = async (n) => {
  const base = n.agentUrl ?? `http://${n.tailnet}:4310`;
  const get = (path) => fetch(`${base}${path}`, { signal: AbortSignal.timeout(2000) }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status} from ${path}`))));
  const cur = agents[n.name] ?? {};
  const devicesDue = !cur.devicesAt || Date.now() - cur.devicesAt > 30_000;
  const [m, st, dv] = await Promise.allSettled([get('/api/session/metrics'), get('/api/session/status'), devicesDue ? get('/api/session/devices') : Promise.resolve(cur.devices)]);
  const why = (r) => (r.reason?.name === 'TimeoutError' ? 'no answer in 2 s' : String(r.reason?.cause?.code ?? r.reason?.message ?? r.reason));
  agents[n.name] = {
    ok: m.status === 'fulfilled',
    at: Date.now(),
    metrics: m.status === 'fulfilled' ? m.value : null,
    status: st.status === 'fulfilled' ? st.value : cur.status ?? null,
    devices: dv.status === 'fulfilled' ? dv.value : cur.devices ?? null,
    devicesAt: dv.status === 'fulfilled' && devicesDue ? Date.now() : cur.devicesAt,
    error: m.status === 'fulfilled' ? null : why(m),
  };
};
const pollAgents = () => {
  let allow = [];
  try {
    allow = farmNodes(FARM_NODES);
  } catch {
    return;
  }
  for (const n of allow) pollAgent(n).catch(() => {});
  // the hub only when a box's agent does not answer (it may still know the box another way)
  if (allow.some((n) => agents[n.name] && !agents[n.name].ok)) pollHub();
};

/**
 * studio-manager's hub (header), the fallback: its newest /api/fleet answer, asked only while a box's own agent does
 * not answer. A slow or absent hub costs one 2 s timeout per poll, nothing else.
 */
const hub = { url: HUB, ok: false, snapshot: null, at: 0, error: 'not asked yet' };
const pollHub = async () => {
  try {
    const r = await fetch(`${HUB}/api/fleet`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    Object.assign(hub, { ok: true, snapshot: await r.json(), at: Date.now(), error: null });
  } catch (e) {
    Object.assign(hub, { ok: false, error: e?.name === 'TimeoutError' ? 'no answer in 2 s' : String(e?.cause?.code ?? e?.message ?? e) });
  }
};
pollAgents();
setInterval(pollAgents, 5_000).unref();

/** the farm's view for /api (Farm); replaced by the farm's own once it is wired (drift-farm.mjs) */
let farmView = () => ({ enabled: false, jobs: [], workers: [] });

/**
 * this Mac's name as the tailnet spells it: macOS's LocalHostName ("Laubs-MBP") in lower case ("laubs-mbp", its
 * MagicDNS label), read once; elsewhere the hostname
 */
const MAC_NAME = (() => {
  const r = platform() === 'darwin' ? spawnSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 3000 }) : null;
  const n = r?.status === 0 ? r.stdout.trim() : '';
  return (n || hostname().replace(/\.local$/, '')).toLowerCase();
})();

/** Status.machines and Status.sources (scripts/drift-fleet.mjs): this Mac, then the render machines */
function machinesNow(m, sl, farm) {
  let allow = [];
  let policy;
  try {
    allow = farmNodes(FARM_NODES);
    policy = readYieldPolicy(ROOT);
  } catch (e) {
    return { machines: [], sources: { agents: {}, hub: { url: HUB, ok: false, at: 0, error: String(e.message), used: false } } };
  }
  const hubUsed = allow.some((n) => agents[n.name] && !agents[n.name].ok);
  const machines = fleetCards({ agents, hub: hubUsed && hub.ok ? hub.snapshot : null, reports: [...nodes.values()], farm: farm.jobs, allow, mac: macCard({ host: MAC_NAME, machine: m, slots: sl }), policy, now: Date.now() });
  const sources = { agents: Object.fromEntries(allow.map((n) => [n.name, { ok: agents[n.name]?.ok ?? false, at: agents[n.name]?.at ?? 0, error: agents[n.name] ? agents[n.name].error : 'not asked yet' }])), hub: { url: HUB, ok: hub.ok, at: hub.at, error: hub.error, used: hubUsed } };
  return { machines, sources };
}

/** @returns {Promise<Status>} */
async function status() {
  const work = readJson(WORK);
  const [m, sl] = [await machine(), slots()];
  const farm = farmView();
  const { machines, sources } = machinesNow(m, sl, farm);
  // (fleet: the same cards under the name the previous page read, until scripts/drift-dash-ui/ replaces it)
  const fleet = { hub: { url: HUB, ok: !sources.hub.used || hub.ok, error: hub.error }, cards: machines };
  return { now: Date.now(), machine: m, slots: sl, work: work ?? { streams: [], waitingOnUser: [] }, outputs: outputs(work), machines, sources, farm, fleet, nodes: [...nodes.values()].sort((a, b) => String(a.node).localeCompare(String(b.node))) };
}

/** the render farm's hub (header); off, with the reason on the console, when farm.json cannot be read */
let farm = null;
try {
  const tokenFile = process.env.DRIFT_FARM_TOKEN_FILE ?? join(ROOT, 'farm.json');
  const t = farmToken(tokenFile);
  if (t.created) console.log(`[dash] farm: wrote ${tokenFile} with a new token. Each render machine needs it in its drift-node.json: "farm": { "token": "<the token in ${tokenFile}>" }`);
  farm = createFarmHub({ dir: process.env.DRIFT_FARM_DIR ?? join(ROOT, 'out/drift/farm'), token: t.token, allow: fromTailnet, hints: () => farmNodes(FARM_NODES), bundleDir: process.env.DRIFT_FARM_BUNDLE_DIR ?? join(ROOT, 'out/drift-bundle'), log: (m) => console.log(`[dash] ${m}`) });
  farmView = farm.view;
} catch (e) {
  console.error(`[dash] farm off: ${e.message}`);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (farm && (await farm.handle(req, res, url))) return;
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
    // RANGE REQUESTS: Safari and iOS ask a video for its bytes in ranges, and play nothing served whole
    const size = statSync(p).size;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (m && (m[1] !== '' || m[2] !== '')) {
      const start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
      const end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(size - 1, Number(m[2]));
      if (start > end || start >= size) {
        res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
        return;
      }
      res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1, 'accept-ranges': 'bytes', 'cache-control': 'max-age=3600' });
      createReadStream(p, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes', 'cache-control': 'max-age=3600' });
    createReadStream(p).pipe(res);
    return;
  }
  // the page: the files of scripts/drift-dash-ui/ (flat; "/" is index.html), read from disk on each request
  const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const type = /^[\w.-]+$/.test(name) && UI_TYPES[extname(name)];
  if (!type || !existsSync(join(UI_DIR, name))) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
  createReadStream(join(UI_DIR, name)).pipe(res);
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

/** the page's files (index.html, app.js, app.css, mock.js): the studio console, built against the /api types above */
const UI_DIR = join(ROOT, 'scripts/drift-dash-ui');
const UI_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
