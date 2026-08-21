/**
 * Terrain-info texture (§T.112d, §V94, research §2.5): the per-cell facts
 * about the ground that shading (T112d) and placement (T112e/f) both read,
 * baked once on the CPU heightmap grid alongside the horizon map and
 * uploaded the way `seabed.ts` uploads the depth field.
 *
 * THE CHANNEL LAYOUT IS THE SHARED INTERFACE — `TerrainInfoChannels` below is
 * the contract T112e reads, so it is defined first and exported as a typed
 * constant. Eight channels are baked; FOUR go to the GPU.
 *
 * WHY ONE RGBA8 TEXTURE AND NOT TWO (§V40, counted, not assumed). The sierra
 * terrain fragment already binds 6 samplers through the shared blend base
 * (wetline 1, caustics derivatives array 1 + displacement 3, sun shadow
 * depth 1) and 2 more for the horizon planes (T112a) — 8 of the 9 the deck
 * family budgets (tests/shipBindingBudget.test.ts). One sampler is left. So
 * the four channels that CANNOT be derived at the fragment go in the texture
 * (curvature, moisture, path distance, debris), and the four that can are
 * derived there from things already bound:
 *   slope, aspect  ← `normalWorldGeometry` (exact, per fragment)
 *   skyAO          ← the horizon planes (T112a, already sampled for aoNode)
 *   joint          ← `swissTurbulence2` (the TSL twin of the erosion bake's
 *                    joint-density noise, same offset, same octaves)
 * The CPU sampler `sampleTerrainInfo` exposes ALL EIGHT with the same
 * encodings, so placement code never has to know which side a channel lives.
 *
 * PURE over (heightmap, horizon, path, debris): no three types in the bake,
 * so tests bind the properties (AO = 1 flat, curvature + on a crown, moisture
 * higher in a valley, aspect analytic on a plane) without a renderer.
 * `terrainInfoFor(hm)` memoises one bake per heightmap; the horizon map is
 * REUSED through `horizonMapFor`, never rebaked.
 */
import * as THREE from 'three/webgpu';
import { positionLocal, texture, vec2 } from 'three/tsl';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyNode = any;

// ── THE CONTRACT ──────────────────────────────────────────────────────────

/** every channel the bake produces, GPU-resident or derived */
export type TerrainInfoChannel =
  | 'slope'
  | 'aspect'
  | 'curvature'
  | 'skyAO'
  | 'moisture'
  | 'pathDistance'
  | 'debris'
  | 'joint';

/**
 * Channel layout + encodings. Every value is 0..1 in the texture AND in the
 * CPU sampler; the `decode` entries give the physical quantity back.
 */
export const TerrainInfoChannels = {
  /** the one RGBA8 texture: which byte holds which channel */
  texture: {
    curvature: 'r',
    moisture: 'g',
    pathDistance: 'b',
    debris: 'a',
  },
  /** channels the fragment derives from bindings it already has */
  derived: {
    slope: 'normalWorldGeometry (tan of the slope angle / tan 60°)',
    aspect: 'normalWorldGeometry (downhill azimuth / 2π, atan(z, x) convention)',
    skyAO: 'horizon planes (T112a) — 1 − mean(sin horizon) over 8 azimuths',
    joint: 'swissTurbulence2(localXZ · jointScale + jointNoiseOffset, 3 octaves)',
  },
  /** encodings, CPU and GPU alike */
  encode: {
    /** slope byte = min(tan θ / tan 60°, 1) */
    slopeTanMax: Math.tan((60 * Math.PI) / 180),
    /** aspect byte = azimuth / 2π, azimuth = atan2(−∂h/∂z, −∂h/∂x) ∈ [0, 2π) */
    aspectTurns: Math.PI * 2,
    /** curvature byte = 0.5 + 0.5 · clamp(κ / range, −1, 1); κ = −(hxx + hzz)/2, + convex */
    curvatureRangePerMetre: 0.05,
    /** pathDistance byte = min(metres / 32, 1); 1 = no route (hm.path absent) */
    pathDistanceMetres: 32,
    /** debris byte = min(metres / 4, 1); 0 when no erosion bake ran */
    debrisMetres: 4,
  },
} as const;

