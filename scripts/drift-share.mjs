/**
 * WHO ELSE IS ON THIS GPU — and yielding to them (the user, 2026-10-29: "let's make sure that we are not fucking up
 * other stuff … so that we are not interfering with maybe ComfyUI or something running outside of our control …
 * we're not assuming that we are always going to be the only users of these machines"). The studio's 4090s and the
 * 5090 laptop also run ComfyUI, sd-webrtc and FluxRT (studio-manager's fleet), games and Blender; a render that starts
 * while one of them holds 18 GB of the card's 24 either dies with a lost device or takes theirs down.
 *
 *   gpuSnapshot()      the NVIDIA card as `nvidia-smi -q -x` reports it — total, used, free, utilisation, and every
 *                      process on it, graphics and compute (`--query-compute-apps` misses graphics, which is what a
 *                      WebGPU page is; `pmon` is unreliable under Windows' WDDM) — each one marked
 *                        ours     its process or an ancestor is one of our scripts (scripts/drift-*.mjs, cine-*.mjs:
 *                                 drift-render's Chrome and its GPU process, cine-sink's ffmpeg), or a Chrome with
 *                                 Playwright's profile folder (one whose node parent died)
 *                        system   the desktop itself (dwm, Xorg, the shell): always there, never yielded to
 *                        foreign  everything else, named where we know it (ComfyUI, Blender, Unreal, a Steam game …)
 *                      null where there is no nvidia-smi (the Mac): nothing to yield to.
 *   shareDecision()    from a snapshot and the policy: ready / busy-foreign / rendering / rendering+shared, and
 *                      whether a job that needs `needGB` may start now
 *   waitForGpu()       before a chunk (drift-queue.mjs) or the GPU check (drift-node.mjs): wait while someone else
 *                      holds the card, re-checking every `recheckS`. It never touches another process.
 *
 * THE POLICY, drift-node.json "yield" (each key optional; --force renders anyway). WHAT CONFLICTS is someone else
 * WORKING the card, or too little memory left for our job — not memory an idle service holds (the coordinator,
 * 2026-10-30: linux-monster sat out the farm all evening because an IDLE sd-webrtc held 5 GB of its 24 GB card, under a
 * rule that yielded to any 4 GB held by others; "the share decision should key on what actually conflicts"):
 *   foreignUtil    30   % GPU utilisation, SUSTAINED — the median of the samples of the last UTIL_WINDOW_S (20 s, a
 *                       sample every 5 s), never one sample — while nothing of ours is on the card, before we wait: an
 *                       idle desktop or a browser stays under 10, a generating ComfyUI or a game sits at 90–100
 *                       (eeg-msi, its user's own apps at 100% for minutes: a real conflict, yielded to)
 *   foreignVramGB  4    GB of VRAM others may hold — a TIEBREAKER only: it counts when the card is tight, its free
 *                       memory within this much of our job's need (a service that holds 5 GB idle may load a model
 *                       and take the rest). With room to spare it does not block.
 *   needVramGB     —    GB per lane our job needs free. Default by the master's size, from the Mac's measurements
 *                       (RENDER-NODE.md): 22 at 8192² (it peaked near 23.5 at ss 1.25), 10 below (the page alone was
 *                       about 11 GB before any master). Only checked while nothing of ours is on the card.
 *   recheckS       30   s between checks while waiting.
 *
 * WHERE THE NUMBERS COME FROM: per-process VRAM is nvidia-smi's on Linux. On Windows WDDM gives nvidia-smi nothing
 * per process (N/A); there it is the GPU performance counters' WMI class
 * (Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory, whose name is never translated), read in the same
 * PowerShell call as the process table — the way studio-manager's agent reads its services' VRAM (its
 * src/session/svcstats.ts). Without either, "foreign" is what is used while nothing of ours runs.
 *   THOSE COUNTERS LIE PER PROCESS (windows-monster, 2026-10-30: the adapter's own counter said 5,780 MB in use and
 *   nvidia-smi 5,772 MiB, while one Chrome "held" 29 GB and the NVIDIA Overlay 2.9 TB, and the processes together far
 *   more than the card: they overlap, and some report reserved space): so only the instances of the NVIDIA adapter
 *   count (its LUID: the adapter whose dedicated total is nvidia-smi's used memory; a laptop's integrated GPU has its
 *   own), the largest per process, not a sum; a process's figure above what the whole card uses is unknown, not
 *   believed; and "others" are never more than what nvidia-smi says is used, less ours and the desktop's. Process command lines
 * are read to tell ours from theirs and to name an app; only names and memory ever leave this machine.
 *
 * STUDIO-MANAGER: where the box runs studio-manager's agent (127.0.0.1:4310, `yarn session serve`; the studio's
 * fleet tool, ../studio-manager), its services' pids name the GPU users it started — "comfy", "sd-webrtc", "fluxrt"
 * — better than any pattern, and its device list names the GPU model. Read-only: GET /api/session/status and
 * /api/session/devices, 1.5 s each, cached 30 s; no agent, the patterns below.
 *
 * Featherweight: one nvidia-smi call per snapshot; the process table is one `ps` (Linux, macOS) or one PowerShell call
 * (Windows, cached 15 s, read again early when a GPU process is not in it). Built-ins only.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ------------------------------------------------------------------------------------------------- the policy
export const YIELD_DEFAULTS = Object.freeze({ foreignVramGB: 4, foreignUtil: 30, needVramGB: null, recheckS: 30 });

/** drift-node.json "yield" over the defaults; a wrong key or value fails loud (a typo must not silently yield nothing) */
export function readYieldPolicy(root) {
  const file = join(root, 'drift-node.json');
  if (!existsSync(file)) return { ...YIELD_DEFAULTS };
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n').replace(/,(\s*[\]}])/g, '$1'));
  } catch (e) {
    throw new Error(`${file}: not valid JSON (${e.message})`);
  }
  return policyOf(cfg?.yield, file);
}

