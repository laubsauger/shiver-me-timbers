/**
 * §V.72 (amended by §T.190) WAVE SHOALING — the sea GROWS over its own
 * shallows, BREAKS when the column can no longer hold it, and dies away to the
 * waterline. Open water is untouched, bit for bit.
 *
 * WHAT THESE TESTS ARE FOR (§Rule 6, §V.80): every assertion encodes a claim the
 * feature exists to make, not a number someone measured once.
 *  · growth is LINEAR THEORY's (energy flux conserved at the group velocity),
 *    not a curve someone liked — so it is checked against an independent
 *    Newton solve of the dispersion relation, and against Green's law;
 *  · breaking caps the local Hs at γ·d everywhere, and the surf zone decays to
 *    nothing at the shore — or a beach has no surf line, or the sea digs
 *    through the sand;
 *  · breaking is ONE factor for the whole sea, so it keeps every band's share
 *    of the energy — or a surf zone is a different sea, not a smaller one;
 *  · long swell feels the bottom before short chop;
 *  · deep water beside land is EXACTLY the open ocean, which is the whole
 *    mechanism behind "rough cliffs" and the proof the shipped sea did not move;
 *  · and the GPU's law, the mirror the hull floats on, and the receiver the
 *    beach is drowned by are ONE law (§V.8, §V.77), checked numerically on the
 *    float32 node graph and not by regex alone.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { float, positionWorld, uniform } from 'three/tsl';
import {
  breakerClip,
  breakerClipSlope,
  breakerSaturation,
  groupVelocityRatio,
  shallowWaterKd,
  SHOAL_DEEP_KD,
  shoalBandGains,
  shoalingCoefficient,
  shoalSurfNodes,
  shoalWavenumber,
  shoalWavenumberFloor,
  surfBreakingFactor,
  surfBreakingIntensity,
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
import { createOceanSim } from '../src/ocean';
import { createCaustics } from '../src/caustics';
import surfaceMaterialSource from '../src/ocean/surfaceMaterial.ts?raw';
import cpuOceanSource from '../src/sea-physics/cpuOcean.ts?raw';
import causticsNodeSource from '../src/caustics/causticsNode.ts?raw';
import shoreFoamSource from '../src/foam/shoreFoam.ts?raw';

const PRESETS = ['calm', 'swell', 'storm'] as const;
const OPEN_DEPTH = islandParams.seabedOpenDepth;
const G = 9.81;

function preset(name: (typeof PRESETS)[number]): OceanParams {
  return { ...oceanParams, ...weatherPresets[name].ocean };
}

const memo = new Map<string, number[]>();
/** spectrum integrals at 512² are slow; the preset objects are rebuilt per call, so key on content */
function cached(tag: string, p: OceanParams, f: () => number[]): number[] {
  const key = tag + JSON.stringify(p);
  if (!memo.has(key)) memo.set(key, f());
  return memo.get(key)!;
}

/** the three shoaling wavenumbers for a sea state, as every consumer derives them */
function shoalKs(p: OceanParams): number[] {
  return cached('k', p, () => [0, 1, 2].map((i) =>
    shoalWavenumber(
      spectralMeanWavenumber(p.resolution, p.cascades[i].domain, p, cascadeBand(i, p.splitWavelengths)),
      OPEN_DEPTH,
      p,
    ),
  ));
}

/** per-cascade elevation RMS (m) for a sea state */
function sigmas(p: OceanParams): number[] {
  return cached('s', p, () => [0, 1, 2].map((i) =>
    Math.sqrt(
      spectralHeightVariance(p.resolution, p.cascades[i].domain, p, cascadeBand(i, p.splitWavelengths)),
    ),
  ));
}

/** local significant height (m) the law leaves at `depth` */
function hsAt(p: OceanParams, depth: number, external: number[] | null = null): number {
  const s = sigmas(p);
  const g = shoalBandGains(depth, shoalKs(p), s, external, p, []);
  return 4 * Math.hypot(...s.map((v, i) => v * g[i]));
}

/** INDEPENDENT reference: Newton on ω² = g·k·tanh(k·d), from the deep-water k₀ */
function exactKd(k0: number, d: number): number {
  const omega2 = G * k0;
  let k = Math.max(k0, Math.sqrt(omega2 / (G * Math.max(d, 1e-9))));
  for (let it = 0; it < 60; it++) {
    const t = Math.tanh(k * d);
    const f = G * k * t - omega2;
    const df = G * t + G * k * d * (1 - t * t);
    k -= f / df;
  }
  return k * d;
}

