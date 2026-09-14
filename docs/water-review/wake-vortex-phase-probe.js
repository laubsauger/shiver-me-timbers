/** Actual injector shader: compare shed foam at fixed water while the hull advances.
 * Baseline must retain the projection predicate fix while using the old phase.
 */
export async function probeWakeVortexPhase(renderer, baseline) {
  const T = await import('three/webgpu');
  const { float, int, instanceIndex, ivec2, textureStore, vec2, vec4, Fn } = await import('three/tsl');
  const { createWakeInjector } = await import('../../src/flowfoam/wakeInjection.ts');
  const { flowFoamParams } = await import('../../src/params/flowfoam.ts');
  const p = { ...flowFoamParams, cutIntensity: 0, bowIntensity: 0,
    shoulderIntensity: 0, sternIntensity: 0, moundIntensity: 0,
    vortexSpread: 0, vortexSpacing: 12, wakeBreakup: 0 };
  const injectors = [baseline.createWakeInjector(p), createWakeInjector(p)];
  let head = 0;
  const advance = () => {
    for (const injector of injectors) {
      injector.setShip([0, head], 0, 10, 0, -30, 10);
      injector.advance(0.1);
      injector.pushParams();
    }
  };
  advance();
  for (head = 1; head <= 200; head++) advance();
  head = 200;
  const target = new T.StorageTexture(2, 1);
  target.type = T.FloatType;
  const kernel = Fn(() => {
    const side = instanceIndex.equal(0).select(float(-5 * p.vortexOffset), float(5 * p.vortexOffset));
    const coord = vec2(side, 101);
    textureStore(target, ivec2(int(instanceIndex), 0), vec4(
      injectors[0].wakeFieldNode(coord).rate.x,
      injectors[1].wakeFieldNode(coord).rate.x, 0, 1)).toWriteOnly();
  })().compute(2);
  const results = [];
  try {
    for (let sample = 0; sample < 6; sample++) {
      await renderer.computeAsync(kernel);
      const data = await renderer.backend.copyTextureToBuffer(target, 0, 0, 2, 1, 0);
      const contrast = channel => {
        const port = data[channel], starboard = data[4 + channel];
        if (!(port + starboard > 0)) throw new Error('Probe missed the vortex street');
        return (starboard - port) / (starboard + port);
      };
      results.push({ head, before: contrast(0), after: contrast(1) });
      for (let i = 0; i < 3; i++) { head++; advance(); }
    }
    const range = key => Math.max(...results.map(r => r[key])) - Math.min(...results.map(r => r[key]));
    // Independent straight-track oracle: d = head - 101, hull length = 30,
    // odometer = head. Port and starboard envelopes cancel in the contrast.
    const expectedContrast = Math.sin(-2 * Math.PI * (101 + 30) / p.vortexSpacing);
    if (results.some(r => Math.abs(r.after - expectedContrast) > 0.001)) {
      throw new Error('GPU projection lost the side or used the wrong phase');
    }
    if (range('after') > 0.001 || range('before') < 1) throw new Error('Vortex phase stability failed');
    return { results, expectedContrast, oldRange: range('before'), newRange: range('after') };
  } finally {
    target.dispose();
  }
}
