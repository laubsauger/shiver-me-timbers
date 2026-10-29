/**
 * ?mock: a fake /api Status (the JSDoc contract at the top of scripts/drift-dash.mjs), so the console can be judged
 * before the studio boxes and the farm report anything. Loaded only in mock mode (app.js imports it on demand).
 *
 *   ?mock          this Mac rendering a review clip with one stills job queued and its memory nearly gone,
 *                  linux-monster rendering our farm job, windows-monster busy with ComfyUI (18 GB), eeg-msi ready;
 *                  farm jobs running, queued, done, failed and cancelled
 *   ?mock=yield    the other states: linux-monster syncing (a farm job preparing), windows-monster waiting for
 *                  ComfyUI to let go (our job yields), eeg-msi offline, this Mac's slots free
 *
 * Progress moves with the wall clock, so the 3 s updates (and the DOM patching) can be watched. The work streams and
 * the outputs are the real ones when /api answers (`real`), else a small made-up set.
 */
const MIN = 60_000;

export function mockStatus(now, scenario = 'default', real = null) {
  const yieldCase = scenario === 'yield';
  const t = now / 1000;
  const outs = real?.outputs?.length ? real.outputs : fakeOutputs(now);
  const someVideo = outs.find((o) => o.video)?.path ?? outs[0]?.path ?? null;

  // this Mac: one review clip in its one slot, 240 frames at ~0.7 fps, starting over every ~6 min
  const clipDone = Math.floor(((t % 360) / 360) * 240);
  const held = yieldCase ? [] : [{
    slot: '0', pid: 48211, started: now - (clipDone / 0.7) * 1000 - 22_000,
    label: 'review clip 642–650 s, 1280 px  →  swash_642-650_1280.mp4',
    cmd: 'node scripts/drift-review-clip.mjs --from 642 --to 650 --width 1280 --shot {"fov":55,"yaw":22,"pitch":-9} --out /private/tmp/claude-501/scratchpad/sim3/swash_642-650_1280.mp4 --port 5372',
    done: clipDone, total: 240, unit: 'frames', etaS: (240 - clipDone) / 0.7, last: `[review] ${clipDone}/240  0.7 fps`,
  }];
  const slots = {
    limit: 1,
    held,
    waiting: yieldCase ? [] : [{ pid: 48377, label: 'review stills (shots_tower_dusk.json)', since: now - 4 * MIN - 10_000 }],
    recent: [
      { label: 'review clip 700–712 s, 1280 px  →  tower_lamp_700-712.mp4', exit: '0', ended: now - 9 * MIN },
      { label: 'review stills (sky_r5.json)', exit: '1', ended: now - 26 * MIN },
    ],
  };
  const machine = {
    cores: 14, load: yieldCase ? [9.4, 10.1, 11.8] : [17.2, 15.4, 12.8], memFreePct: yieldCase ? 12 : 7,
    gpuPct: yieldCase ? 18 : 97, gpuMemGB: yieldCase ? 9.6 : 31.4, gpuName: 'Apple M3 Max', power: 'AC', headlessPages: held.length,
    top: [
      { pid: 48230, cpu: 88.1, memMB: 1460, name: 'headless Chrome GPU (render)' },
      { pid: 16695, cpu: 48.3, memMB: 211, name: 'Loom MCP server' },
      { pid: 85279, cpu: 43.0, memMB: 98, name: 'Loom MCP server' },
      { pid: 16592, cpu: 41.2, memMB: 97, name: 'Loom MCP server' },
      { pid: 85160, cpu: 40.6, memMB: 949, name: 'Claude app' },
      { pid: 405, cpu: 37.9, memMB: 77, name: 'WindowServer' },
    ],
  };

  // the farm: linux-monster's chunk of the 2K preview, 9000 frames at ~4.1 fps
  const fDone = 3200 + Math.floor((t % 1400) * 4.1);
  const running = {
    id: 'f-0193', label: 'preview-2k 600–900 s', kind: 'long', state: 'running', node: yieldCase ? 'windows-monster' : 'linux-monster', prefer: null,
    createdAt: now - 52 * MIN, startedAt: now - 47 * MIN, endedAt: null, exitCode: null, base: 'ed980ff',
    progress: { done: fDone, total: 9000, unit: 'frames', fps: yieldCase ? 0 : 4.1, etaS: yieldCase ? null : (9000 - fDone) / 4.1 }, estS: null,
    last: yieldCase ? 'waiting for the GPU: ComfyUI holds 18.1 GB (the policy allows 4 GB)' : `chunk 3/12  frame ${fDone}/9000  4.1 fps`, results: [], error: null,
  };
  const preparing = {
    id: 'f-0196', label: 'review stills tower_shots.json', kind: 'still', state: 'preparing', node: 'linux-monster', prefer: null,
    createdAt: now - 3 * MIN, startedAt: now - 70_000, endedAt: null, exitCode: null, base: 'ed980ff',
    progress: { done: null, total: 14, unit: 'stills', fps: null, etaS: null }, estS: 240, last: 'npm ci: lockfile changed', results: [], error: null,
  };
  const jobs = [
    ...(yieldCase ? [preparing] : []),
    { id: 'f-0195', label: 'master-4k 1100–1180 s', kind: 'long', state: 'queued', node: null, prefer: null, createdAt: now - 12 * MIN, startedAt: null, endedAt: null, exitCode: null, base: 'ed980ff', progress: { done: null, total: null, unit: null, fps: null, etaS: null }, estS: 5400, last: null, results: [], error: null },
    { id: 'f-0194', label: 'review clip 742–760 s', kind: 'clip', state: 'queued', node: null, prefer: 'eeg-msi', createdAt: now - 6 * MIN, startedAt: null, endedAt: null, exitCode: null, base: 'ed980ff', progress: { done: null, total: null, unit: null, fps: null, etaS: null }, estS: 420, last: null, results: [], error: null },
    running,
    { id: 'f-0190', label: 'smoke', kind: 'clip', state: 'done', node: 'eeg-msi', prefer: null, createdAt: now - 66 * MIN, startedAt: now - 61 * MIN, endedAt: now - 55 * MIN, exitCode: 0, base: 'ed980ff', progress: { done: 180, total: 180, unit: 'frames', fps: 0.6, etaS: 0 }, estS: null, last: 'done: 180 frames, decode check ok', results: someVideo ? [{ path: someVideo, bytes: 18_400_000 }] : [], error: null },
    { id: 'f-0191', label: 'master-4k 300–420 s', kind: 'long', state: 'failed', node: 'windows-monster', prefer: null, createdAt: now - 130 * MIN, startedAt: now - 121 * MIN, endedAt: now - 98 * MIN, exitCode: 1, base: '7074655', progress: { done: 1450, total: 3600, unit: 'frames', fps: null, etaS: null }, estS: null, last: 'GPU process exited (device lost)', results: [], error: 'Chrome’s GPU process crashed in chunk 4 of 8 (device lost); chunks 1–3 kept' },
    { id: 'f-0192', label: 'review stills sky_r4.json', kind: 'still', state: 'cancelled', node: null, prefer: null, createdAt: now - 84 * MIN, startedAt: null, endedAt: now - 71 * MIN, exitCode: null, base: '7074655', progress: { done: null, total: null, unit: null, fps: null, etaS: null }, estS: null, last: null, results: [], error: 'cancelled: superseded by sky_r5' },
  ];

  const mac = {
    key: 'this-mac', name: 'laubs-mbp · this Mac', tailnet: null, os: 'macOS', online: true, self: true, badge: held.length ? 'rendering' : 'ready', why: null,
    gpu: { name: 'Apple M3 Max', utilPct: machine.gpuPct, usedGB: machine.gpuMemGB, totalGB: null, tempC: null, oursGB: null, othersGB: null },
    ramPct: 100 - machine.memFreePct, services: [], slots: { held: held.length, limit: 1, waiting: slots.waiting.length, jobs: held.map((h) => h.label) },
    job: null, hub: false,
  };
  const box = (o) => ({
    tailnet: null, os: 'windows', online: true, why: null, services: [], job: null, farm: null, waiting: null, last: null, error: null, lastRun: null,
    power: null, commit: null, bundle: null, seen: null, source: 'agent', agentError: null, ...o,
  });
  const linux = yieldCase
    ? box({ key: 'linux-monster', name: 'linux-monster', tailnet: 'rnatwoofour-linux', os: 'linux', badge: 'syncing', hint: { gpu: 'RTX 4090', speed: 1, battery: false },
        gpu: { name: 'NVIDIA GeForce RTX 4090', utilPct: 3, usedGB: 1.1, totalGB: 24, tempC: 44, oursGB: 0, othersGB: 1.1, powerW: 61, powerLimitW: 450 }, ramPct: 22,
        farm: preparing, last: 'npm ci: lockfile changed', seen: now - 2000, commit: 'ed980ff', bundle: '20261029' })
    : box({ key: 'linux-monster', name: 'linux-monster', tailnet: 'rnatwoofour-linux', os: 'linux', badge: 'rendering', hint: { gpu: 'RTX 4090', speed: 1, battery: false },
        gpu: { name: 'NVIDIA GeForce RTX 4090', utilPct: 96, usedGB: 15.6, totalGB: 24, tempC: 72, oursGB: 14.2, othersGB: 1.4, powerW: 398, powerLimitW: 450 }, ramPct: 34,
        services: [{ name: 'sd-webrtc', state: 'healthy', vramGB: 1.2 }, { name: 'mediamtx', state: 'healthy', vramGB: null }],
        farm: running, job: { name: 'preview-2k', chunk: 3, chunks: 12, frames: fDone, framesTotal: 9000, fps: 4.1, etaS: (9000 - fDone) / 4.1, out: '/home/studio/renders/ed980ff-20261029/preview-2k' },
        last: running.last, seen: now - 3000, commit: 'ed980ff', bundle: '20261029' });
  const comfy = [{ name: 'ComfyUI', state: 'busy', vramGB: 18.1 }, { name: 'sd-webrtc', state: 'healthy', vramGB: 2.2 }, { name: 'mediamtx', state: 'healthy', vramGB: null }, { name: 'frame-server', state: 'healthy', vramGB: null }, { name: 'studio-tts', state: 'healthy', vramGB: null }];
  const windows = yieldCase
    ? box({ key: 'windows-monster', name: 'windows-monster', tailnet: 'desktop-0kl6e4p', badge: 'waiting-foreign', hint: { gpu: 'RTX 4090', speed: 1, battery: false },
        gpu: { name: 'NVIDIA GeForce RTX 4090', utilPct: 84, usedGB: 20.3, totalGB: 24, tempC: 69, oursGB: 0, othersGB: 20.3, powerW: 331, powerLimitW: 450 }, ramPct: 55, services: comfy,
        farm: running, waiting: { why: 'ComfyUI holds 18.1 GB of VRAM (the policy allows 4 GB)', since: new Date(now - 7 * MIN).toISOString(), foreign: [{ name: 'ComfyUI', memGB: 18.1 }] },
        last: running.last, seen: now - 4000, commit: 'ed980ff', bundle: '20261029' })
    : box({ key: 'windows-monster', name: 'windows-monster', tailnet: 'desktop-0kl6e4p', badge: 'busy-foreign', why: '20.3 GB of VRAM in use, GPU 81% busy', hint: { gpu: 'RTX 4090', speed: 1, battery: false },
        gpu: { name: 'NVIDIA GeForce RTX 4090', utilPct: 81, usedGB: 20.3, totalGB: 24, tempC: 67, oursGB: 0, othersGB: 20.3, powerW: 312, powerLimitW: 450 }, ramPct: 52, services: comfy,
        lastRun: { state: 'failed', job: 'master-4k', seen: now - 98 * MIN } });
  const eeg = yieldCase
    ? box({ key: 'eeg-msi', name: 'eeg-msi', tailnet: '204-eeg', online: false, badge: 'offline', hint: { gpu: 'RTX 5090 Laptop, power-limited to ~100 W', speed: 0.5, battery: true },
        gpu: { name: 'RTX 5090 Laptop, power-limited to ~100 W', utilPct: null, usedGB: null, totalGB: 24, tempC: null, oursGB: 0, othersGB: null }, ramPct: null,
        source: null, agentError: 'no answer in 2 s', seen: now - 3 * 3600_000, lastRun: { state: 'done', job: 'smoke', seen: now - 3 * 3600_000 } })
    : box({ key: 'eeg-msi', name: 'eeg-msi', tailnet: '204-eeg', badge: 'ready', hint: { gpu: 'RTX 5090 Laptop, power-limited to ~100 W', speed: 0.5, battery: true },
        gpu: { name: 'NVIDIA GeForce RTX 5090 Laptop GPU', utilPct: 1, usedGB: 0.7, totalGB: 23.9, tempC: 47, oursGB: 0, othersGB: 0.7, powerW: 21, powerLimitW: 109 }, ramPct: 24,
        power: 'AC', lastRun: { state: 'done', job: 'smoke', seen: now - 55 * MIN } });

  return {
    now,
    machine,
    slots,
    work: real?.work ?? fakeWork(now),
    outputs: outs,
    machines: [mac, linux, windows, eeg],
    sources: { agents: { 'linux-monster': { ok: true, at: now, error: null }, 'windows-monster': { ok: true, at: now, error: null }, 'eeg-msi': { ok: !yieldCase, at: now, error: yieldCase ? 'no answer in 2 s' : null } }, hub: { url: 'http://localhost:4310', ok: false, at: 0, error: 'ECONNREFUSED', used: yieldCase } },
    farm: {
      enabled: true,
      jobs,
      workers: [
        { node: 'linux-monster', state: 'busy', seen: now - 3000, speed: 1, job: yieldCase ? 'f-0196' : 'f-0193' },
        { node: 'windows-monster', state: yieldCase ? 'busy' : 'busy-foreign', seen: now - 4000, speed: 1, job: yieldCase ? 'f-0193' : null },
        { node: 'eeg-msi', state: yieldCase ? 'offline' : 'waiting', seen: now - (yieldCase ? 3 * 3600_000 : 5000), speed: 0.5, job: null },
      ],
    },
    nodes: [],
  };
}

