/**
 * Pure CPU mirrors of the ship-wake GPU math (§V10 follow-up) — ZERO three
 * imports, same mirror contract as flowMath.ts. GPU twin:
 * wakeInjection.wakeRateNode; change one side → change the other.
 *
 * THE MODEL (see wakeTrack.ts for why the old ship-local one was thrown out):
 * every feature is a function of a point's position in the CUTWATER TRACK
 * frame, not in the ship's live frame. Project the query point onto the
 * recorded polyline → (dist along the track back to the hull, signed lateral
 * offset, age of the water there, speed the hull had there). Those four
 * numbers carry the whole wake. Nothing reads the ship's current heading
 * except the forward-clip at the stem, so a turn cannot rotate wake that has
 * already been laid down.
 *
 * FIVE FEATURES, TWO EMISSION POINTS (user: "a clear distinction between the
 * disturbance caused by the front of the boat and that caused by the aft —
 * they're also emitted in different spots"):
 *
 *   AT THE CUTWATER (dist = 0)
 *   0. bow mound — the displacement bow wave. The ONLY feature that lives
 *      FORWARD of the stem: a crescent crest peaking `moundLead` metres ahead
 *      on the centreline and sweeping aft as it goes outboard, where it hands
 *      over to the Kelvin arms. User: "there's some sort of reaction with the
 *      water actually being thrown away forwards from more or less the
 *      spearhead of the boat", constant "whenever we are moving at reasonable
 *      speeds". Amplitude rides a lagged speed (wakeTrack.approachExp) so a
 *      heavy hull piles it up and lets it fall away instead of popping.
 *      It is evaluated in the LIVE stem frame — it has to lead the ship — but
 *      it is INJECTED into the world-anchored accumulation, so the water it
 *      deposits is ordinary trail from the next frame on and never re-orients.
 *   1. cutwater core — narrow bright band right at the stem, the hull tearing
 *      the surface open. Dies within `cutLength` metres of track.
 *   2. Kelvin arms — crest at lateral = dist·tan θ, so the vertex is ON the
 *      stem and the arms open at the Kelvin angle as the ship travels. Boosted
 *      near the hull (`hullBoost`) for the "heaving water out" read.
 *
 *   AT THE TRANSOM (dist = hull length — the hull has to pass first)
 *   3. stern churn — wide centreline band, ∝ speed², spreading turbulently
 *      with AGE (slow, ~0.5 m/s) not with the Kelvin slope. Reads as a broad
 *      flat rooster tail, visibly unlike the two thin diverging arms.
 *   4. shed vortex pair — two discrete lobes off the transom corners drifting
 *      slowly outboard, intensity modulated by a von-Kármán-style alternating
 *      street (port/starboard π out of phase, period `vortexSpacing` metres).
 *      This is the "external vortexes coming out from the aft" the user asked
 *      for and it is the feature that makes aft ≠ bow at a glance.
 *
 * §B.4: the shed-vortex oscillation is phased by track DISTANCE, which is
 * per-position — no shared global time term, so the street marches aft with
 * the water instead of the whole wake blinking in sync.
 */
import { fbm2Cpu } from '../terrain/noiseCpu';
import { FLOW_OCTAVES } from './flowMath';
import { TRACK_CAPACITY, type TrackSample } from './wakeTrack';

