# Speedboat collisions, crashes, respawn (§T.188 S6)

Code: `src/sea-physics/boatCollide.ts`, `src/speedboat/crash/` (sensors, detect, machine, damage, teleport).
Additive: `applyRigid6Impulse` in `src/sea-physics/rigidBody.ts`; collision hook in `src/sim-worker/*`.
Tests: `tests/boatCollide.test.ts`, `tests/boatCollideWorker.test.ts`, `tests/speedboatCrash.test.ts`.
Design inputs: tech-research §4 (respawn point superseded: on the racing line behind the crash), design doc §3.

## Per-tick order (every boat, player and NPC alike)

```
1  snapshot poses of all boats (the sim-worker WORLD region, or the page's own copy for the player)
2  collideBoatWithFleet(i, …)      boat↔boat, impulses from the snapshot, this boat's share only
3  collideBoatWithWorld(i, …)      static colliders, then the bed (seabed/terrain height)
4  setControls × crash.out.{steerScale, throttleScale}; samplePatch; stepRigid6
5  measureCrashSensors → stepCrashMachine → events, damage, ghost flag, teleport
```

## Collision model

- **Proxy.** Five capsules along the keel built from the hull proxy's own vertices (`buildCollisionHull`): per z-bin,
  radius = max half-beam + 0.10 m (render flare + rub rail) or half the depth if larger, axis at mid-depth; the
  chain's ends pulled in so the caps end at the gearcases aft and the stem forward. Radii 1.25 / 1.25 / 1.25 / 1.14 /
  0.57 m. 22 bed points: keel and both chines per bin, deck corners at the transom and amidships, the stem, the three
  gearcases.
- **Boat↔boat.** Conservative advancement per capsule pair on linearly moving endpoints (`p + v·t + e + t·ω×e`), bound =
  largest endpoint relative speed (exact for every point pair, so no tunnelling at any speed). Earliest time of impact
  wins; the response is a Catto impulse at that point with the full inverse inertia, restitution 0.25, Coulomb friction
  0.3. The pair is re-swept with the new velocities up to 4 sub-contacts (touching-but-separating capsule pairs are
  skipped), so a boat sliding along another meets each capsule at its own time of impact.
- **Why tick-level, from the snapshot.** A worker shard only sees other boats through the frozen WORLD snapshot. With
  the lower index always "A", both shards compute the same pair bit for bit and apply ±J: momentum is conserved to
  round-off and the result is independent of the worker layout (§V2). Several contacts on one boat are Jacobi (all from
  the snapshot). Velocities change at the tick start through `applyRigid6Impulse` (rigid mass/inertia, velocities only;
  rigid6 still integrates pose, V100). Contacts do not depend on the substep count, so §V107 holds trivially. Cost of
  the choice: a boat bounces up to `closingSpeed·t_c` early (≤ 0.75 m at a 45 m/s head-on, ≈ 5 cm at a 3 m/s rub).
- **Static colliders** (`StaticCollider {a, b, radius, flexible?, id?}`, packed by `prepareStaticWorld`): the same sweep
  against an infinite-mass capsule, restitution 0.1, friction 0.5. A `flexible` gate pole pushes nothing and takes 10%
  of the speed once per contact episode (GDD §3).
- **Bed** (`BedHeight = (x, z) => y`, e.g. `SeabedField.heightAt`): each point's path over the tick sampled at 3
  positions; normal from the central-difference gradient (±0.5 m); speculative contacts (a point may close the gap it
  has this tick, never more), restitution 0.1 when touching, Baumgarte 0.2 beyond 2 cm capped at 2 m/s, Coulomb 0.5,
  4 Gauss–Seidel iterations. A coarse skip samples the bed under the hull axis at the tick's start and end first.
  `grounding.ts` is not used: vertical spring + planar friction, yaw-free by contract (§B.6).
- **V110 (tech-research numbering: bounded at result).** One scale on the whole response of a pair (both boats) or of
  the world solve so |Δv|/dt ≤ 150 g and |Δω|/dt ≤ 600 rad/s². A capped contact continues next tick.
- **Known behaviour.** A 50° ramp is climbed like a boat ramp (the normal tilts the response up); a ≥ 70° face turns the
  boat along it. At 100 m/s closing a spinning glancing pair can overlap ≈ 0.75 m for a tick (7 in 1000), with no
  pass-through; at 45 m/s the worst overlap in 1000 randomized head-ons is < 10 cm.

## Crash thresholds (`CRASH_THRESHOLDS`, all on the same tick unless noted)

