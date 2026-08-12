/**
 * GPU view of the procedural deck heightfield (deckHeightfield.ts).
 *
 * Kept in its own module so the generator itself stays three-free: the
 * blueprint tests and the deck-water solver's CPU side both want the field
 * without dragging a renderer in.
 *
 * Layout — RGBA, half float:
 *   R  terrain height in metres, relative to `field.deckY`  (structure + plank)
 *   G  water-domain coverage, 0 outboard of the planking … 1 on open deck
 *   B  the per-board component of R alone, in metres
 *   A  obstacle mask: 1 = bulwark / coaming / mast partner / capstan drum
 *
 * Half float rather than float32 on purpose: `float32-filterable` is an
 * OPTIONAL WebGPU feature, and an unfilterable texture sampled with a linear
 * sampler is a validation error, not a soft fallback. Half float carries ~3
 * decimal digits, which is 0.5 mm at the 1 m scale of R and finer still on B
 * — and the sub-millimetre plank detail is exactly why B is a SEPARATE
 * channel instead of being read out of R by subtraction.
 */
import * as THREE from 'three';
import type { DeckHeightfield } from './deckHeightfield';

export interface DeckFieldSampler {
  texture: THREE.DataTexture;
  /** ship-space rectangle the texture's [0,1]² covers */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** ship-space y the field's height 0 sits at */
  deckY: number;
}

export function createDeckFieldTexture(field: DeckHeightfield): DeckFieldSampler {
  const count = field.width * field.height;
  const data = new Uint16Array(count * 4);
  for (let i = 0; i < count; i++) {
    data[i * 4] = THREE.DataUtils.toHalfFloat(field.data[i]);
    data[i * 4 + 1] = THREE.DataUtils.toHalfFloat(field.mask[i]);
    data[i * 4 + 2] = THREE.DataUtils.toHalfFloat(field.plank[i]);
    data[i * 4 + 3] = THREE.DataUtils.toHalfFloat(field.solid[i]);
  }
  const texture = new THREE.DataTexture(
    data,
    field.width,
    field.height,
    THREE.RGBAFormat,
    THREE.HalfFloatType,
  );
  // clamp, not repeat: sampling past the transom must return the transom row,
  // never wrap round to the stem
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  // MIPS ARE NOT OPTIONAL HERE (§V.48). This texture is 192 × 512 over a 35 m
  // deck and the grazing follow camera compresses that length into a few
  // hundred pixels, so the along-ship axis is heavily minified. Unmipped, the
  // per-board channel becomes per-pixel random under minification — and it is
  // consumed twice, as an albedo multiplier AND as a height that reliefNormal
  // differentiates in screen space, so it produced albedo speckle and specular
  // speckle at once, over the entire deck, in calm water at 1.7 knots.
  //
  // This is the THIRD time this project has shipped an unmipped texture that
  // aliased into uniform per-pixel speckle (foam StorageTexture at the
  // horizon, ocean far field, now this). The tell is always that the noise
  // covers a whole surface evenly rather than clustering anywhere.
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8; // the grazing deck view is the whole problem
  texture.needsUpdate = true;
  texture.name = 'deck-heightfield';
  return {
    texture,
    minX: field.minX,
    maxX: field.maxX,
    minZ: field.minZ,
    maxZ: field.maxZ,
    deckY: field.deckY,
  };
}
