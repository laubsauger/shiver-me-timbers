# Speedboat trailer — v2 cut (`sb-trailer-v1`)

**v2 (sunset into night).** Same 60 s, same 17 beats, same timings, cameras, choreography and cue notes as v1; what
changed is the time of day per shot and the framing/notes night calls for: **01–09 sunset**, **10 the dusk time cut**,
**11–16 night** (moonlit, the boats' LED strips and pools), 17 the title slot. The clip names, the edit plan and the
Resolve import are unchanged (the timeline is still named `sb-trailer-v1`, so takes already on disk still pair).
The night act depends on §T.209 (moonlit time option + boat LEDs, in progress in the tree); see §Night.

The 60 s speedboat trailer script, turned into a shot list the offline cine renderer shoots on
`speedboat.html?mode=free`, delivered as separate clips with handles for an edit in DaVinci Resolve
(`docs/cine/trailer-edit-plan.md`, `scripts/resolve/trailer_import.py`). Music, the title card and the final
assembly happen in Resolve; this side renders pictures and SFX stems and writes the edit plan.

## Delivery (set the Resolve timeline to this)

| | |
|---|---|
| Frame rate | **30 fps** (USER: the first real record is 1080p30). 4K60 later, behind a flag: `record({ res: '4k', fps: 60 })` / `&res=4k&fps=60` |
| Master | **1920×1080**, ProRes 422 HQ (`prores_ks` profile 3, 10-bit 4:2:2), `video/<clip>.mov` |
| Proxy | ProRes 422 Proxy, `proxy/<clip>.mov` (made from the master when it closes; sink `--proxy WxH`) |
| SFX | 48 kHz 24-bit PCM WAV, lossless (AudioWorklet tap), `sfx/<clip>.wav` = mix, exactly the clip's length; `sfxStems` engine/water when the audio seam exists (§Gaps) |
| Handles | **1.0 s** at rest, **3 s** at speed (settled runs), 06: 1.5 s, 10: 2.5 s, R5 06c: 2 s (dissolve room) |
| Grade | **`cine-sunset`** baked in (grade/index.ts), each time of day sets its own live grade values (look.ts). Not a clean plate |
| Anti-aliasing | **16 jittered subframes per frame** (capture.ts `Accumulator`, averaged in linear light); look passes `&ss=4` |
| Motion blur | **180° shutter**: the 16 subframes spread over half a frame (recorder.ts `shutter`) |
| Resume | `record({ resume: true })` / `&resume`: skips clips the sink already has under the same settings key |
| Names | `sb-trailer-v2_<id>_<slug>[_<time>]_take<NN>`, e.g. `sb-trailer-v2_10_bow-lookback_night_take01` |

The first full record (1080p30, N=16, all shots + variants) runs only after the user signs off a look pass
(640×360, N=4, 180°). Nothing full-res is started by an agent.

```
out/cine/sb-trailer-v2/
  edit-plan.json          what trailer_import.py reads: each shot's NEWEST take on disk; missing files left out
  plan.template.json      the full plan the page sent
  manifest.json           the last render run (fps, size, frames per clip)
  video/  proxy/  sfx/    video/<clip>.mov.key = the settings key it was rendered with (resume)
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

Look pass (what the review previews are made from): `?mode=free&cine=record&w=640&h=360&fps=30&ss=4`, then the
proxies concatenated in cut order with each clip's 1 s handles trimmed.

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

## Shot list (v2)

Timeline seconds (the default assembly; the edit is cut to music in Resolve and may run longer). Frames: `hull` =
bolted to her (+ `mountIsolation` spring), `ship` = heading frame, `platform` = a camera boat/drone with its own mass
(§Cameras), `locked` = her pose at the head frame, held, `world` = static lens.

| id | in–out | time | location | primitive | camera | drive | sea | cue |
|---|---|---|---|---|---|---|---|---|
| 01 | 0–3 | sunset | bayDetail | dolly | ship, rides water 0.3 m | idle cruise ~6 kn, bow NNE (sun rakes the starboard flank) | glass + Bf2 wind | gentle water, sparse tension |
| 02 | 3–6 | sunset | bayDetail | slide | ship, 0.8 m | idle cruise, NNE | glass + wind | engine idle begins |
| 03 | 6–9 | sunset | bayDetail | dolly | ship, 0.45 m | idle cruise, NNE | glass + wind | mechanical vibration |
| 04 | 9–12 | sunset | bay | mount | hull, isolation 0.08 s | idle cruise, E (pilot silhouetted); courier cargo on the aft deck | glass + wind | musical pulse |
| 05 | 12–14 | sunset | bay | reveal | locked, 0.7 m, pans with her (aimShip) | idle cruise toward the lens | glass + wind | hold the tension |
| 06 | 14–15 | sunset (+night = **06b**) | bayThrottle | insert | hull macro 16°, dash side, focus tracks the grip, cine fill light | reach −0.7, lever 0→1 over 0–1.2 s, hold | glass + wind | music pulls out, rev surge |
| 07 | 15–19 | sunset | bay | chase | platform lag 0.5, 28° from 14–18 m, 3.4 m over the sea | launch from idle (throttle at −2 s) | glass + wind | **music drop**, roar |
| 08 | 19–23 | sunset | openSwell | follow | platform lag 0.7, abeam 21 m, 30°, own 1.2° roll | 33 m/s target (makes ~26) east | breeze | hull impacts |
| 09 | 23–26 | sunset | rockyPoint | static-long | world 1.2 m + aimShip, **22°** | 35 m/s up the lap line | breeze | Doppler pass |
| 10 | 26–30 | **dusk** (+sunset, night looks) | openSwell | mount | hull, isolation 0.06 s | 26 m/s east, weave 0.04 | breeze | **time cut** — sky going blue, LEDs 0.4 |
| 11 | 30–34 | night | towerTip | follow | **platform, low front 3/4** (0.9 m, 45° off the bow, 32°) | 20 m/s round the tip | calm | hook opens — LED pool + spray at the lens |
| 12 | 34–38 | night | towerTip | follow | platform lag 0.6, rear quarter, 40° | same carve | calm | pitch under load |
| 13 | 38–42 | night | openSwell | follow | platform lag 0.9, ahead looking back, 26° | 28 m/s east | calm | clear impacts — (pack pools behind her) |
| 14a | 42–43.6 | night | openSwell | insert | hull wheel, isolation 0.06 s | 24 m/s, weave 0.12 @ 0.7 Hz | calm | cut 1/3 steering |
| 14b | 43.6–45.3 | night | openSwell | follow | platform abeam 21 m, 30° | 26 m/s | calm | cut 2/3 — LED-lit spray |
| 14c | 45.3–47 | night | openSwell | chase | platform lag 0.5, 36° from 28 m | 24 m/s | calm | cut 3/3 lands |
| 15 | 47–52 | night | knuckleGap | static-long | world (180, 330) 1.5 m + aimShip, 24° | 26 m/s through the channel | calm | engine dominates — drowned town, strobes, LED reflections |
| 16 | 52–56 | night | horizon | rising | platform lag 1.0, 40°, 6→26 m | 34 m/s west | breeze | engine trails away — under the moon |
| 17 | 56–60 | — | — | title slot | — | — | — | musical hit (built in Resolve) |

Every take: **SEA_SETTLE** 4 s in front of the preroll (the sea arrives at the take's weather before she is placed),
`waterClearance` 0.4 m on every non-hull lens. Night = §T.209 `MOONLIT_NIGHT` (23:00, half moon). Markers as v1.

## Look (v2)

One patch per time of day (`src/speedboat/cine/look.ts` `TIME_LOOK`), merged under each shot's own world
(`shotlist.ts` `withLook`, one level deep, so a shot can move one exposure without restating the sky). Every time writes
the same keys: the director never resets between shots, so a night shot recorded after a sunset one would otherwise keep
the sunset's warm gain.

- **Sunset.** The first takes were pink and hazy: the engine's golden-hour palette is rose-salmon through the body with a
  mauve zenith, at the game's exposure 1.1 and `glass`'s 0.95 ambient. The grade alone left the sky pink (720p side by
  side: identity grade / `cine-sunset` / amber skies). Now: amber mid band `#c27d45`, slate zenith pulled low (curve
  0.45), gold horizon, exposure 0.77, ambient 0.42 (deep hull shadows; 0.32 crushed the livery). The user's review of
  the first amber frames: loved the reflections and the direction, the sun was blown out — so the disc is smaller and
  hotter with the glow/halo pulled in (0.7° / 22 / glow 600·0.6 / halo 10·0.08), bloom later and softer (1.0 / 0.45),
  streak and flare quieter, the glint road and sparkle down (0.5 / 0.75).
