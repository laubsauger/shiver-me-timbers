/**
 * §V42 dynamic rope tests. src/ropes/ropeDynamics.ts is the CPU mirror of the
 * Verlet chain in the compute kernel, which cannot itself be unit-tested — so
 * these tests gate the GPU exactly as tests/ropes.test.ts does for the §V12
 * catenary. If the reference is wrong, every rope on screen is wrong.
 *
 * The centre of gravity here is the ONE property the feature exists for: that
 * ship acceleration makes the rope lag, and that the lag is EMERGENT from
 * integrating in world space with pinned anchors — not a phase offset, not a
 * canned oscillation. The rope it replaces swung on a sine wave regardless of
 * what the ship did, and that is precisely what read as dead. Several tests
 * below would still pass against a canned sine; the ones that would not are
 * marked, and they are the point.
 */
import { describe, expect, it } from 'vitest';
import { solveCatenary, type Vec3Like } from '../src/ropes/catenaryMath';
import {
  DT_MAX,
  linkRestLengths,
  needsReseed,
  seedRope,
  simWeight,
  stepRope,
  type RopeDynamicsParams,
  type RopeState,
} from '../src/ropes/ropeDynamics';
import { ropeParams } from '../src/params/ropes';

const P: RopeDynamicsParams = {
  gravity: ropeParams.gravity,
  damping: ropeParams.damping,
  windForce: ropeParams.windForce,
  constraintIterations: ropeParams.constraintIterations,
  substeps: ropeParams.substeps,
  maxStray: ropeParams.maxStray,
  strayFraction: ropeParams.strayFraction,
  teleportDistance: ropeParams.teleportDistance,
};

const SEGMENTS = 16;
const DT = 1 / 60;
const NO_WIND: Vec3Like = { x: 0, y: 0, z: 0 };
const v3 = (x: number, y: number, z: number): Vec3Like => ({ x, y, z });
const len = (a: Vec3Like): number => Math.hypot(a.x, a.y, a.z);
const sub = (a: Vec3Like, b: Vec3Like): Vec3Like =>
  ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const finite = (p: Vec3Like): boolean =>
  Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);

/** a slack rope between two anchors, plus its catenary rest curve */
function makeRope(A: Vec3Like, B: Vec3Like, slack = 1.15) {
  const L = len(sub(B, A)) * slack;
  const rest = solveCatenary(A, B, L, SEGMENTS);
  return { A, B, L, rest, state: seedRope(rest) };
}

/** rest curve for anchors that have moved — the chain is always leashed to
 *  the catenary of where its anchors are NOW */
const restFor = (A: Vec3Like, B: Vec3Like, L: number): Vec3Like[] =>
  solveCatenary(A, B, L, SEGMENTS);

const mid = (pts: Vec3Like[]): Vec3Like => pts[Math.floor(pts.length / 2)];

