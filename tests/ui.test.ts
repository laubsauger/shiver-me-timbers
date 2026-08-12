/**
 * Settings store tests (§V21: settings survive reload; corrupt persistence
 * must never crash the game — a broken save on a showcase machine would
 * take down the whole demo, so load is required to fall back to defaults
 * silently, and every persisted value is clamped so a hand-edited or stale
 * save can't push the renderer outside its supported range).
 * Store only — node env, no DOM.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  QUALITY_BUNDLES,
  QUALITY_PRESETS,
  createSettingsStore,
  presetIntact,
  sanitizeSettings,
} from '../src/ui/settingsStore';
import type { Quality, QualityHints, StorageLike } from '../src/ui/settingsStore';
import {
  GRAPHICS_FEATURES,
  GRAPHICS_FEATURE_IDS,
  applyGraphicsSettings,
  featureNeedsReload,
  featureWired,
  resetGraphicsBridge,
  setFeatureSink,
  shadowMapSizeNeedsReload,
  unwiredFeatures,
} from '../src/ui/graphicsFeatures';
import { pointOfSail } from '../src/ui/windDial';
import { clearParamsRegistry, getParamsEntry, registerParams } from '../src/params/registry';

function fakeStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

const KEY = 'smt.settings.v1';

describe('persistence roundtrip (settings must survive reload — §V21)', () => {
  it('a second store over the same storage sees what the first one saved', () => {
    const storage = fakeStorage();
    const a = createSettingsStore(storage);
    a.set({ graphics: { resolutionScale: 0.75, quality: 'low' }, audio: { master: 0.25 } });

    const b = createSettingsStore(storage);
    expect(b.get()).toEqual(a.get());
    expect(b.get().graphics.resolutionScale).toBe(0.75);
    expect(b.get().graphics.quality).toBe('low');
    expect(b.get().audio.master).toBe(0.25);
  });

  it('works without any storage at all (non-browser / privacy mode)', () => {
    const store = createSettingsStore(undefined);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(() => store.set({ audio: { sfx: 0.5 } })).not.toThrow();
    expect(store.get().audio.sfx).toBe(0.5);
  });
});

describe('corrupt persisted data (broken save must not take the game down)', () => {
  it('unparseable JSON falls back to defaults without throwing', () => {
    const storage = fakeStorage({ [KEY]: '{not json at all' });
    let store!: ReturnType<typeof createSettingsStore>;
    expect(() => {
      store = createSettingsStore(storage);
    }).not.toThrow();
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('a throwing storage backend still yields a working store', () => {
    const storage: StorageLike = {
      getItem: () => {
        throw new Error('quota / security error');
      },
      setItem: () => {
        throw new Error('quota / security error');
      },
    };
    const store = createSettingsStore(storage);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(() => store.set({ audio: { master: 0.1 } })).not.toThrow();
  });

  it('wrong-shaped JSON (arrays, strings, partials) sanitizes to valid settings', () => {
    for (const raw of ['[]', '"hi"', '42', '{"graphics":"nope"}', '{"audio":{"master":"loud"}}']) {
      const store = createSettingsStore(fakeStorage({ [KEY]: raw }));
      expect(store.get()).toEqual(DEFAULT_SETTINGS);
    }
  });
});

describe('clamping (out-of-range values could break the renderer/mixer)', () => {
  it('clamps persisted out-of-range values on load', () => {
    const bad = {
      graphics: { resolutionScale: 4, quality: 'ultra' },
      audio: { master: -2, sfx: 99, ambience: NaN },
    };
    const storage = fakeStorage({ [KEY]: JSON.stringify(bad) });
    const s = createSettingsStore(storage).get();
    expect(s.graphics.resolutionScale).toBe(1); // 0.5..1 — never upscale past native
    expect(s.graphics.quality).toBe(DEFAULT_SETTINGS.graphics.quality); // unknown tier rejected
    expect(s.audio.master).toBe(0);
    expect(s.audio.sfx).toBe(1);
    expect(s.audio.ambience).toBe(DEFAULT_SETTINGS.audio.ambience); // NaN is not a volume
  });

  it('clamps on set too — the UI is not the only writer', () => {
    const store = createSettingsStore(fakeStorage());
    store.set({ graphics: { resolutionScale: 0.1 }, audio: { ambience: 7 } });
    expect(store.get().graphics.resolutionScale).toBe(0.5);
    expect(store.get().audio.ambience).toBe(1);
  });

  it('sanitizeSettings never emits values outside the contract', () => {
    const s = sanitizeSettings({ graphics: { resolutionScale: -Infinity } });
    expect(s.graphics.resolutionScale).toBeGreaterThanOrEqual(0.5);
    expect(s.graphics.resolutionScale).toBeLessThanOrEqual(1);
  });
});

describe('quality preset table (engine consumers rely on every hint field)', () => {
  const qualities: Quality[] = ['low', 'medium', 'high'];
  const hintKeys: (keyof QualityHints)[] = [
    'oceanResolution',
    'cloudRtScale',
    'shadows',
    'foamBlurPasses',
    'maxAnisotropy',
  ];

  it('every quality tier defines every hint field (no undefined reaches the engine)', () => {
    for (const q of qualities) {
      const preset = QUALITY_PRESETS[q];
      expect(preset, `missing preset for ${q}`).toBeDefined();
      for (const key of hintKeys) {
        expect(preset[key], `${q}.${key} missing`).toBeDefined();
      }
      expect(Object.keys(preset).sort()).toEqual([...hintKeys].sort());
    }
  });

  it('ocean resolution never drops below the §V19 512 floor', () => {
    for (const q of qualities) {
      expect(QUALITY_PRESETS[q].oceanResolution).toBeGreaterThanOrEqual(512);
    }
  });

  it('hints() follows the selected quality', () => {
    const store = createSettingsStore(fakeStorage());
    store.set({ graphics: { quality: 'low' } });
    expect(store.hints()).toEqual(QUALITY_PRESETS.low);
  });
});

describe('subscribe (engine systems react live to settings changes)', () => {
  it('fires on set with the new sanitized state', () => {
    const store = createSettingsStore(fakeStorage());
    const seen: number[] = [];
    store.subscribe((s) => seen.push(s.graphics.resolutionScale));
    store.set({ graphics: { resolutionScale: 0.6 } });
    store.set({ graphics: { resolutionScale: 42 } }); // clamped BEFORE notify
    expect(seen).toEqual([0.6, 1]);
  });

  it('unsubscribe stops notifications', () => {
    const store = createSettingsStore(fakeStorage());
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store.set({ audio: { master: 0.2 } });
    off();
    store.set({ audio: { master: 0.3 } });
    expect(calls).toBe(1);
  });
});

/**
 * Per-feature graphics switches (§I ui/settings/graphics). The user could not
 * turn off the effect that was corrupting their ship, because the only switch
 * was in the debug panel. These tests pin the path that fixes that: a switch
 * in the menu ends up on the params key the system actually reads, presets are
 * bundles of those same switches, and a switch with nothing behind it is
 * REPORTED rather than silently doing nothing (six silent no-ops in §B).
 */
