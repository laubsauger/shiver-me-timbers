# R3 SYNC — world lookdev (§T.102, §V88, §V22 pass over everything that landed today)

Captured 2026-08-22 from `git archive fd4450b` (HEAD at capture) served by its own Vite on
port **5193** — an isolated snapshot with its own `cacheDir`, never the live tree (harness §5).
Nothing under `src/` was edited; the only snapshot-only change is a `<script src="/cap.js">`
added to the three HTML entries, which installs the capture harness (`__cap`) and nothing else.

All stills are **1920×1080 PNG** read straight off the canvas (`toDataURL`) with
`renderer.setPixelRatio(1)` and `setSize(1920,1080,false)`, then `setSize`/`setPixelRatio`
stubbed so the page's own resize listener cannot walk the backing store back to the window
size (it did, on the first pass — the first twelve frames came out 2250×1232 and were re-shot).

**The tab was VISIBLE and FOREGROUND for every frame.** `document.visibilityState === 'visible'`
and a live rAF counter (28–30 ticks/s) were asserted immediately before each capture, and the
capture throws rather than writing a file if either fails. The MCP tab would not go into its own
window by itself — `tabs_context_mcp{createIfEmpty}` put it in the user's 43-tab window twice —
so the working recipe is: **make an empty Chrome window with AppleScript first, focus it, THEN
call `tabs_context_mcp{createIfEmpty:true}`**, and delete the leftover `chrome://newtab/` from
that window afterwards. (`move tab … to nw` in AppleScript does move the tab but Chrome
re-creates it, and the MCP tab id dies with it. Don't.) No existing window was resized.

The tab did die once mid-run (renderer gone, window reverted to `chrome://newtab/`); the six
frames in flight were re-shot. Nothing was lost.

## The two §T.102 deviations, both mechanical

1. **`raft.html?at=<island>` does not exist.** `main-raft.ts` builds its jump list from
   `sea.archipelago.anchorages`, and `createArchipelago` only pushes an anchorage when
   `sites[0].archetype === 'lagoon'`. The sierra slice forces its own archetypes, so
   `__game.jumpTargets` is **`['spawn']` and nothing else**, and `?at=dome` logs
   `[jump] ?at=dome is not a destination`. Every island frame here was posed by writing the
   raft's position and pinning `followCam.setDebugPose()`. If T102's URL is meant to work,
   the sierra world needs anchorages.
2. **The `preview.html` frames at `tod` 17.8 and 22 carry no information.** That harness has a
   flat `0x7fa0bb` background, a matte sea plane and one directional light; below the horizon
   the sun contributes nothing and `raft-beam-tod17.8.png` and `raft-beam-tod22.png` are the
   same hemisphere-lit raft against the same flat blue. They are in the set for completeness.
   Time-of-day on the raft has to be judged in `raft.html`.

## Scene setup

| thing | value |
|---|---|
| §1–2 | `src/ship/preview.html?ship=raft…`, harness HUD hidden, camera/sun driven through the harness's own `VIEWS`/`placeAtStation` maths (identical to the URL path — `fit` 0.434, beam `dist` 22.59 / `height` 5.21) |
| §3–6 | `raft.html`, photo mode (`P`) — no HUD, no compass, no Tweakpane, no station prompts |
| weather (§5, §6, LOD) | `weatherParams.cellIntensity = 0`, `rainParams.opacity = 0`. **Not cosmetic** — see the rain note in §3 |
| weather (§3 island frames) | left at the shipped `calm` default, deliberately, so the rain shows |
| hands | `player.hands.group.visible = false` — see defect R3-2 |
| everything else | `src/params/*.ts` defaults at fd4450b |

`skyParams.timeOfDay` is re-written immediately before every capture: the day clock keeps
running between tool calls and 60 s of thinking time is a full game hour.

---

# 1 · Raft, dressed

`raft-{beam,bow,lee,stern,top}-tod12.png`, `raft-beam-tod{17.8,22}.png`,
`raft-station-{cabin,radio,tiller,bow,nest}-tod12.png`, plus close frames
`raft-cabin-interior-{aft,fore}.png`, `raft-cabin-berth-{port,stbd}.png`,
`raft-cabin-floor-mats.png`, `raft-cabin-roof-underside.png`, `raft-radio-corner.png`,
`raft-thatch-{eave,ridge}.png`, `raft-crates.png`, `raft-rail-slackrope.png`,
`raft-chest-guara.png`, `raft-spar-clearance{,-2}.png`, `raft-stern-oar.png`.

## What is there

Everything T117 claims is on the raft and resolves in the assembly. Verified by name, with
world AABBs: `berth-port`, `berth-starboard`, `floor-mat-0/1`, `radio-set`, `radio-crate`,
`radio-partition`, `battery-1/2`, `pot-1/2`, `ladle`, `chart`, `aerial-lead`, `aerial-wire`,
`thatch-roof-port/starboard`, `roof-lath-port/starboard`, `crate-1/2/3`, `rail-port/starboard`,
`plank-chest`, `jerrycan-1/2`, `dinghy`, `cage`, `rain-drum`, `kitchen-box`. 95 meshes total.

- **The radio reads as a radio** (`raft-station-radio-tod12.png`, `raft-radio-corner.png`).
  Grey set on an olive crate, a dial arc with a pointer, a second meter needle, a knob on the
  right cheek, a whip aerial, batteries stacked beside it and the aerial lead running up to the
  wire. The corrected station aim does look **down at the dial** — that reads correctly now.
- **Three crates that differ: yes** (`raft-crates.png`). One olive-drab box, one pale slatted
  crate with visible battens, one dark-green box. Plus two blue jerrycans. Good silhouette
  variety along the port side.
- **Slack-rope railing: yes** (`raft-rail-slackrope.png`). Posts with rope catenaries between
  them, sagging correctly, no straight-line cheat.
- **0.30 m of air around the spars: yes** (`raft-spar-clearance.png`, `-2.png`). The course
  stands clear of the yard and of the bipod at both the fore and the aft face; no cloth
  intersecting a spar at any of the three sails.
- **Thatch in courses on visible laths: partly** — see below.

## What falls short

**R3-1 · Everything new shares one cold blue-grey "plank" material, and it fights the raft.**
`berth-port`/`berth-starboard`, `plank-chest`, `radio-partition`, `kitchen-box`, the guara
boards and the splashboards all render as the same desaturated slate blue-grey with a plank
stripe. Against the warm bamboo deck and straw walls they read as painted steel, not as wood,
reed or bedding. On the berths in particular (`raft-cabin-berth-port.png`) it kills the read:
a reed mat and a mattress come out as two grey boards. This is the single biggest look delta on
the dressing, and it is one material.

**R3-2 · The first-person hands draw in photo mode.** `main-raft.ts` does
`app.camera.add(player.hands.group)`, and `ui.isPhotoMode()` gates the prompts and the HUD but
not the hands — so every §V22 frame taken from a debug pose had two mitts floating at the bottom
of it until I hid the group by hand. Photo mode is the recording gesture; the hands should go
with the HUD.

**R3-3 · The thatch is shingles, not thatch** (`raft-thatch-eave.png`, `raft-thatch-ridge.png`).
The five courses and the laths are there and the ridge cap is right, but each course is a grid
of identical rectangular tiles with a dashed stitch mark — it reads as wooden shakes or a
factory panel. The eave is a straight sawtooth of those same tiles, so the "ragged eave" does
not read at all: at 3 m it is a machined edge. Photo 09's reference is loose banana-leaf strands
hanging down the slope; nothing here hangs.

**R3-4 · The cabin has no light and no bounce** (`raft-cabin-interior-aft.png`). The interior
sits ~4× darker than the deck outside; the berths, chart, partition and pots are all legible
only because the wall behind them is darker still. Nothing in there is emissive — I could not
find the "emissive LED" on the radio at tod 12 in either the wide or the close frame; if it is
there it is below the ambient.

**R3-5 · The thatch underside is still pure black** (`raft-cabin-roof-underside.png`). Same
defect R1 flagged: the roof's backface is unlit, so the ceiling of a lived-in cabin is a void.
The laths are visible against it, which makes the black read as a hole rather than as shadow.

**R3-6 · The cabin walls are unchanged from R1** — the ~7 cm dark-olive "quilted" grid, glossy,
with a dark cross in each cell. R1 called this "the single biggest look delta on the raft" and
it is still the thing your eye goes to in every interior frame.

**R3-7 · Log textures smear badly at close range** (`prompts-tiller.png`, `raft-stern-oar.png`).
Standing on the logs, the grain stretches into long blurred streaks — anisotropic filtering or
a UV that is metres long in one axis. Fine at 20 m, bad at 1 m, and the walker spends all its
time at 1 m.

**R3-8 · The steering oar's blade is still above the water** (`raft-stern-oar.png`), as R1
reported. `steering-oar` AABB centre is at y 0.28 with a 2.36 m vertical span, and in the frame
the blade sits over the stern block, not in the sea.

Kept from R1 and unchanged: the flag is still the galleon's skull-and-crossbones
(`raft-beam-tod12.png`), the lookout eye is still inside the topsail
(`raft-station-nest-tod12.png` is 100 % cloth).

---

# 2 · Interaction prompts

`prompts-tiller.png`, `prompts-radio.png`, `prompts-guara-bow-port.png`,
`prompts-cues-in-reach.png`, `prompts-walk.gif`.

The prompt layer is DOM, so `toDataURL` alone cannot see it. These four stills are a genuine
composite: the WebGPU canvas drawn into a 2D canvas, then the live `.smt-prompt-layer` subtree
rasterised over it through an SVG `foreignObject` with the page's own `<style>` inlined. They
are 2250×1232 (the viewport) rather than 1920×1080, because `createRaftPrompt` in the harness
projects against `window.innerWidth/innerHeight` and pinning the canvas to 1920×1080 would put
the labels in the wrong place.

`prompts-walk.gif` is a real walk: 69 frames (every 4th sim frame, 12 fps) driven by real
`KeyboardEvent`s through `attachPlayerKeys`, from the bow tip → fore deck → starboard strip →
the starboard doorway → the radio. Auto-crouch fires at the sill, `interact.focus()` lands on
`radio`, and the plaque comes up. **The route R2 could not walk now walks.**

## What is right

- The plaque is a handsome brass thing and the copy is right: `[E] TILLER`, `[E] RADIO`,
  `[E] GUARA — BOW PORT`. Small caps, engraved key cap, legible over both sky and deck.
- One plaque at a time, and it tracks the socket live as the raft moves.
- `inReach()` is doing real work: at the tiller it reports `tiller, guara-5, guara-4,
  gangway-stern`; at the mast foot `guara-3, halyard, sheet-p, sheet-s, guara-1`.
- Hands render (they did not in R2 — `scene.add(camera)` landed).

## What falls short

**R3-9 · Every station socket is on the deck, so every prompt is a picture of the floor.**
This is the important one. `station-radio` resolves to **(−0.62, 0.93, −3.24)** — the cabin
floor — while `radio-set` sits at y 1.78 on its crate. `station-tiller` is at y 0.29,
`station-guara-1` at y 0.26, `station-chart` at y 0.93. Reach is measured from the capsule
(§B69), so standing next to the thing works, but the *plaque hangs at the socket*, and the
socket is at your feet. In `prompts-radio.png` the label "Radio" floats over bare floor matting
with **no radio anywhere in the frame**; in `prompts-guara-bow-port.png` it floats on the deck
weave beside the board, not on it. The affordance is telling the player to look down.
The fix is one number per station: hoist the label anchor to the object, or give
`RAFT_STATIONS` a label offset.

**R3-10 · The in-reach diamonds are invisible.** In `prompts-cues-in-reach.png` two cues are
on screen at 2250 px wide. They are **~6 px** of dark brass at `opacity 0.62`, on a dark deck.
At 1080p, on a monitor, they are not there. `promptCueSizePx` and the cue's contrast against
wood both need to go up, or the cue needs a light halo.

**R3-11 · Focus picks the nearest socket, not the one you are looking at.** Standing 1.15 m
forward of the tiller and aiming dead at it returns `guara-4`, because guara-4's socket is
nearer to the capsule and still inside the look cone. You have to stand within ~0.5 m of the
tiller to be offered the tiller. Same at the mast foot: 0.3 m of walk swaps `halyard` for
`guara-3`. Tie-break should weight the look axis, not just range.

**R3-12 · The starboard strip is still not reliably walkable.** Starting at (1.85, 0.63, 3.4)
and holding W, the walker made 0.53 m in 9 s — blocked. The same route via the centreline first
(x 0 down to z 3.2, then out to x 1.7) walks fine. There is a solid cell around x 1.85 / z 2.9
with nothing visible there.

---

# 3 · Islands

Per archetype at tod 7.5 / 12 / 17.5: `island-{dome,cirque,ridge}-tod{7.5,12,17.5}.png`.
Plan views `island-{dome,cirque,ridge}-plan.png`. Close checks
`island-dome-sheeting-close.png`, `island-dome-route-fork.png`, `island-dome-veg-close.png`,
`island-ridge-flank-gullies.png`, `island-cirque-talus-wall.png`.

Geometry, from the live heightmaps: dome peak **49.4 m** over a 204 m radius; cirque **43.1 m**
over 197 m; drowned ridge **19.5 m** over 163 m; Half Dome **762 m** over 480 m at 2.5 km.
All three slice islands carry a 4-POI route (`landing`, `station`, `exit`, `fork`).

## What is right

- **The plan views are the good news** (`*-plan.png`). The cirque really is a horseshoe open to
  the south-west with a lagoon inside it; the drowned ridge really is a long narrow bar; the
  dome really is a circular crown. The macro forms are distinct and they are the right forms.
- **The distraction fork exists** and the route POIs are on walkable ground.
- Pines have decent silhouettes and read as pines at 300 m.
- The beach band is continuous and the swash line looks right at every hour.

## What falls short

**R3-13 · There is no granite. The islands are chartreuse.** At 7.5 and 12 every landmass is one
flat, saturated yellow-green with almost no value range and no visible self-shadowing; at 17.5
the same surface goes red-brown. §V94 asks for "layered granite shading" and this is a single
hue with a lambert term on it. The boulders, the talus and the outcrops are the *same* yellow as
the ground, so they read as blisters rather than as rock — `island-cirque-talus-wall.png` is the
clearest case. This is the top island issue by a distance; nothing else on this list matters as
much.

**R3-14 · The sheeting bands are a rectilinear grid, and the geometry does not agree with it.**
`island-dome-sheeting-close.png` — the whole surface, boulders included, carries a regular
axis-aligned lattice of thin darker lines in heightmap space. From the air
(`island-dome-plan.png`) it reads as a swirl or a whirlpool. Exfoliation bands should follow the
dome's own curvature as concentric shells; these follow the grid. **The brief's test — do the
geometry and the shading agree — fails: the terrain has terraces, and the shading has graph
paper.**

**R3-15 · The authored route is a road, not worn ground** (`island-dome-route-fork.png`,
`island-dome-tod12.png`). It is a 6–8 m wide, smooth, evenly-graded pale band that is brighter
than everything around it and has soft parallel edges, running from the beach to the crown. It
looks laid, not walked. It wants to be narrower, broken, and expressed as thinned ground cover
plus a shallow trough rather than as a lighter colour.

**R3-16 · No gullies on the ridge flanks** (`island-ridge-flank-gullies.png`). At 19.5 m peak
over a 163 m radius the drowned ridge is a pancake — there is not enough relief for a gully to
exist. The flanks are smooth. Either the ridge needs height or the erosion needs to bite at
low slope.

**R3-17 · The talus is not graded.** At the cirque wall the debris is a scatter of similar-sized
ellipsoids along the beach, not a fine-to-coarse apron running up to a cliff. And there is no
cliff: the cirque's "half-ring of cliffs" is a grassy crescent whose inner face is walkable
everywhere.

**R3-18 · Vegetation is on the dome and almost nowhere else.** The dome has a good pine band;
the cirque has about three trees; the drowned ridge has none. The pines sit on the **crown**,
not in hollows — from the plan view they form arcs across the top. Ground cover is a scatter of
small pale blue-grey splats that read as puddles or lichen rather than manzanita, and I could
not tell a juniper from a pine at any range in these frames.

**R3-19 · Rain falls on a sunny island at noon on the shipped default.** `raftWorldParams
.defaultPreset` is `calm`, but `weatherParams.cellIntensity` is `1` and `rainParams.opacity`
is `0.3` with 12 000 streaks, so a passing cell drops visible white streaks across
`island-dome-sheeting-close.png` and `island-dome-veg-close.png` under a blue sky. Either the
cell should not fire on `calm`, or the streaks need to be gated on the cell being overhead.

**R3-20 · The Half Dome silhouette is see-through, and it is banded.** In every frame that
contains it (`island-cirque-tod12.png`, `island-cirque-tod17.5.png`, `sky-tod12-away-sun.png`,
`island-dome-tod7.5.png`) the 762 m cone is **semi-transparent** — clouds and sky read straight
through it — and its face carries hard horizontal bands. At sunset it stays a pale blue-white
lump while everything else goes warm, i.e. it is not taking the grade. For a landmark whose
whole job is silhouette, this is a hole.

---

# 4 · LOD honesty check — the answer is more interesting than "identical"

`lod-morph-applied-880m.png`, `lod-morph-zeroed-880m.png`, plus context frames
`island-lod-1000m.png`, `island-lod-1400m.png`, `island-far-1470m-eye14m.png`.

## Verdict, in two parts

**(a) The morph path IS reaching the GPU. It is live and it is correct.** Proven directly
rather than by eye: the `island-terrain` mesh has `geometry.morphAttributes.position` mounted
(74 716 vertices), and `mesh.morphTargetInfluences[0]` tracks camera distance continuously —

| camera distance to island centre | 620 m | 700 m | 800 m | 880 m | 899 m |
|---|---|---|---|---|---|
| `morphTargetInfluences[0]` | 0.063 | 0.329 | 0.661 | 0.927 | 0.991 |

which is exactly `(d − 600) / 300`, the `terrainLodPlan` ramp. `morphHeightDelta` is **2.219 m**
— the furthest a vertex travels across the band. Forcing the influence to 0 at 880 m and
diffing against the natural 0.933 over the island's screen box (595,481)-(1280,599) gives a mean
absolute difference of **1.78** against a same-configuration noise floor of **1.18** (moving sea
and foliage), and 18.3 % of pixels changed against 12.8 %. The pixels do move.

**(b) But the Tweakpane A/B the brief asked for is inert, and would have lied to you.**
Flipping `islandParams.lodTerrainMorph` at runtime changes **nothing** on any sierra island:

| distance | influence with `lodTerrainMorph = true` | with `= false` |
|---|---|---|
| 620 m | 0.0628 | 0.0608 |
| 700 m | 0.3288 | 0.3268 |
| 800 m | 0.6614 | 0.6594 |
| 880 m | 0.9274 | 0.9254 |
| 899 m | 0.9906 | 0.9886 |

(the 0.002 offset is a ±0.3 m camera nudge I used to force a recompute, not the flag.)

The cause is one line in `src/island/island.ts:221`. `createIsland` takes
`p: ResolvedIslandParams = bespoke ? { ...islandParams, ...opts.overrides, archetype } :
islandParams` — a **spread copy** whenever the island is bespoke. Every sierra island is
bespoke (it has an archetype and overrides). The per-frame update then calls
`terrain.setLodDistance(dist, p)` with that frozen snapshot, so the panel writes to
`islandParams` and the island reads its own copy. **This is a §V16/§V62 defect and it is not
limited to the morph:** `lodTerrainDistance`, `lodTerrainMorphBand`, `lodRockCull`,
`castShadows`, `radius` and `foamTargetMargin` are all read off the same snapshot on sierra
islands, so every one of those Tweakpane controls is dead there. In the pirate world, islands
built without overrides get `islandParams` by reference and the same controls DO work — which
is exactly the kind of split that makes a bug survive a review.

So: had I judged this by eye off the toggle, I would have reported "the morph is not reaching
the GPU". The frames are near-identical, the diagnosis is not.

The two shipped PNGs are the honest pair: `lod-morph-applied-880m.png` (influence 0.933, as
shipped) versus `lod-morph-zeroed-880m.png` (influence forced to 0 on the mesh). At 880 m on a
49 m island a 2.2 m vertex travel is ~2 px, so do not expect to see it side by side — the
number is the evidence, not the picture.

Context: no terrain tearing or LOD explosion was reproducible at 400 / 700 / 1000 / 1400 /
2000 m, nor at 1470 m with the eye at 14 m (`island-far-1470m-eye14m.png` is clean). An earlier
pass did produce six frames of terrain torn into ribbons floating in the sky with the trees and
boulders detached — those were shot while the raft was being teleported between islands and I
could not reproduce it once the camera and the raft were settled before the shot. **Flagged, not
diagnosed.** If the user has ever seen the islands come apart mid-sail, that is the shape of it.

---

# 5 · Clouds and sky

`sky-tod{7,12,17.8,22}-{toward,away}-sun.png`, `sky-night-horizon-tod22.png`.
Open water at (2600, 2600), 3.5 km from every island, eye 14 m, weather forced fully calm.

| check | verdict |
|---|---|
| clouds warm on the lit side at 17.8 | **pass** — at 17.5/17.8 the cumulus are pink-amber with a brighter edge on the sun side; the grey-sunset complaint is gone |
| forward-scatter rim on a cloud between camera and sun | **not proven here.** At tod 17.8 the sun quadrant was empty of cumulus in the calm preset. The rim is visible on the island frames at tod 17.5 (`island-dome-tod17.5.png`) but that is a side-lit read, not a between-camera-and-sun read. Worth one more frame with a cloud placed deliberately |
| still WHITE at noon | **pass** — `sky-tod12-away-sun.png`: white cumulus with neutral grey undersides on a blue sky. No orange, no warm tint. The gate did not leak |
| night unchanged | **pass** — deep navy, stars, moonless side clean |
| no vertical bars at the horizon | **pass, measured.** In the 36-row band immediately above the horizon at tod 22, across all 1920 columns: mean L 39.34, **stdev 1.22**, largest adjacent-column jump 5.6/255 (a single star). §B91's picket fence is gone |
| no dead-straight horizontal cut at ~3.5° | **pass, measured.** Largest row-to-row luminance step anywhere in the night sky is **2.74/255**, and it is at a cirrus edge 335 rows up, not near the horizon. The sea/sky transition itself spans ~8 rows (38.5 → 30.1), i.e. a gradient, not a cut. §B90 holds |

## What falls short

**R3-21 · The night cirrus is a starburst.** `sky-tod22-away-sun.png` and
`sky-tod22-toward-sun.png` both show the high cloud band as long white streaks radiating from a
single point, like a zoom blur. It is present at tod 7 and 12 too (faint), and it is the most
artificial thing in the night sky now that the bars are gone. It comes from the `band*` cirrus
layer's perspective on a flat plane at `bandAltitude 2100` — a plane that low subtends the whole
sky and its texture converges to the vanishing point. Either raise the band, or warp the UVs so
the streaks stay tangential.

**R3-22 · The islands' saturated yellow leaks into the sea reflection as a hard-edged block.**
Visible in `island-dome-tod12.png` and `island-ridge-tod7.5.png` as a rectangular lighter-green
patch on the water under the Half Dome, with a straight vertical boundary. Reads as a planar
reflection frustum edge, not as a reflection.

---

# 6 · Near-sun road

`sunroad-tod17.9.png` (shipped defaults), `sunroad-glint1.00-control.png` (A/B control).
tod **17.9**, sun elevation **1.45°** — the same geometry as the pitch's `sunroad.png`.
Camera `[ship.x − 470, 6.5, ship.z − 198]` looking along the sun vector. `glintRoadStrength`
confirmed **0.75** in the shipped params.

**The apex is still a bar.** Widths at L ≥ 235 on `sunroad-tod17.9.png`:

| row | what | width |
|---|---|---|
| horizon − 30 / − 20 / − 10 | the sun's glare | 142 / 136 / 130 px |
| horizon + 20 / + 40 / + 80 | the road, just below | 130 / 131 / 146 px |
| horizon + 160 / + 300 | further down | 36 / 49 px |

The apex is **~100 %** of the glare's own width — if anything better than the pitch's 90–95 % —
and it holds that width for ~80 rows before the chop breaks it into glitter. §T.110 / §V92 hold.

## The number

**Road-band clipped fraction (all channels ≥ 250), x = sun ± 120 px, 200 rows below the horizon:
6.01 %** on the shipped frame, against the pitch's **8.0 %** baseline. Supporting figures on the
same window: L ≥ 240 **35.5 %**, L ≥ 200 **77.6 %**, mean L **221.8**. Off-road control on the
same rows: **0 %** clipped, L ≥ 200 **5.3 %**.

**Read that with three caveats, in order of size.**

1. **It is a single frame of a stochastic surface.** Three repeat captures of the identical
   setup gave **5.65 %, 5.76 %, 8.78 %** — a ±3 pp spread from wave phase alone. Mean ≈ 6.7 %.
   Any comparison against 8.0 % that does not average is noise.
2. **It is not the pitch's scene.** Theirs was the pirate lagoon at `?at=lagoon` with the §V.46
   hold pinning wind near 8 m/s; this is the raft world in open water at wind 4. Rougher sea
   means more glitter and more clipped pixels, so mine is if anything the *easier* number.
3. **A matched-instant A/B does show the knob working.** Interleaving `glintRoadStrength`
   1.0 / 0.75 six times, and keeping only the pairs whose detected horizon row matched within
   3 px: **12.5 % and 11.9 % clipped at 1.0, versus 8.8 % at 0.75** — a ~28 % reduction, in the
   direction and roughly the magnitude §B89 predicted. `uGlintRoad.value` is written every frame
   (`surfaceMaterial.ts:2512`), so unlike `godRayScale` this one is not a build-time no-op.

**Verdict on the brief's question:** the near-sun band **no longer clips to white** — it is a
bright bar with structure in it, and 6 % of the band's pixels at full clip against 8.0 % before.
The remaining clip is wave-crest glitter inside the road, not the road itself.

---

# 7 · Pirate

`pirate-enemy-full-canvas.png`, `pirate-rudder-starboard.png`, `pirate-rudder-port.png`,
`pirate-rudder-swing.gif`.

- **T118 — the enemy sails under full canvas: confirmed.** `pirate-enemy-full-canvas.png`:
  `state.ships[1]` with `sailTrim 0.958`, six red courses and topsails set and drawing, heeled to
  leeward, making **10.25 m/s** with a wake. The player's ship astern has hers furled, which
  makes the comparison in-frame.
- **B92 — the rudder blade swings: confirmed.** `pirate-rudder-{starboard,port}.png` are the
  same pose from 26 m astern with the helm hard over each way; the blade below the transom is
  visibly at a different angle in each. `pirate-rudder-swing.gif` is a full −1 → +1 → −1 sweep
  at 10 fps.

## What falls short

**R3-23 · The rudder is a slab and it is not attached.** The blade is a plain dark rectangle
with no pintles, gudgeons or stock, and there is a visible gap between its top edge and the
transom — it hangs in the water behind the hull rather than hinging on it. It is also small
relative to a ship this size, and half of it is under the waterline where the water is opaque,
so the swing you just fixed is only half visible.

**R3-24 · A hard-edged blue rectangle sits on the water off the port bow**
(`pirate-enemy-full-canvas.png`, lower left, ~x 0–700 / y 780–1080). A distinctly bluer patch
with a straight diagonal boundary. Caustics or reflection tile seam; it does not move with the
waves.

Not a defect but worth saying: **the pirate ocean is visibly better than the raft ocean.** Same
code, different weather and different island palette — the raft world's sea reads as flat
turquoise next to this. Whatever the pirate scene is doing to the water is what the raft scene
should be doing.

---

# Console

**Not clean. This is the finding I would open the review with.**

Captured on a fresh `raft.html` boot at defaults, with nothing touched — no debug camera, no
teleport, no param writes — over ~4 s of running:

1. **`WebGPUBackend: copyFramebufferToTexture: Source and destination formats do not match.
   bgra8unorm rgba16float`** — once, at boot.
2. **~40 × `[gpu] uncaptured error: Binding size for [Buffer "bindingBuffer_UniformBuffer_N"] is
   zero`**, on `bindGroup_object`, vertex-stage uniform binding 2 and 4. The buffer index keeps
   climbing (1, 3, 13, 21, 31, 39, 43, 45, 72, 100, 120, 142, 148, 164, 170, 188, 214, 216, 234,
   238, 264, 284, 298, 318 …), i.e. this is not one bad object at startup — bind-group creation
   is failing for new objects continuously. **A bind group that fails to create is an object that
   does not draw**, silently. Worth finding out what is missing from the scene.
3. **`Copy origin … and size (1×1) does not cover the entire subresource (3600×1970) of
   [Texture "depthBuffer"]. The entire subresource must be copied when the format
   (Depth24Plus) is a depth/stencil format or the sample count (4) is > 1`**, immediately
   followed by **`[Invalid CommandBuffer from CommandEncoder "copyFramebufferToTexture_2"] is
   invalid due to a previous error`**. Something is trying a 1×1 depth readback against a
   multisampled depth buffer every time it runs, and the whole command buffer is thrown away.

Warnings, same boot: `WebGPUTimestampQueryPool [compute]` and `[render]`: *Maximum number of
queries exceeded* — the §7 harness note says an overflow means the pass list is not to be
trusted; and `THREE.TSL: "modInt()" is deprecated`.

`preview.html` is clean apart from `[caustics] waterLighting() called before
setActiveCaustics()` (material baked without caustics/wetness) and the same `modInt`
deprecation.

---

# The three things I would fix first

1. **The islands' palette and the grid that is standing in for sheeting** (R3-13, R3-14).
   Everything else in §3 is a detail on top of a landmass that currently reads as chartreuse
   plastic with graph paper on it. §V94 is not met at any hour, and this is the set's weakest
   material by a wide margin.
2. **`createIsland`'s frozen params snapshot** (`src/island/island.ts:221`, §4). It is one line,
   it silently kills six Tweakpane controls on exactly the islands this phase is about, and it
   is the reason the LOD A/B the brief asked for could not have answered its own question. It
   also makes any future "I toggled it and nothing changed" report untrustworthy.
3. **The station sockets that put every prompt on the floor** (R3-9), together with the
   invisible cues (R3-10). T116's plaque is well made and lands in the wrong place; the whole
   point of the feature is that the player looks at a thing and is told what it is, and right
   now they are looking at the deck. One offset per station fixes it.

Runner-up, because it is cheap: **hide the hands in photo mode** (R3-2). Every capture agent
after me will otherwise hit it, and every recorded clip has mitts in the corner.
