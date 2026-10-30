/**
 * The persistent Chrome profiles (scripts/drift-chrome.mjs, header: PERSISTENT PROFILES). The user, 2026-10-30: "cache
 * the compiled shaders, at least if there were no changes … something that handles this smartly so we don't end up
 * compiling shaders all the time". Measured on the Mac (Chrome 156, Metal): 40 small pipelines 604 ms in a fresh
 * profile, 10 ms in the same profile the next run, and still warm from another port (the cache is per site). What
 * must hold:
 *   - TWO LIVE CHROMES NEVER SHARE A PROFILE (Chrome's own lock would hand the second one's page to the first): a
 *     second taker gets the next profile; a profile whose holder died is taken over, not lost.
 *   - THE CACHES GO ONLY WHEN THEY MUST: a new driver or Chrome, or past the cap. Content changes need nothing — the
 *     caches are keyed by the shader — so an unchanged stack keeps every compiled pipeline.
 *   - EMPTYING A PROFILE'S CACHES KEEPS THE PROFILE (its lock, its record), and nothing outside it.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { clearGpuCaches, GPU_CACHE_DIRS, PROFILE_GPU_CACHE_MAX, staleWhy, takeProfile } from '../scripts/drift-chrome.mjs';

const root = mkdtempSync(join(tmpdir(), 'drift-chrome-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('two live Chromes never share a profile', () => {
  it('a second taker gets the next profile; a released one is taken again', () => {
    const a = takeProfile('render-chrome', root, process.pid);
    const b = takeProfile('render-chrome', root, process.ppid); // (another live process)
    expect(a.dir).toBe(join(root, 'render-chrome-0'));
    expect(b.dir).toBe(join(root, 'render-chrome-1'));
    a.release();
    expect(takeProfile('render-chrome', root, process.ppid).dir).toBe(join(root, 'render-chrome-0'));
    b.release();
  });

  it('a profile whose holder died is taken over', () => {
    const dir = join(root, 'review-chrome-0');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.drift-lock'), '999999'); // (no such process)
    const p = takeProfile('review-chrome', root, process.pid);
    expect(p.dir).toBe(dir);
    expect(readFileSync(join(dir, '.drift-lock'), 'utf8')).toBe(String(process.pid));
    p.release();
    expect(existsSync(join(dir, '.drift-lock'))).toBe(false);
  });
});

describe('the caches go only when they must', () => {
  const meta = { driver: '591.44', chrome: 'Chrome/156.0.8078.74' };
  it('the same driver and Chrome under the cap: kept (a changed shader is a cache miss, nothing to empty)', () => {
    expect(staleWhy(meta, { driver: '591.44', chrome: 'Chrome/156.0.8078.74', bytes: 500e6 })).toBeNull();
    expect(staleWhy(null, { driver: '591.44', bytes: 0 })).toBeNull(); // (a new profile: nothing to empty)
  });
  it('a new NVIDIA driver, a new Chrome, or past the cap: emptied, and says why', () => {
    expect(staleWhy(meta, { driver: '595.10', bytes: 0 })).toMatch(/driver changed \(591\.44 → 595\.10\)/);
    expect(staleWhy(meta, { driver: '591.44', chrome: 'Chrome/157.0.1.2', bytes: 0 })).toMatch(/Chrome changed/);
    expect(staleWhy(meta, { driver: '591.44', bytes: PROFILE_GPU_CACHE_MAX + 1 })).toMatch(/over 2 GB/);
  });
  it('Chrome\'s version is known only once it runs: a check without it does not empty anything', () => {
    expect(staleWhy(meta, { driver: '591.44', chrome: null, bytes: 0 })).toBeNull();
  });
});

describe('emptying the caches keeps the profile', () => {
  it('removes the cache folders, and keeps the lock, the record and the rest of the profile', () => {
    const dir = join(root, 'stills-chromium-0');
    for (const d of GPU_CACHE_DIRS) {
      mkdirSync(join(dir, d), { recursive: true });
      writeFileSync(join(dir, d, 'data_0'), 'x');
    }
    writeFileSync(join(dir, '.drift-lock'), String(process.pid));
    writeFileSync(join(dir, '.drift-profile.json'), '{}');
    mkdirSync(join(dir, 'Default', 'Local Storage'), { recursive: true });
    clearGpuCaches(dir);
    for (const d of GPU_CACHE_DIRS) expect(existsSync(join(dir, d)), d).toBe(false);
    expect(existsSync(join(dir, '.drift-lock'))).toBe(true);
    expect(existsSync(join(dir, '.drift-profile.json'))).toBe(true);
    expect(existsSync(join(dir, 'Default', 'Local Storage'))).toBe(true);
  });
});
