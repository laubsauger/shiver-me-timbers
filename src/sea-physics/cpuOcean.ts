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
 * grows, breaks and dies over its own shallows on the GPU (§T.190), so it must
 * do so identically here or the hull floats on a different sea from the one
 * drawn. Breaking reads the Hs of ALL THREE bands (cascade 2 as statistics
 * only, see `shoalSigma`), because the GPU's does. Two things make
 * "same formula" insufficient and are therefore load-bearing here —
 *  · the depth is read at the GRID COORD the inversion solves for, not at the
 *    query point, because that grid coord is the vertex the GPU displaced;
 *  · the depth is measured against STILL WATER, so neither side has to know
 *    the other's displacement to agree.
 * Both are §V.72's own text. Cascade 2 is still unmirrored, so the two sides
 * differ by its (σ ≈ 0.07 m) contribution exactly as they did before.
 */
import { SIM_DT } from '../core/loop';
import { createCpuIFFT2D } from './cpuFft';
import {
  cascadeBand,
  effectiveChoppiness,
  generateButterfly,
  GRAVITY,
  type SpectrumData,
} from '../ocean/oceanMath';
import {
  SpectrumScheduler,
  type SpectrumSnapshot,
} from '../ocean/spectrumRebuild';
import {
  breakerClip,
  shoalBandGains,
  shoalWavenumber,
} from '../ocean/shoaling';
import {
  bandPropagation,
  SHOAL_ASYMMETRY_BANDS,
  shoalAsymmetryCoefficients,
  shoalAsymmetrySample,
  type AsymmetryBand,
} from '../ocean/shoalAsymmetry';
import {
  developmentRatio,
  fetchBandCoefficient,
  fetchBandGain,
  fullyDevelopedPeakWavenumber,
} from '../ocean/fetch';
import {
  swellBandShare,
  swellShadowGain,
  type ShelterSource,
} from '../ocean/swellShadow';
import { oceanParams, type OceanParams } from '../params/ocean';
import { seaPhysicsParams, type SeaPhysicsParams } from '../params/seaPhysics';
import type { SeabedField } from './grounding';

/** cascades mirrored for buoyancy (see header: cascade 2 excluded) */
export const MIRRORED_CASCADES = 2;

