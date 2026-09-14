/** Verify actual accumulation textures against the constant-source solution. */
export async function probeFoamTiming(renderer) {
  const N = await import('three/tsl');
  const { createAccumulation } = await import('../../src/flowfoam/accumulation.ts');
  const { createFlowNoiseUniforms } = await import('../../src/flowfoam/flowNoise.ts');
  const { flowFoamParams } = await import('../../src/params/flowfoam.ts');
  const p = { ...flowFoamParams, resolution: 8, regionSize: 8, blurSpread: 0, slickHalfLife: 12 };
  const profile = { res: 8, size: () => 8, decayHalfLife: () => 0.5,
    useFlow: false, useCapture: false, useDetail: false, wakeScale: () => 1 };
  const source = () => ({ rate: N.vec4(0.1, 0.02, 0, 0), elev: N.float(0) });
  const results = [];
  for (const fps of [5, 30, 60, 144]) {
    const acc = createAccumulation(p, createFlowNoiseUniforms(p), source, profile);
    try {
      for (let i = 0; i < fps * 3; i++) acc.step(renderer, 1 / fps);
      await renderer.backend.device.queue.onSubmittedWorkDone();
      const data = await renderer.backend.copyTextureToBuffer(acc.foamTexture, 0, 0, 8, 8, 0);
      const expected = [0.1, 0.02].map((rate, i) => {
        const k = Math.LN2 / [0.5, 12][i];
        return rate * -Math.expm1(-k * 3) / k;
      });
      const values = [data[(4 * 8 + 4) * 4], data[(4 * 8 + 4) * 4 + 1]];
      const maxError = Math.max(...values.map((v, i) => Math.abs(v - expected[i])));
      if (!Number.isFinite(maxError) || maxError > 2e-6) throw new Error(`Foam timing ${fps} FPS error ${maxError}`);
      results.push({ fps, values, expected, maxError });
    } finally { acc.dispose(); }
  }
  return results;
}
