/**
 * §T.198 Tower Reach AS THE PAGE BUILDS IT, headless: the kit island decor InstancedMeshes from the same `createKitDecor`
 * call island.ts makes (same seed, heightmap, render info, surface mask; stand-in material), under island groups at the
 * site centres, handed to the page's own `towerReachCourse().attach`. The colliders and bed are the lists the player's
 * collide step and the workers receive. Built once per test file (the terrain bake is the slow part).
 */
import * as THREE from 'three/webgpu';
import { buildTowerReach, towerReachSites } from '../src/circuit';
import { createKitDecor } from '../src/circuit/kitDecor';
import { kitRenderInfo, kitSurfaceFor } from '../src/circuit/kitRender';
import type { TowerReachWorld } from '../src/circuit/towerReach';
import { createSeabedField } from '../src/island/seabed';
import { towerReachCourse, TOWER_REACH_SEED, type CourseWorld } from '../src/speedboat/page/course';

export interface CollisionWorld {
  world: TowerReachWorld;
  page: CourseWorld;
  islandGroups: THREE.Group[];
}

let cached: CollisionWorld | null = null;

export function collisionWorld(): CollisionWorld {
  if (cached) return cached;
  towerReachSites(TOWER_REACH_SEED); // registers the kit render info, as the page's course hook does
  const world = buildTowerReach(TOWER_REACH_SEED);
  const seabed = createSeabedField(world.heightmaps.map((hm, i) => ({ heightmap: hm, center: world.sites[i].position })));
  const stand = new THREE.MeshStandardNodeMaterial();
  const islandGroups = world.sites.map((site, i) => {
    const hm = world.heightmaps[i];
    const g = new THREE.Group();
    g.name = 'island';
    g.position.set(site.position[0], 0, site.position[1]);
    // island.ts: kitHooks.decorate({ seed: opts.seed (= site.seed), heightmap, rockMaterial, aerialOutput, castShadows })
    const decor = createKitDecor({ seed: site.seed, heightmap: hm, rockMaterial: stand, castShadows: false }, kitRenderInfo(hm), kitSurfaceFor(hm));
    if (decor) g.add(decor.group);
    return g;
  });
  const warn = console.warn;
  console.warn = () => {};
  let page: CourseWorld;
  try {
    page = towerReachCourse().attach({
      archipelago: { islands: world.sites.map((site, i) => ({ center: site.position, heightmap: world.heightmaps[i], rocks: { placements: [] }, group: islandGroups[i] })), seabed },
      cpuOcean: { setSeabed() {} },
    });
  } finally {
    console.warn = warn;
  }
  cached = { world, page, islandGroups };
  return cached;
}
