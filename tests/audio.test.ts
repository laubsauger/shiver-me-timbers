/**
 * Audio math tests (T21) — pure node, no AudioContext. WHY these matter:
 * every synthesized sound is shaped by this math. A non-monotonic ADSR
 * segment clicks audibly, a bad dB conversion breaks volume settings, an
 * unwrapped LFO phase loses float precision over long sessions (swell
 * stutter), and unclamped volumes can blow past unity into clipping. Creak
 * randomization must be seed-deterministic (§V2 spirit: no Math.random).
 */
import { describe, expect, it } from 'vitest';
import {
  advanceLfo,
  centsToRatio,
  clamp01,
  dbToLinear,
  expApproach,
  lfoUnipolar,
  linearToDb,
  safeExpTarget,
  sampleAdsr,
  wrapPhase,
  type Adsr,
} from '../src/audio/envelope';
import { createEngine } from '../src/audio/engine';
import { planCreak } from '../src/audio/oneshots';
import {
  bedTargets,
  driftFactor,
  emitterTargets,
  luffEstimate,
  splashStrength,
  unit,
} from '../src/audio/mix';
import { createDeltaTrigger, createGatedTrigger } from '../src/audio/triggers';
import { listenerPoseFromMatrix } from '../src/audio/emitters';
import { sliceOffset } from '../src/audio/sampleShot';
import { attachAudioSettings } from '../src/audio/settingsBridge';
import { LOAD_ORDER, SAMPLE_URLS } from '../src/audio/assets';
import { createSettingsStore, type StorageLike } from '../src/ui/settingsStore';
import { audioParams } from '../src/params/audio';
import { createRng } from '../src/state/rng';

const env: Adsr = { attack: 0.1, decay: 0.2, sustain: 0.6, release: 0.3 };
const GATE = 1.0;

