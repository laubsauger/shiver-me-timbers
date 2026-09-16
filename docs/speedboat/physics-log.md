# Speedboat physics core — handoff log (T165 → T179)

Status at 7af5108: `rigid6` integrator + hull↔water contact + procedural hull, pure TS, not wired into any mode.
Tests: `tests/rigid6.test.ts` (15), `tests/hullWater.test.ts` (31). Design: `docs/speedboat/tech-research.md`.

## Files
- `src/sea-physics/rigidBody.ts` — `stepRigid6` (only integrator of the 13 channels), `Rigid6Load`, `Rigid6Memory`
  (previous added mass + per-boat scratch `workspace`), `gyroMidpoint`, `rigid6KineticEnergy/AngularMomentum`.
- `src/sea-physics/hullWater.ts` — `WaterPatch` (height grid), `HullWater.samplePatch/evaluate/forceFn/resetMemory`,
  `planingSubsteps`, `HULL_WATER_DEFAULTS`. Outputs: `wet`, `waterline`, `sections`, `wake`, `load`, `frictionForce/Torque`.
- `src/speedboat/hullMesh.ts` — `buildDeepVHull`, `hullStations`, `halfBeamAt/keelRiseAt/deadriseAt/keelLength/deckHeight`,
  `deriveMassProperties`, `HULL_DATA`, `REFERENCE_DEEP_V`. Reads `src/speedboat/deepV12.hull.json` (single source,
  also read by the Blender render-hull script; stations table is pinned equal to the generator by a test).

## Frames and conventions
- Hull frame: x across (±), y up from keel baseline, z forward from transom (z=0). Body frame = hull frame − CG.
  rigid6 position = CG. Quaternion [x,y,z,w]. velocity/angularVelocity WORLD. Pitch about body x: bow-UP is
  NEGATIVE ω_x / negative rotation about +x. Roll about body z, yaw about body y. Inertia vector = [pitch, yaw, roll].
- Trim in tests = asin(fwd·Ŷ) = asin(2(q_y q_z − q_w q_x)). Roll = asin(2(q_x q_y + q_w q_z)).
- Half-section index = 2·strip + side (side 0: body x < 0, 1: x ≥ 0), strip 0 = transom.
- Strip normal N̂ points INTO the hull; V_n = −N̂·v_point > 0 means penetrating.
- Gravity is added inside stepRigid6 (force m·g), divided by m + A like every other force.
- Height sampler: caller binds `ocean.pressureHeadAt(x,z,t)` for forces (Smith, V68). Patch spacing 0.8 m, all boats.

## Force terms (all in `HullWater.evaluate`, rigid6 only integrates)
| term | law | where |
|---|---|---|
| hydrostatic | −ρg·d_c·A·n̂·C_T per wet tri; torque at exact centre of pressure (A/12 formula) | `emit` |
| clip | Kerner 0/1/2/3-vertex cases on patch depths | `evaluate` clip loop |
| skin friction | ½ρ(C_f,ITTC57 + ΔC_F 0.0004)·A·(c_W/c_g)·|v_t|v_t, Rn on λb = A_plan/B; `frictionTorque` exposed | friction pass |
| section geometry | N̂ = normalised Σ(−n̂A) ⊥ body z (both halves); c_g = |Σ|/(2Δz); c = min(π/2·c_g, b_chine); m_a,sec = kρ(π/2)c²; half share = c_g,half²/Σc_g² (uncapped, projected on N̂) | half-section block |
| slam/shed | V_n·Δm_a per half: growth → inelastic GS impulse ΔA·V_n/(1+ΔA·w); shrink with V_n>0 → ΔA·V_n; V_n≤0 → nothing | GS loop, `gsInvMass/gsApply` |
| crossflow | ½ρC_Dc·2c·share·V_n|V_n| along N̂; lateral ½ρC_Dc·A_side·V|V| along body x; linearised-implicit impulses | `gsDrag` |
| rotating-frame added mass | m_a,half·Δz·N_b·(ω_b×v_b) along N̂ | "ROTATING-FRAME" block, `addHalfForce` |
| planing lift | |u|·(M_i − M_up), M = m_a·V_n per half, placed at boundaries (upwind share ramps with area), trailing extrapolation, clamp ≥0; Garme C_T on the STEADY part only (V_n of horizontal CG motion) | lift block |
| added mass (to rigid6) | diagonal: A_x,y = Σ a·N_b²; ΔI = Σ a·(r_b×N_b)² + roll plate a·c²/8; surge 0.05·m·displaced fraction | added-mass loop |
| V110 cap | one scale on force, torque and samples | cap block |
| wake samples | per-plan-cell sums of signed wet fy, ≥0, Σ = max(0, F_y) (`wake`) | `buildWakeLoad` |
Integrator divides by min(A_old, A_new) per axis (`keepOf`); growth exchange is the contact's slam impulse (same inverse mass).

## Calibration constants and sources
- Garme near-transom reduction C_T = tanh(2.5·x_T/(a_non·B·Fn_B)), a_non = 0.34. Formula NOT verified against the
  primary (Garme, Int. Shipbuild. Prog. 52(3) 2005, paywalled); taken from Niazmand Bilandi et al., JMSE 2018 6:136 eq.22.
- ITTC-57 friction + ΔC_F 0.0004 (Savitsky 1964 procedure). k(β) = 1 (Wagner). C_Dc = 1 (Zarnick). Surge A 0.05·m (doc §1.3).
- Hull (JSON): LOA 12, chine beam 2.30, deadrise 24° aft of 7.2 m warping t² to 45° at forefoot (Sport Fishing Mag
  "Perfect Boat Hull Designs": Regulator 24°→48–49°; Ray Hunt Design Q&A), stem rake 0.35, triple Mercury Racing 450R
  (689 lb, Boating Mag), 30" setback bracket (Bloodydecks/Viking), prop point 1.06 m aft (mount + assumed 0.30 gearcase).
  Mass 5351 kg / LCG 3.636 / VCG 0.845 / gyradii derived from `massItems` (structure numbers ASSUMED).
