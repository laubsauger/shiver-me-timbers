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
import { CARDINALS, beaufort, cardinal } from './windDial';
import { DEFAULT_SETTINGS, SEA_RANGES, SEA_STATES, seaStateFor, seaStatePatch } from './settingsStore';
import { CONTROL_GROUPS } from '../input/controlMap';

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

const DEG = Math.PI / 180;

/**
 * A wind is NAMED for where it comes FROM — a northerly blows toward the
 * south. `windDirection` is the bearing it blows TOWARD, so every label on
 * this control is the stored bearing turned through 180°, and every value
 * written back is the label's bearing turned through 180° again.
 *
 * Getting this backwards is silent and total: the sea, the sails and the
 * flags would all still agree with each other, and all be reversed against
 * the word on the button.
 */
const oppositeDeg = (deg: number): number => (deg + 180) % 360;

/** the toward-bearing (rad) of a wind named for the compass point it comes from */
export const WIND_PRESETS: readonly { value: number; label: string }[] = CARDINALS.map(
  (label, i) => ({ value: oppositeDeg(i * 45) * DEG, label }),
);

/**
 * Stored toward-bearing (rad) → the FROM bearing in whole degrees, snapped to
 * the slider's own 5° step. Rounded rather than truncated because the rad↔deg
 * round trip is not exact in binary: 225° comes back as 224.99999999999997,
 * and a truncating slider would read one step low for every preset.
 */
export function windFromDeg(rad: number): number {
  const toward = ((((rad / DEG) % 360) + 360) % 360);
  return (Math.round(oppositeDeg(toward) / 5) * 5) % 360;
}

/** the slider's own value IS the FROM bearing: 45 → "from 045° NE" */
function windLabel(fromDeg: number): string {
  const d = ((Math.round(fromDeg) % 360) + 360) % 360;
  return `from ${String(d).padStart(3, '0')}° ${cardinal(d)}`;
}

/**
 * What makes the slider readable instead of a bare number: Force 3 at 3.4 m/s
 * is where WHITECAPS start, i.e. the first place the sea itself visibly
 * answers this control, and Force 6 is where the shipped default sits. A
 * player who wants "a bit more sea" is looking for a force, not for a metre
 * per second. The BANDS come from windDial.ts — the HUD's true-wind plaque
 * names the same wind, and two tables would eventually disagree about it.
 */
export function windSpeedLabel(v: number): string {
  const b = beaufort(v);
  return `${v.toFixed(1)} m/s · F${b.force} ${b.name}`;
}

const GRAVITY = 9.81;

/**
 * Swell height in the unit a mariner reads: SIGNIFICANT height, which is 4×
 * the RMS elevation the param stores (see `swellAmplitude` in params/ocean).
 * Showing the raw 0.34 would be showing a number nobody can picture; 1.4 m is
 * a sea you can imagine standing in.
 */
export function swellHeightLabel(rms: number): string {
  return rms <= 0 ? 'none — pure wind sea' : `${(4 * rms).toFixed(1)} m`;
}

/**
 * Period AND the wavelength it implies (λ = gT²/2π), because the period alone
 * does not say how far apart the crests are and the wavelength is what decides
 * whether a 35 m hull lifts to a wave or rides over it.
 *
 * MEASURED HEIGHT-NEUTRAL across this whole range — Hs 2.79 m at 4 s against
 * 2.69 m at 20 s — because the swell spectrum is normalised for its own
 * height. So this slider changes the sea's CHARACTER and nothing else, which
 * is exactly the "long rolling swell under light chop" the weather presets
 * record as unreachable.
 */
export function swellPeriodLabel(t: number): string {
  return `${t.toFixed(1)} s · λ ${Math.round((GRAVITY * t * t) / (2 * Math.PI))} m`;
}

/**
 * The wind sea's ENERGY, against the sea as shipped. There is no honest metre
 * reading for this one: it is the Phillips scale, and the project has already
 * been bitten by treating it as a height (amplitude fell 0.75 → 0.32 while Hs
 * ROSE 2.3 → 2.8 m, i.e. the two moved in opposite directions). A multiple of
 * a sea the player has actually seen is the readable, true thing to print.
 */
