# W2a: calibrating the wake source model (SPEC T175)

Status: CPU-verified. Browser/GPU checks are **PENDING** (§9); they were deferred because the GPU was pinned.
Date: 2026-09-13. Scope: `src/wake/*`, `tests/wake{Source,Calibration,Solver,Kelvin}.test.ts`. No in-game wiring.
Companions: `wake-research.md` (§3 source, §6 W2) and `w0-measurement.md` (§6 targets).

Legend: `[M]` means measured by a CPU tow in this repo. Scratch instruments live in
`scratchpad/w2a/` (`tow.ts` prototype, `readout.ts`, `hump.ts`, `mut.ts`). `[L]` means literature.

---

## 0. Decision

**Each sample is a pressure acting at its keel depth.** A sample with vertical force `fy` and depth
`d` forces the free surface with head `ĥ'(k) = e^(−|k|d)·ĥ(k)`. The drawn surface uses the same
filtered head, so static cancellation still holds. For buoyancy stations, `d` = station immersion ×
`smithDepthScale` (galleon 2.44 m, brigantine 2.07 m, raft 0.30 m).

- At k = 0 the factor is 1, so ∫ρg·h' dA = ΣF_y (V-W2) and V-W3 are untouched. Only wave-making
  content is attenuated.
- It is the **same kernel** buoyancy already feels the sea through (§V68 Smith, `pressureHeadAt`).
  By Haskind reciprocity, a body that feels waves through `e^(−kd)·Î(k)` radiates through the same
  function. A different wake kernel would make the hull's wave excitation and its wave radiation two
  inconsistent models.
- No authored wake constant exists. Amplitude, footprint and attenuation all come from the hull's own
  contact numbers.

## 1. The W1 problem, measured

The galleon runs at 7 m/s (Fn_L 0.375, L_wl 35.5 m, not the 38.5 m loft length) off her real 54
stations. The raw and column rows ran on 256² × 0.5 m (30 s tow); the keel row ran on the chosen
256² × 0.625 m tier (42 s tow). `[M]`

| source model | near-hull p2t | cusp slope | bow / stern crest | R_w/W | clamp |
|---|---|---|---|---|---|
| raw surface head (W1) | 5.96 m | 1.35 | 1.74 / 2.95 | 0.047 | hits |
| Michell column `(1−e^(−kd))/kd` | 3.24 m | 0.57 | 1.08 / 1.49 | 0.017 | 0 |
| **keel `e^(−kd)` (chosen), 160 m tier** | **1.56 m** | **0.223** | **0.56 / 0.61** | **0.0054** | **0** |
| W0 target | 0.83 to 2.0 | 0.14 to 0.40 | — | — | 0 |

### Why keel and not column

- **The surface-flux source is the pressure model.** A surface volume source q = −∂h/∂t with drawn
  η is algebraically the pressure-forced system with drawn η + h. So "thin-ship volume flux" adds
  nothing at the surface. Only the *vertical distribution* of the source differs.
- **Michell's column factor is the side-wall linearisation of a wall-sided box.** It is the flux
  through bow and stern faces spread over 0..d. The station model has no walls: it is a waterplane
  quadrature whose force is bottom pressure. V-W2 defines the wake as the reaction to the
  *vertical* force, and that force acts at depth d.
- **Column leaves linear validity.** It gives cusp slope 0.57, above the Stokes limit of 0.44.
- **Field data favour keel.** Kriebel & Seelig (2005) give gH/U² = β(F−0.1)²(y/L)^(−1/3), as
  reproduced in ERDC/CHL CHETN-IX-46 (2017) eq. 1–5, with Le = 0.4 L (EST). The table compares H at
  y = L/2 `[M]`:

  | speed | keel | column | Kriebel |
  |---|---|---|---|
  | 7 m/s | 1.06 m | 1.93 m | 0.52 m |
  | 8.5 m/s | 1.69 m | 2.32 m | 1.27 m |
  | 10 m/s | 2.68 m | 2.65 m | 2.65 m |

  - Keel is within 2× at 7 m/s and on the fit at 10 m/s.
  - Both models over-predict at 5 m/s (0.71 m against 0.10 m): the linear model keeps near-field
    height that the empirical (F−0.1)² law removes at low Fn. This is stated, not fixed.
