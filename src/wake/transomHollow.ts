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
