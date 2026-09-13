/**
 * §T W1 — the eWave solver, CPU reference (docs/wake/wake-research.md §2, §6 W1).
 *
 * Every block states WHY the property matters and is written so that it FAILS
 * if the dispersion relation, the integrator or the forcing changes — never a
 * snapshot of today's numbers (§V80). The Kelvin / high-Froude properties live
 * in tests/wakeKelvin.test.ts.
 *
 * GPU-free by design: node has no WebGPU. The TSL twin is checked here only
 * STRUCTURALLY (one compute group, shared expressions imported not copied);
 * the numeric CPU↔GPU agreement is the browser comparison in
 * src/wake/preview.ts (`__wakePond.compare()`), per §V22.
 */
import { describe, expect, it } from 'vitest';
import { GRAVITY, dispersion } from '../src/ocean/oceanMath';
import {
  WAKE_ETA_CLAMP,
  WAKE_MAX_SAMPLES,
  WAKE_RHO,
  WakeSolverCpu,
  WakeSourceBuffer,
  defaultSponge,
  fft2d,
  modeWavenumber,
  splatSigma,
  wakeAnchor,
  wakeButterflyTables,
  type WakeSpongeParams,
} from '../src/wake/wakeSolverMath';
import { WakeSolverGpu, wakeDispatchCount } from '../src/wake/wakeSolverPasses';
import passesSource from '../src/wake/wakeSolverPasses.ts?raw';

const NO_SPONGE: WakeSpongeParams = { width: 0.15, gammaMax: 0 };

function maxAbs(a: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]));
  return m;
}

describe('butterfly transform pairing (§V77 — the ocean table, not a second FFT)', () => {
  /**
   * WHY: the forward transform is the ocean's inverse table with conjugated
   * twiddles. If either the conjugation or the 1/N² placement is wrong the
   * solver silently runs on a scaled or mirrored spectrum. Round trip must be
   * identity to Float32-twiddle precision.
   */
  it('forward then inverse is N²·identity', () => {
    const n = 64;
    const t = wakeButterflyTables(n);
    const re = new Float64Array(n * n);
    const im = new Float64Array(n * n);
    for (let i = 0; i < n * n; i++) {
      re[i] = Math.sin(i * 0.37) + Math.cos(i * 1.3);
      im[i] = Math.cos(i * 0.11);
    }
    const r0 = Float64Array.from(re);
    const i0 = Float64Array.from(im);
    fft2d(re, im, n, t.forward);
    fft2d(re, im, n, t.inverse);
    let err = 0;
    for (let i = 0; i < n * n; i++) err = Math.max(err, Math.abs(re[i] / (n * n) - r0[i]), Math.abs(im[i] / (n * n) - i0[i]));
    expect(err).toBeLessThan(2e-6);
  });

  it('forward table puts a cosine of k modes at spectral index ±k (sign convention the evolve pass assumes)', () => {
    const n = 32;
    const t = wakeButterflyTables(n);
    const re = new Float64Array(n * n);
    const im = new Float64Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) re[y * n + x] = Math.cos((2 * Math.PI * 3 * x) / n);
    fft2d(re, im, n, t.forward);
    // e^{-2πikx/N} kernel: energy only at kx = 3 and kx = N−3, ky = 0
    expect(re[3]).toBeCloseTo((n * n) / 2, 2);
    expect(re[n - 3]).toBeCloseTo((n * n) / 2, 2);
    expect(Math.abs(re[4])).toBeLessThan(1e-3);
  });
});

