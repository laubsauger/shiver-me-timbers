/**
 * SPEEDBOAT entry (§T.181 S0). Boot only — scene construction is `speedboat/page/speedboatScene.ts`,
 * the per-tick/per-frame plumbing `speedboat/page/speedboatFrame.ts`, the player's physics
 * `speedboat/page/playerBoat.ts`, the NPC fleet's pipelined worker `speedboat/page/npcFleet.ts`.
 *
 * §V109: nothing reached from here imports main.ts, main-raft.ts, raft/, combat/ or ai/
 * (tests/speedboatIsolation.test.ts walks the graph).
 *
 * SEAMS (speedboat/page/seams.ts, docs/speedboat/page.md): controls §T.182, camera §T.182,
 * audio §T.183, HUD §T.185, course §T.187, crash/respawn §T.188 — each is ONE constructor call
 * below, swapped by its task.
 *
 * LOOP ORDER (§V2, `core/loop.ts` untouched):
 *   tick   controls → sea to tick time → PLAYER rigid6 step → crash hook → wake/jets on the sim
 *          pose → NPC tick record → NPC pump (collect if home, kick the next trailing tick)
 *   render sea → boats at interpolated poses → camera → post/render → HUD → audio → NPC pump
 */
import { TimestampQuery } from 'three/webgpu';
import { webgpuAvailable, renderGatePage } from './core/gate';
import { App } from './core/app';
import { GameLoop } from './core/loop';
import { installNodeTypeCache } from './core/nodeTypeCache';
import { createPostWarmGate, withFullCoverage } from './core/bootCompile';
import { bindResolution } from './core/bootSettings';
import { bootProgress, bootReady } from './core/bootSplash';
import { createPostPipeline } from './core/postPipeline';
import { createInitialState, type ShipState, type SimState } from './state/simState';
import { createDebugShell } from './debug';
import { createSky } from './sky';
import { oceanParams } from './ocean';
import { postParams } from './params/post';
import { weatherParams } from './params/weather';
import { createWeatherSample, createWeatherSystem } from './weather';
import { initGraphicsSettings, setFeatureSink } from './ui';
import { buildDeepVHull } from './speedboat/hullMesh';
import { openSeaCourse } from './speedboat/page/course';
import { speedboatSeaParams } from './speedboat/page/seaParams';
import { buildSpeedboatBoats, buildSpeedboatSea } from './speedboat/page/speedboatScene';
import { createPlayerBoat } from './speedboat/page/playerBoat';
import { createNpcFleetDriver } from './speedboat/page/npcFleet';
import { createSpeedboatFrame } from './speedboat/page/speedboatFrame';
import { createRaceCameraRig } from './camera/raceCam';
import { createRaceControls } from './speedboat/controls';
import { createSpeedboatAudioSink } from './audio/boat/pageSink';
import { createKnotsHud, createNoCrashes, installAudioUnlock } from './speedboat/page/stubs';
import type { BoatAudioFrame, HudModel } from './speedboat/page/seams';

/** rivals on the grid (design doc §2 slice: 7 NPCs) */
const NPC_COUNT = 7;
/** the ambient preset: 'swell' IS "Working sea" (weather/presets.ts WEATHER_PRESET_INFO) */
const DEFAULT_SEA = 'swell';

