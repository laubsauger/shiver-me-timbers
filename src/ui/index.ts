/**
 * Game UI shell entry (§V21: DOM overlay over the live canvas, reads the
 * persisted settings store, Esc toggles pause — the caller halts the sim
 * tick in onPause and resumes it in onResume; render keeps running).
 *
 * WIRING ORDER MATTERS. Several graphics switches are read at CONSTRUCTION
 * (TSL bakes its graph once, the shadow map allocates once), so main.ts calls
 * initGraphicsSettings() FIRST — before any system is built — and hands the
 * returned store to createGameUI. Everything after that is live: the store
 * notifies, and the same settings go back into the params registry.
 */
import { createSettingsStore } from './settingsStore';
import type { GameSettings, SettingsStore } from './settingsStore';
import { applyGraphicsSettings } from './graphicsFeatures';
import { createPauseMenu } from './pauseMenu';
import { createHud } from './hud';
import type { WindReadout } from './hud';
import type { MusicStatus } from './settingsScreen';
import { createFullscreen } from './fullscreen';
import { createViewModes } from './viewModes';
import { ensureUiStyles } from './styles';
import { div } from './dom';
import { createQuickControls } from './quickControls';

export type { GameSettings, QualityHints, Quality, SettingsStore } from './settingsStore';
export {
  QUALITY_PRESETS, QUALITY_BUNDLES, DEFAULT_SETTINGS, applyWorldSettings,
} from './settingsStore';
export type { GraphicsFeatureId } from './graphicsFeatures';
export { GRAPHICS_FEATURES, setFeatureSink, unwiredFeatures } from './graphicsFeatures';
export type { WindReadout } from './hud';
export type { MusicStatus } from './settingsScreen';

export interface GameUiCallbacks {
  /** sim tick halt/resume wiring is the caller's job (main thread, later task) */
  onPause: () => void;
  onResume: () => void;
  /** the store from initGraphicsSettings(); one is created if omitted */
  settings?: SettingsStore;
}

export interface GameUi {
  setHeading(rad: number): void;
  setSpeed(knots: number): void;
  setWind(w: WindReadout): void;
  setTrim(trim: number): void;
  setDamage(zoneId: string, level: number): void;
  /** now-playing line in the audio settings — pass `() => audio.musicInfo()` */
  setMusicStatusSource(fn: () => MusicStatus): void;
  /** persisted settings — engine consumers subscribe for live changes */
  settings: SettingsStore;
  /** programmatic pause control (Esc is handled internally) */
  pause: () => void;
  resume: () => void;
  isPaused: () => boolean;
  /** §I ui/cinematic — photo mode hides every overlay, HUD included */
  isPhotoMode: () => boolean;
  isDevLayerVisible: () => boolean;
  /** short-lived getting-started card; call when the first game frame exists */
  showQuickControls(): void;
  dispose(): void;
}

/**
 * Load persisted settings and push the graphics block into the params registry
 * BEFORE any system is constructed, then keep pushing it on every change.
 * Returns the store to hand to createGameUI (and to anything else that needs
 * a live settings feed, e.g. the renderer's resolution scale).
 */
export function initGraphicsSettings(store: SettingsStore = createSettingsStore()): SettingsStore {
  applyGraphicsSettings(store.get().graphics);
  store.subscribe((s: GameSettings) => applyGraphicsSettings(s.graphics));
  return store;
}

export function createGameUI(callbacks: GameUiCallbacks): GameUi {
  ensureUiStyles();
  const settings = callbacks.settings ?? initGraphicsSettings();

  const root = div('smt-ui');
  document.body.appendChild(root);

  const hud = createHud(root);
  const quickControls = createQuickControls(root);
  // one fullscreen control, shared: the menu entry throws it, the view modes
  // listen to it (full screen = cinematic), and both read the same truth
  const fullscreen = createFullscreen();
  const viewModes = createViewModes(root, fullscreen);
  const menu = createPauseMenu(root, {
    onPause: callbacks.onPause,
    onResume: callbacks.onResume,
    settings,
    fullscreen,
    peelEscape: viewModes.peelEscape,
  });

  return {
    setHeading: hud.setHeading,
    setSpeed: hud.setSpeed,
    setWind: hud.setWind,
    setTrim: hud.setTrim,
    setDamage: hud.setDamage,
    setMusicStatusSource: menu.setMusicStatusSource,
    settings,
    pause: menu.open,
    resume: menu.close,
    isPaused: menu.isOpen,
    isPhotoMode: viewModes.isPhoto,
    isDevLayerVisible: viewModes.isDevVisible,
    showQuickControls: quickControls.show,
    dispose(): void {
      quickControls.dispose();
      menu.dispose();
      viewModes.dispose();
      fullscreen.dispose();
      hud.dispose();
      root.remove();
    },
  };
}
