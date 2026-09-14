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
- The trim request policy (−wave lift, +0.3 above 20 m/s) has never run on the physics; check it when the stepCore line lands.
