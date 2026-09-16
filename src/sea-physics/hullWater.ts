/**
 * HULL↔WATER CONTACT for the speedboat (§T.165 S1; docs/speedboat/tech-research.md
 * §2.1–2.7; docs/wake/wake-research.md §3.1–3.2, V-W2). Engine-free (§V3), pure TS,
 * allocation-free per call after construction. NOT wired into any mode.
 *
 * ONE CONTACT, EVERY CONSUMER (proposed V101 / V-W2). One `evaluate()` per hull per
 * substep clips the hull against the water and produces, in reused buffers:
 *  - wet triangles: centroid, outward normal, area, centroid depth, point velocity
 *    relative to the water, strip index, and the HydroSample fields the wake splats
 *    (fy = vertical force this sample carried, sigma = √A_plan/2)
 *  - waterline segments: the clipped cut edges with local normal velocity (spray root
 *    line, wake injection outline)
 *  - per-strip 2D+t data {c, d, V_n, dm_a/dt, sprayRoot, slam impulse}
 *  - totals: wetted area, displaced volume, slam impulse, patch misses, cap scale
 *  - the rigid6 load: force/torque about the CG + body-frame added mass/inertia
 * The force IS the sum of the samples: Σ wet.fy = load.force[1] (tested). wet.fy is SIGNED (a submerged
 * upward-facing face is pushed up); the WAKE reads `wake` instead — per-plan-column sums, every fy ≥ 0,
 * Σ = max(0, load.force[1]) — which is the wake doc's ∫ρg·h_P dA = ΣF_y (V-W2). A second sampler ⊥.
 *
 * HEIGHT SOURCE (§2.1). `samplePatch()` runs once per tick: a hull-aligned grid
 * (≤ 0.8 m spacing, footprint + tick sweep + margin; DEVIATION from the doc's 1.6 m, user decision:
 * 1.6 m misses the λ 8.3 m wave heave force by 17% of its amplitude, 0.8 m by 4%; ~140 samples) filled from a caller-supplied
 * `HeightSampler`; every substep reads the patch bilinearly. The sampler is an
 * interface on purpose — this module does not import CpuOcean. For FORCES the caller
 * should bind `ocean.pressureHeadAt(x, z, t)` (§V68: a hull answers the Smith-attenuated
 * pressure field; a mirror built with speedboat draft, proposed V105). The clipped
 * waterline is then the pressure waterline; a geometric spray line that must sit on the
 * DRAWN sea would need its own `heightAt` patch (not built here — flagged).
 *
 * FORCE MODEL (§2.2–2.3, D3 hybrid):
 *  - HYDROSTATIC (Kerner pt 1): F = −ρg·d_c·A·n̂ per wet triangle (exact Archimedes for a closed
 *    hull in flat water, divergence theorem). TORQUE at the true centre of pressure
 *    (∫d·r dA = A/12·[(Σd)(Σr) + Σd_i·r_i]) — DEVIATION from the doc's "centroid, add CoP only if
 *    the trim test fails": the centroid form made the mirror-symmetric hull YAW at rest (the
 *    clipped-quad split follows the mirrored winding; −70 N·m, 20° in 20 s).
 *  - VISCOUS: F = −½ρ·C_f·A_sr·|v_t|·v_t per wet triangle, C_f = ITTC-57 0.075/(log₁₀Rn − 2)² +
 *    ΔC_F 0.0004 (the roughness allowance of Savitsky's 1964 procedure), A_sr = clipped area scaled to
 *    the spray-root width (Wagner c / geometric c), Rn on the mean wetted length λb = A_plan/B.
 *  - GARME NEAR-TRANSOM REDUCTION on the STEADY sectional load (hydrostatic + steady lift):
 *    C_T = tanh(2.5·x_T/(a_non·B·Fn_B)). Formula NOT verified against the primary source (see
 *    `garmeANon`); a_non = Garme's 0.34 (not fitted; the Savitsky fit, 0.9, is measured but not adopted — see there).
 *  - 2D+t MOMENTUM STRIPS (Zarnick 1978 / Faltinsen 2005 ch. 9): per strip, from the
 *    clipped geometry — N̂ = normalised Σ(−n̂A) ⊥ body z, geometric wetted half-beam
 *    c_g = |Σ(−n̂A)|/(2Δz), Wagner c = min((π/2)·c_g, b_chine), m_a = k·ρ·(π/2)·c².
 *      lift      −U·∂(m_a·V_n)/∂ξ with M = m_a·V_n at strip centres: each centre-to-centre
 *                increase is placed at the shared boundary (half to each wet strip), the trailing
 *                half-strip to the transom is extrapolated, then the flux leaves with the wake
 *                (dry-transom Kutta). Clamped ≥ 0 (see ASSUMPTIONS).
 *      slam      the V_n·dm_a/dt term as an INELASTIC MOMENTUM EXCHANGE on entry (Δm_a > 0, V_n > 0),
 *                and as the shed momentum flux (Δm_a < 0) while the section still penetrates; Gauss–Seidel over strips against the body's effective
 *                mass at the strip point with the SAME 1/(m + min(A_old, A_new)) rigid6 divides by
 *                (rigidBody.ts FLUID MOMENTUM), so it can never reverse the strip's normal
 *                velocity and its total is h-independent (proposed V103).
 *      crossflow ½ρ·C_Dc·(2c)·V_n|V_n|·Δz along N̂ and ½ρ·C_Dc·A_side·V|V| along body x, as
 *                linearised-implicit impulses in the same Gauss–Seidel pass, i.e. on the
 *                POST-slam velocity. DEVIATION from an explicit force: the explicit form
 *                threw a 25 m/s flat landing back up at +20 m/s at one substep per tick.
 *                All impulses reach rigid6 as impulse/h, so it stays the only integrator (V100).
 *      added mass (§V69): from the SAME strips. COUPLED (default, T179): A6 = Σ a·J·Jᵀ, J = [N̂_b; r_b×N̂_b]
 *                per heave half-section and per sway strip, + roll plate m_a·c²/8·Δz, + surge — handed to rigid6
 *                as `addedMass6` with a per-section keep min(a_old, a_new). The coupled form was UNSTABLE
 *                in T165's trial only because the rotating-frame load was missing then; with it (and without
 *                the angular Kirchhoff term, below) it passes every pitch/roll/Savitsky test. Diagonal option:
 *                A_x,y = Σ m_a·Δz·N_b², ΔI = Σ m_a·Δz·(r_b×N_b)² + plate; surge 0.05·m ramped by displaced
 *                fraction (doc: constant — ramped so a flying hull has no water to drag).
 *  - LATERAL 2D+t (T179): sway added mass m_lat = k_lat·ρ(π/2)·d² per wet strip along L̂ = N̂ × ẑ_b; rotating-frame,
 *                entry exchange and Kirchhoff loads at the strip centroid; the momentum flux (side force) and
 *                the separated crossflow drag as pressure NORMAL TO THE BOTTOM PANELS (addLateralStripForce).
 *  - DRIVES (T179/T189): engine-model thrust (engine.ts) along each trimmed and yawed drive line at its prop point; each gearcase a
 *                Helmbold low-aspect-ratio foil with stall and natural ventilation, span from its immersion
 *                (evaluateDrives). Reported in driveForce/driveTorque, NOT in `load` (V-W2 samples = contact).
 *  - KIRCHHOFF −ω×(A·v) completion and the trailing-face wetting (T179 resting drift): see evaluate/faceFactor.
 *  - BOUNDED AT RESULT (proposed V110, §V44): if the EXPLICIT flux loads' |F|/m or |τ_b/I| exceed the cap they are
 *    scaled by ONE factor (samples with them); impulses are never rescaled (T189). PASSIVITY (T189) then bounds the
 *    kinetic energy those loads may add by what the entrained water holds.
 *
 * ASSUMPTIONS (the doc does not pin these; each is a flagged choice, not a tuned knob):
 *  - k(β) = 1 (plain Wagner). The doc writes k(β) without a value.
 *  - lift clamped ≥ 0 per boundary: momentum that falls downstream is shed, no suction
 *    (the "dm_a/dt only while the wetted beam grows" convention of Zarnick-type models).
 *  - lateral crossflow reuses C_Dc (doc gives no C_D,lat value).
 *  - water particle velocity: only its VERTICAL surface component, ∂η/∂t from two consecutive patches (T189,
 *    `waterVelocity`), enters V_n, V_L, the Gauss–Seidel impulses, Kirchhoff's p and the face drag. The horizontal
 *    orbital velocity needs the wave number, which a height sampler does not carry (measured: it moved no hook, the
 *    vertical part moved most of them). Skin friction still sees the hull velocity over still water.
 *  - only running-surface strips get 2D+t terms: the deck lid, transom and stem cap get
 *    hydrostatics + viscous only (an INVERTED flat landing has no slam — known gap).
 *  - aero, Kerner suction (default 0 in the doc): NOT here (out of scope).
 *
 * KNOWN LIMITS (measured): V104 at EQUILIBRIUM over Savitsky's valid range C_v 3.1–6.0.
 * MANEUVERING (T179, docs/speedboat/physics-log.md): half lock (15°) is a steady turn at C_v 3–6 and hooks 1.5–3 s
 * after the helm starts at C_v 7–10; full lock hooks 1.25–1.6 s in at every C_v (past 45° at C_v 3 too). Spray
 * strakes / chine flats are NOT modelled: the literature found gives them no lift or roll term (part 3). A released hull keeps a
 * few cm/s of horizontal speed from entry-only slam/crossflow along its trimmed normal.
 * Free-running at C_v 3.5–3.9 a pitch limit cycle remains (0.28° at 14 strips, ~0.9° as the strips are
 * refined — so it is the continuous model, not discretisation), far below the doc's porpoising limit;
 * and a roll (chine-walk) limit cycle of ±30° appears at C_v ≥ 8. Both open, reported.
 * One GS sweep is not a converged solve —
 * at 100× C_Dc a 20° stern-first 30 m/s entry still rebounds.
 *
 * MEMORY (proposed V108): `prevMa` (per-strip added mass of the previous substep, for
 * dm_a/dt) is the only carried value. `resetMemory()` on any teleport/respawn/LOD handoff;
 * the first call after a reset exchanges no slam momentum.
 *
 * OWN-WAKE (proposed V111): the sampler handed to `samplePatch` must not include this hull's
 * own same-tick wake source. Not enforceable from here; stated for the wiring stage.
 */
import type { Quat, Vec3 } from '../state/simState';
import { createEngineState, MERCURY_450R, resetEngineState, stepEngine, type EngineSpec, type EngineState } from './engine';
import { factorSpd6, solveFactored6, type Rigid6ForceFn, type Rigid6Load, type Rigid6State } from './rigidBody';

/** water surface (or pressure head) elevation at world (x, z), m */
export type HeightSampler = (x: number, z: number) => number;

/** what the contact needs from a hull; `buildDeepVHull` (src/speedboat/hullMesh.ts) satisfies it */
export interface HullWaterMesh {
  positions: Float64Array;
  vertexCount: number;
  indices: Uint16Array | Uint32Array;
  triCount: number;
  triStrip: Int16Array;
  strips: {
    count: number;
    dz: number;
    zCentre: Float64Array;
    chineHalfBeam: Float64Array;
    keelY: Float64Array;
    /** deadrise at the strip centre, rad (chine-wet added mass; absent ⇒ no chine-wet growth) */
    deadrise?: Float64Array;
    /** chine at the strip centre per half as a lerp of two vertices (see HullStrips); absent ⇒ no chine-wet growth */
    chineV0?: Int32Array;
    chineV1?: Int32Array;
    chineT?: Float64Array;
  };
  mass: number;
  inertia: Vec3;
  propPoint: Vec3;
  propRadius: number;
  /** transom z and stem z in the body frame (length = stemZ − transomZ) */
  transomZ: number;
  stemZ: number;
  /** steerable drives (thrust + gearcase foil); none ⇒ no drive load */
  drives?: readonly HullDrive[];
}

export interface HullWaterParams {
  /** sea water density, kg/m³ */
  rho: number;
  gravity: number;
  /** kinematic viscosity, m²/s (ITTC 15 °C sea water) */
  nu: number;
  /** k(β) in m_a = k·ρ·(π/2)·c² */
  addedMassCoeff: number;
  /** Zarnick crossflow drag coefficient C_Dc */
  crossflowDrag: number;
  /** surge added mass / m (doc §1.3) */
  surgeAddedMassRatio: number;
  /** k_lat in the sectional SWAY added mass m_lat = k_lat·ρ·(π/2)·d² (d = wetted depth of the section); 0 = no lateral 2D+t */
  lateralAddedMassCoeff: number;
  /**
   * POWER SCALE for tests, W (all engines together): the engine model runs with powerScale = this / STANDIN_THRUST.powerW
   * (engine torque, rotating inertia and prop K_T/K_Q all × k ⟹ same rpm, k × thrust). Default = three rated 450Rs ⟹ 1.
   * Tests raise it (4 MW) to hold C_v 8–10 on the non-stepped proxy. Name kept from T179 (API).
   */
  standInDrivePowerW: number;
  /** the engine + prop of every drive (src/sea-physics/engine.ts) */
  engine: Readonly<EngineSpec>;
  /** prop torque reaction on the hull about each drive line (see evaluateDrives) */
  propTorqueReaction: boolean;
  /**
   * COUPLED 6×6 ADDED MASS (default): A6 = Σ a·J·Jᵀ, J = [N̂_b; r_b × N̂_b] over the heave half-sections and the sway
   * strips, handed to rigid6 as `addedMass6` — heave–pitch (A₃₅), sway–roll and sway–yaw coupling included. false =
   * the diagonal per-axis added mass of T165 (no lever arms).
   */
  coupledAddedMass: boolean;
  /** Kirchhoff −ω × (A·v) completion of the rotating-frame fluid load (see KIRCHHOFF COMPLETION in evaluate) */
  kirchhoff: boolean;
  /** sectional 2D+t loads at the Wagner centres of pressure (see placeCentresOfPressure); false = geometric centroids (T165) */
  wagnerCentreOfPressure: boolean;
  /** chine-wet added-mass growth under the DEEPER chine of a heeled section (Payne 1994; see chineWetGrowth) */
  chineWetAddedMass: boolean;
  /** gearcase lateral foils on the drives (off = thrust vectoring only) */
  driveFoil: boolean;
  /** natural ventilation of the surface-piercing gearcases (off = wetted lift to stall) */
  gearcaseVentilation: boolean;
  /**
   * RELATIVE FLOW (T189): subtract the water's vertical surface velocity ∂η/∂t (this patch − the previous one, per tick)
   * from every fluid-momentum velocity (2D+t V_n, sway V_L, GS impulses, Kirchhoff p, face drag). Without it the
   * entrained-water terms saw the hull heaving WITH a swell as heaving through still water: a hull at rest in Working
   * sea capsized 3/4 seeds in 90 s (roll rate 120–290°/s), 0/4 with it (max heel 11–24°).
   */
  waterVelocity: boolean;
  /**
   * PLANING PANELS FACE THE WATER (T189): a half-section's 2D+t added mass (and its strip's sway added mass) fades out
   * as its panel normal turns from facing down to horizontal (world n_y 0.26 → 0, i.e. 75° → 90° from vertical).
   * Wagner's wedge-entry flow needs the water under the panel; a side-on or inverted "bottom" kept planing momentum
   * terms and launched a capsized hull (see `passivity`). Ramp width ASSUMED.
   */
  planingFacing: boolean;
  /**
   * PANEL PRESSURE ≥ AMBIENT (T189): the sway momentum flux and sway rotating-frame load are pressure on the bottom
   * panels (addLateralStripForce); on a half-panel whose planing region is open to the free surface at its spray root
   * the pressure cannot fall below ambient — air is drawn in (ventilation). So the side-force SUCTION on a half is
   * limited to that half's planing lift. Without it the lee panel pulled up to 100 kN of suction on a wave face and
   * the crossing-swell hooks at 6° of drive were 9/16 (C_v 8) and 11/16 (C_v 10).
   */
  panelSuctionLimit: boolean;
  /**
   * PASSIVITY OF THE FLUID-MEMORY LOADS (T189): the explicit momentum-flux loads (rotating frame, Kirchhoff, planing
   * lift, sway flux) may not add more rigid kinetic energy, relative to the water, than the entrained water holds
   * (½·Σ m_a·V_n² + ½·Σ m_lat·V_L², plus what the dissipative terms have taken out). The 2D+t strip terms are each a
   * momentum balance of a thin section, but outside their validity (a heeled, sinking or tumbling hull) the set is not
   * energy-consistent: an inverted re-entry at 35 m/s gained 2.6 MJ (50 m of height) over its initial energy; now 0.
   * Coupled added mass only (the diagonal step has no (M + A)⁻¹ to evaluate the work with).
   * T196: σ scales only the MOMENTUM-TRANSFER loads (rotating frame, its 6×6 gyroscopic part, Kirchhoff) — the terms that
   * move energy between the hull's modes and the water's without a sign of their own. The planing lift and sway flux are
   * no longer scaled: measured on the crossing-swell hooks, on the ticks the bound bit (σ < 0.5) the transfer terms put
   * +54…+154 kW in while the lift took −63…−181 kW out, so one σ over all of them also removed the righting lift of a
   * heeled landing (the water-exit rule, `waterExit`, is what keeps the lift from pushing a withdrawing panel).
   */
  passivity: boolean;
  /**
   * SEPARATED NORMAL-PRESSURE DRAG on wet NON-running faces (deck lid, transom, stem cap): ½ρ·C_D·A·V_n|V_n| along the
   * face normal, as a linearised implicit impulse (dissipative by construction), transom scaled by its Froude drying.
   * C_D 1.2: flat plate normal to the flow (Hoerner, Fluid-Dynamic Drag 1965, ch. 3: 1.17–1.28). These faces had only
   * hydrostatics: a buried or inverted hull rose through the water with nothing resisting it. 0 = off.
   */
  faceDragCoeff: number;
  /**
   * ZERO-SPEED WAVE RADIATION DAMPING (T196, see RADIATION below): each wet strip is a 2D section heaving on a free
   * surface; the waves it radiates take energy out at N₃₃(ω) of a wedge (Frank 1967 close-fit source method), applied
   * as a linear implicit damper on the strip's vertical velocity relative to the water at the section's own heave
   * natural frequency, faded out between length Froude number 0.4 and 1.0 where the 2D+t planing terms take over.
   */
  radiationDamping: boolean;
  /**
   * WATER EXIT CARRIES NO PLANING MOMENTUM (T196): in the planing lift flux −U·∂(m_a·V_n)/∂ξ a half-section whose bottom
   * is WITHDRAWING along its normal (V_n < 0) contributes M = 0, the rule the slam law already applies to V_n·dm_a/dt
   * ("a section moving out of the water gets nothing"). Without it a withdrawing section downstream of a deeper one
   * (bow-down pose, heeled landing, crest exit) received POSITIVE lift U·(M_i − M_up) with both M negative — a pressure
   * pushing a surface that moves away from the water, i.e. power into the hull (+1.2 MN·m bow-down on a −10° / 30 m/s
   * entry) — which the passivity bound then answered by zeroing every explicit load, righting lift included.
   */
  waterExit: boolean;
  /**
   * THE DRIVES RUN IN THE TRANSOM WAKE (T196): behind a planing transom the water leaves the keel and rises only slowly
   * aft, so a setback bracket's props and gearcases sit in a HOLLOW below the undisturbed surface — which is how a
   * surface-piercing prop mounted near keel level runs half surfaced at speed. Prop and anti-ventilation-plate depths
   * (driveImmersion, gearcaseImmersion, propDepth/propImmersion) are taken against the Korvin-Kroukovsky, Savitsky & Lehman
   * (1949) centreline wake profile (see `transomWakeDepression`), faded in with the transom's Froude drying.
   */
  transomWake: boolean;
  /**
   * Garme near-transom reduction length a_non (0 = off): every sectional load (hydrostatic and
   * 2D+t) is multiplied by C_T = tanh(2.5·x_T/(a_non·B·Fn_B)), x_T = distance from the trailing
   * edge (transom), Fn_B = U/√(gB).
   * SOURCE — NOT VERIFIED AGAINST THE PRIMARY: Garme, K., "Improved time domain simulation of
   * planing hulls in waves by correction of the near-transom lift", Int. Shipbuild. Prog. 52(3)
   * 201–230, 2005 (paywalled; his thesis TRITA-AVE 2004:34 has no open full text). The formula and
   * Garme's 0.34 are taken from the reproduction in Niazmand Bilandi et al., J. Mar. Sci. Eng.
   * 2018, 6, 136, eq. (22).
   * APPLIED TO THE STEADY LOAD ONLY — hydrostatic pressure and the steady part of the 2D+t lift (the
   * momentum flux at the pose with the CG moving horizontally). The rate-dependent terms (lift from
   * heave/pitch rate, V_n·dm_a/dt, crossflow drag) keep their full 2D+t value: Garme's function was
   * chosen from steady pressures and running attitude, and applied to the rate terms it removed the
   * near-transom heave/pitch damping — a free-running limit cycle at C_v ≤ 3.7 (3.4° p2p).
   * NOT FITTED: Garme's own 0.34 (as quoted by Niazmand Bilandi et al. 2018; primary unread). It leaves the equilibrium
   * trim 0.48–0.87° BELOW Savitsky 1964 at every valid C_v (prismatic oracle hull: 4.19/2.67/2.21/1.95° vs 4.97/3.55/2.99/
   * 2.43° at C_v 3.1/4.3/5.0/6.0) — the steady load kept too near the transom, so she runs flat (user 2026-09-14: "not
   * sitting in the water on the back"). MEASURED FIT, NOT ADOPTED: 0.9 gives −0.17…+0.14° over C_v 3.1–6.0 and
   * resistance −5…−6 % (0.2/0.6/0.8/1.0 scanned), player hull 20/30 m/s 2.75/1.93° → 3.51/2.50°. It moves the
   * manoeuvring envelope (Denny & Hubble speed loss, the C_v 3/5 full-lock hook/survival pair, crossing-swell hooks at
   * C_v 8 2 → 4/16), the race AI's measured capability table, the pack band and three crash-machine scenarios — a
   * decision for the physics/AI owners, not a silent default (docs/speedboat/physics-log.md, T-seakeeping section).
   */
  garmeANon: number;
  /** skin-friction roughness allowance ΔC_F added to the ITTC-57 line (Savitsky 1964 procedure) */
  frictionAllowance: number;
  /** 2D+t strips on/off (off = hydrostatics + viscous only) */
  planing: boolean;
  viscous: boolean;
  /** V110 linear cap on the explicit flux loads, m/s² — a SAFETY bound, not a feel knob */
  maxAccel: number;
  /** V110 angular cap, rad/s² */
  maxAngularAccel: number;
  /** patch grid spacing upper bound, m (0.8: wave heave force within 10% at λ 8.3 m, tested) */
  patchSpacing: number;
  /** patch margin around footprint + tick sweep, m */
  patchMargin: number;
  /** patch nodes per axis cap */
  patchMaxAxis: number;
}

/**
 * RATED POWER REFERENCE (T179 name kept). The T179 temporary curve T = η·P/max(U, 12)·s^1.5 is GONE (T189): thrust is
 * the engine model's (src/sea-physics/engine.ts). `powerW` = three Mercury Racing 450R (450 hp = 335.7 kW each) is the
 * reference `standInDrivePowerW` is divided by to get the engine powerScale.
 */
export const STANDIN_THRUST = Object.freeze({ powerW: 3 * 335.7e3, efficiency: 0.55, refSpeed: 12 });

/** a steerable drive (satisfied by `DriveUnit`, src/speedboat/hullMesh.ts); body frame, at steer 0 */
export interface HullDrive {
  pivot: Vec3;
  prop: Vec3;
  foilCe: Vec3;
  avPlateY: number;
  span: number;
  lateralArea: number;
  stallRad: number;
  profileDragCoeff: number;
  maxSteerRad: number;
  /** body y of the trim/tilt pivot (the clamp bracket pin); absent ⇒ no trim */
  trimPivotY?: number;
  /** trim range, rad (+ = out) */
  trimMinRad?: number;
  trimMaxRad?: number;
  /** prop rotation hand in forward gear: +1 right-hand, −1 left-hand (counter-rotating); absent ⇒ +1 */
  propHand?: number;
}

