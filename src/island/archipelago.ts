/**
 * Archipelago scatter (T33) — a few islands placed around the play area, plus
 * the seabed field they share.
 *
 * §V2 is the reason this is a seeded pure function and not a hand-placed list:
 * multiplayer clients later rebuild the world from `SimState.seed` alone, so
 * the layout has to be reproducible bit-for-bit from (seed, params). The
 * placement rules are also the things a player would notice if they broke:
 *  - nothing within `spawnClearance` of the world origin (the ship spawns at
 *    0,0 and must not start beached — pinned by tests)
 *  - open water between footprints, so islands never fuse into a landmass
 *  - inside the ocean's 4.6 km rim, so no island is half-eaten by the sea edge
 *
 * Rejection sampling, not jitter-grid: the annulus + clearance + gap
 * constraints are cheap to test and a failure is loud (§Rule 8) rather than
 * an island quietly landing on the spawn point.
 */
import * as THREE from 'three/webgpu';
import { createRng } from '../state/rng';
import { islandParams, type IslandParams } from '../params/island';
import { createIsland, type Island, type IslandFrame } from './island';
import { createIslandMaterials, type IslandMaterials } from './islandMaterials';
import { createSeabedField, type SeabedField, type SeabedIsland } from './seabed';

/** placement attempts per island before the layout is declared impossible */
const PLACEMENT_ATTEMPTS = 512;
/** decorrelates each island's own generation stream from the layout stream */
const ISLAND_SEED_STRIDE = 7919;
/** where on the camera-facing radius the shared sea-level probe sits (of R) */
const SHORE_SAMPLE_FRACTION = 0.9;

export interface IslandSite {
  /** seed for this island's heightmap / rocks / palms */
  seed: number;
  /** centre on the world XZ plane */
  position: [number, number];
  /** footprint radius (m) */
  radius: number;
}

/**
 * Deterministic island layout. Same (seed, params) → identical sites.
 * Throws if the constraints cannot be satisfied instead of returning a
 * partial world (§Rule 8) — that is a params bug, not a runtime condition.
 */
export function generateIslandSites(
  seed: number,
  p: IslandParams = islandParams,
): IslandSite[] {
  const rng = createRng(seed);
  const sites: IslandSite[] = [];
  const rMin = Math.min(p.scatterMinDistance, p.scatterMaxDistance);
  const rMax = Math.max(p.scatterMinDistance, p.scatterMaxDistance);

  const count = Math.max(0, Math.floor(p.islandCount));
  // one seeded rotation for the whole ring, so the nearest island isn't
  // always off the same bow
  const ringPhase = rng();
  for (let i = 0; i < count; i++) {
    let placed = false;
    for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS && !placed; attempt++) {
      // STRATIFIED, not uniform: island i owns radial band i/count and angular
      // sector i/count. Uniform sampling of a 700..3600 m annulus put every
      // island past 1900 m — the world had no landfall you could sail to and
      // nothing in the near field to look at. Stratifying guarantees the set
      // spans the whole range (one close, one at the haze distance) and makes
      // the gap constraint almost always satisfiable on the first attempt.
      const sector = (i + rng()) / count;
      const angle = (sector + ringPhase) * Math.PI * 2;
      const band = (i + rng()) / count;
      const dist = rMin + (rMax - rMin) * band;
      const radius = p.scatterRadiusMin + (p.scatterRadiusMax - p.scatterRadiusMin) * rng();
      const x = Math.cos(angle) * dist;
      const z = Math.sin(angle) * dist;
      if (dist - radius < p.spawnClearance) continue;
      let clear = true;
      for (const other of sites) {
        const d = Math.hypot(x - other.position[0], z - other.position[1]);
        if (d < radius + other.radius + p.islandGap) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
      sites.push({
        seed: seed + ISLAND_SEED_STRIDE * (i + 1),
        position: [x, z],
        radius,
      });
      placed = true;
    }
    if (!placed) {
      throw new Error(
        `generateIslandSites: could not place island ${i + 1}/${p.islandCount} in ` +
          `${PLACEMENT_ATTEMPTS} attempts — annulus ${rMin}..${rMax} m is too small ` +
          `for ${p.islandCount} islands of radius ≤${p.scatterRadiusMax} m with ` +
          `${p.islandGap} m gaps and ${p.spawnClearance} m spawn clearance`,
      );
    }
  }
  return sites;
}

