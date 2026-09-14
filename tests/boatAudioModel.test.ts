/**
 * §T.183 rpm model — the physics the engine voice's pitch comes from (V112: pitch = rpm, never speed).
 * The first blocks pin the temporary audio adapter (`rpmModel.ts`, still the turbine/two-stroke/electric model);
 * the last block pins the §T.189 seam, where the V8 runs `sea-physics/engine.ts`.
 *
 * WHY each property:
 *  - AIRBORNE FLARE: the design doc's "airborne over-rev" must fall out of the prop losing its water
 *    (Q_p × airFloor), not a scripted rev — if the load law breaks, a jump sounds like cruising.
 *  - LIMITER: the fuel cut + hysteresis IS the bounce. A period outside ~40–250 ms reads either as a
 *    buzz (too fast) or a stutter (too slow), and an rpm past the limit means the cut is not cutting.
 *  - GOVERNOR 'air': the assist exists to hold the revs down in the air; if it does not, it is a knob
 *    that drives nothing (V62).
 *  - PLANING: a loaded prop settles to a steady rpm set by the advance ratio, with a real slip —
 *    rpm must RISE with advance and with ventilation. That is the whole "reacts to the physics" claim.
 *  - OVERRUN: lifting at speed lets the water windmill the prop (rpm stays well above idle) and cuts
 *    fuel — the crackle on lift-off depends on that flag.
 *  - NaN: the telemetry is sim output; a NaN in the ODE would silence the worklet for good.
 */
import { describe, expect, it } from 'vitest';
import {
  ENGINE_SPECS,
  V8_SPEC,
  VOICE_KINDS,
  createEngineState,
  propSlip,
  stepEngine,
  type EngineInput,
  type EngineSpec,
  type EngineState,
} from '../src/audio/boat/rpmModel';
import * as SEAM from '../src/audio/boat/engineModel';
import { MERCURY_450R, createEngineState as createPhysicsEngine, stepEngine as stepPhysicsEngine } from '../src/sea-physics/engine';

const DT = 1 / 1500; // the worklet's control step (32 samples at 48 k)

function run(st: EngineState, spec: EngineSpec, input: EngineInput, seconds: number, each?: (st: EngineState, t: number) => void): EngineState {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    stepEngine(st, spec, input, DT);
    each?.(st, (i + 1) * DT);
  }
  return st;
}

function planing(spec: EngineSpec): EngineState {
  return run(createEngineState(spec), spec, { throttle: 1, advance: spec.calSpeed, immersion: spec.calImmersion, governor: 'off' }, 15);
}

describe('§T.183 rpm model — loaded planing', () => {
  it.each(VOICE_KINDS)('%s: full throttle at its design speed settles to a steady rpm with 5–20 % prop slip', (kind) => {
    const spec = ENGINE_SPECS[kind];
    const st = planing(spec);
    let lo = Infinity;
    let hi = -Infinity;
    run(st, spec, { throttle: 1, advance: spec.calSpeed, immersion: spec.calImmersion, governor: 'off' }, 1, (s) => {
      lo = Math.min(lo, s.rpm);
      hi = Math.max(hi, s.rpm);
    });
    expect(hi - lo).toBeLessThan(10);
    expect(st.limiterCut).toBe(false);
    const slip = propSlip(spec, st.rpm, spec.calSpeed);
    expect(slip).toBeGreaterThan(0.05);
    expect(slip).toBeLessThan(0.2);
  });

  it('rpm rises with advance speed (the prop unloads as J grows) — the pitch follows the boat getting on the plane', () => {
    const rpms = [0, 10, 20, 30, 41].map((v) => run(createEngineState(V8_SPEC), V8_SPEC, { throttle: 1, advance: v, immersion: 1, governor: 'off' }, 5).rpm);
    for (let i = 1; i < rpms.length; i++) expect(rpms[i]).toBeGreaterThan(rpms[i - 1] + 100);
    // a hole shot is a loaded engine well below the limit, not a free rev
    expect(rpms[0]).toBeGreaterThan(2000);
    expect(rpms[0]).toBeLessThan(0.7 * V8_SPEC.limitRpm);
  });

  it('a ventilating prop (lower immersion, same advance) runs higher rpm', () => {
    const at = (imm: number): number => run(createEngineState(V8_SPEC), V8_SPEC, { throttle: 0.7, advance: 30, immersion: imm, governor: 'off' }, 5).rpm;
    expect(at(0.5)).toBeGreaterThan(at(1) + 150);
  });

  it('throttle response lags: rpm cannot jump — it takes 0.2–2 s to reach 90 % of the hole-shot rpm', () => {
    const input: EngineInput = { throttle: 1, advance: 0, immersion: 1, governor: 'off' };
    const final = run(createEngineState(V8_SPEC), V8_SPEC, input, 5).rpm;
    let t90 = -1;
    run(createEngineState(V8_SPEC), V8_SPEC, input, 5, (s, t) => {
      if (t90 < 0 && s.rpm >= V8_SPEC.idleRpm + 0.9 * (final - V8_SPEC.idleRpm)) t90 = t;
    });
    expect(t90).toBeGreaterThan(0.2);
    expect(t90).toBeLessThan(2);
  });
});

