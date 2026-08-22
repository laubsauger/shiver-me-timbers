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
import {
  createIsland,
  islandPeakHeights,
  type Island,
  type IslandFrame,
  type ResolvedIslandParams,
} from './island';
import { createIslandMaterials, type IslandMaterials } from './islandMaterials';
import type { IslandHeightmap } from './heightmap';
import type { ArchetypeName } from './archetypes';
import { createSeabedField, type SeabedField, type SeabedIsland } from './seabed';
import {
  findLagoonAnchorage,
  SHOWCASE_LAGOON,
  SHOWCASE_SEED_STRIDE,
  type Anchorage,
} from './showcase';

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
  /**
   * Forced silhouette family. Set ONLY by the hand-placed showcase island —
   * see showcase.ts for why one deliberate exception beats seed-hunting.
   */
  archetype?: ArchetypeName;
  /** params applied on top of `islandParams` for this island alone */
  overrides?: Partial<IslandParams>;
  /**
   * Silhouette only (§V90): the Half-Dome island on the far horizon. Nothing
   * routes to it, no anchorage is solved for it, and it stays ≥ 1.5× the
   * furthest reachable station away. Set by `generateSierraSites`.
   */
  unreachable?: boolean;
}

/**
 * Resolve the params an island is actually built from. ONE function so tests,
 * the seabed field and the renderer cannot each apply a different subset of
 * the overrides and then disagree about where the ground is.
 */
export function siteParams(
  site: IslandSite,
  base: IslandParams = islandParams,
): ResolvedIslandParams {
  return {
    ...base,
    radius: site.radius,
    ...islandPeakHeights(site.radius, base),
    ...site.overrides,
    archetype: site.archetype,
  };
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

  // THE SHOWCASE ISLAND GOES IN FIRST, and that ordering is the whole trick:
  // the rejection loop below already tests every candidate against everything
  // in `sites`, so seeding the list with a hand-placed island makes the
  // procedural ones route around it automatically, at every seed, with no
  // second constraint to keep in sync. It takes one of the `islandCount`
  // slots rather than adding to them (see showcase.ts).
  const showcase = count > 0;
  if (showcase) {
    sites.push({
      seed: seed + SHOWCASE_SEED_STRIDE,
      position: [...SHOWCASE_LAGOON.position],
      radius: SHOWCASE_LAGOON.radius,
      archetype: SHOWCASE_LAGOON.archetype,
      overrides: SHOWCASE_LAGOON.overrides,
    });
  }
  const scattered = showcase ? count - 1 : count;

  // one seeded rotation for the whole ring, so the nearest island isn't
  // always off the same bow
  const ringPhase = rng();
  for (let i = 0; i < scattered; i++) {
    let placed = false;
    for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS && !placed; attempt++) {
      // STRATIFIED, not uniform: island i owns radial band i/scattered and
      // angular sector i/scattered. Uniform sampling of a 700..3600 m annulus
      // put every island past 1900 m — the world had no landfall you could
      // sail to and nothing in the near field to look at. Stratifying
      // guarantees the set spans the whole range (one close, one at the haze
      // distance) and makes the gap constraint almost always satisfiable on
      // the first attempt. The strata run over the SCATTERED count, not the
      // total: the showcase island is not on this ring and must not consume a
      // band, or the far end of the range would go unsampled.
      const sector = (i + rng()) / scattered;
      const angle = (sector + ringPhase) * Math.PI * 2;
      const band = (i + rng()) / scattered;
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
        `generateIslandSites: could not place scattered island ${i + 1}/${scattered} in ` +
          `${PLACEMENT_ATTEMPTS} attempts — annulus ${rMin}..${rMax} m is too small ` +
          `for ${p.islandCount} islands of radius ≤${p.scatterRadiusMax} m with ` +
          `${p.islandGap} m gaps and ${p.spawnClearance} m spawn clearance`,
      );
    }
  }
  return sites;
}

/**
 * Water a raft can sit in without her deck logs touching (m). She draws 0.3 m
 * and the calm-preset trough is about a metre, so this is draft + trough +
 * margin — the same reasoning as showcase.ts's 7 m, on a hull an order of
 * magnitude smaller.
 */
const LANDING_ANCHOR_DEPTH = 1.5;
/** how far seaward of the landing the berth may be pushed (m) */
const LANDING_ANCHOR_REACH = 40;
/** march step along a candidate bearing (m) */
const LANDING_ANCHOR_STEP = 2;
/** bearings tried out of the landing */
const LANDING_ANCHOR_BEARINGS = 24;

/**
 * Where a raft would lie off a routed island: the CLOSEST water to that
 * island's `landing` POI that is deep enough to float her, reached from the
 * landing without crossing land.
 *
 * The landing is where the path graph decided you come ashore (T112b), so it
 * is the honest anchor — the berth is the last metre of the sail rather than a
 * viewpoint someone liked. Facing it puts the beach, the route off it and the
 * summit behind in one frame, which is what `?at=<island>` is for.
 *
 * NOT `findLagoonAnchorage`: that one solves for a 35 m galleon in 7 m of
 * water nearest a lagoon BASIN, and it THROWS on an island with no basin —
 * which is every sierra island but the cirque. Different hull, different
 * objective, so a different solver rather than five more options on that one.
 *
 * The "without crossing land" rule is the part that cannot be dropped: a
 * bearing that tunnels over a spit would berth her in the water on the far
 * side of it, a short swim from a beach she cannot reach.
 *
 * Returns null (∅, not a throw) when nothing qualifies — an island with no
 * route simply has no anchorage, and the world is still valid without one.
 */