- **Mutation** (`mut.ts`, depth scaled; galleon 7 m/s) `[M]`:

  | depth | p2t | cusp slope | R_w/W | calibration tests |
  |---|---|---|---|---|
  | ×0 | 5.38 m | 1.26 | 0.043 | fail |
  | ×0.5 | 2.67 m | 0.45 | 0.013 | fail |
  | **×1** | **1.60 m** | **0.232** | **0.0050** | **pass** |
  | ×2 | 0.80 m | 0.083 | 0.0010 | fail |

## 2. Numbers per preset

All presets run on their tier with automatic Δt and duration, measured by `measureWake` (§5).
Hs = 2.78 m. `[M]`

| preset | Fr_L | p2t (m) | bow / stern / shoulder (m) | cusp slope | H(L/2) vs Kriebel (m) | α_max vs R–M | R_w/W | clamp |
|---|---|---|---|---|---|---|---|---|
| galleon-5 | 0.268 | 0.98 | 0.39 / 0.52 / 0.42 | 0.194 | 0.71 vs 0.10 | 10.7°* vs 19.5° | 0.0029 | 0 |
| **galleon-7** | 0.375 | **1.56** | 0.56 / 0.61 / 0.33 | **0.223** | 1.06 vs 0.52 | 16.5° vs 19.5° | 0.0054 | 0 |
| galleon-10 | 0.536 | 2.06 | 0.72 / 0.24 / 0.57 | 0.288 | 2.68 vs 2.65 | 14.0° vs 19.0° | 0.040 | 0 |
| brigantine-7 | 0.406 | 1.78 | 0.51 / 0.87 / 0.33 | 0.213 | 1.09 vs 0.64 | 18.0° vs 19.5° | 0.0072 | 0 |
| raft-2 | 0.169 | 0.15 | 0.02 / 0.09 / 0.00 | 0.016 | 0.04 vs 0.00 | floor* vs 19.5° | ~0 | 0 |
| speedboat-40 (proxy) | 5.83 | 0.30 | 0.26 / 0.03 / 0.08 | 0.019 | — | 2.2° vs 1.96° (Darmon 2.2°) | 0.0022 | 0 |

- `*` means the divergent-envelope search sat at its floor (½·α_R–M), i.e. the pattern is
  transverse-dominated. Darmon et al. 2014 predict exactly that for small Fr.
- Raft peak / galleon-7 peak = 0.089 / 0.968 = **0.09** (target ≤ 0.15).
- Raft λ_T is measured within 10% of 2πU²/g = 2.56 m.
- **Hump** (`hump.ts`, R/(W·Fn²), 256² × 1 m, 256 m domain) `[M]`:

  | Fn | 0.25 | 0.30 | 0.35 | 0.40 | 0.45 | 0.50 | 0.55 | 0.60 | 0.70 |
  |---|---|---|---|---|---|---|---|---|---|
  | R/(W·Fn²) | 0.012 | 0.020 | 0.049 | 0.027 | 0.101 | 0.149 | 0.152 | 0.153 | 0.104 |

  This is the classic shape: a prismatic hump near 0.35, a hollow near 0.40, and a main hump from
  0.5 to 0.6 that falls by 0.7. A surface pressure (no depth) gives a rise ratio of only 2.0 against
  the keel model's 5.0 (test tier).

## 3. Source contract (V101)

```ts
HydroSample { x, z: number;   // world plan position (m)
              fy: number;     // vertical force this sample carried this tick (N, ≥ 0)
              footprint: number; // √A_plan / 2 (m)
              depth: number } // depth below the local surface at which fy acts (m, ≥ 0)
```

Producers live in `src/wake/stationSources.ts`:

