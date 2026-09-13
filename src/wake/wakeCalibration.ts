/**
 * Wake calibration presets + readouts (§T W2a, docs/wake/w2a-source-model.md).
 * Engine-free: the SAME functions run the vitest calibration tests on the CPU
 * solver and the pond's readouts on a GPU state readback, so a number in the
 * write-up, a test bound and a pond HUD line are one measurement (§V77).
 *
 * Frame: the vessel runs along world +x at constant speed from x = 0, on the
 * z = 0 track, level, at her flat-calm equilibrium draft. Every length below
 * is in metres in the HULL frame (x forward of the ship origin, z to port).
 */
import { quatFromAxisAngle } from '../core/quat';
import { GRAVITY } from '../ocean/oceanMath';
import { brigantineSeaParams, raftSeaParams, seaPhysicsParams, type SeaPhysicsParams } from '../params/seaPhysics';
import { equilibriumDraft, probeStations } from '../sea-physics/buoyancy';
import type { ShipState } from '../state/simState';
import { planingPatchSamples, stationSamples, type PlaningPatch } from './stationSources';
import { propJetSample, type PropWashInput } from './propWash';
import {
  WAKE_ETA_CLAMP,
  WAKE_MAX_DT,
  WakeSolverCpu,
  WakeSourceBuffer,
  defaultSponge,
  fft2d,
  modeWavenumber,
  splatSigma,
  wakeAnchor,
  wakeButterflyTables,
  type HydroSample,
} from './wakeSolverMath';

/** W0 target sea: default `swell` preset Hs (docs/wake/w0-measurement.md §1) */
export const W0_SWELL_HS = 2.78;

/**
 * Wake tier for ship speeds up to 10 m/s: 256² × 0.625 m = 160 m.
 * MEASURED (w2a doc §4): at 10 m/s λ_T = 64 m; a 128 m domain (λ_T/L = 0.5)
 * recirculated it past the sponge and read near-hull peak-to-trough +85% and
 * wave resistance +96% against a 256 m reference, while 160 m stayed within
 * ~10%. Law: L_dom ≥ 2.4·λ_T(U_max) — just under the measured-good ratio
 * 160/64 = 2.50; the measured-bad ratio was 2.0.
 */
export const WAKE_SHIP_TIER = { n: 256, texel: 0.625 } as const;
export const WAKE_DOMAIN_PER_LAMBDA_T = 2.4;
/** the raft's tier (w2a §5): 256² × 0.5 m = 128 m, λ_T(2 m/s) = 2.56 m is 5 texels */
export const WAKE_RAFT_TIER = { n: 256, texel: 0.5 } as const;

/**
 * HIGH-FROUDE TIER RULE (§T.181 hook 6, docs/wake/w5c-speedboat-tier.md). W2a's
 * L_dom ≥ 2.4·λ_T is a TRANSVERSE-wave law; at 40 m/s λ_T = 2πU²/g = 1025 m and
 * no 256² grid can hold it (512² costs 1.4–3.3 ms GPU, wake-research §2.4). A
 * planing hull's visible wake is the DIVERGENT system instead: stationary waves at
 * propagation angle θ have k = g/(U²cos²θ) and their energy sits on the ray
 * tan α = tanθ/(1 + 2tan²θ) ≈ c_g(k)/U — narrow arms whose angle is set by the
 * shortest wave the (band-limited) forcing still excites (`havelockArmAngleDeg`).
 * Those waves are λ ≈ 2–25 m, so what the domain must hold is LENGTH ASTERN, not λ_T:
 *
 *   reach astern of the stem = 2·(0.5 − sponge.width)·n·texel − clearance,
 *   clearance = 4·splatSigma(0, texel) = 4√2·texel (`wakeAnchor`)
 *   ⇒ texel ≥ reach / (2(0.5 − w)·n − 4√2)
 *
 * The texel is ALSO the forcing's band limit (splat σ ≥ √2·texel, §V48): coarser
 * texels push the dominant divergent wave longer and the arm wider. The rule takes
 * the smallest texel (in 1/8 m) that reaches `reachAstern`; the resolution cost is
 * checked against Rabaud & Moisy's hull-length law in tests/wakeSpeedboatTier.test.ts.
 * Below the speed where 2.4·λ_T still fits the ship tier, the W2a tier stands.
 */
export const SPEEDBOAT_WAKE_REACH_ASTERN = 300;

