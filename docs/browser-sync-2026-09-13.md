# Browser sync, 2026-09-13

One dev server (`npm run dev -- --port 5231`), one tab, run in sequence. Measure and screenshot only; no source was edited.
Screenshots and GIFs are in
`/private/tmp/claude-501/-Users-flo-work-code-shiver-me-timbers/adc53218-9260-41a8-8d6a-476d5936a376/scratchpad/browser-sync/`
(`$SHOTS` below).

**Environment caveats. Every absolute number here is an upper bound.**
- CPU was contended the whole run: three `vitest` workers at about 100% each, plus `mediaanalysisd` at 170%.
- Pages ran at 18–31 fps. Frame time held near 33 ms, looking vsync-locked at 30 Hz.
- The viewport changed under the run: 1920×917, then 797×556, 878×668 and 1251×952.
- The MCP tab group disappeared twice. Each time the tab was lost and had to be re-created and rebooted.
- The raft's in-game clock runs at about 1 game hour per real minute. `__game.clock.set(14.5)` was pinned before shots, but night fell during the T174 low shots.
- Storm cells were pinned off throughout: `weatherParams.cellIntensity = 0`.

| # | check | verdict |
|---|---|---|
| 1 | T167 camera jank | **PASS** (pirate only; stopped by coordinator after user sign-off) |
| 2 | T173 raft motion | **NEEDS-USER-EYE** (numbers mild on the default sea) |
| 3 | T174 swell shadow | **PASS** on CPU and physics / **NEEDS-USER-EYE** on the GPU look |
| 4 | Wake pond W1/W2a | **PASS** (residual), 2 flags |
| 5 | W2b raft sim wake | **NEEDS-USER-EYE** (arms not visible at shipped scale) |
| 6 | W5 foam | **NEEDS-USER-EYE**, one probable defect (bow sheet at 2 m/s) |
| 7 | Speedboat lookdev + worker | **PASS** COI/pipeline, **FAIL** draw batching and one console error; worker not wired |

---

## 1. T167: camera jank (pirate `/`)

Setup:
- Galleon unanchored, full sail, 12–13 m/s.
- Follow cam about 9° off dead astern, 29 m trail.
- Logged camera position and ship render pose (`shipAssembly.group`) after every rAF callback. The hull position was projected to screen with the live camera.

**Natural frame time** (29–91 ms, mean 55 ms, 6 s, 107 frames):
- Hull on-screen velocity wobble: median **0.08** px/s per frame, p90 1.25, max 18.6 (one long frame).
- Hull screen x stayed within 966.1–969.4 px and y within 629.0–630.5 px for 6 s.
- 0 back-and-forth reversals of screen vx.
- Trail distance 28.78–28.98 m.