describe('V-W6 step-rate free: the integrator is exact, Δt is a quality knob only', () => {
  /**
   * WHY (§V2): the CPU band steps on the fixed tick, the GPU on the render
   * frame. If the period depended on Δt, the wake's speed — and λ_T, and the
   * Kelvin angle — would change with frame rate. A symplectic-Euler or
   * leapfrog step would pass at 120 Hz and fail at 30 Hz here.
   */
  const periodAt = (dt: number): number => {
    const n = 64;
    const texel = 0.5;
    const s = new WakeSolverCpu({ n, texel, sponge: NO_SPONGE });
    const m = 20; // λ = 1.6 m, T ≈ 1.01 s
    const k = (2 * Math.PI * m) / s.domain;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) s.zeta[j * n + i] = 0.1 * Math.cos(k * i * texel);
    let prev = s.zeta[0];
    const crossings: number[] = [];
    for (let step = 0; step < 1000; step++) {
      s.step(dt);
      const v = s.zeta[0];
      if (prev > 0 && v <= 0) crossings.push(s.time - (dt * v) / (v - prev));
      prev = v;
    }
    return (crossings[crossings.length - 1] - crossings[0]) / (crossings.length - 1);
  };

  it('a single mode keeps period 2π/√(g|k|) ±0.1% after 1000 steps at 30/60/120 Hz, runs agree to 1e-4', () => {
    const k = (2 * Math.PI * 20) / 32;
    const expected = (2 * Math.PI) / dispersion(k);
    const periods = [1 / 30, 1 / 60, 1 / 120].map(periodAt);
    for (const p of periods) expect(Math.abs(p / expected - 1)).toBeLessThan(1e-3);
    expect(Math.max(...periods) / Math.min(...periods) - 1).toBeLessThan(1e-4);
  });

  it('a pressed source radiates the SAME field at t = 3 s whether stepped at 30, 60 or 120 Hz', () => {
    // sponge off: the ramp is operator-split from the rotation, which is a
    // boundary-layer effect measured separately below — this pins the physics
    const run = (hz: number): Float32Array => {
      const s = new WakeSolverCpu({ n: 64, texel: 0.5, sponge: NO_SPONGE });
      const src = new WakeSourceBuffer();
      src.push(0.3, -0.2, 1e5, 1.2);
      s.splat(src);
      for (let i = 0; i < 3 * hz; i++) s.step(1 / hz);
      return s.surface;
    };
    const [a, b, c] = [30, 60, 120].map(run);
    const scale = maxAbs(c);
    expect(scale).toBeGreaterThan(1e-3); // the source did radiate
    let d = 0;
    for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - c[i]), Math.abs(b[i] - c[i]));
    expect(d / scale).toBeLessThan(1e-4);
  });

  it('the sponge absorbs per SECOND, not per step: energy left after 20 s agrees to 1% at 30 vs 120 Hz', () => {
    // e^(−γΔt) per step; operator splitting against the rotation is the only
    // residual (measured 0.2%). A per-step constant factor would differ 4×.
    const left = (hz: number): number => {
      const s = new WakeSolverCpu({ n: 64, texel: 0.5 });
      for (let j = 0; j < 64; j++) {
        for (let i = 0; i < 64; i++) {
          const x = (i - 32) * 0.5;
          const z = (j - 32) * 0.5;
          s.zeta[j * 64 + i] = 0.2 * Math.exp(-(x * x + z * z) / 8);
        }
      }
      const e0 = s.energy();
      for (let i = 0; i < 20 * hz; i++) s.step(1 / hz);
      return s.energy() / e0;
    };
    const a = left(30);
    const b = left(120);
    expect(a).toBeLessThan(0.5); // the sponge did something
    expect(Math.abs(a / b - 1)).toBeLessThan(0.01);
  });
});

describe('energy: a wake that grows is the V28 wedge in slow motion', () => {
  /**
   * WHY: E = ½ρΔA·Σ(g|η̂|² + |k||φ̂|²) is conserved by the exact rotation and
   * may only ever be REMOVED (sponge, Float32-twiddle round-off). Any growth
   * compounds per step and eventually saturates the ±3 m clamp everywhere.
   */
  it('sources off, sponge off: E never increases over 10⁴ steps and is conserved to 1%', () => {
    const n = 64;
    const texel = 0.5;
    const s = new WakeSolverCpu({ n, texel, sponge: NO_SPONGE });
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = (i - n / 2) * texel;
        const z = (j - n / 2) * texel;
        s.zeta[j * n + i] = 0.2 * Math.exp(-(x * x + z * z) / 8) * Math.cos(1.7 * x + 0.4 * z);
        s.phi[j * n + i] = 0.05 * Math.exp(-(x * x + z * z) / 20) * Math.sin(0.9 * z);
      }
    }
    const e0 = s.energy();
    let prev = e0;
    for (let step = 1; step <= 10000; step++) {
      s.step(1 / 60);
      if (step % 50 === 0) {
        const e = s.energy();
        expect(e).toBeLessThanOrEqual(prev * (1 + 1e-9));
        prev = e;
      }
    }
    expect(prev / e0).toBeGreaterThan(0.99);
  }, 30_000);

  it('the sponge removes a free packet: < 1e-3 of the energy remains after 60 s', () => {
    const n = 64;
    const texel = 0.5;
    const s = new WakeSolverCpu({ n, texel });
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = (i - n / 2) * texel;
        const z = (j - n / 2) * texel;
        s.zeta[j * n + i] = 0.2 * Math.exp(-(x * x + z * z) / 8);
      }
    }
    const e0 = s.energy();
    for (let i = 0; i < 600; i++) s.step(0.1);
    expect(s.energy() / e0).toBeLessThan(1e-3);
  });
});

