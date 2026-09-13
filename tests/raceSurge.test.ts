/**
 * §T.184 Surge boost — EARNED ONLY (design doc §3, §V80).
 *
 * WHY: Surge is the Governor letting go as a reward for riding the sea well. If it recharges
 * by itself, or a sloppy landing or a crash still pays, it turns into a catch-up/spam button
 * and the risk the whole mode is built on stops mattering. So: only the three qualifying events
 * pay, a bad version of each pays nothing, the meter stops at 3, a crash or penalty inside an
 * exposed sector voids that sector, and firing costs a whole segment for a bounded boost.
 */
import { describe, expect, it } from 'vitest';
import { raceParams } from '../src/race/params';
import type { RacerSensors } from '../src/race/sensors';
import { SurgeMeter, type SurgeAward } from '../src/race/surge';

const DT = 1 / 60;
const P = raceParams.surge;
const deg = Math.PI / 180;

type In = Pick<RacerSensors, 'airborne' | 'slam' | 'pitch' | 'roll' | 'crashed' | 'launchedFromWake' | 'surgePressed'>;
const calm: In = { airborne: false, slam: 0, pitch: 2 * deg, roll: 0, crashed: false, launchedFromWake: false, surgePressed: false };

class Rig {
  meter = new SurgeMeter(P);
  t = 0;
  awards: SurgeAward[] = [];
  fired = 0;
  run(seconds: number, input: Partial<In> = {}, earning = true) {
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) {
      this.t += DT;
      const r = this.meter.step({ ...calm, ...input }, this.t, DT, earning);
      this.awards.push(...r.awards);
      if (r.fired) this.fired++;
    }
  }
  /** takeoff, air for `air` s, touchdown with `landing` inputs, then 0.5 s of running */
  jump(air: number, landing: Partial<In> = {}, airInput: Partial<In> = {}) {
    this.run(air, { airborne: true, ...airInput });
    this.run(2 * DT, landing);
    this.run(0.5);
  }
}

describe('§T.184 Surge earning', () => {
  it('a clean landing after ≥ 0.6 s of air earns one third of a segment, once', () => {
    const r = new Rig();
    r.run(1);
    r.jump(0.8);
    expect(r.awards).toEqual([{ reason: 'cleanLanding', amount: 1 / 3 }]);
    expect(r.meter.segments).toBeCloseTo(1 / 3, 12);
  });

  it('nothing else pays: short hops, bad attitude, hard slam, a crash in the landing, or just driving', () => {
    const r = new Rig();
    r.run(600); // ten minutes of clean running: no passive recharge
    r.jump(0.4); // too short
    r.jump(0.8, { pitch: 12 * deg }); // bow high
    r.jump(0.8, { pitch: -5 * deg }); // stuffed
    r.jump(0.8, { roll: 15 * deg }); // on a chine
    r.jump(0.8, { slam: P.cleanSlamMax + 0.5 }); // slammed
    r.jump(0.8, { crashed: true }); // crash on touchdown
    r.jump(0.8, {}, { launchedFromWake: false });
    // the last jump above IS clean: exactly one award overall proves the others were refused
    expect(r.awards.map((a) => a.reason)).toEqual(['cleanLanding']);
  });

  it('a slam arriving just after touchdown (inside the landing window) still spoils the landing', () => {
    const r = new Rig();
    r.run(0.8, { airborne: true });
    r.run(DT); // touchdown tick, no slam yet
    r.run(2 * DT, { slam: P.cleanSlamMax + 1 });
    r.run(0.5);
    expect(r.awards).toEqual([]);
  });

  it('a wake jump pays even when short, and one jump pays once', () => {
    const r = new Rig();
    r.jump(0.3, {}, { launchedFromWake: true });
    r.jump(0.9, {}, { launchedFromWake: true }); // long and clean: still one award, as a wake jump
    expect(r.awards.map((a) => a.reason)).toEqual(['wakeJump', 'wakeJump']);
    expect(r.meter.segments).toBeCloseTo(2 / 3, 12);
  });

  it('a wake jump that ends in a crash pays nothing', () => {
    const r = new Rig();
    r.jump(0.5, { crashed: true }, { launchedFromWake: true });
    expect(r.awards).toEqual([]);
  });

  it('the meter caps at 3 segments and further clean jumps add nothing', () => {
    const r = new Rig();
    for (let i = 0; i < 12; i++) r.jump(0.8);
    expect(r.meter.segments).toBe(3);
    const before = r.awards.length;
    r.jump(0.8);
    expect(r.awards.length).toBe(before);
    expect(r.awards.reduce((s, a) => s + a.amount, 0)).toBeCloseTo(3, 12);
  });

  it('no earning outside the race (grid, finished)', () => {
    const r = new Rig();
    r.run(0.8, { airborne: true }, false);
    r.run(0.5, {}, false);
    expect(r.awards).toEqual([]);
  });
});

