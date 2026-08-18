/**
 * THE SHELTER FIELD — "how much clear water is upwind of this point", the one
 * spatial query `fetch.ts` needs, shared by the three consumers that must not
 * disagree about it (§V.8): the ocean material, the CPU mirror the ship floats
 * on, and the terrain's reconstruction of the sea.
 *
 * Same shape as `island/seabed.ts` and for the same reason: CPU and GPU read
 * THE SAME ARRAY. `fetchAt()` bilinearly samples the Float32Array; the texture
 * handed to the shaders is that array quantised to half float, on the identical
 * origin/size/uv convention as the seabed texture. There is no second
 * implementation for the two sides to drift apart in.
 *
 * ── WHY A BAKED FIELD AND NOT AN UPWIND MARCH ───────────────────────────────
 *
 * A per-vertex march against the seabed texture would be affordable on the GPU
 * (the frame is CPU-bound: 595 draws, 18 passes, CPU encode 19–24 ms against
 * GPU 6–10 ms) and RUINOUS on the CPU. `CpuOcean.gridCoord` already pays
 * `inverseDisplacementIterations` × the seabed sampler per lookup, and buoyancy
 * calls it once per hull station per tick; hanging a 60-step ray march off that
 * multiplies the mirror's cost by two orders of magnitude for a field that is
 * nearly constant over a ship. So the march is done ONCE, for the whole world,
 * as a sweep — and both sides then pay one bilinear fetch.
 *
 * ── THE SWEEP ───────────────────────────────────────────────────────────────
 *
 * Fetch obeys a one-dimensional recurrence along the wind:
 *
 *      F(p) = 0                              where p is land
 *      F(p) = min(cap, F(p + û·h) + h)       otherwise, û = upwind unit vector
 *
 * so the whole field is ONE ordered pass over the grid, not a march per cell:
 * visit cells in the order that guarantees the upwind neighbours are already
 * solved (which is fixed by the signs of û), and read the upwind point by
 * interpolating between the two neighbours that bracket û — the standard
 * anisotropic sweep. O(N²) with one array read per cell instead of O(N²·steps)
 * with a texture read per step. Measured cost is in the report.
 *
 * The LAND MASK is baked once and never rebuilt: it depends on the islands,
 * which do not move. Only the direction-dependent sweep re-runs, and only when
 * the wind actually turns (`fetchRebuildRadians`) — which in a sailing game is
 * rarely, because `oceanParams.windDirection` is not a key the weather presets
 * patch. Wind SPEED does not touch this field at all; it enters `fetch.ts` as a
 * scalar uniform, so the sea answers a freshening breeze with no rebuild.
 *
 * ── THE THREE THINGS THAT MAKE THE EDGES BEHAVE ─────────────────────────────
 *
 * 1. CAP = FIELD SIZE, and cells entering from the upwind border START at the
 *    cap. So a cell with no land upwind of it reports the cap EXACTLY, and the
 *    cap is above the fully developed fetch at every shipped wind, so its
 *    development ratio clamps to 1 and its gain is exactly 1. Open water inside
 *    the archipelago is therefore untouched, not merely nearly untouched.
 * 2. MARGIN. The grid extends `fetchFieldMargin` past the seabed's own bounds
 *    so that a lee shadow has recovered to the cap BEFORE the border, where
 *    clamp-to-edge takes over. Undersized margin does not corrupt anything — it
 *    truncates the far tail of a shadow — but it would draw a ring, so the
 *    margin is checked against `fullyDevelopedFetch` in the tests.
 * 3. BLUR. A hard land mask gives a hard-edged shadow wedge, which reads as a
 *    painted line on the water and aliases when a distant vertex spans several
 *    texels (§V.48 — and unlike the seabed this field is re-swept, so a mip
 *    chain would have to be regenerated with it). A few texels of separable box
 *    blur is both the band limit and the honest physics: a wind shadow's edge
 *    is a turbulent mixing layer, not a line.
 */
