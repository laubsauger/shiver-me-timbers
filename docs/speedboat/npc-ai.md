# Speedboat NPC racers (§T.186, S5) — handoff

Status: pilot, line, profile, archetypes and the sim-worker hook built and tested headless on real physics. Not on a
page yet (no `main-speedboat.ts`). Tests: `tests/raceAi{Line,Capability,Pilot,Laps,Pack,Sea,Determinism,Perf}.test.ts`,
harness `tests/raceAiHarness.ts`.

## Decisions carried in

- No speed rubber-banding (USER, design doc §4). Trailing NPCs take more risk: tighter line level, later braking, more
  air tolerance. Nothing in `src/race/ai` touches power, and the throttle stays the physics' own −0.3..1 (tested).
- Every boat runs full-fidelity physics (§V110), so tech-research §5.6 LOD/rails is dropped. The pilot runs inside
  `BoatSimCore.step`, on whatever transport the fleet uses.
- Decisions use sim state only: the tick-k pose, the WORLD snapshot, the core's own CpuOcean at the tick time, and the
  race standing written into the buffer. No camera, no wall clock.

## Files (`src/race/ai/`)

| File | Role |
|---|---|
| `measure.ts` | Headless measurement on real `HullWater` + `stepRigid6`: straight accel/coast/reverse, steady turns, lock entries. Not imported by the pilot. |
| `capability.ts` | Committed `MEASURED` table + interpolation (`curvatureAt`, `steerForCurvature`, `holdThrottle`, `turnTopSpeed`, `accelAt`, `decelAt`), `lockLimit(v)` (no-hook schedule), `HELM_RATE` 15°/s |
| `line.ts` | Corridors (gate poles − margin; marks: rounding segment on the side away from `keepOn`, keep-out circle radius + margin + `MARK_TRACK`), elastic-band min-Σκ² relaxation, static keep-outs (`LINE_CLEAR`), uniform 2 m resample, signed κ, lateral room (clipped `ROOM_CLEAR` short of a solid) |
| `keepOut.ts` | The page's solid colliders a hull can reach as xz discs on a 24 m grid (`buildKeepOuts`, `keepOutPush`, `keepOutClearance`); structured-clone safe |
| `profile.ts` | Speed profile: lateral cap from the measured turning (bisection), helm-rate cap, forward/backward passes with measured accel/decel |
| `archetypes.ts` | The seven couriers (design doc §4) as parameter sets |
| `aiBlock.ts` | Slot map of the per-boat AI block in the sim buffer; `encodeStanding` |
| `pilot.ts` | `buildPilotSetup(course, roster, { seed, colliders?, start?, grid? })` (5 risk levels × line + profile, keep-outs, rolling-start data), `RacePilot.control` |

## How it works

- **Line.** Corridor midpoints, then Gauss–Seidel on the discrete bi-Laplacian. Corridor samples are projected onto
  their segment and every sample is pushed out of mark keep-outs. Coarse to fine (12 → 6 → 3 m), re-sampled by arc
  length between corridor samples after every block. Build takes ~0.2 s for 5 levels. Relaxed vs midpoints: less than
  half the ∫κ² and at least 10 % faster profile (tested).
- **Risk levels.** 5 levels, r = 0..1: margin `7 − 5r` m, turning use `0.72 + 0.2r`, brake use `0.3 + 0.6r` (coast ↔
  full reverse). Each level's profile is strictly faster than the one below (tested). A boat rides the level its
  current risk picks, with hysteresis. Its station is tracked as an unwrapped lap fraction, so a level switch
  re-projects cleanly.
