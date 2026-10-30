/**
 * ?mock: a fake /api Status, /api/history and /api/log (the JSDoc contract at the top of scripts/drift-dash.mjs), so
 * the console can be judged before the studio's boxes and the farm report all of it. Loaded only in mock mode (the
 * app imports it on demand).
 *
 *   ?mock          A BUSY NIGHT: a whole-show render in progress on the farm — the dome master (2048², 39 chunks of
 *                  20 s: 18 back, one rendering on linux-monster, one failed, the rest queued at low priority) and its
 *                  16:9 version (13 chunks of 60 s, one rendering on eeg-msi) — while the agents' review jobs go
 *                  first; this Mac renders a review clip with a stills job waiting and its memory nearly gone;
 *                  windows-monster is busy with ComfyUI (18 GB) and paused from the farm. Three hours of history
 *                  behind it: every machine's GPU use and throughput, the queue's depth, the finished jobs.
 *   ?mock=yield    the other states: linux-monster draining and syncing, windows-monster waiting for ComfyUI to let
 *                  go (our chunk yields), eeg-msi removed from the farm and offline, this Mac's slots free
 *
 * Progress moves with the wall clock, so the 3 s updates (and the DOM patching, the rolling numbers, the gliding bars)
 * can be watched. The work streams and the outputs are the real ones when /api answers (`real`), else a small
 * made-up set; the live previews are those outputs' images, a new one every 10 s.
 */
const MIN = 60_000;
const H = 3_600_000;
/** the mock's fixed origin: ids and the times of finished jobs hang off it, so they stay put from poll to poll */
const T0 = Date.now();
/** a fixed pseudo-random number in [0, 1) for a seed: the mock is the same on every load */
const rnd = (seed) => {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};
const SP = '/private/tmp/claude-501/-Users-flo-work-code/0797e262-d034-440d-bc9c-75e815284435/scratchpad';
const SHOW = '/Users/flo/work/code/shiver-me-timbers/out/drift/preview/de97f3f';
const P0 = { done: null, total: null, unit: null, fps: null, etaS: null };

const id = (minsAgo, tail) => `${new Date(T0 - minsAgo * MIN).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}-${tail}`;
const hex = (n) => Math.floor(rnd(n) * 0xffffff).toString(16).padStart(6, '0');
const base = (o) => ({ prefer: null, exitCode: null, base: 'de97f3f', estS: null, last: null, results: [], error: null, why: null, attempts: 0, samples: [], cls: null, claimedAt: null, priority: 'normal', outs: [], ...o });
const clip = (from, to, w, out) => ['node', 'scripts/drift-review-clip.mjs', '--from', String(from), '--to', String(to), '--width', String(w), '--out', out];
const stills = (shots, w, out) => ['node', 'scripts/drift-review-stills.mjs', shots, '--width', String(w), '--out', out];

/** a running job's fps samples over the last minutes, around `fps`, for frames `done` now */
function samplesFor(now, startedAt, fps, done, seed) {
  const s = [];
  for (let k = 120; k >= 1; k--) {
    const ts = now - k * 10_000;
    if (ts < startedAt + 40_000) continue;
    const f = fps * (1 + 0.1 * Math.sin(ts / 97_000 + seed) + (rnd(ts / 10_000 + seed) - 0.5) * 0.08);
    s.push([ts, Math.round(f * 100) / 100, Math.max(0, done - Math.round(((now - ts) / 1000) * fps))]);
  }
  return s;
}

/**
 * THE WHOLE-SHOW RENDERS: drift-farm-render's chunks, each a low-priority farm job whose output is
 * <out>/chunks/chunk_<from>-<to>.mp4. `live`: the chunk index rendering now and its box; `failed`: a chunk that broke
 */