export const HULL_WATER_DEFAULTS: Readonly<HullWaterParams> = Object.freeze({
  rho: 1025,
  gravity: 9.81,
  nu: 1.19e-6,
  addedMassCoeff: 1,
  crossflowDrag: 1,
  surgeAddedMassRatio: 0.05,
  lateralAddedMassCoeff: 1,
  standInDrivePowerW: STANDIN_THRUST.powerW,
  engine: MERCURY_450R,
  propTorqueReaction: false,
  coupledAddedMass: true,
  wagnerCentreOfPressure: true,
  chineWetAddedMass: true,
  kirchhoff: true,
  driveFoil: true,
  gearcaseVentilation: true,
  waterVelocity: true,
  planingFacing: true,
  panelSuctionLimit: true,
  passivity: true,
  faceDragCoeff: 1.2,
  radiationDamping: true,
  waterExit: true,
  transomWake: true,
  garmeANon: 0.34,
  frictionAllowance: 0.0004,
  planing: true,
  viscous: true,
  maxAccel: 50 * 9.81,
  maxAngularAccel: 200,
  patchSpacing: 0.8,
  patchMargin: 1.0,
  patchMaxAxis: 48,
});

const HALF_PI = Math.PI / 2;
/**
 * TRANSOM WETTING by the transom-draft Froude number Fn_T = U/√(g·T), T = the keel's depth at the trailing edge
 * (see `faceFactor`). The transom runs dry at Fn_T ≈ 2.5 in model tests, 2.4 in numerical simulation and ≈ 2.2
 * at full-scale Reynolds number (Maki et al. 2006 geosim tests and "On transom clearance", Ocean Eng. 2015, as
 * summarised in the literature search, primary PDFs not read). The wet end of the ramp, 1.1 = half the dry
 * value, is ASSUMED: a smooth ramp only has to reach "wet" at rest and "dry" by planing speed.
 */
const TRANSOM_DRY_FN = 2.2;
const TRANSOM_WET_FN = 1.1;

/**
 * RADIATION (T196, `radiationDamping`). 2D heave added mass and wave damping of a WEDGE on deep water, computed with
 * Frank's pulsating-source close-fit method (Frank, NSRDC Report 2375, 1967; formulation as in Journée & Massie,
 * "Offshore Hydromechanics", TU Delft 2001, §7.3.4): Green function G = ln r − ln r′ − 2·PV∫e^{kY}cos kX/(k − ν)dk +
 * 2πi·e^{νY}cos νX (free-surface condition and outgoing waves checked numerically; the PV integral in closed form with
 * E₁), 24 cosine-spaced panels per contour (20 → 40 panels changes the coefficients < 0.1 %). Validation of the solver
 * (scratch `t196/rad/frank.py`): semicircle heave added mass → ρπR²/2 as ω → ∞ (1.004); damping → the Haskind/Froude–
 * Krylov long-wave limit ρωB² as ω → 0 (0.87 of it at νR = 0.025, rising); N₃₃ = ρg²Ā²/ω³ from the solver's own far-
 * field wave amplitude within 0.5 % (J&M eq. 6.33). Rows: deadrise β (deg) of a wedge of waterline half-beam b and keel
 * draft T = b·tanβ; columns: ξ = ω²b/g. a33 = M₃₃/(ρB²), b33 = N₃₃/(ρωB²), B = 2b. Heave damping is nearly independent
 * of deadrise (the reason a V is used for every section, with β = atan(T/b) of the actual section).
 */
const RAD_BETA_DEG = [8, 12, 16, 20, 24, 28, 32, 38, 45];
const RAD_LN_XI = [0.02, 0.05, 0.1, 0.2, 0.35, 0.5, 0.7, 1.0, 1.4, 2.0, 3.0, 5.0, 8.0].map(Math.log);
const RAD_A33 = [
  [1.249, 0.9594, 0.7606, 0.592, 0.4841, 0.4297, 0.3886, 0.3554, 0.3334, 0.3189, 0.3121, 0.314, 0.3219],
  [1.234, 0.9438, 0.7449, 0.5763, 0.4685, 0.4141, 0.3732, 0.3404, 0.3189, 0.3052, 0.2993, 0.302, 0.3114],
  [1.218, 0.928, 0.729, 0.5603, 0.4526, 0.3984, 0.3577, 0.3254, 0.3045, 0.2917, 0.2869, 0.3006, 0.299],
  [1.202, 0.9119, 0.7128, 0.5441, 0.4365, 0.3825, 0.3421, 0.3103, 0.2901, 0.2783, 0.2748, 0.2828, 0.2948],
  [1.186, 0.8953, 0.6961, 0.5274, 0.4199, 0.3662, 0.3262, 0.295, 0.2758, 0.2652, 0.263, 0.2727, 0.2853],
  [1.169, 0.8781, 0.6788, 0.5101, 0.4028, 0.3493, 0.3099, 0.2795, 0.2614, 0.2523, 0.2509, 0.2633, 0.2771],
  [1.151, 0.8601, 0.6607, 0.492, 0.385, 0.3319, 0.2931, 0.2638, 0.247, 0.2396, 0.2445, 0.2547, 0.2696],
  [1.123, 0.8311, 0.6315, 0.4629, 0.3565, 0.3043, 0.2668, 0.2396, 0.2254, 0.2212, 0.2273, 0.2431, 0.2597],
  [1.085, 0.7932, 0.5933, 0.425, 0.3198, 0.2692, 0.2341, 0.2106, 0.2007, 0.2014, 0.212, 0.232, 0.25],
];
const RAD_B33 = [
  [0.9013, 0.8173, 0.7261, 0.6139, 0.5138, 0.4487, 0.3881, 0.3261, 0.271, 0.2175, 0.1643, 0.1102, 0.07313],
  [0.9012, 0.8169, 0.7254, 0.6127, 0.5122, 0.4466, 0.3855, 0.323, 0.2674, 0.2134, 0.1598, 0.1055, 0.0696],
  [0.9011, 0.8165, 0.7247, 0.6114, 0.5102, 0.4442, 0.3825, 0.3193, 0.2632, 0.2087, 0.1548, 0.1072, 0.06376],
  [0.9009, 0.816, 0.7238, 0.6099, 0.508, 0.4413, 0.3791, 0.3152, 0.2584, 0.2034, 0.1492, 0.09716, 0.063],
  [0.9006, 0.8154, 0.7227, 0.6081, 0.5053, 0.438, 0.375, 0.3104, 0.2529, 0.1975, 0.1427, 0.09144, 0.05793],
  [0.9003, 0.8147, 0.7214, 0.606, 0.5022, 0.4341, 0.3703, 0.3048, 0.2466, 0.1907, 0.1344, 0.08546, 0.05312],
  [0.8999, 0.8138, 0.7199, 0.6034, 0.4985, 0.4295, 0.3647, 0.2982, 0.2393, 0.183, 0.1351, 0.07911, 0.04821],
  [0.8992, 0.8121, 0.7169, 0.5985, 0.4914, 0.4207, 0.3543, 0.2862, 0.2262, 0.1693, 0.118, 0.06885, 0.04064],
  [0.8979, 0.8094, 0.7121, 0.5905, 0.4799, 0.4067, 0.3379, 0.2676, 0.2065, 0.1497, 0.1003, 0.0559, 0.03166],
];
/** length Froude numbers of the radiation fade: displacement strip theory's usual range ends near 0.4; "a length Froude
 *  number of 1~1.2 is often used as a lower limit for planing" (Sun & Faltinsen, "The influence of gravity on the
 *  performance of planing vessels in calm water", J. Eng. Math. 2007, §1), where the 2D+t (φ = 0) terms are the model */
const RAD_FADE_FN0 = 0.4;
const RAD_FADE_FN1 = 1.0;

/** bilinear in deadrise (deg) and ln ξ over a RAD_* table, clamped at the edges */
export function radiationCoeff(tab: readonly (readonly number[])[], betaDeg: number, xi: number): number {
  const nb = RAD_BETA_DEG.length;
  let bi = 0;
  while (bi < nb - 2 && RAD_BETA_DEG[bi + 1] < betaDeg) bi++;
  const tb = Math.min(1, Math.max(0, (betaDeg - RAD_BETA_DEG[bi]) / (RAD_BETA_DEG[bi + 1] - RAD_BETA_DEG[bi])));
  const lx = Math.log(Math.max(1e-6, xi));
  const nx = RAD_LN_XI.length;
  let xk = 0;
  while (xk < nx - 2 && RAD_LN_XI[xk + 1] < lx) xk++;
  const tx = Math.min(1, Math.max(0, (lx - RAD_LN_XI[xk]) / (RAD_LN_XI[xk + 1] - RAD_LN_XI[xk])));
  const r0 = tab[bi];
  const r1 = tab[bi + 1];
  const v0 = r0[xk] + (r0[xk + 1] - r0[xk]) * tx;
  const v1 = r1[xk] + (r1[xk + 1] - r1[xk]) * tx;
  return v0 + (v1 - v0) * tb;
}
export const RADIATION_A33: readonly (readonly number[])[] = RAD_A33;
export const RADIATION_B33: readonly (readonly number[])[] = RAD_B33;

/**
 * Per-hull height grid, sampled once per tick and read bilinearly by every substep.
 * Hull-aligned (u along the hull's horizontal forward, w across), so a heading change
 * never inflates it; any axis choice is valid, only the size changes.
 */
export class WaterPatch {
  readonly heights: Float64Array;
  nu = 0;
  nw = 0;
  ox = 0;
  oz = 0;
  e1x = 1;
  e1z = 0;
  du = 1;
  dw = 1;
  /** queries that fell outside the grid since the last build (clamped to the edge) */
  outside = 0;
  sampleCount = 0;
  private built = false;
  /** Whether the current grid belongs to the next velocity difference (separate from height availability). */
  private retainForVelocity = false;
  /** the previous build's grid (for ∂η/∂t, see `verticalVelocityAt`) */
  private readonly prevHeights: Float64Array;
  private pnu = 0;
  private pnw = 0;
  private pox = 0;
  private poz = 0;
  private pe1x = 1;
  private pe1z = 0;
  private pdu = 1;
  private pdw = 1;
  private pdt = 0;
  private hasPrev = false;

  constructor(readonly maxAxis: number) {
    this.heights = new Float64Array(maxAxis * maxAxis);
    this.prevHeights = new Float64Array(maxAxis * maxAxis);
  }

  /** V108: the next build has no previous grid (a teleport is not a wave) */
  forgetPrevious(): void {
    this.hasPrev = false;
    this.retainForVelocity = false;
  }

  /**
   * VERTICAL WATER VELOCITY ∂η/∂t at world (x, z), m/s: (this build − the previous build)/dt at the same world point,
   * both read bilinearly. For a linear wave that is the surface particle's vertical velocity (the free-surface
   * kinematic condition, flat-slope limit); on a pressure-head patch (Smith, V68) it is the attenuated one at the
   * hull's reference depth, the same field the forces read. 0 before a second build, after `forgetPrevious`, or where
   * the previous grid did not reach. Leaves `outside` unchanged.
   */
  verticalVelocityAt(x: number, z: number): number {
    if (!this.hasPrev || !(this.pdt > 0)) return 0;
    const rx = x - this.pox;
    const rz = z - this.poz;
    const fu = (rx * this.pe1x + rz * this.pe1z) / this.pdu;
    const fw = (-rx * this.pe1z + rz * this.pe1x) / this.pdw;
    const mu = this.pnu - 1;
    const mw = this.pnw - 1;
    if (!(fu >= 0 && fu <= mu && fw >= 0 && fw <= mw)) return 0;
    let iu = Math.floor(fu);
    let iw = Math.floor(fw);
    if (iu >= mu) iu = mu - 1;
    if (iw >= mw) iw = mw - 1;
    const tu = fu - iu;
    const tw = fw - iw;
    const H = this.prevHeights;
    const r0 = iw * this.pnu;
    const r1 = r0 + this.pnu;
    const hp = (H[r0 + iu] * (1 - tu) + H[r0 + iu + 1] * tu) * (1 - tw) + (H[r1 + iu] * (1 - tu) + H[r1 + iu + 1] * tu) * tw;
    const o = this.outside;
    const hn = this.heightAt(x, z);
    this.outside = o;
    return (hn - hp) / this.pdt;
  }

  build(
    sampler: HeightSampler,
    mesh: HullWaterMesh,
    state: Readonly<Rigid6State>,
    dt: number,
    spacing: number,
    margin: number,
  ): void {
    if (this.retainForVelocity) {
      this.prevHeights.set(this.heights.subarray(0, this.nu * this.nw));
      this.pnu = this.nu;
      this.pnw = this.nw;
      this.pox = this.ox;
      this.poz = this.oz;
      this.pe1x = this.e1x;
      this.pe1z = this.e1z;
      this.pdu = this.du;
      this.pdw = this.dw;
      this.pdt = dt;
      this.hasPrev = true;
    }
    const [qx, qy, qz, qw] = state.quaternion;
    const [px, , pz] = state.position;
    // world xz of body +z and body +x; pick the longer as the grid's long axis
    const fx = 2 * (qx * qz + qw * qy);
    const fz = 1 - 2 * (qx * qx + qy * qy);
    const rx = 1 - 2 * (qy * qy + qz * qz);
    const rz = 2 * (qx * qz - qw * qy);
    const fl = Math.hypot(fx, fz);
    const rl = Math.hypot(rx, rz);
    let e1x: number;
    let e1z: number;
    if (fl >= 0.2 || fl >= rl) {
      e1x = fl > 1e-9 ? fx / fl : 1;
      e1z = fl > 1e-9 ? fz / fl : 0;
    } else {
      e1x = rx / rl;
      e1z = rz / rl;
    }
    const e2x = -e1z;
    const e2z = e1x;
    let uMin = Infinity;
    let uMax = -Infinity;
    let wMin = Infinity;
    let wMax = -Infinity;
    const P = mesh.positions;
    // every vertex, plus the prop point (a setback bracket puts it beyond the hull's own footprint)
    for (let i = 0; i <= mesh.vertexCount; i++) {
      const last = i === mesh.vertexCount;
      const bx = last ? mesh.propPoint[0] : P[i * 3];
      const by = last ? mesh.propPoint[1] : P[i * 3 + 1];
      const bz = last ? mesh.propPoint[2] : P[i * 3 + 2];
      const tx = 2 * (qy * bz - qz * by);
      const ty = 2 * (qz * bx - qx * bz);
      const tz = 2 * (qx * by - qy * bx);
      const wx = bx + qw * tx + (qy * tz - qz * ty);
      const wz = bz + qw * tz + (qx * ty - qy * tx);
      const u = wx * e1x + wz * e1z;
      const w = wx * e2x + wz * e2z;
      if (u < uMin) uMin = u;
      if (u > uMax) uMax = u;
      if (w < wMin) wMin = w;
      if (w > wMax) wMax = w;
    }
    // sweep over the tick (substeps move the hull forward in time inside it)
    const sweepU = (state.velocity[0] * e1x + state.velocity[2] * e1z) * dt;
    const sweepW = (state.velocity[0] * e2x + state.velocity[2] * e2z) * dt;
    if (sweepU > 0) uMax += sweepU;
    else uMin += sweepU;
    if (sweepW > 0) wMax += sweepW;
    else wMin += sweepW;
    uMin -= margin;
    uMax += margin;
    wMin -= margin;
    wMax += margin;
    const nu = Math.min(this.maxAxis, Math.max(2, Math.ceil((uMax - uMin) / spacing) + 1));
    const nw = Math.min(this.maxAxis, Math.max(2, Math.ceil((wMax - wMin) / spacing) + 1));
    this.nu = nu;
    this.nw = nw;
    this.du = (uMax - uMin) / (nu - 1);
    this.dw = (wMax - wMin) / (nw - 1);
    this.e1x = e1x;
    this.e1z = e1z;
    this.ox = px + uMin * e1x + wMin * e2x;
    this.oz = pz + uMin * e1z + wMin * e2z;
    const H = this.heights;
    for (let j = 0; j < nw; j++) {
      const bx = this.ox + j * this.dw * e2x;
      const bz = this.oz + j * this.dw * e2z;
      for (let i = 0; i < nu; i++) {
        H[j * nu + i] = sampler(bx + i * this.du * e1x, bz + i * this.du * e1z);
      }
    }
    this.sampleCount = nu * nw;
    this.outside = 0;
    this.built = true;
    this.retainForVelocity = true;
  }

  heightAt(x: number, z: number): number {
    if (!this.built) throw new Error('WaterPatch.heightAt before build(): sample the patch once per tick first');
    const rx = x - this.ox;
    const rz = z - this.oz;
    let fu = (rx * this.e1x + rz * this.e1z) / this.du;
    let fw = (-rx * this.e1z + rz * this.e1x) / this.dw;
    const mu = this.nu - 1;
    const mw = this.nw - 1;
    if (fu < 0 || fu > mu || fw < 0 || fw > mw) {
      if (fu < -1e-6 || fu > mu + 1e-6 || fw < -1e-6 || fw > mw + 1e-6) this.outside++;
      fu = fu < 0 ? 0 : fu > mu ? mu : fu;
      fw = fw < 0 ? 0 : fw > mw ? mw : fw;
    }
    let iu = Math.floor(fu);
    let iw = Math.floor(fw);
    if (iu >= mu) iu = mu - 1;
    if (iw >= mw) iw = mw - 1;
    const tu = fu - iu;
    const tw = fw - iw;
    const H = this.heights;
    const r0 = iw * this.nu;
    const r1 = r0 + this.nu;
    return (
      (H[r0 + iu] * (1 - tu) + H[r0 + iu + 1] * tu) * (1 - tw) + (H[r1 + iu] * (1 - tu) + H[r1 + iu + 1] * tu) * tw
    );
  }
}

/** wet triangle buffers (capacity 2 × triCount) */
export interface WetTriangles {
  count: number;
  centroid: Float64Array;
  normal: Float64Array;
  area: Float64Array;
  depth: Float64Array;
  /** point velocity relative to the (still) water */
  vel: Float64Array;
  strip: Int16Array;
  /** HydroSample: vertical force this sample carried, N (signed; see report) */
  fy: Float64Array;
  /** HydroSample: plan footprint radius √(A·|n_y|)/2, m */
  sigma: Float64Array;
}

/**
 * WAKE LOAD SAMPLES (V101 / V-W2): the pressure the hull puts on the water, as ≥ 0 plan-column samples.
 * A wet triangle's own fy is SIGNED — an upward-facing submerged face (a buried deck, an inverted hull's
 * bottom) is pushed UP by the water, fy < 0 — and a clamp-at-0 consumer then integrates MORE load than
 * the contact carries. The water column under a plan point feels the NET of every face above it, and
 * hydrostatically that net is ρg × the column's submerged thickness ≥ 0. So the wet samples are summed
 * per hull-aligned plan cell of the height patch (≤ 0.8 m); cells still < 0 (dynamic suction, or a
 * face whose partner fell in the next cell) are clamped and the positive cells rescaled so that
 *   Σ fy = min(max(0, load.force[1]), maxAccel·m)   with every fy ≥ 0.
 * A net DOWNWARD pull by the water (load.force[1] < 0) gives no wake load; `deficit` reports it.
 *
 * §B126 THE V110 BOUND APPLIES HERE TOO. `load.force[1]` carries the velocity-level impulse terms (slam, crossflow,
 * face drag, sway entry) divided by the substep. Those are bounded against the RIGID BODY by construction (V103: they
 * never reverse a point's velocity) but not in newtons, so one substep of an inverted hull dragged under at 25 m/s
 * handed 5.6 GN — 300 000 × the boat's weight — to the wake field, which is a STEADY-pattern model (a Kelvin wake is
 * forced by the load the hull carries, never by one substep of an impact). The consequence was fleet-wide: a source of
 * 9.3e7 N threw ±80 m of "wake" across its 300 m wedge, and the boats inside it were buried 30–55 m deep for one tick
 * and fired out at 460 and 1068 m/s. So the load the wake sees gets the SAME V110 bound (`maxAccel·m`) the explicit
 * flux loads get, and every cell scales by that one factor: the pattern's centroid, second moments and depth are
 * exactly the unbounded load's, only the amplitude is physical. `rescale` and `deficit` report the trim.
 */
export interface WakeLoadSamples {
  count: number;
  /** plan position (world x, z) of the cell's load, plan-area weighted */
  x: Float64Array;
  z: Float64Array;
  /** vertical load the water carries in this cell, N, ≥ 0 */
  fy: Float64Array;
  /** plan footprint radius √(A_plan)/2, m */
  sigma: Float64Array;
  /** plan-area-weighted mean depth, m, ≥ 0 */
  depth: Float64Array;
  /** load.force[1] − Σ fy (≠ 0 when the net vertical load is downward, or past the V110 bound — §B126) */
  deficit: number;
  /** the load the wake carries / Σ positive cell loads: 1 ⇔ no cell was negative and the V110 bound was slack */
  rescale: number;
}

export interface WaterlineSegments {
  count: number;
  a: Float64Array;
  b: Float64Array;
  /** normal velocity (along the parent triangle's outward normal) at the segment midpoint */
  vn: Float64Array;
}

export interface HullSections {
  count: number;
  /** Wagner wetted half-beam, m */
  c: Float64Array;
  /** vertical keel immersion at the strip centre (signed, + = below the surface), m */
  d: Float64Array;
  /** penetration velocity along the strip normal, m/s */
  vn: Float64Array;
  /** forward speed along body z, m/s */
  u: Float64Array;
  /** sectional added mass, kg/m */
  ma: Float64Array;
  /** ∂m_a/∂t at the body-fixed strip over the last substep, kg/(m·s) */
  dmadt: Float64Array;
  /** (π/2)·c_g — spray root half-beam; > chine half-beam ⇒ sheet leaves the chine */
  sprayRoot: Float64Array;
  wetArea: Float64Array;
  /** slam impulse this substep, N·s */
  slam: Float64Array;
  /** world strip normal N̂ (into the hull) */
  normal: Float64Array;
  /** world wet centroid */
  centroid: Float64Array;
}

export class HullWater {
  readonly params: HullWaterParams;
  readonly patch: WaterPatch;
  readonly wet: WetTriangles;
  readonly waterline: WaterlineSegments;
  readonly sections: HullSections;
  /** ≥ 0 plan-column samples for the wake (see WakeLoadSamples); Σ fy = max(0, load.force[1]) */
  readonly wake: WakeLoadSamples;
  readonly load: Rigid6Load;
  /** totals of the last evaluate() */
  wettedArea = 0;
  /** hydrostatic displaced volume Σ d·A·(−n_y), m³ (exact submerged volume in flat water) */
  displacedVolume = 0;
  /** Σ slam impulse this substep, N·s */
  slamImpulse = 0;
  /** V110 scale applied (1 = uncapped) */
  capScale = 1;
  /** uncapped hydro force (world), N */
  readonly rawForce: Vec3 = [0, 0, 0];
  /** skin-friction share of the uncapped force and of the torque about the CG (world) */
  readonly frictionForce: Vec3 = [0, 0, 0];
  readonly frictionTorque: Vec3 = [0, 0, 0];
  propDepth = 0;
  propImmersion = 0;

