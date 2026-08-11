/**
 * Weather presets (§V7): calm | swell | storm as PLAIN DATA patches over
 * other systems' params. Applying a preset is indistinguishable from turning
 * the same Tweakpane knobs (§V16) — zero special code paths, and the objects
 * here are JSON-serializable by contract (no functions, no class instances).
 *
 * All three presets patch the SAME key set (enforced by `PresetPatch` using
 * Pick, not Partial) so switching presets is fully reversible — no key is
 * ever left behind at a stale value from the previous preset.
 *
 * Value refs: docs/final-full-result.png (bright tropical, ≈calm→swell) and
 * docs/handoff.md §2 (storm: amplitude up + heavier foam bias → big patches).
 */
import { oceanParams, type OceanParams } from '../params/ocean';
import { skyParams, type SkyParams } from '../params/sky';
import { cloudParams, type CloudParams } from '../params/clouds';

/**
 * The tunables every preset must provide. `Pick` (required keys) is the
 * reversibility guarantee described above.
 */
export interface PresetPatch {
  ocean: Pick<
    OceanParams,
    'amplitude' | 'windSpeed' | 'choppiness' | 'jacobianFoamBias'
  >;
  sky: Pick<SkyParams, 'hazeStrength' | 'sunIntensity' | 'ambientIntensity'>;
  clouds: Pick<CloudParams, 'coverage' | 'sunColor' | 'skyColor'>;
}

/**
 * Keys holding packed 0xRRGGBB colors. Lerping through a hex-packed int
 * produces garbage channels, so transitions snap these at the midpoint
 * instead of interpolating (see applyPreset.ts).
 */
export const COLOR_KEYS: readonly string[] = ['sunColor', 'skyColor'];

export const weatherPresets: Readonly<
  Record<'calm' | 'swell' | 'storm', PresetPatch>
> = {
  // calm — glassy tropical morning (docs/final-full-result.png at its
  // gentlest): low energy, light breeze, foam only where waves truly fold.
  calm: {
    ocean: {
      amplitude: 0.3, // gentle rollers, no whitecaps
      windSpeed: 4, // light breeze (m/s) → short, soft spectrum
      choppiness: 0.85, // rounded crests — little horizontal pinching
      jacobianFoamBias: 0.12, // well below swell: foam only on rare true folds
    },
    sky: {
      hazeStrength: 0.45, // clear day, slight milky horizon
      sunIntensity: 3.4, // full unclouded sun
      ambientIntensity: 0.9, // bright open-sky bounce
    },
    clouds: {
      coverage: 0.25, // a few scattered fair-weather cumulus
      sunColor: 0xfff6e4, // bright warm-white sunlit cloud faces
      skyColor: 0xe6eef5, // airy pale-blue shadow sides
    },
  },

  // swell — the game's default sea state. MUST mirror the params-module
  // defaults (tests assert this) so applying it restores factory values.
  swell: {
    ocean: {
      // captured from the live params modules at import time — swell IS the
      // factory default, so ocean-tuning iterations can't desync this preset
      amplitude: oceanParams.amplitude,
      windSpeed: oceanParams.windSpeed,
      choppiness: oceanParams.choppiness,
      jacobianFoamBias: oceanParams.jacobianFoamBias,
    },
    sky: {
      hazeStrength: skyParams.hazeStrength,
      sunIntensity: skyParams.sunIntensity,
      ambientIntensity: skyParams.ambientIntensity,
    },
    clouds: {
      coverage: cloudParams.coverage,
      sunColor: cloudParams.sunColor,
      skyColor: cloudParams.skyColor,
    },
  },

  // storm — handoff.md §2: raise amplitude AND bias the Jacobian threshold
  // so far more of the surface reads as folding → massive foam patches (§V7).
  storm: {
    ocean: {
      amplitude: 2.2, // heavy seas, > 2× swell energy
      windSpeed: 18, // near-gale (m/s) → long steep spectrum
      choppiness: 1.9, // hard-pinched crests that overlap and fold
      // 0.9 meant "foam wherever the surface is compressed by 10%" (J≈1 at
      // rest) — very nearly the whole sea on ANY spectrum, which is what made
      // storm read as blobby noise. Storm's extra foam must come from the sea
      // genuinely folding more (amplitude + choppiness), not from lowering the
      // detection bar: sits just above swell's 0.55 (§V7).
      jacobianFoamBias: 0.62,
    },
    sky: {
      hazeStrength: 1.0, // horizon fully washed out in spray/mist
      sunIntensity: 1.6, // sun choked by overcast — half swell strength
      ambientIntensity: 0.55, // gloomy, low sky bounce
    },
    clouds: {
      coverage: 0.85, // near-total overcast
      sunColor: 0x8d8f94, // sunlit faces go flat grey — no warm rim
      skyColor: 0x525c68, // dark slate shadow sides
    },
  },
};

export type WeatherPresetName = keyof typeof weatherPresets;

export const WEATHER_PRESET_NAMES = Object.keys(
  weatherPresets,
) as readonly WeatherPresetName[];
