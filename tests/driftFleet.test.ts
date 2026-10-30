/**
 * The render machines' cards (scripts/drift-fleet.mjs, shown by scripts/drift-dash.mjs): studio-manager's hub view of
 * each box (its GET /api/fleet) merged with our drift-node heartbeats. What a wrong merge would hide:
 *   - ONE CARD PER MACHINE: our job lands on the box's card however the heartbeat names it — the Windows hostname in
 *     capitals, a custom "name", or only the tailnet address it reported from — and only the render machines of
 *     drift-farm-nodes.json are shown (not the photobooth laptop, not the hub's own Mac twice).
 *   - THE BADGE: "rendering preview-2k" beside "comfy 18 GB" while our heartbeat is fresh; once it stops, the box's own
 *     state from the hub's numbers (busy with ComfyUI, or ready) — never a stale "rendering".
 *   - NO HUB: the cards still show our heartbeats, and the machines with no data say offline.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentView, farmNodes, fleetCards, machineCard, macCard, STALE_MS } from '../scripts/drift-fleet.mjs';
import { YIELD_DEFAULTS } from '../scripts/drift-share.mjs';

const allow = farmNodes(join(__dirname, '..', 'scripts/drift-farm-nodes.json'));
const NOW = 1_800_000_000_000;

const svc = (name: string, state: string, vramMb?: number) => ({ name, port: 8188, healthy: state === 'healthy', state, source: 'agent', controllable: true, web: null, base: null, ...(vramMb ? { stats: { cpuPct: 40, rssMb: 9000, vramMb, procs: 3 } } : {}) });
const gpu = (util: number, used: number, temp = 60) => ({ name: 'NVIDIA GeForce RTX 4090', util, memUsedMb: used, memTotalMb: 24564, temp });
const view = (name: string, tailnet: string, ip: string, online: boolean, o: { gpus?: unknown[]; services?: unknown[]; self?: boolean; hostname?: string } = {}) => ({
  name, identity: tailnet, self: o.self ?? false, online, os: name.includes('linux') ? 'linux' : 'windows', tags: [], lastSeen: null, managed: true, flags: [],
  addr: { tailnet, tailnetIp: ip, host: `${tailnet}.tail1a2b.ts.net`, used: 'tailnet' },
  agent: { reachable: online, hostname: o.hostname ?? tailnet, label: tailnet },
  services: o.services ?? [],
  metrics: online ? { cpu: 12, ram: { pct: 41, usedMb: 26000, totalMb: 65000 }, gpus: o.gpus ?? [], at: NOW } : null,
});
/** GET /api/fleet as the Mac hub answers it (FleetSnapshot, the fields read) */
const HUB = {
  tailnet: { available: true },
  nodes: [
    view('mac-hub', 'flos-mac', '100.64.0.1', true, { self: true }),
    view('linux-monster', 'rnatwoofour-linux', '100.101.1.2', true, { gpus: [gpu(97, 19100, 71)], services: [svc('comfy', 'healthy', 18432), svc('fluxrt', 'disabled'), svc('sd-webrtc', 'down')] }),
    view('windows-monster', 'desktop-0kl6e4p', '100.101.1.3', true, { gpus: [gpu(99, 8200)], services: [svc('mediamtx', 'healthy'), svc('sd-webrtc', 'healthy', 2150)], hostname: 'DESKTOP-0KL6E4P' }),
    view('eeg-msi', '204-eeg', '100.101.1.4', false),
    view('morpheus', 'morpheus', '100.101.1.5', true, { gpus: [gpu(5, 900)] }),
    view('msi', 'msi', '100.101.1.6', true, { gpus: [gpu(3, 700)] }),
  ],
  discovered: [], takenAt: NOW - 2000, age: 2000, tookMs: 300,
};
/** our heartbeat from windows-monster, rendering (drift-node.mjs payload), as the dashboard stored it */
const RENDERING = {
  node: 'win-4090', host: 'DESKTOP-0KL6E4P', os: 'win32', commit: 'ed980ff', bundle: '20261029', state: 'rendering', seen: NOW - 4000, from: '::ffff:100.101.1.3',
  gpu: { name: 'NVIDIA GeForce RTX 4090', utilPct: 99, memUsedGB: 8, memTotalGB: 24 },
  vram: { usedGB: 8, totalGB: 24, oursGB: 5.9, foreignGB: 2.1, freeGB: 16 },
  job: { name: 'preview-2k', chunk: 3, chunks: 12, frames: 4100, framesTotal: 23100, fps: 3.4, etaS: 2400, out: 'out/drift/renders/ed980ff-77113d/preview-2k' },
};