function fakeWork(now) {
  return {
    streams: [
      { title: 'Swash v2: real water simulation', state: 'coding', detail: 'replacing the analytic swash with a 2D shallow-water sim on the GPU; early 8 s clip first', eta: '2–3 h', since: now - 70 * MIN },
      { title: 'Radio tower on far island', state: 'rendering', detail: 'night clip to judge the beacon blink', eta: '~40 min', since: now - 30 * MIN },
      { title: 'Sky + shadows', state: 'blocked', detail: 'needs the swash sim’s wet sand before the contact shadows can be judged', eta: '', since: now - 20 * MIN },
      { title: 'Beach dressing', state: 'done', detail: 'round 2 verified: patch gone, shadows and contact marks', since: now - 3 * 3600_000 },
    ],
    waitingOnUser: ['Radio tower: bigger? Today 208 m with a solid head', 'Sail emblem: keep or replace'],
  };
}

function fakeOutputs(now) {
  return [
    { path: '/mock/review/swash_642-650_1280.mp4', mtime: now - 2 * MIN, name: 'swash_642-650_1280.mp4', dir: 'sim3', video: true },
    { path: '/mock/review/tower_lamp_night_745.8.png', mtime: now - 9 * MIN, name: 'tower_lamp_night_745.8.png', dir: 'tower_lamp4', video: false },
  ];
}
