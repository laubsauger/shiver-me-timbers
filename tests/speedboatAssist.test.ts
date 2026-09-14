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
import { rotateVec } from '../src/core/quat';
import { HullWater, type HeightSampler } from '../src/sea-physics/hullWater';
import { createRigid6Memory, stepRigid6, type Rigid6State } from '../src/sea-physics/rigidBody';
import {
  assistPreset,
  createAssistState,
  createGovernorState,
  GOVERNOR,
  readBoatSim,
  safeLockRad,
  speedCoefficient,
  stepAssists,
  stepGovernor,
  stepHelm,
  LANDING_PITCH_CENTRE,
  TRIM_MIN,
  TRIM_RATE,
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

/** how the drive trim reaches the physics over a jump: none, the assists' own command, or full trim-in only while airborne */
type TrimPath = 'none' | 'assist' | 'airOnly';

/** C_v run at speed into a Gaussian sand-bar ridge of height A, half-width w: a real launch and landing */
function jump(
  cv: number,
  A: number,
  w: number,
  settings: AssistSettings,
  trimPath: TrimPath = 'none',
): { airS: number; landingPitchDeg: number | null; maxAirRpm: number; lateAirRpm: number; states: Rigid6State[]; throttles: number[] } {
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
  let maxAirRpm = 0;
  let lateAirRpm = 0;
  let trim = 0;
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
      throttles.push(cmd.throttle);
      if (trimPath === 'assist') trim = cmd.trimRad;
      else if (trimPath === 'airOnly') {
        const max = TRIM_RATE * DT;
        trim += Math.max(-max, Math.min(max, (sim.airborne ? TRIM_MIN : 0) - trim));
      }
      // the real drive trim path (T189 `setControls(steer, throttle, trim)`)
      hw.setControls(cmd.steerRad, cmd.throttle, trim);
    }
    hw.samplePatch(sampler, s, DT);
    stepRigid6(s, hull, DT, 2, (ss, h, out) => hw.evaluate(ss, h, out), mem);
    if (time >= 10) states.push({ position: [...s.position] as Vec3, quaternion: [...s.quaternion] as Quat, velocity: [...s.velocity] as Vec3, angularVelocity: [...s.angularVelocity] as Vec3 });
    const after = readBoatSim(hw, s);
    if (after.airborne) {
      air += DT;
      launched = true;
      maxAir = Math.max(maxAir, air);
      if (time >= 10) maxAirRpm = Math.max(maxAirRpm, after.rpm);
      if (time >= 10 && air > 0.25) lateAirRpm = Math.max(lateAirRpm, after.rpm);
    } else {
      if (launched && landing === null && air > 0.3) landing = after.pitch * DEG;
      air = 0;
    }
  }
  return { airS: maxAir, landingPitchDeg: landing, maxAirRpm, lateAirRpm, states, throttles };
}

describe('the Governor (OFF · AIR · FULL)', () => {
  it('airborne over a real sand bar at full throttle: OFF bounces on the engine\'s rev limiter, AIR governs the flight at rated', () => {
    // WHY (design §3, tech-research §3.1): a prop out of the water loses its load and flares; the Governor is the
    // salvaged module that stops it. §T.207: judged on the ENGINE MODEL's own rpm (hw.driveRpm, §V77), not a proxy. This
    // 4 MW harness runs the props past rated on the approach (6400–6800 rpm wet, ventilating on the face), which the
    // Governor deliberately leaves alone (wet = the running point, §T.206). Measured: 2.5 m bar at C_v 8 flies 1.08 s —
    // OFF 6837 rpm (limiter 6800 + its cut overshoot), AIR 6178 over the whole flight (1.013 × rated); C_v 10 1.5 m bar
    // flies 0.6 s — AIR 6798 on the launch tick (the face), 6069–6165 from 0.25 s on (1.011 × rated).
    const base = { ...assistPreset('pro') };
    const off = jump(8, 2.5, 10, { ...base, governor: 'OFF' });
    const airG = jump(8, 2.5, 10, { ...base, governor: 'AIR' });
    const spec = new HullWater(hull).params.engine;
    expect(off.airS).toBeGreaterThan(0.8);
    expect(airG.airS).toBeGreaterThan(0.8);
    expect(off.maxAirRpm).toBeGreaterThanOrEqual(spec.limitRpm);
    expect(airG.maxAirRpm).toBeLessThanOrEqual(1.02 * spec.ratedRpm);
    const fast = jump(10, 1.5, 10, { ...base, governor: 'AIR' });
    expect(fast.airS).toBeGreaterThan(0.5);
    expect(fast.lateAirRpm).toBeLessThanOrEqual(1.02 * spec.ratedRpm);
  });

  it('wet, AIR changes nothing even over rated; props out, it governs at rated with a lead; FULL caps the landing window only', () => {
    // WHY: the wet running point (calm WOT itself ventilates to 6790 rpm) must cost nothing (§T.206, §V110), while a
    // flaring dry prop is cut on the rise, before the throttle lag lets it reach the limiter
    const wet = (rpm: number, propImmersion = 0.6) => ({ airborne: false, propImmersion, rpm, ratedRpm: 6100 });
    const dry = (rpm: number) => ({ airborne: true, propImmersion: 0, rpm, ratedRpm: 6100 });
    const st = createGovernorState();
    expect(stepGovernor(st, 'AIR', 1, wet(5744), DT)).toBe(1);
    expect(stepGovernor(st, 'AIR', 1, wet(6790, 0.52), DT)).toBe(1);
    expect(stepGovernor(createGovernorState(), 'AIR', 1, wet(6790, 0.19), DT)).toBe(1);
    expect(stepGovernor(createGovernorState(), 'AIR', 1, dry(5000), DT)).toBe(1);
    expect(stepGovernor(createGovernorState(), 'AIR', 1, dry(6400), DT)).toBeLessThan(1);
    expect(stepGovernor(createGovernorState(), 'AIR', 1, dry(6800), DT)).toBe(GOVERNOR.airThrottle);
    // a launch: immersion 0.9 → 0.3 in one tick while the rpm jumps 5700 → 5950 — cut before rated is reached
    const launching = createGovernorState();
    stepGovernor(launching, 'AIR', 1, wet(5700, 0.9), DT);
    expect(stepGovernor(launching, 'AIR', 1, wet(5950, 0.3), DT)).toBeLessThan(1);
    expect(stepGovernor(createGovernorState(), 'OFF', 1, dry(6800), DT)).toBe(1);
    // 0.5 s of air, then touchdown
    const full = createGovernorState();
    for (let k = 0; k < 30; k++) stepGovernor(full, 'FULL', 1, dry(5000), DT);
    const caps: number[] = [];
    for (let k = 0; k < 60; k++) caps.push(stepGovernor(full, 'FULL', 1, wet(5000), DT));
    expect(caps[0]).toBeLessThanOrEqual(0.5);
    expect(caps[35]).toBeLessThanOrEqual(0.5);
    expect(caps[40]).toBe(1);
    // a hop shorter than LANDING_MIN_AIR is not a landing
    const hop = createGovernorState();
    for (let k = 0; k < 10; k++) stepGovernor(hop, 'FULL', 1, dry(5000), DT);
    expect(stepGovernor(hop, 'FULL', 1, wet(5000), DT)).toBe(1);
  });
});

