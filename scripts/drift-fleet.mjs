/**
 * THE STUDIO'S RENDER MACHINES ON ONE PAGE, for scripts/drift-dash.mjs (the user, 2026-10-29: "showing which instance
 * has how much compute ready, so that we are not interfering with maybe ComfyUI"). Each machine's card puts together
 *
 *   - what the box's own studio-manager agent says (the studio's fleet tool, ../studio-manager, read-only; every box
 *     runs one on :4310 and answers over the tailnet): GET /api/session/metrics (the GPU's load, VRAM, temperature,
 *     power), /api/session/status (the services it runs, with the VRAM each holds: "fluxrt 14.5 GB"),
 *     /api/session/devices (which card it is: the 5090 laptop). Polled by the dashboard (agentView). Where a box's
 *     agent does not answer, studio-manager's hub (GET /api/fleet on the Mac's `yarn studio`) when it runs
 *   - the render farm's job on it (drift-farm.mjs), and
 *   - what our own drift-node heartbeat says (drift-node.mjs → POST /report): the job, its chunk, frames and ETA, and
 *     our share of the VRAM
 *
 * matched by name, tailnet label or tailnet address, so one card reads "rendering preview-2k, chunk 3/12, ~40 min
 * left" beside "comfy 18 GB". Only the machines in scripts/drift-farm-nodes.json are shown (the user: the 4090
 * desktops and the 5090 laptop, not the photobooth or the projector laptops), with this Mac's card first.
 *
 * THE BADGE: our job's state while a heartbeat is fresh (syncing, rendering, rendering+shared, waiting-foreign,
 * failed); otherwise the box's, from the hub's numbers and the same thresholds a render yields at (drift-share.mjs's
 * policy): offline, busy-foreign (more VRAM used, or more load, than a render would start beside), or ready.
 * Pure functions of their inputs: tests/driftFleet.test.ts runs them on a fixture of the hub's answer.
 */
import { readFileSync } from 'node:fs';
import { YIELD_DEFAULTS } from './drift-share.mjs';

/** s without a heartbeat before a node's own report is stale (the dashboard's "offline" for heartbeats too) */
export const STALE_MS = 90_000;
/** our job's states that name the card's badge while its heartbeat is fresh */
const JOB_STATES = new Set(['syncing', 'rendering', 'rendering+shared', 'waiting-foreign', 'failed']);
/** a hub service row that is running (FleetServiceState) */
const RUNNING = new Set(['healthy', 'starting', 'busy']);

/** scripts/drift-farm-nodes.json's nodes */
export function farmNodes(file) {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(j.nodes)) throw new Error(`${file}: no "nodes"`);
  return j.nodes;
}

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/^::ffff:/, '');
const isIp = (s) => /^\d+\.\d+\.\d+\.\d+$/.test(s) || s.includes(':');
/** every name a machine goes by, lower case: a MagicDNS name also as its first label */
function keys(list) {
  const out = new Set();
  for (const raw of list) {
    const k = norm(raw);
    if (!k) continue;
    out.add(k);
    if (!isIp(k) && k.includes('.')) out.add(k.split('.')[0]);
  }
  return out;
}
const hubKeys = (v) => keys([v.name, v.identity, v.addr?.tailnet, v.addr?.host, v.addr?.tailnetIp, v.addr?.ip, v.agent?.hostname, v.agent?.label]);
const reportKeys = (r) => keys([r.node, r.host, r.tailnet, r.from]);
const allowKeys = (n) => keys([n.name, n.tailnet]);
const meets = (a, b) => [...a].some((k) => b.has(k));
const gb = (mb) => (Number.isFinite(mb) ? Math.round(mb / 102.4) / 10 : null);

/**
 * the cards: this Mac's first (`mac`, from macCard), then one per machine of `allow` (drift-farm-nodes.json) in its
 * order, each from the hub's view of it (`hub`: GET /api/fleet's body, or null when the hub is not running) and its
 * newest heartbeat (`reports`: the dashboard's node reports, each with `seen` and `from`)
 */
