/**
 * §T.98 raft entry glue, GPU-free. WHY each block exists:
 *
 * - day clock: `dayMinutes` is a RATE knob. A clock that drifts by a minute
 *   a day is invisible in play and wrong; 24 real minutes of sim ticks must
 *   land on exactly one day, and the wrap must be [0, 24) because the sky
 *   reads the value as an hour.
 * - adapter: sailing owns x/z/yaw, buoyancy owns y/pitch/roll (§V.77). If
 *   the adapter ever wrote `position[1]` or lost the roll, the raft would
 *   either stop heaving or stop rolling — silently, on the next tick.
 * - actions: every station name maps to ONE documented control with the
 *   documented clamp; a name that maps to nothing is the §V.62 defect.
 * - tuning: `activeRaftTuning()` is a live switch and must be read per tick.
 * - beaching (§T.109): the tick wrapper must run `stepRaftBeaching` AFTER
 *   sailing on the raft's own params, hold her once beached, and route the
 *   `push-off` station to `pushOff` — and only offer it while beached. A
 *   raft that sails through the sand, or a push-off that does nothing, is
 *   the §V.62 dead-knob shape.
 * - raft sea params: the raft is 15 t on a 0.3 m draft; floating her on the
 *   galleon's 604 t / 2 m (what §T.98 shipped) puts the deck under water.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SIM_DT } from '../src/core/loop';
import {
  advanceClock,
  bootTimeOfDay,
  calmPreset,
  clockRate,
  createDayClock,
  DAWN_HOUR,
  raftWeatherPresets,
  skipToDawn,
} from '../src/raft/raftWorld';
import { raftWorldParams } from '../src/params/raftWorld';
import {
  motionOf, pushOffRaft, quatFromAxisAngle, quatMul, rotateVec, stepRaftBeach, stepRaftShip, writeMotion, yawOf,
} from '../src/raft/raftShip';
import {
  applyDebugChannel,
  applyRaftAction,
  bindRaftActions,
  initialRaftControls,
  radio,
  raftBeach,
  type ActionHost,
} from '../src/raft/raftActions';
import { neutralRaftBeaching, raftContactPoints } from '../src/sailing/raftBeaching';
import { raftBeachingParams } from '../src/params/raftBeaching';
import { brigantineSeaParams, raftSeaParams, seaPhysicsParams } from '../src/params/seaPhysics';
import { equilibriumDraft } from '../src/sea-physics/buoyancy';
import { getParamsEntry } from '../src/params/registry';
import { raftParams } from '../src/params/raft';
import { RAFT_ACTIONS } from '../src/player/stations';
import * as raftSailingParams from '../src/params/raftSailing';
import { PRESET_STORMINESS, WEATHER_PRESET_NAMES } from '../src/weather/presets';
import type { ShipState } from '../src/state/simState';
import type { SkyParams } from '../src/params/sky';

const P = { dayMinutes: 24, startHour: 7, clockRunning: true, maxStorminess: 0.12, defaultPreset: 'calm' as const };

function ship(over: Partial<ShipState> = {}): ShipState {
  return {
    id: 'player', kind: 'player',
    position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0],
    rudder: 0, sailTrim: 0.5, anchored: false, flood: 0, damage: {},
    ...over,
  };
}

describe('day clock (§T.98)', () => {
  it('dayMinutes real minutes of sim ticks are exactly one day, and the hour wraps to [0, 24)', () => {
    const ticks = Math.round((P.dayMinutes * 60) / SIM_DT);
    let tod = 7;
    for (let i = 0; i < ticks; i++) tod = advanceClock(tod, SIM_DT, P);
    expect(tod).toBeCloseTo(7, 6);
    expect(advanceClock(23.99, 1, P)).toBeLessThan(24);
    expect(advanceClock(23.99, 1, P)).toBeGreaterThanOrEqual(0);
    // one game hour per real minute at 24
    expect(clockRate(P) * 60).toBeCloseTo(1, 12);
  });

  it('is a live knob: halving dayMinutes doubles the rate, clockRunning=false freezes the sun', () => {
    expect(advanceClock(0, 60, { ...P, dayMinutes: 12 })).toBeCloseTo(2, 9);
    expect(advanceClock(13.5, 600, { ...P, clockRunning: false })).toBe(13.5);
    expect(advanceClock(Number.NaN, Number.NaN, P)).toBe(0);
  });

  it('the mat wakes you at 06:00, and the clock writes the sky params object it is handed', () => {
    expect(skipToDawn()).toBe(DAWN_HOUR);
    expect(DAWN_HOUR).toBe(6);
    const sky = { timeOfDay: 22 } as SkyParams;
    const clock = createDayClock(P, sky);
    clock.tick(60);
    expect(sky.timeOfDay).toBeCloseTo(23, 9);
    clock.skipToDawn();
    expect(sky.timeOfDay).toBe(6);
    clock.set(-1);
    expect(sky.timeOfDay).toBe(23);
    expect(clock.hour).toBe(23);
  });

  it('?tod= wins over startHour; garbage falls back to it; the params module is registered with its defaults', () => {
    expect(bootTimeOfDay('?tod=18.5', P)).toBe(18.5);
    expect(bootTimeOfDay('?tod=banana', P)).toBe(7);
    expect(bootTimeOfDay('?at=lagoon', { ...P, startHour: 5 })).toBe(5);
    expect(bootTimeOfDay('?tod=25', P)).toBe(1);
    expect(raftWorldParams.dayMinutes).toBe(24);
    expect(raftWorldParams.startHour).toBe(7);
    expect(raftWorldParams.clockRunning).toBe(true);
  });
});

describe('weather ceiling (§T.98 storm presets excluded)', () => {
  it('admits only presets at or below maxStorminess and swaps the rest for the fallback', () => {
    const admitted = raftWeatherPresets(P);
    expect(admitted).toEqual(['glass', 'calm', 'breeze', 'swell']);
    for (const n of WEATHER_PRESET_NAMES) {
      const out = calmPreset(n, P);
      expect(PRESET_STORMINESS[out]).toBeLessThanOrEqual(P.maxStorminess);
      if (PRESET_STORMINESS[n] <= P.maxStorminess) expect(out).toBe(n);
      else expect(out).toBe(P.defaultPreset);
    }
    expect(calmPreset('not-a-preset', P)).toBe(P.defaultPreset);
    expect(P.defaultPreset).toBe('calm'); // user: calm is the raft's default sea
  });
});

describe('RaftMotion ↔ ShipState adapter (§V.77 split)', () => {
  it('round-trips yaw through the quaternion and leaves y, vy, pitch and roll exactly alone', () => {
    const pitch = 0.12;
    const roll = -0.2;
    const yaw0 = 0.8;
    const q = quatMul(
      quatFromAxisAngle([0, 1, 0], yaw0),
      quatMul(quatFromAxisAngle([1, 0, 0], pitch), quatFromAxisAngle([0, 0, 1], roll)),
    );
    const s = ship({ quaternion: q, position: [3, -0.37, 5], velocity: [0.5, 0.21, 1] });
    expect(yawOf(q)).toBeCloseTo(yaw0, 9);
    const m = motionOf(s);
    expect(m.yaw).toBeCloseTo(yaw0, 9);
    writeMotion(s, { position: [4, 999, 6], yaw: 2.5, velocity: [1, 999, 2], yawRate: 0.3 });
    expect(s.position).toEqual([4, -0.37, 6]);
    expect(s.velocity).toEqual([1, 0.21, 2]);
    expect(s.angularVelocity[1]).toBe(0.3);
    expect(yawOf(s.quaternion)).toBeCloseTo(2.5, 9);
    // pitch and roll survive: forward.y is the pitch, the residual about z is the roll
    const fwd = rotateVec(s.quaternion, [0, 0, 1]);
    expect(Math.asin(fwd[1])).toBeCloseTo(-Math.asin(-Math.sin(pitch)) * -1, 6);
    const qYP = quatMul(quatFromAxisAngle([0, 1, 0], 2.5), quatFromAxisAngle([1, 0, 0], -Math.asin(fwd[1])));
    const res = quatMul([-qYP[0], -qYP[1], -qYP[2], qYP[3]], s.quaternion);
    expect(2 * Math.atan2(res[2], res[3])).toBeCloseTo(roll, 6);
  });

  it('stepRaftShip moves the hull under sail, mirrors oar and sheet onto rudder/sailTrim, never touches y', () => {
    const s = ship({ position: [0, -0.4, 0], velocity: [0, 0.05, 0] });
    const c = initialRaftControls();
    c.oarAngle = 0.4;
    c.sheet = 1;
    for (let i = 0; i < 600; i++) stepRaftShip(s, c, { speed: 8, direction: 0 }, SIM_DT);
    expect(Math.hypot(s.velocity[0], s.velocity[2])).toBeGreaterThan(0.2);
    expect(s.position[1]).toBe(-0.4);
    expect(s.velocity[1]).toBe(0.05);
    expect(s.rudder).toBe(0.4);
    expect(s.sailTrim).toBe(1);
    c.sailUp = false;
    stepRaftShip(s, c, { speed: 8, direction: 0 }, SIM_DT);
    expect(s.sailTrim).toBe(0);
  });
});

describe('activeRaftTuning is consulted EVERY tick (§V.62)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('the wrapper calls it once per step and sails on whatever it returns', () => {
    const spy = vi.spyOn(raftSailingParams, 'activeRaftTuning');
    const s = ship();
    const c = initialRaftControls();
    for (let i = 0; i < 5; i++) stepRaftShip(s, c, { speed: 8, direction: 0 }, SIM_DT);
    expect(spy).toHaveBeenCalledTimes(5);
    // flip the switch mid-run: the next tick reads the other set
    const before = raftSailingParams.raftSailingMode.accessible;
    raftSailingParams.raftSailingMode.accessible = !before;
    try {
      stepRaftShip(s, c, { speed: 8, direction: 0 }, SIM_DT);
      expect(spy.mock.results.at(-1)?.value).toBe(
        before ? raftSailingParams.trueRaftTuning : raftSailingParams.accessibleRaftTuning,
      );
    } finally {
      raftSailingParams.raftSailingMode.accessible = before;
    }
  });
});

describe('RaftAction → RaftControls (§V.84, §V.62)', () => {
  const sinks = () => ({ skipToDawn: vi.fn() });

  it('every RaftAction name is handled; an unknown one is refused loudly (false)', () => {
    const c = initialRaftControls();
    for (const a of RAFT_ACTIONS) expect(applyRaftAction(c, a, 0.5, sinks()), a).toBe(true);
    expect(applyRaftAction(c, 'mainsail-reef', 1, sinks())).toBe(false);
  });

  it('tiller → oarAngle clamped −1..1', () => {
    const c = initialRaftControls();
    applyRaftAction(c, 'tiller', 0.3, sinks());
    expect(c.oarAngle).toBe(0.3);
    applyRaftAction(c, 'tiller', 7, sinks());
    expect(c.oarAngle).toBe(1);
    applyRaftAction(c, 'tiller', -7, sinks());
    expect(c.oarAngle).toBe(-1);
    applyRaftAction(c, 'tiller', 'left', sinks());
    expect(c.oarAngle).toBe(-1); // a bad value leaves the helm where it was
  });

  it('guara-N → guaraDepth[N−1] clamped 0..1, and only that board', () => {
    for (let n = 1; n <= 5; n++) {
      const c = initialRaftControls();
      applyRaftAction(c, `guara-${n}`, 0.8, sinks());
      applyRaftAction(c, `guara-${n}`, 1.7, sinks());
      expect(c.guaraDepth[n - 1]).toBe(1);
      applyRaftAction(c, `guara-${n}`, -2, sinks());
      expect(c.guaraDepth[n - 1]).toBe(0);
      for (let k = 0; k < 5; k++) if (k !== n - 1) expect(c.guaraDepth[k]).toBe(0.5);
    }
  });

  it('both sheets → sheet 0..1; halyard > 0.5 hoists, ≤ 0.5 strikes the sail', () => {
    const c = initialRaftControls();
    applyRaftAction(c, 'sheet-p', 0.9, sinks());
    expect(c.sheet).toBe(0.9);
    applyRaftAction(c, 'sheet-s', 3, sinks());
    expect(c.sheet).toBe(1);
    applyRaftAction(c, 'halyard', 0.2, sinks());
    expect(c.sailUp).toBe(false);
    applyRaftAction(c, 'halyard', 0.5, sinks());
    expect(c.sailUp).toBe(false);
    applyRaftAction(c, 'halyard', 0.51, sinks());
    expect(c.sailUp).toBe(true);
  });

  it('sleep → skipToDawn; push-off → pushOff; radio → the tune stub 0..1; chart/ladder/gangways change no control', () => {
    const c = initialRaftControls();
    const s = { ...sinks(), pushOff: vi.fn() };
    const snapshot = JSON.stringify(c);
    applyRaftAction(c, 'sleep', undefined, s);
    expect(s.skipToDawn).toHaveBeenCalledTimes(1);
    applyRaftAction(c, 'push-off', undefined, s);
    expect(s.pushOff).toHaveBeenCalledTimes(1);
    // the sink is optional: a host without beaching wired must not throw
    expect(applyRaftAction(c, 'push-off', undefined, sinks())).toBe(true);
    applyRaftAction(c, 'radio', 0.42, s);
    expect(radio.tune).toBe(0.42);
    applyRaftAction(c, 'radio', 9, s);
    expect(radio.tune).toBe(1);
    for (const a of ['chart', 'ladder', 'gangway-bow', 'gangway-port', 'gangway-starboard', 'gangway-stern']) {
      expect(applyRaftAction(c, a, 1, s)).toBe(true);
    }
    expect(JSON.stringify(c)).toBe(snapshot);
  });

  it('bindRaftActions registers every action on the host and the handlers drive the SAME controls object', () => {
    const handlers = new Map<string, (v: unknown) => void>();
    const host: ActionHost = {
      onAction(name, h) {
        handlers.set(name, h);
        return () => handlers.delete(name);
      },
    };
    const c = initialRaftControls();
    const off = bindRaftActions(host, c, sinks());
    expect([...handlers.keys()].sort()).toEqual([...RAFT_ACTIONS].sort());
    handlers.get('tiller')?.(-0.6);
    handlers.get('guara-5')?.(0.1);
    expect(c.oarAngle).toBe(-0.6);
    expect(c.guaraDepth[4]).toBe(0.1);
    off();
    expect(handlers.size).toBe(0);
  });

  it('debug channels step the same fields by signed deltas, clamped; dawn reaches the clock', () => {
    const c = initialRaftControls();
    const s = sinks();
    applyDebugChannel(c, 'oar', 0.7, s);
    applyDebugChannel(c, 'oar', 0.7, s);
    expect(c.oarAngle).toBe(1);
    applyDebugChannel(c, 'guara-fwd', 0.25, s);
    expect(c.guaraDepth).toEqual([0.75, 0.75, 0.5, 0.5, 0.5]);
    applyDebugChannel(c, 'guara-aft', -1, s);
    expect(c.guaraDepth).toEqual([0.75, 0.75, 0.5, 0, 0]);
    applyDebugChannel(c, 'sheet', 2, s);
    expect(c.sheet).toBe(1);
    applyDebugChannel(c, 'dawn', 1, s);
    expect(s.skipToDawn).toHaveBeenCalledTimes(1);
  });
});

describe('raft SeaPhysicsParams (§T.109: 15 t on a log-radius draft, not the galleon)', () => {
  it('is registered, light, shallow, and floats on her marks (logs half submerged)', () => {
    expect(getParamsEntry('sea-physics-raft')?.params).toBe(raftSeaParams);
    expect(raftSeaParams.hullDraft).toBeLessThan(0.4);
    expect(raftSeaParams.hullDraft).toBeCloseTo(raftParams.logDiameterMax / 2, 9);
    expect(raftSeaParams.mass).toBeGreaterThanOrEqual(10000);
    expect(raftSeaParams.mass).toBeLessThanOrEqual(25000);
    // one mass for buoyancy and beaching, or the sand carries a different raft than the sea does
    expect(raftSeaParams.mass).toBe(raftBeachingParams.mass);
    // m·g/K = draft: the design waterline IS the log axis
    expect(Math.abs(equilibriumDraft(raftSeaParams))).toBeLessThan(0.01);
    expect(raftSeaParams.hullFreeboard).toBeLessThan(0.5);
    // the plan is the raft's, not the galleon's or the brigantine's
    expect(raftSeaParams.hullHalfBeam).toBeCloseTo(raftParams.crossbeamLength / 2, 9);
    expect(raftSeaParams.hullBowZ - raftSeaParams.hullSternZ).toBeCloseTo(raftParams.logCentreLength + raftParams.sternProjection, 9);
    expect(raftSeaParams.inertiaPitch).toBeLessThan(seaPhysicsParams.inertiaPitch / 50);
    expect(raftSeaParams.rollDampingScale).toBeGreaterThan(brigantineSeaParams.rollDampingScale);
    // the sea's own numbers are carried over, not retyped
    expect(raftSeaParams.mirrorResolution).toBe(seaPhysicsParams.mirrorResolution);
    expect(raftSeaParams.smithDepthScale).toBe(seaPhysicsParams.smithDepthScale);
  });
});

describe('beaching through the tick wrapper (§T.109, §T.100)', () => {
  const wind = { speed: 8, direction: 0 };
  /** a beach apron rising toward +z: seabed −3 m at z ≤ 0, up through the waterline at z = 30 */
  const apron = { heightAt: (_x: number, z: number): number => -3 + Math.max(0, z) * 0.1 };
  const deep = { heightAt: (): number => -50 };

  it('stepRaftBeach after stepRaftShip grounds her on a rising beach, HOLDS her, and the sail cannot creep her', () => {
    const s = ship({ position: [0, 0, 0] });
    const holder = { state: neutralRaftBeaching() };
    const c = initialRaftControls();
    c.sheet = 1;
    const points = raftContactPoints();
    expect(points.length).toBeGreaterThan(9);
    let beachedAt = -1;
    for (let i = 0; i < 6000 && beachedAt < 0; i++) {
      stepRaftShip(s, c, wind, SIM_DT);
      const b = stepRaftBeach(s, holder, points, apron, SIM_DT);
      if (b.beach.beached) beachedAt = i;
    }
    expect(beachedAt).toBeGreaterThan(0);
    expect(holder.state.beached).toBe(true);
    expect(holder.state.hold).not.toBeNull();
    const hold = [...s.position] as [number, number, number];
    const yaw = yawOf(s.quaternion);
    // she is in the sand, not out at sea: the log undersides reach the apron
    expect(apron.heightAt(hold[0], hold[2])).toBeGreaterThan(-raftSeaParams.hullDraft - raftBeachingParams.draft - 0.5);
    for (let i = 0; i < 500; i++) {
      stepRaftShip(s, c, wind, SIM_DT);
      stepRaftBeach(s, holder, points, apron, SIM_DT);
    }
    expect(s.position[0]).toBeCloseTo(hold[0], 9);
    expect(s.position[2]).toBeCloseTo(hold[2], 9);
    expect(yawOf(s.quaternion)).toBeCloseTo(yaw, 9);
    expect(Math.hypot(s.velocity[0], s.velocity[2])).toBe(0);
    expect(holder.state.beached).toBe(true);
  });

  it('in deep water nothing happens, and the state object is replaced, not mutated (§V.3)', () => {
    const s = ship({ position: [0, -0.1, 0], velocity: [0, 0, 1.5] });
    const before = neutralRaftBeaching();
    const holder = { state: before };
    const b = stepRaftBeach(s, holder, raftContactPoints(), deep, SIM_DT);
    expect(b.aground).toBe(false);
    expect(holder.state.beached).toBe(false);
    expect(holder.state).not.toBe(before);
    expect(before).toEqual(neutralRaftBeaching());
  });

  it('pushOffRaft backs a beached raft astern and frees the hold; it refuses (writes nothing) afloat', () => {
    const afloat = ship({ velocity: [0, 0, 1] });
    const holder = { state: neutralRaftBeaching() };
    expect(pushOffRaft(afloat, holder)).toBe(false);
    expect(afloat.velocity).toEqual([0, 0, 1]);
    const yaw = 0.7;
    const s = ship({ position: [5, 0, 20], quaternion: quatFromAxisAngle([0, 1, 0], yaw) });
    holder.state = { beached: true, release: 0, hold: [5, 0, 20], holdYaw: yaw };
    expect(pushOffRaft(s, holder)).toBe(true);
    expect(holder.state.beached).toBe(false);
    expect(holder.state.release).toBeCloseTo(raftBeachingParams.pushOffTime, 9);
    const astern = rotateVec(s.quaternion, [0, 0, -1]);
    const v = raftBeachingParams.pushOffSpeed;
    expect(s.velocity[0]).toBeCloseTo(astern[0] * v, 9);
    expect(s.velocity[2]).toBeCloseTo(astern[2] * v, 9);
    expect(yawOf(s.quaternion)).toBeCloseTo(yaw, 9);
  });

  it('the push-off station routes to the pushOff sink, and the entry gates it on raftBeach.state.beached', () => {
    const c = initialRaftControls();
    const s = ship({ position: [0, 0, 0] });
    const sinks = { skipToDawn: vi.fn(), pushOff: () => void pushOffRaft(s, raftBeach) };
    const actionEnabled = (a: string): boolean => a !== 'push-off' || raftBeach.state.beached;
    const saved = raftBeach.state;
    try {
      raftBeach.state = neutralRaftBeaching();
      expect(actionEnabled('push-off')).toBe(false);
      expect(actionEnabled('tiller')).toBe(true);
      applyRaftAction(c, 'push-off', undefined, sinks);
      expect(s.velocity).toEqual([0, 0, 0]); // afloat: the sink is a no-op
      raftBeach.state = { beached: true, release: 0, hold: [0, 0, 0], holdYaw: 0 };
      expect(actionEnabled('push-off')).toBe(true);
      applyRaftAction(c, 'push-off', undefined, sinks);
      expect(raftBeach.state.beached).toBe(false);
      expect(s.velocity[2]).toBeCloseTo(-raftBeachingParams.pushOffSpeed, 9);
    } finally {
      raftBeach.state = saved;
    }
  });
});
