/**
 * Settings store tests (§V21: settings survive reload; corrupt persistence
 * must never crash the game — a broken save on a showcase machine would
 * take down the whole demo, so load is required to fall back to defaults
 * silently, and every persisted value is clamped so a hand-edited or stale
 * save can't push the renderer outside its supported range).
 * Store only — node env, no DOM.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  QUALITY_PRESETS,
  createSettingsStore,
  sanitizeSettings,
} from '../src/ui/settingsStore';
import type { Quality, QualityHints, StorageLike } from '../src/ui/settingsStore';

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
