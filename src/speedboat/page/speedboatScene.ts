/**
 * Speedboat page SCENE CONSTRUCTION (§T.181 S0): the shared sea, the boats' GLB instances and
 * the prop-wash spray. `main-speedboat.ts` owns the order; this file owns the calls.
 *
 * ORDER CONSTRAINTS (TSL bakes material graphs at construction, core/seaScene.ts header):
 *   buildSea (binds the caustics) → attachHullWetline → asset.instantiate (slot materials bake
 *   waterLighting + the wetline; hero, NPCs, pace boat) → rooster tail.
 *
 * SEA: `buildSea` with the course hook's sites (open sea today, §T.187 later), the SIM wake
 * backend (§T W2b), one prop jet per drive for the sim foam (§T.180 c), and the page's speedboat
 * sea params (params/speedboatSea.ts, the same object the NPC fleet is built with).
 */
import type { Mesh } from 'three/webgpu';
import type { App } from '../../core/app';
import { buildSea } from '../../core/seaScene';
import { createBoatLightPool, setActiveBoatLightPool } from '../../ocean/boatLightPool';
import { createHullMask, setActiveHullMask } from '../../ocean/hullVolumeMask';
import type { SeaPhysicsParams } from '../../params/seaPhysics';
import type { SkyHandle } from '../../sky';
import type { SimState } from '../../state/simState';
import { WAKE_SPEEDBOAT_TIER } from '../../wake/wakeCalibration';
import { createVesselFx } from '../../wake/vesselFx';
import type { WeatherSystem } from '../../weather';
import { HERO_BOAT_URL, HERO_LIVERY, createBoatAssetLoader, wetlineOptions, type BoatInstance, type BoatLivery } from '../assets';
import { HULL_DATA } from '../hullMesh';
import { COMMUNITY_PAINTS, RIVALS } from '../ui/roster';
import { liveryFor } from './liveries';
import { createPaceBoat } from './paceBoat';
import { createBoatLights } from './boatLights';
import type { CourseHook } from './seams';

export function buildSpeedboatSea(app: App, state: SimState, sky: SkyHandle, weather: WeatherSystem, course: CourseHook, seaParams: SeaPhysicsParams) {
  // §T.209: the boats' LED light pools are baked into the ocean's colour graph, so the pool is active BEFORE buildSea
  // (and stays active: a rebuilt surface keeps its pools). ocean/boatLightPool.ts
  const boatLightPool = createBoatLightPool();
  setActiveBoatLightPool(boatLightPool);
  // hull volume mask: baked into the ocean and every spray pool (the crest spray inside buildSea, the boats' pools in
  // createVesselFx), fed by each boat's depth cap at render (ocean/hullVolumeMask.ts, assets/waterMask.ts)
  // `?hullmask=0` builds without it (perf A/B and a kill switch; the depth caps still lid the wells)
  const maskOff = typeof location !== 'undefined' && new URLSearchParams(location.search).get('hullmask') === '0';
  setActiveHullMask(maskOff ? undefined : createHullMask());
  const sea = buildSea(app, state, sky, weather, {
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
  return Object.assign(sea, { boatLightPool });
}
export type SpeedboatSea = ReturnType<typeof buildSpeedboatSea>;

/**
 * §T.191 rival paints: NPC i is racerId i + 1, the HUD roster's RIVALS[i] — its community paint (page/liveries.ts,
 * all eight on the one hull mask) and its race number, so the hull, the plotter dot and the standings agree.
 */
export const NPC_NUMBERS: readonly number[] = RIVALS.map((r) => r.number);
export function npcLivery(i: number): BoatLivery {
  const r = RIVALS[i % RIVALS.length];
  const paint = COMMUNITY_PAINTS.find((p) => p.community === r.community);
  return liveryFor(paint ? paint.id : 'signal', r.number);
}

/** §T177 wetline atlas slots: the player is 0, rival i is 1 + i, the marshal skiff is last */
export const WETLINE_HERO_SLOT = 0;
export function wetlineSlotOfNpc(i: number): number {
  return WETLINE_HERO_SLOT + 1 + i;
}

export interface SpeedboatBoatsOptions {
  /** CPU water height at the current sim time (the pace boat sits on it); default flat water */
  waterAt?: (x: number, z: number) => number;
}

export async function buildSpeedboatBoats(app: App, sea: SpeedboatSea, npcCount: number, opts: SpeedboatBoatsOptions = {}) {
  const loader = await createBoatAssetLoader(app.renderer);
  const asset = await loader.load(HERO_BOAT_URL);
  // before instantiate: the slot materials bake the wetline into their graphs.
  // §T177: ONE slot per hull on the page — hero, every rival, and the marshal skiff. Eight boats share seven
  // materials, so a single-slot atlas would paint every rival with the HERO's boot-top; the drawn object picks its
  // own pair of rows through `userData.wetlineSlot` (caustics/waterLighting.ts). Still one texture, one binding.
  const slots = 2 + npcCount;
  const wetline = sea.caustics.attachHullWetline({ ...wetlineOptions(asset.extras), slots });
  const fov = app.camera.fov;
  const hero = asset.instantiate({ variant: 'hero', water: true, livery: HERO_LIVERY, fovDeg: fov });
  const npcs: BoatInstance[] = [];
  for (let i = 0; i < npcCount; i++) npcs.push(asset.instantiate({ variant: 'npc', water: true, livery: npcLivery(i), fovDeg: fov }));
  for (const b of [hero, ...npcs]) app.scene.add(b.object);
  // §T.191 rolling start: the marshal skiff, also after the wetline (hidden until RaceState.paceBoat is set)
  const pace = createPaceBoat(app, asset, opts.waterAt ?? (() => 0));
  // slot 0 = hero, 1…npcCount = rivals, npcCount + 1 = the skiff (speedboatFrame feeds them; §T177)
  hero.object.userData.wetlineSlot = WETLINE_HERO_SLOT;
  for (let i = 0; i < npcs.length; i++) npcs[i].object.userData.wetlineSlot = WETLINE_HERO_SLOT + 1 + i;
  pace.instance.object.userData.wetlineSlot = slots - 1;

  // §T.195 (docs/wake/w6-multivessel.md): every boat's wake sources, prop ribbons, bow sheet, rooster tail and prop
  // bubbles — the player's from her contact, the rivals' from the worker's per-step FX record — one pool each
  const vesselFx = createVesselFx({ scene: app.scene, flowFoam: sea.flowFoam, reflection: sea.reflection as unknown as { excludeFromReflection(o: Mesh): void } | null });

  // §T.209 LEDs: strips (slot materials), water pools, underwater glow, the player's two real lights (page/boatLights.ts)
  const lights = createBoatLights({ scene: app.scene, pool: sea.boatLightPool, hero, npcs, extras: asset.extras });

  return { loader, asset, wetline, hero, npcs, pace, vesselFx, lights };
}
export type SpeedboatBoats = Awaited<ReturnType<typeof buildSpeedboatBoats>>;
