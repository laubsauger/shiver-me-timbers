/**
 * §T.150 / §T.103 — THE RADIO.
 *
 * Three layers, three kinds of assertion:
 *
 *  1. §V86 — the TUNER is a pure function of (freq, heading, dist, night), so
 *     everything about it is a PROPERTY of numbers (§V80): clarity peaks on
 *     station, strength falls with distance, the cardioid is monotone toward
 *     the bearing, the lock needs dwell and releases with hysteresis, night
 *     doubles the range, NaN never gets in, and the same inputs give the same
 *     answer twice.
 *  2. §V87 — the CONTENT is a manifest. A fourth station is a data edit.
 *  3. §B100 — a control is only wired if the WORLD moved. So the last block
 *     drives the REAL interact path at the REAL `station-radio` socket on the
 *     REAL blueprint, and asserts three things downstream of it: the tuner's
 *     frequency changed, the needle PIECE turned, and the audio adapter wrote
 *     to its gain, filter and playback-rate nodes. Asserting that a handler is
 *     registered is what §B100 says is not enough, twice over.
 */
import { describe, expect, it } from 'vitest';
import { compassOffsetPx } from '../src/ui/hud';
import * as THREE from 'three';
import type { Material } from 'three';
import { radioParams, type RadioParams } from '../src/params/radio';
import {
  bearingTo,
  bindStations,
  cardioid,
  clarityOf,
  createRadioRuntime,
  dialFrequency,
  falloff,
  frequencyChannel,
  halfRange,
  LOCK_CHIME,
  NO_LOCK,
  RADIO_STATIONS,
  radioClips,
  readTuner,
  stationSignal,
  stepLock,
  wrapAngle,
  type LockState,
  type RadioStation,
  type RadioStationDef,
} from '../src/radio';
import { NO_FRAGMENT, radioMix, stepFragments } from '../src/radio/radioMix';
import { createRaftRadio, isRadioNight, radioBearings } from '../src/raft/raftRadio';
import { radio, raftControls, applyRaftAction } from '../src/raft/raftActions';
import { createInteract } from '../src/player/interact';
import { RAFT_STATIONS } from '../src/player/stations';
import { buildRaftBlueprint } from '../src/ship/raftBlueprint';
import { ShipAssembly } from '../src/ship/shipAssembly';
import { playerParams } from '../src/params/player';
import type { PlayerState } from '../src/player/playerStep';

const P = radioParams;
const DT = 1 / 60;
const AT_ORIGIN: RadioStation = { id: 'a', freqMHz: 7, x: 0, z: 0 };

// ---------------------------------------------------------------------------
// 1 · §V86 the tuner
// ---------------------------------------------------------------------------

