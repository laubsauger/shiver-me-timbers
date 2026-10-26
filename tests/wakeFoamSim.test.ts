/**
 * §T.171 W5 — FOAM AND SLICK FROM THE SIM WAKE (docs/wake/w5-foam.md).
 * WHY each block exists:
 *
 *  1. NO WHITECAPS ON GLASS. Breaking foam is keyed on the sim surface's own
 *     steepness against the Stokes limit. A calm field, and waves below the
 *     0.30 onset, must inject EXACTLY nothing — otherwise the wake paints
 *     white where the water it draws is smooth, which is the W2b mismatch this
 *     task exists to close.
 *  2. THE WHITE TRAIL FOLLOWS THE SIM'S ARMS. On a towed pond case the
 *     breaking foam's lateral position must be where the SOLVER put the
 *     divergent crests (its own envelope maximum), not where an authored
 *     Kelvin line says they should be.
 *  3. A HULL AT REST MAKES NO WAKE FOAM (§V102 analogue). Static cancellation
 *     leaves no steep surface, and the churn term is the hull's displacement
 *     RATE, which is zero without relative motion. Under way the same hull
 *     does lay a trail (liveness), and one passage lays the dose the model
 *     states (scale-free: ∝ lift, not ∝ draft).
 *  4. §V28: non-finite inputs inject nothing and cannot reach a uniform.
 *  5. PIRATE IS FROZEN until W6: the analytic flowfoam compute WGSL is the
 *     pre-W5 graph byte for byte, and the sim backend still adds nothing to
 *     the ocean material (tests/wakeBackend.test.ts §2 carries that half).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { GRAVITY } from '../src/ocean/oceanMath';
import { flowFoamParams, type FlowFoamParams } from '../src/params/flowfoam';
import { createFlowFoam, type FlowFoam } from '../src/flowfoam';
import {
  BREAK_ONSET_SLOPE,
  STOKES_SLOPE,
  createSimFoamField,
  simFoamRateCpu,
  simHeadGradientCpu,
} from '../src/flowfoam/simFoam';
import { liftFraction } from '../src/foam/sprayMath';
import { WakeSim } from '../src/wake/wakeSim';
import {
  WAKE_MAX_DT,
  WakeSolverCpu,
  WakeSourceBuffer,
  fft2d,
  modeWavenumber,
  splatSigma,
  wakeButterflyTables,
} from '../src/wake/wakeSolverMath';
import { WAKE_RAFT_TIER, presetByName, presetFrame, presetSamples, towStep } from '../src/wake/wakeCalibration';

const P: FlowFoamParams = flowFoamParams;

// ---------------------------------------------------------------------------
describe('1. breaking: injected where the sim is steeper than the onset, never on a calm field', () => {
  const rate = (slope: number): number => simFoamRateCpu({ slope, headAdvect: 0, lift: 0, depth: 0.3 }, P)[0];

  it('a calm sim field (zero slope, zero head motion) injects exactly 0 foam and 0 slick', () => {
    expect(simFoamRateCpu({ slope: 0, headAdvect: 0, lift: 0, depth: 0.3 }, P)).toEqual([0, 0]);
    expect(simFoamRateCpu({ slope: 0, headAdvect: 0, lift: 1, depth: 0.3 }, P)).toEqual([0, 0]);
  });

  it('a sine wave below the onset injects 0 at EVERY phase; one past Stokes injects exactly where |∇η| > 0.30', () => {
    const k = (2 * Math.PI) / 4;
    for (const ka of [0.1, 0.25, 0.299]) {
      for (let x = 0; x < 4; x += 0.05) expect(rate(Math.abs(ka * Math.sin(k * x)))).toBe(0);
    }
    let breaking = 0;
    for (let x = 0; x < 4; x += 0.05) {
      const s = Math.abs(0.5 * Math.sin(k * x));
      const f = rate(s);
      if (s <= BREAK_ONSET_SLOPE) expect(f).toBe(0);
      else {
        expect(f).toBeGreaterThan(0);
        breaking++;
      }
      if (s >= STOKES_SLOPE) expect(f).toBeCloseTo(P.simBreakRate, 12);
    }
    expect(breaking).toBeGreaterThan(10);
    // monotone in steepness — steeper water is never less white
    let prev = -1;
    for (let s = 0; s <= 0.6; s += 0.01) {
      expect(rate(s)).toBeGreaterThanOrEqual(prev);
      prev = rate(s);
    }
  });
});

// ---------------------------------------------------------------------------
/** towed Gaussian pressure through a 128² CPU solver (tests/wakeKelvin.test.ts setup) */
function towPatch(force: number): { s: WakeSolverCpu; x: number; lead: number } {
  const N = 128;
  const TEXEL = 0.5;
  const s = new WakeSolverCpu({ n: N, texel: TEXEL });
  const footprint = Math.sqrt(1 - TEXEL ** 2);
  const sigma = splatSigma(footprint, TEXEL, N);
  const U = 0.45 * Math.sqrt(GRAVITY * Math.PI * Math.SQRT2 * sigma); // Fr 0.45, the Kelvin plateau
  const lead = 0.3 * s.domain;
  const dt = Math.min(WAKE_MAX_DT, (0.3 * U) / GRAVITY, (0.4 * sigma) / U);
  const duration = (2.2 * 0.62 * s.domain) / U + 4;
  const src = new WakeSourceBuffer();
  let x = 0;
  for (let k = 0; k * dt < duration; k++) {
    x = U * k * dt;
    s.setCenter(x - lead, 0);
    const t = Math.min(1, (k * dt) / 4);
    src.clear();
    src.push(x, 0, force * t * t * (3 - 2 * t), footprint);
    s.splat(src);
    s.step(dt, { slope: true });
  }
  return { s, x, lead };
}

