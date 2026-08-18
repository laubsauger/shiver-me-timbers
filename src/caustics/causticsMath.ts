/**
 * Pure caustic math (§V.34). ZERO three.js imports on purpose: every formula
 * the TSL nodes evaluate has a CPU twin here, and tests/caustics.test.ts
 * proves them against a brute-force ray trace before the GPU ever runs
 * (same discipline as ocean/oceanMath.ts).
 *
 * ── DERIVATION ───────────────────────────────────────────────────────────
 * Parameterise the water surface by the undisplaced horizontal coordinate
 * u = (x, z). The FFT gives us, per cascade:
 *   horizontal map  q(u) = u + λ·D(u)        (displacement texture .xz)
 *   height          h(u)                     (displacement texture .y)
 *   world gradient  g(u) = ∇h                (derivatives texture .xy / .zw)
 *
 * A sun ray entering at the surface point (q, h) refracts to direction T and
 * lands on a receiver `d` metres below at
 *
 *     Q(u) = q(u) + w(u)·d(u),     w := T_xz / (−T_y),   d := h − y_receiver
 *
 * Flux conservation gives the caustic gain as the ratio of the surface patch
 * area to the receiver patch area:
 *
 *     G = |det ∂q/∂u| / |det ∂Q/∂u| = |det A| / |det M|
 *
 * and, expanding ∂Q/∂u with ∇_u d = ∇h = g,
 *
 *     M = A + w⊗g + d·B,     B := ∂w/∂u
 *
 * so with C := A + w⊗g the determinant is EXACTLY QUADRATIC IN DEPTH:
 *
 *     det M(d) = det C + d·mixed(C,B) + d²·det B
 *
 * Three consequences this design leans on:
 *  - at d = 0, det M = det C = det A: the constant term IS the FFT's existing
 *    foam Jacobian (§V.6). Caustics and foam are the same quantity taken at
 *    different receiver offsets, which is why no second surface eval is
 *    needed (§V.34).
 *  - any receiver depth costs 2 FMAs once (detC, mixed, detB) are built, so
 *    hull-at-waterline and seabed-at-8m share one evaluation.
 *  - reflection is the same algebra with reflect() instead of refract() and
 *    "height above water" instead of depth — the sun dancing on a hull side.
 */

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

/** vertical component of a refracted/reflected ray is floored here (§V.28) */
export const MIN_VERTICAL = 0.05;

/**
 * Cap on lateral drift per metre of span (§B.11).
 *
 * Flooring the divisor keeps the DIVISION safe but leaves the QUOTIENT free
 * to reach |ray|/MIN_VERTICAL = 20, and that is not a safe number: the
 * finite difference of a field that saturates at ±20 over an epsilon of
 * ~0.35 m reaches |∂w| ≈ 50, so det M(span) acquires coefficients in the
 * hundreds and flips sign between neighbouring pixels. The gain then
 * oscillates between ~0 and its |detA|/σ ceiling per pixel — speckle.
 *
 * Refraction has a physical ceiling here: air→water can never bend more
 * than 48.6° from the surface normal (Snell's window), so tan(48.6°) = 1.135
 * relative to the normal, and a few times that relative to vertical once the
 * wave tilts. Reflection has NO such bound — a wave face can throw the sun
 * horizontally or downward — which is why the reflected branch must be
 * gated on the ray actually travelling upward as well as clamped.
 */
export const MAX_DRIFT = 2.5;

/** limit a drift vector's magnitude, preserving direction (§V.28) */
export function clampDrift(drift: Vec2, maxDrift: number): Vec2 {
  const limit = Math.max(maxDrift, 1e-3);
  const len = Math.hypot(drift[0], drift[1]);
  if (!(len > limit)) return len > 0 || len === 0 ? drift : [0, 0];
  const s = limit / len;
  return [drift[0] * s, drift[1] * s];
}

export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const span = edge1 - edge0;
  if (Math.abs(span) < 1e-12) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / span);
  return t * t * (3 - 2 * t);
}

/** Snell ratio for a ray crossing air → water */
export function airToWaterEta(waterIor: number): number {
  return 1 / Math.max(waterIor, 1e-3);
}

/**
 * Water surface normal from the WORLD-space height gradient. The ocean
 * material already divides the raw ∂h/∂x by the choppy stretch (1+λ∂Dx/∂x)
 * to get this gradient, so g is a true slope, not a texture value.
 */
export function normalFromSlope(gx: number, gz: number): Vec3 {
  const inv = 1 / Math.sqrt(gx * gx + gz * gz + 1);
  return [-gx * inv, inv, -gz * inv];
}

