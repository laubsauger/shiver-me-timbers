# Performance analysis

Three parts, in dependency order: **the instrument**, **where the time goes**,
**the knobs**. Part 2 is short and honest rather than long and plausible —
several numbers people wanted are marked *not measured*, because they are not
measured.

Provenance is tagged on every claim:

| tag | means |
|---|---|
| **[M]** | measured in-browser this session, method stated |
| **[C]** | read from code (file:line given), not timed |
| **[?]** | unknown — explicitly not measured |

---

## 1. The instrument

### 1.1 What was wrong

`renderer.info.render.timestamp` read a constant **29.688 ms across 90
consecutive frames** (§V.63). The cause is not the constructor parameter — that
was already fixed correctly — and not a missing feature. It is three r180
itself, in three separate places.

**(a) three's pool latches on failure.** `WebGPUTimestampQueryPool
.resolveQueriesAsync()` /
`_resolveQueries()` (`node_modules/three/src/renderers/webgpu/utils/
WebGPUTimestampQueryPool.js`) has **five** early exits — `trackTimestamp` off,
`currentQueryIndex === 0`, disposed, `resultBuffer.mapState !== 'unmapped'`,
and the catch-all `catch` — and **every one of them returns `this.lastValue`**,
the previous successful reading. `Backend.resolveTimestampsAsync()`
(`common/Backend.js:499`) then writes that into `renderer.info[type].timestamp`
with no marker that it is stale. `Info.reset()` does **not** clear `timestamp`
(only `dispose()` does, `common/Info.js:158-161`), so the stale value also
survives the next frame.

> A dead instrument is therefore **indistinguishable from a perfectly steady
> frame**. It reads as a plausible constant, with no warning. That is the whole
> of the 29.688 ms.

**(b) the number was never a frame.** Even when it is live, the value is the
sum over **every pass allocated since the last successful readback**, and
`mapAsync` routinely outruns the frame. Measured on the unpatched build **[M]**:
`pendingResolve` was a live Promise, `resultBuffer.mapState === 'pending'`, and
`lastValue` moved 125.63 ms → 104.66 ms over 500 ms *while the app was drawing
at roughly 68 fps*. A ~100 ms "frame time" on a ~15 ms frame is three or four
frames of passes added together and labelled as one.

**(c) the compute pool was wedged, permanently.** Live snapshot of the
unpatched build **[M]**:

```
compute pool: currentQueryIndex 2048   (= maxQueries)
              queryOffsets.size  530
              lastValue          0
