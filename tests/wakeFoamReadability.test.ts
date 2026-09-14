/**
 * W8: the wake we leave reads as WATER WITH SHAPE, not a white blanket (docs/wake/w8-foam-readability.md).
 *
 * USER: "the wake we leave is solid white almost at any kind of speed instantly … even at very slow speeds as soon as
 * the engine runs … we can never appreciate [the exhaust exit bubbles]". The fix is at the sources: bubbles need AIR
 * (the jet's lifted excess carries none), a buried prop draws no surface air, landed water folds in air only past the
 * plunge-entrainment onset, and the through-hub exhaust boils where its plume surfaces.
 *
 * Instrument: the speedboat's own contact towed at the throttle that holds the speed, a CPU solver for the hull head
 * and slope, and the vessel-mode foam rate (`simFoamRateAtCpu`: churn + breaking; ribbon; retained chine packets;
 * exhaust boil) accumulated along her track at the near tier's decay clocks, spread across the track by the tier's
 * blur (σ = blurSpread·√age; along-track blur is left out, which over-states a short patch's peak). Coverage is then
 * read through the
 * ocean material's own laws: the dissolve gate (foamParams.residueKneeLow + erodeDepth — past its top the lane is a
 * solid sheet), the stage-A freshness f^E of the foam/slick clocks, and the white law (`flowfoam.wakeWhiteNode`: the
 * lace gate's sub-pixel mean 1 − √edge, edge rising with age and thin coverage — the only part drawn white).
 */
import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../src/core/loop';
import { stepRigid6 } from '../src/sea-physics/rigidBody';
import { planingSubsteps } from '../src/sea-physics/hullWater';
import { LIFT_DEPTH_FLOOR, liftFraction, waterlineSprayEmission } from '../src/foam/sprayMath';
import { SpeedboatTow } from '../src/wake/speedboatTow';
import { ChineContactHistory } from '../src/wake/chineContact';
import { WAKE_RHO, WakeSolverCpu, type HydroSample, WakeSourceBuffer, defaultSponge, splatSigma, wakeAnchor } from '../src/wake/wakeSolverMath';
import { GRAVITY } from '../src/ocean/oceanMath';
import { exhaustBoil, propJetSample, type PropWashInput } from '../src/wake/propWash';
import { exhaustBoilFoamCpu, propWashFoamCpu, retainedChineFoamCpu, simFoamRateAtCpu, strutFoamCpu, jetRunWindow } from '../src/flowfoam/simFoam';
import { wakeLoadRamp } from '../src/wake/vesselFx';
import { HOLLOW_DEPTHS, createHollowRecord, hollowSamples, measureHollow } from '../src/wake/transomHollow';
import { FX_LEN, createBoatFx, readBoatFx, writeBoatFx } from '../src/sim-worker/fx';
import { appendageFoamDrive, appendageSample, strutsFromJets, type AppendageInput } from '../src/wake/appendages';
import { WAKE_LACE, freshnessExponent } from '../src/flowfoam';
import { flowFoamParams as FP } from '../src/params/flowfoam';
import { foamParams } from '../src/params/foam';

const P = { simBreakRate: FP.simBreakRate, simChurnRate: FP.simChurnRate, simSternChurn: FP.simSternChurn, simSlickPerFoam: FP.simSlickPerFoam };
const BEAM = 2.3;
const TRANSOM = 3.6; // hull origin ahead of the transom (buildDeepVHull)
const GATE_LOW = foamParams.residueKneeLow;
const GATE_TOP = foamParams.residueKneeLow + foamParams.erodeDepth;

const sm = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** the throttle at which her surge acceleration changes sign at speed U (bisection on the drive model) */
function holdingThrottle(U: number): number {
  const accel = (thr: number): number => {
    const tow = new SpeedboatTow(U, thr);
    tow.advanceTo(U * 2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = tow as any;
    let sum = 0;
    for (let k = 0; k < 60; k++) {
      t.hw.setControls(0, thr);
      t.state.position[0] += U * SIM_DT;
      t.hw.samplePatch(() => 0, t.state, SIM_DT);
      stepRigid6(t.state, t.hull, SIM_DT, planingSubsteps(t.hw, t.state, SIM_DT), (st, h, out) => t.hw.evaluate(st, h, out), t.memory);
      sum += t.state.velocity[0] - U;
      t.state.velocity[0] = U;
      t.state.velocity[2] = 0;
      t.state.position[2] = 0;
      t.state.angularVelocity[1] = 0;
    }
    return sum;
  };
  if (accel(0) > 0) return 0;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 9; i++) {
    const m = (lo + hi) / 2;
    if (accel(m) > 0) hi = m;
    else lo = m;
  }
  return (lo + hi) / 2;
}

