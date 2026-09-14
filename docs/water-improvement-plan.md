# Water appearance and performance

**Current:** 196 m middle waves and a 128² middle CPU mirror are now enabled.
The original 98 m pitch-response regression keeps every assertion on its
reference domain/grid. New current-sea tests preserve the absolute acceleration
and motion requirements across three seeds/four headings. Real GPU time series
show 35–44% less middle-band foam pulsing. Contact foam, regional shoreline
memory, ripple decorrelation, downwind birth noise and FFT optimizations remain.
See the third-pass evidence below; earlier rollout decisions are historical.

**Latest checkpoint (thirty-third pass):** sky stays sharp through cinematic
DOF. Night wisps remain, with one-third hashed density and stronger along-line
breakup. See the night-lighting handoff and sky DOF GPU regression.

**Previous checkpoint (thirty-second pass):** night stars use a smaller,
subpixel-filtered disc; night wind streaks and LED hotspots are reduced.
Submerged hull strips and red cockpit courtesy lights are implemented. See
`water-review/night-lighting-handoff.md` for exact values, tests and GPU checks.

**Previous checkpoint (thirty-first pass):** chine history retires expired packets
in place. Live frame benchmarking is deferred under concurrent machine load;
performance claims in this pass concern allocations and work bounds only.

**Previous checkpoint (thirtieth pass):** whitecap coverage and detail reuse one
filtered warp. The full foam mask passes near/middle/far GPU comparison; see
pass 30 for numerical tolerance and validation limits.

**Previous checkpoint (twenty-ninth pass):** foam lookup warp now filters each
noise octave by pixel footprint and skips noise once unresolved. Nearby detail
is preserved; see pass 29 for fragment-stage GPU regression measurements.

**Previous checkpoint (twenty-eighth pass):** swash edge foam now emerges with
runup height instead of painting a full-strength contour between waves. Mature
edges and stranded residue are preserved. See pass 28 for GPU regression proof.

**Previous checkpoint (twenty-seventh pass):** shore runup now uses local offshore
fetch/swell energy. Exposed dry beaches retain swash; sheltered beaches get
less runup. See pass 27 for GPU parity, memory and bake-cost measurements.

**Previous checkpoint (twenty-sixth pass):** airborne spray now follows actual
sky/key light; stranded shore foam fades independently of wet sand. Day/night
and storm captures, GPU residue/cost probe, and tests are recorded below.

**Previous checkpoint (twenty-fourth pass):** surface wake and whitecaps now
follow live sky/key intensity instead of glowing at night. Day/night GPU
captures saved; airborne spray has the same separate lighting defect, still
pending. See pass 24.

**Previous checkpoint (twenty-third pass):** storm beach swash no longer hashes
continuous spatial coordinates into per-pixel amplitude jumps. GPU continuity
probe and matched storm-wave captures are recorded in pass 23 below.

**Previous checkpoint (twenty-second pass):** swell now travels along its authored
direction, matching the existing swell shadow. Cay beaches retain their authored
elevation; thin fresh aeration keeps turquoise instead of turning solid white.
See pass 22 below for measurements and limits.

**Previous checkpoint (twenty-first pass):** live bow-foam envelopes have been
replaced by retained world-space emissions. Turns, takeoff and later impacts
no longer reposition or re-drive older sources. Each emission carries its own
volume, direction and age, and retires smoothly. GPU and CPU costs, the turning
capture, and regression evidence are recorded in the twenty-first pass below.

**Performance checkpoint (eighteenth pass):** the three sea-page HUDs now measure
unclamped wall-clock frame intervals, independently of fixed-time capture or
simulation freezes. The pirate HUD also reports accumulated buoyancy-mirror
CPU time per rendered frame, including catch-up ticks.
CPU buoyancy reuses FFT plans and
evaluates equal-frequency phases once per update. Together these reduce paired
full-mirror timing from 6.805 to 5.185 ms (23.8%), with 3,932,160 float32 values
bit-identical. These are CPU update timings, not whole-frame FPS. The GPU ocean remains GPU-driven;
the larger CPU mirror is an explicit cost of widening the middle wave domain.
Wake age follows actual tier/source
coverage; empty shore support no longer turns analytic wakes into fresh
whitecaps. Cloud blur uses precomputed weights, and storm lobes form a stable
connected growth chain without added instances. Moving-wake controls, storm
captures and GPU probes are recorded below. Validation details and limitations
are recorded per pass. Nothing committed.

## Request and evidence

Improve vessel/shore contact foam, repeated wave patterns, crest formation and
dissolution, and rendering cost. Preserve the CPU/GPU sea agreement and existing
user edits. No fallback rendering paths, spectrum rerolls to satisfy tests, or
new simulation textures without a measured need.

Inspection found:

- `flowfoam/accumulation.ts` captures tagged meshes from above against a fitted
  water plane. Vertical faces have little projected area; the fit cannot follow
  wave curvature or supply shoreline contact outside the vessel's capture region.
- `flowfoam/intersectionMask.ts` has an unused screen-depth contact helper. The
  ocean already reads unrefracted opaque depth for transmission, so contact can
  reuse that read. It must reject foreground depth and the cleared background.
- FFT domains are 1010, 98 and 22.7 m. See `research-cascade-tiling.md`: the middle
  band's coherent repetition is real. Enlarging domains changes buoyancy and
  spectral quadrature; the finest domain cannot grow without losing short waves.
- Surface ripples remain six infinite carriers, despite shared coordinate warp.
  Local phase variation must operate at each carrier's scale, with its own
  sampling bound, rather than reducing visible range.
- Whitecaps already use minimum Jacobian eigenvalue, crest-aligned breakup,
  short-lived breaking and long-lived residue, diffusion and noise dissolution.
  The breakup drift uses a fixed diagonal unrelated to wind direction.
- Each FFT pass invokes `renderer.compute` separately. Three r180 supports ordered
  arrays; its WebGPU backend submits once per call. At 512² this is 20 submissions
  per cascade (spectrum + 18 butterflies + unpack), 60 across the ocean.

## Implementation slice

1. Reuse straight scene depth to add a feathered, torn contact band at the actual
   rendered waterline. Feed contact coverage through existing wake foam detail
   and lighting, so shore/vessel contact does not become an untextured white rim.
   Keep contact separate from persistent wake state: screen-space depth cannot
   supply offscreen history. Document this limit explicitly.
2. Decorrelate each ripple carrier with a smooth local phase field moving along
   its propagation axis. Retain wavelength-based antialiasing and account for
   the phase field's added frequency. This addresses small-scale woven patterns;
   it does not claim to eliminate the 98 m FFT repeat. Reuse terrain's tested
   sin-free quintic noise instead of the surface's separate sine-hash noise.
3. Advect the breakup noise coordinate along wind before converting to the crest
   frame. Preserve the two foam clocks, fold gate and diffusion. This is motion
   of the birth pattern, not a new fluid-velocity solver. Integrate the offset
   over fixed simulation steps so a wind change does not rotate accumulated
   travel and teleport the pattern.
4. Batch each cascade's existing ordered compute passes. Preserve all dispatches,
   intermediates and the spectrum/unpack ordering. Do not claim GPU milliseconds
   from submission counts or headless shader compilation.

## Acceptance and proof

- Contact mask is zero for foreground geometry, cleared depth, and water columns
  beyond its width; zero strength disables it exactly. Noise detail shares the
  existing foam art texture, without increasing the fragment binding budget.
- Ripple phase differs across translated patches and moves in its wave direction.
  High-frequency modulation retires with the carrier at pixel Nyquist.
- Breakup drift responds to wind rotation and retains simulation-time ownership.
- FFT calls fall from 60 to 3 per rendered frame at 512²; dispatch order and
  texture contents are unchanged by grouping.
- Run ocean, foam, flow-foam and binding tests, TypeScript/build, and generated
  WGSL checks. Browser look/performance results must be labelled separately from
  mathematical and source-level proof.

## Follow-on work for agents (initial handoff; second pass below)

The FFT repetition remains a separate physics-aware task. Own
`ocean/spectrumRebuild.ts`, `ocean/oceanMath.ts`, `sea-physics/cpuOcean.ts` together.
Compare a wider middle band using fixed seeds across calm/swell/storm; measure
spatial autocorrelation, foam coverage time-series, hull pitch acceleration and
CPU sampling cost. Use interpolation accuracy rather than seed-specific ratios
as the hull acceptance metric. Do not widen the finest band at fixed resolution.

Persistent shoreline foam needs a world-space regional state driven by seabed
depth and local wave breaking, with injection, transport and two-clock decay.
The boat-following capture is not sufficient. Own its coverage bounds, recentering,
seabed sampling and texture budget before implementing it. Depth contact in this
slice is the visible contact lip, not a substitute for beach swash/backwash.

Browser review should use the same time, seed, weather, camera and resolution:
stationary and moving hull, rock wall, beach, low grazing view, 50/150/300 m
elevation. Record CPU frame and GPU compute/render timings after warmup, plus
console validation errors. Inspect contact crawl, transparent objects, and foam
disappearance at screen edges. No visual approval is implied by unit tests.

## Implementation results

The four implementation items above were completed in the first pass. The
second pass below implements regional shoreline history and CPU FFT reuse.
The wider middle domain was evaluated but not enabled after its hull gate failed.

Validation: 337 tests pass across `waterImprovements`, `ocean`, `foam`,
`flowfoam`, `oceanBindingBudget`, `wakeBackend`, and `bandLimitAudit`.
Production build and TypeScript checks pass. Build warnings concern existing
non-module COI scripts and bundle size. The gated foam synchrony harness now
passes its spectrum's wind direction to the CPU breakup mirror; its expensive
statistical sweeps were not rerun, so older measurements remain historical.

Local headless Chrome, WebGPU, 1280×800, 512² cascades:

| FFT submission mode | CPU submission median | Queue-completion median |
| --- | ---: | ---: |
| Individual passes, round 1 | 1.030 ms | 5.555 ms |
| Batched, round 1 | 0.265 ms | 3.415 ms |
| Individual passes, round 2 | 0.855 ms | 5.695 ms |
| Batched, round 2 | 0.275 ms | 3.445 ms |

Each round used 15 samples, with the game loop stopped and
`device.queue.onSubmittedWorkDone()` before and after each three-cascade update.
Both modes used the same initialized compute nodes and frozen ocean input.
Readback of all three RGBA32F displacement textures (4,194,304 bytes each)
found **zero differing bytes** between individual and batched dispatches.
These are isolated FFT measurements, not a whole-frame FPS claim. The existing
GPU HUD is unsuitable for summing render passes; see `agent-browser-harness.md`.
The benchmark also exhausted its per-frame timestamp pool because the loop was
stopped; that pool was reset afterward and was not used for these measurements.

The updated material rendered in Chrome without GPU validation errors. The
scene reported a boot-time `flowFoam.update` warning about `advanceWake` ordering;
this slice does not change that frame integration. Headless wake-backend tests
also emit a vec3 codegen warning; browser rendering is the stronger check here.

[Original material](water-review/material-before.png) and
[updated material](water-review/material-after.png) show a matched low hull-side
view at simulation time 12.6 s. Both use the same current foam state: this is a
material comparison, not an A/B of the foam simulation. The contact band remains
subtle in heavy existing whitewater. Broader beach, storm, motion and elevated
camera review is still needed before visual sign-off.

Controls: `oceanSurface.contactFoamStrength` (default 0.18), with
`flowfoam.depthThreshold` and `flowfoam.maskFeather` defining the contact band.
The screen-depth width is in view-Z metres; it is view-dependent and cannot
represent offscreen contacts or persistent beach swash.


## Second pass: shoreline memory and wider-chop experiment

### Ownership and behavior

- The 196 m middle-domain candidate quarters identical middle-band tiles per
  area, but **the shipped domain remains 98 m**: its hull-response gate failed.
  The candidate is explicit in `waterSpectrum.test.ts`, not a new runtime mode.
  Long/fine domains remain 1010/22.7 m. Short-band repetition is still open.
- `params/seaPhysics.ts`, `sea-physics/cpuOcean.ts`: long mirror remains 64²;
  middle mirror can independently increase through `mirrorChopResolution`
  (shipped default 64; candidate 128). The candidate sampling interval stays
  1.53125 m, avoiding the interpolation defect from widening a 64² grid.
  Each band owns its butterfly table; changing either resolution rebuilds it.
  Worker metadata that reports `mirrorResolution` describes the base grid only.
- `ocean/oceanMath.ts`, `sea-physics/cpuOcean.ts`: reuse four FFT work arrays
  across rows/columns. This removes 1,020 typed-array allocations per 128²
  transform while retaining every float32 stage and arithmetic operation.
- `foam/shoreFoam.ts`: regional water-surface residue and fresh-breaking state
  occupy **BA of existing cascade-0 front/back/coarse textures**. RG stays the
  periodic whitecap simulation. No new texture, dispatch, or fragment binding.
