/**
 * Settings → engine bindings, shared by every mode (§V95).
 *
 * The UI owns the persisted settings store; the renderer and the params are
 * ours. Both entries pushed the same two settings through the same two lines
 * of glue, separately — and a resolution scale that only one mode honours is
 * the §V.62 dead-knob shape wearing a second hat.
 *
 * Both bindings push ONCE up front and then on every change, so a stored sky,
 * a stored wind and a stored resolution scale survive a reload.
 */
import type { GameSettings, SettingsStore } from '../ui/settingsStore';
import { applyWorldSettings } from '../ui/settingsStore';

/** the renderer's pixel ratio, capped at 2 and scaled by the graphics setting */
export function bindResolution(
  renderer: { setPixelRatio(ratio: number): void },
  settings: SettingsStore,
): void {
  const apply = (s: GameSettings = settings.get()): void => {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * s.graphics.resolutionScale);
  };
  apply();
  settings.subscribe(apply);
}

/**
 * World staging — time of day and the wind. `applyWorldSettings` is the single
 * mapping between the store and the params (it is what the §V.62 wiring test
 * holds), and the wind lands on `oceanParams`, which is where the sim tick
 * reads `state.wind` from: one write moves the spectrum, the sails, the AI,
 * the flags, the spray, the palms and the weather cells' drift together.
 */
export function bindWorldSettings(settings: SettingsStore): void {
  const apply = (s: GameSettings = settings.get()): void => {
    applyWorldSettings(s.world);
  };
  apply();
  settings.subscribe(apply);
}
