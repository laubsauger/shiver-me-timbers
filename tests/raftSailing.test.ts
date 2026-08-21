/**
 * §T.96 raft sailing model — WHY these tests (properties, §V.80):
 * The raft is a game about NOT being able to point — the `true` set must
 * refuse to drive above its TWA limit or the trade-wind crossing is a
 * motorboat; the `accessible` set must widen that and go faster but keep
 * every SIGN, or the two tunings are two games. Guara steering is the one
 * piece of Kon-Tiki physics players will have read about: boards down
 * forward ⇒ she luffs, down aft ⇒ she bears away (runasimi/Heyerdahl) — the
 * spec row had it backwards, so the sign is asserted from the physics, not
 * from the row. The oar shares the rudder sign of `shipKinematics`
 * (+ = starboard) so one input layer serves both hulls.
 */
import { describe, expect, it } from 'vitest';
import {
  guaraYawMoment,
  neutralRaftControls,
  oarTorque,
  sailDrive,
  stepRaftSailing,
  type RaftControls,
  type RaftMotion,
} from '../src/sailing/raftKinematics';
import { windBearing, type Wind } from '../src/sailing/shipKinematics';
import {
  accessibleRaftTuning,
  activeRaftTuning,
  trueRaftTuning,
  type RaftTuning,
} from '../src/params/raftSailing';
import { SIM_DT } from '../src/core/loop';

const W7: Wind = { direction: 0, speed: 7 }; // blowing toward +z

function raft(yaw = 0, speed = 0): RaftMotion {
  return {
    position: [0, 0, 0],
    yaw,
    velocity: [Math.sin(yaw) * speed, 0, Math.cos(yaw) * speed],
    yawRate: 0,
  };
}

function run(
  s: RaftMotion,
  c: RaftControls,
  wind: Wind,
  t: RaftTuning,
  seconds: number,
  hold = false,
) {
  let st = stepRaftSailing(s, c, wind, t, SIM_DT);
  const n = Math.round(seconds / SIM_DT);
  for (let i = 1; i < n; i++) {
    // hold the heading when we are measuring a speed, not a turn
    const src = hold ? { ...st, yaw: s.yaw, yawRate: 0 } : st;
    st = stepRaftSailing(src, c, wind, t, SIM_DT);
  }
  return st;
}

/** yaw the raft so the wind blows from the given TWA on the port side */
function yawForTwa(twaDeg: number): number {
  // gamma = wind.direction − yaw; TWA = π − |gamma|; port tack ⇒ gamma > 0
  return -(Math.PI - (twaDeg * Math.PI) / 180);
}

const SETS: [string, RaftTuning][] = [
  ['true', trueRaftTuning],
  ['accessible', accessibleRaftTuning],
];

describe('speed polar', () => {
  it('true: dead run in 7 m/s settles to 1.5–2.1 m/s (Heyerdahl 1.5–2)', () => {
    const st = run(raft(), neutralRaftControls(), W7, trueRaftTuning, 240, true);
    expect(st.speed).toBeGreaterThan(1.5);
    expect(st.speed).toBeLessThan(2.1);
  });
  it('accessible (the default): dead run settles to 2.4–3.4 m/s, ~×1.6 true', () => {
    const a = run(raft(), neutralRaftControls(), W7, accessibleRaftTuning, 240, true);
    const t = run(raft(), neutralRaftControls(), W7, trueRaftTuning, 240, true);
    expect(a.speed).toBeGreaterThan(2.4);
    expect(a.speed).toBeLessThan(3.4);
    expect(a.speed / t.speed).toBeGreaterThan(1.4);
    expect(a.speed / t.speed).toBeLessThan(1.8);
    expect(activeRaftTuning()).toBe(accessibleRaftTuning);
  });
  it('true: no drive at 60° TWA — she cannot beat; way decays to a drift', () => {
    expect(sailDrive((60 * Math.PI) / 180, 7, trueRaftTuning)).toBe(0);
    const yaw = yawForTwa(60);
    const st = run(raft(yaw, 2), neutralRaftControls(), W7, trueRaftTuning, 120, true);
    const fwd = st.velocity[0] * Math.sin(yaw) + st.velocity[2] * Math.cos(yaw);
    expect(fwd).toBeLessThan(0.3);
  });
  it('accessible: positive drive at 80° TWA (limit is 70°, §T.96)', () => {
    expect(sailDrive((60 * Math.PI) / 180, 7, accessibleRaftTuning)).toBe(0);
    expect(sailDrive((80 * Math.PI) / 180, 7, accessibleRaftTuning)).toBeGreaterThan(0);
    const yaw = yawForTwa(80);
    const st = run(raft(yaw), neutralRaftControls(), W7, accessibleRaftTuning, 120, true);
    expect(st.drive).toBeGreaterThan(0);
    expect(st.speed).toBeGreaterThan(0.5);
  });
});

