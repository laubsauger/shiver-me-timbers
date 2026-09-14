/**
 * THE GOVERNOR (design doc §3: a salvaged throttle-governor module, physical OFF · AIR · FULL dial), on the ENGINE'S
 * OWN RPM (§T.207, §V77: one rpm model feeds thrust, Governor and audio — sea-physics/engine.ts via `hw.driveRpm`; the
 * T182 rpm proxy is gone).
 *
 * LAW (AIR and FULL). While the props are OUT — airborne (hull and every gearcase dry), mean prop immersion below
 * `ventImmersion`, or the mean immersion fell by ≥ `collapseDrop` in one tick (a launch: 0.9 → 0.3 → 0 over two ticks,
 * against ≤ 0.1 per tick in calm WOT running) — the throttle is an rpm governor at the rated rpm (6100):
 *   lead = rpm + max(0, Δrpm/dt)·`leadS`  (the highest drive; the rise extrapolated over the throttle body's lag),
 *   throttle ≤ max(`airThrottle`, 1 − `rpmGain`·(lead/rated − 1)).
 * The lead is because a dry prop gains ≈ 26 000 rpm/s while the throttle closes in 0.07 s and the sample is a tick old.
 * WET, NOTHING IS CAPPED, not even over rated: the unassisted hull's calm WOT running point itself ventilates to 6790 rpm
 * (19 000 rpm/s rises), and any wet cut there — 30 ticks in 10 s at 1.12 × rated — cost 6 % top speed through the
 * spool lag (§T.206/§V110: an assist that is slower than an unassisted rival at the running point is a bug).
 * [M] tests/speedboatAssist (4 MW sand-bar harness): 2.5 m bar at C_v 8 — OFF 6837 rpm (limiter), AIR 6178 over the
 * whole flight; C_v 10 1.5 m bar — AIR 6798 at the launch tick (the ventilated face, still wet), 6069–6165 from 0.25 s
 * into the flight (OFF: the limiter). Calm WOT (createRaceControls, CpuOcean calm): Default 33.827 = Pro 33.827 m/s.
 * FULL also caps the throttle for `LANDING_CAP_SECONDS` after an airtime ≥ `LANDING_MIN_AIR`: a prop re-entering at
 * full throttle is the torque spike / bog of tech-research §3.1 and the stuffed landing of design §3.
 */
import type { GovernorMode } from './settings';

export const GOVERNOR = Object.freeze({
  /** the lowest throttle the Governor commands (floor of the rpm cap; above overrunThrottle 0.03, so no fuel cut) */
  airThrottle: 0.05,
  /** throttle cut per unit of rpm/rated over 1, props out */
  rpmGain: 40,
  /** s of rpm rise extrapolated ahead (the throttle body's closing lag): a flaring prop is cut before it arrives */
  leadS: 0.15,
  /** mean prop immersion below which the drives count as out */
  ventImmersion: 0.1,
  /** a one-tick fall of the mean prop immersion at least this large: the props are leaving the water (launch) */
  collapseDrop: 0.25,
});

export const LANDING_MIN_AIR = 0.3;
export const LANDING_CAP_SECONDS = 0.6;
export const LANDING_THROTTLE_CAP = 0.5;

export interface GovernorState {
  /** seconds airborne so far (0 when wet) */
  airTime: number;
  /** seconds left of the FULL landing cap */
  landingCap: number;
  /** the rpm and mean prop immersion the last step read (NaN before the first) */
  lastRpm: number;
  lastImmersion: number;
}

export function createGovernorState(): GovernorState {
  return { airTime: 0, landingCap: 0, lastRpm: Number.NaN, lastImmersion: Number.NaN };
}

/** what the Governor reads of the sim (a BoatSimSample satisfies it) */
export interface GovernorSample {
  airborne: boolean;
  /** mean prop immersion 0..1 */
  propImmersion: number;
  /** highest drive crank rpm (engine model) */
  rpm: number;
  /** the engine's rated crank rpm (0 = unknown: no rpm cap) */
  ratedRpm: number;
}

/**
 * Governor step: returns the throttle to send (same sign as `throttle`) and advances `st` (air timer, landing cap).
 */
export function stepGovernor(
  st: GovernorState,
  mode: GovernorMode,
  throttle: number,
  sim: Readonly<GovernorSample>,
  dt: number,
  params: Readonly<typeof GOVERNOR> = GOVERNOR,
): number {
  let out = throttle;
  if (sim.airborne) {
    st.airTime += dt;
  } else {
    if (st.airTime >= LANDING_MIN_AIR && mode === 'FULL') st.landingCap = LANDING_CAP_SECONDS;
    st.airTime = 0;
  }
  if (mode !== 'OFF') {
    let cap = 1;
    const out_ = sim.airborne || sim.propImmersion < params.ventImmersion || st.lastImmersion - sim.propImmersion >= params.collapseDrop;
    if (out_ && sim.ratedRpm > 0) {
      const rise = Number.isFinite(st.lastRpm) && dt > 0 ? Math.max(0, sim.rpm - st.lastRpm) / dt : 0;
      const lead = sim.rpm + rise * params.leadS;
      if (lead > sim.ratedRpm) cap = Math.max(params.airThrottle, 1 - params.rpmGain * (lead / sim.ratedRpm - 1));
    }
    if (mode === 'FULL' && st.landingCap > 0) {
      cap = Math.min(cap, LANDING_THROTTLE_CAP);
      st.landingCap = Math.max(0, st.landingCap - dt);
    }
    if (Math.abs(out) > cap) out = Math.sign(out) * cap;
  } else {
    st.landingCap = 0;
  }
  st.lastRpm = sim.rpm;
  st.lastImmersion = sim.propImmersion;
  return out;
}