```

`main.ts` resolved only `TimestampQuery.RENDER`, so the **compute** pool — which
is where the ocean FFT lives — filled to capacity on the first few hundred
frames and never recycled. From that point:

- `allocateQueriesForContext()` returns **`null`**, and
  `WebGPUBackend.initTimestampQuery()` (`WebGPUBackend.js:1954-1961`) writes it
  into `beginningOfPassWriteIndex` **unchecked**. WebIDL coerces `null` to `0`,
  so an exhausted pool silently **aliases every subsequent pass onto query pair
  0** instead of erroring.
- 530 unique uids for 1024 allocated pairs ⇒ **~494 uid collisions**. three keys
  `queryOffsets` on a `Map`, so a collision silently drops the earlier pass from
  the sum. The uid is `r:<info.render.frameCalls>:<renderContext.id>`, and
  `frameCalls` resets every frame, so collisions are guaranteed the moment a
  batch spans more than one frame.

**(d) a separate, smaller instrument bug.** The HUD showed
`renderer.info.render.calls`, which is a **lifetime** counter by design —
measured at **206 262** in a session drawing **251–486** objects per frame
**[M]**. `drawCalls` / `triangles` / `frameCalls` *are* per-frame, because
`Renderer.init()` unconditionally starts three's own rAF loop
(`common/Renderer.js:803` → `common/Animation.js:67`) which calls
`info.reset()` every frame **whether or not `setAnimationLoop` is used**.
§B.25's "4238 → 38978 within one build" was the wrong field, not a missing
reset. **Do not add an `info.reset()` call** — there already is one, and a
second one racing three's own rAF callback would undercount.

### 1.2 Verdict: GPU timestamps work. Use them.

They are not dead. On this machine **[M]**:

- adapter and device both expose `timestamp-query`; `backend.trackTimestamp === true`
- query pairs **are** written — 0/0 pairs were rare-to-absent once measured correctly
- **the browser quantises timestamps to 65 536 ns = 0.065536 ms.** Every nonzero
  duration observed, across both pools and hundreds of batches, was an exact
  multiple of 0.065536. **This is a hard floor**: any pass faster than ~65 µs
  reads exactly `0` and cannot be resolved individually. It is not noise, it is
  a grid — treat any single-pass reading of 0.066 / 0.131 / 0.197 ms as
  "1 / 2 / 3 quanta", i.e. ±65 µs.

Wall clock stays void per §V.39 / §B.25 and there is no need to fall back to it.

### 1.3 The replacement — `src/debug/gpuTimer.ts`

New file, installed from `main.ts` immediately after `App.create()` and
**before the first render** (three lazily builds its own pool on first use and
never replaces it). It is a duck-typed stand-in for three's pool. Differences
that matter:

| three's pool | `gpuTimer` |
|---|---|
| returns `lastValue` on any failure | returns `NaN` and counts the miss — **a frame it could not read reports nothing** |
| `null` on overflow → aliases onto pair 0 | dedicated scratch pair, excluded from every sum, counted as `overflows` |
| whole frame collapsed to one scalar | per-pass, keyed on render-context id, labelled with target name + size |
| `Map` keyed on a colliding uid | sequence-suffixed, no pass can be dropped |
| batch sum presented as a frame | divides by the batch's **inferred frame count** (see below) |
| render pool only | **render and compute**, both drained every frame |
| — | `unwritten` counter: 0/0 pairs, i.e. the GPU ignoring `timestampWrites` |
| — | `quantumMs`: smallest nonzero duration ever seen |

**Batch-frame inference.** `mapAsync` takes longer than a frame (measured ~2–4
frames per successful read **[M]**), and the pool keeps allocating while a
readback is in flight, so one batch carries several frames of passes. The frame
count is recoverable from the data: a pass that runs once per frame appears once
per frame, so **the maximum occurrence count across keys is the number of frames
spanned**. Dividing by it yields per-frame *amortised* cost, which is the right
number for a budget — a pass that runs on half the frames should read as half.

`health().batchFrames` exposes it. **If `batchFrames` is large or jittery, widen
your error bars**; it is the dominant source of uncertainty in every render
number below.

### 1.4 How to use it

```js
__perf.report()   // per-pass min-of-60 table, render and compute
__perf.reset()    // drop the window — call at the start of each A/B leg
__perf.health()   // reads / misses / unwritten / overflows / batchFrames / quantumMs
```

The HUD gains a `--- gpu (min-of-N) ---` block: both pool totals, the heaviest
passes, and a `!!` health line that appears whenever `reads === 0`,
`unwritten > 0`, `overflows > 0`, or the last read is more than a second old. It
refreshes every 15 frames.

`__perf.timer === null` means **GPU timing is unavailable on this machine**.
That means *no number*, not "use wall clock".

### 1.5 Measurement protocol (do not skip any of it)

1. **Kill rAF, do not use `__game.setSpeed(0)`** — it does not pause the sim
   (§V.63).
2. **Force the camera.** The renderer is not frame-deterministic across sessions;
   foam blurs once per *rendered* frame and rigging integrates per frame, so the
   same sim tick holds different state at 56 fps and 35 fps (§V.63).
3. **Foreground tab, and do not trust `visibilityState`** — it has been observed
   wrong in both directions.
4. **Do not resize the window mid-capture.** A resize changes every render
   target's dimensions, which fragments the per-pass keys and breaks the
   batch-frame inference. This invalidated three of my capture windows.
5. **`__perf.reset()` between legs**, and compare `min`, not mean. On an
   adaptive-sync display report frame-time **variance**, never a single fps.
6. **Verify which tree the dev server is serving before believing anything.**
   During this session `http://localhost:5234` was served by
   `node /private/tmp/smt-deck/node_modules/.bin/vite` with `node_modules`
   symlinked back to the main tree — the documented trap, live. `curl` a source
   file and grep it for a string you just wrote.
