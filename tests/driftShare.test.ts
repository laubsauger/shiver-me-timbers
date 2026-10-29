/**
 * Sharing the studio's GPUs (scripts/drift-share.mjs; the user, 2026-10-29: "we're not assuming that we are always
 * going to be the only users of these machines"). The same 4090s run ComfyUI, sd-webrtc, FluxRT and games. What must
 * hold, or a render takes someone's work down (or never starts):
 *   - WHOSE PROCESS: our render's Chrome GPU process is ours through its ancestry (Chrome → node drift-render.mjs),
 *     even though it is just "chrome" to nvidia-smi; the user's own Chrome is not; the desktop (Xorg, dwm) is never
 *     yielded to.
 *   - YIELD: ComfyUI holding 18 GB → the next chunk waits; nothing but the desktop → it starts. Utilisation counts
 *     against others only while nothing of ours is on the card (with ours on it, the load is ours).
 *   - WINDOWS: WDDM gives nvidia-smi no per-process memory; the GPU counters do, and without them a heavy app by name
 *     still counts.
 *   - THE WAIT re-checks until the card is free, and --force never waits.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  agentOf, classify, needVramGB, parseNvidiaSmiXml, parsePsTable, parseWinPs, policyOf, readYieldPolicy, shareDecision, shareOf, waitForGpu, WIN_GPU_MARK,
  YIELD_DEFAULTS, type GpuShare,
} from '../scripts/drift-share.mjs';

/** nvidia-smi -q -x as a 580-series driver prints it, cut to the parts read (plus neighbours that must not confuse it) */
function smiXml({ used, util, procs }: { used: number; util: number; procs: [number, string, string, string][] }): string {
  return `<?xml version="1.0" ?>
<!DOCTYPE nvidia_smi_log SYSTEM "nvsmi_device_v12.dtd">
<nvidia_smi_log>
	<driver_version>580.95.05</driver_version>
	<attached_gpus>1</attached_gpus>
	<gpu id="00000000:01:00.0">
		<product_name>NVIDIA GeForce RTX 4090</product_name>
		<fb_memory_usage>
			<total>24564 MiB</total>
			<reserved>0 MiB</reserved>
			<used>${used} MiB</used>
			<free>${24564 - used} MiB</free>
		</fb_memory_usage>
		<bar1_memory_usage>
			<total>256 MiB</total>
			<used>2 MiB</used>
			<free>254 MiB</free>
		</bar1_memory_usage>
		<utilization>
			<gpu_util>${util} %</gpu_util>
			<memory_util>40 %</memory_util>
			<encoder_util>0 %</encoder_util>
		</utilization>
		<processes>
${procs.map(([pid, type, path, mem]) => `			<process_info>
				<gpu_instance_id>N/A</gpu_instance_id>
				<pid>${pid}</pid>
				<type>${type}</type>
				<process_name>${path}</process_name>
				<used_memory>${mem}</used_memory>
			</process_info>`).join('\n')}
		</processes>
		<accounted_processes>
		</accounted_processes>
	</gpu>
</nvidia_smi_log>
`;
}

/** a Linux render node's `ps -Ao pid=,ppid=,pcpu=,rss=,command=` while the queue renders */
const PS = `    1     0  0.0  12000 /sbin/init
 1442     1  0.3 120000 /usr/lib/xorg/Xorg :0 -seat seat0
 2001     1 99.0 9000000 /home/studio/ComfyUI/venv/bin/python main.py --listen 0.0.0.0 --port 8188
 3000     1  2.0  80000 /usr/bin/node /home/studio/shiver-me-timbers/scripts/drift-queue.mjs out/drift/node/queue-preview-2k.json
 3010  3000  1.0  90000 /usr/bin/node /home/studio/shiver-me-timbers/scripts/drift-slot.mjs --weight 1 -- /usr/bin/node /home/studio/shiver-me-timbers/scripts/drift-render.mjs
 3020  3010 50.0 400000 /usr/bin/node /home/studio/shiver-me-timbers/scripts/drift-render.mjs --size 2048 --from 0 --to 60
 3100  3020 10.0 300000 /opt/google/chrome/chrome --headless --user-data-dir=/tmp/playwright_chromiumdev_profile-AbC123 --remote-debugging-pipe
 3110  3100 40.0 2000000 /opt/google/chrome/chrome --type=gpu-process --headless --enable-unsafe-webgpu
 3200  3020 30.0 200000 ffmpeg -f rawvideo -pix_fmt rgba -s 2048x2048 -i pipe:0 -c:v libx264 out.mp4
 3150  3020  5.0  90000 /usr/bin/node /home/studio/shiver-me-timbers/scripts/cine-sink.mjs --port 0
 4000     1  5.0 500000 /opt/google/chrome/chrome --user-data-dir=/home/studio/.config/google-chrome
 4010  4000  3.0 300000 /opt/google/chrome/chrome --type=gpu-process
 5000     1  1.0 300000 /opt/google/chrome/chrome --headless --user-data-dir=/tmp/playwright_chromiumdev_profile-Orphan
`;
const table = parsePsTable(PS);
const XORG: [number, string, string, string] = [1442, 'G', '/usr/lib/xorg/Xorg', '412 MiB'];
const COMFY: [number, string, string, string] = [2001, 'C', '/home/studio/ComfyUI/venv/bin/python', '18432 MiB'];
const OUR_GPU: [number, string, string, string] = [3110, 'G', '/opt/google/chrome/chrome', '6144 MiB'];
const share = (procs: [number, string, string, string][], used: number, util: number): GpuShare => shareOf(parseNvidiaSmiXml(smiXml({ used, util, procs })), table)!;

