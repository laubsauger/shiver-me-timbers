/**
 * Island rock outcrops (T20): icosahedra deformed by CPU noise, scattered on
 * the beach ring and waterline with T27's rockMaterial. Deterministic per
 * seed (§V2-adjacent: createRng only). Tunables in params/island.ts (§V16).
 *
 * T13 SOCKET (intersection foam, §V10): rocks that straddle the waterline are
 * tagged `mesh.userData.foamTarget = true`. T13's water-material depth-compare
 * pass should treat every scene mesh with that flag as an intersection-foam
 * target (foam ring where the hull/rock pierces the water). Nothing else is
 * built here — no foam RT, no depth mask.
 *
 * generateRockPlacements + deformRockGeometry are material-free so tests
 * verify placement/determinism without a renderer; createRocks assembles
 * meshes and (lazily-compiling) material.
 */
import * as THREE from 'three/webgpu';
import { createRng } from '../state/rng';
import { fbm2Cpu } from '../terrain/noiseCpu';
import { createRockMaterial, type RockMaterialHandle } from '../terrain';
import { islandParams, type IslandParams } from '../params/island';
import { sierraParams, type SierraParams } from '../params/sierra';
import { findShoreRadius, gradientAt, type IslandHeightmap } from './heightmap';
import { createSierraRockMaterial } from './sierraMaterial';
import { horizonMapFor } from './horizonMap';

export interface RockPlacement {
  /** island-local; y = terrain height + partial embed */
  position: [number, number, number];
  /** uniform xz scale (unit icosahedron radius 1 → rock radius ≈ scale) */
  scale: number;
  /** vertical squash: rock half-height ≈ scale × squash */
  squash: number;
  /**
   * z/x footprint ratio. A granite mass is never round in plan — the
   * references are whale-backs and loaves, and a scatter of spheres at
   * different sizes still reads as one shape repeated (§V43).
   */
  aspect: number;
  /** yaw (rad) */
  yaw: number;
  /** tilt off vertical (rad) + its azimuth — bedding planes are not level */
  tilt: number;
  tiltDir: number;
  /** index into the shared deformed-geometry variants */
  variant: number;
  /** straddles the waterline → T13 intersection-foam target (§V10) */
  foamTarget: boolean;
  /** true for the big headland masses, false for the boulder scatter */
  cliff: boolean;
  /** §T.112a: where a sierra boulder came from (undefined on the shore scatter) */
  origin?: 'convex' | 'erratic';
}

/** seeded stream for the inland scatter — after the shore loops, so pirate bytes never move */
const INLAND_SEED_OFFSET = 3391;
/** curvature probe stride in cells — resolution, not a look tunable */
const INLAND_PROBE_STRIDE = 2;

/**
 * −Laplacian of h at an island-local point (1/m): > 0 on a convex cell (a
 * rib, a shoulder, a dome crest), < 0 in a hollow. Central differences on
 * `heightAt`, the same truth `gradientAt` reads, at the grid's own spacing.
 */
export function convexityAt(hm: IslandHeightmap, x: number, z: number): number {
  const eps = (2 * hm.worldRadius) / (hm.size - 1);
  const h0 = hm.heightAt(x, z);
  const lap =
    (hm.heightAt(x + eps, z) + hm.heightAt(x - eps, z) + hm.heightAt(x, z + eps) + hm.heightAt(x, z - eps) - 4 * h0) /
    (eps * eps);
  return -lap;
}

/** inland = above the apron AND inside the shore radius by the DG band */
function isInland(hm: IslandHeightmap, x: number, z: number, sp: SierraParams): boolean {
  if (hm.heightAt(x, z) < sp.boulderMinHeight) return false;
  const angle = Math.atan2(z, x);
  return Math.hypot(x, z) < findShoreRadius(hm, angle) - sp.dgSandBand;
}