/** INDEPENDENT reference Ks = √(cg_deep/cg) from the textbook n = ½(1 + 2kd/sinh 2kd) */
function textbookKs(kd: number): number {
  const n = 0.5 * (1 + (2 * kd) / Math.sinh(2 * kd));
  return 1 / Math.sqrt(2 * n * Math.tanh(kd));
}

// ───────────────────────────────────────────────────────────────────────────
// float32 evaluator for the TSL twin (same convention as swellShadow.test.ts)
// ───────────────────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function evalTsl(n: any): number {
  const f = Math.fround;
  if (n.isConstNode) return f(n.value);
  if (n.isUniformNode) return f(n.value);
  if (n.type === 'SplitNode' && n.node?.isUniformNode) {
    return f((n.node.value as THREE.Vector2)[n.components as 'x' | 'y']);
  }
  if (n.isOperatorNode) {
    const a = evalTsl(n.aNode);
    const b = evalTsl(n.bNode);
    switch (n.op) {
      case '+': return f(a + b);
      case '-': return f(a - b);
      case '*': return f(a * b);
      case '/': return f(a / b);
    }
  }
  if (n.isMathNode) {
    const a = evalTsl(n.aNode);
    switch (n.method) {
      case 'sqrt': return f(Math.sqrt(a));
      case 'exp': return f(Math.exp(a));
      case 'abs': return f(Math.abs(a));
      case 'pow': return f(Math.pow(a, evalTsl(n.bNode)));
      case 'max': return f(Math.max(a, evalTsl(n.bNode)));
      case 'min': return f(Math.min(a, evalTsl(n.bNode)));
    }
  }
  if (n.node) return evalTsl(n.node);
  throw new Error(`evalTsl: unsupported node ${n.type ?? n.constructor?.name} ${n.op ?? n.method ?? ''}`);
}

describe('§V.72 tanh, written out because TSL has none', () => {
  it('is the real tanh, so the physics arguments about it hold', () => {
    for (const x of [0, 0.1, 0.5, 1, Math.PI, 5, 12]) {
      expect(tanhCpu(x)).toBeCloseTo(Math.tanh(x), 10);
    }
  });

  it('saturates instead of going NaN when the exponential overflows', () => {
    expect(tanhCpu(400)).toBe(1);
    expect(Number.isNaN(tanhCpu(400))).toBe(false);
  });
});

describe('§V.72 the band measurement it keys on', () => {
  it('each cascade reports a wavenumber inside its own band', () => {
    // a weighting bug (by mode count, say) would put the answer outside the
    // band it claims to describe, and every gain downstream would be for a
    // wave that cascade does not carry
    for (const name of PRESETS) {
      const p = preset(name);
      for (let i = 0; i < 3; i++) {
        const band = cascadeBand(i, p.splitWavelengths);
        const k = spectralMeanWavenumber(p.resolution, p.cascades[i].domain, p, band);
        expect(k, `${name} cascade ${i}`).toBeGreaterThan(band.kMin);
        expect(k).toBeLessThanOrEqual(band.kMax);
      }
    }
  });

  it('cascade 0 is a different sea in different weather, so it is measured live', () => {
    const lambda0 = PRESETS.map((n) => {
      const p = preset(n);
      return (2 * Math.PI) /
        spectralMeanWavenumber(p.resolution, p.cascades[0].domain, p, cascadeBand(0, p.splitWavelengths));
    });
    expect(Math.max(...lambda0) / Math.min(...lambda0)).toBeGreaterThan(2);
  });
});

