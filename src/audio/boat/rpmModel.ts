/**
 * §T.183 RPM MODEL — one engine + its propeller, pure and deterministic.
 *
 * The sim does not publish an engine speed yet (hullWater's thrust is a TEMPORARY constant-power
 * curve, physics-log T179), so audio needs its own crank ODE to have a pitch source at all. It is
 * the tech-research §3.1 law, written once, and runs INSIDE the audio worklet at control rate so
 * the rev limiter cuts fuel at cylinder resolution instead of at 60 Hz:
 *
 *   I·dω/dt = Q_e(rpm, throttle) − Q_friction(rpm) − Q_prop / gear
 *   Q_e     = Q_curve(rpm) · max(throttleLagged^1.6, idleAir) · fuelOn
 *   Q_prop  = K_Q0 · ρ · D⁵ · (n² − (V_a / (J0'·D))²) · (airFloor + (1 − airFloor)·s)
 *
 * n = prop rev/s, V_a = drive advance (hullWater `driveAdvance`), s = prop immersion
 * (`driveImmersion`). The (n² − n_v²) form is K_Q0·(1 − (J/J0')²)·n² without the J = V/(nD)
 * singularity at n = 0; past J0' the water turns the prop (windmilling), which is why a lift at
 * speed holds rpm up and the overrun fuel cut crackles.
 *
 * WHAT FALLS OUT WITHOUT A SPECIAL CASE: a prop in air loses (1 − airFloor) of its torque ⟹ rpm
 * flares to the limiter; the limiter cuts fuel ⟹ rpm falls by friction until the hysteresis band
 * re-fires ⟹ bounce; re-entry restores the load ⟹ bog. Speed is an INPUT TO THE LOAD, never a
 * pitch: the voice reads `rpm` only (V112).
 *
 * If the sim later publishes a drive rpm (S2 `speedboat/drive.ts`), the page passes it as
 * `rpmOverride` and this model only keeps the fuel-cut/overrun state — two consumers must not
 * reconstruct the same field (V77).
 */

export type VoiceKind = 'v8' | 'turbine' | 'twoStroke' | 'electric';
export const VOICE_KINDS: readonly VoiceKind[] = ['v8', 'turbine', 'twoStroke', 'electric'];

/** 'off' = ECU hard limiter only; 'air' = Governor drops the limit while the props are out; 'full' = also eases throttle near the limit when wet */
export type GovernorMode = 'off' | 'air' | 'full';

export interface EngineSpec {
  kind: VoiceKind;
  idleRpm: number;
  /** hard fuel-cut limit (turbine/electric: soft governor start) */
  limitRpm: number;
  /** re-fire this far below the cut */
  limitHystRpm: number;
  /** the Governor's airborne limit */
  governorAirRpm: number;
  /** 'hard' = fuel cut + hysteresis (bounce); 'soft' = torque tapers to zero over `softBandRpm` */
  limiter: 'hard' | 'soft';
  softBandRpm: number;
  /** crank torque curve at full throttle: peak, where, and the parabola half-width */
  peakTorqueNm: number;
  peakTorqueRpm: number;
  torqueSpreadRpm: number;
  /** floor of the curve as a fraction of peak (a parabola must not go negative at idle) */
  torqueFloorFrac: number;
  /** electric: constant torque below this rpm, constant power above; 0 = use the parabola */
  basePowerRpm: number;
  /** friction + pumping: f0 + f1·k + f2·k², k = rpm/1000, N·m */
  friction0: number;
  friction1: number;
  friction2: number;
  /** closed-throttle pumping loss at ≥ 3000 rpm, N·m */
  pumpingNm: number;
  /** rotating inertia reflected to the crank, kg·m² */
  inertia: number;
  throttleTauUp: number;
  throttleTauDown: number;
  throttleExponent: number;
  /** idle air: base opening + P gain on the rpm error fraction, capped */
  idleBase: number;
  idleKp: number;
  idleMax: number;
  /** crank : prop reduction */
  gear: number;
  propDiameter: number;
  /** torque falls to zero at J0' = zeroTorqueJFactor · pitch/D */
  zeroTorqueJFactor: number;
  /** fraction of the water torque a prop in air keeps (tech-research §3.1: 0.12) */
  airFloor: number;
  /** CALIBRATION: at this advance, rpm, slip and immersion, full throttle is in torque balance */
  calSpeed: number;
  calRpm: number;
  calSlip: number;
  calImmersion: number;
  /** overrun fuel cut (DFCO): throttle below this at rpm above `overrunRpm` */
  overrunThrottle: number;
  overrunRpm: number;
}