describe('2. the white trail follows the SIM\'s Kelvin arms (towed pond, Fr 0.45)', () => {
  const arms = (force: number) => {
    const { s, x } = towPatch(force);
    const N = s.n;
    const nn = N * N;
    // the solver's own divergent envelope A² = η² + φ(|k|φ)/g (wakeKelvin.test.ts), per ray
    const re = new Float64Array(nn);
    const im = new Float64Array(nn);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) re[j * N + i] = s.phi[j * N + i] * ((i + j) & 1 ? -1 : 1);
    const tables = wakeButterflyTables(N);
    fft2d(re, im, N, tables.forward);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = Math.hypot(modeWavenumber(i, N, s.domain), modeWavenumber(j, N, s.domain)) / nn;
        re[j * N + i] *= k;
        im[j * N + i] *= k;
      }
    }
    fft2d(re, im, N, tables.inverse);
    const a2 = new Float64Array(nn);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const idx = j * N + i;
        a2[idx] = s.zeta[idx] ** 2 + (s.phi[idx] * re[idx] * ((i + j) & 1 ? -1 : 1)) / GRAVITY;
      }
    }
    const at = (arr: ArrayLike<number>, u: number, v: number): number => {
      const i = Math.round(u);
      const j = Math.round(v);
      return i < 0 || j < 0 || i >= N || j >= N ? 0 : arr[j * N + i];
    };
    const r1 = 0.2 * s.domain;
    const r2 = 0.62 * s.domain;
    let envBest = -1;
    let envDeg = 0;
    let foamSum = 0;
    let foamDegSum = 0;
    let foamBest = -1;
    let foamDeg = 0;
    let maxSlope = 0;
    for (let deg = 0; deg <= 35; deg += 0.25) {
      const a = (deg * Math.PI) / 180;
      let env = 0;
      let foam = 0;
      for (let r = r1; r <= r2; r += s.texel / 2) {
        for (const side of [-1, 1]) {
          const u = s.gridU(x - r * Math.cos(a));
          const v = s.gridV(side * r * Math.sin(a));
          env += Math.sqrt(Math.max(0, at(a2, u, v))) * Math.sqrt(r);
          const slope = Math.hypot(at(s.slopeX, u, v), at(s.slopeZ, u, v));
          maxSlope = Math.max(maxSlope, slope);
          foam += simFoamRateCpu({ slope, headAdvect: 0, lift: 0, depth: 1 }, P)[0];
        }
      }
      if (env > envBest) {
        envBest = env;
        envDeg = deg;
      }
      foamSum += foam;
      foamDegSum += foam * deg;
      if (foam > foamBest) {
        foamBest = foam;
        foamDeg = deg;
      }
    }
    return { envDeg, foamSum, foamCentroidDeg: foamSum > 0 ? foamDegSum / foamSum : NaN, foamDeg, maxSlope, r: (r1 + r2) / 2 };
  };

  it('a sub-breaking tow (max slope < 0.30) lays no breaking foam anywhere', () => {
    const a = arms(1e4);
    expect(a.maxSlope).toBeLessThan(BREAK_ONSET_SLOPE);
    expect(a.foamSum).toBe(0);
  }, 60_000);

  it('a just-breaking tow puts the foam on the envelope maximum: centroid and peak within 2° (lateral offset within ~0.9 m at mid-band)', () => {
    const a = arms(2e4);
    expect(a.maxSlope).toBeGreaterThan(BREAK_ONSET_SLOPE);
    expect(a.foamSum).toBeGreaterThan(0);
    // the solver's arm is where the physics put it (Darmon: just inside φ_K at Fr 0.45)
    expect(a.envDeg).toBeGreaterThan(12);
    expect(a.envDeg).toBeLessThan(20);
    expect(Math.abs(a.foamCentroidDeg - a.envDeg)).toBeLessThanOrEqual(2);
    expect(Math.abs(a.foamDeg - a.envDeg)).toBeLessThanOrEqual(2);
    // the same statement as a lateral offset at the band's mid distance
    const rad = Math.PI / 180;
    expect(Math.abs(a.r * Math.tan(a.foamCentroidDeg * rad) - a.r * Math.tan(a.envDeg * rad))).toBeLessThan(0.9);
    // and NOT on the track: a foam source that ignored the arms would centre near 0°
    expect(a.foamCentroidDeg).toBeGreaterThan(8);
  }, 60_000);
});

