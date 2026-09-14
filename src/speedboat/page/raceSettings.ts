/**
 * RACE SETTINGS PERSISTENCE + THE TWO ASSIST SHAPES (§T.185 pause → §T.182 controls, §V21 settings survive reload).
 *
 * Persisted under `speedboat.settings.v1`: the pause screen's assists, camera, HUD size and audio levels, and the
 * last boat selection. Storage is a per-viewer convenience, never load-bearing: every read and write is wrapped
 * (private windows, blocked site data and quota errors throw on access), and a missing, corrupt or partial record
 * falls back field by field to the defaults, so the page always boots into a valid race.
 *
 * TWO ASSIST SHAPES. The pause screen speaks `ui/pause` AssistSettings (preset, governor 'off|air|full',
 * landingAssist, steeringLock on/off, autoReset); the controls read `speedboat/assists` AssistSettings
 * (speedLimitedLock 0..1, helmRateDegPerS, governor 'OFF|AIR|FULL', landingAssist, autoReset). The UI value is
 * AUTHORITATIVE for the fields it shows (what the pilot sees is what the boat does); the helm rate is not an assist
 * (assists/settings.ts) and is kept from the controls. Mismatch reported: the UI's Pro preset keeps auto reset ON
 * (design doc §3 "auto reset stays on in both") while `assists` ASSIST_PRESETS.pro has autoReset false.
 */
import type { Volumes } from '../../audio/engine';
import { radioBusLevel } from '../../audio/boat/radioBus';
import type { AssistSettings as ControlAssists, GovernorMode as ControlGovernor } from '../assists/settings';
import { ASSIST_PRESETS as UI_PRESETS, type AssistSettings as UiAssists, type AudioSettings } from '../ui/pause';
import { DEFAULT_SELECTION, SEA_OPTIONS, TIME_OPTIONS, RIVAL_OPTIONS, type BoatSelection } from '../ui/boatSelect';
import { COMMUNITY_PAINTS, GOGGLES } from '../ui/roster';
import { HUD_SCALES } from '../ui/layout';
import type { GovernorMode as UiGovernor, HudCamera } from '../ui/model';

export const RACE_SETTINGS_KEY = 'speedboat.settings.v1';