/** triple rebuilt ethanol V8 outboards (450R class: 4.6 L, ~455 hp at 6000 rpm, 1.75:1, 15.5" × 30") */
export const V8_SPEC: EngineSpec = Object.freeze({
  kind: 'v8',
  idleRpm: 650,
  limitRpm: 6800,
  limitHystRpm: 320,
  governorAirRpm: 5400,
  limiter: 'hard',
  softBandRpm: 200,
  peakTorqueNm: 600,
  peakTorqueRpm: 4600,
  torqueSpreadRpm: 5000,
  torqueFloorFrac: 0.35,
  basePowerRpm: 0,
  friction0: 12,
  friction1: 6,
  friction2: 1.1,
  pumpingNm: 42,
  inertia: 0.2,
  throttleTauUp: 0.12,
  throttleTauDown: 0.07,
  throttleExponent: 1.6,
  idleBase: 0.07,
  idleKp: 2.2,
  idleMax: 0.25,
  gear: 1.75,
  propDiameter: 0.394,
  zeroTorqueJFactor: 1.05,
  airFloor: 0.12,
  calSpeed: 41,
  calRpm: 6300,
  calSlip: 0.1,
  calImmersion: 0.85,
  overrunThrottle: 0.03,
  overrunRpm: 1900,
}) as EngineSpec;

/** "Shine": a marine gas turbine; `rpm` is the power-turbine output after reduction, `spool` the gas generator */
export const TURBINE_SPEC: EngineSpec = Object.freeze({
  ...V8_SPEC,
  kind: 'turbine',
  idleRpm: 900,
  limitRpm: 3000,
  limitHystRpm: 0,
  governorAirRpm: 2700,
  limiter: 'soft',
  softBandRpm: 180,
  peakTorqueNm: 1500,
  peakTorqueRpm: 0,
  torqueSpreadRpm: 9000,
  torqueFloorFrac: 0.75,
  friction0: 20,
  friction1: 18,
  friction2: 0,
  pumpingNm: 0,
  inertia: 1.1,
  throttleTauUp: 1.3,
  throttleTauDown: 0.9,
  throttleExponent: 1.2,
  idleBase: 0.1,
  idleKp: 1.5,
  idleMax: 0.3,
  gear: 0.7,
  calRpm: 2750,
  overrunRpm: 1e9,
}) as EngineSpec;

/** "Flat Jack": three 2.5 L two-stroke triples (per engine), light and peaky */
export const TWO_STROKE_SPEC: EngineSpec = Object.freeze({
  ...V8_SPEC,
  kind: 'twoStroke',
  idleRpm: 850,
  limitRpm: 7900,
  limitHystRpm: 380,
  governorAirRpm: 6200,
  peakTorqueNm: 330,
  peakTorqueRpm: 6600,
  torqueSpreadRpm: 4600,
  torqueFloorFrac: 0.25,
  friction0: 6,
  friction1: 3,
  friction2: 0.6,
  pumpingNm: 14,
  inertia: 0.07,
  throttleTauUp: 0.06,
  throttleTauDown: 0.05,
  idleBase: 0.05,
  gear: 2.0,
  propDiameter: 0.36,
  calRpm: 7300,
  overrunRpm: 2200,
}) as EngineSpec;

