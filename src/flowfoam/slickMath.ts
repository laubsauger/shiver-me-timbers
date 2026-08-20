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
 *      ADDITIVE SLOPE (index.wakeSlopeNode) AND, since §T13's displacement
 *      pass, as an ELEVATION (index.wakeHeightNode) — see below.
 *
 *   3. THE SAME FIELD AS A DISPLACEMENT. "A slope, never a displacement" was
 *      the standing rule and the user has asked for it revisited: a wake that
 *      only tilts the normal changes shading and nothing else — no silhouette,
 *      no parallax, no deformation, i.e. paint. DISPLACEMENT IS THE INTEGRAL OF
 *      SLOPE, and every mechanism here is the gradient of a CLOSED-FORM scalar,
 *      so nothing is invented and no numerical integration is needed:
 *
 *        term        slope (already shipped)          its potential η
 *        ─────────── ──────────────────────────────── ────────────────────────
 *        transverse  a·sin(φ)·dir̂                     −(a/k)·cos(φ)
 *        divergent   a·sin(φ)·dir̂                     NOT DISPLACED — see below
 *        eddy core   m·(2u·e^(−u²)/RIDGE_PEAK)·r̂      −m·coreR·e^(−u²)/RIDGE_PEAK
 *        bow mound   M·(−2u·e^(−u²)/RIDGE_PEAK)·ĝ     +M·thick·e^(−u²)/(RIDGE_PEAK·|g|)
 *
 *      k = 2π/λ is the term's OWN local wavenumber, so amplitude = slope·λ/2π
 *      falls out of the algebra rather than being a second tuning. `|g|` is the
 *      length of ∇(crest distance) = |fwd + sweep·right| — it appears because
 *      the shipped mound slope is written on the NORMALISED gradient, and
 *      dividing by it is what makes η's gradient equal that vector EXACTLY
 *      instead of approximately. There is no new look knob in any of this: move
 *      `transSlope`/`moundSlope`/`eddySlope` and the shape moves with the
 *      shading, because they are one field.
 *
 *      THE DIVERGENT TRAIN IS DELIBERATELY NOT DISPLACED, and someone will try
 *      to "fix" that. Its wavelength is λ_T/(1+t²) with t ≥ 1/√2 and running to
 *      KELVIN_TAN_MAX toward the centreline, so over the inner half of the
 *      wedge it is below the ocean mesh's Nyquist limit at EVERY speed (vertex
 *      spacing ≈ 1.1 m at the ship, §V.30). A per-vertex gate would delete it
 *      over most of its own extent; displacing it ungated puts ~4 cm of
 *      crawling moiré on the geometry. Its job — the feathered cusp texture —
 *      is a SHADING job, it is already band-limited against PIXELS in the
 *      fragment slope, and there it survives to ranges no mesh could carry.
 *
 *      WHY THE REMAINDER NEEDS NO NYQUIST GATE AT ALL, which is the property
 *      that keeps the CPU mirror camera-free (§V.8: a gate on vertex spacing
 *      could not be mirrored, because spacing is a function of the CAMERA).
 *      The mound (6.4 m ridge) and the eddies (7.65 m cores) are FIXED-SIZE
 *      features, comfortably above 2× the ~1.1 m spacing. The transverse train
 *      is the only variable one, and it band-limits ITSELF: amplitude = slope·
 *      λ/2π and λ = 2πv²/g, so a train short enough to alias is also slow
 *      enough to be tiny. MEASURED at the shipped params: the transverse train
 *      reaches λ = 2·spacing at v = 1.84 m/s, where `sf` has faded it to
 *      amplitude 4.5 mm. Worst case anywhere in the LOD's range (spacing 2.6 m
 *      at 100 m from the camera) is 26 mm, by which distance the region edge
 *      fade is already taking it out. State the bound, do not build the gate.
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
 * Transverse Kelvin wavelength (m) on the centreline: λ = 2πv²/g. The waves
 * that keep station with the hull are those whose phase speed equals the
 * ship's, and c = √(gλ/2π) inverts to this. Speed-DEPENDENT, unlike the wedge
 * angle. Off the centreline use `kelvinWavelengthCpu`, of which this is the
 * t → 0 limit.
 */
