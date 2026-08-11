/**
 * Piece materials (§V16): tri-planar plank wood per piece family + sail
 * cloth, node builders in woodMaterial.ts. Two-tone weathered wood per
 * docs/ship-full-view.png — warm mid-tone hull w/ darker wale stripes,
 * pale deck, dark trim. Kept apart from geometry so tests stay GPU-free.
 * §V23: no chained 3-arg TSL math anywhere in this module tree.
 */
import * as THREE from 'three/webgpu';
import type { PieceKind } from './pieceTypes';
import { shipMaterialParams } from '../params/ship';
import {
  createWoodMaterial,
  type ShipMaterialHandle,
  type WoodTones,
} from './woodMaterial';
import { createSailClothMaterial } from './sailMaterial';

export { uShipSunDirection } from './sailMaterial';
export { setShipWorldMatrix } from './woodMaterial';

type Family = 'hull' | 'deck' | 'spar' | 'trim' | 'sail';

const FAMILY_OF: Record<PieceKind, Family> = {
  cannon: 'trim',
  wheel: 'trim',
  capstan: 'trim',
  grating: 'trim',
  stairs: 'deck',
  'hull-section': 'hull',
  bow: 'hull',
  transom: 'hull',
  cabin: 'hull',
  gallery: 'hull',
  deck: 'deck',
  'forecastle-deck': 'deck',
  'sterncastle-deck': 'deck',
  mast: 'spar',
  yard: 'spar',
  bowsprit: 'spar',
  'crow-nest': 'spar',
  keel: 'trim',
  rail: 'trim',
  rudder: 'trim',
  'lantern-post': 'trim',
  sail: 'sail',
};

/**
 * Pieces whose LOCAL y is ship-space y, so `y < 0` genuinely means below the
 * waterline. Only these may wear the wet boot-top: `cabin` and `gallery` are
 * also 'hull' family, but they sit high on the stern with their own local
 * origins — the gallery's would put a dark waterline band across its windows.
 */
const WATERLINE_KINDS = new Set<PieceKind>(['hull-section', 'bow', 'transom']);

function woodTones(family: Exclude<Family, 'sail'>, waterline: boolean): WoodTones {
  const p = shipMaterialParams;
  switch (family) {
    case 'hull':
      return { light: p.hullLight, dark: p.hullDark, wale: true, waterline };
    case 'deck':
      return { light: p.deckLight, dark: p.deckDark, wale: false, waterline: false };
    case 'spar':
      return { light: p.sparLight, dark: p.sparDark, wale: false, waterline: false };
    case 'trim':
      return { light: p.trimLight, dark: p.trimDark, wale: false, waterline: false };
  }
}

/** every live handle, so the debug panel can refresh all ships (§V16) */
const liveHandles = new Set<ShipMaterialHandle>();

export function refreshShipMaterials(): void {
  for (const handle of liveHandles) handle.refresh();
}

/** track for live refresh; untrack when the material is disposed */
function tracked(handle: ShipMaterialHandle, name: string): THREE.MeshStandardNodeMaterial {
  liveHandles.add(handle);
  const dispose = handle.material.dispose.bind(handle.material);
  handle.material.dispose = () => {
    liveHandles.delete(handle);
    dispose();
  };
  handle.material.name = name;
  return handle.material;
}

/** open shells (lofted hull strips, lookout basket) render both faces so
 *  looking inside never shows culled holes (§V22 critique) */
const OPEN_SHELL_KINDS = new Set<PieceKind>([
  'hull-section',
  'bow',
  'transom',
  'crow-nest',
]);

export function createPieceMaterial(kind: PieceKind): THREE.MeshStandardNodeMaterial {
  const family = FAMILY_OF[kind];
  const handle =
    family === 'sail'
      ? createSailClothMaterial()
      : createWoodMaterial(woodTones(family, WATERLINE_KINDS.has(kind)));
  if (OPEN_SHELL_KINDS.has(kind)) handle.material.side = THREE.DoubleSide;
  // double-sided hull shells: cast from front faces only, otherwise coplanar
  // back faces self-shadow (acne) under the sun map
  if (OPEN_SHELL_KINDS.has(kind)) handle.material.shadowSide = THREE.FrontSide;
  // sails must cast from BOTH faces: front-face-only culled the whole sail
  // out of the shadow map whenever the sun was behind it, so sails never
  // shadowed the deck or each other (§V22 self-shadow critique)
  if (family === 'sail') handle.material.shadowSide = THREE.DoubleSide;
  return tracked(handle, `piece-${kind}`);
}

/** dark interior seen through a breach (holed variant group 1) */
export function createHoleMaterial(): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial();
  mat.color.setHex(shipMaterialParams.holeColor);
  mat.roughness = 1;
  mat.metalness = 0;
  mat.name = 'piece-hole';
  return mat;
}
