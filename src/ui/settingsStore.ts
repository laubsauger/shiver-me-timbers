/**
 * Game settings store (§V21: DOM overlay reads this store; settings survive
 * reload via localStorage). Plain TS, zero DOM imports — safe for tests and
 * for engine code that consumes quality hints. Values are clamped on load
 * AND on write; corrupt persisted JSON falls back to defaults without
 * throwing (a broken save must never take the game down).
 *
 * Quality presets are NAMED BUNDLES of the per-feature switches (§I), not a
 * parallel mechanism: picking "High" writes every switch, and touching any
 * switch afterwards simply leaves the bundle — `isPresetIntact()` reports it.
 */
import { skyParams } from '../params/sky';
import { oceanParams } from '../params/ocean';
import { GRAPHICS_FEATURE_IDS, SHADOW_MAP_SIZES } from './graphicsFeatures';
import type { GraphicsFeatureId } from './graphicsFeatures';

export type Quality = 'low' | 'medium' | 'high';

export type GraphicsFeatureState = Record<GraphicsFeatureId, boolean>;

export interface GraphicsSettings {
  /** render resolution multiplier, 0.5..1 of native canvas size */
  resolutionScale: number;
  /** the last preset applied — the switches below may since have drifted */
  quality: Quality;
  /** per-feature switches, applied to the params registry by graphicsFeatures */
  features: GraphicsFeatureState;
  /** sun shadow map texels per side; allocated at construction (reload) */
  shadowMapSize: number;
  /** palm LOD distance multiplier, 0..1; 0 = no palms */
  foliageDensity: number;
}

export interface AudioSettings {
  /** all volumes 0..1 */
  master: number;
  /** music bus (§I audio/music) — persisted now, silent until tracks land */
  music: number;
  sfx: number;
  ambience: number;
}

/**
 * World state the player can set directly (§I ui/settings).
 *
 * Time of day is NOT part of the graphics quality bundles: it is a creative
 * choice, not a performance one, and a quality preset must never silently
 * restage the scene. It lives here so it survives a reload — during alpha the
 * whole point is to come back to the same light you were last looking at.
 */
export interface WorldSettings {
  /** simulated hour 0..24; drives sun position and every light ramp */
  timeOfDay: number;
  /**
   * Bearing the TRUE wind blows TOWARD, in radians clockwise from north
   * (+Z) — the same convention `oceanParams.windDirection`, `state.wind` and
   * the HUD heading tape already use. Named by where it blows FROM on screen,
   * because that is how a sailor names a wind; the stored number is the
   * TOWARD bearing, unconverted, so it can be assigned to the param directly.
   */
  windDirection: number;
  /** true wind speed in m/s — the sea state as much as the sailing */
  windSpeed: number;
  /** Phillips scale of the WIND SEA → `oceanParams.amplitude` */
  amplitude: number;
  /** RMS swell elevation in m → `oceanParams.swellAmplitude`; Hs_swell is 4× */
  swellAmplitude: number;
  /** swell peak period in s → `oceanParams.swellPeriod`; λ = gT²/2π */
  swellPeriod: number;
  /** swell toward-bearing in rad, DECOUPLED from the wind on purpose */
  swellDirection: number;
}

/**
 * THE SEA STATE THE PLAYER CAN REACH, and the reason it is a range and not a
 * preset. User: "we need control about the wind speed, swell and all of this
 * in a better way than just having these three presets that are like wildly
 * different." Measured Hs of those three: calm 1.23 m, swell 2.78 m, storm
 * 14.70 m — a 12× jump with nothing between the top two.
 *
 * Every bound below is measured against the shipped spectrum rather than
 * guessed (the numbers are Hs = 4√m₀ summed over the three cascades):
 *
 *  windSpeed 0.5–25 m/s spans Hs 1.35 → 12.63 m ON ITS OWN, so this one slider
 *    already covers calm through very nearly storm continuously. The floor is
 *    the params file's own: Phillips' fetch length is V²/g, so 0 means "no
 *    wind sea at all" rather than "a light air". The ceiling is the top of
 *    Beaufort 9.
 *  amplitude 0–1.5 spans Hs 1.35 → 6.23 m at wind 11. It is the wind sea's
 *    energy where windSpeed is its LENGTH, and it is what the storm preset
 *    (1.15) raises to get its height. 4 is the params ceiling and is far past
 *    anything sailable.
 *  swellAmplitude 0–1.5 spans Hs 2.43 → ~7 m. 0 removes the swell train
 *    EXACTLY (the sea drops to its pure wind-sea 2.43 m), which is what makes
 *    "wind chop with no ground swell" reachable.
 *  swellPeriod 2–20 s is the params range exactly, and it is HEIGHT-NEUTRAL:
 *    measured Hs 2.79 → 2.69 m across the whole span, because the swell
 *    spectrum is normalised for its own height. So it is a pure character
 *    knob — 4 s is a short confused sea, 20 s is a long ground swell — which
 *    is precisely the "long rolling swell under light chop" the presets'
 *    own comment records as unreachable.
 */
