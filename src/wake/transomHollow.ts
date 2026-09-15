/**
 * W8 round 5: THE TRANSOM HOLLOW, DRAWN (docs/wake/w8-foam-readability.md §16). The physics runs a planing hull's drives in
 * the hollow behind her dry transom (`HullWater.transomWakeDepthAt`, T196: the Korvin-Kroukovsky/Savitsky/Lehman
 * centreline profile the prop immersion uses), but the drawn water was flat there, so the lower units hovered over an
 * unbroken surface.
 *
 * The linear wake solver cannot make a separated hollow by itself, so the hollow enters it the way transom-stern flow is
 * treated in linear ship-wave theory: as a VIRTUAL EXTENSION OF THE HULL whose pressure holds the free surface down by
 * the hollow's depth (Doctors & Day 1997). Hull-type samples of weight ρ·g·dep·dA: the drawn surface (η + h) dips there,
 * and where the pressure ends the flow closes and the solver radiates the rooster-tail hump aft of it.
 *
 * `HollowRecord` is the compact per-boat form (transom point, forward, length, width, HOLLOW_DEPTHS depths at the cell
 * centres) the sim-worker FX record carries, so rivals draw theirs too. Read LIVE every tick (trim is being re-fitted).
 */
import { WAKE_RHO, type HydroSample } from './wakeSolverMath';
import { GRAVITY } from '../ocean/oceanMath';

/** depth samples along the hollow (literal record size) and the scan reach in beams */
export const HOLLOW_DEPTHS = 8;
export const HOLLOW_MAX_BEAMS = 8;
/** the pressed width as a share of the max chine beam (the hollow is narrower than the transom's chines) */
export const HOLLOW_WIDTH_SHARE = 0.8;

export interface HollowRecord {
  x: number;
  z: number;
  fwdX: number;
  fwdZ: number;
  /** metres from the transom to where the hollow closes (0 = none) */
  length: number;
  width: number;
  depths: Float64Array;
}

export function createHollowRecord(): HollowRecord {
  return { x: 0, z: 0, fwdX: 0, fwdZ: 1, length: 0, width: 0, depths: new Float64Array(HOLLOW_DEPTHS) };
}

/** measure the hollow from the physics' depth field along her centreline aft of the transom point (world) */
export function measureHollow(depthAt: (x: number, z: number) => number, x: number, z: number, fwdX: number, fwdZ: number, beam: number, out: HollowRecord): HollowRecord {
  const len = Math.hypot(fwdX, fwdZ);
  out.length = 0;
  out.depths.fill(0);
  if (![x, z, fwdX, fwdZ, beam].every(Number.isFinite) || !(len > 1e-6) || !(beam > 0)) return out;
  const fx = fwdX / len;
  const fz = fwdZ / len;
  out.x = x;
  out.z = z;
  out.fwdX = fx;
  out.fwdZ = fz;
  out.width = HOLLOW_WIDTH_SHARE * beam;
  const step = (HOLLOW_MAX_BEAMS * beam) / 64;
  let close = 0;
  for (let k = 1; k <= 64; k++) {
    const d = depthAt(x - fx * k * step, z - fz * k * step);
    if (Number.isFinite(d) && d > 0) close = k * step;
    else if (close > 0) break;
  }
  if (!(close > 0)) return out;
  out.length = close;
  for (let c = 0; c < HOLLOW_DEPTHS; c++) {
    const aft = ((c + 0.5) * close) / HOLLOW_DEPTHS;
    const d = depthAt(x - fx * aft, z - fz * aft);
    out.depths[c] = Number.isFinite(d) && d > 0 ? d : 0;
  }
  return out;
}

/** the hollow as hull-type wake samples appended to `out` (returns how many were added) */
export function hollowSamples(h: Readonly<HollowRecord>, out: HydroSample[]): number {
  if (!(h.length > 0) || !(h.width > 0) || ![h.x, h.z, h.fwdX, h.fwdZ, h.length, h.width].every(Number.isFinite)) return 0;
  const dx = h.length / HOLLOW_DEPTHS;
  let n = 0;
  for (let c = 0; c < HOLLOW_DEPTHS; c++) {
    const dep = h.depths[c];
    if (!(dep > 0) || !Number.isFinite(dep)) continue;
    const aft = (c + 0.5) * dx;
    out.push({ x: h.x - h.fwdX * aft, z: h.z - h.fwdZ * aft, fy: WAKE_RHO * GRAVITY * dep * dx * h.width, footprint: Math.max(0.5 * h.width, dx), depth: 0 });
    n++;
  }
  return n;
}

