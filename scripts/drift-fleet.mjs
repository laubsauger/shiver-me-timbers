/**
 * THIS MAC'S CARD AND THE BOXES' HEARTBEATS, for scripts/drift-dash.mjs. The other machines' cards (studio-manager's
 * agents, the farm job on each box, the badge) are the studio-farm package's (src/fleet.mjs of the sibling checkout
 * ../studio-farm, which drift-dash loads); what stays here is the Drift's own: this Mac's card from the dashboard's
 * probes and its render slots (it is the hub's machine, and a farm worker of its own), and the heartbeats of both kinds
 * of box worker, the newest per box — drift-node's /report and the studio-farm workers' GPU picture through the hub.
 * Pure functions of their inputs: tests/driftFleet.test.ts.
 */

/**
 * THE STUDIO FARM WORKERS' GPU PICTURE as heartbeats (the user, 2026-11-02, after linux-monster moved to the studio
 * farm's worker: "the Linux box is not telling us anymore what is using VRAM … it's eating everything" — our own
 * render, which the old drift-node worker had reported in its /report heartbeat): each worker's card as it reports it
 * to the hub (studio-farm's gpuReport: gpu, vram with ours, the named others), in the heartbeat's own shape, so the
 * cards and the page read it as they read drift-node's. `workers`: the hub's view().workers (each `gpu` null or
 * { gpu, vram, foreign, at }). No state, job or power: the farm's own job and the box's agent say those
 */
export function farmHeartbeats(workers = []) {
  return workers.filter((w) => w?.gpu && Number.isFinite(w.gpu.at)).map((w) => ({ node: w.node, seen: w.gpu.at, gpu: w.gpu.gpu, vram: w.gpu.vram, foreign: w.gpu.foreign, via: 'farm' }));
}

/** heartbeats from both kinds of worker, the newest per node (a box moved to the farm's worker keeps its old one) */
export function newestHeartbeats(...lists) {
  const by = new Map();
  for (const r of lists.flat()) if (r?.node && (by.get(r.node)?.seen ?? -1) < (r.seen ?? 0)) by.set(r.node, r);
  return [...by.values()];
}

/**
 * this Mac's card, from the dashboard's own probes: ioreg's GPU load and memory, RAM, our render slots — and THIS MAC
 * AS A FARM WORKER (the user, 2026-11-02: "accept, drain, pause and remove toggles in the dashboard, so we can join in
 * or out of the render farm"), when the hub knows it: its farm state and moves (`farmState`, the hub's
 * view().nodes[host]), its worker as the hub last heard it (`worker`, one of view().workers: null or offline when it
 * does not run — the card then says how to start it), and the farm job it runs (`farm`, the hub's jobs). The farm
 * job's own slot is left out of `slots.jobs`: the card shows the job itself, with its progress and preview.
 */
export function macCard({ host, machine, slots, farm = [], farmState = null, worker = null }) {
  const farmJob = farm.filter((j) => j.node === host && ['preparing', 'running'].includes(j.state)).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0] ?? null;
  const local = (slots?.held ?? []).filter((h) => !/^farm \S+ /.test(h.cmd ?? h.label ?? ''));
  const held = slots?.held?.length ?? 0;
  const fs = farmState?.state ?? null;
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
    slots: { held, limit: slots?.limit ?? null, waiting: slots?.waiting?.length ?? 0, jobs: local.map((h) => h.label) },
    job: null,
    hub: false,
    farmState: fs ?? undefined,
    farmActions: farmState?.actions ?? undefined,
    farmStateAt: farmState?.at ?? null,
    excluded: fs === 'paused' || fs === 'removed' ? `${fs} from the dashboard` : null,
    farm: farmJob,
    // (the hub's word for its worker: offline, waiting, busy, busy-foreign with why — on battery, local jobs first)
    farmWorker: worker && worker.state !== 'offline' ? { state: worker.state, why: worker.why ?? null, seen: worker.seen ?? null, types: worker.types ?? null } : null,
    farmWorkerSeen: worker?.seen || null,
  };
}