describe.each(SETS)('%s tuning — shared properties', (_name, t) => {
  it('drive is zero at and below minTwa, monotone C0 rising above it, max on the run', () => {
    expect(sailDrive(t.minTwa, 7, t)).toBe(0);
    expect(sailDrive(t.minTwa - 0.2, 7, t)).toBe(0);
    let prev = 0;
    for (let a = t.minTwa; a <= Math.PI; a += 0.01) {
      const d = sailDrive(a, 7, t);
      expect(d).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = d;
    }
    // C1 at the limit: onset is QUADRATIC (ratio → 4), not a kink (ratio 2)
    const e = 0.002;
    const ratio = sailDrive(t.minTwa + 2 * e, 7, t) / sailDrive(t.minTwa + e, 7, t);
    expect(ratio).toBeGreaterThan(3.8);
    expect(ratio).toBeLessThan(4.2);
    expect(sailDrive(Math.PI, 7, t)).toBeCloseTo(t.thrust * 49, 9);
  });

  it('forward guaras down, aft raised ⇒ she luffs (turns toward the wind)', () => {
    const c = { ...neutralRaftControls(), guaraDepth: [1, 1, 0, 0, 0] };
    const yaw = yawForTwa(120); // wind from port, gamma > 0
    const s0 = raft(yaw, 1.5);
    const st = run(s0, c, W7, t, 20);
    const gamma = windBearing(yaw, W7.direction);
    expect(gamma).toBeGreaterThan(0);
    // toward the wind on port tack = yaw decreasing
    expect(st.yawRate).toBeLessThan(0);
    expect(Math.abs(st.yawRate)).toBeGreaterThan(1e-3);
  });

  it('aft guaras down, forward raised ⇒ she bears away (turns downwind)', () => {
    const c = { ...neutralRaftControls(), guaraDepth: [0, 0, 0, 1, 1] };
    const yaw = yawForTwa(120);
    const st = run(raft(yaw, 1.5), c, W7, t, 20);
    expect(st.yawRate).toBeGreaterThan(1e-3);
  });

  it('the guara sign mirrors with the tack', () => {
    const c = { ...neutralRaftControls(), guaraDepth: [1, 1, 0, 0, 0] };
    const port = run(raft(yawForTwa(120), 1.5), c, W7, t, 20);
    const stbd = run(raft(-yawForTwa(120), 1.5), c, W7, t, 20);
    expect(Math.sign(port.yawRate)).toBe(-Math.sign(stbd.yawRate));
  });

  it('symmetric boards ⇒ ~zero net guara moment; no boards ⇒ exactly zero', () => {
    const c = neutralRaftControls();
    const sym = { ...c, guaraPos: [3, 1.5, 0, -1.5, -3].map((p) => p + t.sailCE) };
    expect(Math.abs(guaraYawMoment(sym, 1.5, 0.4, t))).toBeLessThan(1e-12);
    expect(guaraYawMoment({ ...c, guaraDepth: [0, 0, 0, 0, 0] }, 1.5, 0.4, t)).toBe(0);
    // no leeway, no lift — boards alone do not turn a raft going straight
    expect(guaraYawMoment({ ...c, guaraDepth: [1, 1, 0, 0, 0] }, 1.5, 0, t)).toBe(0);
  });

  it('positive oar ⇒ starboard turn (yaw increases), the rudder sign of shipKinematics', () => {
    const c = { ...neutralRaftControls(), oarAngle: 1 };
    const st = run(raft(0, 1.5), c, W7, t, 10);
    expect(st.yawRate).toBeGreaterThan(0);
    expect(st.yaw).toBeGreaterThan(0);
    expect(oarTorque(-1, 1.5, t)).toBeLessThan(0);
  });

  it('oar torque saturates at the rope limit and still bites at a crawl', () => {
    expect(t.oarMax).toBeLessThan(1);
    expect(oarTorque(1, 1.5, t)).toBe(oarTorque(t.oarMax, 1.5, t));
    expect(oarTorque(0.5 * t.oarMax, 1.5, t)).toBeLessThan(oarTorque(t.oarMax, 1.5, t));
    expect(oarTorque(1, 0, t)).toBeGreaterThan(0);
    expect(oarTorque(1, 2, t)).toBeGreaterThan(oarTorque(1, 0, t));
  });

  it('sail down ⇒ only windage: drift < 0.3 m/s, downwind only', () => {
    const c = { ...neutralRaftControls(), sailUp: false };
    const st = run(raft(Math.PI / 2, 2), c, W7, t, 240, true);
    expect(st.speed).toBeLessThan(0.3);
    expect(st.drive).toBe(0);
    // she has been carried downwind (+z), not along her own heading (+x)
    expect(st.position[2]).toBeGreaterThan(0);
    const along = st.velocity[0]; // her forward axis is +x here
    expect(Math.abs(along)).toBeLessThan(0.05);
  });

  it('leeway: a beam wind pushes her sideways, and boards reduce it', () => {
    const yaw = yawForTwa(110);
    const down = run(raft(yaw, 1), neutralRaftControls(), W7, t, 60, true);
    const up = run(raft(yaw, 1), { ...neutralRaftControls(), guaraDepth: [0, 0, 0, 0, 0] }, W7, t, 60, true);
    expect(down.leeway).toBeGreaterThan(0); // wind from port ⇒ slides to starboard
    expect(Math.abs(up.leeway)).toBeGreaterThan(Math.abs(down.leeway));
  });

  it('NaN in every input ⇒ finite output', () => {
    const bad: RaftMotion = {
      position: [NaN, NaN, NaN],
      yaw: NaN,
      velocity: [NaN, NaN, NaN],
      yawRate: NaN,
    };
    const c: RaftControls = {
      sheet: NaN,
      guaraDepth: [NaN, 1, NaN, 0, 1],
      guaraPos: [NaN, 1, 0, -1, NaN],
      oarAngle: NaN,
      sailUp: true,
    };
    const st = stepRaftSailing(bad, c, { direction: NaN, speed: NaN }, t, NaN);
    for (const v of [...st.position, ...st.velocity, st.yaw, st.yawRate, st.speed, st.leeway, st.drive])
      expect(Number.isFinite(v)).toBe(true);
    expect(Number.isFinite(guaraYawMoment(c, NaN, NaN, t))).toBe(true);
    expect(Number.isFinite(oarTorque(NaN, NaN, t))).toBe(true);
    expect(Number.isFinite(sailDrive(NaN, NaN, t))).toBe(true);
  });

  it('deterministic: same inputs twice ⇒ identical output, input untouched', () => {
    const s = raft(0.3, 1.2);
    const snap = JSON.stringify(s);
    const c = { ...neutralRaftControls(), oarAngle: 0.3, guaraDepth: [1, 0.5, 0, 1, 0] };
    const a = run(s, c, W7, t, 30);
    const b = run(s, c, W7, t, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(s)).toBe(snap);
  });
});

