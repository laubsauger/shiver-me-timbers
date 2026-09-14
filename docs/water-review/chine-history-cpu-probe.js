/** CPU cost of the new fixed-tick history and render-frame packet upload. */
export async function probeChineHistoryCpu(sim, baseline) {
  const T = await import('three/webgpu');
  const { uniform } = await import('three/tsl');
  const { createSimFoamField } = await import('../../src/flowfoam/simFoam.ts');
  const { ChineContactHistory } = await import('../../src/wake/chineContact.ts');
  const { createWaterlineSpray } = await import('../../src/foam/sprayMath.ts');
  const { flowFoamParams } = await import('../../src/params/flowfoam.ts');
  const history = new ChineContactHistory();
  const bow = { ...createWaterlineSpray(), inContact: true, flux: 0.1, launch: 2, halfWidth: 1 };
  const sheets = [];
  let tick = 0;
  const advance = () => {
    for (let id = 0; id < 8; id++) {
      bow.x = id * 20; bow.z = tick / 3;
      sheets[id] = history.update(id, tick, bow, 0, 20, 1 / 60);
    }
    tick++;
  };
  for (let i = 0; i < 120; i++) advance();
  const historyTimes = [];
  for (let round = 0; round < 8; round++) {
    const start = performance.now();
    for (let i = 0; i < 1000; i++) advance();
    if (round > 0) historyTimes.push((performance.now() - start) / 1000);
  }
  const centre = uniform(new T.Vector2(sim.solver.centerX, sim.solver.centerZ));
  const p = { ...flowFoamParams };
  const fields = [baseline.createSimFoamField(sim, p, centre, { vessels: 8, propJets: 0 }),
    createSimFoamField(sim, p, centre, { vessels: 8, propJets: 0 })];
  fields[0].setChineSheets(sheets.map(e => ({ ...e, front: 40 })));
  fields[1].setChineSheets(sheets);
  const upload = [[], []];
  for (let round = 0; round < 8; round++) for (const i of round % 2 ? [1, 0] : [0, 1]) {
    const start = performance.now();
    for (let n = 0; n < 1000; n++) fields[i].update();
    if (round > 0) upload[i].push((performance.now() - start) / 1000);
  }
  const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  return { vessels: 8, iterationsPerSample: 1000, historyTickMilliseconds: historyTimes,
    uploadBeforeMilliseconds: upload[0], uploadAfterMilliseconds: upload[1],
    medianHistoryTick: median(historyTimes), medianUploadBefore: median(upload[0]), medianUploadAfter: median(upload[1]) };
}
