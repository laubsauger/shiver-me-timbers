/**
 * §T.209 THE RACE'S TIME OPTION → THE SKY. Boat select and free roam's pause Time row pick a `TIME_OPTIONS` label
 * (ui/boatSelect.ts); the page applies it here, at race start and on every pause change.
 *
 * A clock label ('06:30' … '17:30') sets `skyParams.timeOfDay` to that hour; the default label '15:00' is the params
 * default the page always rendered, so the default look and the T205 perf baseline hold. 'Night' writes the moonlit
 * night preset (sky/nightPreset.ts); leaving it restores what the preset replaced (the moon phase)
 * before the new hour is written. Deterministic, no clock.
 */
import { skyParams, type SkyParams } from '../../params/sky';
import { applyNightPreset, type NightPresetKeys } from '../../sky/nightPreset';

export const NIGHT_TIME = 'Night';

export function isNightTime(label: string): boolean {
  return label === NIGHT_TIME;
}

/** 'HH:MM' → decimal hour, or null for anything else */
export function raceTimeHour(label: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(label);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return hour < 24 && minute < 60 ? hour + minute / 60 : null;
}

export function applyRaceTime(label: string, sky: Pick<SkyParams, NightPresetKeys> = skyParams): void {
  const night = isNightTime(label);
  const h = night ? null : raceTimeHour(label);
  if (!night && h === null) return;
  applyNightPreset(night, sky);
  if (night) return;
  if (h !== null) sky.timeOfDay = h;
}
