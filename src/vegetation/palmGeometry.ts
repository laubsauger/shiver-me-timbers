/**
 * Procedural palm geometry (T26). Deterministic per seed (§V2-adjacent:
 * seeded visuals must be pure f(seed, params) — createRng only, never
 * Math.random). Shape tunables come from params/vegetation (§V16).
 *
 * One palm = curved tapered trunk swept along a quadratic bend curve,
 * 6-10 creased frond strips drooping from the crown, optional coconut
 * cluster. Bakes the vertex attributes the wind shader (windSway.ts)
 * contractually needs:
 *   windWeight  — 0 at trunk base → 1 at frond tips (sway ∝ weight²)
 *   phaseOffset — per frond/coconut so parts don't sway in unison
 *   role        — 0 trunk, 1 frond, 2 coconut (palmMaterial tinting)
 * Geometry only: no materials, no renderer — safe to import in node tests.
 */
import * as THREE from 'three/webgpu';
import { createRng, type Rng } from '../state/rng';
import { vegetationParams, type VegetationParams } from '../params/vegetation';

/** roles baked into the `role` attribute */
export const PALM_ROLE = { trunk: 0, frond: 1, coconut: 2 } as const;

/** frond cross-section: 7 verts = 3 each side of a raised midrib */
const FROND_CROSS_VERTS = 7;
/** coconut sphere tessellation (lat rings × long segments) */
const COCONUT_RINGS = 4;
const COCONUT_SEGMENTS = 6;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

interface GeoBuilder {
  positions: number[];
  uvs: number[];
  windWeights: number[];
  phases: number[];
  roles: number[];
  /** vertex − crown, for the per-instance crown reshape (see palmShape.ts) */
  crownOffsets: number[];
  /** 0..1 up the trunk; exactly 1 for anything hanging off the crown */
  stems: number[];
  indices: number[];
}

/**
 * `crownOffset` and `stemT` are the two attributes that let ONE palm mesh be
 * many different palms.
 *
 * The geometry is built once per island and every instance shares it, so all
 * the variation there can be has to come through the instance — and an instance
 * matrix is affine, which is why widening its ranges bought scale and lean and
 * could never buy SHAPE. Splitting each vertex into "where the crown is" plus
 * "where this vertex is relative to the crown" is enough to make the crown
 * reshapeable in the vertex stage: scale the offset's y and you have a weeping
 * palm or a perky one, scale its xz and you have a wide crown or a tight one,
 * and `stemT²` carries a static trunk curve that the fronds ride along with.
 * All of it per instance, all in the vertex stage, at ONE draw call.
 */
function pushVert(
  b: GeoBuilder,
  x: number, y: number, z: number,
  u: number, v: number,
  windWeight: number, phase: number, role: number,
  cox: number, coy: number, coz: number, stemT: number,
): number {
  const i = b.positions.length / 3;
  b.positions.push(x, y, z);
  b.uvs.push(u, v);
  b.windWeights.push(windWeight);
  b.phases.push(phase);
  b.roles.push(role);
  b.crownOffsets.push(cox, coy, coz);
  b.stems.push(stemT);
  return i;
}

/** grid of (rows+1)×(cols+1) verts already pushed row-major → two tris/cell */
function pushGridIndices(b: GeoBuilder, first: number, rows: number, cols: number): void {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = first + r * (cols + 1) + c;
      const d = a + cols + 1;
      b.indices.push(a, d, a + 1, a + 1, d, d + 1);
    }
  }
}

interface Crown { x: number; y: number; z: number }

