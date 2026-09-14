/**
 * THE WAKE EVERY HULL FEELS (§T.207, §V8, §V108, §V110, §V2). USER: "wakes should obviously in a way impact the travel
 * but it should be for everyone." A deterministic CPU wake-elevation field that the hull contact reads through its
 * height sampler, for the player AND every rival, from the SAME per-boat records.
 *
 * MODEL: linear steady ship waves of a moving pressure on deep water (Havelock 1908; Lamb §242 in 2D). For p moving at U
 * along +x, p̂(k) = ∫p e^{−ik·x} dA, causal (Rayleigh) contour, the wave part is
 *     η = (1/(πρU²)) ∫_{−π/2}^{π/2} dθ sec²θ k₀ Im[p̂(k₀cosθ, k₀sinθ) e^{ik₀ξ}]·H(−ξ),  k₀ = g sec²θ/U², ξ = x cosθ + y sinθ
 * (2D check: a line load P gives 2P̂(k₀)/(ρU²)·sin k₀x astern, Lamb's amplitude). With u = tan θ, X astern, Y abeam and
 * K = g/U², s = √(1+u²), k = K s²:
 *     η(X, Y) = (1/(πρU²)) ∫₀^∞ du k |p̂(k, u)| [H(X − Yu) sin(−Ks(X − Yu)) + sin(−Ks(X + Yu))]
 * — only mildly oscillatory in u (the splat envelope ends it at k ≈ √24/σ), so it is evaluated by a trapezoid on a
 * per-source node table (`QUAD_NODES`, stride 4/2/1 by the phase range at the query). Far out (phase range past
 * `STAT_PHASE_FROM` rad) the nodes cannot follow and the STATIONARY-PHASE far field takes over: the roots of
 * Y/X = u/(1 + 2u²) (transverse, divergent), each (s² k |p̂|/(πρU²))·√(2π/|Φ''|)·sin(Φ + sgn Φ''·π/4), Φ = −Ks(X − Yu),
 * the cusp floored by the Airy integral's size |Φ''| ≥ 0.7957·|Φ'''|^{2/3}. [M] (scratch, U 8–40 m/s, X 10–300 m, Y/X
 * 0–0.3): 80-node quadrature within 1e-4 m of a 40 000-node reference wherever its range < 250 rad; stationary phase
 * within ~10 % where it is > 300 rad, and 2–100× off near the track within ~0.8U²/g astern — why it is not used there.
 *
 * AMPLITUDE FROM THE CALIBRATED WAKE MODEL (V-W2, §V101): the pressure is the hull's own contact wake load — the
 * `hw.wake` plan-column samples the GPU wake solver splats (Σ fy = the water's vertical load, N), each drawn as a Gaussian
 * of σ = `splatSigma(footprint, texel, n)` buried at its depth (e^{−kd}), the forcing `havelockArmAngleDeg` evaluates. The
 * band is the speedboat NEAR tier's (256² × 0.5 m, σ ≥ 0.71 m: the drawn near-hull wake, §T.199): the wake a hull floats
 * on is the wake that is drawn. The samples are reduced to ONE moment-matched Gaussian per boat (Σfy, centroid,
 * along/across second moments incl. each splat's σ², mean depth). [M] against the full 22-sample transform (tow at 15
 * and 30 m/s, X 20–80 m): peak |η| within 5 %. NOT modelled: the local (non-wave) near field (the depression under a
 * hull, ≤ 2 mm at 20 m; other hulls cannot be there), the Smith attenuation (a planing hull's running draft ≪ 1/k),
 * finite depth, and wave history (below).
 *
 * STRAIGHT COURSE, ESTABLISHED LENGTH, NO HISTORY. The steady pattern is laid astern along the source's current course
 * over ground; X past `WAKE_FIELD_REACH` (the drawn wake's 300 m interior) fades out. A turning source swings its
 * pattern with its heading (no wake history is kept). [M] a circular-path variant (κ = ω_y/U) was tried and REJECTED:
 * in the Tower Reach smoke race a tumbling or hooking boat's yaw rate (1–6 rad/s) whipped tiny-radius arcs across the
 * pack, ∂η/∂t at receivers' CGs 4–38 m/s, 27 crashes vs 5 on the straight course.
 * A pattern is only as long as the source has been running: a source started impulsively fills its wedge from the start
 * point, and its divergent waves (group velocity ½ the phase velocity) are established only up to ≈ half the distance
 * run (Lighthill, Waves in Fluids §3.10). The record carries that distance (`RUN`, reset on a placement) and the field
 * fades from run/2 to run astern — so a grid start or a respawn does not throw a full steady wake at the boat behind.
 *
 * WAVE MEMORY. A record's load moments are low-passed with `WAKE_MEMORY_S` (ASSUMED 1 s): the waves already in the
 * water do not vanish when the emitter goes airborne, and a receiver never sees a source switch on in one tick (a jump in
 * η is a ∂η/∂t spike in the contact's water velocity). The filter shapes timing only, never the steady amplitude.
 *
 * DETERMINISM (§V2/§V110): a record is a pure function of (the boat's state after its step, its wake samples, its own
 * previous record); the field is a pure function of the records. The step core (every rival, any transport) and the
 * page (the player) call these same functions on the same numbers. §V108: `prepare` never takes the receiver's own record.
 */
