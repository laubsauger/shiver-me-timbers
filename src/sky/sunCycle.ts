/**
 * Pure day-cycle math (§V16 tunables in params; kept THREE-free so node
 * tests can prove it). The sun drives every other lit system — ocean SSS,
 * cloud color, fog — so direction continuity and clamped ramps are load
 * bearing, not cosmetic.
 *
 * Model: equinox sun (declination 0) at a given latitude. Hour angle H is 0
 * at noon, ±π at midnight; the direction is a pure rotation of a unit
 * vector, so it is normalized by construction and continuous across the
 * midnight wrap. Axes: +x east, +y up, +z south (matches three.js Y-up).
 */
import { skyParams, type SkyParams } from '../params/sky';

export type Vec3 = [number, number, number];
export type Rgb = [number, number, number];

export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/** Hermite smoothstep on scalars — same curve the shaders use. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** 0xRRGGBB → [r,g,b] in 0..1 (sRGB values, three.Color does the transfer). */
export function hexToRgb(hex: number): Rgb {
  return [
    ((hex >> 16) & 0xff) / 255,
    ((hex >> 8) & 0xff) / 255,
    (hex & 0xff) / 255,
  ];
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const u = clamp01(t);
  return [
    clamp01(a[0] + (b[0] - a[0]) * u),
    clamp01(a[1] + (b[1] - a[1]) * u),
    clamp01(a[2] + (b[2] - a[2]) * u),
  ];
}

/**
 * Unit vector from the origin toward the sun for a time of day (hours,
 * wraps mod 24) and latitude (degrees, defaults to the sky params value).
 */
export function sunDirection(
  timeOfDay: number,
  latitude: number = skyParams.latitude,
): Vec3 {
  const t = ((timeOfDay % 24) + 24) % 24;
  const H = (t / 24) * Math.PI * 2 - Math.PI; // 0 at noon
  const lat = (latitude * Math.PI) / 180;
  return [
    -Math.sin(H), // east in the morning (H<0), west in the evening
    Math.cos(H) * Math.cos(lat), // altitude, peaks at noon
    Math.cos(H) * Math.sin(lat), // noon sun sits south of zenith for lat>0
  ];
}

/** Sun elevation above the horizon in radians (negative at night). */
export function sunElevation(
  timeOfDay: number,
  latitude: number = skyParams.latitude,
): number {
  const y = sunDirection(timeOfDay, latitude)[1];
  return Math.asin(Math.min(1, Math.max(-1, y)));
}

/**
 * Sun light color vs elevation (radians): warm orange skimming the horizon,
 * white-gold at high noon, dimming to embers below the horizon. Components
 * always clamp to 0..1 — downstream materials multiply by this and must
 * never brighten past their own ramps.
 */
export function sunColor(elevation: number): Rgb {
  const low = hexToRgb(skyParams.sunColorLow);
  const noon = hexToRgb(skyParams.sunColorNoon);
  const day = mixRgb(low, noon, smoothstep(0.03, 0.5, elevation));
  // fade toward dark embers as the sun sinks; never fully black so dawn
  // pops back in smoothly instead of snapping
  const sink = smoothstep(-0.25, -0.02, elevation);
  return mixRgb([0.05, 0.02, 0.01], day, sink);
}

/**
 * Sky tint multiplier vs elevation: night navy → full white by mid-morning.
 * Applied to zenith/horizon colors and the fog color so the whole scene
 * darkens as one.
 *
 * `moonLift` (0..1, default 0 = the moonless night this function always
 * described) crossfades the NIGHT END of the ramp from `nightTint` to
 * `moonlitNightTint`. It only ever touches the night endpoint, so the ramp
 * above the horizon — and therefore the whole §T39 sunset — is bit-identical
 * whatever the moon is doing. The lift is the sky's OWN response to
 * moonlight: without it a full moon lights the ship and the water while the
 * dome behind them stays the same dead navy, which reads as a spotlight in a
 * cave rather than as a moonlit night.
 */
export function skyTint(elevation: number, moonLift: number = 0): Rgb {
  const night = mixRgb(
    hexToRgb(skyParams.nightTint),
    hexToRgb(skyParams.moonlitNightTint),
    moonLift,
  );
  // Edges are BELOW the horizon on purpose. They used to run to +0.28 rad,
  // which meant everything under ~16° elevation was being multiplied by a
  // navy tint — i.e. golden hour was quietly cooled and dimmed by ~40% more
  // in red than in blue, fighting the very grade §T39 wants. Full daylight
  // brightness now holds down to the horizon and only twilight darkens.
  return mixRgb(night, [1, 1, 1], smoothstep(-0.25, 0.02, elevation));
}