function buildTrunk(b: GeoBuilder, rng: Rng, p: VegetationParams): Crown {
  const height = lerp(p.heightMin, p.heightMax, rng());
  const bendAngle = rng() * Math.PI * 2;
  const bend = p.trunkBend * lerp(0.6, 1.2, rng());
  const bx = Math.cos(bendAngle);
  const bz = Math.sin(bendAngle);
  const rows = p.trunkSegments;
  const cols = p.trunkRadialSegments;
  const first = b.positions.length / 3;
  for (let r = 0; r <= rows; r++) {
    const t = r / rows;
    const lateral = bend * t * t; // quadratic bend curve
    const cx = bx * lateral;
    const cy = height * t;
    const cz = bz * lateral;
    // taper with a chunky base flare (stylized ref proportions)
    const flare = 1 + 0.5 * (1 - t) ** 3;
    const radius = lerp(p.trunkBaseRadius, p.trunkTopRadius, t) * flare;
    const weight = p.trunkTopWindWeight * t * t; // exactly 0 at the base ring
    for (let c = 0; c <= cols; c++) {
      const a = (c / cols) * Math.PI * 2;
      pushVert(
        b,
        cx + Math.cos(a) * radius, cy, cz + Math.sin(a) * radius,
        c / cols, t,
        weight, 0, PALM_ROLE.trunk,
        // trunk verts have no crown offset; `stemT` is their height fraction,
        // which is what carries the per-instance curve (see palmShape.ts)
        0, 0, 0, t,
      );
    }
  }
  pushGridIndices(b, first, rows, cols);
  return { x: bx * bend, y: height, z: bz * bend };
}

/**
 * One frond.
 *
 * THE ASYMMETRY IS THE POINT (user: the palms are "very, very sad"). The
 * previous version drew every frond from the same narrow ranges — pitch
 * 0.30-0.85, length ×0.85-1.15, droop ×0.8-1.2 — and swept them at exactly
 * `2π/n` around the crown with a jitter that could only ever be POSITIVE and
 * never exceeded one slot. The result is an umbrella: n near-identical arms at
 * near-identical angles. A real crown has fronds at every stage of its life,
 * some new and near-vertical, some old and hanging below horizontal, and they
 * are not evenly spaced because the old ones have fallen.
 *
 * Three terms widened or added:
 *  - PITCH now runs from well above to slightly BELOW horizontal, so a crown
 *    contains both spikes and hangers.
 *  - SWEEP: the midrib curves sideways as well as down. A frond is not planar
 *    and the old one was, which is most of why the crowns read as a fan.
 *  - ROLL: the V-crease is rotated about the midrib, so the fold does not sit
 *    in the vertical plane on every single frond.
 */
function buildFrond(
  b: GeoBuilder, rng: Rng, p: VegetationParams, crown: Crown, yaw: number,
): void {
  const phase = rng() * Math.PI * 2;
  // −0.15 reaches below horizontal: the old fronds in the references hang
  const pitch = lerp(-0.15, 1.0, rng() ** 0.85);
  const length = p.frondLength * lerp(0.68, 1.3, rng());
  const width = p.frondWidth * lerp(0.75, 1.25, rng());
  const droop = p.frondDroop * lerp(0.55, 1.6, rng());
  // lateral curve of the midrib, as a fraction of length, either hand
  const sweep = (rng() * 2 - 1) * p.frondSweep;
  const roll = (rng() * 2 - 1) * p.frondRoll;
  const dx = Math.cos(yaw);
  const dz = Math.sin(yaw);
  const sx = -dz; // horizontal side vector
  const sz = dx;
  const rows = p.frondSegments;
  const cols = FROND_CROSS_VERTS - 1;
  const first = b.positions.length / 3;
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);
  const cosR = Math.cos(roll);
  const sinR = Math.sin(roll);
  for (let r = 0; r <= rows; r++) {
    const t = r / rows;
    // midrib curve: outward along yaw, rising then drooping quadratically,
    // and curving sideways — quadratic in t so the stem still leaves straight
    const lateral = sweep * length * t * t;
    const mx = crown.x + dx * cosP * length * t + sx * lateral;
    const my = crown.y + length * (sinP * t - droop * t * t);
    const mz = crown.z + dz * cosP * length * t + sz * lateral;
    // half-width: pinched at the stem, tapering to a point at the tip
    const hw = width * 0.5 * Math.sqrt(1 - t) * Math.min(1, 0.25 + t * 4);
    const weight = p.trunkTopWindWeight + (1 - p.trunkTopWindWeight) * t ** 1.3;
    for (let c = 0; c <= cols; c++) {
      const s = (c / cols) * 2 - 1; // -1..1 across the strip
      const foldDrop = Math.abs(s) * p.frondCrease * hw; // V-crease off the midrib
      // roll the (side, up) pair about the midrib so the fold is not vertical
      const across = s * hw * cosR - foldDrop * -sinR;
      const down = s * hw * sinR + foldDrop * cosR;
      const vx = mx + sx * across;
      const vy = my - down;
      const vz = mz + sz * across;
      pushVert(
        b,
        vx, vy, vz,
        (s + 1) * 0.5, t,
        weight, phase, PALM_ROLE.frond,
        vx - crown.x, vy - crown.y, vz - crown.z, 1,
      );
    }
  }
  pushGridIndices(b, first, rows, cols);
}