export function findLandingAnchorage(hm: IslandHeightmap): Anchorage | null {
  const landing = hm.path?.pois.find((q) => q.kind === 'landing');
  if (!landing) return null;
  let best: Anchorage | null = null;
  let bestD = Infinity;
  for (let i = 0; i < LANDING_ANCHOR_BEARINGS; i++) {
    const a = (i / LANDING_ANCHOR_BEARINGS) * Math.PI * 2;
    const ux = Math.cos(a);
    const uz = Math.sin(a);
    // the landing is a LAND cell by construction (a beach cell touching the
    // sea), so the first metres out of it are still beach — the crossing rule
    // can only start once she is actually afloat
    let afloat = false;
    for (let d = LANDING_ANCHOR_STEP; d <= LANDING_ANCHOR_REACH; d += LANDING_ANCHOR_STEP) {
      if (d >= bestD) break;
      const x = landing.x + ux * d;
      const z = landing.z + uz * d;
      const depth = -hm.heightAt(x, z);
      if (depth <= 0) {
        if (afloat) break; // back onto land: a spit, and the far side is not hers
        continue;
      }
      afloat = true;
      if (depth < LANDING_ANCHOR_DEPTH) continue;
      bestD = d;
      best = {
        x,
        z,
        // forward is [sin h, cos h] (showcase.ts's convention): bow at the
        // beach she just sailed for
        heading: Math.atan2(landing.x - x, landing.z - z),
        depth,
      };
      break;
    }
  }
  return best;
}

/** an anchorage in WORLD coords — the debug jump's destination list */
export interface WorldAnchorage extends Omit<Anchorage, 'x' | 'z'> {
  /** stable id used by the jump key and `?at=` */
  name: string;
  x: number;
  z: number;
}

export interface Archipelago {
  /** add this to the scene — one group holds every island */
  group: THREE.Group;
  islands: Island[];
  sites: IslandSite[];
  /**
   * Places worth parking at, solved from the built heightmaps. Empty when the
   * world has no islands. Feeds the debug jump (src/debug/jump.ts).
   */
  anchorages: WorldAnchorage[];
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
  /**
   * A hand-built site list instead of `generateIslandSites` — the sierra
   * slice (`generateSierraSites`, sierraSites.ts). Must already be resolved
   * (positions, radii, archetypes, overrides); nothing here re-validates it.
   */
  sites?: IslandSite[];
}

export function createArchipelago(opts: CreateArchipelagoOptions): Archipelago {
  const p = opts.params ?? islandParams;
  const sites = opts.sites ?? generateIslandSites(opts.seed, p);

  const group = new THREE.Group();
  group.name = 'archipelago';
  const materials = createIslandMaterials();
  const islands: Island[] = [];
  const foamTargets: THREE.Object3D[] = [];
  // hand each island a silhouette nobody else has, until the families run out
  const usedArchetypes: ArchetypeName[] = [];
  for (const site of sites) {
    const island = createIsland({
      seed: site.seed,
      position: site.position,
      radius: site.radius,
      archetype: site.archetype,
      overrides: site.overrides,
      materials,
      avoidArchetypes: usedArchetypes,
    });
    usedArchetypes.push(island.heightmap.archetype);
    islands.push(island);
    foamTargets.push(...island.foamTargets);
    group.add(island.group);
  }

  // The showcase island is sites[0] by construction (see generateIslandSites).
  // Its anchorage is solved from the heightmap that was actually built, not
  // from a stored constant — same island, same bay mouth, one source of truth.
  const anchorages: WorldAnchorage[] = [];
  // `=== 'lagoon'`, not `!== undefined`: a sierra site list also forces its
  // archetypes, and `findLagoonAnchorage` throws on an island with no basin
  if (sites.length > 0 && sites[0].archetype === 'lagoon') {
    const local = findLagoonAnchorage(islands[0].heightmap);
    anchorages.push({
      name: 'lagoon',
      x: islands[0].center[0] + local.x,
      z: islands[0].center[1] + local.z,
      heading: local.heading,
      depth: local.depth,
    });
  }
  // §T.125: and one berth per ROUTED island — the sierra slice's whole world
  // had `jumpTargets === ['spawn']`, so `raft.html?at=dome` did nothing and
  // every R3 island frame was hand-posed. Membership is the ROUTE, not the
  // archetype: `heightmap.path` exists only where the path carve ran (a slice
  // family at ≥ `pathMinRadius`), which is exactly the islands you can land
  // on — a filler islet and the unreachable Half Dome (§V90) have no route and
  // get no berth, without this file learning what either of those is.
  for (let i = 0; i < islands.length; i++) {
    if (sites[i].unreachable) continue;
    const local = findLandingAnchorage(islands[i].heightmap);
    if (!local) continue;
    const base = islands[i].heightmap.archetype;
    // the name is the family, which is unique among routed islands; the
    // suffix is a guard, not an expectation
    let name: string = base;
    for (let n = 2; anchorages.some((a) => a.name === name); n++) name = `${base}-${n}`;
    anchorages.push({
      name,
      x: islands[i].center[0] + local.x,
      z: islands[i].center[1] + local.z,
      heading: local.heading,
      depth: local.depth,
    });
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
    anchorages,
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
