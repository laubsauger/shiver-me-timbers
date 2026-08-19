/**
 * SCRATCH MEASUREMENT — the four ranked research items, measured before they
 * are built. NOT AN INVARIANT TEST. `FOAM_RESEARCH=1 npx vitest run
 * tests/zzScratchFoamResearch.test.ts`.
 *
 * Items (docs/research-poseidon.md §3.3/§4, docs/research-water-implementations
 * .md §2.2/§3.3/§4):
 *   1. phase-lead injection   — sample the gate cτ upwave, write it here
 *   2. windward-face gate     — a second injector on the leading flank
 *   3. peak-hold onset        — max() instead of += on the breaking channel
 *   4. foam's own normal      — shading, measured separately (see the report)
 *
 * WHAT IT REPORTS, per config, and why each one:
 *   coverage      mean(foamAmount) through the REAL shading chain (art texture,
 *                 dissolve, body, cap variation, soft saturation). The pinned
 *                 invariant. Absolute differs from the browser's 0.62% — one
 *                 fixed framing, a 128² sim mirror, no wake and no haze damp —
 *                 so only the DELTA between configs here is meaningful.
 *   crest30/10    share of shaded foam mass in the top 30%/10% of the sea by
 *                 total elevation (the statistic foamMath's two-clock split
 *                 and cross-band bias were tuned on: 92.4% / 76.1%).
 *   fwdShare      share of shaded foam mass on the FORWARD flank of the wave
 *                 (−∇h·d̂ > 0) — 0.5 is symmetric, >0.5 is foam ahead of the
 *                 crest. This is the anticipation statistic, and nothing in
 *                 the repo measured it before.
 */
import { describe, expect, it } from 'vitest';
import {
  blurDecayAt,
  blurMixPerStep,
  breakingGain,
  breakupJitterAligned,
  breakupOctaves,
  crestBiasPerMetre,
  crestFrame,
  decayFactorPerFrame,
  dissolveKnee,
  eigenFoamGate,
  eigenInjectPerStep,
  eigenSigma,
  expectedBandFoam,
  foamBodyLevel,
  foamCoverage,
  foamTexelMetres,
  jacobianSigma,
  meanFoamAgeTicks,
  metricSigmaScale,
  minEigenvalue,
  tensorRadiusTexels,
  tierWeightAt,
  waveCarveOffset,
  whitecapWindScale,
  wrapIndex,
} from '../src/foam/foamMath';
import {
  FOAM_BREAKUP_CELLS,
  FOAM_CREST_MEAN,
  FOAM_SOFT_MEAN,
  buildFoamPattern,
} from '../src/foam/foamPattern';
import { foamParams } from '../src/params/foam';
import { oceanParams, type OceanParams } from '../src/params/ocean';
import {
  cascadeBand,
  effectiveChoppiness,
  generateButterfly,
  generateH0,
  spectralHeightVariance,
  spectralJacobianRms,
  spectralMeanWavenumber,
} from '../src/ocean/oceanMath';
import { cpuIFFT2D, extractCentralBlock } from '../src/sea-physics/cpuOcean';
import { fbm2Cpu, valueNoise2Cpu } from '../src/terrain/noiseCpu';
import { SIM_DT } from '../src/core/loop';

// this repo has no @types/node and a scratch harness must not add one — the
// other zzScratch* files simply leave the tsc error, this one declares it away
declare const process: { env: Record<string, string | undefined> };

const RUN = process.env.FOAM_RESEARCH === '1';
const maybe = RUN ? it : it.skip;

/** sim mirror grid per band. 128 keeps a 6-config sweep inside a few minutes */
const N = Number(process.env.FOAM_N ?? 128);
/** ticks to reach the residue's steady state (mean visible age is 77 ticks) */
const WARM = 420;
/** shaded samples after warm-up, spaced so the sea has moved between them */
const SAMPLES = 3;
const SAMPLE_TICKS = 30;
/** shaded patch: 512² over 60 m ⇒ 0.117 m/px, a deck-range framing */
const PATCH = 512;
const PATCH_METRES = 60;
const PIXEL_METRES = PATCH_METRES / PATCH;
/** art texture, exactly the one foamTexture.ts uploads */
const ART_N = 256;

