import { describe, expect, it } from 'vitest';
import { ChineContactHistory } from '../src/wake/chineContact';
import { createWaterlineSpray } from '../src/foam/sprayMath';
import { chineSheetFoamCpu, packMovingChineSheet } from '../src/flowfoam/simFoam';

const spray = () => ({ ...createWaterlineSpray(), inContact: true, flux: 0.1, launch: 2, halfWidth: 1, fwdX: 0, fwdZ: 1 });

describe('causal bow foam', () => {
  it('starts at impact, reaches nearby water first, and cannot light the far V instantly', () => {
    const history = new ChineContactHistory();
    const bow = spray();
    let e = history.update(0, 0, bow, 0, 20, 1 / 60);
    const rayX = (distance: number) => { const b = packMovingChineSheet(e)!.b; return 1 + b[2] * b[3] * (1 - Math.exp(-distance / b[3])); };
    expect(chineSheetFoamCpu([e], rayX(10), -10, 0.1)).toBe(0);
    for (let tick = 1; tick <= 15; tick++) e = history.update(0, tick, bow, 0, 20, 1 / 60);
    expect(e.front).toBeCloseTo(5);
    expect(chineSheetFoamCpu([e], rayX(2), -2, 0.1)).toBeGreaterThan(0);
    expect(chineSheetFoamCpu([e], rayX(10), -10, 0.1)).toBe(0);
    for (let tick = 16; tick <= 45; tick++) e = history.update(0, tick, bow, 0, 20, 1 / 60);
    expect(chineSheetFoamCpu([e], rayX(10), -10, 0.1)).toBeGreaterThan(0);
  });

  it('resets on airtime and re-entry while retaining independent vessel histories', () => {
    const h = new ChineContactHistory();
    const bow = spray();
    h.update(0, 0, bow, 0, 20, 1 / 60);
    h.update(1, 0, bow, 0, 10, 1 / 60);
    expect(h.update(1, 60, bow, 0, 10, 1 / 60).front).toBe(10);
    expect(h.update(0, 60, bow, 0, 20, 1 / 60).front).toBe(20);
    expect(h.update(0, 61, { ...bow, inContact: false }, 0, 20, 1 / 60).front).toBe(0);
    expect(h.update(0, 62, bow, 0, 20, 1 / 60).front).toBe(0);
    expect(h.update(1, 60, bow, 0, 10, 1 / 60).front).toBe(10); // repeated worker sample
    expect(h.update(0, 63, bow, 0, 20, 1 / 60).front).toBeCloseTo(1 / 3);
    expect(h.update(1, 0, bow, 0, 10, 1 / 60).front).toBe(0); // race restart
  });

  it('uses motion direction during sideslip and integrates speed changes', () => {
    const h = new ChineContactHistory();
    const bow = spray();
    h.update(0, 0, bow, 20, 0, 0.1);
    h.update(0, 1, bow, 20, 0, 0.1);
    const e = h.update(0, 2, bow, 10, 0, 0.1);
    expect(e.front).toBe(3);
    expect(packMovingChineSheet(e)!.b.slice(0, 2)).toEqual([-1, -0]);
  });
});
