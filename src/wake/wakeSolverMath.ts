/**
 * eWave — the shared hull-sampled wake solver, CPU reference (§T W1,
 * docs/wake/wake-research.md §2.3). ZERO three imports: this file runs in
 * vitest/node, is the oracle the TSL passes (`wakeSolverPasses.ts`) are
 * checked against in the browser, and is the future CPU-authoritative long-wave
 * band (W4, §4.2) — hence the fixed-tick API (`splat` → `step(dt)` →
 * `surface`/`surfaceAt`).
 *
 * PHYSICS (V-W1 — the wake is SOLVED, not drawn). Linear deep-water free
 * surface, state per texel = elevation η and surface velocity potential φ,
 * forced by the contact pressure written as an equivalent head h_P = P/(ρg):
 *
 *   ∂η/∂t = √(−∇²) φ        (Fourier: |k| φ̃)
 *   ∂φ/∂t = −g (η + h_P)
 *
 * With h_P held over the step, ζ = η + h_P obeys the free oscillator
 * ζ̃'' = −g|k| ζ̃, so the update is an EXACT rotation per mode (ω = √(g|k|)):
 *
 *   ζ̃' = ζ̃ cos ωΔt + √(|k|/g) φ̃ sin ωΔt          η̃' = ζ̃' − h̃_P
 *   φ̃' = φ̃ cos ωΔt − √(g/|k|) ζ̃ sin ωΔt
 *   (implemented on the state ζ itself since W2a — see SOURCE DEPTH below)
 *   k = 0: η̃' = −h̃_P, φ̃' = 0 (DC set explicitly, §V28). OPEN SEA, not a
 *          closed pond: the doc's η̃'(0) = 0 conserves the pond's volume, so
 *          every hull would raise the whole domain by ∫h_P/A_dom — a 3.7 cm
 *          table for a galleon in 128 m that steps back to the sea at the
 *          domain edge. On the open ocean that volume goes to infinity.
 *
 * Exact for ANY Δt — there is no CFL and no step-rate physics (V-W6). The
 * Kelvin angle, λ_T = 2πU²/g and the high-Froude narrowing all EMERGE from the
 * one line `dispersion(|k|)`; nothing here knows what a wake looks like.
 *
 * The drawn/floated surface is η_vis = η + h_P = ζ (V-W3 static cancellation):
 * a steadily pressed patch settles to η = −h_P, so η_vis = 0 and a vessel at
 * anchor makes no wake and does not sink into its own hole.
 *
 * SOURCE DEPTH (§T W2a, docs/wake/w2a-source-model.md). A hull does not press
 * on the free surface: its vertical force is the pressure on its BOTTOM, d
 * metres down. Laplace carries a pressure at depth d to the surface as
 * e^(−|k|d) per mode — the same kernel buoyancy already feels the sea through
 * (§V68 Smith, Haskind reciprocity: one kernel both ways). So the head that
 * forces AND the head that is drawn are ĥ' = Σ_bins e^(−|k|d_b)·ĥ_b. At k = 0
 * the factor is 1, so ∫ρg·h' dA = ΣF_y (V-W2) and static cancellation are
 * untouched; only the wave-making content is attenuated.
 *
 * Per-sample depths are carried in TWO BINS per step, at the min and max
 * sample depth, each sample split linearly between them (exact for any
 * two-depth fleet; see `splatBinWeight`). Because d_b changes tick to tick,
 * the STATE is ζ = η + h' (the drawn surface) and each step adds the change
 * of the filtered head, ĥ'_new − ĥ'_old, before the free rotation of (ζ̂, φ̂).
 * The old head is kept SPATIALLY (world-anchored, scrolled with the state), so
 * no spectral buffer and no phase shift on scroll are needed.
 *
 * ONE EXPRESSION (§V77). The transform is the ocean's own radix-2 butterfly
 * TABLE (`generateButterfly`, src/ocean/oceanMath.ts) driven by the same
 * `out = in[a] + W·in[b]` rule the TSL `buildFftPasses` runs; the forward
 * transform is the same table with conjugated twiddles. Per-mode ω, the sponge
 * profile, splat σ and peak head are exported functions the GPU uploads as
 * tables/instances; only the rotation lines and the Gaussian falloff are
 * transliterated — see `wakeSolverPasses.ts` and the browser comparison in
 * `preview.ts` (`__wakePond.compare()`).
 */
import { GRAVITY, dispersion, generateButterfly } from '../ocean/oceanMath';

/** seawater density (kg/m³). W2 producers must emit fy in the same units. */
export const WAKE_RHO = 1025;
/** §V44 bound at source on the drawn surface η_vis (m) — a backstop, not a shaper */
export const WAKE_ETA_CLAMP = 3;
/** §V44 bound at source on the drawn slope (dimensionless) */
export const WAKE_SLOPE_CLAMP = 1;
/** splat instance capacity: 8 vessels × 64 samples (galleon quadrature = 54) */
export const WAKE_MAX_SAMPLES = 512;
/** a splat quad / CPU window reaches this many σ from the sample (e^-8 ≈ 3e-4 at the edge) */
export const WAKE_SPLAT_RADIUS_SIGMAS = 4;
/** longest step the solver will take in one go (s) — forcing is held over it */
export const WAKE_MAX_DT = 0.1;

