/**
 * SCRATCH MEASUREMENT 2 — resolution convergence + fine time series.
 * See zzScratchFoamSynchrony.test.ts for the question being asked.
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
  eigenFoamGate,
  eigenInjectPerStep,
  eigenSigma,
  foamCoverage,
  foamMaskFrom,
  foamTexelMetres,
  jacobianSigma,
  meanFoamAgeTicks,
  metricSigmaScale,
  minEigenvalue,
  tensorRadiusTexels,
  whitecapWindScale,
  wrapIndex,
} from '../src/foam/foamMath';
import { foamParams } from '../src/params/foam';
import { oceanParams, type OceanParams } from '../src/params/ocean';
import {
  cascadeBand,
  effectiveChoppiness,
  generateButterfly,
  generateH0,
  spectralHeightVariance,
  spectralJacobianRms,
} from '../src/ocean/oceanMath';
import { cpuIFFT2D, extractCentralBlock } from '../src/sea-physics/cpuOcean';
import { SIM_DT } from '../src/core/loop';

const RUN = process.env.FOAM_SYNC === '1';
const maybe = RUN ? it : it.skip;

class Band {
  readonly domain: number;
  readonly cell: number;
  readonly jacobianRms: number;
  readonly heightVariance: number;
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
  readonly residue: Float32Array;
  readonly breaking: Float32Array;
  readonly sR: Float32Array;
  readonly sB: Float32Array;

  constructor(readonly index: number, readonly n: number, p: OceanParams) {
    this.domain = p.cascades[index].domain;
    this.cell = this.domain / n;
    const band = cascadeBand(index, p.splitWavelengths);
    this.jacobianRms = spectralJacobianRms(p.resolution, this.domain, p, band);
    this.heightVariance = spectralHeightVariance(p.resolution, this.domain, p, band);
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
    const u = (((x / this.domain) % 1) + 1) % 1 * n;
    const v = (((z / this.domain) % 1) + 1) % 1 * n;
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

  /** inject pass into `out`; returns domain-mean injection */
  inject(
    others: Band[], crestBias: number, drift: number, out: Float32Array, breakup = true,
  ): number {
    const n = this.n;
    const r = this.tensorRadius;
    let sum = 0;
    for (let m = 0; m < n; m++) {
      for (let q = 0; q < n; q++) {
        const i = m * n + q;
        let metric = this.lam[i];
        const wx = (q + 0.5) * this.cell;
        const wz = (m + 0.5) * this.cell;
        if (crestBias !== 0) {
          let hOther = 0;
          for (const o of others) if (o.index !== this.index) hOther += o.sample(o.h, wx, wz);
          metric -= crestBias * hOther;
        }
        if (breakup && this.octaves > 0) {
          let jxx = 0;
          let jzz = 0;
          let jxz = 0;
          for (let t = 0; t < 8; t++) {
            const ang = (t / 8) * Math.PI * 2;
            const ti = wrapIndex(m + Math.round(Math.sin(ang) * r), n) * n
              + wrapIndex(q + Math.round(Math.cos(ang) * r), n);
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
        const inj = Math.max(0, this.gate - metric) * this.perStep;
        out[i] = inj;
        sum += inj;
      }
    }
    return sum / (n * n);
  }

  accumulate(inj: Float32Array, decay: number, bDecay: number): void {
    const n = this.n;
    const size = n * n;
    const cap = Math.max(1, foamParams.foamAccumMax);
    for (let i = 0; i < size; i++) {
      this.sR[i] = Math.min(cap, this.residue[i] + inj[i]);
      this.sB[i] = Math.min(cap, this.breaking[i] + inj[i]);
    }
    for (let m = 0; m < n; m++) {
      for (let q = 0; q < n; q++) {
        this.residue[m * n + q] = blurDecayAt(
          this.sR, n, q, m, foamParams.blurRadius, decay, this.blurMix,
        ) * (cap > 1 ? 1 : 1);
        this.breaking[m * n + q] = blurDecayAt(
          this.sB, n, q, m, foamParams.blurRadius, bDecay, this.blurMix,
        );
      }
    }
  }
}

interface Sea {
  lambda: number;
  seaSigma: number;
  crestBias: number;
  decay: number;
  bDecay: number;
  gain: number;
}

function configure(bands: Band[], p: OceanParams): Sea {
  const jacobianRms = Math.sqrt(bands.reduce((a, b) => a + b.jacobianRms ** 2, 0));
  const heightRms = Math.sqrt(bands.reduce((a, b) => a + b.heightVariance, 0));
  const lambda = effectiveChoppiness(p.choppiness, jacobianRms, p.choppinessFoldLimit);
  const seaSigma = jacobianSigma(jacobianRms, lambda);
  const windScale = whitecapWindScale(p.windSpeed, foamParams.whitecapWindRef);
  const decay = decayFactorPerFrame(foamParams.decayHalfLife, SIM_DT);
  const bDecay = Math.min(decay, decayFactorPerFrame(foamParams.breakingHalfLife, SIM_DT));
  const ageTicks = meanFoamAgeTicks(decay);
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
  }
  return {
    lambda,
    seaSigma,
    crestBias: crestBiasPerMetre(foamParams.crestBiasSigma, jacobianRms, lambda, heightRms),
    decay,
    bDecay,
    gain: breakingGain(decay, bDecay),
  };
}

