/**
 * Settings screen inside the pause panel (§I ui/settings/graphics + audio).
 *
 * Graphics is a list of INDIVIDUAL switches over the params registry — every
 * expensive system can be thrown from here, which is the whole point: a player
 * whose ship is being corrupted by one effect must be able to reach that
 * effect without opening a debug panel. Quality presets sit on top as named
 * bundles that write those same switches, so the two can never disagree.
 *
 * Audio is master / music / effects / ambience, independently (§I).
 */
import type { GameSettings, Quality, SettingsStore } from './settingsStore';
import { GRAPHICS_FEATURES, SHADOW_MAP_SIZES } from './graphicsFeatures';
import type { GraphicsFeatureId } from './graphicsFeatures';
import { featureNeedsReload, featureWired, shadowMapSizeNeedsReload, unwiredFeatures } from './graphicsFeatures';
import { sectionHead, segmentRow, sliderRow, switchRow } from './settingsControls';
import type { SwitchRow } from './settingsControls';
import { button, div, el } from './dom';

/** structural mirror of AudioSystem.musicInfo() — no import into src/audio */
export interface MusicStatus {
  tracks: number;
  current: string | null;
  duck: number;
}

export interface SettingsScreen {
  root: HTMLElement;
  focusFirst(): void;
  /** re-read availability — sinks can be registered after the UI is built */
  refresh(): void;
  /** main.ts hands over `() => audio.musicInfo()` for the now-playing line */
  setMusicStatusSource(fn: () => MusicStatus): void;
  dispose(): void;
}

const QUALITY_LABELS: Record<Quality, string> = { low: 'Low', medium: 'Medium', high: 'High' };

/**
 * Named hours worth one click. `Sunset` is the §T.39 showcase value: the sun
 * sits at 4.35°, which is where the golden-hour palette is fully saturated AND
 * the key is still at 93% — the only window where both hold (see sunCycle).
 * `Golden` is the brighter alternative one notch earlier.
 *
 * `Night` is 19:15, and it is NOT the darkest hour on purpose. A full moon is
 * by definition ANTIPODAL to the sun (src/sky/moonCycle.ts `moonDirection`),
 * so it is highest exactly when the night is deepest — 43° at 21:00, 75° at
 * midnight — and a body at 75° casts no glint ROAD, only a small pool of
 * sparkle straight below it. The road needs a LOW body, and the moon is only
 * low while the sun has just gone: measured, the road exists over 19:00–19:30
 * and again over 04:30–05:00, and nowhere in between.
 *
 * Do NOT try to buy a low moon with `moonPhase` instead. Phase moves the moon
 * along its own track, not down: at 0.35 it still sits at 72° at 21:00, and
 * `MOON_SURGE` has already dropped the key to 0.42 of full by then — a dimmer
 * moon in the same wrong place.
 *
 * The sun is at -17° here, so a band of dusk survives in the west. That is
 * wanted: it is what the moonlit water is read against.
 */
const TIME_PRESETS: readonly { value: number; label: string }[] = [
  { value: 6.3, label: 'Dawn' },
  { value: 9, label: 'Morning' },
  { value: 12, label: 'Noon' },
  { value: 17.3, label: 'Golden' },
  { value: 17.7, label: 'Sunset' },
  { value: 19.25, label: 'Night' },
];

/** 17.7 → "17:42" — hours are not decimal and reading them as such is a trap */
function clockLabel(v: number): string {
  const h = Math.floor(v);
  const m = Math.round((v - h) * 60);
  // 17.999 rounds minutes to 60; carry it rather than printing "17:60"
  const hh = m === 60 ? (h + 1) % 24 : h;
  return `${String(hh).padStart(2, '0')}:${String(m === 60 ? 0 : m).padStart(2, '0')}`;
}

/** section title → the switches it holds, in reading order */
const SECTIONS: readonly { title: string; ids: GraphicsFeatureId[] }[] = [
  { title: 'Effects', ids: ['reflections', 'caustics', 'deckWater', 'spray', 'rain'] },
  { title: 'Shadows', ids: ['shadows', 'islandShadows'] },
  { title: 'Post-processing', ids: ['postFx', 'postAo', 'postBloom', 'postVibrance', 'postVignette'] },
];

const pct = (v: number): string => `${Math.round(v * 100)}%`;

