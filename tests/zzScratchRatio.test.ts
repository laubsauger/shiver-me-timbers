import { describe, expect, it } from 'vitest';
import { oceanParams, type OceanParams } from '../src/params/ocean';
import { oceanSurfaceParams } from '../src/params/oceanSurface';
import { seaPhysicsParams } from '../src/params/seaPhysics';
import { causticsParams } from '../src/params/caustics';
import {
  cascadeBand, effectiveChoppiness, slopeResolutionFootprint,
  slopeWavelengthHistogram, spectralHeightVariance, spectralJacobianRms,
  waveSpectrum,
} from '../src/ocean/oceanMath';
import { jacobianSigma } from '../src/foam/foamMath';
import { weatherPresets } from '../src/weather/presets';

const RUN = process.env.CASCADE_WIDEN === '1';
const maybe = RUN ? it : it.skip;

describe('scratch: §V.59 texel-ratio guard vs cascade-1 domain', () => {
  maybe('sweep', () => {
    /* eslint-disable no-console */
    const keep = oceanSurfaceParams.normalKeepCut;
    const bins = (d: number, i: number) => slopeWavelengthHistogram(
      oceanParams.resolution, d, { ...oceanParams,
        cascades: [{ domain: 1010 }, { domain: d }, { domain: 22.7 }] },
      cascadeBand(i, oceanParams.splitWavelengths),
    );
    const r2 = slopeResolutionFootprint(bins(22.7, 2), keep) / (22.7 / 512);
    console.log('cascade2 footprint/texel =', r2.toFixed(4));
    console.log('D1    foot1(m)  ratio1    |r2/r1-1|   guard(>0.25)');
    for (let d = 98; d <= 260; d += 5) {
      const f1 = slopeResolutionFootprint(bins(d, 1), keep);
      const r1 = f1 / (d / 512);
      const g = Math.abs(r2 / r1 - 1);
      console.log(
        `${String(d).padEnd(5)} ${f1.toFixed(4).padEnd(9)} ${r1.toFixed(4).padEnd(9)} ` +
        `${g.toFixed(4).padEnd(11)} ${g > 0.25 ? 'pass' : 'FAIL'}`,
      );
    }
    expect(true).toBe(true);
    /* eslint-enable no-console */
  }, 600_000);

  /**
   * The SPLIT axis (research-abyssal-ocean §3.1). Domains are pinned, so both
   * bands keep their texel — only the band EDGE moves, which relabels which
   * wavelengths each histogram sees. The domain sweep above failed across a
   * whole band of values because r1 swept THROUGH r2; here there is no sweep
   * of the texel, so this is a single step that either passes or does not.
   */
  maybe('split sweep — §V.59 guard vs splitWavelengths[1]', () => {
    /* eslint-disable no-console */
    const keep = oceanSurfaceParams.normalKeepCut;
    const D = [1010, 98, 22.7];
    const binsFor = (split: [number, number], i: number) => slopeWavelengthHistogram(
      oceanParams.resolution, D[i], { ...oceanParams, splitWavelengths: split },
      cascadeBand(i, split),
    );
    console.log('\nsplit1  foot1(m)  r1       foot2(m)  r2       |r2/r1-1|  guard(>0.25)  W2');
    for (const s1 of [8.3, 8, 7.5, 7, 6.5, 6, 5.5, 5.25, 5, 4.75, 4.5, 4.25, 4, 3.5, 3.167]) {
      const split: [number, number] = [oceanParams.splitWavelengths[0], s1];
      const f1 = slopeResolutionFootprint(binsFor(split, 1), keep);
      const f2 = slopeResolutionFootprint(binsFor(split, 2), keep);
      const r1 = f1 / (D[1] / 512);
      const r2 = f2 / (D[2] / 512);
      const g = Math.abs(r2 / r1 - 1);
      console.log(
        `${String(s1).padEnd(7)} ${f1.toFixed(4).padEnd(9)} ${r1.toFixed(4).padEnd(8)} ` +
        `${f2.toFixed(4).padEnd(9)} ${r2.toFixed(4).padEnd(8)} ` +
        `${g.toFixed(4).padEnd(10)} ${(g > 0.25 ? 'pass' : 'FAIL').padEnd(13)} ` +
        `${(D[2] / s1).toFixed(3)}`,
      );
    }
    // and the free-rider lever A, split[0], with split[1] held at each of the
    // two candidate values
    console.log('\nsplit0  split1  foot1(m)  r1       |r2/r1-1|  guard  W1');
    for (const s1 of [8.3, 5]) {
      const f2 = slopeResolutionFootprint(binsFor([40, s1], 2), keep);
      const r2 = f2 / (D[2] / 512);
      for (const s0 of [40, 37, 35, 33]) {
        const split: [number, number] = [s0, s1];
        const f1 = slopeResolutionFootprint(binsFor(split, 1), keep);
        const r1 = f1 / (D[1] / 512);
        const g = Math.abs(r2 / r1 - 1);
        console.log(
          `${String(s0).padEnd(7)} ${String(s1).padEnd(7)} ${f1.toFixed(4).padEnd(9)} ` +
          `${r1.toFixed(4).padEnd(8)} ${g.toFixed(4).padEnd(10)} ` +
          `${(g > 0.25 ? 'pass' : 'FAIL').padEnd(6)} ${(D[1] / s0).toFixed(3)}`,
        );
      }
    }
    expect(true).toBe(true);
    /* eslint-enable no-console */
  }, 600_000);

  /**
   * The ANALYTIC half of the split audit: every downstream number that is a
   * pure function of the spectrum's moments, so it can be priced without an
   * IFFT. `foldDepth` is here because `tests/caustics.test.ts` re-derives it
   * from the LIVE spectrum and fails outside ±25% — the caustics module now
   * depends on this file and says so.
   */
  maybe('split audit — Hs, gate z, foldDepth, §V.8 caps', () => {
    /* eslint-disable no-console */
    const bend = 1 - 1 / causticsParams.waterIor;
    const redN = seaPhysicsParams.mirrorResolution;
    console.log(
      '\nsplit     Hs(m)    seaJrms  seaSigma  gate z(σ)  σ∇²h     foldDepth(m)  ' +
      'C1 §V.8cap  C1 samp/λ  C1 cubic  C0 §V.8cap',
    );
    for (const s of [[40, 8.3], [40, 6], [40, 5], [40, 4], [33, 5]] as Array<[number, number]>) {
      const p: OceanParams = { ...oceanParams, splitWavelengths: s };
      let hv = 0;
      let jv = 0;
      let m4 = 0;
      for (let i = 0; i < 3; i++) {
        const dom = p.cascades[i].domain;
        const band = cascadeBand(i, s);
        hv += spectralHeightVariance(p.resolution, dom, p, band);
        const j = spectralJacobianRms(p.resolution, dom, p, band);
        jv += j * j;
        const N = p.resolution;
        for (let m = 0; m < N; m++) {
          for (let n = 0; n < N; n++) {
            const kx = (2 * Math.PI * (n - N / 2)) / dom;
            const kz = (2 * Math.PI * (m - N / 2)) / dom;
            const k = Math.hypot(kx, kz);
            if (!(k > band.kMin && k <= band.kMax) || k < 1e-9) continue;
            const amp = Math.sqrt(waveSpectrum(kx, kz, p) / 2) / dom;
            m4 += 2 * amp * amp * k ** 4;
          }
        }
      }
      const seaJ = Math.sqrt(jv);
      const lam = effectiveChoppiness(p.choppiness, seaJ, p.choppinessFoldLimit);
      const sig = jacobianSigma(seaJ, lam);
      const sigmaCurv = Math.sqrt(m4);
      const fold = 1 / (bend * sigmaCurv);
      const c1Short = s[1];
      console.log(
        `${s.join('/').padEnd(9)} ${(4 * Math.sqrt(hv)).toFixed(4).padEnd(8)} ` +
        `${seaJ.toFixed(5).padEnd(8)} ${sig.toFixed(5).padEnd(9)} ` +
        `${((1 - p.jacobianFoamBias) / sig).toFixed(4).padEnd(10)} ` +
        `${sigmaCurv.toFixed(5).padEnd(8)} ${fold.toFixed(4).padEnd(13)} ` +
        `${(32 * c1Short).toFixed(1).padEnd(11)} ` +
        `${((redN * c1Short) / p.cascades[1].domain).toFixed(2).padEnd(10)} ` +
        `${(((redN * c1Short) / p.cascades[1].domain) < 6 ? 'yes' : 'NO').padEnd(9)} ` +
        `${(32 * s[0]).toFixed(1)}`,
      );
    }
    // §V.36's cross-preset contract (tests/foam.test.ts): storm's gate must
    // sit a full σ looser than swell's. Both presets ride the SAME
    // splitWavelengths, so a split change moves both z's and the GAP is what
    // has to survive.
    console.log('\nsplit     preset  bias    σ(trace)  z(σ)     gap(swell−storm)');
    for (const s of [[40, 8.3], [40, 6], [40, 5]] as Array<[number, number]>) {
      const zOf = (name: 'calm' | 'swell' | 'storm', biasOver?: number) => {
        const base: OceanParams = { ...oceanParams, splitWavelengths: s };
        const p: OceanParams = {
          ...base, ...(weatherPresets[name].ocean as Partial<OceanParams>),
        };
        let jv = 0;
        for (let i = 0; i < 3; i++) {
          const j = spectralJacobianRms(
            p.resolution, p.cascades[i].domain, p, cascadeBand(i, s),
          );
          jv += j * j;
        }
        const rms = Math.sqrt(jv);
        const lam = effectiveChoppiness(p.choppiness, rms, p.choppinessFoldLimit);
        const bias = biasOver ?? p.jacobianFoamBias;
        return { bias, sig: jacobianSigma(rms, lam), z: (1 - bias) / jacobianSigma(rms, lam) };
      };
      for (const [name, over] of [
        ['calm', undefined], ['swell', 0.6], ['swell', 0.617], ['swell', 0.632], ['storm', undefined],
      ] as Array<['calm' | 'swell' | 'storm', number | undefined]>) {
        const r = zOf(name, over);
        const gap = name === 'swell' ? r.z - zOf('storm').z : NaN;
        console.log(
          `${s.join('/').padEnd(9)} ${name.padEnd(7)} ${r.bias.toFixed(3).padEnd(7)} ` +
          `${r.sig.toFixed(5).padEnd(9)} ${r.z.toFixed(4).padEnd(8)} ` +
          `${Number.isNaN(gap) ? '' : gap.toFixed(4) + (gap > 1 ? '  pass' : '  FAIL')}`,
        );
      }
    }
    console.log(
      `(shipped foldDepth param = ${causticsParams.foldDepth}, test band ` +
      `${(causticsParams.foldDepth * 0.75).toFixed(4)}–${(causticsParams.foldDepth * 1.25).toFixed(4)} m; ` +
      `C0 domain ${oceanParams.cascades[0].domain} m, C1 domain ${oceanParams.cascades[1].domain} m)`,
    );
    expect(true).toBe(true);
    /* eslint-enable no-console */
  }, 600_000);
});