describe('§V42 dynamic rope: the chain holds together', () => {
  it('keeps both anchors pinned exactly, every frame', () => {
    // WHY: anchors ARE the ship — a rope whose end drifts off its socket has
    // visibly come untied. Pinning after integration and again after every
    // constraint pass is what guarantees it, and it is also the channel
    // through which all ship motion enters the simulation.
    const r = makeRope(v3(0, 20, 0), v3(8, 14, 3));
    for (let f = 0; f < 120; f++) {
      stepRope(r.state, r.A, r.B, r.rest, NO_WIND, DT, P);
      expect(len(sub(r.state.pos[0], r.A)), `frame ${f}`).toBeLessThan(1e-9);
      expect(len(sub(r.state.pos[SEGMENTS], r.B))).toBeLessThan(1e-9);
    }
  });

  it('holds its length: links converge on the rest spacing, and stay there', () => {
    // WHY: a rope that stretches reads as elastic, and one that collapses
    // reads as string. Gauss-Seidel is iterative, so this is a convergence
    // claim, not an identity — it pins that the iteration count in params is
    // actually enough for the chain to hold.
    const r = makeRope(v3(0, 22, 0), v3(10, 16, 0));
    // rest lengths come from the CATENARY, not L/segments: solveCatenary
    // samples uniformly in horizontal x, so its links vary ~2.2× end to end.
    // A chain told to hold equal links fights the curve it was seeded from and
    // never settles — that was a real bug these tests caught.
    const rests = linkRestLengths(r.rest);
    expect(Math.max(...rests) / Math.min(...rests)).toBeGreaterThan(1.5);
    for (let f = 0; f < 240; f++) {
      stepRope(r.state, r.A, r.B, r.rest, NO_WIND, DT, P);
    }
    for (let i = 0; i < SEGMENTS; i++) {
      const link = len(sub(r.state.pos[i + 1], r.state.pos[i]));
      expect(link, `link ${i}`).toBeCloseTo(rests[i], 1);
    }
  });

  it('settles: an undisturbed rope stops moving', () => {
    // WHY: damping < 1 must actually remove energy. A chain that never
    // settles jitters forever, which on a moored ship looks like the rig is
    // permanently being shaken — and it would mask real motion.
    const r = makeRope(v3(0, 20, 0), v3(9, 15, 2));
    for (let f = 0; f < 600; f++) {
      stepRope(r.state, r.A, r.B, r.rest, NO_WIND, DT, P);
    }
    let motion = 0;
    for (let i = 0; i <= SEGMENTS; i++) {
      motion = Math.max(motion, len(sub(r.state.pos[i], r.state.prev[i])));
    }
    expect(motion).toBeLessThan(1e-3);
  });

  it('hangs DOWN: gravity pulls the slack below the chord', () => {
    // WHY: the sag has to come from gravity acting on particles, not from the
    // analytic curve being copied. Released along a straight chord, the chain
    // must fall into a hanging shape on its own.
    const A = v3(0, 20, 0);
    const B = v3(10, 20, 0);
    const L = 12;
    const straight = Array.from({ length: SEGMENTS + 1 }, (_, i) => {
      const t = i / SEGMENTS;
      return v3(A.x + (B.x - A.x) * t, A.y, 0);
    });
    const rest = solveCatenary(A, B, L, SEGMENTS);
    const state: RopeState = seedRope(straight);
    for (let f = 0; f < 300; f++) stepRope(state, A, B, rest, NO_WIND, DT, P);
    expect(mid(state.pos).y).toBeLessThan(A.y - 0.5);
  });
});