/**
 * OUTPUT TEXTURE LAYOUT (§V77, §T W2b) — the one statement of which RGBA
 * channel carries what. The GPU post pass WRITES by these indices and the
 * flowfoam resample (`flowfoam/simInjection.ts`) READS by them, so a swap can
 * only ever be consistent on both sides.
 *   heightTexture[HEIGHT]      η_vis (m)              (the `elevTexture.r` layout)
 *   slopeTexture[SLOPE_DX/DZ]  ∂η_vis/∂x, ∂η_vis/∂z  (the `foamTexture.ba` layout)
 */
export const WAKE_TEX_CHANNEL = { HEIGHT: 0, SLOPE_DX: 2, SLOPE_DZ: 3 } as const;

/**
 * One contact-pressure sample (docs/wake/wake-research.md §3.1, the reduced
 * form of the speedboat doc's §2.7 contact contract). World plan position,
 * the vertical hydrodynamic force this sample carried this tick, and its
 * plan footprint radius.
 */
export interface HydroSample {
  /** world x (m) */
  x: number;
  /** world z (m) */
  z: number;
  /** vertical force on the hull from this sample (N, ≥ 0; negatives clamp to 0) */
  fy: number;
  /** plan footprint radius σ (m) — √(A_plan)/2; floored at one texel by the splat */
  footprint: number;
  /**
   * depth below the local surface at which this sample's vertical force acts
   * (m, ≥ 0): a buoyancy station's keel immersion × smithDepthScale, a wet
   * triangle's centroid depth. 0 = a surface pressure (W1 behaviour).
   */
  depth: number;
}

/** [x, z, fy, footprint, depth] per sample in `WakeSourceBuffer.data` */
export const WAKE_SAMPLE_STRIDE = 5;

/**
 * Flat, allocation-free source list for up to `capacity` samples across any
 * number of vessels. Both the CPU splat and the GPU splat pass read it, so the
 * two can never be fed different inputs.
 *
 * §V28: a sample with ANY non-finite field is dropped (counted, never drawn);
 * fy is clamped to ≥ 0 (a hull cannot pull the sea up by its keel).
 */
export class WakeSourceBuffer {
  /** [x, z, fy, footprint, depth] per sample — Float64 so kilometre world coords keep mm */
  readonly data: Float64Array;
  count = 0;
  /** samples rejected for non-finite fields since the last `clear()` */
  dropped = 0;
  /** samples rejected because the buffer was full since the last `clear()` */
  overflowed = 0;

  constructor(readonly capacity = WAKE_MAX_SAMPLES) {
    this.data = new Float64Array(capacity * WAKE_SAMPLE_STRIDE);
  }

  clear(): void {
    this.count = 0;
    this.dropped = 0;
    this.overflowed = 0;
  }

  push(x: number, z: number, fy: number, footprint: number, depth = 0): boolean {
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(z) ||
      !Number.isFinite(fy) ||
      !Number.isFinite(footprint) ||
      !Number.isFinite(depth)
    ) {
      this.dropped++;
      return false;
    }
    if (this.count >= this.capacity) {
      this.overflowed++;
      return false;
    }
    const o = this.count * WAKE_SAMPLE_STRIDE;
    this.data[o] = x;
    this.data[o + 1] = z;
    this.data[o + 2] = Math.max(0, fy);
    this.data[o + 3] = Math.max(0, footprint);
    this.data[o + 4] = Math.max(0, depth);
    this.count++;
    return true;
  }

  /**
   * One vessel's samples. A vessel with ANY non-finite sample is skipped whole
   * (§5.6: a non-finite pose poisons every station, so a partial hull would be
   * a lie); returns the number accepted.
   */
  pushVessel(samples: readonly HydroSample[]): number {
    for (const s of samples) {
      if (
        !Number.isFinite(s.x) ||
        !Number.isFinite(s.z) ||
        !Number.isFinite(s.fy) ||
        !Number.isFinite(s.footprint) ||
        !Number.isFinite(s.depth)
      ) {
        this.dropped += samples.length;
        return 0;
      }
    }
    let n = 0;
    for (const s of samples) if (this.push(s.x, s.z, s.fy, s.footprint, s.depth)) n++;
    return n;
  }

  /**
   * The two source-depth bins for the current samples: min and max depth over
   * samples that carry force. Equal (single bin) when every sample shares a
   * depth — a level hull in calm water.
   */
  depthBins(): { d0: number; d1: number } {
    let d0 = Infinity;
    let d1 = -Infinity;
    for (let s = 0; s < this.count; s++) {
      const o = s * WAKE_SAMPLE_STRIDE;
      if (!(this.data[o + 2] > 0)) continue;
      const d = this.data[o + 4];
      if (d < d0) d0 = d;
      if (d > d1) d1 = d;
    }
    return d0 <= d1 ? { d0, d1 } : { d0: 0, d1: 0 };
  }
}