export function createSettingsScreen(store: SettingsStore, onBack: () => void): SettingsScreen {
  const backBtn = button('smt-back-btn', '‹ Back');
  backBtn.addEventListener('click', onBack);
  const head = div('smt-settings-head', el('h2', 'smt-settings-title', 'Settings'), backBtn);

  const graphicsTab = button('smt-tab is-active', 'Graphics');
  const audioTab = button('smt-tab', 'Audio');
  const tabs = div('smt-tabs', graphicsTab, audioTab);
  tabs.setAttribute('role', 'tablist');
  graphicsTab.id = 'smt-tab-graphics';
  audioTab.id = 'smt-tab-audio';
  for (const [tab, panel] of [[graphicsTab, 'smt-panel-graphics'], [audioTab, 'smt-panel-audio']] as const) {
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', panel);
  }
  graphicsTab.setAttribute('aria-selected', 'true');
  audioTab.setAttribute('aria-selected', 'false');

  // — preset —
  const quality = segmentRow<Quality>({
    label: 'Detail',
    hint: 'A named set of the switches below. Change any one and this reads Custom.',
    options: (['low', 'medium', 'high'] as const).map((q) => ({ value: q, label: QUALITY_LABELS[q] })),
    onSelect: (q) => store.applyQuality(q),
  });
  const presetNote = el('p', 'smt-note', '');
  presetNote.hidden = true;
  quality.root.appendChild(presetNote);

  // — display —
  const resolution = sliderRow({
    label: 'Resolution',
    hint: 'Renders below native size and scales up. The cheapest frame you can buy.',
    min: 0.5, max: 1, step: 0.05, format: pct,
    onInput: (v) => store.set({ graphics: { resolutionScale: v } }),
  });

  // — feature switches —
  const switches = new Map<GraphicsFeatureId, SwitchRow>();
  const sectionByTitle = new Map<string, HTMLElement>();
  const featureSections = SECTIONS.map(({ title, ids }) => {
    const rows = ids.map((id) => {
      const f = GRAPHICS_FEATURES.find((x) => x.id === id)!;
      const row = switchRow({
        label: f.label,
        hint: f.hint,
        nested: !!f.parent,
        onToggle: (on) => store.set({ graphics: { features: { [id]: on } } }),
      });
      switches.set(id, row);
      return row.root;
    });
    const section = div('smt-section', sectionHead(title), ...rows);
    sectionByTitle.set(title, section);
    return section;
  });

  const shadowMap = segmentRow<number>({
    label: 'Shadow detail',
    hint: 'Texels in the sun shadow map. Allocated when the game starts.',
    options: SHADOW_MAP_SIZES.map((s) => ({ value: s, label: `${s / 1024}K` })),
    onSelect: (v) => store.set({ graphics: { shadowMapSize: v } }),
  });
  // the size control belongs with the switches it sizes, not in its own group
  sectionByTitle.get('Shadows')!.appendChild(shadowMap.root);

  const foliage = sliderRow({
    label: 'Foliage',
    hint: 'How far out palms are still drawn. At nought the islands go bare.',
    min: 0, max: 1, step: 0.05, format: (v) => (v === 0 ? 'none' : pct(v)),
    onInput: (v) => store.set({ graphics: { foliageDensity: v } }),
  });

  // — time of day —
  // A creative control, deliberately NOT in a quality bundle. Presets first
  // because the common case is "put me at sunset now"; the slider is there for
  // the case the presets do not cover. Both write the same setting.
  const todPreset = segmentRow<number>({
    label: 'Time of day',
    hint: 'The sun sets at 18:00. Golden hour is the last half hour before it.',
    options: TIME_PRESETS,
    onSelect: (v) => store.set({ world: { timeOfDay: v } }),
  });
  const todSlider = sliderRow({
    label: 'Exact hour',
    hint: 'Fine control, for framing a shot the presets do not land on.',
    min: 0, max: 23.9, step: 0.05, format: clockLabel,
    onInput: (v) => store.set({ world: { timeOfDay: v } }),
  });

  const graphicsRows = div(
    'smt-rows',
    div('smt-section', sectionHead('Preset'), quality.root),
    div('smt-section', sectionHead('Display'), resolution.root),
    div('smt-section', sectionHead('World'), todPreset.root, todSlider.root),
    ...featureSections,
    div('smt-section', sectionHead('Scenery'), foliage.root),
  );
  graphicsRows.id = 'smt-panel-graphics';
  graphicsRows.setAttribute('role', 'tabpanel');
  graphicsRows.setAttribute('aria-labelledby', 'smt-tab-graphics');

  // — audio —
  const audioSpecs = [
    { key: 'master' as const, label: 'Master', hint: 'Everything, at once.' },
    { key: 'music' as const, label: 'Music', hint: 'The score. Steps back on its own when the guns come out.' },
    { key: 'sfx' as const, label: 'Effects', hint: 'Cannon, hull, canvas, splashes.' },
    { key: 'ambience' as const, label: 'Ambience', hint: 'Sea, wind and weather.' },
  ];
  const audioRowsByKey = audioSpecs.map((spec) => ({
    key: spec.key,
    row: sliderRow({
      label: spec.label, hint: spec.hint, min: 0, max: 1, step: 0.01, format: pct,
      onInput: (v) => store.set({ audio: { [spec.key]: v } }),
    }),
  }));
  // now playing, under the music fader — the one place a player looks to find
  // out what the tune is, and the honest answer when there is no music aboard
  const nowPlaying = el('p', 'smt-note is-quiet', 'No music aboard yet.');
  audioRowsByKey.find((a) => a.key === 'music')!.row.root.appendChild(nowPlaying);
  let musicStatus: (() => MusicStatus) | null = null;
  function syncNowPlaying(): void {
    const info = musicStatus?.();
    if (!info || info.tracks === 0) {
      nowPlaying.textContent = 'No music aboard yet.';
      return;
    }
    if (!info.current) {
      nowPlaying.textContent = 'Between tracks.';
      return;
    }
    nowPlaying.textContent = `Now playing: ${info.current}${info.duck < 1 ? ' — stepped back' : ''}`;
  }
  const audioRows = div('smt-rows', div('smt-section', sectionHead('Volumes'),
    ...audioRowsByKey.map((a) => a.row.root)));
  audioRows.id = 'smt-panel-audio';
  audioRows.setAttribute('role', 'tabpanel');
  audioRows.setAttribute('aria-labelledby', 'smt-tab-audio');
  audioRows.style.display = 'none';
  // ticks only while the audio tab is actually on screen
  const poll = setInterval(() => {
    if (audioRows.style.display !== 'none' && root.isConnected) syncNowPlaying();
  }, 1000);

  function selectTab(which: 'graphics' | 'audio'): void {
    const g = which === 'graphics';
    graphicsTab.classList.toggle('is-active', g);
    audioTab.classList.toggle('is-active', !g);
    graphicsTab.setAttribute('aria-selected', String(g));
    audioTab.setAttribute('aria-selected', String(!g));
    graphicsRows.style.display = g ? '' : 'none';
    audioRows.style.display = g ? 'none' : '';
    if (!g) syncNowPlaying();
  }
  graphicsTab.addEventListener('click', () => selectTab('graphics'));
  audioTab.addEventListener('click', () => selectTab('audio'));

  function sync(s: GameSettings): void {
    quality.set(s.graphics.quality);
    const intact = store.isPresetIntact();
    presetNote.hidden = intact;
    presetNote.textContent = intact
      ? ''
      : `Custom — altered from ${QUALITY_LABELS[s.graphics.quality]}.`;
    resolution.set(s.graphics.resolutionScale);
    shadowMap.set(s.graphics.shadowMapSize);
    shadowMap.setPendingReload(shadowMapSizeNeedsReload(s.graphics.shadowMapSize));
    foliage.set(s.graphics.foliageDensity);
    // the slider always shows the truth; the preset row highlights nothing
    // when the hour sits between named times, which is the honest state
    todPreset.set(s.world.timeOfDay);
    todSlider.set(s.world.timeOfDay);
    for (const [id, row] of switches) {
      const on = s.graphics.features[id];
      const f = GRAPHICS_FEATURES.find((x) => x.id === id)!;
      row.set(on);
      row.setWired(featureWired(id));
      row.setMuted(!!f.parent && !s.graphics.features[f.parent]);
      row.setPendingReload(featureNeedsReload(id, on));
    }
    for (const a of audioRowsByKey) a.row.set(s.audio[a.key]);
  }

  sync(store.get());
  const unsubscribe = store.subscribe(sync);

  let warned = false;
  function refresh(): void {
    sync(store.get());
    syncNowPlaying();
    if (warned) return;
    warned = true;
    const missing = unwiredFeatures();
    // fail loud: a switch with nothing behind it is the §B silent-no-op shape
    if (missing.length) {
      console.warn(`[ui] graphics switches with no params key or sink: ${missing.join(', ')}`);
    }
  }

  const root = div('smt-settings', head, tabs, graphicsRows, audioRows);
  return {
    root,
    focusFirst: () => backBtn.focus(),
    refresh,
    setMusicStatusSource(fn: () => MusicStatus): void {
      musicStatus = fn;
      syncNowPlaying();
    },
    dispose(): void {
      clearInterval(poll);
      unsubscribe();
    },
  };
}
