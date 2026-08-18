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
 *
 * SHOALING (§V.72) rides on top of all of that, from the SHARED definition in
 * src/ocean/shoaling.ts rather than from a second implementation: the sea
 * calms over its own shallows on the GPU, so it must calm identically here or
 * the hull floats at open-ocean height over a calmed lagoon. Two things make
 * "same formula" insufficient and are therefore load-bearing here —
 *  · the depth is read at the GRID COORD the inversion solves for, not at the
 *    query point, because that grid coord is the vertex the GPU displaced;
 *  · the depth is measured against STILL WATER, so neither side has to know
 *    the other's displacement to agree.
 * Both are §V.72's own text. Cascade 2 is still unmirrored, so the two sides
 * differ by its (σ ≈ 0.07 m) contribution exactly as they did before.
 */
import { SIM_DT } from '../core/loop';
import {
  cascadeBand,
  cpuButterflyIFFT,
  effectiveChoppiness,
  generateButterfly,
  generateH0,
  GRAVITY,
  spectralJacobianRms,
  spectralMeanWavenumber,
} from '../ocean/oceanMath';
import {
  breakerClip,
  shoalFactor,
  shoalWavenumber,
} from '../ocean/shoaling';
import { oceanParams, type OceanParams } from '../params/ocean';
import { seaPhysicsParams, type SeaPhysicsParams } from '../params/seaPhysics';
import type { SeabedField } from './grounding';

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
  // fail loud: redN > fullN makes `off` negative and the reads run off the
  // front of the buffer, which returns zeros/garbage rather than throwing —
  // a mirror that silently carries no spectrum at all (§V.28: sanitize the
  // construction-time ints, do not discover it as "the ship stopped floating")
  if (!Number.isInteger(redN) || redN < 2 || redN > fullN || (fullN - redN) % 2 !== 0) {
    throw new Error(
      `extractCentralBlock: redN ${redN} must be an even-offset integer in [2, ${fullN}]`,
    );
  }
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
  /**
   * This band's energy-weighted mean wavenumber (rad/m), from the SAME
   * `spectralMeanWavenumber` call `OceanCascade` makes — so the shoaling
   * attenuation the ship floats on is derived from the same measurement of the
   * same band as the one the GPU draws (§V.8, §V.72).
   */
  readonly meanWavenumber: number;
  readonly height: Float32Array;
  /**
   * THE SMITH-CORRECTED HEIGHT — the field a hull actually feels (§V.68).
   *
   * A floating body does not respond to the free SURFACE, it responds to the
   * PRESSURE integrated over its wetted volume, and in linear deep-water wave
   * theory the dynamic pressure of a mode k decays with depth as e^(−k·d).
   * For the wall-sided prism sections this model already uses (`immersedDepth`
   * runs a slice from keel to deck at constant breadth) the vertical
   * Froude–Krylov force is the pressure at the KEEL times the waterplane, so
   * the wave part of the force is ρg·A·ζ·e^(−k·T) — the surface elevation
   * with every mode scaled by its own depth decay. That is the Smith effect,
   * and it is why a long swell lifts a ship bodily while short chop passes
   * under her: at T = 2 m a 189 m swell arrives at 94% while an 8 m ripple
   * arrives at 21%. The hull low-passes the sea BY ITS OWN DRAFT, as a
   * consequence of where it sits rather than as a filter anyone tuned.
   *
   * This is a per-MODE factor, so it belongs in k-space, not at the sampler:
   * applying it here costs one multiply-add per mode and NO extra IFFT (see
   * `compute` — it rides in the free imaginary half of the Dz transform),
   * where a per-station spatial kernel cost five heightAt calls per station
   * and could only ever approximate one direction of it.
   *
   * `height` stays the TRUE surface: §V.8 (ships float on the sea that is
   * drawn) is a claim about geometry — waterline, spray, green water, camera
   * — and every geometric consumer keeps reading it. Only the FORCE reads
   * this field, because only the force is an integral of pressure.
   */
  readonly head: Float32Array;
  readonly dx: Float32Array;
  readonly dz: Float32Array;
  private readonly n: number;
  /**
   * The GPU's half-texel, expressed in THIS grid's index units (§B.34).
   *
   * `texture(displacement, worldXZ/domain)` is a hardware bilinear fetch, so
   * texel i's centre sits at (i+0.5)/R in UV while the IFFT wrote texel i
   * with the field at i·domain/R. The surface the GPU DRAWS is therefore the
   * field shifted by half a GPU texel, domain/(2·R) — and §V.8 says we float
   * the ship on the sea that is drawn, so the mirror has to reproduce that
   * same shift.
   *
   * It has to reproduce it in METRES. The old code wrote a literal −0.5,
   * which is half a MIRROR texel, and the mirror is 64² where the GPU is
   * 512² — so the sea the ship floated on was displaced from the sea on
   * screen by domain·(1/128 − 1/1024). At the old 420 m cascade that was
   * 2.9 m and nobody caught it; when the domain went to 1010 m to carry the
   * swell it became 6.90 m, a fifth of the hull's length, and the ship was
   * feeling a wave that visibly belonged a third of a beam away.
   */
  private readonly halfTexel: number;
  /**
   * Cubic reconstruction only where the grid is MARGINAL. Bilinear is what
   * the GPU does and it is fine when a wave gets plenty of samples; it falls
   * apart near Nyquist, which is exactly where cascade 0 now lives (its 40 m
   * band edge gets 2.53 samples per cycle at 1010 m / 64). Cascade 1 gets
   * 5.42 and does not need it. Decided from the numbers rather than hardwired
   * per cascade, so the next domain change re-decides it instead of silently
   * inheriting a choice made for a domain that no longer exists.
   */
  private readonly cubic: boolean;
  private readonly h0: Float32Array;
  private readonly omega: Float32Array;
  private readonly kxN: Float32Array; // kx/|k|, 0 at DC
  private readonly kzN: Float32Array;
  private readonly kMag: Float32Array;
  /** e^(−k·depth) per mode; rebuilt only when the depth moves */
  private readonly atten: Float32Array;
  private attenDepth = Number.NaN;
  private readonly a: { re: Float32Array; im: Float32Array };
  private readonly b: { re: Float32Array; im: Float32Array };

  constructor(index: number, seed: number, p: OceanParams, redN: number) {
    this.n = redN;
    this.domain = p.cascades[index].domain;
    this.halfTexel = redN / (2 * p.resolution);
    const band = cascadeBand(index, p.splitWavelengths);
    const shortest = (2 * Math.PI) / band.kMax;
    this.cubic = shortest / (this.domain / redN) < 6;
    const kEdge = (Math.PI * redN) / this.domain;
    if (band.kMax >= kEdge) {
      throw new Error(
        `mirrorResolution ${redN} too low for cascade ${index}: ` +
          `band kMax ${band.kMax.toFixed(3)} ≥ grid edge ${kEdge.toFixed(3)}`,
      );
    }
    this.meanWavenumber = spectralMeanWavenumber(p.resolution, this.domain, p, band);
    // identical h0 call to OceanCascade.generateSpectrumData (§V.8)
    const full = generateH0(p.resolution, this.domain, seed + index * 7919, p, band);
    this.h0 = extractCentralBlock(full, p.resolution, redN);
    const size = redN * redN;
    this.omega = new Float32Array(size);
    this.kxN = new Float32Array(size);
    this.kzN = new Float32Array(size);
    this.kMag = new Float32Array(size);
    this.atten = new Float32Array(size);
    for (let m = 0; m < redN; m++) {
      for (let x = 0; x < redN; x++) {
        const kx = (2 * Math.PI * (x - redN / 2)) / this.domain;
        const kz = (2 * Math.PI * (m - redN / 2)) / this.domain;
        const k = Math.hypot(kx, kz);
        const i = m * redN + x;
        this.omega[i] = Math.sqrt(GRAVITY * k);
        this.kMag[i] = k;
        const safeK = Math.max(k, 1e-6);
        this.kxN[i] = kx / safeK;
        this.kzN[i] = kz / safeK;
      }
    }
    this.height = new Float32Array(size);
    this.head = new Float32Array(size);
    this.dx = new Float32Array(size);
    this.dz = new Float32Array(size);
    this.a = { re: new Float32Array(size), im: new Float32Array(size) };
    this.b = { re: new Float32Array(size), im: new Float32Array(size) };
  }

  /**
   * Evolve spectrum to `time`, IFFT, unpack → height/head/dx/dz grids.
   *
   * THE SMITH FIELD IS FREE. Two complex IFFTs already run here, and each
   * carries two real fields: A = h + i·Dx uses both halves, but B = i·(kz/|k|)h
   * is Hermitian, so its IFFT is purely REAL and the whole imaginary half was
   * being discarded. Adding i·e^(−k·d)·h to B fills it: that term is
   * ANTI-Hermitian (e^(−k·d) is even and real, h is Hermitian), so it
   * transforms to a purely IMAGINARY field and the two separate exactly —
   * IFFT(B').re is still Dz, IFFT(B').im is the attenuated height. Cost of
   * the correction is therefore one multiply-add per mode and one grid, not
   * a third transform (the IFFT is 71% of a sim tick, §B.42).
   */
  compute(
    time: number,
    butterfly: Float32Array,
    choppiness: number,
    smithDepth: number,
  ): void {
    const n = this.n;
    if (this.attenDepth !== smithDepth) {
      const d = Math.max(0, smithDepth);
      for (let i = 0; i < n * n; i++) this.atten[i] = Math.exp(-this.kMag[i] * d);
      this.attenDepth = smithDepth;
    }
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
      // B = Dz spectrum + i·(Smith-attenuated height spectrum): both are
      // i·(real, even-or-odd)·h, so they collapse to one complex multiply
      const g = this.kzN[i] + this.atten[i];
      this.b.re[i] = -hIm * g;
      this.b.im[i] = hRe * g;
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
        // a HEIGHT, so no choppiness: λ displaces crests sideways, it does
        // not change how hard the water pushes up under the keel
        this.head[i] = sign * this.b.im[i];
      }
    }
  }

  /**
   * CATMULL-ROM sample with wrap; half-texel offset matches GPU texture().
   *
   * WHY NOT BILINEAR (§B.34). The grid VALUES are exact — the IFFT output is
   * the true field at the nodes, and the ctor guarantees every mode in the
   * band is represented. All the error is in what happens BETWEEN the nodes,
   * and that error is a function of how many samples the shortest wave in
   * the band gets. Cascade 0's domain went 420 m → 1010 m to carry a 189 m
   * swell, its mirror stayed at 64², and its grid step went 6.6 m → 15.8 m:
   * the 40 m wave at the top of its band fell to 2.53 samples per cycle,
   * where a straight line between samples is nothing like a sine.
   *
   * Measured against a 512² mirror of the SAME modes, so the comparison is
   * purely reconstruction: bilinear was wrong by 0.582 m RMS on a σ = 1.0 m
   * sea — 58% of sigma, peaks of 2.7 m. That is the ship floating on a
   * different ocean from the one drawn, which is exactly what §V.8 forbids,
   * and it was invisible because nothing compares the two.
   *
   * Raising N is the obvious fix and it is unaffordable: the mirror's own
   * FFT is O(N² log N), measured 1.40 ms/tick at 64², 6.06 at 128², 23.99 at
   * 256² — the whole sim tick budget, for a grid nobody looks at. Cubic
   * reconstruction costs 16 taps instead of 4 on a step that is not the
   * bottleneck, and buys more than the 4× grid does.
   */
  sample(grid: Float32Array, x: number, z: number): number {
    const n = this.n;
    const u = (x / this.domain) * n - this.halfTexel;
    const v = (z / this.domain) * n - this.halfTexel;
    const iu = Math.floor(u);
    const iv = Math.floor(v);
    const fu = u - iu;
    const fv = v - iv;
    if (!this.cubic) {
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
    // Catmull-Rom basis at fu / fv (tangents from the neighbouring nodes).
    // Two buffers, not one shared scratch: the second fill would otherwise
    // clobber the first and both axes would use the v weights.
    const wu = cubicWeights(fu, CUBIC_U);
    const wv = cubicWeights(fv, CUBIC_V);
    let acc = 0;
    for (let j = 0; j < 4; j++) {
      const zz = (((iv + j - 1) % n) + n) % n;
      const row = zz * n;
      let rowAcc = 0;
      for (let i = 0; i < 4; i++) {
        const xx = (((iu + i - 1) % n) + n) % n;
        rowAcc += wu[i] * grid[row + xx];
      }
      acc += wv[j] * rowAcc;
    }
    return acc;
  }
}