// ---------------------------------------------------------------------------
// Shared single expressions (§V77) — the TSL graph transliterates each.
// ---------------------------------------------------------------------------

/**
 * Effective Gaussian σ of a splat (m). Footprint floored at one texel, then
 * convolved with a one-texel Gaussian: that convolution IS the source
 * band-limit e^(−|k|²Δx²/2) of §2.3 (V48), done analytically in the splat so
 * the head that is DRAWN (η + h_P) and the head that FORCES are the same
 * field — filtering only the forcing would leave h_P − h̃_P as a permanent
 * static-cancellation residual under every hull. Capped so a splat quad never
 * exceeds a quarter of the domain.
 */
export function splatSigma(footprint: number, texel: number, n: number): number {
  const s = Math.min(Math.max(footprint, texel), (n * texel) / (4 * WAKE_SPLAT_RADIUS_SIGMAS));
  return Math.sqrt(s * s + texel * texel);
}

/**
 * Peak head (m) of a normalised Gaussian carrying force fy: ∫ρg·h_P dA = fy
 * (Newton 3, V-W2). σ ≥ one texel by `splatSigma`, so the divisor is floored.
 */
export function splatPeakHead(fy: number, sigma: number): number {
  return fy / (WAKE_RHO * GRAVITY * 2 * Math.PI * sigma * sigma);
}

/** Gaussian falloff at squared plan distance r2 (m²) */
export function splatFalloff(r2: number, sigma: number): number {
  return Math.exp(-r2 / (2 * sigma * sigma));
}

/**
 * Surface response per mode to a pressure acting `depth` metres down (§T W2a):
 * the potential of a buried pressure decays as e^(kz), so the surface sees
 * e^(−|k|·depth). 1 at k = 0 (Newton 3 and static cancellation hold), and the
 * same factor `cpuOcean.pressureHeadAt` applies in reverse (§V68).
 */
export function sourceDepthAttenuation(k: number, depth: number): number {
  return Math.exp(-Math.abs(k) * Math.max(0, depth));
}

/**
 * Share of a sample of depth d that goes to the DEEP bin d1 (the rest to d0).
 * Linear in d: exact for any fleet with ≤ 2 distinct depths; for a spread of
 * depths e^(−kd) is convex in d, so the mix slightly UNDER-attenuates (bounded
 * by (kΔd)²/8 of the factor).
 */
export function splatBinWeight(depth: number, d0: number, d1: number): number {
  const span = d1 - d0;
  return span > 1e-6 ? Math.min(1, Math.max(0, (depth - d0) / span)) : 0;
}

/** sponge parameters: ramp width as a fraction of the domain per side, and peak damping rate */
export interface WakeSpongeParams {
  /** fraction of the domain per side occupied by the ramp (doc §2.5: 0.15) */
  width: number;
  /** damping rate at the very edge (1/s) */
  gammaMax: number;
}

/**
 * Damping rate (1/s) contributed by ONE axis at texel index i. Quadratic ramp
 * from 0 at the inner edge of the zone to gammaMax at the border; the two axes
 * add, so corners damp hardest. The per-step factor is e^(−(γx+γz)Δt), which
 * makes the absorption per SECOND independent of the step rate (V-W6).
 */
export function spongeGammaAxis(i: number, n: number, p: WakeSpongeParams): number {
  const w = Math.max(p.width * n, 1);
  const fromEdge = Math.min(i + 0.5, n - (i + 0.5));
  const u = Math.min(Math.max(1 - fromEdge / w, 0), 1);
  return p.gammaMax * u * u;
}

/**
 * Domain centre for a vessel (V-W5: sim pose only, never the camera; the
 * solver snaps it to texels in `setCenter`).
 *
 * Placed from the BOW, not the origin: the stem (`bowAhead` metres along the
 * hull's forward unit axis) sits `clearance` metres inside the forward edge of
 * the unsponged interior, so all remaining interior lies astern. A fixed
 * "0.3·L_dom astern of the origin" (research §2.5) puts a galleon's stem
 * (+21 m) at 59.4 m in a 128 m domain whose interior ends at 44.8 m — the bow
 * wave would be generated inside the front sponge. The hull axis rather than
 * the velocity so the answer is defined at rest.
 */
export function wakeAnchor(
  x: number,
  z: number,
  forwardX: number,
  forwardZ: number,
  bowAhead: number,
  domain: number,
  sponge: WakeSpongeParams,
  clearance: number,
): { x: number; z: number } {
  const len = Math.hypot(forwardX, forwardZ);
  const fx = len > 1e-9 ? forwardX / len : 1;
  const fz = len > 1e-9 ? forwardZ / len : 0;
  const interiorHalf = (0.5 - sponge.width) * domain;
  const ahead = bowAhead + clearance - interiorHalf; // centre offset along the axis (negative = astern)
  return { x: x + fx * ahead, z: z + fz * ahead };
}

/** signed wavenumber (rad/m) of spectral index m on a centred n-grid (the (−1)^(x+y) shift) */
export function modeWavenumber(m: number, n: number, domain: number): number {
  return ((m - n / 2) * 2 * Math.PI) / domain;
}