export function wakeTierForSpeed(maxSpeed: number, reachAstern = SPEEDBOAT_WAKE_REACH_ASTERN, n = 256): { n: number; texel: number } {
  const lambdaT = (2 * Math.PI * maxSpeed * maxSpeed) / GRAVITY;
  if (WAKE_DOMAIN_PER_LAMBDA_T * lambdaT <= WAKE_SHIP_TIER.n * WAKE_SHIP_TIER.texel) return { n: WAKE_SHIP_TIER.n, texel: WAKE_SHIP_TIER.texel };
  const w = defaultSponge(n, 1).width; // a fraction of the domain, independent of the texel
  const texel = Math.ceil((8 * reachAstern) / (2 * (0.5 - w) * n - 4 * Math.SQRT2)) / 8;
  return { n, texel: Math.max(texel, WAKE_SHIP_TIER.texel) };
}

/** reach of the unsponged interior astern of the stem for a tier (m) — the inverse of the rule */
export function wakeReachAstern(tier: { n: number; texel: number }): number {
  const L = tier.n * tier.texel;
  return 2 * (0.5 - defaultSponge(tier.n, tier.texel).width) * L - 4 * splatSigma(0, tier.texel, tier.n);
}

/** the speedboat's in-game wake tier: 256² × 1.75 m = 448 m, 304 m of interior astern of the stem at ≤ 40 m/s */
export const WAKE_SPEEDBOAT_MAX_SPEED = 40;
export const WAKE_SPEEDBOAT_TIER: { readonly n: number; readonly texel: number } = Object.freeze(wakeTierForSpeed(WAKE_SPEEDBOAT_MAX_SPEED));

/**
 * HAVELOCK'S FAR FIELD, EVALUATED FOR A SAMPLED SOURCE (Havelock 1908; the
 * stationary-phase form Darmon, Benzaquen & Raphaël 2014 use). For a pressure P
 * towed at U along +x the linear surface is
 *   η(r, α) ≈ (1/ρg) ∫ dθ k² P̂(k cosθ, k sinθ) e^{i r G(θ)},  k = g/(U²cos²θ),  G = k·cos(θ − α)
 * and stationary phase on the divergent branch (θ from the cusp 35.26° to 90°) puts
 * amplitude A(α) ∝ k²|P̂| / √(r·|G''(θs)|) on the ray tan α = tan θs / (1 + 2tan²θs).
 * The arm is the α maximising A√r. P̂ is the transform of the samples AS THE SOLVER
 * DRAWS THEM (`band` given): Gaussian σ = splatSigma(footprint, texel, n), buried at
 * `depth` (e^{−kd}); with `band` null the physical footprint is used. Large-Fr limit
 * for one Gaussian: 12.85°/Fr_b (Darmon eq. 4.11); for a hull whose forcing has no
 * structure shorter than L it tends to Rabaud–Moisy's 11.4°/Fr_L.
 */
export function havelockArmAngleDeg(
  sources: readonly HydroSample[],
  originX: number,
  originZ: number,
  speed: number,
  band: { n: number; texel: number } | null,
): { alphaDeg: number; lambda: number; thetaDeg: number } {
  const k0 = GRAVITY / (speed * speed);
  const cusp = Math.atan(Math.SQRT1_2);
  let best = -1;
  let out = { alphaDeg: NaN, lambda: NaN, thetaDeg: NaN };
  for (let deg = (cusp * 180) / Math.PI + 0.01; deg < 89.99; deg += 0.01) {
    const t = (deg * Math.PI) / 180;
    const c = Math.cos(t);
    const k = k0 / (c * c);
    const kx = k * c;
    const kz = k * Math.sin(t);
    let re = 0;
    let im = 0;
    for (const s of sources) {
      const sig = band ? splatSigma(s.footprint, band.texel, band.n) : s.footprint;
      const w = s.fy * Math.exp((-k * k * sig * sig) / 2) * Math.exp(-k * Math.max(0, s.depth));
      const ph = kx * (s.x - originX) + kz * (s.z - originZ);
      re += w * Math.cos(ph);
      im -= w * Math.sin(ph);
    }
    const tn = Math.tan(t);
    const alpha = Math.atan(tn / (1 + 2 * tn * tn));
    // G'' in closed form: G = k0·cos(θ−α)/cos²θ
    const h = 1e-4;
    const G = (x: number): number => (k0 * Math.cos(x - alpha)) / (Math.cos(x) * Math.cos(x));
    const g2 = Math.abs((G(t + h) - 2 * G(t) + G(t - h)) / (h * h));
    const a = (k * k * Math.hypot(re, im)) / Math.sqrt(g2);
    if (a > best) {
      best = a;
      out = { alphaDeg: (alpha * 180) / Math.PI, lambda: (2 * Math.PI) / k, thetaDeg: deg };
    }
  }
  return out;
}

