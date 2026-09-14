/** Compare full CPU mirror evolution against a supplied pre-plan CpuOcean module. */
export async function probeCpuMirror(baseline) {
  const { CpuOcean } = await import('../../src/sea-physics/cpuOcean.ts');
  const { oceanParams } = await import('../../src/params/ocean.ts');
  const { seaPhysicsParams } = await import('../../src/params/seaPhysics.ts');
  const mirrors = [new baseline.CpuOcean(7, oceanParams, seaPhysicsParams), new CpuOcean(7, oceanParams, seaPhysicsParams)];
  const times = [[], []];
  let comparedValues = 0;
  for (let step = 0; step < 48; step++) {
    const time = 100 + step / 60;
    for (const k of step % 2 ? [1, 0] : [0, 1]) {
      const start = performance.now(); mirrors[k].update(time);
      if (step >= 8) times[k].push(performance.now() - start);
    }
    for (let c = 0; c < mirrors[0].cascades.length; c++) for (const key of ['height', 'head', 'dx', 'dz']) {
      const a = mirrors[0].cascades[c][key], b = mirrors[1].cascades[c][key];
      const aa = new Uint32Array(a.buffer, a.byteOffset, a.length), bb = new Uint32Array(b.buffer, b.byteOffset, b.length);
      for (let i = 0; i < aa.length; i++) {
        if (aa[i] !== bb[i]) throw new Error(`Mirror mismatch ${step}/${c}/${key}/${i}`);
        comparedValues++;
      }
    }
  }
  return { bitIdentical: true, comparedValues, samples: times[0].length,
    medianUpdateMs: times.map(s => s.sort((a, b) => a - b)[Math.floor(s.length / 2)]) };
}
