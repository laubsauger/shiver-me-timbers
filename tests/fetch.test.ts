/**
 * §V.73 FETCH AND SHELTER — water with land upwind of it cannot grow the sea
 * the wind is asking for.
 *
 * WHAT THESE TESTS ARE FOR (§Rule 6). Every assertion below encodes a claim the
 * feature exists to make, and the FIRST of them is the one that matters:
 *
 *  · sheltered water must have a lower Hs AND A SHORTER PEAK WAVELENGTH at the
 *    same wind. The second clause is not a bonus — it is the whole difference
 *    between this and a naive amplitude fade, and it is deliberately here so
 *    that a future "simplification" down to `height *= f(fetch)` FAILS. Short
 *    fetch does not give you a small ocean; it gives you short steep chop;
 *  · steepness must go UP as fetch shortens, which is why enclosed water looks
 *    busy and mean while being objectively tiny;
 *  · open water must be the sea it always was, bit for bit, or a shelter
 *    feature has silently retuned the whole ocean;
 *  · the mirror the ship floats on and the law the shader reads must be ONE
 *    law (§V.8), not two implementations that agree today;
 *  · and the shelter itself must be measured UPWIND — a field that shelters
 *    the windward shore is not a fetch model, it is a distance-to-land fade.
 *
 * The TSL half cannot be evaluated headless — same constraint and the same
 * convention as `tests/shoaling.test.ts` — so the CPU functions in
 * `src/ocean/fetch.ts` are what is under test, and the §V.8 section below plus
 * `tests/oceanBindingBudget.test.ts` are what keep the shader on them.
 */
import { describe, expect, it } from 'vitest';
import surfaceMaterialSource from '../src/ocean/surfaceMaterial.ts?raw';
import cpuOceanSource from '../src/sea-physics/cpuOcean.ts?raw';
import causticsNodeSource from '../src/caustics/causticsNode.ts?raw';
import {
  developmentRatio,
  fetchBandCoefficient,
  fetchBandGain,
  fullyDevelopedFetch,
  fullyDevelopedPeakWavenumber,
  PM_DIMENSIONLESS_FETCH,
  type FetchSource,
} from '../src/ocean/fetch';
import {
  blurField,
  createFetchField,
  sampleGrid,
  sweepFetch,
} from '../src/ocean/fetchField';
import type { SeabedField } from '../src/island/seabed';
import {
  cascadeBand,
  spectralHeightVariance,
  spectralMeanWavenumber,
} from '../src/ocean/oceanMath';
import { oceanParams, type OceanParams } from '../src/params/ocean';
import { seaPhysicsParams } from '../src/params/seaPhysics';
import { weatherPresets } from '../src/weather/presets';
import { CpuOcean, MIRRORED_CASCADES } from '../src/sea-physics/cpuOcean';

function preset(name: 'calm' | 'swell' | 'storm'): OceanParams {
  return { ...oceanParams, ...weatherPresets[name].ocean };
}

/** the per-cascade coefficients, exactly as all three consumers derive them */
function coefficients(p: OceanParams, bands = MIRRORED_CASCADES): number[] {
  const peakK = fullyDevelopedPeakWavenumber(p.windSpeed);
  return Array.from({ length: bands }, (_, i) =>
    fetchBandCoefficient(
      peakK,
      spectralMeanWavenumber(
        p.resolution,
        p.cascades[i].domain,
        p,
        cascadeBand(i, p.splitWavelengths),
      ),
      p,
    ),
  );
}

/** a shelter field reporting the same clear upwind water everywhere */
const uniformFetch = (metres: number): FetchSource => ({ fetchAt: () => metres });

// ───────────────────────────────────────────────────────────────────────────
// THE LAW
// ───────────────────────────────────────────────────────────────────────────

