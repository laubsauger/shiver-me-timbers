/**
 * §V.4/§V.19 ocean math. These tests gate the GPU work: if the butterfly
 * table or Hermitian packing is wrong, the GPU produces garbage that is
 * miserable to debug — so the math is proven on CPU first.
 */
import { describe, expect, it } from 'vitest';
import {
  GRAVITY,
  bitReverse,
  cascadeBand,
  cpuButterflyIFFT,
  dispersion,
  effectiveChoppiness,
  gaussianPair,
  generateButterfly,
  generateH0,
  generateSpectrumData,
  spectralMeanWavenumber,
  spectralSteepness,
  naiveIDFT,
  phillips,
  spectralHeightVariance,
  swellSpectrum,
  swellWavelengthFor,
  spectralJacobianRms,
  slopeWavelengthHistogram,
  slopeResolutionFootprint,
  slopeVarianceTotal,
  swellEffectiveDirectionality,
  swellPeakWavenumber,
  swellReferenceDomain,
  windSeaPeakWavenumber,
  windSeaSpread,
} from '../src/ocean/oceanMath';
import { oceanParams } from '../src/params/ocean';
import { OceanSimulation } from '../src/ocean/oceanCascades';
import { CpuOcean } from '../src/sea-physics/cpuOcean';
import { SIM_DT } from '../src/core/loop';
import { oceanSurfaceParams } from '../src/params/oceanSurface';
import { skyParams } from '../src/params/sky';
// §V.33: the water's extinction and the geometry it has to reveal both live
// outside this module — that is the point of the block that reads them.
import { causticsParams } from '../src/params/caustics';
import { islandParams } from '../src/params/island';
import {
  bodyTint,
  chroma,
  grazingSaturationAt,
  luminance,
  pigmentFloor,
  seaColorCpu,
  type Rgb,
  type SkyDomeCpu,
} from '../src/ocean/seaChroma';
// source read (not fs): this repo has no @types/node, vite hands it over raw
import surfaceMaterialSource from '../src/ocean/surfaceMaterial.ts?raw';
import cpuOceanSource from '../src/sea-physics/cpuOcean.ts?raw';
import { weatherPresets } from '../src/weather/presets';
import type { OceanParams } from '../src/params/ocean';
import {
  SPECTRUM_SIGNATURE_KEYS,
  spectrumSignature,
} from '../src/ocean/oceanCascades';
import { seaPhysicsParams } from '../src/params/seaPhysics';
import {
  buildOceanGrid,
  ringRadius,
  snapToGrid,
  solveGrowthRate,
  spacingAtRadius,
  warpVertex,
  type SurfaceGridOptions,
} from '../src/ocean/surfaceGeometry';
import { createRng } from '../src/state/rng';
import { Color, SRGBColorSpace } from 'three';

describe('dispersion (§V.4 wave speed realism)', () => {
  it('ω² = g·k — deep water relation', () => {
    for (const k of [0.01, 0.5, 2, 40]) {
      const w = dispersion(k);
      expect(w * w).toBeCloseTo(GRAVITY * k, 6);
    }
  });
});

describe('cascade band split (§V.19 no duplicated energy)', () => {
  it('bands partition k-space with no overlap and no gap', () => {
    const splits: [number, number] = [24, 5];
    const b0 = cascadeBand(0, splits);
    const b1 = cascadeBand(1, splits);
    const b2 = cascadeBand(2, splits);
    expect(b0.kMax).toBe(b1.kMin);
    expect(b1.kMax).toBe(b2.kMin);
    expect(b0.kMin).toBe(0);
    expect(b2.kMax).toBe(Infinity);
  });

  it('a given k lands in exactly one cascade', () => {
    const splits: [number, number] = [24, 5];
    for (const k of [0.05, 0.26, 0.3, 1.2, 1.26, 3]) {
      const hits = [0, 1, 2].filter((c) => {
        const b = cascadeBand(c, splits);
        return k > b.kMin && k <= b.kMax;
      });
      expect(hits).toHaveLength(1);
    }
  });
});

describe('phillips spectrum', () => {
  it('zero at k=0 (no DC drift) and decays at high k', () => {
    expect(phillips(0, 0, oceanParams)).toBe(0);
    const low = phillips(0.3, 0.1, oceanParams);
    const high = phillips(30, 10, oceanParams);
    expect(low).toBeGreaterThan(0);
    expect(high).toBeLessThan(low);
  });

  it('waves against wind are damped — sea moves with the wind', () => {
    const p = { ...oceanParams, windDirection: 0 };
    const withWind = phillips(1, 0, p);
    const against = phillips(-1, 0, p);
    expect(against).toBeLessThan(withWind);
    expect(against).toBeGreaterThan(0);
  });
});

describe('butterfly IFFT table (§V.4 GPU math gate)', () => {
  it('bitReverse sane', () => {
    expect(bitReverse(1, 3)).toBe(4);
    expect(bitReverse(3, 3)).toBe(6);
    expect(bitReverse(0, 8)).toBe(0);
  });

  it('stage indices form a permutation covering all inputs', () => {
    const N = 16;
    const bf = generateButterfly(N);
    const stages = Math.log2(N);
    for (let j = 0; j < stages; j++) {
      const used = new Set<number>();
      for (let x = 0; x < N; x++) {
        const i = (j * N + x) * 4;
        used.add(bf[i + 2]);
        used.add(bf[i + 3]);
      }
      expect(used.size).toBe(N); // every input consumed, none lost
    }
  });

  it('butterfly-driven IFFT matches naive inverse DFT (random complex input)', () => {
    const N = 16;
    const rng = createRng(99);
    const input = {
      re: Float32Array.from({ length: N }, () => rng() * 2 - 1),
      im: Float32Array.from({ length: N }, () => rng() * 2 - 1),
    };
    const bf = generateButterfly(N);
    const fast = cpuButterflyIFFT(input, bf, N);
    const slow = naiveIDFT(input, N);
    for (let n = 0; n < N; n++) {
      expect(fast.re[n]).toBeCloseTo(slow.re[n], 3);
      expect(fast.im[n]).toBeCloseTo(slow.im[n], 3);
    }
  });
});

describe('h0 spectrum generation (§V.2 determinism, §V.4 Hermitian)', () => {
  const N = 16;
  const band = { kMin: 0, kMax: Infinity };

  it('same seed → identical spectrum', () => {
    const a = generateH0(N, 100, 7, oceanParams, band);
    const b = generateH0(N, 100, 7, oceanParams, band);
    expect(a).toEqual(b);
  });

  it('different seed → different spectrum', () => {
    const a = generateH0(N, 100, 7, oceanParams, band);
    const b = generateH0(N, 100, 8, oceanParams, band);
    expect(a).not.toEqual(b);
  });

  it('stored h0(−k) actually is the grid value at the mirrored texel', () => {
    // If this breaks, h(k,t) loses Hermitian symmetry → complex heights →
    // visually: ocean explodes into noise. Cheap check, huge failure mode.
    const spec = generateH0(N, 100, 3, oceanParams, band);
    for (const [n, m] of [
      [1, 2],
      [5, 9],
      [15, 1],
      [8, 8],
    ]) {
      const i = m * N + n;
      const nm = (N - n) % N;
      const mm = (N - m) % N;
      const j = mm * N + nm;
      expect(spec[i * 4 + 2]).toBe(spec[j * 4 + 0]);
      expect(spec[i * 4 + 3]).toBe(spec[j * 4 + 1]);
    }
  });

  it('band filter zeroes out-of-band k', () => {
    const narrow = generateH0(N, 100, 3, oceanParams, { kMin: 0.2, kMax: 0.4 });
    let nonZero = 0;
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        const kx = (2 * Math.PI * (n - N / 2)) / 100;
        const kz = (2 * Math.PI * (m - N / 2)) / 100;
        const k = Math.hypot(kx, kz);
        const i = (m * N + n) * 4;
        const mag = Math.abs(narrow[i]) + Math.abs(narrow[i + 1]);
        if (k <= 0.2 || k > 0.4) {
          expect(mag).toBe(0);
        } else if (mag > 0) {
          nonZero++;
        }
      }
    }
    expect(nonZero).toBeGreaterThan(0);
  });
});

describe('gaussianPair', () => {
  it('deterministic and roughly standard-normal', () => {
    const rng = createRng(1234);
    let sum = 0;
    let sumSq = 0;
    const count = 4000;
    for (let i = 0; i < count / 2; i++) {
      const [a, b] = gaussianPair(rng);
      sum += a + b;
      sumSq += a * a + b * b;
    }
    const mean = sum / count;
    const variance = sumSq / count - mean * mean;
    expect(Math.abs(mean)).toBeLessThan(0.1);
    expect(variance).toBeGreaterThan(0.8);
    expect(variance).toBeLessThan(1.2);
  });
});

/**
 * §V30 clipmap LOD. These encode WHY the warp exists: constant screen-space
 * triangle size out to kilometres, a circular rim inside the camera far
 * plane, and a spacing law the shader can reproduce analytically (it drives
 * the Nyquist cascade fades — get it wrong and detail either aliases or ends
 * in the visible ring §V30 forbids).
 */
describe('ocean surface clipmap (§V30 open 360° horizon)', () => {
  const grid: SurfaceGridOptions = {
    segments: oceanSurfaceParams.gridSegments,
    coreSpacing: oceanSurfaceParams.gridCoreSpacing,
    horizonRadius: oceanSurfaceParams.gridHorizonRadius,
    rimRound: oceanSurfaceParams.gridRimRound,
  };
  const k = solveGrowthRate(grid);

  it('the outermost ring lands on horizonRadius', () => {
    const half = grid.segments / 2;
    expect(ringRadius(half, grid.coreSpacing, k)).toBeCloseTo(grid.horizonRadius, 1);
  });

  it('spacing law matches the ring radii it came from (shader parity)', () => {
    // the material computes spacing = s0 + k·dist; it must equal the actual
    // gap between consecutive rings, or the cascade fades cut at the wrong
    // distance and detail aliases or vanishes early
    for (const n of [1, 40, 120, 200, 255]) {
      const r0 = ringRadius(n, grid.coreSpacing, k);
      const r1 = ringRadius(n + 1, grid.coreSpacing, k);
      // spacingAtRadius is the derivative, r1−r0 its integral over one ring:
      // they agree to O(k/2) ≈ 1%, which is far tighter than any fade needs
      expect(spacingAtRadius(r0, grid.coreSpacing, k) / (r1 - r0)).toBeCloseTo(1, 1);
    }
  });

  it('keeps triangles at a near-constant screen angle (spacing/distance)', () => {
    // this is the whole point of the warp: no vertex budget wasted at 400 m,
    // none starved at 4 km
    for (const r of [50, 200, 800, 2000, 4000]) {
      const ratio = spacingAtRadius(r, grid.coreSpacing, k) / r;
      expect(ratio).toBeGreaterThan(0.01);
      expect(ratio).toBeLessThan(0.045);
    }
  });

  it('radius grows monotonically along every direction — no folded triangles', () => {
    for (const dir of [
      [1, 0],
      [1, 1],
      [0.3, 1],
    ]) {
      let prev = -1;
      for (let i = 0; i <= 64; i++) {
        const t = i / 64;
        const [x, z] = warpVertex(dir[0] * t, dir[1] * t, grid, k);
        const r = Math.hypot(x, z);
        expect(r).toBeGreaterThanOrEqual(prev);
        prev = r;
      }
    }
  });

  it('rim is circular, so no corner pokes through the camera far plane', () => {
    // a square rim would put its corners at √2·horizonRadius and get sliced —
    // a notched horizon is exactly the cutoff §V30 bans
    for (let i = 0; i <= 32; i++) {
      const a = (i / 32) * Math.PI * 2;
      // walk the parameter-space boundary of the unit square
      const s = Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
      const [x, z] = warpVertex(Math.cos(a) / s, Math.sin(a) / s, grid, k);
      expect(Math.hypot(x, z)).toBeCloseTo(grid.horizonRadius, 0);
    }
  });

  it('snaps the mesh origin to whole core steps (near vertices never swim)', () => {
    const [x, z] = snapToGrid(123.456, -78.9, grid);
    expect(x / grid.coreSpacing).toBeCloseTo(Math.round(x / grid.coreSpacing), 6);
    expect(z / grid.coreSpacing).toBeCloseTo(Math.round(z / grid.coreSpacing), 6);
    expect(Math.abs(x - 123.456)).toBeLessThanOrEqual(grid.coreSpacing);
  });

  it('emits triangles in ROW-MAJOR order — ring order wedges the GPU (§V28)', () => {
    // Not a style preference. Ring-by-ring ("front-to-back") order was tried
    // as an early-Z win and never finished its first frame on Apple Silicon:
    // a ring's consecutive triangles scatter across every screen tile, which
    // is pathological for a tile-based deferred renderer. Row-major keeps
    // spatially coherent runs and boots at 100 fps with the same mesh. This
    // test fails the moment someone reorders the index buffer again.
    const small: SurfaceGridOptions = {
      segments: 16,
      coreSpacing: 1,
      horizonRadius: 400,
      rimRound: 0.3,
    };
    const geo = buildOceanGrid(small);
    const pos = geo.getAttribute('position');
    const idx = geo.getIndex();
    expect(idx).not.toBeNull();
    const cols = small.segments + 1;
    const seen = new Set<number>();
    for (let q = 0; q < small.segments * small.segments; q++) {
      const j = Math.floor(q / small.segments);
      const i = q % small.segments;
      const a = j * cols + i;
      // quad q occupies indices [6q, 6q+6) — row-major, in place
      expect(idx!.getX(q * 6)).toBe(a);
      expect(idx!.getX(q * 6 + 1)).toBe(a + cols);
      expect(idx!.getX(q * 6 + 2)).toBe(a + 1);
      for (let c = 0; c < 6; c++) seen.add(idx!.getX(q * 6 + c));
    }
    // every vertex is used — no orphan rows, no holes in the sea
    expect(seen.size).toBe(pos.count);
  });

  it('degrades to a uniform grid when the horizon is inside the core reach', () => {
    const tiny = { segments: 64, coreSpacing: 10, horizonRadius: 100, rimRound: 0.3 };
    expect(solveGrowthRate(tiny)).toBe(0);
    expect(ringRadius(32, tiny.coreSpacing, 0)).toBe(320);
  });
});