/** a "yield" object checked and merged over the defaults */
export function policyOf(y, where = 'yield') {
  if (y === undefined) return { ...YIELD_DEFAULTS };
  if (y === null || typeof y !== 'object' || Array.isArray(y)) throw new Error(`${where}: "yield" is an object, e.g. { "foreignVramGB": 4 }`);
  for (const [k, v] of Object.entries(y)) {
    if (!(k in YIELD_DEFAULTS)) throw new Error(`${where}: "yield" has no "${k}" (it takes ${Object.keys(YIELD_DEFAULTS).join(', ')})`);
    if (!(typeof v === 'number' && v >= 0) && !(k === 'needVramGB' && v === null)) throw new Error(`${where}: "yield"."${k}" must be a number ≥ 0`);
  }
  return { ...YIELD_DEFAULTS, ...y };
}

/** GB of free VRAM a job needs before it may start (header: needVramGB) */
export function needVramGB(job, policy = YIELD_DEFAULTS) {
  const lanes = Math.max(1, Number(job?.lanes ?? 1));
  const perLane = Number.isFinite(policy.needVramGB) ? policy.needVramGB : (job?.size ?? 0) >= 8192 ? 22 : 10;
  return perLane * lanes;
}

// ------------------------------------------------------------------------------------------- nvidia-smi -q -x
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (xml, name) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decode(m[1].trim()) : null;
};
const mib = (s) => {
  const m = /([\d.]+)\s*MiB/.exec(s ?? '');
  return m ? Number(m[1]) : null;
};
const pct = (s) => {
  const m = /([\d.]+)\s*%/.exec(s ?? '');
  return m ? Number(m[1]) : null;
};

/**
 * the GPUs of `nvidia-smi -q -x`: { driver, gpus: [{ name, totalMB, usedMB, freeMB, utilPct, procs: [{ pid, type
 * (G | C | C+G), path, memMB (null: N/A, Windows WDDM) }] }] }. Plain tag reads: the format is flat and stable, and a
 * dependency-free script cannot take an XML parser.
 */
export function parseNvidiaSmiXml(xml) {
  const gpus = [];
  for (const m of String(xml).matchAll(/<gpu id="[^"]*">([\s\S]*?)<\/gpu>/g)) {
    const g = m[1];
    const fb = tag(g, 'fb_memory_usage') ?? '';
    const procs = [...(/<processes>([\s\S]*?)<\/processes>/.exec(g)?.[1] ?? '').matchAll(/<process_info>([\s\S]*?)<\/process_info>/g)].map(([, p]) => ({
      pid: Number(tag(p, 'pid')),
      type: tag(p, 'type'),
      path: tag(p, 'process_name') ?? '',
      memMB: mib(tag(p, 'used_memory')),
    })).filter((p) => Number.isInteger(p.pid) && p.pid > 0);
    gpus.push({ name: tag(g, 'product_name'), totalMB: mib(tag(fb, 'total')), usedMB: mib(tag(fb, 'used')), freeMB: mib(tag(fb, 'free')), utilPct: pct(tag(tag(g, 'utilization') ?? '', 'gpu_util')), procs });
  }
  return { driver: tag(String(xml), 'driver_version'), gpus };
}

