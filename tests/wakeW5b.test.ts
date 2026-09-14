/**
 * §T.180 W5b — CLOSING W5's OPEN LIST (docs/wake/w5b.md). WHY each block exists:
 *
 *  a. BREAKING SEES THE SEA, WITHOUT DOUBLE-COUNTING IT. A wake crest riding a
 *     steep sea breaks where the same crest on glass would not (slopes add as
 *     accelerations do), but ambient whitecaps belong to src/foam: the sim must
 *     inject only the INCREMENT its wake causes. A texel with no wake slope
 *     injects nothing whatever the sea; a calm sea reproduces W5 exactly.
 *  b. THE FAR TIER DOES NOT ALIAS THE SIM. A 2.5 m texel point-sampling a 0.5 m
 *     field sees a narrow feature only when a texel centre happens to land on
 *     it, so the far trail blinks and blots as the region scrolls. The injected
 *     total over a row of far texels must not depend on the sub-texel offset.
 *  c. PROP WASH IS WIRED. The drive's thrust reaches the sim (a signed jet head,
 *     kept out of the hull's immersion field), the foam (a jet ribbon) and a
 *     rooster-tail emitter, from the drive model's own numbers; the pond's
 *     speedboat is her own contact, not the planing stand-in.
 *  d. WAKE FOAM HAS AN AGE. Fresh churn is whitewater and aged foam a thinning
 *     lane; the age is measured from the two decay clocks the texture already
 *     holds (no new binding), and aged foam's outline is the dissolve's soft
 *     average rather than a 2 px contour.
 *  e. §T.70: A HULL WORKING IN A SEA MAKES FOAM WITH NO WAY ON. Her burial rate
 *     enters the churn as the volume flux her waterplane pushes out.
 *  1–4. The browser pass's defects: hard far-tier blotches (b + d), the 2 m/s bow
 *     launched at its Bernoulli bound, no waves ahead of the bow from wrap-round,
 *     and no separate clear pass in the wake step.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import raftFrameSource from '../src/raft/raftFrame.ts?raw';
import surfaceMaterialSource from '../src/ocean/surfaceMaterial.ts?raw';
import { GRAVITY, SLOPE_BIN_COUNT, slopeBinWavelength, slopeResolutionFootprint } from '../src/ocean/oceanMath';
import { flowFoamParams as P } from '../src/params/flowfoam';
import { sprayParams } from '../src/params/spray';
import { raftSeaParams } from '../src/params/seaPhysics';
import { decayFactorPerFrame, dissolveKnee } from '../src/foam/foamMath';
import { BOW_CONTACT_RISE, bowContactEmission, bowLaunchVelocity, type BowContactInput } from '../src/foam/sprayMath';
import { createBowSpray } from '../src/foam/bowSpray';
import { createRoosterTail, roosterApex, roosterTailEmission } from '../src/foam/roosterTail';
import { WHITECAP_STAGE_A_SECONDS, createFlowFoam, freshnessExponent, tierFreshnessCpu } from '../src/flowfoam';
import {
  AMBIENT_QUADRATURE,
  BREAK_ONSET_SLOPE,
  NO_BURIAL,
  STOKES_SLOPE,
  bandSlopeVariance,
  boxOffset,
  expectedBreakingCpu,
  farSupersample,
  fitBurialPlane,
  jetFoamRate,
  NUM,
  packPropJet,
  propWashFoamCpu,
  simFoamRateAtCpu,
  simFoamRateCpu,
  waterplaneRimLength,
  type SimFoamCpuFields,
} from '../src/flowfoam/simFoam';
import { createHullContact, waterlineFromBox } from '../src/sea-physics/hullContact';
import { JET_SPREAD, jetExcessSpeed, propJetSample, type PropWashInput } from '../src/wake/propWash';
import { SpeedboatTow } from '../src/wake/speedboatTow';
import { WAKE_RAFT_TIER, WAKE_SHIP_TIER, presetByName, presetFrame, presetSamples, towPreset } from '../src/wake/wakeCalibration';
import { WakeSim } from '../src/wake/wakeSim';
import { WAKE_RHO, WakeSolverCpu, WakeSourceBuffer, defaultSponge, spongeAdvectionScale } from '../src/wake/wakeSolverMath';
import { WakeSolverGpu } from '../src/wake/wakeSolverPasses';

// ---------------------------------------------------------------------------
// headless helpers (tests/wakeBackend.test.ts precedent)
// ---------------------------------------------------------------------------
function headlessBuilder(object: unknown): any {
  const canvas = {
    width: 4, height: 4, style: {}, getContext: (): null => null, addEventListener: (): void => {},
    removeEventListener: (): void => {}, getRootNode: (): unknown => ({}), setAttribute: (): void => {},
  };
  const renderer = new THREE.WebGPURenderer({ canvas: canvas as never });
  const backend = (renderer as any).backend;
  backend.renderer = renderer;
  (renderer as any).hasFeature = (name: string): boolean => name === 'float32-filterable';
  return backend.createNodeBuilder(object, renderer);
}
function built(node: unknown): { wgsl: string; values: unknown[] } {
  const b = headlessBuilder(node);
  b.build();
  const values: unknown[] = [];
  for (const g of b.getBindings()) {
    for (const bind of g.bindings) {
      for (const u of bind.uniforms ?? []) values.push(u.value);
      // uniform ARRAYS bind as their own buffer; the node keeps its source array
      const arr = bind.nodeUniform?.array;
      if (Array.isArray(arr)) values.push(...arr);
    }
  }
  return { wgsl: b.computeShader as string, values };
}
function recorder() {
  const computes: unknown[] = [];
  let clears = 0;
  let renders = 0;
  const r: any = {
    autoClear: false,
    autoClearColor: false,
    compute: (n: unknown) => { computes.push(n); },
    render: () => { renders++; r.clearedInPass = r.autoClear && r.autoClearColor; },
    setRenderTarget: () => {}, getRenderTarget: () => null, getClearColor: () => {},
    getClearAlpha: () => 0, setClearColor: () => {}, clear: () => { clears++; },
  };
  return { r, computes, clears: () => clears, renders: () => renders };
}
function flowfoamComputes(ff: ReturnType<typeof createFlowFoam>): unknown[] {
  const rec = recorder();
  ff.advanceWake(1 / 60);
  ff.update(rec.r, 1 / 60);
  // The final two submissions are the near/far accumulation batches.
  const batches = rec.computes.slice(-2);
  expect(batches).toHaveLength(2);
  for (const batch of batches) {
    expect(Array.isArray(batch)).toBe(true);
    expect(batch).toHaveLength(2);
  }
  return batches.flat();
}
/** a deterministic standard normal stream (LCG + Box–Muller) */
function normals(seed: number): () => number {
  let s = seed >>> 0;
  const u = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s + 0.5) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

