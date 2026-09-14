# Speedboat perf baseline (T205)

Measured 2026-09-14, 03:18–03:25, working tree at `3403b8e` plus uncommitted WIP from others (`src/flowfoam/simFoam.ts`, `src/wake/chineContact.ts`, `src/wake/vesselFx.ts`). Nothing in `src/` was changed. All instrumentation lived in scratch (`scratchpad/t205/`: `pre.js`, `inst.js`, `driver.mjs`, `plan.mjs`). Raw JSON for every window is in `scratchpad/t205/full/`.

Machine: Apple M3 Max (30-core GPU), macOS 26.3, Chrome 152, WebGPU on Metal, DPR 1. Page: `speedboat.html?autopilot`, Tower Reach, 7 NPCs, SAB worker transport (cross-origin isolated).

## Summary

- **The GPU is the bottleneck at 1080p.** Device utilisation sits at 94–98% and GPU busy time is 23–34 ms per frame, so with vsync the page locks to 30 fps (p50 frame 33.3 ms in every window except 720p cockpit). The GPU queue runs about 100–130 ms behind the CPU (`onSubmittedWorkDone` tail). That is roughly three frames of extra input latency.
- **CPU work is 16–21 ms per frame, but that includes about 2 sim ticks per frame, because 30 fps means two ticks are owed.** At 60 fps (one tick per frame) it would be about 13–15 ms. The main thread is idle 42% of the time (CPU profile). So the CPU is the second wall, not the first.
- Two costs dwarf everything else on the GPU: **ocean surface shading** and **kit island terrain shading**, both inside one MSAA 4× HDR scene pass.
- **Stutter sources:**
  - vsync quantisation: 33/50 ms alternation;
  - `holdSim` frames while the worker lags, in the pack;
  - 4–5 tick catch-up frames of 66–83 ms, dominated by the CPU ocean mirror;
  - one first-seen compile hitch the first time the pilots are drawn (near camera).
- GC is not a stutter source: 0.2% of main-thread time.

## 1. Frame time (headless Chrome, rAF intervals, 1920×1080 unless noted)

W = Working sea, C = Calm. "gap" = nearest rival (m) over the window. On Working sea the autopilot player fell off the back of the pack, so the in-pack numbers are the Calm rows.

| window | s | fps | mean | p50 | p95 | p99 | max | >33 ms | CPU work mean/p95 | ticks/frame | GPU busy mean/p95 | GPU util | draw calls | tris | gap |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| W rolling, far | 20 | 35.8 | 27.9 | 33.3 | 33.3 | 50 | 50 | 9 | 16.2 / 18.8 | 1.68 | 23.8 / 31.0 | 94% | 376 | 3.2 M | 24→351 |
| W racing, far | 20 | 33.5 | 29.9 | 33.3 | 33.3 | 50 | 83 | 21 | 17.1 / 19.5 | 1.79 | 23.4 / 30.0 | 94% | 441 | 3.5 M | 107 |
| W racing, near | 20 | 29.2 | 34.2 | 33.3 | 50 | 50 | 67 | 87 | 18.6 / 22.8 | 2.00 | 27.6 / 37.4 | 98% | 425 | 3.4 M | 65 |
| W racing, cockpit | 20 | 33.1 | 30.2 | 33.3 | 50 | 50 | 67 | 71 | 15.7 / 20.0 | 1.78 | 26.4 / 38.5 | 98% | 396 | 3.0 M | 37 |
| W 1280×720 racing, far | 12 | 35.4 | 28.3 | 33.3 | 33.3 | 50 | 50 | 6 | 15.9 / 17.9 | 1.69 | 25.3 / 31.0 | 97% | 401 | 3.1 M | 19 |
| W 1280×720 racing, near | 10 | 32.2 | 31.1 | 33.3 | 50 | 50 | 50 | 20 | 15.3 / 17.7 | 1.83 | 28.2 / 35.7 | 98% | 327 | 2.5 M | 40 |
| W 1280×720 racing, cockpit | 10 | 51.4 | 19.5 | 16.7 | 33.3 | 33.3 | 50 | 3 | 12.9 / 15.3 | 1.17 | 14.5 / 28.0 | 89% | 301 | 2.5 M | 40 |
| C rolling, far (pack) | 15 | 26.8 | 37.3 | 33.3 | 50 | 50 | 67 | 105 | 17.9 / 21.5 | 1.97 | 33.9 / 38.4 | 98% | 489 | 3.1 M | 14 |
| **C racing, far (pack)** | 20 | 26.2 | 38.2 | 33.3 | 50 | 50 | 83 | 154 | 18.3 / 22.7 | 1.91 | 34.2 / 37.7 | 98% | 459 | 3.1 M | 10 |
| C racing, near (pack) | 12 | 28.0 | 35.7 | 33.3 | 50 | 50 | 67 | 62 | 19.8 / 24.7 | 1.94 | 32.2 / 39.0 | 98% | 471 | 2.8 M | 14 |
| C racing, cockpit (pack) | 12 | 33.6 | 29.8 | 33.3 | 33.3 | 50 | 67 | 8 | 20.9 / 24.0 | 1.78 | 25.1 / 30.2 | 97% | 428 | 2.8 M | 17 |