export function fleetCards({ agents = {}, hub = null, reports = [], farm = [], allow = [], mac = null, policy = YIELD_DEFAULTS, now = Date.now() }) {
  const hubViews = (hub?.nodes ?? []).filter((v) => !v.self);
  const cards = allow.map((n) => {
    const ak = allowKeys(n);
    // the box's own agent first; the hub's view when the agent did not answer and the hub has one that did
    const direct = agents[n.name] ? agentView(n, agents[n.name]) : null;
    const fromHub = hubViews.find((v) => meets(hubKeys(v), ak)) ?? null;
    const view = direct?.online ? direct : fromHub?.online ? { ...fromHub, source: 'hub' } : direct ?? fromHub;
    const vk = view ? new Set([...ak, ...hubKeys(view)]) : ak;
    const report = reports.filter((r) => meets(reportKeys(r), vk)).sort((a, b) => (b.seen ?? 0) - (a.seen ?? 0))[0] ?? null;
    const farmJob = farm.filter((j) => j.node === n.name && ['preparing', 'running'].includes(j.state)).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0] ?? null;
    return machineCard(n, view, report, policy, now, farmJob);
  });
  return mac ? [mac, ...cards] : cards;
}

/** a service row of the agent's /api/session/status (StatusRow) in the hub's terms (FleetServiceRow's state) */
const serviceOf = (r) => ({ name: r.name, state: r.absent ? 'absent' : r.alive ? (r.healthy ? 'healthy' : 'starting') : r.enabled === false ? 'disabled' : 'down', stats: r.stats });

/**
 * a box as its own agent answered (`a`: { ok, metrics, status, devices, error, at } from the dashboard's poll), in
 * the shape of the hub's FleetNodeView, so one card builder reads both
 */
export function agentView(n, a) {
  return {
    name: n.name, identity: n.tailnet, self: false, online: a?.ok === true, os: n.os,
    addr: { tailnet: n.tailnet, tailnetIp: n.tailnetIp }, agent: { reachable: a?.ok === true, hostname: n.tailnet },
    services: Array.isArray(a?.status) ? a.status.filter((r) => typeof r?.name === 'string').map(serviceOf) : [],
    metrics: a?.metrics ?? null, devices: a?.devices ?? null, error: a?.error ?? null, at: a?.at ?? null, source: 'agent',
  };
}

