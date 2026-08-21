# R1-fix — §B70 / §B73 / §B75 / §B76 / §B78(harness) / §B79 / §B80 / §B81 on `preview.html?ship=raft`

Captured 2026-08-21 from the LIVE tree on `localhost:5196` (Vite dev), visible tab, extension
screenshots at 1568×704 (the `*-tod17.5` and `station-*` frames caught the window mid-resize by
another session: the render is the 1254×562 region top-left, the rest is page background — the
engine's `resize` handler fires on the next frame, nothing in the scene is affected). Frames are
the harness as shipped: `updateRig` per frame, sails SET (`?sail=furled` is the bundle), ropes
compute-solved and drawn (new, §B78/§B79), wind 11 m/s @ 0.25 rad (the raft default: before the
wind, belly leading the mast).

Files: `{beam,bow,lee,stern,top}-tod12.jpg`, `{beam,bow,lee,stern,top}-tod17.5.jpg`,
`station-tiller-tod12.jpg`, `station-cabin-tod12.jpg`, `fp-tiller-hands.jpg`,
`fp-tiller-block.jpg` (first person, hands + the stern block/thole-pins/oar at the tiller),
`flag-t0.png` / `flag-t1.png` (0.35 s apart — the fold on the ensign has moved toward the fly),
`B73-before-*-tod12.png` (the previous agent's frames before any of this),
`stern-tod12-B75-before.jpg` (before the rope wiring, rake and B81), `bow-close-tod12-B79-before.jpg`
(the inherited 69-rope square-rig plan, thick, before B79/B80), `bow-close-tod12.jpg` (final, B83).

## Defect → cause → fix → frame

| # | defect (user) | cause | fix | frame |
|---|---|---|---|---|
| B70-hang | `?ship=raft&view=beam&tod=12` blocks the main thread > 30 s | `raftSailFace.ts` `sminNode` was an inline TSL expression: 35 chained `smin` levels, each reading its predecessor through `mix(b,a,h)` AND `h` (used 3×); three's `MathNode/OperatorNode.getNodeType` has no memo, so the first type resolve walked ~4^35 nodes before any shader existed | `sminNode` is a typed `Fn(…, 'float')` — the walk stops at each level. **Measured: first HUD frame 2.6 s after navigation, 0 long tasks** (`performance.now()` polled in-page); galleon on the same server unchanged. Test: `raftMaterials.test.ts` "getNodeType … within 250 ms" | beam-tod12 |
| B70-flat | "every piece one flat ochre" | `raftMaterialNodes.createRaftPieceUniforms` hooked `onObjectUpdate` on `aabbMin` only; three runs a uniform's update only if THAT uniform is in the shader, so graphs reading `seed`/`variant` alone (crates, the face decal) were never updated | the update hangs off all six uniforms with a per-frame memo | bow-tod12 (drum, crates, weave, thatch, face) |
| B70-weave | cabin a black-and-tan checkerboard at 15 m | the 5-strand basket blocks' crowns: a vertical wall at noon is at N·L≈0, so at `weaveBump 6` one block's crowns caught the sun and the next's did not | `weaveBump 6 → 2.5`; blocks read by strand direction and the block seam, as in PHOTO-04/08 | station-tiller-tod12, fp-tiller-hands |
| B70-logs | logs cream-white | `balsaWarm 0xc6a87a` end of the per-log spread + toneVar 0.7 at noon | `balsaWarm 0xb0906c`, `balsaToneVar 0.5` → grey-brown [PHOTO-08] | stern-tod12 |
| B70-guaras | no guaras visible | `guaraDepth` measured from the log BOTTOMS put the plank top under the mats | measured from the log axis (the waterline, [§2 Size "1.5 m below raft"]); test: tops > deck + 0.3 | stern-tod12 (two blades under the stern) |
| B70-sails | "sails as vertical teardrop bundles at the mast" | two things: the beam view of a SQUARE sail before the wind is edge-on (it is a teardrop from the beam by construction — see the 1947 photo, taken from the quarter), and the previous default trim | default SET (`?sail=furled` for the bundle); yard spans x, cloth drops −y, membrane unchanged | lee/bow/stern-tod12 vs beam-tod12 |
| B73-rig | "perfectly straight masts … janky … a little forward pulled" | yards authored square, legs an exact A, stays near-taut (galleon STYLE 1.004), sheets lead AFT (square-rigger) | `yardAttitude()` seeded cock/rake/slew/offset × `shipDetailParams.irregularity` (main ≠ topsail ≠ mizzen, never level at irr 1); `legLeanJitter`; `topPoleTilt`; `mizzenSpritAngle` with the mizzen hoisted to the pole head; stays/guys at `RAFT_STANDING_SLACK 1.02`; sail pieces carry `shape.sheetLeadAft = -1` → `sailFrame.readSheetLeadSign` flips the §T85 corner pull forward (galleon untouched, sign +1) | top-tod12 (belly ahead of the yard), lee-tod12 (cocked yards) |
| B73-boards | "front boards that shape the bow are too low" | 0.35 m boards at the log tips, floating over the taper | `splashboardHeight 0.55`, inset 0.8 m onto full-round log, plus a `splashboardRun 4.5 m` side board each side outboard of the outer log | bow-tod12 |
| B73-lashings | no lashings | none authored | `lashing` kind: a rope collar on the beam + a ring on the log at every crossing the deck does not hide (outer two logs each side × 9 beams), one piece per beam; the crossing wrap at the bipod head. `lashingTurns` wide, rope material (`createLashingMaterial`) | stern-tod12, fp-tiller-block |
| B75-1 | bipod perfectly straight | no rake param | `mastRakeAft 0.11 rad` (6.3°): legs, topsail pole, crossing wrap and lookout all pivot at the step and meet at `crossingAt` | beam-tod12 |
| B75-2 | rope ladder 90° off, away from the leg | authored 0.3 m beside the leg in the leg's plane | hung on the leg, `ladderStandoff 0.1` off its surface, in the leg's frame (follows lean + rake) — first on the forward face; the final orientation is B83-2 below | lee-tod12, bow-close-tod12 |
| B75-3 | furled bundles "suggest a much larger sail" | `pieceGeometrySail.ts` bundle radius `max(0.15, drop·0.05)·1.15` — a galleon-scaled FLOOR | `furlBundleRadius(width, drop) = (area/yardLength)·0.0575`, guard 0.02; galleon courses unchanged to the mm, only the rear topgallant (drop 2.57) loses the floor (−14 %); raft topsail/mizzen rolls halve. Property test across all three ships | (`?sail=furled`) |
| B75-4 / B78 | no rigging in the harness; no hands; E inert | `preview.ts` never built the ropes; camera not in the scene (hands are its children); fov 45 / near 0.5; `attachFirstPerson` passed no `socketWorld` | ropes: the same path as `main.ts`/`raftScene.ts` (plan → `createRopes` → `applyRiggingPlan` → `renderer.compute`), `?ropes=0` to leave out; `scene.add(camera)`, `cameraParams.fov` / near 0.1 (core/app.ts); `socketWorld` try/catch like main-raft; HUD shows `[E] <station>` when `interact.focus()` is non-null | fp-tiller-hands, fp-tiller-block |
| B76 | flag "wiggles … from the tip away from the pole" | `flagMaterial.ts` carrier `ωt + k·u`: crests travel toward −u (fly → hoist) | `ωt − k·u` on the wave AND the crack; CPU mirror `flagRipplePhase`/`flagRippleGrow` in `flagDynamics.ts`; `tests/flagWave.test.ts` (velocity sign, envelope 0 at hoist, source scan of the GPU sign) | flag-t0 / flag-t1 |
| B79 | "way too many ropes" | the shared planner is a square-rigger's: 69 ropes, 36 buntlines, on three sails | `RAFT_ROPE_TABLE` (main: 2 sheets + 2 braces (+halyard, ≤2 lifts); topsail: 2 sheets; mizzen: ≤2 sheets; standing: main's 2 side guys + the line to the mizzen head + the mizzen's 2 stern stays) → **13 ropes**: stay 3, shroud 2, brace 2, sheet 6. Dedup of the planner's doubled ropes. No halyards/forestay yet — the planner has no masthead block / bow socket for them (gap, below) | beam-tod12, bow-tod12 |
| B80 | ropes as thick as the spars | planner `thickness` is a RADIUS: stays 0.05 m | `RAFT_ROPE_RADIUS`: stays/shrouds 0.015 (30 mm hemp), running 0.010; test ≤ 0.02 and < yard radius/3 | beam-tod12 vs bow-close-tod12-B79-before |
| B83-1 | "a row of uniform wooden pegs standing up out of every yard" | the robands (`pieceGeometrySail.sailTies`) are the galleon's authored 0.36 m tie, sized for a 0.2–0.3 m yard; on the raft's 6 cm bamboo yard they stood 0.26 m proud | `sailTieSpec(yardR)`: loop 1.4 radii tall on the spar axis, raft sails carry `shape.yardR`; galleon call (no yardR) returns the authored tie unchanged | top-tod12, bow-close-tod12 |
| B83-2 | ladder still flat sideways | hung on the forward face, rungs athwartships | hung on the leg's OUTBOARD face (`[legR + standoff, 0.4, 0]`, rotation π/2 about the leg axis): stringers ∥ leg, rungs ⊥ leg and ⊥ the outward normal; property test on the piece's rotation | lee-tod12, bow-close-tod12 |
| B81 | "huge gap between the long logs, water visible" | `buildLogGeometry` tapered the log (×0.82) over its WHOLE length, so neighbours opened ~0.1 m amidships on top of the 2–8 cm chink | `logTaperLength 1.6 m`: full-round trunk, taper only in the last 1.6 m before the chamfer; test: trunk full-round past the mast step, surface gap ≤ 0.08 | stern-tod12 vs stern-tod12-B75-before |

## Numbers

- Hang: > 30 s blocked → **2.6 s to first HUD frame** (navigation → `fps` in HUD), 0 `longtask` entries.
- Triangles: raft **12 024** total (lashings 1 644 after the 8→6-segment ring cut, side boards 24; every
  other kind as before) vs brigantine 45 740 (`tests/raft.test.ts` "cheaper than the brigantine" holds).
- Ropes: 69 → 13.
- Gates: `npx vitest run tests/raft.test.ts tests/raftMaterials.test.ts tests/raftVariant.test.ts
  tests/raftDeckField.test.ts tests/ship.test.ts tests/shipDetail.test.ts tests/enemyBrigantine.test.ts
  tests/shipBindingBudget.test.ts tests/bandLimitAudit.test.ts tests/flagWave.test.ts` → exit 0,
  10 files / 296 tests. `npx tsc --noEmit` → 0 errors in `src/ship|params|raft|ropes|player` and
  `tests/raft*|flag*` (the whole-repo exit is 2 from other agents' `tests/zzScratch*.test.ts` and
  `tests/audio.test.ts`, not touched here).

## Remaining gaps vs the photos (not done, in scope order)

1. **No halyards, no forestay, no flag halyard.** The shared planner only emits sheets/braces/lifts/stays
   from the sockets the blueprint has; the raft has no masthead block socket or bow anchor. The 1947
   b/w frame shows ~5 stays fanning to the masthead + a forestay to the bow. Needs two sockets on the
   blueprint and a `halyard` rule in the planner (or raft-only entries in `raftRigging.ts`).
2. **Sail belly is modest at 11 m/s** — the §T85 curve is the galleon's (`sailWindRef` 6.43 m/s);
   the photo's main is drum-full. A raft `sailWindRef` override was not added (the membrane reads
   `shipMaterialParams` globally; an override needs a per-ship param route).
3. **Furled main bundle** is law-consistent with the galleon but still reads heavy on a 5.5 m yard;
   the photo reference (replica, inspiration only) shows a slim bundle with a few ties at ~2/3 mast
   height — the yard does not lower on furl here.
4. **Cabin interior / thatch underside black** (R2 README item) — untouched, not in this task.
5. **Interact prompt in the HUD**: `interact.focus()` returned null at 0.7 m from the tiller socket
   facing it (eye 1.9 m, socket at 0.29 m, `reach`/cone in `playerParams`); the wiring is in
   (`socketWorld`, HUD line), the station was not reached in the still. `fp-tiller-block.jpg` shows
   hands + the station, without the prompt.
6. **Mizzen**: set in the harness; the 1947 b/w running frame has it NOT set — a furl per sail is a
   sim decision, not a blueprint one.
7. Frames captured at 1568×704 through the extension (the tab was visible), not the R0 1920×1080
   readback; `*-tod17.5` and `station-*` show the mid-resize crop noted above.
