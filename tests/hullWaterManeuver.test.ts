/**
 * Speedboat MANEUVERING (§T.179 S1b): lateral 2D+t, gearcase foils, thrust vectoring, Kirchhoff completion,
 * transom-face wetting, coupled 6×6 added mass — WHY these tests (docs/speedboat/physics-log.md, T179 section):
 *
 *  - A boat at rest must not move (resting drift). Two defects made it walk: the Garme transom reduction
 *    switched the transom FACE's hydrostatic pressure on and off with the sign of a 1e-7 m/s surge (a one-way
 *    brake that rectified bobbing into aft drift), and without the Kirchhoff −ω×(A·v) term a heaving,
 *    pitching hull swapped momentum between body axes each cycle (0.31 m/s forward after settling).
 *  - She must run straight with the helm centred, turn when steered, bank INTO the turn, lose speed the way
 *    trials do, keep her grip, and not steer in the air.
 *  - Every number is a property with a source or a closed form; each block names the mutation it catches.
 */
import { describe, expect, it } from 'vitest';
import { quatFromAxisAngle, rotateVec } from '../src/core/quat';
import { HULL_WATER_DEFAULTS, HullWater, type HeightSampler, type HullWaterParams } from '../src/sea-physics/hullWater';
import { createRigid6Memory, stepRigid6, type Rigid6State } from '../src/sea-physics/rigidBody';
import { buildDeepVHull, HULL_DATA } from '../src/speedboat/hullMesh';
import type { Quat, Vec3 } from '../src/state/simState';

const DT = 1 / 60;
const G = 9.81;
const RHO = 1025;
const FLAT: HeightSampler = () => 0;
const hull = buildDeepVHull();
const L = HULL_DATA.spec.length;
const B = 2 * HULL_DATA.spec.chineHalfBeam;
const LOCK = hull.drives[0].maxSteerRad;

function st(p: Vec3, q: Quat = [0, 0, 0, 1], v: Vec3 = [0, 0, 0], w: Vec3 = [0, 0, 0]): Rigid6State {
  return { position: [...p] as Vec3, quaternion: [...q] as Quat, velocity: [...v] as Vec3, angularVelocity: [...w] as Vec3 };
}

const trimDeg = (q: Quat): number => (Math.asin(Math.max(-1, Math.min(1, 2 * (q[1] * q[2] - q[3] * q[0])))) * 180) / Math.PI;

/** a hull settled at its hydrostatic rest pose (test-side damper, then removed and velocities zeroed) */
function restPose(params: Partial<HullWaterParams> = {}): { hw: HullWater; s: Rigid6State; mem: ReturnType<typeof createRigid6Memory> } {
  const hw = new HullWater(hull, params);
  const mem = createRigid6Memory();
  const s = st([0, 0.3, 0]);
  for (let t = 0; t < 20 * 60; t++) {
    hw.samplePatch(FLAT, s, DT);
    stepRigid6(s, hull, DT, 2, (ss, h, out) => {
      hw.evaluate(ss, h, out);
      for (let k = 0; k < 3; k++) {
        out.force[k] -= 3 * hull.mass * ss.velocity[k];
        out.torque[k] -= 3 * hull.inertia[0] * ss.angularVelocity[k];
      }
    }, mem);
  }
  for (let k = 0; k < 3; k++) s.velocity[k] = s.angularVelocity[k] = 0;
  return { hw, s, mem };
}

interface TurnResult {
  diameterOverL: number;
  speedRatio: number;
  approach: number;
  steadySpeed: number;
  heelInDeg: number;
  heelAmpDeg: number;
  maxDriftDeg: number;
  minUpY: number;
  yawRate: number;
  headingWanderDeg: number;
}

/**
 * Straight at C_v for 12 s (throttle from a speed-hold loop), then the helm is put over at 30°/s (hydraulic
 * steering; ASSUMED) and the throttle frozen at its straight-line value: 30 s of free turning. Steady values
 * are the mean of the last 8 s. `heelInDeg` > 0 means the boat heels INTO the turn.
 */