  private readonly px: Float64Array;
  private readonly py: Float64Array;
  private readonly pz: Float64Array;
  private readonly pd: Float64Array;
  private readonly prevMa: Float64Array;
  /** previous substep's body-frame added mass [x,y,z] and added inertia [x,y,z] */
  private readonly prevAdded = new Float64Array(6);
  private hasPrev = false;
  // strip accumulators
  private readonly sSx: Float64Array;
  private readonly sSy: Float64Array;
  private readonly sSz: Float64Array;
  private readonly sLatP: Float64Array;
  private readonly sLatM: Float64Array;
  private readonly sForce: Float64Array;
  private readonly sLift: Float64Array;
  private readonly hArea: Float64Array;
  private readonly hCentroid: Float64Array;
  private readonly hNormal: Float64Array;
  private readonly hMa: Float64Array;
  private readonly hVn: Float64Array;
  private readonly hU: Float64Array;
  private readonly hCw: Float64Array;
  private readonly hCg: Float64Array;
  /** half-section index per wet triangle (−1 = not running surface) */
  private readonly wHalf: Int16Array;
  private readonly cellFy: Float64Array;
  private readonly cellA: Float64Array;
  private readonly cellAx: Float64Array;
  private readonly cellAz: Float64Array;
  private readonly cellAd: Float64Array;
  private readonly cellList: Int32Array;
  // Gauss–Seidel scratch: working velocities, inverse mass/inertia (body diag), body axes in world
  private readonly gv = new Float64Array(3);
  private readonly gw = new Float64Array(3);
  private readonly gsInvM = new Float64Array(3);
  private readonly gsInvI = new Float64Array(3);
  private readonly gsAxes = new Float64Array(9);
  private readonly j6 = new Float64Array(6);
  private readonly k6 = new Float64Array(36);
  private readonly minv6 = new Float64Array(36);
  private readonly s6 = new Float64Array(36);
  private readonly x6 = new Float64Array(6);
  private gsC6 = false;
  // lateral sections, per strip
  private readonly sDepMax: Float64Array;
  private readonly sDepMin: Float64Array;
  private readonly lMa: Float64Array;
  private readonly lPrev: Float64Array;
  private readonly lDir: Float64Array;
  private readonly lVL: Float64Array;
  private readonly lU: Float64Array;
  private readonly lF: Float64Array;
  /** water vertical velocity (∂η/∂t) at each half-section's rate point and each strip centroid, m/s (T189) */
  private readonly hWv: Float64Array;
  private readonly sWv: Float64Array;
  /** per half: vertical force of the EXPLICIT flux loads (the part V110 and passivity may scale) */
  private readonly sForceExpY: Float64Array;
  private readonly sForceTrY: Float64Array;
  /** explicit flux loads (rotating frame, Kirchhoff, lift, sway flux) of the last evaluate, world [force; torque about
   *  the CG], BEFORE the V110 and passivity scales: load = rawForce − (1 − capScale·passivityScale)·explicitLoad */
  readonly explicitLoad = new Float64Array(6);
  /** the momentum-TRANSFER part of explicitLoad (rotating frame, gyroscopic 6×6 part, Kirchhoff) — what passivity scales */
  readonly explicitTransferLoad = new Float64Array(6);
  private readonly expMark = new Float64Array(6);
  /** passivity credit: energy the entrained water holds / dissipation banked, J (T189) */
  private credit = 0;
  private readonly pv6 = new Float64Array(6);
  private readonly pa6 = new Float64Array(6);
  private readonly pb6 = new Float64Array(6);
  private readonly pl6 = new Float64Array(6);
  private readonly pd6 = new Float64Array(6);
  /** passivity scale applied to the explicit flux loads on the last evaluate (1 = none) */
  passivityScale = 1;
  /** radiation damping speed fade on the last evaluate (1 at rest, 0 planing) and its total vertical impulse, N·s */
  radiationScale = 0;
  radiationImpulse = 0;
  // drive
  steer = 0;
  throttle = 0;
  /** drive trim, rad (+ = trim out: the lower unit swings aft and up, the thrust line tips DOWN forward — bow up) */
  trim = 0;
  /** Surge boost fed to every engine (engine.ts EngineInput.boost; 1 = stock), set with `setBoost` */
  boost = 1;
  /** one engine + prop per drive (src/sea-physics/engine.ts, V77: THE rpm model; thrust, Governor and audio read it) */
  readonly engines: EngineState[];
  /** crank rpm per drive, last evaluate (= engines[k].rpm) */
  readonly driveRpm: Float64Array;
  /** last evaluate(): drive load (world, about the CG), NOT part of `load` (which stays the hull contact) */
  readonly driveForce: Vec3 = [0, 0, 0];
  readonly driveTorque: Vec3 = [0, 0, 0];
  /** gearcase immersed-span fraction and prop immersion per drive, last evaluate() */
  readonly gearcaseImmersion: Float64Array;
  readonly driveImmersion: Float64Array;
  /**
   * PER-DRIVE RESULTS of the last evaluate() (V77/V101: one thrust expression, consumers read it here — the prop
   * wash, spray, audio). `driveThrust[k]` N along the drive's line, SIGNED (reverse gear < 0; Σ|·| = `thrust`
   * when all signs agree); `driveProp[3k..]` the prop point, world; `driveDir[3k..]` the unit drive line (the
   * yawed body +z the thrust pushes along), world; `driveAdvance[k]` |advance speed| along it, m/s;
   * `driveThrustFactor[k]` = s^1.5, the immersion/ventilation fraction of the rated thrust (s = `driveImmersion`).
   * Filled for every drive whatever the throttle (thrust 0 at throttle 0).
   */
  readonly driveThrust: Float64Array;
  readonly driveProp: Float64Array;
  readonly driveDir: Float64Array;
  readonly driveAdvance: Float64Array;
  readonly driveThrustFactor: Float64Array;
  private readonly engineIn = { throttle: 0, advance: 0, immersion: 1, powerScale: 1, neutral: true, boost: 1 };
  /** foil lateral (side) force magnitude summed over drives, N (signed along body x) */
  foilSideForce = 0;
  thrust = 0;
  private readonly dr = new Float64Array(3);
  private readonly pnl = new Float64Array(8);
  /** per strip: sway-mode force direction f and moment m (world, per unit side force) */
  private readonly lJf: Float64Array;
  private readonly lJm: Float64Array;
  /** per half: panel weight w_h and panel normal n̂_h of its strip's sway mode */
  private readonly lpw: Float64Array;
  private readonly lJfD: Float64Array;
  private readonly lJmD: Float64Array;
  private readonly lpwD: Float64Array;
  private readonly lpn: Float64Array;
  /** geometric wet centroid and the lateral (antisymmetric) Wagner centre of pressure per half, world */
  private readonly hGeo: Float64Array;
  private readonly hLat: Float64Array;
  /** steady (symmetric Wagner) centre of pressure per half, world — the steady planing lift acts here */
  private readonly hSteady: Float64Array;
  private readonly sLiftSt: Float64Array;
  /** per strip: the sway rotating-frame load, deferred to the flux pass when `panelSuctionLimit` */
  private readonly lRotF: Float64Array;
  /** per half: hydrostatic force on its wet triangles (world), for the panel-pressure limit */
  private readonly hHyd: Float64Array;
  private readonly dd = new Float64Array(3);
  private readonly dn = new Float64Array(3);
  private readonly da = new Float64Array(3);
  // per-call pose cache
  private cgx = 0;
  private cgy = 0;
  private cgz = 0;
  private vx = 0;
  private vy = 0;
  private vz = 0;
  private wx = 0;
  private wy = 0;
  private wz = 0;
  private bzX = 0;
  private bzY = 0;
  private bzZ = 1;
  private uForward = true;
  private beamMax = 0;
  /** 2.5/(a_non·B·Fn_B); 0 ⇒ no reduction (at rest, or disabled) */
  private garmeK = 0;
  private trailWet = 0;
  /** transom keel point (world) and its depth below the local surface, last evaluate (0 when not running forward) */
  private trX = 0;
  private trZ = 0;
  private trDepth = 0;
  private fX = 0;
  private fY = 0;
  private fZ = 0;
  private tX = 0;
  private tY = 0;
  private tZ = 0;

  constructor(
    readonly mesh: HullWaterMesh,
    params: Partial<HullWaterParams> = {},
  ) {
    this.params = { ...HULL_WATER_DEFAULTS, ...params };
    this.patch = new WaterPatch(this.params.patchMaxAxis);
    const nV = mesh.vertexCount;
    const cap = mesh.triCount * 2;
    const ns = mesh.strips.count;
    this.px = new Float64Array(nV);
    this.py = new Float64Array(nV);
    this.pz = new Float64Array(nV);
    this.pd = new Float64Array(nV);
    this.wet = {
      count: 0,
      centroid: new Float64Array(cap * 3),
      normal: new Float64Array(cap * 3),
      area: new Float64Array(cap),
      depth: new Float64Array(cap),
      vel: new Float64Array(cap * 3),
      strip: new Int16Array(cap),
      fy: new Float64Array(cap),
      sigma: new Float64Array(cap),
    };
    this.waterline = {
      count: 0,
      a: new Float64Array(mesh.triCount * 3),
      b: new Float64Array(mesh.triCount * 3),
      vn: new Float64Array(mesh.triCount),
    };
    this.sections = {
      count: ns,
      c: new Float64Array(ns),
      d: new Float64Array(ns),
      vn: new Float64Array(ns),
      u: new Float64Array(ns),
      ma: new Float64Array(ns),
      dmadt: new Float64Array(ns),
      sprayRoot: new Float64Array(ns),
      wetArea: new Float64Array(ns),
      slam: new Float64Array(ns),
      normal: new Float64Array(ns * 3),
      centroid: new Float64Array(ns * 3),
    };
    this.prevMa = new Float64Array(2 * ns);
    this.hGeo = new Float64Array(2 * ns * 3);
    this.lJf = new Float64Array(ns * 3);
    this.lJm = new Float64Array(ns * 3);
    this.lpw = new Float64Array(2 * ns);
    this.lJfD = new Float64Array(ns * 3);
    this.lJmD = new Float64Array(ns * 3);
    this.lpwD = new Float64Array(2 * ns);
    this.lpn = new Float64Array(2 * ns * 3);
    this.hLat = new Float64Array(2 * ns * 3);
    this.hSteady = new Float64Array(2 * ns * 3);
    this.sLiftSt = new Float64Array(2 * ns);
    this.lRotF = new Float64Array(ns);
    this.hHyd = new Float64Array(2 * ns * 3);
    this.sDepMax = new Float64Array(ns);
    this.sDepMin = new Float64Array(ns);
    this.lMa = new Float64Array(ns);
    this.lPrev = new Float64Array(ns);
    this.lDir = new Float64Array(ns * 3);
    this.lVL = new Float64Array(ns);
    this.lU = new Float64Array(ns);
    this.lF = new Float64Array(ns);
    const nd = mesh.drives ? mesh.drives.length : 0;
    this.gearcaseImmersion = new Float64Array(nd);
    this.driveImmersion = new Float64Array(nd);
    this.driveThrust = new Float64Array(nd);
    this.driveProp = new Float64Array(nd * 3);
    this.driveDir = new Float64Array(nd * 3);
    this.driveAdvance = new Float64Array(nd);
    this.driveThrustFactor = new Float64Array(nd);
    this.driveRpm = new Float64Array(nd);
    this.engines = [];
    for (let k = 0; k < nd; k++) this.engines.push(createEngineState(this.params.engine));
    this.hWv = new Float64Array(2 * ns);
    this.sWv = new Float64Array(ns);
    this.sForceExpY = new Float64Array(2 * ns);
    this.sForceTrY = new Float64Array(2 * ns);
    {
      const cells = this.params.patchMaxAxis * this.params.patchMaxAxis;
      this.wake = {
        count: 0,
        x: new Float64Array(cells),
        z: new Float64Array(cells),
        fy: new Float64Array(cells),
        sigma: new Float64Array(cells),
        depth: new Float64Array(cells),
        deficit: 0,
        rescale: 1,
      };
      this.cellFy = new Float64Array(cells);
      this.cellA = new Float64Array(cells);
      this.cellAx = new Float64Array(cells);
      this.cellAz = new Float64Array(cells);
      this.cellAd = new Float64Array(cells);
      this.cellList = new Int32Array(cells);
    }
    // per HALF-section (index 2·strip + side, side 0 = −x, 1 = +x)
    this.sSx = new Float64Array(2 * ns);
    this.sSy = new Float64Array(2 * ns);
    this.sSz = new Float64Array(2 * ns);
    this.sLatP = new Float64Array(2 * ns);
    this.sLatM = new Float64Array(2 * ns);
    this.sForce = new Float64Array(2 * ns * 3);
    this.sLift = new Float64Array(2 * ns);
    this.hArea = new Float64Array(2 * ns);
    this.hCentroid = new Float64Array(2 * ns * 3);
    this.hNormal = new Float64Array(2 * ns * 3);
    this.hMa = new Float64Array(2 * ns);
    this.hVn = new Float64Array(2 * ns);
    this.hU = new Float64Array(2 * ns);
    this.hCw = new Float64Array(2 * ns);
    this.hCg = new Float64Array(2 * ns);
    this.wHalf = new Int16Array(mesh.triCount * 2);
    this.load = { force: [0, 0, 0], torque: [0, 0, 0], addedMass: [0, 0, 0], addedInertia: [0, 0, 0] };
  }

  /** V108: forget every per-location memory (teleport, respawn, LOD handoff) */
  resetMemory(): void {
    this.prevMa.fill(0);
    this.lPrev.fill(0);
    this.prevAdded.fill(0);
    this.hasPrev = false;
    this.credit = 0;
    this.patch.forgetPrevious();
  }

  /** the engines back to idle (a respawn with the engine stalled/restarted; not part of `resetMemory`, which is location) */
  resetEngines(): void {
    for (const e of this.engines) resetEngineState(e, this.params.engine);
    this.driveRpm.fill(0);
  }

  /** once per tick, before the substeps */
  samplePatch(sampler: HeightSampler, state: Readonly<Rigid6State>, dt: number): void {
    this.patch.build(sampler, this.mesh, state, dt, this.params.patchSpacing, this.params.patchMargin);
  }

  /** a rigid6 force callback that evaluates this contact once per substep */
  forceFn(): Rigid6ForceFn {
    return (state, h, out) => this.evaluate(state, h, out);
  }