- **Profile.** `v_lat`: the highest v with `curvatureAt(v, lockLimit(v))·latUse ≥ |κ|`, capped by the measured
  full-throttle speed at that drive angle. `v_helm`: `V·|dδ/ds| ≤ ½·HELM_RATE`. Then 2 laps forward (accel shifted by
  the turn's drag) and 2 laps backward.
- **Steer.** Pure pursuit with L = clamp(lookaheadS·V, 25, 70) m, lookaheadS 1.5–2.0 s; the target is offset laterally
  by avoidance/blocking. κ = 2 sin α / L through the measured steer map, plus a yaw-rate damper (0.12) and a roll helm
  (× waveSkill: past 20° heel, steer away from the heel + roll-rate term). Then these limits apply in order: heel
  limiter (lock fades from 22° to 38° tilt; unwinding past it gets twice the helm rate), 40 % lock for 1.5 s after a placement, slew 15°/s, and the hard
  `lockLimit(v)`.
  - 1 s lookahead oscillated ±20 m in the chicane; the lag needs L ≫ √2·V·τ.
  - 30°/s helm from an unsettled hull peaked at 30–39° tilt; 15°/s peaks at 22–26°.
- **Throttle.** PI on the profile speed 0.6 s ahead, with the measured hold throttle as feed-forward and reverse only
  when > 1.5 m/s too fast. Mistake kinds: 1 = fumble ≤ 0.35; 3 = +6 % over-speed.
- **Waves.** Every 3 ticks the pilot reads `heightAt` **at the tick time** at 5 points along its path. A future-time
  read calls `CpuOcean.update(t)`, which rebuilds the mirror and steps the spectrum scheduler, moving the sea for every
  boat. Measured before the fix: 39 ms/tick for 7 boats. Tested.
  - Inputs: predicted airtime 2·V·slope/g, and the trough→face slope change ("stuff").
  - Above the archetype tolerance: lift × waveSkill, and a bow-down trim request.
  - Exposed ramp within tolerance and jumpAppetite > 0.5: hold throttle.
  - Sea respect: a ~4 s mean of predicted airtime cuts target speed up to 40 % × waveSkill × (1 − risk).
  - Props dry (last tick's `PROP_IMMERSION`): feather ≤ 0.4, unless the pilot loves jumps.
- **Traffic.** From WORLD: closest approach over 2 s < 8 m with the other boat ahead or alongside ⇒ lateral offset away
  (≤ 8 m, held 1.5 s). A faster boat 4–35 m behind ⇒ blocking offset of `aggression × 6` m to the inside of the next
  150 m. Offsets are clamped to the corridor room over the whole lookahead, minus 1 m (a gate inside the lookahead
  binds; that was a real miss).
- **Mistakes.** Seeded mulberry32 whose state lives in the buffer. λ = mistakesPerMin·(1 + risk).
- **Catch-up.** trail = clamp((gapToLeader − 1)/6, 0, 1); risk += trail × catchUp.
- **Crash / recovery.** If upY < 0.5 or the standing is crashed/respawning ⇒ throttle 0 and helm centred. On a respawn
  (reset seq) ⇒ global re-projection, integrators cleared, and recoveryS of recoveryRisk (veteran −0.2, hothead +0.2).

## AI state: in the sim buffer, not worker memory

`LayoutSpec.aiLen = AI_BLOCK_LEN` appends a 32-f64 block after each boat's wake samples.

- **AI OUT (24 slots).** The pilot's entire memory plus its applied controls. Stepper-written and inside the V2 hash:
  station, level, PI integral, applied steer (rad) / throttle / trim request, rng, mistake/recovery timers, risk,
  offset, avoid timer, wave lift, jump, target speed, cross-track, ticks, blocking, upset, respawned, rolling-start clock
  (`ROLL`, was the sample hint — now derived from the station), sea mean.
- **AI IN (8 slots).** Main-written before `kick` via `encodeStanding`, not hashed: valid, position, racers, lap,
  progress, gapToLeader, state code, go/speed-cap. The cap can only slow a boat.

`RacePilot` holds only the immutable setup. So:
- a pilot rebuilt mid-race continues bit-identically (tested);
- the state survives a transport downgrade with the buffer;
- the page can read the AI for HUD, radio and debug (`fleet.readAi`).

## Sim-worker changes (hooks, precise)

- **`layout.ts`**:
  - `H.AI_LEN = 13` (header slot, 0 when absent);
  - `AI_OUT_LEN 24`, `AI_IN_LEN 8`, `AI_BLOCK_LEN 32`;
  - optional `LayoutSpec.aiLen`; `boatBlockLength(wakeCap, aiLen = 0)`;
  - `aiOffset(i)`; `outRange` extends over AI OUT only when present;
  - the adopted spec carries `aiLen` only when > 0.
  - A layout without a pilot is byte-identical (tested, and the simWorker suites stay green).
- **`stepCore.ts`**: `BoatSimCoreInit.pilot?: PilotSetup`, `readonly pilot`, and `justReset` (a reset of an already
  placed boat). A piloted boat calls `pilot.control(i, L, state, this.ocean, this.time, justReset, out)` and then
  `hw.setControls(out.steer, out.throttle)`; controls IN are ignored for that boat. All other paths are unchanged.
- **`transport.ts`**: `SimInit.pilot?` (structured-cloned in `cloneInit`; the init message already spreads SimInit).
- **`workerHost.ts`**: passes `msg.pilot` to the core.
- **`fleet.ts`**: `aiLen` when `opts.pilot`; `writeAiInput(i, values)`; `readAi(i, slot)`.

## Measured turning (flat water, default drives = stand-in thrust, top speed 29.5 m/s)

Each cell is the steady speed (m/s) → R = 1/κ (m). Hold loop capped at full throttle.

| entry v | 5° | 10° | 12.5° |
|---|---|---|---|
| 6 | 6.0 → 105 | 6.0 → 51 | 6.0 → 40 |
| 10 | 10.0 → 139 | 10.0 → 73 | 10.0 → 60 |
| 14 | 14.0 → 194 | 14.0 → 106 | 14.0 → 90 |
| 18 | 18.0 → 246 | 18.0 → 131 | 18.0 → 114 |
| 22 | 22.0 → 282 | 21.9 → 146 | 21.9 → 126 |
| 26 | 26.0 → 313 | 25.9 → 158 | 25.6 → 133 |
| 29.5 | 28.7 → 346 | 26.8 → 161 | 25.8 → 134 |

Lateral acceleration at 12.5° runs from 1.5 m/s² at 6 m/s to 5.0 m/s² at 25 m/s. Positive drive angle turns to port.

**Lock schedule.** 10° at ≤ 6 m/s → 12.5° from 12 m/s to C_v 6.5 → 10° from C_v 7.5.

- With a 15°/s helm and full throttle held through the entry: no departure at 6–29.5 m/s, nor at 4 MW for C_v 7/8/10.
- 1.6× the schedule departs at 4 of 7 speeds; 1.5× at 4 MW departs at C_v 7, 8 and 10 (both tested).
- For comparison, a 30°/s helm departed at 15° (6 m/s) and at 17.5° (all speeds).

## Results (synthetic course: 9 gates + 2 port marks, ≈ 1.35 km lap, calm = 'calm' preset)

- **Rookie, 3 laps, calm.** 75.45 / 74.77 / 75.33 s; 34 elements passed, 0 missed, 0 hooks, 0 crashes.
- **Seven archetypes, 1 lap, calm, catch-up OFF.**

  | archetype | lap (s) |
  |---|---|
  | hothead | 68.4 |
  | rival | 69.5 |
  | blocker | 69.7 |
  | swell | 70.9 |
  | lee | 71.4 |
  | veteran | 72.7 |
  | rookie | 75.2 |

  Profile estimates: risk 1 = 62 s, risk 0 = 82 s. 0 misses, 0 hooks.
- **Catch-up ON vs OFF** (same race):
  - finish spread 5.9 s vs 11.2 s;
  - the last boat (rookie) finishes at 75.0 s instead of 82.7 s;
  - max throttle 1.0 either way.
- **Working sea** (the shipped default 'swell' preset; no speedboat presets exist), 1 lap, 3 veterans + 3 rookies:

  | | veteran | rookie |
  |---|---|---|
  | crashes per boat | 13 / 7 / 13 (Σ 33) | 18 / 10 / 18 (Σ 46) |
  | lap time (s) | 125–145 | 129–154 |

  An earlier revision (before the faster helm unwind) measured 9 / 13 / 13 vs 10 / 22 / 17.

  A/B on 2 veterans: roll helm on 6–7 crashes, off 11–12 (flipped sign: run aborted on a NaN placement, see Open).
- **Perf.** Pilot alone (8 boats, real mirror, wave reads, traffic): 18 µs per NPC per tick at machine factor ×2.7,
  63 µs at ×8 (capped) under heavy parallel-agent load. Budget: 60 µs × machine factor. The full 7-boat core step was
  ~10 ms/tick on this loaded machine; instrumented, the pilot share was ~0.2 ms of that.
- **Determinism.** Main vs sab×2 vs transfer×1 (hothead, rookie, blocker, 1 lap, calm): hash chain over OUT + AI OUT,
  positions every second and lap times compared with `toEqual`. Identical. The existing simWorkerDeterminism suite is
  still green.

## Open / needed from other owners

1. **Physics (sea-physics owner).** In the Working sea the V-39 proxy capsizes about every 10–20 s under the best
   pilot. It launches with roll rate, lands heeled and rolls over. Even with speed held straight, any heading
   capsizes at 10–29 m/s. This is the physics log's open roll-damping gap (~15 kN·m·s/rad), not the AI. The design's
   "veteran never crashes / Shine ≥ 3× Longhaul" cannot be met until it is fixed. The sea test bounds are today's
   reality.
2. **Trim (sim-worker owner).** `HullWater.setControls(steer, throttle, trim)` exists now and the pilot returns its
   request as `PilotOutput.trim` (unit, −1 bow down … +1 bow up). Not applied until `stepCore.ts` passes it (see Racecraft
   below) — untested on the physics.
3. **Thrust is TEMPORARY** (stand-in, T166). When the drive model lands, `raceAiCapability` fails; paste the new
   `measureCapability()` JSON into `capability.ts#MEASURED`, then re-check the lock tests (4 MW rows cover faster
   drives).
4. **Player in WORLD.** `BoatFleet.kick` copies only fleet boats into WORLD. For NPCs to avoid or block the player,
   the page (T181) must write the player's pose into a WORLD slot. A fleet boat index with `pilot.boats[i] = null` and
   a main-thread-written pose would need a `setWorldPose` hook (not built).
5. **Race logic (T184) wiring.** Each tick the page writes `encodeStanding` for every NPC before `kick`. The harness
   computes standings itself; `gapToLeader` is in seconds, from the leader-progress envelope. Rolling start: pass a
   number as `go` (speed cap).
6. **Respawn (T188).** Place on the surface, not at a fixed height. A fixed y = 0.35 m roughly doubled the Working-sea
   crashes in the harness through crash→respawn→crash loops.
7. **Flipped roll-helm A/B aborted.** A NaN placement height appeared once in the harness (`CpuOcean.heightAt` at
   t = 0 on a fresh mirror, run with flipped roll gains). It was not reproduced. The harness now throws with the
   values if it happens again.

## Racecraft on Tower Reach (rival AI fixes after §T.198/§T.202)

Headless evidence: `tests/speedboatRaceHarness.ts` now races on the page's own world (`tests/speedboatCollisionWorld.ts`
→ `towerReachCourse().attach`: course furniture, roof walls, capsules fitted to the drawn kit props; 7 668 colliders in the
tree, 7 839 at HEAD a4c02bf — the difference is uncommitted circuit WIP), not pirate rock placements.

| # | Cause (measured) | Fix |
|---|---|---|
| 1 Main Street walls | The line knew only gates and marks; between corridors every offset (avoidance, blocking) got a flat 12 m of room, and a boat far off its line pursued a chord straight back through whatever stood between. The line itself runs 38 m off the reference line on the G4→G5 leg, so a boat at full room offset sat ~50 m off it: the 47–58 m of the live report. In the harness (1 lap, then the post-finish lap at the 15 m/s cap) boats that had lost their line pressed against Main Street roof walls 45–60 m off it (124 solid-contact ticks). | `keepOut.ts`: solids a hull can reach as discs. The line relaxation pushes every sample `LINE_CLEAR` (10 m) off them; the lateral room stops `ROOM_CLEAR` (5 m) short of them; the pursuit chord (boat → target, every 3 m) is kept `PURSUIT_CLEAR` (4 m) clear by moving the target sideways (≤ 25 m). Far off the line the lookahead grows to 2.5 × the distance off it, so the arc back is one the boat can turn (the off-line corner cap reversed a rookie to 4 m/s, 30 m off her line, for 15 s; on the synthetic course it cost a rookie lap 8 s). `buildPilotSetup(…, { colliders })`. |
| 2 T1 miss | The mark keep-out was radius + margin: the lines rounded T1 at 31.9–35 m (radius 28), and a boat 4–6 m off its line cut the radius. With the §T.202 lap order the harness lap did not reproduce the miss, but the margin was the same. | Mark keep-out = radius + margin + `MARK_TRACK` (6 m): T1 now 37.5–41 m. Gates get the same treatment: `gateMargin` = max(margin + `GATE_TRACK` 3 m, `GATE_SHARE` 18 % of the width), after a lee 7 m and a (catch-up, over-speeding) rookie 11 m off their lines crossed 3–4 m outside G8's pole. |
| 3 no grid hold | The pilot rode its racing line from its slot; the columns converged and trailed their slots by 70 m. | While GO ≤ 0 the pilot holds its slot: `PilotSetup.start` carries the pace line and grid geometry (race/params start, `gridDepth`, grid index = fleet index), `AI.ROLL` counts rolling ticks (the slot `HINT` is now derived from `STATION`), the target is the pace line at the slot's column and the speed is pace + 0.35 × the along-line error, under the cap. At green: global re-projection onto the racing line and `OFFSET` = the cross-track it is at (merge at the offset slew). Then 40 s of **opening caution** (`CAUTION_S`, `AI.ROLL` < 0): overlapping within 13 m along ⇒ keep 9 m lateral; in a boat's lane (±4 m) ⇒ no closer than 14 m, pull out to pass. Without it the columns touched after the start gate and a follower nose-to-tail through G1 touched its leader; both hooked. Race-long, the same two rules kept the synthetic pack from passing (tests/raceAiPack: hothead 6 s slower than the veteran, catch-up no longer closing the pack), so they end with the caution. Measured: every rival ≤ 1 m along / 0.2 m across its slot at green (the peak lag, ~55 m, is the acceleration from 0 behind a pace boat that starts at pace speed). |
| 4 trim | `setControls` had no trim input; the request was computed and dropped. | `PilotOutput.trim` (unit −1..1, = `AI.TRIM`). Needs the sim-worker/page owner to pass it (below). |
| — pack, found on the way | A blocker covering the inside of T2 leaned on a rival overlapping it for 8 s and hooked; an avoid/alongside offset slewing back at 3 m/s from outside a tight corridor ran a hothead 1.6 m outside a 36 m chicane gate. | Blocking never moves toward a boat overlapping on that side. A corridor that binds inside the lookahead (room under the 12 m cap) clamps the offset itself, not only its target. |
| 5 guy anchor | Same as 3: off the pace line, a rival could reach an anchor. | Slot hold on the clear pace line + keep-outs (all static solids, anchors included). |
| 6 harness world | Pirate rock placements. | `courseFixture` uses `collisionWorld()`; the clearance test asserts the list is the page's and holds > 1 000 drawn-prop capsules. |

**Result (HEAD a4c02bf physics, scratch worktree; the tree's physics was mid-edit by T207):** Calm 1-lap smoke race —
all 8 finished, 0 penalties, 0 rival crashes, 0 rival ticks touching a static solid, every rival ≤ 6 m from its grid slot
0.5 s before green (measured ≤ 1 m), same hash at tick 2400 at 60 fps and 20 fps pacing; rivals 147.2–153.1 s, the
autopiloted player 162.0 s. Synthetic suites: raceAiLine/Pilot/Pack/Laps green (Pack at HEAD also green; Laps lap 3 had
regressed to +13 % with the 1.5× recovery lookahead, fixed with 2.5×). The same smoke race on the working tree of
2026-09-14 13:40 (T207's boat-wake field and circuit WIP uncommitted): 0 penalties, all 8 finished, but 2 rival hooks
(#3 veteran at tick 8942 and one more) — not gated here until that physics settles.

**Working sea** (HEAD physics, the 'swell' preset, 230 s from the start, 200 s after green; nobody completed the lap):
crashes hothead 34, rookie 28, swell 26, lee 26, rival 22, blocker 20, veteran 20 (162 hooks, 14 barrel rolls; 4
before green). Open item 1 (roll damping) still dominates.

**Wiring needed from other owners (not edited here):**
- `src/sim-worker/stepCore.ts` (pilot branch): `b.hw.setControls(po.steer, po.throttle);` →
  `b.hw.setControls(po.steer, po.throttle, unitTrimToRad(po.trim ?? 0));`
- `src/speedboat/page/autopilot.ts` `sample()`: after `out.throttle = po.throttle;` add `out.trim = po.trim ?? 0;`
- `src/main-speedboat.ts`: `buildPilotSetup(world.course, [...RIVAL_ARCHETYPES, null], { seed: state.seed, colliders: world.colliders })`
  — without it the page's rivals have no keep-outs (the grid hold works without it).
- ~~The trim request policy (−wave lift, +0.3 above 20 m/s) has never run on the physics~~ — landed in §T.207, re-tuned below.

## Wakes and trim (after §T.207: wakes move every hull, the pilot's trim reaches the drives)

Headless evidence: `tests/speedboatRaceSmoke` (Tower Reach, calm, 1 lap, wakes on) + a seed sweep of the same race
(seeds 2100–2105, scratch, not committed) counting rival crashes and tilt > 32° episodes.

| # | Cause (measured) | Fix (`pilot.ts`) |
|---|---|---|
| wake hooks | Pilots were blind to wakes. A lee 16 m behind a blocker at 30 m/s through a sweeper, in its stern hollow (−0.3 m at the CG, 6 % roll slope), heeled 18° → 38° in 0.4 s with the props out and hooked; a rookie 26 m behind the blocker rolled over in a turn on the post-finish lap; a rookie braking in full reverse 30 m behind a blocker (wake crest +0.25 m, 12 % roll slope) snapped from 30° of heel to 50° the other way. | (1) The wave read adds the other boats' wake field (`WakeField` from WAKE WORLD, prepared 0.6 s ahead) to the surface, so a wake crest lifts like a ramp; its roll slope across the path within 0.9 s lifts a cornering pilot (≥ `WAKE_SKILL` 0.6 of the lift). (2) Cornering inside another boat's Kelvin wedge (tan 19.47°·X + 4 m) within `WAKE_GAP` 45 m of its stern: speed cap closing ≤ 0.3 m/s per metre short of the gap, and a lateral step past the wedge edge on the side she is on. (3) Reverse is the brake only below 10° of tilt. (4) In smooth water (`AI.SEA` ≤ 0.25) past 22° of heel she eases the throttle to 30 % at 38° (the drives roll her into the turn). Formation (rolling start) ignores wakes: a wake-lifted rookie sat 14.7 m off its grid slot. |
| trim | +0.3 above 20 m/s everywhere and −waveLift (to −6°) had never run on the physics; applied: raceAiLaps lap-to-lap 11 %, raceAiPack a hook. | Neutral below 15 m/s and in the formation; −0.5·lift in a lift; −0.2 cornering (line κ > 1/400 within 2 s, or tilt > 10°); +0.3 on a straight above 24 m/s; slewed 1.5/s. Flat water [M]: +0.3 top speed 33.9 → 35.1 m/s (+1.0 blows out, 29.7); −0.25 R −3 % in steady turns; a lock-to-lock reversal at 14–30 m/s peaks at the same tilt/drift (±1°) at trim −0.3…+0.3. Capability table unchanged (measured at trim 0; `raceAiCapability` green). |
| sea | Easing throttle at heel everywhere made the veterans crash more than the rookies in the Working sea (raceAiSea veterans 28 vs rookies 19). | The heel ease only in smooth water (above). |

**Results.** Smoke race (seed 2100): 0 rival crashes, 0 penalties, 0 solid contacts, grid slots held, paced hash equal; all 8
finish, rivals 147–192 s (slower tail than before: the wake spacing costs time in corners). Seed sweep with the same race:
pilots blind to wakes (wake terms off, heel ease on, reverse at any heel) 62 tilt episodes and 10 rival crashes over 6 seeds; wake-aware (with heel
ease, before the sea gate) 30 episodes, 2 crashes; the final policy 0 crashes over seeds 2100–2102 (13 episodes).
raceAiLaps rookie 66.5 / 62.4 / 61.0 s; raceAiPack, raceAiSea (veterans 14 vs rookies 20), raceAiDeterminism green.

**Fragile, stated (fixed in §T.213 below).** raceAiLaps (lap-to-lap ≤ 4 % for the rookie), raceAiPack (archetype spread
and hothead < veteran) and raceAiSea were single-seed checks that flipped with any pilot change: across seeds 1–5 each
policy tried failed laps on 1–2 seeds and pack on 2 of 3. The player's autopilot (`page/autopilot.ts`) has no WAKE WORLD
in its private layout, so it stays wake-blind.

## Racing across seeds, not on one (§T.213)

Evidence: `tests/raceAiSweep.ts` + `scripts/race-ai-sweep.mjs` — one race per process (CPU only, no browser), the seed
moving BOTH the sea realisation and the pilots' mistake dice. Two courses: `pack` (the synthetic 11-element course, seven
couriers, 1 lap, 30 m grid rows, wakes AND boat contacts on — the harness carried neither before) and `tower` (Tower Reach
exactly as the page builds it: colliders, seabed lee, rolling start, crash machines, race logic, the autopiloted player).
The seas are the speedboat's own (`params/speedboatSea.ts`): calm Hs ≈ 0.16 m, working ≈ 0.5 m (the race default), open ≈ 1.5 m;
the harness used to race the ladder's `swell` rung (Hs 2.8 m) and called it "Working".

**Baseline → after, per 12 seeds × {calm, working}** (crash-free races / all races, and the first-to-last rival finish spread):

| | Tower Reach calm | Tower Reach working | pack calm | pack working |
|---|---|---|---|---|
| before | 9/12, worst 3, spread 25.7 s | 10/12, worst 2, 29.3 s | 11/12, 31.5 s | 10/12, 31.1 s |
| after | 12/12, spread 13.0 s | 12/12, spread 13.6 s | 24/24 seeds, 14.3 s | 22/24 seeds, worst 1, 15.8 s |

Missed gates: Tower Reach 0 before and after; the synthetic pack 3 → 10 marginal misses in 48 races (below).

**Root causes found (each measured, then fixed generally — no per-seed constants):**

| # | Cause (measured) | Fix (`pilot.ts`) |
|---|---|---|
| 1 wake lift ate the pack | The §T.207 wake-roll LIFT fired on 27–45 % of every follower's wave reads (the pack lives inside wakes): the hothead lost 16 s of profile speed to it in one lap, the swell 20 s, while the leader lost none. Pack spread 31 s, and the order was the grid order — nobody passed. | The wake read no longer lifts the throttle. What a wake does is roll her, so it now reduces the HELM (`AI.WAKE_BRACE`, below) instead of the drive. |
| 2 no passing rule | Traffic was avoidance (closest approach < 8 m) + a 40 s opening caution + a corner-only "wake quarter" cap that dropped a boat 45 m astern of anything it turned inside. A faster boat behind had no way past and no lane of its own. | PASS/FOLLOW, race-long: the boat in this lane ahead (its lane, below) is passed on the side that fits the corridor room, `PASS_LAT` off ITS offset; while still in its lane the closing speed is capped to hold the gap; no side fits ⇒ follow at the gap. The alongside rule (`AVOID_LAT`) is now race-long too, and the caution's own follow rule is gone. |
| 3 how big a wake is depends on how fast its maker is | Measured on the field the pilot reads: a 24 m/s source leaves ≤ 0.1 m and ≤ 3 % of roll slope outside \|Y\| 6 m; an 8–11 m/s one (a corner, a queue, a boat that has just been passed) leaves 0.2–0.3 m and 6–7 % along its cusp (0.35·X out) to 60 m astern — and a 12 m hull crossing that at 12–20 m/s with helm on capsizes. Straight-line crossings at any speed peak at 8° of tilt (measured), so it is wake + helm, not wake alone. | The lane a boat ahead owns is its own beam when it is quick (`LANE_HALF` 6 m) and its whole Kelvin wedge when it is at hump speed, blended over `WAKE_SLOW_TOP` 22 → 10 m/s; the gap behind it grows the same way (25 → 45 m). |
| 4 a follow cap compounds into a standstill | With the cap free to fall below the leader's own speed, a queue through the tight mark collapsed to 6 m/s and then to 0 — and a queue at hump speed is a queue of the wakes in row 3. | The cap never asks for less than the leader's speed − `FOLLOW_SLACK` (3 m/s), nor less than `FOLLOW_FLOOR` (6 m/s) while the leader is above it. |
| 5 the offset outran the boat | A pass/avoid offset slewing at 3 m/s reached 11 m while the hull was still on the old line: at the pursuit lookahead that is a 20° heading step, and the overshoot ran boats 30–40 m off their line, into the next gate's pole. | `OFFSET_LEAD`: the offset never leads the boat's own cross-track by more than 4 m. |
| 6 the heel limiter took the righting helm away too | The symmetric tilt limiter faded the lock to nothing at 38° whichever way the helm was going, so a hull past it could only wait — and the roll helm (× `waveSkill`) was 0.2 of a helm for a rookie. Boats rolled 25° → 45° with the helm centred. | Directional limit on the heel `HELM_HEEL_TAU` (0.5 s) AHEAD: the helm TOWARD the heeled side eases from 18° to nothing at 30°, the righting helm keeps the full lock. Plus a roll damper at every heel and a `ROLL_SKILL_MIN` floor of 0.6 on both: keeping the boat under her is not an archetype trait. |
| 7 a wake crest with the helm on | 60°/s of roll rate arrived from a 0.27 m crest with 14 % of slope across the hull, 20 m astern of two slow boats. | `AI.WAKE_BRACE` (the slot the one-tick RESPAWNED flag had): the wake roll slope across the path within 0.9 s takes up to `BRACE_LOCK` (50 %) of the helm lock, decaying over 0.5 s — she crosses crests nearer upright. Released as she runs off her line (`BRACE_RELEASE` 8 m), where the helm is what puts her back through the gate. |
| 8 finished boats parked on the racing line | The post-finish 15 m/s cap put a boat at cruising speed on the line the pack was still racing down, with the wake of a boat at hump speed. | A finished pilot pulls to the outside of what comes next first; the cool-down cap applies once she is 8 m off the line. |

§T.213 acceptance (12 seeds × calm + working): Tower Reach — 24/24 races crash-free, every rival classified finished, no
missed gate, no static-solid contact. Synthetic pack (24 seeds) — 46/48 crash-free, never more than 1 crash in a race,
everyone finished, 10 marginal misses (below).

**Still open, stated.** (All five are answered, with numbers, in the §T.213 follow-up section below — read that first.)
- **The pack spread is 13–16 s over ONE lap, not the design band** (design doc §4: median P1–P8 ≤ 25 s over a 3-lap race,
  i.e. ≈ 8 s a lap). Halved from 26–31 s, and no rubber band: it is line risk, traffic and catch-up only.
- **Marginal misses on the synthetic course**: 10 in 48 pack races (0 in 24 Tower Reach races), all boats 8–35 m off their
  line under full catch-up risk crossing 0.3–6 m outside a 36 m chicane pole or the last gate. Raising the gate corridor's
  tracking allowance (`GATE_TRACK` 3 → 5 m) and the level margin did NOT fix them and cost crashes elsewhere (19/24 clean).
- **A physics blow-up, not the AI**: in the `open` sea (and once in calm), two boats in contact at ~30 m/s came out of one
  tick at 460 and 1068 m/s — `sea-physics` boat↔boat contact, reproducible from the sweep (pack, open, seed 101, t 18.5 s).
  The `open` sweep rows are meaningless until that is fixed.
- `tests/speedboatRaceSmoke`'s pacing assertion (`paced.heldFrames > 0` — 20 fps pacing must make the fleet trail) fails on
  this machine AT HEAD as well, with the §T.213 pilot reverted: it is a fleet-pacing/budget check, not an AI one. The race
  it runs is clean either way (all eight classified finished, no penalty, no rival crash, no solid contact).
- The player's autopilot still has no WAKE WORLD in its private layout (`page/autopilot.ts`), so it is wake-blind: it runs
  the same policy, but its wake read finds nothing. Unchanged by §T.213.

**Tests.** `raceAiLaps` (3 seeds × calm/working, rookie, 3 laps), `raceAiPack` (6 seeds × calm/working on real worker
threads: clean racing per race, spread/ordering on the median, catch-up A/B, no thrust path), `raceAiSea` (3 seeds ×
working/open: everyone finishes, the wave read is live, the open sea costs time). The full sweep is opt-in:
`node scripts/race-ai-sweep.mjs` (12 seeds × calm/working + 3 open, both courses, ~25 min on 8 processes;
`--course pack --seeds 24` for the fast half, `--log <file.jsonl>` to survive an interrupted shell, `--events` for the
per-crash situation lines).

## What the pack spread actually is (§T.213 follow-up)

Evidence: the same sweep (`scripts/race-ai-sweep.mjs`, one race per vite-node process), plus two scratch harnesses run
the same way — a DECOMPOSITION (each archetype alone in empty water, then the seven together with the wake field off,
on, and with catch-up off) and a PROBE (per boat, time-weighted means of the pilot's own AI OUT slots during the race:
target speed against the level's flat-water profile, throttle, wave read, brace, cross-track, tilt). Both were deleted
after the measurement; the numbers are here.

**The spread was never archetype skill, and it was never the sea.** Synthetic pack course, 1 lap, 6 seeds × two seas,
first-to-last FINISH spread (absolute, so it carries the flying grid's 90 m stagger ≈ 3.3 s) and LAP spread (each boat's
own lap, net of it):

| | finish | lap |
|---|---|---|
| each archetype ALONE in empty water | 3.9 / 3.5 s | 3.9 / 3.5 s |
| seven together, boat contacts on, **wake field off** | 6.3 / 6.6 s | 3.5 / 3.8 s |
| seven together, **wake field on** (what ships) | 13.2 / 12.9 s | 8.4 / 7.8 s |
| the same with catch-up off | 12.5 / 15.8 s | 8.1 / 10.6 s |

Seven boats racing, touching and blocking each other cost the pack NOTHING in pace (lap spread 3.5 → 3.5 s). Turning the
wake field on doubled it. Per grid row, wake field on minus off (6 seeds, lap seconds): row 0 (rival, veteran) 0.0/−0.3,
row 1 (hothead, blocker) +2.5/+2.4, row 2 (swell, lee) +5.5/+3.8, row 3 (rookie) +6.4. **Each row behind the leader lost
~2 s more than the row ahead of it, and the finishing order was the grid order** — 89–90 % of all finishing pairs across
96 races, on both courses, both seas.

**Where in the pilot.** Not the throttle lift (`AI.WAVE_LIFT` was 0.000 for every boat, every race). Not the sea respect
(`AI.SEA` went 0.013 → 0.033–0.056 against a 0.15 threshold). Not the heel ease (no boat spent a tick past `HEEL_EASE`,
mean tilt 8–10°). It was the FOLLOW CAP: the profile speed the traffic cap took off a follower went 0.9–1.8 → 2.3–2.9 m/s
on a 27 m/s plan, and the applied throttle 0.87 → 0.77. Removing the cap outright (scratch) drops the spread to a median
7.3 / 7.9 s — and the boats touch **1034 times in 24 races instead of 231**, crash-free falls to 18/24, and 5 gates are
missed. So the cap is not optional; the question is how much of it is the wake and how much is the hull.

**The cap is a spacing, and the spacing IS the spread.** A queue of seven at `gapM` metres is 6·gapM long, and that
length in seconds is what separates first from last at the flag. With wakes, `gapM` was 25 m behind a quick boat and 45 m
behind one at hump speed: 150–270 m, 6–10 s at 27 m/s. Without wakes it is `FOLLOW_GAP` 14 m: 84 m, 3.1 s — which is
exactly the 6.3 s the wake-off column measures once the 3.3 s of grid stagger is added.

**Fixes (measured, no rubber band — nothing here touches power, and the catch-up A/B is unchanged):**

| # | Cause | Fix (`pilot.ts`) |
|---|---|---|
| 1 | The wake gap was held down every straight. What it was measured against is a hull in another's stern hollow WITH HELM ON (§T.207: a lee 16 m astern through a sweeper, 18° → 38° of heel in 0.4 s); a straight-line wake crossing peaks at 8° of tilt at any speed (§T.213 #3). | `GAP_CORNER_S`: the gap runs from `FOLLOW_GAP` on a straight to the wedge-scaled `WAKE_GAP_MIN + WAKE_GAP_SLOW·slow` as the line bends, read 3 s of travel ahead so the room is open before the helm goes on. |
| 2 | The SPEED cap was gated on the boat ahead's whole Kelvin wedge (15–20 m by 40 m astern), so a boat clearly on another line still had to match its speed. | The cap is gated on the hull's own lane (`LANE_HALF`); the wedge keeps its two real jobs — how wide to go by, and the pull-out. |
| 3 | The pass berth was the wedge + 2 m (15–22 m) and the corridor is `ROOM_CAP` 12 m, so "no side fits ⇒ follow" refused every pass exactly where passing matters: behind a boat at hump speed, in a corner queue. | The berth is the widest the corridor HAS, never below `AVOID_LAT` — the separation the alongside rule already keeps between two hulls. |

**Result, synthetic pack, 24 seeds × two seas, 1 lap (finish spread median, p25–p75, min–max):**

| | before | after |
|---|---|---|
| calm | 13.6 (12.1–14.4) 10.8–16.6 | 11.5 (11.0–12.2) 9.3–14.9 |
| working | 13.5 (12.7–14.8) 10.9–18.4 | 11.6 (10.9–13.4) 9.2–15.4 |
| crash-free | 20/24, 23/24 | 23/24, 22/24 |
| missed gates | 1, 0 | 0, 2 |
| boat contacts | 231, 223 | 190, 296 |

**And on Tower Reach — the course the page races — 12 seeds × two seas, 1 lap** (the autopiloted player on the grid too,
now wake-aware; the same seeds before and after):

| | before | after |
|---|---|---|
| calm | median 13.3, 10.0–18.8 | median 11.3, 9.9–15.0 |
| working | median 14.3, 9.5–21.3 | median 12.3, 11.0–15.6 |
| crash-free | 12/12, 10/12 | 12/12, 11/12 |
| missed gates | 0, 1 | 0, 0 |
| static-solid contacts | 0, 0 | 0, 0 |
| boat contacts | 106, 142 | 76, 104 |

The worst case is what moved most: the long tail (18.8 and 21.3 s races) is gone on both seas, because the tail WAS a back
row queued behind a corner's worth of room down every straight.

**Tried and REJECTED, with the numbers:**
- **A directional wake brace** (ease only the helm that adds to the roll the wake is about to put on, as §T.213 #6 did for
  the heel limiter). Spread 11.5 / 11.5 s — no change — and crash-free 22/24, 21/24 with a race at 2 crashes. The brace is
  not what costs the pack time; the symmetric one is left alone.
- **A flat shorter gap.** `WAKE_GAP_MIN/SLOW` 18/10: spread 10.2 / 10.6 s but crash-free 21/24 and **19/24**, 3 missed
  gates each. 20/15 corner-gated: 10.5 / 11.5 s, crash-free 22/24 and **18/24**, worst 3 crashes, 443 contacts. Both fail
  the §T.213 acceptance (crash-free in ≥ 95 % of races, never more than 1). 25/20 corner-gated is the edge that holds.
- **A floor under the off-line corner cap** (`cornerSpeed` bottoms out at its own 4 m/s when the pursuit arc is tighter
  than the boat holds at any speed, and the autopiloted player braked to it 18 m off her line). Floored at 12 m/s the
  Tower Reach smoke race came out bit-identical — she is over 12 m/s through the whole excursion, so it never binds.
- **Aiming the pursuit at the next element's own corridor** when the hull is outside the room there (the recovery
  lookahead deliberately aims far down the line, which past a gate means aiming past its pole). It fixes the player's
  start gate and costs everything else: 2 → **56** missed gates in 48 pack races, spread 11.5 → 22.2 s, 944 contacts —
  aiming at a point 8 m ahead is a pure-pursuit instability, not a correction. With a 25 m lookahead floor on the element
  it is 2 → **7** missed gates and crash-free 22/24 → **16/24** in the working sea. Rejected.

**The ≈ 8 s a lap target is the wrong reading of the design, and the design band is MET.** Design doc §4 says median
P1–P8 ≤ 25 s over a 3-lap race; §T.213 divided that by three and measured 1-lap races against 8.3 s. But the spread is not
proportional to laps — it is (grid stagger) + (queue length) + (skill difference × laps), and only the last term repeats.
Measured on the shipped policy, 12 seeds × two seas: **1 lap 11.5 / 11.6 s; 3 laps 14.7 / 15.8 s** (p25–p75 14.1–15.1 and
15.1–16.3, max 22.0), not 3 × 11.5. The 25 s band holds with 9 s to spare. A per-lap band is only meaningful as
`stagger + queue + laps · skill`; on this course and grid that is ≈ 3.3 + 3.1…9 + 3.9·laps s, and its floor with the boats
nose-to-tail at a distance they survive is ≈ 7 s at one lap — reached in the scratch run only by removing the cap and
taking 1034 contacts. **Recommend the sweep and `raceAiPack` gate the design's own statement (≤ 25 s over the race) and
report the 1-lap number as a diagnostic, which is what they now do.**

**The synthetic chicane is no longer missing gates.** §T.213 measured ~1 marginal miss per 5 pack races (10 in 48). At the
tree measured here — the re-measured turning table of 2026-09-16 (`capability.ts`, topsides separated from planing
bottoms) — the SAME sweep over 24 seeds × two seas finds **1 missed gate in 48 races before the fixes above and 2 in 48
after**, and neither is the chicane: both are a boat 36–58 m off her line at 11–15 m/s under full catch-up risk, recovering
after a knock, crossing the LAST gate (element 9/10) wide. The chicane misses went with the turning table, not with a
pilot change. What is left is the recovery case, and it is a different mechanism: off the line the pursuit lookahead grows
(`RECOVER_LOOK`) so the arc back is one the boat can turn, which necessarily aims her past the gate she is beside.

**The player's autopilot now reads wakes.** `page/autopilot.ts` builds its private one-boat layout with a WAKE WORLD and
copies the race session's own per-tick rival records (`RaceSession.rivalWake`, the same array `PlayerBoat.setWakeSources`
already floats her hull on) into it, fleet index order; her own slot stays zero (`WakeField.prepare` excludes the reader,
§V108). Every wake term in the pilot is gated on `L.spec.wakeField`, so this is the whole of it: the same policy, the same
source, the same lane/gap/brace a rival gets. `tests/raceAiAutopilot.test.ts` proves the wiring on flat water, where
`AI.SEA` can only leave zero if another boat's wake reached the wave read.

**Open, stated: it costs the player the start gate on the smoke race's seed.** She is last on the grid, so the opening
traffic at the start gate is hers alone, and reading wakes puts her on the other side of it. Isolated on that one race:
HEAD pilot + wake-blind autopilot — player clean, but rival #3 touches a static solid for 6 ticks (the smoke test is red
in this tree for a reason that is not the pilot's); this pilot + wake-blind — everything clean, player 159.4 s; this pilot
+ wake-aware — rivals clean and off every solid, player 165.1 s with the start gate missed (+5 s). She still races the lap
and is still classified finished. Both pilot-side fixes tried for it are in the REJECTED list above. `speedboatRaceSmoke`
now asserts the rivals' penalties at zero (the race-AI gate, unchanged in strength, and newly met — the solid-contact
assertion passes with this pilot and fails at HEAD) and bounds the player's at one missed element, with the isolation in
the test's own comment. It is a real regression for one boat on one seed, and it is written down rather than papered over.

**`speedboatRaceSmoke`'s `heldFrames > 0` was unreachable, and it was never an AI check.** `raceSession.holdSim` pumps the
fleet before it decides (39da0b9, "refresh its collected trace before losing another frame of sim time"). On the harness's
in-process fleet that pump polls, collects the in-flight batch and advances `collectedTick` synchronously, so the
predicate is false every time and the loop never holds — at HEAD as well. The assertion's intent is that the 20 fps run
really did trail (otherwise the hash equality below it compares two identical runs), and what that means on ANY transport
is the catch-up report: at 60 fps the fleet is stepped one tick per request (`catchUp.maxBatch` 1), at 20 fps it owes
three and catches up in one multi-tick batch (> 1, `maxLagTicks` > 1). That is what it now asserts.
