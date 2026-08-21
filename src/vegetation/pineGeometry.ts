/**
 * Low-poly conifer geometry (§T.99) — Jeffrey pine / juniper / dead snag.
 * Deterministic per seed (§V2-adjacent: createRng only). Geometry only: no
 * materials, no renderer — safe in node tests.
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
 *   role        — 0 trunk, 1 pine needles, 2 dead wood, 3 juniper needles
 *                 (pineScatter.ts's material tints by role)
 */
import * as THREE from 'three/webgpu';
import { createRng, type Rng } from '../state/rng';
import { sierraParams, type SierraParams } from '../params/sierra';

export const PINE_ROLE = { trunk: 0, needles: 1, deadWood: 2, juniper: 3 } as const;
export type PineVariant = 'pine' | 'juniper' | 'dead';

const TRUNK_SIDES = 6;
const TRUNK_RINGS = 3;
const TIER_SIDES = 8;
const BRANCH_SIDES = 3;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

interface GeoBuilder {
  positions: number[];
  uvs: number[];
  windWeights: number[];
  phases: number[];
  roles: number[];
  indices: number[];
}

function pushVert(
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
  return b.positions.length / 3 - 1;
}

/** a tapered tube along +y from y0 to y1, optionally capped at the top */
function pushTube(
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
 * Build one tree. Same (seed, variant, params) → byte-identical buffers.
 * Attributes: position, normal (computed), uv, windWeight, phaseOffset, role.
 */
export function buildPineGeometry(
  seed: number,
  variant: PineVariant = 'pine',
  p: SierraParams = sierraParams,
): THREE.BufferGeometry {
  const rng: Rng = createRng(seed);
  const b: GeoBuilder = { positions: [], uvs: [], windWeights: [], phases: [], roles: [], indices: [] };

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
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(b.positions), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(b.uvs), 2));
  geometry.setAttribute('windWeight', new THREE.BufferAttribute(new Float32Array(b.windWeights), 1));
  geometry.setAttribute('phaseOffset', new THREE.BufferAttribute(new Float32Array(b.phases), 1));
  geometry.setAttribute('role', new THREE.BufferAttribute(new Float32Array(b.roles), 1));
  geometry.setIndex(b.indices);
  geometry.computeVertexNormals();
  return geometry;
}
