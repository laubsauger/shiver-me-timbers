/**
 * Lofted hull geometry (T8 visual pass, §V22): pointed stem, rounded
 * transom, sheer curve rising fore+aft, tumblehome above the bilge.
 * Pure functions of the piece's serializable `shape` hints (§V18) — the
 * piece GRAPH is untouched, only the geometry inside pieces changed.
 * Ship-space loft, translated into piece-local at the end.
 */
import * as THREE from 'three';
import type { AABB } from './pieceTypes';

/** shape hints every hull-family piece carries (all plain numbers, §V18) */
export interface HullShape {
  side: number; // -1 port, +1 starboard, 0 = both (bow piece)
  z0: number; // ship-space span of this piece
  z1: number;
  beamHalf: number;
  bowZ: number; // z of the stem point
  sternZ: number; // z of the transom
  draft: number;
  freeboard: number;
  sheerBow: number;
  sheerStern: number;
  tumblehome: number;
  keelPinch: number;
}

export function asHullShape(shape: Record<string, number> | undefined): HullShape | null {
  if (shape === undefined || shape.beamHalf === undefined) return null;
  return shape as unknown as HullShape;
}

/** plan-view half-breadth multiplier: 1 amidships → 0 at the stem,
 *  rounded in to ~0.55 at the transom */
export function hullEnvelope(z: number, s: HullShape): number {
  const bowStart = s.bowZ * 0.3;
  const sternStart = s.sternZ * 0.55;
  if (z >= bowStart) {
    const v = Math.max(0, (s.bowZ - z) / (s.bowZ - bowStart));
    return Math.pow(v, 0.72); // convex waterlines → pointed stem
  }
  if (z <= sternStart) {
    const w = Math.max(0, (z - s.sternZ) / (sternStart - s.sternZ));
    return 0.55 + 0.45 * Math.pow(w, 0.65); // rounded stern quarters
  }
  return 1;
}

/** rail rise toward bow/stern (sheer curve) */
export function hullSheer(z: number, s: HullShape): number {
  const fore = Math.max(0, z) / s.bowZ;
  const aft = Math.max(0, -z) / -s.sternZ;
  return s.sheerBow * fore * fore + s.sheerStern * aft * aft;
}

/** cross-section half-width at height fraction h (0 keel → 1 rail):
 *  pinched keel, round bilge widest near the waterline, tumblehome above */
function sectionHalf(env: number, h: number, s: HullShape): number {
  const hMax = 0.6;
  if (h <= hMax) {
    const t = h / hMax;
    const bilge = Math.sin((t * Math.PI) / 2);
    return env * (s.keelPinch + (1 - s.keelPinch) * Math.pow(bilge, 0.8));
  }
  const t = (h - hMax) / (1 - hMax);
  return env * (1 - s.tumblehome * t * t);
}

const Z_SLICES = 12;
const H_STEPS = 8;

/** one side shell strip over [z0,z1] in SHIP space (indexed grid) */
function sideStrip(s: HullShape, side: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= Z_SLICES; i++) {
    const z = s.z0 + ((s.z1 - s.z0) * i) / Z_SLICES;
    const env = hullEnvelope(z, s);
    const topY = s.freeboard + hullSheer(z, s);
    for (let j = 0; j <= H_STEPS; j++) {
      const h = j / H_STEPS;
      positions.push(side * s.beamHalf * sectionHalf(env, h, s), -s.draft + (topY + s.draft) * h, z);
      uvs.push(i / Z_SLICES, h);
    }
  }
  const row = H_STEPS + 1;
  for (let i = 0; i < Z_SLICES; i++) {
    for (let j = 0; j < H_STEPS; j++) {
      const a = i * row + j;
      const b = (i + 1) * row + j;
      // wind so the face normal points outboard (±x) for each side
      if (side >= 0) indices.push(a, a + 1, b, b, a + 1, b + 1);
      else indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** one hull side section, translated into piece-local (origin x=0, z=center) */
export function buildLoftedHullSection(s: HullShape): THREE.BufferGeometry {
  const geo = sideStrip(s, s.side);
  geo.translate(0, 0, -(s.z0 + s.z1) / 2);
  return geo;
}

/** beakhead deck plate: closes the bow triangle between the shell tops,
 *  following the plan envelope to the stem point under the bowsprit */
function bowDeckStrip(s: HullShape): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= Z_SLICES; i++) {
    const z = s.z0 + ((s.z1 - s.z0) * i) / Z_SLICES;
    const hw = s.beamHalf * hullEnvelope(z, s) * 0.99;
    const y = s.freeboard + hullSheer(z, s) - 0.04;
    positions.push(-hw, y, z, hw, y, z);
    uvs.push(i / Z_SLICES, 0, i / Z_SLICES, 1);
  }
  for (let i = 0; i < Z_SLICES; i++) {
    const a = i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); // faces up (+y)
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** bow: both side strips continuing the loft to the stem point, plus the
 *  beakhead deck plate so there is no opening under the bowsprit (§V22) */
export function buildLoftedBow(s: HullShape): THREE.BufferGeometry {
  const starboard = sideStrip(s, 1);
  const port = sideStrip(s, -1);
  const deck = bowDeckStrip(s);
  const merged = mergeStrips([starboard, port, deck]);
  merged.translate(0, 0, -s.z0); // bow piece origin sits at hull end
  return merged;
}

/** local index-preserving merge (both strips share attribute layout) */
function mergeStrips(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let offset = 0;
  for (const g of geos) {
    const pos = g.getAttribute('position');
    const uv = g.getAttribute('uv');
    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      uvs.push(uv.getX(i), uv.getY(i));
    }
    const idx = g.getIndex();
    if (idx) for (let i = 0; i < idx.count; i++) indices.push(idx.getX(i) + offset);
    offset += pos.count;
    g.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** deck outline following the hull envelope (plan view), piece-local */
export function buildEnvelopeDeck(aabb: AABB, s: HullShape): THREE.BufferGeometry {
  const thickness = aabb.max[1] - aabb.min[1];
  const shape = new THREE.Shape();
  const slices = 16;
  const at = (i: number): [number, number] => {
    const z = s.z0 + ((s.z1 - s.z0) * i) / slices;
    return [s.beamHalf * hullEnvelope(z, s) * 0.98, z];
  };
  const [x0, z0] = at(0);
  shape.moveTo(-x0, z0);
  shape.lineTo(x0, z0);
  for (let i = 1; i <= slices; i++) {
    const [x, z] = at(i);
    shape.lineTo(x, z);
  }
  for (let i = slices; i >= 0; i--) {
    const [x, z] = at(i);
    shape.lineTo(-x, z);
  }
  const geo = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
  geo.rotateX(Math.PI / 2); // extrusion (+z) → downward: deck top at y=0
  return geo;
}
