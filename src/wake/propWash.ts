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
   * §T.195 air a VENTILATING prop draws in, as a speed over its disc (m/s, ≥ 0): e·P·|n| — the blades sweep the
   * nominal pitch volume A·P·n per second, the surface-piercing arc e = 4·imm·(1 − imm) of it through air (W8: a
   * buried prop draws no surface air at any J — `ventilationAirSpeed`). Optional: absent reads 0.
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
 * blades draw straight in). EXHAUST term (W8): the through-hub gas the boil does not release, (1 − φ)·Q_ex/A
 * (`exhaustBoil`) — present whenever the engine turns (in neutral too: the gas still leaves through the hub).
 * SLIP term (W8 round 3): the surface air a loaded buried prop draws through its vortices (`slipAirSpeed`).
 * 0 with the engine off and out of the water.
 */
export function aerationSpeed(j: Pick<PropWashInput, 'discArea' | 'immersion' | 'lossPower' | 'ventAirSpeed'> & Partial<Pick<PropWashInput, 'propRps' | 'thrust' | 'advance' | 'depth'>>): number {
  if (!Number.isFinite(j.discArea) || !(j.discArea > 0) || !Number.isFinite(j.immersion)) return 0;
  const P = j.lossPower ?? 0;
  const v = j.ventAirSpeed ?? 0;
  const imm = Math.min(1, Math.max(0, j.immersion));
  const D = 2 * Math.sqrt(j.discArea / Math.PI);
  const turb = Number.isFinite(P) && P > 0 ? (AIR_ENTRAINMENT_EFFICIENCY * imm * P) / (WAKE_RHO * GRAVITY * j.discArea * D) : 0;
  const vent = Number.isFinite(v) && v > 0 ? v : 0;
  // W8: the exhaust gas the plume does not boil out rides the slipstream (`exhaustBoil`)
  const ex = exhaustBoil({ propRps: j.propRps, lossPower: j.lossPower, thrust: j.thrust ?? 0, advance: j.advance ?? 0, depth: j.depth ?? 0, discArea: j.discArea });
  const draw = slipAirSpeed({ propRps: j.propRps, lossPower: j.lossPower, thrust: j.thrust ?? 0, advance: j.advance ?? 0, depth: j.depth ?? 0, discArea: j.discArea, immersion: j.immersion });
  return turb + vent + draw + (imm > 0 ? (ex.flux * (1 - ex.share)) / j.discArea : 0);
}

/**
 * §T.195 / W8 SURFACE AIR a prop draws, e·P·|n| (`PropWashInput.ventAirSpeed`): only the blade arc that pierces the
 * surface, e = 4·imm·(1 − imm), has air to draw. W8 (docs/wake/w8-foam-readability.md §2): the old χ = 1 − (1 − e)·v(J)
 * gave a BURIED prop at low advance (J below the ventilation band) 45 % of its pitch volume in air — 1.4 m/s at idle
 * 0.7 m down, with no air path to it. What a buried through-hub prop ventilates with is its own exhaust gas, which
 * `exhaustGasFlux` counts once. `ventFactor` is kept in the signature (the engine's curve) but a buried prop draws no
 * surface air at any J.
 */
export function ventilationAirSpeed(immersion: number, ventFactor: number, pitch: number, propRps: number): number {
  if (![immersion, ventFactor, pitch, propRps].every(Number.isFinite)) return 0;
  const imm = Math.min(1, Math.max(0, immersion));
  // a prop clear of the water draws no air INTO water
  if (!(imm > 0)) return 0;
  const e = 4 * imm * (1 - imm);
  return e * Math.max(0, pitch) * Math.abs(propRps);
}

/** W8 the fleet engine's swept volume (Mercury Racing 450R: 4.6 L V8, `sea-physics/engine` MERCURY_450R header), m³ */
export const EXHAUST_DISPLACEMENT = 4.6e-3;
/** W8 gearcase reduction and efficiency, and the crank's peak brake torque (N·m) — MERCURY_450R's, restated (propWash reads no spec) */
export const EXHAUST_GEAR = 1.6;
export const EXHAUST_GEAR_EFFICIENCY = 0.95;
export const EXHAUST_PEAK_TORQUE = 439 * 1.3558;
/**
 * W8 manifold pressure over ambient against crank load τ = brake torque / peak: ≈ 0.3 closed-throttle idle (spark-ignition
 * manifold vacuum ~30 kPa) to ≈ 1.5 at full supercharger boost. Linear between (ASSUMED shape; ends are textbook
 * SI-engine values, Heywood 1988 ch. 7).
 */
