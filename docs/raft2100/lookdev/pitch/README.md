# Pitch deck frames — god rays, night, lagoon, sun road

Captured 2026-08-22 from `git archive c8b579c` (HEAD at capture) served by its own Vite on
port 5194 — an isolated snapshot, never the live tree (harness §5). Main pirate game,
`/?at=lagoon`, photo mode (`P`): no HUD, no compass, no Tweakpane, no dev text in any shot.
All four are 1920×1080 PNG read straight off the canvas (`toDataURL` on a foreground tab —
`renderer.setPixelRatio(1)` with the `#app` container pinned to 1920×1080 CSS px, so the
backing store is exactly 1920×1080 regardless of the window).

**The tab was VISIBLE and FOREGROUND for every frame.** The previous attempt's livelock was
a hidden tab (rAF measured at literally 0 ticks/s, `state.time` frozen at 0.22, `toDataURL`
returning one byte-identical image forever). The fix is not a pump: it is
`osascript -e 'tell application "Google Chrome" to activate'` plus putting the MCP tab in
its **own Chrome window on the second display**, so the extension's focus handling cannot
switch the game tab back into the background. Verified before every capture with
`document.visibilityState === 'visible'` and a live rAF counter.

## Files

| file | what |
|---|---|
| `godrays.png` | low sun bursting through the rig, shafts over the water |
| `sunroad.png` | sun disc just above the horizon, road running to camera (T110 / §V22) |
| `night.png` | full moon, moon road, ship under sail, stern lanterns lit |
| `lagoon.png` | showcase lagoon in clean afternoon light |
| `b89/*.png` | evidence for the §B89 god-ray/glint tuning question, not deck material |

## Scene setup shared by all four

| thing | value |
|---|---|
| boot | `/?at=lagoon`, photo mode (`P`) |
| weather | preset `calm` applied via `applyWeatherPreset('calm', {immediate:true})`, then `weatherParams.cellIntensity = 0` and `rainParams.opacity = 0` |
| sea | wind is held ~8 m/s by the §V.46 ambient hold regardless of the preset's 4 — not pinnable, same finding as R0 |
| enemy | `state.ships[1]` parked at (6000, 6000) on a 500 ms interval. **Not cosmetic:** on the first run the enemy sank the player ship (`position[1]` −8.5 m, hull under water, one lantern left) partway through the shoot and three frames had to be thrown away. Any lookdev session longer than ~15 min at `?at=lagoon` needs this. |
| pixel ratio | 1 |
| everything else | `src/params/*.ts` defaults at c8b579c |

`skyParams.timeOfDay` is re-written after every settle wait — `applyWorldSettings` reverts it
(harness §6) and it did revert here.

## Per-frame

### `godrays.png`

* tod **17.55** (sun 6.6° up, due west)
* camera tracked off the live ship each frame (she sails at anchor, a fixed pose drifts out
  of alignment within seconds):
  `sd = [-0.9930, 0.1140, 0.0305]`, `d = 55`, `rig = [ship.x, 17, ship.z + 9]`,
  `cam = rig − sd·d`, `target = rig` — i.e. the camera looks exactly along the sun vector at
  a point 17 m up the rig and 9 m to one side, so the disc sits in the gap between the
  fore and main courses rather than dead behind a sail.
* god-ray params changed from default (the only params changed for this frame):

  | param | default | used |
  |---|---|---|
  | `godRayIntensity` | 0.55 | **1.0** |
  | `godRayLength` | 0.28 | **0.40** |
  | `godRayThreshold` | 1.0 | **0.90** |
  | `godRayDecay` | 0.96 | **0.972** |
  | `godRayFalloff` | 0.32 | **0.50** |
  | `godRayClamp` | 12 | **14** |

  This is a deliberate half-step. An earlier take at intensity 2.2 / length 0.60 /
  threshold 0.50 / falloff 0.90 / clamp 24 is what the user saw and called "completely
  overboard" — see §B89 below. `b89/overcooked-tod17.2.png` is that take, kept as the
  counter-example.
* **Falls short:** the shafts read as thin streaks, not as broad volumetric beams. That is
  what the technique is — a radial blur of a bright pass — and the module says so itself
  ("shafts are made by OCCLUDERS"). The rigging gives you rope-width shafts because the
  ropes are rope-width. Broad beams would need a cloud deck between camera and sun, and
  `calm` has only small fair-weather puffs; the storm presets that do have deck also bring
  rain streaks and a purple sky.

### `sunroad.png`

* tod **17.9** (sun 1.45° up, due west) — the disc is above the sea horizon, not behind land
* camera: `cam = [ship.x + 470, 6.5, ship.z + 198]`, `target = cam + [−1000, +4, −50]`
* **post params: all defaults.** Nothing but `timeOfDay` and the shared weather change.
* **T110 verdict: correct — the apex is a bar, not a pinch.** Measured on this exact PNG,
  luminance rows through the disc and through the road:

  | row | what | width at L ≥ 235 |
  |---|---|---|
  | y 520–540 | the sun's glare, just above the horizon | 123–128 px |
  | y 560–580 | the road, just below the horizon | 112–118 px |
  | y 600–630 | the road, further down | 105–120 px |

  The apex is ~90–95 % of the glare's own width and stays that width all the way to the
  bottom of the frame. The old pinch-to-a-point is gone. Confirmed at a second framing too
  (`sunroad` variant with the island under the sun: disc core 64–74 px at L ≥ 248 against a
  102 px apex bar).
