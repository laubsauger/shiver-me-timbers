/**
 * §T.189 engine + prop (src/sea-physics/engine.ts) — the ONE rpm model thrust, Governor and voice read (V77).
 *
 * WHY each property:
 *  - PROPPED RIGHT: a real 450R is propped so that at the boat's top speed the engine turns inside Mercury's
 *    5800–6400 rpm WOT window at 8–12 % slip and delivers its rated 450 prop-shaft hp. If the prop law or the
 *    torque curve drifts, top speed becomes a tuning knob instead of the result of the balance.
 *  - BOLLARD: at rest the prop is loaded (rpm below rated) but a high-pitch surface-piercing prop is a poor
 *    static thruster — thrust must sit well under the momentum-theory ideal, or the hole shot is a catapult.
 *  - DRY PROP: the airborne over-rev must fall out of K_Q collapsing with immersion (tech-research §3.1: limiter
 *    within 0.3 s, thrust < 10 %), and the limiter must BOUNCE (cut/refire), not clamp.
 *  - SPOOL: thrust is not instant — the throttle body lags, so a stab of throttle takes ≳ 0.3 s to bite.
 *  - powerScale: tests emulate a larger engine to hold C_v 8–10 on the non-stepped hull; that must scale
 *    thrust without moving rpm, or the voice and the Governor would hear a different engine.
 *  - DETERMINISM / dt: lockstep replays and 1/120 vs 1/240 substep callers must see the same engine.
 *  - REVERSE: reverse gear must push astern.
 *  - DRAG REPORT: solves 3·T(U) = drag(U) on the hull agent's current table and prints the thrust available at
 *    the cited real top speed — the number that says whether drag or thrust is off.
 */
import { describe, expect, it } from 'vitest';
import { MERCURY_450R as S, createEngineState, resetEngineState, stepEngine, type EngineState } from '../src/sea-physics/engine';

const DT = 1 / 240;
const MPH = 0.44704;
/** cited target: Nor-Tech 390 Sport triple 450R 87 mph, Mystic M4200 triple 450R mid-80s ⟹ 85 mph ± 5 % */
const TARGET = 85 * MPH;

function run(st: EngineState, throttle: number, advance: number, immersion: number, secs: number, dt = DT, extra?: { powerScale?: number }): EngineState {
  const n = Math.round(secs / dt);
  for (let i = 0; i < n; i++) stepEngine(st, S, { throttle, advance, immersion, powerScale: extra?.powerScale }, dt);
  return st;
}

/** WOT steady state; immersion defaults to the RUNNING immersion the prop is propped for (T196: calImmersion 0.6, the
 *  transom-wake immersion measured at speed — a planing surface-piercing prop is never buried) */
function steadyWot(advance: number, immersion = S.calImmersion, dt = DT, powerScale?: number): EngineState {
  const st = createEngineState(S);
  st.rpm = 6000;
  st.throttle = 1;
  return run(st, 1, advance, immersion, 4, dt, { powerScale });
}

const shaftPower = (st: EngineState): number => 2 * Math.PI * st.propRps * st.propTorque;