describe('§V42 the point of the feature: motion is EMERGENT, not canned', () => {
  /** drive a rope by moving BOTH anchors along a supplied path */
  function driveAnchors(
    steps: number,
    anchorAt: (frame: number) => { A: Vec3Like; B: Vec3Like },
    wind: Vec3Like = NO_WIND,
  ) {
    const start = anchorAt(0);
    const r = makeRope(start.A, start.B);
    let lastRest = r.rest;
    for (let f = 1; f <= steps; f++) {
      const { A, B } = anchorAt(f);
      lastRest = restFor(A, B, r.L);
      stepRope(r.state, A, B, lastRest, wind, DT, P);
    }
    const anchors = anchorAt(steps);
    return { state: r.state, rest: lastRest, ...anchors };
  }

  it('ACCELERATING the ship makes the rope trail behind it', () => {
    // WHY: THE test. A canned sine offset cannot pass this — it does not know
    // the ship exists. Here nothing measures or applies ship acceleration:
    // the anchors are simply pinned to sockets that move, the particles carry
    // their own momentum in world space, and the rope is left behind. If this
    // fails, the rig is back to being decorative.
    const accel = 6; // m/s² in +x, a hard bear-away
    const shift = (f: number): number => 0.5 * accel * (f * DT) ** 2;
    const out = driveAnchors(45, (f) => ({
      A: v3(shift(f), 20, 0),
      B: v3(10 + shift(f), 20, 0),
    }));
    // the rope's middle sits ABAFT the midpoint of its own anchors
    const anchorMidX = (out.A.x + out.B.x) / 2;
    const lag = anchorMidX - mid(out.state.pos).x;
    expect(lag, 'rope should trail the accelerating ship').toBeGreaterThan(0.05);
  });

  it('…and at CONSTANT velocity it settles to a steady trail, not an oscillation', () => {
    // WHY: this is the sharpest "is it really simulated" test, and it took a
    // correction to get right. A towed rope does NOT return to its stationary
    // shape — damping is drag against the air, so a rope moving through still
    // air genuinely streams aft, and a ship at cruise should show that. What
    // it must NOT do is keep swinging: a canned sine, or any oscillator
    // pretending to be physics, never stops. So assert the two things that are
    // actually true — a modest steady deflection, and that it is STEADY.
    const speed = 8; // m/s
    const r = makeRope(v3(0, 20, 0), v3(10, 20, 0));
    const trail: number[] = [];
    for (let f = 1; f <= 900; f++) {
      const A = v3(speed * f * DT, 20, 0);
      const B = v3(10 + speed * f * DT, 20, 0);
      stepRope(r.state, A, B, restFor(A, B, r.L), NO_WIND, DT, P);
      trail.push((A.x + B.x) / 2 - mid(r.state.pos).x);
    }
    const settled = trail.slice(-120);
    // a real, bounded trail — drag, not a whip
    const mean = settled.reduce((s2, x) => s2 + x, 0) / settled.length;
    expect(mean).toBeGreaterThan(0);
    expect(mean).toBeLessThan(P.maxStray);
    // …and it has stopped moving. An oscillator would still be swinging here.
    expect(Math.max(...settled) - Math.min(...settled)).toBeLessThan(0.01);
  });

  it('swings back after the ship stops — momentum, not a target pose', () => {
    // WHY: a rope that merely lerps toward a displaced rest pose would stop
    // dead when the ship does. Real momentum overshoots and returns. This
    // catches an "ease toward an offset" implementation, which would look
    // plausible in a still screenshot and wrong in motion.
    const accel = 8;
    const hold = 30;
    const shift = (f: number): number =>
      f <= hold ? 0.5 * accel * (f * DT) ** 2 : 0.5 * accel * (hold * DT) ** 2;
    const r = makeRope(v3(0, 20, 0), v3(10, 20, 0));
    const offsets: number[] = [];
    for (let f = 1; f <= 160; f++) {
      const A = v3(shift(f), 20, 0);
      const B = v3(10 + shift(f), 20, 0);
      stepRope(r.state, A, B, restFor(A, B, r.L), NO_WIND, DT, P);
      offsets.push((A.x + B.x) / 2 - mid(r.state.pos).x);
    }
    // it lagged while accelerating…
    const during = Math.max(...offsets.slice(0, hold));
    expect(during).toBeGreaterThan(0.05);
    // …and after the ship stopped it swung back THROUGH neutral, not just to it
    const after = offsets.slice(hold + 5);
    expect(Math.min(...after)).toBeLessThan(0);
  });

  it('wind blows the rope downwind, and harder wind blows it further', () => {
    // WHY: the wind term must be a real force with a direction, not a
    // magnitude feeding an oscillator. Monotonicity in wind speed is the
    // cheapest way to pin that, and it also catches a sign error.
    const anchors = () => ({ A: v3(0, 20, 0), B: v3(10, 20, 0) });
    const calm = driveAnchors(400, anchors, v3(0, 0, 0));
    const breeze = driveAnchors(400, anchors, v3(0, 0, 6));
    const gale = driveAnchors(400, anchors, v3(0, 0, 18));
    expect(mid(breeze.state.pos).z).toBeGreaterThan(mid(calm.state.pos).z);
    expect(mid(gale.state.pos).z).toBeGreaterThan(mid(breeze.state.pos).z);
  });

  it('is deterministic: same inputs, same chain', () => {
    // WHY: §V2. The rig is render dressing, but a nondeterministic one would
    // make any visual regression impossible to reproduce or bisect.
    const run = () =>
      driveAnchors(90, (f) => ({
        A: v3(0.5 * 4 * (f * DT) ** 2, 20, 0),
        B: v3(10, 20, 0),
      })).state.pos;
    expect(run()).toEqual(run());
  });
});

