/** Pre-change indexing oracle, with unchanged arithmetic and float32 stages. */
export function floatIndexIFFT(input, butterfly, n, scratch) {
  const stages = Math.log2(n);
  let [pingRe, pingIm, pongRe, pongIm] = scratch;
  pingRe.set(input.re); pingIm.set(input.im);
  for (let j = 0; j < stages; j++) {
    for (let x = 0; x < n; x++) {
      const i = (j * n + x) * 4;
      const wr = butterfly[i], wi = butterfly[i + 1];
      const a = butterfly[i + 2], b = butterfly[i + 3];
      pongRe[x] = pingRe[a] + wr * pingRe[b] - wi * pingIm[b];
      pongIm[x] = pingIm[a] + wr * pingIm[b] + wi * pingRe[b];
    }
    [pingRe, pongRe] = [pongRe, pingRe]; [pingIm, pongIm] = [pongIm, pingIm];
  }
  return { re: pingRe, im: pingIm };
}
export async function probeFFTIndexing() {
  const { cpuButterflyIFFT, generateButterfly } = await import('../../src/ocean/oceanMath.ts');
  const results = [];
  for (const n of [64, 128]) {
    const table = generateButterfly(n);
    const input = { re: Float32Array.from({ length: n }, (_, i) => Math.sin(i * 0.371)),
      im: Float32Array.from({ length: n }, (_, i) => Math.cos(i * 0.197)) };
    const scratch = [0, 1].map(() => Array.from({ length: 4 }, () => new Float32Array(n)));
    const a = floatIndexIFFT(input, table, n, scratch[0]);
    const b = cpuButterflyIFFT(input, table, n, scratch[1]);
    const bits = x => new Uint32Array(x.buffer, x.byteOffset, x.length);
    for (const channel of ['re', 'im']) for (let i = 0; i < n; i++) {
      if (bits(a[channel])[i] !== bits(b[channel])[i]) throw new Error(`FFT changed at ${n}/${channel}/${i}`);
    }
    const samples = [[], []];
    for (let round = 0; round < 40; round++) for (const k of round % 2 ? [1, 0] : [0, 1]) {
      const fn = [floatIndexIFFT, cpuButterflyIFFT][k];
      const start = performance.now();
      for (let i = 0; i < 256; i++) fn(input, table, n, scratch[k]);
      if (round >= 8) samples[k].push((performance.now() - start) / 256);
    }
    results.push({ n, bitIdentical: true, medianLineMs: samples.map(s => s.sort((a, b) => a - b)[Math.floor(s.length / 2)]) });
  }
  return results;
}