function registerFakeSystems(): void {
  clearParamsRegistry();
  resetGraphicsBridge();
  registerParams('reflection', { live: 0 });
  registerParams('caustics', { enabled: true });
  registerParams('deckwater', { enabled: true });
  registerParams('spray', { enabled: true });
  registerParams('sky', { shadowsEnabled: true, shadowMapSize: 2048 });
  registerParams('island', { castShadows: true, lodPalmFull: 500, lodPalmCull: 1400 });
  registerParams('post', {
    enabled: false, aoEnabled: true, bloomEnabled: true,
    vibranceEnabled: true, vignetteEnabled: true,
  });
  // NOTE: no 'rain' entry — T37 has not landed, which is the unwired case
}

describe('graphics switches reach the params key the system reads', () => {
  beforeEach(registerFakeSystems);
  afterEach(() => {
    clearParamsRegistry();
    resetGraphicsBridge();
  });

  it('turns every wired feature off, then back on, through the registry', () => {
    const off = {} as Record<string, boolean>;
    for (const id of GRAPHICS_FEATURE_IDS) off[id] = false;
    applyGraphicsSettings({ features: off as never, shadowMapSize: 2048, foliageDensity: 1 });

    for (const f of GRAPHICS_FEATURES) {
      const entry = getParamsEntry(f.system);
      if (!entry || !(f.key in entry.params)) continue;
      expect(entry.params[f.key], `${f.system}.${f.key} not switched off`).toBe(f.off);
    }

    const on = {} as Record<string, boolean>;
    for (const id of GRAPHICS_FEATURE_IDS) on[id] = true;
    applyGraphicsSettings({ features: on as never, shadowMapSize: 2048, foliageDensity: 1 });
    expect(getParamsEntry('reflection')?.params.live).toBe(1); // numeric, not boolean
    expect(getParamsEntry('caustics')?.params.enabled).toBe(true);
    expect(getParamsEntry('post')?.params.enabled).toBe(true);
  });

  it('reports a switch with no params key instead of silently dropping it', () => {
    expect(unwiredFeatures()).toContain('rain'); // no rain params module registered
    expect(featureWired('caustics')).toBe(true);
  });

  it('a sink registered by main.ts makes an unbacked switch live', () => {
    const seen: boolean[] = [];
    const off = setFeatureSink('rain', (on) => seen.push(on));
    expect(featureWired('rain')).toBe(true);
    expect(unwiredFeatures()).not.toContain('rain');

    const state = {} as Record<string, boolean>;
    for (const id of GRAPHICS_FEATURE_IDS) state[id] = false;
    applyGraphicsSettings({ features: state as never, shadowMapSize: 2048, foliageDensity: 1 });
    expect(seen).toEqual([false]);
    off();
    expect(featureWired('rain')).toBe(false);
  });

  it('foliage density scales the AUTHORED lod distances, never the last written ones', () => {
    const base = { ...getParamsEntry('island')!.params };
    const feats = {} as Record<string, boolean>;
    for (const id of GRAPHICS_FEATURE_IDS) feats[id] = true;
    const apply = (d: number) =>
      applyGraphicsSettings({ features: feats as never, shadowMapSize: 2048, foliageDensity: d });

    apply(0.5);
    apply(0.5);
    apply(0.5); // dragging a slider re-applies constantly — must not compound
    expect(getParamsEntry('island')!.params.lodPalmCull).toBe((base.lodPalmCull as number) * 0.5);
    apply(1);
    expect(getParamsEntry('island')!.params.lodPalmCull).toBe(base.lodPalmCull);
    apply(0);
    // 0 must be an actual off switch: palmLodCount culls everything past 0 m
    expect(getParamsEntry('island')!.params.lodPalmCull).toBe(0);
  });

  it('flags construction-gated changes as needing a restart, and only those', () => {
    const feats = {} as Record<string, boolean>;
    for (const id of GRAPHICS_FEATURE_IDS) feats[id] = true;
    applyGraphicsSettings({ features: feats as never, shadowMapSize: 2048, foliageDensity: 1 });

    // caustics.enabled is read when the TSL graph is baked → restart
    expect(featureNeedsReload('caustics', true)).toBe(false); // matches boot
    expect(featureNeedsReload('caustics', false)).toBe(true);
    // reflection.live is a live pass gate → never asks for a restart
    expect(featureNeedsReload('reflections', false)).toBe(false);
    expect(shadowMapSizeNeedsReload(2048)).toBe(false);
    expect(shadowMapSizeNeedsReload(4096)).toBe(true);
  });

  it('writes the shadow map size the engine allocates from', () => {
    const feats = {} as Record<string, boolean>;
    for (const id of GRAPHICS_FEATURE_IDS) feats[id] = true;
    applyGraphicsSettings({ features: feats as never, shadowMapSize: 4096, foliageDensity: 1 });
    expect(getParamsEntry('sky')!.params.shadowMapSize).toBe(4096);
  });
});

