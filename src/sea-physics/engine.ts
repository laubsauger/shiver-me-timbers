/**
 * §T.189 ENGINE + PROPELLER — one outboard (crank, gearcase, surface-piercing prop), pure and deterministic.
 *
 * The ONE rpm model (V77): thrust, the Governor and the engine voice all read `EngineState.rpm`. Built on the
 * audio crank ODE (src/audio/boat/rpmModel.ts, §T.183) — same torque-curve shape, friction/pumping law, throttle
 * lag, idle-air controller, hard limiter with hysteresis and two-cycle minimum cut, overrun fuel cut and the
 * windmilling bound — with the prop replaced by a K_T/K_Q open-water model so that THRUST comes out of the same
 * balance as rpm (no constant-power stand-in).
 *
 *   I·dω/dt = k·[(Q_b(rpm) + Q_f(rpm, 1))·φ·fuel − Q_f(rpm, φ)] − Q_p/(G·η_g)      (crank-referred)
 *   φ       = max(throttleLagged^1.6, idleAir)
 *   Q_p     = k·K_Q·ρ·n²·D⁵,   T = k·K_T·ρ·n²·D⁴,   J = V_a/(n·D),   n = ω/(2π·G)   (prop rev/s)
 *   K_Q     = kqMax·v(J)·(a + (1 − a)·s^1.5)·(1 − (J/J_Q0)²),   J_Q0 = kqZeroJFactor·P/D
 *   K_T     = ktMax·v(J)·s^1.5·(1 − (J/J_T0)²),                  J_T0 = ktZeroJFactor·P/D
 * Q_b is the crank BRAKE torque at wide-open throttle (friction already out, as a dyno measures it), so k = 1 at
 * WOT gives exactly Q_b; closed throttle gives −Q_f (friction + pumping, engine braking). s = hullWater
 * `driveImmersion`, a = airFloor, v = low-J full-ventilation factor, k = `powerScale`.
 *
 * PROP MODEL (source: Kim & Rhee, "Model tests of surface piercing propellers in open-water conditions",
 * smp'24 Berlin, DOI 10.15480/882.9329, https://www.marinepropulsors.com/proceedings/2024/5-b-3.pdf — Modified
 * Model-841-B, 4 blades, P/D 1.0 and 1.2, I_T 0.3/0.5/0.7, Fr 2 and 3.5; values read off Figs 7, 12):
 *  - shape: a parabola in J through the measured K_T/K_Q plateau (partially ventilated regime). P/D 1.2, I_T 0.7:
 *    K_T 0.18 at J 0.5 falling to 0.02 at J 1.2 ⟹ zero thrust at J ≈ 1.28 = 1.07·P/D; 10K_Q 0.35 at J 0.6, 0.17 at
 *    J 1.2 ⟹ zero torque at J ≈ 1.55 = 1.29·P/D. The zero points are carried to the racing prop's P/D in PITCH-
 *    NORMALISED advance J/(P/D) (= 1 − nominal slip): zero thrust at −7 % nominal slip, which is also what a
 *    cupped cleaver shows at full scale (MTI 340X, 15×35 CNC Cleaver, 1.60:1, 128 mph ⟹ ~3 % apparent slip at
 *    6400 rpm; Boating Mag, https://www.boatingmag.com/escalating-mercury-racing-performance/).
 *  - immersion: K_T and K_Q both ∝ I_T^1.5 within ±10 % over I_T 0.3–0.7 (K_T 0.055/0.12/0.18, 10K_Q 0.10/0.23/0.35
 *    ⟹ ÷ I_T^1.5 = 0.34/0.34/0.31 and 0.61/0.65/0.60); efficiency nearly independent of I_T (Fig 12). DEVIATION
 *    from tech-research §3.1, which had torque LINEAR in s: the measured torque follows the thrust law. The
 *    hullWater immersion s is smoothstep(I_T) and is used as I_T directly (|s − I_T| ≤ 0.1). airFloor 0.12 of the
 *    wet torque is kept for a dry prop (spray/foam windage; tech-research §3.1, ASSUMED there).
 *  - full ventilation at low J (Fig 7/12: K_T and K_Q at J = 0.1 are 0.5–0.67 of the plateau; the cavity collapses
 *    by J ≈ 0.4–0.5 at P/D 1.2): v rises from ventMin 0.55 at J/(P/D) ≤ 0.12 to 1 at ≥ 0.42 (smoothstep; the
 *    measured non-monotone dip at J 0.2 is smoothed out). This is why a racing prop spins up at the hole shot.
 *  - magnitudes: kqMax from the torque balance at the CALIBRATION point (below); ktMax from the open-water
 *    efficiency there, calEta0 0.57 = Kim & Rhee Fig 12 at the same J/(P/D) ≈ 0.9 (I_T 0.5–0.7: 0.55–0.59).
 *  - windmilling: (n² − n_v²) is bounded below by −0.6·n_v² (rpmModel's bound, ASSUMED); the reflected torque
 *    uses /η_g when the prop loads the engine and ×η_g when the water drives it.
 *  - reverse gear (throttle < 0): the prop turns the other way; the drive's `advance` is unsigned, so astern it is
 *    NOT credited as unloading (J = 0 quadrant) and thrust is × reverseThrustFactor 0.5 (ASSUMED: a prop run astern
 *    with its blade sections backwards; no cited number for cleavers).
 *
 * ENGINE (Mercury Racing 450R, Sport Master gearcase): 450 prop-shaft hp, 439 lb-ft, 4.6 L supercharged V8, WOT
 * range 5800–6400 rpm, 1.60:1 on BOTH gearcases, 20/25/30 in shafts, Sport Master requires MAX5 or Outboard CNC
 * Cleaver props (Boating Mag 450R review, https://boatingmag.com/mercury-racing-450r-outboard-review/ and
 * https://boatingmag.com/crank-up-performance-volume/). rpmModel's 1.75:1 is the 400R/Verado ratio (Boating Mag
 * Nor-Tech 390 test with 400Rs lists 1.75:1, https://boatingmag.com/nor-tech-390-sport-boat-test/) — not the 450R.
 *
 * CALIBRATION (target top speed): closest real boats to 12 m / 5.35 t / 24° / 3×450R —
 *   Nor-Tech 390 Sport, 39 ft, 10 ft beam, 24°, 11,500–12,500 lb, triple 450R: 87 mph smooth water
 *     (YachtWorld "Nor-Tech 390 Sport – Speed Rules!", https://www.yachtworld.com/research/nor-tech-390-sport-speed-rules/;
 *      deadrise/displacement: https://boatingmag.com/nor-tech-390-sport-boat-test/); same hull, triple 400R: "breaking 80 mph".
 *   Mystic M4200, 42'10", 24°, ~15,000 lb: triple 450R "mid-80-mph" (https://www.speedonthewater.com/mystic-building-first-mercury-racing-450r-powered-m3800-center-console/);
 *     quad 450R, 15×25 MAX5, 1.60:1: 86 mph (https://boatingmag.com/boats/2022-mystic-m4200/).
 *   Formula 380 SSC, 38 ft, >21,200 lb crossover, triple 450R: 64–65.5 mph at 5900–6400 rpm (heavy bound;
 *     https://speedonthewater.com/new-formula-380-ssc-with-triple-mercury-racing-450r-engines-impresses/).
 * ⟹ target 85 mph (38.0 m/s) ± 5 %. Prop: 15.25 in × 26 in five-blade (MAX5/CNC Cleaver class; the M4200's 15×25 MAX5
 * runs 86 mph at 6–9 % slip, CNC Cleaver diameters 14.63–15.25 in, https://www.mercuryracing.com/propellers-overview/300hp-5-blade-cnc-cleaver.html;
 * 26 in pitch ASSUMED one size up for the lighter boat). Balance at 85 mph, 6100 rpm (mid WOT range), buried prop
 * (hullWater measures `driveImmersion` 1.000 in straight running, docs/speedboat/controls.md) ⟹ slip 9.5 %.
 *
 * INTEGRATION: semi-implicit in the prop load (n² → n·n'), explicit in engine torque, sub-stepped at ≤ 1/480 s. The
 * ODE itself is stable at 1/120 s (load time constant I/(dQ/dω) ≈ 0.1 s); the sub-step is for the LIMITER, whose
 * 320 rpm band is crossed in ~15 ms by a dry prop — and it makes 1/120 and 1/240 s callers step the same 1/480 s
 * trajectory. Outputs (thrust, propTorque, shaftAccelTorque) are means over the sub-steps (impulse-consistent).
 * Allocation-free, no module-level mutable state.
 */

