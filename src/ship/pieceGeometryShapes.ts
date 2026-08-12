/**
 * Shaped greybox geometry: hull panels, deck outline, bow wedge, sails.
 * Sized purely from the piece AABB so any blueprint dimension works
 * (§V.18: geometry is a swappable view over piece data).
 */
import * as THREE from 'three';
import type { AABB } from './pieceTypes';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

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
 * Thin cylinder spanning two points — the primitive every rope-ish and
 * bar-ish fitting is made of (ratline rungs, lanyards, head rails, straps).
 * Degenerate spans are dropped to a zero-length stub rather than producing a
 * NaN orientation (§V28 in spirit: no non-finite vertex ever reaches a buffer).
 */
export function barBetween(
  a: THREE.Vector3,
  b: THREE.Vector3,
  radius: number,
  sides = 5,
): THREE.BufferGeometry {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const geo = new THREE.CylinderGeometry(radius, radius, Math.max(1e-4, len), sides, 1, true);
  if (len > 1e-5) {
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      dir.divideScalar(len),
    );
    geo.applyQuaternion(q);
  }
  geo.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return geo;
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