export interface Config {
  name: string;
  /** item 1: seconds of phase lead. 0 = shipped */
  lead: number;
  /** item 2: residue the fully-facing flank settles at. 0 = shipped */
  windward: number;
  /** item 3: peak-hold the breaking channel instead of accumulating */
  peakHold: boolean;
  /** item 2: how many σ of forward slope counts as fully wind-facing */
  windSigma?: number;
  /** item 3: recalibration multiplier on the peak-hold scale */
  peakMul?: number;
}

/* ---------------------------------------------------------------- the sea */

class Band {
  readonly domain: number;
  readonly cell: number;
  readonly jacobianRms: number;
  readonly heightVariance: number;
  readonly meanK: number;
  readonly octaves: number;
  readonly tensorRadius: number;
  readonly h: Float32Array;
  readonly dx: Float32Array;
  readonly dz: Float32Array;
  readonly dhdx: Float32Array;
  readonly dhdz: Float32Array;
  readonly lam: Float32Array;
  private readonly h0: Float32Array;
  private readonly kxN: Float32Array;
  private readonly kzN: Float32Array;
  private readonly omega: Float32Array;
  private readonly a: { re: Float32Array; im: Float32Array };
  private readonly b: { re: Float32Array; im: Float32Array };
  private readonly butterfly: Float32Array;

  gate = 0;
  perStep = 0;
  breakupAmp = 0;
  blurMix = 1;
  slopeSigma = 0;
  /** phase-lead offset in TEXELS of this band's own grid (item 1) */
  leadX = 0;
  leadZ = 0;
  /** windward injection per tick at a fully-facing texel (item 2) */
  windPerStep = 0;
  windSigma = WINDWARD_SIGMA;
  readonly residue: Float32Array;
  readonly breaking: Float32Array;
  readonly sR: Float32Array;
  readonly sB: Float32Array;
  meanResidue = 0;
  meanBreaking = 0;

  constructor(readonly index: number, readonly n: number, p: OceanParams) {
    this.domain = p.cascades[index].domain;
    this.cell = this.domain / n;
    const band = cascadeBand(index, p.splitWavelengths);
    this.jacobianRms = spectralJacobianRms(p.resolution, this.domain, p, band);
    this.heightVariance = spectralHeightVariance(p.resolution, this.domain, p, band);
    this.meanK = spectralMeanWavenumber(p.resolution, this.domain, p, band);
    this.h0 = extractCentralBlock(
      generateH0(p.resolution, this.domain, 1337 + index * 7919, p, band), p.resolution, n,
    );
    const size = n * n;
    this.kxN = new Float32Array(size);
    this.kzN = new Float32Array(size);
    this.omega = new Float32Array(size);
    for (let m = 0; m < n; m++) {
      for (let q = 0; q < n; q++) {
        const kx = (2 * Math.PI * (q - n / 2)) / this.domain;
        const kz = (2 * Math.PI * (m - n / 2)) / this.domain;
        const k = Math.hypot(kx, kz);
        const safe = Math.max(k, 1e-6);
        const i = m * n + q;
        this.kxN[i] = kx / safe;
        this.kzN[i] = kz / safe;
        this.omega[i] = Math.sqrt(9.81 * k);
      }
    }
    this.a = { re: new Float32Array(size), im: new Float32Array(size) };
    this.b = { re: new Float32Array(size), im: new Float32Array(size) };
    this.h = new Float32Array(size);
    this.dx = new Float32Array(size);
    this.dz = new Float32Array(size);
    this.dhdx = new Float32Array(size);
    this.dhdz = new Float32Array(size);
    this.lam = new Float32Array(size);
    this.residue = new Float32Array(size);
    this.breaking = new Float32Array(size);
    this.sR = new Float32Array(size);
    this.sB = new Float32Array(size);
    this.butterfly = generateButterfly(n);
    const texel = foamTexelMetres(this.domain, p.resolution);
    this.octaves = breakupOctaves(foamParams.breakupMetres, texel);
    const kMax = band.kMax;
    this.tensorRadius = tensorRadiusTexels(
      Number.isFinite(kMax) ? (2 * Math.PI) / kMax : 0, texel,
    );
  }