describe('§V86 the tuner is a pure function of (freq, heading, dist, night)', () => {
  it('clarity PEAKS on the station and falls away either side, and is exactly 0 outside the window', () => {
    // the property, not the curve (§V80): a wider window, a squarer shape or a
    // different hump are all legitimate moves that must not fail this
    expect(clarityOf(0)).toBeCloseTo(1, 9);
    let previous = clarityOf(0);
    for (let k = 1; k <= 40; k++) {
      const d = (P.channelWidth * k) / 40;
      const c = clarityOf(d);
      expect(c, `clarity rose again at Δf ${d}`).toBeLessThanOrEqual(previous + 1e-12);
      expect(clarityOf(-d), 'the window is not symmetric').toBeCloseTo(c, 12);
      previous = c;
    }
    // A STATION YOU HAVE DRIFTED OFF IS GONE, NOT QUIET. Without this the dial
    // is a slider with a bias and finding a voice is not a search.
    for (const d of [P.channelWidth, P.channelWidth * 1.001, P.channelWidth * 4, 1e6]) {
      expect(clarityOf(d), `still audible ${d} MHz off station`).toBe(0);
    }
  });

  it('strength falls with distance, monotonically, and never turns negative', () => {
    let previous = falloff(0, false);
    expect(previous).toBeCloseTo(1, 9);
    for (let k = 1; k <= 200; k++) {
      const d = k * 120;
      const f = falloff(d, false);
      expect(f, `signal rose at ${d} m`).toBeLessThan(previous);
      expect(f).toBeGreaterThan(0);
      previous = f;
    }
    // half signal at the half-range, which is what the parameter NAMES
    expect(falloff(halfRange(false), false)).toBeCloseTo(0.5, 9);
  });

  it('§V86 night DOUBLES the range: the distance at which a station still locks scales with nightRangeMult', () => {
    expect(halfRange(true) / halfRange(false)).toBeCloseTo(P.nightRangeMult, 9);
    // and it is a range multiplier, not a gain one: the day curve read at d is
    // the night curve read at d × mult, at every distance
    for (const d of [100, 800, 2600, 9000]) {
      expect(falloff(d, false)).toBeCloseTo(falloff(d * P.nightRangeMult, true), 9);
    }
    // the thing a player experiences: a station too far to lock by day locks at night
    const far = halfRange(false) * 1.6;
    const day = stationSignal(AT_ORIGIN, { freqMHz: 7, x: 0, z: far, headingRad: Math.PI, night: false });
    const night = stationSignal(AT_ORIGIN, { freqMHz: 7, x: 0, z: far, headingRad: Math.PI, night: true });
    expect(day.signal).toBeLessThan(P.lockThreshold);
    expect(night.signal).toBeGreaterThan(P.lockThreshold);
  });

  it('the cardioid is MONOTONE toward the station — swinging the bow at a voice never makes it quieter', () => {
    // the aerial runs fore-and-aft along the mast, so this is the skill the
    // design doc puts in place of a quest marker
    let previous = cardioid(Math.PI);
    for (let k = 1; k <= 90; k++) {
      const rel = Math.PI * (1 - k / 90);
      const g = cardioid(rel);
      expect(g, `turning toward the station lost signal at rel ${rel}`).toBeGreaterThanOrEqual(previous - 1e-12);
      expect(cardioid(-rel), 'the pattern is not symmetric about the bow').toBeCloseTo(g, 12);
      previous = g;
    }
    expect(cardioid(0)).toBeGreaterThan(cardioid(Math.PI));
    // …and it is the DEPTH that owns how directional it is (§V62: the knob drives it)
    expect(cardioid(Math.PI, { ...P, cardioidDepth: 0 })).toBeCloseTo(cardioid(0, { ...P, cardioidDepth: 0 }), 12);
  });

  it('and the whole signal is monotone in heading through the real station-signal path', () => {
    const st: RadioStation = { id: 'a', freqMHz: 7, x: 1400, z: 0 };
    const bearing = bearingTo(0, 0, st.x, st.z);
    let previous = -1;
    for (let k = 0; k <= 60; k++) {
      const heading = wrapAngle(bearing + Math.PI * (1 - k / 60));
      const s = stationSignal(st, { freqMHz: 7, x: 0, z: 0, headingRad: heading, night: false });
      expect(s.signal).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = s.signal;
    }
  });

  it('the dial maps the 0..1 channel onto the band, and back again', () => {
    expect(dialFrequency(0)).toBeCloseTo(P.bandLowMHz, 9);
    expect(dialFrequency(1)).toBeCloseTo(P.bandHighMHz, 9);
    for (const c of [0, 0.13, 0.5, 0.77, 1]) {
      expect(frequencyChannel(dialFrequency(c))).toBeCloseTo(c, 9);
    }
    // the readout the player sees and the physics the tuner runs are the SAME
    // map, which is the only reason a number on screen means anything (§V37)
    expect(dialFrequency(1.4)).toBeCloseTo(P.bandHighMHz, 9);
    expect(dialFrequency(-3)).toBeCloseTo(P.bandLowMHz, 9);
  });
});

