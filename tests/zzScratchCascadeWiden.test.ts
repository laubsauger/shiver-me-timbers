/**
 * SCRATCH — the widening trade. Gated on CASCADE_WIDEN=1, skipped otherwise.
 *
 * Phase 1: what a wider domain COSTS at fixed 512² — band moments truncate at
 *          the grid's own Nyquist, so the moment functions measure it directly.
 * Phase 2: what it BUYS — injection/fired/cap statistics at the REAL cell size
 *          (scratch 3 held the cell fixed by growing N; the ship cannot).
 * Phase 3: composite coverage time series through the accumulator + its period.
 */
import { describe, expect, it } from 'vitest';
import {
  breakupJitterAligned,
  breakupOctaves,
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
import { oceanParams, type OceanParams } from '../src/params/ocean';
import {
  cascadeBand,
  effectiveChoppiness,
  generateButterfly,
  generateH0,
  spectralHeightVariance,
  spectralJacobianRms,
  spectralMeanWavenumber,
  spectralSteepness,
  slopeResolutionFootprint,
  slopeVarianceTotal,
  slopeWavelengthHistogram,
} from '../src/ocean/oceanMath';
import { cpuIFFT2D, extractCentralBlock } from '../src/sea-physics/cpuOcean';
import { SIM_DT } from '../src/core/loop';

const RUN = process.env.CASCADE_WIDEN === '1';
const maybe = RUN ? it : it.skip;

function st(v: number[]) {
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  return { mean, sd, cv: mean > 0 ? sd / mean : NaN, min: Math.min(...v), max: Math.max(...v) };
}

/** candidate cascade geometries — [c0, c1, c2] domains + split wavelengths */
interface Cfg {
  name: string;
  d: [number, number, number];
  split: [number, number];
}

const CFGS: Cfg[] = [
  { name: 'shipped', d: [1010, 98, 22.7], split: [40, 8.3] },
  { name: 'c1x2', d: [1010, 196, 22.7], split: [40, 8.3] },
  { name: 'c1-175', d: [1010, 175, 22.7], split: [40, 8.3] },
  { name: 'c1x2.55', d: [1010, 250, 22.7], split: [40, 8.3] },
  { name: 'c1x4', d: [1010, 392, 22.7], split: [40, 8.3] },
  { name: 'c2x3', d: [1010, 98, 68], split: [40, 8.3] },
  { name: 'c2x4', d: [1010, 98, 90.8], split: [40, 8.3] },
  { name: 'both196', d: [1010, 196, 90.8], split: [40, 8.3] },
  { name: 'both', d: [1010, 250, 90.8], split: [40, 8.3] },
  { name: 'both-wide', d: [1010, 392, 90.8], split: [40, 8.3] },
  // the PROPOSAL: every §V.8 guard intact, mirror samples/λ 2.59 vs cascade
  // 0's already-shipped 2.53
  { name: 'proposal', d: [1010, 205, 91], split: [40, 8.3] },
  // the aggressive re-split: buys W1 = 8.25 by moving 8.3–11 m OUT of the
  // mirrored band, i.e. off the ship. Measured so the cost is on the record.
  { name: 'resplit', d: [1010, 330, 100], split: [40, 11] },
  // research-abyssal-ocean §3.1 lever B — W2 raised by LOWERING the band edge
  // at a completely fixed domain/texel/Nyquist. Every one of these keeps
  // `cascades` bit-identical to shipped, so the ONLY thing that moves is which
  // cascade owns the 5–8.3 m octave.
  { name: 'split-6', d: [1010, 98, 22.7], split: [40, 6] },
  { name: 'split-5', d: [1010, 98, 22.7], split: [40, 5] },
  { name: 'split-4', d: [1010, 98, 22.7], split: [40, 4] },
  // lever A as a free rider on lever B (it FAILS §V.59 on its own at 8.3)
  { name: 'split-5+A33', d: [1010, 98, 22.7], split: [33, 5] },
];

function withCfg(c: Cfg): OceanParams {
  return {
    ...oceanParams,
    cascades: [{ domain: c.d[0] }, { domain: c.d[1] }, { domain: c.d[2] }],
    splitWavelengths: c.split,
  };
}

describe('SCRATCH: cascade widening trade', () => {
  maybe('phase 1 — spectral cost of a coarser cell at fixed 512', () => {
    /* eslint-disable no-console */
    const base = oceanParams;
    console.log('\n=== PER-BAND MOMENTS (N=512). σh in m, σJ = jacobian RMS ===');
    console.log(
      'cfg          band  domain  cell    nyqλ    λmin/cell  W(tile/λmax)  σh       σJ       σsteep   kmean',
    );
    for (const c of CFGS) {
      const p = withCfg(c);
      for (let i = 0; i < 3; i++) {
        const b = cascadeBand(i, p.splitWavelengths);
        const D = p.cascades[i].domain;
        const cell = D / p.resolution;
        const nyq = 2 * cell;
        // shortest wave the band ASKS for, vs what the grid can hold
        const asked = Number.isFinite(b.kMax) ? (2 * Math.PI) / b.kMax : nyq;
        const shortest = Math.max(asked, nyq);
        // longest wave the band holds, for the tile-repeat count
        const longest = b.kMin > 0 ? (2 * Math.PI) / b.kMin : 189; // swell λ for c0
        console.log(
          `${c.name.padEnd(12)} ${i}     ${String(D).padEnd(7)} ${cell.toFixed(3).padEnd(7)} ` +
            `${nyq.toFixed(3).padEnd(7)} ${(shortest / cell).toFixed(1).padEnd(10)} ` +
            `${(D / longest).toFixed(1).padEnd(13)} ` +
            `${Math.sqrt(spectralHeightVariance(p.resolution, D, p, b)).toFixed(4).padEnd(8)} ` +
            `${spectralJacobianRms(p.resolution, D, p, b).toFixed(5).padEnd(8)} ` +
            `${spectralSteepness(p.resolution, D, p, b).toFixed(5).padEnd(8)} ` +
            `${spectralMeanWavenumber(p.resolution, D, p, b).toFixed(4)}`,
        );
      }
      // sea-wide aggregates: what every downstream calibration reads
      let hv = 0;
      let jv = 0;
      for (let i = 0; i < 3; i++) {
        const b = cascadeBand(i, p.splitWavelengths);
        hv += spectralHeightVariance(p.resolution, p.cascades[i].domain, p, b);
        const j = spectralJacobianRms(p.resolution, p.cascades[i].domain, p, b);
        jv += j * j;
      }
      const seaJ = Math.sqrt(jv);
      const lambda = effectiveChoppiness(p.choppiness, seaJ, p.choppinessFoldLimit);
      console.log(
        `  -> Hs=${(4 * Math.sqrt(hv)).toFixed(4)} m  seaJacobianRms=${seaJ.toFixed(5)}  ` +
          `effChoppiness=${lambda.toFixed(5)}  seaSigma=${jacobianSigma(seaJ, lambda).toFixed(5)}\n`,
      );
    }
    expect(true).toBe(true);
    /* eslint-enable no-console */
  }, 3600_000);
});

/** one band's reduced field at the REAL foam grid (n = ocean resolution) */
function bandField(p: OceanParams, index: number, n: number) {
  const b = cascadeBand(index, p.splitWavelengths);
  const domain = p.cascades[index].domain;
  const h0 = extractCentralBlock(
    generateH0(p.resolution, domain, 1337 + index * 7919, p, b), p.resolution, n,
  );
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
    index,
    domain,
    n,
    cell,
    jacobianRms: spectralJacobianRms(p.resolution, domain, p, b),
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

/* ---------------------------------------------------------------------------
 * PHASE 4 — the §V.8 cost. The mirror's grid VALUES are exact (the ctor
 * guarantees every band mode is inside the reduced grid); all the error is
 * BETWEEN nodes, and it is a function of samples-per-shortest-wave, which is
 * exactly what a wider domain at a fixed 64² mirror spends. §B.34 measured
 * bilinear at 0.582 m RMS on a σ=1 m sea at 2.53 samples/λ and answered it
 * with Catmull-Rom; this measures what Catmull-Rom itself costs as that
 * number falls further.
 * ------------------------------------------------------------------------- */

/** Catmull-Rom on a wrapped n×n grid, node i at x = i·domain/n */
function catrom(grid: Float32Array, n: number, domain: number, x: number, z: number): number {
  const u = (x / domain) * n;
  const v = (z / domain) * n;
  const iu = Math.floor(u);
  const iv = Math.floor(v);
  const fu = u - iu;
  const fv = v - iv;
  const w = (t: number) => [
    -0.5 * t * (1 - t) * (1 - t),
    1 + t * t * (1.5 * t - 2.5),
    t * (0.5 + t * (2 - 1.5 * t)),
    0.5 * t * t * (t - 1),
  ];
  const wu = w(fu);
  const wv = w(fv);
  let acc = 0;
  for (let j = 0; j < 4; j++) {
    const zz = (((iv + j - 1) % n) + n) % n;
    let row = 0;
    for (let i = 0; i < 4; i++) {
      const xx = (((iu + i - 1) % n) + n) % n;
      row += wu[i] * grid[zz * n + xx];
    }
    acc += wv[j] * row;
  }
  return acc;
}

/** height grid of one band at grid size n over `domain`, mirror packing */
function heightGrid(p: OceanParams, index: number, domain: number, n: number, time: number) {
  const b = cascadeBand(index, p.splitWavelengths);
  const h0 = extractCentralBlock(
    generateH0(p.resolution, domain, 1337 + index * 7919, p, b), p.resolution, n,
  );
  const size = n * n;
  const a = { re: new Float32Array(size), im: new Float32Array(size) };
  for (let m = 0; m < n; m++) {
    for (let q = 0; q < n; q++) {
      const kx = (2 * Math.PI * (q - n / 2)) / domain;
      const kz = (2 * Math.PI * (m - n / 2)) / domain;
      const k = Math.hypot(kx, kz);
      const kxN = kx / Math.max(k, 1e-6);
      const i = m * n + q;
      const ph = Math.sqrt(9.81 * k) * time;
      const c = Math.cos(ph);
      const s = Math.sin(ph);
      const r0 = h0[i * 4];
      const i0 = h0[i * 4 + 1];
      const r1 = h0[i * 4 + 2];
      const i1 = h0[i * 4 + 3];
      const hRe = (r0 + r1) * c - (i0 + i1) * s;
      const hIm = (r0 - r1) * s + (i0 - i1) * c;
      a.re[i] = hRe * (1 - kxN);
      a.im[i] = hIm * (1 - kxN);
    }
  }
  cpuIFFT2D(a, generateButterfly(n), n);
  const h = new Float32Array(size);
  for (let m = 0; m < n; m++) {
    for (let q = 0; q < n; q++) {
      const i = m * n + q;
      h[i] = ((q + m) & 1 ? -1 : 1) * a.re[i];
    }
  }
  return h;
}

describe('SCRATCH: §V.8 mirror reconstruction cost', () => {
  maybe('phase 4 — Catmull-Rom error vs samples per shortest wave', () => {
    /* eslint-disable no-console */
    const p = oceanParams;
    const REF = 512;
    const redN = 64;
    console.log('\n=== MIRROR RECONSTRUCTION ERROR (64² Catmull-Rom vs 512² reference) ===');
    console.log('band  domain  mirrorCell  shortest λ  samples/λ   σh(m)    rmsErr(m)  err/σ   maxErr(m)');
    const cases: Array<[number, number]> = [
      [0, 1010], // the SHIPPED precedent (§B.34): 2.53 samples/λ, cubic answered it
      [1, 98], [1, 147], [1, 196], [1, 250],
    ];
    for (const [idx, domain] of cases) {
      const b = cascadeBand(idx, p.splitWavelengths);
      const shortest = (2 * Math.PI) / b.kMax;
      const kEdge = (Math.PI * redN) / domain;
      const fits = b.kMax < kEdge;
      const coarse = heightGrid(p, idx, domain, redN, 31.7);
      const fine = heightGrid(p, idx, domain, REF, 31.7);
      let se = 0;
      let sv = 0;
      let mx = 0;
      const S = 20000;
      let seed = 12345;
      const rnd = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      for (let i = 0; i < S; i++) {
        const x = rnd() * domain;
        const z = rnd() * domain;
        const a = catrom(coarse, redN, domain, x, z);
        const r = catrom(fine, REF, domain, x, z);
        se += (a - r) ** 2;
        sv += r * r;
        mx = Math.max(mx, Math.abs(a - r));
      }
      const rms = Math.sqrt(se / S);
      const sigma = Math.sqrt(sv / S);
      console.log(
        `${idx}     ${String(domain).padEnd(7)} ${(domain / redN).toFixed(3).padEnd(11)} ` +
          `${shortest.toFixed(1).padEnd(11)} ${(shortest / (domain / redN)).toFixed(2).padEnd(11)} ` +
          `${sigma.toFixed(4).padEnd(8)} ${rms.toFixed(4).padEnd(10)} ` +
          `${(rms / sigma).toFixed(4).padEnd(7)} ${mx.toFixed(4)}` +
          (fits ? '' : '   << band does NOT fit the mirror grid (ctor throws)'),
      );
    }
    expect(true).toBe(true);
    /* eslint-enable no-console */
  }, 3600_000);

  maybe('phase 5 — which downstream calibrations move', () => {
    /* eslint-disable no-console */
    console.log('\n=== DOWNSTREAM CONSUMERS ===');
    console.log(
      'cfg          band  texel   octaves  tensorR  slopeVar   slopeFoot(m)  kmean    foamGate  injPerStep',
    );
    for (const c of CFGS) {
      const p = withCfg(c);
      let jv = 0;
      for (let i = 0; i < 3; i++) {
        const j = spectralJacobianRms(
          p.resolution, p.cascades[i].domain, p, cascadeBand(i, p.splitWavelengths),
        );
        jv += j * j;
      }
      const seaJ = Math.sqrt(jv);
      const lambda = effectiveChoppiness(p.choppiness, seaJ, p.choppinessFoldLimit);
      const seaSigma = jacobianSigma(seaJ, lambda);
      const windScale = whitecapWindScale(p.windSpeed, foamParams.whitecapWindRef);
      for (let i = 0; i < 3; i++) {
        const b = cascadeBand(i, p.splitWavelengths);
        const D = p.cascades[i].domain;
        const texel = foamTexelMetres(D, p.resolution);
        const oct = breakupOctaves(foamParams.breakupMetres, texel);
        const jr = spectralJacobianRms(p.resolution, D, p, b);
        const bandSigma = jacobianSigma(jr, lambda);
        const ss = metricSigmaScale(foamParams.crestBiasSigma, foamParams.breakupSigma, oct);
        const bins = slopeWavelengthHistogram(p.resolution, D, p, b);
        console.log(
          `${c.name.padEnd(12)} ${i}     ${texel.toFixed(3).padEnd(7)} ${String(oct).padEnd(8)} ` +
            `${tensorRadiusTexels(Number.isFinite(b.kMax) ? (2 * Math.PI) / b.kMax : 0, texel).toFixed(1).padEnd(8)} ` +
            `${slopeVarianceTotal(bins).toFixed(5).padEnd(10)} ` +
            `${slopeResolutionFootprint(bins, 0.9).toFixed(3).padEnd(13)} ` +
            `${spectralMeanWavenumber(p.resolution, D, p, b).toFixed(4).padEnd(8)} ` +
            `${eigenFoamGate(p.jacobianFoamBias, jr, lambda, bandSigma, seaSigma, ss).toFixed(5).padEnd(9)} ` +
            `${eigenInjectPerStep(foamParams.injectStrength * windScale, SIM_DT, jr, lambda, bandSigma, seaSigma, ss).toFixed(6)}`,
        );
      }
      console.log('');
    }
    expect(true).toBe(true);
    /* eslint-enable no-console */
  }, 3600_000);
});

/** wrap-sample a per-lane field at a world point */
function sampleWrap(f: Float32Array, domain: number, n: number, wx: number, wz: number): number {
  const cell = domain / n;
  const x = ((Math.floor(wx / cell) % n) + n) % n;
  const m = ((Math.floor(wz / cell) % n) + n) % n;
  return f[m * n + x];
}

describe('SCRATCH: composite coverage time series', () => {
  maybe('phase 2/3 — injection + accumulated coverage per config', () => {
    /* eslint-disable no-console */
    const N = Number(process.env.CW_N ?? 256);
    const STEPS = Number(process.env.CW_STEPS ?? 400);
    const DT = Number(process.env.CW_DT ?? 0.25); // s between samples
    const only = process.env.CW_ONLY;
    const list = only ? CFGS.filter((c) => only.split(',').includes(c.name)) : CFGS;
    console.log(`\n=== ACCUMULATED COMPOSITE COVERAGE (n=${N}, ${STEPS} steps @ ${DT}s) ===`);
    console.log(
      'cfg          cov%mean  cov%min  cov%max  covCV  peak/trough  inj1CV  inj2CV  period(s)  densMean  densCV',
    );
    /**
     * §V.36: `jacobianFoamBias` is an ABSOLUTE threshold DOCUMENTED as a
     * σ-multiple, so any change to the spectrum's moments moves what it means.
     * With CW_HOLDZ=1 the bias is re-derived per config to hold the shipped
     * z, which is the only way to compare SYNCHRONY without the comparison
     * being confounded by a coverage mean that moved underneath it.
     */
    const holdZ = process.env.CW_HOLDZ === '1';
    const seaSigmaOf = (p: OceanParams) => {
      let jv = 0;
      for (let i = 0; i < 3; i++) {
        const j = spectralJacobianRms(
          p.resolution, p.cascades[i].domain, p, cascadeBand(i, p.splitWavelengths),
        );
        jv += j * j;
      }
      const sj = Math.sqrt(jv);
      return jacobianSigma(sj, effectiveChoppiness(
        oceanParams.choppiness, sj, oceanParams.choppinessFoldLimit,
      ));
    };
    const zShipped = (1 - oceanParams.jacobianFoamBias) / seaSigmaOf(oceanParams);
    if (holdZ) console.log(`(bias re-derived per config to hold z = ${zShipped.toFixed(4)}σ)`);

    for (const c of list) {
      const p = withCfg(c);
      if (holdZ) p.jacobianFoamBias = 1 - zShipped * seaSigmaOf(p);
      // sea-wide moments from the CONFIG (the gate is σ-relative, §V.36)
      let jv = 0;
      for (let i = 0; i < 3; i++) {
        const j = spectralJacobianRms(
          p.resolution, p.cascades[i].domain, p, cascadeBand(i, p.splitWavelengths),
        );
        jv += j * j;
      }
      const seaJ = Math.sqrt(jv);
      const lambda = effectiveChoppiness(p.choppiness, seaJ, p.choppinessFoldLimit);
      const seaSigma = jacobianSigma(seaJ, lambda);
      const windScale = whitecapWindScale(p.windSpeed, foamParams.whitecapWindRef);

      const lanes = [0, 1, 2].map((i) => {
        const f = bandField(p, i, N);
        const texel = foamTexelMetres(p.cascades[i].domain, p.resolution);
        const oct = breakupOctaves(foamParams.breakupMetres, texel);
        const bandSigma = jacobianSigma(f.jacobianRms, lambda);
        const ss = metricSigmaScale(foamParams.crestBiasSigma, foamParams.breakupSigma, oct);
        return {
          f,
          oct,
          gate: eigenFoamGate(p.jacobianFoamBias, f.jacobianRms, lambda, bandSigma, seaSigma, ss),
          perStep: eigenInjectPerStep(
            foamParams.injectStrength * windScale, SIM_DT, f.jacobianRms, lambda,
            bandSigma, seaSigma, ss,
          ),
          amp: foamParams.breakupSigma * eigenSigma(f.jacobianRms, lambda),
          acc: new Float32Array(N * N),
        };
      });
      // decay per SIM step, applied over DT of wall time
      const decay = Math.pow(decayFactorPerFrame(foamParams.decayHalfLife, SIM_DT), DT / SIM_DT);
      const stepsPerSample = DT / SIM_DT;
      const ceiling = foamParams.foamAccumMax;

      const cov: number[] = [];
      const dens: number[] = [];
      const inj: number[][] = [[], [], []];
      for (let s = 0; s < STEPS; s++) {
        const t = s * DT;
        for (const l of lanes) {
          l.f.evolve(t, lambda);
          let sum = 0;
          for (let m = 0; m < N; m++) {
            for (let q = 0; q < N; q++) {
              const i = m * N + q;
              let metric = l.f.lam[i];
              if (l.oct > 0) {
                metric += l.amp * breakupJitterAligned(
                  (q + 0.5) * l.f.cell, (m + 0.5) * l.f.cell, crestFrame(1, 0, 0),
                  foamParams.breakupElongation, 1 / Math.max(0.5, foamParams.breakupMetres),
                  foamParams.breakupWarp, l.oct, t * 0.013,
                );
              }
              const v = Math.max(0, l.gate - metric) * l.perStep * stepsPerSample;
              sum += v;
              l.acc[i] = Math.min(ceiling, l.acc[i] * decay + v);
            }
          }
          inj[l.f.index].push(sum / (N * N));
        }
        // composite coverage on a 400 m patch of WORLD, all three lanes summed
        // exactly as shadingNode does: each lane wrapped at its own domain
        const PATCH = 400;
        const G = 400;
        const THRESH = Number(process.env.CW_THRESH ?? 0.5);
        let covered = 0;
        let mass = 0;
        for (let m = 0; m < G; m++) {
          for (let q = 0; q < G; q++) {
            const wx = ((q + 0.5) * PATCH) / G;
            const wz = ((m + 0.5) * PATCH) / G;
            let f = 0;
            for (const l of lanes) {
              f += sampleWrap(l.acc, l.f.domain, N, wx, wz);
            }
            if (f > THRESH) covered++;
            mass += f;
          }
        }
        cov.push(covered / (G * G));
        dens.push(mass / (G * G));
      }
      // dominant period of the coverage series, after the accumulator settles
      const warm = Math.floor(STEPS / 4);
      const series = cov.slice(warm);
      const mean = series.reduce((a, b) => a + b, 0) / series.length;
      let bestP = 0;
      let bestPow = 0;
      for (let k = 1; k <= series.length / 4; k++) {
        const period = (series.length * DT) / k;
        if (period < 2 || period > 200) continue;
        let re = 0;
        let im = 0;
        for (let i = 0; i < series.length; i++) {
          const ph = (2 * Math.PI * k * i) / series.length;
          re += (series[i] - mean) * Math.cos(ph);
          im += (series[i] - mean) * Math.sin(ph);
        }
        const pow = re * re + im * im;
        if (pow > bestPow) {
          bestPow = pow;
          bestP = period;
        }
      }
      const sc = st(series);
      const sd = st(dens.slice(warm));
      console.log(
        `${c.name.padEnd(12)} ${(100 * sc.mean).toFixed(3).padEnd(9)} ${(100 * sc.min).toFixed(3).padEnd(8)} ` +
          `${(100 * sc.max).toFixed(3).padEnd(8)} ${sc.cv.toFixed(3).padEnd(6)} ` +
          `${(sc.max / Math.max(1e-9, sc.min)).toFixed(1).padEnd(12)} ` +
          `${st(inj[1]).cv.toFixed(3).padEnd(7)} ${st(inj[2]).cv.toFixed(3).padEnd(7)} ` +
          `${bestP.toFixed(1).padEnd(9)} ` +
          `${sd.mean.toFixed(5).padEnd(9)} ${sd.cv.toFixed(3)}`,
      );
    }
    expect(true).toBe(true);
    /* eslint-enable no-console */
  }, 3600_000);
});