/**
 * Is the sun's DISC above the horizon, 0..1. The geometric half of
 * `daylight()`, and the only half that is allowed to reach 0: below the
 * horizon the earth occludes the beam, full stop.
 *
 * Edges are the APPARENT sunset, not the mathematical one — refraction lifts
 * the disc ~0.57° and the disc itself is ~0.53° across, so the direct beam
 * really dies over roughly ±1°. Widened to [-2.0°, +1.15°] so an accelerated
 * day clock dims rather than snaps: at a 1:1 clock the elevation rate near
 * the horizon is 0.253 rad/h, which walks this window in ~13 sim-minutes.
 */
export const SUN_BELOW = -0.035; // rad, -2.0°: disc fully set
export const SUN_CLEAR = 0.02; //  rad, +1.15°: disc fully clear of the horizon

export function sunAboveHorizon(elevation: number): number {
  return smoothstep(SUN_BELOW, SUN_CLEAR, elevation);
}

/**
 * Is a body's DISC drawable, 0..1 (§V91). Exactly 0 once the body's centre is
 * `radiusDeg + marginDeg` below the horizon, exactly 1 once it is `radiusDeg`
 * above it — i.e. the whole disc has cleared the sea. Multiplies every disc,
 * glow and halo term of the sun AND the moon in the sky background, so no
 * body is ever painted from under the water, through the world, or into the
 * Snell's window when it is not actually up.
 *
 * This is NOT `sunAboveHorizon()`: that gate is the key LIGHT's and its edges
 * are the apparent sunset widened for the day clock; this one is about the
 * PICTURE of the body and follows the authored disc size. Distinct on purpose
 * — widening the light's gate must not start drawing discs underwater.
 *
 * CPU scalar over elevation, delivered as a uniform — no per-fragment branch,
 * no pixel footprint (§V48 does not apply). Edge gap is floored (§V28).
 */
export function bodyHorizonGate(elevation: number, radiusDeg: number, marginDeg: number): number {
  const r = (Number.isFinite(radiusDeg) ? Math.max(0, radiusDeg) : 0) * (Math.PI / 180);
  const m = (Number.isFinite(marginDeg) ? Math.max(0, marginDeg) : 0) * (Math.PI / 180);
  const lo = -(r + m);
  const hi = Math.max(r, lo + MIN_EDGE_GAP);
  // @band-limited-elsewhere: CPU scalar over ELEVATION, once per frame, a uniform
  return smoothstep(lo, hi, elevation);
}

/**
 * Residual broadband strength of the beam, KEY_FLOOR..1 — never 0 while the
 * sun is up. The art-directed half of `daylight()`.
 *
 * WHY THIS IS NOT A PHOTOMETRIC AIR-MASS CURVE. Of the three things a real
 * low sun does to a scene, two are already modelled elsewhere and the third
 * we deliberately cannot model:
 *
 *  1. SPECTRAL extinction — the sun going orange — is `sunColor()`. Measured:
 *     `sunColorLow` (0xff9440) carries 0.473× the Rec.709 luminance of
 *     `sunColorNoon` (0xfff3da) in LINEAR space, so the colour term alone
 *     already more than halves the key's output by the time it reaches the
 *     horizon. A photometric brightness ramp stacked on top double-counts the
 *     same physics.
 *  2. cos(incidence) — the beam raking the deck and the sea rather than
 *     hitting them square — is N·L in every material. Free and correct.
 *  3. EXPOSURE. A real golden-hour photograph has a bright warm key on the
 *     subject because the photographer opened up ~2 stops. We tonemap at a
 *     FIXED exposure (1.1) with no adaptation, so a photometric ramp — the
 *     Kasten-Young beam is 0.18× the noon value at 4° elevation — renders
 *     golden hour as a silhouette against a still-bright sky. That is exactly
 *     the murk §T39 has to avoid. KEY_FLOOR is that missing exposure
 *     compensation, applied once, in the single place that owns the key.
 *
 * So the beam holds full strength through the whole golden hour and tapers
 * only inside the last ~6°, where the sky's own light is going too and the
 * taper reads as atmosphere instead of as a dimmer.
 *
 * The previous single ramp `smoothstep(-0.02, 0.18, e)` conflated (1)+(3)
 * with the horizon gate and did not reach full until 10.3°, while
 * `lowSunWarmth()` does not reach full until 4.6° — the two windows did not
 * overlap, so NO time of day had both a saturated sunset palette and a
 * full-strength key. Splitting the gate off is what makes them overlap; see
 * the "golden hour needs both" test.
 */
