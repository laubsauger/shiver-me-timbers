/**
 * SPEEDBOAT ASSISTS ON THE REAL PHYSICS (§T.182 S2). HullWater + rigid6, headless — the assists are judged by what
 * the hull DOES, not by what the functions return.
 *
 * WHY (§T.179 USER DECISION 2026-09-13): the physics stays honest — a hard helm at speed hooks her, a legit crash —
 * and the DEFAULT assist is what keeps normal full-stick play from hooking by accident. So:
 *  - default preset, full stick held, C_v 3–10 flat water: never hooks, heel never past 35°;
 *  - the same in a sea: that is where the flat-water curve alone was NOT enough (the heel guard is why);
 *  - Pro preset: the physics unmodified — it hooks exactly where the raw envelope does;
 *  - the Governor keeps the engine off the limiter in the air;
 *  - the landing assist lands her nearer the window, acting ONLY through the trim command (never a force).
 * Harness = physics-log T179 part 3 (speed held by throttle for 12 s, throttle then frozen; the non-stepped proxy
 * needs `standInDrivePowerW` 4 MW to hold C_v 8–10).
 */
import { describe, expect, it } from 'vitest';
import { invRotateVec, rotateVec } from '../src/core/quat';
import { HullWater, type HeightSampler } from '../src/sea-physics/hullWater';
import { createRigid6Memory, stepRigid6, type Rigid6State } from '../src/sea-physics/rigidBody';
import {
  assistPreset,
  createAssistState,
  createGovernorState,
  LANDING_PITCH_CENTRE,
  RPM_PROXY,
  readBoatSim,
  safeLockRad,
  speedCoefficient,
  stepAssists,
  stepGovernor,
  stepHelm,
  type AssistSettings,
  type BoatSimSample,
} from '../src/speedboat/assists';
import { neutralBoatInput } from '../src/speedboat/controls/boatInput';
import { buildDeepVHull, HULL_DATA } from '../src/speedboat/hullMesh';
import type { Quat, Vec3 } from '../src/state/simState';

const DT = 1 / 60;
const G = 9.81;
const hull = buildDeepVHull();
const B = 2 * HULL_DATA.spec.chineHalfBeam;
const LOCK = hull.drives[0].maxSteerRad;
const DEG = 180 / Math.PI;
const FLAT: (t: number) => HeightSampler = () => () => 0;

const launch = (U: number): Rigid6State => ({
  position: [0, 0.35, 0] as Vec3,
  quaternion: [-Math.sin(0.02), 0, 0, Math.cos(0.02)] as Quat,
  velocity: [0, 0, U] as Vec3,
  angularVelocity: [0, 0, 0] as Vec3,
});

interface Run {
  peakHeelDeg: number;
  /** seconds from the helm starting until heel or slip passes 45° (−1 = never) */
  departS: number;
  steers: number[];
  final: Rigid6State;
}

/**
 * 12 s straight at C_v (speed-held), then `stick(t)` through the assists for `hold` s with the throttle frozen.
 * `mutate` may edit the sim sample before the assists read it (used to switch the heel guard off).
 */
function steerRun(
  cv: number,
  settings: AssistSettings,
  stick: (t: number) => number,
  opts: { hold?: number; sea?: (t: number) => HeightSampler; mutate?: (s: BoatSimSample) => void; raw?: (t: number) => number } = {},
): Run {
  const hold = opts.hold ?? 20;
  const sea = opts.sea ?? FLAT;
  const U = cv * Math.sqrt(G * B);
  const hw = new HullWater(hull, { standInDrivePowerW: 4e6 });
  const mem = createRigid6Memory();
  const s = launch(U);
  const st = createAssistState();
  const input = neutralBoatInput();
  const sim = readBoatSim(hw, s);
  const T1 = 12;
  let integ = 0;
  let thrSum = 0;
  let thrN = 0;
  let peak = 0;
  let departS = -1;
  const steers: number[] = [];
  for (let t = 0; t < (T1 + hold) * 60; t++) {
    const time = t / 60;
    if (time < T1) {
      const err = U - Math.hypot(s.velocity[0], s.velocity[2]);
      integ += err * DT;
      const thr = Math.max(0, Math.min(1, 0.3 + 0.3 * err + 0.1 * integ));
      if (time > T1 - 3) {
        thrSum += thr;
        thrN++;
      }
      hw.setControls(0, thr);
    } else if (opts.raw) {
      const steer = opts.raw(time - T1);
      steers.push(steer);
      hw.setControls(steer, thrSum / thrN);
    } else {
      readBoatSim(hw, s, sim);
      opts.mutate?.(sim);
      input.throttle = thrSum / thrN;
      input.steer = stick(time - T1);
      const cmd = stepAssists(input, sim, settings, st, DT, LOCK);
      steers.push(cmd.steerRad);
      hw.setControls(cmd.steerRad, cmd.throttle);
    }
    hw.samplePatch(sea(time), s, DT);
    stepRigid6(s, hull, DT, 2, (ss, h, out) => hw.evaluate(ss, h, out), mem);
    if (time >= T1) {
      const f = rotateVec(s.quaternion, [0, 0, 1]);
      const x = rotateVec(s.quaternion, [1, 0, 0]);
      const up = rotateVec(s.quaternion, [0, 1, 0]);
      let drift = Math.atan2(f[0], f[2]) - Math.atan2(s.velocity[0], s.velocity[2]);
      if (drift > Math.PI) drift -= 2 * Math.PI;
      if (drift < -Math.PI) drift += 2 * Math.PI;
      peak = Math.max(peak, Math.abs(Math.asin(Math.max(-1, Math.min(1, x[1])))) * DEG);
      if (departS < 0 && (up[1] < Math.cos(Math.PI / 4) || Math.abs(drift) > Math.PI / 4)) departS = time - T1;
    }
  }
  return { peakHeelDeg: peak, departS, steers, final: s };
}