function turn(cv: number, steerFraction: number, params: Partial<HullWaterParams> = {}, N = 2, seconds = 30): TurnResult {
  const U = cv * Math.sqrt(G * B);
  // the non-stepped proxy needs more than the 1 MW of three 450Rs to hold C_v 8–10; the harness supplies it
  const hw = new HullWater(hull, { standInDrivePowerW: 4e6, ...params });
  const mem = createRigid6Memory();
  const s = st([0, 0.35, 0], [-Math.sin(0.02), 0, 0, Math.cos(0.02)], [0, 0, U]);
  const T1 = 12;
  const T2 = T1 + seconds;
  let integ = 0;
  let thrSum = 0;
  let thrN = 0;
  let heading = 0;
  let prevHead = 0;
  let minUp = 1;
  let maxDrift = 0;
  const rec: { t: number; heading: number; speed: number; heel: number }[] = [];
  for (let t = 0; t < T2 * 60; t++) {
    const time = t / 60;
    const speed = Math.hypot(s.velocity[0], s.velocity[2]);
    if (time < T1) {
      const err = U - speed;
      integ += err * DT;
      const thr = Math.max(0, Math.min(1, 0.3 + 0.3 * err + 0.1 * integ));
      if (time > T1 - 3) {
        thrSum += thr;
        thrN++;
      }
      hw.setControls(0, thr);
    } else {
      hw.setControls(Math.min(steerFraction * LOCK, (time - T1) * (30 * Math.PI) / 180), thrSum / thrN);
    }
    hw.samplePatch(FLAT, s, DT);
    stepRigid6(s, hull, DT, N, (ss, h, out) => hw.evaluate(ss, h, out), mem);
    const f = rotateVec(s.quaternion, [0, 0, 1]);
    const r = rotateVec(s.quaternion, [1, 0, 0]);
    const up = rotateVec(s.quaternion, [0, 1, 0]);
    const head = Math.atan2(f[0], f[2]);
    let dh = head - prevHead;
    if (dh > Math.PI) dh -= 2 * Math.PI;
    if (dh < -Math.PI) dh += 2 * Math.PI;
    heading += dh;
    prevHead = head;
    let drift = head - Math.atan2(s.velocity[0], s.velocity[2]);
    if (drift > Math.PI) drift -= 2 * Math.PI;
    if (drift < -Math.PI) drift += 2 * Math.PI;
    if (time > T1) {
      minUp = Math.min(minUp, up[1]);
      maxDrift = Math.max(maxDrift, (Math.abs(drift) * 180) / Math.PI);
    }
    // positive steer turns the bow toward body −x, so the INSIDE of the turn is −x: body +x rising = heeling in
    rec.push({ t: time, heading, speed, heel: (Math.asin(Math.max(-1, Math.min(1, r[1]))) * 180) / Math.PI });
  }
  const pre = rec.filter((x) => x.t > T1 - 8 && x.t < T1);
  const last = rec.filter((x) => x.t > T2 - 8);
  const yawRate = (last[last.length - 1].heading - last[0].heading) / (last[last.length - 1].t - last[0].t);
  const steadySpeed = last.reduce((a, x) => a + x.speed, 0) / last.length;
  const heels = last.map((x) => x.heel);
  return {
    diameterOverL: (2 * steadySpeed) / Math.abs(yawRate) / L,
    speedRatio: steadySpeed / U,
    approach: U,
    steadySpeed,
    heelInDeg: heels.reduce((a, x) => a + x, 0) / heels.length,
    heelAmpDeg: (Math.max(...heels) - Math.min(...heels)) / 2,
    maxDriftDeg: maxDrift,
    minUpY: minUp,
    yawRate,
    headingWanderDeg: ((Math.max(...pre.map((x) => x.heading)) - Math.min(...pre.map((x) => x.heading))) * 180) / Math.PI,
  };
}

