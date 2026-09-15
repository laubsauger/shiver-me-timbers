# Speedboat race HUD and screens (§T.185)

Code: `src/speedboat/ui/`. Harness: `speedboat-ui-harness.html` (`npm run dev`, then open
`/speedboat-ui-harness.html`). Look: design doc §9 "stencil and signal" and its 7 mockups
(artifact 9820b95d), sized down after user feedback on 2026-09-13.

## Wiring (page, §T.181)

```ts
injectSpeedboatUiCss(); await loadSpeedboatFonts();
const hud = new RaceHud(document.body); hud.setCourse(prepareCourse(course)); hud.setRoster(buildRoster(paintId, number));
const model = createRaceHudModel(8); const tel = createHudTelemetry(8);
// every frame
updateRaceHudModel(model, raceState, hudCourse, playerId, tel, dt);
dash.update(model, dt);                 // page/dashMount.ts: needles every frame, canvases at DASH_HZ, only while in view
hud.setDashCovers(dash.legible);        // cockpit overlay drops trim + speed while the dash reads
hud.update(model, dt);
pause.poll(now); results.poll(now); select.poll(now);    // gamepad, only while open
```

- `RaceHudModel` (model.ts) is one flat mutable struct, filled in place. `updateRaceHudModel` allocates nothing.
- `HudTelemetry` is what only the page knows: speed, rpm ×3, trim, pitch, airborne, pose, camera, Governor,
  every racer's x/z/heading, the next gate's screen projection, crash detail, radio calls, toasts.
- `hud.setVisible(false)` while pause, results or select is up. `hud.resize(w, h)` on window resize.
- `hud.setScale(s)` applies the HUD size option (`HUD_SCALES`: Small 0.85, Default 1, Large 1.15). The page
  persists it (settings store).

## Layout

- Unit `--u = min(100vw/1280, 100vh/720)` (the mockup frame). The race HUD uses `--hu = --u × --hud-scale`.
- Panels are data (`CHASE_PANELS`, `COCKPIT_PANELS` in layout.ts). The stylesheet is generated from those
  rects, so `placePanel()` is exactly what the browser gets. The frame is capped at 21:9, centred.
- §B121: nothing sits in the lower centre (the wake) or the central 40% except the gate marker and toasts.
  The keep-outs scale with the scene width `min(vw, vh·16/9)` because three.js keeps the vertical FOV.
- Chase: position + lap and the three nearest places top left; lap clock and radio strip top centre; north-up
  plotter top right; sea chip + trim/pitch dial bottom left; Surge cells + LED tach + knots + Governor
  bottom right.
- Cockpit: position/lap, the gaps either side, radio strip, gate marker, and compact trim + speed panels (user
  2026-09-14: trim must be visible in every view). Surge, Governor and the plotter belong to the dash.

## Live dash (§T.208, `ui/dash.ts` + `page/dashMount.ts`)

The hero's modelled dash carries live instruments, fed the same `RaceHudModel` as the HUD:

- Tablet: the plotter canvas (course, rivals, player arrow, next mark, lap and clock), repainted at `DASH_HZ` (10).
- Gauge glasses, one canvas tile each: tach face, LED knots + Surge lamps over a Governor lamp (OFF dark, AIR
  amber, FULL orange), trim face. The faces paint once; the middle tile repaints only when knots, Surge or the
  Governor change. The GLB's baked needles are covered.
- Needles: two quads over the tach and trim faces, turned every frame (a quaternion, no repaint). The trim needle
  reads drive trim (`TRIM_DIAL_DEG` over ±60°), not hull pitch. The Governor knob turns to its detent.
- When: by what the lens sees, not the camera mode (`dashScreenRadius`). Below `DASH_VISIBLE_MIN` (gauge radius
  ≈ 9 px at 1080p) nothing poses or paints, so chase costs nothing and a trailer insert at the gauges is live.
- `legible`: every gauge WHOLE inside the frame (clear of the edge by its own size + 2 % of the height) with radius
  ≥ 3.7 % of the viewport height (≈ 40 px at 1080p, numerals ≈ 11 px), dropping below 3.1 % (hysteresis). While legible
  in the cockpit camera the overlay hides its trim and speed panels (`.is-dash-live`); look back, look up or drop the
  dash out of frame and they return, so trim is always on screen somewhere. In the default cockpit view (eyes on the
  horizon) the gauges sit at the bottom edge and are NOT legible, so the compact panels stay — they go only when the
  pilot's view actually frames the dash (glancing down, over-the-shoulder and gauge inserts in the trailer).
