/**
 * GPU texture construction for the ocean FFT pipeline (§V.4).
 * All simulation data lives in StorageTextures written by compute passes.
 */
import * as THREE from 'three/webgpu';
import { float, int, storageTexture, texture, textureLoad } from 'three/tsl';

type TslNode = any;

export function createDataTexture(
  data: Float32Array,
  width: number,
  height: number,
): THREE.DataTexture {
  const tex = new THREE.DataTexture(
    data,
    width,
    height,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** rgba32f storage texture for spectrum ping-pong (exact intermediate math) */
export function createSpectrumTexture(n: number): THREE.StorageTexture {
  const tex = new THREE.StorageTexture(n, n);
  tex.type = THREE.FloatType;
  tex.format = THREE.RGBAFormat;
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

/** tiling output texture (displacement / derivatives), sampled by materials */
export function createOutputTexture(n: number): THREE.StorageTexture {
  const tex = new THREE.StorageTexture(n, n);
  tex.type = THREE.FloatType;
  tex.format = THREE.RGBAFormat;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = false;
  return tex;
}

/**
 * The same thing, but with `layers` array slices behind ONE binding and ONE
 * SAMPLER (§V.40). Samplers are never shared between textures in three's WebGPU
 * backend — the sampler count IS the filterable-texture count — so three
 * per-cascade 2D textures cost 3+3 in a stage while one array texture costs
 * 1+1. That is the whole reason this exists; the layers are otherwise identical
 * to `createOutputTexture` and MUST stay that way.
 *
 * Every field below is load-bearing and is NOT the `StorageArrayTexture`
 * default:
 *  - type/format: the class sets neither, and the FFT unpack writes rgba32f.
 *  - Linear/Linear: the class does default to these, but they are the reason
 *    this costs a sampler at all — see §V.40 and `isUnfilterable`.
 *  - RepeatWrapping: the class defaults to ClampToEdge. The cascades TILE, and
 *    callers sample with `.fract()`-ed uv, so a bilinear tap that straddles the
 *    0/1 seam must wrap to the far edge or it clamps and the tile boundary
 *    shows as a seam across the whole sea.
 *  - A MIP CHAIN, and 16× anisotropy (the one difference from
 *    `createOutputTexture`). The sea's shading normals are read from these
 *    layers, and at a grazing view one pixel spans many of a cascade's
 *    wavelengths: a base-level tap is a point sample of a zero-mean slope
 *    field, and the far water shimmered as per-pixel dark and sky-blue specks
 *    (docs/drift/engine-findings.md §12). three r186 rebuilds a storage
 *    texture's chain itself, after a compute pass wrote it and before it is
 *    next sampled (`mipmapsAutoUpdate`, Bindings.js). Only a reader that
 *    passes its footprint uses the chain: see `sampleCascadeLayer`.
 */
export function createOutputArrayTexture(
  n: number,
  layers: number,
): THREE.StorageArrayTexture {
  const tex = new THREE.StorageArrayTexture(n, n, layers);
  tex.type = THREE.FloatType;
  tex.format = THREE.RGBAFormat;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.anisotropy = 16;
  return tex;
}

/**
 * One cascade's slice of a shared array texture: the texture everyone binds,
 * plus which layer this cascade owns.
 */
export interface CascadeLayer {
  readonly texture: THREE.StorageArrayTexture;
  readonly layer: number;
}

/**
 * Sample a cascade's layer. Go through this rather than calling `texture()`
 * directly — forgetting `.depth()` on a `texture_2d_array` emits a
 * `textureSample` with no array index, which is not a valid WGSL overload, and
 * the failure mode is §V.40's: `CreateBindGroupLayout`/pipeline creation fails,
 * the material never draws, and the console names the descriptor rather than
 * the call site. `int()` because `depthNode` is built as an `int`.
 *
 * WITHOUT `grad`, the base level, bilinear: what every reader got before the
 * layers had a mip chain. Not an implicit-derivative sample: callers pass
 * `.fract()`-ed uv, whose derivative jumps by a whole tile at the wrap, so an
 * implicit sample would take the smallest mip along every tile seam.
 * WITH `grad` = the uv's screen derivatives [d/dx, d/dy] (of the uv BEFORE its
 * `.fract()`), a filtered, anisotropic sample over that footprint.
 *
 * FRAGMENT STAGE ONLY. Recorded against three r180 in
 * tests/oceanBindingBudget.test.ts; r186's `generateTextureSampleLevel` and
 * `generateTextureGrad` do carry the array index in the fragment stage.
 */
export function sampleCascadeLayer(slice: CascadeLayer, uv: TslNode, grad?: [TslNode, TslNode]): TslNode {
  const t = texture(slice.texture, uv);
  return (grad ? t.grad(grad[0], grad[1]) : t.level(float(0))).depth(int(slice.layer));
}

/**
 * Write a cascade's layer from a compute pass.
 *
 * NOT `textureStore(...).depth(...)`: `textureStore` calls `toStack()`
 * IMMEDIATELY on the node it builds, while `.depth()` returns a CLONE — so that
 * spelling emits the UNLAYERED store and drops the layered clone on the floor.
 * Build with `storageTexture`, clone with the layer, then stack that. (Access
 * is set after `.depth()` too: `TextureNode.clone()` does not copy it, so any
 * `.toWriteOnly()` before the clone is silently lost.)
 */
export function storeCascadeLayer(
  slice: CascadeLayer,
  coord: TslNode,
  value: TslNode,
): void {
  const store: TslNode = storageTexture(slice.texture, coord, value).depth(
    int(slice.layer),
  );
  store.toWriteOnly().toStack();
}

/**
 * Read a cascade's layer WITHOUT a sampler, for compute passes that already
 * have integer texel coordinates. `textureLoad` is the one path in three r180
 * that carries the array index correctly in every shader stage
 * (`generateTextureLoad` passes `depthSnippet`; the filtered paths do not).
 * `.setSampler(false)` survives the `.depth()` clone — `TextureNode.clone()`
 * copies `sampler` — so the order here is safe either way round.
 */
export function loadCascadeLayer(slice: CascadeLayer, coord: TslNode): TslNode {
  return textureLoad(slice.texture, coord).depth(int(slice.layer));
}
