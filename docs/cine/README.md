# Rendering the piece

The shot script is [warfish-alan-watts-camera-script.md](warfish-alan-watts-camera-script.md).
This is how you shoot it.

```
src/cine/shotlist.ts   the timeline, as data — every number in the script doc
src/cine/director.ts   (shot, time) -> a camera pose and a world state
src/cine/recorder.ts   owns the frame clock; drives capture; POSTs each frame
src/cine/capture.ts    renderer -> raw RGBA, without the compositor
src/cine/pump.ts       drives rAF from a worker so a hidden tab still renders
scripts/cine-sink.mjs  receives raw frames, encodes one clip per shot
scripts/cine-mux.mjs   per-shot clips -> one film, dissolves and all
```

## It is an offline renderer, not a screen capture

Nothing here runs in real time or needs to. The recorder owns the clock:

```
advance exactly 1/fps -> render -> read the pixels -> FREEZE (dt 0) while the
frame is encoded -> unfreeze -> advance exactly 1/fps
```

A frame may take four seconds of wall clock; the world still advances by
exactly 1/24 s. Output timing is a property of the script, not of the machine
that rendered it. Wobble, key interpolation and the sun solve are all pure
functions of shot-local time, so re-rendering frame 412 gives back frame 412.

The freeze is `GameLoop.setFixedDt(0)` rather than stopping the loop, because
rAF has to keep turning across the readback (agent-browser-harness.md §3).

## Shoot it

```bash
npm run cine:sink
```

```bash
npm run dev
```

Open `http://localhost:5173/?cine=record`, or from the console once the game is
up:

```js
__game.cine.record()                                         // 1920x1080 @ 24
__game.cine.record({ only: ['H1','D','M','O'] })             // build-order set
__game.cine.record({ only: ['D'], width: 3840, height: 2160, fps: 30 })
__game.cine.stop()
```