/** clamped hermite smoothstep — mirror of the TSL smoothstep used on GPU */
export function smoothstepCpu(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** falling edge: 1 at x=0, 0 at x=e — the fade idiom used all over the field */
const fadeTo = (e: number, x: number): number => 1 - smoothstepCpu(0, Math.max(e, 1e-6), x);

/** wake tunables subset of FlowFoamParams (pure, structural) */
export interface WakeParams {
  kelvinAngle: number;
  bowIntensity: number;
  armWidth: number;
  armWidthGrowth: number;
  hullBoost: number;
  hullBoostDist: number;
  bowLife: number;
  cutIntensity: number;
  cutWidth: number;
  cutLength: number;
  sternIntensity: number;
  sternWidth: number;
  sternSpread: number;
  sternLife: number;
  sternOnset: number;
  vortexIntensity: number;
  vortexOffset: number;
  vortexSpread: number;
  vortexWidth: number;
  vortexSpacing: number;
  vortexLife: number;
  moundIntensity: number;
  moundLead: number;
  moundSweep: number;
  moundSpan: number;
  moundThick: number;
  moundFill: number;
  moundLag: number;
  speedThreshold: number;
  fullWakeSpeed: number;
  trackSpacing: number;
  trackLife: number;
  tailFade: number;
  bowClip: number;
  wakeNoiseScale: number;
  wakeNoiseContrast: number;
  wakeBreakup: number;
}

/** hull geometry the wake needs (from the blueprint AABB, main.ts) */
export interface WakeHull {
  /** bow point → transom distance (m) = bowOffset − sternOffset */
  length: number;
  /** hull width (m) */
  beam: number;
}

/** result of projecting a world point onto the cutwater track */
export interface TrackProjection {
  /** false when the track is too short to have a segment */
  found: boolean;
  /** arclength (m) from the projection forward to the live cutwater */
  dist: number;
  /** seconds since the cutwater passed the projection */
  age: number;
  /** speed over water (m/s) the hull had there */
  speed: number;
  /** signed lateral offset (m); + = starboard of the track */
  lateral: number;
}

const NO_PROJECTION: TrackProjection = {
  found: false,
  dist: 0,
  age: 0,
  speed: 0,
  lateral: 0,
};

/**
 * Nearest point on the cutwater polyline, with age/dist/speed interpolated
 * along the hit segment. GPU twin: the Loop in wakeInjection.wakeRateNode.
 *
 * WHY nearest-point is the right frame: on a straight course the nearest track
 * point to a wake query sits exactly abeam of it, so `dist` equals the classic
 * "metres aft of the bow" and `lateral = dist·tanθ` reproduces the textbook
 * Kelvin V exactly. On a curve the same construction bends the V along the
 * path, which is the entire point of the rework.
 *
 * The lateral SIGN comes from the stored forward at the younger endpoint (not
 * from the segment direction) so it stays stable when a segment degenerates.
 */
export function projectOnTrack(points: TrackSample[], wx: number, wz: number): TrackProjection {
  if (points.length < 2) return NO_PROJECTION;
  let best = Infinity;
  const out: TrackProjection = { found: true, dist: 0, age: 0, speed: 0, lateral: 0 };
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const dx = wx - a.x;
    const dz = wz - a.z;
    const len2 = Math.max(ex * ex + ez * ez, 1e-6); // §V28 floored divisor
    const t = Math.min(1, Math.max(0, (dx * ex + dz * ez) / len2));
    const cx = wx - (a.x + ex * t);
    const cz = wz - (a.z + ez * t);
    const d2 = cx * cx + cz * cz;
    if (d2 >= best) continue;
    best = d2;
    // right = (fz, −fx): forward rotated −90° about +y. The cross-track
    // component only supplies the SIGN — the magnitude must be the true
    // distance to the segment, or a point off the END of the polyline (where
    // the offset is purely along-track) reads as sitting on the centreline.
    const lat = cx * a.fz - cz * a.fx;
    out.dist = a.dist + (b.dist - a.dist) * t;
    out.age = a.age + (b.age - a.age) * t;
    out.speed = a.speed + (b.speed - a.speed) * t;
    out.lateral = (lat < 0 ? -1 : 1) * Math.sqrt(d2);
  }
  return out;
}

/**
 * Displacement bow wave (foam/second) in the LIVE stem frame — the mound of
 * water a hull shoves ahead of itself. GPU twin: the mound block in
 * wakeInjection.wakeRateNode.
 *
 * Shape: the crest peaks `moundLead` metres AHEAD of the stem on the
 * centreline and sweeps aft by `moundSweep` per metre outboard, so its tips
 * end up abaft the stem and run into the Kelvin arms — one continuous
 * hull-water interaction rather than three separate effects. Fore-aft it is
 * thin on the leading face (`moundThick`, water piling up against the stem)
 * and `moundFill`× thicker behind the crest, filling the gap back to the hull
 * so nothing forward of the stem reads as undisturbed.
 *
 * `moundSpeed` is the LAGGED speed (wakeTrack.approachExp), not the raw one.
 */
