/**
 * §T.193 SHOALING WAVES CHANGE SHAPE: sharp crests, flat troughs and a steep
 * front face, so a sandbar's breakers are ramps rather than swells.
 *
 * WHY. §T.190 made the bar's sea grow and break, but a linear sea over a 3 m
 * crest is capped at Hs = γ·d and the FFT tiles cannot shorten its wavelength,
 * so the bar's faces were no steeper than a sine of that height. Real waves in
 * shallow water are NON-LINEAR: energy moves into the harmonics, the crest
 * sharpens (skewness) and the front steepens while the back flattens
 * (asymmetry). This file adds that shape per band from a field-validated
 * parameterisation, as one expression every consumer shares (§V.77).
 *
 * THE PARAMETERISATION: Ruessink, Ramaekers & van Rijn (2012), "On the
 * parameterization of the free-stream non-linear wave orbital motion in
 * nearshore morphodynamic models", Coastal Engineering 65, 56–63, fitted to
 * ~30 000 field time series. With the Ursell number
 *     Ur = (3/4)·a_w·k/(kd)³,   a_w = Hs/2   ⟹   Ur = (3/8)·Hs/(d·(kd)²),
 * the total non-linearity and the biphase are
 *     B = p1 + (p2 − p1)/(1 + exp((p3 − log10 Ur)/p4))
 *     ψ = −90° + 90°·tanh(p5/Ur^p6)
 *     Sk = B·cos ψ,   As = B·sin ψ     (As < 0 = pitched forward)
 * with p1..p6 = 0, 0.857, −0.471, 0.297, 0.815, 0.672. The constants, the log10
 * and a_w = Hs/2 were checked against Delft3D's implementation
 * (morphology_kernel/sed_support_routines.f90: "b = 0.857 +/- 0.016",
 * `urs = 0.75·aw·k/(kh)³`, `aw = 0.5·hs`). The fit is for near-bed orbital
 * VELOCITY. In shallow water u ≈ η·√(g/d), so the surface inherits the shape
 * to leading order, and that is the approximation made here.
 *
 * THE SHAPE: each band's second harmonic, built pointwise from its own
 * analytic signal. A mode's Tessendorf displacement is D = λ·∇η/|k|, so along
 * the band's propagation direction ŝ the field H = −(D·ŝ)/λ is the spatial
 * Hilbert transform of η: η = a·cos φ ⟹ H = a·sin φ. Then
 *     η² − H² = a²·cos 2φ    and    2ηH = a²·sin 2φ
 * carry the second harmonic with NO derivative texture, NO extra FFT, and
 * nothing the CPU mirror lacks. Both are products of the band with itself, so
 * they are band-limited to twice the band (§V.48). Per band:
 *     y += f·[κ_S·(η² − H_q²) + κ_A·2η·H_R],   κ_S = c·cos ψ/σ̂,   κ_A = −c·sin ψ/σ̂
 * where σ̂ = σᵢ·gᵢ is the band's local spectral RMS. Both terms scale as a²/σ̂,
 * so the largest waves in a group are the most non-linear. For a Gaussian band
 * ⟨a⁴⟩ = 2⟨a²⟩², which gives B = 6c/(1 + 4c²)^{3/2}. `skewAmplitude` inverts
 * that for c, so the ENSEMBLE matches the fit, not just a mean wave.
 *
 * DIRECTIONAL SPREAD. A mode at θ to ŝ projects H·cos θ. H_q = H/q with
 * q = √⟨cos²θ⟩ restores the harmonic's amplitude and keeps η² − H_q² zero-mean,
 * so there is no set-up bias. H_R = H/R with R = |⟨k̂⟩| restores the cross term,
 * whose ensemble weight is ⟨cos θ⟩ = R. Both are spectrum moments
 * (`bandPropagation`), identical on every side.
 *
 * WHY VERTICAL, NOT A FORWARD LEAN — see docs/ocean/shoaling.md §T.193. In
 * short: the horizontal lean x += ŝ·α·η has the same first-order harmonic, but
 * its Jacobian needs ∂η/∂s, which the mirror does not have pointwise. With an
 * envelope guard holding the narrow-band det estimate ≥ 0.35 the true
 * finite-difference det still went negative at d = 1.5 m. The vertical form
 * leaves the horizontal map untouched, bit for bit, so its det IS the
 * Tessendorf det the fold cap already governs.
 *
 * THE PROFILE GUARD, the vertical analogue of anti-fold. With local harmonic
 * ratio ρ = c·|A|/σ̂ (|A| = √(η² + H_q²), the envelope), the profile
 * cos φ + ρ·cos(2φ − β) grows a SECOND crest per wavelength once ρ passes an
 * onset that depends on the biphase: 0.25 at β = 0 (pure skewness), 0.5 at
 * β = 90° (`secondCrestOnset`). f saturates ρ at `shoalAsymmetryHarmonicCap` ×
 * that onset, with the same knee construction as shoaling.ts's breaking factor
 * (exactly 1 below 75% of the cap, C1 through it). It is keyed on the envelope,
 * not the phase, so the guard does not ripple with the wave.
 *
 * DEEP WATER IS EXACTLY THE IDENTITY. B is multiplied by max(1 − (kd/π)⁴, 0)
 * with shoaling.ts's floored k and its kd clamp, so every band with d ≥ λ/2
 * gets c = 0 ⟹ y + 0, bit for bit. Ur itself uses the band's TRUE (unfloored)
 * mean k. The floor compresses where "deep" begins, and applied to Ur it would
 * understate a 190 m swell's non-linearity over a 3 m bar about tenfold.
 *
 * BANDS. Cascades 0 and 1 only (`SHOAL_ASYMMETRY_BANDS`), the bands the CPU
 * mirror floats hulls on (§V.8). Cascade 2 (λ ≤ 8.3 m) has kd ≥ 2.3 over any
 * bar the circuit builds, where the gate leaves ≤ 30% of a B already < 0.01.
 *
 * §V.28: every divisor is floored. Ur is floored at 1e-12 (Delft3D's floor) and
 * the tanh argument is capped. Dry land (d = 0 ⟹ Hs = 0) gives B = 0.
 */