export interface EngineSpec {
  /** rated prop-shaft power, W, at `ratedRpm` (crank) */
  ratedPowerW: number;
  ratedRpm: number;
  /** manufacturer's wide-open-throttle crank rpm window */
  wotRpmMin: number;
  wotRpmMax: number;
  /** crank BRAKE torque at WOT: peak, where, parabola half-width, floor as a fraction of peak */
  peakTorqueNm: number;
  peakTorqueRpm: number;
  torqueSpreadRpm: number;
  torqueFloorFrac: number;
  /** friction + supercharger drive: f0·min(1, 4k) + f1·k + f2·k², k = rpm/1000, N·m */
  friction0: number;
  friction1: number;
  friction2: number;
  /** closed-throttle pumping loss at ≥ 3000 rpm, N·m */
  pumpingNm: number;
  /** all rotating parts (crank, supercharger, gearcase, prop) reflected to the crank, kg·m² */
  inertia: number;
  /** throttle body / manifold fill lag (lever → effective opening), s */
  throttleTauUp: number;
  throttleTauDown: number;
  throttleExponent: number;
  /** idle air: base opening + P gain on the rpm error fraction, capped */
  idleRpm: number;
  idleBase: number;
  idleKp: number;
  idleMax: number;
  /** hard fuel-cut limiter and its re-fire band, crank rpm */
  limitRpm: number;
  limitHystRpm: number;
  /** overrun fuel cut: lagged throttle below this with rpm above `overrunRpm` */
  overrunThrottle: number;
  overrunRpm: number;
  /** crank : prop reduction and gearcase mechanical efficiency */
  gear: number;
  gearEfficiency: number;
  /** prop diameter and nominal pitch, m */
  propDiameter: number;
  propPitch: number;
  /** K_T, K_Q parabola heights at J = 0, fully immersed and fully wetted (solved by `calibrateProp`) */
  ktMax: number;
  kqMax: number;
  /** zero thrust / zero torque advance ratio as a multiple of P/D */
  ktZeroJFactor: number;
  kqZeroJFactor: number;
  /** full-ventilation factor at low pitch-normalised advance J/(P/D): ventMin below ventJStart, 1 above ventJEnd */
  ventMin: number;
  ventJStart: number;
  ventJEnd: number;
  /** windmilling: (n² − n_v²) ≥ −windmillBound·n_v² */
  windmillBound: number;
  /** K_T, K_Q ∝ s^immersionExponent */
  immersionExponent: number;
  /** fraction of the wet torque a dry prop keeps */
  airFloor: number;
  /** astern thrust as a fraction of the ahead law */
  reverseThrustFactor: number;
  /** largest SURGE boost (charge-pressure torque factor, see EngineInput.boost) the engine accepts */
  boostMax: number;
  /** kg/m³ */
  waterDensity: number;
  /** CALIBRATION: at this advance (m/s), crank rpm, immersion, WOT is in torque balance with open-water η0 = calEta0 */
  calSpeed: number;
  calRpm: number;
  calImmersion: number;
  calEta0: number;
}