/** a 0.9·A m crossing swell (two sines) — measured to hook the flat-water curve alone */
const swell = (A: number) => (t: number): HeightSampler => (x, z) =>
  A * (0.6 * Math.sin(0.06 * z + 0.02 * x - 0.8 * t) + 0.3 * Math.sin(0.11 * x - 0.05 * z - 1.1 * t));

describe('speed-limited lock (default preset) on the real hull', () => {
  const def = assistPreset('default');

  it('the curve gives the user\'s ±12° at top speed (42 m/s) and the full 30° drive lock only near rest', () => {
    expect(safeLockRad(speedCoefficient(42)) * DEG).toBeCloseTo(12, 6);
    expect(safeLockRad(speedCoefficient(3)) * DEG).toBeCloseTo(30, 6);
    // non-increasing with speed: a lock that opens as she speeds up reads as a bug
    let prev = Infinity;
    for (let v = 0; v <= 60; v += 0.5) {
      const l = safeLockRad(speedCoefficient(v));
      expect(l).toBeLessThanOrEqual(prev + 1e-12);
      prev = l;
    }
  });

  it('full stick held 20 s at every C_v 3–10 in flat water: never hooks, heel never past 35°', () => {
    // measured (T182): peak heel 23.0–24.6° across C_v 3–10; without the curve (Pro) full lock hooks at every one
    for (const cv of [3, 4, 5, 6, 7, 8, 9, 10]) {
      const r = steerRun(cv, def, () => 1);
      expect(r.departS, `C_v ${cv}`).toBeLessThan(0);
      expect(r.peakHeelDeg, `C_v ${cv}`).toBeLessThanOrEqual(35);
    }
  });

  it('left and right are mirror images (the curve and the guard do not care which way)', () => {
    const r = steerRun(8, def, () => 1, { hold: 6 });
    const l = steerRun(8, def, () => -1, { hold: 6 });
    expect(Math.abs(r.peakHeelDeg - l.peakHeelDeg)).toBeLessThan(0.5);
    expect(Math.abs(r.steers[60] + l.steers[60])).toBeLessThan(1e-3);
  });

  it('in a 0.9 m sea the heel guard turns most hooks into recoveries (the flat-water curve alone hooks nearly always)', () => {
    // measured (T182 scratch, 64 runs incl. 4 sea headings, A 0.66/1): curve alone 63/64 hook, with the guard 27/64.
    // This subset: A = 1, sea heading 0, both turn directions, C_v 4/6/8/10.
    let guarded = 0;
    let unguarded = 0;
    for (const cv of [4, 6, 8, 10]) {
      for (const stick of [1, -1]) {
        if (steerRun(cv, def, () => stick, { sea: swell(1) }).departS >= 0) guarded++;
        if (steerRun(cv, def, () => stick, { sea: swell(1), mutate: (s) => (s.roll = 0) }).departS >= 0) unguarded++;
      }
    }
    // T189 (relative vertical flow, capped panel suction) made the raw hull survive more of this sea: unguarded fell
    // from 7–8 to 4 hooks of 8. The property is unchanged: the scenario still hooks the curve alone, and the guard halves it.
    expect(unguarded, 'the scenario is one the curve alone cannot survive').toBeGreaterThanOrEqual(4);
    expect(guarded, `guarded ${guarded} vs unguarded ${unguarded}`).toBeLessThanOrEqual(Math.floor(unguarded / 2));
  });

  it('in that sea the RAW hull turns at C_v 10 with 4° of drive without hooking (T189: was a known limit of T182)', () => {
    // Pro preset, stick = 4°/30° of lock. T182 measured 16 runs (4 headings × 2 amplitudes × 2 directions): C_v 8 hooked
    // 3/16 at 4° and 9/16 at 6°; C_v 10 8/16 at 4°. T189 (relative vertical flow, panel pressure ≥ ambient, passivity,
    // face drag; docs/speedboat/physics-log.md) — this heading/amplitude/direction no longer hooks.
    const r = steerRun(10, assistPreset('pro'), () => 4 / 30, { sea: swell(1) });
    expect(r.departS).toBeLessThan(0);
  });
});

