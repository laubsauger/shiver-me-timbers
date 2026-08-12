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
  bowEmission,
  bowSpawnOffset,
  crestBreaking,
  crestHeightThreshold,
  distanceFade,
  dragFactorPerFrame,
  goldenSeed,
  inSpawnWindow,
  isDead,
  launchVelocity,
  respawnCandidate,
  sanitizePoolCount,
  spawnAccepted,
  sprayJacobianThreshold,
  spriteScale,
  stepParticle,
  type ParticleState,
} from '../src/foam/sprayMath';
import { sprayParams } from '../src/params/spray';
import { getParamsEntry } from '../src/params/registry';

const DT = 1 / 60; // §V2 fixed sim tick
const P = { launchSpeed: 4, lateralSpread: 0.4, windCarry: 0.6 };
const BOW = { bowLaunchSpread: 0.6, bowForwardThrow: 1.3, bowRise: 0.45 };
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

describe('bow emission budget (rate-bound, not pool-bound)', () => {
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

describe('bow launch velocity cone (thrown FORWARD + outboard off the cutwater)', () => {
  // heading +x, 6 m/s — the frame comes from the HULL, not from the track
  const launch = (s: number, sheet = 1) => bowLaunchVelocity(s, 2.2, 6, 1, 0, BOW, sheet);

  it('up component ≤ bowRise × speed × sheet; zero speed → zero burst', () => {
    for (const s of seeds.slice(0, 64)) {
      const [, vy] = launch(s);
      expect(vy).toBeGreaterThan(0);
      expect(vy).toBeLessThanOrEqual(6 * BOW.bowRise + 1e-12);
    }
    expect(bowLaunchVelocity(0.5, 2.2, 0, 1, 0, BOW)).toEqual([0, 0, 0]);
  });

  it('LEADS the bow: forward component can exceed ship speed', () => {
    // WHY (user: "we don't have a bow wake that actually pushes water or
    // spray forward"): with throw ≤ 1 every droplet falls astern of the stem
    // within a frame and the bow reads perfectly clean. Throw > 1 means the
    // sheet outruns the hull — water visibly pushed ahead of the cutwater.
    const fwd = seeds.slice(0, 64).map((s) => launch(s)[0]);
    expect(Math.max(...fwd)).toBeGreaterThan(6);
    expect(Math.min(...fwd)).toBeGreaterThan(0); // never thrown backward
    expect(sprayParams.bowForwardThrow).toBeGreaterThan(1);
  });

  it('horizontal cone is bounded by (spread + throw) × speed', () => {
    for (const s of seeds.slice(0, 64)) {
      const [vx, , vz] = launch(s);
      expect(Math.hypot(vx, vz)).toBeLessThanOrEqual(
        6 * (BOW.bowLaunchSpread + BOW.bowForwardThrow) + 1e-12,
      );
    }
  });

  it('the ejection frame follows the HEADING, not a world axis', () => {
    // WHY (user: "flows in a little bit of a weird angle"): rotate the hull
    // and the whole cone must rotate with it — same speeds, rotated basis.
    const a = launch(0.37); // heading +x
    const b = bowLaunchVelocity(0.37, 2.2, 6, 0, 1, BOW); // heading +z
    expect(b[2]).toBeCloseTo(a[0], 12); // forward component follows heading
    expect(b[0]).toBeCloseTo(-a[2], 12); // outboard rotates with it
    expect(b[1]).toBeCloseTo(a[1], 12); // rise is heading-independent
  });

  it('sheet lifts the spray; a cruising stem throws it flat and forward', () => {
    // WHY (user: bow spray "too small", wants size tied to how hard the bow
    // buried): only the RISE scales with the sheet — the forward shove is
    // ship speed either way, so cruise mist still leads the bow.
    const full = launch(0.37, 1);
    const cruise = launch(0.37, 0.35);
    expect(cruise[1]).toBeCloseTo(full[1] * 0.35, 12);
    expect(cruise[0]).toBeCloseTo(full[0], 12); // forward shove unchanged
    expect(cruise[2]).toBeCloseTo(full[2], 12);
    expect(launch(0.37, -3)[1]).toBe(0); // clamped, never fired downward
    expect(launch(0.37, 9)).toEqual(full); // and never amplified (§V28)
  });

  it('flanks both sides of the bow across seeds', () => {
    // heading +x → outboard is ±z; both signs must occur or the ship
    // would spray from one side only.
    const sides = seeds.slice(0, 64).map((s) => Math.sign(launch(s)[2]));
    expect(sides).toContain(1);
    expect(sides).toContain(-1);
  });
});

describe('bow emission regimes (constant cutwater mist + impact sheets)', () => {
  const E = {
    bowImmersionThreshold: 0.02,
    bowImmersionFull: 0.45,
    bowSpeedThreshold: 1.0,
    bowSpeedFull: 8.0,
    bowImpactRef: 0.6,
    bowContactDepth: 0.12,
    bowSpeedExponent: 2,
    bowBurstRate: 600,
    bowCruiseRate: 200,
    bowCruiseSheet: 0.35,
  };

  it('mists continuously while making way — as long as the stem is IN the water', () => {
    // WHY (user: "we need a constant little bow wake whenever we're moving"):
    // a hull at speed always works water at the stem, so shallow contact must
    // still emit. But it is CONTACT, not motion, that licenses the mist.
    // barely wetted stem (below the burst threshold) but touching: mist only
    const cruise = bowEmission(0.02, 6, 0, true, E);
    expect(cruise.rate).toBeGreaterThan(0);
    expect(cruise.sheet).toBeCloseTo(E.bowCruiseSheet, 12); // mist, not sheet
  });

  it('an AIRBORNE bow throws nothing — the detachment defect', () => {
    // WHY (user: "we see it detach when we're lifting out of the water… it
    // comes out from something that is in the air, where there's nothing
    // touching the water"). Full speed, mid-trough, no station in contact:
    // emission must be exactly zero, not merely reduced.
    expect(bowEmission(0, 8, 0, false, E).rate).toBe(0);
    expect(bowEmission(0.9, 8, 2, false, E).rate).toBe(0); // even mid-slam data
    // and with contact but zero immersion, the contact ramp still floors it
    expect(bowEmission(0, 8, 0, true, E).rate).toBe(0);
  });

  it('is silent at rest — no fizzing at anchor', () => {
    expect(bowEmission(0.9, 0, 0, true, E).rate).toBe(0);
    expect(bowEmission(0.9, 1.0, 0, true, E).rate).toBe(0); // at speed threshold
  });

  it('a hard burial emits more AND bigger than a slow one', () => {
    // WHY: "let the size relate to how hard the bow just buried (impact
    // velocity × immersion depth)" — both rate and sheet must respond.
    const slow = bowEmission(0.6, 6, 0, true, E);
    const slam = bowEmission(0.6, 6, 2.0, true, E);
    expect(slam.rate).toBeGreaterThan(slow.rate);
    expect(slam.sheet).toBeGreaterThan(slow.sheet);
    // a FULL sheet needs a hard burial AND real speed — at 6 kn even a solid
    // slam throws a partial sheet, which is the whole point of the exponent
    expect(slam.sheet).toBeLessThan(1);
    expect(bowEmission(0.6, 12, 2.0, true, E).sheet).toBe(1);
    expect(slow.rate).toBeGreaterThan(bowEmission(0, 6, 0, true, E).rate); // depth counts
  });

  it('rate and sheet stay bounded and finite for absurd inputs (§V28)', () => {
    for (const [imm, spd, rate] of [
      [1e6, 1e6, 1e6],
      [-5, -5, -5],
      [NaN, NaN, NaN],
    ]) {
      const e = bowEmission(imm, spd, rate, true, E);
      expect(Number.isFinite(e.rate)).toBe(true);
      expect(e.rate).toBeGreaterThanOrEqual(0);
      expect(e.rate).toBeLessThanOrEqual(E.bowCruiseRate + E.bowBurstRate);
      expect(e.sheet).toBeGreaterThanOrEqual(0);
      expect(e.sheet).toBeLessThanOrEqual(1);
    }
  });
});

describe('cutwater emission line (spray leaves the hull, not a point)', () => {
  const O = { bowSideOffset: 1.0, bowStemLength: 2.0 };

  it('runs AFT of the crossing and out to both flanks, never ahead of it', () => {
    // WHY (user: spray "comes out from something that is in the air"): the
    // emitter sits where the hull ENTERS the water, and the hull shoulders
    // water backward from there along its immersed length. Seeding ahead of
    // the crossing puts droplets in mid-air in front of the stem. Water is
    // pushed forward by the launch VELOCITY, not by spawning it out front.
    const offs = seeds.slice(0, 64).map((s) => bowSpawnOffset(s, 2.2, 1, 0, O));
    // ship forward = +x → stem run is −x (aft), flanks are ±z
    expect(Math.max(...offs.map((o) => o[0]))).toBeLessThanOrEqual(0);
    expect(Math.min(...offs.map((o) => o[0]))).toBeLessThan(-0.5);
    expect(Math.max(...offs.map((o) => o[1]))).toBeGreaterThan(0);
    expect(Math.min(...offs.map((o) => o[1]))).toBeLessThan(0);
    for (const [ox, oz] of offs) {
      expect(Math.abs(oz)).toBeLessThanOrEqual(O.bowSideOffset + 1e-12);
      expect(Math.abs(ox)).toBeLessThanOrEqual(O.bowStemLength + 1e-12);
    }
  });

  it('is deterministic in (seed, time) like every other spray draw (§V2)', () => {
    expect(bowSpawnOffset(0.37, 2.2, 1, 0, O)).toEqual(bowSpawnOffset(0.37, 2.2, 1, 0, O));
    expect(bowSpawnOffset(0.37, 2.2, 1, 0, O)).not.toEqual(bowSpawnOffset(0.41, 2.2, 1, 0, O));
  });

  it('rotates with the heading — the line follows the hull, not world axes', () => {
    const a = bowSpawnOffset(0.37, 2.2, 1, 0, O); // heading +x
    const b = bowSpawnOffset(0.37, 2.2, 0, 1, O); // heading +z
    expect(b[1]).toBeCloseTo(a[0], 12);
    expect(b[0]).toBeCloseTo(-a[1], 12);
  });
});

describe('crest spawn gating (§V6 — only genuinely breaking crests spray)', () => {
  it('needs a FOLDING jacobian and a crest top, not merely low jacobian', () => {
    // WHY (user: white dots "all over the place", a snow globe over the whole
    // ocean): the jacobian dips below the foam bias across most of a choppy
    // sea. Spray marks water actually tearing off a wave TOP — both gates.
    expect(crestBreaking(-0.2, 1.5, -0.1, 1.4)).toBe(true);
    expect(crestBreaking(0.3, 1.5, -0.1, 1.4)).toBe(false); // foamy, not folding
    expect(crestBreaking(-0.2, 0.2, -0.1, 1.4)).toBe(false); // fold in a trough
  });

  it('threshold tracks the foam bias (§V7) but is CEILED at physical sense', () => {
    // WHY: storm lowers the bar for foam on purpose, and spray should follow —
    // but the storm preset sets jacobianFoamBias to 0.9, i.e. "compressed by
    // 10%", which is nearly the entire sea. Uncapped that is a blizzard.
    expect(sprayJacobianThreshold(0.55, -0.65, 0.05)).toBeCloseTo(-0.1, 12);
    expect(sprayJacobianThreshold(0.9, -0.65, 0.05)).toBeCloseTo(0.05, 12);
    expect(sprayJacobianThreshold(2.0, 0, 0.05)).toBe(0.05); // never runaway
    // storms still spray harder than calm, just not unboundedly
    expect(sprayJacobianThreshold(0.12, -0.65, 0.05)).toBeLessThan(
      sprayJacobianThreshold(0.55, -0.65, 0.05),
    );
  });

  it('height gate is a MULTIPLE OF σ, never metres (§V36)', () => {
    // WHY: a metre constant silently changes meaning whenever the swell is
    // retuned — 1.4 m was a rare breaking crest at one spectrum and an
    // ordinary wave top at the next. σ is the sea's own height statistic, so
    // 1.5σ selects the same fraction of crests in calm, swell and storm.
    expect(crestHeightThreshold(1.5, 0.703)).toBeCloseTo(1.0545, 6);
    // doubling the sea doubles the bar — the gate stays equally selective
    expect(crestHeightThreshold(1.5, 1.4)).toBeCloseTo(2 * crestHeightThreshold(1.5, 0.7), 12);
    // and it must never gate on `amplitude`, which moves the OTHER way:
    // amplitude fell 0.75 → 0.32 while significant wave height rose 2.3 → 2.8
  });

  it('an unbuilt spectrum shuts the gate rather than passing everything', () => {
    // WHY §V28: σ is 0 until the first spectrum build. A zero threshold would
    // pass every candidate above sea level — the whole ocean spraying on the
    // first frames — and NaN would compare false in one direction only.
    expect(crestHeightThreshold(1.5, 0)).toBe(Infinity);
    expect(crestHeightThreshold(1.5, NaN)).toBe(Infinity);
    expect(crestHeightThreshold(NaN, 0.7)).toBe(Infinity);
    expect(crestBreaking(-0.5, 99, -0.1, crestHeightThreshold(1.5, 0))).toBe(false);
  });

  it('lottery thins each breaking band, deterministically (§V2)', () => {
    // WHY: without it a single breaking crest drains the whole pool in one
    // tick and reads as a solid white slab instead of a spatter.
    const roll = seeds.slice(0, 256).filter((s) => spawnAccepted(s, 3.5, 0.25));
    expect(roll.length).toBeGreaterThan(20);
    expect(roll.length).toBeLessThan(120);
    expect(spawnAccepted(0.37, 3.5, 0.25)).toBe(spawnAccepted(0.37, 3.5, 0.25));
    expect(seeds.filter((s) => spawnAccepted(s, 3.5, 0)).length).toBe(0);
    expect(seeds.filter((s) => spawnAccepted(s, 3.5, 1)).length).toBe(seeds.length);
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

  it('sprites stay mist-scale: sub-half-metre puffs that grow, never balls', () => {
    // WHY (user: "the foam particles are way too big"): a droplet cluster is
    // centimetres-to-decimetres across. Metre-wide sprites read as opaque
    // bouncy spheres, which is exactly what the first live run showed.
    expect(sprayParams.sizeMin).toBeLessThanOrEqual(0.15);
    expect(sprayParams.sizeMax).toBeLessThanOrEqual(0.5);
    expect(sprayParams.sizeMin).toBeLessThanOrEqual(sprayParams.sizeMax);
    expect(sprayParams.opacity).toBeLessThanOrEqual(0.35); // additive mist
    expect(sprayParams.softness).toBeGreaterThan(1); // soft edge, not a disc
  });

  it('spawns clear of the water: the surface WRITES DEPTH, coplanar dies', () => {
    // WHY: the ocean surface switched to depthWrite = true. A sprite born
    // exactly on the surface z-fights it and gets depth-rejected at the
    // grazing angles this camera lives at — the effect silently thins out.
    // Both emitters must clear roughly half a sprite of their own size class.
    expect(sprayParams.spawnLift).toBeGreaterThan(sprayParams.sizeMin / 2);
    expect(sprayParams.bowSpawnLift).toBeGreaterThan(
      (sprayParams.sizeMin * sprayParams.bowSizeScale) / 2,
    );
  });

  it('spray is a NEAR-FIELD effect: fadeNear < fadeFar, both short', () => {
    // WHY: sprites stippled out to the horizon read as snow, and far crests
    // already carry painted foam. Beyond fadeFar the pool draws nothing.
    expect(sprayParams.fadeNear).toBeLessThan(sprayParams.fadeFar);
    expect(sprayParams.fadeFar).toBeLessThanOrEqual(sprayParams.spawnExtent);
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

  it('invisible sprites are ZERO SIZE, never alpha-0 quads (§V28/§B.5)', () => {
    // WHY: 4096 alpha-0 additive quads still rasterize every fragment. The
    // NaN-scale wedge that looked like a Chrome hang came from this path, so
    // both the dead case and the faded-out case must collapse to exactly 0.
    expect(spriteScale(1, 1, 0.08, 0.32)).toBe(0); // dead
    expect(spriteScale(0.5, 0, 0.08, 0.32)).toBe(0); // beyond fadeFar
    expect(spriteScale(NaN, 1, 0.08, 0.32)).toBe(0); // NaN age (§B.5)
    expect(spriteScale(0, 1, 0.08, 0.32)).toBeCloseTo(0.08, 12);
    expect(spriteScale(1 - 1e-9, 1, 0.08, 0.32)).toBeGreaterThan(0.31);
    expect(spriteScale(0, 1, 0.08, 0.32, 1.4)).toBeCloseTo(0.112, 12);
  });

  it('distance fade is full near, dead far, and NaN-free at degenerate ranges', () => {
    expect(distanceFade(0, 25, 55)).toBe(1);
    expect(distanceFade(25, 25, 55)).toBe(1);
    expect(distanceFade(55, 25, 55)).toBe(0);
    expect(distanceFade(1e4, 25, 55)).toBe(0);
    expect(distanceFade(40, 25, 55)).toBeGreaterThan(0);
    expect(distanceFade(40, 25, 55)).toBeLessThan(1);
    // far ≤ near must be floored, not divided by (§V28)
    expect(Number.isFinite(distanceFade(30, 50, 50))).toBe(true);
    expect(Number.isFinite(distanceFade(30, 50, 10))).toBe(true);
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