function showChunks(now, { dir, flat, chunkS, total, size, doneUpTo, live, failed, boxes, perMin, seed }) {
  const t = now / 1000;
  const out = [];
  const n = Math.ceil(total / chunkS);
  for (let i = 0; i < n; i++) {
    const from = i * chunkS;
    const to = Math.min(total, from + chunkS);
    const frames = Math.round((to - from) * 30);
    const file = `${dir}/chunks/chunk_${from.toFixed(3)}-${to.toFixed(3)}.mp4`;
    const argv = flat
      ? ['node', 'scripts/drift-review-clip.mjs', '--from', String(from), '--to', String(to), '--fps', '30', '--width', String(size), '--channel', 'chrome', '--allow-long', '--allow-large', '--out', '{{out:0}}']
      : ['node', 'scripts/drift-render.mjs', '--size', String(size), '--fps', '30', '--from', String(from), '--to', String(to), '--channel', 'chrome', '--lanes', '1', '--out', '{{out:0}}'];
    const common = { id: id(170 - i * 0.01, hex(seed + i)), label: `${flat ? 'drift-review-clip.mjs' : 'drift-render.mjs'} ${from}–${to} s`, kind: flat ? 'clip' : 'long', argv, outs: [file], priority: 'low', submitter: { agent: 'show render', pid: 61000 + seed, host: 'Mac' }, createdAt: T0 - 172 * MIN, queuedAt: T0 - 171 * MIN, cls: flat ? `drift-review-clip.mjs:${size}` : `drift-render.mjs:${size}` };
    if (i < doneUpTo && i !== failed) {
      // back, one after another on the boxes over the last ~2.5 h
      const endedAt = T0 - (doneUpTo - i) * perMin * MIN + rnd(seed + i) * 2 * MIN;
      const startedAt = endedAt - perMin * boxes.length * MIN * (0.85 + rnd(seed + i * 3) * 0.3);
      out.push(base({ ...common, state: 'done', node: boxes[i % boxes.length], startedAt, claimedAt: startedAt - 25_000, endedAt, exitCode: 0, progress: { done: frames, total: frames, unit: 'frames', fps: frames / ((endedAt - startedAt) / 1000), etaS: 0 }, results: [{ path: file, bytes: 210_000_000 }] }));
    } else if (i === failed) {
      const endedAt = T0 - 41 * MIN;
      out.push(base({ ...common, state: 'failed', node: boxes[1 % boxes.length], startedAt: endedAt - 9 * MIN, endedAt, exitCode: 1, progress: { done: Math.round(frames * 0.35), total: frames, unit: 'frames', fps: null, etaS: null }, error: 'Chrome’s GPU process crashed (device lost); run the render again for the missing chunk', last: 'GPU process exited' }));
    } else if (i === live?.i) {
      // (stalled: its box yields to someone else's load — the frames stop where they were, no rate, no ETA)
      const fps = live.fps;
      const done = live.stalled ? Math.round(frames * 0.6) : Math.min(frames - 1, Math.floor((t % (frames / fps)) * fps));
      const startedAt = live.stalled ? T0 - 14 * MIN : now - (done / fps) * 1000 - 35_000;
      out.push(base({ ...common, state: 'running', node: live.box, startedAt, claimedAt: startedAt - 20_000, progress: { done, total: frames, unit: 'frames', fps: live.stalled ? 0 : fps, etaS: live.stalled ? null : (frames - done) / fps }, samples: live.stalled ? [] : samplesFor(now, startedAt, fps, done, seed), last: live.stalled ? 'waiting for the GPU: ComfyUI holds 18.1 GB (the policy allows 4 GB)' : `[${flat ? 'review' : 'render'}] ${done}/${frames}  ${fps.toFixed(2)} fps` }));
    } else {
      out.push(base({ ...common, state: 'queued', node: null, progress: P0, estS: Math.round(frames / (flat ? 1.2 : 2.1)), why: 'low priority: after the agents’ queued jobs' }));
    }
  }
  return out;
}