/** GLSL `refract(I, N, eta)`. I points INTO the surface. Zero vector on TIR. */
export function refract(I: Vec3, N: Vec3, eta: number): Vec3 {
  const dotNI = N[0] * I[0] + N[1] * I[1] + N[2] * I[2];
  const k = 1 - eta * eta * (1 - dotNI * dotNI);
  if (k < 0) return [0, 0, 0];
  const f = eta * dotNI + Math.sqrt(k);
  return [eta * I[0] - f * N[0], eta * I[1] - f * N[1], eta * I[2] - f * N[2]];
}

/** GLSL `reflect(I, N)`. I points INTO the surface. */
export function reflect(I: Vec3, N: Vec3): Vec3 {
  const d = 2 * (N[0] * I[0] + N[1] * I[1] + N[2] * I[2]);
  return [I[0] - d * N[0], I[1] - d * N[1], I[2] - d * N[2]];
}

export interface Drift {
  /** lateral travel per metre of depth (refracted) or height (reflected) */
  drift: Vec2;
  /** |vertical| component of the ray, floored — path length = span / this */
  vertical: number;
  /** 0 when no light enters/leaves here (sun behind the local surface) */
  valid: number;
}

/**
 * Refracted sun ray, expressed as lateral drift per metre of depth.
 * `sun` points FROM the surface TOWARD the sun (the engine's convention,
 * cf. ocean/surfaceMaterial `normalWorld.dot(sunDirectionUniform)`).
 */
export function refractedDrift(
  sun: Vec3,
  gx: number,
  gz: number,
  eta: number,
  maxDrift: number = MAX_DRIFT,
): Drift {
  const N = normalFromSlope(gx, gz);
  const cosI = N[0] * sun[0] + N[1] * sun[1] + N[2] * sun[2];
  if (cosI <= 0) return { drift: [0, 0], vertical: MIN_VERTICAL, valid: 0 };
  const T = refract([-sun[0], -sun[1], -sun[2]], N, eta);
  const down = Math.max(-T[1], MIN_VERTICAL);
  return {
    drift: clampDrift([T[0] / down, T[2] / down], maxDrift),
    vertical: down,
    valid: 1,
  };
}

/**
 * Sun ray specularly reflected UP off the surface — above-water caustics.
 *
 * Unlike refraction this has NO angular bound: a steep wave face can throw
 * the reflected ray horizontal or straight back down into the sea. Such a
 * ray cannot illuminate anything above the water, so it is gated out
 * entirely (§B.11) rather than divided by a floored near-zero vertical.
 */
export function reflectedDrift(
  sun: Vec3,
  gx: number,
  gz: number,
  maxDrift: number = MAX_DRIFT,
): Drift {
  const N = normalFromSlope(gx, gz);
  const cosI = N[0] * sun[0] + N[1] * sun[1] + N[2] * sun[2];
  const R = reflect([-sun[0], -sun[1], -sun[2]], N);
  // the ray must both come from a sunlit face AND travel upward
  if (cosI <= 0 || R[1] <= MIN_VERTICAL) {
    return { drift: [0, 0], vertical: MIN_VERTICAL, valid: 0 };
  }
  return {
    drift: clampDrift([R[0] / R[1], R[2] / R[1]], maxDrift),
    vertical: R[1],
    valid: 1,
  };
}

/**
 * Diagonal of the horizontal-displacement Jacobian A, straight out of the
 * derivatives texture (.zw = ∂Dx/∂x, ∂Dz/∂z). The off-diagonal ∂Dx/∂z is not
 * stored per-texel — only folded into the packed foam Jacobian — so it is
 * dropped here. It is the smaller term for wind-aligned seas and costs three
 * extra texture taps to recover, which §V.17 does not have room for.
 */
export function surfaceStretch(lambda: number, dDxdx: number, dDzdz: number) {
  const a11 = 1 + lambda * dDxdx;
  const a22 = 1 + lambda * dDzdz;
  return { a11, a22, detA: a11 * a22 };
}

/** coefficients of det M(d) = detC + d·mixed + d²·detB */
export interface RayJacobian {
  detC: number;
  mixed: number;
  detB: number;
  detA: number;
}

/**
 * Build the depth polynomial. `driftDx`/`driftDz` are ∂w/∂x and ∂w/∂z,
 * measured by finite difference on the live surface (see causticsNode).
 */
export function rayJacobian(
  a11: number,
  a22: number,
  w: Vec2,
  g: Vec2,
  driftDx: Vec2,
  driftDz: Vec2,
): RayJacobian {
  // C = A + w⊗g
  const c11 = a11 + w[0] * g[0];
  const c12 = w[0] * g[1];
  const c21 = w[1] * g[0];
  const c22 = a22 + w[1] * g[1];
  // B columns are the finite differences of w along x and z
  const b11 = driftDx[0];
  const b21 = driftDx[1];
  const b12 = driftDz[0];
  const b22 = driftDz[1];
  return {
    detA: a11 * a22,
    detC: c11 * c22 - c12 * c21,
    mixed: c11 * b22 + b11 * c22 - c12 * b21 - b12 * c21,
    detB: b11 * b22 - b12 * b21,
  };
}