describe('§V86 the lock needs dwell and lets go with hysteresis', () => {
  const hold = (signal: number, seconds: number, from: LockState = NO_LOCK, p: RadioParams = P): LockState => {
    let s = from;
    const steps = Math.round(seconds / DT);
    for (let i = 0; i < steps; i++) {
      s = stepLock(s, { id: 'a', clarity: 1, strength: signal, signal, distance: 0, bearingRad: 0 }, DT, p).state;
    }
    return s;
  };

  it('DWELL: a strong station does not lock instantly — it locks after lockDwellSec', () => {
    const strong = P.lockThreshold + 0.3;
    expect(hold(strong, P.lockDwellSec * 0.5).locked, 'locked before the dwell was up').toBeNull();
    expect(hold(strong, P.lockDwellSec * 0.9).locked).toBeNull();
    expect(hold(strong, P.lockDwellSec + 0.2).locked).toBe('a');
  });

  it('DWELL RESETS if it drops out: a station tapped past twice does not add up to a lock', () => {
    let s = hold(P.lockThreshold + 0.3, P.lockDwellSec * 0.7);
    s = hold(0, 0.2, s); // swept off it
    s = hold(P.lockThreshold + 0.3, P.lockDwellSec * 0.7, s);
    expect(s.locked, 'two half-dwells added up to a lock').toBeNull();
  });

  it('HYSTERESIS: a locked station rides out a dip below the threshold, and only lets go below θ − h', () => {
    const locked = hold(P.lockThreshold + 0.3, P.lockDwellSec + 0.2);
    expect(locked.locked).toBe('a');
    // the dip a passing wave or a yaw oscillation puts in the signal
    const dipped = hold(P.lockThreshold - P.lockHysteresis * 0.5, 3, locked);
    expect(dipped.locked, 'the lock chattered off inside the hysteresis band').toBe('a');
    const dropped = stepLock(dipped, { id: 'a', clarity: 1, strength: 0, signal: P.lockThreshold - P.lockHysteresis * 1.5, distance: 0, bearingRad: 0 }, DT, P);
    expect(dropped.state.locked).toBeNull();
    expect(dropped.lost).toBe('a');
  });

  it('`gained` fires on the ONE step the lock happens, not on every step after it', () => {
    let s = NO_LOCK;
    const best = { id: 'a', clarity: 1, strength: 1, signal: 1, distance: 0, bearingRad: 0 };
    let gains = 0;
    for (let i = 0; i < Math.round((P.lockDwellSec + 3) / DT); i++) {
      const step = stepLock(s, best, DT, P);
      s = step.state;
      if (step.gained !== null) gains++;
    }
    expect(gains, 'the chime would have played every frame').toBe(1);
  });

  it('a second station cannot steal a lock while the first still holds', () => {
    const locked = hold(1, P.lockDwellSec + 0.2);
    const step = stepLock(locked, { id: 'b', clarity: 1, strength: 1, signal: 1, distance: 0, bearingRad: 0 }, DT, P);
    expect(step.state.locked).toBeNull(); // 'a' fell to 0 → it releases
    expect(step.lost).toBe('a');
    expect(step.gained).toBeNull(); // …and 'b' still has to serve its own dwell
  });
});

describe('§V28 the tuner is NaN-safe and deterministic', () => {
  it('every reading is finite even when the raft hands it garbage', () => {
    const junk = [NaN, Infinity, -Infinity];
    for (const bad of junk) {
      for (const input of [
        { freqMHz: bad, x: 0, z: 0, headingRad: 0, night: false },
        { freqMHz: 7, x: bad, z: 0, headingRad: 0, night: false },
        { freqMHz: 7, x: 0, z: bad, headingRad: 0, night: false },
        { freqMHz: 7, x: 0, z: 0, headingRad: bad, night: false },
      ]) {
        const r = readTuner([AT_ORIGIN], input);
        expect(Number.isFinite(r.signal), `signal from ${JSON.stringify(input)}`).toBe(true);
        expect(Number.isFinite(r.best!.clarity)).toBe(true);
        expect(Number.isFinite(r.best!.strength)).toBe(true);
      }
    }
    expect(Number.isFinite(dialFrequency(NaN))).toBe(true);
    expect(Number.isFinite(clarityOf(NaN))).toBe(true);
    expect(Number.isFinite(cardioid(NaN))).toBe(true);
    expect(Number.isFinite(falloff(NaN, false))).toBe(true);
  });

  it('a NaN frame cannot poison a lock so it never clears again', () => {
    // WHY THIS EXACT TEST: `signal > threshold` is FALSE for NaN and so is
    // `signal < release`, so a NaN leaking into the lock would freeze it
    // wherever it stood — silent, errorless, and permanent.
    let s = NO_LOCK;
    for (let i = 0; i < 200; i++) {
      s = stepLock(s, { id: 'a', clarity: 1, strength: 1, signal: 1, distance: 0, bearingRad: 0 }, DT, P).state;
    }
    expect(s.locked).toBe('a');
    const bad = readTuner([AT_ORIGIN], { freqMHz: NaN, x: NaN, z: 0, headingRad: NaN, night: false });
    s = stepLock(s, bad.best, DT, P).state;
    expect(s.locked, 'a NaN frame froze the lock on').toBeNull();
  });

  it('DETERMINISTIC: the same inputs give the same numbers, with no clock and no rng', () => {
    const input = { freqMHz: 6.83, x: 412, z: -900, headingRad: 1.1, night: true };
    const stations = bindStations((k) => ({ x: k * 1000, z: k * -700 }));
    expect(JSON.stringify(readTuner(stations, input))).toBe(JSON.stringify(readTuner(stations, input)));
    const a = createRadioRuntime();
    const b = createRadioRuntime();
    a.setStations(stations);
    b.setStations(stations);
    for (let i = 0; i < 500; i++) {
      const step = { channel: (i % 100) / 100, x: i, z: -i, headingRad: i * 0.01, night: i > 250, dt: DT };
      expect(JSON.stringify(a.step(step))).toBe(JSON.stringify(b.step(step)));
    }
  });
});