describe('§V.73 the open ocean cannot move', () => {
  it('is EXACTLY 1 at full development, for every band and every sea state', () => {
    // not "close to 1" — the whole design rests on this being an identity, the
    // same way shoaling's wavenumber floor is measured at 5.7e-5 and declared
    // immovable. If this drifts, every preset the user has tuned has moved.
    for (const name of ['calm', 'swell', 'storm'] as const) {
      const p = preset(name);
      for (const c of coefficients(p)) {
        expect(fetchBandGain(c, 1, p), name).toBe(1);
      }
    }
  });

  it('reports full development past the PM limit, however much more fetch there is', () => {
    const p = preset('swell');
    const full = fullyDevelopedFetch(p.windSpeed, p);
    expect(developmentRatio(full, p.windSpeed, p)).toBeCloseTo(1, 12);
    expect(developmentRatio(full * 1e6, p.windSpeed, p)).toBe(1);
  });

  it('the compression is one number, and it is the only thing between us and a dead ocean', () => {
    // the honest statement of the scale problem: uncompressed, full development
    // at the shipped wind needs 271 km and our archipelago is 9 km, so EVERY
    // square metre of the world would be fetch-limited
    const p = preset('swell');
    const real = (PM_DIMENSIONLESS_FETCH * p.windSpeed ** 2) / 9.81;
    expect(real).toBeGreaterThan(250_000);
    expect(fullyDevelopedFetch(p.windSpeed, p)).toBeCloseTo(real / p.fetchWorldScale, 6);
    // and the shipped compression must leave the open sea between islands
    // alone: islands are scattered out to 3.6 km with 400 m gaps, so a
    // full-development distance of ~1 km is comfortably inside open water
    expect(fullyDevelopedFetch(p.windSpeed, p)).toBeLessThan(1500);
  });
});

describe('§V.73 long bands die first — the mechanism that makes chop, not a fade', () => {
  it('a longer wave is suppressed harder than a shorter one, at every ratio', () => {
    // THE structural claim. If this ever inverts, or flattens to "all bands
    // scale together", the model has become an amplitude multiply and the
    // sheltered water will read as a scale model of the ocean outside.
    const p = preset('swell');
    const cs = coefficients(p, 3);
    for (const r of [0.02, 0.05, 0.1, 0.25, 0.5, 0.9]) {
      const g = cs.map((c) => fetchBandGain(c, r, p));
      expect(g[0], `cascade 0 vs 1 @ r=${r}`).toBeLessThan(g[1]);
      expect(g[1], `cascade 1 vs 2 @ r=${r}`).toBeLessThan(g[2]);
    }
  });

  it('the peak MIGRATES: the band that survives gets shorter as shelter tightens', () => {
    // the peak wavelength is not computed anywhere — it is where the surviving
    // energy ends up. This asserts that the survivor moves up in wavenumber.
    const p = preset('swell');
    const cs = coefficients(p, 3);
    const survivor = (r: number): number => {
      const g = cs.map((c) => fetchBandGain(c, r, p));
      return g.indexOf(Math.max(...g));
    };
    // deep shelter is carried by the SHORTEST band, open water by all equally
    expect(survivor(0.05)).toBe(2);
    expect(cs.map((c) => fetchBandGain(c, 1, p))).toEqual([1, 1, 1]);
  });

  it('steepens rather than merely shrinks — the young-sea α term is present', () => {
    // the short band is AMPLIFIED in shelter. This is the term that makes a
    // sheltered anchorage look busy instead of glassy, and the user's standing
    // instruction is that the lagoon must not go glassy.
    const p = preset('swell');
    const shortest = coefficients(p, 3)[2];
    expect(fetchBandGain(shortest, 0.1, p)).toBeGreaterThan(1);
  });
});

describe('§V.73 the second compression: the cutoff cannot become a step', () => {
  it('caps the coefficient of a band far longer than the peak', () => {
    // MEASURED on calm (4 m/s ⟹ peak λ 16 m) where cascade 0's mean λ is 249 m:
    // the raw coefficient is 256 and the gain fell 1.000 → 0.000 across
    // FOURTEEN METRES of fetch, which is a painted ring on the water.
    const calm = preset('calm');
    const raw = fetchBandCoefficient(
      fullyDevelopedPeakWavenumber(calm.windSpeed),
      spectralMeanWavenumber(
        calm.resolution,
        calm.cascades[0].domain,
        calm,
        cascadeBand(0, calm.splitWavelengths),
      ),
      { ...calm, fetchLongBandLimit: 1e6 },
    );
    expect(raw).toBeGreaterThan(200);
    expect(coefficients(calm, 3)[0]).toBe(calm.fetchLongBandLimit ** 2);
  });

  it('the calm step is now a ramp, and swell and storm never reach the cap', () => {
    const calm = preset('calm');
    const full = fullyDevelopedFetch(calm.windSpeed, calm);
    const g0 = (f: number) =>
      fetchBandGain(coefficients(calm, 3)[0], developmentRatio(f, calm.windSpeed, calm), calm);
    // it used to be 0.000 fourteen metres inside the full-development distance
    expect(g0(full * 0.87)).toBeGreaterThan(0.4);
    // the presets the user iterates on are untouched by the cap
    for (const name of ['swell', 'storm'] as const) {
      const p = preset(name);
      for (const c of coefficients(p, 3)) expect(c).toBeLessThan(p.fetchLongBandLimit ** 2);
    }
  });
});

