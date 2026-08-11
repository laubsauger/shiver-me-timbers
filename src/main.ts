import { webgpuAvailable, renderGatePage } from './core/gate';
import { App } from './core/app';
import { GameLoop } from './core/loop';
import { createInitialState } from './state/simState';
import type { SimState } from './state/simState';

async function boot(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) throw new Error('missing #app root');

  if (!(await webgpuAvailable())) {
    renderGatePage(root);
    return;
  }

  const app = await App.create(root);
  const state: SimState = createInitialState(1337);

  // placeholder geo until T3/T4 ocean lands
  const placeholder = new (await import('./core/placeholder')).Placeholder(app.scene);

  const loop = new GameLoop(
    (dt) => {
      state.tick++;
      state.time += dt;
    },
    () => {
      placeholder.update(state.time);
      app.controls.update();
      app.render();
    },
  );
  loop.start();
}

boot();