/** "Spark": inverter-fed PMSM, constant torque to base speed then constant power */
export const ELECTRIC_SPEC: EngineSpec = Object.freeze({
  ...V8_SPEC,
  kind: 'electric',
  idleRpm: 0,
  limitRpm: 7600,
  limitHystRpm: 0,
  governorAirRpm: 6500,
  limiter: 'soft',
  softBandRpm: 250,
  peakTorqueNm: 520,
  peakTorqueRpm: 0,
  torqueFloorFrac: 0,
  basePowerRpm: 4200,
  friction0: 2,
  friction1: 1.5,
  friction2: 0.25,
  pumpingNm: 0,
  inertia: 0.09,
  throttleTauUp: 0.04,
  throttleTauDown: 0.04,
  throttleExponent: 1.2,
  idleBase: 0,
  idleKp: 0,
  idleMax: 0,
  gear: 2.2,
  calRpm: 7000,
  overrunRpm: 1e9,
}) as EngineSpec;

export const ENGINE_SPECS: Readonly<Record<VoiceKind, EngineSpec>> = {
  v8: V8_SPEC,
  turbine: TURBINE_SPEC,
  twoStroke: TWO_STROKE_SPEC,
  electric: ELECTRIC_SPEC,
};

/** crank torque at full throttle before friction, N·m */
export function torqueCurve(spec: EngineSpec, rpm: number): number {
  const r = Math.max(0, rpm);
  if (spec.basePowerRpm > 0) {
    return r <= spec.basePowerRpm ? spec.peakTorqueNm : (spec.peakTorqueNm * spec.basePowerRpm) / r;
  }
  const u = (r - spec.peakTorqueRpm) / spec.torqueSpreadRpm;
  return spec.peakTorqueNm * Math.max(spec.torqueFloorFrac, 1 - u * u);
}

export function frictionTorque(spec: EngineSpec, rpm: number, thrEff: number): number {
  const k = Math.max(0, rpm) / 1000;
  const pump = spec.pumpingNm * (1 - thrEff) * Math.min(1, k / 3);
  return spec.friction0 * Math.min(1, k * 4) + spec.friction1 * k + spec.friction2 * k * k + pump;
}

/** prop pitch that gives `calSlip` at the calibration point, m */
export function propPitch(spec: EngineSpec): number {
  const n = spec.calRpm / 60 / spec.gear;
  return spec.calSpeed / ((1 - spec.calSlip) * n);
}

export interface PropCoefficients {
  pitch: number;
  /** J0' · D, m — V_a / this = the prop rps at which the water stops loading the prop */
  zeroTorqueLength: number;
  /** K_Q0 · ρ · D⁵ */
  k: number;
}

const coeffCache = new WeakMap<EngineSpec, PropCoefficients>();

/**
 * Solve K_Q0 from the calibration point: full throttle, calRpm, calSpeed advance, calImmersion ⟹
 * engine net torque · gear = prop torque. Every spec therefore reaches its own top-speed rpm at
 * its own design slip, and the planing rpm is a property of the balance, not a lookup.
 */
export function propCoefficients(spec: EngineSpec): PropCoefficients {
  const hit = coeffCache.get(spec);
  if (hit) return hit;
  const pitch = propPitch(spec);
  const zeroTorqueLength = spec.zeroTorqueJFactor * pitch;
  const n = spec.calRpm / 60 / spec.gear;
  const nv = spec.calSpeed / zeroTorqueLength;
  const imm = spec.airFloor + (1 - spec.airFloor) * spec.calImmersion;
  const net = torqueCurve(spec, spec.calRpm) - frictionTorque(spec, spec.calRpm, 1);
  const k = (net * spec.gear) / ((n * n - nv * nv) * imm);
  // ρ and D⁵ are folded into k (K_Q0 = k / (ρ·D⁵))
  const out = { pitch, zeroTorqueLength, k: Math.max(1e-6, k) };
  coeffCache.set(spec, out);
  return out;
}

/** prop torque at the crank, N·m (negative = the water drives the engine) */
export function propTorqueAtCrank(spec: EngineSpec, rpm: number, advance: number, immersion: number): number {
  const c = propCoefficients(spec);
  const n = Math.max(0, rpm) / 60 / spec.gear;
  const nv = Math.max(0, advance) / c.zeroTorqueLength;
  const s = immersion < 0 ? 0 : immersion > 1 ? 1 : immersion;
  let base = n * n - nv * nv;
  // windmilling torque is bounded: a real prop stalls when the water drives it hard
  if (base < -0.6 * nv * nv) base = -0.6 * nv * nv;
  return (c.k * base * (spec.airFloor + (1 - spec.airFloor) * s)) / spec.gear;
}

