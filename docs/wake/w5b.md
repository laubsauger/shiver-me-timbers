# W5b: closing W5's open list, plus the browser-sync wake/foam defects (SPEC T180)

Status: code + CPU/codegen tests green; browser pass §7. Date: 2026-09-13.
SPEC: §T.180 (and §T.59, §T.70), V100, V10, V40, V48, V77, V80, V22, V28, V101–V105.
Companions: `w5-foam.md` (the model this extends), `w2a-source-model.md`, `wake-research.md` §3.4 / §5.4,
`docs/browser-sync-2026-09-13.md` §4–6.

Legend: `[M]` measured in this repo. Scratch instruments (gitignored): `tests/zzScratchW5bPond.test.ts` (wrap
energy), `tests/zzScratchW5bBoat.test.ts` (contact tow), `tests/zzScratchW5bEncode.test.ts`,
`tests/zzScratchW5Fingerprint.test.ts` (pirate hashes). Permanent: `tests/wakeW5b.test.ts`.

---

## 1. (a) Breaking sees the ambient sea, as an increment

`simFoam.ts simFoamRate`:

```
ΔB = max(0, E[B(|∇η_wake + ∇η_amb|)] − E[B(|∇η_amb|)])      B(s) = smoothstep(0.30, 0.44, s)
```

- **Why a sum of slopes.** For deep-water modes the downward accelerations at a crest add as g·Σkᵢaᵢ, so the
  summed slope is the same Stokes/acceleration criterion W5 used, now for wake + sea.
- **Band limit.** The flowfoam compute cannot see the drawn sea's phase (no cascade binding there, and wiring one
  needs `seaScene.ts`). The ambient slope therefore enters as a statistic: an isotropic Gaussian with per-axis
  σ = √(v/2), where v is the ocean's slope variance at λ ≥ 2 sim texels, read from each cascade's published
  histogram (`bandSlopeVariance`, bisection on `slopeFootprint`). Shorter ambient waves are not resolvable in the
  sim's band and their breaking is src/foam's.
- **No double count.** Subtracting E[B(|∇η_amb|)] makes the injection exactly 0 wherever the wake adds no slope,
  whatever the sea. σ = 0 reproduces W5 bit for bit (the rule is exact there).
- **E[·]** is a 5 × 3 Gauss–Hermite rule aligned with the wake slope (10 smoothsteps). `[M]` against 4·10⁵ Monte
  Carlo draws: worst error 0.005 at σ ≤ 0.05, 0.039 at σ ≤ 0.1, 0.050 at σ = 0.15. The two shortcuts (ignore
  the sea; B(√(s² + 2σ²))) are out by 0.31 at σ = 0.1. GH 9 × 5 halves the σ 0.15 error for 2.7× the cost; not
  taken.
