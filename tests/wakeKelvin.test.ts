/**
 * V-W1 WAKE IS SOLVED, NOT DRAWN — the Kelvin pattern as a property of
 * physics (docs/wake/wake-research.md §2.1, §6 W1 test 2).
 *
 * A Gaussian pressure patch is towed through the CPU solver in its own frame
 * (the domain re-origins every texel exactly like the game will), and the
 * angle, narrowing and wavelength are MEASURED from the field. Nothing in
 * src/wake knows any of these numbers; they must come out of ω² = g|k|.
 * Change the dispersion relation, the integrator, the forcing sign or the
 * splat width law and these fail.
 *
 * REFERENCE: Darmon, Benzaquen & Raphaël 2014 (JFM 738 R3, arXiv 1309.6751)
 * — the theory for EXACTLY this forcing, a Gaussian pressure field of size b
 * with P̂(K) = exp(−K²/4π²), K = kb, Fr = U/√(gb). Our splat is
 * exp(−r²/2σ²) ⇒ b = π√2·σ_eff. Their results used here:
 *   - Fr ≲ 0.3: the maximum of the angular envelope is ON THE TRACK
 *     (transverse waves dominate); φ_max jumps to the Kelvin plateau at
 *     Fr ≈ 0.31 and stays there to Fr ≈ 0.7 (their Fig. 2 reads ≈ 0.30 rad,
 *     just inside φ_K = 19.47° — the finite-distance caustic offset).
 *   - large Fr: φ_max = 1/(40^¼·√π·Fr) rad = 12.85°/Fr (their eq. 4.11),
 *     approached from ABOVE (their Fig. 2).
 * The research doc's 19.5 ± 1.5° at Fr 0.30 and 11 ± 2.5° at Fr 1.0 come from
 * Rabaud & Moisy's HULL-LENGTH law, which is not this forcing — see the W1
 * report for that deviation.
 *
 * MEASUREMENT. Phase-free envelope A² = η² + φ·(|k|φ)/g (for a free wave this
 * is exactly the squared amplitude at every phase). Averaged along rays from
 * the source over r ∈ [0.2, 0.62]·L_dom, weighted by √r because far-field
 * divergent amplitude falls as r^(−½) (Darmon eq. 4.8) — the weight makes the
 * band average an unbiased angular envelope.
 *
 * 128² × 0.5 m: angles measured at 256² agree to ≤ 0.75° (W1 report) at 4×
 * the cost.
 */
import { describe, expect, it } from 'vitest';
import { GRAVITY } from '../src/ocean/oceanMath';
import {
  WAKE_MAX_DT,
  WakeSolverCpu,
  WakeSourceBuffer,
  fft2d,
  modeWavenumber,
  splatSigma,
  wakeButterflyTables,
} from '../src/wake/wakeSolverMath';

const N = 128;
const TEXEL = 0.5;
const KELVIN_DEG = (Math.asin(1 / 3) * 180) / Math.PI;
const DARMON_DEG_AT_FR1 = (1 / (Math.pow(40, 0.25) * Math.sqrt(Math.PI))) * (180 / Math.PI);

interface Towed {
  alphaMax: number;
  lambdaT: number | null;
  U: number;
}