export function windSeaLabel(v: number, shipped: number): string {
  if (v <= 0) return 'flat — swell only';
  return `${(v / Math.max(1e-6, shipped)).toFixed(2)}×`;
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
  const controlsTab = button('smt-tab', 'Controls');
  const tabs = div('smt-tabs', graphicsTab, audioTab, controlsTab);
  tabs.setAttribute('role', 'tablist');
  graphicsTab.id = 'smt-tab-graphics';
  audioTab.id = 'smt-tab-audio';
  controlsTab.id = 'smt-tab-controls';
  for (const [tab, panel] of [
    [graphicsTab, 'smt-panel-graphics'],
    [audioTab, 'smt-panel-audio'],
    [controlsTab, 'smt-panel-controls'],
  ] as const) {
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', panel);
  }
  graphicsTab.setAttribute('aria-selected', 'true');
  audioTab.setAttribute('aria-selected', 'false');
  controlsTab.setAttribute('aria-selected', 'false');

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

  // — wind —
  // Beside time of day and for the same reason: both stage the world, neither
  // is a performance decision, and a quality preset must never move either.
  //
  // BOTH of these rows commit on RELEASE. windSpeed and windDirection are both
  // in the ocean's spectrum signature, so either one moving rebuilds all three
  // FFT cascades — 419 ms warm. See `commitOnRelease` in settingsControls.
  const windPreset = segmentRow<number>({
    label: 'Wind',
    hint: 'Where the wind blows FROM, as a sailor names it. Turns the sea, the sails and the flags together.',
    options: WIND_PRESETS,
    onSelect: (v) => store.set({ world: { windDirection: v } }),
  });
  const windSlider = sliderRow({
    label: 'Exact bearing',
    hint: 'Anything between the eight points. Settles on release — the sea is refitted, not nudged.',
    min: 0, max: 355, step: 5, format: windLabel,
    commitOnRelease: true,
    // the SLIDER is in degrees and the STORE is in radians, and both ends of
    // the pair go through this one multiplication so a preset and the slider
    // landing on the same point produce the identical float — otherwise the
    // preset plate would never light up for a bearing the slider set
    onInput: (deg) => store.set({ world: { windDirection: oppositeDeg(deg) * DEG } }),
  });
  const windSpeed = sliderRow({
    label: 'Wind speed',
    hint: 'Force 3 is where the first whitecaps break. Above Force 6 she is hard work under full canvas.',
    ...SEA_RANGES.windSpeed,
    format: windSpeedLabel,
    commitOnRelease: true,
    onInput: (v) => store.set({ world: { windSpeed: v } }),
  });

  // — sea state ladder —
  // Eight rungs where there used to be three presets an ocean apart. The plate
  // is the coarse gesture ("give me a gale"); the sliders under it are the fine
  // one, and moving any of them simply drops the plate to Custom.
  const seaState = segmentRow<string>({
    label: 'Sea state',
    hint: 'The Beaufort scale, as a mariner reads it off the deck. Sets the wind sea and suggests a swell to match — both stay yours to alter after.',
    options: SEA_STATES.map((r) => ({ value: r.id, label: r.label })),
    onSelect: (id) => {
      const rung = SEA_STATES.find((r) => r.id === id);
      if (rung) store.set({ world: seaStatePatch(rung) });
    },
  });
  // the NOAA description of whatever sea is actually set — this is what makes
  // nine numbered cells legible, and it is quoted rather than written
  const seaNote = el('p', 'smt-note', '');
  seaState.root.appendChild(seaNote);

  /**
   * THE WAY BACK OUT. The world block persists, so a player who once tried the
   * bottom of the wind slider was becalmed on that save forever and reported
   * it as the game starting with no wind — when the shipped default is 11 m/s,
   * Force 6. Graphics has had `applyQuality` to fall back on all along; this is
   * the same affordance for the half of the store that could actually strand
   * you, and it is deliberately IN the Sea section rather than at the foot of
   * the screen, because that is where the setting that stranded you lives.
   */
  const worldReset = button('smt-reset-btn', 'Reset sea & sky to defaults');
  worldReset.addEventListener('click', () => store.resetWorld());
  const worldResetRow = div('smt-row smt-row--action', worldReset);

  const windSea = sliderRow({
    label: 'Wind sea',
    hint: 'How much energy the local wind puts into the waves it raises. Wind speed sets their LENGTH; this sets their height.',
    ...SEA_RANGES.amplitude,
    format: (v) => windSeaLabel(v, DEFAULT_SETTINGS.world.amplitude),
    commitOnRelease: true,
    onInput: (v) => store.set({ world: { amplitude: v } }),
  });

  // The swell is a SECOND wave train, radiated by a storm days away and miles
  // off, and it is decoupled from the wind on purpose — a long ground swell
  // under a flat calm is a real sea and one of the best ones there is.
  const swellHeight = sliderRow({
    label: 'Swell height',
    hint: 'The long train running under the wind chop. At nought the sea is pure wind sea.',
    ...SEA_RANGES.swellAmplitude,
    format: swellHeightLabel,
    commitOnRelease: true,
    onInput: (v) => store.set({ world: { swellAmplitude: v } }),
  });
  const swellPeriod = sliderRow({
    label: 'Swell period',
    hint: 'Seconds between crests. Long is a slow ocean lift, short is a steep confused sea — the height does not change either way.',
    ...SEA_RANGES.swellPeriod,
    format: swellPeriodLabel,
    commitOnRelease: true,
    onInput: (v) => store.set({ world: { swellPeriod: v } }),
  });
  const swellBearing = sliderRow({
    label: 'Swell bearing',
    hint: 'Swell running ACROSS the wind is the clearest sign this water came from somewhere. It does not follow the wind, by design.',
    min: 0, max: 355, step: 5, format: windLabel,
    commitOnRelease: true,
    onInput: (deg) => store.set({ world: { swellDirection: oppositeDeg(deg) * DEG } }),
  });

  const graphicsRows = div(
    'smt-rows',
    div('smt-section', sectionHead('Preset'), quality.root),
    div('smt-section', sectionHead('Display'), resolution.root),
    div('smt-section', sectionHead('World'), todPreset.root, todSlider.root),
    // the sea gets its own section: it is the biggest group on the screen now,
    // and "close to weather and all of this kind of stuff" (user) is satisfied
    // by sitting directly under the hour, not by sharing its rule
    div(
      'smt-section',
      sectionHead('Sea'),
      seaState.root,
      windPreset.root, windSlider.root, windSpeed.root, windSea.root,
      swellHeight.root, swellPeriod.root, swellBearing.root,
      worldResetRow,
    ),
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

  // — controls —
  // This is rendered from the same control map imported by the live keyboard
  // handlers. It is a reference page, not a rebinding UI: every listed key is
  // therefore guaranteed to describe a binding that exists now.
  const controlsRows = div(
    'smt-rows smt-controls',
    ...CONTROL_GROUPS.map((group) =>
      div(
        'smt-section',
        sectionHead(group.title),
        ...group.bindings.map((binding) => {
          const keys = div(
            'smt-control-keys',
            ...binding.keys.map((key) => el('kbd', 'smt-key', key)),
          );
          const copy = div(
            'smt-control-copy',
            el('span', 'smt-control-action', binding.action),
            ...(binding.hint ? [el('span', 'smt-control-hint', binding.hint)] : []),
          );
          return div('smt-control-row', keys, copy);
        }),
      ),
    ),
  );
  controlsRows.id = 'smt-panel-controls';
  controlsRows.setAttribute('role', 'tabpanel');
  controlsRows.setAttribute('aria-labelledby', 'smt-tab-controls');
  controlsRows.style.display = 'none';
  // ticks only while the audio tab is actually on screen
  const poll = setInterval(() => {
    if (audioRows.style.display !== 'none' && root.isConnected) syncNowPlaying();
  }, 1000);

  function selectTab(which: 'graphics' | 'audio' | 'controls'): void {
    const g = which === 'graphics';
    const a = which === 'audio';
    const c = which === 'controls';
    graphicsTab.classList.toggle('is-active', g);
    audioTab.classList.toggle('is-active', a);
    controlsTab.classList.toggle('is-active', c);
    graphicsTab.setAttribute('aria-selected', String(g));
    audioTab.setAttribute('aria-selected', String(a));
    controlsTab.setAttribute('aria-selected', String(c));
    graphicsRows.style.display = g ? '' : 'none';
    audioRows.style.display = a ? '' : 'none';
    controlsRows.style.display = c ? '' : 'none';
    if (a) syncNowPlaying();
  }
  graphicsTab.addEventListener('click', () => selectTab('graphics'));
  audioTab.addEventListener('click', () => selectTab('audio'));
  controlsTab.addEventListener('click', () => selectTab('controls'));

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
    // same contract for the wind: the plate lights only on an exact point, the
    // slider always shows the truth. The plate goes dark between points and
    // that is the honest state, not a missing highlight.
    windPreset.set(s.world.windDirection);
    windSlider.set(windFromDeg(s.world.windDirection));
    windSpeed.set(s.world.windSpeed);
    windSea.set(s.world.amplitude);
    swellHeight.set(s.world.swellAmplitude);
    swellPeriod.set(s.world.swellPeriod);
    swellBearing.set(windFromDeg(s.world.swellDirection));
    // the ladder highlights only on an exact rung; between rungs it goes dark
    // and the note says what the sea is anyway, which is the useful half
    const rung = seaStateFor(s.world);
    seaState.set(rung?.id ?? '');
    // GLASS carries no Beaufort force and that is deliberate — see the rung's
    // note in settingsStore: Beaufort describes WIND and glass is a claim about
    // the WATER. Printing "Force Glass" would be nonsense, so the force is part
    // of the head only when the rung actually names one.
    // Two decimals below 0.1 m: a glassy calm reads "About 0.01 m", and
    // `toFixed(1)` would have printed it as "About 0.0 m" — a rung that says
    // its own height is zero looks like a bug rather than like glass.
    seaNote.textContent = rung
      ? `${rung.force === undefined ? rung.name : `Force ${rung.label} — ${rung.name}`}. `
        + `${rung.sea} About ${rung.hs.toFixed(rung.hs < 0.1 ? 2 : 1)} m.`
      : 'Between forces — set by hand from the sliders below.';
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

  const root = div('smt-settings', head, tabs, graphicsRows, audioRows, controlsRows);
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