import * as THREE from 'three/webgpu';
import { texture, uniform } from 'three/tsl';
import { oceanParams, type OceanParams } from '../params/ocean';
import type { SeabedField } from '../island/seabed';
import type { FetchSource } from './fetch';

/** any TSL node — structural, not typed (file-local convention) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNode = any;

/** the params this field is shaped by (§V.16) */
export interface FetchFieldParams {
  fetchFieldSize: number;
  fetchFieldMargin: number;
  fetchBlurTexels: number;
  fetchRebuildRadians: number;
}

export interface FetchField extends FetchSource {
  /** baked upwind-distance texture (r16f, metres) for materials */
  texture: THREE.DataTexture;
  /** world XZ of the field's corner; uv = (worldXZ − origin) / size */
  origin: [number, number];
  /** world span (m) on both axes */
  size: number;
  /** world size (m) of one texel */
  texelSize: number;
  /** the value an unsheltered cell reports — "no land upwind" (m) */
  cap: number;
  /** live uniforms backing the TSL helper (origin, 1/size) */
  uniforms: {
    origin: ReturnType<typeof uniform>;
    invSize: ReturnType<typeof uniform>;
  };
  /**
   * Re-sweep for a wind direction if it has turned far enough to matter.
   * Returns true when it actually rebuilt, so callers can count the cost.
   */
  update(windDirection: number): boolean;
  /** how many sweeps have run — perf accounting, and a test hook */
  readonly sweepCount: number;
  dispose(): void;
}

