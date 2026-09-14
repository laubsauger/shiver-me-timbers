/**
 * §T.183 / §T.189 THE ENGINE-MODEL SEAM (V77: thrust, the Governor and audio read ONE rpm).
 *
 * Every boat-audio module imports the engine model from HERE and nowhere else (tests/boatAudioGraph).
 *
 * V8 (the player's triple 450R and most rivals) runs `src/sea-physics/engine.ts` — the sim's own crank +
 * surface-piercing-prop ODE, limiter, overrun cut and `MERCURY_450R` spec. The interfaces did not match
 * one-for-one, so this file ADAPTS rather than re-exports:
 *  - physics has no voice kinds: turbine / two-stroke / electric still run the temporary `./rpmModel`
 *    until engine.ts grows specs for them;
 *  - physics takes a Governor CAP (`rpmLimit`); audio's `GovernorMode` is mapped to it only when audio
 *    integrates locally ('air'/'full' + props out ⟹ `governorAirRpm`);
 *  - physics maps a centred lever (throttle exactly 0) to NEUTRAL — mirrored here;
 *  - the voices need sound-side fields physics does not own (`load`, `bark`, `refireCount`, `overrunTime`,
 *    `limiterActivity`, `spool`): derived below from the physics state's limiter/overrun TRANSITIONS and
 *    lagged throttle. They shape loudness/pops only, never rpm.
 *
 * SIM-PUBLISHED RPM (`hullWater.driveRpm` → `BoatFrameTelemetry.rpm`) wins whenever present: the local
 * physics state is slaved to it (20 ms sound-only de-zipper) and its limiter/overrun logic runs on the
 * SIM's rpm, so the fuel-cut pops follow the same thresholds the sim applies (engine.ts's spec numbers,
 * not a second copy). Without it (NPCs on the worker path, the harness) the same physics ODE integrates
 * locally from drive advance/immersion.
 */
import {
  MERCURY_450R,
  createEngineState as createPhysicsState,
  stepEngine as stepPhysics,
  type EngineSpec as PhysicsSpec,
  type EngineState as PhysicsState,
} from '../../sea-physics/engine';
import {
  ENGINE_SPECS as LEGACY_SPECS,
  createEngineState as createLegacyState,
  stepEngine as stepLegacy,
  type EngineSpec as LegacySpec,
  type EngineState as LegacyState,
  type GovernorMode,
  type VoiceKind,
} from './rpmModel';

export { VOICE_KINDS, type GovernorMode, type VoiceKind } from './rpmModel';

export interface EngineSpec {
  kind: VoiceKind;
  /** crank : prop reduction (ventilation-howl pitch) */
  gear: number;
  idleRpm: number;
  limitRpm: number;
  /** design top-speed advance, m/s (harness/tests) */
  calSpeed: number;
  /** audio's Governor mapping when integrating locally */
  governorAirRpm: number;
  physics: Readonly<PhysicsSpec> | null;
  legacy: Readonly<LegacySpec> | null;
}

export interface EngineInput {
  throttle: number;
  advance: number;
  immersion: number;
  governor: GovernorMode;
  /** sim-published crank rpm for this drive (`hullWater.driveRpm[k]`) */
  rpmOverride?: number;
}

export interface EngineState {
  rpm: number;
  /** sound: effective combustion opening 0..1 */
  thrEff: number;
  /** sound: turbine spool / combustion level 0..1 */
  spool: number;
  /** sound: combustion loudness driver, 0 with fuel off */
  load: number;
  /** sound: smoothed rate of load rise */
  bark: number;
  limiterCut: boolean;
  overrun: boolean;
  overrunTime: number;
  refireCount: number;
  cutCount: number;
  limiterActivity: number;
  phys: PhysicsState | null;
  legacy: LegacyState | null;
  /** de-zippered sim rpm (override path) */
  follow: number;
}

function specFromPhysics(p: Readonly<PhysicsSpec>): EngineSpec {
  return { kind: 'v8', gear: p.gear, idleRpm: p.idleRpm, limitRpm: p.limitRpm, calSpeed: p.calSpeed, governorAirRpm: 5400, physics: p, legacy: null };
}
function specFromLegacy(l: Readonly<LegacySpec>): EngineSpec {
  return { kind: l.kind, gear: l.gear, idleRpm: l.idleRpm, limitRpm: l.limitRpm, calSpeed: l.calSpeed, governorAirRpm: l.governorAirRpm, physics: null, legacy: l };
}

export const ENGINE_SPECS: Readonly<Record<VoiceKind, EngineSpec>> = {
  v8: specFromPhysics(MERCURY_450R),
  turbine: specFromLegacy(LEGACY_SPECS.turbine),
  twoStroke: specFromLegacy(LEGACY_SPECS.twoStroke),
  electric: specFromLegacy(LEGACY_SPECS.electric),
};