/**
 * §T.112a, research D9: the shore ring was the only place a rock could be.
 * On a granite dome the boulders are on the CONVEX, STEEP ground — ribs and
 * shoulders that shed their sheets — plus a few glacial ERRATICS dropped on
 * the flat treads. Sierra islands only (`hm.sierra`), a separate rng stream,
 * and pushed after the shore scatter, so every pirate placement is
 * byte-identical to before.
 */
export function generateInlandPlacements(
  seed: number,
  hm: IslandHeightmap,
  p: IslandParams = islandParams,
  sp: SierraParams = sierraParams,
): RockPlacement[] {
  if (!hm.sierra) return [];
  const rng = createRng(seed + INLAND_SEED_OFFSET);
  const R = hm.worldRadius;
  const cell = (2 * R) / (hm.size - 1);
  const convex: [number, number][] = [];
  const treads: [number, number][] = [];
  for (let iz = 1; iz < hm.size - 1; iz += INLAND_PROBE_STRIDE) {
    for (let ix = 1; ix < hm.size - 1; ix += INLAND_PROBE_STRIDE) {
      const x = -R + ix * cell;
      const z = -R + iz * cell;
      if (!isInland(hm, x, z, sp)) continue;
      const slope = gradientAt(hm, x, z);
      if (slope > sp.boulderSlopeMin && convexityAt(hm, x, z) > sp.boulderConvexity) convex.push([x, z]);
      else if (slope < sp.erraticSlopeMax) treads.push([x, z]);
    }
  }
  const out: RockPlacement[] = [];
  const place = (cells: [number, number][], count: number, origin: 'convex' | 'erratic'): void => {
    for (let i = 0; i < count && cells.length > 0; i++) {
      const c = cells[Math.floor(rng() * cells.length) % cells.length];
      let x = c[0];
      let z = c[1];
      // a half-cell jitter off the probe grid, re-checked against the gate:
      // curvature turns over inside a cell, and a boulder that drew a convex
      // cell must still SIT on convex ground (tests pin it at the boulder)
      for (let attempt = 0; attempt < 8; attempt++) {
        const jx = c[0] + (rng() - 0.5) * cell;
        const jz = c[1] + (rng() - 0.5) * cell;
        const ok =
          origin === 'convex'
            ? convexityAt(hm, jx, jz) > 0 && gradientAt(hm, jx, jz) > sp.boulderSlopeMin * 0.5
            : gradientAt(hm, jx, jz) < sp.erraticSlopeMax;
        if (ok) {
          x = jx;
          z = jz;
          break;
        }
      }
      // heavy-tailed like the shore scatter; erratics draw from the big end
      const t = origin === 'erratic' ? 0.6 + 0.4 * rng() : rng() ** 3;
      const scale = sp.boulderMinScale + (sp.boulderMaxScale - sp.boulderMinScale) * t;
      const squash = p.rockSquashMin + (p.rockSquashMax - p.rockSquashMin) * rng();
      const aspect = p.rockAspectMin + (p.rockAspectMax - p.rockAspectMin) * rng();
      const halfHeight = scale * squash;
      out.push({
        position: [x, hm.heightAt(x, z) + halfHeight * (1 - p.rockEmbed), z],
        scale,
        squash,
        aspect,
        yaw: rng() * Math.PI * 2,
        tilt: rng() * p.rockTiltMax,
        tiltDir: rng() * Math.PI * 2,
        variant: Math.floor(rng() * p.rockGeoVariants) % p.rockGeoVariants,
        foamTarget: false,
        cliff: false,
        origin,
      });
    }
  };
  place(convex, Math.round(sp.inlandBouldersPerRadius * R), 'convex');
  place(treads, Math.round(sp.erraticCount), 'erratic');
  return out;
}

