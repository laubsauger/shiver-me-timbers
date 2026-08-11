/**
 * CPU mirror of the GPU ocean spectrum (§V.8): buoyancy must float ships on
 * the SAME waves the GPU renders — drift between them is a visible bug.
 * Engine-free (§V.3), deterministic (§V.2).
 *
 * Mirrors cascades 0 and 1 only: cascade 2 is the 15 m ripple domain
 * (λ ≤ 5 m per splitWavelengths) — sub-boat-length chop averages out over
 * a ~30 m hull and cannot move it, so mirroring it would be wasted CPU.
 *
 * Phase-exactness at reduced resolution: generateH0 draws gaussians
 * sequentially over its grid, so calling it at a smaller N would assign
 * DIFFERENT gaussians to the same k-mode than the GPU sees (out-of-phase
 * waves = V8 violation). But k-spacing 2π/domain depends only on domain,
 * so the reduced grid's modes are exactly the CENTRAL BLOCK of the
 * full-resolution grid. We generate h0 at full GPU resolution — identical
 * call to OceanCascade (seed + index·7919, same cascadeBand) — and extract
 * that block: every mirrored mode carries the GPU's exact amplitude+phase.
 * The band cap must sit inside the reduced grid (kMax < π·N/domain) so the
 * modes we drop are exactly the zero-amplitude ones; ctor enforces this.
 *
 * Evolution + unpack replicate spectrumPass/unpackPass: h(k,t) =
 * h0(k)e^{iωt} + conj(h0(−k))e^{−iωt}, Dx = i(kx/|k|)h, spec packing
 * A = h + i·Dx (two real fields per complex IFFT), (−1)^(x+y) sign,
 * choppiness λ on Dx/Dz. Slope/jacobian fields are skipped — buoyancy
 * needs only height + horizontal displacement; the shared fields' math is
 * bit-identical in structure to the GPU's.
 */
import { SIM_DT } from '../core/loop';
import {
  cascadeBand,
  cpuButterflyIFFT,
  generateButterfly,
  generateH0,
  GRAVITY,
} from '../ocean/oceanMath';
import { oceanParams, type OceanParams } from '../params/ocean';
import { seaPhysicsParams, type SeaPhysicsParams } from '../params/seaPhysics';

/** cascades mirrored for buoyancy (see header: cascade 2 excluded) */
export const MIRRORED_CASCADES = 2;

/** 2D inverse FFT: cpuButterflyIFFT applied row-wise then column-wise. */
export function cpuIFFT2D(
  grid: { re: Float32Array; im: Float32Array },
  butterfly: Float32Array,
  n: number,
): void {
  const lineRe = new Float32Array(n);
  const lineIm = new Float32Array(n);
  for (let m = 0; m < n; m++) {
    lineRe.set(grid.re.subarray(m * n, m * n + n));
    lineIm.set(grid.im.subarray(m * n, m * n + n));
    const out = cpuButterflyIFFT({ re: lineRe, im: lineIm }, butterfly, n);
    grid.re.set(out.re, m * n);
    grid.im.set(out.im, m * n);
  }
  for (let c = 0; c < n; c++) {
    for (let m = 0; m < n; m++) {
      lineRe[m] = grid.re[m * n + c];
      lineIm[m] = grid.im[m * n + c];
    }
    const out = cpuButterflyIFFT({ re: lineRe, im: lineIm }, butterfly, n);
    for (let m = 0; m < n; m++) {
      grid.re[m * n + c] = out.re[m];
      grid.im[m * n + c] = out.im[m];
    }
  }
}

/** central k-space block of a full-res h0 grid (RGBA texels) — see header */
export function extractCentralBlock(
  full: Float32Array,
  fullN: number,
  redN: number,
): Float32Array {
  const off = (fullN - redN) / 2;
  const out = new Float32Array(redN * redN * 4);
  for (let m = 0; m < redN; m++) {
    for (let n = 0; n < redN; n++) {
      const src = ((m + off) * fullN + (n + off)) * 4;
      out.set(full.subarray(src, src + 4), (m * redN + n) * 4);
    }
  }
  return out;
}