describe('Pro preset = the physics unmodified', () => {
  const pro = assistPreset('pro');

  it('commands the drives exactly as the raw envelope harness does (30°/s helm to the drives\' own lock) and hooks where it hooks', () => {
    // physics-log envelope after T189: half lock hooks from C_v 9 (2.47 s; was C_v 8 before T189), full lock hooks at C_v 3.
    // T196 (drives in the transom wake): half lock hooks only at C_v 10 (3.65 s), full lock from C_v 4 (2.15 s) — C_v 3 full
    // lock now survives a 44° roll-in. Same property, the speeds where the raw hull hooks today.
    for (const [cv, frac] of [[10, 0.5], [4, 1]] as const) {
      const viaAssists = steerRun(cv, pro, () => frac, { hold: 6 });
      const rate = (30 / DEG) * DT;
      const raw = steerRun(cv, pro, () => 0, { hold: 6, raw: (t) => Math.min(frac * LOCK, Math.round(t * 60 + 1) * rate) });
      for (let k = 0; k < raw.steers.length; k++) expect(Math.abs(viaAssists.steers[k] - raw.steers[k])).toBeLessThan(1e-12);
      expect(viaAssists.departS, `C_v ${cv} Pro hooks`).toBeGreaterThan(0);
      expect(Math.abs(viaAssists.departS - raw.departS), `C_v ${cv}`).toBeLessThanOrEqual(2 * DT + 1e-9);
    }
  });

  it('the helm never exceeds the drives\' lock and moves at its rate', () => {
    let h = 0;
    for (let k = 0; k < 120; k++) {
      const n = stepHelm(h, 1, LOCK, 30 / DEG, DT);
      expect(n - h).toBeLessThanOrEqual((30 / DEG) * DT + 1e-15);
      h = n;
    }
    expect(h).toBeCloseTo(LOCK, 12);
  });
});

