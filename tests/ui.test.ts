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
  STORAGE_KEY,
  SEA_RANGES,
  SEA_STATES,
  applyWorldSettings,
  seaStateFor,
  seaStatePatch,
  createSettingsStore,
  presetIntact,
  sanitizeSettings,
} from '../src/ui/settingsStore';
import type { Quality, QualityHints, StorageLike } from '../src/ui/settingsStore';
import { skyParams } from '../src/params/sky';
// the §V.62 wiring check below drives the REAL wind consumers, not fakes: the
// spectrum the sea is rebuilt from, and the rig that answers to it
import { oceanParams } from '../src/params/ocean';
import { spectrumSignature } from '../src/ocean/oceanCascades';
import { phillips } from '../src/ocean/oceanMath';
import { sailDrive } from '../src/ship/sailDynamics';
import { apparentWind } from '../src/ship/flagDynamics';
import { shipMaterialParams } from '../src/params/ship';
import {
  WIND_PRESETS,
  swellHeightLabel,
  swellPeriodLabel,
  windFromDeg,
  windSpeedLabel,
} from '../src/ui/settingsScreen';
import { beaufort } from '../src/ui/windDial';
import { stalledReason } from '../src/ui/hud';
import { cascadeBand, spectralHeightVariance } from '../src/ocean/oceanMath';
// the REAL param files, imported for the bundle-vs-params check below. The
// registry inside these tests holds deliberate fakes, which is precisely why
// three bundle/param divergences shipped unnoticed (§V.62).
import { reflectionParams } from '../src/params/reflection';
import { causticsParams } from '../src/params/caustics';
import { deckWaterParams } from '../src/params/deckwater';
import { islandParams } from '../src/params/island';
import { postParams } from '../src/params/post';
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
import {
  INITIAL_VIEW_STATE,
  devLayerFor,
  reduceView,
} from '../src/ui/viewModes';
import type { ViewAction, ViewState } from '../src/ui/viewModes';
import {
  applyDevLayer,
  devLayerAttached,
  devLayerVisible,
  resetDevLayer,
  setDevLayerSink,
} from '../src/ui/devLayer';
import { clearParamsRegistry, getParamsEntry, registerParams } from '../src/params/registry';
import {
  CONTROL_CODES,
  CONTROL_GROUPS,
  isFullscreenShortcut,
} from '../src/input/controlMap';

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

// imported, never re-typed: a STORAGE_KEY bump (which is how a bad persisted
// bundle is retired) used to break three unrelated tests with a wrong-looking
// clamping failure instead of saying "the key moved".
const KEY = STORAGE_KEY;