// ---------------------------------------------------------------------------
// 2 · §V87 the content is a manifest
// ---------------------------------------------------------------------------

describe('§V87 the radio content is a manifest, not code', () => {
  it('every station sits inside the band, on its own frequency, and names real clips', () => {
    const seen = new Set<string>();
    for (const d of RADIO_STATIONS) {
      expect(d.freqMHz, `${d.id} below the band`).toBeGreaterThanOrEqual(P.bandLowMHz);
      expect(d.freqMHz, `${d.id} above the band`).toBeLessThanOrEqual(P.bandHighMHz);
      expect(seen.has(d.id), `duplicate station id ${d.id}`).toBe(false);
      seen.add(d.id);
      expect(d.fragments.length, `${d.id} has nothing to say`).toBeGreaterThan(0);
      expect(d.night.length, `${d.id} has no night callback`).toBeGreaterThan(0);
    }
    for (const clip of radioClips()) {
      expect(clip.src, `${clip.title} is not an mp3`).toMatch(/\.mp3(\?|$)/);
      expect(clip.durationSec).toBeGreaterThan(0);
      expect(clip.credit.length).toBeGreaterThan(0);
    }
    expect(radioClips()).toContain(LOCK_CHIME);
  });

  it('§V87 TWO STATIONS ARE NEVER CLOSER THAN A WINDOW: each is findable on its own', () => {
    // the property that makes the dial a map: if two stations shared a window
    // you could never separate them, and the "signal" would be whichever the
    // array order happened to put first
    const sorted = [...RADIO_STATIONS].sort((a, b) => a.freqMHz - b.freqMHz);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].freqMHz - sorted[i - 1].freqMHz,
        `${sorted[i - 1].id} and ${sorted[i].id} share a tuning window`).toBeGreaterThan(P.channelWidth);
    }
  });

  it('A FOURTH STATION IS A DATA EDIT: it tunes, locks and speaks with zero code changes', () => {
    const extra: RadioStationDef = {
      id: 'synthetic',
      title: 'a fourth teaching',
      freqMHz: (P.bandLowMHz + P.bandHighMHz) / 2,
      site: 3,
      fragments: [{ src: 'x/one.mp3', durationSec: 1, title: 'one', credit: 'test' }],
      night: [{ src: 'x/night.mp3', durationSec: 1, title: 'night', credit: 'test' }],
    };
    const defs = [...RADIO_STATIONS, extra];
    const rt = createRadioRuntime(defs);
    rt.setStations(bindStations(() => ({ x: 0, z: 0 }), defs));
    expect(rt.stations().some((s) => s.id === 'synthetic')).toBe(true);
    let snap = rt.step({ channel: frequencyChannel(extra.freqMHz), x: 0, z: 0, headingRad: 0, night: false, dt: DT });
    expect(snap.best?.id).toBe('synthetic');
    for (let i = 0; i < Math.round((P.lockDwellSec + 0.5) / DT); i++) {
      snap = rt.step({ channel: frequencyChannel(extra.freqMHz), x: 0, z: 0, headingRad: 0, night: false, dt: DT });
    }
    expect(snap.locked).toBe('synthetic');
    expect(rt.clipOf('synthetic', 0, false)).toBe('x/one.mp3');
    expect(rt.clipOf('synthetic', 0, true), 'the night pool is the one that plays after dusk').toBe('x/night.mp3');
  });

  it('a station whose island the archipelago does not have is DROPPED, not parked at the origin', () => {
    // a voice broadcasting from (0,0) is a bug that sounds like a feature
    expect(bindStations(() => null)).toHaveLength(0);
    expect(bindStations((k) => (k === 0 ? { x: 10, z: 10 } : null))).toHaveLength(1);
    expect(bindStations(() => ({ x: NaN, z: 0 }))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3 · the mix and the fragment pool
// ---------------------------------------------------------------------------

describe('§T.150c the static changes CHARACTER with the tuning, and never goes silent', () => {
  it('level falls, tone closes down and pitch drags as a station comes up', () => {
    const off = radioMix(0, true);
    const on = radioMix(1, true);
    expect(on.staticGain, 'the static did not step back for the station').toBeLessThan(off.staticGain);
    expect(on.staticHz, 'the hiss did not close onto the voice band').toBeLessThan(off.staticHz);
    expect(on.staticRate, 'the pitch did not drag').toBeLessThan(off.staticRate);
    expect(on.voiceGain).toBeGreaterThan(off.voiceGain);
    // A SILENT RADIO READS AS A BROKEN RADIO
    expect(on.staticGain).toBeGreaterThan(0);
    // and it is monotone across the sweep, so a player hears himself getting warmer
    let prevGain = off.staticGain;
    let prevHz = off.staticHz;
    for (let k = 1; k <= 50; k++) {
      const m = radioMix(k / 50, true);
      expect(m.staticGain).toBeLessThanOrEqual(prevGain + 1e-12);
      expect(m.staticHz).toBeLessThanOrEqual(prevHz + 1e-9);
      prevGain = m.staticGain;
      prevHz = m.staticHz;
    }
    for (const v of Object.values(radioMix(NaN, true))) expect(Number.isFinite(v)).toBe(true);
  });

  it('a locked station speaks AT ONCE and then every fragmentGapSec, cycling its pool', () => {
    let s = NO_FRAGMENT;
    const heard: number[] = [];
    for (let i = 0; i < Math.round(30 / DT); i++) {
      const step = stepFragments(s, 'a', 2, DT);
      s = step.state;
      if (step.play !== null) heard.push(step.play);
    }
    expect(heard[0], 'the reward for finding it did not arrive').toBe(0);
    expect(heard.length).toBe(1 + Math.floor(30 / P.fragmentGapSec));
    expect(heard.slice(0, 4)).toEqual([0, 1, 0, 1]); // it cycles, it does not repeat one
    // and nothing plays while nothing is locked
    expect(stepFragments(NO_FRAGMENT, null, 2, DT).play).toBeNull();
    expect(stepFragments(NO_FRAGMENT, 'a', 0, DT).play).toBeNull();
  });

  it('night is dusk to dawn, and it is what opens the night pool', () => {
    expect(isRadioNight(21)).toBe(true);
    expect(isRadioNight(2)).toBe(true);
    expect(isRadioNight(12)).toBe(false);
    expect(isRadioNight(NaN)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4 · §B100 — the world moved
// ---------------------------------------------------------------------------

/** the smallest WebAudio that `createPanner` + `createLoopLayer` + `playSample` actually touch */
interface StubParam { value: number; writes: number }
function stubParam(v = 0): StubParam & Record<string, unknown> {
  const p = {
    value: v,
    writes: 0,
    setTargetAtTime(t: number): void { p.value = t; p.writes++; },
    setValueAtTime(t: number): void { p.value = t; p.writes++; },
    linearRampToValueAtTime(t: number): void { p.value = t; p.writes++; },
    cancelScheduledValues(): void { /* no-op */ },
  };
  return p as unknown as StubParam & Record<string, unknown>;
}

function stubContext(): {
  ctx: BaseAudioContext;
  gains: Array<ReturnType<typeof stubParam>>;
  filters: Array<{ frequency: ReturnType<typeof stubParam> }>;
  sources: Array<{ playbackRate: ReturnType<typeof stubParam>; started: number }>;
  panners: Array<{ positionX: ReturnType<typeof stubParam>; positionY: ReturnType<typeof stubParam>; positionZ: ReturnType<typeof stubParam> }>;
} {
  const gains: Array<ReturnType<typeof stubParam>> = [];
  const filters: Array<{ frequency: ReturnType<typeof stubParam> }> = [];
  const sources: Array<{ playbackRate: ReturnType<typeof stubParam>; started: number }> = [];
  const panners: Array<{ positionX: ReturnType<typeof stubParam>; positionY: ReturnType<typeof stubParam>; positionZ: ReturnType<typeof stubParam> }> = [];
  const node = (extra: Record<string, unknown>): Record<string, unknown> => ({
    connect(out: unknown) { return out; },
    disconnect() { /* no-op */ },
    ...extra,
  });
  const ctx = {
    currentTime: 0,
    sampleRate: 32000,
    createGain() {
      const gain = stubParam(0);
      gains.push(gain);
      return node({ gain });
    },
    createBiquadFilter() {
      const f = { frequency: stubParam(20000), Q: stubParam(1), type: 'lowpass' };
      filters.push(f);
      return node(f);
    },
    createBufferSource() {
      const s = { playbackRate: stubParam(1), started: 0, buffer: null as unknown, loop: false, loopStart: 0, loopEnd: 0 };
      sources.push(s);
      return node({
        ...s,
        get playbackRate() { return s.playbackRate; },
        set buffer(b: unknown) { s.buffer = b; },
        set loop(v: boolean) { s.loop = v; },
        set loopStart(v: number) { s.loopStart = v; },
        set loopEnd(v: number) { s.loopEnd = v; },
        start() { s.started++; },
        stop() { /* no-op */ },
      });
    },
    createPanner() {
      const p = { positionX: stubParam(), positionY: stubParam(), positionZ: stubParam() };
      panners.push(p);
      return node({ ...p, panningModel: '', distanceModel: '', refDistance: 0, maxDistance: 0, rolloffFactor: 0 });
    },
    createBuffer(_ch: number, len: number, rate: number) {
      return { duration: len / rate, sampleRate: rate, length: len, getChannelData: () => new Float32Array(len) };
    },
  };
  return { ctx: ctx as unknown as BaseAudioContext, gains, filters, sources, panners };
}

describe('§B100 the dial drives the world, not a number', () => {
  const stubFactory = () => ({ dispose(): void {} }) as unknown as Material;
  const EYE = playerParams.standHeight - playerParams.eyeDrop;

  /** the REAL interact path, focused on the REAL `station-radio` socket */
  function gripTheDial(): { ix: ReturnType<typeof createInteract>; log: Array<[string, unknown]> } {
    const asm = new ShipAssembly(buildRaftBlueprint(), stubFactory);
    asm.group.updateMatrixWorld(true);
    const socket = asm.socketWorldPosition(RAFT_STATIONS.radio.socket);
    const pos: [number, number, number] = [socket[0] + 0.35, socket[1] - EYE + 0.4, socket[2] + 0.35];
    const state: PlayerState = {
      pos, yaw: Math.atan2(socket[0] - pos[0], socket[2] - pos[2]), pitch: -0.2,
      vel: [0, 0, 0], grounded: true, crouch: 1, frame: 'ship',
    } as unknown as PlayerState;
    const log: Array<[string, unknown]> = [];
    const ix = createInteract(
      {
        state,
        setState: () => undefined,
        applyAction: (name, value) => {
          log.push([name, value]);
          return applyRaftAction(raftControls, name, value, { skipToDawn: () => undefined });
        },
      },
      { socketWorld: (id) => { try { return asm.socketWorldPosition(id) as [number, number, number]; } catch { return null; } } },
    );
    // §V71: focus through the live assembly, exactly as the game does
    expect(ix.focus(), 'the radio is not the station in front of a player at station-radio').toBe('radio');
    ix.begin();
    expect(ix.held()).toBe('radio');
    return { ix, log };
  }

  it('turning the knob moves the CHANNEL, the FREQUENCY, and the audio-facing mix', () => {
    const { ix, log } = gripTheDial();
    // wind it to the bottom of the band, then sweep up — mouse RIGHT is tune up
    for (let i = 0; i < 400; i++) ix.step(DT, { yawDelta: 0.05, pitchDelta: 0 });
    expect(radio.tune).toBe(0);
    const low = radio.tune;
    for (let i = 0; i < 200; i++) ix.step(DT, { yawDelta: -0.05, pitchDelta: 0 });
    ix.end();
    expect(radio.tune, 'the knob turned and the store did not').toBeGreaterThan(low);
    expect(log.some(([n]) => n === 'radio'), 'the real interact path never published `radio`').toBe(true);
    // the frequency the tuner will run on, not just a 0..1 number
    expect(dialFrequency(radio.tune)).toBeGreaterThan(dialFrequency(low));
    expect(dialFrequency(radio.tune)).toBeLessThanOrEqual(P.bandHighMHz);
  });

  it('and the whole chain moves: needle piece turns, and the REAL audio adapter writes gain, cutoff and rate', () => {
    const asm = new ShipAssembly(buildRaftBlueprint(), stubFactory);
    asm.group.updateMatrixWorld(true);
    const { ctx, gains, filters, sources, panners } = stubContext();
    let attached: { update(dt: number): void; dispose(): void } | null = null;
    const audio = {
      attach(make: (c: BaseAudioContext, b: { ambience: AudioNode; music: AudioNode; sfx: AudioNode }) => typeof attached) {
        const bus = { connect: () => undefined, disconnect: () => undefined } as unknown as AudioNode;
        attached = make(ctx, { ambience: bus, music: bus, sfx: bus });
        return () => { attached = null; };
      },
    } as unknown as Parameters<typeof createRaftRadio>[0]['audio'];
    // the station is dead ahead and close, so a sweep across the band must
    // cross it — the world the tuner is being asked about is a real one
    const target = RADIO_STATIONS[0];
    const sierra = {
      sites: [{ position: [0, 900] }, { position: [4000, 0] }, { position: [-4000, 0] }],
      order: [0, 1, 2],
    } as unknown as Parameters<typeof createRaftRadio>[0]['sierra'];
    const set = createRaftRadio({ audio, assembly: asm, sierra });
    expect(attached, 'the radio never joined the one audio graph (§V95)').not.toBeNull();
    expect(panners.length, 'no HRTF emitter was made').toBeGreaterThanOrEqual(2);
    expect(sources.length, 'the static bed never started').toBeGreaterThanOrEqual(1);

    const needle = asm.group.getObjectByName('radio-needle') as THREE.Object3D;
    const meter = asm.group.getObjectByName('radio-meter-needle') as THREE.Object3D;
    expect(needle, 'there is no needle piece to turn').toBeTruthy();
    const raft = { position: [0, 0, 0], quaternion: [0, 0, 0, 1] } as unknown as Parameters<typeof set.step>[1];

    // §T.156 — THE SET IS OFF UNTIL A HAND IS ON IT, and off is SILENT: no
    // signal, no lock, no hiss, whatever the dial says. USER: "it should only
    // make sound when we interact with it."
    radio.on = false;
    radio.tune = frequencyChannel(RADIO_STATIONS[0].freqMHz);
    const dark = set.step(DT, raft, 12);
    attached!.update(DT);
    expect(dark.signal, 'a radio nobody switched on still heard a station').toBe(0);
    expect(dark.locked, 'a radio nobody switched on locked one').toBeNull();
    expect(dark.mix.staticGain, 'the set was off and still hissing').toBe(0);
    expect(gains[0].value, 'the static bed was driven while the set was off').toBeLessThan(1e-3);

    // …and now a hand takes the knob
    radio.on = true;
    // OFF STATION, at the very bottom of the band
    radio.tune = 0;
    set.step(DT, raft, 12);
    attached!.update(DT);
    const offNeedle = needle.rotation.z;
    const offMeter = meter.rotation.z;
    const offCutoff = filters[0].frequency.value;
    const offGain = gains[0].value;
    const offRate = sources[0].playbackRate.value;
    expect(panners[0].positionY.value, 'the speaker is at the origin, not on the set')
      .toBeGreaterThan(1);

    // ON STATION: park the dial on the first station's own frequency and hold
    radio.tune = frequencyChannel(target.freqMHz);
    let snap = set.step(DT, raft, 12);
    expect(snap.best?.id).toBe(target.id);
    expect(snap.signal, 'a station dead ahead at 900 m is inaudible').toBeGreaterThan(P.lockThreshold);
    for (let i = 0; i < Math.round((P.lockDwellSec + 1) / DT); i++) {
      snap = set.step(DT, raft, 12);
      attached!.update(DT);
    }

    // THE PIECE MOVED (§T.136c)
    expect(needle.rotation.z, 'the tuning needle never turned').not.toBeCloseTo(offNeedle, 6);
    expect(meter.rotation.z, 'the signal meter never rose with the signal').toBeGreaterThan(offMeter + 0.05);
    // THE AUDIO FACADE WAS DRIVEN (§B100) — the nodes, not a callback
    expect(gains[0].writes, 'nothing was ever written to the static gain').toBeGreaterThan(10);
    expect(filters[0].frequency.value, 'the hiss never closed onto the voice band').toBeLessThan(offCutoff);
    expect(sources[0].playbackRate.value, 'the static pitch never dragged').toBeLessThan(offRate);
    expect(gains[0].value, 'the static never stepped back for the station').toBeLessThan(offGain);
    // AND IT LOCKED, which is the thing the whole mode turns on
    expect(snap.locked).toBe(target.id);

    /**
     * §T.156 — A LOCK IS A BEARING YOU KEEP. The point of the switch is that
     * the player does not have to leave the set hissing to keep what it found:
     * the fix outlives the power, and the bearing to it is RECOMPUTED from
     * where the raft is now (§V71) rather than saved at lock time.
     */
    expect(snap.fixes.map((f) => f.id), 'the lock left no fix behind').toContain(target.id);
    radio.on = false;
    const dead = set.step(DT, raft, 12);
    expect(dead.mix.staticGain, 'switching off did not silence the set').toBe(0);
    expect(dead.locked, 'the lock survived the power being cut').toBeNull();
    expect(dead.fixes.map((f) => f.id), 'the FIX did not survive the power being cut').toContain(target.id);

    // the aerial is at (0, 900): due north of the origin, and due EAST of a
    // raft that has sailed 900 m west of it
    const here = radioBearings(dead, 0, 0);
    expect(here[0].bearingDeg, 'a station dead ahead to the north did not read 000°').toBeCloseTo(0, 3);
    const moved = radioBearings(dead, -900, 900);
    expect(moved[0].bearingDeg, 'the bearing was frozen at lock time, not recomputed')
      .toBeCloseTo(90, 3);
    expect(here[0].label, 'the mark is labelled with an id, not the station name')
      .toBe(RADIO_STATIONS[0].title);

    set.dispose();
    radio.tune = 0.5;
    radio.on = false;
  });

  /**
   * §T.156 — WHERE A FIX FALLS ON THE COMPASS. The tape reads clockwise from
   * north under a fixed lubber line, so a mark is placed by the SHORTEST way
   * round: a station 10° to port is a few pixels left of the lubber, ⊥ 350°
   * of tape to the right. §V80 — this is the property, not the pixel count.
   */
  it('a compass mark takes the short way round the lubber line', () => {
    expect(compassOffsetPx(10, 0, 2), 'a mark to starboard fell to port').toBe(20);
    expect(compassOffsetPx(350, 0, 2), 'a mark 10° to port went the long way round').toBe(-20);
    expect(compassOffsetPx(0, 350, 2)).toBe(20);
    // dead ahead is exactly under the lubber, at every heading
    for (const h of [0, 37, 180, 271, 359]) expect(compassOffsetPx(h, h, 3)).toBe(0);
    // and the mark never leaves the band by more than half a turn
    for (const b of [0, 90, 179.9, 180, 181, 270, 359.9]) {
      expect(Math.abs(compassOffsetPx(b, 0, 1))).toBeLessThanOrEqual(180);
    }
    expect(compassOffsetPx(NaN, 0, 2), 'a NaN bearing escaped (§V28)').toBe(0);
  });
});
