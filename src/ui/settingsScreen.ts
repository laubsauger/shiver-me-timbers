/**
 * Settings screen inside the pause panel (§V21: graphics res-scale/quality +
 * audio volumes, written live to the persisted settings store). Sliders are
 * rope tracks with brass knobs; quality is a segmented brass control.
 */
import type { GameSettings, Quality, SettingsStore } from './settingsStore';
import { button, div, el } from './dom';

export interface SettingsScreen {
  root: HTMLElement;
  focusFirst(): void;
  dispose(): void;
}

interface SliderSpec {
  label: string;
  min: number;
  max: number;
  step: number;
  read: (s: GameSettings) => number;
  write: (store: SettingsStore, v: number) => void;
}

function makeSlider(store: SettingsStore, spec: SliderSpec): { row: HTMLElement; sync: (s: GameSettings) => void } {
  const value = el('span', 'smt-row-value');
  const input = el('input', 'smt-range');
  input.type = 'range';
  input.min = String(spec.min);
  input.max = String(spec.max);
  input.step = String(spec.step);
  const fmt = (v: number) => `${Math.round(v * 100)}%`;
  const sync = (s: GameSettings) => {
    const v = spec.read(s);
    input.value = String(v);
    value.textContent = fmt(v);
  };
  input.addEventListener('input', () => spec.write(store, Number(input.value)));
  sync(store.get());
  const row = div('smt-row', div('smt-row-top', el('span', 'smt-row-label', spec.label), value), input);
  return { row, sync };
}

export function createSettingsScreen(store: SettingsStore, onBack: () => void): SettingsScreen {
  const backBtn = button('smt-back-btn', '‹ Back');
  backBtn.addEventListener('click', onBack);
  const head = div('smt-settings-head', el('h2', 'smt-settings-title', 'Settings'), backBtn);

  // — tabs —
  const graphicsTab = button('smt-tab is-active', 'Graphics');
  const audioTab = button('smt-tab', 'Audio');
  const tabs = div('smt-tabs', graphicsTab, audioTab);

  // — graphics rows —
  const resSlider = makeSlider(store, {
    label: 'Resolution scale', min: 0.5, max: 1, step: 0.05,
    read: (s) => s.graphics.resolutionScale,
    write: (st, v) => st.set({ graphics: { resolutionScale: v } }),
  });
  const qualityBtns = new Map<Quality, HTMLButtonElement>();
  const seg = div('smt-seg');
  for (const q of ['low', 'medium', 'high'] as const) {
    const b = button('smt-seg-btn', q.charAt(0).toUpperCase() + q.slice(1));
    b.addEventListener('click', () => store.set({ graphics: { quality: q } }));
    qualityBtns.set(q, b);
    seg.appendChild(b);
  }
  const qualityRow = div('smt-row', div('smt-row-top', el('span', 'smt-row-label', 'Quality')), seg);
  const graphicsRows = div('smt-rows', resSlider.row, qualityRow);

  // — audio rows —
  const audioSliders = (
    [
      ['Master', (s: GameSettings) => s.audio.master, 'master'],
      ['Effects', (s: GameSettings) => s.audio.sfx, 'sfx'],
      ['Ambience', (s: GameSettings) => s.audio.ambience, 'ambience'],
    ] as const
  ).map(([label, read, key]) =>
    makeSlider(store, {
      label, min: 0, max: 1, step: 0.01, read,
      write: (st, v) => st.set({ audio: { [key]: v } }),
    }),
  );
  const audioRows = div('smt-rows', ...audioSliders.map((s) => s.row));
  audioRows.style.display = 'none';

  function selectTab(which: 'graphics' | 'audio'): void {
    graphicsTab.classList.toggle('is-active', which === 'graphics');
    audioTab.classList.toggle('is-active', which === 'audio');
    graphicsRows.style.display = which === 'graphics' ? '' : 'none';
    audioRows.style.display = which === 'audio' ? '' : 'none';
  }
  graphicsTab.addEventListener('click', () => selectTab('graphics'));
  audioTab.addEventListener('click', () => selectTab('audio'));

  // reflect store changes (quality highlight + slider positions)
  const sync = (s: GameSettings): void => {
    for (const [q, b] of qualityBtns) b.classList.toggle('is-active', q === s.graphics.quality);
    resSlider.sync(s);
    for (const sl of audioSliders) sl.sync(s);
  };
  sync(store.get());
  const unsubscribe = store.subscribe(sync);

  const root = div('smt-settings', head, tabs, graphicsRows, audioRows);
  return {
    root,
    focusFirst: () => backBtn.focus(),
    dispose: () => unsubscribe(),
  };
}
