# Speedboat page (§T.181 S0): skeleton, loop, seams

Status (§T.191): one playable race on Tower Reach — boat select → rolling start → laps → crashes/respawn → results, 7 piloted rivals on the worker. See "§T.191 race slice" below; the S0 notes that follow are the skeleton it grew from.

S0 status: the page boots end to end on open sea. The player runs `rigid6` + `HullWater`, 7 NPCs run through `src/sim-worker`, the wake runs on the sim backend, and a chase camera and a knots HUD are wired. Every later task plugs into a seam in `src/speedboat/page/seams.ts` and swaps one constructor line in `src/main-speedboat.ts`.

## Files

| File | Role |
|---|---|
| `speedboat.html` | Splash (`__bootProgress` / `__bootReady`). The COI shim `coi-register.js` loads before the module. |
| `vite.config.ts` | `speedboat: 'speedboat.html'` input entry |
| `src/main-speedboat.ts` | Boot and loop order only (≤ 300 lines) |
| `src/speedboat/page/seams.ts` | The integration interfaces (below) |
| `src/speedboat/page/speedboatScene.ts` | `buildSea` (sim wake on `WAKE_SPEEDBOAT_TIER`, one prop jet per drive, course sites, speedboat sea params), GLB hero + NPC instances, rooster tail |
| `src/speedboat/page/speedboatFrame.ts` | `tickSea` / `tickBoat` (fixed tick), `renderSea` / `renderBoats` (frame): the speedboat's calls between `core/seaFrame.ts` runs, plus `HullWaterStations` (burial → churn, waterline → wetline) |
| `src/core/seaFrame.ts` | The per-tick/per-frame sea sequence shared with `raft/raftFrame.ts` (§V95) |
| `src/speedboat/page/playerBoat.ts` | Player physics: the same step `BoatSimCore` runs per boat |
| `src/speedboat/page/npcFleet.ts` | Pipelined kick/collect driver over `createNpcFleet` |
| `src/params/speedboatSea.ts` | Speedboat `SeaPhysicsParams` (Smith depth = deep-V draft), registered as `sea-physics-speedboat` for the panel; shared by the page mirror and the fleet |
| `src/speedboat/page/seaParams.ts` | Page adapter: supplies the grid's rest CG height (`SPAWN_CG_Y`) |
| `src/speedboat/page/course.ts` | Open-sea `CourseHook` stub, grid spawns |
| `src/speedboat/page/controls.ts` | Keyboard `ControlSource` stub |
| `src/speedboat/page/stubs.ts` | Chase camera, silent audio + unlock, no-crash hook, knots HUD |
| `tests/speedboatIsolation.test.ts` | §V109 transitive walk (entry + all of `src/speedboat/`) |
| `tests/speedboatPageStructure.test.ts` | Boot order, physics in the tick, worker selection and pipelining, wake on the sim pose, steer sign |
| `tests/speedboatSeaFrame.test.ts` | §V95 shared sea sequence (no copies, order), prop jets + wake tier, burial/wetline wiring, params registration, audio hooks |
| `tests/hullWaterStations.test.ts` | Burial rate = immersion change (swell, pitch plane, teleport, clamp), waterline vs the clipped contact waterline, no telemetry side effects |
| `tests/simWorkerBatch.test.ts` | Multi-tick kick tick-exact vs one tick per kick (20 fps, hidden-tab burst, real worker threads) |

## Loop order (`core/loop.ts` untouched)

```
tick:   state.tick++, time += dt → weather → controls.sample → frame.tickSea (spectrum + mirror)
        → player.tick (setControls → samplePatch(pressureHead) → planingSubsteps → stepRigid6)
        → crash.tick (→ player.place + snaps) → frame.tickBoat (flowfoam track, wakeSim.tick on the
        SIM pose with this step's samples + jets, rooster tail) → npcs.recordTick → npcs.pump
render: renderSea → renderBoats (hero + NPC interpolated, camera.update, clouds/reflection/surface)
        → post/render → timestamp resolve → hud.update → audio.update → npcs.pump
```

## NPC pipelining

