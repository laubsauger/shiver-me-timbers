/**
 * T189: THE HULL IN A SEA, ITS ENERGY, ITS DRIVE TRIM AND ITS ENGINES (docs/speedboat/physics-log.md, T189 section).
 *
 * WHY these exist:
 *  - the fluid-momentum terms used the hull's velocity over STILL water: a hull at rest in the shipped Working sea
 *    capsized (user playtest: "tippy", "rolling around before doing anything");
 *  - the explicit flux loads and the V110 rescale of the impulses put energy INTO a tumbling or inverted hull (user and
 *    crash agent: an inverted hull launched 18 m);
 *  - a 4–6° turn in a 0.9 m crossing swell hooked at C_v 8–10 while flat water was stable;
 *  - the drives had no trim and a temporary constant-power thrust with no engine behind it ("instant throttle").
 * Each test names the mutation that must break it.
 */
import { describe, expect, it } from 'vitest';
import { quatFromAxisAngle, quatMul, rotateVec } from '../src/core/quat';
import { oceanParams } from '../src/params/ocean';
import { seaPhysicsParams } from '../src/params/seaPhysics';
import { CpuOcean } from '../src/sea-physics/cpuOcean';
import { HullWater, type HeightSampler, type HullWaterParams } from '../src/sea-physics/hullWater';
import { createRigid6Memory, rigid6KineticEnergy, stepRigid6, type Rigid6State } from '../src/sea-physics/rigidBody';
import { buildDeepVHull, HULL_DATA, type HullProxy } from '../src/speedboat/hullMesh';
import type { Quat, Vec3 } from '../src/state/simState';

const DT = 1 / 60;
const G = 9.81;
const FLAT: HeightSampler = () => 0;
const hull = buildDeepVHull();
// Historical T179 mutation includes its old geometry classification, not just its force flags.
const t179Hull = buildDeepVHull();
for (let i = 0; i < t179Hull.spec.segments; i++) {
  for (let sideTriangle = 4; sideTriangle < 8; sideTriangle++) {
    t179Hull.triStrip[i * 10 + sideTriangle] = Math.floor(i / t179Hull.spec.segmentsPerStrip);
  }
}
const B = 2 * HULL_DATA.spec.chineHalfBeam;
const DEG = Math.PI / 180;
/** every T189 fluid change off, and T196's water-exit rule (the T179 model) */
const T179: Partial<HullWaterParams> = { waterVelocity: false, planingFacing: false, panelSuctionLimit: false, passivity: false, faceDragCoeff: 0, waterExit: false };

const st = (p: Vec3, q: Quat, v: Vec3, w: Vec3 = [0, 0, 0]): Rigid6State => ({ position: [...p] as Vec3, quaternion: [...q] as Quat, velocity: [...v] as Vec3, angularVelocity: [...w] as Vec3 });

describe('at rest in the shipped Working sea (Hs ≈ 2.8 m)', () => {
  /** max heel over `secs` of drifting, no input, from the flat-water rest pose placed on the local surface */
  const drift = (seed: number, params: Partial<HullWaterParams>, secs: number): number => {
    const ocean = new CpuOcean(seed, structuredClone(oceanParams), { ...structuredClone(seaPhysicsParams), hullDraft: 0.54 });
    ocean.update(0);
    const hw = new HullWater(hull, params);
    const mem = createRigid6Memory();
    let time = 0;
    const s = st([0, ocean.pressureHeadAt(0, 0, 0) + 0.204, 0], [-Math.sin((2.14 * DEG) / 2), 0, 0, Math.cos((2.14 * DEG) / 2)], [0, 0, 0]);
    const sea: HeightSampler = (x, z) => ocean.pressureHeadAt(x, z, time);
    let maxHeel = 0;
    for (let k = 0; k < secs * 60; k++) {
      ocean.update(time + DT);
      hw.samplePatch(sea, s, DT);
      stepRigid6(s, hull, DT, 2, (ss, h, out) => hw.evaluate(ss, h, out), mem);
      time += DT;
      const x = rotateVec(s.quaternion, [1, 0, 0]);
      const up = rotateVec(s.quaternion, [0, 1, 0]);
      maxHeel = Math.max(maxHeel, Math.abs(Math.atan2(x[1], up[1])) / DEG);
      if (maxHeel > 90) break;
    }
    return maxHeel;
  };

  it('a drifting hull rolls in a bounded way and never capsizes; with the water taken as still (relative flow off) she exceeds the roll budget', () => {
    // WHY: static GM ≈ 0.97 m, GZ max 0.36 m at 50°, vanishing ≈ 100° (measured on the proxy) — a 12 m deep-V does not
    // capsize lying in a Beaufort 6 sea. Measured (T189, 90 s): max heel 11–13° over seeds 188/7/1/2; relative flow off
    // (T179): 3 of those 4 capsized, roll rates 125–290°/s — Kirchhoff's p and V_n taken over still water while the hull
    // heaves with the swell. Seed 188, 60 s here.
    expect(drift(188, {}, 60)).toBeLessThan(30);
    // Topsides no longer feed planing lift, so this mutation peaks near 45° rather than capsizing.
    expect(drift(188, { waterVelocity: false }, 90), 'mutation: still-water velocities exceed the same 30° budget').toBeGreaterThan(30);
  });
});