interface Cell { a: number; y: number; cov: number; white: number; boil: number }

/** steady wake foam behind her at U: cells a m astern of the transom (1..reach), y m across */
function steadyWake(U: number, reach: number) {
  const tow = new SpeedboatTow(U, holdingThrottle(U));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hw = (tow as any).hw;
  const n = 128;
  const texel = 0.5;
  const solver = new WakeSolverCpu({ n, texel });
  solver.setDomainVelocity(U, 0);
  const buf = new WakeSourceBuffer();
  const history = new ChineContactHistory();
  let emitter: ReturnType<ChineContactHistory['update']> | null = null;
  const dt = 1 / 30;
  let tick = 0;
  for (let t = 0; t < 8; t += dt) {
    const x = U * t;
    tow.advanceTo(x);
    const c = wakeAnchor(x, 0, 1, 0, tow.frame.stem + 8, n * texel, defaultSponge(n, texel), 4 * splatSigma(0, texel, n));
    solver.setCenter(c.x, c.z);
    buf.clear();
    const ramp = Math.min(1, t / 3);
    for (const s of tow.samples()) buf.push(s.x, s.z, s.fy * ramp, s.footprint, s.depth);
    for (const j of tow.jets()) {
      const q = propJetSample(j);
      if (q) buf.pushJet(q.x, q.z, q.fy * ramp, q.footprint, q.depth);
    }
    solver.splat(buf);
    solver.step(dt, { slope: true });
    for (let k = 0; k < 2; k++) {
      const bow = waterlineSprayEmission({ waterline: hw.waterline, sections: hw.sections, stripZ: hw.mesh.strips.zCentre }, tow.pose.quaternion);
      emitter = history.update(0, tick++, { ...bow }, U, 0, SIM_DT);
    }
  }
  const jets = tow.jets().map((j) => ({ ...j })) as PropWashInput[];
  const depth = Math.max(LIFT_DEPTH_FLOOR, buf.depthBins().d1);
  const px = tow.pose.position[0];
  const fields = { n, texel, centerX: solver.centerX, centerZ: solver.centerZ, slopeX: solver.slopeX, slopeZ: solver.slopeZ, head: solver.head, headJet: solver.headJet, sponge: solver.sponge };
  const vessel = { x: px, z: 0, radius: 6, vx: U, vz: 0, lift: liftFraction(U, depth), depth };
  const frame = { hullVelX: U, hullVelZ: 0, lift: vessel.lift, depth, vessels: [vessel], jets: [] as PropWashInput[] };
  const tier = FP.regionSize / FP.resolution;
  const T = FP.decayHalfLife;
  const Ts = FP.slickHalfLife;
  const E = freshnessExponent(T, Ts);
  const ds = 0.5;
  const ys: number[] = [];
  for (let y = -16; y <= 16; y += 0.5) ys.push(y);
  // the rate field is steady in her frame: a world point now s′ = a astern was at s ≤ a, (a − s)/U seconds ago
  const rows: { total: number; boil: number }[][] = [];
  const sAt = (i: number): number => -12 + i * ds;
  for (let i = 0; sAt(i) <= TRANSOM + reach; i++) {
    rows.push(ys.map((y) => {
      const x = px - sAt(i);
      const boil = exhaustBoilFoamCpu(jets, x, y, tier);
      const total = simFoamRateAtCpu(fields, x, y, tier, frame, P)[0] + P.simChurnRate * propWashFoamCpu(jets, x, y, tier, true) + boil
        + (emitter ? retainedChineFoamCpu([emitter], x, y, tier) : 0);
      return { total, boil };
    }));
  }
  const cells: Cell[] = [];
  const dy = ys[1] - ys[0];
  for (let a = 1; a <= reach; a++) {
    ys.forEach((y) => {
      // the accumulation's own recurrence, oldest first: r ← min(1, r·2^(−dt/T) + injection·dt) — the ≤ 1 clamp is
      // what keeps a saturated lane's foam/slick ratio (its freshness) high while the churn keeps it pinned
      let F = 0;
      let G = 0;
      let B = 0;
      const dt = ds / U;
      for (let i = 0; sAt(i) <= TRANSOM + a; i++) {
        const age = (TRANSOM + a - sAt(i)) / U;
        const v = FP.blurSpread * FP.blurSpread * age + dy * dy / 4;
        let inj = 0;
        let injB = 0;
        for (let k = 0; k < ys.length; k++) {
          const g = Math.exp(-((y - ys[k]) ** 2) / (2 * v)) * dy / Math.sqrt(2 * Math.PI * v);
          if (g < 1e-6) continue;
          inj += g * rows[i][k].total;
          injB += g * rows[i][k].boil;
        }
        F = Math.min(1, F * 2 ** (-dt / T) + inj * dt);
        G = Math.min(1, G * 2 ** (-dt / Ts) + P.simSlickPerFoam * inj * dt);
        B = Math.min(1, B * 2 ** (-dt / T) + injB * dt);
      }
      const cov = Math.min(1, F);
      const fresh = F > 1e-9 ? Math.min(1, (F * P.simSlickPerFoam) / Math.max(G, F * P.simSlickPerFoam, 1e-12)) ** E : 0;
      const mask = sm(GATE_LOW, GATE_TOP, cov);
      const t = sm(WAKE_LACE.freshLow, WAKE_LACE.freshHigh, fresh);
      const maskFresh = mask * cov; // the wake mask's mean at this coverage (a porous body of mean ≈ 1 at saturation)
      const edge = Math.min(0.97, WAKE_LACE.edgeAged + (WAKE_LACE.edgeFresh - WAKE_LACE.edgeAged) * t + (1 - sm(0.1, 0.7, maskFresh)) * 0.22);
      const white = (1 - Math.sqrt(edge)) * (WAKE_LACE.fleckGain + (1 - WAKE_LACE.fleckGain) * t) * sm(0.01, 0.08, cov); // resolved lace share
      cells.push({ a, y, cov, white, boil: B });
    });
  }
  // the wake wedge: her beam plus the Kelvin half-angle
  const wedge = cells.filter((c) => Math.abs(c.y) <= BEAM / 2 + c.a * Math.tan((19.47 * Math.PI) / 180));
  const frac = (pred: (c: Cell) => boolean): number => wedge.filter(pred).length / wedge.length;
  const widthBeams = (a: number, pred: (c: Cell) => boolean): number => {
    const row = cells.filter((c) => c.a === a && pred(c));
    return row.length ? (row[row.length - 1].y - row[0].y + 0.5) / BEAM : 0;
  };
  return { jets, wedge, frac, widthBeams };
}

