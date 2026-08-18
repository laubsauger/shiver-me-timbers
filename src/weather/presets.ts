/**
 * Weather presets (§V7): a SEVEN-RUNG LADDER of PLAIN DATA patches over other
 * systems' params. Applying a preset is indistinguishable from turning the
 * same Tweakpane knobs (§V16) — zero special code paths, and the objects here
 * are JSON-serializable by contract (no functions, no class instances).
 *
 * Every preset patches the SAME key set (enforced by `PresetPatch` using Pick,
 * not Partial) so switching presets is fully reversible — no key is ever left
 * behind at a stale value from the previous preset.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THESE ARE NOT THE SEA-STATE LADDER, AND THE DIFFERENCE IS THE POINT.
 *
 * `src/ui/settingsStore.ts` carries `SEA_STATES` — nine Beaufort rungs from
 * `glass` to `f8` that write FOUR OCEAN KEYS and nothing else. That ladder is
 * the player's fine trim on WAVE HEIGHT: it is continuous underneath (the
 * settings screen's sliders), it never touches the sky, and a rung is just a
 * convenient place to stop on the way.
 *
 * The presets here are WEATHER. A rung moves ocean + sky + clouds + the §V.46
 * storminess field together, so it changes what the day IS rather than how big
 * the waves are. It is deliberately coarser — seven whole-sky states against
 * nine wave heights — because there is no useful sky difference between
 * Beaufort 4 and Beaufort 5, while there is an enormous one between a working
 * breeze and a squall.
 *
 * The two ladders AGREE where they overlap and are checked against each other
 * (tests/weather.test.ts): both are measured in Hs off the same live spectrum,
 * both are anchored on Beaufort, and neither writes a bearing. They meet at the
 * top — `storm` below lands on Hs 9.60 m against the sea-state ladder's own
 * recalibrated top rung at 9.58 m — which is the whole reason the 14.70 m
 * version of `storm` had to go (see the rung).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE LADDER, MEASURED. `Hs = 4√m₀` summed over the three cascades off the
 * shipped spectrum, exactly as tests/ui.test.ts measures `SEA_STATES`; `z` is
 * the §V36 foam bar in multiples of each rung's OWN σ(det J) — SMALLER z means
 * more of the sea foams, and it is the only honest ordering of foaminess
 * (`jacobianFoamBias` is not a proxy for it — see `foamRarity` in the tests).
 *
 *   rung     wind   Beaufort            Hs (m)   step    z     storminess
 *   glass     1.0   1 light air          0.008    —     53.1     0
 *   calm      4.0   3 gentle breeze      1.225    —      7.06    0
 *   breeze    8.5   5 fresh breeze       2.004   1.64×   3.27    0.05
 *   swell    11.0   6 strong breeze      2.783   1.39×   2.55    0.12  ← default
 *   squall   14.0   7 near gale          4.293   1.54×   2.08    0.38  ← rain
 *   gale     16.5   7 near gale (top)    6.461   1.51×   1.70    0.65
 *   storm    18.5   8 gale               9.604   1.49×   1.45    1
 *
 * No step doubles the sea under it, which was the entire complaint about the
 * old three-entry list (1.22 → 2.78 → 14.70 m: a 5.3× cliff with nothing in
 * it). GLASS SITS OFF THE BOTTOM rather than on the ladder, for the same
 * reason `SEA_STATES.glass` does: it is not a step down from `calm`, it is a
 * different destination reached by taking the WATER out rather than the wind.
 *
 * FORCES 1, 3, 5, 6, 7, 7, 8, checked against `beaufort()` by the tests so a
 * wind that drifts off the force its comment names fails loudly instead of
 * quietly mislabelling. TWO RUNGS SHARE FORCE 7 and that is a fact about
 * Beaufort rather than a gap in the ladder: the bands widen at the top, F7
 * alone spans 13.9–17.1 m/s, and `squall` and `gale` sit at its two ends with
 * a 1.5× difference in Hs between them. The ladder is spaced on the SEA, not
 * on the label.
 *
 * THE TOP OF THE LADDER IS CAPPED BY A PARAM THIS MODULE DOES NOT OWN, and it
 * is worth knowing which: `oceanParams.fetchFieldMargin` is 3200 m and must
 * exceed `fullyDevelopedFetch(windSpeed)` or a lee shadow is truncated at the
 * field border and draws a ring on the water (tests/fetch.test.ts). That
 * resolves to **19.3 m/s** — 3114 m at 19.0, 3280 m at 19.5 — so Beaufort 9
 * (20.8 m/s and up) is UNREACHABLE for any preset until that margin moves.
 * `storm` sits at 18.5 m/s (2952 m, 8% of headroom) deliberately rather than
 * against the wall. Raising the margin is a src/params/ocean.ts change.
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
  /**
   * Two INDEPENDENT wave systems, so a preset has to name both (§V.7 — presets
   * are the vocabulary, and a vocabulary missing half the sea cannot say
   * "long rolling swell under light chop", which is the most common state
   * there is and the one the user found unreachable). `swellPeriod` and
   * `swellDirection` are what make the presets feel like different OCEANS
   * rather than one ocean at different volumes.
   */
  ocean: Pick<
    OceanParams,
    | 'amplitude'
    | 'windSpeed'
    | 'choppiness'
    | 'jacobianFoamBias'
    | 'swellPeriod'
    | 'swellAmplitude'
    | 'swellDirection'
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