- `pump()` runs at the end of each tick and at the end of each frame. If the request is home, it collects. If the fleet trails the page tick, it sends a request.
- **Catch-up (multi-tick kick).** `pump()` sends every tick the fleet owes as one request (`BoatFleet.kickBatch`). Each row carries that tick's exact time, its params snapshot and its controls. A request is capped at 60 ticks and at ⌊budget / measured per-tick step⌋ (≥ 1). The budget is 8 ms of main-thread time on 'main', and max(12 ms, ¾ of the kick interval) on a worker. The stepper runs the rows through the unchanged step core, so a 20 fps page or a hidden-tab backlog is repaid in a few round trips and no tick is ever dropped.
- `tests/simWorkerBatch.test.ts`: a 20 fps pattern plus a 360-tick backlog, with a wind shift inside it, matches one-tick-per-kick stepping at every collected tick (main transport, plus sab×1/×2 and transfer on real threads).
- The params residue is gone: NPC tick k floats on page tick k's params. Rival controls are `controls(boat, tick)`; pose-dependent piloting belongs to the in-stepper T186 pilot. `lagTicks` and `catchUp` report the catch-up.
- **Audio views:** `contact(i)` (wetted area, prop immersion, slam impulse summed over collects until `resetSlam()`) and `throttle(i)`. Inside one multi-tick request only the last tick's slam is published by the stepper.

## Seams for T182–T188

| Seam | Called | Owner | Stub |
|---|---|---|---|
| `ControlSource.sample(dt, boat) → BoatControls {steer −1..1 (+ = right), throttle −0.3..1, trim, surge}` | fixed tick, before physics | T182 | `createKeyboardControls` (W/S, A/D ±0.5 lock, slewed) |
| `CameraRig.update(view, frameDt, waterAt)`, `snap()`, `capturesInput()` | render, after boats placed | T182 | `createChaseCamera` (FollowCam 'follow', radius 16, pivot 2.4) |
| `BoatAudioSink.unlock()`, `update(BoatAudioFrame)` | first gesture; render, last | T183 | `createSilentAudio` + `installAudioUnlock` |
| `HudSink.update(HudModel {knots, headingRad, npcTransport, npcLagTicks})` | render, after the frame | T185 | `createKnotsHud` |
| `CourseHook {sites, course: race/types Course, spawn(slot)}` | boot (sites → `buildSea`), spawns | T187 | `openSeaCourse` |
| `CrashHook.tick(dt, boat, contact) → CrashEvent {kind, respawn}` | fixed tick, after physics, before wake | T188 | `createNoCrashes` |

Owners extend a seam by adding optional members. Renaming a member is a coordinated change.

## S0 hooks: status