class MirrorCascade {
  readonly domain: number;
  readonly height: Float32Array;
  readonly dx: Float32Array;
  readonly dz: Float32Array;
  private readonly n: number;
  private readonly h0: Float32Array;
  private readonly omega: Float32Array;
  private readonly kxN: Float32Array; // kx/|k|, 0 at DC
  private readonly kzN: Float32Array;
  private readonly a: { re: Float32Array; im: Float32Array };
  private readonly b: { re: Float32Array; im: Float32Array };

  constructor(index: number, seed: number, p: OceanParams, redN: number) {
    this.n = redN;
    this.domain = p.cascades[index].domain;
    const band = cascadeBand(index, p.splitWavelengths);
    const kEdge = (Math.PI * redN) / this.domain;
    if (band.kMax >= kEdge) {
      throw new Error(
        `mirrorResolution ${redN} too low for cascade ${index}: ` +
          `band kMax ${band.kMax.toFixed(3)} ≥ grid edge ${kEdge.toFixed(3)}`,
      );
    }
    // identical h0 call to OceanCascade.generateSpectrumData (§V.8)
    const full = generateH0(p.resolution, this.domain, seed + index * 7919, p, band);
    this.h0 = extractCentralBlock(full, p.resolution, redN);
    const size = redN * redN;
    this.omega = new Float32Array(size);
    this.kxN = new Float32Array(size);
    this.kzN = new Float32Array(size);
    for (let m = 0; m < redN; m++) {
      for (let x = 0; x < redN; x++) {
        const kx = (2 * Math.PI * (x - redN / 2)) / this.domain;
        const kz = (2 * Math.PI * (m - redN / 2)) / this.domain;
        const k = Math.hypot(kx, kz);
        const i = m * redN + x;
        this.omega[i] = Math.sqrt(GRAVITY * k);
        const safeK = Math.max(k, 1e-6);
        this.kxN[i] = kx / safeK;
        this.kzN[i] = kz / safeK;
      }
    }
    this.height = new Float32Array(size);
    this.dx = new Float32Array(size);
    this.dz = new Float32Array(size);
    this.a = { re: new Float32Array(size), im: new Float32Array(size) };
    this.b = { re: new Float32Array(size), im: new Float32Array(size) };
  }

  /** evolve spectrum to `time`, IFFT, unpack → height/dx/dz grids */
  compute(time: number, butterfly: Float32Array, choppiness: number): void {
    const n = this.n;
    for (let i = 0; i < n * n; i++) {
      const phase = this.omega[i] * time;
      const c = Math.cos(phase);
      const s = Math.sin(phase);
      const r0 = this.h0[i * 4];
      const i0 = this.h0[i * 4 + 1];
      const r1 = this.h0[i * 4 + 2];
      const i1 = this.h0[i * 4 + 3];
      // h = h0(k)e^{iωt} + conj(h0(−k))e^{−iωt}  (as spectrumPass)
      const hRe = (r0 + r1) * c - (i0 + i1) * s;
      const hIm = (r0 - r1) * s + (i0 - i1) * c;
      // Dx = i·(kx/|k|)·h ; packing A = h + i·Dx collapses to h·(1 − kx/|k|)
      this.a.re[i] = hRe * (1 - this.kxN[i]);
      this.a.im[i] = hIm * (1 - this.kxN[i]);
      // B = Dz spectrum = i·(kz/|k|)·h (Hermitian → real field after IFFT)
      this.b.re[i] = -hIm * this.kzN[i];
      this.b.im[i] = hRe * this.kzN[i];
    }
    cpuIFFT2D(this.a, butterfly, n);
    cpuIFFT2D(this.b, butterfly, n);
    for (let m = 0; m < n; m++) {
      for (let x = 0; x < n; x++) {
        const i = m * n + x;
        const sign = (x + m) & 1 ? -1 : 1; // (−1)^(x+y), as unpackPass
        this.height[i] = sign * this.a.re[i];
        this.dx[i] = sign * this.a.im[i] * choppiness;
        this.dz[i] = sign * this.b.re[i] * choppiness;
      }
    }
  }

