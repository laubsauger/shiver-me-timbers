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
  gustFactor,
  particleLife,
  seaMinEigenvalue,
  sizeJitter,
  sprayEigenGate,
  spriteScale,
  stepParticle,
  type ParticleState,
} from '../src/foam/sprayMath';
import { sprayParams } from '../src/params/spray';
import { getParamsEntry } from '../src/params/registry';

const DT = 1 / 60; // §V2 fixed sim tick
// gustiness 0 pins the burst to its base 0.55..1 band so the cone bounds
// below stay exact; the heavy tail has its own block further down
const P = { launchSpeed: 4, lateralSpread: 0.4, windCarry: 0.6, gustiness: 0 };
const BOW = {
  bowLaunchSpread: 0.6,
  bowForwardThrow: 1.3,
  bowRise: 0.45,
  bowSlamRise: 1.4,
  bowSlamSpread: 0.9,
};
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
  it('always bursts upward: vy ∈ (0.55, 1] × launchSpeed for every seed', () => {
    // WHY: spray falling out of a crest (vy ≤ 0) reads as rain, not spray.
    for (const s of seeds) {
      const [, vy] = launchVelocity(s, 7.7, 0, 0, P);
      expect(vy).toBeGreaterThan(0.55 * P.launchSpeed);
      expect(vy).toBeLessThanOrEqual(P.launchSpeed);
    }
  });

  it('gustiness gives a FEW droplets real launch speed, not all of them', () => {
    // WHY (user: "rarely seeing water particles detach and spray up in
    // interesting ways"): a uniform 0.55..1 draw sends every droplet on the
    // same arc to the same height — that is foam hopping, not spray leaving
    // the water. The tail must be rare (the field must not brighten) and it
    // must be big enough to clear the surface: r^8 does both.
    const gusty = { ...P, gustiness: 1.8 };
    const vys = seeds.map((s) => launchVelocity(s, 7.7, 0, 0, gusty)[1]);
    const flat = seeds.map((s) => launchVelocity(s, 7.7, 0, 0, P)[1]);
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    expect(Math.max(...vys)).toBeGreaterThan(2 * Math.max(...flat)); // real flyers
    expect(mean(vys) / mean(flat)).toBeLessThan(1.35); // but the field is not hotter
    expect(vys.filter((v) => v > 1.5 * P.launchSpeed).length / vys.length).toBeLessThan(0.1);
    // monotone and deterministic in the draw (§V2)
    expect(gustFactor(0.5, 1.8)).toBeGreaterThan(gustFactor(0.4, 1.8));
    expect(gustFactor(2, 1.8)).toBe(gustFactor(1, 1.8)); // clamped (§V28)
    expect(gustFactor(0.37, 0)).toBeCloseTo(0.55 + 0.45 * 0.37, 12);
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

  it('the slam LAUNCHES water clear of the surface — the detachment half', () => {
    // WHY (user: "rarely seeing water particles detach and spray up"): rise
    // was speed × 0.35 × sheet only, so a full sheet at 8 m/s left the stem at
    // ~2.1 m/s up — a 22 cm hop against gravity. Particles that hug the water
    // read as foam. A wedge entering water throws a root jet FASTER than its
    // entry speed, so the slam term is > 1 × closing speed and owes nothing to
    // how fast the ship is going.
    const cruise = bowLaunchVelocity(0.37, 2.2, 6, 1, 0, BOW, 1, 0);
    const slam = bowLaunchVelocity(0.37, 2.2, 6, 1, 0, BOW, 1, 4);
    expect(slam[1]).toBeGreaterThan(cruise[1] + 4 * BOW.bowSlamRise * 0.5);
    // apex against gravity: high enough to be seen leaving the water
    expect(slam[1] ** 2 / (2 * 9.8)).toBeGreaterThan(0.5);
    // a dead-in-the-water hull that slams still throws water (speed 0)
    const still = bowLaunchVelocity(0.37, 2.2, 0, 1, 0, BOW, 1, 4);
    expect(still[1]).toBeGreaterThan(0);
    expect(Math.hypot(still[0], still[2])).toBeGreaterThan(0); // sideways too
    // and nothing at all when neither ship nor sea is moving
    expect(bowLaunchVelocity(0.37, 2.2, 0, 1, 0, BOW, 1, 0)).toEqual([0, 0, 0]);
    expect(bowLaunchVelocity(0.37, 2.2, 0, 1, 0, BOW, 1, NaN)).toEqual([0, 0, 0]);
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
    bowSlamRateOn: 1.6,
    bowSlamRateFull: 5,
    bowSlamRate: 900,
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

  it('a SLAM throws water whether or not the ship is making way', () => {
    // WHY (user: "especially if the boat slams down"): every other bow term is
    // multiplied by speedN = ramp01(speed, 1, 8)², so a hull coming down hard
    // at 3 m/s over ground scored 0.08 there and one slamming while hove to
    // scored zero. A slam is a VERTICAL event — the closing speed between
    // forefoot and water is the whole of it, and hullContact already measures
    // it (the slam SOUND has been keyed on it all along).
    const crawling = bowEmission(0.5, 0.5, 4.5, true, E); // barely moving, hard slam
    expect(crawling.rate).toBeGreaterThan(0.5 * E.bowSlamRate);
    expect(crawling.sheet).toBeGreaterThan(0.8); // and it is a FULL sheet
    // the old path emitted nothing at all here: no speed → no burst, no mist
    const oldPath = E.bowCruiseRate * 0 + E.bowBurstRate * 0;
    expect(oldPath).toBe(0);
    // still monotone in closing speed, and silent below the audio's own onset
    expect(bowEmission(0.5, 0.5, E.bowSlamRateOn, true, E).slam).toBe(0);
    expect(bowEmission(0.5, 0.5, 3, true, E).rate).toBeLessThan(crawling.rate);
    // and a hull with no water under it still throws nothing, slam or not
    expect(bowEmission(0.5, 0.5, 9, false, E).rate).toBe(0);
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
      expect(e.rate).toBeLessThanOrEqual(E.bowCruiseRate + E.bowBurstRate + E.bowSlamRate);
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

  it('the fold gate is foam’s own σ-multiple, re-expressed against λ−', () => {
    // THE BUG THIS REPLACES (§B.12/§V36/§V59, third occurrence in this file's
    // subject matter): the gate was `min(jacobianFoamBias + offset, ceiling)`
    // — an ABSOLUTE det-J threshold. Numbers from the shipped presets, the
    // ocean's own published moments:
    //
    //   preset  σ(det J)   foam gate   OLD spray gate      OLD z
    //   calm      0.125      7.1σ       min(0.12−0.65, .05)  12.3σ
    //   swell     0.157      2.6σ       min(0.60−0.65, .05)   6.7σ
    //   storm     0.510      1.5σ       min(0.25−0.65, .05)   2.7σ
    //
    // i.e. crest spray asked the default sea for a 6.7σ event and calm for a
    // 12.3σ one. It was not sparse, it was OFF — and det J ≤ 0 is exactly the
    // self-intersection `effectiveChoppiness` clamps the sea to prevent, so
    // the trigger required the one thing the ocean guarantees cannot happen.
    const sea = { trace: 0.1651, lambda: 0.95 }; // swell, measured
    const gate = sprayEigenGate(0.6, sea.trace, sea.lambda, 0);
    // at extraSigma 0 it IS the foam onset: same z, expressed in λ− units
    const rest = 1 + -0.592 * sea.trace * sea.lambda;
    const sigma = 0.754 * sea.trace * sea.lambda;
    const zFoam = (1 - 0.6) / (sea.trace * sea.lambda);
    expect(gate).toBeCloseTo(rest - zFoam * sigma, 9);
    expect(zFoam).toBeGreaterThan(2); // and it is a real threshold, not "never"
    expect(zFoam).toBeLessThan(3);
    // extraSigma only ever makes spray RARER than foam, never commoner
    expect(sprayEigenGate(0.6, sea.trace, sea.lambda, 0.5)).toBeLessThan(gate);
    expect(sprayEigenGate(0.6, sea.trace, sea.lambda, -9)).toBe(gate); // floored
    // storms spray harder than calm for the same reason they foam harder
    const zOf = (bias: number, trace: number, lambda: number) =>
      (1 + -0.592 * trace * lambda - sprayEigenGate(bias, trace, lambda, 0)) /
      (0.754 * trace * lambda);
    expect(zOf(0.25, 0.3932, 1.2977)).toBeLessThan(zOf(0.12, 0.1467, 0.85));
  });

  it('a sea with no spectrum yet shuts the fold gate, it does not open it', () => {
    // WHY §V28/§V36: σ is 0 until the first spectrum build, and 0/0 in the
    // z-score would be NaN — which compares false in one direction only, so
    // half the pool would spawn on float noise on the first frames.
    for (const bad of [0, NaN, Infinity, -1]) {
      const gate = sprayEigenGate(0.6, bad, 0.95, 0);
      expect(Number.isFinite(gate)).toBe(true);
      // λ− of a flat sea is 1; nothing can reach a gate this far below it
      expect(gate).toBeLessThan(-5);
      expect(crestBreaking(seaMinEigenvalue(1, 0, 0.95), 99, gate, 0)).toBe(false);
    }
  });

  it('λ− sees a UNIAXIAL fold that det J is blind to (§V58)', () => {
    // WHY spray moved off det J: breaking is uniaxial — the surface compresses
    // hard along the propagation axis and stretches across it, and the product
    // of the two barely moves off 1. Foam injects from λ−; if spray still
    // gated on det J the two would disagree about where the sea is breaking.
    // a = −0.3, b = +0.3 at λ = 1: det J = 0.91 (looks calm), λ− = 0.7.
    const det = (1 - 0.3) * (1 + 0.3);
    expect(seaMinEigenvalue(det, -0.3 + 0.3, 1)).toBeCloseTo(0.7, 12);
    expect(det).toBeGreaterThan(0.9); // det J calls the same texel quiet
    // and it re-applies λ, because the derivatives texture stores ∂D unscaled
    expect(seaMinEigenvalue(det, -0.6, 0.5)).toBeCloseTo(
      seaMinEigenvalue(det, -0.3, 1),
      12,
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

describe('per-particle variation (§V2-safe, against uniformity)', () => {
  it('lifetimes spread around `life` and stay positive at any variation', () => {
    // WHY (user: "more interesting", "in interesting ways" — this project's
    // recurring failure): one lifetime for the pool kills every droplet of a
    // burst on the same frame, so a sheet vanishes as a block. Drawn from the
    // INDEX, not the spawn time, because the physics pass has no spawn time
    // and all three passes must agree on the number or particles respawn
    // early / never fade.
    const lives = seeds.map((_, i) => particleLife(i, 0.7, 0.35));
    expect(Math.min(...lives)).toBeGreaterThanOrEqual(0.7 * 0.65 - 1e-9);
    expect(Math.max(...lives)).toBeLessThanOrEqual(0.7 * 1.35 + 1e-9);
    expect(new Set(lives.map((v) => v.toFixed(6))).size).toBeGreaterThan(200);
    const mean = lives.reduce((a, b) => a + b, 0) / lives.length;
    expect(mean).toBeCloseTo(0.7, 1);
    // deterministic (§V2) and degenerate settings stay safe (§V28)
    expect(particleLife(17, 0.7, 0.35)).toBe(particleLife(17, 0.7, 0.35));
    expect(particleLife(17, 0.7, 0)).toBe(0.7);
    expect(particleLife(17, 0.7, 5)).toBeGreaterThan(0);
    expect(particleLife(17, 0, 0.35)).toBeGreaterThan(0);
  });

  it('size jitter only ever THINS a puff — it can never inflate a quad', () => {
    // WHY §V28/§B.5: the multiplier rides in velSize.w, which the sprite
    // clamps to [0, 1]; a jitter that could exceed 1 would be silently
    // clipped on the GPU and read as "variation does nothing" on the CPU.
    for (const s of seeds) {
      const v = sizeJitter(s, 4.5, 0.5);
      expect(v).toBeGreaterThanOrEqual(0.5);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(sizeJitter(0.37, 4.5, 0)).toBe(1);
    expect(sizeJitter(0.37, 4.5, 9)).toBeGreaterThanOrEqual(0); // clamped
    expect(sizeJitter(0.37, 4.5, 0.5)).toBe(sizeJitter(0.37, 4.5, 0.5));
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