export function jacobianAtDepth(j: RayJacobian, d: number): number {
  return j.detC + d * (j.mixed + d * j.detB);
}

/** σ(d): folds broaden with depth, which is also the caustic's defocus */
export function foldSoftness(base: number, perMeter: number, d: number): number {
  return Math.max(base + perMeter * Math.max(d, 0), 1e-4);
}

/**
 * Regularised reciprocal. det M crosses zero at a caustic fold, which is
 * exactly where the intensity wants to be infinite — dividing by
 * sqrt(det² + σ²) keeps the bright ridge, stays finite, and never branches
 * (§V.28). Returns 1 on flat water, so callers work with `gain − 1`.
 */
export function causticGain(detA: number, detM: number, softness: number): number {
  const s = Math.max(softness, 1e-4);
  return Math.abs(detA) / Math.sqrt(detM * detM + s * s);
}

export interface CausticResponse {
  /** ≥ 0, Reinhard-capped below `maxGain` — ADDITIVE light */
  bright: number;
  /** ∈ [1 − darkStrength, 1] — MULTIPLICATIVE on albedo */
  darken: number;
}

/**
 * Split the gain into a bright lobe (ray convergence) and a dark lobe
 * (divergence). Flat water → { bright: 0, darken: 1 }, so this changes
 * nothing where the sea is glass instead of washing the receiver.
 *
 * §B.11 — WHY THE TWO LOBES TAKE DIFFERENT ROUTES. The dark lobe used to be
 * returned as a negative number added into the same additive term, which
 * reached the hull as a NEGATIVE emissive: it subtracted light, crushed
 * timber to black, and (because the additive term carries per-channel Jerlov
 * extinction, which removes blue and green fastest) left the remainder
 * glowing red. Divergence physically means LESS of the incoming light
 * arrives, which is a multiplication, not a subtraction. Returning it as a
 * factor in [1 − darkStrength, 1] makes negative light impossible by
 * construction rather than by clamping after the fact.
 */
export function causticResponse(
  gain: number,
  maxGain: number,
  darkStrength: number,
): CausticResponse {
  const raw = Number.isFinite(gain) ? gain - 1 : 0;
  const cap = Math.max(maxGain, 1e-3);
  const lit = Math.max(raw, 0);
  // gain ≥ 0 by construction, so raw ≥ −1 and this shortfall is already 0..1
  const shortfall = clamp01(-Math.min(raw, 0));
  return {
    bright: lit / (1 + lit / cap),
    darken: 1 - shortfall * clamp01(darkStrength),
  };
}

/** Beer–Lambert along the actual slanted path, not straight down. */
export function depthAttenuation(
  span: number,
  vertical: number,
  density: number,
): number {
  const path = Math.max(span, 0) / Math.max(vertical, MIN_VERTICAL);
  return Math.exp(-Math.max(density, 0) * path);
}

/** per-channel extinction for a submerged receiver — red dies first */
export function absorptionTint(depth: number, density: Vec3, pathScale: number): Vec3 {
  const p = Math.max(depth, 0) * Math.max(pathScale, 0);
  return [
    Math.exp(-density[0] * p),
    Math.exp(-density[1] * p),
    Math.exp(-density[2] * p),
  ];
}

/**
 * Upward fill from the sea. Downward-facing surfaces see the most water, and
 * the whole term dies off going up the rig — that height falloff is what
 * stops a mast top being lit as if it sat on the waves.
 */
export function bounceWeight(
  normalY: number,
  heightAboveWater: number,
  falloffMeters: number,
): number {
  const facing = clamp01(0.5 - 0.5 * normalY);
  const h = Math.max(heightAboveWater, 0);
  return facing * Math.exp(-h / Math.max(falloffMeters, 1e-3));
}

/** 0 well above the waterline → 1 at and below it (spray band included) */
export function wetness(depth: number, bandAbove: number, bandBelow: number): number {
  return smoothstep(-Math.max(bandAbove, 0), Math.max(bandBelow, 1e-3), depth);
}

/**
 * Reflected-branch reach above the waterline: exponential falloff with a HARD
 * ceiling. The exponential ALONE only decays — it never reaches zero, so at the
 * shipped 4.5 m falloff a deck 6 m up still receives 26% of full strength and
 * the upper works keep a percent or two all the way into the rig. That is what
 * the user saw as caustics "spilling way too high up on the boats". The ramp to
 * zero at `maxHeight` is the bound; the exponential is only the shape.
 *
 * Mirrored by `heightFade` in causticsNode.ts.
 */
