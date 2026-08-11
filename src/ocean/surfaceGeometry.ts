/**
 * Ocean surface geometry (§V.4, §V.30): ONE camera-centered clipmap grid.
 *
 * Why a warped grid and not "dense square + horizon ring": the old split put
 * every vertex inside 420 m and left a flat skirt out to 4.5 km, so the sea
 * read as a small square of real water inside a dead plane (user: "I
 * immediately see a cutoff around the world"). §V30 wants displacement out to
 * kilometres with no ring where detail stops.
 *
 * Construction: an N×N grid in local [-1,1]² warped radially so that the
 * world-space vertex spacing grows GEOMETRICALLY with distance:
 *
 *     spacing(r) = coreSpacing + k·r          (k = growth per ring)
 *     radius(n)  = (coreSpacing/k)·(e^{k·n} − 1)
 *
 * A constant spacing/radius ratio means every triangle covers the same screen
 * angle — no wasted vertices at 400 m, no starvation at 4 km. k is solved once
 * from (segments, coreSpacing, horizonRadius); the shader reads the same law
 * back (spacing = s0 + k·dist) to fade each FFT cascade out exactly where the
 * local triangle can no longer sample it (Nyquist), so the fades RIDE the LOD
 * instead of ending in a visible ring.
 *
 * Two properties this buys us:
 * - single mesh, single draw, no T-junction cracks and no LOD popping — the
 *   warp is baked once and the mesh only ever TRANSLATES (snapped to whole
 *   core steps), so near-field vertices stay world-locked and never swim.
 * - the outer rings blend from square to circular (rimRound) so the boundary
 *   is a circle at exactly horizonRadius; a square would push its corners
 *   √2× further out and get sliced by the camera far plane — a notched
 *   horizon, i.e. the exact artifact §V30 forbids.
 */
import * as THREE from 'three/webgpu';

export interface SurfaceGridOptions {
  /** cells per side of the parameter grid (even; N² cells, one draw call) */
  segments: number;
  /** world-space vertex spacing at the camera (m) */
  coreSpacing: number;
  /** radius the outermost ring reaches (m) — keep inside the camera far plane */
  horizonRadius: number;
  /** 0..1 fraction of the outer rings blended from square to circular */
  rimRound: number;
}

/** world radius of ring n (n = 0 at the camera, segments/2 at the rim) */
export function ringRadius(n: number, coreSpacing: number, k: number): number {
  if (k < 1e-8) return coreSpacing * n; // degenerate → uniform grid
  return (coreSpacing / k) * (Math.exp(k * n) - 1);
}

/**
 * Vertex spacing at world distance r — the derivative of ringRadius, in
 * closed form. The material samples this to size its Nyquist fades.
 */
export function spacingAtRadius(r: number, coreSpacing: number, k: number): number {
  return coreSpacing + k * Math.max(0, r);
}

/**
 * Solve the per-ring growth k that makes ring segments/2 land on
 * horizonRadius. ringRadius is strictly increasing in k, so bisection is
 * exact enough and cannot diverge (§V28: no unbounded iteration, no NaN).
 */
export function solveGrowthRate(o: SurfaceGridOptions): number {
  const half = Math.max(1, Math.floor(o.segments / 2));
  const s0 = Math.max(1e-3, o.coreSpacing);
  // a uniform grid already reaches s0·half; asking for less means k → 0
  if (!(o.horizonRadius > s0 * half)) return 0;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) * 0.5;
    if (ringRadius(half, s0, mid) < o.horizonRadius) lo = mid;
    else hi = mid;
  }
  return (lo + hi) * 0.5;
}

/** Hermite smoothstep — same curve the shaders use (kept THREE-free). */
function smoothstep01(edge0: number, edge1: number, x: number): number {
  const d = edge1 - edge0;
  if (Math.abs(d) < 1e-12) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / d));
  return t * t * (3 - 2 * t);
}

/**
 * World XZ of one grid vertex, exported for tests (monotone radius, circular
 * rim). u,v ∈ [-1,1] are the parameter-space coordinates.
 */
export function warpVertex(
  u: number,
  v: number,
  o: SurfaceGridOptions,
  k: number,
): [number, number] {
  const q = Math.max(Math.abs(u), Math.abs(v)); // Chebyshev ring index
  if (q < 1e-9) return [0, 0];
  const half = Math.max(1, Math.floor(o.segments / 2));
  const w = ringRadius(q * half, Math.max(1e-3, o.coreSpacing), k);
  const e = Math.max(1e-9, Math.hypot(u, v));
  // square ring → (u,v)·w/q ; circular ring → (u,v)·w/e ; blend over the rim
  const round = smoothstep01(1 - Math.min(1, Math.max(1e-3, o.rimRound)), 1, q);
  const scale = w * ((1 - round) / q + round / e);
  return [u * scale, v * scale];
}

/**
 * The full surface mesh: positions on y=0 (the material displaces them),
 * flat +Y normals (the fragment shader builds real normals from the FFT
 * derivative textures — but three's ShadowNode reads normalWorld for its
 * normal bias, so the attribute has to exist).
 */
export function buildOceanGrid(o: SurfaceGridOptions): THREE.BufferGeometry {
  const n = Math.max(2, Math.floor(o.segments / 2) * 2);
  const k = solveGrowthRate({ ...o, segments: n });
  const cols = n + 1;
  const positions = new Float32Array(cols * cols * 3);
  const normals = new Float32Array(cols * cols * 3);
  for (let j = 0; j <= n; j++) {
    const v = (2 * j) / n - 1;
    for (let i = 0; i <= n; i++) {
      const u = (2 * i) / n - 1;
      const [x, z] = warpVertex(u, v, { ...o, segments: n }, k);
      const idx = (j * cols + i) * 3;
      positions[idx] = x;
      positions[idx + 1] = 0;
      positions[idx + 2] = z;
      normals[idx + 1] = 1;
    }
  }
  // Index order is ROW-MAJOR, and that is load bearing (§V28, §B).
  // A "front-to-back" ring-by-ring order looks like a free early-Z win and is
  // a GPU-process wedge on Apple Silicon: consecutive triangles of a ring land
  // in completely different screen tiles, so a tile-based deferred renderer
  // has to keep every tile's primitive list open at once. Measured: 512² in
  // ring order never finished its first frame (main thread blocked > 45 s, tab
  // killed) at BOTH 4600 m and 600 m rim, while the identical mesh in
  // row-major order boots instantly at 100 fps. Row-major keeps spatially
  // coherent runs. Do not "optimise" this into ring order again.
  const indices = new Uint32Array(n * n * 6);
  let t = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * cols + i;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      // (a,c,b) winds counter-clockwise seen from +Y → front faces point up
      indices[t++] = a;
      indices[t++] = c;
      indices[t++] = b;
      indices[t++] = b;
      indices[t++] = c;
      indices[t++] = d;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  g.setIndex(new THREE.BufferAttribute(indices, 1));
  return g;
}

/**
 * Snap a camera position to whole core steps (returns the mesh origin XZ).
 * The core rings are spaced coreSpacing apart, so snapping by that step keeps
 * near-field vertices on fixed world positions — otherwise crests crawl.
 */
export function snapToGrid(
  x: number,
  z: number,
  o: SurfaceGridOptions,
): [number, number] {
  const step = Math.max(1e-3, o.coreSpacing);
  return [Math.floor(x / step) * step, Math.floor(z / step) * step];
}
