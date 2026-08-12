/**
 * Wake SLICK + transverse waves — the wake's effect on the WATER, not on its
 * colour (§V10 follow-up). Pure CPU mirrors, zero three imports, same contract
 * as wakeMath.ts / flowMath.ts. GPU twin: slickInjection.ts.
 *
 * WHY THIS EXISTS (user: "I would expect an actual influence on the surface
 * ripple / wave noise structure caused by the bow wake, by the trail that we
 * leave in the water"). Everything the wake did until now was FOAM: white
 * painted on top of an otherwise undisturbed sea. That is a decal. Two
 * mechanisms turn it into a wake, and neither adds geometry:
 *
 *   1. SLICK (the big one). Turbulence and surfactant in a ship's track kill
 *      the short capillary/chop waves, leaving a smooth glassy lane behind the
 *      hull. It reads as a darker, more mirror-like stripe because flat water
 *      reflects the sky coherently while the ruffled water around it scatters.
 *      This module publishes a 0..1 lane coverage; the ocean material turns it
 *      into a MULTIPLIER on the finest cascade's slope + the micro-wavelet
 *      churn (see index.wakeSmoothNode). It removes existing high-frequency
 *      detail — no new frequencies are introduced, so it cannot itself alias.
 *
 *   2. TRANSVERSE KELVIN WAVES. Inside the V, crests run ACROSS the track,
 *      spaced λ = 2πv²/g. Unlike the 19.47° half-angle (KELVIN_HALF_ANGLE_DEG,
 *      = asin(1/3), a constant of the dispersion relation and famously
 *      independent of ship speed), the transverse wavelength is strongly
 *      speed-dependent: 5.8 m at 3 m/s, 41 m at 8 m/s. Published as an
 *      ADDITIVE SLOPE (index.wakeSlopeNode), never as displacement — the
 *      ocean's geometry belongs to the ocean.
 *
 * PHASE IS A FUNCTION OF `dist`, NOT OF TIME. The Kelvin pattern is steady in
 * the SHIP's frame, so at a fixed world point the phase advances as the ship
 * recedes (dφ/dt = g/v ≈ 0.26 Hz at 6 m/s — the encounter frequency, which is
 * exactly right). That is why the slope is written FRESH every frame instead of
 * accumulated: an oscillating source integrated over time averages to zero.
 * The slick, being a non-negative coverage, IS accumulated (slickHalfLife).
 *
 * The wavelength uses the speed recorded at the projection, so a steady course
 * is exact and an accelerating one is approximated (the honest form integrates
 * g/v² along the track). Noted rather than hidden — the error is a slow chirp.
 *
 * §V44 BOUNDED AT SOURCE: `slickFieldCpu` returns coverage ∈ [0, slickIntensity
 * ·dt] per tick accumulating to ≤ 1, and |slope| ≤ transSlope by construction —
 * every factor multiplying them is a clamped smoothstep or a decaying
 * exponential. `slickDampCpu` returns a value in [1 − slickDamp, 1] for ANY
 * input including non-finite ones (it fails to 1 = no damping).
 */
import { projectOnTrack, smoothstepCpu, type WakeHull } from './wakeMath';
import { TRACK_CAPACITY, trackReachCpu, type TrackSample } from './wakeTrack';

/** m/s² — the only place the transverse wavelength's constant lives */
export const GRAVITY = 9.80665;

/**
 * Kelvin's result: the wake wedge half-angle is asin(1/3) ≈ 19.4712°, set by
 * the deep-water dispersion relation alone. It does NOT depend on ship speed,
 * hull form or displacement. The `kelvinAngle` param defaults to it and the
 * tests pin that — a "tuned" wedge angle is a physics error, not a look knob.
 */
export const KELVIN_HALF_ANGLE_DEG = (Math.asin(1 / 3) * 180) / Math.PI;

/**
 * Transverse Kelvin wavelength (m): λ = 2πv²/g. The waves that keep station
 * with the hull are those whose phase speed equals the ship's, and c = √(gλ/2π)
 * inverts to this. Speed-DEPENDENT, unlike the wedge angle.
 */