async function boot(): Promise<void> {
  installNodeTypeCache();
  const root = document.getElementById('app');
  if (!root) throw new Error('missing #app root');
  if (!(await webgpuAvailable())) {
    renderGatePage(root);
    return;
  }
  const settings = initGraphicsSettings();
  bootProgress('renderer');
  const app = await App.create(root);
  app.controls.enabled = false;
  bootProgress('scene build');
  const state: SimState = createInitialState(2100);

  // Working sea, no storm cells: the ambient preset applies everywhere and nothing drifts in (§V46)
  weatherParams.cellIntensity = 0;
  const weather = createWeatherSystem({ seed: state.seed, setWeather: (wx) => (state.weather = wx as SimState['weather']) });
  weather.apply(new URLSearchParams(location.search).get('weather') ?? DEFAULT_SEA, { lerpSeconds: 0 });
  const weatherHere = createWeatherSample();
  const debug = createDebugShell({ onWeatherPreset: (p) => weather.apply(p) });
  const sky = createSky({ scene: app.scene });
  sky.configureRenderer(app.renderer);

  const course = openSeaCourse(); // §T.187: course + archipelago hook
  const hull = buildDeepVHull();
  const seaParams = speedboatSeaParams(hull);
  const sea = buildSpeedboatSea(app, state, sky, weather, course, seaParams);
  const waterAt = (x: number, z: number): number => sea.cpuOcean.heightAt(x, z, state.time);

  const boat: ShipState = {
    id: 'player', kind: 'player',
    position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0],
    rudder: 0, sailTrim: 0, anchored: false, flood: 0, damage: {},
  };
  state.ships.push(boat);
  const player = createPlayerBoat({ hull, pressureHeadAt: (x, z, t) => sea.cpuOcean.pressureHeadAt(x, z, t) }, boat);
  player.place(course.spawn(0));

  bootProgress('boat models');
  const boats = await buildSpeedboatBoats(app, sea, NPC_COUNT);
  setFeatureSink('shadows', (on) => (sky.sunLight.castShadow = on));
  setFeatureSink('spray', (on) => {
    sea.spray.mesh.visible = on;
    boats.roosterTail.mesh.visible = on;
  });
  bindResolution(app.renderer, settings);

  // §T.178/§V110: same step, same sea params, off the main thread where the page allows it
  bootProgress('npc physics');
  const npcs = await createNpcFleetDriver({
    seed: state.seed, boats: NPC_COUNT, oceanParams, seaParams,
    spawn: (i) => course.spawn(i + 1),
  });

  const camera = createRaceCameraRig(app.camera, { player }); // §T.182
  const controls = createRaceControls({ player, camera, enabled: () => !camera.capturesInput() }); // §T.182
  const crash = createNoCrashes(); // §T.188
  const hud = createKnotsHud(); // §T.185
  const audio = createSpeedboatAudioSink({ camera: app.camera, npcs }); // §T.183
  installAudioUnlock(audio);
  const post = createPostPipeline(app.renderer, app.scene, app.camera, { sunDirection: () => sky.sunDirection });
  const usePost = createPostWarmGate({ enabled: () => postParams.enabled, warm: () => post.warmup() });

  const frame = createSpeedboatFrame({
    app, sea, boats, sky, state, player, npcs, weatherHere, waterAt,
    placeCamera: (view, dt) => camera.update(view, dt, waterAt),
  });
  let lastControls = controls.sample(0, boat);
  const hudModel: HudModel = { knots: 0, headingRad: 0, npcTransport: npcs.fleet.kind, npcLagTicks: 0 };
  const audioFrame: BoatAudioFrame = {
    frameDt: 0, view: frame.view, boat, controls: lastControls,
    contact: { wettedArea: 0, slamImpulse: 0, propImmersion: 0, driveThrust: player.hw.driveThrust },
  };
  const paused = false; // §T.185 pause menu

  const loop = new GameLoop(
    (dt) => {
      state.tick++;
      state.time += dt;
      state.wind.speed = oceanParams.windSpeed;
      state.wind.direction = oceanParams.windDirection;
      weather.update(dt);
      weather.weatherAt(boat.position[0], boat.position[2], weatherHere);
      lastControls = controls.sample(dt, boat);
      frame.tickSea();
      player.tick(lastControls, state.time, dt);
      const c = audioFrame.contact;
      c.wettedArea = player.hw.wettedArea;
      c.slamImpulse = player.hw.slamImpulse;
      c.propImmersion = player.hw.propImmersion;
      const ev = crash.tick(dt, boat, c);
      if (ev) {
        player.place(ev.respawn);
        frame.snap();
        camera.snap();
      }
      frame.tickBoat(dt);
      npcs.recordTick(state.tick, state.time);
      npcs.pump(state.tick);
    },
    (alpha, frameDt) => {
      debug.hud.frame(frameDt * 1000);
      frame.renderSea(frameDt, paused);
      const { headingRad, knots } = frame.renderBoats(alpha, frameDt);
      if (usePost()) {
        post.updateFromParams();
        post.render();
      } else {
        app.render();
      }
      debug.hud.setRenderStats(app.renderer.info.render);
      // App builds the renderer with trackTimestamp (§V.39): unresolved query pools overflow and warn
      void app.renderer.resolveTimestampsAsync(TimestampQuery.RENDER).catch(() => undefined);
      void app.renderer.resolveTimestampsAsync(TimestampQuery.COMPUTE).catch(() => undefined);
      hudModel.knots = knots;
      hudModel.headingRad = headingRad;
      hudModel.npcLagTicks = npcs.lagTicks;
      hud.update(hudModel);
      audioFrame.frameDt = frameDt;
      audioFrame.controls = lastControls;
      audio.update(audioFrame);
      npcs.pump(state.tick); // frame end: the worker steps inside the next frame's gap
    },
    () => paused,
  );

  bootProgress('shader compile');
  await withFullCoverage(app.scene, () =>
    Promise.all([postParams.enabled ? post.warmup() : app.renderer.compileAsync(app.scene, app.camera), sea.flowFoam.warmAsync(app.renderer)]),
  );
  bootProgress('first frame');
  sea.ocean.update(app.renderer, state.time);
  sea.foam.update(app.renderer);
  sea.clouds.update(state.time, sky.sunDirection);
  camera.update(frame.view, 0, waterAt);
  sea.surface.update(app.camera, state.time, sky.sunDirection);
  if (postParams.enabled) {
    post.updateFromParams();
    await post.presentAsync();
  } else {
    await app.renderer.renderAsync(app.scene, app.camera);
  }
  loop.start();
  bootReady();

  // console/browser-verification handle (§V22): read-only use expected
  (window as unknown as Record<string, unknown>).__speedboat = { app, state, sea, boats, player, npcs, controls, camera, hud, loop };
}

boot();