/**
 * Bearings for the CLIFF GROUPS.
 *
 * The references (docs/inspo/island/ref-island-146, -150) do not spread their
 * granite evenly: an island has two or three ROCKY FLANKS carrying nearly all
 * of it, and the rest is clean beach. A uniform angular scatter of big masses
 * would ring the island and read as a wall, which is the same "statistically
 * Poisson" tell `palmGroveAngles` exists to avoid — so cliffs cluster the same
 * way palms do, on their own decorrelated stream.
 */
export function cliffGroupAngles(seed: number, p: IslandParams = islandParams): number[] {
  const rng = createRng(seed);
  const count = Math.max(1, Math.floor(p.cliffGroups));
  const phase = rng();
  const angles: number[] = [];
  for (let i = 0; i < count; i++) {
    angles.push(((i + 0.2 + rng() * 0.6) / count + phase) * Math.PI * 2);
  }
  return angles;
}

/**
 * Counts scale with the island's FOOTPRINT, exactly as `islandPalmCount` does
 * and for the same reason: the authored counts are for `islandParams.radius`,
 * and a 260 m island with the boulder count of a 90 m one reads bare. `p` here
 * is always the unoverridden global (createRocks passes it), so `p.radius` is
 * the reference and `hm.worldRadius` the actual — the ratio cannot cancel to 1
 * the way it would if the per-island copy were passed (see islandPalmCount).
 */
function countForRadius(base: number, hm: IslandHeightmap, p: IslandParams): number {
  const ref = Math.max(p.radius, 1e-3); // §V28 floored divisor
  return Math.max(0, Math.round(base * (hm.worldRadius / ref)));
}

