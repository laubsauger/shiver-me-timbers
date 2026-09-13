# W0 — why the displaced wake is not visible (T161(b), proposed T163)

Status: MEASUREMENT ONLY. No `src/` or SPEC edits. Working tree as of `3403b8e` plus user WIP.
Date: 2026-09-13. Companion to `docs/wake/wake-research.md` §6 W0.

Legend: `[M-gpu]` = GPU readback of the live `elevTexture` in the browser. `[M-cpu]` = the shipped CPU
mirror (`flowFoam.wakeHeightCpu`, `slickFieldCpu`, `bowSlopeCpu`), driven headless through `advanceWake`
for 60 s of steady course. `[M-img]` = in-page canvas capture. `[C]` = arithmetic on those numbers.

## 0. Answer in one paragraph

The displacement path works end to end. The GPU texture holds what the CPU mirror says, and at ×20 the
mesh visibly heaves. The grid is not the problem either: at the real follow-cam distance, spacing is
1.0 m at the ship. The wake cannot be seen because **its geometry is too small for any camera the game
uses, even on glass-flat water** (0.28 m transverse crests over a 31 m wavelength, a 0.06 slope). On
the default sea, the swell adds a second, masking factor. The one feature with real height, the 0.63 m
bow mound, sits 1.3 m ahead of the waterline stem. From the astern follow cam it is hidden under the
beakhead and behind the hull. What reads as "3D wake" in the frame is the steep crest *shading* of the
divergent train. That train is not displaced. Displacing it would add only 6–11 % of the wake's
elevation variance.

## 1. Peak wake elevation vs swell

### Galleon (stem +21.0, transom −17.5, beam 8.5), steady course, 60 s `[M-cpu]`

| v (m/s) | wake max | wake min | mound max | transverse [min,max] | eddy min | divergent *if displaced* [min,max] | λ_T (m) |
|---|---|---|---|---|---|---|---|
| 3 | 0.374 | −0.083 | 0.369 | −0.030, 0.032 | −0.077 | −0.016, 0.018 | 5.8 |
| 5 | 0.723 | −0.240 | 0.634 | −0.131, 0.153 | −0.206 | −0.131, 0.131 | 16.0 |
| **7** | **0.797** | **−0.356** | 0.634 | −0.234, 0.284 | −0.249 | −0.265, 0.222 | 31.4 |
| 8 | 0.792 | −0.421 | 0.634 | −0.290, 0.307 | −0.264 | −0.372, 0.264 | 41.0 |
| 10 | 0.759 | −0.406 | 0.634 | −0.406, 0.315 | −0.287 | −0.631, 0.346 | 64.1 |

- The peak is always the mound on the centreline, **1.25–1.5 m ahead of the stem** (22.25 m ahead of the
  ship origin).
- On the centreline the mound is `moundSlope·moundThick/RIDGE_PEAK` = 0.634 m, not 0.41 m as T161(b)
  said. Off the centreline the `|∇dc|` divisor takes it down to 0.47 m.
- RMS over non-zero texels at 7 m/s: 0.112 m.

### GPU vs CPU, in the browser, pirate at 7.0–7.4 m/s, swell preset, storm cells off `[M-gpu]`

- `elevTexture` (rgba16float 512², found by walking the ocean material's `positionNode`, read with
  `backend.copyTextureToBuffer`): **max 0.797 m** at 22.3 m ahead / 0.06 m lateral. Min −0.41 m at
  32.9 m astern / 4.4 m lateral.
- `wakeHeightCpu` at the same texel: 0.797 m. Over 32,947 interior texels (r ≤ 48 m) the RMS
  difference is **0.017 m**. The max difference of 0.22 m sits at the stem apex; readback and tick are
  asynchronous (the §T.78 apex band).
- Liveness control: ×20 params → max/min moved to the ±2.00 m clamp (26,697 texels clamped). The
  reading is not stale.

### Swell `[M-gpu]`

| sea | `ocean.heightRms` σ | Hs = 4σ | wake peak / Hs | wake peak / σ | astern features (0.25–0.41 m) / Hs |
|---|---|---|---|---|---|
| default `swell` preset, `cellIntensity` 0 | 0.696 m | **2.78 m** | **0.29** | 1.15 | 0.09–0.15 |
| as booted near the lagoon spawn (§V46 storm cell live: wind 17, amp 0.38) | 1.877 m | **7.51 m** | 0.11 | 0.42 | 0.03–0.05 |
| `glass` | 0.0023 m | 0.009 m | ≫1 | — | — |