* **Falls short:** the sea is Beaufort-5 rough even on `calm` (§V.46 hold), so the road is
  broken into glitter rather than a smooth cone; and the near-sun band is a touch hot —
  see §B89.

### `night.png`

* tod **19.0**, `moonPhase 0.5`
* camera: `cam = [ship.x − 130, 7, ship.z + 68]`, `target = cam + [+1000, +113, −35]` —
  looking due east at the moon, ship on the road, road running to camera
* all other params default
* **DEVIATION FROM THE BRIEF, and it is geometry, not taste.** The brief asked for
  `timeOfDay ≈ 22`. At `moonPhase 0.5` the moon is opposite the sun, so at 22:00 it is
  **58.9° above the horizon** and there is no road at all — a road needs a body near the
  horizon. Measured from `moonCycle.moonDirection(t, 0.5)`:

  | tod | 18.5 | 19.0 | 19.4 | 20.5 | 21 | **22** | 23 |
  |---|---|---|---|---|---|---|---|
  | moon elevation | 8.5° | **15.8°** | 21.6° | 37.5° | 44.7° | **58.9°** | 72.2° |
  | `nightFactor` | 0.72 | **1.0** | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 |

  19.0 is the earliest hour that is *full* night (`nightFactor` 1, stars out) and still has
  the moon low enough to lay a road. A full moon at 22:00 and a moon road are mutually
  exclusive at this latitude — that is the equinox/opposition model working correctly, not
  a bug. `b89/` does not carry a tod-22 frame; if the deck needs the literal hour it will be
  a high moon and a glitter patch, not a road.
* **B77 verdict: the full moon does NOT bloom hot at the shipped defaults.** The warning in
  B77's report did not reproduce. At `moonGlowStrength 0.9` / `moonHaloStrength 0.2` the disc
  is a clean readable circle with a modest halo, no white hole, no aura swallowing the sky.
  I captured the proposed tame-down (`0.25` / `0.06`) as a control and it is *worse* — the
  moon goes flat and loses the halo the night sky wants. **Shipped defaults kept; no
  follow-up needed on this.**
* lanterns: two stern lanterns lit, visible as warm points against the hull. They are small
  at this range. No lantern param was touched.
* **Falls short (real artifact, worth a look):** a row of short **vertical light bars hangs
  just above the horizon** across the whole sky, ~8–20 px wide, clearly visible in the sky
  band. **It is not the god rays** — an A/B with `postParams.godRaysEnabled = false`
  (`F-night-nogr`) shows the identical bars. Something in the cloud/haze layer is smearing
  vertically above the horizon at night. Not chased; flagged.

### `lagoon.png`

* tod **15.0** (default), all params default except the shared weather change
* camera: fixed pose `setDebugPose([860, 14, 430], [1010, 9, 190])`
* beach, palms, boulders and the shallow turquoise band on the left; ship small on the
  horizon at centre-right
* **Falls short:** the showcase island is a low sandbar from the water — `peakHeight` 14 m
  over a 260 m radius means there is no landmass to silhouette, so the frame is mostly sea
  and sky with a thin strip of land. A dramatic lagoon shot wants either an aerial or an
  island with relief. The sea is also too lively for a postcard lagoon (§V.46 hold again),
  so the sheltered water inside the bay still has whitecaps.

## §B89 — are the SHIPPED DEFAULTS too hot at low sun?

**No. The god-ray defaults are conservative; the "completely overboard" frame was entirely
my capture overrides.** Probed on a pristine reload with every param untouched but
`timeOfDay`, at two framings (open water sun road, and the sun inside the rig), with
`godRaysEnabled` and `bloomStrength` toggled as controls. Fraction of the 1920×1080 frame
that is blown white (all channels ≥ 250):

| framing | tod | god rays on | god rays off | bloom off |
|---|---|---|---|---|
| open water, sun road | 17.6 | 0.458 % | 0.254 % | — |
| open water, sun road | 17.9 | 0.246 % | 0.253 % | **0.089 %** |
| open water, sun road | 18.0 | 0.008 % | 0.005 % | — |
| sun in the rig | 17.2 | 0.485 % | 0.323 % | 0.362 % |

Nothing there is a blowout. God rays add ~0.1–0.2 pp of clipped pixels; **bloom is the
larger contributor** (0.246 % → 0.089 % with it off at 17.9, and mean frame luminance
136 → 118). `b89/defaults-tod17.9.png` and `b89/defaults-tod17.9-bloom-off.png` are that
pair. Exposure 1.1 and `bloomStrength` 0.35 / `bloomThreshold` 1.0 are all fine at low sun.