describe('at rest in calm water: zero-speed wave radiation damping (T196, user: "boats are still pretty floaty")', () => {
  /** settle at the rest pose (test-side damping), displace, release; returns log-decrement ζ of the first cycle + period */
  const decay = (mode: 'heave' | 'pitch', params: Partial<HullWaterParams>): { zeta: number; period: number } => {
    const hw = new HullWater(hull, params);
    const mem = createRigid6Memory();
    const s = st([0, 0.204, 0], [-Math.sin((2.14 * DEG) / 2), 0, 0, Math.cos((2.14 * DEG) / 2)], [0, 0, 0]);
    for (let k = 0; k < 20 * 60; k++) {
      hw.samplePatch(FLAT, s, DT);
      stepRigid6(s, hull, DT, 2, (ss, h, out) => hw.evaluate(ss, h, out), mem);
      for (let c = 0; c < 3; c++) {
        s.velocity[c] *= 0.9;
        s.angularVelocity[c] *= 0.9;
      }
    }
    const trim = (q: Quat): number => Math.asin(2 * (q[1] * q[2] - q[3] * q[0]));
    const y0 = s.position[1];
    const t0 = trim(s.quaternion);
    if (mode === 'heave') s.position[1] += 0.2;
    else s.quaternion = quatMul(quatFromAxisAngle([1, 0, 0], -3 * DEG), s.quaternion) as Quat; // bow up 3° (about world x, heading 0)
    for (let c = 0; c < 3; c++) s.velocity[c] = s.angularVelocity[c] = 0;
    const xs: number[] = [];
    for (let k = 0; k < 8 * 60; k++) {
      hw.samplePatch(FLAT, s, DT);
      stepRigid6(s, hull, DT, 2, (ss, h, out) => hw.evaluate(ss, h, out), mem);
      xs.push(mode === 'heave' ? s.position[1] - y0 : trim(s.quaternion) - t0);
    }
    const peaks: number[] = [];
    for (let k = 1; k < xs.length - 1 && peaks.length < 2; k++) if (xs[k] > 0 && xs[k] > xs[k - 1] && xs[k] >= xs[k + 1]) peaks.push(k);
    return { zeta: Math.log(xs[0] / xs[peaks[0]]) / (2 * Math.PI), period: (peaks[0] + 1) * DT };
  };

  it('heave and pitch decay at the strip-theory radiation damping of wedge sections; without it they ring', () => {
    // WHY: at zero speed the 2D+t terms (∝ U) vanish and the only energy sink left was entry impulses and crossflow drag:
    // ζ 0.03–0.05, a hull that bobs for ten cycles. A hull oscillating on a free surface radiates waves; Frank's close-fit
    // method on wedge sections (hullWater RAD_B33), summed over this hull's rest sections at the model's own periods and
    // inertias, gives ζ_heave 0.28 and ζ_pitch 0.24 (physics-log T196). Band = that reference ± 30 % on top of the
    // model's other terms (0.03–0.05). Measured T196: heave 0.30 (T 2.3 s), pitch 0.30 over the first cycle.
    // Mutation: radiationDamping off ⇒ back to the ringing hull.
    const h = decay('heave', {});
    const p = decay('pitch', {});
    expect(h.zeta).toBeGreaterThan(0.2);
    expect(h.zeta).toBeLessThan(0.42);
    expect(p.zeta).toBeGreaterThan(0.17);
    expect(p.zeta).toBeLessThan(0.38);
    expect(decay('heave', { radiationDamping: false }).zeta, 'mutation: no radiation').toBeLessThan(0.08);
  });

  it('the radiation term is gone by planing speed (length Froude number 1.0): the Savitsky-validated model is untouched', () => {
    // WHY: above the planing lower limit (Fn_L 1–1.2, Sun & Faltinsen 2007) the 2D+t φ = 0 terms ARE the damping; a
    // zero-speed wave term on top would double count. Mutation: a fade that never reaches 0.
    const hw = new HullWater(hull);
    const L = hull.stemZ - hull.transomZ;
    for (const [U, want] of [[0, 1], [0.35 * Math.sqrt(G * L), 1], [1.05 * Math.sqrt(G * L), 0]] as const) {
      const s = st([0, 0.3, 0], [-Math.sin(0.02), 0, 0, Math.cos(0.02)], [0, 0, U]);
      hw.samplePatch(FLAT, s, DT);
      hw.evaluate(s, DT / 2);
      expect(hw.radiationScale, `U ${U.toFixed(1)} m/s`).toBe(want);
    }
  });
});