/**
 * Speedboat reference (docs/speedboat/tech-research.md §2.4 Savitsky table,
 * 45 m/s row, 12 m boat of src/speedboat/hullMesh.ts: 5842 kg, chine beam
 * 2.618 m; wetted length 4.4 m × 12/11 scale; trim 1.4°).
 */
export const SPEEDBOAT_PLANING: PlaningPatch = { mass: 5842, beam: 2.618, wettedLength: 4.8, trim: (1.4 * Math.PI) / 180 };

export type WakeHullKind = 'galleon' | 'brigantine' | 'raft' | 'speedboat';

export interface WakePreset {
  name: string;
  kind: WakeHullKind;
  /** m/s */
  speed: number;
  n: number;
  texel: number;
}

export const WAKE_PRESETS: readonly WakePreset[] = [
  { name: 'galleon-5', kind: 'galleon', speed: 5, ...WAKE_SHIP_TIER },
  { name: 'galleon-7', kind: 'galleon', speed: 7, ...WAKE_SHIP_TIER },
  { name: 'galleon-10', kind: 'galleon', speed: 10, ...WAKE_SHIP_TIER },
  { name: 'brigantine-7', kind: 'brigantine', speed: 7, ...WAKE_SHIP_TIER },
  { name: 'raft-2', kind: 'raft', speed: 2, ...WAKE_RAFT_TIER },
  // §T.181 hook 6: the divergent tier (448 m), not the ship's 160 m — see wakeTierForSpeed
  { name: 'speedboat-40', kind: 'speedboat', speed: 40, ...WAKE_SPEEDBOAT_TIER },
];

export function presetByName(name: string): WakePreset {
  const p = WAKE_PRESETS.find((q) => q.name === name);
  if (!p) throw new Error(`wake: no preset ${name}`);
  return p;
}

export function seaParamsFor(kind: WakeHullKind): SeaPhysicsParams | null {
  return kind === 'galleon' ? seaPhysicsParams : kind === 'brigantine' ? brigantineSeaParams : kind === 'raft' ? raftSeaParams : null;
}

/** plan outline of the hull in its own frame */
export interface HullFrame {
  /** stem x (forward end of the wetted plan) */
  stem: number;
  /** transom x (aft end) */
  transom: number;
  /** widest half-breadth, m */
  halfBeam: number;
  /** half-breadth at hull-frame x (−1 outside the plan's length) */
  halfBreadth(x: number): number;
  /** wetted length stem − transom */
  length: number;
}

/**
 * The plan the station quadrature stands for: per slice, the half-breadth is
 * the outer Gauss node / √(3/5); stem/transom sit half a slice beyond the end
 * stations; linear between slices, tapering to 0 at the stem.
 */
export function stationFrame(p: SeaPhysicsParams): HullFrame {
  const set = probeStations(p.probeSlices, p);
  const per = 3;
  const slices: { x: number; hb: number }[] = [];
  for (let a = 0; a < set.stations.length; a += per) {
    const g = set.stations.slice(a, a + per);
    slices.push({ x: g[0].local[2] * p.probeLayoutScale, hb: (Math.max(...g.map((t) => Math.abs(t.local[0]))) / Math.sqrt(3 / 5)) * p.probeLayoutScale });
  }
  slices.sort((a, b) => a.x - b.x);
  const half = slices.length > 1 ? (slices[1].x - slices[0].x) / 2 : 0.5;
  const stem = slices[slices.length - 1].x + half;
  const transom = slices[0].x - half;
  const halfBeam = Math.max(...slices.map((s) => s.hb));
  const halfBreadth = (x: number): number => {
    if (x > stem || x < transom) return -1;
    if (x <= slices[0].x) return slices[0].hb;
    const last = slices[slices.length - 1];
    if (x >= last.x) return (last.hb * (stem - x)) / (stem - last.x);
    for (let i = 0; i + 1 < slices.length; i++) {
      if (x <= slices[i + 1].x) {
        const f = (x - slices[i].x) / (slices[i + 1].x - slices[i].x);
        return slices[i].hb + f * (slices[i + 1].hb - slices[i].hb);
      }
    }
    return 0;
  };
  return { stem, transom, halfBeam, halfBreadth, length: stem - transom };
}