export function reflectedReach(
  heightAbove: number,
  falloff: number,
  maxHeight: number,
): number {
  const h = Math.max(heightAbove, 0);
  const decay = Math.exp(-h / Math.max(falloff, 0.01));
  const ceil = Math.max(maxHeight, 1e-3);
  // decreasing smoothstep (edge0 > edge1): 1 well under the ceiling, 0 above it
  return decay * smoothstep(ceil, ceil * 0.6, h);
}

/**
 * How much sea-bounced light a receiver whose world normal has y = `nY` can
 * catch. This light is travelling UPWARD off the wave faces, so a deck
 * (nY = +1) cannot be struck by it at all, while a vertical hull side (nY = 0)
 * catches it square — which is the "light dancing on the boat" the reflected
 * branch exists to draw. Every other face gate in this module is about the
 * WATER's normal; this is the only one about the RECEIVER's.
 *
 * Mirrored by `facing` in causticsNode.ts.
 */
export function receiverFacing(nY: number, limit: number): number {
  return smoothstep(Math.max(limit, 1e-3), 0, nY);
}

/**
 * cos(incidence) between the REFLECTED RAY and the receiver's own normal —
 * the term this branch never had, and the reason the pattern "becomes very
 * distorted at the furthest out of the water" on a curved bow.
 *
 * `receiverFacing` above is a pure function of nY, so it answers only "is this
 * surface pointing up". A hull curving round the bow holds nY = 0 through the
 * whole sweep, so that gate reads 1.000 for every azimuth while the projection
 * behind it stretches without bound. Measured on a vertical side: 1.4x stretch
 * facing a 45 deg sun square, 2.8x at 45 deg off it, and at a 60 deg sun the
 * WHOLE vertical hull is already past 2x — where a projected pattern has
 * stopped reading as caustics at all.
 *
 * The pattern is transported along the reflected ray, and the areal stretch of
 * a beam landing on a surface is exactly 1/|cos(incidence)|, so fading by that
 * cosine makes the contribution vanish precisely as the stretch diverges. It
 * is not a tuned falloff — it is the cosine every irradiance calculation
 * carries, and its absence is why a vertical hull was lit at full strength by
 * a noon sun whose sea-reflected light goes straight up past it.
 *
 * `drift` is lateral travel per metre of rise, so the ray direction is
 * (drift.x, 1, drift.z) normalized. `amount` at 0 restores the old ungated
 * behaviour exactly. Bounded to [0,1] at source (§V.44) — a non-unit normal
 * can only ever be clamped, never amplify the term.
 *
 * Mirrored by `incidence` in causticsNode.ts.
 */
export function reflectedIncidence(drift: Vec2, normal: Vec3, amount: number): number {
  const len = Math.hypot(drift[0], 1, drift[1]);
  // light TRAVELS along the ray, so it lands on a face whose normal opposes it
  const cos =
    -(drift[0] * normal[0] + normal[1] + drift[1] * normal[2]) / len;
  return 1 + (clamp01(cos) - 1) * clamp01(amount);
}

/**
 * Half-width of the ABOVE-water side of the waterline crossfade, shrunk by the
 * receiver's own slope.
 *
 * A VERTICAL band means completely different things on two receivers, which is
 * the §V.52 shape (one coefficient setting two physically independent
 * responses). `waterlineBlend` is 0.8 m because a hull needed that much to stop
 * the above/below branches meeting in a visible seam — and on a hull, 0.8 m of
 * height is 0.8 m of surface. On a beach the same 0.8 m is 0.8/slope metres of
 * DRY SAND: 6 m at 1:10, 24 m at 1:40. That is the user's "on shore seem to go
 * up a little bit too high", and no amount of moving the constant fixes both,
 * because the constant is right for one receiver and wrong for the other.
 *
 * So bound it in the receiver's own dimension (§V.66): scale the above-water
 * half-width by the horizontal component of the normal, which IS the slope.
 * A vertical side (nY = 0) keeps the full 0.8 m and the signed-off hull
 * crossfade is preserved BIT FOR BIT; a flat beach (nY = 1) takes it to zero
 * and the caustic stops at the water's edge where it belongs.
 *
 * Only the ABOVE side moves. Below the waterline the receiver is genuinely lit
 * through water at any slope, so that half keeps `waterlineBlend` untouched.
 *
 * Mirrored by `aboveBand` in causticsNode.ts.
 */
export function waterlineAboveBand(blend: number, nY: number, amount: number): number {
  const slope = Math.sqrt(Math.max(1 - nY * nY, 0));
  return Math.max(blend, 0) * (1 + (slope - 1) * clamp01(amount));
}