export function transverseWavelengthCpu(speed: number): number {
  const v = Math.max(Math.abs(speed), 1e-6);
  return (2 * Math.PI * v * v) / GRAVITY;
}

/**
 * Hard ceiling on tan θ for the DIVERGENT branch. Structural, not a look knob:
 * the branch runs to infinity on the centreline (where its wavelength runs to
 * zero), and an unbounded tan θ is an unbounded phase — §V44's "flooring a
 * divisor bounds the DIVISION, not the QUOTIENT" in its purest form. The
 * wavelength gate has already faded the amplitude to zero long before this
 * clamp engages (measured: it bites inside r/rMax ≈ 0.2 at every speed), so the
 * clamp only exists to keep the number finite where the amplitude is 0 —
 * because 0 × NaN is NaN, not 0.
 */
export const KELVIN_TAN_MAX = 12;

/** r = |lateral| / dist at the cusp line = tan(19.4712°) = 1/(2√2) */
export const KELVIN_R_MAX = 1 / (2 * Math.SQRT2);

/**
 * Extremum of |2u·e^(−u²)| = √2·e^(−½). Dividing by it normalises that profile
 * to a peak of exactly 1, which is how both surface features here are bounded
 * AT SOURCE (§V44) rather than by a clamp: the bow-mound ridge across its crest
 * line, and the shed eddies' radial dimple. Shared so the two cannot drift, and
 * so slickInjection's TSL twin divides by the same number (§V.33).
 */
export const RIDGE_PEAK = Math.SQRT2 * Math.exp(-0.5);

/** the two stationary-phase branches at a point, both as tan θ */
export interface KelvinBranches {
  /** √(1 − 8r²) — zero exactly ON the cusp, clamped to 0 outside the wedge */
  disc: number;
  /** TRANSVERSE branch: long crests across the track, 0 on the centreline */
  tT: number;
  /** DIVERGENT branch: the feathered crests fanning off the stem */
  tD: number;
}

/**
 * SOLVE the Kelvin stationary-phase condition in closed form — the second phase
 * field the bow wave needs, and the reason one field could never fake both.
 *
 * A wave travelling at angle θ to the track keeps station with the hull when
 * its phase speed is v·cos θ, so k = g/(v² cos²θ). Stationary phase
 * (∂φ/∂θ = 0) puts that wave at r = |y|/d = t/(1 + 2t²), t = tan θ. Inverting:
 *
 *      2r·t² − t + r = 0   ⟹   t = [1 ± √(1 − 8r²)] / (4r)
 *
 * TWO roots, which ARE the two wave systems: the minus root is the transverse
 * train (t → 0 on the centreline, crests across the track), the plus root is
 * the divergent train (t → ∞ on the centreline, crests at 54.74° to it — the
 * classic feathered V). They are real only for r ≤ 1/(2√2), i.e. inside
 * 19.4712° — the Kelvin envelope falls out of the algebra rather than being
 * imposed, and both roots meet at t = 0.7071 exactly on the cusp, so the field
 * is continuous across it.
 *
 * The transverse root is written as 2r/(1 + disc) rather than (1 − disc)/(4r):
 * algebraically identical, but the latter is 0/0 on the centreline.
 */
export function kelvinBranchesCpu(r: number): KelvinBranches {
  const rr = Math.max(Math.abs(r), 1e-6); // §V28 floored divisor
  const disc = Math.sqrt(Math.max(1 - 8 * rr * rr, 0));
  return {
    disc,
    tT: (2 * rr) / (1 + disc),
    tD: Math.min((1 + disc) / (4 * rr), KELVIN_TAN_MAX),
  };
}

/** local wavelength (m) of either branch: λ = 2πv²/(g(1+t²)) */
export function kelvinWavelengthCpu(speed: number, t: number): number {
  const v = Math.max(Math.abs(speed), 1e-6);
  return (2 * Math.PI * v * v) / (GRAVITY * (1 + t * t));
}

