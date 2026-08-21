/**
 * RAFT 2100 entry (§T.98, §V.81). Boot only — every system is imported, and
 * nothing here is shared with `src/main.ts` except the modules both import.
 * No enemy, no combat, no AI, no guns: one raft, the sea, the islands, a day
 * that passes, and a walker at the tiller.
 *
 * Scene construction is `raft/raftScene.ts`, the per-tick/per-frame plumbing
 * is `raft/raftFrame.ts`, sailing goes through `raft/raftShip.ts`, stations
 * through `raft/raftActions.ts`, the day clock through `raft/raftWorld.ts`.
 */
import { webgpuAvailable, renderGatePage } from './core/gate';
import { App } from './core/app';
import { GameLoop } from './core/loop';
import { installNodeTypeCache } from './core/nodeTypeCache';
import { createInitialState, type SimState } from './state/simState';
import { createDebugShell } from './debug';
import { DEFAULT_BOOT_TARGET, bootJumpTarget, installJump } from './debug/jump';
import { createSky } from './sky';
import { oceanParams } from './ocean';
import { postParams } from './params/post';
import { createAmbientHold, createWeatherSystem, createWeatherSample, weatherWorldPatch } from './weather';
import { createPostPipeline } from './core/postPipeline';
import { createUnderwater } from './underwater';
import { applyWorldSettings, createGameUI, initGraphicsSettings, setFeatureSink } from './ui';
import { createAudio, attachAudioSettings } from './audio';
import { createRaftCeiling, raftBoardingPoints } from './ship/raftDeckField';
import { FollowCam } from './camera';
import { createPlayer } from './player';
import { createHands } from './player/hands';
import { buildRaftSea, buildRaftVessel } from './raft/raftScene';
import { createRaftFrame } from './raft/raftFrame';
import { pushOffRaft, stepRaftShip, placeRaftAtStart } from './raft/raftShip';
import { applyDebugChannel, bindRaftActions, radio, raftBeach, raftControls } from './raft/raftActions';
import { bootTimeOfDay, calmPreset, createDayClock } from './raft/raftWorld';
import type { Object3D } from 'three/webgpu';

/** compileAsync never rebuilds the frustum, so cull nothing during the walk (see main.ts) */
function withFullCoverage(root: Object3D, compile: () => Promise<unknown>): Promise<unknown> {
  const culled: boolean[] = [];
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    culled.push(o.frustumCulled);
    o.frustumCulled = false;
  });
  const pending = compile();
  let i = 0;
  root.traverse((o) => {
    o.frustumCulled = culled[i++] ?? o.frustumCulled;
  });
  return pending;
}

