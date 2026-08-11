/**
 * Procedural island (T20): heightmap terrain (heightmap.ts) + sand/rock blend
 * mesh (islandMesh.ts, T27 material) + deformed rock outcrops (rocks.ts) +
 * terrain-aware palms (palms.ts, T26 stack). Deterministic per seed
 * (§V2-adjacent). All tunables in params/island.ts (§V16).
 *
 * T13 SOCKETS (waterfall + intersection foam — documented, NOT built here):
 * - `island.foamTargets`: rock meshes straddling the waterline, each tagged
 *   `userData.foamTarget = true`. T13's water-material depth-compare (§V10)
 *   should include them in the intersection-foam mask alongside ship hulls.
 * - `island.waterfallSocket`: an empty Object3D anchored at the steepest
 *   shoreline point (world transform, +z facing out to sea, userData.socket
 *   = 'waterfall'). T13 parents its waterfall plane + flow-foam quad here;
 *   no waterfall geometry/shader exists yet.
 *
 * Build-time params (radius, gridSize, shape/scatter values) need a
 * createIsland() rebuild; material params stay live via update().
 */
import * as THREE from 'three/webgpu';
import { islandParams } from '../params/island';
import {
  findShoreRadius,
  generateIslandHeightmap,
  gradientAt,
  type IslandHeightmap,
} from './heightmap';
import { createIslandMesh, type IslandMeshHandle } from './islandMesh';
import { createRocks, type Rocks } from './rocks';
import { createIslandPalms, type IslandPalms } from './palms';

export {
  generateIslandHeightmap,
  findShoreRadius,
  gradientAt,
  type IslandHeightmap,
  type IslandHeightmapParams,
} from './heightmap';
export { buildIslandGeometry, createIslandMesh } from './islandMesh';
export { generateRockPlacements, deformRockGeometry, createRocks } from './rocks';
export { islandPalmPlacement, createIslandPalms } from './palms';
export { islandParams, type IslandParams } from '../params/island';

/** decorrelate the sub-system rng streams derived from the island seed */
const ROCK_SEED_OFFSET = 1013;
const PALM_SEED_OFFSET = 2027;
/** shoreline angles scanned when picking the waterfall socket location */
const SOCKET_SCAN_ANGLES = 64;

export interface CreateIslandOptions {
  seed: number;
  /** island center on the world XZ plane (waterline stays world y=0) */
  position: [number, number];
  /** overrides islandParams.radius for this island */
  radius?: number;
}

export interface Island {
  group: THREE.Group;
  heightmap: IslandHeightmap;
  /** terrain height (m, waterline 0) at WORLD coords; off-island → -rimDepth */
  heightAt(worldX: number, worldZ: number): number;
  /** per-frame: palm sway + live material param sync */
  update(time: number, windDir: [number, number], windStrength: number): void;
  /** T13 socket: waterline-straddling rocks for intersection foam (§V10) */
  foamTargets: THREE.Mesh[];
  /** T13 socket: anchor for the waterfall plane + flow foam */
  waterfallSocket: THREE.Object3D;
  terrain: IslandMeshHandle;
  rocks: Rocks;
  palms: IslandPalms;
  dispose(): void;
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
  socket.lookAt(Math.cos(bestAngle) * hm.worldRadius * 2, 0, Math.sin(bestAngle) * hm.worldRadius * 2);
  return socket;
}

export function createIsland(opts: CreateIslandOptions): Island {
  const p = opts.radius !== undefined ? { ...islandParams, radius: opts.radius } : islandParams;
  const heightmap = generateIslandHeightmap(opts.seed, p);

  const terrain = createIslandMesh(heightmap, p.skirtDepth);
  const rocks = createRocks({ seed: opts.seed + ROCK_SEED_OFFSET, heightmap });
  const palms = createIslandPalms({
    seed: opts.seed + PALM_SEED_OFFSET,
    heightmap,
    count: p.palmCount,
  });
  const waterfallSocket = buildWaterfallSocket(heightmap);

  const group = new THREE.Group();
  group.name = 'island';
  group.add(terrain.mesh, rocks.group, palms.mesh, waterfallSocket);
  const [px, pz] = opts.position;
  group.position.set(px, 0, pz);

  return {
    group,
    heightmap,
    heightAt(worldX, worldZ): number {
      return heightmap.heightAt(worldX - px, worldZ - pz);
    },
    update(time, windDir, windStrength): void {
      palms.update(time, windDir, windStrength);
      terrain.updateFromParams();
      rocks.updateFromParams();
    },
    foamTargets: rocks.foamTargets,
    waterfallSocket,
    terrain,
    rocks,
    palms,
    dispose(): void {
      palms.dispose();
      rocks.dispose();
      terrain.dispose();
    },
  };
}