describe('sponge: open boundary, not a mirror and not a wrap', () => {
  /**
   * WHY: the FFT domain is periodic. Energy that reflects off the ramp, or
   * crosses it and wraps round, re-enters the wake as phantom waves arriving
   * from ahead of the ship (research §2.5 failure mode).
   *
   * A plane packet travelling +x is split into +x and −x travelling energy
   * spectrally: for a +x wave φ̂ = −i·sgn(kx)·(ω/|k|)·η̂. The −x share at any
   * time is reflection. Criterion read as ENERGY fraction < 2% (see report:
   * the amplitude coefficient is also printed).
   */
  const reflection = (lambda: number, width: number): { reflected: number; residual: number } => {
    const n = 128;
    const texel = 0.5;
    const s = new WakeSolverCpu({ n, texel });
    const L = s.domain;
    const nn = n * n;
    const t = wakeButterflyTables(n);
    const k0 = (2 * Math.PI) / lambda;
    const re = new Float64Array(nn);
    const im = new Float64Array(nn);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = (i - n / 2) * texel;
        re[j * n + i] = 0.1 * Math.exp(-(x * x) / (2 * width * width)) * Math.cos(k0 * x) * ((i + j) & 1 ? -1 : 1);
      }
    }
    fft2d(re, im, n, t.forward);
    const pr = new Float64Array(nn);
    const pi = new Float64Array(nn);
    const q = (idx: number): number => {
      const kx = modeWavenumber(idx % n, n, L);
      const kz = modeWavenumber(Math.floor(idx / n), n, L);
      const km = Math.hypot(kx, kz);
      return km === 0 ? 0 : (Math.sign(kx) * km) / dispersion(km);
    };
    for (let idx = 0; idx < nn; idx++) {
      const f = q(idx) === 0 ? 0 : -1 / q(idx);
      pr[idx] = f * im[idx];
      pi[idx] = -f * re[idx];
    }
    fft2d(re, im, n, t.inverse);
    fft2d(pr, pi, n, t.inverse);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const idx = j * n + i;
        const sg = (i + j) & 1 ? -1 : 1;
        s.zeta[idx] = (re[idx] * sg) / nn;
        s.phi[idx] = (pr[idx] * sg) / nn;
      }
    }
    const split = (): { fwd: number; back: number } => {
      const er = new Float64Array(nn);
      const ei = new Float64Array(nn);
      const ar = new Float64Array(nn);
      const ai = new Float64Array(nn);
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const idx = j * n + i;
          const sg = (i + j) & 1 ? -1 : 1;
          er[idx] = s.zeta[idx] * sg;
          ar[idx] = s.phi[idx] * sg;
        }
      }
      fft2d(er, ei, n, t.forward);
      fft2d(ar, ai, n, t.forward);
      let fwd = 0;
      let back = 0;
      for (let idx = 0; idx < nn; idx++) {
        const qq = q(idx);
        // +x part (η̂ − i·q·φ̂)/2, −x part (η̂ + i·q·φ̂)/2
        const fr = (er[idx] + qq * ai[idx]) / 2;
        const fi = (ei[idx] - qq * ar[idx]) / 2;
        const br = (er[idx] - qq * ai[idx]) / 2;
        const bi = (ei[idx] + qq * ar[idx]) / 2;
        fwd += fr * fr + fi * fi;
        back += br * br + bi * bi;
      }
      return { fwd, back };
    };
    const e0 = split();
    expect(e0.back / e0.fwd).toBeLessThan(1e-6); // the packet really is one-way
    const cg = 0.5 * Math.sqrt(GRAVITY / k0);
    const T = Math.max((1.5 * L) / cg, 60);
    let worst = 0;
    let step = 0;
    for (let time = 0; time < T; time += 0.2, step++) {
      s.step(0.2);
      if (step % 10 === 9) worst = Math.max(worst, split().back);
    }
    const end = split();
    return { reflected: worst / e0.fwd, residual: (end.fwd + end.back) / e0.fwd };
  };

  for (const [lambda, width] of [
    [2, 3], // 4 texels — the doc's short end
    [8, 6],
    [16, 10], // L_dom/4 at 128² × 0.5 m — the long end, the hard case for a 15% ramp
  ] as const) {
    it(`λ = ${lambda} m: reflected energy < 2% and nothing survives to wrap (< 2%)`, () => {
      const r = reflection(lambda, width);
      expect(r.reflected).toBeLessThan(0.02);
      expect(r.residual).toBeLessThan(0.02);
    }, 30_000);
  }
});