/**
 * THE BEAUFORT LADDER — nine rungs from glass to gale, replacing a three-step
 * jump nobody could sail between.
 *
 * User: "we probably want more presets so that we can be a little bit more
 * fine-grained... Right now our storm is a little bit too intense — basically
 * too crazy to be in. So let's add some subdivisions, and some more
 * interesting things like a perfect, almost perfect flatness or a very very
 * calm sea, as well as subdivisions on the way up to being very stormy."
 *
 * WHY BEAUFORT AND NOT A MADE-UP SCALE. It is a DESCRIPTIVE scale — it was
 * built to be read off a deck by eye, which is exactly the judgement this
 * control is asking the player to make. `docs/research-whitecap-coverage.md`
 * carries the NOAA table the `sea` strings below are quoted verbatim from, and
 * records the cross-check that makes it trustworthy here: Force 3 begins at
 * 7 kt = 3.60 m/s and is the first mention of whitecaps in the whole scale,
 * while Callaghan 2008's independently fitted whitecap onset is 3.70 m/s. A
 * 19th-century eyeball scale and a modern regression agreeing to 0.1 m/s.
 *
 * That agreement is why the ladder pays off twice. Foam coverage is gated on
 * wind speed through Callaghan's threshold-cubic, so stepping up these rungs
 * produces a physically consistent whitecap progression FOR FREE — measured at
 * the wind speeds below: 0%, 0%, 0.001%, 0.11%, 0.73%, 1.49%, 2.66%, 3.84%,
 * against the research doc's own CAL08 column of 0, 0, 0.001, 0.11, 0.74, 1.5,
 * 2.7. Nothing was tuned to make that happen.
 *
 * `hs` IS MEASURED, NOT AUTHORED — significant wave height in metres, 4√m₀
 * summed over the three cascades at the values on the same row. It is recorded
 * here so the ladder's spacing is a checkable fact, and `tests/ui.test.ts`
 * re-measures every rung against the live spectrum: 0.19 → 0.41 → 0.81 → 1.42
 * → 2.35 → 3.67 → 6.49 → 9.58 m. Roughly 1.6× a rung, no gap you could fall
 * through, which is the entire complaint answered.
 *
 * GLASS SITS OFF THE BOTTOM OF THAT LADDER RATHER THAN ON IT, at Hs 0.0085 m.
 * The 1.6×-per-rung spacing is a claim about SAILABLE seas, and glass is not a
 * step down from Force 1 — it is a different destination, 22× flatter, reached
 * by taking the ground swell out rather than by taking the wind out. See the
 * rung's own note for the measurement; it is the clearest demonstration in the
 * codebase that swell and wind are independent knobs.
 *
 * A NOTE ON THE SHIPPED DEFAULT, which matches NO rung. `DEFAULT_SETTINGS.world`
 * is seeded from `oceanParams` (wind 11, amplitude 0.24, swell 0.34/11 s,
 * Hs 2.78 m), and that sits BETWEEN `f5` (9.8 m/s, 2.35 m) and `f6` (12.6 m/s,
 * 3.67 m) — both of which are legitimate Beaufort representatives of their own
 * forces. So a fresh boot correctly reads "Between forces". Do not "fix" that by
 * dragging a rung onto the default: it would put two rungs inside one force and
 * break the ladder's spacing. `resetWorld()` below is the right answer to
 * "get me back to the sea the game shipped with".
 *
 * THE TOP RUNG IS THE RECALIBRATED STORM. The shipped `storm` weather preset
 * measures Hs 14.70 m — worse than the worst recorded North Atlantic sea, and
 * far past the 8–10 m its own comment says it was cut to. That is what "too
 * crazy to be in" is. Holding its wind at 18 m/s and taking amplitude
 * 1.15 → 0.46 lands Hs 9.58 m. NOTE: this fixes the LADDER only —
 * `src/weather/presets.ts` still authors 1.15 and is owned by another agent.
 *
 * THE SWELL IS SUGGESTED, NEVER LOCKED. Beaufort describes WIND SEA. The swell
 * train is decoupled on purpose (params/ocean.ts:92) because a big swell on a
 * calm day is a real and wanted sea, so a rung writes a swell that suits it and
 * then gets out of the way — drag the swell sliders afterwards and the plate
 * simply reads Custom, exactly as a graphics quality preset does. Neither wind
 * DIRECTION nor swell DIRECTION is touched by any rung: bearing is the player's
 * alone, and a preset silently spinning the compass would be unforgivable.
 */
