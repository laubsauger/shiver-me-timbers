# Gameplay water performance — 2026-09-15

Scope: gameplay frame budget, preserving the new stern spray and wake appearance.
No commits. Other agents' UI/AI edits remain separate.

## Changes

- `foam/roosterTail.ts`: evaluate smooth sun/sky/LED scattering in vertices for
  mist and drops, matching hull spray. Particle count, motion, opacity masks,
  lifetime, displacement and render resolution are unchanged.
- Wrap `dropRadianceNode` in `Fn`: generated shaders previously contained the
  zero-initialised LED accumulator without its loop. Moving such a result to a
  varying must include its statement flow. The corrected drop, mist and hull
  vertex shaders each contain the LED loop; fragment shaders contain no HG lobe.
- The previously ineffective LED gain of 3 produced a neon plume once the loop
  actually ran. Calibrated to 0.18 for subtle nearby strip spill. Verified in a
  frozen night side view, with a green boat and seven zero-colour slots.
- Skip exactly zero-colour light slots in spray and ocean lighting. These are
  uniform branches, not distance culling or a replacement lighting model.

## Measurement caveat: GPU pass sums are invalid here

On this Chrome/WebGPU/Metal run, many timestamp intervals overlap. For example,
small bloom targets and SMAA stages reported starts around 10.9–11.0 ms and ends
around 22.2–22.9 ms, inside the scene's 8.65–22.15 ms interval. Three r180 sums
these intervals, producing apparent 250–380 ms frames. **Do not treat
`renderer.info.render.timestamp` as elapsed GPU frame time on this run.**

Used queue completion (`device.queue.onSubmittedWorkDone`) around each submitted
frame for the subsequent comparisons. This is serial CPU+GPU latency, including
browser scheduling, not isolated GPU work or a steady-state FPS prediction.
Ordinary gameplay pacing must be measured separately through the normal loop.

## Controlled one-boat checks

Isolated Vite copy, separate Chrome profile, 1280×713 drawing buffer, DPR 1.
Constrained wet hull at 20 m/s for repeatable emission, then frozen particles.
Original/changed/original comparisons used the same buffers and camera.

- Direct render, mist lighting change alone: medians 27.08 / 23.60 / 25.06 ms.
- With mist optimised, adding vertex-lit drops: 25.84 / 23.50 / 24.67 ms.
- Separate full-frame completed-render check: about 28 ms both before and after;
  direct rendering about 24–25 ms. **No demonstrated whole-game 60 FPS result.**
- CPU frame submission varied substantially (roughly 11.5–20 ms). CPU ocean
  mirror tick alone varied roughly 2.9–5.2 ms. Shared machine load visibly changes
  these measurements, so do not attribute those CPU differences to shader edits.

The A/B checks preceded the LED function-scope correction. They isolate the
smooth sun/sky stage change; they do not prove savings from the previously
missing LED loop. Inactive-light skipping and final night lighting need separate
cost attribution if larger performance claims are made.

## Verification

93 focused tests pass, including three new real TSL code-generation regressions:
drops, mist and hull spray must retain the guarded LED loop in the vertex stage
and keep scattering out of the fragment stage. TypeScript passes. Final shaders
boot and render on WebGPU; night side-view inspection confirms preserved spray
shape and restrained coloured spill. No new pools, passes, textures or lights.

## Remaining budget work

1. Full eight-boat normal-loop pacing, including worker starvation and rolling
   start. Keep CPU simulation, submission and wall frame intervals separate.
2. Isolate expensive water/spray drawing with completed-frame A/B checks at the
   actual gameplay camera. No reliance on overlapping timestamp sums.
3. CPU mirror FFT remains a measurable fixed cost. Preserve physics phase/parity
   when changing it; do not blindly reduce its cadence or resolution.
4. Repeat a race on an otherwise idle machine before claiming a 30/60 FPS tier.

## Actual eight-boat normal-loop sample

