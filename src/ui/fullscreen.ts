/**
 * Full screen (§V21 — a pause-menu ACTION, not a stored setting).
 *
 * Deliberately not persisted. `requestFullscreen()` only works inside a user
 * gesture, so a remembered "was full screen" could never be honoured on boot:
 * it would be a preference the game silently ignores every launch, which is
 * exactly the silent-no-op shape §B keeps punishing. The control mirrors the
 * REAL state instead, and the browser is the single owner of that truth.
 *
 * The whole document goes full screen, not the canvas: fullscreening the
 * canvas alone would leave the HUD and this very menu outside the fullscreen
 * element and therefore invisible.
 *
 * Resize: entering/leaving fires a window `resize`, which App.onResize already
 * listens for, so the renderer, clipmap and reflection target follow.
 */

export interface FullscreenControl {
  /** false in browsers/iframes that refuse it — the caller hides the entry */
  supported(): boolean;
  isActive(): boolean;
  /** MUST be called from a user gesture (click/keypress handler) */
  toggle(): void;
  subscribe(cb: (active: boolean) => void): () => void;
  dispose(): void;
}

export function createFullscreen(
  target: HTMLElement = document.documentElement,
): FullscreenControl {
  const listeners = new Set<(active: boolean) => void>();
  const active = (): boolean => document.fullscreenElement !== null;

  const onChange = (): void => {
    for (const cb of listeners) cb(active());
  };
  document.addEventListener('fullscreenchange', onChange);

  return {
    supported: () => typeof target.requestFullscreen === 'function' && document.fullscreenEnabled,
    isActive: active,
    toggle(): void {
      const done = active() ? document.exitFullscreen() : target.requestFullscreen();
      // a rejected request leaves the DOM state unchanged and fires no event,
      // so re-notify by hand or the switch would sit there claiming success
      void Promise.resolve(done).catch((err: unknown) => {
        console.warn('[ui] full screen refused by the browser', err);
        onChange();
      });
    },
    subscribe(cb): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose(): void {
      document.removeEventListener('fullscreenchange', onChange);
      listeners.clear();
    },
  };
}
