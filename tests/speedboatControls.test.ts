/**
 * SPEEDBOAT CONTROLS (§T.182; design doc §3) — devices → BoatInput → the page seam.
 *
 * WHY these properties:
 *  - §V2: the sim must see ONE input record per fixed tick, a function of what was held/pressed — never of when a
 *    keydown landed inside the frame. A replayed log of BoatInput must reproduce the race, and a tap shorter than a
 *    tick must still count (Surge at 60 Hz is a real tap).
 *  - The design's signs are easy to get backwards (↑ is BOW DOWN; + steer is RIGHT, and HullWater agrees). A sign
 *    slip here is a boat that turns the wrong way or trims the wrong way, silently.
 *  - One key, one meaning after a rebind; deadzones give 0 at rest and full at the stops, with no step off centre.
 *  - The seam adapter must hand the drives EXACTLY the assisted angle (the page multiplies steer back by the lock).
 */
import { describe, expect, it } from 'vitest';
import { assistPreset, TRIM_MAX } from '../src/speedboat/assists';
import {
  BoatInputDevices,
  createMapState,
  createRaceControls,
  DEFAULT_BOAT_BINDINGS,
  DEFAULT_BOAT_CONTROL_OPTIONS,
  deadzone,
  mapBoatInput,
  neutralBoatInput,
  rebindKey,
  shapeAxis,
  type BoatAction,
  type BoatInput,
  type KeySnapshot,
  type PadLike,
} from '../src/speedboat/controls';
import { buildDeepVHull } from '../src/speedboat/hullMesh';
import { HullWater } from '../src/sea-physics/hullWater';
import type { Rigid6State } from '../src/sea-physics/rigidBody';
import type { Quat, Vec3 } from '../src/state/simState';

const DT = 1 / 60;

function key(target: EventTarget, type: 'keydown' | 'keyup', code: string, repeat = false): void {
  const e = new Event(type);
  Object.assign(e, { code, repeat });
  target.dispatchEvent(e);
}

function pad(axes: number[] = [0, 0, 0, 0], pressed: Record<number, number> = {}): PadLike {
  const buttons = Array.from({ length: 17 }, (_, i) => ({ pressed: (pressed[i] ?? 0) > 0.5, value: pressed[i] ?? 0 }));
  return { axes, buttons, connected: true };
}

const snap = (held: BoatAction[] = [], presses: BoatAction[] = []): KeySnapshot => ({
  held: new Set(held),
  presses: new Map(presses.map((a) => [a, 1])),
});

describe('keyboard map (design §3)', () => {
  const fold = (held: BoatAction[]): BoatInput =>
    mapBoatInput(snap(held), null, DEFAULT_BOAT_BINDINGS, DEFAULT_BOAT_CONTROL_OPTIONS, createMapState(), DT);

  it('W/S throttle ahead/astern, A/D steer left/right, ↑ bow DOWN / ↓ bow UP', () => {
    const t = new EventTarget();
    const dev = new BoatInputDevices({ getGamepads: () => null });
    dev.attach(t);
    const read = (code: string): BoatInput => {
      key(t, 'keydown', code);
      const r = { ...dev.sample(DT) };
      key(t, 'keyup', code);
      dev.sample(DT);
      return r;
    };
    expect(read('KeyW').throttle).toBe(1);
    expect(read('KeyS').throttle).toBe(-1);
    expect(read('KeyD').steer).toBe(1);
    expect(read('KeyA').steer).toBe(-1);
    expect(read('ArrowUp').trim).toBe(-1);
    expect(read('ArrowDown').trim).toBe(1);
    expect(read('KeyC').lookBack).toBe(true);
    dev.detach();
    // detached: nothing is heard
    key(t, 'keydown', 'KeyW');
    expect(dev.sample(DT).throttle).toBe(0);
  });

  it('opposing keys cancel; both Shifts are one Surge that stays held until BOTH are up', () => {
    expect(fold(['steerLeft', 'steerRight']).steer).toBe(0);
    const t = new EventTarget();
    const dev = new BoatInputDevices({ getGamepads: () => null });
    dev.attach(t);
    key(t, 'keydown', 'ShiftLeft');
    key(t, 'keydown', 'ShiftRight');
    key(t, 'keyup', 'ShiftLeft');
    expect(dev.sample(DT).surge).toBe(true);
    key(t, 'keyup', 'ShiftRight');
    expect(dev.sample(DT).surge).toBe(false);
  });

  it('a tap between two ticks is not lost: Surge, camera and pause each fire on the next tick, once', () => {
    const t = new EventTarget();
    const dev = new BoatInputDevices({ getGamepads: () => null });
    dev.attach(t);
    for (const code of ['ShiftLeft', 'KeyV', 'Escape']) {
      key(t, 'keydown', code);
      key(t, 'keyup', code);
    }
    const a = dev.sample(DT);
    expect([a.surge, a.cameraCycle, a.pause]).toEqual([true, true, true]);
    const b = dev.sample(DT);
    expect([b.surge, b.cameraCycle, b.pause]).toEqual([false, false, false]);
    // key repeat is not a new press
    key(t, 'keydown', 'KeyV');
    dev.sample(DT);
    key(t, 'keydown', 'KeyV', true);
    expect(dev.sample(DT).cameraCycle).toBe(false);
  });

  it('reset fires once, on the tick the 1 s hold completes, and not again until released', () => {
    const st = createMapState();
    const fired: number[] = [];
    let hold = 0;
    for (let k = 0; k < 150; k++) {
      const r = mapBoatInput(snap(k < 120 ? ['reset'] : []), null, DEFAULT_BOAT_BINDINGS, DEFAULT_BOAT_CONTROL_OPTIONS, st, DT);
      if (r.reset) fired.push(k);
      if (k === 29) hold = r.resetHold;
    }
    expect(fired).toEqual([59]);
    expect(hold).toBeCloseTo(0.5, 6);
  });

  it('window blur releases every held key (no throttle stuck open behind an alt-tab)', () => {
    const t = new EventTarget();
    const dev = new BoatInputDevices({ getGamepads: () => null });
    dev.attach(t);
    key(t, 'keydown', 'KeyW');
    t.dispatchEvent(new Event('blur'));
    expect(dev.sample(DT).throttle).toBe(0);
  });
});

