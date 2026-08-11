/**
 * Weather system facade (T6, §V7): preset switching + transition ticking.
 *
 * INTEGRATION (src/main.ts, main thread — replaces the T2 placeholder in
 * the createDebugPanel onWeatherPreset callback):
 *
 *   const weather = createWeatherSystem({
 *     setWeather: (w) => { state.weather = w; },   // §V3: sim owns the write
 *   });
 *   createDebugPanel({ onWeatherPreset: (p) => weather.apply(p) });
 *   // inside the fixed-tick sim update (§V2):
 *   weather.update(SIM_DT);
 */
import { applyWeatherPreset, type WeatherTransition } from './applyPreset';
import type { WeatherPresetName } from './presets';

export interface WeatherSystemOpts {
  /** integrator-supplied SimState.weather writer (§V3 — no state import here) */
  setWeather?: (w: WeatherPresetName) => void;
}

export interface WeatherSystem {
  /** switch preset; throws on unknown name. Replaces any running transition. */
  apply(name: string, opts?: { lerpSeconds?: number }): void;
  /** advance the active transition by dt seconds (call from the sim tick) */
  update(dt: number): void;
  /** name of the most recently applied preset */
  readonly current: WeatherPresetName;
}

export function createWeatherSystem(
  opts: WeatherSystemOpts = {},
): WeatherSystem {
  let current: WeatherPresetName = 'swell'; // matches SimState initial weather
  let transition: WeatherTransition | undefined;
  return {
    apply(name, applyOpts = {}): void {
      transition = applyWeatherPreset(name, {
        ...applyOpts,
        setWeather: opts.setWeather,
      });
      current = transition.preset;
    },
    update(dt): void {
      transition?.update(dt);
    },
    get current(): WeatherPresetName {
      return current;
    },
  };
}

export { applyWeatherPreset } from './applyPreset';
export type { WeatherTransition, ApplyPresetOpts } from './applyPreset';
export {
  weatherPresets,
  WEATHER_PRESET_NAMES,
  type WeatherPresetName,
  type PresetPatch,
} from './presets';
