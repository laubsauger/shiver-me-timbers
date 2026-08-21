/**
 * Terrain-info BAKE (§T.112d) — the CPU side of terrainInfo.ts, split out
 * so the contract file stays readable. See terrainInfo.ts for the channel
 * layout and why only four channels reach the GPU.
 *
 * Stages, all on the heightmap grid:
 *   1. slope / aspect / curvature — central differences at the grid spacing
 *      (the same truth `gradientAt` / `convexityAt` read)
 *   2. skyAO — reused from `horizonMapFor(hm)` (T112a), never rebaked
 *   3. moisture — D8 flow accumulation, highest cell first, then the proxy
 *      flow (log-scaled) + flatness + concavity; sea cells are wet
 *   4. pathDistance from `hm.path` (T112b) IF PRESENT, else +∞ (no wear);
 *      debris from `hm.erosion` (T112c) if present, else 0; joint density
 *      from the same swiss-turbulence the erosion bake uses
 *   5. pack the GPU four to RGBA8
 */
import type { IslandHeightmap } from './heightmap';
import { horizonMapFor, type HorizonMap } from './horizonMap';
import { swissTurbulence2Cpu } from '../terrain/noiseCpu';
import { sierraParams, type SierraParams } from '../params/sierra';
import { TerrainInfoChannels, type TerrainInfo, type TerrainInfoChannel, type TerrainPathLike } from './terrainInfo';

// ── BAKE ──────────────────────────────────────────────────────────────────

const D8_DX = [1, 1, 0, -1, -1, -1, 0, 1];
const D8_DZ = [0, 1, 1, 1, 0, -1, -1, -1];
/** moisture proxy weights: flow accumulation, flatness, concavity */
const MOIST_FLOW = 0.5;
const MOIST_FLAT = 0.25;
const MOIST_CONCAVE = 0.25;

/**
 * The joint-density noise offset. The erosion bake seeds its joint field from
 * the heightmap's private noise offset, which `heightmap.ts` does not publish;
 * until it does, both sides of T112d (this bake and the shader) use THIS
 * offset, derived from the seeded ice azimuth so it is per-island and
 * deterministic. The shading joint field is therefore the same KIND of field
 * as the erosion's, not the same instance — flagged in the T112d report.
 */
export function jointNoiseOffset(hm: Pick<IslandHeightmap, 'sierra' | 'worldRadius'>): [number, number] {
  const az = hm.sierra?.iceAzimuth ?? 0;
  const t = az / (Math.PI * 2);
  const ox = ((t * 7.31 + 0.137) % 1) * 1024;
  const oz = ((t * 3.17 + 0.611 + hm.worldRadius * 1e-3) % 1) * 1024;
  return [ox, oz];
}

export interface TerrainInfoBakeOptions {
  /** baked horizon map for the same grid; default `horizonMapFor(hm)` */
  horizon?: HorizonMap;
  /** override `hm.path` (tests stub both branches) */
  path?: TerrainPathLike | null;
  /** override `hm.erosion.debris` */
  debris?: Float32Array | Float64Array | null;
  p?: SierraParams;
}