/** Standalone transform helper. Live cascades retain a plan across ticks. */
export function cpuIFFT2D(
  grid: { re: Float32Array; im: Float32Array },
  butterfly: Float32Array,
  n: number,
): void {
  createCpuIFFT2D(butterfly, n)(grid);
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
  /** band height variance from the same snapshot — T174's swell share divides by it */
  readonly heightVariance: number;
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
  private readonly transform: ReturnType<typeof createCpuIFFT2D>;
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
  /** Exact float32 frequencies shared by radial modes; no phase approximation. */
  private readonly omega: Float32Array;
  private readonly phaseIndex: Uint32Array;
  private readonly phaseCos: Float64Array;
  private readonly phaseSin: Float64Array;
  private readonly kxN: Float32Array; // kx/|k|, 0 at DC
  private readonly kzN: Float32Array;
  private readonly kMag: Float32Array;
  /** e^(−k·depth) per mode; rebuilt only when the depth moves */
  private readonly atten: Float32Array;
  private attenDepth = Number.NaN;
  private readonly a: { re: Float32Array; im: Float32Array };
  private readonly b: { re: Float32Array; im: Float32Array };

  /**
   * `spectrum` is THE SAME `SpectrumData` object `OceanCascade` was handed for
   * this band, out of the one `SpectrumScheduler` snapshot — not a second
   * computation of it (§V.8, and see spectrumRebuild.ts).
   *
   * WHAT THIS DELETED. The mirror used to re-derive, at full 512² and on the
   * same tick the GPU had just computed the identical numbers:
   * `spectralMeanWavenumber` per mirrored cascade, `generateH0` per mirrored
   * cascade, and — the expensive one — `spectralJacobianRms` for all THREE
   * cascades including the 22.7 m band, which alone measured 67.7 ms. Seven
   * 512² passes, 126 ms, for numbers that were already sitting in the
   * snapshot. `p` here is the snapshot's FROZEN params, so the band, the
   * domain and the resolution are the ones the h0 was actually built with
   * rather than whatever the live singleton has lerped to since.
   */
  constructor(index: number, p: OceanParams, redN: number, spectrum: SpectrumData) {
    this.n = redN;
    this.transform = createCpuIFFT2D(generateButterfly(redN), redN);
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
    this.meanWavenumber = spectrum.meanWavenumber;
    this.heightVariance = spectrum.heightVariance;
    this.h0 = extractCentralBlock(spectrum.h0, p.resolution, redN);
    const size = redN * redN;
    this.phaseIndex = new Uint32Array(size);
    const frequencyIndices = new Map<number, number>();
    const frequencies: number[] = [];
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
        const omega = Math.fround(Math.sqrt(GRAVITY * k));
        let phaseIndex = frequencyIndices.get(omega);
        if (phaseIndex === undefined) {
          phaseIndex = frequencies.length;
          frequencyIndices.set(omega, phaseIndex);
          frequencies.push(omega);
        }
        this.phaseIndex[i] = phaseIndex;
        this.kMag[i] = k;
        const safeK = Math.max(k, 1e-6);
        this.kxN[i] = kx / safeK;
        this.kzN[i] = kz / safeK;
      }
    }
    this.omega = new Float32Array(frequencies);
    // Keep Math.sin/cos results at JS double precision until spectral packing.
    this.phaseCos = new Float64Array(frequencies.length);
    this.phaseSin = new Float64Array(frequencies.length);
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
    choppiness: number,
    smithDepth: number,
  ): void {
    const n = this.n;
    if (this.attenDepth !== smithDepth) {
      const d = Math.max(0, smithDepth);
      for (let i = 0; i < n * n; i++) this.atten[i] = Math.exp(-this.kMag[i] * d);
      this.attenDepth = smithDepth;
    }
    for (let i = 0; i < this.omega.length; i++) {
      const phase = this.omega[i] * time;
      this.phaseCos[i] = Math.cos(phase);
      this.phaseSin[i] = Math.sin(phase);
    }
    for (let i = 0; i < n * n; i++) {
      const phaseIndex = this.phaseIndex[i];
      const c = this.phaseCos[phaseIndex];
      const s = this.phaseSin[phaseIndex];
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
    this.transform(this.a);
    this.transform(this.b);
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
 * §V.8 THE SHIP'S OWN WAKE, as part of the sea she floats on.
 *
 * `d9e8e22` wired `flowFoam.wakeHeightNode` into the ocean material's
 * `positionNode`, so the DRAWN surface carries wake elevation. This is the
 * other half: without it the hull floats on a sea that no longer exists, which
 * is §V.8's exact failure mode and the class of bug `f62e037` produced four
 * separate user reports from in one day.
 *
 * INCLUDE IT IN BOTH, WITH §V.68 DOING THE BOUNDING — this is the decision, and
 * the reason it is safe is STRUCTURAL rather than tuned:
 *  · `heightAt` (geometry: waterline, cutwater, spray, camera) takes the wake at
 *    FULL amplitude, because that is the surface the GPU draws;
 *  · `pressureHeadAt` (force: buoyancy) takes it attenuated by e^(−k·T) at each
 *    term's own wavenumber, exactly as this mirror's spectrum already does for
 *    every FFT mode (see `MirrorCascade.head`);
 *  · NO hull exclusion and NO damping, because `setShip(pos[x,z], yaw, speed,…)`
 *    takes NO y, NO pitch and NO roll. The wake field has no dependence on any
 *    degree of freedom buoyancy controls, so the heave→wake→heave loop is absent
 *    by construction rather than by being small.
 *
 * The one loop that is NOT closed by that argument is SURGE: buoyancy adds a
 * horizontal wave-slope force, so speed → mound → head gradient → surge → speed
 * is a real path, at one tick of delay. It is bounded by `smithAtten` like
 * everything else here and measured in the stability sweep (seaPhysics tests),
 * not assumed away.
 *
 * Structural (a one-method interface), not the concrete `FlowFoam`: §V.3 keeps
 * sea-physics free of the engine, and a test needs to be able to hand this an
 * analytic wake whose elevation and depth decay it knows in closed form.
 */
export interface WakeElevationField {
  /**
   * Wake surface elevation (m, signed) at a world XZ. `smithDepth` 0 = the true
   * free surface (geometry); > 0 = the elevation whose hydrostatic head equals
   * the wake's dynamic pressure at that depth (§V.68, force).
   */
  wakeHeightCpu(x: number, z: number, smithDepth: number): number;
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
 * WHAT IS LEFT OF THE MIRROR'S OWN REBUILD TRIGGER: its sampling resolutions.
 *
 * Every SPECTRUM param used to be listed here, duplicating the GPU's
 * `spectrumSignature` — two lists that had to be kept identical by hand, and
 * §B.7 is what happens when they are not. They no longer can diverge: the
 * mirror now rebuilds when the shared `SpectrumScheduler` publishes a new
 * snapshot, i.e. on the same statement the GPU adopts it, so "the same
 * spectrum params" is a pointer rather than a string comparison (§V.8).
 *
 * The base and chop mirror resolutions are independent of the GPU grid,
 * so changes to either must rebuild the mirror's sampling grids.
 */
function mirrorSignature(seaP: SeaPhysicsParams): string {
  return `${seaP.mirrorResolution}/${seaP.mirrorChopResolution}`;
}

export class CpuOcean {
  private cascades: MirrorCascade[];
  private readonly oceanP: OceanParams;
  private readonly seaP: SeaPhysicsParams;
  private signature: string;
  /** §V.59 direction-free trace moment — what the fold cap must divide by */
  private jacobianRms: number;
  /**
   * THE SPECTRUM SOURCE (§V.8, §B.51). Normally the very object
   * `OceanSimulation` owns, handed in by main.ts, so the drawn sea and the
   * floated sea are downstream of ONE amortised, double-buffered build and
   * swap on the same statement. When none is supplied — the headless suite,
   * and any test that drives a mirror with no GPU sim — the mirror builds its
   * own on the same schedule, so both configurations behave identically.
   */
  private readonly scheduler: SpectrumScheduler;
  /** true when this mirror must step the scheduler itself (no GPU sim above) */
  private readonly ownsScheduler: boolean;
  /** last snapshot built from — swap detection is object identity, not a key */
  private adopted: SpectrumSnapshot;
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
  /**
   * §T.190 per-band spectral height RMS (m) for EVERY cascade of the adopted
   * spectrum — including the one this mirror does not draw. Depth-limited
   * breaking caps the whole sea's Hs at a point, so the band the hull cannot
   * feel still counts toward whether the water is breaking (the GPU sums all
   * three; a two-band Hs here would break later than the drawn sea).
   */
  private shoalSigma: number[] = [];
  /** scratch for `bandGains` → `shoalBandGains` — the hot path must not allocate */
  private readonly shoalGains: number[] = [];
  /**
   * §T.193 shoaling asymmetry (src/ocean/shoalAsymmetry.ts): per mirrored band
   * its mean k, propagation direction and directional moments, plus the Smith
   * factor of its second harmonic e^(−2k̄T), refreshed with `shoalK`. The rest
   * is hot-path scratch.
   */
  private asymBands: AsymmetryBand[] = [];
  private asymHead: number[] = [];
  private readonly asymSkew: number[] = [0, 0];
  private readonly asymTilt: number[] = [0, 0];
  private readonly asymRatio: number[] = [0, 0];
  private readonly asymEta: number[] = [0, 0];
  private readonly asymProj: number[] = [0, 0];
  private readonly asymDy: number[] = [0, 0];
  /** open-ocean water depth (m) reported by the bed away from any island */
  private openDepth = 0;
  /**
   * §V.73 THE SHELTER FIELD, optional and structural for exactly the reasons
   * the seabed above is: an open-ocean scene has no land to hide behind, and a
   * test needs to be able to hand this an analytic shelter (`{ fetchAt: () =>
   * 120 }`) to assert the law at a KNOWN fetch.
   *
   * §V.8: this must be THE SAME field the ocean material and the terrain read.
   * Handing the mirror a different one — including none — floats the hull on
   * the open-ocean sea while the drawn water lies down inside the rim, which
   * is §B.34's disagreement arriving by a third route.
   */
  private fetch: ShelterSource | null = null;
  /** §V.8 the ship's own wake — see `WakeElevationField` and `setWakeField` */
  private wake: WakeElevationField | null = null;
  /**
   * Per-cascade (k_pfull/k_band)² — the band's entire dependence on wavenumber
   * in the fetch law, cached per tick for the same reason `shoalK` is: it moves
   * only when the spectrum or the wind speed moves, and `heightAt` is called
   * many times per tick by the hull stations.
   */
  private fetchC: number[] = [];
  /** T174 per-cascade swell share fᵢ, refreshed with `fetchC` (same call as the material) */
  private swellShare: number[] = [];
  /** scratch for `bandGains` — the hot path must not allocate */
  private readonly gains: number[] = [];

  constructor(
    seed: number,
    oceanP: OceanParams = oceanParams,
    seaP: SeaPhysicsParams = seaPhysicsParams,
    scheduler?: SpectrumScheduler,
  ) {
    this.oceanP = oceanP;
    this.seaP = seaP;
    this.signature = mirrorSignature(seaP);
    this.ownsScheduler = scheduler === undefined;
    this.scheduler = scheduler ?? new SpectrumScheduler(seed, oceanP);
    this.adopted = this.scheduler.current;
    this.jacobianRms = this.adopted.jacobianRms;
    this.cascades = [];
    this.buildCascades();
    this.refreshShoal();
  }

  /**
   * (Re)build the mirrored cascades from the CURRENT snapshot. Cheap by
   * construction — the N² work happened once, in the scheduler, for both
   * consumers: what is left here is a 64² central-block extraction per
   * cascade plus the per-mode k tables. Measured under 1 ms against the
   * 107.7 ms this used to cost (§B.51).
   */
  private buildCascades(): void {
    const snap = this.adopted;
    this.cascades = [];
    for (let i = 0; i < MIRRORED_CASCADES; i++) {
      // snap.params, not this.oceanP: an amortised build spans ticks and a
      // preset lerp moves the live singleton on every one of them, so the band
      // and the domain must come from the params the h0 was built with
      const n = i === 0 ? this.seaP.mirrorResolution
        : Math.max(this.seaP.mirrorResolution, this.seaP.mirrorChopResolution);
      this.cascades.push(new MirrorCascade(i, snap.params, n, snap.cascades[i]));
    }
    this.jacobianRms = snap.jacobianRms;
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

  /**
   * Wire the shelter field the sea is fetch-limited by (§V.73). Same contract
   * as `setSeabed`: call it once, at startup, with the SAME field the ocean
   * material and the caustics receiver were handed.
   */
  setFetch(fetch: ShelterSource | null): void {
    this.fetch = fetch;
    this.refreshFetch();
  }

  /**
   * Wire the wake the sea carries (§V.8). Same contract as `setSeabed` and
   * `setFetch`: call it once, at startup, with THE SAME `FlowFoam` instance the
   * ocean material was handed — the material reads `wakeHeightNode` off that
   * object's elevation texture and this reads `wakeHeightCpu` off the same
   * object's track, so "the same wake" is a pointer rather than two schedules
   * that have to agree (§B.34, `3ad1212`).
   *
   * ORDERING, and it is load-bearing: the field must be advanced (`advanceWake`)
   * INSIDE the sim tick, before buoyancy samples it. Left in the render block it
   * is aged on `frameDt`, and then the hull floats on a track from a different
   * instant than the one drawn — §V.2 and §V.8 in one defect.
   */
  setWakeField(wake: WakeElevationField | null): void {
    this.wake = wake;
  }

  /** per-cascade shoaling wavenumbers — see `shoalK` */
  private refreshShoal(): void {
    // §T.190: every band of the ADOPTED spectrum (same SpectrumData the GPU's
    // OceanCascade copies), not only the mirrored ones — see `shoalSigma`
    const bands = this.adopted.cascades;
    this.shoalK = bands.map((c) =>
      shoalWavenumber(c.meanWavenumber, this.openDepth, this.oceanP),
    );
    this.shoalSigma = bands.map((c) => Math.sqrt(Math.max(c.heightVariance, 0)));
    // §T.193: the same SpectrumData the GPU's uniforms read (moments cached per h0)
    const smith = this.smithDepth();
    this.asymBands = [];
    this.asymHead = [];
    for (let i = 0; i < SHOAL_ASYMMETRY_BANDS; i++) {
      this.asymBands.push({ kMean: bands[i].meanWavenumber, ...bandPropagation(bands[i].h0) });
      this.asymHead.push(Math.exp(-2 * bands[i].meanWavenumber * smith));
    }
  }

  /** per-cascade fetch coefficients — see `fetchC` */
  private refreshFetch(): void {
    const peakK = fullyDevelopedPeakWavenumber(this.oceanP.windSpeed);
    // §T.190: all adopted bands, so breaking sees the undrawn cascade's fetch
    // and shadow too (the mirrored ones are the same SpectrumData, same values)
    const bands = this.adopted.cascades;
    this.fetchC = bands.map((c) =>
      fetchBandCoefficient(peakK, c.meanWavenumber, this.oceanP),
    );
    this.swellShare = bands.map((c, i) =>
      swellBandShare(this.oceanP, i, c.heightVariance),
    );
  }

  /**
   * Per-cascade fetch gain at a GRID coord, into the shared scratch.
   *
   * ONE ratio for all bands — it is a property of the place, not of the band —
   * and one bilinear field sample per call, which is why the shelter field is
   * baked rather than marched (see fetchField.ts). All 1 with no field wired,
   * so every path below is bit-identical to what it was before fetch existed.
   *
   * §V.72's trap (a), inherited verbatim: the caller passes the GRID coord `q`
   * the inverse displacement solved for, never the query `x`. The GPU
   * fetch-limits the vertex it is DISPLACING, so reading the field at `x`
   * would put the two seas metres apart horizontally near shore.
   */
  private bandGains(qx: number, qz: number): number[] {
    const g = this.gains;
    const n = this.adopted.cascades.length;
    if (!this.fetch) {
      for (let i = 0; i < n; i++) g[i] = 1;
      return g;
    }
    const ratio = developmentRatio(
      this.fetch.fetchAt(qx, qz),
      this.oceanP.windSpeed,
      this.oceanP,
    );
    // T174: the swell shadow rides on the same grid-coord sample (§V.72a) and
    // the same product as the vertex shader's `shoal[i]`. A bare FetchSource
    // (tests) has no shadow ⟹ K = 1 ⟹ gain exactly 1.
    const k = this.fetch.shadowAt ? this.fetch.shadowAt(qx, qz) : 1;
    for (let i = 0; i < n; i++) {
      g[i] =
        fetchBandGain(this.fetchC[i], ratio, this.oceanP) *
        swellShadowGain(this.swellShare[i], k);
    }
    return g;
  }

  /**
   * §T.190 THE ONE PER-BAND GAIN at a GRID coord: fetch × shadow (above), then
   * shoaling growth and depth-limited breaking through `shoalBandGains` — the
   * same function the vertex shader's TSL twin is, over ALL adopted bands.
   * No bed ⟹ the external gains untouched (bit-identical to pre-shoaling).
   * `depth` is the caller's `depthAt(q)`, so it is read once per lookup.
   */
  private shoaledGains(qx: number, qz: number, depth: number): number[] {
    const ext = this.bandGains(qx, qz);
    if (!this.seabed) return ext;
    return shoalBandGains(depth, this.shoalK, this.shoalSigma, ext, this.oceanP, this.shoalGains);
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
    /**
     * §V.8 LOCKSTEP. The mirror adopts a new spectrum on the tick the shared
     * scheduler publishes one, which is the same tick — and, in main.ts, the
     * same statement — the GPU installs it into its h0 textures. There is no
     * countdown here any more and that is the point: the old code kept a
     * SECOND arm-at-15 countdown over a SECOND copy of the signature key list,
     * and the two agreed only because someone had matched them by hand. An
     * amortised rebuild would have broken that agreement immediately (the GPU
     * swap moves 26 ticks later; a hand-matched countdown does not), and the
     * failure mode is silent: the ship floats correctly on a sea that is drawn
     * differently (§B.34, four user reports in one day).
     *
     * When this mirror owns its scheduler (no GPU sim above it) it steps it
     * here, on the same once-per-tick cadence `OceanSimulation.advanceSpectrum`
     * uses, so the two configurations produce the same schedule.
     */
    if (this.ownsScheduler) this.scheduler.advance(this.oceanP);
    const sig = mirrorSignature(this.seaP);
    const resized = sig !== this.signature;
    if (resized) {
      this.signature = sig;
    }
    if (resized || this.scheduler.current !== this.adopted) {
      this.adopted = this.scheduler.current;
      this.buildCascades();
      this.gridTime = NaN; // force recompute below
    }
    // §V.72: cheap (one max + one divide per cascade) and it has to run every
    // tick, not only on rebuild — the shoaling params are NOT spectrum params,
    // so `mirrorSignature` deliberately does not see them and a value cached
    // on the rebuild path would ignore a live tweak (§V.62). The GPU refreshes
    // the same numbers in `updateFromParams`, from the same function.
    this.refreshShoal();
    // §V.73, same argument one file over: the fetch coefficients are BOTH
    // spectrum-derived (each band's mean k) and wind-derived, and windSpeed
    // reaches the mirror through the rate-limited rebuild — so a value cached
    // on the rebuild path alone would lag the wind by up to 15 ticks while the
    // material's own refresh moved immediately (§V.62, §V.8).
    this.refreshFetch();
    const staleFor = Math.abs(time - this.gridTime);
    if (staleFor < this.seaP.updateEveryTicks * SIM_DT - 1e-9) return;
    const lambda = this.effectiveChoppiness();
    const depth = this.smithDepth();
    for (const c of this.cascades) {
      c.compute(time, lambda, depth);
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
      // §V.73: the fixed point gains a second factor and the argument is
      // unchanged — the vertex shader scales the WHOLE displacement, horizontal
      // included, by shoal·fetch, so the mirror must solve for the same point
      // or the two sides are inverting different equations.
      // §T.190: growth and breaking ride the same product, horizontal included
      const gain = this.shoaledGains(qx, qz, this.depthAt(qx, qz));
      for (let i = 0; i < this.cascades.length; i++) {
        const c = this.cascades[i];
        const g = gain[i];
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
   * Σ over cascades of a grid, each band scaled by its own shoaling gain
   * (growth × fetch × shadow × breaking, §T.190), then column-guarded (§V.72). ONE place, because `heightAt` and
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
    if (!this.seabed && !this.fetch) {
      let sum = 0;
      for (const c of this.cascades) sum += c.sample(grid(c), qx, qz);
      return sum;
    }
    const depth = this.depthAt(qx, qz);
    const gain = this.shoaledGains(qx, qz, depth);
    let sum = 0;
    for (let i = 0; i < this.cascades.length; i++) {
      const c = this.cascades[i];
      sum += c.sample(grid(c), qx, qz) * gain[i];
    }
    // §T.193 the shoaling second harmonic, before the column guard as on the
    // GPU. The pressure head takes each band's harmonic at its own Smith
    // depth, e^(−2k̄T) (it is a wave of twice the band's wavenumber).
    if (this.seabed) {
      const dy = this.asymmetryAt(qx, qz, depth, gain);
      if (dy !== null) {
        const head = grid(this.cascades[0]) === this.cascades[0].head;
        for (let i = 0; i < SHOAL_ASYMMETRY_BANDS; i++) sum += dy[i] * (head ? this.asymHead[i] : 1);
      }
    }
    // §V.73 is a SPECTRUM statement and term B is a WATER COLUMN statement, so
    // the clip still keys on the bed alone. With no bed there is no column to
    // limit against and `depthAt` reports 0 — clipping to that would flatten a
    // fetch-only scene to nothing.
    return this.seabed ? breakerClip(sum, depth, this.oceanP) : sum;
  }

  /**
   * §T.193 each mirrored band's shoaling second harmonic (m) at GRID coord q,
   * from src/ocean/shoalAsymmetry.ts, the functions the vertex shader's twin
   * is. `gain` is the all-band `shoaledGains` at q. Null where every band is
   * deep (the gate is exactly 0), so open water samples nothing extra and sums
   * bit-identically.
   */
  private asymmetryAt(qx: number, qz: number, depth: number, gain: readonly number[]): number[] | null {
    if (!shoalAsymmetryCoefficients(
      depth, this.shoalK, this.asymBands, this.shoalSigma, gain, this.oceanP,
      this.asymSkew, this.asymTilt, this.asymRatio,
    )) return null;
    for (let i = 0; i < SHOAL_ASYMMETRY_BANDS; i++) {
      const c = this.cascades[i];
      const b = this.asymBands[i];
      this.asymEta[i] = c.sample(c.height, qx, qz) * gain[i];
      this.asymProj[i] = (c.sample(c.dx, qx, qz) * b.x + c.sample(c.dz, qx, qz) * b.z) * gain[i];
    }
    shoalAsymmetrySample(
      this.asymEta, this.asymProj, this.asymBands, this.asymSkew, this.asymTilt, this.asymRatio,
      this.effectiveChoppiness(), this.asymDy,
    );
    return this.asymDy;
  }

  private readonly q: [number, number] = [0, 0];

  /**
   * The wake's contribution at the GRID coord `gridCoord` just solved for, NOT
   * at the query point — §V.72(a), and the reason is the same one the shoaling
   * depth is read there. `surfaceMaterial.positionNode` adds
   * `wakeHeightNode(worldXZ)` at the UNDISPLACED grid position and then lets the
   * cascades carry that vertex sideways; reading the wake at the post-
   * displacement point instead would put the drawn sea and the floated sea 1–2 m
   * apart horizontally, which is §B.34 arriving by a third route.
   *
   * OUTSIDE `shoaledSum` on purpose: the GPU adds the wake AFTER `totalDisp`,
   * so it is neither shoaled, nor fetch-limited, nor breaker-clipped. A wake is
   * a hull's own disturbance of the local surface, not a component of the wind
   * spectrum, and every one of those three modifiers is a spectrum statement.
   */
  private wakeAt(smithDepth: number): number {
    return this.wake ? this.wake.wakeHeightCpu(this.q[0], this.q[1], smithDepth) : 0;
  }

  /** Water height at world (x,z) — the surface as drawn (§V.8). */
  heightAt(x: number, z: number, time: number): number {
    if (time !== this.time || Number.isNaN(this.gridTime)) this.update(time);
    this.gridCoord(x, z, this.q);
    // FULL amplitude: this is the geometric question, and the geometry the GPU
    // drew carries the whole wake (§V.8, `d9e8e22`)
    return this.shoaledSum((c) => c.height, this.q[0], this.q[1]) + this.wakeAt(0);
  }

  /** Smith-attenuated equivalent elevation at world (x,z) — see the field. */
  pressureHeadAt(x: number, z: number, time: number): number {
    if (time !== this.time || Number.isNaN(this.gridTime)) this.update(time);
    this.gridCoord(x, z, this.q);
    // §V.68: the FORCE integrates pressure, so the wake is attenuated by
    // e^(−k·T) at each term's own wavenumber, exactly as every FFT mode above
    // already is. Same `smithDepth()` — one draft, one sea.
    return (
      this.shoaledSum((c) => c.head, this.q[0], this.q[1]) + this.wakeAt(this.smithDepth())
    );
  }
}
