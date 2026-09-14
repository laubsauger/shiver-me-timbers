/** Historical pass-20 proof. Supply the archived pre-emission simFoam module. */
export async function probeChineFront(renderer, sim, historicalModule) {
  const T = await import('three/webgpu');
  const { Fn, int, instanceIndex, ivec2, textureStore, uniform, uniformArray, vec2, vec4 } = await import('three/tsl');
  const { createSimFoamField, chineSheetFoamCpu, packMovingChineSheet } = historicalModule;
  const { flowFoamParams } = await import('../../src/params/flowfoam.ts');
  const { createWaterlineSpray } = await import('../../src/foam/sprayMath.ts');
  const bow = { ...createWaterlineSpray(), inContact: true, flux: 0.1, launch: 2, halfWidth: 1 };
  const e = { bow, speed: 20, vx: 0, vz: 20, front: 0 };
  const field = createSimFoamField(sim, { ...flowFoamParams, simBreakRate: 0, simChurnRate: 0 },
    uniform(new T.Vector2(sim.solver.centerX, sim.solver.centerZ)), { vessels: 8, propJets: 0 });
  const b = packMovingChineSheet(e).b;
  const distances = [2, 10, 20];
  const coords = distances.map(d => new T.Vector2(1 + b[2] * b[3] * (1 - Math.exp(-d / b[3])), -d));
  const uCoords = uniformArray(coords);
  const target = new T.StorageTexture(3, 1);
  target.type = T.FloatType;
  const kernel = Fn(() => {
    const p = uCoords.element(int(instanceIndex));
    const rate = field.rateNode(vec2(p.x, p.y), 0.1);
    textureStore(target, ivec2(int(instanceIndex), 0), vec4(rate.x, 0, 0, 1)).toWriteOnly();
  })().compute(3);
  const results = [];
  try {
    for (const front of [0, 5, 15, 25]) {
      e.front = front;
      field.setChineSheets([e]); field.update();
      await renderer.computeAsync(kernel);
      const data = await renderer.backend.copyTextureToBuffer(target, 0, 0, 3, 1, 0);
      const gpu = distances.map((_, i) => data[4 * i]);
      const cpu = coords.map(p => chineSheetFoamCpu([e], p.x, p.y, 0.1));
      for (let i = 0; i < 3; i++) {
        if (Math.abs(gpu[i] - cpu[i]) > 1e-4) throw new Error(`GPU/CPU mismatch: ${front}, ${i}: ${gpu[i]} / ${cpu[i]}`);
        if (distances[i] >= front && gpu[i] !== 0) throw new Error('Foam appeared ahead of birth front');
      }
      results.push({ secondsAt20MetresPerSecond: front / 20, front, gpu, cpu });
    }
    return { distances, results };
  } finally { target.dispose(); }
}