- **`stationSamples(ship, seaParams, out?, head?)`** covers the galleon, brigantine and raft through
  `probeStations`:
  - immersion = clamp(head − y + draft, 0, draft + freeboard)
  - fy = K·immersion·weight·support
  - footprint = √(weight·K/ρg)/2
  - depth = immersion·smithDepthScale
  - Consequence: fy = ρg·depth·A per station, so depth cannot be tuned apart from force (tested).
- **`hullWaterSamples(wet)`** maps the speedboat contact's `WetTriangles` directly: centroid x/z,
  fy, sigma, and centroid depth clamped ≥ 0.
- **`planingPatchSamples`** is a pond-only proxy until a trimmed 6DOF speedboat pose exists.
  - It uses the Savitsky table in `docs/speedboat/tech-research.md` §2.4: 5842 kg, beam 2.618 m,
    wetted length 4.8 m, τ 1.4°.
  - Pressure is 0 at the transom and rises to the stagnation line.

### Conflicts and deviations, reported (not edited)

1. **`hullWater.ts`: `wet.fy` is signed.** A downward-facing wet triangle (deck lid, flare) has
   fy < 0. `WakeSourceBuffer` clamps it to 0, so ∫h > `load.force[1]` whenever such triangles exist.
   Upright running has none; a buried bow or an inverted landing does. The proposal is that
   hullWater emit per-plan-cell net samples, or that the splat accept signed fy.
   The test confirms Σfy = load ±1% upright.
2. **Dynamic lift depth.** hullWater's planing lift reaches the samples as an area share per strip.
   Its depth is the triangle centroid depth, which is right for bottom pressure.
3. **`stationSamples` re-derives buoyancy's private `immersedDepth`** (V77/V95 smell).
   - It reproduces only the **hydrostatic** part. The dampers need buoyancy's per-ship memory.
   - It reads `ship.quaternion` as given; buoyancy re-applies a stripped pitch.
   - At W2 wiring, `stepShipBuoyancy` should emit these samples from its own station loop.
   - Test: ΣF_y equals `stepShipBuoyancy`'s vertical force ±1% for all three hulls in a heaved,
     heeled and pitched pose.

## 4. Solver changes (W1 to W2a)

- **State is ζ = η + h' (the drawn surface), φ.**
  - Each step adds Δĥ' = Σ_b e^(−|k|d_b)(ĥ_b,new − ĥ_b,old) and then rotates (ζ̂, φ̂) freely.
  - DC: ζ̂'(0) = 0, the open sea, as before.
- **Two depth bins per step**, at the min and max sample depth. Each sample is split linearly
  (`splatBinWeight`). This is exact for any two-depth fleet. For a spread of depths it
  under-attenuates by ≤ (kΔd)²/8.
- **The old head is stored spatially**, in the GPU state texture (`rgba32f` = ζ, φ, h0, h1), and
  scrolls with the state. No spectral buffer and no scroll phase-shift are needed.
- **GPU twin** (`wakeSolverPasses.ts`):
  - The splat writes .r = total head and .g = deep-bin part, from a second instance attribute.
  - Pack packs (h0 + i·h1)_new and (h0 + i·h1)_old into the head texture.
  - Evolve separates the pairs with a mirrored `textureLoad` and applies e^(−|k|d) from 4 uniforms.
  - Post stores the new bins.
  - Dispatch count is unchanged at **35 in one group**.
- **CPU:** 3 transforms per step, 4 with slope. Old and new bins go through one difference
  transform when the depths are unchanged; a source-free step skips the head transform. The
  `wakeSolver.test.ts` runtime is back to 12.7 s alone, including one added test.
- **W1 bug fixed.** `energy()` was divided by N⁴ instead of N², so absolute joules were 1/N² too
  small. Ratios, and therefore every test, were unaffected. The fix is verified against
  ½ρg·a²/2·A to 1e-7.
- **New CPU diagnostic `waveResistance(dir)`** = ∫ρg·h'·∂η/∂s dA (Havelock), computed by Parseval.
  It is tested against the spatial integral to 1e-3.

## 5. Domain (open issue 3)

Galleon at 10 m/s, 60 s tow, compared against a 512² × 0.5 m (256 m) reference `[M]`:

