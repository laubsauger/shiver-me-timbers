/**
 * The beach dressing's placement (src/drift/wandering/beachDressing.ts) on a plain beach: a 1:11 face rising inland
 * from the waterline, the eye's walk over it (beats.ts). What it must keep true, whatever the densities are tuned to:
 * the waves' swash stays almost bare, the swash's upper limit and the wrack line are where things gather, the walked
 * line and the wanderers' path stay clear, nothing is placed where the eye could only ever see it as a speck (the
 * 2026-10-29 review: "I'd much rather have stuff disappear than look like that"), the bleached sticks stay rare ("the
 * little bones … too much"), and the same beach comes out every run (every frame a function of t).
 */
import { describe, expect, it } from 'vitest';
import { COVERAGE, WRACK, eyePath, placeBeachDressing, wrackAt, type DressingPlace } from '../src/drift/wandering/beachDressing';

const beach = { x: 0, z: 0 };
/** m over the sea: 1:11 up from the waterline (x = 0) inland (+x), under water out to sea */
const ground = (x: number): number => x / 11;
const site = { ground: (x: number) => ground(x), beach, inland: (x: number) => x, palms: [] as Array<[number, number]> };
const placed = placeBeachDressing(site);
const all = Object.values(placed).flat();
/** things a m² between two heights (m over the sea), along the stretch the eye sees closest (along −20..40) */
const density = (list: DressingPlace[], h0: number, h1: number): number => {
  const n = list.filter((p) => ground(p.x) >= h0 && ground(p.x) < h1 && -p.z > -20 && -p.z < 40).length;
  return n / ((h1 - h0) * 11 * 60);
};

describe('beach dressing placement', () => {
  it('is the same beach every run', () => {
    const again = placeBeachDressing(site);
    for (const k of Object.keys(placed) as Array<keyof typeof placed>) {
      expect(again[k].length).toBe(placed[k].length);
      expect(again[k].map((p) => [p.x, p.z, p.s])).toEqual(placed[k].map((p) => [p.x, p.z, p.s]));
    }
  });

  it('dresses the beach at all, near the walk', () => {
    expect(placed.pebble.length).toBeGreaterThan(300);
    expect(placed.shell.length).toBeGreaterThan(150);
  });

  it('leaves the swash almost bare: the waves rework it', () => {
    const swash = all.filter((p) => ground(p.x) < 0.4).length;
    expect(swash / all.length).toBeLessThan(0.02);
    expect(all.every((p) => ground(p.x) > 0)).toBe(true);
  });

  it('gathers pebbles and shells at the swash limit, more than on the open sand', () => {
    const small = [...placed.pebble, ...placed.shell];
    expect(density(small, 0.55, 0.7)).toBeGreaterThan(3 * density(small, 0.72, 0.88));
  });

  it('lays the dried leaves and twigs on the wrack line, the one the ground decal paints', () => {
    const wrack = [...placed.leaf, ...placed.twig];
    const near = wrack.filter((p) => Math.abs(ground(p.x) - WRACK.height) < 2 * WRACK.wander + 2 * WRACK.half).length;
    expect(near / wrack.length).toBeGreaterThan(0.8);
    // (and where they lie, the decal's own band and clumps are there too: the same function)
    const mean = wrack.reduce((s, p) => s + wrackAt(p.x, p.z, ground(p.x), 1.5), 0) / wrack.length;
    expect(mean).toBeGreaterThan(0.3);
  });

  it('places nothing the eye could only see as a speck: every piece spans COVERAGE.gone from somewhere on its path', () => {
    const path = eyePath(beach, (x) => ground(x));
    for (const p of all) {
      const y = ground(p.x);
      const d = Math.min(...path.map(([x, py, z]) => Math.hypot(x - p.x, py - y, z - p.z)));
      expect(p.s / d).toBeGreaterThanOrEqual(COVERAGE.gone);
    }
  });

  it('keeps the bleached sticks rare', () => {
    expect(placed.stick.length).toBeLessThan(0.05 * (placed.pebble.length + placed.shell.length));
  });

  it('keeps the held eye’s spot and the wanderers’ path clear', () => {
    // w4's hold (beats.ts COAST_KEYS: along 12, off −8): nothing within half a metre under the eye
    expect(all.every((p) => Math.hypot(p.x - 8, p.z + 12) >= 0.5)).toBe(true);
    // props.ts walkers (off −5.3 ± 1 from along ~4 on): nothing big enough to trip over
    const onPath = all.filter((p) => -p.z > 3 && p.x > 4 && p.x < 6.6 && p.s > 0.06);
    expect(onPath).toEqual([]);
  });
});
