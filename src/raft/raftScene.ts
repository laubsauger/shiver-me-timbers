/**
 * Raft-entry scene construction (§T.98): the SEA and the VESSEL, built in the
 * order the pirate boot (`src/main.ts`) established and for the same reasons,
 * condensed. TSL bakes material graphs at construction, so every dependency
 * below is an ORDERING constraint, not a preference:
 *
 *   caustics → bound BEFORE any receiver material (ship, terrain, deck water)
 *   archipelago → its seabed feeds the ocean material and the §V.8 mirror
 *   fetch field → built from the seabed, handed to surface, mirror, terrain
 *   clouds → the planar reflection needs their blurred RT at construction
 *   reflection → the ocean material samples it, so it exists before the surface
 *   deck water → bound BEFORE the ShipAssembly (the deck material reads it)
 *
 * The raft boot OWNS `setActiveCaustics`/`setActiveDeckWater` (§I raft/app):
 * it is a separate page, so the singletons are its own.
 *
 * Everything is added to the scene immediately — no §T.40 staged warm-up.
 * The entry has one ship and no combat, so the whole scene is the first
 * picture, and one `compileAsync` pays for all of it once.
 */
import type { Mesh } from 'three/webgpu';
import type { App } from '../core/app';
import type { SimState } from '../state/simState';
import type { SkyHandle } from '../sky';
import type { WeatherSystem } from '../weather';
import { createOceanSim, oceanParams } from '../ocean';
import { OceanSurface } from '../ocean/oceanSurface';
import { createFoamSim, createSpray, createBowSpray } from '../foam';
import { createFlowFoam } from '../flowfoam';
import { createClouds } from '../clouds';
import { createCaustics, setActiveCaustics } from '../caustics';
import { createArchipelago } from '../island';
import { generateSierraSites } from '../island/sierraSites';
import { createFetchField } from '../ocean/fetchField';
import { createPlanarReflection } from '../reflection';
import { createRain } from '../rain';
import { CpuOcean } from '../sea-physics/cpuOcean';
import { createHullContact, waterlineFromBlueprint, waterlineFromBox } from '../sea-physics/hullContact';
import { seaPhysicsParams } from '../params/seaPhysics';
import { ShipAssembly } from '../ship/shipAssembly';
import { createDeckFieldTexture } from '../ship/deckFieldTexture';
import { createPieceMaterialCache } from '../core/bootShared';
import { buildRaftBlueprint } from '../ship/raftBlueprint';
import { buildRaftDeckField } from '../ship/raftDeckField';
import { createDeckWater, setActiveDeckWater } from '../deckwater';
import { createRopes } from '../ropes';
import { applyRiggingPlan, buildBlockDescriptors } from '../ropes/shipRigging';
import { buildRaftRiggingPlan } from '../ship/raftRigging';
import { buildRatlinePlan } from '../ship/ratlinePlan';
import { buildRungDescriptors } from '../ropes/ratlines';
import { ropeParams } from '../params/ropes';
import { raftMaterialParams } from '../params/raftMaterials';
import { blueprintAabb } from '../ship/previewRaft';