// ---------------------------------------------------------------------------
describe('3. §V102 analogue: a hull at rest makes no wake foam; under way one passage lays the stated dose', () => {
  const RAFT = presetByName('raft-2');

  /** the raft (her own 54 buoyancy stations) held or towed through a CPU solver; probes integrate the dose */
  function raft(speed: number, seconds: number) {
    const s = new WakeSolverCpu({ n: 128, texel: RAFT.texel });
    const frame = presetFrame(RAFT);
    const dt = towStep({ ...RAFT, speed: Math.max(speed, 1) });
    const buf = new WakeSourceBuffer();
    const probeX = 24;
    const probes = [0, 1, 2, 3, 4].map((z) => ({ z, dose: 0 }));
    let gridFoam = 0;
    let maxSlope = 0;
    let maxHead = 0;
    let depth = 0;
    for (let k = 0; k * dt < seconds; k++) {
      const x = speed * k * dt;
      s.setCenter(x + frame.stem - 16, 0);
      buf.clear();
      for (const sm of presetSamples(RAFT, x)) buf.push(sm.x, sm.z, sm.fy, sm.footprint, sm.depth);
      s.splat(buf);
      s.step(dt, { slope: true });
      depth = buf.depthBins().d1;
      const lift = liftFraction(speed, depth);
      for (const p of probes) {
        const [gx] = simHeadGradientCpu(s.head, s.n, s.texel, s.centerX, s.centerZ, probeX, p.z);
        const i = Math.round(s.gridU(probeX));
        const j = Math.round(s.gridV(p.z));
        const slope = i >= 0 && j >= 0 && i < s.n && j < s.n ? Math.hypot(s.slopeX[j * s.n + i], s.slopeZ[j * s.n + i]) : 0;
        p.dose += simFoamRateCpu({ slope, headAdvect: speed * gx, lift, depth }, P)[0] * dt;
      }
      if (k * dt > seconds - 1) {
        for (let q = 0; q < s.head.length; q++) maxHead = Math.max(maxHead, s.head[q]);
        for (let j = 0; j < s.n; j++) {
          for (let i = 0; i < s.n; i++) {
            const q = j * s.n + i;
            const slope = Math.hypot(s.slopeX[q], s.slopeZ[q]);
            maxSlope = Math.max(maxSlope, slope);
            const wx = s.centerX + (i - s.n / 2) * s.texel;
            const wz = s.centerZ + (j - s.n / 2) * s.texel;
            const [gx] = simHeadGradientCpu(s.head, s.n, s.texel, s.centerX, s.centerZ, wx, wz);
            gridFoam += simFoamRateCpu({ slope, headAdvect: speed * gx, lift, depth }, P)[0];
          }
        }
      }
    }
    return { probes, gridFoam, maxSlope, maxHead, depth, frame };
  }

  it('at rest for 15 s: the whole grid injects exactly 0 (no churn without motion, no steep water under static cancellation)', () => {
    const r = raft(0, 15);
    expect(r.maxHead).toBeGreaterThan(0.1); // she IS pressing on the sea
    expect(r.maxSlope).toBeLessThan(BREAK_ONSET_SLOPE);
    expect(r.gridFoam).toBe(0);
    for (const p of r.probes) expect(p.dose).toBe(0);
  }, 60_000);

  it('towed at 2 m/s past a fixed point: the centreline dose ≈ churnRate·lift·(1 + sternChurn)·h_peak/D, and it stays inside her beam', () => {
    const r = raft(2, 22);
    const lift = liftFraction(2, r.depth);
    const predicted = P.simChurnRate * lift * (1 + P.simSternChurn) * (r.maxHead / r.depth);
    const centre = r.probes[0].dose;
    expect(centre).toBeGreaterThan(0);
    expect(Math.abs(centre / predicted - 1)).toBeLessThan(0.15);
    // a raft at Fn 0.17 makes no breaking waves (research W5: "raft gurgle only")
    expect(r.maxSlope).toBeLessThan(BREAK_ONSET_SLOPE);
    // the lane is her width: well outside the half-beam it has fallen away
    const outside = r.probes.find((p) => p.z >= r.frame.halfBeam + 1.2)!;
    expect(outside.dose).toBeLessThan(0.1 * centre);
  }, 60_000);
});