const MPH = 0.44704;
const INCH = 0.0254;

/** internal sub-step ceiling, s (limiter resolution; see header) */
export const MAX_ENGINE_SUBSTEP = 1 / 480;

/** crank brake torque at wide-open throttle, N·m */
export function brakeTorque(spec: Readonly<EngineSpec>, rpm: number): number {
  const u = (Math.max(0, rpm) - spec.peakTorqueRpm) / spec.torqueSpreadRpm;
  return spec.peakTorqueNm * Math.max(spec.torqueFloorFrac, 1 - u * u);
}

/** friction + pumping at crank rpm and effective throttle opening φ, N·m (rpmModel.ts law) */
export function frictionTorque(spec: Readonly<EngineSpec>, rpm: number, thrEff: number): number {
  const k = Math.max(0, rpm) / 1000;
  const pump = spec.pumpingNm * (1 - thrEff) * Math.min(1, k / 3);
  return spec.friction0 * Math.min(1, k * 4) + spec.friction1 * k + spec.friction2 * k * k + pump;
}

/** low-J full-ventilation factor at pitch-normalised advance j = J/(P/D) */
export function ventilationFactor(spec: Readonly<EngineSpec>, j: number): number {
  let x = (j - spec.ventJStart) / (spec.ventJEnd - spec.ventJStart);
  x = x < 0 ? 0 : x > 1 ? 1 : x;
  return spec.ventMin + (1 - spec.ventMin) * x * x * (3 - 2 * x);
}