describe('W8 the wake we leave reads as water with shape, not a white blanket', () => {
  it('2 m/s with the engine in gear: no solid lane and next to no white in the wedge, but each exhaust boils where its plume surfaces', () => {
    const w = steadyWake(2, 30);
    // the user's blanket: coverage past the dissolve gate's top renders as one solid sheet. Before W8 the jet's lifted
    // excess painted a slab (coverage 1.0 from 2 to 30 m astern) behind a drive merely in gear.
    // Now nothing is solid past the boil, and the boil itself is a patch mid-gate, not a slab
    expect(w.frac((c) => c.cov >= GATE_TOP && c.a >= 20)).toBeLessThan(0.02);
    expect(w.frac((c) => c.cov >= GATE_TOP)).toBeLessThan(0.1);
    expect(Math.max(...w.wedge.map((c) => c.cov))).toBeLessThan(0.6);
    // a few surfacing flecks at most (round 3's slip-drawn air lays a trace behind a loaded drive at 4 kn)
    expect(w.frac((c) => c.white > 0.5)).toBeLessThan(0.02);
    // …and the exhaust is there to appreciate: a boil behind every drive, carrying a real share of what she lays
    for (const j of w.jets) {
      const b = exhaustBoil(j);
      expect(b.flux).toBeGreaterThan(0);
      expect(b.share).toBeGreaterThan(0.1);
    }
    const boil = w.wedge.reduce((s, c) => s + c.boil, 0);
    const all = w.wedge.reduce((s, c) => s + c.cov, 0);
    expect(boil).toBeGreaterThan(0.25 * all);
    // it is a patch where the plume surfaces, not a lane: most of it within about two boat lengths of the transom
    const near = w.wedge.filter((c) => c.a <= 15).reduce((s, c) => s + c.boil, 0);
    expect(near).toBeGreaterThan(0.5 * boil);
  }, 120_000);

  it('planing at 30 m/s: a dense white core ≤ 3 beams wide for the first tens of metres that breaks into lace, never a stripe', () => {
    const w = steadyWake(30, 60);
    const whiteMax = (a: number): number => Math.max(...w.wedge.filter((c) => c.a === a).map((c) => c.white));
    // there IS a dense white churn behind the drives (the user wants the planing wash to read) …
    expect(Math.max(whiteMax(10), whiteMax(15), whiteMax(20))).toBeGreaterThan(0.5);
    for (const a of [10, 15, 20]) expect(w.widthBeams(a, (c) => c.white > 0.5)).toBeLessThanOrEqual(3);
    // … which has broken up by 40 m (coordinator: dense 15–30 m, lace by 40–60 m — not a 100 m white stripe) …
    for (const a of [40, 50, 60]) expect(whiteMax(a)).toBeLessThan(0.5);
    // … into lace that is still there, not a fade to nothing
    for (const a of [40, 60]) expect(whiteMax(a)).toBeGreaterThan(0.05);
    expect(w.frac((c) => c.white > 0.5)).toBeLessThan(0.1);
    // the solid part of the lane stays a core, not the wedge
    for (const a of [10, 30]) expect(w.widthBeams(a, (c) => c.cov >= GATE_TOP)).toBeLessThanOrEqual(3);
    // the exhaust has been swallowed by the wash at speed: its boil is a trace of the lane
    for (const j of w.jets) expect(exhaustBoil(j).share).toBeLessThan(0.02);
  }, 120_000);
});

