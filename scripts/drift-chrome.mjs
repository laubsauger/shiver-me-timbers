/**
 * THE ONE PLACE that decides how The Drift's headless browser is launched, so the renderer (drift-render.mjs) and the
 * node self-test (drift-gpu-check.mjs) run exactly the same Chrome (docs/drift/RENDER-NODE.md).
 *
 *   macOS    no GPU flags: new headless mode is on the Metal adapter as it is (drift-render.mjs always did this;
 *            unchanged). `--enable-unsafe-webgpu` there only adds a SwiftShader fallback adapter.
 *   Linux    WebGPU on NVIDIA is allowlisted only on Wayland (Chrome 147+, driver 535.183.01+); headless is not
 *            Wayland, so the blocklist is bypassed and Vulkan asked for explicitly (developer.chrome.com
 *            "Supercharge Web AI model testing": the same four flags on an NVIDIA Linux box).
 *   Windows  WebGPU is on by default on D3D12 (Chrome 113+): no flags.
 *   Linux + Windows: Playwright's own `--enable-unsafe-swiftshader` is dropped, so a machine whose GPU path is broken
 *            gets NO adapter (the page shows its WebGPU gate and the render fails at once) instead of a software one
 *            rendering at a frame a minute.
 *
 * Overrides, for a node whose driver needs something else (drift-gpu-check.mjs --variants finds a working set):
 *   DRIFT_CHROME_ARGS="--a --b"   replaces the platform's GPU flags (not --js-flags)
 *   out/drift/node-chrome.json    {"args": [...]} written by `drift-gpu-check.mjs --variants --save`; used when the
 *                                 env var is not set (out/drift is gitignored: it is this machine's, not the repo's)
 *   DRIFT_HEADLESS=0              a visible window (when a driver gives headless no GPU)
 *
 * PERSISTENT PROFILES, so shaders compile once (the user, 2026-10-30: "cache the compiled shaders, at least if there
 * were no changes … something that handles this smartly so we don't end up compiling shaders all the time"):
 * Playwright's chromium.launch gives every Chrome a throwaway profile, and with it an empty GPU disk cache — Dawn's
 * compiled WebGPU pipelines (DawnWebGPUCache), Chrome's own shader caches (GrShaderCache, GraphiteDawnCache) — so
 * every boot compiled the whole film's shaders again (eeg-msi: the first frame of a 1-frame job 75 s after launch).
 * launchChrome() gives each Chrome a profile that stays: ~/.cache/drift-chrome-profiles/<kind>-<channel>-<n>, one per live Chrome
 * (a profile cannot be shared by two at once: a lock file with the holder's pid, taken over when that pid is gone).
 * The caches are keyed by what they hold (Dawn: a hash of the shader and pipeline, the adapter and driver), so an
 * unchanged shader is a hit and a changed one compiles: nothing to manage by hand. A profile's GPU caches are emptied
 * when Chrome's version or the NVIDIA driver changed since it was last used, or when they pass 2 GB.
 *   DRIFT_CHROME_PROFILES=<dir>   where the profiles live, instead of ~/.cache/drift-chrome-profiles
 *   DRIFT_CHROME_PERSIST=0        a throwaway profile, as before
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// (DRIFT_NODE_CHROME: a farm job's tree is not the box's checkout; the worker points it at the checkout's file, the one
// drift-gpu-check.mjs --save wrote for this machine)
export const NODE_CHROME_FILE = process.env.DRIFT_NODE_CHROME || join(ROOT, 'out/drift/node-chrome.json');

/** the platform's GPU flags when nothing overrides them */
export const PLATFORM_GPU_ARGS = {
  darwin: [],
  linux: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--disable-vulkan-surface'],
  win32: [],
};

/** flag sets drift-gpu-check.mjs --variants tries in order, per platform (the first is the default) */
export const GPU_ARG_VARIANTS = {
  darwin: [[]],
  linux: [
    PLATFORM_GPU_ARGS.linux,
    // Dawn's own adapter blocklist (reported to reject some 570+ drivers even past --ignore-gpu-blocklist)
    [...PLATFORM_GPU_ARGS.linux, '--ignore-gpu-blocklist', '--enable-dawn-features=disable_adapter_blocklist'],
    ['--enable-unsafe-webgpu', '--enable-features=Vulkan,VulkanFromANGLE', '--use-angle=vulkan', '--ignore-gpu-blocklist'],
    ['--enable-unsafe-webgpu'],
  ],
  win32: [
    [],
    // a machine with an integrated GPU too: make "no preference" mean the discrete one (Chromium's web-test switch)
    ['--use-webgpu-power-preference=default-high-performance'],
    ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
  ],
};