| kind | condition | measured against |
|---|---|---|
| hook | slip ≥ 35° ∧ \|yaw rate\| ≥ 1.0 rad/s ∧ \|heel\| ≥ 20° ∧ ground speed ≥ 15 m/s | chine catch at full lock: C_v 5 slip 39°/1.26 rad/s/heel 32°, C_v 8 38°/1.50/25°; half lock C_v 3–6 ≤ 17°/0.53; C_v 3 full lock is a 12 m/s stumble |
| stuff | bow immersion ≥ 0.4 m ∧ decel over 0.1 s ≥ 1.5 g ∧ speed 0.1 s earlier ≥ 12 m/s | 30 m/s bow-down entry: 0.77 m / 1.4 g at 0.25 s then pitchpoles; clean sea: 1.7 m once at < 1.5 g |
| blowOver | airborne (wetted area < 0.5 m²) ∧ bow-up pitch ≥ 35° (GDD), or pitch ≥ 75° any time | clean jumps ≤ 26° |
| barrelRoll | \|heel\| ≥ 110° ∨ tilt ≥ 110° | clean sea tilt ≤ 44° |
| impact | one collision \|Δv\| ≥ 8 m/s (not a flexible pole) | tech-research §4.1 |

Priority when several hold: impact, barrelRoll, blowOver, stuff, hook. Angles are total over SO(3):
heel = atan2(right·Ŷ, up·Ŷ), pitch = asin(fwd·Ŷ), tilt = acos(up·Ŷ).

Latency (tests, real physics, onset measured independently): hook ≤ 0.5 s of heel/slip > 45°; stuff ≤ 0.5 s after the
foredeck goes under above 12 m/s; blow-over ≤ 0.5 s of bow-up > 45° airborne; barrel roll ≤ 0.5 s of tilt > 90°;
impact on the contact tick. No detection in 60 s of Working sea (seed 188) with assists Default at throttle 0.6.

## State machine (`stepCrashMachine`, phases match `RacerStanding.state`)

```
racing ──detect──▶ crashed         input cut; 1.5 s engine stall starts; damage by kind
crashed ──after ≥ 1.0 s: tilt ≤ 30°, speed ≤ 8 m/s, |ω| ≤ 1 rad/s, wet, held 0.5 s──▶ racing   (recovered)
crashed ──autoReset: tilt ≥ 110° for 1.2 s | bow under 0.4 m for 1.0 s | |Δv| ≥ 20 kn shown 1.2 s | 3 s──▶ respawning
racing | ghost | crashed ──reset held──▶ respawning
respawning ──0.4 s fade──▶ RespawnProvider → respawnPose → deps.teleport (V108) ──▶ ghost
ghost ──2 s and not overlapping a boat──▶ racing ;  ghost ──detect──▶ crashed
```

Outputs `machine.out`: `throttleScale`, `steerScale`, `ghost` (fleet mask; also set while fading out), `fade` (0..1).
Events: `crash {kind, impact}`, `impact {deltaV, source, other}` (≥ 2 m/s, audio/camera), `recovered`,
`respawnStart {kind}`, `teleport {pose}`, `respawnEnd`. `autoReset: false` (Pro) never teleports on its own.

## Teleport contract (`teleportBoat`, `assertTeleportFirstTick`)

Pose written element-wise; `resetRigid6Memory`, `HullWater.resetMemory`, plus caller `extra` resetters (collision
episodes `resetBoatCollideMemory`, assists `resetAssistState`, wake source history — owners outside this task).
Worker boats: `BoatFleet.place` (stepCore resets rigid6, HullWater and collision memory; the boat is contact-off for
that kick because its WORLD pose is stale). Respawn pose = level, CG at water + `restCgHeight(hull)` (0.239 m, level
hydrostatic float by bisection), velocity along the heading, ω = 0. Tested: the first evaluate after the reset
exchanges exactly 0 slam, the first tick ≤ 1e-3 N·s; without `HullWater.resetMemory` a boat dropped in slams > 100 N·s
on that evaluate; afloat within 0.5 s (|v_y| < 0.5 m/s, tilt < 5°, CG within 0.3 m).

## Damage for the render (`machine.damage`)

