/**
 * §V12 CPU reference of the rope catenary solver. The TSL compute kernel in
 * ropeCompute.ts mirrors THIS math term-for-term; the GPU side cannot be
 * unit-tested, so this file is the tested ground truth — if it is wrong, the
 * GPU is wrong (tests/ropes.test.ts). Pure math: no three.js, no per-frame
 * CPU use (§V12: CPU only edits endpoint data, the compute pass solves).
 *
 * Model (docs/ropes-math.png): a rope of arc length L from A to B hangs as a
 * catenary y = a·cosh(x/a). In the vertical plane through A,B with horizontal
 * span h and vertical delta v, the sag parameter a satisfies the
 * transcendental
 *
 *   sqrt(L² − v²) = 2a·sinh(h / (2a))
 *
 * With z = h/(2a) and r = sqrt(L² − v²)/h this becomes sinh(z)/z = r, solved
 * by bounded Newton iteration on f(z) = sinh(z) − r·z. Convergence is
 * guaranteed: sinh(z)/z ≥ 1 + z²/6 means the start z₀ = sqrt(6(r−1)) sits at
 * or above the positive root, where f is convex and increasing, so Newton
 * descends monotonically onto it — a fixed iteration count needs no
 * early-exit branch, which is exactly what the GPU loop wants.
 */

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Newton steps — fixed bound so the mirrored GPU loop is fixed-size */
export const CATENARY_ITERATIONS = 20;
/** L ≤ chord·(1+TAUT_EPS) → rope treated as taut: straight line, no solve */
export const TAUT_EPS = 1e-4;
/** horizontal span < H_EPS → vertical rope: sag plane undefined → straight */
export const H_EPS = 1e-5;
/** r is clamped ≥ 1+R_EPS so z₀ = sqrt(6(r−1)) stays real */
export const R_EPS = 1e-7;
/** z start cap — keeps sinh/cosh finite in f32 on the GPU (sinh 30 ≈ 5e12) */
export const Z_MAX = 30;
/** lower clamps guarding division; mirrored verbatim in the shader */
export const Z_MIN = 1e-9;
export const FPRIME_MIN = 1e-9;

/**
 * Solve sinh(z)/z = r for z > 0 (r > 1). Returns z = h/(2a); the caller
 * recovers the catenary parameter as a = h/(2z).
 */
export function solveSagParameter(r: number): number {
  const rc = Math.max(r, 1 + R_EPS);
  let z = Math.min(Math.sqrt(6 * (rc - 1)), Z_MAX);
  for (let i = 0; i < CATENARY_ITERATIONS; i++) {
    const f = Math.sinh(z) - rc * z;
    const fp = Math.max(Math.cosh(z) - rc, FPRIME_MIN);
    z = Math.max(z - f / fp, Z_MIN);
  }
  return z;
}

/**
 * Sample the catenary from A to B with rope length L at `segments+1` points
 * (uniform in horizontal x; index 0 = A, index `segments` = B, snapped
 * exactly). Degenerate inputs never produce NaN:
 *  - L ≤ chord (taut/short rope)  → straight line A→B
 *  - vertical rope (span h ≈ 0)   → straight line A→B (sag plane undefined)
 */
export function solveCatenary(
  A: Vec3Like,
  B: Vec3Like,
  L: number,
  segments: number,
): Vec3Like[] {
  const dx = B.x - A.x;
  const v = B.y - A.y;
  const dz = B.z - A.z;
  const h = Math.hypot(dx, dz);
  const dist = Math.hypot(h, v);
  const pts: Vec3Like[] = new Array<Vec3Like>(segments + 1);

  if (h < H_EPS || L <= dist * (1 + TAUT_EPS)) {
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      pts[i] = { x: A.x + dx * t, y: A.y + v * t, z: A.z + dz * t };
    }
    return pts;
  }

  const r = Math.sqrt(Math.max(L * L - v * v, 0)) / h;
  const z = solveSagParameter(r);
  const a = h / (2 * z);
  // 2a·sinh(z) = h·sinh(z)/z ≈ sqrt(L² − v²): the solved span constant
  const span = 2 * a * Math.sinh(z);
  // x of the lowest point; asinh shifts the curve to honour the v offset
  const xm = h / 2 - a * Math.asinh(v / span);
  // vertical shift so y(0) = 0 exactly (cosh is even → bit-exact at x=0)
  const y0 = -a * Math.cosh(xm / a);
  const ux = dx / h;
  const uz = dz / h;

  for (let i = 0; i <= segments; i++) {
    const x = (i / segments) * h;
    const y = a * Math.cosh((x - xm) / a) + y0;
    pts[i] = { x: A.x + ux * x, y: A.y + y, z: A.z + uz * x };
  }
  // snap endpoints: kills the residual Newton error at x = h
  pts[0] = { x: A.x, y: A.y, z: A.z };
  pts[segments] = { x: B.x, y: B.y, z: B.z };
  return pts;
}
