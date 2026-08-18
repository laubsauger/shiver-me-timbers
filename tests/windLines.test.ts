/**
 * §T.47 WIND LINES — the transliteration-pair tests.
 *
 * A TSL graph cannot be evaluated headless, so `src/sky/windLines.ts` carries a
 * CPU mirror of everything the node derives and these drive that. The
 * convention is the project's (bandLimit.ts ↔ the wood material, sailShape.ts ↔
 * the sail graph, starfield.ts ↔ the star field): the two sides are changed
 * together, and what is proven here are the PROPERTIES the look depends on —
 *
 *   1. the streaks converge on the wind's own bearing, and on nothing else;
 *   2. a streak never leaves its own cell, which is what makes evaluating ONE
 *      cell per pixel legal;
 *   3. the pattern dissolves as it pinches instead of aliasing into a knot;
 *   4. a calm sky is bare, and a storm sky is not;
 *   5. the drift phases are independent accumulators (§V.55).
 */
import { describe, expect, it } from 'vitest';
import {
  WAVE_RATIO,
  WAVE_SECOND,
  WIND_LINE_CLEARANCE,
  advanceWindPhase,
  oddStreakCount,
  pixelAngleFor,
  streakArcSpacing,
  streakForIndex,
  vanishingPoint,
  waveNumbers,
  windAxis,
  windLineFilter,
  windLineGate,
  windLinePeakRadiance,
  windLineWaveSlope,
  windLineWeight,
} from '../src/sky/windLines';
import { skyParams } from '../src/params/sky';
import { apparentWind } from '../src/ship/flagDynamics';
import { SEA_STATES } from '../src/ui/settingsStore';

const P = skyParams;
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/** the reference frame every number in the source comments is quoted at */
const PX_1080 = pixelAngleFor(55, 1080);

/** unit direction at polar angle theta from the axis, azimuth phi about it */
function dirAt(direction: number, theta: number, phi: number): [number, number, number] {
  const { axis, side } = windAxis(direction);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const up: [number, number, number] = [0, 1, 0];
  return [
    axis[0] * c + s * (side[0] * Math.cos(phi) + up[0] * Math.sin(phi)),
    axis[1] * c + s * (side[1] * Math.cos(phi) + up[1] * Math.sin(phi)),
    axis[2] * c + s * (side[2] * Math.cos(phi) + up[2] * Math.sin(phi)),
  ];
}

