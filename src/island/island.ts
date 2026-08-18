/**
 * One procedural island (T20/T33): heightmap terrain (heightmap.ts) + sand/
 * rock blend mesh (islandMesh.ts, T27 material, T33 swash) + deformed rock
 * outcrops (rocks.ts) + terrain-aware palms (palms.ts, T26 stack).
 * Deterministic per seed (§V2-adjacent). Tunables in params/island.ts (§V16).
 *
 * SOCKETS:
 * - `island.foamTargets`: the terrain mesh plus every rock batch that
 *   straddles the waterline, each tagged `userData.foamTarget = true`.
 *   flowfoam's injection pass finds them by scene traversal, so the surf line
 *   at the beach and the foam collar on the rocks come out of the SAME §V10
 *   depth-compare machinery as the ship wake — nothing duplicated here.
 * - `island.waterfallSocket`: an empty Object3D at the steepest shoreline
 *   point (+z facing out to sea, userData.socket = 'waterfall'). T13 parents
 *   its waterfall plane + flow-foam quad here; no waterfall geometry yet.
 *
 * Build-time params (radius, gridSize, shape/scatter values) need a
 * createIsland() rebuild; material params stay live via update().
 *
 * Lives outside index.ts so archipelago.ts can import it without an import
 * cycle through the barrel.
 */
import * as THREE from 'three/webgpu';
import { islandParams, type IslandParams } from '../params/island';
import { findShoreRadius, generateIslandHeightmap, gradientAt, type IslandHeightmap } from './heightmap';
import type { ArchetypeName } from './archetypes';
import { createIslandMesh, selectTerrainLod, type IslandMeshHandle } from './islandMesh';
import { createRocks, type Rocks } from './rocks';
import { createIslandPalms, type IslandPalms } from './palms';
import { createGroundCover, type GroundCoverMeshes } from '../terrain';
import type { IslandMaterials } from './islandMaterials';

/**
 * Everything an island is built from: the world tunables, plus the two
 * per-island build inputs that are NOT Tweakpane knobs (§V16 — `archetype` is
 * a choice made once at construction, not a value anyone drags).
 */
export type ResolvedIslandParams = IslandParams & { archetype?: ArchetypeName };

/** decorrelate the sub-system rng streams derived from the island seed */
const ROCK_SEED_OFFSET = 1013;
const PALM_SEED_OFFSET = 2027;
const COVER_SEED_OFFSET = 3041;
/** shoreline angles scanned when picking the waterfall socket location */
const SOCKET_SCAN_ANGLES = 64;

export interface CreateIslandOptions {
  seed: number;
  /** island center on the world XZ plane (waterline stays world y=0) */
  position: [number, number];
  /** overrides islandParams.radius for this island */
  radius?: number;
  /**
   * Force a silhouette family instead of drawing one from the seed. One
   * caller: the hand-placed showcase island (showcase.ts).
   */
  archetype?: ArchetypeName;
  /**
   * Params applied on top of islandParams (and on top of the radius-derived
   * peak heights) for this island alone. Build-time, like `radius`.
   */
  overrides?: Partial<IslandParams>;
  /**
   * Shared shader set (islandMaterials.ts). When present the island renders
   * with it and does NOT push uniforms itself — the archipelago does that once
   * for the whole set (§V17). Omit for a stand-alone island that owns and
   * drives its own materials.
   */
  materials?: IslandMaterials;
  /**
   * Silhouette families already used in this world. A world where two of five
   * islands share a shape fails "identifiable from miles out" as surely as one
   * where all five do (§V43), so the archipelago hands out distinct ones.
   */
  avoidArchetypes?: readonly ArchetypeName[];
}

/** per-frame inputs an island needs from the sim/render side */
export interface IslandFrame {
  /** sim time (s) */
  time: number;
  /** unit wind direction on XZ (from oceanParams.windDirection) */
  windDir: [number, number];
  /** wind strength 0..1+ — palms and sea agree because both read the sea state */
  windStrength: number;
  /** live water surface height (m) at this island's shore, from CpuOcean (§V8) */
  waterLevel: number;
  /** swell amplitude (m) ≈ Hs/2 — scales the beach runup; use `ocean.heightRms * 2` */
  swell: number;
  /** world sun direction (unit, pointing AT the sun) */
  sunDirection: THREE.Vector3;
  /**
   * Atmosphere colour the island melts into at range (§V30/§V43) — pass
   * `scene.fog.color`, which the sky rig retints per frame and which the ocean
   * already copies for its own distance haze. Land and sea must melt into the
   * SAME atmosphere or every coastline shows a seam; see
   * terrain/aerialPerspective.ts.
   */
  hazeColor: THREE.Color;
  /** camera world position — drives the LOD (§V17) */
  cameraPosition: THREE.Vector3;
}