export const EXHAUST_MAP_IDLE = 0.3;
export const EXHAUST_MAP_PER_LOAD = 1.2;
/** W8 water-injected exhaust gas at ≈ 80 °C: volume over intake (≈ 20 °C) volume, 353/293 */
export const EXHAUST_TEMP_RATIO = 1.2;

/**
 * W8 THROUGH-HUB EXHAUST GAS, m³/s per drive: a four-stroke swallows V_d/2 per crank rev at manifold density, and all of
 * it leaves through the prop hub (water-cooled):
 *
 *   Q_ex = (V_d / 2) · n_crank · MAP(τ) · T_ex/T_in          n_crank = |n_prop| · gear
 *   τ = (P_shaft / (2π·|n_prop|)) / (gear · η_g) / T_peak      P_shaft = P_loss + T·U_a
 *
 * Idle in gear (650 rpm): ≈ 10 L/s. Race load (6000 rpm, boosted): ≈ 0.3–0.5 m³/s. 0 with the engine off (no rev/s) or
 * for a producer that publishes no rev/s (the pre-W8 records). Reads only published jet fields, so rivals get it too.
 */
export function exhaustGasFlux(j: Pick<PropWashInput, 'propRps' | 'lossPower' | 'thrust' | 'advance'>): number {
  const n = Math.abs(j.propRps ?? 0);
  if (!Number.isFinite(n) || !(n > 0)) return 0;
  return (EXHAUST_DISPLACEMENT / 2) * n * EXHAUST_GEAR * (EXHAUST_MAP_IDLE + EXHAUST_MAP_PER_LOAD * engineLoad(j)) * EXHAUST_TEMP_RATIO;
}

/** W8 crank load τ = brake torque / peak (0..1) from the published shaft power (lost + thrust power) and rev/s */
export function engineLoad(j: Pick<PropWashInput, 'propRps' | 'lossPower' | 'thrust' | 'advance'>): number {
  const n = Math.abs(j.propRps ?? 0);
  if (!Number.isFinite(n) || !(n > 0)) return 0;
  const loss = Number.isFinite(j.lossPower) ? Math.max(0, j.lossPower ?? 0) : 0;
  const push = Number.isFinite(j.thrust) && Number.isFinite(j.advance) ? Math.max(0, j.thrust * Math.abs(j.advance)) : 0;
  const crankTorque = (loss + push) / (2 * Math.PI * n) / (EXHAUST_GEAR * EXHAUST_GEAR_EFFICIENCY);
  return Math.min(1, Math.max(0, crankTorque / EXHAUST_PEAK_TORQUE));
}

/** W8 round 3: the fleet prop's nominal pitch (m) — MERCURY_450R's 26 in, restated (propWash reads no spec) */
export const SLIP_PROP_PITCH = 26 * 0.0254;
/**
 * W8 round 3 LOOK CALIBRATION: air a LOADED, BURIED prop draws down from the surface through its tip and hub vortices,
 * per unit of slip·P·|n|·e^(−d/D)·τ. The mechanism is vortex (free-surface) ventilation: a shallow prop (d/D ≲ 2) under
 * high slip pulls surface air and exhaust into its blade vortices (Kozlowska & Steen; Califano & Steen 2011). Sized so
 * a deep-V pushing through the hump (8–20 kn, slip 0.3–0.6, τ 0.2–0.5) lays a moderate churned white wash.
 */
export const SLIP_DRAW_GAIN = 40;
/** W8 round 3 tip-vortex cavitation band: closed above σ = 1, fully open at σ = 0.4 */
export const SLIP_SIGMA_OPEN = 1;
export const SLIP_SIGMA_FULL = 0.4;

