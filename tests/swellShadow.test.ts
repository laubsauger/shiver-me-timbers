/**
 * T174 SWELL SHADOW IN ISLAND LEE — an island must leave a calm wake in the
 * remotely generated swell, which does not regrow behind land.
 *
 * WHAT THESE TESTS ARE FOR (§Rule 6, §V.80 — properties, not decisions):
 *  · the lee is calmer and RECOVERS with distance. A shadow that never fills in
 *    is a painted wedge to the horizon; one that is not there is the T174 bug;
 *  · LONG SWELL WRAPS FURTHER INTO A LEE THAN SHORT SWELL. That is diffraction,
 *    and it is the clause a "simplification" to a geometric shadow cannot pass
 *    (the mutation test removes the wavelength term and must fail);
 *  · the shadow follows the SWELL's bearing, not the island and not the wind;
 *  · open water and the upswell side are the sea they always were, BIT FOR BIT,
 *    on both the CPU and the float32 GPU expression, or every tuned preset and
 *    every buoyancy measurement has silently moved;
 *  · wind-sea bands are NOT shadowed: chop in a lee is `fetch.ts`'s job, and
 *    two models describing the same waves in the same place is §V.77;
 *  · the mirror the hull floats on and the shader apply ONE expression (§V.8).
 *
 * Model and sources: docs/ocean/swell-shadow.md.
 */
import { describe, expect, it } from 'vitest';
import surfaceMaterialSource from '../src/ocean/surfaceMaterial.ts?raw';
import cpuOceanSource from '../src/sea-physics/cpuOcean.ts?raw';
import { float, positionWorld, uniform } from 'three/tsl';
import { createOceanSim } from '../src/ocean';
import { createCaustics } from '../src/caustics';
import * as THREE from 'three/webgpu';
import {
  fadeShadowBorder,
  marchSwellShadow,
  swellBandShare,
  swellShadowGain,
  swellShadowGainNode,
  swellShadowInputs,
  SWELL_SHADOW_SNAP,
  type ShelterSource,
  type SwellShadowInputs,
} from '../src/ocean/swellShadow';
import { createFetchField, sampleGrid, SWELL_SHADOW_MIN_FRAMES } from '../src/ocean/fetchField';
import type { SeabedField } from '../src/island/seabed';
import {
  cascadeBand,
  spectralHeightVariance,
  swellPeakWavenumber,
} from '../src/ocean/oceanMath';
import { normalCdf } from '../src/foam/foamMath';
import { oceanParams, type OceanParams } from '../src/params/ocean';
import { seaPhysicsParams } from '../src/params/seaPhysics';
import { weatherPresets } from '../src/weather/presets';
import { CpuOcean } from '../src/sea-physics/cpuOcean';

function preset(name: 'calm' | 'swell' | 'storm' | 'glass'): OceanParams {
  return { ...oceanParams, ...weatherPresets[name].ocean };
}

// ───────────────────────────────────────────────────────────────────────────
// A synthetic world: a square field with land where `isLand` says
// ───────────────────────────────────────────────────────────────────────────

const RES = 256;
const CELL = 30;
const HALF = (RES * CELL) / 2;

function landMask(isLand: (x: number, z: number) => boolean): Uint8Array {
  const land = new Uint8Array(RES * RES);
  for (let j = 0; j < RES; j++) {
    for (let i = 0; i < RES; i++) {
      if (isLand((i + 0.5) * CELL - HALF, (j + 0.5) * CELL - HALF)) land[j * RES + i] = 1;
    }
  }
  return land;
}

function march(land: Uint8Array, inputs: SwellShadowInputs): (x: number, z: number) => number {
  const out = new Float32Array(RES * RES);
  marchSwellShadow(land, RES, CELL, inputs, out);
  return (x, z) => sampleGrid(out, RES, [-HALF, -HALF], CELL, x, z);
}

/** a disc islet of radius r at the origin */
const islet = (r: number) => landMask((x, z) => Math.hypot(x, z) < r);

const TOWARD_X: Pick<SwellShadowInputs, 'direction'> = { direction: 0 };

// ───────────────────────────────────────────────────────────────────────────
// THE ONE EXPRESSION
// ───────────────────────────────────────────────────────────────────────────