export function transverseWavelengthCpu(speed: number): number {
  const v = Math.max(Math.abs(speed), 1e-6);
  return (2 * Math.PI * v * v) / GRAVITY;
}

/** slick/transverse tunables — a structural subset of FlowFoamParams */
export interface SlickParams {
  slickIntensity: number;
  slickWidth: number;
  slickSpread: number;
  slickSpreadCap: number;
  slickDecay: number;
  slickEdge: number;
  slickDamp: number;
  slickBandFull: number;
  slickBandCut: number;
  transSlope: number;
  transDecay: number;
  transSpread: number;
  transInner: number;
  kelvinAngle: number;
  speedThreshold: number;
  fullWakeSpeed: number;
  trackLife: number;
  tailFade: number;
  bowClip: number;
  trackSpacing: number;
  trackCoarsen: number;
  trackCoarsenStart: number;
}

/** what one texel of the accumulation carries beyond foam */
export interface SlickField {
  /** lane coverage RATE (1/s) — accumulated by the advect pass */
  slick: number;
  /** additive world-X surface slope from the transverse waves (signed) */
  slopeX: number;
  /** additive world-Z surface slope from the transverse waves (signed) */
  slopeZ: number;
}

const ZERO: SlickField = { slick: 0, slopeX: 0, slopeZ: 0 };

/** falling edge with a flat CORE: 1 inside w·(1−edge), 0 at w */
function plateau(w: number, edge: number, x: number): number {
  const outer = Math.max(w, 1e-6);
  const inner = outer * (1 - Math.min(Math.max(edge, 0), 1));
  return 1 - smoothstepCpu(inner, Math.max(outer, inner + 1e-6), x);
}

/**
 * Slick coverage rate + transverse slope at a world point, in the track frame.
 * ONE projection feeds both, which is why they share a function: on the GPU the
 * polyline walk is the expensive part and it is already paid for by the foam.
 *
 * GPU twin: slickInjection.slickFieldNode — keep the formulas identical.
 */
