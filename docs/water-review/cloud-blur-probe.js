/** Compare two cloud-blur implementations using the same packed cloud fixture. */
export async function probeCloudBlur(renderer, baseline, candidate) {
  const T = await import('three/webgpu');
  const { cloudParams } = await import('../../src/params/clouds.ts');
  const w = 768, h = 432, data = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const density = Math.max(0, Math.sin(x * 0.013) * Math.cos(y * 0.019));
    data[i] = density * 0.6; data[i + 1] = density * 0.8;
    data[i + 2] = density; data[i + 3] = density * (x / w);
  }
  const input = new T.DataTexture(data, w, h, T.RGBAFormat, T.FloatType); input.needsUpdate = true;
  const p = { ...cloudParams, rtWidth: w, rtHeight: h };
  const a = baseline.createCloudBlur(input, p), b = candidate.createCloudBlur(input, p);
  const queue = renderer.backend.device.queue;
  const half = (v) => {
    const sign = v & 32768 ? -1 : 1, e = (v >> 10) & 31, m = v & 1023;
    return sign * (e === 0 ? m * 2 ** -24 : e === 31 ? (m ? NaN : Infinity) : (1 + m / 1024) * 2 ** (e - 15));
  };
  try {
    a.run(renderer); b.run(renderer); await queue.onSubmittedWorkDone();
    const aa = await renderer.backend.copyTextureToBuffer(a.output, 0, 0, w, h, 0);
    const bb = await renderer.backend.copyTextureToBuffer(b.output, 0, 0, w, h, 0);
    let changed = 0, maxError = 0, squared = 0;
    for (let i = 0; i < aa.length; i++) {
      if (aa[i] !== bb[i]) changed++;
      const error = Math.abs(half(aa[i]) - half(bb[i]));
      maxError = Math.max(maxError, error); squared += error * error;
    }
    const samples = [[], []];
    for (let i = 0; i < 20; i++) for (const j of i % 2 ? [1, 0] : [0, 1]) {
      const blur = [a, b][j];
      await queue.onSubmittedWorkDone();
      const start = performance.now();
      for (let k = 0; k < 8; k++) blur.run(renderer);
      await queue.onSubmittedWorkDone();
      if (i >= 4) samples[j].push((performance.now() - start) / 8);
    }
    const median = s => s.sort((a, b) => a - b)[Math.floor(s.length / 2)];
    return { components: aa.length, changed, maxError, rmsError: Math.sqrt(squared / aa.length),
      baselineQueueMs: median(samples[0]), candidateQueueMs: median(samples[1]), samplesPerVariant: samples[0].length };
  } finally { a.dispose(); b.dispose(); input.dispose(); }
}