/** where the GPU flags come from on this machine, and what they are */
export function gpuArgs() {
  const env = process.env.DRIFT_CHROME_ARGS;
  if (env !== undefined && env.trim() !== '') return { args: env.trim().split(/\s+/), from: 'DRIFT_CHROME_ARGS' };
  if (existsSync(NODE_CHROME_FILE)) {
    const saved = JSON.parse(readFileSync(NODE_CHROME_FILE, 'utf8'));
    if (!Array.isArray(saved.args)) throw new Error(`${NODE_CHROME_FILE}: no "args" array`);
    return { args: saved.args, from: NODE_CHROME_FILE };
  }
  return { args: PLATFORM_GPU_ARGS[process.platform] ?? [], from: `${process.platform} default` };
}

/**
 * Playwright launch options for one render page. `extraGpuArgs` replaces the GPU flags (the self-test's variants).
 * --expose-gc: the page collects garbage every few frames (src/drift/record.ts GC_EVERY).
 */
export function chromeLaunchOptions(channel, gpu = gpuArgs().args) {
  const o = { channel, headless: process.env.DRIFT_HEADLESS !== '0', args: ['--js-flags=--expose-gc', ...gpu] };
  // macOS keeps Playwright's defaults exactly as drift-render.mjs always had them
  if (process.platform !== 'darwin') o.ignoreDefaultArgs = ['--enable-unsafe-swiftshader'];
  return o;
}

// ------------------------------------------------------------------------------------------ persistent profiles
/**
 * where the profiles live (header: PERSISTENT PROFILES): in the user's home, not the checkout, so every checkout,
 * worktree and farm job tree on a machine shares them (the caches are keyed by content, so sharing is safe)
 */
export const PROFILES_DIR = process.env.DRIFT_CHROME_PROFILES || join(homedir(), '.cache', 'drift-chrome-profiles');
/** bytes of GPU cache a profile may hold before it is emptied */
export const PROFILE_GPU_CACHE_MAX = 2 * 2 ** 30;
/**
 * the caches in a profile that a changed stack or the cap empties: the GPU ones (in the user data dir, and in its
 * Default profile; Chrome 156 on macOS writes GraphiteDawnCache, GPUPersistentCache, Default/DawnWebGPUCache,
 * DawnGraphiteCache, GPUCache) and V8's code cache and the HTTP cache beside them
 */
export const GPU_CACHE_DIRS = ['GrShaderCache', 'GraphiteDawnCache', 'GPUPersistentCache', 'ShaderCache', 'Default/GPUCache', 'Default/DawnWebGPUCache', 'Default/DawnGraphiteCache', 'Default/Code Cache', 'Default/Cache'];
/** bytes of Dawn's WebGPU cache that mean it holds pipelines (Chrome makes the folder, nearly empty, on every start) */
const WARM_BYTES = 64 * 1024;
const LOCK = '.drift-lock';
const META = '.drift-profile.json';

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // (someone else's process: alive)
  }
};

/**
 * a profile of `kind` that no live Chrome holds: the first of <kind>-0, <kind>-1, … whose lock is free or whose holder
 * is gone. → { dir, release }
 */
export function takeProfile(kind, root = PROFILES_DIR, pid = process.pid) {
  for (let i = 0; i < 32; i++) {
    const dir = join(root, `${kind}-${i}`);
    mkdirSync(dir, { recursive: true });
    const lock = join(dir, LOCK);
    try {
      writeFileSync(lock, String(pid), { flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const holder = Number(readFileSync(lock, 'utf8'));
      if (Number.isInteger(holder) && holder > 0 && holder !== pid && alive(holder)) continue;
      writeFileSync(lock, String(pid)); // (its holder died without letting go)
    }
    return {
      dir,
      release: () => {
        try {
          if (Number(readFileSync(lock, 'utf8')) === pid) rmSync(lock, { force: true });
        } catch {
          // (gone already)
        }
      },
    };
  }
  throw new Error(`no free Chrome profile of kind ${kind} in ${root} (32 in use?)`);
}

/** bytes under `dir` (no links followed) */
function sizeOf(dir) {
  let n = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) n += sizeOf(p);
    else if (e.isFile()) n += statSync(p).size;
  }
  return n;
}