- `foam/index.ts`, `foamPasses.ts`: configure shoreline once before stepping;
  inject/advect/decay BA in the existing first inject pass, preserve BA through
  whitecap blur, and include BA in the existing coarse reduction. Explicit
  `frameDt = 0` now freezes foam; invalid negative/nonfinite dt throws.
- `ocean/oceanSurface.ts`: configure from the existing seabed/fetch and follow
  camera position. `surfaceMaterial.ts`: sample shoreline in undisplaced world
  coordinates and compose through the existing foam detail/freshness lighting.

### Shoreline contract

The 512 m square region snaps to whole simulation texels (1 m at default 512²).
Previous/current origins travel with the history. Four explicit zero-boundary
history taps prevent wrapping; first dispatch and out-of-region teleports reject
old state. A 38.4 m border taper hides the regional boundary. The existing coarse
view filters minified shoreline sampling.

Source follows a thin wet column over the actual seabed, with the two resolved
wave bands' displacement, shoaling, fetch, swell shelter and breaker clipping.
The source is modulated by broad noise and positive estimated wave-rise velocity;
receding water transports/decays instead of injecting. Bed-gradient runup/backwash
and weak wind drift advect history. Breaking half-life is 0.65 s, residue 4 s;
source rate is 0.14/s before wetness/approach/noise gates. Dry ground drains foam.
These constants live together in `shoreFoam.ts` for subsequent art tuning.

Limits: rise is the narrow-band estimate `-phaseSpeed * slope·wind`, not a stored
velocity field; crossed swell can disagree with it. The finest wave band is
unresolved by this grid and excluded. This is regional water foam: departed
regions lose history, and stranded sand swash remains owned by the existing sand
material. Screen-depth vessel contact is still view-dependent and has no new
persistent vessel history; the existing wake system supplies that persistence.

### Evidence

`waterSpectrum.test.ts`, seeds 7/1337, calm/swell/storm, three times and 400
positions per case, compares the candidate 128² middle mirror against a 256² reference
from the **same** published spectrum:

| Preset | Max relative height RMS error | Max relative pitch-forcing RMS error |
| --- | ---: | ---: |
| Calm | 1.506% | 1.279% |
| Swell | 0.553% | 0.320% |
| Storm | 0.537% | 0.310% |

Pitch forcing is the pressure-head difference across a 20 m hull, not a claim
about final hull dynamics. Correlation at the former 98 m translation is
−0.174…−0.037 across both axes/seeds; at 196 m it is exactly 1.

Real WebGPU shoreline readback, 128² controlled flat-water fixture:

- First dispatch discards seeded stale history: total residue 0.
- Seeded BA `(0.5, 0.25)` after 1/60 s becomes
  `(0.4985580146, 0.2455960065)`, matching analytic two-clock decay to float32.
- An 8 m camera shift translates the same values by exactly two cells.
- Exposed cells and a 1,000 m teleport contain zero residue, with no wrap.
- Existing RG `(0.3, 0.2)` is unchanged in all these cases.

Actual scene readback during the wider-domain candidate review also finds ~14,800 active shoreline cells and peak residue
0.076 (later 0.106), confirming real seabed/wave-driven injection. This is coverage
in the state texture, not a visual approval. The updated shader renders on WebGPU.

The work-buffer regression compares every output byte against independent
allocation-per-line transforms at 8², 64² and 128². The existing naive 2D DFT
oracle remains the separate check on FFT arithmetic itself.

### Remaining review

Review shoreline over motion, calm/storm and grazing/elevated cameras; tune source
and decay only against matched captures. Re-run the long foam synchrony sweep
before claiming the temporal pulse eliminated. The 22.7 m band still repeats.
Do not widen it at fixed resolution: that loses the short spectrum. Any further
domain change must retain CPU/GPU geometry agreement and measure mirror cost.

### Second-pass isolated cost

Chrome WebGPU, 512² foam, game loop stopped; nine alternating warmed samples,
queue-completion timings for the full existing foam pass sequence (8 calls in
this configuration):

| Configuration | Median, round 1 | Median, round 2 |
| --- | ---: | ---: |
| Without shoreline | 1.045 ms | 0.965 ms |
| With shoreline | 1.125 ms | 1.095 ms |

CPU mirror update, seed 7, shipped swell, twelve warmed samples:

| Configuration | Median |
| --- | ---: |
| Old 98 m / 64² middle, allocation-per-line FFT | 2.650 ms |
| Wider 196 m / 128² middle, allocation-per-line FFT | 6.370 ms |
| Old 98 m / 64² middle, reused FFT workspace | 1.710 ms |
| Wider 196 m / 128² middle, reused FFT workspace | 4.510 ms |

Workspace reuse cuts the wider mirror update about 29% in this run. The wider
mirror still costs more than the old sea; this is an explicit fidelity tradeoff,
not an overall performance win. These timings are isolated, taken under machine
contention, and are not whole-frame FPS or mobile performance guarantees.

[Regional shoreline close-up](water-review/shore-history.png) is a local review
artifact (ignored by git), captured with the 196 m candidate. It shows
contact/residue around the beach and rocks,
but is not a matched before/after or motion review. HUD timings in the image
are stale/overcounted and must not be used as performance evidence.

Validation while evaluating the candidate: 208 tests pass across `waterImprovements`,
`oceanBindingBudget`, `bandLimitAudit`, `foam`, `flowfoam`, `seaPhysicsClass` and
`simWorkerDeterminism`. Worker modes return the same `611d7862` simulation hash.
The subsequent FFT/workspace and wider-spectrum run passes six selected tests,
including the independent naive DFT oracle. The earlier full ocean run passes
126 tests. The long full hull suite is tracked separately below.

Vite production bundling passes. Full TypeScript/build remains blocked by an
unrelated existing `src/race/ai/pilot.ts:316` unused `iT` (`TS6133`); no water
type errors remain. Concurrent course work also produces unresolved model-URL
build warnings, alongside existing COI-script and bundle-size warnings.


### Hull gate and rollout decision

The full 52-test hull suite completed: 51 pass, one fails. The candidate's maximum
pitch angle with added inertia is **7.2908°**, versus **7.5228°** without it; the
existing test requires at least a 10% reduction (below 6.7705°). The absolute
pitch-acceleration bound below 20°/s² passes, but later assertions in that test
were not reached. This could be realization-dependent forced response rather
than interpolation error; the accuracy measurements above do not resolve it.

Do not reroll a seed/domain or weaken the assertion to make it green. The shipped
middle domain and default CPU grids are restored to 98 m and 64²/64². The
independent middle-grid control, candidate tests and measurements remain for the
next physics-aware investigation. FFT workspace reuse is byte-identical and
retains its measured 2.650 → 1.710 ms gain on the old/default sea in this run.

The same long run reported two obsolete failures from before the shoreline
binding ledger and filtering annotations were corrected. Both corrected audits
pass in the later focused run. The restored-default hull gate passes (22.9 s); the same targeted run also
passes all four candidate spectrum tests and the byte-exact FFT workspace test.
No hull assertion or seed was changed.


## Third pass: enable wider waves with independent hull acceptance

### Why the previous gate needed a distinct fixture

The old test compared the current hull against a different rigid/added-inertia
model and expected at least a 10% reduction in **peak angle**. Added inertia
changes resonance as well as acceleration response. A changed spectrum therefore
changes that ratio; it is not an invariant of inertia. The earlier domain sweep
already demonstrated this across 130–215 m (`research-cascade-tiling.md`, §4).
The 196 m failure was real as a regression result, but did not prove that the
actual ship violated its absolute motion requirements.

`tests/seaPhysics.test.ts` now retains that complete regression on its 98 m,
64²/64² reference domain and sampling. Its seed and every assertion are unchanged.
Three additional tests run the **current default sea and mirror** at seeds
7/11/1337, four headings, 2,400 ticks, with 600 warmup ticks. They retain the
existing absolute requirements: peak pitch acceleration below 20°/s² and visible
pitch motion above 3°. The separate free-decay/period and inertia derivation
checks still test the causal effect of added inertia. No mass, damping, inertia,
wave amplitude or seed was tuned to satisfy these checks.

| Seed | Peak pitch acceleration | Peak pitch angle |
| --- | ---: | ---: |
| 7 | 16.7755°/s² | 6.0771° |
| 11 | 19.5587°/s² | 7.2908° |
| 1337 | 9.9199°/s² | 4.7734° |

These are sampled acceptance cases, not a claim that every possible seed is
bounded below 20°/s². Seed 11 has only 0.44°/s² headroom, so further sea or hull
changes must rerun this test. The earlier pressure-head/height accuracy tests now
exercise shipped defaults rather than a separately configured candidate.

### Real GPU foam pulse measurement

Chrome WebGPU, 512² waves and foam, actual `OceanSimulation` and `createFoamSim`,
fixed 1/60 s steps, 50 s per case. Discard 10 s warmup and read the middle band's
RGBA32F state every 0.5 s for the remaining 40 s. Form optical coverage from the
real residue/breaking channels using the shipped weights, breaking gain and
`1 - exp(-density * raw)`. This excludes material detail, world variation,
lighting, the other bands and shoreline foam. Both domains use the same seed,
weather, frame step and simulation code; only middle domain changes.

| Seed | Domain | Mean band coverage | Temporal CV | Min / max coverage |
| --- | ---: | ---: | ---: | ---: |
| 7 | 98 m | 2.022% | 0.690 | 0.367% / 5.895% |
| 7 | 196 m | 2.758% | 0.386 | 0.953% / 4.862% |
| 1337 | 98 m | 1.929% | 0.632 | 0.459% / 5.375% |
| 1337 | 196 m | 2.390% | 0.412 | 0.819% / 4.683% |

Temporal coefficient of variation falls **44.1% and 34.7%**. Mean middle-band
coverage rises **36.4% and 23.9%**; this is a visible tradeoff, not a claim of
constant coverage or elimination of pulsing. The finest 22.7 m band is unchanged.
Spatial correlation at the former 98 m translation remains −0.174…−0.037;
the new 196 m period is still exact. No new wave textures, FFT passes, or bindings.
Raw local time series: `docs/water-review/foam-pulse.json` (ignored review artifact).

Prior isolated CPU reference: 4.510 ms for wider waves with FFT workspace reuse,
versus 2.650 ms for the old smaller sea before that optimization. That benchmark
predates concurrent surf-zone integration; final whole-frame timings were not
measured. Do not sum it with GPU timings or claim a whole-frame FPS gain.


Matched local captures: [98 m reference](water-review/waves-98m.png) and
[196 m middle domain](water-review/waves-196m.png). Camera `(0,100,-600)` looks
at `(0,0,-800)`, seed 7, simulation time 20 s, 1280×800. Each surface uses its
own wave/foam state warmed for 20 s, in the same frozen scene and lighting.
The water is 45 m deep here; this is an open-water comparison, not a shoreline
or vessel-motion review. Images are review artifacts. Increased foam
coverage is visible; the fine-band pattern toward the horizon remains.

TypeScript and Vite production bundling pass; the earlier unrelated race-AI
error was resolved by concurrent work. The full 55-test hull suite passes,
including the unchanged assertions on the 98 m reference and all three new
current-sea cases. Ocean (126), foam (100), spectrum (4), water improvements (7),
binding budget (4), and band-limit audit (2) pass.

The first shoaling run loaded a test version just before a concurrent edit
(file changed at 15:37:37; run started 15:37:26), and reported one stale failure.
Both 98 m and 196 m controlled checks of the current test pass. Current full
shoaling verification is recorded below; no shoaling code or thresholds were
changed in this pass.

Final current shoaling run: **33/33 pass**. Total across the eight focused files:
**331 tests pass**. TypeScript, production bundling and `git diff --check` pass.
The shoaling fixture emits its existing missing-key-light diagnostic. Review
browser/server are closed. No commits were made.

## Fourth pass: batch foam submissions and isolate the commit

Foam now submits its eight ordered kernels once per fixed simulation step,
retaining inject, blur and reduction ordering. Shoreline configuration replaces
the first two kernels in that stable group before the first dispatch.

Real WebGPU comparison on the isolated commit snapshot: 30 steps, 10 warmup,
20 measured samples, 512² waves/foam and a configured shallow-bed shoreline.
All three RGBA32F foam textures were **byte-identical** between individual and
batched dispatches (4,194,304 bytes each); shoreline residue was nonzero, so BA
preservation was exercised as well as whitecaps. Median CPU submission time
fell from **0.150 to 0.075 ms**. Queue completion measured 0.950 versus 0.995 ms;
this run establishes lower CPU overhead, not a GPU-time improvement.

Selective commit excludes concurrent shoaling-growth, cinematic, post-processing,
and asset changes. In mixed files only this task's changes are included; the
shoreline module uses the existing committed shoaling law in that snapshot.
The working tree retains the other agent's newer surf-law integration intact.
Initial isolated snapshot validation: TypeScript, production build, and 18 focused
tests pass. The remaining five focused files pass all 382 tests: **400 tests
pass in the isolated snapshot**. No commit was made; the latest supplied
AGENTS instructions forbid commits.