export interface Island {
  group: THREE.Group;
  heightmap: IslandHeightmap;
  /** island centre on the world XZ plane */
  center: [number, number];
  /** terrain height (m, waterline 0) at WORLD coords; off-island → -rimDepth */
  heightAt(worldX: number, worldZ: number): number;
  /** per-frame: swash + palm sway + LOD + live material param sync */
  update(frame: IslandFrame): void;
  /** T13 socket: waterline-straddling geometry for intersection foam (§V10) */
  foamTargets: THREE.Object3D[];
  /** T13 socket: anchor for the waterfall plane + flow foam */
  waterfallSocket: THREE.Object3D;
  terrain: IslandMeshHandle;
  rocks: Rocks;
  palms: IslandPalms;
  /** instanced grass + shrubs (§V43) — two draws, gated to near range */
  cover: GroundCoverMeshes;
  dispose(): void;
}

/**
 * Palms per island scale LINEARLY with footprint radius: `palmCount` is
 * authored for the default radius, and a 260 m island with the same 28 palms
 * reads bald. Linear (not area) on purpose — quadratic would put ~250 palms
 * on one island and blow §V17 the moment the ship anchors off it.
 */
/**
 * Peak height and its floor for a given footprint radius.
 *
 * TWO CORRECTIONS IN A ROW LIVE HERE, and the second undoes half of the first.
 *
 * WAS: a fixed 26 m against a 110-260 m scatter, so peak/radius ran 0.198 down
 * to 0.149 — growth made islands MORE pancake-like. Fixed by scaling linearly
 * with radius.
 *
 * BUT LINEAR IS ALSO WRONG, and it is the other half of why every island read
 * as the same cone. `k = radius/base` makes peak/radius a CONSTANT — 0.444 by
 * construction — so a big island is a SCALED COPY of a small one and can never
 * be a broader landmass. Measured across all five archetypes at every radius,
 * peak/radius came out 0.38-0.52 with the medians inside one narrow band, and
 * the showcase island at R = 260 was a 115.6 m mountain with a 98.2 m floor
 * under it. That mountain is what the user was looking at.
 *
 * `peakHeightGrowth` < 1 sends growth sideways instead of up: at 0.5 a 260 m
 * island is 1.7× the height of a 90 m one rather than 2.9×. The art-direction
 * references (docs/inspo/island/) are sand platforms a couple of metres proud
 * with boulders on them — relief there is nearly all PROP, not terrain — so
 * the exponent and the base height are both deliberately low.
 */
export function islandPeakHeights(
  radius: number,
  ref = islandParams,
): { peakHeight: number; minPeakHeight: number } {
  const base = Math.max(ref.radius, 1e-3); // §V28 floored divisor
  const k = Math.pow(Math.max(radius, 0) / base, ref.peakHeightGrowth);
  return { peakHeight: ref.peakHeight * k, minPeakHeight: ref.minPeakHeight * k };
}

export function islandPalmCount(radius: number, ref = islandParams): number {
  // `ref` is the UNOVERRIDDEN params: ref.palmCount is authored for
  // ref.radius, and passing the per-island copy (whose radius is the override)
  // would cancel the ratio to 1 and plant the same 28 palms on every island.
  const base = Math.max(ref.radius, 1e-3); // §V28 floored divisor
  return Math.max(0, Math.round(ref.palmCount * (radius / base)));
}

/** steepest shoreline point → waterfall anchor, oriented out to sea */
function buildWaterfallSocket(hm: IslandHeightmap): THREE.Object3D {
  let bestAngle = 0;
  let bestSlope = -Infinity;
  for (let i = 0; i < SOCKET_SCAN_ANGLES; i++) {
    const angle = (i / SOCKET_SCAN_ANGLES) * Math.PI * 2;
    const r = findShoreRadius(hm, angle);
    // slope just inland of the shore — where a cliff face would carry water
    const slope = gradientAt(hm, Math.cos(angle) * r * 0.92, Math.sin(angle) * r * 0.92);
    if (slope > bestSlope) {
      bestSlope = slope;
      bestAngle = angle;
    }
  }
  const r = findShoreRadius(hm, bestAngle);
  const x = Math.cos(bestAngle) * r * 0.92;
  const z = Math.sin(bestAngle) * r * 0.92;
  const socket = new THREE.Object3D();
  socket.name = 'waterfall-socket';
  socket.userData.socket = 'waterfall';
  socket.position.set(x, Math.max(hm.heightAt(x, z), 0), z);
  socket.lookAt(
    Math.cos(bestAngle) * hm.worldRadius * 2,
    0,
    Math.sin(bestAngle) * hm.worldRadius * 2,
  );
  return socket;
}