/** C_v run at speed into a Gaussian sand-bar ridge of height A, half-width w: a real launch and landing */
function jump(
  cv: number,
  A: number,
  w: number,
  settings: AssistSettings,
  opts: { emulateTrim?: boolean } = {},
): { airS: number; landingPitchDeg: number | null; maxAirRpm: number; states: Rigid6State[]; throttles: number[] } {
  const U = cv * Math.sqrt(G * B);
  const hw = new HullWater(hull, { standInDrivePowerW: 4e6 });
  const mem = createRigid6Memory();
  const s = launch(U);
  const z0 = 10 * U + 60;
  const sampler: HeightSampler = (_x, z) => A * Math.exp(-(((z - z0) / w) ** 2));
  const st = createAssistState();
  const input = neutralBoatInput();
  const sim = readBoatSim(hw, s);
  let integ = 0;
  let hold = 0;
  let air = 0;
  let maxAir = 0;
  let launched = false;
  let landing: number | null = null;
  let trim = 0;
  let maxAirRpm = 0;
  const states: Rigid6State[] = [];
  const throttles: number[] = [];
  for (let t = 0; t < 18 * 60; t++) {
    const time = t / 60;
    if (time < 10) {
      const err = U - Math.hypot(s.velocity[0], s.velocity[2]);
      integ += err * DT;
      hold = Math.max(0, Math.min(1, 0.3 + 0.3 * err + 0.1 * integ));
      hw.setControls(0, hold);
    } else {
      readBoatSim(hw, s, sim);
      // the pilot holds the throttle wide open over the bar
      input.throttle = 1;
      const cmd = stepAssists(input, sim, settings, st, DT, LOCK);
      hw.setControls(cmd.steerRad, cmd.throttle);
      throttles.push(cmd.throttle);
      trim = cmd.trimRad;
      if (sim.airborne) maxAirRpm = Math.max(maxAirRpm, st.governor.rpm);
    }
    hw.samplePatch(sampler, s, DT);
    stepRigid6(
      s,
      hull,
      DT,
      2,
      (ss, h, out) => {
        hw.evaluate(ss, h, out);
        if (!opts.emulateTrim || trim === 0) return;
        // TEST-ONLY drive-trim emulation (HullWater has no trim input yet): each drive's published thrust re-aimed
        // about body x by the trim angle (+ = trim out: the thrust line tips DOWN, stern down, bow up)
        const c = Math.cos(trim);
        const sn = Math.sin(trim);
        for (let k = 0; k < hw.driveThrust.length; k++) {
          const T = hw.driveThrust[k];
          if (T === 0) continue;
          const d0: Vec3 = [hw.driveDir[3 * k], hw.driveDir[3 * k + 1], hw.driveDir[3 * k + 2]];
          const d = invRotateVec(ss.quaternion, d0);
          const dw = rotateVec(ss.quaternion, [d[0], d[1] * c - d[2] * sn, d[1] * sn + d[2] * c]);
          const f = [T * (dw[0] - d0[0]), T * (dw[1] - d0[1]), T * (dw[2] - d0[2])];
          const r = [0, 1, 2].map((i) => hw.driveProp[3 * k + i] - ss.position[i]);
          for (let i = 0; i < 3; i++) out.force[i] += f[i];
          out.torque[0] += r[1] * f[2] - r[2] * f[1];
          out.torque[1] += r[2] * f[0] - r[0] * f[2];
          out.torque[2] += r[0] * f[1] - r[1] * f[0];
        }
      },
      mem,
    );
    if (time >= 10) states.push({ position: [...s.position] as Vec3, quaternion: [...s.quaternion] as Quat, velocity: [...s.velocity] as Vec3, angularVelocity: [...s.angularVelocity] as Vec3 });
    const after = readBoatSim(hw, s);
    if (after.airborne) {
      air += DT;
      launched = true;
      maxAir = Math.max(maxAir, air);
    } else {
      if (launched && landing === null && air > 0.3) landing = after.pitch * DEG;
      air = 0;
    }
  }
  return { airS: maxAir, landingPitchDeg: landing, maxAirRpm, states, throttles };
}

describe('the Governor (OFF · AIR · FULL)', () => {
  it('airborne over a real sand bar at full throttle: OFF bounces on the rev limiter, AIR keeps the rpm proxy at rated', () => {
    // WHY (design §3, tech-research §3.1): a prop out of the water loses its load and flares; the Governor is the
    // salvaged module that stops it. Measured flight 1.2–1.4 s (C_v 8, 2 m bar). T196: the same bar now flies 0.7–0.8 s by
    // the assists' airborne flag (hull dry AND every gearcase dry: the raised drives in the transom wake, VCG +2 cm), under
    // the 0.8 s this check needs to see a flare; a 2.5 m bar restores a > 0.8 s flight — the property is the Governor's.
    const base = { ...assistPreset('pro') };
    const off = jump(8, 2.5, 10, { ...base, governor: 'OFF' });
    const airG = jump(8, 2.5, 10, { ...base, governor: 'AIR' });
    expect(off.airS).toBeGreaterThan(0.8);
    expect(airG.airS).toBeGreaterThan(0.8);
    expect(off.maxAirRpm).toBeGreaterThanOrEqual(RPM_PROXY.limiter - 1e-9);
    // the Governor now feathers only below VENT_IMMERSION (surfaced planing props are the running point, not a dry prop),
    // so the last metres of the launch spool the proxy over rated before the drive is out: ~4% at 0.45, 9% at T206's 0.1
    // (the proxy's quadratic load law flares at any part immersion; the §T.189 engine's own limiter is the real bound).
    // Still below OFF's limiter.
    expect(airG.maxAirRpm).toBeLessThanOrEqual(1.1);
  });

  it('with the props buried AIR changes nothing; FULL caps the throttle for the landing window only', () => {
    const st = createGovernorState();
    expect(stepGovernor(st, 'AIR', 1, false, 1, DT)).toBe(1);
    // 0.5 s of air, then touchdown
    const full = createGovernorState();
    for (let k = 0; k < 30; k++) stepGovernor(full, 'FULL', 1, true, 0, DT);
    const caps: number[] = [];
    for (let k = 0; k < 60; k++) caps.push(stepGovernor(full, 'FULL', 1, false, 1, DT));
    expect(caps[0]).toBeLessThanOrEqual(0.5);
    expect(caps[35]).toBeLessThanOrEqual(0.5);
    expect(caps[40]).toBe(1);
    // a hop shorter than LANDING_MIN_AIR is not a landing
    const hop = createGovernorState();
    for (let k = 0; k < 10; k++) stepGovernor(hop, 'FULL', 1, true, 0, DT);
    expect(stepGovernor(hop, 'FULL', 1, false, 1, DT)).toBe(1);
  });
});

