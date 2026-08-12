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
  LAYOUT_KEYS,
  weatherPresets,
  type WeatherPresetName,
} from './presets';

/**
 * Systems already warned about, so a preset switch every few seconds does not
 * spam the console — but the FIRST miss is always reported (§B.18).
 */
const warnedMissing = new Set<string>();

/**
 * Test/HMR helper — forget which systems have already been warned about, so a
 * fresh registry starts from a clean slate (same role as clearParamsRegistry).
 */
export function resetPresetWarnings(): void {
  warnedMissing.clear();
}

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
  /** feeds a CPU layout rebuild → quantise the lerp instead of running it smooth */
  layout: boolean;
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
    if (!entry) {
      // §B.18: this skip stayed silent for the entire project while every
      // cloud value in every preset went nowhere — src/params/clouds.ts had
      // never registered. The skip must remain non-fatal (parallel param
      // modules genuinely may not have landed yet), but it must never again
      // be INVISIBLE. Anything a preset names and cannot find is reported.
      if (!warnedMissing.has(system)) {
        warnedMissing.add(system);
        console.warn(
          `[weather] preset "${name}" patches "${system}", but no params ` +
            `module registered under that name — every ${system} value in ` +
            `every preset is being silently dropped. Check that ` +
            `src/params/${system}.ts calls registerParams('${system}', …) ` +
            `and that it is imported before the first preset apply (§B.18).`,
        );
      }
      continue;
    }
    for (const [key, to] of Object.entries(patch as Record<string, number>)) {
      const cur = entry.params[key];
      // a key the preset names but the params module does not have is the
      // same class of silent drop, one level down — the write would create a
      // dead property the system never reads
      if (!(key in entry.params) && !warnedMissing.has(`${system}.${key}`)) {
        warnedMissing.add(`${system}.${key}`);
        console.warn(
          `[weather] preset "${name}" sets ${system}.${key}, which is not a ` +
            `key of the registered ${system} params — it will be written but ` +
            `never read (§B.18).`,
        );
      }
      lanes.push({
        params: entry.params,
        key,
        // non-numeric current value → degenerate lerp (writes `to` at once)
        from: typeof cur === 'number' ? cur : to,
        to,
        color: COLOR_KEYS.includes(key),
        layout: LAYOUT_KEYS.includes(key),
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
      // Layout lanes drive a CPU rebuild of the cloud lobe set on any frame
      // their value moves. Lerped smoothly, a 4 s transition regenerates ~400
      // lobes on every one of ~240 frames; quantised to N steps it does so N
      // times, for a reshape that still reads as continuous. The value is
      // still a true lerp — only its PROGRESS is stepped.
      const steps = Math.max(1, Math.floor(weatherParams.layoutLerpSteps) || 1);
      const pLayout = Math.round(p * steps) / steps;
      for (const lane of lanes) {
        const t = lane.layout ? pLayout : p;
        lane.params[lane.key] = lane.color
          ? p >= 0.5
            ? lane.to
            : lane.from // colors snap at midpoint (never garbage blends)
          : lane.from + (lane.to - lane.from) * t; // linear → monotonic
      }
    },
  };
}
