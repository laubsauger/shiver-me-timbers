/**
 * Low-poly conifer geometry (§T.99) — Jeffrey pine / juniper / dead snag, plus
 * the SHARED low-poly builder every sierra plant is assembled from
 * (juniperGeometry.ts, manzanitaGeometry.ts, §T.112e). Deterministic per seed
 * (§V2-adjacent: createRng only). Geometry only: no materials, no renderer —
 * safe in node tests.
 *
 * One tree = a tapered 6-sided trunk + 3–4 stacked cone tiers (pine), two wide
 * low tiers on a stub (juniper), or a bare trunk with a few drooping branch
 * prisms (dead — the treetops breaking the surface to leeward of a drowned
 * ridge). Budget ≤ 300 triangles (pinned by tests/sierra.test.ts): a stand of
 * 60 on a 250 m island is one instanced draw, and at the 1.4 km palm cull a
 * tier cone is a few pixels.
 *
 * Bakes the attributes the wind shader (windSway.ts) contractually reads:
 *   windWeight  — 0 at the trunk base → ~1 at the top tier (sway ∝ weight²)
 *   phaseOffset — per tier / per branch so the crown does not move as one
 *   role        — 0 trunk, 1 pine needles, 2 dead wood, 3 juniper needles,
 *                 4 manzanita leaf, 5 manzanita stem (pineScatter.ts's
 *                 material tints by role)
 *
 * CLUSTER NORMALS ARE BAKED HERE, NOT SHADED (§T.112e, research §2 foliage).
 * A cone tier lit by its own facet normals reads as a cone — the giveaway that
 * makes low-poly foliage look like folded card. Production foliage blends the
 * surface normal toward the normal of the CANOPY VOLUME the leaf belongs to,
 * so a clump lights as one soft mass. That blend depends on nothing but the
 * mesh, so it is a bake: `markCluster` records which canopy sphere each vertex
 * belongs to and `finishGeometry` writes the blended normal into the `normal`
 * attribute. Zero shader cost, and it is a pure function the CPU tests can
 * read (see foliage.ts / tests/sierraVegetation.test.ts).
 */
import * as THREE from 'three/webgpu';
import { createRng, type Rng } from '../state/rng';
import { sierraParams, type SierraParams } from '../params/sierra';
import { applyClusterNormals } from './foliage';

export const PINE_ROLE = {
  trunk: 0,
  needles: 1,
  deadWood: 2,
  juniper: 3,
  manzanitaLeaf: 4,
  manzanitaStem: 5,
} as const;
export type PineVariant = 'pine' | 'juniper' | 'dead';

const TRUNK_SIDES = 6;
const TRUNK_RINGS = 3;
const TIER_SIDES = 8;
const BRANCH_SIDES = 3;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export interface GeoBuilder {
  positions: number[];
  uvs: number[];
  windWeights: number[];
  phases: number[];
  roles: number[];
  /** canopy-sphere centre this vertex belongs to (3 per vertex) */
  centers: number[];
  /** 0 = wood (keep the facet normal), 1 = foliage (blend to the canopy) */
  clusterW: number[];
  indices: number[];
}

export const newGeoBuilder = (): GeoBuilder => ({
  positions: [],
  uvs: [],
  windWeights: [],
  phases: [],
  roles: [],
  centers: [],
  clusterW: [],
  indices: [],
});

export function pushVert(
  b: GeoBuilder,
  x: number, y: number, z: number,
  u: number, v: number,
  wind: number, phase: number, role: number,
): number {
  b.positions.push(x, y, z);
  b.uvs.push(u, v);
  b.windWeights.push(wind);
  b.phases.push(phase);
  b.roles.push(role);
  b.centers.push(0, 0, 0);
  b.clusterW.push(0);
  return b.positions.length / 3 - 1;
}

/**
 * Tag vertices [first, end) as belonging to one canopy sphere centred at
 * (cx, cy, cz). `weight` 1 = full cluster normal, 0 = leave the facet normal.
 */
export function markCluster(
  b: GeoBuilder,
  first: number,
  cx: number, cy: number, cz: number,
  weight = 1,
): void {
  for (let i = first; i < b.positions.length / 3; i++) {
    b.centers[i * 3] = cx;
    b.centers[i * 3 + 1] = cy;
    b.centers[i * 3 + 2] = cz;
    b.clusterW[i] = weight;
  }
}

