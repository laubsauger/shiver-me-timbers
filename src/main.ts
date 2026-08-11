import { webgpuAvailable, renderGatePage } from './core/gate';
import { App } from './core/app';
import { GameLoop } from './core/loop';
import { createInitialState } from './state/simState';
import type { SimState } from './state/simState';
import { createDebugShell } from './debug';
import { createSky } from './sky';
import { createOceanSim, oceanParams } from './ocean';
import { OceanSurface } from './ocean/oceanSurface';
import { createFoamSim, createSpray, createBowSpray } from './foam';
import { createFlowFoam } from './flowfoam';
import { rotateVec } from './combat/quatMath';
import { createClouds } from './clouds';
import { skyParams } from './params/sky';
import { buildGalleonBlueprint } from './ship/shipBlueprint';
import { ShipAssembly } from './ship/shipAssembly';
import { createInputCollector } from './sailing/input';
import { stepShipSailing } from './sailing/shipKinematics';
import { createFollowCam } from './camera';
import { createWeatherSystem } from './weather';
import { createPostPipeline } from './core/postPipeline';
import { postParams } from './params/post';
import { createGameUI } from './ui';
import { createAudio } from './audio';
import { CpuOcean } from './sea-physics/cpuOcean';
import { stepShipBuoyancy } from './sea-physics/buoyancy';
import { stepFlooding } from './sea-physics/flooding';
import { floodingHoles } from './ship/destruction';
import { createRopes } from './ropes';
import { createBlocks } from './ropes/blocks';
import {
  applyBlocks,
  applyRiggingPlan,
  buildRiggingPlan,
  selectBlockSockets,
} from './ropes/shipRigging';
import { ropeParams } from './params/ropes';

// bisect switches for the renderer-freeze hunt — all true = full game
const FEATURES = {
  spray: true, // re-enabled: B5 NaN guards landed
  bowSpray: true, // re-enabled: B5 NaN guards landed
  flowFoam: true, // re-enabled: T13 wake rework verification (see flowfoam report)
  // ropes+blocks wired and ready — kept OFF pending the freeze-hunt bisect;
  // flip to true for the T11 rig visual check once Chrome is back
  ropes: true,
};