// ---------------------------------------------------------------------------
describe('4. §V28: non-finite inputs inject nothing', () => {
  it('any NaN / Infinity input → [0, 0]', () => {
    const ok = { slope: 0.5, headAdvect: -1, lift: 0.7, depth: 0.3 };
    expect(simFoamRateCpu(ok, P)[0]).toBeGreaterThan(0);
    for (const key of Object.keys(ok) as (keyof typeof ok)[]) {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(simFoamRateCpu({ ...ok, [key]: bad }, P)).toEqual([0, 0]);
      }
    }
    expect(liftFraction(Number.NaN, 0.3)).toBe(0);
    expect(liftFraction(2, Number.NaN)).toBe(0);
  });

  it('foam heading stays unit length and aligned at rest and crawling speeds', () => {
    const sim = new WakeSim(WAKE_RAFT_TIER);
    const field = createSimFoamField(sim, { ...flowFoamParams }, { value: new THREE.Vector2() });
    try {
      for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.7]) {
        for (const speed of [0, 0.0005, 0.001, 0.002, 20]) {
          field.setHull(yaw, speed);
          field.update();
          const direction = field.uniforms.uHullDirection.value;
          expect(direction.length()).toBeCloseTo(1, 12);
          expect(direction.x).toBeCloseTo(Math.sin(yaw), 12);
          expect(direction.y).toBeCloseTo(Math.cos(yaw), 12);
          expect(field.uniforms.uHullVel.value.x).toBeCloseTo(direction.x * speed, 12);
          expect(field.uniforms.uHullVel.value.y).toBeCloseTo(direction.y * speed, 12);
        }
      }
    } finally {
      sim.dispose();
    }
  });

  it('the GPU uniforms never take a non-finite hull pose or param', () => {
    const sim = new WakeSim(WAKE_RAFT_TIER);
    const params = { ...flowFoamParams };
    const field = createSimFoamField(sim, params, { value: new THREE.Vector2() });
    field.setHull(0.5, 2);
    field.setHull(Number.NaN, Number.POSITIVE_INFINITY);
    params.simBreakRate = Number.NaN;
    params.simChurnRate = Number.POSITIVE_INFINITY;
    field.update();
    const u = field.uniforms;
    expect(u.uHullVel.value.x).toBeCloseTo(Math.sin(0.5) * 2, 12);
    expect(u.uHullVel.value.y).toBeCloseTo(Math.cos(0.5) * 2, 12);
    for (const v of [u.uLift.value, u.uDepth.value]) expect(Number.isFinite(v)).toBe(true);
    sim.dispose();
  });
});

