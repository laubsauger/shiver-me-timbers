# Camera script — "Warfish / Alan Watts" reference reconstruction

Source: `Copy of Warfish Alan Watts no logo.mp4` — 239.86 s, 1280×720, 23.976 fps.
Purpose: prove our engine can shoot an approximation of this piece. Timed script:
events, camera motion, framing, light, weather, post. **People and animals are
out of scope** — their shots are re-cast onto ship/sea/light subjects at the same
lengths so the *edit* survives even though the *content* changes.

Hull: **brigantine** (`src/params/ship.ts:brigantineParams`, ~30 m LOA), not the raft.
The reference boat is a ~13 m downeast trawler, so every camera distance and
altitude below is the reference framing scaled ×2.3 to hold the same subject size
in frame. See §6 for the "recreate the yacht instead" option.

Axis convention used throughout (repo convention, `src/combat/battery.ts:42`):
ship-local **+Z forward, +Y up, +X starboard**. `SHIP` = ship origin at the
waterline. Distances metres, angles degrees, `alt` = height above mean water.

---

## 1. What the reference actually is

A 4-minute tone piece with a single dramatic arc and almost no events:

| Act | Time | Content | Function |
|---|---|---|---|
| I | 0:00–0:46 | pre-dawn, ship as a speck and a wake in blackness | isolation, scale |
| II | 0:46–1:45 | sunrise, warm, the tightest cutting in the film | arrival, warmth |
| III | 1:45–3:00 | night, the ship a single point of light | isolation again, but earned |
| IV | 3:00–3:45 | fog, then nothing | dissolution |
| V | 3:45–4:00 | black, titles | — |

**Mean shot length 11.4 s.** There are 19 shots in 240 s. Every cut lands on a
held frame, never on action. The only tempo change in the whole film is a cluster
of 3.5–6 s cuts at 1:11–1:45, and it is doing the work of "the day starts".

Three rules the reference never breaks, and neither should we:

1. **The subject is small.** The ship is 5–15 % of frame width in every wide.
   That is what makes the water read as an ocean rather than a pool.
2. **All camera motion is low-frequency.** Locked, drone-smooth, or riding the
   swell. No whip pan, no crash zoom, no orbit, no handheld shake anywhere.
3. **Blacks are crushed to nothing and highlights are allowed to clip hard.**
   Half the frames in Act I are 95 % pure black. The sun and the work light are
   blown to paper white with no rolloff.

---

## 2. Global look (set once, before any shot)

```
post.grainEnabled   = true
post.grainAmount    = 0.012     // default 0.006 is too clean for this
post.vignetteEnabled= true
post.vignetteStrength= 0.50
post.vignetteStart  = 0.38
post.vignetteEnd    = 0.80
post.bloomEnabled   = true
post.bloomThreshold = 0.65      // low — this film blooms early
post.bloomStrength  = 0.85
post.bloomRadius    = 0.70
post.godRaysEnabled = true
post.dofEnabled     = true      // OFF by default in the repo; the piece needs it
post.vibrance       = 0.10

grade.liftR/G/B     = -0.010 / -0.012 / -0.008   // crush, cool-biased
grade.saturation    = 0.92
grade.splitStrength = 0.35
grade.splitPivot    = 0.45
grade.shadowTint    = cool blue    (≈ 0.42, 0.48, 0.62)
grade.highlightTint = warm amber   (≈ 0.62, 0.53, 0.40)
```

Frame is **16:9, no letterbox**. The reference is not scoped.

Titles use a small-caps serif at ~55 % opacity, hairline rule above the name.

---

## 3. Shot table

`◼` hard cut · `≈` cross-dissolve · `▼` fade

