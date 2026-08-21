# R2 walk review — `preview.html?ship=raft&fp=1`, HEAD dd233c3 (+ the two R1 snapshot tweaks)

Captured 2026-08-21 from the same snapshot/server as R1. Hidden tab, so pointer lock was
impossible: the walker was driven directly — `KeyboardEvent`s dispatched on `window`
(W / Ctrl / E / Space go through the real `attachPlayerKeys` path) and `state.yaw/pitch` written
on `__preview.walk.player.state` for looking (the `LookAccumulator` only feeds from pointer-lock
mouse deltas). Everything else (deck field, crouch, overboard, swim, boarding, interact) is the
real `createPlayer` step. Stills are 1920×1080 output-RT readbacks; `walk.gif` is 436 frames
(every 24th sim frame, 12 fps, 640×360) of the second, successful route.

Files: `walk.gif`, `tiller.png`, `strip.png`, `cabin.png`, `swim.png`, `lookout.png`,
`lookout-aft.png`, `hands.png`.

## Route and what happened

1. **Spawn at tiller** (`?fp=1`, default station) — feet (0, 0.27, −5.9) on the bare stern logs,
   eye 1.87 m, facing the bow. `tiller.png`: the view is the cabin's aft wall 1.5 m away and the
   mizzen sail filling the right half. No deck, no horizon.
2. **Tiller → starboard strip: STUCK, three ways.** (a) straight to starboard: blocked at x 1.23
   by the rain drum (x 1.25-1.83, z −4.93..−4.35). (b) round the drum at x 2.1: blocked at
   z −4.96 (nothing visible there — suspect the drum's solid cell is wider than the mesh).
   (c) up the outer log at x 2.3: climbs onto the deck (y 0.27 → 0.63) but is then blocked at
   **z −4.15 across the whole strip (x 1.9..2.3)** — the kitchen box (x 1.3-1.9, z −4.1..−3.5)
   plus the crossbeam-0 cell leave no passable gap between box and foot-rail. Space (jump) does
   nothing aboard. **The stern is an island: a tiller spawn cannot reach the rest of the raft.**
3. Re-spawned at the bow (`&station=bow`, feet (0, 0.16, 6.35) on the log tip). Bow tip →
   fore deck → starboard strip: fine, 0.27 → 0.63 step taken without a hitch. `strip.png`
   (eye 2.23 m, looking at the cabin): the eye is ABOVE the cabin eave — the roof is a plank
   texture from here, and the cabin interior is black.
4. **Doorway → cabin: works, auto-crouch fires.** Entering at z −2.7 (the starboard doorway is
   z −3.4..−2.0) the floor steps up 0.63 → 0.93 and `crouch` flips true: eye 2.23 → 1.93, i.e.
   1.0 m above the cabin floor under a 2.08 m eave. `cabin.png`: dark olive quilted weave on
   every wall and the floor, ceiling pure black (no thatch underside), nothing inside except the
   crate in the corner. Walked to the mat (−0.6, −1.9) and back out; crouch released at the
   door (eye back to 2.23). No clipping through walls.
5. **Starboard edge → swim: BLOCKED at the foot-rail.** Walking off the strip at z −2.7 stops at
   x 2.43 (the rail at x 2.36-2.51 is solid, and so is the deck edge behind it). Off the bow
   side at z 3.2 (no rail there) it works: `frame` → `swim`, feet to −1.35, eye 0.25 above
   the water. `swim.png` (eye 0.25, looking at the hull): log ends are huge faceted discs, the
   underside of every log is black, the foot-rail and crossbeams are black slabs.
6. **Swim → foot-rail → re-board: NEVER.** Swam to (3.0, −3.3) then pushed in to 0.17 m from the
   gangway-starboard socket, and to the bow log tip: still `swim`. Cause is in
   `playerStep.stepSwim`: a boarding point is accepted only if `|bp.y − feet.y| ≤
   boardVertical` (1.5 m) — the swimmer's feet are at −1.35 and the rail points are at +0.44, a
   1.8 m gap, so no boarding point ever qualifies. E does nothing in swim. For the rest of the
   route the walker was **teleported** to (2.3, 0.63, −3.3) (noted here, not in the GIF).
7. **Strip → mast ladder: blocked at z 0.18** (bipod leg foot + the ladder's own solid cell span
   the strip at z 0.5-0.7). The ladder socket itself is at x 2.69, outboard of the foot-rail.
8. **E at the ladder: nothing.** `attachFirstPerson` builds `createPlayer` without a
   `socketWorld`, so `interact` is inert in the preview — no station, no ladder, no lookout.
   `lookout.png` / `lookout-aft.png` were taken by pinning the state to the lookout socket
   (0, 9.14, 0.6) each frame: forward is 100 % topsail cloth (eye 10.74 is inside the topsail's
   9.46-11.23 span), aft shows the flag and the yard. Not a usable perch.
9. **Hands: missing in every frame**, at fov 45, at fov 75, and with `near` dropped to 0.05
   (`hands.png`). `createHands()` returns a 2-mitt group and `walk.update` parents it to the
   camera, but `preview.ts` never adds the camera to the scene (`scene.add(camera)`), so the
   camera's children are not rendered. Not checked in the main game.

## What worked
- Walking on the deck field: speed, step-up onto the deck, heightfield on the fore deck and strip.
- Auto-crouch with hysteresis at the cabin door, in both directions.
- Going overboard where there is no rail (bow quarters), swim frame, eye at the water line.
- No wall clipping, no fall-through, no NaNs; `__cap.errors` empty; console clean.

## What didn't (for the owner, in priority order)
1. Re-boarding is impossible (boardVertical 1.5 < 1.8 m feet-to-rail gap).
2. Tiller spawn is walled in (rain drum + kitchen box + crossbeam-0 cells).
3. The starboard strip dead-ends at the bipod/ladder cell; the ladder socket is outboard.
4. No interact in the preview (no `socketWorld`) — ladder/lookout/tiller stations untestable here.
5. Hands never render in the preview (camera not in scene).
6. Lookout eye height sits inside the topsail.
7. Preview camera fov 45 / near 0.5 would clip the hands even if they rendered (hands at z −0.45).
