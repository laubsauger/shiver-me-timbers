# Speedboat page (§T.181 S0): skeleton, loop, seams

Status: the page boots end to end on open sea. The player runs `rigid6` + `HullWater`, 7 NPCs run through `src/sim-worker`, the wake runs on the sim backend, and a chase camera and a knots HUD are wired. Every later task plugs into a seam in `src/speedboat/page/seams.ts` and swaps one constructor line in `src/main-speedboat.ts`.

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
