/**
 * SCRATCH 3 — the root-cause confirmation.
 *
 * (a) Same BAND, bigger DOMAIN: if the pulse is "too few modes at the band's
 *     energetic end", widening the tile must kill it and nothing else changes.
 * (b) What dropping cascade 2 (the 311x-repeating tile) buys, and what it costs.
 */
import { describe, expect, it } from 'vitest';
import {
  breakupJitterAligned,
  breakupOctaves,
  crestBiasPerMetre,
  crestFrame,
  decayFactorPerFrame,
  eigenFoamGate,
  eigenInjectPerStep,
  eigenSigma,
  foamTexelMetres,
  jacobianSigma,
  metricSigmaScale,
  minEigenvalue,
  tensorRadiusTexels,
  whitecapWindScale,
  wrapIndex,
} from '../src/foam/foamMath';
import { foamParams } from '../src/params/foam';
import { oceanParams } from '../src/params/ocean';
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

function st(v: number[]) {
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  return { mean, sd, cv: mean > 0 ? sd / mean : NaN, min: Math.min(...v), max: Math.max(...v) };
}

/** minimal single-band field, domain and grid free */
function band(index: number, domain: number, n: number, h0res: number) {
  const p = oceanParams;
  const b = cascadeBand(index, p.splitWavelengths);
  const h0 = extractCentralBlock(generateH0(h0res, domain, 1337 + index * 7919, p, b), h0res, n);
  const size = n * n;
  const kxN = new Float32Array(size);
  const kzN = new Float32Array(size);
  const om = new Float32Array(size);
  for (let m = 0; m < n; m++) {
    for (let q = 0; q < n; q++) {
      const kx = (2 * Math.PI * (q - n / 2)) / domain;
      const kz = (2 * Math.PI * (m - n / 2)) / domain;
      const k = Math.hypot(kx, kz);
      const s = Math.max(k, 1e-6);
      const i = m * n + q;
      kxN[i] = kx / s;
      kzN[i] = kz / s;
      om[i] = Math.sqrt(9.81 * k);
    }
  }
  const bf = generateButterfly(n);
  const a = { re: new Float32Array(size), im: new Float32Array(size) };
  const bb = { re: new Float32Array(size), im: new Float32Array(size) };
  const dx = new Float32Array(size);
  const dz = new Float32Array(size);
  const lam = new Float32Array(size);
  const cell = domain / n;
  return {
    domain,
    n,
    cell,
    jacobianRms: spectralJacobianRms(h0res, domain, p, b),
    heightVariance: spectralHeightVariance(h0res, domain, p, b),
    lam,
    evolve(time: number, lambda: number) {
      for (let i = 0; i < size; i++) {
        const ph = om[i] * time;
        const c = Math.cos(ph);
        const s = Math.sin(ph);
        const r0 = h0[i * 4];
        const i0 = h0[i * 4 + 1];
        const r1 = h0[i * 4 + 2];
        const i1 = h0[i * 4 + 3];
        const hRe = (r0 + r1) * c - (i0 + i1) * s;
        const hIm = (r0 - r1) * s + (i0 - i1) * c;
        a.re[i] = hRe * (1 - kxN[i]);
        a.im[i] = hIm * (1 - kxN[i]);
        bb.re[i] = -hIm * kzN[i];
        bb.im[i] = hRe * kzN[i];
      }
      cpuIFFT2D(a, bf, n);
      cpuIFFT2D(bb, bf, n);
      for (let m = 0; m < n; m++) {
        for (let x = 0; x < n; x++) {
          const i = m * n + x;
          const sg = (x + m) & 1 ? -1 : 1;
          dx[i] = sg * a.im[i] * lambda;
          dz[i] = sg * bb.re[i] * lambda;
        }
      }
      for (let m = 0; m < n; m++) {
        for (let q = 0; q < n; q++) {
          const i = m * n + q;
          const ax = (dx[m * n + wrapIndex(q + 1, n)] - dx[m * n + wrapIndex(q - 1, n)]) / (2 * cell);
          const bz = (dz[wrapIndex(m + 1, n) * n + q] - dz[wrapIndex(m - 1, n) * n + q]) / (2 * cell);
          const az = (dx[wrapIndex(m + 1, n) * n + q] - dx[wrapIndex(m - 1, n) * n + q]) / (2 * cell);
          lam[i] = minEigenvalue(2 + ax + bz, (1 + ax) * (1 + bz) - az * az);
        }
      }
    },
  };
}