const KEY_FLOOR = 0.35; // beam strength left at the moment of sunset
const HAZE_EDGE = 0.1; //  rad, 5.7°: above this the beam is unattenuated

export function beamStrength(elevation: number): number {
  return KEY_FLOOR + (1 - KEY_FLOOR) * smoothstep(-0.02, HAZE_EDGE, elevation);
}

/**
 * 0..1 daylight factor for light intensities: 0 below the horizon, full
 * strength from ~6° up. Product of a geometric gate and an attenuation, so
 * it is bounded 0..1 and non-decreasing BY CONSTRUCTION (§V44 — bounded at
 * source, both factors are smoothsteps, never clamped after the fact).
 * Smooth so shadows never pop: the steepest point moves 9.5e-4 per
 * sim-second on a 1:1 clock.
 */
export function daylight(elevation: number): number {
  return sunAboveHorizon(elevation) * beamStrength(elevation);
}

/**
 * 0..1 "golden hour" factor — peaks when the sun skims the horizon, gone by
 * mid-morning. Scales the warm horizon tint and fog warm shift.
 */
export function lowSunWarmth(elevation: number): number {
  return smoothstep(-0.12, 0.0, elevation) * (1 - smoothstep(0.08, 0.4, elevation));
}

/** sRGB transfer function, one channel → linear. */
export function srgbToLinear(c: number): number {
  if (!Number.isFinite(c)) return 0;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** 0xRRGGBB → LINEAR [r,g,b], for maths that must happen in light space. */
export function hexToLinearRgb(hex: number): Rgb {
  const c = hexToRgb(hex);
  return [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])];
}

/** Rec.709 luminance. Only meaningful on LINEAR input. */
export function luminance(c: Rgb): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/**
 * Pull a colour toward its own luminance. amount 0 = untouched, 1 = grey.
 *
 * WHY THE LIGHT RIG NEEDS THIS: a sky colour chosen to look right when you
 * PAINT it is not the colour that sky DELIVERS as light. Our zenith is a
 * deep stylised blue with red at ~7% of blue in linear terms; real skylight
 * irradiance integrates the pale horizon band and the sun's aureole and
 * lands far closer to white. Feeding the painted colour straight into an
 * unshadowed HemisphereLight makes shade so blue-dominant that it overrides
 * albedo hue entirely — brown timber multiplied by (0.03, 0.13, 0.27) comes
 * out teal, which is the flat sea-coloured hull the user reported. Mixing
 * toward luminance (not toward white) kills the hue extremity while leaving
 * brightness mathematically untouched, so shade desaturates without
 * getting lighter.
 */
export function desaturate(c: Rgb, amount: number): Rgb {
  const a = clamp01(amount);
  const l = luminance(c);
  return [c[0] + (l - c[0]) * a, c[1] + (l - c[1]) * a, c[2] + (l - c[2]) * a];
}

/**
 * The scene's colour state for a sun elevation: the day palette crossfaded
 * to the golden-hour palette by lowSunWarmth().
 *
 * ONE source of truth on purpose (§T39). The sky background, the fog colour
 * and the hemisphere ambient all read this, so at sunset the sky, the haze
 * the islands melt into, and the light filling the ship's shaded side all
 * warm by the same weight at the same moment. Give each system its own
 * sunset handling and they drift apart — which is exactly what "warm sky
 * over a cold scene" looks like.
 */
export interface SkyPalette {
  zenith: Rgb;
  mid: Rgb;
  horizon: Rgb;
  ground: Rgb;
  /** 0..1 golden-hour weight, also the warm-tint amount */
  warm: number;
}

export function skyPalette(elevation: number, p: SkyParams): SkyPalette {
  const warm = clamp01(lowSunWarmth(elevation) * p.sunsetStrength);
  const blend = (dayHex: number, duskHex: number): Rgb =>
    mixRgb(hexToRgb(dayHex), hexToRgb(duskHex), warm);
  return {
    zenith: blend(p.zenithColor, p.sunsetZenithColor),
    mid: blend(p.midColor, p.sunsetMidColor),
    horizon: blend(p.horizonColor, p.sunsetHorizonColor),
    ground: blend(p.groundBounceColor, p.sunsetGroundColor),
    warm,
  };
}