export interface EngineInput {
  /** −0.3..1 as applied to the drive (reverse uses |throttle|) */
  throttle: number;
  /** m/s, hullWater `driveAdvance[k]` */
  advance: number;
  /** 0..1, hullWater `driveImmersion[k]` */
  immersion: number;
  governor: GovernorMode;
  /** a sim-published rpm, if any: the model then tracks it instead of integrating (V77) */
  rpmOverride?: number;
}

export interface EngineState {
  rpm: number;
  /** lagged throttle, 0..1 */
  throttle: number;
  /** effective throttle opening incl. idle air and governor, 0..1 */
  thrEff: number;
  /** turbine gas-generator spool 0..1 (other kinds: = thrEff) */
  spool: number;
  /** limiter fuel cut active */
  limiterCut: boolean;
  /** overrun (closed-throttle) fuel cut active */
  overrun: boolean;
  /** seconds the current limiter cut has lasted */
  cutTime: number;
  /** increments every time fuel returns after a cut (the voice pops on it) */
  refireCount: number;
  /** increments on every limiter cut (the bounce counter tests read) */
  cutCount: number;
  /** 0..1 combustion load: thrEff with fuel on, 0 off */
  load: number;
  /** positive rate of load rise, smoothed (bark) */
  bark: number;
  /** seconds since the overrun cut began (pop density decays with it) */
  overrunTime: number;
  /** 0..1 limiter activity, smoothed */
  limiterActivity: number;
}

export function createEngineState(spec: EngineSpec): EngineState {
  return {
    rpm: spec.idleRpm,
    throttle: 0,
    thrEff: spec.idleBase,
    spool: spec.idleBase,
    limiterCut: false,
    overrun: false,
    cutTime: 0,
    refireCount: 0,
    cutCount: 0,
    load: 0,
    bark: 0,
    overrunTime: 0,
    limiterActivity: 0,
  };
}

/** internal step ≤ this, s — the ODE is explicit and the limiter band is ~10 ms wide */
export const MAX_ENGINE_STEP = 0.0005;

function fin(x: number, fallback: number): number {
  return Number.isFinite(x) ? x : fallback;
}