/**
 * W9 THE ROOSTER HUMP (docs/wake/w9-at-speed-disturbance.md). Where the hollow closes, the flows from both quarters meet
 * and heap ABOVE the undisturbed surface — the transom stern's "rooster tail" crest, measured at roughly the transom
 * draft behind dry transoms at high transom Froude numbers (Maki 2006; Doctors & Day 1997 draw its linear part). The
 * linear solver does not raise it from the hollow alone at planing speed: the free wave it radiates is 2πU²/g ≈ 400 m
 * long at 25 m/s. So the closure gets its own SUCTION: signed (jet-type, `WakeSourceBuffer.pushJet`) samples whose head
 * lifts the drawn surface by HUMP_HEIGHT_SHARE of the hollow's deepest point over ±15 % of the hollow length around the
 * closure. A jet-type sample is not a hull entering water, so the churn foam does not read it (simFoam `hullHead`).
 * LOOK CALIBRATION, stated: the share (a crest below the measured ~1·T, since part of it breaks into the boil drawn
 * by `hullSpray`).
 */
export const HUMP_HEIGHT_SHARE = 0.6;
/**
 * W9 the transom Froude number Fn_T = U/√(g·T) over which the stern goes from a wet, wave-making transom (the solver's
 * own stern wave) to a dry, ventilated one whose hollow closes in a crest: 0 at 3, 1 at 5 (dry transom beyond Fn_T ≈
 * 4–5, Doctors & Day 1997; Maki 2006). Below it the hump and its whitewater are not drawn.
 */
export const HUMP_FROUDE_ON = 3;
export const HUMP_FROUDE_FULL = 5;
/** W9 a hollow shallower than this (m) closes without a crest worth drawing (the record's centimetre-deep slivers at 3 m/s) */
export const HUMP_MIN_DEPTH = 0.02;

/** W9 the dry-transom share at speed U (m/s) over transom immersion T (m): smooth 0 → 1 across HUMP_FROUDE_ON..FULL */
export function dryTransomShare(speed: number, transomDepth: number): number {
  if (!(speed > 0) || !(transomDepth > 0) || !Number.isFinite(speed) || !Number.isFinite(transomDepth)) return 0;
  const fn = speed / Math.sqrt(GRAVITY * transomDepth);
  const x = Math.min(1, Math.max(0, (fn - HUMP_FROUDE_ON) / (HUMP_FROUDE_FULL - HUMP_FROUDE_ON)));
  return x * x * (3 - 2 * x);
}
const HUMP_PROFILE: readonly (readonly [number, number])[] = [[0.85, 0.6], [1, 1], [1.15, 0.6]];

/**
 * the closure hump as signed (negative fy = lift) jet-type samples appended to `out` for a boat at `speed` (m/s, over
 * the water), × `dryTransomShare`; returns how many
 */
export function humpSamples(h: Readonly<HollowRecord>, speed: number, out: HydroSample[]): number {
  if (!(h.length > 0) || !(h.width > 0) || ![h.x, h.z, h.fwdX, h.fwdZ, h.length, h.width].every(Number.isFinite)) return 0;
  let dMax = 0;
  for (let c = 0; c < HOLLOW_DEPTHS; c++) if (Number.isFinite(h.depths[c]) && h.depths[c] > dMax) dMax = h.depths[c];
  const dry = dryTransomShare(speed, h.depths[0]);
  if (!(dMax > HUMP_MIN_DEPTH) || !(dry > 0)) return 0;
  const dx = 0.15 * h.length;
  for (const [at, w] of HUMP_PROFILE) {
    const aft = at * h.length;
    out.push({ x: h.x - h.fwdX * aft, z: h.z - h.fwdZ * aft, fy: -WAKE_RHO * GRAVITY * HUMP_HEIGHT_SHARE * dry * dMax * w * dx * h.width, footprint: Math.max(0.5 * h.width, dx), depth: 0 });
  }
  return HUMP_PROFILE.length;
}