import { GRAVITY } from '../ocean/oceanMath';
import type { WakeLoadSamples } from '../sea-physics/hullWater';
import type { Rigid6State } from '../sea-physics/rigidBody';
import { WAKE_RHO, splatSigma } from './wakeSolverMath';

/** one boat's wake record, f64 slots */
export const WS = {
  /** CG world x, z after the step */
  X: 0,
  Z: 1,
  /** horizontal velocity, m/s */
  VX: 2,
  VZ: 3,
  /** distance run since the last placement, m (the pattern's established length, see header) */
  RUN: 4,
  /** low-passed Σfy (N) and the fy-weighted moments: along / across offsets of the load from the CG (m), their second
   *  moments incl. each splat's σ² (m²), depth (m) — all × Σfy */
  F: 5,
  FA: 6,
  FC: 7,
  FAA: 8,
  FCC: 9,
  FD: 10,
} as const;
export const WAKE_SRC_LEN = 11;

/** the band the field is forced at: the speedboat near tier (wakeCalibration WAKE_SPEEDBOAT_NEAR_TIER, test-pinned) */
export const WAKE_FIELD_BAND = Object.freeze({ n: 256, texel: 0.5 });
/** ASSUMED wave memory, s (see header) */
export const WAKE_MEMORY_S = 1;
/** pattern reach astern along the path, m (wakeCalibration SPEEDBOAT_WAKE_REACH_ASTERN) */
export const WAKE_FIELD_REACH = 300;
/** below this speed a hull's far field is not worth a force */
export const WAKE_MIN_SPEED = 2;
/** most sources one receiver keeps after culling */
export const WAKE_MAX_SOURCES = 8;
/** trapezoid intervals of the per-source node table (divisible by 4: strides 4/2/1) */
export const QUAD_NODES = 80;
/** phase range (rad) past which the stationary-phase far field replaces the quadrature (blended up to STAT_PHASE_FULL) */
export const STAT_PHASE_FROM = 250;
export const STAT_PHASE_FULL = 320;
/** phase range (rad) below which 20 / 40 of the 80 intervals suffice ([M] ≈ 3 rad per interval holds 1e-4 m) */
export const STRIDE4_RANGE = 60;
export const STRIDE2_RANGE = 120;

const TAU_CUSP = 1 / Math.sqrt(8);
const AIRY_FLOOR = 0.7957;
/** envelope exponent at the node table's last wavenumber */
const ENVELOPE_END = 12;
/** culling margin around the receiver's CG, m: covers the 12 m hull's patch */
const CULL_MARGIN = 16;

/**
 * TABLE SINE for the quadrature's inner loop (the field's whole cost is ~40 sines per sample per source): 4096 entries,
 * linear interpolation, error ≤ (2π/4096)²/8 = 3e-7. Plain float arithmetic, so every engine gives the same bits (§V2).
 */
const SIN_N = 4096;
const SIN_SCALE = SIN_N / (2 * Math.PI);
const SIN_TAB = (() => {
  const t = new Float64Array(SIN_N + 1);
  for (let i = 0; i <= SIN_N; i++) t[i] = Math.sin((2 * Math.PI * i) / SIN_N);
  return t;
})();
export function tableSin(x: number): number {
  const f = x * SIN_SCALE;
  const i = Math.floor(f);
  const j = i & (SIN_N - 1);
  const a = SIN_TAB[j];
  return a + (f - i) * (SIN_TAB[j + 1] - a);
}

/** most boats a field keeps node tables for (fleets are ≤ 32: boatCollide's masks) */
const TABLE_BOATS = 32;

const smooth = (e0: number, e1: number, x: number): number => {
  const u = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return u * u * (3 - 2 * u);
};

/**
 * Write boat `state`'s record after its step into `out[o..]`, low-passing against `prev[po..]` (its previous record;
 * pass `reset` on a teleport tick — V108, the moments start from 0). Samples are in world x/z (hullWater WakeLoadSamples).
 */
