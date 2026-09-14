/**
 * SPEEDBOAT entry (§T.181 S0 → §T.191 one playable race). Boot only — scene construction is
 * `speedboat/page/speedboatScene.ts`, the course world `page/course.ts`, the fixed-tick race `page/raceSession.ts`,
 * the per-tick/per-frame plumbing `page/speedboatFrame.ts`, the NPC fleet's pipelined worker `page/npcFleet.ts`,
 * the HUD and screens `page/raceUi.ts`.
 *
 * §V109: nothing reached from here imports main.ts, main-raft.ts, raft/, combat/ or ai/
 * (tests/speedboatIsolation.test.ts walks the graph).
 *
 * LOOP ORDER (§V2, `core/loop.ts` untouched):
 *   tick   sea to tick time → race session (controls → collide → player physics → crash → race → outputs)
 *          → wake/jets on the sim pose → NPC pump (collect if home, kick every owed tick)
 *   render sea → boats + pilots + pace boat at interpolated poses → furniture → post/render → HUD → audio → NPC pump
 *   pause  select, pause and results screens, and `session.holdSim` (the race's tick-delay guarantee)
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
import { createCourseFurniture } from './circuit/courseFurniture';
import { buildPilotSetup } from './race/ai/pilot';
import { buildDeepVHull } from './speedboat/hullMesh';
import { respawnClear, towerReachCourse } from './speedboat/page/course';
import { speedboatSeaParams } from './speedboat/page/seaParams';
import { buildSpeedboatBoats, buildSpeedboatSea } from './speedboat/page/speedboatScene';
import { createPlayerBoat } from './speedboat/page/playerBoat';
import { createNpcFleetDriver } from './speedboat/page/npcFleet';
import { createSpeedboatFrame } from './speedboat/page/speedboatFrame';
import { createPilots, type Pilots } from './speedboat/page/pilotRig';
import { createDashMount } from './speedboat/page/dashMount';
import { createRaceSession, RIVAL_ARCHETYPES } from './speedboat/page/raceSession';
import { createAutopilotControls } from './speedboat/page/autopilot';
import { createRaceUi } from './speedboat/page/raceUi';
import { createBoatPreview } from './speedboat/page/boatPreview';
import { createPageChrome } from './speedboat/page/pageChrome';
import { createRaceHudFrame } from './speedboat/page/raceHudFrame';
import { engineVolumes, radioLevel, SEA_PRESET } from './speedboat/page/raceSettings';
import { liveryFor } from './speedboat/page/liveries';
import { createRaceCameraRig } from './camera/raceCam';
import { createRaceControls } from './speedboat/controls';
import { createSpeedboatAudioSink } from './audio/boat/pageSink';
import { installAudioUnlock } from './speedboat/page/stubs';
import type { BoatAudioFrame } from './speedboat/page/seams';

/** rivals on the grid (design doc §2 slice: 7 NPCs) */
const NPC_COUNT = 7;

/** the boot phase, on the splash AND readable as `__speedboatStage` (a boot that stalls or throws says where) */
const stage = (label: string): void => {
  (window as unknown as Record<string, unknown>).__speedboatStage = `${label} @${Math.round(performance.now())}ms`;
  bootProgress(label);
};