- **The sun's azimuth is not a per-shot knob** (an equinox sunset is due west on this engine), so side-light is chosen by
  heading: 01–03 moor on `bayDetail`, the same spot with her bow NNE, putting the sun 30° aft of the starboard beam the
  detail lenses see. Pointing east, the 27 and the orange band were black against amber.
- **Dusk** (10): sun −5° (at −3° it was still lavender-orange), a blue zenith, the warm gain half-way back to neutral.
- **Night**: exposure 0.9, cool shadow split, neutral highlights (the LEDs keep their colours), the grade mode's earlier
  bloom for the LEDs, the sky's wind streaks off (they read as shooting stars on a black sky). 11 opens up to 1.3.
- **Motion** (01–07, USER "feels completely parked", "blobbed in"): an idle cruise (3.5 m/s target, measured 2.5 at the
  old 3 m/s target), a Beaufort-2 wind texture on the glass, no hand-set ground swell (the sea-presets agent owns swell).
- **06 light** (review: silhouette, soft): the boat turned so the sun rakes the port throttle quadrant, focus tracks the
  grip (0.6 m range, bokeh 2.5), and a small warm cine-only practical over the quadrant while a `throttleHand` shot is
  cued (host.ts). `shots/throttle_hand_quality_check.png` is the frame for the glove judgement.