/**
 * Default sponge for a domain: the ramp must strip a wave of λ = L/4 (the
 * longest the W1 reflection test covers, and faster than anything shorter:
 * c_g = ½√(g/k)) to ≤ 1% of its energy across the exit ramp PLUS the entry
 * ramp it would wrap into. Mean γ of a quadratic ramp is γmax/3, crossing
 * time 2w/c_g, energy decays at 2γ ⇒ γmax = 3·ln(100)·c_g / (2·2w).
 */
export function defaultSponge(n: number, texel: number): WakeSpongeParams {
  const width = 0.15;
  const domain = n * texel;
  const k = (2 * Math.PI) / (domain / 4);
  const cg = 0.5 * Math.sqrt(GRAVITY / k);
  const w = width * domain;
  return { width, gammaMax: (3 * Math.log(100) * cg) / (4 * w) };
}

// ---------------------------------------------------------------------------
// Butterfly FFT (CPU transliteration of src/ocean/fftPasses.ts)
// ---------------------------------------------------------------------------

export interface WakeButterflyTables {
  /** inverse: the ocean table verbatim (twiddle e^{+2πik/N}) */
  inverse: Float32Array;
  /** forward: same indices, conjugated twiddles (e^{−2πik/N}) — unnormalised, the 1/N² lives in evolve */
  forward: Float32Array;
}

const tableCache = new Map<number, WakeButterflyTables>();

export function wakeButterflyTables(n: number): WakeButterflyTables {
  let t = tableCache.get(n);
  if (!t) {
    const inverse = generateButterfly(n);
    const forward = Float32Array.from(inverse);
    for (let i = 1; i < forward.length; i += 4) forward[i] = -forward[i];
    t = { inverse, forward };
    tableCache.set(n, t);
  }
  return t;
}

/** the table unpacked into typed columns once per table (hot loop reads no Float32 → double conversions) */
interface UnpackedTable {
  wr: Float64Array;
  wi: Float64Array;
  a: Int32Array;
  b: Int32Array;
  lines: Float64Array[];
}
const unpackedCache = new WeakMap<Float32Array, UnpackedTable>();

function unpack(table: Float32Array, n: number): UnpackedTable {
  let u = unpackedCache.get(table);
  if (!u) {
    const len = table.length / 4;
    u = {
      wr: new Float64Array(len),
      wi: new Float64Array(len),
      a: new Int32Array(len),
      b: new Int32Array(len),
      lines: [new Float64Array(n), new Float64Array(n), new Float64Array(n), new Float64Array(n)],
    };
    for (let t = 0; t < len; t++) {
      u.wr[t] = table[t * 4];
      u.wi[t] = table[t * 4 + 1];
      u.a[t] = table[t * 4 + 2];
      u.b[t] = table[t * 4 + 3];
    }
    unpackedCache.set(table, u);
  }
  return u;
}

/**
 * In-place 2D radix-2 transform of (re, im) — rows then columns, each 1D pass
 * running exactly the shader's `out[x] = in[a] + W·in[b]` stage loop with the
 * twiddles as Float32 values (the GPU's precision, §V77).
 */
export function fft2d(re: Float64Array, im: Float64Array, n: number, table: Float32Array): void {
  const { wr, wi, a, b, lines } = unpack(table, n);
  const stages = Math.log2(n);
  for (let line = 0; line < 2 * n; line++) {
    const horizontal = line < n;
    const base = horizontal ? line * n : line - n;
    const stride = horizontal ? 1 : n;
    let pr = lines[0];
    let pi = lines[1];
    let qr = lines[2];
    let qi = lines[3];
    for (let x = 0, p = base; x < n; x++, p += stride) {
      pr[x] = re[p];
      pi[x] = im[p];
    }
    for (let j = 0, o = 0; j < stages; j++) {
      for (let x = 0; x < n; x++, o++) {
        const bb = b[o];
        const aa = a[o];
        const br = pr[bb];
        const bi = pi[bb];
        const w0 = wr[o];
        const w1 = wi[o];
        qr[x] = pr[aa] + w0 * br - w1 * bi;
        qi[x] = pi[aa] + w0 * bi + w1 * br;
      }
      const tr = pr;
      pr = qr;
      qr = tr;
      const ti = pi;
      pi = qi;
      qi = ti;
    }
    for (let x = 0, p = base; x < n; x++, p += stride) {
      re[p] = pr[x];
      im[p] = pi[x];
    }
  }
}

// ---------------------------------------------------------------------------
// The solver
// ---------------------------------------------------------------------------

export interface WakeSolverOptions {
  /** grid resolution (power of two) */
  n: number;
  /** texel size (m) */
  texel: number;
  sponge?: WakeSpongeParams;
}

export interface WakeStepOptions {
  /** also produce spectral ∂η_vis/∂x, ∂η_vis/∂z (two extra inverse transforms) */
  slope?: boolean;
}