  /**
   * THE per-substep contact (V101). Fills every buffer and ACCUMULATES the hydro load
   * into `out` (also copied to `this.load`). Must be called exactly once per substep:
   * dm_a/dt is taken against the previous call.
   */
  evaluate(state: Readonly<Rigid6State>, h: number, out?: Rigid6Load): void {
    const mesh = this.mesh;
    const prm = this.params;
    const rho = prm.rho;
    const [qx, qy, qz, qw] = state.quaternion as Quat;
    const cgx = (this.cgx = state.position[0]);
    const cgy = (this.cgy = state.position[1]);
    const cgz = (this.cgz = state.position[2]);
    const vx = (this.vx = state.velocity[0]);
    const vy = (this.vy = state.velocity[1]);
    const vz = (this.vz = state.velocity[2]);
    const wx = (this.wx = state.angularVelocity[0]);
    const wy = (this.wy = state.angularVelocity[1]);
    const wz = (this.wz = state.angularVelocity[2]);
    const patch = this.patch;

    // ITTC-57 at the hull's speed through the water (one Rn per call)
    // Garme near-transom reduction: C_T(x_T) = tanh(garmeK·x_T), garmeK = 2.5/(a_non·B·Fn_B)
    {
      const zx = 2 * (qx * qz + qw * qy);
      const zy = 2 * (qy * qz - qw * qx);
      const zz = 1 - 2 * (qx * qx + qy * qy);
      this.bzX = zx;
      this.bzY = zy;
      this.bzZ = zz;
      const uCg = vx * zx + vy * zy + vz * zz;
      this.uForward = uCg >= 0;
      let bMax = 0;
      for (let i = 0; i < mesh.strips.count; i++) bMax = Math.max(bMax, 2 * mesh.strips.chineHalfBeam[i]);
      this.beamMax = bMax;
      const fnB = bMax > 0 ? Math.abs(uCg) / Math.sqrt(prm.gravity * bMax) : 0;
      const denom = prm.garmeANon * bMax * fnB;
      this.garmeK = prm.garmeANon > 0 && denom > 1e-9 ? 2.5 / denom : 0;
      this.trailWet = 0;
      this.trDepth = 0;
      if (this.garmeK > 0 && mesh.strips.count > 0) {
        const si = this.uForward ? 0 : mesh.strips.count - 1;
        const bxk = 0;
        const byk = mesh.strips.keelY[si];
        const bzk = this.uForward ? mesh.transomZ : mesh.stemZ;
        const tx = 2 * (qy * bzk - qz * byk);
        const ty = 2 * (qz * bxk - qx * bzk);
        const tz = 2 * (qx * byk - qy * bxk);
        const x = cgx + bxk + qw * tx + (qy * tz - qz * ty);
        const y = cgy + byk + qw * ty + (qz * tx - qx * tz);
        const z = cgz + bzk + qw * tz + (qx * ty - qy * tx);
        const dT = this.patch.heightAt(x, z) - y;
        this.trX = x;
        this.trZ = z;
        this.trDepth = this.uForward ? dT : 0;
        const fnT = dT > 1e-6 ? Math.abs(uCg) / Math.sqrt(prm.gravity * dT) : Infinity;
        const e = Math.min(1, Math.max(0, (fnT - TRANSOM_WET_FN) / (TRANSOM_DRY_FN - TRANSOM_WET_FN)));
        this.trailWet = 1 - e * e * (3 - 2 * e);
      }
    }

    // ---- vertices → world, depth below the patch surface
    const P = mesh.positions;
    const PX = this.px;
    const PY = this.py;
    const PZ = this.pz;
    const PD = this.pd;
    for (let i = 0; i < mesh.vertexCount; i++) {
      const bx = P[i * 3];
      const by = P[i * 3 + 1];
      const bz = P[i * 3 + 2];
      const tx = 2 * (qy * bz - qz * by);
      const ty = 2 * (qz * bx - qx * bz);
      const tz = 2 * (qx * by - qy * bx);
      const x = cgx + bx + qw * tx + (qy * tz - qz * ty);
      const y = cgy + by + qw * ty + (qz * tx - qx * tz);
      const z = cgz + bz + qw * tz + (qx * ty - qy * tx);
      PX[i] = x;
      PY[i] = y;
      PZ[i] = z;
      PD[i] = patch.heightAt(x, z) - y;
    }

    // ---- reset accumulators
    const ns = mesh.strips.count;
    const S = this.sections;
    this.sSx.fill(0);
    this.sSy.fill(0);
    this.sSz.fill(0);
    this.sLatP.fill(0);
    this.sLatM.fill(0);
    S.wetArea.fill(0);
    S.centroid.fill(0);
    this.sDepMax.fill(0);
    this.sDepMin.fill(Infinity);
    this.hArea.fill(0);
    this.hCentroid.fill(0);
    this.hHyd.fill(0);
    this.wet.count = 0;
    this.waterline.count = 0;
    this.fX = this.fY = this.fZ = 0;
    this.tX = this.tY = this.tZ = 0;
    this.wettedArea = 0;
    this.displacedVolume = 0;
    this.explicitLoad.fill(0);
    this.explicitTransferLoad.fill(0);
    this.sForceExpY.fill(0);
    this.sForceTrY.fill(0);

    // body x̂ in world, for the lateral projected areas
    const bxx = 1 - 2 * (qy * qy + qz * qz);
    const bxy = 2 * (qx * qy + qw * qz);
    const bxz = 2 * (qx * qz - qw * qy);
    this.latX = bxx;
    this.latY = bxy;
    this.latZ = bxz;

    // ---- clip (Kerner 4 cases)
    const I = mesh.indices;
    for (let t = 0; t < mesh.triCount; t++) {
      const i0 = I[t * 3];
      const i1 = I[t * 3 + 1];
      const i2 = I[t * 3 + 2];
      const d0 = PD[i0];
      const d1 = PD[i1];
      const d2 = PD[i2];
      const nSub = (d0 > 0 ? 1 : 0) + (d1 > 0 ? 1 : 0) + (d2 > 0 ? 1 : 0);
      if (nSub === 0) continue;
      const strip = mesh.triStrip[t];
      if (nSub === 3) {
        this.emit(PX[i0], PY[i0], PZ[i0], PX[i1], PY[i1], PZ[i1], PX[i2], PY[i2], PZ[i2], d0, d1, d2, strip);
        continue;
      }
      // rotate (keeping winding) so the odd vertex is `a`
      let a = i0;
      let b = i1;
      let c = i2;
      const odd = nSub === 1 ? (d0 > 0 ? 0 : d1 > 0 ? 1 : 2) : d0 <= 0 ? 0 : d1 <= 0 ? 1 : 2;
      if (odd === 1) {
        a = i1;
        b = i2;
        c = i0;
      } else if (odd === 2) {
        a = i2;
        b = i0;
        c = i1;
      }
      const da = PD[a];
      const db = PD[b];
      const dc = PD[c];
      const tb = da / (da - db);
      const tc = da / (da - dc);
      const ibx = PX[a] + (PX[b] - PX[a]) * tb;
      const iby = PY[a] + (PY[b] - PY[a]) * tb;
      const ibz = PZ[a] + (PZ[b] - PZ[a]) * tb;
      const icx = PX[a] + (PX[c] - PX[a]) * tc;
      const icy = PY[a] + (PY[c] - PY[a]) * tc;
      const icz = PZ[a] + (PZ[c] - PZ[a]) * tc;
      this.pushSegment(ibx, iby, ibz, icx, icy, icz, PX[a], PY[a], PZ[a], PX[b], PY[b], PZ[b], PX[c], PY[c], PZ[c]);
      if (nSub === 1) {
        this.emit(PX[a], PY[a], PZ[a], ibx, iby, ibz, icx, icy, icz, da, 0, 0, strip);
      } else {
        this.emit(ibx, iby, ibz, PX[b], PY[b], PZ[b], PX[c], PY[c], PZ[c], 0, db, dc, strip);
        this.emit(ibx, iby, ibz, PX[c], PY[c], PZ[c], icx, icy, icz, 0, dc, 0, strip);
      }
    }
    // ---- 2D+t sections, split into PORT and STARBOARD HALF-SECTIONS (asymmetric wedge, doc §2.3
    //      "tilted by the local heel"). Each half carries its share of the section's added mass, its own
    //      normal velocity and upwind momentum flux, and acts at its own wet centroid along the SECTION
    //      normal. A symmetric section gives exactly the full-section 2D+t; a ROLLING section gets the
    //      lift difference across the keel that is its roll damping, a HEELED one the asymmetric-wedge
    //      restoring. The strip-mean form averaged the roll-rate normal velocity away across the keel:
    //      linearised roll damping −0.3 kN·m·s (now −5…−7) and roll stiffness turning positive at C_v 10
    //      (now −31…−59 kN·m/rad) — a ±27–31° roll limit cycle at C_v 8 and capsize at 9–10.
    const m = mesh.mass;
    // body axes in world
    const byx = 2 * (qx * qy - qw * qz);
    const byy = 1 - 2 * (qx * qx + qz * qz);
    const byz = 2 * (qy * qz + qw * qx);
    const bzx = 2 * (qx * qz + qw * qy);
    const bzy = 2 * (qy * qz - qw * qx);
    const bzz = 1 - 2 * (qx * qx + qy * qy);
    let Ax = 0;
    let Ay = 0;
    let dIx = 0;
    let dIy = 0;
    let dIz = 0;
    let slamJx = 0;
    let slamJy = 0;
    let slamJz = 0;
    let slamLx = 0;
    let slamLy = 0;
    let slamLz = 0;
    this.slamImpulse = 0;
    const SF = this.sForce;
    SF.fill(0);
    S.slam.fill(0);
    S.dmadt.fill(0);
    const dz = mesh.strips.dz;
    const k = prm.addedMassCoeff;
    const nh = 2 * ns;
    const HA = this.hArea;
    const HC = this.hCentroid;
    const HN = this.hNormal;
    const HMA = this.hMa;
    const HVN = this.hVn;
    const HU = this.hU;
    const HCW = this.hCw;
    const HCG = this.hCg;
    // strip totals and centroids from the halves
    for (let i = 0; i < ns; i++) {
      const A = HA[2 * i] + HA[2 * i + 1];
      S.wetArea[i] = A;
      if (A <= 1e-9) continue;
      S.centroid[i * 3] = (HC[i * 6] + HC[i * 6 + 3]) / A;
      S.centroid[i * 3 + 1] = (HC[i * 6 + 1] + HC[i * 6 + 4]) / A;
      S.centroid[i * 3 + 2] = (HC[i * 6 + 2] + HC[i * 6 + 5]) / A;
    }
    for (let hI = 0; hI < nh; hI++) {
      const A = HA[hI];
      if (A <= 1e-9) continue;
      HC[hI * 3] /= A;
      HC[hI * 3 + 1] /= A;
      HC[hI * 3 + 2] /= A;
      for (let c = 0; c < 3; c++) this.hGeo[hI * 3 + c] = this.hLat[hI * 3 + c] = HC[hI * 3 + c];
    }
    HMA.fill(0);
    HVN.fill(0);
    HU.fill(0);
    HCW.fill(0);
    HCG.fill(0);
    const chineWet = prm.chineWetAddedMass && !!mesh.strips.chineV0 && !!mesh.strips.deadrise;
    const waterVel = prm.waterVelocity;
    this.hWv.fill(0);
    this.sWv.fill(0);
    if (prm.planing) {
      for (let i = 0; i < ns; i++) {
        let nX = 0;
        let nY = 0;
        let nZ = 0;
        let cgSum = 0;
        let maSum = 0;
        let vnW = 0;
        let uW = 0;
        let cRms = 0;
        if (S.wetArea[i] > 1e-9) {
          // SECTION normal from both halves (⊥ body z)
          let sx = this.sSx[2 * i] + this.sSx[2 * i + 1];
          let sy = this.sSy[2 * i] + this.sSy[2 * i + 1];
          let sz = this.sSz[2 * i] + this.sSz[2 * i + 1];
          const along = sx * bzx + sy * bzy + sz * bzz;
          sx -= along * bzx;
          sy -= along * bzy;
          sz -= along * bzz;
          const aProj = Math.sqrt(sx * sx + sy * sy + sz * sz);
          if (aProj > 1e-9) {
            nX = sx / aProj;
            nY = sy / aProj;
            nZ = sz / aProj;
            for (let side = 0; side < 2; side++) {
              const hI = 2 * i + side;
              HN[hI * 3] = nX;
              HN[hI * 3 + 1] = nY;
              HN[hI * 3 + 2] = nZ;
              if (HA[hI] <= 1e-9) continue;
              // The SECTION keeps the full-section Wagner c and m_a (so a symmetric section is exactly the
              // strip model and the chine cap acts on the section); each half takes the share c_g,half² /
              // Σ c_g² of it, from its own UNCAPPED wetted width projected on the section normal (the
              // lower half of a heeled wedge carries more — asymmetric-wedge restoring that survives a
              // wet chine). Measured alternatives: shares by wetted area lost roll stiffness at C_v ≥ 7
              // (capsize at 9); a per-half chine cap lost it at C_v ≤ 5 (13° loll).
              const cG = aProj / (2 * dz);
              const cW = Math.min(HALF_PI * cG, mesh.strips.chineHalfBeam[i]);
              const cgP = Math.max(0, (this.sSx[2 * i] * nX + this.sSy[2 * i] * nY + this.sSz[2 * i] * nZ) / dz);
              const cgS = Math.max(0, (this.sSx[2 * i + 1] * nX + this.sSy[2 * i + 1] * nY + this.sSz[2 * i + 1] * nZ) / dz);
              const cgH = side === 0 ? cgP : cgS;
              const share = cgP * cgP + cgS * cgS > 0 ? (cgH * cgH) / (cgP * cgP + cgS * cgS) : 0.5;
              let ma = k * rho * HALF_PI * cW * cW * share;
              if (chineWet) ma += k * rho * HALF_PI * this.chineWetGrowth(i, side);
              if (prm.planingFacing) ma *= this.panelFacing(this.sSx[hI], this.sSy[hI], this.sSz[hI], bzx, bzy, bzz);
              this.placeCentresOfPressure(hI, i, cgH, byx, byy, byz, bzx, bzy, bzz);
              const rx = HC[hI * 3] - cgx;
              const ry = HC[hI * 3 + 1] - cgy;
              const rz = HC[hI * 3 + 2] - cgz;
              if (waterVel) this.hWv[hI] = patch.verticalVelocityAt(HC[hI * 3], HC[hI * 3 + 2]);
              const pvx = vx + (wy * rz - wz * ry);
              const pvy = vy + (wz * rx - wx * rz) - this.hWv[hI];
              const pvz = vz + (wx * ry - wy * rx);
              HCG[hI] = cG;
              HCW[hI] = cW;
              HMA[hI] = ma;
              HVN[hI] = -(pvx * nX + pvy * nY + pvz * nZ);
              HU[hI] = pvx * bzx + pvy * bzy + pvz * bzz;
              cgSum += cG;
              maSum += ma;
              vnW += ma * HVN[hI];
              uW += HA[hI] * HU[hI];
              cRms += cW * cW;
            }
          }
        }
        S.c[i] = Math.sqrt(cRms / 2);
        S.sprayRoot[i] = (HALF_PI * cgSum) / 2;
        S.ma[i] = maSum;
        S.vn[i] = maSum > 0 ? vnW / maSum : 0;
        S.u[i] = S.wetArea[i] > 1e-9 ? uW / S.wetArea[i] : 0;
        S.normal[i * 3] = nX;
        S.normal[i * 3 + 1] = nY;
        S.normal[i * 3 + 2] = nZ;
        // keel immersion at the strip centre
        {
          const bxk = 0;
          const byk = mesh.strips.keelY[i];
          const bzk = mesh.strips.zCentre[i];
          const tx = 2 * (qy * bzk - qz * byk);
          const ty = 2 * (qz * bxk - qx * bzk);
          const tz = 2 * (qx * byk - qy * bxk);
          const x = cgx + bxk + qw * tx + (qy * tz - qz * ty);
          const y = cgy + byk + qw * ty + (qz * tx - qx * tz);
          const z = cgz + bzk + qw * tz + (qx * ty - qy * tx);
          S.d[i] = patch.heightAt(x, z) - y;
        }
      }
      // ---- LATERAL (SWAY) SECTIONS: each wet strip also carries a sway added mass along its lateral axis
      //      L̂ = N̂ × ẑ_b (in the section plane, ⊥ the heave normal). Lewis-form/ellipse result: a body moving
      //      along one semi-axis carries ρπ·(other semi-axis)² per length; the free surface at impact/high
      //      frequency is φ = 0, so the wetted half-body carries half of the doubled body's value —
      //      m_lat = k_lat·ρ·(π/2)·d², d = the section's wetted depth (lowest wet point to the waterline). The
      //      same law gives the heave m_a = ρ(π/2)c² (semi-axes swapped), so heave and sway share one
      //      convention; a deep-V is DEEP for its beam, which is how deadrise gives grip, and a wet chine adds
      //      the side depth. (Faltinsen 2005 ch. 9 slender-body maneuvering; Newman 1977 §4.13 added mass.)
      {
        const kl = prm.lateralAddedMassCoeff;
        for (let i = 0; i < ns; i++) {
          this.lMa[i] = 0;
          this.lpw[2 * i] = this.lpw[2 * i + 1] = this.lpwD[2 * i] = this.lpwD[2 * i + 1] = 0;
          this.lVL[i] = 0;
          this.lU[i] = 0;
          const nX = S.normal[i * 3];
          const nY = S.normal[i * 3 + 1];
          const nZ = S.normal[i * 3 + 2];
          if (kl <= 0 || S.wetArea[i] <= 1e-9 || nX * nX + nY * nY + nZ * nZ < 0.5) continue;
          const lx = nY * bzz - nZ * bzy;
          const ly = nZ * bzx - nX * bzz;
          const lz = nX * bzy - nY * bzx;
          this.lDir[i * 3] = lx;
          this.lDir[i * 3 + 1] = ly;
          this.lDir[i * 3 + 2] = lz;
          const d = Math.max(0, this.sDepMax[i] - Math.max(0, this.sDepMin[i]));
          this.lMa[i] = kl * rho * HALF_PI * d * d;
          if (prm.planingFacing) this.lMa[i] *= this.panelFacing(nX, nY, nZ, bzx, bzy, bzz);
          const rx = S.centroid[i * 3] - cgx;
          const ry = S.centroid[i * 3 + 1] - cgy;
          const rz = S.centroid[i * 3 + 2] - cgz;
          this.lU[i] = (vx + (wy * rz - wz * ry)) * bzx + (vy + (wz * rx - wx * rz)) * bzy + (vz + (wx * ry - wy * rx)) * bzz;
          this.lateralJacobian(i, lx, ly, lz, rx, ry, rz, bzx, bzy, bzz);
          const JF = this.lJf;
          const JM = this.lJm;
          if (waterVel) this.sWv[i] = patch.verticalVelocityAt(S.centroid[i * 3], S.centroid[i * 3 + 2]);
          this.lVL[i] = JF[i * 3] * vx + JF[i * 3 + 1] * (vy - this.sWv[i]) + JF[i * 3 + 2] * vz + JM[i * 3] * wx + JM[i * 3 + 1] * wy + JM[i * 3 + 2] * wz;
        }
        for (let i = 0; i < ns; i++) {
          const ml = this.lMa[i];
          if (ml <= 0) continue;
          const o = i * 3;
          const F = this.lJf;
          const Mv = this.lJm;
          const fbx = F[o] * bxx + F[o + 1] * bxy + F[o + 2] * bxz;
          const fby = F[o] * byx + F[o + 1] * byy + F[o + 2] * byz;
          const mbx = Mv[o] * bxx + Mv[o + 1] * bxy + Mv[o + 2] * bxz;
          const mby = Mv[o] * byx + Mv[o + 1] * byy + Mv[o + 2] * byz;
          const mbz = Mv[o] * bzx + Mv[o + 1] * bzy + Mv[o + 2] * bzz;
          const mdz = ml * dz;
          Ax += mdz * fbx * fbx;
          Ay += mdz * fby * fby;
          dIx += mdz * mbx * mbx;
          dIy += mdz * mby * mby;
          dIz += mdz * mbz * mbz;
        }
      }
      // added mass from the half-sections (diagonal about the CG, §V69)
      for (let hI = 0; hI < nh; hI++) {
        const ma = HMA[hI];
        if (ma <= 0) continue;
        const nX = HN[hI * 3];
        const nY = HN[hI * 3 + 1];
        const nZ = HN[hI * 3 + 2];
        const rx = HC[hI * 3] - cgx;
        const ry = HC[hI * 3 + 1] - cgy;
        const rz = HC[hI * 3 + 2] - cgz;
        const nbx = nX * bxx + nY * bxy + nZ * bxz;
        const nby = nX * byx + nY * byy + nZ * byz;
        const nbz = nX * bzx + nY * bzy + nZ * bzz;
        const rbx = rx * bxx + ry * bxy + rz * bxz;
        const rby = rx * byx + ry * byy + rz * byz;
        const rbz = rx * bzx + ry * bzy + rz * bzz;
        const mdz = ma * dz;
        Ax += mdz * nbx * nbx;
        Ay += mdz * nby * nby;
        const cxb = rby * nbz - rbz * nby;
        const cyb = rbz * nbx - rbx * nbz;
        const czb = rbx * nby - rby * nbx;
        dIx += mdz * cxb * cxb;
        dIy += mdz * cyb * cyb;
        dIz += mdz * (czb * czb + (HCW[hI] * HCW[hI]) / 8);
      }
    } else {
      S.c.fill(0);
      S.ma.fill(0);
      S.vn.fill(0);
      S.u.fill(0);
      S.sprayRoot.fill(0);
      S.d.fill(0);
    }
    const Az = prm.surgeAddedMassRatio * m * Math.min(1, (this.displacedVolume * rho) / m);
    const C6 = prm.coupledAddedMass && prm.planing;
    if (C6) {
      const K6 = this.k6;
      K6.fill(0);
      const hp = this.hasPrev;
      for (let hI = 0; hI < nh; hI++) {
        const ma = HMA[hI];
        if (ma <= 0 && !(hp && this.prevMa[hI] > 0)) continue;
        const nX = HN[hI * 3];
        const nY = HN[hI * 3 + 1];
        const nZ = HN[hI * 3 + 2];
        const rx = HC[hI * 3] - cgx;
        const ry = HC[hI * 3 + 1] - cgy;
        const rz = HC[hI * 3 + 2] - cgz;
        const J = this.j6;
        J[0] = nX * bxx + nY * bxy + nZ * bxz;
        J[1] = nX * byx + nY * byy + nZ * byz;
        J[2] = nX * bzx + nY * bzy + nZ * bzz;
        const rbx = rx * bxx + ry * bxy + rz * bxz;
        const rby = rx * byx + ry * byy + rz * byz;
        const rbz = rx * bzx + ry * bzy + rz * bzz;
        J[3] = rby * J[2] - rbz * J[1];
        J[4] = rbz * J[0] - rbx * J[2];
        J[5] = rbx * J[1] - rby * J[0];
        const aK = (hp ? Math.min(this.prevMa[hI], ma) : ma) * dz;
        for (let r = 0; r < 6; r++) {
          const kr = aK * J[r];
          for (let c = r; c < 6; c++) K6[r * 6 + c] += kr * J[c];
        }
        K6[35] += (aK * (HCW[hI] * HCW[hI])) / 8;
      }
      for (let i = 0; i < ns; i++) {
        const ml = this.lMa[i];
        if (ml <= 0 && !(hp && this.lPrev[i] > 0)) continue;
        const J = this.j6;
        const o = i * 3;
        const F = this.lJf;
        const Mv = this.lJm;
        J[0] = F[o] * bxx + F[o + 1] * bxy + F[o + 2] * bxz;
        J[1] = F[o] * byx + F[o + 1] * byy + F[o + 2] * byz;
        J[2] = F[o] * bzx + F[o + 1] * bzy + F[o + 2] * bzz;
        J[3] = Mv[o] * bxx + Mv[o + 1] * bxy + Mv[o + 2] * bxz;
        J[4] = Mv[o] * byx + Mv[o + 1] * byy + Mv[o + 2] * byz;
        J[5] = Mv[o] * bzx + Mv[o + 1] * bzy + Mv[o + 2] * bzz;
        const aK = (hp ? Math.min(this.lPrev[i], ml) : ml) * dz;
        for (let r = 0; r < 6; r++) {
          const kr = aK * J[r];
          for (let c = r; c < 6; c++) K6[r * 6 + c] += kr * J[c];
        }
      }
      K6[14] += Az;
      for (let r = 1; r < 6; r++) for (let c = 0; c < r; c++) K6[r * 6 + c] = K6[c * 6 + r];
      // (M + K6)⁻¹ by columns
      const S6m = this.s6;
      const X = this.x6;
      const Mi = this.minv6;
      for (let k = 0; k < 36; k++) S6m[k] = K6[k];
      S6m[0] += m;
      S6m[7] += m;
      S6m[14] += m;
      S6m[21] += mesh.inertia[0];
      S6m[28] += mesh.inertia[1];
      S6m[35] += mesh.inertia[2];
      if (!factorSpd6(S6m)) throw new Error('hullWater: coupled added-mass matrix is not positive definite');
      for (let c = 0; c < 6; c++) {
        X.fill(0);
        X[c] = 1;
        solveFactored6(S6m, X);
        for (let r = 0; r < 6; r++) Mi[r * 6 + c] = X[r];
      }
    }

    if (prm.planing) {
      // ---- slam: inelastic momentum exchange, Gauss–Seidel over half-sections, with the SAME inverse
      //      mass rigid6 divides this substep's impulse by: m + min(A_old, A_new)
      const pa = this.prevAdded;
      const hp = this.hasPrev;
      this.gsInvM[0] = 1 / (m + (hp ? Math.min(pa[0], Ax) : Ax));
      this.gsInvM[1] = 1 / (m + (hp ? Math.min(pa[1], Ay) : Ay));
      this.gsInvM[2] = 1 / (m + (hp ? Math.min(pa[2], Az) : Az));
      this.gsInvI[0] = 1 / (mesh.inertia[0] + (hp ? Math.min(pa[3], dIx) : dIx));
      this.gsInvI[1] = 1 / (mesh.inertia[1] + (hp ? Math.min(pa[4], dIy) : dIy));
      this.gsInvI[2] = 1 / (mesh.inertia[2] + (hp ? Math.min(pa[5], dIz) : dIz));
      this.gsC6 = C6;
      this.gsAxes[0] = bxx;
      this.gsAxes[1] = bxy;
      this.gsAxes[2] = bxz;
      this.gsAxes[3] = byx;
      this.gsAxes[4] = byy;
      this.gsAxes[5] = byz;
      this.gsAxes[6] = bzx;
      this.gsAxes[7] = bzy;
      this.gsAxes[8] = bzz;
      this.gv[0] = vx;
      this.gv[1] = vy;
      this.gv[2] = vz;
      this.gw[0] = wx;
      this.gw[1] = wy;
      this.gw[2] = wz;
      for (let hI = 0; hI < nh; hI++) {
        const ma = HMA[hI];
        const dA = (ma - this.prevMa[hI]) * dz;
        const strip = hI >> 1;
        if (hp) S.dmadt[strip] += (ma - this.prevMa[hI]) / h;
        if (!hp || dA === 0 || HA[hI] <= 1e-9) continue;
        const nX = HN[hI * 3];
        const nY = HN[hI * 3 + 1];
        const nZ = HN[hI * 3 + 2];
        const vn = -this.pointVelAlong(hI, nX, nY, nZ);
        if (vn <= 0) continue;
        const wInv = this.gsInvMass(hI, nX, nY, nZ);
        // V_n·dm_a/dt in BOTH directions while the section still penetrates (V_n > 0): a running
        // section whose wetted beam shrinks sheds the momentum flux it carried (a downward load). The
        // entry-only form halved the steady-flow heave/pitch damping U·sinτ·∂m_a/∂z and, with it,
        // left a 1.3 s limit cycle at C_v ≤ 3.7. A section moving OUT of the water (V_n ≤ 0) gets
        // nothing, so a landing still loses its momentum and is never handed it back (§V70).
        const J = dA > 0 ? (dA * vn) / (1 + dA * wInv) : dA * vn;
        S.slam[strip] += J;
        this.slamImpulse += J;
        this.gsApply(hI, nX, nY, nZ, J);
        const rx = HC[hI * 3] - cgx;
        const ry = HC[hI * 3 + 1] - cgy;
        const rz = HC[hI * 3 + 2] - cgz;
        const jx = J * nX;
        const jy = J * nY;
        const jz = J * nZ;
        slamJx += jx;
        slamJy += jy;
        slamJz += jz;
        slamLx += ry * jz - rz * jy;
        slamLy += rz * jx - rx * jz;
        slamLz += rx * jy - ry * jx;
        SF[hI * 3] += jx / h;
        SF[hI * 3 + 1] += jy / h;
        SF[hI * 3 + 2] += jz / h;
      }
      // ---- lateral entry exchange: sway added mass that GROWS takes up the point's lateral velocity
      //      inelastically (the heave slam's law on the lateral axis); shrinking water leaves with its momentum
      if (hp) {
        for (let i = 0; i < ns; i++) {
          const ml = this.lMa[i];
          const dA = (ml - this.lPrev[i]) * dz;
          if (!(dA > 0)) continue;
          const V = this.gsVelJ(i);
          if (V === 0) continue;
          const wInv = this.gsInvMassJ(i);
          const J = (-dA * V) / (1 + dA * wInv);
          this.gsApply(-1, 0, 0, 0, J);
          this.addLateralStripForce(i, J / h);
        }
      }
      // ---- crossflow drag (normal ½ρ·C_Dc·c_half·V_n|V_n| per half, lateral ½ρ·C_Dc·A_side·V|V|) as
      //      velocity-level impulses in the SAME Gauss–Seidel pass: the explicit force form is stiff
      //      (a flat 25 m/s entry: B·h/m ≫ 2, measured bounce to +20 m/s at one substep).
      const halfRhoCd = 0.5 * rho * prm.crossflowDrag;
      for (let hI = 0; hI < nh; hI++) {
        if (HA[hI] <= 1e-9) continue;
        if (HMA[hI] > 0) this.gsDrag(hI, HN[hI * 3], HN[hI * 3 + 1], HN[hI * 3 + 2], halfRhoCd * 2 * HCW[hI] * (HMA[hI] / S.ma[hI >> 1]) * dz, h); // the half's share of ½ρ·C_Dc·2c
      }
      // lateral crossflow drag per strip on its sway Jacobian (velocity, inverse mass and force all through the
      // same panel-pressure mode — see lateralJacobian)
      for (let i = 0; i < ns; i++) {
        if (this.lMa[i] <= 0) continue;
        const V = this.gsVelJ(i, true);
        if (V === 0) continue;
        const aSide = V > 0 ? this.sLatP[2 * i] + this.sLatP[2 * i + 1] : this.sLatM[2 * i] + this.sLatM[2 * i + 1];
        if (!(aSide > 0)) continue;
        const kd = halfRhoCd * aSide * Math.abs(V) * h;
        const w = this.gsInvMassJ(i, true);
        const J = (-kd * V) / (1 + kd * w);
        this.gsApply(-1, 0, 0, 0, J);
        this.addLateralStripForce(i, J / h, true);
      }
      // ---- zero-speed wave radiation (T196): implicit, in the same pass
      this.radiationImpulse = 0;
      this.radiationScale = 0;
      if (prm.radiationDamping) this.radiationDampingPass(h);
      for (let hI = 0; hI < nh; hI++) this.prevMa[hI] = HMA[hI];
      for (let i = 0; i < ns; i++) this.lPrev[i] = this.lMa[i];
      pa[0] = Ax;
      pa[1] = Ay;
      pa[2] = Az;
      pa[3] = dIx;
      pa[4] = dIy;
      pa[5] = dIz;
      this.hasPrev = true;
      this.fX += slamJx / h;
      this.fY += slamJy / h;
      this.fZ += slamJz / h;
      this.tX += slamLx / h;
      this.tY += slamLy / h;
      this.tZ += slamLz / h;
      // ---- face drag (deck lid, transom, stem cap): implicit impulses too, before the explicit loads
      if (prm.faceDragCoeff > 0) this.faceDrag(h);
      // ---- passivity credit (T196): the rigid kinetic energy the implicit impulses above just took out (slam, entry,
      //      crossflow, radiation, face drag), relative to the water — energy handed to the water this substep
      if (prm.passivity) this.bankImpulseDissipation(vx, vy, vz, wx, wy, wz, bxx, bxy, bxz, byx, byy, byz, bzx, bzy, bzz);
      // ---- EXPLICIT FLUX LOADS begin (rotating frame, Kirchhoff, lift, sway flux): V110 and passivity scale these
      this.markExplicit();
      // ---- ROTATING-FRAME ADDED-MASS LOAD: the m_a·∂V_n/∂t of a BODY-FIXED section includes the change
      //      of its normal velocity as the hull ROTATES in the stream, ∂V_n/∂t ⊃ N_b·(ω_b × v_b) — for
      //      pitch, m_a·q·u. rigid6 divides world accelerations by the added mass and cannot see it.
      //      Without it the heave–pitch mode had a limit cycle at C_v 3.5–3.9 that grew as the strips
      //      were refined (0.39° → 0.87°); with it the cycle is gone at every strip count. (Flipping its
      //      sign makes C_v 3–5 oscillate at 1.7–3.0°.)
      {
        const vbx = vx * bxx + vy * bxy + vz * bxz;
        const vby = vx * byx + vy * byy + vz * byz;
        const vbz = vx * bzx + vy * bzy + vz * bzz;
        const obx = wx * bxx + wy * bxy + wz * bxz;
        const oby = wx * byx + wy * byy + wz * byz;
        const obz = wx * bzx + wy * bzy + wz * bzz;
        const ocx = oby * vbz - obz * vby;
        const ocy = obz * vbx - obx * vbz;
        const ocz = obx * vby - oby * vbx;
        for (let hI = 0; hI < nh; hI++) {
          const ma = HMA[hI];
          if (ma <= 0) continue;
          const nX = HN[hI * 3];
          const nY = HN[hI * 3 + 1];
          const nZ = HN[hI * 3 + 2];
          const nbx = nX * bxx + nY * bxy + nZ * bxz;
          const nby = nX * byx + nY * byy + nZ * byz;
          const nbz = nX * bzx + nY * bzy + nZ * bzz;
          this.addHalfForce(hI, ma * dz * (nbx * ocx + nby * ocy + nbz * ocz));
        }
        // ---- lateral sections: the same rotating-frame load on the sway added mass, at the strip centroid.
        //      COUPLED (6×6): + A6·[0; I⁻¹(ω_b × Iω_b)] — the step's gyroscopic update acts on the RIGID inertia
        //      only, so the part of the water's acceleration it implies must come from here (derivation in the
        //      KIRCHHOFF note below).
        const I0 = mesh.inertia[0];
        const I1 = mesh.inertia[1];
        const I2 = mesh.inertia[2];
        const gx = (oby * I2 * obz - obz * I1 * oby) / I0;
        const gy = (obz * I0 * obx - obx * I2 * obz) / I1;
        const gz = (obx * I1 * oby - oby * I0 * obx) / I2;
        // ---- KIRCHHOFF COMPLETION: −ω × p, p = the water's linear momentum (A·v). rigid6 integrates the
        //      world velocity with the added mass per body axis; for water carried by a ROTATING hull
        //      Kirchhoff's equations need, on top of the section loads above (A·(ω×v)),
        //        F = −ω × (A·v)            (body frame; Lamb 1932 §124, Newman 1977 §4.13)
        //      Without it a heaving, pitching hull at rest swapped momentum between body axes on every cycle —
        //      horizontal momentum was not conserved and a hull released in calm water walked away (0.31 m/s
        //      after settling from a 20 cm drop, measured, with the transom-face defect below fixed). Force only,
        //      through the CG: the angular −ω×p_ang − v×p_lin is NOT added — v×p_lin is the Munk moment, which
        //      the lift/lateral momentum flux already carries (measured: adding −ω×p_ang capsized the roll kick at
        //      C_v 8). p from point velocities when coupled (p = A6·ν), from the CG velocity with the diagonal
        //      step (whose A has no lever arms).
        const kirch = prm.kirchhoff;
        let plx = 0;
        let ply = 0;
        let plz = 0;
        for (let hI = 0; hI < nh; hI++) {
          const ma = HMA[hI];
          if (ma <= 0) continue;
          const nX = HN[hI * 3];
          const nY = HN[hI * 3 + 1];
          const nZ = HN[hI * 3 + 2];
          const aN = ma * dz;
          const rx = HC[hI * 3] - cgx;
          const ry = HC[hI * 3 + 1] - cgy;
          const rz = HC[hI * 3 + 2] - cgz;
          if (C6) {
            const nbx = nX * bxx + nY * bxy + nZ * bxz;
            const nby = nX * byx + nY * byy + nZ * byz;
            const nbz = nX * bzx + nY * bzy + nZ * bzz;
            const rbx = rx * bxx + ry * bxy + rz * bxz;
            const rby = rx * byx + ry * byy + rz * byz;
            const rbz = rx * bzx + ry * bzy + rz * bzz;
            this.addHalfForce(hI, aN * ((rby * nbz - rbz * nby) * gx + (rbz * nbx - rbx * nbz) * gy + (rbx * nby - rby * nbx) * gz));
            // roll plate term of A6 (body z)
            const tg = ((aN * HCW[hI] * HCW[hI]) / 8) * gz;
            this.tX += tg * bzx;
            this.tY += tg * bzy;
            this.tZ += tg * bzz;
          }
          if (kirch) {
            const vyr = vy - this.hWv[hI];
            const vn = C6 ? vx * nX + vyr * nY + vz * nZ + (wy * rz - wz * ry) * nX + (wz * rx - wx * rz) * nY + (wx * ry - wy * rx) * nZ : vx * nX + vyr * nY + vz * nZ;
            const qx = aN * vn * nX;
            const qy = aN * vn * nY;
            const qz = aN * vn * nZ;
            plx += qx;
            ply += qy;
            plz += qz;
            SF[hI * 3] -= wy * qz - wz * qy;
            SF[hI * 3 + 1] -= wz * qx - wx * qz;
            SF[hI * 3 + 2] -= wx * qy - wy * qx;
          }
        }
        for (let i = 0; i < ns; i++) {
          const ml = this.lMa[i];
          if (ml <= 0) continue;
          const o = i * 3;
          const F = this.lJf;
          const Mv = this.lJm;
          const fbx = F[o] * bxx + F[o + 1] * bxy + F[o + 2] * bxz;
          const fby = F[o] * byx + F[o + 1] * byy + F[o + 2] * byz;
          const fbz = F[o] * bzx + F[o + 1] * bzy + F[o + 2] * bzz;
          const aN = ml * dz;
          let f = aN * (fbx * ocx + fby * ocy + fbz * ocz);
          if (C6) {
            const mbx = Mv[o] * bxx + Mv[o + 1] * bxy + Mv[o + 2] * bxz;
            const mby = Mv[o] * byx + Mv[o + 1] * byy + Mv[o + 2] * byz;
            const mbz = Mv[o] * bzx + Mv[o + 1] * bzy + Mv[o + 2] * bzz;
            f += aN * (mbx * gx + mby * gy + mbz * gz);
          }
          if (prm.panelSuctionLimit) this.lRotF[i] = f;
          else this.addLateralStripForce(i, f);
          if (kirch) {
            const vL = C6 ? this.lVL[i] : vx * F[o] + (vy - this.sWv[i]) * F[o + 1] + vz * F[o + 2];
            const qx = aN * vL * F[o];
            const qy = aN * vL * F[o + 1];
            const qz = aN * vL * F[o + 2];
            plx += qx;
            ply += qy;
            plz += qz;
            const A = S.wetArea[i];
            for (let side = 0; side < 2; side++) {
              const hI = 2 * i + side;
              const w = this.hArea[hI] / A;
              if (!(w > 0)) continue;
              SF[hI * 3] -= w * (wy * qz - wz * qy);
              SF[hI * 3 + 1] -= w * (wz * qx - wx * qz);
              SF[hI * 3 + 2] -= w * (wx * qy - wy * qx);
            }
          }
        }
        if (kirch) {
          this.fX -= wy * plz - wz * ply;
          this.fY -= wz * plx - wx * plz;
          this.fZ -= wx * ply - wy * plx;
        }
      }
      this.transferExplicit();
      // ---- planing lift: −U·∂(m_a·V_n)/∂ξ per half-section, M sampled at half centroids, piecewise
      // linear. The momentum gained between two centres is placed at their shared boundary (half to each
      // wet neighbour). At the TRAILING section the half strip to the transom is extrapolated, then the
      // flux leaves with the wake (Kutta: nothing aft of the transom). Upwind direction = sign of the
      // CG's body-z speed; magnitude uses each half's own |u|.
      const LF = this.sLift;
      LF.fill(0);
      const LFS = this.sLiftSt;
      LFS.fill(0);
      {
        const uCg = vx * bzx + vy * bzy + vz * bzz;
        const step = uCg >= 0 ? 1 : -1;
        const trail = uCg >= 0 ? 0 : ns - 1;
        for (let hI = 0; hI < nh; hI++) {
          if (HMA[hI] <= 0) continue;
          const i = hI >> 1;
          const side = hI & 1;
          const upS = i + step;
          const up = 2 * upS + side;
          const upWet = upS >= 0 && upS < ns && HMA[up] > 0;
          const exitRule = prm.waterExit;
          const vnI = exitRule && HVN[hI] < 0 ? 0 : HVN[hI];
          const vnUp = upWet ? (exitRule && HVN[up] < 0 ? 0 : HVN[up]) : 0;
          const mI = HMA[hI] * vnI;
          const mUp = upWet ? HMA[up] * vnUp : 0;
          const lift = Math.abs(HU[hI]) * (mI - mUp);
          // steady part: V_n the section would have at this pose with the CG moving horizontally
          let vSt = -(vx * HN[hI * 3] + vz * HN[hI * 3 + 2]);
          let vStUp = upWet ? -(vx * HN[up * 3] + vz * HN[up * 3 + 2]) : 0;
          if (exitRule) {
            if (vSt < 0) vSt = 0;
            if (vStUp < 0) vStUp = 0;
          }
          const liftSt = Math.abs(HU[hI]) * (HMA[hI] * vSt - (upWet ? HMA[up] * vStUp : 0));
          // share to the upwind section ramps with ITS wetted area (0 → ½): a hard ½/1 switch jumped the
          // pitch moment each time the keel entry point crossed a strip boundary
          const wUp = upWet ? 0.5 * Math.min(1, HA[up] / HA[hI]) : 0;
          const zc = mesh.strips.zCentre[i];
          // Garme on the STEADY part only (see `garmeANon`), evaluated where each piece of lift acts
          const sP = liftSt * this.transomFactor(zc + 0.5 * step * dz);
          const cb = sP + (lift - liftSt);
          if (cb > 0) {
            const fs = cb * this.steadyShare(sP, lift - liftSt);
            LF[hI] += (1 - wUp) * cb;
            LFS[hI] += (1 - wUp) * fs;
            if (upWet) {
              LF[up] += wUp * cb;
              LFS[up] += wUp * fs;
            }
          }
          if (i === trail) {
            const sE = liftSt * this.transomFactor(zc - 0.25 * step * dz);
            const ext = wUp * (sE + (lift - liftSt));
            if (ext > 0) {
              LF[hI] += ext;
              LFS[hI] += ext * this.steadyShare(sE, lift - liftSt);
            }
          }
        }
      }
      for (let hI = 0; hI < nh; hI++) {
        if (!(LF[hI] > 0) || HA[hI] <= 1e-9) continue;
        const fs = Math.min(LF[hI], Math.max(0, LFS[hI]));
        const fu = LF[hI] - fs;
        if (fu > 0) this.addHalfForce(hI, fu);
        if (fs > 0) {
          const P = this.hSteady;
          this.addForceAt(hI, fs * HN[hI * 3], fs * HN[hI * 3 + 1], fs * HN[hI * 3 + 2], P[hI * 3] - cgx, P[hI * 3 + 1] - cgy, P[hI * 3 + 2] - cgz);
        }
      }
      // ---- LATERAL MOMENTUM FLUX (slender-body side force, −U·∂(m_lat·V_L)/∂ξ along L̂): the planing lift's
      //      scheme on the sway momentum M = m_lat·V_L, boundary placement, trailing extrapolation, the flux
      //      leaving at the transom (Kutta). NOT clamped: sway momentum has either sign. Its moment about the CG
      //      contains the Munk yaw moment (directionally destabilising, as for any slender hull: the drives'
      //      foils are what make her straight-running stable). Faltinsen 2005 §9 (2D+t maneuvering); Newman 1977 §7.
      {
        const LFl = this.lF;
        LFl.fill(0);
        const uCg = vx * bzx + vy * bzy + vz * bzz;
        const step = uCg >= 0 ? 1 : -1;
        const trail = uCg >= 0 ? 0 : ns - 1;
        for (let i = 0; i < ns; i++) {
          if (this.lMa[i] <= 0) continue;
          const upS = i + step;
          const upWet = upS >= 0 && upS < ns && this.lMa[upS] > 0;
          const mI = this.lMa[i] * this.lVL[i];
          const mUp = upWet ? this.lMa[upS] * this.lVL[upS] : 0;
          const cb = -Math.abs(this.lU[i]) * (mI - mUp);
          const wUp = upWet ? 0.5 * Math.min(1, S.wetArea[upS] / S.wetArea[i]) : 0;
          LFl[i] += (1 - wUp) * cb;
          if (upWet) LFl[upS] += wUp * cb;
          if (i === trail) LFl[i] += wUp * cb;
        }
        for (let i = 0; i < ns; i++) {
          let f = LFl[i];
          if (prm.panelSuctionLimit) {
            f += this.lRotF[i];
            this.lRotF[i] = 0;
            if (f !== 0) this.addLateralStripForceLimited(i, f);
          } else if (f !== 0) this.addLateralStripForce(i, f);
        }
      }
      this.endExplicit();
    }
    // ---- SKIN FRICTION, ITTC-57 + ΔC_F on the SPRAY-ROOT-bounded wetted area (Savitsky 1964's
    //      pressure area S = λb²/cosβ): each running-surface triangle's clipped area is scaled by
    //      its strip's Wagner c / geometric c (≤ π/2, less once the chine is wet). Rn on the mean
    //      wetted length λb = A_plan/B, as Savitsky; the clipped (calm-water) area alone under-
    //      predicted friction by ~⅓ at planing speed.
    const FF = this.frictionForce;
    const FT = this.frictionTorque;
    FF[0] = FF[1] = FF[2] = FT[0] = FT[1] = FT[2] = 0;
    if (prm.viscous) {
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      let lRef = mesh.stemZ - mesh.transomZ;
      if (prm.planing && this.beamMax > 0) {
        let aPlan = 0;
        for (let i = 0; i < ns; i++) aPlan += 2 * S.c[i] * dz;
        if (aPlan > 0) lRef = Math.max(0.1 * lRef, aPlan / this.beamMax);
      }
      const Rn = (speed * lRef) / prm.nu;
      const lg = Math.log10(Rn) - 2;
      const cf = Rn > 1e5 ? 0.075 / (lg * lg) + prm.frictionAllowance : 0;
      const halfRhoCf = 0.5 * rho * cf;
      const W = this.wet;
      for (let j = 0; j < W.count; j++) {
        const hI = this.wHalf[j];
        let ratio = 1;
        if (prm.planing && hI >= 0 && this.hCg[hI] > 0) ratio = this.hCw[hI] / this.hCg[hI];
        const nnx = W.normal[j * 3];
        const nny = W.normal[j * 3 + 1];
        const nnz = W.normal[j * 3 + 2];
        const pvx = W.vel[j * 3];
        const pvy = W.vel[j * 3 + 1];
        const pvz = W.vel[j * 3 + 2];
        const vnn = pvx * nnx + pvy * nny + pvz * nnz;
        const tvx = pvx - vnn * nnx;
        const tvy = pvy - vnn * nny;
        const tvz = pvz - vnn * nnz;
        const tv = Math.sqrt(tvx * tvx + tvy * tvy + tvz * tvz);
        const c = -halfRhoCf * W.area[j] * ratio * tv;
        const fx = c * tvx;
        const fy = c * tvy;
        const fz = c * tvz;
        const rx = W.centroid[j * 3] - cgx;
        const ry = W.centroid[j * 3 + 1] - cgy;
        const rz = W.centroid[j * 3 + 2] - cgz;
        this.fX += fx;
        this.fY += fy;
        this.fZ += fz;
        this.tX += ry * fz - rz * fy;
        this.tY += rz * fx - rx * fz;
        this.tZ += rx * fy - ry * fx;
        FF[0] += fx;
        FF[1] += fy;
        FF[2] += fz;
        FT[0] += ry * fz - rz * fy;
        FT[1] += rz * fx - rx * fz;
        FT[2] += rx * fy - ry * fx;
        W.fy[j] += fy;
      }
    }
    // ---- V110 bound at the result — on the EXPLICIT flux loads only (T189). The impulse terms (slam, crossflow and
    //      face drag, sway entry) are velocity-level and bounded by construction (they never reverse a point's
    //      velocity, V103); scaling them after the Gauss–Seidel pass handed back momentum the pass had taken out
    //      (measured: +550 kJ of rigid kinetic energy over one capped re-entry). Hydrostatics and friction are bounded.
    this.rawForce[0] = this.fX;
    this.rawForce[1] = this.fY;
    this.rawForce[2] = this.fZ;
    const E = this.explicitLoad;
    let s = 1;
    {
      const fMag = Math.sqrt(E[0] * E[0] + E[1] * E[1] + E[2] * E[2]);
      if (fMag > prm.maxAccel * m) s = (prm.maxAccel * m) / fMag;
      const tbx = E[3] * bxx + E[4] * bxy + E[5] * bxz;
      const tby = E[3] * byx + E[4] * byy + E[5] * byz;
      const tbz = E[3] * bzx + E[4] * bzy + E[5] * bzz;
      const alpha = Math.max(Math.abs(tbx) / mesh.inertia[0], Math.abs(tby) / mesh.inertia[1], Math.abs(tbz) / mesh.inertia[2]);
      if (alpha * s > prm.maxAngularAccel) s = prm.maxAngularAccel / alpha;
    }
    this.capScale = s;
    const sp = prm.passivity && C6 && prm.planing ? this.passivityLimit(h, s, bxx, bxy, bxz, byx, byy, byz, bzx, bzy, bzz) : 1;
    this.passivityScale = sp;
    const kExp = 1 - s;
    const kTr = s * (1 - sp);
    const ET = this.explicitTransferLoad;
    if (kExp > 0 || kTr > 0) {
      this.fX -= kExp * E[0] + kTr * ET[0];
      this.fY -= kExp * E[1] + kTr * ET[1];
      this.fZ -= kExp * E[2] + kTr * ET[2];
      this.tX -= kExp * E[3] + kTr * ET[3];
      this.tY -= kExp * E[4] + kTr * ET[4];
      this.tZ -= kExp * E[5] + kTr * ET[5];
    }

    // ---- HydroSamples: each wet triangle carries its own hydrostatic + viscous (+ face drag) fy plus its area share
    //      of its half-section's dynamic force (explicit part × the same scale) ⇒ Σ fy = load.force[1]
    const W = this.wet;
    for (let j = 0; j < W.count; j++) {
      const hI = this.wHalf[j];
      let fy = W.fy[j];
      if (hI >= 0 && this.hArea[hI] > 1e-9) fy += ((SF[hI * 3 + 1] - kExp * this.sForceExpY[hI] - kTr * this.sForceTrY[hI]) * W.area[j]) / this.hArea[hI];
      W.fy[j] = fy;
    }
    this.buildWakeLoad(this.fY);

    // ---- prop immersion (§3.1: s = smoothstep(−r, r, depth))
    {
      const [bx, by, bz] = mesh.propPoint;
      const tx = 2 * (qy * bz - qz * by);
      const ty = 2 * (qz * bx - qx * bz);
      const tz = 2 * (qx * by - qy * bx);
      const x = cgx + bx + qw * tx + (qy * tz - qz * ty);
      const y = cgy + by + qw * ty + (qz * tx - qx * tz);
      const z = cgz + bz + qw * tz + (qx * ty - qy * tx);
      this.propDepth = patch.heightAt(x, z) - this.transomWakeDepression(x, z) - y;
      const r = mesh.propRadius;
      const e = Math.min(1, Math.max(0, (this.propDepth + r) / (2 * r)));
      this.propImmersion = e * e * (3 - 2 * e);
    }

    const L = this.load;
    L.force[0] = this.fX;
    L.force[1] = this.fY;
    L.force[2] = this.fZ;
    L.torque[0] = this.tX;
    L.torque[1] = this.tY;
    L.torque[2] = this.tZ;
    L.addedMass[0] = Ax;
    L.addedMass[1] = Ay;
    L.addedMass[2] = Az;
    L.addedInertia[0] = dIx;
    L.addedInertia[1] = dIy;
    L.addedInertia[2] = dIz;
    this.evaluateDrives(state, h);
    if (out && C6 && out.addedMass6 && this.k6[7] + this.k6[21] + this.k6[28] + this.k6[35] > 0) {
      for (let k = 0; k < 36; k++) out.addedMass6[k] += this.k6[k];
      out.coupled = true;
    }
    if (out) {
      for (let c = 0; c < 3; c++) {
        out.force[c] += this.driveForce[c];
        out.torque[c] += this.driveTorque[c];
        out.force[c] += L.force[c];
        out.torque[c] += L.torque[c];
        out.addedMass[c] += L.addedMass[c];
        out.addedInertia[c] += L.addedInertia[c];
      }
    }
  }

