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
  bodyHorizonGate,
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
 * Unit vector toward the moon — ON ITS OWN ORBIT (§V91, §B63).
 *
 * It used to be `sunDirection(tod − 24·phase)`: the sun's own track,
 * time-shifted. That put the moon ON the sun's path at every phase, so near
 * new/old phase it rode a few degrees beside the setting sun and the pair
 * read as one body changing into the other (§B63). The orbit here is the
 * sun's diurnal circle TILTED by `inclinationDeg` about a node line that sits
 * `nodeOffsetDeg` along the track from the sun:
 *
 *   e1 = sun, e2 = the sun a quarter-day earlier (so e1,e2 span the track),
 *   u  = cos E·e1 + sin E·e2            the un-tilted moon, E = 2π·phase
 *        (identical to the old sunDirection(tod − 24·phase) — see test),
 *   a  = cos Ω·e1 + sin Ω·e2            the node line, in the track plane,
 *   m  = Rot(a, i)·u                    Rodrigues, closed form.
 *
 * A rotation of a unit vector is a unit vector, so this is normalized BY
 * CONSTRUCTION with no normalize() and therefore no §V28 NaN; every term is a
 * sin/cos of a finite angle, so it is continuous in t and in phase and
 * periodic in both. With i = 0 it reduces exactly to the old expression, which
 * is how the tests pin that nothing ELSE moved.
 *
 * Elongation from the sun is phase·360° around the orbit: full (0.5) is
 * opposite the sun within i — it rises as the sun sets and culminates near
 * midnight; new (0) is within i of the sun, and DARK (see moonIllumination /
 * moonDiscState). At the default Ω = 90° the full and new moons sit at the
 * full tilt rather than on the track — the non-eclipse month.
 */
export function moonDirection(
  timeOfDay: number,
  phase: number = skyParams.moonPhase,
  latitude: number = skyParams.latitude,
  inclinationDeg: number = skyParams.moonInclination,
  nodeOffsetDeg: number = skyParams.moonNodeOffset,
): Vec3 {
  const t = Number.isFinite(timeOfDay) ? timeOfDay : 0;
  const e1 = sunDirection(t, latitude);
  const e2 = sunDirection(t - 6, latitude);
  const E = 2 * Math.PI * clamp01(phase);
  const cE = Math.cos(E);
  const sE = Math.sin(E);
  const u: Vec3 = [cE * e1[0] + sE * e2[0], cE * e1[1] + sE * e2[1], cE * e1[2] + sE * e2[2]];
  const i = ((Number.isFinite(inclinationDeg) ? inclinationDeg : 0) * Math.PI) / 180;
  if (i === 0) return u;
  const O = ((Number.isFinite(nodeOffsetDeg) ? nodeOffsetDeg : 0) * Math.PI) / 180;
  const cO = Math.cos(O);
  const sO = Math.sin(O);
  const a: Vec3 = [cO * e1[0] + sO * e2[0], cO * e1[1] + sO * e2[1], cO * e1[2] + sO * e2[2]];
  // Rodrigues: u·cos i + (a×u)·sin i + a·(a·u)·(1 − cos i)
  const ci = Math.cos(i);
  const si = Math.sin(i);
  const ax: Vec3 = [
    a[1] * u[2] - a[2] * u[1],
    a[2] * u[0] - a[0] * u[2],
    a[0] * u[1] - a[1] * u[0],
  ];
  const au = (a[0] * u[0] + a[1] * u[1] + a[2] * u[2]) * (1 - ci);
  return [
    u[0] * ci + ax[0] * si + a[0] * au,
    u[1] * ci + ax[1] * si + a[1] * au,
    u[2] * ci + ax[2] * si + a[2] * au,
  ];
}

/** Moon elevation above the horizon in radians (negative when it has set). */
export function moonElevation(
  timeOfDay: number,
  phase: number = skyParams.moonPhase,
  latitude: number = skyParams.latitude,
  inclinationDeg: number = skyParams.moonInclination,
  nodeOffsetDeg: number = skyParams.moonNodeOffset,
): number {
  const y = moonDirection(timeOfDay, phase, latitude, inclinationDeg, nodeOffsetDeg)[1];
  return Math.asin(Math.min(1, Math.max(-1, y)));
}