  /** bilinear sample with wrap; half-texel offset matches GPU texture() */
  sample(grid: Float32Array, x: number, z: number): number {
    const n = this.n;
    const u = (x / this.domain) * n - 0.5;
    const v = (z / this.domain) * n - 0.5;
    const iu = Math.floor(u);
    const iv = Math.floor(v);
    const fu = u - iu;
    const fv = v - iv;
    const x0 = ((iu % n) + n) % n;
    const x1 = (x0 + 1) % n;
    const z0 = ((iv % n) + n) % n;
    const z1 = (z0 + 1) % n;
    const g00 = grid[z0 * n + x0];
    const g10 = grid[z0 * n + x1];
    const g01 = grid[z1 * n + x0];
    const g11 = grid[z1 * n + x1];
    return (
      (g00 * (1 - fu) + g10 * fu) * (1 - fv) + (g01 * (1 - fu) + g11 * fu) * fv
    );
  }
}

export interface SurfaceSample {
  height: number;
  dx: number;
  dz: number;
}

export class CpuOcean {
  private readonly cascades: MirrorCascade[];
  private readonly butterfly: Float32Array;
  private readonly oceanP: OceanParams;
  private readonly seaP: SeaPhysicsParams;
  private time = NaN;
  private gridTime = NaN;

  constructor(
    seed: number,
    oceanP: OceanParams = oceanParams,
    seaP: SeaPhysicsParams = seaPhysicsParams,
  ) {
    this.oceanP = oceanP;
    this.seaP = seaP;
    const n = seaP.mirrorResolution;
    this.butterfly = generateButterfly(n);
    this.cascades = [];
    for (let i = 0; i < MIRRORED_CASCADES; i++) {
      this.cascades.push(new MirrorCascade(i, seed, oceanP, n));
    }
  }

  /** sim time of the last update() call (grids may lag ≤ updateEveryTicks) */
  get currentTime(): number {
    return this.time;
  }

  /** advance mirror to sim time; grids recompute every updateEveryTicks */
  update(time: number): void {
    this.time = time;
    const staleFor = Math.abs(time - this.gridTime);
    if (staleFor < this.seaP.updateEveryTicks * SIM_DT - 1e-9) return;
    for (const c of this.cascades) {
      c.compute(time, this.butterfly, this.oceanP.choppiness);
    }
    this.gridTime = time;
  }

  /** summed cascade fields at UNDISPLACED grid coords (x,z) — no inversion */
  sampleRaw(x: number, z: number): SurfaceSample {
    let height = 0;
    let dx = 0;
    let dz = 0;
    for (const c of this.cascades) {
      height += c.sample(c.height, x, z);
      dx += c.sample(c.dx, x, z);
      dz += c.sample(c.dz, x, z);
    }
    return { height, dx, dz };
  }

  /**
   * Water height at world (x,z). The IFFT gives height at DISPLACED
   * positions (x+Dx, z+Dz), so fixed-point iterate x_q = x − Dx(x_q) to
   * find the grid coord whose displaced position lands on the query.
   */
  heightAt(x: number, z: number, time: number): number {
    if (time !== this.time || Number.isNaN(this.gridTime)) this.update(time);
    let qx = x;
    let qz = z;
    for (let it = 0; it < this.seaP.inverseDisplacementIterations; it++) {
      let dx = 0;
      let dz = 0;
      for (const c of this.cascades) {
        dx += c.sample(c.dx, qx, qz);
        dz += c.sample(c.dz, qx, qz);
      }
      qx = x - dx;
      qz = z - dz;
    }
    let height = 0;
    for (const c of this.cascades) height += c.sample(c.height, qx, qz);
    return height;
  }
}