Continue after the commit: above-water wave/foam shape, wake integration, and
measured frame cost remain active work. Underwater atmosphere/ambience is queued
behind the above-water work, per the user's latest priority.

## Fifth pass: keep wake churn anchored during region movement

`flowfoam/accumulation.ts` advected history through the region shift, but its
foam-dependent curl strength sampled the unshifted old texel. Moving the vessel
therefore applied churn from a different world location. The source now reads
that world cell in the previous region, with zero outside its bounds. The
existing texel-snapped centre allows one integer texture load, preserving the
read count. Near/far advection and blur also share one ordered submission per
tier instead of two separate submissions.

The saved browser regression is `docs/water-review/wake-recenter-probe.js`.
It creates independent 64² accumulators with identical world-space foam and
compares overlap after ±4 m X/Z and diagonal region moves. Noise, advection,
and foam-dependent churn are enabled; diffusion is disabled to isolate motion.
Before the fix, maximum coverage error was 0.02054393. Afterwards four cases
are exact and the fifth differs by 1.78814e-7 (float32 interpolation rounding).
The probe throws above 1e-6 and runs without changing live game parameters.
This proves world anchoring, not a subjective assessment of wake appearance.

A separate 512² WebGPU comparison ran 50 steps, discarded 10 warmup steps,
and alternated individual/batched order across 40 timed samples. All 4,194,304
bytes of RGBA wake state matched. Median CPU submission was 0.025/0.020 ms;
queue completion was 0.710/0.690 ms. This is a small overhead saving; it does
not establish a meaningful whole-scene FPS gain. No extra texture or dispatch
was introduced.

Validation: TypeScript passes; flow-foam and water-improvement suites pass all
91 tests. Saved browser regression also passes. Current shoreline surf-law
integration and all other concurrent edits remain untouched. No files staged
or committed, following the latest supplied AGENTS instructions.

Remaining above-water review: actual moving-vessel screenshots, fine-band
repetition/coverage tradeoff, crest alignment versus local wave direction, and
whole-scene GPU cost. Shoreline rise currently uses wind-projected slope even
for swell; replacing it needs a consistent propagation/velocity signal, not
an arbitrary blended direction (shadow strength is not swell energy share).

Full-scene review at 1280×800 (isolated snapshot, default lagoon, above water):
27 render passes and 19–27 compute passes per frame. The fresh timer window
reported 3,594 successful reads, no misses/overflow/unwritten pairs, and no
instrument errors. Compute minima over 60 samples: FFT cascades
0.754/0.779/0.766 ms, foam group 0.641 ms, near wake 0.238 ms, far wake 0.061 ms.
These are pass measurements in this scene, not savings against a baseline.

Render timing is currently unsuitable for optimization decisions. Several
small bloom passes each report roughly 10 ms, summing to 99.4 ms render time
while the visible frame HUD reports approximately 24.4 ms/frame. Healthy pool
counters do not establish correct pass attribution. Diagnose raw timestamp
intervals and compare a controlled bloom-only workload before trusting the
render ranking; do not optimize bloom based on this table or claim a measured
whole-frame win. The earlier independent kernel queue/equality proofs do not
use this instrument.

Production build passes after the wake change. The initial above-water visual
check remains very busy at the horizon, so this is not final visual acceptance.
A subsequent live moving-vessel capture was rejected because the review ship
sank during the running scene; a controlled vessel pass remains necessary.

A fresh `?at=spawn` reload cleared the old breach state. With the opponent moved
out of combat range, the undamaged vessel ran at roughly 11 m/s, flood = 0.
`docs/water-review/moving-vessel.png` records the above-water trailing-quarter
view with a camera tracking the vessel. This is a current-state review, not a
matched before/after image. The wake is continuous, but broad foam patches,
busy distant highlights, and a saturated blue patch beneath the vessel still
need investigation. Do not treat this screenshot as final art approval. The
HUD's render timing in the image has the anomaly described above.

Next bounded work packages for subsequent agents:

1. **Crest and wake silhouette:** fixed seed/time/camera in open water, isolate
   whitecaps, analytic wake, and reflected highlights one at a time. Identify
   which source forms the broad patches before changing erosion or density.
   Retain calm/swell/storm coverage measurements; no global bias adjustment
   solely to rescue one sea state.
2. **Vessel blue patch:** preserve a matching view and separately disable body
   scattering, reflection, transmission, and wake smoothing in review-only
   experiments. Trace the responsible term before changing any color.
3. **Render cost:** record raw begin/end intervals for the bloom passes and
   reproduce with an isolated render chain. Prove timer attribution before
   using its summed render cost to choose optimizations.
4. **Shore rise direction:** obtain actual vertical velocity or a spectrum-based
   estimate that distinguishes swell propagation from wind. Validate incoming,
   outgoing, and crosswind swell against temporal height differences; keep the
   existing two-band geometry and concurrent surf-law integration consistent.

Underwater atmosphere remains lower priority until these above-water checks
are resolved. No unsupported fallback or new rendering dependency was added.


## Sixth pass: correct refraction and the blue seabed highlight

### Refraction follows the camera and one consistent depth sample

`surfaceRefraction.ts` projects horizontal normal tilt into the camera's basis,
with WebGPU's downward screen-Y convention and viewport-height scaling. The
old world-X/Z offset changed its physical meaning when the camera rotated and
stretched with aspect ratio. This remains the existing screen-space refraction
approximation; it is not a ray marcher or a full Snell solver.

The existing bent/straight color selection now selects the corresponding depth
as well. Previously, a bent lookup hitting foreground selected straight color
but disabled transmission using the rejected bent depth, producing opaque
patches along submerged hull edges. Cleared depth is not treated as geometry.
No new fallback path, sample, texture, or render pass was introduced.

Tests exercise valid bent geometry, foreground rejection with a valid straight
hull sample, and cleared/background rejection. The saved browser probe is
`docs/water-review/refraction-probe.js`; it runs the actual helper on WebGPU.
Four joint camera/wave rotations give identical output. Flat water gives exact
zero; halving viewport width preserves displacement in pixels. Top-down normal
(0.3, sqrt(0.9), -0.1), strength 0.02, viewport 1280×800 produces offset
(-0.00375000015, 0.00200000009), with the expected bend sign.

### The blue patch was unattenuated seabed specular

Controlled scene: default swell at `?at=spawn`, simulation time
76.56666666666361 s, player position
(-49.6122375767, -1.0789206151, 813.0871752996), camera offset
(+25, world Y=9, -20), aimed at the hull at world Y=-1. The review snapshot
excludes concurrent surf-law/cinematic edits; working-tree build/type checks
include them. The loop was frozen while rendering continued.

Evidence sequence:

- Front/back-face diagnostic was entirely front-facing in the affected region.
- Disabling reflection left the cobalt patch intact.
- Suppressing transmitted scene light removed it.
- Hiding the ocean exposed a shiny rectangular terrain surface. A raycast
  identified `island-terrain`, around (-96.83, -43.57, 839.06), not a wake mesh.
- Water lighting attenuated its diffuse albedo, but standard PBR specular still
  received unattenuated sunlight. The ocean then absorbed red and green from
  that bright highlight on the way to the camera, making it cobalt.

`waterLighting.attenuation` now exposes the existing Beer-Lambert node already
used by diffuse albedo. Sand and blended terrain use `WaterLitMaterial`, a
standard lighting-model extension that applies that same attenuation to direct
and indirect specular. Diffuse is not attenuated twice. Emissive caustics are
added after this stage and retain their existing absorption. Dry terrain gets
identity attenuation. Existing roughness, palette, and water coefficients stay
at their authored values; no new texture, sampler, pass, or tunable is needed.

Final actual-material captures: `docs/water-review/seabed-before.png` and
`seabed-after.png`. A review-only uniform disabled/enabled the specular
attenuation at the same time, pose and camera. In rectangle x=[600,880),
y=[435,533), bright-blue pixels (display RGB: B>=90, B>1.5G, B>2R) fell from
**4,553 to 62**. This is a reproducible image diagnostic, not radiometric data
or a cross-lighting art threshold. Reflection/transmission controls separate this cause from the refraction fix.
The refraction comparison was also rechecked against Vite's actual versioned
material module, avoiding the risk of a duplicate module with disconnected
uniforms. Verified captures at time 62.16666666666442 s are
`refraction-verified-before.png` and `refraction-verified-after.png`.

### Skip the default foam identity rotation

At `crestElongation=1`, rotating into a crest frame and back is mathematically
the identity. The shader nevertheless evaluated angle FBM, sine and cosine for
both crest and wake detail. A uniform branch now returns the input coordinate
at that setting; anisotropic settings retain the existing transform. It also
avoids rotation roundoff on large world coordinates.

Independent WebGPU shading probe: two foam masks, 1024×512 float target,
40 measured samples after 10 warmup, interleaved old/new order. Default-setting
queue-completion median was **0.695/0.665 ms**; CPU submission was 0.030 ms for
both. At elongation 2 the corresponding queue numbers were 0.685/0.705 ms.
This is a small default-path saving in an isolated shader workload, not a
whole-scene FPS claim. Float image RMS differences were 3.153e-5 at elongation 1
and 1.315e-5 at 2; maximum differences were 0.001702 and 0.002117. The algebra
is unchanged, but generated-shader arithmetic is not byte-identical.

### Validation and next work

TypeScript and production build pass. Water-refraction, terrain-specular,
caustics, terrain, terrain quick-wins, foam, and ocean-binding checks pass
(200 distinct tests across seven focused files, run in focused groups). Both
the full scene and the saved refraction probe compile and execute in WebGPU.
The material tests preserve dry lighting, attenuate direct and indirect
specular, prove diffuse is not darkened again, and preserve attenuation when a terrain
material is cloned.

Remaining above-water work: broad whitecap silhouettes and busy distant
highlights. A frozen whitecap-density-zero control removed the detached blobs
while retaining the vessel wake, locating their main source in crest foam.
Do not retune wake injection to solve those patches. Render timer attribution
still needs repair before its summed render numbers can drive optimization.
The underwater branch is also worth profiling for unnecessary above-water
work, but shader derivative legality must be checked before adding a branch.
No files staged or committed; current AGENTS instructions prohibit commits.

## Seventh pass: storm-cloud fragments and rendering cost

The user added storm clouds that sometimes resemble small grey balls. The
isolated actual cloud pipeline reproduced this with the shipped global storm:
176 of 281 seed-1 lobes had no overlapping ellipsoid neighbour. Existing cloud
composition tests exercised fair-weather support only. Noise already deforms
both the lobe mesh and the surrounding sprite, so adding noise would leave the
separated objects intact.

Two layout mechanisms compounded the problem:

- The storm preset reduced lobe fractions to 0.13–0.24 while the local storm
  transform multiplied them by another 0.62 and stretched the tower to 2.6 radii.
  Storm growth now uses 1.4 lobe scale, approximately the cube root of the
  default 2.6/0.95 height increase. The full storm preset retains 0.24–0.40
  support at the existing 30–46 lobes per ring cluster.
- The full storm preset already authored its large radius and low base, then
  local-storm modifiers doubled the radius and dropped the base again. Its
  modifiers now become identity. All six other presets explicitly restore the
  local-storm modifiers, so switching away from storm cannot retain them.

Across seeds 1–20, global storm now has 3.8% detached lobes and 92.2% of lobes
belong to each cluster's largest connected component. Local storm growth under
shipped ambient parameters has 7.9% detached lobes. These are diagnostics of
undisplaced ellipsoid support, not a claim that every noise-displaced surface
intersects. A few detached top fragments remain; connected growth or better
anvil sampling would be the next shape work. Calm layout and RNG consumption do
not change, and neither instance count nor render-target allocation increases.

Fuller clouds cost fill work. Before optimization, matched cloud-only queue
measurements rose 1.590 to 1.685 ms for global storm and 1.520 to 2.080 ms for
local storm. These measurements include composite and exclude the rest of the
game. Do not claim a net whole-frame speedup from the later optimization.

The cloud icosphere was non-indexed. Its expensive displacement and normal
shader therefore ran on repeated identical vertices. `cloudGeometry.ts` now
indexes only bit-identical position, normal and UV tuples, retaining seams,
triangle order, and detail-zero flat normals. Default detail 2 has 180 triangles
in Three r180, with 540 original vertices and 101 indexed vertices. Four tests
reconstruct every original triangle attribute bit at detail levels 0–3.

The two dependent blur dispatches now share one command submission. Actual GPU
comparisons of the complete 768×432 RGBA16F blurred cloud texture found zero
changed components for both full storm and local storm. Paired warmed queue
measurements for cores plus blur fell 1.885 to 1.615 ms and 2.200 to 2.000 ms,
respectively (60 samples each, alternating order). A zero-alpha sprite discard
experiment saved little and changed four half-float components in one frame;
it was rejected. No sprite shader changes remain.

