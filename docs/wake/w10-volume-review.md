# Wake volume review — 2026-09-16

User target: heavy, fast boats must visibly displace and throw water from low and close cameras, not merely draw a foam trail from above. Review every inadequate part, not only the weakest feature. Keep low-speed disturbance restrained and preserve gameplay performance. The supplied trailer frames predate the current W9 implementation; they are reference failures, not evidence that W9 never runs.

## Current evidence

An isolated source snapshot was captured at 1920×1080 with the existing R1 cinematic, hero 25 m/s and rival 30 m/s. Captures and harness: `/private/tmp/wake-volume-review-0916/`. These are temporary review artifacts, not checked-in assets. Baseline side and rear views show a visible transom boil, but heavy fragments resemble aligned slivers and the forward wetted region still has a weak contact silhouette. Do not mark the whole look accepted because the source tests pass.

Baseline GPU particle readback: 14,837 retained particle records, maximum height 0.81 m above the hero's sampled stern water level. That measurement includes both nearby boats and uses an age filter, not exact per-particle rendered opacity. It demonstrates airborne positions exist; it is not a proof of visible whitewater volume or displaced surface height. Source demand was approximately 31.8–33.0k clumps/s for the two boats, under the existing 40,960/s turnover cap.

## Changes in this pass

- **Surface attachment:** a chine sheet previously spawned every particle at the forward contact's water height, although its reconstructed contact already had a different stern height. Carry the start-to-end surface rise in the unused width-uniform component, interpolate birth height along the run, and store that same height for each particle's return plane. Reset rise when pooled slots change emitter kinds. No extra texture lookup, buffer or draw pass.
- **Heavy fragment silhouette:** size at death 0.65 → 0.5 m; velocity streak factor 2.5 → 1.2. Side/rear captures of this combination show broader, less needle-like fragments. Fine rooster droplets retain their own streak model. Density, launch velocity, lifetime and pool count are unchanged. An opacity-0.8 candidate was captured but not adopted.
- **Onset:** full sheet density previously switched on immediately above 6 m/s. All three planing source rates now ramp smoothly over 6–10 m/s, preserving the existing full-rate behaviour above 10 m/s and no planing emitters below 6. This is an explicit visual transition, not a changed hydrodynamic planing threshold. It does not solve the separate landing/contact-history problem.

The surface approximation is still a straight line between sampled contact heights. This patch does not claim to follow every lateral wave or to solve asymmetric roll/contact spray.

Validation: 30 tests pass across `wakeAtSpeedDisturbance`, `sprayFleet`, `sprayReturn` and `sprayLightingShader`; TypeScript and diff checks pass. Final isolated-browser captures include sunset side/rear views and a night-pack rear view, without shader exceptions. The night wash remains visible and takes local light colour. The 3/8 m/s *requested* cinematic variants still emitted small amounts of planing spray, so their actual speed was not established and they must not be used as low-speed acceptance evidence. CPU tests cover a real 3 m/s tow and the 6–10 m/s rate transition. Final screenshots are visual checks at different simulation times, not pixel-matched A/B measurements. Existing KTX2-loader, post-MSAA reload and TSL-deprecation warnings remain. Review browser and server were shut down; other agents' sessions were untouched.

## Completion checklist

| Part | Required evidence before calling it good enough | Status |
| --- | --- | --- |
| Displaced surface | Trough and closure crest readable at low angles with spray hidden; verify actual elevation, not only source load | Inverted signs fixed; GPU trough confirmed, low-angle crest still weak |
| Chine sheets | Attached to wet hull, outward launch, broken sheets rather than sticks or balls; both sides under roll | Longitudinal attachment fixed; asymmetric contact open |
| Engine wash | Local at prop sources, aft-directed thrust response, no instant wide disturbance ahead of drives | Recheck standing start and steering |
| Turbulence | Irregular stirred surface/normal structure follows jet direction before relaxing into ambient sea | Open visual check |
| Foam | Aerated water beneath broken foam; readable water relief, no opaque white carpet or regularly spaced bars | Open in close views |
| Timing | Acceleration and landing grow from the sources; old wake survives independently after throttle lift or turning | Speed onset fixed; landing/history open |
| View/lighting | Side, stern, low-front and chase at displacement, transition and race speeds; daylight, sunset and night; hero and rivals | Partial captures |
| Performance | Fixed pool/pass budgets; paired timing in uncontended session before FPS claims | No new passes/particles; no timing claim |