| # | In | Out | Dur | Rig | Subject | Light |
|---|---|---|---|---|---|---|
| A | 0.00 | 7.22 | 7.2 | locked, waterline | sun only | dawn, sun +2.5° |
| ◼ | | | | | | |
| B | 7.22 | 16.0 | 8.8 | high aerial, held | ship enters, tiny | nautical twilight, sun −6° |
| C | 16.0 | 29.65 | 13.7 | high aerial, held | ship + diagonal wake, title card | sun −5° |
| ◼ | | | | | | |
| D | 29.65 | 46.25 | 16.6 | **stern chase, slow push** | wake V, ship enters top | sun −3°, blue hour |
| ◼ | | | | | | |
| E | 46.25 | 56.5 | 10.3 | aerial abeam, parallel track | ship in profile | sun +1.5°, first warmth |
| ≈ | | | | | | |
| F1 | 56.5 | 62.0 | 5.5 | helm station, static | rig against sun | sun +2° |
| ≈ | | | | | | |
| F2 | 62.0 | 66.0 | 4.0 | deck dolly fwd | deck → bow | sun +3° |
| ≈ | | | | | | |
| F3 | 66.0 | 71.74 | 5.7 | deck, static | **flare blowout** | sun +4°, godrays max |
| ◼ | | | | | | |
| G1 | 71.74 | 77.70 | 6.0 | stem cam, 1.5 m | bow wave, gold foam | sun +5° |
| ◼ | | | | | | |
| G2 | 77.70 | 81.21 | 3.5 | stem cam, tighter | bow wave | sun +5° |
| ◼ | | | | | | |
| H1 | 81.21 | 85.54 | 4.3 | waterline, bobbing | sunstar + mirror path | sun +1° |
| ◼ | | | | | | |
| H2 | 85.54 | 93.93 | 8.4 | waterline, bobbing | same, wider | sun +1° |
| ◼ | | | | | | |
| I1 | 93.93 | 99.60 | 5.7 | deck, rail diagonal | rail + lantern silhouette | sun −2°, dusk band |
| ◼ | | | | | | |
| I2 | 99.60 | 104.81 | 5.2 | deck, matching angle | same | sun −2° |
| ◼ | | | | | | |
| J | 104.81 | 116.4 | 11.6 | waterline macro, long lens | **abstract gold glitter** | sun +1°, dusk |
| ◼ | | | | | | |
| K | 116.4 | 121.04 | 4.6 | high aerial, held | ship at rest, lamps on | night, moon 0.6 |
| ◼ | | | | | | |
| L | 121.04 | 143.81 | 22.8 | waterline → subsurface | split-level, under the hull | night, lantern only |
| ◼ | | | | | | |
| M | 143.81 | 154.32 | 10.5 | **extreme high, locked** | ship = one point of light | night, no moon in frame |
| ◼ | | | | | | |
| N1 | 154.32 | 158.0 | 3.7 | deck CU | binnacle / radio set glow | night |
| ◼ | | | | | | |
| N2 | 158.0 | 180.26 | 22.3 | waterline alongside | black sea, lantern spill, island resolves | night |
| ◼ | | | | | | |
| O | 180.26 | 190.86 | 10.6 | waterline off the bow | **bow + work light in fog** | fog, sun 0 |
| ◼ | | | | | | |
| P | 190.86 | 196.0 | 5.1 | waterline, closer | bow slides out of frame | fog |
| ◼ | | | | | | |
| Q | 196.0 | 225.0 | 29.0 | inside the fog, drifting | nothing | fog |
| ▼ | | | | | | |
| R | 225.0 | 240.0 | 15.0 | — | logo, titles, credits | black |

---

## 4. Shot cards

### A · 0.00–7.22 · Sunstar, locked
Long lens straight into the sun sitting just clear of the horizon. Sun at frame
`(+0.30, +0.28)` from centre. Water is a blackened out-of-focus wedge in the
lower-left corner. Reads as one held image, not a shot.

```
cam.pos     = SHIP + (0, 1.5, 0) — anywhere, the ship is not in frame
cam.aim     = sun, offset so the disc sits upper-right third
fov         = 20            // long lens, compresses the star
sky.timeOfDay = 5.95        // or 18.60 for the dusk read
sun elevation = +2.5°
weather     = 'glass'
sky.hazeStrength = 0.35
post.godRayIntensity = 1.4, godRayLength = 0.45, godRayTaps = 64
post.bloomStrength   = 1.2
post.dofFocus = 200, dofRange = 400   // horizon sharp, foreground water mush
```
Motion: **micro-wander only** — yaw and pitch each ±0.4° on a 0.06 Hz sine,
phase-offset. Enough that it is not a still.

> Gap: the reference's coloured ghost/bokeh chain running down-left from the sun
> is a physical lens artefact. We have godrays and bloom, not a flare ghost
> chain. See §6.