/** the farm's jobs: the agents' review jobs (queued, finished today) and the two whole-show renders */
function farmJobs(now, yieldCase, outs) {
  const img = outs.find((o) => !o.video)?.path ?? null;
  const vid = outs.find((o) => o.video)?.path ?? null;
  const jobs = [];
  // the dome master: on linux-monster (on windows-monster in the yield case, where it waits for ComfyUI)
  jobs.push(...showChunks(now, { dir: SHOW, flat: false, chunkS: 20, total: 770, size: 2048, doneUpTo: 18, live: { i: 18, box: yieldCase ? 'windows-monster' : 'linux-monster', fps: 2.1, stalled: yieldCase }, failed: 12, boxes: ['linux-monster', 'windows-monster', 'linux-monster', 'eeg-msi'], perMin: 7.5, seed: 100 }));
  // its 16:9 version: on eeg-msi
  jobs.push(...showChunks(now, { dir: `${SHOW}-flat2048`, flat: true, chunkS: 60, total: 770, size: 2048, doneUpTo: 9, live: yieldCase ? null : { i: 9, box: 'eeg-msi', fps: 1.2 }, failed: -1, boxes: ['eeg-msi', 'windows-monster'], perMin: 16, seed: 300 }));
  if (yieldCase) {
    jobs.push(base({ id: id(4, 'c03f11'), label: 'drift-review-stills.mjs tower_shots.json', kind: 'still', argv: stills(`${SP}/tower/tower_shots.json`, 1280, `${SP}/tower/r7`), state: 'preparing', node: 'linux-monster', submitter: { agent: 'tower agent', pid: 5521 }, createdAt: now - 4 * MIN, queuedAt: now - 3.5 * MIN, claimedAt: now - 70_000, progress: { ...P0, total: 14, unit: 'stills' }, estS: 240, last: 'npm ci: the lockfile changed' }));
  }
  // the agents' jobs in line: they go before the show's low-priority chunks
  jobs.push(base({ id: id(1, 'f70a2d'), label: 'drift-review-clip.mjs --from 760 --to 772', kind: 'clip', argv: clip(760, 772, 1280, `${SP}/sim4/swash_760-772_1280.mp4`), state: 'uploading', node: null, submitter: { agent: 'swash agent', pid: 7311 }, createdAt: T0 - 40_000, progress: P0 }));
  const queued = [
    ['b2e810', 'clip', clip(742, 760, 1280, `${SP}/tower/beacon_742-760_1280.mp4`), 31, 420, 'tower agent', null, 'high'],
    ['47aa03', 'still', stills(`${SP}/sky/sky_r7.json`, 1280, `${SP}/sky/r7`), 18, 180, 'sky agent', 'eeg-msi', 'normal'],
    ['d5f2b7', 'clip', clip(600, 612, 1280, `${SP}/sim4/waterline_600-612_1280.mp4`), 9, 380, 'swash agent', null, 'normal'],
    ['6aa0f4', 'still', stills(`${SP}/raft/raft_shots.json`, 1920, `${SP}/raft/r2`), 2, 150, 'raft agent', null, 'normal'],
  ];
  for (const [tail, kind, argv, ago, est, who, prefer, priority] of queued) {
    jobs.push(base({ id: id(ago, tail), label: argv.slice(1, 4).join(' '), kind, argv, state: 'queued', node: null, prefer, priority, submitter: { agent: who, pid: 4000 + ago }, createdAt: T0 - ago * MIN - 20_000, queuedAt: T0 - ago * MIN, progress: P0, estS: est, why: prefer ? `${prefer} busy with another job` : 'being handed out' }));
  }
  // THE REAL RHYTHM (the user's screenshot, 2026-10-30: real jobs are 20–90 s): runs of short back-to-back stills and
  // checks from a few agents on every box over the last hour — the timeline must group, zoom and still be readable
  const runs = [['review', 'linux-monster', 58, 9], ['farm-consistency', 'windows-monster', 52, 6], ['sim7', 'eeg-msi', 47, 8], ['review', 'windows-monster', 33, 7], ['claude 0797e262', 'linux-monster', 24, 5], ['sim7', 'eeg-msi', 19, 6], ['farm-precision', 'windows-monster', 12, 4], ['review', 'linux-monster', 9, 6]];
  runs.forEach(([who, node, startAgo, count], r) => {
    let t = T0 - startAgo * MIN;
    for (let i = 0; i < count; i++) {
      const runS = 20 + Math.round(rnd(r * 31 + i) * 70);
      const startedAt = t + Math.round(rnd(r * 17 + i) * 8000);
      const endedAt = startedAt + runS * 1000;
      t = endedAt + 2000;
      const failed = rnd(r * 7 + i * 3) < 0.08;
      const shots = 2 + Math.floor(rnd(r + i) * 4);
      jobs.push(base({
        id: id(startAgo - i, hex(900 + r * 40 + i)), label: `drift-review-stills.mjs ${who.split(' ')[0]}_${i}.json`, kind: 'still', argv: stills(`${SP}/${who.split(' ')[0]}/q${r}_${i}.json`, 1280, `${SP}/${who.split(' ')[0]}/q${r}`),
        state: failed ? 'failed' : 'done', node, submitter: { agent: who, pid: 7000 + r }, createdAt: startedAt - 30_000, queuedAt: startedAt - 25_000, claimedAt: startedAt - 4000, startedAt, endedAt,
        exitCode: failed ? 1 : 0, progress: { done: failed ? 1 : shots, total: shots, unit: 'stills', fps: null, etaS: null }, error: failed ? 'exit 1: page crashed while compiling shaders' : null,
        results: !failed && img ? [{ path: outs.filter((o) => !o.video)[(r * 5 + i) % Math.max(1, outs.filter((o) => !o.video).length)]?.path ?? img, bytes: 2_400_000 }] : [],
      }));
    }
  });
  // the agents' finished jobs today
  const fin = [
    ['0a7e41', 'still', stills(`${SP}/sky/sky_r6.json`, 1280, `${SP}/sky/r6`), 'done', 'eeg-msi', 24, 6, 12, null, 'sky agent', img],
    ['3c1f90', 'clip', clip(642, 650, 1280, `${SP}/sim3/waterline_642-650_1280.mp4`), 'done', 'linux-monster', 52, 6, 240, 0.71, 'swash agent', vid],
    ['e61c33', 'clip', clip(700, 712, 1280, `${SP}/tower/tower_lamp_700-712.mp4`), 'done', 'windows-monster', 86, 7, 360, 0.95, 'tower agent', vid],
    ['5b90a8', 'still', stills(`${SP}/tower/tower_shots.json`, 1280, `${SP}/tower/r6`), 'done', 'eeg-msi', 101, 6, 14, null, 'tower agent', img],
    ['7f18e2', 'clip', clip(518, 530, 1280, `${SP}/raft/streaks_518-530_1280.mp4`), 'done', 'linux-monster', 128, 9, 360, 0.66, 'raft agent', null],
    ['aa31c5', 'still', stills(`${SP}/sim3/beach_shots.json`, 1280, `${SP}/sim3/r1`), 'done', 'windows-monster', 140, 3, 8, null, 'swash agent', img],
    ['f4b6a0', 'clip', clip(310, 322, 1280, `${SP}/sky/clouds_310-322_1280.mp4`), 'done', 'eeg-msi', 152, 11, 360, 0.55, 'sky agent', null],
    ['21e4d9', 'still', stills(`${SP}/raft/raft_r1.json`, 1280, `${SP}/raft/r1`), 'done', 'linux-monster', 300, 4, 10, null, 'raft agent', null],
    ['4d7a5e', 'clip', clip(518, 524, 1280, `${SP}/raft/streaks_518-524_1280.mp4`), 'failed', 'eeg-msi', 66, 1, 30, null, 'raft agent', null, 'on battery: the queue refuses to render (plug the laptop in)', 3],
    ['b85e17', 'still', stills(`${SP}/sky/sky_r5.json`, 1280, `${SP}/sky/r5`), 'failed', 'linux-monster', 112, 2, 3, null, 'sky agent', null, 'exit 1: TypeError: d.sea.scene is undefined (post script)', 1],
    ['c9f3a2', 'still', stills(`${SP}/sky/sky_r4.json`, 1280, `${SP}/sky/r4`), 'cancelled', null, 84, 0, null, null, 'sky agent', null, 'cancelled: superseded by sky_r5', null],
  ];
  for (const [tail, kind, argv, state, node, endedAgo, runMin, total, fps, who, result, error, exit] of fin) {
    const endedAt = T0 - endedAgo * MIN;
    const startedAt = state === 'cancelled' ? null : endedAt - runMin * MIN;
    const done = state === 'done' ? total : state === 'failed' ? Math.round((total ?? 0) * 0.4) : null;
    jobs.push(base({
      id: id(endedAgo + runMin + 5, tail), label: argv.slice(1, 4).join(' '), kind, argv, state, node, submitter: { agent: who, pid: 3000 + endedAgo },
      createdAt: (startedAt ?? endedAt) - (3 + rnd(endedAgo) * 9) * MIN, queuedAt: (startedAt ?? endedAt) - (2 + rnd(endedAgo) * 8) * MIN, claimedAt: startedAt ? startedAt - 40_000 : null, startedAt, endedAt,
      exitCode: state === 'done' ? 0 : exit ?? null, progress: { done, total, unit: kind === 'still' ? 'stills' : 'frames', fps: state === 'done' ? fps : null, etaS: null }, error: error ?? null,
      results: result ? [{ path: result, bytes: 18_400_000 }] : [],
    }));
  }
  return jobs;
}