/**
 * Catmull-Rom weights for the four nodes at t−1, t, t+1, t+2. Interpolating
 * (passes through every node, so the grid's exact values survive) and C1, so
 * the surface slope the hull integrates has no per-cell kinks — bilinear's
 * slope is piecewise constant, which is its own small source of chatter.
 */
const CUBIC_U = [0, 0, 0, 0];
const CUBIC_V = [0, 0, 0, 0];
function cubicWeights(t: number, out: number[]): number[] {
  const t2 = t * t;
  const t3 = t2 * t;
  out[0] = 0.5 * (-t3 + 2 * t2 - t);
  out[1] = 0.5 * (3 * t3 - 5 * t2 + 2);
  out[2] = 0.5 * (-3 * t3 + 4 * t2 + t);
  out[3] = 0.5 * (t3 - t2);
  return out;
}

export interface SurfaceSample {
  height: number;
  dx: number;
  dz: number;
}

/**
 * The slice of the mirror buoyancy actually consumes. Declared structurally
 * so tests can drive the hull with an analytic sea (a single sine of known
 * wavelength) and assert the hull's frequency response directly — with the
 * concrete class the only available sea is a full FFT spectrum, where every
 * wavelength is present at once and "does short chop move the ship?" cannot
 * be isolated. CpuOcean satisfies it without implementing it.
 */
