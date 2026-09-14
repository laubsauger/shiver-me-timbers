/** Run in the dev-server browser console:
 * const { reviewWakeRecentering } = await import('/docs/water-review/wake-recenter-probe.js');
 * await reviewWakeRecentering(__game.app.renderer);
 * Uses independent 64² textures; does not alter game parameters or wake state.
 */
export async function reviewWakeRecentering(renderer) {
  const N = await import('three/tsl');
  const { createAccumulation } = await import('/src/flowfoam/accumulation.ts');
  const { createFlowNoiseUniforms } = await import('/src/flowfoam/flowNoise.ts');
  const { flowFoamParams } = await import('/src/params/flowfoam.ts');
  const params = { ...flowFoamParams, resolution: 64, regionSize: 64, blurSpread: 0 };
  const dose = N.uniform(1);
  const source = world => ({
    rate: N.vec4(world.length().mul(-0.3).exp().mul(dose), 0, 0, 0),
    elev: N.float(0),
  });
  const profile = {
    res: 64, size: () => 64, decayHalfLife: () => 10,
    useFlow: true, useCapture: false, useDetail: false, wakeScale: () => 1,
  };
  const results = [];
  for (const [dx, dz] of [[4, 0], [-4, 0], [0, 4], [0, -4], [4, -4]]) {
    dose.value = 1;
    const fixed = createAccumulation(params, createFlowNoiseUniforms(params), source, profile);
    const moving = createAccumulation(params, createFlowNoiseUniforms(params), source, profile);
    try {
      fixed.step(renderer, 1);
      moving.step(renderer, 1);
      await renderer.backend.device.queue.onSubmittedWorkDone();
      dose.value = 0;
      moving.setCenter(dx, dz);
      fixed.step(renderer, 0.1);
      moving.step(renderer, 0.1);
      await renderer.backend.device.queue.onSubmittedWorkDone();
      const a = await renderer.backend.copyTextureToBuffer(fixed.foamTexture, 0, 0, 64, 64, 0);
      const b = await renderer.backend.copyTextureToBuffer(moving.foamTexture, 0, 0, 64, 64, 0);
      let maxError = 0, sum = 0, count = 0;
      // Compare common world cells, away from either region's open boundary.
      for (let y = 12; y < 52; y++) {
        for (let x = 12; x < 52; x++) {
          const error = Math.abs(b[(y * 64 + x) * 4] - a[((y - dz) * 64 + x + dx) * 4]);
          maxError = Math.max(maxError, error);
          sum += error * error;
          count++;
        }
      }
      results.push({ dx, dz, maxError, rmsError: Math.sqrt(sum / count) });
    } finally {
      fixed.dispose();
      moving.dispose();
    }
  }
  if (results.some(result => result.maxError > 1e-6)) {
    throw new Error(`Wake recentering changed world-space foam: ${JSON.stringify(results)}`);
  }
  return results;
}