export function mockStatus(now, scenario = 'default', real = null) {
  const yieldCase = scenario === 'yield';
  const t = now / 1000;
  const outs = real?.outputs?.length ? real.outputs : fakeOutputs(now);

  // this Mac: one review clip in its one slot, 240 frames at ~0.7 fps, starting over every ~6 min
  const clipDone = Math.max(30, Math.floor(((t % 360) / 360) * 240));
  const lines = Math.floor(clipDone / 30);
  const fpsHistory = Array.from({ length: lines }, (_, i) => Math.round((0.35 + 0.4 * (1 - Math.exp(-(i + 1) / 2.5))) * 10) / 10);
  const held = yieldCase ? [] : [{
    slot: '0', pid: 48211, started: now - (t % 360) * 1000 - 40_000,
    label: 'review clip 642–650 s, 1280 px  →  swash_642-650_1280.mp4',
    cmd: `node scripts/drift-review-clip.mjs --from 642 --to 650 --width 1280 --shot {"fov":55,"yaw":22,"pitch":-9} --out ${SP}/sim4/swash_642-650_1280.mp4 --port 5372`,
    done: lines * 30, total: 240, unit: 'frames', etaS: (240 - lines * 30) / (fpsHistory.at(-1) ?? 0.7), last: `[review] ${lines * 30}/240  ${fpsHistory.at(-1)} fps`,
    info: { frames: 240, from: 642, to: 650, fps: 30, width: 1280, height: 720, ss: 5.82 }, fpsHistory,
  }];
  const slots = {
    limit: 1,
    held,
    waiting: yieldCase ? [] : [{ pid: 48377, label: 'review stills (shots_tower_dusk.json)', cmd: `node scripts/drift-review-stills.mjs ${SP}/tower/shots_tower_dusk.json --width 1280 --out ${SP}/tower/dusk`, since: T0 - 4 * MIN - 10_000 }],
    recent: [
      { label: 'review clip 700–712 s, 1280 px  →  tower_lamp_700-712.mp4', cmd: `node scripts/drift-review-clip.mjs --from 700 --to 712 --width 1280 --out ${SP}/tower/tower_lamp_700-712.mp4`, out: `${SP}/tower/tower_lamp_700-712.mp4`, exit: '0', started: T0 - 19 * MIN, ended: T0 - 9 * MIN, slot: '0', done: 360, total: 360, unit: 'frames', fps: 0.62, info: { frames: 360, from: 700, to: 712, fps: 30, width: 1280, height: 720, ss: 5.82 } },
      { label: 'review stills (sky_r5.json)', cmd: `node scripts/drift-review-stills.mjs ${SP}/sky/sky_r5.json --width 1280 --out ${SP}/sky/r5`, out: `${SP}/sky/r5`, exit: '1', started: T0 - 29 * MIN, ended: T0 - 26 * MIN, slot: '1', done: 2, total: 6, unit: 'stills', fps: null, info: null },
    ],
  };
  const machine = {
    cores: 14, load: yieldCase ? [9.4, 10.1, 11.8] : [17.2, 15.4, 12.8], memFreePct: yieldCase ? 12 : 7, ramTotalGB: 36,
    gpuPct: yieldCase ? 18 : 97, gpuMemGB: yieldCase ? 9.6 : 24.4, gpuName: 'Apple M3 Max', power: 'AC', headlessPages: held.length,
    // (a moving set, as ps reports it: the console must keep its list steady anyway)
    top: [
      { pid: 48230, cpu: 88.1, memMB: 1460, name: 'headless Chrome GPU (render)' },
      { pid: 16695, cpu: 40 + 12 * Math.sin(t / 7), memMB: 211, name: 'Loom MCP server' },
      { pid: 85279, cpu: 36 + 10 * Math.sin(t / 5), memMB: 98, name: 'Loom MCP server' },
      { pid: 85160, cpu: 38 + 15 * Math.sin(t / 4), memMB: 949, name: 'Claude app' },
      { pid: 405, cpu: 30 + 14 * Math.sin(t / 3), memMB: 77, name: 'WindowServer' },
      t % 9 < 4 ? { pid: 9911, cpu: 33 + 8 * Math.sin(t), memMB: 412, name: 'typecheck (tsc)' } : { pid: 512, cpu: 31, memMB: 300, name: 'Google Chrome (yours)' },
    ],
  };

  const jobs = farmJobs(now, yieldCase, outs);
  const runOn = (node) => jobs.find((j) => (j.state === 'running' || j.state === 'preparing') && j.node === node) ?? null;
  const box = (o) => ({
    tailnet: null, os: 'windows', online: true, why: null, services: [], job: null, farm: null, waiting: null, last: null, error: null, lastRun: null,
    power: null, commit: 'de97f3f', bundle: '20261030', seen: now - 3000, source: 'agent', agentError: null, farmState: 'accepting', ...o,
  });
  const mac = {
    key: 'this-mac', name: 'laubs-mbp', tailnet: null, os: 'macOS', online: true, self: true, badge: held.length ? 'rendering' : 'ready', why: null,
    gpu: { name: 'Apple M3 Max', utilPct: machine.gpuPct, usedGB: machine.gpuMemGB, totalGB: null, tempC: null, oursGB: null, othersGB: null },
    ramPct: 100 - machine.memFreePct, ramTotalGB: 36, cpuPct: Math.round((100 * machine.load[0]) / machine.cores), services: [],
    slots: { held: held.length, limit: 1, waiting: slots.waiting.length, jobs: held.map((h) => h.label) }, job: null, hub: false,
  };
  const linuxJob = runOn('linux-monster');
  const linux = yieldCase
    ? box({ key: 'linux-monster', name: 'linux-monster', tailnet: 'rnatwoofour-linux', os: 'linux', badge: 'syncing', farmState: 'draining', hint: { gpu: 'RTX 4090', speed: 1, battery: false },
        gpu: { name: 'NVIDIA GeForce RTX 4090', utilPct: 3, usedGB: 1.1, totalGB: 24, tempC: 44, oursGB: 0, othersGB: 1.1, powerW: 61, powerLimitW: 450 }, ramPct: 22, ramTotalGB: 62.6, cpuPct: 31,
        farm: linuxJob, last: 'npm ci: the lockfile changed' })
    : box({ key: 'linux-monster', name: 'linux-monster', tailnet: 'rnatwoofour-linux', os: 'linux', badge: 'rendering', hint: { gpu: 'RTX 4090', speed: 1, battery: false },
        gpu: { name: 'NVIDIA GeForce RTX 4090', utilPct: 96, usedGB: 15.6, totalGB: 24, tempC: 72, oursGB: 14.2, othersGB: 1.4, powerW: 398 + Math.round(8 * Math.sin(t / 5)), powerLimitW: 450 }, ramPct: 34, ramTotalGB: 62.6, cpuPct: 41,
        services: [{ name: 'sd-webrtc', state: 'healthy', vramGB: 1.2 }, { name: 'mediamtx', state: 'healthy', vramGB: null }],
        farm: linuxJob, last: linuxJob?.last });
  const comfy = [{ name: 'ComfyUI', state: 'busy', vramGB: 18.1 }, { name: 'sd-webrtc', state: 'healthy', vramGB: 2.2 }, { name: 'mediamtx', state: 'healthy', vramGB: null }, { name: 'frame-server', state: 'healthy', vramGB: null }, { name: 'studio-tts', state: 'healthy', vramGB: null }, { name: 'vgw-agent', state: 'healthy', vramGB: 0.4 }];
  const winJob = runOn('windows-monster');
  const windows = yieldCase
    ? box({ key: 'windows-monster', name: 'windows-monster', tailnet: 'desktop-0kl6e4p', badge: 'waiting-foreign', hint: { gpu: 'RTX 4090', speed: 1, battery: false },
        gpu: { name: 'NVIDIA GeForce RTX 4090', utilPct: 84, usedGB: 20.3, totalGB: 24, tempC: 69, oursGB: 0, othersGB: 20.3, powerW: 331, powerLimitW: 450 }, ramPct: 55, ramTotalGB: 47.8, cpuPct: 22, services: comfy,
        farm: winJob, waiting: { why: 'ComfyUI holds 18.1 GB of VRAM (the policy allows 4 GB)', since: new Date(now - 7 * MIN).toISOString(), foreign: [{ name: 'ComfyUI', memGB: 18.1 }] }, last: winJob?.last })
    : box({ key: 'windows-monster', name: 'windows-monster', tailnet: 'desktop-0kl6e4p', badge: 'busy-foreign', farmState: 'paused', why: '20.3 GB of VRAM in use, GPU 81% busy', hint: { gpu: 'RTX 4090', speed: 1, battery: false },
        gpu: { name: 'NVIDIA GeForce RTX 4090', utilPct: 81, usedGB: 20.3, totalGB: 24, tempC: 67, oursGB: 0, othersGB: 20.3, powerW: 312 + Math.round(20 * Math.sin(t / 4)), powerLimitW: 450 }, ramPct: 52, ramTotalGB: 47.8, cpuPct: 18, services: comfy,
        lastRun: { state: 'done', job: 'drift-render.mjs 280–300 s', seen: now - 70 * MIN } });
  const eegJob = runOn('eeg-msi');
  const eeg = yieldCase
    ? box({ key: 'eeg-msi', name: 'eeg-msi', tailnet: '204-eeg', online: false, badge: 'offline', farmState: 'removed', hint: { gpu: 'RTX 5090 Laptop, power-limited to ~100 W', speed: 0.5, battery: true },
        gpu: { name: 'RTX 5090 Laptop, power-limited to ~100 W', utilPct: null, usedGB: null, totalGB: 24, tempC: null, oursGB: 0, othersGB: null }, ramPct: null,
        source: null, agentError: 'no answer in 2 s', seen: now - 3 * H, lastRun: { state: 'done', job: 'smoke', seen: now - 3 * H } })
    : box({ key: 'eeg-msi', name: 'eeg-msi', tailnet: '204-eeg', badge: 'rendering', hint: { gpu: 'RTX 5090 Laptop, power-limited to ~100 W', speed: 0.5, battery: true },
        gpu: { name: 'NVIDIA GeForce RTX 5090 Laptop GPU', utilPct: 99, usedGB: 11.2, totalGB: 23.9, tempC: 78, oursGB: 10.5, othersGB: 0.7, powerW: 96 + Math.round(4 * Math.sin(t / 6)), powerLimitW: 109 }, ramPct: 41, ramTotalGB: 63.1, cpuPct: 22,
        power: 'AC', farm: eegJob, last: eegJob?.last });

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
        { node: 'linux-monster', state: 'busy', farmState: yieldCase ? 'draining' : 'accepting', seen: now - 3000, speed: 1, job: linuxJob?.id ?? null },
        { node: 'windows-monster', state: yieldCase ? 'busy' : 'busy-foreign', farmState: yieldCase ? 'accepting' : 'paused', seen: now - 4000, speed: 0.98, job: winJob?.id ?? null },
        { node: 'eeg-msi', state: yieldCase ? 'offline' : 'busy', farmState: yieldCase ? 'removed' : 'accepting', seen: now - (yieldCase ? 3 * H : 5000), speed: 0.52, job: eegJob?.id ?? null },
      ],
    },
    nodes: [],
  };
}

