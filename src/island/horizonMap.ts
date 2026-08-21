/**
 * Horizon map (§T.112a, §V94): per-cell, per-azimuth elevation angle to the
 * terrain, baked on the CPU heightmap grid and uploaded as two RGBA8
 * textures the way `seabed.ts` uploads the depth field.
 *
 * WHY. The sun shadow map is one 80 m ortho centred on the ship, so a 250 m
 * island has no self-shadow beyond the raft's neighbourhood (research §1.4,
 * D5), and there is no terrain AO at all. Both are functions of the same
 * number: how high the terrain rises above a point, in a given direction.
 *   - SUN SELF-SHADOW = the sun's elevation against the horizon angle in the
 *     sun's azimuth (interpolated between the two nearest of the 8 rays)
 *   - SKY AO        = 1 − mean(sin horizon) over the 8 rays — an open plain
 *     sees the whole sky (AO 1), a gully floor with 45° walls sees ~30% less
 *
 * PURE over (data, size, radius): no three types in the bake, so tests bind
 * the properties (0 on a flat field, monotone toward a ridge, ≤ 50 ms for
 * 256²) without a renderer. `horizonMapFor(hm)` memoises one bake per
 * heightmap so the terrain and the rocks share it.
 *
 * Encoding: byte = angle / (π/2) · 255, azimuth k = k·45° counter-clockwise
 * from +x toward +z (the same convention as `atan(z, x)` in the shader).
 * Plane 0 holds azimuths 0..3, plane 1 holds 4..7 (RGBA each).
 */
import * as THREE from 'three/webgpu';
import { atan, asin, float, positionLocal, smoothstep, texture } from 'three/tsl';
import type { IslandHeightmap } from './heightmap';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyNode = any;

export const HORIZON_AZIMUTHS = 8;
/** the 8 ray directions in CELL steps — (dx, dz) for azimuth k·45° */
const RAY_DX = [1, 1, 0, -1, -1, -1, 0, 1];
const RAY_DZ = [0, 1, 1, 1, 0, -1, -1, -1];

export interface HorizonMapOptions {
  /** march step along the ray in cells (≤ 2: the brief's bound) */
  stride?: number;
  /** ray reach in cells; default = half the grid (the island radius) */
  reachCells?: number;
  /**
   * cells at or below this height (m) get horizon 0 without a march — the
   * seabed is under water and nobody reads AO through it; it halves the bake
   */
  skipBelow?: number;
}

export interface HorizonMap {
  size: number;
  radius: number;
  /** size² × 8 bytes: plane 0 (azimuths 0..3) then plane 1 (4..7), RGBA each */
  angles: Uint8Array;
  /** horizon angle (rad) at a cell for azimuth k */
  angleAt(ix: number, iz: number, k: number): number;
  /** 1 − mean(sin horizon) at a cell */
  skyAoAt(ix: number, iz: number): number;
}

/** byte ↔ angle: the whole quadrant 0..π/2 over 0..255 */
export const ANGLE_PER_BYTE = Math.PI / 2 / 255;

export function bakeHorizonMap(
  data: Float32Array,
  size: number,
  radius: number,
  opts: HorizonMapOptions = {},
): HorizonMap {
  if (data.length !== size * size) {
    throw new Error(`bakeHorizonMap: data length ${data.length} ≠ size² ${size * size}`); // §Rule 8
  }
  const stride = Math.max(1, Math.min(2, Math.floor(opts.stride ?? 2)));
  const reach = Math.max(1, Math.floor(opts.reachCells ?? (size - 1) / 2));
  const skipBelow = opts.skipBelow ?? -2;
  const cell = (2 * radius) / Math.max(size - 1, 1); // metres per cell
  const plane = size * size * 4;
  const angles = new Uint8Array(plane * 2);

  for (let iz = 0; iz < size; iz++) {
    for (let ix = 0; ix < size; ix++) {
      const i = iz * size + ix;
      const h0 = data[i];
      if (h0 <= skipBelow) continue; // bytes stay 0 = open horizon
      for (let k = 0; k < HORIZON_AZIMUTHS; k++) {
        const dx = RAY_DX[k] * stride;
        const dz = RAY_DZ[k] * stride;
        // metres per step: axis rays step `stride` cells, diagonals stride·√2
        const stepLen = cell * stride * (dx !== 0 && dz !== 0 ? Math.SQRT2 : 1);
        let maxTan = 0;
        let x = ix + dx;
        let z = iz + dz;
        let dist = stepLen;
        for (let s = stride; s <= reach; s += stride) {
          if (x < 0 || z < 0 || x >= size || z >= size) break;
          const t = (data[z * size + x] - h0) / dist;
          if (t > maxTan) maxTan = t;
          x += dx;
          z += dz;
          dist += stepLen;
        }
        const angle = Math.atan(maxTan);
        const byte = Math.min(255, Math.round(angle / ANGLE_PER_BYTE));
        angles[(k < 4 ? 0 : plane) + i * 4 + (k & 3)] = byte;
      }
    }
  }

  const angleAt = (ix: number, iz: number, k: number): number => {
    const i = iz * size + ix;
    return angles[(k < 4 ? 0 : plane) + i * 4 + (k & 3)] * ANGLE_PER_BYTE;
  };
  return {
    size,
    radius,
    angles,
    angleAt,
    skyAoAt(ix, iz): number {
      let s = 0;
      for (let k = 0; k < HORIZON_AZIMUTHS; k++) s += Math.sin(angleAt(ix, iz, k));
      return 1 - s / HORIZON_AZIMUTHS;
    },
  };
}