## Follow-up: inverted stern geometry

The sign-only W9 tests did not test the evolved surface. `WakeSolverCpu`/GPU evolve and draw ζ = η + h_P; a rapidly moving positive head locally raises that drawn surface. The explicit hollow used a positive head and the closure crest a negative head, applying physical-pressure intuition to the wrong output variable.

A 25 m/s, three-second moving-source reproduction (128², 0.5 m texels, 60 Hz; 12 m hollow, 1.84 m width, peak prescribed depth 0.3 m) showed +0.1261 m at 3 m astern and −0.0929 m at the 12 m closure. The corrected signs give −0.1261 m and +0.0929 m. These are isolated-source numerical results, not measured full-scene elevations.

`hollowSamples` now emits negative visible heads and `humpSamples` positive heads. Both use the existing signed solver channel for player and rivals; general hull load sources, boat physics and the solver equations are unchanged. The hollow no longer enters the hull-churn head: it is an explicit surface shape, not another hull impact. Existing prop/sheet/closure foam sources remain. Domain containment now includes the signed shapes' radius and footprint so extended stern sources cannot be clipped at a rival's simulation boundary. Source counts and GPU passes are unchanged.

`tests/transomSurface.test.ts` checks the actual evolved trough/crest, both boats' signed-channel routing, and whole-vessel boundary culling. The old sign convention produces the opposite surface and violates the new shape assertions. 72 tests pass across transom surface, at-speed disturbance, foam readability, vessel ordering, solver stability/static-cancellation, backend integration and eight-boat wakes. TypeScript and diff checks pass. Concurrent test-file restoration removed this pass's onset/slope/sign assertions; those were restored, and the 24 tests in the three directly affected suites plus typecheck were rerun successfully.

After the other agent released the GPU lock, an isolated R1 25 m/s run with rival script entries removed and airborne effects hidden produced `shots/surface-surface-side.png` and `shots/surface-surface-rear.png`. Readback from the exact elevation texture sampled by the ocean vertices showed −0.3804 m at 4 m astern and +0.0533 m at 14 m astern (the live hollow record closed at 12.075 m). This includes hull and prop sources, unlike the isolated CPU reproduction above. The trough has the correct sign in the rendered pipeline. The low-angle crest still reads weakly; this is not full visual acceptance. Foam was left visible. Shader execution reported no exceptions. Harness: `/private/tmp/wake-volume-review-0916/surface.mjs`. Review Chrome and server were closed and the GPU lock released.

No upright steering assist or boat-force change belongs in this visual pass. Preserve other agents' work. No commits.

## Low-angle filter diagnostic and coordination

The current speedboat session claims reflection and ocean fragment-shader performance (T216), explicitly excluding wake/foam/flowfoam. Codex leaves those shading/reflection paths untouched. File claims, requests and results are recorded in `docs/water-review/AGENT-COORD.md`; an ambiguous older external flowfoam claim has been queried rather than assumed free. No production source changed during this diagnostic.

Hypothesis tested: the near wake's slope band filter hides the resolved closure crest at low viewing angles. In an isolated snapshot only, a uniform bypassed **just** the wave-slope filter; geometry, foam coverage and other shading stayed unchanged. The initial tick-only freeze still drifted and was rejected. Rendering directly to the canvas then caused a depth-MSAA mismatch and was also rejected. The valid run stopped the game loop and manually rendered through the existing post pipeline with node-frame advancement.

Final A/B/A captures (`shots/fixedband-{side,rear}-{a,b,a2}.png`) have exactly zero A→A2 difference over the sampled lower-water image region (rows 550–1079, every second pixel). Mean absolute display-RGB change with the filter bypassed is 0.000262 for the side view and 0.00000262 for the rear view, on a 0–255 scale. Both images remain visually unchanged around the weak crest. This rules out this filter as the cause in these two R1 views, not at every possible distance. Do not disable it or increase its thresholds on this evidence.

Harness: `/private/tmp/wake-volume-review-0916/band.mjs`, pixel comparison: `compare.py`. The valid run had no GPU validation exceptions; existing loader/MSAA-settings/deprecation warnings remained. Browser/server closed, shared GPU lock released. Next investigate the crest's spatial shape and its foam coverage without overlapping T216's performance edits.

## Closure footprint calibration