/**
 * Evaluates a scalar TSL graph built from Const/Uniform/Convert/Operator/Math
 * nodes, in FLOAT32 at every step — the GPU's precision. `leaf` may answer for
 * any other node (a texture channel) before the walk gives up. This is what lets the
 * §V.8 check be numeric rather than a regex: the node graph the material
 * compiles is walked and computed, not re-derived.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function evalTsl(n: any, leaf?: (n: any) => number | undefined): number {
  const f = Math.fround;
  const sub = leaf?.(n);
  if (sub !== undefined) return f(sub);
  if (n.isConstNode) return f(n.value);
  if (n.isUniformNode) return f(n.value);
  if (n.isOperatorNode) {
    const a = evalTsl(n.aNode, leaf);
    const b = evalTsl(n.bNode, leaf);
    switch (n.op) {
      case '+': return f(a + b);
      case '-': return f(a - b);
      case '*': return f(a * b);
      case '/': return f(a / b);
    }
  }
  if (n.isMathNode) {
    const a = evalTsl(n.aNode, leaf);
    switch (n.method) {
      case 'sqrt': return f(Math.sqrt(a));
      case 'max': return f(Math.max(a, evalTsl(n.bNode, leaf)));
      case 'min': return f(Math.min(a, evalTsl(n.bNode, leaf)));
    }
  }
  if (n.node) return evalTsl(n.node, leaf); // ConvertNode float(x)
  throw new Error(`evalTsl: unsupported node ${n.type ?? n.constructor?.name} ${n.op ?? n.method ?? ''}`);
}

describe('T174 the gain: one expression, and open water cannot move', () => {
  const uShare = uniform(0);
  const uK = uniform(1);
  const node = swellShadowGainNode(uShare, uK);
  const gpu = (share: number, k: number): number => {
    uShare.value = share;
    uK.value = k;
    return evalTsl(node);
  };

  it('is EXACTLY 1 in open water on the CPU and on the float32 GPU expression', () => {
    // K = 1 is open sea; 0.9999999 is what a GPU bilinear of four 1.0 texels can
    // return. Both must be an identity, not "close" — bit-identical open water
    // is the only way the pirate and raft far field provably did not move.
    for (const share of [0, 0.1, 0.284, 0.9, 1]) {
      for (const k of [1, 0.9999999, 1 - SWELL_SHADOW_SNAP * 0.5]) {
        expect(swellShadowGain(share, k)).toBe(1);
        expect(gpu(share, k)).toBe(1);
      }
    }
  });

  it('is EXACTLY 1 for a band with no swell in it, however deep the shadow', () => {
    // wind sea is fetch's job: a zero share must leave the band untouched
    for (const k of [0, 0.2, 0.7]) {
      expect(swellShadowGain(0, k)).toBe(1);
      expect(gpu(0, k)).toBe(1);
    }
  });

  it('the shader and the mirror compute the same number (float32 vs float64)', () => {
    for (let a = 0; a <= 10; a++) {
      for (let b = 0; b <= 10; b++) {
        const share = a / 10;
        const k = b / 10;
        expect(Math.abs(gpu(share, k) - swellShadowGain(share, k))).toBeLessThan(2e-6);
      }
    }
  });

  it('is energy bookkeeping: the swell share is scaled by K², the rest passes', () => {
    const f = 0.3;
    const k = 0.4;
    const kk = k / (1 - SWELL_SHADOW_SNAP);
    expect(swellShadowGain(f, k) ** 2).toBeCloseTo(1 - f + f * kk * kk, 12);
    expect(swellShadowGain(1, 0)).toBe(0);
  });

  it('is bounded and NaN-safe (§V.28)', () => {
    expect(swellShadowGain(0.5, NaN)).toBe(1);
    for (const k of [-3, 0, 0.5, 7]) {
      const g = swellShadowGain(0.8, k);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(1);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// THE MARCH
// ───────────────────────────────────────────────────────────────────────────

describe('T174 the lee: calmer behind the island, recovering downswell', () => {
  const swell = swellShadowInputs(preset('swell'));
  const K = march(islet(150), { ...swell, ...TOWARD_X });

  it('is shadowed just behind the island and fills in with distance', () => {
    const lee = [150 + 100, 150 + 600, 150 + 2000, 150 + 3500].map((x) => K(x, 0));
    expect(lee[0]).toBeLessThan(0.4);
    for (let i = 1; i < lee.length; i++) expect(lee[i]).toBeGreaterThan(lee[i - 1]);
    expect(lee[3]).toBeGreaterThan(0.85);
  });

  it('leaves the upswell side and the open sea beside it EXACTLY untouched', () => {
    for (const d of [450, 1200, 3000]) expect(K(-d, 0)).toBe(1);
    // abeam, well outside the penumbra
    expect(K(0, 2500)).toBe(1);
    expect(K(-3000, -3000)).toBe(1);
  });

  it('never reports a K outside [0, 1] or a non-finite K', () => {
    for (let i = 0; i < 400; i++) {
      const v = K(((i * 137) % 7000) - 3500, ((i * 271) % 7000) - 3500);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('a NaN bearing or a dead wavenumber is open sea, never a NaN sea', () => {
    const land = islet(150);
    for (const bad of [
      { ...swell, direction: NaN },
      { ...swell, wavenumber: 0 },
      { ...swell, spread: NaN },
    ]) {
      const k = march(land, bad);
      expect(k(300, 0)).toBe(1);
    }
  });
});

describe('T174 diffraction: long swell wraps further into the lee than short swell', () => {
  /**
   * A narrow swell over a small islet, so diffraction rather than directional
   * spread decides the near lee. Same islet, same spread, same point — only the
   * swell PERIOD differs. 180 m across: three march cells (60 m here), so the
   * obstacle is resolved and the difference is the physics, not the grid.
   */
  const land = islet(90);
  const spread = 0.08;
  const deficitAt = (period: number, disableDiffraction = false): number => {
    const k = march(land, {
      direction: 0,
      // "remove the wavelength dependence" = a wavenumber so large π/k vanishes
      wavenumber: disableDiffraction ? 1e9 : swellPeakWavenumber(period),
      spread,
    });
    return 1 - k(90 + 300, 0);
  };

  it('a 16 s swell loses much less behind an islet than a 6 s swell', () => {
    const long = deficitAt(16); // λ 400 m
    const short = deficitAt(6); // λ 56 m
    // MEASURED 0.695 vs 0.421. The bound is a PROPERTY (a clear margin, both
    // relative and absolute), not those numbers.
    expect(short).toBeGreaterThan(0.3);
    expect(long).toBeLessThan(short * 0.7);
    expect(short - long).toBeGreaterThan(0.15);
  });

  it('MUTATION: without the π·x/k term the two periods are indistinguishable', () => {
    // this is the guard that the wavelength dependence is doing the work above
    // and not an accident of the geometry — a geometric shadow fails it
    expect(deficitAt(16, true)).toBeCloseTo(deficitAt(6, true), 6);
    expect(deficitAt(16, true)).toBeGreaterThan(deficitAt(16) * 1.5);
  });

  it('matches the closed form σ² = σθ²x² + πx/k behind a strip, far from it', () => {
    // the documented model, not a look: a wall one march cell thick, K on its
    // centreline against a Gaussian-blurred top-hat, 1 − erf(W/2 / σ√2). W is
    // the wall's MEASURED deficit ∫(1−K)dv, because rasterising a 300 m wall
    // onto 60 m march cells is not what is under test — the σ law is (a
    // blurred top-hat conserves exactly that integral, whatever σ is).
    const strip = landMask((x, z) => Math.abs(z) < 150 && Math.abs(x) < 30);
    for (const [k, s] of [
      [0.0332, 0], // pure diffraction, 11 s swell
      [1e9, 0.375], // pure spread
      [0.0332, 0.375], // the shipped swell
      [0.112, 0.08], // short narrow swell
    ] as const) {
      const K = march(strip, { direction: 0, wavenumber: k, spread: s });
      for (const d of [1200, 2400]) {
        let w = 0;
        for (let z = -HALF + CELL / 2; z < HALF; z += CELL) w += (1 - K(30 + d, z)) * CELL;
        const sigma = Math.sqrt(s * s * d * d + (Math.PI * d) / k);
        const predicted = 1 - (normalCdf(w / 2 / sigma) - normalCdf(-w / 2 / sigma));
        expect(Math.abs(K(30 + d, 0) - predicted), `k=${k} σθ=${s} d=${d}`).toBeLessThan(0.04);
      }
    }
  });

  it('does not invent shadow: the deficit ∫(1−K)dv stays the obstacle width', () => {
    // the regression the lateral distance transform exists for — a gather blur
    // with a growing radius leaked a 300 m islet's deficit to 700 m in 5 km
    const W = 300;
    const strip = landMask((x, z) => Math.abs(z) < W / 2 && Math.abs(x) < 30);
    const K = march(strip, { direction: 0, wavenumber: 1e9, spread: 0.375 });
    const deficits = [300, 1200, 3000].map((d) => {
      let deficit = 0;
      for (let z = -HALF + CELL / 2; z < HALF; z += CELL) deficit += (1 - K(d, z)) * CELL;
      return deficit;
    });
    // the wall is 300 m; on 60 m march cells its soft raster blocks ~240 m
    for (const deficit of deficits) {
      expect(deficit).toBeGreaterThan(W * 0.7);
      expect(deficit).toBeLessThan(W * 1.25);
    }
    // and it does not GROW downswell — the leak's signature
    expect(deficits[2] / deficits[0]).toBeLessThan(1.15);
  });
});

