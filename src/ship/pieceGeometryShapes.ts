/**
 * Shaped greybox geometry: hull panels, deck outline, bow wedge, sails.
 * Sized purely from the piece AABB so any blueprint dimension works
 * (§V.18: geometry is a swappable view over piece data).
 */
import * as THREE from 'three';
import type { AABB, SailStateId } from './pieceTypes';
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
 * Sail per trim state (docs/ship-side-sails-fully-reefed.png):
 * full = flat cloth panel, reefed = roll at the yard + short skirt,
 * furled = tight roll only. Top edge hangs at y≈0 (the yard line).
 *
 * The BELLY IS NO LONGER BAKED IN: sailMaterial.ts bulges and flutters the
 * cloth per frame from the live wind (§V22 "sails appear too static"). Every
 * part carries a `sailShape` attribute = (clothWeight, width, drop) so the
 * one shared cloth material knows which vertices are cloth (weight 1) and
 * which are hardware — robands, the furled roll — that must not move.
 */
/** tag a part with (clothWeight, width, drop) for the cloth shader */
function withSailShape(
  geo: THREE.BufferGeometry,
  weight: number,
  width: number,
  drop: number,
): THREE.BufferGeometry {
  const count = geo.attributes.position.count;
  const data = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    data[i * 3] = weight;
    data[i * 3 + 1] = width;
    data[i * 3 + 2] = drop;
  }
  geo.setAttribute('sailShape', new THREE.BufferAttribute(data, 3));
  return geo;
}

/** robands: short tie loops lashing the cloth to its yard (y≈0) */
function sailTies(width: number, drop: number): THREE.BufferGeometry[] {
  const ties: THREE.BufferGeometry[] = [];
  const count = 7;
  for (let i = 0; i < count; i++) {
    const x = -width * 0.44 + (width * 0.88 * i) / (count - 1);
    const tie = new THREE.CylinderGeometry(0.035, 0.035, 0.36, 5);
    tie.translate(x, 0.08, 0);
    ties.push(withSailShape(tie, 0, width, drop));
  }
  return ties;
}

export function buildSailGeometry(state: SailStateId, aabb: AABB): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const width = s.x;
  const drop = -aabb.min[1];
  if (state === 'full') {
    // flat panel; the material owns the shape. Segmented enough (16×12) that
    // the shader billow and the luff ripple read smooth.
    const geo = new THREE.PlaneGeometry(width, drop, 16, 12);
    geo.translate(0, -drop / 2, 0);
    return mergeNonIndexed([
      withSailShape(geo, 1, width, drop),
      ...sailTies(width, drop),
    ]);
  }
  const rollRadius = Math.max(0.15, drop * 0.05) * (state === 'furled' ? 0.7 : 1.15);
  const roll = new THREE.CylinderGeometry(rollRadius, rollRadius, width * 0.96, 8);
  roll.rotateZ(Math.PI / 2); // axis along the yard (x)
  withSailShape(roll, 0, width, drop);
  if (state === 'furled') return mergeNonIndexed([roll, ...sailTies(width, drop)]);
  // reefed: rolled bundle plus a short hanging skirt of cloth that still
  // stirs in the wind (its own drop keeps the motion in scale)
  const skirtDrop = drop * 0.22;
  const skirt = new THREE.PlaneGeometry(width * 0.9, skirtDrop, 8, 3);
  skirt.translate(0, -skirtDrop / 2 - rollRadius * 0.5, 0);
  withSailShape(skirt, 1, width * 0.9, skirtDrop);
  return mergeNonIndexed([roll, skirt, ...sailTies(width, drop)]);
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
