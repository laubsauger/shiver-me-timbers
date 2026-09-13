# Speedboat page (§T.181 S0): skeleton, loop, seams

Status: the page boots end to end on open sea. The player runs `rigid6` + `HullWater`, 7 NPCs run through `src/sim-worker`, the wake runs on the sim backend, and a chase camera and a knots HUD are wired. Every later task plugs into a seam in `src/speedboat/page/seams.ts` and swaps one constructor line in `src/main-speedboat.ts`.

## Files

| File | Role |
|---|---|
| `speedboat.html` | Splash (`__bootProgress` / `__bootReady`). The COI shim `coi-register.js` loads before the module. |
| `vite.config.ts` | `speedboat: 'speedboat.html'` input entry |
| `src/main-speedboat.ts` | Boot and loop order only (≤ 300 lines) |
| `src/speedboat/page/seams.ts` | The integration interfaces (below) |
| `src/speedboat/page/speedboatScene.ts` | `buildSea` (sim wake, course sites, speedboat sea params), GLB hero + NPC instances, rooster tail |
| `src/speedboat/page/speedboatFrame.ts` | `tickSea` / `tickBoat` (fixed tick), `renderSea` / `renderBoats` (frame) |
| `src/speedboat/page/playerBoat.ts` | Player physics: the same step `BoatSimCore` runs per boat |
| `src/speedboat/page/npcFleet.ts` | Pipelined kick/collect driver over `createNpcFleet` |
| `src/speedboat/page/seaParams.ts` | Speedboat `SeaPhysicsParams`, shared by the page mirror and the fleet (Smith depth = deep-V draft) |
| `src/speedboat/page/course.ts` | Open-sea `CourseHook` stub, grid spawns |
| `src/speedboat/page/controls.ts` | Keyboard `ControlSource` stub |
| `src/speedboat/page/stubs.ts` | Chase camera, silent audio + unlock, no-crash hook, knots HUD |
| `tests/speedboatIsolation.test.ts` | §V109 transitive walk (entry + all of `src/speedboat/`) |
| `tests/speedboatPageStructure.test.ts` | Boot order, physics in the tick, worker selection and pipelining, wake on the sim pose, steer sign |

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

- `pump()` runs at the end of each tick and at the end of each frame. If the kick is home, it collects. If the fleet trails the page tick, it writes controls and kicks the next tick. At most one tick is in flight.
- NPC tick k is kicked with page tick k's exact `SimState.time`, held in a 128-tick ring. The result is therefore a function of tick index. Tested: a fleet pumped every third tick catches up to the same OUT hash.
- **Residue:** the ocean/sea params are the live objects at kick time.
- **Known limit:** the fleet advances at most about 2 ticks per rendered frame, one per pump. Below about 30 fps it drifts behind. Past 128 ticks it drops ticks, counts them and warns once.
  - Seen in a hidden tab, where catch-up frames run 5 ticks: lag reached 42.
  - The fix belongs in `src/sim-worker`: a kick that steps N ticks. Alternatively, the loop owner can await `fleet.done()` inside catch-up frames.

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

## Hooks needed from other owners (not done here)

1. **`src/core/seaScene.ts`:** `SeaOptions` needs `propJets?: number` passed to `createFlowFoam({ …, propJets })`.
   - Where: option near `:57`, call at `:68`.
   - Until then the sim foam compiles for 0 jets and `flowFoam.setPropWash` does nothing.
   - The jets still reach the wake solve through `wakeSim.tick`.
2. **`src/sea-physics/hullWater.ts`:** needs a `HullBurialInput` view (heave/pitch burial rates) for `flowFoam.setHullBurial` (passed `null` today). It also needs a per-station waterline for `wetline.updateFromContacts` (the wetline dries today).
3. **`src/core` §V95:** `renderSea` repeats `raft/raftFrame.renderSea`'s sea sequence. tech-research §8 S0 planned a `core/seaFrame.ts renderSeaCommon`; extracting it touches `src/raft`.
4. **`src/params`:** `speedboatSeaParams` belongs in `src/params/speedboat.ts`.
5. **`src/sim-worker`:** a multi-tick kick (see Known limit above), and seabed/fetch for islands (sim-worker.md blockers 1–2) before T187 puts sites under the rivals.
6. **Wake:** `WAKE_SHIP_TIER` (160 m) is sized for ≤ 10 m/s ships. At 40 m/s the transverse wavelength is far larger than the domain. Only the player's samples go to `wakeSim`; multi-boat wake is T170.
