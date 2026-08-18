/**
 * Weather system facade (T6 presets §V7, T38 localised field §V46).
 *
 * INTEGRATION (src/main.ts, main thread owns the wiring):
 *
 *   const weather = createWeatherSystem({
 *     seed: state.seed,                            // §V2 deterministic cells
 *     setWeather: (w) => { state.weather = w; },   // §V3: sim owns the write
 *   });
 *   createDebugPanel({ onWeatherPreset: (p) => weather.apply(p) });
 *
 *   // inside the fixed-tick sim update (§V2), where wind is already live:
 *   weather.update(SIM_DT);            // ticks the preset lerp AND cell drift
 *   state.weatherDrift = weather.drift;// plain {x,z}; see §V2 note below
 *
 *   // anywhere, any frame — the §V46 sampler:
 *   const here = weather.weatherAt(ship.position[0], ship.position[2], sample);
 *   here.storm     // 0..1 local storm strength (rain, audio, wave sub-noise)
 *   here.rain      // 0..1 rain density
 *   here.ocean.amplitude / .windSpeed / .choppiness / .jacobianFoamBias
 *   here.sky.hazeStrength / .sunIntensity / .ambientIntensity
 *   here.clouds.coverage / .sunColor / .skyColor
 *
 * §V2 STATE: the field is a pure function of (seed, drift, time, params). The
 * only thing that must survive a save/replay is `drift` — two plain numbers,
 * JSON-serialisable by construction. It is INTEGRATED per tick rather than
 * computed as wind·t because wind direction changes, and `wind(t)·t` would
 * teleport the entire weather map the moment it did.
 *
 * §V3: no SimState import here. The integrator passes `setWeather` and mirrors
 * `drift` into state itself.
 */
import { oceanParams } from '../params/ocean';
import { weatherParams } from '../params/weather';
import { applyWeatherPreset, type WeatherTransition } from './applyPreset';
import {
  advanceDrift,
  stormAt,
  stormCellsNear,
  type StormCell,
  type StormFieldConfig,
  type StormFieldDrift,
} from './field';
import { blendSample, createWeatherSample, type WeatherSample } from './sampler';
import { clamp01 } from './field';
import { PRESET_STORMINESS, type WeatherPresetName } from './presets';

export interface WeatherSystemOpts {
  /** integrator-supplied SimState.weather writer (§V3 — no state import here) */
  setWeather?: (w: WeatherPresetName) => void;
  /** sim seed — storm cell placement is a pure function of it (§V2) */
  seed?: number;
  /** restore a saved field drift (SimState round-trip) */
  drift?: StormFieldDrift;
}

export interface WeatherSystem {
  /** switch preset; throws on unknown name. Replaces any running transition. */
  apply(name: string, opts?: { lerpSeconds?: number }): void;
  /** advance the preset transition AND the storm-cell drift by dt (sim tick) */
  update(dt: number): void;
  /**
   * §V46 sampler: blended preset values at world XZ. Fills and returns `out`
   * (allocation-free); omit it and a shared internal sample is reused, which
   * is only safe if the caller consumes the values before sampling again.
   */
  weatherAt(x: number, z: number, out?: WeatherSample): WeatherSample;
  /**
   * 0..1 local storm strength only — cheaper when the patch is not needed.
   * The SAME scalar `weatherAt().storm` reports: the ambient preset's own
   * storminess soft-unioned with the local cell field. See the note on the
   * union in `createWeatherSystem`.
   */
  stormAt(x: number, z: number): number;
  /**
   * §V.63: the storm CELLS near (x, z), world frame, nearest first. What
   * `stormAt` is to rain density, this is to cloud PLACEMENT — a cloud has to
   * stand on a cell, and only a cell list says where one is. Fills `pool`.
   */
  stormCellsNear(
    x: number,
    z: number,
    radiusCells: number,
    pool: StormCell[],
  ): StormCell[];
  /** name of the most recently applied preset (the AMBIENT weather) */
  readonly current: WeatherPresetName;
  /** live field offset — plain {x,z}, mirror straight into SimState (§V2) */
  readonly drift: StormFieldDrift;
  /** seconds of sim time elapsed, drives the per-cell lifecycle */
  readonly time: number;
}