/**
 * Angle between the sun and the moon in DEGREES, 0..180. The moon's true
 * elongation; what decides whether a crescent is a sight or a sliver lost in
 * the sun's glare. Clamped dot (§V28: acos of 1+ε is NaN).
 */
export function moonElongation(sunDir: Vec3, moonDir: Vec3): number {
  const d = sunDir[0] * moonDir[0] + sunDir[1] * moonDir[1] + sunDir[2] * moonDir[2];
  return (Math.acos(Math.min(1, Math.max(-1, d))) * 180) / Math.PI;
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

/**
 * THE KEY'S RADIANCE, as a fraction of a full-strength sun (§V.72), 0..1.
 *
 * WHY THIS EXISTS, AND WHAT IT REPLACES. The ocean copied `sunLight.color`
 * and NOTHING ELSE into the water's light tint, so the sea's idea of "how
 * bright is the key" was the key's HUE — a number that only moves when the
 * colour ramp moves. `moonColor`'s luminance is 0.390 against a noon sun's
 * 0.904, so the moon laid a road at 43% of noon's and 55% of a sun at the
 * same elevation, while keying the ship at 0.75/3.4 = 22%. Two statements
 * about one body's brightness, 2.5x apart — and the user saw the louder one:
 * "it's like the same size as what the sun is doing".
 *
 * THIS IS NOT A NEW MODEL. `caustics/waterLighting.ts:setCausticKey` already
 * computes exactly this expression, for exactly this reason, and its header
 * already states the answer this file was contradicting: "a full moon keys at
 * moonIntensity/sunIntensity = 0.75/3.4 = 0.22 in a 0.39-luminance blue, i.e.
 * 9.5% of noon's caustic radiance". The caustics were right and the water was
 * wrong; this publishes the caustics' number so both read ONE expression
 * instead of two that disagree by 4.53x. Clamped 0..1 on the same §V.44
 * argument setCausticKey states: it may only ever DIM the water relative to
 * its authored daytime calibration, whatever the panel does to either knob.
 *
 * GATED ON `dirW`, WHICH IS WHY NO SUN FRAME CAN MOVE. `keyDirectionWeight`
 * is exactly 0 at every sun elevation at or above SUN_BELOW, so this returns
 * exactly 1 for every hour the sun owns the key — the §T39 sunset and the
 * signed-off 15.0/17.6 framings are bit-identical BY CONSTRUCTION, not by a
 * value that happens to land on 1. The un-gated form (`key.intensity /
 * sunIntensity`, the caustics' own) would additionally carry `beamStrength`'s
 * KEY_FLOOR onto the water below 5.7 deg of sun and dim the late sunset by up
 * to 2.9x. That is arguably more correct and is deliberately NOT taken here:
 * it is a change to a signed-off frame that wants eyes on it, not a moon fix.
 */
export function keyRadianceScale(dirW: number, moonW: number, p: SkyParams): number {
  const sun = Math.max(p.sunIntensity, 1e-3);
  const moon = (Math.max(0, p.moonIntensity) * clamp01(moonW)) / sun;
  return clamp01(1 + clamp01(dirW) * (clamp01(moon) - 1));
}

/**
 * Everything the sky background needs to DRAW the two bodies — all of it
 * resolved on the CPU, once per frame, and delivered as uniforms (§V91).
 *
 * `sunDiscGate` / `moonDiscGate` multiply every disc, glow and halo term of
 * their body: exactly 0 once the body is `bodyHorizonMargin` below the horizon
 * plus its own radius (nothing is drawn from under the sea), and for the moon
 * additionally 0 inside `moonGlareAngle` of the sun — a moon that close is a
 * ≤2%-lit sliver inside the sun's forward scatter, and drawing it is the
 * "second disc beside the setting sun" of §B63.
 *
 * `drawPhase` is the phase the TERMINATOR is cut at: the ORBIT's phase, so
 * the disc agrees with `moonIllumination(moonPhase)` — a full moon is FULL
 * (§B77: the old `min` by illumination let the 0.18 cheat beat phase 0.5 and
 * drew every full moon as a 21% crescent). `moonDiscPhase` survives only as
 * a FLOOR on the drawn crescent's width (see the param): it can only ever
 * ADD to a thin crescent, never subtract from a fat one. `litFraction` is the
 * lit AREA of that drawn disc; it scales the aura (glow/halo) as before.
 *
 * A third gate, `moonMinLit`: the orbit's OWN illumination below this is a
 * sliver that no floor should resurrect — a 2%-lit moon is a moon nobody sees,
 * in or out of the glare cone. It reaches exactly 0 at the threshold, which is
 * what lets the visible term be 0 rather than "very faint" (§B77's sliver).
 *
 * Every factor is a 0..1 smoothstep or a product of them — bounded at source
 * (§V44), never clamped after the fact.
 */
export interface MoonDiscState {
  sunDiscGate: number;
  moonDiscGate: number;
  drawPhase: number;
  litFraction: number;
}

/** deg. Floor for the glare ramp's width (§V28: a zero-width smoothstep is 0/0) */
const MIN_GLARE_SOFT = 0.01;
/** Floor for the lit-fraction ramp's width (§V28, same reason) */
const MIN_LIT_SOFT = 1e-3;

export function moonDiscState(
  sunElev: number,
  moonElev: number,
  elongationDeg: number,
  p: SkyParams,
): MoonDiscState {
  const sunDiscGate = bodyHorizonGate(sunElev, p.sunDiscSize, p.bodyHorizonMargin);
  const horizon = bodyHorizonGate(moonElev, p.moonDiscSize, p.bodyHorizonMargin);
  const glare0 = Number.isFinite(p.moonGlareAngle) ? Math.max(0, p.moonGlareAngle) : 0;
  const soft = Number.isFinite(p.moonGlareSoftness) ? Math.max(MIN_GLARE_SOFT, p.moonGlareSoftness) : MIN_GLARE_SOFT;
  // @band-limited-elsewhere: CPU scalar over ELONGATION, once per frame, a uniform
  const glare = smoothstep(glare0, glare0 + soft, Number.isFinite(elongationDeg) ? elongationDeg : 0);
  const orbit = clamp01(p.moonPhase);
  const cheat = clamp01(p.moonDiscPhase);
  const orbitLit = moonIllumination(orbit);
  // the orbit's own illumination gates the disc: ramp from minLit to 2·minLit
  // (floored width), exactly 0 at and below the threshold
  const minLit = clamp01(p.moonMinLit);
  // @band-limited-elsewhere: CPU scalar over the orbit's lit fraction, once per frame, a uniform
  const litGate = smoothstep(minLit, minLit + Math.max(MIN_LIT_SOFT, minLit), orbitLit);
  // FLOOR by ILLUMINATION: illumination is even about 0.5, so the two
  // candidates with equal illumination have equal cos(2πp) and the switch
  // is continuous in the terminator's k. The orbit wins whenever it is at
  // least as lit as the cheat — full stays full.
  const drawPhase = orbitLit < moonIllumination(cheat) ? cheat : orbit;
  return {
    sunDiscGate,
    moonDiscGate: horizon * glare * litGate,
    drawPhase,
    litFraction: moonIllumination(drawPhase),
  };
}

/**
 * The direction the moon's LIT LIMB faces, as a unit vector in the disc's
 * plane (⊥ `moonDir`): the sun's direction with its component along the moon
 * removed. The sun is at infinity, so the direction observer→sun IS the
 * direction moon→sun, and the lit hemisphere of a sphere faces its light —
 * a crescent's horns point away from the sun, its bright limb toward it.
 *
 * Degenerate exactly at new and full (sun along the moon's axis): there the
 * disc is all-dark or all-lit and no axis matters, so the fallback is the
 * old fixed horizontal axis `moonDir × up`, and if the moon is at the zenith
 * too, +x. Never normalize(0) (§V28): every branch returns a unit vector.
 */
export function moonLitAxis(sunDir: Vec3, moonDir: Vec3): Vec3 {
  const s = sunDir.map((v) => (Number.isFinite(v) ? v : 0)) as Vec3;
  const m = moonDir.map((v) => (Number.isFinite(v) ? v : 0)) as Vec3;
  const sm = s[0] * m[0] + s[1] * m[1] + s[2] * m[2];
  const candidates: Vec3[] = [
    [s[0] - m[0] * sm, s[1] - m[1] * sm, s[2] - m[2] * sm],
    // moonDir × (0,1,0)
    [-m[2], 0, m[0]],
    [1, 0, 0],
  ];
  for (const c of candidates) {
    const l = Math.hypot(c[0], c[1], c[2]);
    if (l > MIN_LEN) return [c[0] / l, c[1] / l, c[2] / l];
  }
  return [1, 0, 0];
}

/**
 * CPU mirror of the sky background's terminator (skyBackground.ts, step 5):
 * the disc basis `litAxis` (x, toward the sun) / `moonDir × litAxis` (y), and
 * the cut `k = cos(2π·drawPhase)` — a disc point (x, y) in radius units is lit
 * where x > k·√(1−y²). The lit area of that cut is (1−k)/2 by construction,
 * which is `moonIllumination(drawPhase)`: the shader and the CPU cannot
 * disagree on the lit fraction, only on the axis — and the axis is this one.
 */
export function moonTerminator(
  sunDir: Vec3,
  moonDir: Vec3,
  drawPhase: number,
): { litAxis: Vec3; k: number; litFraction: number } {
  const k = Math.cos(2 * Math.PI * clamp01(drawPhase));
  return { litAxis: moonLitAxis(sunDir, moonDir), k, litFraction: (1 - k) / 2 };
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
 * `color` is the key's HUE and `intensity` is its LEVEL. That split used to be
 * load-bearing in a way it should never have been: `oceanSurface.ts` copied
 * `sunLight.color` and not its intensity, so the colour alone set how bright
 * the moon's road burned while the intensity alone set how hard it keyed the
 * ship — two independent statements of one body's brightness, and they drifted
 * 2.5x apart. That is fixed at the source rather than balanced by hand: the
 * water now multiplies the hue by `radianceScale`, so ONE number moves the
 * moon and `moonIntensity` is the single knob for how bright the moon is.
 *
 * `color` is therefore free to be what it says it is — a hue. `moonColor`'s
 * deliberate Purkinje blue is an ART CHOICE about the tint of moonlight and
 * carries no claim about its level; see the header. Do not put level back into
 * it, and do not "correct" the blue to the physically warmer 4100 K.
 */
export interface KeyLight {
  /** unit vector from the origin toward the body that owns the key */
  direction: Vec3;
  /** sRGB HUE — what every sun-driven water term is tinted by */
  color: Rgb;
  /** DirectionalLight intensity, ≥ 0 */
  intensity: number;
  /**
   * 0..1 the key's LINEAR radiance as a fraction of a full-strength sun —
   * exactly 1 for every hour the sun owns the key. Any consumer that reads
   * `color` WITHOUT `intensity` must multiply by this, in the linear working
   * space, or it is claiming the moon is as bright as the sun. See
   * `keyRadianceScale()` for the whole argument. `sky/lighting.ts` publishes
   * it on the DirectionalLight so the water can reach it.
   */
  radianceScale: number;
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
  /**
   * Unit vector toward the SUN — the true sun, at every hour (§V91). The
   * sun's DISC is drawn here, never along `direction`: after the handover
   * `direction` is the moon's, and a sun disc drawn along it sat ON the moon
   * every night (ember-coloured, 14× HDR) — "the sun turned into the moon".
   */
  sunDirection: Vec3;
  /** 0..1 gates on the sun's and the moon's disc/glow/halo — see moonDiscState */
  sunDiscGate: number;
  moonDiscGate: number;
  /** phase the moon's terminator is cut at, and the lit area of that disc */
  moonDrawPhase: number;
  moonLitFraction: number;
  /** unit vector ⊥ moonDirection that the lit limb faces — see moonLitAxis (§B77) */
  moonLitAxis: Vec3;
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
  const sunDir = sunDirection(timeOfDay, p.latitude);
  const moonDir = moonDirection(
    timeOfDay,
    p.moonPhase,
    p.latitude,
    p.moonInclination,
    p.moonNodeOffset,
  );
  const moonElev = Math.asin(Math.min(1, Math.max(-1, moonDir[1])));
  const disc = moonDiscState(sunElev, moonElev, moonElongation(sunDir, moonDir), p);

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
    radianceScale: keyRadianceScale(dirW, moonW, p),
    moonWeight: moonW,
    nightFactor: nightFactor(sunElev),
    ambient: ambientLevel(day, moonW, p),
    sunElevation: sunElev,
    moonElevation: moonElev,
    moonDirection: moonDir,
    sunDirection: sunDir,
    sunDiscGate: disc.sunDiscGate,
    moonDiscGate: disc.moonDiscGate,
    moonDrawPhase: disc.drawPhase,
    moonLitFraction: disc.litFraction,
    moonLitAxis: moonLitAxis(sunDir, moonDir),
  };
}