describe('nvidia-smi -q -x', () => {
  it('reads the card, its memory, its load and every process on it, graphics and compute', () => {
    const p = parseNvidiaSmiXml(smiXml({ used: 18900, util: 97, procs: [XORG, COMFY] }));
    expect(p.driver).toBe('580.95.05');
    expect(p.gpus).toHaveLength(1);
    expect(p.gpus[0]).toMatchObject({ name: 'NVIDIA GeForce RTX 4090', totalMB: 24564, usedMB: 18900, freeMB: 5664, utilPct: 97 });
    expect(p.gpus[0].procs.map((x) => [x.pid, x.type, x.memMB])).toEqual([[1442, 'G', 412], [2001, 'C', 18432]]);
  });

  it('Windows (WDDM) gives no per-process memory: N/A is "unknown", not 0', () => {
    const p = parseNvidiaSmiXml(smiXml({ used: 3000, util: 4, procs: [[812, 'C+G', 'C:\\Windows\\System32\\dwm.exe', 'N/A']] }));
    expect(p.gpus[0].procs[0].memMB).toBeNull();
  });
});

describe('ours, the desktop, and everyone else', () => {
  it('our render\'s Chrome GPU process is ours through its parents (Chrome → node drift-render.mjs)', () => {
    expect(classify(3110, '/opt/google/chrome/chrome', table).kind).toBe('ours');
    // cine-sink's encoder too: it is drift-render's grandchild
    expect(classify(3200, 'ffmpeg', table).kind).toBe('ours');
  });

  it('a render Chrome whose node parent died is still ours (Playwright\'s throwaway profile)', () => {
    expect(classify(5000, '/opt/google/chrome/chrome', table).kind).toBe('ours');
  });

  it('the user\'s own Chrome is not ours, and is named so', () => {
    expect(classify(4010, '/opt/google/chrome/chrome', table)).toMatchObject({ kind: 'foreign', label: 'Chrome (not ours)', heavy: false });
  });

  it('ComfyUI is named and counts as a heavy GPU user; the X server is the desktop', () => {
    expect(classify(2001, '/home/studio/ComfyUI/venv/bin/python', table)).toMatchObject({ kind: 'foreign', label: 'ComfyUI', heavy: true });
    expect(classify(1442, '/usr/lib/xorg/Xorg', table).kind).toBe('system');
  });

  it('an unknown program is named by its executable', () => {
    expect(classify(9999, 'C:\\Games\\Foo\\FooGame.exe', new Map()).label).toBe('FooGame');
  });
});

