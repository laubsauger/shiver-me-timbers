/**
 * §V10 flow-foam invariants, verified against the pure CPU mirror
 * (src/flowfoam/flowMath.ts) of the GPU compute math. WHY each matters:
 * - divergence-poor flow: advection must swirl foam outward/downstream, not
 *   pile it into sinks (bright hotspots) or tear vacuum holes — mass moves,
 *   only decay removes it.
 * - determinism (§V2): same world position + time → same flow vector, or
 *   replays/multiplayer would advect different wakes from the same state.
 * - region-shift math: foam is a WORLD-anchored effect rendered in a sliding
 *   window; if recentering moved texel content, wakes would smear along with
 *   the ship instead of staying behind it in the water.
 * - decay factor: half-life must be frame-rate independent or trail length
 *   would change with fps.
 * - params bounds (§V16): every tunable registered with sane Tweakpane meta.
 */
import { describe, expect, it } from 'vitest';
import {
  advectLookupUv,
  flowPotentialCpu,
  flowVectorCpu,
  regionShiftUv,
  snapToTexel,
  uvForWorld,
  worldForUv,
  type FlowFieldParams,
} from '../src/flowfoam/flowMath';
import { decayFactorPerFrame } from '../src/foam/foamMath';
import { flowFoamParams } from '../src/params/flowfoam';
import { getParamsEntry } from '../src/params/registry';

const P: FlowFieldParams = {
  noiseScale: 0.06,
  noiseStrength: 3,
  noiseScrollSpeed: 0.4,
  baseFlowSpeed: 0.8,
  curlStep: 1.2,
};
const T = 1.7;
const DIR: [number, number] = [0, 1];

/** forward-difference divergence of the flow field with probe step h */
function divergenceAt(x: number, z: number, h: number, p: FlowFieldParams): number {
  const v0 = flowVectorCpu(x, z, T, DIR[0], DIR[1], p);
  const vx = flowVectorCpu(x + h, z, T, DIR[0], DIR[1], p);
  const vz = flowVectorCpu(x, z + h, T, DIR[0], DIR[1], p);
  return (vx[0] - v0[0]) / h + (vz[1] - v0[1]) / h;
}

