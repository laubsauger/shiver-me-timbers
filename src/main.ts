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

async function boot(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) throw new Error('missing #app root');

  if (!(await webgpuAvailable())) {
    renderGatePage(root);
    return;
  }

  const app = await App.create(root);
  const state: SimState = createInitialState(1337);

  const debug = createDebugShell({
    onWeatherPreset: (p) => {
      // full preset system = T6; weather field flows into SimState already
      state.weather = p as SimState['weather'];
    },
  });

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

  const loop = new GameLoop(
    (dt) => {
      state.tick++;
      state.time += dt;
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

      surface.update(app.camera, state.time, sky.sunDirection);
      app.controls.update();
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
  };
}

boot();