/**
 * CPU eWave. Row j is world z, column i is world x; texel (i, j) is centred at
 * (centerX + (i − n/2)·texel, centerZ + (j − n/2)·texel). The centre only ever
 * moves by whole texels (`setCenter`), so a scroll is an exact index shift and
 * never a resample (V-W5; same law as flowfoam `snapToTexel`).
 *
 * Per step, in the GPU's order: [scroll] → splat(h bins) → forward(ζ, φ;
 * h_new; h_old) → ζ̂ += ĥ'_new − ĥ'_old, free rotation → inverse(ζ, φ[, ∇ζ])
 * → sponge → η_vis = ζ.
 */
export class WakeSolverCpu {
  readonly n: number;
  readonly texel: number;
  readonly domain: number;
  readonly sponge: WakeSpongeParams;
  centerX = 0;
  centerZ = 0;
  /**
   * state: ζ = η + h' — the DRAWN surface before the §V44 clamp (m) — and the
   * surface velocity potential φ (m²/s). Away from any source ζ = η.
   */
  readonly zeta: Float64Array;
  readonly phi: Float64Array;
  /** total raw (unattenuated) pressure head h_P of the current sources (m) — ∫ρg·head dA = Σfy */
  readonly head: Float64Array;
  /** the part of `head` in the deep bin (depth `binDepth1`); the rest is at `binDepth0` */
  readonly head1: Float64Array;
  binDepth0 = 0;
  binDepth1 = 0;
  /** drawn/floated surface η_vis = ζ, clamped ±WAKE_ETA_CLAMP (m) — upload-ready Float32 */
  readonly surface: Float32Array;
  /** ∂η_vis/∂x, ∂η_vis/∂z from the last `step(dt, {slope: true})`, clamped ±WAKE_SLOPE_CLAMP */
  readonly slopeX: Float32Array;
  readonly slopeZ: Float32Array;
  /** simulated seconds */
  time = 0;

  /** the head (bins, depths) that ζ currently contains — world-anchored, scrolls with the state */
  private readonly prev0: Float64Array;
  private readonly prev1: Float64Array;
  private prevDepth0 = 0;
  private prevDepth1 = 0;
  /** any force in the current / old head — lets a source-free step skip the head transform */
  private headLive = false;
  private prevLive = false;

  private readonly tables: WakeButterflyTables;
  private readonly kx: Float64Array;
  private readonly kMag: Float64Array;
  private readonly rootKOverG: Float64Array;
  private readonly rootGOverK: Float64Array;
  private readonly gammaAxis: Float64Array;
  private readonly spongeAxis: Float64Array;
  private cosT: Float64Array;
  private sinT: Float64Array;
  private tableDt = NaN;
  private spongeDt = NaN;
  private readonly attCache = new Map<number, Float64Array>();
  private readonly w: Float64Array[];

