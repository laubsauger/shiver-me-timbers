/**
 * §V.2: fixed timestep — sim tick count depends only on elapsed sim time,
 * never on render frame rate. If this breaks, determinism (and future
 * multiplayer lockstep) breaks with it.
 */
import { describe, expect, it } from 'vitest';
import { advanceAccumulator, GameLoop, MAX_SUBSTEPS, SIM_DT } from '../src/core/loop';

/**
 * Drive GameLoop by hand: a stub rAF that records the pending callback so the
 * test can advance wall-clock time deliberately instead of waiting for a real
 * display. Returns a `step(ms)` that runs exactly one frame.
 */
function driveLoop(loop: GameLoop): { step(ms: number): void; stop(): void } {
  let pending: ((t: number) => void) | null = null;
  let now = 0;
  const g = globalThis as Record<string, unknown>;
  const prevRaf = g.requestAnimationFrame;
  const prevCancel = g.cancelAnimationFrame;
  g.requestAnimationFrame = (cb: (t: number) => void): number => {
    pending = cb;
    return 1;
  };
  g.cancelAnimationFrame = (): void => {
    pending = null;
  };
  loop.start();
  return {
    step(ms: number): void {
      now += ms;
      const cb = pending;
      pending = null;
      cb?.(now);
    },
    stop(): void {
      loop.stop();
      g.requestAnimationFrame = prevRaf;
      g.cancelAnimationFrame = prevCancel;
    },
  };
}

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

/**
 * PAUSE IS A RENDER-VISIBLE CONTRACT, not just "stop calling tick".
 *
 * The pause menu leaves the renderer running so the player can see the effect
 * of a setting change. That only works if the picture is STILL. Gating the
 * tick alone left the accumulator advancing, so alpha kept saw-toothing 0→1
 * while the sim's prev/curr poses stayed frozen one tick apart — main.ts lerps
 * the ship between them and the follow camera chases the result, so the whole
 * scene shook for as long as the menu was open.
 */
describe('pause holds the picture still (§V.21)', () => {
  it('stops the sim clock without freezing the renderer', () => {
    let paused = false;
    let ticks = 0;
    let renders = 0;
    const loop = new GameLoop(
      () => {
        ticks++;
      },
      () => {
        renders++;
      },
      () => paused,
    );
    const d = driveLoop(loop);
    try {
      d.step(0); // first frame only seeds lastTime
      for (let i = 0; i < 10; i++) d.step(16.7);
      const tickedWhileRunning = ticks;
      expect(tickedWhileRunning).toBeGreaterThan(0);
      const renderedWhileRunning = renders;

      paused = true;
      for (let i = 0; i < 10; i++) d.step(16.7);
      // the sim clock stopped dead...
      expect(ticks).toBe(tickedWhileRunning);
      // ...but the renderer kept drawing, which is the whole point of §V.21
      expect(renders).toBeGreaterThan(renderedWhileRunning);
    } finally {
      d.stop();
    }
  });

  it('holds the interpolation alpha FLAT while paused, so nothing jitters', () => {
    let paused = false;
    const alphas: number[] = [];
    const loop = new GameLoop(
      () => {},
      (alpha) => alphas.push(alpha),
      () => paused,
    );
    const d = driveLoop(loop);
    try {
      d.step(0);
      // a frame time that is NOT a whole multiple of SIM_DT, so a live
      // accumulator is guaranteed to produce a moving alpha
      for (let i = 0; i < 5; i++) d.step(16.7);
      paused = true;
      alphas.length = 0;
      for (let i = 0; i < 30; i++) d.step(16.7);

      expect(alphas).toHaveLength(30);
      // every paused frame reports the SAME alpha — the render lerp is then a
      // constant, whatever prev/curr happen to be
      expect(new Set(alphas).size).toBe(1);
    } finally {
      d.stop();
    }
  });

  it('resumes without a catch-up burst of the paused wall-clock time', () => {
    let paused = true;
    let ticks = 0;
    const loop = new GameLoop(
      () => {
        ticks++;
      },
      () => {},
      () => paused,
    );
    const d = driveLoop(loop);
    try {
      d.step(0);
      // ten seconds sat in the menu
      for (let i = 0; i < 600; i++) d.step(16.7);
      expect(ticks).toBe(0);

      paused = false;
      d.step(16.7);
      // one frame's worth of sim, not ten seconds of debt: freezing the
      // accumulator means the paused time was never owed in the first place
      expect(ticks).toBeLessThanOrEqual(MAX_SUBSTEPS);
    } finally {
      d.stop();
    }
  });
});
