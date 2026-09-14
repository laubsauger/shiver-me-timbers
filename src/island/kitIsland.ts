/**
 * KIT ISLAND RENDER HOOKS (§T.194) — the render-side twin of
 * `registerSierraFamily` (sierraArchetypes.ts, §T.187).
 *
 * A `kit:` island (the speedboat race kit, src/circuit) rides the whole sierra
 * pipeline for its terrain. What the sierra pipeline cannot know is what the
 * island IS: a granite rock garden in the surf, a dune cay, a drowned town's
 * knoll. Those differ at exactly the range a race boat sees them (5-30 m at
 * speed): tidal zonation on the rock, wrack and driftwood on the sand, rubble
 * on the knoll. So a kit registers ONE set of hooks here and island.ts /
 * islandMaterials.ts call them for `kit:` islands only.
 *
 * ADDITIVE BY CONSTRUCTION. Nothing here runs unless the heightmap's archetype
 * starts with `kit:` AND a kit registered hooks. A pirate or raft island never
 * reaches this module's hooks, so its heightmap, placements, draws and shader
 * programs are the ones it had (pinned by the T194 hash in
 * docs/speedboat/circuit.md and tests/kitIsland.test.ts).
 *
 * Params: `createRocks`, `createStructures` and the sierra cover read the
 * GLOBAL `islandParams` / `sierraParams`, not the island's resolved params —
 * so the §T.187 kit's `rockCount`/`cliffCount`/`structureSettlements`
 * overrides never reached them (the race islands grew pirate stilt huts).
 * island.ts now hands a `kit:` island's builders its RESOLVED island params,
 * and `sierraParams` below for the sierra side, without changing what every
 * other island reads.
 */
import type * as THREE from 'three/webgpu';
import type { SierraParams } from '../params/sierra';
import type { TerrainBlendMaterialHandle } from '../terrain';
import type { IslandHeightmap } from './heightmap';
import type { SierraAtlas } from './sierraAtlas';
import type { SierraRockMaterialHandle } from './sierraMaterial';

export function isKitArchetypeName(name: string | undefined): boolean {
  return typeof name === 'string' && name.startsWith('kit:');
}

/** the shared kit shader pair: ONE of each for the world, like the sierra pair (§T.132) */
export interface KitMaterialSet {
  terrain: TerrainBlendMaterialHandle;
  rock: SierraRockMaterialHandle;
  /** allocate/upload this island's kit layer (same layer index as its sierra atlas layer) */
  bind(hm: IslandHeightmap, layer: number): void;
  /** stamp per-island kit uniforms on every mesh under `root` (after the sierra tag) */
  tag(root: THREE.Object3D, hm: IslandHeightmap): void;
  update(frame: { time: number; waterLevel: number; swell: number; sunDirection: THREE.Vector3 }): void;
  dispose(): void;
}

/** what island.ts needs from the materials to build a kit island's props */
export interface KitDecorContext {
  seed: number;
  heightmap: IslandHeightmap;
  /** the kit rock material (zonation) for granite blocks; absent on an unshared island */
  rockMaterial?: THREE.Material;
  /** put a decor material on the island's aerial curve (§B67); absent on an unshared island */
  aerialOutput?: (material: THREE.Material) => void;
  castShadows: boolean;
}

export interface KitDecor {
  group: THREE.Object3D;
  /** meshes that straddle the water (flowfoam §V10 targets) */
  foamTargets: THREE.Object3D[];
  setLodDistance(cameraDistance: number): void;
  update?(frame: { time: number; waterLevel: number; sunDirection: THREE.Vector3 }): void;
  dispose(): void;
}

export interface KitIslandHooks {
  /** sierra params for this island's rocks, plants and cover (full object) */
  sierraParams(hm: IslandHeightmap, base: SierraParams): SierraParams;
  /** build the world's kit shader pair on first request */
  createMaterials(atlas: SierraAtlas): KitMaterialSet;
  /** kit-specific props (driftwood, rubble, blocks, dune grass); null = none */
  decorate(ctx: KitDecorContext): KitDecor | null;
}

let hooks: KitIslandHooks | null = null;

/**
 * Register the kit's hooks. One kit today (the race kit); a second registration
 * of a DIFFERENT object throws (§Rule 8) — two kits silently fighting over
 * which one renders every `kit:` island is the bug this refuses.
 */
export function registerKitIslandHooks(h: KitIslandHooks): void {
  if (hooks && hooks !== h) throw new Error('registerKitIslandHooks: a different kit already registered its hooks');
  hooks = h;
}

/** the hooks for this heightmap, or null (not a kit island, or no kit registered) */
export function kitHooksFor(hm: Pick<IslandHeightmap, 'archetype'>): KitIslandHooks | null {
  return hooks && isKitArchetypeName(hm.archetype) ? hooks : null;
}