  constructor(opts: WakeSolverOptions) {
    const { n, texel } = opts;
    if (!Number.isInteger(Math.log2(n)) || n < 4) throw new Error(`wake: n must be a power of two ≥ 4, got ${n}`);
    if (!(texel > 0) || !Number.isFinite(texel)) throw new Error(`wake: texel must be finite > 0, got ${texel}`);
    this.n = n;
    this.texel = texel;
    this.domain = n * texel;
    this.sponge = opts.sponge ?? defaultSponge(n, texel);
    const nn = n * n;
    this.zeta = new Float64Array(nn);
    this.phi = new Float64Array(nn);
    this.head = new Float64Array(nn);
    this.head1 = new Float64Array(nn);
    this.prev0 = new Float64Array(nn);
    this.prev1 = new Float64Array(nn);
    this.surface = new Float32Array(nn);
    this.slopeX = new Float32Array(nn);
    this.slopeZ = new Float32Array(nn);
    this.tables = wakeButterflyTables(n);
    this.kx = new Float64Array(n);
    for (let m = 0; m < n; m++) this.kx[m] = modeWavenumber(m, n, this.domain);
    this.kMag = new Float64Array(nn);
    this.rootKOverG = new Float64Array(nn);
    this.rootGOverK = new Float64Array(nn);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = Math.hypot(this.kx[i], this.kx[j]);
        const idx = j * n + i;
        this.kMag[idx] = k;
        // DC (k = 0) is special-cased in evolve; these stay 0 there (§V28: no /0)
        if (k > 0) {
          this.rootKOverG[idx] = Math.sqrt(k / GRAVITY);
          this.rootGOverK[idx] = Math.sqrt(GRAVITY / k);
        }
      }
    }
    this.gammaAxis = new Float64Array(n);
    for (let i = 0; i < n; i++) this.gammaAxis[i] = spongeGammaAxis(i, n, this.sponge);
    this.spongeAxis = new Float64Array(n);
    this.cosT = new Float64Array(nn);
    this.sinT = new Float64Array(nn);
    this.w = Array.from({ length: 10 }, () => new Float64Array(nn));
  }

  /** world → continuous texel coordinates (texel centres at integers) */
  gridU(x: number): number {
    return (x - this.centerX) / this.texel + this.n / 2;
  }
  gridV(z: number): number {
    return (z - this.centerZ) / this.texel + this.n / 2;
  }

  /**
   * Re-origin on whole texels (V-W5). State moves with the world: after the
   * call, world point p reads the same ζ/φ as before wherever both grids
   * cover it; texels entering from outside start at rest.
   */
  setCenter(x: number, z: number): { sx: number; sz: number } {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return { sx: 0, sz: 0 };
    const sx = Math.round((x - this.centerX) / this.texel);
    const sz = Math.round((z - this.centerZ) / this.texel);
    if (sx === 0 && sz === 0) return { sx, sz };
    this.centerX += sx * this.texel;
    this.centerZ += sz * this.texel;
    const tmp = this.w[0];
    shiftField(this.zeta, this.n, sx, sz, tmp);
    shiftField(this.phi, this.n, sx, sz, tmp);
    // the head ζ contains is world-anchored state too (the GPU keeps it in the state texture)
    shiftField(this.prev0, this.n, sx, sz, tmp);
    shiftField(this.prev1, this.n, sx, sz, tmp);
    // the drawn outputs move with the world too, so a read between scroll and step is not stale
    shiftField(this.surface, this.n, sx, sz, tmp);
    shiftField(this.slopeX, this.n, sx, sz, tmp);
    shiftField(this.slopeZ, this.n, sx, sz, tmp);
    return { sx, sz };
  }

  /** draw the sources into the head bins (replaces the previous head) */
  splat(src: WakeSourceBuffer): void {
    const { n, texel, head, head1 } = this;
    head.fill(0);
    head1.fill(0);
    const { d0, d1 } = src.depthBins();
    this.binDepth0 = d0;
    this.binDepth1 = d1;
    this.headLive = false;
    for (let s = 0; s < src.count; s++) {
      const o = s * WAKE_SAMPLE_STRIDE;
      const sigma = splatSigma(src.data[o + 3], texel, n);
      const peak = splatPeakHead(src.data[o + 2], sigma);
      if (!(peak > 0)) continue;
      this.headLive = true;
      const deep = splatBinWeight(src.data[o + 4], d0, d1);
      const u = this.gridU(src.data[o]);
      const v = this.gridV(src.data[o + 1]);
      const r = (WAKE_SPLAT_RADIUS_SIGMAS * sigma) / texel;
      // texel centres strictly inside the quad [u−r, u+r] — the rasteriser's rule
      const i0 = Math.max(0, Math.ceil(u - r));
      const i1 = Math.min(n - 1, Math.floor(u + r));
      const j0 = Math.max(0, Math.ceil(v - r));
      const j1 = Math.min(n - 1, Math.floor(v + r));
      for (let j = j0; j <= j1; j++) {
        const dz = (j - v) * texel;
        for (let i = i0; i <= i1; i++) {
          const dx = (i - u) * texel;
          const h = peak * splatFalloff(dx * dx + dz * dz, sigma);
          head[j * n + i] += h;
          head1[j * n + i] += h * deep;
        }
      }
    }
  }

  /**
   * Advance Δt seconds with the current head held (Δt clamped to
   * [0, WAKE_MAX_DT]).
   *
   * CPU PACKING (a speed choice, same transform): pairs of REAL fields share
   * one complex transform — A + iB with Â = (F + conj F₋)/2, B̂ = (F − conj F₋)/2i
   * — so (ζ, φ), (h0, h1)_new and (h0, h1)_old cost one transform each. When
   * the bin depths did not change, new − old is transformed once instead
   * (linear, identical result): 3 transforms per step, 4 with slope.
   */
  step(dtIn: number, opts: WakeStepOptions = {}): void {
    const dt = Number.isFinite(dtIn) ? Math.min(Math.max(dtIn, 0), WAKE_MAX_DT) : 0;
    const { n } = this;
    const nn = n * n;
    this.ensureTables(dt);
    const [fr, fi, hr, hi, or, oi, gr, gi, qr, qi] = this.w;
    const same = this.binDepth0 === this.prevDepth0 && this.binDepth1 === this.prevDepth1;
    // no head now and none in ζ: the head terms are exactly zero, skip their transform
    const forced = this.headLive || this.prevLive;
    // pack: (−1)^(x+y) centring; bin 0 = head − head1
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const idx = j * n + i;
        const sg = (i + j) & 1 ? -1 : 1;
        fr[idx] = this.zeta[idx] * sg;
        fi[idx] = this.phi[idx] * sg;
        const h1 = this.head1[idx];
        const h0 = this.head[idx] - h1;
        if (same) {
          hr[idx] = (h0 - this.prev0[idx]) * sg;
          hi[idx] = (h1 - this.prev1[idx]) * sg;
        } else {
          hr[idx] = h0 * sg;
          hi[idx] = h1 * sg;
          qr[idx] = this.prev0[idx] * sg;
          qi[idx] = this.prev1[idx] * sg;
        }
      }
    }
    const fwd = this.tables.forward;
    fft2d(fr, fi, n, fwd);
    if (forced) fft2d(hr, hi, n, fwd);
    else {
      hr.fill(0);
      hi.fill(0);
    }
    if (!same) fft2d(qr, qi, n, fwd);
    const a0 = this.attenuation(this.binDepth0);
    const a1 = this.attenuation(this.binDepth1);
    const b0 = same ? a0 : this.attenuation(this.prevDepth0);
    const b1 = same ? a1 : this.attenuation(this.prevDepth1);
    // evolve (exact rotation), 1/N² normalisation applied once here
    const inv = 0.5 / nn; // ½ from the pair separation
    const dc = (n / 2) * n + n / 2;
    for (let j = 0; j < n; j++) {
      const mj = ((n - j) % n) * n;
      const kz = j === 0 ? 0 : this.kx[j]; // Nyquist row: no signed wavenumber
      for (let i = 0; i < n; i++) {
        const idx = j * n + i;
        if (idx === dc) {
          // open sea, not a pond: the displaced volume leaves to infinity, so the
          // mean drawn level stays put — ζ̂'(0) = 0, φ̂'(0) = 0
          or[idx] = oi[idx] = gr[idx] = gi[idx] = 0;
          continue;
        }
        const m = mj + ((n - i) % n);
        // ζ̂ = (F + conj F₋)/2,  φ̂ = (F − conj F₋)/2i
        const ar = (fr[idx] + fr[m]) * inv;
        const ai = (fi[idx] - fi[m]) * inv;
        const br = (fi[idx] + fi[m]) * inv;
        const bi = (fr[m] - fr[idx]) * inv;
        // Δĥ' = e^(−|k|d0)·ĥ0 + e^(−|k|d1)·ĥ1, new minus old
        let zr = ar + a0[idx] * (hr[idx] + hr[m]) * inv + a1[idx] * (hi[idx] + hi[m]) * inv;
        let zi = ai + a0[idx] * (hi[idx] - hi[m]) * inv + a1[idx] * (hr[m] - hr[idx]) * inv;
        if (!same) {
          zr -= b0[idx] * (qr[idx] + qr[m]) * inv + b1[idx] * (qi[idx] + qi[m]) * inv;
          zi -= b0[idx] * (qi[idx] - qi[m]) * inv + b1[idx] * (qr[m] - qr[idx]) * inv;
        }
        const c = this.cosT[idx];
        const s = this.sinT[idx];
        const ka = this.rootKOverG[idx] * s;
        const kb = this.rootGOverK[idx] * s;
        const nzr = zr * c + ka * br;
        const nzi = zi * c + ka * bi;
        const pr = br * c - kb * zr;
        const pi = bi * c - kb * zi;
        // repack ζ̂' + iφ̂'
        or[idx] = nzr - pi;
        oi[idx] = nzi + pr;
        if (opts.slope) {
          // (∂x + i∂z)ζ: i·kx·ζ̂' + i·(i·kz·ζ̂') = i·kx·ζ̂' − kz·ζ̂'
          const kxs = i === 0 ? 0 : this.kx[i];
          gr[idx] = -kxs * nzi - kz * nzr;
          gi[idx] = kxs * nzr - kz * nzi;
        }
      }
    }
    const invT = this.tables.inverse;
    fft2d(or, oi, n, invT);
    if (opts.slope) fft2d(gr, gi, n, invT);
    // post: un-centre, sponge, η_vis = ζ; the head ζ now contains becomes "old"
    const sp = this.spongeAxis;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const idx = j * n + i;
        const sg = (i + j) & 1 ? -1 : 1;
        const damp = sp[i] * sp[j] * sg;
        const zeta = or[idx] * damp;
        this.zeta[idx] = zeta;
        this.phi[idx] = oi[idx] * damp;
        this.surface[idx] = clamp(zeta, WAKE_ETA_CLAMP);
        this.prev1[idx] = this.head1[idx];
        this.prev0[idx] = this.head[idx] - this.head1[idx];
        if (opts.slope) {
          this.slopeX[idx] = clamp(gr[idx] * sg, WAKE_SLOPE_CLAMP);
          this.slopeZ[idx] = clamp(gi[idx] * sg, WAKE_SLOPE_CLAMP);
        }
      }
    }
    this.prevDepth0 = this.binDepth0;
    this.prevDepth1 = this.binDepth1;
    this.prevLive = this.headLive;
    this.time += dt;
  }

  /** bilinear η_vis at a world point (0 outside the grid) */
  surfaceAt(x: number, z: number): number {
    const u = this.gridU(x);
    const v = this.gridV(z);
    const i = Math.floor(u);
    const j = Math.floor(v);
    const fu = u - i;
    const fv = v - j;
    const at = (a: number, b: number): number =>
      a < 0 || b < 0 || a >= this.n || b >= this.n ? 0 : this.surface[b * this.n + a];
    return (
      (at(i, j) * (1 - fu) + at(i + 1, j) * fu) * (1 - fv) + (at(i, j + 1) * (1 - fu) + at(i + 1, j + 1) * fu) * fv
    );
  }

  /**
   * Free-wave energy (J): ½ρ·ΔA·(1/N²)·Σ_k (g|ζ̂|² + |k||φ̂|²) with ζ̂, φ̂ the
   * unnormalised transforms — conserved exactly by the rotation, only ever
   * removed by the sponge. Where sources press, ζ includes their drawn head.
   */
  energy(): number {
    const { n } = this;
    const nn = n * n;
    const [fr, fi] = this.w;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const idx = j * n + i;
        const sg = (i + j) & 1 ? -1 : 1;
        fr[idx] = this.zeta[idx] * sg;
        fi[idx] = this.phi[idx] * sg;
      }
    }
    fft2d(fr, fi, n, this.tables.forward);
    let sum = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const idx = j * n + i;
        const m = ((n - j) % n) * n + ((n - i) % n);
        const ar = (fr[idx] + fr[m]) * 0.5;
        const ai = (fi[idx] - fi[m]) * 0.5;
        const br = (fi[idx] + fi[m]) * 0.5;
        const bi = (fr[m] - fr[idx]) * 0.5;
        sum += GRAVITY * (ar * ar + ai * ai) + this.kMag[idx] * (br * br + bi * bi);
      }
    }
    return (0.5 * WAKE_RHO * this.texel * this.texel * sum) / nn;
  }

  /**
   * Wave-making resistance (N) of the CURRENT sources moving along the unit
   * direction (dirX, dirZ): R = ∫ ρg·h'·∂η/∂s dA (Havelock's pressure-
   * distribution form, the horizontal force the sea's slope exerts back on the
   * hull pressing it; positive = drag). Evaluated by Parseval with η = ζ − h':
   * the h'·∂h'/∂s part integrates to zero, so R = ρg·ΔA/N²·Re Σ conj(ĥ')·i·k_s·ζ̂.
   * CPU diagnostic only (tests, pond readouts) — not part of the step.
   */
  waveResistance(dirX: number, dirZ: number): number {
    const { n } = this;
    const nn = n * n;
    const len = Math.hypot(dirX, dirZ) || 1;
    const ux = dirX / len;
    const uz = dirZ / len;
    const [fr, fi, hr, hi] = this.w;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const idx = j * n + i;
        const sg = (i + j) & 1 ? -1 : 1;
        fr[idx] = this.zeta[idx] * sg;
        fi[idx] = 0;
        hr[idx] = (this.head[idx] - this.head1[idx]) * sg;
        hi[idx] = this.head1[idx] * sg;
      }
    }
    fft2d(fr, fi, n, this.tables.forward);
    fft2d(hr, hi, n, this.tables.forward);
    const a0 = this.attenuation(this.binDepth0);
    const a1 = this.attenuation(this.binDepth1);
    let sum = 0;
    for (let j = 0; j < n; j++) {
      const kz = j === 0 ? 0 : this.kx[j];
      for (let i = 0; i < n; i++) {
        const idx = j * n + i;
        const m = ((n - j) % n) * n + ((n - i) % n);
        const kxs = i === 0 ? 0 : this.kx[i];
        const ks = kxs * ux + kz * uz;
        const h0r = (hr[idx] + hr[m]) * 0.5;
        const h0i = (hi[idx] - hi[m]) * 0.5;
        const h1r = (hi[idx] + hi[m]) * 0.5;
        const h1i = (hr[m] - hr[idx]) * 0.5;
        const pr = a0[idx] * h0r + a1[idx] * h1r;
        const pi = a0[idx] * h0i + a1[idx] * h1i;
        // Re[conj(p)·(i·ks·ζ̂)] = ks·(pi·ζr − pr·ζi)
        sum += ks * (pi * fr[idx] - pr * fi[idx]);
      }
    }
    return (WAKE_RHO * GRAVITY * this.texel * this.texel * sum) / nn;
  }

  /** per-mode e^(−|k|d), cached for the few depths a scene uses */
  private attenuation(depth: number): Float64Array {
    let a = this.attCache.get(depth);
    if (!a) {
      if (this.attCache.size >= 8) this.attCache.clear();
      a = new Float64Array(this.kMag.length);
      for (let idx = 0; idx < a.length; idx++) a[idx] = sourceDepthAttenuation(this.kMag[idx], depth);
      this.attCache.set(depth, a);
    }
    return a;
  }

  private ensureTables(dt: number): void {
    if (dt !== this.tableDt) {
      const nn = this.n * this.n;
      for (let idx = 0; idx < nn; idx++) {
        const w = dispersion(this.kMag[idx]) * dt;
        this.cosT[idx] = Math.cos(w);
        this.sinT[idx] = Math.sin(w);
      }
      this.tableDt = dt;
    }
    if (dt !== this.spongeDt) {
      for (let i = 0; i < this.n; i++) this.spongeAxis[i] = Math.exp(-this.gammaAxis[i] * dt);
      this.spongeDt = dt;
    }
  }
}

function clamp(v: number, lim: number): number {
  return v > lim ? lim : v < -lim ? -lim : v;
}

/** new[i, j] = old[i + sx, j + sz]; 0 where that falls outside */
function shiftField(f: Float64Array | Float32Array, n: number, sx: number, sz: number, tmp: Float64Array): void {
  tmp.fill(0);
  for (let j = 0; j < n; j++) {
    const oj = j + sz;
    if (oj < 0 || oj >= n) continue;
    for (let i = 0; i < n; i++) {
      const oi = i + sx;
      if (oi < 0 || oi >= n) continue;
      tmp[j * n + i] = f[oj * n + oi];
    }
  }
  f.set(tmp);
}
