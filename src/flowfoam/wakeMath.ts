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
 *   3. stern churn — wide centreline band, ∝ speed, spreading turbulently
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
import { TRACK_CAPACITY, trackReachCpu, type TrackSample } from './wakeTrack';

/** clamped hermite smoothstep — mirror of the TSL smoothstep used on GPU */
export function smoothstepCpu(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** falling edge: 1 at x=0, 0 at x=e — the fade idiom used all over the field */
const fadeTo = (e: number, x: number): number => 1 - smoothstepCpu(0, Math.max(e, 1e-6), x);

/**
 * TRUE DISSIPATION with age: exp(−a/τ). Replaces the smoothstep "life" fades,
 * which were flat near a = 0 — 87% brightness still at 82 m astern — so the
 * wake read as a fixed-length ribbon of constant intensity that then stopped.
 * User: "it seems like our wake is only modulated by distance and not by time…
 * it's too intense too far behind the boat… we need a nice gradient that makes
 * this disappear slowly instead of instantly." An exponential falls from the
 * first second and never reaches a hard edge, which is what dissipation does.
 */
const dissipate = (tau: number, a: number): number => Math.exp(-a / Math.max(tau, 1e-6));

/** wake tunables subset of FlowFoamParams (pure, structural) */
export interface WakeParams {
  shoulderIntensity: number;
  shoulderLength: number;
  shoulderPush: number;
  shoulderWidth: number;
  shoulderEntry: number;
  kelvinAngle: number;
  bowIntensity: number;
  armWidth: number;
  armWidthGrowth: number;
  armWidthMax: number;
  aftSpreadCap: number;
  trackCoarsen: number;
  trackCoarsenStart: number;
  hullBoost: number;
  hullBoostDist: number;
  bowDecay: number;
  cutIntensity: number;
  cutWidth: number;
  cutLength: number;
  sternIntensity: number;
  sternWidth: number;
  sternWidthSlow: number;
  sternSpread: number;
  sternDecay: number;
  sternOnset: number;
  vortexIntensity: number;
  vortexOffset: number;
  vortexSpread: number;
  vortexWidth: number;
  vortexSpacing: number;
  vortexDecay: number;
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
  breakupSmoothAge: number;
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
  /** LAGGED CURRENT hull speed — wake is only being GENERATED while under way */
  liveSpeed = points[0]?.speed ?? 0,
): number {
  const n = projectOnTrack(points, wx, wz);
  if (!n.found) return 0;
  // A hove-to ship generates no wake. This term is a SOURCE re-evaluated every
  // frame, not a one-off deposit: while under way the pattern sweeps outward so
  // each texel gets a bounded dose, but the instant the hull stops the pattern
  // freezes and that same dose lands on the same texels for ever, piling up to
  // solid white. User: "if you're stationary then it should be like a very very
  // very tiny amount around the hull directly, if anything." Gating generation
  // on live speed lets the already-deposited foam simply decay away.
  const liveGate = smoothstepCpu(
    p.speedThreshold,
    Math.max(p.speedThreshold * 2, p.speedThreshold + 1e-6),
    liveSpeed,
  );
  if (liveGate <= 0) return 0;

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
    p.cutIntensity * s * sf * fadeTo(p.cutWidth, ay) * fadeTo(p.cutLength, d) * dissipate(p.bowDecay, a);

  // --- 2. Kelvin arms: crest at dist·tanθ, vertex ON the stem ---
  // The crest position is d·tanθ and is famously INDEPENDENT of speed — that
  // part was already right. What read as "panning out too heavily" is the arm
  // THICKNESS: growing it 0.05 m per metre turns the V into a wedge-shaped
  // blob a few hundred metres astern, which is exactly the range the wake now
  // reaches. Capped.
  const kelvin = d * tanK; // the physical envelope every aft feature lives in
  const armW = Math.min(p.armWidth + p.armWidthGrowth * d, p.armWidthMax);
  // DILUTION: a crest spread over a wider band carries the same water more
  // thinly. User: "while it goes white it kind of distributes and gets diluted
  // — it needs to fade out to the sides too, really organically."
  const armDilute = p.armWidth / armW;
  const arm = fadeTo(armW, Math.abs(ay - kelvin)) * armDilute;
  const boost = 1 + p.hullBoost * fadeTo(p.hullBoostDist, d);
  // sf SQUARED on the arms only: the user's rule is that a slow ship shows no
  // spread to the side at all, just a little disturbance aft. A single sf left
  // the V still out-reading the (speed-scaled) churn at drift speed.
  const bow = p.bowIntensity * s * sf * sf * arm * boost * dissipate(p.bowDecay, a);

  // --- 2b. hull shoulder: the mass of water the forebody shoulders ASIDE ---
  // User: "it doesn't really feel like we're actually pushing away and
  // displacing water to the side... reads as if the boat is flying through the
  // water instead of plowing through it." A crescent at the stem alone cannot
  // sell that — displacement has to be visible along the whole immersed
  // forebody, pressed OUT past the hull side, and then peel into the arms.
  // `halfBeamAt` is the wetted half-beam profile: analytic for now, and the
  // single place the physics agent's per-station immersion table will land.
  const halfBeam = hull.beam * 0.5 * smoothstepCpu(0, Math.max(p.shoulderEntry, 1e-6), d);
  const shoulderOff =
    halfBeam + p.shoulderPush * smoothstepCpu(0, Math.max(p.shoulderLength, 1e-6), d);
  // plateau over the forebody, then hand over to the arms (which by then have
  // diverged to roughly the same offset — see the continuity test)
  const shoulderHold = 1 - smoothstepCpu(p.shoulderLength * 0.55, p.shoulderLength, d);
  const shoulder =
    p.shoulderIntensity *
    s *
    sf *
    fadeTo(p.shoulderWidth, Math.abs(ay - shoulderOff)) *
    shoulderHold *
    dissipate(p.bowDecay, a);

  // --- aft features: only where the TRANSOM has already passed ---
  const ds = d - hull.length;
  let stern = 0;
  let vortex = 0;
  if (ds > 0) {
    // age of the water measured from the transom, not the stem
    const as = Math.max(a - hull.length / Math.max(s, p.speedThreshold), 0);
    const onset = smoothstepCpu(0, Math.max(p.sternOnset, 1e-6), ds);
    // Nothing aft may pan out past the Kelvin wedge. Turbulent spread is a
    // rate (m/s of water age) while the wedge is a slope (m per m of travel),
    // so at low speed an uncapped churn overtakes the V and the whole aft
    // structure fans out wrong. The cap ties both aft features to the same
    // physical envelope the arms obey.
    const aftCap = hull.beam * 0.5 + p.aftSpreadCap * kelvin;

    // --- 3. stern churn: the TURBULENT CORE, a few beams wide — not the wedge.
    // It fills only a small fraction of the Kelvin envelope; letting it track
    // the envelope (aftSpreadCap 0.8) made it 120 m wide at 200 m astern, which
    // is the "very very wide, looks like a crazy one" the user saw.
    // LINEAR in speed, not squared: squared collapsed the churn to nothing at
    // drift speed, and "only some slight disturbance at the aft" is exactly
    // what the user asks to see when barely making way.
    // The Kelvin ENVELOPE is speed-independent (arcsin(1/3), a constant), but
    // the bright turbulent core behind the transom genuinely is not: a slow
    // hull drags a narrow thread, a fast one a broad boil. This is where speed
    // may legitimately change the wake's apparent angle.
    const churnW0 = hull.beam * 0.5 * p.sternWidth * (p.sternWidthSlow + (1 - p.sternWidthSlow) * sf);
    const churnW = Math.min(churnW0 + p.sternSpread * as, aftCap);
    stern =
      p.sternIntensity *
      s *
      fadeTo(churnW, ay) *
      (churnW0 / churnW) * // dilution: same water spread wider reads fainter
      dissipate(p.sternDecay, as) *
      onset;

    // --- 4. shed vortex pair: two lobes, alternating port/starboard puffs ---
    const vOff = Math.min(hull.beam * 0.5 * p.vortexOffset + p.vortexSpread * as, aftCap);
    const side = n.lateral < 0 ? Math.PI : 0; // von Kármán: sides π out of phase
    const phase = (2 * Math.PI * ds) / Math.max(p.vortexSpacing, 1e-6) + side;
    const puff = 0.5 + 0.5 * Math.sin(phase);
    vortex =
      p.vortexIntensity *
      s *
      fadeTo(p.vortexWidth, Math.abs(ay - vOff)) *
      puff *
      dissipate(p.vortexDecay, as) *
      onset;
  }

  // Tail fade: a sample about to be evicted must not pop out of existence.
  // BOTH eviction routes need one — at speed the track is capped by CAPACITY
  // (a length), adrift it is capped by trackLife (a time), and covering only
  // one leaves a hard edge in the other regime.
  // Anchored to the GRADED track's nominal reach — with distance-graded
  // spacing the capacity no longer implies `spacing × capacity` metres.
  const capDist = trackReachCpu({
    capacity: TRACK_CAPACITY,
    spacing: p.trackSpacing,
    coarsen: p.trackCoarsen,
    coarsenStart: p.trackCoarsenStart,
    life: p.trackLife,
    minSpeed: p.speedThreshold,
    maxTurn: 1,
  });
  const tail =
    (1 - smoothstepCpu(p.trackLife * (1 - p.tailFade), p.trackLife, a)) *
    (1 - smoothstepCpu(capDist * (1 - p.tailFade), capDist, d));
  // forward clip: nothing ahead of the live cutwater (points[0] = live pose)
  const h = points[0];
  const ahead = (wx - h.x) * h.fx + (wz - h.z) * h.fz;
  const clip = fadeTo(p.bowClip, ahead);

  return (cut + bow + shoulder + stern + vortex) * gate * liveGate * tail * clip;
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
  return wakeTrailCpu(points, wx, wz, hull, p, moundSpeed) + mound;
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
  const trail = wakeTrailCpu(points, wx, wz, hull, p, moundSpeed);
  if (trail === 0) return mound;
  // Breakup COARSENS with age: turbulence loses its fine structure as it
  // decays, so old wake must become a soft wash rather than the high-frequency
  // stipple the user saw. Blended toward the noise's own mean so smoothing
  // changes the texture without changing the brightness.
  const age = Math.max(projectOnTrack(points, wx, wz).age, 0);
  const t = smoothstepCpu(0, Math.max(p.breakupSmoothAge, 1e-6), age);
  const breakup = wakeBreakupCpu(wx, wz, p) * (1 - t) + (1 - p.wakeBreakup * 0.5) * t;
  return trail * breakup + mound;
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
    Math.max(p.sternSpread * p.sternDecay * 3, p.vortexSpread * p.vortexDecay * 3 + p.vortexWidth);
  // the mound reaches forward of the head and outboard of the centreline
  const mound = Math.max(p.moundSpan, p.moundLead + p.moundThick * p.moundFill);
  const shoulder = hull.beam * 0.5 + p.shoulderPush + p.shoulderWidth;
  return Math.max(arms, aft, mound, shoulder) + p.cutWidth + p.bowClip;
}