describe('engine: propped like a real triple-450R 39 footer', () => {
  it('at the cited top speed: rpm in the WOT window, 8–12 % slip, plausible η0, rated shaft power', () => {
    const st = steadyWot(TARGET);
    expect(st.rpm).toBeGreaterThanOrEqual(S.wotRpmMin);
    expect(st.rpm).toBeLessThanOrEqual(S.wotRpmMax);
    expect(st.slip).toBeGreaterThanOrEqual(0.08);
    expect(st.slip).toBeLessThanOrEqual(0.12);
    const p = shaftPower(st);
    expect(Math.abs(p / S.ratedPowerW - 1)).toBeLessThan(0.05);
    const eta0 = (st.thrust * TARGET) / p;
    // Kim & Rhee 2024 SPP open water: peak 0.59–0.63, design point just past the peak
    expect(eta0).toBeGreaterThan(0.5);
    expect(eta0).toBeLessThan(0.7);
    expect(st.limiterCut).toBe(false);
  });

  it('WOT rpm stays inside 5800–6400 across the whole ±5 % target speed band (a correctly chosen pitch)', () => {
    for (const u of [TARGET * 0.95, TARGET * 1.05]) {
      const st = steadyWot(u);
      expect(st.rpm).toBeGreaterThanOrEqual(S.wotRpmMin);
      expect(st.rpm).toBeLessThanOrEqual(S.wotRpmMax);
    }
  });

  it('bollard (advance 0, WOT): prop loaded below rated rpm, thrust a fraction of the momentum-theory ideal', () => {
    const st = run(createEngineState(S), 1, 0, 1, 5);
    expect(Number.isFinite(st.thrust) && Number.isFinite(st.rpm) && Number.isFinite(st.propTorque)).toBe(true);
    expect(st.rpm).toBeLessThan(S.ratedRpm);
    expect(st.rpm).toBeGreaterThan(S.idleRpm * 4);
    const p = shaftPower(st);
    const area = Math.PI * (S.propDiameter / 2) ** 2;
    const ideal = Math.cbrt(2 * S.waterDensity * area * p * p); // actuator disc, figure of merit 1
    // high-P/D surface-piercing prop, fully ventilated at J = 0: figure of merit 0.06–0.35
    expect(st.thrust).toBeGreaterThan(0.15 * ideal);
    expect(st.thrust).toBeLessThan(0.5 * ideal);
  });
});

describe('engine: dry prop, limiter, spool', () => {
  it('prop lifted clear at WOT: limiter within 0.3 s, thrust ≈ 0, and it bounces (cut → refire → cut)', () => {
    const st = steadyWot(TARGET);
    const wet = st.thrust;
    stepEngine(st, S, { throttle: 1, advance: TARGET, immersion: 0 }, DT);
    expect(st.shaftAccelTorque).toBeGreaterThan(50); // the rotating parts are being spun up
    let tLimit = -1;
    let cuts = 0;
    let refires = 0;
    let prev = st.limiterCut;
    let maxRpm = 0;
    let minAfter = Infinity;
    for (let i = 1; i < 480; i++) {
      stepEngine(st, S, { throttle: 1, advance: TARGET, immersion: 0 }, DT);
      if (st.limiterCut && tLimit < 0) tLimit = (i + 1) * DT;
      if (st.limiterCut && !prev) cuts++;
      if (!st.limiterCut && prev) refires++;
      prev = st.limiterCut;
      maxRpm = Math.max(maxRpm, st.rpm);
      if (tLimit > 0 && i * DT > tLimit + 0.1) minAfter = Math.min(minAfter, st.rpm);
      expect(Math.abs(st.thrust)).toBeLessThan(0.1 * wet);
    }
    expect(tLimit).toBeGreaterThan(0);
    expect(tLimit).toBeLessThanOrEqual(0.3);
    expect(cuts).toBeGreaterThanOrEqual(3);
    expect(refires).toBeGreaterThanOrEqual(2);
    expect(maxRpm).toBeLessThan(S.limitRpm + 150);
    expect(minAfter).toBeGreaterThan(S.limitRpm - S.limitHystRpm - 400);
  });

  it('spool: a 0→1 throttle step at planing speed takes ≥ 0.3 s to reach 90 % thrust (and < 1.5 s)', () => {
    for (const u of [30, 0]) {
      const final = steadyWot(u, 1).thrust;
      const st = run(createEngineState(S), 0, u, 1, 4);
      let t90 = -1;
      for (let i = 0; i < 480 && t90 < 0; i++) {
        stepEngine(st, S, { throttle: 1, advance: u, immersion: 1 }, DT);
        if (st.thrust >= 0.9 * final) t90 = (i + 1) * DT;
      }
      expect(t90).toBeGreaterThanOrEqual(0.3);
      expect(t90).toBeLessThan(1.5);
    }
  });

  it('lifting at speed: overrun fuel cut, the water windmills the prop well above idle, the prop drags', () => {
    const st = steadyWot(30);
    run(st, 0, 30, 1, 3);
    expect(st.overrun).toBe(true);
    expect(st.rpm).toBeGreaterThan(S.idleRpm * 3);
    expect(st.thrust).toBeLessThan(0);
  });
});