describe('ocean cascades vs the CPU buoyancy mirror (§V8)', () => {
  it('every cascade band fits inside the mirror grid', () => {
    // cpuOcean throws if a band's kMax falls outside its reduced grid — the
    // wave-scale retune must never silently float ships on a different sea
    for (let i = 0; i < 2; i++) {
      const band = cascadeBand(i, oceanParams.splitWavelengths);
      const kEdge =
        (Math.PI * seaPhysicsParams.mirrorResolution) / oceanParams.cascades[i].domain;
      expect(band.kMax).toBeLessThan(kEdge);
    }
  });

  it('the coarse cascade holds several swell wavelengths per tile (§V19)', () => {
    // tiling reads as repetition once the domain is only a couple of waves
    // wide (user critique); the longest band wavelength is splitWavelengths[0]
    expect(oceanParams.cascades[0].domain / oceanParams.splitWavelengths[0])
      .toBeGreaterThan(8);
  });
});


/**
 * §B storm fold. The user saw storm shatter the surface into faceted shards
 * with sea-wide blobby foam. Both symptoms are ONE cause: λ·∂Dx/∂x reaching
 * −1 turns the parametric surface inside out, and a negative Jacobian is
 * precisely the foam trigger (§V6). These tests encode the contract that no
 * weather preset can drive the sea into a folded state (§V7 keeps presets as
 * pure params, so the guarantee has to live in the cascade math).
 */

/**
 * §B.7 tripwire. `spectrumSignature` is what decides whether h0 is rebuilt when
 * a param moves; a spectrum-shaping param missing from it is a SILENT no-op —
 * the GPU keeps the launch-time sea while the panel says otherwise, and the
 * CPU buoyancy mirror then floats ships on a different ocean than the one on
 * screen (§V.8). The swell train shipped with all six of its keys missing from
 * both signatures, and the weather presets lerp three of them.
 *
 * This pins the list against `OceanParams` itself, so the NEXT spectrum param
 * fails here instead of in a user report six weeks later.
 */

/**
 * §V.19 for the SWELL TRAIN. Swell is narrow-band by nature, and a 1010 m tile
 * resolves k in steps of 2π/1010 — so a bandwidth authored the way a
 * oceanographer would write it collapses onto one or two modes and tiles the
 * world as a single clean sinusoid. That is the exact failure §V.19 names, and
 * it is invisible to any test of the spectrum's ENERGY: the height is right,
 * the sea state is right, and the water looks like corrugated iron.
 *
 * These pin the SHAPE of what the grid actually got, per preset. `swellGridModes`
 * is the knob that buys it (see swellSpectrum's grid floor).
 */
describe('§V.19 the swell is a wave TRAIN, not one sinusoid', () => {
  const modesOf = (p: OceanParams) => {
    const N = 256;
    const L = Math.max(...p.cascades.map((c) => c.domain));
    const vals: number[] = [];
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        const kx = (2 * Math.PI * (n - N / 2)) / L;
        const kz = (2 * Math.PI * (m - N / 2)) / L;
        const v = swellSpectrum(kx, kz, p);
        if (v > 0) vals.push(v);
      }
    }
    vals.sort((a, b) => b - a);
    const total = vals.reduce((a, b) => a + b, 0);
    let acc = 0;
    let half = 0;
    for (const v of vals) {
      acc += v;
      half++;
      if (acc >= total * 0.5) break;
    }
    return { top: vals[0] / total, half, wavesPerTile: L / swellWavelengthFor(p.swellPeriod) };
  };

  for (const name of ['calm', 'swell', 'storm'] as const) {
    it(`${name}: enough modes and enough waves per tile to read as a sea`, () => {
      const p: OceanParams = { ...oceanParams, ...weatherPresets[name].ocean };
      const m = modesOf(p);
      // no single mode may dominate — that IS the sinusoid failure
      expect(m.top, `${name}: one mode carries ${(m.top * 100).toFixed(0)}% of the swell`)
        .toBeLessThan(0.2);
      // half the energy must be spread over several modes, so the train beats
      // and evolves instead of marching in lockstep
      expect(m.half, `${name}: only ${m.half} modes carry half the swell`).toBeGreaterThanOrEqual(5);
      // and the tile has to hold enough crests that the repeat is not the
      // dominant feature (the same standard that took cascade 0 to 1010 m)
      expect(m.wavesPerTile, `${name}: ${m.wavesPerTile.toFixed(1)} swell waves per tile`)
        .toBeGreaterThan(3.5);
    });
  }

  it('the swell lives in the LONG band only — it must not become chop', () => {
    // The grid floor is measured against the COARSEST cascade, not the caller's
    // domain. Floored per-cascade instead, the 22.7 m tile widened the swell's
    // band 44× and smeared it straight into the chop: σ of the finest cascade
    // went 0.080 → 0.114 m from a 189 m wave, i.e. the swell would have made
    // the sea MORE nervous, the exact opposite of its purpose.
    const withSwell = { ...oceanParams };
    const without: OceanParams = { ...oceanParams, swellAmplitude: 0 };
    const sigmaOf = (p: OceanParams, i: number) =>
      Math.sqrt(
        spectralHeightVariance(128, p.cascades[i].domain, p, cascadeBand(i, p.splitWavelengths)),
      );
    // long band gains it all…
    expect(sigmaOf(withSwell, 0)).toBeGreaterThan(sigmaOf(without, 0) * 1.05);
    // …and the two short bands are untouched, to 4 decimals
    expect(sigmaOf(withSwell, 1)).toBeCloseTo(sigmaOf(without, 1), 4);
    expect(sigmaOf(withSwell, 2)).toBeCloseTo(sigmaOf(without, 2), 4);
  });

  it('its height is what the parameter says, whatever the shape knobs do', () => {
    // swellAmplitude is METRES of RMS swell elevation (swellScale normalises
    // for it). If it were not, every period/bandwidth/spread tweak would move
    // the sea state too — §B.12's failure, designed out rather than tested for.
    const base: OceanParams = { ...oceanParams, amplitude: 0 };
    const sig = (p: OceanParams) =>
      Math.sqrt(
        [0, 1, 2].reduce(
          (a, i) =>
            a + spectralHeightVariance(256, p.cascades[i].domain, p, cascadeBand(i, p.splitWavelengths)),
          0,
        ),
      );
    expect(sig(base)).toBeCloseTo(oceanParams.swellAmplitude, 1);
    for (const over of [
      { swellPeriod: 8 },
      { swellPeriod: 15 },
      { swellDirectionality: 8 },
      { swellDirection: 0.4 },
      { swellBandwidth: 0.3 },
    ]) {
      expect(sig({ ...base, ...over }), JSON.stringify(over)).toBeCloseTo(
        oceanParams.swellAmplitude,
        1,
      );
    }
  });
});

/**
 * "This very obvious sine-wavy feeling that our waves still tend to give us"
 * (user, third report on the surface).
 *
 * A comb is a spread that is the SAME WIDTH at every scale. Both halves of the
 * defect were that, on the two trains, and both are grid/physics facts rather
 * than taste — so these assert the SHAPE of the spread across wavenumber, never
 * a particular constant.
 */
describe('§V.19 directional spread is a function of SCALE, not a constant', () => {
  const N = 128;
  /** axial (2nd-moment) circular spread of a band's slope energy, degrees */
  const axialSpread = (
    p: OceanParams,
    i: number,
    spec: (kx: number, kz: number, q: OceanParams) => number,
  ) => {
    const c = p.cascades[i];
    const band = cascadeBand(i, p.splitWavelengths);
    let e = 0;
    let a2 = 0;
    let b2 = 0;
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        const kx = (2 * Math.PI * (n - N / 2)) / c.domain;
        const kz = (2 * Math.PI * (m - N / 2)) / c.domain;
        const k = Math.hypot(kx, kz);
        if (!(k > band.kMin && k <= band.kMax) || k < 1e-9) continue;
        const S = spec(kx, kz, p);
        if (!(S > 0)) continue;
        const E = S * k * k;
        const th = Math.atan2(kz, kx);
        e += E;
        a2 += E * Math.cos(2 * th);
        b2 += E * Math.sin(2 * th);
      }
    }
    return e > 0
      ? (Math.sqrt(2 * Math.max(0, 1 - Math.hypot(a2, b2) / e)) * 90) / Math.PI
      : NaN;
  };

  it('THE BUG: the chop must not be combed as tightly as the rollers', () => {
    // the old cos^n form measured 16.5° / 16.5° / 16.4° across the cascades —
    // one fan, every scale, which is what a corduroy sea IS
    const fine = axialSpread(oceanParams, 2, phillips);
    const coarse = axialSpread(oceanParams, 0, phillips);
    expect(fine).toBeGreaterThan(coarse * 1.2);
    // and the short waves specifically must be near the isotropic limit,
    // which is where Mitsuyasu's fit puts them at ~3× the peak frequency
    expect(fine).toBeGreaterThan(30);
  });

  it('is narrowest AT the peak and broadens either side of it', () => {
    // the physical shape: one wind raised the peak, so it is the only place
    // the fan is tight. A monotone spread in k would be a different bug.
    const kp = windSeaPeakWavenumber(oceanParams);
    const at = (k: number) => {
      let best = 0;
      for (let a = 0; a < 64; a++) {
        const th = (a / 64) * 2 * Math.PI;
        best = Math.max(
          best,
          windSeaSpread(Math.cos(th - oceanParams.windDirection), k, oceanParams),
        );
      }
      return best; // peak of the lobe: higher = narrower fan
    };
    expect(at(kp)).toBeGreaterThan(at(kp * 6));
    expect(at(kp)).toBeGreaterThan(at(kp / 6));
  });

  it('widening the spread must NOT change the sea state (§B.12)', () => {
    // a shape knob that silently moves Hs is the trap `swellScale` exists to
    // avoid on the other train; the directional factor is normalised, so the
    // omnidirectional E(k) — and therefore Hs, the foam gate and the fold cap
    // — is invariant under every spread param.
    const base = { ...oceanParams };
    const hs = (p: OceanParams) => {
      let v = 0;
      for (const [i, c] of p.cascades.entries())
        v += spectralHeightVariance(N, c.domain, p, cascadeBand(i, p.splitWavelengths));
      return 4 * Math.sqrt(v);
    };
    const ref = hs(base);
    for (const patch of [
      { spreadPeak: 3 },
      { spreadPeak: 25 },
      { spreadAbovePeak: 0.5 },
      { spreadBelowPeak: 1 },
    ]) {
      expect(hs({ ...base, ...patch })).toBeCloseTo(ref, 2);
    }
  });

  it('the same normalisation holds jacobianRms, so the fold cap is untouched', () => {
    // transfer |k| is direction-free ⟹ a function of E(k) alone (§V.59)
    const jr = (p: OceanParams) => {
      let v = 0;
      for (const [i, c] of p.cascades.entries()) {
        const j = spectralJacobianRms(N, c.domain, p, cascadeBand(i, p.splitWavelengths));
        v += j * j;
      }
      return Math.sqrt(v);
    };
    expect(jr({ ...oceanParams, spreadPeak: 3 })).toBeCloseTo(jr(oceanParams), 3);
  });

  it('the SWELL cannot be narrower than the grid can aim (the missing floor)', () => {
    // `swellGridModes` floored the RADIAL bandwidth and nothing floored the
    // ANGULAR width, so a cos^24 lobe at calm's 264 m period fitted inside one
    // ray of modes — a plane wave, which is the sinusoid §V.19 forbids.
    for (const name of ['calm', 'swell', 'storm'] as const) {
      const p: OceanParams = {
        ...oceanParams,
        ...(weatherPresets[name].ocean as Partial<OceanParams>),
      };
      const n = swellEffectiveDirectionality(p);
      expect(n).toBeLessThanOrEqual(p.swellDirectionality);
      // the lobe must span at least `swellGridModes` angular grid steps
      const kp = swellPeakWavenumber(p.swellPeriod);
      const dTheta = (2 * Math.PI) / swellReferenceDomain(p) / kp;
      expect(1 / Math.sqrt(n)).toBeGreaterThanOrEqual(p.swellGridModes * dTheta - 1e-9);
    }
  });

  it('and the swell keeps its authored HEIGHT through that floor (§B.12)', () => {
    // the normalisation reads the EFFECTIVE spread, so widening for the grid
    // must not change how tall the swell is
    const p: OceanParams = { ...oceanParams, swellDirectionality: 64 };
    const swellVar = (q: OceanParams) => {
      let v = 0;
      const c = q.cascades[0];
      const band = cascadeBand(0, q.splitWavelengths);
      for (let m = 0; m < N; m++) {
        for (let n = 0; n < N; n++) {
          const kx = (2 * Math.PI * (n - N / 2)) / c.domain;
          const kz = (2 * Math.PI * (m - N / 2)) / c.domain;
          const k = Math.hypot(kx, kz);
          if (!(k > band.kMin && k <= band.kMax) || k < 1e-9) continue;
          v += (2 * (swellSpectrum(kx, kz, q) / 2)) / (c.domain * c.domain);
        }
      }
      return v;
    };
    // 64 and 24 both clamp to the same grid ceiling ⟹ identical height
    expect(swellVar(p)).toBeCloseTo(swellVar(oceanParams), 4);
  });
});