async function boot(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) throw new Error('missing #app root');

  if (!(await webgpuAvailable())) {
    renderGatePage(root);
    return;
  }

  const app = await App.create(root);
  const state: SimState = createInitialState(1337);

  const weather = createWeatherSystem({
    setWeather: (w) => {
      state.weather = w as SimState['weather'];
    },
  });
  const debug = createDebugShell({ onWeatherPreset: (p) => weather.apply(p) });

  const sky = createSky({ scene: app.scene });
  sky.configureRenderer(app.renderer);

  const ocean = createOceanSim(state.seed);
  const foam = createFoamSim(
    ocean.cascades.map((c) => ({ displacement: c.displacement, domain: c.domain })),
    oceanParams.resolution,
  );
  // §V.10 intersection foam + ship wake (T13) — created before the surface
  // so the material can sample the wake mask
  const flowFoam = createFlowFoam();

  const surface = new OceanSurface(ocean, foam, flowFoam);
  app.scene.add(surface.group);

  // crest + bow spray particles (T5 follow-up)
  const spray = createSpray(
    ocean.cascades.map((c) => ({ displacement: c.displacement, domain: c.domain })),
    oceanParams.resolution,
  );
  const bowSpray = createBowSpray();
  app.scene.add(spray.mesh, bowSpray.mesh);

  const clouds = createClouds({
    renderer: app.renderer,
    camera: app.camera,
    seed: state.seed,
  });
  clouds.attachTo(app.scene);

  // player ship (§V.13): galleon assembly rendered from SimState (§V.3)
  state.ships.push({
    id: 'player',
    kind: 'player',
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    rudder: 0,
    sailTrim: 0.8,
    flood: 0,
    damage: {},
  });
  const playerShip = state.ships[0];
  // piece damage states (intact|holed|destroyed) — written by destruction
  // ops when combat wiring lands (T17); hp values live in ShipState.damage
  const playerZoneStates: Record<string, import('./ship/pieceTypes').DamageStateId> = {};
  const galleonBlueprint = buildGalleonBlueprint();
  const shipAssembly = new ShipAssembly(galleonBlueprint);
  app.scene.add(shipAssembly.group);

  // §V.12 rigging: catenary compute ropes anchored to blueprint sockets
  const riggingPlan = buildRiggingPlan(galleonBlueprint);
  const ropes = createRopes({ maxRopes: Math.max(riggingPlan.length, 32) });
  app.scene.add(ropes.mesh);
  // wooden blocks (pulleys) at running-rigging terminations
  const blockSockets = selectBlockSockets(riggingPlan, ropeParams.maxBlocks);
  const blocks = createBlocks(blockSockets.length);
  app.scene.add(blocks.mesh);

  // hull dims for wake + bow spray, from blueprint hull AABBs
  let bowZ = 0;
  let sternZ = 0;
  let beamHalf = 2;
  for (const piece of galleonBlueprint) {
    if (piece.kind !== 'hull-section') continue;
    bowZ = Math.max(bowZ, piece.transform.position[2] + piece.aabb.max[2]);
    sternZ = Math.min(sternZ, piece.transform.position[2] + piece.aabb.min[2]);
    beamHalf = Math.max(beamHalf, Math.abs(piece.transform.position[0]) + piece.aabb.max[0]);
  }
  // tag hull meshes as intersection-foam targets (§V.10); everything on the
  // ship casts + receives sun shadows (sails onto deck, masts onto sails…)
  shipAssembly.group.traverse((o) => {
    if (o.name.startsWith('hull') || o.name.includes('-hull')) {
      o.userData.foamTarget = true;
    }
    if ((o as Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  // the water receives ship shadows too
  surface.group.traverse((o) => {
    if ((o as Mesh).isMesh) o.receiveShadow = true;
  });
  ropes.mesh.castShadow = true;

  // §V.8: CPU mirror of the same seeded spectrum the GPU renders
  const cpuOcean = new CpuOcean(state.seed);

  const input = createInputCollector(window);
  const followCam = createFollowCam(app.camera, app.renderer.domElement);
  app.controls.enabled = false; // follow cam owns the pointer now

  let paused = false;
  const ui = createGameUI({
    onPause: () => {
      paused = true; // sim halts, render continues (§V.21)
    },
    onResume: () => {
      paused = false;
    },
  });

  const audio = createAudio();

  const post = createPostPipeline(app.renderer, app.scene, app.camera);

  // render-side interpolation caches (§V.2: sim ticks at 60Hz, render at
  // display rate — lerping prev→curr tick kills transform micro-stutter)
  const prevPos = new Vector3();
  const currPos = new Vector3();
  const prevQuat = new Quaternion();
  const currQuat = new Quaternion();
  currPos.fromArray(playerShip.position);
  currQuat.fromArray(playerShip.quaternion);
  prevPos.copy(currPos);
  prevQuat.copy(currQuat);
  // interpolated view of the player ship handed to render-side consumers
  const renderShipView = structuredClone(playerShip);

  const loop = new GameLoop(
    (dt) => {
      if (paused) return;
      state.tick++;
      state.time += dt;
      // live wind follows ocean params (weather transitions lerp these)
      state.wind.speed = oceanParams.windSpeed;
      state.wind.direction = oceanParams.windDirection;
      weather.update(dt);
      const snapshot = input.sample(dt);
      stepShipSailing(playerShip, snapshot, state.wind, dt);
      cpuOcean.update(state.time);
      // §V.14 flooding: holes from damaged zones (inert while undamaged)
      const holes = floodingHoles(galleonBlueprint, playerZoneStates, playerShip.quaternion, 0);
      stepFlooding(playerShip, holes.positions, dt);
      stepShipBuoyancy(playerShip, cpuOcean, dt, undefined, holes.positions);
      prevPos.copy(currPos);
      prevQuat.copy(currQuat);
      currPos.fromArray(playerShip.position);
      currQuat.fromArray(playerShip.quaternion);
    },
    (alpha, frameDt) => {
      debug.hud.frame(frameDt * 1000);

      sky.setShadowFocus(playerShip.position[0], playerShip.position[1], playerShip.position[2]);
      sky.update(skyParams.timeOfDay);

      let t = performance.now();
      ocean.update(app.renderer, state.time);
      foam.update(app.renderer);
      debug.hud.setPassTiming('ocean+foam cpu-dispatch', performance.now() - t);

      t = performance.now();
      clouds.update(state.time, sky.sunDirection);
      debug.hud.setPassTiming('clouds cpu-dispatch', performance.now() - t);

      // spray + wake systems follow the ship (§V.6, §V.10)
      const shipYaw = Math.atan2(
        rotateVec(playerShip.quaternion, [0, 0, 1])[0],
        rotateVec(playerShip.quaternion, [0, 0, 1])[2],
      );
      const shipSpeed = Math.hypot(playerShip.velocity[0], playerShip.velocity[2]);
      spray.centerUniform.value.set(playerShip.position[0], playerShip.position[2]);
      windDirTmp.set(Math.cos(state.wind.direction), Math.sin(state.wind.direction));
      if (FEATURES.spray) spray.update(app.renderer, windDirTmp);
      const bowLocal = rotateVec(playerShip.quaternion, [0, 0, bowZ]);
      bowWorldTmp.set(
        playerShip.position[0] + bowLocal[0],
        playerShip.position[1] + bowLocal[1],
        playerShip.position[2] + bowLocal[2],
      );
      shipVelTmp.fromArray(playerShip.velocity);
      if (FEATURES.bowSpray) {
        bowSpray.update(app.renderer, {
          bowWorldPos: bowWorldTmp,
          shipVelocity: shipVelTmp,
          immersionDepth:
            cpuOcean.heightAt(bowWorldTmp.x, bowWorldTmp.z, state.time) - bowWorldTmp.y,
        });
      }
      if (FEATURES.flowFoam) {
        flowFoam.setCenter(playerShip.position[0], playerShip.position[2]);
        flowFoam.setFlowDir([-playerShip.velocity[0], -playerShip.velocity[2]]);
        flowFoam.setShip(
          [playerShip.position[0], playerShip.position[2]],
          shipYaw,
          shipSpeed,
          bowZ,
          sternZ,
          beamHalf * 2,
        );
        flowFoam.renderInjection(app.renderer, app.scene);
        flowFoam.update(app.renderer, frameDt);
      }

      // render reads SimState (§V.3), interpolated between ticks — the
      // camera must chase the same interpolated pose or IT stutters instead
      shipAssembly.group.position.lerpVectors(prevPos, currPos, alpha);
      shipAssembly.group.quaternion.slerpQuaternions(prevQuat, currQuat, alpha);
      renderShipView.position[0] = shipAssembly.group.position.x;
      renderShipView.position[1] = shipAssembly.group.position.y;
      renderShipView.position[2] = shipAssembly.group.position.z;
      renderShipView.quaternion[0] = shipAssembly.group.quaternion.x;
      renderShipView.quaternion[1] = shipAssembly.group.quaternion.y;
      renderShipView.quaternion[2] = shipAssembly.group.quaternion.z;
      renderShipView.quaternion[3] = shipAssembly.group.quaternion.w;
      renderShipView.velocity = playerShip.velocity;
      followCam.update(renderShipView, frameDt, (x, z) => cpuOcean.heightAt(x, z, state.time));

      // rigging follows the moving ship: rewrite anchors, GPU re-solves (§V.12)
      if (FEATURES.ropes) {
        shipAssembly.group.updateMatrixWorld(true);
        applyRiggingPlan(riggingPlan, ropes, (id) => shipAssembly.socketWorldPosition(id));
        applyBlocks(blockSockets, blocks, (id) => shipAssembly.socketWorldPosition(id));
        app.renderer.compute(ropes.computeNode);
      }

      const speed = Math.hypot(playerShip.velocity[0], playerShip.velocity[2]);
      ui.setSpeed(speed * 1.944); // m/s → knots
      const fwd = shipAssembly.group.getWorldDirection(tmpDir);
      ui.setHeading(Math.atan2(fwd.x, fwd.z));

      audio.update({ windSpeed: state.wind.speed, weather: state.weather }, frameDt);

      surface.update(app.camera, state.time, sky.sunDirection);
      if (postParams.enabled) {
        post.updateFromParams();
        post.render();
      } else {
        app.render();
      }
      debug.hud.setRenderStats(app.renderer.info.render);
    },
  );
  loop.start();

  // dev console handle (not part of any interface contract)
  (window as unknown as Record<string, unknown>).__game = {
    app,
    state,
    sky,
    ocean,
    surface,
    clouds,
    shipAssembly,
    ui,
    ropes,
    blocks,
    riggingPlan,
    blockSockets,
  };
}

import { Quaternion, Vector2, Vector3, type Mesh } from 'three/webgpu';
const tmpDir = new Vector3();
const windDirTmp = new Vector2();
const bowWorldTmp = new Vector3();
const shipVelTmp = new Vector3();

boot();