**Throttled** (10-frame blocks alternating +35 ms of busy-work; fast 28 ms median vs slow 60 ms, a ratio of about 2.2, like 50↔100 fps; 10 s, 221 frames):
- Trail distance median **28.912 m fast vs 28.910 m slow**, a dt dependence of 2 mm. SPEC's old code gave 75 vs 23 mm.
- Wobble on regime-switch frames: median **0.07**, max **0.29** px/s per frame (SPEC's old code: 13). Steady frames: median 0.06.
- One spike of 26.9 px/s per frame on a single **120 ms frame**:
  - The sim hit `MAX_SUBSTEPS` and dropped its debt (`loop.ts advanceAccumulator`).
  - The ship moved 1.07 m where it should have moved 1.48 m, so the hull dipped about 2 px and recovered over about 5 frames.
  - This is a one-way hitch, not back-and-forth judder, and not the camera.

Verdict: no judder remains on pirate. The raft (b) was not run, because the coordinator stopped this check after the user signed it off.

Files:
- `$SHOTS/t167-pirate-followcam-behind.gif`
- `$SHOTS/t167-pirate-followcam-behind.jpg`

Console (pirate): no errors.

## 2. T173: raft motion (`/raft.html`)

Render pose was sampled per rAF over 30 s. Pitch is the bow-up angle, roll is the starboard-up angle, heave is the render-group y.
- Wind 4 m/s is the raft default. 4.8 m/s is what holds 2 m/s.
- K is the swell-shadow coefficient at the raft.

| case | K | speed | pitch p-p (sd) | roll p-p (sd) | heave p-p |
|---|---|---|---|---|---|
| spawn, at rest, wind 4 | 0.42 | 0.03 | 2.01° (0.47) | 2.69° (0.65) | 0.78 m |
| spawn lee, sailing, wind 4.8 | 0.46 | 1.92 | 4.41° (1.00) | 3.98° (0.95) | 0.91 m |
| open sea (1742, −234), sailing | 1.00 | 1.87 | 4.56° (0.79) | 3.25° (0.72) | 1.75 m |
| open sea, sail down (drifting 0.65→0.11 m/s) | 1.00 | 0.36 | 5.49° (1.15) | 4.00° (0.96) | 1.75 m |

Mean pitch at 2 m/s: **+0.40°** sim backend vs **+1.49°** `?wake=analytic`. The analytic backend sits about 1.1° more bow-up, which matches the w2b §7.6 V8a expectation of about 0.85°.

Qualitative:
- On the raft's default sea the motion is gentle: about ±2.7° pitch and ±2° roll.
- In the GIFs (about 2 fps capture) it reads as a lashed raft working in a small sea, not a cork.
- The SPEC's +24–47% was measured on the **swell** preset (13° p-p), which was **not run here**. Whether that preset is too lively is still the user's call.

Files:
- `$SHOTS/t173-raft-2ms-lee-followcam.gif`
- `$SHOTS/t173-raft-rest-opensea-side.gif`
- `$SHOTS/t173-raft-rest-opensea.jpg`

## 3. T174: swell shadow (raft)

Swell direction 1.948 rad, travelling toward ŝ = (−0.37, +0.93) in x/z. The test island's centre is about (150, −2550), roughly 650 m across. Swell share f₀ = 1 on cascade 0 (strength 1) and f₁ = 0.

**CPU mirror** (`__game.cpuOcean`, same as the buoyancy the raft floats on):

*Heave in the lee:*
- Height sd at u = 900 m on the lee centreline (K = 0.26), 15 s windows: **0.478 m off → 0.170 m on (−64%)**.
- At u = 2000 m (K = 0.26): 0.375 → 0.128 m.

*Windward and side are identical:*
- Test: strength toggled with `co.update(t)` at the same t.
- Points: windward u = −1200 and (−800, v = 300), side (900, −2200).
- Result: heights **bit-identical** (`h1 === h0`) in 5 of 5 repeats × 3 points. The lee point differed every time, as it should.

*Lateral profile at u = 900:*
- Smooth Gaussian: K = 1 → 0.59 (v = ±600) → 0.26 (centre).
- No step or fringe.

*Fill-in along the lee centreline:*
- K runs 0.04 (500 m), 0.31 (1 km), then dips again to 0.07–0.25 at 1.25–2 km behind a second island chain.
- Beyond that: 0.33 (2.75 km), 0.51 (4 km), 0.55 (5 km).
- Recovery is slower than "2–4 island widths", but the downswell islands (cirque/drownedRidge group) overlap this lee, so the single-island rule cannot be isolated here.

*Field edge:*
- Fetch field origin (−5903, −6882), size 12 061 m.
- Along the lee centreline K ramps 0.68 → 0.74 → 0.82 → 0.90 → 0.96 → 1.00 over u = 6.7–8.2 km. That is a smooth border fade with **no ring**.

**GPU** (drawn sea):
- A/B screenshots at the same camera, strength 1 vs 0: elevated windward, 900 m overhead, 45 m and 6 m in the lee looking downswell, 6 m windward.
- They are close to indistinguishable. The raft default swell is 0.3 amplitude (13 s, λ about 264 m), and a static frame does not show long heave.
- Supporting evidence from physics: the raft's heave was 0.91 m in the lee vs 1.75 m in open sea (§2).
- GPU frame time: `onSubmittedWorkDone` two-frame bracket, 4 interleaved legs × 20 samples. Median on 68.5 ms vs off 68.2 ms, **Δ ≈ +0.3 ms, inside noise**.

**Incidental** (the same with strength on and off, so not T174):
- `t174-shadow*-overhead-900m.jpg` shows **hard straight-edged rectangles and diagonal bands** on the water or seabed. It looks like a shadow-map cascade or terrain-tile boundary seen through clear water. Owner: probably `src/terrain` / shadows.
- `t174-shadow*-windward-elevated.jpg`: the spire island has a **hard vertical light/dark split** down its face.

Files:
- `$SHOTS/t174-shadow{0,1}-lee-45m-downswell.jpg`
- `$SHOTS/t174-shadow{0,1}-windward-elevated.jpg`
- `$SHOTS/t174-shadow{0,1}-overhead-900m.jpg`
- `$SHOTS/t174-shadow{0,1}-{lee,windward}-6m-night.jpg`

## 4. Wake pond (`/src/wake/preview.html`)

**`__wakePond.compare()`, CPU↔GPU on identical inputs, 240 steps:**

| scenario | max\|Δη_vis\| | of max | rel | rms | head rel | non-finite |
|---|---|---|---|---|---|---|
| preset galleon-7 | 2.18e-3 m | 1.114 m | 0.196% | 1.7e-4 m | 0.43% | 0 |
| kelvin Fr 0.45 | 1.81e-4 m | 0.385 m | 0.047% | 4.9e-6 m | 0.058% | 0 |

The CPU and GPU centres matched in both runs.

**GPU timing** (`timing()` / HUD, min of 60, 256², 35 dispatches in 1 group; W1 budget ≤ 1.0 ms GPU, ≤ 40 dispatches, CPU encode ≤ 0.2 ms):

| preset | compute group | CPU encode |
|---|---|---|
| galleon-7 | 0.393 ms | 0.33–0.62 ms |
| galleon-10 | 0.459 ms | |
| raft-2 | 0.393–0.459 ms | |
| speedboat-40 | 0.85–0.92 ms | 0.5–0.99 ms |

- `health()`: 1051 reads, 0 overflows, 0 unwritten, batchFrames 1.
- **Flag: CPU encode is 0.33–0.99 ms, over the W1 ≤ 0.2 ms line**, although the CPU was contended.
- **Flag: splat read 6.23 ms** in one `timing()` call (0.000 and 0.066 ms in others). This is probably timer noise, but worth a re-read on a quiet machine.

**Readouts** (`readout()`):

| preset | α_max vs R–M | Fr_L | λ_T | near-hull p2t | cusp slope | maxAbs |
|---|---|---|---|---|---|---|
| galleon-7 | 16.7° / 19.5° | 0.375 | 31.4 m | 1.67 m (band ≥0.83, ≤2.0 ✓) | 0.22 | 0.99 |
| galleon-10 | 14.2° / 19.0° | 0.536 | 64.0 m | 2.23 m | 0.25 | 1.90 |
| raft-2 | 9.7° / 19.5° | 0.169 | 2.56 m | 0.155 m | 0.019 | 0.094 |
| speedboat-40 | 2.2° / 1.96° | 5.83 | 1025 m | 0.14 m | 0.028 | 0.51 |

Visual:
- galleon-7 and galleon-10 show clear transverse and divergent wedges.
- **Flag:** both show wave structure **ahead of the stem** in the top-right and bottom-right corners (`pond-galleon-10.jpg`). This may be periodic wrap-around leaking through the sponge (wake-research §"periodic wrap-around"). Owner: `src/wake`.
- galleon-10's λ_T of 64 m leaves only about 2.5 wavelengths in the 160 m domain.
- raft-2 at ×1 is almost invisible. At ×8 it shows a narrow transverse train (`pond-raft-2-scale8.jpg`).
- speedboat-40 is a faint needle.

Console: no errors.

Files:
- `$SHOTS/pond-galleon-7.jpg`
- `$SHOTS/pond-galleon-10.jpg`
- `$SHOTS/pond-raft-2-scale1.jpg`
- `$SHOTS/pond-raft-2-scale8.jpg`
- `$SHOTS/pond-speedboat-40.jpg`

## 5. W2b: raft sim wake

Setup:
- `raft.html` (A) vs `raft.html?wake=analytic` (B), one tab reloaded as A → B → A.
- Open sea around (1700, −300), 1.8–2.1 m/s, held for 78 s (A) and 69 s (B) before judging.

**Wake visible, Kelvin arms displaced: not observed.**
- Views tried: follow cam, a quarter astern pose (camera 10 m abeam, 7 m up), a grazing pose (1.6 m up, looking 30 m astern), and a pose 55 m astern at 18 m.
- None shows a V of crests in silhouette or in shading on the default sea.
- Repeated on near-glass (`oceanParams.amplitude` 0.05, `swellAmplitude` 0; a diagnostic only, restored afterwards): still no arms visible.
- This fits the pond raft-2 readout: maxAbs 9 cm, p2t 15 cm, α_max 9.7°.
- The shipped follow cam puts the **HUD bar exactly over the water astern of the raft** (`raft-followcam-2ms-hud-covers-wake.jpg`), so the wake zone is hidden in the shipped view regardless.

**Seam and pulsing:**
- No straight edge or step in the 45–55 m astern views.
- A 20 s pulse watch and a 90° turn were not run. Pulsing cannot be judged from about 2 fps screen capture.

**Slope axes and lighting:** not assessable, because there are no visible arms.

**Frame time** (the numbers are noise-dominated):

| backend | rAF median | `onSubmittedWorkDone` two-frame bracket, median per leg |
|---|---|---|
| A (sim) | 33.1–33.3 ms | 66, 132, 102, 68 ms |
| B (analytic) | 33.5–35.3 ms | 140, 143, 147, 145 ms |

There is no evidence that the sim costs more than analytic. The 1.0 ms budget cannot be resolved on this machine state.

**V8a:** mean pitch A +0.40° vs B +1.49° (§2).

Near-glass side effect: at `amplitude` 0.05 the whole sea is covered in **marbled white foam patches** (`w2b-A-sim-2ms-*-nearglass.jpg`). It could be expected foam statistics at a non-shipped value; ocean/foam owner to glance at it.

Files:
- `$SHOTS/w2b-A-sim-2ms-{quarter-astern,grazing-astern,from-astern-55m}-default.jpg`
- `$SHOTS/w2b-B-analytic-2ms-{quarter-astern,from-astern-55m}.jpg`
- `$SHOTS/w2b-A-sim-2ms-*-nearglass.jpg`

Console (A and B): no errors.
- 16× `THREE.TSL: "modInt()" is deprecated`.
- `WebGPUTimestampQueryPool [compute]/[render]: Maximum number of queries exceeded`, once per load.

## 6. W5 foam

**Lane.**
- Seen from overhead astern (3 m forward, 16 m up):
  - a beam-wide pale lane with **no V of foam** ✓;
  - faint at 2 m/s (`w5-A-sim-2ms-overhead-lane.jpg`);
  - strong and about 40 m long at 3.7 m/s (`w5-A-sim-3.7ms-overhead-lane.jpg`);
  - gone at 0.5 m/s ✓.
- **The lane edges are hard and blotchy** (dissolve-gate look), not soft.
- In B the lane looks much the same (`w5-B-analytic-2ms-overhead-lane.jpg`). Similar hard-edged pale patches also appear on open water away from the raft in both backends, so the lane does not separate clearly from background foam at the wind 4.8–5.3 used here (the raft default is 4 m/s).

**Alignment with displaced arms:** not assessable (§5, no visible arms).

**Bow spray** (a low pose ahead of the bow):

| speed | A (sim) | B (analytic) |
|---|---|---|
| 0.5 m/s | nothing ✓ | not run |
| 2 m/s | **a few droplets only, no "real sheet"** | a few droplets |
| 3.5 m/s | a large splash arc through the sail/deck, and water over the bow deck (slam-like) | not run |

At 2 m/s A and B look alike, as the doc expects. **Probable defect:** the 2 m/s bow sheet is too faint to read. The doc's next lever is per-pool opacity. Owner: `src/foam` (sprayMath / spray pools).

**Readable vs whitecaps:** not run (cells stayed off).

**GPU ms:** not resolvable (§5).

**Pirate galleon (analytic path):**
- `__game.flowFoam.wakeBackend()` returns `'analytic'`, and `wakeSim` is absent ✓.
- The quarter view shows the foam V and dark trough streaks astern.
- There is no same-pose "before" frame to diff against, so identity to the old look is NEEDS-USER-EYE.

Other raft observations:
- A dark saw-tooth fringe runs along the logs at the waterline at every speed. It is probably the wetline or contact band (`w5-A-sim-0.5ms-bow-spray.png`).
- Tan plank/hand shapes sit fixed in the **bottom screen corners in follow cam and debug-pose views**, even with the camera 1 km away (every raft screenshot). It looks like the first-person arms/oar rendering outside FP mode. Owner: `src/raft` / player.

Files:
- `$SHOTS/w5-A-sim-{0.5,2,3.7}ms-overhead-lane.jpg`
- `$SHOTS/w5-A-sim-{0.5ms-bow-spray,2ms-bow-spray-a,3.5ms-bow-spray-a,3.5ms-bow-spray-b}.png`
- `$SHOTS/w5-B-analytic-2ms-bow-spray.png`
- `$SHOTS/w5-pirate-galleon-analytic-quarter-13ms.jpg`

## 7. Speedboat lookdev and physics worker

**COI and service worker:**
- `crossOriginIsolated === true` on every load; `SharedArrayBuffer` is available.
- No service worker is registered in dev (`getRegistrations()` returns []). The shim exits early because the headers already isolate the page.
- Navigation type `navigate`; `timeOrigin` stable over 8 s; `coi-shim-reloaded` flag null. That means **0 reloads and no loop** ✓.

**Loads:**
- Resource timing shows HTTP 200 for:
  - `/assets/models/speedboat_pipeline_test.glb`
  - `basis_transcoder.js` and `.wasm` (the `?url` import and the fixed name)
  - the KTX2Loader and meshopt decoder deps
- No COEP-blocked requests.
- The KTX2 textures decoded: 15 textures, **56.0 MB GPU texture memory**.
- Side note: the two deps carry different optimize hashes (`?v=bee43a62` vs `?v=b1a7bfe3`), because Vite re-optimized at start ("lockfile has changed").

**Readouts:**
- 1 boat, studio: **72 draws, 101 967 tris**.
- Per LOD: draws 40 / 37 / 24, tris 95 409 / 13 926 / 3 229; 7 materials.
- Frame 33.3 ms, vsync-locked. §V17's ≤ 8 ms render is not measurable here.
- **`count=8&dist=45`: 523 draws / 141 081 tris**, about 65 draws per boat. The doc expects "about 7 × 8 plus shadow draws". **FAIL**: draws are per mesh, not per material. Owner: `src/speedboat/assets` / `scripts/asset-build.mjs` / `scripts/blender`.
- The HUD says `hero LOD 2` in the close studio framing while the frame's tris equal LOD0 plus shadow. Possibly the LOD label or selection is wrong.

**Look** (judging the pipeline only):
- Turntable shows white gelcoat topsides, a dark bottom, grey deck, black rub rail, screen and an orange cowl.
- Materials and textures resolve.

**Sea scene** (`?scene=sea`):
- The boat floats with foam around the hull.
- The console shows **two errors**:
  - `WebGPUBackend: copyFramebufferToTexture: Source and destination formats do not match. bgra8unorm rgba16float` (likely the perspex `transmission` on the hero with post). Owner: `src/speedboat/assets` slotMaterials / lookdev.
  - `flowFoam.update: the wake track has never been advanced. Call advanceWake(dt) from the SIM TICK`. Lookdev doesn't tick the wake. Owner: `src/speedboat/lookdev.ts`.
- Clouds in this view look dark and sooty.

**Worker:** `createNpcFleet` is referenced only in `src/sim-worker/select.ts`. No page constructs a fleet, so transport and round-trip timing were **not measurable**: not wired to a page yet.

Files:
- `$SHOTS/speedboat-lookdev-studio-lit.jpg`
- `$SHOTS/speedboat-lookdev-turntable-{a,b}.jpg`
- `$SHOTS/speedboat-lookdev-sea.jpg`

---

## Not run

- T167 on the raft: stopped by the coordinator.
- T173 on the swell preset.
- W2b §7.4: 90° turn, 20 s pulse watch, the cells-on NaN check, and ≥ 5 interleaved legs. Only A/B/A was done, because each leg costs a reload and 70 s.
- W5 §6.3 slam into a swell with cells on, and §6.4 readability against whitecaps.
- Any check at timeOfDay 17.6.
- Speedboat `?view=slot|uv|lod`, `livery=`, and the Pages/Safari/Firefox steps.

Two harness limits shaped all of this:
- GIF capture through the extension runs at about 2 fps, so it cannot show frame-level judder or pulsing.
- `javascript_tool` calls time out at 45 s, so long captures had to be split.