  evolve(time: number, lambda: number): void {
    const n = this.n;
    const size = n * n;
    for (let i = 0; i < size; i++) {
      const phase = this.omega[i] * time;
      const c = Math.cos(phase);
      const s = Math.sin(phase);
      const r0 = this.h0[i * 4];
      const i0 = this.h0[i * 4 + 1];
      const r1 = this.h0[i * 4 + 2];
      const i1 = this.h0[i * 4 + 3];
      const hRe = (r0 + r1) * c - (i0 + i1) * s;
      const hIm = (r0 - r1) * s + (i0 - i1) * c;
      this.a.re[i] = hRe * (1 - this.kxN[i]);
      this.a.im[i] = hIm * (1 - this.kxN[i]);
      this.b.re[i] = -hIm * this.kzN[i];
      this.b.im[i] = hRe * this.kzN[i];
    }
    cpuIFFT2D(this.a, this.butterfly, n);
    cpuIFFT2D(this.b, this.butterfly, n);
    for (let m = 0; m < n; m++) {
      for (let x = 0; x < n; x++) {
        const i = m * n + x;
        const sign = (x + m) & 1 ? -1 : 1;
        this.h[i] = sign * this.a.re[i];
        this.dx[i] = sign * this.a.im[i] * lambda;
        this.dz[i] = sign * this.b.re[i] * lambda;
      }
    }
    const hs = this.cell;
    for (let m = 0; m < n; m++) {
      for (let q = 0; q < n; q++) {
        const i = m * n + q;
        const xp = m * n + wrapIndex(q + 1, n);
        const xm = m * n + wrapIndex(q - 1, n);
        const zp = wrapIndex(m + 1, n) * n + q;
        const zm = wrapIndex(m - 1, n) * n + q;
        this.dhdx[i] = (this.h[xp] - this.h[xm]) / (2 * hs);
        this.dhdz[i] = (this.h[zp] - this.h[zm]) / (2 * hs);
        const ax = (this.dx[xp] - this.dx[xm]) / (2 * hs);
        const bz = (this.dz[zp] - this.dz[zm]) / (2 * hs);
        const az = (this.dx[zp] - this.dx[zm]) / (2 * hs);
        this.lam[i] = minEigenvalue(2 + ax + bz, (1 + ax) * (1 + bz) - az * az);
      }
    }
  }

  sample(grid: Float32Array, x: number, z: number): number {
    const n = this.n;
    const u = ((((x / this.domain) % 1) + 1) % 1) * n;
    const v = ((((z / this.domain) % 1) + 1) % 1) * n;
    const i0 = Math.floor(u);
    const j0 = Math.floor(v);
    const fu = u - i0;
    const fv = v - j0;
    const ia = wrapIndex(i0, n);
    const ib = wrapIndex(i0 + 1, n);
    const ja = wrapIndex(j0, n);
    const jb = wrapIndex(j0 + 1, n);
    return (grid[ja * n + ia] * (1 - fu) + grid[ja * n + ib] * fu) * (1 - fv)
      + (grid[jb * n + ia] * (1 - fu) + grid[jb * n + ib] * fu) * fv;
  }