export interface OceanHeightField {
  /** sim time of the last update() (NaN before the first) */
  readonly currentTime: number;
  /**
   * The TRUE free surface at (x,z) — the sea that is drawn (§V.8). Every
   * GEOMETRIC question reads this: waterline, cutwater, green water, spray,
   * camera, shore runup.
   */
  heightAt(x: number, z: number, time: number): number;
  /**
   * The surface elevation whose HYDROSTATIC head equals the wave's real
   * dynamic pressure at the hull's reference depth — every mode scaled by
   * e^(−k·d) (§V.68, the Smith effect; see MirrorCascade.head). Buoyancy
   * integrates pressure, so buoyancy reads THIS, and it is the whole reason
   * a deep hull cannot be shoved about by chop it is sitting underneath.
   *
   * Required, not optional: a default that quietly fell back to `heightAt`
   * would restore the defect silently in any sea that forgot to implement it
   * (§V.62), and every analytic test sea can state its own e^(−k·d) exactly.
   */
  pressureHeadAt(x: number, z: number, time: number): number;
}

/**
 * Params whose change requires h0 regeneration — MUST match the GPU's
 * spectrumSignature (oceanCascades.ts): weather transitions lerp
 * amplitude/windSpeed live, the GPU rebuilds its spectrum, and a mirror
 * that kept floating ships on the launch-time sea is exactly the drift V8
 * forbids ("storm waves roll over an unaffected ship").
 * mirrorResolution is CPU-only but rebuild-shaped too, so it's included.
 */
