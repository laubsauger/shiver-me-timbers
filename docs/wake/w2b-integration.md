# W2b: the sim wake in the shared ocean path, raft first

Status: CPU/codegen-verified. The browser checks are **PENDING** (§7); they were deferred because the user's GPU is saturated.
Date: 2026-09-13. SPEC: §T.169 (raft wake from her waterplane), the §V8 amendment (§T.168–§T.170), plus V40, V100, V101, V104, V105, V28 and V2.
Companions: `wake-research.md` §5 (rendering), `w2a-source-model.md` (source contract and tiers).

Legend: `[M]` means measured in this repo (vitest / headless codegen). Scratch instruments are gitignored:
`tests/zzScratchW2bFingerprint.test.ts` and `tests/zzScratchW2bRaftTrim.test.ts`.

---

## 1. Design: one switch, same channels, no material change

`createFlowFoam({ wakeBackend, wakeTier })`, passed through by `buildSea(..., { wakeBackend, wakeTier })`.

- **`'analytic'`** is the default. The pirate page (`main.ts` → `createFlowFoam()`) and the speedboat lookdev use it. It is the pre-W2b graph, byte for byte (§2).
- **`'sim'`** is selected by the raft page (`raftScene.ts`, tier `WAKE_RAFT_TIER` = 256² × 0.5 m).
  - flowfoam constructs a `WakeSim` (`src/wake/wakeSim.ts`) around `WakeSolverGpu`.
  - The near tier's advect pass then takes the wake's **surface** from the solver (`src/flowfoam/simInjection.ts`):

| channel | analytic | sim |
|---|---|---|
| `elevTexture.r` (ocean **vertex** displacement) | analytic elevation | solver `heightTexture.r` (η_vis), bilinear, edge-windowed |
| `foamTexture.ba` (ocean **fragment** slope) | analytic crest + mound slope | solver `slopeTexture.ba` (∂η/∂x, ∂η/∂z), not blurred |
| `foamTexture.r` foam / `.g` slick | analytic doses | **unchanged analytic doses** (W5, §T.171, replaces them) |
| far tier (256² / 640 m) | analytic doses | identical graph (doses only) |

