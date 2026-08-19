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
 *
 * THE BAND — WHY A GRID ALONE IS NOT A RATE LIMIT (§B.59).
 *
 * A grid quantises the VALUE. It does not bound how often the value CHANGES,
 * because the grid has an edge every `step` and a sample sitting on one
 * re-crosses it on the smallest wobble. The §V.46 field is sampled at the
 * ship's own position and is continuous in space AND time (cells drift
 * downwind at 0.6× the wind — 6.6 m/s at wind 11, so the field sweeps past a
 * ship at ANCHOR too), so it lands on an edge constantly. MEASURED, replaying
 * the shipped wiring over 805 s (the user's own cruise length) across twelve
 * headings at 5.6 m/s: the grid alone fires a MEDIAN OF 34 spectrum re-cuts,
 * worst heading 43, with runs of up to 14 back to back — and a re-cut is
 * ~0.9 s of excess main-thread work spread over its 26 ticks (measured
 * in-browser at 512²: +15-21 ms on a 27 ms frame, i.e. roughly half the frame
 * rate for the 0.43 s the build lasts). That is the reported "it accumulates
 * even with nothing on screen": nothing accumulates, the trigger just never
 * stops firing while you are under way.
 *
 * So the band is a SECOND, independent knob: `step` is how precisely the sea
 * states the weather, `band` is how far the weather must move before the sea
 * is allowed to restate it. They are decoupled on purpose — coarsening the
 * grid instead would buy the same rate cut at strictly worse precision, and
 * measurably worse WORST-case behaviour (a 2.0 m/s grid chattered 24 re-cuts
 * back to back on one leg, because a coarse grid parks a slow signal on an
 * edge for longer, not less often).
 *
 * COMMITS ARE COUPLED ACROSS KEYS, and that is worth half the remaining cost:
 * `windSpeed` and `amplitude` are BOTH spectrum-signature keys, so a rebuild
 * fires on whichever moves first and then again on the other. One commit
 * point republishes every key on its own grid at once, which is one rebuild
 * carrying two fresher values instead of two rebuilds carrying one each.
 *
 * MEASURED at the shipped 0.5 m/s / 0.02 grid — twelve 805 s legs at 5.6 m/s
 * (the user's own cruise speed) over the shipped seed, re-cuts per leg and the
 * drawn sea's Hs error against a sea that tracked the field exactly:
 *
 *     band  re-cuts/leg med / worst  longest run  Hs err mean / max  parked
 *        0          34 / 43               14      0.017 / 0.40 m       28
 *        2           8 / 14                1      0.073 / 1.12 m        8
 *        3           6 /  8                1      0.100 / 1.63 m        6   <-
 *        4           4 /  6                1      0.121 / 2.08 m        4
 *
 * and on a faster leg (9 m/s, where the hull crosses cell gradients sooner)
 * band 0's worst heading is 71 re-cuts with a run of 20 back to back, against
 * band 3's 14 and a longest run of 1. THE RUN LENGTH IS THE USER-FACING
 * NUMBER: a run is a stretch with a build permanently in flight, which is the
 * "no recovery while under way" in the report.
 *
 * THE PARKED COLUMN IS WHY THIS IS NOT PURELY A POSITION PROBLEM. A ship at
 * anchor took 28 re-cuts over the same 805 s, because the cells drift THROUGH
 * her, so the field moves even when she does not.
 *
 * 3 rather than 2 for the worst case (14 → 8 legs, 20 → 1 run length) and
 * rather than 4 because the return flattens there while the error keeps
 * growing. Coupling is free on both axes: band 3 UNcoupled measured 7 / 11 with
 * a WORSE Hs error (0.109 / 1.52), because two lanes committing separately
 * publish two staler values.
 *
 * THE TRADE, stated so it can be re-taken: at band 3 the sea does not restate
 * the weather until the wind at the hull has moved 1.5 m/s (or the amplitude
 * 0.06) from what it last committed. Sailing into a squall the sea is
 * therefore behind the rain and the flags by however long the field takes to
 * move that far — on top of the 0.70 s §B.51 already costs — and its Hs is
 * within 0.10 m of ideal on average, over 0.5 m out for 9.4% of the time, with
 * a worst excursion of 1.63 m at the steepest part of a cell edge. Sailing OUT
 * of one it is the same lag in reverse. What it is NOT is a disagreement
 * between the sea and the rig: `windSpeed` is published ONCE, and the sails,
 * the flags, the wind lines, the AI and the spectrum all read that one number,
 * so they step together and cannot drift apart.
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
  /**
   * Hysteresis, in multiples of each key's own `step`: how far the SAMPLE must
   * move from what was last published before anything is re-published. 0 (the
   * default) is the pure grid — every crossing publishes. See THE BAND above.
   */
  band = 0,
): AmbientHold<Record<K, number>> {
  const ambient = {} as Record<K, number>;
  /** the exact values we last wrote — anything else in `params` is an edit */
  const published = {} as Record<K, number | undefined>;
  for (const key of keys) ambient[key] = params[key];
  const onGrid = (key: K, v: number): number => {
    const step = steps[key];
    const base = ambient[key];
    return step > 0 ? base + Math.round((v - base) / step) * step : v;
  };
  return {
    restore(): void {
      for (const key of keys) {
        if (params[key] !== published[key]) {
          ambient[key] = params[key];
          // AN OUTSIDE EDIT ALSO CLEARS THE HYSTERESIS (§V.62). The band is
          // there to ignore the FIELD's own wobble; a preset landing or a
          // panel drag is a new ambient, and a knob that had to be turned a
          // band's width before it did anything would be the defect §V.62
          // names. Clearing the reference makes the next publish commit.
          published[key] = undefined;
        }
        params[key] = ambient[key];
      }
    },
    publish(sample): void {
      // ONE commit point for every key — see COMMITS ARE COUPLED above.
      let commit = !(band > 0);
      if (!commit) {
        for (const key of keys) {
          const v = sample[key];
          if (typeof v !== 'number' || !Number.isFinite(v)) continue;
          const last = published[key];
          // a step of 0 disables quantisation for that key, and with it the
          // band: the threshold is 0, so every tick commits (see THE STEP)
          if (last === undefined || Math.abs(v - last) >= steps[key] * band) {
            commit = true;
            break;
          }
        }
      }
      for (const key of keys) {
        const v = sample[key];
        // a non-finite sample would poison ambient on the next restore
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        params[key] = published[key] = commit
          ? onGrid(key, v)
          : (published[key] as number);
      }
    },
  };
}