export interface SeaStateRung {
  /** stable key; also what the segment plate highlights on */
  id: string;
  /** the plate's own text — narrow, because there are nine of them */
  label: string;
  /** Beaufort's name for the force */
  name: string;
  /**
   * The Beaufort force this rung NAMES, when it names one — checked against
   * `beaufort(windSpeed)` by tests/ui.test.ts, so a rung whose wind drifts off
   * the force on its own plate fails loudly instead of quietly mislabelling.
   *
   * Absent on GLASS, and that absence is the point rather than an omission.
   * Beaufort describes WIND; glass is a statement about the WATER, and the two
   * are decoupled here on purpose (params/ocean.ts:92). Force 0 proper means
   * under 0.5 m/s, which is below `SEA_RANGES.windSpeed.min` and below the
   * HUD's own becalmed threshold — a rung that hard-locks the ship in irons is
   * the very trap this pass is fixing, not one to add. So glass takes the
   * lowest air a ship can still ghost on and takes the flatness out of the
   * water instead, which is exactly what the decoupling is for.
   */
  force?: number;
  /** verbatim NOAA sea description (docs/research-whitecap-coverage.md §3) */
  sea: string;
  /** MEASURED significant wave height at this rung, m — see the note above */
  hs: number;
  windSpeed: number;
  amplitude: number;
  swellAmplitude: number;
  swellPeriod: number;
}