7. One instance at a time. §T.40 records the GPU process dying three times when
   two instances compiled concurrently.

---

## 2. Where the time goes

### 2.1 Conditions of the measurements below

Chrome / WebGPU / Apple Silicon. `devicePixelRatio` **0.8**, `resolutionScale`
1.0, canvas backing store **1920×856 = 1.64 MP**. Medium quality bundle. The
app was being driven concurrently by another agent — it was navigated, resized
and hot-reloaded repeatedly during capture. **This is stated because it bounds
what I am willing to claim.**

### 2.2 Frame structure — measured, stable across every sample **[M]**

- **20 render passes** per frame
- **79–85 compute dispatches** per frame
- **251–486 draw calls**, **1.66–1.82 M triangles**

The 20 render passes, by render-context id:

| # | pass | size |
|---|---|---|
| 0 | scene pass (`output`) | 1920×856, **4× MSAA** |
| 1 | `ShadowMap` | 2048×2048 |
| 2 | god-ray target | 960×428 (half res) |
| 3 | `clouds/cores` | 768×432 |
| 4 | `canvas` — final post composite | 1920×856 |
| 5 | **bloom — 11 passes**: `bright` 960×428, then h0/v0 960×428, h1/v1 480×214, h2/v2 240×107, h3/v3 120×54, h4/v4 60×27 | — |
| 6, 7 | two more god-ray targets | 960×428 |
| 9 | `flowfoam/injection` | 512×512 |

**Bloom is 11 of the 20 render passes in this frame.** That is the single most
striking structural fact in the profile, and it is a *count*, not a timing — it
holds regardless of how fast each pass is.

**The planar reflection pass did not appear in any sample.** 19 of the 20 passes
are accounted for above; reflection is a second full scene render and would be
unmistakable. Either it was disabled in that session's stored settings, the
camera was below the mirror plane (`planarReflection.ts:262` skips), or it is
not running. **[?] — resolve this before trusting any reflection cost number.**

### 2.3 Compute — measured **[M]**

One clean 5 s window, correct key dedupe, `batchFrames` 3.85:

| per-frame compute total | ms |
|---|---|
| min (the defensible number) | **2.05** |
| p50 | 4.96 |
| p90 | 6.49 |

86 distinct dispatch keys per batch. No single dispatch exceeded ~0.15 ms mean;
most sat at 1–2 quanta, i.e. at or below the instrument's resolution. Node-id
clustering (a run of ~60 nodes at ids 958…1199, step 4) matches the code
inventory of the ocean FFT exactly.

**Interpretation:** the ocean FFT is *not* a per-frame problem. 60 dispatches ×
262 144 invocations = 15.7 M invocations/frame **[C]** lands inside a ~2–5 ms
compute budget. The FFT's cost is concentrated in the **rebuild**, not the
evolve.

### 2.4 Render — **not measured. [?]**

I will not quote a render figure. Every capture window was invalidated by a
concurrent window resize or page reload, which fragments the per-pass keys and
destroys the batch-frame inference; raw per-batch sums ranged from 20 ms to
570 ms across samples, which is a statement about the capture, not about the
frame. The rank ordering was also unstable.

What survived as *shape* rather than magnitude, and should be re-measured
first:

- the scene pass and the final canvas composite were consistently the two
  largest single passes
- the bloom chain's small mips (60×27, 120×54) never read anywhere near
  proportional to their pixel count — consistent with **per-pass fixed
  overhead** dominating, which is what 11 passes predicts
- `ShadowMap 2048×2048` was consistently among the **cheapest** passes
  (0.07–0.46 ms observed). This is the strongest available signal that
  **shadow map size is a bad knob** — see §3.