export function bakeTerrainInfo(hm: IslandHeightmap, opts: TerrainInfoBakeOptions = {}): TerrainInfo {
  const t0 = performance.now();
  const size = hm.size;
  const n = size * size;
  const R = hm.worldRadius;
  const cell = (2 * R) / Math.max(size - 1, 1);
  const data = hm.data;
  if (data.length !== n) throw new Error(`bakeTerrainInfo: data length ${data.length} ≠ size² ${n}`); // §Rule 8
  const p = opts.p ?? sierraParams;
  const enc = TerrainInfoChannels.encode;

  const horizon = opts.horizon ?? horizonMapFor(hm);
  if (horizon.size !== size) throw new Error(`bakeTerrainInfo: horizon size ${horizon.size} ≠ grid ${size}`); // §Rule 8
  const pathSrc = opts.path === undefined ? ((hm as IslandHeightmap & { path?: TerrainPathLike }).path ?? null) : opts.path;
  if (pathSrc && pathSrc.distance.length !== n) {
    throw new Error(`bakeTerrainInfo: path distance length ${pathSrc.distance.length} ≠ size² ${n}`); // §Rule 8
  }
  const debrisSrc = opts.debris === undefined ? (hm.erosion?.debris ?? null) : opts.debris;
  if (debrisSrc && debrisSrc.length !== n) {
    throw new Error(`bakeTerrainInfo: debris length ${debrisSrc.length} ≠ size² ${n}`); // §Rule 8
  }

  const mk = (): Float32Array => new Float32Array(n);
  const channels: Record<TerrainInfoChannel, Float32Array> = {
    slope: mk(),
    aspect: mk(),
    curvature: mk(),
    skyAO: mk(),
    moisture: mk(),
    pathDistance: mk(),
    debris: mk(),
    joint: mk(),
  };
  const tanSlope = new Float32Array(n);
  const kappa = new Float32Array(n);
  const at = (ix: number, iz: number): number =>
    data[Math.min(Math.max(iz, 0), size - 1) * size + Math.min(Math.max(ix, 0), size - 1)];

  // slope / aspect / curvature — central differences at the grid's own spacing
  for (let iz = 0; iz < size; iz++) {
    for (let ix = 0; ix < size; ix++) {
      const i = iz * size + ix;
      const h0 = data[i];
      const hx1 = at(ix + 1, iz);
      const hx0 = at(ix - 1, iz);
      const hz1 = at(ix, iz + 1);
      const hz0 = at(ix, iz - 1);
      const dx = (hx1 - hx0) / (2 * cell);
      const dz = (hz1 - hz0) / (2 * cell);
      const tan = Math.hypot(dx, dz);
      tanSlope[i] = tan;
      channels.slope[i] = Math.min(tan / enc.slopeTanMax, 1);
      // downhill azimuth; a flat cell has no aspect — 0 by convention
      const az = tan > 1e-6 ? Math.atan2(-dz, -dx) : 0;
      channels.aspect[i] = ((az % enc.aspectTurns) + enc.aspectTurns) % enc.aspectTurns / enc.aspectTurns;
      const hxx = (hx1 - 2 * h0 + hx0) / (cell * cell);
      const hzz = (hz1 - 2 * h0 + hz0) / (cell * cell);
      const k = -(hxx + hzz) / 2;
      kappa[i] = k;
      channels.curvature[i] = 0.5 + 0.5 * Math.min(Math.max(k / enc.curvatureRangePerMetre, -1), 1);
      channels.skyAO[i] = horizon.skyAoAt(ix, iz);
    }
  }

  // moisture: D8 flow accumulation on land cells (highest first), then the
  // proxy = flow (log-scaled) + flatness + concavity. Sea cells are wet.
  const acc = new Float32Array(n).fill(1);
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => data[b] - data[a]);
  let maxAcc = 1;
  for (let o = 0; o < n; o++) {
    const i = order[o];
    const h0 = data[i];
    if (h0 <= 0) continue;
    const ix = i % size;
    const iz = (i - ix) / size;
    let best = -1;
    let bestDrop = 0;
    for (let k = 0; k < 8; k++) {
      const nx = ix + D8_DX[k];
      const nz = iz + D8_DZ[k];
      if (nx < 0 || nz < 0 || nx >= size || nz >= size) continue;
      const j = nz * size + nx;
      const drop = (h0 - data[j]) / (D8_DX[k] !== 0 && D8_DZ[k] !== 0 ? Math.SQRT2 : 1);
      if (drop > bestDrop) {
        bestDrop = drop;
        best = j;
      }
    }
    if (best >= 0) {
      acc[best] += acc[i];
      if (acc[best] > maxAcc) maxAcc = acc[best];
    }
  }
  const logMax = Math.log1p(maxAcc);
  for (let i = 0; i < n; i++) {
    if (data[i] <= 0) {
      channels.moisture[i] = 1;
      continue;
    }
    const flow = logMax > 0 ? Math.log1p(acc[i]) / logMax : 0;
    const flat = 1 - Math.min(tanSlope[i] / enc.slopeTanMax, 1);
    const concave = Math.min(Math.max(-kappa[i] / enc.curvatureRangePerMetre, 0), 1);
    channels.moisture[i] = Math.min(MOIST_FLOW * flow + MOIST_FLAT * flat + MOIST_CONCAVE * concave, 1);
  }

  // path distance (T112b, if published), debris (T112c)
  for (let i = 0; i < n; i++) {
    channels.pathDistance[i] = pathSrc ? Math.min(Math.max(pathSrc.distance[i], 0) / enc.pathDistanceMetres, 1) : 1;
    channels.debris[i] = debrisSrc ? Math.min(Math.max(debrisSrc[i], 0) / enc.debrisMetres, 1) : 0;
  }

  // joint noise. Its finest octave is 4 / jointScale ≈ 12 m against a ~2 m
  // cell, so it is evaluated on a HALF-resolution lattice (a 4 m step, still
  // three samples per finest wavelength) and upsampled bilinearly: the same
  // field to within the lattice's own smoothing, at a quarter of the 26 ms
  // the full grid measured (tests/terrainInfo.test.ts pins ≤ 40 ms in all).
  const [ox, oz] = jointNoiseOffset(hm);
  const cs = (size >> 1) + 1; // coarse side: covers 0..size-1 at step 2
  const coarse = new Float32Array(cs * cs);
  for (let cz = 0; cz < cs; cz++) {
    const z = -R + Math.min(cz * 2, size - 1) * cell;
    for (let cx = 0; cx < cs; cx++) {
      const x = -R + Math.min(cx * 2, size - 1) * cell;
      coarse[cz * cs + cx] = swissTurbulence2Cpu(x * p.jointScale + ox, z * p.jointScale + oz, 3);
    }
  }
  for (let iz = 0; iz < size; iz++) {
    const cz = Math.min(iz >> 1, cs - 2);
    const fz = iz / 2 - cz;
    for (let ix = 0; ix < size; ix++) {
      const cx = Math.min(ix >> 1, cs - 2);
      const fx = ix / 2 - cx;
      const a = coarse[cz * cs + cx];
      const b = coarse[cz * cs + cx + 1];
      const c = coarse[(cz + 1) * cs + cx];
      const d = coarse[(cz + 1) * cs + cx + 1];
      const top = a + (b - a) * fx;
      const bot = c + (d - c) * fx;
      channels.joint[iz * size + ix] = top + (bot - top) * fz;
    }
  }

  // pack the GPU four
  const bytes = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    bytes[i * 4] = Math.round(channels.curvature[i] * 255);
    bytes[i * 4 + 1] = Math.round(channels.moisture[i] * 255);
    bytes[i * 4 + 2] = Math.round(channels.pathDistance[i] * 255);
    bytes[i * 4 + 3] = Math.round(channels.debris[i] * 255);
  }

  return {
    size,
    radius: R,
    cell,
    channels,
    bytes,
    jointNoiseOffset: [ox, oz],
    hasPath: pathSrc !== null,
    bakeMs: performance.now() - t0,
  };
}

const cache = new WeakMap<IslandHeightmap, TerrainInfo>();

/** one bake per heightmap, shared by the terrain, the rocks, placement and tests */
export function terrainInfoFor(hm: IslandHeightmap): TerrainInfo {
  let info = cache.get(hm);
  if (!info) {
    info = bakeTerrainInfo(hm);
    cache.set(hm, info);
  }
  return info;
}
