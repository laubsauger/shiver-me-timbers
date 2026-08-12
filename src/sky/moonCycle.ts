/**
 * Moon cycle + THE KEY LIGHT (§V16 tunables in params; THREE-free so node
 * tests can prove it).
 *
 * ── WHY THERE IS NO SECOND LIGHT ────────────────────────────────────────
 * A moon is 384,000 km away, so its rays are parallel: it is a DIRECTIONAL
 * source, exactly like the sun. That means it does not need a light of its
 * own — it needs the sun's rig pointed somewhere else and tinted differently.
 * `sky.sunDirection` and `sky.sunLight` are read by the ocean glints, the
 * caustics, the clouds, the god rays, the island terrain and the shadow map
 * (src/main.ts:286-1073), so re-aiming that ONE pair buys moon shadows, a
 * moon glint road and moonlit caustics for free and without touching a single
 * file owned by another system. Those two handles are therefore no longer
 * "the sun" — they are THE KEY, whichever body currently owns it.
 *
 * ── THE HANDOVER, AND WHY IT CANNOT BE A SLERP ──────────────────────────
 * A full moon is by definition ANTIPODAL to the sun, so at the moment of
 * sunset the two directions are exactly opposite and every interpolation
 * between them is degenerate: normalize(lerp(d, -d, 0.5)) is normalize(0),
 * i.e. NaN over the whole sky (§V28). Slerp is no better — the great circle
 * through two antipodal points is undefined.
 *
 * So the handover is engineered instead of interpolated, in two halves:
 *
 *   1. The swing happens in a window where the key is PROVABLY DARK. The
 *      sun's own gate `sunAboveHorizon()` reaches exactly 0 at SUN_BELOW
 *      (-0.035 rad), and the moon's ramp does not leave 0 until HANDOVER_END
 *      (-0.10 rad). Between those two elevations both terms are exactly zero,
 *      so the key direction may move however it likes and NOTHING is lit by
 *      it. `keyLight()` puts the entire 180° swing inside that dead window.
 *   2. The path goes through the NADIR, not through the horizon. Two
 *      non-degenerate lerps (sun → straight down → moon) instead of one
 *      degenerate one. This is not merely a singularity dodge: it keeps the
 *      key's `.y` at or below 0 for the whole swing, and `.y` is what the
 *      ocean's `sunUpFactor` and the caustics' `sunUp` gate on. Route the
 *      swing across the horizon instead and those gates flicker on and off
 *      mid-twilight — a glint road strobing on empty water.
 *
 * ── COLOUR (read this before "fixing" it) ───────────────────────────────
 * Moonlight is NOT blue. It is sunlight reflected off a grey body, ~4100 K,
 * spectrally very close to the sun and if anything slightly WARMER than
 * daylight. The blue everyone associates with night is the PURKINJE SHIFT in
 * human scotopic vision — rods peak ~498 nm and take over below ~0.1 cd/m²,
 * so the eye's own response goes blue, not the light. `moonColor` is
 * therefore a deliberate, named STYLISATION of a perceptual effect, not a
 * physical claim, and this comment exists so nobody later "corrects" it into
 * a physics bug in either direction.
 *
 * ── INTENSITY (§T39's KEY_FLOOR argument, applied a second time) ────────
 * A full moon delivers ~0.25 lux against the sun's ~100,000: 1/400,000. That
 * ratio is unusable here for exactly the reason `beamStrength()` documents —
 * we tonemap at a FIXED exposure (1.1) with no adaptation, while a real
 * observer at night is running several thousand-fold of pupil and retinal
 * gain. Feeding the physical ratio to a fixed exposure renders a black frame,
 * which is not "realistic", it is unexposed. `moonIntensity` is that missing
 * adaptation, applied once, in the single place that owns the key — the same
 * move, for the same reason, as KEY_FLOOR.
 */
import { skyParams, type SkyParams } from '../params/sky';
import {
  SUN_BELOW,
  clamp01,
  hexToRgb,
  smoothstep,
  sunAboveHorizon,
  sunColor,
  sunDirection,
  sunElevation,
  daylight,
  type Rgb,
  type Vec3,
} from './sunCycle';

