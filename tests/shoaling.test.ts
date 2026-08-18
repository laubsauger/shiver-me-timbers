/**
 * §V.72 WAVE SHOALING — the sea calms over its own shallows and roughens back
 * to the open-ocean swell on its own.
 *
 * WHAT THESE TESTS ARE FOR (§Rule 6): every assertion below encodes a claim
 * the feature exists to make, not a number someone measured once.
 *  · long swell must feel the bottom before short chop does, or this is a
 *    global fade wearing a physics costume;
 *  · deep water beside land must be UNTOUCHED, which is the entire mechanism
 *    behind "rough cliffs" and the reason no cliff special case exists;
 *  · the shipped open ocean must not move, or a shore feature has silently
 *    retuned the whole sea;
 *  · the drawn surface must never dig through the seabed, at any sea state, or
 *    a lagoon flickers dry once per wave;
 *  · and the GPU's law and the mirror the ship floats on must be one law
 *    (§V.8), not two implementations that agree today.
 *
 * The TSL half cannot be evaluated headless, so — same convention as
 * bandLimit.ts ↔ shipDetail.test.ts — the CPU functions in shoaling.ts are the
 * ones under test, and `tests/oceanBindingBudget.test.ts` plus the call sites
 * are what keep the shader on the same ones.
 */
import { describe, expect, it } from 'vitest';
import {
  breakerClip,
  breakerClipSlope,
  breakerSaturation,
  shoalFactor,
  shoalWavenumber,
  shoalWavenumberFloor,
  tanhCpu,
} from '../src/ocean/shoaling';
import {
  cascadeBand,
  spectralHeightVariance,
  spectralMeanWavenumber,
} from '../src/ocean/oceanMath';
import { oceanParams, type OceanParams } from '../src/params/ocean';
import { islandParams } from '../src/params/island';
import { weatherPresets } from '../src/weather/presets';
import { CpuOcean } from '../src/sea-physics/cpuOcean';
import { seaPhysicsParams } from '../src/params/seaPhysics';

const PRESETS = ['calm', 'swell', 'storm'] as const;
const OPEN_DEPTH = islandParams.seabedOpenDepth;

function preset(name: (typeof PRESETS)[number]): OceanParams {
  return { ...oceanParams, ...weatherPresets[name].ocean };
}

/** the three shoaling wavenumbers for a sea state, as both sides derive them */
function shoalKs(p: OceanParams): number[] {
  return [0, 1, 2].map((i) =>
    shoalWavenumber(
      spectralMeanWavenumber(p.resolution, p.cascades[i].domain, p, cascadeBand(i, p.splitWavelengths)),
      OPEN_DEPTH,
      p,
    ),
  );
}

/** per-cascade elevation RMS (m) for a sea state */
function sigmas(p: OceanParams): number[] {
  return [0, 1, 2].map((i) =>
    Math.sqrt(
      spectralHeightVariance(p.resolution, p.cascades[i].domain, p, cascadeBand(i, p.splitWavelengths)),
    ),
  );
}

describe('§V.72 tanh, written out because TSL has none', () => {
  it('is the real tanh, so the physics arguments about it hold', () => {
    for (const x of [0, 0.1, 0.5, 1, Math.PI, 5, 12]) {
      expect(tanhCpu(x)).toBeCloseTo(Math.tanh(x), 10);
    }
  });

  it('saturates instead of going NaN when the exponential overflows', () => {
    // the shader evaluates this at k·d with d up to the far clipmap's seabed
    // clamp; e^{2x} overflows to +inf in f32 long before that, and the whole
    // point of the 1 − 2/(e+1) form is that inf lands on exactly 1
    expect(tanhCpu(400)).toBe(1);
    expect(Number.isNaN(tanhCpu(400))).toBe(false);
  });

  it('reaches the textbook deep-water criterion at d = λ/2', () => {
    // a wave feels the bottom below half its wavelength — this is the claim
    // the whole model rests on, and tanh delivers it with no authored endpoint
    const lambda = 120;
    const k = (2 * Math.PI) / lambda;
    expect(shoalFactor(k, lambda / 2)).toBeGreaterThan(0.99);
    expect(shoalFactor(k, lambda / 20)).toBeLessThan(0.35);
  });
});