export const SEA_STATES: readonly SeaStateRung[] = [
  {
    // labelled '0' rather than 'Glass': nine plates share one row at ~53 px
    // each and a five-letter cell overflows it at narrow widths, while the
    // digit keeps the row regular. The plate is the gesture; the note under it
    // is where the meaning is, and for this rung the note carries no force
    // number at all — see `force` on the interface.
    id: 'glass', label: '0', name: 'Glassy calm', hs: 0.0085,
    sea: 'Sea like a mirror. Not a ripple, and the ground swell has died away entirely.',
    /**
     * THE GLASS RUNG — "a perfect, almost perfect flatness" (user), and the
     * one this ladder described and then never built: the note under `f1` has
     * always said that dropping the ground swell "to nought below gives
     * literal glass", pointing at a rung below it that did not exist.
     *
     * IT IS NOT A LOW-WIND SETTING, and that is the whole lesson. Measured on
     * the shipped spectrum, the wind holds the SAME 1.0 m/s as `f1` and the
     * sea still falls from Hs 0.191 m to 0.0085 m — a factor of 22 — because
     * `f1`'s height is essentially ALL ground swell (its wind sea alone is
     * 0.017 m) and swell is decoupled from wind by design. Lowering the wind
     * on its own would have changed almost nothing; the flatness comes from
     * `swellAmplitude` 0.05 → 0 and `amplitude` 0.24 → 0.06.
     *
     * That is also why `amplitude` is set at all rather than left at the
     * shipped 0.24. It is decoupled from `windSpeed` too: at a fixed wind of
     * 8 m/s, amplitude alone moves Hs 1.28 → 2.02 m (0.24 → 0.60) and moves
     * whitecap coverage by 5×. A "calm" preset that drops the wind and leaves
     * the amplitude where it was still leaves a heaving sea, so every rung on
     * this ladder must set BOTH deliberately.
     *
     * The long 16 s period is what the residual mirror-flex reads as: nothing
     * you can see as a wave, everything you can see as a slow breathing tilt
     * in the sun glitter.
     */
    windSpeed: 1.0, amplitude: 0.06, swellAmplitude: 0, swellPeriod: 16,
  },
  {
    id: 'f1', label: '1', force: 1, name: 'Light air', hs: 0.19,
    sea: 'Ripples with the appearance of scales; no foam crests.',
    // the ground swell alone: the wind sea at 1 m/s is 0.017 m, so 0.19 of the
    // 0.191 is the long train — which is exactly what `glass` above removes
    windSpeed: 1.0, amplitude: 0.24, swellAmplitude: 0.05, swellPeriod: 14,
  },
  {
    id: 'f2', label: '2', force: 2, name: 'Light breeze', hs: 0.41,
    sea: 'Small wavelets, crests glassy, do not break.',
    windSpeed: 2.6, amplitude: 0.24, swellAmplitude: 0.1, swellPeriod: 13,
  },
  {
    id: 'f3', label: '3', force: 3, name: 'Gentle breeze', hs: 0.81,
    sea: 'Large wavelets, crests begin to break. Perhaps scattered white horses.',
    // THE WHITECAP RUNG. 4.4 m/s sits just above Callaghan's 3.70 m/s onset,
    // so this is the first rung on which foam exists at all — by the published
    // law, not by a threshold anybody picked here.
    windSpeed: 4.4, amplitude: 0.24, swellAmplitude: 0.18, swellPeriod: 12.5,
  },
  {
    id: 'f4', label: '4', force: 4, name: 'Moderate breeze', hs: 1.42,
    sea: 'Small waves, becoming longer. Fairly frequent white horses.',
    windSpeed: 7.0, amplitude: 0.24, swellAmplitude: 0.26, swellPeriod: 12,
  },
  {
    id: 'f5', label: '5', force: 5, name: 'Fresh breeze', hs: 2.35,
    sea: 'Moderate waves, taking more pronounced long form. Many white horses are formed.',
    windSpeed: 9.8, amplitude: 0.24, swellAmplitude: 0.34, swellPeriod: 11,
  },
  {
    id: 'f6', label: '6', force: 6, name: 'Strong breeze', hs: 3.67,
    sea: 'Large waves begin to form. White foam crests are more extensive everywhere.',
    windSpeed: 12.6, amplitude: 0.24, swellAmplitude: 0.45, swellPeriod: 10.5,
  },
  {
    id: 'f7', label: '7', force: 7, name: 'Near gale', hs: 6.49,
    sea: 'Sea heaps up and white foam from breaking waves begins to be blown in streaks.',
    // amplitude starts to climb only here: below this the wind alone carries
    // the ladder, which is what Phillips says it should (peak ∝ V²/g)
    windSpeed: 15.7, amplitude: 0.35, swellAmplitude: 0.6, swellPeriod: 9.5,
  },
  {
    id: 'f8', label: '8', force: 8, name: 'Gale', hs: 9.58,
    sea: 'Edges of crests begin to break into spindrift. The foam is blown in well-marked streaks.',
    // a gale's swell is the SHORTEST on the ladder and that is not a slip —
    // it is raised by the gale itself, close by, so it is steep and confused
    windSpeed: 18.0, amplitude: 0.46, swellAmplitude: 0.75, swellPeriod: 9,
  },
];

export const SEA_RANGES = {
  windSpeed: { min: 0.5, max: 25, step: 0.5 },
  // 0.02 is also the quantum the §V.46 weather field publishes amplitude at,
  // so a slider step can never be finer than the value the sim can hold
  amplitude: { min: 0, max: 1.5, step: 0.02 },
  swellAmplitude: { min: 0, max: 1.5, step: 0.02 },
  swellPeriod: { min: 2, max: 20, step: 0.5 },
} as const;

export interface GameSettings {
  graphics: GraphicsSettings;
  audio: AudioSettings;
  world: WorldSettings;
}

/**
 * Engine hints per quality tier — consumers (ocean, clouds, renderer) wire
 * these later; the table lives here so a preset is one lookup, not logic.
 * oceanResolution never drops below 512 (§V19 floor).
 */
export interface QualityHints {
  /** FFT cascade texture size per side */
  oceanResolution: number;
  /** cloud RT scale relative to canvas */
  cloudRtScale: number;
  shadows: boolean;
  /** progressive foam blur passes per frame */
  foamBlurPasses: number;
  /** texture max anisotropy */
  maxAnisotropy: number;
}

export const QUALITY_PRESETS: Record<Quality, QualityHints> = {
  low: { oceanResolution: 512, cloudRtScale: 0.25, shadows: false, foamBlurPasses: 1, maxAnisotropy: 2 },
  medium: { oceanResolution: 512, cloudRtScale: 0.5, shadows: true, foamBlurPasses: 2, maxAnisotropy: 4 },
  high: { oceanResolution: 1024, cloudRtScale: 0.5, shadows: true, foamBlurPasses: 3, maxAnisotropy: 8 },
};

/** the graphics block a preset writes — everything except the preset name */
export type QualityBundle = Omit<GraphicsSettings, 'quality'>;