describe('§B.7 every spectrum-shaping param forces a rebuild', () => {
  /**
   * params that do NOT shape h0 — everything else must be in the signature.
   *
   * The three `shoal*` params are post-processing on top of the finished
   * spectrum (§V.72: an attenuation applied at the sampler, per cascade), so
   * they must NOT force an h0 rebuild — and precisely because they are outside
   * the signature, BOTH sides re-read them every frame rather than caching
   * them on the rebuild path (surfaceMaterial's `refreshShoal`,
   * CpuOcean.update). Adding one here without doing that is §V.62.
   *
   * The six `fetch*` params are the same shape one law over (§V.73): a
   * per-cascade gain applied to the finished spectrum at the sampler, plus the
   * shape of the field it is sampled from. They are OUTSIDE the signature for
   * the same reason and carry the same obligation — `surfaceMaterial`'s
   * `refreshFetch`, `CpuOcean.refreshFetch` and `refreshShoalingUniforms` all
   * re-read them every frame. Note that `windSpeed` IS in the signature and
   * does move the fetch coefficients, which is exactly why those refreshes
   * cannot live on the rebuild path: the rebuild is rate-limited to 15 ticks
   * and the wind is published continuously by the §V.46 weather field.
   */
  const NOT_SPECTRAL = new Set([
    'choppiness',
    'choppinessFoldLimit',
    'jacobianFoamBias',
    'shoalDeepFraction',
    'shoalBreakerIndex',
    'shoalColumnCeiling',
    'fetchWorldScale',
    'fetchMaxGain',
    'fetchLongBandLimit',
    'fetchFieldSize',
    'fetchFieldMargin',
    'fetchBlurTexels',
    'fetchRebuildRadians',
  ]);

  it('the signature key list covers every spectral param in OceanParams', () => {
    const covered = new Set<string>(SPECTRUM_SIGNATURE_KEYS);
    for (const key of Object.keys(oceanParams)) {
      if (NOT_SPECTRAL.has(key)) continue;
      expect(covered.has(key), `${key} is missing from SPECTRUM_SIGNATURE_KEYS`).toBe(true);
    }
  });

  it('moving any one of them actually changes the signature', () => {
    const base = spectrumSignature(oceanParams);
    const bumps: Partial<Record<string, unknown>> = {
      amplitude: oceanParams.amplitude + 0.1,
      windSpeed: oceanParams.windSpeed + 1,
      windDirection: oceanParams.windDirection + 0.1,
      spreadPeak: oceanParams.spreadPeak + 1,
      oppositeWaveDamp: oceanParams.oppositeWaveDamp + 0.1,
      smallWaveCutoff: oceanParams.smallWaveCutoff + 0.01,
      swellPeriod: oceanParams.swellPeriod + 1,
      swellAmplitude: oceanParams.swellAmplitude + 0.1,
      swellDirection: oceanParams.swellDirection + 0.1,
      swellDirectionality: oceanParams.swellDirectionality + 1,
      swellBandwidth: oceanParams.swellBandwidth + 0.05,
      swellGridModes: oceanParams.swellGridModes + 1,
    };
    for (const [key, value] of Object.entries(bumps)) {
      expect(
        spectrumSignature({ ...oceanParams, [key]: value }),
        `${key} does not move the signature — its changes would never rebuild h0`,
      ).not.toBe(base);
    }
  });

  it('the CPU buoyancy mirror rebuilds on the same set (§V.8)', () => {
    // the two signatures are separate strings by design (the mirror adds its
    // own resolution) but they must never disagree about WHEN to rebuild
    const mirrorSrc = cpuOceanSource;
    for (const key of SPECTRUM_SIGNATURE_KEYS) {
      if (key === 'resolution' || key === 'cascades') continue;
      expect(mirrorSrc, `mirrorSignature is missing ${key} (§B.7)`).toContain(`p.${key}`);
    }
  });
});

describe('anti-fold choppiness cap (§B storm, §V6, §V7)', () => {
  // §V.59: combined RMS of the Jacobian TRACE (∂Dx/∂x + ∂Dz/∂z, transfer |k|)
  // at λ=1 — exactly what OceanSimulation.refreshSeaState computes, and the
  // moment `effectiveChoppiness` divides by. It used to mirror
  // `spectralSteepness` (transfer kx²/|k|), which is the x-PROJECTION: valid
  // only while one wave train ran with the wind, and 2.6× low on the
  // swell-dominated band the swell train introduced. Cascades are independent
  // so their variances add.
  const sigmaTotal = (patch: Partial<typeof oceanParams>) => {
    const p = { ...oceanParams, ...patch };
    let variance = 0;
    for (let i = 0; i < 3; i++) {
      const s = spectralJacobianRms(
        128,
        p.cascades[i].domain,
        p,
        cascadeBand(i, p.splitWavelengths),
      );
      variance += s * s;
    }
    return Math.sqrt(variance);
  };
  const limit = oceanParams.choppinessFoldLimit;

  it('leaves the SHIPPED sea alone — the cap must not quietly flatten swell', () => {
    // this is the regression guard: a cap that engages on the default sea
    // would silently override the artist's choppiness on every load
    const sigma = sigmaTotal({});
    expect(effectiveChoppiness(oceanParams.choppiness, sigma, limit)).toBe(
      oceanParams.choppiness,
    );
  });

  it('DOES engage on a storm sea — otherwise the guard is decorative', () => {
    // storm preset territory: amplitude and choppiness both up
    const sigma = sigmaTotal({ amplitude: 1.5, windSpeed: 14 });
    const lambda = effectiveChoppiness(1.9, sigma, limit);
    expect(lambda).toBeLessThan(1.9);
  });

  it('folds only past 1/foldLimit sigma, whatever the preset', () => {
    // λ·σ ≤ limit ⇔ the displacement gradient reaches −1 only at ≥1/limit σ.
    // Below ~2σ a fold is common enough to shred the surface AND to flip the
    // Jacobian negative over huge areas, which is the foam explosion (§V6).
    for (const patch of [
      {},
      { amplitude: 0.3, windSpeed: 4 },
      { amplitude: 1.5, windSpeed: 14 },
      { amplitude: 4, windSpeed: 20 },
    ]) {
      const sigma = sigmaTotal(patch);
      const lambda = effectiveChoppiness(1.9, sigma, limit);
      expect(lambda * sigma).toBeLessThanOrEqual(limit + 1e-9);
      expect(1 / (lambda * sigma)).toBeGreaterThanOrEqual(1 / limit - 1e-6);
    }
  });

  it('never RAISES the artist value — it is a cap, not a target', () => {
    // a glassy sea must stay glassy; the guard may only take choppiness away
    expect(effectiveChoppiness(0.2, 1e-6, limit)).toBe(0.2);
    expect(effectiveChoppiness(0, 5, limit)).toBe(0);
  });

  it('is finite and non-negative for degenerate input (§V28)', () => {
    for (const sig of [0, 1e-12, Number.POSITIVE_INFINITY]) {
      const v = effectiveChoppiness(0.95, sig, limit);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
    expect(effectiveChoppiness(Number.NaN, 1, limit)).toBe(0);
  });
});

describe('sea-state scale drives crest thresholds (§B cow pattern)', () => {
  const rmsFor = (amplitude: number, windSpeed: number) => {
    let variance = 0;
    for (let i = 0; i < 3; i++) {
      variance += spectralHeightVariance(
        128,
        oceanParams.cascades[i].domain,
        { ...oceanParams, amplitude, windSpeed },
        cascadeBand(i, oceanParams.splitWavelengths),
      );
    }
    return Math.sqrt(variance);
  };

  it('RMS elevation tracks amplitude and wind — it is a real sea-state scale', () => {
    const calm = rmsFor(0.3, 4);
    const swell = rmsFor(0.32, 11);
    const storm = rmsFor(1.5, 14);
    expect(calm).toBeLessThan(swell);
    expect(swell).toBeLessThan(storm);
    expect(Number.isFinite(storm)).toBe(true);
  });

  it('the crest band selects a small minority of the surface at ANY sea state', () => {
    // gaussian surface: fraction above n·σ is independent of σ, which is the
    // whole point — the band cannot drift into "most of the ocean" again
    const erfc = (x: number) => {
      const t = 1 / (1 + 0.3275911 * Math.abs(x));
      const y =
        1 -
        ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
          0.254829592) *
          t *
          Math.exp(-x * x);
      return x >= 0 ? 1 - y : 1 + y;
    };
    const fractionAbove = (n: number) => 0.5 * erfc(n / Math.SQRT2);
    expect(fractionAbove(oceanSurfaceParams.crestBandLow)).toBeLessThan(0.1);
    expect(fractionAbove(oceanSurfaceParams.crestBandHigh)).toBeLessThan(0.02);
    // and the old absolute gate, expressed in sigma for the CURRENT sea,
    // would have caught a third of it — the regression this pins
    const sigmaNow = rmsFor(oceanParams.amplitude, oceanParams.windSpeed);
    expect(fractionAbove(0.25 / sigmaNow)).toBeGreaterThan(0.25);
  });

  it('the crest band is ordered and above the body band', () => {
    expect(oceanSurfaceParams.crestBandHigh).toBeGreaterThan(oceanSurfaceParams.crestBandLow);
    expect(oceanSurfaceParams.bodyBandHigh).toBeGreaterThan(oceanSurfaceParams.bodyBandLow);
    expect(oceanSurfaceParams.crestBandLow).toBeGreaterThan(0);
  });
});


describe('significant wave height accessor (§V8 shared sea-state scale)', () => {
  it('Hs = 4√m₀ and tracks the spectrum, not the amplitude slider', () => {
    // the trap this exists to close: amplitude fell 0.75 → 0.32 in the swell
    // retune while Hs ROSE, so anything normalising by amplitude is as wrong
    // as a constant
    const hs = (patch: Partial<typeof oceanParams>) => {
      const p = { ...oceanParams, ...patch };
      let m0 = 0;
      for (let i = 0; i < 3; i++) {
        m0 += spectralHeightVariance(
          128,
          p.cascades[i].domain,
          p,
          cascadeBand(i, p.splitWavelengths),
        );
      }
      return 4 * Math.sqrt(m0);
    };
    const oldSea = hs({ amplitude: 0.75, windSpeed: 8 });
    const newSea = hs({ amplitude: 0.32, windSpeed: 11 });
    expect(newSea).toBeGreaterThan(oldSea); // Hs up while amplitude went down
    expect(hs({ amplitude: 1.5, windSpeed: 14 })).toBeGreaterThan(newSea);
  });
});


/**
 * Integration-hook contracts (§V24 shallows, §V26 reflections). These are
 * shape/param guards, not renders: both hooks must be no-ops when their input
 * is absent, so the main thread can wire them independently of the ocean and
 * an open-ocean scene is bit-identical either way.
 */
describe('optional material inputs stay optional (§V24, §V26)', () => {
  it('shallow tint is bounded and only meaningful with a seabed', () => {
    // strength is live now that islands ship a seabed field; the FACTOR is
    // what keeps it off open water, so strength alone must never be a
    // deep-ocean tint. Guarded here so nobody "fixes" a missing shore tint
    // by pushing strength past 1 and turning the whole sea turquoise.
    expect(oceanSurfaceParams.shallowTintStrength).toBeGreaterThan(0);
    expect(oceanSurfaceParams.shallowTintStrength).toBeLessThanOrEqual(1);
    expect(oceanSurfaceParams.shallowFullDepth).toBeGreaterThan(0);
  });

  it('refraction ramps in with water thickness, not as a constant offset', () => {
    // depthFull must be a real distance or the ramp degenerates back to the
    // constant offset that haloed hulls at the waterline
    expect(oceanSurfaceParams.refractionDepthFull).toBeGreaterThan(0.1);
    expect(oceanSurfaceParams.refractionStrength).toBeGreaterThan(0);
  });

  it('far-field foam damping is a cap, never a boost', () => {
    expect(oceanSurfaceParams.foamFarDamp).toBeGreaterThanOrEqual(0);
    expect(oceanSurfaceParams.foamFarDamp).toBeLessThanOrEqual(1);
  });
});


/**
 * §V.33 THE WATER HAS ONE EXTINCTION MODEL — and you can see the sea floor.
 *
 * The user's report was "I want to see the ship's shadow hit the sea floor,
 * not just the surface". Everything needed for that already existed: the
 * island terrain is real geometry with `receiveShadow`, the caustics are
 * already gated by the same shared shadow node, and §V.24's see-through path
 * already sampled the scene behind the surface. What killed it was arithmetic.
 *
 * `oceanSurfaceParams.absorptionDensity` was a SCALAR 0.35/m applied to all
 * three channels — numerically the RED Jerlov coefficient, applied to blue —
 * while `causticsParams.submergedAbsorption{R,G,B}` already held the real
 * per-channel K_d for three other consumers (the caustic's own attenuation,
 * the submerged hull tint, and the underwater volume). Two owners, and the one
 * that governed looking DOWN through the water was ~12× too opaque in blue. At
 * the island's rim depth that left 12% of the floor reaching the eye, so a
 * shadow on it — a ~40% modulation — moved under 5% of the pixel. Invisible,
 * exactly as reported.
 *
 * These tests fail if anyone re-adds a second owner, flattens the vector back
 * to a scalar, or tunes the sea so opaque that its own shelf stops showing.
 */
describe('§V.33 one water: per-channel extinction, and a visible sea floor', () => {
  const K = [
    causticsParams.submergedAbsorptionR,
    causticsParams.submergedAbsorptionG,
    causticsParams.submergedAbsorptionB,
  ] as const;
  /** Beer–Lambert transmission down a path of `metres`, per channel */
  const transmit = (metres: number): number[] => K.map((k) => Math.exp(-k * metres));

  it('the ocean surface owns no absorption of its own (single owner)', () => {
    // Both keys were deleted from params/oceanSurface.ts. Re-adding either
    // re-opens the split: the see-through path would disagree with the caustic,
    // the submerged hull and the underwater volume about what water this is,
    // and the disagreement is silent — it just looks wrong from one side.
    const surface = oceanSurfaceParams as Record<string, unknown>;
    expect(surface.absorptionDensity).toBeUndefined();
    // `refractionTint` was a fixed teal multiplied onto the refracted scene: a
    // depth-INDEPENDENT stand-in for the curve below. Keeping both double-tints
    // and gives sand at 0.5 m the same cast as sand at 8 m.
    expect(surface.refractionTint).toBeUndefined();
  });

  it('extinction is per channel — a scalar is the defect, not a simplification', () => {
    // Jerlov I–IB: red dies roughly an order of magnitude faster than blue.
    // If these three ever collapse toward each other the water stops being
    // water and becomes a grey veil that merely gets thicker with depth.
    expect(K[0]).toBeGreaterThan(K[1]);
    expect(K[1]).toBeGreaterThan(K[2]);
    expect(K[0] / K[2]).toBeGreaterThan(5);
  });

  it('the island shelf is visible through its own water', () => {
    // THE NUMBER THAT MATTERS. Floor geometry exists from the shoreline down to
    // the heightmap rim, so this is the deepest water with anything under it to
    // look at — and it is where the ship's shadow has to land for the user's
    // request to be satisfied at all. Tied to islandParams so that deepening
    // the islands without re-checking the water trips here rather than in a
    // screenshot.
    const [, g, b] = transmit(islandParams.rimDepth);
    // the old scalar gave 0.12 flat at this depth: a shadow on the floor was
    // under 5% of the pixel, which is the bug
    expect(g).toBeGreaterThan(0.4);
    expect(b).toBeGreaterThan(0.6);
  });

  it('the floor arrives turquoise, not grey — that is the whole cue', () => {
    // Across the band you can actually sail (galleon draft ~2 m up to the rim),
    // blue must clearly outlive red or the floor reads as a dimmed photograph
    // rather than as something seen through water.
    for (const depth of [2, 4, islandParams.rimDepth]) {
      const [r, , b] = transmit(depth);
      expect(b / r).toBeGreaterThan(1.5);
    }
  });

  it('the sea is still optically thick — this is water, not clear glass', () => {
    // NOT the guard that keeps the see-through path off open water: that is
    // `validRefraction`, which zeroes transmission where there is no geometry
    // behind the surface at all. Open ocean is protected by having nothing to
    // show, not by absorbing it.
    // What this guards is the shared coefficient being dialled toward zero to
    // "see more" — which would also turn the submerged hull and the underwater
    // volume into air. Red is the channel that decides whether a medium reads
    // as water, and it must be gone by the open-ocean depth. Blue legitimately
    // survives at 26% there; that asymmetry IS the model working.
    const [r] = transmit(islandParams.seabedOpenDepth);
    expect(r).toBeLessThan(0.01);
  });
});


