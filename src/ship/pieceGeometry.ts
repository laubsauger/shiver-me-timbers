/**
 * Greybox geometry per PieceKind, sized from the piece AABB (§V.18: any
 * conforming piece data renders without code changes). Pure BufferGeometry
 * — no materials here, so blueprint/geometry stay GPU-free for tests.
 * Holed variants live in pieceGeometryHoled.ts, sails in pieceGeometryShapes.ts.
 */
import * as THREE from 'three';
import { LANTERN_ARM_REACH, type AABB, type PieceKind } from './pieceTypes';
import {
  aabbCenter,
  aabbSize,
  buildBowGeometry,
  buildDeckGeometry,
  buildHullSectionGeometry,
  mergeNonIndexed,
} from './pieceGeometryShapes';
import { buildSailGeometry } from './pieceGeometrySail';
import { buildMastGeometry, buildYardGeometry } from './pieceGeometrySpar';
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
  buildWheelDiscGeometry,
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
  buildWindowGeometry,
} from './pieceGeometryRig';

import {
  buildCabinWallGeometry,
  buildCrateGeometry,
  buildCrossbeamGeometry,
  buildLogGeometry,
  buildPoleGeometry,
  buildRaftSlabGeometry,
  buildSteeringOarGeometry,
  buildSternBlockGeometry,
} from './pieceGeometryRaft';

export { buildSailGeometry } from './pieceGeometrySail';
export { buildHoledVariant } from './pieceGeometryHoled';

function box(aabb: AABB): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const c = aabbCenter(aabb);
  return new THREE.BoxGeometry(s.x, s.y, s.z).translate(c.x, c.y, c.z);
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

/**
 * Slender post with an iron bracket at the top. The LAMP IS NOT PART OF IT —
 * it hangs from `socket-lantern-*` at the bracket's tip and swings (src/lanterns).
 *
 * This piece used to carry a bulb of its own: a sphere of radius `r` centred at
 * `height - r`, while the shaft stopped at 0.85 of the height. Two defects fell
 * out of that, both in the user's report (docs/bugs/bug-lantern-spheres.png):
 *
 *   - the sphere FLOATED. Shaft top 0.85·h, bulb bottom h - 2r = 0.90·h at the
 *     galleon's numbers — a 0.10 m gap of open air between the post and the
 *     thing it was meant to be capping.
 *   - it was a SECOND BULB. The practical light hangs `cordLength` (0.35 m)
 *     below the cap, so every post carried two globes 0.36 m apart: one dark
 *     sphere lit from underneath by the other, which is exactly what "large
 *     dark balls floating above the rail" was.
 *
 * So the post is now only a post: full-height shaft, a cap ferrule, and the
 * bracket the lamp actually hangs off, reaching aft by `LANTERN_ARM_REACH` to
 * the socket's own z with a short hook drop at the tip. One lamp per post, and
 * it is attached to something.
 */
function lanternPost(aabb: AABB): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const r = s.x / 2;
  const top = aabb.min[1] + s.y;
  const shaft = new THREE.CylinderGeometry(r * 0.5, r * 0.6, s.y, 8);
  shaft.translate(0, aabb.min[1] + s.y / 2, 0);
  const cap = new THREE.CylinderGeometry(r * 0.7, r * 0.52, r * 0.4, 8);
  cap.translate(0, top - r * 0.2, 0);
  // the bracket: a horizontal iron reaching aft (−z) to the socket station
  const arm = new THREE.CylinderGeometry(r * 0.2, r * 0.2, LANTERN_ARM_REACH, 6);
  arm.rotateX(Math.PI / 2); // cylinder axis +y → +z
  arm.translate(0, top - r * 0.3, -LANTERN_ARM_REACH / 2);
  // and a short drop at its tip, so the cord reads as seized to iron
  const hook = new THREE.CylinderGeometry(r * 0.16, r * 0.16, r * 0.9, 6);
  hook.translate(0, top - r * 0.3 - r * 0.45, -LANTERN_ARM_REACH);
  return mergeNonIndexed([shaft, cap, arm, hook]);
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
    case 'wheel-disc':
      return buildWheelDiscGeometry(aabb);
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
      // hoops, woolding and a partner collar at the deck (§T.34)
      return buildMastGeometry(aabb, 0.45, { partners: true });
    case 'bowsprit':
      // banded like a mast, but it passes through no deck, so no collar
      return buildMastGeometry(aabb, 0.4);
    case 'yard':
      return buildYardGeometry(aabb);
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
        : buildRailGeometry(aabb, shape);
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
    // --- RAFT 2100 (§T89)
    case 'log':
      return buildLogGeometry(aabb, shape);
    case 'crossbeam':
      return buildCrossbeamGeometry(aabb, shape);
    case 'bipod-mast':
      return buildPoleGeometry(aabb, shape);
    case 'cabin-wall':
      return buildCabinWallGeometry(aabb, shape);
    case 'stern-block':
      return buildSternBlockGeometry(aabb, shape);
    case 'steering-oar':
      return buildSteeringOarGeometry(aabb, shape);
    case 'crate':
      return buildCrateGeometry(aabb, shape);
    case 'bamboo-deck':
    case 'thatch-roof':
    case 'guara':
    case 'splashboard':
      return buildRaftSlabGeometry(aabb);
  }
}