import { float } from 'three/tsl';
import {
  SHOAL_DEEP_KD,
  shallowWaterKd,
  shallowWaterKdNode,
  tanhCpu,
  tanhNode,
  type ShoalingParams,
} from './shoaling';

/** any TSL node — file-local convention shared with shoaling.ts */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNode = any;

/** Ruessink et al. (2012) fit, as Delft3D's sed_support_routines.f90 carries it */
export const RUESSINK_2012 = Object.freeze({
  p1: 0,
  p2: 0.857,
  p3: -0.471,
  p4: 0.297,
  p5: 0.815,
  p6: 0.672,
});

/** cascades that carry the shape term — the CPU mirror's bands (§V.8) */
export const SHOAL_ASYMMETRY_BANDS = 2;

const EPS = 1e-6;
/** Delft3D's Ursell floor, so log10 never sees 0 */
const UR_FLOOR = 1e-12;
/** largest B the Gaussian-band inversion runs at (its maximum is 1.155) */
export const SHOAL_ASYMMETRY_B_CAP = 0.95;
/** a band's local RMS below this (m) is treated as this — a divisor floor only */
const SIGMA_FLOOR = 1e-4;
/** mean wavenumber floor (rad/m) for an empty band — a divisor floor only */
const K_FLOOR = 1e-3;
/** λ below which H = −D·ŝ/λ is under-estimated rather than divided by ~0 */
const LAMBDA_FLOOR = 0.05;
/** coherence floor: a band with no mean direction gets no amplified harmonic */
const COHERENCE_FLOOR = 0.3;
/** fixed-point iterations of `skewAmplitude` (contraction ≤ 0.43 at the cap) */
const C_ITERATIONS = 8;
/** tanh argument cap: tanh(20) is 1 in double and in float */
const TANH_ARG_CAP = 20;

export interface ShoalAsymmetryParams extends ShoalingParams {
  shoalAsymmetryGain: number;
  shoalAsymmetryHarmonicCap: number;
}

