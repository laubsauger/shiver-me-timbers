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
  hullWorking,
  luffEstimate,
  slamSignal,
  slamStrength,
  splashStrength,
  unit,
} from '../src/audio/mix';
import { createHaulMachine, type HaulEvent } from '../src/audio/sailHaul';
import { discoverMusicTracks, parseTrackName, type MusicTrackRef } from '../src/audio/musicAssets';
import {
  agcStep,
  createPlaylist,
  duckHit,
  gapFor,
  musicStateFor,
  stepDuck,
  tagMatch,
  trackWeight,
  windowRms,
  type DuckState,
} from '../src/audio/musicPlaylist';
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
    // music defaults to unity: the settings store does not carry it yet
    expect(engine.getVolumes()).toEqual({ master: 1, sfx: 0, ambience: 1, music: 1 });
    engine.setVolumes({ ambience: 1.7, master: 0.5 });
    expect(engine.getVolumes()).toEqual({ master: 0.5, sfx: 0, ambience: 1, music: 1 });
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
    const still = emitterTargets({ speed: 0, working: 0 }, p);
    expect(still.wake).toBe(0);
    expect(still.bowRush).toBe(0);
    const half = emitterTargets({ speed: p.wakeSpeedRef / 2, working: 0 }, p).wake;
    const full = emitterTargets({ speed: p.wakeSpeedRef, working: 0 }, p).wake;
    expect(half).toBeLessThan(full / 2); // quadratic, not linear
    expect(full).toBeCloseTo(p.wakeGain, 10);
    // above the reference speed it saturates instead of running away
    expect(emitterTargets({ speed: 100, working: 0 }, p).wake).toBeCloseTo(p.wakeGain, 10);
  });

  it('hull gurgle and rigging creak keep a floor — a drifting hull still lives', () => {
    const idle = emitterTargets({ speed: 0, working: 0 }, p);
    expect(idle.gurgle).toBeCloseTo(p.gurgleGain * p.gurgleFloor, 10);
    expect(idle.creak).toBeCloseTo(p.creakLoopGain * p.creakFloor, 10);
    const rolling = emitterTargets({ speed: 0, working: 1 }, p);
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
    store.set({ audio: { master: 0.4, sfx: 0.3, ambience: 0.2, music: 0.1 } });
    const engine = createEngine();
    attachAudioSettings(engine, store);
    expect(engine.getVolumes()).toEqual({ master: 0.4, sfx: 0.3, ambience: 0.2, music: 0.1 });
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
    first.set({ audio: { master: 0.25, sfx: 0.6, ambience: 0.15, music: 0.4 } });
    const engine = createEngine();
    attachAudioSettings(engine, createSettingsStore(storage)); // "reload"
    expect(engine.getVolumes()).toEqual({ master: 0.25, sfx: 0.6, ambience: 0.15, music: 0.4 });
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

// ─────────────────────────────────────────────────────────────────────────────
// "The ship as a working object": creak, slam, and the reefing haul.
// ─────────────────────────────────────────────────────────────────────────────

/** a hullContact-shaped stub; arrays are bow-most first, like the real one */
const contactOf = (
  depth: number[],
  rate: number[],
  cutwater: { inContact?: boolean; depth?: number; rate?: number } = {},
) => ({
  cutwater: {
    inContact: cutwater.inContact ?? true,
    world: [0, 0, 0] as [number, number, number],
    depth: cutwater.depth ?? 0.5,
    rate: cutwater.rate ?? 0,
  },
  sliceDepth: depth,
  sliceRate: rate,
  wetFraction: depth.filter((d) => d > 0).length / Math.max(1, depth.length),
});

describe('hull working (why the creak went silent when the ship got calmer)', () => {
  it('a CALM hull still works: the sea running the planks keeps creak alive', () => {
    // post-damping motion: ~0.03 rad/s roll+pitch — under the old 0.35 rad/s
    // reference that alone was ~9% and inaudible
    const rotationOnly = hullWorking(0.02, 0.01, null, p);
    const inASeaway = hullWorking(0.02, 0.01, contactOf([1, 1, 1], [0.8, -0.7, 0.6]), p);
    expect(inASeaway).toBeGreaterThan(rotationOnly);
    expect(inASeaway).toBeGreaterThan(0.5);
    // and whatever the signal, the loop is never inaudible: it has a floor
    expect(emitterTargets({ speed: 0, working: 0 }, p).creak).toBeCloseTo(
      p.creakLoopGain * p.creakFloor,
      10,
    );
    expect(p.creakLoopGain * p.creakFloor).toBeGreaterThan(0.2);
  });

  it('rolling hard maxes it out from rotation alone, and it stays 0..1', () => {
    expect(hullWorking(p.creakMotionRef, 0, null, p)).toBeCloseTo(1, 10);
    expect(hullWorking(10, 10, contactOf([1], [50]), p)).toBe(1);
    expect(hullWorking(Number.NaN, 0, null, p)).toBe(0);
    expect(hullWorking(0, 0, contactOf([-1, -1], [9, 9]), p)).toBe(0); // dry hull
  });

  it('drives the ambience creak layer too, with the same floor', () => {
    const quiet = bedTargets({ windSpeed: 5, weather: 'calm', shipSpeed: 0, working: 0 }, p).creak;
    const loud = bedTargets({ windSpeed: 5, weather: 'calm', shipSpeed: 0, working: 1 }, p).creak;
    expect(quiet).toBeCloseTo(p.creakBedGain * p.creakFloor, 10);
    expect(loud).toBeCloseTo(p.creakBedGain, 10);
    // weather must NOT scale creak — the hull works the same in a flat calm
    expect(bedTargets({ windSpeed: 5, weather: 'storm', shipSpeed: 0, working: 0.5 }, p).creak).toBe(
      bedTargets({ windSpeed: 5, weather: 'calm', shipSpeed: 0, working: 0.5 }, p).creak,
    );
  });
});

describe('slam detection (the bow coming down on the sea)', () => {
  it('reads the FORWARD slices only — the run aft buries smoothly at speed', () => {
    const n = 10;
    const depth = new Array(n).fill(1);
    const rate = new Array(n).fill(0.2);
    rate[n - 1] = 9; // a big aft-most burial must NOT read as a slam
    expect(slamSignal(contactOf(depth, rate), p)).toBeLessThan(p.slamRateOn);
    rate[0] = 4; // the stem driving under does
    expect(slamSignal(contactOf(depth, rate), p)).toBeCloseTo(4, 10);
  });

  it('ignores dry slices and falls back to the cutwater rate', () => {
    expect(slamSignal(contactOf([-1, -1, -1], [8, 8, 8]), p)).toBe(0);
    expect(slamSignal(contactOf([-1, -1], [0, 0], { rate: 3 }), p)).toBeCloseTo(3, 10);
    // airborne hull: the cutwater contributes nothing
    expect(slamSignal(contactOf([-1, -1], [0, 0], { inContact: false, rate: 3 }), p)).toBe(0);
    expect(slamSignal(null, p)).toBe(0);
    expect(slamSignal(contactOf([1], [Number.NaN]), p)).toBe(0);
  });

  it('intensity scales with impact velocity, with a floor and a ceiling', () => {
    const soft = slamStrength(p.slamRateOn, p);
    const hard = slamStrength(p.slamRateFull, p);
    expect(soft).toBeGreaterThan(0.3); // even a light slap is audible
    expect(soft).toBeLessThan(hard);
    expect(slamStrength(1000, p)).toBeLessThanOrEqual(1);
  });

  it('a seaway does not machine-gun slams: gated at the slam thresholds', () => {
    const trig = createGatedTrigger(
      () => ({ on: p.slamRateOn, off: p.slamRateOff, cooldown: p.slamCooldown, repeat: true }),
      createRng(5),
    );
    let fires = 0;
    // 30 s of a 0.35 Hz pitching cycle that buries the bow hard twice a cycle
    for (let i = 0; i < 60 * 30; i++) {
      const t = i / 60;
      const rateSignal = 3 * Math.max(0, Math.sin(t * 2 * Math.PI * 0.35));
      if (trig.step(rateSignal, 1 / 60, true)) fires++;
    }
    expect(fires).toBeGreaterThan(8); // it must actually fire — this is the ask
    expect(fires).toBeLessThan(30 / p.slamCooldown);
  });
});

describe('reefing haul (a process, not a click — and it works both ways)', () => {
  const runHaul = (from: number, to: number, seconds: number, seed = 4): HaulEvent[] => {
    const machine = createHaulMachine();
    const rng = createRng(seed);
    const events: HaulEvent[] = [];
    const emit = (e: HaulEvent): void => void events.push(e);
    machine.step(from, 1 / 60, rng, emit); // adopt the start value
    const steps = Math.max(1, Math.round(seconds * 60));
    for (let i = 1; i <= steps; i++) {
      machine.step(from + ((to - from) * i) / steps, 1 / 60, rng, emit);
    }
    for (let i = 0; i < 120; i++) machine.step(to, 1 / 60, rng, emit); // settle
    return events;
  };

  it('reefing IN produces an opening crack, a rhythm of rustles, then a terminal snap', () => {
    const events = runHaul(1, 0, 2);
    expect(events[0].kind).toBe('open');
    expect(events[0].direction).toBe(-1);
    expect(events.filter((e) => e.kind === 'rustle').length).toBeGreaterThan(3);
    expect(events[events.length - 1].kind).toBe('terminal');
    expect(events.filter((e) => e.kind === 'terminal')).toHaveLength(1);
  });

  it('setting sail OUT sounds too, and opens with the deploy sound instead', () => {
    const out = runHaul(0, 1, 2);
    expect(out[0].kind).toBe('open');
    expect(out[0].direction).toBe(1);
    expect(out[0].gain).toBeCloseTo(p.sailDeployGain, 10);
    expect(out.filter((e) => e.kind === 'rustle').length).toBeGreaterThan(3);
    // direction colours the rustles: hauling in is heavier/slower
    const inRate = runHaul(1, 0, 2).find((e) => e.kind === 'rustle')!.playbackRate;
    const outRate = out.find((e) => e.kind === 'rustle')!.playbackRate;
    expect(inRate).toBeLessThan(outRate);
  });

  it('rustles are paced by haulTickSec with jitter — not one per frame', () => {
    const rustles = runHaul(1, 0, 2).filter((e) => e.kind === 'rustle').length;
    expect(rustles).toBeLessThanOrEqual(2 / p.haulTickSec + 2);
    expect(new Set(runHaul(1, 0, 2).map((e) => e.playbackRate)).size).toBeGreaterThan(1);
  });

  it('a one-frame JUMP in drop still runs a full haul, not a lonely click', () => {
    // the case where the rig has not been animated smoothly yet
    const events = runHaul(1, 0, 1 / 60);
    expect(events.filter((e) => e.kind === 'rustle').length).toBeGreaterThan(0);
    expect(events[events.length - 1].kind).toBe('terminal');
  });

  it('a motionless rig is silent, and startup never fires', () => {
    const machine = createHaulMachine();
    const rng = createRng(1);
    const events: HaulEvent[] = [];
    for (let i = 0; i < 600; i++) machine.step(0.8, 1 / 60, rng, (e) => void events.push(e));
    expect(events).toHaveLength(0);
    expect(machine.active()).toBe(false);
    // trim creeping by a hair (autopilot noise) must not trigger a haul either
    for (let i = 0; i < 600; i++) {
      machine.step(0.8 + i * 1e-4, 1 / 60, rng, (e) => void events.push(e));
    }
    expect(events).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Music: streamed playlist, its own bus, ducked under combat.
// ─────────────────────────────────────────────────────────────────────────────

describe('track discovery (dropping files in is the whole workflow)', () => {
  it("parses the user's convention: tags after the LAST underscore, split on dashes", () => {
    const t = parseTrackName('../../assets/audio/music/Knives at Dusk_smooth-vibey.mp3');
    expect(t.id).toBe('Knives at Dusk_smooth-vibey');
    expect(t.title).toBe('Knives at Dusk');
    expect(t.tags).toEqual(['smooth', 'vibey']);
  });

  it('keeps unknown tags instead of dropping them (the vocabulary is theirs)', () => {
    // nothing here is in SITUATION_TAGS — it must still survive parsing
    expect(parseTrackName('X_brine-gloom-fiddle.mp3').tags).toEqual(['brine', 'gloom', 'fiddle']);
    expect(parseTrackName('Y_combat.ogg').tags).toEqual(['combat']);
  });

  it('a title with dashes/spaces and no underscore is a valid untagged track', () => {
    const t = parseTrackName('Dead-Man-Tell No Tales.mp3');
    expect(t.title).toBe('Dead-Man-Tell No Tales');
    expect(t.tags).toEqual([]);
    // degenerate shapes are ordinary inputs, never throws
    expect(parseTrackName('Trailing_.mp3').tags).toEqual([]);
    expect(parseTrackName('_leading.mp3').tags).toEqual(['leading']);
    expect(parseTrackName('a_b_c-d.mp3').title).toBe('a_b'); // only the LAST underscore splits
  });

  it('discovery never throws, skips non-audio files, and encodes spaces', () => {
    const tracks = discoverMusicTracks();
    expect(Array.isArray(tracks)).toBe(true);
    for (const t of tracks) {
      expect(t.url).toMatch(/\.(mp3|ogg|m4a|wav|flac)$/i);
      expect(t.url).not.toContain(' '); // a raw space breaks the <audio> fetch
      expect(t.url).not.toContain('.gitkeep');
      expect(Array.isArray(t.tags)).toBe(true);
    }
  });
});

describe('playlist selection (shuffle now, tag bias prepared)', () => {
  const ref = (id: string, tags: string[] = []): MusicTrackRef => ({
    id,
    title: id,
    tags,
    url: `${id}.mp3`,
  });

  it('no tracks = a silent, clean state forever — never an error', () => {
    const empty = createPlaylist([], createRng(1));
    expect(empty.size()).toBe(0);
    for (const s of ['calm', 'island', 'storm', 'combat'] as const) {
      expect(empty.next(s)).toBeNull();
      expect(empty.countFor(s)).toBe(0);
    }
  });

  it('ships as pure shuffle: at bias 0 an untagged track is as likely as a tagged one', () => {
    expect(audioParams.musicTagBias).toBe(0); // the shipped default
    const tagged = ref('battle', ['combat', 'drums']);
    const plain = ref('plain');
    expect(trackWeight(tagged, 'combat')).toBe(trackWeight(plain, 'combat'));
    const list = createPlaylist([tagged, plain], createRng(7));
    const picks = new Set<string>();
    for (let i = 0; i < 20; i++) picks.add(list.next('combat')!.id);
    expect(picks).toEqual(new Set(['battle', 'plain'])); // both get played
  });

  it('tag bias is a BIAS, not a filter: a mismatched track can still play', () => {
    const was = audioParams.musicTagBias;
    audioParams.musicTagBias = 1;
    try {
      const stormy = ref('stormy', ['storm', 'dark']);
      const mellow = ref('mellow', ['smooth', 'vibey']);
      expect(trackWeight(stormy, 'storm')).toBeGreaterThan(trackWeight(mellow, 'storm'));
      expect(trackWeight(mellow, 'storm')).toBeGreaterThanOrEqual(1); // never zero
      // with only mismatched tracks available, music still plays
      const onlyMellow = createPlaylist([mellow], createRng(4));
      expect(onlyMellow.next('combat')?.id).toBe('mellow');
      // over many draws the fitting tracks win the majority (needs a library
      // bigger than the no-repeat window — see the next assertion)
      const library = [
        ref('s1', ['storm']),
        ref('s2', ['storm', 'dark']),
        ref('s3', ['ominous']),
        ref('m1', ['smooth']),
        ref('m2', ['vibey']),
        ref('m3', ['mellow']),
      ];
      const list = createPlaylist(library, createRng(11));
      let stormWins = 0;
      for (let i = 0; i < 300; i++) if (list.next('storm')!.id.startsWith('s')) stormWins++;
      expect(stormWins).toBeGreaterThan(180); // > 60%, not 100% — still a bias
      // honest limit: in a 2-track library the no-repeat window outranks the
      // bias and the two simply alternate. Small libraries are shuffle.
      const tiny = createPlaylist([stormy, mellow], createRng(11));
      const seq = [tiny.next('storm')!.id, tiny.next('storm')!.id, tiny.next('storm')!.id];
      expect(new Set(seq).size).toBe(2);
    } finally {
      audioParams.musicTagBias = was;
    }
  });

  it('unknown tags never help and never hurt', () => {
    const was = audioParams.musicTagBias;
    audioParams.musicTagBias = 1;
    try {
      expect(tagMatch(ref('x', ['brine', 'gloom']), 'storm')).toBe(0);
      expect(trackWeight(ref('x', ['brine']), 'storm')).toBe(1); // same as untagged
      expect(trackWeight(ref('y'), 'storm')).toBe(1);
    } finally {
      audioParams.musicTagBias = was;
    }
  });

  it('shuffle avoids immediate repeats, and a 2-track library cannot deadlock', () => {
    const many = createPlaylist(['a', 'b', 'c', 'd', 'e'].map((id) => ref(id)), createRng(9));
    let prev = '';
    for (let i = 0; i < 40; i++) {
      const t = many.next('calm')!;
      expect(t.id).not.toBe(prev);
      prev = t.id;
    }
    const two = createPlaylist([ref('a'), ref('b')], createRng(3));
    for (let i = 0; i < 10; i++) expect(two.next('calm')).not.toBeNull();
    // a single-track library repeats it rather than going silent
    const one = createPlaylist([ref('only')], createRng(3));
    expect(one.next('calm')?.id).toBe('only');
    expect(one.next('calm')?.id).toBe('only');
  });

  it('sequential mode walks the files in order', () => {
    const was = audioParams.musicShuffle;
    audioParams.musicShuffle = false;
    try {
      const list = createPlaylist(['a', 'b', 'c'].map((id) => ref(id)), createRng(1));
      expect([list.next('calm')?.id, list.next('calm')?.id, list.next('calm')?.id]).toEqual([
        'a',
        'b',
        'c',
      ]);
      expect(list.next('calm')?.id).toBe('a'); // wraps
    } finally {
      audioParams.musicShuffle = was;
    }
  });

  it('gaps encode the design: the sea is the default, music is an event', () => {
    expect(gapFor('combat')).toBeLessThan(gapFor('island'));
    expect(gapFor('island')).toBeLessThan(gapFor('storm'));
    expect(gapFor('storm')).toBeLessThan(gapFor('calm'));
    expect(gapFor('calm')).toBeGreaterThan(20); // long stretches of ambience
  });

  it('situation priority: guns beat weather beats landfall', () => {
    expect(musicStateFor({ weather: 'storm', landDistance: 10, combatHeat: 1 })).toBe('combat');
    expect(musicStateFor({ weather: 'storm', landDistance: 10, combatHeat: 0 })).toBe('storm');
    expect(musicStateFor({ weather: 'calm', landDistance: 10, combatHeat: 0 })).toBe('island');
    expect(musicStateFor({ weather: 'calm', combatHeat: 0 })).toBe('calm');
    expect(musicStateFor({ weather: 'swell', landDistance: Infinity, combatHeat: 0 })).toBe('calm');
  });
});

describe('combat ducking (music steps back under the guns)', () => {
  it('falls to the duck level fast and recovers slowly, staying in 0..1', () => {
    let d = duckHit({ level: 1, hold: 0 });
    for (let i = 0; i < 60; i++) d = stepDuck(d, 1 / 60); // 1 s of duck
    expect(d.level).toBeLessThan(0.5);
    expect(d.level).toBeGreaterThanOrEqual(audioParams.musicDuckLevel - 1e-6);
    const duckedAt1s = d.level;
    for (let i = 0; i < 60 * 20; i++) d = stepDuck(d, 1 / 60); // long silence after
    expect(d.hold).toBe(0);
    expect(d.level).toBeGreaterThan(0.99);
    // asymmetry is the point: 1 s of recovery must not undo 1 s of duck
    let r = { level: audioParams.musicDuckLevel, hold: 0 };
    for (let i = 0; i < 60; i++) r = stepDuck(r, 1 / 60);
    expect(1 - r.level).toBeGreaterThan(duckedAt1s - audioParams.musicDuckLevel);
  });

  it('a sustained broadside keeps it ducked instead of pumping between shots', () => {
    let d: DuckState = { level: 1, hold: 0 };
    for (let i = 0; i < 60 * 6; i++) {
      if (i % 45 === 0) d = duckHit(d); // a shot every 0.75 s
      d = stepDuck(d, 1 / 60);
      if (i > 60) expect(d.level).toBeLessThan(0.6); // never climbs back mid-fight
    }
  });
});

describe('level matching across tracks (streaming rules out scanning the file)', () => {
  it('pulls a loud track down and a quiet one up, within clamps', () => {
    const loud = agcStep(1, 0.5, 100);
    const quiet = agcStep(1, 0.01, 100);
    expect(loud).toBeLessThan(1);
    expect(loud).toBeGreaterThanOrEqual(audioParams.musicGainMin);
    expect(quiet).toBeGreaterThan(1);
    expect(quiet).toBeLessThanOrEqual(audioParams.musicGainMax);
  });

  it('is slow enough never to pump inside a track, and holds through silence', () => {
    const oneStep = agcStep(1, 0.5, audioParams.musicAgcIntervalSec);
    expect(1 - oneStep).toBeLessThan(0.1); // a quarter second barely moves it
    expect(agcStep(0.7, 0, 1)).toBe(0.7); // gap/silence: hold, do not wind up
    expect(agcStep(0.7, Number.NaN, 1)).toBe(0.7);
  });

  it('windowRms matches known signals', () => {
    expect(windowRms(new Float32Array(64).fill(0.5))).toBeCloseTo(0.5, 6);
    const sine = new Float32Array(1024).map((_, i) => Math.sin((i / 1024) * Math.PI * 2 * 8));
    expect(windowRms(sine)).toBeCloseTo(Math.SQRT1_2, 2);
    expect(windowRms(new Float32Array(0))).toBe(0);
  });
});

describe('the music bus (§I: a fourth independent volume)', () => {
  it('is clamped and settable like the others, before any AudioContext', () => {
    const engine = createEngine({ music: 5 });
    expect(engine.getVolumes().music).toBe(1);
    engine.setVolumes({ music: 0.35 });
    expect(engine.getVolumes()).toEqual({ master: 1, sfx: 1, ambience: 1, music: 0.35 });
  });

  it('a settings store WITHOUT a music key leaves the bus alone (UI lands separately)', () => {
    const engine = createEngine({ music: 0.6 });
    const legacyStore = {
      get: () => ({ audio: { master: 0.5, sfx: 0.5, ambience: 0.5 } }),
      subscribe: () => () => undefined,
    };
    attachAudioSettings(engine, legacyStore);
    expect(engine.getVolumes().music).toBe(0.6); // untouched, not reset to 1
    expect(engine.getVolumes().master).toBe(0.5);
  });

  it('music survives a reload independently of the other three buses', () => {
    const raw = new Map<string, string>();
    const storage: StorageLike = {
      getItem: (k) => raw.get(k) ?? null,
      setItem: (k, v) => void raw.set(k, v),
    };
    createSettingsStore(storage).set({ audio: { music: 0.2, master: 0.9 } });
    const engine = createEngine();
    attachAudioSettings(engine, createSettingsStore(storage));
    expect(engine.getVolumes().music).toBeCloseTo(0.2, 10);
    expect(engine.getVolumes().master).toBeCloseTo(0.9, 10);
    // and a live change to music alone must not disturb the rest
    const store = createSettingsStore(storage);
    attachAudioSettings(engine, store);
    store.set({ audio: { music: 0 } });
    expect(engine.getVolumes().music).toBe(0);
    expect(engine.getVolumes().master).toBeCloseTo(0.9, 10);
  });
});