  /**
   * Inject pass. `outF` = fold injection (both channels), `outW` = windward
   * injection (residue only).
   *
   * ITEM 1 is a pure TRANSLATION: every term of the gate is read at the lead
   * texel and the foam is written here, so the fired field is the shipped one
   * shifted downwave and its distribution — hence coverage — is untouched.
   */
  inject(
    others: Band[], crestBias: number, drift: number, cfg: Config,
    outF: Float32Array, outW: Float32Array, dirX: number, dirZ: number,
  ): void {
    const n = this.n;
    const r = this.tensorRadius;
    const lx = cfg.lead !== 0 ? this.leadX : 0;
    const lz = cfg.lead !== 0 ? this.leadZ : 0;
    for (let m = 0; m < n; m++) {
      for (let q = 0; q < n; q++) {
        const i = m * n + q;
        // the gate is evaluated at the LEAD texel; the foam lands at `i`
        const gq = wrapIndex(q + lx, n);
        const gm = wrapIndex(m + lz, n);
        const gi = gm * n + gq;
        let metric = this.lam[gi];
        const wx = (gq + 0.5) * this.cell;
        const wz = (gm + 0.5) * this.cell;
        if (crestBias !== 0) {
          let hOther = 0;
          for (const o of others) if (o.index !== this.index) hOther += o.sample(o.h, wx, wz);
          metric -= crestBias * hOther;
        }
        if (this.octaves > 0) {
          let jxx = 0;
          let jzz = 0;
          let jxz = 0;
          for (let t = 0; t < 8; t++) {
            const ang = (t / 8) * Math.PI * 2;
            const ti = wrapIndex(gm + Math.round(Math.sin(ang) * r), n) * n
              + wrapIndex(gq + Math.round(Math.cos(ang) * r), n);
            jxx += this.dhdx[ti] * this.dhdx[ti];
            jzz += this.dhdz[ti] * this.dhdz[ti];
            jxz += this.dhdx[ti] * this.dhdz[ti];
          }
          metric += this.breakupAmp * breakupJitterAligned(
            wx, wz, crestFrame(jxx, jzz, jxz), foamParams.breakupElongation,
            1 / Math.max(0.5, foamParams.breakupMetres),
            foamParams.breakupWarp, this.octaves, drift,
          );
        }
        outF[i] = Math.max(0, this.gate - metric) * this.perStep;
        if (this.windPerStep > 0 && this.slopeSigma > 0) {
          // leading face: outward normal xz = (−∂h/∂x, −∂h/∂z); its dot with
          // the propagation direction is positive on the face the crest
          // reaches first. σ-relative, like every other gate here.
          const forward = -(this.dhdx[gi] * dirX + this.dhdz[gi] * dirZ);
          const f = Math.min(1, Math.max(0, forward / (this.windSigma * this.slopeSigma)));
          outW[i] = f * this.windPerStep;
        } else {
          outW[i] = 0;
        }
      }
    }
  }

  accumulate(injF: Float32Array, injW: Float32Array, decay: number, bDecay: number,
    peakHold: boolean, peakScale: number): void {
    const n = this.n;
    const size = n * n;
    const cap = Math.max(1, foamParams.foamAccumMax);
    for (let i = 0; i < size; i++) {
      this.sR[i] = Math.min(cap, this.residue[i] + injF[i] + injW[i]);
      this.sB[i] = peakHold
        ? Math.min(cap, Math.max(injF[i] * peakScale, this.breaking[i]))
        : Math.min(cap, this.breaking[i] + injF[i]);
    }
    for (let m = 0; m < n; m++) {
      for (let q = 0; q < n; q++) {
        this.residue[m * n + q] = blurDecayAt(
          this.sR, n, q, m, foamParams.blurRadius, decay, this.blurMix,
        );
        this.breaking[m * n + q] = blurDecayAt(
          this.sB, n, q, m, foamParams.blurRadius, bDecay, this.blurMix,
        );
      }
    }
  }
}

/**
 * How many σ of forward slope counts as a "fully wind-facing pixel". 2σ is the
 * same multiple the fold gate itself sits at, so the windward term fires on
 * roughly the steepest 2% of forward flank rather than on the whole flank.
 */
const WINDWARD_SIGMA = 2;

interface Sea {
  lambda: number;
  crestBias: number;
  decay: number;
  bDecay: number;
  gain: number;
  heightRms: number;
  dirX: number;
  dirZ: number;
}

