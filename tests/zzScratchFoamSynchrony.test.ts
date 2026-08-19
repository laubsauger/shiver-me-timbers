/**
 * SCRATCH MEASUREMENT — NOT AN INVARIANT TEST. Delete or promote before merge.
 *
 * User report: foam is "too synchronous across the whole screen — it comes
 * into view and then goes out and comes back into view". A synchrony complaint
 * cannot be read off a still, so this is a CPU transliteration of the inject +
 * blurDecay passes over the real three-cascade spectrum, sampled over time.
 *
 * It answers, in order:
 *   1. per-cascade contribution to the injection (mass, fired area, σ)
 *   2. whether any term in the gate is globally coherent
 *   3. the time series of foam over a 300 m "screen" patch, per band
 *   4. the spatial autocorrelation length of the injected field, per band
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

/** grid per cascade — resolves every band's own wavelengths (see report) */
const N = 128;

interface Lane {
  index: number;
  domain: number;
  cell: number;
  /** analytic moments, exactly what the sim gates on */
  jacobianRms: number;
  heightVariance: number;
  h: Float32Array;
  dx: Float32Array;
  dz: Float32Array;
  /** ∂h/∂x, ∂h/∂z, ∂Dx/∂x, ∂Dz/∂z, det J */
  dhdx: Float32Array;
  dhdz: Float32Array;
  dDxdx: Float32Array;
  dDzdz: Float32Array;
  det: Float32Array;
  h0: Float32Array;
  kxN: Float32Array;
  kzN: Float32Array;
  omega: Float32Array;
  a: { re: Float32Array; im: Float32Array };
  b: { re: Float32Array; im: Float32Array };
  octaves: number;
  tensorRadius: number;
  // per-tick gate state
  gate: number;
  perStep: number;
  breakupAmp: number;
  sigma: number;
  // accumulators
  residue: Float32Array;
  breaking: Float32Array;
  scratchR: Float32Array;
  scratchB: Float32Array;
  blurMix: number;
}

function makeLane(index: number, p: OceanParams, butterfly: Float32Array): Lane {
  const domain = p.cascades[index].domain;
  const band = cascadeBand(index, p.splitWavelengths);
  const full = generateH0(p.resolution, domain, 1337 + index * 7919, p, band);
  const h0 = extractCentralBlock(full, p.resolution, N);
  const size = N * N;
  const kxN = new Float32Array(size);
  const kzN = new Float32Array(size);
  const omega = new Float32Array(size);
  for (let m = 0; m < N; m++) {
    for (let n = 0; n < N; n++) {
      const kx = (2 * Math.PI * (n - N / 2)) / domain;
      const kz = (2 * Math.PI * (m - N / 2)) / domain;
      const k = Math.hypot(kx, kz);
      const safe = Math.max(k, 1e-6);
      const i = m * N + n;
      kxN[i] = kx / safe;
      kzN[i] = kz / safe;
      omega[i] = Math.sqrt(9.81 * k);
    }
  }
  const texel = foamTexelMetres(domain, p.resolution);
  const kMax = cascadeBand(index, p.splitWavelengths).kMax;
  return {
    index,
    domain,
    cell: domain / N,
    jacobianRms: spectralJacobianRms(p.resolution, domain, p, band),
    heightVariance: spectralHeightVariance(p.resolution, domain, p, band),
    h: new Float32Array(size),
    dx: new Float32Array(size),
    dz: new Float32Array(size),
    dhdx: new Float32Array(size),
    dhdz: new Float32Array(size),
    dDxdx: new Float32Array(size),
    dDzdz: new Float32Array(size),
    det: new Float32Array(size),
    h0,
    kxN,
    kzN,
    omega,
    a: { re: new Float32Array(size), im: new Float32Array(size) },
    b: { re: new Float32Array(size), im: new Float32Array(size) },
    octaves: breakupOctaves(foamParams.breakupMetres, texel),
    tensorRadius: tensorRadiusTexels(
      Number.isFinite(kMax) ? (2 * Math.PI) / kMax : 0,
      texel,
    ),
    gate: 0,
    perStep: 0,
    breakupAmp: 0,
    sigma: 0,
    residue: new Float32Array(size),
    breaking: new Float32Array(size),
    scratchR: new Float32Array(size),
    scratchB: new Float32Array(size),
    blurMix: 1,
    // butterfly is shared; kept out of the lane on purpose
  } as Lane & { _b?: unknown };
}

