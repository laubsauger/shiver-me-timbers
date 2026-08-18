/**
 * Seabed depth field (T33) — the single source of "how deep is the water at
 * this world XZ", shared by three consumers that must not disagree:
 *
 *  1. ocean surface material  → shallows turquoise tint over sand (§V20)
 *  2. buoyancy (§V8)          → the ship shoals and grounds instead of
 *                               floating over land
 *  3. caustics (§V34, T32)    → seabed/shallows receiver depth attenuation
 *
 * Two faces of the SAME function so those consumers cannot drift:
 *  - CPU: `heightAt(x,z)` / `depthAt(x,z, waterY)` — exact, reads the island
 *    heightmaps directly (bilinear, identical to the rendered terrain at
 *    vertices), for sim code.
 *  - GPU: a single world-space height texture + TSL sampler nodes, for
 *    materials. The texture is BAKED FROM the CPU sampler, so it is the same
 *    field quantized, never a second implementation.
 *
 * Shape away from an island: the heightmap only spans its own footprint and
 * reports `-rimDepth` outside it, which would put a hard depth cliff (and so
 * a hard tint ring) at the footprint edge. `seabedShelfWidth` blends the rim
 * out to `seabedOpenDepth` — that ramp IS the turquoise halo, so it is a look
 * tunable, not an implementation detail.
 *
 * Zero magic constants: everything comes from params/island.ts (§V16).
 */
import * as THREE from 'three/webgpu';
import { float, smoothstep, texture, uniform } from 'three/tsl';
import { islandParams, type IslandParams } from '../params/island';
import type { IslandHeightmap } from './heightmap';

/** one island's contribution: its local heightmap plus its world centre */
export interface SeabedIsland {
  heightmap: IslandHeightmap;
  /** island centre on the world XZ plane (waterline stays world y = 0) */
  center: [number, number];
}

/**
 * smoothstep(0, w, x) — the shelf ramp, and the ONE owner of it.
 *
 * Exported because `islandMesh.buildIslandGeometry` now builds its outer apron
 * from this same curve. The drawn seabed and the sampled depth field have to
 * be the same surface — the whole reason this module exists is that three
 * consumers must not disagree about how deep the water is, and the geometry
 * the player looks at is a fourth. A second copy of the ramp in the mesh
 * builder would be exactly the drift this file's docstring forbids.
 */
export function shelfRamp(x: number, w: number): number {
  const t = Math.min(Math.max(x / Math.max(w, 1e-3), 0), 1);
  return t * t * (3 - 2 * t);
}

/**
 * Seabed height (m, waterline = 0, negative below) at a world XZ. Pure over
 * (islands, params): no GPU, no three types — sim code and tests call this.
 */
export function sampleSeabedHeight(
  islands: readonly SeabedIsland[],
  x: number,
  z: number,
  p: IslandParams = islandParams,
): number {
  const open = -p.seabedOpenDepth;
  let h = open;
  for (const isl of islands) {
    const lx = x - isl.center[0];
    const lz = z - isl.center[1];
    const R = isl.heightmap.worldRadius;
    // CHEBYSHEV, NOT EUCLIDEAN — the ramp has to start on the same curve the
    // heightmap ends on, and the heightmap is a SQUARE grid over [-R, R]².
    // Keyed on `hypot` the ramp began at the inscribed circle, so between
    // d = R and the corner at d = R√2 the grid was still returning interior
    // data while the ramp had already carried the field a third of the way to
    // open depth: measured on the showcase island, -12.0 m at the axes against
    // -24.3 m at the corners, i.e. a 12.3 m disagreement between the drawn
    // terrain rim and the depth the water is shaded against, with 4-fold
    // symmetry. Visible as the turquoise dying at the corners
    // (`shallowFactor` 0.259 → 0.0) — a soft square-with-rounded-corners
    // pattern round every island. `max(|lx|,|lz|) − R` is exactly zero on the
    // grid boundary, so the two agree everywhere by construction.
    const d = Math.max(Math.abs(lx), Math.abs(lz));
    if (d > R + p.seabedShelfWidth) continue;
    // heightAt already reports -rimDepth outside the footprint, so the local
    // value is continuous across d = R; the shelf ramp carries it to open sea
    const local = isl.heightmap.heightAt(lx, lz);
    const t = shelfRamp(d - R, p.seabedShelfWidth);
    const hi = local + (open - local) * t;
    if (hi > h) h = hi;
  }
  return h;
}

