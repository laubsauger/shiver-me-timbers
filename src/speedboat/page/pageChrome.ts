/**
 * THE SPEEDBOAT PAGE'S CHROME (§T.201, USER: "missing … ways to go fullscreen and hide the dev stuff"): full screen and
 * the dev overlays (perf HUD + Tweakpane), by key, by the pause menu, and remembered.
 *
 * SHARED, NOT COPIED (§V95): full screen is `ui/fullscreen.ts` (whole document, mirrors the browser's real state, a
 * refused request re-notifies) and the dev layer is the `ui/devLayer.ts` channel the debug shell already listens on.
 * Keys follow pirate/raft: Tab or F1 toggles the dev overlays, Alt+Enter goes full screen (`isFullscreenShortcut`);
 * `F` is added here because a race has no text field for it to fight.
 *
 * DEV OVERLAYS ARE HIDDEN BY DEFAULT on this page. `?dev` (or `?dev=1`) forces them on for the session, `?dev=0` off;
 * otherwise the last toggle is remembered (every storage touch guarded: a blocked store just means the default).
 * No speedboat pointer lock exists (raceCam.capturesInput() is false), so there is nothing to release around full screen;
 * the resize full screen fires reaches App.onResize and the HUD's own resize listener.
 */
import { isFullscreenShortcut } from '../../input/controlMap';
import { applyDevLayer } from '../../ui/devLayer';
import { createFullscreen, type FullscreenControl } from '../../ui/fullscreen';
import { browserStore, type KeyValueStore } from './raceSettings';

export const DEV_OVERLAYS_KEY = 'smt.speedboat.devOverlays';

/** `?dev` wins for the session; else the remembered toggle; else hidden */
export function initialDevOverlays(search: string, store: KeyValueStore | null): boolean {
  const q = new URLSearchParams(search);
  if (q.has('dev')) return q.get('dev') !== '0';
  try {
    return store?.getItem(DEV_OVERLAYS_KEY) === '1';
  } catch {
    return false;
  }
}

type KeyLike = Pick<KeyboardEvent, 'code' | 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'repeat' | 'target'>;

/** what a keydown means to the chrome; null = not ours (typing into a panel field is never ours) */
export function chromeKeyFor(e: KeyLike): 'fullscreen' | 'dev' | null {
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null;
  if (e.repeat || (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable))) return null;
  if (isFullscreenShortcut(e)) return 'fullscreen';
  if (e.altKey || e.ctrlKey || e.metaKey) return null;
  if (e.code === 'KeyF' && !e.shiftKey) return 'fullscreen';
  if (e.key === 'Tab' || e.key === 'F1') return 'dev';
  return null;
}

export interface PageChrome {
  readonly fullscreen: FullscreenControl;
  devOverlays(): boolean;
  toggleDev(): void;
  /** fires on a dev toggle and on every full-screen change (the pause menu mirrors both) */
  subscribe(cb: () => void): () => void;
  dispose(): void;
}

export interface PageChromeOptions {
  search?: string;
  store?: KeyValueStore | null;
  /** keydown source; default window */
  target?: EventTarget;
  fullscreen?: FullscreenControl;
}

export function createPageChrome(o: PageChromeOptions = {}): PageChrome {
  const store = o.store === undefined ? browserStore() : o.store;
  const fullscreen = o.fullscreen ?? createFullscreen();
  const listeners = new Set<() => void>();
  const notify = (): void => listeners.forEach((cb) => cb());
  let dev = initialDevOverlays(o.search ?? location.search, store);
  applyDevLayer(dev);

  const toggleDev = (): void => {
    dev = !dev;
    applyDevLayer(dev);
    try {
      store?.setItem(DEV_OVERLAYS_KEY, dev ? '1' : '0');
    } catch {
      /* storage is a convenience */
    }
    notify();
  };
  const onKey = (e: Event): void => {
    const k = chromeKeyFor(e as KeyboardEvent);
    if (!k) return;
    e.preventDefault(); // Tab would move focus, F1 is the browser's help
    if (k === 'dev') toggleDev();
    else if (fullscreen.supported()) fullscreen.toggle(); // inside the keydown: a user gesture
  };
  const target = o.target ?? window;
  target.addEventListener('keydown', onKey);
  const unsubscribe = fullscreen.subscribe(notify);

  return {
    fullscreen,
    devOverlays: () => dev,
    toggleDev,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose() {
      target.removeEventListener('keydown', onKey);
      unsubscribe();
      listeners.clear();
    },
  };
}
