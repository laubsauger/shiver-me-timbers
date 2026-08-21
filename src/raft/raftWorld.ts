/**
 * Raft-entry world glue (§T.98): the DAY CLOCK and the weather ceiling.
 *
 * The clock is the only thing in the project that moves `skyParams.timeOfDay`
 * on its own. It advances on the SIM tick (§V.2: a rate per real second has
 * to ride the fixed clock, not the frame), wraps at 24, and is pure in
 * `advanceClock` so the rate can be pinned by a test: 24 real minutes of
 * ticks at `dayMinutes = 24` is exactly one day. Every tick reads the params
 * object live (§V.62) — a slider moved mid-sail takes effect on the next tick.
 *
 * Nothing here imports three.js or the DOM.
 */
import { skyParams, type SkyParams } from '../params/sky';
import { raftWorldParams, type RaftWorldParams } from '../params/raftWorld';
import {
  PRESET_STORMINESS,
  WEATHER_PRESET_NAMES,
  type WeatherPresetName,
} from '../weather/presets';

/** the hour the sleeping mat wakes you at */
export const DAWN_HOUR = 6;

function fin(x: number, fallback: number): number {
  return Number.isFinite(x) ? x : fallback;
}

/** hours of sky time per real second at these params */
export function clockRate(p: RaftWorldParams = raftWorldParams): number {
  return 24 / (Math.max(1e-3, fin(p.dayMinutes, 24)) * 60);
}

/** pure: time of day after `dt` real seconds, wrapped to [0, 24) */
export function advanceClock(tod: number, dt: number, p: RaftWorldParams = raftWorldParams): number {
  const t0 = fin(tod, 0);
  if (!p.clockRunning) return t0;
  let t = (t0 + clockRate(p) * Math.max(0, fin(dt, 0))) % 24;
  if (t < 0) t += 24;
  return t;
}

export function skipToDawn(): number {
  return DAWN_HOUR;
}

/** `?tod=` wins over `startHour`; anything unparsable falls back to the param */
export function bootTimeOfDay(search: string, p: RaftWorldParams = raftWorldParams): number {
  const q = new URLSearchParams(search).get('tod');
  const v = q === null ? Number.NaN : Number(q);
  const h = Number.isFinite(v) ? v : fin(p.startHour, 7);
  return ((h % 24) + 24) % 24;
}

/** the presets the raft entry admits, in ladder order */
export function raftWeatherPresets(p: RaftWorldParams = raftWorldParams): WeatherPresetName[] {
  return WEATHER_PRESET_NAMES.filter((n) => PRESET_STORMINESS[n] <= p.maxStorminess);
}

/** a preset the raft will sail in: the one asked for, or the fallback if it is too stormy */
export function calmPreset(name: string, p: RaftWorldParams = raftWorldParams): WeatherPresetName {
  const n = name as WeatherPresetName;
  const s = PRESET_STORMINESS[n];
  if (s === undefined || s > p.maxStorminess) return p.defaultPreset;
  return n;
}

export interface DayClock {
  /** one sim tick of `dt` seconds */
  tick(dt: number): void;
  skipToDawn(): void;
  set(hour: number): void;
  readonly hour: number;
}

export function createDayClock(p: RaftWorldParams = raftWorldParams, sky: SkyParams = skyParams): DayClock {
  return {
    tick(dt) {
      sky.timeOfDay = advanceClock(sky.timeOfDay, dt, p);
    },
    skipToDawn() {
      sky.timeOfDay = skipToDawn();
    },
    set(hour) {
      sky.timeOfDay = ((fin(hour, 0) % 24) + 24) % 24;
    },
    get hour() {
      return sky.timeOfDay;
    },
  };
}