function componentCount(f: Float32Array, n: number): number {
  const seen = new Uint8Array(n * n);
  const stack: number[] = [];
  let cnt = 0;
  for (let i = 0; i < n * n; i++) {
    if (seen[i] || f[i] <= 0) continue;
    cnt++;
    stack.length = 0;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const q = stack.pop() as number;
      const y = (q / n) | 0;
      const x = q % n;
      for (const t of [
        y * n + wrapIndex(x + 1, n),
        y * n + wrapIndex(x - 1, n),
        wrapIndex(y + 1, n) * n + x,
        wrapIndex(y - 1, n) * n + x,
      ]) if (!seen[t] && f[t] > 0) { seen[t] = 1; stack.push(t); }
    }
  }
  return cnt;
}

describe('SCRATCH 3: root cause', () => {
  maybe('same band, bigger domain', () => {
    /* eslint-disable no-console */
    const p = oceanParams;
    console.log('\n=== CASCADE 1 (band 8.3-40 m), SAME cell size, WIDER TILE ===');
    console.log('domain  wavelengths  N     cell    fired%   firedCV  caps    capCV  injCV');
    // sea-wide moments held at the SHIPPED sea so the gate does not move
    const shipped = [0, 1, 2].map((i) => ({
      j: spectralJacobianRms(p.resolution, p.cascades[i].domain, p, cascadeBand(i, p.splitWavelengths)),
      h: spectralHeightVariance(p.resolution, p.cascades[i].domain, p, cascadeBand(i, p.splitWavelengths)),
    }));
    const seaJ = Math.sqrt(shipped.reduce((a, b) => a + b.j * b.j, 0));
    const lambda = effectiveChoppiness(p.choppiness, seaJ, p.choppinessFoldLimit);
    const seaSigma = jacobianSigma(seaJ, lambda);
    const windScale = whitecapWindScale(p.windSpeed, foamParams.whitecapWindRef);

    for (const [domain, n, h0res] of [[98, 256, 512], [196, 512, 512], [392, 1024, 1024]] as const) {
      const b = band(1, domain, n, h0res);
      const texel = foamTexelMetres(domain, p.resolution);
      const oct = breakupOctaves(foamParams.breakupMetres, texel);
      const bandSigma = jacobianSigma(b.jacobianRms, lambda);
      const ss = metricSigmaScale(foamParams.crestBiasSigma, foamParams.breakupSigma, oct);
      const gate = eigenFoamGate(p.jacobianFoamBias, b.jacobianRms, lambda, bandSigma, seaSigma, ss);
      const perStep = eigenInjectPerStep(
        foamParams.injectStrength * windScale, SIM_DT, b.jacobianRms, lambda, bandSigma, seaSigma, ss,
      );
      const amp = foamParams.breakupSigma * eigenSigma(b.jacobianRms, lambda);
      const kMax = cascadeBand(1, p.splitWavelengths).kMax;
      const tr = tensorRadiusTexels((2 * Math.PI) / kMax, texel);
      const out = new Float32Array(n * n);
      const fired: number[] = [];
      const caps: number[] = [];
      const inj: number[] = [];
      const steps = 60;
      for (let s = 0; s < steps; s++) {
        const t = s * 1.0;
        b.evolve(t, lambda);
        let f = 0;
        let sum = 0;
        for (let m = 0; m < n; m++) {
          for (let q = 0; q < n; q++) {
            const i = m * n + q;
            const wx = (q + 0.5) * b.cell;
            const wz = (m + 0.5) * b.cell;
            let metric = b.lam[i];
            if (oct > 0) {
              // isotropic frame here: the crest tensor needs dh, which this
              // reduced band does not carry. STATED — it changes cap SHAPE,
              // not the count statistic this test is about.
              metric += amp * breakupJitterAligned(
                wx, wz, crestFrame(1, 0, 0), foamParams.breakupElongation,
                1 / Math.max(0.5, foamParams.breakupMetres), foamParams.breakupWarp, oct, t * 0.013,
              );
            }
            const v = Math.max(0, gate - metric) * perStep;
            out[i] = v;
            if (v > 0) f++;
            sum += v;
          }
        }
        fired.push(f / (n * n));
        inj.push(sum / (n * n));
        caps.push(componentCount(out, n));
      }
      const sf = st(fired);
      const sca = st(caps);
      console.log(
        `${String(domain).padEnd(7)} ${(domain / 40).toFixed(1).padEnd(12)} ` +
        `${String(n).padEnd(5)} ${b.cell.toFixed(3).padEnd(7)} ` +
        `${(100 * sf.mean).toFixed(3)}%   ${sf.cv.toFixed(3)}    ` +
        `${sca.mean.toFixed(0).padEnd(7)} ${sca.cv.toFixed(3)}  ${st(inj).cv.toFixed(3)}`,
      );
    }
    console.log('(wavelengths = domain / the band\'s LONGEST wave, 40 m — the mode count at');
    console.log(' the energetic end of the band is what decides whether the tile is stationary)');
    expect(true).toBe(true);
    /* eslint-enable no-console */
  }, 3600_000);
});