describe('T174 the shadow follows the SWELL, not the island', () => {
  const land = islet(150);
  const base = swellShadowInputs(preset('swell'));

  it('rotating the swell by 90° moves the lee by 90°', () => {
    const east = march(land, { ...base, direction: 0 });
    const north = march(land, { ...base, direction: Math.PI / 2 });
    const d = 600;
    expect(east(d, 0)).toBeLessThan(0.7);
    expect(east(0, d)).toBeGreaterThan(0.97);
    expect(north(0, d)).toBeLessThan(0.7);
    expect(north(d, 0)).toBeGreaterThan(0.97);
    // and it is the same shadow, turned — not a different one
    expect(north(0, d)).toBeCloseTo(east(d, 0), 1);
  });

  it('a wider directional spread refills the far lee sooner', () => {
    const narrow = march(land, { ...base, direction: 0, spread: 0.2 });
    const wide = march(land, { ...base, direction: 0, spread: 0.6 });
    expect(wide(2500, 0)).toBeGreaterThan(narrow(2500, 0));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// WHAT GETS SHADOWED
// ───────────────────────────────────────────────────────────────────────────

describe('T174 only the swell share is shadowed — chop is fetch’s job', () => {
  const variance = (p: OceanParams, i: number): number =>
    spectralHeightVariance(p.resolution, p.cascades[i].domain, p, cascadeBand(i, p.splitWavelengths));

  it('the wind-sea cascades carry no swell on any shipped sea, so their gain is exactly 1', () => {
    for (const name of ['calm', 'swell', 'storm'] as const) {
      const p = preset(name);
      // variance only divides the share; any positive number shows it is zero
      expect(swellBandShare(p, 1, 1e-3), name).toBe(0);
      expect(swellBandShare(p, 2, 1e-3), name).toBe(0);
      expect(swellShadowGain(swellBandShare(p, 1, 1e-3), 0)).toBe(1);
    }
  });

  it('cascade 0 is shadowed in proportion to how much of it is swell', () => {
    const shares = (['calm', 'swell', 'storm'] as const).map((n) => {
      const p = preset(n);
      return swellBandShare(p, 0, variance(p, 0));
    });
    // calm is swell-dominated (90% by variance), storm is wind-dominated
    expect(shares[0]).toBeGreaterThan(0.8);
    expect(shares[1]).toBeGreaterThan(0.1);
    expect(shares[1]).toBeLessThan(shares[0]);
    expect(shares[2]).toBeLessThan(shares[1]);
  });

  it('no swell, or strength 0, is exactly the sea without the feature', () => {
    const glass = preset('glass');
    expect(swellBandShare(glass, 0, 1)).toBe(0);
    const off = { ...preset('swell'), swellShadowStrength: 0 };
    expect(swellBandShare(off, 0, 1e-3)).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// THE BUILT FIELD
// ───────────────────────────────────────────────────────────────────────────

describe('T174 the built field carries the shadow in the fetch texture', () => {
  const seabed = {
    heightAt: (x: number, z: number) => (Math.hypot(x, z) < 200 ? 6 : -45),
    origin: [-2000, -2000] as [number, number],
    size: 4000,
  } as unknown as SeabedField;
  const p: OceanParams = {
    ...oceanParams,
    fetchFieldSize: 128,
    fetchFieldMargin: 1000,
    swellDirection: 0,
  };
  const field = createFetchField(seabed, p);

  it('is shadowed down-swell and exactly open up-swell', () => {
    expect(field.shadowAt(700, 0)).toBeLessThan(0.7);
    expect(field.shadowAt(-1200, 0)).toBe(1);
  });

  it('packs K into G of the SAME texture the shader already samples (§V.40)', () => {
    const tex = field.texture;
    expect(tex.format).toBe(THREE.RGFormat);
    const data = tex.image.data as Uint16Array;
    expect(data.length).toBe(128 * 128 * 2);
    // texel under the lee: G decodes to the CPU array's K, R to its fetch
    const i = Math.floor((700 + 3000) / field.texelSize);
    const j = Math.floor((0 + 3000) / field.texelSize);
    const cx = -3000 + (i + 0.5) * field.texelSize;
    const cz = -3000 + (j + 0.5) * field.texelSize;
    const k = (j * 128 + i) * 2;
    expect(THREE.DataUtils.fromHalfFloat(data[k + 1])).toBeCloseTo(field.shadowAt(cx, cz), 3);
    expect(THREE.DataUtils.fromHalfFloat(data[k]) / field.fetchAt(cx, cz)).toBeCloseTo(1, 3);
  });

  it('the field border is open sea exactly, so clamp-to-edge cannot extend a shadow', () => {
    for (let t = -3000; t <= 3000; t += 250) {
      expect(field.shadowAt(3000, t)).toBe(1);
      expect(field.shadowAt(t, 3000)).toBe(1);
    }
    const data = new Float32Array(16 * 16).fill(0.25);
    fadeShadowBorder(data, 16, 10, 40);
    expect(data[0]).toBe(1);
    expect(data[8 * 16 + 8]).toBe(0.25);
  });

  /** frames until the field re-marches (Infinity if it never does within `limit`) */
  const framesToRebuild = (limit = 3 * SWELL_SHADOW_MIN_FRAMES): number => {
    for (let f = 1; f <= limit; f++) if (field.update(p.windDirection)) return f;
    return Infinity;
  };

  it('re-marches when the swell moves, never for strength, never for NaN', () => {
    framesToRebuild(); // settle the construction-time gate
    const before = field.shadowCount;
    p.swellShadowStrength = 0.5; // a uniform, not a bake input
    expect(framesToRebuild()).toBe(Infinity);
    p.swellDirection = 0.001; // under fetchRebuildRadians
    expect(framesToRebuild()).toBe(Infinity);
    p.swellDirection = Math.PI / 2;
    expect(framesToRebuild()).toBeLessThanOrEqual(SWELL_SHADOW_MIN_FRAMES);
    expect(field.shadowCount).toBe(before + 1);
    // and the lee has actually turned with it
    expect(field.shadowAt(0, 700)).toBeLessThan(0.7);
    expect(field.shadowAt(700, 0)).toBeGreaterThan(0.97);
    p.swellPeriod = oceanParams.swellPeriod * 1.2;
    expect(framesToRebuild()).toBe(SWELL_SHADOW_MIN_FRAMES);
    p.swellDirection = NaN;
    expect(framesToRebuild()).toBe(Infinity);
    expect(field.shadowCount).toBe(before + 2);
  });

  it('a preset lerp re-marches at most once per gate, and still lands the final swell', () => {
    // the swell turning 1.9 rad across a 4 s transition at 60 fps
    p.swellDirection = 0;
    p.swellPeriod = oceanParams.swellPeriod;
    framesToRebuild();
    const before = field.shadowCount;
    const frames = 240;
    for (let f = 1; f <= frames; f++) {
      p.swellDirection = (1.9 * f) / frames;
      field.update(p.windDirection);
    }
    expect(field.shadowCount - before).toBeLessThanOrEqual(Math.ceil(frames / SWELL_SHADOW_MIN_FRAMES));
    framesToRebuild(); // the transition has ended; the last move must land
    const lee = 700;
    expect(field.shadowAt(Math.cos(1.9) * lee, Math.sin(1.9) * lee)).toBeLessThan(0.7);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// §V.8 — THE SEA THE HULL FLOATS ON
// ───────────────────────────────────────────────────────────────────────────

/** surface variance of the mirror along a transect, several instants */
function mirrorVariance(p: OceanParams, shelter: ShelterSource | null): number {
  const cpu = new CpuOcean(4242, p, seaPhysicsParams);
  if (shelter) cpu.setFetch(shelter);
  let sum = 0;
  let n = 0;
  for (const t of [0, 3.7, 8.1, 12.9]) {
    for (let s = 0; s < 2020; s += 1) {
      const h = cpu.heightAt(s * 0.8 + t * 31, s * 0.6 - t * 17, t);
      sum += h * h;
      n++;
    }
  }
  return sum / n;
}

describe('§V.8 T174 the mirror the ship floats on and the sea that is drawn', () => {
  const p = preset('swell');
  const open = (k: number): ShelterSource => ({ fetchAt: () => 1e9, shadowAt: () => k });

  it('an open-sea shadow (K = 1) is BIT-IDENTICAL to no shadow at all', () => {
    const bare = new CpuOcean(99, p, seaPhysicsParams);
    const wired = new CpuOcean(99, p, seaPhysicsParams);
    bare.setFetch({ fetchAt: () => 1e9 });
    wired.setFetch(open(1));
    const none = new CpuOcean(99, p, seaPhysicsParams);
    for (let i = 0; i < 40; i++) {
      const x = i * 13.7;
      const z = i * -7.3;
      const t = i * 0.31;
      const h = none.heightAt(x, z, t);
      expect(wired.heightAt(x, z, t)).toBe(h);
      expect(bare.heightAt(x, z, t)).toBe(h);
      expect(wired.pressureHeadAt(x, z, t)).toBe(none.pressureHeadAt(x, z, t));
    }
  });

  it('applies the K² law to the swell share — measured twice, then predicted', () => {
    /**
     * The mirror's variance is Σ gᵢ²σᵢ² with gᵢ² = 1 − fᵢ(1 − K'²). So the drop
     * from K = 1 to any K is proportional to (1 − K'²) — measure K = 1 and
     * K = 0, predict K = 0.6. A mirror that applied K linearly, applied it to
     * the wrong band, or ignored it, misses the third point.
     */
    const kk = (k: number) => Math.min(k / (1 - SWELL_SHADOW_SNAP), 1);
    const vOpen = mirrorVariance(p, open(1));
    const vDark = mirrorVariance(p, open(0));
    const vMid = mirrorVariance(p, open(0.6));
    const predicted = vOpen - (1 - kk(0.6) ** 2) * (vOpen - vDark);
    expect(vDark).toBeLessThan(vOpen * 0.95);
    expect(Math.abs(predicted - vMid) / vMid).toBeLessThan(0.02);
  });

  it('with no swell share the darkest shadow is BIT-IDENTICAL to open sea', () => {
    // the same wiring with the strength at 0: proves the gain is gated by the
    // SHARE (the wind sea passes), not by K alone. An absolute bound on how
    // much variance K = 0 removes is not asserted — a narrow-band swell's
    // variance along a finite transect is sampling noise at ±40%.
    const off = { ...p, swellShadowStrength: 0 };
    const dark = new CpuOcean(7, off, seaPhysicsParams);
    const none = new CpuOcean(7, off, seaPhysicsParams);
    dark.setFetch(open(0));
    for (let i = 0; i < 30; i++) {
      expect(dark.heightAt(i * 21.1, i * 3.3, i * 0.47)).toBe(none.heightAt(i * 21.1, i * 3.3, i * 0.47));
    }
  });

  it('the drawn sea and the floated sea import the ONE shadow expression', () => {
    expect(surfaceMaterialSource).toMatch(/from '\.\/swellShadow'/);
    expect(surfaceMaterialSource).toMatch(/swellShadowGainNode\(uSwellShare\[i\], swellK\)/);
    expect(surfaceMaterialSource).toMatch(/swellBandShare\(oceanParams, i, c\.heightVariance\)/);
    expect(cpuOceanSource).toMatch(/from '\.\.\/ocean\/swellShadow'/);
    expect(cpuOceanSource).toMatch(/swellShadowGain\(this\.swellShare\[i\], k\)/);
    expect(cpuOceanSource).toMatch(/swellBandShare\(this\.oceanP, i, c\.heightVariance\)/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// §V.8 / §V.77 — THE THIRD CONSUMER: the sea the beach is drowned by
// ───────────────────────────────────────────────────────────────────────────

/** every node reachable from `root` through the operand/child links TSL uses */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function allNodes(root: any): any[] {
  const out: unknown[] = [];
  const seen = new Set<number>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (n: any): void => {
    if (!n || typeof n !== 'object' || !n.isNode || seen.has(n.id)) return;
    seen.add(n.id);
    out.push(n);
    for (const k of ['aNode', 'bNode', 'cNode', 'node', 'uvNode']) walk(n[k]);
  };
  walk(root);
  return out;
}

describe('§V.77 T174 the terrain reconstructs the SAME shadowed sea', () => {
  /**
   * f62e037's lesson, applied to the new factor: `waterHeightNode` is what the
   * beach and the caustics use to decide how drowned they are. If it summed
   * the unshadowed swell, every lee beach would see a taller sea than the one
   * drawn — a false wet band marching with the swell. So the test walks the
   * REAL node graph `Caustics.waterHeight` builds and pins, per cascade, that
   * the swell-shadow gain is there, fed by THAT cascade's share uniform and the
   * `.g` of the SAME fetch-field sample its `.r` fetch comes from — then
   * evaluates that very subgraph and compares it to the CPU mirror's function.
   * Removing the wiring leaves no such subgraph and every clause fails.
   */
  const sim = createOceanSim(1234);
  const water = createCaustics(sim);
  const seabed = {
    heightAt: (x: number, z: number) => (Math.hypot(x, z) < 200 ? 6 : -45),
    origin: [-2000, -2000] as [number, number],
    size: 4000,
  } as unknown as SeabedField;
  const field = createFetchField(seabed, { ...oceanParams, fetchFieldSize: 64, fetchFieldMargin: 500 });
  water.setFetchField(field);
  water.setSeabedOpenDepth(45);
  water.update(new THREE.Vector3(0, 1, 0));
  const nodes = allNodes(water.waterHeight(positionWorld.xz, float(10)));
  const fetchTex = nodes.filter((n) => n.isTextureNode && n.value === field.texture);
  const kSplit = nodes.filter(
    (n) => n.type === 'SplitNode' && n.components === 'y' && n.node?.value === field.texture,
  );

  it('reads K from the one fetch-field sample, not a second texture read', () => {
    expect(kSplit.length).toBe(1);
    expect(fetchTex.length).toBe(1);
    expect(kSplit[0].node).toBe(fetchTex[0]);
  });

  it('refreshes each cascade’s share from the same call as the material and the mirror', () => {
    for (const [i, c] of sim.cascades.entries()) {
      expect(water.shoaling.swellShare[i].value).toBe(swellBandShare(oceanParams, i, c.heightVariance));
    }
  });

  it('applies swellShadowGain per cascade — found in the graph, then evaluated', () => {
    const kId = kSplit[0]?.id;
    for (const [i] of sim.cascades.entries()) {
      const share = water.shoaling.swellShare[i];
      const gains = nodes.filter((n) => {
        if (!(n.isMathNode && n.method === 'sqrt')) return false;
        const inner = allNodes(n);
        return inner.some((m) => m.id === share.id) && inner.some((m) => m.id === kId);
      });
      expect(gains.length, `cascade ${i}`).toBe(1);
      const prev = share.value;
      try {
        for (const [f, k] of [[0.28, 0.1], [1, 0.5], [0.6, 1], [0, 0]] as const) {
          share.value = f;
          const gpu = evalTsl(gains[0], (m) => (m.id === kId ? k : undefined));
          expect(Math.abs(gpu - swellShadowGain(f, k)), `cascade ${i} f=${f} K=${k}`).toBeLessThan(2e-6);
        }
      } finally {
        share.value = prev;
      }
    }
  });
});