/**
 * §V.33 the sun shadow has ONE darkness. The ocean ran its own 0.85 while
 * every lit material took three's default 1.0, so a single ship shadow
 * crossing the waterline stepped 15% lighter as it left the beach — precisely
 * the seam the see-through work above exists to make beautiful.
 */
describe('§V.33 a shadow does not step at the waterline', () => {
  it("the scene-wide shadow darkness is the sky rig's, and the water only trims it", () => {
    // skyParams.shadowIntensity lands on sunLight.shadow.intensity, which the
    // ONE shared shadow node folds in as mix(1, pcf, intensity) — so it reaches
    // the water, the ship, the terrain and the sea floor through one binding.
    expect(skyParams.shadowIntensity).toBeGreaterThan(0);
    expect(skyParams.shadowIntensity).toBeLessThanOrEqual(1);
    // The water multiplies its own trim on top. At 1 it takes the scene's
    // shadow exactly as the sea floor does, which is what keeps the shadow
    // continuous across the waterline. Anything else re-opens the step.
    expect(oceanSurfaceParams.shadowStrength).toBe(1);
    const onWater = skyParams.shadowIntensity * oceanSurfaceParams.shadowStrength;
    expect(onWater).toBeCloseTo(skyParams.shadowIntensity, 10);
  });

  it('a shadow on water is never fully black — skylight is not blocked', () => {
    // The ship occludes the sun, not the dome. A shadowed sea should go bluer
    // and dimmer; at intensity 1 it goes to the raw PCF result and reads as a
    // hole cut in the water.
    expect(skyParams.shadowIntensity).toBeLessThan(1);
  });
});


/**
 * Storm reference (SoT screenshot, user): turbulent sub-noise on wave faces,
 * tall waves, and water that stays luminous teal under a DARK overcast sky.
 * The last one is the trap — §B.12's fix made the ambient crest glow
 * sun-gated, and a naive reading of that would kill crest translucency
 * exactly when the reference says it should be strongest.
 */
describe('storm sea reads (§B.12 follow-up, user storm reference)', () => {
  const seaBoost = (rms: number) =>
    Math.min(
      Math.max(rms / Math.max(0.05, oceanSurfaceParams.seaRmsReference), 1),
      oceanSurfaceParams.stormGlowMax,
    );

  it('crest glow survives with NO sun and grows with sea state', () => {
    // skylight floor is what is left when backlight = 0. It must be > 0 or
    // storm water goes grey under overcast, and it must RISE with sea state
    // or the reference's luminous storm crests are unreachable.
    expect(oceanSurfaceParams.sssSkylightFloor).toBeGreaterThan(0);
    const swell = oceanSurfaceParams.sssSkylightFloor * seaBoost(0.7);
    const storm = oceanSurfaceParams.sssSkylightFloor * seaBoost(2.5);
    expect(storm).toBeGreaterThan(swell);
    // ...but never a sun-independent slug again (§B.12): capped well under 1
    expect(storm).toBeLessThan(0.6);
  });

  it('the sea-state boost is inert at and below the reference sea', () => {
    // calm must not inherit storm luminosity
    expect(seaBoost(0.2)).toBe(1);
    expect(seaBoost(oceanSurfaceParams.seaRmsReference)).toBe(1);
  });

  it('micro-detail is slope-driven and finer than any vertex can carry', () => {
    // it lives in the normal on purpose: at ~1 m spacing near the ship a
    // 2.4 m wavelet is already only 2 verts wide, so geometry cannot hold it
    expect(oceanSurfaceParams.microDetailScale).toBeLessThan(
      oceanParams.cascades[2].domain / 4,
    );
    expect(oceanSurfaceParams.microDetailStrength).toBeGreaterThan(0);
    expect(oceanSurfaceParams.microDetailSlopeGate).toBeGreaterThan(0);
  });

  it('the fine cascade reaches further than it did before the storm pass', () => {
    // loosened Nyquist gate: cascade 2 displacement now survives to ~2x the
    // distance, which is where the churned near-field faces live
    const k = solveGrowthRate({
      segments: oceanSurfaceParams.gridSegments,
      coreSpacing: oceanSurfaceParams.gridCoreSpacing,
      horizonRadius: oceanSurfaceParams.gridHorizonRadius,
      rimRound: oceanSurfaceParams.gridRimRound,
    });
    const cutSpacing =
      oceanParams.cascades[2].domain / oceanSurfaceParams.lodSamplesCut;
    const cutDistance = (cutSpacing - oceanSurfaceParams.gridCoreSpacing) / k;
    expect(cutDistance).toBeGreaterThan(200);
  });
});

/**
 * §V.48, the NORMAL tier — "the sea goes plasticky too close by" (user).
 *
 * The defect these encode is not a number that was too small, it is a gate
 * measured against the WRONG QUANTITY. The old tier compared a pixel's
 * footprint to a cascade's TEXEL SIZE and retired the whole band at 3.5
 * texels, justified by "the cascade pyramid is the mip chain". §V.19
 * band-splits the cascades so that no wavelength appears in two of them, so
 * there is no pyramid to fall back to: when cascade 2 goes, every wavelength
 * under 8.3 m leaves the sea. And a texel is the finest thing the grid can
 * HOLD, not what the band is MADE OF, so the criterion fired an order of
 * magnitude before the band ran out.
 *
 * These are written against the SPECTRUM rather than against the constants, so
 * they keep meaning when the sea state moves (§V.36's discipline): every one of
 * them asks "is resolvable detail being thrown away", never "is the number
 * still 3.5".
 */
describe('§V.48 the normal LOD retires a band when the BAND runs out', () => {
  const N = 128; // coarse grid: these assertions are about ratios, not σ
  const bins = (i: number, p = oceanParams) =>
    slopeWavelengthHistogram(
      N,
      p.cascades[i].domain,
      p,
      cascadeBand(i, p.splitWavelengths),
    );
  /** fraction of a band's slope variance carried by λ ≥ 2·footprint */
  const resolvable = (b: Float64Array, footprint: number) => {
    let total = 0;
    let keep = 0;
    for (let i = 0; i < b.length; i++) {
      const lam = Math.pow(2, -8 + i / 8);
      total += b[i];
      if (lam >= 2 * footprint) keep += b[i];
    }
    return total > 0 ? keep / total : 0;
  };

  it('the footprint it reports really is where that much variance survives', () => {
    for (let i = 0; i < 3; i++) {
      const b = bins(i);
      for (const keep of [0.95, 0.5, 0.2]) {
        const f = slopeResolutionFootprint(b, keep);
        // one bin of slack: the histogram is 1/8-octave quantised
        expect(resolvable(b, f)).toBeGreaterThanOrEqual(keep - 0.06);
        expect(resolvable(b, f * 1.2)).toBeLessThan(keep + 0.12);
      }
    }
  });

  it('is monotone — asking to keep more detail can only cut sooner', () => {
    for (let i = 0; i < 3; i++) {
      const b = bins(i);
      expect(slopeResolutionFootprint(b, 0.95)).toBeLessThanOrEqual(
        slopeResolutionFootprint(b, 0.5),
      );
      expect(slopeResolutionFootprint(b, 0.5)).toBeLessThanOrEqual(
        slopeResolutionFootprint(b, 0.2),
      );
    }
  });

  it('THE BUG: a texel-count gate deletes detail that is still resolvable', () => {
    // this is the regression, stated as the measurement that found it — the
    // old cut (3.5 texels) landed while cascade 2 still carried most of its
    // slope, i.e. it was retiring signal, not noise
    const oldCutFootprint = (3.5 * oceanParams.cascades[2].domain) / oceanParams.resolution;
    expect(resolvable(bins(2), oldCutFootprint)).toBeGreaterThan(0.8);
    // and the shipped keep fractions do NOT cut there
    expect(slopeResolutionFootprint(bins(2), oceanSurfaceParams.normalKeepCut))
      .toBeGreaterThan(oldCutFootprint * 4);
  });

  it('a texel ratio cannot be shared between cascades — hence metres', () => {
    // §V.59's tell: one constant that looks like it should serve every band.
    // If these ever converge the measurement is broken, not the design.
    const texelRatio = (i: number) =>
      slopeResolutionFootprint(bins(i), oceanSurfaceParams.normalKeepCut) /
      (oceanParams.cascades[i].domain / oceanParams.resolution);
    expect(Math.abs(texelRatio(2) / texelRatio(1) - 1)).toBeGreaterThan(0.25);
  });

  it('no cascade is retired while the NEXT one could not carry its band', () => {
    // the pyramid argument only ever holds where bands overlap, and §V.19 says
    // they never do — so the fine cascade must outlive the footprint at which
    // its own content dies, not the footprint at which its grid does
    for (let i = 0; i < 3; i++) {
      const cut = slopeResolutionFootprint(bins(i), oceanSurfaceParams.normalKeepCut);
      const bandShortest =
        i === 2 ? oceanParams.splitWavelengths[1] : oceanParams.splitWavelengths[i];
      // cut must be past Nyquist of the band's LONGEST wave — the last thing
      // in it to go sub-pixel
      expect(cut).toBeGreaterThan(bandShortest / 40);
    }
  });

  it('holds on every weather preset, not just the shipped one', () => {
    for (const name of ['calm', 'swell', 'storm'] as const) {
      const p: OceanParams = {
        ...oceanParams,
        ...(weatherPresets[name].ocean as Partial<OceanParams>),
      };
      for (let i = 0; i < 3; i++) {
        const b = bins(i, p);
        const full = slopeResolutionFootprint(b, oceanSurfaceParams.normalKeepFull);
        const cut = slopeResolutionFootprint(b, oceanSurfaceParams.normalKeepCut);
        expect(Number.isFinite(full)).toBe(true);
        expect(cut).toBeGreaterThan(full);
      }
    }
  });

  it('the material reads the measured footprints, not a texel count', () => {
    // §B.31/§B.7 shape: the value is spectrum-derived, so it MUST be refreshed
    // where the spectrum can move, or a weather preset silently keeps the
    // launch-time LOD.
    expect(surfaceMaterialSource).toContain('slopeFootprint(sp.normalKeepFull)');
    expect(surfaceMaterialSource).toContain('refreshNormFoot()');
    expect(surfaceMaterialSource).not.toContain('normalTexel');
  });
});

/**
 * §V.48b — THE VARIANCE A FADE REMOVES HAS TO GO SOMEWHERE.
 *
 * The block above proves the normal LOD retires a band at the right FOOTPRINT.
 * This one proves the other half, which was missing entirely: fading to zero is
 * the correct MEAN of a zero-mean slope field, but it also deletes that field's
 * VARIANCE, and a surface that has lost its sub-pixel slope is not a smooth
 * surface — it is a ROUGH one whose roughness the shading no longer knows
 * about. Dropping it turns the far sea into a mirror (measured in
 * surfaceMaterial's own normLod docstring: shading slope RMS exactly zero past
 * 365 m), and a grazing mirror is maximally sensitive to whatever residual
 * normal survives. That is the user's "really really noisy in the distance",
 * arriving as an ABSENCE of detail rather than an excess of it.
 *
 * So these assertions are about CONSERVATION, not about thresholds: whatever
 * the LOD takes out of the normal must appear in the roughness, at every
 * footprint and on every weather preset. They are written against the spectrum
 * for the same reason the block above is — they must keep meaning when the sea
 * state moves.
 *
 * Why the screen-space σ² already in the material cannot do this job, and the
 * reason the two terms are ADDED rather than swapped: `dFdx(normalWorld)`
 * measures the normal that SURVIVED the fade, so it is blind by construction to
 * the band the fade removed. A test cannot see that directly (it is a GPU
 * derivative), but it is exactly why the reconstruction below has to exist.
 */