describe('engine: Surge boost (T196)', () => {
  it('boost b: the extra thrust comes out of the prop curve — more than b × thrust and at most √b × rpm at the same advance (lower J); 1 is the stock engine', () => {
    // WHY: the race's Surge must not be a thrust multiplier (a dry prop would push, a prop at the limiter would push
    // more); as charge-pressure torque + Governor over-rev the prop balance decides: torque × b ⇒ n² × b ⇒ thrust × b
    // at the same J, and the lower J of the faster prop adds a little more. Mutation: boost applied to thrust instead (rpm unchanged) or no over-rev allowance (rpm clamps at
    // the limiter, thrust short of b).
    const run1 = (boost: number, advance: number, immersion: number): EngineState => {
      const st = createEngineState(S);
      st.rpm = 6000;
      st.throttle = 1;
      for (let i = 0; i < 4 / DT; i++) stepEngine(st, S, { throttle: 1, advance, immersion, boost }, DT);
      return st;
    };
    const base = run1(1, TARGET, S.calImmersion);
    const stock = steadyWot(TARGET);
    expect(base.thrust).toBe(stock.thrust);
    expect(base.rpm).toBe(stock.rpm);
    const b = 1.2;
    const up = run1(b, TARGET, S.calImmersion);
    // at the same advance the faster prop runs at a lower J, where K_T is higher: measured 1.30 for b 1.2 (≈ b^1.43)
    expect(up.thrust / base.thrust).toBeGreaterThan(b);
    expect(up.thrust / base.thrust).toBeLessThan(b ** 1.6);
    // rpm rises by less than √b: the lower J also raises K_Q (measured × 1.04 for b 1.2); it stays under the raised cut
    expect(up.rpm / base.rpm).toBeGreaterThan(1.02);
    expect(up.rpm / base.rpm).toBeLessThanOrEqual(Math.sqrt(b));
    expect(up.limiterCut).toBe(false);
    // a dry prop gets nothing from it
    expect(Math.abs(run1(b, TARGET, 0).thrust)).toBeLessThan(0.02 * base.thrust);
    // clamped
    expect(run1(5, TARGET, S.calImmersion).rpm).toBeCloseTo(run1(S.boostMax, TARGET, S.calImmersion).rpm, 6);
  });
});