describe('quality presets are bundles of the switches, not a parallel mechanism', () => {
  it('applyQuality writes every switch the bundle names', () => {
    const store = createSettingsStore(fakeStorage());
    store.applyQuality('high');
    const g = store.get().graphics;
    expect(g.quality).toBe('high');
    expect(g.features).toEqual(QUALITY_BUNDLES.high.features);
    expect(g.shadowMapSize).toBe(QUALITY_BUNDLES.high.shadowMapSize);
    expect(store.isPresetIntact()).toBe(true);
  });

  it('touching one switch leaves the preset without renaming it', () => {
    const store = createSettingsStore(fakeStorage());
    store.applyQuality('high');
    store.set({ graphics: { features: { reflections: false } } });
    expect(store.get().graphics.quality).toBe('high'); // still says where it came from
    expect(store.isPresetIntact()).toBe(false); // …but the UI must read Custom
    expect(store.get().graphics.features.caustics).toBe(true); // others untouched
  });

  it('re-picking the preset restores every switch it names', () => {
    const store = createSettingsStore(fakeStorage());
    store.applyQuality('high');
    store.set({ graphics: { features: { reflections: false, spray: false }, foliageDensity: 0 } });
    store.applyQuality('high');
    expect(presetIntact(store.get().graphics)).toBe(true);
  });

  it('the shipped default is the tier whose bundle matches the engine defaults', () => {
    // a fresh install must render exactly what the engine renders today, or the
    // first thing the settings screen does is change the game (§V17 reflections
    // stay off until the player asks for them)
    expect(DEFAULT_SETTINGS.graphics.quality).toBe('medium');
    expect(DEFAULT_SETTINGS.graphics.features.reflections).toBe(false);
    expect(QUALITY_BUNDLES.high.features.reflections).toBe(true);
  });

  it('feature switches survive a reload', () => {
    const storage = fakeStorage();
    const a = createSettingsStore(storage);
    a.set({ graphics: { features: { deckWater: false, postFx: true } } });
    const b = createSettingsStore(storage);
    expect(b.get().graphics.features.deckWater).toBe(false);
    expect(b.get().graphics.features.postFx).toBe(true);
  });

  it('a save from before per-feature switches loads with the default bundle', () => {
    const legacy = JSON.stringify({ graphics: { resolutionScale: 0.8, quality: 'low' } });
    const s = createSettingsStore(fakeStorage({ [KEY]: legacy })).get();
    expect(s.graphics.features).toEqual(DEFAULT_SETTINGS.graphics.features);
    expect(s.graphics.resolutionScale).toBe(0.8);
  });

  it('snaps a hand-edited shadow map size to one the GPU can allocate', () => {
    expect(sanitizeSettings({ graphics: { shadowMapSize: 3500 } }).graphics.shadowMapSize).toBe(4096);
    expect(sanitizeSettings({ graphics: { shadowMapSize: 3000 } }).graphics.shadowMapSize).toBe(2048);
    expect(sanitizeSettings({ graphics: { shadowMapSize: 1 } }).graphics.shadowMapSize).toBe(1024);
    expect(sanitizeSettings({ graphics: { shadowMapSize: 'huge' } }).graphics.shadowMapSize)
      .toBe(DEFAULT_SETTINGS.graphics.shadowMapSize);
  });
});