| tier | p2t | cusp slope | H(L/2) | R_w/W |
|---|---|---|---|---|
| 256² × 0.5 (128 m) | **3.84 (+85%)** | 0.567 | 2.73 | 0.075 (+96%) |
| **256² × 0.625 (160 m)** | **2.12 (+2%)** | 0.274 | 2.63 | 0.042 (+10%) |
| 512² × 0.5 (256 m) ref | 2.07 | 0.308 | 2.32 | 0.038 |

- At 7 m/s, 128 m reads a slope 30% high (0.300 against 0.228). 160 m is within 5% at 5 and 7 m/s.
- The cause: at λ_T = 64 m = L_dom/2 the transverse train recirculates past a 19 m ramp that is
  narrower than λ.
- **Recommendation:** `WAKE_SHIP_TIER` = 256² × 0.625 m, with the law L_dom ≥ 2.4·λ_T(U_max).
  - Cost: Nyquist λ rises from 1.0 m to 1.25 m, which does not matter for the ship.
  - The raft keeps 256² × 0.5 m (λ_T 2.56 m).
- The bow-anchored `wakeAnchor` (W1) stays.

## 6. Bow crest vs stern wave (open issue 2)

- **Measured at 7 m/s** `[M]`:
  - bow crest 0.56 m at 2 m aft of the stem, alongside
  - stern crest 0.61 m about 8 m aft of the transom, on the centreline
  - shoulder crest 0.33 m, forward half, ≥ 1.25 half-beams off the track (clear of the silhouette)
  - The divergent bow wave carries cusp slope 0.22 ≥ 0.14, which is the W0 readability criterion.
  - At 10 m/s the bow dominates: 0.72 / 0.24 / 0.57.
- **What physics says for this bow.**
  - The station plan and the loft have a vertical-tangent elliptical entrance (`hullEnvelope`
    v^0.72), so 2α_E ≫ 25°.
  - Noblesse et al. 2008 (JFM 600:105, "Simple analytical relations for ship bow waves") find that
    bows with 2α_E > ~25° have **no steady bow wave below a critical speed**. At Fn 0.2 to 0.35 a
    bluff bow's wave is a breaking, unsteady pile-up. A linear solver cannot draw it, and nothing
    tuned into it should pretend to.
  - The stern wave matching the bow wave at Fn ≈ 0.35–0.45 is physical for the model's immersed,
    0.55-beam transom.
- **Source placement cannot fix it.**
  - Under V-W2, fy ≥ 0: extra pressure ahead of the stem makes a *depression*, not a crest.
  - A stagnation-pressure term is horizontal and outside the vertical-force contract.
- **Decision.**
  - Keep the emergent linear crest. It sits at the forward shoulder and reads through slope.
  - The bluff-bow pile-up belongs to W5 (breaking foam and spray from bow-crest slope plus
    `hullContact.cutwater`).
  - Revisit only if the follow-cam sync pass (§9) shows the shoulder crest failing to read.
  - The stern crest sits about 8 m aft of the transom, which is under or behind the shipped
    follow-cam frame (25 m astern, 17 m up, looking down 34°). **PENDING browser.**

## 7. Hull-length Kelvin law (open issue 4)

- **Galleon Fr_L** (L_wl 35.5 m): 5 m/s → 0.27, 7 → 0.375, 10 → 0.536.
  - Rabaud & Moisy 2013: Kelvin 19.47° up to Fr_c = √(3/4π) = 0.49, then 19.0° at 0.536. The
    galleon is effectively Kelvin across her range.
  - Measured α_max of the divergent envelope is 16.5° at 7 m/s and 14.0° at 10 m/s. The early
    Darmon 2014 amplitude-angle decline sets in before R–M's envelope narrows.
- **Brigantine:** 18.0° at Fr 0.41.
- **Speedboat proxy:** Fr_L 5.8 on a 4.8 m wetted length gives 2.2°, against R–M 1.96° and Darmon
  12.85°/Fr = 2.2°. The narrowing emerges from the small forcing, as W1 showed.

## 8. Tests (exit codes)

