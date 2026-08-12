/**
 * Driven damped pendulum for a hanging lantern (§V16 tunables in params;
 * THREE-free so node tests can prove it).
 *
 * ── WHY AN ODE AND NOT A sin(time) ─────────────────────────────────────
 * §V.55 and §B.30: a canned oscillator whose rate varies is the single most
 * repeated defect in this project — the flags ran to 59.5 Hz after ten
 * minutes because `time × rate` is only a valid phase while the rate is
 * constant. A pendulum has no such failure mode BY CONSTRUCTION: it is a
 * second-order differential equation integrated at a fixed timestep, so
 * there is no phase to drift and no rate to multiply by elapsed time. It is
 * also the only formulation that produces the thing the request is actually
 * about — LAG. A lantern that tracks the deck instantly is a prop; a lantern
 * that arrives late and overshoots is alive, and the lateness is not a
 * hand-tuned offset, it is what a second-order system does.
 *
 * ── THE MODEL ──────────────────────────────────────────────────────────
 * State is the unit vector from the hook down to the lantern, expressed in
 * the SHIP'S LOCAL FRAME and stored as its two horizontal components (sx, sz)
 * — the vertical component is recovered as -sqrt(1 - sx² - sz²), so the
 * vector is unit by construction and no angle is ever wrapped.
 *
 * Rest is wherever EFFECTIVE GRAVITY points in that frame, i.e.
 * normalize(R⁻¹·(g - a)). Two consequences fall out for free, and both are
 * the effect the request describes:
 *
 *   - the ship heels, the ship's local "down" tilts, and the lantern does
 *     NOT: it goes on hanging plumb while the deck rolls around it;
 *   - the hull accelerates (heave, a slam off a crest) and the effective
 *     gravity swings, which kicks the pendulum and leaves it ringing at its
 *     own natural period long after the kick.
 *
 * Natural period is 2π√(L/g) — 1.19 s at the default 0.35 m cord, against
 * the hull's measured 7.17 s roll and 5.43 s heave. That separation is the
 * point: the lantern is far faster than the sea, so it tracks the slow roll
 * quasi-statically (reading as "hangs level") while the fast content of the
 * ship's motion excites its own ring.
 */
import type { LanternParams } from '../params/lanterns';

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

const TAU = Math.PI * 2;
/** m/s² — the pendulum's restoring field, not the sim's gravity */
export const G = 9.81;

/** §V28: never let a caller's NaN reach a transform */
function finite(v: number, fallback = 0): number {
  return Number.isFinite(v) ? v : fallback;
}

/** fold into [0, 2π) — keeps an accumulator's precision constant forever */
export function wrapTau(x: number): number {
  const v = finite(x) % TAU;
  return v < 0 ? v + TAU : v;
}

export interface LanternState {
  /** horizontal components of the unit hang vector, SHIP-LOCAL */
  sx: number;
  sz: number;
  /** their rates, 1/s */
  vx: number;
  vz: number;
  /**
   * Flame flicker phase accumulators. TWO of them, detuned by a non-integer
   * ratio, because §V.55's closing line is that multiplying ONE wrapped
   * accumulator by 1.7 breaks continuity at every wrap — the harmonic needs
   * its own integral, not a scaled copy of somebody else's.
   */
  flickerPhase: number;
  flickerHarmonic: number;
}

/**
 * Scramble a seed to [0,1).
 *
 * INTEGER mixing, deliberately — no `Math.sin`, whose precision is
 * implementation-defined and would make the seed engine-dependent, which is
 * not something §V.2 determinism can rest on.
 *
 * It is also not a plain multiply. `wrapTau(seed · k)` aliases: two unrelated
 * seeds whose product lands within 2π of each other come out with the same
 * phase, and the desync test in tests/lanterns.test.ts caught exactly that
 * (0.11 and 7.43 mapped to 0.1887 and 0.1830 rad — visually identical
 * lanterns). That is §B.4's shape, found before it ever reached a pixel.
 */
