import { describe, expect, it } from 'vitest';
import { ChineContactHistory } from '../src/wake/chineContact';
import { createWaterlineSpray } from '../src/foam/sprayMath';
import { retainedChineFoamCpu } from '../src/flowfoam/simFoam';
const spray = () => ({ ...createWaterlineSpray(), inContact: true, flux: 0.1, launch: 2, halfWidth: 1 });

describe('causal bow foam', () => {
  it('cannot paint a completed trail at impact; subsequent motion leaves water behind', () => {
    const h = new ChineContactHistory();
    let e = h.update(0, 0, spray(), 0, 20, 1 / 60);
    expect(retainedChineFoamCpu([e], 2, -10, 0.1)).toBe(0);
    for (let t = 1; t <= 45; t++) e = h.update(0, t, { ...spray(), z: t / 3 }, 0, 20, 1 / 60);
    expect(retainedChineFoamCpu([e], 2, 5, 0.1)).toBeGreaterThan(0);
    expect(retainedChineFoamCpu([e], 2, 25, 0.1)).toBe(0);
  });
  it('a restart clears old locations; teleport contact reset retains detached emissions', () => {
    const h = new ChineContactHistory();
    h.update(0, 0, spray(), 0, 20, 1 / 60);
    h.resetContact(0);
    const e = h.update(0, 1, { ...spray(), x: 1000 }, 20, 0, 1 / 60);
    expect(e.emissions).toHaveLength(2);
    expect(e.emissions[0].x).toBe(0);
    expect(e.emissions[1].x).toBe(1000);
    const restarted = h.update(0, 0, { ...spray(), x: 2000 }, 20, 0, 1 / 60);
    expect(restarted.emissions).toHaveLength(1);
    expect(restarted.emissions[0].x).toBe(2000);
  });
});