export function writeWakeSource(
  out: Float64Array,
  o: number,
  prev: Float64Array,
  po: number,
  reset: boolean,
  state: Readonly<Rigid6State>,
  wake: Readonly<WakeLoadSamples>,
  dt: number,
): void {
  const [qx, qy, qz, qw] = state.quaternion;
  const cx = state.position[0];
  const cz = state.position[2];
  const vx = state.velocity[0];
  const vz = state.velocity[2];
  const U = Math.hypot(vx, vz);
  // along = course over ground; at rest, the bow's plan direction
  let tx: number;
  let tz: number;
  if (U > 1e-6) {
    tx = vx / U;
    tz = vz / U;
  } else {
    const fx = 2 * (qx * qz + qw * qy);
    const fz = 1 - 2 * (qx * qx + qy * qy);
    const l = Math.hypot(fx, fz) || 1;
    tx = fx / l;
    tz = fz / l;
  }
  let F = 0;
  let FA = 0;
  let FC = 0;
  let FAA = 0;
  let FCC = 0;
  let FD = 0;
  const { n, texel } = WAKE_FIELD_BAND;
  for (let k = 0; k < wake.count; k++) {
    const w = wake.fy[k];
    if (!(w > 0)) continue;
    const dx = wake.x[k] - cx;
    const dz = wake.z[k] - cz;
    const a = dx * tx + dz * tz;
    const c = dz * tx - dx * tz;
    const s = splatSigma(wake.sigma[k], texel, n);
    F += w;
    FA += w * a;
    FC += w * c;
    FAA += w * (a * a + s * s);
    FCC += w * (c * c + s * s);
    FD += w * Math.max(0, wake.depth[k]);
  }
  const keep = reset ? 0 : Math.exp(-dt / WAKE_MEMORY_S);
  const mix = 1 - keep;
  out[o + WS.X] = cx;
  out[o + WS.Z] = cz;
  out[o + WS.VX] = vx;
  out[o + WS.VZ] = vz;
  out[o + WS.RUN] = (reset ? 0 : prev[po + WS.RUN]) + U * dt;
  out[o + WS.F] = keep * prev[po + WS.F] + mix * F;
  out[o + WS.FA] = keep * prev[po + WS.FA] + mix * FA;
  out[o + WS.FC] = keep * prev[po + WS.FC] + mix * FC;
  out[o + WS.FAA] = keep * prev[po + WS.FAA] + mix * FAA;
  out[o + WS.FCC] = keep * prev[po + WS.FCC] + mix * FCC;
  out[o + WS.FD] = keep * prev[po + WS.FD] + mix * FD;
}

/** the splat envelope's last wavenumber for a source (lateral σ², depth): k²σ²/2 + k·d = ENVELOPE_END */
function envelopeEndK(sc2: number, d: number): number {
  return sc2 > 1e-6 ? (-d + Math.sqrt(d * d + 2 * ENVELOPE_END * sc2)) / sc2 : ENVELOPE_END / Math.max(d, 1e-3);
}

/**
 * Stationary-phase far field (m) of one moment-matched source at X astern, Y ≥ 0 abeam (see header). Exported for the
 * tests; the field uses it only where the quadrature's phase range is too large.
 */
export function kelvinFarField(X: number, Y: number, U: number, F: number, sa2: number, sc2: number, depth: number): number {
  if (!(X > 0) || !(F > 0) || !(U > 0)) return 0;
  const tau = Y / X;
  if (!(tau < TAU_CUSP)) return 0;
  const K = GRAVITY / (U * U);
  const pre = F / (Math.PI * WAKE_RHO * U * U);
  const disc = Math.sqrt(Math.max(0, 1 - 8 * tau * tau));
  let eta = 0;
  for (let r = 0; r < 2; r++) {
    let t: number;
    if (r === 0) t = (2 * tau) / (1 + disc); // transverse root, (1 − disc)/(4τ) without the cancellation
    else {
      if (tau < 1e-9) continue;
      t = (1 + disc) / (4 * tau);
    }
    const s2 = 1 + t * t;
    const s = Math.sqrt(s2);
    const k = K * s2;
    const expo = (k * k * (sa2 + sc2 * t * t)) / (2 * s2) + k * depth;
    if (expo > 30) continue;
    const phi = -K * s * (X - Y * t);
    // F(θ) = X secθ − Y secθ tanθ (Φ = −K F): F'' = X·A − Y·A', F''' = X·A' − Y·A'', A = s t² + s³
    const t2 = t * t;
    const s3 = s2 * s;
    const A = s * t2 + s3;
    const dA = s * t2 * t + 5 * s3 * t;
    const ddA = s * t2 * t2 + 18 * s3 * t2 + 5 * s3 * s2;
    const f2 = X * A - Y * dA;
    const f3 = X * dA - Y * ddA;
    const p2 = Math.max(K * Math.abs(f2), AIRY_FLOOR * Math.cbrt(K * K * f3 * f3));
    if (!(p2 > 0)) continue;
    const quarter = f2 > 0 ? -Math.PI / 4 : Math.PI / 4; // sgn Φ'' = −sgn F''
    eta += pre * s2 * k * Math.exp(-expo) * Math.sqrt((2 * Math.PI) / p2) * Math.sin(phi + quarter);
  }
  return eta;
}