describe('V-W3 static cancellation: a vessel at anchor makes no wake and does not sink', () => {
  /**
   * WHY: a steadily pressed patch must settle to η = −h_P so the DRAWN and
   * FLOATED surface η + h_P is flat. Without it a displacement hull reads a
   * hole the depth of its own draft and double-counts its hydrostatics.
   * Fails if the forcing sign, the DC handling or the head used in η_vis
   * differ from the head that forced.
   */
  // depth 0 = a surface pressure (W1); 2.4 m = a galleon keel, two bins (W2a).
  // The buried case must cancel just as exactly: the head that is DRAWN and the
  // head that FORCES are the same attenuated field, or a keel-deep hull would
  // sit in a permanent static rim of h − h'.
  for (const [depth, spread] of [
    [0, 0],
    [2.4, 0.6],
  ] as const) {
    it(`RMS η_vis within 6 m of a stationary 1.3 m head settles below 1% of the head (source depth ${depth} m)`, () => {
      const n = 128;
      const texel = 0.5;
      const s = new WakeSolverCpu({ n, texel });
      const src = new WakeSourceBuffer();
      src.push(-0.5, 0, 1e5, 1.5, depth - spread);
      src.push(0.5, 0, 1e5, 1.5, depth + spread);
      s.splat(src);
      const head = maxAbs(s.head);
      expect(head).toBeGreaterThan(1);
      let early = 0;
      for (let i = 0; i < 600; i++) {
        s.step(0.1);
        if (i < 5) early = Math.max(early, maxAbs(s.surface));
      }
      let sum = 0;
      let count = 0;
      let far = 0;
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const x = (i - n / 2) * texel;
          const z = (j - n / 2) * texel;
          const v = s.surface[j * n + i];
          if (x * x + z * z < 36) {
            sum += v * v;
            count++;
          } else far = Math.max(far, Math.abs(v));
        }
      }
      expect(Math.sqrt(sum / count) / head).toBeLessThan(0.01);
      // open sea: no pond rise away from the hull either
      expect(far / head).toBeLessThan(0.01);
      // and the pressing really happened — the switch-on transient radiated
      // (an inert solver, or one that ignored the head, never shows it)
      expect(early).toBeGreaterThan(0.1 * head);
    });
  }
});

describe('V-W2 Newton 3 at the splat: ∫ρg·h_P dA = Σ fy', () => {
  /** WHY: the wake is the reaction to the hull's own force; a mis-normalised kernel scales every wake. */
  it('holds to 0.5% for footprints from sub-texel to 3 m, anywhere on the grid', () => {
    const s = new WakeSolverCpu({ n: 128, texel: 0.5 });
    const src = new WakeSourceBuffer();
    const forces = [3e4, 1.2e5, 7e5, 2e6];
    const footprints = [0.1, 0.5, 1.3, 3];
    let total = 0;
    for (let v = 0; v < 4; v++) {
      src.push(-17.3 + v * 11.1, 9.7 - v * 6.4, forces[v], footprints[v]);
      total += forces[v];
    }
    s.splat(src);
    let integral = 0;
    for (const h of s.head) integral += h * WAKE_RHO * GRAVITY * s.texel * s.texel;
    expect(Math.abs(integral / total - 1)).toBeLessThan(0.005);
  });

  it('holds ≥ 8 vessels × 64 samples at once (capacity), then counts overflow instead of dropping silently', () => {
    const src = new WakeSourceBuffer();
    expect(WAKE_MAX_SAMPLES).toBeGreaterThanOrEqual(8 * 64);
    for (let v = 0; v < 8; v++) {
      const hull = Array.from({ length: 64 }, (_, i) => ({ x: v * 10 + i * 0.1, z: v, fy: 1e3, footprint: 0.5, depth: 0 }));
      expect(src.pushVessel(hull)).toBe(64);
    }
    expect(src.push(0, 0, 1, 1)).toBe(false);
    expect(src.overflowed).toBe(1);
  });
});