/**
 * Solve ktMax/kqMax from the calibration point: WOT brake torque × G × η_g = prop torque at (calSpeed, calRpm,
 * calImmersion), and K_T from η0 = J·K_T/(2π·K_Q) = calEta0. Returns a new spec; the input is not mutated.
 */
export function calibrateProp(spec: Readonly<EngineSpec>): EngineSpec {
  const G = spec.gear;
  const D = spec.propDiameter;
  const pd = spec.propPitch / D;
  const n = spec.calRpm / 60 / G;
  const J = spec.calSpeed / (n * D);
  const v = ventilationFactor(spec, J / pd);
  const gT = Math.pow(Math.min(1, Math.max(0, spec.calImmersion)), spec.immersionExponent);
  const gQ = spec.airFloor + (1 - spec.airFloor) * gT;
  const qProp = brakeTorque(spec, spec.calRpm) * G * spec.gearEfficiency;
  const kq = qProp / (spec.waterDensity * n * n * Math.pow(D, 5));
  const kt = (spec.calEta0 * 2 * Math.PI * kq) / J;
  const jq = J / (spec.kqZeroJFactor * pd);
  const jt = J / (spec.ktZeroJFactor * pd);
  return {
    ...spec,
    kqMax: kq / (v * gQ * (1 - jq * jq)),
    ktMax: kt / (v * gT * (1 - jt * jt)),
  };
}

/** Mercury Racing 450R + Sport Master 1.60:1 + 15.25 × 26 in five-blade surface-piercing prop (sources in header) */
export const MERCURY_450R: Readonly<EngineSpec> = Object.freeze(
  calibrateProp({
    ratedPowerW: 450 * 745.7, // 450 prop-shaft hp (Boating Mag 450R review)
    ratedRpm: 6100, // mid WOT range 5800–6400 (ASSUMED: rating point not published)
    wotRpmMin: 5800,
    wotRpmMax: 6400,
    peakTorqueNm: 439 * 1.3558, // 439 lb-ft = 595 N·m, taken as crank brake torque (Boating Mag)
    peakTorqueRpm: 4600, // rpmModel, ASSUMED (not published)
    // spread solved so that brake torque · G · η_g · ω = 450 hp at 6100 rpm: 553 N·m = 0.93 of peak (a flat
    // positive-displacement-supercharger curve)
    torqueSpreadRpm: 5660,
    torqueFloorFrac: 0.35, // rpmModel
    friction0: 12, // rpmModel: ≈ 2.5 bar FMEP at 6000 rpm on 4.6 L incl. supercharger drive
    friction1: 6,
    friction2: 1.1,
    pumpingNm: 42,
    inertia: 0.2, // rpmModel, ASSUMED (crank+flywheel ≈ 0.12, supercharger rotors ≈ 0.02, prop 13 kg SS / G² ≈ 0.035)
    throttleTauUp: 0.12, // rpmModel, ASSUMED (drive-by-wire throttle body + manifold fill; a belt-driven twin-screw has no turbo lag)
    throttleTauDown: 0.07,
    throttleExponent: 1.6,
    idleRpm: 650, // rpmModel
    idleBase: 0.07,
    idleKp: 2.2,
    idleMax: 0.25,
    limitRpm: 6800, // rpmModel, ASSUMED (no published 450R limiter value; 400 rpm above the WOT window)
    limitHystRpm: 320,
    overrunThrottle: 0.03,
    overrunRpm: 1900,
    gear: 1.6, // Boating Mag: 1.60:1 Sport Master and 5.44 HD
    gearEfficiency: 0.95, // ASSUMED (right-angle bevel pair + seals); prop-shaft hp is net of it
    propDiameter: 15.25 * INCH,
    propPitch: 26 * INCH,
    ktMax: 0, // solved below
    kqMax: 0,
    ktZeroJFactor: 1.07, // Kim & Rhee 2024 Fig 12
    kqZeroJFactor: 1.29,
    ventMin: 0.55, // Kim & Rhee 2024 Figs 7, 12 (J = 0.1)
    ventJStart: 0.12,
    ventJEnd: 0.42,
    windmillBound: 0.6, // rpmModel, ASSUMED
    immersionExponent: 1.5, // Kim & Rhee 2024 Fig 12 fit
    // T189: ρ_air/ρ_water. The 0.12 of tech-research §3.1 / rpmModel was a flare-rate heuristic; as a TORQUE on the
    // hull it made a prop in pure air roll the boat (≈ 190 N·m net on the triple rig, ~6°/s per second of flight).
    // Partial immersion (spray, the ventilated band) is the immersion^1.5 law's job, not the floor's.
    airFloor: 1.225 / 1025,
    reverseThrustFactor: 0.5, // ASSUMED
    boostMax: 1.3, // T196: race Surge range (game design), not a 450R figure
    waterDensity: 1025,
    calSpeed: 85 * MPH, // target top speed (header table)
    calRpm: 6100,
    calImmersion: 0.6, // T196: the running immersion at planing speed in the transom wake (hullWater transomWake, measured s 0.61 at C_v 8 with the drives at keel height) — was 1 (buried), which the props never are at speed
    calEta0: 0.57, // Kim & Rhee 2024 Fig 12 at J/(P/D) ≈ 0.9
  }),
);