export const TERRAIN_INFO_CHANNELS: readonly TerrainInfoChannel[] = [
  'slope',
  'aspect',
  'curvature',
  'skyAO',
  'moisture',
  'pathDistance',
  'debris',
  'joint',
];

/** the published path-graph surface this file consumes IF PRESENT (T112b) */
export interface TerrainPathLike {
  /** metres to the route centreline, size² row-major like `hm.data` */
  distance: Float32Array;
}

export interface TerrainInfo {
  size: number;
  radius: number;
  /** metres per cell */
  cell: number;
  /** 0..1 per channel, size² each, row-major like `hm.data` */
  channels: Record<TerrainInfoChannel, Float32Array>;
  /** the four GPU channels packed RGBA8, size² × 4 */
  bytes: Uint8Array;
  /** the joint-noise offset the shader must use to reproduce `channels.joint` */
  jointNoiseOffset: [number, number];
  /** true when `hm.path` was present and `pathDistance` is real */
  hasPath: boolean;
  bakeMs: number;
}

export interface TerrainInfoSample {
  slope: number;
  aspect: number;
  curvature: number;
  skyAO: number;
  moisture: number;
  pathDistance: number;
  debris: number;
  joint: number;
}

// ── CPU SAMPLER (T112e placement, tests) ──────────────────────────────────

/** bilinear 0..1 sample of one channel at island-local (x, z); clamped at the grid edge */
export function sampleTerrainChannel(info: TerrainInfo, channel: TerrainInfoChannel, x: number, z: number): number {
  const arr = info.channels[channel];
  const size = info.size;
  const gx = Math.min(Math.max((x + info.radius) / info.cell, 0), size - 1);
  const gz = Math.min(Math.max((z + info.radius) / info.cell, 0), size - 1);
  const x0 = Math.min(Math.floor(gx), size - 2);
  const z0 = Math.min(Math.floor(gz), size - 2);
  const fx = gx - x0;
  const fz = gz - z0;
  const a = arr[z0 * size + x0];
  const b = arr[z0 * size + x0 + 1];
  const c = arr[(z0 + 1) * size + x0];
  const d = arr[(z0 + 1) * size + x0 + 1];
  const top = a + (b - a) * fx;
  const bot = c + (d - c) * fx;
  return top + (bot - top) * fz;
}

/** all eight channels, 0..1, at island-local (x, z) — the mirror of what the fragment sees */
export function sampleTerrainInfo(info: TerrainInfo, x: number, z: number): TerrainInfoSample {
  return {
    slope: sampleTerrainChannel(info, 'slope', x, z),
    aspect: sampleTerrainChannel(info, 'aspect', x, z),
    curvature: sampleTerrainChannel(info, 'curvature', x, z),
    skyAO: sampleTerrainChannel(info, 'skyAO', x, z),
    moisture: sampleTerrainChannel(info, 'moisture', x, z),
    pathDistance: sampleTerrainChannel(info, 'pathDistance', x, z),
    debris: sampleTerrainChannel(info, 'debris', x, z),
    joint: sampleTerrainChannel(info, 'joint', x, z),
  };
}

/** physical decode helpers for the encoded channels */
export const decodeTerrainInfo = {
  slopeTan: (v: number): number => v * TerrainInfoChannels.encode.slopeTanMax,
  aspectRad: (v: number): number => v * TerrainInfoChannels.encode.aspectTurns,
  curvaturePerMetre: (v: number): number => (v - 0.5) * 2 * TerrainInfoChannels.encode.curvatureRangePerMetre,
  pathDistanceMetres: (v: number): number => v * TerrainInfoChannels.encode.pathDistanceMetres,
  debrisMetres: (v: number): number => v * TerrainInfoChannels.encode.debrisMetres,
};

/**
 * Weight of the ice-axis fallback in the sheeting direction, in ENCODED
 * curvature units per metre. The curvature gradient on a 250 m dome is
 * ~1e-3 encoded/m; the fallback only wins where the field is flat.
 */
export const SHEET_DIR_FALLBACK = 2e-4;

