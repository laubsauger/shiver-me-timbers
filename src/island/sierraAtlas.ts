/**
 * THE SIERRA ISLAND ATLAS (§T.132) — one material for every granite island.
 *
 * WHAT WAS WRONG. `islandMaterials.ts` kept `sierraTerrains`/`sierraRocks` as
 * Maps keyed per `IslandHeightmap`, under a comment that said the six handles
 * "DO share the program: the node graph is identical, only the texture binding
 * differs, and the WebGPU pipeline cache keys on the generated code". Both
 * halves were false, and they were false for the same reason: the per-island
 * numbers were CONSTANTS in the graph, so they were printed into the WGSL.
 * Diffed headlessly, two islands' terrain shaders differed in exactly six
 * literals — `2·worldRadius` (twice: the horizon uv and the info uv), the
 * sheeting `bandPhase`, the joint-noise offset, and the two joint axes — which
 * is six distinct program strings for six islands. And even had the source
 * matched, three caches a built material by its NODE INSTANCE ids, so six
 * material objects are six `NodeBuilder.build()` runs regardless. MEASURED
 * headless on the raft world's island set: 6 terrain programs / 12.9 s of
 * codegen plus 6 rock programs / 8.6 s, and in-browser 39.9 s + 18.4 s of
 * `compileAsync` — the single biggest item in boot, growing with island count.
 *
 * THE CURE. Get the per-island data out of the graph's IDENTITY:
 *   - the two horizon planes and the terrain-info texture become
 *     `DataArrayTexture`s, one LAYER per island, sampled with `.depth(layer)`;
 *   - the layer index and the five per-island numbers become OBJECT-GROUP
 *     uniforms, filled in `onObjectUpdate` off `object.userData.sierraIsland`
 *     — the mechanism `src/ship/sailDriver.ts` and `raftMaterialNodes.ts`
 *     already use for per-piece data (§T.90). §B85's trap applies: the hook
 *     goes on EVERY uniform, because three runs a uniform's `onObjectUpdate`
 *     only when THAT uniform is referenced by the shader, and the rock graph
 *     and the terrain graph reference different subsets.
 * One material, one program, one codegen run, for any number of islands.
 *
 * WHY AN ARRAY TEXTURE AND NOT AN ATLAS-WITH-OFFSET. An offset atlas needs a
 * per-island uv scale AND a clamp to keep bilinear taps and, worse, MIPS from
 * bleeding across the neighbouring island's tile — and §V48 requires these
 * fields mipped (they are read under heavy minification from a kilometre off).
 * An array texture mips each layer independently and clamps at the layer edge
 * for free, which is exactly the existing per-island texture's behaviour. The
 * cost is that every layer is the same resolution.
 *
 * SO THE LAYERS ARE ONE FIXED SIZE and each island's bake is RESAMPLED into
 * it on upload. The heightmaps are not all one size — `sierraSites.ts` builds
 * slices at `sliceGridSize` (256) and fillers at `fillerGridSize` (128) — and
 * the resample is done at the GPU's own sampling convention (texel centres at
 * (i+0.5)/size), so a 128 layer read at 256 is the value the GPU's bilinear
 * filter would have returned from the 128 texture. The CPU bakes are NOT
 * touched: `horizonMapFor`/`terrainInfoFor` keep full native resolution, and
 * everything that samples them on the CPU (placement, the shader's CPU twins,
 * the tests) is unaffected.
 */
import * as THREE from 'three/webgpu';
import { objectGroup, uniform } from 'three/tsl';
import type { IslandHeightmap } from './heightmap';
import { horizonMapFor, type HorizonMap } from './horizonMap';
import { terrainInfoFor } from './terrainInfoBake';
import type { TerrainInfo } from './terrainInfo';
// sierraMaterial.ts imports this module TYPE-ONLY, so this direction is the
// only runtime edge between the two and there is no cycle.
import { jointAxes, sheetPhase } from './sierraMaterial';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyNode = any;

/**
 * Layer resolution. 256 = `sierraParams.sliceGridSize`, the largest grid the
 * shipped world bakes, so the hero islands are stored at native resolution and
 * only the 128² fillers are up-sampled (lossless under the linear filter they
 * are read with). A grid CRANKED past this in the panel is DOWN-sampled for
 * SHADING only — the mesh, the collision and every CPU reader keep the full
 * bake.
 */
export const SIERRA_ATLAS_SIZE = 256;

/**
 * Layer cap. The params' own maximum sierra island count is
 * `sliceCount` (≤3) + `fillerCount` (≤6) + the half dome (1) = 10; 12 leaves
 * headroom without another allocation. Past it `bind()` throws by name (§Rule
 * 8) rather than silently shading an island with its neighbour's horizon.
 *
 * VRAM: 3 arrays × 12 layers × 256² × RGBA8 = 9.4 MB, ×4/3 for mips ≈ 12.6 MB,
 * FLAT in island count. The six per-island texture sets it replaces were
 * ≈3.9 MB and grew with every island added.
 */
export const SIERRA_ATLAS_LAYERS = 12;