Validation: 195 tests pass across cloud geometry, storm mass, existing clouds,
cloud coupling, weather and ocean binding budgets. Typecheck and production
build pass. `docs/water-review/storm-clouds.json` records measured conditions;
`storm-clouds-before.png` and `storm-clouds-after.png` are matched local captures.
`cloud-review.html` runs the actual cloud pipeline against a constant background
for diagnosis, without atmosphere, ocean or game postprocessing. The captures
are not a final full-scene art approval.

### Water continuation: variance during distance fades

Both FFT normal retirement and micro-wave retirement restored `(1 − fade)` of
the band's variance after multiplying its slope amplitude by `fade`. Variance
scales with amplitude squared: at half amplitude, only one quarter remains in
the normal, so the unresolved distribution must receive three quarters. The
old accounting lost one quarter of the original variance at that transition.

`surfaceFiltering.ts` now provides the shared `1 − fade²` complement for both
paths. Cascaded amplitude fades are multiplied before squaring. Existing
roughness limits, physical wave amplitudes, wake damping, shoaling and noise
remain untouched. The result is still the existing slope-variance approximation
to the displaced normal; this does not solve its other modelling limitations.
No new texture, sample, pass or parameter is introduced.

Tests integrate the resolved sine wave numerically and add the actual scalar
shader graph's unresolved contribution throughout the fade. All 143 focused
water/ocean/binding tests pass. The actual GPU graph at 64 amplitude samples
matches the analytic result and conserves the total with zero observed float
error; `docs/water-review/variance-probe.js` reproduces that check.

The full ocean shader compiled and rendered. Matched `variance-before.png` and
`variance-after.png` freeze sim time 10.533333333333436, vessel position
[4.162717174946129, -0.8665023527056385, 82.49908015013177], camera
[vessel.x + 15, 5, vessel.z − 20], target [vessel.x, 0, vessel.z + 100]. The
water-only rectangle x=[380,700), y=[310,510) changes 511 of 64,000 pixels, with
mean absolute RGB difference 0.0100 on the 8-bit display scale and maximum 11.
This is a small transition correction, not evidence that the busy highlights
are solved. Broad foam silhouettes and the remaining glint appearance still
need separate visual controls. The HUD's frozen-frame performance figures are
invalid and must not be used as timing evidence.

Final seventh-pass verification: 334 distinct focused tests across eight files,
production build and `git diff --check` pass. The saved variance GPU probe also
runs successfully. No changes are staged or committed.

## Eighth pass: sparkle retirement and vessel reflection direction

### Sparkle average

The radial sparkle is `smoothstep(R, 0, distance)`, but its retirement used
`πR²/2` as the cell mean. Integrating the actual radial profile gives `3πR²/10`.
The old value therefore made the unresolved disc contribution 66.7% brighter
than the resolved disc's mean. This is a shape-average error, separate from the
previous pass's wave-variance error.

`sparkleMath.ts` calculates the average on the CPU. It includes the square-cell
clipping integral for radii above half a cell; simply changing 0.5 to 0.3 would
still be wrong for those supported panel settings. The existing shape uniform
now carries the mean in its third component. The shader no longer recomputes
coverage for every water pixel. Removing the absolute 0.05-pixel radius floor
keeps the radius/cell ratio constant, including small-radius panel settings.
The regular sparkle radius, density, strength, and cell-size defaults are unchanged.
This fixes the disc expectation only; the hash/twinkle probability model remains
an approximation and is not claimed to become an exact global energy integral.

Ten tests compare the analytic mean with numerical integration for small,
jittered and clipped discs, plus continuity and input validity. The runnable
`sparkle-mean-probe.js` compares the actual GPU radial shape with the CPU mean.
At the default radius ratio 0.8/2.6, GPU mean is 0.0892286783 against expected
0.0892286671. All seven tested radii have absolute error below 8.2e-7.

Actual ocean shader compilation succeeds. Matched open-water captures are
`sparkle-open-before.png` and `sparkle-open-after.png`, sim time
12.83333333333355, camera [5.235624853695584, 4, 257.7722350839553], target
[-136.1857313836139, 0, 294.37477546239916]. Water rectangle x=[380,1000),
y=[320,520) changes 48,125 of 124,000 pixels, mean absolute RGB difference
0.2227 on the 8-bit display scale. This is a restrained correction, not removal
of the sun path. The shader does less coverage arithmetic; no whole-frame speed
claim is made from the invalid frozen-frame HUD timings.

### Planar reflection direction

The planar mirror distorted screen UV with raw world-space normal X/Z. Rotating
the camera therefore changed which wave component moved the reflection sideways
or vertically. This was the same coordinate-space mistake found earlier in
refraction, but the mirror has different handedness and needs a separate law.

`reflectionDistortionNode` now forms the difference between the wave-reflected
ray and the flat-water ray, mirrors it into the source camera frame, and projects
it onto screen axes. It handles the virtual camera's reversed right vector and
the texture's downward V axis. Half the ray deflection preserves the existing
slope-strength calibration near normal incidence. Viewport-height scaling makes
uncapped pixel displacement consistent across aspect ratios. The existing UV
cap, mip selection, reflection coverage, render resolution and texture reads
remain unchanged. This is still a bounded planar-mirror distortion approximation,
not a ray-traced reflection or an occlusion solution.

A simpler projected-normal candidate was replaced before finalization: it lost
vertical distortion near grazing, even though a tilted mirror rotates the
reflected ray there too. The ray difference avoids that failure.

`reflection-distortion-probe.js` checks the actual GPU helper at top-down view,
flat water, four joint camera/wave yaw rotations, changed viewport aspect, and
45-degree versus near-horizontal views. Top-down UV offset is
[-0.0035575626, -0.0018973666]; flat water is exactly zero; joint-yaw outputs
agree within 1e-9. The actual full ocean compiles and renders. Matched vessel
captures are `reflection-distortion-before.png` and `reflection-distortion-after.png`,
sim time 30.783333333332866, ship [5.649856902056862, -2.3731096148439277,
304.7340526717809], camera [ship.x + 25, 7, ship.z − 20], target
[ship.x, −1, ship.z]. Flags and the performance HUD are not frozen by the water
simulation clock; do not use them for pixel equality or performance conclusions.

### Remaining visual diagnosis and validation

In the frozen sun-facing open-water view, disabling sun glints removes the
near-field white patches. Distant bright wave bands remain. Disabling whitecap
foam changes little in that particular view; disabling reflection removes the
bands. Disabling micro-wave detail does not remove them. The next reflection
investigation should examine the analytic sky contribution, grazing Fresnel and
wave self-masking, rather than retune foam to hide a reflection artifact. The
separate broad foam silhouettes still need a frame where their contribution is
visible and measurable.

An underside-branch performance shortcut remains unimplemented: `skySunTerm`
uses `fwidth`, so moving it into non-uniform front-face control flow could break
WGSL derivative requirements. Establish derivative-safe factoring before trying
that optimization. No branch or fallback was added.

Validation: 177 tests pass across sparkle math, planar reflection, ocean,
binding budgets and water regressions. Typecheck, production build and
`git diff --check` pass. No new simulation textures, samplers or passes. Nothing
staged or committed.


## Ninth pass: reflection horizon and bright wave ribbons

### Evidence and change

The sky dome clamps direction elevation to zero below the horizon. That is
useful for its background, but water reused that bright horizon for downward
reflection rays too. A red/green sign diagnostic (`sky-ray-mask.png`) aligns
negative reflected elevation with many bright wave ribbons. Disabling the sun
terms did not remove those ribbons in the earlier control.

`reflectionSkyVisibilityNode` partitions the analytic environment between sky
and the existing shaded water-body radiance. Its smoothstep width is the larger
of twice the pixel derivative width and twice the unresolved slope standard
deviation, with a 1e-4 floor for the zero-width boundary. The latter preserves
roughness when distant normal bands retire. The sea contribution is blended
after the sky's grazing colour adjustment, avoiding a second water tint. Valid
planar geometry reflections still override through existing coverage.

This is an explicit local-radiance approximation to wave-to-wave reflection,
not traced visibility. It does not model distant terrain occlusion, multiple
reflection bounces or sun masking. The smoothing width is approximate, not a
fitted microfacet visibility distribution. No new texture reads, simulation
buffers or render passes; additional pixel arithmetic includes sqrt, derivative,
smoothstep and colour mixing. No GPU speedup or whole-frame timing claim.

### Verification and review artifacts

The actual WebGPU helper passes 64 samples: maximum CPU/GPU formula difference
1.11e-16, sky/sea complement error zero. Run `probeReflectionSkyVisibility` from
`docs/water-review/reflection-sky-probe.js` with an initialized WebGPU renderer.
Three scalar graph tests cover hemisphere endpoints, bounded monotonic and
complementary shares, and roughness after screen derivatives disappear.
The focused water, ocean and binding suite passes 146 tests.
Typecheck, production build and `git diff --check` pass. Build retains existing
large-chunk and non-module script warnings. Nothing staged or committed.

Matched `horizon-final-before.png` / `horizon-final-after.png` use simulation
time 16.916666666666988, camera [5.679285299919145, 4, 303.0652373707844], target
[-135.74207093739034, 0, 339.66777774922826], with normal sun lighting restored.
The broad bright reflection ribbons reduce while sun glints remain. The matched
higher-view pair `horizon-high-before.png` / `horizon-high-after.png` uses camera
[30, 24, 320], target [5, 0, 300], at the same simulation time. Shallow bottom
structure remains visible. Neither pair proves temporal stability across all
weather or camera states. The performance HUD is invalid while simulation dt=0;
exclude it from comparisons. Initial captures used a stale Vite module and were
replaced only after rebinding the actual versioned material controls.

### Next work

Measure visible foam silhouettes and wake breakup in motion, particularly the
large solid patches in the higher view. Establish a repeatable moving camera and
boat route before tuning birth/dissolve thresholds. Preserve the reflection
controls so foam is judged separately from bright specular waves. Underwater
ambience remains deferred behind above-water appearance and performance.


## Tenth pass: foam body age without an opacity increase

`surfaceMaterial` already passes combined wake/contact/shore age as
`foamDetailMask`'s `detailRetire`. The edge used that age, but the body ignored it
and treated coverage as freshness. At fixed dense coverage, old wake therefore
kept the fresh crest pattern indefinitely. `foamShading` now uses the supplied
age for the body handover when a breaking-channel share is not supplied. The
existing mean normalization remains unchanged. Whitecaps continue to use their
breaking-channel share; callers with no age retain their existing behavior.

The first candidate supplied age as the breaking share too. Actual GPU output
showed that this raised mean dense aged foam alpha from 0.324 to 0.535, about
65%, because soft and crest art have different means. That candidate was
removed. The retained change affects pattern selection while preserving the
existing expected mean. No new shader branches, texture reads, passes or buffers.

`foam-age-probe.js` renders the actual shader at doses 0, 0.2 and 0.7, ages 0,
0.53, 1.06 and 2.12 seconds over a 32 m square, sampled at 256². It accepts an
initialized renderer and the baseline foam-shading module (exports
`foamDetailMask` and `updateFoamShadingUniforms`). The isolated comparison keeps
that pre-edit module at `/private/tmp/water-selective/src/foam/foamAgeBefore.ts`.
Results are saved in `foam-body-age.json`. All 12 cases are finite and bounded;
bare water stays zero; mean coverage differs by less than 2%, below the probe's
3% limit. At dose 0.7 and age 1.06 seconds, mean alpha is 0.324432 before and
0.324327 after, while mean absolute per-pixel difference is 0.128241.

`foam-body-age.png` shows equal-dose old/new body patterns at age 1.06 seconds.
The aged film is visibly softer. This isolated patch does not prove that large
full-scene foam silhouettes or wake motion are solved. Those still require a
moving scene review; do not describe this as a complete wake appearance fix.
No whole-frame performance improvement is claimed.

Four wake shader tests initially failed because their helper discarded all
batched submissions, including the near/far accumulation passes introduced in
an earlier performance pass. The helper now verifies and flattens the final two
2-pass batches, preserving the shader/uniform assertions. All 158 distinct
focused tests pass across wake W5b, water improvements, foam and foam textures
(the corrected wake/water subset has 43 passing tests). Production build and
`git diff --check` pass. Nothing staged or committed.


## Eleventh pass: frame-independent source survival

Flow-foam accumulation used `old * exp(-k*dt) + rate*dt`. Old foam decayed
through the frame, but the entire new source arrived at the frame end. Thus a
steady source produced more surviving foam at low FPS. At the shipped 5 s near
half-life, the equilibrium excess was 1.3927% at 5 FPS versus 0.1156% at 60 FPS.
At a 0.5 s half-life it reached 14.5027% versus 1.1597%. This is a real timing
error, but too small at shipped settings to explain all large foam patches.