describe('energy: the water never throws a hull (passivity, face drag, impulses uncapped)', () => {
  /** capsized/inverted re-entries in flat water at throttle 0: largest rise of mechanical energy above its initial value */
  const reentries = (params: Partial<HullWaterParams>, mesh: HullProxy = hull): number => {
    let worst = -Infinity;
    for (const heel of [120, 180]) {
      for (const [U, drop, p] of [[35, 1.5, 3], [35, 3, 0], [25, 1.5, 1.5]] as const) {
        const a = heel * DEG;
        const q: Quat = [0, Math.sin(0.15) * Math.cos(a / 2), Math.cos(0.15) * Math.sin(a / 2), Math.cos(0.15) * Math.cos(a / 2)];
        const l = Math.hypot(...q);
        for (let i = 0; i < 4; i++) q[i] /= l;
        const s = st([0, drop + 0.6, 0], q, [0, -1, U], [0, 0, p]);
        const hw = new HullWater(mesh, params);
        const mem = createRigid6Memory();
        const E = (): number => rigid6KineticEnergy(s, mesh) + mesh.mass * G * s.position[1];
        const E0 = E();
        for (let t = 0; t < 6 * 60; t++) {
          hw.samplePatch(FLAT, s, DT);
          stepRigid6(s, mesh, DT, 2, (ss, h, out) => hw.evaluate(ss, h, out), mem);
          worst = Math.max(worst, (E() - E0) / (mesh.mass * G));
        }
      }
    }
    return worst;
  };

  it('a capsized or inverted hull re-entering at 25–35 m/s never rises above its initial energy; the T179 model threw it tens of metres', () => {
    // WHY: with no waves and no throttle nothing can add energy. T179 measured over 216 such re-entries: +50 m of height
    // above the initial energy; T189: 0 (216/216). The mutation (passivity, face drag and the impulse cap back to T179)
    // must gain metres. Units: metres of height (ΔE / m·g).
    expect(reentries({})).toBeLessThan(0.05);
    expect(reentries(T179, t179Hull), 'mutation: T179 fluid model').toBeGreaterThan(3);
  });
});

