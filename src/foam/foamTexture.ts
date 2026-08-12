/**
 * GPU view of the foam art texture (foamPattern.ts) — §T.5 stage 3.
 *
 * ONE texture for the whole project, and it is a singleton for a reason that
 * is a hard limit and not a convenience: the ocean fragment stage has TWO
 * spare samplers (§V.40, `tests/oceanBindingBudget.test.ts`), Metal caps
 * samplers per function at 16, and overrun does not degrade — the bind group
 * layout fails, the pipeline is invalid and the ocean NEVER DRAWS, with the
 * console naming the descriptor rather than the texture that was added. Two
 * `texture()` reads of the SAME texture object dedupe to one binding and one
 * sampler (bindings hash on `value.uuid`), so the crest lookup and the soft
 * lookup are free of each other. Two texture OBJECTS would not be.
 *
 * Lazy, not eager: building the pattern is ~135 ms of CPU (measured, 256²,
 * two warped worley lookups and six fbms per texel) and nothing outside a live
 * renderer needs it. That is 0.2% of the 58 s cold boot §T.40 is about, and it
 * happens inside the shader-compilation phase rather than before first paint —
 * but it is not free, so it is stated. Halving the size quarters it.
 */
import * as THREE from 'three';
import { buildFoamPattern } from './foamPattern';

/**
 * Texels per side.
 *
 * 256, and the number is a band-limit decision rather than a memory one. The
 * crest layer repeats every `artCrestMetres` (≈6 m), so one texel is ≈2.3 cm —
 * finer than the ≈12 cm bubble clusters of its 52-cell raft and far finer than
 * any pixel of sea at any camera this game has. Going to 512 quadruples the
 * generation cost to resolve detail the mip chain immediately averages away;
 * going to 128 would put the fine raft at 2 texels per cell, which is where
 * the shape statistics in tests/foamTexture.test.ts stop meaning anything.
 */
export const FOAM_ART_SIZE = 256;

let cached: THREE.DataTexture | null = null;

/**
 * The shared foam art texture. Call from inside an `Fn()` body — the returned
 * object is inert data, but the `texture()` node built from it is not (§V.57).
 */
export function foamArtTexture(): THREE.DataTexture {
  if (cached) return cached;
  const tex = new THREE.DataTexture(
    buildFoamPattern(FOAM_ART_SIZE),
    FOAM_ART_SIZE,
    FOAM_ART_SIZE,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  // TILES: the pattern is periodic on the unit square by construction
  // (foamPattern's header) and is sampled at world/repeat over an unbounded
  // ocean. ClampToEdge here would stripe the entire sea.
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  // §V.48, and this is the FIFTH texture in this project to need saying so.
  // The crest layer's features are centimetres across on a surface that runs
  // to the horizon; unmipped, every pixel past a few metres picks one texel at
  // random and the whole sea speckles uniformly (the tell is always that the
  // noise covers a surface EVENLY rather than clustering). The mip chain is
  // also what supplies §V.48's second half for free: under minification each
  // channel converges to its own local MEAN, which is exactly the average that
  // pixel should have seen.
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  // the sea is viewed at grazing angles almost everywhere (§V.56b: distant
  // water is ENTIRELY grazing), so the anisotropic taps are not a nicety
  tex.anisotropy = 8;
  // NoColorSpace, explicitly: these are masks and heights, not albedo. Tagging
  // them sRGB would apply a transfer function to a dissolve threshold and
  // silently move the mean off 0.5 (§V.31's family, one axis over).
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  tex.name = 'foam-art';
  cached = tex;
  return tex;
}

/** drop the singleton (tests / hot reload) */
export function disposeFoamArtTexture(): void {
  cached?.dispose();
  cached = null;
}