function mirrorSignature(p: OceanParams, seaP: SeaPhysicsParams): string {
  return [
    p.resolution, p.amplitude, p.windSpeed, p.windDirection,
    p.spreadPeak, p.spreadBelowPeak, p.spreadAbovePeak, p.spreadMin,
    p.oppositeWaveDamp, p.smallWaveCutoff,
    p.splitWavelengths, p.cascades.map((c) => c.domain),
    // the SWELL train too — the presets lerp all three of these, and a mirror
    // that misses them is §B.7 in its original form (§V.8)
    p.swellPeriod, p.swellAmplitude, p.swellDirection,
    p.swellDirectionality, p.swellBandwidth, p.swellGridModes,
    seaP.mirrorResolution,
  ].join('|');
}

/**
 * Σ-over-cascades displacement-gradient RMS, exactly as OceanSimulation
 * .refreshSeaState aggregates it: variance summed over ALL THREE GPU
 * cascades (not just the two mirrored here — the fold cap the GPU applies
 * is one number for the whole sea) then square-rooted. Cached with the
 * spectrum: it only moves when a spectrum-shaping param moves.
 */
function totalJacobianRms(p: OceanParams): number {
  let variance = 0;
  for (let i = 0; i < p.cascades.length; i++) {
    const s = spectralJacobianRms(
      p.resolution,
      p.cascades[i].domain,
      p,
      cascadeBand(i, p.splitWavelengths),
    );
    variance += s * s;
  }
  return Math.sqrt(Math.max(0, variance));
}

