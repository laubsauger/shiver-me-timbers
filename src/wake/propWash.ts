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
import { GRAVITY } from '../ocean/oceanMath';
import { WAKE_RHO, type HydroSample } from './wakeSolverMath';

/** round turbulent jet half-width growth db/ds (Pope 2000 §5.1: S ≈ 0.094–0.10) */
export const JET_SPREAD = 0.1;
/**
 * §T.199 SPREAD RATE OF A JET IN CO-FLOW, db/ds ≈ S·u_s/(u_s + U_c): a turbulent jet's growth is set by its velocity
 * EXCESS over the stream it runs in (the small-deficit wake/jet similarity: momentum flux ∝ U_c·u_s·b² conserved,
 * entrainment velocity ∝ u_s — Pope 2000 §5.5; Rajaratnam 1976 ch. 3 for co-flowing jets), and reduces to S in still
 * water. A prop's slipstream at race speed carries u_s = ΔV ≈ 1–3 m/s in U_a ≈ 25–40 m/s, so it spreads ~15× slower
 * than a static jet: at 50 m astern ±0.5 m, not ±5 m (the flat white band of T199, wider than the V it sat in).
 * The FOAM RIBBON reads it; the sim source (`propJetSample`) keeps the still-water S — STATED RESIDUE (T180's pinned
 * source strength), docs/wake/w7-speedboat-look.md §2.
 */
export function jetSpreadRate(excess: number, advance: number): number {
  const u = Math.max(0, Number.isFinite(excess) ? excess : 0);
  const c = Math.abs(Number.isFinite(advance) ? advance : 0);
  return u + c > 1e-6 ? (JET_SPREAD * u) / (u + c) : JET_SPREAD;
}

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
  /**
   * §T.195 shaft power the prop absorbs but does not turn into thrust power, W (≥ 0): |2π·n·Q| − |T·U_a|
   * (`propLossPower`). What the slipstream dissipates as swirl, turbulence and — for a ventilating prop — air.
   * Optional: absent reads 0 (no aeration), so every pre-§T.195 producer is unchanged.
   */
  lossPower?: number;
  /**
   * §T.195 air a VENTILATING prop draws in, as a speed over its disc (m/s, ≥ 0): χ·P·|n| — the blades sweep the
   * nominal pitch volume A·P·n per second, χ of it through air. χ = 1 − (1 − e)·v(J): e = 4·imm·(1 − imm) the
   * surface-piercing arc (0 buried, 1 half-in), v(J) the engine model's low-advance full-ventilation factor
   * (`engine.ventilationFactor`, 0.55 at the hole shot → 1 above J/(P/D) 0.42). Optional: absent reads 0.
   */
  ventAirSpeed?: number;
  /**
   * §T.199 prop shaft speed, rev/s (signed as the engine reports it) — the blade tip speed 2π·|n|·R that throws a
   * surface-piercing prop's rooster tail (`foam/roosterTail.roosterTailEmission`). Optional: absent, the rooster tail
   * estimates it from the jet (`propRpsEstimate`).
   */
  propRps?: number;
}

/**
 * §T.199 a prop's rev/s when its producer does not publish one: an IDEAL prop's pitch speed n·P equals the fully
 * developed slipstream speed, and actuator-disc momentum puts that at V_j = U_a + ΔV (`jetExcessSpeed`) ⟹
 * n ≈ (U_a + ΔV)/P. STATED approximation (real props slip more than ideal ones, so this reads n a few % low);
 * 0 for any non-physical input.
 */
export function propRpsEstimate(j: Pick<PropWashInput, 'advance' | 'thrust' | 'discArea'>, pitch: number): number {
  if (!Number.isFinite(pitch) || !(pitch > 0)) return 0;
  const n = (Math.abs(j.advance) + jetExcessSpeed(j.advance, j.thrust, j.discArea)) / pitch;
  return Number.isFinite(n) ? n : 0;
}

/** §T.195: the prop's lost power, W — shaft power minus thrust power; 0 for any non-finite or idle-off input */
export function propLossPower(propRps: number, propTorque: number, thrust: number, advance: number): number {
  if (![propRps, propTorque, thrust, advance].every(Number.isFinite)) return 0;
  return Math.max(0, Math.abs(2 * Math.PI * propRps * propTorque) - Math.abs(thrust * advance));
}

/**
 * §T.195 share of a slipstream's dissipated power that goes into entraining air against buoyancy. Lamarre & Melville
 * (1991, Nature 351) measured up to ~50 % of the energy a breaking wave loses spent entraining air; 0.3 is the
 * middle of their range, ASSUMED to carry to a prop's turbulent slipstream (same mechanism: surface-reaching
 * turbulence folding air in).
 */
export const AIR_ENTRAINMENT_EFFICIENCY = 0.3;

/**
 * §T.195 AERATION SPEED of one prop — the entrained air's volume flux over the disc (m/s, ≥ 0):
 *
 *   u_air = η_e · imm · P_loss / (ρ·g·A·D)  +  u_vent          D = 2√(A/π)
 *
 * TURBULENT term: the air volume the lost power can drive one prop diameter down against buoyancy (ρ·g·D per m³),
 * η_e = AIR_ENTRAINMENT_EFFICIENCY; × immersion (a prop clear of the water churns no water). LINEAR in power, so a
 * prop idling in gear boils at (n_idle/n_WOT)³ ≈ 0.1 % of wide open. VENTILATION term: `ventAirSpeed` (the air the
 * blades draw straight in). 0 in neutral, idle-off, or out of the water (no torque, no rpm).
 */
export function aerationSpeed(j: Pick<PropWashInput, 'discArea' | 'immersion' | 'lossPower' | 'ventAirSpeed'>): number {
  if (!Number.isFinite(j.discArea) || !(j.discArea > 0) || !Number.isFinite(j.immersion)) return 0;
  const P = j.lossPower ?? 0;
  const v = j.ventAirSpeed ?? 0;
  const imm = Math.min(1, Math.max(0, j.immersion));
  const D = 2 * Math.sqrt(j.discArea / Math.PI);
  const turb = Number.isFinite(P) && P > 0 ? (AIR_ENTRAINMENT_EFFICIENCY * imm * P) / (WAKE_RHO * GRAVITY * j.discArea * D) : 0;
  const vent = Number.isFinite(v) && v > 0 ? v : 0;
  return turb + vent;
}

/** §T.195 χ·P·|n| (`PropWashInput.ventAirSpeed`): pitch-normalised advance jp = J/(P/D), v = ventilation factor at jp */
export function ventilationAirSpeed(immersion: number, ventFactor: number, pitch: number, propRps: number): number {
  if (![immersion, ventFactor, pitch, propRps].every(Number.isFinite)) return 0;
  const imm = Math.min(1, Math.max(0, immersion));
  const e = 4 * imm * (1 - imm);
  // a prop clear of the water draws no air INTO water
  if (!(imm > 0)) return 0;
  const chi = 1 - (1 - e) * Math.min(1, Math.max(0, ventFactor));
  return Math.max(0, chi) * Math.max(0, pitch) * Math.abs(propRps);
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

