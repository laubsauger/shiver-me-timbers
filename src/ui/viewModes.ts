/**
 * View modes (§I ui/cinematic) — what is on screen over the render, and how
 * Escape gets you back out of it.
 *
 * THREE LAYERS, most transient first:
 *   photo mode   — nothing at all: no HUD, no dev tools. `P` (or F2).
 *   dev layer    — Tweakpane + perf HUD. `F1`.
 *   game HUD     — compass, plaques, wind rose. Always on outside photo mode.
 * Menus are never part of a mode: hiding the pause menu would trap the player.
 *
 * FULL SCREEN IS CINEMATIC BY DEFAULT. Going full screen is the gesture that
 * means "I am recording now", so the dev layer steps aside on entry and comes
 * back exactly as it was on exit — F1 while full screen is a look inside the
 * shot, not a new preference for the desktop window.
 *
 * ESCAPE PEELS ONE LAYER PER PRESS, outermost first:
 *   full screen → photo mode → settings view → pause menu → (pause).
 * The browser owns the first rung and exits full screen on that very keypress,
 * so this controller only starts at the second. One press, one layer, always.
 *
 * The reducer below is pure and holds every one of those rules, so the ladder
 * is pinned by tests rather than by the order of DOM event handlers.
 */
import { applyDevLayer } from './devLayer';
import type { FullscreenControl } from './fullscreen';
import { div } from './dom';

export interface ViewState {
  /** the player's standing intent for the dev layer */
  dev: boolean;
  photo: boolean;
  /** dev intent parked while full screen holds it down; null = not parked */
  devBeforeFullscreen: boolean | null;
}

export type ViewAction =
  | { type: 'toggleDev' }
  | { type: 'togglePhoto' }
  | { type: 'enterFullscreen' }
  | { type: 'exitFullscreen' }
  | { type: 'escape' };

export const INITIAL_VIEW_STATE: ViewState = {
  dev: true,
  photo: false,
  devBeforeFullscreen: null,
};

/** what the debug shell is actually told — photo mode outranks the F1 intent */
export function devLayerFor(s: ViewState): boolean {
  return s.dev && !s.photo;
}

export interface ViewTransition {
  state: ViewState;
  /** true = this Escape was spent here and must not also reach the pause menu */
  consumedEscape: boolean;
  /** one line to show the player when the interface vanishes under them */
  caption?: string;
}

export function reduceView(s: ViewState, action: ViewAction): ViewTransition {
  switch (action.type) {
    case 'toggleDev': {
      const dev = !devLayerFor(s);
      // asking for the dev tools ends photo mode — otherwise F1 would set an
      // intent the player cannot see the result of, which reads as a dead key
      return {
        state: { ...s, dev, photo: dev ? false : s.photo },
        consumedEscape: false,
        caption: dev ? undefined : 'Dev tools hidden — F1 to bring them back',
      };
    }
    case 'togglePhoto': {
      const photo = !s.photo;
      return {
        state: { ...s, photo },
        consumedEscape: false,
        caption: photo ? 'Photo mode — Esc or P to return · C for free camera' : undefined,
      };
    }
    case 'enterFullscreen': {
      if (s.devBeforeFullscreen !== null) return { state: s, consumedEscape: false };
      return {
        state: { ...s, dev: false, devBeforeFullscreen: s.dev },
        consumedEscape: false,
        caption: s.dev ? 'Cinematic — F1 for dev tools · P for photo mode' : undefined,
      };
    }
    case 'exitFullscreen': {
      if (s.devBeforeFullscreen === null) return { state: s, consumedEscape: false };
      return {
        state: { ...s, dev: s.devBeforeFullscreen, devBeforeFullscreen: null },
        consumedEscape: false,
      };
    }
    case 'escape': {
      // photo mode is the outermost thing this controller owns; everything
      // below it belongs to the pause menu, so the key passes through
      if (!s.photo) return { state: s, consumedEscape: false };
      return { state: { ...s, photo: false }, consumedEscape: true };
    }
  }
}

export interface ViewModes {
  isPhoto(): boolean;
  isDevVisible(): boolean;
  /** Escape handler for the pause menu: true = the key was spent here */
  peelEscape(): boolean;
  dispose(): void;
}

/** keys that must not fire while the player is typing into a panel field */
function typingInto(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

export function createViewModes(root: HTMLElement, fullscreen: FullscreenControl): ViewModes {
  let state = INITIAL_VIEW_STATE;

  const caption = div('smt-caption');
  caption.setAttribute('role', 'status');
  root.appendChild(caption);
  let captionTimer: ReturnType<typeof setTimeout> | undefined;

  function showCaption(text: string): void {
    caption.textContent = text;
    caption.classList.add('is-on');
    clearTimeout(captionTimer);
    captionTimer = setTimeout(() => caption.classList.remove('is-on'), 2800);
  }

  function apply(): void {
    root.classList.toggle('is-photo', state.photo);
    applyDevLayer(devLayerFor(state));
  }

  function dispatch(action: ViewAction): boolean {
    const next = reduceView(state, action);
    state = next.state;
    apply();
    if (next.caption) showCaption(next.caption);
    return next.consumedEscape;
  }

  // push the initial state so a debug shell built earlier is already in sync
  apply();

  function onKeyDown(e: KeyboardEvent): void {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || typingInto(e.target)) return;
    // P as well as F2: on the reference machine the F-row is media keys unless
    // the player has changed a system setting, and a capture binding that
    // needs Fn held is not a capture binding
    if (e.key === 'F1') {
      e.preventDefault(); // F1 is the browser's help key
      dispatch({ type: 'toggleDev' });
    } else if (e.key === 'F2' || e.key === 'p' || e.key === 'P') {
      e.preventDefault();
      dispatch({ type: 'togglePhoto' });
    }
  }
  window.addEventListener('keydown', onKeyDown);

  const unsubscribeFullscreen = fullscreen.subscribe((active) =>
    dispatch({ type: active ? 'enterFullscreen' : 'exitFullscreen' }),
  );

  return {
    isPhoto: () => state.photo,
    isDevVisible: () => devLayerFor(state),
    peelEscape: () => dispatch({ type: 'escape' }),
    dispose(): void {
      window.removeEventListener('keydown', onKeyDown);
      unsubscribeFullscreen();
      clearTimeout(captionTimer);
      caption.remove();
      root.classList.remove('is-photo');
      applyDevLayer(true);
    },
  };
}
