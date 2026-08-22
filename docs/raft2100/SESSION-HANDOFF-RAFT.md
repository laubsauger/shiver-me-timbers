# Raft 2100 — session handoff (updated 2026-08-22)

SPEC.md = source of truth (§G line 5, §I raft/*, §V81–V95, §T88–T115, §B63–B79).
This file = what SPEC doesn't carry. Pirate-mode handoff stays in `docs/SESSION-HANDOFF.md`.

## What Raft 2100 is
Second game mode, same engine, one vessel (§V93): Kon-Tiki raft (1947 bones, 2100 dressing),
flooded-Sierra archipelago, first-person walker, diegetic radio → island → Alan Watts
teaching (placeholder audio, manifest-swappable). Ambient, no combat. Design doc (artifact v3):
https://claude.ai/code/artifact/9c312a95-650e-4bb8-9022-4c7cd54616d1 · Pitch deck:
https://claude.ai/code/artifact/0e9fbbe0-cd36-4005-b5d3-1f4ebc6025cf (fill amount/contact
placeholders; epigraph quote is a placeholder, not Watts). Sources:
scratchpad `raft2100*.tpl.html` (session-local; regenerate from the artifacts if lost).
Reference: `docs/raft2100/kon-tiki-reference.md`, `terrain-research.md`.

## Run
- Pirate: `npm run dev` → `/` (unchanged). `?ship=raft` swaps the player ship (T91).
- Raft mode boots into the CALM preset (`raftWorldParams.defaultPreset`; `?weather=` overrides).
- Raft mode: `/raft.html` (own bundle, `src/main-raft.ts`, boots no enemy/combat). `?tod=`, `?at=`.
  `window.__game = { state, player, raftControls, radio, clock, beach, followCam, assembly, setFp, grade }`.
- Raft lookdev harness: `/src/ship/preview.html?ship=raft&view=beam|bow|lee|stern|top&tod=12`,
  `&station=tiller|radio|bow|nest|cabin`, `&fp=1` (walk). KNOWN: hung >30 s on dd233c3 — the
  B70 fixer was diagnosing (see "in flight").
- Gates: `npx tsc --noEmit` (pre-existing red: `tests/audio.test.ts` node:fs — user WIP;
  `tests/zzScratch*` scratch), `npx vitest run`, `npx vite build` (emits index.html + raft.html).
  ALWAYS check exit codes — `| grep` masked two red commits this session (both fixed up).
- Band-limit audit (`tests/bandLimitAudit.test.ts`) is lexical: it matches the token `step(` —
  name methods `advance`; markers `@band-limited-elsewhere` must be ON the line or one above.

## Committed this session (HEAD 09f7ba1, 30+ commits)
R1 raft: T89 blueprint/params, T90 materials (+Kon-Tiki face SDF), T91 ?ship=raft + preview,
T92 raft deck field. R2: T94 FP walker, T95 stations/interact/hands/debug keys, T96 raft sailing
(guara CLR physics — spec sign was wrong, B64). R3: T98 raft.html entry, T99 Sierra archetypes
(+B67 haze fix), T100 beaching/ashore/frames, T101 LUT grade node, T109 wiring (+raftSeaParams).
Fixes: T108 moon orbit + horizon gates (B63/B65), T110 sun-road/god-ray disc width (B72).
Terrain: T111 research, T112a quick wins, T112c erosion pass stage. Lookdev sets on disk:
R0 (grade frames), R1 (pre-fix raft), R2 (walk), T108 (moon).

## 2026-08-22 session — everything queued at the last pause LANDED
Full suite 2952 pass / 24 skip, tsc clean, both entries build (HEAD b17ecf5).

T113 dedupe (§V95): shared boot glue in `src/core/boot*.ts`, quats moved
`combat/quatMath` → `src/core/quat.ts`, harness uses `src/debug/harnessHud.ts`.
main.ts -198 lines. `modeGlue.test.ts` pins it by NAME and by SHAPE (a renamed paste
fails too); `raftIsolation` now walks imports TRANSITIVELY — which found the raft still
reaches `src/combat/` via `followCam → camStations → battery/aim`. Ratcheted, not fixed.

T114 sails-through-masts: penetration was ONLY at negative drive (a backed sail bellies
aft, into the mast). Push is one field per panel, not radial (radial tears cloth into two
sheets); stand-off is a parabola, not the cylinder's exact profile (infinite slope creases
the canvas). Square-riggers bit-identical at drive ≥ 0.

T115 walk fixes: 3 of 8 defects were NOT what the review said — re-boarding measured from
feet a body-length underwater; "walled-in tiller" was a 0.46 m lane vs a 0.6 m capsule;
"bipod dead-end" was the ladder socket sitting off the deck. Plus interact range now
measured to the capsule (eye-to-socket spent the whole reach on the player's height).

T116 prompts, T117 dressing (cabin, thatch courses, radio on a crate with dial/meter/LED,
varied crates, rope railing) — T117 also DISPROVED T114's raft diagnosis by sweep:
`yardMastClearance` cannot close a bipod (legs splay in x, the sail plane turns about a
vertical axis), so that band is the cloth's job; the blueprint owed air, 0.05 → 0.30.

T118 enemy rig: `updateRig` WAS being called — the AI used `sailTrim` as a throttle with a
0.15 floor, which since the membrane is DRAWN as 18% of the hoist. B92: nothing had ever
rotated a rudder blade on any ship.

T119 clouds: the only sun-driven system not reading §V72's key light (a fog-colour proxy 4×
too narrow). B91's horizon bars/cut were one cause — a `min(rise/up, bandRange)` clamp
freezing the hit point onto a constant-radius circle.

T112e/f/g terrain: vegetation, talus/outcrops, CDLOD morph live + cull live (at 900 m the old
ramp had DELETED 374 of 841 plants). Impostors and hi-z built but INERT — see T120.

B89 resolved by measurement: god-ray defaults were never hot (bloom contributes more); the
near-sun road was, `glintRoadStrength` 1.0 → 0.75. T110 verified §V22 in-browser.
B77 retired: the full-moon tame-down is worse than the shipped defaults.

## Queued (not started) — in priority order
- T120 finish T112g: impostors live (need a renderer via main.ts), the 512² height field,
  dithered mesh half of the cross-fade, parallax reprojection. Indirect draws ARE available.
- T112h painterly (gated on R3 lookdev).
- DONE: pitch frames captured (`docs/raft2100/lookdev/pitch/`). CAPTURE LESSON: an MCP tab inside
  the user's big Chrome window never activates → rAF at 0 ticks/s → one frozen frame forever.
  Use its OWN Chrome window + `osascript activate`; verify visibilityState AND a live rAF counter.
  Park `state.ships[1]` on long pirate runs — the enemy AI sank the player mid-session.
- R3 sync (T102) IN FLIGHT at the time of writing — `raft.html?at=<island>&tod=` × islands × tod + 24-min day timelapse; author
  first LUTs via `__game.grade.bake(slot)`. Then T103 radio, T104 teachings, T105 markers/chart/
  sleep/score, T106 playtest. Then the user's "really deep review" of the whole Kon-Tiki build.
- Open bugs not yet tasked: B66 key radiance mid-swing, B68 chink drain vs mask,
  B93 the sky's two low-sun ramps disagree (`lowSunWarmth` to 23°, `sunColor` to 28°) so at
  tod 7 a warm sky hands the clouds a near-white key — needs a decision, not a patch.
- Known, deliberately unfixed: `setShipWorldMatrix` is a module singleton both ships write each
  frame (the enemy wins; both wetlines index in her frame) — fixing it costs the shared material
  set. The raft's steering oar is still static (different pivot from a rudder).

## User decisions (don't re-ask)
Same repo/mode switch · FP with hands · loose Sierra, one Half-Dome silhouette · Ghibli colour +
Firewatch composition · Watts rights via Alan Watts Org + Mark Watts, placeholder clips ·
clues = proximity audio + found text + raft-radio night callbacks · diegetic radio dial ·
semi-real sailing default accessible + hard toggle · 3-island slice · true-scale cabin w/
auto-crouch · 2100 dressing on 1947 bones · main+topsail+mizzen · play = walk+touch, hotkeys
debug only · swim back allowed · optional sleep · beach the raft · chart overlay→prop · placeholder
hands · separate raft.html · empty cage · terrain: stylised PBR first (painterly gated), dense-
walkable fork shrubs, implied trails, erosion owns silhouettes, 512² tex + 256² mesh, pirate
islands adopt free wins, bake = chunked CPU ≤300 ms/island measured.

## Workflow that worked
Spec-first (§V/§T per dir) → fan out per-dir agents WITHOUT browser → main thread flips §T,
verifies (exit codes), commits per task → ONE lookdev agent owns the browser at phase syncs →
user reviews batched frames. Agents die on session limits: SendMessage resumes from transcript
if it exists; otherwise respawn with "continue from disk" and `git status`/`git diff`.
