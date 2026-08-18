/**
 * Perf HUD (§V.17): frame budget is an invariant, so timings stay on
 * screen. fps = rolling FPS_WINDOW-frame avg; per-pass ms rows fed via
 * setPassTiming(); renderer.info.render stats via setRenderStats().
 * Styles inline — no CSS files.
 */

export const FPS_WINDOW = 30;

/**
 * Shape of `renderer.info.render` we display.
 *
 * `drawCalls` and `triangles` ARE per-frame: `Renderer.init()` starts three's
 * own rAF loop (`Animation.start()`, Renderer.js:803) which calls
 * `info.reset()` every frame whether or not `setAnimationLoop` is used, so
 * §V.2's separate loop does not have to.
 *
 * `calls` is NOT. `Info.reset()` deliberately leaves it alone — it is a
 * LIFETIME counter, measured at 206 262 on a session that was drawing 486
 * objects per frame. That is §B.25's "4238 → 38978 within one build": the
 * counter was never wrong, it was the wrong counter. Read `drawCalls`.
 */
export interface RenderStats {
  calls: number;
  drawCalls: number;
  triangles: number;
}

export interface PerfHud {
  el: HTMLDivElement;
  /** call once per rAF with the frame duration in ms */
  frame(frameMs: number): void;
  setPassTiming(label: string, ms: number): void;
  setRenderStats(stats: RenderStats): void;
  /** GPU timestamp block, pre-formatted; null hides it (§V.39) */
  setGpu(lines: readonly string[] | null): void;
  dispose(): void;
}

export function createPerfHud(parent: HTMLElement = document.body): PerfHud {
  const el = document.createElement('div');
  el.style.cssText = [
    'position:fixed',
    'top:8px',
    'left:8px',
    'z-index:1000',
    'padding:6px 8px',
    'background:rgba(0,0,0,0.65)',
    'color:#9f9',
    'font:11px/1.5 monospace',
    'white-space:pre',
    'pointer-events:none',
    'border-radius:4px',
  ].join(';');
  parent.appendChild(el);

  const samples = new Float32Array(FPS_WINDOW);
  let sampleCount = 0;
  let cursor = 0;
  let lastFrameMs = 0;
  const passes = new Map<string, number>();
  /**
   * A SNAPSHOT, not the live `renderer.info.render`.
   *
   * `Renderer.init()` starts three's own rAF loop (`Animation.start()`,
   * Renderer.js:803), registered during renderer construction — i.e. BEFORE
   * §V.2's loop registers its own. Every tick therefore runs three's callback
   * first, and that callback opens with `info.reset()`. §V.2's loop then calls
   * `hud.frame()` at the TOP of its callback, so a HUD holding a reference to
   * the live object redraws in the one window where the counters are
   * guaranteed to be zero — measured `draws 0  tris 0` on a frame that drew
   * 515 objects and 1.86 M triangles. Copying the values at
   * `setRenderStats()` time (which main.ts calls immediately AFTER the render,
   * before the reset) is what makes the row a measurement rather than proof
   * that reset ran. Same class of fault as §B.25: the counter was never
   * broken, it was read at the wrong instant.
   */
  let stats: RenderStats | null = null;
  let gpu: readonly string[] | null = null;

  const redraw = (): void => {
    let sum = 0;
    for (let i = 0; i < sampleCount; i++) sum += samples[i];
    const avgMs = sampleCount > 0 ? sum / sampleCount : 0;
    const fps = avgMs > 0 ? 1000 / avgMs : 0;
    const lines = [
      `fps   ${fps.toFixed(1)}`,
      `frame ${lastFrameMs.toFixed(2)} ms`,
    ];
    if (passes.size > 0) {
      lines.push('--- passes ---');
      for (const [label, ms] of passes) {
        lines.push(`${label.padEnd(14)} ${ms.toFixed(2)} ms`);
      }
    }
    if (gpu !== null && gpu.length > 0) {
      lines.push('--- gpu (min-of-N) ---');
      for (const l of gpu) lines.push(l);
    }
    if (stats) {
      lines.push('--- render ---');
      lines.push(`draws ${stats.drawCalls}  tris ${stats.triangles}`);
    }
    el.textContent = lines.join('\n');
  };

  return {
    el,
    frame(frameMs: number): void {
      lastFrameMs = frameMs;
      samples[cursor] = frameMs;
      cursor = (cursor + 1) % FPS_WINDOW;
      if (sampleCount < FPS_WINDOW) sampleCount++;
      redraw();
    },
    setPassTiming(label: string, ms: number): void {
      passes.set(label, ms);
    },
    setRenderStats(s: RenderStats): void {
      // copy, do not alias — see the `stats` declaration above
      if (stats === null) stats = { calls: 0, drawCalls: 0, triangles: 0 };
      stats.calls = s.calls;
      stats.drawCalls = s.drawCalls;
      stats.triangles = s.triangles;
    },
    setGpu(lines: readonly string[] | null): void {
      gpu = lines;
    },
    dispose(): void {
      el.remove();
    },
  };
}