function configure(bands: Band[], p: OceanParams, cfg: Config): Sea {
  const jacobianRms = Math.sqrt(bands.reduce((a, b) => a + b.jacobianRms ** 2, 0));
  const heightRms = Math.sqrt(bands.reduce((a, b) => a + b.heightVariance, 0));
  const lambda = effectiveChoppiness(p.choppiness, jacobianRms, p.choppinessFoldLimit);
  const seaSigma = jacobianSigma(jacobianRms, lambda);
  const windScale = whitecapWindScale(p.windSpeed, foamParams.whitecapWindRef);
  const decay = decayFactorPerFrame(foamParams.decayHalfLife, SIM_DT);
  const bDecay = Math.min(decay, decayFactorPerFrame(foamParams.breakingHalfLife, SIM_DT));
  const ageTicks = meanFoamAgeTicks(decay);
  const dirX = Math.cos(p.windDirection);
  const dirZ = Math.sin(p.windDirection);
  for (const b of bands) {
    const bandSigma = jacobianSigma(b.jacobianRms, lambda);
    const ss = metricSigmaScale(foamParams.crestBiasSigma, foamParams.breakupSigma, b.octaves);
    b.gate = eigenFoamGate(p.jacobianFoamBias, b.jacobianRms, lambda, bandSigma, seaSigma, ss);
    b.perStep = eigenInjectPerStep(
      foamParams.injectStrength * windScale, SIM_DT,
      b.jacobianRms, lambda, bandSigma, seaSigma, ss,
    );
    b.breakupAmp = foamParams.breakupSigma * eigenSigma(b.jacobianRms, lambda);
    b.blurMix = blurMixPerStep(
      foamParams.blurSpreadMetres, foamTexelMetres(b.domain, p.resolution),
      foamParams.blurRadius, ageTicks,
    );
    // slope σ along ONE axis, from the band's own |k| moment (isotropic split)
    b.slopeSigma = b.jacobianRms / Math.SQRT2;
    // ITEM 1: c = sqrt(g/k̄), the band's own energy-weighted phase speed.
    // f(x,t+τ) = f(x − cτ d̂, t), so the gate is read cτ UPWAVE.
    const c = b.meanK > 0 ? Math.sqrt(9.81 / b.meanK) : 0;
    const texels = (c * cfg.lead) / b.cell;
    b.leadX = -Math.round(texels * dirX);
    b.leadZ = -Math.round(texels * dirZ);
    // ITEM 2: equilibrium semantics — a fully-facing texel settles at
    // `windward` on the residue's own scale, so the rate is that × (1−d)/d.
    b.windPerStep = cfg.windward > 0 && decay > 0 && decay < 1
      ? (cfg.windward * (1 - decay)) / decay : 0;
    b.windSigma = cfg.windSigma ?? WINDWARD_SIGMA;
    b.meanResidue = expectedBandFoam(
      b.gate, b.perStep, b.jacobianRms, lambda, decay, foamParams.foamAccumMax,
    );
    b.meanBreaking = expectedBandFoam(
      b.gate, b.perStep, b.jacobianRms, lambda, bDecay, foamParams.foamAccumMax,
    );
  }
  return {
    lambda,
    crestBias: crestBiasPerMetre(foamParams.crestBiasSigma, jacobianRms, lambda, heightRms),
    decay,
    bDecay,
    gain: breakingGain(decay, bDecay),
    heightRms,
    dirX,
    dirZ,
  };
}

/* ------------------------------------------------------------ the shading */

/** bilinear tap of the art texture, RepeatWrapping, channel c of 4 */
function art(data: Uint8Array, u: number, v: number, c: number): number {
  const n = ART_N;
  const x = ((((u % 1) + 1) % 1) * n) - 0.5;
  const y = ((((v % 1) + 1) % 1) * n) - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const xa = wrapIndex(x0, n);
  const xb = wrapIndex(x0 + 1, n);
  const ya = wrapIndex(y0, n);
  const yb = wrapIndex(y0 + 1, n);
  const g = (px: number, py: number): number => data[(py * n + px) * 4 + c] / 255;
  return (g(xa, ya) * (1 - fx) + g(xb, ya) * fx) * (1 - fy)
    + (g(xa, yb) * (1 - fx) + g(xb, yb) * fx) * fy;
}

interface Shaded {
  /** mean(foamAmount) — the pinned coverage */
  coverage: number;
  crest30: number;
  crest10: number;
  fwdShare: number;
}

/**
 * CPU mirror of index.shadingNode → foamShading.foamDetailMask, at one fixed
 * framing. Every term that multiplies the foam ALPHA is here, because the mean
 * of that product IS coverage; the purely tonal terms (tint, light) are not.
 */
