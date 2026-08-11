import { webgpuAvailable, renderGatePage } from './core/gate';
import { App } from './core/app';
import { GameLoop } from './core/loop';
import { createInitialState } from './state/simState';
import type { SimState } from './state/simState';
import { createDebugShell } from './debug';
import { createSky } from './sky';
import { createOceanSim, oceanParams } from './ocean';
import { OceanSurface } from './ocean/oceanSurface';
import { createFoamSim } from './foam';
import { createClouds } from './clouds';
import { skyParams } from './params/sky';
import { buildGalleonBlueprint } from './ship/shipBlueprint';
import { ShipAssembly } from './ship/shipAssembly';
import { createInputCollector } from './sailing/input';
import { stepShipSailing } from './sailing/shipKinematics';
import { createFollowCam } from './camera';
import { createWeatherSystem } from './weather';
import { createGameUI } from './ui';
import { createAudio } from './audio';
import { CpuOcean } from './sea-physics/cpuOcean';
import { stepShipBuoyancy } from './sea-physics/buoyancy';

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
  const surface = new OceanSurface(ocean, foam);
  app.scene.add(surface.group);

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
  const shipAssembly = new ShipAssembly(buildGalleonBlueprint());
  app.scene.add(shipAssembly.group);

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
      stepShipBuoyancy(playerShip, cpuOcean, dt);
    },
    (_alpha, frameDt) => {
      debug.hud.frame(frameDt * 1000);

      sky.update(skyParams.timeOfDay);

      let t = performance.now();
      ocean.update(app.renderer, state.time);
      foam.update(app.renderer);
      debug.hud.setPassTiming('ocean+foam cpu-dispatch', performance.now() - t);

      t = performance.now();
      clouds.update(state.time, sky.sunDirection);
      debug.hud.setPassTiming('clouds cpu-dispatch', performance.now() - t);

      // render reads SimState (§V.3)
      shipAssembly.group.position.fromArray(playerShip.position);
      shipAssembly.group.quaternion.fromArray(playerShip.quaternion);
      followCam.update(playerShip, frameDt, (x, z) => cpuOcean.heightAt(x, z, state.time));

      const speed = Math.hypot(playerShip.velocity[0], playerShip.velocity[2]);
      ui.setSpeed(speed * 1.944); // m/s → knots
      const fwd = shipAssembly.group.getWorldDirection(tmpDir);
      ui.setHeading(Math.atan2(fwd.x, fwd.z));

      audio.update({ windSpeed: state.wind.speed, weather: state.weather }, frameDt);

      surface.update(app.camera, state.time, sky.sunDirection);
      app.render();
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
  };
}

import { Vector3 } from 'three/webgpu';
const tmpDir = new Vector3();

boot();