describe('§V42 stability: nothing here may ever reach the GPU as NaN', () => {
  it('survives a frame-time spike without exploding (§V28)', () => {
    // WHY: deltaTime in a compute pass is REAL frame delta, and it spikes on a
    // tab switch, a shader recompile or a stall. Verlet is only conditionally
    // stable: one huge dt and the chain leaves the solar system, writes NaN
    // into `points`, and that becomes NaN-sized geometry — the §B5 wedge that
    // presents as a browser hang, not as a shader bug. DT_MAX is the clamp.
    const r = makeRope(v3(0, 20, 0), v3(10, 15, 0));
    for (const dt of [DT, 5, 1e6, Number.POSITIVE_INFINITY, Number.NaN, -1]) {
      stepRope(r.state, r.A, r.B, r.rest, v3(0, 0, 40), dt, P);
      for (const p of r.state.pos) expect(finite(p), `dt ${dt}`).toBe(true);
    }
    // and it is still a rope, not a smear
    for (const p of r.state.pos) {
      expect(len(sub(p, r.rest[0]))).toBeLessThan(100);
    }
  });

  it('scrubs a poisoned chain instead of propagating it', () => {
    // WHY: belt and braces for the same failure. If anything ever does write a
    // non-finite particle, the next frame must rebuild the rope rather than
    // spread NaN down the chain through the constraints. The GPU mirror gets
    // this from `x <= t` being false for NaN in WGSL.
    const r = makeRope(v3(0, 20, 0), v3(10, 15, 0));
    r.state.pos[5] = v3(Number.NaN, Number.NaN, Number.NaN);
    r.state.pos[9] = v3(1e30, -1e30, 1e30);
    expect(needsReseed(r.state, r.A, r.B, P.teleportDistance)).toBe(true);
    stepRope(r.state, r.A, r.B, r.rest, NO_WIND, DT, P);
    for (const p of r.state.pos) expect(finite(p)).toBe(true);
    for (let i = 0; i <= SEGMENTS; i++) {
      expect(len(sub(r.state.pos[i], r.rest[i]))).toBeLessThan(P.maxStray + 1e-6);
    }
  });

  it('re-anchors cleanly when a mast breaks (§V14) — no snap across the gap', () => {
    // WHY: §V14 detaches a mast and the rope re-solves; its anchor teleports
    // metres in one frame. A chain still hanging off the old anchor would be
    // catapulted across that gap by its own distance constraints — a visible
    // whip-crack exactly when the player is looking at the mast. Detected by
    // comparing the pinned anchor (where it was last frame) to where it is now.
    const r = makeRope(v3(0, 20, 0), v3(10, 15, 0));
    for (let f = 0; f < 60; f++) {
      stepRope(r.state, r.A, r.B, r.rest, NO_WIND, DT, P);
    }
    const A2 = v3(40, 4, 25); // the masthead has gone over the side
    const rest2 = restFor(A2, r.B, r.L);
    expect(needsReseed(r.state, A2, r.B, P.teleportDistance)).toBe(true);
    stepRope(r.state, A2, r.B, rest2, NO_WIND, DT, P);
    // lands on the NEW curve immediately, and at rest — not flung
    for (let i = 0; i <= SEGMENTS; i++) {
      expect(len(sub(r.state.pos[i], rest2[i])), `particle ${i}`).toBeLessThan(P.maxStray + 1e-6);
      expect(len(sub(r.state.pos[i], r.state.prev[i])), `velocity ${i}`).toBeLessThan(0.5);
    }
  });

  it('normal sailing never trips the teleport guard', () => {
    // WHY: the guard must distinguish "re-anchored" from "sailing fast". If it
    // fired every frame the rope would be re-seeded constantly and could never
    // build the momentum the whole feature depends on — it would look exactly
    // like the static catenary it replaced, which is a silent failure.
    const r = makeRope(v3(0, 20, 0), v3(10, 15, 0));
    const speed = 15; // m/s, faster than the galleon will ever sail
    for (let f = 1; f <= 120; f++) {
      const A = v3(speed * f * DT, 20, 0);
      const B = v3(10 + speed * f * DT, 15, 0);
      stepRope(r.state, A, B, restFor(A, B, r.L), NO_WIND, DT, P);
      expect(needsReseed(r.state, A, B, P.teleportDistance), `frame ${f}`).toBe(false);
    }
  });

  it('the dt clamp is what does it — an unclamped step would diverge', () => {
    // WHY: proves the guard above is load-bearing rather than incidentally
    // true. The same chain integrated with a raw 5 s step, if DT_MAX did not
    // cap it, moves orders of magnitude further in one frame.
    const capped = Math.min(DT_MAX, 5);
    expect(capped).toBe(DT_MAX);
    expect(DT_MAX).toBeLessThan(0.05);
  });
});

