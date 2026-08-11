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
export function refractedDrift(sun: Vec3, gx: number, gz: number, eta: number): Drift {
  const N = normalFromSlope(gx, gz);
  const cosI = N[0] * sun[0] + N[1] * sun[1] + N[2] * sun[2];
  if (cosI <= 0) return { drift: [0, 0], vertical: MIN_VERTICAL, valid: 0 };
  const T = refract([-sun[0], -sun[1], -sun[2]], N, eta);
  const down = Math.max(-T[1], MIN_VERTICAL);
  return { drift: [T[0] / down, T[2] / down], vertical: down, valid: 1 };
}

/** Sun ray specularly reflected UP off the surface — above-water caustics. */
export function reflectedDrift(sun: Vec3, gx: number, gz: number): Drift {
  const N = normalFromSlope(gx, gz);
  const cosI = N[0] * sun[0] + N[1] * sun[1] + N[2] * sun[2];
  if (cosI <= 0) return { drift: [0, 0], vertical: MIN_VERTICAL, valid: 0 };
  const R = reflect([-sun[0], -sun[1], -sun[2]], N);
  const up = Math.max(R[1], MIN_VERTICAL);
  return { drift: [R[0] / up, R[2] / up], vertical: up, valid: 1 };
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

/**
 * Split the gain into a Reinhard-capped bright lobe (ray convergence) and a
 * scaled dark lobe (divergence). Flat water → 0, so this ADDS nothing where
 * the sea is glass instead of uniformly washing the receiver.
 */
export function causticResponse(
  gain: number,
  maxGain: number,
  darkStrength: number,
): number {
  const raw = gain - 1;
  if (raw <= 0) return raw * clamp01(darkStrength);
  const cap = Math.max(maxGain, 1e-3);
  return raw / (1 + raw / cap);
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