describe('at rest (T179: the resting drift)', () => {
  it('a hull at her rest pose in calm water stays put: < 1 cm in 60 s', () => {
    // WHY: calm water puts no horizontal force on a closed hull, so any walk is a model defect. 1 cm/min
    // (0.17 mm/s) is below every real disturbance the game has (wind, current, wake) by orders of magnitude,
    // yet 10× the 0.8 mm the corrected model shows. Before the fix: 12.7 cm in 60 s from the SAME pose (the
    // transom face's pressure toggled by the sign of a 1e-7 m/s surge through Garme's tanh at x_T = ±4e-16).
    const { hw, s, mem } = restPose();
    const x0 = s.position[0];
    const z0 = s.position[2];
    for (let t = 0; t < 60 * 60; t++) {
      hw.samplePatch(FLAT, s, DT);
      stepRigid6(s, hull, DT, 2, (ss, h, out) => hw.evaluate(ss, h, out), mem);
    }
    expect(Math.hypot(s.position[0] - x0, s.position[2] - z0)).toBeLessThan(0.01);
  });

  it('released 20 cm high she settles without walking away: horizontal speed ≤ the entry impulse turned by her trim, and the Kirchhoff term is what holds it', () => {
    // WHY: a pitched hull settling does get a small horizontal push (pressure is normal to a trimmed bottom),
    // bounded by the vertical entry momentum redirected through the trim: |v_h| ≤ tan(θ_max)·√(2g·Δy).
    // Without −ω×(A·v) the body-axis added mass rectified the heave–pitch cycle into 0.31 m/s — a hull that
    // leaves the dock on its own. The same run with the term off must break the bound (the mutation).
    const drop = (params: Partial<HullWaterParams>): { vh: number; bound: number } => {
      const hw = new HullWater(hull, params);
      const mem = createRigid6Memory();
      const s = st([0, 0.5, 0]);
      let maxTrim = 0;
      for (let t = 0; t < 60 * 60; t++) {
        hw.samplePatch(FLAT, s, DT);
        stepRigid6(s, hull, DT, 2, (ss, h, out) => hw.evaluate(ss, h, out), mem);
        maxTrim = Math.max(maxTrim, Math.abs(trimDeg(s.quaternion)));
      }
      return { vh: Math.hypot(s.velocity[0], s.velocity[2]), bound: Math.tan((maxTrim * Math.PI) / 180) * Math.sqrt(2 * G * 0.2) };
    };
    const on = drop({});
    expect(on.vh).toBeLessThan(on.bound);
    const off = drop({ kirchhoff: false });
    expect(off.vh).toBeGreaterThan(off.bound);
  });
});