/** everything the shader needs to know about WHICH island it is drawing */
export interface SierraIslandBinding {
  /** index into the atlas layers */
  layer: number;
  /** the island's half-extent (m); the grid spans [-radius, radius]² */
  radius: number;
  /** the bake's joint-noise offset */
  jointOffset: THREE.Vector2;
  /** the island's two joint-set axes, seeded off its ice azimuth */
  jointDirA: THREE.Vector2;
  jointDirB: THREE.Vector2;
  /** per-island sheeting phase, so two islands do not band at the same metres */
  bandPhase: number;
}

/** the object-group uniforms every sierra material reads */
export interface SierraIslandUniforms {
  readonly layer: AnyNode;
  readonly radius: AnyNode;
  readonly jointOffset: AnyNode;
  readonly jointDirA: AnyNode;
  readonly jointDirB: AnyNode;
  readonly bandPhase: AnyNode;
}

export interface SierraAtlas {
  /** azimuths 0..3 and 4..7, one layer per island */
  horizon: [THREE.DataArrayTexture, THREE.DataArrayTexture];
  /** curvature / moisture / pathDistance / debris, one layer per island */
  info: THREE.DataArrayTexture;
  uniforms: SierraIslandUniforms;
  /** uv step of one atlas texel */
  readonly texel: number;
  /** metres per atlas texel for the island being drawn, as a node */
  readonly cell: AnyNode;
  /** allocate (or return) this island's layer and upload its bakes */
  bind(hm: IslandHeightmap): SierraIslandBinding;
  /** hand the island's layer back to the free list */
  release(hm: IslandHeightmap): void;
  /** how many layers are in use — the test's handle on "one material, N islands" */
  readonly used: number;
  dispose(): void;
}

// ── resampling ────────────────────────────────────────────────────────────

/**
 * Bilinear RGBA8 resample at the GPU's sampling convention: destination texel
 * j covers uv (j+0.5)/dstSize, which lands at source coordinate
 * u·srcSize − 0.5, clamped at the edge exactly as `ClampToEdgeWrapping` does.
 * A same-size call is a straight copy, bit for bit.
 */
export function resampleRgba8(
  src: Uint8Array,
  srcOffset: number,
  srcSize: number,
  dst: Uint8Array,
  dstOffset: number,
  dstSize: number,
): void {
  if (srcSize === dstSize) {
    dst.set(src.subarray(srcOffset, srcOffset + srcSize * srcSize * 4), dstOffset);
    return;
  }
  const scale = srcSize / dstSize;
  // CLAMP THE COORDINATE, ⊥ THE INDEX. Clamping `floor(s)` and keeping
  // `s - floor(s)` as the weight is the classic off-by-one: at s = -0.25 it
  // reads 0.25·texel0 + 0.75·texel1 — the edge value pulled INWARD, where
  // clamp-to-edge means texel0 exactly. Pinned in the test.
  const clamp = (v: number): number => (v < 0 ? 0 : v > srcSize - 1 ? srcSize - 1 : v);
  for (let jz = 0; jz < dstSize; jz++) {
    const sz = clamp((jz + 0.5) * scale - 0.5);
    const z0 = Math.floor(sz);
    const z1 = Math.min(z0 + 1, srcSize - 1);
    const fz = sz - z0;
    for (let jx = 0; jx < dstSize; jx++) {
      const sx = clamp((jx + 0.5) * scale - 0.5);
      const x0 = Math.floor(sx);
      const x1 = Math.min(x0 + 1, srcSize - 1);
      const fx = sx - x0;
      const i00 = srcOffset + (z0 * srcSize + x0) * 4;
      const i10 = srcOffset + (z0 * srcSize + x1) * 4;
      const i01 = srcOffset + (z1 * srcSize + x0) * 4;
      const i11 = srcOffset + (z1 * srcSize + x1) * 4;
      const o = dstOffset + (jz * dstSize + jx) * 4;
      for (let c = 0; c < 4; c++) {
        const top = src[i00 + c] + (src[i10 + c] - src[i00 + c]) * fx;
        const bot = src[i01 + c] + (src[i11 + c] - src[i01 + c]) * fx;
        dst[o + c] = Math.round(top + (bot - top) * fz);
      }
    }
  }
}

// ── the atlas ─────────────────────────────────────────────────────────────

