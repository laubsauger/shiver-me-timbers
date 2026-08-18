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
      // t >= 1 snaps to `to` EXACTLY: `from + (to - from) * 1` is not `to` in
      // binary (1.0 + (0.41 − 1.0) = 0.4099999999999999), and the contract
      // "inside a full-strength cell the sea IS the storm preset" has to be
      // exact — the ambient hold publishes this value into the live params and
      // an ULP of drift there is an extra spectrum signature, i.e. an extra
      // rebuild, for a sea nobody can tell apart.
      slot[key] = COLOR_KEYS.includes(key)
        ? t >= 0.5
          ? to
          : from
        : t >= 1
          ? to
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

/**
 * THE WRITE-BACK GUARD — a §V.46 consumer that DRIVES a system must hold the
 * ambient value the field is applied to, or the field feeds on its own output.
 *
 * `blendSample`'s `from` end IS the live params object (see the header: that
 * is the whole design — ambient weather is whatever the preset lerp last
 * wrote). So a consumer that publishes the sampled value back into those SAME
 * params destroys the `from` end: next tick blends from a value that already
 * contains last tick's blend, and the geometric series walks all the way to
 * the storm preset and STAYS there. Measured on the shipped ocean wiring, a
 * CONSTANT cell at t = 0.3 — a third of a squall, never the middle of one:
 * windSpeed 11 → 13.1 → 15.6 → … → 18.0 and amplitude 0.24 → 1.15 inside 20
 * ticks (0.33 s), i.e. the full storm values; 60 ticks of clear air after it
 * brought back NEITHER. Hs 2.78 → 14.45 m for the rest of the session. Two
 * further consequences worth naming, because they do not look like this bug:
 * wind stops responding to weather at all (it is pinned at the storm value,
 * so wind→wave coupling reads as "disconnected"), and the ratchet's own
 * convergence is what finally lets the spectrum signature go quiet and fires
 * a full cascade rebuild mid-sail.
 *
 * The hold keeps ambient on the side and puts it back before each sample:
 *
 *   ambient.restore();                 // params := ambient (blend `from` end)
 *   weather.weatherAt(x, z, here);     // blends ambient → cell
 *   ambient.publish(here.ocean);       // params := blend (what systems read)
 *
 * AMBIENT'S SOURCE OF TRUTH IS STILL THE LIVE PARAMS, and it has to be:
 * a weather transition (applyPreset lerps into these objects every tick) and
 * a Tweakpane drag (§V16) are both genuine ambient changes, and §V.62 is
 * explicit that a knob which stops driving anything is a defect of its own.
 * `restore` therefore ADOPTS before it restores — any value that is not the
 * one we ourselves last published came from outside, so it becomes the new
 * ambient. The only thing the hold suppresses is its own echo.
 *
 * THE STEP — WHY A CONTINUOUS FIELD MAY NOT DRIVE A REBUILT SYSTEM CONTINUOUSLY.
 *
 * `windSpeed` and `amplitude` are both spectrum-signature keys: moving either
 * re-cuts h0 on the GPU AND on the §V.8 mirror, measured warm at the shipped
 * 512² at 394 ms + 96 ms = ~490 ms of MAIN-THREAD work. The cost is NOT the
 * FFT — it is `generateSpectrumData`, six analytic 512² passes per cascade.
 * A field sampled at the ship's own position moves on EVERY tick she is under
 * way, so published raw it would arm the ocean's rate limit forever and buy a
 * ~490 ms stall every 16 ticks. Publishing on a STEP is what makes the sea
 * answer the weather affordably: the signature genuinely goes quiet between
 * steps, so the rebuild fires once per step CROSSED rather than once per tick,
 * and the whole calm↔storm range holds only a few dozen distinct steps.
 *
 * The grid is ANCHORED AT AMBIENT, not at zero, and that is the whole reason
 * the step costs nothing anywhere else:
 *   - at t = 0 the blend IS ambient, so the published value is ambient EXACTLY
 *     — a preset lands on its authored number and a panel drag is honoured at
 *     its own 0.01 resolution (§V.62: an absolute grid would swallow every
 *     other step of that drag, which is a knob that half stops driving);
 *   - only the FIELD'S OWN EXCURSION is quantised, which is exactly the term
 *     that moves every tick;
 *   - the anchor re-registers whenever ambient does, so the step never
 *     accumulates a bias.
 * `step <= 0` disables quantisation for that key.
 */
export interface AmbientHold<S> {
  /** adopt any outside edit, then put ambient back for the blend's `from` end */
  restore(): void;
  /** publish the sampled values into the live params, remembering the echo */
  publish(sample: S): void;
}

export function createAmbientHold<K extends string>(
  keys: readonly K[],
  params: Record<K, number>,
  /** publish grid per key, in the key's own units; see THE STEP above */
  steps: Record<K, number>,
): AmbientHold<Record<K, number>> {
  const ambient = {} as Record<K, number>;
  /** the exact values we last wrote — anything else in `params` is an edit */
  const published = {} as Record<K, number | undefined>;
  for (const key of keys) ambient[key] = params[key];
  return {
    restore(): void {
      for (const key of keys) {
        if (params[key] !== published[key]) ambient[key] = params[key];
        params[key] = ambient[key];
      }
    },
    publish(sample): void {
      for (const key of keys) {
        const v = sample[key];
        // a non-finite sample would poison ambient on the next restore
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        const step = steps[key];
        const base = ambient[key];
        params[key] = published[key] =
          step > 0 ? base + Math.round((v - base) / step) * step : v;
      }
    },
  };
}
