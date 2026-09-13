/**
 * PROP WASH — the drive's momentum jet as a wake, foam and spray input
 * (§T.180 c, docs/wake/w5b.md §3, wake-research.md §3.4).
 *
 * One `PropWashInput` per prop per tick, read off the drive model that makes the
 * thrust (`HullWater`, §T.179 — `propWashHullWater.propWashFromHullWater`). Three consumers:
 *
 *   SIM SOURCE   `propJetSample`: the jet boils up where its half-width reaches
 *                the surface, s = (d − r)/S aft of the disc (S = JET_SPREAD,
 *                round turbulent jet). The vertical momentum flux it delivers
 *                there is its axial flux T times the spread slope S (the edge
 *                of a jet spreading at db/ds = S carries that share of its
 *                velocity sideways) — pushed UP, so a SIGNED head
 *                fy = −S·T over the jet's width b = max(r, d), at the prop's
 *                depth (the solver's e^(−|k|d) carries it to the surface).
 *                Order-of-magnitude, not calibrated: a moving boil radiates a
 *                stern wave; a boil held at rest is cancelled by §V102 like any
 *                steady source (the drawn surface is η + h) — its visible part
 *                at rest is foam (below), stated.
 *   FOAM         `flowfoam/simFoam.jetFoamRate` — turbulent ribbon aft of the prop.
 *   SPRAY        `foam/roosterTail` — a surface-piercing prop throws a rooster tail.
 *
 * Actuator disc (Rankine–Froude): V_j = √(U_a² + 2T/(ρA)); the jet's excess
 * speed V_j − U_a is what churns. No authored coefficient: the old research
 * plan's C_pw is replaced by the spread slope, a textbook jet constant.
 *
 * §V101 RESIDUE, stated: HullWater publishes the TOTAL thrust and per-drive
 * immersion but not per-drive thrust or prop world position, so the adapter
 * re-places the props (the same yaw-about-pivot the drive model uses) and
 * splits the total by each drive's thrust-curve weight imm^1.5/max(U_a, U_ref).
 * The hook that would retire that: publish `driveThrust[k]` and `propWorld[k·3]`
 * where `evaluateDrives` computes `T` and `R` (hullWater.ts, the thrust block).
 */
import { WAKE_RHO, type HydroSample } from './wakeSolverMath';

/** round turbulent jet half-width growth db/ds (Pope 2000 §5.1: S ≈ 0.094–0.10) */
export const JET_SPREAD = 0.1;
/** potential-core length of a round jet, in diameters (Rajaratnam 1976: ≈ 6 D) */
export const JET_CORE_DIAMETERS = 6;

/**
 * One prop's wash, handed per tick by the vessel that owns the drive.
 */
export interface PropWashInput {
  /** prop position, world (m) */
  x: number;
  z: number;
  /** unit jet direction, world XZ (the way the water leaves: aft along the shaft in forward gear) */
  dirX: number;
  dirZ: number;
  /** thrust magnitude (N, ≥ 0) — already scaled by the prop's own immersion by the drive model */
  thrust: number;
  /** prop disc area (m²) */
  discArea: number;
  /** depth of the prop centre below the local surface (m; ≤ 0 when it is out) */
  depth: number;
  /** advance speed through the water along the shaft (m/s, ≥ 0) */
  advance: number;
  /** 0..1 how much of the disc is in the water (1 = fully immersed, 0 = clear) */
  immersion: number;
  /** world y of the local surface above the prop (m) — where spray leaves (optional for wave/foam consumers) */
  surfaceY?: number;
}

/** actuator-disc jet excess V_j − U_a = √(U_a² + 2T/(ρA)) − U_a (m/s, ≥ 0); 0 for any non-physical input */
export function jetExcessSpeed(advance: number, thrust: number, discArea: number): number {
  if (!Number.isFinite(advance) || !Number.isFinite(thrust) || !Number.isFinite(discArea) || !(discArea > 0) || !(thrust > 0)) return 0;
  const u = Math.abs(advance);
  return Math.sqrt(u * u + (2 * thrust) / (WAKE_RHO * discArea)) - u;
}

/** a jet input is usable: finite, a direction, a disc, thrust */
export function propWashValid(j: PropWashInput): boolean {
  const vals = [j.x, j.z, j.dirX, j.dirZ, j.thrust, j.discArea, j.depth, j.advance, j.immersion];
  return vals.every(Number.isFinite) && Math.hypot(j.dirX, j.dirZ) > 1e-9 && j.discArea > 0;
}

/** the sim source for one jet (header), or null when it pushes nothing */
export function propJetSample(j: PropWashInput, out: HydroSample = { x: 0, z: 0, fy: 0, footprint: 0, depth: 0 }): HydroSample | null {
  if (!propWashValid(j) || !(j.thrust > 0) || !(j.immersion > 0)) return null;
  const r = Math.sqrt(j.discArea / Math.PI);
  const d = Math.max(0, j.depth);
  const len = Math.hypot(j.dirX, j.dirZ);
  const s = Math.max(0, d - r) / JET_SPREAD;
  out.x = j.x + (j.dirX / len) * s;
  out.z = j.z + (j.dirZ / len) * s;
  out.fy = -JET_SPREAD * j.thrust;
  out.footprint = Math.max(r, d);
  out.depth = d;
  return out;
}