export class CpuOcean {
  private cascades: MirrorCascade[];
  private butterfly: Float32Array;
  private readonly seed: number;
  private readonly oceanP: OceanParams;
  private readonly seaP: SeaPhysicsParams;
  private signature: string;
  /** §V.59 direction-free trace moment — what the fold cap must divide by */
  private jacobianRms: number;
  private rebuildCountdown = -1;
  private time = NaN;
  private gridTime = NaN;
  /**
   * §V.72 THE SEABED, and the reason it is OPTIONAL and STRUCTURAL.
   *
   * Optional: an open-ocean scene (and most of the test suite) has no islands,
   * and with no bed there is nothing to shoal against — every path below
   * short-circuits to the pre-shoaling behaviour, bit-identically.
   *
   * Structural (`{ heightAt }`, the interface grounding.ts already declares)
   * rather than the concrete `island/seabed`: §V.3 keeps sea-physics free of
   * the engine and of the island's params, and a test can hand this an
   * analytic beach — `{ heightAt: () => -3 }` — which is the only way to
   * assert the shoaling law at a KNOWN depth.
   */
  private seabed: SeabedField | null = null;
  /**
   * Per-cascade shoaling wavenumber (rad/m) — the band's own mean k, floored
   * so no band's transition reaches deeper than the world's sea floor. Cached
   * per tick rather than per sample: it moves only when the spectrum, the
   * shoaling params or the bed's open depth move, and `heightAt` is called
   * many times per tick by the hull stations.
   */
  private shoalK: number[] = [];
  /** open-ocean water depth (m) reported by the bed away from any island */
  private openDepth = 0;

  constructor(
    seed: number,
    oceanP: OceanParams = oceanParams,
    seaP: SeaPhysicsParams = seaPhysicsParams,
  ) {
    this.seed = seed;
    this.oceanP = oceanP;
    this.seaP = seaP;
    this.signature = mirrorSignature(oceanP, seaP);
    this.jacobianRms = totalJacobianRms(oceanP);
    const n = seaP.mirrorResolution;
    this.butterfly = generateButterfly(n);
    this.cascades = [];
    for (let i = 0; i < MIRRORED_CASCADES; i++) {
      this.cascades.push(new MirrorCascade(i, seed, oceanP, n));
    }
    this.refreshShoal();
  }

  /**
   * Wire the seabed the sea shoals over (§V.72). Separate from the constructor
   * because the mirror is built from a seed alone and the archipelago is built
   * later; call it once, at startup, with the SAME field the ocean material
   * was handed — two different beds is §V.8 with extra steps.
   *
   * `openDepth` is read from the field rather than from params/island so that
   * sea-physics keeps its §V.3 independence: it is data, not a dependency.
   */
  setSeabed(seabed: SeabedField | null, openDepth: number): void {
    this.seabed = seabed;
    this.openDepth = Math.max(openDepth, 0);
    this.refreshShoal();
  }