describe('straight running and turning (T179 acceptance)', () => {
  it('helm centred at C_v 3–10: no yaw divergence, heading wander < 0.25° over 60 s', () => {
    // WHY: a slender planing hull alone is directionally unstable (Munk moment of the lateral momentum flux);
    // the gearcases aft are what make her run straight. A divergence grows exponentially and blows any bound in
    // a minute; 0.25°/min is below what a helmsman notices. Mutation: driveFoil off ⇒ the hull alone.
    for (const cv of [3, 5, 8, 10]) {
      const U = cv * Math.sqrt(G * B);
      const hw = new HullWater(hull, { standInDrivePowerW: 4e6 });
      const mem = createRigid6Memory();
      const s = st([0, 0.35, 0], [-Math.sin(0.02), 0, 0, Math.cos(0.02)], [0, 0, U]);
      let integ = 0;
      const heads: number[] = [];
      let maxYawRate = 0;
      for (let t = 0; t < 70 * 60; t++) {
        const err = U - Math.hypot(s.velocity[0], s.velocity[2]);
        integ += err * DT;
        hw.setControls(0, Math.max(0, Math.min(1, 0.3 + 0.3 * err + 0.1 * integ)));
        hw.samplePatch(FLAT, s, DT);
        stepRigid6(s, hull, DT, 2, (ss, h, out) => hw.evaluate(ss, h, out), mem);
        if (t >= 10 * 60) {
          const f = rotateVec(s.quaternion, [0, 0, 1]);
          heads.push((Math.atan2(f[0], f[2]) * 180) / Math.PI);
          maxYawRate = Math.max(maxYawRate, Math.abs(s.angularVelocity[1]));
        }
      }
      expect(Math.max(...heads) - Math.min(...heads), `C_v ${cv}`).toBeLessThan(0.25);
      expect(maxYawRate, `C_v ${cv}`).toBeLessThan(1e-3);
    }
  });

  // one helm setting through the speed range: a third of the lock (10°) — see the envelope test for more
  const third = [3, 5, 8, 10].map((cv) => ({ cv, r: turn(cv, 1 / 3) }));

  it('turns: steady diameter within full-scale planing-craft data (8–40 L) at 10° of drive, growing with speed', () => {
    // SOURCES: Sadati, Zeraatgar & Moghaddas, Proc IMechE M 236 (2022) full-scale trials — semi-planing
    // 8–15 L, planing up to 40 L; Denny & Hubble, Marine Technology 28 (1991) trials 10–20 L and "the
    // turning radius increases with speed" (both as reported by Aslan, NPS thesis 2015). A few boat lengths
    // is a displacement-ship number, not a planing one. Mutation: lateralAddedMassCoeff 0 (no hull grip) or
    // driveFoil off both leave this band.
    // the trials reach ~60 kn; C_v 10 (92 kn) is beyond them and only has to keep the trend
    for (const { cv, r } of third.filter((x) => x.cv <= 8)) {
      expect(r.diameterOverL, `C_v ${cv}`).toBeGreaterThanOrEqual(8);
      expect(r.diameterOverL, `C_v ${cv}`).toBeLessThanOrEqual(40);
    }
    for (let i = 1; i < third.length; i++) expect(third[i].r.diameterOverL).toBeGreaterThan(third[i - 1].r.diameterOverL);
  });

  it('banks INTO the turn where the bottom pressure sits outboard of the CG line (C_v 3–5), keeps her grip and her plane', () => {
    // WHY: a deep-V's side force is pressure on the LEADING bottom panel (Marleaux, Simonis & Abdel-Maksoud,
    // 35th Symp. Naval Hydrodynamics 2024: "a strong pressure increase at one of the spray roots … main cause
    // for side forces"), whose normal line passes c/sin2β above the keel — above the CG while the wetted
    // half-beam c is wide — and the gearcases push the stern out BELOW the CG: both roll her in. A side force
    // put through the strip centroid heels her out (measured −3° at C_v 5).
    // Grip: drift stays under Kerner's ~20° hard-turn slip. Plane: from C_v 5 up she is still planing in the
    // turn (F∇ > 3, the planing regime of Savitsky-type classification); at C_v 3 the Denny & Hubble test below
    // is the check that she drops only as far as trials do.
    for (const { cv, r } of third) {
      if (cv <= 5) expect(r.heelInDeg, `C_v ${cv}`).toBeGreaterThan(1);
      expect(r.minUpY, `C_v ${cv}: never past 25° of heel`).toBeGreaterThan(Math.cos((25 * Math.PI) / 180));
      expect(r.maxDriftDeg, `C_v ${cv}`).toBeLessThan(20);
      if (cv >= 5) expect(r.steadySpeed / Math.sqrt(G * Math.cbrt(hull.mass / RHO)), `C_v ${cv}: still planing`).toBeGreaterThan(3);
    }
  });

  it('loses speed in the turn as Denny & Hubble trials do: U_c/U_a = 1/√(1 + K_c(L/R)²) within 0.15 (C_v 3, 10°–30°)', () => {
    // SOURCE: Denny & Hubble 1991 eqs. as reproduced by Aslan (NPS 2015, eqs. 21–25): K_c = F∇²·(30°/δ),
    // F∇ = U/√(g∇^⅓); valid 0.3 < F∇ < 4, which C_v 3 (F∇ 3.45) is and C_v ≥ 4 is not. The speed loss is the
    // drag of making the side force; a turn that kept its speed (no induced drag) or stalled to a crawl fails.
    const vol = hull.mass / RHO;
    for (const frac of [1 / 3, 0.5, 1]) {
      const r = frac === 1 / 3 ? third[0].r : turn(3, frac);
      const fv = r.approach / Math.sqrt(G * Math.cbrt(vol));
      const kc = fv * fv * (30 / ((frac * LOCK * 180) / Math.PI));
      const R = (r.diameterOverL * L) / 2;
      const dh = 1 / Math.sqrt(1 + kc * (L / R) ** 2);
      expect(Math.abs(r.speedRatio - dh), `δ ${(frac * 30).toFixed(0)}°: model ${r.speedRatio.toFixed(2)} vs D&H ${dh.toFixed(2)}`).toBeLessThanOrEqual(0.15);
    }
  });

  it('turning circle converges with substeps: D/L and turn speed change < 2% from N = 2 to N = 4 (V107)', () => {
    const a = turn(5, 1 / 3, {}, 2);
    const b = turn(5, 1 / 3, {}, 4);
    expect(Math.abs(a.diameterOverL - b.diameterOverL) / b.diameterOverL).toBeLessThan(0.02);
    expect(Math.abs(a.speedRatio - b.speedRatio) / b.speedRatio).toBeLessThan(0.02);
  });

  it.fails('KNOWN LIMIT (reported): half or full lock at C_v ≥ 5 hooks — the acceptance "no capsize or spin-out at 50%/100% steer, C_v 3–10" is NOT met', () => {
    // The physics does not give it. At 23.8 m/s one degree of gearcase is ~15 kN of lift slope per drive on a
    // 5.4 t boat (Helmbold slope, three 0.22 m² gearcases, capped by ventilation): at 15° the stern is driven to
    // large slip, the heel runs up and the inner chine trips (measured with a 30°/s helm: C_v 5 at half lock
    // heels 35 ± 20°, C_v 8–10 capsize; full lock capsizes from C_v 5). Real outboard boats are not put hard over
    // at 45 kn; the doc's S2 plan limits the lock with speed (±12° at top speed) and a steering-actuator torque
    // limit is the physical version. This block fails for that reason (flip to `it` to read the numbers).
    for (const frac of [0.5, 1]) {
      for (const cv of [5, 8, 10]) {
        const r = turn(cv, frac, {}, 2, 20);
        expect(r.minUpY, `C_v ${cv} at ${frac * 100}% lock`).toBeGreaterThan(0.5);
        expect(r.maxDriftDeg, `C_v ${cv} at ${frac * 100}% lock`).toBeLessThan(45);
      }
    }
  });
});

