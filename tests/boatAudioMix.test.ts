/**
 * §T.183 main-thread boat mix — distance, doppler, voice stealing, events, packing.
 *
 * WHY each block:
 *  - §V96 DISTANCE LAW MEASURED AGAINST THE SPACE: a race spreads seven rivals over hundreds of
 *    metres of open sea. The shared emitter model (ref 10 m, max 350 m, inverse) goes FLAT past 350 m,
 *    so a boat a kilometre back would be exactly as loud as one at 350 m. The property: gain keeps
 *    falling across every race distance, and the source is small enough that walking the length of
 *    the boat changes it.
 *  - DOPPLER: the spec criterion (tech-research §6.3) is ×1.132 / ×0.896 ±2 % for a 40 m/s pass-by,
 *    rendered through the SAME automation the browser runs (piecewise-linear ramps at jittered
 *    frame times, audio clock quantised to 128 samples). A plain d/c delay gives ×1.117/×0.883 (the
 *    moving-LISTENER law) and a one-pole re-targeted per frame gives 60 Hz pitch jitter — both fail here.
 *  - STEALING: a slot may only change boat through fade → switch → wait for the new propagation delay,
 *    or the DelayNode replays the previous boat; and full voices go to the closest three with
 *    hysteresis, or two rivals at similar range swap voices every frame (audible chatter).
 *  - EVENTS: a landing must be a landing (air time) and slam strength must grow with the impulse.
 */
import { describe, expect, it } from 'vitest';
import {
  BoatEventDetector,
  DopplerTrack,
  RampClock,
  SPEED_OF_SOUND,
  airAbsorptionCutoffHz,
  assignNpcSlots,
  createNpcSlots,
  distanceGain,
  packBoat,
  type BoatFrameTelemetry,
  type VoiceCandidate,
} from '../src/audio/boat/mixMath';
import { boatAudioParams as P } from '../src/audio/boat/params';
import { BI, BOAT_STRIDE, muffleAmount, DEFAULT_VOICE_TUNABLES } from '../src/audio/boat/protocol';
import { audioParams } from '../src/params/audio';
import { createRng } from '../src/state/rng';

describe('§V96 distance law against open-sea race distances', () => {
  const race = [10, 25, 50, 100, 200, 350, 500, 800, 1200];

  it('the shared emitter model plateaus at its maxDistance — measured, the reason boats carry their own law', () => {
    const inverse = (d: number): number => {
      const dd = Math.min(Math.max(d, audioParams.emitterRefDistance), audioParams.emitterMaxDistance);
      return audioParams.emitterRefDistance / (audioParams.emitterRefDistance + audioParams.emitterRolloff * (dd - audioParams.emitterRefDistance));
    };
    expect(inverse(1200)).toBe(inverse(audioParams.emitterMaxDistance));
  });

  it('boat gain falls monotonically through every race distance, ~6 dB per doubling, no plateau', () => {
    for (let i = 1; i < race.length; i++) expect(distanceGain(race[i], P)).toBeLessThan(distanceGain(race[i - 1], P));
    const db = (d: number): number => 20 * Math.log10(distanceGain(d, P));
    expect(db(100) - db(200)).toBeGreaterThan(5);
    expect(db(600) - db(1200)).toBeGreaterThan(5);
  });

  it('the source is smaller than the boat: gain at the far end of a 12 m hull is measurably below gain at the engines', () => {
    expect(P.refDistance).toBeLessThan(2.3 / 2);
    expect(distanceGain(12, P)).toBeLessThan(0.5 * distanceGain(2, P));
  });

  it('air absorption darkens distant boats: cutoff falls with distance and sits in the ISO 9613 range', () => {
    for (let i = 1; i < race.length; i++) expect(airAbsorptionCutoffHz(race[i], 1)).toBeLessThanOrEqual(airAbsorptionCutoffHz(race[i - 1], 1));
    // 3 dB of absorption: ~3.5 kHz at 100 m, ~0.9 kHz at 1 km
    expect(airAbsorptionCutoffHz(100, 1)).toBeGreaterThan(2500);
    expect(airAbsorptionCutoffHz(100, 1)).toBeLessThan(4500);
    expect(airAbsorptionCutoffHz(1000, 1)).toBeLessThan(1200);
  });
});

