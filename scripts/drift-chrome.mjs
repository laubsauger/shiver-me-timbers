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
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const NODE_CHROME_FILE = join(ROOT, 'out/drift/node-chrome.json');

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