function makeArrayTexture(name: string, layers: number): THREE.DataArrayTexture {
  const size = SIERRA_ATLAS_SIZE;
  const tex = new THREE.DataArrayTexture(new Uint8Array(size * size * 4 * layers), size, size, layers);
  tex.name = name;
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  // §V48: read under heavy minification from a kilometre off. An array texture
  // mips each layer on its own, so this is the per-island texture's behaviour.
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

export function createSierraAtlas(layers: number = SIERRA_ATLAS_LAYERS): SierraAtlas {
  const size = SIERRA_ATLAS_SIZE;
  const layerBytes = size * size * 4;
  const horizon: [THREE.DataArrayTexture, THREE.DataArrayTexture] = [
    makeArrayTexture('island/horizon0', layers),
    makeArrayTexture('island/horizon1', layers),
  ];
  const info = makeArrayTexture('island/terrainInfo', layers);

  // §T.90 / §B85: object-group uniforms, hooked on EVERY member.
  const layer = uniform(0).setGroup(objectGroup);
  const radius = uniform(1).setGroup(objectGroup);
  const jointOffset = uniform(new THREE.Vector2()).setGroup(objectGroup);
  const jointDirA = uniform(new THREE.Vector2(1, 0)).setGroup(objectGroup);
  const jointDirB = uniform(new THREE.Vector2(0, 1)).setGroup(objectGroup);
  const bandPhase = uniform(0).setGroup(objectGroup);

  let lastObject: THREE.Object3D | null = null;
  let lastFrame = -1;
  let warned = false;
  const update = (frame: { object: THREE.Object3D | null; frameId: number }): void => {
    const object = frame.object;
    if (object === null || object === undefined) return;
    if (object === lastObject && frame.frameId === lastFrame) return;
    lastObject = object;
    lastFrame = frame.frameId;
    const b = object.userData.sierraIsland as SierraIslandBinding | undefined;
    if (b === undefined) {
      // §Rule 8: a sierra mesh nobody tagged would silently inherit whichever
      // island was drawn before it — say so once rather than shade a lie.
      if (!warned) {
        warned = true;
        console.error(
          `[sierraAtlas] "${object.name}" draws a sierra material with no userData.sierraIsland — ` +
            'tag it in createIsland (tagSierraIsland) or it inherits the previous island.',
        );
      }
      return;
    }
    layer.value = b.layer;
    radius.value = b.radius;
    (jointOffset.value as THREE.Vector2).copy(b.jointOffset);
    (jointDirA.value as THREE.Vector2).copy(b.jointDirA);
    (jointDirB.value as THREE.Vector2).copy(b.jointDirB);
    bandPhase.value = b.bandPhase;
  };
  for (const u of [layer, radius, jointOffset, jointDirA, jointDirB, bandPhase]) u.onObjectUpdate(update);

  const bound = new Map<IslandHeightmap, SierraIslandBinding>();
  const free: number[] = [];
  let next = 0;

  const upload = (index: number, map: HorizonMap, ti: TerrainInfo): void => {
    const plane = map.size * map.size * 4;
    resampleRgba8(map.angles, 0, map.size, horizon[0].image.data as Uint8Array, index * layerBytes, size);
    resampleRgba8(map.angles, plane, map.size, horizon[1].image.data as Uint8Array, index * layerBytes, size);
    resampleRgba8(ti.bytes, 0, ti.size, info.image.data as Uint8Array, index * layerBytes, size);
    horizon[0].needsUpdate = true;
    horizon[1].needsUpdate = true;
    info.needsUpdate = true;
  };

  return {
    horizon,
    info,
    uniforms: { layer, radius, jointOffset, jointDirA, jointDirB, bandPhase },
    texel: 1 / size,
    // metres per atlas texel — the resampled grid's own spacing, ⊥ the bake's
    cell: radius.mul(2 / (size - 1)),
    bind(hm): SierraIslandBinding {
      const existing = bound.get(hm);
      if (existing) return existing;
      const index = free.pop() ?? next++;
      if (index >= layers) {
        throw new Error(
          `createSierraAtlas: ${layers} layers is the cap and island ${index + 1} wants one — ` +
            'raise SIERRA_ATLAS_LAYERS in src/island/sierraAtlas.ts (VRAM ≈ 1.05 MB per layer)',
        ); // §Rule 8
      }
      const map = horizonMapFor(hm);
      const ti = terrainInfoFor(hm);
      upload(index, map, ti);
      const az = hm.sierra?.iceAzimuth ?? 0;
      const [a, b] = jointAxes(az);
      const binding: SierraIslandBinding = {
        layer: index,
        radius: hm.worldRadius,
        jointOffset: new THREE.Vector2(ti.jointNoiseOffset[0], ti.jointNoiseOffset[1]),
        jointDirA: new THREE.Vector2(a[0], a[1]),
        jointDirB: new THREE.Vector2(b[0], b[1]),
        bandPhase: sheetPhase(az),
      };
      bound.set(hm, binding);
      return binding;
    },
    release(hm): void {
      const b = bound.get(hm);
      if (!b) return;
      bound.delete(hm);
      free.push(b.layer);
    },
    get used(): number {
      return bound.size;
    },
    dispose(): void {
      horizon[0].dispose();
      horizon[1].dispose();
      info.dispose();
      bound.clear();
      free.length = 0;
      next = 0;
    },
  };
}

/**
 * Stamp the binding on every mesh under `root` — the terrain mesh, the rock
 * InstancedMeshes, the talus. The whole subtree is tagged rather than a hand
 * list, because a mesh that grows a sierra material later must not have to
 * remember to add itself here (§V37: two lists that can disagree).
 */
export function tagSierraIsland(root: THREE.Object3D, binding: SierraIslandBinding): void {
  root.traverse((o) => {
    o.userData.sierraIsland = binding;
  });
}