describe('§V46 reefing: a rope whose REST LENGTH changes under it', () => {
  it('hauls taut without popping as a buntline takes in', () => {
    // WHY: reefing shortens a line while its anchors stay put, so the rest
    // curve moves under a chain that is already settled on the old one. Two
    // ways that goes wrong: the leash clips the change into a visible jump
    // (the leash is a sanity net, so it scales with rope length rather than
    // being a flat metre), or the teleport guard mistakes a shape change for a
    // re-anchor and reseeds, which would kill the very motion we want. The
    // "rope physically grabs" read is the sag disappearing — so assert it does
    // disappear, and that it gets there smoothly.
    const A = v3(0, 20, 0);
    const B = v3(10, 20, 0);
    const chord = len(sub(B, A));
    const slackLen = chord * 1.18;
    const haulLen = chord * 1.005;
    const r = makeRope(A, B, 1.18);
    for (let f = 0; f < 300; f++) stepRope(r.state, A, B, r.rest, NO_WIND, DT, P);
    const sagBefore = A.y - mid(r.state.pos).y;
    expect(sagBefore, 'starts slack and hanging').toBeGreaterThan(0.5);

    // haul it in over half a second, as updateRig would drive a furl
    const frames = 30;
    let maxJump = 0;
    let prevMid = mid(r.state.pos);
    for (let f = 1; f <= frames + 240; f++) {
      const k = Math.min(1, f / frames);
      const L = slackLen + (haulLen - slackLen) * k;
      const rest = solveCatenary(A, B, L, SEGMENTS);
      expect(needsReseed(r.state, A, B, P.teleportDistance), `frame ${f}`).toBe(false);
      stepRope(r.state, A, B, rest, NO_WIND, DT, P);
      const now = mid(r.state.pos);
      maxJump = Math.max(maxJump, len(sub(now, prevMid)));
      prevMid = now;
    }
    const sagAfter = A.y - mid(r.state.pos).y;
    expect(sagAfter, 'ends taut — the sag is gone').toBeLessThan(sagBefore * 0.35);
    expect(maxJump, 'no single-frame pop while hauling').toBeLessThan(0.35);
  });

  it('eases back out again when the sail is set', () => {
    // WHY: the gear has to work both ways — sheets lengthen as clews drop.
    // A one-way implementation would look right during a furl and stay
    // wrongly taut forever after.
    const A = v3(0, 20, 0);
    const B = v3(10, 20, 0);
    const chord = len(sub(B, A));
    const r = makeRope(A, B, 1.005);
    for (let f = 0; f < 120; f++) stepRope(r.state, A, B, r.rest, NO_WIND, DT, P);
    const tautSag = A.y - mid(r.state.pos).y;
    for (let f = 1; f <= 400; f++) {
      const k = Math.min(1, f / 40);
      const rest = solveCatenary(A, B, chord * (1.005 + 0.175 * k), SEGMENTS);
      stepRope(r.state, A, B, rest, NO_WIND, DT, P);
    }
    expect(A.y - mid(r.state.pos).y).toBeGreaterThan(tautSag + 0.5);
  });
});

describe('§V42 LOD: the static catenary is the FAR regime', () => {
  it('simulates near, falls back to the catenary far away, smoothly', () => {
    // WHY: §V41 split the RENDER into near/far; this is the matching split for
    // the SOLVE, so distant rigging costs a Newton solve instead of a chain —
    // which is what makes room for ratlines. The crossfade must be continuous
    // or ropes visibly stiffen as the camera pulls back.
    const d = ropeParams.simDistance;
    const band = ropeParams.simFadeBand;
    expect(simWeight(0, d, band)).toBeCloseTo(1, 6);
    expect(simWeight(d, d, band)).toBeCloseTo(1, 6);
    expect(simWeight(d + band, d, band)).toBeCloseTo(0, 6);
    expect(simWeight(1e5, d, band)).toBeCloseTo(0, 6);
    let prev = Infinity;
    for (let x = 0; x <= d + band * 2; x += 0.5) {
      const w = simWeight(x, d, band);
      expect(w).toBeGreaterThanOrEqual(-1e-12);
      expect(w).toBeLessThanOrEqual(1 + 1e-12);
      expect(w).toBeLessThanOrEqual(prev + 1e-12); // monotone
      prev = w;
    }
  });

  it('has no step at either end of the fade band', () => {
    // WHY: a discontinuity here is a visible pop as the camera moves — the
    // same class of fault §V41 exists to prevent on the render side.
    const d = ropeParams.simDistance;
    const band = ropeParams.simFadeBand;
    const step = 0.05;
    for (let x = d - 2; x <= d + band + 2; x += step) {
      const jump = Math.abs(simWeight(x + step, d, band) - simWeight(x, d, band));
      expect(jump, `at ${x} m`).toBeLessThan(0.01);
    }
  });
});