export function bowMoundCpu(
  head: TrackSample,
  wx: number,
  wz: number,
  moundSpeed: number,
  p: WakeParams,
): number {
  const gate = smoothstepCpu(
    p.speedThreshold,
    Math.max(p.speedThreshold * 2, p.speedThreshold + 1e-6),
    moundSpeed,
  );
  if (gate <= 0) return 0;
  const sf = smoothstepCpu(
    p.speedThreshold,
    Math.max(p.fullWakeSpeed, p.speedThreshold + 1e-6),
    moundSpeed,
  );
  const dx = wx - head.x;
  const dz = wz - head.z;
  const ahead = dx * head.fx + dz * head.fz;
  const aside = Math.abs(dx * head.fz - dz * head.fx); // right = (fz, −fx)
  // signed distance from the swept crest line
  const dc = ahead - (p.moundLead - p.moundSweep * aside);
  const thick = dc >= 0 ? p.moundThick : p.moundThick * p.moundFill;
  const lon = fadeTo(thick, Math.abs(dc));
  const lat = fadeTo(p.moundSpan, aside);
  return p.moundIntensity * moundSpeed * sf * gate * lon * lat;
}

/**
 * Deterministic wake ENVELOPE (foam/second, noise-free) at a world point,
 * evaluated in the track frame. Port/starboard symmetric EXCEPT the shed
 * vortex street, which alternates sides by construction (that asymmetry is the
 * signature of a real vortex street, and the tests pin it).
 * GPU twin: wakeInjection.wakeRateNode — keep formulas identical.
 */
export function wakeTrailCpu(
  points: TrackSample[],
  wx: number,
  wz: number,
  hull: WakeHull,
  p: WakeParams,
): number {
  const n = projectOnTrack(points, wx, wz);
  if (!n.found) return 0;

  const s = n.speed;
  // §V28: both smoothstep spans floored so e0 === e1 can never divide by 0
  const gate = smoothstepCpu(p.speedThreshold, Math.max(p.speedThreshold * 2, p.speedThreshold + 1e-6), s);
  if (gate <= 0) return 0;
  const sf = smoothstepCpu(p.speedThreshold, Math.max(p.fullWakeSpeed, p.speedThreshold + 1e-6), s);

  const ay = Math.abs(n.lateral);
  const d = Math.max(n.dist, 0);
  const a = Math.max(n.age, 0);
  const tanK = Math.tan((p.kelvinAngle * Math.PI) / 180);

  // --- 1. cutwater core: the stem tearing the surface, right at the bow ---
  const cut =
    p.cutIntensity * s * sf * fadeTo(p.cutWidth, ay) * fadeTo(p.cutLength, d);

  // --- 2. Kelvin arms: crest at dist·tanθ, vertex ON the stem ---
  const armW = p.armWidth + p.armWidthGrowth * d;
  const arm = fadeTo(armW, Math.abs(ay - d * tanK));
  const boost = 1 + p.hullBoost * fadeTo(p.hullBoostDist, d);
  const bow = p.bowIntensity * s * sf * arm * boost * fadeTo(p.bowLife, a);

  // --- aft features: only where the TRANSOM has already passed ---
  const ds = d - hull.length;
  let stern = 0;
  let vortex = 0;
  if (ds > 0) {
    // age of the water measured from the transom, not the stem
    const as = Math.max(a - hull.length / Math.max(s, p.speedThreshold), 0);
    const onset = smoothstepCpu(0, Math.max(p.sternOnset, 1e-6), ds);

    // --- 3. stern churn: wide, flat, centreline-peaked, ∝ speed² ---
    const churnW = hull.beam * 0.5 * p.sternWidth + p.sternSpread * as;
    stern = p.sternIntensity * s * s * fadeTo(churnW, ay) * fadeTo(p.sternLife, as) * onset;

    // --- 4. shed vortex pair: two lobes, alternating port/starboard puffs ---
    const vOff = hull.beam * 0.5 * p.vortexOffset + p.vortexSpread * as;
    const side = n.lateral < 0 ? Math.PI : 0; // von Kármán: sides π out of phase
    const phase = (2 * Math.PI * ds) / Math.max(p.vortexSpacing, 1e-6) + side;
    const puff = 0.5 + 0.5 * Math.sin(phase);
    vortex =
      p.vortexIntensity *
      s *
      s *
      fadeTo(p.vortexWidth, Math.abs(ay - vOff)) *
      puff *
      fadeTo(p.vortexLife, as) *
      onset;
  }

  // Tail fade: a sample about to be evicted must not pop out of existence.
  // BOTH eviction routes need one — at speed the track is capped by CAPACITY
  // (a length), adrift it is capped by trackLife (a time), and covering only
  // one leaves a hard edge in the other regime.
  const capDist = p.trackSpacing * TRACK_CAPACITY;
  const tail =
    (1 - smoothstepCpu(p.trackLife * (1 - p.tailFade), p.trackLife, a)) *
    (1 - smoothstepCpu(capDist * (1 - p.tailFade), capDist, d));
  // forward clip: nothing ahead of the live cutwater (points[0] = live pose)
  const h = points[0];
  const ahead = (wx - h.x) * h.fx + (wz - h.z) * h.fz;
  const clip = fadeTo(p.bowClip, ahead);

  return (cut + bow + stern + vortex) * gate * tail * clip;
}

