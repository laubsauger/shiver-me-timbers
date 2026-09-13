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
