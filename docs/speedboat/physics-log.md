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