describe('rebinding', () => {
  it('a rebound key leaves the action it came from and reports it', () => {
    const { bindings, displaced } = rebindKey(DEFAULT_BOAT_BINDINGS, 'surge', 'KeyW', true);
    expect(bindings.keys.surge).toEqual(['KeyW']);
    expect(bindings.keys.throttle).toEqual([]);
    expect(displaced).toEqual(['throttle']);
    // the default map is not mutated
    expect(DEFAULT_BOAT_BINDINGS.keys.throttle).toEqual(['KeyW']);
    const t = new EventTarget();
    const dev = new BoatInputDevices({ bindings, getGamepads: () => null });
    dev.attach(t);
    key(t, 'keydown', 'KeyW');
    const r = dev.sample(DT);
    expect(r.surge).toBe(true);
    expect(r.throttle).toBe(0);
  });
});

describe('gamepad (standard mapping)', () => {
  const opt = DEFAULT_BOAT_CONTROL_OPTIONS;
  const read = (p: PadLike, o = opt): BoatInput => mapBoatInput(snap(), p, DEFAULT_BOAT_BINDINGS, o, createMapState(), DT);

  it('deadzone: 0 at rest and inside it, continuous from 0 just outside it, ±1 at the stops', () => {
    expect(deadzone(0.1, 0.12)).toBe(0);
    expect(deadzone(0.1201, 0.12)).toBeLessThan(1e-3);
    expect(deadzone(-1, 0.12)).toBe(-1);
    expect(shapeAxis(1, 0.12, 1.5)).toBe(1);
    expect(shapeAxis(Number.NaN, 0.12, 1.5)).toBe(0);
    // monotone
    let prev = -Infinity;
    for (let v = -1; v <= 1; v += 0.01) {
      const s = shapeAxis(v, 0.12, 1.5);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
    // a resting stick drifting inside its deadzone does nothing
    expect(read(pad([0.08, 0, 0, -0.2])).steer).toBe(0);
  });

  it('RT ahead, LT astern, left stick steer (right = +), right stick pulled back = bow up; invert flips only the stick', () => {
    expect(read(pad([0, 0, 0, 0], { 7: 1 })).throttle).toBe(1);
    expect(read(pad([0, 0, 0, 0], { 6: 1 })).throttle).toBe(-1);
    expect(read(pad([1, 0, 0, 0])).steer).toBe(1);
    expect(read(pad([0, 0, 0, 1])).trim).toBe(1);
    expect(read(pad([0, 0, 0, 1]), { ...opt, invertTrim: true }).trim).toBe(-1);
    // keys are never inverted
    const k = mapBoatInput(snap(['trimBowUp']), null, DEFAULT_BOAT_BINDINGS, { ...opt, invertTrim: true }, createMapState(), DT);
    expect(k.trim).toBe(1);
  });

  it('pad buttons: camera fires on the press edge only; Surge and look back read held', () => {
    const st = createMapState();
    const s1 = mapBoatInput(snap(), pad([0, 0, 0, 0], { 3: 1, 0: 1 }), DEFAULT_BOAT_BINDINGS, opt, st, DT);
    const s2 = mapBoatInput(snap(), pad([0, 0, 0, 0], { 3: 1, 0: 1, 11: 1 }), DEFAULT_BOAT_BINDINGS, opt, st, DT);
    expect([s1.cameraCycle, s2.cameraCycle]).toEqual([true, false]);
    expect([s1.surge, s2.surge]).toEqual([true, true]);
    expect(s2.lookBack).toBe(true);
  });
});

describe('determinism (§V2)', () => {
  it('the same key/pad schedule gives the same BoatInput sequence however events fall inside each tick', () => {
    const schedule = (k: number): { codes: string[]; p: PadLike } => ({
      codes: [k % 40 < 20 ? 'KeyW' : '', k % 90 < 30 ? 'KeyD' : '', k % 120 === 7 ? 'ShiftLeft' : ''].filter(Boolean),
      p: pad([Math.sin(k * 0.05), 0, 0, Math.cos(k * 0.03)], { 7: (k % 50) / 50 }),
    });
    const run = (split: boolean): BoatInput[] => {
      const t = new EventTarget();
      let current = pad();
      const dev = new BoatInputDevices({ getGamepads: () => [null, current] });
      dev.attach(t);
      const held = new Set<string>();
      const out: BoatInput[] = [];
      for (let k = 0; k < 400; k++) {
        const { codes, p } = schedule(k);
        const want = new Set(codes);
        // releases and presses delivered either all at once or interleaved with repeats
        for (const c of [...held]) if (!want.has(c)) {
          key(t, 'keyup', c);
          held.delete(c);
        }
        for (const c of want) {
          if (!held.has(c)) key(t, 'keydown', c);
          else if (split) key(t, 'keydown', c, true);
          held.add(c);
        }
        if (want.has('ShiftLeft')) {
          key(t, 'keyup', 'ShiftLeft');
          held.delete('ShiftLeft');
        }
        current = p;
        out.push({ ...dev.sample(DT) });
      }
      return out;
    };
    expect(run(true)).toEqual(run(false));
  });
});

describe('page seam adapter (createRaceControls → ControlSource)', () => {
  const hull = buildDeepVHull();
  const boat = (speed: number): Rigid6State => ({
    position: [0, 0.35, 0] as Vec3,
    quaternion: [0, 0, 0, 1] as Quat,
    velocity: [0, 0, speed] as Vec3,
    angularVelocity: [0, 0, 0] as Vec3,
  });

  it('hands the drives exactly the assisted angle (seam steer × lock), + = right, and the lock closes with speed', () => {
    const hw = new HullWater(hull);
    hw.samplePatch(() => 0, boat(42), DT);
    hw.evaluate(boat(42), DT / 2);
    const t = new EventTarget();
    const cam = { inputs: 0, pilotInput: () => cam.inputs++ };
    const rc = createRaceControls({ player: { hw, hull }, devices: (() => { const d = new BoatInputDevices({ getGamepads: () => null }); d.attach(t); return d; })(), camera: cam });
    key(t, 'keydown', 'KeyD');
    key(t, 'keydown', 'KeyW');
    let c = rc.sample(DT, boat(42));
    for (let k = 0; k < 120; k++) c = rc.sample(DT, boat(42));
    const lock = hull.drives[0].maxSteerRad;
    expect(c.steer * lock).toBeCloseTo(rc.command.steerRad, 12);
    expect(c.steer).toBeGreaterThan(0);
    // 42 m/s: the default curve's 12°, of a 30° drive lock
    expect((c.steer * lock * 180) / Math.PI).toBeCloseTo(12, 6);
    expect(c.throttle).toBe(1);
    expect(cam.inputs).toBe(121);
    // Pro: the whole drive lock
    rc.settings = assistPreset('pro');
    for (let k = 0; k < 120; k++) c = rc.sample(DT, boat(42));
    expect(c.steer).toBeCloseTo(1, 12);
  });

  it('trim reaches the seam normalised (−1 at −6°, +1 at +8°); disabled input goes neutral, not stale', () => {
    const hw = new HullWater(hull);
    hw.samplePatch(() => 0, boat(20), DT);
    hw.evaluate(boat(20), DT / 2);
    const t = new EventTarget();
    let enabled = true;
    const d = new BoatInputDevices({ getGamepads: () => null });
    d.attach(t);
    const rc = createRaceControls({ player: { hw, hull }, devices: d, enabled: () => enabled, settings: { ...assistPreset('default'), landingAssist: 0 } });
    key(t, 'keydown', 'ArrowDown');
    let c = rc.sample(DT, boat(20));
    for (let k = 0; k < 180; k++) c = rc.sample(DT, boat(20));
    expect(c.trim).toBeCloseTo(1, 12);
    expect(rc.command.trimRad).toBeCloseTo(TRIM_MAX, 12);
    key(t, 'keydown', 'KeyD');
    enabled = false;
    c = rc.sample(DT, boat(20));
    expect(rc.input).toEqual(neutralBoatInput());
    // the persistent trim setpoint stays where the pilot left it
    expect(c.trim).toBeCloseTo(1, 12);
  });
});