describe('pluggable tunings', () => {
  it('swapping the set never changes the SIGN of any moment or the drive', () => {
    const cases: Array<[number[], number]> = [
      [[1, 1, 0, 0, 0], 0.6],
      [[0, 0, 0, 1, 1], 0.6],
      [[1, 1, 0, 0, 0], -0.6],
      [[0, 0, 1, 1, 1], 0.2],
    ];
    for (const [depth, lat] of cases) {
      const c = { ...neutralRaftControls(), guaraDepth: depth };
      const a = guaraYawMoment(c, 1.5, lat, trueRaftTuning);
      const b = guaraYawMoment(c, 1.5, lat, accessibleRaftTuning);
      expect(Math.sign(a)).toBe(Math.sign(b));
      expect(a).not.toBe(0);
    }
    for (const ang of [-1, -0.3, 0.3, 1]) {
      expect(Math.sign(oarTorque(ang, 1, trueRaftTuning))).toBe(
        Math.sign(oarTorque(ang, 1, accessibleRaftTuning)),
      );
    }
    for (let a = 0; a <= Math.PI; a += 0.05) {
      // accessible draws wherever true draws (and then some), never the reverse
      if (sailDrive(a, 7, trueRaftTuning) > 0) expect(sailDrive(a, 7, accessibleRaftTuning)).toBeGreaterThan(0);
    }
  });
});