describe('W8 round 3: impacts evolve in time, and every drive strut marks the water', () => {
  it('a landing load rises over tens of milliseconds instead of one tick; an airborne hull drops it at once', () => {
    const st = { load: 0 };
    const dt = 1 / 60;
    // airborne → a 60 kN landing load arrives in one tick
    expect(wakeLoadRamp(st, 0, dt)).toBe(1);
    const first = wakeLoadRamp(st, 60_000, dt);
    expect(first).toBeLessThan(0.35); // the solver never sees the whole pulse on the impact tick
    let t = dt;
    let share = first;
    while (share < 0.95) { share = wakeLoadRamp(st, 60_000, dt); t += dt; }
    expect(t).toBeGreaterThan(0.1);
    expect(t).toBeLessThan(0.5);
    // leaving the water is not delayed
    expect(wakeLoadRamp(st, 0, dt)).toBe(1);
    expect(st.load).toBe(0);
  });

  it('vessel mode lays no instant waterplane-rim ring from vertical burial (the impact water is the flying chine sheet)', () => {
    const n = 64;
    const head = new Float64Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) head[j * n + i] = Math.max(0, 0.4 - 0.02 * Math.hypot(i - n / 2, j - n / 2));
    const fields = { n, texel: 0.5, centerX: 0, centerZ: 0, slopeX: new Float64Array(n * n), slopeZ: new Float64Array(n * n), head, sponge: { width: 0.15 } };
    const burial = { a: 4, b: 0, c: 0, ox: 0, oz: 0, rms: 4, rimLength: 1.5 };
    const base = { hullVelX: 0, hullVelZ: 0, lift: 1, depth: 0.4, burial };
    const rim = (vessels: boolean) => simFoamRateAtCpu(fields, 4, 0, 0.234, vessels ? { ...base, vessels: [{ x: 0, z: 0, radius: 6, vx: 0, vz: 0, lift: 1, depth: 0.4 }] } : base, P)[0];
    expect(rim(false)).toBeGreaterThan(0); // the single-hull raft/galleon graph keeps §T.70's rim churn
    expect(rim(true)).toBe(0);
  });

  it('a drive strut trails a thin eddy streak at 5 kn and a stronger ventilated one at speed, and a small split-wave source', () => {
    const at = (U: number, depth: number): AppendageInput => ({ x: 0, z: 0, dirX: 1, dirZ: 0, chord: 0.38, thickness: 0.07, depth, speed: U });
    const slow = appendageFoamDrive(at(2.5, 0.8));
    const fast = appendageFoamDrive(at(30, 0.4));
    expect(slow).toBeGreaterThan(0);
    expect(fast).toBeGreaterThan(5 * slow);
    expect(appendageFoamDrive(at(0, 0.8))).toBe(0);
    const src = appendageSample(at(2.5, 0.8))!;
    expect(src.fy).toBeCloseTo(WAKE_RHO * GRAVITY * 0.07 * 0.38 * 0.8, 6); // its immersed displacement, the hull sources’ currency
    expect(appendageSample(at(2.5, 0))).toBeNull();
    // the speedboat's struts come from her drives' live jets (steer/trim move them), just forward of each prop
    const jet: PropWashInput = { x: 10, z: 0, dirX: -1, dirZ: 0, thrust: 900, discArea: Math.PI * 0.2 ** 2, depth: 0.7, advance: 2.5, immersion: 1, propRps: 11 };
    const out: AppendageInput[] = [];
    expect(strutsFromJets([jet], out)).toBe(1);
    expect(out[0].x).toBeCloseTo(10.2, 9);
    expect(strutFoamCpu([jet], 10.2 - 3, 0, 0.234)).toBeGreaterThan(0);
    expect(strutFoamCpu([jet], 10.2 - 3, 2, 0.234)).toBeLessThan(0.05 * strutFoamCpu([jet], 10.2 - 3, 0, 0.234));
  });
});