describe('§V.73 §V.44 boundedness', () => {
  it('is never negative and never exceeds the ceiling, at any ratio or band', () => {
    const p = preset('storm');
    for (const c of [0, 1e-6, 0.001, 0.05, 0.5, 5, 500]) {
      for (let r = 0; r <= 1.0001; r += 0.005) {
        const g = fetchBandGain(c, r, p);
        expect(Number.isFinite(g)).toBe(true);
        expect(g).toBeGreaterThanOrEqual(0);
        expect(g).toBeLessThanOrEqual(p.fetchMaxGain + 1e-12);
      }
    }
  });

  it('survives a zero and a NaN fetch instead of poisoning the sea', () => {
    // §V.28: `windDirection` and `windSpeed` are live panel values and the
    // field is sampled per vertex — one NaN here is a NaN ocean for the session
    const p = preset('swell');
    const c = coefficients(p)[0];
    expect(Number.isFinite(fetchBandGain(c, developmentRatio(0, p.windSpeed, p), p))).toBe(true);
    expect(Number.isFinite(fetchBandGain(c, developmentRatio(0, 0, p), p))).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// THE SHELTER FIELD
// ───────────────────────────────────────────────────────────────────────────

describe('§V.73 the shelter field is measured UPWIND', () => {
  const RES = 64;
  const CELL = 25; // m
  const CAP = RES * CELL;

  /** a single island: one block of land in the middle of the grid */
  function islandMask(): Uint8Array {
    const land = new Uint8Array(RES * RES);
    for (let j = 30; j < 34; j++) for (let i = 30; i < 34; i++) land[j * RES + i] = 1;
    return land;
  }

  function swept(windDirection: number): Float32Array {
    const out = new Float32Array(RES * RES);
    sweepFetch(islandMask(), RES, CELL, windDirection, CAP, out);
    return out;
  }

  it('shelters DOWNWIND of land and leaves the windward side at open-sea fetch', () => {
    // the single claim that separates a fetch model from a distance-to-land
    // fade: the same 10 texels away, one side is sheltered and the other is not
    const f = swept(0); // wind blows toward +x, so upwind is −x
    const lee = f[32 * RES + 40]; // 6 cells downwind of the island
    const windward = f[32 * RES + 24]; // 6 cells upwind of it
    expect(lee).toBeLessThan(CAP * 0.2);
    expect(windward).toBe(CAP);
  });

  it('the shadow RECOVERS with distance downwind', () => {
    const f = swept(0);
    const near = f[32 * RES + 36];
    const mid = f[32 * RES + 44];
    const far = f[32 * RES + 56];
    expect(near).toBeLessThan(mid);
    expect(mid).toBeLessThan(far);
    // and the recovery is the honest one: distance travelled since the land
    expect(mid - near).toBeCloseTo((44 - 36) * CELL, 0);
  });

  it('the shadow TURNS with the wind — it is not baked to the island', () => {
    const east = swept(0); // shadow lies at +x of the island
    const north = swept(Math.PI / 2); // shadow lies at +z of the island
    expect(east[32 * RES + 40]).toBeLessThan(CAP * 0.2);
    expect(east[40 * RES + 32]).toBe(CAP);
    expect(north[40 * RES + 32]).toBeLessThan(CAP * 0.2);
    expect(north[32 * RES + 40]).toBe(CAP);
  });

  it('open water with nothing upwind reports the cap EXACTLY, so its gain is exactly 1', () => {
    // this is what makes "the open ocean cannot move" true of the FIELD and
    // not merely of the law: a cell that never meets land must not accumulate
    // some large-but-finite number that quietly limits the sea
    const empty = new Uint8Array(RES * RES);
    const out = new Float32Array(RES * RES);
    for (const dir of [0, 0.7, Math.PI, -2.1]) {
      sweepFetch(empty, RES, CELL, dir, CAP, out);
      for (const v of out) expect(v).toBe(CAP);
    }
  });

  it('is finite in every direction, including the axis-aligned degenerate ones', () => {
    // ux or uz exactly 0 makes one of the sweep's two neighbours degenerate;
    // a divide by it would fill the world with NaN fetch
    for (let d = 0; d < 16; d++) {
      const out = swept((d * Math.PI) / 8);
      for (const v of out) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(CAP);
      }
    }
  });

  it('land itself has no fetch, so nothing can grow a wave on a beach', () => {
    const f = swept(0.4);
    expect(f[32 * RES + 32]).toBe(0);
  });
});

describe('§V.73 the field the two sides share', () => {
  it('the CPU sampler lands on texel centres, so it cannot be half a texel off the shader', () => {
    // §B.34's class of defect. uv = (world − origin)/size and a texel centre is
    // at (i + 0.5)·cell; if the two conventions disagree the mirror reads a
    // different shelter than the shader at the same point.
    const res = 8;
    const cell = 10;
    const origin: [number, number] = [-40, -40];
    const data = new Float32Array(res * res);
    for (let k = 0; k < data.length; k++) data[k] = k;
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const x = origin[0] + (i + 0.5) * cell;
        const z = origin[1] + (j + 0.5) * cell;
        expect(sampleGrid(data, res, origin, cell, x, z)).toBeCloseTo(j * res + i, 9);
      }
    }
  });

  it('clamps to edge outside the field, which is where open ocean lives', () => {
    const res = 4;
    const data = new Float32Array(res * res).fill(7);
    expect(sampleGrid(data, res, [0, 0], 10, -1e6, -1e6)).toBe(7);
    expect(sampleGrid(data, res, [0, 0], 10, 1e6, 1e6)).toBe(7);
  });

  it('the blur band-limits without inventing energy', () => {
    // it is the §V.48 band limit AND the soft edge of the shadow, so it must
    // preserve the constant (no ringing, no bias) and must actually smooth
    const res = 32;
    const data = new Float32Array(res * res).fill(100);
    const scratch = new Float32Array(res * res);
    blurField(data, res, 3, scratch);
    for (const v of data) expect(v).toBeCloseTo(100, 9);

    const step = new Float32Array(res * res);
    for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) step[j * res + i] = i < 16 ? 0 : 100;
    blurField(step, res, 3, scratch);
    // the hard edge is gone: the two cells either side of it are no longer 0/100
    expect(step[16 * res + 15]).toBeGreaterThan(1);
    expect(step[16 * res + 16]).toBeLessThan(99);
  });
});