/**
 * /api/history: each machine every 15 s for 30 min and every 60 s for 3 h ([ms epoch, GPU %, our VRAM GB, others' GB,
 * badge, our fps there, GPU W]), the fleet likewise ([ms epoch, queued, running, frames/min, GPU W]), and this Mac's
 * finished slot jobs. Three hours of a busy night: the show's chunks on linux-monster all along, on windows-monster
 * until ComfyUI took it ~70 min ago, the 16:9 chunks on eeg-msi; this Mac's review clips in bursts
 */
export function mockHistory(now, scenario = 'default') {
  const yieldCase = scenario === 'yield';
  const at = (minsAgo) => {
    const i = minsAgo;
    const n = rnd(Math.floor(now / 60000) - i);
    const mac = yieldCase && i < 20 ? [8, null, null, 'ready', 0, null] : (i % 40) < 26 ? [Math.round(85 + n * 14), null, null, 'rendering', 0.62, null] : [Math.round(4 + n * 10), null, null, 'ready', 0, null];
    const lin = yieldCase && i < 8 ? [3, 0, 1.1, 'syncing', 0, 61] : [Math.round(92 + n * 7), 14.2, 1.4, 'rendering', 2.1 * (0.92 + n * 0.16), Math.round(380 + n * 30)];
    const win = i < 70 ? (Math.sin(i / 6) > -0.3 ? [Math.round(55 + n * 40), 0, 20.3, yieldCase && i < 20 ? 'waiting-foreign' : 'busy-foreign', 0, Math.round(250 + n * 90)] : [Math.round(n * 6), 0, 2.6, 'ready', 0, 70]) : [Math.round(90 + n * 8), 13.8, 0.6, 'rendering', 2.0 * (0.92 + n * 0.16), Math.round(370 + n * 40)];
    const eeg = yieldCase ? [null, null, null, 'offline', 0, null] : i > 160 ? [Math.round(n * 3), 0, 0.7, 'ready', 0, 22] : [Math.round(93 + n * 6), 10.5, 0.7, 'rendering', 1.2 * (0.9 + n * 0.2), Math.round(92 + n * 12)];
    return { mac, lin, win, eeg };
  };
  const row = (t, v) => [t, v[0], v[1], v[2], v[3], Math.round(v[4] * 100) / 100, v[5]];
  const util = { 'this-mac': [], 'linux-monster': [], 'windows-monster': [], 'eeg-msi': [] };
  const long = { 'this-mac': [], 'linux-monster': [], 'windows-monster': [], 'eeg-msi': [] };
  const fleet = [];
  const fleetLong = [];
  const fleetRow = (t, s, minsAgo) => {
    const fpm = Math.round(60 * [s.mac, s.lin, s.win, s.eeg].reduce((a, v) => a + v[4], 0));
    const watts = [s.lin, s.win, s.eeg].reduce((a, v) => a + (v[5] ?? 0), 0);
    const queued = Math.max(4, Math.round(40 - (180 - minsAgo) * 0.07 + 4 * Math.sin(minsAgo / 9)));
    const running = [s.mac, s.lin, s.win, s.eeg].filter((v) => /^rendering|^syncing|^waiting-foreign/.test(v[3])).length;
    return [t, queued, running, fpm, watts];
  };
  for (let k = 179; k >= 0; k--) {
    const t = now - k * 60_000;
    const s = at(k);
    long['this-mac'].push(row(t, s.mac));
    long['linux-monster'].push(row(t, s.lin));
    long['windows-monster'].push(row(t, s.win));
    long['eeg-msi'].push(row(t, s.eeg));
    fleetLong.push(fleetRow(t, s, k));
  }
  for (let k = 119; k >= 0; k--) {
    const t = now - k * 15_000;
    const s = at(Math.floor(k / 4));
    util['this-mac'].push(row(t, s.mac));
    util['linux-monster'].push(row(t, s.lin));
    util['windows-monster'].push(row(t, s.win));
    util['eeg-msi'].push(row(t, s.eeg));
    fleet.push(fleetRow(t, s, k / 4));
  }
  const job = (k, ago, run, cmd, exit, done, total, unit, fps, info) => ({ key: `0:${T0 - (ago + run) * MIN}`, label: cmd, cmd, out: cmd.match(/--out (\S+)/)?.[1] ?? null, exit, started: T0 - (ago + run) * MIN, ended: T0 - ago * MIN, slot: String(k), done, total, unit, fps, info });
  const jobs = [
    job(0, 40, 9, `node scripts/drift-review-clip.mjs --from 560 --to 568 --width 1280 --out ${SP}/sim3/run-up_560-568_1280.mp4`, '0', 240, 240, 'frames', 0.48, { frames: 240, from: 560, to: 568, fps: 30, width: 1280, height: 720, ss: 5.82 }),
    job(0, 58, 4, `node scripts/drift-review-stills.mjs ${SP}/sky/diag5.json --width 1280 --out ${SP}/sky/diag5`, '0', 5, 5, 'stills', null, null),
    job(0, 96, 11, `node scripts/drift-review-clip.mjs --from 740 --to 752 --width 640 --crf 12 --out out/drift/review/tower_lamp_clip_740-752.mp4`, '0', 360, 360, 'frames', 1.4, { frames: 360, from: 740, to: 752, fps: 30, width: 640, height: 360, ss: 5.82 }),
    job(0, 130, 3, `node scripts/drift-review-stills.mjs ${SP}/r2c/v.json --width 1280 --out ${SP}/r2c`, '1', 1, 4, 'stills', null, null),
    job(0, 150, 8, `node scripts/drift-review-clip.mjs --from 604 --to 612 --width 1280 --out ${SP}/sky/sun_604-612_1280.mp4`, '0', 240, 240, 'frames', 0.55, { frames: 240, from: 604, to: 612, fps: 30, width: 1280, height: 720, ss: 5.82 }),
  ];
  return { now, stepS: 15, util, fleet, long: { stepS: 60, util: long, fleet: fleetLong }, jobs };
}