- `flowfoam/injection` was at or below one quantum

### 2.5 CPU — not measured this session **[?]**

The existing HUD rows (`ocean+foam cpu-dispatch`, `clouds cpu-dispatch`) are
wall-clock dispatch times, not GPU. Known CPU hot spots from code **[C]**:

- `cpuOcean.update` — self-documented **1.40 ms/tick at 64²**, 6.06 at 128²,
  23.99 at 256² (`src/sea-physics/cpuOcean.ts:322-324`). Largest single tick item.
- `hullContact.update` — one `heightAt` per station, plus two more slice loops
  (`src/sea-physics/hullContact.ts:257-266, 287, 309, 354`); each `heightAt` is
  a 16-tap Catmull-Rom per cascade.
- `combat.update` — a **1536-iteration loop plus six `BufferAttribute`
  re-uploads every frame regardless of activity**
  (`src/combat/combatFx.ts:461-495`).
- `updateMatrixWorld(true)` on the whole ship subtree **twice per frame**
  (`src/main.ts` ×2).
- `island.update` re-applies `castShadow` and traverses the rock group for all
  5 islands every frame (`src/island/island.ts:256-259`).
- The perf HUD rebuilds and writes `el.textContent` **every frame**
  (`src/debug/perfHud.ts`), unthrottled.

### 2.6 The ocean rebuild — the one confirmed stall

A full 3-cascade spectrum rebuild measures **419 ms warm**, of which **cascade 2
alone is 355 ms** (prior measurement, carried forward). Cascade 2's domain is
**22.7 m** (`src/params/ocean.ts:224`), which keeps λ ≤ 8.3 m
(`splitWavelengths[1]`), so almost no mode is band-rejected and the h0 build
does nearly full work over the whole 512² grid. This is **52 frame budgets** in
one hitch. It is not per-frame — but it fires on any wind/sea-state change.

Three shapes of fix, in preference order (none reduce fidelity):

1. **Amortise.** Rebuild one cascade per frame, or one row-block per frame, and
   swap when complete. Cost becomes invisible; the sea takes a few frames to
   respond to a wind change, which is physically correct anyway.
2. **Rebuild off the critical path.** The rebuild is a pure function of the
   spectrum params; it can target the ping buffer while the pong buffer keeps
   rendering.
3. **Cut cascade 2's h0 grid only.** 512² → 256² for the 22.7 m cascade quarters
   its rebuild and costs detail only in the shortest waves, which are also the
   ones the normal/derivative path already stretches
   (`normalDetailStretch: 3.0`).

---

## 3. The knobs

Ordered by *what they trade*, not by size. The first two groups cost no fidelity
at all; spend them before touching anything below.

Legend: **live** = takes effect immediately · **reload** = construction gate,
needs a page reload · **rebuild** = needs a code change, no param exists.

### 3.1 Redundant work — pure wins, no fidelity cost

| knob | what it buys | evidence | live? |
|---|---|---|---|
| **Ocean FFT no-tick guard** (done, `a87eb98`) | 60 of ~85 dispatches skipped on every frame that ran no tick. On a 120 Hz display that is **half of all frames** | `src/main.ts` guard; provably bit-identical output — `OceanSimulation.update` reads only `time` + `oceanParams` | live |
| **Spray + bow spray at display rate** | Same shape, not yet done. Both are called from the *render* callback (`src/main.ts`) but integrate with `SIM_DT` (`src/foam/spray.ts:287`, `src/foam/sprayPool.ts:212-222`). At 120 Hz the particles advance at **2× wall rate** *and* cost 2× the dispatches. Fixing it is a **correctness fix that also halves the work** | **[C]** | code change |
| **`combat.update` early-out** | Skips a 1536-iteration loop and **six `BufferAttribute` uploads per frame** when the pool is empty — i.e. almost always | `src/combat/combatFx.ts:461-495` **[C]** | code change |
| **Throttle the perf HUD** | String build + `textContent` write + DOM layout every frame | `src/debug/perfHud.ts` **[C]** | code change |
| **Cache `updateMatrixWorld` / island `castShadow`** | Two full ship-subtree matrix walks and five `rocks.group.traverse` calls per frame, for values that change slowly | `src/main.ts` ×2, `src/island/island.ts:256-259` **[C]** | code change |
| **Drain the compute timestamp pool** (done) | The compute query set had been full since early boot, aliasing every dispatch onto pair 0 for the whole session | §1.1(c) **[M]** | live |