- Light: unlit screens × `dashBrightness(LED level)`: 1 by day, 0.75 at full night (the night preset's LED level).
- Cine: `ui.update(frame, cine.active)` runs only the telemetry → model → dash path while a shot is cued (no HUD).
- Failure: a throw while mounting or updating logs once and drops the dash; the page keeps running.
- Measured (1080p, headless Chrome under the GPU lock, 2026-09-15): `dash.update` 0.019–0.030 ms mean per frame
  (max 1.9 ms on the first paint of the faces), +4 draw calls, no new sampler outside the dash materials; the GPU
  delta of the four quads was below the noise floor of a loaded machine.

Size cut on 2026-09-13 (user: "too large and chunky"): corner blocks as a share of a 16:9 viewport went
TL 7.8 → 3.9 %, BL 6.4 → 3.3 %, BR 6.3 → 3.3 %, TR 3.7 → 2.3 %, all planes 25.3 → 13.6 %.
Position numeral 96 → 60 u, knots 66 → 44 u, plane alpha 0.82 → 0.66, meters thinner. At the default size
the design doc floor still holds at 1080p (position ≥ 88 px, speed ≥ 64 px), and at 1280×720 on Small
no HUD text is under 8 px (tests/speedboatUiLayout.test.ts).

Plotter is north-up, not heading-up. Over three laps the circuit is learned as a shape, and a fixed shape
is what makes "two corners behind Crosswind" readable at a glance. The gate marker in the 3D view already
does the "where do I steer" job.

## Performance

DOM + CSS + inline SVG. Every per-frame write is a `Text.data` from precomputed tables (text.ts), an SVG
animated value (`cx.baseVal`, `SVGTransform.setRotate`), a cached class flag, or a table transform
string. No innerHTML, no string building, no layout reads in `update*`. String building (crash cause,
conditions) lives in `rebuild*` methods called behind a change check. This is enforced by a source scan in
tests/speedboatUiHotPath.test.ts. The harness bar shows the model + HUD update cost.

## Screens

- Rolling start + countdown: tower lamps (race logic's `lights` when present), called number, grid chip,
  conditions, start rules under the radio strip.
- Crash: letterbox, desaturating tint, cause with numbers, slow-mo tag, race control's call, Governor fuel cut
  + respawn bar, place before → now. Ghost: a chip with a draining bar under the position block.
- Results: order, pilot · community, per-lap times, classified time or gap, best lap with the fastest lap
  marked, your race stats (page-supplied), tower broadcast, Race again / Watch replay (disabled until P5) / Menu.
- Hull & paint: V-39 spec sheet, 8 community paints, number (skips rival numbers), eyewear, sea/time/rivals.
  §T.201: no hull art of its own (the SVG sketches and `hullArt.ts` are gone; roster.ts keeps only name, HUD hue
  and the livery join). The page (`page/boatPreview.ts`) renders the runtime GLB + seated hero pilot through the
  slot materials in each livery (`liveryFor`, read from `assets/livery.ts` at call time) and hands the cards
  their pictures with `setPaintThumb(paintId, dataUrl)`: lazily on the first open, cached per paint + number, one
  offscreen render + one readback each (the card shows its hue chip until then). `onPreviewMount(host)` starts
  the live turntable, drawn on the game canvas in the host's rect (view offset + scissor, no readback) on an
  in-engine stage (sea-horizon gradient, livery-hue water glow, contact shadow); `setPreviewLive(true)` cuts a
  clipped-corner hole in the dim over it. Drag to orbit, idle auto-rotate. Eyewear is not visualised (the pilot
  GLB has one lens material and the race never applied the choice).
- Pause: Resume, Restart, Boat select (Back returns to the paused race), Governor, Assists (preset Default/Pro plus
  dials), Camera, HUD size, Audio, Graphics (quality preset, the shared settings store), Full screen, Dev
  overlays, Quit. Open with Esc, gamepad Start, or the small pause button left of the plotter (`addPauseButton`).
  §T.201 pad fix: `MenuNav.attach` takes the pad's held buttons as already seen, so the Start that opened the pause
  is not read as Back (= Resume) on the next frame.
- Page chrome (`page/pageChrome.ts`): dev overlays (perf HUD + Tweakpane, via `ui/devLayer.ts`) are hidden by
  default; Tab/F1 or the pause row toggles them and the choice is remembered (`smt.speedboat.devOverlays`,
  guarded storage); `?dev` forces them on, `?dev=0` off. Full screen: `F`, Alt+Enter or the pause row, through
  `ui/fullscreen.ts`. The speedboat has no pointer lock.
- Navigation: arrows/WASD, Enter/Space, Esc/Backspace; gamepad D-pad or left stick with repeat, A, B, Start;
  pointer hover and click. Left/right change values in place on rows that have values.

## Fonts (self-hosted, COEP same-origin)

`assets/fonts/speedboat/`: Saira Stencil One (SIL OFL 1.1, no reserved font name) and Saira Condensed
SemiBold/Bold (SIL OFL 1.1, reserved font name "Saira"). Both come from github.com/google/fonts. They were
converted TTF → WOFF2 with fontTools, keeping every glyph and the original names. That is a container
change, not a subset, so the reserved font name is not engaged. The licence texts sit next to the files.

## Open items for other owners

- Race logic (§T.184): per-racer world pose is not in `RaceState`, so the page feeds it through telemetry.
  Crash kind, peak g, stop time, respawn and ghost timers are not in `RaceState` either (§T.188). There are
  no radio-call events (§T.183), and nothing marks `lapTimes` as indexed by `racerId`; the HUD assumes it is.
- Assets: `livery.ts` holds the STYLE-SPEC four-boat table. The HUD's 8 community paints (roster.ts) need
  their matching `liveryKey`s.
- The design doc countdown mockup puts the radio strip lower centre. The HUD keeps it top centre (§9 rule
  and §B121).