// ------------------------------------------------------------------------------------------ the process table
/** `ps -Ao pid=,ppid=,pcpu=,rss=,command=` (macOS, Linux procps) → pid → { pid, ppid, cpuPct, rssMB, cmd } */
export function parsePsTable(text) {
  const out = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    out.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), cpuPct: Number(m[3]), rssMB: Number(m[4]) / 1024, cmd: m[5] });
  }
  return out;
}

/** Windows' markers between the process table, the per-process GPU memory and the per-adapter GPU memory in WIN_PS's output */
export const WIN_GPU_MARK = '#gpu';
export const WIN_ADAPTER_MARK = '#adapters';
/**
 * one PowerShell call: the CIM process table (pid, ppid, working set, name, command line — tab-separated, [char]9, so
 * no escapes cross the command line), then after `#gpu` each process's dedicated GPU memory per adapter
 * (`pid_<pid>_luid_…_phys_<n> <bytes>`)
 */
export const WIN_PS = [
  "Get-CimInstance Win32_Process | ForEach-Object { '{0}{5}{1}{5}{2}{5}{3}{5}{4}' -f $_.ProcessId, $_.ParentProcessId, $_.WorkingSetSize, $_.Name, $_.CommandLine, [char]9 }",
  `'${WIN_GPU_MARK}'`,
  "Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory -ErrorAction SilentlyContinue | ForEach-Object { '{0} {1}' -f $_.Name, $_.DedicatedUsage }",
  `'${WIN_ADAPTER_MARK}'`,
  "Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory -ErrorAction SilentlyContinue | ForEach-Object { '{0} {1}' -f $_.Name, $_.DedicatedUsage }",
].join('; ');

/**
 * WIN_PS's output → { table: pid → { pid, ppid, cpuPct: null, rssMB, cmd }, gpuMemByLuid: luid → (pid → MB, the
 * largest instance), adapters: luid → MB in use } (header: THOSE COUNTERS LIE PER PROCESS)
 */
export function parseWinPs(text) {
  const table = new Map();
  const gpuMemByLuid = new Map();
  const adapters = new Map();
  let section = 'procs';
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === WIN_GPU_MARK || line === WIN_ADAPTER_MARK) {
      section = line;
      continue;
    }
    if (section === WIN_GPU_MARK) {
      const m = /^pid_(\d+)_luid_(0x[0-9a-f]+_0x[0-9a-f]+)_phys_\d+\s+(\d+)\s*$/i.exec(line);
      if (!m || Number(m[3]) <= 0) continue;
      const luid = m[2].toLowerCase();
      const per = gpuMemByLuid.get(luid) ?? new Map();
      per.set(Number(m[1]), Math.max(per.get(Number(m[1])) ?? 0, Number(m[3]) / 2 ** 20));
      gpuMemByLuid.set(luid, per);
      continue;
    }
    if (section === WIN_ADAPTER_MARK) {
      const m = /^luid_(0x[0-9a-f]+_0x[0-9a-f]+)_phys_\d+\s+(\d+)\s*$/i.exec(line);
      if (m) adapters.set(m[1].toLowerCase(), (adapters.get(m[1].toLowerCase()) ?? 0) + Number(m[2]) / 2 ** 20);
      continue;
    }
    const f = raw.split('\t');
    if (f.length < 4 || !/^\d+$/.test(f[0])) continue;
    const pid = Number(f[0]);
    table.set(pid, { pid, ppid: Number(f[1]), cpuPct: null, rssMB: Number(f[2]) / 2 ** 20, cmd: f.slice(4).join('\t').trim() || f[3] });
  }
  return { table, gpuMemByLuid, adapters };
}

/**
 * the NVIDIA card's per-process memory (pid → MB) out of parseWinPs's: the adapter whose memory in use is nearest
 * nvidia-smi's used figure (`usedMB`) — not the integrated GPU's, not a virtual display's
 */
