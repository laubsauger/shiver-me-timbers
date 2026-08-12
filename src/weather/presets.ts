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
import {
  CLOUD_LAYOUT_KEYS,
  cloudParams,
  type CloudParams,
} from '../params/clouds';

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
  /**
   * §V11b: a storm sky must read as a MONUMENT — anvil/mushroom forms with
   * internal structure, sitting ON the horizon — and calm as scattered
   * fair-weather cumulus. Those are the same generator at different numbers
   * (`silhouetteRadius()` in src/clouds/cloudCores.ts), so the silhouette
   * family belongs in the preset patch: without it, storm could only turn
   * cumulus grey, which is the "procedurally plausible" failure §V43 rejects.
   * Keeping it in params also keeps §V7 intact — still no storm code path.
   */
  clouds: Pick<
    CloudParams,
    | 'coverage'
    | 'sunColor'
    | 'skyColor'
    | 'clusterCount'
    | 'ringInner'
    | 'ringOuter'
    | 'altitudeMin'
    | 'altitudeMax'
    | 'clusterRadiusMin'
    | 'clusterRadiusMax'
    | 'clusterFlatten'
    | 'clusterHeight'
    | 'heightBias'
    | 'lobeScaleMin'
    | 'lobeScaleMax'
    | 'domeExponent'
    | 'waistWidth'
    | 'waistHeight'
    | 'anvilStart'
    | 'capRound'
    | 'anvilSpread'
  >;
}

/**
 * Preset keys whose lerp forces a CPU rebuild of the cloud lobe set
 * (src/clouds gates regeneration on `cloudLayoutKey`). Lerped continuously,
 * a 4-second transition would regenerate ~400 lobes on all ~240 frames of it.
 * applyPreset quantises the progress of these lanes instead, so the sky
 * reshapes in a handful of visible steps and rebuilds a handful of times.
 * Derived from the clouds module's own list — it cannot drift out of sync.
 */