The closure sources used their entire longitudinal cell spacing as Gaussian sigma. For long, narrow hollows this spread their integrated head sideways and diluted the crest. The source now uses `max(width / 2, cellSpacing / 2)`; the three source positions, integrated head, dry-transom gate, source count and solver are unchanged. Adjacent Gaussians still overlap; short hollows whose width dominates are unchanged. This is a visual footprint calibration, not a new hydrodynamic model or an amplitude multiplier.

A controlled CPU comparison at 25 m/s, 120 steps, 128² cells at 0.5 m, with identical hollow depths and source volumes:

| Hollow length | Previous closure height | Narrower closure height |
| --- | --- | --- |
| 6 m | 0.0977 m | 0.0977 m |
| 12 m | 0.0963 m | 0.1563 m |
| 18 m | 0.0826 m | 0.1297 m |

The evolving-surface regression now covers 12 and 18 m hollows, requiring a closure above 0.12 m, bounded below 0.3 m, with much lower disturbance two hollow widths sideways. Both previous footprints fail the height requirement. Existing source-load tests still check unchanged nominal volume, and low-speed tests retain the dry-transom suppression. All 25 checks across transomSurface, wakeAtSpeedDisturbance and wakeFoamReadability pass.

An isolated 1080p R1 run with airborne effects hidden produced `shots/crestwidth-surface-{side,rear}.png`. GPU elevation readback gives a −0.3628 m trough and +0.0730 m closure near 14 m astern. This run's live hollow is 13.8 m, unlike the earlier 12.075 m record; do not treat the two browser captures as a controlled gain measurement. The crest remains subtle in the side view and foam still flattens the visual read. No shader exceptions appeared. The owned browser and server were stopped and the shared GPU lock released. No additional passes, samples or particles were added; no FPS improvement claimed.

Coordination: released this session's flowfoam/foam claims for T216's coverage/light performance gates. The other session subsequently claimed per-instance hull wetlines in caustics and speedboat scene/frame files. This patch touches neither scope. Source and evidence remain uncommitted per user instruction.

Diff whitespace checks pass. Shared-tree TypeScript check currently reports TS6133 for unused `objectGroup` at `src/caustics/waterLighting.ts:30`, in the other session’s active T177 changes. Reported through the coordination log; that file was left untouched.

## New user evidence: moving dark patch and island-floor seam

User screenshots dated 2026-09-16 02:57:22, 02:57:31 and 12:20:30 show two unresolved artifacts:

- A broad dark region around the player boat, with a hard curved/polygonal perimeter. The user reports that it follows the boat and changes shape. It is visible in the 02:57:31 chase view; do not confuse it with the narrow physical boat shadow or assume wake foam is responsible.
- A dark, angular discontinuity on/through the water in front of the small island, visible at 12:20:30 near the terrain/seabed transition. It may have a different cause.

Source images: `/Users/flo/Desktop/Screenshot 2026-09-16 at 02.57.22.png`, `...02.57.31.png`, `...12.20.30.png`. Cause not established. Candidates to isolate: water-surface shadow sampling and its boat-following frustum, planar reflection coverage, refraction/depth validity, and island apron/depth-field agreement. Acceptance requires removal of artificial boundaries while keeping legitimate hull/terrain shadows and reflections; inspect while moving the boat and camera, not only a still frame.

Read-only triage: 78 existing island/terrain-LOD tests pass, including apron extent, vertex/depth-field agreement and monotonic shelf descent. This lowers suspicion of the previously fixed missing-apron defect; it does not validate rendered normals, overlapping islands, refraction or shadow boundaries. The water shadow path delegates frustum rejection to Three's shadow filter. The refraction path has binary depth/on-screen validity gates; either needs a frozen-frame isolation before being named as the cause.

GPU validation deferred while the shared lock is owned by `b122-agent` for its rectangle investigation. Its existing open-water capture contains a sky rectangle, which is not sufficient evidence of the same defect as these new screenshots. Added the new symptoms and requested isolation in the shared coordination log; no production shader changed speculatively and no second browser launched.

Next controlled capture: reproduce the chase patch, stop simulation and render the same post pipeline for A/B/A. Test water `shadowStrength=0`, scene shadow intensity zero, planar reflection strength zero, and `refractionSnell=0` separately, restoring each before the next. Then inspect raw scene colour/depth and terrain with water hidden if the island seam persists. Require an identical A/A2 control and distinguish removal of the offending boundary from simply darkening or hiding all water detail.