/** shortest signed angle between two bearings, radians */
function angleDelta(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * THE SWEEP, as a free function over plain arrays so it is testable without a
 * GPU, an island or a three import.
 *
 * `land[i]` non-zero marks a cell that blocks. `out` is filled with the clear
 * upwind distance in metres, saturating at `cap`. `windDirection` is the
 * direction the wind BLOWS TOWARD — the same convention as the sea, the sails
 * and `advanceDrift` ((cos θ, sin θ) → (x, z)) — so upwind is its negation.
 */
export function sweepFetch(
  land: Uint8Array,
  res: number,
  cell: number,
  windDirection: number,
  cap: number,
  out: Float32Array,
): void {
  // upwind unit vector: where the energy came FROM
  const ux = -Math.cos(windDirection);
  const uz = -Math.sin(windDirection);
  const ax = Math.abs(ux);
  const az = Math.abs(uz);
  // §V.28: a degenerate direction would divide by zero below. It cannot arise
  // from a unit vector, but windDirection is a live panel value and NaN would
  // fill the whole world with NaN fetch, i.e. a NaN sea.
  if (!(ax + az > 1e-6)) {
    out.fill(cap);
    return;
  }
  const sx = ux > 0 ? 1 : ux < 0 ? -1 : 0;
  const sz = uz > 0 ? 1 : uz < 0 ? -1 : 0;

  // step to the first cell boundary the upwind ray crosses, and how far along
  // the OTHER axis it has drifted by then (`t`, the interpolation weight)
  const xMajor = ax >= az;
  const step = xMajor ? cell / Math.max(ax, 1e-6) : cell / Math.max(az, 1e-6);
  const t = xMajor ? az / Math.max(ax, 1e-6) : ax / Math.max(az, 1e-6);

  // visit order: the upwind neighbours must already be solved, which fixes the
  // direction of each loop from the sign of û
  const iFrom = sx > 0 ? res - 1 : 0;
  const iTo = sx > 0 ? -1 : res;
  const iStep = sx > 0 ? -1 : 1;
  const jFrom = sz > 0 ? res - 1 : 0;
  const jTo = sz > 0 ? -1 : res;
  const jStep = sz > 0 ? -1 : 1;

  /** upwind grid value, cap outside the field — "open sea beyond the border" */
  const at = (i: number, j: number): number =>
    i < 0 || j < 0 || i >= res || j >= res ? cap : out[j * res + i];

  for (let j = jFrom; j !== jTo; j += jStep) {
    for (let i = iFrom; i !== iTo; i += iStep) {
      const k = j * res + i;
      if (land[k]) {
        out[k] = 0;
        continue;
      }
      // the two neighbours bracketing û: cross the major axis first, then
      // interpolate toward the diagonal by how far the minor axis has drifted
      const a = xMajor ? at(i + sx, j) : at(i, j + sz);
      const b = at(i + sx, j + sz);
      const upwind = a + (b - a) * t;
      const v = upwind + step;
      out[k] = v < cap ? v : cap;
    }
  }
}

/**
 * Separable box blur, `radius` texels, in place through a scratch buffer.
 * Clamp-to-edge, which is the same boundary the sampler uses.
 *
 * This is the field's band limit (see the header) AND the soft edge of the
 * wind shadow; do not remove it to "sharpen" the shelter.
 */
export function blurField(
  data: Float32Array,
  res: number,
  radius: number,
  scratch: Float32Array,
): void {
  const r = Math.max(Math.floor(radius), 0);
  if (r === 0) return;
  const width = r * 2 + 1;
  const clamp = (v: number): number => (v < 0 ? 0 : v > res - 1 ? res - 1 : v);
  /**
   * SLIDING WINDOW, not a per-texel tap loop, and the reason is the frame
   * budget rather than tidiness. The naive form is O(N²·r) and MEASURED at
   * 8.75 ms per re-sweep at the shipped 512² and radius 3 — a third of the
   * whole CPU encode budget (19–24 ms against 6–10 ms of GPU), landing as a
   * stutter on a wind-direction drag. Running sums make it O(N²) and
   * INDEPENDENT of the radius, so `fetchBlurTexels` is now free to be a look
   * decision instead of a cost one.
   */
  // horizontal
  for (let j = 0; j < res; j++) {
    const row = j * res;
    let sum = data[row] * (r + 1);
    for (let d = 1; d <= r; d++) sum += data[row + clamp(d)];
    for (let i = 0; i < res; i++) {
      scratch[row + i] = sum / width;
      sum += data[row + clamp(i + r + 1)] - data[row + clamp(i - r)];
    }
  }
  // vertical
  for (let i = 0; i < res; i++) {
    let sum = scratch[i] * (r + 1);
    for (let d = 1; d <= r; d++) sum += scratch[clamp(d) * res + i];
    for (let j = 0; j < res; j++) {
      data[j * res + i] = sum / width;
      sum += scratch[clamp(j + r + 1) * res + i] - scratch[clamp(j - r) * res + i];
    }
  }
}

/**
 * Bilinear sample of a square grid whose texel CENTRES sit at
 * origin + (i + 0.5)·cell — the identical convention `seabedHeightNode` and
 * every `texture(tex, uv)` read use, so the CPU and the shader land on the
 * same interpolant rather than half a texel apart (§B.34's class of defect).
 * Clamp-to-edge outside, matching the texture's wrap mode.
 */
export function sampleGrid(
  data: Float32Array,
  res: number,
  origin: readonly [number, number],
  cell: number,
  x: number,
  z: number,
): number {
  const fx = (x - origin[0]) / cell - 0.5;
  const fz = (z - origin[1]) / cell - 0.5;
  const i0 = Math.floor(fx);
  const j0 = Math.floor(fz);
  const tx = fx - i0;
  const tz = fz - j0;
  const c = (v: number): number => (v < 0 ? 0 : v > res - 1 ? res - 1 : v);
  const i0c = c(i0);
  const i1c = c(i0 + 1);
  const j0c = c(j0) * res;
  const j1c = c(j0 + 1) * res;
  const a = data[j0c + i0c];
  const b = data[j0c + i1c];
  const cc = data[j1c + i0c];
  const d = data[j1c + i1c];
  const top = a + (b - a) * tx;
  const bot = cc + (d - cc) * tx;
  return top + (bot - top) * tz;
}

/**
 * Build the shelter field over an existing seabed.
 *
 * `seabed` supplies both the geometry (`heightAt` ≥ 0 is land — a wave is
 * blocked by whatever breaks the surface) and the extent the land occupies.
 * The field is deliberately BIGGER than the seabed's own bounds; see MARGIN in
 * the header.
 */
export function createFetchField(
  seabed: SeabedField,
  op: OceanParams = oceanParams,
): FetchField {
  const res = Math.max(8, Math.floor(op.fetchFieldSize));
  const margin = Math.max(op.fetchFieldMargin, 0);
  const size = seabed.size + margin * 2;
  const origin: [number, number] = [seabed.origin[0] - margin, seabed.origin[1] - margin];
  const cell = size / res;
  /**
   * "No land upwind" — see THE THREE THINGS in the header. The field's own span
   * is the natural value: it is the longest run a cell can accumulate, so a
   * border cell and an unsheltered interior cell report the SAME number and no
   * seam can exist between them.
   */
  const cap = size;

  // ── the land mask, baked once (the islands do not move) ──────────────────
  const land = new Uint8Array(res * res);
  for (let j = 0; j < res; j++) {
    const wz = origin[1] + (j + 0.5) * cell;
    for (let i = 0; i < res; i++) {
      const wx = origin[0] + (i + 0.5) * cell;
      land[j * res + i] = seabed.heightAt(wx, wz) >= 0 ? 1 : 0;
    }
  }

  const data = new Float32Array(res * res);
  const scratch = new Float32Array(res * res);
  const half = new Uint16Array(res * res);
  const tex = new THREE.DataTexture(half, res, res, THREE.RedFormat, THREE.HalfFloatType);
  tex.name = 'ocean/fetchField';
  /**
   * §V.48: NO MIP CHAIN, and that is a decision rather than an omission. The
   * readers minify this (the ocean's vertex spacing runs to ~90 m at the rim
   * against a ~30 m texel), which is normally the argument FOR mips — but this
   * texture is re-swept when the wind turns, so a chain would have to be
   * regenerated with it, and the blur above already band-limits the field to
   * several texels. The residual is bounded and quoted in the report.
   */
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  // clamp is correct, not a fallback: the border ring already reads `cap`, so
  // sampling far outside the field reports open ocean, which it is
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;

  const uniforms = {
    origin: uniform(new THREE.Vector2(origin[0], origin[1])),
    invSize: uniform(1 / size),
  };

  let sweptDirection = NaN;
  let sweeps = 0;

  const rebuild = (windDirection: number): void => {
    sweepFetch(land, res, cell, windDirection, cap, data);
    blurField(data, res, op.fetchBlurTexels, scratch);
    for (let k = 0; k < data.length; k++) half[k] = THREE.DataUtils.toHalfFloat(data[k]);
    tex.needsUpdate = true;
    sweptDirection = windDirection;
    sweeps++;
  };
  rebuild(op.windDirection);

  return {
    fetchAt: (x, z) => sampleGrid(data, res, origin, cell, x, z),
    texture: tex,
    origin,
    size,
    texelSize: cell,
    cap,
    uniforms,
    update(windDirection: number): boolean {
      if (!Number.isFinite(windDirection)) return false;
      const moved = Math.abs(angleDelta(windDirection, sweptDirection));
      // NaN on the first call (sweptDirection starts NaN) compares false, but
      // the constructor has already swept once, so this is purely the turn test
      if (moved <= Math.max(op.fetchRebuildRadians, 0)) return false;
      rebuild(windDirection);
      return true;
    },
    get sweepCount(): number {
      return sweeps;
    },
    dispose(): void {
      tex.dispose();
    },
  };
}

/**
 * TSL: clear upwind water (m) at a world-XZ node. Same uv convention as
 * `seabedHeightNode`, deliberately — the two fields are read at the same point
 * by the same shaders and a different mapping is how they would drift.
 */
export function fetchFieldNode(field: FetchField, worldXZ: AnyNode): AnyNode {
  const uv = worldXZ.sub(field.uniforms.origin).mul(field.uniforms.invSize);
  return texture(field.texture, uv).r;
}