export interface EngineState {
  /** crank rpm */
  rpm: number;
  /** lagged |throttle| 0..1 */
  throttle: number;
  limiterCut: boolean;
  overrun: boolean;
  cutTime: number;
  /** outputs of the last step (means over its internal sub-steps) */
  /** N along the drive line, SIGNED (reverse < 0); already × any immersion loss */
  thrust: number;
  /** N·m the water exerts on the prop about the prop shaft (reaction on the hull), signed by shaft rotation sense
   *  (+ = right-hand prop in forward gear); positive while the prop absorbs torque */
  propTorque: number;
  /** N·m = I_rot·dω/dt reflected to the prop shaft, same sign convention */
  shaftAccelTorque: number;
  /** prop rev/s, signed by rotation sense */
  propRps: number;
  /** nominal slip 1 − V_a/(P·n); 1 when the prop is (nearly) stopped */
  slip: number;
  /** J = V_a/(n·D); 0 when the prop is (nearly) stopped */
  advanceRatio: number;
}

export interface EngineInput {
  /** −0.3..1; negative = reverse gear */
  throttle: number;
  /** m/s along the drive line (hullWater `driveAdvance[k]`) */
  advance: number;
  /** 0..1 (hullWater `driveImmersion[k]`) */
  immersion: number;
  /** Governor cap, crank rpm (acts as the limiter's cut point) */
  rpmLimit?: number;
  /**
   * SURGE BOOST (T196; the race's Surge `thrustMultiplier` enters here, never as a thrust multiplier): ≥ 1, clamped to
   * `spec.boostMax`. Framed as extra charge pressure plus a Governor over-rev allowance: the crank BRAKE torque at every
   * throttle is × boost and the limiter / Governor cut point is × √boost. Thrust then comes out of the same prop balance
   * — at a given advance the loaded prop's torque and thrust both go as n², so the torque × boost settles at n² × boost,
   * i.e. ≤ √boost × rpm (the headroom the over-rev allowance gives) and ≥ boost × thrust (the faster prop runs at a lower J
   * where K_T and K_Q are higher: measured thrust × 1.30, rpm × 1.04 for boost 1.2 at 85 mph). 1 (or absent)
   * = the stock engine, bit-identical.
   */
  boost?: number;
  /** k: scales engine torque, friction, inertia AND prop K_T/K_Q, so rpm is unchanged and thrust/power scale by k */
  powerScale?: number;
  /** gearcase in NEUTRAL: the prop is decoupled (no thrust, no prop torque); the crank train still spins (T189: the
   *  hull maps a centred lever, throttle exactly 0, to neutral — a single-lever binnacle's centre detent) */
  neutral?: boolean;
}