describe('§T.183 rpm model — airborne, limiter, governor', () => {
  it.each(['v8', 'twoStroke'] as const)('%s: airborne at full throttle ⟹ rpm reaches the limiter within 0.35 s and never overshoots it by > 150 rpm', (kind) => {
    const spec = ENGINE_SPECS[kind];
    const st = planing(spec);
    let tReach = -1;
    let peak = 0;
    run(st, spec, { throttle: 1, advance: spec.calSpeed, immersion: 0, governor: 'off' }, 1.5, (s, t) => {
      peak = Math.max(peak, s.rpm);
      if (tReach < 0 && s.rpm >= 0.97 * spec.limitRpm) tReach = t;
    });
    expect(tReach).toBeGreaterThan(0);
    expect(tReach).toBeLessThan(0.35);
    expect(peak).toBeLessThan(spec.limitRpm + 150);
  });

  it.each(['turbine', 'electric'] as const)('%s: airborne ⟹ rpm flares into its soft governor band (no fuel-cut bounce)', (kind) => {
    const spec = ENGINE_SPECS[kind];
    const st = planing(spec);
    const before = st.rpm;
    run(st, spec, { throttle: 1, advance: spec.calSpeed, immersion: 0, governor: 'off' }, 3);
    expect(st.rpm).toBeGreaterThan(before + 100);
    expect(st.rpm).toBeGreaterThan(spec.limitRpm - spec.softBandRpm * 1.5);
    expect(st.rpm).toBeLessThan(spec.limitRpm + 50);
    expect(st.cutCount).toBe(0);
  });

  it('V8 limiter bounce: fuel-cut period in a plausible 40–250 ms, repeating while airborne', () => {
    const st = planing(V8_SPEC);
    run(st, V8_SPEC, { throttle: 1, advance: V8_SPEC.calSpeed, immersion: 0, governor: 'off' }, 0.5);
    const times: number[] = [];
    let last = st.cutCount;
    run(st, V8_SPEC, { throttle: 1, advance: V8_SPEC.calSpeed, immersion: 0, governor: 'off' }, 2, (s, t) => {
      if (s.cutCount !== last) {
        last = s.cutCount;
        times.push(t);
      }
    });
    expect(times.length).toBeGreaterThan(8);
    const period = (times[times.length - 1] - times[0]) / (times.length - 1);
    expect(period).toBeGreaterThan(0.04);
    expect(period).toBeLessThan(0.25);
    // every cut ends in a re-fire (the pop the voice plays)
    expect(st.refireCount).toBeGreaterThanOrEqual(times.length - 1);
  });

  it("Governor 'air' holds the airborne revs to its own lower limit, and bounces there", () => {
    const st = planing(V8_SPEC);
    let peak = 0;
    const cuts0 = st.cutCount;
    run(st, V8_SPEC, { throttle: 1, advance: V8_SPEC.calSpeed, immersion: 0, governor: 'air' }, 2, (s, t) => {
      if (t > 0.5) peak = Math.max(peak, s.rpm);
    });
    expect(peak).toBeLessThan(V8_SPEC.governorAirRpm + 150);
    expect(st.cutCount - cuts0).toBeGreaterThan(5);
    // and while wet the Governor 'air' leaves planing rpm alone
    const wet = run(createEngineState(V8_SPEC), V8_SPEC, { throttle: 1, advance: V8_SPEC.calSpeed, immersion: V8_SPEC.calImmersion, governor: 'air' }, 6);
    expect(Math.abs(wet.rpm - planing(V8_SPEC).rpm)).toBeLessThan(5);
  });

  it('re-entry after a jump bogs: rpm drops back under the limiter once the prop bites', () => {
    const st = planing(V8_SPEC);
    run(st, V8_SPEC, { throttle: 1, advance: V8_SPEC.calSpeed, immersion: 0, governor: 'off' }, 1);
    run(st, V8_SPEC, { throttle: 1, advance: V8_SPEC.calSpeed, immersion: V8_SPEC.calImmersion, governor: 'off' }, 0.8);
    expect(st.rpm).toBeLessThan(V8_SPEC.limitRpm - 300);
  });
});