function buildCoconut(
  b: GeoBuilder, rng: Rng, p: VegetationParams, crown: Crown,
): void {
  const phase = rng() * Math.PI * 2;
  const radius = p.coconutRadius * lerp(0.85, 1.15, rng());
  const a = rng() * Math.PI * 2;
  const cx = crown.x + Math.cos(a) * p.trunkTopRadius * 1.6;
  const cy = crown.y - radius * lerp(0.6, 1.2, rng());
  const cz = crown.z + Math.sin(a) * p.trunkTopRadius * 1.6;
  const first = b.positions.length / 3;
  for (let r = 0; r <= COCONUT_RINGS; r++) {
    const vLat = r / COCONUT_RINGS;
    const lat = vLat * Math.PI;
    for (let c = 0; c <= COCONUT_SEGMENTS; c++) {
      const lon = (c / COCONUT_SEGMENTS) * Math.PI * 2;
      const vx = cx + Math.sin(lat) * Math.cos(lon) * radius;
      const vy = cy + Math.cos(lat) * radius;
      const vz = cz + Math.sin(lat) * Math.sin(lon) * radius;
      pushVert(
        b,
        vx, vy, vz,
        c / COCONUT_SEGMENTS, vLat,
        p.trunkTopWindWeight, phase, PALM_ROLE.coconut,
        // a nut rides the crown, but must NOT be stretched by the crown
        // reshape or it would go ovoid — palmShape.ts masks it off by role
        vx - crown.x, vy - crown.y, vz - crown.z, 1,
      );
    }
  }
  pushGridIndices(b, first, COCONUT_RINGS, COCONUT_SEGMENTS);
}

/**
 * Build one palm. Same (seed, params) → byte-identical buffers. Attributes:
 * position, normal (computed), uv, windWeight, phaseOffset, role.
 */
export function buildPalmGeometry(
  seed: number,
  p: VegetationParams = vegetationParams,
): THREE.BufferGeometry {
  const rng = createRng(seed);
  const b: GeoBuilder = {
    positions: [], uvs: [], windWeights: [], phases: [], roles: [],
    crownOffsets: [], stems: [], indices: [],
  };

  const crown = buildTrunk(b, rng, p);

  const frondCount = p.frondsMin + Math.floor(rng() * (p.frondsMax - p.frondsMin + 1));
  for (let f = 0; f < frondCount; f++) {
    // SYMMETRIC jitter of up to a full slot either way. The old form was
    // `+ rng() · π/frondCount` — strictly positive and at most HALF a slot, so
    // the fronds could shuffle but never actually leave their even spacing.
    // A crown that has dropped a few fronds has real gaps in it.
    const yaw =
      (f / frondCount) * Math.PI * 2 + (rng() * 2 - 1) * ((Math.PI * 2) / frondCount) * 0.6;
    buildFrond(b, rng, p, crown, yaw);
  }

  if (rng() < p.coconutChance) {
    const coconuts = 2 + Math.floor(rng() * 3);
    for (let i = 0; i < coconuts; i++) buildCoconut(b, rng, p, crown);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(b.positions), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(b.uvs), 2));
  geometry.setAttribute('windWeight', new THREE.BufferAttribute(new Float32Array(b.windWeights), 1));
  geometry.setAttribute('phaseOffset', new THREE.BufferAttribute(new Float32Array(b.phases), 1));
  geometry.setAttribute('role', new THREE.BufferAttribute(new Float32Array(b.roles), 1));
  geometry.setAttribute('crownOffset', new THREE.BufferAttribute(new Float32Array(b.crownOffsets), 3));
  geometry.setAttribute('stemT', new THREE.BufferAttribute(new Float32Array(b.stems), 1));
  geometry.setIndex(b.indices);
  geometry.computeVertexNormals();
  return geometry;
}
