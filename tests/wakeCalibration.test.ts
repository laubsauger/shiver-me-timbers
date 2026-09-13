/**
 * §T W2a — AMPLITUDE CALIBRATION of the hull-sampled wake, galleon at 7 m/s on
 * the shipped wake tier (docs/wake/w2a-source-model.md §2, targets from
 * docs/wake/w0-measurement.md §6).
 *
 * WHY each bound exists:
 *  - near-hull peak-to-trough ≥ 0.3·Hs (0.83 m on the default swell): below it
 *    the wake is as invisible as the analytic field W0 measured. ≤ 2.0 m: a
 *    35 m hull at Fn 0.375 is not a hovercraft — the raw hydrostatic head
 *    (W1, no depth attenuation) read 6 m and hit the ±3 m clamp.
 *  - cusp slope ≥ 0.14 = the sea's own RMS slope, or the crest shading is lost
 *    in the noise (W0 §6). < 0.40: below the Stokes limiting steepness 0.44,
 *    i.e. inside the linear model's validity — a steeper wake would be breaking
 *    water the solver cannot represent.
 *  - no clamp hits: the §V44 clamp is a backstop, not a shaper.
 * These FAIL if the source depth is removed (p2t 5.9 m, slope 1.35) or the
 * depth is halved/doubled (see the write-up's mutation table).
 */
import { describe, expect, it } from 'vitest';
import { GRAVITY } from '../src/ocean/oceanMath';
import {
  W0_SWELL_HS,
  WAKE_DOMAIN_PER_LAMBDA_T,
  WAKE_SHIP_TIER,
  measureWake,
  presetByName,
  presetFrame,
  presetSamples,
  towPreset,
  type WakeReadout,
} from '../src/wake/wakeCalibration';
import { WakeSolverCpu, WakeSourceBuffer } from '../src/wake/wakeSolverMath';

describe('galleon 7 m/s: a readable, unsaturated, non-breaking wake from her own stations', () => {
  const preset = presetByName('galleon-7');
  let readout: WakeReadout | null = null;
  let movingEnergy = 0;
  const get = (): WakeReadout => {
    if (!readout) {
      const tow = towPreset(preset, { dt: 0.1, duration: 45 });
      readout = measureWake(tow.solver, tow.frame, tow.x, preset.speed);
      movingEnergy = tow.solver.energy();
    }
    return readout;
  };

  it('near-hull peak-to-trough in [0.3·Hs, 2.0] m', () => {
    const r = get();
    expect(r.nearHullPeakToTrough).toBeGreaterThanOrEqual(0.3 * W0_SWELL_HS);
    expect(r.nearHullPeakToTrough).toBeLessThanOrEqual(2.0);
  }, 30_000);

  it('cusp slope in [0.14, 0.40): steeper than the sea’s RMS slope, short of breaking', () => {
    const r = get();
    expect(r.cuspSlope).toBeGreaterThanOrEqual(0.14);
    expect(r.cuspSlope).toBeLessThan(0.4);
  }, 30_000);

  it('no texel reaches the ±3 m source clamp', () => {
    expect(get().clampHits).toBe(0);
  }, 30_000);

  it('V102: the same hull at rest makes no wake — energy < 1e-4 of the 7 m/s wake 30 s after she settles', () => {
    // at rest the only waves are the launch transient of lowering her in (10 s
    // ramp), radiating away; measured 2.4e-4 at 20 s, 4.5e-5 at 30 s after the
    // ramp. A missing or mis-scaled cancellation leaves a standing field instead.
    get();
    const s = new WakeSolverCpu({ n: preset.n, texel: preset.texel });
    const buf = new WakeSourceBuffer();
    const samples = presetSamples(preset, 0);
    for (let k = 0; k < 400; k++) {
      const r = Math.min(1, (k * 0.1) / 10);
      const ramp = r * r * (3 - 2 * r);
      buf.clear();
      for (const q of samples) buf.push(q.x, q.z, q.fy * ramp, q.footprint, q.depth);
      s.splat(buf);
      s.step(0.1);
    }
    expect(movingEnergy).toBeGreaterThan(0);
    expect(s.energy() / movingEnergy).toBeLessThan(1e-4);
  }, 30_000);

  it('W3: the raft at her 2 m/s cruise peaks at ≤ 0.15 of the galleon’s 7 m/s peak', () => {
    const galleon = get();
    const raft = presetByName('raft-2');
    const tow = towPreset({ ...raft, n: 128 }, { dt: 0.05, duration: 30 });
    const r = measureWake(tow.solver, tow.frame, tow.x, raft.speed);
    expect(r.maxAbs).toBeGreaterThan(0);
    expect(r.maxAbs / galleon.maxAbs).toBeLessThanOrEqual(0.15);
  }, 30_000);
});

describe('wake tier (W0 §6 extent): the domain holds the longest ship wave', () => {
  /**
   * WHY: measured in the W2a write-up §4 — at 10 m/s (λ_T 64 m) a 128 m domain
   * recirculated the transverse train past the sponge and inflated near-hull
   * peak-to-trough by 85% against a 256 m reference; 160 m stayed within ~10%.
   * The tier must keep L_dom ≥ 2.4·λ_T at the fastest ship speed (10 m/s).
   */
  it('256² tier spans ≥ 2.4 λ_T(10 m/s) and the galleon 10 m/s preset uses it', () => {
    const lambda = (2 * Math.PI * 100) / GRAVITY;
    expect(WAKE_SHIP_TIER.n * WAKE_SHIP_TIER.texel).toBeGreaterThanOrEqual(WAKE_DOMAIN_PER_LAMBDA_T * lambda);
    const g10 = presetByName('galleon-10');
    expect(g10.n * g10.texel).toBe(WAKE_SHIP_TIER.n * WAKE_SHIP_TIER.texel);
    // and the stem's wake starts inside the interior: bow-anchored, not origin-anchored
    expect(presetFrame(g10).stem).toBeGreaterThan(15);
  });
});