function features(on: GraphicsFeatureId[]): GraphicsFeatureState {
  const state = {} as GraphicsFeatureState;
  for (const id of GRAPHICS_FEATURE_IDS) state[id] = on.includes(id);
  return state;
}

/**
 * Post stages stay ON inside every bundle: they only cost anything when
 * `postFx` itself is on, and a player who switches the grade on expects to see
 * the grade rather than four more switches.
 *
 * MEDIUM is the shipped default. It is NOT automatically the same thing as the
 * engine's param defaults, and assuming it was cost real time — TWICE, in both
 * directions, which is why this list is now checked against `params/*` by a
 * test rather than by reading:
 *  - `reflections` was absent here while `params/reflection.ts` said `live: 1`,
 *    so the param file lost and reflections were dead at the default quality;
 *  - `postFx` was absent here while `params/post.ts` said `enabled: true`, so
 *    the ENTIRE post chain — bloom, god rays, vignette, vibrance, dither —
 *    had never once run for anybody, and the store then persisted that false
 *    so a fix here alone could not have reached a player (hence the
 *    STORAGE_KEY bump below);
 *  - `postAo` was named here while `params/post.ts` says `aoEnabled: false`
 *    with a documented reason — GTAO reads the scene-pass DEPTH, WebGPU
 *    cannot resolve a multisampled depth attachment, so building AO forces
 *    the scene pass to `samples: 0` and costs the WHOLE FRAME its MSAA. This
 *    list was silently buying that trade on every boot, at every tier.
 * A feature switched on in `params/*` is OFF unless this list also names it,
 * and a feature switched OFF in `params/*` is ON if this list names it. Both
 * directions are silent. Diff the two before touching either.
 *
 * `postFx` stays out of LOW on purpose, and that is a choice rather than an
 * omission: low exists to buy frames back, post is a chain of full-screen
 * passes, and the switch is `reload: false` so a low-tier player can turn the
 * grade on mid-session (main.ts warms the post path in the background first).
 */
export const QUALITY_BUNDLES: Record<Quality, QualityBundle> = {
  low: {
    /**
     * 0.75 → 1. Not a quality-bar decision, a MEASUREMENT: 0.75 was the only
     * real downscale left in the codebase and it was paying full price for
     * nothing.
     *
     * What it bought: near zero. This frame is CPU-BOUND — 595 draw calls
     * across 18 passes, 19-24 ms of CPU encode against 6-10 ms of GPU work
     * (d5bd07a) — and `low` has already switched off reflections, caustics,
     * deck water, spray, rain, both shadow paths and the whole post chain,
     * i.e. every stage that was fill-limited. Shrinking the framebuffer under
     * a draw-call bottleneck moves the frame time hardly at all.
     *
     * What it cost: the entire image. At a 1920-wide window the backing store
     * lands at 1440×642 and is bilinearly stretched 1.33× to the canvas, with
     * no sharpening anywhere in the composite. Against a 2×SSAA reference that
     * is RMSE 15.83 vs 10.76 at native — 47% worse, uniformly, over every
     * pixel rather than at edges. It is the "everything is blocky" signature
     * the user photographed. It also silently caps what this tier can ever get
     * back: `postFx` is a `reload: false` switch, so a low-tier player can
     * turn post on mid-session, and the SMAA at the end of that chain
     * reconstructs edges in the BACKING STORE — a 1.33× bilinear upscale
     * afterwards smears the sub-pixel detail it just rebuilt.
     *
     * The remaining frame-buying levers at this tier are `foliageDensity` and
     * the feature list, not the whole frame. `shadowMapSize` is inert here —
     * `shadows` is not in the feature list below, so nothing reads it.
     */
    resolutionScale: 1,
    features: features(['postBloom', 'postVibrance', 'postVignette']),
    shadowMapSize: 1024,
    foliageDensity: 0.35,
  },
  medium: {
    resolutionScale: 1,
    features: features([
      // 'reflections' is IN medium on purpose. Measured with GPU timestamp
      // queries at the §T.39 sunset framing: +0.9 to +1.1 ms (367 → 556 draw
      // calls). It is what puts the ship INTO the water she floats on, and at
      // a grazing sunset the dark shape beside a hull is its reflection, not
      // its shadow — a shadow cannot darken reflected sky. Leaving it out made
      // `reflectionParams.live = 1` dead at the default quality, because this
      // bundle is written over the params on every boot.
      'reflections',
      'caustics', 'deckWater', 'spray', 'rain', 'shadows', 'islandShadows',
      'postFx', 'postBloom', 'postVibrance', 'postVignette',
    ]),
    shadowMapSize: 2048,
    foliageDensity: 0.75,
  },
  high: {
    resolutionScale: 1,
    features: features([
      'reflections', 'caustics', 'deckWater', 'spray', 'rain', 'shadows',
      'islandShadows', 'postFx', 'postBloom', 'postVibrance', 'postVignette',
    ]),
    shadowMapSize: 4096,
    foliageDensity: 1,
  },
};

