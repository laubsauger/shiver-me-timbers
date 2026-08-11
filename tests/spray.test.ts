/**
 * Crest + bow spray invariants, verified against the CPU mirrors (sprayMath)
 * of the GPU passes. WHY each matters: spray must be deterministic (§V2 —
 * replay = identical visuals, no Math.random), must always burst UPWARD off
 * crests, must blow downwind in storms (§V7), must die on schedule, and the
 * bow burst must fire only when the hull actually punches through a wave at
 * speed — not fizz constantly at anchor.
 */
import { describe, expect, it } from 'vitest';
import {
  advanceBurstCursor,
  ageOpacity,
  bowLaunchVelocity,
  burstGate,
  dragFactorPerFrame,
  goldenSeed,
  inSpawnWindow,
  isDead,
  launchVelocity,
  respawnCandidate,
  sanitizePoolCount,
  stepParticle,
  type ParticleState,
} from '../src/foam/sprayMath';
import { sprayParams } from '../src/params/spray';
import { getParamsEntry } from '../src/params/registry';

const DT = 1 / 60; // §V2 fixed sim tick
const P = { launchSpeed: 4, lateralSpread: 0.4, windCarry: 0.6 };
const BOW = { bowLaunchSpread: 0.6, bowForwardKeep: 0.3 };
const seeds = Array.from({ length: 256 }, (_, i) => goldenSeed(i));