/**
 * The field one receiver reads this tick: the records of every OTHER boat, culled around the receiver's CG.
 * Allocation-free after construction.
 */
export class WakeField {
  count = 0;
  private readonly px = new Float64Array(WAKE_MAX_SOURCES);
  private readonly pz = new Float64Array(WAKE_MAX_SOURCES);
  private readonly tx = new Float64Array(WAKE_MAX_SOURCES);
  private readonly tz = new Float64Array(WAKE_MAX_SOURCES);
  private readonly run = new Float64Array(WAKE_MAX_SOURCES);
  private readonly u = new Float64Array(WAKE_MAX_SOURCES);
  private readonly f = new Float64Array(WAKE_MAX_SOURCES);
  private readonly sa2 = new Float64Array(WAKE_MAX_SOURCES);
  private readonly sc2 = new Float64Array(WAKE_MAX_SOURCES);
  private readonly d = new Float64Array(WAKE_MAX_SOURCES);
  private readonly len = new Float64Array(WAKE_MAX_SOURCES);
  /** the boat index of prepared source n (its node table) */
  private readonly boat = new Int32Array(WAKE_MAX_SOURCES);
  /** per BOAT index: √(K·k_end) and k_end (phase range per metre astern / abeam), trapezoid step du·F/(πρU²) */
  private readonly rangeX = new Float64Array(TABLE_BOATS);
  private readonly rangeY = new Float64Array(TABLE_BOATS);
  private readonly step = new Float64Array(TABLE_BOATS);
  /** per BOAT index, (QUAD_NODES + 1) nodes: u, K·s, k·envelope — rebuilt only when that boat's record changed */
  private readonly nu = new Float64Array(TABLE_BOATS * (QUAD_NODES + 1));
  private readonly nks = new Float64Array(TABLE_BOATS * (QUAD_NODES + 1));
  private readonly namp = new Float64Array(TABLE_BOATS * (QUAD_NODES + 1));
  /** the (F, U, sa2, sc2, d) each boat's table was built from (NaN = none) */
  private readonly tableKey = new Float64Array(TABLE_BOATS * 5).fill(Number.NaN);
  private readonly pathOut = { X: 0, Y: 0, w: 0 };

