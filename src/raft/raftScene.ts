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
import { raftWakeParams } from '../params/raftSailing';
import type { Mesh } from 'three/webgpu';
import type { App } from '../core/app';
import type { SimState } from '../state/simState';
import type { SkyHandle } from '../sky';
import type { WeatherSystem } from '../weather';
import { buildSea } from '../core/seaScene';
import { generateSierraSites } from '../island/sierraSites';
import { createHullContact, waterlineFromBlueprint, waterlineFromBox } from '../sea-physics/hullContact';
import { raftSeaParams } from '../params/seaPhysics';
import { ShipAssembly } from '../ship/shipAssembly';
import { createDeckFieldTexture } from '../ship/deckFieldTexture';
import { createPieceMaterialCache } from '../core/bootShared';
import { buildRaftBlueprint } from '../ship/raftBlueprint';
import { buildRaftDeckField } from '../ship/raftDeckField';
import { WAKE_RAFT_TIER } from '../wake/wakeCalibration';
import type { WakeBackend } from '../flowfoam';
import { createDeckWater, setActiveDeckWater } from '../deckwater';
import { createRopes } from '../ropes';
import { applyRiggingPlan, buildBlockDescriptors } from '../ropes/shipRigging';
import { raftBlockSize } from '../ship/raftRigging';
import { buildRaftRiggingPlan } from '../ship/raftRigging';
import { buildRatlinePlan } from '../ship/ratlinePlan';
import { buildRungDescriptors } from '../ropes/ratlines';
import { ropeParams } from '../params/ropes';
import { raftMaterialParams } from '../params/raftMaterials';
import { blueprintAabb } from '../ship/previewRaft';
import { createRaftLanterns } from '../ship/raftLanterns';
import { createRaftLook, type RaftLookTier } from '../ship/raftLook';
import { dressRaft } from '../ship/raftDress';

/**
 * §T W2b: the raft sails on the SIM wake. `raft.html?wake=analytic` builds the
 * pre-W2b analytic surface instead (and its §V.8 mirror coupling) — the A/B
 * leg for docs/wake/w2b-integration.md's frame-time and look checks. A boot
 * choice, not a live knob: TSL bakes the advect graph at construction.
 */
export function raftWakeBackend(search: string): WakeBackend {
  return new URLSearchParams(search).get('wake') === 'analytic' ? 'analytic' : 'sim';
}

export function buildRaftSea(app: App, state: SimState, sky: SkyHandle, weather: WeatherSystem) {
  // §T.99 / §T.109: the raft sails the Sierra slices, not the pirate sites
  const sierra = generateSierraSites(state.seed);
  const sea = buildSea(app, state, sky, weather, {
    sites: sierra.sites,
    // §T.161: the wake ramp is the galleon's; this raft sails at a third her
    // speed and never developed one on the shipped thresholds. Since §T W2b it
    // scales the analytic FOAM and SLICK doses only (still analytic until W5,
    // §T.171) — the wake's surface below is solved, not ramped
    wakeSpeedScale: raftWakeParams.speedScale,
    // §T W2b / §T.169: the wake's SURFACE is the eWave solve of her own station
    // pressures (`raftFrame.tickSea` feeds it), on her 0.5 m tier; visual-only
    // until §T.170, so the mirror below carries no wake (§V8 amendment)
    wakeBackend: raftWakeBackend(typeof location === 'undefined' ? '' : location.search),
    wakeTier: WAKE_RAFT_TIER,
    // §T.173/§V.68: the mirror's Smith depth is HER draft (0.3 m), the same
    // params object `raftFrame.tickSea` steps her buoyancy with — the galleon's
    // 2.0 m low-passed every wave she feels as if she drew seven times as much
    seaParams: raftSeaParams,
  });
  return { ...sea, sierra };
}
export type RaftSea = ReturnType<typeof buildRaftSea>;

/**
 * `quality`: the graphics preset (ui/settingsStore). THE RAFT'S LOOK is the film's (the user, 2026-10-29: "ONE raft
 * for game and film … the game's raft to use the same improved assets"): ship/raftLook.ts's scanned surfaces,
 * raftDress.ts's worn geometry, frame and interior, raftStores.ts's stores, raftSailWear.ts's sewn sails — the
 * preset sets only what they cost (RaftLookTier: the parallax march's steps), never what they are.
 * `?raftplain` builds the raft as it was, undressed (an A/B).
 */
export function buildRaftVessel(app: App, sea: RaftSea, o: { quality?: RaftLookTier } = {}) {
  const blueprint = buildRaftBlueprint();
  // the raft writer's field (§T.92), never the galleon's (§V.18): it serves
  // the walker, the deck-water solver and the plank relief alike
  const deckField = buildRaftDeckField(blueprint);
  const deckWater = createDeckWater({ source: deckField });
  setActiveDeckWater(deckWater);
  // §T.40's one-set-per-class cache, the same factory main.ts builds (§V95)
  const materials = createPieceMaterialCache(createDeckFieldTexture(deckField));
  const plain = typeof location !== 'undefined' && new URLSearchParams(location.search).has('raftplain');
  const look = plain ? null : createRaftLook(materials, { tier: o.quality ?? 'medium' });
  const assembly = new ShipAssembly(blueprint, look?.factory ?? materials);
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
  // …worn, framed, furnished and stowed (the stores load after: `ready`)
  const dressed = look ? dressRaft(assembly.group, blueprint, look.factory, { tier: o.quality ?? 'medium' }) : null;
  look?.track(assembly.group);
  const ready = Promise.all([look?.ready, dressed?.ready]).then(() => undefined);
  // the lanterns under the roof's corners, lit at dusk (raftFrame updates them from the Sun)
  const lanterns = createRaftLanterns();
  assembly.group.add(lanterns.group);

  const riggingPlan = buildRaftRiggingPlan(blueprint);
  const rungs = buildRungDescriptors(buildRatlinePlan(blueprint), riggingPlan);
  // §T.140/§V66: a block is sized by the rope it is seized into, and the raft's
  // gear is 20 mm where the galleon's is 56 — the same shell read as a ship's
  // block on a raft's line ("the rope blocks look oversized for this boat")
  const blocks = buildBlockDescriptors(riggingPlan, ropeParams.maxBlocks,
    ropeParams.blockAnchorT, raftBlockSize);
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
    stemZ, transomZ, beamHalf, updateRopes, lanterns, ready,
  };
}
export type RaftVessel = ReturnType<typeof buildRaftVessel>;
