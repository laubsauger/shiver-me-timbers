/**
 * §V.2: fixed timestep — sim tick count depends only on elapsed sim time,
 * never on render frame rate. If this breaks, determinism (and future
 * multiplayer lockstep) breaks with it.
 */
import { describe, expect, it } from 'vitest';
import { advanceAccumulator, MAX_SUBSTEPS, SIM_DT } from '../src/core/loop';

function runFrames(frameDts: number[]): number {
  let acc = 0;
  let steps = 0;
  for (const dt of frameDts) {
    const res = advanceAccumulator(acc, dt);
    acc = res.accumulator;
    steps += res.steps;
  }
  return steps;
}

describe('fixed-step accumulator (§V.2)', () => {
  it('60fps frames → exactly one step per frame', () => {
    const frames = Array(120).fill(SIM_DT);
    expect(runFrames(frames)).toBe(120);
  });

  it('same total time at 30fps vs 144fps → same step count (±1 residual)', () => {
    const oneSecond30 = Array(30).fill(1 / 30);
    const oneSecond144 = Array(144).fill(1 / 144);
    const steps30 = runFrames(oneSecond30);
    const steps144 = runFrames(oneSecond144);
    expect(Math.abs(steps30 - steps144)).toBeLessThanOrEqual(1);
    expect(steps30).toBeGreaterThanOrEqual(59);
    expect(steps30).toBeLessThanOrEqual(61);
  });

  it('caps catch-up after a stall — no death spiral', () => {
    const res = advanceAccumulator(0, 2.0); // 2s stall
    expect(res.steps).toBeLessThanOrEqual(MAX_SUBSTEPS);
    // leftover debt dropped below one step, not carried forever
    expect(res.accumulator).toBeLessThan(SIM_DT);
  });

  it('alpha stays in [0,1) for interpolation', () => {
    let acc = 0;
    for (const dt of [0.013, 0.021, 0.009, 0.033, 0.016]) {
      const res = advanceAccumulator(acc, dt);
      acc = res.accumulator;
      expect(res.alpha).toBeGreaterThanOrEqual(0);
      expect(res.alpha).toBeLessThan(1);
    }
  });
});