Frozen frame, same view (sim held with `loop.setFixedDt(0)`, W racing, far): 1080p GPU busy 21.3 ms and CPU 9.2 ms; 720p GPU 16.7 ms and CPU 8.8 ms. **Dropping from 1080p to 720p saves only 4.5 ms of GPU (21%).** The main pass is not dominated by pixel count.

## 2. Ranked costs

### GPU, per frame (exclusive time on the GPU timeline, ms)

"C pack far" is the worst sustained case (busy 34.2 ms); "W far" is the spread field (busy 23.4 ms). The % columns are shares of GPU busy time.

| # | item | C pack far | % | W far | % | notes |
|---|---|---|---|---|---|---|
| 1 | **Main HDR scene pass, 1920×1080, MSAA 4×** (`output-msaa`, 273–316 draws) | 25.7 | 75% | 17.5 | 75% | The frozen A/B rows below split it (not additive: hiding the ocean exposes submerged terrain). |
| 1a | ↳ ocean surface (hide A/B) | — | — | −11.7 busy / −9.6 main | — | Also removes the half-res scene pass. CPU −3.4 ms. |
| 1b | ↳ kit island terrain, 8 plain meshes (hide A/B) | — | — | −9.4 busy / −7.5 main | — | CPU −1.0 ms. Matches T194's +5–10 ms. |
| 1c | ↳ course furniture (hide A/B) | — | — | −2.9 | — | CPU −4.1 ms, 137 draw calls. |
| 1d | ↳ island instanced props, 32 meshes | — | — | −0.8 | — | within noise |
| 1e | ↳ 8 boats + pilots | — | — | −0.65 (rivals only −0.2) | — | CPU −1.4 ms, 133 draw calls |
| 2 | Post: bloom mips, SMAA ×3, god rays, composite | 2.2 | 6.5% | 1.2 | 5.3% | Post-off A/B −0.6 (noise); the MSAA scene pass stays when post is off. |
| 3 | FFT cascades (3 compute groups) | 2.05 | 6.0% | 1.8 | 7.6% | |
| 4 | Flowfoam wake tiers + accumulation compute | 1.43 | 4.2% | 0.93 | 4.0% | Largest group 0.57–0.78; near tier 0.23–0.45; far 0.09–0.16. |
| 5 | Foam compute (`sea.foam.update`) | 1.04 | 3.0% | 0.70 | 3.0% | |
| 6 | Half-res scene pass `ocean-scene-color` 960×540 (≈220–260 draws) | 0.87 | 2.5% | 0.55 | 2.3% | Cheap on the GPU, expensive in draw-call JS (see CPU #1). |
| 7 | Clouds (cores pass + blur compute) | 0.34 | 1.0% | 0.31 | 1.3% | |
| 8 | Shadow map 2048² (100–127 draws) | 0.25 | 0.7% | 0.16 | 0.7% | Runtime A/B impossible, see caveats. |
| 9 | vesselFx spray computes | 0.13 | 0.4% | 0.08 | 0.3% | Hide A/B ≈ 0 |
| 10 | Flowfoam injection 512² | 0.12 | 0.4% | 0.11 | 0.5% | |
| 11 | Ambient spray | 0.05 | — | 0.04 | — | Hide A/B ≈ 0 |
| — | Planar reflection | — | — | ≈0 | — | Stubbing `reflection.update` changed nothing measurable. |

Camera effect on the main pass: near is +2–4 ms over far on Working sea. Cockpit is lower in the pack (18.3 vs 25.7).

### CPU main thread, per frame (performance.now wrappers, ms mean)

The "C pack far" column is 18.3 ms of work at 1.91 ticks/frame. The per-tick cost is in brackets.

| # | item | C pack far | % of work | W far | per-tick / notes |
|---|---|---|---|---|---|
| 1 | **three.js render JS for the whole post graph** (`renderer.render` inside `post.render`: main scene + half-res `ocean-scene-color` + shadow + post quads) | 8.81 | 48% | 8.55 | 437 draw calls in `info`. Profile top frames: `_renderObjectDirect`, `NodeFrame`/`Bindings.updateForRender`, `updateMatrixWorld`, `writeBuffer` (≈2,200 uniform writes/frame, 24–40 MB/s). |
| 2 | **CPU ocean mirror** `cpuOcean.update` (tickSea) | 4.47 | 24% | 3.67 | ≈2.3 ms/tick. Profile: `cpuOcean.compute` 6.0%, `cpuFft.line` 5.4%, `cpuOcean.sample` 3.3%, shoaling 2% of the main thread. |
| 3 | Player physics `player.tick` | 1.70 | 9% | 1.49 | 0.9 ms/tick. `hw.samplePatch` (pressure-head reads) 1.47; rigid6 + HullWater substeps 0.22. |
| 4 | Flowfoam injection capture (`renderInjection`, 16–24 draws) | 0.72 | 4% | 0.73 | |
| 5 | Course furniture `update` (culling, lamps, strobe) | 0.70 | 4% | 0.63 | Plus its 137 draw calls inside #1: the hide A/B saved 4.1 ms of CPU in total. |
| 6 | vesselFx tick (wake sources + spray emit computes) | 0.41 | 2% | 0.43 | 0.21 ms/tick; 15 compute dispatches/frame |
| 7 | Flowfoam wake + accumulation update (dispatch) | 0.30 | 2% | 0.32 | |
| 8 | Clouds update | 0.13 | 1% | 0.13 | |
| 9 | FFT dispatch `ocean.update` | 0.12 | <1% | 0.16 | |
| 10 | Worker pump (kick + poll + collect/copy) | 0.10 | <1% | 0.11 | kickBatch 0.016, poll 0.012, recordTick 0.023 |
| 11 | Pilots update (mixers) | 0.08 | <1% | 0.09 | |
| 12 | HUD `ui.update` | 0.07 | <1% | 0.07 | |
| 13 | Race session other: controls/autopilot, collide, crash, race.step, applyOutputs | ≈0.20 | 1% | ≈0.20 | Each ≤ 0.1; collide (7,800 colliders) 0.03–0.05/tick |
| 14 | Wake samples, jets, advanceWake, wetline, camera, surface, setDriveState, pace, archipelago update | ≈0.3 | 2% | ≈0.3 | All < 0.07 each |

Outside the loop callback (from the CPU profile, 8.3 s): idle 42%, `(program)` 5.8%, GC 0.2%.

**Worker** (SAB, 7 NPCs plus external player slot, `fleet.stepMs`):

| field | step ms/tick | round-trip p50 / p95 / max | ticks/request (max) | holdSim frames |
|---|---|---|---|---|
| Spread (W) | 7.0–7.5 | 14 / 19 / 60 | 1–2 | 0–16 per window |
| Pack (C far) | 8.5 | 20 / 33 / 65 | 1–2 (3) | **93 of 533 (17%)** |
| Pack (C near) | 9.9 | 17 / 31 / 51 | 1–2 | 36 of 346 |
| Pack (C cockpit) | 11.2 | 16 / 23 / 43 | 1 | 2 of 417 |

Max lag was 4 ticks; `starvedTicks` stayed 0. At 30 fps each frame owes ≈2 ticks, which is 17–22 ms of worker time. The loop holds a frame whenever the fleet trails by more than `D − MAX_SUBSTEPS` = 3 ticks.

## 3. Stutter sources

1. **GPU-bound vsync alternation** between 33 and 50 ms frames in every 1080p window (6–154 frames >33 ms per window). The GPU queue tail is 100–130 ms.
2. **`holdSim` frames** while the worker is behind in the pack: 10–17% of frames (C rolling and racing, far). Each one is a rendered frame with no sim advance.
3. **Catch-up frames** after a hold or a long frame: 4–5 ticks run in one frame, giving 66–83 ms frames with tick 13–17 ms, of which the CPU mirror is 8.6–10.9 ms. There is about one per window.
4. **First-seen compile:**
   - The first switch to the near camera compiled 16 pilot pipelines (`M_PilotHair/Skin/Lens/Pilot`) with a **58 ms long task**.
   - 6 `MeshBasicNodeMaterial` pipelines appeared about 2 s into the rolling start.
   - No other long tasks (>50 ms) happened during play. 3 long tasks over 200 ms happened at boot.
5. **GC: not a factor.**
   - The heap sits at 440–640 MB and allocation runs at 47–75 MB/s.
   - A scavenge happens about every 12 frames.
   - GC is 0.2% of main-thread time.

## 4. Memory and pipelines (estimated from `GPUDevice.createTexture`/`createBuffer` wrappers)

- **Textures: ≈815 MB across 215 textures.**
  - By format: rgba16float 297 MB, depth24plus 157, rgba32float 141, astc-4×4 89, bc7 56, rgba8 36, bgra8 32.
  - Multisampled at 1080p: `-msaa` and `output-msaa` (rgba16f ×4, 63 MB each), the canvas `colorBuffer` bgra8 ×4 (32 MB) and five depth24plus ×4 (32 MB each). That is ≈350 MB of 4× buffers.
- Buffers: 54 MB across 6,300 buffers.
- Pipelines: 1,171 created (737 at the select screen). Shader modules: 763.
- Triangles per frame: 2.5–3.5 M. The ocean mesh is 524 k triangles; the archipelago is 768 k (plain 8 meshes + instanced 32).

## 5. Knobs, ranked by expected gain for the quality cost (none implemented)

Gains are estimates from the measurements above. Items marked *unmeasured* need their own A/B before anyone relies on them.

| # | knob | expected gain | quality impact |
|---|---|---|---|
| 1 | **Kit terrain material:** distance/shoreline LOD of its expensive terms (triplanar and detail samples, per-pixel noise), or bake far islands. Also stop shading terrain the opaque-looking ocean hides (depth-only prepass or an underwater shortcut). | GPU −4 to −8 ms (hiding it saved 9.4) | Low if the LOD starts beyond the course corridor; medium if near cliffs lose detail. |
| 2 | **Ocean surface cost:** (a) feed refraction from the main pass colour instead of re-rendering ≈220–260 objects into `ocean-scene-color`, or render only a layer or nearby objects; (b) fewer cascade and detail samples per pixel at distance. | (a) CPU −2.5 to −3 ms and GPU −0.5 to −1; (b) GPU −3 to −6 ms (hiding the ocean saved 11.7) | (a) small: refraction of far objects. (b) medium: far-sea detail and sparkle. |
| 3 | **MSAA:** main HDR pass 4× → 2× or 1× (SMAA already runs), and no canvas MSAA when post is on (`antialias` false when post owns the output). | GPU −3 to −8 ms (*unmeasured*; 4× rgba16f on TBDR is costly), memory −190 to −300 MB | Edge shimmer on rigging, poles and hull lines; SMAA covers most of it. |
| 4 | **Resolution scale:** the existing `graphics.resolutionScale` at 0.67, or dynamic resolution on GPU busy time. | GPU −4.5 ms at 720p (−21%), measured | Softer image; HUD unaffected. |
| 5 | **Worker in the pack:** cheaper far-NPC contact/pilot, split the fleet over 2 workers, or allow more lag before `holdSim` (larger `RACE_DELAY_TICKS`) | Removes most of the 10–17% hold frames | None visible. Delay adds race-output latency (117 ms now). |
| 6 | **Furniture draw calls:** instance or merge buoys, poles and gate parts; distance-cull the far course | CPU −3 ms, GPU −1 to −2 (hiding it saved 4.1 CPU and 2.9 GPU) | None if the silhouettes are kept. |
| 7 | **CPU ocean mirror** (2.3 ms/tick): fewer or smaller CPU cascades for the player, cache per tick near the hull, or share the worker's mirror | CPU −2 to −4 ms/frame at 30 fps, and it shortens catch-up frames | Physics parity risk (§V110: player and NPCs must feel the same sea). |
| 8 | **Pre-warm pilot materials** (compile with the pilot visible, in `withFullCoverage`) | Removes the 58 ms first near-camera hitch | None |
| 9 | Boats: fewer material slots or draws per boat (≈17 draws each), LOD for rivals > 150 m | CPU −0.7 to −1.4 ms | Low |
| 10 | Post: bloom mip count, god rays at lower res | GPU −0.5 to −1 ms | Low |

Low value (each < 0.5 ms): reflection, vesselFx and ambient spray, shadow map (0.2 ms GPU, though its ≈120 draws cost JS inside CPU #1), HUD, race logic, colliders.

**Order of attack for 60 fps at 1080p.** GPU busy needs to fall from ≈24–34 ms to ≤ 14 ms. That needs #1 and #2, plus #3 or #4. The CPU has to stay ≤ 14 ms at one tick per frame: it is ≈13–15 ms now, and #2a and #6 give headroom.

## 6. Methods

- **Where the numbers come from.** All numbers come from one **headless Chrome** session (`--headless=new`, Metal, `--enable-webgpu-developer-features`, viewport 1920×1080 or 1280×720 at DPR 1). The GPU lock was held throughout: 03:17–03:25 for the run, plus a short visible-tab attempt at 03:27–03:29.
- **CPU timing.**
  - Methods reachable from `window.__speedboat` were wrapped with `performance.now()` timers.
  - The wrapped objects: loop tick/render, session sub-steps, player, `hw.samplePatch`/`evaluate`, sea subsystems, vesselFx, furniture, pilots, UI, fleet kick/poll.
  - Timers are inclusive. `renderer.render`/`compute` were timed at the outermost call only and attributed to the calling wrapper.
  - A V8 sampling CPU profile (8 s, 0.5 ms interval) ran on W racing far.
- **GPU per pass.**
  - Timestamp queries go through a custom query pool (begin/end per pass, render and compute merged per frame).
  - **Metal intervals overlap:** a 60×34 bloom pass read 15 ms end-to-begin, so the project's `gpuTimer` sums of 300+ ms are not usable on this machine.
  - Each pass is therefore charged `end − max(begin, previous end)` on the GPU timeline, and busy time is the sum.
  - A cross-check: GPU busy tracks ioreg Device Utilization (94–98% at 23–34 ms busy while 30 fps; 71% at 9.5 ms busy while 60 fps).
  - Subsystem splits inside the one scene pass come from **frozen-frame A/B** (`setFixedDt(0)`, same camera): toggle visibility or stub the update, 2.5–3 s per leg.
- **Memory, pipelines, long tasks, GC.**
  - Memory and pipelines: wrappers on `GPUDevice.createTexture`/`createBuffer`/`create*Pipeline`/`createShaderModule`, installed at document start.
  - Long tasks: `PerformanceObserver`.
  - GC: `performance.memory` drops (with `--enable-precise-memory-info`) plus the profile.
- **Worker.** Kick-to-poll round trip, `fleet.stepMs()`, `catchUp`, and `isPaused` counts outside UI screens (= `holdSim`).

## 7. Caveats

- **No visible-window numbers.**
  - The extension tab opened hidden (`document.hidden` true). Boot stalled at shader compile until a screenshot, and rAF delivered 0 frames in 3 s.
  - Every number here is therefore headless. Headless presents offscreen at 60 Hz; the user's LG display runs at 100 Hz, where the quantisation would be 10/20/30 ms instead of 16.7/33/50.
  - A visible run needs the user to keep the tab in front, or a headed Chrome window started by an agent.
- **A/B noise.** The frozen baseline drifted from 19.9 to 22.6 ms GPU across the A/B series, so A/B deltas under about 1.5 ms are noise.
- **Toggles I could not A/B.**
  - Shadows: setting `castShadow = false` at runtime throws in three's `updateShadow` every frame (a three r180 fault), so it was measured only by its pass timestamp.
  - Clouds: no toggleable mesh handle.
  - Post is a construction gate, so the post-off A/B keeps the MSAA scene pass.
- **Coverage gaps.**
  - Rolling start was measured only with the far camera. Green at 29.6 s left no room for near or cockpit during the roll.
  - The 720p near and cockpit windows are 10 s, and the Calm near and cockpit windows are 12 s, not 20 s.
- **Who drove.** The player ran the autopilot, and its `session.controls` cost (≈0.07 ms) is included. On Working sea it drove behind the pack, so the pack numbers come from Calm.
- **Instrumentation overhead.** About 50 wrapped functions, a `writeBuffer` counter (1.1% of the main thread), and per-frame timestamp resolves. These inflate CPU work by an estimated ≤ 0.5 ms and the GPU slightly.
- **Background load.** `mediaanalysisd` ran at ≈145% CPU when the session started (GPU idle 0–1% beforehand). There were no other agents or GPU jobs.
