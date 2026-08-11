/**
 * Game settings store (§V21: DOM overlay reads this store; settings survive
 * reload via localStorage). Plain TS, zero DOM imports — safe for tests and
 * for engine code that consumes quality hints. Values are clamped on load
 * AND on write; corrupt persisted JSON falls back to defaults without
 * throwing (a broken save must never take the game down).
 */

export type Quality = 'low' | 'medium' | 'high';

export interface GraphicsSettings {
  /** render resolution multiplier, 0.5..1 of native canvas size */
  resolutionScale: number;
  quality: Quality;
}

export interface AudioSettings {
  /** all volumes 0..1 */
  master: number;
  sfx: number;
  ambience: number;
}

export interface GameSettings {
  graphics: GraphicsSettings;
  audio: AudioSettings;
}

/**
 * Engine hints per quality tier — consumers (ocean, clouds, renderer) wire
 * these later; the table lives here so a preset is one lookup, not logic.
 * oceanResolution never drops below 512 (§V19 floor).
 */
export interface QualityHints {
  /** FFT cascade texture size per side */
  oceanResolution: number;
  /** cloud RT scale relative to canvas */
  cloudRtScale: number;
  shadows: boolean;
  /** progressive foam blur passes per frame */
  foamBlurPasses: number;
  /** texture max anisotropy */
  maxAnisotropy: number;
}

export const QUALITY_PRESETS: Record<Quality, QualityHints> = {
  low: { oceanResolution: 512, cloudRtScale: 0.25, shadows: false, foamBlurPasses: 1, maxAnisotropy: 2 },
  medium: { oceanResolution: 512, cloudRtScale: 0.5, shadows: true, foamBlurPasses: 2, maxAnisotropy: 4 },
  high: { oceanResolution: 1024, cloudRtScale: 0.5, shadows: true, foamBlurPasses: 3, maxAnisotropy: 8 },
};

export const DEFAULT_SETTINGS: GameSettings = {
  graphics: { resolutionScale: 1, quality: 'high' },
  audio: { master: 0.8, sfx: 1, ambience: 0.7 },
};

const STORAGE_KEY = 'smt.settings.v1';
const QUALITIES: readonly Quality[] = ['low', 'medium', 'high'];

/** minimal persistence surface so tests can inject a fake */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SettingsPatch {
  graphics?: Partial<GraphicsSettings>;
  audio?: Partial<AudioSettings>;
}

export type SettingsListener = (settings: GameSettings) => void;

export interface SettingsStore {
  /** deep copy — mutate via set() only, so clamping always applies */
  get(): GameSettings;
  set(patch: SettingsPatch): void;
  /** hints for the currently selected quality tier */
  hints(): QualityHints;
  subscribe(cb: SettingsListener): () => void;
}

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(max, Math.max(min, n));
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

/** coerce arbitrary parsed data into a valid GameSettings (clamp + defaults) */
export function sanitizeSettings(raw: unknown): GameSettings {
  const r = asRecord(raw);
  const g = asRecord(r.graphics);
  const a = asRecord(r.audio);
  const d = DEFAULT_SETTINGS;
  return {
    graphics: {
      resolutionScale: clampNum(g.resolutionScale, 0.5, 1, d.graphics.resolutionScale),
      quality: QUALITIES.includes(g.quality as Quality) ? (g.quality as Quality) : d.graphics.quality,
    },
    audio: {
      master: clampNum(a.master, 0, 1, d.audio.master),
      sfx: clampNum(a.sfx, 0, 1, d.audio.sfx),
      ambience: clampNum(a.ambience, 0, 1, d.audio.ambience),
    },
  };
}

function clone(s: GameSettings): GameSettings {
  return { graphics: { ...s.graphics }, audio: { ...s.audio } };
}

/** localStorage when in a browser; undefined elsewhere (memory-only store) */
function defaultStorage(): StorageLike | undefined {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    /* privacy modes can throw on access — treat as absent */
  }
  return undefined;
}

export function createSettingsStore(storage: StorageLike | undefined = defaultStorage()): SettingsStore {
  let state: GameSettings;
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    state = raw ? sanitizeSettings(JSON.parse(raw)) : clone(DEFAULT_SETTINGS);
  } catch {
    console.warn('[ui] settings load failed — using defaults');
    state = clone(DEFAULT_SETTINGS);
  }

  const listeners = new Set<SettingsListener>();

  function persist(): void {
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      console.warn('[ui] settings persist failed (storage unavailable/full)');
    }
  }

  return {
    get: () => clone(state),
    set(patch: SettingsPatch): void {
      state = sanitizeSettings({
        graphics: { ...state.graphics, ...patch.graphics },
        audio: { ...state.audio, ...patch.audio },
      });
      persist();
      for (const cb of listeners) cb(clone(state));
    },
    hints: () => ({ ...QUALITY_PRESETS[state.graphics.quality] }),
    subscribe(cb: SettingsListener): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