function planingFrame(patch: PlaningPatch): HullFrame {
  const hb = patch.beam / 2;
  return {
    stem: patch.wettedLength,
    transom: 0,
    halfBeam: hb,
    halfBreadth: (x) => (x < 0 || x > patch.wettedLength ? -1 : hb),
    length: patch.wettedLength,
  };
}

export function presetFrame(preset: WakePreset): HullFrame {
  const p = seaParamsFor(preset.kind);
  return p ? stationFrame(p) : planingFrame(SPEEDBOAT_PLANING);
}

/** a level ship at her flat-calm marks, origin at (x, 0), heading +x */
export function towedShip(p: SeaPhysicsParams, x: number): ShipState {
  return {
    id: 'wake-tow',
    kind: 'player',
    position: [x, equilibriumDraft(p), 0],
    // body +z (forward) → world +x
    quaternion: quatFromAxisAngle([0, 1, 0], Math.PI / 2),
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    rudder: 0,
    sailTrim: 0,
    flood: 0,
  } as unknown as ShipState;
}

/** the preset vessel's samples with its origin at world (x, 0) */
export function presetSamples(preset: WakePreset, x: number, out: HydroSample[] = []): HydroSample[] {
  const p = seaParamsFor(preset.kind);
  if (p) return stationSamples(towedShip(p, x), p, out);
  return planingPatchSamples(SPEEDBOAT_PLANING, x, 0, 1, 0, out);
}

/** domain centre for a vessel whose origin is at x (V-W5: bow-anchored, sim pose only) */
export function presetAnchor(preset: WakePreset, frame: HullFrame, x: number): { x: number; z: number } {
  const sponge = defaultSponge(preset.n, preset.texel);
  const clearance = 4 * splatSigma(0, preset.texel, preset.n);
  return wakeAnchor(x, 0, 1, 0, frame.stem, preset.n * preset.texel, sponge, clearance);
}

/**
 * Step length for a towed source: forcing is held over a step, so keep the
 * hull's jump per step under 0.4 of the narrowest splat and the transverse
 * period well sampled. The integrator itself is exact for any Δt.
 */
export function towStep(preset: WakePreset): number {
  const sigma = splatSigma(0, preset.texel, preset.n);
  return Math.min(WAKE_MAX_DT, (0.3 * preset.speed) / GRAVITY, (0.4 * sigma) / preset.speed);
}

/** seconds until the pattern over the measured window is steady (start-up packet gone) */
export function towDuration(preset: WakePreset): number {
  return (1.4 * preset.n * preset.texel) / preset.speed + 10;
}

export interface Tow {
  solver: WakeSolverCpu;
  /** vessel origin x at the end */
  x: number;
  frame: HullFrame;
}

/**
 * Tow a preset through a fresh CPU solver. Force ramps in over the first 4 s
 * (smoothstep) so the start-up transient is a gentle packet, not a slam.
 * `hook` runs after every step (e.g. to time-average a readout).
 */