async function boot(): Promise<void> {
  installNodeTypeCache();
  const root = document.getElementById('app');
  if (!root) throw new Error('missing #app root');
  if (!(await webgpuAvailable())) {
    renderGatePage(root);
    return;
  }
  const settings = initGraphicsSettings();
  stage('renderer');
  const app = await App.create(root);
  app.controls.enabled = false;
  stage('scene build');
  const state: SimState = createInitialState(2100);
  const query = new URLSearchParams(location.search);

  // the course's own sea (Tower Reach: Calm, the start in the lee); no storm cells drift in (§V46)
  const course = towerReachCourse(); // §T.187/§T.191: sites now, the world after buildSea
  weatherParams.cellIntensity = 0;
  const weather = createWeatherSystem({ seed: state.seed, setWeather: (wx) => (state.weather = wx as SimState['weather']) });
  weather.apply(query.get('weather') ?? course.seaPreset, { lerpSeconds: 0 });
  const weatherHere = createWeatherSample();
  const chrome = createPageChrome(); // §T.201: dev overlays hidden unless ?dev / remembered; F, Alt+Enter, Tab/F1
  const debug = createDebugShell({ onWeatherPreset: (p) => weather.apply(p) });
  const sky = createSky({ scene: app.scene });
  sky.configureRenderer(app.renderer);

  const hull = buildDeepVHull();
  const seaParams = speedboatSeaParams(hull);
  const sea = buildSpeedboatSea(app, state, sky, weather, course, seaParams);
  const waterAt = (x: number, z: number): number => sea.cpuOcean.heightAt(x, z, state.time);
  const world = course.attach(sea); // Tower Reach world, worker world data, colliders, bed; mirror on the grid seabed
  stage('course furniture');
  const furniture = await createCourseFurniture({ renderer: app.renderer, data: world.world.furniture, course: world.world.course, seabedAt: world.world.seabedAt });
  app.scene.add(furniture.group);

  const boat: ShipState = {
    id: 'player', kind: 'player',
    position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0],
    rudder: 0, sailTrim: 0, anchored: false, flood: 0, damage: {},
  };
  state.ships.push(boat);
  const player = createPlayerBoat({ hull, pressureHeadAt: (x, z, t) => sea.cpuOcean.pressureHeadAt(x, z, t) }, boat);
  player.place(course.spawn(0));

  stage('boat models');
  const boats = await buildSpeedboatBoats(app, sea, NPC_COUNT, { waterAt });
  // pilots are cosmetic: they load BESIDE the boot, never gate it (a KTX2 transcode stalls in a hidden tab, §V.39)
  let pilots: Pick<Pilots, 'hero' | 'update'> = { hero: { setHeadVisible: () => undefined, eyeSource: () => false } as unknown as Pilots['hero'], update: () => undefined };
  let cockpitView = false; // a cockpit switch made while the pilot loads is not replayed by onCockpitChange
  void createPilots(app, boats).then((p) => {
    pilots = p;
    p.hero.setHeadVisible(!cockpitView);
  });
  setFeatureSink('shadows', (on) => (sky.sunLight.castShadow = on));
  setFeatureSink('spray', (on) => {
    sea.spray.mesh.visible = on;
    boats.vesselFx.setVisible(on);
  });
  bindResolution(app.renderer, settings);

  // §T.178/§V110: same step, same sea, same seabed and colliders, off the main thread where the page allows it
  stage('npc physics');
  const pilotSetup = buildPilotSetup(world.course, [...RIVAL_ARCHETYPES, null], { seed: state.seed }); // §T.196: race/ai reads the physical handedness
  const npcs = await createNpcFleetDriver({
    seed: state.seed, boats: NPC_COUNT, oceanParams, seaParams,
    spawn: (i) => course.spawn(i + 1),
    pilot: pilotSetup, contacts: { boats: true, colliders: world.colliders }, world: world.simWorld, player: true,
  });

  const camera = createRaceCameraRig(app.camera, { player }); // §T.182
  camera.cam.onCockpitChange = (on) => pilots.hero.setHeadVisible(!(cockpitView = on));
  camera.cam.setEyeSource((p, q) => pilots.hero.eyeSource(p, q));
  const controls = createRaceControls({ player, camera, enabled: () => !camera.capturesInput() }); // §T.182
  const audio = createSpeedboatAudioSink({ // §T.183
    camera: app.camera, npcs, npcContact: (i) => npcs.contact(i), npcThrottle: (i) => npcs.throttle(i),
  });
  installAudioUnlock(audio);
  const post = createPostPipeline(app.renderer, app.scene, app.camera, { sunDirection: () => sky.sunDirection });
  const usePost = createPostWarmGate({ enabled: () => postParams.enabled, warm: () => post.warmup() });

  const frame = createSpeedboatFrame({
    app, sea, boats, sky, state, player, npcs, weatherHere, waterAt,
    placeCamera: (view, dt) => camera.update(view, dt, waterAt),
  });
  // ?autopilot: the player's boat runs the rivals' §T.186 pilot (browser checks, and the smoke race's controls)
  const autopilot = query.has('autopilot')
    ? createAutopilotControls({
        setup: pilotSetup, index: npcs.playerIndex, boats: NPC_COUNT + 1, lockRad: hull.drives[0].maxSteerRad, sea: sea.cpuOcean,
        time: () => state.time, world: () => session.snapshot, standing: () => session.playerAiIn, propImmersion: () => player.hw.propImmersion,
      })
    : null;
  const session = createRaceSession({
    course: world.course, hull, player, npcs, controls: autopilot ?? controls,
    resetPressed: () => controls.input.reset, surgePressed: () => controls.input.surge, autoReset: () => controls.settings.autoReset,
    colliders: world.colliders, bed: world.bed, isClear: respawnClear(world.colliders, world.bed), waterAt: (x, z) => sea.cpuOcean.pressureHeadAt(x, z, state.time), fetchVersion: () => sea.fetchField.version,
    onPlayerTeleport: () => {
      frame.snap();
      camera.cam.endCrash();
      camera.snap();
      controls.reset();
      autopilot?.reset();
    },
    onPlayerCrash: (_ev, at) => camera.cam.beginCrash(at),
  });
  const ui = createRaceUi({
    parent: document.body, course: world.course, racerIds: session.gridOrder, controls, camera,
    audio: { setVolume: (a) => (audio.engine.setVolumes(engineVolumes(a)), audio.radio.setLevel(radioLevel(a))), radioCall: () => audio.radio.call() },
    defaultSea: 'Calm', chrome, graphics: settings,
    preview: createBoatPreview({ renderer: app.renderer, asset: boats.asset, pilot: () => pilots.hero.object ?? null }), // §T.201
    dash: createDashMount(boats.hero), // §T.208
    onStart: (sel) => {
      weather.apply(SEA_PRESET[sel.sea] ?? course.seaPreset, { lerpSeconds: 0 });
      boats.hero.setLivery(liveryFor(sel.paintId, sel.number));
      session.start(state.tick);
    },
    onRestart: () => session.start(state.tick),
    onQuit: () => {
      session.stop();
      ui.openSelect();
    },
  });
  const hudFrame = createRaceHudFrame({
    session, npcs, controls, camera: app.camera, cameraMode: () => camera.cam.mode, view: frame.view, boat,
    wettedArea: () => player.hw.wettedArea, driveRpm: player.hw.driveRpm, oceanParams, seaLabel: () => ui.selection.sea, pace: boats.pace.display,
  });
  const npcCtl = { steer: 0, throttle: 0 };
  const npcControls = (i: number): typeof npcCtl => ((npcCtl.steer = npcs.steer(i)), (npcCtl.throttle = npcs.throttle(i)), npcCtl);
  const audioFrame: BoatAudioFrame = {
    frameDt: 0, view: frame.view, boat, controls: session.applied,
    contact: {
      wettedArea: 0, slamImpulse: 0, propImmersion: 0,
      driveThrust: player.hw.driveThrust, driveAdvance: player.hw.driveAdvance, driveImmersion: player.hw.driveImmersion, driveRpm: player.hw.driveRpm,
    },
  };

  const loop = new GameLoop(
    (dt) => {
      state.tick++;
      state.time += dt;
      state.wind.speed = oceanParams.windSpeed;
      state.wind.direction = oceanParams.windDirection;
      weather.update(dt);
      weather.weatherAt(boat.position[0], boat.position[2], weatherHere);
      frame.tickSea();
      session.tick(state.tick, state.time, dt);
      audioFrame.contact.wettedArea = player.hw.wettedArea;
      audioFrame.contact.slamImpulse += player.hw.slamImpulse;
      audioFrame.contact.propImmersion = player.hw.propImmersion;
      frame.tickBoat(dt);
      npcs.pump(state.tick);
    },
    (alpha, frameDt, wallFrameDt) => {
      debug.hud.frame(wallFrameDt * 1000);
      frame.renderSea(frameDt, ui.blocking);
      const ctl = session.applied;
      frame.renderBoats(alpha, frameDt, { heroSteer: ctl.steer, heroThrottle: ctl.throttle, heroTrim: ctl.trim, heroPropRpm: player.hw.driveRpm, npcSteer: (i) => npcs.steer(i), npcThrottle: (i) => npcs.throttle(i) });
      pilots.update(frameDt, ctl, npcControls);
      const race = session.state;
      boats.pace.update(race?.paceBoat ?? null, frameDt);
      const lights = race?.lights;
      furniture.update({
        camera: app.camera, time: state.time, dt: frameDt, waterHeightAt: waterAt,
        nextElement: race?.standings.find((s) => s.racerId === 0)?.nextElement, startLamps: lights?.lit, startGreen: lights?.green,
        pace: boats.pace.display.visible ? boats.pace.display : null, // §T.202 marshal skiff mast + strobe
      });
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
      ui.update(hudFrame.fill(frameDt));
      audioFrame.frameDt = frameDt;
      audioFrame.governor = controls.settings.governor.toLowerCase() as BoatAudioFrame['governor'];
      audio.update(audioFrame);
      audioFrame.contact.slamImpulse = 0; // summed over the ticks this frame covered (§T.183 hook 2)
      npcs.resetSlam();
      npcs.pump(state.tick); // frame end: the worker steps inside the next frame's gap
    },
    () => ui.blocking || session.holdSim(state.tick),
  );

  stage('shader compile');
  await withFullCoverage(app.scene, () =>
    Promise.all([postParams.enabled ? post.warmup() : app.renderer.compileAsync(app.scene, app.camera), sea.flowFoam.warmAsync(app.renderer)]),
  );
  stage('first frame');
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
  ui.openSelect();

  // console/browser-verification handle (§V22): read-only use expected
  (window as unknown as Record<string, unknown>).__speedboat = { app, state, sea, boats, player, npcs, controls, camera, loop, session, ui, world, furniture, frame, get pilots() { return pilots; } };
}

// fail loud (§Rule 8): a boot that throws leaves a black page; the stage and the error are readable from the console
boot().catch((e: unknown) => {
  console.error('[speedboat] boot failed:', e);
  (window as unknown as Record<string, unknown>).__speedboatBootError = e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
});