export function createEngineState(spec: Readonly<EngineSpec>): EngineState {
  const st: EngineState = {
    rpm: 0,
    throttle: 0,
    limiterCut: false,
    overrun: false,
    cutTime: 0,
    thrust: 0,
    propTorque: 0,
    shaftAccelTorque: 0,
    propRps: 0,
    slip: 1,
    advanceRatio: 0,
  };
  resetEngineState(st, spec);
  return st;
}

/** idling in forward gear, at rest */
export function resetEngineState(st: EngineState, spec: Readonly<EngineSpec>): void {
  st.rpm = spec.idleRpm;
  st.throttle = 0;
  st.limiterCut = false;
  st.overrun = false;
  st.cutTime = 0;
  st.thrust = 0;
  st.propTorque = 0;
  st.shaftAccelTorque = 0;
  st.propRps = spec.idleRpm / 60 / spec.gear;
  st.slip = 1;
  st.advanceRatio = 0;
}

const TWO_PI = 2 * Math.PI;

/** advance one engine by dt seconds (sub-stepped internally at ≤ MAX_ENGINE_SUBSTEP); mutates `st` */
export function stepEngine(st: EngineState, spec: Readonly<EngineSpec>, input: Readonly<EngineInput>, dt: number): void {
  const total = Number.isFinite(dt) ? Math.min(0.1, Math.max(0, dt)) : 0;
  if (total <= 0) return;
  const steps = Math.max(1, Math.ceil(total / MAX_ENGINE_SUBSTEP - 1e-9));
  const h = total / steps;

  const thrRaw = Number.isFinite(input.throttle) ? input.throttle : 0;
  const reverse = thrRaw < 0;
  const dir = reverse ? -1 : 1;
  const thrIn = Math.min(1, Math.abs(thrRaw));
  const advIn = Number.isFinite(input.advance) ? Math.min(80, Math.max(0, input.advance)) : 0;
  const imm = Number.isFinite(input.immersion) ? Math.min(1, Math.max(0, input.immersion)) : 1;
  const ps = input.powerScale;
  const k = ps !== undefined && Number.isFinite(ps) && ps > 0 ? ps : 1;
  const cap = input.rpmLimit;
  const bIn = input.boost;
  const boost = bIn !== undefined && Number.isFinite(bIn) && bIn > 1 ? Math.min(bIn, Math.max(1, spec.boostMax)) : 1;
  const limitStock = cap !== undefined && Number.isFinite(cap) && cap > 0 ? Math.min(spec.limitRpm, cap) : spec.limitRpm;
  const limit = boost === 1 ? limitStock : limitStock * Math.sqrt(boost);

  const G = spec.gear;
  const eta = spec.gearEfficiency;
  const D = spec.propDiameter;
  const pd = spec.propPitch / D;
  const rho = spec.waterDensity;
  const I = spec.inertia * k;
  const c = TWO_PI * G; // ω_crank = c·n
  const gT = Math.pow(imm, spec.immersionExponent);
  const gQ = spec.airFloor + (1 - spec.airFloor) * gT;
  // astern the unsigned advance is not credited as unloading the prop (header)
  const adv = reverse ? 0 : advIn;
  const nvQ = adv / (spec.kqZeroJFactor * spec.propPitch);
  const nvT = adv / (spec.ktZeroJFactor * spec.propPitch);
  const nvQ2 = nvQ * nvQ;
  const nvT2 = nvT * nvT;
  const coupled = input.neutral === true ? 0 : 1;
  const kQ = coupled * k * spec.kqMax * rho * Math.pow(D, 5) * gQ;
  const kT = coupled * k * spec.ktMax * rho * D * D * D * D * gT * (reverse ? spec.reverseThrustFactor : 1);
  const aUp = 1 - Math.exp(-h / Math.max(1e-3, spec.throttleTauUp));
  const aDown = 1 - Math.exp(-h / Math.max(1e-3, spec.throttleTauDown));
  const rpmToOmega = TWO_PI / 60;

  let sumT = 0;
  let sumQ = 0;
  const omega0 = st.rpm * rpmToOmega;

  for (let i = 0; i < steps; i++) {
    st.throttle += (thrIn - st.throttle) * (thrIn > st.throttle ? aUp : aDown);
    const thr = Math.pow(st.throttle, spec.throttleExponent);
    let idleAir = spec.idleBase + (spec.idleKp * (spec.idleRpm - st.rpm)) / spec.idleRpm;
    idleAir = idleAir < 0 ? 0 : idleAir > spec.idleMax ? spec.idleMax : idleAir;
    let thrEff = thr > idleAir ? thr : idleAir;

    // ---- fuel: hard limiter (cut + hysteresis, ≥ two engine cycles) and overrun cut
    if (!st.limiterCut && st.rpm >= limit) {
      st.limiterCut = true;
      st.cutTime = 0;
    } else if (st.limiterCut) {
      st.cutTime += h;
      if (st.rpm <= limit - spec.limitHystRpm && st.cutTime >= 240 / Math.max(600, st.rpm)) st.limiterCut = false;
    }
    let fuel = st.limiterCut ? 0 : 1;
    const wantsOverrun = st.throttle < spec.overrunThrottle && st.rpm > spec.overrunRpm;
    if (wantsOverrun && !st.overrun) st.overrun = true;
    else if (st.overrun && (!wantsOverrun || st.rpm < spec.overrunRpm - 150)) st.overrun = false;
    if (st.overrun) {
      fuel = 0;
      thrEff = 0;
    }

    const rpm = st.rpm;
    const omega = rpm * rpmToOmega;
    const qEngine = k * ((brakeTorque(spec, rpm) * boost + frictionTorque(spec, rpm, 1)) * thrEff * fuel - frictionTorque(spec, rpm, thrEff));

    // ---- prop load, semi-implicit in n²: Q_p ≈ kQ·v·(n·n' − n_v²)
    const n = omega / c;
    const jn = n > 1e-3 ? adv / (n * D * pd) : adv > 0 ? 1e3 : 0;
    const v = ventilationFactor(spec, jn);
    const kQv = kQ * v;
    let omegaNext: number;
    if (n * n - nvQ2 >= -spec.windmillBound * nvQ2) {
      const e = n * n >= nvQ2 ? 1 / (G * eta) : eta / G;
      omegaNext = ((I * omega) / h + qEngine + e * kQv * nvQ2) / (I / h + (e * kQv * omega) / (c * c));
    } else {
      omegaNext = omega + (h * (qEngine + (eta / G) * kQv * spec.windmillBound * nvQ2)) / I;
    }
    if (!(omegaNext > 0)) omegaNext = 0;
    st.rpm = omegaNext / rpmToOmega;

    // ---- outputs at the new speed
    const n1 = omegaNext / c;
    const j1 = n1 > 1e-3 ? adv / (n1 * D * pd) : adv > 0 ? 1e3 : 0;
    const v1 = ventilationFactor(spec, j1);
    const n12 = n1 * n1;
    const baseQ = n12 - nvQ2 > -spec.windmillBound * nvQ2 ? n12 - nvQ2 : -spec.windmillBound * nvQ2;
    const baseT = n12 - nvT2 > -spec.windmillBound * nvT2 ? n12 - nvT2 : -spec.windmillBound * nvT2;
    sumQ += kQ * v1 * baseQ;
    sumT += kT * v1 * baseT;
  }

  const n = st.rpm / 60 / G;
  st.thrust = (dir * sumT) / steps;
  st.propTorque = (dir * sumQ) / steps;
  st.shaftAccelTorque = (dir * I * G * (st.rpm * rpmToOmega - omega0)) / total;
  st.propRps = dir * n;
  st.advanceRatio = n > 1e-3 ? advIn / (n * D) : 0;
  st.slip = n > 1e-3 ? 1 - advIn / (spec.propPitch * n) : 1;
}
