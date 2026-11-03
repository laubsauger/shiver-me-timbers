# The Drift: status

Where each part of the film stands on **2026-10-29**. A snapshot: update the date and the rows when a beat moves.

- **The live list of the user's review notes** is `../drift-narrative/wandering-on/open-notes-2026-10-29.md`
  (`[x]` done, `[~]` changed and to be verified in a render, `[ ]` open). Add new notes there, not here; a new review
  day starts a new `open-notes-<date>.md`.
- Direction per act: `../drift-narrative/undertime/direction.md`, `../drift-narrative/get-the-drift/direction.md`
  and `direction-part-b.md`, `../drift-narrative/wandering-on/direction.md`. The acts and Mark's open questions:
  `../drift-narrative/README.md`.
- Show times below are from the code on 2026-10-29 (`beatStarts` of each act's timeline). They move whenever a
  beat's length changes: read them from the page's HUD when it matters.

## The whole show

One clock, 770 s (12:50; 23 100 frames at 30 fps): Act 1 from 0 s, Act 2 from 81 s (overlapping Act 1's last 5 s),
the sea's scene from 313.9 s (a 3 s crossfade during the landing), fade to black at the end.

| | status |
|---|---|
| Blocking | every beat is on one clock, rendered end to end in rough cuts |
| Renders | the latest full render is v11, 4096² x264 (2026-10-28); no 10/12-bit or 8K master yet. The deliverable's resolution and frame rate (4K or 8K, 30 or 60 fps) is an open question for Mark; the pipeline can render an 8K 12-bit ProRes 4444 master ([PIPELINES.md](PIPELINES.md) §11) |
| Venue | Horizon 18, tilted 15° (decided); the sea horizon at the dome's true horizontal (decided 2026-10-27) |
| Seat check | a seat's view can be reprojected (`drift-seat-view.py`); a check of rough-cut chunks in studio-world's virtual Horizon 18 from audience seats is still to do |
| Sound | not in the repo: Mark's music sets the beat lengths; Alan Watts over W3–W4 (rights to clear) |

## The spine (2026-11-02)

The story spine was approved on 2026-11-02: **everything lost, a few remain, they find each other**
(`../drift-narrative/next-level-2026-11-02.md`). Two of its moves are now in the film by default, so the next master
render has them:

- **Lights Out** (Act 2, ~235–275 s; `getTheDriftParams.lightsOut`): the flood comes as a front across the night
  side, the cities go out behind it, near-black in the score's dip, one warm lamp stays lit low in front, the Sun
  rises ~15 s later. The lamp sits 40° left of the landing's front, on the bearing of c4's answering station.
  `drift.html?lightsOut=0` (`--query lightsOut=0`) gives back the approved flood.
- **Call, wait, answer** (c4, ~430–485 s; `driftParams.radioCall`): our masthead's pulses go out unanswered, a second
  shorter call, the lamp ahead (−40°) answers the call sign on the music's step (447.93 s), the raft's bow turns to
  it, the Rose wakes from it as a raised cascade, and every path keeps a faint trail until the dissolve.
  `drift.html?radioCall=0` (`--query radioCall=0`) or `--setup 'd.params.radioCall = false'` gives back the old wake.
- **w6's trails**: the w6 Rose's chatter keeps the same faint trails (`roseTraffic.ts` TRAIL_W6), the figure building
  link by link over w6's first ~25 s and gone by 744 s, before the end title (748 s).

Still off, prototypes: `radioOperator`, `radioEnding`, `?drownedstub`, `?powerline`, `?linedown`.

## Act 1, Undertime (0–86 s)

Built (direction v2). Beats: first 0, arise 7, cool 18, wave 38, remain 45, zoom 55, gather 73 s.

2026-10-30 round (the user: richer collisions, "a few more shades", and the light wave as "a total collapse of space
and time"): collision products (`productModel.ts`, `products.ts`: annihilation stars with kinks, delta rays, gamma
conversions, jets with V0s), braided bound pairs, shades within each colour family; the light wave rebuilt as a build
(from 32.5 s, inside the cooling), a radiant front, the field pulled toward it (`waveFx.ts`), trails frozen where it
passes and cooling as an afterglow, a held caustic-web whiteout (`sky.ts`), the dust lit as a sheet; glow profiles as a
windowed core + halo (`glow.ts`). Beat lengths unchanged.

| open | |
|---|---|
| Crawl text | placeholder until Dimi's narration arrives (`src/drift/undertime/crawlText.ts`) |
| The survivor | direction.md's "one near pair gets away" is not drawn in the event grammar (only the old track grammar had it): the hero grain appears without the matter track arriving |

## Act 2, Get the Drift (81–~314 s)

Parts A (galaxies → Milky Way → Earth at dawn) and B (time wave, overshoot, flood, Drift 2) built. Beats: galaxies
81, ours 99, band 123, sun 133, earth 145, timewave 187, lights 209, overshoot 231, flood 241, drift2 265, landing
285 s.

| open | |
|---|---|
| Act 2's stars | still ~0.1° blobs at 4K. Dropping the minimum size in `milkyWay.ts` would change the approved Act 2 look: ask first |
| Earth glint and Sun | reworked (four-ray sparkle with twinkle; white core and veil); the user found the glint "sparkly" and the Sun underwhelming: verify |
| The approach | the sea looks too flat and static on the way down: more swell structure earlier in the descent |

## Part C, at sea (end of Act 2)

| beat | from | light | stands | open |
|---|---|---|---|---|
| C1 a raft | 313.9 s | morning (Act 2's) | one continuous descent into a slow follow; the sea's scene takes over in a 3 s crossfade | a small brightness step at the hand-over; the sea too flat on the approach |
| C2 seafaring | 355 s | sunset | far rafts on the horizon; the sail set | debris at sea reads as black slabs at sunset; near debris reads as plain boxes |
| C3 the dolphin | 385 s | last light | the dolphin (real outline and motion, wet skin) on the stage left of the sail, in the Sun's road: leaps across the Sun, circles the blue case afloat, noses it, flips it over the horizon onto the bow; the 16:9 turns 10° left for it (2026-11-01) | people on the raft are capsule stand-ins |
| C4 the network | 430 s | night | night falls in a 22 s time-lapse (was a dissolve the user found too fast); the call, the wait and the answer, then the Rose's cascade with faint trails (the spine, above) | verify the fall into night; raft lights a touch dimmer |

The raft throughout: CC0 props and the hard case are in; open are its wake and contact (a collar, bow heap and eddies
were added; the contact line reads too bright and grey, its shadow on the water is missing, streaks remain), the foam
and lapping at its sides, the walls' cold repeating weave, the cabin interior, sails "fresh out of an IKEA bag"
(Kon-Tiki cloth wanted), and small dressing faults (a floating box and bucket, the lifebuoy's place, rope rails).

## Act 3, Wandering On

| beat | from | light | stands | open |
|---|---|---|---|---|
| W1 the coast | 490 s | morning, Sun behind left over the sea | the film's own coast and forest, far motus, high island in haze | edge trees still look "pasted on"; canopy too regular; black spots under the trees; near-field haze |
| W2 landfall | 540 s | late morning | the raft runs aground, we step off and glide along the waterline | the waterline (lapping, foam bore, swash) still being tuned; the raft rests on the sand in a few cm of water at ~545 s; sand mottling and tiling |
| W3 the field | 590 s | golden hour | Act 1's pairs in balance, faint | none noted |
| W4 the sandpipers | 635 s | sunset | seventh flock bake: in over the forest, a low pass, the vortex overhead, away over the forest ahead | verify the new bake in a render |
| W5 wandering on | 675 s | dusk | three walkers (stand-ins) along the waterline | check they walk on after a flock now gone into the trees |
| W6 the outro | 710 s | night | Milky Way, the Rose's chatter with faint trails (gone before the title), the field's flicker among the stars, the end title, fade to black | none noted |

## Across the film

| area | stands | open |
|---|---|---|
| Clouds | rebuilt with physical lighting (review stills in `out/drift/clouds_review/`) | flicker; sunset bases too evenly peach; cloudlets near the Sun too bright; soft overhead; cloud shadows on the sea; faint streaks in clear sky; the game to adopt the new system |
| Ambient occlusion | seam-free GTAO in the dome capture, sea scene only | |
| Water | per-world sea colours; reflections held above the horizon | caustics and transparency look plasticky; swell and ripple at the shore |
| Crew | jointed stand-in rigs (crew.ts, crewLife.ts): clear of sail, spars, lanterns and each other over the whole show (tests/driftCrew); seated poses, reactions to sunset, dolphin, answer and landfall; idle life | **next edit: replace the stand-ins with real characters** (the user, 2026-11-02: "we definitely need to rework the characters … note it to rework this for the next edit"). Options found, nothing downloaded: Microsoft Rocketbox avatars (MIT, rigged, ~2–3 d), MakeHuman/MPFB2 (CC0 exports), Mixamo or CMU mocap clips sampled by t for natural motion (~1–2 d), Renderpeople free scans (check the licence); the clearance test carries over |
| Night beach (w5–w6) | bioluminescent shore in (biolum.ts, biolumGlow.ts, shoreline.ts) | **next edit: an HDR-like night, not just brighter** (the user, 2026-11-02: "our beach scene is … drowning … the water is too dark, the beach is too dark, the plants are too dark. But we also don't want to just brighten it up … a high dynamic range kind of situation where we recover the darks and get some reflection of the environment and the night sky, a subtle one … without losing the bioluminescence"): lift the shadows by local tone mapping or a scotopic night grade rather than exposure; the night sky (stars, Milky Way, the network's arcs) faintly mirrored in the water; sand and foliage readable by sky- and starlight; the glow keeps its contrast on top |
| Shore | short-crested chop, irregular cusps, no stepped sheet edge | **next edit: the layered surf zone** (2–4 breaker lines at 30–60 m, day and night): an opt-in breaker term in the ocean material keyed to `swashForcing`'s phase, lines peeling and spaced c·T apart (the shore agent's design note, 2026-11-02) |

## Decisions still open

From `../drift-narrative/wandering-on/direction.md` and the README: C1's time of day (dawn arrival or a sunset);
the night's Moon; whether Act 2 ends with the network; Act 3's length and the Alan Watts passage; people on the
rafts or not; the dolphin's style; the end (title, the game's menu, or a fade); 4K or 8K, 30 or 60 fps.