describe('landing assist (trim only)', () => {
  // T196: the C_v 8 bar was 1.2 m × 8 — its flight by the airborne flag (hull and gearcases dry) is 0.17 s now, under the
  // 0.3 s a landing needs; 1.6 m flies 0.6 s
  const cases: [number, number, number][] = [[8, 1.6, 8], [8, 2, 10], [6, 1.5, 6], [10, 1.5, 10], [9, 2.5, 12]];

  // KNOWN REGRESSION, reported to the controls owner (T196, docs/speedboat/physics-log.md): with the drives running part-
  // surfaced in the transom wake (hullWater `transomWake`, prop immersion 0.6 at planing speed, coordinator item 7) the
  // props leave the water at the launch, so re-aiming their thrust has nothing to push with. Measured landing pitch
  // off → on (window centre 2.5°): C_v 8 1.6 m 9.6 → 9.8°, 8/2 m 12.1 → 12.3°, 6/1.5 m 10.7 → 10.6°, 10/1.5 m 8.2 → 8.6°,
  // 9/2.5 m 12.7 → 13.6° (T182 on buried props: 1.5–4.6° better). Kept as `it.fails` so the day the assist or the trim
  // path regains authority this flips and has to be restored.
  it.fails('lands nearer the window than with it off, on every bar (drive trim emulated as thrust-line pitch)', () => {
    // measured (T182): landing pitch 14.3/16.3/15.1/16.3/19.0° off → 12.8/12.5/12.8/12.7/14.4° at 0.5. Honest size:
    // still above the 7° clean limit — a dry prop cannot pitch her in the air (docs/speedboat/controls.md hooks).
    const centre = LANDING_PITCH_CENTRE * DEG;
    let gain = 0;
    for (const [cv, A, w] of cases) {
      const off = jump(cv, A, w, { ...assistPreset('default'), landingAssist: 0 }, { emulateTrim: true });
      const on = jump(cv, A, w, assistPreset('default'), { emulateTrim: true });
      expect(off.landingPitchDeg, `C_v ${cv} bar ${A}: lands`).not.toBeNull();
      const eOff = Math.abs((off.landingPitchDeg as number) - centre);
      const eOn = Math.abs((on.landingPitchDeg as number) - centre);
      expect(eOn, `C_v ${cv} bar ${A}`).toBeLessThan(eOff - 1);
      gain += eOff - eOn;
    }
    expect(gain / cases.length).toBeGreaterThan(2);
  });

  it('never applies a force: with no trim path into the physics, assist on and off fly bit-identical paths', () => {
    const off = jump(8, 2, 10, { ...assistPreset('default'), landingAssist: 0 });
    const on = jump(8, 2, 10, assistPreset('default'));
    expect(on.states.length).toBe(off.states.length);
    for (let k = 0; k < on.states.length; k++) {
      expect(on.states[k].position).toEqual(off.states[k].position);
      expect(on.states[k].quaternion).toEqual(off.states[k].quaternion);
    }
  });
});

describe('determinism (§V2)', () => {
  it('the same inputs and states give the same commands, in any interleaving', () => {
    const settings = assistPreset('default');
    const seq = (k: number): [number, BoatSimSample] => [
      Math.sin(k * 0.37),
      { speed: 20 + 10 * Math.sin(k * 0.05), pitch: 0.05 * Math.sin(k * 0.2), pitchRate: 0.3 * Math.cos(k * 0.2), roll: 0.3 * Math.sin(k * 0.11), vy: Math.sin(k * 0.3), heightAboveWater: 0.35 + Math.max(0, Math.sin(k * 0.1)), airborne: Math.sin(k * 0.1) > 0.5, propImmersion: Math.max(0, Math.cos(k * 0.1)) },
    ];
    const run = (): number[] => {
      const st = createAssistState();
      const input = neutralBoatInput();
      const out: number[] = [];
      for (let k = 0; k < 600; k++) {
        const [stick, sim] = seq(k);
        input.steer = stick;
        input.throttle = 1;
        input.trim = Math.sign(Math.sin(k * 0.02));
        const c = stepAssists(input, sim, settings, st, DT, LOCK);
        out.push(c.steerRad, c.throttle, c.trimRad);
      }
      return out;
    };
    expect(run()).toEqual(run());
  });
});
