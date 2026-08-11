/**
 * Fixed-timestep sim loop decoupled from rAF render (§V.2).
 * Sim ticks at exactly SIM_DT; render runs at display rate with
 * interpolation alpha available for smooth visuals.
 */

export const SIM_DT = 1 / 60;
/** cap catch-up work after tab-hidden stalls */
export const MAX_SUBSTEPS = 5;

export interface StepResult {
  steps: number;
  accumulator: number;
  /** fraction of SIM_DT left in accumulator, for render interpolation */
  alpha: number;
}

/**
 * Pure accumulator advance — testable without rAF.
 * Returns number of fixed steps to run this frame.
 */
export function advanceAccumulator(
  accumulator: number,
  frameDt: number,
  dt: number = SIM_DT,
  maxSubSteps: number = MAX_SUBSTEPS,
): StepResult {
  let acc = accumulator + frameDt;
  let steps = 0;
  while (acc >= dt && steps < maxSubSteps) {
    acc -= dt;
    steps++;
  }
  // drop unpayable debt (stall) instead of spiraling
  if (acc >= dt) acc = acc % dt;
  return { steps, accumulator: acc, alpha: acc / dt };
}

export type TickFn = (dt: number) => void;
export type RenderFn = (alpha: number, frameDt: number) => void;

export class GameLoop {
  private accumulator = 0;
  private lastTime = -1;
  private rafId = 0;
  private running = false;

  constructor(
    private tick: TickFn,
    private render: RenderFn,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = -1;
    const frame = (timeMs: number) => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(frame);
      if (this.lastTime < 0) {
        this.lastTime = timeMs;
        return;
      }
      const frameDt = Math.min((timeMs - this.lastTime) / 1000, 0.25);
      this.lastTime = timeMs;
      const res = advanceAccumulator(this.accumulator, frameDt);
      this.accumulator = res.accumulator;
      for (let i = 0; i < res.steps; i++) this.tick(SIM_DT);
      this.render(res.alpha, frameDt);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }
}