/** stationary phase (rad) of either branch: φ = (g/v²)(d + |y|t)√(1+t²) */
export function kelvinPhaseCpu(d: number, ay: number, t: number, speed: number): number {
  const v = Math.max(Math.abs(speed), 1e-6);
  return ((GRAVITY / (v * v)) * (d + ay * t) * Math.sqrt(1 + t * t));
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
  divSlope: number;
  divDecay: number;
  divSpread: number;
  divOuterFade: number;
  waveBandLow: number;
  waveBandHigh: number;
  moundSlope: number;
  eddySlope: number;
  eddyRadius: number;
  vortexOffset: number;
  vortexSpacing: number;
  vortexDecay: number;
  sternOnset: number;
  moundLead: number;
  moundSweep: number;
  moundSpan: number;
  moundThick: number;
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
  /**
   * ELEVATION (m, signed) — the scalar whose gradient is (slopeX, slopeZ),
   * minus the divergent train (module header explains why that one stays
   * shading-only). This is what the ocean's VERTEX stage adds to its own
   * displacement and what `CpuOcean` adds to `heightAt`, so the ship floats on
   * the wake she is drawn sitting in (§V.8).
   *
   * RESIDUAL, bounded not chased: η's gradient equals the slope field exactly
   * for the carrier (the sin/cos pair and the two ridge profiles) and only
   * approximately for the ENVELOPES — `innerFade`, the exponential decays and
   * `spread` all vary with position, so ∇η carries an extra (∇amp)·cos(φ)/k
   * term the slope field does not. Envelope scales are tens of metres against
   * wavelengths of 6–23 m, so the disagreement is ≈ λ/(2π·L_env) ≲ 9% of the
   * slope. It shows as shading that leads or trails the geometry by a fraction
   * of a crest at the trail's outer fade, and nowhere else.
   */
  elev: number;
}

const ZERO: SlickField = { slick: 0, slopeX: 0, slopeZ: 0, elev: 0 };

/**
 * §V.68 THE SMITH CORRECTION, applied to the wake exactly as the mirror's
 * spectrum applies it to every FFT mode: linear deep-water dynamic pressure
 * decays as e^(−k·d), so a hull LOW-PASSES the sea by its own draft. A wake
 * feature is a free-surface deformation like any other and obeys the same law.
 *
 * It is what bounds the one loop this whole displacement pass could close. The
 * ship sits in her own bow mound — physically true, and she should — but she
 * feels 14% of it, not all of it, and by the same arithmetic every other
 * floating body already answers to. `d = 0` returns 1 exactly, so the geometric
 * readers are bit-identical to an un-attenuated field.
 *
 * GPU twin: none, deliberately. The GPU DRAWS the true surface; only buoyancy
 * asks a pressure question, and buoyancy is CPU-side.
 */