describe('§V.72 the band measurement it keys on', () => {
  it('each cascade reports a wavenumber inside its own band', () => {
    // a weighting bug (by mode count, say) would put the answer outside the
    // band it claims to describe, and every factor downstream would be for a
    // wave that cascade does not carry
    for (const name of PRESETS) {
      const p = preset(name);
      for (let i = 0; i < 3; i++) {
        const band = cascadeBand(i, p.splitWavelengths);
        const k = spectralMeanWavenumber(
          p.resolution,
          p.cascades[i].domain,
          p,
          band,
        );
        expect(k, `${name} cascade ${i}`).toBeGreaterThan(band.kMin);
        expect(k).toBeLessThanOrEqual(band.kMax);
      }
    }
  });

  it('cascade 0 is a different sea in different weather, so it is measured live', () => {
    // the reason this is a measurement and not a baked constant per cascade:
    // the wind sea and the swell train trade dominance inside cascade 0's
    // 40–1010 m band, and its mean wavelength moves by a factor of ~3
    const lambda0 = PRESETS.map((n) => {
      const p = preset(n);
      return (
        (2 * Math.PI) /
        spectralMeanWavenumber(p.resolution, p.cascades[0].domain, p, cascadeBand(0, p.splitWavelengths))
      );
    });
    expect(Math.max(...lambda0) / Math.min(...lambda0)).toBeGreaterThan(2);
  });
});

describe('§V.72 term A: long swell feels the bottom first', () => {
  it('cascade 0 attenuates before cascade 1 before cascade 2, at every depth', () => {
    // THE claim that separates this from a global depth fade. §V.19 band-splits
    // the cascades so each has its own wavelength; if this ordering ever
    // collapses, the sea calms as one lump and the shallows stop reading as
    // shallows.
    for (const name of PRESETS) {
      const ks = shoalKs(preset(name));
      for (const d of [0.5, 1, 2, 4.5, 8, 15, 25]) {
        const f = ks.map((k) => shoalFactor(k, d));
        expect(f[0], `${name} @ ${d} m`).toBeLessThan(f[1]);
        expect(f[1], `${name} @ ${d} m`).toBeLessThan(f[2]);
      }
    }
  });

  it('a cliff into deep water is not calmed — which is why there is no cliff case', () => {
    // the user asked for calm beaches AND rough cliffs. Keying on DEPTH gives
    // both from one rule: a cliff has no shallow band, so it gets no
    // attenuation. This asserts the second half of that sentence.
    for (const name of PRESETS) {
      for (const f of shoalKs(preset(name)).map((k) => shoalFactor(k, OPEN_DEPTH))) {
        expect(f, name).toBeGreaterThan(1 - 1e-4);
      }
    }
  });

  it('the wavenumber floor is what keeps the open ocean where it was', () => {
    // our sea floor is 45 m where a real storm swell would want 71 m, so
    // without the floor the open sea would be damped at storm. Guard the
    // consequence, not the constant: unfloored, storm's longest band is
    // materially attenuated in open water; floored, it is not.
    const p = preset('storm');
    const raw = spectralMeanWavenumber(
      p.resolution,
      p.cascades[0].domain,
      p,
      cascadeBand(0, p.splitWavelengths),
    );
    expect(shoalFactor(raw, OPEN_DEPTH)).toBeLessThan(0.99);
    expect(shoalFactor(shoalWavenumber(raw, OPEN_DEPTH, p), OPEN_DEPTH)).toBeGreaterThan(
      1 - 1e-4,
    );
    // and the floor is derived from the world's own depth, not authored
    expect(shoalWavenumberFloor(OPEN_DEPTH, p)).toBeCloseTo(
      Math.PI / (p.shoalDeepFraction * OPEN_DEPTH),
      12,
    );
  });
});