`decayedSourceDuration` computes `-expm1(-k*dt)/k`, where `k = ln(2)/halfLife`.
Both wake backends use separate integrated durations for foam and slick;
waterline capture uses the foam duration. The exponential runs on the CPU,
once per channel per tier, with no new texture reads, passes or GPU buffers.
The existing scalar source-duration uniform becomes a vec2. Invalid half-lives
and timesteps throw before accumulation uniforms are changed. Zero dt injects
zero; it does not skip recentering or the existing compute dispatches.

The source is assumed constant within a frame. This fixes reaction/source
integration only: moving-hull sampling, semi-Lagrangian transport error, blur
saturation below roughly 21 FPS, and within-frame source changes remain.
Saturation at coverage 1 also limits the unsaturated partition proof. No new
substeps or claimed frame-time savings. Source integration now accounts for the
small age of foam created during the frame, so the foam/slick ratio can differ
slightly from instantaneous injection.

Four CPU regressions cover frame partitions, a shared source-stop boundary,
zero/tiny dt and invalid clocks. The actual GPU probe runs three seconds of
constant injection at 5, 30, 60 and 144 FPS on 8² accumulation textures. It tests
foam and slick against the analytic solution with flow/blur disabled. Worst
absolute error is 2.79395e-7; results are in `foam-timing.json`, runnable probe
in `foam-timing-probe.js`. This proves the production accumulation wiring,
not a separate scalar mirror. All 114 focused tests pass across flow-foam,
wake W5b and source timing.

The full workspace build currently fails in unrelated edits:
`src/sea-physics/hullWater.ts` unused variables, `src/speedboat/assets/slotMaterials.ts`
argument mismatch, and missing exports used by `tests/assetPipelineChecker.test.ts`.
Those files were not changed in this pass. Keep their ownership separate.

The isolated review copy builds successfully after synchronizing the already
fixed `waterLitMaterial` typing from the workspace. This copy contains review
controls, so it is compilation evidence for the water changes, not proof that
the full current workspace builds. `git diff --check` passes. No commits.


## Twelfth pass: coverage-weighted wake age at tier boundaries

The near/far handover blended freshness by distance alone. At a 50% crossfade,
fresh foam in only one tier therefore read as half-aged because the empty tier
returned zero freshness. Disabling far foam could still leave its age influencing
visible near foam. The material then changed body, dissolve and colour based on
an invisible source. `coverageWeightedAgeNode` now weights each tier by the same
coverage, edge fade, far strength and distance blend used by `foamSampleNode`.
The age is the contributed fresh coverage divided by contributed total coverage.

Two scalar graph tests cover empty sources and conservation of fresh coverage
across 101 handover weights. The actual GPU `wake-age-handover-probe.js` fills
both production accumulation textures and samples the real flow-foam API halfway
through the handover. Near-only, far-only and far-disabled cases all return age
1, at coverage approximately 0.2. The previous distance-only blend returned 0.5
for the one-tier cases. All 63 focused water, wake W5b and wake backend tests
pass, including ocean shader construction and binding-count checks. No new
texture or sampler bindings. Added weighting arithmetic only. Source-age ratios
remain approximations for mixed injection histories; this does not make them
exact particle ages. Nothing committed.


## Thirteenth pass: fixed cloud blur weights

The separable blur evaluated Gaussian exponentials inside a 13-iteration GPU
loop per pixel, in each pass. The tap count and weights are fixed, so the graph
now builds those weights once and emits the taps directly. Float32 rounding is
retained in the weight calculation. Radius uniforms, depth dependence, clamped
sampling, texture formats and ordered two-pass submission remain unchanged.

The actual GPU comparison uses a packed density/depth fixture at 768×432.
32,039 of 1,327,104 half-float components differ; maximum absolute difference
0.00048828125, RMS 0.0000451632. This is not bit-identical. No added reads or
passes. An isolated, alternating eight-run batch benchmark gave median queue
completion 3.015 vs 2.7981 ms in one run and 1.1175 vs 0.6769 ms in a second,
16 retained samples per variant. Both favor the candidate, but system load
changes absolute timings substantially. Do not turn these into a whole-game
FPS claim. Earlier single-dispatch timings conflicted under full-scene reloads
and were discarded as performance evidence.

The reusable `cloud-blur-probe.js` accepts baseline and candidate modules.
Baseline retained in the isolated review copy as `src/clouds/cloudBlurLoop.ts`.
Results are `cloud-blur-batch.json` and `cloud-blur-repeat.json`. The 112 focused
cloud, geometry and storm-mass tests pass. Full scene appearance is checked
separately from the numeric packed-target comparison.


## Fourteenth pass: shoreline support incorrectly rejuvenated all analytic wakes

The moving vessel view exposed a source-age composition error. The analytic
backend has no measured wake age (`null`). When a shore texture was wired, the
material used `mix(wakeFresh ?? 1, shoreFresh, shoreShare)`. Even when shore
coverage was zero, that produced freshness 1 for the whole analytic wake. It
therefore used the bright whitecap colour/alpha law and fresh body texture.
Enabling a feature at build time must not change unrelated water everywhere.

`foamSourceAgesNode` now composes three explicit material controls: body pattern,
edge retirement and lighting freshness. With no measured wake age and no other
source, these retain the analytic laws (coverage-driven body, resolved torn edge,
wake-coloured lighting). Real contact coverage moves them toward fresh; real
shore coverage moves them toward measured shore age. Measured sim wake age still
drives all three. `foamDetailMask` accepts a separate optional body-pattern age,
so choosing a body does not replace its established mean or force edge aging.
This is not fabricated particle age or a fallback simulation path.

Three scalar graph regressions cover empty shoreline support, full fresh
contact, aged shore and partial shore coverage. All 66 focused water, wake W5b
and backend tests pass, including shader compilation and binding-count checks.
No new texture reads, samplers or passes. The extra source-weight arithmetic
has not been isolated for a frame-time claim.

The matched full-scene captures `wake-source-before.png` / `wake-source-after.png`
use simulation time 29.816666666666254, ship [5.727441696721075,
-1.8360965783892775, 292.6550095906843]. Camera follows at ship + [28, 22-y, -42]
and targets ship + [0, -y, -25] (absolute camera height 22, target height 0).
The isolated scene runs the analytic wake. The source-age correction changes
material without removing the broad patch. `wake-no-opacity.png` disables wake
optical depth in the same frame and removes that patch, proving its ownership.

The near 512²/120 m stored texture peaks at 0.7342383, mean 0.0250763: 46,893
texels exceed 0.01, 12,089 exceed 0.2, 532 exceed 0.5, none exceed 0.9. Thus
saturated injection is not the explanation for this frame. Continue with body
contrast and breakup under motion; do not claim the large-patch look is solved.
Hull health was not measured in this late frame; repeat the waterline
assessment with explicit hull-state recording before tuning injection. Review camera setup initially used
vector fields on array positions; those invalid captures were discarded.


## Fifteenth pass: connected storm growth without parent-switch jumps

The fixed storm image still showed detached small lobes above the principal
mass despite the earlier lobe-size correction. Existing storm lobes now grow in
a stable height order: each centre stays within an overlapping ellipsoid-scaled
reach of the preceding lower lobe. Full storms use 35% overlap so displaced
geometry and the composite density threshold have room to feather the join.
Partial storms interpolate the displacement; fair weather returns unchanged.
No RNG calls, instances, radii, texture reads or GPU passes were added. Lobe
shading attributes retain their authored identities; only layout centres move.
This deliberately makes storm silhouettes more compact.

An initial nearest-lower-parent version was rejected: a small weather change
could switch parents and move a lobe by 0.330 cluster radii. Height order stays
stable under the common monotone height-bias transform, so the retained chain
has no such parent switches. The 80%-reach intermediate measured a maximum
0.0204-radius step over eight seeds at 1% weather increments; the final tighter
65%-reach version passes a 0.05 bound over seeds 1/7/11/1337 and 100 weather steps.
Tests also verify that every full-storm cluster forms one connected mass across
20 seeds, while fair placement, radii and seeds remain unchanged. This is a
layout support test, not a volumetric guarantee at every camera direction.

The final fixed-camera image is `cloud-chain-final.png`; compare the prior
layout in `cloud-blur-after.png`. Detached tops now attach to the principal
cloud; the style remains a lobe-based approximation, not volumetric ray marching.
Generation median in a 200-iteration browser comparison was 0.150 ms before and
0.225 ms after (179 retained samples per variant). This is rebuild-time CPU cost,
not per-frame GPU cost; the rejected quadratic search cost about 0.540 ms.

The blur-only fixed-camera pair changes 81 of 840,960 displayed pixels by at
most one 8-bit level; mean RGB difference is 0.0000325/255. The shader target
comparison remains the stronger numeric check because tone mapping can hide
small packed differences. Latest cloud suite: 114 passing tests. Latest wake/
water suite: 66 passing tests. Full workspace typecheck/build and `git diff
--check` pass. No staging or commits.

### Remaining appearance work, ordered by evidence

1. The broad analytic wake patch remains visible after correcting source age.
   The zero-opacity control and measured stored coverage identify ownership;
   next evaluate body contrast and outline under a recorded healthy hull route.
   Do not remove it by retuning reflection or by calling all high coverage fresh.
2. Assess shoreline foam from water level and on a fixed approach route; current
   contact and history tests prove wiring, not all coastal visual cases.
3. Measure whole-game frame time with real frame intervals and repeatable motion.
   Fixed-dt HUD values and summed overlapping GPU timings are not valid FPS proof.
4. Underwater ambience remains deferred, as requested, behind above-water work.


## Sixteenth pass: distinguish GPU ocean from CPU buoyancy cost

The visual ocean remains GPU FFT. Physics also evolves a reduced CPU mirror so
synchronous hull queries do not wait for GPU readback. The earlier 98-to-196 m
middle-domain change raised its CPU mirror from 64² to 128² to retain sample
spacing and the represented band. That increased middle-grid cell count fourfold
and FFT cost further; it was a real CPU cost tradeoff, not a GPU-to-CPU migration.
The long mirror remains 64², and the finest visual band is not mirrored.

A real moving-frame probe uses wall-clock timing with fixed dt disabled, 60
warmup frames and 180 retained frames. Initial observed mean frame interval was
41.85 ms, render CPU 11.05 ms, and simulation tick CPU 8.36 ms. A second run that
instrumented the mirror separately measured 46.05 ms mean intervals, 13.29 ms
render CPU, 8.15 ms per tick and 6.98 ms per mirror update. There were 498 ticks
in 180 measured frames: the fixed 60 Hz sim catches up several ticks per slow
render frame. Thus the mirror, not just rendering, is a substantial CPU cost.
These runs differ in scene time/system load and are not a performance A/B.
The callback probe is `moving-frame-probe.js`; it restores all wrapped callbacks.

`cpuButterflyIFFT` now marks table indices as integers in its typed-array hot
loop. An isolated browser benchmark improved line transforms about 12% with
bit-identical output. More importantly, live cascades now retain a `createCpuIFFT2D`
plan: integer index arrays, copied float twiddles and four reusable line buffers.
It reads/writes rows and columns by stride, without per-line subarray views,
input/output objects or per-transform scratch allocation. Butterfly source
values are loaded before either output write, avoiding alias-sensitive reloads.
Operation order and float32 stage boundaries remain unchanged. The standalone
`cpuIFFT2D` convenience helper builds a plan for its call; production cascades
build once and reuse it for both packed transforms across ticks.

Actual production-plan comparison: 64² transform median 0.510 to 0.420 ms;
128² 2.295 to 1.900 ms, 40 retained alternating samples. A stronger full-mirror
comparison over 48 ticks checks every height, pressure-head, X-displacement and
Z-displacement value in both bands: all 3,932,160 float32 values are bit-identical.
Median full update falls from 6.690 to 5.745 ms, about 14.1%, on the same paired
run. This preserves resolution, spectrum, phase and physics sampling. The
baseline in that comparison already includes the integer-index improvement;
do not add the percentages as if they were independent whole-frame gains.

Reusable probes: `fft-indexing-probe.js`, `fft-plan-probe.js` and
`cpu-mirror-probe.js`. The latter two accept the retained pre-plan module from
`/private/tmp/water-selective/src/sea-physics/cpuOceanBeforePlan.ts`. No asynchronous
readback, worker migration, lower update rate or alternative rendering path was
introduced. A larger architectural saving would need its own measured latency
and buoyancy-error contract. The 128² tradeoff remains visible in the budget.

Validation: 21 water-improvement tests pass, including bitwise repeated-plan
checks at 8², 64² and 128². Four focused sea-physics tests pass (2D transform,
coarse/full mirror agreement, finer mirror, and block extraction). The broader
sea-physics run was interrupted amid heavy concurrent test contention; it is
not claimed as a completed gate. A workspace build encountered the unrelated
unused `trY` declaration in `hullWater.ts`; that concurrent file was not edited.
The isolated review snapshot passes its production build with the FFT changes.

