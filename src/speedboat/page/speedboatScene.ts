/**
 * Speedboat page SCENE CONSTRUCTION (§T.181 S0): the shared sea, the boats' GLB instances and
 * the prop-wash spray. `main-speedboat.ts` owns the order; this file owns the calls.
 *
 * ORDER CONSTRAINTS (TSL bakes material graphs at construction, core/seaScene.ts header):
 *   buildSea (binds the caustics) → attachHullWetline → asset.instantiate (slot materials bake
 *   waterLighting + the wetline) → rooster tail.
 *
 * SEA: `buildSea` with the course hook's sites (open sea today, §T.187 later), the SIM wake
 * backend (§T W2b), one prop jet per drive for the sim foam (§T.180 c), and the page's speedboat
 * sea params (params/speedboatSea.ts, the same object the NPC fleet is built with).
 */
import type { Mesh } from 'three/webgpu';
import type { App } from '../../core/app';
import { buildSea } from '../../core/seaScene';
import { createRoosterTail } from '../../foam/roosterTail';
import type { SeaPhysicsParams } from '../../params/seaPhysics';
import type { SkyHandle } from '../../sky';
import type { SimState } from '../../state/simState';
import { WAKE_SPEEDBOAT_TIER } from '../../wake/wakeCalibration';
import type { WeatherSystem } from '../../weather';
import { FLEET_LIVERIES, HERO_BOAT_URL, HERO_LIVERY, createBoatAssetLoader, wetlineOptions, type BoatInstance, type BoatLivery } from '../assets';
import { HULL_DATA } from '../hullMesh';
import type { CourseHook } from './seams';

export function buildSpeedboatSea(app: App, state: SimState, sky: SkyHandle, weather: WeatherSystem, course: CourseHook, seaParams: SeaPhysicsParams) {
  return buildSea(app, state, sky, weather, {
    sites: course.sites,
    // the analytic wake ramp's scale — not evaluated on the sim backend (flowfoam WakeBackend)
    wakeSpeedScale: 1,
    // §T W2b: the wake surface is solved from the player's own contact load, fed in the fixed tick
    // (speedboatFrame.tickBoat). Tier: the speedboat's 448 m domain (256² × 1.75 m, ≈ 300 m of clear
    // water astern for the divergent arms at 40 m/s — docs/wake/w5c-speedboat-tier.md), as
    // wakeCalibration's 'speedboat-40' preset uses; same grid and dispatch count as the ship tier.
    wakeBackend: 'sim',
    wakeTier: WAKE_SPEEDBOAT_TIER,
    // §T.180 c: the sim foam compiles one jet slot per drive, so `flowFoam.setPropWash` lays the
    // prop wash ribbon the jets also force the wake solve with (`wakeSim.tick`)
    propJets: HULL_DATA.engines.length,
    seaParams,
  });
}
export type SpeedboatSea = ReturnType<typeof buildSpeedboatSea>;

/** rival paints: the fleet table's hues, numbers from the design doc's grid (#27 is the player's) */
export const NPC_NUMBERS = [9, 3, 11, 22, 44, 56, 8] as const;
const NPC_PAINTS = [FLEET_LIVERIES.yellow, FLEET_LIVERIES.turquoise, FLEET_LIVERIES.charcoal] as const;
export function npcLivery(i: number): BoatLivery {
  return { ...NPC_PAINTS[i % NPC_PAINTS.length], number: NPC_NUMBERS[i % NPC_NUMBERS.length] };
}

export async function buildSpeedboatBoats(app: App, sea: SpeedboatSea, npcCount: number) {
  const loader = await createBoatAssetLoader(app.renderer);
  const asset = await loader.load(HERO_BOAT_URL);
  // before instantiate: the slot materials bake the wetline into their graphs
  const wetline = sea.caustics.attachHullWetline(wetlineOptions(asset.extras));
  const fov = app.camera.fov;
  const hero = asset.instantiate({ variant: 'hero', water: true, livery: HERO_LIVERY, fovDeg: fov });
  const npcs: BoatInstance[] = [];
  for (let i = 0; i < npcCount; i++) npcs.push(asset.instantiate({ variant: 'npc', water: true, livery: npcLivery(i), fovDeg: fov }));
  for (const b of [hero, ...npcs]) app.scene.add(b.object);

  // §T.180 c: surface-piercing props throw a rooster tail, from the same per-drive results as the wash
  const roosterTail = createRoosterTail();
  app.scene.add(roosterTail.mesh);
  sea.reflection?.excludeFromReflection(roosterTail.mesh as unknown as Mesh);

  return { loader, asset, wetline, hero, npcs, roosterTail };
}
export type SpeedboatBoats = Awaited<ReturnType<typeof buildSpeedboatBoats>>;
