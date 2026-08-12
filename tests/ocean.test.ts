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
  naiveIDFT,
  phillips,
  spectralHeightVariance,
  spectralSteepness,
} from '../src/ocean/oceanMath';
import { oceanParams } from '../src/params/ocean';
import { oceanSurfaceParams } from '../src/params/oceanSurface';
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
describe('anti-fold choppiness cap (§B storm, §V6, §V7)', () => {
  // combined RMS ∂Dx/∂x at λ=1, exactly what OceanSimulation.refreshSeaState
  // computes: cascades are independent so their variances add
  const sigmaTotal = (patch: Partial<typeof oceanParams>) => {
    const p = { ...oceanParams, ...patch };
    let variance = 0;
    for (let i = 0; i < 3; i++) {
      const s = spectralSteepness(
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
 * "Rotating the camera should not switch the light off" (user). A glint road
 * IS a specular and SHOULD vanish when you look away — that part is correct
 * and must stay. What must not vanish is the sea reading as sunlit, so the
 * contract is: there is always a view-INDEPENDENT sun response, and the
 * off-axis softening is a broad sky halo, never a faked wide specular.
 */
describe('the sea stays lit from every camera angle (user)', () => {
  it('has a view-independent sun response at all', () => {
    // N·L body scatter + N·L wrap gain: both are functions of the surface
    // normal and the sun only. If either goes to zero the sea goes flat the
    // moment the camera turns away from the sun.
    expect(oceanSurfaceParams.sunScatterStrength).toBeGreaterThan(0);
    expect(oceanSurfaceParams.lightGain).toBeGreaterThan(0);
  });

  it('the off-axis term is a BROAD halo, not a disguised specular', () => {
    // the glint road is pow(N·H, glintRoadPower) — a true specular. The sky
    // sun halo must be far broader, or we have simply faked a view-
    // independent glint, which the user explicitly did not ask for and which
    // would look worse.
    expect(oceanSurfaceParams.skySunGlowPower).toBeLessThan(
      oceanSurfaceParams.glintRoadPower / 4,
    );
    expect(oceanSurfaceParams.skySunGlowStrength).toBeGreaterThan(0);
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

  it('is the identity where the normals are coherent — the glint road stays', () => {
    for (const nh of [0.9, 0.99, 0.999]) {
      expect(lobe(nh, sp.glintRoadPower, 0)).toBeCloseTo(
        Math.pow(nh, sp.glintRoadPower),
        10,
      );
    }
  });

  it('collapses the pixel-to-pixel swing where they are not', () => {
    const p = sp.glintRoadPower; // 180: the tightest lobe in the material
    const a = 0.999;
    const b = 0.985; // one neighbouring pixel, a slightly different wave face
    const raw = lobe(a, p, 0) / lobe(b, p, 0);
    expect(raw).toBeGreaterThan(8); // unfiltered: neighbours differ ~13x
    const filtered = lobe(a, p, 0.05) / lobe(b, p, 0.05);
    expect(filtered).toBeLessThan(2); // filtered: they now agree
  });

  it('can only ever attenuate, never amplify (§V.44 bounded at source)', () => {
    // gain = 1/(1 + p·σ²) with σ² ≥ 0 and capped, so the term is bounded
    // WITHOUT a clamp after the fact
    expect(sp.specularAaStrength).toBeGreaterThanOrEqual(0);
    expect(sp.specularAaMax).toBeGreaterThan(0);
    for (const p of [sp.sparklePower, sp.glintRoadPower, sp.glintTrainPower]) {
      const gain = 1 / (1 + p * sp.specularAaMax);
      expect(gain).toBeGreaterThan(0);
      expect(gain).toBeLessThanOrEqual(1);
    }
  });
});

/**
 * §V.36 crest foam. The user: whitecaps missing entirely, sea reads
 * "synthetic, like a weird liquid", and they want sparse foam even in normal
 * swell. A σ-relative gate gives sparse-in-swell and heavy-in-storm from one
 * number, and cannot rot when the spectrum moves (§B.12 was the same bug).
 */
describe('crest foam gate is sea-state relative (§V.36)', () => {
  const sp = oceanSurfaceParams;

  it('is expressed in sigma, never in metres', () => {
    // a metre constant means "top 7%" on the sea it was written for and
    // something else entirely after any spectrum change
    expect(sp.crestFoamBandHigh).toBeGreaterThan(sp.crestFoamBandLow);
    expect(sp.crestFoamBandLow).toBeGreaterThan(0);
    expect(sp.crestFoamBandLow).toBeLessThan(4);
  });

  it('selects a sparse minority of crests, not a band across the sea', () => {
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
    const above = (n: number) => 0.5 * erfc(n / Math.SQRT2);
    expect(above(sp.crestFoamBandLow)).toBeLessThan(0.12); // sparse in swell
    expect(above(sp.crestFoamBandLow)).toBeGreaterThan(0.01); // but not zero
  });

  it('foam takes some of the sky colour — reference foam is warm cream', () => {
    expect(sp.foamSkyTint).toBeGreaterThan(0);
    expect(sp.foamSkyTint).toBeLessThan(1);
  });

  /**
   * User at the default swell preset: "too long, too white, too thick, too
   * regular, too big — just too chunky, like a milk cut." The shape cause is
   * that a smooth gate on a smooth field yields a connected CONTOUR, i.e. one
   * unbroken ribbon per crest line.
   */
  it('is broken up by a noise gate, or it draws ribbons along every crest', () => {
    // the gate has to exist and be a real window, not a pass-through
    expect(sp.crestFoamPatchHigh).toBeGreaterThan(sp.crestFoamPatchLow);
    expect(sp.crestFoamPatchLow).toBeGreaterThan(0);
    expect(sp.crestFoamPatchHigh).toBeLessThanOrEqual(1);
    // and it has to select the UPPER part of the break-up field (mean 0.5),
    // so it removes coverage rather than merely modulating it — a window
    // centred at or below the mean would leave the ribbon essentially intact
    expect((sp.crestFoamPatchLow + sp.crestFoamPatchHigh) / 2).toBeGreaterThan(0.5);
    // and its features must be big enough to read as patches on a wave, not
    // as a texture: a metre-scale field would just look like grain
    expect(sp.crestFoamPatchScale).toBeGreaterThan(5);
  });

  it('keeps the patch BODY translucent and only the breaking edge white', () => {
    // thin foam takes the water and sky under it; "milk cut" is what a
    // near-opaque body reads as
    expect(sp.crestFoamStrength).toBeLessThan(0.45);
    expect(sp.crestFoamEdgeStrength).toBeGreaterThan(sp.crestFoamStrength * 2);
    expect(sp.crestFoamEdgeStrength).toBeLessThanOrEqual(1);
    // the edge sits ABOVE the crest band, so it is a lip and not a second
    // coat over the whole patch
    expect(sp.crestFoamEdgeWidth).toBeGreaterThan(0);
  });

  /**
   * §V.36's promise is that ONE pair of numbers serves calm/swell/storm. That
   * only holds if something in the gate is NOT σ-relative: a σ-relative pair
   * on both axes gives literally constant coverage at every sea state, and
   * the user wants sparse in swell and heavy in storm.
   */
  it('scales with sea state through the SLOPE gate, not the height band', () => {
    // the height band is in σ (keeps meaning "crest tops" when the spectrum
    // moves — §B.12), the slope gate is absolute (a storm sea is genuinely
    // steeper, so coverage rises without any per-preset number)
    expect(sp.crestFoamSlopeGate).toBeGreaterThan(0);
    expect(sp.crestFoamSlopeGate).toBeLessThan(1.5);
    // sanity: an absolute slope gate must sit inside the range real sea
    // slopes span, or it is either always on or always off
    const coverage = (slopeRms: number) =>
      Math.min(1, slopeRms / sp.crestFoamSlopeGate);
    expect(coverage(0.12)).toBeLessThan(0.6); // swell: sparse
    expect(coverage(0.34)).toBeGreaterThan(0.9); // storm: heavy
  });
});
