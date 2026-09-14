/**
 * RACE KIT RENDER WIRING (§T.194): registers the kit's island hooks
 * (src/island/kitIsland.ts) — its surface masks, shader pair, sierra look and
 * props — for every `kit:` island the circuit builds. Registration is cheap
 * (no GPU work, no bakes); everything below runs lazily, per island, when the
 * archipelago builds it.
 */
import { registerKitIslandHooks, type KitIslandHooks } from '../island/kitIsland';
import type { IslandHeightmap } from '../island/heightmap';
import { bakeKitSurface, type KitKind, type KitSurfaceMask } from './kitSurface';
import { createKitMaterialSet, kitSierraParams } from './kitMaterial';
import { createKitDecor } from './kitDecor';
import type { KitSpec } from './kitFamilies';

export interface KitRenderInfo {
  kind: KitKind;
  /** the island's spec in its world-aligned local frame */
  spec: KitSpec;
  /** unit swell travel direction, world frame */
  swellTravel: readonly [number, number];
  seed: number;
  /** the lap's reference line in the island's LOCAL frame (closed polyline), and the clearance props keep from it (m) */
  corridor: readonly (readonly [number, number])[];
  corridorClearance: number;
}

const INFO = new Map<string, KitRenderInfo>();
const MASKS = new WeakMap<IslandHeightmap, KitSurfaceMask>();

export function kitRenderInfo(hm: Pick<IslandHeightmap, 'archetype'>): KitRenderInfo {
  const info = INFO.get(hm.archetype as string);
  if (!info) throw new Error(`kitRender: no render info for '${String(hm.archetype)}' (register it with registerKitRenderInfo)`); // §Rule 8
  return info;
}

export function kitSurfaceFor(hm: IslandHeightmap): KitSurfaceMask {
  let m = MASKS.get(hm);
  if (!m) {
    const info = kitRenderInfo(hm);
    m = bakeKitSurface(hm, { kind: info.kind, swellTravel: info.swellTravel, seed: info.seed });
    MASKS.set(hm, m);
  }
  return m;
}

const HOOKS: KitIslandHooks = {
  sierraParams: (hm, base) => {
    const info = kitRenderInfo(hm);
    const p = kitSierraParams(base);
    // plants: sparse and salt-tolerant. No pine forest on a sand cay or in the surf.
    // plants: sparse and salt-tolerant — bunchgrass and a little deadfall, no conifers in the surf.
    // (The pine/juniper/manzanita batches are also the ones measured drawing floating instances on
    // the kit islands headless — see circuit.md §T194 — so they stay at zero here.)
    const noTrees = { pineDensity: 0, juniperDensity: 0, manzanitaDensity: 0, understoryConeDensity: 0 };
    switch (info.kind) {
      case 'sandCay':
        return { ...p, ...noTrees, understoryDeadfallDensity: base.understoryDeadfallDensity * 0.3, understoryGrassDensity: base.understoryGrassDensity * 2.2 };
      case 'rockGarden':
        return { ...p, ...noTrees, understoryDeadfallDensity: 0, understoryGrassDensity: base.understoryGrassDensity * 0.8 };
      case 'drownedTown':
        return { ...p, ...noTrees, understoryGrassDensity: base.understoryGrassDensity * 1.8 };
    }
  },
  createMaterials: (atlas) => createKitMaterialSet(atlas, { maskFor: kitSurfaceFor }),
  decorate: (ctx) => createKitDecor(ctx, kitRenderInfo(ctx.heightmap), kitSurfaceFor(ctx.heightmap)),
};

/** record what a kit island is (towerReachSites calls this per island) and make sure the hooks are live */
export function registerKitRenderInfo(name: string, info: KitRenderInfo): void {
  INFO.set(name, info);
  registerKitIslandHooks(HOOKS);
}