describe('§V.72 term B: depth-limited breaking', () => {
  it('is EXACTLY the identity below the breaker index', () => {
    // this is what makes term B safe to ship: it is not a small tax on every
    // sea, it is nothing at all until a wave runs out of water column
    const p = oceanParams;
    for (const d of [2, 6, 20, 45]) {
      for (const frac of [0, 0.25, 0.5, 0.77]) {
        const y = frac * p.shoalBreakerIndex * d;
        expect(breakerClip(y, d, p)).toBeCloseTo(y, 12);
        expect(breakerClip(-y, d, p)).toBeCloseTo(-y, 12);
        expect(breakerSaturation(y, d, p)).toBe(0);
      }
    }
  });

  it('never lets a wave occupy the whole water column, however big it is', () => {
    // the playability guarantee: (1 − ceiling)·d of water always remains, so
    // the ocean mesh cannot drop below the sand and flicker a lagoon dry.
    // The bound is ATTAINED, not approached — tanh saturates to exactly 1 once
    // the excess is a few multiples of the knee's width — so `≤` is the honest
    // assertion and the strictly-positive clearance is the line after it.
    const p = oceanParams;
    for (const d of [0.5, 1, 2, 4.5, 10, 30]) {
      for (const y of [-1e3, -50, -10, 10, 50, 1e3]) {
        const clipped = breakerClip(y, d, p);
        expect(Math.abs(clipped)).toBeLessThanOrEqual(p.shoalColumnCeiling * d);
        // NANOMETRE tolerance, and it is the TEST's arithmetic that needs it,
        // not the clip's: `(1 − 0.85)` is 0.15000000000000002 in binary, so
        // the expectation is the thing that rounds. Left explicit rather than
        // loosened to `toBeCloseTo`, which would stop failing for real reasons.
        expect(d - Math.abs(clipped)).toBeGreaterThan(
          (1 - p.shoalColumnCeiling) * d - 1e-9,
        );
      }
    }
  });

  it('has no crease along a depth contour (C1 at the knee)', () => {
    // a hard min() here would draw a painted ring around every island; the
    // slope must be continuous through the join, and the tail's slope at the
    // knee is sech²(0) = 1, matching the identity branch
    const p = oceanParams;
    const d = 5;
    const knee = p.shoalBreakerIndex * d;
    const h = 1e-4;
    const below = (breakerClip(knee - h, d, p) - breakerClip(knee - 2 * h, d, p)) / h;
    const above = (breakerClip(knee + 2 * h, d, p) - breakerClip(knee + h, d, p)) / h;
    expect(below).toBeCloseTo(1, 4);
    expect(above).toBeCloseTo(1, 3);
  });

  it('the slope the normals carry is the clip\'s own derivative', () => {
    // geometry and shading must agree on the flat trough bottoms the clip
    // creates, or a flattened sheet is shaded with the slopes of the wave that
    // was clipped away
    const p = oceanParams;
    const d = 4;
    for (const y of [0.5, 2, 3.2, 4, 8]) {
      const h = 1e-4;
      const numeric = (breakerClip(y + h, d, p) - breakerClip(y - h, d, p)) / (2 * h);
      expect(breakerClipSlope(breakerSaturation(y, d, p))).toBeCloseTo(numeric, 3);
    }
  });

  it('the ceiling must stay above the breaker index or the knee inverts', () => {
    expect(oceanParams.shoalColumnCeiling).toBeGreaterThan(oceanParams.shoalBreakerIndex);
  });
});

/**
 * The end-to-end claims, driven through the mirror the ship actually floats on
 * (§V.8) rather than through the law in isolation — a law that is right and a
 * mirror that does not apply it is the bug this whole feature can have.
 */
