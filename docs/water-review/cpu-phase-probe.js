import { probeCpuMirror } from './cpu-mirror-probe.js';

/** Supply the retained pre-phase-cache CpuOcean module from the review snapshot. */
export async function probeCpuPhases(baseline) {
  const result = await probeCpuMirror(baseline);
  const { CpuOcean } = await import('../../src/sea-physics/cpuOcean.ts');
  const { oceanParams } = await import('../../src/params/ocean.ts');
  const { seaPhysicsParams } = await import('../../src/params/seaPhysics.ts');
  const mirrors = [new baseline.CpuOcean(7, oceanParams, seaPhysicsParams),
    new CpuOcean(7, oceanParams, seaPhysicsParams)];
  const samples = [[], []];
  // Rebuild only the reduced mirrors from their existing shared snapshots.
  // Spectrum construction is unchanged and would obscure this added cost.
  for (let round = 0; round < 48; round++) {
    for (const k of round % 2 ? [1, 0] : [0, 1]) {
      const start = performance.now();
      mirrors[k].buildCascades();
      if (round >= 8) samples[k].push(performance.now() - start);
    }
  }
  return {
    ...result,
    medianRebuildMs: samples.map(s => s.sort((a, b) => a - b)[Math.floor(s.length / 2)]),
    frequencies: mirrors[1].cascades.map(c => ({
      cells: c.n * c.n,
      unique: c.omega.length,
      addedBytes: c.omega.byteLength + c.phaseCos.byteLength + c.phaseSin.byteLength,
    })),
  };
}