export function nvidiaGpuMem({ gpuMemByLuid, adapters }, usedMB) {
  if (!gpuMemByLuid?.size) return new Map();
  let best = null;
  for (const [luid, mb] of adapters ?? []) if (gpuMemByLuid.has(luid) && (best === null || Math.abs(mb - usedMB) < Math.abs(adapters.get(best) - usedMB))) best = luid;
  // no adapter counter: the LUID with the most memory under it
  if (best === null) best = [...gpuMemByLuid].sort((a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0))[0][0];
  return gpuMemByLuid.get(best) ?? new Map();
}

// -------------------------------------------------------------------------------------------- ours, theirs
/** our processes' own command lines: the drift / cine scripts, and a Chrome on Playwright's throwaway profile */
const OURS = /scripts[/\\](?:drift|cine)-[\w.-]+\.mjs|playwright_chromiumdev_profile/i;
/** names for the apps the studio runs: [pattern over path + command line, label, heavy (a real GPU user), kind] */
const KNOWN = [
  [/comfyui/i, 'ComfyUI', true],
  [/stable-diffusion-webui|webui-user|automatic1111|sd-forge|forge[/\\]/i, 'Stable Diffusion WebUI', true],
  [/sd-webrtc|streamdiffusion/i, 'sd-webrtc (StreamDiffusion)', true],
  [/fluxrt|run_webrtc\.py/i, 'FluxRT', true],
  [/invokeai/i, 'InvokeAI', true],
  [/ollama/i, 'Ollama', true],
  [/lm ?studio/i, 'LM Studio', true],
  [/blender/i, 'Blender', true],
  [/unrealeditor|ue[45]editor|unreal ?engine/i, 'Unreal Editor', true],
  [/[/\\]unity(\.exe)?\b|unity hub/i, 'Unity', true],
  [/touchdesigner/i, 'TouchDesigner', true],
  [/resolve(\.exe)?\b|davinci/i, 'DaVinci Resolve', true],
  [/arena\.exe|resolume/i, 'Resolume Arena', true],
  [/steamapps[/\\]common[/\\]([^/\\]+)/i, (m) => `a game (${m[1]})`, true],
  [/epic games[/\\]([^/\\]+)/i, (m) => `a game (${m[1]})`, true],
  [/[/\\]python[\d.]*(\.exe)?(\s|$)|^python[\d.]*(\.exe)?\b/i, 'Python (an AI tool?)', true],
  [/obs(64)?(\.exe)?(\s|$)/i, 'OBS', false],
  [/chrome(\.exe)?(\s|$)|google chrome/i, 'Chrome (not ours)', false],
  [/msedge/i, 'Edge', false],
  [/firefox/i, 'Firefox', false],
  [/[/\\]brave/i, 'Brave', false],
  [/\bdwm\.exe|[/\\]explorer\.exe|searchhost|shellexperiencehost|startmenuexperiencehost|textinputhost|lockapp|ctfmon|nvcontainer|nvidia (share|overlay)|\bXorg\b|Xwayland|gnome-shell|kwin|plasmashell|WindowServer/i, 'desktop', false, 'system'],
];

/** is `pid` ours: its own command line or an ancestor's (up to 12 levels) is one of our scripts */
export function isOurs(pid, table, path = '') {
  if (OURS.test(path)) return true;
  let p = pid;
  for (let i = 0; i < 12 && p > 1; i++) {
    const e = table.get(p);
    if (!e) return false;
    if (OURS.test(e.cmd)) return true;
    p = e.ppid === p ? 0 : e.ppid;
  }
  return false;
}

/**
 * { kind: ours | system | foreign, label, heavy } of a process (nvidia-smi's path, the table's command line);
 * `services`: studio-manager's [{ name, pid }] — a process under one of their pids is that service
 */
export function classify(pid, path, table, services = []) {
  if (isOurs(pid, table, path)) return { kind: 'ours', label: 'The Drift (render)', heavy: true };
  if (services.length > 0) {
    const byPid = new Map(services.filter((x) => x.pid > 0).map((x) => [x.pid, x.name]));
    for (let p = pid, i = 0; i < 12 && p > 1; i++) {
      if (byPid.has(p)) return { kind: 'foreign', label: byPid.get(p), heavy: true };
      const e = table.get(p);
      if (!e || e.ppid === p) break;
      p = e.ppid;
    }
  }
  const text = `${path} ${table.get(pid)?.cmd ?? ''}`;
  for (const [re, label, heavy, kind] of KNOWN) {
    const m = re.exec(text);
    if (m) return { kind: kind ?? 'foreign', label: typeof label === 'function' ? label(m) : label, heavy };
  }
  const exe = (path || table.get(pid)?.cmd || `pid ${pid}`).split(/[/\\]/).pop().split(/\s/)[0].replace(/\.exe$/i, '');
  return { kind: 'foreign', label: exe || `pid ${pid}`, heavy: false };
}

