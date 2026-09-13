# W5: foam, slick and bow spray from the sim wake (SPEC T171)

Status: CPU/codegen-verified. The browser checks are **PENDING** (§6); they were deferred because the user's GPU is saturated.
Date: 2026-09-13. SPEC: §T.171, plus V100, V101, V102, V10, V77, V40, V28, V48, V62, V80, and T59 / T70.
Companions: `wake-research.md` §5.4 (foam) and §3.4 (spray sheets, prop wash), `w2a-source-model.md` §6 (no steady bow crest), `w2b-integration.md` (the sim surface).

Legend: `[M]` means measured in this repo. The scratch instruments are gitignored:
`tests/zzScratchW5Fingerprint.test.ts` (hashes) and `tests/zzScratchW5Calib.test.ts` (calibration readouts).

---

## 1. Foam (R) and slick (G) from the sim: `src/flowfoam/simFoam.ts`

With `wakeBackend: 'sim'`, both flowfoam tiers inject `.r`/`.g` from the solver field that displaces the ocean. The
analytic injector is **not evaluated** on that backend any more: the near tier gets a zero field for its doses (the
surface still comes from `simInjection.ts`), and the far tier gets the zero field plus the sim doses. The analytic code
stays for pirate until W6 (§T.172).

There is one expression, `simFoamRate<T>(arith, inputs, params)`. `simFoamRateCpu` instantiates it for numbers and
`createSimFoamField().rateNode` instantiates it for TSL nodes (V77: one expression, not two that happen to agree).

| term | formula | grounding |
|---|---|---|
| breaking B | `smoothstep(0.30, 0.44, \|∇η_vis\|)` | 0.44 is the Stokes limit (H/λ ≈ 1/7 ⇒ ka ≈ 0.44); 0.30 is the onset from research §5.4. For a deep-water mode the vertical acceleration is g·k·a, so the slope criterion **is** the a > αg criterion. These are constants, not params. |
| bury / emerge | `max(0, −u·∇h_P)` / `max(0, u·∇h_P)` | ∂h_P/∂t = −u·∇h_P is the rate at which the moving hull displaces water at a fixed world point. h_P is the splatted pressure head, i.e. her immersion field from the same buoyancy stations (V101). The bow buries; the transom emerges (separation). |
| lift | `liftFraction(U, D) = min(1, U²/(2g·D))` | Bernoulli: the stagnation head can lift only the top U²/2g of a D-deep column. The bow spray uses the same function. |
| churn | `lift·(bury + simSternChurn·emerge)/D` | Normalising by D makes one passage lay a dose ∝ lift (scale-free across raft and galleon, §V66). |
| **foam** | `simBreakRate·B + simChurnRate·churn` | |
| **slick** | `simSlickPerFoam·foam` | Turbulence proxy: the lane is laid where the whitewater was made, and it outlives the whitewater by `slickHalfLife`. |

GPU side (compute, `textureLoad` only, no material binding):
- a bilinear resample of the solver `slopeTexture` (channels by `WAKE_TEX_CHANNEL`)
- the bilinear gradient of `headTarget.r`, twinned on the CPU by `simHeadGradientCpu`
- the same sponge edge window as the surface resample
- the **same centre uniform** as the surface resample (`simInjection.uSimCenter`), so paint and shape cannot drift apart

u comes from `setShip` (heading × speed over water), recorded by a sim-only wrapper; the analytic `setShip` is
untouched. D is `wakeSim.sources.depthBins().d1`. Every uniform is finite-guarded (V28).

**Calibration `[M]`** (raft-2 preset, CPU solver, 256² × 0.5 m, 2 m/s, fixed probe; `zzScratchW5Calib`):

| readout | value |
|---|---|
| D / h_P peak / lift | 0.300 m / 0.309 m / 0.680 |
| centreline dose per passage | 0.49; predicted 0.35·0.68·2·(0.309/0.300) = 0.49 |
| dose at 1 / 2 / 3 / 4 m off the track | 0.36 / 0.36 / 0.11 / 0.005 (half-beam 2.5 m) |
| near-tier coverage just behind the transom | 0.31 centreline, 0.23 at 1–2 m |
| slick | 0.46 |
| max sim slope | 0.18, below the 0.30 onset, so the raft makes no breaking foam ("raft gurgle only", research W5) |

