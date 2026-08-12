/**
 * Pause menu (§V21: Esc opens/closes; sim halt is wired by the caller via
 * onPause/onResume — render keeps running underneath, so the backdrop is a
 * translucent sea-dark vignette, not a solid). The panel is a deckle-edged
 * chart: engraved small-caps title, ruled action entries, wax seal accent.
 */
import { uiParams } from '../params/ui';
import type { SettingsStore } from './settingsStore';
import { createSettingsScreen } from './settingsScreen';
import type { MusicStatus } from './settingsScreen';
import { createFullscreen } from './fullscreen';
import { button, div, el, fleuronDivider, sealEmblem } from './dom';

export interface PauseMenuOptions {
  onPause: () => void;
  onResume: () => void;
  settings: SettingsStore;
}

export interface PauseMenu {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  setMusicStatusSource(fn: () => MusicStatus): void;
  dispose(): void;
}

export function createPauseMenu(root: HTMLElement, opts: PauseMenuOptions): PauseMenu {
  let open = false;

  // — backdrop (click anywhere outside the panel resumes) —
  const backdrop = div('smt-backdrop');
  backdrop.setAttribute('aria-hidden', 'true');

  // — panel: menu view —
  const resumeBtn = button('smt-menu-btn', 'Resume');
  // full screen is an ACTION, not a stored setting: the browser only grants it
  // inside a gesture, so it lives with the other verbs and mirrors real state
  const fullscreen = createFullscreen();
  const fullscreenBtn = button('smt-menu-btn', 'Full Screen');
  const fullscreenTag = el('span', 'smt-menu-tag', 'off');
  fullscreenBtn.appendChild(fullscreenTag);
  const settingsBtn = button('smt-menu-btn', 'Settings');
  const restartBtn = button('smt-menu-btn', 'Restart Voyage');
  restartBtn.disabled = true;
  restartBtn.appendChild(el('span', 'smt-menu-tag', 'soon'));

  const menu = div('smt-menu', resumeBtn, settingsBtn, restartBtn);
  if (fullscreen.supported()) menu.insertBefore(fullscreenBtn, settingsBtn);

  const menuView = div(
    'smt-menu-view',
    el('p', 'smt-eyebrow', 'voyage held'),
    el('h1', 'smt-title', 'Becalmed'),
    fleuronDivider(),
    menu,
  );

  function syncFullscreen(): void {
    const on = fullscreen.isActive();
    fullscreenTag.textContent = on ? 'on' : 'off';
    fullscreenBtn.setAttribute('aria-pressed', String(on));
  }
  syncFullscreen();
  const unsubscribeFullscreen = fullscreen.subscribe(syncFullscreen);
  fullscreenBtn.addEventListener('click', () => fullscreen.toggle());

  // — panel: settings view (hidden until opened) —
  const settingsView = createSettingsScreen(opts.settings, () => showView('menu'));
  settingsView.root.style.display = 'none';

  const seal = div('smt-seal');
  seal.appendChild(sealEmblem());

  const panel = div('smt-panel', menuView, settingsView.root, seal);
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Pause menu');
  const wrap = div('smt-panel-wrap', div('smt-panel-shadow', panel));

  root.appendChild(backdrop);
  root.appendChild(wrap);

  let view: 'menu' | 'settings' = 'menu';
  function showView(next: 'menu' | 'settings'): void {
    view = next;
    menuView.style.display = next === 'menu' ? '' : 'none';
    settingsView.root.style.display = next === 'settings' ? '' : 'none';
    // the settings list is long — the chart unfolds rather than scrolling a
    // narrow column, and the wax seal would collide with it, so it steps aside
    panel.classList.toggle('is-settings', next === 'settings');
    if (next === 'menu') resumeBtn.focus();
    else {
      // availability is re-read here, not at build time: main.ts may register
      // feature sinks after the UI exists
      settingsView.refresh();
      settingsView.focusFirst();
    }
  }

  function doOpen(): void {
    if (open) return;
    open = true;
    root.style.setProperty('--smt-dim', String(uiParams.pauseBackdropDim));
    root.classList.add('is-paused');
    showView('menu');
    opts.onPause();
  }

  function doClose(): void {
    if (!open) return;
    open = false;
    root.classList.remove('is-paused');
    opts.onResume();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    // Esc peels ONE layer at a time: full screen, then settings, then pause.
    // The browser owns the first of those and exits full screen on this very
    // keypress — pausing as well would make one press do two things, and the
    // player would come back to a menu they never asked for.
    if (document.fullscreenElement) return;
    e.preventDefault();
    if (!open) doOpen();
    else if (view === 'settings') showView('menu'); // Esc backs out of settings first
    else doClose();
  }

  resumeBtn.addEventListener('click', doClose);
  settingsBtn.addEventListener('click', () => showView('settings'));
  backdrop.addEventListener('click', doClose);
  window.addEventListener('keydown', onKeyDown);

  return {
    open: doOpen,
    close: doClose,
    toggle: () => (open ? doClose() : doOpen()),
    isOpen: () => open,
    setMusicStatusSource: settingsView.setMusicStatusSource,
    dispose(): void {
      window.removeEventListener('keydown', onKeyDown);
      unsubscribeFullscreen();
      fullscreen.dispose();
      settingsView.dispose();
      backdrop.remove();
      wrap.remove();
    },
  };
}