### 3.2 Dead configuration — fix before tuning anything

- **`QUALITY_PRESETS` has zero consumers.** `oceanResolution`, `cloudRtScale`,
  `foamBlurPasses`, `maxAnisotropy` (`src/ui/settingsStore.ts:102-106`) are read
  by exactly one caller in the repo, a test. No engine code reads them **[C]**.
  Anyone tuning "quality" via this table is tuning nothing.
- **`low` disables `postFx` but leaves `postBloom` / `postVibrance` /
  `postVignette` on** (`settingsStore.ts:148`) — three switches that cannot do
  anything with the chain off.
- **`medium` and `high` differ only in `shadowMapSize` (2048 vs 4096) and
  `foliageDensity` (0.75 vs 1).** Identical feature sets, identical
  `resolutionScale`. And the shadow pass is measured to be one of the *cheapest*
  in the frame (§2.4). **`high` therefore costs almost nothing more than
  `medium`** — the tier is close to cosmetic, and the real gap is medium→low,
  which comes almost entirely from `resolutionScale 0.75` plus dropping the
  whole post chain.
- **`rain.enabled` and `spray.enabled` do not exist** as params
  (`src/params/rain.ts`, `src/params/spray.ts`); spray works only via a sink in
  `main.ts`, rain is reported by `unwiredFeatures()` **[C]**.
- **`shadows` names `sky.shadowsEnabled`, which lives in
  `src/params/oceanSurface.ts:453`**, not `params/sky.ts` **[C]**.

### 3.3 Resolution of intermediates — cost for pixels, not for design

These change how many pixels a stage touches without changing what it draws.

| knob | current | range | what it costs | what it changes visually | live? |
|---|---|---|---|---|---|
| **`resolutionScale`** | 1.0 (med/high), 0.75 (low) | 0.5–1 | **The single biggest lever.** Scales the scene pass, the *entire* bloom chain, all three god-ray targets and the canvas composite together — i.e. 15 of the 20 render passes | overall softness; the honest first knob | **live** (`main.ts`, `setPixelRatio`) |
| **`godRayScale`** | 0.5 | 0.1–1 | Sizes the three god-ray RTs (960×428 today) | shaft softness only; shafts are low-frequency by nature, so this is cheap fidelity | **reload** (`postGodRays.ts:156`) |
| **AO `resolutionScale`** | **0.5, hardcoded** | — | Not a param at all (`postPipeline.ts:200`). Should be one | AO contact softness | **rebuild** |
| **`reflection.resolutionScale`** | 0.5, **hard-clamped ≤0.5** | 0.05–0.5 | The reflection is a second full scene render; halving again quarters its pixels | mirror sharpness — already half, so further cuts show | **live** (`planarReflection.ts:255`) |
| **`clouds.rtWidth/rtHeight`** | 768×432 | — | One offscreen render + two 13-tap blur dispatches | cloud edge crispness | **reload** |
| **`flowfoam.resolution` / `farResolution`** | 512 / 256 | — | 4 compute dispatches + one whole-scene injection render | wake detail near the hull | **reload** |
| **MSAA `samples`** | **4** (`antialias: true`, `app.ts:92`) | 0/2/4 | The scene pass renders at 1920×856 **×4**. This is pure bandwidth and it is paid on the heaviest fragment shader in the project (the ocean) | rope, yard and rigging edges — this scene is full of one-pixel geometry, so it is *expensive to lose* | **reload** (renderer ctor) |