function dot(a: readonly number[], b: readonly number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * THE CONVENTION. This block is the twin of the "KNOWN DIVERGENCE" block in
 * tests/ui.test.ts, and it exists so that whoever reconciles the two camps has
 * to come here on purpose rather than discovering afterwards that the sky moved.
 */
describe('the streaks converge on the bearing the FLAGS feel', () => {
  it('reads windDirection through the sails/flags convention, not the sea\'s', () => {
    for (const deg of [0, 45, 90, 135, 225]) {
      const theta = deg * DEG;
      const vp = vanishingPoint(theta);
      // the flags' own vector for a ship lying still IS the true wind's
      const flag = apparentWind({
        windDirection: theta,
        windSpeed: 10,
        shipVelX: 0,
        shipVelZ: 0,
      });
      expect(vp[0]).toBeCloseTo(flag.x, 12);
      expect(vp[2]).toBeCloseTo(flag.z, 12);
      expect(vp[1]).toBe(0); // the vanishing points are ON the horizon
    }
  });

  it('therefore disagrees with the SEA except at the 45° fixed point', () => {
    // the ocean spectrum's convention (src/ocean/oceanMath.ts `phillips`)
    const sea = (t: number) => [Math.cos(t), 0, Math.sin(t)] as const;
    // the reflection's two fixed points — where the project has never noticed
    for (const deg of [45, 225]) {
      const t = deg * DEG;
      expect(dot(vanishingPoint(t), sea(t))).toBeCloseTo(1, 12);
    }
    // and where it is a whole reversal: 135° puts them 180° apart
    expect(dot(vanishingPoint(135 * DEG), sea(135 * DEG))).toBeCloseTo(-1, 12);
    // 0° and 90° are the quarter turns
    expect(dot(vanishingPoint(0), sea(0))).toBeCloseTo(0, 12);
    expect(dot(vanishingPoint(90 * DEG), sea(90 * DEG))).toBeCloseTo(0, 12);
  });

  it('the frame is orthonormal at every bearing (phi is a real azimuth)', () => {
    for (let deg = 0; deg < 360; deg += 17) {
      const { axis, side } = windAxis(deg * DEG);
      expect(Math.hypot(...axis)).toBeCloseTo(1, 12);
      expect(Math.hypot(...side)).toBeCloseTo(1, 12);
      expect(dot(axis, side)).toBeCloseTo(0, 12);
      // both horizontal: the vanishing points must land on the horizon
      expect(axis[1]).toBe(0);
      expect(side[1]).toBe(0);
    }
  });
});

/**
 * CONVERGENCE IS A PROPERTY OF THE OBJECT, not something drawn on. Every streak
 * is a meridian of the ±W poles, so they all pass through both of them and the
 * gap between neighbours closes to nothing there.
 */
describe('the pencil converges — and only at the two wind poles', () => {
  it('every streak passes through both vanishing points', () => {
    const dir = 0.7;
    const vp = vanishingPoint(dir);
    for (const phi of [0, 1.1, 2.5, -2.0, Math.PI]) {
      // theta → 0 is the downwind pole, theta → π the upwind one
      expect(dot(dirAt(dir, 1e-7, phi), vp)).toBeCloseTo(1, 10);
      expect(dot(dirAt(dir, Math.PI - 1e-7, phi), vp)).toBeCloseTo(-1, 10);
    }
  });

  it('adjacent streaks close on each other as the pole is approached', () => {
    const n = oddStreakCount(P.windLineCount);
    const equator = streakArcSpacing(n, 1);
    expect(equator / DEG).toBeCloseTo(360 / n, 6); // 7.35° at the shipped 49
    // monotone all the way in, and zero AT the pole — that is the convergence
    let prev = equator;
    for (const theta of [60, 30, 15, 5, 1].map((d) => d * DEG)) {
      const arc = streakArcSpacing(n, Math.sin(theta));
      expect(arc).toBeLessThan(prev);
      prev = arc;
    }
    expect(streakArcSpacing(n, 0)).toBe(0);
  });

  it('the count is forced odd, so the atan2 seam lands on a cell wall', () => {
    // an even count would put a streak CENTRE on the ±π wrap and tear it
    expect(oddStreakCount(48)).toBe(49);
    expect(oddStreakCount(49)).toBe(49);
    expect(oddStreakCount(P.windLineCount) % 2).toBe(1);
    expect(oddStreakCount(0)).toBe(3); // floored, never zero or negative
    expect(oddStreakCount(Number.NaN)).toBe(49);
  });
});

/**
 * ONE CELL PER PIXEL is only legal while a streak stays inside its own cell.
 * This is `starfield.ts`'s JITTER argument in one dimension, and it fails the
 * same way: a straight cut down the sky where the wave meets the cell wall.
 */
describe('a streak never reaches its own cell wall', () => {
  const wave = P.windLineWaveAmount;
  const halfDuty = P.windLineWidth / 2;

  it('the shipped amplitudes leave real clearance', () => {
    const excursion = wave * (1 + WAVE_SECOND) + halfDuty;
    expect(excursion).toBeLessThan(WIND_LINE_CLEARANCE);
    // and the clearance itself must stay inside the half-cell
    expect(WIND_LINE_CLEARANCE).toBeLessThan(0.5);
    // margin in DEGREES at the shipped count, which is what a reader can judge
    const spacing = 360 / oddStreakCount(P.windLineCount);
    expect((0.5 - excursion) * spacing).toBeGreaterThan(1.5);
  });

  it('no offset over the whole sweep of theta and index exceeds it', () => {
    let worst = 0;
    const phases = { wave: 1.3, waveB: 5.1, gust: 2.2 };
    for (let i = -60; i <= 60; i++) {
      for (let t = 0; t <= Math.PI; t += Math.PI / 120) {
        const s = streakForIndex(i, t, phases, P, 1);
        worst = Math.max(worst, Math.abs(s.offset));
      }
    }
    expect(worst).toBeLessThanOrEqual(wave * (1 + WAVE_SECOND) + 1e-12);
    expect(worst + halfDuty).toBeLessThan(WIND_LINE_CLEARANCE);
    // and it must actually USE most of its allowance, or the wave is invisible
    expect(worst).toBeGreaterThan(wave);
  });
});

/**
 * §V.48b. The pattern must dissolve as it pinches. Both halves are checked: the
 * drawn width never falls under the 2 px floor, and the amplitude falls as the
 * reciprocal of the filter once it does — which together hold the flux the
 * pixel should have seen.
 */
describe('§V.48: the pinch dissolves rather than aliasing', () => {
  const n = oddStreakCount(P.windLineCount);
  const slope = windLineWaveSlope(P.windLineWaveAmount, P.windLineWaveFreq);
  const halfDuty = P.windLineWidth / 2;
  const energyAt = (theta: number, px = PX_1080) =>
    windLinePeakRadiance(1, 1, P.windLineWidth, windLineFilter(n, Math.sin(theta), px, slope));

  it('the AUTHOR owns the width at the equator, not the 2 px floor', () => {
    // the moonTerminatorSoftness lesson: an authored value under the floor has
    // never rendered at all. Here the half-width is 0.33°, the floor 0.11°.
    const filter = windLineFilter(n, 1, PX_1080, slope);
    expect(2 * filter).toBeLessThan(halfDuty);
    expect(energyAt(Math.PI / 2)).toBeCloseTo(1, 12);
    // still true at 720p, which is the resolution that squeezes it hardest
    expect(energyAt(Math.PI / 2, pixelAngleFor(55, 720))).toBeCloseTo(1, 12);
  });

  it('and it fades to nothing INTO the vanishing point, monotonically', () => {
    let prev = energyAt(30 * DEG);
    expect(prev).toBeCloseTo(1, 6); // still crisp 30° out
    for (const deg of [20, 15, 10, 5, 2, 1, 0.25]) {
      const e = energyAt(deg * DEG);
      expect(e).toBeLessThanOrEqual(prev + 1e-12);
      prev = e;
    }
    expect(prev).toBeLessThan(0.02); // a quarter degree out, essentially gone
    // AT the pole the ε floor on sinθ pins the filter, and §V28's corollary
    // says that bounds the DIVISION, not the quotient — so what matters is
    // that the pinned value lands on "gone" rather than on a knot. It does:
    // 3e-6 of a peak that is itself 0.06 linear.
    expect(energyAt(0)).toBeLessThan(1e-5);
  });

  it('the fade onset and half-energy angles are the ones the header quotes', () => {
    // these are load-bearing numbers: they are the whole claim that the
    // convergence is visible before it dissolves
    const solve = (target: number) => {
      let lo = 1e-6;
      let hi = Math.PI / 2;
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (energyAt(mid) < target) lo = mid;
        else hi = mid;
      }
      return ((lo + hi) / 2) / DEG;
    };
    expect(solve(0.999)).toBeCloseTo(20.6, 0);
    expect(solve(0.5)).toBeCloseTo(9.9, 0);
    expect(solve(0.25)).toBeCloseTo(4.9, 0);
  });

  it('a coarser sample grid fades it sooner, never later', () => {
    for (const deg of [15, 8, 4]) {
      const fine = energyAt(deg * DEG, pixelAngleFor(55, 1440));
      const coarse = energyAt(deg * DEG, pixelAngleFor(55, 720));
      expect(coarse).toBeLessThanOrEqual(fine + 1e-12);
    }
  });

  it('the wave slope is a correction, not the filter — 10% at the equator', () => {
    // 1.22 against 7.80 — and that is the WORST case, at the equator: the
    // meridian term diverges toward the poles while this one stays put
    const meridian = n / TAU;
    expect(slope).toBeCloseTo(1.22, 2);
    expect(slope / meridian).toBeLessThan(0.2);
    expect(slope).toBeGreaterThan(0); // but it is not zero, so it is carried
  });
});

