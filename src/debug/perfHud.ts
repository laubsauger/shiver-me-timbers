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
  /**
   * Call once per rAF with the frame duration in ms. Nothing on the overlay
   * reports this sample on its own — it feeds the FPS_WINDOW ring, and the
   * frame row prints avg/min/max of that ring. See `redraw()` for why a single
   * sample beside a windowed fps was worse than useless.
   */
  frame(frameMs: number): void;
  setPassTiming(label: string, ms: number): void;
  setRenderStats(stats: RenderStats): void;
  /** GPU timestamp block, pre-formatted; null hides it (§V.39) */
  setGpu(lines: readonly string[] | null): void;
  /**
   * Free-text rows under the timings; null clears them. For facts a harness
   * needs on screen beside the frame budget (the focused station prompt, the
   * wind it was launched with, the shadow rig it is A/B-ing) — so a preview
   * page never has a reason to grow a second overlay with its own fps math
   * (§V95).
   */
  setNotes(lines: readonly string[] | null): void;
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
  let notes: readonly string[] | null = null;

  const redraw = (): void => {
    /**
     * THE FRAME ROW IS A WINDOW, NOT A SAMPLE.
     *
     * It used to print the single most recent `frameDt`. Beside a 30-frame
     * average fps that is inconsistent by construction, and it is how
     * `fps 261.1` came to sit next to `frame 0.00 ms` on the same overlay: two
     * statistics of different things, neither labelled. A capture reading
     * `frame 9.30 ms` was likewise honest and useless — the same window
     * averaged 23.3 ms, so the frame was JITTERY, not cheap, and a whole
     * investigation was steered by reading one sample as steady state.
     *
     * `avg` is now exactly `1000 / fps` by construction, so the two rows can
     * never disagree, and `min`/`max` put the jitter on screen where the
     * average hides it.
     */
    let sum = 0;
    let min = Infinity;
    let max = 0;
    let zeros = 0;
    for (let i = 0; i < sampleCount; i++) {
      const v = samples[i];
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
      // `<= 0`, not `=== 0`: a regressed rAF timestamp gives a NEGATIVE dt,
      // which drags the average down and inflates fps just as badly.
      if (v <= 0) zeros++;
    }
    const avgMs = sampleCount > 0 ? sum / sampleCount : 0;
    const fps = avgMs > 0 ? 1000 / avgMs : 0;
    const lines = [
      `fps   ${fps.toFixed(1)}  (${sampleCount}-frame avg)`,
      `frame ${avgMs.toFixed(2)} avg  ${(sampleCount > 0 ? min : 0).toFixed(2)} min  ` +
        `${max.toFixed(2)} max ms`,
    ];
    /**
     * A ZERO-LENGTH FRAME IS NOT A FRAME.
     *
     * `frameDt` is `(rAF timestamp - previous rAF timestamp)`, and Chrome hands
     * every callback fired for one frame the SAME timestamp. So a dt of exactly
     * 0 does not mean an instant frame — it means the render callback ran twice
     * against one timestamp, which inflates fps by the duplication factor while
     * showing 0 in the frame row. That is the failure mode `fps 261.1` /
     * `frame 0.00 ms` looks like, and it is silent unless it is said out loud.
     *
     * The arithmetic fits: a window alternating 7.66 ms and 0 averages 3.83 ms,
     * i.e. exactly `fps 261.1`, on a machine actually running 130.5 fps
     * (`tests/perfHudFrameRow.test.ts` reconstructs it). NOT PROVEN to be what
     * produced that capture — the source of a duplicated dispatch was never
     * found, and this row can only report the symptom.
     */
    if (zeros > 0) {
      lines.push(`!! ${zeros}/${sampleCount} frames had dt<=0 — fps is INFLATED, not real`);
    }
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
    if (notes !== null && notes.length > 0) {
      for (const l of notes) lines.push(l);
    }
    el.textContent = lines.join('\n');
  };

  return {
    el,
    frame(frameMs: number): void {
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
    setNotes(lines: readonly string[] | null): void {
      notes = lines;
    },
    dispose(): void {
      el.remove();
    },
  };
}