describe('§T.183 rpm model — overrun, robustness, override', () => {
  it('lift at speed: overrun fuel cut on, and the water windmills the prop far above idle', () => {
    const st = planing(V8_SPEC);
    run(st, V8_SPEC, { throttle: 0, advance: V8_SPEC.calSpeed, immersion: V8_SPEC.calImmersion, governor: 'off' }, 2);
    expect(st.overrun).toBe(true);
    expect(st.load).toBe(0);
    expect(st.rpm).toBeGreaterThan(3 * V8_SPEC.idleRpm);
    // slowing down ends the overrun and fuel returns (a re-fire)
    const refires = st.refireCount;
    run(st, V8_SPEC, { throttle: 0, advance: 0, immersion: 1, governor: 'off' }, 4);
    expect(st.overrun).toBe(false);
    expect(st.refireCount).toBeGreaterThan(refires);
    expect(Math.abs(st.rpm - V8_SPEC.idleRpm)).toBeLessThan(120);
  });

  it('extreme and non-finite inputs never produce a non-finite or runaway rpm', () => {
    for (const kind of VOICE_KINDS) {
      const spec = ENGINE_SPECS[kind];
      const st = createEngineState(spec);
      const bad = [NaN, Infinity, -Infinity, 1e9, -1e9, 0];
      for (const a of bad) for (const b of bad) {
        stepEngine(st, spec, { throttle: a, advance: b, immersion: a, governor: 'full' }, 0.05);
        stepEngine(st, spec, { throttle: b, advance: a, immersion: b, governor: 'off', rpmOverride: a }, b);
        expect(Number.isFinite(st.rpm)).toBe(true);
        expect(st.rpm).toBeGreaterThanOrEqual(0);
        expect(st.rpm).toBeLessThan(spec.limitRpm + 500);
      }
    }
  });

  it('a sim-published rpm overrides the ODE (V77: one field, one owner)', () => {
    const st = createEngineState(V8_SPEC);
    run(st, V8_SPEC, { throttle: 0.4, advance: 0, immersion: 1, governor: 'off', rpmOverride: 4321 }, 0.5);
    expect(st.rpm).toBeCloseTo(4321, 0);
  });

  it('is deterministic: identical input sequences give identical state', () => {
    const a = createEngineState(V8_SPEC);
    const b = createEngineState(V8_SPEC);
    for (let i = 0; i < 3000; i++) {
      const inp: EngineInput = { throttle: (i % 700) / 700, advance: (i % 900) / 30, immersion: i % 500 < 100 ? 0 : 0.8, governor: 'off' };
      stepEngine(a, V8_SPEC, inp, DT);
      stepEngine(b, V8_SPEC, inp, DT);
    }
    expect(a).toEqual(b);
  });
});