export function towPreset(
  preset: WakePreset,
  opts: {
    duration?: number;
    dt?: number;
    mutateSample?: (s: HydroSample) => void;
    hook?: (t: Tow, time: number) => void;
    /**
     * §T.180: a stateful vessel in place of the stateless preset samples — the
     * contact-driven speedboat (`speedboatTow.SpeedboatTow`), whose prop jets
     * are splatted as signed jet sources. Its origin is towed to x = speed·t.
     */
    vessel?: PresetVessel;
  } = {},
): Tow {
  const solver = new WakeSolverCpu({ n: preset.n, texel: preset.texel });
  const frame = opts.vessel?.frame ?? presetFrame(preset);
  const dt = opts.dt ?? towStep(preset);
  const duration = opts.duration ?? towDuration(preset);
  const buf = new WakeSourceBuffer();
  const samples: HydroSample[] = [];
  const tow: Tow = { solver, x: 0, frame };
  const steps = Math.ceil(duration / dt);
  // §T.180: the domain scrolls with her, so the sponge absorbs at c_g + U along her track
  solver.setDomainVelocity(preset.speed, 0);
  for (let k = 0; k < steps; k++) {
    const time = k * dt;
    tow.x = preset.speed * time;
    const c = wakeAnchor(tow.x, 0, 1, 0, frame.stem, preset.n * preset.texel, defaultSponge(preset.n, preset.texel), 4 * splatSigma(0, preset.texel, preset.n));
    solver.setCenter(c.x, c.z);
    const r = Math.min(1, time / 4);
    const ramp = r * r * (3 - 2 * r);
    buf.clear();
    if (opts.vessel) {
      opts.vessel.advanceTo(tow.x);
      for (const s of opts.vessel.samples(samples)) {
        opts.mutateSample?.(s);
        buf.push(s.x, s.z, s.fy * ramp, s.footprint, s.depth);
      }
      for (const j of opts.vessel.jets()) {
        const q = propJetSample(j);
        if (q) buf.pushJet(q.x, q.z, q.fy * ramp, q.footprint, q.depth);
      }
    } else {
      presetSamples(preset, tow.x, samples);
      for (const s of samples) {
        opts.mutateSample?.(s);
        buf.push(s.x, s.z, s.fy * ramp, s.footprint, s.depth);
      }
    }
    solver.splat(buf);
    solver.step(dt);
    opts.hook?.(tow, time + dt);
  }
  return tow;
}

/** a stateful towed vessel (§T.180 — `SpeedboatTow`): its own frame, samples and prop jets */
export interface PresetVessel {
  readonly frame: HullFrame;
  advanceTo(x: number): void;
  samples(out: HydroSample[]): HydroSample[];
  jets(): readonly PropWashInput[];
}

/** a wake field as the pond reads it back or the CPU solver holds it */
export interface WakeField {
  n: number;
  texel: number;
  centerX: number;
  centerZ: number;
  /** drawn surface ζ (m), row j = z, column i = x */
  zeta: ArrayLike<number>;
  /** surface velocity potential (m²/s) — needed only for the envelope angle */
  phi?: ArrayLike<number>;
}

export interface WakeReadout {
  froudeL: number;
  lambdaT: number;
  /** max − min of η_vis outside the plan within one full beam of it */
  nearHullPeakToTrough: number;
  /** highest crest in that band, forward third / aft third of the hull */
  bowCrest: number;
  sternCrest: number;
  /** highest crest ahead of midships and ≥ 1.25 half-beams off the track: the bow wave clear of the silhouette */
  shoulderCrest: number;
  /** max |∇η_vis| on the Kelvin cusp band (15°–23° from the stem, L … L + 50 m astern), unsponged interior */
  cuspSlope: number;
  /** max − min of η_vis along the line one half-length off the track (Kriebel–Seelig's y) */
  lineHeightHalfL: number;
  /**
   * Kriebel & Seelig (2005) empirical H at y = L/2, deep water, Le = 0.4 L (EST):
   * gH/U² = β(F − 0.1)²(y/L)^(−1/3), β = 1 + 8·tanh³(0.45(L/Le − 2)) — as
   * reproduced in ERDC/CHL CHETN-IX-46 (2017) eq. 1–5. NaN past Fr_L 0.7.
   */
  kriebelHalfL: number;
  /**
   * angle (deg, from the stem) of the DIVERGENT envelope maximum, searched from
   * half the Rabaud–Moisy angle to 35° so the transverse train on the track does
   * not win; a result AT that floor means transverse-dominated. NaN without φ
   */
  alphaMaxDeg: number;
  /** Rabaud–Moisy hull-length law (deg) */
  alphaRabaudMoisyDeg: number;
  /** texels at or past the ±3 m source clamp */
  clampHits: number;
  maxAbs: number;
}

/** Rabaud & Moisy 2013 (PRL 110:214503): Kelvin up to Fr_c = √(3/4π), then atan(√(2πF²−1)/(4πF²−1)) */
export function rabaudMoisyAngleDeg(froudeL: number): number {
  const f2 = froudeL * froudeL;
  const kelvin = (Math.asin(1 / 3) * 180) / Math.PI;
  if (f2 <= 3 / (4 * Math.PI)) return kelvin; // Fr_c = √(3/4π) ≈ 0.49, where the formula meets 19.47°
  return (Math.atan(Math.sqrt(2 * Math.PI * f2 - 1) / (4 * Math.PI * f2 - 1)) * 180) / Math.PI;
}

