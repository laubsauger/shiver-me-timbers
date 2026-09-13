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