/**
 * The sky background's BAND GEOMETRY for a given golden-hour weight.
 *
 * Sole owner of "what shape is the sky", the same way skyPalette() owns
 * "what colour is the sky", and driven by the SAME `warm` weight so the two
 * can never disagree (§T39). Kept here rather than inline in the background
 * module so the shape is one testable function instead of two lerps buried
 * next to uniform writes.
 *
 * WHY THE SHAPE HAS TO MOVE AT ALL. The day geometry is correct for the day:
 * a broad pale haze wedge and a high-biased zenith curve are what
 * docs/final-full-result.png shows at a midday sun, and that look is signed
 * off. But `height = lift^gradientCurve` uses lift = sin(elevation), so at
 * 30° — the top of a frame that is mostly sea — lift is only 0.5 and a curve
 * of 1.5 leaves height at 0.35. The sky is still 65% midColor there, and the
 * zenith hue never enters the shot at all. With the sunset palette that
 * strands the rose-indigo overhead and leaves the visible window running
 * cream → terracotta, every stop an orange: the "single-coloured" report.
 *
 * Measured RGB spread across the 0-30° window at warm=1: 0.411 with the day
 * geometry, 0.561 with this one (+36%). The curve is the dominant term
 * (0.514 on its own) and the haze wedge the smaller half (0.446 on its own),
 * so both move together — neither alone clears the bar the test pins.
 */
export interface BandGeometry {
  hazeFalloff: number;
  gradientCurve: number;
}

export function bandGeometry(warm: number, p: SkyParams): BandGeometry {
  const w = clamp01(warm);
  return {
    hazeFalloff: p.hazeFalloff + (p.sunsetHazeFalloff - p.hazeFalloff) * w,
    gradientCurve: p.gradientCurve + (p.sunsetGradientCurve - p.gradientCurve) * w,
  };
}

/**
 * The two colours the HemisphereLight is driven with, for a given night→day
 * tint. Sole owner of the "which sky colour lights the scene" decision, so
 * the answer is one testable function rather than a line buried in the light
 * rig: the SKY half is the sky's bulk colour (mid), never the zenith, and
 * both halves are desaturated before they light anything. Inputs are sRGB
 * triples from skyPalette(), so the ambient inherits the sunset crossfade.
 *
 * RETURNS LINEAR, not sRGB — the caller must write it with a linear setter.
 * The desaturation has to happen in linear space because that is where the
 * multiply against albedo happens; doing it in sRGB looks like the same
 * operation and silently under-corrects, which is exactly how the teal hull
 * survived a first attempt at this fix.
 */
export function hemisphereColors(
  midRgb: Rgb,
  groundRgb: Rgb,
  tint: Rgb,
  desaturation: number,
): { sky: Rgb; ground: Rgb } {
  const prep = (c: Rgb): Rgb => {
    const l: Rgb = [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])];
    return desaturate([l[0] * tint[0], l[1] * tint[1], l[2] * tint[2]], desaturation);
  };
  return { sky: prep(midRgb), ground: prep(groundRgb) };
}

/** smallest gap we allow between two smoothstep edges (§V28: e0 == e1 → 0/0) */
const MIN_EDGE_GAP = 1e-5;

/**
 * Cosine edges for the analytic sun disc, from its angular radius and soft
 * edge in DEGREES. Returned as [outer, inner] for `smoothstep(outer, inner,
 * dot(view, sun))` — cosine falls as the angle grows, so the OUTER edge is
 * the SMALLER number and must stay strictly below the inner one. A zero or
 * negative softness (param typed to 0) would collapse both edges onto each
 * other and smoothstep divides by (e1 - e0) → NaN across the whole sky, so
 * the gap is floored here rather than trusted from the panel (§V28).
 */
export function sunDiscCosines(sizeDeg: number, softnessDeg: number): [number, number] {
  const size = Number.isFinite(sizeDeg) ? Math.max(0, sizeDeg) : 0;
  const soft = Number.isFinite(softnessDeg) ? Math.max(0, softnessDeg) : 0;
  const inner = Math.cos((size * Math.PI) / 180);
  const outer = Math.cos(((size + soft) * Math.PI) / 180);
  return [Math.min(outer, inner - MIN_EDGE_GAP), inner];
}

/**
 * Sanitized linear-fog range in meters. three's fog factor is
 * (far - depth) / (far - near) — equal or inverted endpoints divide by zero
 * and NaN out every fogged fragment, so the ordering is enforced here (§V28).
 * Callers keep authoring near/far freely in the panel.
 */
export function fogRange(near: number, far: number): [number, number] {
  const n = Number.isFinite(near) ? Math.max(0, near) : 0;
  const f = Number.isFinite(far) ? far : n + 1;
  return [n, Math.max(f, n + 1)];
}