/** Ur = (3/8)·Hs/(d·(kd)²), floored at 1e-12 */
export function ursellNumber(hs: number, kd: number, depth: number): number {
  return Math.max((0.375 * Math.max(hs, 0)) / Math.max(Math.max(depth, 0) * kd * kd, EPS * EPS), UR_FLOOR);
}

function ursellNumberNode(hs: AnyNode, kd: AnyNode, depth: AnyNode): AnyNode {
  return hs.max(0).mul(0.375).div(depth.max(0).mul(kd).mul(kd).max(EPS * EPS)).max(UR_FLOOR);
}

/** Ruessink 2012: total non-linearity B and biphase ψ (radians, −π/2..0) */
export function ruessinkShape(ur: number): { b: number; psi: number } {
  const { p1, p2, p3, p4, p5, p6 } = RUESSINK_2012;
  const u = Math.max(ur, UR_FLOOR);
  const b = p1 + (p2 - p1) / (1 + Math.exp((p3 - Math.log10(u)) / p4));
  const psi = -0.5 * Math.PI * (1 - tanhCpu(Math.min(p5 / Math.pow(u, p6), TANH_ARG_CAP)));
  return { b, psi };
}

function ruessinkShapeNode(ur: AnyNode): { b: AnyNode; psi: AnyNode } {
  const { p1, p2, p3, p4, p5, p6 } = RUESSINK_2012;
  const u = ur.max(UR_FLOOR);
  const log10 = u.log().div(Math.LN10);
  const b = float(p1).add(float(p2 - p1).div(float(p3).sub(log10).div(p4).exp().add(1)));
  const psi = float(1)
    .sub(tanhNode(float(p5).div(u.pow(p6)).min(TANH_ARG_CAP)))
    .mul(-0.5 * Math.PI);
  return { b, psi };
}

/** exactly 0 for kd ≥ π (deep water), 1 − (kd/π)⁴ below */
export function asymmetryDeepGate(kd: number): number {
  const r = Math.min(kd, SHOAL_DEEP_KD) / SHOAL_DEEP_KD;
  return Math.max(1 - r * r * r * r, 0);
}

function asymmetryDeepGateNode(kd: AnyNode): AnyNode {
  const r = kd.min(SHOAL_DEEP_KD).div(SHOAL_DEEP_KD);
  const r2 = r.mul(r);
  return float(1).sub(r2.mul(r2)).max(0);
}

/**
 * The second-harmonic ratio c at which a Gaussian band carries total
 * non-linearity `b`: 6c/(1 + 4c²)^{3/2} = b on the small-c branch. Fixed point
 * c ← b·(1 + 4c²)^{3/2}/6, started from c = b/6. Exactly 0 at b = 0.
 */
export function skewAmplitude(b: number): number {
  const bb = Math.min(Math.max(b, 0), SHOAL_ASYMMETRY_B_CAP);
  let c = bb / 6;
  for (let i = 0; i < C_ITERATIONS; i++) c = (bb * Math.pow(1 + 4 * c * c, 1.5)) / 6;
  return c;
}

function skewAmplitudeNode(b: AnyNode): AnyNode {
  const bb = b.max(0).min(SHOAL_ASYMMETRY_B_CAP);
  let c: AnyNode = bb.div(6);
  for (let i = 0; i < C_ITERATIONS; i++) c = bb.mul(c.mul(c).mul(4).add(1).pow(1.5)).div(6);
  return c;
}

/** where the harmonic guard's knee sits, as a fraction of the cap */
const GUARD_ONSET = 0.75;

/**
 * The harmonic ratio r past which cos φ + r·cos(2φ − β) grows a SECOND crest
 * per wavelength, as a function of the biphase β = −ψ: 0.25 for pure skewness,
 * 0.5 for pure asymmetry. Fit 0.25 + 0.25·sin(β)^0.6, which is at most 0.012
 * above the exact onset (bisection, β 0–90°; the test re-measures it). The cap
 * param is a fraction of this, and its 0.95 default absorbs the excess.
 */
