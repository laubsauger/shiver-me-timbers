/**
 * THE TRAILER'S LOOK PER TIME OF DAY (docs/cine/speedboat-trailer-v1.md §Look). Every shot names a `timeOfDay`
 * (shotlist.ts) and takes its world patch from here, so the sky, the exposure and the live grade values are one
 * decision per time, not sixteen.
 *
 *   sunset  01–09  the sun 3–3.5° over the western horizon, amber, deep shadows
 *   dusk    10     the time cut: the sun 5° under the horizon, the sky going blue, LED strips coming on
 *   night   11–16  moonlit, the boats' LEDs own the frame
 *
 * WHY THE SKY IS REWRITTEN AND NOT JUST GRADED. The first takes were pink and hazy: the engine's golden-hour palette
 * (params/sky.ts) is rose-salmon through the body (`sunsetMidColor` #e37156) with a mauve zenith, at the game's exposure
 * 1.1 and a 0.95 ambient from `glass`. A gain can take some pink out, but the haze and the lifted shadow are in the
 * render. Measured side by side in the browser (720p look pass, grade identity vs CINE_SUNSET vs these skies): the grade
 * alone left the sky pink; the amber palette at exposure 0.74 / ambient 0.42 is what gave amber water and a dark hull;
 * exposure 0.62 / ambient 0.32 crushed the livery to black.
 *
 * EVERY TIME WRITES THE SAME KEYS. The director re-applies a shot's patch every tick and never resets between shots
 * (cine/director.ts), so a night shot that left `gainB` alone would inherit the sunset's warm gain in a `record({ only })`
 * that runs night before sunset. Each block below lists the full key set.
 *
 * The sun's AZIMUTH is not a per-shot control on this engine: at an equinox sun every sunset is due west (sky/sunCycle.ts,
 * −sin H on x). Backlight vs side-light is chosen by the boat's heading and the lens, per shot (locations.ts `bayDetail`).
 *
 * NIGHT is §T.209's moonlit preset (sky/nightPreset.ts MOONLIT_NIGHT: 22:00, half moon), written through the world
 * patch like every other time. The boats' LEDs follow the sky's `nightFactor` in the game; a shot pins them instead
 * (`TIME_LED`, page/boatLights.ts `setOverride`), so a take's LED level is a decision, not a side effect of the sun.
 * The white clouds and wind lines at night are T209's follow-up, not hand-fixed here.
 */
import type { WorldPatch } from '../../cine/types';
import { CINE_SUNSET } from '../../grade';
import { MOONLIT_NIGHT } from '../../sky/nightPreset';
import { raceTimeHour } from '../page/raceTime';

export type TrailerTime = 'sunset' | 'dusk' | 'night' | 'noon' | 'golden';
export const TRAILER_TIMES: readonly TrailerTime[] = ['sunset', 'dusk', 'night', 'noon', 'golden'];

type SkyPatch = NonNullable<WorldPatch['sky']>;
type GradePatch = NonNullable<WorldPatch['grade']>;

/** the sky keys every time writes (see the header) */
const SKY_DEFAULTS: SkyPatch = {
  exposure: 1.1,
  zenithColor: 0x336cb1,
  midColor: 0x558fbe,
  horizonColor: 0xa1e7ff,
  sunsetZenithColor: 0x6f5473,
  sunsetMidColor: 0xe37156,
  sunsetHorizonColor: 0xffd183,
  sunsetGradientCurve: 0.6,
  horizonWarmColor: 0xffaf57,
  horizonWarmStrength: 0.45,
  sunColorLow: 0xff9440,
  hazeStrength: 0.5,
  ambientIntensity: 0.7,
  moonPhase: 0.5,
  sunDiscSize: 1.1,
  sunDiscIntensity: 14,
  sunGlowPower: 240,
  sunGlowStrength: 1.2,
  sunHaloPower: 6,
  sunHaloStrength: 0.16,
};