export interface Archipelago {
  /** add this to the scene — one group holds every island */
  group: THREE.Group;
  islands: Island[];
  sites: IslandSite[];
  /**
   * Shared seabed depth field: ocean shallows tint, §V8 grounding, §V34
   * caustics receivers. See src/island/seabed.ts for the sampler contract.
   */
  seabed: SeabedField;
  /** every mesh tagged for §V10 intersection foam (already tagged in userData) */
  foamTargets: THREE.Object3D[];
  /** the one shader set every island renders with (§V17) */
  materials: IslandMaterials;
  /**
   * Per-frame. `waterLevel` is filled in here: sampled once, on the shore of
   * the island nearest the camera, and shared by every island (see the shared
   * material set — only the near island's swash is readable anyway).
   */
  update(frame: Omit<IslandFrame, 'waterLevel'>, waterLevelAt: WaterLevelFn): void;
  dispose(): void;
}

/** world XZ → water surface height (m); wire to CpuOcean.heightAt (§V8) */
export type WaterLevelFn = (x: number, z: number) => number;

export interface CreateArchipelagoOptions {
  /** world seed — use SimState.seed so the world matches the sim (§V2) */
  seed: number;
  /** overrides islandParams for this build (tests) */
  params?: IslandParams;
}

export function createArchipelago(opts: CreateArchipelagoOptions): Archipelago {
  const p = opts.params ?? islandParams;
  const sites = generateIslandSites(opts.seed, p);

  const group = new THREE.Group();
  group.name = 'archipelago';
  const materials = createIslandMaterials();
  const islands: Island[] = [];
  const foamTargets: THREE.Object3D[] = [];
  for (const site of sites) {
    const island = createIsland({
      seed: site.seed,
      position: site.position,
      radius: site.radius,
      materials,
    });
    islands.push(island);
    foamTargets.push(...island.foamTargets);
    group.add(island.group);
  }

  const seabedIslands: SeabedIsland[] = islands.map((i) => ({
    heightmap: i.heightmap,
    center: i.center,
  }));
  const seabed = createSeabedField(seabedIslands, p);

  return {
    group,
    islands,
    sites,
    seabed,
    foamTargets,
    materials,
    update(frame, waterLevelAt): void {
      // The swash reads the live sea level through ONE shared uniform, so it
      // is sampled at the island the camera is actually near — the only one
      // close enough to read the swash at all. One CpuOcean.heightAt per
      // frame, not one per island: that sample is not free (§V8 mirror).
      let nearest: Island | undefined;
      let best = Infinity;
      let nx = 0;
      let nz = 0;
      for (const island of islands) {
        const dx = frame.cameraPosition.x - island.center[0];
        const dz = frame.cameraPosition.z - island.center[1];
        const d = Math.hypot(dx, dz);
        if (d < best) {
          best = d;
          nearest = island;
          nx = dx;
          nz = dz;
        }
      }
      let waterLevel = 0;
      if (nearest) {
        // sample ON THE SHORE FACING THE CAMERA, not at the island centre: a
        // 69 m swell differs by over a metre across a 200 m island, and a
        // metre of level error slides the whole wet band metres up a flat
        // beach — visibly detached from the water the ocean mesh draws
        const len = Math.max(Math.hypot(nx, nz), 1e-3); // §V28 floored divisor
        const reach = nearest.heightmap.worldRadius * SHORE_SAMPLE_FRACTION;
        waterLevel = waterLevelAt(
          nearest.center[0] + (nx / len) * reach,
          nearest.center[1] + (nz / len) * reach,
        );
      }
      materials.update({ ...frame, waterLevel });
      for (const island of islands) island.update({ ...frame, waterLevel });
    },
    dispose(): void {
      for (const island of islands) island.dispose();
      materials.dispose();
      seabed.dispose();
    },
  };
}