export interface SeabedField {
  /** seabed height (m, waterline 0, negative below) at a world XZ */
  heightAt(x: number, z: number): number;
  /** water column depth (m, ≥ 0) under `waterY` — 0 where the seabed is dry */
  depthAt(x: number, z: number, waterY?: number): number;
  /** baked height texture (r16f, meters) for materials — see the node helpers */
  texture: THREE.DataTexture;
  /** world XZ of texel (0,0); uv = (worldXZ − origin) / size */
  origin: [number, number];
  /** world span (m) the texture covers on both axes */
  size: number;
  /** world size (m) of ONE texel — what a reader band-limits against (§V.48) */
  texelSize: number;
  /** seabed height reported where no island reaches (m, negative) */
  openHeight: number;
  /** live uniforms backing the TSL helpers (origin, 1/size) */
  uniforms: {
    origin: ReturnType<typeof uniform>;
    invSize: ReturnType<typeof uniform>;
  };
  dispose(): void;
}

/** square world AABB covering every island footprint + shelf + margin */
function fitBounds(
  islands: readonly SeabedIsland[],
  p: IslandParams,
): { origin: [number, number]; size: number } {
  if (islands.length === 0) return { origin: [-1, -1], size: 2 };
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const isl of islands) {
    const reach = isl.heightmap.worldRadius + p.seabedShelfWidth + p.seabedTextureMargin;
    minX = Math.min(minX, isl.center[0] - reach);
    maxX = Math.max(maxX, isl.center[0] + reach);
    minZ = Math.min(minZ, isl.center[1] - reach);
    maxZ = Math.max(maxZ, isl.center[1] + reach);
  }
  // square, centred: one `size` scalar keeps the shader mapping a single mul
  const size = Math.max(maxX - minX, maxZ - minZ, 1);
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  return { origin: [cx - size / 2, cz - size / 2], size };
}

/**
 * Build the shared seabed field. The texture is filled by evaluating
 * `sampleSeabedHeight` per texel, so GPU and CPU can only differ by
 * quantization (texel size = size / resolution, half-float height).
 */
export function createSeabedField(
  islands: readonly SeabedIsland[],
  p: IslandParams = islandParams,
): SeabedField {
  const res = Math.max(4, Math.floor(p.seabedTextureSize));
  const { origin, size } = fitBounds(islands, p);
  const openHeight = -p.seabedOpenDepth;

  // half float keeps a 1024² field at 2 MB and stays LINEAR-FILTERABLE on
  // WebGPU (r32float is not, without the float32-filterable feature)
  const data = new Uint16Array(res * res);
  const cell = size / res;
  for (let iz = 0; iz < res; iz++) {
    const wz = origin[1] + (iz + 0.5) * cell;
    for (let ix = 0; ix < res; ix++) {
      const wx = origin[0] + (ix + 0.5) * cell;
      data[iz * res + ix] = THREE.DataUtils.toHalfFloat(
        sampleSeabedHeight(islands, wx, wz, p),
      );
    }
  }

  const tex = new THREE.DataTexture(data, res, res, THREE.RedFormat, THREE.HalfFloatType);
  tex.name = 'island/seabedHeight';
  /**
   * §V.48 — MIPPED, and it is not optional now that this field drives geometry.
   *
   * This texture is minified by both of its readers. The fragment tint has
   * always been one (screen resolution against a texel that is `size/res`
   * metres — with the shipped archipelago that is ~6.8 m, so any view from
   * more than a few hundred metres minifies it), and §V.72's shoaling added a
   * second in the VERTEX stage, where the sampling rate is the clipmap's
   * vertex spacing: 0.5 m under the camera but ~90 m at the rim, i.e. thirteen
   * texels per sample. Unmipped minified sampling is a point sample of a field
   * that carries the island heightmap's own noise, and the shoaling factor
   * derived from it then wobbles per vertex as the clipmap snaps — §V.48's
   * "uniform speckle over a whole surface", arriving as a crawling shoreline.
   *
   * The mip chain is what a filtered tier IS for a texture that can carry one
   * (unlike the compute-written derivative StorageTextures, which cannot, and
   * whose absence of one is why surfaceMaterial has to reconstruct the same
   * thing from the spectrum). Cost is 33% of 2 MB, once, at build time.
   */
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  // clamp is correct, not a fallback: the margin guarantees the border ring is
  // already open-ocean depth, so sampling far outside reads open sea
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;

  const uniforms = {
    origin: uniform(new THREE.Vector2(origin[0], origin[1])),
    invSize: uniform(1 / size),
  };

  return {
    heightAt: (x, z) => sampleSeabedHeight(islands, x, z, p),
    depthAt: (x, z, waterY = 0) =>
      Math.max(waterY - sampleSeabedHeight(islands, x, z, p), 0),
    texture: tex,
    origin,
    size,
    texelSize: cell,
    openHeight,
    uniforms,
    dispose(): void {
      tex.dispose();
    },
  };
}

