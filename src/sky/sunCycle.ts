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
import { skyParams } from '../params/sky';

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
 */
export function skyTint(elevation: number): Rgb {
  const night = hexToRgb(skyParams.nightTint);
  return mixRgb(night, [1, 1, 1], smoothstep(-0.12, 0.28, elevation));
}

/**
 * 0..1 daylight factor for light intensities: 0 below the horizon, full
 * strength once the sun clears ~10°. Smooth so shadows never pop.
 */
export function daylight(elevation: number): number {
  return smoothstep(-0.02, 0.18, elevation);
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
 * The two colours the HemisphereLight is driven with, for a given night→day
 * tint. Sole owner of the "which sky colour lights the scene" decision, so
 * the answer is one testable function rather than a line buried in the light
 * rig: the SKY half is the sky's bulk colour (mid), never the zenith, and
 * both halves are desaturated before they light anything.
 *
 * RETURNS LINEAR, not sRGB — the caller must write it with a linear setter.
 * The desaturation has to happen in linear space because that is where the
 * multiply against albedo happens; doing it in sRGB looks like the same
 * operation and silently under-corrects, which is exactly how the teal hull
 * survived a first attempt at this fix.
 */
export function hemisphereColors(
  midHex: number,
  groundHex: number,
  tint: Rgb,
  desaturation: number,
): { sky: Rgb; ground: Rgb } {
  const prep = (hex: number): Rgb => {
    const c = hexToLinearRgb(hex);
    return desaturate([c[0] * tint[0], c[1] * tint[1], c[2] * tint[2]], desaturation);
  };
  return { sky: prep(midHex), ground: prep(groundHex) };
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