## Cameras (v2)

- **`platform`** (cine/types.ts, director.ts — shared, the pirate piece can adopt it): a camera boat/drone with mass.
  Critically damped spring onto her position and smoothed velocity (no lag at a steady speed, `lag` s response to
  launches and slams), heading = her smoothed course, height = the low-passed sea under the lens (never her heave),
  aim = a low-passed point at her CG with a dead zone (she moves in the frame on impacts), the platform's own slow roll,
  her pitch/roll never transfer. Used by 07, 08, 11, 12, 13, 14b, 14c, 16. USER: "camera… on a steel beam".
- **`mountIsolation`**: hard mounts (04, 06, 10, 14a) take her attitude through a slerp spring (0.05–0.08 s).
- **`waterClearance`**: no follow/chase/static lens under the surface under it.
- **Heavier camera language**: chase lenses 28–40° from further back instead of 36–58° close in; no speed ramps.
- **Time scale, measured** (take 06 traces, 640×360@30): the recorder advances exactly 1/fps per frame (plus the shutter
  subframes that add to it), manifest and every clip `r_frame_rate=30/1`, the preview concat 30/1 (no retime). Boat
  speed from distance/frames: 08 25.9 m/s (drive target 33, the physics tops out ~26 — the headless sim says the same),
  09 29.2, 13 28.9, 16 29.8, 11/12 20.0 (target 20), 01–05 2.5 (target 3). So the clips are real time; the toy/hyperspeed
  read was the rigs (fixed above) and the physics' mass feel (sea agent).
- **Motion blur check**: `shots/motion_blur_07_chase.png` — the sea streaks along the motion, the boat and her antenna
  (static relative to the chase platform) stay crisp. Boats, pilots, camera and dampers are interpolated per subframe;
  sea surface time, wake, foam and spray step on the 1/60 s tick, so a 1/60 s shutter samples them at one or two states.

## Time-of-day variants

Rendered as **looks of one take** (recorder.ts `looks`): each output frame is drawn at every time of day from the same
simulated instant (dt 0 between looks, identical jitter/shutter subframes, one accumulator per look) and written to its
own clip. Two separate takes of one shot are NOT deterministic on this page (cm at rest, more after a launch), which is
why variants are not re-runs. Proof: per-frame hash of her drawn pose + the camera matrix — 06 sunset/night 120/120
frames bit-identical, 10 dusk/sunset/night 270/270.

- **No flicker** (USER: frame-by-frame flicker between variants "doesn't work", nor during the jumps). The flicker
  preview is gone; variants are for straight cuts and dissolves only.
