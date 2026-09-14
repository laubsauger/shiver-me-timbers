/** Actual GPU packet source, plus an alternating comparison against the prior envelope. */
export async function probeChineHistory(renderer, sim, baseline, onePacketPerTick = false) {
  const T = await import('three/webgpu');
  const N = await import('three/tsl');
  const { createSimFoamField, retainedChineFoamCpu } = await import('../../src/flowfoam/simFoam.ts');
  const { ChineContactHistory } = await import('../../src/wake/chineContact.ts');
  const { createWaterlineSpray } = await import('../../src/foam/sprayMath.ts');
  const { flowFoamParams } = await import('../../src/params/flowfoam.ts');
  const history = new ChineContactHistory();
  const sheets = [];
  for (let tick = 0; tick <= 120; tick++) {
    const t = tick / 60;
    for (let id = 0; id < 8; id++) {
      const ox = (id % 4) * 22, oz = Math.floor(id / 4) * 24;
      const turned = t >= 1;
      const bow = { ...createWaterlineSpray(), inContact: true, flux: 0.1, launch: 2, halfWidth: 1,
        x: ox + (turned ? (t - 1) * 20 : 0), z: oz + Math.min(t, 1) * 20,
        fwdX: turned ? 1 : 0, fwdZ: turned ? 0 : 1 };
      if (onePacketPerTick) history.resetContact(id);
      sheets[id] = history.update(id, tick, bow, turned ? 20 : 0, turned ? 0 : 20, 1 / 60);
    }
  }
  const p = { ...flowFoamParams, simBreakRate: 0, simChurnRate: 0 };
  const centre = N.uniform(new T.Vector2(sim.solver.centerX, sim.solver.centerZ));
  const fields = [baseline.createSimFoamField(sim, p, centre, { vessels: 8, propJets: 0 }),
    createSimFoamField(sim, p, centre, { vessels: 8, propJets: 0 })];
  fields[0].setChineSheets(sheets.map(e => ({ ...e, front: 40 })));
  fields[1].setChineSheets(sheets);
  for (const f of fields) f.update();
  const size = 512, span = 120, texel = span / size;
  const targets = fields.map(() => { const t = new T.StorageTexture(size, size); t.type = T.FloatType; return t; });
  const kernels = fields.map((f, i) => N.Fn(() => {
    const x = N.int(N.instanceIndex).mod(N.int(size));
    const z = N.int(N.instanceIndex).div(N.int(size));
    const world = N.vec2(x, z).add(0.5).mul(texel).sub(20);
    const rate = f.rateNode(world, texel);
    N.textureStore(targets[i], N.ivec2(x, z), N.vec4(rate.x, 0, 0, 1)).toWriteOnly();
  })().compute(size * size));
  const times = [[], []];
  try {
    for (let round = 0; round < 10; round++) {
      for (const i of round % 2 ? [1, 0] : [0, 1]) {
        await renderer.computeAsync(kernels[i]);
        await renderer.resolveTimestampsAsync(T.TimestampQuery.COMPUTE);
        if (round >= 3) times[i].push(renderer.info.compute.timestamp);
      }
    }
    const data = await renderer.backend.copyTextureToBuffer(targets[1], 0, 0, size, size, 0);
    const samples = [];
    for (const [x, z] of [[2, 13], [2, 18], [10, 22], [15, 20], [15, 2], [30, 30], [46, 38]]) {
      const ix = Math.floor((x + 20) / texel), iz = Math.floor((z + 20) / texel);
      const wx = (ix + 0.5) * texel - 20, wz = (iz + 0.5) * texel - 20;
      const gpu = data[(iz * size + ix) * 4];
      const cpu = retainedChineFoamCpu(sheets, wx, wz, texel);
      if (Math.abs(gpu - cpu) > Math.max(1e-5, cpu * 1e-4)) throw new Error(`GPU mismatch at ${wx},${wz}: ${gpu}/${cpu}`);
      samples.push({ x: wx, z: wz, gpu, cpu });
    }
    if (!samples.some(s => s.cpu > 0.01)) throw new Error('Probe missed every retained emission');
    const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    return { grid: size, vessels: 8, onePacketPerTick, packets: sheets.map(e => e.emissions.length), samples,
      gpuMilliseconds: { before: times[0], after: times[1], medianBefore: median(times[0]), medianAfter: median(times[1]) } };
  } finally { targets.forEach(t => t.dispose()); }
}