function evolve(lane: Lane, time: number, lambda: number, butterfly: Float32Array): void {
  const size = N * N;
  for (let i = 0; i < size; i++) {
    const phase = lane.omega[i] * time;
    const c = Math.cos(phase);
    const s = Math.sin(phase);
    const r0 = lane.h0[i * 4];
    const i0 = lane.h0[i * 4 + 1];
    const r1 = lane.h0[i * 4 + 2];
    const i1 = lane.h0[i * 4 + 3];
    const hRe = (r0 + r1) * c - (i0 + i1) * s;
    const hIm = (r0 - r1) * s + (i0 - i1) * c;
    lane.a.re[i] = hRe * (1 - lane.kxN[i]);
    lane.a.im[i] = hIm * (1 - lane.kxN[i]);
    lane.b.re[i] = -hIm * lane.kzN[i];
    lane.b.im[i] = hRe * lane.kzN[i];
  }
  cpuIFFT2D(lane.a, butterfly, N);
  cpuIFFT2D(lane.b, butterfly, N);
  for (let m = 0; m < N; m++) {
    for (let x = 0; x < N; x++) {
      const i = m * N + x;
      const sign = (x + m) & 1 ? -1 : 1;
      lane.h[i] = sign * lane.a.re[i];
      lane.dx[i] = sign * lane.a.im[i] * lambda;
      lane.dz[i] = sign * lane.b.re[i] * lambda;
    }
  }
  // central differences, exactly as unpackPass builds them
  const hStep = lane.cell;
  for (let m = 0; m < N; m++) {
    for (let n = 0; n < N; n++) {
      const i = m * N + n;
      const xp = m * N + wrapIndex(n + 1, N);
      const xm = m * N + wrapIndex(n - 1, N);
      const zp = wrapIndex(m + 1, N) * N + n;
      const zm = wrapIndex(m - 1, N) * N + n;
      lane.dhdx[i] = (lane.h[xp] - lane.h[xm]) / (2 * hStep);
      lane.dhdz[i] = (lane.h[zp] - lane.h[zm]) / (2 * hStep);
      const ax = (lane.dx[xp] - lane.dx[xm]) / (2 * hStep);
      const bz = (lane.dz[zp] - lane.dz[zm]) / (2 * hStep);
      const az = (lane.dx[zp] - lane.dx[zm]) / (2 * hStep);
      lane.dDxdx[i] = ax;
      lane.dDzdz[i] = bz;
      lane.det[i] = (1 + ax) * (1 + bz) - az * az;
    }
  }
}

/** bilinear wrap sample of a lane grid at a world position */
function sampleWrap(grid: Float32Array, domain: number, x: number, z: number): number {
  const u = ((x / domain) % 1 + 1) % 1 * N;
  const v = ((z / domain) % 1 + 1) % 1 * N;
  const i0 = Math.floor(u);
  const j0 = Math.floor(v);
  const fu = u - i0;
  const fv = v - j0;
  const i1 = wrapIndex(i0 + 1, N);
  const j1 = wrapIndex(j0 + 1, N);
  const a = grid[wrapIndex(j0, N) * N + wrapIndex(i0, N)];
  const b = grid[wrapIndex(j0, N) * N + i1];
  const c = grid[j1 * N + wrapIndex(i0, N)];
  const d = grid[j1 * N + i1];
  return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv;
}

/**
 * One tick of the inject pass, CPU mirror. Writes the injection field into
 * `out` and returns nothing. `crestBias` 0 disables the long-wave term.
 */
