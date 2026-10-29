# CLAUDE.md

How to work in this repo, for a person or a Claude Code session on any machine. The details and the reasons are in
the docs this points to.

## Two things live here

- **The game**, Shiver Me Timbers: a WebGPU pirate game (`index.html` → `src/main.ts`), with the Raft 2100 mode
  (`raft.html` → `src/main-raft.ts`) and the speedboat pages. `SPEC.md` is its source of truth (§C constraints,
  §V invariants, §T tasks, §B bug ledger). Hand-over notes: `docs/SESSION-HANDOFF.md`.
- **The film**, *The Drift*: a fulldome origin story for Raft 2100, made for the Horizon 18 dome (tilted 15°).
  `drift.html` → `src/main-drift.ts`. It reuses the game's engine (FFT ocean, sky, raft, archipelago, flow foam,
  sails) and adds its own acts. A change to a shared system (`src/ocean`, `src/flowfoam`, `src/ship`, `src/sky`,
  `src/island`, `src/core`) changes both; keep film-only behaviour behind film params or an opt-in.

The film's content (treatments, direction, the user's review notes, reference photos) is outside the repo in
`../drift-narrative/`. Read it there; never commit it.

## Where the film's code lives

| path | what |
|---|---|
| `src/main-drift.ts` | boot, the show clock, URL params, the `window.__drift` handle |
| `src/drift/undertime/` | Act 1, Undertime (particle field, crawl, cosmic web) |
| `src/drift/getTheDrift/` | Act 2, Get the Drift: galaxies → Milky Way → Earth → flood → landing |
| `src/drift/wandering/` | Part C at sea (c1–c4) and Act 3, Wandering On (w1–w6): `sea.ts` the scene, `beats.ts` the timeline |
| `src/drift/record.ts` | offline recorder: frames to a sink as raw RGBA |
| `src/cine/domeCapture.ts` | the fisheye dome-master capture, with `setFlat` (the 16:9 review view); `domeAo.ts`, `capture.ts` |
| `src/params/drift.ts`, `src/params/getTheDrift.ts` | tunables, live through `__drift.params` |
| `scripts/drift-*` | data bakes, asset tools, render and review drivers (`docs/drift/PIPELINES.md`) |

**Every frame is a pure function of show time `t`.** Renders split the show into lanes that draw in any order, so
nothing may depend on the wall clock or on the previous frame. State that must carry over (wake, foam) is warmed up
from a fixed earlier time. Keep it so in every change.

## Run it

```sh
npm install
npm run dev          # http://localhost:5173/drift.html
```

URL params: `?t=<s>` start time · `?paused` · `?view=dome` (the square master; default `flat`, a drag-to-look
preview) · `?speed=<x>` · `?guides=0` (hide the dome guides) · `?markers` (orientation check: red front at the
bottom, green right, blue zenith, yellow back) · `?sea[&hour=<h>]` (the sea test act alone, on its own clock) ·
`?raftplain` (the game's undressed raft, an A/B) · `?trace` (TSL errors name our line) · `?record&…` (a render
lane; `scripts/drift-render.mjs` sets it). Keys: Space pause, ←/→ ±2 s (Shift ±10 s), Home restart, V flat/dome,
G guides, `[` `]` speed. In the console: `__drift.setTime(s)`, `__drift.params`, `__drift.total`.

Headless jobs need the installed **Google Chrome**: Playwright's bundled Chromium fails to compile some of the
sea's shaders, so everything from the sea (~314 s) on comes out broken in it. Pass `--channel chrome` to
`drift-render.mjs` and `drift-stills.mjs`; the review scripts default to it.

Several sessions often work in one tree at once: give your dev server its own port
(`npm run dev -- --port <n> --strictPort`). **At most two heavy render jobs run on a machine at once**, counted
across every session: start every headless render (stills, review clips, benchmarks, lanes) through
`node scripts/drift-slot.mjs [--weight <lanes>] -- <command>`, which waits for a free slot
(`node scripts/drift-slot.mjs --status` shows who holds them). While someone works at the machine the limit is one:
`out/drift/.slots/limit` holds it, machine-wide. Boot one page and reuse it for every shot and variant of a round.
**The studio dashboard**, `node scripts/drift-dash.mjs` (http://localhost:5190; `--tailnet` so render nodes can
report to it), shows the slots, each job's progress and ETA, the work streams, the render nodes and the newest
outputs. A session coordinating agents keeps `out/drift/dashboard/work.json` (streams, state, estimate, what waits
on the user) current as it dispatches and hears back.

## Review