/**
 * Preset keys whose lerp re-cuts the SPECTRUM — the same lane class as
 * LAYOUT_KEYS above, one system over, and the reason a seven-rung ladder is
 * affordable at all.
 *
 * These are exactly `SPECTRUM_SIGNATURE_KEYS` (src/ocean/oceanCascades.ts) ∩
 * the ocean keys a preset patches. Moving ANY of them changes
 * `spectrumSignature`, which regenerates h0 on the GPU **and** on the §V.8
 * CPU mirror — measured warm at ~490 ms of main-thread work at 512², and the
 * cost is `generateSpectrumData`, not the FFT.
 *
 * MEASURED (ddd2d77): a smooth 4 s preset lerp moves five of these on every
 * frame, so the ocean's rate limit (`rebuildCountdown`, one rebuild per 16
 * ticks on a continuously-moving input) fires **16 rebuilds — 8140 ms of
 * main-thread stall across a 4-second transition**. A fused spectrum pass cut
 * that to 2221 ms and the worst tick from 599 ms to 222 ms: better, still bad,
 * and it gets WORSE with more rungs because more rungs means more transitions.
 *
 * THE FIX IS THE ONE THE CLOUDS ALREADY USE. `applyPreset` quantises the
 * PROGRESS of this lane class to `weatherParams.spectrumLerpSteps` steps, so
 * the signature genuinely goes quiet between steps and the rebuild count is
 * the step count instead of `transitionSeconds × 60 / 16`. The values are
 * still true lerps and still land exactly on target at the end; only their
 * progress is stepped. All five step TOGETHER on the same quantised progress —
 * staggering them would multiply the signature changes by five and undo the
 * whole thing.
 *
 * WHY THE LIST IS SPELT OUT HERE rather than imported like `LAYOUT_KEYS` is:
 * `SPECTRUM_SIGNATURE_KEYS` lives in `src/ocean/oceanCascades.ts`, which pulls
 * in three.js and the WebGPU pipeline objects — far too much to drag into the
 * weather module, which is otherwise params-only. So it is duplicated, and
 * tests/weather.test.ts pins it against the real list by intersection: adding
 * a spectrum key to the ocean, or a new ocean key to `PresetPatch`, fails
 * there instead of silently reintroducing the stall (§V.62). The right home
 * for the shared list is `src/params/ocean.ts`; that file is under another
 * agent's experiment right now.
 */
export const SPECTRUM_KEYS: readonly string[] = [
  'amplitude',
  'windSpeed',
  'swellPeriod',
  'swellAmplitude',
  'swellDirection',
];

export const weatherPresets: Readonly<
  Record<
    'glass' | 'calm' | 'breeze' | 'swell' | 'squall' | 'gale' | 'storm',
    PresetPatch
  >