describe('scroll / re-origin (V-W5): an exact texel shift, world-anchored', () => {
  /**
   * WHY: the domain follows the hero vessel. A scroll that resampled, flipped
   * a sign on odd shifts (the (−1)^(x+y) centring!) or moved the field the
   * wrong way would smear or teleport the wake every time the ship crosses a
   * texel. On a periodic grid the step commutes with a whole-texel shift, so
   * shift→step must equal step→shift wherever nothing was dropped.
   */
  it('shift-then-step equals step-then-shift to 1e-4 (odd shift, sources in world space)', () => {
    const n = 128;
    const texel = 0.5;
    const a = new WakeSolverCpu({ n, texel, sponge: NO_SPONGE });
    const b = new WakeSolverCpu({ n, texel, sponge: NO_SPONGE });
    for (const s of [a, b]) {
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const x = (i - n / 2) * texel;
          const z = (j - n / 2) * texel;
          s.zeta[j * n + i] = 0.3 * Math.exp(-(x * x + z * z) / 18) * Math.cos(0.8 * x);
        }
      }
    }
    const src = new WakeSourceBuffer();
    src.push(1.1, -0.6, 8e4, 1.2);
    const shift = { x: 5 * texel, z: -3 * texel };
    // A: shift, then step
    a.setCenter(shift.x, shift.z);
    a.splat(src);
    a.step(0.3);
    // B: step, then shift
    b.splat(src);
    b.step(0.3);
    b.setCenter(shift.x, shift.z);
    expect(a.centerX).toBe(b.centerX);
    let d = 0;
    let m = 0;
    for (let j = 10; j < n - 10; j++) {
      for (let i = 10; i < n - 10; i++) {
        d = Math.max(d, Math.abs(a.surface[j * n + i] - b.surface[j * n + i]));
        m = Math.max(m, Math.abs(b.surface[j * n + i]));
      }
    }
    expect(m).toBeGreaterThan(0.05);
    expect(d / m).toBeLessThan(1e-4);
  });

  it('a world point reads the same η_vis immediately after re-centring (direction and texel snap)', () => {
    const s = new WakeSolverCpu({ n: 64, texel: 0.5 });
    const src = new WakeSourceBuffer();
    src.push(2, 1, 1e5, 1);
    s.splat(src);
    for (let i = 0; i < 10; i++) s.step(0.1);
    const probe = [3.0, -1.5] as const;
    const before = s.surfaceAt(probe[0], probe[1]);
    const moved = s.setCenter(2.26, -0.74); // snaps to (2.5, -0.5): 5 and −1 texels
    expect(moved).toEqual({ sx: 5, sz: -1 });
    expect(s.centerX).toBe(2.5);
    expect(s.surfaceAt(probe[0], probe[1])).toBe(before);
  });
});

describe('V28: non-finite inputs never reach the field', () => {
  /** WHY (§B5): one NaN splat is a NaN spectrum is a NaN sea after one inverse FFT. */
  it('NaN/Inf samples are dropped and counted; a vessel with one bad station is skipped whole', () => {
    const src = new WakeSourceBuffer();
    expect(src.push(NaN, 0, 1e5, 1)).toBe(false);
    expect(src.push(0, Infinity, 1e5, 1)).toBe(false);
    expect(src.push(0, 0, NaN, 1)).toBe(false);
    expect(src.push(0, 0, 1e5, -Infinity)).toBe(false);
    expect(src.dropped).toBe(4);
    const hull = [
      { x: 0, z: 0, fy: 1e5, footprint: 1, depth: 0 },
      { x: 1, z: 0, fy: NaN, footprint: 1, depth: 0 },
    ];
    expect(src.pushVessel(hull)).toBe(0);
    expect(src.count).toBe(0);
    expect(src.push(0, 0, -5e4, 1)).toBe(true); // negative force clamps to 0, not a suction hole
    expect(src.data[2]).toBe(0);
  });

  it('with NaN samples, NaN/Inf Δt and a NaN re-centre in the mix, the field stays finite and bounded', () => {
    const s = new WakeSolverCpu({ n: 64, texel: 0.5 });
    const src = new WakeSourceBuffer();
    src.push(NaN, NaN, NaN, NaN);
    src.push(0, 0, 1e9, 0.2); // absurd force: clamp at source must hold
    s.setCenter(NaN, 3);
    s.splat(src);
    s.step(NaN);
    s.step(Infinity);
    for (let i = 0; i < 20; i++) s.step(1 / 60);
    for (const v of s.surface) expect(Number.isFinite(v)).toBe(true);
    expect(maxAbs(s.surface)).toBeLessThanOrEqual(WAKE_ETA_CLAMP);
    expect(s.centerX).toBe(0);
  });
});