describe('engine: scaling, determinism, reverse', () => {
  it('powerScale k: rpm identical, thrust and prop torque × k', () => {
    const k = 2.5;
    const a = createEngineState(S);
    const b = createEngineState(S);
    for (let i = 0; i < 960; i++) {
      const thr = i < 240 ? 0.4 : 1;
      stepEngine(a, S, { throttle: thr, advance: 20 + i * 0.01, immersion: 1 }, DT);
      stepEngine(b, S, { throttle: thr, advance: 20 + i * 0.01, immersion: 1, powerScale: k }, DT);
      expect(b.rpm).toBeCloseTo(a.rpm, 6);
    }
    expect(b.thrust / a.thrust).toBeCloseTo(k, 6);
    expect(b.propTorque / a.propTorque).toBeCloseTo(k, 6);
  });

  it('two interleaved states are bit-identical; 1/120 vs 1/240 s steady thrust within 1 %', () => {
    const a = createEngineState(S);
    const b = createEngineState(S);
    for (let i = 0; i < 1200; i++) {
      const inp = { throttle: i % 300 < 150 ? 1 : 0.2, advance: 15 + 10 * Math.sin(i * 0.01), immersion: 0.5 + 0.5 * Math.cos(i * 0.03) };
      stepEngine(a, S, inp, DT);
      stepEngine(b, S, inp, DT);
    }
    expect(b.rpm).toBe(a.rpm);
    expect(b.thrust).toBe(a.thrust);
    expect(b.shaftAccelTorque).toBe(a.shaftAccelTorque);
    const t120 = steadyWot(TARGET, 1, 1 / 120).thrust;
    const t240 = steadyWot(TARGET, 1, 1 / 240).thrust;
    expect(Math.abs(t120 / t240 - 1)).toBeLessThan(0.01);
    resetEngineState(a, S);
    expect(a.rpm).toBe(S.idleRpm);
    expect(a.thrust).toBe(0);
  });

  it('reverse gear pushes astern, with the prop turning the other way', () => {
    const st = run(createEngineState(S), -0.3, 0, 1, 3);
    expect(st.thrust).toBeLessThan(0);
    expect(st.propRps).toBeLessThan(0);
    expect(st.propTorque).toBeLessThan(0);
  });
});

describe('engine vs the hull drag table (report for the hull agent)', () => {
  // three engines total, flat water, drives at 0 trim (hull agent, T189 brief)
  const U = [15, 20, 25, 29.5, 35, 40, 45];
  const DRAG = [8.9e3, 11.4e3, 15.3e3, 18.8e3, 23.6e3, 28.3e3, 33.5e3];
  const GEARCASE = [1.3e3, 2.3e3, 3.6e3, 5.1e3, 7.1e3, 9.3e3, 11.8e3];
  const interp = (tab: number[], u: number): number => {
    let i = 0;
    while (i < U.length - 2 && u > U[i + 1]) i++;
    const t = (u - U[i]) / (U[i + 1] - U[i]);
    return tab[i] + (tab[i + 1] - tab[i]) * t;
  };
  const topSpeed = (drag: (u: number) => number): number => {
    let lo = 15;
    let hi = 45;
    for (let it = 0; it < 30; it++) {
      const mid = 0.5 * (lo + hi);
      if (3 * steadyWot(mid).thrust > drag(mid)) lo = mid;
      else hi = mid;
    }
    return 0.5 * (lo + hi);
  };

  it('solves the steady top speed and the thrust available at the cited top speed', () => {
    const vTable = topSpeed((u) => interp(DRAG, u));
    const vNoGearcase = topSpeed((u) => interp(DRAG, u) - interp(GEARCASE, u));
    const tAtTarget = 3 * steadyWot(TARGET).thrust;
    const rpmAtTable = steadyWot(vTable).rpm;
    console.info(
      `[T189 engine] 3×450R top speed on current drag table: ${vTable.toFixed(2)} m/s (${(vTable / MPH).toFixed(1)} mph, WOT ${rpmAtTable.toFixed(0)} rpm); ` +
        `without gearcase drag: ${vNoGearcase.toFixed(2)} m/s (${(vNoGearcase / MPH).toFixed(1)} mph); ` +
        `thrust available at the cited ${(TARGET / MPH).toFixed(0)} mph (${TARGET.toFixed(2)} m/s): ${(tAtTarget / 1e3).toFixed(2)} kN vs table drag ${(interp(DRAG, TARGET) / 1e3).toFixed(2)} kN`,
    );
    // the balance is the result, not a target: pin only that it is a finite crossing inside the table
    expect(vTable).toBeGreaterThan(15);
    expect(vTable).toBeLessThan(45);
    expect(vNoGearcase).toBeGreaterThan(vTable);
    // real boats reach TARGET, so the thrust available there is what the hull's drag must come down to
    expect(tAtTarget).toBeGreaterThan(10e3);
    expect(tAtTarget).toBeLessThan(25e3);
  });
});
