# Steering roll: diagnosis and bottom-panel classification

2026-09-16. User confirmed the symptom is **rolling onto the side**, not a sudden yaw turn.

## Implemented

`src/speedboat/hullMesh.ts`: topside triangles now have `triStrip = -1`. Only keel-to-chine bottom triangles feed the planing strips. Topsides retain hydrostatic pressure, skin friction and separated normal face drag through the existing non-planing face path.

Previously the side walls contributed to each bottom half's area, normal and centroid. As a chine immersed, the model treated those vertical walls as part of the Wagner planing wedge: the strip normal rotated and the pressure centres moved. This produced a large roll transient during steering. The fix changes which surfaces supply those forces; it does not change gravity, inertia, engine angles, steering assists or directly set orientation.

The command path was already physical: input → assists → drive angle → thrust/gearcase forces at their actual lever arms → rigid-body integration. No steering-to-quaternion shortcut was found.

## Evidence

Headless fixed-step runs use the real `CpuOcean`, default assists and `createPlayerBoat`, seed 2100, 30 m/s initial forward speed, ten seconds straight at full throttle, then full helm. Four headings × both turn directions, 30 seconds per turn. No other-boat wakes are needed to reproduce the problem.

| Sea | Previous classification | Bottom-only planing |
| --- | --- | --- |
| Shipped Open preset | Worst bank 68.1° | Worst bank 38.6° |
| Rough stress settings | 5/8 runs cross 70° | 2/8 runs cross 70° |

Rough stress settings: Open preset overridden with windSpeed 11, amplitude 0.24, swellAmplitude 0.34, swellPeriod 11. This is a diagnostic stress case, **not a claim about the user's currently selected settings**. In its old 90°-heading/right-turn reproduction, bank crossed 70° just 1.72 seconds after steering began while peak world-y yaw rate was only 18.6°/s.

The checked-in `tests/speedboatSteeringSea.test.ts` uses the shipped Open preset, 90° heading and a ten-second right turn. It requires bank below 45°, at least 30° of actual rightward heading change and speed above 10 m/s. Restoring the old topside classification makes this test fail at 49.8398° bank. Thus simply suppressing steering or stopping the boat cannot satisfy the test.

Narrower helm angles, predictive helm unloading, disabling individual fluid terms and shifting individual pressure centres were investigated in temporary probes. None established a general correction; none of those experimental changes ships.

## Existing acceptance tests

