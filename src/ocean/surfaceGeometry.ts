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
import {
  abs,
  attribute,
  exp,
  float,
  length,
  max,
  mix,
  positionLocal,
  select,
  smoothstep,
} from 'three/tsl';

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
 *
 * `ringOverride` is the §V.30b radial LOD (see `snapRingIndex`): the vertex
 * keeps its own DIRECTION but is placed on the world ring of another, smaller
 * index. Omitted ⟹ the vertex sits on its own ring, which is the baked mesh
 * and the pre-LOD behaviour exactly.
 *
 * TWO THINGS ARE DELIBERATELY ASYMMETRIC HERE and both are load-bearing:
 *  - the square projection divides by the vertex's OWN `q`, so (u,v)/q is the
 *    point of the unit square this vertex faces. Dividing by the overridden
 *    ring instead would push outer rings of a collapsed group further out and
 *    the group would not collapse at all.
 *  - the square→circle blend reads the OVERRIDDEN ring. Every vertex of a
 *    collapsed group therefore lands on the SAME squircle, which is what makes
 *    the group's quads exactly zero-area (they are chords of one convex curve,
 *    collinear on the square part and 1e-5 px² on the rounded part, i.e. below
 *    the rasteriser's sub-pixel grid). Reading its own `q` instead would morph
 *    square→circle ACROSS the group and open a √2 fold at the diagonals.
 */
export function warpVertex(
  u: number,
  v: number,
  o: SurfaceGridOptions,
  k: number,
  ringOverride?: number,
): [number, number] {
  const q = Math.max(Math.abs(u), Math.abs(v)); // Chebyshev ring index
  if (q < 1e-9) return [0, 0];
  const half = Math.max(1, Math.floor(o.segments / 2));
  const nq = ringOverride ?? q * half;
  const w = ringRadius(nq, Math.max(1e-3, o.coreSpacing), k);
  const e = Math.max(1e-9, Math.hypot(u, v));
  // square ring → (u,v)·w/q ; circular ring → (u,v)·w/e ; blend over the rim
  const round = smoothstep01(
    1 - Math.min(1, Math.max(1e-3, o.rimRound)),
    1,
    nq / half,
  );
  const scale = w * ((1 - round) / q + round / e);
  return [u * scale, v * scale];
}

/**
 * §V.30b RADIAL LOD — how many rings collapse onto one, and why the law is a
 * quadratic in r.
 *
 * The clipmap above equalises WORLD angular size (spacing/r = const, §V.30).
 * The SCREEN does not see world angle: a plane seen from an eye h above it
 * projects a radial step Δr at ground distance r to
 *
 *     screen extent = f · h · Δr / r²      (r ≫ h, f = focal length in px)
 *
 * — the 1/r² is the grazing compression, and it is why the far rings are free
 * to delete while the ANGULAR density (which projects as f·Δt/r, one power of
 * r) must not be touched. Measured on the shipped grid (512 segments, 0.5 m
 * core, 4600 m rim ⟹ k = 0.0205, so Δr = 0.5 + 0.0205·r) at a 12 m deck eye,
 * 55° fov, 1440p (f = 1383 px):
 *
 *     r        Δr      radial px   tangential px
 *     500 m    10.7    0.59        6.9
 *     1 km     21.0    0.29        6.6
 *     2 km     41.4    0.17        6.4
 *     4.6 km   94.8    0.12        5.4
 *
 * Eight to ten rings per pixel of screen height, against 6 px of lateral
 * detail on the same triangle. Holding the radial step at `pixels` px instead
 * gives the law this function implements:
 *
 *     Δr ≥ kRadial · r² ,   kRadial = pixels / (f · h)
 *
 * so a ring may collapse into its neighbour while `stride · (s0 + k·r)` is
 * still under that bound. `kRadial = 0` disables the whole thing and every
 * vertex stays on its own ring, bit-identically.
 *
 * WHY POWER-OF-TWO STRIDES EVALUATED AT BLOCK-ALIGNED INDICES. The obvious
 * form — compute the stride from this vertex's own radius, then floor the
 * index to a multiple of it — is NOT MONOTONE: with a stride boundary at
 * n = 163, ring 162 (stride 2) lands on 162 and ring 163 (stride 4) lands on
 * 160, i.e. an outer ring folds INSIDE an inner one and the band between them
 * renders back-to-front. Testing level L at the START of L's own aligned block
 * makes the acceptance test constant across each block; blocks nest, so the
 * map is constant on blocks and each block maps to its own start, which is
 * monotone by construction. `half` is a multiple of 2^maxLevel for every legal
 * `gridSegments` (the slider steps in 64s), so the rim ring is always its own
 * block start and the sea disc still ends exactly at `horizonRadius` with its
 * full 8·half angular samples — the horizon silhouette is untouched.
 */
export function lodRingIndex(
  n: number,
  coreSpacing: number,
  k: number,
  kRadial: number,
  maxLevel: number,
  /** octaves of `fit` over which a ring morphs onto its parent (0 = step) */
  morphOctaves: number,
): number {
  if (!(kRadial > 0)) return n;
  const s0 = Math.max(1e-3, coreSpacing);
  let eff = n;
  for (let level = 1; level <= maxLevel; level++) {
    const stride = 1 << level;
    // §V.30b MORPH WIDTH SCALES WITH THE LEVEL, and it has to. `fit` grows
    // exponentially in the ring index (r does), so one octave of fit is a fixed
    // ~34 rings whatever the level — but level L's blocks are 2^L rings wide
    // and the blend is block-constant (that is what keeps the map monotone), so
    // a fixed-width band contains 17 blocks at level 1 and barely 2 at level 4.
    // Measured envelope jump at the deck with a fixed width: 1.49x at 2 km,
    // i.e. the wall was gone at the first boundary and back at the fourth.
    // L octaves keeps the number of blocks in the band roughly constant.
    const fitLo = Math.pow(2, -Math.max(0, morphOctaves));
    const m = Math.floor(n / stride) * stride;
    const r = ringRadius(m, s0, k);
    // how much bigger the screen-derived target step is than this stride's
    // step — 1 is "exactly licensed". Block-constant, which is what keeps the
    // map monotone (see the header above).
    const fit = (kRadial * r * r) / (stride * (s0 + k * r));
    eff += (m - eff) * smoothstep01(fitLo, 1, fit);
  }
  return eff;
}