Command: `npx vitest run tests/wake*`, **exit 0**, 74 tests. `npx tsc --noEmit`, **exit 0**.

- **`tests/wakeCalibration.test.ts`** (6 tests):
  - galleon 7 m/s p2t ∈ [0.3·Hs, 2.0]
  - cusp slope ∈ [0.14, 0.40)
  - no clamp hits
  - V102 at rest: energy < 1e-4 of the moving wake 30 s after a 10 s lowering
  - raft/galleon peak ≤ 0.15
  - tier ≥ 2.4 λ_T(10 m/s)
- **`tests/wakeSource.test.ts`** (10 tests):
  - ΣF_y = buoyancy ±1%, splat ±1% (galleon, brigantine, raft)
  - fy = ρg·depth·A per station, depth = flat-calm immersion
  - hullWater samples = load ±1%
  - planing proxy weight and depth order
  - raft: no `speedScale`, strength = weight
  - raft λ_T ±10%
  - `waveResistance` Parseval = spatial
  - hump C(0.55) ≥ 3·C(0.35) and C(0.75) < 0.8·C(0.55)
- **`tests/wakeSolver.test.ts`** (21 tests): the W1 suite on the ζ state, plus static cancellation at
  source depth 2.4 m with two bins.
- **`tests/wakeKelvin.test.ts`** (4 tests): unchanged physics.
- **Mutations**, depth ×0 / ×0.5 / ×2 / solver attenuation removed, fail 3–4 tests each (§1).
- `wakeSea` and `wakeFinish` are the analytic flowfoam suites, not touched, and pass.

## 9. Browser checks: PENDING (deferred, GPU pinned)

Run all in one pass. Use your own dev server (`npm run dev -- --port 5219`), your own tab, and the
sink `node scratchpad/wake-sink.mjs`.

1. **CPU↔GPU agreement.** Open `http://localhost:5219/src/wake/preview.html?preset=galleon-7`.
   - In the console run `await __wakePond.compare(600)` and expect `relMaxDiffVis` < 1e-3 and
     `nonFinite` 0.
   - Repeat for `?preset=raft-2` and `?mode=kelvin&fr=0.45`. The W1 surface path must still agree.
   - First-run risks: the mirrored `textureLoad` in evolve, the `.g` channel of the head RT, and the
     second instanced attribute.
2. **Readouts match the CPU.** For each of `__wakePond.presets`:
   - Run `__wakePond.preset(name)`, wait for sim t ≥ 1.4·L_dom/U + 10 s, then
     `await __wakePond.readout()`.
   - Compare against §2 (±10%; the GPU runs on the frame clock).
   - `__wakePond.readoutCpu(name)` prints the CPU numbers and R_w/W.
3. **Visual.** Capture one image per preset (`__wakePond.capture('w2a-<preset>.png')`). Look for:
   - a V wedge whose R–M lines hug the cusps (galleon, brigantine)
   - a thin 2° V on the speedboat
   - cm ripples on the raft
   - no ringing at the domain edge at galleon-10
4. **Timing.** `__wakePond.timing()` at galleon-7: the compute group must stay ≤ 1.0 ms. The
   ζ-state evolve adds 4 `exp` and 1 `textureLoad` per texel.
5. **In game** (after wiring, not W2a): shipped follow cam, swell preset with
   `weatherParams.cellIntensity = 0`, galleon at 7 m/s. Check that the shoulder crest and cusp
   shading read beside and aft of the hull, and that the stern crest is off-frame (§6).

## 10. Open items

- The low-Fn height excess against Kriebel (5 m/s) is linear near-field, not tuned away.
- The station adapter is hydrostatic only. Samples should be emitted by `stepShipBuoyancy` at W2
  wiring (§3.3).
- hullWater signed fy (§3.1).
- The two-bin approximation for continuous depth spreads (speedboat triangles) is ≤ (kΔd)²/8. It
  is not measured on a real hullWater tow.
- `WAKE_SHIP_TIER` (160 m) is a recommendation. The in-game tier choice belongs to the wiring owner.