// ---------------------------------------------------------------------------
describe('a. breaking = the wake\'s INCREMENT over the ambient sea, band-limited', () => {
  const breaking = (slope: number, sigma: number): number =>
    simFoamRateCpu({ slope, headAdvect: 0, lift: 0, depth: 0.3, ambientSigma: sigma }, P)[0] / P.simBreakRate;

  it('no double count: where the wake adds no slope the sim injects exactly 0 — even in a sea that breaks on its own', () => {
    expect(expectedBreakingCpu(0, 0.2)).toBeGreaterThan(0.05); // that sea DOES whitecap (src/foam's job)
    for (const sigma of [0, 0.05, 0.1, 0.2, 0.4]) expect(breaking(0, sigma)).toBe(0);
  });

  it('a calm sea (σ = 0) is W5 exactly; a sub-onset wake crest (0.25) breaks once the sea is steep enough', () => {
    for (let s = 0; s <= 0.6; s += 0.01) {
      const t = Math.min(1, Math.max(0, (s - BREAK_ONSET_SLOPE) / (STOKES_SLOPE - BREAK_ONSET_SLOPE)));
      expect(breaking(s, 0)).toBeCloseTo(t * t * (3 - 2 * t), 12);
    }
    expect(breaking(0.25, 0)).toBe(0);
    expect(breaking(0.25, 0.1)).toBeGreaterThan(0.02);
    // more sea, more increment for the same sub-onset crest; never negative anywhere
    let prev = -1;
    for (const sigma of [0, 0.03, 0.06, 0.09, 0.12]) {
      const b = breaking(0.2, sigma);
      expect(b).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = b;
    }
    for (let s = 0; s <= 0.8; s += 0.05) for (const sigma of [0.02, 0.1, 0.3]) expect(breaking(s, sigma)).toBeGreaterThanOrEqual(0);
  });

  it('E[B] IS the expectation over an isotropic Gaussian sea (Monte Carlo, 4e5 draws), not a moment heuristic', () => {
    const B = (x: number): number => NUM.smoothstep(BREAK_ONSET_SLOPE, STOKES_SLOPE, x);
    const g = normals(12345);
    const N = 400_000;
    const draws = Array.from({ length: N }, () => [g(), g()] as const);
    let worst = 0;
    // measured accuracy of the 5 × 3 rule (docs/wake/w5b.md §1): ≤ 0.005 at σ ≤ 0.05, ≤ 0.039 at σ ≤ 0.1.
    // The two tempting shortcuts — ignoring the sea, or B(√(s² + 2σ²)) — are out by 0.31 at σ 0.1.
    let calm = 0;
    for (const sigma of [0.03, 0.05, 0.1]) {
      for (const s of [0, 0.15, 0.25, 0.32, 0.4, 0.5]) {
        let mc = 0;
        for (const [a, c] of draws) mc += B(Math.hypot(s + sigma * a, sigma * c));
        const err = Math.abs(mc / N - expectedBreakingCpu(s, sigma));
        worst = Math.max(worst, err);
        if (sigma <= 0.05) calm = Math.max(calm, err);
      }
    }
    expect(calm).toBeLessThan(0.01);
    expect(worst).toBeLessThan(0.045);
    expect(AMBIENT_QUADRATURE.reduce((a, q) => a + q[2], 0)).toBeCloseTo(1, 12);
  });

  it('the ambient slope is the sea\'s variance in the SIM\'s band (λ ≥ 2 sim texels) — shorter waves are src/foam\'s', () => {
    // a synthetic histogram: equal slope variance per octave from 0.25 m to 64 m
    const bins = new Float64Array(SLOPE_BIN_COUNT);
    let total = 0;
    let above1m = 0;
    for (let b = 0; b < SLOPE_BIN_COUNT; b++) {
      const lam = slopeBinWavelength(b);
      if (lam >= 0.25 && lam <= 64) {
        bins[b] = 1e-3;
        total += 1e-3;
        if (lam >= 1) above1m += 1e-3;
      }
    }
    const band = { slopeVariance: () => total, slopeFootprint: (keep: number) => slopeResolutionFootprint(bins, keep) };
    const v = bandSlopeVariance([band], 1);
    expect(Math.abs(v - above1m)).toBeLessThanOrEqual(1.5e-3); // one bin of slack
    expect(v).toBeLessThan(0.8 * total);
    expect(bandSlopeVariance([band], 1e-3)).toBeCloseTo(total, 9);
  });

  it('wired: flowFoam.setAmbientSea reaches the advect pass\'s uniforms (σ = √(v/2), ambient E[B] from the same function)', () => {
    const ff = createFlowFoam({ wakeBackend: 'sim', wakeTier: WAKE_RAFT_TIER });
    const bins = new Float64Array(SLOPE_BIN_COUNT);
    for (let b = 0; b < SLOPE_BIN_COUNT; b++) if (slopeBinWavelength(b) >= 2) bins[b] = 2e-3;
    const total = bins.reduce((a, x) => a + x, 0);
    ff.setAmbientSea([{ slopeVariance: () => total, slopeFootprint: (k: number) => slopeResolutionFootprint(bins, k) }]);
    const passes = flowfoamComputes(ff);
    const sigma = Math.sqrt(bandSlopeVariance([{ slopeVariance: () => total, slopeFootprint: (k: number) => slopeResolutionFootprint(bins, k) }], 1) / 2);
    expect(sigma).toBeGreaterThan(0.05);
    for (const pass of [passes[0], passes[2]]) {
      const { values } = built(pass);
      expect(values).toContain(sigma);
      expect(values).toContain(expectedBreakingCpu(0, sigma));
    }
    ff.dispose();
  });
});