/**
 * TSL: seabed height (m, waterline 0) at a world-XZ node. `worldXZ` is a vec2
 * of world (x, z) — e.g. the ocean surface material's own `worldXZ`.
 */
export function seabedHeightNode(field: SeabedField, worldXZ: any): any {
  const uv = worldXZ.sub(field.uniforms.origin).mul(field.uniforms.invSize);
  return texture(field.texture, uv).r;
}

/**
 * TSL: seabed height at an EXPLICIT mip level chosen from the reader's own
 * sampling footprint — the vertex-stage twin of `seabedHeightNode`.
 *
 * §V.48, AND THE REASON THE MIP CHAIN ALONE IS NOT THE FIX. In three r180 the
 * vertex stage cannot take an implicit-derivative sample (`textureSample` is
 * fragment-only), so `WGSLNodeBuilder._generateTextureSample` rewrites every
 * non-fragment read as `textureSampleLevel(..., 0)` — LEVEL ZERO, hardcoded.
 * A vertex reader therefore point-samples the finest mip no matter how coarse
 * its own sampling grid is, and mipping the texture buys it nothing at all.
 * The level has to be handed in, which is what this exists to do.
 *
 * `footprint` is the world size (m) of one sample of the CALLING grid — for
 * the ocean clipmap that is its local vertex spacing, which already grows with
 * distance under the §V.30 LOD law, so this rides the LOD instead of ending in
 * a ring. The fragment stage needs none of this: there `texture()` picks its
 * own level from screen derivatives, and mipping the texture is the whole fix.
 */
export function seabedHeightLodNode(
  field: SeabedField,
  worldXZ: any,
  footprint: any,
): any {
  const uv = worldXZ.sub(field.uniforms.origin).mul(field.uniforms.invSize);
  // log2 of "how many texels does one sample of mine cover", floored at 0 —
  // magnification is level 0 and negative levels are not a thing (§V.28)
  const level = footprint.div(Math.max(field.texelSize, 1e-3)).max(1).log2();
  return texture(field.texture, uv).level(level).r;
}

/**
 * TSL: shallowness 0..1 — 0 in water at least `fullDepth` deep, 1 where the
 * seabed reaches the water surface. This is the factor the ocean material
 * should feed to its shallow-tint mix.
 *
 * `waterY` is the water surface height at the same XZ (the displaced FFT
 * height, so the tint breathes with the swell); `fullDepth` is the depth (m)
 * at which the shallow tint has completely given way to the deep body colour
 * — it belongs to whoever owns the look, hence a caller-supplied node.
 *
 * §V23: functional smoothstep, and e0 > e1 reads "1 at/below e1, 0 at/above
 * e0" — here 1 at depth 0, 0 at depth fullDepth.
 * §V28: fullDepth is floored so a 0 from the panel cannot divide by zero.
 */
export function seabedShallowFactorNode(
  field: SeabedField,
  worldXZ: any,
  waterY: any,
  fullDepth: any,
): any {
  const depth = waterY.sub(seabedHeightNode(field, worldXZ)).max(0);
  return smoothstep(float(fullDepth).max(1e-3), float(0), depth);
}