async function boot(): Promise<void> {
  installNodeTypeCache();
  const root = document.getElementById('app');
  if (!root) throw new Error('missing #app root');
  if (!(await webgpuAvailable())) {
    renderGatePage(root);
    return;
  }
  const w = window as unknown as { __bootProgress?: (s: string) => void; __bootReady?: () => void };
  const phase = (label: string): void => w.__bootProgress?.(label);

  const settings = initGraphicsSettings();
  phase('renderer');
  const app = await App.create(root);
  phase('scene build');
  const state: SimState = createInitialState(2100);

  const weather = createWeatherSystem({
    seed: state.seed,
    setWeather: (wx) => {
      state.weather = wx as SimState['weather'];
    },
  });
  const weatherHere = createWeatherSample();
  const oceanAmbient = createAmbientHold(['windSpeed', 'amplitude'], oceanParams, { windSpeed: 0.5, amplitude: 0.02 }, 3);
  // storm presets are refused (§T.98): the settings row has already written
  // the asked-for sea into the store, so the calm one is written back over it
  const applyWeather = (name: string): void => {
    const calm = calmPreset(name);
    if (calm !== name) {
      console.warn(`[raft] weather '${name}' is not sailed on a raft — using '${calm}'`);
      settings.set({ world: weatherWorldPatch(calm) });
    }
    weather.apply(calm);
  };
  const debug = createDebugShell({ onWeatherPreset: applyWeather });
  const sky = createSky({ scene: app.scene });
  sky.configureRenderer(app.renderer);
  const sea = buildRaftSea(app, state, sky, weather);

  state.ships.push({
    id: 'player', kind: 'player',
    position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0],
    rudder: 0, sailTrim: 0.5, anchored: false, flood: 0, damage: {},
  });
  const raft = state.ships[0];
  placeRaftAtStart(raft, sea.sierra.start);
  const vessel = buildRaftVessel(app, sea);
  const waterAt = (x: number, z: number): number => sea.cpuOcean.heightAt(x, z, state.time);

  const followCam = new FollowCam(app.camera, app.renderer.domElement);
  app.controls.enabled = false;

  let paused = false;
  setFeatureSink('shadows', (on) => {
    sky.sunLight.castShadow = on;
  });
  setFeatureSink('spray', (on) => {
    sea.spray.mesh.visible = on;
    sea.bowSpray.mesh.visible = on;
  });
  const ui = createGameUI({
    settings,
    onWeatherPreset: applyWeather,
    onPause: () => {
      paused = true;
    },
    onResume: () => {
      paused = false;
    },
  });
  const applyResolution = (s = settings.get()): void => {
    app.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * s.graphics.resolutionScale);
  };
  applyResolution();
  settings.subscribe(applyResolution);
  const applyWorld = (s = settings.get()): void => applyWorldSettings(s.world);
  applyWorld();
  settings.subscribe(applyWorld);
  // the day clock owns the sun from here on; a settings change still re-seeds it
  const clock = createDayClock();
  clock.set(bootTimeOfDay(window.location.search));

  const audio = createAudio(ui.settings.get().audio);
  attachAudioSettings(audio, ui.settings);
  ui.setMusicStatusSource(() => audio.musicInfo());
  const underwater = createUnderwater({ camera: app.camera, sunDirProvider: () => sky.sunDirection });
  app.scene.add(underwater.waterlineMesh);
  const post = createPostPipeline(app.renderer, app.scene, app.camera, {
    underwater,
    sunDirection: () => sky.sunDirection,
  });
  let postWarm = postParams.enabled;
  let postWarming = false;
  const usePost = (): boolean => {
    if (!postParams.enabled) return false;
    if (postWarm) return true;
    if (!postWarming) {
      postWarming = true;
      void post.warmup().then(() => {
        postWarm = true;
        postWarming = false;
      });
    }
    return false;
  };

  // --- the walker (§T.94/§T.95), spawned at the tiller, first person on boot ---
  const { assembly } = vessel;
  assembly.group.updateMatrixWorld(true);
  const tillerLocal = assembly.socketWorldPosition('station-tiller'); // assembly is at the origin here
  const sinks = {
    skipToDawn: () => clock.skipToDawn(),
    pushOff: () => void pushOffRaft(raft, raftBeach),
  };
  // the island field, unfiltered: the player's terrain surface (`ashore.ts`)
  // and the gangway decide for themselves where water − swimDepth ends ground
  const groundAt = (x: number, z: number): number => sea.archipelago.seabed.heightAt(x, z);
  const socketWorld = (id: string): [number, number, number] | null => {
    try {
      return assembly.socketWorldPosition(id);
    } catch {
      return null;
    }
  };
  const setFp = (on: boolean): void => {
    player.setActive(on);
    followCam.setMode(on ? 'fp' : 'follow');
  };
  const player = createPlayer({
    sim: state,
    shipPose: () => raft,
    deckField: vessel.deckField,
    waterAt,
    boardingPoints: raftBoardingPoints(vessel.blueprint),
    ceilingAt: createRaftCeiling(),
    spawn: [tillerLocal[0], tillerLocal[1], tillerLocal[2]],
    canvas: app.renderer.domElement,
    hands: createHands(),
    socketWorld,
    groundAt,
    actionEnabled: (a) => a !== 'push-off' || raftBeach.state.beached,
    devLayerOn: () => ui.isDevLayerVisible(),
    onDebug: (ch, d) => applyDebugChannel(raftControls, ch, d, sinks),
    onToggle: () => setFp(!player.isActive()),
  });
  bindRaftActions(player, raftControls, sinks);
  followCam.setPoseSource(() => player.cameraPose());
  setFp(true);
  // the hands ride the lens; the camera joins the scene so they draw (and compile now)
  if (player.hands !== null) app.camera.add(player.hands.group);
  app.scene.add(app.camera);

  const frame = createRaftFrame({
    app, sea, vessel, sky, state, raft, beach: raftBeach, weatherHere, audio, waterAt,
    placeCamera: (view, dt) => followCam.update(view, dt, waterAt),
  });
  const jump = installJump({
    target: window,
    ship: raft,
    targets: sea.archipelago.anchorages.map((a) => ({ name: a.name, x: a.x, z: a.z, heading: a.heading })),
    waterLevelAt: waterAt,
    onTeleport: () => {
      frame.snap();
      followCam.snap();
    },
  });
  const requestedAt = bootJumpTarget(window.location.search);
  if (!jump.jumpTo(requestedAt ?? DEFAULT_BOOT_TARGET) && requestedAt !== null) {
    console.warn(`[jump] ?at=${requestedAt} is not a destination — have: ${jump.targets.map((t) => t.name).join(', ')}`);
  }
  frame.snap();
  let aground = false;

  const loop = new GameLoop(
    (dt) => {
      if (paused) return;
      state.tick++;
      state.time += dt;
      state.wind.speed = oceanParams.windSpeed;
      state.wind.direction = oceanParams.windDirection;
      weather.update(dt);
      oceanAmbient.restore();
      weather.weatherAt(raft.position[0], raft.position[2], weatherHere);
      oceanAmbient.publish(weatherHere.ocean);
      clock.tick(dt);
      // sailing owns x/z/yaw; buoyancy (inside tickSea) owns y/pitch/roll (§V.77)
      stepRaftShip(raft, raftControls, state.wind, dt);
      aground = frame.tickSea(dt).aground;
      player.step(dt);
    },
    (alpha, frameDt) => {
      debug.hud.frame(frameDt * 1000);
      frame.renderSea(frameDt, paused);
      const { headingRad, knots } = frame.renderVessel(alpha, frameDt);
      ui.setSpeed(knots);
      ui.setHeading(headingRad);
      ui.setTrim(raft.sailTrim);
      ui.setWind({
        windDirection: state.wind.direction, windSpeed: state.wind.speed,
        shipVelX: raft.velocity[0], shipVelZ: raft.velocity[2], headingRad, brace: raft.brace,
        anchored: false, aground,
      });
      underwater.update(frameDt, waterAt, state.time);
      if (usePost()) {
        post.updateFromParams();
        post.render();
      } else {
        app.render();
      }
      debug.hud.setRenderStats(app.renderer.info.render);
      frame.renderAudio(frameDt);
    },
    () => paused,
  );

  phase('shader compile');
  await withFullCoverage(app.scene, () =>
    postParams.enabled ? post.warmup() : app.renderer.compileAsync(app.scene, app.camera),
  );
  phase('first frame');
  sea.ocean.update(app.renderer, state.time);
  sea.foam.update(app.renderer);
  sea.clouds.update(state.time, sky.sunDirection);
  sea.surface.update(app.camera, state.time, sky.sunDirection);
  if (postParams.enabled) {
    post.updateFromParams();
    await post.presentAsync();
  } else {
    await app.renderer.renderAsync(app.scene, app.camera);
  }
  loop.start();
  w.__bootReady?.();
  ui.showQuickControls();

  // dev console handle for the lookdev agent (§V.88) — not an interface contract
  (window as unknown as Record<string, unknown>).__game = {
    app, state, sky, ui, player, raftControls, radio, beach: raftBeach, clock, followCam, assembly, weather,
    archipelago: sea.archipelago, cpuOcean: sea.cpuOcean,
    jumpTo: jump.jumpTo, jumpTargets: jump.targets,
    setFp,
  };
}

boot();