const cache = new WeakMap<IslandHeightmap, HorizonMap>();

/** one bake per heightmap, shared by every consumer (terrain, rocks, tests) */
export function horizonMapFor(hm: IslandHeightmap): HorizonMap {
  let m = cache.get(hm);
  if (!m) {
    m = bakeHorizonMap(hm.data, hm.size, hm.worldRadius);
    cache.set(hm, m);
  }
  return m;
}

// ── GPU side ──────────────────────────────────────────────────────────────

export interface HorizonTextures {
  planes: [THREE.DataTexture, THREE.DataTexture];
  radius: number;
  dispose(): void;
}

/**
 * Two RGBA8 textures over the island's [-R, R]² grid. Linear filtered and
 * mipped (§V48: read under minification from the far island), clamp to edge
 * (the grid border is under water, so its horizon is already 0).
 */
export function createHorizonTextures(map: HorizonMap): HorizonTextures {
  const plane = map.size * map.size * 4;
  const make = (offset: number, name: string): THREE.DataTexture => {
    const tex = new THREE.DataTexture(
      map.angles.subarray(offset, offset + plane),
      map.size,
      map.size,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    );
    tex.name = name;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
  };
  const planes: [THREE.DataTexture, THREE.DataTexture] = [
    make(0, 'island/horizon0'),
    make(plane, 'island/horizon1'),
  ];
  return {
    planes,
    radius: map.radius,
    dispose(): void {
      for (const t of planes) t.dispose();
    },
  };
}

export interface HorizonNodes {
  /** 1 − mean(sin horizon), 0..1 — feed `material.aoNode` */
  skyAO: AnyNode;
  /** 1 when the sun clears the horizon in its azimuth, 0 when it is behind it */
  sunVisibility: AnyNode;
}

/**
 * TSL consumers. `localXZ` is the ISLAND-LOCAL position (the island group
 * carries the world offset, so `positionLocal.xz` is right for the terrain
 * mesh and — after the instance matrix — for the rock instances). `sunDir`
 * is the world unit vector pointing at the sun; `softness` the half-width
 * (rad) of the shadow terminator.
 */
export function horizonNodes(
  tex: HorizonTextures,
  sunDir: AnyNode,
  softness: AnyNode,
  localXZ: AnyNode = positionLocal.xz,
): HorizonNodes {
  const uv = localXZ.div(2 * tex.radius).add(0.5);
  const a = texture(tex.planes[0], uv);
  const b = texture(tex.planes[1], uv);
  const quadrant = Math.PI / 2;
  const rays = [a.r, a.g, a.b, a.a, b.r, b.g, b.b, b.a].map((n) => n.mul(quadrant));

  let sinSum: AnyNode = float(0);
  for (const r of rays) sinSum = sinSum.add(r.sin());
  const skyAO = float(1).sub(sinSum.div(HORIZON_AZIMUTHS));

  // sun azimuth in ray units (0..8), then a triangular hat over the two
  // nearest rays — an unrolled select, no dynamic indexing
  const azimuth = atan(sunDir.z, sunDir.x).div(Math.PI / 4).add(HORIZON_AZIMUTHS).mod(HORIZON_AZIMUTHS);
  let horizon: AnyNode = float(0);
  for (let k = 0; k < HORIZON_AZIMUTHS; k++) {
    // wrapped distance to ray k in [0, 4]
    const d = azimuth.sub(k).add(HORIZON_AZIMUTHS).mod(HORIZON_AZIMUTHS);
    const w = float(1).sub(d.min(float(HORIZON_AZIMUTHS).sub(d))).max(0);
    horizon = horizon.add(rays[k].mul(w));
  }
  const elevation = asin(sunDir.y.clamp(-1, 1));
  // @band-limited-elsewhere: a compare of two ANGLES (sun vs horizon), no spatial period; width = softness param
  const sunVisibility = smoothstep(horizon.sub(softness), horizon.add(softness), elevation);
  return { skyAO, sunVisibility };
}

/** CPU twin of the shader's azimuth hat — tests pin the two agree */
export function sunVisibilityCpu(
  map: HorizonMap,
  ix: number,
  iz: number,
  sunDir: [number, number, number],
  softness: number,
): number {
  let az = Math.atan2(sunDir[2], sunDir[0]) / (Math.PI / 4);
  az = ((az % HORIZON_AZIMUTHS) + HORIZON_AZIMUTHS) % HORIZON_AZIMUTHS;
  let horizon = 0;
  for (let k = 0; k < HORIZON_AZIMUTHS; k++) {
    const d = (((az - k) % HORIZON_AZIMUTHS) + HORIZON_AZIMUTHS) % HORIZON_AZIMUTHS;
    const w = Math.max(0, 1 - Math.min(d, HORIZON_AZIMUTHS - d));
    horizon += map.angleAt(ix, iz, k) * w;
  }
  const e = Math.asin(Math.max(-1, Math.min(1, sunDir[1])));
  const t = Math.min(Math.max((e - (horizon - softness)) / Math.max(2 * softness, 1e-6), 0), 1);
  return t * t * (3 - 2 * t);
}