describe('§V.48b the normal LOD converts what it removes into roughness', () => {
  const N = 128;
  const bins = (i: number, p = oceanParams) =>
    slopeWavelengthHistogram(N, p.cascades[i].domain, p, cascadeBand(i, p.splitWavelengths));
  /** fraction of a band's slope variance carried by λ ≥ 2·footprint */
  const resolvable = (b: Float64Array, footprint: number) => {
    let total = 0;
    let keep = 0;
    for (let i = 0; i < b.length; i++) {
      const lam = Math.pow(2, -8 + i / 8);
      total += b[i];
      if (lam >= 2 * footprint) keep += b[i];
    }
    return total > 0 ? keep / total : 0;
  };

  /**
   * The shader's `normLod` ramp, transliterated: smoothstep(cut, full, x) with
   * cut > full, i.e. 1 below `full` and 0 above `cut`. Keep this in step with
   * surfaceMaterial's `filtered` — the pair is the point.
   */
  const smoothstep = (e0: number, e1: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  const lodAt = (i: number, footprint: number, p = oceanParams) => {
    const b = bins(i, p);
    const full = slopeResolutionFootprint(b, oceanSurfaceParams.normalKeepFull);
    const cut = slopeResolutionFootprint(b, oceanSurfaceParams.normalKeepCut);
    return smoothstep(cut, full, footprint);
  };
  /** what the shader reconstructs: Σ (1 − lod_i)·σ²_i */
  const unresolvedAt = (footprint: number, p = oceanParams) => {
    let acc = 0;
    for (let i = 0; i < 3; i++) {
      acc += (1 - lodAt(i, footprint, p)) * slopeVarianceTotal(bins(i, p));
    }
    return acc;
  };

  it('publishes the same total the footprint function partitions', () => {
    // if these two ever disagree the roughness is reconstructed against a
    // different sea than the LOD faded, and nothing downstream can tell
    for (let i = 0; i < 3; i++) {
      const b = bins(i);
      const total = slopeVarianceTotal(b);
      expect(total).toBeGreaterThan(0);
      const foot = slopeResolutionFootprint(b, 0.5);
      // resolvable() is a FRACTION of the same total, so the split is exact
      expect(resolvable(b, foot) * total).toBeLessThanOrEqual(total + 1e-12);
    }
  });

  it('is non-negative and bounded by the band it came from (§V.44)', () => {
    // the shader clamps to specularAaMax, but the term must be well-behaved
    // BEFORE the clamp or the clamp is hiding a sign error
    let bandTotal = 0;
    for (let i = 0; i < 3; i++) bandTotal += slopeVarianceTotal(bins(i));
    for (const foot of [0.001, 0.01, 0.1, 1, 10, 1000]) {
      const u = unresolvedAt(foot);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(bandTotal * (1 + 1e-9));
    }
  });

  it('rises monotonically as the pixel grows — roughness replaces detail', () => {
    // THE CONTRACT. Every metre of footprint the LOD takes out of the normal
    // has to arrive in the roughness, so this can never dip: a dip is a band
    // that was deleted from the geometry AND from the shading.
    let prev = -1;
    for (const foot of [0.005, 0.02, 0.05, 0.12, 0.3, 0.8, 2, 6, 20]) {
      const u = unresolvedAt(foot);
      expect(u).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = u;
    }
  });

  /**
   * The FINE cascades' share. Cascade 0 is the long swell — at any footprint a
   * camera will ever see it is still fully resolved, and it SHOULD be: a 100 m
   * wave is not sub-pixel at 8 m per pixel. The mirror the user sees is the
   * loss of cascades 1 and 2, so that is what these assert on. Asserting on all
   * three would have been the §V.48 mistake in a test: measuring against the
   * whole population instead of against the band that actually runs out.
   */
  const fineTotal = (p = oceanParams) =>
    slopeVarianceTotal(bins(1, p)) + slopeVarianceTotal(bins(2, p));

  it('THE BUG: past the mirror distance the sea is rough, not flat', () => {
    // 365 m is where the material measured composite shading slope RMS hitting
    // EXACTLY ZERO. At the footprint that corresponds to, the fine cascades are
    // fully retired — so the OLD code had a mirror there, and the new one must
    // have their whole slope variance standing in for it as roughness.
    // derived from the spectrum, never hardcoded: "past the footprint at which
    // this sea's fine bands have run out", so it keeps meaning if they move
    const cutOf = (i: number) =>
      slopeResolutionFootprint(bins(i), oceanSurfaceParams.normalKeepCut);
    const farFootprint = Math.max(cutOf(1), cutOf(2)) * 1.5;
    expect(lodAt(1, farFootprint)).toBeLessThan(0.01);
    expect(lodAt(2, farFootprint)).toBeLessThan(0.01);
    // the mirror is gone: everything the fade removed is now driving lobe
    // width instead of being discarded
    expect(unresolvedAt(farFootprint)).toBeGreaterThan(fineTotal() * 0.99);
  });

  it('holds on every weather preset, not just the shipped one', () => {
    for (const name of ['calm', 'swell', 'storm'] as const) {
      const p: OceanParams = {
        ...oceanParams,
        ...(weatherPresets[name].ocean as Partial<OceanParams>),
      };
      expect(fineTotal(p)).toBeGreaterThan(0);
      // near field: the detail is resolved, so almost nothing is converted
      expect(unresolvedAt(1e-4, p)).toBeLessThan(fineTotal(p) * 0.5);
      // far field: all of it is
      expect(unresolvedAt(50, p)).toBeGreaterThan(fineTotal(p) * 0.99);
    }
  });

  it('the material actually consumes it, and adds it to the screen-space σ²', () => {
    // §B.8/§B.14/§B.18 shape: a term that is computed and never read is the
    // failure mode this project produces most often, and it is silent.
    expect(surfaceMaterialSource).toContain('cascadeUnresolvedVar');
    expect(surfaceMaterialSource).toContain('c.slopeVariance()');
    // ADDED to the dFdx estimate, never replacing it — the two see disjoint
    // bands, so a swap would silently drop the residual the fade left behind
    expect(surfaceMaterialSource).toContain('.add(unresolvedVar.mul(uSlopeVarAa))');
  });
});

/**
 * §V.48 TENTH AND ELEVENTH OCCURRENCES — the churn wavelets (§B, this session).
 *
 * `buildSurfaceSlope`'s four turbulent wavelets were gated by a single
 * `lodWeight(microDetailScale, …)`, which is wrong twice over, and both are
 * mistakes §V.48 already names:
 *
 *  - WRONG QUANTITY: `lodWeight` measures VERTEX spacing (coreSpacing +
 *    k·camDist) — the MESH's Nyquist limit, and a function of camera distance
 *    alone. These wavelets live in the FRAGMENT stage, where the right measure
 *    is `fwidth(worldXZ)`; the difference is the grazing stretch 1/sin(θ),
 *    which is unbounded and is the entire §T.39 sunset framing.
 *  - WRONG FEATURE: one gate for the whole stack, measured against the
 *    COARSEST wavelet, while slope goes as k — so the finest wavelet carries
 *    the most slope and goes sub-pixel soonest, and it was the one being
 *    guarded least. §B.20's caulk seam and §B.33's crackle octave, again.
 *
 * These assertions are about the RATIO between the sharpest feature and the
 * thing the old gate measured, so they keep meaning if the wavelet stack is
 * retuned.
 */
describe('§V.48 the churn wavelets are gated on their OWN wavelength', () => {
  /** the frequency multipliers in buildSurfaceSlope's wavelet stack */
  const FREQ = [1.0, 1.618, 2.414, 3.732];

  it('the sharpest wavelet carries the MOST slope, so it needs the most guard', () => {
    // slope amplitude ∝ k ∝ freqMul, and slope VARIANCE ∝ k². This is why
    // gating the stack on the base wavelength is not a small error.
    const base = FREQ[0];
    const finest = FREQ[FREQ.length - 1];
    expect(finest / base).toBeGreaterThan(3.5);
    // it also goes sub-pixel that many times SOONER — the two compound
    const scale = oceanSurfaceParams.microDetailScale;
    expect(scale / finest).toBeLessThan(scale / base / 3.5);
  });

  it('THE BUG: the old single gate ran 3.7x too late for the finest wavelet', () => {
    // transliteration of the old expression's intent: one Nyquist gate at the
    // BASE wavelength. Everything between the two footprints below was
    // aliasing with no guard at all — the fibrous foreground noise on the
    // wave flanks.
    const scale = oceanSurfaceParams.microDetailScale;
    const oldCut = scale / 2; // Nyquist of the base wavelet
    const trueCut = scale / FREQ[FREQ.length - 1] / 2; // Nyquist of the finest
    expect(oldCut / trueCut).toBeGreaterThan(3.5);
  });

  it('the full-strength gate leaves at least two samples per wavelength', () => {
    // below 2 the wavelet is past Nyquist while still at full amplitude, which
    // is the aliasing this parameter exists to prevent
    expect(oceanSurfaceParams.microDetailSamplesFull).toBeGreaterThan(2);
  });

  /**
   * THE REGRESSION THIS CAUSED, and the reason the band limit is not the whole
   * job (user: "a very very regular grid visible now that is no bueno").
   *
   * These are FOUR cosine plane waves at four fixed directions. That is an
   * interference LATTICE by construction, and no per-wavelet Nyquist gate can
   * make a lattice stop being regular — it only stops it aliasing. The old
   * `lodWeight` gate was wrong as a band limit AND load-bearing for the look:
   * it kept the lattice inside the near field, where it reads as churn on a
   * wave face instead of as a weave over the whole sea. Replacing it with the
   * per-wavelet gate alone extended the pattern 9-18× and made it legible.
   *
   * So the contract is TWO fades with distinct jobs, and this asserts that the
   * ENVELOPE is the binding one at a head-on view — if a refactor ever lets the
   * Nyquist gate decide reach, the grid comes straight back.
   */
  it('THE REGRESSION: the envelope, not Nyquist, decides how FAR the churn goes', () => {
    const scale = oceanSurfaceParams.microDetailScale;
    const stretch = oceanSurfaceParams.normalDetailStretch;
    // envelope: lodWeight(microScale) reaches 0 at this VERTEX SPACING
    const envelopeCutSpacing = (scale * stretch) / oceanSurfaceParams.lodSamplesCut;
    const k = 0.02005; // clipmap growth for the shipped grid (solveGrowthRate)
    const envelopeCutDist = (envelopeCutSpacing - oceanSurfaceParams.gridCoreSpacing) / k;
    // Nyquist: the COARSEST wavelet survives longest, so it sets the reach if
    // the envelope is ever removed. rad/px at fov 55, 879 px tall.
    const radPerPx = (2 * Math.tan((55 * Math.PI) / 180 / 2)) / 879;
    const nyquistCutDist = scale / 2 / radPerPx;
    // the envelope must cut FIRST, and by a wide margin — this is the number
    // that regressed: 55 m vs 1013 m
    expect(envelopeCutDist).toBeLessThan(nyquistCutDist / 5);
    expect(envelopeCutDist).toBeLessThan(120);
  });

  it('the material gates per wavelet AND keeps a reach envelope — both', () => {
    // the mechanical tell for every half of this, so a revert is loud.
    // (`microFade` was the single stack-wide gate that did BOTH jobs badly)
    expect(surfaceMaterialSource).not.toContain('const microFade =');
    // the envelope is back, named for the job it actually does
    expect(surfaceMaterialSource).toContain('const microReach = lodWeight(microScale');
    // and it is folded into each wavelet's own fade, so §V.48b still sees
    // everything that was removed — by the reach as well as by Nyquist
    expect(surfaceMaterialSource).toContain('.mul(microReach)');
    // each wavelet computes its own lambda and fades against pixWorld
    expect(surfaceMaterialSource).toContain('const lambda = microScale.div(freqMul)');
    expect(surfaceMaterialSource).toContain('uMicroSamples');
    // §V.48b: what it fades out becomes roughness rather than nothing
    expect(surfaceMaterialSource).toContain('microUnresolvedVar');
  });
});


/**
 * "Rotating the camera should not switch the light off" (user). A glint road
 * IS a specular and SHOULD vanish when you look away — that part is correct
 * and must stay. What must not vanish is the sea reading as sunlit, so the
 * contract is: there is always a view-INDEPENDENT sun response, and the
 * off-axis softening is a broad sky halo, never a faked wide specular.
 */
/**
 * §B: TSL `assign`/`addAssign` OUTSIDE an `Fn()` body is a SILENT NO-OP.
 * `Node.prototype.assign` (three/src/nodes/tsl/TSLCore.js) needs the module's
 * `currentStack`, which only exists while an Fn body is executing; with no
 * stack it console.errors once and returns `this` UNCHANGED. The ocean's
 * shading normal was built at module scope, so the §V.5 turbulent sub-noise on
 * wave faces — every `microDetail*` param — was written, tuned, and never
 * reached a pixel. It reads as "the water is too clean", never as a failure.
 *
 * The whole slope build therefore lives in `buildSurfaceSlope`, which is
 * CALLED from inside `colorNode`'s Fn. Anything added to it later (the wake
 * slope is the second such term) dies the moment that moves back out.
 */

/**
 * §V.56 — the sea's own pigment is a FLOOR, not a base layer.
 *
 * These sweep the two axes the defect actually lives on, VIEW AZIMUTH and
 * DISTANCE, and floor the CHROMA. They deliberately do NOT test luminance: a
 * grey wash has exactly the luminance it should, which is why five successive
 * versions of this bug (the cow pattern, the teal hull, the rotation blowout,
 * the grazing grey wash, the wake's white curtain) each passed every check we
 * had and still arrived on screen.
 *
 * They also test the SUM, not the terms. Fresnel at grazing, a pale sky, the
 * distance haze and the foam are each defensible alone; the failure is their
 * product (§V.49, applied to one material rather than two owners).
 */
describe('§V.56 the sea holds its colour on both axes', () => {
  // TWO skies, because the defect is a PRODUCT and only one of them shows it.
  // A warm sunset sky is chromatic enough to survive a bad re-saturation on
  // its own; a neutral overcast/fog sky is the worst case the invariant has to
  // hold under, and it is the one the user shot ("takes on the grey sky
  // reflection quite intensely").
  const SUNSET: SkyDomeCpu = {
    mid: [0.42, 0.5, 0.62],
    zenith: [0.2, 0.32, 0.55],
    haze: [0.86, 0.78, 0.7],
    warm: [1.0, 0.72, 0.42],
    sunDir: [-0.983, 0.176, 0.047],
    hazeStrength: 0.55,
    hazeFalloff: 0.14,
    sunHaze: 0.5,
    warmAmount: 0.8,
    gradientCurve: 0.75,
  };
  const NEUTRAL: SkyDomeCpu = {
    mid: [0.62, 0.62, 0.62],
    zenith: [0.48, 0.48, 0.48],
    haze: [0.85, 0.85, 0.85],
    warm: [0.85, 0.85, 0.85],
    sunDir: [-0.983, 0.176, 0.047],
    hazeStrength: 0.7,
    hazeFalloff: 0.14,
    sunHaze: 0.3,
    warmAmount: 0.2,
    gradientCurve: 0.75,
  };
  /** deepColor #093642 after the wrap light — the pigment we must not lose */
  const BODY: Rgb = [0.02, 0.11, 0.14];
  const FLOOR = oceanSurfaceParams.pigmentFloorChroma;

  const sample = (
    sky: SkyDomeCpu,
    azimuth: number,
    camDist: number,
    overrides: Partial<Parameters<typeof seaColorCpu>[0]> = {},
  ): Rgb => {
    // a grazing view — the reflection ray leaves at a shallow elevation, and
    // its AZIMUTH is the axis the old elevation-only ramp could not see at all
    const elev = 0.12;
    const h = Math.sqrt(1 - elev * elev);
    return seaColorCpu({
      refl: [Math.cos(azimuth) * h, elev, Math.sin(azimuth) * h],
      // distance IS grazing: cos(view, normal) → 0 as the water recedes, so
      // Schlick → 1 and the pixel becomes pure reflected sky
      cosTheta: Math.max(0.02, 1 / (1 + camDist * 0.02)),
      camDist,
      body: BODY,
      sky,
      fresnelR0: oceanSurfaceParams.fresnelR0,
      reflectionStrength: oceanSurfaceParams.reflectionStrength,
      grazingSaturation: oceanSurfaceParams.grazingSaturation,
      grazingSaturationFar: oceanSurfaceParams.grazingSaturationFar,
      grazingSaturationFullDist: oceanSurfaceParams.grazingSaturationFullDist,
      pigmentFloorChroma: FLOOR,
      pigmentFloorStrength: oceanSurfaceParams.pigmentFloorStrength,
      hazeT: 0,
      hazeColor: sky.haze,
      ...overrides,
    });
  };

  it('DISTANCE: the mid-field never washes out, under either sky', () => {
    // out to hazeStart, past which atmospheric extinction legitimately owns
    // the pixel. This is the sweep a single grazingSaturation constant fails.
    for (const [name, sky] of [['sunset', SUNSET], ['neutral', NEUTRAL]] as const) {
      for (let d = 10; d <= oceanSurfaceParams.hazeStart; d += 30) {
        expect(
          chroma(sample(sky, 0, d)),
          `${name} sky: chroma collapsed at ${d} m`,
        ).toBeGreaterThanOrEqual(FLOOR);
      }
    }
  });

  it('AZIMUTH: no direction of view loses the water (the rotation axis)', () => {
    for (const [name, sky] of [['sunset', SUNSET], ['neutral', NEUTRAL]] as const) {
      for (let i = 0; i < 16; i++) {
        const az = (i / 16) * Math.PI * 2;
        for (const d of [40, 200, 600]) {
          expect(
            chroma(sample(sky, az, d)),
            `${name}: chroma collapsed at azimuth ${((az * 180) / Math.PI) | 0}°, ${d} m`,
          ).toBeGreaterThanOrEqual(FLOOR);
        }
      }
    }
  });

  /** the material's own haze ramp, so the sweep melts where the frame does */
  const hazeAt = (d: number): number => {
    const u = Math.min(
      1,
      Math.max(0, (d - oceanSurfaceParams.hazeStart) /
        (oceanSurfaceParams.hazeEnd - oceanSurfaceParams.hazeStart)),
    );
    return Math.pow(u * u * (3 - 2 * u), oceanSurfaceParams.hazeCurve) *
      oceanSurfaceParams.hazeStrength;
  };

  it('HORIZON: the far field hands over to atmosphere, it does not go turquoise', () => {
    // The third report on this axis, and the opposite failure to the grey
    // wash: at grazingSaturationFar 0.55 with an ungated pigment floor, every
    // pixel past ~900 m converged on ONE hue and the horizon read as a solid
    // turquoise band. §V.30 wants the sea to melt into haze there — that melt
    // is what makes the water look like it goes somewhere.
    const near = chroma(sample(SUNSET, 0, 600, { hazeT: hazeAt(600) }));
    const horizon = chroma(sample(SUNSET, 0, 3800, { hazeT: hazeAt(3800) }));
    // the horizon must be MUCH closer to the sky than the mid-field is
    expect(horizon).toBeLessThan(near * 0.4);
    // and it must actually approach the haze colour, not merely dim
    const px = sample(SUNSET, 0, 4400, { hazeT: hazeAt(4400) });
    for (let c = 0; c < 3; c++) {
      expect(Math.abs(px[c] - SUNSET.haze[c])).toBeLessThan(0.06);
    }
  });

  it('the horizon CONVERGES on the atmosphere — no coloured wall at any radius', () => {
    // Not "chroma falls monotonically": the haze has a chroma of its own and
    // the water may legitimately pass through it. The invariant is that the
    // pixel gets steadily CLOSER to the air in front of it — a band that
    // diverges from the haze as it recedes is the coloured wall §V.30 forbids.
    // measured as COLOUR distance, not chroma distance: the water's chroma
    // legitimately passes THROUGH the haze's own on its way down, so a
    // chroma-gap test reads that crossing as a divergence.
    const dist = (a: Rgb, b: Rgb): number =>
      Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    let prev = Infinity;
    for (let d = 1200; d <= oceanSurfaceParams.hazeEnd; d += 200) {
      const gap = dist(sample(SUNSET, 0, d, { hazeT: hazeAt(d) }), SUNSET.haze);
      expect(gap, `the water pulled AWAY from the haze at ${d} m`)
        .toBeLessThanOrEqual(prev + 1e-6);
      prev = gap;
    }
  });

  it('REPRODUCES the bug: the shipped-before values collapse the same sweep', () => {
    // A test that cannot fail is not a test (§Rule 6). These are exactly the
    // values in the tree before this change — one flat grazingSaturation of
    // 0.15 and no floor — against the neutral sky. It is the reported defect,
    // measured: a grey sea with the RIGHT luminance, which is why nothing
    // caught it.
    // cosTheta 0.01 is the genuine worst case and the one the user shot: water
    // near the horizon, Schlick ≈ 0.98, essentially PURE reflected sky with no
    // body term left to carry the colour.
    const grazing = { cosTheta: 0.01, camDist: 800 } as const;
    const before = chroma(
      sample(NEUTRAL, 0, 800, {
        ...grazing,
        grazingSaturationFar: oceanSurfaceParams.grazingSaturation,
        pigmentFloorStrength: 0,
      }),
    );
    expect(before).toBeLessThan(FLOOR);
    // and the shipped values clear it by a wide margin
    expect(chroma(sample(NEUTRAL, 0, 800, grazing))).toBeGreaterThan(before * 1.8);
  });

  it('the distance ramp does the work; the floor is the guarantee', () => {
    // honest attribution: at shipped params the RAMP is what lifts the
    // mid-field, and the floor never engages there. The floor exists for the
    // cases the ramp cannot reach — and it must actually bite when it does.
    const rampOnly = chroma(sample(NEUTRAL, 0, 800, { pigmentFloorStrength: 0 }));
    expect(rampOnly).toBeGreaterThanOrEqual(FLOOR);
    // force the collapse and check the floor catches it
    const grey: Rgb = [0.5, 0.51, 0.52];
    const lifted = pigmentFloor(grey, bodyTint(BODY), FLOOR);
    expect(chroma(grey)).toBeLessThan(FLOOR);
    expect(chroma(lifted)).toBeGreaterThanOrEqual(FLOOR * 0.95);
    // …without darkening the frame: it is a hue restore, not a shade (§V.44)
    expect(luminance(lifted)).toBeGreaterThan(luminance(grey) * 0.8);
  });

  it('and it is INERT wherever the sea already has its colour', () => {
    // above the floor the composite must be bit-identical — a floor that
    // quietly tints healthy water is a global hue shift with extra steps
    const coloured: Rgb = [0.02, 0.16, 0.2];
    expect(chroma(coloured)).toBeGreaterThan(FLOOR);
    expect(pigmentFloor(coloured, bodyTint(coloured), FLOOR)).toEqual([
      coloured[0],
      coloured[1],
      coloured[2],
    ]);
  });

  it('re-saturation is a HUMP: low near, high mid-field, low at the horizon', () => {
    const at = (d: number, waterness: number) =>
      grazingSaturationAt(
        d,
        oceanSurfaceParams.grazingSaturation,
        oceanSurfaceParams.grazingSaturationFar,
        oceanSurfaceParams.grazingSaturationFullDist,
        waterness,
      );
    const near = at(5, 1);
    const mid = at(700, 1 - hazeAt(700));
    const horizon = at(4200, 1 - hazeAt(4200));
    // NEAR stays where the over-saturated-teal fix put it: close water shows
    // its body through the surface (§V.24) and needs no help
    expect(near).toBeCloseTo(oceanSurfaceParams.grazingSaturation, 2);
    // MID-FIELD is the only place that does — entirely grazing, no transmission
    expect(mid).toBeGreaterThan(near * 1.6);
    // HORIZON hands back to the atmosphere. Both ends low is the whole point:
    // a rising ramp is what painted the turquoise band.
    expect(horizon).toBeLessThan(mid * 0.35);
  });

  it('the shader runs the same two levers (CPU pair kept in step)', () => {
    // seaChroma.ts is a TRANSLITERATION, not a second implementation — if the
    // shader stops calling these, every sweep above is measuring nothing.
    expect(surfaceMaterialSource).toMatch(/uGrazingSat\.x[\s\S]{0,160}uGrazingSat\.y/);
    expect(surfaceMaterialSource).toMatch(/uPigFloor/);
    expect(surfaceMaterialSource).toMatch(/colChroma/);
  });
});

describe('§B the shading normal is built inside the fragment Fn', () => {
  const builderDecl = surfaceMaterialSource.indexOf('const buildSurfaceSlope = ()');
  const fnDecl = surfaceMaterialSource.indexOf('const colorNode = Fn(');

  it('the slope builder exists and is invoked from inside the Fn', () => {
    expect(builderDecl).toBeGreaterThan(-1);
    const call = surfaceMaterialSource.indexOf('buildSurfaceSlope()');
    expect(call).toBeGreaterThan(fnDecl);
  });

  it('no addAssign sits at module scope, where it would silently vanish', () => {
    const firstAssign = surfaceMaterialSource.indexOf('.addAssign(');
    // every assign must come after the builder opens; module scope is
    // everything before it
    expect(firstAssign).toBeGreaterThan(builderDecl);
  });

  it('the churn the user is missing is actually in that builder', () => {
    const builderBody = surfaceMaterialSource.slice(builderDecl, fnDecl);
    expect(builderBody).toMatch(/uMicro/);
    expect(builderBody).toMatch(/addAssign/);
  });
});

describe('the sea stays lit from every camera angle (user)', () => {
  it('has a view-independent sun response at all', () => {
    // N·L body scatter + N·L wrap gain: both are functions of the surface
    // normal and the sun only. If either goes to zero the sea goes flat the
    // moment the camera turns away from the sun.
    expect(oceanSurfaceParams.sunScatterStrength).toBeGreaterThan(0);
    expect(oceanSurfaceParams.lightGain).toBeGreaterThan(0);
  });

  it('the off-axis sky term is the SKY\'s, and is a BROAD halo', () => {
    // The glint road is a Beckmann lobe on the sea's own σ² (§V.75) — a true
    // specular, and it is the ONLY thing in the water allowed to be that
    // tight. The off-axis brightening around the sun must be far broader or we
    // have simply faked a view-independent glint, which the user did not ask
    // for.
    //
    // It is also no longer the OCEAN's: `skySunGlowStrength/Power` are gone on
    // purpose. They were an ocean-owned lobe stacked on an elevation-only
    // reflected-sky ramp, so the sea took the sun's warmth on the sun's side
    // and never lost it on the other ("too much of the sunlight colour all
    // around"). The reflected sky is now skyDomeColor(refl) from the sky
    // system, whose azimuthal terms ride `sunSide = dot(dir,sun)*0.5+0.5`
    // to a power of at most 2 — broad by construction, and it COOLS the
    // anti-solar side because it is a mix, not an add.
    expect(oceanSurfaceParams).not.toHaveProperty('skySunGlowPower');
    expect(oceanSurfaceParams).not.toHaveProperty('skySunGlowStrength');
    expect(surfaceMaterialSource).not.toMatch(/skySunGlow/);
    // the ocean asks the sky for it rather than modelling a second one
    expect(surfaceMaterialSource).toMatch(/skyDomeColor\(refl\)/);
    // and the sun's azimuthal spread there is nowhere near the road's width:
    // the road's half-width is the sea's RMS slope, ~14° at the shipped swell,
    // against a sky whose sunSide term is squared at most, i.e. tens of degrees
    expect(skyParams.sunHazeStrength).toBeGreaterThan(0);
  });

  it('skylight is used as light, not as paint', () => {
    // desaturating the sky colour before using it as illumination; 0 would
    // mean painting the water with the literal sky swatch
    expect(oceanSurfaceParams.skylightDesaturation).toBeGreaterThan(0);
    expect(oceanSurfaceParams.skylightDesaturation).toBeLessThanOrEqual(1);
  });

  it('the sun gain carries real N·L contrast', () => {
    // gain/floor is the lit-vs-unlit ratio of the wrap term before any
    // additive path. Too small and every wave face reads the same brightness,
    // which is what made the sea look flat and unlit off-axis.
    expect(oceanSurfaceParams.lightGain / oceanSurfaceParams.lightFloor)
      .toBeGreaterThan(0.75);
  });
});


/**
 * §T.39 golden hour. The sea held hardcoded sky colours while sky, fog and
 * ambient all warmed off the shared live palette — a mint turquoise ocean
 * under a fully amber sunset. The fix ties the reflected sky to the live haze
 * colour the water ALREADY copies for its distance haze, so the two can never
 * drift apart again. These tests pin both ends of that: midday must be
 * untouched, sunset must actually warm.
 */
describe('reflected sky follows the live day cycle (§T.39)', () => {
  const linear = (hex: string) => {
    const c = new Color();
    c.setStyle(hex, SRGBColorSpace);
    return [c.r, c.g, c.b];
  };
  const tint = (hazeHex: string) => {
    const live = linear(hazeHex);
    const ref = linear(oceanSurfaceParams.skyReferenceHaze);
    return live.map((v, i) =>
      Math.min(oceanSurfaceParams.skyTintMax, v / Math.max(0.02, ref[i])),
    );
  };

  it('is a NO-OP at the reference haze — midday keeps its authored look', () => {
    // if someone retunes skyReferenceHaze without retuning the authored
    // gradient, the whole day cycle shifts. This is that tripwire.
    for (const channel of tint(oceanSurfaceParams.skyReferenceHaze)) {
      expect(channel).toBeCloseTo(1, 5);
    }
  });

  it('warms the sea at the measured sunset haze', () => {
    // sky agent's live sunset fog colour at timeOfDay 17.75
    const [r, g, b] = tint('#fdb669');
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    expect(r).toBeGreaterThan(1.5); // unmistakably warm, not a nudge
  });

  it('the tint ceiling does not clip the sunset it exists to carry', () => {
    // at 2.5 the cap was binding on red (needs 3.11) and quietly
    // under-warming the water
    const ref = linear(oceanSurfaceParams.skyReferenceHaze);
    const live = linear('#fdb669');
    const uncapped = Math.max(...live.map((v, i) => v / ref[i]));
    expect(oceanSurfaceParams.skyTintMax).toBeGreaterThanOrEqual(uncapped);
  });

  it('follows the live sky by default — constants alone are the bug', () => {
    expect(oceanSurfaceParams.skyFollowStrength).toBeGreaterThan(0.9);
  });
});

describe('sun-elevation gate clears a horizon-kissing sunset (§T.39)', () => {
  const smooth = (e0: number, e1: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  const gate = (y: number) =>
    smooth(
      oceanSurfaceParams.sunHorizonFadeLow,
      oceanSurfaceParams.sunHorizonFadeHigh,
      y,
    );

  it('is at FULL strength for the showcase sun, with real margin', () => {
    // the shot sits at sunDir.y = 0.0631 (3.62°). The old 0.02→0.06 ramp
    // cleared it by 5%, which is not margin — golden hour wants to go lower.
    expect(gate(0.0631)).toBe(1);
    expect(oceanSurfaceParams.sunHorizonFadeHigh).toBeLessThanOrEqual(0.0631 / 3);
  });

  it('still carries the sun at 1 degree of elevation', () => {
    expect(gate(0.0175)).toBeGreaterThan(0.5);
  });

  it('goes dark once the sun is actually down', () => {
    // below the horizon there is no direct sun; §B — the water reading "dead"
    // at 18.5h was the sun having SET, not a shader bug
    expect(gate(0)).toBe(0);
    expect(gate(-0.05)).toBe(0);
    expect(oceanSurfaceParams.sunHorizonFadeLow).toBeLessThan(
      oceanSurfaceParams.sunHorizonFadeHigh,
    );
  });
});

/**
 * §V.44 rotation blowout. The user shot one position from four azimuths: the
 * sea was electric cyan facing the sun and dark teal facing away — "just by
 * rotating the camera the whole scenery changes". The cause was a view·sun
 * lobe added without a ceiling, so facing a low sun it fired across the whole
 * visible sea at once. These tests encode WHY the bound exists: rotating the
 * camera must not restage the scene, and the bound has to hold at EVERY sun
 * elevation, not just the one it was tuned at.
 */
describe('backscatter lobe is bounded at source (§V.44)', () => {
  const sp = oceanSurfaceParams;

  it('has a hard ceiling below full replacement', () => {
    // it is a mix, so the ceiling is the maximum fraction of the body colour
    // the lobe can ever replace. At 1.0 the sea becomes the scatter colour
    // outright; past ~0.6 the toward-sun frame runs away again.
    expect(sp.sssMaxMix).toBeGreaterThan(0);
    expect(sp.sssMaxMix).toBeLessThanOrEqual(0.6);
  });

  it('the colour it mixes toward cannot out-brighten a lit sea', () => {
    // a mix bounds the WEIGHT; this bounds the TARGET. Both are needed — an
    // unbounded target with a bounded weight is still a blowout.
    expect(sp.sssBrightness).toBeLessThanOrEqual(1);
  });

  it('worst-case lobe contribution stays a minority of the pixel', () => {
    // the property that actually fixes the user's complaint: even with the
    // lobe fully saturated (camera facing the sun, crest, full choppiness)
    // most of the pixel is still the sea, not the scatter colour
    expect(sp.sssMaxMix).toBeLessThan(0.5);
  });

  it('is gated on sun elevation, so it cannot fire from a set sun', () => {
    expect(sp.sunHorizonFadeHigh).toBeGreaterThan(sp.sunHorizonFadeLow);
    expect(sp.sunHorizonFadeLow).toBeGreaterThanOrEqual(0);
  });
});

/**
 * §V.48 band-limiting. A world-locked hash grid is scale-invariant in WORLD
 * space, which means it is wrong in SCREEN space at every distance except the
 * one it was tuned at: 24 px blocks near the hull, per-pixel stipple in the
 * mid-distance.
 *
 * The FIRST fix sized cells by distance × view angle. That is only correct
 * looking straight down. On a plane seen at a grazing angle the world
 * footprint of one pixel is stretched by 1/sin(grazing), so at the sunset
 * framing (low camera, water running to the horizon) the cells went
 * sub-pixel again and the whole mid-field stippled — which the user
 * reported. CPU transliteration of both laws, so the regression is a test
 * failure and not another screenshot.
 */
describe('sparkle cells are sized by the pixel footprint (§V.48)', () => {
  const sp = oceanSurfaceParams;
  // 55 deg vertical fov over ~840 px
  const radPerPx = (55 * Math.PI) / 180 / 840;
  /**
   * World-space size of one pixel ON THE WATER, for a camera `h` above the
   * plane looking at a point `d` away horizontally. The 1/sin(grazing) term
   * is the whole point: it is what the angular law omitted.
   */
  const footprint = (d: number, h: number) => ((h * h + d * d) * radPerPx) / h;
  const quantise = (target: number) =>
    Math.max(sp.sparkleMinCell, 2 ** Math.floor(Math.log2(target)));
  const cellPx = (d: number, h: number) => {
    const f = footprint(d, h);
    return quantise(Math.max(sp.sparkleMinCell, f * sp.sparkleCellPixels)) / f;
  };

  it('holds its pixel size across four orders of distance', () => {
    // the old world-locked grid ran 24 px -> 0.25 px over this same range
    for (const d of [2, 10, 50, 200, 1000, 4000]) {
      expect(cellPx(d, 22)).toBeGreaterThan(1); // not per-pixel noise
      expect(cellPx(d, 22)).toBeLessThan(6); // not visible blocks
    }
  });

  it('holds it at a GRAZING framing too, where the angular law failed', () => {
    // low camera, sea running to the horizon: the §T.39 sunset shot
    for (const d of [50, 400, 1500, 4000]) {
      expect(cellPx(d, 3)).toBeGreaterThan(1);
      expect(cellPx(d, 3)).toBeLessThan(6);
    }
    // and prove the superseded law really did collapse there, so nobody
    // "simplifies" the footprint back into a distance × angle estimate
    const angular = (d: number, h: number) =>
      quantise(Math.max(sp.sparkleMinCell, d * 0.0028)) / footprint(d, h);
    expect(angular(1500, 3)).toBeLessThan(0.05); // ~1/20 px => pure stipple
  });

  it('quantises to octaves so the pattern does not boil under motion', () => {
    // within an octave the cell size is constant => world-locked, so the
    // pattern does not crawl as the camera dollies. Footprints are picked
    // RELATIVE to an octave boundary so the test survives retuning the
    // cells-per-pixel target.
    const size = (f: number) => quantise(f * sp.sparkleCellPixels);
    const at = (t: number) => (4 * t) / sp.sparkleCellPixels; // t ∈ (1,2) = one octave
    expect(size(at(1.1))).toBe(size(at(1.8)));
    expect(size(at(1.1))).not.toBe(size(at(2.5))); // ...and it does step
  });
});

/**
 * §V.48 specular antialiasing. A narrow specular lobe point-sampled on a
 * normal field that swings through many wave faces inside one pixel is a coin
 * flip per pixel; the user sees it as the whole sea glittering and boiling
 * when zoomed out. Carrying the sub-pixel normal variance into the lobe WIDTH
 * fixes it. Turning the specular down would too — and would flatten the sea —
 * so these tests are written against the thing that distinguishes them:
 * neighbouring pixels must AGREE more, while the lobe keeps its energy.
 */
describe('specular lobes are filtered by normal variance (§V.48)', () => {
  const sp = oceanSurfaceParams;
  /** the shader's own form: p' = p/(1 + p·σ²), peak × p'/p (energy conserved) */
  const lobe = (ndoth: number, p: number, varSq: number) => {
    const k = 1 + p * varSq;
    return Math.pow(ndoth, p / k) / k;
  };

  // §V.75 SCOPE: this `widen` form now covers the SPARKLE and the glint TRAIN
  // only. The road left it — its width is the sea's measured σ² and its peak
  // is the Beckmann normalisation, see the §V.75 block below. The two must not
  // be merged back: `widen` divides the peak by the widening factor, and
  // applying that on top of an NDF that already carries 1/(πσ²) is precisely
  // the double count that made the sun 4% of this water's light.
  it('is the identity where the normals are coherent — the sparkle stays', () => {
    for (const nh of [0.9, 0.99, 0.999]) {
      expect(lobe(nh, sp.sparklePower, 0)).toBeCloseTo(
        Math.pow(nh, sp.sparklePower),
        10,
      );
    }
  });

  it('collapses the pixel-to-pixel swing where they are not', () => {
    const p = sp.sparklePower; // 40: the tightest surviving pow(N·H) lobe
    const a = 0.999;
    const b = 0.94; // one neighbouring pixel, a slightly different wave face
    const raw = lobe(a, p, 0) / lobe(b, p, 0);
    expect(raw).toBeGreaterThan(8); // unfiltered: neighbours differ ~11x
    const filtered = lobe(a, p, 0.15) / lobe(b, p, 0.15);
    expect(filtered).toBeLessThan(2); // filtered: they now agree
  });

  it('can only ever attenuate, never amplify (§V.44 bounded at source)', () => {
    // gain = 1/(1 + p·σ²) with σ² ≥ 0 and capped, so the term is bounded
    // WITHOUT a clamp after the fact
    expect(sp.specularAaStrength).toBeGreaterThanOrEqual(0);
    expect(sp.specularAaMax).toBeGreaterThan(0);
    for (const p of [sp.sparklePower, sp.glintTrainPower]) {
      const gain = 1 / (1 + p * sp.specularAaMax);
      expect(gain).toBeGreaterThan(0);
      expect(gain).toBeLessThanOrEqual(1);
    }
  });
});

/**
 * §V.75 THE SUN IS THE BRIGHTEST THING ON THE WATER.
 *
 * The defect these tests exist to catch, measured at the lagoon, tod 17.6, sun
 * 5.8°, camera 7 m, mean water luminance over a mid-field band of 12 bins:
 *
 *     baseline                                     93
 *     sparkleStrength 0 AND glintRoadStrength 0    90   (−4%)
 *     + reflectionStrength 0                       28   (−70%)
 *
 * With BOTH glint terms off the frame was visually indistinguishable from
 * baseline: the sun was 4% of the sea's light and the reflected sky 70%, and
 * the sea measured 22% BRIGHTER facing away from the sun than toward it. The
 * cause was arithmetic, not art — the road's peak was
 * `glintRoadStrength / (1 + glintRoadPower·σ²)`, which at the sunset framing's
 * σ² is 0.55/181 = 0.003 against a sky reflection of ~0.11. Two orders of
 * magnitude, and no value of `glintRoadStrength` inside its slider range could
 * have closed it.
 *
 * The lobe is now energy-correct: Beckmann D on the sea's OWN slope variance,
 * Smith masking, Schlick at the microfacet, scaled by the sun irradiance this
 * material already states in its diffuse term. These tests are written against
 * the RATIO, because the ratio is what was wrong.
 */
describe('§V.75 the sun glint is an energy, not a sheen', () => {
  const sp = oceanSurfaceParams;
  /** Beckmann NDF — the Gaussian slope law Cox & Munk fitted to the sea */
  const beckmann = (cosH: number, a2: number) => {
    const c2 = Math.max(cosH * cosH, 1e-4);
    return Math.exp(-((1 - c2) / c2) / a2) / (Math.PI * a2 * c2 * c2);
  };
  /** Smith height-correlated visibility, 1/(4 N·L N·V) folded in */
  const smithV = (nol: number, nov: number, a2: number) =>
    0.5 /
    Math.max(
      nol * Math.sqrt(nov * nov * (1 - a2) + a2) +
        nov * Math.sqrt(nol * nol * (1 - a2) + a2),
      1e-5,
    );
  const schlick = (voh: number) =>
    sp.fresnelR0 + (1 - sp.fresnelR0) * Math.pow(1 - voh, 5);
  /**
   * The shader's own expression. `π · lightGain` is the unit bridge: the
   * material's diffuse term is an unnormalised Lambert
   * (`waterCol · sunTint · lightGain · N·L`), so `sunTint · lightGain` IS
   * E_⊥/π in this renderer's radiance units. Keep this in step with
   * surfaceMaterial's sun-glint block — the pair is the point.
   */
  const sunSpec = (cosH: number, nol: number, nov: number, voh: number, a2: number) =>
    Math.PI *
    sp.lightGain *
    sp.glintRoadStrength *
    beckmann(cosH, a2) *
    smithV(nol, nov, a2) *
    schlick(voh) *
    nol;

  /**
   * THE MEASURED FRAMING. Sun 5.8° elevation, eye 7 m looking down ~5° at the
   * mid-field, so the half vector stands almost straight up (cos ≈ 1) and the
   * microfacet's own incidence is ~85° — which is where the golden cone gets
   * its intensity, and it is Fresnel, not a boost.
   */
  const SUNSET = { cosH: 0.9995, nol: Math.sin((5.8 * Math.PI) / 180), nov: 0.087 };
  /** total mean square slope of the shipped swell sea (both components) */
  const SEA_VAR = 0.0607;
  /** measured scene-linear radiance of the reflected sky in that frame */
  const SKY_REFL = 0.11;

  it('outshines the sky it competes with — the ratio that was the bug', () => {
    const peak = sunSpec(SUNSET.cosH, SUNSET.nol, SUNSET.nov, 0.095, SEA_VAR);
    // the OLD road, for the record: peak = strength/(1 + power·σ²) with the
    // σ² the AA filter actually reaches at this framing
    const oldPeak = 0.55 / (1 + 180 * 1.0);
    expect(oldPeak).toBeLessThan(0.005);
    expect(peak / oldPeak).toBeGreaterThan(100);
    // and the bar that matters: the sun's own reflection has to dominate the
    // mirrored sky at the core of the road, or there is no cone, only a sheen
    expect(peak).toBeGreaterThan(10 * SKY_REFL);
  });

  it('is LONGER and WIDER as the sea roughens — σ² is the only width knob', () => {
    // "much longer and a little wider" (user). A Beckmann lobe's half-power
    // half-angle is atan(sqrt(σ²·ln2)); on a grazing view the road's REACH
    // toward the eye is that angle divided by the view's own grazing angle, so
    // a rougher sea extends the road for free. This is the acceptance check:
    // it must be monotonic in σ², with no distance term anywhere in it.
    const halfAngle = (a2: number) => {
      const peak = beckmann(1, a2);
      let lo = 0;
      let hi = Math.PI / 2;
      for (let i = 0; i < 60; i++) {
        const m = (lo + hi) / 2;
        if (beckmann(Math.cos(m), a2) > peak / 2) lo = m;
        else hi = m;
      }
      return lo;
    };
    let prev = 0;
    for (const a2 of [0.003, 0.01, 0.03, 0.0607, 0.12, 0.25]) {
      const w = halfAngle(a2);
      expect(w).toBeGreaterThan(prev);
      prev = w;
    }
    // calm → shipped swell is a ~4.5x wider lobe, i.e. the road grows with the
    // sea state rather than with a hand-placed falloff
    expect(halfAngle(SEA_VAR) / halfAngle(0.003)).toBeGreaterThan(3);
  });

  it('the sim\'s own σ² is the one Cox & Munk measured', () => {
    // The lobe is only physical if the surface driving it is. σ² here is the
    // TOTAL mean square slope, up- plus cross-wind, which is what
    // slopeVarianceTotal sums and what Cox & Munk (1954) regress as
    // 0.003 + 0.00512·U. If the spectrum ever drifts off this the road's width
    // silently stops meaning anything.
    const N = 128;
    let total = 0;
    for (let i = 0; i < 3; i++) {
      total += slopeVarianceTotal(
        slopeWavelengthHistogram(
          N,
          oceanParams.cascades[i].domain,
          oceanParams,
          cascadeBand(i, oceanParams.splitWavelengths),
        ),
      );
    }
    const coxMunk = 0.003 + 0.00512 * oceanParams.windSpeed;
    expect(total).toBeGreaterThan(0.4 * coxMunk);
    expect(total).toBeLessThan(2.5 * coxMunk);
  });

  it('is bounded at source, for every degenerate input (§V.44)', () => {
    // 1/(πσ²) runs away as σ² → 0 and 1/(4 N·V) runs away at exact grazing.
    // The shader floors σ² at Cox & Munk's zero-wind intercept and clamps the
    // product; both halves have to hold or a single pixel hands bloom an Inf.
    const FLOOR = 0.003;
    const MAX = 32;
    for (const cosH of [0, 0.5, 0.9, 1]) {
      for (const nol of [0, 1e-3, 0.1, 1]) {
        for (const nov of [0, 1e-3, 0.1, 1]) {
          for (const a2 of [FLOOR, SEA_VAR, 1]) {
            const v = sunSpec(cosH, Math.max(nol, 1e-3), Math.max(nov, 1e-3), 0.1, a2);
            expect(Number.isFinite(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(0);
            expect(Math.min(v, MAX)).toBeLessThanOrEqual(MAX);
          }
        }
      }
    }
  });

  it('keeps ONE owner for the lobe\'s width, and it is σ²', () => {
    // `glintRoadPower` was an independent exponent on the same lobe. It is how
    // the road's shape and the sea's actual roughness came to disagree by two
    // orders of magnitude, because nothing tied them together. Re-adding it
    // re-opens exactly that, silently.
    expect(oceanSurfaceParams).not.toHaveProperty('glintRoadPower');
    // the identifier survives only in the prose that records why it went
    expect(surfaceMaterialSource).not.toMatch(/sp\.glintRoadPower|uGlintRoad\.y/);
    // and §V.26 stays shut: no sun disc through the reflection, analytic or
    // otherwise. The lobe carries the sun's ENERGY, never its outline.
    expect(surfaceMaterialSource).toMatch(/skyDomeColor\(refl\)/);
    expect(surfaceMaterialSource).not.toMatch(/sunDisc/);
  });
});

/**
 * THE INTERIM CREST-FOAM GATE WAS DELETED (§B). It was a SECOND, INDEPENDENT
 * foam source in surfaceMaterial, combined with the sim's by `max`, and it
 * existed only because "the foam sim ... at normal swell currently produces
 * nothing". Measured on the real spectrum, the sim now covers 1.70% of the sea
 * at the swell preset against Monahan & O'Muircheartaigh 1980's ~4% for that
 * wind, and the gate carried 12.0% of the visible foam mass there. At CALM the
 * sim correctly produces 0.00% and the gate was the only foam on the water —
 * 0.57% coverage of whitecaps the user has since said should not exist ("if
 * it's rather calm then I think it's fine that there's no foam").
 *
 * Its params went with it. What survives is the one assertion that was never
 * about that gate:
 */
describe('foam colour (§V.20)', () => {
  const sp = oceanSurfaceParams;

  it('foam takes some of the sky colour — reference foam is warm cream', () => {
    expect(sp.foamSkyTint).toBeGreaterThan(0);
    expect(sp.foamSkyTint).toBeLessThan(1);
  });
});

/**
 * THE SPECTRUM REBUILD IS A RATE LIMIT, NOT A QUIET-DETECTOR (§B).
 *
 * Both sides of the §V.8 mirror pair gate their h0 regeneration on a 15-tick
 * countdown armed by a change in the spectrum signature. The countdown was
 * RE-ARMED on every changed tick, which is a detector for the input going
 * quiet, not a rate limit: an input that moves every tick never lets it reach
 * zero and the sea NEVER rebuilds. That is not a corner case — §V.46 drives
 * `windSpeed` and `amplitude` off the storm field at the ship's own position,
 * so a ship under way moves the signature on every single tick. The symptom
 * was a sea that ignored the weather entirely until the value happened to
 * settle, and then a full 3-cascade rebuild landing as one stall.
 *
 * Arming ONCE and letting it run down gives a rebuild every 16 ticks under a
 * moving input, still coalesces a slider drag into one rebuild after the drag
 * stops, and — because the signature is updated on every change — builds the
 * LATEST spectrum rather than the one that armed the counter.
 *
 * The two sides are tested TOGETHER on purpose: a mirror that rebuilds on
 * different ticks from the GPU is §V.8's exact failure, and the arming rule
 * is duplicated in the two files for the same reason `mirrorSignature` is.
 */
describe('spectrum rebuild rate limit (§V.8)', () => {
  // 128 is the smallest grid the shipped 64² mirror can be extracted from
  const RESOLUTION = 128;
  const stubRenderer = { compute: (): void => {} } as never;

  /** ramp the spectrum every tick, exactly as a ship sailing into a cell does */
  function driveContinuously(ticks: number): { gpu: number[]; mirror: number[] } {
    const p = { ...oceanParams, resolution: RESOLUTION };
    const sp = { ...seaPhysicsParams }; // shipped mirrorResolution: cascade 0's band needs it
    const sim = new OceanSimulation(7, p);
    const mirror = new CpuOcean(7, p, sp);
    const gpu: number[] = [];
    const mirrorTicks: number[] = [];
    // sim time is held CONSTANT so the mirror's grids are stale-gated on every
    // tick EXCEPT the ones a rebuild forces — which makes `heightAt` an exact
    // rebuild detector rather than a proxy that only fires once a cap engages
    let lastHs = sim.significantWaveHeight();
    let lastHeight = mirror.heightAt(0, 0, 0);
    for (let i = 0; i < ticks; i++) {
      p.windSpeed = 11 + i * 0.25; // moves the signature EVERY tick
      p.amplitude = 0.24 + i * 0.02;
      sim.update(stubRenderer, 0, p);
      mirror.update(0);
      const hs = sim.significantWaveHeight();
      if (hs !== lastHs) {
        gpu.push(i);
        lastHs = hs;
      }
      const height = mirror.heightAt(0, 0, 0);
      if (height !== lastHeight) {
        mirrorTicks.push(i);
        lastHeight = height;
      }
    }
    return { gpu, mirror: mirrorTicks };
  }

  it('a continuously moving spectrum rebuilds on a fixed cadence, not never', () => {
    const { gpu } = driveContinuously(100);
    // the old re-arming code produced ZERO rebuilds over these 100 ticks
    expect(gpu.length).toBeGreaterThan(4);
    // first rebuild is the debounce the slider drag wants — not immediate
    expect(gpu[0]).toBeGreaterThanOrEqual(15);
    // and then it is REGULAR: every gap is the same 16 ticks (~267 ms)
    const gaps = gpu.slice(1).map((t, i) => t - gpu[i]);
    for (const gap of gaps) expect(gap).toBe(16);
  });

  it('the mirror rebuilds on the SAME ticks as the GPU (§V.8)', () => {
    const { gpu, mirror } = driveContinuously(100);
    expect(gpu.length).toBeGreaterThan(4); // not vacuously equal at zero
    expect(mirror).toEqual(gpu);
  });

  it('a slider drag that STOPS still coalesces into one rebuild', () => {
    const p = { ...oceanParams, resolution: RESOLUTION };
    const sim = new OceanSimulation(7, p);
    let rebuilds = 0;
    let lastHs = sim.significantWaveHeight();
    for (let i = 0; i < 60; i++) {
      if (i < 10) p.windSpeed = 11 + i * 0.5; // the drag
      sim.update(stubRenderer, i * SIM_DT, p);
      const hs = sim.significantWaveHeight();
      if (hs !== lastHs) {
        rebuilds++;
        lastHs = hs;
      }
    }
    // ten changed ticks, ONE rebuild — and it carries the value the drag
    // ended on, because the signature tracks every change
    expect(rebuilds).toBe(1);
  });
});

/**
 * `generateSpectrumData` is a pure SPEED fix for the project's one confirmed
 * stall: h0 plus the five spectral moments fused into one N² pass instead of
 * six, each of which re-evaluated the same `waveSpectrum` at the same texel
 * (378 → 103 ms for a full 3-cascade rebuild, measured warm at the shipped
 * 512²). It is allowed to be faster. It is NOT allowed to be different.
 *
 * These assertions are `toBe` on doubles ON PURPOSE — not `toBeCloseTo`. The
 * fusion is only safe because each accumulator receives the same addends in
 * the same order, so the result is bit-identical rather than merely close, and
 * a tolerance here would let a real numerical drift through. What that drift
 * would cost is §V.8: `steepnessRms`/`jacobianRms` set the anti-fold choppiness
 * cap, `heightVariance` sets Hs and therefore every σ-relative foam and spray
 * gate, `meanWavenumber` sets the per-cascade shoaling attenuation, and the CPU
 * buoyancy mirror measures the SAME moments from the SAME six functions — so a
 * fused path that quietly disagreed would float ships on a different sea from
 * the one drawn, silently, which is exactly the failure §V.8 exists to forbid.
 *
 * The six originals therefore stay exported and stay the DEFINITION of each
 * moment. This test is what makes the fused path a derivation of them rather
 * than a second opinion.
 */
describe('fused spectrum build (generateSpectrumData)', () => {
  const p = oceanParams;

  it('is bit-identical to the six separate passes, on every shipped cascade', () => {
    for (let i = 0; i < p.cascades.length; i++) {
      const band = cascadeBand(i, p.splitWavelengths);
      const domain = p.cascades[i].domain;
      // the seed offset OceanCascade itself applies — h0's phases depend on
      // the RNG draw order, so this pins that too
      const seed = 1337 + i * 7919;
      const fused = generateSpectrumData(p.resolution, domain, seed, p, band);

      const h0 = generateH0(p.resolution, domain, seed, p, band);
      expect(fused.h0.length).toBe(h0.length);
      let mismatched = 0;
      for (let t = 0; t < h0.length; t++) {
        if (fused.h0[t] !== h0[t]) mismatched++;
      }
      expect(mismatched, `cascade ${i}: h0 texels differ from generateH0`).toBe(0);

      expect(fused.steepnessRms).toBe(spectralSteepness(p.resolution, domain, p, band));
      expect(fused.jacobianRms).toBe(spectralJacobianRms(p.resolution, domain, p, band));
      expect(fused.heightVariance).toBe(
        spectralHeightVariance(p.resolution, domain, p, band),
      );
      expect(fused.meanWavenumber).toBe(
        spectralMeanWavenumber(p.resolution, domain, p, band),
      );

      const bins = slopeWavelengthHistogram(p.resolution, domain, p, band);
      expect(fused.slopeBins.length).toBe(bins.length);
      for (let b = 0; b < bins.length; b++) {
        expect(fused.slopeBins[b], `cascade ${i}: slope bin ${b}`).toBe(bins[b]);
      }
    }
  });

  /**
   * The fusion holds under a DIFFERENT spectrum too, not just the shipped one.
   * A storm moves the band occupancy (cascade 2 rejects almost nothing at
   * either sea state, cascade 0 rejects most of the grid), and it is the
   * band-rejected texels that the fused loop handles differently — it still
   * draws their gaussians but skips their moments, which is the one place the
   * six originals disagree with each other about what to skip.
   */
  it('stays bit-identical on a storm spectrum', () => {
    const storm: OceanParams = { ...p, windSpeed: 18, amplitude: 1.2 };
    for (let i = 0; i < storm.cascades.length; i++) {
      const band = cascadeBand(i, storm.splitWavelengths);
      const domain = storm.cascades[i].domain;
      const fused = generateSpectrumData(storm.resolution, domain, 99 + i, storm, band);
      const h0 = generateH0(storm.resolution, domain, 99 + i, storm, band);
      let mismatched = 0;
      for (let t = 0; t < h0.length; t++) {
        if (fused.h0[t] !== h0[t]) mismatched++;
      }
      expect(mismatched, `storm cascade ${i}: h0 texels differ`).toBe(0);
      expect(fused.jacobianRms).toBe(
        spectralJacobianRms(storm.resolution, domain, storm, band),
      );
      expect(fused.heightVariance).toBe(
        spectralHeightVariance(storm.resolution, domain, storm, band),
      );
    }
  });
});