export function createWeatherSystem(
  opts: WeatherSystemOpts = {},
): WeatherSystem {
  let current: WeatherPresetName = 'swell'; // matches SimState initial weather
  let transition: WeatherTransition | undefined;
  const seed = Number.isFinite(opts.seed) ? (opts.seed as number) | 0 : 1;
  const drift: StormFieldDrift = {
    x: Number.isFinite(opts.drift?.x) ? (opts.drift as StormFieldDrift).x : 0,
    z: Number.isFinite(opts.drift?.z) ? (opts.drift as StormFieldDrift).z : 0,
  };
  let time = 0;
  const shared = createWeatherSample();

  /**
   * THE UNION THE CLOUD LAYER WAS MISSING (§V.63).
   *
   * `weatherAt().storm` — what rain, audio and the sea are gated on — is the
   * ambient preset's storminess SOFT-UNIONED with the local cell field
   * (sampler.ts). `stormAt` returned the bare field, so the two disagreed by
   * exactly the ambient term, and the disagreement was invisible at the
   * default preset (`swell`, 0.12) and total at the one that matters:
   * `apply('storm')` sets ambient storminess to 1, so rain went to 1
   * EVERYWHERE while every cloud in the sky kept reading the cell field —
   * mostly zero — and stayed fair-weather cumulus. A global storm preset
   * produced full rain under a fair-weather sky.
   *
   * Applied to the CELL AMPLITUDES too, not just the scalar: cell clusters are
   * both placed and shaped from `amp`, and lifting the shape sampler while
   * leaving the placement sampler bare would put a fully-formed anvil next to
   * a cumulus built from the same cell.
   *
   * Bounded in [0,1] by construction, same soft union `b + (1-b)·t` the
   * sampler uses — never a sum that could pass 1 (§V44).
   */
  const ambientUnion = (t: number): number => {
    const base = clamp01(PRESET_STORMINESS[current] ?? 0);
    return base + (1 - base) * clamp01(Number.isFinite(t) ? t : 0);
  };

  // rebuilt per sample from the LIVE panel values (§V16) — the field must
  // respond to a slider drag, and sanitizeFieldConfig re-clamps every time
  const config = (): StormFieldConfig => ({
    seed,
    cellSize: weatherParams.cellSize,
    cellRadius: weatherParams.cellRadius,
    radiusVariance: weatherParams.cellRadiusVariance,
    jitter: weatherParams.cellJitter,
    edgeSoftness: weatherParams.cellEdgeSoftness,
    coverage: weatherParams.cellCoverage,
    intensity: weatherParams.cellIntensity,
    lifecycleSeconds: weatherParams.cellLifecycleSeconds,
    lifecycleDepth: weatherParams.cellLifecycleDepth,
  });

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
      time += Number.isFinite(dt) ? Math.max(dt, 0) : 0;
      // cells drift downwind, reading the SAME wind the sea and the sails do
      // (§V47) — there is no second wind source anywhere in this system
      advanceDrift(
        drift,
        oceanParams.windDirection,
        oceanParams.windSpeed,
        weatherParams.cellDrift,
        dt,
      );
    },
    weatherAt(x, z, out = shared): WeatherSample {
      return blendSample(stormAt(x, z, drift, time, config()), current, out);
    },
    stormAt(x, z): number {
      return ambientUnion(stormAt(x, z, drift, time, config()));
    },
    stormCellsNear(x, z, radiusCells, pool): StormCell[] {
      const cells = stormCellsNear(x, z, drift, time, config(), radiusCells, pool);
      for (const cell of cells) cell.amp = ambientUnion(cell.amp);
      return cells;
    },
    get current(): WeatherPresetName {
      return current;
    },
    get drift(): StormFieldDrift {
      return drift;
    },
    get time(): number {
      return time;
    },
  };
}

export { applyWeatherPreset, resetPresetWarnings } from './applyPreset';
export type { WeatherTransition, ApplyPresetOpts } from './applyPreset';
export {
  weatherPresets,
  WEATHER_PRESET_NAMES,
  PRESET_STORMINESS,
  LAYOUT_KEYS,
  type WeatherPresetName,
  type PresetPatch,
} from './presets';
export {
  advanceDrift,
  cellAt,
  hashCell,
  makeStormCell,
  sanitizeFieldConfig,
  stormAt,
  stormCellsNear,
  type StormCell,
  type StormFieldConfig,
  type StormFieldDrift,
} from './field';
export {
  blendSample,
  createAmbientHold,
  createWeatherSample,
  type AmbientHold,
  type WeatherSample,
} from './sampler';
export {
  hazeAnisotropy,
  hazeDensityScale,
  type HazeContract,
  hazeContract,
} from './haze';