describe('§V.73 the built field, end to end', () => {
  /**
   * A 200 m island at the origin on a 4 km seabed. Only `heightAt`, `origin`
   * and `size` are read by `createFetchField`; the rest of `SeabedField` is a
   * GPU concern it never touches, which is what lets this test the REAL field
   * rather than a reimplementation of it.
   */
  const seabed = {
    heightAt: (x: number, z: number) => (Math.hypot(x, z) < 200 ? 6 : -45),
    origin: [-2000, -2000] as [number, number],
    size: 4000,
  } as unknown as SeabedField;

  // a coarse field: this test is about the wiring, not the resolution
  const p: OceanParams = { ...oceanParams, fetchFieldSize: 128, fetchFieldMargin: 1000 };
  const field = createFetchField(seabed, p);

  it('spans the seabed plus its margin, and caps at its own span', () => {
    expect(field.size).toBe(4000 + 2 * 1000);
    expect(field.origin).toEqual([-3000, -3000]);
    expect(field.cap).toBe(field.size);
  });

  /** longest band's gain at a sampled shelter — 1 means "open ocean here" */
  const gainAt = (metres: number): number => {
    const q = preset('swell');
    return fetchBandGain(coefficients(q)[0], developmentRatio(metres, q.windSpeed, q), q);
  };

  it('open water far from the island is open ocean EXACTLY, gain and all', () => {
    // the wind blows toward +x by default (windDirection 0.25π), so the far
    // −x/−z corner is upwind of everything
    expect(gainAt(field.fetchAt(-2500, -2500))).toBe(1);
  });

  it('is sheltered downwind of the island and open upwind of it', () => {
    // THE claim, on the real field: the same distance from the same island,
    // one side sheltered and the other untouched. A distance-to-land fade
    // cannot tell these two points apart.
    const d = 400;
    const w = oceanParams.windDirection;
    const lee = field.fetchAt(Math.cos(w) * d, Math.sin(w) * d);
    const windward = field.fetchAt(-Math.cos(w) * d, -Math.sin(w) * d);
    expect(lee).toBeLessThan(field.cap * 0.2);
    // asserted through the GAIN, not the metres: the blur that band-limits the
    // field bleeds ~0.5% of the cap onto the windward side, and it is
    // immaterial precisely because the ratio clamps at full development long
    // before that — which is the property worth pinning, not the raw number
    expect(windward).toBeGreaterThan(field.cap * 0.95);
    expect(gainAt(windward)).toBe(1);
  });

  it('re-sweeps only when the wind has actually turned', () => {
    // the sweep is the model's whole per-direction cost; a rebuild per frame
    // would put it straight into the CPU-bound encode budget
    const before = field.sweepCount;
    expect(field.update(oceanParams.windDirection)).toBe(false);
    expect(field.update(oceanParams.windDirection + 0.001)).toBe(false);
    expect(field.update(oceanParams.windDirection + 0.5)).toBe(true);
    expect(field.sweepCount).toBe(before + 1);
    // and a NaN bearing must not rebuild, or one bad frame is a NaN world
    expect(field.update(NaN)).toBe(false);
  });

  it('never reports a negative or non-finite shelter anywhere', () => {
    for (let i = 0; i < 200; i++) {
      const v = field.fetchAt((i * 137) % 7000 - 3500, (i * 271) % 7000 - 3500);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(field.cap + 1e-3);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// THE BEHAVIOUR — measured on the sea the ship actually floats on
// ───────────────────────────────────────────────────────────────────────────

/**
 * Hs and mean zero-crossing wavelength of the mirror's surface, measured along
 * a transect ALONG THE WIND (which is the direction a wavelength means
 * anything in) at several instants.
 *
 * Deliberately measured rather than derived: a test that recomputed the
 * spectrum would pass even if `CpuOcean` applied the gains to the wrong
 * cascade, which is exactly the §V.8 failure worth catching.
 */
function seaState(p: OceanParams, fetch: FetchSource | null) {
  const cpu = new CpuOcean(4242, p, seaPhysicsParams);
  if (fetch) cpu.setFetch(fetch);
  const dx = Math.cos(p.windDirection);
  const dz = Math.sin(p.windDirection);
  const LENGTH = 2020; // two cascade-0 domains
  const STEP = 0.5;
  const n = Math.floor(LENGTH / STEP);
  let sumSq = 0;
  let count = 0;
  let crossings = 0;
  for (const t of [0, 3.7, 8.1, 12.9, 19.3]) {
    // lateral offset per instant so the five transects are different water
    const ox = -dz * t * 37;
    const oz = dx * t * 37;
    let prev = cpu.heightAt(ox, oz, t);
    for (let s = 1; s < n; s++) {
      const h = cpu.heightAt(ox + dx * s * STEP, oz + dz * s * STEP, t);
      sumSq += h * h;
      count++;
      if (prev <= 0 && h > 0) crossings++;
      prev = h;
    }
  }
  const rms = Math.sqrt(sumSq / count);
  return {
    hs: 4 * rms,
    variance: sumSq / count,
    // mean zero-up-crossing wavelength — total distance walked / crossings
    wavelength: (LENGTH * 5) / Math.max(crossings, 1),
  };
}

/**
 * The DRAWN sea's state at a given fetch: Hs and energy-weighted mean
 * wavelength composed analytically over ALL THREE cascades.
 *
 * WHY THIS EXISTS ALONGSIDE `seaState`, and it is not duplication. The mirror
 * carries cascades 0 and 1 only — cascade 2 is sub-boat-length chop that cannot
 * move a 35 m hull, so mirroring it would be wasted CPU (cpuOcean's header).
 * But cascade 2 is exactly where the young-sea steepening lands and where the
 * visible chop lives, so a steepness claim measured on the mirror is measured
 * on an instrument that is band-limited past the effect. The mirror is the
 * right instrument for "what does the ship feel"; this is the right one for
 * "what does the player see".
 */
function spectralSeaState(p: OceanParams, fetchMetres: number) {
  const bands = [0, 1, 2];
  const ks = bands.map((i) =>
    spectralMeanWavenumber(
      p.resolution,
      p.cascades[i].domain,
      p,
      cascadeBand(i, p.splitWavelengths),
    ),
  );
  const vars = bands.map((i) =>
    spectralHeightVariance(
      p.resolution,
      p.cascades[i].domain,
      p,
      cascadeBand(i, p.splitWavelengths),
    ),
  );
  const cs = coefficients(p, 3);
  const r = developmentRatio(fetchMetres, p.windSpeed, p);
  const gains = cs.map((c) => fetchBandGain(c, r, p));
  const energy = gains.map((g, i) => g * g * vars[i]);
  const total = energy.reduce((a, b) => a + b, 0);
  const meanK = energy.reduce((a, e, i) => a + e * ks[i], 0) / total;
  const hs = 4 * Math.sqrt(total);
  const wavelength = (2 * Math.PI) / meanK;
  return { gains, hs, wavelength, steepness: hs / wavelength };
}

describe('§V.73 the drawn sea gets SHORT STEEP CHOP, not a small ocean', () => {
  // measured on all three cascades — see spectralSeaState for why the mirror
  // is the wrong instrument for this particular claim
  for (const name of ['calm', 'swell', 'storm'] as const) {
    it(`${name}: steepness goes UP as the shelter tightens`, () => {
      const p = preset(name);
      const open = spectralSeaState(p, 1e9);
      const lagoon = spectralSeaState(p, 120);
      expect(lagoon.hs, 'smaller').toBeLessThan(open.hs);
      expect(lagoon.wavelength, 'shorter').toBeLessThan(open.wavelength);
      // THE clause that a naive amplitude fade cannot pass: an amplitude scale
      // divides Hs and leaves the wavelength alone, so its steepness FALLS.
      expect(lagoon.steepness, 'steeper').toBeGreaterThan(open.steepness * 1.15);
    });
  }

  it('the long band is deleted while the short band is AMPLIFIED', () => {
    // the whole mechanism in one assertion, on the shipped default sea
    const g = spectralSeaState(preset('swell'), 120).gains;
    expect(g[0]).toBeLessThan(0.05);
    expect(g[2]).toBeGreaterThan(1);
  });
});

describe('§V.73 sheltered water at the SAME wind', () => {
  const p = preset('swell');
  // ~120 m of clear upwind water: a boat-sized anchorage inside a rim
  const open = seaState(p, uniformFetch(1e9));
  const lagoon = seaState(p, uniformFetch(120));

  it('is SMALLER — lower significant wave height', () => {
    expect(lagoon.hs).toBeLessThan(open.hs * 0.7);
  });

  it('is SHORTER — and this clause is what stops a naive amplitude fade', () => {
    // an amplitude scale leaves the wavelength EXACTLY where it was, so this
    // assertion is unpassable by the simplification someone will propose. The
    // peak has to move because the long bands are gone, not because anything
    // computed a period.
    expect(lagoon.wavelength).toBeLessThan(open.wavelength * 0.7);
  });

  it('is NOT GLASSY — there is still a sea in there', () => {
    // the user's standing instruction. Shelter is not calm; the complaint was
    // that things do not make sense together, never that flat water was wanted.
    expect(lagoon.hs).toBeGreaterThan(0.2);
  });

  it('scales with the wind: the same anchorage is developed in light air', () => {
    // MEASURED full-development distances: 138 m at calm, 1044 m at swell,
    // 2795 m at storm. So a 200 m basin is a fully developed sea in light air
    // and a hard-limited one in a gale, and that falls out of F̃ = gF/U²
    // rather than being a second authored curve. It is also why the model is
    // invisible on the calm preset, which is correct — a sheltered bay and the
    // open sea DO look alike at 4 m/s.
    const calm = preset('calm');
    const storm = preset('storm');
    expect(developmentRatio(200, calm.windSpeed, calm)).toBe(1);
    for (const c of coefficients(calm, 3)) expect(fetchBandGain(c, 1, calm)).toBe(1);
    expect(developmentRatio(200, storm.windSpeed, storm)).toBeLessThan(0.1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// §V.8 — ONE LAW, THREE CONSUMERS
// ───────────────────────────────────────────────────────────────────────────

describe('§V.8 the mirror the ship floats on and the sea that is drawn', () => {
  const p = preset('swell');

  it('an unlimited shelter field is BIT-IDENTICAL to no shelter field at all', () => {
    // the strongest form of "open ocean cannot move": not a tolerance, an
    // identity, asserted through the whole mirror — inverse displacement,
    // per-cascade sum and all. If the fetch path is not a true no-op at full
    // development then every existing buoyancy measurement has moved.
    const bare = new CpuOcean(99, p, seaPhysicsParams);
    const wired = new CpuOcean(99, p, seaPhysicsParams);
    wired.setFetch(uniformFetch(1e9));
    for (let i = 0; i < 40; i++) {
      const x = i * 13.7;
      const z = i * -7.3;
      const t = i * 0.31;
      expect(wired.heightAt(x, z, t)).toBe(bare.heightAt(x, z, t));
      expect(wired.pressureHeadAt(x, z, t)).toBe(bare.pressureHeadAt(x, z, t));
    }
  });

  it('the mirror applies the LAW, per band — measured, then predicted', () => {
    /**
     * THE §V.8 AGREEMENT TEST, in the strongest form that is available without
     * a GPU (the TSL half cannot be evaluated headless — see the file header).
     *
     * The shader multiplies cascade i's displacement by `fetchBandGain(Cᵢ, r)`.
     * So the mirror's surface VARIANCE at ratio r must be Σ gᵢ(r)²·σᵢ², with
     * σᵢ² the mirror's own per-band variance. Measure two ratios, solve for the
     * two σᵢ², then PREDICT a third and compare against measurement.
     *
     * A mirror that applied one gain to every band, or applied band 0's gain to
     * band 1, or evaluated the ratio at the query instead of the grid coord,
     * fits the first two points and MISSES the third. That is what makes this a
     * test of the law rather than of the arithmetic.
     */
    const cs = coefficients(p);
    const full = fullyDevelopedFetch(p.windSpeed, p);
    const gains = (r: number) => cs.map((c) => fetchBandGain(c, r, p));

    const rA = 1;
    const rB = 0.12;
    const rC = 0.3;
    const vA = seaState(p, uniformFetch(full * rA)).variance;
    const vB = seaState(p, uniformFetch(full * rB)).variance;
    const vC = seaState(p, uniformFetch(full * rC)).variance;

    // solve [gA0² gA1²; gB0² gB1²] · [σ0²; σ1²] = [vA; vB]
    const gA = gains(rA).map((g) => g * g);
    const gB = gains(rB).map((g) => g * g);
    const det = gA[0] * gB[1] - gA[1] * gB[0];
    expect(Math.abs(det)).toBeGreaterThan(1e-9);
    const s0 = (vA * gB[1] - gA[1] * vB) / det;
    const s1 = (gA[0] * vB - vA * gB[0]) / det;

    // the fit must be physical: both bands hold energy, and the LONG band
    // holds most of it (which is why deleting it is what calms the water)
    expect(s0).toBeGreaterThan(0);
    expect(s1).toBeGreaterThan(0);
    expect(s0).toBeGreaterThan(s1);

    const gC = gains(rC).map((g) => g * g);
    const predicted = gC[0] * s0 + gC[1] * s1;
    // 6% — the residual is finite-transect sampling, not a law difference
    expect(Math.abs(predicted - vC) / vC).toBeLessThan(0.06);
  });

  it('all three consumers import the ONE law — no second implementation', () => {
    // f62e037 in test form. That bug was `waterHeightNode` summing the RAW
    // cascade displacement while the ocean drew a modulated sum; one sign
    // error's worth of disagreement produced four separate user reports in a
    // day. There are three places that reconstruct this sea and they must all
    // read the same file.
    for (const [name, src] of [
      ['surfaceMaterial (the drawn sea)', surfaceMaterialSource],
      ['cpuOcean (the sea the hull floats on)', cpuOceanSource],
      ['causticsNode (the sea the beach is drowned by)', causticsNodeSource],
    ] as const) {
      expect(src, `${name} must import the fetch law, not reimplement it`).toMatch(
        /from '(\.\.\/ocean|\.)\/fetch'/,
      );
      expect(src, `${name} must use fetchBandGain`).toMatch(/fetchBandGain/);
    }
  });

  it('the field margin covers the shipped storm, or a lee shadow hits the border', () => {
    // an undersized margin truncates the far tail of a shadow at the field
    // edge, where clamp-to-edge takes over — which draws a ring on the water.
    const storm = preset('storm');
    expect(oceanParams.fetchFieldMargin).toBeGreaterThan(
      fullyDevelopedFetch(storm.windSpeed, storm),
    );
  });
});
