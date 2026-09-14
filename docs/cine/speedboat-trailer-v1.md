# Speedboat trailer v1 (`sb-trailer-v1`)

The 60 s speedboat trailer script, turned into a shot list the offline cine renderer shoots on
`speedboat.html?mode=free`, delivered as separate clips with handles for an edit in DaVinci Resolve
(`docs/cine/trailer-edit-plan.md`, `scripts/resolve/trailer_import.py`). Music, the title card and the final
assembly happen in Resolve; this side renders pictures and SFX stems and writes the edit plan.

## Delivery (set the Resolve timeline to this)

| | |
|---|---|
| Frame rate | **60 fps**, constant, every clip |
| Master | **3840×2160**, ProRes 422 HQ (`prores_ks` profile 3, 10-bit 4:2:2), `video/<clip>.mov` |
| Proxy | **1920×1080**, ProRes 422 Proxy, `proxy/<clip>.mov` (made from the master when it closes) |
| SFX stem | 48 kHz 24-bit PCM WAV, `sfx/<clip>.wav`, exactly the clip's length, same start |
| Handles | **1.0 s** before and after every shot (a clip is `1 + shot + 1` s) |
| Grade | clean plate (`cine-flat`: no grain, vignette or colour grade; DOF, bloom, flare stay) |
| Names | `sb-trailer-v1_<id>_<slug>_take<NN>`, e.g. `sb-trailer-v1_07_rear-chase-launch_take01` |

60 rather than 30: the action beats are spray and fast lateral motion at real speed, 60 keeps them clean and
leaves room to conform to 30 or slow a beat down in the edit. The edit plan carries the same fps and size.

```
out/cine/sb-trailer-v1/
  edit-plan.json          what trailer_import.py reads: each shot's NEWEST take on disk; missing files left out
  plan.template.json      the full plan the page sent (all 18 clips)
  manifest.json           the last render run (fps, size, frames per clip)
  video/  proxy/  sfx/
```

## Run it

```bash
node scripts/cine-sink.mjs --edit sb-trailer-v1     # writes out/cine/sb-trailer-v1/
npm run dev
```