describe('the machine cards', () => {
  const cards = fleetCards({ hub: HUB, reports: [RENDERING], allow, mac: macCard({ host: 'Mac · this Mac', machine: { gpuPct: 12, gpuMemGB: 6, memFreePct: 70, gpuName: 'Apple M3 Max' }, slots: { held: [], limit: 2, waiting: [] } }), now: NOW });

  it('this Mac first, then exactly the three render machines in their order (not morpheus, not msi, not the hub\'s self)', () => {
    expect(cards.map((c) => c.name)).toEqual(['Mac · this Mac', 'linux-monster', 'windows-monster', 'eeg-msi']);
  });

  it('our job lands on the box it renders on (the heartbeat says DESKTOP-0KL6E4P / win-4090; the hub says windows-monster)', () => {
    const w = cards.find((c) => c.name === 'windows-monster')!;
    expect(w.badge).toBe('rendering');
    expect(w.job).toMatchObject({ name: 'preview-2k', chunk: 3, chunks: 12, etaS: 2400 });
    expect(w.services.map((s: { name: string; vramGB: number | null }) => [s.name, s.vramGB])).toEqual([['sd-webrtc', 2.1], ['mediamtx', null]]);
    // ours from the heartbeat, the rest of what the hub sees in use is everyone else's
    expect(w.gpu).toMatchObject({ usedGB: 8, totalGB: 24, oursGB: 5.9, othersGB: 2.1 });
  });

  it('a box with ComfyUI holding 18 GB is busy, named by its service, even with nothing of ours on it', () => {
    const l = cards.find((c) => c.name === 'linux-monster')!;
    expect(l.badge).toBe('busy-foreign');
    expect(l.services[0]).toEqual({ name: 'comfy', state: 'healthy', vramGB: 18 });
    expect(l.why).toMatch(/18\.7 GB of VRAM in use.*GPU 97% busy/);
  });

  it('a box the hub cannot reach is offline, with its farm hint still on the card', () => {
    const e = cards.find((c) => c.name === 'eeg-msi')!;
    expect(e.badge).toBe('offline');
    expect(e.hint).toMatchObject({ speed: 0.85, battery: true }); // (drift-farm-nodes.json: measured, 2026-10-30)
  });

  it('matched by the tailnet address alone, when the heartbeat\'s names match nothing', () => {
    const byIp = { ...RENDERING, node: 'lm', host: 'tower', from: '100.101.1.2' };
    const c = fleetCards({ hub: HUB, reports: [byIp], allow, now: NOW });
    expect(c.find((x) => x.name === 'linux-monster')!.job?.name).toBe('preview-2k');
  });

  it('once our heartbeats stop, the badge is the box\'s again, and the last run is kept as a line', () => {
    const stale = { ...RENDERING, seen: NOW - STALE_MS - 1000 };
    const w = fleetCards({ hub: HUB, reports: [stale], allow, now: NOW }).find((c) => c.name === 'windows-monster')!;
    expect(w.badge).toBe('busy-foreign'); // 8 GB in use and 99 % load that are no longer ours
    expect(w.job).toBeNull();
    expect(w.lastRun).toMatchObject({ job: 'preview-2k', state: 'rendering' });
  });

  it('our job waiting for ComfyUI says so (the queue\'s waiting-foreign) instead of "busy"', () => {
    const waiting = { ...RENDERING, state: 'waiting-foreign', waiting: { why: '18.0 GB of VRAM held by others (comfy 18.0 GB)', since: '2026-10-29T22:00:00Z' }, from: '100.101.1.2', host: 'rnatwoofour-linux' };
    const l = fleetCards({ hub: HUB, reports: [waiting], allow, now: NOW }).find((c) => c.name === 'linux-monster')!;
    expect(l.badge).toBe('waiting-foreign');
    expect(l.waiting.why).toMatch(/comfy/);
  });

  it('no hub: our heartbeats alone still make the card; machines without either are offline', () => {
    const c = fleetCards({ hub: null, reports: [RENDERING], allow, now: NOW });
    const w = c.find((x) => x.name === 'windows-monster')!;
    expect(w).toMatchObject({ badge: 'rendering', online: true, hub: false });
    expect(w.gpu).toMatchObject({ usedGB: 8, totalGB: 24, utilPct: 99 });
    expect(c.find((x) => x.name === 'linux-monster')!.badge).toBe('offline');
  });

  it('a quiet box is ready', () => {
    const quiet = view('windows-monster', 'desktop-0kl6e4p', '100.101.1.3', true, { gpus: [gpu(4, 1800)], services: [svc('mediamtx', 'healthy')] });
    expect(machineCard(allow[1], quiet, null, YIELD_DEFAULTS, NOW).badge).toBe('ready');
  });

  it('a box answered by its own agent: its CPU, RAM and services pass through (the agents\' /api/session/metrics and /status)', () => {
    const a = { ok: true, at: NOW, metrics: { cpu: 6, ram: { pct: 11, usedMb: 6937, totalMb: 64111 }, gpus: [{ name: 'NVIDIA GeForce RTX 4090', util: 77, memUsedMb: 14687, memTotalMb: 24564, temp: 64, powerW: 267.6, powerLimitW: 450 }] }, status: [{ name: 'fluxrt', pid: 2708752, alive: true, healthy: true, enabled: false, stats: { vramMb: 14558 } }, { name: 'comfy', alive: false, healthy: false, enabled: true }], devices: null };
    const c = machineCard(allow[0], agentView(allow[0], a), null, YIELD_DEFAULTS, NOW);
    expect(c).toMatchObject({ cpuPct: 6, ramPct: 11, ramTotalGB: 62.6, source: 'agent', badge: 'busy-foreign' });
    expect(c.services).toEqual([{ name: 'fluxrt', state: 'healthy', vramGB: 14.2 }]);
    expect(c.gpu).toMatchObject({ powerW: 267.6, powerLimitW: 450 });
  });

  it('this Mac is rendering while a render slot is held', () => {
    expect(macCard({ host: 'm', machine: {}, slots: { held: [{ label: 'review clip 300–330 s' }], limit: 2, waiting: [] } })).toMatchObject({ badge: 'rendering', slots: { held: 1, jobs: ['review clip 300–330 s'] } });
  });
});
