/**
 * Debug shell integration surface (T2: §V.16, §V.17).
 *
 * createDebugShell(opts: { onWeatherPreset?: (p: string) => void })
 *   => { panel: DebugPanel, hud: PerfHud, dispose(): void }
 *
 * Integrator (app.ts) usage:
 *   const debug = createDebugShell({ onWeatherPreset: applyPreset });
 *   // per rAF:
 *   debug.hud.frame(frameDtMs);
 *   debug.hud.setPassTiming('ocean-fft', ms);
 *   debug.hud.setRenderStats(renderer.info.render);
 *   // teardown:
 *   debug.dispose();
 *
 * Systems expose tunables by calling registerParams(name, obj, meta) from
 * their params/*.ts module — a panel folder appears automatically, even
 * when the system registers after the shell was created. Tab toggles the
 * panel.
 */
import { createDebugPanel, type DebugPanel } from './panel';
import { createPerfHud, type PerfHud } from './perfHud';

export type { DebugPanel, WeatherPreset } from './panel';
export type { PerfHud, RenderStats } from './perfHud';

export interface DebugShell {
  panel: DebugPanel;
  hud: PerfHud;
  dispose(): void;
}

export function createDebugShell(
  opts: { onWeatherPreset?: (p: string) => void } = {},
): DebugShell {
  const panel = createDebugPanel(opts);
  const hud = createPerfHud();
  return {
    panel,
    hud,
    dispose(): void {
      panel.dispose();
      hud.dispose();
    },
  };
}