describe('turning in a crossing swell (the T182 blocker)', () => {
  const swell = (A: number, rot: number) => (t: number): HeightSampler => (x0, z0) => {
    const c = Math.cos(rot);
    const sn = Math.sin(rot);
    const x = c * x0 - sn * z0;
    const z = sn * x0 + c * z0;
    return A * (0.6 * Math.sin(0.06 * z + 0.02 * x - 0.8 * t) + 0.3 * Math.sin(0.11 * x - 0.05 * z - 1.1 * t));
  };
  /** the T182 16-run set: raw helm 30°/s to `deg`, 12 s speed hold then throttle frozen, 20 s; hooks = heel or slip > 45° */
  const hooks = (cv: number, deg: number, params: Partial<HullWaterParams>, mesh: HullProxy = hull): number => {
    let n = 0;
    for (const A of [0.66, 1]) {
      for (const rot of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        for (const sign of [1, -1]) {
          const U = cv * Math.sqrt(G * B);
          const hw = new HullWater(mesh, { standInDrivePowerW: 4e6, ...params });
          const mem = createRigid6Memory();
          const s = st([0, 0.35, 0], [-Math.sin(0.02), 0, 0, Math.cos(0.02)], [0, 0, U]);
          let integ = 0;
          let thrSum = 0;
          let thrN = 0;
          for (let k = 0; k < 32 * 60; k++) {
            const time = k / 60;
            if (time < 12) {
              const err = U - Math.hypot(s.velocity[0], s.velocity[2]);
              integ += err * DT;
              const thr = Math.max(0, Math.min(1, 0.3 + 0.3 * err + 0.1 * integ));
              if (time > 9) {
                thrSum += thr;
                thrN++;
              }
              hw.setControls(0, thr);
            } else {
              hw.setControls(sign * Math.min(deg * DEG, Math.round((time - 12) * 60 + 1) * 30 * DEG * DT), thrSum / thrN);
            }
            hw.samplePatch(swell(A, rot)(time), s, DT);
            stepRigid6(s, mesh, DT, 2, (ss, h, out) => hw.evaluate(ss, h, out), mem);
            if (time > 12) {
              const f = rotateVec(s.quaternion, [0, 0, 1]);
              const up = rotateVec(s.quaternion, [0, 1, 0]);
              let drift = Math.atan2(f[0], f[2]) - Math.atan2(s.velocity[0], s.velocity[2]);
              if (drift > Math.PI) drift -= 2 * Math.PI;
              if (drift < -Math.PI) drift += 2 * Math.PI;
              if (up[1] < Math.cos(Math.PI / 4) || Math.abs(drift) > Math.PI / 4) {
                n++;
                break;
              }
            }
          }
        }
      }
    }
    return n;
  };

  it('6° of drive at C_v 8: at most 2 hooks in 16 (T179 model: 9) — the T196 acceptance of ≤ 1/16 is NOT met at C_v 8, see the log', () => {
    // Measured (T189 final): C_v 8 4° 2/16, 6° 5/16; C_v 10 4° 5/16, 6° 6/16 (T179: 3, 9, 8, 11). What moved them: the
    // vertical relative flow (hull heaving with the swell is not planing through still water) and the panel-pressure
    // limit (a lee panel cannot pull more than the load it carries). T196: 6° C_v 8 2/16, C_v 10 1/16 — the water-exit
    // rule, passivity scoped to the transfer loads and credited with the impulses' dissipation (a heeled landing keeps
    // its righting lift and roll damping), and the drives running in the transom wake (gearcases leave the water with the
    // hull instead of steering her stern through a 1 s flight). The two left: 1.0–1.3 s flights rolling 20 → 45° under the
    // drive loads of the low-side props still in the water. Mutation: the T179 fluid model.
    expect(hooks(8, 6, {})).toBeLessThanOrEqual(2);
    expect(hooks(8, 6, T179, t179Hull), 'mutation: T179 fluid model').toBeGreaterThanOrEqual(8);
  });
});

