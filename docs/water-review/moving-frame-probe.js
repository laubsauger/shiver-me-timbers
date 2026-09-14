/** Vite review only: time actual moving-frame intervals and CPU callbacks.
 * Uses the debug GameLoop instance; never treats fixed scene dt or HUD sums as FPS.
 */
export async function probeMovingFrames(game, count = 180, warmup = 60) {
  const loop = game.loop;
  const tick = loop.tick, render = loop.render, fixedDt = loop.fixedDt;
  const intervals = [], renders = [], ticks = [], mirror = [];
  const updateOcean = game.cpuOcean.update;
  let frames = 0, previous = 0;
  const summary = values => {
    const sorted = [...values].sort((a, b) => a - b);
    return { samples: values.length, mean: values.reduce((a, b) => a + b, 0) / values.length,
      median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * 0.95)] };
  };
  const startTime = game.state.time;
  loop.setFixedDt(null);
  game.cpuOcean.update = function(...args) {
    const start = performance.now();
    const result = updateOcean.apply(this, args);
    if (frames >= warmup) mirror.push(performance.now() - start);
    return result;
  };
  try {
    await new Promise(resolve => {
      loop.tick = function(dt) {
        const start = performance.now();
        tick.call(this, dt);
        if (frames >= warmup) ticks.push(performance.now() - start);
      };
      loop.render = function(...args) {
        const start = performance.now();
        render.apply(this, args);
        if (frames >= warmup) {
          renders.push(performance.now() - start);
          if (previous) intervals.push(start - previous);
        }
        previous = start;
        if (++frames >= count + warmup) resolve();
      };
    });
    return { startTime, endTime: game.state.time, intervalMs: summary(intervals),
      renderCpuMs: summary(renders), tickCpuMs: summary(ticks), mirrorCpuMs: summary(mirror),
      note: 'Observed wall-clock intervals and CPU work, not GPU timestamps or an A/B speedup.' };
  } finally {
    loop.tick = tick; loop.render = render; loop.setFixedDt(fixedDt);
    game.cpuOcean.update = updateOcean;
  }
}