/** pure, deterministic: same (seed, heightmap, params) → same placements */
export function generateRockPlacements(
  seed: number,
  hm: IslandHeightmap,
  p: IslandParams = islandParams,
): RockPlacement[] {
  const rng = createRng(seed);
  const placements: RockPlacement[] = [];

  const push = (
    x: number,
    z: number,
    scale: number,
    squash: number,
    embed: number,
    cliff: boolean,
  ): void => {
    const aspect = p.rockAspectMin + (p.rockAspectMax - p.rockAspectMin) * rng();
    const yaw = rng() * Math.PI * 2;
    const tilt = rng() * p.rockTiltMax;
    const tiltDir = rng() * Math.PI * 2;
    const variant = Math.floor(rng() * p.rockGeoVariants) % p.rockGeoVariants;
    const halfHeight = scale * squash;
    // A mass standing OFF the shore sits on a seabed that keeps falling away,
    // and embedding it against that puts a 20 m dome entirely under water —
    // the references stand them proud in the shallows. Floor the seat so a
    // rock never sinks more than `rockSeaSeat` of its own half-height below
    // still water, whatever the bathymetry does out there.
    const ground = Math.max(hm.heightAt(x, z), -halfHeight * p.rockSeaSeat);
    const y = ground + halfHeight * (1 - embed);
    // approximate: deformation perturbs the surface ±rockNoiseAmp, so the
    // straddle test uses the undeformed half-height (good enough for tagging)
    const foamTarget = y - halfHeight < 0 && y + halfHeight > 0;
    placements.push({
      position: [x, y, z],
      scale,
      squash,
      aspect,
      yaw,
      tilt,
      tiltDir,
      variant,
      foamTarget,
      cliff,
    });
  };

  /**
   * THE ROCKY FLANKS, resolved ONCE and shared by the boulders and the cliff
   * masses below.
   *
   * "The big rocks — maybe they're all a little bit too evenly and same
   * shaped." The shapes are the other half of this fix (see deformRockGeometry);
   * this is the EVENLY. A uniform random bearing is a Poisson process, and a
   * Poisson process on a ring is exactly what "evenly spread" looks like to the
   * eye — the same measurement that sent the palms into groves (angular-gap
   * CV 0.84). Real granite scatter does not do that: boulders are the DEBRIS
   * of the masses they came off, so they lie in fields at the foot of the
   * headlands and in the surf line below them, with clean beach in between.
   *
   * The cliff groups are already the island's rocky flanks, so the boulders
   * simply inherit them — one bearing set, two systems, and the scatter reads
   * as talus off the headland instead of as a ring of props. A minority stay
   * loose so the beaches are not perfectly swept either.
   */
  const groups = cliffGroupAngles(seed + 7717, p);

  // -- boulder scatter: clumped on the flanks, along the shoreline ----------
  const boulders = countForRadius(p.rockCount, hm, p);
  for (let i = 0; i < boulders; i++) {
    const clumped = rng() < p.rockClumpFraction;
    // triangular jitter packs the field toward its flank and thins at the
    // edges (same shape and reason as the palm groves and the cliff groups)
    const angle = clumped
      ? groups[Math.floor(rng() * groups.length) % groups.length] +
        (rng() + rng() - 1) * p.rockClumpSpread
      : rng() * Math.PI * 2;
    const r = findShoreRadius(hm, angle) + (rng() * 2 - 1) * p.rockSpread;
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    // §V43: the old range was 3.0-8.0 sampled UNIFORMLY, i.e. a mean of 5.5
    // with a 1.6:1 spread either side of it — "one shape at one size". Real
    // granite scatter is heavy-tailed: mostly small, occasionally huge. The
    // cube of a uniform pushes the mass of the distribution to the small end
    // and still reaches the top of the range, so the same two params now
    // describe a scatter instead of a mean.
    const t = rng() ** 3;
    const scale = p.rockMinScale + (p.rockMaxScale - p.rockMinScale) * t;
    const squash = p.rockSquashMin + (p.rockSquashMax - p.rockSquashMin) * rng();
    push(x, z, scale, squash, p.rockEmbed, false);
  }

  // -- cliff masses: the island's SILHOUETTE -------------------------------
  // These are scale features, not props. They go in the SAME instanced
  // batches as the boulders (see createRocks) so they cost no extra draw
  // call — the only difference here is where they sit and how big they are.
  // Bearings come from `groups` above, which the boulders now share.
  const cliffs = countForRadius(p.cliffCount, hm, p);
  for (let i = 0; i < cliffs; i++) {
    const centre = groups[Math.floor(rng() * groups.length) % groups.length];
    // triangular jitter packs the mass toward the group centre (same shape
    // and same reason as islandPalmPlacement's grove jitter)
    const angle = centre + (rng() + rng() - 1) * p.cliffGroupSpread;
    const shoreR = findShoreRadius(hm, angle);
    // radial band runs from well inland out past the waterline, so a group
    // reads as one headland running down into the sea rather than a row
    const f = p.cliffRadialInner + (p.cliffRadialOuter - p.cliffRadialInner) * rng();
    const r = shoreR * f;
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    // one dominant mass per group, the rest stepping down around it — the
    // reference silhouette is a hierarchy, not a row of equals
    const lead = i < groups.length;
    const t = lead ? 0.68 + rng() * 0.32 : rng() ** 1.7;
    const scale = p.cliffMinScale + (p.cliffMaxScale - p.cliffMinScale) * t;
    const squash = p.cliffSquashMin + (p.cliffSquashMax - p.cliffSquashMin) * rng();
    push(x, z, scale, squash, p.cliffEmbed, true);
  }
  placements.push(...generateInlandPlacements(seed, hm, p));
  return placements;
}