- **The day→night switch is R5 `throttle-to-night` (06c)**: a second throttle grab from a different angle (higher, over
  the dash, looking down-aft to port into the sun), its sunset and night takes frame-identical, handles 2 s each side.
  The edit plan marks the lever's **push-start frame** (`coverage[].cutS` = source 2.000 s: handle 2 s + the throttle's
  rise at shot time 0); the importer stacks the night take over the sunset take in the setup's timeline and drops a
  purple marker on that frame; the assembly carries a `day→night: R5 06c` marker at 29.5 s. Cut or dissolve there.
  (An in-render sunset→night ramp was dropped by the user.)
- Kept: 06/06b (sunset + night) and 10 (dusk + sunset + night) as alternates. Whole-trailer variants remain behind
  `record({ variants })` for the edit to choose from.
- Edit plan: `shots[].alternates` (assembly, disabled `ToD: <time>` tracks) and `coverage[]` (bins per setup/time).
  One SFX stem per shot.

## Render budget (estimate, not measured at 1080p)

Look pass 640×360, N=4, 180°: the whole list incl. variants took ~6 min of lock time (≈12 output fps at N=4). At
1080p (9× the pixels, partly GPU-bound) N=16 the estimate is **~0.5–0.7 output fps**: the current list (~3,700 frames
incl. the 06/10 looks) ≈ **1.5–2 h**. The coverage plan below (≈9 setups × 6 cameras × ~14 s + ~28 inserts × 4 s ≈
23,000 frames) ≈ **9–13 h** → tier it: A = the current 18 shots + duel/pack masters + the three hard mounts (~3 h);
B = remaining coverage cameras; C = inserts. N=8 is acceptable for static/slow lenses (01–05, 09, 15) and roughly halves
those. All resumable.

## Coverage (v2.1)

All additive: every assembly shot keeps its own lens (camera `main`) and its place on the 60 s default assembly. On
top of that:

- **Coverage cameras on a run** (`TrailerShot.coverage`, the `COVERAGE` map in shotlist.ts): more lenses on the SAME
  run. The recorder draws every output frame once per look — looks are cameras × times of day — from one simulated
  instant (recorder.ts `looks`, cine/index.ts `cameras`: each camera has its own director cued with the run and advanced
  on the same clock, so its dampers integrate every frame). Measured on 07 and 13 (640×360): the boat position under
  every camera equals the main lens's to the bit, 180/180 frames. Clip: `…_07_rear-chase-launch_cam-windshield-back_take01`.
- **Coverage-only setups** (`TRAILER_RUNS`, `run: true`, not on the assembly): **R1 duel** (sunset, #27 vs #8 abeam
  8.5 m, the lead changes at t ≈ 0.4 / 4.8 / 8.5), **R2 overtake-wake** (sunset, #27 crosses #14's wake 30 m behind it
  and runs it down; calm gives a lift, not an air hop), **R3 night-pack** (night, #27 leads a chevron of four, #3
  challenges late). 10 s + handles each, solved headless with the rivals' wakes/contact and the crash machine, 6/6 clean
  on `calm`.
