# W5c: the speedboat's wake tier (SPEC T181 hook 6)

Status: code + CPU tests green; browser PENDING. Date: 2026-09-13.
Code: `src/wake/wakeCalibration.ts` (`wakeTierForSpeed`, `wakeReachAstern`, `WAKE_SPEEDBOAT_TIER`,
`havelockArmAngleDeg`). Test: `tests/wakeSpeedboatTier.test.ts`. `[M]` = measured in this repo.

## 1. Why the ship tier is wrong at 40 m/s

- `WAKE_SHIP_TIER` (256² × 0.625 m = 160 m) follows W2a's transverse law L_dom ≥ 2.4·λ_T, measured on the galleon at
  ≤ 10 m/s. At 40 m/s λ_T = 2πU²/g = 1025 m: the law would need 2.5 km. 512² costs 1.4–3.3 ms GPU (wake-research §2.4),
  so no affordable grid meets it.
- It is also the wrong law. A 12 m hull at Fr_L = 3.7 is divergent-dominated (Fr_c = 0.49): the wake is two narrow arms.
  On 160 m those arms end **109 m** astern of the stem `[M]`.

## 2. What the arms are made of (Havelock far field)

- Stationary waves at propagation angle θ have k = g/(U²cos²θ). Stationary phase of Havelock's integral puts their
  amplitude k²|P̂(k cosθ, k sinθ)|/√(r|G''|) on the ray tan α = tanθ/(1 + 2tan²θ) ≈ c_g(k)/U. The arm is the α of the
  maximum (`havelockArmAngleDeg`). Check: one Gaussian reproduces Darmon et al.'s 12.85°/Fr_b from above.
- For the contact at 40 m/s (22 plan-column samples over 7.8 m, footprints 0.12–0.34 m, 3 jets) the UNFILTERED forcing
  keeps rising to λ ≈ 2 m (α 1.25°) `[M]`. That peak comes from the samples' spacing, not from the hull, so it is
  not a target. Rabaud & Moisy's hull-length law, fitted to real wakes, gives **3.10°** for L = 12 m (dominant λ ≈ L).
- The solver draws the forcing band-limited by its own texel (splat σ ≥ √2·texel, §V48). So the texel sets the dominant
  divergent wave: Havelock arm vs texel `[M]`: 0.625 m → 2.07° (λ* 5.4 m), 1.0 → 2.57°, 1.5 → 3.12° (12 m),
  1.75 → **3.37° (14 m)**, 2.5 → 4.01°, 3.0 → 4.40°.
- Those waves travel at c_g ≈ 2–3 m/s, so what the domain must hold is **length astern**, not λ_T.

## 3. The rule

```
reach astern of the stem = 2(0.5 − w)·n·texel − 4√2·texel     (w = 0.15 sponge, clearance = 4·splatSigma, wakeAnchor)
texel = ceil₁/₈( reach / (2(0.5 − w)·n − 4√2) ),  n = 256        when 2.4·λ_T(U_max) > 160 m (U > ~8.2 m/s)
```

- Reach 300 m (the low end of the 300–500 m visual range) ⇒ **256² × 1.75 m = 448 m, 303.7 m astern**.
- The resolution cost is bounded: the tier's arm is +8.7% (Havelock) / +14.6% (solver) of the R–M angle.
  500 m would need 2.9 m texels ⇒ ≈ 4.4°, +42%.
- **GPU:** the same 256² grid and 35 dispatches as the ship tier (2.4 M invocations, 0.3–0.8 ms `[C]`), one compute group.
  Texel size costs nothing on the GPU.
- **Rejected:**
  - A near/far pair of 256² solvers: 2× the cost (0.6–1.6 ms), and it needs a merged dispatch array in `WakeSolverGpu`.
  - 512²: 1.4–3.3 ms.
  - The flowfoam far tier "carrying the arms": it carries sim FOAM, not the wave surface, so no arms would be drawn past
    the sim domain.

## 4. Measured on the pond preset (`speedboat-40` = SpeedboatTow contact, CPU solver, 25.7 s tow) `[M]`

| | 160 m ship tier | **448 m speedboat tier** |
|---|---|---|
| arm α, solver / Havelock (tier band) | 1.80° / 2.07° | **3.55° / 3.37°** (R–M 3.10°) |
| reach astern | 109 m | **304 m** |
| energy ahead of stem +5 m / wedge | 2.8e-5 | **5.7e-5** (1.25e-3 with the moving-domain sponge scaling off) |
| energy outside 35° wedge / wedge | — | 1.3e-3 |
| arm √r·\|ζ\| at 250–300 m / at 50–100 m | (outside domain) | 1.31 |
| max \|ζ\|, clamp hits | 0.335 m, 0 | 0.097 m, 0 |

- **Mutations** (restored from byte copies, sha256 verified):
  - tier back to 160 m: 5 tests fail;
  - sponge domain-speed scale off: 1 fails (the wrap bound is 2.5e-4; the galleon's 5e-3 would have passed it);
  - Havelock prediction without the splat band limit: 2 fail.

## 5. Costs and pending

- **Near-hull resolution drops.** Sim Nyquist goes 1.25 → 3.5 m, the forcing band limit halves amplitude at
  λ ≈ 14 m, and the ambient breaking band (`ambientLambdaMin` = 2 texels) starts at 3.5 m. Short bow-wave detail next to
  the hull now comes from foam and spray, not the sim surface.
- **Far-tier sub-sampling.** S = ⌈2.5/1.75⌉ = 2 (4 taps, was 16).
- **Browser PENDING:** GPU ms at `?preset=speedboat-40`, `compare(240)` CPU↔GPU, and the look of the arms from the chase cam.
