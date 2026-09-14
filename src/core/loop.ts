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
/** frameDt drives visuals; wallFrameDt measures the unclamped rAF interval. */
export type RenderFn = (alpha: number, frameDt: number, wallFrameDt: number) => void;

export class GameLoop {
  private accumulator = 0;
  private lastTime = -1;
  private rafId = 0;
  private running = false;
  /** last alpha handed to render — held flat while paused, see frame() */
  private alpha = 0;
  /** see setFixedDt */
  private fixedDt: number | null = null;

  constructor(
    private tick: TickFn,
    private render: RenderFn,
    /** pause is the LOOP's business, not the tick's — see frame() */
    private isPaused: () => boolean = () => false,
  ) {}

  /**
   * Drive the loop at an EXACT dt per rAF instead of the wall clock (§cine).
   *
   * Two things need this and neither is a debug convenience:
   *
   *  - A recorded frame must advance the world by exactly 1/fps of SCENE time
   *    however long the GPU took, or the output is timed by the machine that
   *    rendered it.
   *  - `0` freezes the sim while still rendering. That is how the recorder
   *    holds the world still across a slow canvas readback: the accumulator
   *    does not advance, no tick runs, and rAF keeps turning — which matters
   *    because three's Animation module bumps `nodeFrame.frameId` from its own
   *    rAF, and post silently re-composites a STALE scene texture if that
   *    stops (docs/agent-browser-harness.md §3).
   *
   * `null` hands the loop back to the wall clock.
   */
  setFixedDt(dt: number | null): void {
    this.fixedDt = dt;
  }

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
      const wallFrameDt = (timeMs - this.lastTime) / 1000;
      const frameDt =
        this.fixedDt !== null ? this.fixedDt : Math.min(wallFrameDt, 0.25);
      // advanced even when overridden, so handing the clock back does not
      // deliver one enormous catch-up frame
      this.lastTime = timeMs;
      // PAUSE FREEZES THE ACCUMULATOR, not merely the tick. Gating only the
      // tick leaves the accumulator advancing, so alpha saw-tooths 0→1 every
      // SIM_DT while prev/curr sim poses stay frozen ONE TICK APART — render
      // then lerps the ship between two different poses at display rate and
      // the camera, which chases that interpolated pose, shakes the entire
      // scene. Holding alpha flat is what makes "sim halts, render continues"
      // actually mean a still picture.
      if (this.isPaused()) {
        this.render(this.alpha, frameDt, wallFrameDt);
        return;
      }
      const res = advanceAccumulator(this.accumulator, frameDt);
      this.accumulator = res.accumulator;
      this.alpha = res.alpha;
      for (let i = 0; i < res.steps; i++) this.tick(SIM_DT);
      this.render(res.alpha, frameDt, wallFrameDt);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }
}