Review profile was **High**, not Medium: native scale 1, 4096 shadow map,
reflections/caustics/spray/post enabled, AO off; sea wind 11, amplitude 0.24,
swell amplitude 0.34. This is a shared-machine observation, not an acceptance
benchmark. Snapshot includes the UI/AI edits present when copied at session start;
other agents may have advanced those files since.

Two consecutive real-time samples, no constrained boat placement or manual sim
stepping. Held straight-ahead throttle input; this is load testing, not a full lap.

| Sample | Frames | Wall interval p50 / p90 | Tick CPU per rendered frame p50 / p90 | Render CPU p50 / p90 |
|---|---:|---:|---:|---:|
| 24 s from grid (first 4 s excluded), ends rolling | 576 | 29.97 / 70.29 ms | 5.40 / 20.52 ms | 12.17 / 16.37 ms |
| Next 40 s (first 4 s excluded), ends 13.75 s into racing | 1228 | 21.99 / 51.99 ms | 4.65 / 15.25 ms | 9.70 / 12.37 ms |

Second sample: the loop pause predicate held 365 of 1227 checks (~29.7%) with the
race UI unblocked. `session.starvedTicks` stayed zero: the deterministic worker
lag guard is preventing trace loss. Worker catch-up reported max lag 5 ticks,
max batch 3; final batch/budget 1 tick. These guards must not be bypassed to make
an FPS counter look better. Tick CPU p90 includes three sim steps; first sample
p90 included four. The worker and CPU ocean mirror need profiling together.

**Agent handoff:** inspect `raceSession.holdSim`, `NpcFleet.catchUp` scheduling,
and worker physics/AI cost with these counters. Keep deterministic trace timing.
This water pass does not edit those concurrently owned files. Neither measured
sample establishes stable 30 FPS, much less 60. A faster median alone is not enough.

## 2026-09-16: remove a stale-result simulation hold

`raceSession.holdSim` checked `npcs.collectedTick` before the next `pump`. A worker
could finish during the gap between animation frames, but the page would decide
to pause from the previous frame's collected tick. Rendering then ran before the
frame-end pump collected those already-ready results. This discarded another
frame's simulation time unnecessarily.

The guard now calls the existing non-blocking worker pump only when the collected
trace appears insufficient, then checks the **same** required tick again. No lag
limit, timestep, catch-up budget, trace ordering or physics fidelity changes.
On the main-thread transport, the existing bounded pump can perform owed work;
the worker transport never blocks waiting for unfinished work.

Live isolated eight-boat comparison, three consecutive 15-second windows:

| Mode | Guard checks | Held | Held with worker already ready | Released by polling | Page ticks advanced |
|---|---:|---:|---:|---:|---:|
| Original | 386 | 97 | 51 | 0 | 567 |
| Poll before the same guard | 352 | 96 | 89 candidate holds | 82 | 742 |
| Original again | 373 | 118 | 70 | 0 | 620 |

No trace starvation occurred. The sequence is not the same scene replay: races
advance, weather and pack positions change, and machine load varies. Median
frame intervals were 30 / 40 / 39 ms. **This demonstrates avoidable simulation
stalls, not an FPS improvement.** Releasing simulation also allows more owed CPU
work per frame; rendering and worker throughput still need separate budget work.

`tests/speedboatWorkerHold.test.ts` reproduces the failure using the actual fleet
driver with completion deliberately hidden until a frame boundary. It failed
before the change and passes afterwards. Unfinished results still hold; sufficient
trace avoids another pump. 23 focused tests pass, including batch determinism on
real worker threads with SAB ×1, SAB ×2 and transfer ×1. TypeScript passes.

Final production-code browser check: 20 seconds, 492 guard checks, 75 stale
holds released, 223 genuine holds retained, zero starved trace ticks and no
worker error. The race was still rolling at the end. This confirms the remaining
worker throughput problem is real; the guard must continue to protect it.