export function secondCrestOnset(psi: number): number {
  return 0.25 + 0.25 * Math.pow(Math.max(Math.sin(-psi), 0), 0.6);
}

function secondCrestOnsetNode(psi: AnyNode): AnyNode {
  return psi.negate().sin().max(0).pow(0.6).mul(0.25).add(0.25);
}

/**
 * THE PROFILE GUARD: the factor f the band's harmonic is scaled by so its local
 * ratio ρ = c·|A|/σ̂ saturates at `cap`. Same construction as shoaling.ts's
 * breaking factor: min(ρ, knee) + head·tanh(max(ρ − knee, 0)/head), knee =
 * 0.75·cap, over ρ. EXACTLY 1 below the knee, C1 through it.
 */
export function harmonicGuard(rho: number, cap: number): number {
  const c = Math.max(cap, EPS);
  const knee = GUARD_ONSET * c;
  const head = c - knee;
  const limited = Math.min(rho, knee) + head * tanhCpu(Math.max(rho - knee, 0) / head);
  return limited / Math.max(rho, EPS);
}

function harmonicGuardNode(rho: AnyNode, cap: AnyNode): AnyNode {
  const c = float(cap).max(EPS);
  const knee = c.mul(GUARD_ONSET);
  const head = c.sub(knee);
  const limited = rho.min(knee).add(head.mul(tanhNode(rho.sub(knee).max(0).div(head))));
  return limited.div(rho.max(EPS));
}

/**
 * A band as the shape term sees it: its unfloored energy-weighted mean
 * wavenumber `kMean` (rad/m), its propagation direction (`x`, `z`), and two
 * directional moments about it: `q` = √⟨cos²θ⟩ and `r` = ⟨cos θ⟩ = |⟨−k̂⟩|.
 * See `bandPropagation`.
 */
export interface AsymmetryBand {
  kMean: number;
  x: number;
  z: number;
  q: number;
  r: number;
}

/**
 * THE PER-BAND PLACE COEFFICIENTS: κ_S (`skewOut`), κ_A (`tiltOut`) and
 * c/(σ̂·cap·onset(ψ)) (`ratioOut`, the guard's normaliser), all 1/m, from depth and the band gains shoaling.ts already
 * computed. `gains` and `sigma` cover ALL cascades, because Hs belongs to the
 * whole sea (the same m0 depth-limited breaking reads). Returns true when any
 * band is non-zero, so the CPU hot path can skip the samples in open water.
 */
export function shoalAsymmetryCoefficients(
  depth: number,
  shoalK: ArrayLike<number>,
  bands: readonly AsymmetryBand[],
  sigma: ArrayLike<number>,
  gains: ArrayLike<number>,
  p: ShoalAsymmetryParams,
  skewOut: number[],
  tiltOut: number[],
  ratioOut: number[],
): boolean {
  let m0 = 0;
  for (let i = 0; i < gains.length; i++) {
    const a = sigma[i] * gains[i];
    m0 += a * a;
  }
  const hs = 4 * Math.sqrt(m0);
  let any = false;
  for (let i = 0; i < SHOAL_ASYMMETRY_BANDS; i++) {
    const gate = asymmetryDeepGate(Math.min(shallowWaterKd(shoalK[i], depth), SHOAL_DEEP_KD));
    let c = 0;
    let psi = 0;
    if (gate > 0 && p.shoalAsymmetryGain > 0) {
      const kdTrue = shallowWaterKd(Math.max(bands[i].kMean, K_FLOOR), depth);
      const shape = ruessinkShape(ursellNumber(hs, kdTrue, depth));
      c = skewAmplitude(p.shoalAsymmetryGain * gate * shape.b);
      psi = shape.psi;
    }
    const inv = 1 / Math.max(sigma[i] * gains[i], SIGMA_FLOOR);
    skewOut[i] = c * Math.cos(psi) * inv;
    tiltOut[i] = -c * Math.sin(psi) * inv;
    ratioOut[i] = (c * inv) / Math.max(p.shoalAsymmetryHarmonicCap * secondCrestOnset(psi), EPS);
    if (c > 0) any = true;
  }
  return any;
}