- **What is removed, and only that.** In sim mode the analytic injector is called with `detail = false`, the path the
  far tier already runs. That drops exactly the transverse and divergent crests, the bow-mound slope and their
  elevation. The foam and slick rates it returns are the same expressions (`detail` reaches only
  `slickFieldNode`'s crest branch and `bowSlopeNode`). The analytic code stays until W6 (§T.172).
- **`.ba` blur exclusion** (research §5.3): a new `AccumProfile.blurSlope` option, false for the sim near tier.
- **The ocean material is untouched.** `surfaceMaterial.ts` still reads `wakeHeightNode` (vertex) and
  `wakeSlopeNode` / `wakeSmoothNode` (fragment) off the same flowfoam textures. The sim textures are read in a
  **compute** pass through `textureLoad`, so they are not material bindings.
- **Edge window.** A per-axis smoothstep runs from 0 at the grid border to 1 at the sponge's inner edge
  (15% of the domain, 19.2 m for the raft). The absorbing layer is not wake, so the border cannot draw a seam.

### Tick/frame split (V2 + V104 + V105)

- **Fixed tick** (`raftFrame.tickSea`):
  - `stepShipBuoyancy(raft, cpuOcean, dt, raftSeaParams, undefined, wakeSamples)` writes the 54 wake samples from
    its own station loop (`writeStationSample`, the hydrostatic share of each station's force at this tick's
    immersion). It is the same loop that floats her (§V101/§V77, closed in W2b-2, §8).
  - then `wakeSim.tick(raft, wakeSamples, stationFrame(raftSeaParams).stem, dt)`
  - The tick anchors the domain on the raft's **sim pose** (`wakeAnchor`, bow-anchored, texel-snapped). No camera
    reaches `wakeSim.ts`.
  - It uploads the samples and **banks** the tick's dt.
- **Render frame** (`flowFoam.update`, already called in `renderSea`):
  - `wakeSim.step(renderer)` runs one splat plus **one** `renderer.compute(35 nodes)` group, advanced by the banked
    sim seconds.
  - A frame with no tick behind it dispatches nothing.
  - The advect pass then resamples about the centre that group scrolled to.
- **Why the split.**
  - Stepping in the tick dispatches N groups on a slow frame (a V104 breach).
  - Stepping on frame dt makes the pattern depend on frame rate (a V2 breach).
  - The integrator is exact for any Δt (V103), so merging ticks changes forcing hold only.
- **Limit.** A frame slower than `WAKE_MAX_DT` (100 ms, 10 fps) drops the excess wake time. That is visual-only.

### CPU cost `[M]`, raft in the shipped sea, per tick

| item | W2b-1 | W2b-2 |
|---|---|---|
| sample emission | `stationSamples`, 54 extra `pressureHeadAt`: 0.050 ms | inside `stepShipBuoyancy`: within timer noise (0.054 with vs 0.057 ms without, 2 runs) |
| `stationFrame` | 0.0045 ms | 0.0051 ms |
| `wakeSim.tick` | 0.0054 ms | 0.0045 ms |
| **total wake cost per tick** | **≈ 0.06 ms** (over the 0.05 ms budget) | **≈ 0.007 ms** |

## 2. Pirate: bit-identical evidence

**(a) Fingerprints.** `zzScratchW2bFingerprint` builds the **shipped** ocean-surface material headless (vertex +
fragment WGSL) plus every flowfoam compute shader, and hashes the analytic CPU mirror over a 300-tick curved tow.
It was run before any edit and again after `[M]`:

| | before W2b | after, `createFlowFoam()` | after, `{wakeBackend:'analytic'}` | after, `'sim'` (raft tier) |
|---|---|---|---|---|
| ocean material WGSL (118 538 B) | `4da186d2…ca34` | `4da186d2…ca34` | `4da186d2…ca34` | **`4da186d2…ca34`** |
| flowfoam compute WGSL (4 passes) | `cebaea3a…70e5` | `cebaea3a…70e5` | `cebaea3a…70e5` | `3ff4452f…0f3c` |
| analytic CPU mirror | `1cdd6dac…cbbc` | `1cdd6dac…cbbc` | `1cdd6dac…cbbc` | — |

- The sim backend leaves the **ocean material WGSL identical**. That proves no binding changed in either stage.
- Only the flowfoam compute changes, in exactly two passes:
  - near advect: +2 `texture_2d` + 2 samplers (the solver height and slope; compute stage, 4 samplers total)
  - near blur: `.ba` passthrough
- Both far-tier passes are identical.

**(b) Permanent tests.** `tests/wakeBackend.test.ts` §1–§2. Existing suites stay green: `trimUnderWay`, `wakeSea`,
`wakeFinish`, `flowfoam` and `oceanBindingBudget`, which is unchanged (fragment 15 samplers / 17 textures,
vertex 6/6). No ledger file changed.

## 3. §V8 amendment on the raft: what she no longer feels

- **How `setWakeField` is used.** `buildSea` wires `cpuOcean.setWakeField(flowFoam)`.
  - `heightAt` adds `wakeHeightCpu(x, z, 0)`: the geometry readers (waterline, hullContact, bow immersion, camera).
  - `pressureHeadAt` adds `wakeHeightCpu(x, z, smithDepth)`: buoyancy.
- **Change.** In sim mode `flowFoam.wakeHeightCpu` returns 0, so one wiring serves both backends.
  - Her buoyancy is **bit-identical to no wake field**, whether the sim is fed or idle (test §4).
  - The pirate path is unchanged: `main.ts` does its own `setWakeField(flowFoam)` on an analytic flowfoam.
- **Consequence `[M]`.** The raft was towed kinematically along +z with `raftSeaParams` and the shipped
  `speedScale` 0.35. Figures are the second half of a 60 s run. "Coupled" means the OLD analytic wake is in her
  mirror (what she felt before W2b); "off" is what she feels now:

| sea | U | mean pitch coupled / off | mean heave coupled / off | max \|Δpitch\| | max \|Δheave\| | analytic wake peak under hull (geo / Smith head) |
|---|---|---|---|---|---|---|
| flat | 1 m/s | 1.024° / 0.571° | +1.67 cm / 0 | 0.45° | 1.67 cm | 33.3 / 24.8 cm |
| **flat** | **2 m/s** | **1.422° / 0.571°** | **+3.10 cm / 0** | **0.85°** | **3.10 cm** | **60.9 / 45.9 cm** |
| flat | 3 m/s | 1.345° / 0.571° | +3.21 cm / 0 | 0.77° | 3.21 cm | 63.9 / 47.4 cm |
| shipped (calm default) | 2 m/s | 1.176° / 0.470° | −18.3 / −20.9 cm | 1.70° | 8.40 cm | 60.8 / 45.8 cm |

- Pitch is + bow up. The 0.571° flat "off" is her static `cgOffsetZ` trim.
- Read: the analytic field put a 0.46 m Smith-head mound under her. It lifted the bow by **0.85°** and the hull by
  **3.1 cm** at 2 m/s in flat water, and by up to 1.7° / 8.4 cm instantaneous in the shipped sea.
- That coupling is gone while the sim is on. It returns only with the CPU band (§T.170).
- The sim's own raft wake is ≤ 0.15 m peak-to-trough (w2a §2), about 4× smaller than the analytic mound she was
  floating on.
- **Geometry readers lose the wake too** (V8a is "visual-only"): `hullContact` wetline, bow-spray immersion and the
  camera water height no longer see wake elevation. The residual is ≤ the sim's 0.09 m raft peak. It is stated,
  not compensated.

### `raftWakeParams.speedScale`

- **Surface: retired in sim mode.** No elevation or slope term is computed from the analytic ramp.
- **Still live:**
  - `flowFoam.setSpeedScale`: the analytic **foam and slick doses** (`foamTexture.r/.g`), until W5.
  - `bowSpray.update({ speedScale })` in `raftFrame.renderSea`: spray is W5's too.
- It is not deleted: removing it would change her foam and spray.

## 4. Files touched

- `src/flowfoam/index.ts`: `WakeBackend`, options, `wakeSim`, `wakeHeightCpu` → 0 in sim mode, the step and
  centre write in `update`, and dispose. No new texture call sites, so the V40 tripwire count is unchanged.
- `src/flowfoam/simInjection.ts` (new): sim resample into the near advect's `{rate.zw, elev}`, with doses from
  `detail = false`.
- `src/flowfoam/accumulation.ts`: `nearProfile(p)` (the old default, exported) and `blurSlope`.
- `src/wake/wakeSim.ts` (new): the tick/frame driver.
- `src/wake/wakeCalibration.ts`: `WAKE_RAFT_TIER` constant, which the `raft-2` preset now references. No physics
  change.
- `src/wake/index.ts`: exports.
- `src/wake/stationSources.ts`: `hullWaterSamples(hw.wake)`, per the physics agent's V101 contract update (plan-column
  `WakeLoadSamples`, all fy ≥ 0). This closes the W2a signed-fy gap. Call site: `tests/wakeSource.test.ts`.