function tow(froude: number, footprint: number): Towed {
  const s = new WakeSolverCpu({ n: N, texel: TEXEL });
  const sigma = splatSigma(footprint, TEXEL, N); // the σ the solver actually draws
  const b = Math.PI * Math.SQRT2 * sigma;
  const U = froude * Math.sqrt(GRAVITY * b);
  const lead = 0.3 * s.domain;
  const r1 = 0.2 * s.domain;
  const r2 = 0.62 * s.domain;
  // step: hold the moving forcing short against both the patch and the transverse period
  const dt = Math.min(WAKE_MAX_DT, (0.3 * U) / GRAVITY, (0.4 * sigma) / U);
  const duration = (2.2 * r2) / U + 4;
  const src = new WakeSourceBuffer();
  let x = 0;
  for (let k = 0; k * dt < duration; k++) {
    x = U * k * dt;
    s.setCenter(x - lead, 0);
    const t = Math.min(1, (k * dt) / 4);
    src.clear();
    src.push(x, 0, 1e5 * t * t * (3 - 2 * t), footprint);
    s.splat(src);
    s.step(dt);
  }

  // envelope A² = η² + φ·(|k|φ)/g
  const nn = N * N;
  const re = new Float64Array(nn);
  const im = new Float64Array(nn);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) re[j * N + i] = s.phi[j * N + i] * ((i + j) & 1 ? -1 : 1);
  const tables = wakeButterflyTables(N);
  fft2d(re, im, N, tables.forward);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = Math.hypot(modeWavenumber(i, N, s.domain), modeWavenumber(j, N, s.domain)) / nn;
      re[j * N + i] *= k;
      im[j * N + i] *= k;
    }
  }
  fft2d(re, im, N, tables.inverse);
  const a2 = new Float64Array(nn);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const idx = j * N + i;
      a2[idx] = s.zeta[idx] ** 2 + (s.phi[idx] * re[idx] * ((i + j) & 1 ? -1 : 1)) / GRAVITY;
    }
  }
  const at = (u: number, v: number): number => {
    const i = Math.floor(u);
    const j = Math.floor(v);
    const fu = u - i;
    const fv = v - j;
    const g = (a: number, c: number): number => (a < 0 || c < 0 || a >= N || c >= N ? 0 : a2[c * N + a]);
    return (g(i, j) * (1 - fu) + g(i + 1, j) * fu) * (1 - fv) + (g(i, j + 1) * (1 - fu) + g(i + 1, j + 1) * fu) * fv;
  };
  let best = -1;
  let alphaMax = 0;
  for (let deg = 0; deg <= 35; deg += 0.25) {
    const a = (deg * Math.PI) / 180;
    let sum = 0;
    for (let r = r1; r <= r2; r += TEXEL / 2) {
      for (const side of [-1, 1]) {
        const amp = Math.sqrt(Math.max(0, at(s.gridU(x - r * Math.cos(a)), s.gridV(side * r * Math.sin(a)))));
        sum += amp * Math.sqrt(r);
      }
    }
    if (sum > best) {
      best = sum;
      alphaMax = deg;
    }
  }

  // transverse wavelength: mean up-crossing spacing of η_vis on the track
  const r0 = 0.15 * s.domain;
  const crossings: number[] = [];
  let prev = s.surfaceAt(x - r0, 0);
  for (let r = r0 + TEXEL / 4; r < r2; r += TEXEL / 4) {
    const v = s.surfaceAt(x - r, 0);
    if (prev < 0 && v >= 0) crossings.push(r - (TEXEL / 4) * (v / (v - prev)));
    prev = v;
  }
  const lambdaT = crossings.length >= 4 ? (crossings[crossings.length - 1] - crossings[0]) / (crossings.length - 1) : null;
  return { alphaMax, lambdaT, U };
}

describe('V-W1 Kelvin wake emerges from ω² = g|k| (towed Gaussian pressure patch)', () => {
  const runs = new Map<number, Towed>();
  const get = (fr: number, footprint: number): Towed => {
    let r = runs.get(fr);
    if (!r) {
      r = tow(fr, footprint);
      runs.set(fr, r);
    }
    return r;
  };

  it('Fr 0.30: transverse-dominated — envelope maximum on the track (Darmon: Fr ≲ 0.3); λ_T = 2πU²/g ± 5%', () => {
    const r = get(0.3, Math.sqrt(1.5 ** 2 - TEXEL ** 2));
    expect(r.alphaMax).toBeLessThanOrEqual(2);
    expect(r.lambdaT).not.toBeNull();
    expect(Math.abs(r.lambdaT! / ((2 * Math.PI * r.U * r.U) / GRAVITY) - 1)).toBeLessThan(0.05);
  }, 30_000);

  it('Fr 0.45: the Kelvin plateau — α_max within [φ_K − 3.5°, φ_K + 1°]; λ_T = 2πU²/g ± 5%', () => {
    const r = get(0.45, Math.sqrt(1.0 ** 2 - TEXEL ** 2));
    expect(r.alphaMax).toBeGreaterThanOrEqual(KELVIN_DEG - 3.5);
    expect(r.alphaMax).toBeLessThanOrEqual(KELVIN_DEG + 1);
    expect(r.lambdaT).not.toBeNull();
    expect(Math.abs(r.lambdaT! / ((2 * Math.PI * r.U * r.U) / GRAVITY) - 1)).toBeLessThan(0.05);
  }, 30_000);

  it('Fr 1.0: narrowing has begun — α_max ≥ 2° inside the plateau, not below the large-Fr asymptote − 1.5°', () => {
    const plateau = get(0.45, Math.sqrt(1.0 ** 2 - TEXEL ** 2)).alphaMax;
    const r = get(1.0, Math.sqrt(0.75 ** 2 - TEXEL ** 2));
    expect(r.alphaMax).toBeLessThanOrEqual(plateau - 2);
    expect(r.alphaMax).toBeGreaterThanOrEqual(DARMON_DEG_AT_FR1 - 1.5);
  }, 30_000);

  it('Fr 2.0: α_max = 12.85°/Fr ± 1.5° (Darmon eq. 4.11) and α(2)/α(1) = 0.5 ± 0.12 — a Mach-like 1/Fr law', () => {
    const one = get(1.0, Math.sqrt(0.75 ** 2 - TEXEL ** 2)).alphaMax;
    const two = get(2.0, Math.sqrt(0.75 ** 2 - TEXEL ** 2)).alphaMax;
    expect(Math.abs(two - DARMON_DEG_AT_FR1 / 2)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(two / one - 0.5)).toBeLessThanOrEqual(0.12);
  }, 30_000);
});