/**
 * Measure a wake whose vessel origin is at world (shipX, 0) running +x.
 * Only the unsponged interior is read — the sponge is not wake.
 */
export function measureWake(field: WakeField, frame: HullFrame, shipX: number, speed: number): WakeReadout {
  const { n, texel } = field;
  const nn = n * n;
  const L = frame.length;
  const interior = (0.5 - defaultSponge(n, texel).width) * n * texel;
  // spectral slope of ζ (the solver's own derivative)
  const tables = wakeButterflyTables(n);
  const domain = n * texel;
  const re = new Float64Array(nn);
  const im = new Float64Array(nn);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) re[j * n + i] = field.zeta[j * n + i] * ((i + j) & 1 ? -1 : 1);
  fft2d(re, im, n, tables.forward);
  const gxr = new Float64Array(nn);
  const gxi = new Float64Array(nn);
  const gzr = new Float64Array(nn);
  const gzi = new Float64Array(nn);
  for (let j = 0; j < n; j++) {
    const kz = j === 0 ? 0 : modeWavenumber(j, n, domain);
    for (let i = 0; i < n; i++) {
      const kx = i === 0 ? 0 : modeWavenumber(i, n, domain);
      const idx = j * n + i;
      gxr[idx] = (-kx * im[idx]) / nn;
      gxi[idx] = (kx * re[idx]) / nn;
      gzr[idx] = (-kz * im[idx]) / nn;
      gzi[idx] = (kz * re[idx]) / nn;
    }
  }
  fft2d(gxr, gxi, n, tables.inverse);
  fft2d(gzr, gzi, n, tables.inverse);

  const kelvin = (Math.asin(1 / 3) * 180) / Math.PI;
  let pk = -Infinity;
  let tr = Infinity;
  let bow = -Infinity;
  let stern = -Infinity;
  let shoulder = -Infinity;
  let cusp = 0;
  let clampHits = 0;
  let maxAbs = 0;
  const mid = (frame.stem + frame.transom) / 2;
  const beam = 2 * frame.halfBeam;
  for (let j = 0; j < n; j++) {
    const wz = (j - n / 2) * texel + field.centerZ;
    for (let i = 0; i < n; i++) {
      const idx = j * n + i;
      const v = field.zeta[idx];
      const a = Math.abs(v);
      if (a >= WAKE_ETA_CLAMP) clampHits++;
      if (a > maxAbs) maxAbs = a;
      const wx = (i - n / 2) * texel + field.centerX;
      if (Math.abs(wx - field.centerX) > interior || Math.abs(wz - field.centerZ) > interior) continue;
      const hx = wx - shipX;
      const hb = frame.halfBreadth(hx);
      if (hb >= 0 && Math.abs(wz) <= hb + texel) continue; // under the hull: not visible wake
      const dx = Math.max(0, hx - frame.stem, frame.transom - hx);
      const dz = Math.max(0, Math.abs(wz) - Math.max(0, hb));
      if (Math.hypot(dx, dz) <= beam) {
        if (v > pk) pk = v;
        if (v < tr) tr = v;
        if (hx >= frame.stem - L / 3 && v > bow) bow = v;
        if (hx <= frame.transom + L / 3 && v > stern) stern = v;
      }
      if (Math.abs(wz) >= 1.25 * frame.halfBeam && hx >= mid && hx <= frame.stem + L / 2 && v > shoulder) shoulder = v;
      const rx = frame.stem - hx;
      const rr = Math.hypot(rx, wz);
      const ang = (Math.atan2(Math.abs(wz), rx) * 180) / Math.PI;
      if (rx > 0 && ang > kelvin - 4.5 && ang < kelvin + 3.5 && rr > L && rr < L + 50) {
        const sl = Math.hypot(gxr[idx] * ((i + j) & 1 ? -1 : 1), gzr[idx] * ((i + j) & 1 ? -1 : 1));
        if (sl > cusp) cusp = sl;
      }
    }
  }

  // Kriebel-comparable line height at y = L/2
  const at = (wx: number, wz: number): number => {
    const u = (wx - field.centerX) / texel + n / 2;
    const w = (wz - field.centerZ) / texel + n / 2;
    const i = Math.floor(u);
    const j = Math.floor(w);
    const fu = u - i;
    const fw = w - j;
    const g = (a: number, b: number): number => (a < 0 || b < 0 || a >= n || b >= n ? 0 : field.zeta[b * n + a]);
    return (g(i, j) * (1 - fu) + g(i + 1, j) * fu) * (1 - fw) + (g(i, j + 1) * (1 - fu) + g(i + 1, j + 1) * fu) * fw;
  };
  let line = 0;
  for (const side of [-1, 1]) {
    const wz = (side * L) / 2;
    if (Math.abs(wz - field.centerZ) > interior) continue;
    let mx = -Infinity;
    let mn = Infinity;
    for (let hx = frame.stem + 10; ; hx -= texel / 2) {
      const wx = shipX + hx;
      if (wx - field.centerX < -interior) break;
      if (wx - field.centerX > interior) continue;
      const v = at(wx, wz);
      if (v > mx) mx = v;
      if (v < mn) mn = v;
    }
    if (mx > mn) line = Math.max(line, mx - mn);
  }
  const froudeL = speed / Math.sqrt(GRAVITY * L);
  const beta = 1 + 8 * Math.tanh(0.45 * (L / (0.4 * L) - 2)) ** 3;
  // displacement-ship fit: meaningless for a planing hull, so NaN past Fr_L 0.7
  const kriebel =
    froudeL > 0.7 ? NaN : (beta * Math.max(0, froudeL - 0.1) ** 2 * Math.pow(0.5, -1 / 3) * (speed * speed)) / GRAVITY;

  return {
    froudeL,
    lambdaT: (2 * Math.PI * speed * speed) / GRAVITY,
    nearHullPeakToTrough: pk > tr ? pk - tr : 0,
    bowCrest: bow,
    sternCrest: stern,
    shoulderCrest: shoulder,
    cuspSlope: cusp,
    lineHeightHalfL: line,
    kriebelHalfL: kriebel,
    alphaMaxDeg: field.phi ? envelopeAngle(field, frame, shipX, interior, 0.5 * rabaudMoisyAngleDeg(froudeL)) : NaN,
    alphaRabaudMoisyDeg: rabaudMoisyAngleDeg(froudeL),
    clampHits,
    maxAbs,
  };
}