/**
 * THE PER-SAMPLE HEIGHT at one grid point: Σ over bands of the guarded second
 * harmonic (m). `eta[i]` is band i's shoaled elevation (hᵢ·gᵢ), `proj[i]` its
 * shoaled horizontal displacement along ŝᵢ ((Dᵢ·ŝᵢ)·gᵢ, λ included), and
 * `lambda` the fold-capped choppiness both sides displace with. `dy[i]` gets
 * each band's term, for the consumers that need them apart.
 */
export function shoalAsymmetrySample(
  eta: ArrayLike<number>,
  proj: ArrayLike<number>,
  bands: readonly AsymmetryBand[],
  skew: ArrayLike<number>,
  tilt: ArrayLike<number>,
  ratio: ArrayLike<number>,
  lambda: number,
  dy: number[],
): number {
  const inv = 1 / Math.max(lambda, LAMBDA_FLOOR);
  let sum = 0;
  for (let i = 0; i < SHOAL_ASYMMETRY_BANDS; i++) {
    const b = bands[i];
    const e = eta[i];
    const hp = -proj[i] * inv;
    const hq = hp / Math.max(b.q, COHERENCE_FLOOR);
    const hr = hp / Math.max(b.r, COHERENCE_FLOOR);
    const f = harmonicGuard(ratio[i] * Math.sqrt(e * e + hq * hq), 1);
    dy[i] = f * (skew[i] * (e * e - hq * hq) + tilt[i] * 2 * e * hr);
    sum += dy[i];
  }
  return sum;
}

/**
 * A band's propagation direction ŝ (unit XZ) and its directional moments from
 * its h0 texels, as the cascades actually move the band: ŝ is the
 * energy-weighted mean of −k̂. The sign is measured, not assumed:
 * h(k,t) = h0(k)e^{iωt} + conj(h0(−k))e^{−iωt} sends the h0(k) energy toward
 * −k, and tests/shoalingAsymmetry.test.ts checks ŝ against −∂η/∂t·∇η on the
 * mirror. For the swell train this now agrees with `swellDirection`. k̂ needs no
 * domain. Cached per h0 array, which every rebuild replaces rather than mutates.
 */
type BandMoments = { x: number; z: number; q: number; r: number };
const BAND_CACHE = new WeakMap<Float32Array, BandMoments>();
export function bandPropagation(h0: Float32Array): BandMoments {
  const hit = BAND_CACHE.get(h0);
  if (hit) return hit;
  const n = Math.round(Math.sqrt(h0.length / 4));
  let vx = 0;
  let vz = 0;
  let sxx = 0;
  let sxz = 0;
  let szz = 0;
  let e = 0;
  for (let m = 0; m < n; m++) {
    const kz = m - n / 2;
    for (let xx = 0; xx < n; xx++) {
      const t = (m * n + xx) * 4;
      const w = h0[t] * h0[t] + h0[t + 1] * h0[t + 1];
      // a band's h0 is zero outside its annulus: most of a 512² grid for cascades 0 and 1
      if (w === 0) continue;
      const kx = xx - n / 2;
      const k = Math.hypot(kx, kz);
      if (k === 0) continue;
      const ux = kx / k;
      const uz = kz / k;
      vx -= w * ux;
      vz -= w * uz;
      sxx += w * ux * ux;
      sxz += w * ux * uz;
      szz += w * uz * uz;
      e += w;
    }
  }
  const len = Math.hypot(vx, vz);
  const x = len > 0 ? vx / len : 1;
  const z = len > 0 ? vz / len : 0;
  const out = {
    x,
    z,
    q: e > 0 ? Math.sqrt((sxx * x * x + 2 * sxz * x * z + szz * z * z) / e) : 1,
    r: e > 0 ? len / e : 1,
  };
  BAND_CACHE.set(h0, out);
  return out;
}

/** one band's term on the GPU: its height, and its world slope given the band's ∇η */
export interface AsymmetryBandNodes {
  dy: AnyNode;
  slope(gradEta: AnyNode): AnyNode;
}