function shade(bands: Band[], sea: Sea, artData: Uint8Array, time: number,
  originX: number, originZ: number): Shaded {
  const rw = foamParams.residueWeight;
  const bw = foamParams.breakingWeight;
  const density = foamParams.foamDensity;
  const scroll = foamParams.detailScrollSpeed;
  const crestMetres = foamParams.artCrestMetres;
  const softMetres = foamParams.artSoftMetres;
  const erode = foamParams.erodeDepth;
  const kneeLow = foamParams.residueKneeLow;
  const kneeHigh = Math.max(kneeLow + 1e-4, foamParams.residueKneeHigh);
  // tier weights are constant for a fixed framing
  const wFine = bands.map((b) => tierWeightAt(
    PIXEL_METRES, foamTexelMetres(b.domain, oceanParams.resolution),
    foamParams.tierKeepPixels, foamParams.tierFadeSpan,
  ));
  const wCoarse = bands.map((b, i) => (i < bands.length - 1
    ? tierWeightAt(
      PIXEL_METRES, foamTexelMetres(b.domain, oceanParams.resolution / 4),
      foamParams.tierKeepPixels, foamParams.tierFadeSpan,
    )
    : 0));
  // the dissolve's resolved factor and the detail backstop, both constant here
  const cellFor = (fresh: number): number =>
    (softMetres + (crestMetres - softMetres) * fresh) / FOAM_BREAKUP_CELLS;
  const featureMetres = softMetres / 3; // FOAM_SOFT_CELLS
  const keepMetres = featureMetres / Math.max(0.5, foamParams.detailKeepPixels);
  const detailFade = smooth(keepMetres * Math.max(1.05, foamParams.detailFadeSpan),
    keepMetres, PIXEL_METRES);

  let mass = 0;
  let massTop30 = 0;
  let massTop10 = 0;
  let massFwd = 0;
  const alphas = new Float64Array(PATCH * PATCH);
  const elevs = new Float64Array(PATCH * PATCH);
  const fwds = new Float64Array(PATCH * PATCH);

  for (let py = 0; py < PATCH; py++) {
    for (let px = 0; px < PATCH; px++) {
      const wx = originX + (px + 0.5) * PIXEL_METRES;
      const wz = originZ + (py + 0.5) * PIXEL_METRES;
      // foamWarpVec on the sim lookup
      const wd = time * scroll * 0.5;
      const warpX = (fbm2Cpu(wx * foamParams.uvWarpScale + wd, wz * foamParams.uvWarpScale, 2)
        - 0.5) * foamParams.uvWarpMeters;
      const warpZ = (fbm2Cpu(wx * foamParams.uvWarpScale + 17.3,
        wz * foamParams.uvWarpScale + 9.1 - wd, 2) - 0.5) * foamParams.uvWarpMeters;
      const sx = wx + warpX;
      const sz = wz + warpZ;
      let raw = 0;
      let breaking = 0;
      let elev = 0;
      let fwd = 0;
      for (let li = 0; li < bands.length; li++) {
        const b = bands[li];
        const r = lerp(b.meanResidue, b.sample(b.residue, sx, sz), wFine[li]);
        const g = lerp(b.meanBreaking, b.sample(b.breaking, sx, sz), wFine[li]);
        // (the 4× tier is the same field box-reduced; at this framing wCoarse
        // only matters where wFine has already retired, and it reads the same
        // accumulator, so sampling `front` twice is the honest approximation)
        void wCoarse;
        raw += r;
        breaking += g;
        elev += b.sample(b.h, wx, wz);
        fwd += -(b.sample(b.dhdx, wx, wz) * sea.dirX + b.sample(b.dhdz, wx, wz) * sea.dirZ);
      }
      breaking = breaking * sea.gain * bw;
      raw = raw * rw + breaking;
      const share = Math.min(1, Math.max(0, breaking / Math.max(1e-4, raw)));
      // capVariationNode
      const cvDrift = time * 0.013;
      const cv = fbm2Cpu(wx * foamParams.capVariationScale + cvDrift,
        wz * foamParams.capVariationScale - cvDrift * 0.6, 4);
      raw *= Math.max(0, (1 - foamParams.capVariationStrength)
        + ((1 + foamParams.capVariationStrength * 0.25) - (1 - foamParams.capVariationStrength))
          * cv);
      const covered = Math.min(1, Math.max(0, foamCoverage(raw, density)));

      // ---- foamDetailMask -------------------------------------------------
      const phase = valueNoise2Cpu(wx * 0.021, wz * 0.021) * 37;
      const t = (time + phase) * scroll;
      const churnX = warpX * 0.6;
      const churnZ = warpZ * 0.6;
      // crestAnisoCoord at elongation 1 is the identity — shipped value
      const ax = wx + churnX;
      const az = wz + churnZ;
      const lift = Math.min(2, Math.max(-2, elev / Math.max(1e-6, sea.heightRms)));
      const carve = waveCarveOffset(lift, foamParams.tipCarve);
      const crestU = ax / crestMetres + t + carve;
      const crestV = az / crestMetres - t * 0.7 + carve * -0.6;
      const softU = ax / softMetres - t * 0.4 + carve * (crestMetres / softMetres);
      const softV = az / softMetres + t * 0.3 + carve * -0.6 * (crestMetres / softMetres);
      const crestR = art(artData, crestU, crestV, 0);
      const crestB = art(artData, crestU, crestV, 2);
      const softG = art(artData, softU, softV, 1);
      const softB = art(artData, softU, softV, 2);
      const sheetN = smooth(foamParams.sheetKnee, 1, covered);
      const freshness = smooth(0.25, 0.8, share);
      const tear = (softB - 0.5) * foamParams.handoverTear;
      const bodyFresh = smooth(0.25, 0.8, share + tear);
      const broadenMix = 1 - Math.min(1, Math.max(0.05, foamParams.sheetBroaden));
      const bodyBlend = Math.min(1, Math.max(0, bodyFresh * (1 - sheetN * broadenMix)));
      const flat = Math.min(1, Math.max(0, sheetN * foamParams.sheetFlatten));
      const body = foamBodyLevel(softG, crestR, freshness, bodyBlend, flat,
        foamParams.sheetKeep, FOAM_CREST_MEAN, FOAM_SOFT_MEAN);
      const detail = 1 + (body - 1) * detailFade;
      const breakup = softB + (crestB - softB) * freshness;
      const cellMetres = cellFor(freshness);
      const resolved = smooth(cellMetres, cellMetres * 0.5, PIXEL_METRES);
      const knee = dissolveKnee(covered, breakup, kneeLow, kneeHigh, erode, resolved, 0);
      const alpha = Math.min(1, Math.max(0, covered * detail * knee)) * 0.9;
      const idx = py * PATCH + px;
      alphas[idx] = alpha;
      elevs[idx] = elev;
      fwds[idx] = fwd;
      mass += alpha;
      if (fwd > 0) massFwd += alpha;
    }
  }
  // elevation deciles over this patch
  const sorted = Float64Array.from(elevs).sort();
  const p70 = sorted[Math.floor(sorted.length * 0.7)];
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  for (let i = 0; i < alphas.length; i++) {
    if (elevs[i] >= p70) massTop30 += alphas[i];
    if (elevs[i] >= p90) massTop10 += alphas[i];
  }
  const total = PATCH * PATCH;
  return {
    coverage: mass / total,
    crest30: mass > 0 ? massTop30 / mass : 0,
    crest10: mass > 0 ? massTop10 / mass : 0,
    fwdShare: mass > 0 ? massFwd / mass : 0,
  };
}

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
function smooth(e0: number, e1: number, x: number): number {
  const d = e1 - e0;
  if (d === 0) return x < e0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - e0) / d));
  return t * t * (3 - 2 * t);
}

