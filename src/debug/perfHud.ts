/**
 * Perf HUD (§V.17): frame budget is an invariant, so timings stay on
 * screen. fps = rolling FPS_WINDOW-frame avg; per-pass ms rows fed via
 * setPassTiming(); renderer.info.render stats via setRenderStats().
 * Styles inline — no CSS files.
 */

export const FPS_WINDOW = 30;

/** shape of `renderer.info.render` we display */
export interface RenderStats {
  calls: number;
  triangles: number;
}

export interface PerfHud {
  el: HTMLDivElement;
  /** call once per rAF with the frame duration in ms */
  frame(frameMs: number): void;
  setPassTiming(label: string, ms: number): void;
  setRenderStats(stats: RenderStats): void;
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
  let stats: RenderStats | null = null;

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
    if (stats) {
      lines.push('--- render ---');
      lines.push(`calls ${stats.calls}  tris ${stats.triangles}`);
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
      stats = s;
    },
    dispose(): void {
      el.remove();
    },
  };
}