`zones: Float32Array(6)` 0..1, index `ZONE.*`: 0 bowPort, 1 bowStarboard, 2 sidePort, 3 sideStarboard, 4 stern,
5 cockpit; `version` bumps on change. Port = body +x (right-handed, y up, z forward: starboard is −x). Contacts add
`e/(e + 9)` with e = |Δv| − 1 m/s, saturating; crash kinds add fixed wear (stuff: bows + cockpit; barrel roll: cockpit +
sides; blow-over: stern + cockpit; hook: the low side). `damageFeatures`: scuffs > 0.05, tape peeling > 0.3 (hull),
windscreen crack > 0.3, hoop bent > 0.6 (cockpit), hatch missing > 0.5 (bow). `damageGeometryFor(hull)`: bow line at
70% of the length, stern line at 20%, cockpit above the deck.

## Hooks needed from other owners

- **Race (src/race):** the `RespawnProvider` is a thin adapter over `race/respawn.ts` `findRespawnPoint` (same yaw
  convention atan2(fwd.x, fwd.z), same speed rule as `designRespawnSpeed`): `{ x, z, heading: p.yaw, speed: p.speed }`.
  `RacerSensors.crashed = machine.phase === 'crashed'`, `respawnRequested` on the `respawnStart` event; standings
  `state` from `machine.phase`.
- **Circuit (src/circuit):** `StaticCollider[]` (gate poles `flexible: true`, pylon/tower legs, buoys, rocks as spheres)
  and a `BedHeight` (seabed/terrain) for the player; the seabed is not yet in the sim worker (stepCore has no bed).
