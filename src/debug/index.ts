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
import { setDevLayerSink } from '../ui/devLayer';

export type { DebugPanel, WeatherPreset } from './panel';
export type { PerfHud, RenderStats } from './perfHud';
// the same HUD, for the preview harnesses — no page counts its own frames (§V95)
export { createHarnessHud, type HarnessHud } from './harnessHud';

export interface DebugShell {
  panel: DebugPanel;
  hud: PerfHud;
  /** show/hide the whole dev layer — also driven by F1 and by full screen */
  setVisible(visible: boolean): void;
  dispose(): void;
}

export function createDebugShell(
  opts: { onWeatherPreset?: (p: string) => void } = {},
): DebugShell {
  const panel = createDebugPanel(opts);
  const hud = createPerfHud();

  const setVisible = (visible: boolean): void => {
    panel.setLayerVisible(visible);
    hud.el.style.display = visible ? '' : 'none';
  };

  // §I ui/cinematic: the shell REGISTERS itself with the UI's dev-layer
  // channel rather than main.ts wiring the two together. Order-independent —
  // the channel replays its current state to whichever side attaches second —
  // and it keeps src/ui free of Tweakpane.
  const detach = setDevLayerSink(setVisible);

  return {
    panel,
    hud,
    setVisible,
    dispose(): void {
      detach();
      panel.dispose();
      hud.dispose();
    },
  };
}
