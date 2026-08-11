/**
 * Pause menu (§V21: Esc opens/closes; sim halt is wired by the caller via
 * onPause/onResume — render keeps running underneath, so the backdrop is a
 * translucent sea-dark vignette, not a solid). The panel is a deckle-edged
 * chart: engraved small-caps title, ruled action entries, wax seal accent.
 */
import { uiParams } from '../params/ui';
import type { SettingsStore } from './settingsStore';
import { createSettingsScreen } from './settingsScreen';
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
  dispose(): void;
}

export function createPauseMenu(root: HTMLElement, opts: PauseMenuOptions): PauseMenu {
  let open = false;

  // — backdrop (click anywhere outside the panel resumes) —
  const backdrop = div('smt-backdrop');
  backdrop.setAttribute('aria-hidden', 'true');

  // — panel: menu view —
  const resumeBtn = button('smt-menu-btn', 'Resume');
  const settingsBtn = button('smt-menu-btn', 'Settings');
  const restartBtn = button('smt-menu-btn', 'Restart Voyage');
  restartBtn.disabled = true;
  restartBtn.appendChild(el('span', 'smt-menu-tag', 'soon'));

  const menuView = div(
    'smt-menu-view',
    el('p', 'smt-eyebrow', 'voyage held'),
    el('h1', 'smt-title', 'Becalmed'),
    fleuronDivider(),
    div('smt-menu', resumeBtn, settingsBtn, restartBtn),
  );

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
    if (next === 'menu') resumeBtn.focus();
    else settingsView.focusFirst();
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
    dispose(): void {
      window.removeEventListener('keydown', onKeyDown);
      settingsView.dispose();
      backdrop.remove();
      wrap.remove();
    },
  };
}
