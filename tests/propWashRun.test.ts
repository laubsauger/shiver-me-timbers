import { describe, expect, it } from 'vitest';
import { advanceJetRun, exhaustBoil } from '../src/wake/propWash';

const evolve = (steps: number, advance: number, excess: number, seconds: number): number => {
  let run = 0;
  for (let i = 0; i < steps; i++) run = advanceJetRun(run, advance, excess, 0.2, seconds / steps);
  return run;
};

describe('finite prop-wash transport', () => {
  it('grows aft under thrust at standstill, with no prebuilt distant trail', () => {
    const first = evolve(1, 0, 12, 1 / 60);
    expect(first).toBeCloseTo(0.2);
    expect(evolve(60, 0, 12, 1)).toBeGreaterThan(5);
    expect(evolve(60, 0, 12, 1)).toBeLessThan(12);
  });
  it('has no growth without thrust or travel; unpowered travel keeps the existing clock', () => {
    expect(evolve(60, 0, 0, 1)).toBe(0);
    expect(evolve(60, 25, 0, 1)).toBeCloseTo(25);
  });
  it('slows the stationary front as its jet spreads, without timestep-dependent startup', () => {
    const one = evolve(60, 0, 12, 1);
    const two = evolve(120, 0, 12, 2);
    expect(two - one).toBeLessThan(one);
    expect(evolve(120, 0, 12, 1)).toBeCloseTo(one, 10);
    expect(evolve(1, 0, 12, 1)).toBeCloseTo(one, 10);
  });
  it('adds jet transport to boat travel and leaves a retained front still when both stop', () => {
    expect(evolve(60, 20, 4, 1)).toBeGreaterThan(20);
    expect(advanceJetRun(18, 0, 0, 0.2, 1 / 60)).toBe(18);
  });
  it('carries powered exhaust aft at standstill; neutral exhaust still surfaces locally', () => {
    const source = { propRps: 30, lossPower: 2000, advance: 0, depth: 0.25, discArea: Math.PI * 0.2 ** 2 };
    const neutral = exhaustBoil({ ...source, thrust: 0 });
    const powered = exhaustBoil({ ...source, thrust: 3000 });
    expect(neutral.along).toBe(0);
    expect(powered.along).toBeGreaterThan(3 * powered.sigma);
    expect(powered.share).toBeLessThan(neutral.share);
    expect(powered.flux).toBe(neutral.flux);
  });
});
