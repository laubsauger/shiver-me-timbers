/**
 * Game settings store (§V21: DOM overlay reads this store; settings survive
 * reload via localStorage). Plain TS, zero DOM imports — safe for tests and
 * for engine code that consumes quality hints. Values are clamped on load
 * AND on write; corrupt persisted JSON falls back to defaults without
 * throwing (a broken save must never take the game down).
 *
 * Quality presets are NAMED BUNDLES of the per-feature switches (§I), not a
 * parallel mechanism: picking "High" writes every switch, and touching any
 * switch afterwards simply leaves the bundle — `isPresetIntact()` reports it.
 */
import { skyParams } from '../params/sky';
import { GRAPHICS_FEATURE_IDS, SHADOW_MAP_SIZES } from './graphicsFeatures';
import type { GraphicsFeatureId } from './graphicsFeatures';

export type Quality = 'low' | 'medium' | 'high';

export type GraphicsFeatureState = Record<GraphicsFeatureId, boolean>;

export interface GraphicsSettings {
  /** render resolution multiplier, 0.5..1 of native canvas size */
  resolutionScale: number;
  /** the last preset applied — the switches below may since have drifted */
  quality: Quality;
  /** per-feature switches, applied to the params registry by graphicsFeatures */
  features: GraphicsFeatureState;
  /** sun shadow map texels per side; allocated at construction (reload) */
  shadowMapSize: number;
  /** palm LOD distance multiplier, 0..1; 0 = no palms */
  foliageDensity: number;
}

export interface AudioSettings {
  /** all volumes 0..1 */
  master: number;
  /** music bus (§I audio/music) — persisted now, silent until tracks land */
  music: number;
  sfx: number;
  ambience: number;
}

/**
 * World state the player can set directly (§I ui/settings).
 *
 * Time of day is NOT part of the graphics quality bundles: it is a creative
 * choice, not a performance one, and a quality preset must never silently
 * restage the scene. It lives here so it survives a reload — during alpha the
 * whole point is to come back to the same light you were last looking at.
 */
export interface WorldSettings {
  /** simulated hour 0..24; drives sun position and every light ramp */
  timeOfDay: number;
}