### B · 7.22–16.0 · Black, and something in it
Hard cut from a blown white frame to near-black. Deliberate exposure whiplash —
the audience's eye has to adapt, which is why nothing happens for 3 s. The ship
enters lower-right at ~10 s as a pinprick of warm lamp plus a wake thread.

```
cam.pos  = SHIP + (+180, 90, -190)  → ship in the lower-right third
cam.pitch= −42°
fov      = 40
sky.timeOfDay = 5.10      // nautical twilight, sun −6°
weather  = 'calm'
lanterns on, intensity 10
starfield visible
```
Ship makes 8 kn on a steady heading. Camera holds a fixed world pose; the ship
closes toward frame centre on its own. **Do not track it.**

### C · 16.0–29.65 · High trail, title card
Same altitude family, recomposed: ship in the **upper-left third**, wake running
as a hard diagonal to the lower-right corner. The wake is the only luminance in
the frame and it is doing all the composition.

```
cam.pos  = SHIP + (+95, 85, -150)
cam.pitch= −38°, yaw slowly matched to ship heading (half-life 4 s)
fov      = 40
```
Title, lower-left third, ~55 % opacity small-caps serif: fade in 16.0–17.5,
hold, fade out 25.0–26.5. Reference reads `41.388°N 71.515°W`; ours should be a
Sierra-2100 coordinate.

Requires: wake foam (`flowFoam`) carrying legibly at 85 m altitude in near-zero
light. This is the shot that will expose any foam-LOD fade.

### D · 29.65–46.25 · Stern chase — the money shot
16.6 s, one move, and the piece's signature. Camera dead astern **on the ship's
centreline**, low, pitched down just enough that the wake V fills the lower two
thirds and converges on the vertical centreline. The ship is *out of frame ahead*
at the start, enters the top of frame at ≈ 8 s in, and grows to ~8 % frame height
by the cut.

```
t=29.65:  cam.pos = SHIP + (0, 30, −180)
t=46.25:  cam.pos = SHIP + (0, 30, −140)
pitch = −14° constant   fov = 45 constant
```
Closing rate ≈ 2.4 m/s relative — a slow, unbroken push, eased in over the first
2 s and *not* eased out (the cut arrives mid-move). Horizon pinned at 18 % from
the top for the whole shot.

Overlay drone-like micro-motion on top: roll ±0.4° @ 0.08 Hz, yaw ±0.5° @ 0.05 Hz,
alt ±0.3 m @ 0.11 Hz. Without it the shot reads as a rail and the illusion dies.

Light: blue hour, sun −3°, sky a dark teal gradient going black at the top. Sea
near-black; the wake is white. Contrast is the entire shot.

> The reference has a 6-frame strobe artefact through this whole shot (visible as
> a 4 Hz flicker in the foam). It is a shutter/codec artefact. **Do not
> replicate it.**

### E · 46.25–56.5 · Sunrise parallel track
First warmth in the film. Aerial abeam the ship, ship in full profile, held near
frame centre but **drifting slowly frame-left** — the camera runs ~0.3 m/s slower
than the ship, which is what stops it reading as a lock-off.

```
t=46.25:  cam.pos = SHIP + (+160, 42, +10)     // starboard beam, slightly ahead
t=56.50:  cam.pos = SHIP + (+160, 42, −8)      // has fallen astern
pitch = −14°   fov = 38
sky.timeOfDay = 6.35   sun elevation +1.5°
sun azimuth: rakes the far (port) side of the hull — warm rim, cool near side
weather = 'glass' blending to 'calm'
```
Horizon at 22 % from the top. **No cloud detail at all** — sky is a flat
mauve→peach vertical gradient. Sea is a long low swell with a mirror finish and
one narrow white wake line trailing right. Set `oceanParams.swellPeriod ≈ 14`,
`swellAmplitude ≈ 0.25`, `amplitude ≈ 0.10`.

Out on a 1.2 s cross-dissolve.

### F1–F3 · 56.5–71.74 · Sunrise on deck (replaces the wheelhouse block)
Reference is three dissolve-linked interior angles of a passenger watching the
sun come up, ending in a total flare blowout. Same three beats, our subjects:

- **F1 (5.5 s)** helm station, static, sun low behind the standing rigging.
  Shrouds and ratlines cut the disc into slices. `fov 35`.