  /** controls for the drives (S2 input): steer = drive yaw angle, rad (clamped to each drive's lock; + turns the
   *  bow toward body −x), throttle ∈ [−0.3, 1] = the engine lever (src/sea-physics/engine.ts: throttle-body lag, prop
   *  load, limiter), trim = drive trim angle, rad (clamped to each drive's range; + = trim out, bow up; T189) */
  setControls(steer: number, throttle: number, trim = 0): void {
    this.steer = Number.isFinite(steer) ? steer : 0;
    this.throttle = Number.isFinite(throttle) ? (throttle < -0.3 ? -0.3 : throttle > 1 ? 1 : throttle) : 0;
    this.trim = Number.isFinite(trim) ? trim : 0;
  }

  /**
   * SURGE (T196): the race's Surge output multiplier (≥ 1) as an ENGINE boost — extra charge-pressure torque and a Governor
   * over-rev allowance (engine.ts `EngineInput.boost`), so the extra thrust comes out of the prop curve at the boat's own
   * speed and immersion (a dry prop still gets nothing). Clamped to [1, engine.boostMax]; persists until set again.
   */
  setBoost(multiplier: number): void {
    this.boost = Number.isFinite(multiplier) && multiplier > 1 ? Math.min(multiplier, this.params.engine.boostMax) : 1;
  }