/**
 * THE WIND SPEED IS THE ONLY LEVER, and it is the live one. "Absent in a calm"
 * was an explicit part of the request; "intensify in storms" comes free from
 * the same gate, because a storm's wind is what rises.
 */
describe('the field answers the wind, and a calm sky is bare', () => {
  const gate = (v: number) => windLineGate(v, P.windLineOnset, P.windLineFull);

  it('is bare below Beaufort 3, where the sea itself first shows the wind', () => {
    expect(P.windLineOnset).toBeCloseTo(3.4, 6); // the whitecap rung
    for (const v of [0, 1, 2.6, 3.4]) {
      expect(gate(v)).toBe(0);
      // and every streak with it — not literally 0 (the base is floored, §V28)
      // but nine orders below a peak that is already 0.06 linear
      for (let i = 0; i < 200; i++) {
        const s = streakForIndex(i, 1.0, { wave: 0, waveB: 0, gust: 0 }, P, gate(v));
        expect(s.weight).toBeLessThan(1e-6);
      }
    }
  });

  it('the two lowest sea-state rungs draw nothing, the rest do', () => {
    // the ladder is the authority on what a calm IS (src/ui/settingsStore.ts)
    const rungs = SEA_STATES.map((r) => ({ id: r.id, g: gate(r.windSpeed) }));
    expect(rungs.filter((r) => r.g === 0).map((r) => r.id)).toEqual(['f1', 'f2']);
    // F3 — the first rung with whitecaps — is where the sky answers too
    expect(rungs.find((r) => r.id === 'f3')!.g).toBeGreaterThan(0);
  });

  it('fills in monotonically, and a gale is far more than the default', () => {
    let prev = -1;
    for (let v = 0; v <= 25; v += 0.5) {
      const g = gate(v);
      expect(g).toBeGreaterThanOrEqual(prev);
      prev = g;
    }
    const dflt = gate(11); // the shipped F6
    expect(dflt).toBeGreaterThan(0.4);
    expect(dflt).toBeLessThan(0.65); // real headroom left for a storm
    expect(gate(18)).toBeCloseTo(1, 6); // the ladder's top rung fills the sky
  });

  it('streaks fade in from the FAINT end, so none of them pops', () => {
    // the property that makes a rising wind read as air thickening rather than
    // as lines switching on — the same shape as starMagnitude's density gate
    const h = 0.5;
    const low = windLineWeight(h, gate(6), P.windLineDensityPower);
    const high = windLineWeight(h, gate(14), P.windLineDensityPower);
    expect(low).toBeGreaterThan(0);
    expect(high).toBeGreaterThan(low);
    // a streak whose hash sits just under the gate is the faintest one drawn
    const marginal = windLineWeight(gate(11) * 0.999, gate(11), P.windLineDensityPower);
    expect(marginal).toBeLessThan(1e-3);
  });

  it('the peak a streak is drawn at stays subtle against the sky', () => {
    // the day sky body is ~0.14/0.37/0.60 linear (params/sky.ts). A full
    // streak at the equator is a ~10% lift on blue at its very centre.
    const n = oddStreakCount(P.windLineCount);
    const slope = windLineWaveSlope(P.windLineWaveAmount, P.windLineWaveFreq);
    const peak = windLinePeakRadiance(
      P.windLineBrightness,
      1,
      P.windLineWidth,
      windLineFilter(n, 1, PX_1080, slope),
    );
    expect(peak).toBeCloseTo(P.windLineBrightness, 12);
    expect(peak).toBeLessThan(0.1);
  });
});