export function buildRaftSea(app: App, state: SimState, sky: SkyHandle, weather: WeatherSystem) {
  const ocean = createOceanSim(state.seed);
  const bands = ocean.cascades.map((c) => ({
    displacement: c.displacement,
    derivatives: c.derivatives,
    domain: c.domain,
  }));
  const foam = createFoamSim(bands, oceanParams.resolution, ocean);
  const flowFoam = createFlowFoam();
  const clouds = createClouds({
    renderer: app.renderer,
    camera: app.camera,
    seed: state.seed,
    stormAt: weather.stormAt,
    stormCellsNear: weather.stormCellsNear,
  });
  clouds.attachTo(app.scene);
  const caustics = createCaustics(ocean, { sunLight: sky.sunLight });
  setActiveCaustics(caustics);
  // §T.99 / §T.109: the raft sails the Sierra slices, not the pirate sites
  const sierra = generateSierraSites(state.seed);
  const archipelago = createArchipelago({ seed: state.seed, sites: sierra.sites });
  app.scene.add(archipelago.group);
  const fetchField = createFetchField(archipelago.seabed);
  const reflection = createPlanarReflection({
    sunLight: sky.sunLight,
    planeY: 0,
    clouds: {
      blurred: clouds.blurredTexture,
      seed: state.seed,
      sunColorLive: clouds.sunColorLive,
      skyColorLive: clouds.skyColorLive,
      sunDirLive: clouds.sunDirLive,
      shaftSlots: clouds.shaftSlotsLive,
    },
  });
  const surface = new OceanSurface(ocean, foam, flowFoam, {
    sunLight: sky.sunLight,
    seabed: archipelago.seabed,
    fetch: fetchField,
    reflection,
    skyDomeColor: sky.skyDomeColor,
    skySunTerm: sky.skySunTerm,
  });
  app.scene.add(surface.group);
  surface.group.traverse((o) => {
    if ((o as Mesh).isMesh) o.receiveShadow = true;
  });
  const spray = createSpray(bands, oceanParams.resolution);
  const bowSpray = createBowSpray();
  const rain = createRain();
  app.scene.add(spray.mesh, bowSpray.mesh, rain.mesh);
  reflection?.attachTo(app.scene);
  reflection?.excludeFromReflection(clouds.compositeQuad);
  reflection?.excludeFromReflection(spray.mesh);
  reflection?.excludeFromReflection(bowSpray.mesh);

  // §V.8: the mirror floats the hull on the SAME spectrum, seabed, fetch and wake
  const cpuOcean = new CpuOcean(state.seed, oceanParams, seaPhysicsParams, ocean.spectrum);
  cpuOcean.setSeabed(archipelago.seabed, -archipelago.seabed.openHeight);
  caustics.setSeabedOpenDepth(-archipelago.seabed.openHeight);
  caustics.setFetchField(fetchField);
  cpuOcean.setFetch(fetchField);
  cpuOcean.setWakeField(flowFoam);

  return {
    ocean, foam, flowFoam, clouds, caustics, archipelago, fetchField, reflection, sierra,
    surface, spray, bowSpray, rain, cpuOcean,
  };
}
export type RaftSea = ReturnType<typeof buildRaftSea>;

export function buildRaftVessel(app: App, sea: RaftSea) {
  const blueprint = buildRaftBlueprint();
  // the raft writer's field (§T.92), never the galleon's (§V.18): it serves
  // the walker, the deck-water solver and the plank relief alike
  const deckField = buildRaftDeckField(blueprint);
  const deckWater = createDeckWater({ source: deckField });
  setActiveDeckWater(deckWater);
  // §T.40's one-set-per-class cache, the same factory main.ts builds (§V95)
  const materials = createPieceMaterialCache(createDeckFieldTexture(deckField));
  const assembly = new ShipAssembly(blueprint, materials);
  assembly.setSailTint(raftMaterialParams.sailTint);
  assembly.group.traverse((o) => {
    if (o.name.startsWith('hull') || o.name.includes('-hull') || o.name.startsWith('log')) {
      o.userData.foamTarget = true;
    }
    if ((o as Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  app.scene.add(assembly.group);

  const riggingPlan = buildRaftRiggingPlan(blueprint);
  const rungs = buildRungDescriptors(buildRatlinePlan(blueprint), riggingPlan);
  const blocks = buildBlockDescriptors(riggingPlan, ropeParams.maxBlocks);
  const ropes = createRopes({ maxRopes: Math.max(riggingPlan.length, 32), rungs, blocks });
  ropes.mesh.castShadow = true;
  app.scene.add(ropes.mesh);
  sea.reflection?.excludeFromReflection(ropes.mesh);

  // the loft finds no hull-section on nine logs (§T.91: null → box fallback)
  const box = blueprintAabb(blueprint);
  const beamHalf = Math.max(box.max[0], -box.min[0]);
  const hullWaterline = waterlineFromBlueprint(blueprint) ?? waterlineFromBox(box.max[2], box.min[2], beamHalf);
  const hullContact = createHullContact(hullWaterline);
  const stemZ = hullWaterline.bowZ;
  const transomZ = hullWaterline.sternZ;
  const wetline = sea.caustics.attachHullWetline({ bowZ: stemZ, sternZ: transomZ });

  /** per frame: re-anchor every rope on the live sockets and re-solve (§V.12) */
  const updateRopes = (furl: number): void => {
    assembly.group.updateMatrixWorld(true);
    applyRiggingPlan(riggingPlan, ropes, (id) => assembly.socketWorldPosition(id), furl);
    ropes.update();
    app.renderer.compute(ropes.computeNode);
  };

  return {
    blueprint, deckField, assembly, deckWater, ropes, riggingPlan, hullContact, wetline,
    stemZ, transomZ, beamHalf, updateRopes,
  };
}
export type RaftVessel = ReturnType<typeof buildRaftVessel>;