  /**
   * DRIVES — thrust along each drive's line at its prop point, and the GEARCASE as a low-aspect-ratio lateral
   * foil at its centre of effort, both yawed by the steer angle about the drive's pivot.
   *  lift slope  C_Lα = 2πA/(2 + √(A² + 4))  (Helmbold 1942; → πA/2, Jones' slender wing, as A → 0), A = s_i²/S_i
   *              on the IMMERSED span s_i: the anti-ventilation plate runs at the free surface, whose image at
   *              planing speed is φ = 0, so no end-plate doubling of A (Molland & Turnock 2007 via Liu &
   *              Hekkenberg 2017: k_Λ → 2 only against a solid plate).
   *  stall       linear to α_s (JSON `stallDeg`; open-water rudders 15–20°, low-A later — Liu & Hekkenberg 2017),
   *              then decaying to the flat-plate normal-force law C_N ≈ 1.2·sin α (Hoerner) — no lift cliff.
   *  drag        C_D0 + C_L²/(πA) below stall (induced), → C_N·sin α beyond.
   *  immersion   s_i = clamp(span + depth of the AV plate below the patch surface, 0, span): a gearcase lifted
   *              out of the water (airborne, trimmed out, a wave trough) loses area AND aspect ratio, so side
   *              force → 0 smoothly and she cannot steer in the air; thrust × s^1.5 at each prop (doc §3.1).
   *  trim       (T189) the lower unit rotates about the clamp-bracket pin (`trimPivotY`, the mount plane) by the trim
   *              angle θ BEFORE the steer yaw: trim out (θ > 0) swings prop, gearcase and AV plate aft and up and tips the
   *              thrust line down-forward, d = (sinδ·cosθ, −sinθ, cosδ·cosθ) — stern pushed down, bow up; the raised
   *              plate shortens the immersed span. Range from JSON `lowerUnit.trimMinDeg/trimMaxDeg`.
   *  thrust     (T189) from the engine model per drive (src/sea-physics/engine.ts: torque curve, throttle-body lag,
   *              K_T/K_Q prop at the drive's advance and immersion, limiter), stepped once per substep. The prop's
   *              REACTION TORQUE −hand·(Q_water + I·dω/dt) acts on the hull about the drive line: the propeller heel
   *              torque, and the small real part of "throttle pitches her in the air" (spinning the train up or down).
   * Not part of `load` (the hull contact, whose samples sum to it, V-W2); added to the rigid6 load passed in.
   */
  private evaluateDrives(state: Readonly<Rigid6State>, h: number): void {
    const DF = this.driveForce;
    const DT = this.driveTorque;
    DF[0] = DF[1] = DF[2] = DT[0] = DT[1] = DT[2] = 0;
    this.foilSideForce = 0;
    this.thrust = 0;
    const drives = this.mesh.drives;
    if (!drives || drives.length === 0) return;
    const prm = this.params;
    const [qx, qy, qz, qw] = state.quaternion;
    const cgx = state.position[0];
    const cgy = state.position[1];
    const cgz = state.position[2];
    const [vx, vy, vz] = state.velocity;
    const [wx, wy, wz] = state.angularVelocity;
    const rho = prm.rho;
    const patch = this.patch;
    const rot = (bx: number, by: number, bz: number, o: Float64Array): void => {
      const tx = 2 * (qy * bz - qz * by);
      const ty = 2 * (qz * bx - qx * bz);
      const tz = 2 * (qx * by - qy * bx);
      o[0] = bx + qw * tx + (qy * tz - qz * ty);
      o[1] = by + qw * ty + (qz * tx - qx * tz);
      o[2] = bz + qw * tz + (qx * ty - qy * tx);
    };
    const R = this.dr;
    const D = this.dd;
    const Nn = this.dn;
    // body axes in world (for world → body of velocities)
    const bxx = 1 - 2 * (qy * qy + qz * qz);
    const bxy = 2 * (qx * qy + qw * qz);
    const bxz = 2 * (qx * qz - qw * qy);
    const nEng = drives.length;
    const powerScale = prm.standInDrivePowerW / STANDIN_THRUST.powerW;
    let side = 0;
    for (let k = 0; k < nEng; k++) {
      const dv = drives[k];
      const lock = dv.maxSteerRad;
      const del = this.steer < -lock ? -lock : this.steer > lock ? lock : this.steer;
      const cs = Math.cos(del);
      const sn = Math.sin(del);
      const hasTrim = dv.trimPivotY !== undefined;
      const tMin = dv.trimMinRad ?? 0;
      const tMax = dv.trimMaxRad ?? 0;
      const th = hasTrim ? (this.trim < tMin ? tMin : this.trim > tMax ? tMax : this.trim) : 0;
      const ct = Math.cos(th);
      const stt = Math.sin(th);
      const tpy = hasTrim ? (dv.trimPivotY as number) : 0;
      const tpz = dv.pivot[2];
      // chord (thrust) direction and foil normal, body → world
      rot(sn * ct, -stt, cs * ct, D);
      rot(cs, 0, -sn, Nn);
      // ---- gearcase foil
      {
        const fy0 = dv.foilCe[1] - tpy;
        const fz0 = dv.foilCe[2] - tpz;
        const fy = tpy + fy0 * ct - fz0 * stt;
        const fzT = tpz + fy0 * stt + fz0 * ct;
        const ox = dv.foilCe[0] - dv.pivot[0];
        const oz = fzT - dv.pivot[2];
        const bx = dv.pivot[0] + ox * cs + oz * sn;
        const bz = dv.pivot[2] - ox * sn + oz * cs;
        rot(bx, fy, bz, R);
        const rx = R[0];
        const ry = R[1];
        const rz = R[2];
        // immersed span from the AV plate's depth right above the centre of effort (the plate trims with the leg)
        const ay0 = dv.avPlateY - tpy;
        const ay = tpy + ay0 * ct - fz0 * stt;
        const az = tpz + ay0 * stt + fz0 * ct - dv.pivot[2];
        rot(dv.pivot[0] + ox * cs + az * sn, ay, dv.pivot[2] - ox * sn + az * cs, this.da);
        const depthAv = patch.heightAt(cgx + this.da[0], cgz + this.da[2]) - this.transomWakeDepression(cgx + this.da[0], cgz + this.da[2]) - (cgy + this.da[1]);
        const si = Math.min(dv.span, Math.max(0, dv.span + Math.min(0, depthAv)));
        const frac = si / dv.span;
        this.gearcaseImmersion[k] = frac;
        if (frac > 0 && prm.driveFoil) {
          const pvx = vx + (wy * rz - wz * ry);
          const pvy = vy + (wz * rx - wx * rz);
          const pvz = vz + (wx * ry - wy * rx);
          const uc = pvx * D[0] + pvy * D[1] + pvz * D[2];
          const un = pvx * Nn[0] + pvy * Nn[1] + pvz * Nn[2];
          const V2 = uc * uc + un * un;
          if (V2 > 1e-12) {
            const V = Math.sqrt(V2);
            const area = dv.lateralArea * frac;
            const AR = (si * si) / area;
            const cla = (2 * Math.PI * AR) / (2 + Math.sqrt(AR * AR + 4));
            const a = Math.atan2(Math.abs(un), Math.abs(uc));
            const as = dv.stallRad;
            // wetted: linear to stall, then toward the flat-plate normal-force law
            let cl: number;
            let cd: number;
            if (a <= as) {
              cl = cla * a;
              cd = dv.profileDragCoeff + (cl * cl) / (Math.PI * AR);
            } else {
              const wgt = Math.exp(-(a - as) / 0.15);
              const sa = Math.sin(a);
              const ca = Math.cos(a);
              const clMax = cla * as;
              cl = clMax * wgt + 1.2 * sa * ca * (1 - wgt);
              cd = (dv.profileDragCoeff + (clMax * clMax) / (Math.PI * AR)) * wgt + (dv.profileDragCoeff + 1.2 * sa * sa) * (1 - wgt);
            }
            // NATURAL VENTILATION of the surface-piercing gearcase: air drawn down the suction side once the
            // lift coefficient reaches C_L,i = [1 − exp(−σ_v·Fr_h)]·Fr_h^(−1/2) (Damley-Strnad et al. 2019, as
            // quoted and tested by Aguiar Ferreira et al., JFM/arXiv:2503.18015, 2025), σ_v = 2(p0 − p_v)/(ρV²),
            // Fr_h = V/√(g·s_i). Beyond it the lift falls, over a 4° band, to the ventilated flat-plate value, ¼ of
            // the wetted slope (Tulin's linearised supercavitating plate, C_L = πα/2 vs 2πα). The wetted/ventilated
            // HYSTERESIS (washout at a lower α) is not modelled; the anti-ventilation plate is not credited.
            if (prm.gearcaseVentilation && cla > 0) {
              const sigma = (2 * (101325 - 2500)) / (rho * V2);
              const frh = V / Math.sqrt(prm.gravity * si);
              const clI = (1 - Math.exp(-sigma * frh)) / Math.sqrt(frh);
              const aI = Math.min(as, clI / cla);
              if (a > aI) {
                const e = Math.min(1, (a - aI) / (4 * (Math.PI / 180)));
                const v = e * e * (3 - 2 * e);
                const clV = 0.25 * cla * Math.sin(a) * Math.cos(a);
                const clW = Math.min(cl, cla * aI);
                cl = clW * (1 - v) + clV * v;
                cd = cd * (1 - v) + (dv.profileDragCoeff + clV * Math.tan(a)) * v;
              }
            }
            const q = 0.5 * rho * V2 * area;
            // lift ⊥ the in-plane inflow, opposing its normal component; drag against it
            const sgn = -(un >= 0 ? 1 : -1) * (uc >= 0 ? 1 : -1);
            const px = (-un * D[0] + uc * Nn[0]) / V;
            const py = (-un * D[1] + uc * Nn[1]) / V;
            const pz = (-un * D[2] + uc * Nn[2]) / V;
            const vhx = (uc * D[0] + un * Nn[0]) / V;
            const vhy = (uc * D[1] + un * Nn[1]) / V;
            const vhz = (uc * D[2] + un * Nn[2]) / V;
            const fx = q * (cl * sgn * px - cd * vhx);
            const fy = q * (cl * sgn * py - cd * vhy);
            const fz = q * (cl * sgn * pz - cd * vhz);
            DF[0] += fx;
            DF[1] += fy;
            DF[2] += fz;
            DT[0] += ry * fz - rz * fy;
            DT[1] += rz * fx - rx * fz;
            DT[2] += rx * fy - ry * fx;
            side += fx * bxx + fy * bxy + fz * bxz;
          }
        }
      }
      // ---- thrust (engine model) at the prop point along the drive line
      {
        const py0 = dv.prop[1] - tpy;
        const pz0 = dv.prop[2] - tpz;
        const pyT = tpy + py0 * ct - pz0 * stt;
        const pzT = tpz + py0 * stt + pz0 * ct;
        const ox = dv.prop[0] - dv.pivot[0];
        const oz = pzT - dv.pivot[2];
        const bx = dv.pivot[0] + ox * cs + oz * sn;
        const bz = dv.pivot[2] - ox * sn + oz * cs;
        rot(bx, pyT, bz, R);
        const depth = patch.heightAt(cgx + R[0], cgz + R[2]) - this.transomWakeDepression(cgx + R[0], cgz + R[2]) - (cgy + R[1]);
        const r = this.mesh.propRadius;
        const e = Math.min(1, Math.max(0, (depth + r) / (2 * r)));
        const imm = e * e * (3 - 2 * e);
        this.driveImmersion[k] = imm;
        const ua = Math.abs(vx * D[0] + vy * D[1] + vz * D[2]);
        const k3 = 3 * k;
        this.driveProp[k3] = cgx + R[0];
        this.driveProp[k3 + 1] = cgy + R[1];
        this.driveProp[k3 + 2] = cgz + R[2];
        this.driveDir[k3] = D[0];
        this.driveDir[k3 + 1] = D[1];
        this.driveDir[k3 + 2] = D[2];
        this.driveAdvance[k] = ua;
        this.driveThrustFactor[k] = imm * Math.sqrt(imm);
        const eng = this.engines[k];
        const EI = this.engineIn;
        EI.throttle = this.throttle;
        EI.advance = ua;
        EI.immersion = imm;
        EI.powerScale = powerScale;
        EI.neutral = this.throttle === 0;
        EI.boost = this.boost;
        stepEngine(eng, prm.engine, EI, h);
        this.driveRpm[k] = eng.rpm;
        const T = eng.thrust;
        this.driveThrust[k] = T;
        const fx = T * D[0];
        const fy = T * D[1];
        const fz = T * D[2];
        DF[0] += fx;
        DF[1] += fy;
        DF[2] += fz;
        const q = prm.propTorqueReaction ? -(dv.propHand ?? 1) * (eng.propTorque + eng.shaftAccelTorque) : 0;
        DT[0] += R[1] * fz - R[2] * fy + q * D[0];
        DT[1] += R[2] * fx - R[0] * fz + q * D[1];
        DT[2] += R[0] * fy - R[1] * fx + q * D[2];
        this.thrust += T;
      }
    }
    this.foilSideForce = side;
  }

  /**
   * TRANSOM WAKE HOLLOW (T196, `transomWake`): how far below the local undisturbed surface the water is at world (x, z)
   * behind the transom, m (≥ 0). Longitudinal centreline wake profile of prismatic planing surfaces, 10° ≤ β ≤ 30°
   * (Korvin-Kroukovsky, Savitsky & Lehman, Stevens ETT Report 339, 1949, as reproduced in the USNA EN441 planing notes
   * ch. 3 Fig. 9; exponents checked against that figure's worked example, τ 12°, C_v 4.25, λ 2: H 0.15/0.37/0.67 at
   * X 1/2/3 beams):
   *   H/B = 0.02064·(X·τ^0.7/C_v^0.6)² − 0.00448·(X·τ^0.7/C_v^0.6)^2.44 + 0.0108·λ·τ^0.34·X
   * H = height of the wake surface above the keel line EXTENDED aft of the transom, X beams aft, τ trim in degrees, λ the
   * mean wetted length/beam (the hull's A_plan/B²). Depression = transom keel depth + X·B·tanτ − H·B, clamped ≥ 0 (the
   * rooster-tail hump further aft is not credited), × the transom's dry fraction (1 − trailWet), and 0 ahead of the transom.
   * The centreline profile is used for the outer drives too (±0.66 m = 0.29 B; ASSUMED).
   */
  /**
   * PUBLISHED for the drawn sea (§V101, one contact result, many consumers): the same transom hollow the drives' immersion
   * is taken against, m below the local undisturbed surface at world (x, z), from the last evaluate() (0 ahead of the
   * transom, with `transomWake` off, or with the transom wet). A render that draws this hollow shows the props in the
   * water the physics runs them in.
   */
  transomWakeDepthAt(x: number, z: number): number {
    return this.transomWakeDepression(x, z);
  }

  private transomWakeDepression(x: number, z: number): number {
    if (!this.params.transomWake || !(this.trDepth > 0) || !this.uForward) return 0;
    const dry = 1 - this.trailWet;
    if (!(dry > 0)) return 0;
    const hx = this.bzX;
    const hz = this.bzZ;
    const hl = Math.sqrt(hx * hx + hz * hz);
    if (!(hl > 1e-6)) return 0;
    const Xm = -((x - this.trX) * hx + (z - this.trZ) * hz) / hl;
    if (!(Xm > 0)) return 0;
    const B = this.beamMax;
    const tanT = Math.max(0, this.bzY) / hl;
    const tauDeg = (Math.atan(tanT) * 180) / Math.PI;
    const cv = Math.abs(this.vx * this.bzX + this.vy * this.bzY + this.vz * this.bzZ) / Math.sqrt(this.params.gravity * B);
    if (!(cv > 0.1)) return 0;
    let aPlan = 0;
    const S = this.sections;
    for (let i = 0; i < S.count; i++) aPlan += 2 * S.c[i] * this.mesh.strips.dz;
    const lambda = aPlan / (B * B);
    const X = Xm / B;
    const q = (X * Math.pow(tauDeg, 0.7)) / Math.pow(cv, 0.6);
    const H = 0.02064 * q * q - 0.00448 * Math.pow(q, 2.44) + 0.0108 * lambda * Math.pow(tauDeg, 0.34) * X;
    const dep = this.trDepth + Xm * tanT - H * B;
    return dep > 0 ? dep * dry : 0;
  }

  /**
   * Column-sum the signed wet samples into ≥ 0 plan-cell wake loads whose sum is max(0, netFy), bounded at the V110
   * acceleration (§B126 — see the WakeLoadSamples header for why a steady-wake source may not be forced by one
   * substep of an impact).
   */
  private buildWakeLoad(netFy: number): void {
    const W = this.wet;
    const K = this.wake;
    const patch = this.patch;
    const nu = patch.nu;
    const nw = patch.nw;
    const list = this.cellList;
    let n = 0;
    for (let j = 0; j < W.count; j++) {
      const x = W.centroid[j * 3];
      const z = W.centroid[j * 3 + 2];
      const rx = x - patch.ox;
      const rz = z - patch.oz;
      let iu = Math.floor((rx * patch.e1x + rz * patch.e1z) / patch.du);
      let iw = Math.floor((-rx * patch.e1z + rz * patch.e1x) / patch.dw);
      iu = iu < 0 ? 0 : iu >= nu ? nu - 1 : iu;
      iw = iw < 0 ? 0 : iw >= nw ? nw - 1 : iw;
      const c = iw * nu + iu;
      const aPlan = W.area[j] * Math.abs(W.normal[j * 3 + 1]);
      if (this.cellA[c] === 0 && this.cellFy[c] === 0) list[n++] = c;
      this.cellFy[c] += W.fy[j];
      // weight position/depth by plan area, with a floor so vertical faces still place their load
      const wgt = aPlan + 1e-6 * W.area[j];
      this.cellA[c] += wgt;
      this.cellAx[c] += wgt * x;
      this.cellAz[c] += wgt * z;
      this.cellAd[c] += wgt * Math.max(0, W.depth[j]);
    }
    let pos = 0;
    for (let k = 0; k < n; k++) {
      const f = this.cellFy[list[k]];
      if (f > 0) pos += f;
    }
    // §B126: the same V110 bound the explicit flux loads get. `netFy > 0` is false for NaN, so a non-finite load
    // leaves no wake source at all instead of poisoning every receiver's height sampler.
    const bound = this.params.maxAccel * this.mesh.mass;
    const target = netFy > 0 ? (netFy < bound ? netFy : bound) : 0;
    const scale = pos > 0 ? target / pos : 0;
    let m = 0;
    let sum = 0;
    for (let k = 0; k < n; k++) {
      const c = list[k];
      const f = this.cellFy[c];
      const a = this.cellA[c];
      if (f > 0 && scale > 0) {
        K.x[m] = this.cellAx[c] / a;
        K.z[m] = this.cellAz[c] / a;
        K.fy[m] = f * scale;
        K.sigma[m] = 0.5 * Math.sqrt(a);
        K.depth[m] = this.cellAd[c] / a;
        sum += K.fy[m];
        m++;
      }
      this.cellFy[c] = 0;
      this.cellA[c] = 0;
      this.cellAx[c] = 0;
      this.cellAz[c] = 0;
      this.cellAd[c] = 0;
    }
    K.count = m;
    K.deficit = netFy - sum;
    K.rescale = scale;
  }

  /** GS working point velocity of half-section hI's wet centroid along world direction d */
  private pointVelAlong(hI: number, dx: number, dy: number, dz: number): number {
    const C = this.hCentroid;
    return this.pointVelAt(C[hI * 3] - this.cgx, C[hI * 3 + 1] - this.cgy, C[hI * 3 + 2] - this.cgz, dx, dy, dz) - this.hWv[hI] * dy;
  }

  /** GS working velocity at CG offset r (world) along world direction d */
  private pointVelAt(rx: number, ry: number, rz: number, dx: number, dy: number, dz: number): number {
    const gv = this.gv;
    const gw = this.gw;
    const pvx = gv[0] + (gw[1] * rz - gw[2] * ry);
    const pvy = gv[1] + (gw[2] * rx - gw[0] * rz);
    const pvz = gv[2] + (gw[0] * ry - gw[1] * rx);
    return pvx * dx + pvy * dy + pvz * dz;
  }

  /** j6 ← body [d_b; r_b×d_b] at half-section hI; returns the effective inverse mass j6ᵀ·diag(invM, invI)·j6 */
  private gsInvMass(hI: number, dx: number, dy: number, dz: number): number {
    const C = this.hCentroid;
    return this.gsInvMassAt(C[hI * 3] - this.cgx, C[hI * 3 + 1] - this.cgy, C[hI * 3 + 2] - this.cgz, dx, dy, dz);
  }

  private gsInvMassAt(rx: number, ry: number, rz: number, dx: number, dy: number, dz: number): number {
    const A = this.gsAxes;
    const dbx = dx * A[0] + dy * A[1] + dz * A[2];
    const dby = dx * A[3] + dy * A[4] + dz * A[5];
    const dbz = dx * A[6] + dy * A[7] + dz * A[8];
    const rbx = rx * A[0] + ry * A[1] + rz * A[2];
    const rby = rx * A[3] + ry * A[4] + rz * A[5];
    const rbz = rx * A[6] + ry * A[7] + rz * A[8];
    const j = this.j6;
    j[0] = dbx;
    j[1] = dby;
    j[2] = dbz;
    j[3] = rby * dbz - rbz * dby;
    j[4] = rbz * dbx - rbx * dbz;
    j[5] = rbx * dby - rby * dbx;
    const iM = this.gsInvM;
    const iI = this.gsInvI;
    if (this.gsC6) {
      const Mi = this.minv6;
      let w = 0;
      for (let r = 0; r < 6; r++) {
        let t = 0;
        for (let c = 0; c < 6; c++) t += Mi[r * 6 + c] * j[c];
        w += j[r] * t;
      }
      return w;
    }
    return j[0] * j[0] * iM[0] + j[1] * j[1] * iM[1] + j[2] * j[2] * iM[2] + j[3] * j[3] * iI[0] + j[4] * j[4] * iI[1] + j[5] * j[5] * iI[2];
  }

  /** apply impulse J along the direction of the last gsInvMass call to the GS working velocities */
  private gsApply(_hI: number, _dx: number, _dy: number, _dz: number, J: number): void {
    const A = this.gsAxes;
    const j = this.j6;
    const iM = this.gsInvM;
    const iI = this.gsInvI;
    if (this.gsC6) {
      const Mi = this.minv6;
      const d = this.x6;
      for (let r = 0; r < 6; r++) {
        let t = 0;
        for (let c = 0; c < 6; c++) t += Mi[r * 6 + c] * j[c];
        d[r] = J * t;
      }
      this.gv[0] += d[0] * A[0] + d[1] * A[3] + d[2] * A[6];
      this.gv[1] += d[0] * A[1] + d[1] * A[4] + d[2] * A[7];
      this.gv[2] += d[0] * A[2] + d[1] * A[5] + d[2] * A[8];
      this.gw[0] += d[3] * A[0] + d[4] * A[3] + d[5] * A[6];
      this.gw[1] += d[3] * A[1] + d[4] * A[4] + d[5] * A[7];
      this.gw[2] += d[3] * A[2] + d[4] * A[5] + d[5] * A[8];
      return;
    }
    const lvx = J * j[0] * iM[0];
    const lvy = J * j[1] * iM[1];
    const lvz = J * j[2] * iM[2];
    this.gv[0] += lvx * A[0] + lvy * A[3] + lvz * A[6];
    this.gv[1] += lvx * A[1] + lvy * A[4] + lvz * A[7];
    this.gv[2] += lvx * A[2] + lvy * A[5] + lvz * A[8];
    const awx = J * j[3] * iI[0];
    const awy = J * j[4] * iI[1];
    const awz = J * j[5] * iI[2];
    this.gw[0] += awx * A[0] + awy * A[3] + awz * A[6];
    this.gw[1] += awx * A[1] + awy * A[4] + awz * A[7];
    this.gw[2] += awx * A[2] + awy * A[5] + awz * A[8];
  }

  /**
   * PASSIVITY (T189, `passivity`): the scale σ ∈ [0, 1] on the explicit flux loads (already × the V110 scale `s`) such
   * that the rigid kinetic energy RELATIVE TO THE WATER they add over this substep does not exceed the credit: the
   * energy the entrained water holds, E_f = ½Σ m_a·Δz·V_n² + ½Σ m_lat·Δz·V_L². With g the body generalized velocity
   * relative to the water (vertical ∂η/∂t removed), the rest of the load L₀ (hydrostatics, gravity, impulses, friction)
   * and the explicit load L_e, the substep's velocity is g + h·(M + A₆)⁻¹(L₀ + σL_e), and the explicit part of the
   * kinetic-energy change is ΔE(σ) = σ²·a + σ·b (a = ½·dᵀM·d, b = (g + h(M+A)⁻¹L₀)ᵀM·d, d = h(M+A)⁻¹L_e, M rigid).
   * σ = 1 unless ΔE(1) > credit; the credit then loses what was spent and gains what the explicit loads took out,
   * capped at E_f. Coupled added mass only.
   */
  private passivityLimit(h: number, s: number, bxx: number, bxy: number, bxz: number, byx: number, byy: number, byz: number, bzx: number, bzy: number, bzz: number): number {
    const mesh = this.mesh;
    const m = mesh.mass;
    const ns = mesh.strips.count;
    const nh = 2 * ns;
    const dz = mesh.strips.dz;
    let aw = 0;
    let awv = 0;
    let ef = 0;
    for (let hI = 0; hI < nh; hI++) {
      const A = this.hArea[hI];
      aw += A;
      awv += A * this.hWv[hI];
      ef += 0.5 * this.hMa[hI] * dz * this.hVn[hI] * this.hVn[hI];
    }
    for (let i = 0; i < ns; i++) ef += 0.5 * this.lMa[i] * dz * this.lVL[i] * this.lVL[i];
    const wbar = aw > 0 ? awv / aw : 0;
    const E = this.explicitLoad;
    const G = this.pv6;
    const L0 = this.pl6;
    const L1 = this.pa6;
    const toBody = (x: number, y: number, z: number, o: Float64Array, k: number): void => {
      o[k] = x * bxx + y * bxy + z * bxz;
      o[k + 1] = x * byx + y * byy + z * byz;
      o[k + 2] = x * bzx + y * bzy + z * bzz;
    };
    toBody(this.vx, this.vy - wbar, this.vz, G, 0);
    toBody(this.wx, this.wy, this.wz, G, 3);
    const T = this.explicitTransferLoad;
    // L0: everything but the transfer loads (the flux loads at the V110 scale); L1: the transfer loads at that scale
    toBody(this.fX - E[0] + s * (E[0] - T[0]), this.fY - E[1] + s * (E[1] - T[1]) - m * this.params.gravity, this.fZ - E[2] + s * (E[2] - T[2]), L0, 0);
    toBody(this.tX - E[3] + s * (E[3] - T[3]), this.tY - E[4] + s * (E[4] - T[4]), this.tZ - E[5] + s * (E[5] - T[5]), L0, 3);
    toBody(s * T[0], s * T[1], s * T[2], L1, 0);
    toBody(s * T[3], s * T[4], s * T[5], L1, 3);
    const Mi = this.minv6;
    const ds = this.pb6;
    const dd = this.pd6;
    for (let r = 0; r < 6; r++) {
      let a0 = 0;
      let a1 = 0;
      for (let c = 0; c < 6; c++) {
        a0 += Mi[r * 6 + c] * L0[c];
        a1 += Mi[r * 6 + c] * L1[c];
      }
      ds[r] = G[r] + h * a0;
      dd[r] = h * a1;
    }
    const I = mesh.inertia;
    let qa = 0;
    let qb = 0;
    for (let r = 0; r < 6; r++) {
      const mr = r < 3 ? m : I[r - 3];
      qa += 0.5 * mr * dd[r] * dd[r];
      qb += mr * ds[r] * dd[r];
    }
    const credit = this.credit > 0 ? this.credit : 0;
    let sigma = 1;
    if (qa + qb > credit && qa > 0) {
      sigma = (-qb + Math.sqrt(Math.max(0, qb * qb + 4 * qa * credit))) / (2 * qa);
      sigma = sigma < 0 ? 0 : sigma > 1 ? 1 : sigma;
    }
    const spent = qa * sigma * sigma + qb * sigma;
    this.credit = Math.min(ef, this.credit - spent);
    return sigma;
  }