## Seventeenth pass: exact shared-frequency phases

The reduced grids contain 20,480 modes but only 2,078 distinct float32 angular
frequencies: 457 in the 64² long band and 1,621 in the 128² middle band. The old
evolution loop evaluated sine and cosine separately for every mode on every
update. Radial modes with identical frequencies performed identical work.

Each `MirrorCascade` now groups exact float32 frequencies at construction.
Every update evaluates each group's phase directly from the absolute time, then
uses a per-mode index to pack the spectra. The phase results stay float64 until
the existing float32 spectral writes. There is no recurrence, frequency rounding
beyond the existing float32 representation, lower mirror resolution, tick
skipping, or asynchronous sampling. Resizing or adopting a spectrum rebuilds the
groups through the existing cascade construction path.

The paired browser comparison checks all four output grids across both bands
over 48 updates: 3,932,160 float32 values match bit-for-bit. Final retained
40-sample median is 5.875 ms before versus 5.185 ms after (11.7% lower). Two
earlier repeats measured 5.845/5.085 and 5.740/5.065 ms. Comparing both the FFT
plan and phase cache against the retained pre-plan baseline gives 6.805/5.185 ms
(23.8% lower). That baseline already includes the integer-index improvement.

The tradeoff is 41,560 additional persistent bytes across both mirrors and a
measured rebuild median of 4.715 ms versus 2.885 ms. Rebuild cost is repaid after
about three updates in this fixture. The temporary constructor maps and arrays
are not retained. There is no global cache or cache invalidation path.

Evidence: `water-review/cpu-phase-probe.js`, `cpu-phase-perf.json`, and
`cpu-combined-perf.json`. The phase probe accepts the retained pre-phase module
`/private/tmp/water-selective/src/sea-physics/cpuOceanBeforePhase.ts`; the combined
probe uses the pre-plan module described above. Benchmarking isolates mirror
updates and does not establish a whole-scene frame-rate improvement.

Validation: 24 focused tests pass. New phase regression tests compare full grids
against independently calculated per-mode frequencies across two seeds, long
time jumps, backward time, and a live mirror resize. Existing FFT bitwise tests
also pass. No commit was made.

Four focused sea-physics checks also pass after the phase change, including
coarse/full mirror agreement and preservation of represented energy. The full
workspace build still reports the unrelated unused `trY` in `hullWater.ts`.
The isolated snapshot passes typecheck and production bundling with the phase
change and the corrected regression test. `git diff --check` also passes.

### Next architectural comparison: where the mirror runs

The pirate entry updates one CPU mirror before buoyancy in `main.ts`. The shared
sea entry does the same in `core/seaFrame.ts`. The speedboat worker path already
has a `CpuOcean` per `BoatSimCore`, shared by that core's boat slots; it is not
one mirror per NPC. The page's player mirror and worker mirrors are separate.
Worker sharding can therefore multiply mirror work even while relieving the
main thread. Measure active core count and each core's update time before
increasing worker count or claiming a total CPU reduction.

A GPU replacement must supply more than surface height: the CPU mirror exposes
height, horizontal displacement for inverse sampling, and depth-attenuated
pressure head used by the hull. Reading the drawn displacement texture alone
does not replace that contract. A concrete prototype should measure:

1. GPU production time and CPU-visible age of all required fields at each fixed
   physics tick, including catch-up frames and spectrum swaps.
2. Transfer volume, queue latency, missed sample deadlines, and main-thread
   stalls under the actual above-water render workload.
3. Hull acceleration, pitch, heave, and waterline error against the synchronous
   reference across existing seeded tests and moving-vessel captures.
4. Total CPU and GPU cost, not only the time removed from the main thread.

Do not silently reuse stale GPU samples, reduce tick frequency, or duplicate a
second approximate ocean when a readback is late. The current exact CPU path
remains the reference until an explicit sampling contract passes those checks.

## Eighteenth pass: make the live performance display trustworthy

`GameLoop` previously supplied only its visual/simulation delta to render
callbacks. All three sea pages fed that delta into the FPS HUD. Consequently,
`setFixedDt(1/60)` reported 60 FPS regardless of actual render throughput,
`setFixedDt(0)` reported a zero-duration frame, and a one-second stall was
reported as 250 ms because of the simulation catch-up clamp.

The render callback now receives a third argument, `wallFrameDt`: the raw rAF
timestamp difference in seconds. Pirate, raft, and speedboat HUDs use that
argument. The original `frameDt` continues to drive all visual animation and
simulation scheduling, with the same fixed-time override and catch-up clamp.
The paused path forwards both clocks too. The reusable moving-frame probe
forwards all callback arguments so instrumentation cannot drop the new clock.

The pirate entry also sums `CpuOcean.update` CPU duration across all fixed
ticks before each render, then displays and clears it as
`buoyancy mirror cpu/frame`. This includes mirror rebuild work and all catch-up
updates; it excludes the separate spectrum scheduler, hull force evaluation,
worker mirrors, and GPU dispatch. It adds two CPU clock reads per mirror call
and no allocations in the timing path. The row intentionally reports the
current frame's accumulated CPU work, not a per-tick average or GPU duration.

Validation: 14 loop/HUD tests pass. The new cases prove separate clocks during
fixed-rate capture, freeze, pause, return to real time, and a one-second stall.
Simulation tick counts, catch-up cap, and paused interpolation remain covered.
The isolated review snapshot passes typecheck and production bundling. The full
workspace build still stops at the unrelated unused `trY` in `hullWater.ts`.
`git diff --check` passes. Nothing was staged or committed.

An earlier local experiment shared input loads between paired FFT butterflies
while retaining both original twiddles. Outputs matched, but it did not improve
timing (64² approximately unchanged, 128² slower in the measured run). It was
discarded; no paired-butterfly kernel was added to production. Absolute Node
timings under concurrent machine load are not a new browser performance claim.

### Wake follow-up: recorded hull condition

The isolated pirate scene ran a moving route from simulation time 51.0 to
162.767 s, with initial speed 18 knots and fixed scene dt 1/60. Enemy interference
was removed by moving and anchoring the enemy away from the route. The recorded
player state has flood 0 and empty damage at both endpoints. The camera tracks
the hull with world offsets `(28,22,-42)` and target `(0,0,-25)`; this was an
observed sailing route, not a prescribed straight-line trajectory.

`water-review/wake-healthy-route.json` records the endpoint states;
`wake-healthy-route.png` records the frozen endpoint. The broad pale wake is
still visible. This resolves the missing hull-condition evidence from the
earlier capture; it does not establish that its opacity or shape is fixed.

The analytic backend does store foam and slick in RG, but their source rates
are not the fixed-ratio pair used by the sim backend's age reconstruction.
Applying that age formula to analytic RG would invent an age signal. The
remaining work must distinguish excessive source coverage from insufficient
body/edge contrast with matched controls, rather than treating every analytic
wake texel as fresh or borrowing the sim-only ratio.

## Nineteenth pass: preserve the winning track projection and shed phase

The actual GPU probe exposed a mutable-expression ordering bug: `better` read
`best.x`, but `best.assign` changed it before the same predicate selected the
winning lateral sign and forward direction. Capturing the predicate with
`toVar()` before the assignment makes all three fields follow the same segment.
Without it, the GPU fixture treated both vortex sides alike; this was not a
zero-coverage fixture problem.

The foam vortex phase also used distance behind the live transom. That distance
grows as the ship travels, moving the pulse through already-shed water. It now
subtracts the existing wrapped cutwater odometer. CPU envelope/rate helpers
accept the same odometer; zero retains a static fixture's phase origin. Source
amplitudes, decay, spacing, and the water's Kelvin wave phases are unchanged.
No new GPU texture, uniform, pass, or track traversal was added.

Actual GPU source comparison at fixed water while the hull advances 15 m:
old port/starboard contrast spans -1 to +1; corrected contrast stays at 0.5,
with a total range of 2.68e-7. The comparison baseline includes the projection
fix to isolate phase behavior. The probe also checks the independent 0.5
contrast oracle, so losing side selection cannot silently pass as stable phase.
Evidence: `water-review/wake-vortex-phase-probe.js` and `wake-vortex-phase.json`.
The retained baseline is `wakeInjectionBeforePhase.ts` in the isolated snapshot.

Validation: 102 flow-foam/backend tests pass, including the new fixed-world
phase and odometer-wrap regression. Isolated typecheck and production build
pass. Workspace build still reports unrelated unused `trY` in `hullWater.ts`.
The broad pale wake body remains a separate appearance issue; these corrections
fix its directional source behavior, not a claimed final opacity treatment.

## Twentieth pass — causal contact fronts and narrower, porous wake foam

The September 14 playtest screenshots show a long, wide V appearing between an
airborne frame and the next impact. The vessel-mode chine source was stateless:
each render evaluated two complete rays using the latest contact flux. Their
length included 1.5 seconds of undamped lateral sliding and five exponential
landing lengths. Changing opacity alone could not fix this instant birth.

`wake/chineContact.ts` now tracks continuous contact at fixed ticks. Sources
start with zero reach; axial reach integrates horizontal speed over elapsed
simulation ticks. Airborne/zero-flux contact and player teleports reset it.
Rival histories use fleet identity before distance sorting; repeated worker
snapshots do not advance their fronts. The GPU filters inward from that front,
so it cannot deposit fresh foam beyond the travelled contact distance. Existing
foam remains in the accumulation textures and continues its normal advection
and decay. Source axes follow horizontal velocity, including sideslip.

The landed sheet now follows a curve whose lateral displacement approaches a
finite limit, rather than an indefinitely widening straight ray:
`offset(s) = halfWidth + launchSlope * L * (1 - exp(-s/L))`.
The same exponential supplies the source density. The mixing-time calibration
is 0.45 seconds, previously 1.5; coverage thickness is 10 mm, previously 5 mm.
These are appearance calibrations, not claimed measurements of real foam.
Airborne spray launch and hull forces are unchanged. The old test forcing
landed foam to match a straight Kelvin-wave envelope has been replaced by
bounded-width tests: at 25/30/40 m/s its half-coverage edge stays within 6 m of
the track 50 m astern, with less than 3 m additional spread from 10 to 50 m.

Fresh propeller foam has a 12 m exponential source fade in vessel mode. This
reduces renewal of white bubbles far astern without changing the momentum jet
or deleting deposited foam. At 30 m, the source is 8.2% of the previous rate;
its transverse Gaussian and source value at the propeller are unchanged.

The material also flattened dense foam toward uniform white. Simulated wakes
now keep the porous body instead; whitecap and analytic-wake material paths
keep their existing treatment. The same frozen frame was inspected with the
old and porous body (`water-review/chine-body-before.png` and
`chine-body-porous-preview.png`). The preview temporarily disabled the shared
flatten uniform; production applies that choice only to the simulated wake
material. It is a look comparison, not a frame-time benchmark.

Shared optical absorption changed from RGB (0.36, 0.08, 0.03) to
(0.36, 0.06, 0.02), keeping red absorption while transmitting more green/blue.
Surface refraction and submerged lighting still use the same optical path.

Verification:

- The live GPU source probe (`water-review/chine-front-probe.js`, recorded in
  `chine-front-gpu.json`) agrees with the CPU source within 2.8e-8. At 20 m/s,
  time zero injects nothing at 2/10/20 m. At 0.25 seconds only 2 m is active;
  10 m becomes active by 0.75 seconds, and 20 m by 1.25 seconds.
- Contact/re-entry, worker repetition/restart, sideslip and fleet-order tests
  pass. The real vessel-FX boundary is tested with reordered and missing rivals.
- 25 focused contact/prop/look/multivessel tests pass; 54 tests covering source
  shaders, sea-frame wiring and water lighting pass. After the material change,
  115 foam/contact/prop/sea-frame tests pass (these groups overlap).
- The analytic shader pin was deliberately updated for the accepted pass-19
  projector/phase and exact source-integration corrections; both blur hashes
  remain unchanged. The current vessel changes do not alter that baseline.
- Workspace typecheck and production build pass. An additional spray-fleet
  run still fails its existing zero-throttle aeration expectation: the engine
  fixture reports ventilation air at idle. This failure occurs before the
  modified foam source is called; it is not claimed fixed here.

Cost: one contact record per vessel, one additional vec4 uniform per source
slot (128 bytes for eight boats), no additional texture, compute pass or source
traversal. The source shares axial decay across its two arms and rejects cells
ahead of the contact front before evaluating them. No whole-frame speedup is
claimed from this pass.

Historical limit, resolved by the twenty-first pass below: this was a causal growth envelope, not a retained trajectory
for every emitted parcel. Already deposited foam stays in world space, but the
live source envelope still uses current position, flux and direction. Abrupt
turns or strong flux changes during uninterrupted contact need a bounded
history of emissions to preserve their full downstream evolution. Worker
snapshots cannot reconstruct contact transitions that were never collected.
The race view still warrants further tuning of prop-wash breakup and aging;
underwater atmosphere remains deferred. Nothing committed.