describe('§T.184 Surge exposed sectors', () => {
  it('an exposed gate-to-gate sector run clean pays; a sheltered one does not', () => {
    const m = new SurgeMeter(P);
    expect(m.passGate('exposed', true)).toBeNull(); // opens the sector
    expect(m.passGate('sheltered', true)).toEqual({ reason: 'cleanSector', amount: 1 / 3 });
    expect(m.passGate('sheltered', true)).toBeNull(); // sheltered sector closed: nothing
  });

  it('a crash inside the sector voids it, and the next sector starts clean again', () => {
    const m = new SurgeMeter(P);
    m.passGate('exposed', true);
    m.step({ ...calm, crashed: true }, 1, DT, true);
    m.step(calm, 1 + DT, DT, true);
    expect(m.passGate('exposed', true)).toBeNull();
    expect(m.passGate('exposed', true)).toEqual({ reason: 'cleanSector', amount: 1 / 3 });
  });

  it('a hard landing or a penalty inside the sector voids it', () => {
    const hard = new SurgeMeter(P);
    hard.passGate('exposed', true);
    hard.step({ ...calm, slam: P.hardSlam + 1 }, 1, DT, true);
    expect(hard.passGate('exposed', true)).toBeNull();

    const pen = new SurgeMeter(P);
    pen.passGate('exposed', true);
    pen.voidSector();
    expect(pen.passGate('exposed', true)).toBeNull();
  });
});

describe('§T.184 Surge firing', () => {
  it('needs a whole segment, consumes one, boosts for the boost time, then returns to 1', () => {
    const r = new Rig();
    r.jump(0.8);
    r.jump(0.8);
    r.run(DT, { surgePressed: true });
    r.run(DT);
    expect(r.fired).toBe(0); // 2/3 of a segment is not enough
    r.jump(0.8);
    expect(r.meter.segments).toBeCloseTo(1, 9);
    r.run(DT, { surgePressed: true });
    expect(r.fired).toBe(1);
    expect(r.meter.segments).toBe(0);
    expect(r.meter.thrustMultiplier).toBeGreaterThan(1);
    r.run(P.boostSeconds - 2 * DT);
    expect(r.meter.thrustMultiplier).toBeGreaterThan(1);
    r.run(2 * DT);
    expect(r.meter.thrustMultiplier).toBe(1);
  });

  it('holding the button fires once; a press while boosting neither stacks nor spends', () => {
    const r = new Rig();
    for (let i = 0; i < 6; i++) r.jump(0.8); // 2 segments
    r.run(1, { surgePressed: true }); // held a whole second
    expect(r.fired).toBe(1);
    r.run(DT);
    r.run(DT, { surgePressed: true }); // new press, still boosting
    expect(r.fired).toBe(1);
    expect(r.meter.segments).toBeCloseTo(1, 9);
  });

  it('a crash ends the boost', () => {
    const r = new Rig();
    for (let i = 0; i < 3; i++) r.jump(0.8);
    r.run(DT, { surgePressed: true });
    r.run(DT, { crashed: true });
    expect(r.meter.thrustMultiplier).toBe(1);
  });
});