export function smithAtten(k: number, depth: number): number {
  if (!(depth > 0)) return 1;
  return Math.exp(-Math.max(k, 0) * depth);
}

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
  /**
   * World size (m) of one texel of the tier this is being written into. The
   * wave trains are band-limited against it AT THE SOURCE (§V48). 0 = "no
   * carrier grid", which disables the gate — only for analysis, never for a
   * real write, since the GPU always knows its own texel.
   */
  texel = 0,
  /**
   * Cutwater odometer (m) — `track.odo`. `odo − dist` is the odometer reading
   * when this water was passed and is CONSTANT at a fixed world point, which is
   * what anchors the shed eddies. 0 only shifts the street's phase origin, so
   * analysis may omit it; a real write must pass the live value or the CPU and
   * GPU streets sit at different phases.
   */
  odoHead = 0,
  /**
   * §V.68 SMITH DEPTH (m). 0 = the TRUE free surface, which is what every
   * GEOMETRIC reader wants (§V.8: the drawn sea, the waterline, the cutwater).
   * > 0 = the elevation whose hydrostatic head equals this wake's dynamic
   * pressure at that depth, each term attenuated by e^(−k·d) at its OWN
   * wavenumber — which is what BUOYANCY must read, exactly as it already does
   * for every FFT mode. It affects `elev` only; the slope is a shading quantity
   * and has no depth.
   */
  smithDepth = 0,
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

  // --- 2. the two Kelvin wave systems --------------------------------------
  // ONE solve of the stationary-phase condition yields both branches, so the
  // divergent (bow) train costs a sqrt and two divides on top of the transverse
  // one that was already here. See kelvinBranchesCpu for the algebra.
  const v = Math.max(s, p.speedThreshold);
  const br = kelvinBranchesCpu(ay / Math.max(d, 1e-6));
  const spread = (L: number) => 1 / Math.sqrt(1 + d / Math.max(L, 1e-6));
  // §V48: a wave train whose wavelength has gone sub-texel must fade to its own
  // MEAN, which for a zero-mean crest field is zero. Doing this at the SOURCE
  // (rather than only at sample time) is what makes the divergent branch's
  // centreline singularity harmless — λ→0 there, so the gate is already 0.
  const bandGate = (t: number): number => {
    if (!(texel > 0)) return 1; // no carrier grid ⟹ nothing to alias against
    const px = kelvinWavelengthCpu(v, t) / texel;
    return smoothstepCpu(p.waveBandLow, Math.max(p.waveBandHigh, p.waveBandLow + 1e-6), px);
  };
  // right = (fz, −fx): the track frame's lateral axis, signed to this point
  const sgn = n.lateral < 0 ? -1 : 1;
  const rx = n.fz * sgn;
  const rz = -n.fx * sgn;

  // 2a. TRANSVERSE — long crests across the track, strongest on the centreline.
  // Solved on its own branch rather than the old d-only approximation, so the
  // crests correctly bow backward toward the cusp instead of running straight.
  const innerFade =
    1 - smoothstepCpu(kelvin * p.transInner, Math.max(kelvin, kelvin * p.transInner + 1e-6), ay);
  const ampT =
    p.transSlope *
    common *
    innerFade *
    Math.exp(-a / Math.max(p.transDecay, 1e-6)) *
    spread(p.transSpread) *
    bandGate(br.tT);
  /**
   * PHASE ORIGIN: A CREST AT THE STEM, NOT A TROUGH (§T.82). `kelvinPhaseCpu`
   * is 0 at the cutwater, and with η = −(a/k)·cos φ below that put the train's
   * first TROUGH under the stem — the moving-PRESSURE-POINT picture, where the
   * source pushes the water down. A hull is not a pressure point: its bow is a
   * stagnation region and the bow wave is the CREST that climbs the stem
   * (thin-ship theory puts a SOURCE at the entrance, and a source raises the
   * water behind it; the stern, a sink, starts with a trough). The +π moves
   * cos AND sin together, so ∇η = slope still holds exactly and the drawn
   * surface and its shading shift by half a wavelength as one.
   *
   * LOAD-BEARING, not cosmetic, since buoyancy reads this field (§T.78): a/k
   * is 0.5 m at 10 m/s after Smith attenuation and λ/2 = 32 m against a 38.5 m
   * hull, so the trough-at-stem phase sat her stem in a 0.5 m hole with her
   * stern on a 0.5 m crest — measured −1.2° by the head on a flat sea, the
   * user's "front heavy". With the crest at the bow the same train trims her
   * by the STERN at that Froude number (Fn 0.51, past the hump), which is what
   * a displacement hull does. It also closes the apex gap §T.78 recorded: the
   * mound's +0.5 m crest 1.6 m ahead of the stem no longer drops into a −0.5 m
   * trough at the cutwater.
   */
  const phiT = kelvinPhaseCpu(d, ay, br.tT, v) + Math.PI;
  const magT = ampT * Math.sin(phiT);
  // slope points along the propagation direction: aft·cosθ + lateral·sinθ
  const cT = 1 / Math.sqrt(1 + br.tT * br.tT);
  const sT = br.tT * cT;
  /**
   * THE TRANSVERSE TRAIN AS AN ELEVATION. |∇φ| = (g/v²)(1+t²) = 2π/λ = k, so
   * η = −(a/k)·cos φ has exactly ∇η = a·sin(φ)·dir̂ — the vector two lines
   * above. Amplitude a/k = a·λ/2π is therefore not a second tuning but the
   * consequence of the one `transSlope` already sets.
   */
  const kT = (GRAVITY * (1 + br.tT * br.tT)) / (v * v);
  const elevT = (-ampT * Math.cos(phiT) * smithAtten(kT, smithDepth)) / Math.max(kT, 1e-6);

  // 2b. DIVERGENT — THE BOW WAVE. Short steep crests fanning off the stem,
  // strongest at the cusp line and dying inward. sf SQUARED, the same shaping
  // the foam's Kelvin arms use: the user asks for this "at higher speeds", and
  // a hull barely making way throws no bow wave at all.
  const rMaxLocal = KELVIN_R_MAX;
  const r = ay / Math.max(d, 1e-6);
  // the wedge boundary is a real edge, but a hard step in a field that gets
  // differentiated is a 1-px line (§V38) — feather it just outside the cusp
  const outer =
    1 -
    smoothstepCpu(
      rMaxLocal,
      rMaxLocal * (1 + Math.max(p.divOuterFade, 1e-6)),
      r,
    );
  const ampD =
    p.divSlope *
    common *
    sf * // ← squared overall: `common` already carries one sf
    outer *
    Math.exp(-a / Math.max(p.divDecay, 1e-6)) *
    spread(p.divSpread) *
    bandGate(br.tD);
  const magD = ampD * Math.sin(kelvinPhaseCpu(d, ay, br.tD, v));
  const cD = 1 / Math.sqrt(1 + br.tD * br.tD);
  const sD = br.tD * cD;

  // --- 3. SHED EDDIES: the vortex street as a SURFACE, not as paint --------
  // GPU twin: the eddy block in slickInjection.slickFieldNode. The street was
  // already modelled for the FOAM (wakeMath: a von Kármán pair, port and
  // starboard π out of phase, shed at the transom corners `vortexSpacing`
  // apart) and none of it reached the normal. Nothing here is invented: the
  // spacing, the offset and the decay are the street's own, so the scale comes
  // from the hull rather than from a noise field.
  //
  // BOTH cores are summed. Taking only the near-side one leaves a step across
  // the centreline where the lateral sign flips, and a step in a field the
  // ocean differentiates is a 1-px line (§V38).
  const onset = smoothstepCpu(0, Math.max(p.sternOnset, 1e-6), d - hull.length);
  const coreR = Math.max(halfBeam * p.eddyRadius, 1e-6);
  const vOff = halfBeam * p.vortexOffset;
  const odo = odoHead - d;
  const latS = ay * sgn; // SIGNED lateral, in the track's own frame
  const rax = n.fz; // unsigned right = (fz, −fx)
  const raz = -n.fx;
  /**
   * Returns [slopeX, slopeZ, η/magE] for one core. The dimple's potential is
   * −coreR·e^(−u²)/RIDGE_PEAK: differentiating it radially gives back exactly
   * the 2u·e^(−u²)/RIDGE_PEAK profile above, so the surface the eye sees and
   * the surface the shading solves are the same one. NEGATIVE — a vortex core
   * is a depression, which is what the street should read as.
   */
  const core = (off: number, phase: number): [number, number, number] => {
    const qE = (odo - phase) / Math.max(p.vortexSpacing, 1e-6);
    const dAlong = (qE - Math.floor(qE + 0.5)) * p.vortexSpacing;
    const dAcross = latS - off;
    const rE = Math.hypot(dAlong, dAcross);
    const uE = rE / coreR;
    // 2u·e^(−u²) over its own extremum: one core peaks at exactly eddySlope
    const prof = (2 * uE * Math.exp(-uE * uE)) / RIDGE_PEAK;
    const inv = prof / Math.max(rE, 1e-6);
    return [
      (n.fx * dAlong + rax * dAcross) * inv,
      (n.fz * dAlong + raz * dAcross) * inv,
      (-coreR * Math.exp(-uE * uE)) / RIDGE_PEAK,
    ];
  };
  const cS = core(vOff, 0);
  const cP = core(-vOff, p.vortexSpacing * 0.5);
  // §V48 against the FEATURE (a whole core), never the texel. §V48(b): the mean
  // is ZERO and here the naive answer is the correct one — a radial dimple's
  // slope integrates to zero by symmetry, so fading to zero IS fading to mean.
  const bandE =
    texel > 0
      ? smoothstepCpu(p.waveBandLow, Math.max(p.waveBandHigh, p.waveBandLow + 1e-6), (2 * coreR) / texel)
      : 1;
  const magE =
    p.eddySlope *
    common *
    onset *
    innerFade * // nothing aft may pan out past the Kelvin wedge
    Math.exp(-a / Math.max(p.vortexDecay, 1e-6)) *
    bandE;

  // aft unit vector = −forward; both trains propagate away from the hull
  const slopeX = magT * (-n.fx * cT + rx * sT) + magD * (-n.fx * cD + rx * sD) + magE * (cS[0] + cP[0]);
  const slopeZ = magT * (-n.fz * cT + rz * sT) + magD * (-n.fz * cD + rz * sD) + magE * (cS[1] + cP[1]);
  /**
   * A Gaussian dimple has no single wavenumber; π/coreR (i.e. λ = 2·coreR, the
   * core's full width) is the one that reproduces its own extremum spacing and
   * is the same yardstick §V48 is already measured on for this feature. At the
   * shipped 3.83 m radius and a 2 m draft that is e^(−1.64) = 0.19.
   */
  const elevE = magE * (cS[2] + cP[2]) * smithAtten(Math.PI / coreR, smithDepth);
  return { slick, slopeX, slopeZ, elev: elevT + elevE };
}

