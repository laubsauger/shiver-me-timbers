# R1 raft lookdev — `preview.html?ship=raft`, HEAD dd233c3 (+2 snapshot-only tweaks, see below)

Captured 2026-08-21. Frames are 1920×1080 PNG read back from a fresh output RenderTarget
(tone-mapped + sRGB by the renderer's own output path), hidden tab, worker-pumped rAF
(harness §1/§2). Served from an rsync snapshot of HEAD on :5197; no src/ in the repo was edited.
The preview has a flat sky colour, a matte sea plane and one directional sun; it is a
material/geometry check, not a look check.

## READ FIRST — HEAD does not render the raft at all

`preview.html?ship=raft` (and anything that builds the shared sail material, which is **every
ship**, galleon included) hangs the renderer process on the first frame, forever. Bisected with a
`renderObject` hook: the frame reaches `sail-main-upper-mesh | piece-sail` and never returns.
Cause: `konTikiFaceNodes()` in `src/ship/raftSailFace.ts` chains 35 `smin` levels as ONE
expression DAG; three 0.180's `getNodeType()` is uncached and recursive through
Operator/Math/Var nodes, so the first build costs ~5^30 calls. `toVar()` alone does not fix it
(VarNode.getNodeType recurses too). Snapshot fix used for these captures (NOT committed, owner
should port it): accumulate `fill`/`stroke` inside a `Fn()` as `float(1e3).toVar()` +
`.assign(...)` — sail then compiles in 111 ms. Repro for the owner: open the preview URL in a
visible tab; the blue-grey page never renders and the tab stops answering.

Second snapshot-only tweak (also needs porting): `createRaftPieceUniforms()` in
`src/ship/raftMaterialNodes.ts` hangs its per-object refresh on `aabbMin.onObjectUpdate` only;
a consumer that references only `variant` (the sail decal) never triggers it, so `variant`
stays 0 and the face never switches on. With the refresh also registered on `variant`, the face
appears (and the rain drum turned blue and a crate side olive — the crate/drum variants were dead
for the same reason). Frames before/after: `closeup-sail-face-*` were re-captured after the fix;
all other frames are from before it (no face on the sail in them).

## Frames

| file | URL / pose |
|---|---|
| ext-beam-tod12.png | `?ship=raft&view=beam&tod=12` |
| ext-bow-tod17.5.png | `?ship=raft&view=bow&tod=17.5` |
| ext-stern-tod7.png | `?ship=raft&view=stern&tod=7` (re-captured after the variant fix: face visible) |
| ext-top-tod12.png | `?ship=raft&view=top&tod=12` |
| ext-sun-tod17.5.png | `?ship=raft&view=sun&tod=17.5` |
| ext-lee-tod12.png | `?ship=raft&view=lee&tod=12` (at noon `lee` = stern) |
| ext-beam-tod20.png | `?ship=raft&view=beam&tod=20` (sun below the plane; hemisphere light only) |
| station-{tiller,radio,bow,nest,cabin}-tod{7,12,17.5}.png | `?ship=raft&station=<s>&tod=<t>` (station-bow-* re-captured after the fix) |
| closeup-sail-face-fore.png | cam (0, 5.4, 7.4) → (0, 5.4, 0.9), tod 12 — fore face, straight on |
| closeup-sail-face-aft.png | cam (0, 5.4, −5.6) → (0, 5.4, 0.9), tod 12 — aft face through the bipod |
| closeup-logs-bow-endgrain.png | cam (1.6, 1.3, 8.9) → (0.2, 0.1, 6.3), tod 12 — 3 m off the bow |
| closeup-logs-lashing-starboard.png | cam (4.6, 1.3, 1.2) → (2.4, 0.3, 3.2), tod 12 — 3 m off the starboard bow logs |
| closeup-cabin-weave-thatch.png | cam (4.2, 1.9, −2.6) → (1.2, 1.7, −2.2), tod 12 — 3 m off the starboard wall |
| closeup-crates-port.png | cam (−6.5, 2.2, −0.6) → (−1.5, 0.9, −1.0), tod 12 — 5 m off the port side |

(`dist=/height=/yaw=` only orbit the origin, so the closeups were posed by setting
`camera.position`/`lookAt` directly; the numbers above are ship-local metres.)

## Findings vs the museum photos (img 10, 01, 02, 04, 08, 09)

### Proportions
- **Log stagger: OK.** 9 logs, centre log longest (6.85 m fwd), steps of ~0.6-1.2 m to the
  outer logs, square stern. Reads like photo 10/04 from the beam. Bow ends are cut to a blunt
  point in plan — photo 08 shows plain round ends with a chamfer, not a tapered spear.
- **Cabin size/position: too big, too tall, wrong place.** Cabin is 2.4 × 4.25 m and 1.8 m tall
  (deck 0.59 → eave 2.38), sitting aft of the mast from z 0 to −4.3 so its aft wall is 2 m from
  the stern. In the photos the hut is ~2.5 × 4 m but only ~1.2-1.4 m tall (crew stand head-and-
  shoulders above the ridge, photo 01/04) and it sits **under/just abaft the bipod**, leaving a
  long open stern for the steering oar. Here the helmsman stands in a slot between the cabin's
  aft wall and the stern block with the mizzen in his face (`station-tiller-*`).
- **Mast lean: OK** — bipod legs rake slightly aft, crossing at ~9.4 m, matches photo 10.
- **Sail aspect: OK-ish** — course 5.5 × 5.1 m is a bit square; photos read ~1.25:1 wide.
  Topsail 2.6 × 1.8 m sits immediately above the crosstrees — photo 10 has it as a small
  raffee well above a large gap. Mizzen (`sail-mizzen-lower`, 2 × 2 m on a 3.9 m pole at the
  stern) is far larger than the photo's little stern sail and sits right behind the cabin.
- Lookout platform is at 9.1 m, *below* the topsail foot (9.46 m): a person's eye is inside the
  topsail (`station-nest-*` is nothing but cloth in every tod).

### Material reads (T90 reviewer notes)
- **Varied log tones: NO.** All 9 logs are one pale grey-beige; the photos have blond/grey/
  dark-brown logs side by side, dark weathered ends, a green-brown weed/water band. There is a
  faint darker band under the foot-rail but no per-log variation and no weed band at the
  waterline (`closeup-logs-lashing-starboard`, `ext-beam-tod12`).
- **Grooves at crossbeams: partially.** A dark ring + slight pinch is visible where each
  crossbeam crosses a log (`closeup-logs-lashing-starboard`), but no rope is modelled over it —
  the photos' lashings are fat hemp loops over *every* crossing; here they read as a painted
  black line.
- **End grain: present but wrong.** A fan of dark radial cracks on a flat disc
  (`closeup-logs-bow-endgrain`); photo 08 shows concentric rings + a darker core + a chamfered
  rim. The radial-crack pattern is identical on every log.
- **Weave scale: WRONG.** The cabin walls read as a ~7 cm grid of tight dark-olive "quilted"
  squares, glossy, with a dark cross in each cell (`closeup-cabin-weave-thatch`,
  `station-cabin-*`, `station-radio-*`). Photos 04/08 show a pale straw basket-weave with
  10-12 cm split-bamboo strips, over-under 3-wide, matte. Colour is also far too dark/green —
  this is the single biggest look delta on the raft.
- **Thatch strands down slope: NO.** The roof is a flat plank-like texture with long straight
  grain running *along* the ridge; only the eave shows a short fringe. Photo 09 has loose
  banana-leaf strands hanging down the slope. The roof underside is pure black (unlit backface
  — `station-tiller-*`, `station-cabin-*`, `station-radio-*`).
- **Face: centred, upright, 8 rays — YES once the variant fix is in.** Red fill, dark outline,
  zig-zag band, ring eyes, nose, lip box, beard, 8 rays; wear/cracks visible. Reads through to
  the aft face ✓ (`closeup-sail-face-aft`). Face height ~1.8 m on a 5.1 m drop — photo 02 has
  it ~1/3 of the drop too ✓. No face on topsail/mizzen ✓.
- Sail cloth: fine weave + vertical panel seams ✓, foot bows as one arc ✓. Colour is a dull
  olive-khaki in sun; photos are a warmer pale tan. Backlit side is nearly black
  (`closeup-sail-face-aft` at noon).
- Deck mat: a uniform fine basket texture over the whole fore/starboard deck; photo 09's deck is
  split bamboo in visible ~4 cm strips with a woven mat on top. Acceptable at distance.

### Obvious defects
- `ext-*`, `station-bow-*`: **the flag is the galleon's skull-and-crossbones** (`flag-stern`
  uses the pirate badge). Photos: Norwegian flag + the expedition pennant.