export function createIsland(opts: CreateIslandOptions): Island {
  const bespoke =
    opts.radius !== undefined || opts.overrides !== undefined || opts.archetype !== undefined;
  const p: ResolvedIslandParams = bespoke
    ? {
        ...islandParams,
        ...(opts.radius !== undefined
          ? { radius: opts.radius, ...islandPeakHeights(opts.radius) }
          : {}),
        // LAST, deliberately: an override of `peakHeight` must beat the
        // radius-derived one, not be silently replaced by it
        ...opts.overrides,
        archetype: opts.archetype,
      }
    : islandParams;
  const heightmap = generateIslandHeightmap(opts.seed, p, opts.avoidArchetypes);

  const shared = opts.materials;
  const terrain = createIslandMesh(heightmap, p.skirtDepth, shared?.terrain);
  const rocks = createRocks({
    seed: opts.seed + ROCK_SEED_OFFSET,
    heightmap,
    material: shared?.rock.material,
  });
  const palms = createIslandPalms({
    seed: opts.seed + PALM_SEED_OFFSET,
    heightmap,
    count: islandPalmCount(p.radius, islandParams),
    shared: shared ? { palm: shared.palm, sway: shared.palmSway } : undefined,
  });
  const cover = createGroundCover({
    seed: opts.seed + COVER_SEED_OFFSET,
    heightmap,
    material: shared?.cover,
  });
  const waterfallSocket = buildWaterfallSocket(heightmap);

  const group = new THREE.Group();
  group.name = 'island';
  group.add(terrain.mesh, rocks.group, palms.mesh, cover.group, waterfallSocket);
  const [px, pz] = opts.position;
  group.position.set(px, 0, pz);

  const camDelta = new THREE.Vector3();
  const foamTargets: THREE.Object3D[] = [terrain.mesh, ...rocks.foamTargets];
  /**
   * THE PER-FRAME `castShadow` TRAVERSAL, HOISTED (already named as a CPU cost
   * worth attacking, and this frame is CPU-bound at 19-24 ms of encode).
   *
   * It re-walked `rocks.group` every frame, for every island, to write a value
   * that changes only when someone moves the Tweakpane toggle. The casters are
   * a fixed, tiny list — the terrain mesh, the palm batch and one InstancedMesh
   * per rock variant — so collect it ONCE at build time and write the flag only
   * on the frames where the toggle actually moved. Steady state is now a single
   * boolean compare per island per frame instead of a scene walk.
   */
  const shadowCasters: THREE.Object3D[] = [terrain.mesh, palms.mesh, ...rocks.group.children];
  let appliedCastShadows: boolean | null = null;

  return {
    group,
    heightmap,
    center: [px, pz],
    heightAt(worldX, worldZ): number {
      return heightmap.heightAt(worldX - px, worldZ - pz);
    },
    update(frame): void {
      // shared shaders are driven once by the archipelago; pushing the same
      // uniforms five times a frame is pure waste
      if (!shared) {
        palms.update(frame.time, frame.windDir, frame.windStrength);
        palms.setSunDirection(frame.sunDirection);
        // updateFromParams FIRST: it re-reads terrainParams.waterline (the
        // Tweakpane default), so the live sea level has to be pushed after it
        // or the panel value would win every frame
        terrain.updateFromParams();
        terrain.material.setSunDirection(frame.sunDirection);
        terrain.material.setHazeColor(frame.hazeColor);
        terrain.material.setTime(frame.time);
        terrain.material.setSwell(frame.swell);
        terrain.setWaterline(frame.waterLevel);
        rocks.updateFromParams();
      }

      // LOD by distance to the island CENTRE, not to the nearest point: one
      // number per island, and a 200 m footprint never straddles a threshold
      camDelta.set(frame.cameraPosition.x - px, 0, frame.cameraPosition.z - pz);
      const dist = camDelta.length();
      // still live to the Tweakpane toggle — but only written when it moves
      if (appliedCastShadows !== p.castShadows) {
        appliedCastShadows = p.castShadows;
        for (const caster of shadowCasters) caster.castShadow = p.castShadows;
      }

      terrain.setLod(selectTerrainLod(dist, p));
      palms.setLodDistance(dist);
      rocks.setVisible(dist <= p.lodRockCull);
      cover.setLodDistance(dist);
      // §V10/§V17: flowfoam re-tags every foamTarget in the scene each frame
      // and its capture region is ~120 m wide, so an island across the map is
      // pure wasted draws in that pass. Untag it until the ship is near.
      const foamNear = dist <= p.radius + p.foamTargetMargin;
      for (const target of foamTargets) target.userData.foamTarget = foamNear;
    },
    foamTargets,
    waterfallSocket,
    terrain,
    rocks,
    palms,
    cover,
    dispose(): void {
      cover.dispose();
      palms.dispose();
      rocks.dispose();
      terrain.dispose();
    },
  };
}