- Slopes: transverse 0.06, eddy 0.09, divergent 0.11 (shading only), mound 0.17. The sea's own RMS
  slope is 0.137 (`params/flowfoam.ts` eddySlope note). So in swell the shading signal of the
  astern features is also **0.44–0.66× the noise**.
- The storm-cell row is what the user most likely saw: the boot location sat inside a cell.

### Raft (±6.85 m, beam ≈ 5.5 m, `speedScale` 0.35)

| v | CPU mirror (shipped) max | GPU-equivalent max (thresholds × 0.35) | in-browser GPU `[M-gpu]` | in-browser CPU `[M-gpu]` |
|---|---|---|---|---|
| 1.5 | 0.081 | 0.595 | | |
| **2.0** | **0.160** | **0.619** | **0.619** | **0.156** |
| 2.5 | 0.260 | 0.623 | | |
| 3.4 | 0.466 | 0.656 | | |

**New §V.8 defect (not in wake-research.md):** T161(a)'s `speedScale` reaches only the GPU uniforms
(`wakeInjection.pushParams`, `uSpeedThreshold/uFullWakeSpeed`). `slickFieldCpu` and `bowSlopeCpu`
still read the unscaled `p.speedThreshold`/`p.fullWakeSpeed`. So at 2 m/s the raft is **drawn in a
0.62 m mound, while buoyancy feels 0.16 m: a 0.46 m divergence**, measured in the browser. The mound's
size is also the galleon's (`moundThick` 3.2 m, lead 1.6 m, not scaled to the hull). That contradicts
the research doc's "raft wake is cm-scale".

## 2. Is the displacement path live? Yes

- **Uniforms:** `pushParams` runs in `advanceWake`. A console edit of `flowFoamParams` plus
  `advanceWake(0)` moved the texture within one frame.
- **Texture binding:** it is the only rgba16float StorageTexture in `positionNode`. It carries the
  field (§1).
- **Region fade:** the region is centred on the ship; the radial fade runs over 50.4–60 m, so it is
  1.0 over the whole visible wake.
- **Speed gate:** `sf` = 1 at ≥ 5 m/s (galleon) and ≥ 1.75 m/s (raft, GPU).
- **Camera:** no camera-distance gate on the elevation (by design).

Screenshots, sim frozen via `loop.tick = noop`, camera pinned with `followCam.setDebugPose`:

- `w0-03` solid, 1×, swell, quarter view 55 m astern / 16 m up: foam V and glassy lane only, no relief.
- `w0-04` wireframe, 1×: the mesh near the wake is indistinguishable from open sea.
- `w0-05` wireframe, **×20** (mound/trans/eddy slopes; the elevation clamps at ±2 m): eddies, the
  transverse trough and the mound clearly deform the mesh. **The path is live.**
- `w0-06` solid ×20: an obvious 3D wake. The shading is also ×20, so this frame alone does not
  separate geometry from shading.
- `w0-08` solid **×3** (mound 1.9 m, transverse ±0.9 m, eddies −0.75 m): **still barely reads** on
  the swell.

## 3. Grid spacing

Measured in the browser from the live grid and camera. The law is `surfaceGeometry.spacingAtRadius`
with k solved from the live mesh params.

- k = **0.020485**, confirming wake-research.md. T161(b)'s 0.136 was wrong.
- The real follow cam (mode `follow`, not the assumed 35 m) sits **25.27 m horizontally** from the
  ship origin, 16.9 m up, looking down about 34°.
- Spacing at that distance:
  - ship origin 1.02 m
  - **stem/mound 1.47 m**
  - transom 0.68 m
  - 35 m → 1.22 m
  - 60 m → 1.73 m
- The mound ridge (2·moundThick = 6.4 m) therefore spans **4.4 vertices at the stem**. The 31 m
  transverse λ at 7 m/s spans about 30. Wireframe `w0-19` (glass, 12 m astern / 25 m abeam / 3 m up)
  shows a regular ~1 m grid alongside the hull with no collapse from the radial LOD
  (`radialLodPixels` 0.125).
