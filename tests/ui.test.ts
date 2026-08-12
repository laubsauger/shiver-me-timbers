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
import { skyParams } from '../src/params/sky';
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