describe('flow noise pseudo-curl (§V10 advection field)', () => {
  it('divergence vanishes exactly at the matching stencil step', () => {
    // v = (∂ψ/∂z, −∂ψ/∂x) via forward differences with step e: probing the
    // divergence with the SAME step e makes the ψ cross-terms cancel
    // algebraically, so only f64 rounding remains. Tolerance 1e-12 (measured
    // residual ~1e-17). This is the "no sources/sinks" guarantee.
    for (let x = -60; x <= 60; x += 15) {
      for (let z = -60; z <= 60; z += 15) {
        expect(Math.abs(divergenceAt(x, z, P.curlStep, P))).toBeLessThan(1e-12);
      }
    }
  });

  it('divergence-poor vs a gradient field at a mismatched probe step', () => {
    // With probe step h ≠ e the cancellation is only approximate. Compare
    // against the WORST construction from the same potential — the raw
    // gradient (pure source/sink field). Measured mean-|div| ratio ≈ 0.047;
    // tolerance 0.15 leaves ~3× margin for noise-octave/param drift while
    // still failing if someone replaces the curl with a gradient lookup.
    const h = P.curlStep / 3;
    const curlOnly: FlowFieldParams = { ...P, baseFlowSpeed: 0 };
    const e = P.curlStep;
    const grad = (x: number, z: number): [number, number] => {
      const p0 = flowPotentialCpu(x, z, T, DIR[0], DIR[1], P);
      const px = flowPotentialCpu(x + e, z, T, DIR[0], DIR[1], P);
      const pz = flowPotentialCpu(x, z + e, T, DIR[0], DIR[1], P);
      return [((px - p0) / e) * P.noiseStrength, ((pz - p0) / e) * P.noiseStrength];
    };
    let divCurl = 0;
    let divGrad = 0;
    let mag = 0;
    let n = 0;
    for (let x = -60; x <= 60; x += 10) {
      for (let z = -60; z <= 60; z += 10) {
        divCurl += Math.abs(divergenceAt(x, z, h, curlOnly));
        const g0 = grad(x, z);
        const gx = grad(x + h, z);
        const gz = grad(x, z + h);
        divGrad += Math.abs((gx[0] - g0[0]) / h + (gz[1] - g0[1]) / h);
        const v = flowVectorCpu(x, z, T, DIR[0], DIR[1], curlOnly);
        mag += Math.hypot(v[0], v[1]);
        n++;
      }
    }
    expect(mag / n).toBeGreaterThan(0.01); // field is not trivially zero
    expect(divCurl / divGrad).toBeLessThan(0.15);
  });

  it('flow is deterministic and time/scroll-dependent (§V2)', () => {
    const a = flowVectorCpu(12.5, -33.1, T, DIR[0], DIR[1], P);
    const b = flowVectorCpu(12.5, -33.1, T, DIR[0], DIR[1], P);
    expect(b).toEqual(a); // bit-identical: pure function of inputs
    const later = flowVectorCpu(12.5, -33.1, T + 5, DIR[0], DIR[1], P);
    expect(later).not.toEqual(a); // scrolling potential animates the eddies
  });

  it('base flow adds exactly dir·baseFlowSpeed on top of the curl', () => {
    // WHY: setFlowDir carries ship velocity/current — the wake must trail
    // downstream at a predictable speed the params panel can reason about.
    const still: FlowFieldParams = { ...P, baseFlowSpeed: 0 };
    const c = flowVectorCpu(4, 9, T, DIR[0], DIR[1], still);
    const withBase = flowVectorCpu(4, 9, T, DIR[0], DIR[1], P);
    expect(withBase[0]).toBeCloseTo(c[0] + DIR[0] * P.baseFlowSpeed, 12);
    expect(withBase[1]).toBeCloseTo(c[1] + DIR[1] * P.baseFlowSpeed, 12);
  });
});

describe('region window math (§V10 world anchoring)', () => {
  const size = 120;
  const res = 512;
  const texel = size / res;

  it('worldForUv inverts uvForWorld (v axis flips world z)', () => {
    const [u, v] = uvForWorld(12.34, -37.71, 10, -40, size);
    const [wx, wz] = worldForUv(u, v, 10, -40, size);
    expect(wx).toBeCloseTo(12.34, 10);
    expect(wz).toBeCloseTo(-37.71, 10);
    // orientation contract: +z world → smaller v (ortho camera up = (0,0,−1))
    const [, vNorth] = uvForWorld(12.34, -37.71 + 1, 10, -40, size);
    expect(vNorth).toBeLessThan(v);
  });

  it('snapToTexel lands on the texel grid within half a texel', () => {
    const c = snapToTexel(37.777, size, res);
    expect(Math.abs(c / texel - Math.round(c / texel))).toBeLessThan(1e-9);
    expect(Math.abs(c - 37.777)).toBeLessThanOrEqual(texel / 2 + 1e-12);
  });

  it('after a setCenter jump the shift maps a world point to the same texel', () => {
    // WHY: the advect pass reads previous-frame foam through this shift; if
    // it were wrong by even one texel, standing foam would crawl with the
    // ship instead of staying anchored in the water.
    const c1: [number, number] = [snapToTexel(10.3, size, res), snapToTexel(-40.2, size, res)];
    const c2: [number, number] = [
      snapToTexel(c1[0] + 37.53, size, res),
      snapToTexel(c1[1] - 12.24, size, res),
    ];
    const w: [number, number] = [12.34, -37.71];
    const uv1 = uvForWorld(w[0], w[1], c1[0], c1[1], size);
    const uv2 = uvForWorld(w[0], w[1], c2[0], c2[1], size);
    const shift = regionShiftUv(c1[0], c1[1], c2[0], c2[1], size);
    expect(uv2[0] + shift[0]).toBeCloseTo(uv1[0], 12);
    expect(uv2[1] + shift[1]).toBeCloseTo(uv1[1], 12);
    // snapped centers → shift is an exact texel offset → identical texel index
    expect(Math.floor((uv2[0] + shift[0]) * res)).toBe(Math.floor(uv1[0] * res));
    expect(Math.floor((uv2[1] + shift[1]) * res)).toBe(Math.floor(uv1[1] * res));
  });

  it('advect lookup: zero flow = pure shift, flow moves foam downstream', () => {
    const [u0, v0] = advectLookupUv(0.5, 0.5, 0, 0, 0.4, size, 0.01, -0.02);
    expect(u0).toBeCloseTo(0.51, 12);
    expect(v0).toBeCloseTo(0.48, 12);
    // backward lookup: flow +x → source LEFT of the texel (foam moves +x);
    // flow +z → source at LARGER v (v axis flips world z) — this encodes the
    // uv/world orientation shared by the GPU pass and material sampling.
    const [u1, v1] = advectLookupUv(0.5, 0.5, 2, 3, 0.4, size, 0, 0);
    expect(u1).toBeLessThan(0.5);
    expect(v1).toBeGreaterThan(0.5);
  });
});

