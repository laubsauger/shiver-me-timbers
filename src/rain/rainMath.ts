/**
 * Rain math (§T.37, §V47) — PURE, no three. The CPU mirror of everything the
 * rain shader does that is worth asserting headlessly: the wind agreement, the
 * slant it produces, the wrap, and the density gate.
 *
 * These are not helper trivia. §V47's whole claim is that rain is driven by the
 * SAME wind the sea and the sails read; `rainWindVector` is the single place
 * that wind is turned into a rain velocity, and it takes its inputs from
 * oceanParams at the call site so there is nothing to keep in sync.
 */
import { oceanParams } from '../params/ocean';
import { rainParams } from '../params/rain';

const fin = (v: number, fallback: number): number =>
  Number.isFinite(v) ? v : fallback;

export interface RainWind {
  x: number;
  z: number;
}

/**
 * Horizontal advection applied to every drop, in m/s.
 *
 * CONVENTION: (cos θ, sin θ) → (x, z), byte-for-byte the mapping main.ts uses
 * to build the spray wind and the sailing rig uses for apparent wind. If this
 * ever disagrees, rain slants one way while the sea runs the other.
 */
export function rainWindVector(
  direction: number,
  speed: number,
  carry: number,
): RainWind {
  const dir = fin(direction, 0);
  const spd = Math.max(fin(speed, 0), 0);
  const c = Math.max(fin(carry, 0), 0);
  return { x: Math.cos(dir) * spd * c, z: Math.sin(dir) * spd * c };
}

/** the live wind the rain actually uses — read straight off oceanParams (§V47) */
export function liveRainWind(): RainWind {
  return rainWindVector(
    oceanParams.windDirection,
    oceanParams.windSpeed,
    rainParams.windCarry,
  );
}

/**
 * Angle (radians) the streaks lean off vertical, given the horizontal wind
 * speed carried and the fall speed. 0 = straight down. This is what "rain is
 * actually flying left and right" measures out to.
 */
export function rainSlant(horizontalSpeed: number, fallSpeed: number): number {
  const h = Math.abs(fin(horizontalSpeed, 0));
  // floored divisor (§V28): fallSpeed is a live slider and can be dragged to 0
  const v = Math.max(fin(fallSpeed, 0), 1e-3);
  return Math.atan2(h, v);
}

/**
 * Wrap a camera-relative offset into [−size/2, size/2). The drops live in WORLD
 * space (so they are advected by wind and stream past a moving ship correctly)
 * and this is what keeps one instance of each of them inside the box around the
 * camera. CPU mirror of the shader's wrap.
 */
export function wrapOffset(d: number, size: number): number {
  const s = Math.max(fin(size, 0), 1e-3); // divisor floor (§V28)
  const v = fin(d, 0);
  return v - s * Math.floor(v / s + 0.5);
}

/**
 * Depth (m, negative) below mean sea level at which a drop is fully culled.
 *
 * §V36: expressed as a MULTIPLE OF σ, the sea's height RMS, never as absolute
 * metres. The rain volume wraps vertically so drops exist under the waterline
 * too, and the water is see-through in the near field (§V24) — those would
 * read as streaks falling through the sea. A fixed metre cut would clip rain
 * out of the troughs in a storm and leave sub-surface streaks in a calm,
 * because a trough is ≈ −2σ deep whatever the sea state.
 */
export function seaCullDepth(seaSigma: number, cullSigma: number): number {
  const sigma = Math.max(fin(seaSigma, 0), 0);
  const k = Math.max(fin(cullSigma, 0), 0);
  return -sigma * k;
}

/** build-time pool sizing — sanitized once, then it sizes the mesh (§V28) */
export function sanitizeRainCount(raw: number, fallback = 4096): number {
  const n = Math.floor(fin(raw, fallback));
  return Math.min(Math.max(Number.isInteger(n) ? n : fallback, 1), 200000);
}

/**
 * How many drops are live at a given rain intensity (0..1 from
 * `weatherAt().rain`). Drops past this index are collapsed to ZERO SIZE, never
 * merely faded: an alpha-0 quad still rasterizes, and 12k of them is fill rate
 * spent on nothing (§V28, §B5).
 */
export function activeRainCount(count: number, intensity: number): number {
  const n = Math.max(Math.floor(fin(count, 0)), 0);
  const i = Math.min(Math.max(fin(intensity, 0), 0), 1);
  return Math.floor(n * i);
}