describe('audio: four independent buses (§I master/music/sfx/ambience)', () => {
  it('music is its own control and persists on its own', () => {
    const storage = fakeStorage();
    const a = createSettingsStore(storage);
    a.set({ audio: { music: 0.2 } });
    expect(a.get().audio.sfx).toBe(DEFAULT_SETTINGS.audio.sfx); // untouched
    expect(createSettingsStore(storage).get().audio.music).toBe(0.2);
  });

  it('clamps music like every other volume', () => {
    expect(sanitizeSettings({ audio: { music: 9 } }).audio.music).toBe(1);
    expect(sanitizeSettings({ audio: { music: NaN } }).audio.music)
      .toBe(DEFAULT_SETTINGS.audio.music);
  });

  it('a save from before the music bus keeps the default rather than silence', () => {
    const legacy = JSON.stringify({ audio: { master: 0.5, sfx: 0.5, ambience: 0.5 } });
    const s = createSettingsStore(fakeStorage({ [KEY]: legacy })).get();
    expect(s.audio.music).toBe(DEFAULT_SETTINGS.audio.music);
  });
});

describe('wind readout names the point of sail the way a crew would', () => {
  const noGo = 42;
  it('inside the no-go wedge she is stalled head to wind', () => {
    expect(pointOfSail(0, noGo)).toBe('in irons');
    expect(pointOfSail((41 * Math.PI) / 180, noGo)).toBe('in irons');
  });

  it('reads the same to port and to starboard', () => {
    for (const deg of [50, 90, 130, 175]) {
      const r = (deg * Math.PI) / 180;
      expect(pointOfSail(r, noGo)).toBe(pointOfSail(-r, noGo));
    }
  });

  it('walks bow to stern through every point of sail', () => {
    expect(pointOfSail((60 * Math.PI) / 180, noGo)).toBe('close hauled');
    expect(pointOfSail((90 * Math.PI) / 180, noGo)).toBe('beam reach');
    expect(pointOfSail((130 * Math.PI) / 180, noGo)).toBe('broad reach');
    expect(pointOfSail(Math.PI, noGo)).toBe('running');
  });
});

describe('restart prompts must reflect what the engine actually built with', () => {
  beforeEach(registerFakeSystems);
  afterEach(() => {
    clearParamsRegistry();
    resetGraphicsBridge();
  });

  it('a switch restored from localStorage does not demand a restart every launch', () => {
    // boot path: settings are applied BEFORE any system is constructed, so the
    // state right after that first apply IS what got constructed. Comparing
    // against the authored param default instead would light "restart to
    // apply" on a setting the player made three sessions ago.
    const feats = {} as Record<string, boolean>;
    for (const id of GRAPHICS_FEATURE_IDS) feats[id] = true;
    feats.caustics = false; // what the save said
    applyGraphicsSettings({ features: feats as never, shadowMapSize: 1024, foliageDensity: 1 });

    expect(featureNeedsReload('caustics', false)).toBe(false); // this is the built state
    expect(featureNeedsReload('caustics', true)).toBe(true); // turning it back on is not
    expect(shadowMapSizeNeedsReload(1024)).toBe(false);
    expect(shadowMapSizeNeedsReload(2048)).toBe(true);
  });
});