/** rad. Below this sun elevation the key direction is fully the moon's. */
export const HANDOVER_END = -0.1;
/** rad. Below this sun elevation the moon's key is at full strength. */
export const NIGHT_FULL = -0.25;

/**
 * Opposition surge. The moon's brightness is strongly NON-linear in its
 * illuminated fraction: a first-quarter moon shows half a disc but delivers
 * only ~8% of a full moon's light, because at full phase the shadows cast by
 * its own regolith all hide directly behind the grains that cast them. The
 * true exponent implied by 0.5^k = 0.08 is k = 3.64; we take 2.5 as an
 * art-directed compromise, because at 3.64 anything short of a nearly-full
 * moon is indistinguishable from a moonless night and the phase param stops
 * being a usable knob. Deliberate, and named so the deviation is visible.
 */
const MOON_SURGE = 2.5;

/**
 * Unit vector toward the moon.
 *
 * The moon's hour angle LAGS the sun's by its phase angle — that lag IS the
 * phase. So the moon at phase p is simply the sun 24·p hours ago, which
 * reuses `sunDirection()` wholesale and is therefore normalized, continuous
 * across midnight and correct at every latitude by construction.
 *
 * Sanity: at phase 0.5 (full) the offset is 12 h, i.e. exactly antipodal to
 * the sun, so the moon rises at sunset and culminates at local midnight —
 * which is what a full moon does. At phase 0 (new) it sits on the sun.
 */
export function moonDirection(
  timeOfDay: number,
  phase: number = skyParams.moonPhase,
  latitude: number = skyParams.latitude,
): Vec3 {
  return sunDirection(timeOfDay - 24 * clamp01(phase), latitude);
}

/** Moon elevation above the horizon in radians (negative when it has set). */
export function moonElevation(
  timeOfDay: number,
  phase: number = skyParams.moonPhase,
  latitude: number = skyParams.latitude,
): number {
  const y = moonDirection(timeOfDay, phase, latitude)[1];
  return Math.asin(Math.min(1, Math.max(-1, y)));
}

/**
 * Fraction of the moon's disc that is lit, 0..1. Standard half-angle result:
 * the terminator is a cosine of the phase angle 2π·phase, so the lit fraction
 * is (1 - cos φ)/2 — 0 at new, 1/2 at the quarters, 1 at full.
 */
export function moonIllumination(phase: number): number {
  return (1 - Math.cos(2 * Math.PI * clamp01(phase))) / 2;
}

/** Light actually delivered for a phase, 0..1 — illumination + MOON_SURGE. */
export function moonBrightness(phase: number): number {
  return Math.pow(moonIllumination(phase), MOON_SURGE);
}

/**
 * Is the moon's disc up, 0..1. Same edges as the sun's gate — the geometry of
 * a body setting is the geometry of a body setting — and the only factor here
 * allowed to reach 0.
 */
export function moonAboveHorizon(elevation: number): number {
  return sunAboveHorizon(elevation);
}

/**
 * How far the night has taken over from the sun, 0..1. Zero while the sun's
 * own gate is still alive (elevation ≥ HANDOVER_END), so the moon can never
 * add key light to a scene the sun is still lighting — which is both the
 * physical truth (you cannot see moonlight at sunset) and the guarantee that
 * §T39's signed-off 17.3 sunset is bit-identical: at 10.14° this is exactly 0.
 */
export function nightRamp(sunElev: number): number {
  // @band-limited-elsewhere: CPU scalar ramp over SUN ELEVATION, evaluated
  // once per frame on the host. There is no spatial coordinate and no pixel
  // footprint here — this value reaches the GPU as a uniform, never as a
  // per-fragment edge. §V.48 does not apply and fwidth() is not defined.
  return 1 - smoothstep(NIGHT_FULL, HANDOVER_END, sunElev);
}

/** rad, +1.7°: the sun is low enough that lamps start to be lit */
export const LAMP_ON = 0.03;
/** rad, -12°: nautical twilight — every practical light is full on */
export const LAMP_FULL = -0.21;