describe('landing assist (trim only) — not in the Default preset (§T.207)', () => {
  // T196: the C_v 8 bar was 1.2 m × 8 — its flight by the airborne flag (hull and gearcases dry) is 0.17 s now, under the
  // 0.3 s a landing needs; 1.6 m flies 0.6 s
  const cases: [number, number, number][] = [[8, 1.6, 8], [8, 2, 10], [6, 1.5, 6], [10, 1.5, 10], [9, 2.5, 12]];

  it('the assist does not earn a place in Default: through the real trim path it lands no nearer the window', () => {
    // WHY: Default is what an unaware player drives with, and every rising face it trims the drives (in a sea: many per
    // lap) — only worth it if it lands her nearer the window BECAUSE of the direction it trims. T182 measured 1.5–4.6°
    // better on buried props with an emulated thrust line. Through the REAL trim path (T189 `setControls` trim; §T.207,
    // Governor AIR on engine rpm), landing pitch off → on (window centre 2.5°): 13.28 → 12.32°, 19.35 → 16.01°,
    // 10.26 → 11.21°, 12.75 → 11.48°, 22.01 → 18.31° — worse at C_v 6. And not for the assist's reason: full trim-OUT on
    // the face (the opposite command) lands 10.57 / 15.96 / 10.23 / 12.16 / 16.57°, as flat or flatter on 4 of 5 bars —
    // tilting a drive either way lifts its prop about the pivot and costs launch thrust; trim swung only in the AIR moves
    // the landing 0.00° (props dry). Removed from Default (settings.ts); the day the assist lands nearer on every bar
    // with > 1° mean gain, this fails and it goes back.
    expect(assistPreset('default').landingAssist).toBe(0);
    const centre = LANDING_PITCH_CENTRE * DEG;
    const gains: number[] = [];
    for (const [cv, A, w] of cases) {
      const off = jump(cv, A, w, { ...assistPreset('default'), landingAssist: 0 }, 'assist').landingPitchDeg;
      const on = jump(cv, A, w, { ...assistPreset('default'), landingAssist: 0.5 }, 'assist').landingPitchDeg;
      const air = jump(cv, A, w, { ...assistPreset('default'), landingAssist: 0 }, 'airOnly').landingPitchDeg;
      const tag = `C_v ${cv} bar ${A}: off ${off?.toFixed(2)} on ${on?.toFixed(2)} air-only trim ${air?.toFixed(2)}`;
      expect(off, tag).not.toBeNull();
      expect(on, tag).not.toBeNull();
      expect(air, tag).not.toBeNull();
      expect(Math.abs((air as number) - (off as number)), tag).toBeLessThan(0.3);
      gains.push(Math.abs((off as number) - centre) - Math.abs((on as number) - centre));
    }
    const mean = gains.reduce((a, b) => a + b, 0) / gains.length;
    expect(Math.min(...gains) > 0 && mean > 1, `gains ${gains.map((g) => g.toFixed(2)).join(', ')}`).toBe(false);
  });

  it('never applies a force: with no trim path into the physics, assist on and off fly bit-identical paths', () => {
    const off = jump(8, 2, 10, { ...assistPreset('default'), landingAssist: 0 });
    const on = jump(8, 2, 10, { ...assistPreset('default'), landingAssist: 0.5 });
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
      { speed: 20 + 10 * Math.sin(k * 0.05), pitch: 0.05 * Math.sin(k * 0.2), pitchRate: 0.3 * Math.cos(k * 0.2), roll: 0.3 * Math.sin(k * 0.11), vy: Math.sin(k * 0.3), heightAboveWater: 0.35 + Math.max(0, Math.sin(k * 0.1)), airborne: Math.sin(k * 0.1) > 0.5, propImmersion: Math.max(0, Math.cos(k * 0.1)), rpm: 5800 + 600 * Math.sin(k * 0.13), ratedRpm: 6100 },
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