describe('§T.190 term A: shoaling growth is linear theory', () => {
  it('the local kd is the dispersion relation\'s, within Fenton & McKee\'s 1.7%', () => {
    // the amplitude law is a function of the LOCAL kd; an approximation that
    // drifts from ω² = gk·tanh(kd) would grow waves at the wrong depths
    for (const k0 of [0.03, 0.1164, 0.5, 1.6]) {
      for (const d of [0.05, 0.3, 1, 3, 10, 30, 80]) {
        const exact = exactKd(k0, d);
        expect(Math.abs(shallowWaterKd(k0, d) / exact - 1), `k0=${k0} d=${d}`).toBeLessThan(0.017);
      }
    }
  });

  it('cg/cg_deep written without sinh IS the textbook 2n·tanh(kd)', () => {
    for (const kd of [1e-3, 0.05, 0.3, 1, 2, Math.PI]) {
      expect(groupVelocityRatio(kd)).toBeCloseTo(2 * 0.5 * (1 + (2 * kd) / Math.sinh(2 * kd)) * Math.tanh(kd), 10);
    }
  });

  it('Ks matches the analytic Ks(kd) of energy-flux conservation', () => {
    // normalised at d = λ/2 so deep water is exactly 1: the claim is that the
    // SHAPE is linear theory's, to the dispersion approximation's accuracy
    const norm = textbookKs(SHOAL_DEEP_KD);
    for (const k0 of [0.05, 0.1164, 0.4]) {
      for (const d of [0.2, 0.5, 1, 2, 4, 8, 15]) {
        const kd = exactKd(k0, d);
        if (kd >= SHOAL_DEEP_KD) continue;
        const want = textbookKs(kd) / norm;
        expect(Math.abs(shoalingCoefficient(k0, d) / want - 1), `k0=${k0} d=${d} kd=${kd.toFixed(2)}`)
          .toBeLessThan(0.02);
      }
    }
  });

  it('grows (Ks > 1) as the water shoals, following Green\'s law d^(−1/4) in the shallow limit', () => {
    const k0 = 0.1164;
    // growth is real: well inside the shallow-water zone every band is taller
    expect(shoalingCoefficient(k0, 1)).toBeGreaterThan(1.2);
    // and it is Green's: 16× shallower ⟹ 2× taller, once kd ≪ 1
    const ratio = shoalingCoefficient(k0, 0.01) / shoalingCoefficient(k0, 0.16);
    expect(ratio).toBeGreaterThan(1.9);
    expect(ratio).toBeLessThan(2.1);
  });

  it('there is a shoaling zone where waves have GROWN and not yet broken', () => {
    // the whole point of §T.190: growth BEFORE breaking. At calm the long band
    // is taller than in open water at depths where the breaking factor is 1
    const p = preset('calm');
    const ks = shoalKs(p);
    const s = sigmas(p);
    let grownUnbroken = 0;
    for (let d = 1; d <= 6; d += 0.1) {
      const hs0 = 4 * Math.hypot(...ks.map((k, i) => s[i] * shoalingCoefficient(k, d)));
      if (surfBreakingFactor(hs0, d, p) === 1 && shoalBandGains(d, ks, s, null, p, [])[0] > 1) grownUnbroken++;
    }
    expect(grownUnbroken).toBeGreaterThan(3);
  });

  it('long swell feels the bottom before short chop does', () => {
    // §V.19's point: the transition out of deep water happens at a depth set by
    // each band's own wavelength, so the long band leaves the identity first
    for (const name of PRESETS) {
      const ks = shoalKs(preset(name));
      const leaves = ks.map((k) => {
        let d = 60;
        while (d > 0.01 && shoalingCoefficient(k, d) === 1) d -= 0.05;
        return d;
      });
      expect(leaves[0], name).toBeGreaterThan(leaves[1]);
      expect(leaves[1], name).toBeGreaterThan(leaves[2]);
    }
  });

  it('is NaN-free and finite from dry land to the abyss (§V.28)', () => {
    for (const k of [0, 1e-9, 0.1164, 5]) {
      for (const d of [-5, 0, 1e-12, 1e-3, 1, 1e6]) {
        expect(Number.isFinite(shoalingCoefficient(k, d)), `k=${k} d=${d}`).toBe(true);
        for (const g of shoalBandGains(d, [k, k], [1, 1e3], null, oceanParams, [])) {
          expect(Number.isFinite(g), `gain k=${k} d=${d}`).toBe(true);
        }
      }
    }
  });
});