/**
 * THE FACET BUG (user: "the rocks look ridiculous as hell", "~20 flat facets").
 *
 * `THREE.IcosahedronGeometry` is built by `PolyhedronGeometry`, which emits
 * NON-INDEXED triangle soup — every triangle owns three private vertices even
 * where three triangles meet at the same point. `computeVertexNormals()` on
 * non-indexed geometry can only average within a triangle, so it produces a
 * FLAT normal per face. That is the whole defect: the displacement is smooth
 * (it is position-hashed, so duplicated vertices move together and the mesh
 * never cracks) and the SHADING was faceted, which is why raising `rockDetail`
 * never helped — it just made more facets.
 *
 * Welding by quantised position before `computeVertexNormals()` makes the
 * normals area-average across the whole 1-ring, i.e. smooth. The references
 * are smooth rounded granite domes, so this is the art direction as well as
 * the bug fix; the silhouette work now comes from the SHAPE (below) rather
 * than from shading noise.
 *
 * Quantisation is safe because the source positions come off the unit sphere
 * exactly, so coincident vertices are bit-identical before scaling — 1e-5 is a
 * tolerance against float noise, not a merge radius that could weld distinct
 * points on a detail-3 icosahedron (nearest distinct vertices are ~0.16 apart).
 */
function weldGeometry(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const src = geometry.getAttribute('position') as THREE.BufferAttribute;
  const map = new Map<string, number>();
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < src.count; i++) {
    const x = src.getX(i);
    const y = src.getY(i);
    const z = src.getZ(i);
    const key = `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
    let idx = map.get(key);
    if (idx === undefined) {
      idx = positions.length / 3;
      map.set(key, idx);
      positions.push(x, y, z);
    }
    indices.push(idx);
  }
  const welded = new THREE.BufferGeometry();
  welded.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  welded.setIndex(indices);
  return welded;
}

/**
 * SHAPE FAMILIES — the answer to "they're all a little bit too evenly and same
 * shaped".
 *
 * The previous pass fixed the FACETING (non-indexed icosahedra could only take
 * flat per-face normals) and widened the per-instance transform. The user then
 * looked straight past that at the SILHOUETTE, which is a different axis and
 * one the transform cannot reach: `scale`, `squash`, `aspect`, `yaw` and `tilt`
 * are all affine, and no affine map turns a dome into a wedge. Every boulder on
 * the beach was one blob at several sizes because the GENERATOR only had one
 * blob in it — four variants sampled from the same distribution are four
 * samples of the same shape, not four shapes.
 *
 * So the variants are now archetypally different rather than differently
 * seeded. Real granite scatter is slabs, wedges, split blocks and whale-backs
 * lying together; that is what the references show and it is what the seeded
 * generator now has to draw from.
 *
 * IT COSTS NOTHING. `createRocks` already builds one InstancedMesh per variant,
 * so the draw-call count is `rockGeoVariants` whatever the variants contain —
 * exactly the trick that put the cliff masses in the boulders' batches. Four
 * genuinely different silhouettes and four rounded potatoes are the same four
 * draws.
 */
export const ROCK_FAMILIES = ['dome', 'slab', 'wedge', 'block'] as const;
export type RockFamily = (typeof ROCK_FAMILIES)[number];

interface FamilyShape {
  /** multiplier on `rockStretch` — how far from round in plan */
  stretch: number;
  /** vertical scale applied BEFORE the noise (1 = untouched, <1 = a slab) */
  flatten: number;
  /** multiplier on `rockFacetCount` */
  cuts: number;
  /** multiplier on `rockFacetSoftness` — small = a hard arris, large = rolled */
  softness: number;
  /**
   * How far the cuts are pulled toward HORIZONTAL. 1 gives bedding planes and
   * a table top; 0 leaves them uniform on the sphere (shoulders and faces).
   */
  layering: number;
  /** linear thinning along one horizontal axis, 0..0.8 — a prow or a cone */
  taper: number;
  /** multiplier on the grain amplitude — a split block is not a lumpy one */
  grain: number;
}

const FAMILY_SHAPE: Record<RockFamily, FamilyShape> = {
  // the shipped whale-back, unchanged, so the family the references show most
  // of is still the one that comes up most
  dome: { stretch: 1, flatten: 1, cuts: 1, softness: 1, layering: 0, taper: 0, grain: 1 },
  // a bedded table: wide, low, with a near-horizontal top cut. These are the
  // rocks you see lying half-buried at the top of a beach.
  slab: { stretch: 1.5, flatten: 0.52, cuts: 1.2, softness: 0.55, layering: 0.9, taper: 0.12, grain: 0.8 },
  // the prow — ref-island-146's pointed rocks and ref-island-150's cones in
  // the shallows. One end stands tall and the body thins away from it.
  wedge: { stretch: 1.2, flatten: 1.15, cuts: 0.75, softness: 1.3, layering: 0.2, taper: 0.62, grain: 0.9 },
  // a split block: more cuts, deeper, and hard-edged, so it reads as granite
  // that has cleaved rather than as granite that has weathered
  block: { stretch: 0.85, flatten: 0.92, cuts: 1.8, softness: 0.35, layering: 0.45, taper: 0.2, grain: 0.7 },
};

/**
 * One granite mass, as a unit-radius blob of a given FAMILY (above).
 *
 * Four shape terms, deliberately at four different scales — the note asked
 * for "surface texture at two scales (large fracture planes, fine grain)" and
 * a rock that is only fbm-on-a-sphere reads as a potato at every size:
 *
 *  1. ANISOTROPY. A per-variant axis stretch, so the family contains loaves
 *     and whale-backs rather than N spheres. Applied BEFORE the noise so the
 *     displacement follows the stretched body instead of fighting it. The
 *     family scales it, and supplies a vertical term as well, which is what
 *     makes a slab a slab rather than a squashed instance of a dome.
 *  2. TAPER. A linear thinning along one horizontal axis. This is the term no
 *     amount of scaling could ever produce, because it is not affine: it turns
 *     the body into a wedge with a tall end and a thin one.
 *  3. FRACTURE PLANES. A few seeded half-space cuts that flatten the blob
 *     where they bite. This is what makes granite read as granite instead of
 *     as a pebble: broad flat faces meeting in soft edges. Softness comes
 *     from a smooth min, so the cut never puts a crease back in the shading.
 *     The family sets how many, how hard, and how nearly horizontal.
 *  4. GRAIN. The existing three-projection fbm, at the existing amplitude,
 *     supplying the fine lumpiness on top.
 *
 * Finally the base is flattened: `bedFlatten` pulls the bottom cap up toward a
 * plane so the mass BEDS into the ground instead of resting on it like an egg
 * (the note: "sits bedded into the ground rather than on it"). Without it,
 * embedding a round blob far enough to look seated buries most of its height.
 */
export function deformRockGeometry(
  seed: number,
  p: IslandParams = islandParams,
  family: RockFamily = 'dome',
): THREE.BufferGeometry {
  const geometry = weldGeometry(new THREE.IcosahedronGeometry(1, p.rockDetail));
  const rng = createRng(seed);
  const fam = FAMILY_SHAPE[family];
  const o = [rng() * 256, rng() * 256, rng() * 256, rng() * 256, rng() * 256, rng() * 256];

  // (1) per-variant anisotropy, mean-preserving-ish so scale still means size
  const ax = 1 + (rng() * 2 - 1) * p.rockStretch * fam.stretch;
  const az = 1 + (rng() * 2 - 1) * p.rockStretch * fam.stretch;
  const ay = fam.flatten;

  // (2) the taper axis — a horizontal bearing the body thins along
  const taperAngle = rng() * Math.PI * 2;
  const tax = Math.cos(taperAngle);
  const taz = Math.sin(taperAngle);
  const taper = fam.taper * (0.7 + rng() * 0.6);

  // (3) fracture planes: unit normals with an offset inside the body
  const planeCount = Math.max(0, Math.round(p.rockFacetCount * fam.cuts));
  const planes: { nx: number; ny: number; nz: number; d: number }[] = [];
  for (let i = 0; i < planeCount; i++) {
    // uniform on the sphere, biased away from straight down so the cuts read
    // as faces and shoulders rather than as a sawn-off base (the base has its
    // own term below), then pulled toward horizontal by the family's
    // `layering` so a slab gets a table top instead of a random chamfer
    const u = rng() * 2 - 1;
    const phi = rng() * Math.PI * 2;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    let nx = Math.cos(phi) * s;
    let ny = u * 0.6 + 0.15;
    let nz = Math.sin(phi) * s;
    if (fam.layering > 0) {
      // lerp the normal toward straight up, then renormalise — a bedding plane
      const w = fam.layering * (0.5 + rng() * 0.5);
      nx *= 1 - w;
      nz *= 1 - w;
      ny = ny * (1 - w) + w;
      const nl = Math.hypot(nx, ny, nz) || 1; // §V28 floored divisor
      nx /= nl;
      ny /= nl;
      nz /= nl;
    }
    planes.push({
      nx,
      ny,
      nz,
      d: p.rockFacetDepth + rng() * (1 - p.rockFacetDepth),
    });
  }

  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const f = p.rockNoiseFreq;
  const soft = Math.max(p.rockFacetSoftness * fam.softness, 1e-3); // §V28 floored divisor
  for (let i = 0; i < pos.count; i++) {
    const ux = pos.getX(i);
    const uy = pos.getY(i);
    const uz = pos.getZ(i);

    // (4) grain — sampled on the UNDEFORMED unit direction so the noise field
    // is a property of the variant, not of the stretch applied to it
    const n =
      (fbm2Cpu(ux * f + o[0], uy * f + o[1], p.rockNoiseOctaves) +
        fbm2Cpu(uy * f + o[2], uz * f + o[3], p.rockNoiseOctaves) +
        fbm2Cpu(uz * f + o[4], ux * f + o[5], p.rockNoiseOctaves)) /
      3;
    let k = 1 + (n * 2 - 1) * p.rockNoiseAmp * fam.grain;

    // (3) apply the cuts: each plane scales the radius down where the surface
    // pokes past it. exp(-x/soft) is a smooth one-sided clamp — it reaches the
    // plane asymptotically instead of crossing it, so no crease is created.
    let x = ux * ax;
    let y = uy * ay;
    let z = uz * az;
    const len = Math.hypot(x, y, z) || 1; // §V28 floored divisor
    x /= len;
    y /= len;
    z /= len;
    // (2) TAPER, applied to the radius on the unit direction: a smooth linear
    // thinning toward +taperAxis. Clamped well clear of zero so the far end
    // stays a face and never pinches into a degenerate spike.
    if (taper > 0) k *= 1 - taper * (0.5 + 0.5 * (x * tax + z * taz));
    for (const pl of planes) {
      const dot = x * pl.nx + y * pl.ny + z * pl.nz;
      const over = dot - pl.d;
      if (over > 0) k *= pl.d / dot + (1 - pl.d / dot) * Math.exp(-over / soft);
    }

    // BEDDING: squeeze the bottom cap toward a plane at -bedLevel. Smooth in
    // y, so the flank blends into the flat rather than stepping onto it.
    const yBody = y * k * len;
    if (yBody < -p.rockBedLevel) {
      const excess = -p.rockBedLevel - yBody;
      const flattened = -p.rockBedLevel - excess * (1 - p.rockBedFlatten);
      k *= flattened / (yBody || -1e-3); // §V28 floored divisor
    }

    pos.setXYZ(i, x * k * len, y * k * len, z * k * len);
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

export interface CreateRocksOptions {
  seed: number;
  heightmap: IslandHeightmap;
  /** inject a shared material (e.g. the island's); default creates its own */
  material?: THREE.Material;
}

export interface Rocks {
  group: THREE.Group;
  placements: RockPlacement[];
  /** meshes tagged userData.foamTarget — T13 intersection-foam targets */
  foamTargets: THREE.Object3D[];
  /** LOD hook (§V17): hide the whole outcrop set beyond the cull distance */
  setVisible(visible: boolean): void;
  /** push live Tweakpane rock-material edits (no-op if material injected) */
  updateFromParams(): void;
  dispose(): void;
}

/**
 * Assemble rock outcrops as ONE InstancedMesh per deformed geometry variant
 * (§V17: rockCount × islandCount separate meshes was rockCount draw calls per
 * island; instancing makes it rockGeoVariants). Instances of a variant share
 * the foam tag — the injection mask is a waterline height compare, so rocks
 * that sit clear of the water contribute nothing to it anyway (§V10).
 */
export function createRocks(opts: CreateRocksOptions): Rocks {
  const p = islandParams;
  const placements = generateRockPlacements(opts.seed, opts.heightmap, p);
  const variants: THREE.BufferGeometry[] = [];
  for (let v = 0; v < p.rockGeoVariants; v++) {
    // families cycle, so the FIRST rockGeoVariants variants are guaranteed to
    // be one of each rather than a random draw that might hand out three domes
    variants.push(
      deformRockGeometry(opts.seed + 101 * (v + 1), p, ROCK_FAMILIES[v % ROCK_FAMILIES.length]),
    );
  }
  // an unshared sierra island owns a GRANITE handle (§T.112a); the shared
  // path gets it from islandMaterials.sierraRock
  const ownMaterial: RockMaterialHandle | null = opts.material
    ? null
    : opts.heightmap.sierra
      ? createSierraRockMaterial(undefined, { horizon: horizonMapFor(opts.heightmap) })
      : createRockMaterial();
  const material = opts.material ?? ownMaterial!.material;

  const group = new THREE.Group();
  group.name = 'island-rocks';
  const foamTargets: THREE.Object3D[] = [];

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const yawQ = new THREE.Quaternion();
  const tiltQ = new THREE.Quaternion();
  const tiltAxis = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  for (let v = 0; v < variants.length; v++) {
    const forVariant = placements.filter((pl) => pl.variant === v);
    if (forVariant.length === 0) continue;
    const mesh = new THREE.InstancedMesh(variants[v], material, forVariant.length);
    mesh.name = `island-rocks-${v}`;
    let straddles = false;
    for (let i = 0; i < forVariant.length; i++) {
      const pl = forVariant[i];
      position.set(...pl.position);
      // yaw first, then tilt about a horizontal axis — same composition order
      // as scatter.ts's palm lean, so the two read as one convention
      yawQ.setFromAxisAngle(up, pl.yaw);
      tiltAxis.set(Math.cos(pl.tiltDir), 0, Math.sin(pl.tiltDir));
      tiltQ.setFromAxisAngle(tiltAxis, pl.tilt);
      quat.copy(tiltQ).multiply(yawQ);
      scale.set(pl.scale, pl.scale * pl.squash, pl.scale * pl.aspect);
      mesh.setMatrixAt(i, matrix.compose(position, quat, scale));
      straddles = straddles || pl.foamTarget;
    }
    mesh.instanceMatrix.needsUpdate = true;
    // the sierra rock material's horizon shadow rides `receivedShadowNode`,
    // which only runs on a receiver (§T.112a)
    if (opts.heightmap.sierra) mesh.receiveShadow = true;
    // instance matrices are baked, so the default unit-icosahedron bounds
    // would cull the whole batch the moment the origin leaves the frustum
    mesh.computeBoundingSphere();
    if (straddles) {
      mesh.userData.foamTarget = true; // T13 socket, §V10
      foamTargets.push(mesh);
    }
    group.add(mesh);
  }

  return {
    group,
    placements,
    foamTargets,
    setVisible(visible: boolean): void {
      group.visible = visible;
    },
    updateFromParams(): void {
      ownMaterial?.updateFromParams();
    },
    dispose(): void {
      for (const g of variants) g.dispose();
      for (const child of group.children) (child as THREE.InstancedMesh).dispose?.();
      ownMaterial?.dispose();
    },
  };
}