  /**
   * PASSIVITY CREDIT FROM THE IMPULSES (T196). T189's bound let the transfer loads return at most what the EXPLICIT loads
   * had banked, so a hull arriving from the air (credit 0) had its rotating-frame, gyroscopic and Kirchhoff loads zeroed
   * through the whole touchdown — including their roll damping of a heeled landing (measured, crossing swell C_v 8: the
   * transfer roll moment opposed the roll rate at +13…+19 kN·m while σ = 0). The water that the slam and drag impulses
   * set moving holds the energy they took from the hull; that is the "plus what the dissipative terms have taken out"
   * of the bound. Banked here as ½·ΔgᵀM_rigid g between the substep's start and the Gauss–Seidel working velocities
   * (relative to the water's mean vertical velocity), still capped at the entrained water's energy in passivityLimit.
   */
  private bankImpulseDissipation(vx: number, vy: number, vz: number, wx: number, wy: number, wz: number, bxx: number, bxy: number, bxz: number, byx: number, byy: number, byz: number, bzx: number, bzy: number, bzz: number): void {
    const nh = this.hArea.length;
    let aw = 0;
    let awv = 0;
    for (let hI = 0; hI < nh; hI++) {
      aw += this.hArea[hI];
      awv += this.hArea[hI] * this.hWv[hI];
    }
    const wbar = aw > 0 ? awv / aw : 0;
    const m = this.mesh.mass;
    const I = this.mesh.inertia;
    const ke = (ux: number, uy: number, uz: number, ox: number, oy: number, oz: number): number => {
      const y = uy - wbar;
      const a = ox * bxx + oy * bxy + oz * bxz;
      const b = ox * byx + oy * byy + oz * byz;
      const c = ox * bzx + oy * bzy + oz * bzz;
      return 0.5 * m * (ux * ux + y * y + uz * uz) + 0.5 * (I[0] * a * a + I[1] * b * b + I[2] * c * c);
    };
    const d = ke(vx, vy, vz, wx, wy, wz) - ke(this.gv[0], this.gv[1], this.gv[2], this.gw[0], this.gw[1], this.gw[2]);
    if (d > 0) this.credit += d;
  }

  /** snapshot the totals and the per-half vertical force before the explicit flux loads */
  private markExplicit(): void {
    const M = this.expMark;
    M[0] = this.fX;
    M[1] = this.fY;
    M[2] = this.fZ;
    M[3] = this.tX;
    M[4] = this.tY;
    M[5] = this.tZ;
    const SF = this.sForce;
    const Y = this.sForceExpY;
    for (let hI = 0; hI < Y.length; hI++) Y[hI] = SF[hI * 3 + 1];
  }

  /** the transfer loads (rotating frame, gyroscopic, Kirchhoff) end here: their totals and per-half vertical force */
  private transferExplicit(): void {
    const M = this.expMark;
    const T = this.explicitTransferLoad;
    T[0] = this.fX - M[0];
    T[1] = this.fY - M[1];
    T[2] = this.fZ - M[2];
    T[3] = this.tX - M[3];
    T[4] = this.tY - M[4];
    T[5] = this.tZ - M[5];
    const SF = this.sForce;
    const Y = this.sForceExpY;
    const TY = this.sForceTrY;
    for (let hI = 0; hI < Y.length; hI++) TY[hI] = SF[hI * 3 + 1] - Y[hI];
  }

  /** what the explicit flux loads added since `markExplicit` (totals → expLoad, per-half vertical → sForceExpY) */
  private endExplicit(): void {
    const M = this.expMark;
    const E = this.explicitLoad;
    E[0] = this.fX - M[0];
    E[1] = this.fY - M[1];
    E[2] = this.fZ - M[2];
    E[3] = this.tX - M[3];
    E[4] = this.tY - M[4];
    E[5] = this.tZ - M[5];
    const SF = this.sForce;
    const Y = this.sForceExpY;
    for (let hI = 0; hI < Y.length; hI++) Y[hI] = SF[hI * 3 + 1] - Y[hI];
  }

  /**
   * `addLateralStripForce` with PANEL PRESSURE ≥ AMBIENT (`panelSuctionLimit`): each half's share f_h·n̂_h of the sway
   * load may pull on its panel (component along the half's section normal N̂_h negative) by at most the positive normal
   * load that half carries this substep (planing lift + hydrostatic pressure) — beyond that the panel's mean pressure
   * would be sub-ambient while it is open to the air at its spray root.
   */
  private addLateralStripForceLimited(i: number, F: number): void {
    const W = this.lpw;
    if (W[2 * i] === 0 && W[2 * i + 1] === 0) {
      this.addStripForce(i, F * this.lDir[i * 3], F * this.lDir[i * 3 + 1], F * this.lDir[i * 3 + 2]);
      return;
    }
    const C = this.hLat;
    const Nn = this.lpn;
    const HN = this.hNormal;
    for (let side = 0; side < 2; side++) {
      const hI = 2 * i + side;
      let f = F * W[hI];
      if (f === 0) continue;
      const cs = Nn[hI * 3] * HN[hI * 3] + Nn[hI * 3 + 1] * HN[hI * 3 + 1] + Nn[hI * 3 + 2] * HN[hI * 3 + 2];
      // the panel's positive normal load: planing lift + hydrostatic pressure (along the section normal)
      const Hh = this.hHyd;
      const hyd = Hh[hI * 3] * HN[hI * 3] + Hh[hI * 3 + 1] * HN[hI * 3 + 1] + Hh[hI * 3 + 2] * HN[hI * 3 + 2];
      const avail = (this.sLift[hI] > 0 ? this.sLift[hI] : 0) + (hyd > 0 ? hyd : 0);
      if (cs > 0.1 && f * cs < -avail) f = -avail / cs;
      this.addForceAt(hI, f * Nn[hI * 3], f * Nn[hI * 3 + 1], f * Nn[hI * 3 + 2], C[hI * 3] - this.cgx, C[hI * 3 + 1] - this.cgy, C[hI * 3 + 2] - this.cgz);
    }
  }

  /**
   * ZERO-SPEED WAVE RADIATION DAMPING (T196, `radiationDamping`; tables and sources at RAD_A33). Per wet strip i:
   *  - section: waterline half-beam b = mean geometric wetted half-width of its halves, keel draft T = S.d, deadrise
   *    β = atan(T/b), area ≈ b·T (a wedge with the section's beam and draft);
   *  - frequency (the documented approximation): the SECTION'S OWN HEAVE NATURAL FREQUENCY, ω² = ρgB/(ρ·bT + M₃₃(ω)), i.e.
   *    ξ = ω²b/g = 1/(2(T/(4b) + a33(β, ξ))), fixed point (≈ ξ 1.24–1.27, ω 3.3–3.9 rad/s on the deep-V at rest; the hull's
   *    heave period is 2.25 s, ω 2.8 — N₃₃ differs < 5 % between the two because b33·ω is flat there);
   *  - load: −k·V along world vertical at the strip's wet centroid, k = b33(β, ξ)·ρ·ω·B²·Δz × fade, V the point's
   *    vertical velocity relative to the water (∂η/∂t, as every other fluid velocity), as a linearised implicit impulse
   *    (dissipative, never reverses the point), split over its halves by area;
   *  - fade: 1 − smoothstep of the length Froude number between RAD_FADE_FN0 and RAD_FADE_FN1 (U along the hull).
   * Heave only, on the centre line: a V-section radiates little in roll (Frank, same tables: at the hull's 3.4 s roll
   * period the strip sum is ≈ 1 kN·m·s/rad, ζ 0.02) and applying N₃₃ per HALF would have made it ≈ 8× that.
   * Strip theory with these coefficients (scratch `t196/rad/strip.py`, the rest pose): ζ_heave 0.28, ζ_pitch 0.24 at the
   * model's own periods and inertias.
   */
  private radiationDampingPass(h: number): void {
    const mesh = this.mesh;
    const prm = this.params;
    const S = this.sections;
    const ns = mesh.strips.count;
    const g = prm.gravity;
    const L = mesh.stemZ - mesh.transomZ;
    const u = Math.abs(this.vx * this.bzX + this.vy * this.bzY + this.vz * this.bzZ);
    const fn = L > 0 ? u / Math.sqrt(g * L) : 0;
    const e = Math.min(1, Math.max(0, (fn - RAD_FADE_FN0) / (RAD_FADE_FN1 - RAD_FADE_FN0)));
    const fade = 1 - e * e * (3 - 2 * e);
    this.radiationScale = fade;
    if (!(fade > 0)) return;
    const patch = this.patch;
    const waterVel = prm.waterVelocity;
    const dz = mesh.strips.dz;
    for (let i = 0; i < ns; i++) {
      const A = S.wetArea[i];
      const d = S.d[i];
      if (A <= 1e-9 || !(d > 0)) continue;
      const b = 0.5 * (this.hCg[2 * i] + this.hCg[2 * i + 1]);
      if (!(b > 1e-3)) continue;
      const betaDeg = (Math.atan2(d, b) * 180) / Math.PI;
      const sArea = d / (4 * b);
      let xi = 1.2;
      for (let it = 0; it < 4; it++) xi = 1 / (2 * (sArea + radiationCoeff(RAD_A33, betaDeg, xi)));
      const om = Math.sqrt((xi * g) / b);
      const k = radiationCoeff(RAD_B33, betaDeg, xi) * prm.rho * om * 4 * b * b * dz * fade * h;
      const cx = S.centroid[i * 3];
      const cz = S.centroid[i * 3 + 2];
      const rx = cx - this.cgx;
      const ry = S.centroid[i * 3 + 1] - this.cgy;
      const rz = cz - this.cgz;
      const wv = waterVel ? patch.verticalVelocityAt(cx, cz) : 0;
      const V = this.pointVelAt(rx, ry, rz, 0, 1, 0) - wv;
      if (V === 0) continue;
      const w = this.gsInvMassAt(rx, ry, rz, 0, 1, 0);
      const J = (-k * V) / (1 + k * w);
      this.gsApply(-1, 0, 1, 0, J);
      this.radiationImpulse += J;
      for (let side = 0; side < 2; side++) {
        const hI = 2 * i + side;
        const wA = this.hArea[hI] / A;
        if (wA > 0) this.addForceAt(hI, 0, (wA * J) / h, 0, rx, ry, rz);
      }
    }
  }

  /**
   * SEPARATED NORMAL-PRESSURE DRAG on the wet NON-running faces (`faceDragCoeff`): per wet triangle of the deck lid,
   * transom or stem cap, a linearised implicit impulse −k·V/(1 + k·w) along its outward normal, k = ½ρ·C_D·A·|V|·h,
   * V the normal velocity relative to the water (vertical ∂η/∂t included), the transom face × its Froude wetting.
   * Its vertical force goes to that triangle's HydroSample (Σ fy = load, V-W2).
   */
  private faceDrag(h: number): void {
    const W = this.wet;
    const cd = 0.5 * this.params.rho * this.params.faceDragCoeff;
    const patch = this.patch;
    const waterVel = this.params.waterVelocity;
    for (let j = 0; j < W.count; j++) {
      if (this.wHalf[j] >= 0) continue;
      const cx = W.centroid[j * 3];
      const cz = W.centroid[j * 3 + 2];
      const rx = cx - this.cgx;
      const ry = W.centroid[j * 3 + 1] - this.cgy;
      const rz = cz - this.cgz;
      const ff = this.faceFactor(rx * this.bzX + ry * this.bzY + rz * this.bzZ);
      if (!(ff > 0)) continue;
      const nx = W.normal[j * 3];
      const ny = W.normal[j * 3 + 1];
      const nz = W.normal[j * 3 + 2];
      const wv = waterVel ? patch.verticalVelocityAt(cx, cz) : 0;
      const V = this.pointVelAt(rx, ry, rz, nx, ny, nz) - wv * ny;
      if (V === 0) continue;
      const k = cd * W.area[j] * ff * Math.abs(V) * h;
      const wInv = this.gsInvMassAt(rx, ry, rz, nx, ny, nz);
      const J = (-k * V) / (1 + k * wInv);
      this.gsApply(-1, nx, ny, nz, J);
      const fx = (J * nx) / h;
      const fy = (J * ny) / h;
      const fz = (J * nz) / h;
      this.fX += fx;
      this.fY += fy;
      this.fZ += fz;
      this.tX += ry * fz - rz * fy;
      this.tY += rz * fx - rx * fz;
      this.tZ += rx * fy - ry * fx;
      W.fy[j] += fy;
    }
  }

  /** a world force on strip i, split between its wet half-sections by area and applied at their centroids
   *  (Σ area-weighted half centroids = the strip centroid, so the torque is the strip's) */
  private addStripForce(i: number, fx: number, fy: number, fz: number): void {
    const A = this.sections.wetArea[i];
    if (A <= 1e-9) return;
    const C = this.hGeo;
    for (let side = 0; side < 2; side++) {
      const hI = 2 * i + side;
      const w = this.hArea[hI] / A;
      if (w <= 0) continue;
      this.addForceAt(hI, fx * w, fy * w, fz * w, C[hI * 3] - this.cgx, C[hI * 3 + 1] - this.cgy, C[hI * 3 + 2] - this.cgz);
    }
  }

  /**
   * A SWAY load of magnitude F along strip i's lateral axis L̂, carried as PRESSURE NORMAL TO THE BOTTOM
   * PANELS: each wet half gets f_h·n̂_h along its own panel normal (Σ over the wet triangles of that half, ⊥ body
   * z), with f_h = F·w_h (see lateralJacobian), so the lateral components add to F. For an upright V the normal
   * components cancel and what is left is WHERE the side force acts: the panel-normal lines through the
   * antisymmetric Wagner centres πc_W/4 meet the centre line well above the keel, so a hull sliding outward in
   * a turn is rolled INTO it. Source for the mechanism: the side force on a drifting planing hull is "a strong
   * pressure increase at one of the spray roots" (Marleaux, Simonis & Abdel-Maksoud, 35th Symp. Naval
   * Hydrodynamics 2024, 2D+t BEM vs Brown & Klosinski 1994 tests). The same force through the strip centroid
   * heels her OUT of the turn (measured −2…−5° at C_v 3–5, −13° at C_v 10). `drag` selects the crossflow set
   * (geometric centroids). The sway rotating-frame and Kirchhoff loads also go through here.
   * No panel with a lateral slope (s = 0, a flat plate with dry sides) ⇒ plain force at the strip centroid.
   */
  private addLateralStripForce(i: number, F: number, drag = false): void {
    const W = drag ? this.lpwD : this.lpw;
    if (W[2 * i] === 0 && W[2 * i + 1] === 0) {
      this.addStripForce(i, F * this.lDir[i * 3], F * this.lDir[i * 3 + 1], F * this.lDir[i * 3 + 2]);
      return;
    }
    const C = drag ? this.hGeo : this.hLat;
    const Nn = this.lpn;
    for (let side = 0; side < 2; side++) {
      const hI = 2 * i + side;
      const f = F * W[hI];
      if (f === 0) continue;
      this.addForceAt(hI, f * Nn[hI * 3], f * Nn[hI * 3 + 1], f * Nn[hI * 3 + 2], C[hI * 3] - this.cgx, C[hI * 3 + 1] - this.cgy, C[hI * 3 + 2] - this.cgz);
    }
  }

  /**
   * THE SWAY MODE OF STRIP i as ONE generalized coordinate (T179): the side force is panel pressure f_h·n̂_h with
   * f_h = F·w_h, w_h = A_h·s_h/Σ A·s², so a unit F is the world force f = Σ w_h·n̂_h (≈ L̂) and moment
   * m = Σ w_h·r_h × n̂_h. The SAME (f, m) is used for the strip's sway velocity V = f·v + m·ω, its added-mass
   * contribution a·[f; m][f; m]ᵀ, and its Gauss–Seidel impulses — dissipative by construction (force·velocity).
   * Taking the velocity at the strip centroid while the force acted along the panel lines (the first T179
   * version) made a roll rate, which moves the keel sideways BELOW the CG, raise a side force whose line passes
   * ABOVE the CG: negative roll damping (linearised about a C_v 8 steady turn: a 1.7 Hz roll–sway–heave mode
   * growing at +1.8/s). Two sets, one per pressure distribution:
   *  - potential (added mass, entry, rotating frame, momentum flux): r_h = the antisymmetric Wagner centre πc_W/4;
   *  - separated crossflow drag: r_h = the geometric wet centroid (the pressure of a separated crossflow is spread
   *    over the leading panel, not peaked at the spray root). Through the spray-root point the drag's heave- and
   *    heel-dependent projected area drove the same roll–sway–heave mode (linearised growth +2/s at C_v 10 half
   *    lock, −1/s with the drag at the centroid).
   * No panel with lateral slope ⇒ f = L̂ at the strip centroid.
   */
  private lateralJacobian(i: number, lx: number, ly: number, lz: number, rcx: number, rcy: number, rcz: number, bzx: number, bzy: number, bzz: number): void {
    const Nn = this.lpn;
    const S2 = this.pnl;
    let den = 0;
    for (let side = 0; side < 2; side++) {
      const hI = 2 * i + side;
      this.lpw[hI] = 0;
      this.lpwD[hI] = 0;
      S2[side] = 0;
      if (this.hArea[hI] <= 1e-9) continue;
      let nx = this.sSx[hI];
      let ny = this.sSy[hI];
      let nz = this.sSz[hI];
      const al = nx * bzx + ny * bzy + nz * bzz;
      nx -= al * bzx;
      ny -= al * bzy;
      nz -= al * bzz;
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (nl <= 1e-12) continue;
      Nn[hI * 3] = nx / nl;
      Nn[hI * 3 + 1] = ny / nl;
      Nn[hI * 3 + 2] = nz / nl;
      const sh = (nx * lx + ny * ly + nz * lz) / nl;
      S2[side] = sh;
      den += this.hArea[hI] * sh * sh;
    }
    const o = i * 3;
    for (let set = 0; set < 2; set++) {
      const F = set === 0 ? this.lJf : this.lJfD;
      const M = set === 0 ? this.lJm : this.lJmD;
      const W = set === 0 ? this.lpw : this.lpwD;
      const C = set === 0 ? this.hLat : this.hGeo;
      if (den <= 1e-9 * this.sections.wetArea[i]) {
        F[o] = lx;
        F[o + 1] = ly;
        F[o + 2] = lz;
        M[o] = rcy * lz - rcz * ly;
        M[o + 1] = rcz * lx - rcx * lz;
        M[o + 2] = rcx * ly - rcy * lx;
        continue;
      }
      F[o] = F[o + 1] = F[o + 2] = M[o] = M[o + 1] = M[o + 2] = 0;
      for (let side = 0; side < 2; side++) {
        const hI = 2 * i + side;
        if (S2[side] === 0) continue;
        const w = (this.hArea[hI] * S2[side]) / den;
        W[hI] = w;
        const nx = Nn[hI * 3];
        const ny = Nn[hI * 3 + 1];
        const nz = Nn[hI * 3 + 2];
        const rx = C[hI * 3] - this.cgx;
        const ry = C[hI * 3 + 1] - this.cgy;
        const rz = C[hI * 3 + 2] - this.cgz;
        F[o] += w * nx;
        F[o + 1] += w * ny;
        F[o + 2] += w * nz;
        M[o] += w * (ry * nz - rz * ny);
        M[o + 1] += w * (rz * nx - rx * nz);
        M[o + 2] += w * (rx * ny - ry * nx);
      }
    }
  }

  /** GS working velocity of strip i's sway mode (drag = the crossflow set) */
  private gsVelJ(i: number, drag = false): number {
    const F = drag ? this.lJfD : this.lJf;
    const M = drag ? this.lJmD : this.lJm;
    const o = i * 3;
    const v = this.gv;
    const w = this.gw;
    return F[o] * v[0] + F[o + 1] * (v[1] - this.sWv[i]) + F[o + 2] * v[2] + M[o] * w[0] + M[o + 1] * w[1] + M[o + 2] * w[2];
  }

  /** j6 ← strip i's sway Jacobian in the body frame; returns its effective inverse mass */
  private gsInvMassJ(i: number, drag = false): number {
    const A = this.gsAxes;
    const F = drag ? this.lJfD : this.lJf;
    const M = drag ? this.lJmD : this.lJm;
    const o = i * 3;
    const j = this.j6;
    j[0] = F[o] * A[0] + F[o + 1] * A[1] + F[o + 2] * A[2];
    j[1] = F[o] * A[3] + F[o + 1] * A[4] + F[o + 2] * A[5];
    j[2] = F[o] * A[6] + F[o + 1] * A[7] + F[o + 2] * A[8];
    j[3] = M[o] * A[0] + M[o + 1] * A[1] + M[o + 2] * A[2];
    j[4] = M[o] * A[3] + M[o + 1] * A[4] + M[o + 2] * A[5];
    j[5] = M[o] * A[6] + M[o + 1] * A[7] + M[o + 2] * A[8];
    if (this.gsC6) {
      const Mi = this.minv6;
      let wsum = 0;
      for (let r = 0; r < 6; r++) {
        let t = 0;
        for (let c = 0; c < 6; c++) t += Mi[r * 6 + c] * j[c];
        wsum += j[r] * t;
      }
      return wsum;
    }
    const iM = this.gsInvM;
    const iI = this.gsInvI;
    return j[0] * j[0] * iM[0] + j[1] * j[1] * iM[1] + j[2] * j[2] * iM[2] + j[3] * j[3] * iI[0] + j[4] * j[4] * iI[1] + j[5] * j[5] * iI[2];
  }

  /**
   * WAGNER CENTRES OF PRESSURE (T179 heel). The half-section loads used to act at the half's GEOMETRIC wet
   * centroid, half-way from keel to waterline. A planing section's pressure is not uniform. For Wagner's plate
   * (half-width c_W, φ = 0 free surface; Wagner 1932, Faltinsen 2005 §8–9), per side:
   *  - STEADY (symmetric, ċ-driven) pressure ∝ 1/√(c_W² − x²): centre x̄ = 2c_W/π  → `hSteady` (steady lift);
   *  - SWAY (antisymmetric, ċ-driven) pressure: centre x̄ = πc_W/4 (checked numerically for a sign-type normal
   *    velocity, scratch plate.py; the drift pressure peak sits "at one of the spray roots", Marleaux et al.
   *    2024) → `hLat` (the sway mode's potential loads, see lateralJacobian);
   *  - RATE terms (rotation, entry, crossflow, rotating frame, unsteady lift, GS impulse points, the 6×6 lever
   *    arms): the point whose ±x̄ half-model reproduces the plate's roll added inertia m_a·c_W²/8, x̄ = c_W/(2√2)
   *    → `hCentroid`. Putting those at 2c_W/π overstated roll damping and added inertia ≈3×.
   * c_W = min((π/2)·c_g, chine), c_g the half's geometric wet width. The centroid form halved the lever of the
   * steady lift about the keel — dynamic roll stiffness 0.27·mgB/rad at C_v 8 against ~0.57 measured by Brown &
   * Klosinski — and put the side-force line below the CG once the chines dried: she heeled OUT of turns at C_v ≥ 8
   * (−13° at C_v 10). Points move along the panel (same body z) from the keel line; hydrostatics and friction
   * stay on the triangles; the crossflow drag and strip-level loads use the geometric centroid `hGeo`.
   */
  private placeCentresOfPressure(hI: number, i: number, cgH: number, byx: number, byy: number, byz: number, bzx: number, bzy: number, bzz: number): void {
    const C = this.hCentroid;
    const Lp = this.hLat;
    const o = hI * 3;
    this.hSteady[o] = C[o];
    this.hSteady[o + 1] = C[o + 1];
    this.hSteady[o + 2] = C[o + 2];
    if (!this.params.wagnerCentreOfPressure) return;
    const gx = C[o] - this.cgx;
    const gy = C[o + 1] - this.cgy;
    const gz = C[o + 2] - this.cgz;
    const bxx = this.latX;
    const bxy = this.latY;
    const bxz = this.latZ;
    const rbx = gx * bxx + gy * bxy + gz * bxz;
    const rby = gx * byx + gy * byy + gz * byz;
    const rbz = gx * bzx + gy * bzy + gz * bzz;
    const ax = Math.abs(rbx);
    if (ax <= 1e-6) {
      this.hSteady[o] = C[o];
      this.hSteady[o + 1] = C[o + 1];
      this.hSteady[o + 2] = C[o + 2];
      return;
    }
    const chine = this.mesh.strips.chineHalfBeam[i];
    const kY = this.mesh.strips.keelY[i];
    const cWh = Math.min(HALF_PI * cgH, chine);
    const Sd = this.hSteady;
    for (let pass = 0; pass < 3; pass++) {
      // 0: steady (symmetric Wagner) centre 2c_W/π; 1: sway (antisymmetric) centre πc_W/4; 2: rate point c_W/(2√2)
      const xbar = pass === 0 ? (2 / Math.PI) * cWh : pass === 1 ? (Math.PI / 4) * cWh : cWh / (2 * Math.SQRT2);
      const T = pass === 0 ? Sd : pass === 1 ? Lp : C;
      const sc = Math.min(3, Math.max(0.25, xbar / ax));
      const px = rbx * sc;
      const py = kY + (rby - kY) * sc;
      T[o] = this.cgx + px * bxx + py * byx + rbz * bzx;
      T[o + 1] = this.cgy + px * bxy + py * byy + rbz * bzy;
      T[o + 2] = this.cgz + px * bxz + py * byz + rbz * bzz;
    }
  }