  /** per-cascade shoaling wavenumbers — see `shoalK` */
  private refreshShoal(): void {
    this.shoalK = this.cascades.map((c) =>
      shoalWavenumber(c.meanWavenumber, this.openDepth, this.oceanP),
    );
  }

  /**
   * Water depth (m, ≥ 0) under still water at a GRID coord.
   *
   * §V.72: still water (y = 0), never the displaced surface — the displacement
   * is what is being attenuated, so keying it on itself is a feedback loop,
   * and the bed's own depth is what the vertex shader can cheaply agree with.
   */
  private depthAt(x: number, z: number): number {
    return this.seabed ? Math.max(-this.seabed.heightAt(x, z), 0) : 0;
  }

  /** sim time of the last update() call (grids may lag ≤ updateEveryTicks) */
  get currentTime(): number {
    return this.time;
  }

  /**
   * The Tessendorf λ this mirror displaces with — the FOLD-CAPPED value,
   * never the raw slider (§V.8). The GPU caps λ so that λ·σ_gradient stays
   * under choppinessFoldLimit, which is what stops a storm sea folding into
   * shards; a mirror that kept using the raw slider would put every crest
   * at a different horizontal position than the one drawn, and the ship
   * would float on a sea nobody can see — §B.7 by another route. Derived
   * per call from the cached steepness, exactly as OceanSimulation does it,
   * so a live choppiness tweak tracks on both sides within a frame.
   */
  effectiveChoppiness(): number {
    return effectiveChoppiness(
      this.oceanP.choppiness,
      this.jacobianRms,
      this.oceanP.choppinessFoldLimit,
    );
  }

  /** advance mirror to sim time; grids recompute every updateEveryTicks */
  update(time: number): void {
    this.time = time;
    // track live spectrum-shaping tweaks; same 15-tick debounce (~250 ms)
    // as the GPU so both sides settle on the new sea near-simultaneously
    const sig = mirrorSignature(this.oceanP, this.seaP);
    if (sig !== this.signature) {
      this.signature = sig;
      this.rebuildCountdown = 15;
    }
    if (this.rebuildCountdown >= 0 && this.rebuildCountdown-- === 0) {
      const n = this.seaP.mirrorResolution;
      this.butterfly = generateButterfly(n);
      this.cascades = [];
      for (let i = 0; i < MIRRORED_CASCADES; i++) {
        this.cascades.push(new MirrorCascade(i, this.seed, this.oceanP, n));
      }
      // the fold cap is measured on the spectrum, so it moves with it
      this.jacobianRms = totalJacobianRms(this.oceanP);
      this.gridTime = NaN; // force recompute below
    }
    // §V.72: cheap (one max + one divide per cascade) and it has to run every
    // tick, not only on rebuild — the shoaling params are NOT spectrum params,
    // so `mirrorSignature` deliberately does not see them and a value cached
    // on the rebuild path would ignore a live tweak (§V.62). The GPU refreshes
    // the same numbers in `updateFromParams`, from the same function.
    this.refreshShoal();
    const staleFor = Math.abs(time - this.gridTime);
    if (staleFor < this.seaP.updateEveryTicks * SIM_DT - 1e-9) return;
    const lambda = this.effectiveChoppiness();
    const depth = this.smithDepth();
    for (const c of this.cascades) {
      c.compute(time, this.butterfly, lambda, depth);
    }
    this.gridTime = time;
  }

  /**
   * Depth the Smith attenuation is evaluated at: the hull's own draft (§V.66
   * — a feature scaled by its own dimension), times a coefficient for the
   * section shape. It is read per update rather than baked at construction so
   * a live draft tweak drives something (§V.62); the exponentials only
   * recompute when it actually moves.
   *
   * ONE depth for the whole mirror, which is what keeps `update(t)` a pure
   * function of time (§B.42): it depends on a PARAM, not on any ship, so
   * every hull afloat still shares one sea and one IFFT. A second ship class
   * with a materially different draft would need its own field, and that is
   * a spectrum-level decision, not a per-station one.
   */
  private smithDepth(): number {
    return Math.max(0, this.seaP.hullDraft * this.seaP.smithDepthScale);
  }