describe('anchor (V-W5 + W0): the sponge must not eat the bow wave or the first cusp', () => {
  /**
   * WHY (docs/wake/w0-measurement.md §6): at 10 m/s λ_T = 64 m. An anchor
   * keyed on the ship ORIGIN put the galleon's stem (+21 m) inside the front
   * sponge. Property: the bow's splat reach and the first transverse crest
   * astern of the stem at 10 m/s both lie in the unsponged interior of the
   * default 256² × 0.5 m tier, for any heading.
   */
  it('galleon at 10 m/s, any heading: stem splat and first cusp crest inside the interior', () => {
    const n = 256;
    const texel = 0.5;
    const domain = n * texel;
    const sponge = defaultSponge(n, texel);
    const stem = 21;
    const reach = 4 * splatSigma(1, texel, n);
    const lambdaT = (2 * Math.PI * 10 * 10) / GRAVITY;
    const cusp = Math.asin(1 / 3);
    const interior = (0.5 - sponge.width) * domain;
    for (let h = 0; h < 8; h++) {
      const yaw = (h * Math.PI) / 4 + 0.3;
      const fx = Math.cos(yaw);
      const fz = Math.sin(yaw);
      const c = wakeAnchor(1000.3, -250.7, fx, fz, stem, domain, sponge, reach);
      const inside = (px: number, pz: number): boolean =>
        Math.abs(px - c.x) <= interior + 1e-9 && Math.abs(pz - c.z) <= interior + 1e-9;
      const sx = 1000.3 + fx * stem;
      const sz = -250.7 + fz * stem;
      expect(inside(sx + fx * reach * 0.999, sz + fz * reach * 0.999)).toBe(true);
      // first cusp point: λ_T astern of the stem on the ±19.47° rays
      for (const side of [-1, 1]) {
        const ax = -Math.cos(cusp) * lambdaT;
        const az = side * Math.sin(cusp) * lambdaT;
        expect(inside(sx + fx * ax - fz * az, sz + fz * ax + fx * az)).toBe(true);
      }
    }
  });
});

describe('V-W7 one compute group + §V77/§V95 one implementation (structural, GPU-free)', () => {
  /**
   * WHY: the frame is CPU-bound and three encodes one compute pass per
   * `renderer.compute()` call; the wake must be ONE array. And the TSL twin
   * must consume the CPU's shared expressions, not re-derive them.
   */
  it('builds exactly 3 + 4·log2(N) dispatches, ≤ 40 at the 256² default', () => {
    expect(wakeDispatchCount(256)).toBe(35);
    expect(wakeDispatchCount(256)).toBeLessThanOrEqual(40);
    const gpu = new WakeSolverGpu({ n: 256 });
    expect(gpu.computeNodes.length).toBe(35);
    for (const node of gpu.computeNodes) expect(node.isComputeNode).toBe(true);
    gpu.dispose();
  });

  it('submits the whole group in ONE renderer.compute call and imports, never copies, the shared math', () => {
    const code = passesSource
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*\*)/.test(l))
      .join('\n');
    const calls = code.match(/renderer\.compute\(/g) ?? [];
    expect(calls.length).toBe(1);
    expect(passesSource).toMatch(/renderer\.compute\(this\.computeNodes\)/);
    expect(passesSource).toMatch(/import \{ buildFftPasses \} from '\.\.\/ocean\/fftPasses'/);
    for (const shared of ['dispersion', 'splatSigma', 'splatPeakHead', 'spongeGammaAxis', 'modeWavenumber', 'wakeButterflyTables']) {
      expect(passesSource).toContain(shared);
    }
    // ω per mode is the ocean's `dispersion`, evaluated once — no second law in the shader
    expect(code).toMatch(/= dispersion\(k\)/);
    expect(code).not.toMatch(/sqrt\([^)]*uDt/);
  });
});