describe('T196: water exit, the transom wake, Surge', () => {
  it('a bottom withdrawing along its normal gets no planing lift: a −10° / 30 m/s entry puts no power in through the flux loads', () => {
    // WHY: U·(M_i − M_up) with both momenta negative (V_n < 0, the deeper bow upstream) was a POSITIVE pressure on a panel
    // moving away from the water, with a forward component: +619 kW into the hull on this entry, the pitchpole's engine,
    // and the reason passivity then zeroed every explicit load. Mutation: waterExit off.
    const power = (waterExit: boolean): number => {
      const hw = new HullWater(hull, { waterExit, passivity: false });
      const s = st([0, 0.6, 0], [Math.sin((10 * DEG) / 2), 0, 0, Math.cos((10 * DEG) / 2)], [0, -2, 30]);
      hw.samplePatch(FLAT, s, DT);
      hw.evaluate(s, DT / 2);
      hw.evaluate(s, DT / 2);
      const E = hw.explicitLoad;
      const T = hw.explicitTransferLoad;
      return (E[0] - T[0]) * s.velocity[0] + (E[1] - T[1]) * s.velocity[1] + (E[2] - T[2]) * s.velocity[2];
    };
    expect(power(true)).toBeLessThanOrEqual(1);
    expect(power(false), 'mutation: exit sections keep their momentum').toBeGreaterThan(100e3);
  });

  it('the drives run part-surfaced in the transom wake at planing speed (Kim & Rhee immersion 0.3–0.7) and buried at rest', () => {
    // WHY (coordinator item 7, rooster tail): a bracketed surface-piercing prop runs with its shaft near the water surface
    // behind a planing transom (Kim & Rhee 2024: boss cap at the surface at I_T 0.5, best efficiency at low I_T), which is
    // what the Korvin-Kroukovsky/Savitsky/Lehman wake profile gives with the shaft at keel height. Measured T196: centre
    // prop immersion 0.70 / 0.64 / 0.61 at C_v 4 / 6 / 8 (8 at the 4 MW scale); 1.0 at rest. Mutation: transomWake off ⇒
    // buried (1.0) at every speed.
    const imm = (cv: number, params: Partial<HullWaterParams>): number => {
      const U = cv * Math.sqrt(G * B);
      const hw = new HullWater(hull, cv > 7 ? { standInDrivePowerW: 4e6, ...params } : params);
      const mem = createRigid6Memory();
      const s = st([0, 0.35, 0], [-Math.sin(0.02), 0, 0, Math.cos(0.02)], [0, 0, U]);
      let integ = 0;
      let sum = 0;
      let n = 0;
      for (let k = 0; k < 20 * 60; k++) {
        const err = U - Math.hypot(s.velocity[0], s.velocity[2]);
        integ += err * DT;
        hw.setControls(0, U === 0 ? 0 : Math.max(0, Math.min(1, 0.3 + 0.3 * err + 0.1 * integ)));
        hw.samplePatch(FLAT, s, DT);
        stepRigid6(s, hull, DT, 2, (ss, h, out) => hw.evaluate(ss, h, out), mem);
        if (k > 15 * 60) {
          sum += hw.driveImmersion[1];
          n++;
        }
      }
      return sum / n;
    };
    for (const cv of [4, 6, 8]) {
      const i = imm(cv, {});
      expect(i, `C_v ${cv}`).toBeGreaterThanOrEqual(0.3);
      expect(i, `C_v ${cv}`).toBeLessThanOrEqual(0.75);
    }
    expect(imm(6, { transomWake: false }), 'mutation: no wake hollow').toBeGreaterThan(0.95);
    expect(imm(0, {}), 'at rest the lower units are in the water').toBe(1);
  });

  it('Surge reaches the water through the engine: setBoost raises thrust at speed, a dry prop gets nothing, 1 is stock', () => {
    // WHY (coordinator item 6): the race's Surge output multiplier must not be a thrust multiplier (setControls clamps the
    // lever at 1); as an engine boost the prop curve decides. Mutation: ignoring the boost (thrust unchanged).
    const thrust = (boost: number, y: number): number => {
      const hw = new HullWater(hull);
      hw.setBoost(boost);
      const s = st([0, y, 0], [-Math.sin(0.02), 0, 0, Math.cos(0.02)], [0, 0, 30]);
      hw.setControls(0, 1);
      for (let k = 0; k < 480; k++) {
        if (k % 2 === 0) hw.samplePatch(FLAT, s, DT);
        hw.evaluate(s, DT / 2);
      }
      return hw.thrust;
    };
    const stock = thrust(1, 0.35);
    expect(thrust(1.2, 0.35) / stock).toBeGreaterThan(1.15);
    expect(Math.abs(thrust(1.2, 5))).toBeLessThan(0.02 * stock);
    const hw = new HullWater(hull);
    hw.setBoost(0.5);
    expect(hw.boost).toBe(1);
    hw.setBoost(9);
    expect(hw.boost).toBe(hw.params.engine.boostMax);
  });
});