describe('respawn sampling (§V2 determinism, no Math.random)', () => {
  it('same (seed, time) → identical candidate; the spray field replays exactly', () => {
    expect(respawnCandidate(0.37, 12.5, 140)).toEqual(respawnCandidate(0.37, 12.5, 140));
  });

  it('different seeds and different times decorrelate candidates', () => {
    // WHY: correlated candidates would sample the same crest cells → visible
    // clumping instead of spray sprinkled across every breaking wave.
    const a = respawnCandidate(goldenSeed(1), 5, 140);
    const b = respawnCandidate(goldenSeed(2), 5, 140);
    const c = respawnCandidate(goldenSeed(1), 5 + DT, 140);
    expect(a).not.toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('candidates stay inside the spawn square (±extent/2)', () => {
    // WHY: the GPU samples cascade textures at the candidate — positions
    // outside the intended region would spawn spray behind the camera.
    for (const s of seeds) {
      const [x, z] = respawnCandidate(s, 3.3, 140);
      expect(Math.abs(x)).toBeLessThanOrEqual(70);
      expect(Math.abs(z)).toBeLessThanOrEqual(70);
    }
  });

  it('golden seeds are distinct and in [0, 1)', () => {
    expect(new Set(seeds).size).toBe(seeds.length);
    for (const s of seeds) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(1);
    }
  });
});

describe('crest launch velocity (§V6 upward burst, §V7 wind carry)', () => {
  it('always bursts upward: vy ∈ (0.5, 1] × launchSpeed for every seed', () => {
    // WHY: spray falling out of a crest (vy ≤ 0) reads as rain, not spray.
    for (const s of seeds) {
      const [, vy] = launchVelocity(s, 7.7, 0, 0, P);
      expect(vy).toBeGreaterThan(0.5 * P.launchSpeed);
      expect(vy).toBeLessThanOrEqual(P.launchSpeed);
    }
  });

  it('horizontal jitter is bounded by lateralSpread × launchSpeed (+ wind)', () => {
    for (const s of seeds) {
      const [vx, , vz] = launchVelocity(s, 7.7, 0, 0, P);
      expect(Math.hypot(vx, vz)).toBeLessThanOrEqual(P.lateralSpread * P.launchSpeed + 1e-12);
    }
  });

  it('wind shifts the burst downwind by windCarry × wind (§V7 storms)', () => {
    // WHY: storm spray visibly streaming downwind is a big §V20 look cue.
    for (const s of seeds.slice(0, 16)) {
      const calm = launchVelocity(s, 7.7, 0, 0, P);
      const windy = launchVelocity(s, 7.7, 10, 0, P);
      expect(windy[0] - calm[0]).toBeCloseTo(10 * P.windCarry, 10);
      expect(windy[2] - calm[2]).toBeCloseTo(0, 10);
    }
  });
});

describe('particle lifecycle (age, drag, gravity)', () => {
  const start = (): ParticleState => ({ pos: [0, 0, 0], vel: [1, 4, 0], age: 0 });

  it('dies after exactly life seconds of fixed ticks, opacity fading to 0', () => {
    const life = 1.4;
    const drag = dragFactorPerFrame(0.6, DT);
    let s = start();
    let prevOpacity = ageOpacity(s.age, life);
    let steps = 0;
    while (!isDead(s.age, life)) {
      s = stepParticle(s, 9.8, drag, DT, life);
      const o = ageOpacity(s.age, life);
      expect(o).toBeLessThanOrEqual(prevOpacity); // monotonic fade, no pop
      prevOpacity = o;
      steps++;
    }
    expect(steps).toBe(Math.ceil(life / DT));
    expect(ageOpacity(s.age, life)).toBe(0);
  });

  it('gravity arcs the particle: upward launch eventually falls', () => {
    // WHY: the SoT read is a burst that ARCS — straight-line confetti breaks it.
    const drag = dragFactorPerFrame(0.6, DT);
    let s = start();
    for (let i = 0; i < 120; i++) s = stepParticle(s, 9.8, drag, DT, 10);
    expect(s.vel[1]).toBeLessThan(0);
  });

  it('drag factor ∈ (0, 1] and dead particles are never integrated', () => {
    expect(dragFactorPerFrame(0, DT)).toBe(1);
    expect(dragFactorPerFrame(5, DT)).toBeGreaterThan(0);
    expect(dragFactorPerFrame(5, DT)).toBeLessThan(1);
    const dead: ParticleState = { pos: [1, 2, 3], vel: [1, 1, 1], age: 99 };
    expect(stepParticle(dead, 9.8, 0.9, DT, 1.4)).toBe(dead); // spawn pass's job
  });
});

describe('bow burst gate + budget (hull punching through waves)', () => {
  const G = { bowImmersionThreshold: 0.15, bowSpeedThreshold: 1.5 };

  it('fires only when BOTH immersion and speed exceed their thresholds', () => {
    // WHY: bobbing at anchor (immersed, slow) or planing on flat water
    // (fast, dry bow) must not fizz — spray marks punching through a wave.
    expect(burstGate(0.5, 5, G)).toBe(true);
    expect(burstGate(0.5, 1.0, G)).toBe(false); // slow
    expect(burstGate(0.05, 5, G)).toBe(false); // dry bow
    expect(burstGate(0.15, 1.5, G)).toBe(false); // at-threshold = closed
  });

  it('budget accumulates fractional rate deterministically and rotates the cursor', () => {
    // WHY: emission must equal bowBurstRate over time even when rate·dt is
    // fractional, and identical inputs must replay identically (§V2).
    let s = { cursor: 0, acc: 0 };
    let emitted = 0;
    for (let i = 0; i < 60; i++) {
      const r = advanceBurstCursor(s, 90, DT, 1024); // 1.5/frame
      s = { cursor: r.cursor, acc: r.acc };
      emitted += r.budget;
      expect([1, 2]).toContain(r.budget); // never 0, never a dump
    }
    expect(emitted).toBe(90); // exactly rate × 1s
    expect(s.cursor).toBe(90 % 1024);
  });

  it('spawn window admits exactly budget slots and wraps the pool', () => {
    const count = 8;
    const inWin = (i: number) => inSpawnWindow(i, 6, 3, count); // 6,7,0
    expect([0, 1, 2, 3, 4, 5, 6, 7].filter(inWin)).toEqual([0, 6, 7]);
  });
});

describe('bow launch velocity cone (outward + backward relative to ship)', () => {
  it('up component ∈ (0.5, 1] × ship speed; zero ship speed → zero burst', () => {
    for (const s of seeds.slice(0, 64)) {
      const [, vy] = bowLaunchVelocity(s, 2.2, 6, 0, BOW);
      expect(vy).toBeGreaterThan(3);
      expect(vy).toBeLessThanOrEqual(6);
    }
    expect(bowLaunchVelocity(0.5, 2.2, 0, 0, BOW)).toEqual([0, 0, 0]);
  });

  it('horizontal cone is bounded by (spread + forwardKeep) × speed', () => {
    for (const s of seeds.slice(0, 64)) {
      const [vx, , vz] = bowLaunchVelocity(s, 2.2, 6, 0, BOW);
      expect(Math.hypot(vx, vz)).toBeLessThanOrEqual(
        6 * (BOW.bowLaunchSpread + BOW.bowForwardKeep) + 1e-12,
      );
    }
  });

  it('spray falls behind the ship: forward component < ship speed', () => {
    // WHY: keeping only forwardKeep × velocity means the sheet arcs
    // backward RELATIVE TO THE SHIP — spray overtaking the bow looks wrong.
    for (const s of seeds.slice(0, 64)) {
      const [vx] = bowLaunchVelocity(s, 2.2, 6, 0, BOW); // ship moves +x
      expect(vx).toBeLessThan(6);
    }
  });

  it('flanks both sides of the bow across seeds', () => {
    // ship along +x → outboard is ±z; both signs must occur or the ship
    // would spray from one side only.
    const sides = seeds.slice(0, 64).map((s) => Math.sign(bowLaunchVelocity(s, 2.2, 6, 0, BOW)[2]));
    expect(sides).toContain(1);
    expect(sides).toContain(-1);
  });
});

describe('spray params (§V16 registered, bounded)', () => {
  it('registers under "spray"; every numeric default lies inside its meta bounds', () => {
    const entry = getParamsEntry('spray');
    expect(entry).toBeDefined();
    expect(entry!.params).toBe(sprayParams);
    for (const [key, value] of Object.entries(sprayParams)) {
      expect(typeof value).toBe('number');
      const meta = entry!.meta[key];
      expect(meta, `meta for ${key}`).toBeDefined();
      expect(value).toBeGreaterThanOrEqual(meta.min!);
      expect(value).toBeLessThanOrEqual(meta.max!);
    }
  });

  it('sizes honor the 0.2–0.6 m spec and sizeMin ≤ sizeMax', () => {
    expect(sprayParams.sizeMin).toBeGreaterThanOrEqual(0.2);
    expect(sprayParams.sizeMax).toBeLessThanOrEqual(0.6);
    expect(sprayParams.sizeMin).toBeLessThanOrEqual(sprayParams.sizeMax);
  });
});

describe('freeze-audit guards (NaN/dispatch hardening)', () => {
  it('pool count sanitizer: counts size buffers and dispatches at construction', () => {
    // WHY: a fractional/zero/NaN count would corrupt instancedArray
    // allocation or bake a dead dispatch — permanently, not per-frame.
    expect(sanitizePoolCount(4096, 1024)).toBe(4096);
    expect(sanitizePoolCount(100.7, 1024)).toBe(100);
    expect(sanitizePoolCount(0, 1024)).toBe(1);
    expect(sanitizePoolCount(-5, 1024)).toBe(1);
    expect(sanitizePoolCount(NaN, 1024)).toBe(1024);
    expect(sanitizePoolCount(Infinity, 1024)).toBe(1024);
  });

  it('drag guard math: only drag ≥ 0 keeps the velocity factor ≤ 1', () => {
    // WHY: factor > 1 is exponential velocity GROWTH — positions reach
    // Infinity in seconds and infinite sprite quads wedge the rasterizer.
    // The pool clamps drag to ≥ 0 before exp(); this pins the boundary.
    expect(dragFactorPerFrame(Math.max(0, -3), DT)).toBe(1);
    expect(dragFactorPerFrame(Math.max(0, 0.6), DT)).toBeLessThan(1);
  });

  it('age/opacity math stays finite for the guarded life floor', () => {
    // WHY: ageN = age/life feeds the sprite SCALE — a NaN there is a
    // screen-covering quad at additive blend × the whole pool (fill-rate
    // freeze). The pool floors life at 1e-3; verify the floor is NaN-free.
    const lifeFloor = Math.max(0, 1e-3);
    expect(Number.isFinite(ageOpacity(0, lifeFloor))).toBe(true);
    expect(ageOpacity(1, lifeFloor)).toBe(0); // long-dead → fully faded
  });
});
