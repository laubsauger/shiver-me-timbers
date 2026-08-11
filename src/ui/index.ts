/**
 * Game UI shell entry (§V21: DOM overlay over the live canvas, reads the
 * persisted settings store, Esc toggles pause — the caller halts the sim
 * tick in onPause and resumes it in onResume; render keeps running).
 */
import { createSettingsStore } from './settingsStore';
import type { SettingsStore } from './settingsStore';
import { createPauseMenu } from './pauseMenu';
import { createHud } from './hud';
import { ensureUiStyles } from './styles';
import { div } from './dom';

export type { GameSettings, QualityHints, Quality, SettingsStore } from './settingsStore';
export { QUALITY_PRESETS, DEFAULT_SETTINGS } from './settingsStore';

export interface GameUiCallbacks {
  /** sim tick halt/resume wiring is the caller's job (main thread, later task) */
  onPause: () => void;
  onResume: () => void;
}

export interface GameUi {
  setHeading(rad: number): void;
  setSpeed(knots: number): void;
  setDamage(zoneId: string, level: number): void;
  /** persisted settings — engine consumers subscribe for live changes */
  settings: SettingsStore;
  /** programmatic pause control (Esc is handled internally) */
  pause: () => void;
  resume: () => void;
  isPaused: () => boolean;
  dispose(): void;
}

export function createGameUI(callbacks: GameUiCallbacks): GameUi {
  ensureUiStyles();
  const settings = createSettingsStore();

  const root = div('smt-ui');
  document.body.appendChild(root);

  const hud = createHud(root);
  const menu = createPauseMenu(root, { ...callbacks, settings });

  return {
    setHeading: hud.setHeading,
    setSpeed: hud.setSpeed,
    setDamage: hud.setDamage,
    settings,
    pause: menu.open,
    resume: menu.close,
    isPaused: menu.isOpen,
    dispose(): void {
      menu.dispose();
      hud.dispose();
      root.remove();
    },
  };
}