export interface RaceSettings {
  assists: UiAssists;
  camera: HudCamera;
  hudScale: number;
  audio: AudioSettings;
  lastSelection: BoatSelection | null;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const DEFAULT_AUDIO: Readonly<AudioSettings> = Object.freeze({ master: 0.8, engines: 0.9, radio: 0.7, music: 0.5 });

export function defaultRaceSettings(): RaceSettings {
  return {
    assists: { preset: 'default', ...UI_PRESETS.default },
    camera: 'chase',
    hudScale: 1,
    audio: { ...DEFAULT_AUDIO },
    lastSelection: null,
  };
}

/** `window.localStorage`, or null where touching it throws (sandboxed frames, blocked storage) */
export function browserStore(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const num01 = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);
const oneOf = <T>(list: readonly T[], v: unknown, d: T): T => (list.includes(v as T) ? (v as T) : d);

/** field-by-field validation: a stored value only survives if it is one the screens can show */
export function sanitizeRaceSettings(raw: unknown): RaceSettings {
  const d = defaultRaceSettings();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  const a = (r.assists ?? {}) as Record<string, unknown>;
  d.assists = {
    preset: oneOf(['default', 'pro', 'custom'] as const, a.preset, d.assists.preset),
    governor: oneOf(['off', 'air', 'full'] as const, a.governor, d.assists.governor),
    landingAssist: num01(a.landingAssist, d.assists.landingAssist),
    steeringLock: typeof a.steeringLock === 'boolean' ? a.steeringLock : d.assists.steeringLock,
    autoReset: typeof a.autoReset === 'boolean' ? a.autoReset : d.assists.autoReset,
  };
  d.camera = oneOf(['chase', 'near', 'cockpit'] as const, r.camera, d.camera);
  d.hudScale = oneOf(HUD_SCALES.map((s) => s.scale as number), r.hudScale, d.hudScale);
  const au = (r.audio ?? {}) as Record<string, unknown>;
  d.audio = { master: num01(au.master, DEFAULT_AUDIO.master), engines: num01(au.engines, DEFAULT_AUDIO.engines), radio: num01(au.radio, DEFAULT_AUDIO.radio), music: num01(au.music, DEFAULT_AUDIO.music) };
  const s = r.lastSelection as Record<string, unknown> | null | undefined;
  if (s && typeof s === 'object') {
    d.lastSelection = {
      paintId: oneOf(COMMUNITY_PAINTS.map((p) => p.id), s.paintId, DEFAULT_SELECTION.paintId),
      number: typeof s.number === 'number' && Number.isInteger(s.number) && s.number >= 1 && s.number <= 99 ? s.number : DEFAULT_SELECTION.number,
      gogglesId: oneOf(GOGGLES.map((g) => g.id), s.gogglesId, DEFAULT_SELECTION.gogglesId),
      sea: oneOf(SEA_OPTIONS as readonly string[], s.sea, DEFAULT_SELECTION.sea),
      time: oneOf(TIME_OPTIONS as readonly string[], s.time, DEFAULT_SELECTION.time),
      rivals: oneOf(RIVAL_OPTIONS as readonly string[], s.rivals, DEFAULT_SELECTION.rivals),
    };
  }
  return d;
}

export function loadRaceSettings(store: KeyValueStore | null = browserStore()): RaceSettings {
  if (!store) return defaultRaceSettings();
  try {
    const text = store.getItem(RACE_SETTINGS_KEY);
    return text === null ? defaultRaceSettings() : sanitizeRaceSettings(JSON.parse(text));
  } catch {
    return defaultRaceSettings();
  }
}

/** returns false when the store refused (the page carries on with the in-memory settings) */
export function saveRaceSettings(s: Readonly<RaceSettings>, store: KeyValueStore | null = browserStore()): boolean {
  if (!store) return false;
  try {
    store.setItem(RACE_SETTINGS_KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}

// ── assists: UI ⇄ controls ─────────────────────────────────────────────────────────────────────

const GOV_UP: Record<UiGovernor, ControlGovernor> = { off: 'OFF', air: 'AIR', full: 'FULL' };
const GOV_DOWN: Record<ControlGovernor, UiGovernor> = { OFF: 'off', AIR: 'air', FULL: 'full' };

/** write the pause screen's assists into the live controls settings object (mutated in place: the tick reads it) */
export function applyUiAssists(ui: Readonly<UiAssists>, controls: ControlAssists): void {
  controls.governor = GOV_UP[ui.governor];
  controls.landingAssist = ui.landingAssist;
  controls.speedLimitedLock = ui.steeringLock ? 1 : 0;
  controls.autoReset = ui.autoReset;
}

/** the controls' assists as the pause screen shows them (preset matched against the UI's own table) */
export function uiAssistsFrom(c: Readonly<ControlAssists>): UiAssists {
  const a: UiAssists = {
    preset: 'custom',
    governor: GOV_DOWN[c.governor],
    landingAssist: c.landingAssist,
    steeringLock: c.speedLimitedLock >= 0.5,
    autoReset: c.autoReset,
  };
  for (const p of ['default', 'pro'] as const) {
    const q = UI_PRESETS[p];
    if (a.governor === q.governor && a.landingAssist === q.landingAssist && a.steeringLock === q.steeringLock && a.autoReset === q.autoReset) a.preset = p;
  }
  return a;
}

/**
 * Pause audio levels → the audio engine's buses (`AudioEngine.setVolumes`). Boat engine + hull audio sits on the sfx
 * bus (audio/boat/boatAudio.ts), so 'engines' drives sfx. 'radio' is NOT an engine bus: see `radioLevel`.
 */
export function engineVolumes(a: Readonly<AudioSettings>): Partial<Volumes> {
  return { master: a.master, sfx: a.engines, music: a.music };
}

/**
 * Pause audio levels → the race radio bus (§T.197, audio/boat/radioBus.ts `RadioBus.setLevel`): master × radio. The
 * radio bus sits beside the engine's buses (their master gain is not exposed), so master is folded in here.
 */
export function radioLevel(a: Readonly<AudioSettings>): number {
  return radioBusLevel(a.master, a.radio);
}

/** boat-select sea option → weather preset name (weather/presets.ts) */
export const SEA_PRESET: Readonly<Record<string, string>> = Object.freeze({ Calm: 'calm', Breeze: 'breeze', 'Working sea': 'swell', Squall: 'squall' });
