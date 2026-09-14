/**
 * §T.181 hook 6 — THE SPEEDBOAT'S WAKE TIER (docs/wake/w5c-speedboat-tier.md).
 *
 * WHY: the 160 m ship tier was sized by W2a's TRANSVERSE law (L_dom ≥ 2.4·λ_T) for ≤ 10 m/s.
 * At 40 m/s λ_T = 1025 m, so that law cannot be met by any affordable grid, and it is the wrong
 * law anyway: a planing hull's wake is the DIVERGENT system, two narrow arms a few degrees off
 * the track that run hundreds of metres astern. On 160 m the arms end 109 m behind the stem, and
 * a grid fine enough to carry shorter divergent waves than the hull really sheds draws them
 * NARROWER than a real boat's. The tier rule trades those against the GPU budget (one 256² grid,
 * one compute group). Each block below fails if one side of that trade is lost:
 *  - the rule: the tier reaches the visible range astern, and nothing coarser than needed;
 *  - the budget: same grid size and dispatch count as the measured-good ship tier (§V104);
 *  - the physics: Havelock's stationary-phase far field, evaluated for the forcing the solver
 *    actually draws, predicts the arm the solver produces — and that arm is within the
 *    Rabaud–Moisy hull-length law, so the band limit the texel imposes does not visibly widen it;
 *  - the domain: at 40 m/s the grid scrolls through the water faster than any wave it holds, so
 *    wrap-round through the periodic edges would put waves ahead of the bow and outside the wedge.
 *
 * One contact tow (SpeedboatTow: HullWater on rigid6, towed in surge) on the CPU solver is shared
 * by every tow assertion: ≈ 30 s alone.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { GRAVITY } from '../src/ocean/oceanMath';
import { propJetSample } from '../src/wake/propWash';
import { SpeedboatTow } from '../src/wake/speedboatTow';
import {
  SPEEDBOAT_WAKE_REACH_ASTERN,
  WAKE_RAFT_TIER,
  WAKE_SHIP_TIER,
  WAKE_SPEEDBOAT_MAX_SPEED,
  WAKE_SPEEDBOAT_TIER,
  havelockArmAngleDeg,
  measureWake,
  presetByName,
  rabaudMoisyAngleDeg,
  towPreset,
  wakeReachAstern,
  wakeTierForSpeed,
  type Tow,
  type WakeReadout,
} from '../src/wake/wakeCalibration';
import { defaultSponge, type HydroSample } from '../src/wake/wakeSolverMath';
import { WakeSolverGpu, wakeDispatchCount } from '../src/wake/wakeSolverPasses';
import { buildDeepVHull } from '../src/speedboat/hullMesh';
import * as THREE from 'three/webgpu';
import { createFlowFoam } from '../src/flowfoam';

describe('the rule: reach astern, not λ_T', () => {
  it('the speedboat tier holds ≥ 300 m of unsponged water astern of the stem, with the coarsest texel that needs', () => {
    const t = WAKE_SPEEDBOAT_TIER;
    expect(wakeReachAstern(t)).toBeGreaterThanOrEqual(SPEEDBOAT_WAKE_REACH_ASTERN);
    // one eighth of a metre finer would fall short: the band limit is not coarser than the reach requires
    expect(wakeReachAstern({ n: t.n, texel: t.texel - 1 / 8 })).toBeLessThan(SPEEDBOAT_WAKE_REACH_ASTERN);
    // the ship tier's arms end a third of the way there
    expect(wakeReachAstern(WAKE_SHIP_TIER)).toBeLessThan(0.4 * SPEEDBOAT_WAKE_REACH_ASTERN);
    expect(presetByName('speedboat-40')).toMatchObject({ n: t.n, texel: t.texel, speed: WAKE_SPEEDBOAT_MAX_SPEED });
  });

  it('where the transverse law still fits (≤ ~8 m/s) the W2a ship tier stands; the ship and raft tiers are untouched', () => {
    expect(wakeTierForSpeed(7)).toEqual({ n: WAKE_SHIP_TIER.n, texel: WAKE_SHIP_TIER.texel });
    expect(wakeTierForSpeed(40)).toEqual({ n: WAKE_SPEEDBOAT_TIER.n, texel: WAKE_SPEEDBOAT_TIER.texel });
    expect(WAKE_SHIP_TIER).toEqual({ n: 256, texel: 0.625 });
    expect(WAKE_RAFT_TIER).toEqual({ n: 256, texel: 0.5 });
  });

  it('GPU budget: the same 256² grid and dispatch count as the ship tier, one compute group (§V104)', () => {
    expect(WAKE_SPEEDBOAT_TIER.n * WAKE_SPEEDBOAT_TIER.n).toBe(WAKE_SHIP_TIER.n * WAKE_SHIP_TIER.n);
    const solver = new WakeSolverGpu({ n: WAKE_SPEEDBOAT_TIER.n, texel: WAKE_SPEEDBOAT_TIER.texel });
    expect(solver.computeNodes.length).toBe(wakeDispatchCount(WAKE_SHIP_TIER.n));
    solver.dispose();
  });

  it('the page\'s flowfoam on this tier (sim backend, 3 prop jets) compiles every pass and dispatches the wake as ONE group', () => {
    const ff = createFlowFoam({ wakeBackend: 'sim', wakeTier: WAKE_SPEEDBOAT_TIER, propJets: 3 });
    const sim = ff.wakeSim!;
    expect(sim.solver.texel).toBe(WAKE_SPEEDBOAT_TIER.texel);
    const q = [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)];
    for (let i = 0; i < 3; i++) sim.tick({ position: [(i * 40) / 60, 0.2, 0], quaternion: q }, [], 6, 1 / 60);
    const computes: unknown[] = [];
    const rec = {
      compute: (c: unknown) => void computes.push(c),
      render: () => {}, setRenderTarget: () => {}, getRenderTarget: () => null, getClearColor: () => {},
      getClearAlpha: () => 0, setClearColor: () => {}, clear: () => {},
    };
    ff.advanceWake(1 / 60);
    ff.update(rec as never, 1 / 60);
    // the wake's group is the one long array; the accumulation tiers submit [advect, blur] pairs
    const groups = computes.filter((c) => Array.isArray(c) && c.length > 2) as unknown[][];
    expect(groups.length).toBe(1);
    // §T.199: the one group carries the near-hull tier's dispatches after the 448 m tier's
    expect(groups[0]).toEqual([...sim.solver.computeNodes, ...(sim.near ? sim.near.computeNodes : [])]);
    const stubCanvas = {
      width: 4, height: 4, style: {}, getContext: (): null => null,
      addEventListener: (): void => {}, removeEventListener: (): void => {},
      getRootNode: (): unknown => ({}), setAttribute: (): void => {},
    };
    const passes = computes.flatMap((c) => (Array.isArray(c) ? (c.length > 2 ? [] : c) : [c]));
    expect(passes.length).toBeGreaterThan(0);
    for (const c of passes) {
      const renderer = new THREE.WebGPURenderer({ canvas: stubCanvas as never });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const backend = (renderer as any).backend;
      backend.renderer = renderer;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (renderer as any).hasFeature = (name: string): boolean => name === 'float32-filterable';
      const builder = backend.createNodeBuilder(c, renderer);
      builder.build();
      expect((builder.computeShader as string).length).toBeGreaterThan(1000);
    }
    ff.dispose();
  });
});

describe('the Havelock far field is the reference the tier is judged against', () => {
  it('one Gaussian at high Fr: the arm tends to Darmon et al. 12.85°/Fr_b from above, and narrows as 1/U', () => {
    const sigma = 2;
    const b = Math.PI * Math.SQRT2 * sigma;
    const src: HydroSample[] = [{ x: 0, z: 0, fy: 1e5, footprint: sigma, depth: 0 }];
    const at = (fr: number): number => havelockArmAngleDeg(src, 0, 0, fr * Math.sqrt(GRAVITY * b), null).alphaDeg;
    for (const fr of [3, 6]) {
      const a = at(fr);
      expect(a).toBeGreaterThanOrEqual((12.85 / fr) * 0.98);
      expect(a).toBeLessThan((12.85 / fr) * 1.1);
    }
    expect(at(3) / at(6)).toBeCloseTo(2, 1);
  });
});

describe('speedboat-40 on her tier: the contact tow', () => {
  const U = WAKE_SPEEDBOAT_MAX_SPEED;
  let tow: Tow;
  let vessel: SpeedboatTow;
  let readout: WakeReadout;
  const sources: HydroSample[] = [];

  beforeAll(() => {
    vessel = new SpeedboatTow(U);
    tow = towPreset(presetByName('speedboat-40'), { vessel });
    const s = tow.solver;
    readout = measureWake({ n: s.n, texel: s.texel, centerX: s.centerX, centerZ: s.centerZ, zeta: s.zeta, phi: s.phi }, tow.frame, tow.x, U);
    vessel.samples(sources);
    for (const j of vessel.jets()) {
      const q = propJetSample(j);
      if (q) sources.push({ ...q });
    }
  }, 240_000);

  it('the arm the solver draws is the Havelock arm of the forcing it draws (±0.35°: the readout steps 0.25°)', () => {
    const predicted = havelockArmAngleDeg(sources, tow.x, 0, U, WAKE_SPEEDBOAT_TIER);
    expect(readout.froudeL).toBeGreaterThan(3); // divergent-dominated: Fr_L ≫ Fr_c = 0.49
    expect(readout.alphaMaxDeg).toBeGreaterThan(readout.alphaRabaudMoisyDeg * 0.5 + 0.25); // not pinned at the search floor
    expect(Math.abs(readout.alphaMaxDeg - predicted.alphaDeg)).toBeLessThanOrEqual(0.35);
    expect(readout.clampHits).toBe(0);
  });

  it('…and the texel\'s band limit keeps that arm within 20% of the Rabaud–Moisy hull-length law for her 12 m', () => {
    const hull = buildDeepVHull();
    expect(tow.frame.length).toBeCloseTo(hull.stemZ - hull.transomZ, 6);
    const rm = rabaudMoisyAngleDeg(U / Math.sqrt(GRAVITY * tow.frame.length));
    const tier = havelockArmAngleDeg(sources, tow.x, 0, U, WAKE_SPEEDBOAT_TIER).alphaDeg;
    expect(Math.abs(tier / rm - 1)).toBeLessThan(0.2);
    expect(Math.abs(readout.alphaMaxDeg / rm - 1)).toBeLessThan(0.2);
  });

  /** ζ² summed by region, in the hull frame (stem at +x, the interior only unless stated) */
  function energy(): { ahead: number; wedge: number; outside: number; armNear: number; armFar: number } {
    const s = tow.solver;
    const interior = (0.5 - defaultSponge(s.n, s.texel).width) * s.n * s.texel;
    const stemX = tow.x + tow.frame.stem;
    const arm = readout.alphaMaxDeg;
    const out = { ahead: 0, wedge: 0, outside: 0, armNear: 0, armFar: 0 };
    for (let j = 0; j < s.n; j++) {
      for (let i = 0; i < s.n; i++) {
        const wx = s.centerX + (i - s.n / 2) * s.texel;
        const wz = s.centerZ + (j - s.n / 2) * s.texel;
        const z = s.zeta[j * s.n + i];
        const e = z * z;
        if (wx > stemX + 5) {
          out.ahead += e; // sponge included: anything here came round the periodic edge
          continue;
        }
        if (Math.abs(wx - s.centerX) > interior || Math.abs(wz - s.centerZ) > interior) continue;
        const r = Math.hypot(stemX - wx, wz);
        if (r <= 2 * tow.frame.halfBeam + 4) continue;
        const ang = (Math.atan2(Math.abs(wz), stemX - wx) * 180) / Math.PI;
        if (ang <= 35) out.wedge += e;
        else out.outside += e;
        // √r-weighted |ζ| peak on the arm: far-field divergent amplitude falls as r^(−½)
        if (Math.abs(ang - arm) <= 1) {
          const v = Math.abs(z) * Math.sqrt(r);
          if (r >= 50 && r <= 100) out.armNear = Math.max(out.armNear, v);
          if (r >= 250 && r <= 300) out.armFar = Math.max(out.armFar, v);
        }
      }
    }
    return out;
  }

  /**
   * At 40 m/s the grid scrolls 7× faster than c_g(L/4) (6.6 m/s on 448 m), so the sponge only
   * holds because γ is scaled by the domain speed (§T.180). Measured: ahead/wedge 5.7e-5 with the
   * scaling, 1.25e-3 without it — the galleon's 5e-3 bound would pass the unscaled sponge, so this
   * one sits between the two.
   */
  it('no wrap-round: energy ahead of the stem < 2.5e-4 and outside the 35° wedge < 5% of the wedge', () => {
    const e = energy();
    expect(e.wedge).toBeGreaterThan(0);
    expect(e.ahead / e.wedge).toBeLessThan(2.5e-4);
    expect(e.outside / e.wedge).toBeLessThan(5e-2);
  });

  it('the arms are LONG: 250–300 m astern they still carry ≥ 30% of their √r-scaled amplitude at 50–100 m', () => {
    const e = energy();
    expect(e.armNear).toBeGreaterThan(0);
    expect(e.armFar / e.armNear).toBeGreaterThan(0.3);
  });
});