## CPU-only follow-up: rival impact onset

The fixed-step effects coordinator applied `wakeLoadRamp` only to the player hull's pressure samples. Rivals passed their raw worker loads straight to the solver. A frozen-input regression reproduced a 60,000 N first-tick rival load versus 11,283.82 N from the existing player ramp at 60 Hz.

Rival hull loads now use the same 80 ms exponential rise, with state indexed by stable fleet slot rather than nearest-first order. Falling loads remain immediate. Inactive/removed slots and a worker tick rewind discard their ramp state. Samples are copied into reused coordinator-owned objects before scaling; worker records are never mutated. Prop loads, appendage loads and explicit transom shapes keep their existing paths. This fixes pressure-onset parity; it does not yet solve downstream closure arrival or all spray timing. No GPU passes or particle budgets change. Player teleport reset was considered but not changed in this patch.

`tests/vesselLoadOnset.test.ts` exercises first contact, steady contact, sorting swaps, airborne release, re-entry, inactive-slot reuse and worker restart, using hidden effects and no GPU solver. The original coordinator fails its first-contact assertion. The test also freezes an input pressure record to guard worker ownership.

The B122 agent reports the island-like angular edge was traced to a cloud composite quad at 500 m view depth, also present in the reflection stand-in. Their fix belongs to that session; recheck the user's island screenshot after it lands. Their cloud-shadow hypothesis for the curved boat-area patch remains unconfirmed. No concurrent cloud/caustics files were edited here.

- Codex rival-onset validation complete: all 27 focused tests pass; extended worker-restart test rerun passes; shared-tree TypeScript and diff checks pass. No GPU session launched.

## Player reset and remaining closure timing

A follow-up regression demonstrated that `VesselFx.resetContact()` reset chine contact history but kept `heroLoad.load`. After a settled 60 kN load, the next contact received 59,923.64 N rather than the fresh-ramp 11,283.82 N. Reset now clears the player's load accumulator as well. It deliberately keeps detached chine emissions and the solver's existing wake. `vesselLoadOnset` now covers this path through the real CPU-side WakeSim source buffer, with particle effects hidden.

The separate downstream arrival defect is confirmed structurally: `writeBoatFx` samples the current steady-state `transomWakeDepthAt` profile; `vesselFx` immediately emits its full hollow and hump, and `planingSprayEmitters` places closure spray over 0.8–1.2 times the full hollow length. No contact-travel state connects these two consumers. At a 12 m hollow and 25 m/s, even a simple boat-relative flow estimate gives roughly 0.48 s of development, rather than full closure emission on the first tick.

Implementation requirements for that next change:
- One history keyed by stable vessel identity, shared by explicit signed geometry and closure spray; never keyed by nearest-render order.
- Accumulate contact travel from velocity projected along the hull, resetting on dry contact, teleport and worker restart. Do not use absolute reverse velocity as forward development.
- Keep the target steady-state closure location; do not shrink the hollow length and accidentally draw a false crest at the advancing front.
- Ramp existing source cells as flow reaches them, and start closure spray only at the real closure. Preserve prior detached foam and evolved wave state after takeoff or a turn.
- Verify a first-tick landing has no distant closure source, steady contact converges to the unchanged profile, variable update intervals agree, and rivals keep separate histories through sorting and worker gaps.
- Recheck low side/rear visuals after CPU proof; avoid claiming a temporal source model solves full 3D water breakup.

This timing work remains open. The reset fix does not disguise or claim to complete it.

Player-reset validation: 13 focused tests pass across vesselLoadOnset, chineContact, chineVesselOrder and wakeFoamReadability; shared-tree TypeScript and diff checks pass. No GPU used and no commits.

## Selective commit handoff

The user subsequently authorized committing this session's work. The wake patch is being committed separately from the remaining steering/physics edits. An isolated source copy with `hullMesh.ts`, `hullWater.ts` and AI capability restored from committed HEAD (without altering the shared tree) passes 45 tests across transomSurface, vesselLoadOnset, wakeAtSpeedDisturbance, wakeFoamReadability, chineVesselOrder, sprayFleet, sprayReturn and sprayLightingShader. This proves the wake commit does not require the uncommitted steering implementation. Prior no-commit notes above describe the authorization at those earlier stages.

The work is a verified increment, not final visual acceptance. Shared closure travel history, the curved dark patch and further low-angle wake refinement remain open.