- **Lens library** (shotlist.ts): hard mounts `windshield-back`, `pov-forward`, `bow-aft` (tier B until the water mask
  lands), `engine-bracket`; platforms `front-low`, `abeam`, `chase`, `drone-wide`, `tele` (12°, the tighter night
  option); inserts `props`, `cowl-27`, `gauges`, `windshield-spray`, `shoulder-silhouette` (USER: silhouettes over face
  close-ups), `led-strip`, `wake`, `rooster-backlit`, `moon-road`, `rival-whoosh`. Not in the library: tower lamps / start
  lights (the tower rig is lit only in a race), drowned structures (they are 15's own frame and its `pov-forward`).
- **Tiers**: A = the assembly lenses, the rival masters, the hard mounts; B = more coverage; C = inserts.
  `record({ tier: 'A' })` / `&tier=A`; `'none'` = main lenses only.

| setup | time | cameras |
|---|---|---|
| 05 bay cruise reveal | sunset | main, drone-wide, front-low, insert cowl-27 |
| 07 launch | sunset | main, windshield-back, engine-bracket, abeam, front-low, insert props |
| 08 open-water run | sunset | main, pov-forward, chase, tele, drone-wide, inserts rooster-backlit, wake, windshield-spray, gauges |
| 10 dusk time cut | dusk + sunset + night | main, windshield-back, bow-aft, insert shoulder-silhouette (each × 3 times) |
| 12 tower-tip carve | night | main, drone-wide, abeam, insert led-strip |
| 13 night solo front run | night | main, windshield-back, tele, chase, inserts led-strip, moon-road |
| 14b / 14c swell triple | night | main + front-low, pov-forward / tele, insert props |
| 15 Knuckle gap | night | main, pov-forward, chase |
| 16 horizon | night | main, chase (tighter), insert moon-road |
| 06 throttle | sunset + night | main (06/06b) |
| R1 duel | sunset | main (outside the pair), front-low, windshield-back, pov-forward, chase, tele, drone-wide, insert rival-whoosh |
| R2 overtake-wake | sunset | main (high chase), pov-forward, windshield-back, abeam, front-low, insert wake |
| R3 night pack | night | main (front 3/4 ahead of the pack, slow heavy platform), drone-wide, windshield-back, chase, tele, abeam, inserts led-strip, moon-road |
| R4 night pack at cruise | night | main (slow drone hold at 35 kn), front-low, abeam, windshield-back, tele, insert led-strip |

Counts (all times of day): tier A 40 clips / 9,060 frames, B 66 / 15,153, C 84 / 19,254 at 30 fps.
**Edit plan**: `coverage[]` (setup, camera, kind, tier, time, video/proxy, the setup's one SFX stem, `sourceStartS`,
`durationS`, `onAssembly`); the importer bins by setup/time, gives every clip of a setup the same Start TC, and builds a
stacked-track timeline per setup (Resolve's API cannot create multicam clips; "Create Multicam Clip Using Selected
Clips" by Start TC works on the bin). docs/cine/trailer-edit-plan.md §Coverage.

## At speed, settled (v2.2)

USER: "some shots record too early before we're up to speed… a weird acceleration from almost standing… lots of loss if
we cut it off". Measured on the first coverage pass (speed over the first vs last 10 frames of each main take): 08 24.5 →
27.6, 10 22.3 → 27.0, 16 27.9 → 31.9 still accelerating (their 33/34 m/s targets were out of reach, so the throttle never
let go); 01–05 2.6 → 3.3 (cruise still settling); 06/07 accelerate by script. The rest were steady.

- Every at-speed run (`along(loc, s0, v)`) is now placed AT `v`, `AT_SPEED_SETTLE` = 8 s before its head handle, on the
  line where it reaches `s0` at shot time 0 — `s0` measured off the tuned takes, so static lenses keep their passes (09
  still passes the knob, 15 still bursts the gap). Targets are the speeds she actually holds: 08 27, 09 30, 16 31.
- At-speed handles are 3 s each side (clips 9–10 s), so every coverage camera has a long cuttable take.
- The preroll is not drawn (recorder `prerolling` → skip the draw; sim, dampers, sea and wake still run). Multicam cameras
  and time-of-day looks share the one run, so they share the settle.
- **Take check** (host.ts `takeCheck`, logged per take, kept in `__speedboat.cine.takeChecks`): speed at the first and
  last 10 frames vs the target (flag < 90 %), airborne fraction (wetted < 0.5 m², flag > 10 % outside 14a–c), frames with
  the stem deck under the sea. Check run (640×360): 08 27.0/27.0, 09 29.9/30.0, 11 19.8/20.0, 14c 23.9/24.0, 15 27.0/26.1,
  16 31.2/30.9, R3 26.7/25.0, R4 18.2/18.0 m/s; airborne 0 % and bow under 0 frames in all.
- Launch/acceleration only in 06/07 (and their coverage).

**Seas** (the sea agent's presets, `SPEEDBOAT_SEAS`): bay 01–07 `calm` (Hs ~0.23 m); 08–13, 15, 16, R1–R4 `working`
(10 s swell, Hs ~0.5 m — USER: "waves still massive… nothing you'd race a speedboat through"); 14a–c `open` (Hs ~1.15 m),
the only place for deliberate air. **Clouds**: `clusterCount` sunset 11, dusk 7, night 3.

**Wave-height fix pending** (user-approved, sea agent): all realised waves shrink by 1/√2 at the root, the presets
included. Cine keeps the preset names and does NOT compensate. Every sea-dependent take (all of them) is reshot once it
lands; the day take 02 below is a look reference only.

**Re-render list** (everything shot before these changes): all day takes and their coverage — 01–10, R1, R2 — are being
re-rendered now as take 02 (sea, handles, settle, clouds). Night takes 11–16, R3, R4 are held until wake round 3, the
T209 follow-ups (moon, arch light, clouds) and the sea trim fix land.

**Day take 02 look reference** (640×360, N=4, per-setup sheets `scratchpad/trailer/shots/day2/cov_<setup>.png`, pre
wave-height fix): 52 clips; take checks 08 27.0/27.0, 09 29.9/30.0, 10 26.0/26.0, R1 25.7/22.2 (the duel's scripted
trades), R2 28.9/29.2 m/s, airborne 0 %, bow under 0. Cruise 01–05 still settled 2.6 → 3.3 m/s inside the clip → their
preroll now has the same 8 s settle. Lens notes for the reshoot: `insert-gauges` and `insert-windshield-spray` look over
the windshield at the foredeck (the dash is not where the numbers put it — re-place against the cockpit in a frame);
`drone-wide` leaves her small in a corner on 08; `insert-rival-whoosh` (R1) misses the pass (timing); R1 `tele` into the
sun with both boats and the duel's `windshield-back` with #8 alongside read best.

**Night frame check** (current code, R3 at 25–30 m/s, `shots/night_check_spray_surface_clouds.png`): spray plumes and
LED reflections on real wave facets are visible at ≥ 20 m. So the "no spray" moon-road insert was the camera at 14 m
behind her, inside the spray's ~8 m near-camera fade with the plume between lens and hull (a) — pulled back to 26 m / 22°.
Clouds: still bright white puffs in the night sky with `nightLitFloor` 0.16 (T209's). The roll-arch colour is not
readable at that distance.

**SFX stems** (audio agent): engine and water stems land beside the mix per shot (24-bit/48 kHz, exact length); with the
bus compressor's 6 ms look-ahead and +2.6 dB bus gain accounted for they sum to the mix at −112 dB residual. The stems
sit 6 ms ahead of the mix (under a frame). No amb stem (nothing on the ambience bus). Sync of the boat synth itself vs
picture not proven (07's throttle hit is the candidate).

## Jitter review (R1 tele + windshield-back)

Diagnosed from a per-draw trace (`__speedboat.cine.traceDraws(true)`: every subframe of every look with loop phase,
hero/rival/camera poses) on R1, then fixed at the root. Plot: `shots/jitter_R1_frame_deltas.png` (camera pitch 2nd
difference over 2 s, red before / blue after), clips `shots/jitter_R1_{tele,windshield-back}_{before,after}.mp4`.

1. **Pose sampling — clean.** Frames exactly 1/30 s apart; the four 180° subframes 1/240 s apart; hero and rivals both
   interpolated between the two bracketing 1/60 ticks with the SAME loop alpha (hero `speedboatFrame.renderBoats`,
   rivals `rivals.renderPose`); coverage cameras advance on shot time with the recorder's dt.
2. **Physics chatter — none to speak of.** Hull spectrum over the 12 s R1 take on `working`: pitch 19 % < 0.5 Hz, 77.6 %
   0.5–2 Hz, 3.4 % 2–5 Hz, 0 % above 5 Hz (roll 0.8 %, heave 1.5 % in 2–5 Hz; rival the same); pitch-rate sign flips on 5 %
   of ticks. Nothing for the sea agent from this take.
3. **Root cause, hard mounts: the cine's own synthetic buzz.** `GOPRO` (hz 5 → pitch axis 6.9 Hz) and `BUZZ` (hz 6.5 →
   8.9 Hz) put a 4–9 Hz shake on every hard mount — 3–7 frames a cycle at 30 fps, no shutter blurs it. Windshield-back
   camera rotation 2nd difference p50 0.21° with sign reversal on 42 % of frames → after 0.017° / 9 % (pov-forward the
   same). Both are now a slow ~1 Hz mount flex; the hull's real motion still arrives through `mountIsolation`.
4. **Tele**: its camera path was already smooth (rotation 2nd diff p50 0.0014–0.0055°, no reversals; boats' screen
   motion p95 ≈ 0.15 px). Two real faults fixed anyway: the platform's hard aim dead zone (still → chasing in one frame)
   is now a soft ramp; and **boat LODs were derived for the page's 55° camera** — on the 12° tele both boats sat on LOD1
   filling the frame, and on the chase the rival crossed a LOD switch 3 times in a take (pops). The host now re-derives
   LOD distances for every lens (`lodFov` → boatModel `setFov`); the tele now shows LOD0 for both. If the tele still
   reads jittery in the next pass, the remaining suspect is the look pass's 4 subframes strobing fast water detail on a
   long lens (the record uses 16).
5. **Duel colours**: R1's rival was Dome Ten (charcoal + signal yellow → a second orange boat at sunset); now Levee Town
   (white / black) for R1 and Solar Ridge (violet on taupe) for R2. No red/orange/yellow rival at sunset.

## Intro, end, and the slots (post notes, docs/cine/speedboat-trailer-post.md)

- **Slots**: `intro` −8..0 s (fade from black, the build before any boat), `title` 56..60, `end` 60..70 (title + short
  credits). The importer shifts the whole assembly right by the intro's length and marks both as cream range markers.
- **R6 `intro-horizon`** (sunset, `horizonInbound`, calm preset): a slow 22 m push low over the water straight into the
  low sun, 10 s + 2 s handles; the hero comes out of the western horizon on a line 12 m to the lens's side at 25 m/s —
  ~400 m off at t 0, ~150 m at t 10 — so she reads only in the last seconds, the engine on the stem first.
- **R7 `outro-moonroad`** (night, `horizon` line westbound toward the moon, working sea): the R3 chevron passes a
  near-still lens a second before the take and recedes ~250 m down the moon road; wakes settle in front of the lens.
- Both are code/plan only, not headless-checked (R7's rivals keep R3's verified offsets and speeds on another line);
  they render in the final look pass, where the take check and rival crash log judge them. The drowned radio tower is
  not in R6: it stands at (81, −582), not on an open sunset bearing with clear water for a push — a later option.

**Code-side fixes (no render):** `drone-wide` on 08 pulled in to half distance (was 50 m off, 28 m up); duel colours
(above); `insert-rival-whoosh` timing checked against the take 02 trace — the pair passes the lens at t ≈ 4.0 s (hero
x −1191), inside the clip; the sheet's mid-clip frame (t 5) simply came after the pass, no change.

## Spray DOF, broken takes, inserts (verification frames)

- **Spray DOF** (`src/core/skyDof.ts`, owned by the cine work now): the first fix (particles in their own passes over a
  SHARED scene depth texture) destroyed the scene's depth on every resize — "Destroyed texture [depth] used in a submit",
  the page stopped rendering, and a cine record wrote a 48-frame clip of the default page. Replaced by a particle
  COVERAGE pass (spray pools `layers.enable(POST_PARTICLE_LAYER)`, the seam the wake agent added in foam/sprayPool.ts):
  where spray covers a pixel the sharp beauty is kept, like the sky, so a plume reads the same above and below the
  horizon. Evidence: `shots/spray_dof_coverage_mask.png` (coverage in red), `shots/spray_dof_after_horizon_crop_2x.png`.
  Fed into the DOF node's own CoC the coverage never took effect (its CoC pass runs in a private material; before/after
  identical to 0.05 % of pixels) — hence the composite-side restore. Diagnostics: `skyDofDebug.value = 1`.
- **Broken takes fail loudly**: the recorder sends each clip's expected frame count with `/endshot`; the sink writes a
  short take, a take the page failed, or a clip still open at shutdown as `<clip>_FAILED.mov` + `.why.txt` (no proxy, no
  settings key). The host fails a take on any GPU error during it, and at frame 0 on an unarmed drive, a hero > 40 m off
  the shot's line, or a sky clock that is not the shot's time. Session harness: anti-throttling Chrome flags, streamed
  console log, a 20 s no-progress watchdog, a 5-minute session alarm.
- **R5 06c**: sunset and night takes 135/135 frames bit-identical (pose + camera hashes); cut frame = frame 60 (source
  2.000 s). `shots/r5_06c_cut_frame_sunset_night.png`, `shots/r5_06c_frames_57_60_66.png` (reach, grip, push).
- **Inserts** re-placed from a 4-view cockpit probe (`shots/cockpit_probe.png`): `insert-gauges` now behind the wheel
  looking down at the gauge console (+1 stop; the glove partly covers the gauges in the at-speed frame,
  `shots/insert_gauges_v4.png`), `insert-windshield-spray` just behind the glass below its top edge.

## Night (§T.209)

- **Time of day**: `timeOfDay: 'night'` = T209's `MOONLIT_NIGHT` (imported: clock + half moon) through the world patch;
  the LED level is pinned per look (`TIME_LED`: sunset 0, dusk 0.4, night 1) through `boats.lights.setOverride`.
- **Dusk** (10): the first takes rendered a noon-blue sky with white clouds — under the horizon the golden-hour weight
  falls to ~0.2 and the DAY palette paints the sky. Dusk now authors the day hexes as twilight (indigo zenith, slate
  body, rose-amber horizon) at −4°: `shots/dusk_10_fixed.png`.
- **Clouds / wind lines at night** (re-rendered after T209's cloud dimming): clouds are dim grey now; the wind-line
  streaks are still visible across the night sky (`shots/night_16_clouds_windlines.png`) — T209's, not hand-fixed.
- **12 "lunar lander"** (`shots/night_12_drives_exposed.png`): not a jump and not a pose bug — sampled at 20 m/s in the
  carve she is in the water (wetted area 8–12 m², CG 0.5–0.7 m over the sampled sea), yet the drawn surface under and
  behind her stern sits below the lower units, so the legs and props read as hanging in air over her own LED pool. The
  drawn water there is lower than the physics' (wake trough / displacement or the hull water mask being reworked):
  the sea/water-mask agent's, reshoot 12 after it lands.
- **The pack**: R3 night-pack (§Coverage), rivals on scripted drives in the hero's physics (rivals.ts).

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

- **Rival setups R1–R3 are headless-verified, not yet judged on a contact sheet** (coverage look pass). Air hop off a
  wake: not possible on calm at safe speeds (≤ 0.2 s light, 4° pitch); revisit on the `working` preset.
- **Rivals / pack / duel / overtake**: the mechanism exists (`src/speedboat/cine/rivals.ts`: `TrailerShot.rivals` =
  `{ drive, livery?, name? }`, ≤5, the hero's own physics step, mutual wakes and contact, per-rival crash machine,
  LEDs in livery colours; proofs `shots/rivals_duel_calm_t*.png`, `rivals_night_pack_t2.5.png`). No shot data uses it
  yet — the duel, overtake and pack setups are the next step. A duel on `breeze` hooks (sim and browser); `calm` is clean.
- **Hard-mount POV shots** (windshield-back, bow-top aft, POV forward): requested, not built. Bow-top waits for the
  water-mask fix (sea agent).
- **SFX engine/water stems** need a seam in `src/audio/boat` (not ours): `boatAudio.stemTaps(): { engine: AudioNode[];
  water: AudioNode[] }` (engine = `graph.playerEngine` + NPC panners, water = `graph.playerWater`), passed through
  `pageSink.ts` as `stemTaps`. The host already reads it. Mix-only until then; the sync measurement is on the tap, not on
  the synth's own latency.
- **Glove/hand at macro distance** (06): lit and sharp now, but the glove is low-detail and the fingers pass through
  the lever handles instead of wrapping one (`shots/throttle_hand_quality_check.png`) — asset/rig decision.
- **Night sky**: clouds and wind lines read white at night (T209 follow-up, not hand-fixed here).
- **Night swell shots use `calm`** until the sea presets (`calm`/`working`/`open`) land; 12/14a/13/14b/c get reshot then.
  14a's "water through the cockpit": not visible in the calm take; if it returns at a working swell it is the
  water-mask bug (sea agent).
- **08 wake/displacement** is the wake agent's; reshoot 08 after it lands.
- **Two takes of one shot are not deterministic** (cm-level at rest, more after a launch; cause not isolated — ToD is not
  it: sunset vs sunset differs as much). Variants avoid it by construction (looks). Page fixes made on the way:
  raceSession free-roam start now resets `nextRaceTick` (a placement "crashed" with the previous shot's speed) and the
  engines (a take inherited the previous shot's rpm).
- **Capture colour**: the legacy 8-bit sRGB capture double-encodes (washed); the trailer always records through the
  supersampled path, the pirate page still defaults to the legacy one (`record({ samples: 1 })` opts in).
- **No true island channel on Tower Reach** (15 is the Knuckle passage).
- **The carve (11/12) runs through the G7 gate**, 14 m from a flexible pole.
- **Resolve importer** changes (alternates, stems) are untested against a running Resolve.
