// Isolated WebGPU regression: pass the pre-fix shoreRunup module URL.
export async function probe(renderer, baselineModuleUrl) {
  const T = await import('three/webgpu');
  const N = await import('three/tsl');
  const modules = await Promise.all([import(baselineModuleUrl), import('/src/terrain/shoreRunup.ts')]);
  const size = 256, gains = [0, 0.1, 1], targets = [], kernels = [], arrays = [];
  try {
    for (const gain of gains) for (const module of modules) {
      const target = new T.StorageTexture(size, size);
      target.type = T.FloatType;
      targets.push(target);
      const u = module.createShoreUniforms();
      u.heightMin.value = u.heightMax.value = 1;
      u.swellResponse.value = 0;
      u.foamNoiseStrength.value = 0;
      kernels.push(N.Fn(() => {
        const x = N.int(N.instanceIndex).mod(size), y = N.int(N.instanceIndex).div(size);
        u.time = N.float(y).div(size - 1).add(6).mul(u.period);
        const s = module.buildShoreNodes(u, N.float(x).div(size - 1).mul(1.5), N.vec2(0), N.float(gain));
        N.textureStore(target, N.ivec2(x, y), N.vec4(s.sheet, s.wet, s.foam, s.level)).toWriteOnly();
      })().compute(size * size));
    }
    for (const kernel of kernels) await renderer.computeAsync(kernel);
    for (const target of targets) arrays.push(await renderer.backend.copyTextureToBuffer(target, 0, 0, size, size, 0));
    const results = gains.map((gain, g) => {
      const before = arrays[g * 2], after = arrays[g * 2 + 1];
      let zeroLevelBefore = 0, zeroLevelAfter = 0, matureDifference = 0, otherChannelsDifference = 0;
      let peakBefore = 0, peakAfter = 0, residualDifference = 0;
      for (let i = 0; i < before.length; i += 4) {
        for (const c of [0, 1, 3]) otherChannelsDifference = Math.max(otherChannelsDifference, Math.abs(before[i + c] - after[i + c]));
        const level = before[i + 3], height = ((i / 4) % size) / (size - 1) * 1.5;
        peakBefore = Math.max(peakBefore, before[i + 2]);
        peakAfter = Math.max(peakAfter, after[i + 2]);
        if (level === 0 && height === 0) {
          zeroLevelBefore = Math.max(zeroLevelBefore, before[i + 2]);
          zeroLevelAfter = Math.max(zeroLevelAfter, after[i + 2]);
        }
        if (level >= 0.22) matureDifference = Math.max(matureDifference, Math.abs(before[i + 2] - after[i + 2]));
        if (height > level + 0.22) residualDifference = Math.max(residualDifference, Math.abs(before[i + 2] - after[i + 2]));
      }
      if (otherChannelsDifference > 1e-6 || matureDifference > 1e-6 || residualDifference > 1e-6) throw Error('Changed mature foam, stranded foam, or water/sand state');
      if (zeroLevelBefore < 0.1 || zeroLevelAfter >= zeroLevelBefore * 0.5) throw Error('Dormant swash edge still paints a white contour');
      if (gain === 0 && peakAfter > 1e-6) throw Error('Zero-energy swash still creates foam');
      if (gain === 1 && peakAfter < 0.5) throw Error('Mature swash lost foam');
      return { gain, zeroLevelBefore, zeroLevelAfter, peakBefore, peakAfter, matureDifference, residualDifference, otherChannelsDifference };
    });
    return { size, results };
  } finally {
    targets.forEach(target => target.dispose());
    kernels.forEach(kernel => kernel.dispose());
  }
}
