/**
 * §V44/§V55/§V2 — the swinging lantern.
 *
 * These tests exist because "looks alive" is not a specification. The two
 * claims the feature actually makes are LAG (it arrives late and overshoots)
 * and PLUMB (it stays vertical while the deck rolls under it), and both are
 * measurable. Beyond that, the model is a second-order ODE, so it gets the
 * treatment §V.52 and §V.53 demand of every hand-tuned physical constant: the
 * natural period and the damping ratio are MEASURED from a free decay and
 * checked against their own closed forms, not inferred from the coefficients
 * that were typed in.
 *
 * The §V.55 test is the important one for regression. §B.30 (flags at 59.5 Hz
 * after ten minutes) survived three separate passes because the defect LOOKS
 * FINE ON A FRESH RELOAD. So the flicker is run for ten sim-minutes with a
 * deliberately wobbling rate and the frequency is compared between the first
 * and last ten seconds — which is the measurement that would have caught it.
 */
import { describe, expect, it } from 'vitest';
import { lanternParams, type LanternParams } from '../src/params/lanterns';
import {
  FLICKER_RATIO,
  G,
  createLanternState,
  flickerLevel,
  hangTarget,
  hangVector,
  stepPendulum,
  wrapTau,
  type LanternState,
  type Quat,
  type Vec3,
} from '../src/lanterns/pendulum';

const DT = 1 / 60;
const UPRIGHT: Quat = [0, 0, 0, 1];
const STILL: Vec3 = [0, 0, 0];

function withParams(over: Partial<LanternParams>): LanternParams {
  return { ...lanternParams, ...over };
}

/** quaternion for a roll of `a` radians about the ship's +z (fore-aft) axis */
function rollQuat(a: number): Quat {
  return [0, 0, Math.sin(a / 2), Math.cos(a / 2)];
}