describe('decay factor (§V10 accumulation fade, shared with §V6)', () => {
  it('halves after exactly one half-life of fixed ticks', () => {
    const dt = 1 / 60;
    const f = decayFactorPerFrame(3.0, dt);
    expect(Math.pow(f, 3.0 / dt)).toBeCloseTo(0.5, 9);
  });

  it('is frame-rate independent: two half-steps equal one full step', () => {
    // WHY: wake trail length must not depend on fps (§V2 fixed tick).
    const f1 = decayFactorPerFrame(3.0, 1 / 30);
    const f2 = decayFactorPerFrame(3.0, 1 / 60);
    expect(f2 * f2).toBeCloseTo(f1, 12);
  });

  it('non-positive half-life kills foam instantly instead of dividing by zero', () => {
    expect(decayFactorPerFrame(0, 1 / 60)).toBe(0);
    expect(decayFactorPerFrame(-1, 1 / 60)).toBe(0);
  });
});

describe('flowfoam params (§V16 registry contract)', () => {
  it('registers under "flowfoam" with the live object', () => {
    const entry = getParamsEntry('flowfoam');
    expect(entry).toBeDefined();
    expect(entry!.params).toBe(flowFoamParams);
  });

  it('defaults sit inside their Tweakpane meta bounds', () => {
    const entry = getParamsEntry('flowfoam')!;
    for (const [key, meta] of Object.entries(entry.meta)) {
      const value = (flowFoamParams as unknown as Record<string, number>)[key];
      if (meta.min !== undefined) expect(value).toBeGreaterThanOrEqual(meta.min);
      if (meta.max !== undefined) expect(value).toBeLessThanOrEqual(meta.max);
    }
  });

  it('structural bounds the shaders/dispatch rely on', () => {
    // power-of-two resolution: exact texel-snap arithmetic + dispatch align
    expect(flowFoamParams.resolution).toBeGreaterThan(0);
    expect(Math.log2(flowFoamParams.resolution) % 1).toBe(0);
    expect(flowFoamParams.depthThreshold).toBeGreaterThan(0);
    expect(flowFoamParams.maskFeather).toBeGreaterThan(0);
    expect(flowFoamParams.maskFeather).toBeLessThanOrEqual(1);
    expect(flowFoamParams.decayHalfLife).toBeGreaterThan(0);
    expect(flowFoamParams.edgeFade).toBeGreaterThan(0);
    expect(flowFoamParams.edgeFade).toBeLessThan(0.5);
    expect(flowFoamParams.curlStep).toBeGreaterThan(0);
  });
});
