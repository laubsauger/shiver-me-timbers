export interface ComplexGrid {
  re: Float32Array;
  im: Float32Array;
}

/** A reusable 2D transform plan for the ocean's immutable butterfly table.
 * Keeps the reference arithmetic order and every float32 stage boundary.
 * Buffers belong to this plan; calls are synchronous and must not overlap.
 */
export function createCpuIFFT2D(butterfly: Float32Array, n: number): (grid: ComplexGrid) => void {
  const stages = Math.log2(n);
  if (!Number.isInteger(stages) || butterfly.length !== stages * n * 4) {
    throw new RangeError('CPU FFT requires a power-of-two size and matching butterfly table');
  }
  const count = stages * n;
  const wr = new Float32Array(count), wi = new Float32Array(count);
  const indexA = new Uint32Array(count), indexB = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    wr[i] = butterfly[i * 4]; wi[i] = butterfly[i * 4 + 1];
    indexA[i] = butterfly[i * 4 + 2]; indexB[i] = butterfly[i * 4 + 3];
  }
  const ar = new Float32Array(n), ai = new Float32Array(n);
  const br = new Float32Array(n), bi = new Float32Array(n);
  const line = (grid: ComplexGrid, offset: number, stride: number): void => {
    let pr = ar, pi = ai, qr = br, qi = bi;
    for (let x = 0; x < n; x++) {
      pr[x] = grid.re[offset + x * stride];
      pi[x] = grid.im[offset + x * stride];
    }
    for (let stage = 0; stage < stages; stage++) {
      const base = stage * n;
      for (let x = 0; x < n; x++) {
        const i = base + x, a = indexA[i], b = indexB[i];
        const r = wr[i], im = wi[i];
        // The four buffers are distinct. Load before writing either output
        // so the JIT need not account for possible typed-array aliasing.
        const aRe = pr[a], aIm = pi[a], bRe = pr[b], bIm = pi[b];
        qr[x] = aRe + r * bRe - im * bIm;
        qi[x] = aIm + r * bIm + im * bRe;
      }
      const tr = pr, ti = pi;
      pr = qr; pi = qi; qr = tr; qi = ti;
    }
    for (let x = 0; x < n; x++) {
      grid.re[offset + x * stride] = pr[x];
      grid.im[offset + x * stride] = pi[x];
    }
  };
  return (grid: ComplexGrid): void => {
    for (let row = 0; row < n; row++) line(grid, row * n, 1);
    for (let col = 0; col < n; col++) line(grid, col, n);
  };
}
