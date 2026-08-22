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
import { createPostWarmGate, withFullCoverage } from './core/bootCompile';
import { bindResolution, bindWorldSettings } from './core/bootSettings';
import { bootProgress, bootReady } from './core/bootSplash';
import { createUnderwater } from './underwater';
import { createGameUI, initGraphicsSettings, setFeatureSink } from './ui';
import { createRaftPrompt } from './ui/raftPrompt';
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
import { raftWorldParams } from './params/raftWorld';

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
  bootProgress('scene build');
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
  bindResolution(app.renderer, settings);
  bindWorldSettings(settings);
  applyWeather(new URLSearchParams(window.location.search).get('weather') ?? raftWorldParams.defaultPreset); // calm sea by default
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
  const usePost = createPostWarmGate({ enabled: () => postParams.enabled, warm: () => post.warmup() });

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
    hands: createHands({ hidden: () => ui.isPhotoMode() }), // §T.127: no mitts in a §V22 capture
    socketWorld,
    groundAt,
    actionEnabled: (a) => a !== 'push-off' || raftBeach.state.beached,
    devLayerOn: () => ui.isDevLayerVisible(),
    onDebug: (ch, d) => applyDebugChannel(raftControls, ch, d, sinks),
    onToggle: () => setFp(!player.isActive()),
  });
  bindRaftActions(player, raftControls, sinks);
  // §T.116: the station being offered, named on screen at its own socket. It
  // reads `player.interact` and the SAME live socket resolver the stations do
  // (§V71), and it goes dark whenever the frame is being captured (§I
  // ui/cinematic) — photo mode and full-screen cinematic both, from the view
  // modes' own state rather than a flag of its own.
  const prompt = createRaftPrompt({
    interact: player.interact,
    // §T.135: in the water the plaque becomes `[Space] Climb aboard`, hung on
    // the foot-rail the haul-out would actually take
    board: () => player.boardingAnchor(),
    socketWorld,
    camera: () => app.camera,
    // photo mode only: cinematic == full screen (§I ui/cinematic), and most
    // people PLAY full screen — hiding the affordances there would take the
    // prompts away from the players who need them (§T.116 flagged this)
    hidden: () => ui.isPhotoMode() || !player.isActive(),
  });
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
      // after the render: the lens is where the drawn frame put it
      prompt.update(frameDt);
      frame.renderAudio(frameDt);
    },
    () => paused,
  );

  bootProgress('shader compile');
  await withFullCoverage(app.scene, () =>
    postParams.enabled ? post.warmup() : app.renderer.compileAsync(app.scene, app.camera),
  );
  bootProgress('first frame');
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
  bootReady();
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
