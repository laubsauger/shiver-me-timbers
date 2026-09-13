# Hull-sampled GPU wake — research + design

Status: RESEARCH, no production code. Owner of this doc: wake research agent, 2026-09-13.
Scope: one shared, hull-derived, dispersive wake for pirate (`src/main.ts`), raft (`src/main-raft.ts`)
and the planned speedboat race mode. Everything below cites repo `file:line` as of `3403b8e` + working
tree, and external sources by URL. `[M]` = measured, `[C]` = computed/estimated from measurements,
`[D]` = derived here (no source), `UNVERIFIED` = could not confirm in a primary source.

---

## 0. TL;DR

- **Solver: pressure-forced eWave** (Tessendorf 2014 exponential integrator, deep-water ω=√(g|k|)),
  spatial-domain state (η, φ) with one forward and one inverse FFT per step. It reuses our TSL butterfly
  FFT (`src/ocean/fftPasses.ts:32-90`). It has exact dispersion (so the Kelvin angle emerges) and no CFL
  limit (step rate is a quality knob). It also has a spatial sponge, texel-snapped scroll, and a
  256² × 0.5 m near tier. Jeschke & Wojtan 2023 ship this same integrator, with boat wakes, at 512².
- **Source: a contact pressure field.** Each vessel's hydro contact module emits `HydroSample`s
  (plan position, vertical force, footprint). The same samples drive its rigid-body force and the wake,
  so ∫P dA = ΣF_y (Newton 3). Galleon and raft reuse buoyancy's 18×3 quadrature stations. The speedboat
  gets Kerner triangle clipping. Airborne means no samples. Slam, dredging, heel and trim all emerge.
- **Drawn/floated surface = η + P/(ρg)** ("static cancellation"). A vessel at anchor makes no wake and
  floats exactly as with the sim off. Under way, the residual is the wave-making field (bow crest, squat).
- **Coupling: one-way until the speedboat.** Then a CPU-authoritative low band (128² over 256 m) runs
  in the tick. The GPU draws the uploaded CPU band and adds a visual-only high band. GPU→CPU readback
  is rejected: it is nondeterministic (§C, V2).
- **Rendering: +1 vertex sampler, +0 fragment samplers.** The near band writes into the existing
  `elevTexture` and `foamTexture.ba`. The coarse-band gradient reaches the fragment stage as a `varying`.
- **T161(b)'s grid hypothesis is wrong.** Vertex spacing at 35 m is **1.22 m**, not 5.3 m
  (k = 0.0205, not 0.136). The mesh can carry a 3–5 m mound. The cause lies elsewhere; see W0.

---

## 1. Verified current state (and corrections)

| Claim in brief | Verdict | Evidence |
|---|---|---|
| Analytic Kelvin: 48-sample track, TSL twin, CPU `elevationCpu` | ✔ | `wakeTrack.ts:45` `TRACK_CAPACITY=48`; per-texel `Loop(TRACK_SEGMENTS)` `wakeInjection.ts:241`; `elevationCpu` `wakeInjection.ts:579` |
| Near 512²/120 m, far 256²/640 m | ✔ (comment stale) | `params/flowfoam.ts:417-430`; `accumulation.ts:81-83` still says "~460 m" |
| R foam, G slick, BA Kelvin slope; elevTexture RGBA16F ±2 m | ✔ | `accumulation.ts:21-47,159-168,333-354` |
| Single vessel, `setShip(pos,yaw,speed,bow,stern,beam)` | ✔ | `index.ts:256`; callers `main.ts:1168-1176`, `raftFrame.ts:99-103` (duplicated wiring, V95 smell) |
| Enemy brigantine has no wake | ✔ but… | …she **floats on the player's wake**: `cpuOcean.setWakeField(flowFoam)` `main.ts:648`, her buoyancy `main.ts:1228` |
| Ocean displaces by `wakeHeightNode` | ✔ | `surfaceMaterial.ts:791-793`; fragment `wakeSmoothNode` `:879`, `wakeSlopeNode` `:1133` |
| **Fragment samplers 16/16 FULL** | ✘ | Ledger: fragment **15/16 samplers, 17 sampled textures** (limit raised), vertex **6/6 of 16** — `tests/oceanBindingBudget.test.ts:438,445,472-473`. Comments `accumulation.ts:36`, `index.ts:499` ("16/16 textures") and SPEC V40 ("16/14") are stale |
| **T161(b): ~5.3 m vertex spacing at 35 m** | ✘ | Law `spacing = 0.5 + k·r`, `surfaceGeometry.ts:13,67-69`; params 512 seg / 0.5 m / 4600 m `params/oceanSurface.ts:20-25`. Solved k = **0.02049** [M, bisection as `solveGrowthRate`]. Spacing: 5 m→0.60, 25 m→1.01, **35 m→1.22**, 60 m→1.73, 100 m→2.55, 200 m→4.60. 0.136 would give 5.3 m. The header table `surfaceGeometry.ts:156-163` and `slickMath.ts` ("≈1.1 m at the ship") already agree with 0.0205. Radial LOD cannot collapse near rings: fit ≈ 0.003 ≪ fitLo 0.5 at r=35, h=15 |
| `setWaterPlane` zero callers (V62) | ✔ | `index.ts:235`; no caller in `src/`. The `accumulation.ts:220-224` comment claiming it is fitted from hullContact is false |
| Buoyancy 18 stations × 3 Gauss, Smith head | ✔ | `params/seaPhysics.ts:299`, `buoyancy.ts:539-550` |
| Wake has no y/pitch/roll input ⇒ no heave loop | ✔ | Argued in `cpuOcean.ts:418-440`. **A hull-sampled source breaks this by construction** (§4) |
| FFT is raw WGSL | ✘ minor | The butterfly is TSL (`fftPasses.ts`). §C still permits WGSL there |
| Existing readback trap | new | Reused RT readback returns the first frame forever (`src/debug/cascadeView.ts:782`, `docs/agent-browser-harness.md` §2) |

Perf ground truth: the whole-frame compute is **2.05 ms min / 4.96 p50**, mostly the 60 ocean FFT
dispatches × 262k invocations (`docs/performance-analysis.md:210-227`). The frame is CPU-bound, and
dispatches are encoded one compute group per `renderer.compute()` call (`oceanCascades.ts:175`,
three `WebGPUBackend.js:1306`). V17 budget is compute ≤ 4 ms. **The wake must fit in ≤ ~1 ms GPU and
must batch its dispatches.**

---

## 2. Q1 — Solver choice

### 2.1 Physics the solver must reproduce (acceptance physics)