Resolution is independent of the window: `setRenderSize` moves the **renderer**
(so the post pipeline's scene pass moves with it) and the window size is put
back when the run ends. Then:

```bash
npm run cine:mux
```

which writes `out/cine/warfish.mp4`.

To eyeball a shot without recording:

```js
__game.cine.play()      // the whole timeline at wall clock
__game.cine.play('D')   // one shot, looping
```

## An mp4 is not a file until its encoder closes

The single worst failure this pipeline has had, and the one to recognise fast:
**every clip of a finished 1440p run was unplayable.** Nothing was wrong with
the pixels. An mp4 only becomes readable when ffmpeg writes its `moov` atom at
the very end, and every shot's encoder was being held open until the run posted
`/done` — so 23 ffmpeg processes sat on 23 headerless files, and any
interruption at all (a closed tab was enough) cost the entire run.

Three things now stop it:

- **A shot's encoder closes the moment that shot ends** — on `/endshot` from the
  recorder, and again if a new shot's first frame arrives while an old encoder
  is open. The worst an interruption can cost is the shot in progress.
- **In-progress clips are named `.part`.** "Not finished" is visible in `ls`,
  not only in QuickTime's error dialog.
- **`SIGINT`/`SIGTERM` finalise before exit**, so Ctrl-C on the sink still
  leaves playable files. `-movflags +faststart` puts the `moov` at the front.

If you ever do end up with headerless clips — an older run, a `kill -9` — the
encoders can usually still be talked into finishing, because the data is
already down the pipe:

```bash
pkill -INT -f rawvideo     # ffmpeg finalises on SIGINT; SIGKILL loses the file
```

## Output is one clip per shot, in timeline order

The sink writes `out/cine/seg/04-D-stern-chase-the-money-shot.mp4` — ordinal,
shot id, slug. The ordinal is the shot's place in the FULL timeline, not in the
run, so re-rendering one shot on its own drops a file that still sorts into the
edit where it belongs. Cut them by hand, or run the mux to stitch them.

Iterate on one shot without touching the rest:

```js
__game.cine.record({ only: ['D'] })
```

## What it costs

Measured, 1280x720, hidden tab, `only: ['D']`: **398 frames in 20 s — ~20 fps
of render.** The full 240 s piece is 5760 frames, so about **5 minutes** at
720p; 1080p is roughly 2x that and 4K rather more.

It was a hundred times slower than that until the loop stopped drawing frames
nobody sees: the world is frozen at `dt = 0` while a captured frame is read
back and encoded, so every rAF in that window was rendering a full frame
identical to the one already in hand and throwing it away. `Recorder.idleFrame`
skips the draw.

There is no PNG sequence: frames go to the sink as raw RGBA and come back as
one mp4 per shot, so a full render costs a few hundred MB rather than ~6 GB of
stills.

## Watching a render

The canvas does **not** update during a shoot — frames go to an offscreen
target, so the picture is frozen and the game's FPS counter reads zero. That is
correct, and indistinguishable from a hung page, so the shoot puts its own
readout along the bottom of the window:

```
● REC  D  shot 1/1  capture  212/398 (53%)   19.9 fps (0.1s/frame)
elapsed 0m11s   left 0m09s   · canvas frozen on purpose
```

The game's own UI is hidden for the duration. It was never in the captured
frames — capture reads a render target, not the canvas — but leaving it up
means what you see is not what is being shot.

## The set is struck before a frame is shot

The reference is open ocean and nothing else, so `setShooting(true)`:

- hides the archipelago (`archipelago.group`),
- hides the enemy hull, her rigging and the combat FX group,
- suppresses the gunnery crosshair, which is an in-WORLD overlay and would
  otherwise land in frame (the DOM HUD never does — capture reads a render
  target, not the canvas),
- and `prepareScene` jumps to the `spawn` anchorage: 45 m of water, no land in
  reach. The boot berth is over the shelf in ~10 m and has an island on the
  horizon.

`holdScene` re-asserts it every tick, and also zeroes the hero's flood and
damage. That is not housekeeping — see below.

## The weather stands still for a take

Clouds were popping in and out mid-clip. The cloud system was not
misbehaving — it was working: `clouds.update` regenerates every cluster when
the storm CELLS near the camera change (`stormCellKey`), and a cinematic camera
moves hundreds of metres inside one shot. The stern chase closes 40 m; the high
aerial sits 600 m up. Each crossing is a ~400-lobe rebuild, which reads as a sky
re-dealing itself while you watch.

So a shoot switches the cell FIELD off rather than suppressing the rebuild:

- `cellCoverage`, `cellIntensity`, `cellDrift` -> 0 for the duration. No cells,
  no cell key, no regeneration — and `weatherAt` returns the flat ambient
  preset everywhere, which also stops the §V.46 sampler walking the sea state
  around under a moving camera.
- `weather.update(dt)` is skipped: it advances the field drift and the per-cell
  lifecycle clock, both of which keep changing the answer even at zero
  coverage.
- `transitionSeconds` -> 0. A shot is a cut; lerping into its sea over the
  first 96 frames puts the transition in the picture.

Band drift and the composite's own time still run, so the sky moves — it just
stops being re-dealt. Everything is restored when the shoot ends.

Verified on the 16.6 s stern chase: `select='gt(scene,0.02)'` finds nothing but
frame 0.

## The shooting tier

`?cine=…` forces the top of every graphics ladder before the renderer is built:
`applyQuality('high')`, `resolutionScale: 1`, `shadowMapSize: 4096`,
`foliageDensity: 1`. It has to happen at boot — the shadow map is allocated
once when the sky is built and `resolutionScale` sizes the backing store, so
applying either later is a no-op that looks like a setting.

Output defaults to **1920x1080**. Named sizes, or any exact pair:

```js
__game.cine.record({ res: '1440p' })          // 2560x1440 — also '2k'
__game.cine.record({ res: '4k' })             // 3840x2160
__game.cine.record({ width: 2048, height: 858 })   // anything you like
```

or on the URL: `?cine=record&res=1440p`. Cost scales with pixels — 1440p is
about 1.8x 1080p, 4K about 4x.

## Sound

SFX and ambience, no music, as a second pass:

```js
__game.cine.recordAudio()                 // every shot
__game.cine.recordAudio({ only: ['D'] })
```

or `?cine=audio&only=D`. It drops `04-D-….webm` beside the clip, and the mux
lays each take back onto the timeline at that shot's own IN point.

**It has to be a second pass.** The video is rendered offline — a frame takes
as long as it takes and the world advances by exactly 1/fps regardless. An
AudioContext has no such freedom: it runs on the wall clock and cannot be
stepped, so recording it during a 20 fps-of-render pass would stretch the
soundtrack by whatever the machine was doing. The audio pass therefore replays
each shot at REAL speed — same camera, same preroll, same fixed 1/60 sim — so
the same events land at the same shot-local times and the two passes line up.

Music is excluded by tapping the SFX and ambience buses rather than the master:
a bed under the picture is an edit decision, and a piece scored to Alan Watts
does not want the game's playlist under it. The tap goes in through
`audio.attach`, the §V95 seam, so there is still exactly one audio path.

The page needs one click before the audio pass — browsers will not start an
AudioContext without a gesture, and the run says so rather than writing an
empty file.

## The grade is a mode, not a render side effect

`src/grade` has named modes, applied as a batch of writes into the live params
— the same shape a weather preset is:

```js
__game.setGradeMode('cine')   // crushed blacks, early bloom, warm/cool split,
                              // grain, heavy vignette, DOF on
__game.setGradeMode('game')   // back to the shipped look
__game.getGradeMode()
```

A shoot switches to `cine` on start and back to `game` on finish, so you can
A/B the shooting look live in the game rather than only in an mp4. The `game`
mode is snapshotted from the params' own defaults at import time rather than
hand-copied — a hand-copy is a second opinion about the shipped look and goes
stale the first time anyone tunes the real one. Going back to `game` restores
the FULL snapshot, so a shot's own per-shot post overrides cannot leak into the
game's look after a shoot.

## Sun position is set by ELEVATION, not by a clock time

`sunElevationDeg` in a shot's world patch is solved to a `timeOfDay` against
the engine's own `sunElevation`, so the number keeps meaning the same thing if
anyone touches `latitude`.

Two calibration facts about this sky, both measured, both counter-intuitive:

- **It is still broad daylight at −6.5°.** Shot D was written at 05:33 on the
  reasoning that it is "blue hour" and rendered as a bright blue afternoon with
  lit cumulus. `nightFactor` does not reach 1 until roughly −12°.
- **The key light at night is the MOON, not a dimmed sun.** `sky.sunDirection`
  is "the sun by day, the moon at night", and at −41° the moon sits at y=0.68
  with intensity 0.75 — which is why the first night shots came out a bright
  moonlit blue. The darkness of a night shot is set with `moonIntensity` and
  `moonPhase`, not by going later.

The elevations in the shot list are a first calibration against rendered
frames. Treat them as a starting point and trust the output, not the numbers.

## Things it will tell you about loudly

Each of these cost a take before it was caught:

- **The enemy AI sinks the hero during preroll.** The first recorded shot came
  back as empty water: two broadsides had gone in during a 10 s preroll and she
  was on the seabed with `flood: 1` before frame one.
- **A hidden tab renders nothing.** Chrome throttles rAF to zero in a
  background tab and the loop silently stops. `pump.ts` drives it from a worker
  instead; on by default (`record({ pump: false })` to disable). A watchdog
  reports a stall every 5 s rather than leaving a half-written output that
  looks finished.
- **A dead readback looks exactly like a still shot.** Every frame is hashed
  and three identical ones in a row abort the run.
- **A short clip is a render that died.** The mux warns per shot when a clip is
  shorter than the manifest says.
- **A wrong-sized frame is a diagonal smear.** The sink rejects any frame whose
  byte count is not `w*h*4` rather than letting ffmpeg encode the padding.

## Three capture approaches, and why it is the third

1. **`canvas.toDataURL()`** — the browser will not composite a hidden tab's
   WebGPU surface, so every frame is whatever was on screen when the window
   lost focus. Measured: 173 rAF callbacks, the lens moved 400 m, three reads
   byte-identical.
2. **Render target + `OffscreenCanvas.convertToBlob`** — the readback is fine,
   but the PNG encode is a task the browser may deprioritise, and in a hidden
   tab at 1080p it simply stops: *"convertToBlob did not finish in 20000ms"*.
3. **Render target + raw RGBA to node** — what it does now. Nothing is encoded
   in the browser; ffmpeg in the sink does it, and nothing throttles node.

One more trap inside (1) and (2): `post.render()` re-composites a **stale
scene texture** unless `renderer._nodes.nodeFrame.update()` is called first,
because `PassNode` is `NodeUpdateType.FRAME` and three's `Animation` module —
which bumps that id — never runs in this app. This was isolated by running the
same capture loop both ways: three different frames through `renderer.render()`,
three identical ones through `post.render()`. `Capture.bind()` bumps it.

## Two things the mux does not do

- **Titles are not burned in.** This ffmpeg has no `drawtext` (built without
  libfreetype). The last 15 s is black; the exact `drawtext` line is printed at
  the end of a mux run for a freetype build, otherwise add the cards in an
  editor.
- **Audio.** `node scripts/cine-mux.mjs --audio vo.wav` muxes a track in.