- `station-bow-*`, `ext-top-tod12`, `closeup-logs-bow-endgrain`: the 3 forward **guara boards
  are solid black rectangles** standing 0.2 m proud of the deck — no wood read, no lighting.
  Same for the two bow splashboards ("black L") and the foot-rails: black unlit boxes in every
  exterior frame. Looks like a material that ignores the sun (`ext-sun-tod17.5` too).
- `ext-top-tod12`: the splashboard pair forms a black chevron across the bow logs.
- `ext-bow-tod17.5` / `ext-stern-tod7`: the mast-ladder starts *outside* the foot-rail (socket
  at x 2.69, rail at 2.51) and leans in over the deck — it stands on nothing.
- `station-radio-*`: the "radio corner" is a blank dark weave corner + a black ceiling + an
  orange-tan crate; nothing that reads as a radio.
- `station-nest-*`: 100 % topsail cloth (see proportions).
- `ext-beam-tod20`: night = flat hemisphere light, fine for a preview; the pirate flag is the
  brightest thing on the raft.
- No z-fighting, no holes, no floating pieces seen. Sails are not inside-out (both faces shade
  correctly; backlit side dark as expected).
- The steering oar pokes 4 m aft and its blade sits *above* the stern block in `ext-stern-tod7`
  (blade at y 1.46 → it is not in the water).
- Shadows: 8.8 cm texels at ±45 m — rails/guaras cast OK; sail shadow on the deck is crisp.

### Console
No errors or warnings on the page after the sail fix (`__cap.errors` empty across ~20k pumped
frames). Before the fix the page never reaches a frame, so nothing is logged — it just hangs.
