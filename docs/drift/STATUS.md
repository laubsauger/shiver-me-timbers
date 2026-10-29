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

## Act 1, Undertime (0–86 s)

Built (direction v2). Beats: first 0, arise 7, cool 18, wave 38, remain 45, zoom 55, gather 73 s.

| open | |
|---|---|
| Crawl text | placeholder until Dimi's narration arrives (`src/drift/undertime/crawlText.ts`) |

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
| C3 the dolphin | 385 s | last light | the dolphin (real outline and motion) flips the blue case onto the fore-deck | people on the raft are capsule stand-ins |
| C4 the network | 430 s | night | night falls in a 22 s time-lapse (was a dissolve the user found too fast); beams between island stations | verify the fall into night; raft lights a touch dimmer |

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
| W6 the outro | 710 s | night | Milky Way, beams, the field's flicker among the stars, the end title, fade to black | none noted |

## Across the film

| area | stands | open |
|---|---|---|
| Clouds | rebuilt with physical lighting (review stills in `out/drift/clouds_review/`) | flicker; sunset bases too evenly peach; cloudlets near the Sun too bright; soft overhead; cloud shadows on the sea; faint streaks in clear sky; the game to adopt the new system |
| Ambient occlusion | seam-free GTAO in the dome capture, sea scene only | |
| Water | per-world sea colours; reflections held above the horizon | caustics and transparency look plasticky; swell and ripple at the shore |

## Decisions still open

From `../drift-narrative/wandering-on/direction.md` and the README: C1's time of day (dawn arrival or a sunset);
the night's Moon; whether Act 2 ends with the network; Act 3's length and the Alan Watts passage; people on the
rafts or not; the dolphin's style; the end (title, the game's menu, or a fade); 4K or 8K, 30 or 60 fps.
