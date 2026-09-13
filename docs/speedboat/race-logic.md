# Race logic (§T.184)

Pure TypeScript in `src/race/` (not `src/race/ai/`, which is §T.186). No DOM, no three.js, no clocks or randomness: time is `tick · dt` (§V2). Contract shapes live in `src/race/types.ts`.

## Modules

| File | What |
|---|---|
| `race.ts` | `Race` orchestrator: `new Race({ course, racerIds, dt?, params?, isClear? })`, `step(sensors) → { events, state, outputs }`, `retire(id)`, `gridSlot(id, simTime)`, `schedule`, `simTime` |
| `sensors.ts` | `RacerSensors`, the per-tick input for one racer |
| `events.ts` | `RaceEvent` union, emitted in order per tick |
| `gates.ts` | swept `segmentCrossesPoles` / `gateCrossing`, `markRoundingPoles` (a turn mark as a virtual gate on its rounding bearing) |
| `progress.ts` | `CourseLine` (reference line, origin at the start gate) and `ProgressTracker` (windowed projection, continuity cost, hysteresis, wrong way) |
| `standings.ts` | `rankRacers`, `CheckpointTimes`, `gapSeconds` |
| `rollingStart.ts` | pace boat schedule, grid slots, lamps |
| `surge.ts` | `SurgeMeter`: earned-only boost |
| `respawn.ts` | `findRespawnPoint` on the line behind the crash |
| `params.ts` | `raceParams` defaults. Anything the design doc doesn't give a number for is marked *tuning* |

## Rules chosen

- **Crossing:** the segment between consecutive substep positions starts strictly before the gate line and ends on or after it, between the poles. The crossing time is interpolated inside the substep.
- **Mark rounding:** the boat's bearing around the mark sweeps past the rounding bearing, which points to the outside of the turn, in the sense `keepOn` requires, between `radius` and `markCaptureRange`.
- **Missed element:** +5 s (design doc §3), and the racer is not sent back. A miss is called when progress runs `missDistance` past the element, or when one of the next `missLookahead` elements is passed first. Jump start: +5 s. Live positions ignore penalties; results classify by laps, then finish time + penalties. Not implemented: "two missed in a chicane → back to the last gate".
- **Positions:** DNF last, then elements done (laps included), then classified time (both finished) or progress, then previous order, then grid index.
- **Gap:** time at the latest common 10 m checkpoint, minus the leader's time there.
- **Finish:** a racer finishes on completing `laps`, or on the first line crossing after the winner has finished (so lapped boats finish a lap down). Unfinished racers are DNF `dnfAfterWinnerSeconds` after the winner, or on `retire()`.
- **Laps:** timed from green. Lap 1 includes the run from the grid to the line.
- **Surge:** +⅓ segment per clean landing (≥ 0.6 s air, pitch −2…+7°, |roll| < 10°, slam ≤ `cleanSlamMax` g over 0.1 s), per wake jump (one award per jump), and per clean exposed gate-to-gate sector. A crash, penalty, hard slam or respawn voids the open sector. The meter caps at 3. Firing takes one whole segment for 3 s of `thrustMultiplier` ≈ (90/80)², with no stacking and no overheat.
- **Respawn:** the origin is the crash onset's progress. It stays pending until a respawn, or until `crashRecoverSeconds` pass with no crash. Candidates start 60 m back and step back 10 m at a time, up to 240 m, until one is ≥ 40 m from every boat and `isClear(x, z)` accepts it. If none qualifies, the first candidate is used with `clear: false`. Heading follows the line, speed is max(25 kn, 50% of pre-crash speed), and the boat is ghosted for 2 s.

## Page integration (§T.181 / §T.188)

1. At creation, place boats at `race.gridSlot(id, 0)`.
2. Every sim tick, call `step()` with one `RacerSensors` per racer, in `racerIds` order:
   - `positions`: the hull reference point after each substep;
   - `slam`: Σ `HullWater.slamImpulse` / mass / dt / g;
   - `pitch`/`roll`: relative to the local sea surface;
   - `crashed`: from the crash machine;
   - `launchedFromWake`: from the wake field;
   - `surgePressed` / `respawnRequested`: held states (the race detects the edges).
3. Apply the outputs:
   - `thrustMultiplier` on drive thrust;
   - `speedCap` on the Governor limiter (0 on the grid, pace × 1.15 while rolling, null after green);
   - `gridSlot` as the hold target for the player assist and NPCs until green;
   - `ghost` to disable boat-boat contacts.
4. On a `respawn` event, teleport the hull to `(x, z, yaw, speed)` and reset every per-location memory before the next tick. The race sets the next swept segment to start at the respawn point, so a late teleport would sweep from there.

## HUD integration (§T.185)

- `state.standings` and `state.lapTimes` are in race order, not position order: sort by `position`.
- Standing fields:
  - `lap` is the lap being run, 1-based, and 0 before the start line;
  - `lapsCompleted`, `penaltySeconds`, `wrongWay`, `surge` (fractional) and `surgeBoostRemaining` are also available;
  - `dnf` comes with `state: 'finished'`.
- `state.lights` drives the tower lamps and `state.paceBoat` the pace boat (null after green). `state.results` appears once someone finishes.
- Toasts and radio: listen for the `lights`, `gateCrossed`, `lapCompleted` (`best`), `penalty`, `wrongWay`, `surgeEarned`, `surgeFired`, `positionChanged`, `finish` and `dnf` events.

## Contract additions (`types.ts`, optional only)

- `RacerStanding`: `lapsCompleted`, `penaltySeconds`, `wrongWay`, `surgeBoostRemaining`, `dnf`.
- `RaceState`: `lights`, `paceBoat`, `results`.
- New interface: `RaceResult`.
