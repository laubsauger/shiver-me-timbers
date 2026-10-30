/**
 * Undertime's timeline stages the direction (drift-narrative/undertime/direction.md): silence →
 * overwhelming → silence → one thing → everything. On a dome a jump in density, light or camera at a beat
 * boundary changes the whole field of view at once — it reads as a pop, not a cut — so every value is
 * continuous. The camera path is held to comfort limits: a seated dome audience feels acceleration in the
 * stomach, so the eye drifts slowly, never jerks, and stands still where the direction says it does.
 */
import { describe, expect, it } from 'vitest';
import { driftParams } from '../src/params/drift';
import { BEATS, HERO_RUN, beatStarts, eyePath, fieldClock, heroPassTime, undertimeState, waveSweep, waveTimeAt } from '../src/drift/undertime/timeline';
import { phraseHold } from '../src/drift/undertime/crawl';
import { undertimeCrawl } from '../src/drift/undertime/crawlText';

const p = { ...driftParams };
const { starts, total } = beatStarts(p);
const KEYS = ['clock', 'clockRate', 'pairDensity', 'flashGain', 'glow', 'wave', 'build', 'lens', 'crest', 'frontGain', 'heroGrain', 'grains', 'scale', 'stars'] as const;
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

  it('the wave is the second peak and darkness follows it; the front leaves the one grain, the others come later', () => {
    expect(at('wave', 0.5).glow).toBeGreaterThan(at('cool', 1).glow);
    expect(at('remain', 0.1).glow).toBeLessThan(0.02);
    expect(at('remain', 0.2).pairDensity).toBe(0);
    // the hero grain is LEFT BY THE FRONT (the 2026-10-30 story note): nothing there until the front has passed its
    // spot, there for good before the wave is over
    const pass = heroPassTime(p);
    expect(pass).toBeGreaterThan(starts.wave);
    expect(undertimeState(pass, p).heroGrain).toBe(0);
    expect(at('wave', 1).heroGrain).toBeGreaterThan(0.9);
    expect(undertimeState(pass + HERO_RUN + 1, p).heroGrain).toBeCloseTo(1, 6);
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

/**
 * THE LIGHT WAVE AS A COLLAPSE (the 2026-10-30 review: "a better ramp into intensity … a total collapse of space and
 * time … too tame"). Its envelope must build tension and then hold a peak, inside the act's timing, and leave the
 * darkness the remainder needs. On a dome every one of these is felt by the whole room at once.
 */
describe('Undertime light wave envelope', () => {
  // the cooling's last phrase leaves the dome at its fade-out's end (crawl.ts: 0.9 s in, the hold, 1.1 s out)
  const lastPhraseGone = Math.max(
    ...undertimeCrawl(p).filter((ph) => ph.at < starts.wave).map((ph) => ph.at + 0.9 + phraseHold(ph) + 1.1),
  );

  it('the build waits for the text to leave, then accelerates into the front (tension, not a fade-in)', () => {
    expect(undertimeState(lastPhraseGone, p).build).toBe(0);
    const t0 = starts.wave - p.waveBuild;
    const mid = undertimeState(t0 + p.waveBuild / 2, p).build;
    const late = undertimeState(starts.wave - 0.5, p).build;
    // convex: there from the start, most of the rise in the last seconds
    expect(mid).toBeGreaterThan(0.15);
    expect(mid).toBeLessThan(0.4);
    expect(late).toBeGreaterThan(0.7);
    expect(undertimeState(starts.wave, p).build).toBeCloseTo(1, 6);
    for (let t = t0; t < starts.wave; t += 0.1) expect(undertimeState(t + 0.1, p).build).toBeGreaterThanOrEqual(undertimeState(t, p).build);
  });

  it('the front STALLS over the audience, and its crest holds while it does (the climax is the front itself)', () => {
    // the front's angular speed (frac/s) over the audience against its fastest
    const speed = (t: number): number => (undertimeState(t + 0.01, p).wave - undertimeState(t - 0.01, p).wave) / 0.02;
    const over = starts.wave + waveTimeAt(0.5, p.waveStall) * p.wave;
    let fastest = 0;
    for (let t = starts.wave + 0.05; t < starts.wave + p.wave - 0.05; t += 0.02) fastest = Math.max(fastest, speed(t));
    expect(speed(over)).toBeLessThan(0.5 * fastest);
    // and still moving: a stall, not a stop (a front that stops reads as a wall)
    expect(speed(over)).toBeGreaterThan(0.15 * fastest);
    let held = 0;
    let first = Infinity;
    let last = -Infinity;
    for (let t = starts.wave; t < starts.wave + p.wave; t += 0.01) {
      if (undertimeState(t, p).crest > 0.95) {
        held += 0.01;
        first = Math.min(first, t);
        last = Math.max(last, t);
      }
    }
    expect(held).toBeGreaterThan(1);
    expect(first).toBeLessThan(over);
    expect(last).toBeGreaterThan(over);
  });

  it('it is all over before the remainder: darkness first, the one grain singled out in it', () => {
    for (const k of ['build', 'lens', 'crest', 'frontGain'] as const) expect(undertimeState(starts.remain + 0.1, p)[k], k).toBeLessThan(1e-6);
    expect(undertimeState(starts.wave + p.wave - 1.2, p).crest).toBeLessThan(1e-6);
  });

  it('the front pulls hardest as it passes over the audience, and never more than waveLens', () => {
    const max = (p.waveLens * Math.PI) / 180;
    let peakT = 0;
    let peak = 0;
    for (let t = starts.cool; t < starts.remain; t += 0.02) {
      const l = undertimeState(t, p).lens;
      expect(l).toBeLessThanOrEqual(max + 1e-9);
      if (l > peak) [peak, peakT] = [l, t];
    }
    expect(peak).toBeGreaterThan(0.95 * max);
    // while it stalls over the audience
    expect(undertimeState(peakT, p).crest).toBeGreaterThan(0.9);
  });

  it('the inverse of the sweep is exact (the GPU freezes trails on the same curve the CPU kills pairs on)', () => {
    for (let k = 0; k <= 1; k += 0.01) expect(waveTimeAt(waveSweep(k, p.waveStall), p.waveStall)).toBeCloseTo(k, 6);
    // and the sweep only goes forward
    for (let k = 0; k < 1; k += 0.001) expect(waveSweep(k + 0.001, p.waveStall)).toBeGreaterThan(waveSweep(k, p.waveStall));
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
