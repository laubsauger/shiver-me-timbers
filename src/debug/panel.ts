/**
 * Tweakpane debug panel (§V.16): auto-builds one folder per registry
 * entry, including entries registered after panel creation (registry
 * subscription replays existing + streams late registrations). Tab
 * toggles visibility. Logic lives in the registry; this file is thin
 * UI glue. Only primitive values (number/boolean/string) get bindings.
 */
import { Pane } from 'tweakpane';
import { subscribeParams, type ParamsEntry } from '../params/registry';

/**
 * Narrow structural view of the Pane API. Tweakpane's full types live in
 * `@tweakpane/core`, which v4 does not ship — so the imported `Pane` type
 * is missing addBinding/addFolder/hidden. Untyped-narrow glue per T2.
 */
interface BindingLike {
  on(event: 'change', handler: (ev: { value: unknown }) => void): void;
}
interface FolderLike {
  addBinding(
    obj: Record<string, unknown>,
    key: string,
    opts?: object,
  ): BindingLike;
  dispose(): void;
}
interface PaneLike extends FolderLike {
  hidden: boolean;
  addFolder(opts: { title: string }): FolderLike;
}

export const WEATHER_PRESETS = ['calm', 'swell', 'storm'] as const;
export type WeatherPreset = (typeof WEATHER_PRESETS)[number];

export interface DebugPanelOpts {
  /** invoked when the weather preset dropdown changes (wiring = T6) */
  onWeatherPreset?: (preset: string) => void;
}

export interface DebugPanel {
  pane: Pane;
  toggle(): void;
  dispose(): void;
}

export function createDebugPanel(opts: DebugPanelOpts = {}): DebugPanel {
  const pane = new Pane({ title: 'debug' });
  const api = pane as unknown as PaneLike;

  // weather preset placeholder — param sets themselves are T6 (§V.7)
  const weather: Record<string, unknown> = { preset: 'swell' as WeatherPreset };
  api
    .addBinding(weather, 'preset', {
      options: Object.fromEntries(WEATHER_PRESETS.map((p) => [p, p])),
    })
    .on('change', (ev) => opts.onWeatherPreset?.(String(ev.value)));

  // one folder per registered params module; rebuilt on re-registration
  const folders = new Map<string, FolderLike>();
  const buildFolder = (entry: ParamsEntry): void => {
    folders.get(entry.name)?.dispose();
    const folder = api.addFolder({ title: entry.name });
    for (const key of Object.keys(entry.params)) {
      const value = entry.params[key];
      const t = typeof value;
      if (t !== 'number' && t !== 'boolean' && t !== 'string') continue;
      folder.addBinding(entry.params, key, entry.meta[key] ?? {});
    }
    folders.set(entry.name, folder);
  };
  const unsubscribe = subscribeParams(buildFolder);

  const toggle = (): void => {
    api.hidden = !api.hidden;
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Tab') return;
    const target = e.target as HTMLElement | null;
    // let Tab behave normally while editing a panel text field
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'))
      return;
    e.preventDefault();
    toggle();
  };
  window.addEventListener('keydown', onKeyDown);

  return {
    pane,
    toggle,
    dispose(): void {
      window.removeEventListener('keydown', onKeyDown);
      unsubscribe();
      pane.dispose();
    },
  };
}