/** the NVIDIA driver's version, or null (no nvidia-smi: macOS, or not an NVIDIA box); asked once */
let driverOnce;
export function gpuDriver() {
  if (driverOnce !== undefined) return driverOnce;
  const r = spawnSync('nvidia-smi', ['--query-gpu=driver_version', '--format=csv,noheader'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  driverOnce = r.status === 0 ? r.stdout.trim().split('\n')[0] || null : null;
  return driverOnce;
}

/**
 * why a profile's GPU caches go (null: they stay): the driver or Chrome changed since its last use (`meta`), or the
 * caches passed the cap. Chrome's version is known only once it runs: `chrome` null skips that test.
 */
export function staleWhy(meta, { driver, chrome = null, bytes, max = PROFILE_GPU_CACHE_MAX }) {
  if (meta?.driver !== undefined && meta.driver !== driver) return `the GPU driver changed (${meta.driver ?? 'none'} → ${driver ?? 'none'})`;
  if (chrome !== null && meta?.chrome && meta.chrome !== chrome) return `Chrome changed (${meta.chrome} → ${chrome})`;
  if (bytes > max) return `the GPU caches hold ${(bytes / 2 ** 30).toFixed(1)} GB (over ${(max / 2 ** 30).toFixed(0)} GB)`;
  return null;
}

/** empties a profile's GPU caches (header: what is kept is keyed by content; this is only for a changed stack or size) */
export function clearGpuCaches(dir) {
  for (const d of GPU_CACHE_DIRS) rmSync(join(dir, d), { recursive: true, force: true });
}

const readMeta = (dir) => {
  try {
    return JSON.parse(readFileSync(join(dir, META), 'utf8'));
  } catch {
    return null;
  }
};

/**
 * ONE CHROME FOR ONE PAGE, with a persistent profile (header): `chromium` is Playwright's, `kind` names the profile
 * family ("render", "review", "check", "stills"). → a handle shaped like Playwright's Browser for what the drift
 * scripts use: newPage({ viewport }), close(), version(), and `profile` { dir, cache: 'warm' | 'cold', why }.
 * Cold: the profile's GPU caches were empty or just emptied (`why`).
 */
export async function launchChrome(chromium, { channel, gpu = gpuArgs().args, kind = 'page', say = () => {} } = {}) {
  const options = chromeLaunchOptions(channel, gpu);
  if (process.env.DRIFT_CHROME_PERSIST === '0') {
    const b = await chromium.launch(options);
    return { newPage: (o) => b.newPage(o), close: () => b.close(), version: () => b.version(), profile: null };
  }
  // (one family per kind and Chrome build: Playwright's Chromium and Google Chrome would empty each other's caches)
  const prof = takeProfile(`${kind}-${channel ?? 'chromium'}`);
  try {
    const driver = gpuDriver();
    const meta = readMeta(prof.dir);
    let why = staleWhy(meta, { driver, bytes: sizeOf(prof.dir) });
    if (why) {
      say(`chrome profile ${prof.dir}: GPU caches emptied: ${why}`);
      clearGpuCaches(prof.dir);
    }
    // (the HTTP cache is no use here — Vite serves the assets from this disk — and it grew to ~0.8 GB a profile on
    // the first runs, 2026-10-30, on a Mac with 23 GB free: held to 32 MB by the flag below, an old one removed)
    if (sizeOf(join(prof.dir, 'Default', 'Cache')) > 64 * 2 ** 20) rmSync(join(prof.dir, 'Default', 'Cache'), { recursive: true, force: true });
    // (warm: Dawn's cache holds pipelines from an earlier run — read before Chrome starts and makes the folder)
    let warm = !why && sizeOf(join(prof.dir, 'Default', 'DawnWebGPUCache')) > WARM_BYTES;
    const open = () => chromium.launchPersistentContext(prof.dir, { ...options, args: [...options.args, '--disk-cache-size=33554432'], viewport: null });
    let ctx = await open();
    const versionOf = async () => {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      const cdp = await ctx.newCDPSession(page);
      const v = await cdp.send('Browser.getVersion');
      await cdp.detach().catch(() => {});
      return String(v.product ?? '');
    };
    let chrome = await versionOf();
    const changed = staleWhy(meta, { driver, chrome, bytes: 0 });
    if (changed && !why) {
      // (Chrome's version is known only now: closed, emptied, opened again — a second, once per Chrome update)
      say(`chrome profile ${prof.dir}: GPU caches emptied: ${changed}`);
      await ctx.close();
      clearGpuCaches(prof.dir);
      ctx = await open();
      chrome = await versionOf();
      why = changed;
      warm = false;
    }
    writeFileSync(join(prof.dir, META), JSON.stringify({ chrome, driver, at: new Date().toISOString(), pid: process.pid }));
    let first = ctx.pages()[0] ?? null;
    return {
      profile: { dir: prof.dir, cache: warm ? 'warm' : 'cold', why: why ?? (warm ? null : 'a new profile (no WebGPU cache yet)') },
      version: () => chrome.replace(/^[^/]*\//, ''),
      newPage: async (o = {}) => {
        // (the persistent context's first tab is reused; a viewport is set on the page, as a context has none)
        const page = first ?? (await ctx.newPage());
        first = null;
        if (o.viewport) await page.setViewportSize(o.viewport);
        return page;
      },
      close: async () => {
        try {
          await ctx.close();
        } finally {
          prof.release();
        }
      },
    };
  } catch (e) {
    prof.release();
    throw e;
  }
}