/**
 * the card a job would run on (the one with the most memory) with its processes classified and summed:
 * { name, totalMB, usedMB, freeMB, utilPct, procs: [{ pid, label, kind, heavy, memMB }], oursMB, foreignMB, systemMB,
 * memKnown } — memKnown false where neither nvidia-smi nor Windows' counters gave per-process memory
 */
export function shareOf(parsed, table, gpuMem = new Map(), services = []) {
  const gpu = [...(parsed?.gpus ?? [])].sort((a, b) => (b.totalMB ?? 0) - (a.totalMB ?? 0))[0];
  if (!gpu) return null;
  const procs = gpu.procs.map((p) => {
    const c = classify(p.pid, p.path, table, services);
    let memMB = p.memMB ?? (gpuMem.has(p.pid) ? Math.round(gpuMem.get(p.pid)) : null);
    // a process cannot hold more than the whole card has in use: such a figure is a counter's lie, so unknown
    if (memMB !== null && gpu.usedMB !== null && memMB > gpu.usedMB) memMB = null;
    return { pid: p.pid, label: c.label, kind: c.kind, heavy: c.heavy, memMB };
  });
  const sum = (kind) => procs.filter((p) => p.kind === kind).reduce((a, p) => a + (p.memMB ?? 0), 0);
  return { name: gpu.name, totalMB: gpu.totalMB, usedMB: gpu.usedMB, freeMB: gpu.freeMB, utilPct: gpu.utilPct, procs, oursMB: sum('ours'), foreignMB: sum('foreign'), systemMB: sum('system'), memKnown: procs.every((p) => p.memMB !== null) };
}

const gbs = (mb) => `${(mb / 1024).toFixed(1)} GB`;

/**
 * may a job start, and how the card stands: { state: idle | busy-foreign | rendering | rendering+shared, canStart,
 * why, foreign: [{ name, memGB }], foreignGB (null: unknown), freeGB }. `share` null (no NVIDIA card): idle, canStart.
 * Utilisation is only held against others while nothing of ours is on the card (with ours on it, it is ours too).
 */
export function shareDecision(share, policy = YIELD_DEFAULTS, needGB = null) {
  if (!share) return { state: 'idle', canStart: true, why: 'no NVIDIA card here: nothing to yield to', foreign: [], foreignGB: null, freeGB: null };
  const ours = share.procs.some((p) => p.kind === 'ours');
  const foreign = share.procs.filter((p) => p.kind === 'foreign').sort((a, b) => (b.memMB ?? -1) - (a.memMB ?? -1));
  // others' VRAM: their own figures — but never more than the card has in use, less ours and the desktop's (the
  // figures overlap on Windows); where the driver gives none, what is used while nothing of ours is on the card
  const room = Math.max(0, (share.usedMB ?? 0) - share.oursMB - share.systemMB);
  const foreignMB = share.memKnown ? Math.min(share.foreignMB, share.usedMB === null ? Infinity : room) : ours ? null : room;
  const names = (list) => list.slice(0, 4).map((p) => `${p.label}${p.memMB != null ? ` ${gbs(p.memMB)}` : ''}`).join(', ');
  const why = [];
  const freeGB = share.freeMB !== null ? share.freeMB / 1024 : null;
  // (header, THE POLICY) someone WORKING the card: the sustained utilisation, never one sample
  const win = share.utilWindow ?? null;
  const sustained = win !== null && win.n >= UTIL_MIN_SAMPLES && win.spanS >= UTIL_MIN_SPAN_S && win.medianPct !== null;
  if (!ours && sustained && win.medianPct > policy.foreignUtil) why.push(`the GPU is ${win.medianPct}% busy, sustained over ${Math.round(win.spanS)} s (${names(foreign) || 'someone else'}; the policy allows ${policy.foreignUtil}%)`);
  // memory others hold: a tiebreaker only when the card is tight (free within foreignVramGB of the job's need)
  const tight = needGB !== null && freeGB !== null && freeGB < needGB + policy.foreignVramGB;
  if (tight && foreignMB !== null && foreignMB / 1024 > policy.foreignVramGB) why.push(`${gbs(foreignMB)} of VRAM held by others (${names(foreign) || 'unnamed'}) with ${freeGB.toFixed(1)} GB free, close to the job's ~${needGB} GB`);
  // (memory unknown only while ours is on the card, Windows without counters: a heavy app by name makes it shared)
  if (foreignMB === null && foreign.some((p) => p.heavy)) why.push(`${names(foreign.filter((p) => p.heavy))} on the GPU (its memory unknown)`);
  const busy = why.length > 0;
  const short = !ours && needGB !== null && freeGB !== null && freeGB < needGB;
  if (short && !busy) why.push(`${freeGB.toFixed(1)} GB free, the job needs ~${needGB} GB`);
  return {
    state: ours ? (busy ? 'rendering+shared' : 'rendering') : busy ? 'busy-foreign' : 'idle',
    canStart: !busy && !short,
    why: why.join('; ') || 'the GPU is free',
    foreign: foreign.map((p) => ({ name: p.label, memGB: p.memMB != null ? Math.round(p.memMB / 102.4) / 10 : null })),
    foreignGB: foreignMB !== null ? Math.round(foreignMB / 102.4) / 10 : null,
    freeGB: freeGB !== null ? Math.round(freeGB * 10) / 10 : null,
  };
}

