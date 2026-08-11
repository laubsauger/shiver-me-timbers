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
import { createFlagClothMaterial } from './flagMaterial';
import { createGlassMaterial, createIronMaterial } from './fittingMaterials';
import type { DeckFieldSampler } from './deckFieldTexture';

export { uShipSunDirection } from './sailMaterial';
export { setShipWorldMatrix } from './woodMaterial';

type Family = 'hull' | 'deck' | 'spar' | 'trim' | 'sail' | 'flag' | 'iron' | 'glass';

const FAMILY_OF: Record<PieceKind, Family> = {
  pennant: 'flag',
  figurehead: 'trim',
  ratlines: 'trim', // tarred hemp — the darkest cordage aboard
  gunport: 'hull',
  channel: 'iron',
  headrail: 'trim',
  cathead: 'trim',
  anchor: 'iron',
  'pin-rail': 'trim',
  binnacle: 'trim',
  window: 'glass',
  moulding: 'trim',
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

/**
 * Which piece-local axis a spar runs along. Spars are built of staves LENGTHWISE
 * — without this the seam function stacks its courses up the local y of a
 * cylinder and wraps them into barrel hoops (see WoodTones.sparAxis).
 */
export const SPAR_AXIS: Partial<Record<PieceKind, 'x' | 'y'>> = {
  mast: 'y',
  bowsprit: 'y',
  'crow-nest': 'y',
  yard: 'x',
};

type WoodFamily = Exclude<Family, 'sail' | 'flag' | 'iron' | 'glass'>;

function woodTones(
  family: WoodFamily,
  kind: PieceKind,
  waterline: boolean,
  deckField?: DeckFieldSampler,
): WoodTones {
  const p = shipMaterialParams;
  const sparAxis = SPAR_AXIS[kind];
  const base = sparAxis === undefined ? {} : { sparAxis };
  switch (family) {
    case 'hull':
      return { ...base, light: p.hullLight, dark: p.hullDark, wale: true, waterline };
    case 'deck':
      return {
        ...base,
        light: p.deckLight,
        dark: p.deckDark,
        wale: false,
        waterline: false,
        ...(deckField === undefined ? {} : { deckField }),
      };
    case 'spar':
      return { ...base, light: p.sparLight, dark: p.sparDark, wale: false, waterline: false };
    case 'trim':
      return { ...base, light: p.trimLight, dark: p.trimDark, wale: false, waterline: false };
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

export function createPieceMaterial(
  kind: PieceKind,
  deckField?: DeckFieldSampler,
): THREE.MeshStandardNodeMaterial {
  const family = FAMILY_OF[kind];
  let handle: ShipMaterialHandle;
  switch (family) {
    case 'sail':
      handle = createSailClothMaterial();
      break;
    case 'flag':
      handle = createFlagClothMaterial();
      break;
    case 'iron':
      handle = createIronMaterial();
      break;
    case 'glass':
      handle = createGlassMaterial();
      break;
    default:
      handle = createWoodMaterial(
        woodTones(family, kind, WATERLINE_KINDS.has(kind), deckField),
      );
  }
  if (OPEN_SHELL_KINDS.has(kind)) handle.material.side = THREE.DoubleSide;
  // double-sided hull shells: cast from front faces only, otherwise coplanar
  // back faces self-shadow (acne) under the sun map
  if (OPEN_SHELL_KINDS.has(kind)) handle.material.shadowSide = THREE.FrontSide;
  // sails must cast from BOTH faces: front-face-only culled the whole sail
  // out of the shadow map whenever the sun was behind it, so sails never
  // shadowed the deck or each other (§V22 self-shadow critique)
  if (family === 'sail' || family === 'flag') handle.material.shadowSide = THREE.DoubleSide;
  // ratlines and flags are thin: shrinking them out of the shadow map is
  // cheaper than the acne they produce, and a flag's shadow is a wash anyway
  if (family === 'flag') handle.material.side = THREE.DoubleSide;
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
