# Raft 2100 — session handoff (2026-08-21, paused)

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

## In flight when paused — NONE. All four landed. Full suite 2707 pass / 24 pre-existing skips, both entries build.
1. **DONE, committed e95e646** — raft visual fixer (B70/B73/B75/B76/B79–B85). Remaining gaps = B86. Frames: `docs/raft2100/lookdev/R1-fix/` (README lists defect→cause→fix). Formerly: **B70/B73/B75/B76/B79 raft visual fixer** (owns src/ship/raft*, preview*, flagMaterial,
   new `src/ship/raftRigging.ts` + 1-line hunk in `src/raft/raftScene.ts`): materials routing,
   preview hang, sails set/oriented, janky rig (yard cock/rake, forward sheet pull), bipod aft
   rake, ladder orientation, splashboards 0.5–0.6 m + longer run, furl bundle ∝ area, rigging
   lines (CAPPED per B79: <25 ropes, per-class table), flag wave hoist→fly, preview interact +
   hands + fov. Output: `docs/raft2100/lookdev/R1-fix/` + README. Uncommitted WIP in src/ship.
2. **DONE, committed 09b24da** — T112b path-first authoring (hm.path contract in pathCarve.ts). Formerly: **T112b path-first authoring** — `src/island/pathGraph.ts`, carve pass inserted before
   `thermalSmooth`, publishes `hm.path = {distance, routeMask, forkMask, pois, routes}`.
3. **DONE, committed b4c9c88** — T112d terrain-info + layered shading. Formerly: **T112d terrain-info texture + layered shading** — `src/island/terrainInfo.ts`,
   `sierraMaterial.ts` as its own material, `terrain/rockMaterial.ts`; exports channel layout.
4. **DONE, committed 2f31020** — B77 moon terminator + star dusk gate. Formerly: **B77 moon terminator** — `src/sky/skyBackground.ts`/`moonCycle.ts`/`starfield.ts`.
If any died (session limit), resume via the transcript or respawn "continue from disk" — the
briefs live in this session's transcript; the SPEC rows carry the requirements.

## Queued (not started) — in priority order
- B86 raft follow-ups (halyards/forestay sockets, raft sailWindRef, furl yard lowering, interact reach) — fold into T115 or a small raft pass.
- T114 sails pass through masts (all ships; B74) — after fixer exits src/ship.
- T115 R2 walk fixes (B78: boarding height, tiller spawn walled, strip dead-end, lookout eye).
- T113 dedupe mode glue (§V95: withFullCoverage, material cache, quat helpers, preview HUD).
- T112e vegetation layers, T112f outcrops/talus, T112g LOD (512² tex + 256² mesh + CDLOD,
  impostors), T112h painterly (gated on R3 lookdev).
- Pitch SET D frames (god rays, night, lagoon, sun road) — main game would not boot in a
  hidden tab (livelock); capture in a VISIBLE tab, photo mode `P`, `__game.followCam.setDebugPose`.
- R3 sync (T102): `raft.html?at=<island>&tod=` × islands × tod + 24-min day timelapse; author
  first LUTs via `__game.grade.bake(slot)`. Then T103 radio, T104 teachings, T105 markers/chart/
  sleep/score, T106 playtest. Then the user's "really deep review" of the whole Kon-Tiki build.
- Open bugs not yet tasked: B66 key radiance mid-swing, B68 chink drain vs mask, B69 gangway
  socket reach, B71 quatMath in combat/ (T113).

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
