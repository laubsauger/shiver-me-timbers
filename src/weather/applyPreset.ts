/**
 * Applies a weather preset (§V7) by writing values into the LIVE params
 * objects held by the registry (§V16) — the exact objects the systems read
 * and the debug panel mutates. There is no other code path: a preset switch
 * IS a batch of panel edits, nothing more (§V7 "presets only touch params").
 *
 * §V3: this module never imports SimState — the integrator passes a
 * `setWeather` callback that owns the state write.
 *
 * Systems whose params module isn't registered yet are skipped (parallel
 * tasks may not have landed); their keys apply next time the preset is set.
 */
import { getParamsEntry } from '../params/registry';
import { weatherParams } from '../params/weather';
import {
  COLOR_KEYS,
  weatherPresets,
  type WeatherPresetName,
} from './presets';

export interface ApplyPresetOpts {
  /** transition length (s); default = weatherParams.transitionSeconds */
  lerpSeconds?: number;
  /** integrator's SimState.weather writer — invoked once, at apply time */
  setWeather?: (w: WeatherPresetName) => void;
}

export interface WeatherTransition {
  readonly preset: WeatherPresetName;
  readonly done: boolean;
  /** advance the lerp; safe to keep calling after completion (no-op) */
  update(dt: number): void;
}

/** one animated param slot: live target object + key + endpoints */
interface Lane {
  params: Record<string, unknown>;
  key: string;
  from: number;
  to: number;
  /** hex-packed color → snap at midpoint instead of numeric lerp */
  color: boolean;
}

export function applyWeatherPreset(
  name: string,
  opts: ApplyPresetOpts = {},
): WeatherTransition {
  const preset = weatherPresets[name as WeatherPresetName];
  if (!preset) {
    // fail loud: a typo'd preset silently doing nothing would be worse
    throw new Error(
      `unknown weather preset "${name}" — expected one of: ` +
        Object.keys(weatherPresets).join(', '),
    );
  }
  const presetName = name as WeatherPresetName;
  const lerpSeconds = opts.lerpSeconds ?? weatherParams.transitionSeconds;

  // the discrete weather label flips at onset — the sim should know a storm
  // is rolling in even while the visuals are still lerping toward it
  opts.setWeather?.(presetName);

  const lanes: Lane[] = [];
  for (const [system, patch] of Object.entries(preset)) {
    const entry = getParamsEntry(system);
    if (!entry) continue; // system not registered (yet) — guarded skip
    for (const [key, to] of Object.entries(patch as Record<string, number>)) {
      const cur = entry.params[key];
      lanes.push({
        params: entry.params,
        key,
        // non-numeric current value → degenerate lerp (writes `to` at once)
        from: typeof cur === 'number' ? cur : to,
        to,
        color: COLOR_KEYS.includes(key),
      });
    }
  }

  let elapsed = 0;
  let done = false;
  const finish = (): void => {
    for (const lane of lanes) lane.params[lane.key] = lane.to;
    done = true;
  };
  if (lerpSeconds <= 0) finish();

  return {
    preset: presetName,
    get done(): boolean {
      return done;
    },
    update(dt: number): void {
      if (done) return;
      elapsed += dt;
      const p = Math.min(1, elapsed / lerpSeconds);
      if (p >= 1) {
        finish(); // exact targets — no float residue at the end
        return;
      }
      for (const lane of lanes) {
        lane.params[lane.key] = lane.color
          ? p >= 0.5
            ? lane.to
            : lane.from // colors snap at midpoint (never garbage blends)
          : lane.from + (lane.to - lane.from) * p; // linear → monotonic
      }
    },
  };
}