- **F2 (4.0 s)** slow dolly forward along the centreline, 1.6 m eye height,
  0.8 m/s, from the helm toward the foot of the foremast. Sun climbing.
- **F3 (5.7 s)** static, sun clears a shroud and **blows out 60 % of the frame**.
  `godRayIntensity 1.8`, `bloomStrength 1.4`, `bloomThreshold 0.45`.

`timeOfDay` ramps 6.55 → 6.90 across the three. All three joined by 1.0 s
cross-dissolves — the only dissolves in the film, and they are what makes this
block feel like drifting rather than cutting.

### G1/G2 · 71.74–81.21 · Bow wave, gold
Hard cut, and the tempo tightens. Camera at the stem, 1.5 m above water, pitched
down ~35°, watching the bow wave curl and shear past. Backlit gold — the sun is
ahead and low, so the foam is translucent and the water behind it is black.

```
cam.pos = SHIP + (+2.5, 1.5, +13)      // just outboard of the stem
cam.aim = SHIP + (+1.0, 0.0, +17)
fov = 50
post.dofFocus = 3.5, dofRange = 6, dofBokeh = 4
```
G2 is the same rig 3.5 s later, pitched 10° further down and 0.5 m lower. Cutting
between two near-identical angles is deliberate: it reads as *looking harder*.

Heavy motion blur in the reference. Our foam needs to be moving fast enough that
temporal AA does the same job — ship at 9–10 kn, not 6.

### H1/H2 · 81.21–93.93 · Waterline sunstar
No ship in frame at all for 12.7 s. Camera 0.30 m above the sea surface, the swell
crossing the lower frame and periodically climbing over the lens. Sun on the
horizon, hard star, mirror path running straight down the frame to the camera.

```
cam.y   = sampleWaterHeight(x,z) + 0.30     // per frame — it must ride the swell
cam.pitch = 0°, horizon at 40 % from the top
fov = 42
weather = 'calm', low swell
sun elevation +1.0°
post.godRayIntensity 1.6, vignetteStrength 0.55
```
Motion is entirely the sea: the camera inherits the surface, so vertical ±0.35 m
@ ~0.12 Hz and roll ±2° come for free from sampling ocean height and slope. H2
cuts to the same setup 0.15 m lower and 4° wider. This shot is cheap and it is one
of the two most convincing in the film — build it first.

### I1/I2 · 93.93–104.81 · Rail silhouette (replaces the angler)
Reference: a figure at the rail with a rod, blue hour, the rail a hard diagonal
from upper-left to lower-right. Our version keeps the geometry and swaps the
subject for rail + shroud + lantern.

```
cam mounted on the hull (inherits roll/pitch), eye 1.6 m
rail crosses the lower-left as a diagonal, horizon at 45 %
sun elevation −2°, sky banded orange at the horizon → deep blue at 30° up
lanterns on, flickerDepth 0.22
fov = 40
```
Static. The only motion is the ship's own roll, ±1.5°. I2 is a matched reverse.

### J · 104.81–116.4 · Glitter macro
Pure abstraction, 11.6 s of it. Long lens, wide open, on the sun path. The path is
a blown highlight ribbon; the foreground chop is a field of bokeh discs.

```
cam.y = water + 0.40
fov = 12                              // long
post.dofFocus = 6, dofRange = 3, dofBokeh = 6
sky.timeOfDay = 18.30                 // the film has crossed to evening here
sun elevation +1.0°, warm
```
Drift laterally 0.5 m/s while riding the swell. Nothing else happens.

### K · 116.4–121.04 · Night aerial, ship at rest
The ship has stopped. Deck lamps on, their glitter path directly below her. Sea a
uniform dark blue-grey with fine texture and no whitecaps.

```
cam.pos = SHIP + (−90, 110, −95)
pitch = −48°, fov = 40
ship at frame centre-left, ~12 % frame width
sky.timeOfDay = 21.5, moonPhase 0.6, moonIntensity up
weather = 'calm'
```
Nearly locked; 0.4 m/s lateral drift.

### L · 121.04–143.81 · Waterline and under (replaces the shark block)
22.8 s. Reference is split-level and underwater shark footage lit by the boat.
Ours, same length, no creatures:

- **121–130** split-level at the hull: half the frame is black water, half is the
  lit waterline and the lantern's cone on the surface. `underwater.blend` at the
  boundary.