/** one machine: its farm hints (n), the box's view (its agent's, or the hub's; or null), our newest heartbeat (or null) */
export function machineCard(n, view, report, policy = YIELD_DEFAULTS, now = Date.now(), farmJob = null) {
  const fresh = report !== null && now - (report.seen ?? 0) < STALE_MS;
  const g = view?.metrics?.gpus?.[0] ?? null;
  const rg = fresh ? report.gpu : null;
  // the hub's numbers first (studio-manager's agent reads the box every few seconds); our heartbeat's otherwise
  const usedGB = g?.memUsedMb != null ? gb(g.memUsedMb) : rg?.memUsedGB ?? null;
  const totalGB = g?.memTotalMb != null ? gb(g.memTotalMb) : rg?.memTotalGB ?? n.vramGB ?? null;
  const utilPct = g?.util ?? rg?.utilPct ?? null;
  const services = (view?.services ?? [])
    .filter((s) => RUNNING.has(s.state))
    .map((s) => ({ name: s.name, state: s.state, vramGB: s.stats?.vramMb ? gb(s.stats.vramMb) : null }))
    .sort((a, b) => (b.vramGB ?? -1) - (a.vramGB ?? -1));
  // VRAM split: ours from our heartbeat while it is fresh, the rest is everyone else's
  const oursGB = fresh && report.vram?.oursGB != null ? report.vram.oursGB : 0;
  const othersGB = usedGB != null ? Math.max(0, Math.round((usedGB - oursGB) * 10) / 10) : null;
  const online = view?.online === true || fresh;
  // a farm job running there counts as ours rendering, when no fresher word from its heartbeat says otherwise
  const jobState = fresh && JOB_STATES.has(report.state) ? report.state : farmJob && ['preparing', 'running'].includes(farmJob.state) ? 'rendering' : null;
  let badge;
  if (!online) badge = 'offline';
  else if (jobState) badge = jobState;
  else if ((othersGB != null && othersGB > policy.foreignVramGB) || (utilPct != null && utilPct > policy.foreignUtil)) badge = 'busy-foreign';
  else badge = 'ready';
  const why = badge === 'busy-foreign'
    ? [othersGB != null && othersGB > policy.foreignVramGB ? `${othersGB} GB of VRAM in use` : null, utilPct != null && utilPct > policy.foreignUtil ? `GPU ${utilPct}% busy` : null].filter(Boolean).join(', ')
    : null;
  return {
    key: n.name,
    name: n.name,
    tailnet: n.tailnet,
    os: view?.os ?? n.os,
    online,
    badge,
    why,
    hint: { gpu: n.gpu, speed: n.speed, battery: n.battery === true },
    gpu: {
      name: rg?.name ?? view?.devices?.gpus?.find((x) => /nvidia|geforce|rtx/i.test(x?.name ?? ''))?.name ?? g?.name ?? n.gpu,
      utilPct, usedGB, totalGB, tempC: g?.temp ?? null, oursGB, othersGB, powerW: g?.powerW ?? null, powerLimitW: g?.powerLimitW ?? null,
    },
    ramPct: view?.metrics?.ram?.pct ?? null,
    ramTotalGB: view?.metrics?.ram?.totalMb != null ? Math.round(view.metrics.ram.totalMb / 102.4) / 10 : null,
    cpuPct: view?.metrics?.cpu ?? null,
    services,
    job: fresh ? report.job ?? null : null,
    waiting: fresh ? report.waiting ?? null : null,
    last: fresh ? report.last ?? null : null,
    error: fresh ? report.error ?? null : null,
    // our last run on it, once its heartbeats have stopped
    lastRun: report && !fresh ? { state: report.state, job: report.job?.name ?? null, seen: report.seen } : null,
    power: report?.power ?? null,
    commit: report?.commit ?? null,
    bundle: report?.bundle ?? null,
    seen: report?.seen ?? null,
    farm: farmJob,
    source: view?.source ?? (view ? 'hub' : null),
    agentError: view?.online === false ? view?.error ?? null : null,
    hub: view !== null,
  };
}

/** this Mac's card, from the dashboard's own probes: ioreg's GPU load and memory, RAM, our render slots */
export function macCard({ host, machine, slots }) {
  const held = slots?.held?.length ?? 0;
  return {
    key: 'this-mac',
    name: host,
    tailnet: host,
    os: 'macOS',
    online: true,
    self: true,
    badge: held > 0 ? 'rendering' : 'ready',
    why: null,
    gpu: { name: machine?.gpuName ?? null, utilPct: machine?.gpuPct ?? null, usedGB: machine?.gpuMemGB ?? null, totalGB: null, tempC: null, oursGB: null, othersGB: null },
    ramPct: machine?.memFreePct != null ? 100 - machine.memFreePct : null,
    ramTotalGB: machine?.ramTotalGB ?? null,
    // (no per-core CPU % here: the 1-min load over the cores, which is what the Mac's gauge shows)
    cpuPct: machine?.load && machine?.cores ? Math.min(100, Math.round((100 * machine.load[0]) / machine.cores)) : null,
    services: [],
    slots: { held, limit: slots?.limit ?? null, waiting: slots?.waiting?.length ?? 0, jobs: (slots?.held ?? []).map((h) => h.label) },
    job: null,
    hub: false,
  };
}