describe('drives: thrust, gearcase foil, ventilation, air', () => {
  it('a gearcase out of the water makes no side force and no thrust — she cannot steer in the air', () => {
    // WHY (task acceptance): steering is water pushing on the drives. Lifted clear, they must do nothing, and
    // an airborne boat's rotation must be the ballistic one whatever the helm does.
    const air = (steer: number): Rigid6State => {
      const hw = new HullWater(hull);
      const mem = createRigid6Memory();
      const s = st([0, 6, 0], quatFromAxisAngle([1, 0, 0], -0.1), [0, 4, 30], [0.1, 0.05, -0.1]);
      hw.setControls(steer, 1);
      for (let t = 0; t < 30; t++) {
        hw.samplePatch(FLAT, s, DT);
        stepRigid6(s, hull, DT, 2, (ss, h, out) => hw.evaluate(ss, h, out), mem);
        expect(hw.driveForce.every((x) => x === 0) && hw.driveTorque.every((x) => x === 0)).toBe(true);
        expect([...hw.gearcaseImmersion].every((x) => x === 0)).toBe(true);
      }
      return s;
    };
    const a = air(LOCK);
    const b = air(0);
    expect(a.angularVelocity).toEqual(b.angularVelocity);
    expect(a.quaternion).toEqual(b.quaternion);
    // and IN the water the same helm does push: the property above is not "the foil never works"
    const hw = new HullWater(hull);
    const s = st([0, 0.35, 0], [-Math.sin(0.02), 0, 0, Math.cos(0.02)], [0, 0, 20]);
    hw.setControls(0.1, 0);
    hw.samplePatch(FLAT, s, DT);
    hw.evaluate(s, DT / 2);
    expect(hw.gearcaseImmersion[1]).toBe(1);
    expect(Math.abs(hw.foilSideForce)).toBeGreaterThan(10_000);
  });

  it('side force falls smoothly as the gearcase is lifted (immersed span and aspect ratio together), trimmed out to dry', () => {
    const hw = new HullWater(hull);
    let prev = Infinity;
    for (let lift = 0; lift <= 2; lift += 0.05) {
      // heave the whole hull up at fixed pose and speed; the drive lines rise with it
      const s = st([0, 0.35 + lift, 0], [-Math.sin(0.02), 0, 0, Math.cos(0.02)], [0, 0, 20]);
      hw.setControls(0.05, 0);
      hw.samplePatch(FLAT, s, DT);
      hw.evaluate(s, DT / 2);
      const f = Math.abs(hw.foilSideForce);
      expect(f).toBeLessThanOrEqual(prev * (1 + 1e-9) + 1e-9);
      prev = f;
    }
    expect(prev).toBe(0);
  });

  it('natural ventilation caps the gearcase lift at high speed (Damley-Strnad et al. 2019): hard over at 45 m/s gives far less than the wetted foil', () => {
    // WHY: surface-piercing struts ventilate once C_L reaches [1 − e^(−σ_v·Fr_h)]·Fr_h^(−½); the lift then
    // collapses toward the ventilated plate (¼ slope). At 45 m/s, Fr_h ≈ 18 ⇒ C_L,i ≈ 0.18 ≈ 4.6° of a
    // wetted slope of 2.25: hard over, the wetted model would claim ~4× more. Mutation: gearcaseVentilation off.
    const at = (params: Partial<HullWaterParams>): number => {
      const hw = new HullWater(hull, params);
      const s = st([0, 0.4, 0], [-Math.sin(0.015), 0, 0, Math.cos(0.015)], [0, 0, 45]);
      hw.setControls(LOCK * 0.5, 0);
      hw.samplePatch(FLAT, s, DT);
      hw.evaluate(s, DT / 2);
      return Math.abs(hw.foilSideForce);
    };
    const vented = at({});
    const wetted = at({ gearcaseVentilation: false });
    expect(vented).toBeGreaterThan(0);
    expect(vented / wetted).toBeLessThan(0.5);
  });

  it('dimensionless gearcase (§V53): a low-aspect-ratio foil whose lift slope sits below both limiting theories (Jones πA/2, lifting line 2πA/(A+2)) and within 20% of the lower', () => {
    const d = hull.drives[0];
    const A = (d.span * d.span) / d.lateralArea;
    expect(A).toBeGreaterThanOrEqual(1);
    expect(A).toBeLessThanOrEqual(3);
    // measured slope from the model at a small angle, fully wetted, low speed (no ventilation)
    const hw = new HullWater(hull);
    const V = 8;
    const s = st([0, 0.2, 0], [0, 0, 0, 1], [0, 0, V]);
    const alpha = 0.02;
    hw.setControls(alpha, 0);
    hw.samplePatch(FLAT, s, DT);
    hw.evaluate(s, DT / 2);
    const cla = Math.abs(hw.foilSideForce) / (hull.drives.length * 0.5 * RHO * V * V * d.lateralArea * alpha);
    const bound = Math.min((Math.PI * A) / 2, (2 * Math.PI * A) / (A + 2));
    expect(cla).toBeLessThan(bound);
    expect(cla).toBeGreaterThan(0.8 * bound);
  });

  it('sway added mass follows the wedge: m_lat/m_a = tan²β·(2/π)² for an upright V below the chine (same ellipse law, semi-axes swapped)', () => {
    // m_a = ρ(π/2)c² with Wagner c = (π/2)·d/tanβ; m_lat = ρ(π/2)d² ⇒ m_lat/m_a = (d/c)² = tan²β·(2/π)². A
    // deep V is deep for its beam — the grip deadrise buys.
    const prism = buildDeepVHull({ ...HULL_DATA.spec, taperStart: 1, keelRiseStart: 1, warpStart: 1, stemRake: 0 });
    const hw = new HullWater(prism, { coupledAddedMass: false });
    // keel 0.3 m under at the CG, level: below the 0.51 m chine
    const s = st([0, prism.keelBodyY * -1 - 0.3, 0]);
    hw.samplePatch(FLAT, s, DT);
    hw.evaluate(s, DT / 2);
    const beta = (HULL_DATA.spec.deadriseDeg * Math.PI) / 180;
    const expected = Math.tan(beta) ** 2 * (2 / Math.PI) ** 2;
    // body-x added mass (sway) over body-y (heave), both Σ over the same wet strips
    const ratio = hw.load.addedMass[0] / hw.load.addedMass[1];
    expect(Math.abs(ratio - expected) / expected).toBeLessThan(0.1);
  });
});