const SUNSET_SKY: SkyPatch = {
  ...SKY_DEFAULTS,
  exposure: 0.77,
  // amber through the body, a slate-blue zenith pulled low (curve 0.45) for depth, a hot gold horizon band. The first
  // amber pass (#d6752e mid, curve 0.6) read as one flat orange card from horizon to frame top.
  sunsetZenithColor: 0x34405a,
  sunsetMidColor: 0xc27d45,
  sunsetHorizonColor: 0xffb860,
  sunsetGradientCurve: 0.45,
  horizonWarmColor: 0xff8c2a,
  horizonWarmStrength: 0.7,
  sunColorLow: 0xff7a20,
  hazeStrength: 0.5,
  // the shadow side of the hull goes properly dark (0.95 under `glass` lifted it to grey)
  ambientIntensity: 0.42,
  // USER (look-pass review): the sun in the at-rest frames was "too blown out" — a huge bloom disc and water glare
  // clipping to white on the right of the frame. A smaller, tighter disc and a pulled-in glow/halo keep the warm glow
  // around it without the white card (05/04/08 side by side at three settings; this is the middle one)
  sunDiscSize: 0.7,
  sunDiscIntensity: 22,
  sunGlowPower: 600,
  sunGlowStrength: 0.6,
  sunHaloPower: 10,
  sunHaloStrength: 0.08,
};

/**
 * DUSK. Under the horizon the sky's golden-hour weight falls away (sky/sunCycle.ts lowSunWarmth: ~0.2 at −5°), so the
 * DAY palette paints most of it — the first dusk takes were a noon-blue sky with white clouds (coordinator review of
 * look_v2). The day hexes are therefore twilight here: an indigo zenith, a slate-blue body and a rose-amber horizon band,
 * so the last light reads amber-to-blue whichever weight the sky picks.
 */
const DUSK_SKY: SkyPatch = {
  ...SUNSET_SKY,
  exposure: 0.95,
  zenithColor: 0x141d3a,
  midColor: 0x33406a,
  horizonColor: 0xd98a5a,
  sunsetZenithColor: 0x1d2a4a,
  sunsetMidColor: 0x6a5a78,
  sunsetHorizonColor: 0xe0864a,
  horizonWarmStrength: 0.5,
  ambientIntensity: 0.5,
};

const NIGHT_SKY: SkyPatch = {
  ...SKY_DEFAULTS,
  exposure: 0.9,
  moonPhase: MOONLIT_NIGHT.moonPhase,
};

/**
 * DAY LOOKS for the edit's time-lapse (10's `noon` / `golden` variants): the race Time option's own clocks (page/raceTime.ts
 * labels '12:00' / '17:30'), the engine's shipped day palette, no hand-tuned sky. Untuned first pass: judged on the look
 * pass, not by numbers.
 */
const DAY_SKY: SkyPatch = { ...SKY_DEFAULTS };

/** the grade mode's own values, with the blue gain eased off: at 0.88 the sky, the sea and the hull were one orange */
const SUNSET_GRADE: GradePatch = { ...CINE_SUNSET.grade, gainB: 0.92, saturation: 1.0 };
/** half-way back to neutral: the warm gain would turn the blue hour brown */
const DUSK_GRADE: GradePatch = { ...SUNSET_GRADE, gainR: 1.0, gainG: 0.99, gainB: 0.96, highlightTintR: 0.58, highlightTintG: 0.52, highlightTintB: 0.44, splitStrength: 0.12 };
/** noon: the grade node stays on (a construction gate) but neutral — no warm gain on a blue midday sea */
const NOON_GRADE: GradePatch = { ...SUNSET_GRADE, liftR: 0, liftG: 0, liftB: 0, gammaR: 1, gammaG: 1, gammaB: 1, gainR: 1, gainG: 1, gainB: 1, saturation: 1.0, splitStrength: 0, highlightTintR: 0.5, highlightTintG: 0.5, highlightTintB: 0.5, shadowTintR: 0.5, shadowTintG: 0.5, shadowTintB: 0.5 };
/** golden hour: dusk's half-way warmth over the shipped day sky */
const GOLDEN_GRADE: GradePatch = { ...DUSK_GRADE };
/** deep blacks, a cool shadow, NEUTRAL highlights so the LED colours and lamps stay their own */
const NIGHT_GRADE: GradePatch = {
  ...SUNSET_GRADE,
  liftR: -0.015,
  liftG: -0.015,
  liftB: -0.01,
  gammaR: 1.0,
  gammaG: 1.0,
  gammaB: 1.0,
  gainR: 1.0,
  gainG: 1.0,
  gainB: 1.02,
  saturation: 1.05,
  splitStrength: 0.1,
  shadowTintR: 0.44,
  shadowTintG: 0.48,
  shadowTintB: 0.58,
  highlightTintR: 0.5,
  highlightTintG: 0.5,
  highlightTintB: 0.5,
};

type PostPatch = NonNullable<WorldPatch['post']>;
type SurfacePatch = NonNullable<WorldPatch['oceanSurface']>;
/**
 * The lens's DOF, written by every time so a shot that sets none gets the shipped depth of field (params/post.ts), not
 * the last insert's. Found in the first v2 look pass: 07 recorded after 06 inherited 06's 0.9 m focus range and bokeh 5
 * and was soft from end to end, 14b inherited 14a's (her LED hull read as an orange blob). `focusShip` still moves the
 * focus distance every frame on top.
 */