Preview (wall clock, each shot's preroll fast-forwarded so the boat is where the shot needs her):

```
http://localhost:5173/speedboat.html?mode=free&cine=play     the whole trailer in order
http://localhost:5173/speedboat.html?mode=free&cine=07       one shot, looping
```

Record (offline, fixed dt, 3840×2160 @ 60, take 01 by default):

```
http://localhost:5173/speedboat.html?mode=free&cine=record
http://localhost:5173/speedboat.html?mode=free&cine=record&only=09,15&take=2
```

or from the console on a page opened with `?mode=free&cine`:

```js
__speedboat.cine.play('07')
__speedboat.cine.record()                                   // every shot, 4K60, take 1
__speedboat.cine.record({ only: ['09'], take: 2 })          // re-shoot one shot as take 02
__speedboat.cine.record({ only: ['01'], width: 1280, height: 720, fps: 30 })   // a cheap look
__speedboat.cine.stop()
```

SFX stems are a second, **real-time** pass (an AudioContext cannot be stepped; `src/cine/audio.ts`). Click the page
once (browsers need a gesture to start audio), then:

```js
__speedboat.cine.recordAudio()                               // take 1, every shot
__speedboat.cine.recordAudio({ only: ['09'], take: 2 })     // the stem for take 02 — pass the same take
```

Then build the timeline:

```bash
python3 scripts/resolve/trailer_import.py out/cine/sb-trailer-v1/edit-plan.json --proxy
```

**Open the page with `?cine`** for any shoot (a bare `?mode=free&cine` builds the page for shooting and starts
nothing). Two things are decided before the renderer and the post graph exist, so they need it:

- **Maximum quality, whatever the player saved** (`cineSettings`): `high` preset, every graphics feature on
  (reflections, caustics, spray, rain, both shadow paths, the whole post chain including AO), full resolution,
  4096 shadow map, full foliage; texture anisotropy is the renderer's maximum already. The store is in memory:
  it reads the saved settings and never writes them back, so the player's settings are untouched and are what
  the next normal load uses.
- **The clean-plate grade** (`createCineBoot`): DOF, grain and vignette are construction gates of the post
  pipeline (`core/postPipeline.ts`).

A console `record()` on a page opened without `?cine` warns that both only half apply.

## No UI in a shot

While cine is active (play or record) nothing but the canvas is on screen, enforced in code
(`src/speedboat/cine/cineChrome.ts`): one class on `<html>` hides every element that is not the canvas or one of
its ancestors (race HUD, perf HUD, Tweakpane, pause and menus, radio line, markers, toasts, the boot splash,
anything added later), the cursor is hidden, the dev layer is switched off through its own channel, photo mode is
forced, and the page skips its HUD update. Diegetic 3D parts (the dash) stay. There is no on-screen progress line
for the same reason: poll `__speedboat.cine.progress`, or read the `[cine]` console lines and the sink's output.
Captured frames never contained DOM either way — capture reads a render target. Both are asserted in
`tests/speedboatTrailerShotlist.test.ts`.

## What was reused and what was added

Reused as-is: `src/cine/recorder.ts` (offline clock, capture, per-shot clips), `capture.ts`, `pump.ts` (hidden-tab
rendering), `audio.ts` (the real-time SFX pass), `director.ts` (frames, keys, follow, rideSwell, wobble, sun
solve), `src/grade` (`cine-flat`), `scripts/cine-sink.mjs`; the page's free-roam session, `ControlSource` seam,
race camera, photo mode and boat audio.

`src/cine` made mode-agnostic (the pirate page, `src/main.ts`, is untouched and compiles unchanged):

- `createCine` takes `shots`, `global`, `clipName`, `defaults`, `prerollPreview`, `editPlan`; all default to the
  pirate piece's behaviour. `openOcean` is optional.
- `DirectorHost`: `setShipSpeed/Anchored/Weather` optional; `prepareScene(shot, t)` / `holdScene(shot)` receive
  the shot. The director no longer imports the pirate shot list.
- New shot fields: `handle` (edit handles, rendered and recorded on both sides), `aimShip` (a static lens pans
  with the boat), `focusShip` (pull focus to her every frame), `follow.headingOnly` (damp her heading, hold her
  position: a position damper lags speed × halfLife / ln 2 behind her, 15–70 m at 30 m/s, and lost her from
  every chase frame of the first full take).
- The audio pass takes a structural `CineAudioSource` (the pirate `AudioSystem` fits as-is).
- Two behaviour changes that reach the pirate piece, both corrections: a take's first frame now lands exactly on
  its start time (it was up to one preroll step plus a frame late), and the audio pass of a `dissolve` shot now
  covers the same tail frames its video does.

Added:

| file | |
|---|---|
| `src/speedboat/cine/host.ts` | the speedboat `DirectorHost`, audio adapter, max-tier settings, URL/console handle |
| `src/speedboat/cine/cineChrome.ts` | the no-UI lock |
| `src/speedboat/cine/shotlist.ts` | the 16 rendered shots, 17 beats, markers, slots, delivery constants |
| `src/speedboat/cine/locations.ts` | the scouted Tower Reach locations and paths |
| `src/speedboat/cine/drive.ts` | the scripted driver (path follower + placement) |
| `src/speedboat/cine/editPlan.ts` | clip naming + `edit-plan.json` |
| `scripts/cine-sink.mjs --edit` | ProRes master, proxy, WAV stems, `/plan` → `edit-plan.json` |
| `src/main-speedboat.ts` | +5 lines (290 total): settings tier, boot, drive in front of controls/spawn, tick, camera, draw hooks, HUD skip |
| `tests/speedboatTrailerShotlist.test.ts` | the timeline/location/primitive/handle contract, the no-UI lock, capture reads no DOM |

## Shot list

Timeline seconds. Frames: `hull` = bolted to her (full attitude), `ship` = her position + heading, `locked` = her
pose captured at the first frame and held, `world` = static lens.

| id | in–out | location | primitive | frame | drive | sea | cue |
|---|---|---|---|---|---|---|---|
| 01 | 0–3 | bay | dolly | ship, rides water 0.3 m | at rest | glass | gentle water, sparse tension |
| 02 | 3–6 | bay | slide | ship, 0.8 m | at rest | glass | engine idle begins |
| 03 | 6–9 | bay | dolly | ship, 0.45 m | at rest | glass | mechanical vibration |
| 04 | 9–12 | bay | mount | hull | at rest | glass | musical pulse |
| 05 | 12–14 | bay | reveal | locked, 0.7 m | at rest | glass | hold the tension |
| 06 | 14–15 | bay | insert | hull | throttle 0→1 over 0.2–0.85 s | glass | music pulls out, rev surge |
| 07 | 15–19 | bay | chase | ship + follow 0.35 s, rides water 2.2 m | launch from rest (throttle at −2 s) | glass | **music drop**, roar |
| 08 | 19–23 | openSwell | follow | ship + follow, 0.9 m | 33 m/s east | breeze | hull impacts |
| 09 | 23–26 | rockyPoint | static-long | world 1.2 m + aimShip + focus | 35 m/s up the lap line | breeze | Doppler pass |
| 10 | 26–30 | openSwell | mount | hull + engine buzz | 32 m/s east, weave | breeze | wind, engine strain |
| 11 | 30–34 | towerTip | overhead | world 215 m up + aimShip | 20 m/s round the tip (steer ≤ 0.4) | breeze | hook opens |
| 12 | 34–38 | towerTip | follow | ship + follow 0.25 s | same carve | breeze | pitch under load |
| 13 | 38–42 | openSwell | follow | ship ahead, looking back | 33 m/s east | breeze + 0.55 m swell | clear impacts |
| 14a | 42–43.6 | openSwell | insert | hull (wheel) | weave 0.12 @ 0.7 Hz | breeze + swell | cut 1/3 steering |
| 14b | 43.6–45.3 | openSwell | follow | ship abeam, 0.5 m | 33 m/s | breeze + swell | cut 2/3 clears swell |
| 14c | 45.3–47 | openSwell | chase | ship + follow | 33 m/s | breeze + swell | cut 3/3 lands |
| 15 | 47–52 | knuckleGap | static-long | world 1.6 m, fixed aim, 16° lens | 26 m/s through the channel | breeze | engine dominates |
| 16 | 52–56 | horizon | rising | ship + follow, 5→24 m | 34 m/s west | breeze | engine trails away |
| 17 | 56–60 | — | title slot | — | — | — | musical hit (built in Resolve) |

The sun sits 3° (3.5° in the bay) above the western horizon for every shot. The camera numbers and reasons are in
`shotlist.ts` next to each shot. Markers in the plan: 0 sparse tension, 3 idle, 9 pulse, 14 music pulls out,
**15 music drop**, 19 impacts, 23 Doppler pass, 30 hook, 38 drive, **42 cuts on impacts**, 47 engine, 56 hit.

## Locations

Tower Reach, seed 1965 (the page's), scouted headless: seabed depth, the reference sea's swell shadow K
(0 = full lee), and the page's own collider list (`tests/speedboatCollisionWorld.ts`). The sun sets toward world −x.

| id | point (x, z) | shallowest on path | K | nearest collider on path | why |
|---|---|---|---|---|---|
| bay | (140, −330), heading +x | 14.6 m | 0.0 | 81 m | NE lee of Tower Cay: glassiest water, island + sunset behind her for 05; launch runs east between G8 and G7 |
| openSwell | line z = 150, x −1700 → −630 | 30 m | 1.0 | 14 m (a Pylon Row pylon near the east end) | up-swell of the whole group, no land on the western horizon |
| rockyPoint | lens (441, 530) | 4.9 m | 0.7 | 14 m | Knuckle's SE knob stands on the lap line G4→G5; the lens on its shoulder sees her pass ~11 m off |
| towerTip | arc about (240, −140), R 115 | 4.1 m | 0.3 | 14 m (G7 pole; the arc runs through the gate) | the one island tip with open water all round the arc |
| knuckleGap | lens (100, 262), channel (640,445) → (−300,250) | 3.8 m | 0.2 | 7–10 m | best available gap — see gaps |
| horizon | line z = 260, x −650 → −2800 | 34 m | 1.0 | clear | due west into the sun, nothing on that bearing |

## Choreography

**The same water every take.** The sea is a function of sim time and the session clock keeps running between takes,
so each take pins `state.time` when she is placed (the spectrum, the mirror and the clouds are functions of time;
wake, foam and spray integrate dt). Before that, shot 09 ran clean in one browser run and stuffed a second after
placement in the next; after it, a crash that happens happens at the same spot every run. Re-rendering a shot gives
the same composition but not byte-identical frames (09 take 01 vs 02: boat within about half a length at the pass,
PSNR 26–30 dB) — spray particles, preroll step rounding and wake history still differ.

The boat is **driven**, never animated: `drive.ts` sits in front of the page's control source (the seam the
keyboard, gamepad and `?autopilot` use) and follows a shot's path with pure pursuit and a speed PI, in the fixed
tick, on the driver's own tick clock. Every take re-places her through free roam's own `session.start` (crash
machine, collide memory, frame and camera snaps) at `drivePose(shot.drive)` and runs its 6 s preroll through the
same physics, so each clip is repeatable on its own and a 4K render lands on the same water as a 720p preview.

The race pilot (`page/autopilot.ts`) was not reused: it follows the lap's racing line with a race standing and an
eight-boat world snapshot, and a trailer path that goes round an island tip or through a rock channel has no
`PilotSetup`.

Tuned headless on the page's player physics, seabed and fetch field (scratch sim, no GPU): no take stalls or
leaves its line by more than 11 m; 09 passes the lens at 11 m, t ≈ 2.6 s; 11/12 reach the arc apex at t ≈ 2.3 s
(7.3 s preroll); 15 leaves the frame near t ≈ 5.3 s. The carve's steer is capped at 0.4: at 0.6 she heeled past
50° in the turn, which the crash machine reads as a hook (it did, in the first browser take). A crash respawn during an armed shot is logged loudly
(`[cine] the hero CRASHED…`) and shown on the progress line — that take is not the scripted one.

## Browser checks (headless Chrome + WebGPU, under the GPU lock)

Five sessions, clips through the real recorder and sink at 1280×720 / 960×540 @ 30 (not the 4K60 delivery):
all 18 clips rendered (~30 fps of render at 540p, the full trailer in about 3 minutes plus boot), proxies and the
plan landed, and during `play` only the canvas host and the canvas were visible, cursor `none`, 81 elements back
after `stop`; boot gates read DOF on, grain off, AO on, 4096 shadows. Framing verdicts from the frames:

- good: 01 waterline bow, 02 the 27, 04 pilot silhouetted against the sun, 05 reveal with reflection,
  06/14a hand inserts, 08 airborne abeam, 09 speck-to-pass, 10 bow look-back (after the fix), 11 wake arc,
  12, 14b clearing a swell, 15 rocks and knob, 16 silhouette on the glitter road (after the fix).
- 03 is tight on the cowlings (reads, but little water); 13 has her small beside the sun road.
- 07: the chase holds the three cowlings, but from ~t 3 s the rooster tail engulfs the lens.

## Gaps and flags

- **Crash respawns in the preroll on the open swell: 10 and 14c** (last check). Placed level at 80% speed she
  stuffs about a second after landing; the take is recorded but the respawned boat starts from rest. Move
  `startS` again (each placement is now deterministic) or place slower with a longer preroll.
- **07's rooster tail fills the lens** late in the take; the lens needs to sit higher or wider.
- **No courier cargo prop** exists for shot 04's "secured courier cargo behind the seat".
- **Throttle hand (06)**: the pilot rig does not play the `throttle_push` clip (`pilotRig.ts`); the lever input is
  scripted, the hand may not move. The wheel does turn with steer (14a).
- **Insert and detail camera numbers (01–06, 10, 14a)** are placed against the hull JSON, not checked in frames.
- **No true island channel on Tower Reach.** Shot 15 uses the winding passage through Knuckle (30–50 m wide, 3.8 m
  at the shallowest, rocks 7–10 m off her line). It is the flagged pick.
- **The `swell` preset stalls the scripted boat** (18 → 4 m/s in 3 s in the sim); 13/14 use `breeze` with a 0.55 m
  ground swell instead. She tops out near 30 m/s in `breeze`, under the 33–35 m/s targets.
- **The carve (11/12) runs through the G7 gate**, 14 m from a flexible pole.
- **Audio alignment**: the SFX pass starts on the display frame after the head handle begins, so stems sit within
  one frame (~17 ms) of the picture; the sink trims/pads each WAV to the exact clip length.