/**
 * THE BOW MOUND AS A SURFACE (user: "we actually show the water pushed
 * forward"). `wakeMath.bowMoundCpu` paints FOAM on this shape; until now there
 * was no shape under the paint, so the water ahead of the stem read completely
 * undisturbed however much foam was on it.
 *
 * A ridge of water peaking `moundLead` metres ahead of the cutwater on the
 * centreline and sweeping aft as it goes outboard, where it runs into the
 * divergent crests. Its SLOPE is the derivative of that ridge across its own
 * crest line: g(u) = −2u·e^(−u²), normalised by its own extremum (√2·e^(−½) =
 * 0.8578) so the peak slope is exactly `moundSlope` — §V44 bounded at source,
 * by construction rather than by a clamp.
 *
 * Evaluated in the LIVE stem frame because it has to lead the ship, and written
 * (not accumulated) into the slope channels, so it travels with her.
 * `moundSpeed` is the LAGGED speed (wakeTrack.approachExp) — the same drive the
 * foam mound rides, so the two build and subside together instead of
 * disagreeing about when the bow is working.
 */
export function bowSlopeCpu(
  head: TrackSample,
  wx: number,
  wz: number,
  moundSpeed: number,
  p: SlickParams,
  texel = 0,
  /** §V.68 pressure depth (m); 0 = the true free surface — see smithAtten */
  smithDepth = 0,
): { slopeX: number; slopeZ: number; elev: number } {
  const gate = smoothstepCpu(
    p.speedThreshold,
    Math.max(p.speedThreshold * 2, p.speedThreshold + 1e-6),
    moundSpeed,
  );
  if (gate <= 0) return { slopeX: 0, slopeZ: 0, elev: 0 };
  const sf = smoothstepCpu(
    p.speedThreshold,
    Math.max(p.fullWakeSpeed, p.speedThreshold + 1e-6),
    moundSpeed,
  );
  const dx = wx - head.x;
  const dz = wz - head.z;
  const ahead = dx * head.fx + dz * head.fz;
  const side = dx * head.fz - dz * head.fx; // right = (fz, −fx)
  const aside = Math.abs(side);
  const sgn = side < 0 ? -1 : 1;
  // signed distance from the swept crest line — the same shape the foam uses
  const thick = Math.max(p.moundThick, 1e-6);
  const u = (ahead - (p.moundLead - p.moundSweep * aside)) / thick;
  // §V48: the ridge is ~2·moundThick wide; if that goes sub-texel it must fade
  const band = texel > 0
    ? smoothstepCpu(p.waveBandLow, Math.max(p.waveBandHigh, p.waveBandLow + 1e-6), (2 * thick) / texel)
    : 1;
  const lat = 1 - smoothstepCpu(0, Math.max(p.moundSpan, 1e-6), aside);
  const mag =
    (p.moundSlope * gate * sf * lat * band * (-2 * u * Math.exp(-u * u))) / RIDGE_PEAK;
  // ∇(crest distance) = forward + moundSweep·(lateral, signed), normalised
  const gx = head.fx + p.moundSweep * head.fz * sgn;
  const gz = head.fz - p.moundSweep * head.fx * sgn;
  const len = Math.max(Math.hypot(gx, gz), 1e-6);
  /**
   * THE MOUND AS A RIDGE OF WATER, not just as a tilt. η = A·e^(−u²) with
   * A = moundSlope·thick/(RIDGE_PEAK·|∇dc|) has ∇η equal to the returned slope
   * vector EXACTLY — the `|∇dc|` divisor is there because the slope above is
   * written on the NORMALISED gradient, and without it the shape and the
   * shading would disagree by a constant 1.35× at the shipped `moundSweep`.
   *
   * λ = 2·moundThick = 6.4 m for the §V.68 factor: the ridge's full width, the
   * same yardstick its own §V48 band gate is measured on.
   */
  const elev =
    (p.moundSlope * gate * sf * lat * band * thick * Math.exp(-u * u) * smithAtten(Math.PI / thick, smithDepth)) /
    (RIDGE_PEAK * len);
  return { slopeX: (mag * gx) / len, slopeZ: (mag * gz) / len, elev };
}