export function slickFieldCpu(
  points: TrackSample[],
  wx: number,
  wz: number,
  hull: WakeHull,
  p: SlickParams,
  /** LIVE hull speed: a hove-to ship stops GENERATING, deposits then decay */
  liveSpeed = points[0]?.speed ?? 0,
): SlickField {
  const n = projectOnTrack(points, wx, wz);
  if (!n.found) return ZERO;
  // Same gate as the foam and for the same reason (wakeMath.wakeTrailCpu): this
  // is a SOURCE re-evaluated every frame. Stop the ship and the pattern freezes,
  // so the same dose lands on the same texels for ever and the lane pins solid.
  const liveGate = smoothstepCpu(
    p.speedThreshold,
    Math.max(p.speedThreshold * 2, p.speedThreshold + 1e-6),
    liveSpeed,
  );
  if (liveGate <= 0) return ZERO;

  const s = n.speed;
  const sf = smoothstepCpu(
    p.speedThreshold,
    Math.max(p.fullWakeSpeed, p.speedThreshold + 1e-6),
    s,
  );
  if (sf <= 0) return ZERO;

  const ay = Math.abs(n.lateral);
  const d = Math.max(n.dist, 0);
  const a = Math.max(n.age, 0);
  const tanK = Math.tan((p.kelvinAngle * Math.PI) / 180);
  const kelvin = d * tanK;
  const halfBeam = hull.beam * 0.5;

  // Both eviction edges of the history, exactly as the foam fades them — an
  // evicted sample must not pop the damping lane out of existence.
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
  // nothing ahead of the live cutwater — the sea in front of a ship is not calm
  const h = points[0];
  const ahead = (wx - h.x) * h.fx + (wz - h.z) * h.fz;
  const clip = 1 - smoothstepCpu(0, Math.max(p.bowClip, 1e-6), ahead);
  const common = sf * liveGate * tail * clip;

  // --- 1. the glassy lane ---------------------------------------------------
  // Width: the hull's own beam at the stem, widening with the water's AGE (the
  // turbulent patch diffuses) but never past the Kelvin wedge — the same
  // envelope every aft feature obeys, so the lane cannot fan out wider than the
  // wake it belongs to. A FLAT CORE with a soft shoulder, and deliberately NO
  // breakup noise: this factor is multiplied into a slope that the material
  // then differentiates in screen space (§V49), so a stippled lane would come
  // back as amplified per-pixel noise on the normals. Smooth by construction.
  const laneW = Math.max(
    Math.min(halfBeam * p.slickWidth + p.slickSpread * a, halfBeam + p.slickSpreadCap * kelvin),
    1e-3,
  );
  const slick =
    p.slickIntensity * common * plateau(laneW, p.slickEdge, ay) * Math.exp(-a / Math.max(p.slickDecay, 1e-6));

  // --- 2. transverse Kelvin crests -----------------------------------------
  // Inside the wedge only, strongest on the centreline. Energy spreads over a
  // widening front, so the amplitude falls like 1/√(1 + d/transSpread).
  const inner = 1 - smoothstepCpu(kelvin * p.transInner, Math.max(kelvin, kelvin * p.transInner + 1e-6), ay);
  const lam = transverseWavelengthCpu(Math.max(s, p.speedThreshold));
  const phase = (2 * Math.PI * d) / lam;
  const amp =
    p.transSlope *
    common *
    inner *
    Math.exp(-a / Math.max(p.transDecay, 1e-6)) /
    Math.sqrt(1 + d / Math.max(p.transSpread, 1e-6));
  // crests run ACROSS the track ⟹ the slope points ALONG it (n.fx, n.fz)
  const mag = amp * Math.sin(phase);
  return { slick, slopeX: mag * n.fx, slopeZ: mag * n.fz };
}

/**
 * §V48 band-limit factor for anything read out of the accumulation texture and
 * multiplied into a differentiated normal. The StorageTexture carries no mip
 * chain (compute-written), so once one screen pixel spans more than one texel a
 * `texture()` fetch is a point sample — and §V49 says the product rule then
 * hands the normal that aliasing amplified by the slope's own magnitude.
 *
 * Fades 1 → 0 between `slickBandFull` and `slickBandCut` pixels-per-texel. Zero
 * is the CORRECT mean for both consumers: the transverse slope is zero-mean by
 * construction, and the damping's far-field average is "no damping" because a
 * lane a few metres wide occupies a vanishing fraction of a footprint that
 * large. It is also belt-and-braces: the ocean's own normLod has already faded
 * the fine cascade to nothing well before this fires (measured in the report).
 */
export function bandKeepCpu(pixWorld: number, texelWorld: number, p: SlickParams): number {
  if (!Number.isFinite(pixWorld) || !Number.isFinite(texelWorld)) return 0;
  const px = Math.max(pixWorld, 0) / Math.max(texelWorld, 1e-6);
  const full = Math.max(p.slickBandFull, 1e-6);
  // smoothstepCpu(e0, e1, x) with e0 > e1 reads "1 below e1, 0 above e0"
  return smoothstepCpu(Math.max(p.slickBandCut, full + 1e-6), full, px);
}

/**
 * Capillary-damping multiplier the ocean material applies to its FINE slope
 * terms. 1 = untouched water, (1 − slickDamp) = fully slicked lane.
 *
 * §V44 bounded at source and FAILS SAFE: any non-finite input returns 1, so a
 * NaN can never propagate into the surface normal.
 */
export function slickDampCpu(slick: number, keep: number, p: SlickParams): number {
  if (!Number.isFinite(slick) || !Number.isFinite(keep)) return 1;
  const c = Math.min(Math.max(slick, 0), 1);
  const k = Math.min(Math.max(keep, 0), 1);
  const amt = Math.min(Math.max(p.slickDamp, 0), 1);
  return 1 - c * k * amt;
}