/**
 * §V.55, and this is the case the invariant is actually about: the drift rate
 * is `windSpeed × windLineDriftRate`, and the wind speed is LIVE.
 */
describe('§V.55: three independent phase accumulators', () => {
  const [k1, k2] = waveNumbers(P.windLineWaveFreq);
  const kg = TAU * P.windLineGustFreq;
  /** a wind that will not sit still — the whole point of the invariant */
  const speedAt = (t: number) => 9 + 7 * Math.sin(t * 0.11) + 2 * Math.sin(t * 0.7);

  it('stays wrapped and bounded over ten simulated minutes', () => {
    const dt = 1 / 60;
    let a = 0;
    let b = 0;
    let g = 0;
    let bad = 0;
    for (let i = 0; i < 36000; i++) {
      const drift = speedAt(i * dt) * P.windLineDriftRate;
      a = advanceWindPhase(a, k1 * drift, dt);
      b = advanceWindPhase(b, k2 * drift, dt);
      g = advanceWindPhase(g, kg * drift, dt);
      // counted rather than asserted per step: 36k × 3 expects is 2.4 s of
      // suite time for the same single fact
      for (const v of [a, b, g]) {
        if (!Number.isFinite(v) || v < 0 || v >= TAU) bad++;
      }
    }
    expect(bad).toBe(0);
    // and they must still be MOVING at the end — a wrap bug that pinned them
    // would also pass a bounds check
    const after = advanceWindPhase(a, k1 * 11 * P.windLineDriftRate, dt);
    expect(after).not.toBe(a);
  });

  it('the harmonic is its OWN accumulator, not the first one scaled', () => {
    // §V.55's clause about detuned harmonics: multiplying a WRAPPED value by a
    // non-integer ratio breaks continuity at every wrap. This is that bug,
    // measured — the naive `wrap(a) × ratio` drifts off the true phase.
    const dt = 1 / 60;
    let a = 0;
    let b = 0;
    let worst = 0;
    for (let i = 0; i < 6000; i++) {
      const drift = speedAt(i * dt) * P.windLineDriftRate;
      a = advanceWindPhase(a, k1 * drift, dt);
      b = advanceWindPhase(b, k2 * drift, dt);
      const naive = ((a * WAVE_RATIO) % TAU + TAU) % TAU;
      const d = Math.abs(((b - naive + Math.PI) % TAU + TAU) % TAU - Math.PI);
      worst = Math.max(worst, d);
    }
    expect(worst).toBeGreaterThan(1); // radians — a visible re-phasing
  });

  it('`time × rate` would run away, which is why it is not used', () => {
    // the §B.30 shape: the instantaneous frequency of t·ω(t) is ω + t·dω/dt, so
    // elapsed time multiplies every wobble in the rate. Reproduced here so the
    // accumulator above cannot be "simplified" back into a multiply.
    const rate = (t: number) => speedAt(t) * P.windLineDriftRate * k1;
    const naiveFreq = (t: number) => {
      const h = 1e-4;
      return ((t + h) * rate(t + h) - (t - h) * rate(t - h)) / (2 * h);
    };
    // the ENVELOPE over a window, not a point sample: the error term is
    // t·dω/dt and dω/dt is itself oscillating, so a single instant can land on
    // one of its zeros and say nothing
    const worstOver = (from: number, to: number) => {
      let worst = 0;
      for (let t = from; t <= to; t += 0.05) {
        worst = Math.max(worst, Math.abs(naiveFreq(t) - rate(t)));
      }
      return worst;
    };
    const early = worstOver(0, 10);
    const late = worstOver(590, 600);
    expect(late).toBeGreaterThan(20 * early);
    // ten minutes in, the phase error is not a detune — it is a different
    // signal. The true rate never leaves this band; the naive one is 30x it.
    expect(late).toBeGreaterThan(30 * rate(600));
  });

  it('a stalled tab cannot teleport the pattern', () => {
    // dt is clamped, not trusted: a hidden tab hands back a huge frame delta
    const jump = advanceWindPhase(0, 10, 30);
    const capped = advanceWindPhase(0, 10, 0.25);
    expect(jump).toBeCloseTo(capped, 12);
    // and non-finite inputs cannot poison the accumulator (§V28)
    expect(advanceWindPhase(1.2, Number.NaN, 1 / 60)).toBe(1.2);
    expect(Number.isFinite(advanceWindPhase(Number.NaN, 1, 1 / 60))).toBe(true);
  });
});