- `src/core/seaScene.ts`: `wakeBackend` / `wakeTier` options.
- `src/raft/raftScene.ts`: selects `'sim'` and `WAKE_RAFT_TIER`. `raft.html?wake=analytic` is the A/B leg.
- `src/raft/raftFrame.ts`: buoyancy-emitted samples plus `wakeSim.tick` in `tickSea`; comment on the bow-spray
  `speedScale`.
- W2b-2:
  - `src/sea-physics/buoyancy.ts`: `wakeOut?` parameter, exported `immersedDepth`, `sizeStationSamples` and
    `writeStationSample`.
  - `src/wake/stationSources.ts`: `stationSamples` becomes a thin reader.
  - `src/wake/wakeSolverMath.ts`: `WAKE_TEX_CHANNEL`.
  - `src/wake/wakeSolverPasses.ts`: the post pass writes by `WAKE_TEX_CHANNEL` (layout only, same channels, no
    physics change) and gains `compileAsync(renderer)`.
  - `src/flowfoam/index.ts`: `warmAsync`.
  - `src/main-raft.ts`: one line, the warm list.
- `tests/wakeBackend.test.ts` (new) and `tests/wakeSource.test.ts` (adapter call site).
- Not touched: `surfaceMaterial.ts` (no wake-hook change was needed), `main.ts`, `loop.ts`, `postPipeline.ts`,
  `params/post.ts`, cine, grade, hullWater, rigidBody, speedboat, caustics, SPEC.md, `bootCompile.ts` (its
  `withFullCoverage` callback already takes any promise, so no generic hook was missing).