/** a tapered tube along +y from y0 to y1, capped at the top */
export function pushTube(
  b: GeoBuilder,
  x: number, z: number,
  y0: number, y1: number,
  r0: number, r1: number,
  sides: number, rings: number,
  height: number,
  role: number, phase: number, windTop: number,
  lean: [number, number] = [0, 0],
): void {
  const first = b.positions.length / 3;
  for (let j = 0; j <= rings; j++) {
    const t = j / rings;
    const y = lerp(y0, y1, t);
    const r = lerp(r0, r1, t);
    const lx = x + lean[0] * t;
    const lz = z + lean[1] * t;
    const wind = windTop * Math.pow(y / Math.max(height, 1e-3), 2);
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      pushVert(b, lx + Math.cos(a) * r, y, lz + Math.sin(a) * r, i / sides, y / height, wind, phase, role);
    }
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < sides; i++) {
      const a = first + j * sides + i;
      const bb = first + j * sides + ((i + 1) % sides);
      const c = a + sides;
      const d = bb + sides;
      b.indices.push(a, c, bb, bb, c, d);
    }
  }
  // top cap: a fan to a centre vertex
  const top = pushVert(b, x + lean[0], y1, z + lean[1], 0.5, y1 / height, windTop, phase, role);
  const ringStart = first + rings * sides;
  for (let i = 0; i < sides; i++) {
    b.indices.push(ringStart + i, top, ringStart + ((i + 1) % sides));
  }
}

/** one needle tier: a closed cone (apex + rim + bottom disc) */
function pushTier(
  b: GeoBuilder,
  y: number, radius: number, coneHeight: number,
  height: number, role: number, phase: number, wind: number,
): void {
  const apex = pushVert(b, 0, y + coneHeight, 0, 0.5, (y + coneHeight) / height, wind, phase, role);
  const bottom = pushVert(b, 0, y, 0, 0.5, y / height, wind * 0.8, phase, role);
  const rim: number[] = [];
  for (let i = 0; i < TIER_SIDES; i++) {
    const a = (i / TIER_SIDES) * Math.PI * 2;
    rim.push(pushVert(b, Math.cos(a) * radius, y, Math.sin(a) * radius, i / TIER_SIDES, y / height, wind, phase, role));
  }
  for (let i = 0; i < TIER_SIDES; i++) {
    const n = (i + 1) % TIER_SIDES;
    b.indices.push(rim[i], apex, rim[n]); // outward faces
    b.indices.push(rim[n], bottom, rim[i]); // underside
  }
}

/**
 * A squashed leaf lobe — the broad, rounded mass a juniper or a manzanita is
 * made of. Top half only (the underside is never seen and doubles the count).
 */
export function pushLobe(
  b: GeoBuilder,
  cx: number, cy: number, cz: number,
  radius: number, squash: number,
  rings: number, segments: number,
  height: number, role: number, phase: number, wind: number,
): void {
  const first = b.positions.length / 3;
  const inv = 1 / Math.max(height, 1e-3); // §V28
  // ONE apex vertex, then `rings` latitude rings. A full lat-0 ring would be
  // `segments` coincident vertices and `segments` zero-area triangles, which
  // is a quarter of a lobe's whole budget spent on nothing.
  const apex = pushVert(b, cx, cy + radius * squash, cz, 0.5, (cy + radius * squash) * inv, wind, phase, role);
  const ringStart = first + 1;
  for (let r = 1; r <= rings; r++) {
    const lat = (r / rings) * Math.PI * 0.5;
    const sy = Math.cos(lat);
    const sr = Math.sin(lat);
    for (let c = 0; c < segments; c++) {
      const lon = (c / segments) * Math.PI * 2;
      const vy = cy + sy * radius * squash;
      pushVert(b, cx + Math.cos(lon) * sr * radius, vy, cz + Math.sin(lon) * sr * radius, c / segments, vy * inv, wind, phase, role);
    }
  }
  for (let c = 0; c < segments; c++) {
    b.indices.push(ringStart + c, apex, ringStart + ((c + 1) % segments));
  }
  for (let r = 0; r < rings - 1; r++) {
    for (let c = 0; c < segments; c++) {
      const n = (c + 1) % segments;
      const a = ringStart + r * segments + c;
      const bb = ringStart + r * segments + n;
      const cc = a + segments;
      const d = bb + segments;
      b.indices.push(a, cc, bb, bb, cc, d);
    }
  }
  // the lobe IS a canopy sphere: this is exactly the cluster normals blend to
  markCluster(b, first, cx, cy, cz, 1);
}

/**
 * Close the builder into a geometry: position/uv/windWeight/phaseOffset/role,
 * computed facet normals, then the CLUSTER-NORMAL bake on top of them.
 */
export function finishGeometry(b: GeoBuilder, clusterBlend: number): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(b.positions), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(b.uvs), 2));
  geometry.setAttribute('windWeight', new THREE.BufferAttribute(new Float32Array(b.windWeights), 1));
  geometry.setAttribute('phaseOffset', new THREE.BufferAttribute(new Float32Array(b.phases), 1));
  geometry.setAttribute('role', new THREE.BufferAttribute(new Float32Array(b.roles), 1));
  geometry.setIndex(b.indices);
  geometry.computeVertexNormals();
  applyClusterNormals(geometry, Float32Array.from(b.centers), Float32Array.from(b.clusterW), clusterBlend);
  return geometry;
}