## Twenty-first pass — retained emissions through turns and impacts

The live-front shortcut from the previous pass is now removed. `chineContact`
retains numeric snapshots of emitted water: world position, motion direction,
volume, source width, launch speed and birth time. Subsequent hull position,
heading or contact intensity does not feed those older records. A takeoff
stops new emission but leaves existing sources spreading; a player teleport
starts a separate source without joining the old location to the new one.
Race-clock restart clears the old timeline. Rival identity still survives
camera-distance sorting, and repeated worker records age existing water without
emitting another dose.

Emissions coalesce over 50 ms only when their directions differ by less than
five degrees. Coalescing preserves volume and volume-weighted attributes. A
sharper turn starts another packet immediately, including a reversal within the
same interval. Each packet uses its recorded launch to move forward/outboard;
its displacement approaches a finite limit as lateral momentum decays. The
longitudinal footprints overlap to keep the 20 Hz packet cadence from appearing
as stripes. A regression limits that modulation to 6% at 40 m/s.

Fresh-source history lasts 1.5 seconds; deposited foam continues on the existing
advection and decay textures afterward. Deposition is proportional to
`exp(-age/tau) - exp(-lifetime/tau)`, normalized by its time integral. This
reaches zero at expiry instead of abruptly switching off, while depositing the
complete recorded water volume. The lifetime and mixing time remain visual
calibrations. This does not change hull forces or the separate airborne spray
particle model.

The GPU receives packed packet footprints and a bounding box per vessel. It
rejects a whole history outside that box, then scans only its active packets.
The capacity is 92 packets per vessel: enough for a separate emission every
60 Hz physics tick over the source lifetime, including boundary rounding.
Steady motion normally uses 31. Rapid contact/no-contact bursts therefore do
not overflow a buffer sized only for steady coalescing. Eight boats reserve
23.25 KiB of source uniforms. No extra texture or compute pass is introduced.

Final paired measurements on the same 512² source grid, eight vessels,
alternating before/after execution with the page render loop stopped:

| Source workload | Prior live envelope | Retained emissions | Added GPU time |
| --- | ---: | ---: | ---: |
| Turning, 31 packets per boat | 0.058 ms | 0.125 ms | 0.067 ms |
| Burst stress, 90 packets per boat | 0.057 ms | 0.259 ms | 0.202 ms |

These are isolated source-kernel timings, not total ocean time or frame FPS.
The retained CPU/GPU samples agree within 7e-8, including old-leg water after
a right-angle turn and empty water outside both trajectories. Earlier paired
runs varied with GPU load; all reported timings are the final run's medians.
The preserved comparison module lives in the isolated review snapshot as
`simFoamBeforeEmissions.ts`, not in production.

CPU microbenchmarks for eight vessels: retained history costs 0.0024 ms per
fixed tick; render-frame source packing costs 0.0243 ms, previously 0.0023 ms.
These exclude unrelated vessel physics and are not whole-frame measurements.
Evidence: `water-review/chine-history-probe.js`, `chine-history-gpu.json`,
`chine-history-cpu-probe.js`, and `chine-history-cpu.json`.

Validation: 40 focused tests pass across retained contact, burst capacity,
reversal/turn isolation, volume conservation, smooth source retirement,
packet-cadence filtering, fleet ordering, source shaders, sea-frame wiring and
speedboat look. The width tests now evaluate retained packets rather than the
old steady envelope. Typecheck and production build pass. The in-game turning
capture is `water-review/chine-history-turn.png`; it shows the retained model
before the final smooth-retirement and cadence-filter refinements. The final
shader was additionally booted and measured in the normal and burst GPU probes.

The old steady-tow envelope remains only as an explicit calibration input for
CPU callers without a timeline and in the archived pass-20 comparison. Live
vessels always use retained emissions; there is no envelope fallback. Worker
records still cannot recover an unobserved contact transition between collected
snapshots, but collected motion and source changes no longer rewrite old water.
No git commit, checkout or reset was performed.


## 22. Swell travel, cay elevation, turquoise aeration

The shared spectrum evolved positive-k swell toward negative k while
`swellDirection` was documented as travel. The shadow march already used the
positive authored direction. A temporal spatial-field regression measured
negative transport (−16.5 to −17.1 m/s) at three headings before the fix.
`swellSpectrum` now selects the negative-k half-plane; CPU and GPU use the same
spectrum without changing their phase evolution or wind-sea behavior. Removed
Tower Reach's compensating negative exposure vector. Measured-band shoaling
continues to derive direction from actual h0 energy. Existing shadow marching
needs no sign change. This changes seeded swell phases and the side receiving
swell exposure; it does not rotate the authored course or bars.

Cay beaches were not below still water in the sampled authored 0.3–1.5 m band,
but Tower Cay's mean elevation was compressed from 0.862 m to 0.482 m by the
generic beach pipeline. Its already-authored dune/beach/shelf field now uses
the existing exact-field hook. Finished mean is 0.926 m; Bar Head changes
1.184→1.556 m (authored mean 1.125 m; the existing peak floor still applies).
The regression protects beach elevation and dry-ground fraction. Course depth,
bar clearance, prop placement and byte-identical unrelated islands pass.
This removes excess geometric susceptibility to flooding; it does not suppress
legitimate swash or prove storm-time dryness.

Aerated wake color is now #70bbb5. Freshness is multiplied by a density gate
(smoothstep 0.35–0.9 on the existing porous wake mask) before mixing toward
white froth. Thin fresh bubbles retain turquoise and optical-depth transmission;
dense froth and whitecaps retain their white material. No added texture reads,
GPU passes, source particles or CPU frame loops. No frame-time improvement is
claimed: this is a small fragment arithmetic change and a terrain-build fix.

Validation: 219 targeted checks pass across swell travel/shadow, ocean spectrum,
shoaling asymmetry, circuit/kit, wake appearance contracts and resource budget.
Production build passes with existing chunk-size and COI-script warnings.
Live WebGPU game boots and renders with the changed material. The calm-water
43 kn capture `docs/water-review/turquoise-aeration.png` shows turquoise
translucent margins and white broken froth; measured flood is zero. Multi-weather
visual tuning remains a separate follow-up. No commits performed by this agent.


## 23. Coherent shore swash under storm waves

The storm-wave beach review exposed granular white speckling across the wet
sand. `buildShoreNodes` fed `phase * 97` (continuous spatial noise) into a hash
for each wave's amplitude. Adjacent pixels therefore got unrelated runup
heights. This was not foam texture detail: it changed the elevation of the
entire swash tongue and its drying history.

The amplitude now interpolates two hashes keyed only by discrete wave identity,
using the existing smooth phase field. Per-cycle variation remains; rush-up,
drainage, wet memory, amplitude limits and foam source strength remain unchanged.
No texture reads, noise-field evaluations, CPU work or render passes were added.
There are three additional scalar hashes and interpolation arithmetic in the
swash graph (two hashes instead of one for each of three remembered waves).

The paired 512² GPU probe evaluates actual old/new TSL sheet, wetness, foam and
height outputs over a 10.24 m patch at 2 cm spacing. At 42.6667 s and storm
swell input 4.801 m, the old height jumps by up to 0.483 m between neighbors;
new maximum is 0.0000446 m. Old field has 259,765 jumps exceeding 2 cm out of
261,632 comparisons; new field has zero. The reusable probe also throws if
new adjacent height jumps exceed 5 mm. Retained-patch median GPU time is
0.02575 ms before / 0.02946 ms after (+0.00371 ms); samples include scheduling
outliers, so this is a component probe, not a frame-rate claim. Artifacts: `shore-phase-probe.js` and
`shore-phase-gpu.json` in `docs/water-review/`.

Matched camera captures `shore-phase-before.png` / `shore-phase-after.png`
show the removal of beach glitter. Tower Cay remains exposed under this storm
wave state (measured ocean RMS 2.4005 m). Camera [150,110,-120], target
[5,0,-270], seed 1965, time 42.6667 s, 1280×800. These use direct scene rendering
without postprocessing, and inspect storm waves rather than validate the full
storm atmosphere or every point over a storm cycle.

Validation: 52 terrain/kit checks pass; production build passes. A coverage-
erosion experiment produced overly coarse shore foam and was removed after
visual inspection. Remaining work: coherent foam breakup/dissolve along the
shore, runup response to local shelter (it still takes global swell strength),
and matched day/night wake-color checks. No commits performed by this agent.


## 24. Surface foam follows available light

Noon / 18:30 / midnight review found that surface wake stayed nearly daylight
bright while the boat and sea darkened. The foam term used N·L and a constant
ambient floor, but neither the sky nor key intensity. The water body already
had the correct live radiance uniforms.

Whitecaps and aerated wake now multiply ambient by sky luminance, and directional
light by the live key's luminance. Their own color/tint remains intact; both
use the same computed terms, preserving foam's own shading normal. No extra
uniform, texture, pass, CPU work or source-state change. The new arithmetic
is two luminance/light terms shared across wake and whitecaps.

`docs/water-review/wake-night.png` and `wake-night-fixed.png` show the surface
wake losing its false glow. `wake-noon.png` / `wake-noon-fixed.png` confirm the
turquoise body remains visible by day. Each version uses a controlled open-water
run from [3000,0.5,3000], then freezes simulation for light changes; separate
runs are not pixel-matched wave/particle states. These are direct scene captures
without postprocessing. HUD sea/time text belongs to race selection and does
not reflect the review-only sky override.

The corrected night frame exposes the same defect in airborne spray:
`foam/roosterTail.ts`'s `litTint` uses a direction-only HG lobe plus a constant
ambient, while default `sprayPool.ts` color is an unlit tint. Fixing those
requires passing actual light intensity through the shared sprite path;
do not relight the surface wake to conceal it. This is the next specific
lighting task. Shore foam breakup/local-shelter response remain pending too.

Validation: 58 terrain, wake-look and shader-resource checks pass. The final
workspace build is blocked by concurrent unrelated test type errors:
`speedboatAssist.test.ts` omits required `GovernorSample.propImmersion`, and
`speedboatFreeRoam.test.ts` omits `ControlSource.dispose`. The isolated review
snapshot carries the final water files without those concurrent edits and passes
`npm run build` (source type-check plus production bundle). Live WebGPU
material compiles and renders at noon and midnight. No frame-time performance
claim for this lighting change. No commits performed by this agent.


## 25. Live lighting for airborne spray and prop bubbles

`sky/particleLighting.ts` publishes two linear radiance uniforms from the sky
rig after its actual DirectionalLight/HemisphereLight update. Key is color ×
intensity / pi; ambient averages the two hemisphere colors × intensity.
Values start black until the sky publishes a frame. There is no synthetic
sun, scene traversal, or hidden fallback for unbound lighting.

`sprayPool.ts` gives all default spray the live light. Custom color callbacks
receive the same terms. Rooster tails multiply their existing HG directional
lobe by key radiance and their ambient term by ambient radiance. Prop bubbles
retain their turquoise albedo but take the same illumination. Bow spray,
ambient crest spray and all fleet pools therefore darken without changing
emission rates, flight, transparency or particle budgets. Sky updates these
uniforms once per frame, including paused simulation; no per-particle CPU loop,
extra texture, extra pass or new scene query.

`spray-night-fixed.png` and `spray-noon-fixed.png` in `docs/water-review/`
show the same frozen particle state under midnight/noon lighting. Midnight
key RGB is [0.06458,0.09472,0.16053], ambient [0.01071,0.01868,0.03326].
Direct scene rendering, no postprocessing; HUD time is still race selection.
The previous pass's `wake-night-fixed.png` records the white airborne plume
before this correction (different particle state, not a pixel-difference pair).

Three regression tests cover complete extinction at zero light, independent
key/ambient scaling, and publication by the real sky rig without a particle
tick. Existing 47 spray and 98 sky/moon/fleet tests also pass. Production build
passes. Daytime plume is deliberately less opaque-looking because its fixed
0.6 brightness floor is gone; opacity and particle count themselves did not
change. No whole-frame speed claim.

## 26. Stranded foam has its own lifetime

The shore shader previously equated stranded foam with `wet - sheet`. That
made sand drying time control foam lifetime, and moved the foam boundary as
the wet-sand height contracted. Foam now remembers each of three wave deposits
at its original runup height, then attenuates coverage with a quarter-cycle
e-folding time after the wave peak. The returning sheet removes visible
residue under water. Wet sand retains its existing longer drying history.
This is an analytic approximation to deposited foam, not a new fluid simulation.

Actual old/new TSL graphs are exercised by `shore-decay-probe.js`: 256² samples
span one wave cycle and elevations 0–6 m. Changing sand drying from 1 to 30 s
changed old foam by up to 0.2183 coverage; new foam is bit-identical while wet
sand still changes by up to 1. In 17,266 stranded-foam samples away from the
moving edge, mean coverage changes 0.21784→0.02471, with nonzero peak 0.11166.
Assertions reject either dependence on sand drying or removing residue entirely.