## 5. Tests (`tests/wakeBackend.test.ts`, 18 tests)

1. **Pirate.**
   - Default = analytic: no solver, identical ocean and flowfoam WGSL.
   - `main.ts` still calls `createFlowFoam()`.
   - The analytic CPU mirror is live and identical.
2. **V40.** Ocean material WGSL is byte-identical under `'sim'`, and no sim texture is bound on the material.
3. **Raft surface.**
   - Exactly one flowfoam pass (near advect) binds solver height + slope.
   - The far tier is identical and the near blur changed.
   - Node-graph walk: elevation and slope reach the solver textures, never the analytic surface, and the analytic
     injector is only ever asked for `detail = false`.
4. **V8a.**
   - Raft buoyancy is bit-identical with the sim (fed or idle) vs no wake over 12 s at 2 m/s.
   - The analytic coupling moves her by > 5 mm in the same run (liveness).
   - The sim mirror reads 0 where the analytic one reads > 5 cm.
   - The raft page selects `'sim'` and feeds the sim from `stepShipBuoyancy`'s samples in `tickSea` (no
     `stationSamples` or `pressureHeadAt` there).
5. **V105.**
   - Centre = snapped bow anchor for 3 poses and headings, and the stem lies inside the interior.
   - `wakeSim.ts` code has no `camera`.
   - The near advect binds a vec2 equal to the solver centre after a frame.
6. **V104 / V2.**
   - 3 ticks then 1 frame → 1 compute call carrying exactly the 35-node group, 1 splat, and dt = 3·SIM_DT.
   - An idle frame dispatches nothing.
7. **V28.** A NaN pose keeps the centre, a NaN sample drops the vessel, and a NaN dt banks nothing.
8. **`.ba` contract.** The CPU solver's slope correlates > 0.9 with the central difference of its drawn surface
   along world x/z.
   - **8b.** A field sloped only along +x, then only along +z, is packed by `WAKE_TEX_CHANNEL`, resampled by the
     shared expression (`simSurfaceCpu`) and packed by `packSimRate`. It lands in rate.b (x) or rate.a (z) with the
     analytic sign and size (±5%), the other channel is ≤ 5%, and the elevation is within 5 mm.
   - **3b addition.** The TSL instantiation's own channel operator is read off the built node graph: rate.b takes
     only the `SLOPE_DX` swizzle of slope loads, rate.a only `SLOPE_DZ`, elev only `HEIGHT`.
9. **V101 / V77.**
   - Galleon buoyancy over 300 ticks in the shipped sea is bit-identical with and without a sample buffer.
   - The emitted samples `toEqual` `stationSamples` at the pre-step pose with `pressureHeadAt` (galleon, raft,
     90 ticks each).
   - `stationSources.ts` code has no immersion rule of its own.
10. **Warm-up.**
    - `flowFoam.warmAsync` compiles the splat with the head target bound, restores the target, and runs
      `computeAsync(solver.computeNodes)` (35).
    - The analytic backend warms nothing.
    - The raft boot's `withFullCoverage` call includes `sea.flowFoam.warmAsync(app.renderer)` before `loop.start()`.

**Mutation checks** `[M]` (each applied, run, then reverted):