export const DEFAULT_SETTINGS: GameSettings = {
  graphics: { quality: 'medium', ...QUALITY_BUNDLES.medium },
  audio: { master: 0.8, music: 0.7, sfx: 1, ambience: 0.7 },
  // seeded from the engine params so there is ONE default, not two that drift
  world: {
    timeOfDay: skyParams.timeOfDay,
    windDirection: oceanParams.windDirection,
    windSpeed: oceanParams.windSpeed,
    amplitude: oceanParams.amplitude,
    swellAmplitude: oceanParams.swellAmplitude,
    swellPeriod: oceanParams.swellPeriod,
    swellDirection: oceanParams.swellDirection,
  },
};

/**
 * BUMP THIS whenever a QUALITY_BUNDLE changes a switch a player could already
 * have persisted. The store writes the whole graphics block on the first run
 * and reads it back verbatim on every later one, so the persisted copy BEATS
 * any bundle edit — forever, silently, for exactly the players who ran the
 * broken build. v1 → v2: `postFx` was persisted false (post never ran) and
 * `postAo` persisted true (whole-frame MSAA silently traded away); neither
 * could be reached by fixing the bundle alone.
 *
 * The cost is that audio levels and time of day reset with it. That is the
 * right trade while the alternative is a per-key migration table nobody will
 * keep current — but a bump is a user-visible reset, not a free action.
 */
export const STORAGE_KEY = 'smt.settings.v2';
const QUALITIES: readonly Quality[] = ['low', 'medium', 'high'];

/** minimal persistence surface so tests can inject a fake */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SettingsPatch {
  graphics?: Partial<Omit<GraphicsSettings, 'features'>> & {
    features?: Partial<GraphicsFeatureState>;
  };
  audio?: Partial<AudioSettings>;
  world?: Partial<WorldSettings>;
}

export type SettingsListener = (settings: GameSettings) => void;

export interface SettingsStore {
  /** deep copy — mutate via set() only, so clamping always applies */
  get(): GameSettings;
  set(patch: SettingsPatch): void;
  /** write a whole named bundle: quality preset + every switch it implies */
  applyQuality(q: Quality): void;
  /**
   * Put the WORLD block back to what the game shipped with, leaving graphics
   * and audio alone.
   *
   * WHY THIS HAD TO EXIST. The world block persists and there was no way back
   * out of it, so a player who once tried the bottom of the wind slider was
   * becalmed on that save forever — every load, on a sea nobody chose that
   * session. It is what produced the report "we shouldn't start with basically
   * 0 wind" when the shipped default is in fact 11 m/s, Beaufort 6: the game
   * was not starting there, the SAVE was. Bumping `STORAGE_KEY` clears it, but
   * that is a one-off migration that also throws away the player's audio
   * levels and time of day — it is not a control anyone can reach twice.
   *
   * Graphics already had its way home (`applyQuality`, which explicitly
   * carries `world` through untouched); this is the same affordance for the
   * half of the store that could actually strand you.
   */
  resetWorld(): void;
  /** false once any switch has drifted from the named bundle */
  isPresetIntact(): boolean;
  /** hints for the currently selected quality tier */
  hints(): QualityHints;
  subscribe(cb: SettingsListener): () => void;
}

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(max, Math.max(min, n));
}

const TAU = Math.PI * 2;

/**
 * Fold a BEARING into [0, 2π). Bearings are clamped nowhere: an angle has no
 * ends, and clamping one piles every out-of-range value onto due north or due
 * south instead of the compass point it actually names — the persisted 7π/4
 * of a north-westerly would come back as a southerly.
 */
function wrapTau(v: unknown, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  // EXACT IDENTITY on an in-range bearing, and that is not a micro-optimisation.
  // `((n % TAU) + TAU) % TAU` is NOT the identity in binary: 225° goes in as
  // 3.9269908169872414 and comes back 3.9269908169872423. The settings screen's
  // compass plate highlights on exact equality with its preset value, so
  // sanitizing every write through the round trip meant the plate could never
  // light up — click "SW", get SW, see nothing selected. Caught by the
  // round-trip test; it is the §B silent-no-op shape in one ULP.
  if (n >= 0 && n < TAU) return n;
  return ((n % TAU) + TAU) % TAU;
}