1. **Prop jets reach the foam (done).** `SeaOptions.propJets` is forwarded to `createFlowFoam` only when given, and the page passes `HULL_DATA.engines.length` (3). Raft path unchanged: the `buildRaftSea` wiring fingerprint (`zzScratchSeaRefactorHash`, sim `4c93b102…a5a2`, wiring `2f896ffe…78eb`) is byte-identical before and after.
2. **Contact views (done).** `HullWaterStations` in `sea-physics/hullWater.ts` (additive) exposes two chine stations per strip, read off the contact's own patch after the step.
   - Burial: `depth`, `rate` (immersion change per tick, ±20 m/s clamp, 0 after `reset()`), `worldX/Z`, `sliceZ`, `sliceHalfWidth`. It is structurally a `HullBurialInput` and feeds `flowFoam.setHullBurial`.
   - Waterline: `stations` + `waterlineY` (body-frame y where the patch surface meets the hull's vertical line) feed `wetline.updateFromHullContact`. It is the pressure waterline, within 1 cm of the clipped contact waterline at rest.
   - `frame.snap()` resets it (V108). Assumption: the GLB's local frame is the physics body frame (origin at the CG), as the hero's placement already requires.
3. **§V95 sea sequence (done).** `core/seaFrame.ts` holds the runs both entries share. Raft bit-identity across the extraction (`zzScratchSeaFrameHash`: 120 ticks, 61 frames, real mirror, buoyancy and HullContact, recording proxies for the GPU side): sim `3b9238a2…74a6` and wiring `0640d9ee…8dfc` (2723 calls) are identical before and after. A foam/caustics order swap changes the wiring hash, so the harness is live. The pirate page (`main.ts`, user WIP) still builds and drives its sea inline.
4. **Params (done).** `params/speedboatSea.ts registerSpeedboatSeaParams(hull, restCgY)` registers `sea-physics-speedboat` (panel ranges for draft, Smith scale, cadence, iterations). Panel moves reach the rivals on the same tick, through the per-tick params snapshot.
5. **`src/sim-worker`:** multi-tick kick (done, above). Still open: seabed/fetch for islands (sim-worker.md blockers 1–2) before T187 puts sites under the rivals.
6. **Wake tier (done, docs/wake/w5c-speedboat-tier.md).** The page uses `WAKE_SPEEDBOAT_TIER`, 256² × 1.75 m = 448 m, with 304 m astern of the stem.
   - The rule is `wakeTierForSpeed`: at high Froude the domain is sized for reach astern, not 2.4·λ_T (λ_T is 1025 m at 40 m/s).
   - Same grid and 35 dispatches in one group as the ship tier.
   - Arm 3.55° measured against a 3.37° Havelock prediction for the texel-smoothed forcing (Rabaud–Moisy 3.10°). Energy ahead of the bow is 5.7e-5 of the wedge.
   - Cost: the near-hull sim surface only resolves waves of about 3.5 m and up. Browser GPU ms still pending.
   - Only the player's samples feed `wakeSim`; multi-boat wake is T170.
7. **Audio (T183 hooks, docs/speedboat/audio.md).** Done on the page: `contact.driveAdvance`/`driveImmersion` (zero-copy from `player.hw`); the frame's `slamImpulse` summed over its ticks and reset after `audio.update` (the crash hook keeps a per-tick contact); NPC `contact(i)`/`throttle(i)` passed as `npcContact`/`npcThrottle`; `BoatAudioFrame.governor` from `controls.settings.governor`.
   - Open for the audio owner: `pageSink.playerTelemetry` does not forward `governor` yet (one field: `governor: f.governor`).
   - Open, no source: `wakeCrossing`. The sim wake is GPU-only (`flowFoam.wakeHeightCpu` reads 0 on the sim backend, §V8 amendment). Needs a CPU wake field or an async readback of the solver's state texture near the hull (T170).

## §T.191 race slice

| File | Role |
|---|---|
| `page/course.ts` `towerReachCourse()` | Two-phase hook: `sites` before `buildSea`; `attach(sea)` builds the Tower Reach world from the archipelago's heightmaps + seabed, bakes the worker world data (`sim-worker/worldData`), re-points the page mirror at the SAME seabed grid the workers read, and returns colliders + the physics bed (`raceBed`, bars pass through). `seaPreset` = `calm` (course sea; boat select applies Calm/Breeze/Working sea/Squall on start). |
| `page/raceSession.ts` | The fixed-tick race: `tick` = controls → collide → player physics → crash → race → outputs. Crash machines for all 8 racers and `Race` run `RACE_DELAY_TICKS` (8) behind the page; see below. |
| `page/npcFleet.ts` | + pilot, contacts, world data, the player as external fleet boat 7 (per-row pose), per-row contact-off mask and AI IN, tick-exact queued resets (`queueReset`), trace ring (`trace(tick, i, TR.*)`). |
| `page/autopilot.ts` | The rivals' `RacePilot` behind `ControlSource` for the player (`?autopilot`, smoke race). |
| `page/raceUi.ts`, `raceRadio.ts`, `raceSettings.ts`, `liveries.ts`, `raceHudFrame.ts` | HUD + select/pause/results, radio calls from race + crash events, settings persisted in `localStorage['speedboat.settings.v1']` (guarded), the paint-id join onto `assets/livery.ts` FLEET_LIVERIES (all eight rows live there since §T.197), the per-frame HUD input. |
| `page/pilotRig.ts`, `page/paceBoat.ts` | Pilots seated in every hull (head hidden in cockpit cam), the marshal pace boat from `RaceState.paceBoat`. |

Identity: racerId 0 = player = fleet index 7 (external, never stepped); racerId k ≥ 1 = NPC k − 1 = ui/roster `RIVALS[k − 1]` (archetype `RIVAL_ARCHETYPES[k − 1]`, community paint, number). Grid order: rivals 1..7, player last. `RaceState.lapTimes` is in grid order; raceUi remaps it by racerId.

**Why the race runs 8 ticks behind the page (§V2).** Rivals come home late (pipelined worker). At page tick p the race steps tick r = p − 7 from the player's recorded trace row r and the rivals' trace row r; its outputs (input cut, rolling-start cap, ghosts, standings → AI IN, respawns) act from tick p + 1 on both sides; a respawn lands on the player and the rival at the same tick and the race is fed the respawn point for the in-between ticks. The player collides against each rival's trace pose at r extrapolated to the tick start. The loop holds (`session.holdSim`) when the worker trails more than D − MAX_SUBSTEPS ticks: a hitch, never a desync. Cost: race outputs act 117 ms after the tick they describe; collisions are immediate. Evidence: tests/speedboatRaceSmoke.test.ts (same hash at 60 fps pacing and 3-tick/20 fps pacing with holds).

**Order deviation from the brief:** collide runs before physics (controls → collide → physics), as `BoatSimCore.step` does, so the player's step is the rivals' step (§V110).

**Course joins (page/course.ts), each found by a test:**
- Handedness (§T.197): src/race now judges in src/circuit's physical frame (race/types.ts), so Race and the HUD read the authored course. Only the rival pilots get `aiHandedCourse` (poles swapped, keepOn flipped — the §T.191 course, unchanged for them) because src/race/ai still reads mark sides mirrored (race/ai/line.ts `corridorsOf` L95–L110; race/ai owner). `CourseWorld.aiCourse` → `buildPilotSetup`.
- `clearPaceLine`: the authored pace line runs through the lee chicane, rocks and Main Street roofs; the race gets a straight line back from the start gate along the course direction, clear for the grid (±7 m, 8 m margin, 2 m of water). Since §T.197 race/rollingStart keeps every grid slot ON the pace line (pace boat starts `gridDepth` = 135 m along it), so the line simply starts `GRID_TAIL` (40 m) inside the last clear sample; no backwards extension. Tower Reach: ~5 s of pacing (same positions and green as §T.191).
- `rockColliders`: the island rock scatter becomes vertical capsules (player + workers), except rocks intruding the ±14 m course corridor (Tower Reach: 4 in the browser, 37 in the headless replica — most float at the waterline over 7–14 m of water on Bar Head / Main Street; island kit owner).
- `respawnClear`: respawn points need 3 m of water and 10 m from any solid. tests/speedboatCourseClearance.test.ts covers grid, pace line, racing line and respawn candidates.
- Formation: boat↔boat contacts are off until green (the pilot has no grid-slot hold; the columns converge and rolled boats over). Statics and bed still collide.
- Spawn/respawn height: the pressure head at the current time. Drive trim reaches the physics (`unitTrimToRad`, one mapping for player and rivals); rpm from `HullWater.driveRpm` (HUD, drive rig, audio `contact.driveRpm`; rivals via trace `TR.RPM`).
- Liveries: eight one-colour boats, pairwise CIEDE2000 ≥ 25, no sea lookalikes (tests/speedboatLiveries.test.ts).

**Crash kinds:** seams.ts `CrashKind` is now the crash module's (`hook | stuff | blowOver | barrelRoll | impact`); off-course belongs to the race logic.

Open (per owner): Surge `thrustMultiplier` has no physics input (HullWater throttle clamps at 1) — T189/T196; community pattern paints render as a band (asset mask, T192). Closed by §T.197: radio bus, pilot visible, rooster tail emits (props pierce at full throttle with the in-tree physics), roof capsules are in the page collider list (collision work → T198).

## §T.197 polish

- **Pilot not visible — two root causes, both in `page/pilotRig.ts`.** (1) The NPC skin variants `M_PilotSkin@npc_b/c` are referenced by no mesh, so `parser.getDependencies('material')` built them (and their KTX2 textures) AFTER `ktx2.dispose()` had killed the transcoder workers: the promise never settled, `createPilots` hung with no warning, every boat kept the inert pilot. Now built inside `loadPilotGltf` while the loader lives; anisotropy is applied over every material, variants included. (2) The scrubbed clips were made additive with three's `makeClipAdditive` against `seated_base`, which keys only `pelvis`; three leaves every other track ABSOLUTE, so additive blending applied each bone's rest rotation twice and the pilot folded under the seat back (cam_eye 0.14 m above the pan instead of 0.77 m). `makeClipAdditiveToRest` references every track to the rest pose (= clip frame 0) and transforms the cubic-spline tangents too. Not the cause (checked): SkeletonUtils clone (already used), frustum culling (off), LOD (0/1/2 switch as expected), scale (metres), socket parenting (0, 0.431, 0.234 on the boat LOD). Head: collapses only in cockpit (`onCockpitChange`), and the state is re-applied when the pilot finishes loading. Evidence: headless Chrome (WebGPU) cam_eye 0.765 m above the pan; tests/speedboatPilotRig.test.ts (real GLB: posed eye ≤ 2 cm from the seated bind, naive conversion > 20 cm; loader order).
- **Drive rig rest pose (`assets/driveRig.ts`).** Animated nodes keep their glTF TRS as `rest` (composed before `matrixAutoUpdate` goes off); `node.matrix = Trim · Steer · rest`, props `= follow · Spin · rest`. The current hero GLB keeps those nodes at identity, so this was latent, not the "engines out of water" report (at rest the lower units are in the water; at 21 m/s the physics carries them clear — T196). tests/assetPipelineDriveRig.test.ts uses non-identity rests (fails on the old code).
- **Liveries.** `assets/livery.ts` FLEET_LIVERIES = the eight grid boats (hero signal orange + seven one-colour community paints); STYLE-SPEC's rendered rivals moved to `CONCEPT_LIVERIES`. `page/liveries.ts` only joins roster `liveryKey` → row, failing loud on a missing key.
- **Radio bus.** `audio/boat/radioBus.ts`: one gain node for radio, level = Master × Race radio (pause screen, persisted); a squelch burst per new radio line. Radio text is still not voiced.
- **Race output latency.** The rolling-start cap is a pure function of race time, so `raceSession` evaluates it (`rollingCapAt`) for the tick it acts on, for the player's throttle and every rival's recorded AI IN `GO` on the same tick index: deterministic (§V2) and symmetric; the grid hold and the green release no longer lag 8 ticks (tests/speedboatRaceLatency.test.ts, fails on the lagged cap). PROPOSED, not built: (a) crash input cut at tick latency needs every crash machine off the lag — the rivals' would move into the worker step core (sim-worker owner) and the respawn point would have to come from a non-lagged query; a player-only early cut is asymmetric and its fade outruns the lagged respawn point; (b) Surge fire could apply at press time against the lagged meter (no earn latency issue), but `thrustMultiplier` has no physics input yet, so there is nothing to speed up.
- **Every boat marks the water (§T.195 wiring).** `speedboatScene` builds `createVesselFx` (replaces the rooster tail); `tickBoat` calls `vesselFx.tick(renderer, { hw, state: boat, bowAhead: stemZ + 120 }, npcs.fleet, dt, camera.position)` in place of setPropWash / wakeSim.tick / rooster update; the spray toggle calls `vesselFx.setVisible`.

## Free roam (`speedboat.html?mode=free`)

A sandbox on the race map: Tower Reach, its furniture, sea, wakes, spray and player audio, with no rivals and no race. `page/sessionMode.ts` holds the mode (`SessionMode = 'race' | 'free'`, `sessionModeFrom`, `sessionModeHref`) and the pieces it swaps in.

- **No rivals, no worker.** `createIdleNpcFleet()` replaces `createNpcFleetDriver` (0 boats, no pump, `collectedTick` follows the recorded tick so `holdSim` never holds); `buildSpeedboatBoats` builds 0 NPC hulls; `?autopilot` is race-only. `buildPilotSetup` still runs once at boot (not per frame).
- **No race.** `createRaceSession({ freeRoam })`: `start` places the player at `freeSpawnPose` (the clear pace line's first point, pointed along it, moved to the nearest `respawnClear` water if blocked) and never builds a `Race` (no rolling start, lights, gates, laps, penalties, results, radio). The player's crash machine still runs on the same D-tick trace; its outputs (input cut, ghost) act directly; a crash or Hold R lands at `nearestClearWater` from where she is, at rest.
- **HUD.** `RaceHud.setFreeRoam` → one `.sbh.is-free` rule keeps only the `speed` and `trim` panels (position, standings, timer, radio, sea, surge, plotter, gate/pace/start markers, tower lamps, toasts, finish and the race lines of the crash overlay are hidden); raceUi feeds the instruments from a player-only state and skips the radio.
- **Pause.** No Restart / Boat select; a Sea row (Calm · Breeze · Working sea · Squall, applied live, remembered); Mode row (both modes) reloads into the other mode keeping other query params; Quit goes to the race's boat select. Rows are 33 u + 2 u so the race pause's 13 rows clear the hints.
- **View keys are pirate/raft's.** `pageChrome` now runs `ui/viewModes.ts reduceView`: Tab/F1 dev overlays, **P/F2 photo mode (no HUD — the cinematic toggle)**, Esc peels photo mode before pausing, full screen parks the dev overlays. Graphics row = the shared `initGraphicsSettings` store.
- **Cameras.** V cycles near/chase/far/cockpit. raceCam has no free-fly/orbit mode (only the crash orbit): follow-up, not built.
- Evidence: tests/speedboatFreeRoam.test.ts; headless check (`?mode=free`): 0 NPC boats, `session.race` null, 44 kn under W, only speed + trim displayed, P hides the HUD.