/**
 * "HOW DARK IS IT", 0..1 — THE single clock for every practical light in the
 * world: the ship's lanterns, the lighthouse lamp, hut windows, any emissive
 * that should be off in daylight.
 *
 * Deliberately NOT `moonWeight`. A new-moon night is pitch dark and is the
 * night that needs lamps MOST; keying lamps off the moon would switch them
 * off exactly then. And deliberately not a second time-of-day source either:
 * it is a pure function of `sunElevation`, which `sunCycle` already owns, so
 * there is one clock in this project and every consumer reads it. A system
 * that derives its own dusk from `timeOfDay` is where §V.55's whole family of
 * bugs starts — two clocks that agree today and drift the moment either moves.
 *
 * Edges are the human ones rather than the geometric ones: lamps go on around
 * sunset (a little before, as they really are) and are full by nautical
 * twilight, well before the sky is black.
 */
export function nightFactor(sunElev: number): number {
  // CPU scalar ramp over SUN ELEVATION, evaluated once per frame on the host
  // and delivered as a uniform — no spatial coordinate, no pixel footprint.
  // @band-limited-elsewhere: not a fragment edge; fwidth() is not defined here.
  return 1 - smoothstep(LAMP_FULL, LAMP_ON, sunElev);
}

/**
 * The moon's share of the key, 0..1. Bounded at source (§V44): a product of
 * three factors each independently bounded 0..1, never clamped after the
 * fact, and zero whenever ANY of them is zero.
 */
export function moonKeyWeight(sunElev: number, moonElev: number, phase: number): number {
  return moonAboveHorizon(moonElev) * moonBrightness(phase) * nightRamp(sunElev);
}

/**
 * How far the key DIRECTION has swung from the sun to the moon, 0..1.
 *
 * Deliberately a different ramp from `nightRamp` and deliberately DISJOINT
 * from it: this one finishes (reaches 1 at HANDOVER_END) exactly where that
 * one starts. The gap between SUN_BELOW and HANDOVER_END is the dead window
 * the header describes — the only elevations at which this value is strictly
 * between 0 and 1, and the sun contributes 0 across all of them.
 */
export function keyDirectionWeight(sunElev: number): number {
  // @band-limited-elsewhere: CPU scalar ramp over SUN ELEVATION — see
  // nightRamp() above. Uniform, not a fragment edge.
  return 1 - smoothstep(HANDOVER_END, SUN_BELOW, sunElev);
}

/** floor for any normalize() (§V28: normalize(0) is NaN, not 0) */
const MIN_LEN = 1e-6;

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!(len > MIN_LEN)) return [0, -1, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
}

function lerpDir(a: Vec3, b: Vec3, t: number): Vec3 {
  return normalize([
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ]);
}

/** straight down — the waypoint the sun→moon swing routes through */
const NADIR: Vec3 = [0, -1, 0];

/**
 * Blend the key direction from the sun to the moon THROUGH THE NADIR.
 *
 * Two non-degenerate halves rather than one degenerate lerp; see the header
 * for why a direct interpolation cannot work at full moon. The endpoints of
 * each half are ~90° apart at every elevation this function is called at, so
 * neither lerp can collapse to the zero vector, and the returned `.y` never
 * rises above max(a.y, b.y) — which is what keeps the ocean's and the
 * caustics' `.y` gates quiet for the whole swing.
 */
export function blendKeyDirection(sunDir: Vec3, moonDir: Vec3, w: number): Vec3 {
  const t = clamp01(w);
  if (t <= 0) return sunDir;
  if (t >= 1) return moonDir;
  return t < 0.5 ? lerpDir(sunDir, NADIR, t * 2) : lerpDir(NADIR, moonDir, t * 2 - 1);
}

/**
 * Hemisphere ambient level for a day/moon state, 0..1.
 *
 * Written as one `max` rather than a sum on purpose. `day` and `moonW` are
 * disjoint by construction (the sun's gate is 0 below SUN_BELOW; the moon's
 * ramp is 0 above HANDOVER_END), so a sum would be arithmetically identical
 * TODAY — and would silently become an over-unity ambient the first time
 * somebody widened one of the ramps. `max` is bounded at source (§V44)
 * whatever the ramps later do.
 *
 * The floor is the moonless-night term that was always here: enough sky glow
 * to keep silhouettes readable after dark without a moon.
 */
