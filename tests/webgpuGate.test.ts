/**
 * The WebGPU gate's wait (src/core/gate.ts): on a Linux render node, headless Chrome's GPU process brings Vulkan up
 * about 2 s after launch, and an adapter asked for before that is null (linux-monster, 2026-10-30: no adapter at
 * +0.3 s, nvidia/lovelace at +2.4 s). The film's page waits for it (opt-in, `waitMs`); the game's pages do not.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { webgpuAvailable } from '../src/core/gate';

const gpuThatWakesAfter = (nulls: number) => {
  let asked = 0;
  return { requestAdapter: vi.fn(async () => (asked++ < nulls ? null : ({} as GPUAdapter))) };
};

afterEach(() => vi.unstubAllGlobals());

describe('the WebGPU gate', () => {
  it('waits for a GPU that comes up late, when asked to (the film on a Linux node)', async () => {
    vi.stubGlobal('navigator', { gpu: gpuThatWakesAfter(2) });
    expect(await webgpuAvailable(3000)).toBe(true);
  });

  it('answers at once by default (the game: a browser without an adapter sees the gate without delay)', async () => {
    const gpu = gpuThatWakesAfter(2);
    vi.stubGlobal('navigator', { gpu });
    expect(await webgpuAvailable()).toBe(false);
    expect(gpu.requestAdapter).toHaveBeenCalledTimes(1);
  });

  it('gives up after its wait when no adapter ever comes', async () => {
    vi.stubGlobal('navigator', { gpu: gpuThatWakesAfter(1e9) });
    const t0 = Date.now();
    expect(await webgpuAvailable(1200)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  it('no WebGPU in the browser at all: false, without waiting', async () => {
    vi.stubGlobal('navigator', {});
    expect(await webgpuAvailable(5000)).toBe(false);
  });
});