> **The MSAA / AO interlock is the trap that already bit.** `readsDepth =
> aoEnabled \|\| dofEnabled` forces the scene pass to `samples: 0`
> (`postPipeline.ts:136-139`) — WebGPU cannot resolve a multisampled depth
> attachment. **Turning AO on silently turns MSAA off for the entire frame.**
> The param file refused AO for exactly this reason and `QUALITY_BUNDLES`
> overrode it anyway until `2945b3b`. Any preset that enables AO is choosing
> "ambient occlusion instead of anti-aliasing" — state it that way when
> presenting the option, or don't offer it.

### 3.4 Update rate — cost for latency, not for detail

| knob | current | opportunity | live? |
|---|---|---|---|
| **Planar reflection** | every frame | Every-other-frame with reprojection, or gate on camera motion. It is a **second full scene render**, previously measured at **+0.9–1.1 ms and 367→556 draw calls** (`src/params/reflection.ts:64-66`). Only lever today is the binary `rp.live` | **live** (binary) |
| **Shadow map** | every frame, everything casts | Re-render only when the sun or the ship moves past a texel threshold. The frustum is only 80 m and already texel-snapped (`sky/lighting.ts:145+`). **But §2.4 says this pass is cheap — do this for CPU/draw-call reasons, not GPU** | **rebuild** |
| **Clouds** | every frame, deliberately | `main.ts` documents *why* it is excluded from the ocean guard (camera-dependent refit + view-space sun basis + offscreen pass) and states the expensive part **is** the camera-dependent part. Believe the comment | — |
| **Foam shading uniforms** | every frame | The blur/decay is already on the fixed clock; only the display-side refresh is unconditional (`src/foam/index.ts:439`) | **rebuild** |
| **Ocean rebuild** | one 419 ms hitch | Amortise across frames — see §2.6. **The highest-value item on this page** | **rebuild** |

### 3.5 Pass structure — the biggest untapped lever

**Bloom costs 11 render passes** (§2.2). three's `BloomNode` owns a fixed
5-level mip chain; `bloomRadius` only shapes how the levels are combined and
there is **no mip-count param** (`postPipeline.ts:226-229`, `src/params/post.ts`)
**[C]**. At 1920×856 the bottom mips are 120×54 and 60×27 — sizes at which a
render pass is essentially all fixed overhead.

- **3 mip levels instead of 5** removes 4 render passes and changes only the
  widest, faintest halo. This is the clearest "cost for something other than
  fidelity" trade available in post, and it needs a custom bloom node or a patch
  to `BloomNode` — **rebuild**.
- **`godRayTaps: 32`** is a literal `Loop` bound, unconditional, at half res,
  **every pixel, whether or not the sun is on screen** (`postGodRays.ts:219`,
  clamped 4–128). A screen-space early-out on the sun being behind the camera,
  or taps scaled by `godRayLength`, costs nothing visually. **reload** for the
  count, **rebuild** for the early-out.