// ---------------------------------------------------------------------------------------------- the probe
const sh = (cmd, args, timeout = 8000) =>
  new Promise((res) => execFile(cmd, args, { timeout, maxBuffer: 32 << 20, windowsHide: true }, (e, out) => res({ ok: !e, out: String(out ?? ''), missing: e?.code === 'ENOENT' })));

let winCache = { at: 0, table: new Map(), gpuMemByLuid: new Map(), adapters: new Map() };
let smiMissing = false;

// ------------------------------------------------------------------------------------- sustained utilisation
/** s of utilisation history a decision looks at (header: foreignUtil) */
export const UTIL_WINDOW_S = 20;
/** samples a window needs, and the span they must cover (s), before it may say "busy" */
export const UTIL_MIN_SAMPLES = 3;
export const UTIL_MIN_SPAN_S = 10;
/**
 * the utilisation over the last `windowS` of `samples` ([{ at ms, pct, ours }]; ours: something of ours was on the card,
 * so the figure is not someone else's): { medianPct, n, spanS }, the median of the others' samples (the lower middle:
 * one spike in an even window does not make it busy)
 */
export function utilWindow(samples, now, windowS = UTIL_WINDOW_S) {
  const w = samples.filter((x) => !x.ours && x.pct !== null && x.pct !== undefined && now - x.at <= windowS * 1000 && x.at <= now);
  if (w.length === 0) return { medianPct: null, n: 0, spanS: 0 };
  const sorted = w.map((x) => x.pct).sort((a, b) => a - b);
  return { medianPct: sorted[Math.floor((sorted.length - 1) / 2)], n: w.length, spanS: (Math.max(...w.map((x) => x.at)) - Math.min(...w.map((x) => x.at))) / 1000 };
}
/** this process's samples (gpuSnapshot adds one each time; drift-node.mjs's heartbeat takes one every 5 s) */
const utilSeen = [];