- **Grid ruled out as a cause.**

## 4. Displaced vs shading-only

| component | displaced | shading | peak η at 7 m/s | slope |
|---|---|---|---|---|
| bow mound | ✔ | ✔ | 0.634 | 0.17 |
| transverse train | ✔ | ✔ | 0.28 | 0.06 |
| eddy street | ✔ | ✔ | −0.25 | 0.09 |
| divergent train | ✘ (slickMath.ts:54-61) | ✔ | would be 0.27 (0.63 at 10 m/s) | 0.11 |
| foam, slick lane | — | albedo / fine-slope damping | — | — |

Energy split over a 90 × 90 m window around the hull `[M-cpu]`:

| v | divergent share of ∫η² if displaced | divergent share of ∫\|slope\|² (T + D + mound) |
|---|---|---|
| 5 | 2.8 % | 23 % |
| 7 | **6.2 %** | **33 %** |
| 10 | 11.1 % | 44 % |

- **Displacing the divergent train would add only 6–11 % of the elevation variance.** In elevation
  terms, leaving it undisplaced costs very little of the "3D-ness".
- It already carries a third to nearly half of the slope variance, and it is **already shaded**.
- A shading-only A/B makes the point on glass at a low grazing view:
  - `w0-16`: divergent slope ×8, geometry untouched. Gives crisp multi-crest ridges that read as a 3D
    wake.
  - `w0-15`: displaced terms ×3. Gives one broad, soft swelling.
- **Perceived wake structure comes from short, steep crest shading, not from the long low displaced
  terms.**
- Correction to the `slickMath.ts` header: near the cusp the divergent λ is up to (2/3)·λ_T = 21 m at
  7 m/s, which is 14–20× the vertex spacing. It is sub-Nyquist only toward the centreline, and there
  its amplitude is already gated by `bandGate`. The "~4 cm crawling moiré" figure does not describe the
  cusp region, where the would-be amplitude is 0.27 m.

## 5. Calm-sea test (`glass`, Hs 0.009 m)

- `w0-12` quarter view, 1×: **still not visible.** Foam decal only.
- `w0-13` low grazing (5 m eye), 1×: faint divergent streaks (shading) to starboard, no readable relief.
- `w0-15` low grazing, displaced ×3: a broad swell on the quarter is now visible.
- The follow cam on glass (`scratchpad/shots/11`) is the same as on swell: the hull and rig fill the
  centre of the frame, and the wake shows only as foam astern.

So removing the swell **does not** make the shipped wake visible. The swell is a multiplier on the
problem, not the root cause.

## 6. Root causes (ranked) and what they imply for W1–W2

1. **The absolute geometry is too small and too long-wavelength for the view.**
   - Evidence: invisible on glass at 1× (`w0-12`, `w0-13`, `w0-19`), marginal at ×3 on swell (`w0-08`),
     obvious only at ×20 (`w0-06`).
   - The astern features that are actually on screen:
     - transverse 0.28 m over λ 31 m (slope 0.06 = 3.4°)
     - eddies 0.25 m dimples 7.7 m wide
   - From a 34° follow-cam depression, height without steepness produces neither silhouette nor
     parallax.
2. **Masking by the sea.**
   - Peak/Hs is 0.29 on the default preset. The astern features are 0.09–0.15.
   - Their slopes are 0.44–0.66× the sea's RMS slope, so the shading is masked too.
   - At the boot location the §V46 storm cell raised Hs to 7.5 m, taking peak/Hs to 0.11.
3. **The biggest feature is hidden.**
   - The 0.63 m mound peaks 1.3 m ahead of the waterline stem, under the beakhead.
   - The follow cam is directly astern, so the hull occludes it (`w0-10`).
4. **The steep, short structure that makes a wake read is shading-only, and weak.**
   - Divergent slope is 0.11; `w0-16` shows it only reads at ×8.
   - Leaving it undisplaced costs 6–11 % of ∫η². That is **not** a primary cause of the invisible
     displacement, but it is the component the eye keys on.
5. **Ruled out:** the grid (1.0–1.5 m at the wake, §3), the wiring (§2) and GPU/CPU mismatch on the
   galleon (RMS 1.7 cm).