// ---------------------------------------------------------------------------
/** flowfoam's compute passes for one frame, canonical WGSL (tests/wakeBackend.test.ts helpers) */
function flowfoamWgsl(ff: FlowFoam): string[] {
  const stubCanvas = {
    width: 4, height: 4, style: {}, getContext: (): null => null,
    addEventListener: (): void => {}, removeEventListener: (): void => {},
    getRootNode: (): unknown => ({}), setAttribute: (): void => {},
  };
  const computes: unknown[] = [];
  const rec = {
    compute: (n: unknown) => { computes.push(n); },
    render: () => {}, setRenderTarget: () => {}, getRenderTarget: () => null, getClearColor: () => {},
    getClearAlpha: () => 0, setClearColor: () => {}, clear: () => {},
  };
  ff.advanceWake(1 / 60);
  ff.update(rec as never, 1 / 60);
  // the wake's group is the one long array; the accumulation tiers submit [advect, blur] pairs
  const flat = computes.flatMap((c) => (Array.isArray(c) ? (c.length > 2 ? [] : c) : [c]));
  return flat.flatMap((c) => {
    const renderer = new THREE.WebGPURenderer({ canvas: stubCanvas as never });
    const backend = (renderer as any).backend;
    backend.renderer = renderer;
    (renderer as any).hasFeature = (name: string): boolean => name === 'float32-filterable';
    // r186 builds a compute node the way NodeManager.getForCompute does: no object, `builder.compute` set
    const b = backend.createNodeBuilder(null, renderer);
    b.compute = c;
    b.build();
    const ids = new Map<string, number>();
    return [(b.computeShader as string).replace(/NodeBuffer_(\d+)/g, (_m, id: string) => {
      if (!ids.has(id)) ids.set(id, ids.size);
      return `NodeBuffer_#${ids.get(id)}`;
    })];
  });
}

/** FNV-1a 32 — a fingerprint, no node:crypto (the project carries no @types/node) */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