- Buoyancy, Savitsky running trim, roll decay, straight-running stability, inward banking, roll stiffness, turn convergence and default steering envelope remain required.
- The old `it.fails` for half lock at C_v 8–10 now passes as a normal regression test.
- Full lock may still cause a crash, but tests must not require a crash merely because an older force model did. The onset-time check and Pro-versus-raw-command parity remain.
- Historical T179 energy/turn mutations now include the historical topside classification as well as the old force flags. Otherwise they no longer reproduce that historical model.
- Removing relative water velocity still violates the 30° resting-roll budget; the mutation need not capsize to demonstrate that violation.
- The Denny–Hubble speed-loss oracle mistakenly used 12 m overall length. Its cited [Aslan thesis, equations 21–23](https://calhoun.nps.edu/server/api/core/bitstreams/998838ab-990c-46dd-b13a-d0f4ae688883/content) specifies waterline length. The test now measures the loaded resting waterline from the hull's waterline segments. The 0.15 acceptance tolerance is unchanged. Running the turn longer did not resolve the original discrepancy, so duration was not used to hide it.

## Validation and NPC integration

139 focused tests pass across hull statics/handling/sea, player steering, collision, wake stations, player/worker parity, worker batching, AI capability, line and pilot suites. TypeScript check passes. The deliberate old-classification mutation fails the new steering regression; temporary diagnostic test files are removed after use.

`src/race/ai/capability.ts` turning columns were regenerated with the existing `measureCapability()` procedure. Top speed and straight-line acceleration/braking remain within their existing tolerances. NPC lock limits are unchanged and pass their entry tests. On stock engines extra helm now increases bank without forcing a capsize; the existing 4 MW / C_v 7–10 stress mutation still capsizes beyond the schedule, keeping that check meaningful.

A two-boat Open-sea lap smoke test (seed 201, veteran + rookie, 30 m grid gap) also passed: 60.98 s / 57.75 s, zero crashes, missed gates or stuck boats. This is a smoke check, not the full fleet/seed matrix.

## Remaining

Follow-up steering sweep: Open preset, seeds 201 and 202, headings 0° and 90°, both helm directions, with hold/release/countersteer variants. Each run starts at 30 m/s with ten seconds straight at full throttle followed by ten seconds of manoeuvre; release and countersteer occur two seconds into the manoeuvre. None of these 24 runs crossed 70°; worst bank was 44.93°. This broadens coverage but does not cover every wave phase or sustained rough-water turn.

The remaining rough-sea 90°-heading/right-turn trace crossed 70° after 12.15 seconds of helm. By 11.4 seconds the hull was dry and thrust zero; at 11.6–11.8 seconds all drive forces were zero while existing roll angular velocity remained about 0.512 rad/s. Airborne angular momentum carried the bank from about 47° toward 59° before re-entry. This trace does not support adding an artificial upright torque or blaming continued airborne thrust. The preceding water-contact roll impulse remains worth investigating.

## Respawn water-history correction

`WaterPatch.forgetPrevious()` previously cleared `hasPrev`, but the next `build()` immediately restored the old grid as velocity history because `built` was still true. Overlapping patches after a respawn could therefore interpret the new water level as rapid wave motion. A separate `retainForVelocity` flag now invalidates that history until a new grid has been built, while preserving access to the current height sample. No allocations, velocity clamps or fallback sampling were added.

`tests/waterPatchReset.test.ts` reproduces the bug through `HullWater.resetMemory()`: a water-level change from 0.01 m to 0.5 m at 60 Hz manufactured 29.4 m/s vertical water velocity before the fix. It now reports zero on the first new sample and resumes the correct finite difference on the second. Repeated resets before initial sampling are covered too. This is separate from the sustained-turn rollover, which contains no respawns.

Follow-up validation: 37 tests pass across water-history reset, hull-water forces, steering-sea regression and player/worker sea parity; TypeScript check passes. Temporary diagnostic traces and sweep harnesses were removed. No browser/GPU session was started for these checks.

The rough stress case still has two >70° departures in eight sustained turns. Do not describe this as universal capsize prevention. Broaden seed/wave-phase and release/countersteer coverage before any further force-model change; preserve the existing calm-water acceptance checks. Separately evaluate side/chine immersion and airborne low-side drive forces in the remaining departures.

This change adds no rendering passes, mesh triangles or GPU work. It moves wet topsides into the existing face-drag calculation, so CPU cost should be measured independently if it becomes material; FPS under shared machine load is not evidence of a regression or gain.

Other concurrent work in HullWater wake-load bounds, collisions and settings belongs to other agents. This investigation did not edit those changes. No commits were made.

## Final review and selective commits

The crash detector's old C_v 5 full-lock fixture no longer crosses its independently measured 45° departure threshold. It now belongs to the no-false-positive cases. Real full-lock departures on the existing 4 MW stress hull at C_v 7, 8 and 10 still require hook detection within the unchanged 0.5 s of physical onset. No production detector threshold or response changed.

Current validation covers 115 passing checks across hullWater, hullWaterStations, hullWaterManeuver, hullWaterSea, speedboatParity, speedboatSeaParity, speedboatSteeringSea, waterPatchReset, raceAiCapability, speedboatAssist and speedboatCrash. The updated two crash cases were rerun after the initial crash suite exposed the obsolete C_v 5 expectation. TypeScript and diff checks pass.

Two additional shoalingCircuit assertions fail identically with this patch and with all three changed production files replaced by committed HEAD in an isolated copy: bar face statistic 0.27118776451724447, required greater than 0.27203862643472315 and 0.31995087334757244 respectively. These are separate unresolved sandbar-wave issues, not steering regressions; their tests were not changed.

The user subsequently authorized commits. Water-history reset and bottom-panel steering classification are handed off in separate commits; earlier no-commit notes describe their prior status. No GPU/browser session was used for this review. Sustained rough-sea departures and broad visual acceptance remain open.