describe('§T.183 doppler through the automation the browser runs', () => {
  function passBy(speed: number, offset: number, seed: number) {
    const rng = createRng(seed);
    const track = new DopplerTrack();
    const clock = new RampClock();
    const events: [number, number][] = [];
    let t = 0;
    const x0 = -400;
    const quantum = 128 / 48000;
    let first = true;
    while (t < 20) {
      const dt = (1 / 60) * (0.7 + 0.6 * rng());
      t += dt;
      const x = x0 + speed * t;
      const d = Math.hypot(x, offset);
      const ctxTime = Math.floor(t / quantum) * quantum;
      if (first) {
        track.reset(d, P.maxDelay);
        events.push([ctxTime, track.delay]);
        first = false;
        continue;
      }
      const v = track.step(d, dt, P.dopplerTau, P.maxDelay);
      events.push([clock.next(ctxTime, dt), v]);
    }
    // pitch ratio at time T = 1 − d(delay)/dt of the piecewise-linear automation
    const ratioAt = (T: number): number => {
      for (let i = 1; i < events.length; i++) {
        if (events[i][0] >= T) return 1 - (events[i][1] - events[i - 1][1]) / (events[i][0] - events[i - 1][0]);
      }
      return NaN;
    };
    const timeAtX = (x: number): number => (x - x0) / speed;
    return { ratioAt, timeAtX };
  }

  it('40 m/s pass-by: ×1.132 approaching, ×0.896 receding, ±2 %', () => {
    const { ratioAt, timeAtX } = passBy(40, 15, 1);
    const approach = SPEED_OF_SOUND / (SPEED_OF_SOUND - 40);
    const recede = SPEED_OF_SOUND / (SPEED_OF_SOUND + 40);
    expect(approach).toBeCloseTo(1.132, 3);
    expect(recede).toBeCloseTo(0.8956, 3);
    expect(Math.abs(ratioAt(timeAtX(-250)) / approach - 1)).toBeLessThan(0.02);
    expect(Math.abs(ratioAt(timeAtX(250)) / recede - 1)).toBeLessThan(0.02);
  });

  it('no zipper: during a steady approach the frame-to-frame pitch wobble stays under 0.5 % despite ±30 % frame jitter', () => {
    const { ratioAt, timeAtX } = passBy(40, 15, 7);
    let lo = Infinity;
    let hi = -Infinity;
    for (let T = timeAtX(-300); T < timeAtX(-200); T += 0.004) {
      const r = ratioAt(T);
      lo = Math.min(lo, r);
      hi = Math.max(hi, r);
    }
    expect(hi - lo).toBeLessThan(0.005 * 1.132);
  });

  it('the delay stays within [0, maxDelay] and is finite for any distance', () => {
    const tr = new DopplerTrack();
    for (const d of [0, 1, 1e3, 1e6, NaN, Infinity, -5]) {
      const v = tr.step(d, 1 / 60, P.dopplerTau, P.maxDelay);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(P.maxDelay + 1e-9);
    }
  });
});