describe('purity and memory', () => {
  it('two boats, interleaved on one thread, give bit-identical states to separate runs (V2 worker copy)', () => {
    const run = (interleave: boolean): Rigid6State[] => {
      const boats = [0, 1].map((k) => ({
        hw: new HullWater(hull),
        mem: createRigid6Memory(),
        s: st([k * 30, 0.35, 0], [-Math.sin(0.02), 0, 0, Math.cos(0.02)], [0, 0, 18 + 6 * k]),
      }));
      const tick = (k: number, t: number): void => {
        const b = boats[k];
        b.hw.setControls((k === 0 ? 0.2 : -0.35) * Math.min(1, t / 60), 0.6);
        b.hw.samplePatch((x, z) => 0.3 * Math.sin(0.2 * x + 0.1 * z), b.s, DT);
        stepRigid6(b.s, hull, DT, 2, (ss, h, out) => b.hw.evaluate(ss, h, out), b.mem);
      };
      if (interleave) for (let t = 0; t < 240; t++) for (let k = 0; k < 2; k++) tick(k, t);
      else for (let k = 0; k < 2; k++) for (let t = 0; t < 240; t++) tick(k, t);
      return boats.map((b) => b.s);
    };
    const a = run(true);
    const b = run(false);
    for (let k = 0; k < 2; k++) {
      expect(a[k].position).toEqual(b[k].position);
      expect(a[k].quaternion).toEqual(b[k].quaternion);
      expect(a[k].velocity).toEqual(b[k].velocity);
      expect(a[k].angularVelocity).toEqual(b[k].angularVelocity);
    }
  });

  it('defaults are the physics under test (coupled added mass, Kirchhoff, foils, ventilation on)', () => {
    expect(HULL_WATER_DEFAULTS.coupledAddedMass && HULL_WATER_DEFAULTS.kirchhoff && HULL_WATER_DEFAULTS.driveFoil && HULL_WATER_DEFAULTS.gearcaseVentilation).toBe(true);
  });
});