/**
 * SHEETING DIRECTION (research §2.2, Martel 2006): sheets peel off a convex
 * surface and their traces on it run ALONG the contours of the form, so the
 * across-band axis is the direction the curvature changes fastest — ∇κ,
 * which on a dome points at the crown and, on an elliptical dome, leans
 * toward the TIGHTER axis (∇κ ∝ (x/a², z/b²) near the crown). Where ∇κ
 * vanishes (a flat field, a perfect paraboloid) the seeded ice axis stands
 * in so the bands never swirl on a zero vector. CPU twin of the shader's
 * `sheetingDirection`; tests pin the property on a synthetic ellipse.
 */
export function sheetingDirectionCpu(info: TerrainInfo, x: number, z: number, iceAzimuth: number): [number, number] {
  const e = info.cell;
  const gx = (sampleTerrainChannel(info, 'curvature', x + e, z) - sampleTerrainChannel(info, 'curvature', x - e, z)) / (2 * e);
  const gz = (sampleTerrainChannel(info, 'curvature', x, z + e) - sampleTerrainChannel(info, 'curvature', x, z - e)) / (2 * e);
  const dx = gx + Math.cos(iceAzimuth) * SHEET_DIR_FALLBACK;
  const dz = gz + Math.sin(iceAzimuth) * SHEET_DIR_FALLBACK;
  const len = Math.max(Math.hypot(dx, dz), 1e-12);
  return [dx / len, dz / len];
}

// ── GPU SIDE ──────────────────────────────────────────────────────────────

export interface TerrainInfoTexture {
  texture: THREE.DataTexture;
  radius: number;
  size: number;
  cell: number;
  jointNoiseOffset: [number, number];
  dispose(): void;
}

/**
 * One RGBA8 texture over the island's [-R, R]² grid. Linear filtered and
 * mipped (§V48: read under minification from the far island), clamp to edge
 * (the grid border is under water; every mask there is the sea's).
 */
export function createTerrainInfoTexture(info: TerrainInfo): TerrainInfoTexture {
  const tex = new THREE.DataTexture(info.bytes, info.size, info.size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = 'island/terrainInfo';
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return {
    texture: tex,
    radius: info.radius,
    size: info.size,
    cell: info.cell,
    jointNoiseOffset: info.jointNoiseOffset,
    dispose(): void {
      tex.dispose();
    },
  };
}

export interface TerrainInfoNodes {
  /** signed mean curvature, 1/m, + convex */
  curvature: AnyNode;
  /** 0..1 */
  moisture: AnyNode;
  /** metres to the route centreline (32 m = none) */
  pathDistance: AnyNode;
  /** talus thickness, m */
  debris: AnyNode;
  /** ∇ of the ENCODED curvature byte, per metre — the sheeting axis source */
  curvatureGradient: AnyNode;
}

/**
 * TSL reader. `localXZ` is the ISLAND-LOCAL position (`positionLocal.xz`:
 * the island group carries the world offset; for the rock InstancedMesh
 * three's InstanceNode folds the instance matrix into positionLocal, so it
 * is island-local there too). Five taps of ONE texture — centre plus the
 * four neighbours for the curvature gradient — dedupe to one binding and
 * one sampler (§V40: bindings key on texture UUID, not on node).
 */
export function terrainInfoNodes(tex: TerrainInfoTexture, localXZ: AnyNode = positionLocal.xz): TerrainInfoNodes {
  const enc = TerrainInfoChannels.encode;
  const uv = localXZ.div(2 * tex.radius).add(0.5);
  const du = 1 / tex.size;
  const c = texture(tex.texture, uv);
  const xp = texture(tex.texture, uv.add(vec2(du, 0))).r;
  const xm = texture(tex.texture, uv.sub(vec2(du, 0))).r;
  const zp = texture(tex.texture, uv.add(vec2(0, du))).r;
  const zm = texture(tex.texture, uv.sub(vec2(0, du))).r;
  return {
    curvature: c.r.sub(0.5).mul(2 * enc.curvatureRangePerMetre),
    moisture: c.g,
    pathDistance: c.b.mul(enc.pathDistanceMetres),
    debris: c.a.mul(enc.debrisMetres),
    curvatureGradient: vec2(xp.sub(xm), zp.sub(zm)).div(2 * tex.cell),
  };
}