/**
 * W8 round 3 SLIP-DRIVEN AIR (m/s over the disc): K·slip·P·|n|·e^(−d/D)·τ·(1 − e)·open(σ_tip), slip = 1 − U_a/(P·|n|), e the
 * surface-piercing arc. (1 − e): a prop already piercing the surface is air-filled on its suction side and counted by
 * `ventAirSpeed`. Idle (τ ≈ 0) and planing (e ≈ 1) draw ~nothing; the hump draws most. 0 with no rev/s.
 */
export function slipAirSpeed(j: Pick<PropWashInput, 'propRps' | 'lossPower' | 'thrust' | 'advance' | 'depth' | 'discArea' | 'immersion'>): number {
  const n = Math.abs(j.propRps ?? 0);
  if (!Number.isFinite(n) || !(n > 0) || !Number.isFinite(j.discArea) || !(j.discArea > 0) || !Number.isFinite(j.immersion)) return 0;
  const pn = SLIP_PROP_PITCH * n;
  const slip = Math.max(0, 1 - Math.abs(Number.isFinite(j.advance) ? j.advance : 0) / pn);
  const D = 2 * Math.sqrt(j.discArea / Math.PI);
  const d = Math.max(0, Number.isFinite(j.depth) ? j.depth : 0);
  const imm = Math.min(1, Math.max(0, j.immersion));
  if (!(imm > 0)) return 0;
  const e = 4 * imm * (1 - imm);
  // the tip vortex only opens a path for air once its core cavitates: tip cavitation number σ = (p_a + ρgd)/(½ρV_tip²)
  // below the inception band (≈ 1 → 0.4, the order of tip-vortex σ_i for loaded props) — an idling prop's vortex is shut
  const vTip = Math.PI * n * D;
  const sigma = (101325 + WAKE_RHO * GRAVITY * d) / (0.5 * WAKE_RHO * vTip * vTip);
  const x = Math.min(1, Math.max(0, (SLIP_SIGMA_OPEN - sigma) / (SLIP_SIGMA_OPEN - SLIP_SIGMA_FULL)));
  const open = x * x * (3 - 2 * x);
  const u = SLIP_DRAW_GAIN * slip * pn * Math.exp(-d / D) * engineLoad(j) * (1 - e) * open;
  return Number.isFinite(u) ? u : 0;
}

/** W8 rise speed of the exhaust's large bubbles (m/s): 1–10 mm air bubbles in water rise at 0.22–0.3 (Clift, Grace & Weber 1978) */
export const EXHAUST_RISE = 0.3;
/** W8 bubble-plume spread per metre of path (half-width growth; entrainment α ≈ 0.1, Milgram 1983) */
export const EXHAUST_PLUME_SPREAD = 0.1;

/**
 * W8 WHERE THE EXHAUST BOILS. Gas leaves the hub d below the surface, rises at w = EXHAUST_RISE while the water carries
 * it aft at U_a: it surfaces at s = d·U_a/w aft of the prop, spread over σ = r + d + S_p·d·√(1 + (U_a/w)²) — the disc, the
 * radial surface outflow a surfacing bubble plume drives (it reaches about the source depth out, Milgram & Van Houten
 * 1982) and the plume's own growth along its slanted path. The share that
 * rises out as a BOIL rather than being shredded into the slipstream is φ = w/(w + U_a) (the plume's rise against its
 * advection): ≈ 0.23 at 1 m/s, 0.06 at 5 m/s, 0.01 at race speed — visible at idle, swallowed by the wash at speed.
 * The remaining (1 − φ)·Q_ex is slipstream air (`aerationSpeed`).
 */
export function exhaustBoil(j: Pick<PropWashInput, 'propRps' | 'lossPower' | 'thrust' | 'advance' | 'depth' | 'discArea'>): { flux: number; share: number; along: number; sigma: number } {
  const q = exhaustGasFlux(j);
  const u = Math.abs(Number.isFinite(j.advance) ? j.advance : 0);
  const d = Math.max(0, Number.isFinite(j.depth) ? j.depth : 0);
  const r = Number.isFinite(j.discArea) && j.discArea > 0 ? Math.sqrt(j.discArea / Math.PI) : 0;
  const share = EXHAUST_RISE / (EXHAUST_RISE + u);
  return { flux: q, share, along: (d * u) / EXHAUST_RISE, sigma: r + d + EXHAUST_PLUME_SPREAD * d * Math.hypot(1, u / EXHAUST_RISE) };
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