describe('W8 round 4: a prop that re-enters the water lays its lane over time, not in one tick', () => {
  it('the ribbon window is 1 up to the distance run since re-entry and 0 two metres past it', () => {
    const N = { k: (v: number) => v, add: (a: number, b: number) => a + b, sub: (a: number, b: number) => a - b, mul: (a: number, b: number) => a * b, div: (a: number, b: number) => a / b, max: Math.max, min: Math.min, neg: (a: number) => -a, sqrt: Math.sqrt, exp: Math.exp,
      smoothstep: (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); } };
    // one tick after landing at 25 m/s: 0.42 m run — the 12–60 m steady ribbon must not be there yet
    const run = 25 / 60;
    expect(jetRunWindow(N, -0.2, 0, -1, 0, run)).toBe(1);
    expect(jetRunWindow(N, -10, 0, -1, 0, run)).toBe(0);
    // a second later the ribbon reaches 25 m
    expect(jetRunWindow(N, -20, 0, -1, 0, 25)).toBe(1);
    expect(jetRunWindow(N, -30, 0, -1, 0, 25)).toBe(0);
  });
});

describe('W8 round 5: the transom hollow is drawn as a virtual hull extension, from the physics own depth field', () => {
  // a hollow shaped like the physics' profile: 0.3 m deep at the transom, closing 9 m aft; 0 ahead of the transom
  const depthAt = (_x: number, z: number): number => (z < 0 && z > -9 ? 0.3 * (1 - (-z / 9) ** 2) : 0);
  it('measures where the hollow closes and its depths, and presses the surface by ρ·g·depth over it, astern', () => {
    const rec = measureHollow(depthAt, 0, 0, 0, 1, 2.3, createHollowRecord());
    expect(rec.length).toBeGreaterThan(8);
    expect(rec.length).toBeLessThanOrEqual(9.2);
    expect(rec.depths[0]).toBeGreaterThan(rec.depths[HOLLOW_DEPTHS - 1]);
    const out: HydroSample[] = [];
    expect(hollowSamples(rec, out)).toBe(HOLLOW_DEPTHS);
    for (const q of out) expect(q.z).toBeLessThan(0);
    const load = out.reduce((a, q) => a + q.fy, 0);
    let integral = 0;
    for (let z = -0.005; z > -rec.length; z -= 0.01) integral += depthAt(0, z) * 0.01 * rec.width;
    expect(Math.abs(load / (WAKE_RHO * GRAVITY * integral) - 1)).toBeLessThan(0.05);
    // a wet transom / no hollow publishes nothing
    expect(hollowSamples(measureHollow(() => 0, 0, 0, 0, 1, 2.3, createHollowRecord()), [])).toBe(0);
  });
  it('rides the effects record, so rivals draw theirs too (write → read round trip)', () => {
    const tow = new SpeedboatTow(30, 0.9);
    tow.advanceTo(30 * 5);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hw = (tow as any).hw;
    const rec = new Float64Array(FX_LEN);
    writeBoatFx(hw, tow.pose, rec, 0);
    const fx = readBoatFx(rec, 0, createBoatFx());
    const direct = measureHollow((x, z) => hw.transomWakeDepthAt(x, z), fx.hollow.x, fx.hollow.z, fx.hollow.fwdX, fx.hollow.fwdZ, 2.3, createHollowRecord());
    expect(fx.hollow.length).toBeCloseTo(direct.length, 6);
    if (typeof hw.transomWakeDepthAt === 'function') expect(fx.hollow.length).toBeGreaterThan(0);
  }, 60_000);
});