- Deep-water dispersion ω² = g|k|. Transverse wavelength λ_T = 2πU²/g.
  Kelvin half-angle arcsin(1/3) = 19.47°, independent of U (Havelock 1908,
  https://royalsocietypublishing.org/rspa/article/81/549/398/4060/).
- Finite-size narrowing (Rabaud & Moisy 2013, PRL 110:214503, https://arxiv.org/abs/1304.2653):
  α = 19.47° for Fr_L = U/√(gL) ≤ Fr_c = √(3/4π) ≈ 0.49. Above it:
  α = atan[√(2πFr²−1)/(4πFr²−1)] → 1/(2√(2π)·Fr). Values: Fr 1.0 → 11.2°, Fr 2.0 → 5.7° [D from formula].
  Darmon, Benzaquen & Raphaël 2014 (JFM 738 R3, https://arxiv.org/abs/1309.6751): the angle of
  **maximum amplitude** goes as Fr⁻¹, while the outer envelope stays at Kelvin. So the planing narrowing
  is a property of the forcing *size*, not a knob.
- Vessel regimes [C]:

  | Vessel | L | U | Fr_L | λ_T | Expected α_max |
  |---|---|---|---|---|---|
  | Galleon | 38.5 m | 7–10 m/s | 0.36–0.51 | 31–64 m | Kelvin |
  | Raft | ~13.7 m | 2 m/s | 0.17 | 2.6 m | Kelvin, tiny |
  | Speedboat | ~7 m | 20 m/s | 2.4 | 256 m | ≈ 4.7° |

### 2.2 Candidates

| | Dispersion | Kelvin emergent | Boundaries | Scroll | Stability / dt | GPU cost at our scale | Fit to repo |
|---|---|---|---|---|---|---|---|
| **(a) eWave** (Tessendorf 2014, https://jtessen.people.clemson.edu/reports/papers_files/ewavealgorithm.pdf) | **exact** ∀k to Nyquist | **yes** | FFT is periodic. Spatial-domain state + sponge makes it effectively open. The report's convolution form removes periodicity at ~30×30 kernels | texel shift in the spatial pass (existing `regionShiftUv` pattern) | **exact for any Δt**, no CFL (report) | 2 FFTs/step. 256² ≈ 36 dispatches, 2.4 M invocations | **reuses `buildFftPasses`** plus a forward butterfly table |
| (b) iWave (Tessendorf 2004, GPG4, https://jtessen.people.clemson.edu/reports/papers_files/Interactive_Water_Surfaces.pdf) | approx. The 13×13 kernel G(r) truncates low k, so **long waves (≫2P texels) get wrong speeds** | only for λ ≲ 6 texels. The galleon's 31 m λ_T at 0.5 m texels is 62 texels, so the angle is wrong | mask `h*=obstruction`, periodic/reflecting, no sponge | spatial | 2nd-order, needs α damping "to suppress instabilities" | 169 taps/texel → 11 M loads at 256², more than eWave | none |
| (c) plain wave eq. | **none** (c const) | **no**. Mach cone asin(c/U), no transverse train | sponge easy | easy | CFL | cheapest | Crest does this (below) |
| (c′) Crest per-LOD wave eq. (`UpdateDynWaves.compute`, https://github.com/wave-harmonic/crest; docs https://crest.readthedocs.io/en/4.15.2/user/ocean-simulation.html) | piecewise: c = √(gλ/2π) with λ tied to the LOD's texel, Courant-clamped 0.7 | approximate. Dispersion is quantised per octave; not a correct wedge | edge feather 0.95→1 | LOD shift offsets | CFL, damping 0.05 | cheap | a production precedent, but not "physically accurate" |
| (d) Wave packets (Jeschke & Wojtan 2017, https://visualcomputing.ist.ac.at/publications/2017/WWP/) | exact per packet | possible via packet emission (their wake demo UNVERIFIED) | geometric optics, reflections | n/a | unconditional | CPU-heavy, many packets; rendering = packet splats | poor. Deterministic, but N packets × vessels × CPU |
| (d′) Surface wavelets (Jeschke et al. 2018, https://dl.acm.org/doi/10.1145/3197517.3201336) | exact (4D A(x,θ,k)) | yes in principle (ship demos UNVERIFIED) | **best** (islands, sponges natural) | easy | relaxed CFL | 4D grid (e.g. 128²×16θ×4k = 1 M cells) + profile-buffer reconstruction | large new subsystem, research-grade |
| (e) SWE (Chentanez & Müller 2011, https://dl.acm.org/doi/10.1145/1964921.1964977) | ω = k√(gh), **non-dispersive** | **no**: "ripples similar to acoustic shock waves" (J&W 2023) | good | good | CFL | moderate | wrong physics for a deep-water wake |
| (f) Dispersion kernels (Canabal et al. 2016, https://dl.acm.org/doi/10.1145/2980179.2982415) | good (pyramid kernels fix low-k truncation) | yes (their Kelvin-angle accuracy UNVERIFIED) | shadowed convolution for obstacles | spatial | explicit | many taps per level | no reuse |
| (g) SWE + eWave split (Jeschke & Wojtan 2023, https://research.nvidia.com/publication/2023-08_generalizing-shallow-water-simulations-dispersive-surface-waves) | eWave for surface waves at 4 depths + SWE bulk | **yes, boat wakes shown** | SWE handles shore | spatial | exact surface part | 512² at 1 m, ~100 fps on an RTX 2080 Max-Q; 87% of the time is decomposition diffusion | the future path if the wake must shoal/refract on beaches |

**Recommendation: (a) eWave, spatial-domain state, pressure-forced, deep water.** It is the only
candidate that is exact in dispersion, cheap on our existing FFT, and free of CFL. The production proof
is (g), which is eWave plus an optional SWE layer. (g) is also the upgrade path when wakes must feel the
seabed (V72); pure eWave is limited to one depth per domain via tanh(|k|d).

### 2.3 Forced eWave step [D from Tessendorf 2014, pressure term added]

State per texel: surface elevation η and surface velocity potential φ. Forcing is the contact
pressure expressed as equivalent head h_P = P/(ρg) (m), so every channel stays in metres (V66).

```
∂η/∂t = √(−∇²) φ          (Fourier: |k| φ̃)
∂φ/∂t = −g (η + h_P)
Exact over Δt with h_P held (per mode k ≠ 0, ω = √(g|k|), q = η̃ + h̃_P):
  η̃' = −h̃_P + q·cos ωΔt + √(|k|/g)·φ̃·sin ωΔt
  φ̃' = φ̃·cos ωΔt − √(g/|k|)·q·sin ωΔt
k = 0: η̃'= 0 (volume conserved), φ̃' = 0.
```

- **V28:** there is no division by ω. `√(g/|k|)` is finite since |k| ≥ 2π/L_dom. DC is set explicitly.
  cos/sin are a **per-mode table** baked at construction (k and Δt are fixed). The per-step math is then
  only + and ×, which is bit-deterministic across JS engines for the CPU band (V2) and cheap on GPU.
- **Source band-limit at source (V48):** multiply h̃_P by e^(−|k|²σ²/2) with σ = 1 texel, inside the
  evolve pass. This is free, and it kills Gibbs ringing from sharp hull footprints.
- **Band split** (V19 style, used when the CPU band exists, §4): the GPU tier multiplies the evolve
  update by w(k), the CPU tier by 1 − w(k). w is a smoothstep in λ from 12 m down to 6 m. It is linear,
  so the sum is exact.

### 2.4 One step, GPU dispatch plan

```
0 splat    : render pass, instanced Gaussian quads (≤ 8 vessels × 64) → h_P RT (256², rgba16f, additive)
1 pack     : compute — texA ← (η + i·0, φ + i·0), texB ← (h_P, 0)  [+ (−1)^(x+y) centring, as unpackPass]
2 FFT fwd  : 2·log2N butterfly passes (forward table: conjugate twiddles, 1/N² once) — both textures
3 evolve   : compute — table rotation above, source low-pass, band weight w(k)
4 FFT inv  : 2·log2N passes — texA → (η, φ); texB ← spectral ∂η/∂x, ∂η/∂z (i·k_x η̃, i·k_z η̃ packed in evolve)
5 post     : compute — sponge s(x) on η, φ; integer-texel scroll; η_vis = η + h_P; curvature ∇²η (FD)
```

Dispatches: 256² → 2+16+1+16+1 = 36; 512² → 40; 1024² → 44. **Submit all as one
`renderer.compute([...])` array**, which is one compute group, one encoder, one submit
(`WebGPUBackend.js:1306`). This matters because the frame is CPU-bound.

Cost [C], scaled from the ocean's 15.7 M invocations ≈ 2.05–4.96 ms (0.13–0.32 ms per M FFT-kernel
invocations, same kernel shape):

| Tier | Invocations/step | GPU ms/step | Verdict |
|---|---|---|---|
| 256² × 0.5 m (128 m) | 2.4 M | **0.3–0.8** | default |
| 512² × 0.25 m | 10.5 M | 1.4–3.3 | ultra preset only; breaks V17 today |
| 1024² | 46 M | 6–15 | no |

### 2.5 Boundaries, scroll, tiers, dt

- **Sponge:** s(x) = 1 in the inner 70% and ramps to e^(−γΔt) over the outer 15% per side. γ is
  chosen per tier so the slowest in-band wave loses ≥ 99% crossing the ramp. Group velocity
  c_g = ½√(g/k): 6 m waves travel at 1.5 m/s, 60 m waves at 4.8 m/s. Long waves need thicker zones
  (optimal-sponge literature, https://www.sciencedirect.com/science/article/abs/pii/S0029801818309417;
  PML alternative: Söderström, Karlsson & Museth 2010, https://dl.acm.org/doi/10.1145/1857907.1857912).
  Periodic wrap-around of residual energy is the failure mode; W1 tests reflection < 2%.
- **Anchor (V8):** the domain centre is the **hero vessel's sim pose**, biased 0.3·L_dom astern along
  the velocity and snapped to whole texels (`flowMath.snapToTexel`, same as `accumulation.setCenter`
  `accumulation.ts:401-410`). **Never the camera.** The floated sea must not depend on where anyone
  is looking (`slickMath.ts` header, V8).
- **Tiers:**
  - GPU near: 256² × 0.5 m, 128 m domain, ~90 m usable. λ ≥ 1.5 m resolvable.
  - CPU band (W4): 128² × 2 m, 256 m domain, ~180 m usable. λ ≥ 6–8 m.
  - Far trail (> ~90 m astern): the **existing far accumulation tier** (256²/640 m, foam+slick
    advection and decay). It carries sim-injected foam, so no analytic track is needed (§5.4).
- **dt:** the exact integrator makes the GPU step rate a quality knob, not a stability one. Step the
  GPU once per rendered frame with Δt = elapsed sim time since the last GPU step. Sources come from
  the latest tick at interpolated pose. The CPU band steps on the fixed tick (V2). 30 Hz stepping of
  the CPU band is allowed because the integrator is exact; §4.3 covers the cost trade.

---

## 3. Q2 — Source model: hull geometry → pressure

### 3.1 Principle

**The pressure the water exerts on the hull is the pressure the hull exerts on the water.** A linear
free surface forced by a moving pressure distribution is exactly the classical ship-wave model
(Havelock; Darmon et al. 2014 use a Gaussian pressure disturbance). Therefore:

```
HydroSample { x, z            // plan position (world)
              fy               // vertical hydrodynamic force this sample carried this tick (N, ≥ 0)
              sigma            // plan footprint radius (m) — √(A_plan)/2, floored at 1 sim texel
              vx, vz           // local velocity through water (spray direction, prop wash)
              flags            // waterline-edge | stagnation | slam | prop }
h_P(x) = Σ_i fy_i/(ρg) · G_σi(x − x_i)     ⇒  ∫ ρg·h_P dA = Σ fy_i   (Newton 3, testable)
```

Every sample comes from the module that computes that vessel's force. **One contact module, two
consumers (forces, wake), plus a third (spray/foam).** There are no per-vessel wake params.

### 3.2 Producers

| Vessel | Producer | Why | Resolution |
|---|---|---|---|
| Galleon, brigantine | **existing buoyancy quadrature**: 18 stations × 3 Gauss points, force = ρg·head·weight·A_wp (`buoyancy.ts:539-550`) | Already the V50/V68-validated integral; zero new geometry; pitch/heave/heel change the samples | 54 samples, σ ≈ L/36 ≈ 1 m along |
| Raft | same quadrature on the raft's own plan (`sailing/raftWaterplane.ts`, V71, §T162) | Shallow, flat logs ⇒ small head ⇒ small wake, emergent | 54 samples |
| Speedboat (W4) | **new triangle clipper** on a low-poly hydro proxy (Kerner 2015/2016) | Planing: dynamic lift ≫ hydrostatic, only aft running surface wet | ~100–300 tris, 1 sample per wet triangle |

Kerner, "Water interaction model for boats in video games", Just Cause 3:
Part 1 https://www.gamedeveloper.com/programming/water-interaction-model-for-boats-in-video-games,
Part 2 https://www.gamedeveloper.com/programming/water-interaction-model-for-boats-in-video-games-part-2.
Coefficients from the Habrador port, https://www.habrador.com/tutorials/unity-boat-tutorial/5-resistance-forces/.

- **Clip:** each triangle has 0–3 vertices below the local surface. With 1 or 2 below, cut at the
  waterline. The cut segments are the **waterline polyline**, which spray uses.
- **Hydrostatic:** F = −ρg·h_c·A·n̂ at the centroid. Low-poly centroid torque error is a known caveat.
- **Viscous:** C_f = 0.075/(log₁₀Re − 2)² (ITTC-57).
- **Pressure drag:** F = −(C_PD1·v/v_r + C_PD2·(v/v_r)²)·A·cos^{f_P}θ·n̂. Suction uses C_SD1/C_SD2
  and f_S. Port values: all C = 10, f = 0.5. These give planing lift emergently.
- **Slam:** acc = |ΔV_swept|/(A·Δt), F = −clamp(acc/acc_max)²·cosθ·F_stop.
- **Water height per vertex:** do **not** call `heightAt` per vertex. Its cost is a 16-tap
  Catmull-Rom per cascade (`docs/performance-analysis.md:256-266`). Sample a per-vessel K×K local patch
  once per tick (e.g. 5×9 over the hull AABB) and interpolate bilinearly. That is ≈ 45 `heightAt` per
  boat, like hullContact's station budget.
- **Proxy mesh:** generated from the vessel's own evaluator, never hand-authored (V71). Galleon from
  `hullMath.hullHalfWidthAt` (`src/ship/hullMath.ts:89`), raft from `logHalfAt`, speedboat from its
  loft. A test asserts proxy waterplane area and displacement = buoyancy `HullPlan` ± 2% (V77 guard).

### 3.3 What emerges without art direction

- **Galleon dredging at bow and stern:** bow pitch-down raises bow-station head → more fy forward
  → stronger bow source → bow wave and radiated ring. Squat and trim follow (§4.4).
- **Heel and leeway:** asymmetric port/starboard fy, and an obliquely moving pattern → asymmetric wedge.
- **Raft:** 0.3 m draft → h_P ≈ 0.3 m spread over a wide flat plan. At Fr 0.17, λ_T = 2.6 m ≪ L, so the
  length integral cancels most wave-making, as it should. The wake is weak and short-crested, with no
  `speedScale` (retires T161(a)'s wake half).
- **Planing speedboat:** only aft triangles are wet (Savitsky 1964 wetted length/trim,
  https://dlba-inc.com/library/hydrodynamic-design-of-planing-hulls/). Small σ-footprint at high
  Fr_L → narrow α_max ∝ 1/Fr. The wake narrowing comes from the physics, not a knob.
- **Airborne:** zero wet triangles → zero samples → the sim radiates the last pattern away.
- **Re-entry slam:** fy jumps in one tick → h_P step → the linear system rings. Dispersion sorts the
  ring (long waves outrun short ones). The spray burst is keyed on `slam`.
- **Pitching at rest:** a time-varying h_P radiates waves, which is the physical radiation damping.
  See the §4.4 risk.

### 3.4 Non-pressure sources (small, explicit)

- **Prop wash (speedboat):** thrust T at the prop point.
  - Jet speed from actuator-disc theory: V_j = √(U² + 2T/(ρA_disc)) [D].
  - The wave part is a small negative-head splat aft of the transom, −C_pw·(V_j−U)²/(2g). **C_pw is
    the one authored coefficient, UNVERIFIED** (no game/literature source found).
  - The visual part is foam and slick injection into the accumulation (R/G) along the jet, plus
    rooster-tail particles when the transom is clear.
- **Spray sheets:**
  - Emit along clipped waterline segments with rate ∝ max(0, v_n)²·segment length and direction =
    relative flow reflected about the hull normal, lifted.
  - On planing hulls the stagnation line (forward edge of the wetted region) gives whisker spray
    (Savitsky et al. 2007 whisker spray drag, https://www.researchgate.net/publication/233711011).
  - Galleon/raft keep `hullContact.cutwater` → `bowSpray` (`src/foam/bowSpray.ts:27,222-288`) until W5.

### 3.5 GPU hull rasterisation vs CPU splats

| | GPU ortho immersion raster (extend the layer-27 capture, `accumulation.ts:236-263,418-449`) | **CPU HydroSample splats → instanced-quad h_P pass** |
|---|---|---|
| Footprint fidelity | exact silhouette | σ ≥ 1 texel (low-passed anyway, §2.3) |
| Dynamic (planing) pressure | ✘ hydrostatic only | ✔ |
| Feeds rigid-body forces | ✘ (no readback allowed) | ✔ same data |
| Determinism / CPU band mirror | ✘ | ✔ CPU can splat the same list |
| Needs ambient ζ in capture | +3 displacement textures in that pass | no |
| Destruction (holed hull pieces) | holes change wake (side effect) | proxy unaffected unless flooded |
| N = 8 vessels | one pass, free | ≤ 512 instances, one draw |

**Recommendation: CPU samples → GPU splat pass**, a 256² rgba16f RenderTarget read by `textureLoad`
in the pack compute (unfilterable read, no sampler). rgba16f is blendable in core WebGPU; rgba32f
blending needs `float32-blendable`. **Do not** splat in compute with a per-texel loop over samples:
65k × 512 = 33 M evaluations per step.

---

## 4. Q3 — Coupling (V8)

### 4.1 Options

| Option | Latency | Cost | Determinism (§C, V2, "multiplayer later") | Verdict |
|---|---|---|---|---|
| GPU readback (`mapAsync` / `readRenderTargetPixelsAsync`) | 1–3 frames, **variable** | small copy + stall | ✘ Arrival tick depends on GPU timing. GPU floats differ by vendor. Replay hash breaks. Plus the reused-RT stale-frame trap (`cascadeView.ts:782`) | **reject for SimState**; debug probes only |
| CPU mirror, full sim | 0 | 256²: **18.8 ms/step** [M] | ✔ | ✘ unaffordable |
| **CPU-authoritative low band + GPU upload** | 0 | 64²: **0.46 ms**, 128²: **2.0 ms/step** [M: node on dev Mac, 3 fwd + 2 inv 2D FFTs, typed arrays] | ✔ table rotation, +/× only | **W4** |
| One-way (wake visual-only) | — | 0 | ✔ | **W1–W3**, with a V8 amendment |

### 4.2 Recommendation and the V8 amendment

- **W1–W3 (galleon, raft): one-way.** `cpuOcean.setWakeField` is detached from the new sim. Buoyancy
  reads the ambient sea plus nothing from the wake.
  - Measured stake: T82 found own-wake trim of +0.40° to −1.20° under the analytic field, and 0.000°
    without it. T82's test (`tests/trimUnderWay.test.ts`) must be re-cut to the no-wake properties
    (level keel, calm pitch 0).
  - The enemy stops feeling the player's analytic wake. That is correct behaviour today, lost
    temporarily.
  - Amendment text: *"V8a: the hull-sampled wake is visual-only until the CPU band lands (§T W4). The
    floated sea = ambient FFT. Measured residual: galleon pitch ≤ 1.2° (T82) and heave ≤ the wake's
    peak η_vis·Smith. Stated, not hidden."*
- **W4 (speedboat): CPU band.** 128² × 2 m over 256 m, stepped in the tick.
  - `cpuOcean.heightAt` adds η_vis,band at full amplitude. `pressureHeadAt` adds it Smith-attenuated
    per mode (e^(−|k|T), applied in Fourier before the inverse, since the attenuation is per-k). This is
    the same split as today (`cpuOcean.ts:421-433`).
  - The GPU **uploads** the CPU band's η_vis and its gradients (128² rgba16f, ~130 KB/tick) instead of
    re-simulating them. **V77 holds by construction**: one implementation per band, the pointer
    pattern of `setWakeField` (`cpuOcean.ts:636-653`).
  - The GPU near sim carries only w(k) (λ < 6–12 m), visual-only. Residual: sub-8 m chop does not
    launch boats. This is bounded and measured in W4.
  - Why 8 m is enough: speedboat wake waves at 20 m/s along the narrowed wedge are λ ≈ λ_T·cos²θ ≈ 17 m
    at θ ≈ 75° [D]. Galleon λ_T is 31–64 m. The raft's own wake (2.6 m) is entirely visual, which is
    correct: its force is negligible.

### 4.3 CPU band cost decision

- 128² every tick: 2.0 ms on an already CPU-bound frame.
- 128² every 2nd tick (exact Δt = 1/30): **1.0 ms average**, 2 ms spike, 30 Hz stair on the floated
  sea. The stair is invisible to a 5 s-period hull, but matters for speedboat impacts.
- 64² × 2 m over 128 m every tick: 0.46 ms, but only ~90 m usable. A racing pack fits; long galleon
  transverse trains (64 m) do not.
- **Recommend 128² at 30 Hz for pirate/raft coupling (if ever enabled) and every tick in race mode.**
  Worker offload is not deterministic without a blocking handoff, which the main thread cannot do.

### 4.4 Consequences you must accept

- **Static cancellation (V-W3):** buoyancy and render read η_vis = η + h_P.
  - At rest, the steady forced response is η = −h_P exactly (k-independent), so η_vis = 0: no phantom
    hole, and the hull floats exactly as sim-off.
  - Without this, a displacement hull would read a surface depressed to its own keel and **sink**
    (double-counted hydrostatics).
- **The self-loop is now real.** Today's "no heave loop by construction" (`cpuOcean.ts:434-440`) no
  longer holds: fy depends on heave/pitch.
  - Physically, the dynamic free-surface response is radiation damping plus added mass. V69 already
    carries added mass, so double counting is possible.
  - Mitigations: a one-tick lag (sources from the previous tick) and a **stability sweep** (V50
    style): heave/pitch periods within 5% of the sim-off closed form (V53), decay ratio not reduced,
    over wavelength × heading × seed.
  - Fallback: the hero vessel runs a private 64² self-sim (0.46 ms), which is subtracted.
- **T82 comes back emergently.** The bow crest and stern trough past the hump come from the physics
  rather than a +π phase. The trimUnderWay properties ("crest under stem ∀ speed", "by the stern past
  Fn 0.45", "< 1° by the head") become W4 acceptance tests for the CPU band.
- **Speedboats riding wakes** get launch impulses from the λ ≥ 8 m band at one tick of delay, which
  is deterministic and replayable. Airtime off a rival's wake is emergent. So is the rival's wake
  narrowing at speed, which makes crossing it a sharper, shorter hit.

---

## 5. Q4 — Rendering integration

### 5.1 Data flow

```
SIM TICK 60 Hz (CPU, deterministic)                                   RENDER FRAME (GPU)
 sailing/6DOF pose ─┐                                                  ┌───────────────────────────────────────────┐
 cpuOcean ambient ──┼─► HydroContact (per vessel)                      │ splat pass: HydroSample[] → h_P RT 256²    │
                    │     stations (galleon/raft) | clipped tris (W4)  │ pack → FFT fwd → evolve(table,w(k)) →      │
                    │     ├─► forces → buoyancy / 6DOF (single owner)  │ FFT inv → post(sponge,scroll,η_vis,∇²η)    │
                    │     ├─► HydroSample[] ──────────────────────────►│      │ (one compute group)                 │
                    │     │                                            │      ▼                                     │
                    │     │   [W4] CPU band 128² eWave (1−w(k)) ─┐     │ flowfoam near advect 512² (textureLoad):   │
                    │     │         η_vis,band + ∇ ──► cpuOcean  │     │   elevTexture.r ← η_vis,near (Nyquist-gated)│
                    │     │         heightAt / pressureHeadAt    │     │   foamTexture.ba ← ∇η_near                 │
                    │     │                                      └────►│   R foam ← breaking + contact churn        │
                    │     └─► spray (waterline segs, slam, prop)       │   G slick ← wetted-pass dose               │
                    │                                                  │ far advect 256²: foam/slick trail only     │
                    └─ camera NEVER feeds any of this                  │ ocean VERTEX: + elev(near) + band tex      │
                                                                       │        band ∇ → varying()                  │
                                                                       │ ocean FRAGMENT: slope += .ba + varying ∇   │
                                                                       └───────────────────────────────────────────┘
```

### 5.2 Displacement (vertex) — T161(b) and the mesh

- **The near band is resampled into the existing `acc.elevTexture`.** The flowfoam advect pass already
  walks 512² and does manual bilinear via `textureLoad` (`accumulation.ts:282-356`). It adds 0 bindings
  to the ocean material. `wakeHeightNode` (`index.ts:502-505`) is unchanged.
- **Near band displacement is gated by vertex Nyquist:** keep while λ ≥ 2 × `spacingAtRadius`
  (`surfaceGeometry.ts:67`, the same law `lodWeight` uses, `surfaceMaterial.ts:565-575`).
  - This is now **legal**. The near band is visual-only, so the camera-free argument in
    `slickMath.ts` ("no gate because the mirror can't see vertex spacing") applies only to the CPU band.
  - The gated-away part stays in the slope, so the detail is converted rather than deleted (V64).
- **CPU band (W4)** gets one new vertex texture (vertex 6 → 7 of 16, no fragment change). It is never
  gated: its λ ≥ 6 m is ≥ 2× spacing within ~120 m of the camera [C from spacing table], and V8
  forbids a camera gate on it.
- **Mesh:** **no change recommended.** Spacing is 0.60 m at 5 m, 1.01 m at 25 m, 1.22 m at 35 m.
  - A 6.4 m mound ridge spans 5–6 vertices at follow-cam range.
  - The raft FP eye within 10 m sits on 0.5–0.7 m spacing. Its wake is cm-scale and reads through
    normals anyway.
  - If W0 disproves this: (1) lower `gridCoreSpacing` 0.5 → 0.35 (k re-solves, rim unchanged, +0 draw
    calls, costs per-primitive tiling, which is the measured ocean bottleneck `params/oceanSurface.ts:36-45`);
    (2) carry sub-grid detail in the slope, which this design already does. **Not** tessellation
    (no WebGPU tessellation stage).

### 5.3 Normals (fragment) without samplers

- **Near band:** spectral ∂η/∂x, ∂η/∂z from inverse FFT → `foamTexture.ba`, which the analytic Kelvin
  slope writes today (`accumulation.ts:333-337`). It is read by the existing `wakeSlopeNode`
  (`index.ts:453-458`), with the existing `bandKeepNode` band-limit against the pixel footprint
  (V48/V49). Feature = sim texel × `waveBandLow`.
  - **Change:** exclude `.ba` from the blur pass (`accumulation.ts:378-384`). A 1-texel kernel at
    0.234 m is harmless for 6 m waves but smears 1.5 m ones.
- **CPU band:** the gradient is sampled in the vertex stage and passed as `varying()`. This is the
  exact precedent of the fetch field (`surfaceMaterial.ts:683-695`; ledger `oceanBindingBudget.test.ts`
  fetchField entry). Its λ ≥ 6 m interpolates cleanly over ≤ 2.5 m triangles.
- **Ledger:** fragment stays **15 samplers / 17 textures**, vertex 6 → 7 at W4. Recount in the same
  commit (V40).
- Horizontal (choppy) displacement of wake waves: **deferred**. It would need 2 more transforms
  (i·k̂ η̃) and a Jacobian gate change; it is listed as an open decision.

### 5.4 Foam, slick, trail

All injected in the flowfoam **compute** passes (0 material bindings):
- **Breaking:** foam rate ∝ smoothstep over |∇η_vis| from 0.30 to 0.44. 0.44 is the Stokes limiting
  steepness (H/λ ≈ 1/7 → ka ≈ 0.44), so the threshold is not a look knob. Also ∝ max(0, −∇²η)·λ at
  crests.
- **Contact churn:** ∝ |∂h_P/∂t| + |∇h_P|·|v| at the footprint rim, which is dredging whitewater.
  It adds to the existing layer-27 waterline capture (V10), not replacing it.
- **Slick (G):** dose ∝ h_P·Δt. The glassy lane is exactly where hulls have been.
- **Far trail:** the far tier (`index.ts:113-121`) receives the same foam and slick rates, resampled.
  Its 22 s half-life plus flow advection already carries the trail hundreds of metres. With N vessels
  that replaces the 48-segment per-texel track walk (which does not scale to 8 boats: 384 segment
  tests × 512² per step).
- Per-texel noise in breakup must hash **position**, never a shared time phase (§B4).

### 5.5 Coexistence and migration with the analytic Kelvin field

- **W2–W5:** flag `wake.source = 'analytic' | 'sim'`, a live param with a sink wired (V62). Both write
  the same channels, so there is a single switch site in the advect pass and an A/B in the browser.
- **W6:** delete the analytic wave terms (`slickInjection` transverse/divergent, mound, eddy elevation,
  `elevationCpu`, `wakeTrack` if the far trail no longer needs it), the dead `setWaterPlane` (V62),
  and the `speedScale` wake half.

### 5.6 Safety (V28, V44, V23)

- h_P splat inputs are finite-guarded per sample (non-finite pose → vessel skipped, logged once).
  fy clamps to [0, 4·weight].
- η_vis clamps to ±3 m **at source** in the post pass (V44), and the CPU mirror mirrors the clamp
  (the precedent is the ±2 m note at `index.ts:283-289`).
- Sponge floor s ≥ 0, DC explicit, table precomputed, literal `Loop` bounds. Splat quads use a
  zero-size vertex for unused instances (§B5: never rasterise dead instances).
- Functional `mix/smoothstep` only (§B1/§B2, V23).

---

## 6. Q5 — Phased plan

Each phase lists: owning dir · numeric tests encoding **why** · browser check (V22/V88) · perf budget.
Suggested new dir `src/wake/` (solver + splat), which is a §I src-layout amendment. Contact stays in
`src/sea-physics/`. Material wiring is done by `src/ocean` and `src/flowfoam` owners.

### W0 — Measure T161(b) before touching anything
- **Dirs:** `src/debug` (probe), read-only `src/ocean`.
- **Tests:**
  - (1) `surfaceGeometry` spacing at the follow-cam ship distance (28 m radius, pivot 6) resolves the
    shipped mound: `ridgeWidth / spacingAtRadius(r) ≥ 4` ∀ r ≤ 60 m. This is a ratio (V66), pinned to
    the property "the mesh can carry the wake".
  - (2) GPU `elevTexture` readback (fresh RT, `cascadeView.ts:782` trap) max vs `wakeHeightCpu` max,
    within 1 cm at 7 m/s.
- **Browser:** calm preset with cascades zeroed (debug) at follow 35 m and deck/FP; screenshot wake-only.
  Then swell.
- **Decide:** amplitude (0.41 m mound vs swell σ), the undisplaced divergent train (by design,
  `slickMath.ts` header), or wiring. **Expected: amplitude/visibility, not grid.**
- **Perf:** 0.

### W1 — eWave solver in isolation + test pond
- **Dirs:** `src/wake/` (`wakeSolverMath.ts` CPU core; `wakeSolverPasses.ts` TSL; forward butterfly in
  `src/ocean/oceanMath.ts` via its owner); harness `src/wake/preview.html` (like `src/sky/preview.ts`).
- **Tests (vitest, GPU-free, CPU core with `Math.fround`):**
  1. **Dispersion:** a single mode's period = 2π/√(g|k|) ± 0.1% after 1000 steps at Δt ∈ {1/30, 1/60,
     1/120}, and the 3 runs agree to 1e-4. Why: step rate must be a quality knob, never physics (V2).
  2. **Kelvin, as a property of physics** (moving Gaussian pressure, size L, sponge domain in the
     source frame):
     - α_max = 19.5° ± 1.5° at Fr_L ∈ {0.30, 0.45}
     - α_max(Fr 1.0) = 11° ± 2.5°
     - α_max(2.0)/α_max(1.0) = 0.5 ± 0.12 (Rabaud–Moisy/Darmon ∝ 1/Fr)
     - outer envelope stays 19.5° ± 2° at Fr 2
     - measured λ_T = 2πU²/g ± 5%
     - Why: the angle, narrowing and wavelength must come out of ω² = gk, so no one can tune them back in.
  3. **Energy:** sources off, E = Σ(g|η̃|² + |k||φ̃|²) is non-increasing over 10⁴ steps. Sponge
     reflection < 2% for λ ∈ [4 texels, L_dom/4]. Why: a wake that grows is the V28 wedge in slow motion.
  4. **Static cancellation:** a stationary patch → RMS η_vis < 1% of h_P after settling. Why: a vessel
     at anchor makes no wake and must not sink into its own hole.
  5. **Bow crest (T82 WHY):** a hull-shaped patch at Fn 0.35 → max η_vis within the forward 20% of the
     footprint; trough midbody. If it fails, add a thin-ship volume-flux term q = −∂d/∂t (Michell) and
     re-run. That is the one fallback, decided by a test.
  6. **Scroll:** a domain re-centred by k texels equals the unshifted field in the overlap to 1e-4.
  7. **NaN:** NaN/Inf samples → field finite, vessel skipped (V28).
  8. **CPU↔TSL pair:** transliteration of the table rotation and splat kernel (the `bandLimit.ts`
     test-pair pattern, V77).
- **Browser:** pond preview. A point impulse gives a dispersive ring (long waves lead). A moving source
  gives a wedge; the screenshot is overlaid with 19.47° lines.
- **Perf:** 256² ≤ 1.0 ms GPU (min-of-60 timestamps); ≤ 40 dispatches in **one** compute group;
  CPU encode ≤ 0.2 ms.

### W2 — HydroSample contract + galleon (and brigantine for free)
- **Dirs:** `src/sea-physics/` (buoyancy emits samples; `hydroSample.ts` type); `src/wake/` (splat,
  registry `setVessels(samples[][])`); `src/flowfoam/` (resample into elev/.ba, `.ba` blur exclusion);
  `src/ocean/` ledger. Shared tick helper in `src/core` used by both entries (V95), replacing
  `main.ts:1162-1176` and `raftFrame.ts:96-103`.
- **Tests:**
  - (1) ∫ρg·h_P dA = Σ station fy ± 1% (Newton 3). Why: the wake is the reaction to the hull's own force.
  - (2) Galleon at 0 m/s in calm after 30 s: wake energy < 1e-4 of the 7 m/s value.
  - (3) Fn sweep 0.2→0.6: radiated energy flux (∂E/∂t with a sponge sink) rises steeply to a hump near
    Fn ≈ 0.45–0.5, the classic wave-resistance hump. It is emergent and pinned as "flux(0.5)/flux(0.3)
    ≥ 3", not as a value (V80).
  - (4) Brigantine produces a narrower-footprint pattern than the galleon at equal U, a ratio test on
    α_max or crest spacing vs L.
  - (5) Binding ledger: vertex 6/6, fragment 15 unchanged.
  - (6) T82 test re-cut for one-way (§4.2) + V8a text.
- **Browser:** galleon at 3 / 7 / 10 m/s, calm and swell, follow and deck, A/B `wake.source`. Turning
  leaves a curved trail. The enemy's wake is visible. User sign-off (hero visual).
- **Perf:** wake GPU ≤ 1.0 ms total at N = 2; CPU sample emission ≤ 0.05 ms.

### W3 — Raft
- **Dirs:** `src/raft/` consumes the shared helper. **Zero diff** on pirate files (V81). The raft plan
  already exists in `sailing/raftWaterplane.ts`.
- **Tests:**
  - (1) At 2 m/s the dominant wake wavenumber = g/U² ± 10% (λ_T 2.6 m) with no raft-specific wake
    constant. A `?raw` scan asserts `raftWakeParams.speedScale` no longer reaches the wake (V62).
  - (2) Raft peak η_vis ≤ 0.15 × galleon peak at their own cruise speeds, a ratio. Why: a flat
    shallow hull at low Fr barely makes waves.
- **Browser:** R-phase sync set (V88) FP stations bow/tiller: slope ripples read within 10 m.
- **Perf:** unchanged vs W2.

### W4 — Multi-vessel, triangle contact, CPU band (speedboat hooks)
- **Dirs:** `src/sea-physics/hydroTriangles.ts` (Kerner clip + forces + samples), `src/wake/wakeBand.ts`
  (CPU band), `src/sea-physics/cpuOcean.ts` (band in heightAt/pressureHeadAt), new race entry later
  with its own isolation invariant (V81 analogue).
- **Tests:**
  - (1) **Clipper:** a box and a prism float at the analytic draft ± 1%. Submerged volume/centroid is
    exact for all 1- and 2-vertex-under cases. Dimensionless displacement vs ρ∇ (V53).
  - (2) **One producer:** a `?raw` scan confirms the splatter imports only the `HydroSample` type, and
    forces and samples come from the same loop (no second hull evaluation).
  - (3) **Planing:** a proxy at F∇ ≈ 3 has wetted length ≤ 40% of L and α_max < 10°.
  - (4) **Airborne:** zero samples ⇒ ∫h_P = 0.
  - (5) **Slam:** 3 m/s re-entry → ring whose leading crest speed = c_g of its dominant λ ± 15%.
  - (6) **Band identity:** GPU band texture = CPU band buffer bit-exact (same Float32Array).
  - (7) **Coupling is live** (V62): a probe boat crossing a 10 m-λ wake at 15 m/s gets vertical impulse
    > 0 with the band on and exactly the ambient value with it off.
  - (8) **Stability sweep** (§4.4): galleon heave/pitch periods within 5% of sim-off, decay not reduced
    ∀ λ × heading × seed.
  - (9) trimUnderWay properties return (crest under stem, by the stern past Fn 0.45, < 1° by the head).
  - (10) Ledger: vertex 7/16.
- **Browser:** 8 speedboat proxies in a pack on the test pond, one airborne sequence, one wake-jump.
- **Perf:** 8 boats CPU contact + band ≤ 2.5 ms/tick (race mode, every tick); pirate ≤ 1.0 ms (30 Hz
  band); GPU ≤ 1.2 ms.

### W5 — Foam and spray from the sim
- **Dirs:** `src/flowfoam/` (injection), `src/foam/bowSpray.ts` → samples (waterline segments,
  stagnation, slam, prop).
- **Tests:**
  - (1) Still water and sub-threshold (slope < 0.30) waves inject exactly 0 foam. Why: no white caps
    on glass (V72 corollary).
  - (2) Foam coverage astern is monotone in Fn for the galleon.
  - (3) Spray emitters are never above the surface: every spawn is on a clipped waterline segment
    (the hullContact "mid-air emitter" bug class).
  - (4) Prop wash foam ∝ T at fixed U, a ratio.
- **Browser:** galleon bow wave whitening at 10 m/s; speedboat rooster tail and whisker spray; raft
  gurgle only.
- **Perf:** ≤ +0.1 ms.

### W6 — Retire analytic duplicates
- **Dirs:** `src/flowfoam/`, `src/sea-physics/cpuOcean.ts`.
- **Tests:**
  - (1) A `?raw` scan confirms there are no references to `kelvinBranchesCpu`, `elevationCpu`,
    `slickFieldCpu` wave terms, `setWaterPlane`.
  - (2) Binding ledger recount.
  - (3) Perf: the advect pass loses the 48-segment walk. Measure and record (expect the near tier's
    wake cost to drop).
- **Browser:** regression set W2–W5 unchanged.

### Proposed §V invariants (one-liners)
- **V-W1 WAKE IS SOLVED, NOT DRAWN:** wake waves ! emerge from ω² = g|k| forced by contact pressure.
  The Kelvin angle, λ_T and high-Fr narrowing ⊥ authored; they are tested as properties.
- **V-W2 ONE CONTACT, TWO CONSUMERS:** ∀ vessel the HydroSample set that makes its hydro force IS its
  wake source; ∫ρg·h_P dA = ΣF_y.
- **V-W3 STATIC CANCELLATION:** the drawn & floated wake = η + P/(ρg). A stationary vessel makes no
  wake and floats identically sim on/off.
- **V-W4 BAND OWNERSHIP (amends V8):** λ ≥ λ_split is CPU-authoritative in the tick and the GPU draws
  the uploaded field; λ < λ_split is GPU visual-only with a measured residual. Before W4 the whole wake
  is visual-only (V8a).
- **V-W5 ANCHOR ON SIM STATE:** the wake domain follows the hero vessel's sim pose, snapped to texels.
  The camera ⊥ input.
- **V-W6 STEP-RATE FREE:** exact integrator. Results at 30/60/120 Hz stepping agree. No CFL knob exists.
- **V-W7 ONE GROUP:** all wake compute dispatches are submitted as one compute group. Dispatch count is
  asserted in a test.

### Proposed §T titles
- T163 W0 — measure T161(b): grid carries the wake, find what doesn't
- T164 W1 — eWave solver + test pond (Kelvin as a numeric test)
- T165 W2 — HydroSample contract, galleon + brigantine wake, shared tick helper
- T166 W3 — raft wake from her own waterplane (speedScale retired from the wake)
- T167 W4 — triangle contact (Kerner), CPU wake band, multi-vessel, speedboat hooks
- T168 W5 — foam, slick and spray from the sim
- T169 W6 — retire the analytic Kelvin duplicates + dead `setWaterPlane`

---

## 7. Q6 — Risks & open decisions (recommendation in bold)

1. **Coupling timeline:** one-way through W3, CPU band at W4. **Yes.** Pirate/raft lose ≤ 1.2° of
   own-wake trim temporarily; W4 brings it back emergently.
2. **CPU band size:** 64²/128 m at 0.46 ms vs 128²/256 m at 2.0 ms (1.0 ms at 30 Hz).
   **128², every tick in race mode, 30 Hz elsewhere.**
3. **GPU near resolution:** **256² × 0.5 m default**. 512² only as ultra: it costs 1.4–3.3 ms and
   V17 is already at 2–5 ms.
4. **Self-coupling double-counts added mass / goes unstable (§4.4).** **Accept with the W4 sweep.**
   Fallback: a hero private 64² self-sim subtraction.
5. **Pressure patch may not give a bow crest / "dredging" look.** **Test-driven (W1.5)**. Fallback:
   Michell volume-flux term from the same samples.
6. **Compute budget (V17):** the frame is CPU-bound and every `renderer.compute()` is its own group.
   **Batch the wake's 36 dispatches into one array in W1.** Side finding: the ocean's 60 are unbatched
   too (`oceanCascades.ts:175`). Out of scope here, but likely a free CPU win.
7. **Shoaling/refraction of wakes near islands:** FFT = one depth per domain. **Deep water in v1.**
   tanh(|k|d̄) with the domain-mean depth when the domain is over a shelf; the Jeschke & Wojtan 2023
   SWE + multi-depth eWave split if beaches must reshape wakes.
8. **Wake reflecting off rocks/hulls:** the spatial state permits `η *= mask` obstacles (iWave-style).
   **Defer.** Islands are far from the hero domain most of the time.
9. **Horizontal choppy displacement of wake crests:** **defer**; revisit if bow waves read "soft" in W2.
10. **Racers outside the hero domain:** no wave sim, no wake coupling; foam trail only via the far
    accumulation. **Accept and document.** It is deterministic because domain membership is a function
    of sim state.
11. **Prop wash coefficient C_pw is authored** (no source found). **Accept one coefficient**, with a
    dimensionless check vs actuator-disc jet head (V53).
12. **Readback for anything sim-facing:** **never** (determinism + stale-RT trap). Debug probes only.
13. **SPEC text drift found here:** T161(b)'s k, V40's counts, and stale comments in
    `accumulation.ts:36,81-83,220-224` and `index.ts:499`. **Correct via /spec when T163 is filed.**

---

## 8. References

- Tessendorf, *eWave: Using an Exponential Solver on the iWave Problem*, 2014 — https://jtessen.people.clemson.edu/reports/papers_files/ewavealgorithm.pdf
- Tessendorf, *Interactive Water Surfaces* (iWave), Game Programming Gems 4, 2004 — https://jtessen.people.clemson.edu/reports/papers_files/Interactive_Water_Surfaces.pdf
- Jeschke & Wojtan, *Generalizing Shallow Water Simulations with Dispersive Surface Waves*, SIGGRAPH 2023 — https://research.nvidia.com/publication/2023-08_generalizing-shallow-water-simulations-dispersive-surface-waves
- Jeschke & Wojtan, *Water Wave Packets*, SIGGRAPH 2017 — https://visualcomputing.ist.ac.at/publications/2017/WWP/ (code https://github.com/jeschke/water-wave-packets)
- Jeschke, Skřivan, Müller-Fischer, Chentanez, Macklin, Wojtan, *Water Surface Wavelets*, SIGGRAPH 2018 — https://dl.acm.org/doi/10.1145/3197517.3201336
- Schreck, Hafner, Wojtan, *Fundamental Solutions for Water Wave Animation*, SIGGRAPH 2019 — https://visualcomputing.ist.ac.at/publications/2019/FundamentalSolutionForWaterWave/
- Canabal, Miraut, Thuerey, Kim, Portilla, Otaduy, *Dispersion Kernels for Water Wave Simulation*, TOG 35(6) 2016 — https://dl.acm.org/doi/10.1145/2980179.2982415
- Chentanez & Müller, *Real-time Eulerian water simulation using a restricted tall cell grid*, 2011 — https://dl.acm.org/doi/10.1145/1964921.1964977
- Kerner, *Water interaction model for boats in video games*, parts 1 & 2, 2015/2016 — https://www.gamedeveloper.com/programming/water-interaction-model-for-boats-in-video-games , https://www.gamedeveloper.com/programming/water-interaction-model-for-boats-in-video-games-part-2 ; coefficients via https://www.habrador.com/tutorials/unity-boat-tutorial/5-resistance-forces/
- Rabaud & Moisy, *Ship wakes: Kelvin or Mach angle?*, PRL 110:214503, 2013 — https://arxiv.org/abs/1304.2653
- Darmon, Benzaquen, Raphaël, *Kelvin wake pattern at large Froude numbers*, JFM 738 R3, 2014 — https://arxiv.org/abs/1309.6751
- Havelock, *The propagation of groups of waves in dispersive media*, Proc. R. Soc. A 81, 1908 — https://royalsocietypublishing.org/rspa/article/81/549/398/4060/
- Savitsky, *Hydrodynamic Design of Planing Hulls*, Marine Technology 1(1), 1964 — https://dlba-inc.com/library/hydrodynamic-design-of-planing-hulls/ ; whisker spray: https://www.researchgate.net/publication/233711011
- Crest ocean, dynamic waves shader + docs — https://github.com/wave-harmonic/crest , https://crest.readthedocs.io/en/4.15.2/user/ocean-simulation.html
- Ottosson, *Real-time Interactive Water Waves* (Frostbite MSc) — https://media.contentapi.ea.com/content/dam/eacom/frostbite/files/water-interaction-ottosson-bjorn.pdf
- Yuksel, House, Keyser, *Wave Particles*, 2007 — https://www.cemyuksel.com/research/waveparticles/
- NVIDIA WaveWorks 2.0 in ATLAS — https://developer.nvidia.com/blog/nvidia-waveworks-2-0-debuts-in-grapeshot-games-atlas/
- Söderström, Karlsson, Museth, *A PML-based nonreflective boundary for free surface fluid animation*, TOG 2010 — https://dl.acm.org/doi/10.1145/1857907.1857912
- Optimal sponge layer for water wave models — https://www.sciencedirect.com/science/article/abs/pii/S0029801818309417
- No WebGPU FFT millisecond benchmarks were found; GPU cost figures above are `[C]` scaled from this repo's own measured ocean FFT (`docs/performance-analysis.md:210-227`). CPU FFT figures are `[M]` from a scratch node benchmark (5 radix-2 2D FFTs on Float32Arrays, M-series Mac): 64² 0.46 ms, 128² 2.02 ms, 256² 18.8 ms per eWave-like step.