  /**
   * Take the records `rec[offset + j·WAKE_SRC_LEN]` of boats j ∈ [0, boats), skipping `exclude` (§V108: the receiver's own
   * wake), keeping those whose pattern can reach the receiver's CG (cx, cz).
   */
  prepare(rec: Float64Array, offset: number, boats: number, exclude: number, cx: number, cz: number): number {
    let n = 0;
    if (boats > TABLE_BOATS) throw new Error(`wake field: ${boats} boats > ${TABLE_BOATS}`);
    for (let j = 0; j < boats && n < WAKE_MAX_SOURCES; j++) {
      if (j === exclude) continue;
      const o = offset + j * WAKE_SRC_LEN;
      const F = rec[o + WS.F];
      if (!(F > 1)) continue;
      const vx = rec[o + WS.VX];
      const vz = rec[o + WS.VZ];
      const U = Math.hypot(vx, vz);
      if (!(U >= WAKE_MIN_SPEED)) continue;
      const tx = vx / U;
      const tz = vz / U;
      const a = rec[o + WS.FA] / F;
      const c = rec[o + WS.FC] / F;
      const sa2 = Math.max(0, rec[o + WS.FAA] / F - a * a);
      const sc2 = Math.max(0, rec[o + WS.FCC] / F - c * c);
      const d = Math.max(0, rec[o + WS.FD] / F);
      this.px[n] = rec[o + WS.X] + a * tx - c * tz;
      this.pz[n] = rec[o + WS.Z] + a * tz + c * tx;
      this.tx[n] = tx;
      this.tz[n] = tz;
      this.run[n] = rec[o + WS.RUN];
      this.path(n, cx, cz);
      const P = this.pathOut;
      if (!(P.w > 0 && P.X > -CULL_MARGIN && P.X < WAKE_FIELD_REACH + CULL_MARGIN && P.Y < TAU_CUSP * Math.max(0, P.X) + CULL_MARGIN)) continue;
      const K = GRAVITY / (U * U);
      const kEnd = envelopeEndK(sc2, d);
      const uEnd = Math.sqrt(Math.max(0, kEnd / K - 1));
      if (!(uEnd > 0)) continue;
      this.u[n] = U;
      this.f[n] = F;
      this.sa2[n] = sa2;
      this.sc2[n] = sc2;
      this.d[n] = d;
      this.len[n] = 4 * Math.sqrt(sa2);
      this.boat[n] = j;
      n++;
      // the node table depends on the record only: every receiver of this tick shares it
      const key = j * 5;
      const T = this.tableKey;
      if (T[key] === F && T[key + 1] === U && T[key + 2] === sa2 && T[key + 3] === sc2 && T[key + 4] === d) continue;
      T[key] = F;
      T[key + 1] = U;
      T[key + 2] = sa2;
      T[key + 3] = sc2;
      T[key + 4] = d;
      this.rangeX[j] = Math.sqrt(K * kEnd);
      this.rangeY[j] = kEnd;
      const h = uEnd / QUAD_NODES;
      this.step[j] = (h * F) / (Math.PI * WAKE_RHO * U * U);
      const base = j * (QUAD_NODES + 1);
      for (let q = 0; q <= QUAD_NODES; q++) {
        const uq = q * h;
        const s2 = 1 + uq * uq;
        const k = K * s2;
        this.nu[base + q] = uq;
        this.nks[base + q] = K * Math.sqrt(s2);
        this.namp[base + q] = k * Math.exp(-(k * k * (sa2 + sc2 * uq * uq)) / (2 * s2) - k * d);
      }
    }
    this.count = n;
    return n;
  }

  /** coordinates of (x, z) against source m: X astern along its course, Y = |offset|, w = reach and established-length fade */
  private path(m: number, x: number, z: number): void {
    const P = this.pathOut;
    const dx = x - this.px[m];
    const dz = z - this.pz[m];
    const tx = this.tx[m];
    const tz = this.tz[m];
    const X = -(dx * tx + dz * tz);
    P.X = X;
    P.Y = Math.abs(dz * tx - dx * tz);
    const run = this.run[m];
    P.w = (1 - smooth(0.8 * WAKE_FIELD_REACH, WAKE_FIELD_REACH, X)) * (1 - smooth(0.5 * run, run, X));
  }

  /** one prepared source at path coordinates X > 0, Y ≥ 0 (before the path fade) */
  sourceAt(m: number, X: number, Y: number): number {
    const tau = Y / X;
    if (!(tau < TAU_CUSP)) return 0;
    const j = this.boat[m];
    const range = this.rangeX[j] * X + this.rangeY[j] * Y;
    const wFar = smooth(STAT_PHASE_FROM, STAT_PHASE_FULL, range);
    let eta = 0;
    if (wFar < 1) {
      const stride = range < STRIDE4_RANGE ? 4 : range < STRIDE2_RANGE ? 2 : 1;
      const base = j * (QUAD_NODES + 1);
      let sum = 0;
      for (let q = 0; q <= QUAD_NODES; q += stride) {
        const ks = this.nks[base + q];
        const ur = Y * this.nu[base + q];
        let v = tableSin(-ks * (X + ur));
        if (X > ur) v += tableSin(-ks * (X - ur));
        sum += (q === 0 || q === QUAD_NODES ? 0.5 : 1) * this.namp[base + q] * v;
      }
      eta += (1 - wFar) * sum * stride * this.step[j];
    }
    if (wFar > 0) eta += wFar * kelvinFarField(X, Y, this.u[m], this.f[m], this.sa2[m], this.sc2[m], this.d[m]);
    // the wedge edge and the source's own length fade instead of stepping
    return eta * (1 - smooth(0.9 * TAU_CUSP, TAU_CUSP, tau)) * smooth(0, this.len[m], X);
  }

  /** wake elevation, m, at world (x, z): the sum over the prepared sources */
  heightAt(x: number, z: number): number {
    let eta = 0;
    const P = this.pathOut;
    for (let m = 0; m < this.count; m++) {
      this.path(m, x, z);
      if (!(P.w > 0) || !(P.X > 0)) continue;
      eta += P.w * this.sourceAt(m, P.X, P.Y);
    }
    return eta;
  }
}
