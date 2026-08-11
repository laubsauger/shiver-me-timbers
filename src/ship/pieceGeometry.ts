/**
 * Greybox geometry per PieceKind, sized from the piece AABB (§V.18: any
 * conforming piece data renders without code changes). Pure BufferGeometry
 * — no materials here, so blueprint/geometry stay GPU-free for tests.
 * Holed variants live in pieceGeometryHoled.ts, sails in pieceGeometryShapes.ts.
 */
import * as THREE from 'three';
import type { AABB, PieceKind } from './pieceTypes';
import {
  aabbCenter,
  aabbSize,
  buildBowGeometry,
  buildDeckGeometry,
  buildHullSectionGeometry,
  buildSailGeometry,
  mergeNonIndexed,
} from './pieceGeometryShapes';

export { buildSailGeometry } from './pieceGeometryShapes';
export { buildHoledVariant } from './pieceGeometryHoled';

function box(aabb: AABB): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const c = aabbCenter(aabb);
  return new THREE.BoxGeometry(s.x, s.y, s.z).translate(c.x, c.y, c.z);
}

/** vertical spar tapering toward the top, base at aabb min-y */
function taperedSpar(aabb: AABB, topScale: number): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const c = aabbCenter(aabb);
  const r = s.x / 2;
  const geo = new THREE.CylinderGeometry(r * topScale, r, s.y, 12);
  return geo.translate(c.x, aabb.min[1] + s.y / 2, c.z);
}

/** horizontal spar along x (yards) */
function crossSpar(aabb: AABB): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const c = aabbCenter(aabb);
  const geo = new THREE.CylinderGeometry(s.y / 2, s.y / 2, s.x, 8);
  geo.rotateZ(Math.PI / 2);
  return geo.translate(c.x, c.y, c.z);
}

/** open lookout basket: tapered open cylinder + floor disc */
function crowNest(aabb: AABB): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const r = s.x / 2;
  const wall = new THREE.CylinderGeometry(r, r * 0.75, s.y, 10, 1, true);
  wall.translate(0, aabb.min[1] + s.y / 2, 0);
  const floor = new THREE.CircleGeometry(r * 0.75, 10);
  floor.rotateX(-Math.PI / 2);
  floor.translate(0, aabb.min[1] + 0.05, 0);
  return mergeNonIndexed([wall, floor]);
}

/** slender post with a lantern bulb at the top */
function lanternPost(aabb: AABB): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const r = s.x / 2;
  const post = new THREE.CylinderGeometry(r * 0.5, r * 0.6, s.y * 0.85, 8);
  post.translate(0, aabb.min[1] + s.y * 0.425, 0);
  const bulb = new THREE.SphereGeometry(r, 8, 6);
  bulb.translate(0, aabb.min[1] + s.y - r, 0);
  return mergeNonIndexed([post, bulb]);
}

export function buildPieceGeometry(kind: PieceKind, aabb: AABB): THREE.BufferGeometry {
  switch (kind) {
    case 'hull-section':
      return buildHullSectionGeometry(aabb);
    case 'deck':
      return buildDeckGeometry(aabb);
    case 'bow':
      return buildBowGeometry(aabb);
    case 'mast':
      return taperedSpar(aabb, 0.45);
    case 'bowsprit':
      return taperedSpar(aabb, 0.4);
    case 'yard':
      return crossSpar(aabb);
    case 'sail':
      return buildSailGeometry('full', aabb);
    case 'crow-nest':
      return crowNest(aabb);
    case 'lantern-post':
      return lanternPost(aabb);
    case 'keel':
    case 'transom':
    case 'gallery':
    case 'forecastle-deck':
    case 'sterncastle-deck':
    case 'cabin':
    case 'rail':
    case 'rudder':
      return box(aabb);
  }
}