- **Page:** player tick in the order above (own pose snapshot including NPC WORLD poses and a ghost mask); pass
  `machine.out.ghost` to `BoatFleet.setGhost`; `contacts` in `FleetOptions`; NPC crash sensors on the main thread
  (wetted area from `B.WETTED_AREA`, bow immersion from the page mirror, contact |Δv| by re-running the same collide
  calls on a scratch copy of the snapshot — deterministic, identical). The seam `CrashHook`'s kinds
  (`capsize | stuff | blowOver | structure | offCourse`) differ from this module's (`hook | stuff | blowOver |
  barrelRoll | impact`); off-course (3 s off the corridor) belongs to the race logic → `resetRequested`.
- **Physics/assists (T179/T182), found here:** Working sea, assists Default, throttle 0.8 and a ±0.1 weaving helm
  capsizes at ≈ 50 s (seed 188) and ≈ 21 s (seed 7); throttle 0.6 is clean. Without assists at 28 m/s she capsizes in
  ≈ 7 s and an inverted hull was launched 18 m into the air once — the inverted-landing slam gap in hullWater's header.

## §T.198 collisions in the live game

User playtest: "collision with rocks, buildings, any kind of obstacle is not a thing right now … as well as between
boats". The collide step was wired and live on both sides (player: `raceSession.collide`, rivals: `stepCore`); the gap
was what it was handed, and how some colliders were shaped.

**Root causes, measured in the live page** (headless Chrome WebGPU, `window.__speedboat`; scripts and logs in the T198
scratchpad `t198/`):
- **No rock colliders at all.** Tower Reach's kit islands have `rockCount: 0` (§T.194 draws its granite with
  `circuit/kitDecor.ts`), so `page/course.ts rockColliders` found 0 placements: 103 colliders (course furniture + roof
  ridges) against ~2 300 drawn granite blocks, beachrock slabs, rubble and driftwood instances. The headless harness seeded pirate rock placements (no kit hooks), so it
  tested a world with 647 rocks the page never had.
- **Rounded tops at the waterline are ramps.** §T.197's roof ridge capsule (8–15 % of a gable within a hull's reach):
  live, a 20 m/s hull rode over a gable 30 m past it, at 45 m/s it flew 6 m. A block fitted as a dome with its axis under
  the surface did the same (2–4 m).
- **Shore impacts under-reported:** the bed solve reported the largest single hull point's |Δv| (7.7 m/s for a 20 m/s
  beaching spread over a dozen points), below the 8 m/s impact threshold.
- **Rolling start:** boat↔boat contacts were fully off until green, so converging columns could overlap.

**Fixes:**
- `circuit/propColliders.ts` fits capsules to the RENDERED island instances (each InstancedMesh's vertices under its
  instance × world matrix, §V77): one capsule for a block, a row of up to 4 for a slab. Which island meshes are solid
  is a name list (`SOLID_PROP_MESHES` / `SOFT_PROP_MESHES`, plants soft); an unclassified island mesh is a console
  error. `towerReachCourse().attach` takes each island's scene `group`; the SAME list goes to the player, to the workers
  (`contacts.colliders`) and to grid / pace-line / respawn clearance. Islands without a group (headless) fall back to
  `rockColliders`.
- **The waterline is a wall.** Props: every fitted capsule ≥ 0.75 m crossing −0.6…+0.8 m also gets vertical capsules
  along its axis projection, as wide as its widest slice in that band, up to its top (≤ 2 m) (`waterlineWall`). Roofs
  (`courseColliders.ts prismCapsules`): a row of vertical capsules along the ridge (radius = the roof's half-width at
  the draft line + 0.35 m, 0.7 r apart, end ones reaching the corners, up to +0.8 m) plus the circumscribed capsule of
  the roof triangle above. Boxes (chimneys, the store, the steeple tower, the race-control hut, stake daymarks):
  capsule rows (`boxCapsules`). Everything clipped to what a hull reaches (−0.6…+6 m). Cost: near a ridge or a dome's
  top the wall stands ≤ 2 m proud of the drawn slope at deck height.
- `prepareStaticWorld` builds a 24 m xz grid (CSR); `collideBoatWithWorld` tests only the cells under the hull's reach,
  in collider index order (the scan's results), and repacks the hull chain only after an impulse. Node, 7 800 colliders:
  0.8–1.7 µs per boat per tick in open water, 22 µs beside the rock garden (the linear scan over 3 600: 1.1–2.7 ms,
  measured on a loaded machine).
- Bed report: one contact whose |Δv| is the CG's over the whole bed solve.
- Soft contacts (`collideBoatWithFleet(..., softMask)`, `BOAT_COLLIDE_DEFAULTS.softAccel` 3 g, `softBiasSpeed` 1 m/s):
  the same swept pair without restitution or friction, applied horizontally through the CG. The race session sets it
  for every racer under a rolling-start speed cap (`raceOutputs.soft`); ghosts still pass through. Workers read it as
  `F.CONTACT_SOFT_MASK` / `BATCH_ROW.CONTACT_SOFT_MASK` (batch row fixed part 3 → 4 slots).
- `page/course.ts SPAWN_CG_Y` is derived: `restCgHeight(buildDeepVHull())`, the level hydrostatic rest the grid is
  placed at (0.260 m with §T.196's hull water; was a 0.2 literal).

**Measured through the page tick with the real course colliders** (`speedboatCollisionDrive`, 20 / 45 m/s, dead aim
from open water): tall kit granite, pylon, buoy, mast, guy anchor, water tower: |Δv| 21 / 24.5 m/s (the V110 cap),
stopped, impact crash; low block (≤ 1.5 m): stopped or deflected, ≤ 1.9 m up over its footprint; a 0.4 m stone
(no wall below r 0.75 m): a kick costing 10–40 %, the hull hops 2.8 / 4.2 m; shore: bed contact,
speed halved within 0.5 s; gable: deflected along its wall (20 → 14, 38 → 20 m/s), no overlap, no ride-up; gate pole:
−10 % once; a stationary rival T-boned: |Δv| 5.6 / 12.9 m/s, shoved, the player's bow may ride over its gunwale.
Deepest hull overlap: ≤ one tick of travel. After a 45 m/s bow hit the hull can tumble and leave the water short of
the obstacle: that is the impact crash, driven by hull↔water forces on a spinning hull (§T.196), not a collider.

**Tests:** `tests/speedboatCollisionCoverage.test.ts` (every drawn solid prop instance a hull can reach: ≥ 99 % of
vertices and ≥ 90 % of drawn surface inside the page's colliders; course furniture LOD0 GLB vertices in the hull band
≥ 90 %), `tests/speedboatCollisionDrive.test.ts` (the drives above: contact, speed loss, deepest overlap, no ride-over,
impact crash), `tests/speedboatCollisions.test.ts` (§T.197 roofs now a broadside gable, no ride-up),
`tests/boatCollide.test.ts` soft formation, `tests/boatCollideWorker.test.ts` soft mask main ≡ sab×2 ≡ transfer×2.
Shared fixture: `tests/speedboatCollisionWorld.ts` (kit decor built as island.ts does, handed to the page's attach).

**Open (other owners):**
- `tests/speedboatRaceHarness.ts` / `speedboatCourseClearance.test.ts` still build colliders from pirate rock
  placements, not the drawn kit props (the live page's pace line and respawn clearance use the live list).
- Live, after green, rivals hit Main Street roof walls 47–58 m off the reference line (worker trace CONTACT_SOLID
  |Δv| 14–22 m/s, one rival rolled to 128° there): the rivals' line leaves the ±14 m corridor there (race/ai). Before this task
  they drove through those roofs.
- `tests/speedboatPageStructure.test.ts` pins the settled trimmed rest to a 0.197 literal; it should read the physics
  (T196's measured value), not a number.
