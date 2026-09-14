/**
 * THE GOVERNOR (design doc §3: a salvaged throttle-governor module, physical OFF · AIR · FULL dial) and the rpm
 * PROXY it protects.
 *
 * RPM PROXY. HullWater has no engine yet (its thrust curve is TEMPORARY, physics-log T179), so the over-rev the
 * Governor exists to prevent is modelled here, normalised: ρ = n / n_rated, 1 = full throttle with the props
 * buried (measured: `driveImmersion` is 1.000 in straight running at every C_v 0–10 on this hull). Prop torque
 * follows tech-research §3.1, Q_p ∝ n²·(0.12 + 0.88·s) with s the prop immersion, engine torque ∝ throttle:
 *     τ·dρ/dt = |throttle| − (0.12 + 0.88·s)·ρ²,   steady ρ = √(|throttle| / (0.12 + 0.88·s))
 * so a prop lifted clear at full throttle heads for √(1/0.12) = 2.9× rated and sits on the rev limiter instead.
 * τ (spool) 0.25 s and the limiter at 1.15 are ASSUMED (tech-research §3.1 names a limiter, no value).
 * When the drive model lands (S2 drive.ts / engine), its rpm replaces this proxy and the law below reads that.
 *
 * LAW. AIR and FULL cap the throttle at the value whose STEADY rpm at the current immersion is rated:
 *     cap(s) = ρ_cap²·(0.12 + 0.88·s),  ρ_cap = 1
 * — no effect with the props buried (cap = 1), feathering to 0.12 with them dry. Feed-forward from the published
 * immersion, so it acts on the tick the props leave the water, before the rpm has flared.
 * FULL also caps the throttle for `LANDING_CAP_SECONDS` after an airtime ≥ `LANDING_MIN_AIR`: a prop re-entering
 * at full throttle is the torque spike / bog of §3.1 and the stuffed landing of design §3.
 */
import type { GovernorMode } from './settings';

export const RPM_PROXY = Object.freeze({
  dryLoad: 0.12,
  spoolTau: 0.25,
  limiter: 1.15,
  idleThrottle: 0.02,
});

/**
 * below this mean prop immersion the drive is OUT of the water: the Governor feathers. T206 (user: "everyone flies by
 * me"): at 0.45 the planing props' normal dips (calm, full throttle: s 0.2–0.45 on ~10% of ticks, never < 0.2) cut the
 * throttle to ~0.5 for a few ticks, and the engine's spool lag turned 3.9% capped ticks into −1.1 m/s (33.2 → 32.1 m/s)
 * against the rivals, whose pilot feathers only below 0.05. At 0.1 calm planing is never capped (33.18 vs raw 33.21).
 */
export const VENT_IMMERSION = 0.1;
export const LANDING_MIN_AIR = 0.3;
export const LANDING_CAP_SECONDS = 0.6;
export const LANDING_THROTTLE_CAP = 0.5;

export interface GovernorState {
  /** normalised rpm proxy ρ */
  rpm: number;
  /** seconds airborne so far (0 when wet) */
  airTime: number;
  /** seconds left of the FULL landing cap */
  landingCap: number;
}

export function createGovernorState(): GovernorState {
  return { rpm: RPM_PROXY.idleThrottle, airTime: 0, landingCap: 0 };
}

/** prop load factor at immersion s ∈ [0, 1] */
export function propLoad(s: number): number {
  const c = s < 0 ? 0 : s > 1 ? 1 : s;
  return RPM_PROXY.dryLoad + (1 - RPM_PROXY.dryLoad) * c;
}

/** advance the rpm proxy one step (semi-implicit in the quadratic load, unconditionally stable) */
export function stepRpmProxy(rpm: number, throttle: number, immersion: number, dt: number): number {
  const drive = Math.max(RPM_PROXY.idleThrottle, Math.abs(throttle));
  const L = propLoad(immersion);
  const k = dt / RPM_PROXY.spoolTau;
  // τ(ρ' − ρ)/dt = drive − L·ρ·ρ'  ⟹  ρ' = (ρ + k·drive) / (1 + k·L·ρ)
  const next = (rpm + k * drive) / (1 + k * L * rpm);
  return next > RPM_PROXY.limiter ? RPM_PROXY.limiter : next;
}

/**
 * Governor step: returns the throttle to send (same sign as `throttle`) and advances `st` (air timer, landing cap,
 * rpm proxy on the governed throttle).
 */
export function stepGovernor(
  st: GovernorState,
  mode: GovernorMode,
  throttle: number,
  airborne: boolean,
  immersion: number,
  dt: number,
): number {
  let out = throttle;
  if (airborne) {
    st.airTime += dt;
  } else {
    if (st.airTime >= LANDING_MIN_AIR && mode === 'FULL') st.landingCap = LANDING_CAP_SECONDS;
    st.airTime = 0;
  }
  if (mode !== 'OFF') {
    // Feather only a prop that is actually OUT (s below VENT_IMMERSION). §T.196 made s ≈ 0.6–0.7 the normal planing
    // point of the surface-piercing drives, dipping to 0.2; capping there made the assisted player slower than the
    // unassisted rivals (§V110, T206).
    const s = airborne ? 0 : immersion;
    let cap = s < VENT_IMMERSION ? propLoad(s) : 1;
    if (mode === 'FULL' && st.landingCap > 0) {
      cap = Math.min(cap, LANDING_THROTTLE_CAP);
      st.landingCap = Math.max(0, st.landingCap - dt);
    }
    if (Math.abs(out) > cap) out = Math.sign(out) * cap;
  } else {
    st.landingCap = 0;
  }
  st.rpm = stepRpmProxy(st.rpm, out, airborne ? 0 : immersion, dt);
  return out;
}