describe('§T.189 engine-model seam: the V8 voice runs the SIM engine (sea-physics/engine.ts)', () => {
  // WHY: V77 — thrust, the Governor and the voice must agree on rpm. These pin that the seam really drives
  // the physics model (same limiter, same prop), that a sim-published rpm wins, and that the sound-only
  // fuel-cut bookkeeping (pops) follows the physics limiter rather than a second copy of it.
  const S = SEAM.ENGINE_SPECS.v8;
  const runSeam = (st: SEAM.EngineState, input: SEAM.EngineInput, seconds: number, each?: (s: SEAM.EngineState, t: number) => void) => {
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) {
      SEAM.stepEngine(st, S, input, DT);
      each?.(st, (i + 1) * DT);
    }
    return st;
  };

  it('the V8 spec IS the physics 450R (gear, idle, limiter), not the audio adapter', () => {
    expect(S.physics).toBe(MERCURY_450R);
    expect(S.gear).toBe(MERCURY_450R.gear);
    expect(S.limitRpm).toBe(MERCURY_450R.limitRpm);
  });

  it('local integration matches the physics model step for step', () => {
    const seam = SEAM.createEngineState(S);
    const phys = createPhysicsEngine(MERCURY_450R);
    const input = { throttle: 1, advance: 30, immersion: 0.9 };
    for (let i = 0; i < 3000; i++) {
      SEAM.stepEngine(seam, S, { ...input, governor: 'off' }, DT);
      stepPhysicsEngine(phys, MERCURY_450R, input, DT);
    }
    expect(seam.rpm).toBe(phys.rpm);
  });

  it('airborne at WOT: physics limiter bounces, every cut is counted and re-fires (the pops)', () => {
    const st = runSeam(SEAM.createEngineState(S), { throttle: 1, advance: MERCURY_450R.calSpeed, immersion: 1, governor: 'off' }, 8);
    let peak = 0;
    runSeam(st, { throttle: 1, advance: MERCURY_450R.calSpeed, immersion: 0, governor: 'off' }, 2, (s) => (peak = Math.max(peak, s.rpm)));
    expect(st.cutCount).toBeGreaterThan(8);
    expect(st.refireCount).toBeGreaterThanOrEqual(st.cutCount - 1);
    expect(peak).toBeLessThan(MERCURY_450R.limitRpm + 150);
  });

  it('a sim-published rpm wins: the state follows it, and the limiter flags come from the physics thresholds applied to it', () => {
    const st = SEAM.createEngineState(S);
    runSeam(st, { throttle: 0.6, advance: 0, immersion: 1, governor: 'off', rpmOverride: 4321 }, 0.5);
    expect(st.rpm).toBeCloseTo(4321, 0);
    expect(st.limiterCut).toBe(false);
    runSeam(st, { throttle: 1, advance: 0, immersion: 0, governor: 'off', rpmOverride: MERCURY_450R.limitRpm + 50 }, 0.3);
    expect(st.limiterCut).toBe(true);
    const cuts = st.cutCount;
    runSeam(st, { throttle: 1, advance: 0, immersion: 0, governor: 'off', rpmOverride: MERCURY_450R.limitRpm - MERCURY_450R.limitHystRpm - 100 }, 0.3);
    expect(st.limiterCut).toBe(false);
    expect(st.refireCount).toBeGreaterThan(0);
    expect(cuts).toBeGreaterThan(0);
  });

  it('lift at speed through the seam: the overrun cut silences combustion (load 0), then fuel returns', () => {
    const st = runSeam(SEAM.createEngineState(S), { throttle: 1, advance: 35, immersion: 1, governor: 'off' }, 6);
    runSeam(st, { throttle: 0, advance: 35, immersion: 1, governor: 'off' }, 0.3);
    expect(st.overrun).toBe(true);
    expect(st.load).toBe(0);
    runSeam(st, { throttle: 0, advance: 0, immersion: 1, governor: 'off' }, 5);
    expect(st.overrun).toBe(false);
    expect(st.load).toBeGreaterThan(0);
  });
});