- **Wiring.** `flowFoam.setAmbientSea(ocean.cascades)` (cached on the cascades' totals, allocation-free), called
  from `raftFrame.tickSea`. Uniforms σ and E[B(σ)] are computed by the CPU instance of the same function.
- Example `[M]`: a sub-onset wake crest of slope 0.25 injects 0 on glass and ΔB > 0.02 of `simBreakRate` in a
  σ = 0.1 sea.

## 2. (b) The far tier box-filters the sim; defect 1 (hard, blotchy lane)

**Cause, two parts.**

1. *Far tier (≳ 36 m from the region centre, the top of `w5-A-sim-3.7ms-overhead-lane.jpg`).* One bilinear tap
   per 2.5 m far texel on a 0.5 m sim: a feature narrower than a far texel is injected only when a texel centre
   lands on it. The far blur is ≈ 0 at that texel (w ≈ 0.003/step), so nothing smooths it; the material then
   bilinearly magnifies 2.5 m blocks and the dissolve cuts a contour through them — polygonal blots that shift as
   the region scrolls.
2. *Near tier.* The 2 m/s lane dose (0.49, W5 §1) and the 3.7 m/s dose (lift 1 ⇒ ≈ 0.72) sit ABOVE the dissolve
   gate's top (0.005 + 0.22): the lane is a solid slab and the only structure left is its outline, drawn by the
   2 px knee (softness 0.025 in coverage against a lateral gradient of ≈ 0.18 /m ⇒ ≈ 0.1 m). Not a kernel
   threshold (the injection is a continuous product), not quantisation (16F head resolves µm), and advection/blur
   run on the sim path as on the analytic one (blur diffusivity 0.58 m²/s; it saturates below ~21 fps, which the
   contended browser pass hit — stated, not changed).

**Fixes.**

- (b) `rateNode(worldXZ, tierTexel)` averages the RATE over S × S stratified sub-samples across the tier texel,
  S = ⌈tierTexel/simTexel⌉ = 5 (raft tier), 4 (ship tier), 1 (near tier). The rate, not its inputs, because
  breaking and bury/emerge are non-linear. A dynamic `If` skips all far texels outside the sim domain (≈ 2.6 k of
  65 k on the raft tier), so the cost is ≈ 25 sample evaluations × 2.6 k texels. `[M]` far WGSL: one
  `for (i < 25)` loop (raft), `i < 16` (ship); near: none.
  - Test `[M]`: Σ over a row of far texels of a band-limited breaking crest, over 11 sub-texel offsets:
    spread (max−min)/mean **0.067** filtered vs **2.84** point-sampled; filtered total within 10% of the fine
    integral.
- (d, §4) aged wake foam retires the dissolve to its sub-pixel average (a soft ramp of width erode + knee), so the
  lane's aged outline is no longer a 2 px contour. Fresh churn keeps the torn gate.
- NOT changed: the near dose calibration. Solid white right behind a hull working at 3.7 m/s is physical; the lane
  decays into the gate's middle by ~10–20 m astern (half-life 5 s).

## 3. (c) Prop wash, wired

One `PropWashInput` per prop per tick (`src/wake/propWash.ts`), read off the drive model:
`propWashFromHullWater(hw, state, out)` (`src/wake/propWashHullWater.ts`, its own module so pages without a
speedboat do not import the contact model).

| consumer | model | where |
|---|---|---|
| sim source | jet surfaces at s = (d − r)/0.1 aft; vertical momentum flux 0.1·T pushed UP ⇒ signed jet head fy = −0.1·T, footprint max(r, d), depth d | `propJetSample`, `WakeSourceBuffer.pushJet`, splat `.b` |
| foam | actuator disc ΔV = √(U² + 2T/ρA) − U; ribbon half-width r + 0.1·s, core 6 D; rate lift(ΔV, d)·ΔV_c/b, width floored at the tier texel | `simFoam.jetFoamRate`, `createFlowFoam({ propJets })` |
| spray | exposure 4·imm·(1 − imm); flux e·ΔV·A; rate bowLiftRate·flux; launch ΔV aft + ΔV up ⇒ apex ≤ ΔV²/2g | `src/foam/roosterTail.ts` |

- **No authored coefficient.** The research plan's C_pw is replaced by the jet spread slope (0.1, Pope 2000) and
  the potential core (6 D, Rajaratnam 1976). The sim-source magnitude is order-of-magnitude, stated as such.
- **Jets are not hull.** They go in a separate list and a separate head channel (splat `.b`); sim churn reads
  `head.r − head.b`, so a jet splat changes no hull churn `[M]` (test to 1e-9), and `hullDepthMax` (the churn's D)
  ignores jets. The solver's depth bins include them (their attenuation is physical).
- **Limits, stated.** A jet held at rest is cancelled by §V102 like every steady source (drawn = η + h): the dock
  boil shows as foam, not as a mound. HullWater publishes total thrust and per-drive immersion only, so the
  adapter re-places props and splits thrust by the drive curve's weight (§V101 residue). Hook that retires it:
  publish `driveThrust[k]` and `propWorld[k·3]` in `hullWater.ts evaluateDrives` where `T` and `R` are computed
  (thrust block). The rooster tail is not on any page (no sea page carries the speedboat); the hook is in its
  header.
- **Pond.** `speedboat-40` is now `SpeedboatTow`: `HullWater` on `stepRigid6`, towed in surge, free in
  heave/pitch/roll, props from the drive model. `[M]` 40 m/s flat sea: settles by 4 s at trim 1.63°, heave
  +0.688 m, Σ wake fy/W = 1.00, three drives 4.6 kN each at 0.43 m depth, immersion 1.0 ⇒ ΔV 0.89 m/s,
  lift 0.09, no rooster tail (fully immersed props throw none). 20 m/s: trim 2.8°, 9.2 kN/drive; 10 m/s: 6.3°,
  15.4 kN/drive.

## 4. (d) Wake foam age vs whitecaps (§T.59)

- **The age is already in the texture.** The sim injects slick = k·foam, and the two channels decay on different
  clocks (near 5 s / 50 s, far 12 s / 50 s). For a dose laid a seconds ago, f = foam·k/slick = 2^(−a(1/T_f − 1/T_s)),
  so the stage-A weight e^(−a/τ_A) = f^e with e = 1/(ln2·τ_A·(1/T_f − 1/T_s)) = 15.1 (near), 43.0 (far).
  τ_A = 0.53 s is Monahan & Lu (1990)'s active whitecap stage. Waterline-capture foam carries no slick and reads
  fresh, which it is.
- **Material** (`surfaceMaterial.ts`, sim backend only): fresh wake whitewater takes the whitecap colour and alpha
  law; the aged lane keeps the wake material (colour #b9ccc4, optical depth) and passes the age to
  `foamDetailMask(…, detailRetire)`, which multiplies the dissolve's `resolved` — aged foam is drawn as the torn
  gate's own average. No new authored look numbers.
- **No new binding.** `wakeFoamFreshnessNode` samples the same acc/far foam textures; `oceanBindingBudget`'s
  flowfoam ledger went 4 → 5 call sites, 2/2 fragment bindings unchanged (recounted in the same change).
- **Pirate.** `wakeFoamFreshnessNode` is `null` on the analytic backend, so the material builds the pre-W5b graph
  node for node. `foamDetailMask` without the new argument is the same graph. Proof: §6 hashes.
- `tests/wakeBackend.test.ts` §2 re-cut (V80): it pinned "ocean WGSL byte-identical in both backends", a decision
  (d) moves. Property now: equal per-stage texture and sampler counts, no solver texture bound, the age term
  sim-only (analytic node null; sim WGSL differs).

## 5. (e) §T.70 hull burial feeds churn

- `flowFoam.setHullBurial(vessel.hullContact)` right after `hullContact.update` in `raftFrame.tickSea`: a
  least-squares plane of the stations' `rate[]` over world XZ (heave + pitch + roll), and ℓ = A_wp/P of her
  outline. Churn uses ∂h_P/∂t ≈ −u·∇h_P + w(x,z)·ℓ·|∇h_P|/D, so ∫ vertical dA = w·A_wp·(h/D): the volume flux her
  waterplane pushes out, at the rim. Lift uses √(U² + w_rms²).
- `[M]` raft at rest, uniform burial 0.2 m/s: ∫ churn dA / (churnRate·w·A_wp·(h_peak/D)/D) = **1.07** (ℓ = 1.86 m, A_wp 48.8 m²); burial 0
  ⇒ exactly 0 (V102 kept); emerging water churns at `simSternChurn` × the burying rate.
- Physics consequence, stated: slow lapping lifts little whitewater (lift(0.3 m/s, 0.3 m) = 1.5%). Lapping
  foam becomes visible when the slap is a slam.

## 6. Defects 2–4 and the raft wake note

**2. Bow at 2 m/s.** Physics: a 15 t raft at 2 m/s has stagnation head U²/2g = 0.20 m. Water meeting the bow can
climb that high and leaves the stagnation region at ≤ U, so no airborne sheet exists at this speed. What should read
is a low pile-up skirt at the stem (≤ 0.2 m) and white water on the surface at the bow rim (the sim bury churn).
The contact model's launch used the galleon ramp's `bowRise` 0.35: apex (2 · 0.35 · sheet)²/2g ≈ 1 cm at
sheet 0.63, i.e. "a few droplets". The contact mode now launches at the Bernoulli bound `BOW_CONTACT_RISE` = 1:
apex ≤ U²/2g, `[M]` top 0.081 m of 0.204 m at 2 m/s (uniform value only; bow WGSL unchanged). Rate is unchanged
(185/s). No sheet is faked; the slam term is untouched.

**3. Waves ahead of the bow (pond galleon-7/10 corners).** Root cause: the sponge was sized for energy crossing a
STATIONARY ramp at c_g(L/4) (≈ 4 m/s on 160 m), but the domain scrolls with the hull, so wake energy crosses the aft
ramp at up to c_g + U. At 10 m/s the crossing time fell 3.5× and ~16% of the energy (40% amplitude) survived exit +
entry ramps, wrapped through the periodic FFT edges and was scrolled aft into the bow's corners. Not anchor placement,
not the 160 m domain (the pond runs the preset tier). Fix: γ per axis × (c_g + |v_axis|)/c_g, where v is the domain's
own velocity (`WakeSim.tick` measures the unsnapped anchor's motion; the pond and `towPreset` pass the tow speed). 1 at
rest ⇒ every stationary sponge test and V103 hold. `[M]` galleon-10 on 160 m:

| | before | after |
|---|---|---|
| energy ahead of stem +5 m (incl. sponge) / wedge | 2.01e-2 | 1.07e-3 |
| energy outside 35° wedge, interior / wedge | 3.64e-2 | 7.78e-3 |
| max \|ζ\| outside the wedge | 0.44 m | 0.23 m |

Test bound: ahead / wedge < 5e-3. The W2a calibration suite still passes on the stronger sponge.

**4. Pond CPU encode.** `[M]` in node the pond's non-GPU per-frame work (samples, anchor, buffer) is 4–6 µs; the
0.33–0.99 ms is inside three's `render` + `compute(35)`. Found and fixed: the splat cleared its target with
`renderer.clear()`, which in three r180 is its own command encoder + `queue.submit`; it now clears in the splat's
own pass (autoClear on for that render, restored). Instrumented: `__wakePond.encode()` / HUD give min-of-60
scenario / sources / splat / compute, and `__wakePond.setMergeClear(bool)` A/Bs the fix. Browser numbers §7.

**Raft wake at 2 m/s is ≈ 9 cm peak** (pond raft-2 maxAbs 0.094 m, p2t 0.155 m) and does not read from the follow
cam. That is the physics (Fr_L 0.17, λ_T 2.6 m on a 12 m plan); it is expected, not a defect, and was not inflated.

## 7. Browser pass (own server :5233, own tab; storm cells not reached — see below)

**Pond** (`preview.html`, runs in a hidden tab through its worker pump):
- galleon-10 at t 77 s: the corners ahead of the stem are clean; only faint slivers remain inside the front sponge
  (`scratchpad/w5b/after-pond-galleon-10.jpg`; before: `browser-sync/pond-galleon-10.jpg`).
- speedboat-40 is now the contact tow + jets: a narrow V, CPU↔GPU `compare(240)` max|Δη_vis| 0.38%, head 0.35%,
  0 non-finite (`after-pond-speedboat-40-contact.jpg`). A t = 0 crash (`SpeedboatTow.jets` before the first tick)
  was found here, fixed and tested.
- CPU encode, galleon-10, min-of-60 per 3.5 s leg, 6 interleaved legs:

  | clear | splat | total (min) | total (median) |
  |---|---|---|---|
  | merged (new) | 0.160–0.170 ms | 0.340–0.355 ms | 0.53–0.59 ms |
  | separate (old) | 0.180–0.200 ms | 0.360–0.385 ms | 0.66–0.81 ms |

  The phases are scenario 0.025, sources 0.010, splat 0.16 and compute(35) 0.125 ms. The merge saves 0.02 ms min
  and ≈ 0.13 ms median. **The 0.2 ms budget is still missed** (0.34 ms min): what remains is three r180's `render()`
  path for one instanced draw (0.16 ms) and its per-node bind/update loop for 35 dispatches (0.125 ms). Neither can
  be fixed in src/wake without replacing three's compute submission. Speedboat-40's scenario is 0.35 ms, which is
  the HullWater tow itself (2 rigid-6 substeps), a pond-only cost.

**Raft page: NOT RUN.** The MCP Chrome window reported `document.hidden` (0 rAF frames; the sim clock did not
advance in 4 s) through a click and a fresh tab group. The raft loop has no hidden-tab pump, so the lane edges, the
2 m/s bow, whitecap vs wake foam and the galleon look could not be captured. **PENDING**, same setup as w5 §6, with the
window visible.

## 8. Hashes, tests, mutations

**Pirate bit-identity `[M]`** (`zzScratchW5Fingerprint`, before any W5b edit and after):

| | before | after |
|---|---|---|
| bow spray WGSL | `3a7b389d…2b24` | `3a7b389d…2b24` |
| ocean material WGSL (118 538 B) | `4da186d2…ca34` | `4da186d2…ca34` |
| flowfoam compute WGSL (analytic, 4 passes) | `cebaea3a…70e5` | `cebaea3a…70e5` |
| analytic CPU mirror | `1cdd6dac…cbbc` | `1cdd6dac…cbbc` |

The pirate sea is byte-identical, so the (d) age term is provably neutral on the analytic backend: its node is not
built there. `tests/wakeFoamSim.test.ts` §5 (the FNV pin) passes unchanged.

**Gates.** `npx tsc --noEmit` exit 0. Full `npx vitest run`: exit 1, 3522 passed, 38 skipped (the gated
`zzScratch*` files), 2 failed. Both failures are timing budgets under a load average above 100:
`tests/terrainQuickWins.test.ts` (known flaky) and `tests/terrainInfo.test.ts` "bakes a 256² island in ≤ 40 ms".
Neither is in this area. After the final fix, the affected suites (wake*, oceanBindingBudget, bandLimitAudit, foam,
spray, flowfoam, raftSeaMirror, raftEntry) are 407/407, exit 0.

**`tests/wakeW5b.test.ts`** (27 tests): a ×5, b ×2, c ×7, d ×3, e ×4, defect 2 ×2, defect 3 ×3, defect 4 ×1,
V77 ×1. `wakeBackend` §2 is re-cut (§4). `oceanBindingBudget` has the recount.

**Mutations `[M]`** (scratch runner: byte-copy backup, then restore and sha256 verify; every file verified
restored):

| # | mutation | failing tests |
|---|---|---|
| M1 | breaking ignores ambient σ | 2 |
| M2 | no ambient subtraction (double count) | 2 |
| M3 | far tier point-samples (S = 1) | 2 |
| M4 | jet head missing from the jet channel | 1 |
| M5 | churn reads total head (jets counted as hull) | 1 |
| M6 | jet pushes down | 1 |
| M7 | rooster exposure = immersion | 1 |
| M8 | age exponent without ln2 | 1 |
| M9 | material ignores age in the dissolve | 1 |
| M10 | no vertical burial term | 1 |
| M11 | raft does not feed burial | 1 |
| M12 | lift ignores vertical speed | 1 |
| M13 | contact bow keeps the legacy rise | 1 |
| M14 | sponge ignores domain speed | 2 |
| M15 | clear split back out | 1 |
| M16 | tick never passes the solver its velocity | 1 |
| M17 | GPU far loop dropped | 1 |
| M18 | far sub-sample offsets not spread | 1 |
| M19 | jet ribbon not floored at the tier texel | SURVIVED, then closed by a peak ≤ integral/(√2π·texel) test: 1 |
| M20 | GPU far offsets collapsed | SURVIVED (the GPU-only expression), then closed by sharing `boxOffsetOf` CPU/TSL (V77): 1 |

## 9. Deviations, hooks, leftovers

- **Files outside the listed ownership, edited:** `tests/oceanBindingBudget.test.ts` (ledger recount 4 → 5 sites,
  required in the same change by V40), `src/foam/foamShading.ts` + `src/foam/sprayMath.ts` + `src/foam/bowSpray.ts`
  (src/foam/*), `src/wake/*` new files (`propWash.ts`, `propWashHullWater.ts`, `speedboatTow.ts`),
  `tests/wakeBackend.test.ts` §2 re-cut.
- **raftFrame:** two hook lines after `hullContact.update` (burial + ambient sea). The ambient-sea call is not a
  churn line strictly; it lives beside it so the tick feeds flowfoam in one place.
- **Not touched:** src/sea-physics/*, src/sim-worker/*, src/speedboat/*, main.ts, loop.ts, postPipeline.ts,
  params/post.ts, cine, grade, package.json, .gitignore, SPEC.md, seaScene.ts.
- **Hooks for other owners:** `hullWater.ts evaluateDrives` publish per-drive thrust and prop world position;
  a speedboat sea page: `createFlowFoam({ wakeBackend: 'sim', propJets: 3 })`, per tick
  `propWashFromHullWater` → `wakeSim.tick(pose, hullWaterSamples(hw.wake), stem, dt, jets)` +
  `flowFoam.setPropWash(jets)`, render `roosterTail.update(renderer, jets)`.
- **Leftovers:** the drawn ambient PHASE in breaking (needs cascade bindings in the flowfoam compute via
  seaScene); GH accuracy at σ ≥ 0.15; a non-cancelled jet boil at rest; anisotropic ambient slope (downwind
  variance > crosswind); the pond's 35-dispatch CPU cost (§7).