/** advance one engine by dt seconds (sub-stepped internally); mutates and returns `st` */
export function stepEngine(st: EngineState, spec: EngineSpec, input: EngineInput, dt: number): EngineState {
  const total = Math.min(0.25, Math.max(0, fin(dt, 0)));
  const steps = Math.max(1, Math.ceil(total / MAX_ENGINE_STEP));
  const h = total / steps;
  if (h <= 0) return st;
  const thrIn = Math.min(1, Math.abs(fin(input.throttle, 0)));
  const advance = Math.min(80, Math.max(0, fin(input.advance, 0)));
  const immersion = Math.min(1, Math.max(0, fin(input.immersion, 1)));
  // a published rpm is trusted up to just past the limiter (a sim value beyond it is a defect upstream, not a sound)
  const override = input.rpmOverride !== undefined && Number.isFinite(input.rpmOverride) ? Math.min(spec.limitRpm + 300, Math.max(0, input.rpmOverride)) : -1;
  const airborneGov = input.governor !== 'off' && immersion < 0.3;
  const limit = airborneGov ? Math.min(spec.limitRpm, spec.governorAirRpm) : spec.limitRpm;
  const kind = spec.kind;

  for (let i = 0; i < steps; i++) {
    // throttle actuator / throttle-body + manifold fill lag
    const tau = thrIn > st.throttle ? spec.throttleTauUp : spec.throttleTauDown;
    st.throttle += (thrIn - st.throttle) * (1 - Math.exp(-h / Math.max(1e-3, tau)));

    let thr = Math.pow(st.throttle, spec.throttleExponent);
    // Governor FULL: ease the opening in the last 8% below the limit while wet (no bounce)
    if (input.governor === 'full' && !airborneGov) {
      const band = limit * 0.08;
      const ease = Math.min(1, Math.max(0, (limit - st.rpm) / band));
      thr *= 0.25 + 0.75 * ease;
    }
    const idleAir = spec.idleRpm > 0 ? Math.min(spec.idleMax, Math.max(0, spec.idleBase + (spec.idleKp * (spec.idleRpm - st.rpm)) / spec.idleRpm)) : 0;
    let thrEff = Math.max(thr, idleAir);

    // ---- fuel: limiter (hard = cut + hysteresis; soft = taper) and overrun cut
    let fuel = 1;
    if (spec.limiter === 'hard') {
      if (!st.limiterCut && st.rpm >= limit) {
        st.limiterCut = true;
        st.cutTime = 0;
        st.cutCount++;
      } else if (st.limiterCut) {
        st.cutTime += h;
        // two full engine cycles at least: a spark/fuel cut drops whole cycles, never half a stroke
        const minCut = 240 / Math.max(600, st.rpm);
        if (st.rpm <= limit - spec.limitHystRpm && st.cutTime >= minCut) {
          st.limiterCut = false;
          st.refireCount++;
        }
      }
      if (st.limiterCut) fuel = 0;
    } else {
      const over = (st.rpm - (limit - spec.softBandRpm)) / Math.max(1, spec.softBandRpm);
      fuel = Math.min(1, Math.max(0, 1 - over));
      st.limiterCut = false;
    }
    const wantsOverrun = kind !== 'turbine' && kind !== 'electric' && st.throttle < spec.overrunThrottle && st.rpm > spec.overrunRpm;
    if (wantsOverrun && !st.overrun) {
      st.overrun = true;
      st.overrunTime = 0;
    } else if (st.overrun && (!wantsOverrun || st.rpm < spec.overrunRpm - 150)) {
      st.overrun = false;
      st.refireCount++;
    }
    if (st.overrun) {
      st.overrunTime += h;
      fuel = 0;
      thrEff = 0;
    }

    // turbine: the gas generator spools behind the lever; torque follows the spool, not the lever
    if (kind === 'turbine') {
      const spoolTarget = Math.max(thrEff, spec.idleBase);
      const sTau = spoolTarget > st.spool ? spec.throttleTauUp : spec.throttleTauDown;
      st.spool += (spoolTarget - st.spool) * (1 - Math.exp(-h / sTau));
      thrEff = st.spool;
    } else {
      st.spool = thrEff * fuel;
    }
    st.thrEff = thrEff;

    const qe = torqueCurve(spec, st.rpm) * thrEff * fuel;
    const newLoad = fuel > 0 ? thrEff * fuel : 0;
    const rise = (newLoad - st.load) / h;
    st.bark += (Math.max(0, rise) * 0.08 - st.bark) * (1 - Math.exp(-h / 0.12));
    st.load = newLoad;
    st.limiterActivity += ((st.limiterCut ? 1 : 0) - st.limiterActivity) * (1 - Math.exp(-h / 0.25));

    if (override >= 0) {
      // sim owns rpm: follow it with a 20 ms de-zipper, keep the fuel/overrun state machine running
      st.rpm += (override - st.rpm) * (1 - Math.exp(-h / 0.02));
      continue;
    }
    const qf = frictionTorque(spec, st.rpm, thrEff);
    const qp = propTorqueAtCrank(spec, st.rpm, advance, immersion);
    const omegaDot = (qe - qf - qp) / spec.inertia;
    const rpmNext = st.rpm + omegaDot * h * (60 / (2 * Math.PI));
    // friction cannot spin the crank backwards; a stall floor of 0
    st.rpm = rpmNext < 0 ? 0 : rpmNext;
  }
  return st;
}

/** time-averaged steady rpm helpers for tests/harness: slip at the prop */
export function propSlip(spec: EngineSpec, rpm: number, advance: number): number {
  const n = Math.max(1e-6, rpm / 60 / spec.gear);
  return 1 - advance / (propPitch(spec) * n);
}