export const LAYOUT_KEYS: readonly string[] = CLOUD_LAYOUT_KEYS as string[];

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
      // §V11b semantics: `coverage` is PER-LOBE density on near-opaque
      // polygonal cores, so an open sky comes from FEWER CLUSTERS, not from a
      // low coverage. The old 0.25 was tuned for accumulating billboards and
      // now just renders every lobe translucent — solid form, ghosted.
      coverage: 0.8,
      clusterCount: 6, // scattered: this is what opens the sky, not coverage
      ringInner: 900,
      ringOuter: 2600,
      altitudeMin: 380, // fair-weather cumulus ride high
      altitudeMax: 680,
      clusterRadiusMin: 140, // small, discrete puffs
      clusterRadiusMax: 260,
      clusterFlatten: 1.45, // distinctly wider than tall
      clusterHeight: 0.75, // no towers
      heightBias: 1.8, // lobes packed low → the flat cumulus base
      lobeScaleMin: 0.18,
      lobeScaleMax: 0.32,
      domeExponent: 2, // rounded cauliflower top
      waistWidth: 0.95, // no stalk
      waistHeight: 0.75,
      anvilStart: 0.8,
      capRound: 0.9,
      anvilSpread: 0, // no anvil at all
      sunColor: 0xfff6e4, // bright warm-white sunlit cloud faces
      // NOT the old near-white 0xe6eef5: sun + sky are SUMMED
      // (color = sunColor*R + skyColor*G), and two near-whites clip past 1.0
      // on both faces, which is what flattened the clouds into blobs. The
      // skylight term has to sit clearly darker and bluer than the sun term.
      skyColor: 0x6699cc,
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
      clusterCount: cloudParams.clusterCount,
      ringInner: cloudParams.ringInner,
      ringOuter: cloudParams.ringOuter,
      altitudeMin: cloudParams.altitudeMin,
      altitudeMax: cloudParams.altitudeMax,
      clusterRadiusMin: cloudParams.clusterRadiusMin,
      clusterRadiusMax: cloudParams.clusterRadiusMax,
      clusterFlatten: cloudParams.clusterFlatten,
      clusterHeight: cloudParams.clusterHeight,
      heightBias: cloudParams.heightBias,
      lobeScaleMin: cloudParams.lobeScaleMin,
      lobeScaleMax: cloudParams.lobeScaleMax,
      domeExponent: cloudParams.domeExponent,
      waistWidth: cloudParams.waistWidth,
      waistHeight: cloudParams.waistHeight,
      anvilStart: cloudParams.anvilStart,
      capRound: cloudParams.capRound,
      anvilSpread: cloudParams.anvilSpread,
      sunColor: cloudParams.sunColor,
      skyColor: cloudParams.skyColor,
    },
  },

  // storm — handoff.md §2: raise amplitude AND bias the Jacobian threshold
  // so far more of the surface reads as folding → massive foam patches (§V7).
  storm: {
    ocean: {
      /**
       * 2.2 → 1.15. TWO agents measured this independently and reached the
       * same verdict from opposite ends: the ocean agent found Hs = 20.4 m
       * (7× swell, worse than the worst recorded North Atlantic sea, with
       * 20.07 m of it in cascade 0 alone — only two wavelengths per 420 m
       * tile, which is also a §V.19 tiling exposure), and the sea-physics
       * agent independently measured Hs ≈ 22 m and the hull fully clear of
       * the water 8–14% of ticks.
       *
       * It was the cause of TWO separate user reports — crests "crossing over,
       * twisting… bulgy over-cresting" (waves too big for the vertex spacing
       * to carry, NOT a choppiness fold: the λ clamp was verified working and
       * storm's effective λ is 0.94, below swell's 0.95) and the ship
       * "catching airtime… too light". A 35 m hull with 2.6 m of freeboard in
       * a 20 m sea is not a sailing scenario; the physics was right and the
       * sea was wrong.
       *
       * 1.15 lands near Hs 8–10 m — a genuine gale a galleon can survive and
       * be filmed in. One number, and it is the whole revert if a bigger sea
       * is wanted for a shot.
       */
      amplitude: 1.15,
      windSpeed: 18, // near-gale (m/s) → long steep spectrum
      choppiness: 1.9, // hard-pinched crests that overlap and fold
      // 0.9 meant "foam wherever the surface is compressed by 10%" (J≈1 at
      // rest) — very nearly the whole sea on ANY spectrum, which is what made
      // storm read as blobby noise. Storm's extra foam must come from the sea
      // genuinely folding more (amplitude + choppiness), not from lowering the
      // detection bar (§V7).
      //
      // RETUNED 2026-08-12 (the parked note below is now DISCHARGED — the
      // choppiness clamp landed, the verdict came back "storm is NOT folding",
      // and storm's amplitude was cut from Hs≈20 m to ≈8–10 m). Measured
      // instantaneous fold fraction on the realised storm spectrum, with the
      // λ− gate the foam sim now uses (src/foam/foamMath, "THE FOLD METRIC"):
      //
      //   bias   z      per band              union of the three
      //   0.62   0.74   20.0 / 23.9 / 19.1 %  50.8 %   ← was shipping this
      //   0.40   1.17   11.9 / 16.5 / 12.6 %  35.7 %
      //   0.25   1.47    7.8 / 12.4 /  9.4 %  26.8 %   ← now
      //   0.00   1.96    3.7 /  7.3 /  5.4 %  15.5 %
      //
      // Swell's union at its own 0.55 is 8.7 %, so 0.25 puts storm at ≈3× the
      // coverage of swell. That is the read in docs/ref-storm-whitecaps.png —
      // breaking faces and streaks with dark water still visible BETWEEN them.
      // 0.62 put half the sea over the gate every frame, and foam accumulates,
      // so it saturated to an unbroken white sheet ("blobby noise", "milk").
      //
      // PARKED NOTE, kept for the reasoning it records: the obvious move used
      // to be blocked because a surface whose choppy displacement has gone
      // non-monotonic has a folded jacobian over large areas BY DEFINITION,
      // and lowering this number would have hidden an ocean-side defect inside
      // a foam threshold — §V44's "bound it at the source" applied to the
      // fold: a fold cannot be un-folded downstream. That defect is fixed at
      // the source now (effective λ 1.9 → 1.30), which is what makes this
      // retune a tuning change and not a cover-up.
      jacobianFoamBias: 0.25,
    },
    sky: {
      hazeStrength: 1.0, // horizon fully washed out in spray/mist
      sunIntensity: 1.6, // sun choked by overcast — half swell strength
      ambientIntensity: 0.55, // gloomy, low sky bounce
    },
    // §V11b storm sky: the anvil monument, validated by the clouds agent and
    // pinned in tests/clouds.test.ts. This mass spans y ≈ 155–2050 m at
    // 2.2–3.6 km out — it SITS ON THE HORIZON, which is the "Clouds: Concept"
    // read, and is why the placement ring moves out and the base drops.
    clouds: {
      coverage: 1, // per-lobe density: a storm cell is solid
      clusterCount: 7, // fewer, far bigger masses
      ringInner: 2200, // pushed out to the horizon
      ringOuter: 3600,
      altitudeMin: 120, // low, heavy base
      altitudeMax: 260,
      clusterRadiusMin: 420, // each cluster is a monument, not a puff
      clusterRadiusMax: 720,
      clusterFlatten: 1, // vertical development, not a pancake
      clusterHeight: 2.6, // towers: >1 is what builds height
      heightBias: 1, // lobes spread evenly up the tower, not pooled at base
      lobeScaleMin: 0.13, // smaller lobes over a bigger mass = more structure
      lobeScaleMax: 0.24,
      domeExponent: 8, // flat-topped, not domed
      waistWidth: 0.42, // the anvil stalk
      waistHeight: 0.55,
      anvilStart: 0.55, // cap flares from just above the waist
      capRound: 0.95,
      anvilSpread: 1.2, // full mushroom overhang
      sunColor: 0xb9b2ae, // sunlit faces go flat grey — no warm rim
      skyColor: 0x2e3a4a, // dark slate shadow sides
    },
  },
};

export type WeatherPresetName = keyof typeof weatherPresets;

/**
 * How stormy each preset is on its own, 0..1 (§V46). This is the AMBIENT
 * level the localised field builds on: with 'swell' applied globally you get
 * a light working sea everywhere plus squalls where the field says so, and
 * with 'storm' applied globally the whole world is already at 1 and the field
 * can add nothing (soft union — see sampler.ts).
 *
 * Still pure preset data (§V7): nothing here is written into any params
 * object, it only says how strongly the storm END of the vocabulary is
 * already in effect.
 */
export const PRESET_STORMINESS: Readonly<Record<WeatherPresetName, number>> = {
  calm: 0,
  // a working sea, not a storm: enough that the ocean/audio can tell swell
  // from glass, far below the rain threshold so a default day stays dry
  swell: 0.12,
  storm: 1,
};

export const WEATHER_PRESET_NAMES = Object.keys(
  weatherPresets,
) as readonly WeatherPresetName[];