What I set that broke it, and why each one is a documented trap:

| param | default | my overcooked value | what the source says |
|---|---|---|---|
| `godRayIntensity` | 0.55 | 2.2 | 4× gain |
| `godRayLength` | 0.28 | 0.60 | the docstring: 0.28 caps aureole magnification at 1.39×; **0.65 was the value that produced the user-reported "weird plume"**. 0.60 is 2.5×. |
| `godRayThreshold` | 1.0 | 0.50 | feeds half the sky into the bright pass |
| `godRayFalloff` | 0.32 | 0.90 | the docstring: **at 0.9 this term is inert** — it was raised to 0.32 precisely so it would bound the effect. I put it back to inert. |
| `godRayClamp` | 12 | 24 | §V.44 bound, doubled |

Also worth recording, because it cost me two takes: **`godRayScale`, `godRayTaps` and
`godRaySourceTaps` are BUILD-TIME** (the params file says so — `Loop` bounds must be
literal). Writing them live does nothing; `godRayScale = 1.0` was a silent no-op.

**Proposed shipped change: none for the god rays.** If anything the defaults are *under*-
stated — at 0.55/0.28 the shafts are barely legible as shafts even with the sun behind the
rig. If the owner wants them to read without going near the overcooked zone, the frame I
shipped is the recommendation: **intensity 0.55 → 1.0, length 0.28 → 0.40, threshold
1.0 → 0.90, decay 0.96 → 0.972, falloff 0.32 → 0.50, clamp 12 → 14.** That is 1.8× gain and
1.4× reach, well inside the module's own stated safe zone, and it measured no worse than
default for clipping.

## §B89 — the near-sun glitter on the water

Endorsed by the user except for intensity: *"a tad too much on the RAYS ON THE WATER towards
the sun"*. **This is a shipped-default observation, not a capture setting.** I never touched
a single `oceanSurfaceParams` value in this session — `sunroad.png` is the defaults.

Measured on `sunroad.png` itself, in the road band under the sun (x 780–1020, below the
horizon) against a matched off-road patch on the same rows:

| region | L ≥ 250 (clipped) | L ≥ 240 | L ≥ 200 |
|---|---|---|---|
| road band | **8.0 %** | 18.9 % | 49.5 % |
| off-road sea | 0.0 % | — | 3.4 % |

Where it comes from, from `src/ocean/surfaceMaterial.ts`:

```
road = NDF · vis · F · N·L · π · uLightGain · uGlintRoad · srcEnergy   clamped to GLINT_RADIANCE_MAX
```

* **`srcEnergy` is the suspect, and the file already admits it.** It is the §V92
  representative-point normalisation `(σ/(σ + tan(r/2)))²` — the same change that widened
  the apex into the bar the user just endorsed. Its own docstring measures it at
  **0.97–1.2× at 30–60° elevation but 1.4–3.5× at 1–5°**, i.e. it over-delivers energy by up
  to 3.5× at exactly the sunset elevation this frame is shot at. The width is right and the
  radiance rides along with it.
* **`GLINT_RADIANCE_MAX = 32` is not the knob.** Its comment is explicit: ACES reaches 0.97
  of white at scene-linear 4, so it "cannot change a shipped frame" — it exists to stop an
  Inf reaching bloom. Lowering it to bite (below ~8) would chop the mirrored disc's plateau
  flat, which is a different and worse artifact.
* **`specularAaMax` / `slopeVarianceAa` are not the knob either** — those set lobe WIDTH,
  and width is the part the user said to leave alone.
* **`sky.exposure` is not the knob** — it is global and would darken the whole frame to fix
  one band.

**Recommendation — one knob, sanctioned by its own docstring:**

| param | file | current | suggested |
|---|---|---|---|
| `glintRoadStrength` (`uGlintRoad`) | `src/params/oceanSurface.ts` | **1.0** | **0.75** (try 0.70–0.80) |

Its comment reads *"Turn it DOWN, never up, and only for look"* — this is precisely that
case. It scales the road's radiance and nothing else: the lobe width, the apex bar and the
T110 source-disc behaviour are untouched, so the endorsed geometry survives. 0.75 takes the
1.4–3.5× low-sun over-delivery back toward 1.05–2.6×, and should drop the road band's
clipped fraction from 8.0 % to roughly 2–3 % — worth re-measuring in the browser with the
same script rather than trusting that estimate.

If the complaint turns out to be the discrete **sparkle train** riding on the road rather
than the smooth road itself, the equivalent one-knob fix is
`sparkleDensityTrain` **0.82 → 0.87** (thins the hash inside the sun path) or
`sparkleStrength` **1.0 → 0.8**. Those are separate terms from `road` and can be moved
independently.

## Console

Clean. No errors, no `[gpu] uncaptured error`, no NaN warnings across the whole session
(three page loads). The extension's console reader only starts capturing at first call, so
boot-time output from the final load is not in that window — nothing was surfaced in the
page either.