/** rotate a ship-local vector into world space */
function localToWorld(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

function settle(
  s: LanternState,
  q: Quat,
  p: LanternParams,
  seconds = 60,
): LanternState {
  let out = s;
  for (let i = 0; i < seconds / DT; i++) out = stepPendulum(out, q, STILL, DT, p);
  return out;
}

describe('rest and plumb — the "dangling" half of the request', () => {
  it('hangs straight down on an upright, motionless ship and stays there', () => {
    const s = settle(createLanternState(0), UPRIGHT, lanternParams, 30);
    expect(hangVector(s)).toEqual([0, -1, 0]);
    expect(Math.hypot(s.vx, s.vz)).toBeLessThan(1e-9);
  });

  it('stays PLUMB while the deck heels — the deck rolls, the lantern does not', () => {
    // This is the effect, stated as a measurement: with the hull held at 20°
    // of heel, the settled hang vector in WORLD space is straight down. The
    // lantern is not welded to the ship's local -y; it answers gravity.
    for (const heel of [0.1, 0.35, -0.25]) {
      const q = rollQuat(heel);
      const s = settle(createLanternState(0), q, lanternParams, 90);
      const world = localToWorld(q, hangVector(s));
      expect(world[0]).toBeCloseTo(0, 3);
      expect(world[1]).toBeCloseTo(-1, 3);
      expect(world[2]).toBeCloseTo(0, 3);
    }
  });

  it('the hang vector is unit length in every state it can reach', () => {
    let s = createLanternState(3);
    for (let i = 0; i < 4000; i++) {
      s = stepPendulum(s, rollQuat(Math.sin(i * 0.03) * 0.4), [3, -6, 2], DT, lanternParams);
      const h = hangVector(s);
      expect(Math.hypot(h[0], h[1], h[2])).toBeCloseTo(1, 12);
    }
  });
});

describe('lag and overshoot — the "alive" half of the request', () => {
  it('does NOT arrive instantly when the deck tilts', () => {
    // a lantern that tracks the deck with no lag is a prop. One tick after a
    // 20° step the lantern must still be essentially where it was.
    const s0 = settle(createLanternState(0), UPRIGHT, lanternParams, 20);
    const s1 = stepPendulum(s0, rollQuat(0.35), STILL, DT, lanternParams);
    const target = hangTarget(rollQuat(0.35), STILL, lanternParams);
    // it has begun to move...
    expect(Math.abs(s1.sx - s0.sx) + Math.abs(s1.sz - s0.sz)).toBeGreaterThan(0);
    // ...but covered under 2% of the distance to its new rest position
    const moved = Math.hypot(s1.sx - s0.sx, s1.sz - s0.sz);
    const gap = Math.hypot(target[0] - s0.sx, target[1] - s0.sz);
    expect(moved / gap).toBeLessThan(0.02);
  });

  it('OVERSHOOTS its new rest position — an underdamped system, on purpose', () => {
    // overshoot is what reads as a swing. A critically damped or overdamped
    // lantern eases into place and looks like a UI animation.
    const q = rollQuat(0.35);
    const target = hangTarget(q, STILL, lanternParams);
    let s = settle(createLanternState(0), UPRIGHT, lanternParams, 20);
    let past = false;
    for (let i = 0; i < 5 / DT; i++) {
      s = stepPendulum(s, q, STILL, DT, lanternParams);
      // the target's z component is what a roll about +z displaces
      if (Math.sign(target[0]) !== 0 && s.sx / target[0] > 1.02) past = true;
      if (Math.abs(target[1]) > 1e-9 && s.sz / target[1] > 1.02) past = true;
    }
    expect(past).toBe(true);
  });

  it('is excited by HEAVE, not only by heel — the sea kicks it', () => {
    // an upright hull that is accelerating still swings the lantern: that is
    // the d'Alembert term, and it is why a lantern moves in a head sea even
    // when the deck stays level.
    let s = settle(createLanternState(0), UPRIGHT, lanternParams, 20);
    let peak = 0;
    for (let i = 0; i < 6 / DT; i++) {
      // 0.18 Hz surge/sway, roughly the hull's own heave band
      const a: Vec3 = [Math.sin(i * DT * 1.16) * 2.5, 0, 0];
      s = stepPendulum(s, UPRIGHT, a, DT, lanternParams);
      peak = Math.max(peak, Math.hypot(s.sx, s.sz));
    }
    expect(peak).toBeGreaterThan(0.05);
  });
});

describe('§V52/§V53 — the constants are MEASURED, not asserted', () => {
  /** free decay from a displaced start: peaks of |s| over time */
  function freeDecay(p: LanternParams): { period: number; zeta: number } {
    let s: LanternState = { ...createLanternState(0), sx: 0.25 };
    const trace: number[] = [];
    const steps = Math.round(20 / DT);
    for (let i = 0; i < steps; i++) {
      trace.push(s.sx);
      s = stepPendulum(s, UPRIGHT, STILL, DT, p);
    }
    // positive peaks
    const peaks: { t: number; v: number }[] = [];
    for (let i = 1; i < trace.length - 1; i++) {
      if (trace[i] > trace[i - 1] && trace[i] > trace[i + 1] && trace[i] > 1e-4) {
        peaks.push({ t: i * DT, v: trace[i] });
      }
    }
    const n = peaks.length - 1;
    const period = (peaks[n].t - peaks[0].t) / n;
    // logarithmic decrement δ = (1/n)·ln(x0/xn), ζ = δ/√(4π² + δ²)
    const delta = Math.log(peaks[0].v / peaks[n].v) / n;
    return { period, zeta: delta / Math.sqrt(4 * Math.PI ** 2 + delta ** 2) };
  }

  it('swings at the pendulum period 2π√(L/g), for every cord length', () => {
    // §V53's rule: a hand-tuned constant must carry a dimensionless check
    // against the real object. `cordLength` is not a look knob whose value is
    // justified by its effect — it is a length, and it has a closed form.
    for (const L of [0.2, 0.35, 0.8, 1.5]) {
      const measured = freeDecay(withParams({ cordLength: L, damping: 0.02 })).period;
      const closedForm = 2 * Math.PI * Math.sqrt(L / G);
      expect(measured / closedForm).toBeCloseTo(1, 1);
    }
  });

  it('damps at the ratio the param asks for — measured by log decrement', () => {
    for (const z of [0.03, 0.06, 0.15]) {
      const measured = freeDecay(withParams({ damping: z })).zeta;
      expect(measured).toBeGreaterThan(z * 0.8);
      expect(measured).toBeLessThan(z * 1.25);
    }
  });

  it('the shipped default is UNDERDAMPED — or the request is not answered', () => {
    // ζ 0.06 means the swing survives ~5 cycles. §B.22 is the cautionary
    // tale in the other direction: one damping coefficient taken to ζ 0.41
    // stopped the ship rolling at all and nobody could see it from the number.
    expect(freeDecay(lanternParams).zeta).toBeLessThan(0.2);
  });

  it('does not GAIN energy — the integrator is symplectic, not forward Euler', () => {
    // plain forward Euler on a lightly damped oscillator grows the amplitude
    // every cycle, and at ζ 0.06 the damping is far too weak to hide it. This
    // fails loudly if the integrator is ever "simplified".
    const p = withParams({ damping: 0 });
    let s: LanternState = { ...createLanternState(0), sx: 0.2 };
    const energy = (st: LanternState) =>
      (G / p.cordLength) * (st.sx ** 2 + st.sz ** 2) + st.vx ** 2 + st.vz ** 2;
    const e0 = energy(s);
    for (let i = 0; i < 600 / DT; i++) s = stepPendulum(s, UPRIGHT, STILL, DT, p);
    // ten minutes undamped: symplectic Euler keeps energy bounded, it does
    // not keep it exact, so allow a small oscillation but no growth trend
    expect(energy(s) / e0).toBeLessThan(1.05);
  });
});

describe('§V44 bounded at source', () => {
  it('a violent acceleration cannot throw the lantern past its cord', () => {
    // §B.24: an unbounded reaction force threw the whole hull 16 m into the
    // air. The sim's acceleration channel carries grounding impacts and
    // cannon recoil, so the drive is capped BEFORE it enters the ODE.
    let s = createLanternState(0);
    const maxS = Math.sin(lanternParams.maxSwing);
    for (let i = 0; i < 2000; i++) {
      const a: Vec3 = [i % 3 ? 900 : -900, 700, -900];
      s = stepPendulum(s, rollQuat(1.2), a, DT, lanternParams);
      expect(Math.hypot(s.sx, s.sz)).toBeLessThanOrEqual(maxS + 1e-9);
      expect(Number.isFinite(s.sx + s.sz + s.vx + s.vz)).toBe(true);
    }
  });

  it('recovers to plumb after the violence stops — it is not left pinned', () => {
    // clamping the position alone leaves the integrator pumping energy into a
    // state it cannot express, which comes back as a buzz. The stop kills the
    // OUTWARD velocity too, so the lantern settles instead of chattering.
    let s = createLanternState(0);
    for (let i = 0; i < 600; i++) s = stepPendulum(s, UPRIGHT, [500, 0, 500], DT, lanternParams);
    s = settle(s, UPRIGHT, lanternParams, 120);
    expect(Math.hypot(s.sx, s.sz)).toBeLessThan(1e-3);
  });

  it('survives NaN and nonsense without poisoning a transform (§V28)', () => {
    const junk: Quat[] = [
      [Number.NaN, 0, 0, 1],
      [0, 0, 0, 0],
      [Infinity, Infinity, Infinity, Infinity],
    ];
    for (const q of junk) {
      let s = createLanternState(0);
      for (const dt of [0, -1, Number.NaN, 1e9, DT]) {
        s = stepPendulum(s, q, [Number.NaN, 0, Infinity], dt, lanternParams);
        expect(Number.isFinite(s.sx + s.sz + s.vx + s.vz)).toBe(true);
        const h = hangVector(s);
        expect(Number.isFinite(h[0] + h[1] + h[2])).toBe(true);
      }
    }
  });

  it('flicker is bounded in [1-depth, 1] for EVERY pair of phases', () => {
    // bounded at source: 0.6·sin(a) + 0.4·sin(b) is in [-1,1] because the
    // weights sum to 1, so no clamp is needed downstream and none is used.
    const p = withParams({ flickerDepth: 0.4 });
    for (let a = 0; a < 6.3; a += 0.05) {
      for (let b = 0; b < 6.3; b += 0.31) {
        const l = flickerLevel({ ...createLanternState(0), flickerPhase: a, flickerHarmonic: b }, p);
        expect(l).toBeGreaterThanOrEqual(1 - p.flickerDepth - 1e-12);
        expect(l).toBeLessThanOrEqual(1 + 1e-12);
      }
    }
  });

  it('a depth of 0 gives a steady flame, not a dark one', () => {
    const p = withParams({ flickerDepth: 0 });
    expect(flickerLevel(createLanternState(0), p)).toBe(1);
  });
});

describe('§V55 — the flicker phase is an INTEGRAL, and this is the §B.30 test', () => {
  it('holds its frequency after TEN MINUTES of a wobbling rate', () => {
    // §B.30 measured 0.93 Hz → 2.2 Hz at 15 s → 59.5 Hz at 600 s, because
    // `time × rate` multiplies every wobble in the rate by elapsed time. The
    // defect LOOKS FINE ON A FRESH RELOAD, which is why it survived three
    // passes. So: run ten minutes, then compare the frequency at the end
    // against the frequency at the start.
    const base = lanternParams.flickerHz;
    let s = createLanternState(0);
    let t = 0;
    const rateAt = (time: number) => base * (1 + 0.5 * Math.sin(time * 0.37));

    const countCrossings = (seconds: number): number => {
      let crossings = 0;
      let prev = Math.sin(s.flickerPhase);
      for (let i = 0; i < seconds / DT; i++) {
        s = stepPendulum(s, UPRIGHT, STILL, DT, withParams({ flickerHz: rateAt(t) }));
        t += DT;
        const now = Math.sin(s.flickerPhase);
        if (prev < 0 && now >= 0) crossings++;
        prev = now;
      }
      return crossings;
    };

    const first = countCrossings(10);
    for (let i = 0; i < 580 / DT; i++) {
      s = stepPendulum(s, UPRIGHT, STILL, DT, withParams({ flickerHz: rateAt(t) }));
      t += DT;
    }
    const last = countCrossings(10);
    // the rate genuinely wobbles, so these are not identical — but a runaway
    // shows up as a MULTIPLE, not as a few percent. §B.30 would read ~64x.
    expect(last).toBeGreaterThan(first * 0.4);
    expect(last).toBeLessThan(first * 2.5);
  });

  it('keeps both accumulators wrapped forever — precision never decays', () => {
    let s = createLanternState(0);
    for (let i = 0; i < 3600 / DT; i++) s = stepPendulum(s, UPRIGHT, STILL, DT, lanternParams);
    expect(s.flickerPhase).toBeGreaterThanOrEqual(0);
    expect(s.flickerPhase).toBeLessThan(Math.PI * 2);
    expect(s.flickerHarmonic).toBeGreaterThanOrEqual(0);
    expect(s.flickerHarmonic).toBeLessThan(Math.PI * 2);
  });

  it('the harmonic has its OWN accumulator, not a multiple of the first', () => {
    // §V.55's closing line: multiplying a WRAPPED value by a non-integer
    // ratio breaks continuity at every wrap. If the harmonic were derived as
    // `flickerPhase * 1.7` it would equal that product; it must not.
    let s = createLanternState(0);
    for (let i = 0; i < 400; i++) s = stepPendulum(s, UPRIGHT, STILL, DT, lanternParams);
    expect(s.flickerHarmonic).not.toBeCloseTo(wrapTau(s.flickerPhase * FLICKER_RATIO), 4);
  });

  it('two lanterns never pulse in lockstep (§B.4 was the whole ocean doing it)', () => {
    let a = createLanternState(0.11);
    let b = createLanternState(7.43);
    let apart = 0;
    for (let i = 0; i < 600; i++) {
      a = stepPendulum(a, UPRIGHT, STILL, DT, lanternParams);
      b = stepPendulum(b, UPRIGHT, STILL, DT, lanternParams);
      apart = Math.max(apart, Math.abs(flickerLevel(a, lanternParams) - flickerLevel(b, lanternParams)));
    }
    expect(apart).toBeGreaterThan(0.05);
  });
});

describe('§V2 determinism', () => {
  it('same seed and same inputs give bit-identical state', () => {
    const run = () => {
      let s = createLanternState(2.5);
      for (let i = 0; i < 1000; i++) {
        s = stepPendulum(s, rollQuat(Math.sin(i * 0.017) * 0.3), [Math.cos(i * 0.01), 0.4, 0], DT, lanternParams);
      }
      return s;
    };
    expect(run()).toEqual(run());
  });

  it('hangTarget is a pure function of pose and acceleration', () => {
    const q = rollQuat(0.22);
    expect(hangTarget(q, [1, 2, 3], lanternParams)).toEqual(hangTarget(q, [1, 2, 3], lanternParams));
  });
});