function run(cfg: Config, artData: Uint8Array): Shaded & { peakScale: number } {
  const p = oceanParams;
  const bands = [0, 1, 2].map((i) => new Band(i, N, p));
  const sea = configure(bands, p, cfg);
  // ITEM 3: put the peak-hold channel on the accumulator's own scale, so the
  // TYPICAL firing texel arrives at the same breaking value it does today —
  // otherwise the comparison is a brightness change wearing an onset change's
  // clothes. Derived per run from the shipped build's mean breaking value.
  const peakScale = cfg.peakHold ? peakHoldScale(bands, sea) * (cfg.peakMul ?? 1) : 1;
  const injF = bands.map((b) => new Float32Array(b.n * b.n));
  const injW = bands.map((b) => new Float32Array(b.n * b.n));
  const out: Shaded[] = [];
  for (let s = 0; s < WARM + SAMPLES * SAMPLE_TICKS; s++) {
    const t = s * SIM_DT;
    for (const b of bands) b.evolve(t, sea.lambda);
    for (const b of bands) {
      b.inject(bands, sea.crestBias, t * 0.013, cfg, injF[b.index], injW[b.index],
        sea.dirX, sea.dirZ);
      b.accumulate(injF[b.index], injW[b.index], sea.decay, sea.bDecay,
        cfg.peakHold, peakScale);
    }
    if (s >= WARM && (s - WARM) % SAMPLE_TICKS === 0) {
      const k = (s - WARM) / SAMPLE_TICKS;
      out.push(shade(bands, sea, artData, t, k * 137.7, k * 91.3));
    }
  }
  const mean = (f: (x: Shaded) => number): number =>
    out.reduce((a, x) => a + f(x), 0) / out.length;
  return {
    coverage: mean((x) => x.coverage),
    crest30: mean((x) => x.crest30),
    crest10: mean((x) => x.crest10),
    fwdShare: mean((x) => x.fwdShare),
    peakScale,
  };
}