/**
 * Angle (deg, from the stem) of the maximum of the phase-free envelope
 * A² = ζ² + φ·(|k|φ)/g along rays, √r-weighted (the method of
 * tests/wakeKelvin.test.ts), over r from one hull length to the interior edge.
 */
function envelopeAngle(field: WakeField, frame: HullFrame, shipX: number, interior: number, fromDeg: number): number {
  const { n, texel } = field;
  const phi = field.phi!;
  const nn = n * n;
  const domain = n * texel;
  const tables = wakeButterflyTables(n);
  const re = new Float64Array(nn);
  const im = new Float64Array(nn);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) re[j * n + i] = phi[j * n + i] * ((i + j) & 1 ? -1 : 1);
  fft2d(re, im, n, tables.forward);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = Math.hypot(modeWavenumber(i, n, domain), modeWavenumber(j, n, domain)) / nn;
      re[j * n + i] *= k;
      im[j * n + i] *= k;
    }
  }
  fft2d(re, im, n, tables.inverse);
  const a2 = new Float64Array(nn);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const idx = j * n + i;
      a2[idx] = field.zeta[idx] ** 2 + (phi[idx] * re[idx] * ((i + j) & 1 ? -1 : 1)) / GRAVITY;
    }
  }
  const sx = shipX + frame.stem;
  const r1 = frame.length;
  // one radial window for every angle, so no ray is integrated further than another
  const r2 = Math.min(interior + (sx - field.centerX), (interior - Math.abs(field.centerZ)) / Math.sin((35 * Math.PI) / 180));
  let best = -1;
  let alpha = NaN;
  for (let deg = fromDeg; deg <= 35; deg += 0.25) {
    const a = (deg * Math.PI) / 180;
    let sum = 0;
    for (let r = r1; r <= r2; r += texel / 2) {
      const wx = sx - r * Math.cos(a);
      const wz = r * Math.sin(a);
      for (const side of [-1, 1]) {
        const u = Math.round((wx - field.centerX) / texel + n / 2);
        const v = Math.round((side * wz - field.centerZ) / texel + n / 2);
        if (u < 0 || v < 0 || u >= n || v >= n) continue;
        sum += Math.sqrt(Math.max(0, a2[v * n + u])) * Math.sqrt(r);
      }
    }
    if (sum > best) {
      best = sum;
      alpha = deg;
    }
  }
  return alpha;
}