describe('§T.190 open water is the open ocean, bit for bit', () => {
  it('every band at every preset is EXACTLY the identity at the world\'s open depth', () => {
    for (const name of PRESETS) {
      const p = preset(name);
      const ext = [0.93, 1, 1.21];
      const g = shoalBandGains(OPEN_DEPTH, shoalKs(p), sigmas(p), ext, p, []);
      // toBe, not toBeCloseTo: the external gains pass through unmodified
      expect(g, name).toEqual(ext);
      for (let i = 0; i < 3; i++) expect(g[i]).toBe(ext[i]);
    }
  });

  it('the wavenumber floor is what keeps the open ocean exact', () => {
    // our sea floor is 45 m where a real storm swell wants 71 m; without the
    // floor the open sea would be SHOALED at storm. Guard the consequence.
    const p = preset('storm');
    const raw = spectralMeanWavenumber(p.resolution, p.cascades[0].domain, p, cascadeBand(0, p.splitWavelengths));
    expect(shoalingCoefficient(raw, OPEN_DEPTH)).not.toBe(1);
    expect(shoalingCoefficient(shoalWavenumber(raw, OPEN_DEPTH, p), OPEN_DEPTH)).toBe(1);
    expect(shoalWavenumberFloor(OPEN_DEPTH, p)).toBeCloseTo(Math.PI / (p.shoalDeepFraction * OPEN_DEPTH), 12);
  });

  it('a cliff into deep water stays rough to the rock — there is no cliff case', () => {
    // a plunging coast has no shallow band: one metre off the rock it is 40 m
    // deep, and the law must leave the sea EXACTLY alone there
    const cliff = { heightAt: (x: number) => (x < 0 ? 12 : -40) };
    const bare = new CpuOcean(99, preset('storm'), seaPhysicsParams);
    const cliffSea = new CpuOcean(99, preset('storm'), seaPhysicsParams);
    cliffSea.setSeabed(cliff, OPEN_DEPTH);
    for (let i = 0; i < 40; i++) {
      const x = 30 + i * 3.7;
      const t = i * 0.41;
      expect(cliffSea.heightAt(x, i * 5.3, t), `x=${x}`).toBe(bare.heightAt(x, i * 5.3, t));
    }
  });
});