/**
 * §B.4 — the standing lesson about shared phase. The ocean's sparkle cells all
 * flipped on one 3 s beat; the flags got their own; so do these.
 */
describe('§B.4: the streaks do not ripple on one beat', () => {
  const phases = { wave: 0.4, waveB: 2.2, gust: 4.9 };

  it('neighbouring streaks are out of phase with each other', () => {
    const at = (i: number) => streakForIndex(i, 0.9, phases, P, 1).offset;
    const offsets = [];
    for (let i = 0; i < 40; i++) offsets.push(at(i));
    // if every streak shared a phase these would all be identical
    const spread = Math.max(...offsets) - Math.min(...offsets);
    expect(spread).toBeGreaterThan(P.windLineWaveAmount);
  });

  it('the wave, the second wave, the gust and the density are decorrelated', () => {
    // four hash streams, one per property (§B.4). Correlated streams would tie
    // every bright streak to the same wave phase, which is the bug on the
    // minority that most catches the eye.
    const rows: number[][] = [];
    for (let i = 0; i < 400; i++) {
      const s = streakForIndex(i, 0.0, { wave: 0, waveB: 0, gust: 0 }, P, 1);
      // theta 0 and zero phases ⇒ offset and gust are pure functions of the
      // hashes, so this compares the STREAMS rather than the waveforms
      rows.push([s.offset, s.gust, s.weight]);
    }
    const corr = (a: number[], b: number[]) => {
      const ma = a.reduce((x, y) => x + y, 0) / a.length;
      const mb = b.reduce((x, y) => x + y, 0) / b.length;
      let num = 0;
      let da = 0;
      let db = 0;
      for (let i = 0; i < a.length; i++) {
        num += (a[i] - ma) * (b[i] - mb);
        da += (a[i] - ma) ** 2;
        db += (b[i] - mb) ** 2;
      }
      return num / Math.sqrt(Math.max(da * db, 1e-12));
    };
    const col = (j: number) => rows.map((r) => r[j]);
    expect(Math.abs(corr(col(0), col(1)))).toBeLessThan(0.2);
    expect(Math.abs(corr(col(0), col(2)))).toBeLessThan(0.2);
    expect(Math.abs(corr(col(1), col(2)))).toBeLessThan(0.2);
  });

  it('the gust envelope is bounded and actually cuts', () => {
    let lo = 1;
    let hi = 0;
    for (let i = 0; i < 200; i++) {
      for (let t = 0; t <= Math.PI; t += 0.05) {
        const g = streakForIndex(i, t, phases, P, 1).gust;
        lo = Math.min(lo, g);
        hi = Math.max(hi, g);
      }
    }
    expect(lo).toBeGreaterThanOrEqual(1 - P.windLineGustDepth - 1e-12);
    expect(hi).toBeLessThanOrEqual(1 + 1e-12);
    expect(hi - lo).toBeGreaterThan(0.5); // it is a gust, not a hum
  });
});