> = {
  /**
   * glass — "a perfect, almost perfect flatness" (user), and the rung the old
   * three-entry list could not reach at all: its `calm` still carried a 1.22 m
   * ground swell by design.
   *
   * IT IS NOT A LOW-WIND SETTING. Measured on the shipped spectrum this holds
   * a Force 1 air — 1.0 m/s, enough that a ship still ghosts along rather than
   * being stranded in irons — and the sea still falls from `calm`'s 1.222 m to
   * 0.008 m, a factor of 150, because that fall comes from `swellAmplitude`
   * 0.30 → 0 and `amplitude` 0.30 → 0.06. Wind and swell are independent
   * (params/ocean.ts:92); dropping the wind alone would have changed almost
   * nothing, which is exactly the trap `SEA_STATES.glass` documents.
   *
   * The 16 s period is what the residual mirror-flex reads as: nothing you can
   * see as a wave, everything you can see as a slow breathing tilt in the
   * glitter.
   */
  glass: {
    ocean: {
      amplitude: 0.06,
      windSpeed: 1, // Beaufort 1 — steerage way, and no more
      choppiness: 0.6, // nothing to pinch; keeps the last ripples rounded
      jacobianFoamBias: 0, // foam ONLY on a true fold, and there are none
      swellPeriod: 16,
      swellAmplitude: 0, // the ground swell has died away entirely
      swellDirection: Math.PI * 0.62,
    },
    sky: {
      hazeStrength: 0.3, // the clearest air on the ladder
      sunIntensity: 3.4,
      ambientIntensity: 0.95,
    },
    clouds: {
      // §V11b again: an EMPTY sky is few clusters, never low coverage
      coverage: 0.8,
      clusterCount: 3,
      ringInner: 1100,
      ringOuter: 3000,
      altitudeMin: 420,
      altitudeMax: 720,
      clusterRadiusMin: 120,
      clusterRadiusMax: 220,
      clusterFlatten: 1.6,
      clusterHeight: 0.6,
      heightBias: 2,
      lobeScaleMin: 0.16,
      lobeScaleMax: 0.28,
      domeExponent: 1.8,
      waistWidth: 0.98,
      waistHeight: 0.8,
      anvilStart: 0.85,
      capRound: 0.88,
      anvilSpread: 0,
      sunColor: 0xfff9ec,
      skyColor: 0x77a6d6,
    },
  },

  // calm — glassy tropical morning (docs/final-full-result.png at its
  // gentlest): low energy, light breeze, foam only where waves truly fold.
  calm: {
    ocean: {
      amplitude: 0.3, // gentle rollers, no whitecaps
      windSpeed: 4, // light breeze (m/s) → short, soft spectrum
      choppiness: 0.85, // rounded crests — little horizontal pinching
      jacobianFoamBias: 0.12, // well below swell: foam only on rare true folds
      // A calm day is NOT a flat sea: the local wind has dropped but the swell
      // from a distant storm has not, and a long low ground swell under a
      // glassy surface is the most characteristic calm-ocean look there is.
      // This is the preset that most needed a second train — before it, calm
      // could only mean "small and short", i.e. a pond.
      swellPeriod: 13,
      swellAmplitude: 0.3,
      swellDirection: Math.PI * 0.62,
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

  /**
   * breeze — the WORKING day, Beaufort 5 (8.5 m/s), Hs 2.00 m.
   *
   * This is the rung the old list was missing most: between `calm`'s 1.22 m
   * ghosting-along morning and `swell`'s 2.78 m default there was nothing, and
   * those two are the seas a player spends nearly all their time in. It is a
   * fresh breeze with fair-weather cumulus filling in — the sky is still open,
   * but there is enough of it to throw moving shadow on the water.
   *
   * Amplitude comes DOWN from calm's 0.30 to 0.28 while the sea gets 64%
   * bigger, and that is not a slip: `windSpeed` is the wind sea's LENGTH and
   * `amplitude` is its energy, so past Force 3 the wind carries the ladder on
   * its own (Phillips: peak ∝ V²/g). Both are still set deliberately per rung
   * — a preset that only moves the wind leaves a heaving sea underneath.
   */
  breeze: {
    ocean: {
      amplitude: 0.28,
      windSpeed: 8.5, // Beaufort 5, fresh breeze
      choppiness: 0.9,
      // z = 3.27σ: whitecaps you can count, well short of swell's 2.55σ
      jacobianFoamBias: 0.5,
      swellPeriod: 12,
      swellAmplitude: 0.32,
      swellDirection: Math.PI * 1.15,
    },
    sky: {
      hazeStrength: 0.68,
      // still full unclouded sun: the ladder does not start dimming until
      // `squall`, where the cloud actually thickens. A fresh breeze under
      // fair-weather cumulus is a BRIGHT day, and it must also not dip below
      // `swell`'s 3.4 — that would make the sun brighten as the weather got
      // worse, one rung up.
      sunIntensity: 3.4,
      ambientIntensity: 0.8,
    },
    clouds: {
      coverage: 0.82,
      clusterCount: 10, // filling in, but the sky is still open between them
      ringInner: 1600,
      ringOuter: 6000,
      altitudeMin: 460,
      altitudeMax: 840,
      clusterRadiusMin: 200,
      clusterRadiusMax: 440,
      clusterFlatten: 1.4,
      clusterHeight: 0.85,
      heightBias: 1.7,
      lobeScaleMin: 0.21,
      lobeScaleMax: 0.36,
      domeExponent: 2.1,
      waistWidth: 0.92,
      waistHeight: 0.65,
      anvilStart: 0.65,
      capRound: 0.92,
      anvilSpread: 0, // still fair weather: no anvil anywhere below `squall`
      sunColor: 0xfff2de,
      skyColor: 0x5b8cc0,
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
      swellPeriod: oceanParams.swellPeriod,
      swellAmplitude: oceanParams.swellAmplitude,
      swellDirection: oceanParams.swellDirection,
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

  /**
   * squall — Beaufort 7 (14.5 m/s), Hs 4.37 m. THE RUNG WHERE THE WEATHER
   * STARTS BEING WEATHER, and the one that pays for §V.46 and `7892e26`.
   *
   * Its storminess is 0.38 — barely over `rainThreshold` (0.35), so the
   * AMBIENT rain density is 0.013, i.e. nothing. Everything wet about this
   * preset comes from the localised storm CELLS, which the soft union pushes
   * well past `rainFull` inside them. That is the definition of squally
   * weather: dry, bright and blowing hard between the cells, a wall of rain
   * inside one, and — since `7892e26` put the cloud clusters ON the cells
   * (r(rain, storm cloud overhead) 0.000 → 0.750, raining cells with no cloud
   * over them 93.3% → 0.0%) — you can see each one coming across the water
   * before you are in it. Below this rung the whole world stays dry; above it,
   * the rain is everywhere and there is nothing to sail around.
   *
   * The sky is the matching state: cumulus congestus with the first hint of a
   * cap (`anvilSpread` 0.35 against `gale`'s 0.8 and `storm`'s 1.2), towers
   * beginning to build (`clusterHeight` 1.5) and bases coming down.
   */
  squall: {
    ocean: {
      amplitude: 0.22,
      windSpeed: 14, // Beaufort 7, near gale
      choppiness: 1.25, // crests beginning to pinch
      jacobianFoamBias: 0.57, // z = 2.08σ — foam in streaks, not in sheets
      swellPeriod: 10,
      swellAmplitude: 0.5,
      swellDirection: Math.PI * 1.5,
    },
    sky: {
      hazeStrength: 0.95,
      sunIntensity: 2.6, // sun in and out between the cells
      ambientIntensity: 0.65,
    },
    clouds: {
      coverage: 0.9,
      clusterCount: 11,
      ringInner: 2300,
      ringOuter: 7000,
      altitudeMin: 380, // bases coming down
      altitudeMax: 760,
      clusterRadiusMin: 300,
      clusterRadiusMax: 540,
      clusterFlatten: 1.2,
      clusterHeight: 1.5, // congestus: taller than wide is starting
      heightBias: 1.35,
      lobeScaleMin: 0.19,
      lobeScaleMax: 0.32,
      domeExponent: 3.4,
      waistWidth: 0.72,
      waistHeight: 0.6,
      anvilStart: 0.6,
      capRound: 0.95,
      anvilSpread: 0.35, // the first hint of a cap
      sunColor: 0xe8dfd2,
      skyColor: 0x3f5f80,
    },
  },

  /**
   * gale — the TOP of Beaufort 7 (16.5 m/s), Hs 6.46 m. A sustained blow: no
   * longer squalls you can sail between, but a sea and a sky that hold.
   *
   * Storminess 0.65 puts ambient rain at 0.74 — it is raining EVERYWHERE, and
   * that is the qualitative difference from `squall` below it.
   *
   * IT SHARES A BEAUFORT FORCE WITH `squall` AND STILL IS NOT THE SAME SEA:
   * 4.29 m against 6.46 m, half again as big, from 2.5 m/s of extra wind and
   * `amplitude` 0.22 → 0.28. F7 spans 13.9–17.1 m/s, wide enough to hold both
   * comfortably, and the alternative — moving this rung to 17.5 m/s so it
   * could be called Force 8 — would put it 1 m/s from `storm` and make the top
   * two rungs indistinguishable to sail. The label is not worth the rung.
   */
  gale: {
    ocean: {
      amplitude: 0.28,
      windSpeed: 16.5, // Beaufort 7 at its top — see the note on the pair
      choppiness: 1.5,
      jacobianFoamBias: 0.51, // z = 1.70σ — well-marked streaks of foam
      swellPeriod: 9.5,
      swellAmplitude: 0.62,
      swellDirection: Math.PI * 1.34,
    },
    sky: {
      hazeStrength: 0.98,
      sunIntensity: 2, // overcast, no direct sun to speak of
      ambientIntensity: 0.6,
    },
    clouds: {
      coverage: 0.96,
      clusterCount: 9,
      ringInner: 2250,
      ringOuter: 5200,
      altitudeMin: 220,
      altitudeMax: 460,
      clusterRadiusMin: 370,
      clusterRadiusMax: 650,
      clusterFlatten: 1.08,
      clusterHeight: 2.1,
      heightBias: 1.15,
      lobeScaleMin: 0.16,
      lobeScaleMax: 0.28,
      domeExponent: 5.5, // flattening off at the top
      waistWidth: 0.56,
      waistHeight: 0.57,
      anvilStart: 0.57,
      capRound: 0.95,
      anvilSpread: 0.8,
      sunColor: 0xcfc6c0,
      skyColor: 0x36495e,
    },
  },

  // storm — handoff.md §2: raise amplitude AND bias the Jacobian threshold
  // so far more of the surface reads as folding → massive foam patches (§V7).
  storm: {
    ocean: {
      /**
       * 1.15 → 0.41, at wind 18 → 18.5. Measured Hs 14.70 → 9.60 m.
       *
       * THE 1.15 NEVER DID WHAT ITS OWN COMMENT SAID. That comment (kept
       * below in spirit) claimed "1.15 lands near Hs 8–10 m"; measured on the
       * shipped spectrum it lands at **14.70 m** — worse than the worst sea
       * ever recorded in the North Atlantic, and the direct cause of the
       * user's standing report that "our storm is a little bit too intense…
       * too crazy to be in". The 2.2 → 1.15 cut was real and was measured, but
       * it was measured against a spectrum that has since been retuned twice
       * (the swell train landed and cascade 0 went 420 → 1010 m), and nothing
       * re-measured the preset afterwards. `SEA_STATES` in
       * src/ui/settingsStore.ts caught this from its own side and recalibrated
       * ITS top rung to 9.58 m, recording explicitly that "this fixes the
       * LADDER only — src/weather/presets.ts still authors 1.15 and is owned
       * by another agent". This is that fix.
       *
       * WHERE THE 14.70 m CAME FROM: `amplitude`, not wind. At 18 m/s the wind
       * sea alone is nowhere near it, and 1.15 was pumping the Phillips scale
       * to nearly 5× the shipped 0.24 to get there. 0.41 at 18.5 m/s is the
       * same 9.6 m sea `SEA_STATES.f8` reaches (0.46 at 18.0), from the same
       * direction — a genuinely windy sea rather than a small sea inflated.
       *
       * IT WOULD HAVE BEEN BETTER AT BEAUFORT 9 AND IT CANNOT BE. A 9.6 m sea
       * is a Force 9 sea in the real world, and driving it from wind alone
       * would have let `amplitude` sit near the default. `fetchFieldMargin`
       * (3200 m, src/params/ocean.ts) caps any preset's wind at 19.3 m/s —
       * above that a lee shadow is truncated at the field border and draws a
       * ring on the water (tests/fetch.test.ts). So the last of the height is
       * bought with amplitude instead. Raising that margin is the one change
       * that would let this rung be what it should be.
       *
       * WHAT THAT BUYS, in the two reports 1.15 caused: a 35 m hull with 2.6 m
       * of freeboard is a sailing scenario in a 9.6 m sea and is not one in a
       * 14.7 m sea (the sea-physics agent measured the hull fully clear of the
       * water 8–14% of ticks at the old number), and cascade 0 gets back to
       * carrying a useful number of wavelengths per tile (§V.19).
       *
       * IT IS ONE NUMBER TO REVERT if a bigger sea is ever wanted for a shot,
       * and the honest ceiling is worth writing down: nothing above ~10 m has
       * been verified against the hull, so a "rare tempest" rung above this one
       * is deliberately NOT here. It would re-create exactly the sea that was
       * removed, and it needs a hull-clearance measurement first, not a guess.
       */
      amplitude: 0.41,
      windSpeed: 18.5, // Beaufort 8, gale (m/s) → long steep spectrum
      /**
       * 1.9 → 1.7, and the reason is that 1.9 was never being delivered.
       * `effectiveChoppiness` caps λ·σ(det J) at `choppinessFoldLimit`, and on
       * the old 1.15-amplitude sea that cap bit hard: the authored 1.9 reached
       * the GPU as **1.31**. On this smaller sea σ is smaller, so 1.9 would
       * now pass through UNCLAMPED — the crests would come out sharper than
       * they ever shipped, on a preset whose whole point is to be gentler.
       * 1.7 is measured through the same function and is delivered whole, so
       * what is authored here is now what the sea does (§V.62).
       */
      choppiness: 1.7,
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
      // Swell's union at its own 0.55 is 8.7 %, so this puts storm at ≈3× the
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
      //
      // 0.25 → 0.41 WITH THE AMPLITUDE CUT, and the number moving UP while the
      // sea gets calmer is the whole reason this knob is never read on its
      // own. The bar is σ-RELATIVE: z = (1 − bias)/σ(det J), and σ fell with
      // the amplitude. Re-solved against the new spectrum, 0.41 reproduces
      // z = 1.45σ — within 2% of the 1.47σ the table above was tuned to, i.e.
      // the SAME foam read on a survivable sea. Shipping 0.25 unchanged would
      // have taken z to 1.82σ and quietly thinned storm's whitecaps.
      jacobianFoamBias: 0.41,
      // A gale's swell is the SHORTEST on the ladder, and that is not a
      // mistake: a storm sea is dominated by locally-generated wind sea, which
      // is steep and confused. The long ground swell is still there underneath
      // and running from a different quarter, which is what produces the
      // genuinely confused cross-sea a gale looks like — two trains at 100°
      // to each other rather than one train made bigger.
      swellPeriod: 9,
      swellAmplitude: 0.75,
      swellDirection: Math.PI * 1.18,
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
 *
 * THE RAIN THRESHOLD IS THE STRUCTURE OF THIS LIST, not a detail of it. Rain
 * density is `smoothstep(rainThreshold, rainFull, storm)` = smoothstep(0.35,
 * 0.8, s) (src/params/weather.ts), so where a rung sits relative to 0.35
 * decides whether that weather is WET, and the ladder is placed deliberately
 * on both sides of it:
 *
 *   glass  0     rain 0      dry
 *   calm   0     rain 0      dry
 *   breeze 0.05  rain 0      dry — the last dry rung
 *   swell  0.12  rain 0      dry: THE DEFAULT DAY MUST NOT RAIN. Unchanged,
 *                            and it is a pinned invariant, not a preference.
 *   squall 0.38  rain 0.013  dry AMBIENT, drenching inside a cell — the whole
 *                            §V.46 payoff lives on this one rung
 *   gale   0.65  rain 0.741  raining everywhere; no more sailing around it
 *   storm  1     rain 1      the field can add nothing; it is already a storm
 *
 * The old list jumped 0 → 0.12 → 1, so the entire wet half of the range —
 * every state between "a dry working sea" and "the world is at maximum" — was
 * unreachable, and `squall`'s dry-between-wet-inside behaviour could not be
 * expressed at all.
 */
export const PRESET_STORMINESS: Readonly<Record<WeatherPresetName, number>> = {
  glass: 0,
  calm: 0,
  breeze: 0.05,
  // a working sea, not a storm: enough that the ocean/audio can tell swell
  // from glass, far below the rain threshold so a default day stays dry
  swell: 0.12,
  squall: 0.38,
  gale: 0.65,
  storm: 1,
};

export const WEATHER_PRESET_NAMES = Object.keys(
  weatherPresets,
) as readonly WeatherPresetName[];

/**
 * Player-facing name and one-line description per rung, for the settings
 * screen (§V21). It lives beside the data rather than in the UI file for the
 * same reason `SEA_STATES` carries its own NOAA `sea` strings: a rung whose
 * label is written somewhere else drifts away from the numbers it names, and
 * nothing fails when it does.
 *
 * The `sea` lines are the NOAA descriptions of the matching Beaufort force,
 * quoted verbatim from docs/research-whitecap-coverage.md §3 exactly as the
 * sea-state ladder quotes them, with the SKY half appended — because that is
 * the half these presets add over that ladder.
 */
export const WEATHER_PRESET_INFO: Readonly<
  Record<WeatherPresetName, { label: string; name: string; sea: string }>
> = {
  glass: {
    label: 'Glass',
    name: 'Glassy calm',
    sea: 'Sea like a mirror, and the ground swell died away with it. Cloudless but for three high puffs.',
  },
  calm: {
    label: 'Calm',
    name: 'Calm morning',
    sea: 'A long ground swell from a distant storm under a glassy surface. Scattered fair-weather cumulus, full sun.',
  },
  breeze: {
    label: 'Breeze',
    name: 'Working breeze',
    sea: 'Moderate waves, many white horses. Cumulus filling in and throwing moving shadow on the water.',
  },
  swell: {
    label: 'Swell',
    name: 'Working sea',
    sea: 'The sea the game ships with. Large waves beginning to form, white crests everywhere, bright between the clouds.',
  },
  squall: {
    label: 'Squall',
    name: 'Squally',
    sea: 'Sea heaps up, foam blown in streaks. Dry and bright between the cells, a wall of rain inside one — you can watch them coming.',
  },
  gale: {
    label: 'Gale',
    name: 'Gale',
    sea: 'Crests breaking into spindrift, foam in well-marked streaks. Overcast and raining everywhere; nothing left to sail around.',
  },
  storm: {
    label: 'Storm',
    name: 'Storm',
    sea: 'High waves with long overhanging crests, the sea white with driven foam. Anvil cloud on the horizon, no sun.',
  },
};

/**
 * THE OCEAN HALF OF A PRESET, in the shape the settings store's `world` block
 * holds — and the reason it exists is a §V.62 clobber that would otherwise be
 * invisible.
 *
 * `applyWorldSettings` (src/ui/settingsStore.ts) writes the store's `world`
 * block into `oceanParams` on EVERY settings change. A weather preset applied
 * without also writing the store therefore survives only until the player
 * touches any other setting — the volume slider, the time of day — at which
 * point the sea silently snaps back to whatever the store still believed. That
 * is not a bug you would find by looking; it is a preset that works until it
 * randomly does not.
 *
 * So the settings screen writes this patch into the store FIRST and applies
 * the preset second. The store then agrees with the sim by construction, and
 * the transition that follows has nothing left to move on the ocean lanes —
 * which is also why picking a weather preset from the settings screen snaps
 * the water and rolls the SKY in, exactly like the sea-state plate beside it.
 * The debug panel's dropdown still gets the full cinematic lerp.
 *
 * `choppiness` and `jacobianFoamBias` are NOT here, and that is not an
 * oversight: the `world` block does not hold them (they are not player
 * settings), so they arrive through the transition and are free to lerp.
 */
export function weatherWorldPatch(name: WeatherPresetName): {
  windSpeed: number;
  amplitude: number;
  swellAmplitude: number;
  swellPeriod: number;
  swellDirection: number;
} {
  const o = weatherPresets[name].ocean;
  return {
    windSpeed: o.windSpeed,
    amplitude: o.amplitude,
    swellAmplitude: o.swellAmplitude,
    swellPeriod: o.swellPeriod,
    swellDirection: o.swellDirection,
  };
}

/**
 * The preset this sea IS, or null for a sea between presets.
 *
 * Null is a first-class answer, not a failure — the same contract
 * `seaStateFor` has for the sea-state ladder. Dragging any slider, or picking
 * a sea-state rung, leaves the weather plate dark, which is the honest report
 * that the water no longer matches the weather it was set from.
 *
 * WIND DIRECTION IS EXCLUDED, exactly as it is in `seaStateFor`: no preset
 * writes a bearing, so turning the wind must not make the weather read Custom.
 */
export function weatherPresetFor(world: {
  windSpeed: number;
  amplitude: number;
  swellAmplitude: number;
  swellPeriod: number;
  swellDirection: number;
}): WeatherPresetName | null {
  for (const name of WEATHER_PRESET_NAMES) {
    const p = weatherWorldPatch(name);
    if (
      p.windSpeed === world.windSpeed &&
      p.amplitude === world.amplitude &&
      p.swellAmplitude === world.swellAmplitude &&
      p.swellPeriod === world.swellPeriod &&
      p.swellDirection === world.swellDirection
    ) {
      return name;
    }
  }
  return null;
}