function hash01(x: number): number {
  let h = (Math.round(finite(x) * 1e6) >>> 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * A lantern at rest, with its flicker phases offset by a seed.
 *
 * The seed is not decoration: §B.4 is an entire ocean pulsing in sync
 * because every cell shared one time phase. Two lanterns on one taffrail
 * flickering in lockstep read as one flickering SHIP, which is worse than no
 * flicker at all.
 */
export function createLanternState(seed: number): LanternState {
  const s = finite(seed);
  return {
    sx: 0,
    sz: 0,
    vx: 0,
    vz: 0,
    flickerPhase: TAU * hash01(s),
    flickerHarmonic: TAU * hash01(s + 19.19),
  };
}

/** rotate a world vector into the frame of a unit quaternion (v' = q⁻¹ v q) */
export function worldToLocal(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = [finite(q[0]), finite(q[1]), finite(q[2]), finite(q[3], 1)];
  // conjugate rotation: same as rotating by (-x,-y,-z,w)
  const tx = 2 * (-y * v[2] + z * v[1]);
  const ty = 2 * (-z * v[0] + x * v[2]);
  const tz = 2 * (-x * v[1] + y * v[0]);
  return [
    v[0] + w * tx + (-y * tz + z * ty),
    v[1] + w * ty + (-z * tx + x * tz),
    v[2] + w * tz + (-x * ty + y * tx),
  ];
}

/**
 * Where the lantern WANTS to hang, in ship-local coordinates: the direction
 * of effective gravity, as its two horizontal components.
 *
 * §V44 bounded at source — the accelerating frame's contribution is clamped
 * to `maxDriveG` before it is ever added, not clipped out of the result
 * afterwards. An unbounded `a` here is not a big swing, it is a lantern
 * pinned inside-out at the cord's stop with its restoring force reversed,
 * and the sim's acceleration channel is a differentiated quantity fed by
 * grounding impacts and cannon recoil.
 */
export function hangTarget(quat: Quat, accelWorld: Vec3, p: LanternParams): [number, number] {
  const cap = Math.max(0, finite(p.maxDriveG)) * G;
  const clampA = (v: number) => Math.min(cap, Math.max(-cap, finite(v)));
  // effective gravity = g - a (the d'Alembert term of the non-inertial frame)
  const gw: Vec3 = [
    -clampA(accelWorld[0]),
    -G - clampA(accelWorld[1]),
    -clampA(accelWorld[2]),
  ];
  const gl = worldToLocal(quat, gw);
  const len = Math.hypot(gl[0], gl[1], gl[2]);
  if (!(len > 1e-6)) return [0, 0]; // §V28: normalize(0) is NaN
  return [gl[0] / len, gl[2] / len];
}

/**
 * Advance one lantern by `dt`.
 *
 * Semi-implicit (symplectic) Euler: the velocity is updated first and the
 * position with the NEW velocity. For an oscillator that is the difference
 * between an integrator that conserves energy and one that gains it — plain
 * forward Euler on a lightly-damped pendulum grows the amplitude every cycle,
 * and with `lanternDamping` at 0.06 the damping is far too weak to hide it.
 */
export function stepPendulum(
  state: LanternState,
  quat: Quat,
  accelWorld: Vec3,
  dt: number,
  p: LanternParams,
): LanternState {
  // §V28: a paused frame or a debugger stop must not integrate an hour
  const h = Math.min(0.05, Math.max(1 / 1000, finite(dt, 1 / 60)));
  const cord = Math.max(0.02, finite(p.cordLength, 0.35));
  const w0 = Math.sqrt(G / cord);
  const zeta = Math.min(2, Math.max(0, finite(p.damping)));

  const [tx, tz] = hangTarget(quat, accelWorld, p);

  // ẍ = -ω₀²(x - target) - 2ζω₀ẋ  — a driven damped harmonic oscillator
  const k = w0 * w0;
  const c = 2 * zeta * w0;
  let vx = finite(state.vx) + (-k * (finite(state.sx) - tx) - c * finite(state.vx)) * h;
  let vz = finite(state.vz) + (-k * (finite(state.sz) - tz) - c * finite(state.vz)) * h;
  let sx = finite(state.sx) + vx * h;
  let sz = finite(state.sz) + vz * h;

  // The cord's stop. §V44: bounded at source, and the OUTWARD velocity is
  // killed with it — clamping the position alone leaves the integrator
  // pumping energy into a state it cannot express, which comes back as a
  // buzz the moment the ship stops moving.
  const maxS = Math.sin(Math.min(Math.PI / 2, Math.max(0, finite(p.maxSwing))));
  const r = Math.hypot(sx, sz);
  if (r > maxS && r > 1e-9) {
    const scale = maxS / r;
    const outward = (vx * sx + vz * sz) / r;
    if (outward > 0) {
      vx -= (outward * sx) / r;
      vz -= (outward * sz) / r;
    }
    sx *= scale;
    sz *= scale;
  }

  // §V.55: the flicker RATE varies with the wind, so its phase is an
  // INTEGRAL, never `time × rate`. Both accumulators are wrapped, and the
  // harmonic runs its own rather than being a multiple of the fundamental.
  const rate = Math.max(0, finite(p.flickerHz)) * TAU * h;
  return {
    sx,
    sz,
    vx,
    vz,
    flickerPhase: wrapTau(finite(state.flickerPhase) + rate),
    flickerHarmonic: wrapTau(finite(state.flickerHarmonic) + rate * FLICKER_RATIO),
  };
}

/** non-integer, so the two sines never re-align into a single beat */
export const FLICKER_RATIO = 1.7;

/**
 * Unit vector from the hook to the lantern, ship-local. Vertical component
 * is DERIVED, so the result is unit length whatever the state holds.
 */
export function hangVector(state: LanternState): Vec3 {
  const sx = finite(state.sx);
  const sz = finite(state.sz);
  const flat = Math.min(1, sx * sx + sz * sz);
  return [sx, -Math.sqrt(Math.max(0, 1 - flat)), sz];
}

/**
 * Flame brightness multiplier, in [1 - depth, 1].
 *
 * §V44: bounded AT SOURCE, not clamped after. `0.6·sin(a) + 0.4·sin(b)` lies
 * in [-1, 1] because the weights sum to 1, so mapping it through (1-s)/2
 * lands in [0, 1] for every possible pair of phases and the result cannot
 * reach an additive light slot out of range however the params are set.
 * Never returns 0 unless depth is 1 — a lantern that fully extinguishes
 * every cycle reads as a fault, not as a flame.
 */
export function flickerLevel(state: LanternState, p: LanternParams): number {
  const depth = Math.min(1, Math.max(0, finite(p.flickerDepth)));
  const s =
    0.6 * Math.sin(finite(state.flickerPhase)) +
    0.4 * Math.sin(finite(state.flickerHarmonic));
  return 1 - (depth * (1 - s)) / 2;
}