- Savitsky oracle (test): prismatic variant taper/keelRise/warp at 0.85/0.88/0.88; valid range = chines wet, τ≥2°,
  λ≤4 → C_v 3.1–6.0. Measured trim −0.47…−0.86°, R −6…−11%. Equilibrium harness holds speed, damps rates,
  removes friction moment (Savitsky's forces through CG).

## Root causes found (each pinned by a test; mutation-checked)
1. Mirrored winding splits clipped quads differently → centroid torque made symmetric hull yaw at rest (−70 N·m).
   Fix: exact CoP torque. Test: "mirror-symmetric hull at rest makes no yaw or roll torque".
2. Explicit crossflow drag stiff: 25 m/s flat entry bounced to +20 m/s at N=1. Fix: GS velocity-level impulses on
   post-slam velocity. Test: "slam and crossflow drag do not throw a hard landing back up".
3. Doc's Catto one-step implicit-Euler gyro: −18% |L|, −34% E in 10 s at 1 rev/s. Fix: implicit midpoint + energy
   clamp. Tests: "does not brake a fast tumble", "flips about the intermediate axis".
4. Drop-test flake: tick-sampled velocity window aliasing (1.8–2.3% vs 2% gate). Fix: substep-resolved force window,
   first-order check. Test: "drop from 3.6 m: 50 ms peak decel converges first-order".
5. Pitch cycle A (3.4° p2p, C_v≤3.7): V_n·dm_a/dt entry-only halved U·sinτ·∂m_a/∂z damping; Garme applied to rate
   terms. Fix: shed momentum; Garme on steady load only. Test: "free-running … settles … at 14, 28 and 56 strips".
6. Pitch cycle B (C_v 3.5–3.9, 0.39°→0.87° with 14→56 strips): missing rotating-frame added-mass load. Sign flip →
   1.7–3.0° cycles. Same test.
7. Roll: strip mean cancels roll-rate V_n across keel (K_p −0.3 kN·m·s); Garme cut aft roll stiffness to +2.5 kN·m/rad
   at C_v 10 → ±27–31° at C_v 8, capsize 9–10. Fix: half-sections with c_g² shares (K_p −5…−7, K_φ −31…−59).
   Test: "roll: a 10° heel kick decays, no loll, no capsize".
8. World-frame fluid memory (Kirchhoff R·A·Rᵀ·v) double-counted cause 6 and masked it; removed. Test: "rotation alone
   moves no momentum between body axes".
9. Wake clamp over-counted when downward faces wet (inverted/buried, +4%). Fix: `wake` column sums. Test:
   "wake load samples are ≥ 0 and integrate to the net vertical contact load".
10. Patch missed the setback prop point. Fix: prop point in patch extent. Test: "patch covers the hull … 45 m/s".

## Tried and rejected (lateral / yaw / foil / coupling) — scratch, not in repo
Harness: reference hull, 10° or 0.6° initial roll, speed held by surge force, calm water, 40 s, N=2, at the model state
BEFORE fixes 6–8 unless noted (world memory, strip-mean sections, rotating-frame term present).
- Lateral 2D+t side force: m_lat = kρ(π/2)d_lat² (d_lat = one side projected depth), f = −|u|(M_i−M_up) along body x
  + rotating-frame m_lat·(ω×v)_x, added to A_x / yaw / roll inertia. Roll amp: C_v6 17.8°, C_v8 22.9°, C_v10 24.5°
  (without it C_v6 1.1°). Without the rotating term: 25.8° / 88° (capsize) / 88°. Flux off, rotating term on:
  11.4° / 19.7° / 23.9°. Reading: the slender-body side-force Munk yaw moment is directionally destabilising with
  no fin; do not add lateral flux without an aft lateral appendage.
- Drive-leg foil at prop point, F = −½ρ·A·C_Lα·|u|·v_lat, A 0.45 m², C_Lα 2.1: roll 88.5° / 87.4° / 23.1° at
  C_v 6/8/10 (capsize); with lateral 2D+t: 89.9° / 86.4° / 1.6°. Likely because the force acts 0.9 m below CG and
  1.06 m aft of transom (roll–sway coupling), not because the foil is wrong in principle — re-test on the current
  model (half-sections now supply roll damping).
- Diagnostic dampers (not physics): sway 80 kN·s/m at CG → roll 1.4/2.1/14°; yaw 200 kN·m·s → 1.5/3.3/17°;
  roll 40 kN·m·s → ≤0.26° everywhere. The mode was sway–yaw–roll coupled.
- Linearised lateral analysis (scratch `latlin`): include gravity's body-x projection (−mg·φ) or Y_φ is wrong.
  Final model at C_v 3.7/5/8: K_φ −14/−31/−59 kN·m/rad, Y_φ ≈ −43…−49 kN/rad, eigen real parts ≤ +0.05.
- Section force along body y instead of area normal: removes loll but Y_φ −43 kN/rad (no lateral hydro to balance
  gravity when heeled) → roll 14–38° at C_v 3.1–4.3. Rejected.
- Full 6×6 coupled added mass (Σ a·J·Jᵀ, J = [N_b; r_b×N_b], per-strip keep, GS with (M+A)⁻¹): unstable at every C_v
  (pitch 2.5–5.7° at C_v 2.5–6) — but tested only with world-frame memory absent and WITHOUT the rotating-frame term.
  Unit A/B vs diagonal (no rotation) showed no sign bug. A₃₅/√(A₃₃A₅₅) ≈ 0.36 of total mass matrix at C_v 3.1
  (added-mass centroid 1.3 m aft of CG). Re-test with fixes 6–8; the coupled form of the rotating-frame load is
  A_full·[ω×v_b; 0] (already what the per-half force gives).

## Resting drift 0.45 m / 30 s (planing on; 2.5 m with planing off)
Scenario: reference hull released level at CG y 0.5 (not equilibrium; LCG ≠ LCB so it pitches), flat water.
Suspected: anisotropic diagonal added mass divided per body axis while pitched — the vertical net force (buoyancy −
weight, oscillating) resolves into body y (÷(m+A_y)) and body z (÷(m+A_z≈0.05m)), giving a horizontal acceleration
correlated with pitch angle; with weak pitch damping at rest this rectifies to drift. Evidence: drift is LARGER with
planing off (A_y≈0 but A_z>0 and no damping), smaller with 2D+t damping. Candidates: surge added mass ramp
(0.05·m·displaced fraction), keep = min(A_old,A_new) asymmetry, missing Kirchhoff/Munk terms for the diagonal A.
Check first: set surgeAddedMassRatio 0 and measure.

## Pitfalls
- Energy-per-DOF attribution: subtract means (steady U·sinτ contaminates body-y work); dissipative point forces
  can show positive work in one DOF.
- Many "fixes" trade one mode for another (area normal vs body axis; share laws). Always sweep C_v 2.5–10 in pitch
  AND roll with a kick, and refine strips (28/56/112 segments) — a model instability grows with refinement.
- Savitsky is invalid above C_v ≈ 6 for this hull (dry chines, τ<2°). Don't fit there.
- `planingSubsteps` returns 2 at all physical speeds (B₃₃/m_eff ≤ U/L_wet).
- Per-substep state: `evaluate` must be called exactly once per substep (prevMa, prevAdded); `resetMemory` and
  `resetRigid6Memory` on teleport.
- `it.fails` blocks must fail for the stated reason — flip to `it` temporarily and read the message.
- Timing numbers vary ~2× with machine load from parallel agents; measure several times.
- Other agents edit concurrently; full-suite failures outside these two test files were not ours.

---

# T179 (S1b) — lateral/yaw hydrodynamics, drives, resting drift, 6×6 (handoff)

Tests: `tests/hullWaterManeuver.test.ts` (15, one `it.fails` = known limit), `tests/rigid6.test.ts` +3 coupled.
Scratch harnesses (not in repo): `scratchpad/t179/{turn,drift3,deriv,straight,perf}.test.ts`, run with
`scratchpad/t179/run.sh <name>` (vitest config pointing at the repo).

## Resting drift — two root causes (both pinned)
1. **Transom face × Garme.** `transomFactor` gave tanh(k·x_T) to EVERY wet triangle; the transom face sits at
   x_T = 0 (rounded ±4e-16) and k = 2.5/(a·B·Fn_B) is finite for any surge ≠ 0, so the face's hydrostatic
   push was 0 or 1 by the sign of a 1e-7 m/s surge: a one-way brake. At the settled rest pose, released: 12.7 cm
   in 60 s. Fix `faceFactor`: non-running-surface faces take no sectional Garme reduction; the TRAILING face is
   wet at rest and dries by transom-draft Froude number (ramp Fn_T 1.1 → 2.2; dry values 2.2 full scale,
   2.4–2.5 model — Maki et al. 2006 / "On transom clearance" 2015 via search summaries, primaries not read;
   the 1.1 start is ASSUMED). Now 0.8 mm / 60 s. Test "stays put < 1 cm in 60 s" (mutation: old face law ⇒ 14.8 cm).
2. **Missing Kirchhoff −ω×(A·v).** Masked by (1). rigid6 divides by body-axis added mass; a rotating hull then
   does not conserve body + water momentum. Released 20 cm high with (1) fixed: 0.31 m/s steady FORWARD walk
   (17 m / 60 s). Adding the force −ω×p (p = A·v; point velocities in the 6×6) → 2.2 cm/s residual, which is
   the entry-only slam/crossflow impulse along the trimmed normal (bounded by tanθ·√(2gΔy), tested with the
   mutation kirchhoff:false breaking the bound). NOT the angular part −ω×p_ang − v×p_lin: v×p is the Munk moment
   the lift flux already carries; adding −ω×p_ang capsized the C_v 8 roll kick (88°). Surge added mass (the log's
   suspect) was NOT it: zeroing it changed 0.45 → 0.48 m. Mock in rigid6 test: with A(ω×v) − ω×(A·v) the world
   momentum is conserved (<1%), without it not.

## 6×6 coupled added mass — KEPT (default `coupledAddedMass`)
A6 = Σ keep·J·Jᵀ, J = [N̂_b; r_b×N̂_b] per heave half + [L̂_b; r_b×L̂_b] per sway strip + roll plate + surge;
keep = min(a_old, a_new) per section; rigid6 `addedMass6`/`coupled` → Cholesky solve, gyro on rigid I; GS
impulses use (M+K6)⁻¹. Provider adds A6·[0; I⁻¹(ω×Iω)]. Re-tested: all 46 T165 tests pass (Savitsky, pitch
settling 14/28/56 strips, roll decay, drop, flips); T165's instability was the missing rotating-frame term. Why
kept: it is what makes the sway loads at the strip centroid consistent (sway–roll/sway–yaw lever arms): the
diagonal step + centroid loads heeled her out (−5° C_v 5 half lock) and capsized at C_v 8 half lock (2 s helm
ramp); coupled survives C_v 3–5 at 1/3 lock with inward heel. Horizontal speed left by a 0.1 m/s heave +
0.02 rad/s pitch kick at rest: 4.9 mm/s coupled vs 15–24 mm/s diagonal + Kirchhoff.

## Lateral model (sources)
- **Sway added mass** m_lat = k_lat·ρ(π/2)·d², d = wetted depth of the strip (lowest wet vertex to the
  waterline, so a wet chine/heel adds depth). Ellipse law with semi-axes swapped (heave m_a = ρ(π/2)c²);
  Newman 1977 §4.13, Faltinsen 2005 ch. 9 (2D+t). Upright wedge: m_lat/m_a = tan²β·(2/π)² (tested).
- **Loads** along L̂ = N̂×ẑ_b: rotating-frame m_lat·L·(ω×v), inelastic entry on growth, Kirchhoff (at the strip
  centroid); **momentum flux** −|u|·Δ(m_lat·V_L) with the lift's upwind/Kutta scheme (not clamped) and the
  existing lateral crossflow drag, both as **pressure normal to the bottom panels** (`addLateralStripForce`):
  side force on a drifting planing hull comes from the leading spray-root pressure (Marleaux, Simonis &
  Abdel-Maksoud 2024, 35th SNH, readable PDF; compares with Brown & Klosinski 1994). Measured alternatives:
  flux at the centroid ⇒ heel OUT (−2…−5° C_v 3–5, −12…−17° C_v 8–10); all lateral loads via panels ⇒ 22–32°
  inward at C_v 3 (waterjet trial ≈ 5°) and a growing roll–trim oscillation at C_v 5 half lock, unchanged at
  N = 8 (model, not numerics). The kept split still shows that oscillation at C_v 5 half lock (table).
- **Yaw damping**: emergent (point velocities in the lateral strips + gearcase foils). Linear derivatives at C_v 5
  (scratch `deriv`): hull N_r −71, drive N_r −371 kN·m·s; hull N_v +1.7 (Munk, destabilising), drive +82;
  sway–yaw stability C > 0 at C_v 3–10.
- Morabito 2015 (oblique impact side force), Lewandowski 2004 book, Plante et al. 1998, Denny & Hubble 1991 primary:
  paywalled/not read; Denny & Hubble and Lewandowski used through Aslan, NPS thesis 2015 (read).

## Drives (sources)
- JSON `lowerUnit` (added, ASSUMED geometry): AV plate at keel level, span 0.60 m, lateral area 0.22 m²
  (A = 1.64), CE 0.29 m below the plate and 0.12 m aft of the pivot, stall 22°, C_D0 0.02, lock 30°.
  Mercury: 5.44 in HD torpedo only published number. `HullProxy.drives` from `engines` + `lowerUnit`.
- Lift slope Helmbold 2πA/(2+√(A²+4)) (→ Jones πA/2), geometric A of the immersed span (free surface = φ=0, no
  end-plate doubling; Liu & Hekkenberg 2017 review: k_Λ→2 only on a solid plate). Stall 15–20° open-water
  rudders (same review); post-stall flat-plate C_N ≈ 1.2 sin α.
- **Ventilation**: C_L,i = [1−exp(−σ_v·Fr_h)]·Fr_h^−½ (Damley-Strnad et al. 2019 as quoted/tested in Aguiar
  Ferreira et al., arXiv:2503.18015, 2025, read); beyond it lift blends over 4° to ¼ of the wetted slope (Tulin
  supercavitating plate). Inception α at 45 m/s ≈ 4.6°. No hysteresis; AV plate not credited.
- Immersion: span = clamp(span + AV-plate depth, 0, span) → area and A shrink together; out of water ⇒ 0.
- Thrust TEMPORARY: T = throttle·η·P/max(U_a, 12 m/s)·s^1.5 per engine at the yawed prop point, P 335.7 kW,
  η 0.55. Tests raise `standInDrivePowerW` to 4 MW to hold C_v 8–10 on the non-stepped proxy.

## Turning (30°/s helm, throttle frozen, 30 s, last 8 s mean; heel + = INTO the turn)
| C_v | 1/3 lock (10°): D/L, U/U_a, heel, max drift | 1/2 lock | full lock |
|---|---|---|---|
| 3 | 12.3, 0.83, +14.9°, 7° | 5.6, 0.57, +18.7° | 2.1, 0.35, +18.6° (70° transient) |
| 5 | 21.7, 0.90, +6.1°, 9° | 5.6, 0.58, 35±20° oscillating | capsize |
| 8 | 30.9, 0.91, −1.5°, 10° | capsize (with a 2 s ramp: 17 L, +4.8°) | capsize |
| 10 | 44.4, 0.93, −13.4°, 9° | capsize | capsize |
Literature: full-scale planing craft 8–15 L semi-planing, up to 40 L planing (Sadati et al. 2022 abstract);
Denny & Hubble trials 10–20 L; radius grows with speed (both via Aslan 2015). Lewandowski's regression
(STD/L = 1.7 + 0.0222·F∇·(L/∇^⅓)^2.85·30/δ, rudder craft, F∇ < 4) gives 35 L at 10° / 13 L at 30° at C_v 3 —
ours is 3–6× tighter (vectored thrust + three gearcases vs a rudder). "A few boat lengths" (task text) is not
planing-craft data. Speed loss vs Denny & Hubble U_c/U_a = 1/√(1+K_c(L/R)²), K_c = F∇²·30/δ at C_v 3: within
0.15 at 10°/15°/30° (tested; weak discriminator: k_lat 0 still passes, crossflow ×10 fails). Waterjet planing
boat trials (Ocean Eng. 2017 abstract, 15° nozzle at 15 kn): heel ≈ 5°, yaw 10.5°/s — ours at C_v 1.6/15°:
heel ≈ 10°, yaw 10.6°/s.
Straight, helm centred, 60 s: heading wander ≤ 0.05° C_v 3–10 (driveFoil off: 0.63° ⇒ the gearcases are the
directional stability). Chine walk: not emergent in calm straight running (roll range 0.000° over 60 s C_v 3–10);
roll kick decays (T165 test, still passing with drives). Substep N 2→4: D/L and U change < 2% (C_v 5, 10°).

## Open / deviations
- **Acceptance NOT met**: no capsize/spin-out at 50%/100% steer for C_v ≥ 5 (and 50% at C_v 8–10 with a fast
  helm). Physics, not a bug as far as measured: ~15 kN/deg per gearcase at 24 m/s. Needs the S2 speed-limited
  lock (doc §3.2) or a steering-actuator hinge-moment limit. Pinned by `it.fails`.
- Heel is OUT of the turn at C_v ≥ 8 with small helm (−1.5° C_v 8, −13° C_v 10): dry chines put the panel
  pressure line below the CG. Missing candidates: spray reattachment on the side walls (Marleaux: raises roll
  restoring), pressure centred at the spray root rather than the half centroid.
- Released-hull residual 2.2 cm/s (entry-only slam along the trimmed normal; no radiation damping at rest).
- Perf (µs per boat per tick, N=2, analytic sea, quiet machine): 7af5108 62 → diagonal+T179 81 → coupled 96.
  Under parallel-agent load all three double. Cost: 6×6 factor per substep, (M+K6)⁻¹·J per GS impulse.
- API (sim-worker): `HullWater.setControls(steer rad at the drives, throttle −0.3…1)`; `evaluate` now ADDS the
  drive load (thrust + gearcase foils, `driveForce/driveTorque`) and a coupled `addedMass6` to `out`; `load`
  stays the hull contact (V-W2). Drives act even at throttle 0 (foils). stepCore's `applyStandInDrive` would
  now double the thrust if kept alongside setControls — replace it with `hw.setControls(steer·maxSteer, throttle)`.
  New params: `lateralAddedMassCoeff`, `standInDrivePowerW`, `coupledAddedMass`, `kirchhoff`, `driveFoil`,
  `gearcaseVentilation`. `Rigid6Load.addedMass6?/coupled?` (optional; createRigid6Load allocates them).
  `HullWaterMesh.drives?`, `HullProxy.drives`, `driveUnits()`, JSON `lowerUnit` (added fields only).

---

# T179 round 2 — heel out of turn, hard-steer hooks, outboard height, roll arch

Scratch tools: `scratchpad/t179/jac.test.ts` + `eig.py` (finite-difference Jacobian of the one-tick map about a
damped steady turn, eigenmodes via numpy venv), `kphi.test.ts`, `kpdrift.test.ts`, `plate.py` (Wagner plate
centres of pressure), `turn.test.ts` (ROLL=1 prints the per-term roll/side-force breakdown).

## Root causes (each pinned by a test, mutation-checked)
1. **Sectional loads at the geometric centroid.** Half-way from keel to waterline halves the steady-lift lever:
   dynamic K_φ 0.27·mgB/rad at C_v 8 (Brown & Klosinski via Marleaux Fig. 12: ~0.57). Wagner plate centres
   (`placeCentresOfPressure`): steady lift 2c_W/π, sway pressure πc_W/4 (numerically confirmed for a sign-type
   antisymmetric velocity), rate terms c_W/(2√2) (reproduces the plate roll added inertia m_a·c_W²/8; putting them
   at 2c_W/π overstated roll damping ≈3×). K_φ now 102/140/115/98 kN·m/rad at C_v 3/5/8/10 (static 45).
   Test "dynamic roll stiffness ≥ ½·mgB/rad" (mutation wagnerCentreOfPressure:false fails).
2. **Heel out at C_v ≥ 8 was the side-force line below the CG**: through the centroid the panel-normal lines
   meet c/sin2β above the keel < VCG once the chines dry. Through the spray-root centres she heels IN at every
   speed (10° drive: +16/+9.8/+9.0/+9.8° at C_v 3/5/8/10). Gearcases and thrust vector also roll her IN (below
   CG, stern pushed out) — they were never the outward cause. Literature: inward heel growing with turn speed
   (waterjet planing boat free-running tests, Ocean Eng. 2017 abstract); no documented outward heel found.
3. **Sway velocity not on the force's Jacobian** (velocity at strip centroid, force along panel lines): roll rate
   made negative work; linearised C_v 8 turn had a 1.7 Hz roll–sway–heave mode at +1.8/s. One generalized
   coordinate per strip (`lateralJacobian`: same f, m for velocity, added mass, GS, force). Heeled-drift K_p
   now −15/−9/−10/−5 kN·m·s/rad (mutation: −0.1 at C_v 3). Test "roll damping survives a heeled drift".
4. **Crossflow drag at the spray-root centres**: its heave/heel-dependent projected area drove the same mode
   (+2/s at C_v 10 half lock); separated-crossflow pressure is spread over the leading panel → own Jacobian at
   the geometric centroid (−1/s). Mutation fails the half-lock and heel tests.
Rejected: transom hollow lowering the drives (the practitioner source says a bracketed prop runs in a HUMP behind
the hull; TwoMorrow/Boat Builder Central 2016); Wagner splash on m_lat ((π/2)d: 40–55° heel); gearcase immersion
(+0.2 m plate: no change); ventilation off (no change) — the gearcase in a steady turn runs at α ≈ 0.1–1°.

## Hard steer (30°/s helm, lock 30°, half lock = 15°)
- 10°: steady C_v 3–10, D/L 15/25/33/42, U 0.85–0.91. Half lock: steady C_v 4–6 (heel 17–21°); C_v 3 settles
  (25°) after a 49° transient; C_v ≥ 7 hooks 1.4–2.8 s in. Full lock: C_v 3 settles at 25° after a 61° transient;
  C_v ≥ 5 hooks 1.15–1.7 s after the helm starts (the helm takes 1 s to reach lock).
- Mechanism (trace + Jacobian): the damped C_v 8 half-lock turn (heel 12°) is linearly STABLE; the gearcases'
  entry side force below the CG kicks the heel past ~22° before the stern slides, the inner panel of the 24° V
  goes flat, sway added mass swings 3000 → 150 kg per heave cycle, a ~1 Hz heave–roll limit cycle ends in a hook.
  A +15 kN·m·s/rad roll damper removes it: that is the size of the gap. Not in the proxy and plausible sources of
  it: spray strakes / chine flats (renderOnly), side-wall spray reattachment (Marleaux 2024). OPEN, pinned by
  `it.fails` (half lock C_v ≥ 7; >45° transient at C_v 3).
- Gearcase check: 2.5 kN/deg per gearcase at 24 m/s (not "15" — earlier arithmetic slip), capped by ventilation.

## Outboard height and roll arch (JSON)
- AV plate +0.10 m above the keel line (planing: flush to +½ in; bracketed: ~+2 in, "prop runs in a hump behind the
  hull" — TwoMorrow Holdings/Boat Builder Central 2016; forum setback rules +1 in per 4–10 in ⇒ +3…7.5 in at 30 in),
  prop shaft 0.22 m below the plate ⇒ prop point −0.12 m (was −0.35), disc spanning the keel line (Sport Master is a
  surface-piercing gearcase). Prop 0.55 m aft of the mount (was 0.30; ASSUMED from the cowl proportions). 450R
  shafts 20/25/30 in (Boating Mag review): 30 in used. Lower unit: span 0.50, area 0.19 m² (A 1.3), CE 0.21 m below
  the plate, 0.35 m aft of the mount.
- Engine mass items y 1.10, z −0.95 (V8 block over the midsection); roll arch z 4.8 → 3.2 (0.64 m aft of the seat).
  Derived: LCG 3.6060, VCG 0.8540, gyradii pitch 0.2599·L (band ≤ 0.26 binds; engine z −1.10 gave 0.2632), yaw 0.2593,
  roll 0.3774. All T165 tests pass on the new mass budget.
- Asset build (`node scripts/asset-build.mjs`) exit 0, checker OK. Anchors: prop body y −0.974, deck y 0.82 ⇒
  clamp top (plate + 30 in) at body y 0.008, cowl top (outboard.py Y0 + H = +0.78) at ≈ 0.79 ⇒ **cowl top ≈ 0.03 m
  BELOW the deck** (was 0.26 below). STYLE-SPEC's +0.60 m would need the plate ~0.6 m above the keel (dry at speed)
  or a taller cowl than the parts model; not reachable with a real 30 in shaft on this 1.67 m transom.
- Immersion change vs steering: grid essentially unchanged at 10° and half lock C_v ≤ 6 (heel within 1–2°).

## Perf, API
- µs per boat per tick (N=2, analytic sea, quiet): 7af5108 40 → now 63.
- sim-worker `stepCore.ts`: stand-in drive removed; controls → `hw.setControls(steer·lock, throttle)`. Worker
  determinism suite green.
- New param `wagnerCentreOfPressure`. `Rigid6Load`, `HullWater` public API otherwise unchanged since round 1.

---

# T179 part 3 — strakes/chine flats (literature), chine-wet added mass, 1.30 m hull, per-drive results

Scratch (not in repo): `scratchpad/t179s/{env,gz,perf,sweep,sav,pw}.test.ts`, `jsonfix.ts` (writes the JSON),
`lit/` (downloaded sources), `run.sh <name>`.

## Strakes and chine flats: NOT modelled, because the sources give them nothing to model
Hypothesis handed over: strakes/chine flats supply the ~15 kN·m·s/rad of roll damping whose absence lets the
gearcase entry kick hook her. Checked against (access in brackets):
- Clement, DTMB Report 1818, 1964 [full text]: spray strips change resistance −1…−6 % (only forward of the
  high-speed stagnation line), and "no significant lift component resulted from the deflection of the thin sheet
  of whisker spray"; rise and trim "nearly the same". Results stated NOT to apply to deadrise ≥ 20° (ours 24°).
- Savitsky, DeLorme & Datla 2007 [abstract + formulas quoted by Olin et al. 2017]: strakes act on WHISKER spray
  drag (up to 15 % of drag). This model has no whisker-spray drag term (friction is on Savitsky's pressure area), so
  intercepting it removes nothing. Savitsky & Morabito 2011 [abstract + USNA EN486 notes]: spray root = π/2 wave
  rise (our Wagner c); nothing on strakes.
- Brown & Klosinski CG-D-04-95 [full text], prismatic 30°/20°/10° models WITH chine spray strips: roll damping
  c = w·b⁴√(b/g)(1 − sinβ)[0.134 sin|ψ| + 0.0290 C_v + 0.0199 λ/b] (±20 %, C_v 1.5–4), added roll inertia
  I_h = 0.010237 ρ b⁵ (λ/b)(1 − sinβ). On this hull (C_Δ 0.43 vs their 0.4375, L/B 5.2 vs 5):
  | C_v | 1.5 | 2 | 3 | 4 | 5 | 8 | 10 |
  |---|---|---|---|---|---|---|---|
  | model K_p upright, kN·m·s/rad | 16.5 | 21.1 | 25.6 | 22.5 | 21.7 | 13.9 | 10.5 |
  | B&K c (λ from model) | 9.2 | 9.5 | 11.0 | 13.2 | 15.4* | 21.8* | 26.2* |
  (* extrapolated past C_v 4). Inside their data the model is ABOVE B&K; the model only falls below it past C_v 6,
  where no data exist. Scratch: +½·B&K on top cures half lock at every C_v (heel peak ≤ 20°); full B&K on top makes
  full lock hook 2.1–2.5 s in. NOT adopted: double-counts where data exist, extrapolates where they don't.
- A 6 cm strake flat as its own 2D+t plate: m_a = ρ(π/2)(w/2)² = 1.45 kg/m; leading-edge roll damping
  U·Σm_a·x² ≈ 0.3 kN·m·s/rad at C_v 8 (both sides, 3 strakes + chine flat). Jet deflection (Wagner jet momentum
  (π/2)ρV²c, turned 24°): ≈ 0.6 kN·m·s/rad — and its jet-thickness formula is unverified (Faltinsen 2005 not accessed).
- Lewandowski 1997 / Katayama 2006: spray on the side wall raises roll restoring (Lewandowski via Marleaux 2024,
  heel ±10° only); Katayama [full text]: the centre-shift restoring term VANISHES once a chine is wet, and sections
  with one chine wet and the other dry give strongly negative restoring. No source quantifies strakes or chine
  flats in roll (searched; boating press only).
Measured here (dynamic righting M and K_p at fixed heel, heave/trim free, speed held; `gz`): K_p collapses with heel
(C_v 3: −25 / −18 / −6 / −2 kN·m·s/rad at 0/10/20/30°), M peaks ~20° (0.13–0.16 mgB) and falls; the lift line
of the flat low panel passes near the CG past ~25°. Consistent with Katayama's chine-wet loss of restoring.

## Chine-wet added mass under the LOW chine (kept, `chineWetAddedMass`)
Payne 1994 (Ocean Eng. 21(3), as reproduced by Katayama et al. 2006): after chine wetting m′ grows with
C_wet = (1 + 2z_c/b_x)·C_dry ⇒ c² = b² + b·z_c, z_c = d_chine + b(1 − 2/π)tanβ. Full symmetric growth moved
Savitsky trim at C_v 3.1 to −1.21° (fails the 1° gate) ⇒ only the DIFFERENCE between the two chines is added, to
the deeper one (upright load bit-identical: tested). Mesh: `HullStrips.chineV0/V1/T` (chine vertices per half).
Effect: C_v 3 half lock no longer passes 45° on the 1.674 m hull (44.8°→24°); on the 1.30 m hull it is what keeps
C_v 6 half lock steady (off: ±7.9° roll oscillation about 27°). Static K_p/M barely move (≤ 1 kN·m·s/rad): it
acts in the entry transient. Deviation from Payne: symmetric part omitted (above).

## Hull depth 1.674 → 1.30 m, pointed bow (JSON, coordinator request)
- Depth keel→sheer at the transom 1.30 m, freeboard 0.788 m. Source: Apache 42 Renegade 3-view (REFERENCES a1),
  measured: keel→rub rail 1.25–1.34 m near the transom, keel→deck edge 1.50 m; APBA 2026 Super Vee ≥ 48 in
  (1.22 m) keel→deck ahead of the canopy (a15). No manufacturer hull-depth spec found (Cigarette/Fountain/Donzi).
- Mass items: arch/seat/pilot y −0.374 (deck-referenced); shell y 0.8 → 0.643 (area-weighted section centroid
  0.985 → 0.792) and own roll gyradius 0.966 → 0.905 (ASSUMED). Derived: VCG 0.854 → 0.739, roll gyradius
  0.377 → 0.354·B (band ≥ 0.35), pitch 0.2597·L, LCG/mass unchanged.
- Flare knuckle 0.45 → 0.19 m above the chine: overall beam 2.47 m (8°, test band 2.44–2.51). 0.28 m first FAILED the
  asset checker (render deck max 0.586 vs proxy 0.561): near the stem the chine is only 0.31 m under the deck and the
  render's knuckle blend (0.3·(deck − chine) above the knuckle) poked through the deck; `jsonfix.ts` now asserts it.
- `node scripts/asset-build.mjs` exit 0, checker OK (tris/LOD 90417/13520/3397). Anchors: deck body y 0.561, prop
  y −0.859 ⇒ clamp top 0.123, cowl top (outboard.py Y0 + H = +0.78) 0.903 ⇒ **cowl top +0.34 m above the deck**
  (was −0.03; STYLE-SPEC +0.60 still needs a taller cowl or a higher plate). pilot_config.json's "about" text still
  quotes deckY 0.82 (pilot agent's file).
- Bow: `spec.stemHalfBeamFraction` 0.005 (was a hard 0.04 floor in `halfBeamAt`): chine half-beam 6 mm at the stem;
  only z > 11.53 m changes (cos taper). Rake 0.35 m and 45° forefoot kept. Sheer constant; the upturn seen from below
  is the keel rise (0.982 m over the forward 30 %).
- Physics deltas (HEAD → now): rest trim 2.1° both; static M at 10/20/30° heel at rest −6.8/−10.7/−12.9 →
  −7.8/−12.7/−15.9 kN·m; dynamic at C_v 3: M(10°) −11.9 → −14.3, K_p upright −25.3 → −28.0, at 20° −6.0 → −7.3;
  C_v 8: K_p −13.9 → −14.7 (0°), −5.2 → −7.1 (20°). Savitsky (now): trim −0.79/−0.87/−0.88/−0.79/−0.65/−0.51° and R
  −10.6/−10.2/−8.1/−5.4/−5.2/−7.0 % at C_v 3.1/3.7/4.3/5.0/5.6/6.0 (was −0.47…−0.86°, −6…−11 %).
- SO(3) sweep test: the lower deck lid crossing the surface inverted (184° pitch) is 5.1 % of the torque range per
  0.5° — steep, not a step (2.6 % per 0.25°, 1.0 % per 0.1°). The test now asserts the largest jump halves with the
  step (a true discontinuity does not) plus < 8 % per 0.5°.

## Envelope (assists off, helm 30°/s, throttle frozen, 20 s; tilt = acos(up·Ŷ); final code + 1.30 m hull)
| C_v | 1/3 lock (10°) | half lock (15°) | full lock (30°) |
|---|---|---|---|
| 3 | steady, peak 14.5° | steady, peak 22.4° | hook 1.32 s (peak 44.5°) |
| 4 | steady 12.9° | steady 22.0° | hook 1.98 s |
| 5 | steady 13.5° | steady 23.4° | hook 1.70 s |
| 6 | steady 15.2° | steady 25.9° | hook 1.53 s |
| 7 | steady 17.2° | hook 4.02 s | hook 1.40 s |
| 8 | steady 19.0° | hook 1.75 s | hook 1.32 s |
| 9 | steady 20.6° | hook 1.53 s | hook 1.25 s |
| 10 | steady 21.9° | hook 1.43 s | hook 1.18 s |
Acceptance NOT met: half lock C_v 7–10 and full lock at C_v 3. `it.fails` kept with the numbers above.

## Per-drive results (coordinator request, V77)
`HullWater.driveThrust` (signed N), `driveProp` (world, 3k), `driveDir` (unit drive line, world, 3k),
`driveAdvance`, `driveThrustFactor` (s^1.5), with `driveImmersion` — filled every evaluate(). Test: with the foils off
Σ thrust·dir at prop = driveForce/driveTorque, dir yawed by the steer, signs follow reverse gear.
The prop-wash adapter (src/wake/propWashHullWater.ts, not edited here) can read them; scratch `pw.test.ts` shows the
rewrite gives the same jets as the current re-derivation to 1e-6.

## Perf
µs per boat per tick (N=2, analytic sea, same machine, back-to-back, min of 4): HEAD 61–62 → now 63–64 (+2, chine-depth
lerps and per-drive writes).

---

# T189 — turning in waves, energy, at-rest stability, drive trim, engine + power

Scratch (not in repo): `scratchpad/t189/{sea,trace,energy,tumble,inv,rest,work,jump,drag,topspeed,heel10,env,perf}.test.ts`,
`lib.ts`, `hw_scratch.ts` (the instrumented copy with per-term work snapshots), `run.sh <name>`; engine research in
`scratchpad/t189e/`, respawn/origin investigation in `scratchpad/t189r/`.
Tests: `tests/hullWaterSea.test.ts` (6, new), `tests/engine.test.ts` (10, new); edits in hullWater/hullWaterManeuver
(below); `tests/speedboatAssist.test.ts` `it.fails` → `it` (the only edit there).

## Root causes (per-term roll work and energy audits; each pinned)
1. **Still-water velocities in a sea.** Every fluid-momentum velocity (2D+t V_n, sway V_L, GS impulses, Kirchhoff p)
   was the hull's over still water; a hull heaving WITH a swell was treated as slamming/planing through it. At rest in
   Working sea (Hs 2.78 m, CpuOcean, 90 s) 3/4 seeds capsized (roll rates 125–290°/s); Kirchhoff off: 12–19° (it was the
   main injector). Fix `waterVelocity`: vertical surface velocity ∂η/∂t from two consecutive patches
   (`WaterPatch.verticalVelocityAt`, prev grid kept, `forgetPrevious()` on `resetMemory`). Now max heel 11–13°, roll
   rate ≤ 30°/s, 4/4 seeds. Horizontal orbital velocity needs k (not in a height sampler): tried with the analytic
   swell's exact orbital field — horizontal alone moved no hook, vertical moved most (9/11 → 5/7 hooks at 6°).
2. **V110 rescaled the impulses.** Slam/crossflow/sway-entry impulses are applied to the GS velocities, then the cap
   scaled their J/h by s < 1: momentum the pass removed was handed back (+550 kJ over one capped re-entry, measured as
   rigid6 ΔKE − predicted). Fix: the cap acts on the explicit flux loads only (`explicitLoad`, `capScale`).
3. **Explicit flux loads not energy-consistent outside validity.** Inverted/capsized re-entries (216 cases, 90–180°
   heel, 15–35 m/s, flat water, throttle 0): +2.6 MJ (50 m of height) above initial energy; random tumbles +135 m.
   Kirchhoff force alone does work (the Munk moment that would pair it destabilises the hooks, T179); rotating-frame,
   lift and sway flux terms on side-on "bottoms". Fixes: `passivity` (explicit loads may add at most the kinetic energy
   the entrained water holds, ½Σm_aV_n² + ½Σm_latV_L², solved as the largest σ ≤ 1 on the quadratic ΔKE(σ) through the
   same (M + A₆)⁻¹), `planingFacing` (2D+t added mass fades as a panel turns from facing down to horizontal, n_y
   0.26 → 0, ramp ASSUMED), `faceDragCoeff` 1.2 (Hoerner flat plate) on wet deck/transom/stem faces, implicit.
   Now 216/216 re-entries and 100 random tumbles never exceed initial energy (worst +0.15 m).
4. **Lee-panel suction on a wave face.** The sway momentum flux + sway rotating-frame load as panel pressure pulled up to
   ~100 kN on the lee half (energy trace on the hooking runs: latFlux/latRot/lift feeding roll at water exit). A planing
   half open to the air at its spray root cannot go below ambient. Fix `panelSuctionLimit`: suction on a half ≤ its
   planing lift + hydrostatic normal load.
Ruled out (measured): gearcase ventilation off, chine-wet off, patch 0.4 m, diagonal added mass, transom drying (face
factor untouched), gearcase ventilation HYSTERESIS on re-entry (bit-identical hooks), roll damper 5–30 kN·m·s/rad
(8→4/16 at 30 kN·m·s: not the gap), B&K side-force line (a 0.42·chine cap on the sway centre gave C_v 8 0/16 but broke
K_p/D&H/heel tests; not adopted — B&K is 30° deadrise, lever 0.48 B vs model 0.83 B at C_v 3, 0.40 B at C_v 8).

## Crossing swell (T182 set: 2 amplitudes × 4 headings × 2 directions, raw helm 30°/s, 4 MW scale)
| | C_v 8 4° | C_v 8 6° | C_v 10 4° | C_v 10 6° |
|---|---|---|---|---|
| T179 model | 3 | 9 | 8 | 11 |
| T189 fluid fixes, old thrust curve | 0 | 2 | 3 | 4 |
| T189 final (engine thrust, C_D0 0.009) | 2 | 5 | 5 | 6 |
**Acceptance (0/16 at 6°, C_v 8–10) NOT met.** Remaining hooks: 1.2–1.5 s flights off the A = 1 swell at 40–47 m/s,
landing with 20–40° heel (asymmetric exit on crossing slopes) and the low chine/gearcases tripping her; at C_v 10 the
harness is at full throttle and some runs slip out (drift > 45°) at modest heel. Clean symmetric jumps (C_v 6 over a
1.5/2.5 m ridge, crossing 0/10/25°) keep airborne roll ≤ 3°/s at 1 MW (prop torque reaction off).

## Envelope (flat water, assists off, 30°/s helm, 20 s) — user decision still holds: hard helm at speed hooks
half lock (15°): steady C_v 3–8 (peak heel 20–30°), hooks C_v 9 (2.47 s), 10 (2.28 s) — was hooking from C_v 7.
full lock: hooks at every C_v, 2.45 s (C_v 3) … 1.28 s (C_v 10) — C_v 3 was a 44.5° transient, now a hook.
Inward heel at 10° drive: C_v 8 +7.8°, **C_v 10 +1.2° (was +10.6°)** — the suction limit; test threshold at C_v 10
relaxed to > 0 (DEVIATION).

## At rest (user: "tippy", "sits high")
- Statics (proxy, flat water, heave+trim solved): rest CG 0.204 m above water, keel draft 0.536 m, trim 2.14°,
  displaced 5.22 m³ = m/ρ (Archimedes exact). GM ≈ 0.97 m (GZ 0.034 m at 2°), GZ 0.151/0.246/0.306/0.363 m at
  10/20/30/50°, max ≈ 0.36 m at 50°, vanishing ≈ 100°. Roll decay at rest from 10°: period 3.4 s, 8.4→6.8° per cycle
  (ζ ≈ 0.03). Roll gyradius 0.354·B. These are a stiff, normal deep-V; the tippiness was root cause 1.
- Render origin: GLB origin = physics CG to 0.4 mm, pose copied with no offset (`speedboatFrame.ts:130-141`) — the
  "sits high" read came from the heavy rolling (CG 0.59 m above the local surface on average while rolling 33° rms).
- SPAWN (page, not physics): `course.ts:16,28` spawns every boat at a fixed 0.2 m above STILL water, level, zero
  velocity, ignoring the wave height (−2.08…+1.32 m at the grid slots): slot 1 starts 1.1 m under a crest, is thrown
  out at 4.9 rad/s and lands at 174°. Fix for the page owner: CG at `pressureHeadAt(x,z,t) + 0.239 m` after the mirror
  is updated to the spawn time (ideally tilted to the local slope). RESET: `main-speedboat.ts:110` uses
  `createNoCrashes()` (`page/stubs.ts:44-46`), so holding R does nothing yet (T191 wiring); the crash machine's respawn
  (`crash/teleport.ts:120-141`) follows the wave but reads the drawn `heightAt` (`:130`) — use `pressureHeadAt`.

## Working sea at speed (crash agent's scenario: Default assists, throttle 0.8, ±0.1 weave, 120 s)
T189 final, 8 seeds (188, 7, 1–6): throttle 0.8 capsizes 6/8 (22–61 s; T179 model: 2/2 of 188/7, 1/2 of 1/2); throttle 0.6: 0/4 in 120 s (seeds 188, 7, 1, 2). **Acceptance (0/8 at 0.8–1.0) NOT met.** Launches of 1.2–1.8 s (CG 5–7 m above the local surface) off 20–25° faces at
25 m/s with a cross-slope roll rate of ~20–25°/s at takeoff land at 35–45° heel and trip. Hs 2.78 m is Beaufort 6; the
energy injections are gone (above), what remains is flight + landing physics in that sea.

## Drive trim (`setControls(steer, throttle, trim)`)
Lower unit rotates about the clamp pin (JSON `lowerUnit.trimPivotAboveAvPlate` 0.762 m = the 30 in shaft) before the
steer yaw: thrust line (sinδcosθ, −sinθ, cosδcosθ), prop/CE/AV plate move aft-up. Range −6…+20° from the task text
(NOT verified: Mercury pages 403, no web budget). Effect at WOT: running trim 1.87° (0°) → 1.97° (+8°), top speed
+0.8 %. Savitsky check: a bow-up moment M shifts the centre of pressure aft by M/W; at λ ≈ 1.4, τ ∝ λ^−0.45 ⇒ +8° trim's
12.5 kN·m ⇒ ≈ +0.1° — the thrust-line moment alone is small on this hull; the large real effect needs surface-piercing
prop vertical force (not modelled; no coefficient source in hand).
Airborne pitch authority: a dry prop's torque is ρ_air/ρ_water of the wet one (engine `airFloor` now 1.2e-3, was a 0.12
flare heuristic that rolled the boat ~6°/s per second of flight); spinning the train up/down changes angular momentum by
I·G·Δω ≈ 0.2·1.6·180 ≈ 57 N·m·s per engine ⇒ < 1°/s of roll, ~0.007 rad/s of pitch. Real but negligible: throttle and
trim give no meaningful pitch control in the air. `propTorqueReaction` (−hand·(Q + I·dω/dt) about each drive line,
outer pair counter-rotating ASSUMED) is implemented but DEFAULT OFF: the net one-engine torque (~840 N·m, 0.4° heel at
top speed) breaks the left/right mirror and heading-wander guarantees (T182 `speedboatAssist` mirror 3.9° vs 0.5°,
T179 wander 0.44° vs 0.25°) — a decision for the controls owner.

## Engine (src/sea-physics/engine.ts, V77) and top speed
From rpmModel (torque-curve shape, friction/pumping, throttle-body lag 0.12/0.07 s, idle air, limiter 6800/320 with a
two-cycle cut, overrun cut) with 450R data: 450 prop-shaft hp, 439 lb-ft, 1.60:1 Sport Master (the 1.75 in rpmModel is
the 400R), K_T/K_Q parabolas of a surface-piercing prop (Kim & Rhee, smp'24) with immersion^1.5 and a low-J ventilation
factor, 15.25 × 26 in calibrated at 85 mph / 6100 rpm (slip 9.4 %, η0 0.57). Spool 0.47 s to 90 % thrust at 30 m/s.
Throttle exactly 0 = NEUTRAL (added `EngineInput.neutral`; idle-in-gear crept 108 N per engine and moved the resting-drift
test). Per drive `hw.engines[k]`, `driveRpm`, `resetEngines()`. `standInDrivePowerW` now = engine powerScale × 1007 kW.
Cited 3×450R: Nor-Tech 390 Sport (39 ft, 24°, 11.5–12.5k lb) 87 mph; Mystic M4200 mid-80s ⇒ target 85 mph ± 5 %.
**Top speed: 33.4 m/s (74.8 mph) at 0° trim, 33.8 (75.6 mph) at +8° — 11 % short: NOT met.**
Drag/thrust verdict: thrust is right (engine delivers 15.1 kN at 38 m/s, rpm in window); DRAG is high. Gearcase
C_D0 0.02 → 0.009 (Hoerner strut + torpedo, JSON note) cut 9.3 → 4.2 kN at 40 m/s. What remains: hull friction 17.4 of
19.0 kN at 40 m/s on a 5.7 m² clipped (≈ 8.3 m² spray-root) area at 1.74° running trim — consistent with Savitsky at the
MODEL's trim (Savitsky ≈ 12 kN at its own ~2.3°), i.e. the known −0.5…−0.9° trim deficit plus no aero lift and no SPP
vertical prop force. Past C_v 6 Savitsky is invalid (dry chines); not re-fitted (T165 rule).

## API / params
`setControls(steer, throttle, trim = 0)`; `HullDrive.trimPivotY/trimMinRad/trimMaxRad/propHand` (optional);
`HullWaterParams.waterVelocity/planingFacing/panelSuctionLimit/passivity/faceDragCoeff/engine/propTorqueReaction`;
`HullWater.explicitLoad`, `passivityScale`, `engines`, `driveRpm`, `resetEngines()`; `WaterPatch.verticalVelocityAt`,
`forgetPrevious`. JSON: `lowerUnit.profileDragCoeff` 0.02 → 0.009 (+ note), `trimPivotAboveAvPlate/trimMinDeg/trimMaxDeg`,
`engines[].propHand`. `STANDIN_THRUST` kept as the power reference. Sim-worker step API unchanged (stepCore's 2-argument
`setControls` still valid; trim → pass `fleet` CONTROLS trim through when wanted). Audio: import `engine.ts`
(`EngineState` lacks audio's thrEff/load/bark/refire counters — audio keeps those as its own state).

## Tests changed (why)
- hullWater V110: cap on explicit loads only; asserts load = raw − (1 − s)·explicit and impulses unscaled.
- maneuver drift mutation now `{kirchhoff, passivity, faceDragCoeff: 0}` off (all three hold her); chine-wet mutation
  adds `panelSuctionLimit: false`; heel-in at C_v 10 > 0 (was > 3); drive publication test spools the engine first.
- speedboatAssist `it.fails` (raw C_v 10 4° hooks) → `it` (no longer hooks).
- STILL FAILING, not ours to edit (T182 controls): "in a 0.9 m sea the heel guard…" (unguarded 4 < 7: the sea no longer
  hooks the curve alone) and "Pro … hooks where it hooks" (C_v 8 half lock no longer hooks; C_v 9 does, 2.47 s).

## Perf (µs per boat per tick, N=2, analytic sea, throttle 0.7): under load average 31 from parallel agents — best of
12 back-to-back: HEAD 91.5 → now 104.3 (+14 %: engine sub-steps 4 × 3 drives, per-half ∂η/∂t reads, passivity 6×6).

## Weight distribution, squat, "floaty" (coordinator follow-up)
- Mass items: three outboards 312 kg each at z −0.95 m (AFT of the transom, hull frame z from the transom), bracket 110 kg
  at −0.40 ⇒ LCG 3.606 m from the transom (0.30 L). Player (`main-speedboat.ts:90`) and NPC worker (`stepCore.ts:139`)
  build the SAME `buildDeepVHull()`.
- Physics statics/steady trim (flat water, speed held): U 0 → trim +2.12° bow-up (stern down), AV plate 0.60 m BELOW the
  surface, gearcase immersion 1.00; U 3/6/9/12/15 m/s → 2.7/3.8/5.3/5.1/4.1°, plate 0.65/0.72/0.74/0.61/0.48 m under.
  Lower units are submerged at rest and at low speed in the physics. So "NPC engines out of the water" is not the physics
  pose: lead for the page/assets owner — NPC render applies `setDriveState(npcDrive)` (`speedboatFrame.ts:212-222`),
  which tilts each outboard about its tilt tube by the trim angle (`assets/boatModel.ts:93`); check the NPC trim value
  fed there, and the NPC pose interpolation (`npcFleet.renderPose`). Not verified in a browser (no browser).
- "Floaty": heave decay at rest from +0.2 m: period 2.23 s, successive same-sign peaks 0.151 → 0.122 → 0.101 m ⇒
  ζ ≈ 0.034; pitch from +3°: period 2.3 s, ζ ≈ 0.046; roll ζ ≈ 0.03 (period 3.4 s). Buoyancy is exact Archimedes
  (displaced 5.22 m³ = m/ρ at rest). The missing physics is ZERO-SPEED WAVE RADIATION DAMPING (T165 known gap: 2D+t
  supplies damping ∝ U; at rest only entry impulses and crossflow drag remain). Order of magnitude for this hull
  (estimate, not a citation I could re-check this session: 2D rectangular/V section heave damping at ω²b/g ≈ 0.9 of
  ~0.6·ρ·S·ω per metre, Vugts 1968 via Journée & Massie) ⇒ ζ ≈ 0.1. NOT FIXED in T189 — a frequency-domain term that
  must fade with speed and be re-validated against Savitsky/pitch/roll tests; next task.

---

# T196 — PART A DONE (the tree green again after T189)

Scratch (not in repo): `scratchpad/t196/{crashprobe,stuffab,stuff2,stuff3,pylon,lock,lock4,cap,pack,track}.test.ts`, HEAD copy of
hullWater in `scratchpad/t196/head/` for A/B, `run.sh <name>`.

| failing test | call | why / what changed |
|---|---|---|
| raceAiCapability: committed table | LEGIT (engine) | re-measured. The engine model: top speed 29.5 → 33.4 m/s, full-throttle accel at 4 m/s 7.8 → 2.6 m/s², hold throttle at 6 m/s 0.11 → 0.48 (throttle^1.6 body law). The grids were STALE too: SPEED_GRID ended at 29 and TURN_SPEEDS at 29.5, so the 0°/5° columns ended below top speed at throttle 0.9 and `turnTopSpeed(0)` read 29.5 ⇒ `accelAt` shifted by 3.9 m/s. Grids now run past any top speed (unreached speeds drop out) and turn rows end at topSpeed + 0.5 (`turnSpeedsFor`); a 16° steer column added. |
| raceAiCapability: teeth (1.6× the schedule hooks) | LEGIT (T189 suction/passivity) — schedule re-derived | sweep at the 15°/s helm, full throttle: departures now at 20° (6–10 m/s), 22.5° (14), 25° (18–33); 4 MW C_v 6–10: 20° steady, 22.5–25° capsize. The old 12.5° max sat 2× under the edge, so the teeth could not bite. `lockLimit` = 12.5° ≤ 6 m/s → 16° at ≥ 14 m/s; 1.6× departs at all 8 speeds, 1.5× at 4 MW C_v 7/8/10. Property unchanged (at the schedule never departs; one notch past does). |
| raceAiPack: missed gates | LEGIT (engine) — harness start + line margin re-derived | (1) rookie missed the START gate: the harness put grid row 3 at 18 m/s inside the course's last corner; the stand-in's 3–4 m/s² of reverse braked for it, the engine's 1–1.7 m/s² (measured `reverse`) cannot. Grid now on the course's pace line (what the page does, course.ts). (2) hothead/swell missed chicane gates 5/6 by 0.3–0.5 m: measured |cross-track − offset| within 25 m of gates is 4–6 m at 31 m/s (faster boat, 16° lock), the risk-1 line margin was 2 m. `levelShape` margin 7 − 5·risk → 7 − 4·risk (3 m minimum). Lap spread/ratio/ordering assertions untouched and passing (55.8–59.6 s). |
| speedboatCrash: HOOK C_v 5 | NOT PHYSICS (float) | detect 13.25, onset 13.75 — exactly 30 ticks = 0.5000000000000249 > 0.5; HEAD gave 13.25/13.72. Tolerance + 1e-9, as the file's other timing checks. |
| speedboatCrash: STUFF | LEGIT (T189 passivity) — scenario re-cut | HEAD's −10° / 30 m/s pitchpole was powered by planing lift on the aft sections of a bottom WITHDRAWING along its normal (V_n = −3.2 m/s at 10° bow-down): `U·(M_i − M_up)` with both M negative and the deeper bow upstream gives positive lift aft with a forward (thrust) component — +1.2 MN·m bow-down, energy in. Passivity now removes it (σ = 0 on that entry). The model still stuffs when the foredeck is driven under (−15° static: stuff @0.37 s; −10° with a 0.5 rad/s bow-down rate: @0.20 s, same as HEAD). Test uses the falling-bow entry; onset/detect timing checks unchanged. Finding kept for Part B: σ = 0 zeroes ALL explicit loads on such entries (credit starts at 0, is banked only by explicit-load removals). |
| speedboatCrash: pylon recover-in-place, fuel cut | LEGIT (engine) — throttle re-cut | at throttle 0.3 the engine no longer accelerates her off 5 m/s through the hump (φ = 0.3^1.6): she arrived at 2.3 m/s, bow |Δv| 2.4 < 8 ⇒ no crash. Sweep: 0.8 ⇒ |Δv| 8.4 (HEAD at 0.3: 8.2), below the 20 kn structure reset. Both tests at 0.8. |

Gates after Part A: 212/213; the one failure is `raceAiLine` "a layout without a pilot is byte-for-byte…" (3592 vs 2128 bytes) —
sim-worker layout header edits in progress by another agent (T191/T195, `src/sim-worker/layout.ts`), not physics. `tsc`: one
error, `tests/sprayFleet.test.ts` (not ours). raceAiSea passes but is a single-realisation count on a sea where every NPC hooks
10–20× per lap (Part B item 3); it moved ±50 % between runs of this part.

---

# T196 — PART B: radiation damping, heeled landings, Working sea, top speed, prop torque; + coordinator items 6–7 and
# the T197 follow-ups

Scratch (not in repo): `scratchpad/t196/rad/{frank.py,wedge.py,table.py,strip.py}` (2D radiation solver, venv with numpy/
scipy in `t196/venv`), `t196/{decay,sea,trace,trace2,trace3,work,imm,top,jump,env,turnnums,mut,c10,solo,pack}.test.ts`,
`hwdbg.ts` (instrumented copy: per-term roll moments and explicit-term power), `lib.ts` (T189 swell harness), `run.sh`.
Literature used: Journée & Massie, Offshore Hydromechanics (TU Delft 2001, ch. 6–7, downloaded); Kim & Rhee smp'24 (read);
Sun & Faltinsen 2007 (planing gravity, read); USNA EN441 ch. 3 Fig. 9 (Korvin-Kroukovsky, Savitsky & Lehman 1949 wake
profile, read off the rendered figure); Boating Mag Nor-Tech 390 / Mystic M4200 tests (WebFetch).

## B1 — floaty at rest: zero-speed wave radiation damping (`radiationDamping`, default on)
- Solver: Frank (1967) pulsating-source close-fit, deep water, G = ln r − ln r′ − 2·PV∫e^{kY}cos kX/(k−ν)dk + 2πi e^{νY}cos νX
  (PV integral in closed form Re{e^Z E₁(Z)} − πe^{νY}sin ν|X|, checked against quadrature to 1e-15; free-surface and
  outgoing-wave signs derived and checked). Validation: semicircle heave added mass → ρπR²/2 at ω → ∞ (1.004); damping
  rising toward the Haskind/Froude–Krylov limit ρωB² at ω → 0 (0.87 of it at νR 0.025); damping from the solver's own
  far-field wave amplitude (J&M eq. 6.33) within 0.5 %; 20 vs 40 panels < 0.1 %.
- Wedge tables (deadrise 8–45°, ξ = ω²b/g 0.02–8): heave damping b33 = N₃₃/(ρωB²) nearly independent of deadrise (0.31 at
  ξ 1, 24°). Strip theory on this hull's REST sections (heave only, uncoupled): T 1.84 s ζ 0.33; pitch T 1.84 ζ 0.30; roll
  T 2.09 ζ 0.11. At the MODEL's own periods and inertias (heave 2.25 s, pitch 2.3 s, roll 3.4 s — the model carries more
  added mass at rest, Wagner's splash-up factor): ζ_heave 0.28, ζ_pitch 0.24, ζ_roll 0.02 — the cited reference.
- Time domain: per wet strip a linear implicit damper on the strip centroid's vertical velocity relative to the water,
  coefficient b33(β = atan(T/b), ξ_s)·ρωB²·Δz at the SECTION's heave natural frequency ξ_s = 1/(2(T/(4b) + a33)) (ω_s
  3.3–3.9 rad/s; b33·ω is flat between ω_s and the hull's 2.8 rad/s, < 5 %). Heave only on the centre line: per-half
  application would have made roll damping ≈ 8× the V-section's radiation value. Fade: 1 − smoothstep of the length Froude
  number 0.4 → 1.0 (strip theory's usual range → Sun & Faltinsen's lower planing limit "Fn 1~1.2"); zero from C_v 2.3 up,
  so Savitsky, pitch settling and roll-kick tests run on the untouched planing model.
- Result (decay from +0.2 m / +3° / 10°): heave ζ 0.044 → 0.30 (T 2.25 → 2.30 s), pitch 0.078 → 0.30 first cycle / 0.25
  after, roll unchanged 0.03 (radiation reference 0.02 + existing terms). ACCEPTANCE MET for heave/pitch (reference ± 30 %),
  roll deliberately not raised. Test `hullWaterSea` "heave and pitch decay…" (mutation off ⇒ < 0.08) and the fade test.
  The resting-drift mutation in `hullWaterManeuver` now also switches radiation off (it damps the heave–pitch cycle the walk
  rectifies: 0.058 m/s with the three T189 terms off, under the bound).

## B2 — hooks after heeled landings (crossing swell, 6° drive, T182 16-run set)
| | C_v 8 | C_v 10 |
|---|---|---|
| T189 final | 5/16 | 6/16 |
| + water-exit rule only | 5 | 7 |
| + passivity scoped to the transfer loads, credited with impulse dissipation | 4 | 3 |
| + drives in the transom wake, raised 0.12 m (item 7) | **2** | **1** |
Acceptance ≤ 1/16: **met at C_v 10, NOT at C_v 8 (2/16)**. Mechanisms found (per-term roll-moment and power traces):
1. **Exit sections carried planing momentum.** U·(M_i − M_up) with both M negative gave a positive pressure on a panel
   moving AWAY from the water (+619 kW on a −10° / 30 m/s entry, the old pitchpole's engine). `waterExit`: M = 0 on a
   withdrawing half, the rule the slam law already had. Test: flux-load power ≤ 0 on that entry (mutation +619 kW).
2. **Passivity zeroed the righting lift.** On the ticks the bound bit (σ < 0.5, 0.5 % of ticks, all at touchdowns) the
   rotating-frame/gyro/Kirchhoff loads put +54…+154 kW in while lift/sway flux took −63…−181 kW out; one σ over all of them
   removed the lift and the transfer terms' own roll damping (+13…+19 kN·m opposing a −139°/s roll-through). Now σ scales
   the transfer loads only (`explicitTransferLoad`), and the credit also banks the rigid kinetic energy the implicit impulses
   (slam, entry, crossflow, radiation, face drag) took out this substep — the "plus what the dissipative terms have taken
   out" the T189 doc promised; the credit started at 0 on every touchdown before. Energy test unchanged: 216 re-entries
   never above initial energy (< 0.05 m); its T179 mutation now includes `waterExit: false` (the exit rule alone removes
   the injection).
3. **The drives steered her in the air.** In the remaining hooks the hull was dry for 0.5–1 s while the low-side gearcases
   and props stayed buried (bow-up flight, stern low): drive roll moment ±3–6 kN·m spun her 20° → 45°. The transom-wake
   immersion (item 7) takes the lower units out with the hull. The two C_v 8 hooks left: 1.0–1.3 s flights rolling 20 → 45°
   with the low-side prop still in the water; touchdown at 45° with the roll rate being arrested (harness departure = 45°).
Rejected: a deadrise-dependent splash-up factor (linear π/2 → 1 at 90°): 6/16 and 6/16, and it would move Savitsky.
Brown & Klosinski's damping term 0.134 sin|ψ| is YAW angle, not heel (report text) — no heel dependence to borrow.

## B3 — Working sea, Default assists, throttle 0.8, ±0.1 weave, 120 s
0/8 capsizes (seeds 188, 7, 1–6): max tilt 19–27°, mean speed 12.8–15.8 m/s, longest flight 1.0–1.6 s. **ACCEPTANCE MET.**
(T189: 6/8.) A/B seed 188, 60 s: transom wake off ⇒ mean 16.0 m/s vs 13.7 on (props surface in the sea too); radiation off
⇒ same. The crash test's clean Working-sea run (throttle 0.6) now peaks tilt 15° / heel 11° (T188: 35° / 35°).

## B4 — top speed vs the cited 87 mph — NOT MET, and the citation is the wrong hull
- Both cited boats are STEPPED: Nor-Tech 390 Sport "hull steps … ran along the water like shark teeth" (Boating Mag test,
  24°, 11,500 lb, triple 400R "breaking 80 mph"); Mystic M4200 "double-stepped hull" (quad 450R, 86 mph). The proxy is a
  conventional non-stepped deep-V; no non-stepped 12 m triple-450R data found.
- Savitsky for THIS hull (LCG 3.606 m, 24°, 5351 kg, extrapolated past C_v 6): τ 2.0°, R_hull 19.2 kN at 33.9 m/s, 23.1 kN
  at 38 m/s. Model at WOT: 33.9 m/s (75.9 mph), running trim 1.84°, hull drag 16.0 kN, thrust 17.9 kN, 5747 rpm. The model
  is 17 % BELOW Savitsky's drag at its own top speed and its trim within 0.2° of Savitsky's there — the in-range low-trim
  bias (−0.5…−0.9° at C_v 3–6) is not what limits top speed. Savitsky's own non-stepped top speed with this thrust ≈ 31–32
  m/s. Friction was not cut. Missing physics that would raise a real boat's trim (SPP vertical force, aero lift) has no
  coefficient source in hand.

## B5 — prop torque reaction: implemented, default OFF (unchanged). Documented in T189; nothing added.

## Item 6 — Surge boost API
`HullWater.setBoost(multiplier)` (≥ 1, clamped to `engine.boostMax` 1.3; persists) → `EngineInput.boost`: crank brake
torque × boost at every throttle, limiter/Governor cut × √boost. Thrust comes from the prop curve: at 85 mph boost 1.2 ⇒
thrust × 1.30, rpm × 1.04 (lower J raises K_T and K_Q); a dry prop gets nothing; boost 1 bit-identical. The page passes
the race's Surge `thrustMultiplier` straight to `setBoost` (thrust gain ≈ multiplier^1.4 at speed). Sim-worker: not
plumbed (no step API change); a fleet boat needs a control slot for it (owner: T191/T195).

## Item 7 — props buried while planing → drives run in the transom wake
- Measured before: prop immersion 1.00 at C_v 4/6/8, shaft 0.43–0.61 m under the undisturbed surface, gearcases fully wet.
- `transomWake` (default on): prop and AV-plate depths against the Korvin-Kroukovsky/Savitsky/Lehman centreline wake profile
  H/B = 0.02064 q² − 0.00448 q^2.44 + 0.0108 λ τ^0.34 X, q = X τ^0.7/C_v^0.6 (checked against the figure's worked example),
  × the transom's Froude dry fraction. The water leaves the keel and rises slowly: at the props (X 0.57 B) it is ≈ at keel
  height.
- Mount: shaft at keel height (JSON `propPoint.yAboveKeel` −0.12 → 0, AV plate 0.10 → 0.22 m above the keel, outboard mass
  items y 1.10 → 1.222 with the clamp): VCG 0.739 → 0.760 m, roll gyradius 0.3539 → 0.3586 B, pitch 0.2597 → 0.2599 L.
  ASSUMED: "shaft at the keel line" rule for bracketed surfacing props; the T179 setback rule (+3…7.5 in) is exceeded.
- Result: prop immersion 0.70 / 0.64 / 0.61 at C_v 4 / 6 / 8 (≈ I_T 0.66 / 0.60 / 0.57; Kim & Rhee test range 0.3–0.7,
  boss cap at the surface at 0.5), gearcase span 0.65 / 0.62 / 0.61; at rest 1.00 and 1.00 (shaft 0.72 m under). Engine
  re-calibrated at the running immersion (`calImmersion` 1 → 0.6): same WOT balance at 85 mph, so a buried prop (hole shot)
  is 2.15× the old thrust.
- Rest CG height 0.2036 → 0.2249 m above still water (trim 2.14° unchanged) — for T198 `SPAWN_CG_Y`. Intended (the raised
  engines).
- T197 render shots (engines clear of the water at 21 m/s, lower units barely in at rest) do NOT match this physics (at
  rest the AV plate is 0.41 m under still water; at C_v 4 the props are 70 % immersed in the wake hollow): the render's
  pose/outboard anchors or water height differ — page/asset owners (T192 anchors.py reads `yAboveKeel`; rebuild the GLB).
  Not checked in a browser (no browser, GPU lock).

## Consequences re-derived (explicit calls)
- Envelope (flat, 30°/s, 4 MW, throttle frozen): half lock steady C_v 3–9, hooks C_v 10 (3.65 s); full lock hooks C_v 4–10
  (2.15…1.42 s), C_v 3 survives a 44° roll-in. Wake off (same mount): half lock never hooks, full lock hooks C_v 3–10.
- Crash detector: a full-lock departure now slides first (C_v 5: slip 38°, yaw 0.89 rad/s, heel 31° — under the spin-out
  triple) and then lays over past 45°. New `hookKnockdownHeelDeg` 50°: heel ≥ 50° wet, above the speed floor, is a hook.
  Air rolls stay barrelRoll's.
- NPC lock schedule 14.5° (≤ 6 m/s) → 19° (≥ 10 m/s): the lock-entry departure edge moved to 22.5° at 6 m/s and 30° at
  10–33 m/s; 4 MW 25–27.5°. Turn table columns 0/5/10/15/19°; the 19° column contains off-plane rows (a 30 m/s entry
  settles at 12.3 m/s) — sorted by speed, the last row is still the column's full-throttle speed.
- NPC pilot on the new boat: rookie/hothead (shortest lookaheads) slalomed on straights at lock with 12–19° drift
  (pure-pursuit loop under-damped once the gearcases run part-surfaced). Yaw-rate term 0.12 → 0.4, hothead lookahead 1.6
  → 1.8 s, line margin 7 − 3.5·risk (measured tracking error near chicane gates 4–6 m). Pack: laps 55.1–59.1 s, no misses.
- Race/ai handedness moved to race/types.ts (coordinator T197 item 1): `corridorsOf` mark side and hairpin apex; the
  synthetic course's marks are 'starboard' (same geometry); harness rounding line sign follows keepOn.
- Test deviations (in the files): maneuver C_v 10 heel-in bound −5° (−1.8 ± 2.0°: the 4 MW harness over-speeds the prop onto
  the rev limiter at 45 m/s, thrust pulses 20–39 kN, ventilated gearcases ≈ 1 kN side force; wake off +7.2°); full lock C_v 3
  amplitude < 6° (27 ± 5°; wake off: hooks); half-lock mutation → Wagner centres off (chine-wet/suction off stays steady
  now). Assist: Pro envelope speeds C_v 10 half / C_v 4 full; Governor bar 2 → 2.5 m (0.7 s flight by the airborne flag);
  landing assist `it.fails` — KNOWN REGRESSION for the controls owner: with the props surfacing at the launch the emulated
  trim has no thrust to re-aim (off → on landing pitch 9.6 → 9.8°, 12.1 → 12.3°, 10.7 → 10.6°, 8.2 → 8.6°, 12.7 → 13.6°).
- Rookie 3-lap test then missed gates 7 and 10 on laps 2–3 (ran 46 m wide at lock with 12–18° drift at full throttle after a
  mistake). Pilot: when |cross-track − offset| > 15 m the target speed is capped at the measured corner speed of the
  PURSUIT curvature (`cornerSpeed(kappa, latUse)`). 6/9/12/15 m tried: 6 m slowed every lap 3–6 s; 12 m left the catch-up
  spread 0.13 s over its bound; 9 and 15 m pass; 15 m kept. Laps 68.1 / 57.1 / 56.2 s, no misses.

---

# T207 — wakes move every boat (symmetrically), Surge for every engine

Scratch (not in repo): tests/zzScratchT207{Kelvin,Quad,Sym,Perf,Parity,Smoke,Det}.test.ts; scratchpad t207/tree (attribution copy).

## Wake force model (`src/wake/wakeField.ts`)
- NOT the W4 CPU band: an analytic per-boat LINEAR STEADY SHIP-WAVE field (Havelock 1908; Lamb §242 2D check), evaluated
  from a compact per-boat RECORD (11 f64: CG x/z, v_x/v_z, distance run since placement, and the low-passed Σfy + fy-weighted along/across
  offsets, second moments and depth of the contact's `hw.wake` samples). Amplitude = the hull's own contact load, each
  sample drawn as the wake solver splats it at the NEAR tier's band (σ = splatSigma(fp, 0.5 m, 256) ≥ 0.71 m), reduced
  to one moment-matched Gaussian — no fudge factor anywhere.
- η(X, Y) = (1/πρU²) ∫du k|p̂| [H(X−Yu) sin(−Ks(X−Yu)) + sin(−Ks(X+Yu))]: an 80-node trapezoid on a per-source node
  table (stride 4/2/1 by phase range) near the source, stationary-phase (Airy-floored cusp) past a phase range of
  250–320 rad. [M] vs a 20 000-node reference, U 6–40 m/s, X 13–290 m, Y/X 0–0.32: rms error 0.4–2.3 mm on an rms
  field of 20–92 mm. Stationary phase alone was 2–100× off within ~0.8U²/g astern near the track (it misses the hollow
  directly behind a planing hull: −0.13 m at 20 m astern, 30 m/s) — why the quadrature is there.
- Gaussian reduction vs the full 22-sample transform (tow 15 / 30 m/s, X 20–80 m): peak |η| within 5 %.
- Laid straight astern along the source's course over ground (fades 240–300 m astern). A circular-path variant
  (κ = ω_y/U) was REJECTED on measurement: in the Tower Reach smoke race hooking/tumbling boats' yaw rates (1–6 rad/s)
  whipped tiny arcs across the pack, ∂η/∂t at receivers' CGs 4–38 m/s, 27 crash events vs 5 straight (before the established-length fade). Established length:
  the record carries the distance run since placement and the pattern fades from run/2 to run astern (divergent group
  velocity = ½ phase velocity) — no full steady wake thrown at the boat behind on a grid start or a respawn.
  Wave memory: the record's load moments low-passed 1 s (ASSUMED; timing only) so an airborne emitter's wake does not
  vanish and no receiver sees a one-tick ∂η/∂t spike. Not modelled: local near field, Smith attenuation, finite depth,
  true wave history (a transient turn swings the pattern).
- §V108: `WakeField.prepare` skips the receiver's own record. [M] a lone boat is bit-identical wakes on/off.

## Plumbing (§V2/§V110)
- Layout: optional `wakeField` → WAKE WORLD (boats × 11, main-written tick-k records, frozen like WORLD) + WAKE OUT
  (rows × boats × 11, stepper-written); batch rows carry each external boat's record; header F slot 19 = record length.
  Absent ⇒ byte-identical layout (pinned sizes in simWorkerBatch/raceAiLine unchanged). A wake fleet is a WORLD reader
  (multi-shard batches cap at 1, as with pilot/contacts).
- Step core: prepare the field from WAKE WORLD (excluding i) → sampler = pressure head + wake → step → record into WAKE
  OUT from its own previous record (reset on a placement). Player (`playerBoat`): the SAME two calls; `wakeRecord` goes
  to the rivals through `NpcTickInputs.playerWake`, rivals' records come back per tick (`npcFleet.wakeSource`, ring like
  the trace). `raceSession` feeds the player the rivals' records of trace tick tA carried to the tick start (the pose
  rule); npcFleet turns wakes on with `player: true` (the race page).
- Asymmetry left (as for collisions): the player reads rival records D−2 ticks old, extrapolated; rivals read the
  player's exact tick-start record.

## Numbers
- Symmetry (crossing a 30 m/s leader's wake at 45°, 80 m astern, calm): player-in-rival's-wake and rival-in-player's
  ride bit-identical here; max |v_y| 1.56 m/s vs 0.98 without wakes, max pitch 3.28° vs 2.86°, speed −0.07 m/s. Trailing
  straight 30–60 m astern at WOT: speed −0.04 %…+0.2 %, mean pitch +0.1°. Peak |η| at a receiver's CG ≈ 0.09–0.10 m.
- Cost: inner loop on a 4096-entry table sine (error 3e-7, plain float arithmetic) and per-boat node tables shared by
  every receiver of a tick: ≈ 0.01 ms per receiver–source pair (108 patch samples). 8-boat 2×4 pack at 30 m/s, main
  transport, machine at load 11: 3.4–4.8 → 5.6–5.9 ms/tick (+1–2 ms, noisy); before the table sine +4–7 ms.
- Race smoke (tests/speedboatRaceSmoke, NOT in the T207 gates, not edited): wakes on ⇒ 1–2 rival hooks per calm lap
  (e.g. #3 hook tick 3097), wakes off (same tree) ⇒ 0. Deterministic (paced vs unpaced hashes equal at 1200/2400/3200,
  same crash both). With the far tier's band (σ ≥ 2.5 m, ~10× weaker short waves) still 1 hook (#1 tick 3240): the pack
  race is chaotic, the pilots (race/ai) do not read wakes. Owner call: accept crashes in a pack, or pilot wake-awareness.
- speedboatNpcSea "rival pitch std within 10× of the player" (7.20 vs bound 6.34) fails identically WITHOUT T207 (my
  files reverted in a copy): pre-existing, not this task.
- Parity test now runs in clean water (rivals abeam); wake coupling moved to tests/speedboatWakeSymmetry.test.ts.

## Surge
- Controls slot 3 (was reserved) = the race's `thrustMultiplier`; `BoatSimCore.step` → `hw.setBoost` for every stepped
  boat (pilot or not); `setControls/setBatchControls(…, boost)`; npcFleet records `NpcTickInputs.boost` per tick;
  raceSession stores `RacerOutputs.thrustMultiplier` in `raceOutputs.boost` and calls `player.hw.setBoost` in `controls`.
  Slot ≤ 1 = stock, bit-identical. Test: tests/simWorkerSurge.test.ts (rows ≡ one-tick kicks; boosted twin +speed).

# T207 — Governor on the engine's rpm; landing assist out of Default
Scratch (not in repo): tests/zzScratchT207Assist.test.ts, tests/zzScratchT207AssistCalm.test.ts.
## Governor (src/speedboat/assists/governor.ts) — the T182 rpm proxy is gone
- Reads BoatSimSample.rpm (max hw.driveRpm), ratedRpm (6100), propImmersion. AIR/FULL act ONLY with the props OUT:
  airborne, mean immersion < 0.1, or a one-tick immersion fall ≥ 0.25 (launch 0.9 → 0.3 → 0; calm WOT ≤ 0.095/tick).
  Then an rpm governor at rated: lead = rpm + max(0, Δrpm/dt)·0.15 s, throttle ≤ max(0.05, 1 − 40·(lead/rated − 1)).
- WET NOTHING IS CAPPED, even over rated: unassisted calm WOT itself ventilates to 6790 rpm (rises to 19 000 rpm/s,
  immersion min 0.13). A first law with a wet over-rated cap (lead on the rise) cut the parity player to 30.43 vs
  33.6–34.0 m/s; a wet cap only above 1.12 × rated still −6.1 % (30 cut ticks: the spool lag turns cuts into speed).
- Why the lead: a dry prop gains ≈ 26 000 rpm/s, the throttle closes in 0.07 s, the sample is a tick old. Lead 0:
  flights 6760–6814 rpm; lead 0.15 s gain 20: ~6280 held; gain 40: 6061–6178; gain 60 no better.
- Results: calm WOT Default 33.827 = Pro 33.827 m/s (speedboatParity green); 0.9 m swell AIR = OFF 33.255 m/s;
  2.5 m bar C_v 8 OFF 6837 (limiter), AIR 6178 whole flight; C_v 10 1.5 m bar AIR 6798 on the launch tick (wet,
  ventilated face — the 4 MW harness runs 6400–6800 rpm wet before the bar), 6069–6165 from 0.25 s into the flight.
- Tests: OFF ≥ limitRpm; AIR ≤ 1.02 × rated (whole flight on 2.5 m, after 0.25 s on C_v 10); unit: wet over rated
  uncapped, dry flare governed, launch cut before rated.
## Landing assist — removed from Default (landingAssist 0.5 → 0)
- Real trim path (setControls trim), 5 bars, off → on: 13.28→12.32, 19.35→16.01, 10.26→11.21, 12.75→11.48,
  22.01→18.31° (centre 2.5°): worse at C_v 6. Full trim-OUT on the face (opposite command): 10.57/15.96/10.23/12.16/
  16.57° — as flat or flatter on 4 of 5: tilting a drive either way lifts the prop and costs launch thrust; no direction
  to steer with. Trim only in the air: 0.00° (props dry).
- Test: it.fails replaced — Default landingAssist 0; air-only trim < 0.3°; fails if the assist ever lands nearer on
  every bar with mean gain > 1°. Page UI defaults (ui/pause.ts, ui/harness.ts) still say 0.5 — owners to change.

# T207 (coordinator priority) — player and rivals on ONE sea schedule; pilot trim reaches the drives
- Checked in the Working sea with a preset change mid-run (tests/speedboatSeaParity.test.ts): a rival (fleet driver → step
  core, own mirror) and the player (page wiring: `OceanSimulation.advanceSpectrum` → `CpuOcean` on the simulation's own
  scheduler → `createPlayerBoat`, render `OceanSimulation.update` every frame), same start pose and controls, 50 s.
  Physics fidelity, params (mirror/chop resolution, update cadence, inverse iterations, Smith depth), hull and step were
  already identical: with one render frame per tick the trajectories are bit-identical.
- ROOT CAUSE found: `OceanSimulation.update` stepped the spectrum schedule itself on any rendered frame that had no sim
  tick (> 60 Hz display, `holdSim`, a paused select screen), so the page adopted rebuilt spectra at frame-rate-dependent
  ticks while the worker's mirror steps once per tick. [M] 120 fps: first differing tick 1221 (1 s after the preset
  change), 334 m apart by the end, heave std player 1.30 vs rival 1.55 m, top speed 28.06 vs 28.10 m/s. It also broke
  §V2 for the page itself (a replay at another frame rate is another sea).
- Fix (src/ocean/oceanCascades.ts, 3 lines): once any tick has called `advanceSpectrum`, `update` never steps the schedule
  (`tickDriven`); render-only callers keep stepping it in `update`. After: bit-identical at 60 and 120 fps (heave/pitch/roll
  variance and top speed equal by construction). Side effect: a sea chosen while the sim is held (select/pause screens)
  swaps in on the first ticks after it resumes (≤ 41 ticks), on the page and on the worker alike.
- Not fixed here (stated): `tests/seaPhysics` §V.69 "pitch-kick improvement in the 98 m reference sea" (8.35 vs 6.72) and
  `tests/speedboatNpcSea` (rival pitch std 7.20 vs bound 6.34) fail identically without any T207 change (attribution copy).
- Pilot trim (AI agent's request): `stepCore` now passes `unitTrimToRad(po.trim ?? 0)` to `setControls`, the player's
  mapping. Consequence [M]: raceAiLaps rookie metric 0.109 vs bound 0.04 and raceAiPack 3 failures (a hook, lap band,
  catch-up spread) with it; without it raceAiLaps passes and raceAiPack fails only the catch-up spread (2.90 vs 2.74 s).
  The pilot's −waveLift bow-down requests (up to −6° drive trim) were never run through the physics — pilot owner.

# Seakeeping review, 2026-09-14 (trailer review: "water through the boat", "diving between waves", "toy-like")

Scratch (not in repo): `scratchpad/sk/phys/` (`sea.test.ts` page-step seakeeping harness, env `PRESET KN HEAD HEADREF SEED
SECS P OCEAN`; `rest.test.ts`, `drop.test.ts`), `scratchpad/sk/sea/` (`real.test.ts` realised Hs, `trim.test.ts` static/running
trim, `savfit.test.ts` Savitsky scan, `filt.test.ts` response vs wavelength). Presets and ride numbers: docs/speedboat/sea-presets.md.

## Measured, no change justified
- Flat-water natural periods heave/pitch/roll 2.33/2.42/3.42 s (ζ 0.32/0.30/0.03); mass 5351 kg; pitch/yaw/roll inertia
  52.1/51.8/3.6 t·m² (gyradii 0.260 L, 0.259 L, 0.359 B; the outboards' 4.56 m lever ≈ 19.5 t·m² of pitch); added mass
  at rest heave 3.55 m, pitch 2.75 I; at 25 m/s 1.37 m, 0.67 I.
- Landings (flat water, 1–2.5 m drops at 15–25 m/s): rebound ratio 0.10–0.14, no second flight, sink 0.09–0.18 m.
- A/B in breeze/Working sea (2 seeds, 50 kn): proxy flare +8°, 0.45 m sheer spring, addedMassCoeff 1.5, waterVelocity off,
  transomWake off, driveFoil off — none reduced bow stuffing (several worse). The stuffing, 40–49 % downwind airtime and
  the > 2 Hz chatter came from the sea: the old Working sea realised Hs 3.6–3.8 m (see the √2 root cause below) of short,
  steep wind sea.
- Static trim 2.14° stern down; transom keel 0.67 m, AV plate 0.49 m, prop 0.72 m under still water; LCG 31 % from the
  transom. Render pose = physics pose (browser: 2.14/2.14°, 3.06/3.06° at 20.4 m/s); GLB prop anchor body y −0.760 =
  physics prop point.
- Response vs regular head-sea wavelength at 30 m/s (a = min(0.15, λ/28) m): heave std 0.000/0.000/0.004/0.045/0.130/
  0.152 m at λ 2/4/8/16/32/64 m — the wetted-surface integration filters waves shorter than ~2× the wetted length.
  Caveat: a steep λ = 2 × patch spacing (1.6 m at 0.8 m) aliases in the 0.8 m patch (heave diverges at a 0.057 m);
  in the real sea the mirror's Smith factor e^(−k·0.54) is 0.12 there (0.015 at λ 0.8 m), and a 0.01 m wave shows
  nothing; patch 0.4 m removes it (T207 perf note: not adopted).
- Smith effect: `CpuOcean` pressure head attenuates every mode e^(−k·T), T = the deep-V's rest keel depth (0.54 m);
  orbital vertical velocity (`waterVelocity`) is ∂/∂t of that attenuated head; the 2D+t slam is V_n·dm_a/dt with the
  Wagner half-beam growing at (π/2)V/tanβ (force ∝ 1/tanβ, pressure ∝ 1/tan²β), deadrise warped to 45° forward. All
  four effects the user described are in the model; none was missing.

## Root cause found and fixed: the realised sea was √2 taller than its spectrum (all modes)
h0(k)e^{iωt} + conj(h0(−k))e^{−iωt} puts two independent Gaussians on each mode: realised variance 2× every moment the
spectrum books. `H0_AMPLITUDE_SCALE` = 1/√2 on h0 (src/ocean/oceanMath.ts). Swell-only 1.18 m spectrum: realised 1.69–1.73
→ 1.18–1.21 m. Tests re-derived to keep their intent: foam λ− constants ÷√2, hullContact sea target ×√2, §V.69 reference
forcing ×2 energy, shoaling Sk bound 20 → 30 % (measured −24 %), audio slam assertion on the entry slam.

## Running trim: Savitsky fit measured, NOT adopted
`garmeANon` 0.34 leaves equilibrium trim 0.48–0.87° under Savitsky (C_v 3.1–6.0); 0.9 fits within −0.17…+0.14° (player
hull 20/30 m/s 2.75/1.93 → 3.51/2.50°) but moves the manoeuvring envelope, crossing-swell hooks (2 → 4/16 at C_v 8), the AI
capability table, pack band and three crash scenarios (11 tests). Coordinator: keep 0.34, separate task. Drive trim
authority stays ≈ 0.1° (no surface-piercing prop vertical-force source in hand).

# §B126, 2026-09-16: two boats fired out of an `open` race at 460 and 1068 m/s

NOT the boat contact. `scripts/race-ai-sweep.mjs --course pack --seas open --seed-list 101` at t 18.45 s: boats 2 and 5
were 25.9 m apart, their contact report was empty, and the pair solver (`sea-physics/boatCollide.ts`) is a Catto
sequential impulse already bounded at V110 — 600 random contact configurations (head-on, glancing, overtaking, T-bone,
stacked/coincident, tests/boatCollide.test.ts) conserve the pair's momentum to round-off and its worst kinetic-energy
change is +0.11 %, the Baumgarte push-out's own budget.

## The chain, measured
1. Boat 0 capsized at t 18.05 s and planed inverted at 25 m/s, progressively driven under (up·y −0.96, |ω| 4.8 rad/s).
2. One substep of that hull returned `load.force[1]` = 5.6 GN — 100 000 × her weight. V110 caps the EXPLICIT flux loads
   (`capScale` 5.5e−5 there, doing its job); the velocity-level impulse terms (slam, crossflow, face drag, sway entry)
   are bounded against the RIGID BODY by construction (V103) but not in newtons, and `buildWakeLoad` was handed the
   whole `fY`.
3. `writeWakeSource`'s 1 s low-pass divides a spike by 60, so the wake record still carried Σfy = 9.3e7 N (1774 mg;
   an ordinary racing record is 0.7–4.8 mg).
4. `WakeField` is a STEADY Havelock pattern — η ∝ F — so it laid ±80 m of "wake" over its 300 m wedge.
5. The three boats inside the wedge read 30–55 m of water over their decks: displaced volume 42.8 m³ (hull ≈ 7),
   slam impulse 3.2e7 N·s, and they left the tick at 1067.9 and 461.0 m/s horizontal. The race never finished.

## Fix
`buildWakeLoad` bounds the load the wake is handed at the SAME V110 acceleration the explicit loads get,
`maxAccel·m` = 50 g × 5351 kg = 2.63 MN, with every cell scaled by that one factor: the pattern's centroid, second
moments and depth are exactly the unbounded load's, only the amplitude is physical. No new constant, no feel knob, one
place both threads go through (`hw.wake` → `writeWakeSource` on the worker and on the page, §V110/§V2). `netFy > 0` is
false for NaN, so a non-finite load now leaves no source instead of poisoning every receiver's height sampler.

## Numbers
- pack/open/seed 101: max boat speed 1501 → 33.1 m/s; max wake η at a hull 81 → 0.39 m; max wake source 9.3e7 → 2.5e5 N.
- The 12-seed `open` sweep at HEAD, before → after: every rival classified finished 11/12 → 12/12, pack spread max
  ∞ → 37.1 s (median 22.7 → 21.9 s), seed 101 hooks 402 → 8, scares 548 → 10, wall 101 → 24 s. NINE of the twelve seeds
  are bit-identical: the bound never bites in ordinary racing. The block still FAILs T213 on crash-free races (4/12,
  the same four seeds before and after) — that is the AI's seakeeping in a big sea, not this.
- Worst case with the bound in place ([M] tests/hullWater.test.ts): an emitter pinned AT the bound for 12 ticks gives a
  boat 25 m astern 3.1 m of wake elevation, 3.7 m/s of Δv per tick and 25.7 m/s — a sea state, not a launch.

## Known limit, reported
50 g is the V110 safety bound, not a wave-making one: a source pinned at it for a whole second is 12 × the biggest
record ordinary racing produces. Nothing in 12 seeds × 3 seas comes near it, and the measured receiver response above is
bounded, so no second (tuned) constant was introduced.
