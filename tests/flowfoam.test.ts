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
import {
  bowArmDistCpu,
  wakeBreakupCpu,
  wakeEnvelopeCpu,
  wakeRateCpu,
  wakeSpeedFactorCpu,
  type WakeParams,
  type WakeShip,
} from '../src/flowfoam/wakeMath';
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

describe('ship wake injection (§V10 follow-up: bow V + stern band)', () => {
  const WP: WakeParams = {
    kelvinAngle: 19.47,
    bowIntensity: 5,
    sternIntensity: 1.6,
    speedThreshold: 0.5,
    fullWakeSpeed: 5,
    slowWakeWidth: 0.3,
    armWidth: 0.6,
    armWidthGrowth: 0.045,
    sternWidth: 1.0,
    wakeRange: 60,
    wakeNoiseScale: 0.3,
    wakeNoiseContrast: 0.18,
    wakeBreakup: 0.85,
  };
  // ship at origin heading +z (yaw 0): bow at z=+12, stern z=−10, beam 6
  const SHIP: WakeShip = { x: 0, z: 0, yaw: 0, speed: 4, bowOffset: 12, sternOffset: -10, beam: 6 };
  const tan = Math.tan((WP.kelvinAngle * Math.PI) / 180);

  it('arm distance: zero exactly on the V centerlines, |across| at the vertex', () => {
    // WHY: the V must originate AT the bow point and open at the Kelvin
    // angle — a wrong distance function draws the arms at the wrong slope
    // and the wake reads as generic noise, not a ship wake.
    expect(bowArmDistCpu(10, 10 * tan, WP.kelvinAngle)).toBeCloseTo(0, 12); // starboard arm
    expect(bowArmDistCpu(10, -10 * tan, WP.kelvinAngle)).toBeCloseTo(0, 12); // port arm
    expect(bowArmDistCpu(0, 2.5, WP.kelvinAngle)).toBeCloseTo(2.5, 12); // vertex
    expect(bowArmDistCpu(20, 0, WP.kelvinAngle)).toBeCloseTo(20 * tan, 12); // centerline between arms
  });

  it('wake ENVELOPE is port/starboard symmetric (noise breaks it up after)', () => {
    // WHY: the underlying V must be symmetric about the keel line — only the
    // world-anchored breakup noise may differ side to side, or the ship
    // would appear to permanently cut harder on one side.
    for (const z of [10, 0, -12, -30]) {
      for (const x of [1.5, 4, 9]) {
        expect(wakeEnvelopeCpu(x, z, SHIP, WP)).toBeCloseTo(wakeEnvelopeCpu(-x, z, SHIP, WP), 12);
      }
    }
  });

  it('breakup factor is bounded [1−wakeBreakup, 1] and deterministic', () => {
    // WHY: breakup may only REMOVE injected foam (gaps), never amplify it —
    // otherwise intensities in the params panel would lie.
    for (const [x, z] of [[0, -14], [3, -20], [-7, 4], [15.5, -33]]) {
      const b = wakeBreakupCpu(x, z, WP);
      expect(b).toBeGreaterThanOrEqual(1 - WP.wakeBreakup - 1e-12);
      expect(b).toBeLessThanOrEqual(1 + 1e-12);
      expect(wakeBreakupCpu(x, z, WP)).toBe(b);
    }
    expect(wakeRateCpu(0, -14, SHIP, WP)).toBeCloseTo(
      wakeEnvelopeCpu(0, -14, SHIP, WP) * wakeBreakupCpu(0, -14, WP),
      12,
    );
  });

  it('slow drift: faint narrow stern churn only, NO V-arms (user review)', () => {
    // WHY: "if we're going very slow we wouldn't see it spread out to the
    // side; only some slight disturbance at the aft."
    const drift = { ...SHIP, speed: 1.1 }; // above threshold, well below full
    const sf = wakeSpeedFactorCpu(drift.speed, WP);
    expect(sf).toBeLessThan(0.05); // arms are suppressed by sf...
    const onArm = wakeEnvelopeCpu(8 * tan, SHIP.bowOffset - 8, drift, WP);
    const sternChurn = wakeEnvelopeCpu(0, -12, drift, WP);
    expect(sternChurn).toBeGreaterThan(0); // ...but the stern still churns
    expect(onArm).toBeLessThan(sternChurn * 0.15); // V practically invisible
    // and the churn is NARROW: full-speed stern width reaches ~beam, slow ~30%
    const slowEdge = wakeEnvelopeCpu(1.6, -12, drift, WP); // outside 0.3·halfW=0.9
    expect(slowEdge).toBe(0);
    expect(wakeEnvelopeCpu(1.6, -12, SHIP, WP)).toBeGreaterThan(0); // inside at speed
  });

  it('wake development is monotonic with speed', () => {
    const at = (speed: number) =>
      wakeEnvelopeCpu(8 * tan, SHIP.bowOffset - 8, { ...SHIP, speed }, WP);
    expect(at(1)).toBeLessThan(at(2.5));
    expect(at(2.5)).toBeLessThan(at(5));
  });

  it('no wake at anchor: rate is exactly 0 below speedThreshold', () => {
    // WHY: a moored ship ringed by foam reads as a rendering bug.
    const slow = { ...SHIP, speed: 0.49 };
    expect(wakeRateCpu(0, -11, slow, WP)).toBe(0); // right behind the stern
    expect(wakeRateCpu(11 * tan, 1, slow, WP)).toBe(0); // on a bow arm
    expect(wakeRateCpu(0, -11, { ...SHIP, speed: 0 }, WP)).toBe(0);
  });

  it('bow arms and stern band inject where expected, nothing ahead of the bow', () => {
    const sAft = 8; // 8 m behind the bow point (z = 12 − 8 = 4)
    const onArm = wakeEnvelopeCpu(sAft * tan, SHIP.bowOffset - sAft, SHIP, WP);
    const offArm = wakeEnvelopeCpu(sAft * tan + 15, SHIP.bowOffset - sAft, SHIP, WP);
    expect(onArm).toBeGreaterThan(0);
    expect(offArm).toBe(0);
    const sternCenter = wakeEnvelopeCpu(0, -14, SHIP, WP); // 4 m aft of stern
    const sternEdge = wakeEnvelopeCpu(2.9, -14, SHIP, WP); // near scaled band edge
    expect(sternCenter).toBeGreaterThan(sternEdge); // centerline hump = rooster tail
    expect(sternEdge).toBeGreaterThanOrEqual(0);
    expect(wakeEnvelopeCpu(0, SHIP.bowOffset + 5, SHIP, WP)).toBe(0); // ahead of bow
  });

  it('deterministic; envelope is ship-frame invariant (breakup is world-anchored)', () => {
    expect(wakeRateCpu(3.3, -7.7, SHIP, WP)).toBe(wakeRateCpu(3.3, -7.7, SHIP, WP));
    // rotate ship 90° (bow toward +x): the old astern point is now abeam
    const turned = { ...SHIP, yaw: Math.PI / 2 };
    const astern = wakeEnvelopeCpu(-14, 0, turned, WP); // behind stern in new frame
    expect(astern).toBeGreaterThan(0);
    expect(astern).toBeCloseTo(wakeEnvelopeCpu(0, -14, SHIP, WP), 12);
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
    // Kelvin default is the physical wake half-angle (arcsin(1/3) ≈ 19.47°)
    expect(flowFoamParams.kelvinAngle).toBeCloseTo(19.47, 2);
    expect(flowFoamParams.speedThreshold).toBeGreaterThanOrEqual(0);
    expect(flowFoamParams.armWidth).toBeGreaterThan(0);
    expect(flowFoamParams.sternWidth).toBeGreaterThan(0);
    expect(flowFoamParams.wakeRange).toBeGreaterThan(0);
  });
});