describe('§V.72 the shoaled sea, measured on the CpuOcean mirror', () => {
  /** a flat bed at `depth`, which is the only way to assert at a KNOWN depth */
  const flatBed = (depth: number) => ({ heightAt: () => -depth });

  /** min / max surface height over a 320 m patch and 60 s, sampled every 0.5 s */
  function extremes(p: OceanParams, depth: number | null) {
    const cpu = new CpuOcean(1234, p, seaPhysicsParams);
    if (depth !== null) cpu.setSeabed(flatBed(depth), OPEN_DEPTH);
    let min = 0;
    let max = 0;
    const step = 320 / 12;
    for (let t = 0; t <= 60; t += 0.5) {
      for (let iz = 0; iz < 12; iz++) {
        for (let ix = 0; ix < 12; ix++) {
          const h = cpu.heightAt(ix * step, iz * step, t);
          min = Math.min(min, h);
          max = Math.max(max, h);
        }
      }
    }
    return { min, max };
  }

  it('open water is the sea it always was — the shipped look cannot move', () => {
    // a shore feature that quietly retunes the open ocean is the failure mode
    // that would matter most, so it is asserted against the NO-SEABED mirror,
    // i.e. against the code as it behaved before shoaling existed
    for (const name of PRESETS) {
      const p = preset(name);
      const bare = extremes(p, null);
      const deep = extremes(p, OPEN_DEPTH);
      expect(deep.min, `${name} trough`).toBeCloseTo(bare.min, 2);
      expect(deep.max, `${name} crest`).toBeCloseTo(bare.max, 2);
    }
  });

  it('never digs through the seabed, at any sea state or depth', () => {
    // the geometric guarantee. Today's storm trough is −24 m, so everything
    // shallower than 24 m goes dry once a cycle; this is what replaces that.
    for (const name of PRESETS) {
      const p = preset(name);
      for (const d of [1, 2, 4.5, 10, 20]) {
        const { min } = extremes(p, d);
        // strictly above the bed, with the margin the ceiling promises —
        // (1 − ceiling)·d, which storm reaches exactly. Nanometre tolerance
        // for the expectation's own binary rounding; see the clip test.
        expect(d + min, `${name} @ ${d} m`).toBeGreaterThan(
          (1 - p.shoalColumnCeiling) * d - 1e-9,
        );
        expect(d + min, `${name} @ ${d} m`).toBeGreaterThan(0);
      }
    }
  });

  it('a 2 m lagoon holds water at the shipped swell', () => {
    // the number the island's basin depth is downstream of: before shoaling
    // the swell trough was −3.84 m, which is why the showcase basin had to sit
    // at 4.5 m. If this regresses, that basin has to go back down.
    const { min } = extremes(preset('swell'), 2);
    expect(min).toBeGreaterThan(-1.5);
  });

  it('calms the shallows hard while leaving the deep sea alone', () => {
    // the user's ask in one assertion: tame towards the beach, blend to the
    // open ocean swell
    const p = preset('swell');
    const shallow = extremes(p, 2);
    const open = extremes(p, OPEN_DEPTH);
    const shallowRange = shallow.max - shallow.min;
    const openRange = open.max - open.min;
    expect(shallowRange).toBeLessThan(openRange * 0.45);
  });
});

describe('§V.72 the two channels stay separate', () => {
  it('term B is inert at calm and at swell, at every depth', () => {
    // measured, and it is the argument for shipping term B at all: the seas
    // the user has been iterating on get pure linear shoaling, so their look
    // is not exposed to the breaker constants at all
    for (const name of ['calm', 'swell'] as const) {
      const p = preset(name);
      const ks = shoalKs(p);
      const s = sigmas(p);
      for (const d of [1, 2, 3, 4.5, 6, 10, 20, 45]) {
        // a generous 6σ crest of the shoaled sea — well past anything the
        // 60 s mirror sweep above actually produced
        const crest = 6 * Math.hypot(...s.map((v, i) => v * shoalFactor(ks[i], d)));
        expect(breakerSaturation(crest, d, p), `${name} @ ${d} m`).toBe(0);
      }
    }
  });

  it('storm breaks on the shelf where swell does not', () => {
    // "bigger waves crashing onto the shore in a storm", as a property of the
    // model rather than of a dial: the same depth saturates at storm and not
    // at swell, and it does so further out
    const shelf = 4.5;
    const sat = (name: (typeof PRESETS)[number]) => {
      const p = preset(name);
      const ks = shoalKs(p);
      const s = sigmas(p);
      const crest = 3 * Math.hypot(...s.map((v, i) => v * shoalFactor(ks[i], shelf)));
      return breakerSaturation(crest, shelf, p);
    };
    expect(sat('storm')).toBeGreaterThan(0.5);
    expect(sat('swell')).toBe(0);
    expect(sat('calm')).toBe(0);
  });
});
