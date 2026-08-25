import { describe, it } from 'vitest';
import { createDebris } from '../src/combat/debris';
import { createCombatFx } from '../src/combat/combatFx';
import type { CombatFrame } from '../src/combat/combatSystem';

const time = (label: string, iters: number, fn: () => void): void => {
  for (let i = 0; i < 200; i++) fn(); // warm
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const us = ((performance.now() - t0) * 1000) / iters;
  console.log(`${label.padEnd(52)} ${us.toFixed(3)} us/frame`);
};

describe('cost', () => {
  it('measures', () => {
    // a deliberately expensive sea lookup, standing in for cpuOcean.heightAt
    // (measured at 2.48 us in impactRing.ts's header)
    let acc = 0;
    const sea = (x: number, z: number): number => {
      for (let i = 0; i < 60; i++) acc += Math.sin(x * 0.1 + i) * Math.cos(z * 0.1 + i);
      return 0;
    };
    const flat = (): number => 0;

    const idle = createDebris({ count: 40 });
    time('debris.update  IDLE (empty pool)', 200000, () => idle.update(1 / 60, sea));

    const full = createDebris({ count: 40, life: 1e6, floatLife: 1e6 });
    full.spawn([0, 200, 0], [0, 1, 0], 40, 7);
    full.update(1 / 60, flat); // prime
    time('debris.update  40 chunks AIRBORNE, flat sea', 100000, () => full.update(1 / 60, flat));
    time('debris.update  40 chunks AIRBORNE, costly sea', 20000, () => full.update(1 / 60, sea));

    const fx = createCombatFx();
    time('combatFx.update IDLE (whole system, nothing live)', 100000, () => fx.update(1 / 60, [], flat));

    const busy: CombatFrame = {
      muzzles: [], projectiles: [], destruction: [], detached: [],
      hits: [
        { shipIndex: 0, pieceId: 'hull-port-mid', point: [3, 2, 1], projectileId: 7 },
        { shipIndex: 0, pieceId: 'hull-port-mid', point: [4, 2, 1], projectileId: 8 },
      ],
    };
    // RE-EMIT, or the measurement is a lie: a splinter lives 1.1 s, so after
    // ~66 frames of a 50,000-iteration loop the pool is empty again and the
    // "busy" figure is the idle figure with extra steps. This keeps a hit
    // landing every 8 frames, i.e. sustained fire, and charges `emit` for it.
    let f = 0;
    time('combatFx emit+update SUSTAINED FIRE (hit every 8 frames)', 50000, () => {
      if (f++ % 8 === 0) fx.emit(busy);
      fx.update(1 / 60, [], flat);
    });
    console.log(`(sink ${acc.toFixed(0)})`);
    idle.dispose();
    full.dispose();
    fx.dispose();
  });
});