describe('yield: may the next chunk start', () => {
  const policy = { ...YIELD_DEFAULTS };

  it('ComfyUI holding 18 GB → wait, and say who and how much', () => {
    const d = shareDecision(share([XORG, COMFY], 18900, 3), policy, 10);
    expect(d.state).toBe('busy-foreign');
    expect(d.canStart).toBe(false);
    expect(d.why).toMatch(/ComfyUI 18\.0 GB/);
    expect(d.foreign[0]).toEqual({ name: 'ComfyUI', memGB: 18 });
  });

  it('nothing but the desktop → start', () => {
    const d = shareDecision(share([XORG], 412, 2), policy, 10);
    expect(d.state).toBe('idle');
    expect(d.canStart).toBe(true);
  });

  it('a game at full load with little memory → wait (utilisation, while nothing of ours is on the card)', () => {
    const d = shareDecision(share([XORG, [7000, 'G', '/home/studio/.steam/steamapps/common/Hades/Hades', '2048 MiB']], 2460, 88), policy, 10);
    expect(d.canStart).toBe(false);
    expect(d.why).toMatch(/88% busy.*Hades/);
  });

  it('our own render at 99% is not someone else\'s load', () => {
    const d = shareDecision(share([XORG, OUR_GPU], 6556, 99), policy, 10);
    expect(d.state).toBe('rendering');
  });

  it('ComfyUI starting while we render → rendering+shared (reported; the chunk is not stopped)', () => {
    expect(shareDecision(share([XORG, OUR_GPU, COMFY], 24900, 99), policy, 10).state).toBe('rendering+shared');
  });

  it('too little free VRAM for an 8K lane → wait, though no one else is over the policy', () => {
    const d = shareDecision(share([XORG, [7100, 'C', '/usr/bin/python3', '3500 MiB']], 4500, 5), policy, needVramGB({ size: 8192, lanes: 1 }));
    expect(d.canStart).toBe(false);
    expect(d.why).toMatch(/needs ~22 GB/);
    // the same card is enough for a 2K preview's lane
    expect(shareDecision(share([XORG, [7100, 'C', '/usr/bin/python3', '3500 MiB']], 4500, 5), policy, needVramGB({ size: 2048 })).canStart).toBe(true);
  });

  it('no NVIDIA card (the Mac): nothing to yield to', () => {
    expect(shareDecision(null, policy, 22)).toMatchObject({ state: 'idle', canStart: true });
  });
});

describe('Windows: WDDM, and the GPU counters', () => {
  const WIN_PS_OUT = [
    ['4', '0', '1000000', 'System', ''],
    ['812', '700', '90000000', 'dwm.exe', '"dwm.exe"'],
    ['6400', '6300', '900000000', 'python.exe', 'C:\\AI\\ComfyUI_windows_portable\\python_embeded\\python.exe -s ComfyUI\\main.py --windows-standalone-build'],
    ['7000', '6900', '400000000', 'chrome.exe', '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --type=gpu-process --field-trial-handle=1'],
  ].map((f) => f.join('\t')).join('\r\n') + `\r\n${WIN_GPU_MARK}\r\npid_812_luid_0x00000000_0x0000F00D_phys_0 335544320\r\npid_6400_luid_0x00000000_0x0000F00D_phys_0 18253611008\r\npid_7000_luid_0x00000000_0x0000F00D_phys_0 268435456\r\n`;
  const smi = parseNvidiaSmiXml(smiXml({ used: 18900, util: 2, procs: [[812, 'C+G', 'C:\\Windows\\System32\\dwm.exe', 'N/A'], [6400, 'C', 'C:\\AI\\ComfyUI_windows_portable\\python_embeded\\python.exe', 'N/A'], [7000, 'C+G', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'N/A']] }));

  it('reads the CIM process table (tab-separated, CRLF) and the dedicated memory per process', () => {
    const { table: t, gpuMem } = parseWinPs(WIN_PS_OUT);
    expect(t.get(6400)).toMatchObject({ ppid: 6300 });
    expect(Math.round(gpuMem.get(6400)!)).toBe(17408);
    expect(Math.round(gpuMem.get(812)!)).toBe(320);
  });

  it('with the counters: ComfyUI\'s 17 GB counts, dwm (the desktop) does not → wait', () => {
    const { table: t, gpuMem } = parseWinPs(WIN_PS_OUT);
    const s = shareOf(smi, t, gpuMem)!;
    expect(s.memKnown).toBe(true);
    const d = shareDecision(s, YIELD_DEFAULTS, 10);
    expect(d.canStart).toBe(false);
    expect(d.foreign.map((f) => f.name)).toEqual(['ComfyUI', 'Chrome (not ours)']);
    expect(d.foreignGB).toBe(17.3);
  });

  it('without them, and nothing of ours on the card: what is used counts as theirs', () => {
    const s = shareOf(smi, parseWinPs(WIN_PS_OUT).table)!;
    expect(s.memKnown).toBe(false);
    expect(shareDecision(s, YIELD_DEFAULTS, 10).foreignGB).toBe(18.5);
  });

  it('without them, while ours renders: a heavy app by name still makes it shared, a browser does not', () => {
    const tbl = parseWinPs(WIN_PS_OUT).table;
    tbl.set(8000, { pid: 8000, ppid: 1, cpuPct: null, rssMB: 1, cmd: 'node C:\\drift\\scripts\\drift-render.mjs' });
    tbl.set(8100, { pid: 8100, ppid: 8000, cpuPct: null, rssMB: 1, cmd: 'chrome.exe --type=gpu-process' });
    const ours: [number, string, string, string] = [8100, 'C+G', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'N/A'];
    const withComfy = parseNvidiaSmiXml(smiXml({ used: 23000, util: 99, procs: [ours, [6400, 'C', 'C:\\AI\\ComfyUI_windows_portable\\python_embeded\\python.exe', 'N/A']] }));
    expect(shareDecision(shareOf(withComfy, tbl), YIELD_DEFAULTS, 10).state).toBe('rendering+shared');
    const withBrowser = parseNvidiaSmiXml(smiXml({ used: 9000, util: 99, procs: [ours, [7000, 'C+G', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'N/A']] }));
    expect(shareDecision(shareOf(withBrowser, tbl), YIELD_DEFAULTS, 10).state).toBe('rendering');
  });
});

