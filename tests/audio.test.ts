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