/** the live frame of a machine's running job: one of the real outputs' images, a new one every 10 s */
export function mockPreview(m, d) {
  const busy = m.self ? (d.slots?.held?.length ?? 0) > 0 : !!m.farm && (m.farm.state === 'running' || m.farm.state === 'preparing') && m.badge !== 'waiting-foreign';
  const imgs = (d.outputs ?? []).filter((o) => !o.video && !String(o.path).startsWith('/mock/'));
  if (!busy || !imgs.length) return null;
  const k = ['this-mac', 'linux-monster', 'windows-monster', 'eeg-msi'].indexOf(m.key) * 3;
  const o = imgs[(Math.floor(d.now / 10_000) + k) % imgs.length];
  return `/file?p=${encodeURIComponent(o.path)}&v=${Math.round(o.mtime)}`;
}

/** /api/log for an opened row: a plausible tail of the job's output */
export function mockLog(j, now) {
  const lines = [`${new Date(j.startedAt ?? now).toISOString()}  ${Array.isArray(j.src) ? j.src.join(' ') : j.src}`];
  if (j.kind === 'still') {
    for (let i = 1; i <= (j.done ?? 0); i++) lines.push(`[review] shot_${String(i).padStart(2, '0')}.png  t ${600 + i * 4}.0 s  ${(9 + rnd(i) * 4).toFixed(1)} s`);
  } else {
    lines.push(`[render] ${j.total ?? '?'} frames, ${j.settings?.join(', ') ?? ''}`);
    const step = j.unit === 'frames' && j.total > 1000 ? 120 : 30;
    for (let n = step; n <= (j.done ?? 0); n += step) lines.push(`[${j.kind === 'long' ? 'render' : 'review'}] ${n}/${j.total}  ${fpsAt(j, n).toFixed(2)} fps`);
  }
  if (j.error) lines.push(`ERROR ${j.error}`);
  if (j.state === 'done') lines.push(`[farm] done: ${j.outs?.length ?? 0} file(s) sent back`);
  return lines.slice(-200);
}
const fpsAt = (j, n) => (j.avgFps ?? j.fpsNow ?? 1) * (0.9 + 0.2 * rnd(n));

function fakeWork(now) {
  return {
    streams: [
      { title: 'Swash v2: real water simulation', state: 'coding', detail: 'replacing the analytic swash with a 2D shallow-water sim on the GPU; early 8 s clip first', eta: '2–3 h', since: now - 70 * MIN },
      { title: 'Radio tower on far island', state: 'rendering', detail: 'night clip to judge the beacon blink', eta: '~40 min', since: now - 30 * MIN },
      { title: 'Sky + shadows', state: 'blocked', detail: 'needs the swash sim’s wet sand before the contact shadows can be judged', eta: '', since: now - 20 * MIN },
      { title: 'Beach dressing', state: 'done', detail: 'round 2 verified: patch gone, shadows and contact marks', since: now - 3 * H },
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