describe('the policy (drift-node.json "yield")', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drift-share-test-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('defaults when the machine has none', () => {
    expect(readYieldPolicy(dir)).toEqual(YIELD_DEFAULTS);
  });

  it('a machine\'s own numbers over the defaults', () => {
    writeFileSync(join(dir, 'drift-node.json'), '\uFEFF{ "bundle": "x", "yield": { "foreignVramGB": 2, "needVramGB": 20 } }\r\n');
    expect(readYieldPolicy(dir)).toEqual({ ...YIELD_DEFAULTS, foreignVramGB: 2, needVramGB: 20 });
    expect(needVramGB({ size: 2048, lanes: 2 }, readYieldPolicy(dir))).toBe(40);
  });

  it('a typo or a string fails loud: a policy that silently yields to nothing is the failure this exists for', () => {
    expect(() => policyOf({ foreignVram: 4 })).toThrow(/no "foreignVram"/);
    expect(() => policyOf({ foreignUtil: '30' })).toThrow(/number/);
  });
});

describe('waiting', () => {
  const busy = shareOf(parseNvidiaSmiXml(smiXml({ used: 18900, util: 3, procs: [XORG, COMFY] })), table);
  const free = shareOf(parseNvidiaSmiXml(smiXml({ used: 412, util: 2, procs: [XORG] })), table);

  it('re-checks until the card is free, reporting each wait with who holds it', async () => {
    const seq = [busy, busy, free];
    const waits: string[] = [];
    const lines: string[] = [];
    const d = await waitForGpu({ policy: { ...YIELD_DEFAULTS, recheckS: 0.001 }, needGB: 10, snapshot: async () => seq.shift() ?? free, onWait: (w) => waits.push(w.why), say: (m) => lines.push(m) });
    expect(d?.canStart).toBe(true);
    expect(waits).toHaveLength(2);
    expect(waits[0]).toMatch(/ComfyUI/);
    expect(lines.join('\n')).toMatch(/waiting for the GPU[\s\S]*free again/);
  });

  it('--force never looks', async () => {
    let looked = 0;
    await waitForGpu({ force: true, snapshot: async () => (looked++, busy) });
    expect(looked).toBe(0);
  });
});

describe('studio-manager\'s agent names the GPU users it started', () => {
  // GET 127.0.0.1:4310/api/session/status (StatusRow[]) and /api/session/devices (DeviceList), the fields read
  const agent = agentOf(
    [{ name: 'comfy', pid: 1990, alive: true, healthy: true, stats: { cpuPct: 40, rssMb: 9000, vramMb: 18432, procs: 3 } }, { name: 'fluxrt', pid: undefined, alive: false }],
    { gpus: [{ name: 'Intel(R) Arc(TM) Graphics' }, { name: 'NVIDIA GeForce RTX 5090 Laptop GPU', vramMb: 24463 }] },
  );

  it('the NVIDIA card is the GPU model the heartbeat carries (which MSI has the 5090), not the integrated one', () => {
    expect(agent?.gpuName).toBe('NVIDIA GeForce RTX 5090 Laptop GPU');
  });

  it('a python under the agent\'s comfy process is "comfy", by its pid, whatever its command line says', () => {
    const t = parsePsTable(' 1990     1  0.0  9000 /bin/sh -c ./run.sh\n 2001  1990 99.0 9000000 /usr/bin/python3 main.py --listen\n');
    expect(classify(2001, '/usr/bin/python3', t, agent!.services)).toMatchObject({ kind: 'foreign', label: 'comfy', heavy: true });
    // without the agent: the pattern's guess
    expect(classify(2001, '/usr/bin/python3', t).label).toBe('Python (an AI tool?)');
  });

  it('no agent on the box: null, and nothing breaks', () => {
    expect(agentOf(null, null)).toBeNull();
  });
});