/**
 * The rung this sea IS, or null for a sea between rungs.
 *
 * Null is a first-class answer, not a failure: the sliders are continuous and
 * the whole point of them is to reach between the rungs, so the plate going
 * dark is the honest report that you are somewhere the ladder does not name.
 * Same contract as `isPresetIntact` for graphics.
 *
 * Compares only the four keys a rung WRITES. Wind direction and swell
 * direction are excluded on purpose — turning the wind must not make the sea
 * state read Custom, because the wind's bearing is not part of its force.
 */
export function seaStateFor(w: WorldSettings): SeaStateRung | null {
  return (
    SEA_STATES.find(
      (r) =>
        r.windSpeed === w.windSpeed &&
        r.amplitude === w.amplitude &&
        r.swellAmplitude === w.swellAmplitude &&
        r.swellPeriod === w.swellPeriod,
    ) ?? null
  );
}

/** the world patch a rung writes — never a bearing (see seaStateFor) */
export function seaStatePatch(r: SeaStateRung): Partial<WorldSettings> {
  return {
    windSpeed: r.windSpeed,
    amplitude: r.amplitude,
    swellAmplitude: r.swellAmplitude,
    swellPeriod: r.swellPeriod,
  };
}

/** clamp into a named SEA_RANGES band — one bound table, not two that drift */
function clampSea(v: unknown, key: keyof typeof SEA_RANGES, fallback: number): number {
  const r = SEA_RANGES[key];
  return clampNum(v, r.min, r.max, fallback);
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

/** snap to the nearest supported shadow map size — the GPU allocates one of these */
function pickShadowMapSize(v: unknown, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  let best = SHADOW_MAP_SIZES[0];
  for (const s of SHADOW_MAP_SIZES) if (Math.abs(s - v) < Math.abs(best - v)) best = s;
  return best;
}

/** coerce arbitrary parsed data into a valid GameSettings (clamp + defaults) */
export function sanitizeSettings(raw: unknown): GameSettings {
  const r = asRecord(raw);
  const g = asRecord(r.graphics);
  const a = asRecord(r.audio);
  const w = asRecord(r.world);
  const d = DEFAULT_SETTINGS;
  const rawFeatures = asRecord(g.features);
  const featureState = {} as GraphicsFeatureState;
  for (const id of GRAPHICS_FEATURE_IDS) {
    const v = rawFeatures[id];
    featureState[id] = typeof v === 'boolean' ? v : d.graphics.features[id];
  }
  return {
    graphics: {
      resolutionScale: clampNum(g.resolutionScale, 0.5, 1, d.graphics.resolutionScale),
      quality: QUALITIES.includes(g.quality as Quality) ? (g.quality as Quality) : d.graphics.quality,
      features: featureState,
      shadowMapSize: pickShadowMapSize(g.shadowMapSize, d.graphics.shadowMapSize),
      foliageDensity: clampNum(g.foliageDensity, 0, 1, d.graphics.foliageDensity),
    },
    audio: {
      master: clampNum(a.master, 0, 1, d.audio.master),
      music: clampNum(a.music, 0, 1, d.audio.music),
      sfx: clampNum(a.sfx, 0, 1, d.audio.sfx),
      ambience: clampNum(a.ambience, 0, 1, d.audio.ambience),
    },
    world: {
      // 24 is the same instant as 0; clamping to 24 would let a stored value
      // sit on an hour that wraps, so the top of the range is just under it
      timeOfDay: clampNum(w.timeOfDay, 0, 23.99, d.world.timeOfDay),
      windDirection: wrapTau(w.windDirection, d.world.windDirection),
      windSpeed: clampSea(w.windSpeed, 'windSpeed', d.world.windSpeed),
      amplitude: clampSea(w.amplitude, 'amplitude', d.world.amplitude),
      swellAmplitude: clampSea(w.swellAmplitude, 'swellAmplitude', d.world.swellAmplitude),
      swellPeriod: clampSea(w.swellPeriod, 'swellPeriod', d.world.swellPeriod),
      swellDirection: wrapTau(w.swellDirection, d.world.swellDirection),
    },
  };
}

/**
 * Push the world block onto the params the ENGINE reads (§V.62: a control that
 * only writes the store drives nothing, and this project has shipped twelve of
 * those). Called once at boot and on every settings change — main.ts owns the
 * subscription, this owns the mapping, and the mapping is what a test can hold.
 *
 * `oceanParams` is the single wind source in this project, which is why both
 * keys land there and nowhere else: the sim tick copies windSpeed/windDirection
 * into `state.wind` every frame, and the sails, the AI, the flags, the spray,
 * the palms, the rain slant and the weather cells' own drift all read one of
 * those two. A second writer anywhere would be overwritten within a frame.
 *
 * SAFE AGAINST THE §V.46 AMBIENT HOLD, which owns `windSpeed` and `amplitude`
 * as the weather field's blend `from` end: the hold's `restore()` ADOPTS any
 * value it did not itself publish, and this write is exactly that — the same
 * path a Tweakpane drag takes, and for the same documented reason. The other
 * four keys are not held and not touched by the field at all, so the swell is
 * the player's alone.
 *
 * A storm cell passing over the ship still moves windSpeed and amplitude ABOVE
 * what is set here, locally and while it lasts. That is §V.46 working, not
 * this control losing: the value here is the AMBIENT sea, which is what the
 * field blends away from and returns to.
 */
export function applyWorldSettings(w: WorldSettings): void {
  skyParams.timeOfDay = w.timeOfDay;
  oceanParams.windDirection = w.windDirection;
  oceanParams.windSpeed = w.windSpeed;
  oceanParams.amplitude = w.amplitude;
  oceanParams.swellAmplitude = w.swellAmplitude;
  oceanParams.swellPeriod = w.swellPeriod;
  oceanParams.swellDirection = w.swellDirection;
}

function clone(s: GameSettings): GameSettings {
  return {
    graphics: { ...s.graphics, features: { ...s.graphics.features } },
    audio: { ...s.audio },
    world: { ...s.world },
  };
}

/** does this graphics block still match the bundle its preset name promises */
export function presetIntact(g: GraphicsSettings): boolean {
  const bundle = QUALITY_BUNDLES[g.quality];
  if (!bundle) return false;
  if (g.resolutionScale !== bundle.resolutionScale) return false;
  if (g.shadowMapSize !== bundle.shadowMapSize) return false;
  if (g.foliageDensity !== bundle.foliageDensity) return false;
  return GRAPHICS_FEATURE_IDS.every((id) => g.features[id] === bundle.features[id]);
}

/** localStorage when in a browser; undefined elsewhere (memory-only store) */
function defaultStorage(): StorageLike | undefined {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    /* privacy modes can throw on access — treat as absent */
  }
  return undefined;
}