- **130–143.8** sink slowly under the hull and look up: the lit waterline from
  below, the keel a black shape against it, caustics on the hull's wetted skin
  (`src/caustics/hullWetline.ts`).

Near-black grade, `grainAmount 0.016`, DOF on.

### M · 143.81–154.32 · Extreme high — the thematic shot
The one image the whole piece is built around. The camera is so high the ship is a
single unresolved cluster of light in total blackness. No horizon. No sea texture.
Nothing else in frame.

```
cam.pos = SHIP + (+40, 600, +30)
pitch = −75°, fov = 35
ship ≈ 2 % frame width, centre, drifting ~6 px toward frame-left over 10.5 s
sky.timeOfDay = 22.5, moon out of frame, starfield off or very faint
```
Camera locked; the drift is the ship's own way through the water.

> Gap: at 600 m the lantern is sub-pixel and `lanternParams.range` is 18 m, so
> what sells this shot is entirely the lamp's **bloom**, not its lighting. Expect
> to add an explicit distance-stable beacon sprite or raise `bloomThreshold`
> handling for tiny bright sources. See §6.

### N1/N2 · 154.32–180.26 · Instruments, then the dark
- **N1 (3.7 s)** CU on the binnacle or the radio set glowing in the dark — the
  reference's chartplotter beat. The radio is the thematically right substitute
  given the VO.
- **N2 (22.3 s)** camera at the waterline alongside the hull, lantern spill on
  black water, foam curling past. If we want to keep the reference's "something
  is out there" turn without creatures, resolve a black island silhouette out of
  the dark over the last 8 s (`src/archipelago`).

### O · 180.26–190.86 · Bow in fog
Camera at water level off the port bow, looking slightly **up** at the ship. The
masthead work light is blown to a white blob filling roughly a third of the frame
and, because the fog is thick, its beam is a visible glowing volume. Red nav lamps
on the mast. The hull is a flat black silhouette.

```
cam.pos = SHIP + (−34, 1.0, +30)        // 45 m out, 40° off the centreline
cam.pitch = +6°                          // looking slightly up
fov = 45
```
Fog — **not one of the seven presets**, build it:
```
sky.hazeStrength = 1.00
sky.fogNear = 5, sky.fogFar = 120        // presets ship 1800/4900
sun intensity 0, moon low
ocean = 'glass'
masthead lamp: intensity 40, range 60, colour 0xfff0e0
nav lamps: red, intensity 6, range 12
```
Camera bobs on the swell ±0.3 m, roll ±1.5°. Ship makes 1.5 kn — barely moving.

### P · 190.86–196.0 · Bow tight, then gone
Hard cut to ~18 m out and 0.4 m lower, pitched slightly down. Only the stem and
the lamp. Over 5 s the camera drifts back and right until the bow exits frame
lower-left and there is nothing left but fog. **End state: no ship.**

### Q · 196.0–225.0 · Fog
29 s of nothing. Grey, slowly moving, occasional darker holes. Reads as being
*inside* a cloud. The camera drifts at ~3 m/s with a slight roll and no target.

> Gap: uniform haze will render as flat grey and this shot needs internal
> structure. Either fly the camera up into the `src/clouds` layer, or drive
> `hazeStrength` from a scrolling 3D noise. Untested. See §6.

### R · 225.0–240.0 · Titles
- 225.0–228.0 fade to black, 3 s
- 228.0–231.0 logo, centre, ~30 % opacity
- 231.0–235.0 `WORDS BY / ALAN WATTS`, small-caps serif, hairline rule above
- 235.0–240.0 credits, two columns, same treatment

---

## 5. Engine mapping

