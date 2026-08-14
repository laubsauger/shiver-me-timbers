/**
 * Short-lived getting-started card. The full binding reference lives in the
 * settings screen; this only teaches the three actions needed to start moving
 * and inhabit the ship. Keys come from the live control map.
 */
import { CONTROL_CODES } from '../input/controlMap';
import { div, el } from './dom';

export interface QuickControls {
  /** Show after the boot splash has actually left the DOM. Safe to call once. */
  show(): void;
  dispose(): void;
}

const DISPLAY_MS = 9000;
const INTERACTION_GRACE_MS = 1600;
const FADE_MS = 700;

const keyLabel = (code: string): string => code.startsWith('Key') ? code.slice(3) : code;

export function createQuickControls(root: HTMLElement): QuickControls {
  const rows = [
    {
      codes: [CONTROL_CODES.steerLeft, CONTROL_CODES.steerRight],
      action: 'Steer',
      hint: 'left / right',
    },
    {
      codes: [CONTROL_CODES.trimInPrimary, CONTROL_CODES.trimOutPrimary],
      action: 'Trim sails',
      hint: 'haul / ease',
    },
    {
      codes: [CONTROL_CODES.toggleHelm],
      action: 'Take the helm',
      hint: 'press again to return',
    },
  ];

  const card = div(
    'smt-quick-controls',
    el('p', 'smt-quick-eyebrow', 'getting underway'),
    el('h2', 'smt-quick-title', 'At the helm'),
    ...rows.map((row) =>
      div(
        'smt-quick-row',
        div(
          'smt-quick-keys',
          ...row.codes.map((code) => el('kbd', 'smt-key', keyLabel(code))),
        ),
        div(
          'smt-quick-copy',
          el('span', 'smt-quick-action', row.action),
          el('span', 'smt-quick-hint', row.hint),
        ),
      ),
    ),
    el('p', 'smt-quick-foot', 'All bindings in Esc  ·  Settings  ·  Controls'),
  );
  card.setAttribute('role', 'status');
  card.setAttribute('aria-label', 'Getting started controls');
  root.appendChild(card);

  const usefulCodes = new Set<string>(rows.flatMap((row) => row.codes));
  let shown = false;
  let disposed = false;
  let interacted = false;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let removeTimer: ReturnType<typeof setTimeout> | undefined;
  let splashObserver: MutationObserver | undefined;

  function remove(): void {
    card.remove();
  }

  function hide(): void {
    if (!card.classList.contains('is-visible')) return;
    window.removeEventListener('keydown', onKeyDown);
    card.classList.remove('is-visible');
    card.classList.add('is-leaving');
    removeTimer = setTimeout(remove, FADE_MS);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (!usefulCodes.has(event.code) || interacted) return;
    interacted = true;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, INTERACTION_GRACE_MS);
  }

  function reveal(): void {
    if (disposed || shown) return;
    shown = true;
    requestAnimationFrame(() => card.classList.add('is-visible'));
    hideTimer = setTimeout(hide, DISPLAY_MS);
    window.addEventListener('keydown', onKeyDown);
  }

  function show(): void {
    if (disposed || shown) return;
    if (!document.getElementById('boot-splash')) {
      reveal();
      return;
    }
    // The splash owns its own transition/removal timing. Observe the real DOM
    // removal so this card never spends its display lifetime hidden beneath it.
    splashObserver = new MutationObserver(() => {
      if (document.getElementById('boot-splash')) return;
      splashObserver?.disconnect();
      splashObserver = undefined;
      reveal();
    });
    splashObserver.observe(document.body, { childList: true });
  }

  return {
    show,
    dispose(): void {
      disposed = true;
      clearTimeout(hideTimer);
      clearTimeout(removeTimer);
      splashObserver?.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      card.remove();
    },
  };
}