describe('§T.190 term B: depth-limited breaking', () => {
  it('H ≤ γ·d everywhere: the local Hs never exceeds the breaker limit', () => {
    for (const name of PRESETS) {
      const p = preset(name);
      for (let d = 0; d <= 40; d += 0.25) {
        for (const ext of [null, [0.5, 1, 1.25]]) {
          expect(hsAt(p, d, ext), `${name} d=${d}`).toBeLessThanOrEqual(p.shoalSurfGamma * d + 1e-9);
        }
      }
    }
    // and for any incoming sea at all, however absurd
    for (const hs of [0, 0.1, 3, 40, 1e4]) {
      for (const d of [0, 0.5, 3, 20]) {
        expect(hs * surfBreakingFactor(hs, d, oceanParams)).toBeLessThanOrEqual(oceanParams.shoalSurfGamma * d + 1e-9);
      }
    }
  });

  it('the surf zone decays toward shore, to nothing at the waterline', () => {
    // saturated surf: Hs = γ·d, monotone to 0. A surf zone that held its
    // height to the sand is a wall of water on the beach.
    for (const name of PRESETS) {
      const p = preset(name);
      let prev = Infinity;
      for (let d = 2; d >= 0; d -= 0.05) {
        const hs = hsAt(p, d);
        expect(hs, `${name} d=${d.toFixed(2)}`).toBeLessThanOrEqual(prev + 1e-12);
        prev = hs;
      }
      expect(hsAt(p, 0), name).toBe(0);
      expect(hsAt(p, 0.5) / 0.5, `${name} saturated`).toBeCloseTo(p.shoalSurfGamma, 2);
    }
  });

  it('is EXACTLY 1 below the onset knee, and C1 through it', () => {
    const p = oceanParams;
    const d = 5;
    const knee = p.shoalSurfOnset * p.shoalSurfGamma * d;
    for (const hs of [0.01, 0.5, knee * 0.99, knee]) expect(surfBreakingFactor(hs, d, p)).toBe(1);
    const h = 1e-5;
    const out = (x: number) => x * surfBreakingFactor(x, d, p);
    const below = (out(knee - h) - out(knee - 2 * h)) / h;
    const above = (out(knee + 2 * h) - out(knee + h)) / h;
    expect(below).toBeCloseTo(1, 4);
    expect(above).toBeCloseTo(1, 3);
  });

  it('keeps every band\'s share of the energy: a surf zone is the same sea, smaller', () => {
    const p = preset('swell');
    const ks = shoalKs(p);
    const s = sigmas(p);
    for (const d of [0.5, 1, 2, 3]) {
      const g = shoalBandGains(d, ks, s, null, p, []);
      const ks0 = ks.map((k) => shoalingCoefficient(k, d));
      expect(g[0] / g[2], `d=${d}`).toBeCloseTo(ks0[0] / ks0[2], 10);
      expect(g[1] / g[2], `d=${d}`).toBeCloseTo(ks0[1] / ks0[2], 10);
    }
  });

  it('shelter and shoaling compose without double-counting', () => {
    // fetch/shadow decide how much wave ARRIVES; breaking caps what arrived.
    // A sheltered sea therefore starts breaking closer in, and once both are
    // saturated they are the SAME surf (γ·d) — the shelter cannot be applied
    // a second time on top of the cap.
    const p = preset('swell');
    const onset = (ext: number[] | null) => {
      let d = 30;
      const ks = shoalKs(p);
      const s = sigmas(p);
      while (d > 0.05) {
        const g0 = ks.map((k, i) => shoalingCoefficient(k, d) * (ext ? ext[i] : 1));
        if (surfBreakingFactor(4 * Math.hypot(...g0.map((g, i) => g * s[i])), d, p) < 1) return d;
        d -= 0.05;
      }
      return 0;
    };
    const lee = [0.4, 1, 1];
    expect(onset(lee)).toBeLessThan(onset(null));
    expect(hsAt(p, 0.6, lee)).toBeCloseTo(hsAt(p, 0.6, null), 6);
  });

  it('the surf line moves offshore as the sea grows', () => {
    // "bigger waves break further out" as a property of the model, not a dial
    const breaks = (name: (typeof PRESETS)[number]) => {
      const p = preset(name);
      const ks = shoalKs(p);
      const s = sigmas(p);
      for (let d = 45; d > 0.05; d -= 0.05) {
        const hs0 = 4 * Math.hypot(...ks.map((k, i) => s[i] * shoalingCoefficient(k, d)));
        if (surfBreakingFactor(hs0, d, p) < 1) return d;
      }
      return 0;
    };
    expect(breaks('storm')).toBeGreaterThan(breaks('swell'));
    expect(breaks('swell')).toBeGreaterThan(breaks('calm'));
  });

  it('breaking intensity is 0 outside the surf and rises into it', () => {
    const p = preset('swell');
    const ks = shoalKs(p);
    const s = sigmas(p);
    const intensity = (d: number) => {
      const hs0 = 4 * Math.hypot(...ks.map((k, i) => s[i] * shoalingCoefficient(k, d)));
      return surfBreakingIntensity(surfBreakingFactor(hs0, d, p));
    };
    expect(intensity(20)).toBe(0);
    expect(intensity(OPEN_DEPTH)).toBe(0);
    expect(intensity(1)).toBeGreaterThan(intensity(3));
    expect(intensity(3)).toBeGreaterThan(0);
  });
});

