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
