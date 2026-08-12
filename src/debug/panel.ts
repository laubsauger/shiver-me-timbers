/**
 * Tweakpane debug panel (§V.16): auto-builds one folder per registry
 * entry, including entries registered after panel creation (registry
 * subscription replays existing + streams late registrations). Tab
 * toggles visibility. Logic lives in the registry; this file is thin
 * UI glue. Only primitive values (number/boolean/string) get bindings.
 *
 * SCALE: this project now registers ~25 params modules with several hundred
 * keys between them. A default Tweakpane is a single unscrollable column, so
 * past a certain size the panel stops being usable — the user could not reach
 * a toggle at all. Three things fix that and they are all in this file:
 *   - the pane lives in an OWN scroll container, capped to the viewport;
 *   - folders start COLLAPSED, so the default view is ~25 titles not 400 rows;
 *   - a search box filters folders AND individual keys, live.
 * `window.__params` is also published as a console escape hatch, because a GUI
 * that has to be found is worse than a one-liner when you already know the key.
 */
import { Pane } from 'tweakpane';
import {
  subscribeParams,
  listParamsEntries,
  type ParamsEntry,
} from '../params/registry';

/**
 * Narrow structural view of the Pane API. Tweakpane's full types live in
 * `@tweakpane/core`, which v4 does not ship — so the imported `Pane` type
 * is missing addBinding/addFolder/hidden. Untyped-narrow glue per T2.
 */
interface BindingLike {
  on(event: 'change', handler: (ev: { value: unknown }) => void): void;
  hidden: boolean;
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
  expanded: boolean;
  element: HTMLElement;
  addFolder(opts: { title: string; expanded?: boolean }): FolderLike;
}
interface FolderExtra extends FolderLike {
  hidden: boolean;
  expanded: boolean;
  title: string;
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
  /** whole-dev-layer gate (F1 / cinematic), independent of the Tab state */
  setLayerVisible(visible: boolean): void;
  /** filter folders + keys by substring; '' shows everything */
  search(query: string): void;
  dispose(): void;
}

/** a folder plus the bindings inside it, so search can hide rows not just groups */
interface FolderRecord {
  folder: FolderExtra;
  rows: Array<{ key: string; binding: BindingLike }>;
}

export function createDebugPanel(opts: DebugPanelOpts = {}): DebugPanel {
  // own scroll container: Tweakpane renders one long column and will happily
  // run off the bottom of the screen with no way to reach the rest
  const host = document.createElement('div');
  host.className = 'debug-pane-host';
  host.style.cssText = [
    'position:fixed',
    'top:8px',
    'right:8px',
    'z-index:9000',
    'width:320px',
    'max-height:calc(100vh - 16px)',
    'overflow-y:auto',
    'overflow-x:hidden',
    'overscroll-behavior:contain',
  ].join(';');
  document.body.appendChild(host);

  const pane = new Pane({ title: 'debug', container: host });
  const api = pane as unknown as PaneLike;

  // search box, built as a plain input rather than a Tweakpane binding so it
  // can never be filtered out by its own filter
  const searchWrap = document.createElement('div');
  searchWrap.style.cssText = 'padding:4px 4px 6px;position:sticky;top:0;z-index:1;background:#28292e';
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.placeholder = 'filter params…  (e.g. deckwater, enabled)';
  searchInput.style.cssText = [
    'width:100%',
    'box-sizing:border-box',
    'padding:5px 7px',
    'border:1px solid #4a4b52',
    'border-radius:4px',
    'background:#1c1d21',
    'color:#e6e6e6',
    'font:11px/1.3 system-ui,sans-serif',
  ].join(';');
  searchWrap.appendChild(searchInput);
  host.insertBefore(searchWrap, host.firstChild);

  // weather preset placeholder — param sets themselves are T6 (§V.7)
  const weather: Record<string, unknown> = { preset: 'swell' as WeatherPreset };
  api
    .addBinding(weather, 'preset', {
      options: Object.fromEntries(WEATHER_PRESETS.map((p) => [p, p])),
    })
    .on('change', (ev) => opts.onWeatherPreset?.(String(ev.value)));

  // one folder per registered params module; rebuilt on re-registration
  const folders = new Map<string, FolderRecord>();
  let query = '';

  const applyFilter = (): void => {
    const q = query.trim().toLowerCase();
    for (const [name, rec] of folders) {
      const nameHit = name.toLowerCase().includes(q);
      let anyRow = false;
      for (const row of rec.rows) {
        // a folder-name match shows the whole folder; otherwise match per key
        const hit = q === '' || nameHit || row.key.toLowerCase().includes(q);
        row.binding.hidden = !hit;
        anyRow ||= hit;
      }
      rec.folder.hidden = q !== '' && !anyRow;
      // searching auto-opens what matched, and collapses again when cleared
      rec.folder.expanded = q !== '' && anyRow;
    }
  };

  const buildFolder = (entry: ParamsEntry): void => {
    folders.get(entry.name)?.folder.dispose();
    // COLLAPSED by default: ~25 modules of several hundred keys is unusable
    // as an open list, and the first thing anyone needs is to find a module.
    const folder = api.addFolder({
      title: entry.name,
      expanded: false,
    }) as FolderExtra;
    const rows: FolderRecord['rows'] = [];
    for (const key of Object.keys(entry.params)) {
      const value = entry.params[key];
      const t = typeof value;
      if (t !== 'number' && t !== 'boolean' && t !== 'string') continue;
      rows.push({ key, binding: folder.addBinding(entry.params, key, entry.meta[key] ?? {}) });
    }
    folders.set(entry.name, { folder, rows });
    applyFilter();
  };
  const unsubscribe = subscribeParams(buildFolder);

  searchInput.addEventListener('input', () => {
    query = searchInput.value;
    applyFilter();
  });
  // typing in the box must not toggle the panel or steer the ship
  searchInput.addEventListener('keydown', (e) => e.stopPropagation());

  // console escape hatch — `__params.deckwater.enabled = false` beats hunting
  // for a control, and it keeps working when the panel is hidden or filtered.
  (window as unknown as Record<string, unknown>).__params = Object.fromEntries(
    listParamsEntries().map((e) => [e.name, e.params]),
  );

  // TWO independent gates (§I ui/cinematic): `open` is the player's Tab state
  // for this panel; `layerVisible` is F1/cinematic hiding the whole dev layer.
  // Keeping them apart means going full screen and coming back restores the
  // panel exactly as it was, rather than to whatever the last toggle guessed.
  let open = true;
  let layerVisible = true;
  const applyVisibility = (): void => {
    const shown = open && layerVisible;
    api.hidden = !shown;
    host.style.display = shown ? '' : 'none';
  };
  const toggle = (): void => {
    open = !open;
    applyVisibility();
  };
  const setLayerVisible = (v: boolean): void => {
    layerVisible = v;
    applyVisibility();
  };
  // NO key binding here. Tab is bound once, in src/ui/viewModes.ts, and drives
  // the whole dev layer through setLayerVisible(). This file used to bind Tab
  // for its own `open` flag while F1 gated the layer, which meant two keys,
  // two hidden states, and a Tab press that did nothing whenever the layer was
  // already down. `open` survives only for the programmatic toggle() below.

  return {
    pane,
    toggle,
    setLayerVisible,
    search(q: string): void {
      query = q;
      searchInput.value = q;
      applyFilter();
    },
    dispose(): void {
      unsubscribe();
      pane.dispose();
      host.remove();
    },
  };
}
