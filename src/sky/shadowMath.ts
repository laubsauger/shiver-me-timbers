/**
 * Sun-shadow framing math (pure, THREE-free so node tests can prove it).
 *
 * WHY THIS EXISTS: the sun's ortho shadow frustum re-centres on the ship
 * every frame at continuous world coordinates. That slides the shadow map's
 * texel grid smoothly underneath static geometry, so every shadow edge
 * re-samples against a slightly different grid each frame and the edges
 * crawl — the "very noisy and flickery, like aliasing" report. The fix is to
 * quantise the frustum centre to whole shadow-map texels, so the map moves
 * in discrete texel steps and a stationary edge lands on the same texels
 * frame after frame.
 *
 * The quantisation MUST happen in the shadow camera's own basis, and that
 * basis must be the one three actually builds, or we snap to a grid the
 * renderer isn't using and the crawl survives. `shadowBasis` therefore
 * mirrors Matrix4.lookAt(eye, target, up=(0,1,0)) exactly, degenerate
 * nudge included.
 */

export type Vec3 = [number, number, number];

export interface ShadowBasis {
  /** shadow-map horizontal axis (world space) */
  x: Vec3;
  /** shadow-map vertical axis (world space) */
  y: Vec3;
  /** toward the light — the depth axis, never snapped */
  z: Vec3;
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  // §V28: floored divisor — a zero/NaN sun direction must not spray NaN
  // through the light rig and blank every shadow in the scene
  if (!Number.isFinite(len) || len < 1e-9) return [0, 1, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
}

/**
 * Orthonormal basis of the sun's shadow camera. Mirrors three's
 * Matrix4.lookAt with the camera's default up of (0,1,0): z points from the
 * target toward the eye (i.e. toward the sun), x = up × z, y = z × x. When
 * the sun is straight overhead, up × z collapses and three nudges z.z by
 * 1e-4 before retrying — replicated here so the two bases never disagree.
 */
export function shadowBasis(sunDir: Vec3): ShadowBasis {
  let z = normalize(sunDir);
  const up: Vec3 = [0, 1, 0];
  let x = cross(up, z);
  if (dot(x, x) < 1e-12) {
    // up ∥ z: three shifts z.z (|up.z| !== 1 branch) and rebuilds
    z = normalize([z[0], z[1], z[2] + 0.0001]);
    x = cross(up, z);
  }
  x = normalize(x);
  const y = cross(z, x);
  return { x, y, z };
}

/**
 * World size of one shadow-map texel: the ortho frustum spans 2*extent and
 * is sampled by mapSize texels. Returns 0 for nonsense inputs so callers
 * treat snapping as disabled rather than dividing by zero (§V28).
 */
export function shadowTexelSize(extent: number, mapSize: number): number {
  if (!Number.isFinite(extent) || !Number.isFinite(mapSize)) return 0;
  if (extent <= 0 || mapSize <= 0) return 0;
  return (2 * extent) / mapSize;
}

/**
 * Quantise a shadow-frustum centre to the texel grid. Only the two axes
 * that span the shadow map are snapped; the component along the light's
 * depth axis is preserved exactly, so the near/far range the caller chose
 * is not disturbed. A texel size of 0 (or garbage) returns the centre
 * unchanged — snapping off, never NaN.
 */
export function snapShadowCenter(center: Vec3, sunDir: Vec3, texel: number): Vec3 {
  if (!Number.isFinite(texel) || texel <= 0) return [...center];
  if (!center.every(Number.isFinite)) return [...center];
  const { x, y } = shadowBasis(sunDir);
  const u = dot(center, x);
  const v = dot(center, y);
  const du = Math.round(u / texel) * texel - u;
  const dv = Math.round(v / texel) * texel - v;
  return [
    center[0] + x[0] * du + y[0] * dv,
    center[1] + x[1] * du + y[1] * dv,
    center[2] + x[2] * du + y[2] * dv,
  ];
}