/**
 * Scale that makes a peak-hold breaking channel settle where the accumulating
 * one does, for the MEAN firing texel. The accumulator's steady state under a
 * constant per-tick injection I is I·b/(1−b); a peak-hold's is I·k. So
 * k = b/(1−b) — the same number for every band, which is why it is one scalar.
 */
function peakHoldScale(_bands: Band[], sea: Sea): number {
  return sea.bDecay / (1 - sea.bDecay);
}

describe('SCRATCH: the four research items, measured', () => {
  maybe('coverage / crest share / forward share per config', () => {
    /* eslint-disable no-console */
    const artData = buildFoamPattern(ART_N);
    const ALL: Config[] = [
      { name: 'shipped', lead: 0, windward: 0, peakHold: false },
      { name: 'lead 0.15s', lead: 0.15, windward: 0, peakHold: false },
      { name: 'lead 0.2s', lead: 0.2, windward: 0, peakHold: false },
      { name: 'lead 0.3s', lead: 0.3, windward: 0, peakHold: false },
      { name: 'lead 0.5s', lead: 0.5, windward: 0, peakHold: false },
      { name: 'lead 1.0s', lead: 1.0, windward: 0, peakHold: false },
      { name: 'windward .05', lead: 0, windward: 0.05, peakHold: false },
      { name: 'windward .20', lead: 0, windward: 0.20, peakHold: false },
      { name: 'windward .20 s3', lead: 0, windward: 0.20, peakHold: false, windSigma: 3 },
      { name: 'windward .20 s1', lead: 0, windward: 0.20, peakHold: false, windSigma: 1 },
      { name: 'peak-hold', lead: 0, windward: 0, peakHold: true },
      { name: 'peak-hold x.55', lead: 0, windward: 0, peakHold: true, peakMul: 0.55 },
      { name: 'peak-hold x.35', lead: 0, windward: 0, peakHold: true, peakMul: 0.35 },
      { name: 'lead+relief ctl', lead: 0.2, windward: 0, peakHold: false },
    ];
    const want = (process.env.FOAM_CFG ?? '').split(',').filter(Boolean);
    const configs = want.length
      ? ALL.filter((c) => want.includes(c.name) || c.name === 'shipped')
      : ALL.filter((c) => !c.name.includes('ctl'));
    console.log(`\n=== N=${N} sim, ${PATCH}² px at ${PIXEL_METRES.toFixed(3)} m/px, `
      + `${SAMPLES} samples after ${WARM} ticks ===`);
    console.log('config          coverage%   Δ%      crest30  crest10  fwdShare');
    let base = 0;
    for (const cfg of configs) {
      const r = run(cfg, artData);
      if (cfg.name === 'shipped') base = r.coverage;
      const d = base > 0 ? (100 * (r.coverage - base)) / base : 0;
      console.log(
        `${cfg.name.padEnd(15)} ${(100 * r.coverage).toFixed(4).padEnd(11)} `
        + `${d >= 0 ? '+' : ''}${d.toFixed(2).padEnd(7)} `
        + `${(100 * r.crest30).toFixed(1).padEnd(8)} ${(100 * r.crest10).toFixed(1).padEnd(8)} `
        + `${(100 * r.fwdShare).toFixed(2)}`,
      );
    }
    expect(true).toBe(true);
    /* eslint-enable no-console */
  }, 7200_000);
});