describe('drive trim and the engine (T189)', () => {
  it('trim tips the thrust line down-forward and lifts the gearcase; clamped to the drive range', () => {
    // WHY: trim out (+) swings the lower unit aft and up about the clamp pin: the prop shaft points down-forward, the
    // thrust pushes the stern down (bow up) and the anti-ventilation plate rises. Sign agreed with the controls agent
    // (docs/speedboat/controls.md hook 2). Mutation: rotating the line the other way flips `driveDir` y.
    const hw = new HullWater(hull);
    const s = st([0, 0.35, 0], [0, 0, 0, 1], [0, 0, 20]);
    const at = (trimDeg: number): { dy: number; propY: number } => {
      hw.setControls(0, 0.5, trimDeg * DEG);
      hw.samplePatch(FLAT, s, DT);
      hw.evaluate(s, DT / 2);
      return { dy: hw.driveDir[4], propY: hw.driveProp[4] };
    };
    const zero = at(0);
    const out = at(10);
    const inn = at(-6);
    expect(zero.dy).toBeCloseTo(0, 12);
    expect(out.dy).toBeCloseTo(-Math.sin(10 * DEG), 9);
    expect(inn.dy).toBeCloseTo(Math.sin(6 * DEG), 9);
    expect(out.propY, 'trimmed out the prop rises').toBeGreaterThan(zero.propY);
    expect(at(45).dy, 'clamped to +20°').toBeCloseTo(-Math.sin(20 * DEG), 9);
    expect(at(-30).dy, 'clamped to −6°').toBeCloseTo(Math.sin(6 * DEG), 9);
  });

  it('throttle is not instant: a WOT step at planing speed takes the engine ≥ 0.3 s to 90 % thrust; the lever centred is neutral', () => {
    // WHY (user playtest: "instant gas"): thrust comes from the crank ODE (throttle-body lag, rotating inertia, prop load),
    // engine.ts measures 0.47 s to 90 % at 30 m/s. Neutral: throttle exactly 0 decouples the prop.
    const hw = new HullWater(hull);
    const s = st([0, 0.45, 0], [-Math.sin(0.02), 0, 0, Math.cos(0.02)], [0, 0, 30]);
    hw.setControls(0, 0.05);
    for (let k = 0; k < 600; k++) {
      hw.samplePatch(FLAT, s, DT);
      hw.evaluate(s, DT / 2);
    }
    hw.setControls(0, 1);
    const trace: number[] = [];
    for (let k = 0; k < 480; k++) {
      if (k % 2 === 0) hw.samplePatch(FLAT, s, DT);
      hw.evaluate(s, DT / 2);
      trace.push(hw.thrust);
    }
    const final = trace[trace.length - 1];
    const t90 = trace.findIndex((T) => T >= 0.9 * final) * (DT / 2);
    expect(final).toBeGreaterThan(10_000);
    expect(t90).toBeGreaterThanOrEqual(0.3);
    expect(hw.driveRpm[1]).toBe(hw.engines[1].rpm);
    hw.setControls(0, 0);
    hw.evaluate(s, DT / 2);
    expect(hw.thrust).toBe(0);
  });

  it('three 450Rs at WOT in flat water: faster than the T179 stand-in (29.5 m/s) — and short of the cited 85 mph ± 5 %', () => {
    // WHY: the engine and prop are calibrated to real 450R data (engine.ts); the TOP SPEED is then the hull's drag.
    // Measured (T189): 33.4 m/s (74.8 mph) at 0° trim, 33.8 (75.6 mph) at +8°; cited Nor-Tech 390 Sport 3×450R 87 mph,
    // Mystic M4200 mid-80s ⟹ target 36.1–39.9 m/s NOT met (−11 %): drag, not thrust — see the log's drag/thrust verdict.
    const hw = new HullWater(hull);
    const mem = createRigid6Memory();
    const s = st([0, 0.35, 0], [-Math.sin(0.02), 0, 0, Math.cos(0.02)], [0, 0, 30]);
    let u = 0;
    let n = 0;
    for (let k = 0; k < 50 * 60; k++) {
      hw.setControls(0, 1, 6 * DEG);
      hw.samplePatch(FLAT, s, DT);
      stepRigid6(s, hull, DT, 2, (ss, h, out) => hw.evaluate(ss, h, out), mem);
      if (k > 40 * 60) {
        u += Math.hypot(s.velocity[0], s.velocity[2]);
        n++;
      }
    }
    const top = u / n;
    expect(top).toBeGreaterThan(29.5 * 1.1);
    expect(top).toBeLessThan(39.9);
    expect(hw.driveRpm[1], 'WOT rpm inside the 450R window 5800–6400 (± limiter band)').toBeGreaterThan(5500);
  });
});
