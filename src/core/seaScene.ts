/**
 * Mode-neutral SEA construction (§T.164 precursor, §V95): everything the raft
 * entry used to build in `buildRaftSea` except the three decisions that belong
 * to the vessel, which arrive as options — the island sites, the wake ramp's
 * speed scale and the physics params the CPU mirror is built with.
 *
 * TSL bakes material graphs at construction, so the order below is an
 * ORDERING constraint, not a preference (see `raft/raftScene.ts` header):
 *
 *   caustics → bound BEFORE any receiver material (ship, terrain, deck water)
 *   archipelago → its seabed feeds the ocean material and the §V.8 mirror
 *   fetch field → built from the seabed, handed to surface, mirror, terrain
 *   clouds → the planar reflection needs their blurred RT at construction
 *   reflection → the ocean material samples it, so it exists before the surface
 *
 * It calls `setActiveCaustics`, so a page builds exactly one sea.
 * §V81: nothing here reaches main.ts, combat/ or ai/.
 */
import type { Mesh } from 'three/webgpu';
import type { App } from './app';
import type { SimState } from '../state/simState';
import type { SkyHandle } from '../sky';
import type { WeatherSystem } from '../weather';
import { createOceanSim, oceanParams } from '../ocean';
import { OceanSurface } from '../ocean/oceanSurface';
import { createFoamSim, createSpray, createBowSpray } from '../foam';
import { createFlowFoam } from '../flowfoam';
import { createClouds } from '../clouds';
import { createCaustics, setActiveCaustics } from '../caustics';
import { createArchipelago, type IslandSite } from '../island';
import { createFetchField } from '../ocean/fetchField';
import { createPlanarReflection } from '../reflection';
import { createRain } from '../rain';
import { CpuOcean } from '../sea-physics/cpuOcean';
import type { SeaPhysicsParams } from '../params/seaPhysics';

export interface SeaOptions {
  /** the islands this page sails among */
  sites: IslandSite[];
  /** `flowFoam.setSpeedScale`: the wake ramp is tuned on the galleon's speed */
  wakeSpeedScale: number;
  /**
   * the params the §V.8 CPU mirror is built with. Its `hullDraft` is the
   * §V.68 Smith depth every pressure read is attenuated at, so this must be
   * the SAME object the vessel's buoyancy steps with (§T.173)
   */
  seaParams: SeaPhysicsParams;
}

export function buildSea(app: App, state: SimState, sky: SkyHandle, weather: WeatherSystem, opts: SeaOptions) {
  const ocean = createOceanSim(state.seed);
  const bands = ocean.cascades.map((c) => ({
    displacement: c.displacement,
    derivatives: c.derivatives,
    domain: c.domain,
  }));
  const foam = createFoamSim(bands, oceanParams.resolution, ocean);
  const flowFoam = createFlowFoam();
  flowFoam.setSpeedScale(opts.wakeSpeedScale);
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
  const archipelago = createArchipelago({ seed: state.seed, sites: opts.sites });
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
  const cpuOcean = new CpuOcean(state.seed, oceanParams, opts.seaParams, ocean.spectrum);
  cpuOcean.setSeabed(archipelago.seabed, -archipelago.seabed.openHeight);
  caustics.setSeabedOpenDepth(-archipelago.seabed.openHeight);
  caustics.setFetchField(fetchField);
  cpuOcean.setFetch(fetchField);
  cpuOcean.setWakeField(flowFoam);

  return {
    ocean, foam, flowFoam, clouds, caustics, archipelago, fetchField, reflection,
    surface, spray, bowSpray, rain, cpuOcean,
  };
}
export type Sea = ReturnType<typeof buildSea>;