/**
 * The GPU half of the law above — the SAME arithmetic, in TSL, so the two
 * cannot drift (§V.8's structural-lockstep rule applied to the one law that
 * now lives in both stages). Returns the vertex's mesh-local XZ.
 *
 * IT IS THE VERTEX SHADER AND NOT A REBUILD because `kRadial` depends on the
 * CAMERA HEIGHT: a 2 km ring is 0.12 px from a 12 m deck eye and ~3 px from
 * the free camera at 300 m, so one baked grid cannot serve both and a
 * height-banded rebuild is a 3 MB re-upload and a hitch (3ad1212, d270926 spent
 * a day removing exactly that class of hitch). The vertex stage is measured at
 * 0.48 ms / 4.7% of this mesh's cost, so the arithmetic is nearly free there.
 *
 * `select(snapped == n, positionLocal.xz, …)` is not an optimisation: it makes
 * the near field BIT-IDENTICAL rather than merely equal. §V.8 — `cpuOcean` is
 * what the hull floats on and it does not model the grid at all; it agrees with
 * the drawn sea only where the mesh resolves it, i.e. in the core. Guaranteeing
 * `stride == 1` inside the core (see `radialLodMinEye`) keeps the mirror's
 * entire domain of validity on vertices this function provably does not move.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node union
type TslNode = any;

export function radialLodXZNode(
  o: SurfaceGridOptions,
  k: number,
  /** kRadial = pixels/(f·h), as a TSL float; 0 ⟹ the whole term is inert */
  kRadial: TslNode,
  maxLevel: number,
  morphOctaves: number,
): TslNode {
  const half = Math.max(1, Math.floor(o.segments / 2));
  const s0 = Math.max(1e-3, o.coreSpacing);
  const kk = Math.max(1e-8, k);
  const uv = attribute('gridUv', 'vec2');
  const q = max(abs(uv.x), abs(uv.y));
  const n = q.mul(half);
  // ringRadius(), in TSL — (s0/k)·(e^{k·n} − 1)
  const ringR = (nn: TslNode) => float(s0 / kk).mul(exp(nn.mul(kk)).sub(1));
  let eff: TslNode = n;
  for (let level = 1; level <= maxLevel; level++) {
    const stride = 1 << level;
    const fitLo = Math.pow(2, -Math.max(0, morphOctaves));
    const m = n.div(stride).floor().mul(stride);
    const r = ringR(m);
    const fit = kRadial
      .mul(r)
      .mul(r)
      .div(float(stride).mul(r.mul(kk).add(s0)).max(1e-9));
    // @band-limited-elsewhere — `fit` IS the footprint measure. It is
    // kRadial·r²/(stride·Δr), and kRadial = pixels/(f·h), so `fit ≥ 1` reads
    // literally as "this collapse is at least `pixels` px of screen height".
    // There is no coordinate here to alias: this is a VERTEX-stage blend of a
    // ring index against a screen-space size, i.e. the band limit itself rather
    // than an edge that needs one. Stepping it instead of smoothstepping it is
    // exactly the wall the user reported, so the filtered form is load-bearing.
    // @band-limited-elsewhere: `fit` is a screen-pixel measure, see above
    eff = mix(eff, m, smoothstep(fitLo, 1, fit));
  }
  const e = max(length(uv), 1e-9);
  // the square→circle blend reads the EFFECTIVE ring, so a fully collapsed
  // group lands on one squircle (see `warpVertex`) — and reads it continuously,
  // so a morphing group deforms instead of stepping.
  // @band-limited-elsewhere — a VERTEX-stage shape blend over the ring index,
  // band-limited by the mesh by construction: `rimRound` spreads it over 30% of
  // the rings (77 of them here), so its narrowest transition is 77 vertices
  // wide and it has no sub-pixel regime to alias in. Pre-existing geometry from
  // `warpVertex`, unchanged except for reading `eff` instead of `q`.
  // @band-limited-elsewhere: spread over 30% of the rings, no sub-pixel regime
  const round = smoothstep(
    1 - Math.min(1, Math.max(1e-3, o.rimRound)),
    1,
    eff.div(half),
  );
  const scale = ringR(eff).mul(
    float(1).sub(round).div(q.max(1e-9)).add(round.div(e)),
  );
  return select(eff.equal(n), positionLocal.xz, uv.mul(scale));
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
  /**
   * PARAMETER-SPACE (u,v) per vertex — the §V.30b radial LOD's only input.
   * The warp is re-derivable from it in the vertex stage (ring index is
   * max(|u|,|v|)·half, direction is (u,v) itself), so this one vec2 replaces
   * both a ring-index attribute and a direction attribute. 2.1 MB at 512².
   */
  const gridUv = new Float32Array(cols * cols * 2);
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
      gridUv[(j * cols + i) * 2] = u;
      gridUv[(j * cols + i) * 2 + 1] = v;
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
  g.setAttribute('gridUv', new THREE.BufferAttribute(gridUv, 2));
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