export function ambientLevel(day: number, moonW: number, p: SkyParams): number {
  const floor = clamp01(p.nightAmbientFloor);
  const lift = Math.max(clamp01(day), clamp01(p.moonAmbient) * clamp01(moonW));
  return floor + (1 - floor) * lift;
}

/**
 * Everything the light rig and the sky background need to know about who owns
 * the key right now.
 *
 * `color` is the key's RADIANCE TINT and `intensity` is the light rig's
 * multiplier, and they are SEPARATE KNOBS ON PURPOSE — this is not
 * redundancy. `src/ocean/oceanSurface.ts:130` copies `sunLight.color` (and
 * NOT its intensity) into the water's glint tint, so the colour alone sets
 * how bright the moon's glint road burns while the intensity alone sets how
 * hard the moon keys the ship. Fold the night's dimming into one of them and
 * the other is wrong: put it all in the intensity and the moon paints a
 * noon-bright road on black water; put it all in the colour and the ship goes
 * unlit under a blazing sea.
 */
export interface KeyLight {
  /** unit vector from the origin toward the body that owns the key */
  direction: Vec3;
  /** sRGB tint — what every sun-driven water term is multiplied by */
  color: Rgb;
  /** DirectionalLight intensity, ≥ 0 */
  intensity: number;
  /** 0..1 how much of the key the moon owns — drives night tint + ambient */
  moonWeight: number;
  /**
   * 0..1 how dark it is — THE clock every practical light reads (ship's
   * lanterns, lighthouse lamp, hut windows). See nightFactor(). Distinct from
   * `moonWeight`: a new-moon night has nightFactor 1 and moonWeight 0.
   */
  nightFactor: number;
  /** 0..1 hemisphere ambient level, floor included */
  ambient: number;
  /** sun elevation in radians — every palette ramp still keys off the SUN */
  sunElevation: number;
  /** moon elevation in radians, for the disc in the sky background */
  moonElevation: number;
  /**
   * Unit vector toward the moon. Published separately from `direction`
   * because the DISC must be drawn where the moon actually is — a daytime
   * moon is a real sight, and during the twilight handover `direction` is
   * mid-swing through the nadir and points at neither body.
   */
  moonDirection: Vec3;
}

/**
 * Resolve the key light for a time of day.
 *
 * Note that `sunElevation` is returned untouched and every SKY PALETTE ramp
 * (`skyPalette`, `bandGeometry`, `lowSunWarmth`, `fogRange`) still keys off
 * it, not off the key. The sky's colour is set by where the SUN is even at
 * midnight — that is what makes dusk a dusk — and only the KEY changes hands.
 * Conflating the two would let a rising moon warm the horizon.
 */
export function keyLight(timeOfDay: number, p: SkyParams): KeyLight {
  const sunElev = sunElevation(timeOfDay, p.latitude);
  const moonElev = moonElevation(timeOfDay, p.moonPhase, p.latitude);
  const sunDir = sunDirection(timeOfDay, p.latitude);
  const moonDir = moonDirection(timeOfDay, p.moonPhase, p.latitude);

  const moonW = moonKeyWeight(sunElev, moonElev, p.moonPhase);
  const dirW = keyDirectionWeight(sunElev);
  const day = daylight(sunElev);

  const sun = sunColor(sunElev);
  const moon = hexToRgb(p.moonColor);
  const color: Rgb = [
    sun[0] + (moon[0] - sun[0]) * dirW,
    sun[1] + (moon[1] - sun[1]) * dirW,
    sun[2] + (moon[2] - sun[2]) * dirW,
  ];

  return {
    direction: blendKeyDirection(sunDir, moonDir, dirW),
    color,
    // §V44 bounded at source: a sum of two products of non-negative bounded
    // factors, and the two terms are disjoint so it never exceeds the larger
    // of the two peak intensities.
    intensity: Math.max(0, p.sunIntensity) * day + Math.max(0, p.moonIntensity) * moonW,
    moonWeight: moonW,
    nightFactor: nightFactor(sunElev),
    ambient: ambientLevel(day, moonW, p),
    sunElevation: sunElev,
    moonElevation: moonElev,
    moonDirection: moonDir,
  };
}