// ---------------------------------------------------------------------------
describe('b. the far tier box-filters the sim over its own texel', () => {
  /** a breaking crest line along z at world x = x0, band-limited at the sim's Nyquist (σ = 1 texel) */
  function stripe(x0: number): SimFoamCpuFields {
    const n = 64;
    const texel = 0.5;
    const slopeX = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = (i - n / 2) * texel;
        slopeX[j * n + i] = 0.6 * Math.exp(-((x - x0) ** 2) / (2 * texel * texel));
      }
    }
    return { n, texel, centerX: 0, centerZ: 0, slopeX, slopeZ: new Float32Array(n * n), head: new Float64Array(n * n), sponge: defaultSponge(n, texel) };
  }
  const frame = { hullVelX: 0, hullVelZ: 0, lift: 0, depth: 0.3 };
  /** Σ over a row of far texels (2.5 m) of the injected rate × texel width, with the crest at sub-texel offset `off` */
  const rowTotal = (off: number, tierTexel: number, sampleTexel = tierTexel): number => {
    const f = stripe(off);
    let sum = 0;
    for (let k = -3; k <= 3; k++) sum += simFoamRateAtCpu(f, k * 2.5, 0, sampleTexel, frame, P)[0] * 2.5;
    return sum;
  };

  it('the injected total does not depend on where the crest falls inside a far texel (it does, badly, when point-sampled)', () => {
    expect(farSupersample(2.5, 0.5)).toBe(5);
    expect(farSupersample(2.5, 0.625)).toBe(4);
    expect(farSupersample(120 / 512, 0.5)).toBe(1);
    // the stratified offsets tile the texel: symmetric, spaced 1/S (the GPU loop uses the same boxOffsetOf)
    expect([0, 1, 2, 3, 4].map((k) => boxOffset(k, 5))).toEqual([-0.4, -0.2, 0, 0.2, 0.4].map((v) => expect.closeTo(v, 12)));
    const offsets = Array.from({ length: 11 }, (_, k) => -1.25 + k * 0.25);
    const spread = (xs: number[]): number => (Math.max(...xs) - Math.min(...xs)) / (xs.reduce((a, x) => a + x, 0) / xs.length);
    const filtered = offsets.map((o) => rowTotal(o, 2.5));
    // point sampling = the far tier asking at its texel centre only (the pre-W5b pass)
    const point = offsets.map((o) => rowTotal(o, 2.5, 0.5));
    expect(spread(filtered)).toBeLessThan(0.15);
    expect(spread(point)).toBeGreaterThan(1);
    // and the filter conserves what the sim injects: the fine integral at the sim's own spacing
    const fine = (() => {
      const f = stripe(0.1);
      let sum = 0;
      for (let x = -8.75; x < 8.75; x += 0.5) sum += simFoamRateAtCpu(f, x, 0, 0.5, frame, P)[0] * 0.5;
      return sum;
    })();
    expect(Math.abs(rowTotal(0.1, 2.5) / fine - 1)).toBeLessThan(0.1);
  });

  it('wired: the sim FAR advect pass loops S² = 25 subsamples on the raft tier (16 on the ship tier); the near pass does not', () => {
    for (const [tier, s2] of [[WAKE_RAFT_TIER, 25], [WAKE_SHIP_TIER, 16]] as const) {
      const ff = createFlowFoam({ wakeBackend: 'sim', wakeTier: tier });
      const passes = flowfoamComputes(ff);
      expect(built(passes[2]).wgsl).toMatch(new RegExp(`i < ${s2};`));
      expect(built(passes[0]).wgsl).not.toMatch(/for \(/);
      ff.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
describe('c. prop wash: sim source, foam ribbon, rooster tail — from the drive\'s own numbers', () => {
  const jet = (over: Partial<PropWashInput> = {}): PropWashInput => ({
    x: 0, z: 0, dirX: -1, dirZ: 0, thrust: 8000, discArea: Math.PI * 0.04, depth: 0.45, advance: 20, immersion: 1, surfaceY: 0, ...over,
  });

  it('actuator disc: V_j² − U² = 2T/ρA exactly; no thrust, no jet', () => {
    const j = jet();
    const vj = j.advance + jetExcessSpeed(j.advance, j.thrust, j.discArea);
    expect(vj * vj - j.advance ** 2).toBeCloseTo((2 * j.thrust) / (WAKE_RHO * j.discArea), 6);
    expect(jetExcessSpeed(20, 0, j.discArea)).toBe(0);
    expect(jetExcessSpeed(Number.NaN, 8000, 0.1)).toBe(0);
  });

  it('sim source: the jet pushes the surface UP with S·T, splatted into the jet channel, and never counts as hull immersion', () => {
    const q = propJetSample(jet())!;
    expect(q.fy).toBeCloseTo(-JET_SPREAD * 8000, 9);
    expect(q.x).toBeLessThan(0); // it surfaces aft of the prop
    const s = new WakeSolverCpu({ n: 128, texel: 0.5 });
    const buf = new WakeSourceBuffer();
    buf.push(3, 0, 5e4, 1, 0.3);
    buf.pushJet(q.x, q.z, q.fy, q.footprint, q.depth);
    s.splat(buf);
    let jetSum = 0;
    let total = 0;
    for (let i = 0; i < s.head.length; i++) {
      jetSum += s.headJet[i];
      total += s.head[i];
    }
    const cell = WAKE_RHO * GRAVITY * 0.25;
    expect(Math.abs(jetSum * cell / q.fy - 1)).toBeLessThan(2e-3);
    expect(Math.abs(total * cell / (5e4 + q.fy) - 1)).toBeLessThan(2e-3);
    // the column sim churn lifts against is the HULL's
    expect(buf.hullDepthMax()).toBe(0.3);
    expect(buf.depthBins().d1).toBeCloseTo(q.depth, 12);
    // §V28: a non-finite jet is dropped, not splatted
    expect(buf.pushJet(Number.NaN, 0, -100, 1, 0)).toBe(false);
    // a jet is not a hull entering water: the churn a moving hull lays is the same with or without the jet splatted
    const hullOnly = new WakeSolverCpu({ n: 128, texel: 0.5 });
    const hb = new WakeSourceBuffer();
    hb.push(3, 0, 5e4, 1, 0.3);
    hullOnly.splat(hb);
    const churnAt = (sol: WakeSolverCpu, x: number): number =>
      simFoamRateAtCpu({ ...sol, sponge: sol.sponge }, x, 0, 0.5, { hullVelX: 4, hullVelZ: 0, lift: 1, depth: 0.3 }, P)[0];
    for (const x of [q.x - 1, q.x, 1.5, 4.5]) expect(churnAt(s, x)).toBeCloseTo(churnAt(hullOnly, x), 9);
    expect(churnAt(hullOnly, 4.5)).toBeGreaterThan(0);
  });

  it('foam ribbon: aft of the prop only, more thrust more foam, cross-track integral kept on a coarse tier, dose per passage ∝ 1/U', () => {
    const at = (j: PropWashInput, x: number, z: number, texel = 0.234): number => propWashFoamCpu([j], x, z, texel);
    expect(at(jet(), 2, 0)).toBe(0); // ahead (jet points −x)
    expect(at(jet(), -3, 0)).toBeGreaterThan(0);
    let prev = 0;
    for (const T of [1000, 4000, 8000, 16000]) {
      const v = at(jet({ thrust: T }), -3, 0);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
    expect(at(jet({ thrust: 0 }), -3, 0)).toBe(0);
    const across = (texel: number): number => {
      let s = 0;
      for (let z = -12; z <= 12; z += 0.05) s += at(jet(), -6, z, texel) * 0.05;
      return s;
    };
    expect(Math.abs(across(2.5) / across(0.234) - 1)).toBeLessThan(0.02);
    // …and band-limited there: near the disc the ribbon is narrower than a far texel, so the tier must see it
    // at least one texel wide (Gaussian σ ≥ texel ⇒ peak ≤ integral/(√2π·texel)) or it aliases into blots
    const peak = at(jet(), -0.5, 0, 2.5);
    let integral = 0;
    for (let z = -12; z <= 12; z += 0.01) integral += at(jet(), -0.5, z, 2.5) * 0.01;
    expect(peak).toBeLessThanOrEqual((integral / (Math.sqrt(2 * Math.PI) * 2.5)) * 1.001);
    // §T.199: the ribbon's WIDTH now depends on U too (a jet in co-flow spreads at S·ΔV/(ΔV + U)), so the per-passage
    // property is stated on the cross-track INTEGRAL of the dose — the time over the ribbon, whatever its width
    const dose = (U: number): number => {
      const j = jet({ advance: U, thrust: 2000 });
      let d = 0;
      for (let s = 0; s < 80; s += 0.1) for (let z = -6; z <= 6; z += 0.05) d += (at(j, -s, z) * 0.1 * 0.05) / U;
      return d / packPropJet(j)!.meta[0]; // strip the jet's own drive lift·ΔV: what is left is time over the ribbon
    };
    expect(dose(10) / dose(20)).toBeCloseTo(2, 1);
  });

  // §T.199: the throw is the BLADE's (tip speed × the surface-crossing geometry), not the jet head ΔV²/2g the T180
  // emitter launched at (a 4 cm skirt at race speed) — tests/wakeSpeedboatLook.test.ts §2 carries the plume's height
  it('rooster tail: only a SURFACE-PIERCING prop throws, peaking half-in; flux = the exposed arc × sheet speed × disc; the emitter spawns for it', () => {
    const e = (imm: number, over: Partial<PropWashInput> = {}) => roosterTailEmission(jet({ immersion: imm, advance: 15, thrust: 12000, propRps: 50, ...over }), sprayParams);
    expect(e(1).rate).toBe(0);
    expect(e(0).rate).toBe(0);
    expect(e(0.5).rate).toBeGreaterThan(e(0.25).rate);
    expect(e(0.5).rate).toBeGreaterThan(e(0.9).rate);
    expect(e(0.5).flux).toBeCloseTo(e(0.5).exposure * (e(0.5).launch / Math.sqrt(e(0.5).exposure)) * Math.PI * 0.04, 9);
    expect(roosterApex(e(0.5).launch)).toBeCloseTo(e(0.5).launch ** 2 / (2 * GRAVITY), 12);
    expect(e(0.5, { x: Number.NaN }).rate).toBe(0);
    const spawns = (imm: number): number => {
      const rt = createRoosterTail();
      const rec = recorder();
      for (let t = 0; t < 3; t++) rt.update(rec.r, [jet({ immersion: imm, advance: 15, thrust: 12000, propRps: 50 })]);
      return rec.computes.length;
    };
    expect(spawns(1)).toBe(2 * (1 + 3)); // drops + mist: init + physics × 3 each, no spawn
    expect(spawns(0.5)).toBeGreaterThan(2 * (1 + 3));
  });

  it('wired into the GPU: the tick splats jets (instance flag → head .b), and a prop-carrying flowfoam packs them into its advect uniforms', () => {
    const sim = new WakeSim(WAKE_SHIP_TIER);
    sim.tick({ position: [0, 0, 0], quaternion: [0, 0, 0, 1] }, [{ x: 0, z: 2, fy: 4e4, footprint: 1, depth: 0.3 }], 3, 1 / 60, [jet()]);
    expect(sim.sources.jetCount).toBe(1);
    expect(sim.solver.sampleCount).toBe(2);
    sim.dispose();
    const ff = createFlowFoam({ wakeBackend: 'sim', wakeTier: WAKE_SHIP_TIER, propJets: 3 });
    ff.setPropWash([jet(), jet({ x: 1 })]);
    const passes = flowfoamComputes(ff);
    const packed = packPropJet(jet())!;
    const { values } = built(passes[0]);
    const flat = values.flatMap((v: any) => (Array.isArray(v) ? v : [v])).filter((v: any) => v?.isVector4);
    expect(flat.some((v: any) => Math.abs(v.x - packed.meta[0]) < 1e-9 && Math.abs(v.y - packed.meta[1]) < 1e-9)).toBe(true);
    ff.dispose();
  });

  it('the pond\'s speedboat-40 is her own contact: towed at 40 m/s she settles on her weight, three jets aft of the CG, thrust = the drive total', () => {
    const tow = new SpeedboatTow(40);
    // the pond asks at t = 0, before any tick: nothing yet, and no throw
    tow.advanceTo(0);
    expect(tow.jets().length).toBe(0);
    expect(tow.samples().length).toBe(0);
    tow.advanceTo(40 * 6);
    const w = tow.samples().reduce((a, s) => a + s.fy, 0);
    expect(Math.abs(w / (tow.hull.mass * GRAVITY) - 1)).toBeLessThan(0.05);
    const jets = tow.jets();
    expect(jets.length).toBe(3);
    for (const j of jets) {
      expect(j.x).toBeLessThan(tow.pose.position[0]);
      expect(j.dirX).toBeLessThan(-0.9); // water leaves aft
      expect(j.depth).toBeGreaterThan(0);
      expect(j.thrust).toBeGreaterThan(0);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
describe('d. wake foam age from the two decay clocks; aged foam dissolves soft', () => {
  it('a dose aged a seconds reads e^(−a/τ_A) on BOTH tiers, though their clocks differ; waterline-capture foam (no slick) reads fresh', () => {
    const k = P.simSlickPerFoam;
    for (const [foamHalf, e] of [[P.decayHalfLife, freshnessExponent(P.decayHalfLife, P.slickHalfLife)], [P.farDecayHalfLife, freshnessExponent(P.farDecayHalfLife, P.slickHalfLife)]] as const) {
      for (const age of [0.1, 0.5, 1, 2]) {
        const frames = Math.round(age * 60);
        const foam = 0.4 * decayFactorPerFrame(foamHalf, 1 / 60) ** frames;
        const slick = k * 0.4 * decayFactorPerFrame(P.slickHalfLife, 1 / 60) ** frames;
        expect(tierFreshnessCpu(foam, slick, k, e)).toBeCloseTo(Math.exp(-(frames / 60) / WHITECAP_STAGE_A_SECONDS), 6);
      }
    }
    expect(tierFreshnessCpu(0.3, 0, k, freshnessExponent(P.decayHalfLife, P.slickHalfLife))).toBe(1);
    // clocks that cannot be told apart read aged, never NaN
    expect(Number.isFinite(freshnessExponent(50, 5))).toBe(true);
  });

  it('aged foam\'s outline spans the whole dissolve band (soft); fresh foam keeps the torn 2 px knee', () => {
    // a lane edge: coverage rising 0.18 per metre; mean alpha over the art threshold, 10→90% width
    const width = (retire: number): number => {
      const alpha = (y: number): number => {
        let a = 0;
        for (let t = 0; t < 64; t++) a += dissolveKnee(0.18 * y, (t + 0.5) / 64, 0.005, 0.03, 0.22, retire, 0);
        return a / 64;
      };
      let y10 = NaN;
      let y90 = NaN;
      for (let y = 0; y < 3; y += 0.001) {
        if (Number.isNaN(y10) && alpha(y) >= 0.1) y10 = y;
        if (Number.isNaN(y90) && alpha(y) >= 0.9) y90 = y;
      }
      return y90 - y10;
    };
    // the average over thresholds hides the per-pixel contour; measure a SINGLE pixel's edge too
    const pixelEdge = (retire: number): number => {
      const a = (y: number) => dissolveKnee(0.18 * y, 0.5, 0.005, 0.03, 0.22, retire, 0);
      let y10 = NaN;
      let y90 = NaN;
      for (let y = 0; y < 3; y += 0.001) {
        if (Number.isNaN(y10) && a(y) >= 0.1) y10 = y;
        if (Number.isNaN(y90) && a(y) >= 0.9) y90 = y;
      }
      return y90 - y10;
    };
    expect(pixelEdge(0)).toBeGreaterThan(5 * pixelEdge(1));
    // and it IS the torn edge's average (the resolved = 0 limit), not a new shape: same mean edge within 20%
    expect(Math.abs(width(0) / width(1) - 1)).toBeLessThan(0.2);
  });

  it('wired: the sim material passes composed ages to foamDetailMask and mixes to the whitecap law; analytic builds no age node', () => {
    const code = surfaceMaterialSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).toMatch(/wakeFoamFreshnessNode\(worldXZ\)/);
    // e28d0a4 added an 8th arg, `porousBody` (landed sim-wake films keep their porous texture), gated on the
    // sim backend's age node; the composed ages still have to arrive as detailRetire / bodyAge.
    expect(code).toMatch(/foamDetailMask\([^;]*undefined,\s*undefined,\s*undefined,\s*ages\.edge,\s*ages\.body,\s*(?:Boolean\(flowFoam\?\.wakeFoamFreshnessNode\),?\s*)?\)/);
    expect(code).toMatch(/mix\(wakeCol,\s*foamCol,\s*wakeFresh\)/);
    expect(createFlowFoam().wakeFoamFreshnessNode).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('e. §T.70: burial rate from hull contact feeds the churn', () => {
  const raftContact = () => createHullContact(waterlineFromBox(raftSeaParams.hullBowZ, raftSeaParams.hullSternZ, raftSeaParams.hullHalfBeam));

  it('the plane recovers heave + pitch + roll of a hull\'s station rates exactly; ℓ = A/P of her outline', () => {
    const hc = raftContact();
    hc.update({ position: [10, 0, -4], quaternion: [0, Math.sin(0.3), 0, Math.cos(0.3)] } as never, { currentTime: 0, heightAt: () => 0.05 } as never, 0);
    const rate = Float64Array.from(hc.worldX, (x, i) => 0.3 + 0.04 * (x - 10) - 0.07 * (hc.worldZ[i] + 4));
    const plane = fitBurialPlane({ ...hc, inContact: true, rate });
    expect(plane.b).toBeCloseTo(0.04, 9);
    expect(plane.c).toBeCloseTo(-0.07, 9);
    expect(plane.a + plane.b * (10 - plane.ox) + plane.c * (-4 - plane.oz)).toBeCloseTo(0.3, 9);
    // a 12 × 4 box outline: A/P = 48/32
    expect(waterplaneRimLength([6, 0, -6], [2, 2, 2])).toBeCloseTo(48 / 32, 9);
    expect(fitBurialPlane({ ...hc, inContact: false, rate })).toMatchObject({ a: 0, b: 0, c: 0 });
    // §V28
    const bad = Float64Array.from(rate);
    bad[2] = Number.NaN;
    expect(Number.isFinite(fitBurialPlane({ ...hc, inContact: true, rate: bad }).a)).toBe(true);
  });

  it('a heaving hull with NO way on lays foam at her rim, carrying her waterplane\'s volume flux; at rest in calm water it lays none', () => {
    const RAFT = presetByName('raft-2');
    const s = new WakeSolverCpu({ n: 128, texel: 0.5 });
    const buf = new WakeSourceBuffer();
    for (const q of presetSamples(RAFT, 0)) buf.push(q.x, q.z, q.fy, q.footprint, q.depth);
    s.splat(buf);
    const D = buf.hullDepthMax();
    let hPeak = 0;
    for (const h of s.head) hPeak = Math.max(hPeak, h);
    const frame0 = presetFrame(RAFT);
    const hc = raftContact();
    const rim = waterplaneRimLength(hc.sliceZ, hc.sliceHalfWidth);
    const area = (raftSeaParams.buoyancySpring / (WAKE_RHO * GRAVITY)) * raftSeaParams.probeLayoutScale ** 2;
    const fields: SimFoamCpuFields = { ...s, slopeX: s.slopeX, slopeZ: s.slopeZ, sponge: s.sponge };
    const integral = (w: number): number => {
      let sum = 0;
      for (let j = 0; j < s.n; j++) {
        for (let i = 0; i < s.n; i++) {
          const x = (i - s.n / 2) * s.texel;
          const z = (j - s.n / 2) * s.texel;
          sum += simFoamRateAtCpu(fields, x, z, 0.5, { hullVelX: 0, hullVelZ: 0, lift: 1, depth: D, burial: { ...NO_BURIAL, a: w, rimLength: rim } }, P)[0] * 0.25;
        }
      }
      return sum;
    };
    expect(integral(0)).toBe(0);
    const heave = integral(0.2);
    expect(heave).toBeGreaterThan(0);
    // ∫ churn dA = churnRate · lift · w·A_wp·(h/D) / D: the flux, not a look number (ℓ is the plan's A/P)
    const predicted = (P.simChurnRate * 0.2 * area * (hPeak / D)) / D;
    expect(heave / predicted).toBeGreaterThan(0.6);
    expect(heave / predicted).toBeLessThan(1.4);
    // emerging water churns too (the stern term), rising water no more than falling at sternChurn 1
    expect(integral(-0.2) / heave).toBeCloseTo(P.simSternChurn, 1);
    expect(frame0.halfBeam).toBeGreaterThan(0);
  }, 60_000);

  it('lift carries the vertical speed: a hull slapping at 0.6 m/s with no way on is not lift-gated to 0', () => {
    const sim = new WakeSim(WAKE_RAFT_TIER);
    const ff = createFlowFoam({ wakeBackend: 'sim', wakeTier: WAKE_RAFT_TIER });
    const hc = raftContact();
    hc.update({ position: [0, 0, 0], quaternion: [0, 0, 0, 1] } as never, { currentTime: 0, heightAt: () => 0.05 } as never, 0);
    ff.setShip([0, 0], 0, 0, 6, -6, 5);
    ff.wakeSim!.tick({ position: [0, 0, 0], quaternion: [0, 0, 0, 1] }, [{ x: 0, z: 0, fy: 3e4, footprint: 1, depth: 0.3 }], 6, 1 / 60);
    ff.setHullBurial({ ...hc, inContact: true, rate: new Float64Array(hc.rate.length).fill(0.6) });
    const passes = flowfoamComputes(ff);
    const { values } = built(passes[0]);
    // U = 0, w_rms = 0.6: the lift is liftFraction(0.6, D), not liftFraction(0, D) = 0
    const want = Math.min(1, (0.6 * 0.6) / (2 * GRAVITY * 0.3));
    expect(values.some((v) => typeof v === 'number' && Math.abs(v - want) < 1e-9)).toBe(true);
    const burial = values.find((v: any) => v?.isVector4 && Math.abs(v.x - 0.6) < 1e-9) as THREE.Vector4 | undefined;
    expect(burial).toBeDefined();
    expect(burial!.w).toBeCloseTo(waterplaneRimLength(hc.sliceZ, hc.sliceHalfWidth), 9);
    ff.dispose();
    sim.dispose();
  });

  it('the raft feeds it: tickSea hands flowFoam her contact right after the contact update, and the sea\'s cascades', () => {
    const code = raftFrameSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const tick = code.slice(code.indexOf('tickSea('), code.indexOf('renderSea('));
    const update = tick.indexOf('vessel.hullContact.update(');
    const burial = tick.indexOf('sea.flowFoam.setHullBurial(vessel.hullContact)');
    expect(update).toBeGreaterThan(0);
    expect(burial).toBeGreaterThan(update);
    expect(tick).toMatch(/sea\.flowFoam\.setAmbientSea\(sea\.ocean\.cascades\)/);
  });
});

// ---------------------------------------------------------------------------
describe('defect 2: the 2 m/s bow launches at its Bernoulli bound — a low pile-up, never a faked sheet', () => {
  it('apex ≤ U²/2g at every seed, and reaches a readable fraction of it (the legacy 0.35 rise reached 5%)', () => {
    const hc = createHullContact(waterlineFromBox(raftSeaParams.hullBowZ, raftSeaParams.hullSternZ, raftSeaParams.hullHalfBeam));
    hc.update({ position: [0, 0, 0], quaternion: [0, 0, 0, 1] } as never, { currentTime: 0, heightAt: () => 0.01 } as never, 0);
    const c: BowContactInput = { inContact: true, sliceZ: hc.sliceZ, sliceHalfWidth: hc.sliceHalfWidth, depth: hc.depth, draft: raftSeaParams.hullDraft };
    const U = 2;
    const { sheet } = bowContactEmission(c, 0, U, 0, 0.05, sprayParams);
    const head = (U * U) / (2 * GRAVITY);
    let top = 0;
    for (let seed = 0; seed < 400; seed++) {
      const v = bowLaunchVelocity(seed / 400, 1.3, U, 0, 1, { ...sprayParams, bowRise: BOW_CONTACT_RISE }, sheet, 0);
      const apex = (v[1] * v[1]) / (2 * GRAVITY);
      expect(apex).toBeLessThanOrEqual(head + 1e-12);
      top = Math.max(top, apex);
    }
    expect(top).toBeGreaterThan(0.3 * head);
  });

  it('the emitter binds that rise in contact mode and the galleon\'s in legacy mode, with one spawn shader', () => {
    const spawn = (withContact: boolean) => {
      const bs = createBowSpray();
      const rec = recorder();
      const hc = createHullContact(waterlineFromBox(raftSeaParams.hullBowZ, raftSeaParams.hullSternZ, raftSeaParams.hullHalfBeam));
      hc.update({ position: [0, 0, 0], quaternion: [0, 0, 0, 1] } as never, { currentTime: 0, heightAt: () => 0.05 } as never, 0);
      const V = THREE.Vector3;
      bs.update(rec.r, {
        bowWorldPos: new V(0, 0, 6), shipVelocity: new V(0, 0, withContact ? 2 : 9), shipForward: new V(0, 0, 1), immersionDepth: 0.4,
        cutwater: { inContact: true, world: [0, 0, 6], depth: 0.4, rate: 0, halfWidth: 1 },
        contact: withContact ? { inContact: true, sliceZ: hc.sliceZ, sliceHalfWidth: hc.sliceHalfWidth, depth: hc.depth, draft: raftSeaParams.hullDraft } : undefined,
      });
      const node = rec.computes[rec.computes.length - 1];
      return built(node);
    };
    const contact = spawn(true);
    const legacy = spawn(false);
    expect(contact.values).toContain(BOW_CONTACT_RISE);
    expect(legacy.values).toContain(sprayParams.bowRise);
    expect(legacy.values).not.toContain(BOW_CONTACT_RISE);
    const canon = (w: string) => w.replace(/NodeBuffer_\d+/g, 'NB');
    expect(canon(contact.wgsl)).toBe(canon(legacy.wgsl));
  });
});

// ---------------------------------------------------------------------------
describe('defect 3: no waves ahead of the bow — the sponge absorbs at the speed the domain moves', () => {
  it('scale is exactly 1 at rest, and restores the design absorption for energy crossing at c_g + U', () => {
    const n = 256;
    const texel = 0.625;
    expect(spongeAdvectionScale(0, n, texel)).toBe(1);
    const sp = defaultSponge(n, texel);
    const w = sp.width * n * texel;
    const cg = 0.5 * Math.sqrt(GRAVITY / ((2 * Math.PI) / ((n * texel) / 4)));
    const left = (v: number, scale: number) => Math.exp(-2 * ((sp.gammaMax * scale) / 3) * ((2 * w) / v));
    expect(left(cg, 1)).toBeCloseTo(0.01, 6);
    for (const U of [5, 10, 40]) expect(left(cg + U, spongeAdvectionScale(U, n, texel))).toBeCloseTo(0.01, 6);
    expect(left(cg + 10, 1)).toBeGreaterThan(0.1); // what leaked before
  });

  it('galleon 10 m/s on the 160 m tier: wave energy ahead of her stem (+5 m, sponge included) < 0.5% of the wedge', () => {
    const preset = presetByName('galleon-10');
    const tow = towPreset(preset);
    const s = tow.solver;
    const interior = (0.5 - defaultSponge(s.n, s.texel).width) * s.n * s.texel;
    const stemX = tow.x + tow.frame.stem;
    let ahead = 0;
    let wedge = 0;
    for (let j = 0; j < s.n; j++) {
      for (let i = 0; i < s.n; i++) {
        const wx = s.centerX + (i - s.n / 2) * s.texel;
        const wz = s.centerZ + (j - s.n / 2) * s.texel;
        const e = s.zeta[j * s.n + i] ** 2;
        if (wx > stemX + 5) ahead += e;
        else if (Math.abs(wx - s.centerX) <= interior && Math.abs(wz - s.centerZ) <= interior) {
          const ang = (Math.atan2(Math.abs(wz), stemX - wx) * 180) / Math.PI;
          if (ang <= 35 && Math.hypot(stemX - wx, wz) > 2 * tow.frame.halfBeam + 4) wedge += e;
        }
      }
    }
    expect(wedge).toBeGreaterThan(0);
    expect(ahead / wedge).toBeLessThan(5e-3);
  }, 120_000);

  it('wired: the tick measures the domain\'s own velocity and the GPU post pass is scaled by it (identity at rest)', () => {
    const sim = new WakeSim(WAKE_SHIP_TIER);
    const q = [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)];
    sim.tick({ position: [0, 0, 0], quaternion: q }, [], 20, 1 / 60);
    expect(sim.domainVelocity.x).toBe(0); // first tick: no history
    sim.tick({ position: [10 / 60, 0, 0], quaternion: q }, [], 20, 1 / 60);
    expect(sim.domainVelocity.x).toBeCloseTo(10, 6);
    expect(Math.abs(sim.domainVelocity.z)).toBeLessThan(1e-6);
    const post = built(sim.solver.computeNodes[sim.solver.computeNodes.length - 1]);
    expect(post.values).toContain(spongeAdvectionScale(sim.domainVelocity.x, 256, WAKE_SHIP_TIER.texel));
    // a teleport is not a speed
    sim.tick({ position: [5000, 0, 0], quaternion: q }, [], 20, 1 / 60);
    expect(sim.domainVelocity.x).toBe(0);
    sim.dispose();
  });
});

// ---------------------------------------------------------------------------
describe('defect 4: the wake step clears its head target inside the splat pass', () => {
  it('no separate clear() call (a second encoder + submit in three r180); autoClear on for the splat, restored after', () => {
    const solver = new WakeSolverGpu({ n: 64, texel: 0.5 });
    const rec = recorder();
    let clearedInPass = false;
    rec.r.render = () => { clearedInPass = rec.r.autoClear && rec.r.autoClearColor; };
    solver.step(rec.r, 1 / 60);
    expect(rec.clears()).toBe(0);
    expect(clearedInPass).toBe(true);
    expect(rec.r.autoClear).toBe(false);
    expect(rec.r.autoClearColor).toBe(false);
    solver.mergeClear = false;
    solver.step(rec.r, 1 / 60);
    expect(rec.clears()).toBe(1); // the A/B leg the pond measures
    solver.dispose();
  });
});

// keep the jet rate generic honest: the TSL and CPU instances share `jetFoamRate`
describe('V77: the jet ribbon is one expression', () => {
  it('CPU Σ jets = the generic expression on the packed uniforms', () => {
    const j: PropWashInput = { x: 1, z: 2, dirX: 0, dirZ: -1, thrust: 5000, discArea: 0.12, depth: 0.4, advance: 12, immersion: 1 };
    const p = packPropJet(j)!;
    expect(propWashFoamCpu([j], 1.3, -3, 0.5)).toBe(jetFoamRate(NUM, 0.3, -5, p.pos[2], p.pos[3], p.meta[0], p.meta[1], 0.5, p.meta[3]));
  });
});