  /**
   * Summed cascade fields at UNDISPLACED grid coords (x,z) — no inversion, and
   * deliberately NO shoaling either: this is the open-ocean spectrum as the
   * IFFT produced it, which is what a statistical check of the mirror wants.
   * Anything asking "how high is the water HERE" must use `heightAt` (§V.8).
   */
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
   * The IFFT gives its fields at DISPLACED positions (x+Dx, z+Dz), so
   * fixed-point iterate x_q = x − Dx(x_q) to find the grid coord whose
   * displaced position lands on the query. Both `heightAt` and
   * `pressureHeadAt` need the same coord, and it is by far the expensive
   * half of a lookup (`inverseDisplacementIterations` × 2 cascades × 2
   * grids), so it lives in one place.
   */
  private gridCoord(x: number, z: number, out: [number, number]): void {
    let qx = x;
    let qz = z;
    for (let it = 0; it < this.seaP.inverseDisplacementIterations; it++) {
      let dx = 0;
      let dz = 0;
      // §V.72: the fixed point the GPU actually satisfies is
      // x = q + shoal(depth(q))·D(q) — the vertex shader scales the WHOLE
      // displacement, horizontal included, by the per-cascade factor. Reading
      // the depth at the current iterate converges to depth(q) along with the
      // coord itself, so the two sides land on the same grid point instead of
      // one of them solving a slightly different equation.
      const depth = this.depthAt(qx, qz);
      for (let i = 0; i < this.cascades.length; i++) {
        const c = this.cascades[i];
        const g = this.seabed ? shoalFactor(this.shoalK[i], depth) : 1;
        dx += c.sample(c.dx, qx, qz) * g;
        dz += c.sample(c.dz, qx, qz) * g;
      }
      qx = x - dx;
      qz = z - dz;
    }
    out[0] = qx;
    out[1] = qz;
  }

  /**
   * Σ over cascades of a grid, each band scaled by its own shoaling factor,
   * then depth-limited (§V.72). ONE place, because `heightAt` and
   * `pressureHeadAt` must not be able to shoal differently — and because this
   * is the expression that has to stay in step with `positionNode` in
   * surfaceMaterial.ts.
   *
   * The clip is applied to the PRESSURE HEAD too. It is a geometric limiter,
   * not a pressure one, so that is an approximation; it is the right one,
   * because a hull in water shallow enough for the clip to engage is a hull
   * that grounding already owns, and letting the two fields disagree about how
   * big the wave is would put buoyancy and waterline on different seas.
   */
  private shoaledSum(
    grid: (c: MirrorCascade) => Float32Array,
    qx: number,
    qz: number,
  ): number {
    if (!this.seabed) {
      let sum = 0;
      for (const c of this.cascades) sum += c.sample(grid(c), qx, qz);
      return sum;
    }
    const depth = this.depthAt(qx, qz);
    let sum = 0;
    for (let i = 0; i < this.cascades.length; i++) {
      const c = this.cascades[i];
      sum += c.sample(grid(c), qx, qz) * shoalFactor(this.shoalK[i], depth);
    }
    return breakerClip(sum, depth, this.oceanP);
  }

  private readonly q: [number, number] = [0, 0];

  /** Water height at world (x,z) — the surface as drawn (§V.8). */
  heightAt(x: number, z: number, time: number): number {
    if (time !== this.time || Number.isNaN(this.gridTime)) this.update(time);
    this.gridCoord(x, z, this.q);
    return this.shoaledSum((c) => c.height, this.q[0], this.q[1]);
  }

  /** Smith-attenuated equivalent elevation at world (x,z) — see the field. */
  pressureHeadAt(x: number, z: number, time: number): number {
    if (time !== this.time || Number.isNaN(this.gridTime)) this.update(time);
    this.gridCoord(x, z, this.q);
    return this.shoaledSum((c) => c.head, this.q[0], this.q[1]);
  }
}