export interface GameSettings {
  graphics: GraphicsSettings;
  audio: AudioSettings;
  world: WorldSettings;
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

/** the graphics block a preset writes — everything except the preset name */
export type QualityBundle = Omit<GraphicsSettings, 'quality'>;

function features(on: GraphicsFeatureId[]): GraphicsFeatureState {
  const state = {} as GraphicsFeatureState;
  for (const id of GRAPHICS_FEATURE_IDS) state[id] = on.includes(id);
  return state;
}

/**
 * Post stages stay ON inside every bundle: they only cost anything when
 * `postFx` itself is on, and a player who switches the grade on expects to see
 * the grade rather than four more switches. `postFx` is off in all three
 * because the pipeline currently renders black (§T22 in flight) — a preset
 * must never be the thing that blanks the screen.
 *
 * MEDIUM is the shipped default. It is NOT automatically the same thing as the
 * engine's param defaults, and assuming it was cost real time: `reflections`
 * was absent here while `params/reflection.ts` said `live: 1`, and since this
 * bundle is applied over the params on every boot, the param file lost. A
 * feature switched on in `params/*` is OFF unless this list also names it.
 */
export const QUALITY_BUNDLES: Record<Quality, QualityBundle> = {
  low: {
    resolutionScale: 0.75,
    features: features(['postAo', 'postBloom', 'postVibrance', 'postVignette']),
    shadowMapSize: 1024,
    foliageDensity: 0.35,
  },
  medium: {
    resolutionScale: 1,
    features: features([
      // 'reflections' is IN medium on purpose. Measured with GPU timestamp
      // queries at the §T.39 sunset framing: +0.9 to +1.1 ms (367 → 556 draw
      // calls). It is what puts the ship INTO the water she floats on, and at
      // a grazing sunset the dark shape beside a hull is its reflection, not
      // its shadow — a shadow cannot darken reflected sky. Leaving it out made
      // `reflectionParams.live = 1` dead at the default quality, because this
      // bundle is written over the params on every boot.
      'reflections',
      'caustics', 'deckWater', 'spray', 'rain', 'shadows', 'islandShadows',
      'postAo', 'postBloom', 'postVibrance', 'postVignette',
    ]),
    shadowMapSize: 2048,
    foliageDensity: 0.75,
  },
  high: {
    resolutionScale: 1,
    features: features([
      'reflections', 'caustics', 'deckWater', 'spray', 'rain', 'shadows',
      'islandShadows', 'postAo', 'postBloom', 'postVibrance', 'postVignette',
    ]),
    shadowMapSize: 4096,
    foliageDensity: 1,
  },
};

export const DEFAULT_SETTINGS: GameSettings = {
  graphics: { quality: 'medium', ...QUALITY_BUNDLES.medium },
  audio: { master: 0.8, music: 0.7, sfx: 1, ambience: 0.7 },
  // seeded from the sky params so there is ONE default, not two that drift
  world: { timeOfDay: skyParams.timeOfDay },
};

const STORAGE_KEY = 'smt.settings.v1';
const QUALITIES: readonly Quality[] = ['low', 'medium', 'high'];

/** minimal persistence surface so tests can inject a fake */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SettingsPatch {
  graphics?: Partial<Omit<GraphicsSettings, 'features'>> & {
    features?: Partial<GraphicsFeatureState>;
  };
  audio?: Partial<AudioSettings>;
  world?: Partial<WorldSettings>;
}

export type SettingsListener = (settings: GameSettings) => void;

export interface SettingsStore {
  /** deep copy — mutate via set() only, so clamping always applies */
  get(): GameSettings;
  set(patch: SettingsPatch): void;
  /** write a whole named bundle: quality preset + every switch it implies */
  applyQuality(q: Quality): void;
  /** false once any switch has drifted from the named bundle */
  isPresetIntact(): boolean;
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

/** snap to the nearest supported shadow map size — the GPU allocates one of these */
function pickShadowMapSize(v: unknown, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  let best = SHADOW_MAP_SIZES[0];
  for (const s of SHADOW_MAP_SIZES) if (Math.abs(s - v) < Math.abs(best - v)) best = s;
  return best;
}

/** coerce arbitrary parsed data into a valid GameSettings (clamp + defaults) */
export function sanitizeSettings(raw: unknown): GameSettings {
  const r = asRecord(raw);
  const g = asRecord(r.graphics);
  const a = asRecord(r.audio);
  const w = asRecord(r.world);
  const d = DEFAULT_SETTINGS;
  const rawFeatures = asRecord(g.features);
  const featureState = {} as GraphicsFeatureState;
  for (const id of GRAPHICS_FEATURE_IDS) {
    const v = rawFeatures[id];
    featureState[id] = typeof v === 'boolean' ? v : d.graphics.features[id];
  }
  return {
    graphics: {
      resolutionScale: clampNum(g.resolutionScale, 0.5, 1, d.graphics.resolutionScale),
      quality: QUALITIES.includes(g.quality as Quality) ? (g.quality as Quality) : d.graphics.quality,
      features: featureState,
      shadowMapSize: pickShadowMapSize(g.shadowMapSize, d.graphics.shadowMapSize),
      foliageDensity: clampNum(g.foliageDensity, 0, 1, d.graphics.foliageDensity),
    },
    audio: {
      master: clampNum(a.master, 0, 1, d.audio.master),
      music: clampNum(a.music, 0, 1, d.audio.music),
      sfx: clampNum(a.sfx, 0, 1, d.audio.sfx),
      ambience: clampNum(a.ambience, 0, 1, d.audio.ambience),
    },
    // 24 is the same instant as 0; clamping to 24 would let a stored value sit
    // on an hour that wraps, so the top of the range is just under it
    world: { timeOfDay: clampNum(w.timeOfDay, 0, 23.99, d.world.timeOfDay) },
  };
}

function clone(s: GameSettings): GameSettings {
  return {
    graphics: { ...s.graphics, features: { ...s.graphics.features } },
    audio: { ...s.audio },
    world: { ...s.world },
  };
}

/** does this graphics block still match the bundle its preset name promises */
export function presetIntact(g: GraphicsSettings): boolean {
  const bundle = QUALITY_BUNDLES[g.quality];
  if (!bundle) return false;
  if (g.resolutionScale !== bundle.resolutionScale) return false;
  if (g.shadowMapSize !== bundle.shadowMapSize) return false;
  if (g.foliageDensity !== bundle.foliageDensity) return false;
  return GRAPHICS_FEATURE_IDS.every((id) => g.features[id] === bundle.features[id]);
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

  function commit(next: unknown): void {
    state = sanitizeSettings(next);
    persist();
    for (const cb of listeners) cb(clone(state));
  }

  return {
    get: () => clone(state),
    set(patch: SettingsPatch): void {
      commit({
        graphics: {
          ...state.graphics,
          ...patch.graphics,
          features: { ...state.graphics.features, ...patch.graphics?.features },
        },
        audio: { ...state.audio, ...patch.audio },
        world: { ...state.world, ...patch.world },
      });
    },
    applyQuality(q: Quality): void {
      const bundle = QUALITY_BUNDLES[q] ?? QUALITY_BUNDLES[DEFAULT_SETTINGS.graphics.quality];
      // `world` is carried through untouched: a quality preset is a performance
      // decision and must never restage the scene's lighting behind the player
      commit({ graphics: { quality: q, ...bundle }, audio: state.audio, world: state.world });
    },
    isPresetIntact: () => presetIntact(state.graphics),
    hints: () => ({ ...QUALITY_PRESETS[state.graphics.quality] }),
    subscribe(cb: SettingsListener): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