- **16:9 first.** Stills and short clips for the user are 16:9 rectilinear views of the focus zone, drawn through
  the real pipeline (faces, AO, bloom, grade) with `dome.setFlat`: `scripts/drift-review-stills.mjs` and
  `scripts/drift-review-clip.mjs`. Aim at where the audience looks: ahead, 20–40° up.
- **The dome master** (`--dome`) only when the point is the whole scene at once.
- **Point-like things** (stars, birds, glints, flares) change with resolution: check one frame at the cut's size
  before concluding anything from a small still.
- Recipes, shot files and the eye modes (chase, aim, moved eye): `docs/drift/PIPELINES.md`, "Review".

## Render limits

- **No long or full-resolution renders without the user's go.** Review clips: at most ~30 s and 1280×720. Stills
  any time. Masters (2048² and up, ProRes, motion blur) only when the user asks for them.
- A render longer than ~20 min needs AC power (`pmset -g batt` on macOS) and chunks of about 25 min, each its own
  file: run it through the render queue, `scripts/drift-queue.mjs`, which does both. A battery-run overnight render
  once died and lost the night.
- One render at a time (`out/drift/.render.lock`), at most 2 lanes unless `--allow-lanes`, a disk check first: the
  guards in `scripts/drift-render.mjs`. Don't work around them.
- A master is delivered only after its frame count and a macOS AVFoundation decode check pass
  (`docs/drift/PIPELINES.md`, "Verify a master"). A clean ffmpeg decode does not prove DaVinci can read it.

## Typecheck and tests

```sh
npx tsc --noEmit                         # typecheck (src and tests)
npx vitest run tests/<name>.test.ts      # the tests that cover the change
npm run test:changed                     # tests that import what changed vs HEAD; prints what it skipped
npm test                                 # everything
```

- **Selective by default.** In the edit loop run the tests that cover the change. Run the full `npm test` (and a cold
  typecheck) when the user asks, before a release, or when the change reaches shared core. Never re-run a suite or a
  cold typecheck for a diff that already passed (a new worktree, a rebase, a commit-only step). Say so before
  starting anything that takes minutes.
- A narrowed run is not a pass of the whole suite; say which tests ran.
- Failures in files other sessions are editing right now are expected mid-flight: filter by path.
- `tests/zzScratch*` are local measurement harnesses: excluded from `tsc`, never committed.

## Git

- **Commit or push only when the user asks.** Don't make a commit for every tiny change.
- **Never discard work**: no `git checkout -- <file>` / `git checkout .`, `git restore`, `git reset --hard`,
  `git clean`, `git stash drop`, `git branch -D`, force push. Uncommitted changes in this tree are often another
  session's. Stage your own files by path, not `git add -A`.
- **Never commit `../drift-narrative/`.**
- Never commit built or downloaded data: `out/`, `public/drift/{earth,web,galaxies,flock,clouds,pbr}/` and images
  under `docs/` are gitignored. BlenderKit models are royalty-free for renders but may not be passed on.
- Messages in plain words, by area: `drift flock bake: pull up out of dives, land nearer`, `drift sea: …`.

## Code style

- **Comments are long and explanatory, in each file's voice**: why the code is the way it is, what was tried and
  failed, measured numbers. Match the file you edit and keep its comments true to the code.
- **Physical units**: metres, seconds, degrees. Say the unit of every tunable and every magic number (`/** m */`,
  `(deg)`); tunables belong in `src/params/*.ts`.
- **Cite what motivated a change**: the review and its date, quoting the note where it helps, e.g. "(the 2026-10-29
  review: "black spots all around underneath")" or "(the v11 review)".
- WebGPU and TSL only (SPEC §C). TSL traps: the trap ledger in `docs/SESSION-HANDOFF.md`, SPEC §B. Engine faults the
  film's renders found (cube targets, mirrors, shadows, frame transport): `docs/drift/engine-findings.md`.

## Docs

| doc | for |
|---|---|
| `docs/drift/PIPELINES.md` | every process step by step: asset fetch, decimation, bakes, render, master, verification, review |
| `docs/drift/STATUS.md` | where each act and beat stands, the open items |
| `docs/drift/RENDER-NODE.md` | setting up another machine (Linux, Windows) to render: GPU check, asset bundle, render queue |
| `docs/drift/WORKING-NOTES.md` | the working rules in full, with the reasons behind them |
| `docs/drift/engine-findings.md` | engine faults found by the offline renders, and their fixes |
| `docs/drift/earth-data.md` | the Earth maps' sources and rebuild |
| `docs/cine/drift-render.md` | the parallel renderer in depth: lanes, guards, measured rates |
| `../drift-narrative/README.md` | the acts, open questions; `*/direction.md` per act |
| `../drift-narrative/wandering-on/open-notes-2026-10-29.md` | the live list of the user's review notes |
