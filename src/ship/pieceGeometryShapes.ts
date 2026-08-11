/**
 * Shaped greybox geometry: hull panels, deck outline, bow wedge, sails.
 * Sized purely from the piece AABB so any blueprint dimension works
 * (§V.18: geometry is a swappable view over piece data).
 */
import * as THREE from 'three';
import type { AABB, SailStateId } from './pieceTypes';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { shipMaterialParams } from '../params/ship';

export function aabbSize(aabb: AABB): THREE.Vector3 {
  return new THREE.Vector3(
    aabb.max[0] - aabb.min[0],
    aabb.max[1] - aabb.min[1],
    aabb.max[2] - aabb.min[2],
  );
}

export function aabbCenter(aabb: AABB): THREE.Vector3 {
  return new THREE.Vector3(
    (aabb.min[0] + aabb.max[0]) / 2,
    (aabb.min[1] + aabb.max[1]) / 2,
    (aabb.min[2] + aabb.max[2]) / 2,
  );
}

/** Side panel: trapezoid cross-section (narrower at keel), extruded along z. */
export function buildHullSectionGeometry(aabb: AABB): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const w = s.x;
  const shape = new THREE.Shape([
    new THREE.Vector2(-w / 2, aabb.max[1]),
    new THREE.Vector2(w / 2, aabb.max[1]),
    new THREE.Vector2(w * 0.225, aabb.min[1]),
    new THREE.Vector2(-w * 0.225, aabb.min[1]),
  ]);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: s.z, bevelEnabled: false });
  geo.translate(0, 0, aabb.min[2]);
  return geo;
}

/** Deck plank: hull outline (flat transom, curved sides, pointed bow). */
export function buildDeckGeometry(aabb: AABB): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const hb = s.x / 2;
  const sternZ = aabb.min[2];
  const bowZ = aabb.max[2];
  // shape XY = ship XZ; rotateX(π/2) maps shape (x, z') → world (x, 0, z')
  const shape = new THREE.Shape();
  shape.moveTo(-hb * 0.8, sternZ);
  shape.lineTo(hb * 0.8, sternZ);
  shape.quadraticCurveTo(hb, bowZ * 0.1, 0, bowZ);
  shape.quadraticCurveTo(-hb, bowZ * 0.1, -hb * 0.8, sternZ);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: s.y, bevelEnabled: false });
  geo.rotateX(Math.PI / 2); // extrusion (+z) → downward (−y): deck top at y=0
  return geo;
}

/** Stem wedge: triangle plan (point forward), extruded up. */
export function buildBowGeometry(aabb: AABB): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const shape = new THREE.Shape([
    new THREE.Vector2(-s.x / 2, 0),
    new THREE.Vector2(s.x / 2, 0),
    new THREE.Vector2(0, -s.z), // rotateX(−π/2) maps −shapeY → +z (forward)
  ]);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: s.y, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, aabb.min[1], 0);
  return geo;
}

/**
 * Sail per trim state (docs/ship-side-sails-fully-reefed.png):
 * full = billowed curved plane, reefed = roll at the yard + short skirt,
 * furled = tight roll only. Top edge hangs at y≈0 (the yard line).
 */
/** robands: short tie loops lashing the cloth to its yard (y≈0) */
function sailTies(width: number): THREE.BufferGeometry[] {
  const ties: THREE.BufferGeometry[] = [];
  const count = 7;
  for (let i = 0; i < count; i++) {
    const x = -width * 0.44 + (width * 0.88 * i) / (count - 1);
    const tie = new THREE.CylinderGeometry(0.035, 0.035, 0.32, 5);
    tie.translate(x, 0.06, 0);
    ties.push(tie);
  }
  return ties;
}

export function buildSailGeometry(state: SailStateId, aabb: AABB): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const width = s.x;
  const drop = -aabb.min[1];
  if (state === 'full') {
    const geo = new THREE.PlaneGeometry(width, drop, 14, 10);
    geo.translate(0, -drop / 2, 0);
    // belly bulges downwind (+z = toward the bow, wind astern), fullest
    // near the free foot, pinned at the yard (v=1) and at both leeches.
    // sin² across / smoothstep down → ZERO slope at every edge, so edge
    // normals stay face-on (kills the dark rim the review flagged).
    const billow = drop * shipMaterialParams.sailBillow;
    const smooth01 = (x: number): number => {
      const t = Math.min(1, Math.max(0, x));
      return t * t * (3 - 2 * t);
    };
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const u = pos.getX(i) / width + 0.5;
      const v = (pos.getY(i) + drop) / drop; // 0 = foot, 1 = head
      const belly = Math.sin(Math.PI * u) ** 2 * smooth01((1 - v) / 0.9);
      pos.setZ(i, billow * belly);
    }
    geo.computeVertexNormals();
    return mergeNonIndexed([geo, ...sailTies(width)]);
  }
  const rollRadius = Math.max(0.15, drop * 0.05) * (state === 'furled' ? 0.7 : 1.15);
  const roll = new THREE.CylinderGeometry(rollRadius, rollRadius, width * 0.96, 8);
  roll.rotateZ(Math.PI / 2); // axis along the yard (x)
  if (state === 'furled') return mergeNonIndexed([roll, ...sailTies(width)]);
  // reefed: rolled bundle plus a short hanging skirt of cloth
  const skirtDrop = drop * 0.22;
  const skirt = new THREE.PlaneGeometry(width * 0.9, skirtDrop, 6, 2);
  skirt.translate(0, -skirtDrop / 2 - rollRadius * 0.5, 0);
  return mergeNonIndexed([roll, skirt, ...sailTies(width)]);
}

/** merge helper — normalises indexed/non-indexed before merging */
export function mergeNonIndexed(geos: THREE.BufferGeometry[], useGroups = false): THREE.BufferGeometry {
  const flat = geos.map((g) => {
    const ni = g.index !== null ? g.toNonIndexed() : g;
    if (ni !== g) g.dispose();
    return ni;
  });
  const merged = mergeGeometries(flat, useGroups);
  for (const g of flat) g.dispose();
  if (merged === null) throw new Error('geometry merge failed');
  return merged;
}