/**
 * §V.22: prove the graph BUILDS and the uniform path survives, rather than
 * claiming "it works" — nothing here has been rendered.
 */
describe('integration surface', () => {
  it('builds, and update() survives a whole day and a whole gale', async () => {
    const { createWindLines } = await import('../src/sky/windLines');
    const { keyLight } = await import('../src/sky/moonCycle');
    const THREE = await import('three/webgpu');
    const w = createWindLines(P);
    expect(w.node).toBeTruthy();
    const haze = new THREE.Color(0.6, 0.7, 0.8);
    for (let t = 0; t < 24; t += 0.5) {
      for (const speed of [0, 3.4, 11, 18, 25]) {
        w.update(keyLight(t, P), { direction: t * 0.3, speed, dt: 1 / 60 }, haze);
      }
    }
  });

  it('non-finite wind cannot poison the uniforms (§V28)', async () => {
    const { createWindLines } = await import('../src/sky/windLines');
    const { keyLight } = await import('../src/sky/moonCycle');
    const THREE = await import('three/webgpu');
    const w = createWindLines(P);
    const haze = new THREE.Color(0.6, 0.7, 0.8);
    w.update(
      keyLight(12, P),
      { direction: Number.NaN, speed: Number.POSITIVE_INFINITY, dt: Number.NaN },
      haze,
    );
    // the frame it produced must still be a usable one on the next tick
    w.update(keyLight(12, P), { direction: 0.5, speed: 11, dt: 1 / 60 }, haze);
    expect(Number.isFinite(windLineGate(Number.NaN, P.windLineOnset, P.windLineFull))).toBe(true);
  });
});