| mutation | result |
|---|---|
| default backend → `'sim'` | 5 fail |
| analytic asked with `detail = true` | 1 fail |
| sim mirror returns the analytic elevation | 2 fail |
| `step` without the tick guard | 1 fail |
| anchor ignores pose | 1 fail |
| advect centre never written | 1 fail |
| `blurSlope` ignored | 1 fail |
| raft tick does not feed the sim | 1 fail |
| near elevation from analytic | 1 fail |
| NaN dt banked | 1 fail |
| slope axes swapped inside the resample (W2b-1 form) | SURVIVED in W2b-1 — closed in W2b-2 (rows below) |
| W2b-2: resample reads `SLOPE_DZ` for x and `SLOPE_DX` for z | 2 fail |
| W2b-2: `packSimRate` swaps b/a | 2 fail |
| W2b-2: resample sign flipped (`cx − wx`) | 1 fail |
| W2b-2: TSL swizzle table swapped (`x,y,w,z`) | 1 fail |
| W2b-2: buoyancy emits nothing | 1 fail |
| W2b-2: emission perturbs the hull (`pos[1] += 1e-12`) | 3 fail |
| W2b-2: raft boot warm call removed | 1 fail |
| W2b-2: warm compiles without the head target | 1 fail |
| W2b-2: `writeStationSample` drops the flood `support` factor | **SURVIVES** — every test hull is intact (support = 1); the shared definition is not independently pinned under flooding |

## 6. Deviations and open items

- **No vertex-Nyquist gate** on the sim displacement (research §5.2). It would need a material change beyond the
  wake hook. It is legal now (visual-only) but not built. Raft wake content is λ ≥ 1 m against 0.6–1.2 m vertex
  spacing within 35 m.
- **Band-limit feature size is unchanged.** `wakeSlopeNode` still gates at near texel × `waveBandLow` = 0.59 m.
  Research §5.3 says sim texel × `waveBandLow` = 1.25 m. The kept value is conservative: no aliasing, but the slope
  fades slightly sooner with distance. Revisit after §7.
- ~~`stationSamples` re-derives buoyancy's immersion rule~~ **closed in W2b-2** (§8).
- **Foam and slick stay analytic** (W5), so the white trail and glassy lane are the old V while the surface is the
  sim's. Expect a mismatch in the browser; it is W5's to close.
- **`wakeHeightCpu` → 0 is implemented in flowfoam**, not by detaching `setWakeField` in `buildSea`. That way any
  future sim page (pirate included) inherits V8a with its own existing wiring.
- **Edge window over the sponge width**: not in the research. It is a boundary treatment, not a shaper.
- ~~First dispatch is not warmed~~ **closed in W2b-2** (§8). Still cold, in both modes and before W2b: flowfoam's
  own advect/blur passes compile on the first `flowFoam.update`.
- **Open, deferred by the coordinator:**
  - the vertex-spacing gate on the sim displacement
  - the slope-fade feature size (both above)
  - the foam/slick mismatch (W5, §T.171)
- **Render rate above 60 Hz**: the field advances in 60 Hz steps (one dispatch per tick-bearing frame). See the
  pulsing check.

## 7. PENDING browser checks (run in one pass, own snapshot / port / tab, per `docs/agent-browser-harness.md`)

Setup:

1. `rsync` the repo to a uniquely named scratch dir and run `npm run dev -- --port 5221` there. Open two tabs:
   - **A (sim)**: `http://localhost:5221/raft.html`
   - **B (analytic A/B)**: `http://localhost:5221/raft.html?wake=analytic`
2. In each tab's console, once `__game` exists:
   ```js
   const { weatherParams } = await import('/src/params/weather.ts'); weatherParams.cellIntensity = 0; // storm cells off
   __game.setFp(false);                      // shipped follow cam
   __game.raftControls.sailUp = true;
   const sp = () => Math.hypot(__game.state.ships[0].velocity[0], __game.state.ships[0].velocity[2]);
   ```
   Set speed to **2.0 ± 0.2 m/s** (3.9 kn). Adjust `__game.state.wind.speed`, or sheet and oar through the debug
   channels, until `sp()` reads 1.8–2.2 m/s. Hold it for ≥ 70 s before judging, which is 1.4·L_dom/U + 10 s of
   start-up.

Checks:

3. **Wake visible, Kelvin arms displaced** (tab A):
   - Behind the raft, a V of short crests (λ_T ≈ 2.6 m transverse) at ~19° half-angle should read in
     **silhouette/parallax**, not only shading.
   - Toggle wireframe or grazing view as in W0 (`w0-20-raft-2ms-followcam.jpg` is the before image) and confirm the
     arms move vertices.
   - Confirm the **lighting agrees with the displacement**: crest faces toward the sun are lit on the sun side. The
     axis/sign chain is now test-pinned (§5, 8b); this is the end-to-end look, including the GPU post writer.
   - Capture follow-cam and FP bow/tiller images for A and B.