export function createSettingsStore(storage: StorageLike | undefined = defaultStorage()): SettingsStore {
  let state: GameSettings;
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    state = raw ? sanitizeSettings(JSON.parse(raw)) : clone(DEFAULT_SETTINGS);
  } catch {
    console.warn('[ui] settings load failed — using defaults');
    state = clone(DEFAULT_SETTINGS);
  }

  const listeners = new Set<SettingsListener>();

  function persist(): void {
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      console.warn('[ui] settings persist failed (storage unavailable/full)');
    }
  }

  function commit(next: unknown): void {
    state = sanitizeSettings(next);
    persist();
    for (const cb of listeners) cb(clone(state));
  }

  return {
    get: () => clone(state),
    set(patch: SettingsPatch): void {
      commit({
        graphics: {
          ...state.graphics,
          ...patch.graphics,
          features: { ...state.graphics.features, ...patch.graphics?.features },
        },
        audio: { ...state.audio, ...patch.audio },
        world: { ...state.world, ...patch.world },
      });
    },
    applyQuality(q: Quality): void {
      const bundle = QUALITY_BUNDLES[q] ?? QUALITY_BUNDLES[DEFAULT_SETTINGS.graphics.quality];
      // `world` is carried through untouched: a quality preset is a performance
      // decision and must never restage the scene's lighting behind the player
      commit({ graphics: { quality: q, ...bundle }, audio: state.audio, world: state.world });
    },
    resetWorld(): void {
      // the mirror image of applyQuality: graphics and audio are carried
      // through untouched, and the whole world block is rewritten from the
      // shipped defaults rather than patched key by key — a partial reset that
      // left `windSpeed` behind would strand exactly the player this is for
      commit({
        graphics: state.graphics,
        audio: state.audio,
        world: { ...DEFAULT_SETTINGS.world },
      });
    },
    isPresetIntact: () => presetIntact(state.graphics),
    hints: () => ({ ...QUALITY_PRESETS[state.graphics.quality] }),
    subscribe(cb: SettingsListener): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