The analytic raft trail was 0.36 / 0.25 / 0.15 against the ocean's dissolve gate (0.005 + U[0, 0.22]), so the sim trail
lands in the same band. `simBreakRate` 1.2 is not calibrated against a hull, because no shipped raft wake breaks. It is
**PENDING** the galleon wiring and the browser.

**Cost.** The sim near advect WGSL fell from 217 976 B to 183 779 B, because the 48-segment track walk is gone from both
tiers. The pass adds 8 `textureLoad`s per near texel and 8 per far texel. GPU ms is **PENDING** (§6.5).

## 2. Bow pile-up and spray from contact: `src/foam/sprayMath.bowContactEmission`

A bluff bow makes no steady linear crest at these Froude numbers (w2a §6, Noblesse 2008), so the "heaving water out"
comes from contact. The model walks the `hullContact` waterline outline: the segments between slices, per side, plus
the stem face when slice 0 has breadth. For each segment:

```
v_n = u·n̂ (relative normal velocity, hull into water)     d = max(0, draft + mean station depth)
q   = v_n · min(d, v_n²/2g) · Δl        (v_n > 0 only)
rate  = bowLiftRate·Σq + bowSlamRate·slam      sheet = cruiseSheet + (1−cruiseSheet)·max(lift̄, slam)
```

- Over an entrance, Σ v_n·Δl = U × projected width, whatever the shape.
  - A fine bow lifts less water because its shoulders have a small v_n.
  - The aft run throws nothing.
- The slam is `bowEmission`'s own: burial rate on the thresholds it shares with the audio.
- The spawn point is still the surface-snapped `cutwater.world`. The GPU spawn shader is unchanged.
- `bowLiftRate` 205 is calibrated `[M]` so the raft at 2 m/s on her marks throws what the §T.161 ramp gave her:

  | speed | flux | rate (particles/s) | old `speedScale` ramp |
  |---|---|---|---|
  | 0.5 m/s | 0.014 m³/s | 3 | — |
  | 2 m/s | 0.90 m³/s | 185 | 185 |
  | 3.4 m/s | 3.30 m³/s | 677 | 407, saturated |

  Spray now keeps rising with speed instead of plateauing.
- **Wiring.** `BowState.contact` is opt-in.
  - The raft passes her `hullContact` arrays and `raftSeaParams.hullDraft` through a stable getter object in
    `raftFrame.ts`.
  - The pirate page passes nothing, so it keeps the legacy ramp and stays bit-identical.
- **Bow whitewater on the water** (as opposed to the particles) is §1's bury term at the footprint's front rim.

### What happened to `raftWakeParams.speedScale`

- **Spray: retired.** `raftFrame.ts` no longer passes it; the contact model reads no speed scale.
- **Still referenced:** `raftScene.ts:68` → `seaScene.ts:69` `flowFoam.setSpeedScale`.
  - On the sim backend it now reaches only the analytic CPU track (`advanceWake`'s min speed and mound lag, and the
    unread `bowDrive` getter). Nothing drawn reads it. That is a V62 dead knob on this backend.
  - It is live only on the `raft.html?wake=analytic` A/B leg.
  - It is not deleted: the A/B leg needs it. W6 removes it together with the analytic injector.

## 3. T59: wake foam and bow spray readable against whitecaps

- **Bow spray: fixed where the measurement pointed.**
  - T59 measured distFade 0.64 at 37 m, because ship-attached spray sat inside the crest-mist camera fade (25/55 m).
  - `SprayPoolOptions.fadeNear/fadeFar` are per-pool overrides. They change uniform values only, so the sprite WGSL
    is identical.
  - In contact mode the bow pool uses `bowContactFadeNear/Far` (60/120 m): full strength at the follow cam's 30 m slant
    and at 37 m.
  - The pirate page (no contact) keeps the shared fade, bit-identical.
  - Per-pool **opacity** was not changed (0.053 peak additive). Density is already the documented lever, and a new
    opacity number needs the browser. **PENDING** §6.4.