Side finding (§V.8, raft): CPU mirror 0.16 m vs GPU 0.62 m at 2 m/s. `speedScale` is not mirrored,
and the mound is not hull-scaled.

### Implications for the eWave plan

- **W1/W2 amplitude calibration target.**
  - Do not calibrate on elevation alone.
  - Proposed acceptance, galleon at 7 m/s on the default sea:
    - near-hull peak-to-trough ≥ ~0.3·Hs (≥ 0.8–1.0 m against 2.78 m)
    - the **wake's max slope along the cusp ≥ the sea's RMS slope** (≥ 0.14; today the transverse is
      0.06 and the divergent 0.11)
  - Both are ratios (V66) and both are measurable the way this doc measured them.
  - The physically sized pressure source should be allowed to produce the bow and cusp crests it
    produces. If the emergent field lands near today's 0.3 m trains, the result will be exactly as
    invisible as today. W1 test 5 (bow crest) should also pin a **slope** floor, not only a location.
- **Divergent waves must displace, and the eWave sim does that for free.** The W2 vertex-Nyquist gate
  (λ ≥ 2 × spacing) keeps the cusp waves: λ_D is 10–21 m at 7 m/s against 1–1.5 m spacing, so the gate
  removes only the centreline tail, which is tiny anyway.
  - Keep the `.ba` slope path for sub-grid crests.
  - Expect the "3D read" to come mostly from crest steepness. Horizontal (choppy) displacement of wake
    crests, deferred in research §5.3, is worth revisiting early in W2.
- **The bow crest must clear the hull silhouette.**
  - Contact pressure at the stem should put the crest along the forefoot and out past the side, where
    the astern camera can see it abeam of the bow.
  - The W2 browser check must include the **shipped follow cam** (25 m / 17 m up, astern), not only
    free quarter views, plus a low grazing view.
- **Extent / sponge.**
  - The visible structure is within ~60 m astern.
  - At 10 m/s λ_T = 64 m, so the 128 m near domain holds only about 1.4 transverse crests aft of a
    0.3·L_dom astern bias. That is acceptable, but the sponge (15 % a side = 19 m) must not eat the
    first cusp.
  - Prefer biasing the anchor further astern (≈0.35·L_dom), or make the 256² × 0.5 m tier 160 m at
    0.625 m if W1 reflection tests allow.
- **Test sea state.** W0/W2 browser checks must pin `weatherParams.cellIntensity = 0` or record local
  `ocean.heightRms`. The boot location's storm cell tripled Hs without any preset change.
- **W3 raft.** Retiring `speedScale` from the wake (research W3 test 1) also removes today's 0.46 m
  mirror divergence. Until then, the analytic raft mound is the galleon's mound.

## 7. Method notes (for the next measurer)

- Instruments, all in the scratchpad
  (`/private/tmp/claude-501/-Users-flo-work-code-shiver-me-timbers/adc53218-9260-41a8-8d6a-476d5936a376/scratchpad`):
  - `w0cpu.ts`, `w0energy.ts`: `vite-node` headless, CPU mirror plus a copied `slickMathD.ts` that also
    returns the would-be divergent η.
  - `w0setup.js`: in-page rAF pump, readback, freeze, pose, capture.
  - `sink.mjs`: PNG sink.
  - `vite.w0.config.mjs`: dev server with HMR and the watcher off.
- Traps hit:
  - Other agents' `src/` edits force-reloaded a watching dev server twice. Serve with `hmr:false`.
  - A second agent's tab hid ours, so `innerWidth` became 500 and extension screenshots came back
    500×232. Captures were taken with `toDataURL` inside a wrapped `loop.render` after
    `app.onResize({1280×720})`.
  - A free-running worker pump livelocked the tab. A ping-pong pump, where the worker re-arms only
    after the main thread finishes a dispatch, works.
  - A pump installed during boot needed a second `loop.stop()/start()` and `_animation` restart once
    boot finished.
  - `jumpTo('spawn')` coincided with one reload; the cause was not established.
- Screenshots in this folder: `w0-*.jpg` (JPEG at 80 % to keep the repo small; PNG originals are in
  `scratchpad/shots/`).