describe('4b. one centre: the foam resample reads the centre the dispatched group scrolled to', () => {
  it('the FAR advect (sim doses only, no surface) binds a vec2 equal to the solver centre after a tick + frame', () => {
    const ff = createFlowFoam({ wakeBackend: 'sim', wakeTier: WAKE_RAFT_TIER });
    const sim = ff.wakeSim!;
    sim.tick({ position: [57.3, 0, -12.9], quaternion: [0, Math.sin(0.35), 0, Math.cos(0.35)] }, [], 5, 1 / 60);
    expect(Math.hypot(sim.solver.centerX, sim.solver.centerZ)).toBeGreaterThan(10);
    const computes: unknown[] = [];
    const rec = {
      compute: (n: unknown) => { computes.push(n); },
      render: () => {}, setRenderTarget: () => {}, getRenderTarget: () => null, getClearColor: () => {},
      getClearAlpha: () => 0, setClearColor: () => {}, clear: () => {},
    };
    ff.advanceWake(1 / 60);
    ff.update(rec as never, 1 / 60);
    const passes = computes.flatMap((c) => (Array.isArray(c) ? (c.length > 2 ? [] : c) : [c]));
    const canvas = {
      width: 4, height: 4, style: {}, getContext: (): null => null, addEventListener: (): void => {},
      removeEventListener: (): void => {}, getRootNode: (): unknown => ({}), setAttribute: (): void => {},
    };
    const renderer = new THREE.WebGPURenderer({ canvas: canvas as never });
    const backend = (renderer as any).backend;
    backend.renderer = renderer;
    // r186 throws on hasFeature() before init (r180 answered false). Answer as flowfoamWgsl does:
    // since r186 every FloatType texture's filterability (not only DataTextures') follows this
    // answer, and WGSLNodeBuilder caches the first answer for the whole process (§5's pin included)
    (renderer as any).hasFeature = (name: string): boolean => name === 'float32-filterable';
    // r186 builds a compute node the way NodeManager.getForCompute does: no object, `builder.compute` set
    const b = backend.createNodeBuilder(null, renderer);
    b.compute = passes[2]; // update order: near advect, near blur, FAR advect, far blur
    b.build();
    const vec2s: any[] = [];
    let head = false;
    for (const group of b.getBindings()) {
      for (const bind of group.bindings) {
        if (bind.texture === sim.solver.headTarget.texture) head = true;
        for (const u of bind.uniforms ?? []) if (u.value?.isVector2) vec2s.push(u.value);
      }
    }
    expect(head).toBe(true);
    expect(vec2s.filter((v) => v.x === sim.solver.centerX && v.y === sim.solver.centerZ).length).toBe(1);
    ff.dispose();
  });
});

describe('5. analytic shader baseline after the water corrections', () => {
  // Deliberately repinned after exact source integration, captured projection
  // winner and world-anchored vortex phase (water improvement plan, pass 19).
  // Both blur shaders remain identical. Vessel-only foam changes must not leak here.
  // Repinned for three r186 (2026-10-26): same node graph as r180, and once three's own codegen changes are
  // normalised away (banner, module-level `var<private>` temporaries, the new dispatch-count guard, repeated
  // expressions emitted once instead of re-emitted — hence ~219 kB → ~104 kB) both blur passes are textually
  // equal to r180's and the advect passes differ only in that de-duplication. r180 pin:
  //   { passes: 4, bytes: 219431, fnv: ['ff52194e', '698cb172', '2366b0e9', '9761ee6a'] }
  const PINNED = { passes: 4, bytes: 103572, fnv: ['3cb3fc35', '88e6f05f', '425e330b', 'c4847fb3'] };

  it('createFlowFoam() retains the accepted analytic shaders', () => {
    const wgsl = flowfoamWgsl(createFlowFoam());
    expect({ passes: wgsl.length, bytes: wgsl.join('\n====\n').length, fnv: wgsl.map(fnv1a) }).toEqual(PINNED);
  });

  it('…and the sim backend\'s differ in exactly the dose source (liveness: the pin can see a change)', () => {
    const analytic = flowfoamWgsl(createFlowFoam());
    const sim = flowfoamWgsl(createFlowFoam({ wakeBackend: 'sim', wakeTier: WAKE_RAFT_TIER }));
    expect(sim[0]).not.toBe(analytic[0]);
    expect(sim[2]).not.toBe(analytic[2]);
  });
});
