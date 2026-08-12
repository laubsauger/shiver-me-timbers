/**
 * `weatherAt(x, z)` — the §V46 sampler (§T.38).
 *
 * Consumers (ocean amplitude/wind, sky haze/light, clouds coverage/form, rain,
 * audio) ask "what is the weather HERE" instead of reading one global preset.
 * What comes back is a blend of PRESET VALUES, so §V7 still holds exactly:
 * presets remain the whole vocabulary and no code path forks — only the
 * strength of a preset is now position-dependent.
 *
 * THE TWO ENDS OF THE BLEND
 *  - base = the LIVE params objects, i.e. whatever the global preset lerp
 *    (applyPreset.ts) has written. This is the ambient weather.
 *  - cell = the storm preset patch.
 *  - t    = the localised field strength at (x, z), 0..1.
 *
 * Because base is the live params rather than a named preset, applying 'storm'
 * globally makes base === cell and the blend collapses to the identity: a
 * global storm is a storm everywhere, and cells cannot double-count it. The
 * reported `storm` scalar handles that case through a soft union with the
 * ambient preset's own storminess, so it saturates at 1 instead of exceeding it.
 *
 * Colours (§V31 keys in COLOR_KEYS) SNAP at the halfway point rather than
 * lerping — a hex-packed 0xRRGGBB interpolated as an integer is garbage
 * channels, the same rule applyPreset.ts follows for transitions.
 *
 * Allocation: `weatherAt` fills a caller-owned `out` object. It runs per frame
 * for several consumers; a fresh object graph each call would be pure GC churn.
 */
import { getParamsEntry } from '../params/registry';
import { weatherParams } from '../params/weather';
import { oceanParams } from '../params/ocean';
import { skyParams } from '../params/sky';
import { cloudParams } from '../params/clouds';
import { clamp01, smoothstep } from './field';
import {
  COLOR_KEYS,
  PRESET_STORMINESS,
  weatherPresets,
  type PresetPatch,
  type WeatherPresetName,
} from './presets';

export interface WeatherSample {
  /**
   * 0..1 local storm strength: ambient preset storminess soft-unioned with
   * the local cell field. This is the scalar to drive anything that is not a
   * preset key — rain density, audio beds, storm-wave sub-noise.
   */
  storm: number;
  /** 0..1 rain density here — `storm` gated by rainThreshold..rainFull */
  rain: number;
  ocean: PresetPatch['ocean'];
  sky: PresetPatch['sky'];
  clouds: PresetPatch['clouds'];
}

/** fallback live-params objects, used when the registry has no entry yet */
const FALLBACK_PARAMS: Record<string, Record<string, unknown>> = {
  ocean: oceanParams as unknown as Record<string, unknown>,
  sky: skyParams as unknown as Record<string, unknown>,
  clouds: cloudParams as unknown as Record<string, unknown>,
};

/**
 * A zeroed sample shaped like the presets — build one per consumer and reuse
 * it. Shape is derived from the preset data so a new preset key cannot be
 * forgotten here.
 */
export function createWeatherSample(): WeatherSample {
  const shape = weatherPresets.storm;
  const out = { storm: 0, rain: 0 } as unknown as Record<string, unknown>;
  for (const [system, patch] of Object.entries(shape)) {
    const dst: Record<string, number> = {};
    for (const key of Object.keys(patch as Record<string, number>)) dst[key] = 0;
    out[system] = dst;
  }
  return out as unknown as WeatherSample;
}

/** the live params object for a system — registry first (§V16), module second */
function liveParams(system: string): Record<string, unknown> {
  return getParamsEntry(system)?.params ?? FALLBACK_PARAMS[system] ?? {};
}

/**
 * Blend the live params toward the storm preset by `cellStorm`, and report the
 * combined storm/rain scalars. Pure given (cellStorm, ambient, live params).
 *
 * `ambient` is the globally applied preset name; its storminess is what the
 * cell field adds on top of.
 */
export function blendSample(
  cellStorm: number,
  ambient: WeatherPresetName,
  out: WeatherSample,
): WeatherSample {
  const t = clamp01(Number.isFinite(cellStorm) ? cellStorm : 0);
  const target = weatherPresets.storm;
  const dst = out as unknown as Record<string, Record<string, number>>;

  for (const [system, patch] of Object.entries(target)) {
    const live = liveParams(system);
    const slot = dst[system] ?? (dst[system] = {});
    for (const [key, to] of Object.entries(patch as Record<string, number>)) {
      const cur = live[key];
      // a non-numeric live value (system not registered / key missing) has no
      // meaningful blend — take the preset value rather than emit NaN
      const from = typeof cur === 'number' && Number.isFinite(cur) ? cur : to;
      slot[key] = COLOR_KEYS.includes(key)
        ? t >= 0.5
          ? to
          : from
        : from + (to - from) * t;
    }
  }

  // soft union with the ambient preset's own storminess: bounded to [0,1] by
  // construction, so a global storm plus a cell still reads as 1, not 1.6
  const base = clamp01(PRESET_STORMINESS[ambient] ?? 0);
  const storm = base + (1 - base) * t;
  out.storm = storm;
  out.rain = smoothstep(
    weatherParams.rainThreshold,
    weatherParams.rainFull,
    storm,
  );
  return out;
}