4. **No seam, no pulsing** (tab A):
   - Orbit to look ~30–60 m astern and ~25 m ahead. There must be no straight edge or step where the sim domain
     ends (sponge window) or where the flowfoam near region fades (radial).
   - Turn 90° and watch: the domain re-anchors astern texel by texel with no jump.
   - Watch 20 s at a steady heading: no periodic brightness or amplitude pulse, including at 120/144 Hz if the
     display runs above 60.
   - Check for `NaN` / black flecks with `weatherParams.cellIntensity` restored to 1 for 30 s, then back to 0.
5. **Frame time with vs without sim**:
   - Interleave A and B legs, same camera pose, same speed, ≥ 5 legs each, 25-sample min-of-N via
     `queue.onSubmittedWorkDone()` bracketing (harness §4).
   - Report Δ(frame ms) A − B and, if `trackTimestamp` is on, the wake group's GPU ms. Budget: wake ≤ 1.0 ms GPU
     (W1 measured 0.33–0.46 ms at 256²).
   - Confirm there is no first-frame hitch in A once the splash lifts: the sim pipelines are warmed in the boot list
     (§8), so a hitch now means the warm-up missed something.
6. **V8a by eye**: in A, the raft's heave and trim must not respond to her own wake. There is no bow-up settle as
   she gathers way, unlike tab B, where she lifts ~0.85° by the bow at 2 m/s.

## 8. W2b-2: closing three deviations

1. **Slope axis and sign are test-pinned (V80/V77).**
   - The resample and the rate packing are one generic expression (`simSurface`, `packSimRate` in
     `simInjection.ts`) over an operator table. The TSL instantiation runs in the advect pass; `simSurfaceCpu`
     runs it on numbers.
   - The solver-output layout is one table, `WAKE_TEX_CHANNEL` (`wakeSolverMath.ts`). The GPU post pass writes by
     it and the resample reads by it.
   - Tests 8b and 3b cover the chain (§5). The swap, sign and swizzle mutants all fail.
   - **Residual:** the post pass's own `slopeOut[SLOPE_DX] = g.x` assignment is TSL-only. The W1/W2a browser
     `__wakePond.compare` covers it.
2. **Sim pipelines warmed at boot.**
   - `WakeSolverGpu.compileAsync(renderer)` compiles the splat material against `headTarget` (the target is swapped
     only around `compileAsync`'s synchronous walk, as in bootCompile.ts). It then runs the group once with
     `computeAsync`, which is inert: Δt 0, no sources, a state at rest.
   - `flowFoam.warmAsync` exposes it. `main-raft.ts`'s existing `withFullCoverage` callback now returns
     `Promise.all([<scene/post warm>, sea.flowFoam.warmAsync(app.renderer)])`. That is one line changed and the
     entry stays within its 300-line cap.
   - No generic hook was missing in `bootCompile.ts`.
3. **One station loop (V101/V77), and the CPU budget.**
   - `stepShipBuoyancy(..., floodHoles, wakeOut?)` writes one sample per station (dry ones as fy 0) from the
     immersion it has just solved, into a caller buffer resized in place.
   - `stationSamples` is now a reader over buoyancy's exported `immersedDepth` and `writeStationSample`. It is kept
     for the engine-free calibration tows; `wakeSource` and `wakeCalibration` stay green (16/16).
   - **Pirate bit-identity `[M]`** (`zzScratchW2bBuoyHash`: galleon with the analytic wake coupled, brigantine
     flooded 0.3 with a hole, raft; doubled sea; 900 ticks each; state + slam as float64 bits):

     | run | buoyancy hash |
     |---|---|
     | before the change | `680dd6f3…4171` |
     | after, no buffer | `680dd6f3…4171` |
     | after, with buffer (145 800 samples emitted) | `680dd6f3…4171` |

   - Permanent: test 9.
   - Game-path wake cost falls from ≈ 0.06 ms to ≈ 0.007 ms per tick (§1). The in-loop samples use buoyancy's own
     station positions (a re-applied pitch, when sailing stripped it) and its footprint-averaged head. Both kernels
     default to 0.