  /**
   * PLANING PANEL FACING (T189, `planingFacing`): smoothstep of the world-up component of a panel's inward normal
   * (the Σ(−n̂A) of its wet triangles, projected ⊥ body z) from 0 (horizontal) to 0.26 (75° from vertical). 1 for every
   * upright or heeled-to-60° planing panel; 0 for a bottom turned side-on or up.
   */
  private panelFacing(sx: number, sy: number, sz: number, bzx: number, bzy: number, bzz: number): number {
    const al = sx * bzx + sy * bzy + sz * bzz;
    const px = sx - al * bzx;
    const py = sy - al * bzy;
    const pz = sz - al * bzz;
    const pl = Math.sqrt(px * px + py * py + pz * pz);
    if (!(pl > 0)) return 0;
    const e = Math.min(1, Math.max(0, py / pl / 0.26));
    return e * e * (3 - 2 * e);
  }

  /**
   * CHINE-WET ADDED MASS of a HEELED section (Δc² of half-section `side` of strip i). Once the splash-up reaches a
   * chine the flow separates there, but the added mass does not stop growing with immersion: Payne (Ocean Eng.
   * 21(3), 1994), as reproduced and used for roll restoring by Katayama, Fujimoto & Ikeda (J. JASNAOE 3, 2006),
   * m′ = C·ρ(π/2)(b_x/2)²·f(A) with C_wet = (1 + 2z_c/b_x)·C_dry, z_c = the chine's immersion below the level at which
   * the splash-up first wet it (b_x = chine beam). With half-beam b that is c² = b² + b·z_c, b·z_c/2 per side. The
   * splash-up first wets the chine when the geometric half-width is 2b/π (Wagner), i.e. with the chine b(1 − 2/π)·tanβ
   * above the surface, so z_c,h = d_chine,h + b(1 − 2/π)·tanβ.
   * ONLY THE DIFFERENCE BETWEEN THE TWO CHINES is added, to the deeper one: Δc²_h = b·max(0, z⁺_c,h − z⁺_c,other)/2.
   * The symmetric part is already inside the section this model was validated with (Wagner cap at the chine, Garme,
   * side-wall hydrostatics — Savitsky within 1° of trim); adding Payne's symmetric growth on top moved the C_v 3.1
   * equilibrium trim to 1.21° below Savitsky (measured), so it is not added. What the c_g² share cannot give is a
   * section that sinks one chine: both halves hit the SAME section cap, so the heeled low half gained no added mass
   * as its chine went under — dynamic roll stiffness and damping collapsed past ~20° of heel (C_v 3: K_p −25 → −2
   * kN·m·s/rad from 0° to 30°), Katayama's chine-wet loss of restoring with nothing to answer it.
   */
  private chineWetGrowth(i: number, side: number): number {
    const st = this.mesh.strips;
    const t = st.chineT![i];
    const lift = this.mesh.strips.chineHalfBeam[i] * (1 - 2 / Math.PI) * Math.tan(st.deadrise![i]);
    const hI = 2 * i + side;
    const oI = 2 * i + 1 - side;
    const zc = this.pd[st.chineV0![hI]] * (1 - t) + this.pd[st.chineV1![hI]] * t + lift;
    const zo = this.pd[st.chineV0![oI]] * (1 - t) + this.pd[st.chineV1![oI]] * t + lift;
    const d = (zc > 0 ? zc : 0) - (zo > 0 ? zo : 0);
    return d > 0 ? 0.5 * st.chineHalfBeam[i] * d : 0;
  }

  /** fraction of a positive lift contribution s + u that is the steady part */
  private steadyShare(s: number, u: number): number {
    if (s <= 0) return 0;
    if (u <= 0) return 1;
    return s / (s + u);
  }

  /** a force of magnitude f along half-section hI's normal, at its wet centroid, into totals and samples */
  private addHalfForce(hI: number, f: number): void {
    const N = this.hNormal;
    const C = this.hCentroid;
    const fx = f * N[hI * 3];
    const fy = f * N[hI * 3 + 1];
    const fz = f * N[hI * 3 + 2];
    this.addForceAt(hI, fx, fy, fz, C[hI * 3] - this.cgx, C[hI * 3 + 1] - this.cgy, C[hI * 3 + 2] - this.cgz);
  }

  private addForceAt(hI: number, fx: number, fy: number, fz: number, rx: number, ry: number, rz: number): void {
    const SF = this.sForce;
    SF[hI * 3] += fx;
    SF[hI * 3 + 1] += fy;
    SF[hI * 3 + 2] += fz;
    this.fX += fx;
    this.fY += fy;
    this.fZ += fz;
    this.tX += ry * fz - rz * fy;
    this.tY += rz * fx - rx * fz;
    this.tZ += rx * fy - ry * fx;
  }

  /**
   * Quadratic drag −coef·V|V| along world unit d at half-section hI's wet centroid, as a linearised
   * implicit impulse over h (never reverses the point). Applied to the GS velocities and accumulated
   * into the half-section force and the totals as impulse/h.
   */
  private gsDrag(hI: number, dx: number, dy: number, dz: number, coef: number, h: number): void {
    const V = this.pointVelAlong(hI, dx, dy, dz);
    if (V === 0) return;
    const w = this.gsInvMass(hI, dx, dy, dz);
    // linearised backward Euler on m_eff·dV/dt = −coef·|V|·V at this point: V' = V/(1 + coef·|V|·h·w).
    // It removes only a FRACTION of the point's velocity (an under-relaxed Gauss–Seidel step), so a
    // sweep over near-collinear sections does not overshoot the way a per-point "stop" clamp did
    // (measured: +11 m/s rebound at C_Dc 2000); at physical coefficients it equals the explicit drag.
    const k = coef * Math.abs(V) * h;
    const J = (-k * V) / (1 + k * w);
    this.gsApply(hI, dx, dy, dz, J);
    const C = this.hCentroid;
    this.addForceAt(hI, (J * dx) / h, (J * dy) / h, (J * dz) / h, C[hI * 3] - this.cgx, C[hI * 3 + 1] - this.cgy, C[hI * 3 + 2] - this.cgz);
  }

  /** Garme C_T at body-frame z (relative to CG); 1 when the reduction is off or the hull is at rest */
  private transomFactor(bodyZ: number): number {
    if (this.garmeK === 0) return 1;
    const xT = this.uForward ? bodyZ - this.mesh.transomZ : this.mesh.stemZ - bodyZ;
    return xT <= 0 ? 0 : Math.tanh(this.garmeK * xT);
  }

  /**
   * Non-running-surface faces (transom, stem cap, deck lid) take hydrostatics without Garme's SECTIONAL
   * reduction. RESTING-DRIFT ROOT CAUSE (T179): the transom face sits at x_T = 0 exactly, where tanh(k·x_T) is 0
   * for any k > 0 — i.e. at any surge ≠ 0, however small — and 1 at exactly zero speed; with the rounding of
   * x_T (±4e-16) and the sign of a 1e-7 m/s surge deciding which end is "trailing", the transom's hydrostatic
   * push switched on and off: a one-way brake that turned bobbing into a 0.45 m walk in 30 s (and hid the
   * missing Kirchhoff load, see evaluate). Now the TRAILING face is wet at rest and dries with its draft
   * Froude number (TRANSOM_WET_FN → TRANSOM_DRY_FN): at planing speed it carries no pressure (a ventilated
   * transom, which is what the Garme reduction was standing in for), at rest full hydrostatics.
   */
  private faceFactor(bodyZ: number): number {
    if (this.garmeK === 0) return 1;
    const L = this.mesh.stemZ - this.mesh.transomZ;
    const xT = this.uForward ? bodyZ - this.mesh.transomZ : this.mesh.stemZ - bodyZ;
    return xT <= 1e-6 * L ? this.trailWet : 1;
  }

  private latX = 1;
  private latY = 0;
  private latZ = 0;

  private emit(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
    da: number,
    db: number,
    dc: number,
    strip: number,
  ): void {
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const qx = cx - ax;
    const qy = cy - ay;
    const qz = cz - az;
    const nx = uy * qz - uz * qy;
    const ny = uz * qx - ux * qz;
    const nz = ux * qy - uy * qx;
    const A2 = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (A2 < 1e-12) return;
    const A = 0.5 * A2;
    const nnx = nx / A2;
    const nny = ny / A2;
    const nnz = nz / A2;
    const depth = (da + db + dc) / 3;
    const gx = (ax + bx + cx) / 3;
    const gy = (ay + by + cy) / 3;
    const gz = (az + bz + cz) / 3;
    const rx = gx - this.cgx;
    const ry = gy - this.cgy;
    const rz = gz - this.cgz;
    const pvx = this.vx + (this.wy * rz - this.wz * ry);
    const pvy = this.vy + (this.wz * rx - this.wx * rz);
    const pvz = this.vz + (this.wx * ry - this.wy * rx);

    // hydrostatic (force at the centroid is exact; torque below uses the centre of pressure),
    // × Garme's near-transom reduction at this triangle's distance from the trailing edge
    const ct = strip >= 0 ? this.transomFactor(rx * this.bzX + ry * this.bzY + rz * this.bzZ) : this.faceFactor(rx * this.bzX + ry * this.bzY + rz * this.bzZ);
    const ps = -this.params.rho * this.params.gravity * depth * A * ct;
    const fx = ps * nnx;
    const fy = ps * nny;
    const fz = ps * nnz;
    this.fX += fx;
    this.fY += fy;
    this.fZ += fz;
    // hydrostatic torque at the TRUE centre of pressure: for pressure linear over the
    // triangle, ∫d·r dA = A/12·[(Σd)(Σr) + Σd_i·r_i]. The centroid form depends on how a
    // clipped quad was split, and the split follows the winding, which is MIRRORED port
    // vs starboard — it made a symmetric hull at rest yaw (measured −70 N·m, 20° in 20 s).
    {
      const sd = da + db + dc;
      const k12 = A / 12;
      const mx = k12 * (sd * (ax + bx + cx) + da * ax + db * bx + dc * cx) - depth * A * this.cgx;
      const my = k12 * (sd * (ay + by + cy) + da * ay + db * by + dc * cy) - depth * A * this.cgy;
      const mz = k12 * (sd * (az + bz + cz) + da * az + db * bz + dc * cz) - depth * A * this.cgz;
      // τ = (∫d·(r−cg) dA) × (−ρg·C_T·n̂)
      const k = -this.params.rho * this.params.gravity * ct;
      const hx = k * nnx;
      const hy = k * nny;
      const hz = k * nnz;
      this.tX += my * hz - mz * hy;
      this.tY += mz * hx - mx * hz;
      this.tZ += mx * hy - my * hx;
    }
    this.wettedArea += A;
    this.displacedVolume += -depth * A * nny;

    const W = this.wet;
    const j = W.count++;
    W.centroid[j * 3] = gx;
    W.centroid[j * 3 + 1] = gy;
    W.centroid[j * 3 + 2] = gz;
    W.normal[j * 3] = nnx;
    W.normal[j * 3 + 1] = nny;
    W.normal[j * 3 + 2] = nnz;
    W.area[j] = A;
    W.depth[j] = depth;
    W.vel[j * 3] = pvx;
    W.vel[j * 3 + 1] = pvy;
    W.vel[j * 3 + 2] = pvz;
    W.strip[j] = strip;
    W.fy[j] = fy;
    const half = strip >= 0 ? 2 * strip + (rx * this.latX + ry * this.latY + rz * this.latZ >= 0 ? 1 : 0) : -1;
    this.wHalf[j] = half;
    W.sigma[j] = 0.5 * Math.sqrt(A * Math.abs(nny));

    if (half >= 0) {
      const dMax = da > db ? (da > dc ? da : dc) : db > dc ? db : dc;
      const dMin = da < db ? (da < dc ? da : dc) : db < dc ? db : dc;
      if (dMax > this.sDepMax[strip]) this.sDepMax[strip] = dMax;
      if (dMin < this.sDepMin[strip]) this.sDepMin[strip] = dMin;
      this.sSx[half] -= nnx * A;
      this.sSy[half] -= nny * A;
      this.sSz[half] -= nnz * A;
      const lat = nnx * this.latX + nny * this.latY + nnz * this.latZ;
      if (lat > 0) this.sLatP[half] += lat * A;
      else this.sLatM[half] -= lat * A;
      this.hArea[half] += A;
      this.hHyd[half * 3] += fx;
      this.hHyd[half * 3 + 1] += fy;
      this.hHyd[half * 3 + 2] += fz;
      this.hCentroid[half * 3] += gx * A;
      this.hCentroid[half * 3 + 1] += gy * A;
      this.hCentroid[half * 3 + 2] += gz * A;
    }
  }

  private pushSegment(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    t0x: number,
    t0y: number,
    t0z: number,
    t1x: number,
    t1y: number,
    t1z: number,
    t2x: number,
    t2y: number,
    t2z: number,
  ): void {
    const S = this.waterline;
    const j = S.count++;
    S.a[j * 3] = ax;
    S.a[j * 3 + 1] = ay;
    S.a[j * 3 + 2] = az;
    S.b[j * 3] = bx;
    S.b[j * 3 + 1] = by;
    S.b[j * 3 + 2] = bz;
    const ux = t1x - t0x;
    const uy = t1y - t0y;
    const uz = t1z - t0z;
    const qx = t2x - t0x;
    const qy = t2y - t0y;
    const qz = t2z - t0z;
    const nx = uy * qz - uz * qy;
    const ny = uz * qx - ux * qz;
    const nz = ux * qy - uy * qx;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    const rx = 0.5 * (ax + bx) - this.cgx;
    const ry = 0.5 * (ay + by) - this.cgy;
    const rz = 0.5 * (az + bz) - this.cgz;
    const pvx = this.vx + (this.wy * rz - this.wz * ry);
    const pvy = this.vy + (this.wz * rx - this.wx * rz);
    const pvz = this.vz + (this.wx * ry - this.wy * rx);
    S.vn[j] = (pvx * nx + pvy * ny + pvz * nz) / nl;
  }
}

/**
 * Adaptive substep count (§2.6): N = clamp(ceil(B₃₃·dt/(m_eff·0.8)), 2, 4) with the
 * planing heave damping B₃₃ ≈ |U|·max m_a read from the LAST contact (sim state only, §V2).
 */
export function planingSubsteps(hw: HullWater, state: Readonly<Rigid6State>, dt: number): number {
  let maMax = 0;
  for (let i = 0; i < hw.sections.count; i++) if (hw.sections.ma[i] > maMax) maMax = hw.sections.ma[i];
  const v = state.velocity;
  const U = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  const mEff = hw.mesh.mass + hw.load.addedMass[1];
  const n = Math.ceil((U * maMax * dt) / (mEff * 0.8));
  return n < 2 ? 2 : n > 4 ? 4 : n;
}

/** burial-rate clamp (m/s) for the station view — the same bound as `hullContact.ts` MAX_CONTACT_RATE (a K-tick mirror recompute steps the surface) */
export const HULL_WATER_STATION_MAX_RATE = 20;

/**
 * PER-STATION VIEWS OF THE CONTACT for render-side consumers (§T.181 S0 hooks; additive, V77/V101). Two
 * stations per 2D+t strip — the chine at the strip centre, per half (index 2·strip + side, side 0 = −x),
 * exactly the points the contact itself reads (`chineV0/chineV1/chineT`, or ±chineHalfBeam at keelY when a
 * mesh has no chine lerp). Everything is read off the SAME height patch the contact clipped the hull
 * against this tick (`hw.patch`, the §V68 pressure head) at the pose rigid6 just wrote — no second sea
 * sampler (V101), and the patch's `outside` counter is left as the contact left it.
 *
 *  - BURIAL (flowfoam `HullBurialInput`, §T.70 churn): `depth[k]` = patch height − station world y (> 0
 *    under water) and `rate[k]` = its change per tick (> 0 burying), clamped to ±HULL_WATER_STATION_MAX_RATE,
 *    0 on the first update after construction or `reset()` (V108: call it on every teleport/respawn).
 *    `worldX/worldZ` the station plan positions; `sliceZ`/`sliceHalfWidth` the strip centres and chine
 *    half-beams (the outline the rim length is measured on). Same semantics as `HullContact.rate`.
 *    A station outside this tick's patch (the hull was placed since the build) has depth, rate and
 *    waterline NaN — no data, not the patch edge's value; `fitBurialPlane` and the wetline skip NaN.
 *  - WATERLINE (caustics `HullWetline.updateFromHullContact(dt, stations, waterlineY)`): `stations[k]` the
 *    body-frame (x, z) and `waterlineY[k]` the BODY-frame y at which the patch surface meets the hull's
 *    vertical line through that station — the ship-local height the sea reached. NaN when the hull's up axis
 *    is within ~84° of horizontal (no vertical line to intersect) or before the patch exists; the wetline
 *    skips NaN stations and dries them.
 * It is the PRESSURE waterline (the contact's own surface), not the drawn sea's: at the deep-V's 0.5 m Smith
 * depth the difference is the short-wave attenuation, a few cm.
 */
export class HullWaterStations {
  /** body-frame station positions, per half (x signed: − = side 0) */
  readonly stations: { x: number; y: number; z: number }[] = [];
  readonly worldX: Float64Array;
  readonly worldZ: Float64Array;
  readonly depth: Float64Array;
  readonly rate: Float64Array;
  readonly waterlineY: Float64Array;
  readonly sliceZ: Float64Array;
  readonly sliceHalfWidth: Float64Array;
  /** the contact wetted anything on its last evaluate */
  inContact = false;
  private readonly prevDepth: Float64Array;
  private hasPrev = false;

  constructor(mesh: HullWaterMesh) {
    const st = mesh.strips;
    const ns = st.count;
    const P = mesh.positions;
    for (let s = 0; s < ns; s++) {
      for (let side = 0; side < 2; side++) {
        const h = 2 * s + side;
        if (st.chineV0 && st.chineV1 && st.chineT) {
          const t = st.chineT[s];
          const a = st.chineV0[h] * 3;
          const b = st.chineV1[h] * 3;
          this.stations.push({
            x: P[a] * (1 - t) + P[b] * t,
            y: P[a + 1] * (1 - t) + P[b + 1] * t,
            z: P[a + 2] * (1 - t) + P[b + 2] * t,
          });
        } else {
          this.stations.push({ x: (side === 0 ? -1 : 1) * st.chineHalfBeam[s], y: st.keelY[s], z: st.zCentre[s] });
        }
      }
    }
    const n = 2 * ns;
    this.worldX = new Float64Array(n);
    this.worldZ = new Float64Array(n);
    this.depth = new Float64Array(n);
    this.rate = new Float64Array(n);
    this.waterlineY = new Float64Array(n).fill(Number.NaN);
    this.prevDepth = new Float64Array(n);
    this.sliceZ = Float64Array.from(st.zCentre.subarray(0, ns));
    this.sliceHalfWidth = Float64Array.from(st.chineHalfBeam.subarray(0, ns));
  }

  /** V108: forget the previous depths (the next update reports zero burial rate) */
  reset(): void {
    this.hasPrev = false;
  }

  /** once per tick, AFTER the rigid6 step that evaluated `hw` (the patch is this tick's) */
  update(hw: HullWater, state: Readonly<Rigid6State>, dt: number): void {
    const n = this.stations.length;
    this.inContact = hw.wettedArea > 0;
    const patch = hw.patch;
    if (patch.sampleCount === 0) {
      this.rate.fill(0);
      this.waterlineY.fill(Number.NaN);
      this.inContact = false;
      this.hasPrev = false;
      return;
    }
    const outside = patch.outside;
    const [qx, qy, qz, qw] = state.quaternion;
    const [px, py, pz] = state.position;
    // body +y's world y component: the vertical line's rise per unit body y
    const upY = 1 - 2 * (qx * qx + qz * qz);
    const rateOk = this.hasPrev && Number.isFinite(dt) && dt > 0;
    for (let k = 0; k < n; k++) {
      const b = this.stations[k];
      // world = p + q·b (the rotation WaterPatch.build uses)
      let tx = 2 * (qy * b.z - qz * b.y);
      let ty = 2 * (qz * b.x - qx * b.z);
      let tz = 2 * (qx * b.y - qy * b.x);
      const wx = px + b.x + qw * tx + (qy * tz - qz * ty);
      const wy = py + b.y + qw * ty + (qz * tx - qx * tz);
      const wz = pz + b.z + qw * tz + (qx * ty - qy * tx);
      const miss = patch.outside;
      let d = patch.heightAt(wx, wz) - wy;
      // a station off the patch has no water data this tick (a teleport since the build): NaN, not a clamped edge
      if (patch.outside !== miss) d = Number.NaN;
      this.worldX[k] = wx;
      this.worldZ[k] = wz;
      this.depth[k] = d;
      if (!Number.isFinite(d)) {
        this.rate[k] = Number.NaN;
        this.prevDepth[k] = d;
        this.waterlineY[k] = Number.NaN;
        continue;
      }
      if (rateOk && Number.isFinite(this.prevDepth[k])) {
        const r = (d - this.prevDepth[k]) / dt;
        this.rate[k] = r > HULL_WATER_STATION_MAX_RATE ? HULL_WATER_STATION_MAX_RATE : r < -HULL_WATER_STATION_MAX_RATE ? -HULL_WATER_STATION_MAX_RATE : r;
      } else {
        this.rate[k] = 0;
      }
      this.prevDepth[k] = d;
      // waterline: y on the body-vertical line through (x, z) where world y meets the patch surface;
      // fixed-point on the height (the line leans with the hull, so XZ moves as y does)
      if (!(upY > 0.1)) {
        this.waterlineY[k] = Number.NaN;
        continue;
      }
      let y = b.y;
      for (let it = 0; it < 3; it++) {
        tx = 2 * (qy * b.z - qz * y);
        ty = 2 * (qz * b.x - qx * b.z);
        tz = 2 * (qx * y - qy * b.x);
        const lx = px + b.x + qw * tx + (qy * tz - qz * ty);
        const ly = py + y + qw * ty + (qz * tx - qx * tz);
        const lz = pz + b.z + qw * tz + (qx * ty - qy * tx);
        y += (patch.heightAt(lx, lz) - ly) / upY;
      }
      this.waterlineY[k] = y;
    }
    patch.outside = outside;
    this.hasPrev = true;
  }
}
