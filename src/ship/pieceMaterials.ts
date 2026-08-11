/**
 * Greybox wood-tone materials per PieceKind (§V.13 readability pass).
 * Kept in their own module so tests/blueprint code never import GPU-facing
 * material classes. TODO(T22): tri-planar wood PBR replaces these tones.
 */
import * as THREE from 'three/webgpu';
import type { PieceKind } from './pieceTypes';

const WOOD_TONES: Record<PieceKind, number> = {
  'hull-section': 0x6b4a2c,
  keel: 0x4a341f,
  deck: 0x9c7a4e,
  bow: 0x6b4a2c,
  transom: 0x7a5533,
  gallery: 0xb08d57,
  'forecastle-deck': 0x9c7a4e,
  'sterncastle-deck': 0x9c7a4e,
  cabin: 0x7a5533,
  'lantern-post': 0x3f2f1d,
  mast: 0x8a6a42,
  'crow-nest': 0x6b4a2c,
  yard: 0x8a6a42,
  sail: 0xe8e0cc,
  bowsprit: 0x8a6a42,
  rail: 0x5c4026,
  rudder: 0x5c4026,
};

export function createPieceMaterial(kind: PieceKind): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial();
  mat.color.setHex(WOOD_TONES[kind]);
  mat.roughness = kind === 'sail' ? 0.95 : 0.85;
  mat.metalness = 0;
  if (kind === 'sail') mat.side = THREE.DoubleSide;
  mat.name = `piece-${kind}`;
  return mat;
}

/** dark interior seen through a breach (holed variant group 1) */
export function createHoleMaterial(): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial();
  mat.color.setHex(0x120c07);
  mat.roughness = 1;
  mat.metalness = 0;
  mat.name = 'piece-hole';
  return mat;
}