/**
 * Build one tree. Same (seed, variant, params) → byte-identical buffers.
 * Attributes: position, normal (facet + cluster blend), uv, windWeight,
 * phaseOffset, role.
 */
export function buildPineGeometry(
  seed: number,
  variant: PineVariant = 'pine',
  p: SierraParams = sierraParams,
): THREE.BufferGeometry {
  const rng: Rng = createRng(seed);
  const b = newGeoBuilder();

  if (variant === 'dead') {
    const h = p.deadPineHeight * lerp(0.85, 1.15, rng());
    const r = p.pineTrunkRadius * lerp(0.7, 1.0, rng());
    // a bare snag sways at the top like a mast: full weight at the tip
    pushTube(b, 0, 0, 0, h, r, r * 0.25, TRUNK_SIDES, TRUNK_RINGS, h, PINE_ROLE.deadWood, 0, 1);
    const branches = Math.max(0, Math.floor(p.deadBranchCount));
    for (let i = 0; i < branches; i++) {
      // branches sit on the upper two thirds, droop outward and a little down
      const y = h * lerp(0.4, 0.92, rng());
      const a = rng() * Math.PI * 2;
      const len = h * lerp(0.12, 0.28, rng());
      const droop = -len * lerp(0.1, 0.45, rng());
      const phase = rng() * Math.PI * 2;
      const wind = 0.3 + 0.7 * Math.pow(y / h, 2);
      const first = b.positions.length / 3;
      // a 3-sided prism from the trunk surface to a tip
      for (let s = 0; s < BRANCH_SIDES; s++) {
        const sa = (s / BRANCH_SIDES) * Math.PI * 2;
        const br = r * 0.35;
        pushVert(b, Math.cos(a) * r * 0.6 + Math.cos(sa) * br, y + Math.sin(sa) * br, Math.sin(a) * r * 0.6, 0, y / h, wind * 0.5, phase, PINE_ROLE.deadWood);
      }
      const tip = pushVert(b, Math.cos(a) * len, y + droop, Math.sin(a) * len, 1, y / h, wind, phase, PINE_ROLE.deadWood);
      for (let s = 0; s < BRANCH_SIDES; s++) {
        const n = (s + 1) % BRANCH_SIDES;
        b.indices.push(first + s, tip, first + n);
        b.indices.push(first + n, first + s, first + (s + 2) % BRANCH_SIDES);
      }
    }
  } else {
    const juniper = variant === 'juniper';
    const h = juniper
      ? lerp(p.pineHeightMin, p.pineHeightMax, rng()) * 0.42
      : lerp(p.pineHeightMin, p.pineHeightMax, rng());
    const trunkR = p.pineTrunkRadius * (juniper ? 1.2 : 1) * lerp(0.85, 1.15, rng());
    const tiers = juniper ? 2 : Math.round(lerp(p.pineTiersMin, p.pineTiersMax, rng()));
    const crownBase = juniper ? h * 0.12 : h * lerp(0.3, 0.42, rng());
    // trunk runs to just under the top tier's apex
    pushTube(b, 0, 0, 0, h * 0.93, trunkR, trunkR * 0.3, TRUNK_SIDES, TRUNK_RINGS, h, PINE_ROLE.trunk, 0, 0.45);
    const role = juniper ? PINE_ROLE.juniper : PINE_ROLE.needles;
    const spread = juniper ? p.pineTierSpread * 2.6 : p.pineTierSpread;
    const span = h - crownBase;
    // ONE canopy sphere for the whole crown, not one per tier: the tiers are a
    // construction, and the thing the light should see is a single soft cone
    // of needles. Its centre sits at the crown's midpoint.
    const crownFirst = b.positions.length / 3;
    for (let i = 0; i < tiers; i++) {
      const t = i / tiers;
      const y = crownBase + span * t;
      // tiers shrink toward the top; each overlaps the next so no gap shows
      const radius = h * spread * lerp(1, 0.3, t) * lerp(0.9, 1.1, rng());
      const coneHeight = (span / tiers) * (juniper ? 1.1 : 1.45);
      // the top tier's apex overshoots h by its overlap; the weight caps at 1
      const wind = Math.min(1, 0.35 + 0.65 * Math.pow((y + coneHeight) / h, 1.5));
      pushTier(b, y, radius, coneHeight, h, role, rng() * Math.PI * 2, wind);
    }
    markCluster(b, crownFirst, 0, crownBase + span * 0.5, 0, 1);
  }

  return finishGeometry(b, p.foliageClusterBlend);
}