| Script cue | Engine surface |
|---|---|
| every camera pose | `__game.followCam.setDebugPose([x,y,z], [tx,ty,tz])` — holds against every frame and every mode |
| release | `clearDebugPose()` |
| FOV | `cameraParams.fov` |
| deck-mounted rigs (F1, I1/I2, N1) | `followCam.setStation('bow'\|'stern'\|'nest')` or `'helm'`, which ride the hull's roll for free |
| time of day / sun | `skyParams.timeOfDay`, `skyParams.latitude`; `sunElevation()` in `src/sky/sunCycle.ts` to verify |
| weather rung | `applyPreset(name)` — `glass \| calm \| breeze \| swell \| squall \| gale \| storm` |
| bespoke sea (E, H) | `oceanParams.amplitude / swellAmplitude / swellPeriod / choppiness` directly |
| fog (O, P, Q) | `skyParams.hazeStrength`, `fogNear`, `fogFar` |
| moon, stars | `skyParams.moonPhase / moonIntensity / starDensity / starBrightness` |
| lamps | `lanternParams.intensity / range / color / flickerDepth` |
| flare, godrays | `postParams.godRay*`, `bloom*` |
| DOF | `postParams.dofEnabled / dofFocus / dofRange / dofBokeh` (**off by default**) |
| grade | `gradeParams.lift* / gamma* / gain* / split* / *Tint*` |
| ship speed | `__game.setSpeed(knots)` |
| water height for waterline rigs | the `heightFn` already passed to `followCam.update` |

**Shot-list shape.** A `Shot[]` plus a ~60-line player that lerps pose along each
shot's keys and calls `setDebugPose` every frame is the whole implementation:

```ts
interface Key { t: number; pos: Vec3; aim: Vec3; fov?: number }
interface Shot {
  id: string;
  in: number; out: number;
  transition: 'cut' | 'dissolve' | 'fade';
  keys: Key[];              // ship-local; resolved against the live ship pose
  frame: 'world' | 'ship';  // 'ship' = rides the hull (deck rigs)
  wobble?: { roll: number; yaw: number; alt: number; hz: number };
  rideSwell?: number;       // metres above sampled water height
  world?: Partial<{ timeOfDay: number; weather: WeatherPresetName; /* … */ }>;
  post?: Partial<PostParams>;
}
```
Everything in §4 fills that struct directly. Record with the existing screenshot
path at a fixed dt so the capture is deterministic.

---

## 6. Gaps — what will not match, and what to do

1. **Lens flare ghost chain (shot A).** We have godrays + bloom; the reference's
   coloured bokeh string is a physical artefact. Either accept a cleaner sunstar
   or add a small screen-space flare pass. *Cosmetic, high vibe-per-line.*
2. **Sub-pixel light sources (shot M).** At 600 m the lantern lights nothing and
   is smaller than a pixel; the shot is 100 % its bloom. Needs a distance-stable
   beacon sprite or the bloom path will just drop it. **This is the one gap that
   can kill a hero shot.**
3. **Fog interior (shot Q).** Uniform haze renders flat grey. Needs cloud-layer
   interior or noise-driven density. Untested — verify before committing 29 s of
   runtime to it.
4. **DOF quality.** `dofEnabled` is false by default and `dofBokeh` maxes at 8.
   Shot J (glitter macro) lives or dies on bokeh disc quality. Test early.
5. **Foam LOD at altitude.** Shots C and D put the wake at 85 m and 30 m in
   near-zero light with nothing else in frame. Any distance fade in `flowFoam`
   will be brutally visible.
6. **No yacht.** Two options:
   - **Brigantine (recommended).** Every wide reads on silhouette + wake, not
     detail — the ship is under 15 % of frame width in all of them. Costs nothing
     and we shoot today. The deck-level shots (F, I, N) read *better*, because
     rigging against a low sun is a stronger graphic than a wheelhouse window.
   - **Model the trawler.** A new hull class in `src/params/ship.ts` plus
     blueprint work. That is a modelling job, not a camera job, and it buys
     fidelity only in shots E and O where the hull is actually resolvable.
7. **People.** Six shots (56.5–71.7, 93.9–104.8, part of 121–143.8) are built on
   a human figure. Re-cast above onto rigging, rail, lantern and hull. The
   silhouette-at-the-rail beat is the one that loses most; a lantern on a swinging
   cord is the nearest substitute we have.

## 7. Build order

Cheapest-first, and each one independently proves something:

1. **H1/H2** waterline sunstar — no ship, no rig work, proves sun/ocean/godrays.
2. **D** stern chase — proves wake, foam, and drone-motion feel. The signature shot.
3. **M** extreme high — proves the isolation beat, and surfaces gap #2 immediately.
4. **O/P** bow in fog — proves bespoke fog + lantern volume.
5. **E** parallel track — proves the sunrise grade.
6. Everything else.

Shots 1–4 alone are 45 s of footage and would settle the question the whole
exercise is asking.