With the selection preview closed and the game loop stopped, paired GPU medians
are 0.00896 ms old and 0.00875–0.00921 ms new. This component probe detects no
material cost increase; it is not a game-frame benchmark. An earlier contended
run with the preview active was discarded for timing. No new texture/noise
sample or pass; three scalar coverage/age calculations replace the wet-mask
subtraction. `shore-decay-gpu.json` stores raw timings and assertions' inputs.

`shore-decay-storm.png` uses the previous storm beach camera/time; wet sand
remains after foam fades instead of keeping a white inland stripe. The 43
terrain tests pass after this change, and the final production build passes.
No commits performed by this agent.

### Local runup energy: requirements (implemented in pass 27)

Runup amplitude still uses global sea RMS from `core/seaFrame.ts`. A sheltered
beach therefore gets the exposed beach's analytic runup, even though its drawn
waves use fetch and swell shadow. Do not multiply runup by the shelter value
sampled on dry land: land cells are blockers, and that would also extinguish
exposed swash. The next implementation needs a stable seaward shoreline sample
(or a baked shore exposure field) and the shared per-band fetch/swell gains.
Keep genuine storm overtopping. Acceptance: exposed/lee beaches under identical
waves differ in runup; rotating swell moves the sheltered side; dry-land samples
do not kill exposed swash; cost stays bounded without per-pixel CPU queries.


## 27. Offshore exposure drives local runup

`shoreSampling.ts` bakes a geometry-only mapping from beach cells to water
outside a two-cell land dilation. A four-neighbor breadth-first extension
chooses the nearest offshore seed in grid distance. Land dilation visits land
cells only, and the extension queues only the offshore rim rather than the
entire ocean. The map is retained and reused when weather changes. A domain
with no offshore water throws instead of inventing exposure.

The shelter texture is now RGBA16F. R/G retain the exact physical fetch and
swell-shadow values used by waves and buoyancy. B/A copy those same values from
the mapped offshore cell onto the beach. Each wind/swell rebuild updates its
own physical and offshore channels together. CPU `fetchAt`/`shadowAt` and
worker sampling retain the same arrays and meanings.

`Caustics.waterSurface` returns actual water height and local shore-energy
gain from ONE shelter texture sample. It combines existing per-band fetch
and swell gains with the spectrum's measured variances, then takes the local /
open RMS ratio. It does not apply zero-depth shoaling on dry sand: that would
extinguish exposed swash. Sand passes this gain into the existing analytic
runup amplitude, scaling current and remembered waves together. Stand-alone
sand without the active sea keeps its existing authored runup behavior.
No new texture sampler, render pass, CPU frame query or terrain rebuild.

Regression coverage: exposed dry sand gets offshore energy; lee sand gets less;
turning swell 180° swaps the sheltered beach; changing wind updates offshore
fetch without changing swell shadow; original R/G still match CPU sampling.
All mapped cells are checked clear of land, and a no-offshore domain is rejected.
116 shore/fetch/swell/terrain/resource-budget checks pass. Final production
build passes (5.41 s); `git diff --check` is clean.

Actual GPU gain vs CPU shared wave laws, synthetic island and dry beach points:
exposed 0.96277833 vs 0.96277830; lee 0.27829498 vs 0.27829494. Other sampled
coasts agree within 0.000058 (half-texture interpolation precision). The probe
throws above 0.0001 disagreement or if exposed gain is no greater than lee gain.
Artifacts: `shore-exposure-probe.js`, `shore-exposure-gpu.json`, and the real
Tower Cay storm capture `shore-exposure-storm.png` in `docs/water-review/`.
The capture uses the established camera/time and direct scene rendering.

Cost at 512²: +2 MiB persistent CPU (mapping plus added texture channels),
+1 MiB GPU texture. Bake median 27.23→34.30 ms (+7.07 ms), once per world;
initial unoptimized mapping added about 14 ms. Temporary bake storage includes
a 1 MiB queue and 0.25 MiB dilated mask. GPU 256² runup probe median
0.00971→0.01025 ms (+0.00054 ms), compared with global-amplitude swash.
Previous timing run had a +0.005 ms difference; raw samples are saved and no
whole-frame FPS improvement is claimed. Material binding count stays unchanged.

Limit: this remains coarse-grid offshore energy, not a fluid simulation of
surf uprush. Narrow channels/beaches below shelter-grid resolution cannot
carry independent exposure. Grid-distance ties can meet on inland dividing
lines; these are not wave fronts. Real storm overtopping is not suppressed.
No commits performed by this agent.

## 28. Swash edge grows with the tongue

The sand material's edge mask was solely a distance from the swash elevation.
At zero elevation it still produced full-strength foam, including when local
shore energy was zero. That created a stationary contour between tongues and
prevented sheltered runup from fully suppressing the analytic swash edge.

`shoreRunup.ts` now multiplies this edge by a smooth onset over the existing
foam elevation width. The tongue develops its edge as it climbs; the edge
recedes smoothly as the tongue drains. Once runup exceeds that width, the
original edge brightness is unchanged. The independent stranded-foam history
still survives between waves. No new tuning parameter, texture, pass, CPU
frame work, or fallback was added; the shader adds one scalar smoothstep and
multiply. No GPU frame-time improvement is claimed.

The isolated WebGPU regression renders 256² height/phase samples for zero,
weak and full shore-energy gain, comparing the previous and new shaders.
With foam noise disabled, zero-energy peak foam falls from 1 to 0. At the
cycle boundary, full-energy foam falls from 1 to 0.02964 (surviving residue),
and weak-energy foam from 1 to 0.01115. Full-energy peak foam remains 1.
Mature edges, stranded residue beyond the edge, sheet coverage, wet-sand
coverage and runup elevation agree exactly between versions in this probe.
The regression throws if those contracts fail. This is a shader diagnostic,
not a new gameplay visual comparison.

Artifacts: `docs/water-review/shore-edge-probe.js` and `shore-edge-gpu.json`.
Run the probe with a WebGPU renderer and a URL for the pre-change module;
keep a copy beside `shoreRunup.ts` so its relative imports resolve. Fifty
terrain, shore-exposure and material-resource tests pass. Production build
passes (3.61 s). No commits performed.

## 29. Filter foam lookup displacement

`foamWarpVec` fed unfiltered two-octave value noise into both the foam simulation
lookup and the foam art lookup. Texture mipmaps filter their input images;
they do not remove unresolved displacement in the coordinates addressing them.
Consequently distant pixels continued receiving different warp offsets as the
camera moved, even after the warp's lattice was smaller than a pixel.

Both warp components now use the existing `bandLimitedFbm2` rule with one
shared derivative footprint. Each octave retires toward its own mean, making
the signed displacement tend toward zero. Once the largest octave is fully
unresolved, a fragment branch skips all four value-noise evaluations. The
footprint is evaluated before the branch. No texture, sampler, pass or CPU
frame work was added. Filtering adds derivative/scalar work nearby; no measured
whole-frame performance improvement is claimed.

The fragment-stage WebGPU probe compares the original and filtered functions
on a 128² float target, at three pixel footprints and two camera offsets.
At 0.125 m/pixel, maximum component difference is 0.00000073 m. At 2 m/pixel,
mean warp change for a 0.25 m camera translation falls from 0.01246 to
0.00818 m (34%). At 16 m/pixel, peak warp falls from 0.674 m to exactly zero;
translation-induced warp change is also zero. This measures coordinate
stability, not final image shimmer or physical foam transport.

Artifacts: `docs/water-review/foam-warp-probe.js` and `foam-warp-gpu.json`.
The probe requires a WebGPU renderer and the pre-change module URL, with that
copy beside `foamShading.ts` to retain relative imports. It asserts resolved
agreement, unresolved retirement, and reduced motion in the transition.
119 foam, texture and material-resource tests pass. Final production build
passes (3.64 s), and `git diff --check` is clean. No commits performed.

## 30. Reuse whitecap lookup warp

Whitecap shading constructed the same world-coordinate warp twice: once for
simulation coverage sampling and again for the foam-art churn. `shadingNode`
now stores that warp in a TSL variable and supplies it to `foamDetailMask`.
Callers without a precomputed warp still construct their existing warp. This
is expression reuse, with no new source, transport law, or tuning parameter.
It removes one duplicate four-noise warp graph from the whitecap path. No CPU
frame work, textures or bindings were added. GPU frame-time savings have not
been measured, so this is not an FPS claim.

The GPU probe builds the real detail mask with variable coverage and compares
independent versus shared warp. At 0.125 m/pixel the largest mask difference
is 0.0000233 from floating-point evaluation; at 2 and 16 m/pixel it is exactly
zero. The explicit acceptance tolerance is 0.0001, and each sample must contain
a nonconstant foam mask. This is numerical equivalence within tolerance,
not bit-exact equivalence.

Artifacts: `docs/water-review/foam-warp-reuse-probe.js` and
`foam-warp-reuse-gpu.json`. The full ocean scene also rendered successfully
with the filtering from pass 29 and then booted again with warp reuse enabled
(first rendered frame at 8.13 s in the isolated browser). The coastal diagnostic is not a controlled
before/after comparison and is not used to claim a visible improvement.
119 foam, texture and material-resource tests pass; production build passes
(3.74 s). No commits performed.

## 31. Remove per-update chine-history array allocation

The machine is shared with other active projects and agents. The live race
benchmark was stopped and its isolated browser/server closed. No FPS or
wall-clock performance result from that run is accepted. Resume controlled
frame profiling when system load permits it; deterministic behavior and work
counts can be checked now without that timing assumption.

`ChineContactHistory.update` previously filtered the entire packet list into
a newly allocated array on every call, including empty/dry histories. Packet
timestamps are ordered: new emissions append and coalescing updates only the
newest packet toward a later timestamp. Expiry can therefore remove the old
prefix in place with `copyWithin` and length truncation. Updates with no expired
packet now check only the oldest packet. Remaining movement, volume and expiry
laws are unchanged, and the existing fixed capacity remains enforced.

This removes one packet-array allocation per update: 480 arrays per second
if eight vessels are updated at 60 Hz. Other allocations remain, including the
returned emitter object and newly emitted packets. This is not a zero-allocation
claim or a measured frame-time saving.

Regression coverage includes skipped worker ticks that expire the oldest packet
while retaining the younger packet unchanged, full expiry, and a fresh impact
after the list drains. The existing long-running capacity, turn, emission volume
and detached-splash tests remain in place. Eleven chine tests and 25 additional
wake-shape, simulation and prop-lifetime tests pass (36 total). TypeScript
checking passes; `git diff --check` is clean. These correctness checks ran with
one test worker; their elapsed durations are not performance measurements.
No commits performed.

## 32. Compact stars and local night lighting

The detailed record is `water-review/night-lighting-handoff.md`. Star filtering
uses a 1.2-pixel disc and four coverage samples instead of a two-pixel sampled
disc. Submerged hull lines reuse the existing material. Red courtesy fixtures
mount beneath the authored roll arch; one short-range hero spotlight is included
only in the boat-material light set. No new lights on terrain or ocean, no
shadow pass. Eight night-visible fixture draws are added for an eight-boat fleet.

The compact stars and cockpit light each compiled and rendered in small isolated
WebGPU scenes. Tests cover subpixel motion, actual GLB anchors, boat motion,
day/night behavior and resource cleanup. Eleven cockpit/night tests and the
preceding 87 sky/star checks pass. Final TypeScript checking passes after the
concurrent trailer edits settled. No loaded-machine FPS claim and no commits.
A matched gameplay-camera review remains necessary for final visual approval.

## 33. Correct night sky after post-processing

See `water-review/night-lighting-handoff.md`, final sky composite section.
The actual DOF pass was blurring the reduced star discs. Sky depth-clear pixels
now retain sharp color, while scene geometry keeps photographic defocus.
Wind wisps are retained at one-third hashed night density and faint radiance,
with stronger along-line gaps. No cloud removal. GPU DOF regression passes,
72 focused tests pass, and TypeScript checking passes. The sky-only diagnostic
is not a complete gameplay approval. No commits or frame-time claims.

## 34. Couple wake detail to ocean shape

Update: the subsequent W8 visual review removed the ambient-elevation carve
after it produced holes at wave crests. The measurements below record the
earlier experiment; they do not approve the current combined wake appearance.
See `water-review/wake-wave-coupling.md` for the superseding decision.

See `water-review/wake-wave-coupling.md`. Wake breakup now uses the existing
wave elevation, and fresh froth lighting follows the combined water normal
instead of the unrelated whitecap relief. No new bindings or simulation passes.
Actual GPU mask comparison changes shape while average coverage shifts only
0.024 percentage points. The 102 foam/readability tests, four binding-budget
tests and TypeScript pass. A frozen sunset comparison did not identify DOF as
the main cause of distant detail loss; camera and lens remain unchanged.
Moving planing/impact review remains open alongside W8's source/spray work.