describe('sampleAdsr (any non-monotonic segment = audible click)', () => {
  it('attack rises strictly monotonically from 0 to 1', () => {
    expect(sampleAdsr(env, 0, GATE)).toBe(0);
    let prev = -1;
    for (let t = 0; t <= env.attack; t += env.attack / 20) {
      const v = sampleAdsr(env, t, GATE);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
    expect(sampleAdsr(env, env.attack, GATE)).toBeCloseTo(1, 10);
  });

  it('decay falls strictly monotonically and reaches the sustain level', () => {
    let prev = 2;
    for (let t = env.attack + 1e-6; t < env.attack + env.decay; t += env.decay / 20) {
      const v = sampleAdsr(env, t, GATE);
      expect(v).toBeLessThan(prev);
      expect(v).toBeGreaterThanOrEqual(env.sustain);
      prev = v;
    }
    expect(sampleAdsr(env, env.attack + env.decay, GATE)).toBeCloseTo(env.sustain, 10);
  });

  it('holds sustain until gate-off, then releases to exactly 0', () => {
    expect(sampleAdsr(env, 0.5, GATE)).toBeCloseTo(env.sustain, 10);
    expect(sampleAdsr(env, GATE, GATE)).toBeCloseTo(env.sustain, 10);
    const midRelease = sampleAdsr(env, GATE + env.release / 2, GATE);
    expect(midRelease).toBeLessThan(env.sustain);
    expect(midRelease).toBeGreaterThan(0);
    expect(sampleAdsr(env, GATE + env.release, GATE)).toBe(0);
    expect(sampleAdsr(env, GATE + env.release + 5, GATE)).toBe(0);
  });

  it('gate shorter than attack releases from the interrupted level', () => {
    const shortGate = env.attack / 2; // released at level 0.5, mid-attack
    expect(sampleAdsr(env, shortGate, shortGate)).toBeCloseTo(0.5, 10);
    expect(sampleAdsr(env, shortGate + env.release, shortGate)).toBe(0);
  });
});

describe('dB ↔ linear (settings sliders speak dB-ish, nodes speak linear)', () => {
  it('round-trips within float tolerance', () => {
    for (const db of [-60, -24, -6, -1, 0, 3]) {
      expect(linearToDb(dbToLinear(db))).toBeCloseTo(db, 8);
    }
  });

  it('pins the anchor values: 0dB = unity, -6dB ≈ half amplitude', () => {
    expect(dbToLinear(0)).toBe(1);
    expect(dbToLinear(-6)).toBeCloseTo(0.501, 3);
    expect(linearToDb(0)).toBe(-120); // silence floor, not -Infinity
  });

  it('safeExpTarget floors non-positive values (WebAudio exp ramps throw on 0)', () => {
    expect(safeExpTarget(0)).toBeGreaterThan(0);
    expect(safeExpTarget(-1)).toBeGreaterThan(0);
    expect(safeExpTarget(0.5)).toBe(0.5);
  });

  it('expApproach converges toward the target without overshoot', () => {
    let v = 0;
    for (let i = 0; i < 200; i++) v = expApproach(v, 1, 1 / 60, 0.2);
    expect(v).toBeGreaterThan(0.99);
    expect(v).toBeLessThanOrEqual(1);
    expect(expApproach(0.3, 1, 0.016, 0)).toBe(1); // tau=0 snaps
  });
});

describe('LFO phase wrap (unwrapped phase loses precision → swell stutter)', () => {
  it('stays in [0,1) across many frames and wraps multi-cycle steps', () => {
    let phase = 0;
    for (let i = 0; i < 10000; i++) {
      phase = advanceLfo(phase, 0.11, 1 / 60);
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(1);
    }
    expect(advanceLfo(0.25, 10, 1)).toBeCloseTo(0.25, 10); // exactly 10 cycles
    expect(wrapPhase(-0.25)).toBeCloseTo(0.75, 10);
  });

  it('unipolar sine stays within 0..1 (it scales a gain — negatives invert phase)', () => {
    for (let ph = 0; ph < 1; ph += 0.01) {
      const v = lfoUnipolar(ph);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('volume clamp 0..1 (past unity = master bus clipping)', () => {
  it('clamp01 pins out-of-range values', () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(1.5)).toBe(1);
    expect(clamp01(0.42)).toBe(0.42);
  });

  it('engine clamps volumes at construction and via setVolumes, pre-AudioContext', () => {
    const engine = createEngine({ master: 2, sfx: -1 });
    expect(engine.getVolumes()).toEqual({ master: 1, sfx: 0, ambience: 1 });
    engine.setVolumes({ ambience: 1.7, master: 0.5 });
    expect(engine.getVolumes()).toEqual({ master: 0.5, sfx: 0, ambience: 1 });
  });
});

describe('creak randomization (seeded rng → deterministic, §V2 spirit)', () => {
  it('same seed produces the identical plan sequence', () => {
    const a = createRng(42);
    const b = createRng(42);
    for (let i = 0; i < 8; i++) {
      expect(planCreak(a)).toEqual(planCreak(b));
    }
  });

  it('different seeds vary the pitch, always within ±creakSpreadCents bounds', () => {
    const lo = audioParams.creakBaseHz * centsToRatio(-audioParams.creakSpreadCents);
    const hi = audioParams.creakBaseHz * centsToRatio(audioParams.creakSpreadCents);
    const seen = new Set<number>();
    for (const seed of [1, 2, 3, 99, 12345]) {
      const plan = planCreak(createRng(seed));
      expect(plan.startHz).toBeGreaterThanOrEqual(lo);
      expect(plan.startHz).toBeLessThanOrEqual(hi);
      expect(plan.endHz).toBeCloseTo(plan.startHz * audioParams.creakBendRatio, 10);
      seen.add(plan.startHz);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sample-era audio: bed mix, spatial emitters, event gating.
// ─────────────────────────────────────────────────────────────────────────────

const p = audioParams;
const MS_PER_KNOT = 0.514444;

describe('bed layer mix (the bed IS the mix — a flat curve = one static loop)', () => {
  const env = (windSpeed: number, weather: 'calm' | 'swell' | 'storm', shipSpeed = 0) => ({
    windSpeed,
    weather,
    shipSpeed,
  });

  it('wind layer rises monotonically with wind speed and saturates, never past its max', () => {
    let prev = -1;
    for (let w = 0; w <= p.windSpeedRef * 1.5; w += p.windSpeedRef / 20) {
      const g = bedTargets(env(w, 'swell'), p).wind;
      expect(g).toBeGreaterThanOrEqual(prev);
      expect(g).toBeLessThanOrEqual(p.windBedGain * p.swellGainMult + 1e-9);
      prev = g;
    }
    // dead calm still leaves the floor in: silence would read as a dropout
    expect(bedTargets(env(0, 'swell'), p).wind).toBeCloseTo(
      p.windBedFloor * p.swellGainMult,
      10,
    );
  });

  it('weather only scales the same curve (§V7: presets move params, not paths)', () => {
    const calm = bedTargets(env(10, 'calm'), p);
    const swell = bedTargets(env(10, 'swell'), p);
    const storm = bedTargets(env(10, 'storm'), p);
    expect(calm.ocean).toBeLessThan(swell.ocean);
    expect(swell.ocean).toBeLessThan(storm.ocean);
    // identical wind ⇒ identical tone/rate; only the gain multiplier differs
    expect(calm.windCutoffHz).toBe(storm.windCutoffHz);
    expect(calm.windRate).toBe(storm.windRate);
    expect(storm.ocean / calm.ocean).toBeCloseTo(p.stormGainMult / p.calmGainMult, 10);
  });

  it('the 12kn recording plays at rate 1.0 at its own capture wind speed', () => {
    const refMs = p.windRefKnots * MS_PER_KNOT;
    expect(bedTargets(env(refMs, 'swell'), p).windRate).toBeCloseTo(1, 10);
    expect(bedTargets(env(refMs * 2, 'swell'), p).windRate).toBeGreaterThan(1);
    expect(bedTargets(env(0, 'swell'), p).windRate).toBeLessThan(1);
    // rate must stay in a sane band — a wild rate turns wind into a jet engine
    for (const w of [0, 1, 50, 500]) {
      const r = bedTargets(env(w, 'storm'), p).windRate;
      expect(r).toBeGreaterThanOrEqual(1 - p.windRateSpread);
      expect(r).toBeLessThanOrEqual(1 + p.windRateSpread);
    }
  });

  it('the sailing bed only comes up when the ship moves, and cutoff opens with wind', () => {
    expect(bedTargets(env(10, 'swell', 0), p).sailing).toBe(0);
    expect(bedTargets(env(10, 'swell', p.sailBedSpeedRef), p).sailing).toBeGreaterThan(0);
    expect(bedTargets(env(0, 'swell'), p).windCutoffHz).toBeLessThan(
      bedTargets(env(p.windSpeedRef, 'swell'), p).windCutoffHz,
    );
  });

  it('NaN wind cannot leak into a gain (a NaN AudioParam kills the graph)', () => {
    const t = bedTargets(env(Number.NaN, 'swell', Number.NaN), p);
    for (const v of [t.ocean, t.wind, t.sailing, t.windCutoffHz]) expect(Number.isFinite(v)).toBe(true);
    expect(unit(Number.NaN, 5)).toBe(0);
  });

  it('layer drift stays inside [1-depth, 1] so a layer can never invert or spike', () => {
    for (let ph = 0; ph < 1; ph += 0.02) {
      const d = driftFactor(ph, p.bedDriftDepth);
      expect(d).toBeGreaterThanOrEqual(1 - p.bedDriftDepth - 1e-12);
      expect(d).toBeLessThanOrEqual(1 + 1e-12);
    }
    expect(driftFactor(0.25, 0)).toBe(1); // depth 0 = perfectly static
  });
});

describe('crossfade behaviour (a layer that jumps to its target pops audibly)', () => {
  it('a new layer fades in from silence, monotonically, without overshoot', () => {
    let g = 0;
    let prev = -1;
    for (let i = 0; i < 60 * 8; i++) {
      g = expApproach(g, 0.8, 1 / 60, p.bedFadeTau);
      expect(g).toBeGreaterThanOrEqual(prev);
      expect(g).toBeLessThanOrEqual(0.8);
      prev = g;
    }
    expect(g).toBeGreaterThan(0.79);
  });

  it('a weather change crossfades over seconds, not frames', () => {
    const from = bedTargets({ windSpeed: 10, weather: 'calm', shipSpeed: 0 }, p).ocean;
    const to = bedTargets({ windSpeed: 10, weather: 'storm', shipSpeed: 0 }, p).ocean;
    let g = from;
    g = expApproach(g, to, 1 / 60, p.bedFadeTau);
    // one frame moves it a fraction of the way — no step change
    expect(Math.abs(g - from)).toBeLessThan(Math.abs(to - from) * 0.05);
  });
});

describe('positional emitter gains (what makes the ship localizable)', () => {
  it('wake/bow scale super-linearly with speed and are silent at rest', () => {
    const still = emitterTargets({ speed: 0, motion: 0 }, p);
    expect(still.wake).toBe(0);
    expect(still.bowRush).toBe(0);
    const half = emitterTargets({ speed: p.wakeSpeedRef / 2, motion: 0 }, p).wake;
    const full = emitterTargets({ speed: p.wakeSpeedRef, motion: 0 }, p).wake;
    expect(half).toBeLessThan(full / 2); // quadratic, not linear
    expect(full).toBeCloseTo(p.wakeGain, 10);
    // above the reference speed it saturates instead of running away
    expect(emitterTargets({ speed: 100, motion: 0 }, p).wake).toBeCloseTo(p.wakeGain, 10);
  });

  it('hull gurgle and rigging creak keep a floor — a drifting hull still lives', () => {
    const idle = emitterTargets({ speed: 0, motion: 0 }, p);
    expect(idle.gurgle).toBeCloseTo(p.gurgleGain * p.gurgleFloor, 10);
    expect(idle.creak).toBeCloseTo(p.creakLoopGain * p.creakFloor, 10);
    const rolling = emitterTargets({ speed: 0, motion: p.creakMotionRef }, p);
    expect(rolling.creak).toBeCloseTo(p.creakLoopGain, 10);
    expect(rolling.creak).toBeGreaterThan(idle.creak);
  });
});

describe('listener pose from the camera matrix (turning the camera turns the field)', () => {
  it('identity matrix → looking down -Z, up +Y, at the origin', () => {
    const pose = listenerPoseFromMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(pose.fx).toBeCloseTo(0, 12);
    expect(pose.fy).toBeCloseTo(0, 12);
    expect(pose.fz).toBeCloseTo(-1, 12);
    expect([pose.ux, pose.uy, pose.uz]).toEqual([0, 1, 0]);
    expect([pose.px, pose.py, pose.pz]).toEqual([0, 0, 0]);
  });

  it('a 90° yaw rotates forward to -X and carries the translation through', () => {
    // columns of Ry(90°): X=(0,0,-1), Y=(0,1,0), Z=(1,0,0)
    const m = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 5, 3, -2, 1];
    const pose = listenerPoseFromMatrix(m);
    expect(pose.fx).toBeCloseTo(-1, 10);
    expect(pose.fz).toBeCloseTo(0, 10);
    expect([pose.px, pose.py, pose.pz]).toEqual([5, 3, -2]);
  });

  it('a degenerate matrix yields a usable forward instead of NaN', () => {
    const pose = listenerPoseFromMatrix(new Array(16).fill(0));
    expect([pose.fx, pose.fy, pose.fz]).toEqual([0, 0, -1]);
    expect(Number.isFinite(pose.ux + pose.uy + pose.uz)).toBe(true);
  });
});

describe('luff estimate (decides when canvas snaps fire)', () => {
  const base = { windDirection: 0, windSpeed: 12, yawRate: 0, trim: 1 };
  // wind blows toward +z; ship forward +z = running, forward -z = in irons
  it('is ~0 running downwind and high head-to-wind', () => {
    const running = luffEstimate({ ...base, forwardX: 0, forwardZ: 1 }, p);
    const irons = luffEstimate({ ...base, forwardX: 0, forwardZ: -1 }, p);
    expect(running).toBeLessThan(0.05);
    expect(irons).toBeGreaterThan(0.8);
    expect(irons).toBeGreaterThan(p.sailSnapLuffOn);
  });

  it('furled sails never luff, and a hard turn shakes the cloth', () => {
    expect(luffEstimate({ ...base, forwardX: 0, forwardZ: -1, trim: 0 }, p)).toBe(0);
    const straight = luffEstimate({ ...base, forwardX: 0, forwardZ: 1 }, p);
    const turning = luffEstimate({ ...base, forwardX: 0, forwardZ: 1, yawRate: 0.6 }, p);
    expect(turning).toBeGreaterThan(straight);
  });

  it('stays in 0..1 for any input (it scales a gain)', () => {
    for (const dir of [0, 1, 2, 3, 4, 5, 6]) {
      for (const yaw of [-4, 0, 4]) {
        const v = luffEstimate(
          { forwardX: Math.sin(dir), forwardZ: Math.cos(dir), windDirection: dir * 0.7, windSpeed: 40, yawRate: yaw, trim: 1 },
          p,
        );
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('one-shot gating (without hysteresis a threshold machine-guns)', () => {
  const cfg = () => ({ on: 0.5, off: 0.2, cooldown: 1 });

  it('fires on the rising edge and refuses to refire until the signal drops', () => {
    const trig = createGatedTrigger(cfg);
    expect(trig.step(0.6, 1 / 60)).toBe(true);
    let fires = 0;
    for (let i = 0; i < 600; i++) if (trig.step(0.6, 1 / 60)) fires++; // 10 s held high
    expect(fires).toBe(0); // non-repeat: held signal = one event
    // dropping below `off` re-arms; dropping only below `on` does not
    for (let i = 0; i < 60; i++) trig.step(0.4, 1 / 60);
    expect(trig.step(0.6, 1 / 60)).toBe(false);
    for (let i = 0; i < 60; i++) trig.step(0.1, 1 / 60);
    expect(trig.step(0.6, 1 / 60)).toBe(true);
  });

  it('repeat mode paces itself at the cooldown instead of firing every frame', () => {
    const trig = createGatedTrigger(() => ({ on: 0.5, off: 0.2, cooldown: 0.5, repeat: true }));
    let fires = 0;
    for (let i = 0; i < 60 * 10; i++) if (trig.step(1, 1 / 60)) fires++; // 10 s held high
    expect(fires).toBeGreaterThanOrEqual(20); // 10 s / 0.5 s
    expect(fires).toBeLessThanOrEqual(21);
  });

  it('jitter keeps repeated snaps from sounding like a metronome', () => {
    const mk = (seed: number) => {
      const t = createGatedTrigger(
        () => ({ on: 0.5, off: 0.2, cooldown: 0.5, repeat: true, jitter: 0.4 }),
        createRng(seed),
      );
      const times: number[] = [];
      for (let i = 0; i < 60 * 10; i++) if (t.step(1, 1 / 60)) times.push(i / 60);
      return times;
    };
    const times = mk(7);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    expect(new Set(gaps.map((g) => g.toFixed(3))).size).toBeGreaterThan(1);
    expect(mk(7)).toEqual(mk(7)); // seeded: same session, same rhythm
    expect(mk(7)).not.toEqual(mk(99));
  });

  it('the external gate (§V27 speed gate) blocks fires but does not stall the cooldown', () => {
    const trig = createGatedTrigger(() => ({ on: 0.5, off: 0.2, cooldown: 1, repeat: true }));
    for (let i = 0; i < 300; i++) expect(trig.step(1, 1 / 60, false)).toBe(false);
    expect(trig.step(1, 1 / 60, true)).toBe(true); // ready the instant it is allowed
  });

  it('a bow immersion trace at wave rate produces splashes, not a buzz', () => {
    const trig = createGatedTrigger(
      () => ({
        on: p.bowSplashImmersionOn,
        off: p.bowSplashImmersionOff,
        cooldown: p.bowSplashCooldown,
        repeat: true,
      }),
      createRng(3),
    );
    let fires = 0;
    // 20 s of bow immersion oscillating at ~0.5 Hz around the threshold
    for (let i = 0; i < 60 * 20; i++) {
      const t = i / 60;
      const immersion = 0.4 + 0.4 * Math.sin(t * Math.PI); // 0..0.8 m
      if (trig.step(immersion, 1 / 60, true)) fires++;
    }
    expect(fires).toBeGreaterThan(5);
    expect(fires).toBeLessThan(20 / p.bowSplashCooldown + 2);
  });

  it('splash strength grows with immersion and speed, always 0..1', () => {
    const shallow = splashStrength(0.1, 2, p);
    const deep = splashStrength(2, 2, p);
    const fast = splashStrength(2, 20, p);
    expect(shallow).toBeLessThan(deep);
    expect(deep).toBeLessThan(fast);
    expect(fast).toBeLessThanOrEqual(1);
    expect(splashStrength(0, 0, p)).toBeGreaterThan(0);
  });
});

describe('trim change detection (sail deploy / furl events)', () => {
  it('fires once per `delta` of travel with the sign of the change', () => {
    const trig = createDeltaTrigger(() => ({ delta: 0.25, cooldown: 0 }), 0);
    expect(trig.step(0.1, 1 / 60)).toBe(0);
    expect(trig.step(0.3, 1 / 60)).toBe(1);
    expect(trig.step(0.4, 1 / 60)).toBe(0);
    expect(trig.step(0.05, 1 / 60)).toBe(-1);
  });

  it('holding a key that ramps trim 0→1 fires a handful of events, not 60/s', () => {
    const trig = createDeltaTrigger(() => ({ delta: 0.25, cooldown: 0.3 }), 0);
    let fires = 0;
    for (let i = 0; i <= 120; i++) if (trig.step(i / 120, 1 / 60) !== 0) fires++; // 2 s ramp
    expect(fires).toBeGreaterThan(0);
    expect(fires).toBeLessThanOrEqual(5);
  });
});

describe('sample slicing (splashes are cut out of the long wake recording)', () => {
  it('never runs off the end of the buffer or past the chosen window', () => {
    const rng = createRng(11);
    for (let i = 0; i < 50; i++) {
      const off = sliceOffset(rng, 63.7, p.bowSplashWindowSec, p.bowSplashSliceSec);
      expect(off).toBeGreaterThanOrEqual(0);
      expect(off + p.bowSplashSliceSec).toBeLessThanOrEqual(p.bowSplashWindowSec + 1e-9);
    }
    // a window longer than the file clamps to the file
    expect(sliceOffset(() => 1, 2, 60, 1)).toBeCloseTo(1, 10);
    expect(sliceOffset(() => 1, 0.5, 60, 1)).toBe(0); // slice longer than file
  });
});

describe('asset manifest (a typo here = a silent missing layer)', () => {
  it('every declared sample has a URL and a load-order slot, no duplicates', () => {
    const names = Object.keys(SAMPLE_URLS);
    expect(new Set(LOAD_ORDER).size).toBe(LOAD_ORDER.length);
    expect([...LOAD_ORDER].sort()).toEqual([...names].sort());
    for (const url of Object.values(SAMPLE_URLS)) expect(url).toMatch(/\.mp3$/);
    // the byte-identical duplicate must not be referenced
    expect(Object.values(SAMPLE_URLS).some((u) => u.includes('(1)'))).toBe(false);
  });
});

describe('volume buses + persistence (§I settings contract)', () => {
  const memoryStorage = (): StorageLike & { raw: Map<string, string> } => {
    const raw = new Map<string, string>();
    return {
      raw,
      getItem: (k) => raw.get(k) ?? null,
      setItem: (k, v) => void raw.set(k, v),
    };
  };

  it('applies stored volumes immediately on attach', () => {
    const storage = memoryStorage();
    const store = createSettingsStore(storage);
    store.set({ audio: { master: 0.4, sfx: 0.3, ambience: 0.2 } });
    const engine = createEngine();
    attachAudioSettings(engine, store);
    expect(engine.getVolumes()).toEqual({ master: 0.4, sfx: 0.3, ambience: 0.2 });
  });

  it('follows later changes and stops after unsubscribe', () => {
    const store = createSettingsStore(memoryStorage());
    const engine = createEngine();
    const detach = attachAudioSettings(engine, store);
    store.set({ audio: { ambience: 0.1 } });
    expect(engine.getVolumes().ambience).toBe(0.1);
    detach();
    store.set({ audio: { ambience: 0.9 } });
    expect(engine.getVolumes().ambience).toBe(0.1);
  });

  it('volumes survive a reload: a fresh store + engine come back at the saved mix', () => {
    const storage = memoryStorage();
    const first = createSettingsStore(storage);
    first.set({ audio: { master: 0.25, sfx: 0.6, ambience: 0.15 } });
    const engine = createEngine();
    attachAudioSettings(engine, createSettingsStore(storage)); // "reload"
    expect(engine.getVolumes()).toEqual({ master: 0.25, sfx: 0.6, ambience: 0.15 });
  });

  it('a corrupt or out-of-range save cannot push a bus past unity', () => {
    const storage = memoryStorage();
    storage.raw.set('smt.settings.v1', JSON.stringify({ audio: { master: 9, sfx: -3 } }));
    const engine = createEngine();
    attachAudioSettings(engine, createSettingsStore(storage));
    const v = engine.getVolumes();
    expect(v.master).toBe(1);
    expect(v.sfx).toBe(0);
  });
});