function injectField(
  lane: Lane,
  lanes: Lane[],
  crestBias: number,
  drift: number,
  out: Float32Array,
  breakup: boolean,
): void {
  const r = lane.tensorRadius;
  for (let m = 0; m < N; m++) {
    for (let n = 0; n < N; n++) {
      const i = m * N + n;
      const trace = 2 + lane.dDxdx[i] + lane.dDzdz[i];
      let metric = minEigenvalue(trace, lane.det[i]);
      const worldX = (n + 0.5) * lane.cell;
      const worldZ = (m + 0.5) * lane.cell;
      if (crestBias !== 0) {
        let hOther = 0;
        for (const o of lanes) {
          if (o.index === lane.index) continue;
          hOther += sampleWrap(o.h, o.domain, worldX, worldZ);
        }
        metric -= crestBias * hOther;
      }
      if (breakup && lane.octaves > 0) {
        let jxx = 0;
        let jzz = 0;
        let jxz = 0;
        for (let t = 0; t < 8; t++) {
          const ang = (t / 8) * Math.PI * 2;
          const ox = Math.round(Math.cos(ang) * r);
          const oz = Math.round(Math.sin(ang) * r);
          const ti = wrapIndex(m + oz, N) * N + wrapIndex(n + ox, N);
          jxx += lane.dhdx[ti] * lane.dhdx[ti];
          jzz += lane.dhdz[ti] * lane.dhdz[ti];
          jxz += lane.dhdx[ti] * lane.dhdz[ti];
        }
        const frame = crestFrame(jxx, jzz, jxz);
        metric += lane.breakupAmp * breakupJitterAligned(
          worldX, worldZ, frame, foamParams.breakupElongation,
          1 / Math.max(0.5, foamParams.breakupMetres),
          foamParams.breakupWarp, lane.octaves, drift,
        );
      }
      out[i] = Math.max(0, lane.gate - metric) * lane.perStep;
    }
  }
}

function stats(v: number[]): { mean: number; sd: number; cv: number; min: number; max: number } {
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  return { mean, sd, cv: mean > 0 ? sd / mean : NaN, min: Math.min(...v), max: Math.max(...v) };
}

function corr(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(Math.max(1e-30, da * db));
}

function corrF(a: Float32Array, b: Float32Array): number {
  return corr(Array.from(a), Array.from(b));
}

/** radially averaged autocorrelation length (1/e) of a periodic field, metres */
function autocorrLength(f: Float32Array, cell: number): number {
  const size = N * N;
  let mean = 0;
  for (let i = 0; i < size; i++) mean += f[i];
  mean /= size;
  let v0 = 0;
  for (let i = 0; i < size; i++) v0 += (f[i] - mean) ** 2;
  v0 /= size;
  if (!(v0 > 0)) return 0;
  // sample along +x and +z and average (the field is anisotropic; this is a
  // scale, not a shape, measurement)
  for (let d = 1; d < N / 2; d++) {
    let sx = 0;
    let sz = 0;
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        sx += (f[m * N + n] - mean) * (f[m * N + wrapIndex(n + d, N)] - mean);
        sz += (f[m * N + n] - mean) * (f[wrapIndex(m + d, N) * N + n] - mean);
      }
    }
    const rho = (sx / size + sz / size) / (2 * v0);
    if (rho < 1 / Math.E) return d * cell;
  }
  return (N / 2) * cell;
}