const LENS: PostPatch = { dofFocus: 28, dofRange: 45, dofBokeh: 2 };
/** the lens: later, softer bloom and a quieter streak/flare on the low sun, the rest of CINE_SUNSET's optics as they are */
const SUNSET_POST: PostPatch = { ...LENS, bloomThreshold: 1.0, bloomStrength: 0.45, streakStrength: 0.3, flareStrength: 0.45 };
/** the LEDs and the lamps are the only highlights at night: the grade mode's earlier, stronger bloom */
const NIGHT_POST: PostPatch = {
  ...LENS,
  bloomThreshold: CINE_SUNSET.post?.bloomThreshold,
  bloomStrength: CINE_SUNSET.post?.bloomStrength,
  streakStrength: CINE_SUNSET.post?.streakStrength,
  flareStrength: CINE_SUNSET.post?.flareStrength,
};
/** the sun road on the water: the glare highlight was the other half of the blown-out right edge */
const SUNSET_SURFACE: SurfacePatch = { glintRoadStrength: 0.5, sparkleStrength: 0.75 };
/** the shipped values (params/oceanSurface.ts): the moon's road is not the problem */
const NIGHT_SURFACE: SurfacePatch = { glintRoadStrength: 0.75, sparkleStrength: 1.0 };

/**
 * CLOUDS (USER: "a handful more clouds in the sky for some day/sunset shots… keep night clouds sparse and dim"). The
 * count of cumulus clusters on the ring (params/clouds.ts `clusterCount`; the weather rungs put 3–6 up): more at sunset,
 * fewer at dusk, sparse at night, where T209 dims them. A layout key — a variant look regenerates the lobe set.
 */
const SUNSET_CLOUDS: NonNullable<WorldPatch['clouds']> = { clusterCount: 11 };
const DUSK_CLOUDS: NonNullable<WorldPatch['clouds']> = { clusterCount: 7 };
const NIGHT_CLOUDS: NonNullable<WorldPatch['clouds']> = { clusterCount: 3 };

/** the world patch for a time; the shot adds its weather, ocean and post on top */
export const TIME_LOOK: Readonly<Record<TrailerTime, WorldPatch>> = {
  sunset: { sunElevationDeg: 3, sunSide: 'evening', sky: SUNSET_SKY, grade: SUNSET_GRADE, post: SUNSET_POST, oceanSurface: SUNSET_SURFACE, clouds: SUNSET_CLOUDS },
  // −4°: at −3° the palette was still lavender-orange; −5° with the day palette was a noon sky (see DUSK_SKY)
  dusk: { sunElevationDeg: -4, sunSide: 'evening', sky: DUSK_SKY, grade: DUSK_GRADE, post: NIGHT_POST, oceanSurface: NIGHT_SURFACE, clouds: DUSK_CLOUDS },
  // timeOfDay, not an elevation: T209's preset is a clock + a moon phase, and the moon's place depends on both
  night: { timeOfDay: MOONLIT_NIGHT.timeOfDay, sky: NIGHT_SKY, grade: NIGHT_GRADE, post: NIGHT_POST, oceanSurface: NIGHT_SURFACE, clouds: NIGHT_CLOUDS },
  // the race Time labels' clocks; the sun's own place, the shipped sea glint, the day cloud count
  noon: { timeOfDay: raceTimeHour('12:00') ?? 12, sky: DAY_SKY, grade: NOON_GRADE, post: SUNSET_POST, oceanSurface: NIGHT_SURFACE, clouds: SUNSET_CLOUDS },
  golden: { timeOfDay: raceTimeHour('17:30') ?? 17.5, sky: DAY_SKY, grade: GOLDEN_GRADE, post: SUNSET_POST, oceanSurface: SUNSET_SURFACE, clouds: SUNSET_CLOUDS },
};

/**
 * The LED level per time, pinned for the whole take (0..1). Sunset: off — at 3° the sky's night factor is 0 anyway, and a
 * pinned 0 keeps a sunset VARIANT of a night shot from lighting up. Dusk: 0.4, "the strips just on" (T209: the sky's
 * night factor only starts under +1.7° and a variant must not depend on it). Night: full.
 */
export const TIME_LED: Readonly<Record<TrailerTime, number>> = { sunset: 0, dusk: 0.4, night: 1, noon: 0, golden: 0 };