describe('§T.183 NPC voice stealing and tiers', () => {
  const step = (slots: ReturnType<typeof createNpcSlots>, c: VoiceCandidate[], seconds = 1): void => {
    for (let t = 0; t < seconds; t += 1 / 60) assignNpcSlots(slots, c, 1 / 60, P);
  };

  it('7 slots for 9 rivals: the 7 most audible play, the 3 most audible get full voices', () => {
    const slots = createNpcSlots(7);
    const cands = Array.from({ length: 9 }, (_, i) => ({ id: i, score: 1 / (1 + i), delay: 0.05 }));
    step(slots, cands);
    expect(slots.map((s) => s.boat).sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(slots.every((s) => s.phase === 'playing')).toBe(true);
    expect(slots.filter((s) => s.full).map((s) => s.boat).sort()).toEqual([0, 1, 2]);
  });

  it('a steal fades, switches, then waits out the new boat’s propagation delay before playing', () => {
    const slots = createNpcSlots(1);
    step(slots, [{ id: 1, score: 0.1, delay: 0.1 }]);
    expect(slots[0]).toMatchObject({ boat: 1, phase: 'playing' });
    const cands = [
      { id: 1, score: 0.1, delay: 0.1 },
      { id: 2, score: 1, delay: 0.5 },
    ];
    assignNpcSlots(slots, cands, 1 / 60, P);
    expect(slots[0]).toMatchObject({ boat: 1, phase: 'fadeOut', next: 2 });
    let switchedAt = -1;
    let playingAt = -1;
    for (let f = 1; f < 120; f++) {
      assignNpcSlots(slots, cands, 1 / 60, P);
      if (slots[0].switched) switchedAt = f / 60;
      if (playingAt < 0 && slots[0].phase === 'playing') playingAt = f / 60;
    }
    expect(slots[0].boat).toBe(2);
    expect(switchedAt).toBeGreaterThan(0);
    expect(switchedAt).toBeLessThanOrEqual(P.stealFade + 2 / 60);
    expect(playingAt - switchedAt).toBeGreaterThanOrEqual(0.5 - 1 / 60);
  });

  it('hysteresis: two rivals within the steal ratio of each other do not trade the last full voice', () => {
    const slots = createNpcSlots(7);
    const base = Array.from({ length: 7 }, (_, i) => ({ id: i, score: 1 / (1 + i), delay: 0.05 }));
    step(slots, base);
    const fullBefore = slots.filter((s) => s.full).map((s) => s.boat).sort();
    // boat 3 creeps just past boat 2 — inside the ratio
    const nudged = base.map((c) => (c.id === 3 ? { ...c, score: base[2].score * 1.1 } : c));
    step(slots, nudged);
    expect(slots.filter((s) => s.full).map((s) => s.boat).sort()).toEqual(fullBefore);
    // a clear overtake does move it
    const passed = base.map((c) => (c.id === 3 ? { ...c, score: base[0].score * 2 } : c));
    step(slots, passed);
    expect(slots.filter((s) => s.full).map((s) => s.boat)).toContain(3);
  });

  it('a boat that leaves (culled/despawned) fades out and frees its slot', () => {
    const slots = createNpcSlots(2);
    step(slots, [{ id: 5, score: 1, delay: 0 }]);
    step(slots, [], 0.5);
    expect(slots.every((s) => s.phase === 'idle' && s.boat === -1)).toBe(true);
  });
});

describe('§T.183 events and packing', () => {
  const tel = (o: Partial<BoatFrameTelemetry>): BoatFrameTelemetry => ({
    id: 1,
    voice: 'v8',
    position: [0, 0, 0],
    velocity: [0, 0, -30],
    throttle: 1,
    wettedArea: 5,
    slamImpulse: 0,
    ...o,
  });

  it('landing needs real air time, and harder touchdowns are stronger', () => {
    const land = (air: number, vy: number): number => {
      const d = new BoatEventDetector();
      for (let t = 0; t < air; t += 1 / 60) d.step(tel({ wettedArea: 0, velocity: [0, vy, -30] }), 1 / 60, P);
      return d.step(tel({}), 1 / 60, P).landing;
    };
    expect(land(0.1, -6)).toBe(0);
    expect(land(1, -6)).toBeGreaterThan(0);
    expect(land(1, -9)).toBeGreaterThan(land(1, -3));
  });

  it('slam strength grows with Δv = impulse / mass, below threshold is silent, cooldown spaces chatter', () => {
    const s = (imp: number): number => new BoatEventDetector().step(tel({ slamImpulse: imp }), 1 / 60, P).slam;
    expect(s(0.01 * 5350)).toBe(0);
    expect(s(0.3 * 5350)).toBeGreaterThan(0);
    expect(s(1.2 * 5350)).toBeGreaterThan(s(0.3 * 5350));
    const d = new BoatEventDetector();
    expect(d.step(tel({ slamImpulse: 5350 }), 1 / 60, P).slam).toBeGreaterThan(0);
    expect(d.step(tel({ slamImpulse: 5350 }), 1 / 60, P).slam).toBe(0);
  });

  it('muffled exhaust: underwater at idle, in air on the plane or with the prop out', () => {
    const t = DEFAULT_VOICE_TUNABLES;
    expect(muffleAmount(1, 0, 0, t)).toBeGreaterThan(0.9);
    expect(muffleAmount(1, 30, 1, t)).toBe(0);
    expect(muffleAmount(0.1, 0, 0, t)).toBe(0);
  });

  it('packing sanitises non-finite telemetry and falls back to the worker path fields', () => {
    const out = new Float32Array(BOAT_STRIDE);
    const ev = new BoatEventDetector().step(tel({}), 1 / 60, P);
    packBoat(tel({ throttle: NaN, velocity: [NaN, Infinity, 3], wettedArea: NaN, slamImpulse: NaN, propImmersion: 0.4, driveAdvance: [NaN] }), ev, out, 0, 9);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
    expect(out[BI.IMMERSION]).toBeCloseTo(0.4, 5);
    expect(out[BI.ENGINES]).toBe(3);
  });
});