- **Wake foam vs whitecaps.**
  - The ocean material already keeps wake foam on its own mask and colour (`wakeFoamColor`, `wakeFoamDepth` optical
    depth, `surfaceMaterial.ts` §V.10 block), so it never merges into the whitecap mask.
  - W5 adds no fragment sampler (V40: `oceanBindingBudget` unchanged; ocean WGSL byte-identical in both backends).
  - W5 keeps the sim doses inside the dissolve gate band (§1) so the trail has structure rather than a slab.
  - An age term would need the material (`surfaceMaterial.ts`, not W5's). **Leftover**, see §7.

## 4. Pirate: bit-identical evidence `[M]`

Hashes were taken before any W5 edit and after, with `zzScratchW5Fingerprint`:

| | before W5 | after W5, `createFlowFoam()` | after, `'sim'` (raft tier) |
|---|---|---|---|
| bow spray compute + sprite WGSL (legacy call) | `3a7b389d…2b24` | `3a7b389d…2b24` | — |
| ocean material WGSL (118 538 B) | `4da186d2…ca34` | `4da186d2…ca34` | **`4da186d2…ca34`** |
| flowfoam compute WGSL (4 passes) | `cebaea3a…70e5` | `cebaea3a…70e5` | `a3d5ad63…3136` (183 779 B) |
| analytic CPU mirror | `1cdd6dac…cbbc` | `1cdd6dac…cbbc` | — |

The permanent pin lives in `tests/wakeFoamSim.test.ts` §5: four canonical FNV fingerprints, 219 518 B, taken on the
proven-identical tree.

## 5. Tests

`npx tsc --noEmit` → **exit 0**.

Full `npx vitest run` → **exit 1**: 3457 passed, 31 skipped (all in the 15 gated `zzScratch*` files), **1 failed**.
The failure is `tests/terrainQuickWins.test.ts` "bakes a 256² slice island inside 50 ms", the known timing-flaky test.
Run alone it passes 13/13.

**`tests/wakeFoamSim.test.ts`** (11 tests):
1. A calm field → [0, 0]. Sine waves at ka 0.1 / 0.25 / 0.299 → 0 at every phase. At ka 0.5, foam > 0 exactly where
   |∇η| > 0.30, and = `simBreakRate` past 0.44. Monotone.
2. Towed pond (128², Fr 0.45):
   - forcing 1e4 N (max slope < 0.30) → zero breaking foam
   - forcing 2e4 N → foam centroid 16.96° and peak 18.25° against the solver's own envelope α_max 17.25°, both within 2°
     (a lateral offset under 0.9 m at mid-band), and not on the track
3. The raft at rest for 15 s → the whole grid injects exactly 0 (V102 analogue). Towed at 2 m/s, the centreline dose is
   within 15% of the model's stated dose, the lane stays inside her beam, and there is no breaking.
4. V28:
   - any NaN/∞ input → [0, 0]
   - the GPU uniforms keep the last good pose and floor non-finite params
   - 4b: the far advect binds the solver's centre vec2 exactly once, and the head texture
5. The analytic flowfoam WGSL pin; liveness (the sim passes differ).

**`tests/wakeFoamBow.test.ts`** (10 tests):
1. Emission scaling:
   - box bow: flux = U·d·beam, and doubling U or d doubles flux and rate
   - past d = U²/2g, flux stops growing with immersion
   - at rest 0; going astern, the stem throws 0; leeway: the flank throws, symmetric
   - airborne 0; a slam throws with the hull stopped
2. The raft without a speed scale:
   - more than 100/s at 2 m/s, less than 5% of that at 0.5 m/s, monotone
   - the emitter actually runs contact mode (a spawn dispatch where the unscaled ramp spawns none)
   - `raftFrame` feeds `contact` and no `speedScale` (code scan, comments stripped)
3. V28: NaN velocity, burial, draft or station depth → 0.
4. T59:
   - contact fade = 1 at 30 m and 37 m; the mist fade < 0.75 at 37 m
   - the pool binds the bow fade in contact mode and the shared fade in legacy mode, with identical sprite WGSL

**Re-cut** `tests/wakeBackend.test.ts` §3a, handed over by the coordinator:
- W2b's "far tier WGSL identical between backends" pinned a decision W5 moved.
- It now asserts:
  - both advect passes bind the solver slope and head
  - the far pass does not bind height
  - the analytic walk's uniform arrays (`NodeBuffer_`) are in both analytic advect passes and in **no** sim pass
  - the far blur is unchanged; the near blur still differs
- §5b is unchanged. It went green because the foam resample now shares the surface centre uniform instead of adding a
  second one.
- `bandLimitAudit` is back to 176: two `@band-limited-elsewhere` markers in `simFoam.ts`, each with its reason.

**Mutation checks `[M]`** (each applied, the suites run, then reverted):

| # | mutation | result |
|---|---|---|
| M1 | onset 0.30 → 0.20 | 2 fail |
| M2 | breaking ignores slope | 6 fail |
| M3 | churn without lift | 1 fail |
| M4 | churn not ÷D | 1 fail |
| M5 | stern (emerging) churn dropped | 1 fail |
| M6 | GPU hull velocity ignores speed | 1 fail |
| M7 | foam centre = own unwritten uniform | 5 fail |
| M8 | accumulation ignores sim doses | 2 fail |
| M9 | far tier keeps analytic doses | 3 fail |
| M10 | near still evaluates the analytic walk | 1 fail (wakeBackend 3a) |
| M11 | bow flux without the Bernoulli cap | 2 fail |
| M12 | bow immersion ignores draft | 4 fail |
| M13 | bow normal sign flipped | 5 fail |
| M14 | bowSpray ignores `contact` | 1 fail |
| M15 | pool ignores the fade override | 1 fail |
| M16 | raft passes `speedScale` | 1 fail |
| M17 | NaN station depth not dropped | 1 fail |
| M18 | NaN not dropped (sim foam CPU) | 1 fail |

Survivors, stated: `simSternChurn` is 1, so swapping bury and emerge is invisible. `uLift` computed from a constant
speed is not caught when no samples are uploaded (D floor ⇒ lift 1 either way).

## 6. PENDING browser checks (one pass, own snapshot / port / tab, per `docs/agent-browser-harness.md`)

**Setup** is as in w2b §7: tabs **A** `raft.html` (sim) and **B** `raft.html?wake=analytic`. Run
`weatherParams.cellIntensity = 0`, `__game.setFp(false)`, sail up, 2.0 ± 0.2 m/s held for ≥ 70 s.

1. **Raft follow cam**:
   - A white lane starts at her bow rim, thickens at the transom, and runs about 15 m astern in the near tier. The far
     tier carries it on.
   - It is her beam wide (no V of foam at 19°, because her arms do not break).
   - The glassy slick lane lies under it and outlasts it.
   - Capture A and B from the same pose.
2. **Wake foam aligned with the displaced arms**:
   - Grazing/wireframe view as in w2b §7.3. No foam band may sit off the displaced crests.
   - The raft should show no arm foam at all. If any appears, log `wakeSim` slope max (expected ≤ 0.18).
   - A galleon breaking-arm check needs a sim flowfoam on the pirate page, which means editing `main.ts` (user WIP).
     Leave it for the W2 galleon wiring.
3. **Bow pile-up**:
   - At the stem, a dense low sheet that rises with speed (0.5 → 3.4 m/s): nearly nothing adrift, a real sheet at 2 m/s.
   - Foam wraps the bow rim on the water.
   - Slam: sail into a swell (cells back on) and check that a buried stem throws the high arc.
   - Nothing may spawn in mid-air when the stem lifts.
4. **Readable against whitecaps**:
   - Set `weatherParams.cellIntensity = 1` or raise the wind to whitecap onset (> 3.7 m/s).
   - The bow sheet at the follow cam must not fade with distance (distFade 1 to 60 m). The wake lane must read as the
     wake colour, not whitecap white.
   - If the sheet is still too faint, the next lever is a per-pool opacity (add `opacity` to `SprayPoolOptions`, the
     same pattern as the fade override), not `bowLiftRate`.
5. **Frame time**:
   - Interleave A and B, ≥ 5 legs each, 25-sample min-of-N.
   - Expect A's flowfoam passes to be *cheaper* than before W5 (no track walk).
   - Budget: W5 ≤ +0.1 ms over W2b.
6. **`?wake=analytic` A/B**:
   - Tab B must look exactly as before W5: analytic foam V, `speedScale` still live there.
   - Tab B's **bow spray** now uses the contact model too, because `raftFrame` passes `contact` whatever the backend.
     Compare the sheet between A and B: it must be identical.

## 7. Leftovers, deviations, hooks

**T59, still open:**
- Per-pool opacity for bow spray, a browser call.
- An age term that separates old wake foam from whitecaps. It needs `surfaceMaterial.ts` (not W5's): a second read of
  the same `foamTexture` channel costs no binding, but the material owner must do it.
- Crest mist is untouched.

**T70 (lapping), not solved by W5:**
- Relative **vertical** motion is invisible to the sim churn. u only enters through `setShip`; heave and pitch in a swell
  do not.
- The data exists at `raftFrame.ts:126` (`vessel.hullContact.update`, whose `rate[]` is the per-station burial rate).
- Proposed hook: `flowFoam.setHullBurial(planeA, planeB, planeC)`, a least-squares plane of `rate[]` over station world
  XZ, called right after line 126. On the GPU, `bury += h_P·rate(x,z)/D`. That is one expression inside `simFoamRate`,
  adding 3 uniforms and no textures.
- Not built, because it needs a raftFrame line beyond spray wiring and a browser judgement of "lapping".
- The V10 capture is still the only zero-speed hull foam, and `setWaterPlane` still has zero callers (V62, research §1).

**Deviations:**
- **`src/flowfoam/index.ts` was edited** (not in the ownership list; the backend switch lives there). The W2b follow-up
  agent edited it concurrently (`warmAsync`); the two change sets merged cleanly.
- **`tests/wakeBackend.test.ts` §3a was re-cut**, at the coordinator's request.
- **On the sim backend the analytic injector is not called at all**, where W2b called it for doses. That is cheaper, and
  it means the far tier's graph differs between backends.
- **The raft's bow spray uses the contact model on both backends**, because spray is not backend-switched.
- **Breaking reads the wake slope only**, not wake + ambient. The ambient sea slope is not in the flowfoam compute.
  Wake crests riding a steep swell will under-break.
- **The far tier point-samples the sim at its 2.5 m texels** (no prefilter).
  - This is harmless for churn, which is beam-scale.
  - Breaking bands narrower than about 5 m would alias there. The raft never breaks; revisit at the galleon wiring.
- **Single hero velocity** (W4). The prop wash is designed as `PropWashInput` in `simFoam.ts`, not wired. The planned
  injection is foam ∝ (V_j − U)·lift along the jet with V_j = √(U² + 2T/ρA).
- **The foam CPU mirror has no consumer yet.** Audio does not read foam today; any future reader must call
  `simFoamRateCpu` (V77).
- **V101 residue.** Sim churn reads the buoyancy stations (via h_P), while bow spray reads `hullContact`: two samplers of
  the same hull. It is carried over from W2a/W2b.

**Files:**
- new: `src/flowfoam/simFoam.ts`, `tests/wakeFoamSim.test.ts`, `tests/wakeFoamBow.test.ts`, this doc
- edited: `src/flowfoam/accumulation.ts` (`AccumProfile.simFoam`), `src/flowfoam/index.ts`, `src/foam/sprayMath.ts`
  (`liftFraction`, `bowContactEmission`), `src/foam/bowSpray.ts`, `src/foam/sprayPool.ts`, `src/params/spray.ts`,
  `src/params/flowfoam.ts`, `src/raft/raftFrame.ts` (spray contact only), `tests/wakeBackend.test.ts` (§3a)
- not touched: `simInjection.ts`, `main-raft.ts`, `buoyancy.ts`, `stationSources.ts`, `main.ts`, `loop.ts`,
  `postPipeline.ts`, `params/post.ts`, cine, grade, `hullWater`, `rigidBody`, speedboat, sim-worker, `surfaceMaterial.ts`,
  SPEC.md