/**
 * Engine `index` of a triple: rebuilt engines settle a few rpm apart at idle and cut a few rpm apart at the
 * limiter, so a locally integrated triple beats. The prop calibration is untouched (same kqMax/ktMax).
 */
export function detuneSpec(base: EngineSpec, index: number): EngineSpec {
  if (index === 1) return base;
  const d = index === 0 ? -1 : 1;
  if (base.physics) {
    const p = base.physics;
    return specFromPhysics({ ...p, idleRpm: p.idleRpm * (1 + 0.015 * d), limitRpm: p.limitRpm + 25 * d });
  }
  const l = base.legacy!;
  return specFromLegacy({ ...l, calRpm: l.calRpm * (1 + 0.004 * d), idleRpm: l.idleRpm * (1 + 0.015 * d), limitRpm: l.limitRpm + 25 * d });
}

export function createEngineState(spec: EngineSpec): EngineState {
  const phys = spec.physics ? createPhysicsState(spec.physics) : null;
  const legacy = spec.legacy ? createLegacyState(spec.legacy) : null;
  return {
    rpm: phys ? phys.rpm : legacy!.rpm,
    thrEff: 0,
    spool: legacy ? legacy.spool : 0,
    load: 0,
    bark: 0,
    limiterCut: false,
    overrun: false,
    overrunTime: 0,
    refireCount: 0,
    cutCount: 0,
    limiterActivity: 0,
    phys,
    legacy,
    follow: phys ? phys.rpm : legacy!.rpm,
  };
}

/** sound-only de-zipper on a sim-published rpm, s */
const FOLLOW_TAU = 0.02;

export function stepEngine(st: EngineState, spec: EngineSpec, input: EngineInput, dt: number): EngineState {
  const h = Number.isFinite(dt) ? Math.min(0.25, Math.max(0, dt)) : 0;
  if (h <= 0) return st;
  if (spec.legacy && st.legacy) {
    const l = stepLegacy(st.legacy, spec.legacy, input, h);
    st.rpm = l.rpm;
    st.thrEff = l.thrEff;
    st.spool = l.spool;
    st.load = l.load;
    st.bark = l.bark;
    st.limiterCut = l.limiterCut;
    st.overrun = l.overrun;
    st.overrunTime = l.overrunTime;
    st.refireCount = l.refireCount;
    st.cutCount = l.cutCount;
    st.limiterActivity = l.limiterActivity;
    return st;
  }
  const p = spec.physics!;
  const ph = st.phys!;
  const imm = Number.isFinite(input.immersion) ? Math.min(1, Math.max(0, input.immersion)) : 1;
  const thr = Number.isFinite(input.throttle) ? input.throttle : 0;
  const ov = input.rpmOverride;
  const follow = ov !== undefined && Number.isFinite(ov);
  if (follow) {
    const target = Math.min(p.limitRpm + 300, Math.max(0, ov));
    st.follow += (target - st.follow) * (1 - Math.exp(-h / FOLLOW_TAU));
    ph.rpm = st.follow;
  }
  const wasCut = ph.limiterCut;
  const wasOver = ph.overrun;
  stepPhysics(ph, p, {
    throttle: thr,
    advance: input.advance,
    immersion: imm,
    rpmLimit: !follow && input.governor !== 'off' && imm < 0.3 ? spec.governorAirRpm : undefined,
    neutral: thr === 0,
  }, h);
  if (follow) ph.rpm = st.follow;
  else st.follow = ph.rpm;
  if (!Number.isFinite(ph.rpm)) ph.rpm = p.idleRpm;

  // ---- sound-side state from the physics transitions
  if (ph.limiterCut && !wasCut) st.cutCount++;
  if (!ph.limiterCut && wasCut) st.refireCount++;
  if (ph.overrun && !wasOver) st.overrunTime = 0;
  if (!ph.overrun && wasOver) st.refireCount++;
  if (ph.overrun) st.overrunTime += h;
  st.limiterCut = ph.limiterCut;
  st.overrun = ph.overrun;
  const opening = Math.max(Math.pow(Math.min(1, Math.max(0, ph.throttle)), p.throttleExponent), p.idleBase);
  const fuelOn = !ph.limiterCut && !ph.overrun;
  const load = fuelOn ? opening : 0;
  const rise = (load - st.load) / h;
  st.bark += (Math.max(0, rise) * 0.08 - st.bark) * (1 - Math.exp(-h / 0.12));
  st.load = load;
  st.thrEff = opening;
  st.spool = load;
  st.limiterActivity += ((ph.limiterCut ? 1 : 0) - st.limiterActivity) * (1 - Math.exp(-h / 0.25));
  st.rpm = ph.rpm;
  return st;
}