describe('SCRATCH: foam synchrony', () => {
  maybe('measures per-cascade contribution and the global time series', () => {
    const p = oceanParams;
    const butterfly = generateButterfly(N);
    const lanes = [0, 1, 2].map((i) => makeLane(i, p, butterfly));

    const jacobianRms = Math.sqrt(
      lanes.reduce((a, l) => a + l.jacobianRms * l.jacobianRms, 0),
    );
    const heightRms = Math.sqrt(lanes.reduce((a, l) => a + l.heightVariance, 0));
    const lambda = effectiveChoppiness(p.choppiness, jacobianRms, p.choppinessFoldLimit);
    const seaSigma = jacobianSigma(jacobianRms, lambda);
    const windScale = whitecapWindScale(p.windSpeed, foamParams.whitecapWindRef);
    const decay = decayFactorPerFrame(foamParams.decayHalfLife, SIM_DT);
    const bDecay = Math.min(decay, decayFactorPerFrame(foamParams.breakingHalfLife, SIM_DT));
    const ageTicks = meanFoamAgeTicks(decay);
    const crestBias = crestBiasPerMetre(
      foamParams.crestBiasSigma, jacobianRms, lambda, heightRms,
    );

    /* eslint-disable no-console */
    console.log('\n=== SEA ===');
    console.log(`lambda=${lambda.toFixed(4)} jacobianRms=${jacobianRms.toFixed(5)} ` +
      `heightRms=${heightRms.toFixed(3)} seaSigma=${seaSigma.toFixed(5)} ` +
      `windScale=${windScale.toFixed(4)} crestBias=${crestBias.toFixed(4)} /m`);

    for (const l of lanes) {
      const bandSigma = jacobianSigma(l.jacobianRms, lambda);
      const sigmaScale = metricSigmaScale(
        foamParams.crestBiasSigma, foamParams.breakupSigma, l.octaves,
      );
      l.gate = eigenFoamGate(
        p.jacobianFoamBias, l.jacobianRms, lambda, bandSigma, seaSigma, sigmaScale,
      );
      l.perStep = eigenInjectPerStep(
        foamParams.injectStrength * windScale, SIM_DT,
        l.jacobianRms, lambda, bandSigma, seaSigma, sigmaScale,
      );
      l.breakupAmp = Math.max(0, foamParams.breakupSigma) * eigenSigma(l.jacobianRms, lambda);
      l.sigma = eigenSigma(l.jacobianRms, lambda) * sigmaScale;
      l.blurMix = blurMixPerStep(
        foamParams.blurSpreadMetres,
        foamTexelMetres(l.domain, p.resolution),
        foamParams.blurRadius,
        ageTicks,
      );
      console.log(
        `lane ${l.index} domain=${l.domain} cell=${l.cell.toFixed(3)}m ` +
        `jacRms=${l.jacobianRms.toFixed(5)} hVar=${l.heightVariance.toFixed(4)} ` +
        `sigma(lambda-)=${l.sigma.toFixed(5)} gate=${l.gate.toFixed(5)} ` +
        `perStep=${l.perStep.toFixed(4)} oct=${l.octaves} tR=${l.tensorRadius}`,
      );
    }

    // ---- 1. instantaneous per-cascade contribution -------------------------
    const inj = lanes.map(() => new Float32Array(N * N));
    const injNoBias = lanes.map(() => new Float32Array(N * N));
    const T0 = 40;
    for (const l of lanes) evolve(l, T0, lambda, butterfly);
    console.log('\n=== 1. PER-CASCADE CONTRIBUTION (one instant, t=40s) ===');
    console.log('band  firedArea%   injMass    injShare%   acorrLen(m)  acorr(noBreakup)');
    let totalMass = 0;
    const masses: number[] = [];
    for (const l of lanes) {
      injectField(l, lanes, crestBias, T0 * 0.013, inj[l.index], true);
      injectField(l, lanes, 0, T0 * 0.013, injNoBias[l.index], false);
      let fired = 0;
      let mass = 0;
      for (let i = 0; i < N * N; i++) {
        if (inj[l.index][i] > 0) fired++;
        mass += inj[l.index][i];
      }
      mass /= N * N;
      masses.push(mass);
      totalMass += mass;
      console.log(
        `  ${l.index}   ${(100 * fired / (N * N)).toFixed(2)}%   ` +
        `${mass.toExponential(3)}   —   ` +
        `${autocorrLength(inj[l.index], l.cell).toFixed(1)}   ` +
        `${autocorrLength(injNoBias[l.index], l.cell).toFixed(1)}`,
      );
    }
    for (const l of lanes) {
      console.log(`  lane ${l.index} injShare = ${(100 * masses[l.index] / totalMass).toFixed(1)}%`);
    }

    // ---- 2. is a global term modulating the gate? --------------------------
    console.log('\n=== 2. CROSS-BAND COHERENCE OF THE GATE ===');
    // cascade-0 elevation resampled onto each lane's grid
    for (const l of lanes) {
      const h0field = new Float32Array(N * N);
      for (let m = 0; m < N; m++) {
        for (let n = 0; n < N; n++) {
          h0field[m * N + n] = sampleWrap(
            lanes[0].h, lanes[0].domain, (n + 0.5) * l.cell, (m + 0.5) * l.cell,
          );
        }
      }
      console.log(
        `lane ${l.index}: r(inject, cascade0 elevation) with bias = ` +
        `${corrF(inj[l.index], h0field).toFixed(3)}, without = ` +
        `${corrF(injNoBias[l.index], h0field).toFixed(3)}`,
      );
    }

    // ---- 3. the time series over a 300 m screen patch ----------------------
    // A 300 m window of each band, tracked at 0.25 s over 120 s. This is what
    // "comes into view and goes out" is a statement about.
    console.log('\n=== 3. TIME SERIES: mean injection over a 300 m patch ===');
    const patch = 300;
    const originX = 200;
    const originZ = 350;
    const steps = 240;
    const dtSample = 0.5;
    const series: number[][] = lanes.map(() => []);
    const seriesFull: number[][] = lanes.map(() => []);
    const elev0: number[] = [];
    for (let s = 0; s < steps; s++) {
      const t = s * dtSample;
      for (const l of lanes) evolve(l, t, lambda, butterfly);
      for (const l of lanes) {
        injectField(l, lanes, crestBias, t * 0.013, inj[l.index], true);
        // full-domain mean
        let all = 0;
        for (let i = 0; i < N * N; i++) all += inj[l.index][i];
        seriesFull[l.index].push(all / (N * N));
        // 300 m patch mean, sampled on a fixed world grid
        let sum = 0;
        let cnt = 0;
        for (let m = 0; m < 48; m++) {
          for (let n = 0; n < 48; n++) {
            const wx = originX + (n / 48) * patch;
            const wz = originZ + (m / 48) * patch;
            sum += sampleWrap(inj[l.index], l.domain, wx, wz);
            cnt++;
          }
        }
        series[l.index].push(sum / cnt);
      }
      // cascade-0 elevation at the patch centre
      elev0.push(sampleWrap(lanes[0].h, lanes[0].domain, originX + patch / 2, originZ + patch / 2));
    }
    for (const l of lanes) {
      const sp = stats(series[l.index]);
      const sf = stats(seriesFull[l.index]);
      console.log(
        `lane ${l.index}: patch mean=${sp.mean.toExponential(3)} CV=${sp.cv.toFixed(3)} ` +
        `min/max=${(sp.min / sp.mean).toFixed(2)}/${(sp.max / sp.mean).toFixed(2)} | ` +
        `whole-domain CV=${sf.cv.toFixed(3)}`,
      );
    }
    console.log(`r(lane0 patch, lane1 patch) = ${corr(series[0], series[1]).toFixed(3)}`);
    console.log(`r(lane0 patch, lane2 patch) = ${corr(series[0], series[2]).toFixed(3)}`);
    console.log(`r(lane1 patch, lane2 patch) = ${corr(series[1], series[2]).toFixed(3)}`);
    const composite = series[0].map((v, i) => v + series[1][i] + series[2][i]);
    const sc = stats(composite);
    console.log(
      `COMPOSITE patch injection: mean=${sc.mean.toExponential(3)} CV=${sc.cv.toFixed(3)} ` +
      `min/max=${(sc.min / sc.mean).toFixed(2)}/${(sc.max / sc.mean).toFixed(2)}`,
    );
    // dump the series so the shape is legible
    console.log('t(s), lane0, lane1, lane2, composite (normalised to own mean)');
    for (let s = 0; s < steps; s += 4) {
      console.log(
        `${(s * dtSample).toFixed(1)}, ` +
        lanes.map((l) => (series[l.index][s] / stats(series[l.index]).mean).toFixed(3)).join(', ') +
        `, ${(composite[s] / sc.mean).toFixed(3)}`,
      );
    }
    expect(true).toBe(true);
    /* eslint-enable no-console */
  }, 1800_000);
});
