/**
 * Undertime's timeline stages the direction (drift-narrative/undertime/direction.md): silence →
 * overwhelming → silence → one thing → everything. On a dome a jump in density, light or camera at a beat
 * boundary changes the whole field of view at once — it reads as a pop, not a cut — so every value is
 * continuous. The camera path is held to comfort limits: a seated dome audience feels acceleration in the
 * stomach, so the eye drifts slowly, never jerks, and stands still where the direction says it does.
 */
import { describe, expect, it } from 'vitest';
import { driftParams } from '../src/params/drift';
import { BEATS, beatStarts, eyePath, fieldClock, undertimeState } from '../src/drift/undertime/timeline';

const p = { ...driftParams };
const { starts, total } = beatStarts(p);
const KEYS = ['clock', 'clockRate', 'pairDensity', 'flashGain', 'glow', 'wave', 'heroGrain', 'grains', 'scale', 'afterglow', 'stars'] as const;
const at = (b: (typeof BEATS)[number], k: number) => undertimeState(starts[b] + p[b] * k, p);

describe('Undertime timeline', () => {
  it('names the beats in story order', () => {
    expect(undertimeState(0, p).beat).toBe('first');
    for (const b of BEATS) expect(at(b, 0.5).beat).toBe(b);
    expect(undertimeState(total + 1, p).beat).toBe('end');
  });

  it('opens on silence: no field pairs and no haze in the cold open (the hero pair is alone)', () => {
    for (let k = 0; k <= 1; k += 0.1) {
      expect(at('first', k).pairDensity).toBe(0);
      expect(at('first', k).glow).toBe(0);
    }
  });

  it('builds to the boil: a few pairs first, then everywhere (accelerating, not linear)', () => {
    expect(at('arise', 0.25).pairDensity).toBeLessThan(0.25 * 0.5);
    expect(at('arise', 1).pairDensity).toBeCloseTo(1, 6);
    expect(at('arise', 1).glow).toBeGreaterThan(at('cool', 1).glow);
  });

  it('time slows through the cooling and stays slow; the field clock never runs backward', () => {
    expect(at('arise', 0.5).clockRate).toBe(1);
    expect(at('wave', 0.5).clockRate).toBeCloseTo(p.slowRate, 9);
    let prev = -Infinity;
    for (let t = 0; t < total; t += 0.05) {
      const c = fieldClock(t, p);
      expect(c).toBeGreaterThan(prev);
      prev = c;
    }
  });

  it('the field clock is the integral of its rate (pairs move at the rate the HUD shows)', () => {
    for (let t = 0.5; t < total; t += 1.7) {
      const h = 1e-3;
      const slope = (fieldClock(t + h, p) - fieldClock(t - h, p)) / (2 * h);
      expect(slope).toBeCloseTo(undertimeState(t, p).clockRate, 3);
    }
  });

  it('the wave is the second peak and darkness follows it; the remainder appears only after', () => {
    expect(at('wave', 0.5).glow).toBeGreaterThan(at('cool', 1).glow);
    expect(at('remain', 0.1).glow).toBeLessThan(0.02);
    expect(at('remain', 0.2).pairDensity).toBe(0);
    expect(at('wave', 1).heroGrain).toBe(0);
    expect(at('wave', 1).grains).toBe(0);
    // one grain first, the others later
    expect(at('remain', 0.3).heroGrain).toBeGreaterThan(0.9);
    expect(at('remain', 0.3).grains).toBe(0);
    expect(at('remain', 1).grains).toBeCloseTo(1, 6);
  });

  it('pulls back through the decades, then the stars ignite', () => {
    expect(at('zoom', 0).scale).toBe(1);
    expect(at('zoom', 1).scale).toBeCloseTo(10 ** -p.zoomDecades, 9);
    expect(at('zoom', 1).stars).toBe(0);
    expect(at('gather', 1).stars).toBeCloseTo(1, 6);
  });

  it('the pull-back stays inside the comfort rate: under 0.35 e-folds of scale per second, eased at both ends', () => {
    // a Powers-of-Ten flight at 10× per 10 s is 0.23/s; dome guidance derived from it puts the optic flow
    // of a full surrounding field at ~13°/s there. We allow a little more (the field is sparse points)
    let peak = 0;
    const h = 1 / 60;
    for (let t = starts.zoom; t < starts.zoom + p.zoom; t += h) {
      const r = Math.abs(Math.log(undertimeState(t + h, p).scale) - Math.log(undertimeState(t, p).scale)) / h;
      peak = Math.max(peak, r);
    }
    expect(peak).toBeLessThan(0.35);
    expect(peak).toBeGreaterThan(0.2); // and it really is a pull-back, not a creep
    const early = Math.abs(Math.log(undertimeState(starts.zoom + h, p).scale)) / h;
    expect(early).toBeLessThan(0.01);
  });

  it('every value is continuous across every beat boundary', () => {
    for (const b of BEATS) {
      const t = starts[b];
      const before = undertimeState(t - 1e-6, p);
      const after = undertimeState(t + 1e-6, p);
      for (const k of KEYS) expect(Math.abs(after[k] - before[k]), `${k} at the start of ${b}`).toBeLessThan(1e-3);
    }
  });

  it('is a pure function of time: the same t gives the same frame', () => {
    for (let t = 0; t < total; t += 0.37) expect(undertimeState(t, p)).toEqual(undertimeState(t, p));
  });
});

describe('Undertime camera path', () => {
  const dt = 1 / 60;
  const vel = (t: number): number[] => {
    const a = eyePath(t - dt / 2, p);
    const b = eyePath(t + dt / 2, p);
    return [0, 1, 2].map((i) => (b[i] - a[i]) / dt);
  };
  const speed = (t: number): number => Math.hypot(...vel(t));

  it('stands still for the cold open and for the wave (the front does the moving)', () => {
    for (let k = 0.05; k < 1; k += 0.1) {
      expect(speed(starts.first + p.first * k)).toBeLessThan(1e-9);
      expect(speed(starts.wave + p.wave * k)).toBeLessThan(1e-6);
    }
  });

  it('drifts forward, never faster than driftSpeed, and moves the whole way continuously', () => {
    let max = 0;
    let prev = eyePath(0, p);
    for (let t = 0; t <= total; t += dt) {
      const e = eyePath(t, p);
      expect(Math.hypot(e[0] - prev[0], e[1] - prev[1], e[2] - prev[2])).toBeLessThan(p.driftSpeed * dt * 1.01 + 1e-9);
      max = Math.max(max, speed(t));
      prev = e;
    }
    expect(max).toBeGreaterThan(p.driftSpeed * 0.9);
    expect(eyePath(starts.wave, p)[2]).toBeLessThan(-1); // forward is −Z
  });

  it('never jerks: acceleration stays gentle (below 0.1 m/s²) for the whole act', () => {
    for (let t = dt; t < total; t += dt) {
      const a = vel(t - dt / 2);
      const b = vel(t + dt / 2);
      const acc = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / dt;
      expect(acc, `at t = ${t.toFixed(2)}`).toBeLessThan(0.1);
    }
  });
});