/**
 * TSL twin of `shoalAsymmetryCoefficients` + `shoalAsymmetrySample` at one
 * point. `gains` = the ALL-cascade shoaling gains (`shoalSurfNodes().gains`),
 * `eta[i]` the band's shoaled elevation and `disp[i]` its shoaled horizontal
 * displacement (vec2, λ included), `uBand[i]` = (kMean, q, r), `uDir[i]` = ŝ,
 * `uAsym` = (gain, harmonicCap), `lambda` the fold-capped choppiness.
 *
 * `slope(∇η)` is the term's gradient for the shading normal, with f, κ and the
 * place held constant (they vary on the envelope and depth scales, as the
 * existing gains do in the normals). ∇η comes from the derivatives texture and
 * is exact. ∇H has no texture (∂Dx/∂z is not stored), so it takes the band's
 * ensemble value: ŝ·∇H = k̄·q²·η along ŝ ⟹ ∇H_q = k̄·q·η·ŝ and
 * ∇H_R = k̄·(q²/R)·η·ŝ.
 */
export function shoalAsymmetryNodes(
  depth: AnyNode,
  uShoalK: readonly AnyNode[],
  uBand: readonly AnyNode[],
  uDir: readonly AnyNode[],
  uSigma: readonly AnyNode[],
  gains: readonly AnyNode[],
  eta: readonly AnyNode[],
  disp: readonly AnyNode[],
  lambda: AnyNode,
  uAsym: AnyNode,
): AsymmetryBandNodes[] {
  let m0: AnyNode = null;
  for (let i = 0; i < gains.length; i++) {
    const a = float(uSigma[i]).mul(gains[i]);
    m0 = m0 === null ? a.mul(a) : m0.add(a.mul(a));
  }
  const hs = m0.sqrt().mul(4);
  const inv = float(1).div(float(lambda).max(LAMBDA_FLOOR));
  const out: AsymmetryBandNodes[] = [];
  for (let i = 0; i < SHOAL_ASYMMETRY_BANDS; i++) {
    const band = uBand[i];
    const kbar = float(band.x).max(K_FLOOR);
    const q = float(band.y).max(COHERENCE_FLOOR);
    const r = float(band.z).max(COHERENCE_FLOOR);
    const gate = asymmetryDeepGateNode(shallowWaterKdNode(uShoalK[i], depth).min(SHOAL_DEEP_KD));
    const shape = ruessinkShapeNode(ursellNumberNode(hs, shallowWaterKdNode(kbar, depth), depth));
    const c = skewAmplitudeNode(float(uAsym.x).mul(gate).mul(shape.b));
    const sInv = float(1).div(float(uSigma[i]).mul(gains[i]).max(SIGMA_FLOOR));
    const e = eta[i];
    const hp = disp[i].dot(uDir[i]).negate().mul(inv);
    const hq = hp.div(q);
    const hr = hp.div(r);
    const capEff = float(uAsym.y).mul(secondCrestOnsetNode(shape.psi)).max(EPS);
    const f = harmonicGuardNode(c.mul(sInv).div(capEff).mul(e.mul(e).add(hq.mul(hq)).sqrt()), 1);
    const skew = f.mul(c).mul(shape.psi.cos()).mul(sInv);
    const tilt = f.mul(c).mul(shape.psi.sin()).negate().mul(sInv);
    out.push({
      dy: skew.mul(e.mul(e).sub(hq.mul(hq))).add(tilt.mul(e).mul(hr).mul(2)),
      slope: (gradEta: AnyNode) => {
        const along = kbar.mul(e);
        const skewGrad = gradEta.mul(e).sub(uDir[i].mul(hq.mul(along).mul(q))).mul(skew.mul(2));
        const tiltGrad = gradEta.mul(hr).add(uDir[i].mul(e.mul(along).mul(q).mul(q).div(r))).mul(tilt.mul(2));
        return skewGrad.add(tiltGrad);
      },
    });
  }
  return out;
}