function st(v: number[]) {
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  return { mean, sd, cv: mean > 0 ? sd / mean : NaN, min: Math.min(...v), max: Math.max(...v) };
}

/** dominant period (s) of a mean-removed series, by naive DFT */
function dominantPeriod(v: number[], dt: number): { period: number; power: number }[] {
  const n = v.length;
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const out: { period: number; power: number }[] = [];
  for (let k = 1; k < n / 2; k++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const ang = (-2 * Math.PI * k * i) / n;
      re += (v[i] - mean) * Math.cos(ang);
      im += (v[i] - mean) * Math.sin(ang);
    }
    out.push({ period: (n * dt) / k, power: (re * re + im * im) / (n * n) });
  }
  out.sort((a, b) => b.power - a.power);
  return out.slice(0, 6);
}

describe('SCRATCH 2: resolution + fine time series', () => {
  maybe('realised sigma vs analytic, per band per grid', () => {
    /* eslint-disable no-console */
    const p = oceanParams;
    console.log('\n=== REALISED sigma(lambda-) vs the ANALYTIC one the gate uses ===');
    console.log('band  N   cell(m)  realised sd  analytic sd  ratio  firedArea%');
    for (const index of [0, 1, 2]) {
      for (const n of [128, 256, 512]) {
        const bands = [0, 1, 2].map((i) => new Band(i, i === index ? n : 128, p));
        const sea = configure(bands, p);
        const b = bands[index];
        b.evolve(30, sea.lambda);
        const size = n * n;
        let s = 0;
        let s2 = 0;
        for (let i = 0; i < size; i++) {
          s += b.lam[i];
          s2 += b.lam[i] * b.lam[i];
        }
        const mean = s / size;
        const sd = Math.sqrt(Math.max(0, s2 / size - mean * mean));
        const ss = metricSigmaScale(foamParams.crestBiasSigma, foamParams.breakupSigma, b.octaves);
        const analytic = eigenSigma(b.jacobianRms, sea.lambda) * ss;
        const out = new Float32Array(size);
        b.inject(bands, sea.crestBias, 0.4, out);
        let fired = 0;
        for (let i = 0; i < size; i++) if (out[i] > 0) fired++;
        console.log(
          `  ${index}  ${n}  ${(b.domain / n).toFixed(3)}  ${sd.toFixed(5)}  ` +
          `${analytic.toFixed(5)}  ${(sd / analytic).toFixed(3)}  ` +
          `${(100 * fired / size).toFixed(3)}%`,
        );
      }
    }
    expect(true).toBe(true);
    /* eslint-enable no-console */
  }, 1800_000);

  maybe('fine time series of the domain-mean, per band', () => {
    /* eslint-disable no-console */
    const p = oceanParams;
    // 256 per band: cascade 0 gets 3.95 m cells (GPU 1.97), cascade 1 0.383 m
    // (GPU 0.191), cascade 2 0.0887 m (GPU 0.0443). One octave short each,
    // which UNDERSTATES the fine bands' spread — stated, not hidden.
    const bands = [0, 1, 2].map((i) => new Band(i, 256, p));
    const sea = configure(bands, p);
    const dt = 0.25;
    const steps = 480; // 120 s
    const series: number[][] = [[], [], []];
    const outs = bands.map((b) => new Float32Array(b.n * b.n));
    // BREAKUP OFF for the long run: it is a zero-mean world field drifting at
    // 0.21 m/s, so it cannot make a global pulse. Checked below over 40 s.
    for (let s = 0; s < steps; s++) {
      const t = s * dt;
      for (const b of bands) b.evolve(t, sea.lambda);
      for (const b of bands) {
        series[b.index].push(b.inject(bands, sea.crestBias, t * 0.013, outs[b.index], false));
      }
    }
    // control: 40 s WITH the breakup, same band, to show the CV is unchanged
    const ctrlOn: number[] = [];
    const ctrlOff: number[] = [];
    for (let s = 0; s < 160; s++) {
      const t = s * dt;
      bands[1].evolve(t, sea.lambda);
      ctrlOn.push(bands[1].inject(bands, sea.crestBias, t * 0.013, outs[1], true));
      ctrlOff.push(bands[1].inject(bands, sea.crestBias, t * 0.013, outs[1], false));
    }
    console.log(
      `\n[control] lane 1 over 40 s: CV with breakup=${st(ctrlOn).cv.toFixed(3)}, ` +
      `without=${st(ctrlOff).cv.toFixed(3)}`,
    );
    console.log('\n=== DOMAIN-MEAN INJECTION, 120 s at 0.25 s, N=256 ===');
    console.log('(a band tiles over its domain, so this IS what every tile on screen does)');
    for (const b of bands) {
      const s = st(series[b.index]);
      const dp = dominantPeriod(series[b.index], dt);
      console.log(
        `lane ${b.index} (tiles every ${b.domain} m): mean=${s.mean.toExponential(3)} ` +
        `CV=${s.cv.toFixed(3)} min/max=${(s.min / s.mean).toFixed(3)}/${(s.max / s.mean).toFixed(2)}`,
      );
      console.log(
        `        top periods (s): ` +
        dp.map((d) => `${d.period.toFixed(1)}`).join(', '),
      );
    }
    const comp = series[0].map((v, i) => v + series[1][i] + series[2][i]);
    const sc = st(comp);
    console.log(
      `COMPOSITE: mean=${sc.mean.toExponential(3)} CV=${sc.cv.toFixed(3)} ` +
      `min/max=${(sc.min / sc.mean).toFixed(3)}/${(sc.max / sc.mean).toFixed(2)}`,
    );
    console.log(`  top periods (s): ${dominantPeriod(comp, dt).map((d) => d.period.toFixed(1)).join(', ')}`);
    // the one lever inside src/foam: injectFineCascade = 0 retires cascade 2,
    // whose 22.7 m tile repeats 311x across a 400 m view
    const no2 = series[0].map((v, i) => v + series[1][i]);
    const s2 = st(no2);
    console.log(
      `\nWITHOUT cascade 2 (injectFineCascade=0): CV ${sc.cv.toFixed(3)} -> ${s2.cv.toFixed(3)} ; ` +
      `min/max ${(sc.min / sc.mean).toFixed(3)}/${(sc.max / sc.mean).toFixed(2)} -> ` +
      `${(s2.min / s2.mean).toFixed(3)}/${(s2.max / s2.mean).toFixed(2)} ; ` +
      `injection mean ${sc.mean.toExponential(3)} -> ${s2.mean.toExponential(3)} ` +
      `(${((s2.mean / sc.mean - 1) * 100).toFixed(1)}% — restore with injectStrength x${(sc.mean / s2.mean).toFixed(3)})`,
    );
    const no12 = series[0];
    console.log(
      `cascade 0 ALONE: CV ${st(no12).cv.toFixed(3)} ` +
      `min/max ${(st(no12).min / st(no12).mean).toFixed(3)}/${(st(no12).max / st(no12).mean).toFixed(2)} ` +
      `(share of injection ${(100 * st(no12).mean / sc.mean).toFixed(1)}%)`,
    );
    console.log('\nt(s), lane0, lane1, lane2, composite  (each / own mean)');
    for (let s = 0; s < steps; s += 2) {
      console.log(
        `${(s * dt).toFixed(2)}, ` +
        [0, 1, 2].map((i) => (series[i][s] / st(series[i]).mean).toFixed(3)).join(', ') +
        `, ${(comp[s] / sc.mean).toFixed(3)}`,
      );
    }
    expect(true).toBe(true);
    /* eslint-enable no-console */
  }, 1800_000);

  maybe('COUNTERFACTUAL: gate tracking the tile\'s LIVE spread', () => {
    /* eslint-disable no-console */
    const p = oceanParams;
    const bands = [0, 1, 2].map((i) => new Band(i, 256, p));
    const sea = configure(bands, p);
    const dt = 0.25;
    const steps = 480;
    const outs = bands.map((b) => new Float32Array(b.n * b.n));
    // pass 1: record realised (mean, sd) of lambda- per tile per step
    const mom: { mean: number; sd: number }[][] = [[], [], []];
    const staticInj: number[][] = [[], [], []];
    for (let s = 0; s < steps; s++) {
      const t = s * dt;
      for (const b of bands) b.evolve(t, sea.lambda);
      for (const b of bands) {
        const size = b.n * b.n;
        let a = 0;
        let a2 = 0;
        for (let i = 0; i < size; i++) { a += b.lam[i]; a2 += b.lam[i] * b.lam[i]; }
        const mean = a / size;
        mom[b.index].push({ mean, sd: Math.sqrt(Math.max(0, a2 / size - mean * mean)) });
        staticInj[b.index].push(b.inject(bands, sea.crestBias, t * 0.013, outs[b.index], false));
      }
    }
    // pass 2: same field, gate re-anchored to the tile's LIVE (mean, sd) at the
    // SAME z the static gate averages to — the §V36 idiom applied to time as
    // well as to weather
    const liveInj: number[][] = [[], [], []];
    const z0: number[] = [];
    for (const b of bands) {
      const mm = st(mom[b.index].map((m) => m.mean)).mean;
      const ms = st(mom[b.index].map((m) => m.sd)).mean;
      z0.push((b.gate - mm) / ms);
    }
    const gate0 = bands.map((b) => b.gate);
    const per0 = bands.map((b) => b.perStep);
    for (let s = 0; s < steps; s++) {
      const t = s * dt;
      for (const b of bands) b.evolve(t, sea.lambda);
      for (const b of bands) {
        const m = mom[b.index][s];
        const msAvg = st(mom[b.index].map((q) => q.sd)).mean;
        b.gate = m.mean + z0[b.index] * m.sd;
        b.perStep = per0[b.index] * (msAvg / Math.max(1e-9, m.sd));
        liveInj[b.index].push(b.inject(bands, sea.crestBias, t * 0.013, outs[b.index], false));
      }
    }
    for (let i = 0; i < 3; i++) { bands[i].gate = gate0[i]; bands[i].perStep = per0[i]; }

    console.log('\n=== COUNTERFACTUAL: gate anchored to the tile\'s LIVE spread ===');
    console.log('band   static CV   live CV   static mean   live mean   mean ratio');
    for (const b of bands) {
      const a = st(staticInj[b.index]);
      const c = st(liveInj[b.index]);
      console.log(
        `  ${b.index}    ${a.cv.toFixed(3)}      ${c.cv.toFixed(3)}    ` +
        `${a.mean.toExponential(3)}   ${c.mean.toExponential(3)}   ${(c.mean / a.mean).toFixed(3)}`,
      );
    }
    const cs = staticInj[0].map((v, i) => v + staticInj[1][i] + staticInj[2][i]);
    const cl = liveInj[0].map((v, i) => v + liveInj[1][i] + liveInj[2][i]);
    const a = st(cs);
    const c = st(cl);
    console.log(
      `COMPOSITE: CV ${a.cv.toFixed(3)} -> ${c.cv.toFixed(3)} ; ` +
      `min/max ${(a.min / a.mean).toFixed(3)}/${(a.max / a.mean).toFixed(2)} -> ` +
      `${(c.min / c.mean).toFixed(3)}/${(c.max / c.mean).toFixed(2)} ; ` +
      `mean ${a.mean.toExponential(3)} -> ${c.mean.toExponential(3)} ` +
      `(${((c.mean / a.mean - 1) * 100).toFixed(1)}% — the Jensen cost, recover it on injectStrength)`,
    );
    expect(true).toBe(true);
    /* eslint-enable no-console */
  }, 1800_000);

  maybe('EVENT COUNT: how many independent whitecaps does one tile hold?', () => {
    /* eslint-disable no-console */
    const p = oceanParams;
    const bands = [0, 1, 2].map((i) => new Band(i, 256, p));
    const sea = configure(bands, p);
    const dt = 0.5;
    const steps = 200; // 100 s
    const outs = bands.map((b) => new Float32Array(b.n * b.n));

    /** connected components (4-neighbour, wrapping) of the fired region */
    function components(f: Float32Array, n: number): { count: number; sizes: number[] } {
      const seen = new Uint8Array(n * n);
      const sizes: number[] = [];
      const stack: number[] = [];
      for (let i = 0; i < n * n; i++) {
        if (seen[i] || f[i] <= 0) continue;
        let size = 0;
        stack.length = 0;
        stack.push(i);
        seen[i] = 1;
        while (stack.length) {
          const q = stack.pop() as number;
          size++;
          const y = (q / n) | 0;
          const x = q % n;
          const nb = [
            wrapIndex(y, n) * n + wrapIndex(x + 1, n),
            wrapIndex(y, n) * n + wrapIndex(x - 1, n),
            wrapIndex(y + 1, n) * n + wrapIndex(x, n),
            wrapIndex(y - 1, n) * n + wrapIndex(x, n),
          ];
          for (const t of nb) if (!seen[t] && f[t] > 0) { seen[t] = 1; stack.push(t); }
        }
        sizes.push(size);
      }
      return { count: sizes.length, sizes };
    }

    console.log('\n=== HOW MANY INDEPENDENT CAPS IS ONE TILE SHOWING? ===');
    const counts: number[][] = [[], [], []];
    const areas: number[][] = [[], [], []];
    const majors: number[][] = [[], [], []];
    for (let s = 0; s < steps; s++) {
      const t = s * dt;
      for (const b of bands) b.evolve(t, sea.lambda);
      for (const b of bands) {
        b.inject(bands, sea.crestBias, t * 0.013, outs[b.index], true);
        const cc = components(outs[b.index], b.n);
        counts[b.index].push(cc.count);
        let fired = 0;
        for (let i = 0; i < b.n * b.n; i++) if (outs[b.index][i] > 0) fired++;
        areas[b.index].push(fired / (b.n * b.n));
        const big = cc.sizes.length ? Math.max(...cc.sizes) : 0;
        majors[b.index].push(Math.sqrt(big) * b.cell);
      }
    }
    const screen = 400; // metres of sea a deck camera reads
    for (const b of bands) {
      const cn = st(counts[b.index]);
      const ar = st(areas[b.index]);
      const repeats = (screen / b.domain) ** 2;
      console.log(
        `lane ${b.index} (tile ${b.domain} m): caps/tile mean=${cn.mean.toFixed(1)} ` +
        `sd=${cn.sd.toFixed(1)} CV=${cn.cv.toFixed(3)} min..max=${cn.min}..${cn.max} | ` +
        `fired ${(100 * ar.mean).toFixed(3)}% CV=${ar.cv.toFixed(3)} | ` +
        `biggest cap ~${st(majors[b.index]).mean.toFixed(1)} m`,
      );
      console.log(
        `        N_eff from area CV = ${(1 / ar.cv ** 2).toFixed(1)} independent events ; ` +
        `this tile repeats ${repeats.toFixed(0)}x across a ${screen} m view ` +
        `=> ${(cn.mean * repeats).toFixed(0)} caps on screen but only ` +
        `${cn.mean.toFixed(1)} DISTINCT ones`,
      );
    }
    expect(true).toBe(true);
    /* eslint-enable no-console */
  }, 1800_000);

  maybe('SWEEP: gate depth vs synchrony, at held coverage', () => {
    /* eslint-disable no-console */
    const p = oceanParams;
    const bands = [0, 1, 2].map((i) => new Band(i, 256, p));
    const dt = 0.5;
    const steps = 160; // 80 s
    const outs = bands.map((b) => new Float32Array(b.n * b.n));
    console.log('\n=== GATE DEPTH SWEEP (jacobianFoamBias), injectStrength held free ===');
    console.log('bias    z(sigma)   fired%   injMean     injCV   lane1CV   lane2CV   caps/tile(l1)');
    const originalBias = p.jacobianFoamBias;
    for (const bias of [0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
      (p as { jacobianFoamBias: number }).jacobianFoamBias = bias;
      const sea = configure(bands, p);
      const series: number[][] = [[], [], []];
      const firedS: number[] = [];
      const capsL1: number[] = [];
      for (let s = 0; s < steps; s++) {
        const t = s * dt;
        for (const b of bands) b.evolve(t, sea.lambda);
        let firedTot = 0;
        for (const b of bands) {
          series[b.index].push(b.inject(bands, sea.crestBias, t * 0.013, outs[b.index], true));
          let f = 0;
          for (let i = 0; i < b.n * b.n; i++) if (outs[b.index][i] > 0) f++;
          if (b.index === 1) {
            firedTot = f / (b.n * b.n);
            // rough cap count: 4-neighbour flood, wrapping
            const seen = new Uint8Array(b.n * b.n);
            let cnt = 0;
            const stack: number[] = [];
            for (let i = 0; i < b.n * b.n; i++) {
              if (seen[i] || outs[1][i] <= 0) continue;
              cnt++;
              stack.length = 0; stack.push(i); seen[i] = 1;
              while (stack.length) {
                const q = stack.pop() as number;
                const y = (q / b.n) | 0; const x = q % b.n;
                for (const tt of [
                  wrapIndex(y, b.n) * b.n + wrapIndex(x + 1, b.n),
                  wrapIndex(y, b.n) * b.n + wrapIndex(x - 1, b.n),
                  wrapIndex(y + 1, b.n) * b.n + wrapIndex(x, b.n),
                  wrapIndex(y - 1, b.n) * b.n + wrapIndex(x, b.n),
                ]) if (!seen[tt] && outs[1][tt] > 0) { seen[tt] = 1; stack.push(tt); }
              }
            }
            capsL1.push(cnt);
          }
        }
        firedS.push(firedTot);
      }
      const comp = series[0].map((v, i) => v + series[1][i] + series[2][i]);
      const sc = st(comp);
      console.log(
        `${bias.toFixed(2)}   ${((1 - bias) / configure(bands, p).seaSigma).toFixed(2)}   ` +
        `${(100 * st(firedS).mean).toFixed(3)}%   ${sc.mean.toExponential(3)}   ` +
        `${sc.cv.toFixed(3)}   ${st(series[1]).cv.toFixed(3)}   ${st(series[2]).cv.toFixed(3)}   ` +
        `${st(capsL1).mean.toFixed(1)} (CV ${st(capsL1).cv.toFixed(2)})`,
      );
    }
    (p as { jacobianFoamBias: number }).jacobianFoamBias = originalBias;
    console.log('NOTE: injMean is NOT held here — read CV against it, and see the report.');
    expect(true).toBe(true);
    /* eslint-enable no-console */
  }, 1800_000);

  maybe('MECHANISM: is the pulse a small sigma drift amplified by the tail?', () => {
    /* eslint-disable no-console */
    const p = oceanParams;
    const bands = [0, 1, 2].map((i) => new Band(i, 256, p));
    const sea = configure(bands, p);
    const dt = 0.25;
    const steps = 480;
    const rows: { t: number; per: { sd: number; mean: number; z: number; inj: number; fired: number }[] }[] = [];
    const outs = bands.map((b) => new Float32Array(b.n * b.n));
    for (let s = 0; s < steps; s++) {
      const t = s * dt;
      for (const b of bands) b.evolve(t, sea.lambda);
      const per = bands.map((b) => {
        const size = b.n * b.n;
        let a = 0;
        let a2 = 0;
        for (let i = 0; i < size; i++) {
          a += b.lam[i];
          a2 += b.lam[i] * b.lam[i];
        }
        const mean = a / size;
        const sd = Math.sqrt(Math.max(0, a2 / size - mean * mean));
        const inj = b.inject(bands, sea.crestBias, t * 0.013, outs[b.index], false);
        let fired = 0;
        for (let i = 0; i < size; i++) if (outs[b.index][i] > 0) fired++;
        return { sd, mean, z: (mean - b.gate) / sd, inj, fired: fired / size };
      });
      rows.push({ t, per });
    }
    console.log('\n=== MECHANISM: tile-wide sigma vs tile-wide injection ===');
    for (const b of bands) {
      const sd = rows.map((r) => r.per[b.index].sd);
      const mn = rows.map((r) => r.per[b.index].mean);
      const z = rows.map((r) => r.per[b.index].z);
      const inj = rows.map((r) => r.per[b.index].inj);
      const fired = rows.map((r) => r.per[b.index].fired);
      const ssd = st(sd);
      const sinj = st(inj);
      console.log(
        `lane ${b.index}: sd(lambda-) CV=${ssd.cv.toFixed(4)} ` +
        `range ${(ssd.min / ssd.mean).toFixed(3)}..${(ssd.max / ssd.mean).toFixed(3)} | ` +
        `mean(lambda-) CV=${st(mn).cv.toFixed(4)} | ` +
        `z CV=${st(z).cv.toFixed(4)} range ${st(z).min.toFixed(2)}..${st(z).max.toFixed(2)} | ` +
        `fired ${(100 * st(fired).mean).toFixed(3)}% CV=${st(fired).cv.toFixed(3)} | ` +
        `inj CV=${sinj.cv.toFixed(3)}`,
      );
      console.log(
        `        AMPLIFICATION: inj CV / sd CV = ${(sinj.cv / ssd.cv).toFixed(1)}x ; ` +
        `r(sd, inj) = ${(() => {
          const ma = ssd.mean;
          const mb = sinj.mean;
          let num = 0; let da = 0; let db = 0;
          for (let i = 0; i < sd.length; i++) {
            num += (sd[i] - ma) * (inj[i] - mb); da += (sd[i] - ma) ** 2; db += (inj[i] - mb) ** 2;
          }
          return num / Math.sqrt(Math.max(1e-30, da * db));
        })().toFixed(3)}`,
      );
    }

    // ---- what the ACCUMULATOR does to it (domain means are exact) ---------
    // R(t+dt) = (R + I)·decay ; the blur is mass-conserving so it drops out.
    console.log('\n=== WHAT REACHES THE SCREEN (domain-mean accumulator, exact) ===');
    const dR = decayFactorPerFrame(foamParams.decayHalfLife, dt);
    const dB = Math.min(dR, decayFactorPerFrame(foamParams.breakingHalfLife, dt));
    const gain = breakingGain(
      decayFactorPerFrame(foamParams.decayHalfLife, SIM_DT),
      Math.min(
        decayFactorPerFrame(foamParams.decayHalfLife, SIM_DT),
        decayFactorPerFrame(foamParams.breakingHalfLife, SIM_DT),
      ),
    );
    const maskSeries: number[] = [];
    const perBandMask: number[][] = [[], [], []];
    const R = [0, 0, 0];
    const Bc = [0, 0, 0];
    for (let pass = 0; pass < 2; pass++) { // pass 0 = burn-in
      for (let s = 0; s < steps; s++) {
        let depth = 0;
        for (const b of bands) {
          // injection per 0.25 s tick = per-second rate × dt (perStep is per SIM_DT)
          const I = rows[s].per[b.index].inj * (dt / SIM_DT);
          R[b.index] = Math.min(foamParams.foamAccumMax, (R[b.index] + I) * dR);
          Bc[b.index] = Math.min(foamParams.foamAccumMax, (Bc[b.index] + I) * dB);
          const m = foamMaskFrom(
            R[b.index], Bc[b.index], gain, foamParams.residueWeight, foamParams.breakingWeight,
          );
          if (pass === 1) perBandMask[b.index].push(m);
          depth += m;
        }
        if (pass === 1) maskSeries.push(foamCoverage(depth, foamParams.foamDensity));
      }
    }
    for (const b of bands) {
      const s = st(perBandMask[b.index]);
      console.log(
        `lane ${b.index} mask depth: mean=${s.mean.toExponential(3)} CV=${s.cv.toFixed(3)} ` +
        `min/max=${(s.min / s.mean).toFixed(3)}/${(s.max / s.mean).toFixed(2)}`,
      );
    }
    const sm = st(maskSeries);
    console.log(
      `COMPOSITE coverage 1-e^(-d*depth): mean=${(100 * sm.mean).toFixed(4)}% ` +
      `CV=${sm.cv.toFixed(3)} min/max=${(100 * sm.min).toFixed(4)}%/${(100 * sm.max).toFixed(4)}% ` +
      `(=${(sm.max / sm.min).toFixed(1)}x swing)`,
    );
    console.log(`  top periods (s): ${dominantPeriod(maskSeries, dt).map((d) => d.period.toFixed(1)).join(', ')}`);
    console.log('\nt(s), lane0mask, lane1mask, lane2mask, coverage%  (masks / own mean)');
    for (let s = 0; s < steps; s += 2) {
      console.log(
        `${(s * dt).toFixed(2)}, ` +
        [0, 1, 2].map((i) => (perBandMask[i][s] / st(perBandMask[i]).mean).toFixed(3)).join(', ') +
        `, ${(100 * maskSeries[s]).toFixed(4)}`,
      );
    }
    expect(true).toBe(true);
    /* eslint-enable no-console */
  }, 1800_000);
});
