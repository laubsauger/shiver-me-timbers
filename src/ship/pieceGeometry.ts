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
import {
  asHullShape,
  buildEnvelopeDeck,
  buildLoftedBow,
  buildLoftedHullSection,
} from './pieceGeometryHull';
import {
  buildCannonGeometry,
  buildCapstanGeometry,
  buildGratingGeometry,
  buildRailGeometry,
  buildStairsGeometry,
  buildWheelGeometry,
} from './pieceGeometryFittings';
import {
  buildCabinGeometry,
  buildCastleDeck,
  buildCurvedRail,
} from './pieceGeometryCastle';
import {
  buildGalleryGeometry,
  buildTransomGeometry,
  type TransomShape,
} from './pieceGeometryStern';
import {
  buildChannelGeometry,
  buildGunportGeometry,
  buildMouldingGeometry,
} from './pieceGeometryDetail';
import {
  buildAnchorGeometry,
  buildCatheadGeometry,
  buildFigureheadGeometry,
  buildHeadrailGeometry,
} from './pieceGeometryHead';
import {
  buildBinnacleGeometry,
  buildPennantGeometry,
  buildPinRailGeometry,
  buildRatlinesGeometry,
  buildWindowGeometry,
} from './pieceGeometryRig';

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

export function buildPieceGeometry(
  kind: PieceKind,
  aabb: AABB,
  shape?: Record<string, number>,
): THREE.BufferGeometry {
  const hull = asHullShape(shape);
  switch (kind) {
    case 'hull-section':
      // lofted (pointed bow / rounded stern / sheer / tumblehome) when the
      // piece carries shape hints; plain tapered panel fallback otherwise
      return hull !== null ? buildLoftedHullSection(hull) : buildHullSectionGeometry(aabb);
    case 'deck':
      return hull !== null ? buildEnvelopeDeck(aabb, hull) : buildDeckGeometry(aabb);
    case 'bow':
      return hull !== null ? buildLoftedBow(hull) : buildBowGeometry(aabb);
    case 'cannon':
      return buildCannonGeometry(aabb);
    case 'wheel':
      return buildWheelGeometry(aabb);
    case 'capstan':
      return buildCapstanGeometry(aabb);
    case 'grating':
      return buildGratingGeometry(aabb);
    case 'stairs':
      return buildStairsGeometry(aabb);
    case 'forecastle-deck':
    case 'sterncastle-deck':
      // taper-following slab + bulkhead + posts; box fallback sans hints
      return hull !== null
        ? buildCastleDeck(
            hull,
            shape?.rise ?? 1,
            aabbSize(aabb).y,
            (shape?.bulkheadAft ?? 1) === 1,
          )
        : box(aabb);
    case 'cabin':
      return hull !== null ? buildCabinGeometry(hull, aabbSize(aabb).y) : box(aabb);
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
    case 'rail':
      // side rails carry hull hints → curve with taper + sheer;
      // straight runs (stern balustrade) keep the post-run builder
      return hull !== null
        ? buildCurvedRail(hull, aabb, shape?.railInset ?? 0.2, shape)
        : buildRailGeometry(aabb);
    case 'transom':
      // lofted cap matching the shell's aft section (closes the stern);
      // box fallback only for piece data without hull hints
      return hull !== null ? buildTransomGeometry(hull as TransomShape) : box(aabb);
    case 'gallery':
      return buildGalleryGeometry(aabb);
    // --- §T.34 detail fittings. The four that must lie ON the lofted shell
    // (gunports, channels, head rails, mouldings) need the hull hints to find
    // the surface; without them they fall back to a box rather than floating
    // off the planking, so a hint-free AI piece still renders (§V18).
    case 'gunport':
      return shape !== undefined ? buildGunportGeometry(shape) : box(aabb);
    case 'channel':
      return shape !== undefined ? buildChannelGeometry(shape) : box(aabb);
    case 'headrail':
      return shape !== undefined ? buildHeadrailGeometry(shape) : box(aabb);
    case 'moulding':
      return shape !== undefined ? buildMouldingGeometry(shape) : box(aabb);
    case 'pennant':
      return buildPennantGeometry(shape ?? {});
    case 'ratlines':
      return shape !== undefined ? buildRatlinesGeometry(shape) : box(aabb);
    case 'figurehead':
      return buildFigureheadGeometry(aabb);
    case 'cathead':
      return buildCatheadGeometry(aabb);
    case 'anchor':
      return buildAnchorGeometry(aabb);
    case 'pin-rail':
      return buildPinRailGeometry(aabb);
    case 'binnacle':
      return buildBinnacleGeometry(aabb);
    case 'window':
      return buildWindowGeometry(aabb);
    case 'keel':
    case 'rudder':
      return box(aabb);
  }
}
