/**
 * NO GPU SIN-HASH (the farm's consistency check, 2026-10-30, scripts/drift-consistency.mjs). The same commit drawn on
 * the Mac (Apple, Metal) and on the three NVIDIA boxes (D3D12, Vulkan) agreed to 0.7% in mean luminance, but the
 * beach at 604 s differed at RMS 6.9/255 (p99 54) — all of it along the swash and in the foliage — while the boxes
 * agreed among themselves at ~1. The cause, measured with one WGSL probe on all four GPUs:
 *   fract(sin(n) · 43758.5453)    differs on EVERY input tried, by up to 0.75 (Apple's sin is not NVIDIA's; the ×43758
 *                                 turns the last bits into the whole value) — so every swash event's reach and timing
 *                                 (shoreline.ts hashK) came out different on the Mac
 *   sin(x), x ≈ 40 000 m          differs by up to 0.009
 *   hash2 (Hoskins, terrain/noise.ts) of an integer cell, and an integer PCG hash: bit-identical on all four
 * A master whose chunks come from different machines would jump at the seams. So: a GPU hash is the project's
 * sin-free hash2/hash3 (src/terrain/noise.ts, §V16) of an INTEGER lattice value (a floor()ed cell, an event index, a
 * floored pixel), never a sin. CPU code (Math.sin in JS) is the same everywhere and is not this test's business.
 *
 * KNOWN holds the sites that predate the check, by file and count: each owner swaps its own for hash2 and takes its
 * entry out. The test fails on any NEW one, and on a KNOWN entry that is gone (so the list only shrinks).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const KNOWN: Record<string, number> = {
};

/** `.sin()` / `sin(` chained into `.mul(<a big constant>).fract()`: the sin hash, in TSL (calls joined across lines) */
const SIN_HASH = /(?<!Math\.)\bsin\b[^;]*?\.mul\(\s*\d{3,}(?:\.\d+)?\s*\)\s*\.fract\(\)/g;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('no GPU sin-hash (machines must draw the same film)', () => {
  const found: Record<string, number> = {};
  for (const f of tsFiles(join(ROOT, 'src'))) {
    // (a chain split over lines, `.dot(…)\n  .sin()\n  .mul(…)`, joined; comments dropped)
    const text = readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '').replace(/\s*\n\s*\./g, '.');
    const n = (text.match(SIN_HASH) ?? []).length;
    if (n > 0) found[relative(ROOT, f).split('\\').join('/')] = n;
  }

  it('finds the pattern it is meant to (the swash\'s hashK, the impostor dither over four lines)', () => {
    expect('const hashK = (k, s) => sin(k.mul(12.9898).add(s * 78.233)).mul(43758.5453).fract();'.match(SIN_HASH)).toHaveLength(1);
    expect('screenCoordinate.xy.dot(vec2(12.9898, 78.233)).sin().mul(43758.5453).fract();'.match(SIN_HASH)).toHaveLength(1);
    expect('const h = Math.abs(Math.sin(slot * 12.9898) * 43758.5453) % 1;'.match(SIN_HASH)).toBeNull(); // (CPU)
    expect('hash2(cell)'.match(SIN_HASH)).toBeNull();
  });

  it('no new one: every sin hash in src is a KNOWN one, at most as many as listed', () => {
    const extra = Object.entries(found).filter(([f, n]) => n > (KNOWN[f] ?? 0));
    expect(extra, `GPU sin-hash: use hash2 of an integer cell (src/terrain/noise.ts) — ${JSON.stringify(extra)}`).toEqual([]);
  });

  it('the KNOWN list only shrinks: a site fixed is taken off it', () => {
    const fixed = Object.entries(KNOWN).filter(([f, n]) => (found[f] ?? 0) < n);
    expect(fixed, `fixed — take these off KNOWN: ${JSON.stringify(fixed)}`).toEqual([]);
  });
});