/** the process table (and on Windows the counters' GPU memory); `pids`: GPU processes it must hold (Windows reads again early) */
async function processTable(pids) {
  if (process.platform === 'win32') {
    const stale = Date.now() - winCache.at > 15_000 || pids.some((p) => !winCache.table.has(p));
    if (stale) {
      const r = await sh('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WIN_PS, 'utf16le').toString('base64')], 20_000);
      if (r.ok) winCache = { at: Date.now(), ...parseWinPs(r.out) };
    }
    return winCache;
  }
  const r = await sh('ps', ['-Ao', 'pid=,ppid=,pcpu=,rss=,command=']);
  return { table: r.ok ? parsePsTable(r.out) : new Map(), gpuMemByLuid: null };
}

let agentCache = { at: 0, value: null };
/**
 * the box's studio-manager agent (header: STUDIO-MANAGER): { services: [{ name, pid, alive, vramMb }], gpuName } or
 * null when none answers. Cached 30 s, a miss too (a box without one asks twice a minute, not every beat).
 */
export async function localAgent({ port = 4310, timeoutMs = 1500 } = {}) {
  if (Date.now() - agentCache.at < 30_000) return agentCache.value;
  const get = (path) => fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(timeoutMs) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [rows, devices] = await Promise.all([get('/api/session/status'), get('/api/session/devices')]);
  agentCache = { at: Date.now(), value: agentOf(rows, devices) };
  return agentCache.value;
}

/** the agent's status rows and device list → what drift needs of them (null: no agent) */
export function agentOf(rows, devices) {
  if (!Array.isArray(rows)) return null;
  const services = rows.filter((r) => typeof r?.name === 'string').map((r) => ({ name: r.name, pid: Number(r.pid) || 0, alive: r.alive === true, vramMb: r.stats?.vramMb ?? null }));
  const gpus = Array.isArray(devices?.gpus) ? devices.gpus : [];
  const nvidia = gpus.find((g) => /nvidia|geforce|rtx/i.test(g?.name ?? '')) ?? gpus[0];
  return { services, gpuName: nvidia?.name ?? null };
}

/** the NVIDIA card now (shareOf), or null when this machine has no nvidia-smi; `agent`: localAgent()'s answer */
export async function gpuSnapshot({ agent = null } = {}) {
  if (smiMissing) return null;
  const r = await sh('nvidia-smi', ['-q', '-x']);
  if (r.missing) {
    smiMissing = true;
    return null;
  }
  if (!r.ok) return null;
  const parsed = parseNvidiaSmiXml(r.out);
  const pids = parsed.gpus.flatMap((g) => g.procs.map((p) => p.pid));
  const t = await processTable(pids);
  const used = [...parsed.gpus].sort((a, b) => (b.totalMB ?? 0) - (a.totalMB ?? 0))[0]?.usedMB ?? 0;
  const share = shareOf(parsed, t.table, t.gpuMemByLuid ? nvidiaGpuMem(t, used) : new Map(), agent?.services ?? []);
  if (!share) return share;
  // (the sustained utilisation, header: foreignUtil)
  const now = Date.now();
  utilSeen.push({ at: now, pct: share.utilPct, ours: share.procs.some((p) => p.kind === 'ours') });
  while (utilSeen.length > 0 && now - utilSeen[0].at > 120_000) utilSeen.shift();
  const withWindow = { ...share, utilWindow: utilWindow(utilSeen, now) };
  return agent?.gpuName ? { ...withWindow, name: agent.gpuName } : withWindow;
}

/**
 * a snapshot whose utilisation window can decide (UTIL_MIN_SAMPLES over UTIL_MIN_SPAN_S): more samples, 5 s apart,
 * when this process has too few — a worker just started, a queue that checks every 30 s. At most ~15 s, once
 */
export async function sustainedSnapshot(snapshot = async () => gpuSnapshot({ agent: await localAgent() }), stepMs = 5000) {
  let snap = await snapshot();
  for (let i = 0; i < 4 && snap?.utilWindow && (snap.utilWindow.n < UTIL_MIN_SAMPLES || snap.utilWindow.spanS < UTIL_MIN_SPAN_S); i++) {
    await new Promise((ok) => setTimeout(ok, stepMs));
    snap = await snapshot();
  }
  return snap;
}

/**
 * wait until a job needing `needGB` may start (shareDecision), saying why every 5 min and calling `onWait(decision,
 * sinceMs)` at each check. `force`: no check. Returns the last decision. Never touches another process.
 */
export async function waitForGpu({ policy = YIELD_DEFAULTS, needGB = null, say = console.log, onWait = () => {}, force = false, snapshot = async () => gpuSnapshot({ agent: await localAgent() }) } = {}) {
  if (force) return null;
  let since = null;
  let told = 0;
  for (;;) {
    const d = shareDecision(await sustainedSnapshot(snapshot), policy, needGB);
    if (d.canStart) {
      if (since !== null) say(`the GPU is free again after ${Math.round((Date.now() - since) / 1000)} s: going on`);
      return d;
    }
    since ??= Date.now();
    if (Date.now() - told > 300_000) {
      told = Date.now();
      say(`waiting for the GPU: ${d.why}. Re-checking every ${policy.recheckS} s; nothing of theirs is touched (--force renders anyway)`);
    }
    onWait(d, since);
    await new Promise((r) => setTimeout(r, policy.recheckS * 1000));
  }
}