describe('§V.72 term C: the column guard (unchanged since before §T.190)', () => {
  it('is EXACTLY the identity below the breaker index', () => {
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
    const p = oceanParams;
    for (const d of [0.5, 1, 2, 4.5, 10, 30]) {
      for (const y of [-1e3, -50, -10, 10, 50, 1e3]) {
        const clipped = breakerClip(y, d, p);
        expect(Math.abs(clipped)).toBeLessThanOrEqual(p.shoalColumnCeiling * d);
        expect(d - Math.abs(clipped)).toBeGreaterThan((1 - p.shoalColumnCeiling) * d - 1e-9);
      }
    }
  });

  it('has no crease along a depth contour (C1 at the knee)', () => {
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

  it('with Hs ≤ γ·d the guard is not the look: a 5σ crest never reaches its knee', () => {
    // the two channels stay disjoint — breaking shapes the sea, the guard only
    // guarantees the column
    for (const name of PRESETS) {
      const p = preset(name);
      for (const d of [0.5, 1, 2, 3, 4.5, 6, 10, 20, 45]) {
        const crest = 5 * (hsAt(p, d) / 4);
        expect(breakerSaturation(crest, d, p), `${name} @ ${d} m`).toBe(0);
      }
    }
  });
});

/**
 * The end-to-end claims, driven through the mirror the hull actually floats on
 * (§V.8) rather than through the law in isolation.
 */
describe('§V.72/§T.190 the shoaled sea, measured on the CpuOcean mirror', () => {
  const flatBed = (depth: number) => ({ heightAt: () => -depth });

  function patch(p: OceanParams, depth: number | null, read: 'height' | 'head' = 'height') {
    const cpu = new CpuOcean(1234, p, seaPhysicsParams);
    if (depth !== null) cpu.setSeabed(flatBed(depth), OPEN_DEPTH);
    const out: number[] = [];
    const step = 320 / 12;
    for (let t = 0; t <= 60; t += 0.5) {
      for (let iz = 0; iz < 12; iz++) {
        for (let ix = 0; ix < 12; ix++) {
          out.push(read === 'height'
            ? cpu.heightAt(ix * step, iz * step, t)
            : cpu.pressureHeadAt(ix * step, iz * step, t));
        }
      }
    }
    return out;
  }
  const std = (xs: number[]) => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
  };

  it('open water is the sea it always was — bit for bit, not "close"', () => {
    for (const name of PRESETS) {
      const p = preset(name);
      const bare = patch(p, null);
      const deep = patch(p, OPEN_DEPTH);
      let same = true;
      for (let i = 0; i < bare.length; i++) if (bare[i] !== deep[i]) same = false;
      expect(same, name).toBe(true);
    }
  });

  it('never digs through the seabed, at any sea state or depth', () => {
    for (const name of PRESETS) {
      const p = preset(name);
      for (const d of [1, 2, 4.5, 10, 20]) {
        const min = Math.min(...patch(p, d));
        expect(d + min, `${name} @ ${d} m`).toBeGreaterThan((1 - p.shoalColumnCeiling) * d - 1e-9);
      }
    }
  });

  it('the mirror carries the law: the floated sea is the breaking-limited one', () => {
    // buoyancy must feel what the law says is there. Over a 2.5 m bar at swell
    // the attenuation-only law (tanh(k·d) per band, the pre-§T.190 sea) left
    // 35% of the open-sea RMS in the two mirrored bands; the growth+breaking
    // sea leaves the γ·d surf, measured 54% — half as much water again.
    // Measured as a RATIO on one realization, so the mirror's own sampling
    // statistics cancel.
    const p = preset('swell');
    const d = 2.5;
    const open = std(patch(p, OPEN_DEPTH));
    const bar = std(patch(p, d));
    const ks = shoalKs(p);
    const s = sigmas(p);
    const two = (g: number[]) => Math.hypot(s[0] * g[0], s[1] * g[1]) / Math.hypot(s[0], s[1]);
    const oldRatio = two(ks.map((k) => tanhCpu(k * d)));
    const newRatio = two(shoalBandGains(d, ks, s, null, p, []));
    expect(bar / open).toBeGreaterThan(1.3 * oldRatio);
    expect(Math.abs(bar / open / newRatio - 1)).toBeLessThan(0.15);
    // and the pressure head a hull integrates sees the same bigger sea
    const headRatio = std(patch(p, d, 'head')) / std(patch(p, OPEN_DEPTH, 'head'));
    expect(headRatio).toBeGreaterThan(1.3 * oldRatio);
  });
});

describe('§V.8/§V.77 ONE law: GPU material, CPU mirror, beach receiver, shore foam', () => {
  it('every consumer imports the shared gain, none keeps a private formula', () => {
    expect(surfaceMaterialSource).toMatch(/shoalBandGainNodes\(shoalDepth, uShoalK, uShoalSigma, external, uSurf\)/);
    expect(causticsNodeSource).toMatch(/shoalBandGainNodes\(shoal\.depth, shoal\.u\.k, shoal\.u\.sigma, external, shoal\.u\.surf\)/);
    expect(cpuOceanSource).toMatch(/shoalBandGains\(depth, this\.shoalK, this\.shoalSigma, ext, this\.oceanP, this\.shoalGains\)/);
    expect(shoreFoamSource).toMatch(/shoalSurfNodes\(depth,/);
    // breaking foam keys on the SAME B the drawn gains carry — not a second
    // criterion — and it is added to the waterline drive, not replacing it
    expect(shoreFoamSource).toMatch(/const gain = shoal\.gains\[i\]/);
    // (§T.193: concentrated on the crest and steep face by the shoaling harmonic)
    expect(shoreFoamSource).toMatch(/near\.max\(shoal\.breaking\.mul\(face\)\)/);
    // the per-band attenuation that preceded §T.190 must not survive anywhere
    for (const src of [surfaceMaterialSource, causticsNodeSource, cpuOceanSource, shoreFoamSource]) {
      expect(src).not.toMatch(/shoalFactor/);
      expect(src).not.toMatch(/tanhNode\(|tanhCpu\(/);
    }
    // the σ each consumer feeds breaking is the spectrum's, from the SAME field
    expect(surfaceMaterialSource).toMatch(/uShoalSigma\[i\]\.value = Math\.sqrt\(Math\.max\(c\.heightVariance, 0\)\)/);
    expect(causticsNodeSource).toMatch(/u\.sigma\[i\]\.value = Math\.sqrt\(Math\.max\(c\.heightVariance, 0\)\)/);
    expect(cpuOceanSource).toMatch(/this\.shoalSigma = bands\.map\(\(c\) => Math\.sqrt\(Math\.max\(c\.heightVariance, 0\)\)\)/);
    expect(shoreFoamSource).toMatch(/u\.sigma\.value = Math\.sqrt\(Math\.max\(c\.heightVariance, 0\)\)/);
  });

  it('the float32 node graph computes the CPU mirror\'s numbers', () => {
    const p = preset('swell');
    const uK = [0, 1, 2].map(() => uniform(0));
    const uS = [0, 1, 2].map(() => uniform(0));
    const uE = [0, 1, 2].map(() => uniform(1));
    const uD = uniform(0);
    const uSurf = uniform(new THREE.Vector2(p.shoalSurfGamma, p.shoalSurfOnset));
    const nodes = shoalSurfNodes(uD, uK, uS, uE, uSurf);
    const ks = shoalKs(p);
    const s = sigmas(p);
    for (const [kScale, sScale, ext] of [[1, 1, [1, 1, 1]], [1, 3, [0.5, 0.9, 1.2]], [4, 0.3, [1, 1, 1]]] as const) {
      for (const d of [0, 0.05, 0.4, 1, 2.5, 4, 7, 12, 25, OPEN_DEPTH]) {
        uD.value = d;
        for (let i = 0; i < 3; i++) {
          uK[i].value = ks[i] * kScale;
          uS[i].value = s[i] * sScale;
          uE[i].value = ext[i];
        }
        const cpu = shoalBandGains(d, ks.map((k) => k * kScale), s.map((v) => v * sScale), ext, p, []);
        for (let i = 0; i < 3; i++) {
          const gpu = evalTsl(nodes.gains[i]);
          expect(Math.abs(gpu - cpu[i]), `d=${d} band ${i} cpu=${cpu[i]} gpu=${gpu}`)
            .toBeLessThan(2e-5 * Math.max(1, cpu[i]));
        }
        const hs0 = 4 * Math.hypot(...[0, 1, 2].map((i) => uS[i].value * shoalingCoefficient(uK[i].value, d) * ext[i]));
        const cpuBreak = surfBreakingIntensity(surfBreakingFactor(hs0, d, p));
        expect(Math.abs(evalTsl(nodes.breaking) - cpuBreak), `breaking d=${d}`).toBeLessThan(2e-5);
      }
    }
  });

  it('the beach/caustics receiver is built from the SAME gain and uniforms', () => {
    // f62e037/§B.51 in test form: the terrain decides how drowned it is from
    // `waterHeight`; its graph must hold the breaking law's own σ and (γ,
    // onset) uniforms, or a surf zone drawn at γ·d is reconstructed as open sea
    const sim = createOceanSim(1234);
    const water = createCaustics(sim);
    water.setSeabedOpenDepth(OPEN_DEPTH);
    water.update(new THREE.Vector3(0, 1, 0));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const seen = new Set<number>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walk = (n: any): void => {
      if (!n || typeof n !== 'object' || !n.isNode || seen.has(n.id)) return;
      seen.add(n.id);
      for (const k of ['aNode', 'bNode', 'cNode', 'node', 'uvNode']) walk(n[k]);
    };
    walk(water.waterHeight(positionWorld.xz, float(2)));
    for (const [i, c] of sim.cascades.entries()) {
      expect(seen.has(water.shoaling.sigma[i].id), `σ ${i} in graph`).toBe(true);
      expect(seen.has(water.shoaling.k[i].id), `k ${i} in graph`).toBe(true);
      expect(water.shoaling.sigma[i].value).toBe(Math.sqrt(Math.max(c.heightVariance, 0)));
    }
    expect(seen.has(water.shoaling.surf.id)).toBe(true);
  });
});