/**
 * §V48 band-limit factor for anything read out of the accumulation texture and
 * multiplied into a differentiated normal. The StorageTexture carries no mip
 * chain (compute-written), so once one screen pixel can no longer resolve the
 * finest thing the texture holds, a `texture()` fetch is a point sample — and
 * §V49 says the product rule then hands the normal that aliasing amplified by
 * the slope's own magnitude.
 *
 * `featureWorld` IS THE FINEST WRITTEN FEATURE, NOT THE TEXEL. It used to be
 * one texel (0.234 m near) and that is §B.20 again: nothing in this field is a
 * texel wide — the mound ridge is 2·moundThick, the transverse train is 5.8 m
 * at 3 m/s, the damping lane is metres of smooth shoulder — and every periodic
 * term is already floored at the SOURCE (`waveBandLow` texels per wavelength,
 * slickInjection), so `texel · waveBandLow` is exactly the finest thing that
 * can ever be written. Measured on the texel yardstick, the wake's whole
 * SURFACE was deleted at 80 m astern and from any camera under ~6 m of height,
 * while its albedo went on being drawn — the paint outliving its shape.
 *
 * Fades 1 → 0 between `slickBandFull` and `slickBandCut` pixels per feature.
 * Zero is the CORRECT mean for both consumers: the transverse slope is
 * zero-mean by construction, and the damping's far-field average is "no
 * damping" because a lane a few metres wide occupies a vanishing fraction of a
 * footprint that large. It is also belt-and-braces: the ocean's own normLod has
 * already faded the fine cascade to nothing well before this fires.
 */
export function bandKeepCpu(pixWorld: number, featureWorld: number, p: SlickParams): number {
  if (!Number.isFinite(pixWorld) || !Number.isFinite(featureWorld)) return 0;
  const px = Math.max(pixWorld, 0) / Math.max(featureWorld, 1e-6);
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