- **Three separate god-ray render targets** (#2, #6, #7) at 960×428. **[?]** —
  worth checking whether they can be folded.

### 3.6 Geometry and LOD

| knob | current | effect | live? |
|---|---|---|---|
| `oceanSurface.gridSegments` | **512** → 263 169 verts / **524 288 tris in one draw call** (`surfaceGeometry.ts:114-163`) | 512→256 quarters the ocean's triangles. The ocean is `transparent = true`, `DoubleSide` + `forceSinglePass` — the file notes that without `forceSinglePass` those 524k tris rasterise **twice** through the project's heaviest fragment shader | **reload** |
| `oceanSurface.lodSamplesFull / lodSamplesCut` | 9 / 4.5 | per-vertex displacement taps | **reload** |
| `island.lodTerrainDistance / lodPalmFull / lodPalmCull / lodRockCull` | 900 / 500 / 1400 / 1800 | already the mechanism `foliageDensity` multiplies | **live**-ish |
| `ropes.segmentsPerRope / radialSegments / farRadialSegments` | 16 / 6 / 3 | rope tube geometry; near+far materials are both `transparent` (overdraw) | **reload** |
| `ropes.constraintIterations / substeps` | 8 / 2 | The rope solver is **1 thread per rope** (~32–64 threads) running 20-iteration catenary + 8×2×16 sequential Gauss-Seidel (`ropeCompute.ts`). This is **latency-bound, not throughput-bound** — cutting iterations buys little and costs stability. Better lever: dispatch it only when the ship pose or trim changed | **reload** |
| `combat.particleCount` | 1536 | additive `transparent` sprites, one instanced draw, full-pool overdraw (`combatFx.ts:200-201`) | **reload** |
| `spray.count / bowCount` | 2048 / 1024 | additive sprites, `depthWrite = false`, `frustumCulled = false` | **reload** |
| `rain.count` | 12 000 | `transparent`, NormalBlending on purpose; excess drops are set to zero size rather than culled | **reload** |
| `sky.shadowMapSize` | 2048 (1024/2048/4096 by bundle) | **Measured among the cheapest passes in the frame.** Do not spend your quality budget here | **reload** |

### 3.7 Fidelity knobs — last resort, and they are honest ones

Everything above buys time without changing the picture's intent. These change
it: `bloomStrength`, `godRayIntensity`, `vignetteStrength`, `vibrance`,
`grainAmount` — all **live uniforms with an exact identity value**
(`src/params/post.ts`), which is the right design and means a preset can fade a
stage to nothing without a rebuild. Note that fading a stage to zero **does not
reclaim its cost**; only the `*Enabled` construction gates do, and those need a
reload (the `checkGateDrift()` warning in `postPipeline.ts:162-173` exists to
say so out loud).

### 3.8 Proposed shape for the presets

Not a recommendation to implement yet — a shape to test against §3.1–3.5 once
the render profile exists.

- **low** — `resolutionScale 0.75`, post chain off, reflection off, bloom mips 3,
  ocean `gridSegments 256`, foliage 0.35. *Keep MSAA.* Losing edges on ropes and
  yards is the most visible possible degradation in this scene.
- **medium** — `resolutionScale 1.0`, full post, reflection at 0.5, bloom mips 3,
  god-ray taps 16, shadow 2048.
- **high** — as medium plus bloom mips 5, god-ray taps 32, reflection at 0.5
  (it is clamped), shadow 2048 — **not** 4096, which measurably buys nothing.
- **AO stays off in every preset** unless and until it can run without taking
  MSAA with it (§3.3).

---

## 4. Open questions — the honest list

1. **[?] Is the planar reflection actually running?** No reflection pass appeared
   in any sample (§2.2). Resolve first; a lot of the reflection knob map depends
   on it.
2. **[?] The whole render-side profile.** Needs one uncontended run under the
   §1.5 protocol. Everything in §3.3–3.5 is currently ranked by *pass count and
   pixel count*, which is structure, not cost.
3. **[?] Boot.** §T.40 records 58 s cold with 52 s of shader compilation; this
   session measured **14.4 s total, 13.1 s of it "shader compile" [M]** — much
   better, but still 90% of boot.
4. **[?] Per-dispatch attribution in compute.** The 86 compute keys are labelled
   `compute:node<id>` because `ComputeNode.name` is never set. **Setting `.name`
   at each creation site is a one-line-per-system change** that would make the
   compute table self-describing — the ocean FFT, foam, deck water, flow foam and
   the rope solver would name themselves.
5. **[?] Whether the three god-ray targets can be folded into fewer passes.**

---

## 5. Files touched

| file | change |
|---|---|
| `src/debug/gpuTimer.ts` | **new** — per-pass GPU timing that fails loud |
| `src/main.ts` | install `gpuTimer` before the first render; drain **both** pools; feed the HUD; expose `__perf` |
| `src/debug/perfHud.ts` | `setGpu()` block; show `drawCalls` (per-frame) instead of `calls` (lifetime) |

`gpuTimer` is installed in the **main tree**. The instance that was running
during this session was served from `/private/tmp/smt-deck`, so the file needs to
reach that worktree before the instrument is usable there.