/**
 * Full noise-free envelope: the four trailing track features plus the bow
 * mound, which lives FORWARD of the stem and so sits outside their forward
 * clip. GPU twin composes the same two halves.
 */
export function wakeEnvelopeCpu(
  points: TrackSample[],
  wx: number,
  wz: number,
  hull: WakeHull,
  p: WakeParams,
  /** lagged speed driving the bow mound; defaults to the live stem speed */
  moundSpeed = points[0]?.speed ?? 0,
): number {
  const mound = points.length >= 2 ? bowMoundCpu(points[0], wx, wz, moundSpeed, p) : 0;
  return wakeTrailCpu(points, wx, wz, hull, p) + mound;
}

/** cos(45°) = sin(45°) — math constant for the rotated noise lattice */
export const INV_SQRT2 = Math.SQRT1_2;

/**
 * World-anchored breakup factor ∈ [1 − wakeBreakup, 1]: fbm thresholded
 * around 0.5 (±wakeNoiseContrast) into patches. Multiplying the envelope
 * makes arms gappy/feathered instead of painted-on stripes; world-anchored
 * so the pattern stays in the water while the ship sweeps through it.
 * TWO lattice orientations (axis-aligned + 45°-rotated, averaged) hide the
 * square value-noise grid that read as a "pattern of boxes" in review.
 */
export function wakeBreakupCpu(wx: number, wz: number, p: WakeParams): number {
  const nx = wx * p.wakeNoiseScale;
  const nz = wz * p.wakeNoiseScale;
  const rx = (nx - nz) * INV_SQRT2;
  const rz = (nx + nz) * INV_SQRT2;
  const n = 0.5 * (fbm2Cpu(nx, nz, FLOW_OCTAVES) + fbm2Cpu(rx, rz, FLOW_OCTAVES));
  const patch = smoothstepCpu(0.5 - p.wakeNoiseContrast, 0.5 + p.wakeNoiseContrast, n);
  return 1 - p.wakeBreakup + p.wakeBreakup * patch;
}

/**
 * Full wake injection rate = trailing features × world-noise breakup, PLUS the
 * bow mound un-broken. The mound deliberately skips the breakup gaps: the user
 * asked for a CONSTANT reaction at the stem, and a gappy mound flickers in and
 * out as the ship sails through the noise lattice.
 */
export function wakeRateCpu(
  points: TrackSample[],
  wx: number,
  wz: number,
  hull: WakeHull,
  p: WakeParams,
  moundSpeed = points[0]?.speed ?? 0,
): number {
  const mound = points.length >= 2 ? bowMoundCpu(points[0], wx, wz, moundSpeed, p) : 0;
  const trail = wakeTrailCpu(points, wx, wz, hull, p);
  return (trail === 0 ? 0 : trail * wakeBreakupCpu(wx, wz, p)) + mound;
}

/**
 * Lateral reach (m) the wake can possibly have from the track — the margin for
 * the GPU AABB early-out. Over-estimating only costs a few skipped texels;
 * under-estimating would clip the outer arms, so every spreading term is here.
 */
export function wakeReachCpu(maxDist: number, hull: WakeHull, p: WakeParams): number {
  const tanK = Math.tan((p.kelvinAngle * Math.PI) / 180);
  const arms = maxDist * (tanK + p.armWidthGrowth) + p.armWidth;
  const aft =
    hull.beam * 0.5 * Math.max(p.sternWidth, p.vortexOffset) +
    Math.max(p.sternSpread * p.sternLife, p.vortexSpread * p.vortexLife + p.vortexWidth);
  // the mound reaches forward of the head and outboard of the centreline
  const mound = Math.max(p.moundSpan, p.moundLead + p.moundThick * p.moundFill);
  return Math.max(arms, aft, mound) + p.cutWidth + p.bowClip;
}