describe('controls reference uses the live binding map', () => {
  it('advertises the helm toggle and full-screen shortcut', () => {
    const bindings = CONTROL_GROUPS.flatMap((group) => group.bindings);
    expect(CONTROL_CODES.toggleHelm).toBe('KeyH');
    expect(bindings.find((binding) => binding.action === 'Helm view')?.keys).toEqual(['H']);
    expect(bindings.find((binding) => binding.action === 'Toggle full screen')?.keys)
      .toEqual(['Alt', 'Enter']);
  });

  it('claims only Alt+Enter, including the numpad Enter key', () => {
    const event = (code: string, overrides: Partial<KeyboardEvent> = {}) => ({
      code,
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      ...overrides,
    }) as KeyboardEvent;

    expect(isFullscreenShortcut(event('Enter'))).toBe(true);
    expect(isFullscreenShortcut(event('NumpadEnter'))).toBe(true);
    expect(isFullscreenShortcut(event('Enter', { altKey: false }))).toBe(false);
    expect(isFullscreenShortcut(event('Enter', { ctrlKey: true }))).toBe(false);
    expect(isFullscreenShortcut(event('KeyF'))).toBe(false);
  });
});

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

  it('the shipped default bundle agrees with the engine params it overwrites', () => {
    // THE BUNDLE WINS. applyGraphicsSettings() writes this over params/* on
    // every boot, so a feature switched on in params/reflection.ts but absent
    // from this list is simply OFF — silently, at the default quality, for
    // every player. That happened: `live: 1` sat in the param file doing
    // nothing because `medium` did not name 'reflections'.
    expect(DEFAULT_SETTINGS.graphics.quality).toBe('medium');

    // Reflections are ON at medium as of the measurement that overturned the
    // original "stay off until the player asks" decision: GPU timestamp
    // queries at the §T.39 sunset framing put the whole planar pass at
    // +0.9-1.1ms (367 -> 556 draw calls). That decision predated any
    // measurement, and the feature is what puts the ship into the water she
    // floats on — at a grazing sunset the dark shape beside a hull IS its
    // reflection, since a shadow cannot darken reflected sky.
    expect(DEFAULT_SETTINGS.graphics.features.reflections).toBe(true);
    expect(QUALITY_BUNDLES.high.features.reflections).toBe(true);
    // low stays off: it is the tier that exists to buy frames back, and
    // `enabled: 0` (construction gate) is the genuinely free setting there
    expect(QUALITY_BUNDLES.low.features.reflections).toBe(false);
  });

  it('EVERY switch the shipped default writes agrees with the params file it overwrites', () => {
    // §V.62, and it has now bitten in BOTH directions. This bundle is written
    // over params/* on every boot, so at the default quality the bundle IS the
    // truth and the param file is decoration:
    //   - `reflections` absent here while reflection.ts said `live: 1`
    //     => reflections dead at the default quality for every player;
    //   - `postFx` absent here while post.ts said `enabled: true`
    //     => bloom, god rays, vignette, vibrance and dither NEVER RAN, at all,
    //     for anybody, and the store then persisted the false so fixing the
    //     bundle alone could not have reached a player who had booted once;
    //   - `postAo` NAMED here while post.ts says `aoEnabled: false`
    //     => the scene pass was silently built with `samples: 0`, i.e. the
    //     whole frame gave up MSAA — the exact trade post.ts documents as not
    //     worth taking by default.
    // The previous version of this test hand-checked ONE feature, which is how
    // the other two survived it. Check the whole table instead.
    const real: Record<string, Record<string, unknown> | undefined> = {
      reflection: reflectionParams as unknown as Record<string, unknown>,
      caustics: causticsParams as unknown as Record<string, unknown>,
      deckwater: deckWaterParams as unknown as Record<string, unknown>,
      island: islandParams as unknown as Record<string, unknown>,
      post: postParams as unknown as Record<string, unknown>,
    };
    const bundle = QUALITY_BUNDLES[DEFAULT_SETTINGS.graphics.quality];
    const checked: string[] = [];
    for (const f of GRAPHICS_FEATURES) {
      const params = real[f.system];
      // spray/rain/sky expose no such key — reported by unwiredFeatures(), not here
      if (!params || !(f.key in params)) continue;
      checked.push(f.id);
      const bundled = bundle.features[f.id] ? f.on : f.off;
      expect(
        bundled,
        `${f.system}.${f.key}: default bundle writes ${String(bundled)}, ` +
          `params file authors ${String(params[f.key])} — one of the two is a lie`,
      ).toBe(params[f.key]);
    }
    // guard the guard: a renamed system key would silently empty the loop
    expect(checked).toEqual(
      expect.arrayContaining(['reflections', 'postFx', 'postAo', 'postBloom']),
    );
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

/**
 * View modes (§I ui/cinematic). The user wants to hit full screen and record
 * immediately, so full screen must arrive clean; and when the whole interface
 * vanishes, exactly one press must bring back exactly one layer. The ladder is
 * pinned here rather than left to fall out of DOM handler ordering.
 */
function run(actions: ViewAction[], from: ViewState = INITIAL_VIEW_STATE): ViewState {
  return actions.reduce((s, a) => reduceView(s, a).state, from);
}

describe('cinematic: full screen arrives clean, and gives the dev layer back', () => {
  it('hides the dev layer on entry and restores it exactly on exit', () => {
    const inFullscreen = run([{ type: 'enterFullscreen' }]);
    expect(devLayerFor(inFullscreen)).toBe(false); // nothing over the frame

    const after = run([{ type: 'exitFullscreen' }], inFullscreen);
    expect(devLayerFor(after)).toBe(true); // the desk comes back as it was
    expect(after.devBeforeFullscreen).toBeNull();
  });

  it('restores HIDDEN too — full screen must not switch the panel on for you', () => {
    const hidden = run([{ type: 'toggleDev' }]); // player had it off already
    expect(devLayerFor(hidden)).toBe(false);
    const round = run([{ type: 'enterFullscreen' }, { type: 'exitFullscreen' }], hidden);
    expect(devLayerFor(round)).toBe(false);
  });

  it('F1 inside full screen is a look, not a new preference for the window', () => {
    const peeking = run([{ type: 'enterFullscreen' }, { type: 'toggleDev' }]);
    expect(devLayerFor(peeking)).toBe(true); // visible while recording
    const back = run([{ type: 'exitFullscreen' }], peeking);
    expect(devLayerFor(back)).toBe(true); // windowed state was ON, so ON
    expect(back.devBeforeFullscreen).toBeNull();
  });

  it('a repeated enter does not overwrite the parked windowed state', () => {
    const s = run([{ type: 'enterFullscreen' }, { type: 'enterFullscreen' }]);
    expect(s.devBeforeFullscreen).toBe(true);
  });

  it('an exit with nothing parked changes nothing', () => {
    expect(run([{ type: 'exitFullscreen' }])).toEqual(INITIAL_VIEW_STATE);
  });
});

describe('photo mode hides everything, and says how to get back', () => {
  it('outranks the F1 intent — no HUD and no dev tools', () => {
    const s = run([{ type: 'togglePhoto' }]);
    expect(s.dev).toBe(true); // the standing intent survives
    expect(devLayerFor(s)).toBe(false); // …but nothing is drawn
    expect(s.photo).toBe(true);
  });

  it('leaving photo mode restores the dev layer the player had', () => {
    const off = run([{ type: 'toggleDev' }, { type: 'togglePhoto' }, { type: 'togglePhoto' }]);
    expect(devLayerFor(off)).toBe(false); // was off before photo mode
    const on = run([{ type: 'togglePhoto' }, { type: 'togglePhoto' }]);
    expect(devLayerFor(on)).toBe(true);
  });

  it('F1 in photo mode ends photo mode — otherwise it reads as a dead key', () => {
    const s = run([{ type: 'togglePhoto' }, { type: 'toggleDev' }]);
    expect(s.photo).toBe(false);
    expect(devLayerFor(s)).toBe(true);
  });

  it('captions the moment the interface disappears, and only then', () => {
    expect(reduceView(INITIAL_VIEW_STATE, { type: 'togglePhoto' }).caption)
      .toMatch(/Esc/); // must name the way out
    const inPhoto = run([{ type: 'togglePhoto' }]);
    expect(reduceView(inPhoto, { type: 'togglePhoto' }).caption).toBeUndefined();
    expect(reduceView(INITIAL_VIEW_STATE, { type: 'enterFullscreen' }).caption)
      .toMatch(/F1/);
  });
});

describe('Escape peels one layer per press', () => {
  it('spends the key on photo mode and does not also reach the pause menu', () => {
    const inPhoto = run([{ type: 'togglePhoto' }]);
    const t = reduceView(inPhoto, { type: 'escape' });
    expect(t.consumedEscape).toBe(true);
    expect(t.state.photo).toBe(false);
  });

  it('passes the key through when there is no mode to peel', () => {
    const t = reduceView(INITIAL_VIEW_STATE, { type: 'escape' });
    expect(t.consumedEscape).toBe(false); // the pause menu gets it
    expect(t.state).toEqual(INITIAL_VIEW_STATE);
  });

  it('a second press is needed for the next layer down', () => {
    const inPhoto = run([{ type: 'togglePhoto' }]);
    const first = reduceView(inPhoto, { type: 'escape' });
    expect(first.consumedEscape).toBe(true);
    expect(reduceView(first.state, { type: 'escape' }).consumedEscape).toBe(false);
  });
});

describe('dev-layer channel (debug shell and UI never import each other)', () => {
  afterEach(resetDevLayer);

  it('a sink attached after the state changed catches up immediately', () => {
    applyDevLayer(false); // cinematic engaged before the panel existed
    const seen: boolean[] = [];
    setDevLayerSink((v) => seen.push(v));
    expect(seen).toEqual([false]);
  });

  it('detaching stops delivery and reports nothing is listening', () => {
    const seen: boolean[] = [];
    const detach = setDevLayerSink((v) => seen.push(v));
    expect(devLayerAttached()).toBe(true);
    applyDevLayer(false);
    detach();
    applyDevLayer(true);
    expect(seen).toEqual([true, false]); // initial catch-up, then the change
    expect(devLayerAttached()).toBe(false);
    expect(devLayerVisible()).toBe(true); // state still tracked for the next sink
  });
});

/**
 * TIME OF DAY IN SETTINGS (user request, alpha workflow).
 *
 * "I would really like if time of day would be easily accessible in the pause
 * menu or in settings at least, so that we could make it fixed or whatever and
 * then quickly set it to whatever we want. Especially in alpha dev it's very
 * important."
 *
 * Two properties carry that request, and both are easy to break later:
 * it must SURVIVE A RELOAD (otherwise you re-dial the light every session),
 * and a graphics quality preset must NEVER move it — quality is a performance
 * decision, and silently restaging the scene's lighting behind the user is the
 * bug that makes a settings screen untrustworthy.
 */
describe('time of day is a first-class setting', () => {
  it('persists across a reload, so you return to the light you left', () => {
    const mem = fakeStorage();
    const a = createSettingsStore(mem);
    a.set({ world: { timeOfDay: 17.7 } });
    // a fresh store over the SAME storage is what a page reload actually is
    const b = createSettingsStore(mem);
    expect(b.get().world.timeOfDay).toBeCloseTo(17.7, 6);
  });

  it('is NOT touched by a quality preset — quality is performance, not staging', () => {
    const store = createSettingsStore(fakeStorage());
    store.set({ world: { timeOfDay: 17.7 } });
    for (const q of ['low', 'medium', 'high'] as const) {
      store.applyQuality(q);
      expect(store.get().world.timeOfDay).toBeCloseTo(17.7, 6);
    }
  });

  it('survives corrupt or absent persisted data instead of taking the game down', () => {
    expect(sanitizeSettings(undefined).world.timeOfDay)
      .toBe(DEFAULT_SETTINGS.world.timeOfDay);
    expect(sanitizeSettings({ world: { timeOfDay: 'sunset' } }).world.timeOfDay)
      .toBe(DEFAULT_SETTINGS.world.timeOfDay);
    expect(sanitizeSettings({ world: { timeOfDay: NaN } }).world.timeOfDay)
      .toBe(DEFAULT_SETTINGS.world.timeOfDay);
  });

  it('clamps to a real hour, and never onto the wrapping 24 boundary', () => {
    expect(sanitizeSettings({ world: { timeOfDay: -5 } }).world.timeOfDay).toBe(0);
    // 24 IS 0. Allowing it stores an hour that means midnight while reading as
    // midnight-tomorrow, which is a needless ambiguity in a persisted value.
    expect(sanitizeSettings({ world: { timeOfDay: 99 } }).world.timeOfDay).toBeLessThan(24);
    expect(sanitizeSettings({ world: { timeOfDay: 24 } }).world.timeOfDay).toBeLessThan(24);
  });

  it('defaults to the sky params value, so there are not two drifting defaults', () => {
    expect(DEFAULT_SETTINGS.world.timeOfDay).toBe(skyParams.timeOfDay);
  });
});

/**
 * WIND IS A CONTROL, NOT A DECORATION (§V.62).
 *
 * User: "add a control for us then to change the wind direction — that's
 * important. Same goes for time of day... this should go somewhere close to
 * weather and all of this kind of stuff."
 *
 * `oceanParams.windDirection` had NO runtime writer at all before this — the
 * weather presets patch `windSpeed` only, and the sole writers were the debug
 * panel and a `?wind=` boot query on a dev entry point. A settings row that
 * wrote nothing but the store would therefore have been the thirteenth silent
 * no-op in §B, and it would have LOOKED right: the row moves, the label reads
 * back, nothing on screen changes.
 *
 * So these tests do not check that a number was stored. They check that the
 * number reaches the two things the player can actually see move — the SEA
 * (the FFT spectrum is rebuilt from these keys) and the SAILS (the cloth and
 * the drive are computed from them) — against the REAL param objects the
 * engine reads, not a fake.
 */
/** a full world block, so a test can name only the keys it is about */
function world(patch: Partial<typeof DEFAULT_SETTINGS.world> = {}) {
  return { ...DEFAULT_SETTINGS.world, ...patch };
}

describe('the wind control reaches the sea and the sails', () => {
  const shippedWind = { dir: oceanParams.windDirection, speed: oceanParams.windSpeed };
  const shippedHour = skyParams.timeOfDay;
  const shippedSea = {
    amplitude: oceanParams.amplitude,
    swellAmplitude: oceanParams.swellAmplitude,
    swellPeriod: oceanParams.swellPeriod,
    swellDirection: oceanParams.swellDirection,
  };
  afterEach(() => {
    Object.assign(oceanParams, shippedSea);
    // these tests write the SHIPPED singletons on purpose — a fake would prove
    // exactly nothing about whether the control is wired
    oceanParams.windDirection = shippedWind.dir;
    oceanParams.windSpeed = shippedWind.speed;
    skyParams.timeOfDay = shippedHour;
  });

  it('defaults to the ocean params, so there are not two drifting defaults', () => {
    expect(DEFAULT_SETTINGS.world.windDirection).toBe(oceanParams.windDirection);
    expect(DEFAULT_SETTINGS.world.windSpeed).toBe(oceanParams.windSpeed);
  });

  it('lands on oceanParams — the ONE wind source every system reads', () => {
    applyWorldSettings(world({ timeOfDay: 9, windDirection: 2.5, windSpeed: 7 }));
    expect(oceanParams.windDirection).toBe(2.5);
    expect(oceanParams.windSpeed).toBe(7);
    expect(skyParams.timeOfDay).toBe(9); // the same bridge still carries the hour
  });

  it('MOVES THE SEA: both keys are in the spectrum signature, so the sea is refitted', () => {
    // this is the actual mechanism — OceanSimulation.update compares this
    // string and rebuilds all three cascades when it changes. If a future
    // refactor drops either key from the signature the control goes dead
    // silently, with the row still moving.
    applyWorldSettings(world({ timeOfDay: 9, windDirection: 0.5, windSpeed: 9 }));
    const before = spectrumSignature(oceanParams);
    applyWorldSettings(world({ timeOfDay: 9, windDirection: 2.0, windSpeed: 9 }));
    expect(spectrumSignature(oceanParams)).not.toBe(before);
    applyWorldSettings(world({ timeOfDay: 9, windDirection: 2.0, windSpeed: 18 }));
    expect(spectrumSignature(oceanParams)).not.toBe(before);
  });

  it('MOVES THE SEA: turning the wind turns the wave energy with it', () => {
    // the signature proves a rebuild happens; this proves the rebuild lands on
    // a DIFFERENT sea rather than an identical one. Phillips is the function
    // that turns wind into wave energy, so a mode across the new wind must
    // gain what a mode across the old one loses.
    const kx = 0.05;
    const kz = 0.0;
    applyWorldSettings(world({ timeOfDay: 9, windDirection: 0, windSpeed: 11 }));
    const along = phillips(kx, kz, oceanParams);
    applyWorldSettings(world({ timeOfDay: 9, windDirection: Math.PI / 2, windSpeed: 11 }));
    const across = phillips(kx, kz, oceanParams);
    expect(along).toBeGreaterThan(across * 2);
  });

  it('MOVES THE SAILS: the same write changes how the cloth is loaded', () => {
    // a ship on a fixed heading, wind turned from dead astern to dead ahead.
    // `sailDrive` reads windDirection/windSpeed straight off its input, and
    // main.ts feeds it `state.wind`, which is copied from oceanParams every
    // tick — so this is the value the control writes, one hop later.
    const ship = { forwardX: 0, forwardZ: 1, shipVelX: 0, shipVelZ: 0, yawRate: 0 };
    applyWorldSettings(world({ timeOfDay: 9, windDirection: 0, windSpeed: 11 }));
    const running = sailDrive(
      { ...ship, windDirection: oceanParams.windDirection, windSpeed: oceanParams.windSpeed },
      shipMaterialParams,
    );
    applyWorldSettings(world({ timeOfDay: 9, windDirection: Math.PI, windSpeed: 11 }));
    const irons = sailDrive(
      { ...ship, windDirection: oceanParams.windDirection, windSpeed: oceanParams.windSpeed },
      shipMaterialParams,
    );
    // dead astern draws, head to wind does not — if the two came back equal the
    // write never reached the rig
    expect(running.drive).toBeGreaterThan(irons.drive);

    // and the SPEED knob has to matter on its own, not only the bearing
    applyWorldSettings(world({ timeOfDay: 9, windDirection: 0, windSpeed: 3 }));
    const breeze = sailDrive(
      { ...ship, windDirection: oceanParams.windDirection, windSpeed: oceanParams.windSpeed },
      shipMaterialParams,
    );
    expect(running.drive).toBeGreaterThan(breeze.drive);
  });

  it('names the wind for where it comes FROM, which is the reversible half', () => {
    // A northerly blows toward the SOUTH. Get this backwards and NOTHING looks
    // wrong — the sea, the sails and the flags all still agree with each other
    // and all disagree with the word on the button, in every direction at once.
    const north = WIND_PRESETS.find((p) => p.label === 'N')!;
    const w = apparentWind({
      windDirection: north.value, windSpeed: 10, shipVelX: 0, shipVelZ: 0,
    });
    expect(w.z).toBeLessThan(-0.99); // blowing toward −Z, i.e. southward
    const east = WIND_PRESETS.find((p) => p.label === 'E')!;
    const e = apparentWind({
      windDirection: east.value, windSpeed: 10, shipVelX: 0, shipVelZ: 0,
    });
    expect(e.x).toBeLessThan(-0.99); // an easterly blows toward −X, westward
  });

  it('round-trips the slider through the store without losing a compass point', () => {
    // the segment plate highlights on EXACT equality, so a preset and the
    // slider landing on the same bearing must produce the identical float
    for (const p of WIND_PRESETS) {
      const stored = sanitizeSettings({ world: { windDirection: p.value } }).world.windDirection;
      expect(stored).toBe(p.value);
      expect(WIND_PRESETS[windFromDeg(stored) / 45].label).toBe(p.label);
    }
  });

  it('WRAPS the bearing instead of clamping it — an angle has no ends', () => {
    // clamping would pile a north-westerly (7π/4) onto due south
    const tau = Math.PI * 2;
    expect(sanitizeSettings({ world: { windDirection: tau + 0.5 } }).world.windDirection)
      .toBeCloseTo(0.5, 9);
    expect(sanitizeSettings({ world: { windDirection: -0.5 } }).world.windDirection)
      .toBeCloseTo(tau - 0.5, 9);
    expect(sanitizeSettings({ world: { windDirection: 'northerly' } }).world.windDirection)
      .toBe(DEFAULT_SETTINGS.world.windDirection);
    expect(sanitizeSettings({ world: { windDirection: NaN } }).world.windDirection)
      .toBe(DEFAULT_SETTINGS.world.windDirection);
  });

  it('clamps wind speed to a sea the spectrum can carry', () => {
    // 0 is not a light breeze, it is "delete the ocean": Phillips' fetch length
    // is V²/g, so at zero there is no wind sea at all
    expect(sanitizeSettings({ world: { windSpeed: 0 } }).world.windSpeed)
      .toBe(SEA_RANGES.windSpeed.min);
    expect(sanitizeSettings({ world: { windSpeed: 400 } }).world.windSpeed)
      .toBe(SEA_RANGES.windSpeed.max);
    expect(sanitizeSettings({ world: { windSpeed: NaN } }).world.windSpeed)
      .toBe(DEFAULT_SETTINGS.world.windSpeed);
  });

  it('persists across a reload and is NEVER touched by a quality preset', () => {
    const mem = fakeStorage();
    const a = createSettingsStore(mem);
    a.set({ world: { windDirection: 3.1, windSpeed: 17.5 } });
    const b = createSettingsStore(mem);
    expect(b.get().world.windDirection).toBeCloseTo(3.1, 9);
    expect(b.get().world.windSpeed).toBeCloseTo(17.5, 9);
    for (const q of ['low', 'medium', 'high'] as const) {
      b.applyQuality(q);
      expect(b.get().world.windDirection).toBeCloseTo(3.1, 9);
      expect(b.get().world.windSpeed).toBeCloseTo(17.5, 9);
    }
  });

  it('reads the slider in Beaufort, with Force 3 on the whitecap threshold', () => {
    // the label is the whole reason this slider is usable: 3.7 m/s is where the
    // foam gate starts producing whitecaps, and "F3" is what tells the player
    // that without them having to learn a metre per second
    expect(windSpeedLabel(3.7)).toContain('F3');
    expect(windSpeedLabel(3.3)).toContain('F2');
    expect(windSpeedLabel(DEFAULT_SETTINGS.world.windSpeed)).toContain('F6');
    expect(windSpeedLabel(11)).toContain('11.0 m/s');
  });
});

/**
 * §B CANDIDATE, PINNED RATHER THAN BLESSED — the sea and the sails read the
 * SAME `windDirection` through two DIFFERENT conventions.
 *
 *   src/ocean/oceanMath.ts `phillips`  : wind = (cos θ, sin θ)  — from +X
 *   src/ship/flagDynamics.ts `apparentWind` : wind = (sin θ, cos θ) — from +Z
 *
 * Those are a reflection of each other, so the wave bearing is 90° − θ while
 * the rig feels θ. Measured over the shipped spectrum, energy-weighted:
 *
 *   θ =   0°  sea  90°  sails   0°   90° apart
 *   θ =  45°  sea  45°  sails  45°    AGREE
 *   θ =  90°  sea   0°  sails  90°   90° apart
 *   θ = 135°  sea 315°  sails 135°  180° apart — sea runs dead against the rig
 *   θ = 225°  sea 225°  sails 225°   AGREE
 *
 * It has never been visible because the shipped default is exactly π/4 = 45°,
 * one of the two fixed points of that reflection. The wind control is what
 * exposes it: the first drag off the default splits the world in two.
 *
 * The camps split the project roughly in half — cos/sin: the ocean spectrum,
 * spray, palm sway, foam shading, rain slant; sin/cos: sails, flags, AI
 * steering, audio panning, the HUD dial. Reconciling them is a cross-cutting
 * change to main.ts's tick block among others, so it is NOT done here.
 *
 * This test pins the CURRENT relationship so the divergence is a visible,
 * named fact rather than a surprise, and so that whoever fixes it has to come
 * here and delete this block on purpose.
 */
describe('KNOWN DIVERGENCE: sea and sails read windDirection mirrored', () => {
  it('the wave bearing is 90° − windDirection while the rig feels windDirection', () => {
    for (const deg of [0, 45, 90, 135]) {
      const theta = (deg * Math.PI) / 180;
      // a mode running along the SAILS' wind vector, and one along the SEA's
      const sail = { x: Math.sin(theta), z: Math.cos(theta) };
      const sea = { x: Math.cos(theta), z: Math.sin(theta) };
      const p = { ...oceanParams, windDirection: theta };
      const eSail = phillips(0.05 * sail.x, 0.05 * sail.z, p);
      const eSea = phillips(0.05 * sea.x, 0.05 * sea.z, p);
      // the spectrum peaks along ITS OWN convention, not the rig's — equal only
      // at the 45° fixed point, where the two conventions coincide
      if (deg === 45) expect(eSail).toBeCloseTo(eSea, 12);
      else expect(eSea).toBeGreaterThan(eSail);
    }
  });
});

/**
 * THE BEAUFORT LADDER (user: "we probably want more presets so that we can be
 * a little bit more fine-grained... our storm is a little bit too intense —
 * basically too crazy to be in... some more interesting things like a perfect,
 * almost perfect flatness... as well as subdivisions on the way up").
 *
 * The complaint is about SPACING, so the tests are about spacing, and they are
 * measured rather than asserted from the authored numbers: every rung's `hs`
 * is recomputed here from the live spectrum. That means a change to the ocean
 * — a retuned amplitude, a new cascade domain, a different spreading fit —
 * cannot silently pull the ladder out from under the labels.
 */
describe('the sea state ladder is evenly spaced and measured, not guessed', () => {
  // these tests write the SHIPPED oceanParams (that is the §V.62 point), so
  // they must put it back — the ladder ends on a gale, and leaking that into
  // the next file's defaults check is a confusing way to fail
  const shipped = {
    windSpeed: oceanParams.windSpeed,
    windDirection: oceanParams.windDirection,
    amplitude: oceanParams.amplitude,
    swellAmplitude: oceanParams.swellAmplitude,
    swellPeriod: oceanParams.swellPeriod,
    swellDirection: oceanParams.swellDirection,
  };
  afterEach(() => Object.assign(oceanParams, shipped));

  /** Hs = 4√m₀ summed over the three cascades, off the real spectrum */
  function measureHs(w: ReturnType<typeof world>): number {
    const p = {
      ...oceanParams,
      windSpeed: w.windSpeed,
      amplitude: w.amplitude,
      swellAmplitude: w.swellAmplitude,
      swellPeriod: w.swellPeriod,
    };
    let v = 0;
    for (let i = 0; i < 3; i++) {
      v += spectralHeightVariance(128, p.cascades[i].domain, p, cascadeBand(i, p.splitWavelengths));
    }
    return 4 * Math.sqrt(v);
  }

  it('every rung really is the wave height it claims', () => {
    for (const rung of SEA_STATES) {
      const measured = measureHs(world(seaStatePatch(rung)));
      // 5% — the authored number is a rounded readout, not a magic constant
      expect(measured, `${rung.id} claims ${rung.hs} m`).toBeCloseTo(rung.hs, 1);
      expect(Math.abs(measured - rung.hs) / rung.hs).toBeLessThan(0.05);
    }
  });

  it('climbs without a gap you could fall through — THE actual complaint', () => {
    // three presets measured 1.23 / 2.78 / 14.70 m: the top step was 5.3× and
    // there was nothing at all between a working sea and an unsurvivable one
    const hs = SEA_STATES.map((r) => r.hs);
    for (let i = 1; i < hs.length; i++) {
      expect(hs[i], 'the ladder must be monotonic').toBeGreaterThan(hs[i - 1]);
      // no rung may more than double the sea under it
      expect(hs[i] / hs[i - 1], `step ${SEA_STATES[i].id} is a cliff`).toBeLessThan(2.2);
    }
    expect(hs[0]).toBeLessThan(0.25); // "almost perfect flatness"
    expect(hs[hs.length - 1]).toBeGreaterThan(9); // still a real gale at the top
  });

  it('the top rung is survivable, unlike the storm preset it replaces', () => {
    // storm authors amplitude 1.15 at wind 18 and measures Hs 14.70 m — worse
    // than the worst recorded North Atlantic sea, and past the 8–10 m its own
    // comment says it was cut to. "Too crazy to be in" (user) is that number.
    const gale = SEA_STATES[SEA_STATES.length - 1];
    const asShipped = measureHs(world({ ...seaStatePatch(gale), amplitude: 1.15 }));
    expect(asShipped).toBeGreaterThan(14);
    expect(measureHs(world(seaStatePatch(gale)))).toBeLessThan(10.5);
    // the wind is NOT what was wrong, so the recalibration leaves it alone
    expect(gale.windSpeed).toBe(18);
  });

  it('puts the first whitecaps on Force 3, where the published law puts them', () => {
    // Callaghan 2008 fits whitecap onset at 3.70 m/s; NOAA's Force 3 begins at
    // 3.60 m/s and is the first mention of white horses in the whole scale.
    // The ladder has to straddle that, or "first foam" lands on a rung whose
    // description does not mention foam at all.
    const f3 = SEA_STATES.find((r) => r.id === 'f3')!;
    const f2 = SEA_STATES.find((r) => r.id === 'f2')!;
    expect(f2.windSpeed).toBeLessThan(3.7); // no foam is possible here
    expect(f3.windSpeed).toBeGreaterThan(3.7); // and some is, here
    expect(f3.sea.toLowerCase()).toContain('white horses');
  });

  it('a rung NEVER touches a bearing — a preset must not spin the compass', () => {
    const patch = seaStatePatch(SEA_STATES[0]);
    expect(patch).not.toHaveProperty('windDirection');
    expect(patch).not.toHaveProperty('swellDirection');
    const store = createSettingsStore(fakeStorage());
    store.set({ world: { windDirection: 1.23, swellDirection: 4.56 } });
    for (const rung of SEA_STATES) {
      store.set({ world: seaStatePatch(rung) });
      expect(store.get().world.windDirection).toBeCloseTo(1.23, 9);
      expect(store.get().world.swellDirection).toBeCloseTo(4.56, 9);
    }
  });

  it('SUGGESTS a swell but never locks it — a big swell on a calm day is real', () => {
    // the user was explicit that the two are independent, and params/ocean.ts:92
    // decouples them on purpose. A rung writes a swell that suits it; dragging
    // the swell afterwards must stick, and must simply read as Custom.
    const store = createSettingsStore(fakeStorage());
    const glass = SEA_STATES[0];
    store.set({ world: seaStatePatch(glass) });
    expect(seaStateFor(store.get().world)?.id).toBe('f1');
    // a heavy ground swell under a glassy calm: the single sea that proves it
    store.set({ world: { swellAmplitude: 1.2, swellPeriod: 16 } });
    const s = store.get().world;
    expect(s.swellAmplitude).toBeCloseTo(1.2, 9);
    expect(s.windSpeed).toBe(glass.windSpeed); // the calm survived the swell
    expect(seaStateFor(s)).toBeNull(); // and the plate honestly reads Custom
    expect(measureHs(s)).toBeGreaterThan(4); // a genuinely big sea, in a calm
  });

  it('every rung round-trips through the store and lights its own plate', () => {
    // the plate highlights on exact equality after sanitize, so a rung written
    // through the store must come back bit-identical or nothing ever lights up
    const store = createSettingsStore(fakeStorage());
    for (const rung of SEA_STATES) {
      store.set({ world: seaStatePatch(rung) });
      expect(seaStateFor(store.get().world)?.id, `${rung.id} does not light`).toBe(rung.id);
    }
  });

  it('drives the SEA and the SAILS on every rung, not just the store (§V.62)', () => {
    const seen = new Set<string>();
    let lastDrive = Infinity;
    for (const rung of SEA_STATES) {
      applyWorldSettings(world(seaStatePatch(rung)));
      // the sea: a distinct spectrum per rung, so each one really rebuilds
      seen.add(spectrumSignature(oceanParams));
      // the sails: more wind must mean more drive, all the way up the ladder
      const d = sailDrive(
        {
          forwardX: 0, forwardZ: 1, shipVelX: 0, shipVelZ: 0, yawRate: 0,
          windDirection: oceanParams.windDirection, windSpeed: oceanParams.windSpeed,
        },
        shipMaterialParams,
      ).drive;
      expect(d, `${rung.id} does not draw more than the rung below`).toBeGreaterThan(
        lastDrive === Infinity ? -1 : lastDrive,
      );
      lastDrive = d;
    }
    expect(seen.size).toBe(SEA_STATES.length);
  });
});

/**
 * The continuous swell controls — the half of the ask the ladder does NOT
 * answer, because Beaufort describes wind sea and says nothing about a train
 * radiated by a storm that has since blown itself out.
 */
describe('swell is continuous, independent, and actually reaches the water', () => {
  const shipped = {
    amplitude: oceanParams.amplitude,
    swellAmplitude: oceanParams.swellAmplitude,
    swellPeriod: oceanParams.swellPeriod,
    swellDirection: oceanParams.swellDirection,
    windSpeed: oceanParams.windSpeed,
    windDirection: oceanParams.windDirection,
  };
  afterEach(() => Object.assign(oceanParams, shipped));

  it('defaults to the ocean params, so there are not two drifting defaults', () => {
    expect(DEFAULT_SETTINGS.world.amplitude).toBe(oceanParams.amplitude);
    expect(DEFAULT_SETTINGS.world.swellAmplitude).toBe(oceanParams.swellAmplitude);
    expect(DEFAULT_SETTINGS.world.swellPeriod).toBe(oceanParams.swellPeriod);
    expect(DEFAULT_SETTINGS.world.swellDirection).toBe(oceanParams.swellDirection);
  });

  it('every swell key is a SPECTRUM key, so none of them is a free ride', () => {
    // verified rather than assumed: if any of these were outside the signature
    // it could be driven live instead of on release — and if a refactor drops
    // one, the slider goes dead with the row still moving
    const base = spectrumSignature(oceanParams);
    for (const patch of [
      { swellAmplitude: 0.9 },
      { swellPeriod: 6 },
      { swellDirection: 1.0 },
      { amplitude: 0.9 },
    ]) {
      applyWorldSettings(world(patch));
      expect(spectrumSignature(oceanParams), `${Object.keys(patch)[0]} is not in the signature`)
        .not.toBe(base);
      Object.assign(oceanParams, shipped);
    }
  });

  it('swell direction is NOT tied to the wind — that decoupling is the point', () => {
    applyWorldSettings(world({ windDirection: 0.3, swellDirection: 3.0 }));
    expect(oceanParams.windDirection).toBeCloseTo(0.3, 9);
    expect(oceanParams.swellDirection).toBeCloseTo(3.0, 9);
    // turning the wind right around leaves the swell exactly where it was
    applyWorldSettings(world({ windDirection: 3.4, swellDirection: 3.0 }));
    expect(oceanParams.swellDirection).toBeCloseTo(3.0, 9);
  });

  it('reads swell height in metres a sailor can picture, not RMS', () => {
    // the param is RMS elevation and the significant height is 4× it — showing
    // the raw 0.34 would be showing a number nobody can stand next to
    expect(swellHeightLabel(0.34)).toBe('1.4 m');
    expect(swellHeightLabel(0)).toContain('none');
  });

  it('reads swell period with the wavelength it implies', () => {
    // lambda = gT^2/2pi: 11 s is 189 m, which is what decides whether a 35 m
    // hull lifts to the wave or rides over it
    expect(swellPeriodLabel(11)).toContain('189 m');
    expect(swellPeriodLabel(11)).toContain('11.0 s');
  });

  it('clamps and wraps the swell the same way the wind is', () => {
    expect(sanitizeSettings({ world: { swellAmplitude: -3 } }).world.swellAmplitude)
      .toBe(SEA_RANGES.swellAmplitude.min);
    expect(sanitizeSettings({ world: { swellPeriod: 99 } }).world.swellPeriod)
      .toBe(SEA_RANGES.swellPeriod.max);
    expect(sanitizeSettings({ world: { swellDirection: -0.5 } }).world.swellDirection)
      .toBeCloseTo(Math.PI * 2 - 0.5, 9);
    expect(sanitizeSettings({ world: { swellPeriod: 'long' } }).world.swellPeriod)
      .toBe(DEFAULT_SETTINGS.world.swellPeriod);
  });

  it('every slider step is at least as coarse as the sim can hold', () => {
    // the §V.46 field publishes windSpeed quantised to 0.5 m/s and amplitude to
    // 0.02, so a finer step would offer the player precision the sim discards
    expect(SEA_RANGES.windSpeed.step).toBeGreaterThanOrEqual(0.5);
    expect(SEA_RANGES.amplitude.step).toBeGreaterThanOrEqual(0.02);
  });
});

/**
 * §B.49 — WHY SHE IS NOT MAKING WAY.
 *
 * The user's report took several messages to land because "at anchor",
 * "becalmed", "in irons", "sails furled" and "aground" all look identical
 * from the deck: a ship sitting still. Verbatim: "we probably want an anchor
 * button that actually anchors the ship, so we don't have to have this
 * ambiguity between what is anchored and where it can't move."
 *
 * So the HUD names the state, and these tests pin the PRECEDENCE — more than
 * one is routinely true at once (she boots anchored AND furled AND in irons),
 * and the player needs the one they must clear first.
 */
describe('the HUD says why she is not moving (§B.49)', () => {
  const sailing = {
    anchored: false, aground: false, sailTrim: 1,
    windSpeed: 11, theta: Math.PI / 2, noGoDegrees: 30,
  };

  it('says nothing at all when she IS sailing — the badge is not decoration', () => {
    expect(stalledReason(sailing)).toBeNull();
  });

  it('names each state on its own', () => {
    expect(stalledReason({ ...sailing, anchored: true })).toBe('at anchor');
    expect(stalledReason({ ...sailing, aground: true })).toBe('aground');
    expect(stalledReason({ ...sailing, windSpeed: 0.2 })).toBe('becalmed');
    expect(stalledReason({ ...sailing, sailTrim: 0 })).toBe('sails furled');
    expect(stalledReason({ ...sailing, theta: 0.3 })).toBe('in irons');
  });

  it('the anchor outranks everything — weighing it is the first thing to do', () => {
    // exactly the state she boots in: anchored, furled AND head to wind
    const boot = { ...sailing, anchored: true, sailTrim: 0, theta: 0.41 };
    expect(stalledReason(boot)).toBe('at anchor');
    expect(stalledReason({ ...boot, anchored: false })).toBe('sails furled');
    expect(stalledReason({ ...boot, anchored: false, sailTrim: 1 })).toBe('in irons');
  });

  it('blames the WIND before the canvas — a furled ship in a flat calm is becalmed', () => {
    // otherwise the readout tells a player to set canvas that cannot help
    expect(stalledReason({ ...sailing, windSpeed: 0, sailTrim: 0 })).toBe('becalmed');
  });

  it('the no-go boundary is the dial’s, so the badge and the rose agree', () => {
    const at = (deg: number): string | null =>
      stalledReason({ ...sailing, theta: (deg * Math.PI) / 180 });
    expect(at(29)).toBe('in irons');
    expect(at(31)).toBeNull();
  });
});

/**
 * §B.49 — one Beaufort table, two readouts. The settings slider says
 * "11.0 m/s · F6 strong breeze" and the HUD's true-wind plaque says
 * "21.4 kt · F6". A second table would drift, and a player reading two
 * different forces for one wind has no way to know which screen is lying.
 */
describe('the settings slider and the HUD name the same wind', () => {
  it('windSpeedLabel is built from the shared beaufort() bands', () => {
    for (const [mps, force] of [[0.2, 0], [1.0, 1], [3.4, 3], [8.0, 5], [11, 6], [18, 8]] as const) {
      expect(beaufort(mps).force).toBe(force);
      expect(windSpeedLabel(mps)).toContain(`F${force}`);
      expect(windSpeedLabel(mps)).toContain(beaufort(mps).name);
    }
  });

  it('the ladder’s own rungs land on the force their label promises', () => {
    // SEA_STATES is authored in m/s and named in Beaufort; the two must agree
    expect(beaufort(SEA_STATES[2].windSpeed).force).toBe(3); // the whitecap rung
    expect(beaufort(SEA_STATES[7].windSpeed).force).toBe(8); // the gale
  });
});
